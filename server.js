const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { MCPRuntime } = require("./mcp-runtime");
const { ACPRuntime } = require("./acp-runtime");

const app = express();

const OPENAI_TARGET = process.env.OPENAI_TARGET || "http://localhost:1234";
const MCP_CONFIG = process.env.MCP_STDIO_CONFIG || "mcp-stdio.json";
const ACP_CONFIG = process.env.ACP_CONFIG || path.join(os.homedir(), ".jetbrains", "acp.json");

const mcpRuntime = new MCPRuntime(MCP_CONFIG);
let mcpStarted = false;
let acpRuntime = null;
let acpAgentName = null;

const ensureMcpStarted = () => {
  if (!mcpStarted) {
    mcpRuntime.start();
    mcpStarted = true;
  }
};

const loadAcpConfig = () => {
  if (!fs.existsSync(ACP_CONFIG)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(ACP_CONFIG, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const getAcpAgents = () => {
  const config = loadAcpConfig();
  const servers = config?.agent_servers || {};
  return Object.entries(servers).map(([name, value]) => ({
    name,
    command: value.command,
    args: value.args || []
  }));
};

const ensureAcpRuntime = (agentName) => {
  if (acpRuntime && acpAgentName === agentName) {
    return;
  }
  if (acpRuntime) {
    acpRuntime.stop();
  }
  const config = loadAcpConfig();
  const agentConfig = config?.agent_servers?.[agentName];
  if (!agentConfig) {
    throw new Error("Unknown ACP agent");
  }
  acpRuntime = new ACPRuntime(agentConfig);
  acpAgentName = agentName;
  acpRuntime.start();
};

app.use("/mcp", express.json({ limit: "2mb" }));
app.use("/acp", express.json({ limit: "2mb" }));
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

const proxyRoutes = [
  {
    name: "openAI",
    basePath: "/openAI",
    target: OPENAI_TARGET
  },
  {
    name: "openai",
    basePath: "/openai",
    target: OPENAI_TARGET
  }
];

proxyRoutes.forEach(({ basePath, target }) => {
  app.use(
    basePath,
    createProxyMiddleware({
      target,
      changeOrigin: true,
      ws: true,
      xfwd: true,
      proxyTimeout: 60_000,
      timeout: 60_000,
      logLevel: "warn",
      pathRewrite: (path) => path.replace(new RegExp(`^${basePath}`), ""),
      onError(err, req, res) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Proxy error: ${err.message}` } }));
      },
      onProxyRes(proxyRes) {
        proxyRes.headers["access-control-allow-origin"] = "*";
        proxyRes.headers["access-control-allow-methods"] = "*";
        proxyRes.headers["access-control-allow-headers"] = "*";
      }
    })
  );
});

app.post("/mcp", async (req, res) => {
  ensureMcpStarted();
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
    mcpRuntime.sendNotification(outgoing);
    res.json({ ok: true });
    return;
  }

  outgoing.id = payload.id;
  const response = await mcpRuntime.sendRequest(outgoing);
  res.json(response);
});

app.get("/mcp/logs", (req, res) => {
  ensureMcpStarted();
  res.json({ items: mcpRuntime.getLogs() });
});

app.get("/acp/agents", (req, res) => {
  const agents = getAcpAgents();
  if (!agents) {
    res.status(404).json({ error: { message: "ACP config not found" } });
    return;
  }
  res.json({ agents });
});

app.post("/acp/select", (req, res) => {
  const agentName = req.body?.agent;
  if (!agentName) {
    res.status(400).json({ error: { message: "Missing agent in request" } });
    return;
  }
  try {
    ensureAcpRuntime(agentName);
    res.json({ ok: true, agent: agentName });
  } catch (err) {
    res.status(400).json({ error: { message: err instanceof Error ? err.message : "Failed to start agent" } });
  }
});

app.post("/acp", async (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    res.status(400).json({ error: { message: "Invalid JSON-RPC payload" } });
    return;
  }
  if (!acpRuntime) {
    res.status(400).json({ error: { message: "ACP agent not selected" } });
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
    acpRuntime.sendNotification(outgoing);
    res.json({ ok: true });
    return;
  }

  outgoing.id = payload.id;
  const response = await acpRuntime.sendRequest(outgoing);
  res.json(response);
});

app.get("/acp/logs", (req, res) => {
  if (!acpRuntime) {
    res.json({ items: [] });
    return;
  }
  res.json({ items: acpRuntime.getLogs() });
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Gateway running on http://localhost:${port}`);
  console.log(`OpenAI proxy -> ${OPENAI_TARGET} via /openAI`);
  console.log(`ACP config -> ${ACP_CONFIG}`);
});
