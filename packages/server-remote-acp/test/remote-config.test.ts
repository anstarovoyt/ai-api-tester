import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const restoreEnv = (key: string, oldValue: string | undefined): void => {
  if (oldValue === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = oldValue;
  }
};

let tempDir: string;
let remoteConfigPath: string;

const importFreshConfig = async () => {
  vi.resetModules();
  return await import("../src/remote-run/config");
};

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-remote-acp-remote-config-test-"));
  remoteConfigPath = path.join(tempDir, "acp-remote.json");
});

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("acp-remote.json overrides defaults when env vars are not set", async () => {
  const oldRemoteConfig = process.env.ACP_REMOTE_CONFIG;
  const oldPort = process.env.ACP_REMOTE_PORT;
  const oldPath = process.env.ACP_REMOTE_PATH;
  const oldGitRoot = process.env.ACP_REMOTE_GIT_ROOT;
  try {
    delete process.env.ACP_REMOTE_PORT;
    delete process.env.ACP_REMOTE_PATH;
    delete process.env.ACP_REMOTE_GIT_ROOT;
    process.env.ACP_REMOTE_CONFIG = remoteConfigPath;

    const expectedGitRoot = path.join(tempDir, "git-root");
    const expectedUltimateRoot = path.join(tempDir, "ultimate-root");
    const configText = `{
      port: 5555,
      path: "/custom",
      gitRoot: ${JSON.stringify(expectedGitRoot)},
      gitRootMap: {
        "github.com/acme/ultimate": ${JSON.stringify(expectedUltimateRoot)},
      },
    }`;
    fs.writeFileSync(remoteConfigPath, configText, "utf8");

    const config = await importFreshConfig();
    expect(config.ACP_REMOTE_PORT).toBe(5555);
    expect(config.ACP_REMOTE_PATH).toBe("/custom");
    expect(config.ACP_REMOTE_GIT_ROOT).toBe(path.resolve(expectedGitRoot));
    expect(config.ACP_REMOTE_GIT_ROOT_MAP).toEqual({
      "github.com/acme/ultimate": path.resolve(expectedUltimateRoot),
    });
    expect(config.ACP_REMOTE_GIT_ROOT_MAP_SOURCE_LABEL).toMatch(/gitRootMap/);
  } finally {
    restoreEnv("ACP_REMOTE_CONFIG", oldRemoteConfig);
    restoreEnv("ACP_REMOTE_PORT", oldPort);
    restoreEnv("ACP_REMOTE_PATH", oldPath);
    restoreEnv("ACP_REMOTE_GIT_ROOT", oldGitRoot);
  }
});

test("env vars take precedence over acp-remote.json", async () => {
  const oldRemoteConfig = process.env.ACP_REMOTE_CONFIG;
  const oldPort = process.env.ACP_REMOTE_PORT;
  try {
    process.env.ACP_REMOTE_CONFIG = remoteConfigPath;
    process.env.ACP_REMOTE_PORT = "4444";
    fs.writeFileSync(remoteConfigPath, `{ port: 5555 }`, "utf8");

    const config = await importFreshConfig();
    expect(config.ACP_REMOTE_PORT).toBe(4444);
  } finally {
    restoreEnv("ACP_REMOTE_CONFIG", oldRemoteConfig);
    restoreEnv("ACP_REMOTE_PORT", oldPort);
  }
});
