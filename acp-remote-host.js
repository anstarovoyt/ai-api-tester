const { WebSocketServer, WebSocket } = require("ws");
const util = require("util");
const { ACPRuntime } = require("./acp-runtime");

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

const ansi = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
};

const color = (code, text) => (USE_COLOR ? `${code}${text}${ansi.reset}` : String(text));
const dim = (text) => color(ansi.dim, text);
const bold = (text) => color(ansi.bold, text);

const inspectForLog = (value, options = {}) => {
  if (typeof value === "string") {
    return value;
  }
  return util.inspect(value, {
    depth: options.depth ?? 6,
    colors: Boolean(options.colors),
    breakLength: 120,
    maxArrayLength: 50,
    maxStringLength: ACP_REMOTE_LOG_MAX_STRING_CHARS
  });
};

const prefixLines = (prefix, text) => {
  const raw = String(text ?? "");
  const lines = raw.split(/\r?\n/);
  return lines.map((line) => `${prefix} ${line}`).join("\n");
};

const formatPrefix = (level, timestamp, { colors }) => {
  const base = `[ACP-REMOTE ${timestamp}]`;
  const bracketedLevel = level ? `[${level}]` : "";
  if (!colors) {
    return `${base}${bracketedLevel ? ` ${bracketedLevel}` : ""}`;
  }
  const levelColored = (() => {
    if (level === "ERROR") return color(ansi.red, bracketedLevel);
    if (level === "WARN") return color(ansi.yellow, bracketedLevel);
    if (level === "DEBUG") return color(ansi.magenta, bracketedLevel);
    return color(ansi.green, bracketedLevel || "[INFO]");
  })();
  return `${dim(base)} ${levelColored}`;
};

const logWithLevel = (level, ...args) => {
  const timestamp = new Date().toISOString();
  const prefixConsole = formatPrefix(level, timestamp, { colors: true });
  const messageConsole = args.map((arg) => inspectForLog(arg, { colors: USE_COLOR })).join(" ");
  const outConsole = prefixLines(prefixConsole, messageConsole);
  if (level === "ERROR") {
    console.error(outConsole);
  } else if (level === "WARN") {
    console.warn(outConsole);
  } else if (level === "DEBUG") {
    if (ACP_REMOTE_VERBOSE) {
      console.log(outConsole);
    }
  } else {
    console.log(outConsole);
  }
};

const log = (...args) => logWithLevel("INFO", ...args);
const logWarn = (...args) => logWithLevel("WARN", ...args);
const logError = (...args) => logWithLevel("ERROR", ...args);
const logDebug = (...args) => logWithLevel("DEBUG", ...args);

const redactForLog = (payload) => {
  const seen = new WeakSet();
  const redact = (key, value) => {
    if (typeof key === "string") {
      const lowered = key.toLowerCase();
      if (
        lowered.includes("token")
        || lowered.includes("authorization")
        || lowered.includes("api_key")
        || lowered.includes("apikey")
        || lowered.includes("password")
        || lowered.includes("secret")
      ) {
        return "[REDACTED]";
      }
    }
    if (typeof value === "string" && value.length > ACP_REMOTE_LOG_MAX_STRING_CHARS) {
      return `${value.slice(0, ACP_REMOTE_LOG_MAX_STRING_CHARS)}…(${value.length - ACP_REMOTE_LOG_MAX_STRING_CHARS} more chars)`;
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
  try {
    return JSON.parse(JSON.stringify(payload, redact));
  } catch {
    return payload;
  }
};

const safePrettyJsonForLog = (payload) => {
  try {
    const json = JSON.stringify(redactForLog(payload), null, 2);
    if (json.length <= ACP_REMOTE_LOG_MAX_CHARS) {
      return json;
    }
    return `${json.slice(0, ACP_REMOTE_LOG_MAX_CHARS)}\n…(${json.length - ACP_REMOTE_LOG_MAX_CHARS} more chars)`;
  } catch (err) {
    return `<<unserializable:${err instanceof Error ? err.message : String(err)}>>`;
  }
};

const describeRpcForLog = (payload) => {
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
    method: hasMethod ? payload.method : undefined,
    id: hasId ? payload.id : undefined
  };
};

const isSessionUpdateNotification = (payload) => (
  payload
  && typeof payload === "object"
  && !Array.isArray(payload)
  && payload.method === "session/update"
  && (payload.id === undefined || payload.id === null)
);

const sessionUpdateLogCoalescer = (() => {
  const pending = new Map();
  let timer = null;

  const canCoalesce = () => ACP_REMOTE_VERBOSE && ACP_REMOTE_COALESCE_SESSION_UPDATES;

  const scheduleFlush = () => {
    if (timer || !canCoalesce()) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, ACP_REMOTE_SESSION_UPDATE_LOG_FLUSH_MS);
    timer.unref?.();
  };

  const bump = (contextLabel, direction) => {
    if (!canCoalesce()) {
      return false;
    }
    const key = `${contextLabel}|${direction}`;
    const current = pending.get(key) || { contextLabel, direction, count: 0 };
    current.count += 1;
    pending.set(key, current);
    scheduleFlush();
    return true;
  };

  const flush = (filterContextLabel) => {
    if (!canCoalesce()) {
      pending.clear();
      return;
    }
    for (const [key, entry] of pending.entries()) {
      if (filterContextLabel && entry.contextLabel !== filterContextLabel) {
        continue;
      }
      pending.delete(key);
      logDebug(`${entry.contextLabel} ${entry.direction} session/update (x${entry.count})`);
    }
    if (pending.size === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return { bump, flush };
})();

process.on("exit", () => sessionUpdateLogCoalescer.flush());
process.on("SIGINT", () => sessionUpdateLogCoalescer.flush());
process.on("SIGTERM", () => sessionUpdateLogCoalescer.flush());

const formatRpcHeader = ({ contextLabel = "", direction, payload, methodHint }) => {
  const desc = describeRpcForLog(payload);
  const typeColored = (() => {
    const label = desc.type || "unknown";
    if (label === "request") return color(ansi.blue, label);
    if (label === "response") return color(ansi.green, label);
    if (label === "notification") return color(ansi.yellow, label);
    return color(ansi.gray, label);
  })();
  const arrow = direction === "<-" ? color(ansi.cyan, "<-") : color(ansi.magenta, "->");
  const method = desc.method || methodHint || "";
  const methodPart = method ? ` ${bold(method)}` : "";
  const idPart = desc.id !== undefined ? ` ${dim(`id=${desc.id}`)}` : "";
  const ctx = contextLabel ? `${bold(contextLabel)} ` : "";
  return `${ctx}${arrow} ${typeColored}${methodPart}${idPart}`;
};

const logRpc = ({ level, contextLabel, direction, payload, methodHint }) => {
  if (level === "DEBUG" && !ACP_REMOTE_VERBOSE) {
    return;
  }
  if (isSessionUpdateNotification(payload) && sessionUpdateLogCoalescer.bump(contextLabel, direction)) {
    return;
  }
  const header = formatRpcHeader({ contextLabel, direction, payload, methodHint });
  const lines = [header];
  const desc = describeRpcForLog(payload);
  const shouldIncludePayload = ACP_REMOTE_LOG_RPC_PAYLOADS && (
    desc.type === "request"
    || desc.type === "response"
    || (ACP_REMOTE_LOG_RPC_NOTIFICATION_PAYLOADS && desc.type === "notification")
  );
  if (shouldIncludePayload && !isSessionUpdateNotification(payload)) {
    const body = safePrettyJsonForLog(payload);
    for (const line of body.split(/\r?\n/)) {
      lines.push(dim(`  ${line}`));
    }
  }
  if (level === "ERROR") logError(lines.join("\n"));
  else if (level === "WARN") logWarn(lines.join("\n"));
  else if (level === "DEBUG") logDebug(lines.join("\n"));
  else log(lines.join("\n"));
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

    const sendJsonRaw = (payload) => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(JSON.stringify(payload));
    };

    notificationHandler = (payload) => {
      logRpc({ level: "DEBUG", contextLabel: connectionLabel, direction: "->", payload });
      sendJsonRaw(payload);
    };

    runtime.on("notification", notificationHandler);

    ws.on("message", (data) => {
      void (async () => {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        const payload = parsePayload(raw);
        if (!payload) {
          logError(`${connectionLabel} invalid JSON payload.`, raw.slice(0, 200));
          logRpc({ level: "ERROR", contextLabel: connectionLabel, direction: "<-", payload: raw.slice(0, 2_000) });
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
          runtime.sendNotification(payload);
          return;
        }
        requestMethods.set(payload.id, payload.method);
        logRpc({ level: "INFO", contextLabel: connectionLabel, direction: "<-", payload });
        try {
          const response = await runtime.sendRequest(payload, requestTimeoutMs);
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

    ws.on("close", (code, reason) => {
      const reasonText = reason ? reason.toString("utf8") : "";
      log(`${connectionLabel} socket closed.`, { code, reason: reasonText });
      sessionUpdateLogCoalescer.flush(connectionLabel);
      cleanup();
    });
    ws.on("error", (err) => {
      logError(`${connectionLabel} socket error.`, err instanceof Error ? err.message : err);
      sessionUpdateLogCoalescer.flush(connectionLabel);
      cleanup();
    });
  });

  return wss;
};

module.exports = { attachAcpRemoteServer };
