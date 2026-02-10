import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, beforeAll, afterAll } from "vitest";

import { loadAcpConfig, getAcpAgents, resolveAcpAgentConfig } from "../src/remote-run/config";

let tempDir: string;
let configPath: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-remote-acp-test-"));
  configPath = path.join(tempDir, "acp.json");
});

afterAll(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loadAcpConfig returns null for non-existent file", () => {
  const result = loadAcpConfig("/nonexistent/path/config.json");
  expect(result).toBeNull();
});

test("loadAcpConfig parses valid JSON config", () => {
  const config = { agent_servers: { TestAgent: { command: "node" } } };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

  const result = loadAcpConfig(configPath);
  expect(result).toEqual(config);
});

test("loadAcpConfig parses JSON5 with comments and trailing commas", () => {
  const configText = `{
    // JSON5 comment
    agent_servers: {
      TestAgent: { command: "node", },
    },
  }`;
  fs.writeFileSync(configPath, configText, "utf8");

  const result = loadAcpConfig(configPath);
  expect(result).toBeTruthy();
  expect(result!.agent_servers.TestAgent).toBeTruthy();
});

test("getAcpAgents returns null for non-existent config", () => {
  const result = getAcpAgents("/nonexistent/path/config.json");
  expect(result).toBeNull();
});

test("getAcpAgents returns agent list with correct structure", () => {
  const config = {
    agent_servers: {
      RemoteAgent1: { command: "node", args: ["remote1.js"] },
      RemoteAgent2: { command: "python", args: [] }
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

  const result = getAcpAgents(configPath);
  expect(Array.isArray(result)).toBe(true);
  expect(result!.length).toBe(2);
  expect(result!.some((a: any) => a.name === "RemoteAgent1")).toBe(true);
  expect(result!.some((a: any) => a.name === "RemoteAgent2")).toBe(true);
});

test("resolveAcpAgentConfig throws for non-existent config", () => {
  expect(() => resolveAcpAgentConfig("TestAgent", "/nonexistent/path/config.json"))
    .toThrow(/ACP config not found/);
});

test("resolveAcpAgentConfig throws for empty agent_servers", () => {
  fs.writeFileSync(configPath, JSON.stringify({ agent_servers: {} }), "utf8");

  expect(() => resolveAcpAgentConfig(undefined, configPath))
    .toThrow(/does not define any agent_servers/);
});

test("resolveAcpAgentConfig throws for unknown agent", () => {
  const config = { agent_servers: { KnownAgent: { command: "node" } } };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

  expect(() => resolveAcpAgentConfig("UnknownAgent", configPath))
    .toThrow(/Unknown ACP agent/);
});

test("resolveAcpAgentConfig resolves named agent", () => {
  const config = {
    agent_servers: {
      RemoteAgent1: { command: "node" },
      RemoteAgent2: { command: "python", args: ["run.py"] }
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

  const result = resolveAcpAgentConfig("RemoteAgent2", configPath);
  expect(result.name).toBe("RemoteAgent2");
  expect(result.config.command).toBe("python");
  expect(result.config.args).toEqual(["run.py"]);
});

test("resolveAcpAgentConfig prefers OpenCode agent when no name provided", () => {
  const config = {
    agent_servers: {
      FirstAgent: { command: "node" },
      OpenCode: { command: "opencode" },
      LastAgent: { command: "python" }
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

  const result = resolveAcpAgentConfig(undefined, configPath);
  expect(result.name).toBe("OpenCode");
});

test("resolveAcpAgentConfig returns first agent when no OpenCode and no name", () => {
  const config = {
    agent_servers: {
      FirstAgent: { command: "node" },
      SecondAgent: { command: "python" }
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

  const result = resolveAcpAgentConfig(undefined, configPath);
  expect(result.name).toBe("FirstAgent");
});

test("resolveAcpAgentConfig preserves complex env values from JSON5", () => {
  const configText = `{
    agent_servers: {
      TestAgent: {
        command: "node",
        env: {
          STRING_VAL: "world",
          NUM_VAL: 456,
          BOOL_VAL: false,
          OBJ_VAL: { nested: { deep: true } },
          ARR_VAL: ["a", "b"],
          NULL_VAL: null
        }
      }
    }
  }`;
  fs.writeFileSync(configPath, configText, "utf8");

  const result = resolveAcpAgentConfig("TestAgent", configPath);
  expect(result.config.env.STRING_VAL).toBe("world");
  expect(result.config.env.NUM_VAL).toBe(456);
  expect(result.config.env.BOOL_VAL).toBe(false);
  expect(result.config.env.OBJ_VAL).toEqual({ nested: { deep: true } });
  expect(result.config.env.ARR_VAL).toEqual(["a", "b"]);
  expect(result.config.env.NULL_VAL).toBeNull();
});
