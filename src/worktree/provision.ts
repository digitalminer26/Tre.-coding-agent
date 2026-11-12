/**
 * P6 — worktree provisioning (docs/11 §5/S4, §14.1/§14.5, §11.1 P6).
 *
 * `WorktreeProvisioner` creates and tears down the per-task git worktrees
 * under `<episodeDir>/wt/<taskId>` (§5 layout), on the task branch
 * `agent/<episodeId>/<taskId>`, pinned at the episode `baseCommit`.
 *
 * Scope (pinned at P0 — the compartment boundary is normative):
 *  - Provisioning ONLY: `git worktree add` / `remove` / `prune`, branch
 *    creation pinned at the resolved base commit, isolated per-task dirs,
 *    safe (conservative) cleanup, open-or-create idempotence.
 *  - NO integration logic here (that is P12: candidate construction,
 *    trusted gate on the exact SHA, CAS advance of the episode branch).
 *    Removing a worktree whose branch has commits past its base is a
 *    cleanup decision, never a merge decision — deleting an unadvanced
 *    branch is proven by `base..branch` being empty; deleting unmerged
 *    work is refused unless the caller explicitly forces the discard.
 *  - NO ownership enforcement here (that is P7, §14.5): the provisioner
 *    is the mechanism; the supervisor holds the one-consumer-per-(session,
 *    worktree) fence. Provisioning is idempotent (ensure = open-or-create)
 *    so a crash between branch creation and worktree registration
 *    converges on retry, but the caller must already hold the episode's
 *    write fence before calling.
 *
 * Conservative rules (every refusal is an error, never a silent repair):
 *  - `wtRoot` must live OUTSIDE the repository (main checkout AND every
 *    linked worktree) and outside ANY git repo — BARE repos included —
 *    §5: "episode dirs never inside another repo". Enforced at open()
 *    on the nearest existing ancestor (no directory is created before
 *    the gates pass) via realpath containment + `rev-parse
 *    --path-format=absolute --git-common-dir` (audit F1/F2).
 *  - `episodeId`/`taskId` must be safe path components (same rule as the
 *    P4 episode journal); the derived branch name is additionally checked
 *    with `git check-ref-format` (dots, `..`, braces, control chars).
 *  - A worktree registered at `<wtRoot>/<taskId>` with a FOREIGN branch
 *    (not `agent/<episodeId>/<taskId>`) is refused, never adopted;
 *    detached provisioning refuses to adopt a branched registration.
 *  - A directory at the target path that is NOT registered with this repo
 *    is refused (never adopted, never implicitly deleted).
 *  - `removeTaskWorktree` refuses a dirty worktree (any `git status
 *    --porcelain=1 --ignored=traditional -uall` output — untracked AND
 *    ignored, since an unforced remove over an ignored payload once
 *    destroyed it while status read clean; M3 audit) unless `force`.
 *    It also refuses when any `ls-files -v` tag is non-`H`
 *    (assume-unchanged / skip-worktree bits hide modified tracked
 *    content from status; an all-`H` index is the only provable-clean
 *    state). Refusals distinguishing the two: ordinary changes →
 *    `dirty`; status-invisible content → `hidden-content`.
 *  - Branch deletion requires `baseCommit` proof (`base..branch` empty)
 *    unless `force` — deletion of unmerged work is an explicit discard.
 *    `branch -d` is never used (its heuristic is merged-into-HEAD, not
 *    base-pinned); the manual gate runs first, then `branch -D`.
 *  - `prune()` is repo-wide in git; this wrapper refuses to run when any
 *    stale entry lies outside its own `wtRoot` (never touch another
 *    tool's admin metadata) and reports exactly what it removed
 *    (before/after registry diff — git's own dry-run output is silent).
 *
 * All git invocations are fixed argv arrays through `execFile` (no shell,
 * no interpolation), with timeout and bounded buffers; a rev starting
 * with "-" is `--`-separated (a real `--` positional separator, not a
 * prefixed token). Leaf compartment: imports ONLY node:
 * builtins; nothing outside src/worktree/ may import this module until
 * P7/P9 wires it (both directions pinned by tests).
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ProvisionErrorCode =
  | "not-a-git-repo"            // repoRoot missing or has no git toplevel
  | "wt-inside-repo"            // wtRoot is inside the repository itself
  | "wt-in-other-repo"          // wtRoot sits inside some OTHER git repo (§5)
  | "bad-id"                    // episodeId/taskId/branch fails shape or check-ref-format
  | "unresolvable-base"         // baseCommit ref/sha does not name a commit
  | "path-exists"               // unregistered directory at the target path
  | "not-registered"            // asked to operate on a path this repo does not manage
  | "stale-registration"        // registered entry whose directory is gone (prune first)
  | "foreign-branch"            // registered worktree carries a different branch
  | "branch-conflict"           // branch exists but not at the pinned base
  | "dirty"                     // remove refused: worktree has uncommitted changes
  | "hidden-content"            // remove refused: content git status cannot show (ignored file, info/exclude entry, assume-unchanged/skip-worktree bit)
  | "index-blind"               // remove refused: ls-files reported an EMPTY index (unreadable/corrupt) — cannot prove removable
  | "has-submodules"            // remove refused: submodule (mode 160000) entries present — unsupported for agent worktrees
  | "unmerged"                  // branch deletion refused: commits past base
  | "no-base-for-branch-delete" // deleteBranch without proof base
  | "prune-refused"             // stale entries exist outside our wtRoot
  | "branch-in-use"             // deleteBranch refused: branch checked out in another worktree
  | "locked"                    // worktree is `git worktree lock`ed — explicit unlock required
  | "routing-poisoned"          // remove refused: the worktree's OWN file-based config (extensions.worktreeConfig + config.worktree core.worktree, or common core.worktree) re-routes git's checkout resolution away from the registered directory — no cleanliness proof through git would read THIS tree (audit-sol round-5 B1)
  | "bad-wt-root"               // wtRoot exists as a non-directory (open() refuses)
  | "git-failed";               // any other git failure (command + stderr attached)

export class WorktreeProvisionError extends Error {
  constructor(
    readonly code: ProvisionErrorCode,
    message: string,
    readonly detail?: { command?: string; stderr?: string },
  ) {
    super(message);
    this.name = "WorktreeProvisionError";
  }
}

// ---------------------------------------------------------------------------
// git plumbing (fixed argv, promise-based, bounded)
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** Canonical empty-tree object id (git's well-known constant). */
const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Sol round-3 (audit m3fix2) B2/B1 doctrine, ported from the supervise
// observation stack (src/host/supervise.ts PINNED_NEUTRALIZING_CONFIG):
// conversion settings a repo can set against a cleanliness check. Every
// one rides the gate's index-reading calls. fileMode=false is the B2
// hole (an exec-bit change moves nothing under it); autocrlf/eol/
// safecrlf/symlinks/ident bend worktree↔blob comparison the same way.
const PINNED_NEUTRALIZING_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.autocrlf", "false"],
  ["core.eol", "native"],
  ["core.safecrlf", "false"],
  ["core.symlinks", "true"],
  ["core.ident", "false"],
  ["core.fileMode", "true"],
];

/** Sol round-5 (audit m3f5) B1, layer 2: the top-level `--work-tree=`
 *  option. A worktree's OWN file-based config can re-route checkout
 *  resolution: `extensions.worktreeConfig=true` arms
 *  `.git/worktrees/<id>/config.worktree`, whose `core.worktree` is
 *  consumed during repository SETUP and BEATS a `-c core.worktree=`
 *  pin (verified on git 2.54) — only the command-line `--work-tree=`
 *  option wins (and it keeps the admin-dir/index resolution on THIS
 *  worktree; verified: `rev-parse --git-path index` under the pin
 *  still names .git/worktrees/<id>/index). Every gate call on a task
 *  worktree carries the pin so the PROOF reads this tree even if a
 *  config race slips past the routing guard. Env stripping (round 4)
 *  cannot reach file-based config — both layers are needed.
 *  EXPORTED for the round-7 pinned-view witness test (sol R6 minor 3:
 *  the witness must exercise the SHIPPED routeArgs so patching it to
 *  [] flips the test — the pin layer's independent necessity). */
export function routeArgs(absWorkTree: string): string[] {
  return [`--work-tree=${absWorkTree}`];
}

/** Sol round-5 (audit m3f5) B1, layer 1: honest-routing guard. Run
 *  the UNPINNED checkout resolution from the task worktree; if the
 *  worktree's own config (config.worktree via extensions.worktreeConfig)
 *  resolves the checkout ANYWHERE OTHER than the registered directory,
 *  no cleanliness proof through git can be trusted and git's OWN
 *  removal check is fooled too (pre-fix E1: a routed tree holding a
 *  unique ignored payload removed cleanly). Refuses `routing-poisoned`
 *  for BOTH the normal and the force path — force discards this
 *  tree's uncommitted work by contract, it does not authorize
 *  operating through a poisoned routing (an operator repairs config
 *  or removes manually). Empty/failed resolution fails closed. */
async function assertHonestRouting(worktreePath: string, path: string): Promise<void> {
  // Sol round-6 (audit m3fix6) minor 1: a resolution that FAILS (e.g.
  // a worktree-local core.bare=true makes 'rev-parse --show-toplevel'
  // die) is the same fail-closed fact as a mismatch — the checkout's
  // routing is not observable, so translate the failure into
  // routing-poisoned instead of leaking the generic git-failed code
  // (an unobservable routing IS the poisoned condition, per the claim
  // in HANDOFF/ledger; keeping the raw code contradicted it).
  let out: string;
  try {
    out = await git(worktreePath, ["rev-parse", "--show-toplevel"]);
  } catch (err) {
    if (err instanceof WorktreeProvisionError && err.code === "routing-poisoned") throw err;
    throw new WorktreeProvisionError("routing-poisoned", `worktree ${path}: 'rev-parse --show-toplevel' FAILED (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — checkout resolution is not observable, refusing (fail-closed)`);
  }
  const seen = out.trim();
  if (seen === "") {
    throw new WorktreeProvisionError("routing-poisoned", `worktree ${path}: 'rev-parse --show-toplevel' resolved to an EMPTY path — checkout resolution is not observable, refusing (fail-closed)`);
  }
  let seenReal: string;
  let wantReal: string;
  try {
    [seenReal, wantReal] = await Promise.all([realpath(seen), realpath(path)]);
  } catch {
    throw new WorktreeProvisionError("routing-poisoned", `worktree ${path}: routing check cannot canonicalize ${JSON.stringify(seen)} vs ${JSON.stringify(path)} — refusing (fail-closed)`);
  }
  if (seenReal !== wantReal) {
    throw new WorktreeProvisionError("routing-poisoned", `worktree ${path} does NOT resolve to itself: git resolves this checkout at ${seenReal} — its file-based config (extensions.worktreeConfig + config.worktree core.worktree, or a poisoned common core.worktree) re-routes EVERY git view away from the registered directory; no cleanliness proof is valid and git's own removal check is fooled (audit-sol round-5 B1). Refusing; repair the worktree's config (git config --worktree --unset core.worktree; git config --unset extensions.worktreeConfig) or remove manually`);
  }
}
function revArgs(rev: string): string[] {
  return rev.startsWith("-") ? ["--", rev] : [rev];
}

/** Sol round-4 (audit m3fix3) B1 fix: NO git call in this module may
 *  inherit an ambient GIT_* variable. An inherited GIT_WORK_TREE (or
 *  GIT_DIR / GIT_COMMON_DIR / GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY /
 *  GIT_ALTERNATE_OBJECT_DIRECTORIES / GIT_CONFIG* / GIT_ATTR* /
 *  GIT_NAMESPACE …) RE-ROUTES the call's repository — the removal gate
 *  would then prove cleanliness of a DIFFERENT checkout and delete the
 *  task tree over an unexamined ignored payload (repro: audit
 *  m3fix3-env-loss: ambient GIT_WORK_TREE=main made an unforced remove
 *  of a linked worktree holding a unique ignored file succeed).
 *  Rather than deny-listing names one at a time, EVERY provisioner git
 *  invocation strips the whole GIT_* namespace and gets a clean env:
 *  repository routing comes from `cwd` alone, config from the repo's
 *  own files plus the explicit -c pins, and the fresh-index calls
 *  layer their own GIT_INDEX_FILE/GIT_ATTR_SOURCE/... on top. The
 *  provisioner performs only local, non-paged, non-networked git calls,
 *  so nothing legitimate rides in GIT_* (fail-closed by construction
 *  against future git env vars too). */
function gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "GIT_*") continue; // git's own single-char wildcard (never legitimately set)
    if (k.startsWith("GIT_")) continue;
    if (v !== undefined) env[k] = v;
  }
  // Deterministic baseline: system config is machine-state outside the
  // repo (and unreadable under sandboxes) — pin it off rather than
  // depend on the ambient GIT_CONFIG_SYSTEM someone exported.
  return { GIT_CONFIG_SYSTEM: "/dev/null", ...env, ...(extra ?? {}) };
}

/** git with an extra env layer (throwaway-index gating). Same failure
 *  semantics as `git` (any non-zero → git-failed; NO documented-negative
 *  collapsing). Env is the sanitized gitEnv base + extra pins. */
async function gitWithEnv(cwd: string, args: string[], envExtra: Record<string, string>): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: gitEnv(envExtra),
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; code?: number | string; message?: string };
    throw new WorktreeProvisionError("git-failed", `git ${args.join(" ")} failed: ${e.stderr?.trim() || e.message || String(err)}`, {
      command: `git ${args.join(" ")}`,
      stderr: (e.stderr ?? "").slice(0, 2000),
    });
  }
}

/** Sol round-3 (audit m3fix2) B1 fix, ported from supervise.ts
 *  filterNeutralizeArgs: enumerate EVERY configured filter driver in the
 *  repo and pin each to identity (`=cat` for clean/smudge) or disabled
 *  (empty value for `process` — `=cat` would spawn cat as a filter
 *  server whose dead handshake leaves status reporting CLEAN, a
 *  false-clean oracle verified on git 2.54). Plus core.attributesFile
 *  killed (a driver can only be ARMED by an attributes source) and the
 *  PINNED_NEUTRALIZING_CONFIG set. `config --get-regexp` exit 1 is the
 *  documented "no matches"; any other non-zero fails CLOSED (git-failed
 *  → the worktree is kept), never "assume no drivers". */
async function filterNeutralizeArgs(cwd: string): Promise<string[]> {
  const probe = ["config", "--get-regexp", "^filter\\..+\\.(clean|smudge|process)$"];
  let out = "";
  try {
    const { stdout } = await execFileAsync("git", probe, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: gitEnv() });
    out = stdout;
  } catch (err) {
    const e = err as { code?: number | string; stderr?: string; message?: string };
    if (e.code !== 1) throw gitFailure(probe, e);
  }
  const pins: string[] = ["-c", "core.attributesFile=/dev/null"];
  for (const [k, v] of PINNED_NEUTRALIZING_CONFIG) pins.push("-c", `${k}=${v}`);
  for (const line of out.split("\n")) {
    const m = /^(filter\..+\.)(clean|smudge|process)(?=[ \t]|$)/.exec(line);
    if (m?.[1] !== undefined) pins.push("-c", m[2] === "process" ? `${m[1]}${m[2]}=` : `${m[1]}${m[2]}=cat`);
  }
  return pins;
}

/** Git's attributes tokenizer (attr.c): a line is ignorable iff it is
 *  zero-bytes or its FIRST byte is '#'. Byte-accurate (latin1 round-trip)
 *  — JS `\s` matches NBSP and stripping `#…` anywhere would turn the
 *  real rule path `\u00a0#` into a fake comment (supervise round-2 F1).
 *  Returns true when ANY non-ignorable line exists (a real rule). */
function hasEffectiveAttrRules(buf: Buffer): boolean {
  const lines = buf.toString("latin1").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const body = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (body === "" || body.charCodeAt(0) === 0x23) continue;
    if (/^[ \t]*$/.test(body)) continue; // git trims leading blanks: blanks-only = no pattern
    return true;
  }
  return false;
}

/** Sol round-3 (audit m3fix2) B1 arm-the-driver closure: with
 *  GIT_ATTR_SOURCE pointing at the EMPTY tree and core.attributesFile
 *  killed, the ONLY attributes source that can still arm a conversion
 *  for the gate's status is `$GIT_DIR/info/attributes` — it OVERRIDES
 *  GIT_ATTR_SOURCE (supervise round-2 MG-C5-F1). Absent/empty is fine;
 *  ANY effective rule (or unreadability) refuses fail-closed: file
 *  interpretation (filter/eol/text) would then be outside what the
 *  gate can observe, and content an armed driver can hide must never
 *  be removed on a proof the driver itself controls. */
async function refuseReinterpretingAttributes(cwd: string, pins: string[]): Promise<void> {
  const pathOut = await git(cwd, [...pins, "rev-parse", "--git-path", "info/attributes"]);
  const p = resolve(cwd, pathOut.trim());
  const refuse = (why: string): never => {
    throw new WorktreeProvisionError("hidden-content", `removal gate: $GIT_DIR/info/attributes ${why} — the attribute interpretation of tracked content is not observable, so no cleanliness proof is valid; refusing (fail-closed)`);
  };
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // absent: no armable source
    return refuse(`at ${p} is unreadable (${String((e as NodeJS.ErrnoException).code ?? e)})`);
  }
  if (!st.isFile()) return refuse(`at ${p} is not a regular file (type unobservable)`);
  if (st.size > 1024 * 1024) return refuse(`at ${p} exceeds 1 MiB (rules unbounded — not observable)`);
  let buf: Buffer;
  try {
    buf = await readFile(p);
  } catch (e) {
    return refuse(`at ${p} raced unreadable (${String((e as NodeJS.ErrnoException).code ?? e)})`);
  }
  if (hasEffectiveAttrRules(buf)) return refuse(`at ${p} holds attribute rules that may reinterpret tracked bytes (filter/eol/text)`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: gitEnv(),
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; code?: number | string; message?: string };
    throw new WorktreeProvisionError("git-failed", `git ${args.join(" ")} failed: ${e.stderr?.trim() || e.message || String(err)}`, {
      command: `git ${args.join(" ")}`,
      stderr: (e.stderr ?? "").slice(0, 2000),
    });
  }
}

/**
 * Documented NEGATIVE outcomes for the probe family (verified on git
 * 2.54): exit 1 is the "not found / invalid" status of
 * `rev-parse --verify --quiet` and `check-ref-format`; exit 128 with
 * "not a git repository (or any of the parent directories)" (the search
 * genuinely EXHAUSTED at /) or "must be run in a work tree" (bare repo)
 * is the honest negative for placement probes. Critically, the
 * search-exhausted form requires the full parenthesized wording: git's
 * BROKEN-GITLINK error `fatal: not a git repository: (null)` (a .git
 * file pointing at a missing gitdir) is a HARD error, not an "outside
 * any repo" answer — treating it as a negative would provision inside
 * a dead worktree (audit c3 F1). ANY other non-zero (corrupt repo,
 * permission failure, timeout, ENOENT) likewise raises `git-failed`
 * rather than being collapsed into "not found" (audit F4).
 */
const NEGATIVE_MARKERS = [
  "not a git repository (or any of the parent directories)",
  "must be run in a work tree",
];

function isDocumentedNegative(code: unknown, stderr: string): boolean {
  if (code === 1) return true;
  return typeof code === "number" && code !== 0 && NEGATIVE_MARKERS.some((m) => stderr.includes(m));
}

function gitFailure(args: string[], e: { code?: number | string; stderr?: string; message?: string }): WorktreeProvisionError {
  return new WorktreeProvisionError("git-failed", `git ${args.join(" ")} failed: ${e.stderr?.trim() || e.message || String(e)}`, {
    command: `git ${args.join(" ")}`,
    stderr: (e.stderr ?? "").slice(0, 2000),
  });
}

/**
 * Probe family: exit 0 → trimmed stdout, documented negative → null, any
 * other failure → git-failed. NOT usable for probes whose success output
 * is itself empty — use `probeExit0` there.
 */
async function gitVerify(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: gitEnv(),
    });
    return stdout.trim() === "" ? null : stdout.trim();
  } catch (err) {
    const e = err as { code?: number | string; stderr?: string };
    if (isDocumentedNegative(e.code, e.stderr ?? "")) return null;
    throw gitFailure(args, e);
  }
}

/** True when the command exits 0 (probes whose success output is empty);
 *  documented negatives → false; real failures → git-failed. */
async function probeExit0(cwd: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: gitEnv() });
    return true;
  } catch (err) {
    const e = err as { code?: number | string; stderr?: string };
    if (isDocumentedNegative(e.code, e.stderr ?? "")) return false;
    throw gitFailure(args, e);
  }
}

// ---------------------------------------------------------------------------
// Identity & names (§14.1 task/episode components; §5 branch shape)
// ---------------------------------------------------------------------------

/** Same safe-component rule as the P4 episode journal (kept local: leaf). */
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSafeComponent(kind: "episodeId" | "taskId", value: string): void {
  if (!SAFE_COMPONENT.test(value) || value === "." || value === "..") {
    throw new WorktreeProvisionError("bad-id", `${kind} must be a safe, non-empty path component (got ${JSON.stringify(value)})`);
  }
}

/** The §5 task branch name for an (episodeId, taskId) pair. */
export function taskBranchName(episodeId: string, taskId: string): string {
  assertSafeComponent("episodeId", episodeId);
  assertSafeComponent("taskId", taskId);
  return `agent/${episodeId}/${taskId}`;
}

/** git is the authority on ref legality (valid output is EMPTY stdout, so
 *  this is an exit-code probe, not a gitVerify call). */
async function assertValidBranch(cwd: string, branch: string): Promise<void> {
  if (!(await probeExit0(cwd, ["check-ref-format", `refs/heads/${branch}`]))) {
    throw new WorktreeProvisionError("bad-id", `branch ${JSON.stringify(branch)} is not a legal git ref name`);
  }
}

const SHA40 = /^[0-9a-f]{40}$/;

/**
 * Resolve a commit-ish to a full sha (the episode base pin). Accepts a
 * 40-hex sha or any rev that names a commit (tags peel via `^{commit}`).
 * Unresolvable → `unresolvable-base`, never a silent HEAD fallback.
 */
export async function resolveCommit(repoRoot: string, rev: string): Promise<string> {
  if (rev.trim() === "") throw new WorktreeProvisionError("unresolvable-base", "baseCommit must be a non-empty commit reference");
  const sha = await gitVerify(repoRoot, ["rev-parse", "--verify", "--quiet", ...revArgs(`${rev}^{commit}`)]);
  if (sha === null || !SHA40.test(sha)) throw new WorktreeProvisionError("unresolvable-base", `${JSON.stringify(rev)} does not name a commit in ${repoRoot}`);
  return sha;
}

/**
 * True when `head` is `base` or a descendant of it (the pin's invariant).
 * An empty/unknown head is NOT a descendant (fail closed).
 */
async function isDescendantOf(repoRoot: string, head: string, base: string): Promise<boolean> {
  if (head === "") return false;
  if (head === base) return true;
  // `--is-ancestor A B` is true when A is an ancestor of B: we ask whether
  // BASE is an ancestor of HEAD (the pin's invariant), not the reverse.
  // Exit 1 is the documented "no"; ANY undocumented failure (timeout,
  // corrupt repo, invalid head object) PROPAGATES as git-failed rather
  // than being masked into a permanent-looking branch-conflict (ds-c1 F4).
  return probeExit0(repoRoot, ["merge-base", "--is-ancestor", base, head]);
}

// ---------------------------------------------------------------------------
// Worktree registry view (`git worktree list --porcelain`)
// ---------------------------------------------------------------------------

export interface WorktreeEntry {
  /** Absolute path exactly as registered with git. */
  path: string;
  /** HEAD commit sha recorded for that worktree. */
  head: string;
  /** Branch name, or null when detached/bare. */
  branch: string | null;
  /** git marks entries whose directory (or gitdir link) is gone. */
  prunable: boolean;
  /** git marks worktrees pinned with `git worktree lock` (removal needs --force). */
  locked: boolean;
}

/** All worktrees registered with the repository at repoRoot. */
export async function listWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
  const out = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> | undefined;
  const flush = () => {
    if (cur?.path !== undefined) entries.push({ path: cur.path, head: cur.head ?? "", branch: cur.branch ?? null, prunable: cur.prunable ?? false, locked: cur.locked ?? false });
    cur = undefined;
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice("worktree ".length), head: "", branch: null, prunable: false, locked: false };
    } else if (cur !== undefined && line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length);
    } else if (cur !== undefined && line.startsWith("branch refs/heads/")) {
      cur.branch = line.slice("branch refs/heads/".length);
    } else if (cur !== undefined && line.startsWith("prunable")) {
      cur.prunable = true;
    } else if (cur !== undefined && (line === "locked" || line.startsWith("locked "))) {
      cur.locked = true;
    }
  }
  flush();
  return entries;
}

// ---------------------------------------------------------------------------
// The provisioner
// ---------------------------------------------------------------------------

export interface WorktreeProvisionerOptions {
  /** Absolute path of the repository to hang worktrees off. */
  repoRoot: string;
  /** Absolute `<episodeDir>/wt` directory (created if absent; MUST end up outside every repo). */
  wtRoot: string;
  /** Warning sink (progress notes only; refusals are thrown, never warned). Default: silent. */
  warn?: (message: string) => void;
}

/** A provisioned (or reopened) task worktree — the provenance an attempt
 *  record needs (§14.1 AttemptRecord.worktreePath + identity + base pin). */
export interface TaskWorktree {
  episodeId: string;
  taskId: string;
  /** Absolute path `<wtRoot>/<taskId>`. */
  path: string;
  /** Task branch `agent/<episodeId>/<taskId>`; null for detached worktrees. */
  branch: string | null;
  /** HEAD commit at return time (== baseCommit right after creation). */
  head: string;
  /** The pinned base commit this task was provisioned from ("" on plain open). */
  baseCommit: string;
  repoRoot: string;
  /** True when this call found an existing registered worktree. */
  preexisting: boolean;
}

export interface EnsureTaskWorktreeParams {
  episodeId: string;
  taskId: string;
  /** Commit-ish pinned as the task base (§5 merge-contract anchor). */
  baseCommit: string;
  /** "branch" (default) = agent/<episodeId>/<taskId>; "detached" = no branch. */
  mode?: "branch" | "detached";
}

export interface RemoveTaskWorktreeParams {
  episodeId: string;
  taskId: string;
  /** The base the branch was pinned at — REQUIRED for deleteBranch unless force. */
  baseCommit?: string;
  /** Discard uncommitted changes and (with deleteBranch) unmerged branch commits. */
  force?: boolean;
  /** Also delete the task branch (default false: branches outlive cleanup). */
  deleteBranch?: boolean;
}

export interface RemoveReport {
  episodeId: string;
  taskId: string;
  path: string;
  branch: string | null;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  forced: boolean;
  /** True when nothing was registered at the path and none existed. */
  noop: boolean;
}

export class WorktreeProvisioner {
  /** realpath'd git toplevel (canonical for containment + registry compare). */
  readonly repoRoot: string;
  /** realpath'd wtRoot (created by open()). */
  readonly wtRoot: string;
  private readonly warn: (message: string) => void;

  private constructor(repoRoot: string, wtRoot: string, warn: (message: string) => void) {
    this.repoRoot = repoRoot;
    this.wtRoot = wtRoot;
    this.warn = warn;
  }

  /**
   * Validate placement and return a provisioner. Rejects BEFORE any
   * mutation (audit F1: a refused open() creates nothing): missing
   * repoRoot / no git toplevel; wtRoot inside the repository itself (incl.
   * its linked worktrees) or inside ANY other git repo — BARE repos
   * included — detected via `rev-parse --path-format=absolute
   * --git-common-dir` on the nearest EXISTING ancestor (audit F2:
   * `--show-toplevel` misses bare repos). Creates wtRoot (recursive)
   * only after both gates pass.
   */
  static async open(options: WorktreeProvisionerOptions): Promise<WorktreeProvisioner> {
    const warn = options.warn ?? (() => {});
    const repoArg = resolve(options.repoRoot);
    if (!existsSync(repoArg)) throw new WorktreeProvisionError("not-a-git-repo", `repoRoot does not exist: ${repoArg}`);
    if (!(await probeExit0(repoArg, ["rev-parse", "--show-toplevel"]))) {
      throw new WorktreeProvisionError("not-a-git-repo", `not a git repository (no work tree): ${repoArg}`);
    }
    const toplevel = (await git(repoArg, ["rev-parse", "--show-toplevel"])).trim();
    const repoToplevel = await realpath(toplevel).catch(() => resolve(toplevel));
    const repoCommonArg = (await git(repoArg, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const repoCommon = await realpath(repoCommonArg).catch(() => resolve(repoCommonArg));

    // Placement gate on the nearest existing ancestor BEFORE creating
    // anything: an uncreated wtRoot inherits its ancestor's repo context.
    const anchor = nearestExisting(resolve(options.wtRoot));
    const anchorReal = await realpath(anchor).catch(() => anchor);
    const commonOut = await gitVerify(anchorReal, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (commonOut !== null) {
      const commonReal = await realpath(commonOut).catch(() => resolve(commonOut));
      if (commonReal === repoCommon) {
        // git itself resolves this anchor to OUR common git dir: by git's
        // own view the anchor is part of our repository — main checkout,
        // linked worktree, a worktree RENAMED behind git's back (its
        // gitdir file still points here), or the .git dir itself. Refuse
        // unconditionally (audit c2 F1: registry-path containment is
        // fragile to renames; git's common-dir view is the authority).
        throw new WorktreeProvisionError("wt-inside-repo", `wtRoot ${anchor} is part of our own repository (git common dir ${repoCommon}) — episode worktrees live OUTSIDE the repo (§5)`);
      } else {
        throw new WorktreeProvisionError("wt-in-other-repo", `wtRoot ${anchor} lies inside foreign repository (git dir ${commonReal}) (§5: episode dirs never inside another repo, bare included)`);
      }
    }
    const wtArg = resolve(options.wtRoot);
    try {
      await mkdir(wtArg, { recursive: true });
    } catch (err) {
      // ds-c3 F4: wtRoot existing as a NON-DIRECTORY (regular file,
      // symlink to a file) makes even `recursive` mkdir throw EEXIST
      // (verified) — a raw errno escaping the typed contract. Everything
      // that is not "already a directory" is a placement refusal.
      const e = err as { code?: string };
      if (e.code === "EEXIST" || e.code === "ENOTDIR") {
        throw new WorktreeProvisionError("bad-wt-root", `wtRoot exists but is not a directory: ${wtArg} (${e.code}) — refusing to provision under it`);
      }
      throw new WorktreeProvisionError("bad-wt-root", `cannot create wtRoot ${wtArg}: ${e.code ?? String(err)}`);
    }
    return new WorktreeProvisioner(repoToplevel, await realpath(wtArg), warn);
  }

  /** Absolute path for a task under wtRoot (validated, NOT created). */
  taskPath(taskId: string): string {
    assertSafeComponent("taskId", taskId);
    return join(this.wtRoot, taskId);
  }

  /**
   * Open-or-create, idempotent (a crash between branch creation and
   * registration converges on retry). Creation order:
   *   branch absent  → `worktree add --no-track -b agent/<ep>/<task> <path> <baseSha>`
   *   branch at base → `worktree add <path> <branch>` (crash-recovery re-attach)
   *   branch moved   → `branch-conflict` (never reset, never rebased — P7/P12 territory)
   * Post-creation HEAD is verified against the base pin.
   * A preexisting LIVE entry that is `git worktree lock`ed is ACCEPTED
   * (ds-c2 Q5 adjudication, documented per its recommendation): the lock
   * is an admin signal aimed at removal/prune (git's canonical use is
   * holding a worktree during submodule migration), not a provenance
   * gate — refusing it would break ensure()'s idempotence for callers
   * that lock their own dirs. Hazard to state for callers: writing into
   * a worktree another process is mid-migration on can corrupt that
   * migration; the orchestrator (P7 fence) owns who writes where, so
   * locks inside our wtRoot are ours to interpret, not git's to police.
   * Locked entries whose directory is GONE are staleness, not liveness
   * (entryGone: <path>/.git gitfile must exist).
   */
  async ensureTaskWorktree(params: EnsureTaskWorktreeParams): Promise<TaskWorktree> {
    const { episodeId, taskId } = params;
    assertSafeComponent("episodeId", episodeId);
    assertSafeComponent("taskId", taskId);
    const mode = params.mode ?? "branch";
    const baseSha = await resolveCommit(this.repoRoot, params.baseCommit);
    const path = this.taskPath(taskId);
    const branch = mode === "branch" ? taskBranchName(episodeId, taskId) : null;
    if (branch !== null) await assertValidBranch(this.repoRoot, branch);

    const registry = await listWorktrees(this.repoRoot);
    const entry = registry.find((e) => pathsEqual(e.path, path));

    if (entry !== undefined) {
      // Registered with THIS repo: the open path (never re-`add`).
      if (await entryGone(entry)) {
        throw new WorktreeProvisionError(
          "stale-registration",
          entry.locked
            ? `worktree at ${path} is LOCKED and its directory is gone — \`git worktree unlock\` then prune() (git never marks locked entries prunable)`
            : `worktree at ${path} is registered but its directory is gone — call prune() first`,
        );
      }
      if (mode === "branch" && entry.branch !== branch) {
        throw new WorktreeProvisionError("foreign-branch", `worktree ${path} is on branch ${JSON.stringify(entry.branch ?? "(detached)")}, expected ${JSON.stringify(branch)} — refusing to adopt`);
      }
      if (mode === "detached" && entry.branch !== null) {
        throw new WorktreeProvisionError("foreign-branch", `worktree ${path} is on branch ${JSON.stringify(entry.branch)} but detached provisioning was requested — refusing to adopt`);
      }
      // Audit C5: a registration's EXISTENCE is not proof it descends from
      // this base. A retried attempt whose base moved (or a repo mutated
      // between attempts) would otherwise be handed back as provenance
      // claiming `baseCommit: baseSha` while HEAD is somewhere else — a
      // false AttemptRecord (§14.1) and a wrong merge anchor for P12.
      if (!(await isDescendantOf(this.repoRoot, entry.head, baseSha))) {
        throw new WorktreeProvisionError(
          "branch-conflict",
          `worktree ${path} is registered at ${entry.head || "(no head)"}, which does not descend from the requested base ${baseSha} — refusing to adopt (re-provisioning a moved base is P7/P12 territory)`,
        );
      }
      return { episodeId, taskId, path: entry.path, branch: entry.branch, head: entry.head, baseCommit: baseSha, repoRoot: this.repoRoot, preexisting: true };
    }

    // Unregistered target: anything at the path that git does not manage
    // (directory OR plain file — ds-c3/c4 F3: a file made `worktree add`
    // die with raw git-failed downstream) is never adopted and never
    // implicitly deleted; the typed error keeps the contract independent
    // of git's wording.
    if (await pathOccupied(path)) {
      throw new WorktreeProvisionError("path-exists", `path ${path} exists but is not a worktree of ${this.repoRoot} — refusing (never delete unmanaged paths)`);
    }

    if (mode === "detached") {
      await git(this.repoRoot, ["worktree", "add", "--quiet", "--detach", path, baseSha]);
    } else {
      const existingTip = await gitVerify(this.repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
      if (existingTip !== null && existingTip !== baseSha) {
        throw new WorktreeProvisionError("branch-conflict", `branch ${branch} exists at ${existingTip}, not at base ${baseSha} — refusing to move or adopt (integration is P12)`);
      }
      if (existingTip !== null) {
        // Crash-recovery attach: the branch exists at base (created by a
        // prior attempt) but its worktree registration is gone — `add`
        // without -b re-binds the existing branch.
        // ds-c2 F1 adjudication: the auditor claimed a same-named TAG
        // shadows this unqualified operand and detaches the worktree, and
        // proposed qualifying with `refs/heads/<branch>` — BOTH claims
        // were DISPROVEN by experiment on git 2.54: with
        // refs/tags/agent/e/t present, `worktree add p agent/e/t` still
        // checks out the BRANCH (worktrees/<id>/HEAD is the symref
        // refs/heads/...; porcelain lists the branch — and still does
        // when the tag is force-moved AHEAD of it), while the proposed
        // `worktree add p refs/heads/feat` silently produces a DETACHED
        // worktree — the "fix" would have introduced the exact defect it
        // claimed. `worktree add`'s commit-ish is branch-oriented, unlike
        // plain rev-parse. Regression-tested; do NOT qualify this operand.
        await git(this.repoRoot, ["worktree", "add", "--quiet", path, branch as string]);
      } else {
        await git(this.repoRoot, ["worktree", "add", "--quiet", "--no-track", "-b", branch as string, path, baseSha]);
      }
    }

    // Audit C4: `rev-parse HEAD` cannot legitimately answer "not found"
    // here, so exit 1 must NOT be collapsed into a negative by the generic
    // gitVerify classifier — that produced "HEAD null does not match".
    // Use `git()` so the real stderr reaches the caller.
    let head: string;
    try {
      head = (await git(path, ["rev-parse", "HEAD"])).trim();
    } catch (err) {
      const e = err as WorktreeProvisionError;
      throw new WorktreeProvisionError("git-failed", `fresh worktree at ${path} has no readable HEAD: ${e.message}`, e.detail);
    }
    if (head !== baseSha) {
      // ds-c4 F1: this guard fires only when the repo mutates between
      // resolveCommit and `worktree add` materializing it — unreachable
      // deterministically without fault injection, so it carries no test
      // (accepted residual, kept loud: a provenance lie here poisons
      // every P12 merge anchor, so an untested tripwire beats none).
      throw new WorktreeProvisionError("git-failed", `fresh worktree HEAD ${head} does not match pinned base ${baseSha} (repo mutated mid-provision?)`);
    }
    return { episodeId, taskId, path, branch, head, baseCommit: baseSha, repoRoot: this.repoRoot, preexisting: false };
  }

  /**
   * Open an existing provisioned worktree; null when nothing is registered
   * at the path. Accepts the task branch OR detached (both are provisioner
   * products); refuses foreign branches and stale registrations.
   */
  async openTaskWorktree(params: { episodeId: string; taskId: string }): Promise<TaskWorktree | null> {
    const { episodeId, taskId } = params;
    assertSafeComponent("episodeId", episodeId);
    assertSafeComponent("taskId", taskId);
    const path = this.taskPath(taskId);
    const entry = (await listWorktrees(this.repoRoot)).find((e) => pathsEqual(e.path, path));
    if (entry === undefined) return null;
    if (await entryGone(entry)) {
      throw new WorktreeProvisionError(
        "stale-registration",
        entry.locked
          ? `worktree at ${path} is LOCKED and its directory is gone — \`git worktree unlock\` then prune() (git never marks locked entries prunable)`
          : `worktree at ${path} is registered but its directory is gone — call prune() first`,
      );
    }
    const expected = taskBranchName(episodeId, taskId);
    if (entry.branch !== null && entry.branch !== expected) {
      throw new WorktreeProvisionError("foreign-branch", `worktree ${path} is on branch ${JSON.stringify(entry.branch)}, expected ${JSON.stringify(expected)} or detached`);
    }
    return { episodeId, taskId, path: entry.path, branch: entry.branch, head: entry.head, baseCommit: "", repoRoot: this.repoRoot, preexisting: true };
  }

  /**
   * Conservative teardown (§11.1 P6 "safe cleanup"):
   *  - registered-only — never deletes unmanaged directories,
   *  - dirty gate BEFORE any mutation (any porcelain status incl.
   *    untracked; ignored-only worktrees pass) unless force,
   *  - deleteBranch requires baseCommit proof (`base..branch` empty)
   *    unless force — deleting unmerged work is an explicit discard,
   *  - then `worktree remove` (--force for dirty, `-f -f` additionally
   *    when LOCKED — git requires the double force to override a lock;
   *    audit ds-c1 F2), then `branch -D`
   *    AFTER the manual base-pinned gate (never `branch -d`: its
   *    heuristic is merged-into-HEAD, not base-relative). A branch
   *    checked out in another worktree makes `branch -D` fail —
   *    surfaced, not bypassed. A user whose directory is gone yields
   *    stale-registration guidance, never a circular branch-in-use (ds-c2 F4).
   *  Error codes thrown: not-registered, stale-registration, foreign-branch,
   *  locked, dirty, hidden-content, index-blind, has-submodules,
   *  branch-in-use, no-base-for-branch-delete, unmerged,
   *  git-failed (prune() also throws prune-refused and locked).
   *  Branch names beginning with "-" are rejected by git's own
   *  check-ref-format (verified: `git branch -- -foo` → "not a valid
   *  branch name"), so registry-sourced operands cannot inject options;
   *  every proof operand is ref-qualified anyway (ds-c1 F1 / ds-c2 F7).
   */
  async removeTaskWorktree(params: RemoveTaskWorktreeParams): Promise<RemoveReport> {
    const { episodeId, taskId } = params;
    assertSafeComponent("episodeId", episodeId);
    assertSafeComponent("taskId", taskId);
    const force = params.force === true;
    const path = this.taskPath(taskId);
    const entry = (await listWorktrees(this.repoRoot)).find((e) => pathsEqual(e.path, path));
    if (entry === undefined) {
      // ds-c4 F3: a plain FILE at the task path must not report a silent
      // noop — something unmanaged occupies the path the provisioner
      // owns; say so and refuse.
      if (await pathOccupied(path)) {
        throw new WorktreeProvisionError("not-registered", `${path} is not a worktree of ${this.repoRoot} but exists — refusing to touch an unmanaged path`);
      }
      return { episodeId, taskId, path, branch: null, worktreeRemoved: false, branchDeleted: false, forced: false, noop: true };
    }
    if (await entryGone(entry)) {
      throw new WorktreeProvisionError(
        "stale-registration",
        entry.locked
          ? `worktree at ${path} is LOCKED and its directory is gone — \`git worktree unlock\` then prune() (git never marks locked entries prunable)`
          : `worktree at ${path} is registered but its directory is gone — call prune() instead of remove`,
      );
    }
    const expected = taskBranchName(episodeId, taskId);
    if (entry.branch !== null && entry.branch !== expected) {
      throw new WorktreeProvisionError("foreign-branch", `worktree ${path} is on branch ${JSON.stringify(entry.branch)} — refusing to remove a foreign worktree`);
    }
    // Audit C6 (+ ds-c1 F6 ordering): locked refusals come AFTER the
    // foreign check so a locked FOREIGN entry is never advertised as
    // force-discardable (force would then hit foreign-branch anyway).
    if (entry.locked && !force) {
      throw new WorktreeProvisionError("locked", `worktree ${path} is locked (\`git worktree lock\`) — unlock it, or pass force (force discards uncommitted work AND overrides the lock)`);
    }

    // Sol round-5 (audit m3f5) B1: routing guard BEFORE any content
    // gate, on BOTH the normal and the force path (see
    // assertHonestRouting). Verified pre-fix (m3f6-probe reproductions):
    // a worktree whose own config.worktree re-routes the checkout makes
    // `git status` read the REDIRECT TARGET (empty over a real payload
    // in the registered dir), and `git worktree remove` then destroys
    // the registered tree while its own fool-able check passes (E1).
    // The top-level `--work-tree=` pin restores honest resolution for
    // the gate calls but does NOT re-arm git's removal check, so this
    // guard — refuse the operation entirely — is the load-bearing
    // protection; the pins (below) are the belt for the proof itself.
    await assertHonestRouting(entry.path, path);

    // Content gates, unforced only (force = the operator's explicit
    // discard, documented on the force option). ORDER: index-flag
    // gates read the REAL index first (they inspect index BITS which a
    // throwaway index would not carry), then the content proof runs on
    // a THROWAWAY fresh index.
    // Index-flag gate (M3 audit fix): `status` is BLIND to entries the
    // index itself disclaims — assume-unchanged (`h`), skip-worktree
    // (`S`), and every other non-`H` ls-files tag. A tracked file
    // modified under those bits reads clean and vanishes with the
    // tree. The worktree is only honestly removable when EVERY index
    // entry is `H ` (tracked, unflagged). An EMPTY ls-files output is
    // NOT vacuous cleanliness: a corrupt or unreadable index can print
    // nothing and exit 0 on some git builds, so we fail CLOSED as
    // `index-blind` rather than assume no tracked files exist. A
    // genuinely file-less tree is extremely rare in practice (agent
    // worktrees always have a baseCommit with files); the cost of a
    // false refusal is one kept directory, the cost of a false pass is
    // the whole tree. A FAILED ls-files (non-zero exit) propagates as
    // git-failed and is caught upstream as a kept refusal.
    // Audit-haiku F1: `-c core.fsmonitor=false` forces the gate's own
    // view to do the real stat comparison regardless of repo config —
    // the fsmonitor-valid index bit is NOT visible in ls-files -v (it
    // stays an `H` tag) and a lying hook would hide modified content
    // from status, ls-files, AND git's own removal check.
    // DISCLOSED RESIDUE (git itself cannot represent these in any
    // status form): directories ignored while containing ONLY empty
    // subdirectories, and modified CONTENT hidden behind a sparse-
    // checkout skip-worktree — sparse checkout is unsupported for
    // agent worktrees (docs/11 §5 worktree doctrine).
    // Audit-haiku F3: submodule entries (mode 160000) are invisible to
    // both the ignore gate and the flag gate above; git's own removal
    // happens to refuse them with a blunt error, but we gate explicitly
    // so protection never rests on git's accident.
    // TOCTOU note (audit-haiku F4): the gate's view is a snapshot taken
    // while the task is TERMINAL (fate already written). Content
    // written after the gate reads but before the rm is an unavoidable
    // race with no git-level fix (git's own check is equally racy and
    // does not see ignored content). This is acceptable only because
    // release runs exclusively after an accepted-done fate — the worker
    // is provably stopped by the scheduler before release is called.
    if (!force) {
      // Sol round-5 B1 belt (layer 2): the `--work-tree=` pin so this
      // proof reads THIS tree's files even if a config race slips past
      // the routing guard above (verified: the pin wins over
      // config.worktree on git 2.54 and keeps the admin index).
      const tagged = await git(entry.path, [...routeArgs(entry.path), "-c", "core.fsmonitor=false", "ls-files", "-v"]);
      const flagged = tagged.split("\n").filter((l) => l !== "" && l[0] !== "H");
      if (flagged.length > 0) {
        const kinds = [...new Set(flagged.map((l) => l[0] ?? "?"))].sort().join(",");
        throw new WorktreeProvisionError("hidden-content", `worktree ${path} has ${flagged.length} index entr${flagged.length === 1 ? "y" : "ies"} with disclaiming flags (${kinds}: assume-unchanged/skip-worktree/other) whose content status cannot show — refusing to remove (force to discard)`);
      }
      // Audit-haiku F2/F3: an EMPTY ls-files output means the index is
      // not readable-as-expected (a corrupt/unreadable index prints
      // nothing and exits 0 on some git versions) — fail CLOSED rather
      // than vacuously clean. A genuinely file-less tree is rare (every
      // agent baseCommit has files); the cost of a false refusal is one
      // kept directory, the cost of a false pass is the tree.
      if (tagged.trim() === "") {
        throw new WorktreeProvisionError("index-blind", `worktree ${path} reported an EMPTY index (ls-files -v) — cannot prove removable; refusing (corrupt/unreadable index fails closed; force to discard)`);
      }
      // Audit-haiku F3: submodule entries (mode 160000) are invisible to
      // the ignore/flag gates above and git's own removal refuses only
      // BY ACCIDENT (a blunt "working trees containing submodules"
      // error). Refuse explicitly with OUR code — protection must not
      // rest on git's incident. (Mode stays the first column even at
      // conflict stages — verified against git 2.54 staged output.)
      const stages = await git(entry.path, [...routeArgs(entry.path), "-c", "core.fsmonitor=false", "ls-files", "-s"]);
      if (stages.split("\n").some((l) => l.startsWith("160000 "))) {
        throw new WorktreeProvisionError("has-submodules", `worktree ${path} contains submodule entries — agent worktrees do not carry submodules and git cannot remove them safely; refusing`);
      }
      // Dirty gate (strictly conservative: includes untracked AND
      // ignored — M3 audit fix: `status -uall` WITHOUT --ignored showed
      // EMPTY over an ignored payload file and an unforced remove
      // destroyed it while status read clean; proven against pre-fix
      // dist). `--ignored=traditional -uall` surfaces every ignore
      // mechanism (.gitignore, info/exclude, core.excludesFile) as
      // per-FILE `!!` entries — presence is the finding, the path rides
      // only in the bounded stderr detail. (`matching` would collapse a
      // whole ignored directory to one `dir/` line; empty ignored
      // directories are the disclosed residue git itself cannot
      // represent — `remove -f -f` discards them.) Non-`!!` entries are
      // ordinary dirty.
      // Audit-sol B1/B2 (round 3): the status proof runs on a
      // THROWAWAY index built fresh from HEAD under the full
      // neutralization pin set + GIT_ATTR_SOURCE=<empty tree>
      // (supervise.ts R4-B1/R5-F1 doctrine, ported to the release
      // gate). A REAL-index status trusts the stat cache: a clean
      // filter mapped to the committed blob (or any prior poisoned git
      // run) stamped modified bytes as unchanged, and
      // core.fileMode=false made git skip the exec-bit comparison at
      // read-index time — an EMPTY status over dirty bytes (both
      // losses reproduced against the pre-fix gate:
      // .tre/review-probes/m3f2-loss.mjs). A fresh index has NO stat
      // cache: git re-reads and re-hashes every tracked file raw. This
      // does not mutate the worktree's real index (release must be
      // read-only on shared state), so the throwaway lives in a tmp
      // dir. `read-tree HEAD` also refuses (git-failed → kept) when
      // HEAD is unborn — a mid-checkout worktree is never removable
      // unforced. The flag gate above ran FIRST so an
      // assume-unchanged-modified file keeps its `hidden-content`
      // classification (a fresh index would have shown it as plain
      // `dirty` — same refusal, less precise disclosure).
      const pins = await filterNeutralizeArgs(entry.path);
      // B1 arm-the-driver closure (fail-closed): info/attributes
      // overrides GIT_ATTR_SOURCE, so it must hold no effective rules.
      await refuseReinterpretingAttributes(entry.path, pins);
      let freshIdxDir: string | null = null;
      let status: string;
      try {
        freshIdxDir = await mkdtemp(join(tmpdir(), "tre-remove-idx-"));
        const freshEnv: Record<string, string> = {
          GIT_INDEX_FILE: join(freshIdxDir, "idx"),
          GIT_ATTR_SOURCE: EMPTY_TREE_OID,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        };
        await gitWithEnv(entry.path, [...routeArgs(entry.path), ...pins, "read-tree", "HEAD"], freshEnv);
        // `--ignore-submodules=none`: per-submodule
        // `submodule.<n>.ignore=all` hides a populated child's modified
        // bytes from status (supervise R5-B1 — proven empty over
        // modified child/a WITH the config set; only the command-line
        // flag beats it).
        status = await gitWithEnv(entry.path, [...routeArgs(entry.path), ...pins, "-c", "core.fsmonitor=false", "status", "--porcelain=1", "--ignored=traditional", "--untracked-files=all", "--ignore-submodules=none"], freshEnv);
      } finally {
        // The index file is a throwaway; nothing downstream needs it.
        if (freshIdxDir !== null) void rm(freshIdxDir, { recursive: true, force: true }).catch(() => {});
      }
      if (status.trim() !== "") {
        const lines = status.split("\n").filter((l) => l.trim() !== "");
        const ordinary = lines.filter((l) => !l.startsWith("!!"));
        if (ordinary.length > 0) {
          throw new WorktreeProvisionError("dirty", `worktree ${path} has uncommitted changes — refusing to remove (force to discard)`, { stderr: status.slice(0, 2000) });
        }
        throw new WorktreeProvisionError("hidden-content", `worktree ${path} holds IGNORED content git status would not otherwise show (${lines.length} entr${lines.length === 1 ? "y" : "ies"}) — refusing to remove (force to discard)`, { stderr: status.slice(0, 2000) });
      }
    }

    if (params.deleteBranch === true && entry.branch !== null) {
      // Pre-gate (audit F5): a branch checked out in ANOTHER worktree
      // would let `worktree remove` succeed and then fail `branch -D` —
      // a partial mutation. Refuse BEFORE touching anything.
      // Audit ds-c2 F4: a user whose directory is GONE (locked entries are
      // never marked prunable) is not a live checkout — reporting plain
      // branch-in-use sends the operator in circles, because unlock+prune
      // is the fix and reaching it is safe. Refuse with actionable stale
      // guidance instead. Live users keep the original refusal.
      const otherUsers = (await listWorktrees(this.repoRoot)).filter((e) => e.branch === entry.branch && !pathsEqual(e.path, entry.path));
      const staleUsers: string[] = [];
      const liveUsers: string[] = [];
      for (const u of otherUsers) {
        (await entryGone(u) ? staleUsers : liveUsers).push(u.path);
      }
      if (staleUsers.length > 0) {
        throw new WorktreeProvisionError(
          "stale-registration",
          `branch ${entry.branch} is also registered at ${staleUsers.join(", ")} whose director${staleUsers.length > 1 ? "ies are" : "y is"} gone — unlock them if needed and prune() before removing this worktree${liveUsers.length > 0 ? ` (also live at ${liveUsers.join(", ")})` : ""}`,
        );
      }
      if (liveUsers.length > 0) {
        throw new WorktreeProvisionError("branch-in-use", `branch ${entry.branch} is also checked out at ${liveUsers.join(", ")} — refusing partial removal`);
      }
      if (!force) {
        const base = params.baseCommit;
        if (base === undefined || base === "") {
          throw new WorktreeProvisionError("no-base-for-branch-delete", "deleteBranch needs baseCommit to prove the branch is unadvanced (or force)");
        }
        const baseSha = await resolveCommit(this.repoRoot, base);
        // Audit C8: `base..branch` is trivially empty when the caller
        // passes the branch's OWN tip as the base — the gate would then
        // "prove" loss-free deletion while discarding real commits. The
        // proof is sound only when the base is an independent pin: a
        // commit reachable from some ref OTHER than the branch being
        // deleted (the episode branch, main, a tag). A base reachable
        // ONLY through this branch is not a pin at all — it is the
        // branch's own history, and deleting it would lose that history.
        // (ds-c1 F8: `for-each-ref --contains` requires git >= 2.7 — on
        // older git this fails CLOSED with git-failed, never silently.
        // Residual by design: containment via an unrelated tag at the
        // branch tip satisfies independence; that is the caller's own
        // pinning, and the commit object survives through that ref, so
        // no work becomes unreachable — deletion of the LOCAL branch
        // then discards nothing that the caller has not pinned.)
        // Audit ds-c1 F1: `entry.branch` UNQUALIFIED resolves through
        // git's ref-rev-parse rules, where refs/tags/ comes BEFORE
        // refs/heads/ — a same-named tag shadows the branch, so the gate
        // would check the tag's history while `branch -D` deletes the real
        // branch (proven: tag `agent/e/t` at base beats the advanced
        // branch in `rev-parse --verify`). Every operand is qualified.
        const branchRef = `refs/heads/${entry.branch}`;
        const tip = (await git(this.repoRoot, ["rev-parse", "--verify", branchRef])).trim();
        const containing = (await git(this.repoRoot, ["for-each-ref", "--contains", baseSha, "--format=%(refname)"])).trim().split("\n").filter((r) => r !== "" && r !== `refs/heads/${entry.branch}`);
        if (containing.length === 0) {
          throw new WorktreeProvisionError("no-base-for-branch-delete", `baseCommit ${baseSha} is reachable only through ${entry.branch} itself (tip ${tip}) — it is not an independent pin and cannot prove the branch is unadvanced (pass the pin the branch was created at, or force)`);
        }
        const isBaseInBranch = await probeExit0(this.repoRoot, ["merge-base", "--is-ancestor", baseSha, branchRef]);
        if (!isBaseInBranch) {
          throw new WorktreeProvisionError("no-base-for-branch-delete", `baseCommit ${baseSha} is not an ancestor of ${entry.branch} (tip ${tip}) — it cannot prove the branch is unadvanced (pass the branch's own pin, or force)`);
        }
        const ahead = await git(this.repoRoot, ["rev-list", "--max-count=1", `${baseSha}..${branchRef}`]);
        if (ahead.trim() !== "") {
          throw new WorktreeProvisionError("unmerged", `branch ${entry.branch} has commits past ${baseSha} — integration is P12; refusing to delete (force discards)`);
        }
      }
    }

    // Audit ds-c1 F2: a LOCKED worktree needs `-f -f` (git: "use
    // 'remove -f -f' to override or unlock first") — a single --force
    // fails late with git-failed after every gate passed. Verified
    // against git 2.54; double force only for locked entries.
    const forceArgs = !force ? [] : entry.locked ? ["-f", "-f"] : ["--force"];
    await git(this.repoRoot, ["worktree", "remove", ...forceArgs, entry.path]);
    let branchDeleted = false;
    if (params.deleteBranch === true && entry.branch !== null) {
      await git(this.repoRoot, ["branch", "-D", entry.branch]);
      branchDeleted = true;
    }
    return { episodeId, taskId, path: entry.path, branch: entry.branch, worktreeRemoved: true, branchDeleted, forced: force, noop: false };
  }

  /**
   * Remove admin records of VANISHED worktrees (git's own prune semantics:
   * only entries whose directory is gone are touched; live worktrees are
   * never affected). Refuses when ANY stale entry lies outside this
   * provisioner's wtRoot — another tool's metadata is not ours to prune —
   * and reports exactly what it removed (registry diff; git's own
   * `prune --dry-run` prints nothing on this platform, so before/after
   * comparison is the source of truth).
   */
  async prune(): Promise<{ removed: string[] }> {
    const before = await listWorktrees(this.repoRoot);
    // Locked entries are NEVER marked prunable by git (see entryGone) —
    // without this, a locked+vanished registration under wtRoot would be
    // skipped by `git worktree prune` while prune() reported success.
    const stale: WorktreeEntry[] = [];
    for (const e of before) {
      if (await entryGone(e)) stale.push(e);
    }
    const foreign = stale.filter((e) => !pathsEqual(e.path, this.wtRoot) && !isWithin(e.path, this.wtRoot));
    if (foreign.length > 0) {
      // I8: a refusal is an ERROR, never a return value a caller can ignore
      // (audit C1: `prune-refused` was declared but never thrown, so an
      // `await ... ; done` caller silently believed cleanup succeeded).
      throw new WorktreeProvisionError(
        "prune-refused",
        `refusing to prune: ${foreign.length} stale registration(s) lie outside ${this.wtRoot} — another tool's admin metadata is not ours to prune`,
        { stderr: foreign.map((e) => e.path).sort().join("\n") },
      );
    }
    // Audit ds-c1 F3: git's prune SKIPS locked entries, so without this
    // gate prune() would return success while a locked stale entry under
    // our own wtRoot survived — the same silent-incomplete-success class
    // as C1. Refuse; the operator unlocks, then prune converges.
    const lockedStale = stale.filter((e) => e.locked);
    if (lockedStale.length > 0) {
      throw new WorktreeProvisionError(
        "locked",
        `refusing to prune: ${lockedStale.length} stale registration(s) under ${this.wtRoot} are LOCKED — git's prune skips them; run \`git worktree unlock\` then prune again`,
        { stderr: lockedStale.map((e) => e.path).sort().join("\n") },
      );
    }
    if (stale.length === 0) return { removed: [] };
    await git(this.repoRoot, ["worktree", "prune"]);
    const after = new Set((await listWorktrees(this.repoRoot)).map((e) => e.path));
    const removed = stale.filter((e) => !after.has(e.path)).map((e) => e.path).sort();
    this.warn(`worktree prune: removed ${removed.length} stale registration(s): ${removed.join(", ")}`);
    return { removed };
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Lexical containment with separator safety (`/a` is NOT within `/ab`). */
function isWithin(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Compare a registry path with our computed path.
 *
 * `this.wtRoot` IS realpath'd (open()), but a registry path is git's own
 * raw text and may name a directory that no longer exists — so it cannot
 * be realpath'd here without masking the prunable case. String equality
 * is therefore only reliable when git registered the path in the same
 * spelling we compute.
 *
 * Residual (audit C3, accepted for P6 — fail-CLOSED direction): on a
 * case-INSENSITIVE or symlink-aliased filesystem (`/tmp` ->
 * `/private/tmp`, a symlinked episode dir) the two spellings can differ,
 * and the lookup misses. The consequence is a refusal, never a wrong
 * worktree: `ensure` reports `path-exists`, `remove` reports
 * `not-registered`, and `prune` treats the entry as foreign — all
 * operator-visible and recoverable. Canonicalization is deliberately NOT
 * attempted on a path that may be nonexistent.
 */
function pathsEqual(a: string, b: string): boolean {
  return a === b;
}

/** Nearest EXISTING ancestor DIRECTORY of p (inclusive) — the
 *  placement-probe anchor before p (or any parent) has been created.
 *  Stops at directories only: `git -C <regular file>` is ENOTDIR, not a
 *  documented negative (audit c3 F2) — e.g. wtRoot under a linked
 *  worktree's `.git` gitfile anchors on the worktree dir itself, whose
 *  probe answer is the honest one. */
function nearestExisting(p: string): string {
  let cur = p;
  for (;;) {
    try {
      if (statSync(cur).isDirectory()) return cur;
      // exists but is not a directory (e.g. a `.git` gitfile): keep walking
    } catch (err) {
      // ONLY a genuine ENOENT/ENOTDIR means "keep walking up". Anything
      // else (EACCES, ELOOP, EIO) is an inability to PROVE the placement is
      // outside every repo — fail CLOSED rather than skip the ancestor and
      // risk provisioning inside a foreign repo (audit C2).
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new WorktreeProvisionError("git-failed", `cannot inspect ${cur} while validating wtRoot placement (${code}) — refusing to guess`);
      }
    }
    const parent = resolve(cur, "..");
    if (parent === cur) return cur; // filesystem root (existsSync should stop us)
    cur = parent;
  }
}

/**
 * True when a registry entry's directory is GONE. git marks unlocked
 * vanished entries `prunable`, but NEVER marks a LOCKED one (locked means
 * "admin metadata is held on purpose") — so locked entries need an
 * explicit directory check or they masquerade as live (audit ds-c1 F3:
 * prune() skipped them silently and ensure() returned preexisting:true
 * for a vanished locked dir; verified: `worktree list --porcelain` shows
 * `locked` with NO `prunable` line after rm -rf of a locked worktree).
 */
async function entryGone(entry: WorktreeEntry): Promise<boolean> {
  if (entry.prunable) return true;
  // ds-c3 F1 adjudication: the auditor claimed unlocked entries whose
  // directory was deleted AND RECREATED escape `prunable` (git would see
  // the path exist and call it live). DISPROVEN experimentally twice on
  // git 2.54 (locked and unlocked): git's prune check inspects the
  // GITFILE <path>/.git, not <path> — a recreated plain directory still
  // lists `prunable gitdir file points to non-existent location`. So
  // unlocked entries need no extra stat (and none is done: a redundant
  // stat that fails for permission reasons would falsely claim staleness
  // where git says healthy). Only LOCKED entries need our own check —
  // git never marks them prunable, whatever it finds on disk.
  if (entry.locked) return !(await gitfileExists(entry.path));
  return false;
}

/** True when `<p>/.git` exists (file OR dir): the definition of a live
 *  linked-worktree checkout. Stat errors (ENOENT etc.) mean absent. */
async function gitfileExists(p: string): Promise<boolean> {
  try {
    await stat(join(p, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** True when ANY filesystem entry (dir, file, symlink — live OR dangling)
 *  sits at p. lstat, not stat: a dangling symlink IS an occupant (git's
 *  own `worktree add` refuses it), and swallowing its ENOENT here would
 *  hand the refusal to raw git-failed — the exact class ds-c4 F3 typed
 *  (ds-c5 F5). Only ENOENT/ENOTDIR mean "nothing here"; any other stat
 *  error fails CLOSED as occupied. */
async function pathOccupied(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}
