const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { WebSocketServer, WebSocket } = require("ws");
const { ACPRuntime } = require("./acp-runtime");

const DEFAULT_PATH = "/acp";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PORT = 3011;

const ACP_CONFIG = process.env.ACP_CONFIG || path.join(os.homedir(), ".jetbrains", "acp.json");
const ACP_REMOTE_PATH = process.env.ACP_REMOTE_PATH || DEFAULT_PATH;
const ACP_REMOTE_TOKEN = process.env.ACP_REMOTE_TOKEN || "";
const ACP_REMOTE_AGENT = process.env.ACP_REMOTE_AGENT || "";
const ACP_REMOTE_PORT = Number(process.env.ACP_REMOTE_PORT || process.env.PORT || DEFAULT_PORT);
const ACP_REMOTE_GIT_ROOT = process.env.ACP_REMOTE_GIT_ROOT || path.join(os.homedir(), "git");
const ACP_REMOTE_REQUEST_TIMEOUT_MS = Number(process.env.ACP_REMOTE_REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
const ACP_REMOTE_GIT_USER_NAME = process.env.ACP_REMOTE_GIT_USER_NAME || "ACP Remote";
const ACP_REMOTE_GIT_USER_EMAIL = process.env.ACP_REMOTE_GIT_USER_EMAIL || "acp-remote@localhost";
const ACP_REMOTE_PUSH = !["0", "false", "no"].includes(String(process.env.ACP_REMOTE_PUSH || "true").toLowerCase());

let connectionCounter = 1;

const log = (...args) => {
  console.log(`[ACP-REMOTE-RUN ${new Date().toISOString()}]`, ...args);
};

const logError = (...args) => {
  console.error(`[ACP-REMOTE-RUN ${new Date().toISOString()}]`, ...args);
};

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const loadAcpConfig = () => {
  if (!fs.existsSync(ACP_CONFIG)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(ACP_CONFIG, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    logError("Failed to read ACP config.", err instanceof Error ? err.message : err);
    return null;
  }
};

const getAcpAgents = () => {
  const config = loadAcpConfig();
  if (!config) {
    return null;
  }
  const servers = config.agent_servers || {};
  return Object.entries(servers).map(([name, value]) => ({
    name,
    command: value.command,
    args: value.args || []
  }));
};

const resolveAcpAgentConfig = (agentName) => {
  const config = loadAcpConfig();
  if (!config) {
    throw new Error(`ACP config not found: ${ACP_CONFIG}`);
  }
  const servers = config.agent_servers || {};
  const entries = Object.entries(servers);
  if (!entries.length) {
    throw new Error("ACP config does not define any agent_servers");
  }

  const selectByName = (name) => {
    const agentConfig = servers[name];
    if (!agentConfig) {
      throw new Error(`Unknown ACP agent: ${name}`);
    }
    return { name, config: agentConfig };
  };

  if (agentName) {
    return selectByName(agentName);
  }

  if (ACP_REMOTE_AGENT) {
    return selectByName(ACP_REMOTE_AGENT);
  }

  if (servers.OpenCode) {
    return { name: "OpenCode", config: servers.OpenCode };
  }

  const [defaultName, defaultConfig] = entries[0];
  return { name: defaultName, config: defaultConfig };
};

const normalizePath = (value) => {
  if (!value) {
    return "/";
  }
  const trimmed = value.replace(/\/+$/, "");
  return trimmed || "/";
};

const getRequestUrl = (req) => new URL(req.url, `http://${req.headers.host || "localhost"}`);

const closeSocket = (socket, status, message) => {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n${message || ""}`);
  socket.destroy();
};

const isAuthorized = (token, authHeader, queryToken) => {
  if (!token) {
    return true;
  }
  if (authHeader === token || authHeader === `Bearer ${token}`) {
    return true;
  }
  return queryToken === token;
};

const buildJsonRpcError = (id, message, code = -32600) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message }
});

const parseJson = (data) => {
  const raw = typeof data === "string" ? data : data.toString("utf8");
  try {
    return { value: JSON.parse(raw), raw };
  } catch {
    return { value: null, raw };
  }
};

const isJsonRpcRequest = (payload) => payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.method === "string";

const getSessionIdFromParams = (params) => {
  if (!params || typeof params !== "object") {
    return "";
  }
  const direct = params.sessionId || params.session_id;
  return direct ? String(direct) : "";
};

const getSessionIdFromResult = (result) => {
  if (!result || typeof result !== "object") {
    return "";
  }
  const direct = result.sessionId || result.session_id;
  return direct ? String(direct) : "";
};

const generateRunId = () => {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
};

const sanitizeBranchComponent = (value) => String(value || "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

const parseGitRemote = (remoteUrl) => {
  if (!remoteUrl || typeof remoteUrl !== "string") {
    return null;
  }
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return null;
  }

  const sshMatch = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const repoPath = sshMatch[2].replace(/^\/+/, "").replace(/\.git$/i, "");
    return { host, repoPath, normalizedUrl: trimmed };
  }

  if (trimmed.startsWith("ssh://") || trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      const host = url.hostname;
      const repoPath = (url.pathname || "").replace(/^\/+/, "").replace(/\.git$/i, "");
      return { host, repoPath, normalizedUrl: trimmed };
    } catch {
      return null;
    }
  }

  return null;
};

const isSameRepo = (urlA, urlB) => {
  const parsedA = parseGitRemote(urlA);
  const parsedB = parseGitRemote(urlB);
  if (parsedA && parsedB) {
    return (
      parsedA.host.toLowerCase() === parsedB.host.toLowerCase()
      && parsedA.repoPath.toLowerCase() === parsedB.repoPath.toLowerCase()
    );
  }
  return String(urlA || "").trim() === String(urlB || "").trim();
};

const repoLocks = new Map();

const withRepoLock = async (key, fn) => {
  const tail = repoLocks.get(key) || Promise.resolve();
  const next = tail.then(fn, fn);
  repoLocks.set(key, next.catch(() => {}));
  return next;
};

const runCommand = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  child.on("error", reject);
  child.on("close", (code) => {
    if (code === 0) {
      resolve({ stdout, stderr });
    } else {
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}\n${stderr || stdout}`));
    }
  });
});

const runGit = (args, options = {}) => runCommand("git", args, options);

const ensureRepoWorkdir = async (remote, runId, notify) => {
  const parsed = parseGitRemote(remote.url);
  if (!parsed) {
    throw new Error("Unsupported git remote URL");
  }

  const segments = parsed.repoPath.split("/").filter(Boolean);
  const repoName = segments[segments.length - 1] || "repo";
  const owner = segments[0] || "owner";
  const preferredRepoDir = path.join(ACP_REMOTE_GIT_ROOT, parsed.host, ...segments);
  const candidateRepoDirs = [
    preferredRepoDir,
    path.join(ACP_REMOTE_GIT_ROOT, ...segments),
    path.join(ACP_REMOTE_GIT_ROOT, owner, repoName),
    path.join(ACP_REMOTE_GIT_ROOT, repoName),
    path.join(ACP_REMOTE_GIT_ROOT, `${owner}-${repoName}`),
    path.join(ACP_REMOTE_GIT_ROOT, parsed.host, repoName)
  ];

  let repoDir = preferredRepoDir;
  for (const candidate of candidateRepoDirs) {
    if (!fs.existsSync(path.join(candidate, ".git"))) {
      continue;
    }
    try {
      const origin = await runGit(["-C", candidate, "remote", "get-url", "origin"]);
      if (isSameRepo(origin.stdout.trim(), remote.url)) {
        repoDir = candidate;
        break;
      }
    } catch {
      // ignore
    }
  }

  if (repoDir === preferredRepoDir && fs.existsSync(ACP_REMOTE_GIT_ROOT)) {
    try {
      const dirents = fs.readdirSync(ACP_REMOTE_GIT_ROOT, { withFileTypes: true });
      for (const dirent of dirents) {
        if (!dirent.isDirectory()) {
          continue;
        }
        const candidate = path.join(ACP_REMOTE_GIT_ROOT, dirent.name);
        if (!fs.existsSync(path.join(candidate, ".git"))) {
          continue;
        }
        try {
          const origin = await runGit(["-C", candidate, "remote", "get-url", "origin"]);
          if (isSameRepo(origin.stdout.trim(), remote.url)) {
            repoDir = candidate;
            break;
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  const worktreesRoot = path.join(ACP_REMOTE_GIT_ROOT, ".acp-remote-worktrees", parsed.host, ...parsed.repoPath.split("/").filter(Boolean));
  const workdir = path.join(worktreesRoot, runId);
  const branchName = `agent/changes-${sanitizeBranchComponent(runId).slice(0, 24)}`;

  const ref = remote.revision || (remote.branch ? `origin/${remote.branch}` : "");
  if (!ref) {
    throw new Error("Missing remote revision");
  }

  await withRepoLock(repoDir, async () => {
    ensureDir(path.dirname(repoDir));
    ensureDir(path.dirname(workdir));

    if (!fs.existsSync(repoDir)) {
      notify("git/clone", "Cloning repository", { url: remote.url, repoDir });
      await runGit(["clone", remote.url, repoDir]);
    } else if (!fs.existsSync(path.join(repoDir, ".git"))) {
      throw new Error(`Path exists but is not a git repository: ${repoDir}`);
    } else {
      notify("git/open", "Using existing repository", { repoDir });
    }

    try {
      const currentRemote = await runGit(["-C", repoDir, "remote", "get-url", "origin"]);
      const actual = currentRemote.stdout.trim();
      if (actual && actual !== remote.url) {
        notify("git/remote", "Updating origin remote URL", { from: actual, to: remote.url });
        await runGit(["-C", repoDir, "remote", "set-url", "origin", remote.url]);
      }
    } catch {
      // ignore - repository might not have origin
    }

    notify("git/fetch", "Fetching latest refs", { repoDir });
    await runGit(["-C", repoDir, "fetch", "--prune", "origin"]);

    if (fs.existsSync(workdir)) {
      notify("git/worktree", "Removing stale worktree", { workdir });
      try {
        await runGit(["-C", repoDir, "worktree", "remove", "--force", workdir]);
      } catch {
        // ignore
      }
      try {
        fs.rmSync(workdir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    notify("git/worktree", "Creating worktree", { workdir, branchName, ref });
    await runGit(["-C", repoDir, "worktree", "add", "-B", branchName, workdir, ref]);
  });

  return { repoDir, workdir, branchName, remoteUrl: remote.url };
};

const ensureCommittedAndPushed = async (context, notify) => {
  notify("git/status", "Checking working tree", { workdir: context.workdir });
  const status = await runGit(["-C", context.workdir, "status", "--porcelain"]);
  const dirty = status.stdout.trim().length > 0;

  if (dirty) {
    notify("git/commit", "Creating commit", {});
    await runGit(["-C", context.workdir, "add", "-A"]);
    const message = `ACP remote run changes (${new Date().toISOString()})`;
    await runGit([
      "-C",
      context.workdir,
      "-c",
      `user.name=${ACP_REMOTE_GIT_USER_NAME}`,
      "-c",
      `user.email=${ACP_REMOTE_GIT_USER_EMAIL}`,
      "commit",
      "-m",
      message
    ]);
  } else {
    notify("git/commit", "No uncommitted changes", {});
  }

  const head = await runGit(["-C", context.workdir, "rev-parse", "HEAD"]);
  const revision = head.stdout.trim();

  if (ACP_REMOTE_PUSH) {
    notify("git/push", "Pushing branch", { branch: context.branchName });
    await runGit(["-C", context.workdir, "push", "-u", "origin", context.branchName]);
  } else {
    notify("git/push", "Push disabled", { branch: context.branchName });
  }

  return {
    url: context.remoteUrl,
    branch: `refs/heads/${context.branchName}`,
    revision
  };
};

const attachTargetMeta = (response, target) => {
  if (!response || typeof response !== "object") {
    return response;
  }
  const result = response.result;
  if (!result || typeof result !== "object") {
    return response;
  }
  result._meta = { ...(result._meta || {}), target };
  return response;
};

const sendJson = (ws, payload) => {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
};

const startAcpRemoteRunServer = () => {
  const expectedPath = normalizePath(ACP_REMOTE_PATH);
  const wss = new WebSocketServer({ noServer: true });

  const httpServer = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = getRequestUrl(req);
    if (req.method === "GET" && normalizePath(url.pathname) === "/acp/agents") {
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
      closeSocket(socket, "401 Unauthorized");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req) => {
    const connectionId = connectionCounter++;
    const connectionLabel = `conn:${connectionId}`;
    const url = getRequestUrl(req);
    const queryAgent = url.searchParams.get("agent") || "";
    const agentInfo = resolveAcpAgentConfig(queryAgent);
    const runtime = new ACPRuntime(agentInfo.config);
    const sessionContexts = new Map();
    const requestIdToMethod = new Map();

    const notify = (stage, message, extra = {}) => {
      const payload = {
        jsonrpc: "2.0",
        method: "remote/progress",
        params: {
          stage,
          message,
          ...extra
        }
      };
      sendJson(ws, payload);
    };

    log(`${connectionLabel} connected.`, { agent: agentInfo.name, path: url.pathname });
    notify("connection", "Connected", { agent: agentInfo.name });

    runtime.on("notification", (payload) => {
      sendJson(ws, payload);
    });

    ws.on("message", (data) => {
      void (async () => {
        const parsed = parseJson(data);
        if (!parsed.value) {
          logError(`${connectionLabel} invalid JSON payload.`, parsed.raw.slice(0, 200));
          sendJson(ws, buildJsonRpcError(null, "Invalid JSON"));
          return;
        }

        const messages = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
        for (const message of messages) {
          if (!isJsonRpcRequest(message)) {
            sendJson(ws, buildJsonRpcError(message?.id ?? null, "Invalid JSON-RPC payload"));
            continue;
          }

          const isNotification = message.id === undefined || message.id === null;
          if (isNotification) {
            runtime.sendNotification(message);
            continue;
          }

          requestIdToMethod.set(message.id, message.method);

          if (message.method === "session/new") {
            try {
              const params = message.params && typeof message.params === "object" ? message.params : {};
              const remote = params?._meta?.remote;
              if (!remote?.url || !remote?.revision) {
                notify("session/new", "Missing _meta.remote (delegating without git prep)", {});
                const response = await runtime.sendRequest(message, ACP_REMOTE_REQUEST_TIMEOUT_MS);
                sendJson(ws, response);
                continue;
              }

              const runId = generateRunId();
              notify("session/new", "Preparing git workspace", { url: remote.url, branch: remote.branch, revision: remote.revision, runId });

              const context = await ensureRepoWorkdir(remote, runId, notify);
              let initialTarget = null;
              try {
                notify("git", "Ensuring target branch exists", { branch: context.branchName });
                initialTarget = await ensureCommittedAndPushed(context, notify);
                notify("git", "Target branch ready", { target: initialTarget });
              } catch (pushErr) {
                const pushMessage = pushErr instanceof Error ? pushErr.message : "Failed to push target branch";
                logError(`${connectionLabel} initial push failed.`, pushMessage);
                notify("git", "Initial push failed", { error: pushMessage });
              }
              notify("session/new", "Starting ACP session", { cwd: context.workdir });

              const agentParams = { ...params, cwd: context.workdir };
              const agentMessage = { ...message, params: agentParams };

              const response = await runtime.sendRequest(agentMessage, ACP_REMOTE_REQUEST_TIMEOUT_MS);
              const sessionId = getSessionIdFromResult(response?.result);
              if (sessionId) {
                sessionContexts.set(sessionId, { ...context, runId, remote });
                notify("session/new", "Session created", { sessionId, cwd: context.workdir });
              } else {
                notify("session/new", "Session created (unknown sessionId)", { cwd: context.workdir });
              }
              sendJson(ws, initialTarget ? attachTargetMeta(response, initialTarget) : response);
            } catch (err) {
              const messageText = err instanceof Error ? err.message : "Remote session setup failed";
              logError(`${connectionLabel} session/new failed.`, messageText);
              notify("session/new", "Failed", { error: messageText });
              sendJson(ws, buildJsonRpcError(message.id, messageText, -32000));
            }
            continue;
          }

          if (message.method === "session/prompt") {
            try {
              const response = await runtime.sendRequest(message, ACP_REMOTE_REQUEST_TIMEOUT_MS);
              const sessionId = getSessionIdFromParams(message.params);
              if (!sessionId) {
                sendJson(ws, response);
                continue;
              }
              const context = sessionContexts.get(sessionId);
              if (!context) {
                sendJson(ws, response);
                continue;
              }
              try {
                notify("git", "Committing and pushing changes", { sessionId });
                const target = await ensureCommittedAndPushed(context, notify);
                notify("git", "Target branch ready", { target });
                sendJson(ws, attachTargetMeta(response, target));
              } catch (pushErr) {
                const pushMessage = pushErr instanceof Error ? pushErr.message : "Failed to push changes";
                logError(`${connectionLabel} push failed.`, pushMessage);
                notify("git", "Push failed", { error: pushMessage });
                sendJson(ws, response);
              }
            } catch (err) {
              const messageText = err instanceof Error ? err.message : "ACP runtime error";
              sendJson(ws, buildJsonRpcError(message.id, messageText, -32000));
            }
            continue;
          }

          try {
            const response = await runtime.sendRequest(message, ACP_REMOTE_REQUEST_TIMEOUT_MS);
            sendJson(ws, response);
          } catch (err) {
            const messageText = err instanceof Error ? err.message : "ACP runtime error";
            sendJson(ws, buildJsonRpcError(message.id, messageText, -32000));
          }
        }
      })();
    });

    const cleanup = () => {
      runtime.stop();
      const contexts = Array.from(sessionContexts.values());
      sessionContexts.clear();
      void (async () => {
        for (const context of contexts) {
          try {
            notify("git/cleanup", "Removing worktree", { workdir: context.workdir });
            await runGit(["-C", context.repoDir, "worktree", "remove", "--force", context.workdir]);
          } catch (err) {
            logError(`${connectionLabel} failed to remove worktree.`, err instanceof Error ? err.message : err);
          }
        }
      })();
    };

    ws.on("close", (code, reason) => {
      log(`${connectionLabel} closed.`, { code, reason: reason ? reason.toString("utf8") : "" });
      cleanup();
    });

    ws.on("error", (err) => {
      logError(`${connectionLabel} socket error.`, err instanceof Error ? err.message : err);
      cleanup();
    });

    runtime.start();
  });

  httpServer.listen(ACP_REMOTE_PORT, () => {
    log(`Remote run server listening on http://localhost:${ACP_REMOTE_PORT}`);
    log(`WebSocket endpoint -> ws://localhost:${ACP_REMOTE_PORT}${expectedPath}`);
    log(`Agents endpoint -> http://localhost:${ACP_REMOTE_PORT}/acp/agents`);
    log(`ACP config -> ${ACP_CONFIG}`);
    log(`Git root -> ${ACP_REMOTE_GIT_ROOT}`);
  });

  return httpServer;
};

startAcpRemoteRunServer();
