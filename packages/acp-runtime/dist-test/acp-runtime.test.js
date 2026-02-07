"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("assert/strict"));
const index_js_1 = require("../dist/index.js");
(0, node_test_1.default)("ACPRuntime constructor accepts valid config", () => {
    const config = { command: "echo", args: ["hello"] };
    const runtime = new index_js_1.ACPRuntime(config);
    strict_1.default.ok(runtime instanceof index_js_1.ACPRuntime);
});
(0, node_test_1.default)("ACPRuntime getLogs returns empty array initially", () => {
    const runtime = new index_js_1.ACPRuntime({ command: "echo" });
    const logs = runtime.getLogs();
    strict_1.default.ok(Array.isArray(logs));
    strict_1.default.equal(logs.length, 0);
});
(0, node_test_1.default)("ACPRuntime setSpawnCwd returns true before start", () => {
    const runtime = new index_js_1.ACPRuntime({ command: "echo" });
    const result = runtime.setSpawnCwd("/tmp");
    strict_1.default.equal(result, true);
});
(0, node_test_1.default)("ACPRuntime stop does not throw when not started", () => {
    const runtime = new index_js_1.ACPRuntime({ command: "echo" });
    strict_1.default.doesNotThrow(() => runtime.stop());
});
(0, node_test_1.default)("ACPRuntime emits log events", async () => {
    const runtime = new index_js_1.ACPRuntime({
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}))"]
    });
    const logs = [];
    runtime.on("log", (entry) => logs.push(entry));
    await runtime.sendRequest({ jsonrpc: "2.0", id: 1, method: "test" }, 2000);
    runtime.stop();
    strict_1.default.ok(logs.length > 0, "expected at least one log entry");
    strict_1.default.ok(logs.some((l) => l.direction === "outgoing"), "expected outgoing log");
});
(0, node_test_1.default)("ACPRuntime handles process that echoes back", async () => {
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
    const runtime = new index_js_1.ACPRuntime({
        command: process.execPath,
        args: ["-e", echoScript]
    });
    const response = await runtime.sendRequest({ jsonrpc: "2.0", id: 42, method: "echo" }, 3000);
    runtime.stop();
    strict_1.default.ok(response && typeof response === "object");
    strict_1.default.equal(response.id, 42);
    strict_1.default.deepEqual(response.result, { echoed: true });
});
(0, node_test_1.default)("ACPRuntime times out on unresponsive process", async () => {
    const runtime = new index_js_1.ACPRuntime({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"]
    });
    const response = await runtime.sendRequest({ jsonrpc: "2.0", id: 1, method: "test" }, 100);
    runtime.stop();
    strict_1.default.ok(response && typeof response === "object");
    strict_1.default.ok(response.error);
    strict_1.default.ok(response.error.message.includes("timeout"));
});
//# sourceMappingURL=acp-runtime.test.js.map