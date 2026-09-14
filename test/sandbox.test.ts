/**
 * WS11 — bash kernel sandbox (macOS Seatbelt).
 *
 * Pure: policy generation (S-expression shape, denylist coverage, escaping).
 * OS probe (darwin only, offline): the GENERATED policy really confines a
 * bash child — /etc unreadable, workspace read/write works, /etc unwritable.
 * This is a kernel-level test; no LLM, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  generateBashSandboxPolicy,
  sandboxExecPath,
  seString,
} from "../src/tools/sandbox.js";

test("seString escapes backslashes and quotes", () => {
  assert.equal(seString("/tmp/a"), "/tmp/a");
  assert.equal(seString('/tmp/a"b'), '/tmp/a\\"b');
  assert.equal(seString("/tmp/a\\b"), "/tmp/a\\\\b");
});

test("policy: denies the secret surfaces (reads)", () => {
  const p = generateBashSandboxPolicy("/tmp/ws");
  for (const target of [
    "/etc",
    "/private/etc",
    "/var/root",
    "/private/var/root",
    "/private/var/db",
    "/cores",
    "/Library/Keychains",
    "/System/Volumes/Preboot",
    "/Users",
  ]) {
    assert.ok(
      p.includes(`(deny file-read* (subpath "${target}"))`),
      `missing read deny for ${target}`,
    );
  }
});

test("policy: denies system surfaces (writes) + /dev with re-allow", () => {
  const p = generateBashSandboxPolicy("/tmp/ws");
  for (const target of [
    "/etc",
    "/private/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/System",
    "/Library",
    "/var/root",
    "/private/var/root",
    "/cores",
    "/dev",
    "/Users",
  ]) {
    assert.ok(
      p.includes(`(deny file-write* (subpath "${target}"))`),
      `missing write deny for ${target}`,
    );
  }
  for (const target of ["/dev/null", "/dev/stdout", "/dev/stderr"]) {
    assert.ok(
      p.includes(`(allow file-write* (subpath "${target}"))`),
      `missing write re-allow for ${target}`,
    );
  }
});

test("policy: workspace escapes the /Users denies (allow comes AFTER deny — last match wins)", () => {
  const p = generateBashSandboxPolicy("/Users/u/proj");
  const denyIdx = p.indexOf('(deny file-read* (subpath "/Users"))');
  const allowIdx = p.indexOf('(allow file-read* (subpath "/Users/u/proj"))');
  assert.ok(denyIdx >= 0, "has the /Users read deny");
  assert.ok(allowIdx >= 0, "has the workspace read re-allow");
  assert.ok(allowIdx > denyIdx, "the re-allow must come after the deny");
  const denyW = p.indexOf('(deny file-write* (subpath "/Users"))');
  const allowW = p.indexOf('(allow file-write* (subpath "/Users/u/proj"))');
  assert.ok(allowW > denyW, "write re-allow must come after the write deny");
});

test("policy: workspace path is S-expression-escaped", () => {
  const p = generateBashSandboxPolicy('/tmp/we"ird');
  assert.ok(p.includes('"/tmp/we\\"ird"'), "quotes in the path are escaped");
});

/** Run `cmd` under the generated policy with cwd = the workspace (the
 * product spawns the child with cwd = workspace; running from a cwd that is
 * DENIED by the policy makes the shell's getcwd fail and pollutes stderr).
 * Returns { ok, out }. */
function runSandboxed(policy: string, cmd: string, cwd: string): { ok: boolean; out: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-test-"));
  try {
    const policyPath = path.join(dir, "p.sb");
    writeFileSync(policyPath, policy, { mode: 0o600 });
    const sandboxExec = sandboxExecPath();
    if (!sandboxExec) throw new Error("sandbox-exec not found");
    try {
      const out = execFileSync(sandboxExec, ["-f", policyPath, "/bin/sh", "-c", cmd], {
        encoding: "utf8",
        timeout: 30_000,
        cwd,
      });
      return { ok: true, out };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "OS probe (darwin): generated policy confines the bash child",
  { skip: process.platform !== "darwin", timeout: 60_000 },
  () => {
    const ws = mkdtempSync(path.join(tmpdir(), "sb-ws-"));
    try {
      const inFile = path.join(ws, "in.txt");
      writeFileSync(inFile, "workspace-data\n");
      const policy = generateBashSandboxPolicy(ws);

      const secret = runSandboxed(policy, "cat /etc/passwd", ws);
      assert.ok(!secret.ok, "reading /etc/passwd must FAIL");
      assert.match(
        secret.out,
        /Operation not permitted|No such file/,
        `unexpected output: ${secret.out}`,
      );

      const lsEtc = runSandboxed(policy, "ls /etc", ws);
      assert.ok(!lsEtc.ok, "even metadata (ls /etc) must be denied");

      const wsRead = runSandboxed(policy, `cat "${inFile}"`, ws);
      assert.ok(wsRead.ok, "reading a workspace file must succeed");
      assert.match(wsRead.out, /workspace-data/);

      const outFile = path.join(ws, "out.txt");
      const wsWrite = runSandboxed(policy, `echo x > "${outFile}"`, ws);
      assert.ok(wsWrite.ok, "writing in the workspace must succeed");

      const sysWrite = runSandboxed(policy, "echo x > /etc/sb-probe-evil", ws);
      assert.ok(!sysWrite.ok, "writing to /etc must FAIL");

      const devFake = runSandboxed(policy, "echo x > /dev/null", ws);
      assert.ok(devFake.ok, "writing /dev/null must succeed");

      const child = runSandboxed(policy, "sh -c 'cat /etc/hostname 2>&1'", ws);
      assert.ok(!child.ok, "sandbox must propagate to the shell's children");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  },
);
