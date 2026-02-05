import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { ACPRuntime, type LogEntry } from "../../acp-runtime";

type McpStdioConfig = {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type MCPLogEntry = LogEntry;

export class MCPRuntime extends EventEmitter {
  private readonly configPath: string;
  private runtime: ACPRuntime | null = null;

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

  getLogs(): MCPLogEntry[] {
    return this.runtime?.getLogs() ?? [];
  }

  start(): void {
    this.ensureRuntime().start();
  }

  private ensureRuntime(): ACPRuntime {
    if (this.runtime) {
      return this.runtime;
    }
    const config = this.loadConfig();
    const runtime = new ACPRuntime({
      command: config.command,
      args: config.args || [],
      env: config.env || {}
    });
    runtime.on("log", (entry: LogEntry) => this.emit("log", entry));
    this.runtime = runtime;
    return runtime;
  }

  async sendRequest(payload: { jsonrpc?: string; id: unknown; method: string; params?: unknown }, timeoutMs = 30_000): Promise<unknown> {
    return await this.ensureRuntime().sendRequest(payload as any, timeoutMs);
  }

  sendNotification(payload: { jsonrpc?: string; method: string; params?: unknown }): void {
    this.ensureRuntime().sendNotification(payload as any);
  }

  stop(): void {
    if (this.runtime) {
      this.runtime.stop();
    }
  }
}
