/**
 * Timeout/abort KILL contract (2026-09-21 incident):
 *
 * Killing only the shell wrapper left pipeline children (sleep, grep, ...)
 * running as orphans. An orphan holding the stdout pipe means the child's
 * `close` event never fires, so the tool promise never settles and the
 * agent loop hangs forever (proven: `sleep 30 | cat`, SIGKILL the /bin/sh
 * at 1s — `close` did not fire within 8s).
 *
 * The fix: spawn detached (own process group) + SIGKILL the whole group,
 * with a force-settle backstop. These tests pin the user-visible contract:
 *   - a timeout/abort settles the promise promptly (not at the command's
 *     own completion time),
 *   - the whole command tree is actually killed (no orphans),
 *   - normal completion is unaffected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "../src/tools/bash.js";
import { bashSandboxAvailable } from "../src/tools/sandbox.js";

/** A duration no other test on this machine will use. */
const SLEEP = 55;

/** Is anything matching the marker command still alive? */
function orphansAlive(marker: string): string {
  const r = spawnSync("pgrep", ["-fl", marker], { encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

/** Temp workspace the tool pins as cwd. */
async function ws(t: { after: (fn: () => void | Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bash-kill-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const sig = () => new AbortController().signal;
const text = (r: { content: { type: string; text: string }[] }) =>
  r.content.map((c) => c.text).join(" ");

test("timeout kills the whole pipeline: prompt settle, no orphans (unsandboxed)", async (t) => {
  const dir = await ws(t);
  const tool = createBashTool(dir, { sandbox: false });
  const marker = `sleep ${SLEEP}`;
  const t0 = Date.now();
  const r = await tool.execute("t1", { command: `${marker} | cat`, timeout: 1 }, sig());
  const ms = Date.now() - t0;
  assert.equal(r.isError, true);
  assert.match(text(r), /timed out after 1s/);
  assert.ok(ms < 10_000, `promise must settle promptly, took ${ms}ms`);
  await new Promise((res) => setTimeout(res, 300)); // let any orphan register
  if (process.platform !== "win32") {
    assert.equal(orphansAlive(marker), "", "pipeline children must be killed, not orphaned");
  }
});

test("timeout kills the whole pipeline: sandboxed child (darwin)", async (t) => {
  if (!bashSandboxAvailable()) {
    t.skip("kernel sandbox unavailable on this platform");
    return;
  }
  const dir = await ws(t);
  const tool = createBashTool(dir); // sandbox on by default on darwin
  const marker = `sleep ${SLEEP}`;
  const t0 = Date.now();
  const r = await tool.execute("t2", { command: `${marker} | cat`, timeout: 1 }, sig());
  const ms = Date.now() - t0;
  assert.equal(r.isError, true);
  assert.match(text(r), /timed out after 1s/);
  assert.ok(ms < 10_000, `promise must settle promptly, took ${ms}ms`);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(orphansAlive(marker), "", "sandboxed pipeline children must be killed, not orphaned");
});

test("abort kills the whole pipeline: prompt settle, no orphans", async (t) => {
  const dir = await ws(t);
  const tool = createBashTool(dir, { sandbox: false });
  const marker = `sleep ${SLEEP}`;
  const ac = new AbortController();
  const p = tool.execute("t3", { command: `${marker} | cat`, timeout: 60 }, ac.signal);
  setTimeout(() => ac.abort(), 300);
  const t0 = Date.now();
  const r = await p;
  const ms = Date.now() - t0;
  assert.equal(r.isError, true);
  assert.match(text(r), /aborted/);
  assert.ok(ms < 10_000, `promise must settle promptly, took ${ms}ms`);
  await new Promise((res) => setTimeout(res, 300));
  if (process.platform !== "win32") {
    assert.equal(orphansAlive(marker), "", "pipeline children must be killed, not orphaned");
  }
});

test("normal completion is unaffected by the group-kill wiring", async (t) => {
  const dir = await ws(t);
  const tool = createBashTool(dir, { sandbox: false });
  const ok = await tool.execute("t4", { command: "echo hello" }, sig());
  assert.ok(!ok.isError);
  assert.match(text(ok), /hello/);
  const bad = await tool.execute("t5", { command: "echo oops; exit 3" }, sig());
  assert.equal(bad.isError, true);
  assert.match(text(bad), /exit code 3/);
  assert.match(text(bad), /oops/);
});
