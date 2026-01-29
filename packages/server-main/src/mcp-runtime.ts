import * as fs from "fs";
import * as path from "path";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";

type McpStdioConfig = {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type MCPLogEntry = {
  id: number;
  timestamp: string;
  direction: "outgoing" | "incoming" | "notification" | "raw" | "error";
  payload: unknown;
};

export class MCPRuntime extends EventEmitter {
  private readonly configPath: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pendingRequests = new Map<unknown, (payload: unknown) => void>();
  private logEntries: MCPLogEntry[] = [];
  private logCounter = 1;
  private stdoutBuffer = "";
  private started = false;

  constructor(configPath: string) {
    super();
    this.configPath = configPath;
  }

  private loadConfig(): McpStdioConfig {
    const resolvedPath = path.isAbsolute(this.configPath)
      ? this.configPath
      : path.join(process.cwd(), this.configPath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Config not found: ${resolvedPath}`);
    }

    const raw = fs.readFileSync(resolvedPath, "utf8");
    const config = JSON.parse(raw) as Partial<McpStdioConfig>;

    if (!config || config.type !== "stdio" || !config.command) {
      throw new Error("Invalid config. Expected { type: 'stdio', command: string, args?: string[], env?: object }");
    }

    return config as McpStdioConfig;
  }

  private pushLog(entry: Omit<MCPLogEntry, "id" | "timestamp">): void {
    const item: MCPLogEntry = {
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

  getLogs(): MCPLogEntry[] {
    return this.logEntries.slice();
  }

  start(): void {
    if (this.started) {
      return;
    }
    const config = this.loadConfig();
    this.child = spawn(config.command, config.args || [], {
      env: { ...process.env, ...(config.env || {}) },
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;
    this.started = true;

    this.child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf8");
      let index: number;
      while ((index = this.stdoutBuffer.indexOf("\n")) >= 0) {
        const line = this.stdoutBuffer.slice(0, index);
        this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
        this.handleLine(line);
      }
    });

    this.child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        this.pushLog({ direction: "error", payload: message });
      }
    });

    this.child.on("exit", (code) => {
      this.pushLog({ direction: "error", payload: `MCP process exited with code ${code ?? "unknown"}` });
      this.started = false;
    });

    this.child.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.pushLog({ direction: "error", payload: `Failed to start MCP process: ${message}` });
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        if (parsed.id !== undefined && this.pendingRequests.has(parsed.id)) {
          this.pendingRequests.get(parsed.id)?.(parsed);
          this.pendingRequests.delete(parsed.id);
        }
        if (typeof (parsed as any).method === "string" && !("id" in parsed)) {
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

  async sendRequest(payload: { jsonrpc?: string; id: unknown; method: string; params?: unknown }, timeoutMs = 30_000): Promise<unknown> {
    if (!this.child || !this.started) {
      this.start();
    }
    if (!this.child) {
      return { error: { message: "MCP runtime is not started" } };
    }

    const outgoing = {
      jsonrpc: payload.jsonrpc || "2.0",
      id: payload.id,
      method: payload.method,
      params: payload.params ?? {}
    };
    this.pushLog({ direction: "outgoing", payload: outgoing });
    this.child.stdin.write(`${JSON.stringify(outgoing)}\n`);

    return await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(outgoing.id);
        resolve({ error: { message: "Response timeout" } });
      }, timeoutMs);
      this.pendingRequests.set(outgoing.id, (data) => {
        clearTimeout(timeout);
        resolve(data);
      });
    });
  }

  sendNotification(payload: { jsonrpc?: string; method: string; params?: unknown }): void {
    if (!this.child || !this.started) {
      this.start();
    }
    if (!this.child) {
      return;
    }
    const outgoing = {
      jsonrpc: payload.jsonrpc || "2.0",
      method: payload.method,
      params: payload.params ?? {}
    };
    this.pushLog({ direction: "outgoing", payload: outgoing });
    this.child.stdin.write(`${JSON.stringify(outgoing)}\n`);
  }

  stop(): void {
    if (this.child) {
      this.child.kill();
      this.child = null;
      this.started = false;
    }
  }
}

