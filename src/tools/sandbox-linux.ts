/**
 * Linux bash kernel sandbox (Bubblewrap / bwrap).
 *
 * Unlike Seatbelt, bwrap builds a private mount namespace whose / is an
 * empty READ-ONLY directory: selected host runtime mounts and the workspace
 * are overlaid ON TOP of it. User and mount namespaces enforce that view;
 * other homes, /etc secrets, host /tmp and sockets are absent. v1
 * intentionally shares the network, and user-local toolchains in $HOME
 * (for example ~/.local) are not visible unless passed as --extra-root.
 * See docs/09-linux-sandbox.md. Darwin is untouched; this module is imported
 * only by the Linux dispatch in src/tools/sandbox.ts.
 *
 * MOUNT ORDER IS LOAD-BEARING (verified on the lab VM, 2026-10-06):
 *   1. `--ro-bind <emptyRoot> /` FIRST. The empty root becomes / and is
 *      READ-ONLY, so every path not explicitly re-bound is absent or
 *      read-only — the same deny-by-default semantics as the darwin policy.
 *   2. The host runtime self-binds (`--ro-bind-try /usr /usr`, …). bwrap
 *      resolves a bind SOURCE against the HOST root and its DEST against
 *      the CURRENT (already-mounted) root, so these overlay the host's real
 *      /usr,/bin,/lib,… content onto the empty root's skeleton dirs.
 *   3. `--tmpfs /tmp`, `--dev /dev`, `--proc /proc` — private scratch, a
 *      minimal device set, a fresh proc.
 *   4. The workspace and extra roots as RW `--bind` self-binds (last, so
 *      they win over the read-only empty root).
 *   5. `--chdir <workspace>` + the user/pid/ipc/uts namespace unshares.
 *
 * Two consequences of that order, both verified empirically:
 *   - The empty root must be READ-ONLY and every bind DESTINATION must
 *     PRE-EXIST inside it (createEmptyRootSkeleton): bwrap cannot `mkdir` a
 *     dest parent into a read-only mount ("Can't mkdir /usr: Read-only file
 *     system"). A read-WRITE empty root would make the whole (scratch)
 *     filesystem writable — the opposite of the intended boundary.
 *   - The empty root must be mounted FIRST. If the self-binds run first
 *     they hit the host's real paths (a no-op: source and dest resolve to
 *     the same host path), and the empty root mounted last then covers
 *     everything — every exec fails with "execvp /bin/…: No such file or
 *     directory". No symlink mirroring is needed: the self-bind's SOURCE is
 *     the host path, so /bin (a symlink to usr/bin on merged-usr systems)
 *     pulls in the host's real /usr/bin content regardless of the skeleton.
 *
 * --ro-bind-try tolerates missing runtime paths (minimal systems). /tmp is
 * a private tmpfs, /dev is bwrap's minimal device set, and the read-only
 * SSL and resolver config mounts provide TLS/DNS without exposing general
 * /etc.
 */
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Same shape as the darwin SandboxSpawn. */
export interface SandboxSpawn {
  child: ChildProcess;
  /** Release the empty-root dir. Idempotent; best-effort. */
  dispose: () => Promise<void>;
}

export interface BwrapArgsOptions {
  /** The shell command to run (executed as `<shell> -c <command>`). */
  command: string;
  /** The workspace (the sandbox's rw working dir; becomes the child's cwd). */
  cwd: string;
  /** Additional rw roots (CLI --extra-root), same semantics as darwin. */
  extraRoots?: string[];
  /** An empty directory the CALLER created (skeleton, see
   * createEmptyRootSkeleton); it becomes the sandbox's READ-ONLY /. */
  emptyRoot: string;
  /** Shell for the child. Default "/bin/bash". */
  shell?: string;
}

/** Build bwrap argv, without the executable path. Pure and deterministic. */
export function buildBwrapArgs(opts: BwrapArgsOptions): string[] {
  const args = [
    // 1. the empty root FIRST, READ-ONLY: everything not re-bound below is
    //    absent or read-only (deny-by-default, like the darwin policy).
    "--ro-bind", opts.emptyRoot, "/",
    // 2. host runtime self-binds (sources resolve against the host root,
    //    dests against the current root) — overlay real content onto the
    //    empty root's skeleton dirs. -try tolerates missing paths.
    "--ro-bind-try", "/usr", "/usr",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/sbin", "/sbin",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl",
    "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
    // 3. private scratch + minimal device set + fresh proc.
    "--tmpfs", "/tmp",
    "--dev", "/dev",
    "--proc", "/proc",
    // 4. the rw working regions LAST so they win over the read-only root.
    "--bind", opts.cwd, opts.cwd,
  ];
  for (const root of opts.extraRoots ?? []) args.push("--bind", root, root);
  args.push(
    "--chdir", opts.cwd,
    "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--die-with-parent",
    "--", opts.shell ?? "/bin/bash", "-c", opts.command,
  );
  return args;
}

/**
 * Return the bind destination directories, deduplicated in contract order.
 * EVERY one of these must pre-exist inside the empty root (createEmptyRoot
 * Skeleton): the empty root is read-only, so bwrap cannot mkdir a dest
 * parent at mount time.
 */
export function bwrapDestDirs(opts: { cwd: string; extraRoots?: string[] }): string[] {
  return [...new Set([
    "/usr", "/bin", "/lib", "/lib64", "/sbin", "/etc", "/etc/ssl",
    "/tmp", "/dev", "/proc", opts.cwd, ...(opts.extraRoots ?? []),
  ])];
}

/** Return the bind destination files. */
export function bwrapDestFiles(): string[] {
  return ["/etc/resolv.conf"];
}

/**
 * Create the empty-root skeleton under `root`: every bind destination as a
 * (real, empty) directory, plus the resolver file as an empty placeholder.
 * `root` itself must exist. No symlink mirroring is needed — see the module
 * header (self-bind sources resolve against the host root, so the skeleton
 * only has to provide the dest dirs bwrap mounts onto).
 */
export function createEmptyRootSkeleton(
  root: string,
  cwd: string,
  extraRoots: string[] = [],
): void {
  for (const d of bwrapDestDirs({ cwd, extraRoots })) {
    mkdirSync(path.join(root, d), { recursive: true });
  }
  for (const f of bwrapDestFiles()) {
    if (existsSync(f)) {
      const file = path.join(root, f);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "");
    }
  }
}

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"];
let pathCache: string | null | undefined;
/** Locate the bwrap binary, or undefined when unavailable. */
export function bwrapPath(): string | undefined {
  if (pathCache === undefined) {
    pathCache =
      BWRAP_CANDIDATES.find((p) => existsSync(p)) ??
      // No-root installs (dpkg-deb -x to a user prefix, e.g. ~/.local/bin —
      // the lab VM has no root for apt): scan the caller's PATH.
      (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, "bwrap"))
        .find((p) => existsSync(p)) ??
      null;
  }
  return pathCache ?? undefined;
}

let availableCache: boolean | undefined;
/** True only when a real bwrap sandbox probe succeeds on this machine. */
export function linuxSandboxAvailable(): boolean {
  if (availableCache !== undefined) return availableCache;
  const binary = process.platform === "linux" ? bwrapPath() : undefined;
  if (!binary) return (availableCache = false);
  let root: string | undefined;
  try {
    root = mkdtempSync(path.join(tmpdir(), "coding-agent-bw-probe-"));
    createEmptyRootSkeleton(root, tmpdir());
    const shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
    const args = buildBwrapArgs({ command: "true", cwd: tmpdir(), emptyRoot: root, shell });
    const result = spawnSync(binary, args, { stdio: "ignore", timeout: 3000 });
    availableCache = result.status === 0;
  } catch {
    availableCache = false;
  } finally {
    if (root) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  return availableCache;
}

/** Reset the availability cache (tests). */
export function __resetLinuxSandboxAvailability(): void {
  availableCache = undefined;
  pathCache = undefined;
}

/** Spawn a command under the Linux Bubblewrap workspace policy. */
export async function spawnLinuxSandboxedBash(
  command: string,
  opts: { cwd?: string; env: NodeJS.ProcessEnv; detached?: boolean; extraRoots?: string[] },
): Promise<SandboxSpawn> {
  const cwd = opts.cwd ?? process.cwd();
  const env: NodeJS.ProcessEnv = {
    ...opts.env,
    GIT_CONFIG_NOSYSTEM: opts.env.GIT_CONFIG_NOSYSTEM ?? "1",
    TMPDIR: "/tmp",
    TRE_SANDBOX: "1",
  };
  const shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  if (process.env.TRE_SANDBOX === "1") {
    return { child: spawn(shell, ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: opts.detached }), dispose: async () => {} };
  }
  const binary = bwrapPath();
  if (!binary) throw new Error("Bubblewrap (bwrap) is unavailable");
  const emptyRoot = await mkdtemp(path.join(tmpdir(), "coding-agent-bw-"));
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try { await rm(emptyRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  try {
    createEmptyRootSkeleton(emptyRoot, cwd, opts.extraRoots ?? []);
    return {
      child: spawn(binary, buildBwrapArgs({ command, cwd, extraRoots: opts.extraRoots, emptyRoot, shell }), {
        cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: opts.detached,
      }),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
