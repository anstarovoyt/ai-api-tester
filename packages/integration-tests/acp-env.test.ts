import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const test = require("node:test");
const assert = require("assert/strict");

type RuntimeEnvSnapshot = {
  env: Record<string, string | undefined>;
  has: Record<string, boolean>;
};

const repoRoot = path.resolve(__dirname, "../..");
const fixtureAgentPath = path.join(__dirname, "fixtures", "env-agent.js");

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
        args: [${JSON.stringify(fixtureAgentPath)}],
        env: {
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
    assert.ok(response && typeof response === "object", `${label}: expected JSON-RPC object response`);
    assert.equal((response as any).id, 1, `${label}: expected matching JSON-RPC id`);
    assert.ok((response as any).result && typeof (response as any).result === "object", `${label}: expected result object`);

    const { env, has } = (response as any).result as RuntimeEnvSnapshot;
    assert.ok(env && typeof env === "object", `${label}: expected result.env object`);
    assert.ok(has && typeof has === "object", `${label}: expected result.has object`);
    return { env, has };
  } finally {
    runtime.stop();
  }
};

test.before(async () => {
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

test.after(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("server-main parser loads JSON5 config", () => {
  const loaded = serverMainParser.loadAcpConfig(configPath!);
  assert.ok(loaded && typeof loaded === "object");
});

test("server-main parser lists agents", () => {
  const agents = serverMainParser.getAcpAgents(configPath!);
  assert.ok(Array.isArray(agents));
  assert.ok(agents.some((a: any) => a.name === "TestAgent"));
});

test("server-main parser resolves selected agent", () => {
  const resolved = serverMainParser.resolveAcpAgentConfig("TestAgent", configPath!);
  assert.equal(resolved.name, "TestAgent");
});

test("server-main parser keeps numeric env value from JSON5", () => {
  assert.equal(mainAgentInfo.config.env.ACP_TEST_NUMBER, 123);
});

test("server-main parser keeps boolean env value from JSON5", () => {
  assert.equal(mainAgentInfo.config.env.ACP_TEST_BOOL, true);
});

test("server-main parser keeps object env value from JSON5", () => {
  assert.deepEqual(mainAgentInfo.config.env.ACP_TEST_OBJECT, { a: 1 });
});

test("server-main parser keeps array env value from JSON5", () => {
  assert.deepEqual(mainAgentInfo.config.env.ACP_TEST_ARRAY, [1, 2]);
});

test("server-main parser keeps null env value from JSON5", () => {
  assert.equal(mainAgentInfo.config.env.ACP_TEST_REMOVE, null);
});

test("remote-run parser loads JSON5 config", () => {
  const loaded = remoteRunParser.loadAcpConfig(configPath!);
  assert.ok(loaded && typeof loaded === "object");
});

test("remote-run parser lists agents", () => {
  const agents = remoteRunParser.getAcpAgents(configPath!);
  assert.ok(Array.isArray(agents));
  assert.ok(agents.some((a: any) => a.name === "TestAgent"));
});

test("remote-run parser resolves selected agent", () => {
  const resolved = remoteRunParser.resolveAcpAgentConfig("TestAgent", configPath!);
  assert.equal(resolved.name, "TestAgent");
});

test("remote-run parser keeps numeric env value from JSON5", () => {
  assert.equal(remoteAgentInfo.config.env.ACP_TEST_NUMBER, 123);
});

test("remote-run parser keeps boolean env value from JSON5", () => {
  assert.equal(remoteAgentInfo.config.env.ACP_TEST_BOOL, true);
});

test("remote-run parser keeps object env value from JSON5", () => {
  assert.deepEqual(remoteAgentInfo.config.env.ACP_TEST_OBJECT, { a: 1 });
});

test("remote-run parser keeps array env value from JSON5", () => {
  assert.deepEqual(remoteAgentInfo.config.env.ACP_TEST_ARRAY, [1, 2]);
});

test("remote-run parser keeps null env value from JSON5", () => {
  assert.equal(remoteAgentInfo.config.env.ACP_TEST_REMOVE, null);
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
    assert.equal(snapshot.env[check.key], check.value);
    assert.equal(snapshot.has[check.key], check.has);
  });
}

for (const check of runtimeChecks) {
  test(`ACPRuntime passes ${check.key} via remote-run config`, () => {
    const snapshot = remoteRuntimeResult;
    if (!snapshot) {
      throw new Error("missing remoteRuntimeResult");
    }
    assert.equal(snapshot.env[check.key], check.value);
    assert.equal(snapshot.has[check.key], check.has);
  });
}
