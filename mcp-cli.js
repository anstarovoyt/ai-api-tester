const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  bold: "\x1b[1m"
};

const colorize = (color, text) => `${colors[color] || ""}${text}${colors.reset}`;
const formatBanner = (label) => colorize("bold", colorize("cyan", label));

const args = process.argv.slice(2);
const configFlagIndex = args.findIndex((arg) => arg === "--config" || arg === "-c");
const configPath = configFlagIndex >= 0 && args[configFlagIndex + 1]
  ? args[configFlagIndex + 1]
  : "mcp-stdio.json";

const resolvedConfigPath = path.isAbsolute(configPath)
  ? configPath
  : path.join(process.cwd(), configPath);

if (!fs.existsSync(resolvedConfigPath)) {
  console.error(colorize("red", `Config not found: ${resolvedConfigPath}`));
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(resolvedConfigPath, "utf8"));
} catch (err) {
  console.error(colorize("red", `Failed to parse config JSON: ${err instanceof Error ? err.message : err}`));
  process.exit(1);
}

if (!config || config.type !== "stdio" || !config.command) {
  console.error(colorize("red", "Invalid config. Expected { type: 'stdio', command: string, args?: string[], env?: object }"));
  process.exit(1);
}

const child = spawn(config.command, config.args || [], {
  env: { ...process.env, ...(config.env || {}) },
  stdio: ["pipe", "pipe", "pipe"]
});

child.on("exit", (code) => {
  console.log(colorize("yellow", `\nMCP process exited with code ${code ?? "unknown"}`));
  process.exit(code ?? 0);
});

child.on("error", (err) => {
  console.error(colorize("red", `Failed to start MCP process: ${err instanceof Error ? err.message : err}`));
});

let stdoutBuffer = "";
let lastMessageKey = null;
let lastMessageCount = 0;
let lastMessageInputCounter = 0;
let lastRepeatPrintedAt = 0;
let userInputCounter = 0;

const handleLine = (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  const now = Date.now();
  if (trimmed === lastMessageKey && lastMessageInputCounter === userInputCounter) {
    lastMessageCount += 1;
    if (lastMessageCount === 2 || now - lastRepeatPrintedAt > 2000) {
      console.log(colorize("dim", `-> repeated x${lastMessageCount}`));
      lastRepeatPrintedAt = now;
    }
    rl.prompt();
    return;
  }

  lastMessageKey = trimmed;
  lastMessageCount = 1;
  lastMessageInputCounter = userInputCounter;
  lastRepeatPrintedAt = 0;

  try {
    const parsed = JSON.parse(trimmed);
    console.log(`\n${formatBanner("< RESPONSE")}\n${colorize("green", JSON.stringify(parsed, null, 2))}`);
  } catch {
    console.log(`\n${formatBanner("< RESPONSE")}\n${colorize("green", trimmed)}`);
  }
  rl.prompt();
};

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  let index;
  while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
    const line = stdoutBuffer.slice(0, index);
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    handleLine(line);
  }
});

child.stderr.on("data", (chunk) => {
  const message = chunk.toString("utf8");
  if (message.trim()) {
    console.error(`\n${colorize("red", "[stderr]")} ${message.trim()}`);
    rl.prompt();
  }
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "mcp> "
});

let requestId = 1;

const sendRequest = (method, params) => {
  const payload = {
    jsonrpc: "2.0",
    id: requestId++,
    method,
    params
  };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  console.log(`\n${formatBanner("> REQUEST")}\n${colorize("cyan", JSON.stringify(payload, null, 2))}`);
};

const sendNotification = (method, params) => {
  const payload = {
    jsonrpc: "2.0",
    method,
    params
  };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  console.log(`\n${formatBanner("> NOTIFY")}\n${colorize("magenta", JSON.stringify(payload, null, 2))}`);
};

const parseParams = (jsonText) => {
  if (!jsonText || !jsonText.trim()) {
    return {};
  }
  try {
    return JSON.parse(jsonText);
  } catch (err) {
    console.error(colorize("red", `Invalid JSON: ${err instanceof Error ? err.message : err}`));
    return null;
  }
};

const parseCommand = (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const [first, ...rest] = trimmed.split(" ");
  const remainder = rest.join(" ").trim();

  if (first === "list" && rest.length > 0) {
    const target = rest[0];
    const paramsText = rest.slice(1).join(" ").trim();
    if (["tools", "resources", "prompts"].includes(target)) {
      return { method: `${target}/list`, paramsText, notify: false };
    }
  }

  if (first === "notify" && rest.length > 0) {
    const method = rest[0];
    const paramsText = rest.slice(1).join(" ").trim();
    return { method, paramsText, notify: true };
  }

  return { method: first, paramsText: remainder, notify: false };
};

const printHelp = () => {
  console.log(`${colorize("bold", "Commands")}:
  initialize {json}               Initialize session
  notifications/initialized {}    Send initialized notification
  tools/list {}                   List tools
  resources/list {}               List resources
  prompts/list {}                 List prompts
  tools/call {"name":"...","arguments":{}}     Call tool
  resources/read {"uri":"..."}    Read resource
  prompts/get {"name":"...","arguments":{}}    Get prompt
  ping {}                         Ping server
  list tools                      Shortcut for tools/list
  notify <method> {json}          Send JSON-RPC notification
  help                            Show help
  exit                            Quit
`);
};

console.log(`${colorize("green", "MCP CLI started")} ${colorize("dim", resolvedConfigPath)}`);
printHelp();
rl.prompt();

rl.on("line", (line) => {
  const trimmed = line.trim();
  userInputCounter += 1;
  if (!trimmed) {
    rl.prompt();
    return;
  }
  if (trimmed === "exit" || trimmed === "quit") {
    rl.close();
    child.kill();
    return;
  }
  if (trimmed === "help") {
    printHelp();
    rl.prompt();
    return;
  }

  const parsed = parseCommand(trimmed);
  if (!parsed) {
    rl.prompt();
    return;
  }

  const params = parseParams(parsed.paramsText);
  if (params === null) {
    rl.prompt();
    return;
  }

  if (parsed.notify) {
    sendNotification(parsed.method, params);
  } else {
    sendRequest(parsed.method, params);
  }
  rl.prompt();
});

rl.on("close", () => {
  console.log("\nClosing MCP CLI...");
  child.kill();
});
