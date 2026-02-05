import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";

export type JsonRpcId = string | number | null;

export type JsonRpcPayload = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  [key: string]: unknown;
};

export type AgentConfig = {
  command: string;
  args?: string[];
  env?: Record<string, unknown>;
};

export type LogDirection = "outgoing" | "incoming" | "notification" | "raw" | "error";

export type LogEntry = {
  id: number;
  timestamp: string;
  direction: LogDirection;
  payload: unknown;
};

const buildSpawnEnv = (base: NodeJS.ProcessEnv, override: unknown): NodeJS.ProcessEnv => {
  const merged: NodeJS.ProcessEnv = { ...base };
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return merged;
  }
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (value === undefined || value === null) {
      delete merged[key];
      continue;
    }
    if (typeof value === "string") {
      merged[key] = value;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      merged[key] = String(value);
      continue;
    }
    try {
      merged[key] = JSON.stringify(value);
    } catch {
      merged[key] = String(value);
    }
  }
  return merged;
};

export class ACPRuntime extends EventEmitter {
  private readonly agentConfig: AgentConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pendingRequests = new Map<JsonRpcId, (payload: unknown) => void>();
  private logEntries: LogEntry[] = [];
  private logCounter = 1;
  private stdoutBuffer = "";
  private started = false;
  private spawnCwd = "";
  private childToken = 0;

  constructor(agentConfig: AgentConfig) {
    super();
    this.agentConfig = agentConfig;
  }

  setSpawnCwd(cwd: string): boolean {
    if (this.started) {
      return false;
    }
    this.spawnCwd = cwd ? String(cwd) : "";
    return true;
  }

  private pushLog(entry: Omit<LogEntry, "id" | "timestamp">): void {
    const item: LogEntry = {
      id: this.logCounter++,
      timestamp: new Date().toISOString(),
      ...entry
    };
    this.logEntries.push(item);
    if (this.logEntries.length > 500) {
      this.logEntries.shift();
    }
    this.emit("log", item);
  }

  getLogs(): LogEntry[] {
    return this.logEntries.slice();
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.childToken += 1;
    const token = this.childToken;
    const child = spawn(this.agentConfig.command, this.agentConfig.args || [], {
      cwd: this.spawnCwd || undefined,
      env: buildSpawnEnv(process.env, this.agentConfig.env),
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;

    this.child = child;
    this.started = true;
    this.stdoutBuffer = "";

    child.stdout.on("data", (chunk) => {
      if (this.child !== child || this.childToken !== token) {
        return;
      }
      this.stdoutBuffer += chunk.toString("utf8");
      let index: number;
      while ((index = this.stdoutBuffer.indexOf("\n")) >= 0) {
        const line = this.stdoutBuffer.slice(0, index);
        this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
        this.handleLine(line);
      }
    });

    child.stderr.on("data", (chunk) => {
      if (this.child !== child || this.childToken !== token) {
        return;
      }
      const message = chunk.toString("utf8").trim();
      if (message) {
        this.pushLog({ direction: "error", payload: message });
      }
    });

    child.on("exit", (code) => {
      if (this.child !== child || this.childToken !== token) {
        return;
      }
      this.pushLog({ direction: "error", payload: `ACP process exited with code ${code ?? "unknown"}` });
      this.child = null;
      this.started = false;
    });

    child.on("error", (err) => {
      if (this.child !== child || this.childToken !== token) {
        return;
      }
      const message = err.message;
      this.pushLog({ direction: "error", payload: `Failed to start ACP process: ${message}` });
      this.child = null;
      this.started = false;
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      const parsed = JSON.parse(trimmed) as JsonRpcPayload;
      if (parsed && typeof parsed === "object") {
        if (parsed.id !== undefined && this.pendingRequests.has(parsed.id)) {
          this.pendingRequests.get(parsed.id)?.(parsed);
          this.pendingRequests.delete(parsed.id);
        }
        if (typeof parsed.method === "string" && !("id" in parsed)) {
          this.emit("notification", parsed);
          this.pushLog({ direction: "notification", payload: parsed });
        } else {
          this.pushLog({ direction: "incoming", payload: parsed });
        }
      } else {
        this.pushLog({ direction: "raw", payload: trimmed });
      }
    } catch {
      this.pushLog({ direction: "raw", payload: trimmed });
    }
  }

  async sendRequest(payload: JsonRpcPayload, timeoutMs = 30_000): Promise<unknown> {
    if (!this.child || !this.started) {
      this.start();
    }
    if (!this.child) {
      return { error: { message: "ACP runtime is not started" } };
    }

    const outgoing: JsonRpcPayload = {
      jsonrpc: payload.jsonrpc || "2.0",
      id: payload.id,
      method: payload.method,
      params: payload.params ?? {}
    };
    this.pushLog({ direction: "outgoing", payload: outgoing });
    this.child.stdin.write(`${JSON.stringify(outgoing)}\n`);

    return await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(outgoing.id ?? null);
        resolve({ error: { message: "Response timeout" } });
      }, timeoutMs);
      this.pendingRequests.set(outgoing.id ?? null, (data) => {
        clearTimeout(timeout);
        resolve(data);
      });
    });
  }

  sendNotification(payload: JsonRpcPayload): void {
    if (!this.child || !this.started) {
      this.start();
    }
    if (!this.child) {
      return;
    }
    const outgoing: JsonRpcPayload = {
      jsonrpc: payload.jsonrpc || "2.0",
      method: payload.method,
      params: payload.params ?? {}
    };
    this.pushLog({ direction: "outgoing", payload: outgoing });
    this.child.stdin.write(`${JSON.stringify(outgoing)}\n`);
  }

  stop(): void {
    if (this.child) {
      const child = this.child;
      this.child = null;
      this.started = false;
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
  }
}
