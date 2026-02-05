import * as util from "util";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

export type SessionUpdateLogCoalescer = {
  bump: (contextLabel: string, direction: string) => boolean;
  flush: (filterContextLabel?: string) => void;
};

export type CreateAcpRemoteLoggerOptions = {
  prefix: string;
  useColor: boolean;
  verbose: boolean;
  logMaxChars: number;
  logMaxStringChars: number;
  logRpcPayloads: boolean;
  logRpcNotificationPayloads: boolean;
  coalesceSessionUpdates: boolean;
  sessionUpdateLogFlushMs: number;
  writeToFile?: (text: string) => void;
};

export type AcpRemoteLogger = {
  log: (...args: unknown[]) => void;
  logWarn: (...args: unknown[]) => void;
  logError: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  logRpc: (args: { level: LogLevel; contextLabel?: string; direction: string; payload: any; methodHint?: string }) => void;
  redactForLog: (payload: unknown) => unknown;
  safePrettyJsonForLog: (payload: unknown) => string;
  describeRpcForLog: (payload: any) => { type: string; method?: string; id?: any };
  sessionUpdateLogCoalescer: SessionUpdateLogCoalescer;
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

export const createAcpRemoteLogger = (options: CreateAcpRemoteLoggerOptions): AcpRemoteLogger => {
  const color = (code: string, text: unknown) => (options.useColor ? `${code}${text}${ansi.reset}` : String(text));
  const dim = (text: unknown) => color(ansi.dim, text);
  const bold = (text: unknown) => color(ansi.bold, text);

  const inspectForLog = (value: unknown, inspectOptions: any = {}) => {
    if (typeof value === "string") {
      return value;
    }
    return util.inspect(value, {
      depth: inspectOptions.depth ?? 6,
      colors: Boolean(inspectOptions.colors),
      breakLength: 120,
      maxArrayLength: 50,
      maxStringLength: options.logMaxStringChars
    });
  };

  const prefixLines = (prefix: string, text: unknown) => {
    const raw = String(text ?? "");
    const lines = raw.split(/\r?\n/);
    return lines.map((line) => `${prefix} ${line}`).join("\n");
  };

  const formatPrefix = (level: LogLevel, timestamp: string, { colors }: { colors: boolean }) => {
    const base = `[${options.prefix} ${timestamp}]`;
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
    const messageConsole = args.map((arg) => inspectForLog(arg, { colors: options.useColor })).join(" ");

    if (options.writeToFile) {
      const outFile = prefixLines(prefixPlain, messagePlain);
      options.writeToFile(outFile);
    }

    const outConsole = prefixLines(prefixConsole, messageConsole);
    if (level === "ERROR") {
      console.error(outConsole);
    } else if (level === "WARN") {
      console.warn(outConsole);
    } else {
      console.log(outConsole);
    }
  };

  const log = (...args: unknown[]) => logWithLevel("INFO", ...args);
  const logWarn = (...args: unknown[]) => logWithLevel("WARN", ...args);
  const logError = (...args: unknown[]) => logWithLevel("ERROR", ...args);
  const logDebug = (...args: unknown[]) => {
    if (!options.verbose) {
      return;
    }
    logWithLevel("DEBUG", ...args);
  };

  const redactForLog = (payload: unknown) => {
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
      if (typeof value === "string" && value.length > options.logMaxStringChars) {
        return `${value.slice(0, options.logMaxStringChars)}…(${value.length - options.logMaxStringChars} more chars)`;
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

  const safePrettyJsonForLog = (payload: unknown) => {
    try {
      const json = JSON.stringify(redactForLog(payload), null, 2);
      if (json.length <= options.logMaxChars) {
        return json;
      }
      return `${json.slice(0, options.logMaxChars)}\n…(${json.length - options.logMaxChars} more chars)`;
    } catch (err) {
      return `<<unserializable:${err instanceof Error ? err.message : String(err)}>>`;
    }
  };

  const describeRpcForLog = (payload: any) => {
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

  const sessionUpdateLogCoalescer: SessionUpdateLogCoalescer = (() => {
    const pending = new Map<string, { contextLabel: string; direction: string; count: number }>();
    let timer: NodeJS.Timeout | null = null;

    const canCoalesce = () => options.verbose && options.coalesceSessionUpdates;

    const scheduleFlush = () => {
      if (timer || !canCoalesce()) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, options.sessionUpdateLogFlushMs);
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

  const logRpc = ({ level, contextLabel = "", direction, payload, methodHint = "" }: any) => {
    if (level === "DEBUG" && !options.verbose) {
      return;
    }
    if (isSessionUpdateNotification(payload) && sessionUpdateLogCoalescer.bump(contextLabel, direction)) {
      return;
    }
    const header = formatRpcHeader({ contextLabel, direction, payload, methodHint });
    const lines = [header];
    const desc = describeRpcForLog(payload);
    const shouldIncludePayload = options.logRpcPayloads && (
      desc.type === "request"
      || desc.type === "response"
      || (options.logRpcNotificationPayloads && desc.type === "notification")
    );
    if (shouldIncludePayload && !isSessionUpdateNotification(payload)) {
      const body = safePrettyJsonForLog(payload);
      for (const line of body.split(/\r?\n/)) {
        lines.push(dim(`  ${line}`));
      }
    }
    logWithLevel(level, lines.join("\n"));
  };

  return {
    log,
    logWarn,
    logError,
    logDebug,
    logRpc,
    redactForLog,
    safePrettyJsonForLog,
    describeRpcForLog,
    sessionUpdateLogCoalescer
  };
};

