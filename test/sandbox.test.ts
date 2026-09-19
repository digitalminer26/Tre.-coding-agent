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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  generateBashSandboxPolicy,
  sandboxExecPath,
  sandboxShell,
  seString,
} from "../src/tools/sandbox.js";

test("seString escapes backslashes and quotes", () => {
  assert.equal(seString("/tmp/a"), "/tmp/a");
  assert.equal(seString('/tmp/a"b'), '/tmp/a\\"b');
  assert.equal(seString("/tmp/a\\b"), "/tmp/a\\\\b");
});

test("policy: read denies (real-path top-levels + node denies)", () => {
  const p = generateBashSandboxPolicy("/tmp/ws");
  for (const target of [
    "/private", // real paths of /tmp, /var, /etc (data access is checked resolved)
    "/System/Volumes/Data/home", // real target of the /home symlink
    "/cores",
    "/Library/Keychains",
    "/System/Volumes/Data/Library/Keychains", // real spelling
    "/System/Volumes/Preboot",
    "/Users",
    "/Volumes",
    "/Network",
  ]) {
    assert.ok(
      p.includes(`(deny file-read* (subpath "${target}"))`),
      `missing read deny for ${target}`,
    );
  }
  for (const target of ["/etc", "/home"]) {
    assert.ok(
      p.includes(`(deny file-read* (literal "${target}"))`),
      `missing read NODE deny for symlinked top ${target}`,
    );
  }
  // SYMLINKED tops must NOT get subpath denies — a subpath deny of /tmp,
  // /var or /etc is fatal for a workspace under it (no re-allow survives).
  for (const target of ["/tmp", "/var"]) {
    assert.ok(
      !p.includes(`(deny file-read* (subpath "${target}"))`),
      `subpath read deny for symlinked top ${target} would be fatal for a workspace under it`,
    );
  }
  for (const target of [
    "/private/var/folders", // per-user temp (tool runtimes)
    "/private/var/select", // /bin/sh startup probe (keeps stderr quiet)
  ]) {
    assert.ok(
      p.includes(`(allow file-read* (subpath "${target}"))`),
      `missing read re-allow for ${target}`,
    );
  }
});

test("policy: denies system surfaces (writes) + /dev with re-allow", () => {
  const p = generateBashSandboxPolicy("/tmp/ws");
  for (const target of [
    "/private",
    "/System/Volumes/Data/home",
    "/usr",
    "/bin",
    "/sbin",
    "/System",
    "/Library",
    "/cores",
    "/dev",
    "/Users",
    "/Volumes",
    "/Network",
  ]) {
    assert.ok(
      p.includes(`(deny file-write* (subpath "${target}"))`),
      `missing write deny for ${target}`,
    );
  }
  for (const target of ["/private/var/folders", "/dev/null", "/dev/stdout", "/dev/stderr"]) {
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

test("policy: a /tmp workspace escapes the /private denies (re-allow AFTER the deny)", () => {
  // the e2e shape: cwd under /tmp (real path /private/tmp) — the workspace
  // re-allow must come after the /private deny for both reads and writes
  const p = generateBashSandboxPolicy("/tmp/e2e-XXX/10");
  const denyR = p.indexOf('(deny file-read* (subpath "/private"))');
  const allowR = p.indexOf('(allow file-read* (subpath "/tmp/e2e-XXX/10"))');
  assert.ok(denyR >= 0 && allowR > denyR, "read: workspace re-allow after /private deny");
  const denyW = p.indexOf('(deny file-write* (subpath "/private"))');
  const allowW = p.indexOf('(allow file-write* (subpath "/tmp/e2e-XXX/10"))');
  assert.ok(allowW > denyW, "write: workspace re-allow after /private deny");
});

test("policy: a /Users workspace escapes the /Users deny (real-path workspace)", () => {
  // the real-world shape: /Users is a REAL directory (no symlink), so a
  // plain subpath deny + a later subpath re-allow is safe and effective
  const p = generateBashSandboxPolicy("/Users/u/proj");
  const denyR = p.indexOf('(deny file-read* (subpath "/Users"))');
  const allowR = p.indexOf('(allow file-read* (subpath "/Users/u/proj"))');
  assert.ok(denyR >= 0 && allowR > denyR, "read: workspace re-allow after /Users deny");
});

test("policy: workspace path is S-expression-escaped", () => {
  const p = generateBashSandboxPolicy('/tmp/we"ird');
  assert.ok(p.includes('"/tmp/we\\"ird"'), "quotes in the path are escaped");
});

test("policy: the workspace re-allow uses the REAL path (resolved, not literal)", () => {
  // data access is checked against the resolved path — a /tmp/… workspace
  // (real: /private/tmp/…) must be re-allowed in its REAL spelling, else the
  // re-allow matches nothing and the workspace is locked out
  const ws = mkdtempSync(path.join(tmpdir(), "sb-real-"));
  try {
    const real = realpathSync(ws);
    const p = generateBashSandboxPolicy(ws);
    assert.ok(
      p.includes(`(allow file-read* (subpath "${real}"))`),
      `workspace re-allow must use the real path ${real}`,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
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
      const out = execFileSync(sandboxExec, ["-f", policyPath, sandboxShell(), "-c", cmd], {
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

      // 2026-09-18 (s10 canary): the OLD denylist left /tmp readable — a file
      // OUTSIDE the workspace but under /private/tmp was readable. The
      // top-level /private deny must close that for reads AND writes.
      const tmpSibling = "/tmp/sb-canary-" + Date.now() + ".txt";
      writeFileSync(tmpSibling, "sibling-secret\n");
      try {
        const siblingRead = runSandboxed(policy, `cat ${tmpSibling}`, ws);
        assert.ok(!siblingRead.ok, "reading a /tmp file outside the workspace must FAIL");
        assert.ok(
          !siblingRead.out.includes("sibling-secret"),
          "the sibling content must not appear",
        );
        const siblingReadReal = runSandboxed(policy, `cat /private${tmpSibling}`, ws);
        assert.ok(
          !siblingReadReal.out.includes("sibling-secret"),
          "the REAL-path spelling must be denied too",
        );
        const siblingWrite = runSandboxed(policy, `echo x >> ${tmpSibling}`, ws);
        assert.ok(!siblingWrite.ok, "writing a /tmp file outside the workspace must FAIL");
        const siblingWriteReal = runSandboxed(policy, `echo x >> /private${tmpSibling}`, ws);
        assert.ok(!siblingWriteReal.ok, "writing via the REAL-path spelling must FAIL");
        assert.ok(
          !existsSync(tmpSibling) || readFileSync(tmpSibling, "utf8").trim() === "sibling-secret",
          "the sibling file must be unchanged",
        );

        // per-user temp stays usable (v1 boundary: tool runtimes need it)
        const perUserFile = path.join(tmpdir(), `sb-peruser-${Date.now()}.txt`);
        writeFileSync(perUserFile, "peruser-ok\n");
        try {
          const perUser = runSandboxed(policy, `cat "${perUserFile}"`, ws);
          assert.ok(perUser.ok, "reading per-user temp (/private/var/folders) must succeed");
          assert.match(perUser.out, /peruser-ok/);
        } finally {
          rmSync(perUserFile, { force: true });
        }

        // 2026-09-18: the sandboxed child runs /bin/bash (when present) so
        // that `cd` works — /bin/sh's cd fails with ENOTDIR under a deny
        // policy. cd INSIDE the workspace must work (relative + absolute);
        // file ops after `cd ..` OUTSIDE it must still be denied (the
        // chdir escape is inert).
        assert.equal(sandboxShell(), "/bin/bash", "this probe expects /bin/bash");
        const sub = path.join(ws, "sub");
        mkdirSync(sub);
        const cdSub = runSandboxed(policy, "cd sub && pwd", ws);
        assert.ok(cdSub.ok, `cd into a workspace subdir must work: ${cdSub.out}`);
        const cdReal = runSandboxed(policy, `cd "${realpathSync(ws)}" && pwd`, ws);
        assert.ok(cdReal.ok, `cd to the workspace via REAL path must work: ${cdReal.out}`);
        // chdir escape must be inert: cd to a CONFINED top-level (/tmp —
        // note: cd .. stays inside the /var/folders re-allow when the
        // workspace is under $TMPDIR, which is the documented v1 boundary)
        const escFile = "/tmp/sb-esc-" + Date.now() + ".txt";
        const escapeWrite = runSandboxed(policy, `cd /tmp && echo pwned > ${escFile}`, ws);
        assert.ok(!escapeWrite.ok, "a write after cd /tmp (outside the workspace) must FAIL");
        assert.ok(
          !existsSync(escFile),
          "the escape file must not exist",
        );
        rmSync(escFile, { force: true });
      } finally {
        rmSync(tmpSibling, { force: true });
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  },
);
