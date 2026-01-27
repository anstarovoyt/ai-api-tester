const express = require("express");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { MCPRuntime } = require("./mcp-runtime");
const { ACPRuntime } = require("./acp-runtime");
const { attachAcpRemoteServer } = require("./acp-remote-server");

const OPENAI_TARGET = process.env.OPENAI_TARGET || "http://localhost:1234";
const MCP_CONFIG = process.env.MCP_STDIO_CONFIG || "mcp-stdio.json";
const ACP_CONFIG = process.env.ACP_CONFIG || path.join(os.homedir(), ".jetbrains", "acp.json");
const ACP_REMOTE_PATH = process.env.ACP_REMOTE_PATH || "/acp";
const ACP_REMOTE_TOKEN = process.env.ACP_REMOTE_TOKEN || "";
const ACP_REMOTE_AGENT = process.env.ACP_REMOTE_AGENT || "";

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
  if (!config) {
    return null;
  }
  const servers = config.agent_servers || {};
  return Object.entries(servers).map(([name, value]) => ({
    name,
    command: value.command,
    args: value.args || []
  }));
};

const resolveAcpAgentConfig = (agentName) => {
  const config = loadAcpConfig();
  if (!config) {
    throw new Error(`ACP config not found: ${ACP_CONFIG}`);
  }
  const servers = config.agent_servers || {};
  const entries = Object.entries(servers);
  if (!entries.length) {
    throw new Error("ACP config does not define any agent_servers");
  }
  if (agentName) {
    const agentConfig = servers[agentName];
    if (!agentConfig) {
      throw new Error(`Unknown ACP agent: ${agentName}`);
    }
    return { name: agentName, config: agentConfig };
  }
  const [defaultName, defaultConfig] = entries[0];
  return { name: defaultName, config: defaultConfig };
};

const startGatewayServer = () => {
  const app = express();
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

  const ensureAcpRuntime = (agentName) => {
    const { name, config } = resolveAcpAgentConfig(agentName);
    if (acpRuntime && acpAgentName === name) {
      return;
    }
    if (acpRuntime) {
      acpRuntime.stop();
    }
    acpRuntime = new ACPRuntime(config);
    acpAgentName = name;
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
        pathRewrite: (pathValue) => pathValue.replace(new RegExp(`^${basePath}`), ""),
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

  const server = http.createServer(app);
  attachAcpRemoteServer(server, {
    path: ACP_REMOTE_PATH,
    token: ACP_REMOTE_TOKEN,
    resolveAgent: ({ queryAgent }) => {
      const selectedAgent = queryAgent || ACP_REMOTE_AGENT || acpAgentName;
      return resolveAcpAgentConfig(selectedAgent);
    }
  });

  const port = process.env.PORT || 3001;
  server.listen(port, () => {
    console.log(`Gateway running on http://localhost:${port}`);
    console.log(`OpenAI proxy -> ${OPENAI_TARGET} via /openAI`);
    console.log(`ACP config -> ${ACP_CONFIG}`);
    console.log(`ACP remote ws -> ws://localhost:${port}${ACP_REMOTE_PATH}`);
  });

  return server;
};

module.exports = { startGatewayServer };
