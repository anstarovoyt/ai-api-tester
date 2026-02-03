import * as fs from "fs";
import * as path from "path";
import * as util from "util";
import {
  ACP_REMOTE_COALESCE_SESSION_UPDATES,
  ACP_REMOTE_LOG_MAX_CHARS,
  ACP_REMOTE_LOG_MAX_STRING_CHARS,
  ACP_REMOTE_LOG_RPC_NOTIFICATION_PAYLOADS,
  ACP_REMOTE_LOG_RPC_PAYLOADS,
  ACP_REMOTE_SESSION_UPDATE_LOG_FLUSH_MS,
  ACP_REMOTE_VERBOSE,
  USE_COLOR
} from "./config";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

const START_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_DIR = path.join(process.cwd(), ".log");
const LOG_FILE_PATH = path.join(LOG_DIR, `${START_TIMESTAMP}-acp-remote.log`);
let logFileStream: fs.WriteStream | null = null;

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  logFileStream = fs.createWriteStream(LOG_FILE_PATH, { flags: "a" });
  logFileStream.on("error", () => {
    logFileStream = null;
  });
} catch {
  logFileStream = null;
}

const stripAnsi = (value: unknown) => String(value || "").replace(/\x1b\[[0-9;]*m/g, "");

const writeLogTextToFile = (text: string) => {
  if (!logFileStream) {
    return;
  }
  try {
    const cleaned = stripAnsi(text);
    const lines = cleaned.split(/\r?\n/);
    for (const line of lines) {
      logFileStream.write(`${line}\n`);
    }
  } catch {
    // ignore file logging failures
  }
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

const color = (code: string, text: unknown) => (USE_COLOR ? `${code}${text}${ansi.reset}` : String(text));
const dim = (text: unknown) => color(ansi.dim, text);
const bold = (text: unknown) => color(ansi.bold, text);

const inspectForLog = (value: unknown, options: any = {}) => {
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

const prefixLines = (prefix: string, text: unknown) => {
  const raw = String(text ?? "");
  const lines = raw.split(/\r?\n/);
  return lines.map((line) => `${prefix} ${line}`).join("\n");
};

const formatPrefix = (level: LogLevel, timestamp: string, { colors }: { colors: boolean }) => {
  const base = `[ACP-REMOTE-RUN ${timestamp}]`;
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

const logWithLevel = (level: LogLevel, ...args: unknown[]) => {
  const timestamp = new Date().toISOString();
  const prefixPlain = formatPrefix(level, timestamp, { colors: false });
  const prefixConsole = formatPrefix(level, timestamp, { colors: true });
  const messagePlain = args.map((arg) => inspectForLog(arg, { colors: false })).join(" ");
  const messageConsole = args.map((arg) => inspectForLog(arg, { colors: USE_COLOR })).join(" ");

  const outFile = prefixLines(prefixPlain, messagePlain);
  const outConsole = prefixLines(prefixConsole, messageConsole);
  writeLogTextToFile(outFile);

  if (level === "ERROR") {
    console.error(outConsole);
  } else if (level === "WARN") {
    console.warn(outConsole);
  } else {
    console.log(outConsole);
  }
};

export const log = (...args: unknown[]) => logWithLevel("INFO", ...args);
export const logWarn = (...args: unknown[]) => logWithLevel("WARN", ...args);
export const logError = (...args: unknown[]) => logWithLevel("ERROR", ...args);
export const logDebug = (...args: unknown[]) => {
  if (!ACP_REMOTE_VERBOSE) {
    return;
  }
  logWithLevel("DEBUG", ...args);
};

export const redactForLog = (payload: unknown) => {
  const seen = new WeakSet();
  const redact = (key: unknown, value: any) => {
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

export const safePrettyJsonForLog = (payload: unknown) => {
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

export const describeRpcForLog = (payload: any) => {
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

const isSessionUpdateNotification = (payload: any) => (
  payload
  && typeof payload === "object"
  && !Array.isArray(payload)
  && payload.method === "session/update"
  && (payload.id === undefined || payload.id === null)
);

export const sessionUpdateLogCoalescer = (() => {
  const pending = new Map<string, { contextLabel: string; direction: string; count: number }>();
  let timer: NodeJS.Timeout | null = null;

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

  const bump = (contextLabel: string, direction: string) => {
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

  const flush = (filterContextLabel?: string) => {
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

const formatRpcHeader = ({ contextLabel = "", direction, payload, methodHint }: any) => {
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

export const logRpc = ({ level, contextLabel, direction, payload, methodHint = "" }: any) => {
  if (level === "DEBUG" && !ACP_REMOTE_VERBOSE) {
    return;
  }
  const header = formatRpcHeader({ contextLabel, direction, payload, methodHint });
  if (isSessionUpdateNotification(payload) && sessionUpdateLogCoalescer.bump(contextLabel, direction)) {
    return;
  }
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
  logWithLevel(level, lines.join("\n"));
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

