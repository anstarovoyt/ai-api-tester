import { spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  ACP_REMOTE_GIT_ROOT,
  ACP_REMOTE_GIT_ROOT_MAP,
  ACP_REMOTE_GIT_ROOT_MAP_SOURCE_LABEL,
  ACP_REMOTE_GIT_ROOT_SOURCE,
  ACP_REMOTE_GIT_ROOT_SOURCE_LABEL,
  ACP_REMOTE_GIT_USER_EMAIL,
  ACP_REMOTE_GIT_USER_NAME,
  ACP_REMOTE_PUSH,
  ACP_REMOTE_VERBOSE
} from "./config";
import { log, logDebug } from "./logger";

export type RemoteGitInfo = {
  url: string;
  branch?: string;
  revision: string;
};

export type GitWorkspaceContext = {
  repoDir: string;
  workdir: string;
  branchName: string;
  remoteUrl: string;
};

export type TargetGitInfo = {
  url: string;
  branch: string;
  revision: string;
};

export type ProgressNotify = (stage: string, message: string, extra?: any) => void;

export const generateRunId = () => {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
};

const ensureDir = (dirPath: string) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const sanitizeBranchComponent = (value: unknown) => String(value || "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

type ParsedGitRemote = { host: string; repoPath: string; normalizedUrl: string };

const parseGitRemote = (remoteUrl: unknown): ParsedGitRemote | null => {
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

const isSameRepo = (urlA: unknown, urlB: unknown) => {
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

export type GitRootResolution = {
  gitRoot: string;
  gitRootSource: string;
  gitRootSourceLabel: string;
  gitRootMapKey?: string;
  gitRootMapMatch?: "sameRepo" | "repoId" | "repoPath" | "repoName";
};

const normalizeRepoKey = (value: string): { repoId?: string; repoPath?: string; repoName?: string } => {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return {};
  }

  const parsed = parseGitRemote(trimmed);
  if (parsed) {
    const repoPath = parsed.repoPath.toLowerCase();
    const repoId = `${parsed.host}/${parsed.repoPath}`.toLowerCase();
    const segments = parsed.repoPath.split("/").filter(Boolean);
    const repoName = (segments[segments.length - 1] || "").toLowerCase();
    return { repoId, repoPath, repoName };
  }

  let cleaned = trimmed.replace(/^\/+/, "").replace(/\.git$/i, "");
  const hostPathMatch = cleaned.match(/^([^/\s]+):(.+)$/);
  if (hostPathMatch) {
    const host = hostPathMatch[1];
    const repoPath = String(hostPathMatch[2] || "").replace(/^\/+/, "");
    const segments = repoPath.split("/").filter(Boolean);
    const repoName = (segments[segments.length - 1] || "").toLowerCase();
    return { repoId: `${host}/${repoPath}`.toLowerCase(), repoPath: repoPath.toLowerCase(), repoName };
  }

  cleaned = cleaned.replace(/^\/+/, "");
  if (cleaned.includes("/")) {
    const segments = cleaned.split("/").filter(Boolean);
    const repoName = (segments[segments.length - 1] || "").toLowerCase();
    // Heuristic: hostnames usually include a dot.
    if (segments.length >= 3 && segments[0].includes(".")) {
      const host = segments[0];
      const repoPath = segments.slice(1).join("/");
      return { repoId: `${host}/${repoPath}`.toLowerCase(), repoPath: repoPath.toLowerCase(), repoName };
    }
    return { repoPath: cleaned.toLowerCase(), repoName };
  }

  return { repoName: cleaned.toLowerCase() };
};

export const resolveGitRootForRemoteUrl = (
  remoteUrl: unknown,
  options: {
    defaultRoot: { gitRoot: string; gitRootSource: string; gitRootSourceLabel: string };
    gitRootMap: Record<string, string>;
    gitRootMapSourceLabel: string;
  }
): GitRootResolution => {
  const parsedRemote = parseGitRemote(remoteUrl);
  if (!parsedRemote) {
    return { ...options.defaultRoot };
  }

  const remoteRepoPath = parsedRemote.repoPath.toLowerCase();
  const remoteRepoId = `${parsedRemote.host}/${parsedRemote.repoPath}`.toLowerCase();
  const remoteSegments = parsedRemote.repoPath.split("/").filter(Boolean);
  const remoteRepoName = (remoteSegments[remoteSegments.length - 1] || "").toLowerCase();

  let best: { key: string; root: string; score: number; match: GitRootResolution["gitRootMapMatch"] } | null = null;
  for (const [key, root] of Object.entries(options.gitRootMap || {})) {
    const trimmedKey = String(key || "").trim();
    if (!trimmedKey || !root) {
      continue;
    }

    if (isSameRepo(trimmedKey, remoteUrl)) {
      best = { key: trimmedKey, root, score: 4, match: "sameRepo" };
      break;
    }

    const normalized = normalizeRepoKey(trimmedKey);
    if (normalized.repoId && normalized.repoId === remoteRepoId) {
      const next = { key: trimmedKey, root, score: 3, match: "repoId" as const };
      if (!best || next.score > best.score) {
        best = next;
      }
      continue;
    }
    if (normalized.repoPath && normalized.repoPath === remoteRepoPath) {
      const next = { key: trimmedKey, root, score: 2, match: "repoPath" as const };
      if (!best || next.score > best.score) {
        best = next;
      }
      continue;
    }
    if (normalized.repoName && normalized.repoName === remoteRepoName) {
      const next = { key: trimmedKey, root, score: 1, match: "repoName" as const };
      if (!best || next.score > best.score) {
        best = next;
      }
    }
  }

  if (!best) {
    return { ...options.defaultRoot };
  }

  return {
    gitRoot: best.root,
    gitRootSource: best.root,
    gitRootSourceLabel: options.gitRootMapSourceLabel,
    gitRootMapKey: best.key,
    gitRootMapMatch: best.match
  };
};

const repoLocks = new Map<string, Promise<unknown>>();

const withRepoLock = async <T>(key: string, fn: () => Promise<T>) => {
  const tail = repoLocks.get(key) || Promise.resolve();
  const next = tail.then(fn, fn);
  repoLocks.set(key, next.catch(() => {}));
  return await next;
};

const runCommand = (command: string, args: string[], options: any = {}) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
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

const runGit = (args: string[], options: any = {}) => runCommand("git", args, options);

export const redactGitUrl = (value: unknown) => {
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

export const summarizeMetaForLog = (meta: any) => {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return { type: Array.isArray(meta) ? "array" : typeof meta };
  }
  const summary: any = { keys: Object.keys(meta).sort() };
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

export const ensureRepoWorkdir = async (remote: RemoteGitInfo, runId: string, notify: ProgressNotify): Promise<GitWorkspaceContext> => {
  const parsed = parseGitRemote(remote.url);
  if (!parsed) {
    throw new Error("Unsupported git remote URL");
  }

  const remoteUrlForLogs = String(redactGitUrl(remote.url));
  const gitRootResolution = resolveGitRootForRemoteUrl(remote.url, {
    defaultRoot: {
      gitRoot: ACP_REMOTE_GIT_ROOT,
      gitRootSource: ACP_REMOTE_GIT_ROOT_SOURCE,
      gitRootSourceLabel: ACP_REMOTE_GIT_ROOT_SOURCE_LABEL
    },
    gitRootMap: ACP_REMOTE_GIT_ROOT_MAP,
    gitRootMapSourceLabel: ACP_REMOTE_GIT_ROOT_MAP_SOURCE_LABEL
  });
  const gitRoot = gitRootResolution.gitRoot;

  const segments = parsed.repoPath.split("/").filter(Boolean);
  const repoName = segments[segments.length - 1] || "repo";
  const owner = segments[0] || "owner";
  const preferredRepoDir = path.join(gitRoot, repoName);
  const candidateRepoDirs = Array.from(new Set([
    preferredRepoDir,
    path.join(gitRoot, parsed.host, ...segments),
    path.join(gitRoot, ...segments),
    path.join(gitRoot, owner, repoName),
    path.join(gitRoot, `${owner}-${repoName}`),
    path.join(gitRoot, parsed.host, repoName)
  ]));

  let repoDir = "";
  let repoDirReason = "";
  const candidateChecks: any[] = [];
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

  if (!repoDir && fs.existsSync(gitRoot)) {
    repoDirReason = "no match in candidates; scanning git root";
    const scanned: any[] = [];
    try {
      const dirents = fs.readdirSync(gitRoot, { withFileTypes: true });
      for (const dirent of dirents) {
        if (!dirent.isDirectory()) {
          continue;
        }
        const candidate = path.join(gitRoot, dirent.name);
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
        logDebug("Git root scan results.", { gitRoot, scanned });
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

  const worktreesRoot = path.join(gitRoot, ".acp-remote-worktrees", repoName);
  const workdir = path.join(worktreesRoot, runId);
  const branchName = `agent/changes-${sanitizeBranchComponent(runId).slice(0, 24)}`;

  log("Git workdir selection.", {
    gitRoot,
    gitRootSource: gitRootResolution.gitRootSource,
    gitRootSourceLabel: gitRootResolution.gitRootSourceLabel,
    gitRootMapKey: gitRootResolution.gitRootMapKey ? redactGitUrl(gitRootResolution.gitRootMapKey) : undefined,
    gitRootMapMatch: gitRootResolution.gitRootMapMatch,
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
    gitRoot,
    gitRootSource: gitRootResolution.gitRootSource,
    gitRootSourceLabel: gitRootResolution.gitRootSourceLabel,
    gitRootMapKey: gitRootResolution.gitRootMapKey ? redactGitUrl(gitRootResolution.gitRootMapKey) : undefined,
    gitRootMapMatch: gitRootResolution.gitRootMapMatch,
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

export const ensureCommittedAndPushed = async (context: GitWorkspaceContext, notify: ProgressNotify): Promise<TargetGitInfo> => {
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
    branch: context.branchName,
    revision
  };
};

export const cleanupWorkspace = async (context: GitWorkspaceContext) => {
  await withRepoLock(context.repoDir, async () => {
    try {
      await runGit(["-C", context.repoDir, "worktree", "remove", "--force", context.workdir]);
    } catch {
      // ignore
    }
    try {
      fs.rmSync(context.workdir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
};
