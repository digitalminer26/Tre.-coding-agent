/**
 * WS11 — bash kernel sandbox (macOS Seatbelt).
 *
 * The bash tool runs arbitrary shell code; the WS7 path sandbox covers only
 * the file tools (read/write/edit). This module confines the bash CHILD at
 * the kernel level via `sandbox-exec` (Seatbelt), so the shell cannot read
 * secret surfaces (/etc, /var/root, other home dirs, keychains) or write
 * system directories — the same boundary WS7 enforces for the file tools.
 *
 * D12 (verified empirically on macOS 15, Apple Silicon; full kernel matrix
 * re-run 2026-09-18 while digging s10's canary):
 *   - A catchall deny — path-regex `^/` or `(subpath "/")` — plus re-allowing
 *     prefixes makes exec SIGABRT (Abort trap 6, re-verified 2026-09-18).
 *     TOP-LEVEL denies + a subpath re-allow are safe. So the policy is an
 *     ALLOWLIST BY ENUMERATION: deny the sensitive top-levels, re-allow the
 *     workspace LAST (last matching rule wins).
 *   - Data access (open/read/write) is checked against the RESOLVED (real)
 *     path: /tmp/x → /private/tmp/x, so `(deny file-read* (subpath
 *     "/private"))` covers /tmp, /var and /etc in one rule — and the
 *     workspace re-allow must use the workspace's REAL path (a /tmp-spelled
 *     re-allow matches nothing). /Users, /Volumes, /cores, /Library are REAL
 *     directories (no symlink) — ordinary subpath denies work.
 *   - SYMLINKED TOPS are special: a subpath deny of a symlinked top
 *     (/tmp, /var, /etc, /home) is FATAL — it kills EVERY literal-spelling
 *     open underneath and NO re-allow can restore it (verified: even a
 *     `(allow file-read* (subpath "/"))` after it; also `(literal "/tmp"))
 *     is fatal for traversal). Consequence: symlinked tops get a NODE deny
 *     (`(literal "/etc")`) — only /etc and /home are safe that way (no
 *     workspace lives there); /tmp and /var get NO node deny, because a
 *     workspace under them must survive. Residual (accepted): `ls /tmp` and
 *     `ls /var` list top-level NAMES only — no contents, no descent (one
 *     level down is already resolved to /private → denied).
 *   - /home is a symlink to /System/Volumes/Data/home — the REAL target is
 *     denied too (read + write), as is /System/Volumes/Data/Library/
 *     Keychains (the real spelling of /Library/Keychains).
 *   - chdir: `cd` INSIDE the workspace works (bash; relative and absolute,
 *     both spellings). `cd` OUTSIDE it may "succeed" (the shell's cwd moves)
 *     but every file op there is still denied — the escape is inert. NOTE:
 *     /bin/sh's cd is broken under any deny policy (ENOTDIR on `cd .`), so
 *     the sandboxed child runs /bin/bash when present (see sandboxShell).
 *   - /bin/sh probes /private/var/select/sh at startup (harmless stderr
 *     noise when denied); re-allowed for quietness.
 *   - Profiles are inherited across fork/exec: the shell's children are
 *     confined too.
 *   - darwin only. Elsewhere the bash tool runs unsandboxed (the approval
 *     gate + destructive classifier still apply). Opt out: --no-sandbox.
 *
 * Known v1 boundary: per-user temp (/private/var/folders) and /opt are
 * readable and writable (tool runtimes need them); /usr, /bin, /sbin,
 * /System and /Library (minus Keychains) stay readable so exec/dyld work;
 * commands that need ~/.ssh etc. (e.g. git push over ssh) fail under the
 * sandbox — run with --no-sandbox for system-maintenance work.
 * (2026-09-18: /private — i.e. /tmp, /var, /etc — and /Volumes+/Network
 * became confined; before that the denylist left /tmp readable/writable,
 * which s10's canary exposed.)
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

// Stock macOS: /usr/sbin/sandbox-exec. Non-standard system trees (some lab
// machines ship a split /usr) put it in /usr/bin — resolve, don't assume.
const SANDBOX_EXEC_CANDIDATES = ["/usr/bin/sandbox-exec", "/usr/sbin/sandbox-exec"];

let resolvedCache: string | undefined;

/** Locate the sandbox-exec binary, or undefined when unavailable. */
export function sandboxExecPath(): string | undefined {
  if (resolvedCache !== undefined) return resolvedCache;
  resolvedCache = SANDBOX_EXEC_CANDIDATES.find((p) => existsSync(p));
  return resolvedCache;
}

let availableCache: boolean | undefined;

/** True when the kernel sandbox is usable on this platform. */
export function bashSandboxAvailable(): boolean {
  if (availableCache === undefined) {
    availableCache = process.platform === "darwin" && sandboxExecPath() !== undefined;
  }
  return availableCache;
}

/** Reset the availability cache (tests). */
export function __resetSandboxAvailability(): void {
  availableCache = undefined;
}

/** Escape a string for a Seatbelt S-expression literal. */
export function seString(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The workspace's REAL path for policy re-allows: the kernel checks data
 * access against the resolved path, so a /tmp/… workspace must be re-allowed
 * as /private/tmp/… (verified 2026-09-18: a /tmp-spelling re-allow matches
 * nothing). Falls back to the input for non-existent paths (unit tests).
 */
export function workspaceRealPath(workspace: string): string {
  try {
    return realpathSync(workspace);
  } catch {
    return workspace;
  }
}

/**
 * The shell the sandboxed child runs under: /bin/bash when present — its
 * `cd` passes the Seatbelt check, while /bin/sh's cd fails with ENOTDIR on
 * ANY path under a deny policy (verified 2026-09-18). Fallback /bin/sh
 * (then `cd` in commands is broken; everything else works).
 */
export function sandboxShell(): string {
  return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/**
 * Generate the Seatbelt policy for a bash child working in `workspace`.
 * Allowlist by enumeration — see the module header for the kernel semantics
 * (resolved-path matching, fatal symlink-top subpath denies, node denies
 * for /etc + /home, /System/Volumes/Data real-target denies).
 */
export function generateBashSandboxPolicy(workspace: string): string {
  const w = seString(workspaceRealPath(workspace));
  return [
    "(version 1)",
    "(allow default)",
    "; ── reads: workspace-only (allowlist by enumeration) ──",
    // Data access is checked on the RESOLVED path: /tmp,/var,/etc all live
    // under /private — one rule. (subpath "/tmp"|"/var"|"/etc" would be
    // FATAL for a workspace under them — see the module header.)
    '(deny file-read* (subpath "/private"))',
    // Symlinked tops get NODE denies (literal = the node itself) — blocks
    // ls/stat of the symlink without killing traversal. Only /etc and /home
    // are safe that way (no workspace lives there).
    '(deny file-read* (literal "/etc"))',
    '(deny file-read* (literal "/home"))',
    // /home is a symlink to /System/Volumes/Data/home — deny the real target
    '(deny file-read* (subpath "/System/Volumes/Data/home"))',
    '(allow file-read* (subpath "/private/var/folders"))', // per-user temp — tool runtimes need it (v1 boundary)
    '(allow file-read* (subpath "/private/var/select"))', // /bin/sh startup probe (harmless; keeps stderr quiet)
    '(deny file-read* (subpath "/cores"))',
    '(deny file-read* (subpath "/Library/Keychains"))',
    '(deny file-read* (subpath "/System/Volumes/Data/Library/Keychains"))', // real spelling
    '(deny file-read* (subpath "/System/Volumes/Preboot"))',
    '(deny file-read* (subpath "/Users"))',
    '(deny file-read* (subpath "/Volumes"))', // external mounts
    '(deny file-read* (subpath "/Network"))',
    `(allow file-read* (subpath "${w}"))`, // the workspace (REAL path), wherever it lives — LAST so it wins
    "; ── writes: workspace + /dev fakes only ──",
    '(deny file-write* (subpath "/private"))',
    '(deny file-write* (subpath "/System/Volumes/Data/home"))',
    '(deny file-write* (subpath "/usr"))',
    '(deny file-write* (subpath "/bin"))',
    '(deny file-write* (subpath "/sbin"))',
    '(deny file-write* (subpath "/System"))',
    '(deny file-write* (subpath "/Library"))',
    '(deny file-write* (subpath "/cores"))',
    '(deny file-write* (subpath "/Users"))',
    '(deny file-write* (subpath "/Volumes"))',
    '(deny file-write* (subpath "/Network"))',
    '(deny file-write* (subpath "/dev"))',
    '(allow file-write* (subpath "/private/var/folders"))', // per-user temp (v1 boundary)
    `(allow file-write* (subpath "${w}"))`,
    '(allow file-write* (subpath "/dev/null"))',
    '(allow file-write* (subpath "/dev/stdout"))',
    '(allow file-write* (subpath "/dev/stderr"))',
  ].join("\n");
}

export interface SandboxSpawn {
  child: ChildProcess;
  /** Release the policy file. Idempotent; best-effort. */
  dispose: () => Promise<void>;
}

/**
 * Spawn `command` under the Seatbelt workspace policy. The policy file is
 * written to a private dir under the OS temp dir (0600, random name —
 * sandbox-exec reads it BEFORE applying the profile, so it does not itself
 * need to be readable under the policy). The child is
 * `sandbox-exec -f <policy> <shell> -c <command>` with shell = /bin/bash
 * when present (its `cd` survives the policy; /bin/sh's does not — see
 * sandboxShell), else /bin/sh.
 */
export async function spawnSandboxedBash(
  command: string,
  opts: { cwd?: string; env: NodeJS.ProcessEnv },
): Promise<SandboxSpawn> {
  const dir = await mkdtemp(path.join(tmpdir(), "coding-agent-sb-"));
  const policyPath = path.join(dir, `policy-${randomBytes(8).toString("hex")}.sb`);
  await writeFile(policyPath, generateBashSandboxPolicy(opts.cwd ?? process.cwd()), {
    mode: 0o600,
  });
  const sandboxExec = sandboxExecPath();
  if (!sandboxExec) throw new Error("sandbox-exec binary not found");
  const child = spawn(
    sandboxExec,
    ["-f", policyPath, sandboxShell(), "-c", command],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    },
  );
  let disposed = false;
  return {
    child,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
