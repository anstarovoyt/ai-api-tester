import {ACPRuntime} from "../../acp-runtime";
import {WebSocket, WebSocketServer} from "ws";
import {createAcpRemoteLogger} from "./shared/logger";
import {buildJsonRpcError, closeSocket, getRequestUrl, isAuthorized, normalizePath, parseJson} from "./shared/jsonrpc";

const DEFAULT_PATH = "/acp";
const DEFAULT_TIMEOUT_MS = 60_000;
let connectionCounter = 1;

const ACP_REMOTE_VERBOSE = !["0", "false", "no"].includes(String(process.env.ACP_REMOTE_VERBOSE || "true").toLowerCase());
const ACP_REMOTE_LOG_RPC_PAYLOADS = !["0", "false", "no"].includes(
  String(process.env.ACP_REMOTE_LOG_RPC_PAYLOADS || "true").toLowerCase()
);
const ACP_REMOTE_LOG_RPC_NOTIFICATION_PAYLOADS = !["0", "false", "no"].includes(
  String(process.env.ACP_REMOTE_LOG_RPC_NOTIFICATION_PAYLOADS || "false").toLowerCase()
);
const ACP_REMOTE_COALESCE_SESSION_UPDATES = !["0", "false", "no"].includes(
  String(process.env.ACP_REMOTE_COALESCE_SESSION_UPDATES || "true").toLowerCase()
);
const ACP_REMOTE_SESSION_UPDATE_LOG_FLUSH_MS = Number(process.env.ACP_REMOTE_SESSION_UPDATE_LOG_FLUSH_MS || 2_000);
const ACP_REMOTE_LOG_MAX_CHARS = Number(process.env.ACP_REMOTE_LOG_MAX_CHARS || 50_000);
const ACP_REMOTE_LOG_MAX_STRING_CHARS = Number(process.env.ACP_REMOTE_LOG_MAX_STRING_CHARS || 4_000);
const ACP_REMOTE_COLOR = !["0", "false", "no"].includes(String(process.env.ACP_REMOTE_COLOR || "true").toLowerCase());
const USE_COLOR = Boolean(ACP_REMOTE_COLOR && process.stdout.isTTY && !process.env.NO_COLOR);

const logger = createAcpRemoteLogger({
  prefix: "ACP-REMOTE",
  useColor: USE_COLOR,
  verbose: ACP_REMOTE_VERBOSE,
  logMaxChars: ACP_REMOTE_LOG_MAX_CHARS,
  logMaxStringChars: ACP_REMOTE_LOG_MAX_STRING_CHARS,
  logRpcPayloads: ACP_REMOTE_LOG_RPC_PAYLOADS,
  logRpcNotificationPayloads: ACP_REMOTE_LOG_RPC_NOTIFICATION_PAYLOADS,
  coalesceSessionUpdates: ACP_REMOTE_COALESCE_SESSION_UPDATES,
  sessionUpdateLogFlushMs: ACP_REMOTE_SESSION_UPDATE_LOG_FLUSH_MS
});

const { log, logError, logRpc, sessionUpdateLogCoalescer } = logger;

process.on("exit", () => sessionUpdateLogCoalescer.flush());
process.on("SIGINT", () => sessionUpdateLogCoalescer.flush());
process.on("SIGTERM", () => sessionUpdateLogCoalescer.flush());

const formatResponse = (response: any, id: any) => {
  if (response && typeof response === "object" && !Array.isArray(response)) {
    if (response.jsonrpc && ("result" in response || "error" in response)) {
      return response;
    }
    if (response.error && typeof response.error === "object") {
      return { jsonrpc: "2.0", id, error: response.error };
    }
  }
  return { jsonrpc: "2.0", id, result: response ?? null };
};

const getMessageError = (payload: any) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { id: null, message: "Invalid JSON-RPC payload" };
  }
  if (!payload.method || typeof payload.method !== "string") {
    return { id: payload.id ?? null, message: "Missing method in JSON-RPC payload" };
  }
  return null;
};

export const attachAcpRemoteServer = (server: any, options: any = {}) => {
  const {
    path = DEFAULT_PATH,
    token = "",
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    resolveAgent
  } = options;

  const expectedPath = normalizePath(path);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: any, socket: any, head: any) => {
    const url = getRequestUrl(req);
    if (normalizePath(url.pathname) !== expectedPath) {
      return;
    }
    const remoteAddress = req.socket.remoteAddress || "unknown";
    const remotePort = req.socket.remotePort;
    const remoteLabel = remotePort ? `${remoteAddress}:${remotePort}` : remoteAddress;
    if (!isAuthorized(token, req.headers.authorization, url.searchParams.get("token"))) {
      logError("Upgrade rejected (unauthorized).", { remote: remoteLabel, path: url.pathname });
      closeSocket(socket, "401 Unauthorized");
      return;
    }
    log("Upgrade accepted.", { remote: remoteLabel, path: url.pathname });
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket, req: any) => {
    const connectionId = connectionCounter++;
    const connectionLabel = `conn:${connectionId}`;
    const remoteAddress = req.socket.remoteAddress || "unknown";
    const remotePort = req.socket.remotePort;
    const remoteLabel = remotePort ? `${remoteAddress}:${remotePort}` : remoteAddress;
    let runtime: ACPRuntime | null = null;
    let notificationHandler: ((payload: any) => void) | null = null;
    const requestMethods = new Map<any, string>();

    try {
      if (typeof resolveAgent !== "function") {
        throw new Error("ACP remote agent resolver is not configured");
      }
      const url = getRequestUrl(req);
      const queryAgent = url.searchParams.get("agent") || undefined;
      const agentInfo = resolveAgent({ req, queryAgent });
      if (!agentInfo?.config) {
        throw new Error("ACP agent configuration not found");
      }
      log(`${connectionLabel} starting ACP runtime.`, {
        remote: remoteLabel,
        agent: agentInfo.name || queryAgent || "default"
      });
      runtime = new ACPRuntime(agentInfo.config);
      runtime.start();
      log(`${connectionLabel} ACP runtime started.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start ACP runtime";
      logError(`${connectionLabel} failed to start ACP runtime.`, message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(buildJsonRpcError(null, message, -32000)));
      }
      ws.close(1011, "ACP runtime error");
      return;
    }

    const sendJsonRaw = (payload: any) => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(JSON.stringify(payload));
    };

    notificationHandler = (payload: any) => {
      logRpc({ level: "DEBUG", contextLabel: connectionLabel, direction: "->", payload });
      sendJsonRaw(payload);
    };

    runtime.on("notification", notificationHandler);

    ws.on("message", (data: any) => {
      void (async () => {
        const parsed = parseJson(data);
        const payload = parsed.value;
        if (!payload) {
          logError(`${connectionLabel} invalid JSON payload.`, parsed.raw.slice(0, 2_000));
        }
        const validation = getMessageError(payload);
        if (validation) {
          logError(`${connectionLabel} invalid JSON-RPC message.`, validation.message);
          const errorResponse = buildJsonRpcError(validation.id, validation.message);
          logRpc({ level: "ERROR", contextLabel: connectionLabel, direction: "->", payload: errorResponse, methodHint: "jsonrpc/error" });
          sendJsonRaw(errorResponse);
          return;
        }
        const isNotification = payload.id === undefined || payload.id === null;
        if (isNotification) {
          logRpc({ level: "DEBUG", contextLabel: connectionLabel, direction: "<-", payload });
          runtime?.sendNotification(payload);
          return;
        }
        requestMethods.set(payload.id, payload.method);
        logRpc({ level: "INFO", contextLabel: connectionLabel, direction: "<-", payload });
        try {
          const response = await runtime!.sendRequest(payload, requestTimeoutMs);
          const formatted = formatResponse(response, payload.id);
          const methodName = requestMethods.get(payload.id) || payload.method;
          requestMethods.delete(payload.id);
          const responseLevel = formatted?.error ? "ERROR" : "INFO";
          logRpc({ level: responseLevel, contextLabel: connectionLabel, direction: "->", payload: formatted, methodHint: methodName });
          sendJsonRaw(formatted);
        } catch (err) {
          const message = err instanceof Error ? err.message : "ACP runtime error";
          logError(`${connectionLabel} runtime error.`, message);
          const errorResponse = buildJsonRpcError(payload.id ?? null, message, -32000);
          logRpc({ level: "ERROR", contextLabel: connectionLabel, direction: "->", payload: errorResponse, methodHint: payload.method });
          sendJsonRaw(errorResponse);
        }
      })();
    });

    const cleanup = () => {
      if (runtime) {
        runtime.stop();
        if (notificationHandler) {
          runtime.off("notification", notificationHandler);
        }
        log(`${connectionLabel} ACP runtime stopped.`);
      }
    };

    ws.on("close", (code: number, reason: any) => {
      const reasonText = reason ? reason.toString("utf8") : "";
      log(`${connectionLabel} socket closed.`, { code, reason: reasonText });
      sessionUpdateLogCoalescer.flush(connectionLabel);
      cleanup();
    });
    ws.on("error", (err: any) => {
      logError(`${connectionLabel} socket error.`, err instanceof Error ? err.message : err);
      sessionUpdateLogCoalescer.flush(connectionLabel);
      cleanup();
    });
  });

  return wss;
};

