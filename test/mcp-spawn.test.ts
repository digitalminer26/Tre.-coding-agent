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
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ── Spawn-level error guard (the unhandled 'error' ENOENT crash) ──────────

test("a missing executable rejects the spawn (no unhandled 'error' event, no crash)", async () => {
  // regression: spawnMcpServer used to resolve immediately and the child's
  // 'error' event (ENOENT) fired UNHANDLED — crashing the whole tre. host.
  await assert.rejects(
    spawnMcpServer("/definitely-missing-mcp-executable", [], {
      ...baseOpts,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      sandbox: false,
    }),
    /ENOENT/,
  );
});

test("a real non-executable file rejects the spawn with EACCES", async () => {
  // A regular file WITHOUT the execute bit: the kernel refuses exec → EACCES.
  const dir = await mkdtemp(join(tmpdir(), "mcp-eacces-"));
  const file = join(dir, "not-executable");
  await writeFile(file, "#!/bin/sh\necho hi\n", { mode: 0o644 });
  try {
    await assert.rejects(
      spawnMcpServer(file, [], {
        ...baseOpts,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        sandbox: false,
      }),
      (err: NodeJS.ErrnoException) => err.code === "EACCES",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("graceful close is AWAITABLE and observable: resolves only after the child is gone", async () => {
  // A server that exits promptly on stdin EOF (like a well-behaved MCP
  // stdio server): the close chain must resolve AFTER the child exited —
  // the registry awaits this before disposing sandbox resources.
  const spawn = await spawnMcpServer("cat", [], {
    ...baseOpts,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    sandbox: false,
  });
  await spawn.close(); // EOF → cat exits on its own (no escalation needed)
  // NO extra wait: the child must already be gone when close() resolves.
  assert.ok(
    spawn.child.exitCode !== null || spawn.child.signalCode !== null,
    "the child is gone by the time close() resolved",
  );
  await spawn.dispose();
});

test("audit #3: close() resolves only AFTER the escalated child exited (asserted at resolution, no extra wait)", async () => {
  const spawn = await spawnMcpServer(
    "node",
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { ...baseOpts, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, sandbox: false },
  );
  await spawn.close();
  assert.equal(spawn.child.signalCode, "SIGKILL", "dead at close() resolution");
  await spawn.dispose();
});

test("graceful close escalates to SIGKILL for a child that ignores stdin EOF + SIGTERM", async () => {
  // 103s > the 2+2s escalation — the chain must END with the child dead.
  const spawn = await spawnMcpServer(
    "node",
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { ...baseOpts, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, sandbox: false },
  );
  await spawn.close();
  // NO extra wait: the escalation's SIGKILL + bounded exit-wait must have
  // completed before close() resolved — the child is dead right now.
  assert.equal(
    spawn.child.signalCode,
    "SIGKILL",
    "the escalation ended with SIGKILL, observed at close() resolution",
  );
  await spawn.dispose();
});

test("audit #1: a descendant that outlives the leader is reaped by close() (group-wide confirmation)", async () => {
  // The leader spawns a SAME-GROUP descendant (not detached) that ignores
  // stdin EOF AND SIGTERM, then exits on stdin EOF. The descendant outlives
  // the leader — the audit's leak (the old close() resolved on the leader's
  // exit, leaving the descendant alive). close() must escalate on GROUP
  // liveness (SIGTERM → SIGKILL) and CONFIRM the whole group is gone before
  // resolving.
  const leaderCode = [
    "const {spawn}=require('node:child_process');",
    "const d=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});",
    "process.stdout.write('DESC:'+d.pid+'\\n');",
    "process.stdin.resume();",
    "process.stdin.on('end',()=>process.exit(0));",
  ].join("\n");
  const spawn = await spawnMcpServer(process.execPath, ["-e", leaderCode], {
    ...baseOpts,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    sandbox: false,
  });
  // Capture the descendant's pid from the leader's stdout.
  let descPid = 0;
  let outBuf = "";
  await new Promise<void>((resolve) => {
    const onData = (c: Buffer | string): void => {
      outBuf += c.toString("utf8");
      const m = outBuf.match(/DESC:(\d+)/);
      if (m) {
        descPid = Number(m[1]);
        spawn.stdout.off("data", onData);
        resolve();
      }
    };
    spawn.stdout.on("data", onData);
    setTimeout(resolve, 3000);
  });
  assert.ok(descPid > 0, "captured the descendant pid");
  assert.doesNotThrow(() => process.kill(descPid, 0), "descendant alive before close");
  // close() must reap the WHOLE group (the descendant outlives the leader).
  await spawn.close();
  // The descendant must be GONE when close() resolves (group-wide
  // confirmation — the regression the old leader-only exit check missed).
  assert.throws(
    () => process.kill(descPid, 0),
    "the outliving descendant is reaped by close()",
  );
  await spawn.dispose();
});

test("repeated close() calls share ONE chain (no double escalation)", async () => {
  const spawn = await spawnMcpServer("cat", [], {
    ...baseOpts,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    sandbox: false,
  });
  const [a, b] = [spawn.close(), spawn.close()];
  assert.equal(a, b, "the second close returns the first's in-flight chain");
  await a;
  await spawn.dispose();
});
