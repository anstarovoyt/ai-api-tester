import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as JSON5 from "json5";

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

// Timeouts
export const ACP_REQUEST_TIMEOUT_MS = parsePositiveNumber(process.env.ACP_REQUEST_TIMEOUT_MS, 600_000);
export const ACP_RECONNECT_INTERVAL_MS = parsePositiveNumber(process.env.ACP_RECONNECT_INTERVAL_MS, 5_000);
export const ACP_MAX_RECONNECT_ATTEMPTS = parsePositiveNumber(process.env.ACP_MAX_RECONNECT_ATTEMPTS, 10);

// Bot Configuration File (optional)
export const BOT_CONFIG_PATH = process.env.BOT_CONFIG_PATH || path.join(os.homedir(), ".jetbrains", "telegram-bot.json");

export type BotConfig = {
  telegramToken?: string;
  allowedUsers?: number[];
  acpRemoteUrl?: string;
  acpRemoteHttpUrl?: string;
  acpRemoteToken?: string;
  defaultAgent?: string;
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

export const getEffectiveConfig = (): {
  telegramToken: string;
  allowedUsers: number[];
  acpRemoteUrl: string;
  acpRemoteHttpUrl: string;
  acpRemoteToken: string;
  defaultAgent: string;
  requestTimeoutMs: number;
  reconnectIntervalMs: number;
  maxReconnectAttempts: number;
} => {
  const fileConfig = loadBotConfig();

  return {
    telegramToken: TELEGRAM_BOT_TOKEN || fileConfig?.telegramToken || "",
    allowedUsers: TELEGRAM_ALLOWED_USERS.length > 0 
      ? TELEGRAM_ALLOWED_USERS 
      : (fileConfig?.allowedUsers || []),
    acpRemoteUrl: ACP_REMOTE_URL || fileConfig?.acpRemoteUrl || "ws://localhost:3011/acp",
    acpRemoteHttpUrl: ACP_REMOTE_HTTP_URL || fileConfig?.acpRemoteHttpUrl || "http://localhost:3011",
    acpRemoteToken: ACP_REMOTE_TOKEN || fileConfig?.acpRemoteToken || "",
    defaultAgent: ACP_DEFAULT_AGENT || fileConfig?.defaultAgent || "",
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
