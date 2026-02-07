import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const test = require("node:test");
const assert = require("assert/strict");

const { loadAcpConfig, getAcpAgents, resolveAcpAgentConfig } = require("../dist/acp-config.js");

let tempDir: string;
let configPath: string;

test.before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-main-test-"));
  configPath = path.join(tempDir, "acp.json");
});

test.after(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loadAcpConfig returns null for non-existent file", () => {
  const result = loadAcpConfig("/nonexistent/path/config.json");
  assert.equal(result, null);
});

test("loadAcpConfig parses valid JSON config", () => {
  const config = { agent_servers: { TestAgent: { command: "node" } } };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

  const result = loadAcpConfig(configPath);
  assert.deepEqual(result, config);
});

test("loadAcpConfig parses JSON5 with comments", () => {
  const configText = `{
    // This is a comment
    agent_servers: {
      TestAgent: { command: "node" },
    }
  }`;
  fs.writeFileSync(configPath, configText, "utf8");

  const result = loadAcpConfig(configPath);
  assert.ok(result);
  assert.ok(result.agent_servers.TestAgent);
});

test("getAcpAgents returns null for non-existent config", () => {
  const result = getAcpAgents("/nonexistent/path/config.json");
  assert.equal(result, null);
});

test("getAcpAgents returns agent list", () => {
  const config = {
    agent_servers: {
      Agent1: { command: "node", args: ["script1.js"] },
      Agent2: { command: "python", args: ["script2.py"] }
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

  const result = getAcpAgents(configPath);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2);
  assert.ok(result.some((a: any) => a.name === "Agent1" && a.command === "node"));
  assert.ok(result.some((a: any) => a.name === "Agent2" && a.command === "python"));
});

test("resolveAcpAgentConfig throws for non-existent config", () => {
  assert.throws(
    () => resolveAcpAgentConfig("TestAgent", "/nonexistent/path/config.json"),
    /ACP config not found/
  );
});

test("resolveAcpAgentConfig throws for empty agent_servers", () => {
  fs.writeFileSync(configPath, JSON.stringify({ agent_servers: {} }), "utf8");

  assert.throws(
    () => resolveAcpAgentConfig(undefined, configPath),
    /does not define any agent_servers/
  );
});

test("resolveAcpAgentConfig throws for unknown agent", () => {
  const config = { agent_servers: { Agent1: { command: "node" } } };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

  assert.throws(
    () => resolveAcpAgentConfig("UnknownAgent", configPath),
    /Unknown ACP agent/
  );
});

test("resolveAcpAgentConfig resolves named agent", () => {
  const config = {
    agent_servers: {
      Agent1: { command: "node", args: ["a.js"] },
      Agent2: { command: "python" }
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

  const result = resolveAcpAgentConfig("Agent2", configPath);
  assert.equal(result.name, "Agent2");
  assert.equal(result.config.command, "python");
});

test("resolveAcpAgentConfig returns first agent when no name provided", () => {
  const config = {
    agent_servers: {
      FirstAgent: { command: "node" },
      SecondAgent: { command: "python" }
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

  const result = resolveAcpAgentConfig(undefined, configPath);
  assert.equal(result.name, "FirstAgent");
});

test("resolveAcpAgentConfig preserves non-string env values", () => {
  const configText = `{
    agent_servers: {
      TestAgent: {
        command: "node",
        env: {
          STRING_VAL: "hello",
          NUM_VAL: 123,
          BOOL_VAL: true,
          OBJ_VAL: { key: "value" },
          ARR_VAL: [1, 2, 3],
          NULL_VAL: null
        }
      }
    }
  }`;
  fs.writeFileSync(configPath, configText, "utf8");

  const result = resolveAcpAgentConfig("TestAgent", configPath);
  assert.equal(result.config.env.STRING_VAL, "hello");
  assert.equal(result.config.env.NUM_VAL, 123);
  assert.equal(result.config.env.BOOL_VAL, true);
  assert.deepEqual(result.config.env.OBJ_VAL, { key: "value" });
  assert.deepEqual(result.config.env.ARR_VAL, [1, 2, 3]);
  assert.equal(result.config.env.NULL_VAL, null);
});
