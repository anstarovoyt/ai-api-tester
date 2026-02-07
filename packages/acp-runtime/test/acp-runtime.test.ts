import test from "node:test";
import assert from "assert/strict";

import {ACPRuntime} from "../dist/index.js";

test("ACPRuntime constructor accepts valid config", () => {
  const config = { command: "echo", args: ["hello"] };
  const runtime = new ACPRuntime(config);
  assert.ok(runtime instanceof ACPRuntime);
});

test("ACPRuntime getLogs returns empty array initially", () => {
  const runtime = new ACPRuntime({ command: "echo" });
  const logs = runtime.getLogs();
  assert.ok(Array.isArray(logs));
  assert.equal(logs.length, 0);
});

test("ACPRuntime setSpawnCwd returns true before start", () => {
  const runtime = new ACPRuntime({ command: "echo" });
  const result = runtime.setSpawnCwd("/tmp");
  assert.equal(result, true);
});

test("ACPRuntime stop does not throw when not started", () => {
  const runtime = new ACPRuntime({ command: "echo" });
  assert.doesNotThrow(() => runtime.stop());
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

  assert.ok(logs.length > 0, "expected at least one log entry");
  assert.ok(logs.some((l) => l.direction === "outgoing"), "expected outgoing log");
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

  assert.ok(response && typeof response === "object");
  assert.equal((response as any).id, 42);
  assert.deepEqual((response as any).result, { echoed: true });
});

test("ACPRuntime times out on unresponsive process", async () => {
  const runtime = new ACPRuntime({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"]
  });

  const response = await runtime.sendRequest({ jsonrpc: "2.0", id: 1, method: "test" }, 100);
  runtime.stop();

  assert.ok(response && typeof response === "object");
  assert.ok((response as any).error);
  assert.ok((response as any).error.message.includes("timeout"));
});
