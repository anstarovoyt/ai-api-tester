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

const parsePositiveNumber = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseBool = (value: unknown, defaultValue: boolean) => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const lowered = String(value).toLowerCase();
  return !["0", "false", "no"].includes(lowered);
};

export const ACP_CONFIG = process.env.ACP_CONFIG || path.join(os.homedir(), ".jetbrains", "acp.json");

export const ACP_REMOTE_PATH = process.env.ACP_REMOTE_PATH || DEFAULT_PATH;
export const ACP_REMOTE_TOKEN = process.env.ACP_REMOTE_TOKEN || "";
export const ACP_REMOTE_AGENT = process.env.ACP_REMOTE_AGENT || "";

export const ACP_REMOTE_PORT = Number(process.env.ACP_REMOTE_PORT || process.env.PORT || DEFAULT_PORT);
export const ACP_REMOTE_BIND_HOST = process.env.ACP_REMOTE_BIND_HOST || "0.0.0.0";
export const ACP_REMOTE_ADVERTISE_HOST = process.env.ACP_REMOTE_ADVERTISE_HOST || (
  ACP_REMOTE_BIND_HOST && !["0.0.0.0", "::"].includes(ACP_REMOTE_BIND_HOST) ? ACP_REMOTE_BIND_HOST : "localhost"
);
export const ACP_REMOTE_ADVERTISE_PROTOCOL = process.env.ACP_REMOTE_ADVERTISE_PROTOCOL || "http";

export const ACP_REMOTE_GIT_ROOT_SOURCE = process.env.ACP_REMOTE_GIT_ROOT || "~/git";
export const ACP_REMOTE_GIT_ROOT_SOURCE_LABEL = process.env.ACP_REMOTE_GIT_ROOT ? "env:ACP_REMOTE_GIT_ROOT" : "default";
export const ACP_REMOTE_GIT_ROOT = path.resolve(resolveHomeDir(ACP_REMOTE_GIT_ROOT_SOURCE));

export const ACP_REMOTE_REQUEST_TIMEOUT_MS = parsePositiveNumber(process.env.ACP_REMOTE_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
export const ACP_REMOTE_SESSION_IDLE_TTL_MS = parsePositiveNumber(process.env.ACP_REMOTE_SESSION_IDLE_TTL_MS, DEFAULT_SESSION_IDLE_TTL_MS);

export const ACP_REMOTE_GIT_USER_NAME = process.env.ACP_REMOTE_GIT_USER_NAME || "ACP Remote";
export const ACP_REMOTE_GIT_USER_EMAIL = process.env.ACP_REMOTE_GIT_USER_EMAIL || "acp-remote@localhost";
export const ACP_REMOTE_PUSH = parseBool(process.env.ACP_REMOTE_PUSH ?? "true", true);

export const ACP_REMOTE_VERBOSE = parseBool(process.env.ACP_REMOTE_VERBOSE ?? "true", true);
export const ACP_REMOTE_LOG_PAYLOADS = parseBool(process.env.ACP_REMOTE_LOG_PAYLOADS ?? "false", false);
export const ACP_REMOTE_LOG_RPC_PAYLOADS = parseBool(process.env.ACP_REMOTE_LOG_RPC_PAYLOADS ?? "true", true);
export const ACP_REMOTE_LOG_RPC_NOTIFICATION_PAYLOADS = parseBool(process.env.ACP_REMOTE_LOG_RPC_NOTIFICATION_PAYLOADS ?? "false", false);
export const ACP_REMOTE_COALESCE_SESSION_UPDATES = parseBool(process.env.ACP_REMOTE_COALESCE_SESSION_UPDATES ?? "true", true);

export const ACP_REMOTE_SESSION_UPDATE_LOG_FLUSH_MS = Number(process.env.ACP_REMOTE_SESSION_UPDATE_LOG_FLUSH_MS || 2_000);
export const ACP_REMOTE_LOG_MAX_CHARS = Number(process.env.ACP_REMOTE_LOG_MAX_CHARS || 50_000);
export const ACP_REMOTE_LOG_MAX_STRING_CHARS = Number(process.env.ACP_REMOTE_LOG_MAX_STRING_CHARS || 4_000);

export const ACP_REMOTE_COLOR = parseBool(process.env.ACP_REMOTE_COLOR ?? "true", true);
export const USE_COLOR = Boolean(ACP_REMOTE_COLOR && process.stdout.isTTY && !process.env.NO_COLOR);

export const loadAcpConfig = (): any | null => {
  if (!fs.existsSync(ACP_CONFIG)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(ACP_CONFIG, "utf8");
    return JSON5.parse(raw);
  } catch {
    return null;
  }
};

export const getAcpAgents = (): Array<{ name: string; command: string; args: string[] }> | null => {
  const config = loadAcpConfig();
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

export const resolveAcpAgentConfig = (agentName?: string): { name: string; config: any } => {
  const config = loadAcpConfig();
  if (!config) {
    throw new Error(`ACP config not found: ${ACP_CONFIG}`);
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
