import * as fs from "fs";
import * as path from "path";
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
import { createAcpRemoteLogger, type LogLevel } from "../shared/logger";

export type { LogLevel };

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

const logger = createAcpRemoteLogger({
  prefix: "ACP-REMOTE-RUN",
  useColor: USE_COLOR,
  verbose: ACP_REMOTE_VERBOSE,
  logMaxChars: ACP_REMOTE_LOG_MAX_CHARS,
  logMaxStringChars: ACP_REMOTE_LOG_MAX_STRING_CHARS,
  logRpcPayloads: ACP_REMOTE_LOG_RPC_PAYLOADS,
  logRpcNotificationPayloads: ACP_REMOTE_LOG_RPC_NOTIFICATION_PAYLOADS,
  coalesceSessionUpdates: ACP_REMOTE_COALESCE_SESSION_UPDATES,
  sessionUpdateLogFlushMs: ACP_REMOTE_SESSION_UPDATE_LOG_FLUSH_MS,
  writeToFile: writeLogTextToFile
});

export const {
  log,
  logWarn,
  logError,
  logDebug,
  logRpc,
  redactForLog,
  safePrettyJsonForLog,
  describeRpcForLog,
  sessionUpdateLogCoalescer
} = logger;

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

