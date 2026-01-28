const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const util = require("util");
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
const resolveHomeDir = (value) => {
  if (typeof value !== "string") {
    return "";
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
};

const ACP_REMOTE_GIT_ROOT_SOURCE = process.env.ACP_REMOTE_GIT_ROOT || "~/git";
const ACP_REMOTE_GIT_ROOT_SOURCE_LABEL = process.env.ACP_REMOTE_GIT_ROOT ? "env:ACP_REMOTE_GIT_ROOT" : "default";
const ACP_REMOTE_GIT_ROOT = path.resolve(resolveHomeDir(ACP_REMOTE_GIT_ROOT_SOURCE));
const ACP_REMOTE_REQUEST_TIMEOUT_MS = Number(process.env.ACP_REMOTE_REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
const ACP_REMOTE_GIT_USER_NAME = process.env.ACP_REMOTE_GIT_USER_NAME || "ACP Remote";
const ACP_REMOTE_GIT_USER_EMAIL = process.env.ACP_REMOTE_GIT_USER_EMAIL || "acp-remote@localhost";
const ACP_REMOTE_PUSH = !["0", "false", "no"].includes(String(process.env.ACP_REMOTE_PUSH || "true").toLowerCase());
const ACP_REMOTE_VERBOSE = !["0", "false", "no"].includes(String(process.env.ACP_REMOTE_VERBOSE || "true").toLowerCase());
const ACP_REMOTE_LOG_PAYLOADS = !["0", "false", "no"].includes(String(process.env.ACP_REMOTE_LOG_PAYLOADS || "false").toLowerCase());
const ACP_REMOTE_COALESCE_SESSION_UPDATES = !["0", "false", "no"].includes(
  String(process.env.ACP_REMOTE_COALESCE_SESSION_UPDATES || "true").toLowerCase()
);
const ACP_REMOTE_SESSION_UPDATE_LOG_FLUSH_MS = Number(process.env.ACP_REMOTE_SESSION_UPDATE_LOG_FLUSH_MS || 2_000);

let connectionCounter = 1;

const START_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_DIR = path.join(__dirname, ".log");
const LOG_FILE_PATH = path.join(LOG_DIR, `${START_TIMESTAMP}-acp-remote.log`);
let logFileStream = null;

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  logFileStream = fs.createWriteStream(LOG_FILE_PATH, { flags: "a" });
  logFileStream.on("error", () => {
    logFileStream = null;
  });
} catch {
  logFileStream = null;
}

const writeLogLineToFile = (line) => {
  if (!logFileStream) {
    return;
  }
  try {
    logFileStream.write(`${line}\n`);
  } catch {
    // ignore file logging failures
  }
};

const logWithLevel = (level, ...args) => {
  const prefix = `[ACP-REMOTE-RUN ${new Date().toISOString()}]${level ? ` [${level}]` : ""}`;
  writeLogLineToFile(util.format(prefix, ...args));
  if (level === "ERROR") {
    console.error(prefix, ...args);
  } else if (level === "WARN") {
    console.warn(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
};

const log = (...args) => logWithLevel("INFO", ...args);
const logWarn = (...args) => logWithLevel("WARN", ...args);
const logError = (...args) => logWithLevel("ERROR", ...args);
const logDebug = (...args) => {
  if (!ACP_REMOTE_VERBOSE) {
    return;
  }
  logWithLevel("DEBUG", ...args);
};

const sessionUpdateLogCoalescer = (() => {
  const pending = new Map();
  let timer = null;

  const canCoalesce = () => ACP_REMOTE_VERBOSE && ACP_REMOTE_COALESCE_SESSION_UPDATES && !ACP_REMOTE_LOG_PAYLOADS;

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

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const closeLogFile = () => {
  if (!logFileStream) {
    return;
  }
  try {
    logFileStream.end();
  } catch {
    // ignore
  } finally {
    logFileStream = null;
  }
};

process.on("exit", () => {
  sessionUpdateLogCoalescer.flush();
  closeLogFile();
});
process.on("SIGINT", () => {
  sessionUpdateLogCoalescer.flush();
  closeLogFile();
  process.exit(0);
});
process.on("SIGTERM", () => {
  sessionUpdateLogCoalescer.flush();
  closeLogFile();
  process.exit(0);
});

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

const redactUrlForLogs = (url) => {
  if (!url) {
    return "";
  }
  try {
    const copy = new URL(url.toString());
    for (const key of ["token", "authorization", "api_key", "apikey"]) {
      if (copy.searchParams.has(key)) {
        copy.searchParams.set(key, "[REDACTED]");
      }
    }
    return `${copy.pathname}${copy.search || ""}`;
  } catch {
    return String(url);
  }
};

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

const normalizeJsonRpcError = (error) => {
  if (error && typeof error === "object") {
    const code = typeof error.code === "number" ? error.code : -32000;
    const message = typeof error.message === "string" ? error.message : "Unknown error";
    return { ...error, code, message };
  }
  if (typeof error === "string") {
    return { code: -32000, message: error };
  }
  return { code: -32000, message: "Unknown error" };
};

const normalizeJsonRpcNotification = (payload) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  if (typeof payload.method !== "string") {
    return null;
  }
  const normalized = { ...payload, jsonrpc: payload.jsonrpc || "2.0" };
  if ("id" in normalized && (normalized.id === undefined || normalized.id === null)) {
    delete normalized.id;
  }
  return normalized;
};

const normalizeJsonRpcResponse = (response, id) => {
  if (response && typeof response === "object" && !Array.isArray(response)) {
    if ("result" in response || "error" in response) {
      const normalized = { ...response };
      normalized.jsonrpc = normalized.jsonrpc || "2.0";
      normalized.id = id;
      if ("error" in normalized) {
        normalized.error = normalizeJsonRpcError(normalized.error);
      }
      return normalized;
    }
    if (response.error && typeof response.error === "object") {
      return { jsonrpc: "2.0", id, error: normalizeJsonRpcError(response.error) };
    }
  }
  return { jsonrpc: "2.0", id, result: response ?? null };
};

const describeMessage = (payload) => {
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

const safeStringify = (payload, maxLength = 2_000) => {
  if (!ACP_REMOTE_LOG_PAYLOADS) {
    return "";
  }
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(payload, (key, value) => {
      if (typeof key === "string") {
        const lowered = key.toLowerCase();
        if (lowered.includes("token") || lowered.includes("authorization") || lowered.includes("api_key") || lowered.includes("apikey")) {
          return "[REDACTED]";
        }
      }
      if (typeof value === "string" && value.length > 500) {
        return `${value.slice(0, 500)}…(${value.length - 500} more chars)`;
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
    });
    if (json.length <= maxLength) {
      return json;
    }
    return `${json.slice(0, maxLength)}…(${json.length - maxLength} more chars)`;
  } catch (err) {
    return `<<unserializable:${err instanceof Error ? err.message : String(err)}>>`;
  }
};

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

const redactGitUrl = (value) => {
  if (!value || typeof value !== "string") {
    return value;
  }
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }
    return url.toString();
  } catch {
    // not a WHATWG URL (e.g. git@host:owner/repo)
  }
  return value.replace(/^(https?:\/\/)[^@]+@/i, "$1***@").replace(/^(ssh:\/\/)[^@]+@/i, "$1***@");
};

const summarizeMetaForLog = (meta) => {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return { type: Array.isArray(meta) ? "array" : typeof meta };
  }
  const summary = { keys: Object.keys(meta).sort() };
  const remote = meta.remote;
  if (remote && typeof remote === "object" && !Array.isArray(remote)) {
    summary.remote = {
      url: typeof remote.url === "string" ? redactGitUrl(remote.url) : undefined,
      branch: remote.branch,
      revision: remote.revision
    };
  }
  return summary;
};

const ensureRepoWorkdir = async (remote, runId, notify) => {
  const parsed = parseGitRemote(remote.url);
  if (!parsed) {
    throw new Error("Unsupported git remote URL");
  }

  const remoteUrlForLogs = redactGitUrl(remote.url);
  const segments = parsed.repoPath.split("/").filter(Boolean);
  const repoName = segments[segments.length - 1] || "repo";
  const owner = segments[0] || "owner";
  const preferredRepoDir = path.join(ACP_REMOTE_GIT_ROOT, repoName);
  const candidateRepoDirs = Array.from(new Set([
    preferredRepoDir,
    path.join(ACP_REMOTE_GIT_ROOT, parsed.host, ...segments),
    path.join(ACP_REMOTE_GIT_ROOT, ...segments),
    path.join(ACP_REMOTE_GIT_ROOT, owner, repoName),
    path.join(ACP_REMOTE_GIT_ROOT, `${owner}-${repoName}`),
    path.join(ACP_REMOTE_GIT_ROOT, parsed.host, repoName)
  ]));

  let repoDir = "";
  let repoDirReason = "";
  const candidateChecks = [];
  for (const candidate of candidateRepoDirs) {
    const hasGit = fs.existsSync(path.join(candidate, ".git"));
    if (!hasGit) {
      candidateChecks.push({ candidate, hasGit, match: false });
      continue;
    }
    try {
      const origin = await runGit(["-C", candidate, "remote", "get-url", "origin"]);
      if (isSameRepo(origin.stdout.trim(), remote.url)) {
        repoDir = candidate;
        repoDirReason = `matched existing repo origin (${candidate})`;
        candidateChecks.push({
          candidate,
          hasGit,
          origin: redactGitUrl(origin.stdout.trim()),
          match: true
        });
        break;
      }
      candidateChecks.push({
        candidate,
        hasGit,
        origin: redactGitUrl(origin.stdout.trim()),
        match: false
      });
    } catch {
      candidateChecks.push({ candidate, hasGit, match: false, error: "failed to read origin url" });
    }
  }

  if (!repoDir && fs.existsSync(ACP_REMOTE_GIT_ROOT)) {
    repoDirReason = "no match in candidates; scanning git root";
    const scanned = [];
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
            repoDirReason = `matched existing repo origin via git root scan (${candidate})`;
            scanned.push({ candidate, origin: redactGitUrl(origin.stdout.trim()), match: true });
            break;
          }
          scanned.push({ candidate, origin: redactGitUrl(origin.stdout.trim()), match: false });
        } catch {
          // ignore
        }
      }
      if (ACP_REMOTE_VERBOSE) {
        logDebug("Git root scan results.", { gitRoot: ACP_REMOTE_GIT_ROOT, scanned });
      }
    } catch {
      // ignore
    }
  }

  if (!repoDir) {
    const cloneTarget = candidateRepoDirs.find((candidate) => !fs.existsSync(candidate));
    if (!cloneTarget) {
      throw new Error(`No available directory under gitRoot to clone repo: ${remoteUrlForLogs}`);
    }
    repoDir = cloneTarget;
    repoDirReason = `cloning into ${cloneTarget}`;
  }

  const worktreesRoot = path.join(ACP_REMOTE_GIT_ROOT, ".acp-remote-worktrees", parsed.host, ...parsed.repoPath.split("/").filter(Boolean));
  const workdir = path.join(worktreesRoot, runId);
  const branchName = `agent/changes-${sanitizeBranchComponent(runId).slice(0, 24)}`;

  log("Git workdir selection.", {
    gitRoot: ACP_REMOTE_GIT_ROOT,
    gitRootSource: ACP_REMOTE_GIT_ROOT_SOURCE,
    gitRootSourceLabel: ACP_REMOTE_GIT_ROOT_SOURCE_LABEL,
    preferredRepoDir,
    repoDir,
    repoDirReason,
    worktreesRoot,
    host: parsed.host,
    owner,
    repoName,
    repoPath: parsed.repoPath,
    candidatesChecked: candidateChecks.length
  });
  if (ACP_REMOTE_VERBOSE) {
    logDebug("Git candidate selection details.", {
      remote: { host: parsed.host, repoPath: parsed.repoPath, url: remoteUrlForLogs },
      preferredRepoDir,
      candidates: candidateChecks
    });
  }
  notify("git/dir", "Resolved git directories", {
    gitRoot: ACP_REMOTE_GIT_ROOT,
    gitRootSource: ACP_REMOTE_GIT_ROOT_SOURCE,
    gitRootSourceLabel: ACP_REMOTE_GIT_ROOT_SOURCE_LABEL,
    repoName,
    repoDir,
    repoDirReason,
    worktreesRoot
  });

  const ref = remote.revision || (remote.branch ? `origin/${remote.branch}` : "");
  if (!ref) {
    throw new Error("Missing remote revision");
  }

  await withRepoLock(repoDir, async () => {
    ensureDir(path.dirname(repoDir));
    ensureDir(path.dirname(workdir));

    if (!fs.existsSync(repoDir)) {
      notify("git/clone", "Cloning repository", { url: remoteUrlForLogs, repoDir });
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
        notify("git/remote", "Updating origin remote URL", { from: redactGitUrl(actual), to: remoteUrlForLogs });
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

const attachTargetMeta = (response, target, contextLabel = "") => {
  if (!response || typeof response !== "object") {
    return response;
  }
  const result = response.result;
  if (!result || typeof result !== "object") {
    return response;
  }
  logDebug(`${contextLabel} attaching target to response result._meta.`, {
    url: redactGitUrl(target?.url),
    branch: target?.branch,
    revision: target?.revision
  });
  result._meta = { ...(result._meta || {}), target };
  return response;
};

const sendJson = (ws, payload) => {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
};

const sendJsonRpc = (ws, payload, contextLabel = "") => {
  if (Array.isArray(payload)) {
    logDebug(`${contextLabel} sending batch (${payload.length}).`);
    for (const item of payload) {
      sendJsonRpc(ws, item, contextLabel);
    }
    return;
  }
  if (!payload) {
    logWarn(`${contextLabel} attempted to send empty payload.`);
    return;
  }
  const shouldCoalesceSessionUpdate = (
    payload
    && typeof payload === "object"
    && !Array.isArray(payload)
    && payload.method === "session/update"
    && !("id" in payload)
  );
  if (shouldCoalesceSessionUpdate && sessionUpdateLogCoalescer.bump(contextLabel, "->")) {
    sendJson(ws, payload);
    return;
  }
  logDebug(`${contextLabel} ->`, describeMessage(payload), safeStringify(payload));
  sendJson(ws, payload);
};

const startAcpRemoteRunServer = () => {
  const expectedPath = normalizePath(ACP_REMOTE_PATH);
  const wss = new WebSocketServer({ noServer: true });
  log("Git root configured.", {
    gitRoot: ACP_REMOTE_GIT_ROOT,
    gitRootSource: ACP_REMOTE_GIT_ROOT_SOURCE,
    gitRootSourceLabel: ACP_REMOTE_GIT_ROOT_SOURCE_LABEL
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

  wss.on("connection", (ws, req) => {
    const connectionId = connectionCounter++;
    const connectionLabel = `conn:${connectionId}`;
    const url = getRequestUrl(req);
    const queryAgent = url.searchParams.get("agent") || "";
    const remoteAddress = req.socket.remoteAddress || "unknown";
    const remotePort = req.socket.remotePort;
    const remoteLabel = remotePort ? `${remoteAddress}:${remotePort}` : remoteAddress;
    let agentInfo;
    let runtime;
    try {
      agentInfo = resolveAcpAgentConfig(queryAgent);
      runtime = new ACPRuntime(agentInfo.config);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start ACP runtime";
      logError(`${connectionLabel} failed to configure ACP runtime.`, { remote: remoteLabel, agent: queryAgent || "default", error: message });
      sendJsonRpc(ws, buildJsonRpcError(null, message, -32000), connectionLabel);
      ws.close(1011, "ACP runtime error");
      return;
    }
    const sessionContexts = new Map();
    let hasAnySession = false;

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
      sendJsonRpc(ws, payload, connectionLabel);
    };

    log(`${connectionLabel} connected.`, { remote: remoteLabel, agent: agentInfo.name, path: url.pathname });
    notify("connection", "Connected", { agent: agentInfo.name });

    runtime.on("notification", (payload) => {
      const normalized = normalizeJsonRpcNotification(payload);
      if (!normalized) {
        logWarn(`${connectionLabel} skipping non-JSON-RPC notification.`, describeMessage(payload), safeStringify(payload));
        return;
      }
      sendJsonRpc(ws, normalized, connectionLabel);
    });

    runtime.on("log", (entry) => {
      if (
        entry?.direction === "notification"
        && entry?.payload
        && typeof entry.payload === "object"
        && !Array.isArray(entry.payload)
        && entry.payload.method === "session/update"
        && sessionUpdateLogCoalescer.bump(connectionLabel, "runtime")
      ) {
        return;
      }
      logDebug(`${connectionLabel} runtime log.`, entry?.direction, safeStringify(entry?.payload ?? entry));
    });

    ws.on("message", (data) => {
      void (async () => {
        const parsed = parseJson(data);
        if (!parsed.value) {
          logError(`${connectionLabel} invalid JSON payload.`, parsed.raw.slice(0, 200));
          sendJsonRpc(ws, buildJsonRpcError(null, "Invalid JSON"), connectionLabel);
          return;
        }

        const messages = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
        logDebug(`${connectionLabel} received ${messages.length} message(s).`);
        for (const message of messages) {
          const startedAt = Date.now();
          logDebug(`${connectionLabel} <-`, describeMessage(message), safeStringify(message));
          const hasMeta = Boolean(
            message?.params
            && typeof message.params === "object"
            && !Array.isArray(message.params)
            && "_meta" in message.params
          );
          if (hasMeta) {
            logDebug(`${connectionLabel} received params._meta.`, summarizeMetaForLog(message.params._meta));
          }
          if (!isJsonRpcRequest(message)) {
            sendJsonRpc(ws, buildJsonRpcError(message?.id ?? null, "Invalid JSON-RPC payload"), connectionLabel);
            continue;
          }

          const isNotification = message.id === undefined || message.id === null;
          if (isNotification) {
            logDebug(`${connectionLabel} processing notification.`, { method: message.method });
            if (!runtime.started) {
              logDebug(`${connectionLabel} starting ACP runtime for notification.`, {
                agent: agentInfo.name,
                cwd: runtime.spawnCwd || process.cwd()
              });
            }
            runtime.sendNotification(message);
            logDebug(`${connectionLabel} notification forwarded to runtime.`, { method: message.method, durationMs: Date.now() - startedAt });
            continue;
          }

          logDebug(`${connectionLabel} processing request.`, { method: message.method, id: message.id });
          if (hasMeta && message.method !== "session/new") {
            logDebug(`${connectionLabel} passing params._meta through unchanged.`, { method: message.method });
          }

          if (message.method === "session/new") {
            try {
              const params = message.params && typeof message.params === "object" ? message.params : {};
              const meta = params?._meta;
              const remote = meta?.remote;
              logDebug(`${connectionLabel} session/new extracting _meta.remote.`, {
                meta: summarizeMetaForLog(meta),
                hasRemote: Boolean(remote),
                url: redactGitUrl(remote?.url),
                branch: remote?.branch,
                revision: remote?.revision
              });
              if (!remote?.url || !remote?.revision) {
                notify("session/new", "Missing _meta.remote (delegating without git prep)", {});
                if (params.cwd) {
                  if (runtime.started) {
                    logWarn(`${connectionLabel} runtime started before session/new; restarting to apply cwd.`, {
                      previousCwd: runtime.spawnCwd || process.cwd(),
                      requestedCwd: params.cwd
                    });
                    runtime.stop();
                  }
                  const applied = runtime.setSpawnCwd(params.cwd);
                  log(`${connectionLabel} agent cwd selected.`, {
                    cwd: params.cwd,
                    gitRoot: ACP_REMOTE_GIT_ROOT,
                    gitRootSource: ACP_REMOTE_GIT_ROOT_SOURCE,
                    gitRootSourceLabel: ACP_REMOTE_GIT_ROOT_SOURCE_LABEL,
                    applied
                  });
                }
                logDebug(`${connectionLabel} session/new delegating request to runtime unchanged (no git prep).`, { id: message.id });
                if (!runtime.started) {
                  logDebug(`${connectionLabel} starting ACP runtime for session/new (delegated).`, {
                    agent: agentInfo.name,
                    cwd: runtime.spawnCwd || process.cwd()
                  });
                }
                const response = await runtime.sendRequest(message, ACP_REMOTE_REQUEST_TIMEOUT_MS);
                const formatted = normalizeJsonRpcResponse(response, message.id);
                sendJsonRpc(ws, formatted, connectionLabel);
                hasAnySession = true;
                logDebug(`${connectionLabel} session/new completed (delegated).`, { id: message.id, durationMs: Date.now() - startedAt });
                continue;
              }

              const runId = generateRunId();
              notify("session/new", "Preparing git workspace", { url: remote.url, branch: remote.branch, revision: remote.revision, runId });
              logDebug(`${connectionLabel} session/new starting git workspace prep.`, { runId, url: redactGitUrl(remote.url), revision: remote.revision });

              const context = await ensureRepoWorkdir(remote, runId, notify);
              logDebug(`${connectionLabel} session/new git workspace ready.`, { runId, workdir: context.workdir, repoDir: context.repoDir, branchName: context.branchName });
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
              if (runtime.started) {
                logWarn(`${connectionLabel} runtime started before session/new; restarting to apply git workdir.`, {
                  previousCwd: runtime.spawnCwd || process.cwd(),
                  requestedCwd: context.workdir
                });
                runtime.stop();
              }
              const applied = runtime.setSpawnCwd(context.workdir);
              log(`${connectionLabel} agent cwd selected.`, {
                cwd: context.workdir,
                gitRoot: ACP_REMOTE_GIT_ROOT,
                gitRootSource: ACP_REMOTE_GIT_ROOT_SOURCE,
                gitRootSourceLabel: ACP_REMOTE_GIT_ROOT_SOURCE_LABEL,
                applied
              });

              const agentParams = { ...params, cwd: context.workdir };
              const agentMessage = { ...message, params: agentParams };
              logDebug(`${connectionLabel} session/new forwarding request to runtime with updated cwd.`, {
                id: message.id,
                cwd: context.workdir,
                meta: summarizeMetaForLog(agentParams?._meta)
              });
              if (!runtime.started) {
                logDebug(`${connectionLabel} starting ACP runtime for session/new.`, {
                  agent: agentInfo.name,
                  cwd: runtime.spawnCwd || process.cwd()
                });
              }

              const response = await runtime.sendRequest(agentMessage, ACP_REMOTE_REQUEST_TIMEOUT_MS);
              const formatted = normalizeJsonRpcResponse(response, message.id);
              const sessionId = getSessionIdFromResult(formatted?.result);
              if (sessionId) {
                sessionContexts.set(sessionId, { ...context, runId, remote });
                notify("session/new", "Session created", { sessionId, cwd: context.workdir });
              } else {
                notify("session/new", "Session created (unknown sessionId)", { cwd: context.workdir });
              }
              sendJsonRpc(ws, initialTarget ? attachTargetMeta(formatted, initialTarget, connectionLabel) : formatted, connectionLabel);
              hasAnySession = true;
              logDebug(`${connectionLabel} session/new completed.`, { id: message.id, sessionId: sessionId || null, durationMs: Date.now() - startedAt });
            } catch (err) {
              const messageText = err instanceof Error ? err.message : "Remote session setup failed";
              logError(`${connectionLabel} session/new failed.`, messageText);
              notify("session/new", "Failed", { error: messageText });
              sendJsonRpc(ws, buildJsonRpcError(message.id, messageText, -32000), connectionLabel);
              logDebug(`${connectionLabel} session/new error returned.`, { id: message.id, durationMs: Date.now() - startedAt });
            }
            continue;
          }

          if (message.method === "session/prompt") {
            try {
              logDebug(`${connectionLabel} session/prompt forwarding request to runtime.`, { id: message.id });
              if (!runtime.started) {
                logDebug(`${connectionLabel} starting ACP runtime for session/prompt.`, {
                  agent: agentInfo.name,
                  cwd: runtime.spawnCwd || process.cwd()
                });
              }
              const response = await runtime.sendRequest(message, ACP_REMOTE_REQUEST_TIMEOUT_MS);
              const formatted = normalizeJsonRpcResponse(response, message.id);
              const sessionId = getSessionIdFromParams(message.params);
              if (!sessionId) {
                sendJsonRpc(ws, formatted, connectionLabel);
                logDebug(`${connectionLabel} session/prompt completed (no sessionId).`, { id: message.id, durationMs: Date.now() - startedAt });
                continue;
              }
              const context = sessionContexts.get(sessionId);
              if (!context) {
                sendJsonRpc(ws, formatted, connectionLabel);
                logDebug(`${connectionLabel} session/prompt completed (unknown session context).`, { id: message.id, sessionId, durationMs: Date.now() - startedAt });
                continue;
              }
              try {
                notify("git", "Committing and pushing changes", { sessionId });
                const target = await ensureCommittedAndPushed(context, notify);
                notify("git", "Target branch ready", { target });
                sendJsonRpc(ws, attachTargetMeta(formatted, target, connectionLabel), connectionLabel);
                logDebug(`${connectionLabel} session/prompt completed (pushed).`, { id: message.id, sessionId, durationMs: Date.now() - startedAt });
              } catch (pushErr) {
                const pushMessage = pushErr instanceof Error ? pushErr.message : "Failed to push changes";
                logError(`${connectionLabel} push failed.`, pushMessage);
                notify("git", "Push failed", { error: pushMessage });
                sendJsonRpc(ws, formatted, connectionLabel);
                logDebug(`${connectionLabel} session/prompt completed (push failed).`, { id: message.id, sessionId, durationMs: Date.now() - startedAt });
              }
            } catch (err) {
              const messageText = err instanceof Error ? err.message : "ACP runtime error";
              sendJsonRpc(ws, buildJsonRpcError(message.id, messageText, -32000), connectionLabel);
              logDebug(`${connectionLabel} session/prompt error returned.`, { id: message.id, durationMs: Date.now() - startedAt });
            }
            continue;
          }

          try {
            logDebug(`${connectionLabel} forwarding request to runtime.`, { method: message.method, id: message.id });
            if (!runtime.started) {
              logDebug(`${connectionLabel} starting ACP runtime for request.`, {
                agent: agentInfo.name,
                cwd: runtime.spawnCwd || process.cwd()
              });
            }
            const response = await runtime.sendRequest(message, ACP_REMOTE_REQUEST_TIMEOUT_MS);
            const formatted = normalizeJsonRpcResponse(response, message.id);
            sendJsonRpc(ws, formatted, connectionLabel);
            logDebug(`${connectionLabel} request completed.`, { method: message.method, id: message.id, durationMs: Date.now() - startedAt });
          } catch (err) {
            const messageText = err instanceof Error ? err.message : "ACP runtime error";
            sendJsonRpc(ws, buildJsonRpcError(message.id, messageText, -32000), connectionLabel);
            logDebug(`${connectionLabel} request error returned.`, { method: message.method, id: message.id, durationMs: Date.now() - startedAt });
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
      sessionUpdateLogCoalescer.flush(connectionLabel);
      cleanup();
    });

    ws.on("error", (err) => {
      logError(`${connectionLabel} socket error.`, err instanceof Error ? err.message : err);
      sessionUpdateLogCoalescer.flush(connectionLabel);
      cleanup();
    });

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
