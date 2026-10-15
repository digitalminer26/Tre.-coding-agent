/**
 * MCP stdio bridge tests (scope: docs/10-mcp-scope.md §4.1/§4.4).
 *
 * Tests the UNSANDBOXED spawn path + the process-group teardown mechanics
 * (the bash.ts pattern): persistent stdin/stdout pipes, graceful close
 * (stdin EOF → exit), and immediate kill (SIGKILL the group). The sandbox
 * wrappers (darwin Seatbelt / linux bwrap) are platform/binary-dependent and
 * covered by the fail-closed contract, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnMcpServer, type McpSpawn } from "../src/mcp/spawn.js";

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

/** Wait until the child has exited (exitCode or signalCode is set). */
async function waitForExit(spawn: McpSpawn, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (spawn.child.exitCode === null && spawn.child.signalCode === null) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("child did not exit within " + timeoutMs + "ms");
    }
    await tick(20);
  }
}

const baseOpts = {
  cwd: process.cwd(),
  workspace: process.cwd(),
  inheritedSandbox: false,
};

test("unsandboxed spawn: persistent stdin/stdout pipes carry data", async () => {
  const spawn = await spawnMcpServer("cat", [], {
    ...baseOpts,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    sandbox: false,
  });
  assert.ok(spawn.child.pid, "the child has a pid");
  // `cat` echoes stdin → stdout. Write a line, read it back.
  const out: string[] = [];
  spawn.stdout.on("data", (c: Buffer | string) => out.push(c.toString("utf8")));
  spawn.stdin.write("hello-mcp\n");
  await tick(120);
  assert.ok(
    out.join("").includes("hello-mcp"),
    "stdout carries the echoed input: " + JSON.stringify(out.join("")),
  );
  // Graceful teardown: close stdin → cat exits on EOF.
  await spawn.close();
  await waitForExit(spawn);
  await spawn.dispose();
});

test("immediate kill: SIGKILL the process group (a child that ignores stdin EOF)", async () => {
  // A node process that stays alive regardless of stdin (it never reads it).
  const spawn = await spawnMcpServer(
    "node",
    ["-e", "setInterval(()=>{},1000)"],
    { ...baseOpts, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, sandbox: false },
  );
  const pid = spawn.child.pid;
  assert.ok(pid, "the child has a pid");
  // Let it start.
  await tick(80);
  // It is still alive before the kill.
  assert.equal(spawn.child.exitCode, null, "alive before kill");
  // Immediate kill (SIGKILL the group). Synchronous.
  spawn.kill();
  await waitForExit(spawn);
  // The child is dead (killed by a signal, or exited).
  assert.ok(
    spawn.child.exitCode !== null || spawn.child.signalCode !== null,
    "the child exited after kill",
  );
  await spawn.dispose();
});

test("close is idempotent and kill is idempotent (no throw on repeat)", async () => {
  const spawn = await spawnMcpServer(
    "node",
    ["-e", "setInterval(()=>{},1000)"],
    { ...baseOpts, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, sandbox: false },
  );
  await tick(80);
  // kill() twice — the second is a no-op (group already gone).
  spawn.kill();
  spawn.kill();
  await waitForExit(spawn);
  // close() after a kill — must not throw (the child is already dead).
  await spawn.close();
  await spawn.dispose();
  await spawn.dispose(); // dispose is idempotent too.
});
