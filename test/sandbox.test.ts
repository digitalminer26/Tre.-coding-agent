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
  ancestorMetadataRules,
  generateBashSandboxPolicy,
  sandboxExecPath,
  sandboxShell,
  seString,
  tmpdirRealPath,
  spawnSandboxedBash,
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

test("ancestorMetadataRules: walks parents up to (excluding) /, nothing for top-level", () => {
  assert.deepEqual(ancestorMetadataRules("/a/b/c"), [
    '(allow file-read-metadata (literal "/a/b"))',
    '(allow file-read-metadata (literal "/a"))',
  ]);
  assert.deepEqual(ancestorMetadataRules("/a"), []);
  assert.deepEqual(ancestorMetadataRules('/a/b"c'), [
    '(allow file-read-metadata (literal "/a"))', // b"c is a FILE name; /a is its parent
  ]);
  assert.deepEqual(ancestorMetadataRules('/a/b"c/c'), [
    '(allow file-read-metadata (literal "/a/b\\"c"))', // quote in an ancestor is escaped
    '(allow file-read-metadata (literal "/a"))',
  ]);
});

test("policy: ancestor metadata re-allows (workspace + tmp chains) + xcode link literal", () => {
  const p = generateBashSandboxPolicy("/Users/u/proj");
  // the workspace's ancestor NODES — the prefixes node's realpathSync
  // walk-down lstats on its way to the allowed leaf (2026-09-19 fix)
  for (const anc of ["/Users/u", "/Users"]) {
    assert.ok(
      p.includes(`(allow file-read-metadata (literal "${anc}"))`),
      `missing ancestor metadata re-allow for ${anc}`,
    );
  }
  // the per-user tmp chain too (npm/tsc/child processes touch $TMPDIR even
  // when the workspace is elsewhere)
  let cur = path.dirname(tmpdirRealPath());
  while (cur.length > 1 && cur !== "/") {
    assert.ok(
      p.includes(`(allow file-read-metadata (literal "${seString(cur)}"))`),
      `missing tmp-chain metadata re-allow for ${cur}`,
    );
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // the metadata rules come BEFORE the workspace's read allow — the
  // workspace re-allow stays the LAST matching read rule
  const firstMeta = p.indexOf("(allow file-read-metadata ");
  const lastReadAllow = p.lastIndexOf("(allow file-read* (subpath ");
  assert.ok(firstMeta >= 0, "has metadata re-allows");
  assert.ok(firstMeta < lastReadAllow, "workspace read allow stays last");
  // the xcode-select shim's single-file literal (git under the sandbox)
  assert.ok(
    p.includes('(allow file-read* (literal "/private/var/db/xcode_select_link"))'),
    "xcode_select_link literal present",
  );
});

test(
  "spawnSandboxedBash sets GIT_CONFIG_NOSYSTEM=1 (explicit caller value wins)",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "sb-env-"));
    try {
      async function probe(env: NodeJS.ProcessEnv): Promise<string> {
        const { child, dispose } = await spawnSandboxedBash("echo $GIT_CONFIG_NOSYSTEM", {
          cwd: ws,
          env,
        });
        let out = "";
        if (child.stdout) child.stdout.on("data", (d: Buffer) => (out += d));
        await new Promise<void>((res) => child.on("close", () => res()));
        await dispose();
        return out.trim();
      }
      assert.equal(await probe({ ...process.env }), "1", "unset → 1");
      assert.equal(
        await probe({ ...process.env, GIT_CONFIG_NOSYSTEM: "0" }),
        "0",
        "explicit caller value wins",
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  },
);

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

test("policy: C35 extra roots — same mechanism as the workspace, emitted before it", () => {
  const base = mkdtempSync(path.join(tmpdir(), "sb-extra-"));
  try {
    const ws = path.join(base, "ws");
    const er = path.join(base, "extra");
    const sibling = path.join(base, "sibling");
    mkdirSync(ws);
    mkdirSync(er);
    mkdirSync(sibling);
    const wsReal = realpathSync(ws);
    const erReal = realpathSync(er);
    const p = generateBashSandboxPolicy(ws, [er]);

    // Each extra root gets a read AND a write subpath allow (REAL path).
    assert.ok(
      p.includes(`(allow file-read* (subpath "${erReal}"))`),
      "extra root must get a read subpath allow (real path)",
    );
    assert.ok(
      p.includes(`(allow file-write* (subpath "${erReal}"))`),
      "extra root must get a write subpath allow (real path)",
    );
    // The workspace keeps its own allows.
    assert.ok(p.includes(`(allow file-read* (subpath "${wsReal}"))`));
    assert.ok(p.includes(`(allow file-write* (subpath "${wsReal}"))`));
    // Ordering: the extra-root rules come BEFORE the workspace rules, so the
    // workspace stays the LAST matching read/write subpath rule (last-match-
    // wins). The sibling is never re-allowed.
    assert.ok(
      p.indexOf(`(allow file-read* (subpath "${erReal}"))`) <
        p.indexOf(`(allow file-read* (subpath "${wsReal}"))`),
      "extra-root read allow must precede the workspace read allow",
    );
    assert.ok(
      p.indexOf(`(allow file-write* (subpath "${erReal}"))`) <
        p.indexOf(`(allow file-write* (subpath "${wsReal}"))`),
      "extra-root write allow must precede the workspace write allow",
    );
    assert.ok(
      !p.includes(`(subpath "${realpathSync(sibling)}")`),
      "a sibling of the extra root must NOT be re-allowed",
    );
    // The extra root's ancestor chain gets metadata-only re-allows (node's
    // realpathSync walk-down must survive the enumeration denies).
    for (const r of ancestorMetadataRules(erReal)) {
      assert.ok(p.includes(r), `missing ancestor metadata rule ${r}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("policy: C35 no extra roots → byte-identical to the single-root policy (regression pin)", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "sb-extra-pin-"));
  try {
    assert.equal(
      generateBashSandboxPolicy(ws),
      generateBashSandboxPolicy(ws, []),
      "an empty extraRoots list must not change the policy",
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
  {
    skip:
      process.platform !== "darwin"
        ? true
        : process.env.TRE_SANDBOX === "1"
          ? "under an inherited kernel sandbox — nested sandbox_apply is EPERM (rc 71); the kernel probe needs a fresh process (run npm test outside a sandboxed shell)"
          : false,
    timeout: 60_000,
  },
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

        // 2026-09-19 (broken-loop canary): node's realpathSync walk-down —
        // lstat of every prefix from / — must survive the enumeration
        // denies. The ancestor nodes got metadata-only re-allows; without
        // them `node <workspace-file>` crashed with EPERM lstat '/Users' (or
        // '/private' for $TMPDIR workspaces) and tsc, node --test and npm
        // were all dead under the sandbox.
        const nodeProbeFile = path.join(ws, "probe.js");
        writeFileSync(nodeProbeFile, 'console.log("node-ran")\n');
        const nodeRun = runSandboxed(policy, `node "${nodeProbeFile}"`, ws);
        assert.ok(
          nodeRun.ok,
          `running a node FILE under the workspace must succeed: ${nodeRun.out}`,
        );
        assert.match(nodeRun.out, /node-ran/);

        // PTY machinery: `script` needs openpty() (/dev/ptmx + the allocated
        // /dev/ttysNN slave) — without the write-allows every TUI scenario
        // and the skill's TUI-verification recipe died at startup under an
        // inherited sandbox ("openpty: Operation not permitted").
        const ptyRound = runSandboxed(
          policy,
          "(sleep 0.2; printf 'pty-ok\\r') | script -q /dev/null /bin/cat 2>&1 | head -1",
          ws,
        );
        assert.ok(
          ptyRound.ok,
          `script/openpty under the policy must succeed: ${ptyRound.out}`,
        );
        assert.match(ptyRound.out, /pty-ok/);
        // ...but no NEW device nodes can be created in /dev (write-deny holds)
        const devCreate = runSandboxed(policy, "touch /dev/sb-evil-node", ws);
        assert.ok(!devCreate.ok, "creating a file in /dev must still be denied");
        // ...and the metadata re-allow must not open DATA: listing /Users
        // (readdir = file-read-data) is still denied.
        const lsUsers = runSandboxed(policy, "ls /Users", ws);
        assert.ok(!lsUsers.ok, "ls /Users (directory data) must still be denied");
        // the xcode-select link literal is readable (the /usr/bin/git shim
        // needs it), but the surrounding dir is not listable — no traversal.
        if (existsSync("/private/var/db/xcode_select_link")) {
          // readlink, not cat: the shim reads the LINK's target (metadata);
          // cat would follow it into the (separately governed) Xcode/CLT dir.
          const xcodeRead = runSandboxed(policy, "readlink /private/var/db/xcode_select_link", ws);
          assert.ok(xcodeRead.ok, "readlink of xcode_select_link must succeed (git shim)");
          assert.match(xcodeRead.out, /Xcode|CommandLineTools/);
        }
        const xcodeList = runSandboxed(policy, "ls /private/var/db", ws);
        assert.ok(!xcodeList.ok, "ls of the dir containing the link must still be denied");

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

test(
  "OS probe (darwin): C35 extra root is readable+writable, its sibling is NOT",
  {
    skip:
      process.platform !== "darwin"
        ? true
        : process.env.TRE_SANDBOX === "1"
          ? "under an inherited kernel sandbox — nested sandbox_apply is EPERM (rc 71); the kernel probe needs a fresh process (run npm test outside a sandboxed shell)"
          : false,
    timeout: 60_000,
  },
  () => {
    const base = mkdtempSync(path.join(tmpdir(), "sb-c35-"));
    try {
      const ws = path.join(base, "ws");
      const er = path.join(base, "extra");
      const sibling = path.join(base, "sibling");
      mkdirSync(ws);
      mkdirSync(er);
      mkdirSync(sibling);
      writeFileSync(path.join(er, "in.txt"), "extra-data\n");
      writeFileSync(path.join(sibling, "secret.txt"), "sibling-secret\n");
      const policy = generateBashSandboxPolicy(ws, [er]);

      // The extra root is readable AND writable by the sandboxed child.
      const erRead = runSandboxed(policy, `cat "${path.join(er, "in.txt")}"`, ws);
      assert.ok(erRead.ok, `reading the extra root must succeed: ${erRead.out}`);
      assert.match(erRead.out, /extra-data/);
      const erWrite = runSandboxed(policy, `echo x > "${path.join(er, "out.txt")}"`, ws);
      assert.ok(erWrite.ok, `writing in the extra root must succeed: ${erWrite.out}`);
      assert.ok(existsSync(path.join(er, "out.txt")), "the extra-root file must exist");

      // A SIBLING of the extra root (not assigned) is still denied — the
      // re-allow covers the extra root's subpath only, never its parent.
      const sibRead = runSandboxed(policy, `cat "${path.join(sibling, "secret.txt")}"`, ws);
      assert.ok(!sibRead.ok, "reading the extra root's sibling must FAIL");
      assert.ok(!sibRead.out.includes("sibling-secret"), "the sibling content must not leak");
      const sibWrite = runSandboxed(policy, `echo x > "${path.join(sibling, "evil.txt")}"`, ws);
      assert.ok(!sibWrite.ok, "writing the extra root's sibling must FAIL");
      assert.ok(!existsSync(path.join(sibling, "evil.txt")), "the sibling file must not exist");

      // The workspace still works (regression) and /etc is still denied.
      const wsRead = runSandboxed(policy, "echo ws-ok > w.txt && cat w.txt", ws);
      assert.ok(wsRead.ok, "the workspace must still work");
      assert.match(wsRead.out, /ws-ok/);
      const etc = runSandboxed(policy, "cat /etc/passwd", ws);
      assert.ok(!etc.ok, "/etc must still be denied with an extra root assigned");

      // node's realpathSync walk-down survives into the extra root (the
      // ancestor-metadata re-allows cover its chain too).
      const probe = path.join(er, "probe.js");
      writeFileSync(probe, 'console.log("c35-node-ran")\n');
      const nodeRun = runSandboxed(policy, `node "${probe}"`, ws);
      assert.ok(nodeRun.ok, `running a node FILE under the extra root must succeed: ${nodeRun.out}`);
      assert.match(nodeRun.out, /c35-node-ran/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);
