/**
 * WS11 (linux) — bash kernel sandbox (Bubblewrap / bwrap), the counterpart of
 * test/sandbox.test.ts (macOS Seatbelt).
 *
 * Pure (darwin AND linux, no platform guard): buildBwrapArgs argv shape — the
 * EXACT array, extra-root insertion order, the shell default, the empty-root
 * --ro-bind ordering, and the unshare set — plus bwrapDestDirs /
 * bwrapDestFiles and determinism. These pin the contract byte-for-byte.
 *
 * OS probe (linux only, guarded with { skip: process.platform !== "linux" }):
 * the GENERATED bwrap argv really confines a bash child — TMPDIR forced to
 * /tmp, the uid is the (identity-mapped) caller's, the host root not
 * visible, and a SIBLING canary outside the workspace is unreadable while
 * the workspace stays read/write. Kernel-level; no LLM, no network. Skipped on any machine where
 * bwrap is not installed (bwrapPath() is undefined) or the spawn is rejected
 * (bwrap present but unusable here) — the suite must not hard-fail there.
 *
 * The empty-root ordering test (the --ro-bind of emptyRoot coming FIRST,
 * before the host self-binds) is the design's LOAD-BEARING assertion: bwrap
 * resolves a bind SOURCE against the host root and its DEST against the
 * CURRENT root, so the empty root must be mounted first (read-only) for the
 * self-binds to overlay host content onto it. A regression that moves the
 * empty-root bind to the end (or makes it a plain --bind) silently produces
 * an empty sandbox — every exec fails with "execvp /bin/…: No such file or
 * directory". That is the one bug that ships quietly, so it is pinned twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  __resetLinuxSandboxAvailability,
  bwrapDestDirs,
  bwrapDestFiles,
  bwrapPath,
  buildBwrapArgs,
  linuxSandboxAvailable,
  spawnLinuxSandboxedBash,
} from "../src/tools/sandbox-linux.js";

test("buildBwrapArgs: exact argv for a fixed input (no extra roots)", () => {
  const args = buildBwrapArgs({
    command: "ls",
    cwd: "/home/u/proj",
    emptyRoot: "/home/u/empty",
  });
  assert.deepEqual(args, [
    // the empty root FIRST, read-only: deny-by-default
    "--ro-bind", "/home/u/empty", "/",
    // host runtime self-binds (sources resolve against the host root)
    "--ro-bind-try", "/usr", "/usr",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/sbin", "/sbin",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl",
    "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
    // private scratch + minimal device set + fresh proc
    "--tmpfs", "/tmp",
    "--dev", "/dev",
    "--proc", "/proc",
    // the rw working region LAST so it wins over the read-only root
    "--bind", "/home/u/proj", "/home/u/proj",
    "--chdir", "/home/u/proj",
    "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--die-with-parent",
    "--", "/bin/bash", "-c", "ls",
  ]);
});

test("buildBwrapArgs: extraRoots appear as --bind pairs after the workspace", () => {
  const cwd = "/home/u/proj";
  const r1 = "/home/u/extra1";
  const r2 = "/home/u/extra2";
  const emptyRoot = "/home/u/empty";
  const args = buildBwrapArgs({ command: "ls", cwd, extraRoots: [r1, r2], emptyRoot });

  // The full array with the two roots inserted after the workspace bind —
  // pins that the rest of the array is unchanged.
  assert.deepEqual(args, [
    "--ro-bind", emptyRoot, "/",
    "--ro-bind-try", "/usr", "/usr",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/sbin", "/sbin",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl",
    "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
    "--tmpfs", "/tmp",
    "--dev", "/dev",
    "--proc", "/proc",
    "--bind", cwd, cwd,
    "--bind", r1, r1,
    "--bind", r2, r2,
    "--chdir", cwd,
    "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--die-with-parent",
    "--", "/bin/bash", "-c", "ls",
  ]);

  // And pin the ordering explicitly: the empty root FIRST, then the
  // workspace --bind, then the extra --binds (input order) — all before
  // --chdir.
  const bindIdx = (op: string, src: string, dest: string): number => {
    for (let i = 0; i + 2 < args.length; i++) {
      if (args[i] === op && args[i + 1] === src && args[i + 2] === dest) return i;
    }
    return -1;
  };
  const wsIdx = bindIdx("--bind", cwd, cwd);
  const e1Idx = bindIdx("--bind", r1, r1);
  const e2Idx = bindIdx("--bind", r2, r2);
  const emptyIdx = bindIdx("--ro-bind", emptyRoot, "/");
  assert.ok(wsIdx >= 0 && e1Idx >= 0 && e2Idx >= 0 && emptyIdx >= 0, "all bind ops present");
  assert.ok(
    emptyIdx < wsIdx && wsIdx < e1Idx && e1Idx < e2Idx,
    "empty-root ro-bind < workspace bind < extra binds",
  );
});

test("buildBwrapArgs: custom shell is honored; default is /bin/bash", () => {
  const opts = { command: "ls", cwd: "/home/u/proj", emptyRoot: "/home/u/empty" };
  // The tail of the argv is always ["--", shell, "-c", command].
  assert.deepEqual(buildBwrapArgs(opts).slice(-4), ["--", "/bin/bash", "-c", "ls"]);
  assert.deepEqual(
    buildBwrapArgs({ ...opts, shell: "/bin/zsh" }).slice(-4),
    ["--", "/bin/zsh", "-c", "ls"],
  );
});

test("buildBwrapArgs: the empty root is --ro-bind (not --bind) and the FIRST bind, before the self-binds", () => {
  const cwd = "/home/u/proj";
  const emptyRoot = "/home/u/empty";
  const args = buildBwrapArgs({ command: "ls", cwd, emptyRoot });

  // The empty-root op must be --ro-bind: a plain --bind would mount / rw and
  // (with the ordering below) make the whole scratch filesystem writable.
  const emptyIdx = args.indexOf(emptyRoot);
  assert.ok(emptyIdx > 0, "the empty-root path is present");
  assert.equal(args[emptyIdx - 1], "--ro-bind", "the empty root is mounted read-only (--ro-bind, not --bind)");
  assert.equal(args[emptyIdx + 1], "/", "the empty root is mounted on /");

  // It must be the FIRST bind op: the very first op in the argv is the
  // empty-root ro-bind, and the host self-binds (e.g. /usr) come AFTER it.
  assert.equal(args[0], "--ro-bind", "the empty-root ro-bind is the first op");
  assert.equal(args[1], emptyRoot, "the empty-root path is the first operand");
  const usrIdx = args.indexOf("/usr");
  assert.ok(usrIdx > 0, "the /usr self-bind is present");
  assert.ok(emptyIdx < usrIdx, "the empty-root ro-bind precedes the /usr self-bind");
  // The workspace --bind comes after the empty root (so it wins over the
  // read-only root).
  const wsIdx = args.indexOf(cwd);
  assert.ok(wsIdx > 0, "the workspace bind is present");
  assert.equal(args[wsIdx - 1], "--bind", "the workspace is a rw --bind");
  assert.ok(wsIdx > emptyIdx, "the workspace bind follows the empty-root ro-bind");
});

test("buildBwrapArgs: unshare flags are exactly user/pid/ipc/uts (no --unshare-net)", () => {
  const args = buildBwrapArgs({ command: "ls", cwd: "/home/u/proj", emptyRoot: "/home/u/empty" });
  const unshares = args.filter((a) => a.startsWith("--unshare-"));
  assert.deepEqual(unshares, ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts"]);
  assert.ok(
    !args.includes("--unshare-net"),
    "v1 keeps the network shared — --unshare-net must be ABSENT",
  );
});

test("bwrapDestDirs: exact array for cwd + two extra roots; dedup when a root equals cwd", () => {
  const cwd = "/home/u/proj";
  assert.deepEqual(
    bwrapDestDirs({ cwd, extraRoots: ["/home/u/extra1", "/home/u/extra2"] }),
    [
      "/usr", "/bin", "/lib", "/lib64", "/sbin", "/etc", "/etc/ssl",
      "/tmp", "/dev", "/proc", cwd, "/home/u/extra1", "/home/u/extra2",
    ],
  );
  // Dedup: an extra root equal to the cwd appears only once.
  assert.deepEqual(
    bwrapDestDirs({ cwd, extraRoots: [cwd] }),
    ["/usr", "/bin", "/lib", "/lib64", "/sbin", "/etc", "/etc/ssl", "/tmp", "/dev", "/proc", cwd],
  );
});

test("bwrapDestFiles: exactly [\"/etc/resolv.conf\"]", () => {
  assert.deepEqual(bwrapDestFiles(), ["/etc/resolv.conf"]);
});

test("buildBwrapArgs + bwrapDestDirs + bwrapDestFiles are deterministic (same input → same output)", () => {
  const opts = { command: "ls", cwd: "/home/u/proj", extraRoots: ["/home/u/extra1"], emptyRoot: "/home/u/empty" };
  assert.deepEqual(buildBwrapArgs(opts), buildBwrapArgs(opts));
  const d = { cwd: "/home/u/proj", extraRoots: ["/home/u/extra1"] };
  assert.deepEqual(bwrapDestDirs(d), bwrapDestDirs(d));
  assert.deepEqual(bwrapDestFiles(), bwrapDestFiles());
});

test("linuxSandboxAvailable: returns a boolean and recomputes after the reset", {
  skip: process.platform !== "linux",
}, () => {
  // Do NOT assert the value — the probe result depends on the machine
  // (bwrap installed? userns allowed?). Just assert it runs and is a boolean.
  assert.equal(typeof linuxSandboxAvailable(), "boolean");
  __resetLinuxSandboxAvailability();
  assert.equal(typeof linuxSandboxAvailable(), "boolean");
});

test(
  "OS probe (linux): the generated bwrap argv confines the bash child",
  { skip: process.platform !== "linux", timeout: 30_000 },
  async (t) => {
    if (bwrapPath() === undefined) {
      t.skip("bwrap is not installed on this machine");
      return;
    }
    const ws = mkdtempSync(path.join(tmpdir(), "sb-linux-"));
    try {
      let spawnResult;
      try {
        spawnResult = await spawnLinuxSandboxedBash("echo $TMPDIR && id -u && ls / | head -3", {
          cwd: ws,
          env: { ...process.env, HOME: ws },
          detached: false,
        });
      } catch (e) {
        t.skip("spawn rejected (bwrap present but unusable here): " + (e as Error).message);
        return;
      }
      const { child, dispose } = spawnResult;
      let out = "";
      if (child.stdout) child.stdout.on("data", (d: Buffer) => (out += d));
      const code = await new Promise<number>((res) => child.on("close", (c: number | null) => res(c ?? -1)));
      await dispose();

      assert.equal(code, 0, `exit code 0; stdout:\n${out}`);
      const lines = out.trim().split("\n");
      assert.ok(out.includes("/tmp"), "TMPDIR is forced to /tmp");
      // bwrap's default (no --uid-map) is an IDENTITY map: the caller's uid
      // maps to the same uid inside the userns (so workspace files stay owned
      // by the user, not root). The value is machine-dependent (root caller →
      // 0, non-root → its uid), so assert it is a number, not a specific one.
      const uidLine = lines[1] ?? "";
      assert.ok(/^\d+$/.test(uidLine), `uid is a non-negative integer: "${uidLine}"`);
      const lsLines = lines.slice(2);
      assert.ok(
        !lsLines.includes("home"),
        `the host /home must not be visible in ls /: ${lsLines.join(",")}`,
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  },
);

test(
  "OS probe (linux): a SIBLING canary outside the workspace is hidden; the workspace stays read/write",
  { skip: process.platform !== "linux", timeout: 30_000 },
  async (t) => {
    if (bwrapPath() === undefined) {
      t.skip("bwrap is not installed on this machine");
      return;
    }
    const base = mkdtempSync(path.join(tmpdir(), "sb-esc-"));
    try {
      const ws = path.join(base, "ws");
      mkdirSync(ws);
      const canaryName = "canary-" + randomBytes(6).toString("hex");
      const canary = path.join(base, canaryName); // a SIBLING of ws — outside it
      writeFileSync(canary, "canary-secret\n");

      // run(cmd) spawns a FRESH sandbox (cwd = ws). Throws SandboxUnavailable
      // when the spawn itself is rejected (bwrap present but unusable here).
      class SandboxUnavailable extends Error {}
      async function run(cmd: string): Promise<{ code: number; out: string; err: string }> {
        let spawnResult;
        try {
          spawnResult = await spawnLinuxSandboxedBash(cmd, {
            cwd: ws,
            env: { ...process.env, HOME: ws },
            detached: false,
          });
        } catch (e) {
          throw new SandboxUnavailable((e as Error).message);
        }
        const { child, dispose } = spawnResult;
        let out = "";
        let err = "";
        if (child.stdout) child.stdout.on("data", (d: Buffer) => (out += d));
        if (child.stderr) child.stderr.on("data", (d: Buffer) => (err += d));
        const code = await new Promise<number>((res) => child.on("close", (c: number | null) => res(c ?? -1)));
        await dispose();
        return { code, out, err };
      }

      // The canary (a sibling of the workspace, OUTSIDE it) must not be
      // readable. This is the security assertion.
      let cat: { code: number; out: string; err: string };
      try {
        cat = await run(`cat "${canary}"`);
      } catch (e) {
        t.skip("spawn rejected (bwrap present but unusable here): " + (e as Error).message);
        return;
      }
      assert.ok(
        cat.code !== 0,
        `cat of the sibling canary must FAIL: code=${cat.code} out=${cat.out} err=${cat.err}`,
      );
      assert.ok(!cat.out.includes("canary-secret"), "the canary content must not leak");

      // Listing the sibling's parent dir must not show the canary.
      const ls = await run(`ls "${base}"`);
      assert.ok(
        !ls.out.includes(canaryName),
        `ls of the sibling dir must not list the canary: ${ls.out}`,
      );

      // Meanwhile, writing + reading a file INSIDE the workspace must succeed.
      const wsFile = path.join(ws, "in.txt");
      writeFileSync(wsFile, "workspace-data\n");
      const wsRead = await run(`cat "${wsFile}"`);
      assert.equal(wsRead.code, 0, `reading a workspace file must succeed: out=${wsRead.out} err=${wsRead.err}`);
      assert.match(wsRead.out, /workspace-data/);
      const wsWrite = await run(`echo x > "${path.join(ws, "out.txt")}"`);
      assert.equal(wsWrite.code, 0, `writing in the workspace must succeed: out=${wsWrite.out} err=${wsWrite.err}`);
      assert.ok(existsSync(path.join(ws, "out.txt")), "the workspace file must exist");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);
