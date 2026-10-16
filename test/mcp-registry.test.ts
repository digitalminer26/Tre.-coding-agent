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
  reapPendingSpawns,
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
    // Mirror the REAL spawn's close semantics: one shared chain (repeated
    // close() calls await the SAME promise, not a double escalation).
    let closeChain: Promise<void> | null = null;
    const spawn: McpSpawn = {
      child: { pid: undefined } as McpSpawn["child"],
      stdin: mock.stdin,
      stdout: mock.stdout,
      stderr: mock.stderr,
      close: () => {
        if (!closeChain) {
          closeChain = Promise.resolve().then(() => {
            mock.closed = true;
          });
        }
        return closeChain;
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

/** The `mcp_resource` tool(s) in a result's flat tools list (there should be
 *  at most one — it is a single fixed-name tool, not per-server). */
function resourceTools(tools: { name: string }[]): { name: string }[] {
  return tools.filter((t) => t.name === "mcp_resource");
}

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
  // 2 imported tools + the single `mcp_resource` tool (≥1 ready server).
  assert.equal(tools.length, 3);
  assert.equal(handles[0]!.tools.length, 2, "the handle only carries its imported tools");
  // The wire names are the encoded `mcp__` names; the originals are preserved.
  assert.equal(tools[0]!.name, encodeMcpToolName("fs", "read_file"));
  assert.equal((tools[0] as unknown as { mcpServer: string }).mcpServer, "fs");
  assert.equal((tools[0] as unknown as { mcpTool: string }).mcpTool, "read_file");
  // The single resource tool is present exactly once.
  assert.equal(resourceTools(tools).length, 1, "one mcp_resource tool");
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
  // 1 imported tool + the single `mcp_resource` tool.
  assert.equal(tools.length, 2);
  assert.equal(tools[0]!.name, encodeMcpToolName("db", "ping"));
  assert.equal(resourceTools(tools).length, 1, "one mcp_resource tool");
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
  // Only the good server's tools register, plus the single `mcp_resource`.
  assert.equal(tools.length, 2);
  assert.equal(tools[0]!.name, encodeMcpToolName("good", "ok"));
  assert.equal(resourceTools(tools).length, 1, "one mcp_resource tool");
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
  // The good server's tool + the single `mcp_resource` (≥1 ready).
  assert.equal(tools.length, 2);
  assert.equal(resourceTools(tools).length, 1, "one mcp_resource tool");
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
  // 1 imported tool (the allowlist) + the single `mcp_resource`.
  assert.equal(tools.length, 2);
  assert.equal(tools[0]!.name, encodeMcpToolName("fs", "a"));
  assert.equal(resourceTools(tools).length, 1, "one mcp_resource tool");
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

test("teardown (graceful): graceful close (NOT a kill) + dispose AFTER the close chain, idempotent", async () => {
  const mock = new MockMcpServer();
  modernMock(mock, [{ name: "ok" }]);
  let disposed = 0;
  let closeCount = 0;
  const base = mockSpawnFn(mock);
  const spawnFn: McpSpawnFn = async (cmd, args, o) => {
    const s = await base(cmd, args, o);
    // Mirror the real spawn: one shared close chain (the registry's
    // client.close() AND its spawn.close() await the SAME escalation).
    let chain: Promise<void> | null = null;
    return {
      ...s,
      close: () => {
        if (!chain) {
          chain = Promise.resolve().then(() => {
            closeCount++;
            mock.closed = true;
          });
        }
        return chain;
      },
      dispose: async () => {
        disposed++;
      },
    };
  };
  const { handles } = await startMcpServers({ fs: srv() }, spawnFn, baseOpts);
  const h = handles[0]!;
  await h.teardown();
  assert.equal(
    mock.killed,
    false,
    "graceful teardown does NOT SIGKILL the transport (the escalation ran instead)",
  );
  assert.equal(mock.closed, true, "the transport was closed (graceful arm)");
  assert.equal(closeCount, 1, "spawn.close awaited exactly once");
  assert.equal(disposed, 1, "the spawn is disposed (sandbox resources released)");
  await h.teardown(); // idempotent
  assert.equal(disposed, 1, "a second teardown is a no-op");
});

test("audit #2: teardown REJECTS when the group survives the kill bound (unconfirmed termination is not a clean shutdown)", async () => {
  // The spawn's close chain REJECTS (the group did not confirm gone within
  // the SIGKILL bound). The registry's teardown must PROPAGATE that
  // rejection (not swallow it), and must NOT dispose (disposal would race a
  // live group). teardownAll must surface it as a combined failure.
  const mock = new MockMcpServer();
  modernMock(mock, [{ name: "ok" }]);
  let disposed = 0;
  const base = mockSpawnFn(mock);
  let chain: Promise<void> | null = null;
  const spawnFn: McpSpawnFn = async (cmd, args, o) => {
    const s = await base(cmd, args, o);
    return {
      ...s,
      // Mirror the real spawn: ONE shared close chain (the transport's
      // fire-and-forget `void spawn.close()` and the registry's `await
      // spawn.close()` must reference the SAME rejecting promise, so the
      // rejection is handled exactly once — a fresh reject per call would
      // leave the transport's `void` call unhandled).
      close: () => {
        if (!chain) {
          chain = Promise.reject(
            new Error("process group did not exit within the kill bound after SIGKILL"),
          );
        }
        return chain;
      },
      dispose: async () => {
        disposed++;
      },
    };
  };
  const result = await startMcpServers({ fs: srv() }, spawnFn, baseOpts);
  const h = result.handles[0]!;
  // The per-server teardown rejects (propagated, not swallowed).
  await assert.rejects(h.teardown(), /kill bound/);
  // Disposal did NOT run (a live group must not have its sandbox released).
  assert.equal(disposed, 0, "no dispose after an unconfirmed termination");
  // The top-level wrapper surfaces the combined failure.
  await assert.rejects(teardownAll(result), /did not fully complete/);
});

test("killAll retains resources until termination is confirmed", async () => {
  const mock = new MockMcpServer();
  modernMock(mock, [{ name: "ok" }]);
  let disposed = 0;
  let kills = 0;
  const base = mockSpawnFn(mock);
  const spawnFn: McpSpawnFn = async (cmd, args, o) => {
    const s = await base(cmd, args, o);
    return {
      ...s,
      kill: () => {
        kills++;
      },
      dispose: async () => {
        disposed++;
      },
    };
  };
  const { handles } = await startMcpServers({ fs: srv() }, spawnFn, baseOpts);
  const h = handles[0]!;
  // The handle + the client's transport each send the SIGKILL (defense in
  // depth — two idempotent sends to the same group). So ONE h.kill() = 2
  // spawn.kill() calls.
  // The handle + the client's transport each send the SIGKILL (defense in
  // depth — idempotent sends to the same group). The FIRST h.kill() = 2
  // spawn.kill() calls; later ones = 1 (the client is already closed, so its
  // transport-kill arm is a no-op — the handle's own send is what repeats).
  h.kill(); // synchronous — must not throw, must not await
  assert.equal(kills, 2, "the group was SIGKILLed (handle + client arm)");
  assert.equal(disposed, 0, "a kill alone does NOT dispose (termination unconfirmed)");
  h.kill(); // REPEATABLE: a second emergency kill still fires
  assert.equal(kills, 3, "kill is repeatable while unconfirmed");
  assert.equal(disposed, 0, "still no dispose");
  // Only a close() that CONFIRMS the group is gone releases the resources.
  await h.teardown();
  assert.equal(disposed, 1, "dispose happens on confirmed teardown");
  h.kill(); // no-op once confirmed
  assert.equal(kills, 3, "kill is inert after confirmation");
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
  // 2 imported tools (a + b) + the single `mcp_resource`.
  assert.equal(result.tools.length, 3);
  assert.equal(resourceTools(result.tools).length, 1, "one mcp_resource tool");
  // Graceful teardown of BOTH (close, NOT kill — the escalation runs inside
  // the spawn; the mock spawn's close records it).
  await teardownAll(result);
  assert.equal(a.killed, false, "graceful teardown does not SIGKILL");
  assert.equal(b.killed, false, "graceful teardown does not SIGKILL");
  assert.equal(a.closed, true, "server a's transport was closed");
  assert.equal(b.closed, true, "server b's transport was closed");
  // The synchronous backstop over a fresh result.
  const a2 = new MockMcpServer();
  modernMock(a2, [{ name: "a" }]);
  const a2f = mockSpawnFn(a2);
  const r2 = await startMcpServers({ a: srv({ command: "a" }) }, a2f, baseOpts);
  killAll(r2);
  assert.equal(a2.killed, true);
});

// ── the single `mcp_resource` tool (tier 2 — resources) ────────────────────
// ONE fixed-name tool across ALL ready servers, appended ONLY IF ≥1 server
// is ready. It is not per-server, so the per-server `tools` allowlist does
// not apply to it.

test("mcp_resource: one ready server → exactly ONE resource tool (plus the imported tools)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock, [{ name: "read_file", inputSchema: { type: "object" } }]);
  const { handles, tools } = await startMcpServers(
    { fs: srv() },
    mockSpawnFn(mock),
    baseOpts,
  );
  assert.equal(handles[0]!.state, "ready");
  // 1 imported tool + the single mcp_resource tool.
  assert.equal(tools.length, 2);
  assert.equal(tools[0]!.name, encodeMcpToolName("fs", "read_file"));
  const rt = resourceTools(tools);
  assert.equal(rt.length, 1, "exactly ONE mcp_resource tool");
  assert.equal(rt[0]!.name, "mcp_resource");
  // The resource tool is NOT per-server: it does not appear in the handle's
  // imported-tools list (that stays the server's own tools).
  assert.equal(handles[0]!.tools.length, 1, "the handle keeps only its imported tools");
  assert.equal(mcpStatusLine(handles[0]!), "fs — ready (1 tool)");
});

test("mcp_resource: two ready servers → STILL exactly ONE resource tool", async () => {
  const a = new MockMcpServer();
  modernMock(a, [{ name: "a" }]);
  const b = new MockMcpServer();
  modernMock(b, [{ name: "b" }]);
  const ga = mockSpawnFn(a);
  const gb = mockSpawnFn(b);
  const spawnFn: McpSpawnFn = async (cmd, args, o) =>
    cmd === "a" ? ga(cmd, args, o) : gb(cmd, args, o);
  const { handles, tools } = await startMcpServers(
    { a: srv({ command: "a" }), b: srv({ command: "b" }) },
    spawnFn,
    baseOpts,
  );
  assert.equal(handles.every((h) => h.state === "ready"), true);
  // 2 imported tools (a + b) + ONE mcp_resource (not two).
  assert.equal(tools.length, 3);
  const rt = resourceTools(tools);
  assert.equal(rt.length, 1, "still exactly ONE mcp_resource tool for two ready servers");
  assert.equal(rt[0]!.name, "mcp_resource");
});

test("mcp_resource: zero ready servers (all failed) → NO resource tool", async () => {
  // `bad` never answers the probe → startup timeout → failed.
  const bad = new MockMcpServer(); // no handler
  const { handles, tools } = await startMcpServers(
    { bad: srv({ command: "bad" }) },
    mockSpawnFn(bad),
    baseOpts,
  );
  assert.equal(handles[0]!.state, "failed");
  assert.equal(tools.length, 0, "no tools at all when no server is ready");
  assert.equal(resourceTools(tools).length, 0, "no mcp_resource tool");
});

test("mcp_resource: zero ready servers (all disabled) → NO resource tool", async () => {
  const g = mockSpawnFn(new MockMcpServer());
  const spawnFn: McpSpawnFn = async (cmd, args, o) => g(cmd, args, o);
  const { handles, tools } = await startMcpServers(
    { off: srv({ disabled: true }) },
    spawnFn,
    baseOpts,
  );
  assert.equal(handles[0]!.state, "disabled");
  assert.equal(tools.length, 0);
  assert.equal(resourceTools(tools).length, 0, "no mcp_resource tool");
});

// ── Audit regressions ─────────────────────────────────────────────────────

test("audit #1: kill() during an in-flight graceful teardown still SIGKILLs (backstop stays live)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock, [{ name: "ok" }]);
  let killCount = 0;
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((r) => (releaseClose = r));
  const base = mockSpawnFn(mock);
  const spawnFn: McpSpawnFn = async (cmd, args, o) => {
    const s = await base(cmd, args, o);
    return {
      ...s,
      close: () => closeGate, // a slow graceful escalation
      kill: () => {
        killCount++;
        mock.killed = true;
      },
    };
  };
  const { handles } = await startMcpServers({ fs: srv() }, spawnFn, baseOpts);
  const h = handles[0]!;
  const t = h.teardown(); // graceful — still awaiting the close gate
  h.kill(); // host exit during shutdown
  assert.equal(killCount, 1, "kill() is not gated on the in-flight teardown");
  assert.equal(mock.killed, true);
  releaseClose();
  await t;
});

test("audit #1: repeated teardown() calls share ONE promise (cached)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock, [{ name: "ok" }]);
  let closeCount = 0;
  const base = mockSpawnFn(mock);
  const spawnFn: McpSpawnFn = async (cmd, args, o) => {
    const s = await base(cmd, args, o);
    return {
      ...s,
      close: () => {
        closeCount++;
        return Promise.resolve();
      },
    };
  };
  const { handles } = await startMcpServers({ fs: srv() }, spawnFn, baseOpts);
  const h = handles[0]!;
  const a = h.teardown();
  const b = h.teardown();
  assert.equal(a, b, "the same in-flight teardown promise");
  await Promise.all([a, b]);
  // spawn.close is reached via the client's transport.close (1) and the
  // handle's own spawn.close (1) on the FIRST teardown only — a second
  // teardown() must not add any close call.
  const afterFirst = closeCount;
  await h.teardown();
  assert.equal(closeCount, afterFirst, "a repeat teardown() adds no close calls");
});

test("audit #2: /mcp reports a server that died after ready as FAILED (not the stale ready snapshot)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock, [{ name: "ok" }]);
  const { handles } = await startMcpServers({ fs: srv() }, mockSpawnFn(mock), baseOpts);
  const h = handles[0]!;
  assert.equal(h.state, "ready", "startup snapshot is ready");
  mock.closeStdout(); // transport dies after startup → client fail()
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.client!.getState().state, "failed");
  assert.match(mcpStatusLine(h), /^fs — failed \(/);
});

test("audit #2: a registry-level rejected import still reports failed", async () => {
  const mock = new MockMcpServer();
  modernMock(mock, [{ name: "tool", inputSchema: { type: "object" } }]);
  const { handles } = await startMcpServers(
    { fs: srv() },
    mockSpawnFn(mock),
    { ...baseOpts, builtinNames: [encodeMcpToolName("fs", "tool")] },
  );
  assert.match(mcpStatusLine(handles[0]!), /^fs — failed \(tool import rejected/);
});

test("mcp_resource: mixed (one ready, one failed) → exactly ONE resource tool", async () => {
  const good = new MockMcpServer();
  modernMock(good, [{ name: "ok" }]);
  const bad = new MockMcpServer(); // no handler → failed
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
  assert.equal(byName.get("good")!.state, "ready");
  assert.equal(byName.get("bad")!.state, "failed");
  // The good server's tool + ONE mcp_resource (the failed server contributes none).
  assert.equal(tools.length, 2);
  const rt = resourceTools(tools);
  assert.equal(rt.length, 1, "exactly ONE mcp_resource tool");
});

// ── Audit fix: spawns still in startup are reaped by reapPendingSpawns() ──
// A signal during startup (the spawn exists but no handle owns it yet) must
// still SIGKILL it. The spawn is registered as pending on creation and only
// leaves the set once a handle owns it.
test("reapPendingSpawns: a spawn mid-startup (no handle yet) is killed by the sync backstop", async () => {
  const mock = new MockMcpServer();
  // A probe that never answers → startup stays pending (the await is live).
  let killed = false;
  const hangingSpawn: McpSpawnFn = async () => ({
    child: { pid: undefined } as McpSpawn["child"],
    stdin: mock.stdin,
    stdout: mock.stdout,
    stderr: mock.stderr,
    close: async () => {},
    kill: () => {
      killed = true;
    },
    dispose: async () => {},
  });
  const pending = startMcpServers(
    { hang: { command: "x", args: [] } as unknown as McpServerConfig },
    hangingSpawn,
    { launchDir: "/tmp", workspace: "/tmp", extraRoots: [], parentEnv: {}, clientOpts: FAST },
  );
  // Let the spawn resolve and the client begin its probe.
  await new Promise((r) => setTimeout(r, 20));
  reapPendingSpawns();
  assert.equal(killed, true, "the in-startup spawn was SIGKILLed by the backstop");
  // Drain the startup (it fails on its own probe timeout) so the test ends clean.
  await pending.catch(() => {});
});

// ── Audit fix: multi-server startup window (finding 1) ─────────────────────
// Server A becomes ready while server B is still starting. A signal in that
// window must reap A too — it is no longer "pending" but is not yet in any
// published result either, so the backstop must still reach it.
test("reapPendingSpawns during a two-server startup reaps the already-READY sibling", async () => {
  const { reapPendingSpawns } = await import("../src/mcp/registry.js");
  const ready = new MockMcpServer();
  modernMock(ready, []);
  const hang = new MockMcpServer(); // never answers → startup stays in progress
  const killed: Record<string, boolean> = { ready: false, hang: false };
  const spawnFn: McpSpawnFn = async (command) => {
    const which = command === "ready" ? "ready" : "hang";
    const m = which === "ready" ? ready : hang;
    return {
      child: { pid: undefined } as McpSpawn["child"],
      stdin: m.stdin,
      stdout: m.stdout,
      stderr: m.stderr,
      close: async () => {},
      kill: () => {
        killed[which] = true;
      },
      dispose: async () => {},
    };
  };
  const starting = startMcpServers(
    {
      a: { command: "ready", args: [] } as unknown as McpServerConfig,
      b: { command: "hang", args: [] } as unknown as McpServerConfig,
    },
    spawnFn,
    { launchDir: "/tmp", workspace: "/tmp", extraRoots: [], parentEnv: {}, clientOpts: FAST },
  );
  // Let A finish startup (ready) while B is still probing.
  await new Promise((r) => setTimeout(r, 40));
  reapPendingSpawns();
  assert.equal(killed.ready, true, "the already-ready sibling was reaped");
  assert.equal(killed.hang, true, "the still-starting server was reaped");
  await starting.catch(() => {});
});

// ── Audit fix: a failed teardown is retryable (finding 3) ──────────────────
test("a failed teardown is retryable: the next teardownAll re-runs the close chain", async () => {
  const mock = new MockMcpServer();
  modernMock(mock, []);
  let closeCalls = 0;
  let fail = true;
  const spawnFn: McpSpawnFn = async () => ({
    child: { pid: undefined } as McpSpawn["child"],
    stdin: mock.stdin,
    stdout: mock.stdout,
    stderr: mock.stderr,
    close: async () => {
      closeCalls++;
      if (fail) throw new Error("group survived SIGKILL bound");
    },
    kill: () => {},
    dispose: async () => {},
  });
  const result = await startMcpServers(
    { s: { command: "x", args: [] } as unknown as McpServerConfig },
    spawnFn,
    { launchDir: "/tmp", workspace: "/tmp", extraRoots: [], parentEnv: {}, clientOpts: FAST },
  );
  await assert.rejects(teardownAll(result), /did not fully complete/);
  const afterFirst = closeCalls;
  assert.ok(afterFirst > 0, "the first attempt invoked the close chain");
  fail = false; // the group is gone on the retry
  await teardownAll(result); // must NOT replay the cached rejection
  assert.ok(closeCalls > afterFirst, "the retry re-invoked the close chain");
});

// ── Audit fix: a failed final teardown still gets the synchronous kill ─────
test("killAll after a failed teardown SIGKILLs the unconfirmed group", async () => {
  const mock = new MockMcpServer();
  modernMock(mock, []);
  let killed = false;
  const spawnFn: McpSpawnFn = async () => ({
    child: { pid: undefined } as McpSpawn["child"],
    stdin: mock.stdin,
    stdout: mock.stdout,
    stderr: mock.stderr,
    close: async () => {
      throw new Error("group survived SIGKILL bound");
    },
    kill: () => {
      killed = true;
    },
    dispose: async () => {},
  });
  const result = await startMcpServers(
    { s: { command: "x", args: [] } as unknown as McpServerConfig },
    spawnFn,
    { launchDir: "/tmp", workspace: "/tmp", extraRoots: [], parentEnv: {}, clientOpts: FAST },
  );
  await assert.rejects(teardownAll(result));
  killAll(result);
  assert.equal(killed, true, "the unconfirmed group received the synchronous SIGKILL");
});

// ── Audit fix: confirmed cleanup releases ownership (no stale re-kills) ───
// After a SUCCESSFUL startup the spawn leaves liveSpawns only when close()
// confirms the group is gone. A later backstop must not re-kill a cleaned
// spawn (a recycled group id could then hit an unrelated process).
test("a confirmed teardown unregisters the spawn (backstop does not re-kill it)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock, []);
  let kills = 0;
  const spawnFn: McpSpawnFn = async () => ({
    child: { pid: undefined } as McpSpawn["child"],
    stdin: mock.stdin,
    stdout: mock.stdout,
    stderr: mock.stderr,
    close: async () => {}, // resolves = group confirmed gone
    kill: () => {
      kills++;
    },
    dispose: async () => {},
  });
  const result = await startMcpServers(
    { s: { command: "x", args: [] } as unknown as McpServerConfig },
    spawnFn,
    { launchDir: "/tmp", workspace: "/tmp", extraRoots: [], parentEnv: {}, clientOpts: FAST },
  );
  await teardownAll(result); // confirmed
  const before = kills;
  reapPendingSpawns();
  assert.equal(kills, before, "a confirmed-clean spawn is NOT re-killed by the backstop");
});

// ── Audit fix: a FAILED startup stays registered until close() confirms ──
test("a failed startup whose cleanup unconfirmates stays registered for the backstop", async () => {
  const mock = new MockMcpServer(); // no handler → the probe times out → failed
  let kills = 0;
  let killCalls = 0;
  const spawnFn: McpSpawnFn = async () => ({
    child: { pid: undefined } as McpSpawn["child"],
    stdin: mock.stdin,
    stdout: mock.stdout,
    stderr: mock.stderr,
    close: async () => {
      throw new Error("group survived SIGKILL bound");
    },
    kill: () => {
      killCalls++;
      kills = killCalls;
    },
    dispose: async () => {},
  });
  const result = await startMcpServers(
    { s: { command: "x", args: [] } as unknown as McpServerConfig },
    spawnFn,
    { launchDir: "/tmp", workspace: "/tmp", extraRoots: [], parentEnv: {}, clientOpts: { probeTimeoutMs: 100, startupBudgetMs: 300, callTimeoutMs: 500, stallMs: 50 } },
  );
  assert.equal(result.handles[0]!.state, "failed");
  // The handle was created with alreadyTornDown=false (cleanup unconfirmed),
  // so teardown() re-runs the close chain — and still fails.
  await assert.rejects(teardownAll(result), /did not fully complete/);
  // The spawn is STILL registered: a later backstop can re-kill it.
  const before = kills;
  reapPendingSpawns();
  assert.equal(kills, before + 1, "the unconfirmed spawn remains reachable by the backstop");
});
