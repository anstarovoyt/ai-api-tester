import * as readline from "readline";

const KEYS = [
  "ACP_TEST_STRING",
  "ACP_TEST_NUMBER",
  "ACP_TEST_BOOL",
  "ACP_TEST_OBJECT",
  "ACP_TEST_ARRAY",
  "ACP_TEST_REMOVE"
] as const;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line: string) => {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return;
  }

  let message: any;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (!message || typeof message !== "object") {
    return;
  }
  if (message.id === undefined || message.id === null) {
    return;
  }

  const env: Record<string, string | undefined> = {};
  const has: Record<string, boolean> = {};
  for (const key of KEYS) {
    env[key] = process.env[key];
    has[key] = Object.prototype.hasOwnProperty.call(process.env, key);
  }

  const response = {
    jsonrpc: message.jsonrpc || "2.0",
    id: message.id,
    result: { env, has }
  };

  process.stdout.write(`${JSON.stringify(response)}\n`);
});
