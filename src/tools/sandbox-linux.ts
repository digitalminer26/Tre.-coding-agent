/**
 * Linux bash kernel sandbox (Bubblewrap / bwrap).
 *
 * Unlike Seatbelt, bwrap builds a private mount namespace around an empty
 * root: selected host runtime mounts and the workspace are overlaid first,
 * then the empty directory is mounted on / last. User and mount namespaces
 * enforce that view; other homes, /etc secrets, host /tmp and sockets are
 * absent. v1 intentionally shares the network, and user-local toolchains in
 * $HOME (for example ~/.local) are not visible unless passed as --extra-root.
 * See docs/09-linux-sandbox.md. Darwin is untouched; this module is imported
 * only by the Linux dispatch in src/tools/sandbox.ts.
 *
 * --ro-bind-try tolerates missing runtime paths (merged-/usr and minimal
 * systems). /tmp is a private tmpfs, /dev is bwrap's minimal device set, and
 * the read-only SSL and resolver config mounts provide TLS/DNS without
 * exposing general /etc. Host self-binds must precede the empty-root bind:
 * bwrap resolves sources against the current root as it applies each mount.
 */
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  /** An empty directory the CALLER created; it becomes the sandbox's /. */
  emptyRoot: string;
  /** Shell for the child. Default "/bin/bash". */
  shell?: string;
}

/** Build bwrap argv, without the executable path. Pure and deterministic. */
export function buildBwrapArgs(opts: BwrapArgsOptions): string[] {
  const args = [
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
    "--bind", opts.cwd, opts.cwd,
  ];
  for (const root of opts.extraRoots ?? []) args.push("--bind", root, root);
  args.push(
    "--ro-bind", opts.emptyRoot, "/",
    "--chdir", opts.cwd,
    "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--die-with-parent",
    "--", opts.shell ?? "/bin/bash", "-c", opts.command,
  );
  return args;
}

/** Return the bind destination directories, deduplicated in contract order. */
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
    for (const dest of bwrapDestDirs({ cwd: tmpdir() })) mkdirSync(path.join(root, dest), { recursive: true });
    for (const dest of bwrapDestFiles()) {
      if (existsSync(dest)) {
        const file = path.join(root, dest);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, "");
      }
    }
    const args = buildBwrapArgs({ command: "true", cwd: tmpdir(), emptyRoot: root, shell: "/bin/true" });
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
    for (const dest of bwrapDestDirs({ cwd, extraRoots: opts.extraRoots })) await mkdir(path.join(emptyRoot, dest), { recursive: true });
    for (const dest of bwrapDestFiles()) {
      if (existsSync(dest)) {
        const file = path.join(emptyRoot, dest);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "");
      }
    }
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
