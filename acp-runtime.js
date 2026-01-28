const { spawn } = require("child_process");
const { EventEmitter } = require("events");

class ACPRuntime extends EventEmitter {
  constructor(agentConfig) {
    super();
    this.agentConfig = agentConfig;
    this.child = null;
    this.pendingRequests = new Map();
    this.logEntries = [];
    this.logCounter = 1;
    this.stdoutBuffer = "";
    this.started = false;
    this.spawnCwd = "";
    this.childToken = 0;
  }

  setSpawnCwd(cwd) {
    if (this.started) {
      return false;
    }
    this.spawnCwd = cwd ? String(cwd) : "";
    return true;
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
    this.childToken += 1;
    const token = this.childToken;
    const child = spawn(this.agentConfig.command, this.agentConfig.args || [], {
      cwd: this.spawnCwd || undefined,
      env: { ...process.env, ...(this.agentConfig.env || {}) },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.started = true;
    this.stdoutBuffer = "";

    child.stdout.on("data", (chunk) => {
      if (this.child !== child || this.childToken !== token) {
        return;
      }
      this.stdoutBuffer += chunk.toString("utf8");
      let index;
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
      this.pushLog({ direction: "error", payload: `Failed to start ACP process: ${err instanceof Error ? err.message : err}` });
      this.child = null;
      this.started = false;
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

module.exports = { ACPRuntime };
