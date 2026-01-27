const express = require("express");
const { MCPRuntime } = require("./mcp-runtime");

const args = process.argv.slice(2);
const configFlagIndex = args.findIndex((arg) => arg === "--config" || arg === "-c");
const configPath = configFlagIndex >= 0 && args[configFlagIndex + 1]
  ? args[configFlagIndex + 1]
  : "mcp-stdio.json";

const runtime = new MCPRuntime(configPath);
let started = false;

const ensureStarted = () => {
  if (!started) {
    runtime.start();
    started = true;
  }
};

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.post("/mcp", async (req, res) => {
  ensureStarted();
  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    res.status(400).json({ error: { message: "Invalid JSON-RPC payload" } });
    return;
  }

  const isNotification = payload.id === undefined || payload.id === null;
  const outgoing = {
    jsonrpc: payload.jsonrpc || "2.0",
    method: payload.method,
    params: payload.params ?? {}
  };

  if (!outgoing.method) {
    res.status(400).json({ error: { message: "Missing method in JSON-RPC payload" } });
    return;
  }

  if (isNotification) {
    runtime.sendNotification(outgoing);
    res.json({ ok: true });
    return;
  }

  outgoing.id = payload.id;
  const response = await runtime.sendRequest(outgoing);
  res.json(response);
});

app.get("/mcp/logs", (req, res) => {
  ensureStarted();
  res.json({ items: runtime.getLogs() });
});

const webPort = process.env.MCP_CLI_PORT || 4040;
app.listen(webPort, () => {
  console.log(`MCP web server running on http://localhost:${webPort}`);
});
