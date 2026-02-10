import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, beforeAll, afterAll } from "vitest";

type RuntimeEnvSnapshot = {
  env: Record<string, string | undefined>;
  has: Record<string, boolean>;
};

const repoRoot = path.resolve(__dirname, "..");
const fixtureAgentPath = path.join(__dirname, "fixtures", "env-agent.ts");
const nodeModulesPath = path.join(repoRoot, "node_modules");

const loadDist = (relativePath: string): any => require(path.join(repoRoot, relativePath));
const { ACPRuntime } = loadDist("acp-runtime/dist/index.js");

let tempDir: string | undefined;
let configPath: string | undefined;
let serverMainParser: any;
let remoteRunParser: any;
let mainAgentInfo: any;
let remoteAgentInfo: any;
let mainRuntimeResult: RuntimeEnvSnapshot | undefined;
let remoteRuntimeResult: RuntimeEnvSnapshot | undefined;

const writeJson5AcpConfig = (targetPath: string): void => {
  const configText = `{
    // JSON5: comments and trailing commas
    agent_servers: {
      TestAgent: {
        command: ${JSON.stringify(process.execPath)},
        args: ["--import", "tsx", ${JSON.stringify(fixtureAgentPath)}],
        env: {
          NODE_PATH: ${JSON.stringify(nodeModulesPath)},
          ACP_TEST_STRING: "hello",
          ACP_TEST_NUMBER: 123,
          ACP_TEST_BOOL: true,
          ACP_TEST_OBJECT: { a: 1 },
          ACP_TEST_ARRAY: [1, 2],
          ACP_TEST_REMOVE: null,
        },
      },
    },
  }`;
  fs.writeFileSync(targetPath, configText, "utf8");
};

const restoreEnv = (key: string, oldValue: string | undefined): void => {
  if (oldValue === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = oldValue;
  }
};

const fetchRuntimeEnv = async (agentConfig: any, label: string): Promise<RuntimeEnvSnapshot> => {
  const runtime = new ACPRuntime(agentConfig);
  try {
    const response = await runtime.sendRequest({ jsonrpc: "2.0", id: 1, method: "env/check", params: {} }, 5_000);
    if (!response || typeof response !== "object") {
      throw new Error(`${label}: expected object response, got ${typeof response}: ${JSON.stringify(response)}`);
    }
    if ((response as any).error) {
      throw new Error(`${label}: JSON-RPC error: ${JSON.stringify((response as any).error)}`);
    }
    if ((response as any).id !== 1) {
      throw new Error(`${label}: expected id=1, got id=${(response as any).id}, full response: ${JSON.stringify(response)}`);
    }

    const { env, has } = (response as any).result as RuntimeEnvSnapshot;
    if (!env || typeof env !== "object") {
      throw new Error(`${label}: expected result.env object, got ${typeof env}`);
    }
    if (!has || typeof has !== "object") {
      throw new Error(`${label}: expected result.has object, got ${typeof has}`);
    }
    return { env, has };
  } finally {
    runtime.stop();
  }
};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-env-test-"));
  configPath = path.join(tempDir, "acp.json");
  writeJson5AcpConfig(configPath);

  serverMainParser = loadDist("server-main/dist/acp-config.js");
  remoteRunParser = loadDist("server-remote-acp/dist/remote-run/config.js");

  mainAgentInfo = serverMainParser.resolveAcpAgentConfig("TestAgent", configPath);
  remoteAgentInfo = remoteRunParser.resolveAcpAgentConfig("TestAgent", configPath);

  const oldRemove = process.env.ACP_TEST_REMOVE;
  process.env.ACP_TEST_REMOVE = "present";
  try {
    mainRuntimeResult = await fetchRuntimeEnv(mainAgentInfo.config, "env via server-main parser");
    remoteRuntimeResult = await fetchRuntimeEnv(remoteAgentInfo.config, "env via remote-run parser");
  } finally {
    restoreEnv("ACP_TEST_REMOVE", oldRemove);
  }
});

afterAll(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("server-main parser loads JSON5 config", () => {
  const loaded = serverMainParser.loadAcpConfig(configPath!);
  expect(loaded).toBeTruthy();
  expect(typeof loaded).toBe("object");
});

test("server-main parser lists agents", () => {
  const agents = serverMainParser.getAcpAgents(configPath!);
  expect(Array.isArray(agents)).toBe(true);
  expect(agents.some((a: any) => a.name === "TestAgent")).toBe(true);
});

test("server-main parser resolves selected agent", () => {
  const resolved = serverMainParser.resolveAcpAgentConfig("TestAgent", configPath!);
  expect(resolved.name).toBe("TestAgent");
});

test("server-main parser keeps numeric env value from JSON5", () => {
  expect(mainAgentInfo.config.env.ACP_TEST_NUMBER).toBe(123);
});

test("server-main parser keeps boolean env value from JSON5", () => {
  expect(mainAgentInfo.config.env.ACP_TEST_BOOL).toBe(true);
});

test("server-main parser keeps object env value from JSON5", () => {
  expect(mainAgentInfo.config.env.ACP_TEST_OBJECT).toEqual({ a: 1 });
});

test("server-main parser keeps array env value from JSON5", () => {
  expect(mainAgentInfo.config.env.ACP_TEST_ARRAY).toEqual([1, 2]);
});

test("server-main parser keeps null env value from JSON5", () => {
  expect(mainAgentInfo.config.env.ACP_TEST_REMOVE).toBeNull();
});

test("remote-run parser loads JSON5 config", () => {
  const loaded = remoteRunParser.loadAcpConfig(configPath!);
  expect(loaded).toBeTruthy();
  expect(typeof loaded).toBe("object");
});

test("remote-run parser lists agents", () => {
  const agents = remoteRunParser.getAcpAgents(configPath!);
  expect(Array.isArray(agents)).toBe(true);
  expect(agents.some((a: any) => a.name === "TestAgent")).toBe(true);
});

test("remote-run parser resolves selected agent", () => {
  const resolved = remoteRunParser.resolveAcpAgentConfig("TestAgent", configPath!);
  expect(resolved.name).toBe("TestAgent");
});

test("remote-run parser keeps numeric env value from JSON5", () => {
  expect(remoteAgentInfo.config.env.ACP_TEST_NUMBER).toBe(123);
});

test("remote-run parser keeps boolean env value from JSON5", () => {
  expect(remoteAgentInfo.config.env.ACP_TEST_BOOL).toBe(true);
});

test("remote-run parser keeps object env value from JSON5", () => {
  expect(remoteAgentInfo.config.env.ACP_TEST_OBJECT).toEqual({ a: 1 });
});

test("remote-run parser keeps array env value from JSON5", () => {
  expect(remoteAgentInfo.config.env.ACP_TEST_ARRAY).toEqual([1, 2]);
});

test("remote-run parser keeps null env value from JSON5", () => {
  expect(remoteAgentInfo.config.env.ACP_TEST_REMOVE).toBeNull();
});

const runtimeChecks: Array<{ key: string; value: string | undefined; has: boolean }> = [
  { key: "ACP_TEST_STRING", value: "hello", has: true },
  { key: "ACP_TEST_NUMBER", value: "123", has: true },
  { key: "ACP_TEST_BOOL", value: "true", has: true },
  { key: "ACP_TEST_OBJECT", value: "{\"a\":1}", has: true },
  { key: "ACP_TEST_ARRAY", value: "[1,2]", has: true },
  { key: "ACP_TEST_REMOVE", value: undefined, has: false }
];

for (const check of runtimeChecks) {
  test(`ACPRuntime passes ${check.key} via server-main config`, () => {
    const snapshot = mainRuntimeResult;
    if (!snapshot) {
      throw new Error("missing mainRuntimeResult");
    }
    expect(snapshot.env[check.key]).toBe(check.value);
    expect(snapshot.has[check.key]).toBe(check.has);
  });
}

for (const check of runtimeChecks) {
  test(`ACPRuntime passes ${check.key} via remote-run config`, () => {
    const snapshot = remoteRuntimeResult;
    if (!snapshot) {
      throw new Error("missing remoteRuntimeResult");
    }
    expect(snapshot.env[check.key]).toBe(check.value);
    expect(snapshot.has[check.key]).toBe(check.has);
  });
}
