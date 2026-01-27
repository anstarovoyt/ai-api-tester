const readline = require("readline");
const { MCPRuntime } = require("./mcp-runtime");

const args = process.argv.slice(2);
const configFlagIndex = args.findIndex((arg) => arg === "--config" || arg === "-c");
const configPath = configFlagIndex >= 0 && args[configFlagIndex + 1]
  ? args[configFlagIndex + 1]
  : "mcp-stdio.json";

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

const runtime = new MCPRuntime(configPath);
runtime.start();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "mcp> "
});

let requestId = 1;
let lastMessageKey = null;
let lastMessageCount = 0;
let lastMessageInputCounter = 0;
let lastRepeatPrintedAt = 0;
let userInputCounter = 0;

const printResponse = (payload) => {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  console.log(`\n${formatBanner("< RESPONSE")}\n${colorize("green", text)}`);
};

runtime.on("log", (entry) => {
  if (entry.direction === "outgoing") {
    return;
  }
  const payloadText = typeof entry.payload === "string"
    ? entry.payload
    : JSON.stringify(entry.payload);
  if (payloadText === lastMessageKey && lastMessageInputCounter === userInputCounter) {
    lastMessageCount += 1;
    const now = Date.now();
    if (lastMessageCount === 2 || now - lastRepeatPrintedAt > 2000) {
      console.log(colorize("dim", `-> repeated x${lastMessageCount}`));
      lastRepeatPrintedAt = now;
    }
    rl.prompt();
    return;
  }
  lastMessageKey = payloadText;
  lastMessageCount = 1;
  lastMessageInputCounter = userInputCounter;
  lastRepeatPrintedAt = 0;

  if (entry.direction === "error") {
    console.error(`\n${colorize("red", "[stderr]")} ${entry.payload}`);
    rl.prompt();
    return;
  }

  printResponse(entry.payload);
  rl.prompt();
});

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

const sendRequest = (method, params) => {
  const payload = {
    jsonrpc: "2.0",
    id: requestId++,
    method,
    params
  };
  console.log(`\n${formatBanner("> REQUEST")}\n${colorize("cyan", JSON.stringify(payload, null, 2))}`);
  runtime.sendRequest(payload).catch((err) => {
    console.error(colorize("red", `Request failed: ${err instanceof Error ? err.message : err}`));
  });
};

const sendNotification = (method, params) => {
  const payload = {
    jsonrpc: "2.0",
    method,
    params
  };
  console.log(`\n${formatBanner("> NOTIFY")}\n${colorize("magenta", JSON.stringify(payload, null, 2))}`);
  runtime.sendNotification(payload);
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

console.log(`${colorize("green", "MCP CLI started")} ${colorize("dim", configPath)}`);
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
    runtime.stop();
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
  runtime.stop();
});
