/**
 * MCP registry tests — the testable core of the CLI wiring (scope §4.3/§4.4/§7).
 *
 * Uses the mock transport (test/mock-transport.ts) via an injected mock
 * `spawnFn` (no child process). Covers: the ready path (modern + legacy),
 * per-server isolation (one failure never aborts the launch), the disabled
 * skip, the per-server tool allowlist, the atomic import rejection (a wire
 * name colliding with a built-in), the §7 status line, and the teardown
 * (graceful `teardown` + synchronous `killAll` backstop).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startMcpServers,
  teardownAll,
  killAll,
  mcpStatusLine,
  type McpSpawnFn,
  type McpStartOptions,
} from "../src/mcp/registry.js";
import {
  MCP_CLIENT_VERSION,
  MCP_LEGACY_VERSION,
  MCP_ERR_METHOD_NOT_FOUND,
} from "../src/mcp/client.js";
import { encodeMcpToolName } from "../src/mcp/adapter.js";
import { MockMcpServer } from "./mock-transport.js";
import type { McpSpawn } from "../src/mcp/spawn.js";
import type { McpServerConfig } from "../src/config/tre-config.js";

const FAST = {
  callTimeoutMs: 1500,
  probeTimeoutMs: 300,
  startupBudgetMs: 2500,
  stallMs: 200,
};

/** A mock spawnFn that hands the registry a fake McpSpawn wrapping the
 *  given MockMcpServer's transport (no child process). */
function mockSpawnFn(
  mock: MockMcpServer,
  opts: { fail?: boolean } = {},
): McpSpawnFn {
  return async () => {
    if (opts.fail) throw new Error("spawn failed (simulated)");
    const spawn: McpSpawn = {
      child: { pid: undefined } as McpSpawn["child"],
      stdin: mock.stdin,
      stdout: mock.stdout,
      stderr: mock.stderr,
      close: () => {
        mock.closed = true;
        return Promise.resolve();
      },
      kill: () => {
        mock.killed = true;
      },
      dispose: () => Promise.resolve(),
    };
    return spawn;
  };
}

/** A mock that answers a modern probe + tools/list (ready in ~2 ticks). */
function modernMock(
  mock: MockMcpServer,
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [
    { name: "read_file", description: "read", inputSchema: { type: "object" } },
  ],
): void {
  mock.onInbound((l) => {
    const id = l.obj.id as number;
    if (l.obj.method === "server/discover") {
      mock.respondResult(id, {
        resultType: "discovery",
        supportedVersions: [MCP_CLIENT_VERSION],
      });
    } else if (l.obj.method === "tools/list") {
      mock.respondResult(id, { tools });
    }
  });
}

/** A mock that answers the probe with a legacy error + initialize + tools/list. */
function legacyMock(
  mock: MockMcpServer,
  tools: Array<{ name: string }> = [{ name: "ping" }],
): void {
  mock.onInbound((l) => {
    const id = l.obj.id as number;
    if (l.obj.method === "server/discover") {
      mock.respondError(id, MCP_ERR_METHOD_NOT_FOUND, "unknown method");
    } else if (l.obj.method === "initialize") {
      mock.respondResult(id, {
        protocolVersion: MCP_LEGACY_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "mock", version: "1" },
      });
    } else if (l.obj.method === "tools/list") {
      mock.respondResult(id, { tools });
    }
  });
}

const baseOpts: McpStartOptions = {
  launchDir: "/tmp/launch",
  workspace: "/tmp/ws",
  extraRoots: [],
  parentEnv: {},
  clientOpts: FAST,
};

const srv = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  command: "node",
  args: [],
  env: {},
  cwd: "",
  tools: [],
  disabled: false,
  trust: false,
  sandbox: false,
  inheritEnv: false,
  ...over,
});

test("modern ready: imports tools, state ready, status line", async () => {
  const mock = new MockMcpServer();
  modernMock(mock, [
    { name: "read_file", inputSchema: { type: "object" } },
    { name: "write_file", inputSchema: { type: "object" } },
  ]);
  const { handles, tools } = await startMcpServers(
    { fs: srv() },
    mockSpawnFn(mock),
    baseOpts,
  );
  assert.equal(handles.length, 1);
  assert.equal(handles[0]!.name, "fs");
  assert.equal(handles[0]!.state, "ready");
  assert.equal(handles[0]!.reason, "");
  assert.equal(tools.length, 2);
  assert.equal(handles[0]!.tools.length, 2);
  // The wire names are the encoded `mcp__` names; the originals are preserved.
  assert.equal(tools[0]!.name, encodeMcpToolName("fs", "read_file"));
  assert.equal((tools[0] as { mcpServer: string }).mcpServer, "fs");
  assert.equal((tools[0] as { mcpTool: string }).mcpTool, "read_file");
  assert.equal(mcpStatusLine(handles[0]!), "fs — ready (2 tools)");
});

test("legacy ready: the era probe falls back to initialize", async () => {
  const mock = new MockMcpServer();
  legacyMock(mock, [{ name: "ping" }]);
  const { handles, tools } = await startMcpServers(
    { db: srv() },
    mockSpawnFn(mock),
    baseOpts,
  );
  assert.equal(handles[0]!.state, "ready");
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, encodeMcpToolName("db", "ping"));
  assert.equal(mcpStatusLine(handles[0]!), "db — ready (1 tool)");
});

test("per-server isolation: one failure never aborts the launch", async () => {
  const good = new MockMcpServer();
  modernMock(good, [{ name: "ok" }]);
  // `bad` never answers the probe → startup timeout → failed.
  const bad = new MockMcpServer(); // no handler
  const g = mockSpawnFn(good);
  const b = mockSpawnFn(bad);
  const spawnFn: McpSpawnFn = async (cmd, args, o) =>
    cmd === "bad" ? b(cmd, args, o) : g(cmd, args, o);
  const { handles, tools } = await startMcpServers(
    { bad: srv({ command: "bad" }), good: srv({ command: "good" }) },
    spawnFn,
    baseOpts,
  );
  const byName = new Map(handles.map((h) => [h.name, h]));
  assert.equal(byName.get("bad")!.state, "failed");
  assert.ok(byName.get("bad")!.reason.length > 0, "failure carries a reason");
  assert.equal(byName.get("good")!.state, "ready");
  // Only the good server's tools register.
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, encodeMcpToolName("good", "ok"));
});

test("a spawn rejection fails that server (full teardown), others proceed", async () => {
  const good = new MockMcpServer();
  modernMock(good, [{ name: "ok" }]);
  const g = mockSpawnFn(good);
  const spawnFn: McpSpawnFn = async (cmd, args, o) =>
    cmd === "boom"
      ? Promise.reject(new Error("ENOENT: simulated spawn failure"))
      : g(cmd, args, o);
  const { handles, tools } = await startMcpServers(
    { boom: srv({ command: "boom" }), good: srv({ command: "good" }) },
    spawnFn,
    baseOpts,
  );
  const byName = new Map(handles.map((h) => [h.name, h]));
  assert.equal(byName.get("boom")!.state, "failed");
  assert.match(byName.get("boom")!.reason, /ENOENT/);
  assert.equal(byName.get("good")!.state, "ready");
  assert.equal(tools.length, 1);
});

test("disabled: no spawn, no tools, state disabled", async () => {
  let spawned = false;
  const g = mockSpawnFn(new MockMcpServer());
  const spawnFn: McpSpawnFn = async (cmd, args, o) => {
    spawned = true;
    return g(cmd, args, o);
  };
  const { handles, tools } = await startMcpServers(
    { off: srv({ disabled: true }) },
    spawnFn,
    baseOpts,
  );
  assert.equal(spawned, false, "a disabled server is never spawned");
  assert.equal(handles[0]!.state, "disabled");
  assert.equal(tools.length, 0);
  assert.equal(mcpStatusLine(handles[0]!), "off — disabled");
});

test("per-server tool allowlist: only the named tools import", async () => {
  const mock = new MockMcpServer();
  modernMock(mock, [
    { name: "a", inputSchema: { type: "object" } },
    { name: "b", inputSchema: { type: "object" } },
  ]);
  const { handles, tools } = await startMcpServers(
    { fs: srv({ tools: ["a"] }) },
    mockSpawnFn(mock),
    baseOpts,
  );
  assert.equal(handles[0]!.state, "ready");
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, encodeMcpToolName("fs", "a"));
});

test("atomic import rejection: a wire name colliding with a built-in rejects the whole server", async () => {
  const mock = new MockMcpServer();
  // A tool whose encoded wire name equals a seeded built-in name.
  const collidingWire = encodeMcpToolName("fs", "tool");
  modernMock(mock, [{ name: "tool", inputSchema: { type: "object" } }]);
  const { handles, tools } = await startMcpServers(
    { fs: srv() },
    mockSpawnFn(mock),
    { ...baseOpts, builtinNames: [collidingWire] },
  );
  assert.equal(handles[0]!.state, "failed");
  assert.match(handles[0]!.reason, /tool import rejected/);
  assert.equal(tools.length, 0, "a rejected import registers none of the server's tools");
  assert.equal(mcpStatusLine(handles[0]!), `fs — failed (tool import rejected: tool)`);
});

test("teardown (graceful): closes the client + disposes the spawn, idempotent", async () => {
  const mock = new MockMcpServer();
  modernMock(mock, [{ name: "ok" }]);
  let disposed = 0;
  const base = mockSpawnFn(mock);
  const spawnFn: McpSpawnFn = async (cmd, args, o) => {
    const s = await base(cmd, args, o);
    return { ...s, dispose: async () => { disposed++; } };
  };
  const { handles } = await startMcpServers({ fs: srv() }, spawnFn, baseOpts);
  const h = handles[0]!;
  await h.teardown();
  assert.equal(mock.killed, true, "the transport is killed (client.close)");
  assert.equal(disposed, 1, "the spawn is disposed (sandbox resources released)");
  await h.teardown(); // idempotent
  assert.equal(disposed, 1, "a second teardown is a no-op");
});

test("killAll (synchronous backstop): kills + disposes without awaiting", async () => {
  const mock = new MockMcpServer();
  modernMock(mock, [{ name: "ok" }]);
  let disposed = 0;
  const base = mockSpawnFn(mock);
  const spawnFn: McpSpawnFn = async (cmd, args, o) => {
    const s = await base(cmd, args, o);
    return { ...s, dispose: async () => { disposed++; } };
  };
  const { handles } = await startMcpServers({ fs: srv() }, spawnFn, baseOpts);
  const h = handles[0]!;
  h.kill(); // synchronous — must not throw, must not await
  assert.equal(mock.killed, true);
  // dispose is async (best-effort); give it a tick.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(disposed, 1);
  h.kill(); // idempotent
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(disposed, 1);
});

test("teardownAll + killAll (top-level wrappers) operate over every server", async () => {
  const a = new MockMcpServer();
  modernMock(a, [{ name: "a" }]);
  const b = new MockMcpServer();
  modernMock(b, [{ name: "b" }]);
  const ga = mockSpawnFn(a);
  const gb = mockSpawnFn(b);
  const spawnFn: McpSpawnFn = async (cmd, args, o) =>
    cmd === "a" ? ga(cmd, args, o) : gb(cmd, args, o);
  const result = await startMcpServers(
    { a: srv({ command: "a" }), b: srv({ command: "b" }) },
    spawnFn,
    baseOpts,
  );
  assert.equal(result.handles.length, 2);
  assert.equal(result.tools.length, 2);
  // Graceful teardown of BOTH.
  await teardownAll(result);
  assert.equal(a.killed, true);
  assert.equal(b.killed, true);
  // The synchronous backstop over a fresh result.
  const a2 = new MockMcpServer();
  modernMock(a2, [{ name: "a" }]);
  const a2f = mockSpawnFn(a2);
  const r2 = await startMcpServers({ a: srv({ command: "a" }) }, a2f, baseOpts);
  killAll(r2);
  assert.equal(a2.killed, true);
});
