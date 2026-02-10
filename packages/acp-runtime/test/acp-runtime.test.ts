import {expect, test} from "vitest";
import {ACPRuntime} from "../src";

test("ACPRuntime constructor accepts valid config", () => {
  const config = { command: "echo", args: ["hello"] };
  const runtime = new ACPRuntime(config);
  expect(runtime).toBeInstanceOf(ACPRuntime);
});

test("ACPRuntime getLogs returns empty array initially", () => {
  const runtime = new ACPRuntime({ command: "echo" });
  const logs = runtime.getLogs();
  expect(Array.isArray(logs)).toBe(true);
  expect(logs.length).toBe(0);
});

test("ACPRuntime setSpawnCwd returns true before start", () => {
  const runtime = new ACPRuntime({ command: "echo" });
  const result = runtime.setSpawnCwd("/tmp");
  expect(result).toBe(true);
});

test("ACPRuntime stop does not throw when not started", () => {
  const runtime = new ACPRuntime({ command: "echo" });
  expect(() => runtime.stop()).not.toThrow();
});

test("ACPRuntime emits log events", async () => {
  const runtime = new ACPRuntime({
    command: process.execPath,
    args: ["-e", "console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}))"]
  });

  const logs: any[] = [];
  runtime.on("log", (entry: any) => logs.push(entry));

  await runtime.sendRequest({ jsonrpc: "2.0", id: 1, method: "test" }, 2000);
  runtime.stop();

  expect(logs.length).toBeGreaterThan(0);
  expect(logs.some((l) => l.direction === "outgoing")).toBe(true);
});

test("ACPRuntime handles process that echoes back", async () => {
  const echoScript = `
    process.stdin.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (line) {
        try {
          const msg = JSON.parse(line);
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echoed: true } }) + '\\n');
        } catch {}
      }
    });
  `;

  const runtime = new ACPRuntime({
    command: process.execPath,
    args: ["-e", echoScript]
  });

  const response = await runtime.sendRequest({ jsonrpc: "2.0", id: 42, method: "echo" }, 3000);
  runtime.stop();

  expect(response).toBeDefined();
  expect(typeof response).toBe("object");
  expect((response as any).id).toBe(42);
  expect((response as any).result).toEqual({ echoed: true });
});

test("ACPRuntime times out on unresponsive process", async () => {
  const runtime = new ACPRuntime({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"]
  });

  const response = await runtime.sendRequest({ jsonrpc: "2.0", id: 1, method: "test" }, 100);
  runtime.stop();

  expect(response).toBeDefined();
  expect(typeof response).toBe("object");
  expect((response as any).error).toBeDefined();
  expect((response as any).error.message).toContain("timeout");
});
