import * as http from "http";
import {WebSocket, WebSocketServer} from "ws";
import {
  ACP_CONFIG,
  ACP_REMOTE_CONFIG,
  ACP_REMOTE_ADVERTISE_HOST,
  ACP_REMOTE_ADVERTISE_PROTOCOL,
  ACP_REMOTE_BIND_HOST,
  ACP_REMOTE_GIT_ROOT,
  ACP_REMOTE_GIT_ROOT_MAP,
  ACP_REMOTE_GIT_ROOT_MAP_SOURCE_LABEL,
  ACP_REMOTE_GIT_ROOT_SOURCE,
  ACP_REMOTE_GIT_ROOT_SOURCE_LABEL,
  ACP_REMOTE_PATH,
  ACP_REMOTE_PORT,
  ACP_REMOTE_REQUEST_TIMEOUT_MS,
  ACP_REMOTE_TOKEN,
  getAcpAgents,
  resolveAcpAgentConfig
} from "./config";
import {AcpAgentRuntime, getSessionIdFromPayloadParams} from "./agent";
import {
  ensureCommittedAndPushed,
  ensureRepoWorkdir,
  generateRunId,
  redactGitUrl,
  type RemoteGitInfo,
  summarizeMetaForLog,
  type TargetGitInfo
} from "./git";
import {
  buildJsonRpcError,
  closeSocket,
  getRequestUrl,
  getSessionIdFromParams,
  getSessionIdFromResult,
  isAuthorized,
  isJsonRpcRequest,
  normalizeJsonRpcResponse,
  normalizePath,
  parseJson,
  redactUrlForLogs,
  stripMetaFromParams
} from "./jsonrpc";
import {describeRpcForLog, log, logDebug, logError, logRpc, logWarn, sessionUpdateLogCoalescer} from "./logger";
import {RemoteRunSessionManager} from "./sessions";

let connectionCounter = 1;

const ACP_STOP_REASONS = new Set(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]);

const normalizePromptResponseForAcp = (response: any, contextLabel = "") => {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return response;
  }
  if ("error" in response) {
    return response;
  }
  if (!("result" in response)) {
    return response;
  }

  const current = (response as any).result;
  const coerced: any = (() => {
    if (typeof current === "string") {
      return { stopReason: current };
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return {};
    }
    return current;
  })();

  if (!coerced.stopReason || typeof coerced.stopReason !== "string") {
    logWarn(`${contextLabel} session/prompt response missing stopReason; defaulting to end_turn.`);
    coerced.stopReason = "end_turn";
  } else if (!ACP_STOP_REASONS.has(coerced.stopReason)) {
    logWarn(`${contextLabel} session/prompt response has invalid stopReason; defaulting to end_turn.`, {
      stopReason: coerced.stopReason
    });
    coerced.stopReason = "end_turn";
  }
  if (
    "_meta" in coerced
    && coerced._meta !== null
    && (typeof coerced._meta !== "object" || Array.isArray(coerced._meta))
  ) {
    logWarn(`${contextLabel} session/prompt response has invalid _meta; dropping.`);
    coerced._meta = null;
  }

  (response as any).result = coerced;
  return response;
};

const attachTargetMeta = (response: any, target: TargetGitInfo, contextLabel = "") => {
  if (!response || typeof response !== "object") {
    return response;
  }
  const result = (response as any).result;
  if (!result || typeof result !== "object") {
    return response;
  }
  logDebug(`${contextLabel} attaching target to response result._meta.`, {
    url: redactGitUrl(target?.url),
    branch: target?.branch,
    revision: target?.revision
  });
  (result as any)._meta = { ...(((result as any)._meta) || {}), target };
  return response;
};

const sendJson = (ws: WebSocket, payload: any) => {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
};

const sendJsonRpc = (ws: WebSocket, payload: any, contextLabel = "", requestMethodById: Map<any, string> | null = null) => {
  if (Array.isArray(payload)) {
    logDebug(`${contextLabel} sending batch (${payload.length}).`);
    for (const item of payload) {
      sendJsonRpc(ws, item, contextLabel, requestMethodById);
    }
    return;
  }
  if (!payload) {
    logWarn(`${contextLabel} attempted to send empty payload.`);
    return;
  }
  const desc = describeRpcForLog(payload);
  const methodHint = (
    desc.type === "response"
    && requestMethodById
    && payload
    && typeof payload === "object"
    && !Array.isArray(payload)
    && "id" in payload
  ) ? requestMethodById.get((payload as any).id) : undefined;
  const level = desc.type === "response" ? "INFO" : "DEBUG";
  logRpc({ level, contextLabel, direction: "->", payload, methodHint });
  sendJson(ws, payload);
  if (
    desc.type === "response"
    && requestMethodById
    && payload
    && typeof payload === "object"
    && !Array.isArray(payload)
    && "id" in payload
  ) {
    requestMethodById.delete((payload as any).id);
  }
};

export const startAcpRemoteRunServer = () => {
  const expectedPath = normalizePath(ACP_REMOTE_PATH);
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new RemoteRunSessionManager();
  const runtimeSubscribersById = new Map<string, Set<WebSocket>>();

  log("Git root configured.", {
    gitRoot: ACP_REMOTE_GIT_ROOT,
    gitRootSource: ACP_REMOTE_GIT_ROOT_SOURCE,
    gitRootSourceLabel: ACP_REMOTE_GIT_ROOT_SOURCE_LABEL,
    gitRootMapEntries: Object.keys(ACP_REMOTE_GIT_ROOT_MAP || {}).length,
    gitRootMapSourceLabel: ACP_REMOTE_GIT_ROOT_MAP_SOURCE_LABEL,
    acpRemoteConfig: ACP_REMOTE_CONFIG
  });

  const httpServer = http.createServer((req, res) => {
    const startedAt = Date.now();
    const url = getRequestUrl(req);
    const remoteAddress = req.socket.remoteAddress || "unknown";
    const remotePort = req.socket.remotePort;
    const remoteLabel = remotePort ? `${remoteAddress}:${remotePort}` : remoteAddress;

    res.on("finish", () => {
      const durationMs = Date.now() - startedAt;
      logDebug("HTTP request processed.", {
        remote: remoteLabel,
        method: req.method,
        path: redactUrlForLogs(url),
        statusCode: res.statusCode,
        durationMs
      });
    });

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && normalizePath(url.pathname) === "/acp/agents") {
      logDebug("HTTP route matched.", { route: "GET /acp/agents", remote: remoteLabel });
      const agents = getAcpAgents();
      if (!agents) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "ACP config not found" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ agents }));
      return;
    }

    if (req.method === "GET" && normalizePath(url.pathname) === "/health") {
      logDebug("HTTP route matched.", { route: "GET /health", remote: remoteLabel });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Not found" } }));
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = getRequestUrl(req);
    if (normalizePath(url.pathname) !== expectedPath) {
      return;
    }
    if (!isAuthorized(ACP_REMOTE_TOKEN, req.headers.authorization, url.searchParams.get("token"))) {
      logError("Upgrade rejected (unauthorized).", { remote: req.socket.remoteAddress || "unknown", path: url.pathname });
      closeSocket(socket, "401 Unauthorized");
      return;
    }
    log("Upgrade accepted.", { remote: req.socket.remoteAddress || "unknown", path: url.pathname });
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket, req) => {
    const connectionId = connectionCounter++;
    const connectionLabel = `conn:${connectionId}`;
    const url = getRequestUrl(req);
    const queryAgent = url.searchParams.get("agent") || "";
    const remoteAddress = req.socket.remoteAddress || "unknown";
    const remotePort = req.socket.remotePort;
    const remoteLabel = remotePort ? `${remoteAddress}:${remotePort}` : remoteAddress;

    let agentInfo: { name: string; config: any };
    let runtime: AcpAgentRuntime;
    try {
      agentInfo = resolveAcpAgentConfig(queryAgent);
      runtime = new AcpAgentRuntime({
        id: `rt:${connectionId}`,
        agent: agentInfo,
        onNotification: (payload) => {
          const sessionId = getSessionIdFromPayloadParams(payload);
          if (sessionId) {
            const subscribers = sessions.getSubscribers(sessionId);
            if (subscribers.size > 0) {
              for (const subscriber of subscribers) {
                sendJsonRpc(subscriber, payload, `sess:${sessionId}`);
              }
              return;
            }
          }
          const runtimeSubscribers = runtimeSubscribersById.get(runtime.id);
          if (runtimeSubscribers && runtimeSubscribers.size > 0) {
            for (const subscriber of runtimeSubscribers) {
              sendJsonRpc(subscriber, payload, runtime.id);
            }
          }
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start ACP runtime";
      logError(`${connectionLabel} failed to configure ACP runtime.`, { remote: remoteLabel, agent: queryAgent || "default", error: message });
      sendJsonRpc(ws, buildJsonRpcError(null, message, -32000), connectionLabel);
      ws.close(1011, "ACP runtime error");
      return;
    }

    const requestMethodById = new Map<any, string>();
    const addRuntimeSubscriber = (runtimeId: string, socket: WebSocket) => {
      const set = runtimeSubscribersById.get(runtimeId) || new Set<WebSocket>();
      set.add(socket);
      runtimeSubscribersById.set(runtimeId, set);
    };
    addRuntimeSubscriber(runtime.id, ws);

    const sendRpc = (payload: any) => sendJsonRpc(ws, payload, connectionLabel, requestMethodById);

    const notify = (stage: string, message: string, extra: any = {}) => {
      const payload = {
        jsonrpc: "2.0",
        method: "remote/progress",
        params: {
          stage,
          message,
          ...extra
        }
      };
      sendRpc(payload);
    };

    log(`${connectionLabel} connected.`, { remote: remoteLabel, agent: agentInfo.name, path: url.pathname });
    notify("connection", "Connected", { agent: agentInfo.name });

    ws.on("message", (data) => {
      void (async () => {
        const parsed = parseJson(data);
        if (!parsed.value) {
          logError(`${connectionLabel} invalid JSON payload.`, parsed.raw.slice(0, 200));
          sendRpc(buildJsonRpcError(null, "Invalid JSON"));
          return;
        }

        const messages = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
        logDebug(`${connectionLabel} received ${messages.length} message(s).`);
        for (const message of messages) {
          const startedAt = Date.now();
          const inboundDesc = describeRpcForLog(message);
          if (
            inboundDesc.type === "request"
            && message
            && typeof message === "object"
            && !Array.isArray(message)
            && (message as any).id !== null
            && (message as any).id !== undefined
          ) {
            requestMethodById.set((message as any).id, (message as any).method);
            logRpc({ level: "INFO", contextLabel: connectionLabel, direction: "<-", payload: message });
          } else if (inboundDesc.type === "notification") {
            logRpc({ level: "DEBUG", contextLabel: connectionLabel, direction: "<-", payload: message });
          } else {
            logRpc({ level: "DEBUG", contextLabel: connectionLabel, direction: "<-", payload: message });
          }

          const hasMeta = Boolean(
            (message as any)?.params
            && typeof (message as any).params === "object"
            && !Array.isArray((message as any).params)
            && "_meta" in (message as any).params
          );
          if (hasMeta) {
            logDebug(`${connectionLabel} received params._meta.`, summarizeMetaForLog((message as any).params._meta));
          }

          if (!isJsonRpcRequest(message)) {
            sendRpc(buildJsonRpcError((message as any)?.id ?? null, "Invalid JSON-RPC payload"));
            continue;
          }

          const isNotification = (message as any).id === undefined || (message as any).id === null;
          const sessionIdFromParams = getSessionIdFromParams((message as any).params);
          const knownSession = sessionIdFromParams ? sessions.get(sessionIdFromParams) : undefined;
          const sessionRuntime = knownSession?.runtime;
          if (sessionIdFromParams && sessionRuntime) {
            addRuntimeSubscriber(sessionRuntime.id, ws);
            sessions.attach(sessionIdFromParams, ws);
            sessions.touch(sessionIdFromParams);
          }

          if (isNotification) {
            logDebug(`${connectionLabel} processing notification.`, { method: (message as any).method });
            try {
              (sessionRuntime || runtime).sendNotification(message);
            } catch (err) {
              logError(`${connectionLabel} failed to forward notification.`, err instanceof Error ? err.message : String(err));
            }
            logDebug(`${connectionLabel} notification forwarded to runtime.`, { method: (message as any).method, durationMs: Date.now() - startedAt });
            continue;
          }

          logDebug(`${connectionLabel} processing request.`, { method: (message as any).method, id: (message as any).id });

          if (hasMeta && (message as any).method !== "session/new") {
            logDebug(`${connectionLabel} stripping params._meta before forwarding to runtime.`, { method: (message as any).method });
          }

          if ((message as any).method === "session/new") {
            try {
              const params = (message as any).params && typeof (message as any).params === "object" ? (message as any).params : {};
              const meta = (params as any)?._meta;
              const remote: RemoteGitInfo | undefined = (meta as any)?.remote;
              logDebug(`${connectionLabel} session/new extracting _meta.remote.`, {
                meta: summarizeMetaForLog(meta),
                hasRemote: Boolean(remote),
                url: redactGitUrl(remote?.url),
                branch: (remote as any)?.branch,
                revision: (remote as any)?.revision
              });

              if (!remote?.url || !remote?.revision) {
                notify("session/new", "Missing _meta.remote (delegating without git prep)", {});
                const delegatedMessage = { ...message, params: stripMetaFromParams((message as any).params) };
                const response = await runtime.sendRequest(delegatedMessage, ACP_REMOTE_REQUEST_TIMEOUT_MS);
                const formatted = normalizeJsonRpcResponse(response, (message as any).id);
                sendRpc(formatted);
                const sessionId = getSessionIdFromResult((formatted as any)?.result);
                if (sessionId) {
                  sessions.ensure(sessionId, runtime);
                  sessions.attach(sessionId, ws);
                  sessions.touch(sessionId);
                }
                logDebug(`${connectionLabel} session/new completed (delegated).`, { id: (message as any).id, durationMs: Date.now() - startedAt });
                continue;
              }

              const runId = generateRunId();
              notify("session/new", "Preparing git workspace", { url: remote.url, branch: remote.branch, revision: remote.revision, runId });
              logDebug(`${connectionLabel} session/new starting git workspace prep.`, { runId, url: redactGitUrl(remote.url), revision: remote.revision });

              const workspace = await ensureRepoWorkdir(remote, runId, notify);
              logDebug(`${connectionLabel} session/new git workspace ready.`, { runId, workdir: workspace.workdir, repoDir: workspace.repoDir, branchName: workspace.branchName });
              let initialTarget: TargetGitInfo | null = null;
              try {
                notify("git", "Ensuring target branch exists", { branch: workspace.branchName });
                initialTarget = await ensureCommittedAndPushed(workspace, notify);
                notify("git", "Target branch ready", { target: initialTarget });
              } catch (pushErr) {
                const pushMessage = pushErr instanceof Error ? pushErr.message : "Failed to push target branch";
                logError(`${connectionLabel} initial push failed.`, pushMessage);
                notify("git", "Initial push failed", { error: pushMessage });
              }

              notify("session/new", "Starting ACP session", { cwd: workspace.workdir });
              const agentParams = stripMetaFromParams({ ...params, cwd: workspace.workdir });
              const agentMessage = { ...message, params: agentParams };
              logDebug(`${connectionLabel} session/new forwarding request to runtime with updated cwd.`, {
                id: (message as any).id,
                cwd: workspace.workdir,
                metaStripped: "_meta" in (params || {})
              });

              const response = await runtime.sendRequest(agentMessage, ACP_REMOTE_REQUEST_TIMEOUT_MS);
              const formatted = normalizeJsonRpcResponse(response, (message as any).id);
              const sessionId = getSessionIdFromResult((formatted as any)?.result);
              if (sessionId) {
                sessions.ensure(sessionId, runtime);
                sessions.setGitContext(sessionId, { runId, remote, workspace });
                sessions.attach(sessionId, ws);
                sessions.touch(sessionId);
                notify("session/new", "Session created", { sessionId, cwd: workspace.workdir });
              } else {
                notify("session/new", "Session created (unknown sessionId)", { cwd: workspace.workdir });
              }
              sendRpc(initialTarget ? attachTargetMeta(formatted, initialTarget, connectionLabel) : formatted);
              logDebug(`${connectionLabel} session/new completed.`, { id: (message as any).id, sessionId: sessionId || null, durationMs: Date.now() - startedAt });
            } catch (err) {
              const messageText = err instanceof Error ? err.message : "Remote session setup failed";
              logError(`${connectionLabel} session/new failed.`, messageText);
              notify("session/new", "Failed", { error: messageText });
              sendRpc(buildJsonRpcError((message as any).id, messageText, -32000));
              logDebug(`${connectionLabel} session/new error returned.`, { id: (message as any).id, durationMs: Date.now() - startedAt });
            }
            continue;
          }

          if ((message as any).method === "session/load") {
            const sessionId = getSessionIdFromParams((message as any).params);
            if (!sessionId) {
              sendRpc(buildJsonRpcError((message as any).id, "Missing sessionId", -32602));
              continue;
            }
            const record = sessions.get(sessionId);
            if (!record) {
              sendRpc(buildJsonRpcError((message as any).id, `Session not found: ${sessionId}`, -32000));
              continue;
            }
            try {
              addRuntimeSubscriber(record.runtime.id, ws);
              sessions.attach(sessionId, ws);
              sessions.touch(sessionId);
              const params: any = (message as any).params && typeof (message as any).params === "object" ? (message as any).params : {};
              const appliedCwd = record.workspace?.workdir || params.cwd;
              const forwardMessage = { ...message, params: stripMetaFromParams({ ...params, cwd: appliedCwd }) };
              const response = await record.runtime.sendRequest(forwardMessage, ACP_REMOTE_REQUEST_TIMEOUT_MS);
              const formatted = normalizeJsonRpcResponse(response, (message as any).id);
              sendRpc(formatted);
            } catch (err) {
              const messageText = err instanceof Error ? err.message : "ACP runtime error";
              sendRpc(buildJsonRpcError((message as any).id, messageText, -32000));
            }
            continue;
          }

          if ((message as any).method === "session/prompt") {
            try {
              const chosenRuntime = sessionRuntime || runtime;
              const forwardMessage = { ...message, params: stripMetaFromParams((message as any).params) };
              const response = await chosenRuntime.sendRequest(forwardMessage, ACP_REMOTE_REQUEST_TIMEOUT_MS);
              const formatted = normalizePromptResponseForAcp(normalizeJsonRpcResponse(response, (message as any).id), connectionLabel);
              const sessionId = getSessionIdFromParams((message as any).params);
              const record = sessionId ? sessions.get(sessionId) : undefined;
              if (!record || !record.workspace) {
                sendRpc(formatted);
                logDebug(`${connectionLabel} session/prompt completed.`, { id: (message as any).id, sessionId: sessionId || null, durationMs: Date.now() - startedAt });
                continue;
              }
              try {
                notify("git", "Committing and pushing changes", { sessionId });
                const target = await ensureCommittedAndPushed(record.workspace, notify);
                notify("git", "Target branch ready", { target });
                sendRpc(attachTargetMeta(formatted, target, connectionLabel));
                logDebug(`${connectionLabel} session/prompt completed (pushed).`, { id: (message as any).id, sessionId, durationMs: Date.now() - startedAt });
              } catch (pushErr) {
                const pushMessage = pushErr instanceof Error ? pushErr.message : "Failed to push changes";
                logError(`${connectionLabel} push failed.`, pushMessage);
                notify("git", "Push failed", { error: pushMessage });
                sendRpc(formatted);
                logDebug(`${connectionLabel} session/prompt completed (push failed).`, { id: (message as any).id, sessionId, durationMs: Date.now() - startedAt });
              }
            } catch (err) {
              const messageText = err instanceof Error ? err.message : "ACP runtime error";
              sendRpc(buildJsonRpcError((message as any).id, messageText, -32000));
              logDebug(`${connectionLabel} session/prompt error returned.`, { id: (message as any).id, durationMs: Date.now() - startedAt });
            }
            continue;
          }

          try {
            const chosenRuntime = sessionRuntime || runtime;
            const forwardMessage = { ...message, params: stripMetaFromParams((message as any).params) };
            const response = await chosenRuntime.sendRequest(forwardMessage, ACP_REMOTE_REQUEST_TIMEOUT_MS);
            const formatted = normalizeJsonRpcResponse(response, (message as any).id);
            sendRpc(formatted);
            logDebug(`${connectionLabel} request completed.`, { method: (message as any).method, id: (message as any).id, durationMs: Date.now() - startedAt });
          } catch (err) {
            const messageText = err instanceof Error ? err.message : "ACP runtime error";
            sendRpc(buildJsonRpcError((message as any).id, messageText, -32000));
            logDebug(`${connectionLabel} request error returned.`, { method: (message as any).method, id: (message as any).id, durationMs: Date.now() - startedAt });
          }
        }
      })();
    });

    const cleanupConnection = () => {
      sessions.detach(ws);
      for (const [runtimeId, subscribers] of runtimeSubscribersById.entries()) {
        subscribers.delete(ws);
        if (subscribers.size === 0) {
          runtimeSubscribersById.delete(runtimeId);
        }
      }
      if (!sessions.hasSessionsForRuntime(runtime.id)) {
        runtime.stop();
      }
    };

    ws.on("close", (code, reason) => {
      log(`${connectionLabel} closed.`, { code, reason: reason ? reason.toString("utf8") : "" });
      sessionUpdateLogCoalescer.flush(connectionLabel);
      cleanupConnection();
    });

    ws.on("error", (err) => {
      logError(`${connectionLabel} socket error.`, err instanceof Error ? err.message : err);
      sessionUpdateLogCoalescer.flush(connectionLabel);
      cleanupConnection();
    });
  });

  httpServer.listen(ACP_REMOTE_PORT, ACP_REMOTE_BIND_HOST || undefined, () => {
    const protocol = String(ACP_REMOTE_ADVERTISE_PROTOCOL || "http").toLowerCase();
    const wsProtocol = protocol === "https" ? "wss" : "ws";
    const baseUrl = `${protocol}://${ACP_REMOTE_ADVERTISE_HOST}:${ACP_REMOTE_PORT}`;
    log("Remote run server listening.", { port: ACP_REMOTE_PORT, bindHost: ACP_REMOTE_BIND_HOST || "0.0.0.0", advertiseAs: baseUrl });
    log(`WebSocket endpoint -> ${wsProtocol}://${ACP_REMOTE_ADVERTISE_HOST}:${ACP_REMOTE_PORT}${expectedPath}`);
    log(`Agents endpoint -> ${baseUrl}/acp/agents`);
    log(`ACP config -> ${ACP_CONFIG}`);
    log(`ACP remote config -> ${ACP_REMOTE_CONFIG}`);
    log(`Default git root -> ${ACP_REMOTE_GIT_ROOT}`);
  });

  return httpServer;
};
