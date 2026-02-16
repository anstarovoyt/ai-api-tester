import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as JSON5 from "json5";
import type { RemoteGitInfo } from "./acp-client";

const resolveHomeDir = (value: unknown) => {
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

const parsePositiveNumber = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const parseUserIds = (value: unknown): number[] => {
  if (!value || typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => Number.isFinite(id) && id > 0);
};

// Telegram Bot Configuration
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const TELEGRAM_ALLOWED_USERS = parseUserIds(process.env.TELEGRAM_ALLOWED_USERS);

// ACP Remote Server Configuration
export const ACP_REMOTE_URL = process.env.ACP_REMOTE_URL || "ws://localhost:3011/acp";
export const ACP_REMOTE_HTTP_URL = process.env.ACP_REMOTE_HTTP_URL || "http://localhost:3011";
export const ACP_REMOTE_TOKEN = process.env.ACP_REMOTE_TOKEN || "";
export const ACP_DEFAULT_AGENT = process.env.ACP_DEFAULT_AGENT || "";

// Default git repo for ACP remote-run sessions (optional)
export const ACP_DEFAULT_REMOTE_URL = process.env.ACP_DEFAULT_REMOTE_URL || "";
export const ACP_DEFAULT_REMOTE_BRANCH = process.env.ACP_DEFAULT_REMOTE_BRANCH || "";
export const ACP_DEFAULT_REMOTE_REVISION = process.env.ACP_DEFAULT_REMOTE_REVISION || "";

// Timeouts
export const ACP_REQUEST_TIMEOUT_MS = parsePositiveNumber(process.env.ACP_REQUEST_TIMEOUT_MS, 600_000);
export const ACP_RECONNECT_INTERVAL_MS = parsePositiveNumber(process.env.ACP_RECONNECT_INTERVAL_MS, 5_000);
export const ACP_MAX_RECONNECT_ATTEMPTS = parsePositiveNumber(process.env.ACP_MAX_RECONNECT_ATTEMPTS, 10);

// Bot Configuration File (optional)
export const BOT_CONFIG_PATH = process.env.BOT_CONFIG_PATH || path.join(os.homedir(), ".jetbrains", "telegram-bot.json");

export type RepoConfigEntry = {
  name?: string;
  url?: string;
  branch?: string;
  revision?: string;
};

export type NormalizedRepoConfigEntry = {
  name: string;
  url: string;
  branch: string;
  revision: string;
};

export type BotConfig = {
  telegramToken?: string;
  allowedUsers?: number[];
  acpRemoteUrl?: string;
  acpRemoteHttpUrl?: string;
  acpRemoteToken?: string;
  defaultAgent?: string;
  // Back-compat: older configs used "defaultRemote".
  defaultRemote?: RepoConfigEntry;
  // New preferred format: list of repos. First entry becomes the default.
  repos?: RepoConfigEntry[];
  requestTimeoutMs?: number;
};

export const loadBotConfig = (configPath: string = BOT_CONFIG_PATH): BotConfig | null => {
  const resolved = resolveHomeDir(configPath);
  if (!resolved || !fs.existsSync(resolved)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(resolved, "utf8");
    return JSON5.parse(raw);
  } catch {
    return null;
  }
};

const deriveRepoNameFromUrl = (remoteUrl: string): string => {
  const trimmed = String(remoteUrl || "").trim();
  if (!trimmed) {
    return "";
  }
  // git@host:owner/repo(.git)
  const sshMatch = trimmed.match(/^[^@\s]+@[^:\s]+:(.+)$/);
  if (sshMatch) {
    const pathPart = sshMatch[1] || "";
    const segments = pathPart.split("/").filter(Boolean);
    const last = segments[segments.length - 1] || "";
    return last.replace(/\.git$/i, "");
  }
  // ssh://..., https://..., http://...
  if (trimmed.startsWith("ssh://") || trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    try {
      const url = new URL(trimmed);
      const segments = (url.pathname || "").split("/").filter(Boolean);
      const last = segments[segments.length - 1] || "";
      return last.replace(/\.git$/i, "");
    } catch {
      return "";
    }
  }
  return "";
};

const normalizeRepoConfigEntry = (value: unknown, fallbackName: string): NormalizedRepoConfigEntry | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const item = value as Record<string, unknown>;
  const url = typeof item.url === "string" ? item.url.trim() : "";
  if (!url) {
    return null;
  }

  const branch = typeof item.branch === "string" && item.branch.trim() ? item.branch.trim() : "main";
  const revision = typeof item.revision === "string" && item.revision.trim() ? item.revision.trim() : `origin/${branch}`;

  const derivedName = deriveRepoNameFromUrl(url);
  const name = typeof item.name === "string" && item.name.trim()
    ? item.name.trim()
    : (derivedName || fallbackName);

  return { name, url, branch, revision };
};

export const getEffectiveConfig = (): {
  telegramToken: string;
  allowedUsers: number[];
  acpRemoteUrl: string;
  acpRemoteHttpUrl: string;
  acpRemoteToken: string;
  defaultAgent: string;
  repos: NormalizedRepoConfigEntry[];
  defaultRemote?: RemoteGitInfo;
  requestTimeoutMs: number;
  reconnectIntervalMs: number;
  maxReconnectAttempts: number;
} => {
  const fileConfig = loadBotConfig();

  const repos: NormalizedRepoConfigEntry[] = [];

  const defaultRepoFromEnv = ACP_DEFAULT_REMOTE_URL ? normalizeRepoConfigEntry({
    name: "default",
    url: ACP_DEFAULT_REMOTE_URL,
    branch: ACP_DEFAULT_REMOTE_BRANCH || "main",
    revision: ACP_DEFAULT_REMOTE_REVISION || ""
  }, "default") : null;
  if (defaultRepoFromEnv) {
    repos.push(defaultRepoFromEnv);
  }

  const fileReposRaw: unknown = fileConfig?.repos;
  if (Array.isArray(fileReposRaw)) {
    let index = 1;
    for (const entry of fileReposRaw) {
      const normalized = normalizeRepoConfigEntry(entry, `repo-${index}`);
      index += 1;
      if (normalized) {
        repos.push(normalized);
      }
    }
  } else if (fileConfig?.defaultRemote) {
    // Back-compat: older configs only supported a single defaultRemote.
    const normalized = normalizeRepoConfigEntry({ name: "default", ...(fileConfig.defaultRemote as any) }, "default");
    if (normalized) {
      repos.push(normalized);
    }
  }

  const defaultRemote: RemoteGitInfo | undefined = repos.length > 0
    ? { url: repos[0].url, branch: repos[0].branch, revision: repos[0].revision }
    : undefined;

  return {
    telegramToken: TELEGRAM_BOT_TOKEN || fileConfig?.telegramToken || "",
    allowedUsers: TELEGRAM_ALLOWED_USERS.length > 0 
      ? TELEGRAM_ALLOWED_USERS 
      : (fileConfig?.allowedUsers || []),
    acpRemoteUrl: ACP_REMOTE_URL || fileConfig?.acpRemoteUrl || "ws://localhost:3011/acp",
    acpRemoteHttpUrl: ACP_REMOTE_HTTP_URL || fileConfig?.acpRemoteHttpUrl || "http://localhost:3011",
    acpRemoteToken: ACP_REMOTE_TOKEN || fileConfig?.acpRemoteToken || "",
    defaultAgent: ACP_DEFAULT_AGENT || fileConfig?.defaultAgent || "",
    repos,
    defaultRemote,
    requestTimeoutMs: fileConfig?.requestTimeoutMs || ACP_REQUEST_TIMEOUT_MS,
    reconnectIntervalMs: ACP_RECONNECT_INTERVAL_MS,
    maxReconnectAttempts: ACP_MAX_RECONNECT_ATTEMPTS,
  };
};

export const validateConfig = (config: ReturnType<typeof getEffectiveConfig>): string[] => {
  const errors: string[] = [];

  if (!config.telegramToken) {
    errors.push("TELEGRAM_BOT_TOKEN is required");
  }

  if (config.allowedUsers.length === 0) {
    errors.push("TELEGRAM_ALLOWED_USERS is required (comma-separated user IDs)");
  }

  if (!config.acpRemoteUrl) {
    errors.push("ACP_REMOTE_URL is required");
  }

  return errors;
};
