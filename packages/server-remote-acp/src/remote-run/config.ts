import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as JSON5 from "json5";

const DEFAULT_PATH = "/acp";
// Slow models can legitimately take several minutes to respond.
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_PORT = 3011;
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60_000;

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

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
};

const parseFirstPositiveNumber = (values: unknown[], fallback: number) => {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
};

const parseBool = (value: unknown, defaultValue: boolean) => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const lowered = String(value).toLowerCase();
  return !["0", "false", "no"].includes(lowered);
};

export const ACP_CONFIG = process.env.ACP_CONFIG || path.join(os.homedir(), ".jetbrains", "acp.json");

const resolveRemoteConfigDir = () => {
  const resolvedAcpConfig = resolveHomeDir(ACP_CONFIG) || ACP_CONFIG;
  const dir = resolvedAcpConfig ? path.dirname(resolvedAcpConfig) : "";
  return dir || path.join(os.homedir(), ".jetbrains");
};

export const ACP_REMOTE_CONFIG = process.env.ACP_REMOTE_CONFIG || path.join(resolveRemoteConfigDir(), "acp-remote.json");
const ACP_REMOTE_CONFIG_BASENAME = path.basename(String(ACP_REMOTE_CONFIG || "acp-remote.json"));

export type AcpRemoteConfig = {
  // Server
  path?: string;
  token?: string;
  agent?: string;
  port?: number;
  bindHost?: string;
  advertiseHost?: string;
  advertiseProtocol?: string;

  // Git
  gitRoot?: string;
  // Map of "<git-url|host/owner/repo|owner/repo|repo>" -> "<root dir>"
  gitRootMap?: Record<string, string>;
  gitUserName?: string;
  gitUserEmail?: string;
  push?: boolean;

  // Timeouts
  requestTimeoutMs?: number;
  sessionIdleTtlMs?: number;

  // Logging/behavior
  verbose?: boolean;
  logPayloads?: boolean;
  logRpcPayloads?: boolean;
  logRpcNotificationPayloads?: boolean;
  coalesceSessionUpdates?: boolean;

  // Output constraints
  sessionUpdateLogFlushMs?: number;
  logMaxChars?: number;
  logMaxStringChars?: number;
  color?: boolean;
};

export const loadAcpRemoteConfig = (configPath: string = ACP_REMOTE_CONFIG): AcpRemoteConfig | null => {
  const resolved = resolveHomeDir(configPath) || configPath;
  if (!resolved || !fs.existsSync(resolved)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(resolved, "utf8");
    const parsed = JSON5.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const ACP_REMOTE_FILE_CONFIG = loadAcpRemoteConfig();
const remoteFileValue = <T = unknown>(key: keyof AcpRemoteConfig, legacyKey?: string): T | undefined => {
  if (!ACP_REMOTE_FILE_CONFIG) {
    return undefined;
  }
  const config: any = ACP_REMOTE_FILE_CONFIG;
  if (config[key] !== undefined) {
    return config[key] as T;
  }
  if (legacyKey && config[legacyKey] !== undefined) {
    return config[legacyKey] as T;
  }
  return undefined;
};
const remoteFileHasKey = (key: string): boolean => Boolean(ACP_REMOTE_FILE_CONFIG && (ACP_REMOTE_FILE_CONFIG as any)[key] !== undefined);
const remoteFileString = (key: keyof AcpRemoteConfig, legacyKey?: string): string => {
  const value = remoteFileValue<unknown>(key, legacyKey);
  return typeof value === "string" ? String(value).trim() : "";
};

export const ACP_REMOTE_PATH = process.env.ACP_REMOTE_PATH || remoteFileString("path", "ACP_REMOTE_PATH") || DEFAULT_PATH;
export const ACP_REMOTE_TOKEN = process.env.ACP_REMOTE_TOKEN || remoteFileString("token", "ACP_REMOTE_TOKEN") || "";
export const ACP_REMOTE_AGENT = process.env.ACP_REMOTE_AGENT || remoteFileString("agent", "ACP_REMOTE_AGENT") || "";

export const ACP_REMOTE_PORT = parseFirstPositiveNumber(
  [process.env.ACP_REMOTE_PORT, remoteFileValue("port", "ACP_REMOTE_PORT"), process.env.PORT],
  DEFAULT_PORT
);
export const ACP_REMOTE_BIND_HOST = process.env.ACP_REMOTE_BIND_HOST || remoteFileString("bindHost", "ACP_REMOTE_BIND_HOST") || "0.0.0.0";
export const ACP_REMOTE_ADVERTISE_HOST = process.env.ACP_REMOTE_ADVERTISE_HOST || remoteFileString("advertiseHost", "ACP_REMOTE_ADVERTISE_HOST") || (
  ACP_REMOTE_BIND_HOST && !["0.0.0.0", "::"].includes(ACP_REMOTE_BIND_HOST) ? ACP_REMOTE_BIND_HOST : "localhost"
);
export const ACP_REMOTE_ADVERTISE_PROTOCOL = process.env.ACP_REMOTE_ADVERTISE_PROTOCOL || remoteFileString("advertiseProtocol", "ACP_REMOTE_ADVERTISE_PROTOCOL") || "http";

const remoteGitRootFromFileValue = remoteFileValue("gitRoot", "ACP_REMOTE_GIT_ROOT");
const remoteGitRootFromFile = typeof remoteGitRootFromFileValue === "string" ? String(remoteGitRootFromFileValue).trim() : "";
export const ACP_REMOTE_GIT_ROOT_SOURCE = process.env.ACP_REMOTE_GIT_ROOT || remoteGitRootFromFile || "~/git";
export const ACP_REMOTE_GIT_ROOT_SOURCE_LABEL = process.env.ACP_REMOTE_GIT_ROOT
  ? "env:ACP_REMOTE_GIT_ROOT"
  : (remoteGitRootFromFile ? `file:${ACP_REMOTE_CONFIG_BASENAME}:${remoteFileHasKey("gitRoot") ? "gitRoot" : "ACP_REMOTE_GIT_ROOT"}` : "default");
export const ACP_REMOTE_GIT_ROOT = path.resolve(resolveHomeDir(ACP_REMOTE_GIT_ROOT_SOURCE));

const parseGitRootMap = (value: unknown): Record<string, string> => {
  if (!isPlainObject(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [rawKey, rawDir] of Object.entries(value)) {
    const key = String(rawKey || "").trim();
    if (!key) {
      continue;
    }
    if (typeof rawDir !== "string" || !rawDir.trim()) {
      continue;
    }
    result[key] = path.resolve(resolveHomeDir(rawDir.trim()));
  }
  return result;
};

const rawGitRootMap = remoteFileValue("gitRootMap", "ACP_REMOTE_GIT_ROOT_MAP");
export const ACP_REMOTE_GIT_ROOT_MAP_SOURCE_LABEL = rawGitRootMap
  ? `file:${ACP_REMOTE_CONFIG_BASENAME}:${remoteFileHasKey("gitRootMap") ? "gitRootMap" : "ACP_REMOTE_GIT_ROOT_MAP"}`
  : "none";
export const ACP_REMOTE_GIT_ROOT_MAP = parseGitRootMap(rawGitRootMap);

export const ACP_REMOTE_REQUEST_TIMEOUT_MS = parseFirstPositiveNumber(
  [process.env.ACP_REMOTE_REQUEST_TIMEOUT_MS, remoteFileValue("requestTimeoutMs", "ACP_REMOTE_REQUEST_TIMEOUT_MS")],
  DEFAULT_TIMEOUT_MS
);
export const ACP_REMOTE_SESSION_IDLE_TTL_MS = parseFirstPositiveNumber(
  [process.env.ACP_REMOTE_SESSION_IDLE_TTL_MS, remoteFileValue("sessionIdleTtlMs", "ACP_REMOTE_SESSION_IDLE_TTL_MS")],
  DEFAULT_SESSION_IDLE_TTL_MS
);

export const ACP_REMOTE_GIT_USER_NAME = process.env.ACP_REMOTE_GIT_USER_NAME || remoteFileString("gitUserName", "ACP_REMOTE_GIT_USER_NAME") || "ACP Remote";
export const ACP_REMOTE_GIT_USER_EMAIL = process.env.ACP_REMOTE_GIT_USER_EMAIL || remoteFileString("gitUserEmail", "ACP_REMOTE_GIT_USER_EMAIL") || "acp-remote@localhost";
export const ACP_REMOTE_PUSH = parseBool(process.env.ACP_REMOTE_PUSH ?? remoteFileValue("push", "ACP_REMOTE_PUSH") ?? "true", true);

export const ACP_REMOTE_VERBOSE = parseBool(process.env.ACP_REMOTE_VERBOSE ?? remoteFileValue("verbose", "ACP_REMOTE_VERBOSE") ?? "true", true);
export const ACP_REMOTE_LOG_PAYLOADS = parseBool(process.env.ACP_REMOTE_LOG_PAYLOADS ?? remoteFileValue("logPayloads", "ACP_REMOTE_LOG_PAYLOADS") ?? "false", false);
export const ACP_REMOTE_LOG_RPC_PAYLOADS = parseBool(process.env.ACP_REMOTE_LOG_RPC_PAYLOADS ?? remoteFileValue("logRpcPayloads", "ACP_REMOTE_LOG_RPC_PAYLOADS") ?? "true", true);
export const ACP_REMOTE_LOG_RPC_NOTIFICATION_PAYLOADS = parseBool(
  process.env.ACP_REMOTE_LOG_RPC_NOTIFICATION_PAYLOADS ?? remoteFileValue("logRpcNotificationPayloads", "ACP_REMOTE_LOG_RPC_NOTIFICATION_PAYLOADS") ?? "false",
  false
);
export const ACP_REMOTE_COALESCE_SESSION_UPDATES = parseBool(
  process.env.ACP_REMOTE_COALESCE_SESSION_UPDATES ?? remoteFileValue("coalesceSessionUpdates", "ACP_REMOTE_COALESCE_SESSION_UPDATES") ?? "true",
  true
);

export const ACP_REMOTE_SESSION_UPDATE_LOG_FLUSH_MS = parseFirstPositiveNumber(
  [process.env.ACP_REMOTE_SESSION_UPDATE_LOG_FLUSH_MS, remoteFileValue("sessionUpdateLogFlushMs", "ACP_REMOTE_SESSION_UPDATE_LOG_FLUSH_MS")],
  2_000
);
export const ACP_REMOTE_LOG_MAX_CHARS = parseFirstPositiveNumber(
  [process.env.ACP_REMOTE_LOG_MAX_CHARS, remoteFileValue("logMaxChars", "ACP_REMOTE_LOG_MAX_CHARS")],
  50_000
);
export const ACP_REMOTE_LOG_MAX_STRING_CHARS = parseFirstPositiveNumber(
  [process.env.ACP_REMOTE_LOG_MAX_STRING_CHARS, remoteFileValue("logMaxStringChars", "ACP_REMOTE_LOG_MAX_STRING_CHARS")],
  4_000
);

export const ACP_REMOTE_COLOR = parseBool(process.env.ACP_REMOTE_COLOR ?? remoteFileValue("color", "ACP_REMOTE_COLOR") ?? "true", true);
export const USE_COLOR = Boolean(ACP_REMOTE_COLOR && process.stdout.isTTY && !process.env.NO_COLOR);

export const loadAcpConfig = (configPath: string = ACP_CONFIG): any | null => {
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return JSON5.parse(raw);
  } catch {
    return null;
  }
};

export const getAcpAgents = (configPath: string = ACP_CONFIG): Array<{ name: string; command: string; args: string[] }> | null => {
  const config = loadAcpConfig(configPath);
  if (!config) {
    return null;
  }
  const servers = config.agent_servers || {};
  return Object.entries(servers).map(([name, value]: any) => ({
    name,
    command: value.command,
    args: value.args || []
  }));
};

export const resolveAcpAgentConfig = (agentName?: string, configPath: string = ACP_CONFIG): { name: string; config: any } => {
  const config = loadAcpConfig(configPath);
  if (!config) {
    throw new Error(`ACP config not found: ${configPath}`);
  }
  const servers = config.agent_servers || {};
  const entries = Object.entries(servers);
  if (!entries.length) {
    throw new Error("ACP config does not define any agent_servers");
  }

  const selectByName = (name: string) => {
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

  const [defaultName, defaultConfig]: any = entries[0];
  return { name: defaultName, config: defaultConfig };
};
