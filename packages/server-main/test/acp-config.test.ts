import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, beforeAll, afterAll } from "vitest";

import { loadAcpConfig, getAcpAgents, resolveAcpAgentConfig } from "../src/acp-config";

let tempDir: string;
let configPath: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-main-test-"));
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

test("loadAcpConfig parses JSON5 with comments", () => {
  const configText = `{
    // This is a comment
    agent_servers: {
      TestAgent: { command: "node" },
    }
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

test("getAcpAgents returns agent list", () => {
  const config = {
    agent_servers: {
      Agent1: { command: "node", args: ["script1.js"] },
      Agent2: { command: "python", args: ["script2.py"] }
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

  const result = getAcpAgents(configPath);
  expect(Array.isArray(result)).toBe(true);
  expect(result!.length).toBe(2);
  expect(result!.some((a: any) => a.name === "Agent1" && a.command === "node")).toBe(true);
  expect(result!.some((a: any) => a.name === "Agent2" && a.command === "python")).toBe(true);
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
  const config = { agent_servers: { Agent1: { command: "node" } } };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

  expect(() => resolveAcpAgentConfig("UnknownAgent", configPath))
    .toThrow(/Unknown ACP agent/);
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
  expect(result.name).toBe("Agent2");
  expect(result.config.command).toBe("python");
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
  expect(result.name).toBe("FirstAgent");
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
  expect(result.config.env.STRING_VAL).toBe("hello");
  expect(result.config.env.NUM_VAL).toBe(123);
  expect(result.config.env.BOOL_VAL).toBe(true);
  expect(result.config.env.OBJ_VAL).toEqual({ key: "value" });
  expect(result.config.env.ARR_VAL).toEqual([1, 2, 3]);
  expect(result.config.env.NULL_VAL).toBeNull();
});
