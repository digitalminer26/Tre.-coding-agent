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
 *    --porcelain -uall` output, incl. untracked) unless `force`.
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
import { mkdir, realpath, stat } from "node:fs/promises";
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
  | "unmerged"                  // branch deletion refused: commits past base
  | "no-base-for-branch-delete" // deleteBranch without proof base
  | "prune-refused"             // stale entries exist outside our wtRoot
  | "branch-in-use"             // deleteBranch refused: branch checked out in another worktree
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

/** `--`-separate a rev-like operand (option injection: a leading "-"
 *  stays a positional rev with a real `--` separator, not a prefixed token). */
function revArgs(rev: string): string[] {
  return rev.startsWith("-") ? ["--", rev] : [rev];
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
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
    await execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
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
}

/** All worktrees registered with the repository at repoRoot. */
export async function listWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
  const out = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> | undefined;
  const flush = () => {
    if (cur?.path !== undefined) entries.push({ path: cur.path, head: cur.head ?? "", branch: cur.branch ?? null, prunable: cur.prunable ?? false });
    cur = undefined;
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice("worktree ".length), head: "", branch: null, prunable: false };
    } else if (cur !== undefined && line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length);
    } else if (cur !== undefined && line.startsWith("branch refs/heads/")) {
      cur.branch = line.slice("branch refs/heads/".length);
    } else if (cur !== undefined && line.startsWith("prunable")) {
      cur.prunable = true;
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
    await mkdir(wtArg, { recursive: true });
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
      if (entry.prunable) {
        throw new WorktreeProvisionError("stale-registration", `worktree at ${path} is registered but its directory is gone — call prune() first`);
      }
      if (mode === "branch" && entry.branch !== branch) {
        throw new WorktreeProvisionError("foreign-branch", `worktree ${path} is on branch ${JSON.stringify(entry.branch ?? "(detached)")}, expected ${JSON.stringify(branch)} — refusing to adopt`);
      }
      if (mode === "detached" && entry.branch !== null) {
        throw new WorktreeProvisionError("foreign-branch", `worktree ${path} is on branch ${JSON.stringify(entry.branch)} but detached provisioning was requested — refusing to adopt`);
      }
      return { episodeId, taskId, path: entry.path, branch: entry.branch, head: entry.head, baseCommit: baseSha, repoRoot: this.repoRoot, preexisting: true };
    }

    // Unregistered target: a directory git does not manage is never
    // adopted and never implicitly deleted (git would refuse too — the
    // explicit error keeps the contract independent of git's wording).
    if (await dirExists(path)) {
      throw new WorktreeProvisionError("path-exists", `directory ${path} exists but is not a worktree of ${this.repoRoot} — refusing (never delete unmanaged paths)`);
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
        await git(this.repoRoot, ["worktree", "add", "--quiet", path, branch as string]);
      } else {
        await git(this.repoRoot, ["worktree", "add", "--quiet", "--no-track", "-b", branch as string, path, baseSha]);
      }
    }

    const head = await gitVerify(path, ["rev-parse", "HEAD"]);
    if (head === null || head !== baseSha) {
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
    if (entry.prunable) {
      throw new WorktreeProvisionError("stale-registration", `worktree at ${path} is registered but its directory is gone — call prune() first`);
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
   *  - then `worktree remove` (--force only when forced), then `branch -D`
   *    AFTER the manual base-pinned gate (never `branch -d`: its
   *    heuristic is merged-into-HEAD, not base-relative). A branch
   *    checked out in another worktree makes `branch -D` fail —
   *    surfaced, not bypassed.
   */
  async removeTaskWorktree(params: RemoveTaskWorktreeParams): Promise<RemoveReport> {
    const { episodeId, taskId } = params;
    assertSafeComponent("episodeId", episodeId);
    assertSafeComponent("taskId", taskId);
    const force = params.force === true;
    const path = this.taskPath(taskId);
    const entry = (await listWorktrees(this.repoRoot)).find((e) => pathsEqual(e.path, path));
    if (entry === undefined) {
      if (await dirExists(path)) {
        throw new WorktreeProvisionError("not-registered", `${path} is not a worktree of ${this.repoRoot} — refusing to delete an unmanaged directory`);
      }
      return { episodeId, taskId, path, branch: null, worktreeRemoved: false, branchDeleted: false, forced: false, noop: true };
    }
    if (entry.prunable) {
      throw new WorktreeProvisionError("stale-registration", `worktree at ${path} is registered but its directory is gone — call prune() instead of remove`);
    }
    const expected = taskBranchName(episodeId, taskId);
    if (entry.branch !== null && entry.branch !== expected) {
      throw new WorktreeProvisionError("foreign-branch", `worktree ${path} is on branch ${JSON.stringify(entry.branch)} — refusing to remove a foreign worktree`);
    }

    // Dirty gate (strictly conservative: includes untracked).
    const status = await git(entry.path, ["status", "--porcelain", "--untracked-files=all"]);
    if (status.trim() !== "" && !force) {
      throw new WorktreeProvisionError("dirty", `worktree ${path} has uncommitted changes — refusing to remove (force to discard)`, { stderr: status.slice(0, 2000) });
    }

    if (params.deleteBranch === true && entry.branch !== null) {
      // Pre-gate (audit F5): a branch checked out in ANOTHER worktree
      // would let `worktree remove` succeed and then fail `branch -D` —
      // a partial mutation. Refuse BEFORE touching anything.
      const users = (await listWorktrees(this.repoRoot)).filter((e) => e.branch === entry.branch && !pathsEqual(e.path, entry.path));
      if (users.length > 0) {
        throw new WorktreeProvisionError("branch-in-use", `branch ${entry.branch} is also checked out at ${users.map((u) => u.path).join(", ")} — refusing partial removal`);
      }
      if (!force) {
        const base = params.baseCommit;
        if (base === undefined || base === "") {
          throw new WorktreeProvisionError("no-base-for-branch-delete", "deleteBranch needs baseCommit to prove the branch is unadvanced (or force)");
        }
        const baseSha = await resolveCommit(this.repoRoot, base);
        const ahead = await git(this.repoRoot, ["rev-list", "--max-count=1", `${baseSha}..${entry.branch}`]);
        if (ahead.trim() !== "") {
          throw new WorktreeProvisionError("unmerged", `branch ${entry.branch} has commits past ${baseSha} — integration is P12; refusing to delete (force discards)`);
        }
      }
    }

    await git(this.repoRoot, ["worktree", "remove", ...(force ? ["--force"] : []), entry.path]);
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
  async prune(): Promise<{ removed: string[]; refusedForeign: string[] }> {
    const before = await listWorktrees(this.repoRoot);
    const stale = before.filter((e) => e.prunable);
    const foreign = stale.filter((e) => !pathsEqual(e.path, this.wtRoot) && !isWithin(e.path, this.wtRoot));
    if (foreign.length > 0) {
      return { removed: [], refusedForeign: foreign.map((e) => e.path).sort() };
    }
    if (stale.length === 0) return { removed: [], refusedForeign: [] };
    await git(this.repoRoot, ["worktree", "prune"]);
    const after = new Set((await listWorktrees(this.repoRoot)).map((e) => e.path));
    const removed = stale.filter((e) => !after.has(e.path)).map((e) => e.path).sort();
    this.warn(`worktree prune: removed ${removed.length} stale registration(s): ${removed.join(", ")}`);
    return { removed, refusedForeign: [] };
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
 * Compare a registry path with our computed path, both derived from
 * realpath'd anchors (repo toplevel / wtRoot) + git-relative components,
 * so plain string equality is correct — registry paths may name deleted
 * directories, which is exactly why NEITHER side is realpath'd again
 * (a realpath call on a stale entry would throw and mask the mismatch).
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
    } catch {
      // does not exist (or is unreachable) — walk up
    }
    const parent = resolve(cur, "..");
    if (parent === cur) return cur; // filesystem root (existsSync should stop us)
    cur = parent;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
