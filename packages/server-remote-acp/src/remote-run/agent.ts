import { ACPRuntime, type LogEntry } from "../../../acp-runtime";
import { describeMessage, getSessionIdFromParams, normalizeJsonRpcNotification, stripMetaFromParams } from "./jsonrpc";
import { logDebug, logError, logRpc, logWarn, safePrettyJsonForLog, sessionUpdateLogCoalescer } from "./logger";

export type AgentInfo = {
  name: string;
  config: any;
};

export type RuntimeNotificationHandler = (payload: any) => void;

export const getSessionIdFromPayloadParams = (payload: any) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }
  return getSessionIdFromParams((payload as any).params);
};

const extractSessionNotFoundId = (error: any) => {
  if (!error || typeof error !== "object") {
    return "";
  }
  const data = (error as any).data;
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      const message = typeof (parsed as any)?.error === "string" ? (parsed as any).error : "";
      const match = message.match(/Session not found:\\s*([^\\s]+)/);
      return match ? match[1] : "";
    } catch {
      const match = data.match(/Session not found:\\s*([^\\s]+)/);
      return match ? match[1] : "";
    }
  }
  if (data && typeof data === "object") {
    const message = typeof (data as any).error === "string" ? (data as any).error : "";
    const match = message.match(/Session not found:\\s*([^\\s]+)/);
    return match ? match[1] : "";
  }
  return "";
};

const describeRpcForLog = (payload: any) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { type: Array.isArray(payload) ? "batch" : typeof payload };
  }
  const hasMethod = typeof payload.method === "string";
  const hasId = payload.id !== undefined;
  const hasResult = "result" in payload;
  const hasError = "error" in payload;
  const type = hasMethod
    ? (hasId ? "request" : "notification")
    : (hasId && (hasResult || hasError) ? "response" : "unknown");
  return {
    type,
    jsonrpc: payload.jsonrpc,
    method: hasMethod ? payload.method : undefined,
    id: hasId ? payload.id : undefined,
    hasResult,
    hasError
  };
};

export class AcpAgentRuntime {
  readonly id: string;
  readonly agent: AgentInfo;
  private readonly runtime: ACPRuntime;
  private internalCounter = 1;
  private requestMethodByInternalId = new Map<string, string>();

  constructor(options: {
    id: string;
    agent: AgentInfo;
    onNotification: RuntimeNotificationHandler;
    spawnCwd?: string;
  }) {
    this.id = options.id;
    this.agent = options.agent;
    this.runtime = new ACPRuntime(options.agent.config);
    if (options.spawnCwd) {
      this.runtime.setSpawnCwd(options.spawnCwd);
    }

    this.runtime.on("notification", (payload) => {
      const normalized = normalizeJsonRpcNotification(payload);
      if (!normalized) {
        logWarn(`${this.id} skipping non-JSON-RPC notification.`, describeMessage(payload));
        return;
      }
      options.onNotification(normalized);
    });

    this.runtime.on("log", (entry: LogEntry) => this.handleRuntimeLog(entry));
  }

  private handleRuntimeLog(entry: LogEntry) {
    if (
      entry?.direction === "notification"
      && entry?.payload
      && typeof entry.payload === "object"
      && !Array.isArray(entry.payload)
      && (entry.payload as any).method === "session/update"
      && sessionUpdateLogCoalescer.bump(this.id, "runtime")
    ) {
      return;
    }
    const payload: any = entry?.payload;
    const contextLabel = `${this.id} agent`;
    if (!payload) {
      logDebug(`${this.id} runtime log.`, entry?.direction, payload);
      return;
    }

    if (entry?.direction === "error") {
      logError(`${contextLabel} error.`, payload);
      return;
    }

    if (entry?.direction === "outgoing") {
      const desc = describeRpcForLog(payload);
      const level = desc.type === "request" ? "INFO" : "DEBUG";
      logRpc({ level, contextLabel, direction: "->", payload });
      return;
    }

    if (entry?.direction === "incoming") {
      const desc = describeRpcForLog(payload);
      const methodHint = (
        payload
        && typeof payload === "object"
        && !Array.isArray(payload)
        && "id" in payload
      ) ? this.requestMethodByInternalId.get(String(payload.id)) : undefined;
      const level = payload?.error ? "ERROR" : (desc.type === "response" ? "INFO" : "DEBUG");
      logRpc({ level, contextLabel, direction: "<-", payload, methodHint });
      const missingSessionId = extractSessionNotFoundId(payload?.error);
      if (missingSessionId) {
        logWarn(`${contextLabel} session missing in agent process.`, {
          sessionId: missingSessionId,
          hint: "This usually means the WS reconnected or the agent process restarted between session/new and session/prompt."
        });
      }
      return;
    }

    if (entry?.direction === "notification") {
      logRpc({ level: "DEBUG", contextLabel, direction: "<-", payload });
      return;
    }

    logDebug(`${this.id} runtime log.`, entry?.direction, safePrettyJsonForLog(payload));
  }

  sendNotification(message: any) {
    const forwardMessage = { ...message, params: stripMetaFromParams(message.params) };
    this.runtime.sendNotification(forwardMessage);
  }

  async sendRequest(message: any, timeoutMs: number): Promise<any> {
    const internalId = `${this.id}:${this.internalCounter++}`;
    const forwardMessage = { ...message, id: internalId, params: stripMetaFromParams(message.params) };
    if (typeof forwardMessage.method === "string") {
      this.requestMethodByInternalId.set(internalId, forwardMessage.method);
    }
    try {
      return await this.runtime.sendRequest(forwardMessage, timeoutMs);
    } finally {
      this.requestMethodByInternalId.delete(internalId);
    }
  }

  stop() {
    this.runtime.stop();
  }
}
