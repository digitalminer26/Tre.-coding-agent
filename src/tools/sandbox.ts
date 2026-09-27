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
 *
 * 2026-09-19 ("broken loop" fixes — the self-improve loop died at every git
 * and node step under the sandbox; all three verified by a kernel canary
 * matrix on macOS 15, Apple Silicon):
 *   - The enumeration denies cover ancestor NODES (a `subpath` deny matches
 *     the node itself on this kernel), so node's realpathSync walk-down —
 *     lstat of every prefix from / — EPERM'd on /Users or /private BEFORE
 *     reaching any allowed leaf. `node <file>` crashed for workspace, /tmp
 *     AND $TMPDIR paths alike: tsc, node --test and npm were all dead under
 *     the sandbox (only `node -e` survived). Fix: file-read-metadata
 *     re-allows (stat/lstat/readlink only — no data, no listing) on the
 *     ancestor chains of the workspace and the per-user tmp dir.
 *   - /usr/bin/git is an xcode-select SHIM; it readlinks
 *     /private/var/db/xcode_select_link, which the /private deny blocked —
 *     every git call failed with rc=1 plus xcode-select stderr noise.
 *     Fix: a single-file literal re-allow (no traversal is opened; the real
 *     git under /Library/Developer/... was already readable).
 *   - git additionally treats an UNREADABLE /etc/gitconfig as fatal — EPERM
 *     is not the ENOENT it gets on machines where the file is absent. The
 *     sandboxed child now gets GIT_CONFIG_NOSYSTEM=1 (standard practice for
 *     confined tools; an explicit caller value wins) instead of loosening
 *     the /etc deny.
 *   - /bin/sh's cd is still broken under the policy (D12 note 8): the
 *     quality gate therefore runs its one cd + node pair through `bash -c`
 *     (see scripts/quality-check.sh), and test/e2e.sh keeps its workdir in
 *     $TMPDIR instead of /tmp (write-denied; sessions live there too).
 *   - NESTED use: a process ALREADY under a kernel policy cannot apply a
 *     DIFFERENT one (sandbox_apply → EPERM, rc 71; re-applying the identical
 *     policy succeeds — verified 2026-09-19). spawnSandboxedBash therefore
 *     marks its children (TRE_SANDBOX=1) and, when ITSELF runs marked, spawns
 *     the command unwrapped: the child inherits the caller's confinement
 *     as-is — still a real kernel boundary, but the per-call workspace
 *     policy is not re-applied. Consequence: test/e2e.sh scenario 10
 *     (sandbox-escape) is skipped under an inherited sandbox, because the
 *     harness there can only write to repo+tmpdir — both allowed regions —
 *     so it cannot plant a canary in a denied location.
 *   - PTY: the /dev write-deny blocked openpty() (needs /dev/ptmx + the
 *     allocated /dev/ttysNN slave) — `script` died with "openpty: Operation
 *     not permitted", killing every TUI scenario and the skill's TUI
 *     verification recipe under an INHERITED sandbox (one-shot mode is
 *     unaffected — verified 2026-09-19: e2e 5/14, all TUI scenarios dying
 *     at startup). Fix: write-allows for /dev/ptmx (literal) and /dev/ttys*
 *     (regex — SBPL has no glob). Safe: a pty is not a file channel (I/O is
 *     the pty pair itself, children inherit the same policy), and
 *     cross-session slaves stay kernel-DAC-restricted (verified: cat of a
 *     foreign active slave → "Permission denied"). /dev READS were already
 *     open by design (only writes are confined) — no read rules added.
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
 * Metadata-only (file-read-metadata = stat/lstat/readlink — no data, no
 * listing) re-allows for every ancestor directory of `real`, from its parent
 * up to (excluding) /. Needed because node's realpathSync walks DOWN from /
 * lstat-ing each prefix, and the enumeration denies (subpath "/Users",
 * "/private", ...) cover the ancestor NODES themselves — the walk EPERMs
 * before it reaches the allowed leaf (verified 2026-09-19). Emits nothing
 * for top-level paths. (Ordering: emit these BEFORE the workspace's read
 * allow so the workspace stays the last matching read rule.)
 */
export function ancestorMetadataRules(real: string): string[] {
  const rules: string[] = [];
  let cur = path.dirname(real);
  while (cur.length > 1 && cur !== "/") {
    rules.push(`(allow file-read-metadata (literal "${seString(cur)}"))`);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return rules;
}

/** The OS temp dir's REAL path for policy rules (falls back to the input). */
export function tmpdirRealPath(): string {
  try {
    return realpathSync(tmpdir());
  } catch {
    return tmpdir();
  }
}

/**
 * Generate the Seatbelt policy for a bash child working in `workspace`.
 * Allowlist by enumeration — see the module header for the kernel semantics
 * (resolved-path matching, fatal symlink-top subpath denies, node denies
 * for /etc + /home, /System/Volumes/Data real-target denies).
 *
 * C35: `extraRoots` are explicitly assigned additional read/write regions
 * (CLI --extra-root). Each gets the SAME mechanism as the workspace —
 * ancestor-metadata re-allows + read/write subpath allows — emitted BEFORE
 * the workspace rules, which stay LAST (last matching rule wins). An extra
 * root re-allows its own subpath only — never its parent or siblings.
 */
export function generateBashSandboxPolicy(
  workspace: string,
  extraRoots: string[] = [],
): string {
  const w = seString(workspaceRealPath(workspace));
  const er = extraRoots.map((e) => seString(workspaceRealPath(e)));
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
    // xcode-select shim (/usr/bin/git and friends) readlinks this to find
    // the CLT/Xcode dir; denied, it dies with rc=1 + stderr noise on every
    // call. One file, no traversal (verified 2026-09-19).
    '(allow file-read* (literal "/private/var/db/xcode_select_link"))',
    // Ancestor metadata for node's realpathSync walk-down — workspace chain
    // and per-user tmp chain (npm/tsc/child processes touch $TMPDIR even
    // when the workspace is elsewhere). No file content is opened.
    ...ancestorMetadataRules(workspaceRealPath(workspace)),
    ...ancestorMetadataRules(tmpdirRealPath()),
    // C35 extra roots: same mechanism as the workspace (ancestor metadata +
    // a read subpath allow), emitted BEFORE the workspace rule so the
    // workspace remains the last matching read rule.
    ...extraRoots.flatMap((e) => ancestorMetadataRules(workspaceRealPath(e))),
    ...er.map((e) => `(allow file-read* (subpath "${e}"))`),
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
    // C35 extra roots: a write subpath allow each, BEFORE the workspace rule
    // so the workspace stays the last matching write rule.
    ...er.map((e) => `(allow file-write* (subpath "${e}"))`),
    `(allow file-write* (subpath "${w}"))`,
    '(allow file-write* (subpath "/dev/null"))',
    '(allow file-write* (subpath "/dev/stdout"))',
    '(allow file-write* (subpath "/dev/stderr"))',
    // PTY machinery (openpty: /dev/ptmx + the allocated slave /dev/ttysNN) —
    // needed by `script` for TUI verification under an INHERITED sandbox;
    // a pty is not a file channel, cross-session slaves stay DAC-restricted
    // (verified 2026-09-19). SBPL has no glob → regex for the slaves.
    '(allow file-write* (literal "/dev/ptmx"))',
    '(allow file-write* (regex "/dev/ttys[0-9]+"))',
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
/**
 * Spawn options for the sandboxed child. `detached` (bash tool,
 * 2026-09-21): the child leads its own process group so the caller can
 * SIGKILL the whole sandbox-exec→shell→cmd tree on timeout/abort —
 * killing only sandbox-exec orphans the shell, which keeps the stdout
 * pipe open and the caller's promise never settles.
 * `extraRoots` (C35): explicitly assigned additional read/write regions
 * re-allowed in the per-call policy (validated by the CLI before spawn).
 */
export async function spawnSandboxedBash(
  command: string,
  opts: { cwd?: string; env: NodeJS.ProcessEnv; detached?: boolean; extraRoots?: string[] },
): Promise<SandboxSpawn> {
  const dir = await mkdtemp(path.join(tmpdir(), "coding-agent-sb-"));
  const policyPath = path.join(dir, `policy-${randomBytes(8).toString("hex")}.sb`);
  await writeFile(
    policyPath,
    generateBashSandboxPolicy(opts.cwd ?? process.cwd(), opts.extraRoots ?? []),
    {
      mode: 0o600,
    },
  );
  const sandboxExec = sandboxExecPath();
  if (!sandboxExec) throw new Error("sandbox-exec binary not found");
  // git treats an UNREADABLE system config (/etc/gitconfig — denied by the
  // policy) as fatal: EPERM is not the ENOENT it gets where the file is
  // absent. Skip the system level for confined children (inherited ones
  // included — the outer sandbox still denies /etc); an explicit caller
  // value wins.
  const env: NodeJS.ProcessEnv = {
    ...opts.env,
    GIT_CONFIG_NOSYSTEM: opts.env.GIT_CONFIG_NOSYSTEM ?? "1",
  };
  // A process ALREADY under a kernel policy cannot apply a DIFFERENT one
  // (sandbox_apply → EPERM, rc 71 — verified 2026-09-19). When this process
  // was itself spawned by spawnSandboxedBash (TRE_SANDBOX marker), spawn
  // unwrapped: the child inherits the caller's confinement as-is — still a
  // real kernel boundary, but the per-call workspace policy is not
  // re-applied (documented nested-use limitation).
  const inherited = process.env.TRE_SANDBOX === "1";
  const child = inherited
    ? spawn(sandboxShell(), ["-c", command], {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        ...(opts.detached ? { detached: true } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      })
    : spawn(
        sandboxExec,
        ["-f", policyPath, sandboxShell(), "-c", command],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...env, TRE_SANDBOX: "1" },
          ...(opts.detached ? { detached: true } : {}),
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
