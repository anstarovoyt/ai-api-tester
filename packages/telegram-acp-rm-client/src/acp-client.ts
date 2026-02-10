import WebSocket from "ws";
import {EventEmitter} from "events";

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type AcpClientOptions = {
  url: string;
  token?: string;
  agent?: string;
  requestTimeoutMs?: number;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
};

export type SessionInfo = {
  sessionId: string;
  cwd?: string;
};

export type PromptResult = {
  stopReason: string;
  _meta?: {
    target?: {
      url: string;
      branch: string;
      revision: string;
    };
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export class AcpClient extends EventEmitter {
  private readonly options: Required<AcpClientOptions>;
  private ws: WebSocket | null = null;
  private requestIdCounter = 1;
  private pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private reconnectAttempts = 0;
  private isConnecting = false;
  private shouldReconnect = true;

  constructor(options: AcpClientOptions) {
    super();
    this.options = {
      url: options.url,
      token: options.token || "",
      agent: options.agent || "",
      requestTimeoutMs: options.requestTimeoutMs || 600_000,
      reconnectIntervalMs: options.reconnectIntervalMs || 5_000,
      maxReconnectAttempts: options.maxReconnectAttempts || 10,
    };
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.isConnecting) {
      return new Promise((resolve, reject) => {
        const onOpen = () => {
          this.off("error", onError);
          resolve();
        };
        const onError = (err: Error) => {
          this.off("open", onOpen);
          reject(err);
        };
        this.once("open", onOpen);
        this.once("error", onError);
      });
    }

    this.isConnecting = true;
    this.shouldReconnect = true;

    return new Promise((resolve, reject) => {
      const url = new URL(this.options.url);
      if (this.options.agent) {
        url.searchParams.set("agent", this.options.agent);
      }
      if (this.options.token) {
        url.searchParams.set("token", this.options.token);
      }

      const headers: Record<string, string> = {};
      if (this.options.token) {
        headers["Authorization"] = `Bearer ${this.options.token}`;
      }

      this.ws = new WebSocket(url.toString(), { headers });

      this.ws.on("open", () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.emit("open");
        resolve();
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data);
      });

      this.ws.on("close", (code, reason) => {
        this.isConnecting = false;
        this.emit("close", code, reason.toString("utf8"));
        this.rejectAllPending(new Error(`Connection closed: ${code}`));
        this.attemptReconnect();
      });

      this.ws.on("error", (err) => {
        this.isConnecting = false;
        this.emit("error", err);
        if (this.reconnectAttempts === 0) {
          reject(err);
        }
      });
    });
  }

  private attemptReconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.emit("reconnect_failed");
      return;
    }
    this.reconnectAttempts++;
    this.emit("reconnecting", this.reconnectAttempts);
    setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect().catch(() => {});
      }
    }, this.options.reconnectIntervalMs);
  }

  private handleMessage(data: WebSocket.Data): void {
    const raw = typeof data === "string" ? data : data.toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.emit("error", new Error("Invalid JSON received"));
      return;
    }

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        this.handleSingleMessage(item);
      }
    } else {
      this.handleSingleMessage(parsed);
    }
  }

  private handleSingleMessage(message: unknown): void {
    if (!message || typeof message !== "object") {
      return;
    }

    const msg = message as Record<string, unknown>;

    // Check if it's a response (has id and either result or error)
    if ("id" in msg && (("result" in msg) || ("error" in msg))) {
      const pending = this.pendingRequests.get(msg.id as JsonRpcId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(msg.id as JsonRpcId);
        if ("error" in msg) {
          pending.reject(new Error((msg.error as any)?.message || "Unknown error"));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // It's a notification
    if ("method" in msg) {
      this.emit("notification", msg);
      this.emit(`notification:${msg.method}`, msg.params);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private nextId(): number {
    return this.requestIdCounter++;
  }

  async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    const id = this.nextId();
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params: params || {},
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, this.options.requestTimeoutMs);

      this.pendingRequests.set(id, { resolve: resolve as (v: unknown) => void, reject, timeout });
      this.ws!.send(JSON.stringify(request));
    });
  }

  sendNotification(method: string, params?: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params: params || {},
    };
    this.ws.send(JSON.stringify(notification));
  }

  async createSession(cwd?: string): Promise<SessionInfo> {
    const params: Record<string, unknown> = {};
    if (cwd) {
      params.cwd = cwd;
    }
    const result = await this.sendRequest<{ sessionId: string; cwd?: string }>("session/new", params);
    return {
      sessionId: result.sessionId,
      cwd: result.cwd,
    };
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<PromptResult> {
    return await this.sendRequest<PromptResult>("session/prompt", {
      sessionId,
      messages: [
        {
          role: "user",
          content: {type: "text", text: prompt},
        },
      ],
    });
  }

  async cancelSession(sessionId: string): Promise<void> {
    this.sendNotification("session/cancel", { sessionId });
  }

  async getAgents(): Promise<Array<{ name: string; command: string; args: string[] }>> {
    // This is typically an HTTP endpoint, but we can try via WS if available
    // For now, we'll return empty and use HTTP fetch separately
    return [];
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.rejectAllPending(new Error("Client disconnected"));
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export const fetchAgents = async (baseUrl: string, token?: string): Promise<Array<{ name: string; command: string; args: string[] }>> => {
  const url = new URL("/acp/agents", baseUrl);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(url.toString(), { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch agents: ${response.status}`);
  }
  const data = await response.json() as { agents: Array<{ name: string; command: string; args: string[] }> };
  return data.agents || [];
};
