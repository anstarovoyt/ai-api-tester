const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");

class MCPRuntime extends EventEmitter {
  constructor(configPath) {
    super();
    this.configPath = configPath;
    this.child = null;
    this.pendingRequests = new Map();
    this.logEntries = [];
    this.logCounter = 1;
    this.stdoutBuffer = "";
    this.started = false;
  }

  loadConfig() {
    const resolvedPath = path.isAbsolute(this.configPath)
      ? this.configPath
      : path.join(process.cwd(), this.configPath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Config not found: ${resolvedPath}`);
    }

    const raw = fs.readFileSync(resolvedPath, "utf8");
    const config = JSON.parse(raw);

    if (!config || config.type !== "stdio" || !config.command) {
      throw new Error("Invalid config. Expected { type: 'stdio', command: string, args?: string[], env?: object }");
    }

    return config;
  }

  pushLog(entry) {
    const item = {
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

  getLogs() {
    return this.logEntries.slice();
  }

  start() {
    if (this.started) {
      return;
    }
    const config = this.loadConfig();
    this.child = spawn(config.command, config.args || [], {
      env: { ...process.env, ...(config.env || {}) },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.started = true;

    this.child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf8");
      let index;
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
      this.pushLog({ direction: "error", payload: `Failed to start MCP process: ${err instanceof Error ? err.message : err}` });
    });
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        if (parsed.id !== undefined && this.pendingRequests.has(parsed.id)) {
          this.pendingRequests.get(parsed.id)(parsed);
          this.pendingRequests.delete(parsed.id);
        }
        if (parsed.method && !("id" in parsed)) {
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

  sendRequest(payload, timeoutMs = 30_000) {
    if (!this.child || !this.started) {
      this.start();
    }
    const outgoing = {
      jsonrpc: payload.jsonrpc || "2.0",
      id: payload.id,
      method: payload.method,
      params: payload.params ?? {}
    };
    this.pushLog({ direction: "outgoing", payload: outgoing });
    this.child.stdin.write(`${JSON.stringify(outgoing)}\n`);

    return new Promise((resolve) => {
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

  sendNotification(payload) {
    if (!this.child || !this.started) {
      this.start();
    }
    const outgoing = {
      jsonrpc: payload.jsonrpc || "2.0",
      method: payload.method,
      params: payload.params ?? {}
    };
    this.pushLog({ direction: "outgoing", payload: outgoing });
    this.child.stdin.write(`${JSON.stringify(outgoing)}\n`);
  }

  stop() {
    if (this.child) {
      this.child.kill();
      this.child = null;
      this.started = false;
    }
  }
}

module.exports = { MCPRuntime };
