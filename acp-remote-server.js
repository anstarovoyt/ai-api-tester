const { WebSocketServer, WebSocket } = require("ws");
const { ACPRuntime } = require("./acp-runtime");

const DEFAULT_PATH = "/acp";
const DEFAULT_TIMEOUT_MS = 60_000;
let connectionCounter = 1;

const log = (...args) => {
  console.log(`[ACP-REMOTE ${new Date().toISOString()}]`, ...args);
};

const logError = (...args) => {
  console.error(`[ACP-REMOTE ${new Date().toISOString()}]`, ...args);
};

const normalizePath = (value) => {
  if (!value) {
    return "/";
  }
  const trimmed = value.replace(/\/+$/, "");
  return trimmed || "/";
};

const buildJsonRpcError = (id, message, code = -32600) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message }
});

const parsePayload = (data) => {
  const raw = typeof data === "string" ? data : data.toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const formatResponse = (response, id) => {
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

const isAuthorized = (token, authHeader, queryToken) => {
  if (!token) {
    return true;
  }
  if (!authHeader) {
    return queryToken === token;
  }
  if (authHeader === token || authHeader === `Bearer ${token}`) {
    return true;
  }
  return queryToken === token;
};

const getRequestUrl = (req) => new URL(req.url, `http://${req.headers.host || "localhost"}`);

const closeSocket = (socket, status, message) => {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n${message || ""}`);
  socket.destroy();
};

const getMessageError = (payload) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { id: null, message: "Invalid JSON-RPC payload" };
  }
  if (!payload.method || typeof payload.method !== "string") {
    return { id: payload.id ?? null, message: "Missing method in JSON-RPC payload" };
  }
  return null;
};

const attachAcpRemoteServer = (server, options = {}) => {
  const {
    path = DEFAULT_PATH,
    token = "",
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    resolveAgent
  } = options;

  const expectedPath = normalizePath(path);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
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

  wss.on("connection", (ws, req) => {
    const connectionId = connectionCounter++;
    const connectionLabel = `conn:${connectionId}`;
    const remoteAddress = req.socket.remoteAddress || "unknown";
    const remotePort = req.socket.remotePort;
    const remoteLabel = remotePort ? `${remoteAddress}:${remotePort}` : remoteAddress;
    let runtime = null;
    let notificationHandler = null;
    const requestMethods = new Map();

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

    const sendJson = (payload) => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(JSON.stringify(payload));
    };

    notificationHandler = (payload) => {
      log(`${connectionLabel} agent notification.`, payload?.method || "unknown");
      sendJson(payload);
    };

    runtime.on("notification", notificationHandler);

    ws.on("message", (data) => {
      void (async () => {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        const payload = parsePayload(raw);
        if (!payload) {
          logError(`${connectionLabel} invalid JSON payload.`, raw.slice(0, 200));
        }
        const validation = getMessageError(payload);
        if (validation) {
          logError(`${connectionLabel} invalid JSON-RPC message.`, validation.message);
          sendJson(buildJsonRpcError(validation.id, validation.message));
          return;
        }
        const isNotification = payload.id === undefined || payload.id === null;
        if (isNotification) {
          log(`${connectionLabel} notification ->`, payload.method);
          runtime.sendNotification(payload);
          return;
        }
        requestMethods.set(payload.id, payload.method);
        log(`${connectionLabel} request ->`, payload.method, `id=${payload.id}`);
        try {
          const response = await runtime.sendRequest(payload, requestTimeoutMs);
          const formatted = formatResponse(response, payload.id);
          sendJson(formatted);
          const methodName = requestMethods.get(payload.id) || payload.method;
          requestMethods.delete(payload.id);
          log(`${connectionLabel} response ->`, methodName, `id=${payload.id}`);
          if (formatted?.result?._meta?.target) {
            log(`${connectionLabel} target branch:`, formatted.result._meta.target);
          }
          if (formatted?.error) {
            logError(`${connectionLabel} error response.`, formatted.error);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "ACP runtime error";
          logError(`${connectionLabel} runtime error.`, message);
          sendJson(buildJsonRpcError(payload.id ?? null, message, -32000));
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

    ws.on("close", (code, reason) => {
      const reasonText = reason ? reason.toString("utf8") : "";
      log(`${connectionLabel} socket closed.`, { code, reason: reasonText });
      cleanup();
    });
    ws.on("error", (err) => {
      logError(`${connectionLabel} socket error.`, err instanceof Error ? err.message : err);
      cleanup();
    });
  });

  return wss;
};

module.exports = { attachAcpRemoteServer };
