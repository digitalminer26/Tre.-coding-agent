/**
 * P7 — attempt runner & ownership recovery (docs/11 §11.1 P7, §13.2 I1/I2,
 * §14.1 attempt identity, §14.5 derived ownership, S6).
 *
 * The process-control primitive every later phase (P9 supervisor, P11
 * recovery executor) must route through — nothing spawns or stops a
 * managed worker except here, so the ownership fences cannot be worked
 * around. Primitives only; no scheduler lives in this file.
 *
 * Ownership model (§14.5 — derived, never declared):
 *  - Attempt identity is the durable `kind:"attempt"` record (§14.1), not
 *    a PID. state.json is a CACHE (S6): the journal itself is the
 *    liveness-discovery source — resolve "ok" records carry the recorded
 *    pid/pgid (audit F1/F2/F5/F6), so a supervisor restart never needs a
 *    hint row to find the process it must reconcile against, and a
 *    single-row-per-task hint can neither add nor remove a claim.
 *  - Spawn is intent-first (I2): the unresolved attempt record is appended
 *    and fsynced BEFORE the process exists. A crash between log and act
 *    leaves "intent without outcome" ⇒ discover-or-park. ENFORCED:
 *    run()/resume() refuse while any attempt CLAIMING THE TASK'S SESSION
 *    PATH (any task — §14.5 joins on session+worktree, not taskId) lacks
 *    disproven liveness — live child ⇒ `ownership-fence` /
 *    `already-running`, discovered running pid ⇒ `prior-attempt-running`,
 *    unprovable ⇒ `prior-attempt-unresolved` (park; resolve against
 *    observed reality via `confirmStopped` before any re-spawn).
 *  - I1: a replacement worker starts only after the prior holder of the
 *    session path is CONFIRMED stopped — waitpid-class evidence is our
 *    own child's 'exit' event COMBINED WITH a group-liveness sweep (F3:
 *    the leader exiting is not the group exiting); the only other
 *    accepted evidence is the caller's explicit `confirmStopped`
 *    (positive evidence, not silence — I3). A discovered-alive prior is
 *    never killed to take over: that races the very invariant the fence
 *    protects. PARK.
 *  - Bounded liveness (F1/F2/H2-7/F6, §14.1): per session path, blocking
 *    is ANCHORED at the newest tuple (spawnGen where journalled, else
 *    DURABLE LOG POSITION — append order, anchored at each tuple's OWN
 *    successful spawns — never wall-clock ts, never the lexical id), but
 *    "newest" is a SUPERSESSION ceiling, not the whole rule: an older
 *    tuple is released by a newer one ONLY when its own evidence is
 *    deterministically negative. Exemptions (each parks on its own
 *    evidence even under a newer tuple): (1) positive or inconclusive
 *    process/group probe (H2-3); (2) survivor-class ownership (G3);
 *    (3) a cohort-scoped UNPROBEABLE observed-ok claim — a spawn
 *    observed "ok" whose cohort journalled no pid (audit cycle R2, F6:
 *    identifiers of OTHER cohorts describe OTHER processes; only
 *    same-cohort enrichment, or an S6 hint row when the tuple has no
 *    journal pid at all (F10), discharges it). Supersession applies
 *    ONLY when the newest tuple's spawn outcome is resolved
 *    ("ok"/"failed"): an unresolved intent (crashed spawner) has
 *    possibly never observed the prior at all and never erases it.
 *    A never-observed-ok identifier-less unresolved intent is released
 *    by ordering alone — and that escape is operator-level only, never
 *    autonomously reachable (F4, audit cycle R1; see markSuperseded).
 *  - Concurrency (F7): run()/resume() are serialized per episode
 *    instance (promise mutex) AND the child entry is registered
 *    synchronously at the spawn call — two concurrent callers cannot
 *    both pass the fence, both allocate the same attemptId, or both
 *    spawn against one session path.
 *
 * Durability (§13.1 scoping): journal appends are sync-before-return
 * (DecisionJournal); state.json writes are tmp+fsync+rename. Process-
 * death durability only — no power-failure claim.
 *
 * Compartment: node: builtins + src/episode/journal.ts (the P4 journal
 * primitives) only. P7 is the "until the supervisor lands" consumer the
 * P4 guard names — the first module allowed to write episode files.
 */
import { spawn as nodeSpawn, execFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import {
  DecisionJournal,
  episodeDir,
  newDecisionId,
  readEpisodeState,
  writeEpisodeState,
  STATE_SCHEMA_ID,
  type AttemptRecord,
  type EpisodeState,
  type SupervisorRecord,
} from "../episode/journal.js";

const execFileAsync = promisify(execFile);

// ────────────────────────────── errors ──────────────────────────────────────

export type RunnerErrorCode =
  | "bad-input"                // ids/state invalid before any side effect (fail fast, zero mutation)
  | "ownership-fence"          // I1: a live attempt holds the session path (or this episode's runner slot is taken)
  | "prior-attempt-running"    // I1/I2: unresolved-or-ok attempt DISCOVERED alive — park, never kill-to-take-over
  | "prior-attempt-unresolved" // I2: unresolved intent / unprovable liveness — park or confirmStopped first
  | "already-running"          // this supervisor already has a live child for that exact attempt
  | "not-running"              // stop(): no live child was started here for that session
  | "spawn-failed"             // child could not be spawned (the intent record is resolved "failed")
  | "journal-failed";          // journal operation failed (divergence guard — the journal is authority; reopen before retry)

export class RunnerError extends Error {
  constructor(readonly code: RunnerErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "RunnerError";
  }
}

// ────────────────────────────── task identity ───────────────────────────────

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*-a[0-9]+$/;

// E (audit): bound on waiting for the leader to actually exit after an
// escalation to SIGKILL. An unsignalizable leader (EPERM) would make an
// unbounded exit wait a hang — on timeout the verdict is "unknown".
const POST_KILL_EXIT_WAIT_MS = 2_000;

/** Task identity for one run/resume. `session` is the worker session FILE
 *  path — the resource the ownership fence is drawn on (§14.5 pairs
 *  session+worktree; later phases layer the worktree fence on this
 *  primitive). Paths are CANONICALIZED (absolute, `~`-expanded) before
 *  any use: fence keys, record fields, and hints all derive from the
 *  canonical form, so `./s.jsonl`, `/abs/s.jsonl`, and `~/…/s.jsonl` can
 *  never become two identities for one file. Validated before ANY
 *  filesystem or process side effect. */
export interface AttemptTask {
  episodeId: string;
  taskId: string;
  /** Worker session file path (must live OUTSIDE the worktree, S4). */
  session: string;
  /** Caller-proposed attemptId (fresh runs: a candidate for max+1 only —
   *  the RUNNER allocates, §14.1). */
  attemptId?: string;
  taskRevision?: number;
  model?: string;
  worktreePath?: string;
}

function assertTask(t: AttemptTask, runnerEpisodeId: string): void {
  if (typeof t !== "object" || t === null || Array.isArray(t)) throw new RunnerError("bad-input", "task must be an object");
  if (typeof t.episodeId !== "string" || t.episodeId.length === 0) throw new RunnerError("bad-input", "task.episodeId must be a non-empty string");
  if (typeof t.taskId !== "string" || !SAFE_ID.test(t.taskId)) throw new RunnerError("bad-input", `task.taskId: unsafe component ${JSON.stringify(t.taskId)}`);
  if (typeof t.session !== "string" || t.session.length === 0) throw new RunnerError("bad-input", "task.session must be a non-empty path");
  if (t.episodeId !== runnerEpisodeId) throw new RunnerError("bad-input", `task.episodeId ${JSON.stringify(t.episodeId)} does not match this runner's episode ${JSON.stringify(runnerEpisodeId)}`);
  if (t.attemptId !== undefined && !ATTEMPT_ID.test(t.attemptId)) throw new RunnerError("bad-input", `attemptId must match "<taskId>-a<N>" (got ${JSON.stringify(t.attemptId)})`);
  // schema parity: AttemptRecord.taskRevision is integer >= 1
  if (t.taskRevision !== undefined && (!Number.isInteger(t.taskRevision) || t.taskRevision < 1)) throw new RunnerError("bad-input", "taskRevision must be an integer >= 1");
}

/** Canonicalize a path to the exact string the fence keys on (F8):
 *  `~`-expanded, absolute, `.`/`..` collapsed. NOT realpath-based:
 *  the session file may not exist yet, and symlink aliasing two fence
 *  identities is documented in close(`--session` must use one path). */
export function canonicalPath(p: string): string {
  let s = p;
  if (s === "~" || s.startsWith("~/")) s = join(homedir(), s.slice(2) === "" ? "." : s.slice(2));
  return resolvePath(s);
}

/** F4: canonical copy of a task (session + worktree fence paths). Every
 *  entry point (run/resume/stop/reconcile/confirmStopped/writeStateHint)
 *  routes through this BEFORE any comparison, record field, map key, or
 *  spawn argv — record/fence/map identity is derived from the canonical
 *  form so `/s/t1.jsonl` and `/s/../s/t1.jsonl` are ONE resource. */
function canonicalTask(t: AttemptTask): AttemptTask {
  if (typeof t !== "object" || t === null) return t; // assertTask reports the shape error
  const out: AttemptTask = { ...t };
  if (typeof out.session === "string" && out.session.length > 0) out.session = canonicalPath(out.session);
  if (typeof out.worktreePath === "string" && out.worktreePath.length > 0) out.worktreePath = canonicalPath(out.worktreePath);
  return out;
}

/** The attempt counter inside "t2-a3" ("t2-a10" → 10; malformed → 0). */
export function attemptNumber(attemptId: string): number {
  const m = /-a([0-9]+)$/.exec(attemptId);
  return m ? Number(m[1]) : 0;
}

/** The next attemptId for a task: 1 + the max over EVERY candidate
 *  (durable records, state.json hint, caller's fresh proposal) — never
 *  resets on supervisor restart (§14.1 allocation is derived from all
 *  sources, §14.5). */
export function nextAttemptId(taskId: string, ...candidates: (string | undefined)[]): string {
  let max = 0;
  for (const c of candidates) if (typeof c === "string") max = Math.max(max, attemptNumber(c));
  return `${taskId}-a${max + 1}`;
}

// ────────────────────────────── worker spawning ─────────────────────────────

export interface WorkerSpawn {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** MUST lead the worker's own process group — the group-leader
   *  contract (G1, P7 audit). The runner spawns with `detached:true` so
   *  stop() signals the whole tree (`kill -TERM -pgid`) and group death
   *  is determinable via kill(-pgid,0) → ESRCH. A grandchild that
   *  outlives its parent is the exact I1 hazard a bare `child.kill()`
   *  would paper over. `detached:false` is REFUSED by validateSpawnSpec
   *  (an inherited group is unsweepable and its survivor class is
   *  forever undisprovable); omit the field or set true. */
  detached?: boolean;
}

export interface WorkerSpawner {
  readonly kind: string;
  spawn(task: AttemptTask, attemptId: string, opts?: { resume?: boolean }): WorkerSpawn;
}

/** Default spawner contract, matched to the REAL CLI (audit F-8):
 *  fresh → `tre. --session <file>` (created if absent), resume →
 *  `tre. --resume <file>` — XOR, never both (main.ts rejects the pair
 *  with exit 2). The old default emitted `--attempt-id`, which the CLI
 *  does not accept, and emitted --resume AND --session together on
 *  resume: invoking the built CLI produced exit 2 while the runner
 *  still recorded ok (stdio ignored). attemptId/episode identity rides
 *  in the environment (TRE_ATTEMPT_ID / TRE_EPISODE_ID), where an
 *  unknown variable cannot break argv parsing; validateSpawnSpec
 *  enforces the same invariants for custom spawners. The session path
 *  is the CANONICAL one (F-4 canonicalTask) so a misconfigured command
 *  can neither drop the managed-mode identity nor point a worker at a
 *  non-canonical path. */
export function treWorkerSpawner(command = "tre.", baseArgs: string[] = []): WorkerSpawner {
  return {
    kind: `tre:${command}`,
    spawn(task, attemptId, opts) {
      const args = [...baseArgs];
      // XOR: exactly one of --resume / --session, and never --attempt-id.
      args.push(opts?.resume ? "--resume" : "--session", task.session);
      return {
        command,
        args,
        cwd: task.worktreePath,
        env: { ...process.env, TRE_ATTEMPT_ID: attemptId, TRE_EPISODE_ID: task.episodeId, TRE_TASK_ID: task.taskId },
      };
    },
  };
}

/** Validate one WorkerSpawn spec: a bare non-empty string command with
 *  no argv discipline is NOT a managed worker. F-8: the managed-mode
 *  argv contract is enforced here too — the flags the worker's real CLI
 *  rejects (--attempt-id; --resume together with --session) fail
 *  validation BEFORE the spawn is attempted, so the runner can never
 *  record "ok" over an argv the CLI exits 2 on. */
export function validateSpawnSpec(spec: WorkerSpawn, commandExists: (cmd: string) => boolean): string | undefined {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return "spec must be an object";
  if (typeof spec.command !== "string" || spec.command.length === 0) return "command must be a non-empty string";
  if (!Array.isArray(spec.args) || spec.args.some((a) => typeof a !== "string")) return "args must be an array of strings";
  if (spec.command.includes("\0") || spec.args.some((a) => a.includes("\0"))) return "command/args must not contain NUL";
  if (spec.args.includes("--attempt-id")) return 'args must not contain "--attempt-id" (not accepted by the tre. CLI; attempt identity is passed via TRE_ATTEMPT_ID)';
  if (spec.args.includes("--resume") && spec.args.includes("--session")) return 'args must not contain both "--resume" and "--session" (mutually exclusive per the tre. CLI)';
  // G1 (P7 audit): GROUP-LEADER CONTRACT. A non-detached worker shares
  // the SUPERVISOR's own process group: stop() cannot sweep or probe it,
  // a forked grandchild survives its leader, and no evidence path ever
  // disproves that survivor class — the session would stay fenced
  // forever. Managed workers MUST lead their own group; a spawner asking
  // for detached:false is refused here (before the fork), not silently
  // coerced.
  if (spec.detached !== undefined && spec.detached !== true) return 'detached must be omitted or true (group-leader contract G1: every managed worker leads its own process group so stop() can sweep the whole tree); any other value, including false and falsy non-booleans, is rejected';
  if (!commandExists(spec.command)) return `command ${JSON.stringify(spec.command)} is not executable (bare strings are not resolved via a shell by the runner)`;
  return undefined;
}

// ────────────────────────────── reconcile views ─────────────────────────────

/** One durable attempt record plus OUR evidence-backed view of its
 *  process: `live` is set ONLY from waitpid-class evidence (a child of
 *  THIS supervisor instance); ps-probe verdicts land in `probe`.
 *  `superseded` (F1/F2): a newer tuple on the SAME session path had
 *  spawn evidence — this tuple can no longer block a spawn. */
export interface AttemptView {
  record: AttemptRecord;
  /** Own-child liveness (this supervisor started it): true live, false
   *  exited (waitpid-class), undefined not our child. */
  live?: boolean;
  /** ps-probe verdict on the recorded pid (journal-recorded pid when
   *  present — the durable source — else the matching state.json hint
   *  row; only when we are not the parent). */
  probe?: { pid: number; running: boolean | undefined; sameUid?: boolean };
  /** F5 (audit): kill(-pgid,0) verdict on the RECORDED process group.
   *  Leader death alone is NOT group death — a crashed worker may leave
   *  grandchildren running in its group. true = members exist (park),
   *  false = ESRCH group confirmed gone (death proof covering leader
   *  AND descendants), undefined = undeterminable (EPERM ⇒ park). */
  groupProbe?: { pgid: number; running: boolean | undefined };
  /** G1 (P7 audit): the attempt's TUPLE carries an UNDISPROVABLE group
   *  claim. Assignment is EXACTLY `survivorTupleClaim(tuple)` (see that
   *  function — tuple-historic, NOT latest-record-derived): (a) any
   *  non-confirmation, non-failed record with `detached:false` ⇒ true
   *  (inherited foreign group — contradiction, worse reading wins);
   *  (b) any spawn cohort (spawnGen; undefined ⇒ one "legacy" cohort)
   *  that journalled a pid with NO group identity (no pgid, no
   *  detached:true) that no proven-mode record OF THAT SAME COHORT
   *  rehabilitated ⇒ true (spawn mode never recorded); (c) otherwise
   *  false — INCLUDING identifier-less unresolved intents (nothing to
   *  un-prove) and detached:true-without-pgid claims (proven mode
   *  implies the determinable hypothetical group pgid===pid). A dead
   *  leader is NOT group death: `stopped` and a failed LATEST do not
   *  clear ownership — only an OBSERVED group death (kill(-pgid,0)
   *  ESRCH via reaping) or an evidence-bearing confirm against proven
   *  group identity does; same-cohort proven-mode enrichment (a record
   *  OF THE UNPROVEN PID'S OWN generation journalling it detached/pgid)
   *  clears class (b) at classification time (F8, audit cycle R2).
   *  Unprobeable observed-ok claims are separately flagged per cohort
   *  in `protectedOk`. */
  ownership?: boolean;
  /** Newest-tuple-per-session rule (see header): true ⇒ NOT part of
   *  `unresolved`/`blocking` (advisory detail for reconcile callers). */
  superseded?: boolean;
  /** H3-R2/F6 (audit cycles R1-R2): this tuple contains a spawn cohort
   *  (spawn identity) whose spawn was POSITIVELY observed "ok" but
   *  NEVER journalled a pid — the claim has no probeable identity, so
   *  its death can NEVER be disproven. Identifiers from OTHER cohorts
   *  describe OTHER processes and cannot discharge it (F6). Blocks by
   *  ordering-proof immunity; exits only via same-cohort enrichment
   *  (a record OF THAT COHORT journaling a pid) or manual repair. */
  protectedOk?: AttemptRecord;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

/** Derived ownership for one task (§14.5): latest record per attempt
 *  tuple, unresolved spawns, confirmed-live children, and the
 *  session-joined view (`blocking`/`superseded` span ALL tasks). */
export interface OwnershipView {
  episodeId: string;
  taskId: string;
  latest?: AttemptView;
  /** Unresolved spawn intents of THIS task that still block (not superseded). */
  unresolved: AttemptView[];
  /** Attempts of this task with confirmed-live processes (own child). */
  live: AttemptView[];
  /** Live children (this instance) of OTHER tasks claiming the same
   *  session path — the fence joins on session, not task (§14.5). */
  foreignLive: { attemptId: string; taskId: string }[];
  /** Every non-superseded tuple (ANY task) whose liveness is not
   *  disproven — the full fence set (§14.5: ownership joins on
   *  session+worktree, not taskId — F4). */
  blocking: AttemptView[];
  /** This task's tuples displaced by a newer tuple on their session
   *  path (F1/F2) — kept for audit, never blocking. */
  superseded: AttemptView[];
}

export interface ReconcileDecision {
  episodeId: string;
  taskId: string;
  /** "spawn" is permitted ONLY when every claim on the task's session
   *  path (every task, §14.5) is confirmed stopped, superseded, or
   *  resolved-failed AND nothing was discovered alive. Anything else
   *  parks — the conservative fallback (I1/I2). */
  action: "spawn" | "park" | "running";
  reasons: string[];
}

export interface ReconcileResult {
  episodeId: string;
  taskId: string;
  decision: ReconcileDecision;
  ownership: OwnershipView;
  /** Every ps probe this reconcile performed (audit trail). */
  probes: { pid: number; running: boolean | undefined; sameUid?: boolean }[];
}

// ────────────────────────────── handles & results ───────────────────────────

export interface AttemptHandle {
  episodeId: string;
  taskId: string;
  attemptId: string;
  session: string;
  pid?: number;
  detached: boolean;
  /** Never rejects: resolves with the waitpid-class exit evidence. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Set when the S6 pid-hint write failed AFTER a durable spawn: the
   *  journal (authority) is consistent; the hint is stale. Surfaced, not
   *  swallowed — callers may retry `writeStateHint`. */
  stateWarning?: string;
}

export interface StopResult {
  attemptId: string;
  /** true ONLY when the direct child exited AND (detached spawns) the
   *  process group's death was CONFIRMED via kill(-pgid,0) → ESRCH.
   *  Leader exit alone never claims the group is gone (audit F-5). */
  stopped: boolean;
  /** true when SIGTERM was ignored and SIGKILL (process-group) was used. */
  escalated: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** F5 group-level verdict AFTER the exit event (kill(-pgid,0) class):
   *  "reaped" — whole group gone (stopped:true means what it says);
   *  "alive" — members survived even the SIGKILL sweep: a replacement
   *  spawn for this session stays fenced;
   *  "unknown" — group liveness not determinable (EPERM) — park.
   *  G1 (P7 audit): a NON-detached child stops with "unknown" too —
   *  its inherited group has no controllable pgid, so whole-group death
   *  can never be claimed from the leader's exit. */
  groupStatus?: "reaped" | "alive" | "unknown";
}

// ────────────────────────────── the runner ──────────────────────────────────

export interface PidStatus {
  running: boolean;
  /** true when the pid belongs to THIS euid (a foreign-uid running hit on
   *  our hint means the row is not ours to judge — unprovable). */
  sameUid: boolean;
}

export interface AttemptRunnerOptions {
  /** Episodes root containing `<episodeId>/` scaffolds (S4, Q3: ~/.tre/episodes). */
  root: string;
  episodeId: string;
  /** Worker spawner; default `treWorkerSpawner()`. */
  spawner?: WorkerSpawner;
  /** SIGTERM→SIGKILL escalation delay; default 5000 ms. */
  stopTimeoutMs?: number;
  /** Injectable process probes (tests; default same-uid `ps -p`). */
  probes?: { pidAlive?: (pid: number) => Promise<PidStatus | undefined> };
  /** Executable check for spawn-spec validation (F11; tests inject).
   *  Default: an absolute path must exist and be executable, a bare name
   *  must resolve on $PATH. */
  commandCheck?: (command: string) => boolean;
}

interface ChildEntry {
  child: ReturnType<typeof nodeSpawn>;
  task: AttemptTask;
  attemptId: string;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** process-group id captured at 'spawn' (detached ⇒ pgid === pid). */
  pgid?: number;
  settle: (v: { code: number | null; signal: NodeJS.Signals | null }) => void;
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Lifecycle-transition recency is CAUSAL, never wall-clock (audit F1):
 * a record's position in the journal's APPEND ORDER IS its causality.
 * `record.ts` is the machine clock — it can step backward and collides
 * within one millisecond across generations — and `id` is a random UUID
 * whose lexical order carries no causal meaning, so ordering transitions
 * by ts/id could invert a supersede and a stop recorded microseconds
 * apart. The seq map (append index per record id, first occurrence wins)
 * is built once per reconcile from the already-read records.
 */
/**
 * H3-R1/F3 (audit cycle R1): the survivor OFFENSE witness — the record
 * that CAUSES `survivorTupleClaim` to be true. Unlike the claim (which
 * is existential), the witness must be scoped exactly like it: a
 * mode-unproven record is a witness only when its pid is NOT proven
 * within its OWN cohort (a same-cohort later enrichment removes it from
 * the differential — quoting an enriched record as "permanently
 * unprovable" was the F3 misattribution). A `detached:false` record is
 * an unconditional witness (contradiction clause of the claim). Returns
 * undefined iff the tuple is NOT survivor-class — the predicates are
 * maintained as exact complements.
 */
function survivorOffense(records: SupervisorRecord[]): AttemptRecord | undefined {
  interface Cohort { proven: Set<number>; unproven: AttemptRecord[] }
  const cohorts = new Map<string, Cohort>();
  let contradiction: AttemptRecord | undefined;
  for (const r of records) {
    if (r.kind !== "attempt" || r.confirmation === true || r.spawnOutcome === "failed") continue;
    if (r.detached === false) { if (contradiction === undefined) contradiction = r; continue; }
    const key = typeof r.spawnGen === "number" ? `g${r.spawnGen}` : "legacy";
    let c = cohorts.get(key);
    if (!c) { c = { proven: new Set<number>(), unproven: [] }; cohorts.set(key, c); }
    const provenMode = r.detached === true || typeof r.pgid === "number";
    if (typeof r.pid === "number") {
      if (provenMode) c.proven.add(r.pid);
      else c.unproven.push(r as AttemptRecord);
    }
  }
  if (contradiction !== undefined) return contradiction;
  for (const c of cohorts.values()) {
    for (const r of c.unproven) if (!c.proven.has(r.pid!)) return r;
  }
  return undefined;
}

/**
 * H3-2 (audit cycle 12) — the survivor-class claim, ONE definition
 * shared by the analyze scan and the confirmStopped gate.
 *
 * A tuple (the non-confirmation, non-"failed" records of one
 * attemptId on one session) carries an UNDISPROVABLE group claim when
 * some pid it ever journalled has NO group identity anywhere in the
 * tuple:
 *   - `detached:false`         → the process ran in an INHERITED (foreign)
 *                                group the runner can neither sweep nor
 *                                probe. A later record cannot rehabilitate
 *                                it (contradiction ⇒ take the WORSE reading).
 *   - mode unrecorded + no pgid → spawn mode UNKNOWN: the hypothetical
 *                                pgid===pid probe is unsound, so no probe
 *                                of the leader can ever disprove group
 *                                survivors. This covers UNRESOLVED intents
 *                                too (H3-2): an intent that journalled a
 *                                pid without group identity may have
 *                                started a worker whose group was never
 *                                recorded — exactly the epistemic position
 *                                a late confirmation must not sail past.
 * A pid IS proven when a record of the SAME spawn identity journals it
 * with `detached:true` (group-leader contract: pgid===pid — the G3
 * hypothetical probe is sound) or with an explicit pgid — e.g. an
 * intent stamped without mode that its later "ok" resolve re-records
 * with the mode: the SAME process's group is then known.
 * H3-R1 (audit review): proof is scoped per SPAWN IDENTITY. Records
 * split into cohorts by `spawnGen` (pre-generation legacy records form
 * ONE cohort: they carry no generation to distinguish spawns, so the
 * pre-P8 journal keeps its same-spawn enrichment semantics). A pid
 * journalled WITHOUT group identity is laundered only by a
 * proven-mode record in its OWN cohort — a LATER spawn's `ok`
 * (different gen, possibly the SAME reused numeric pid) is a different
 * process and can never rehabilitate an earlier identifier-less
 * survivor claim. PID reuse across generations must not turn a park
 * into a spawn.
 * Proven classes are NOT survivor: `detached:true + pgid` (private,
 * probeable group) nor `detached:true` alone (pgid===pid implied).
 * Resolved "failed" records are F6 negative evidence (the process NEVER
 * existed); `confirmation` records describe observation time, not spawn
 * time — both excluded.
 */
function survivorTupleClaim(records: SupervisorRecord[]): boolean {
  // One proven/unproven pair per spawn identity (see H3-R1 above).
  interface Cohort { proven: Set<number>; unproven: Set<number> }
  const cohorts = new Map<string, Cohort>();
  for (const r of records) {
    if (r.kind !== "attempt" || r.confirmation === true || r.spawnOutcome === "failed") continue;
    // Contradiction clause: a NON-detached spawn claims an inherited
    // foreign group — unprovable regardless of what else the tuple says.
    if (r.detached === false) return true;
    const key = typeof r.spawnGen === "number" ? `g${r.spawnGen}` : "legacy";
    let c = cohorts.get(key);
    if (!c) { c = { proven: new Set<number>(), unproven: new Set<number>() }; cohorts.set(key, c); }
    const provenMode = r.detached === true || typeof r.pgid === "number";
    if (typeof r.pid === "number") {
      if (provenMode) c.proven.add(r.pid);
      else c.unproven.add(r.pid);
    }
  }
  for (const c of cohorts.values()) {
    for (const pid of c.unproven) if (!c.proven.has(pid)) return true;
  }
  return false;
}

/**
 * H3-R2/F6 (audit cycles R1-R2) — the UNPROBEABLE observed-ok claim.
 * An "ok" record (non-confirmation) journalled WITHOUT a pid is a
 * positive observation of a process the journal can never probe: its
 * death is undisprovable by any evidence this module can gather.
 * Cohort-scoped like `survivorTupleClaim`: identifiers journalled by
 * OTHER spawn identities (other generations, other spawns of the
 * legacy cohort) describe OTHER processes and cannot discharge the
 * claim (F6 laundering: a gen-2 failed record with a dead pid proves
 * only gen-2's non-spawn). Enrichment is order-insensitive within the
 * cohort (a mode-less intent stamped with its pid before/after its ok
 * resolve describes the same process). Returns the offending ok record
 * iff some cohort observed ok with no pid anywhere in that cohort.
 */
function unprobeableOkClaim(records: SupervisorRecord[], hintPids?: number[]): AttemptRecord | undefined {
  interface Cohort { hasIdentity: boolean; okNoPid: AttemptRecord | undefined }
  // F15 (audit cycle R4): the R3 "last confirmation resets the window"
  // rule is DELETED — a `confirmation:true` record alone does NOT prove
  // the confirming implementation satisfied the cohort-wide contract
  // (the pre-R5 confirmStopped checked only the latest cohort, so a
  // journal can legitimately contain `[g1 ok/no-id, g2 ok/dead,
  // g2 confirmation]` — g1 was never discharged). Closure is now
  // EVIDENCE-CARRIED, not position-carried: a confirmation record
  // contributes ONLY the identity it journalls itself (pid/pgid it was
  // appended with — R5 confirmStopped stamps the hint identity it
  // actually probed dead) to its OWN cohort. A confirmation copying
  // gen-2 identity can never discharge a gen-1 claim; a confirmation
  // carrying the probed identity of the claiming cohort closes exactly
  // that claim. Records appended after any confirmation are ordinary
  // cohort members — a later resume's ok-without-pid is a fresh claim
  // in a fresh cohort (or the same cohort: still protected).
  const cohorts = new Map<string, Cohort>();
  // F10 (audit cycle R3): the hint row is the identity of the tuple's
  // LATEST spawn cohort, computed over the COMPLETE cohort history —
  // including FAILED generations (a failed resolve is still a spawn
  // the hint could identify). A legacy (spawnGen-less) tuple is a
  // single cohort, so the hint is its latest. If the latest cohort
  // holds no claim entry (failed-only), the hint enriches nothing.
  let latestKey = "legacy";
  let maxGen = Number.NEGATIVE_INFINITY;
  let anyRecord = false;
  for (const r of records) {
    if (r.kind !== "attempt" || r.confirmation === true) continue;
    anyRecord = true;
    if (typeof r.spawnGen === "number" && r.spawnGen > maxGen) { maxGen = r.spawnGen; latestKey = `g${r.spawnGen}`; }
  }
  if (!anyRecord) return undefined;
  for (const r of records) {
    if (r.kind !== "attempt" || r.confirmation === true || r.spawnOutcome === "failed") continue;
    const key = typeof r.spawnGen === "number" ? `g${r.spawnGen}` : "legacy";
    let c = cohorts.get(key);
    if (!c) { c = { hasIdentity: false, okNoPid: undefined }; cohorts.set(key, c); }
    if (typeof r.pid === "number" || typeof r.pgid === "number") c.hasIdentity = true;
    if (r.spawnOutcome === "ok" && c.okNoPid === undefined) c.okNoPid = r as AttemptRecord;
  }
  // F15: a confirmation's journalled identity enriches ONLY the cohort
  // it copies (its `spawnGen`): the confirmation attests that THIS
  // identity was probed dead at confirm time. It creates no cohort,
  // claims nothing, and reaches no other cohort.
  for (const r of records) {
    if (r.kind !== "attempt" || r.confirmation !== true) continue;
    if (typeof (r as AttemptRecord).pid !== "number" && typeof (r as AttemptRecord).pgid !== "number") continue;
    const key = typeof r.spawnGen === "number" ? `g${r.spawnGen}` : "legacy";
    const c = cohorts.get(key);
    if (c) c.hasIdentity = true;
  }
  const hintCohort = hintPids !== undefined && hintPids.length > 0 ? cohorts.get(latestKey) : undefined;
  if (hintCohort) hintCohort.hasIdentity = true;
  for (const c of cohorts.values()) if (c.okNoPid !== undefined && !c.hasIdentity) return c.okNoPid;
  return undefined;
}

/**
 * F12 (audit cycle R3) / F16 (audit cycle R4): ONE identity-enrichment
 * contract shared by analyze and confirmStopped. An S6 hint row supplies
 * the tuple's process identity ONLY when the tuple journalled NO pid
 * anywhere (the same rule as the legacy-hint probe-candidate path):
 * rows match on attemptId + sessionPath exactly. F16: EVERY matching
 * row across ALL task keys is accepted — analyze probes all of them and
 * confirmStopped must probe the SAME accepted set (R3 accepted only
 * the first match and probed only the own-task row, so a live row
 * under `tasks.t2` was enrichment for analyze but invisible to
 * confirmation: reconcile parked, confirm succeeded, run refused).
 * Returns tuple-key -> the FULL accepted hint-pid set (deduped).
 */
function hintEnrichment(records: SupervisorRecord[], state: { tasks?: Record<string, { attemptId?: string; session?: string; pid?: number } | undefined> } | undefined, episodeId: string): Map<string, number[]> {
  const journalHasPid = new Map<string, boolean>();
  const byAttemptSession = new Map<string, string>(); // "attemptId\u0000session" -> tupleKey
  for (const r of records) {
    if (r.kind !== "attempt" || r.episodeId !== episodeId || r.confirmation === true) continue;
    const key = tupleKey(r);
    if (typeof (r as AttemptRecord).pid === "number") journalHasPid.set(key, true);
    byAttemptSession.set(`${r.attemptId}\u0000${(r as AttemptRecord).sessionPath}`, key);
  }
  const out = new Map<string, number[]>();
  for (const row of Object.values(state?.tasks ?? {})) {
    if (!row || typeof row.attemptId !== "string" || typeof row.pid !== "number" || typeof row.session !== "string") continue;
    const key = byAttemptSession.get(`${row.attemptId}\u0000${row.session}`);
    if (key === undefined || journalHasPid.get(key)) continue;
    const set = out.get(key) ?? [];
    if (!set.includes(row.pid)) { set.push(row.pid); out.set(key, set); }
  }
  return out;
}

function seqMapOf(records: SupervisorRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  records.forEach((r, i) => {
    if (!m.has(r.id)) m.set(r.id, i);
  });
  return m;
}

const runners = new Map<string, AttemptRunner | Promise<AttemptRunner>>();

/**
 * Controlled worker spawn/stop for managed attempts + lost-supervisor
 * reconcile (discover-or-park). ONE instance per episode per process
 * (exclusive journal writer — the P4 caller contract; enforced here
 * within the process, cross-process remains the supervisor's fence).
 */
export class AttemptRunner {
  private readonly journal: DecisionJournal;
  private readonly children = new Map<string, ChildEntry>(); // key: session file path
  private readonly stopTimeoutMs: number;
  private readonly pidProbeImpl: (pid: number) => Promise<PidStatus | undefined>;
  private readonly commandCheck: (command: string) => boolean;
  private readonly spawner: WorkerSpawner;
  private readonly root: string;
  private readonly episodeId: string;
  /** F7: serialization queue for run()/resume() — the fence, the
   *  attemptId allocation, the intent append, and the child registration
   *  are ONE critical section per episode instance. */
  private spawnQueue: Promise<unknown> = Promise.resolve();
  private spawnActive = 0; // F3: count of queued-or-active spawn transactions
  private closed = false;

  private constructor(opts: AttemptRunnerOptions, journal: DecisionJournal) {
    this.root = opts.root;
    this.episodeId = opts.episodeId;
    this.journal = journal;
    this.stopTimeoutMs = opts.stopTimeoutMs ?? 5000;
    this.pidProbeImpl = opts.probes?.pidAlive ?? defaultPidProbe;
    this.commandCheck = opts.commandCheck ?? defaultCommandExists;
    this.spawner = opts.spawner ?? treWorkerSpawner();
  }

  /** Open (and register) the runner for one episode directory. `root` is
   *  canonicalized (F8) so relative/absolute spellings of the same
   *  episodes root cannot open two runners on one journal. Throws
   *  `ownership-fence` when an instance is already open for the same
   *  episode in this process — two runners on one journal is exactly the
   *  fence violation this module exists to prevent. */
  static async open(opts: AttemptRunnerOptions): Promise<AttemptRunner> {
    if (typeof opts.root !== "string" || opts.root.length === 0) throw new RunnerError("bad-input", "root must be a non-empty string");
    const normalized: AttemptRunnerOptions = { ...opts, root: canonicalPath(opts.root) };
    const dir = episodeDir(normalized.root, normalized.episodeId); // validates the episodeId component
    const existing = runners.get(dir);
    if (existing) {
      if (existing instanceof Promise) {
        // F-g: a concurrent open() already claimed this slot synchronously
        // — JOIN its pending open instead of racing a second journal
        // writer onto one episode (the old check-await-register left a
        // window where two callers both passed the check).
        return await existing;
      }
      throw new RunnerError("ownership-fence", `an AttemptRunner is already open for episode ${JSON.stringify(opts.episodeId)} in this process — close it first (one exclusive journal writer)`);
    }
    // Claim SYNCHRONOUSLY before any await (F-g); the pending promise IS
    // the reservation. Released on failure so a later open may retry.
    const pending: Promise<AttemptRunner> = (async () => {
      const journal = await DecisionJournal.forEpisode(dir);
      return new AttemptRunner(normalized, journal);
    })();
    runners.set(dir, pending);
    try {
      const runner = await pending;
      runners.set(dir, runner);
      return runner;
    } catch (e) {
      if (runners.get(dir) === pending) runners.delete(dir);
      throw e;
    }
  }

  /** True while any child started by this instance is still running. */
  get hasLiveChildren(): boolean {
    for (const e of this.children.values()) if (!e.exited) return true;
    return false;
  }

  /** Unregister the runner. Refuses (unless force) while a child is live —
   *  stopping workers is `stop()`'s job, and dropping tracking while a
   *  worker writes to its session would hide exactly what reconcile must
   *  see. force only forgets tracking (and unrefs the children so the
   *  host process may exit); the durable records remain. */
  close(force = false): void {
    if (this.closed) return;
    // F3 (audit): a queued-or-active spawn transaction OWNS the writer
    // slot. Closing mid-transaction let the old runner continue through
    // nodeSpawn and the ok-append AFTER a reopen had put a second
    // writer on the journal (two live workers, one attemptId). Refuse
    // while any transaction is in flight — the registry reservation is
    // retained until it settles. force detaches (same policy as live
    // children); the pre-spawn closure recheck below covers that path.
    if (!force && this.spawnActive > 0) throw new RunnerError("ownership-fence", "refusing to close while a spawn transaction is in flight — await it first (or close(true) to force)");
    if (!force && this.hasLiveChildren) throw new RunnerError("ownership-fence", "refusing to close while a child is live — stop() first (or close(true) to detach tracking)");
    if (force) for (const e of this.children.values()) if (!e.exited) { try { e.child.unref(); } catch { /* already reaped */ } }
    this.closed = true;
    runners.delete(this.dir());
  }

  /** Read every durable record (schema-validated by the journal). */
  async records(): Promise<SupervisorRecord[]> {
    this.assertOpen();
    try {
      return (await this.journal.read()).records;
    } catch (e) {
      throw new RunnerError("journal-failed", `journal read failed: ${msg(e)}`, { cause: msg(e) });
    }
  }

  // ─────────────────────────── run / resume ─────────────────────────────────

  /**
   * Start a FRESH attempt (attemptId = max over all sources + 1).
   * Serialized per instance (F7): two concurrent run() calls can never
   * both pass the fence, share an attemptId, or spawn twice on one
   * session path. Intent-first (I2): the unresolved attempt record is
   * durable BEFORE the process exists; the resolve record ("ok" with the
   * recorded pid/pgid on the spawn event / "failed" on spawn error)
   * follows. Refuses when any fence fails — see `fenceOrThrow`; NO
   * refusal performs a spawn.
   */
  async run(task: AttemptTask): Promise<AttemptHandle> {
    this.assertOpen();
    const t = canonicalTask(task); // F4: one identity for the file, before ANY comparison/record/map use
    assertTask(t, this.episodeId);
    return this.enqueueSpawn(async () => {
      const records = await this.records();
      const attemptId = nextAttemptId(t.taskId, ...attemptCandidates(records, t.taskId, await this.readState(), t.attemptId));
      await this.fenceOrThrow(t, records, attemptId, false);
      return this.spawnAttempt(t, attemptId, false, nextSpawnGen(records, t.session));
    });  }

  /**
   * RESUME the SAME attempt (§14.1: attemptId is stable across --resume;
   * a fresh runId belongs to the worker). A new spawn intent/outcome pair
   * is appended under the same (episodeId, taskId, attemptId) tuple —
   * latest-per-tuple is the view (P4 lifecycle clarification).
   * Serialized with run() (F7). Refuses when the attempt was never
   * recorded (use run()), is live here (`already-running`), or any fence
   * fails.
   */
  async resume(task: AttemptTask, attemptId: string): Promise<AttemptHandle> {
    this.assertOpen();
    const t = canonicalTask(task); // F4: equivalent resume spellings are ONE identity
    assertTask(t, this.episodeId);
    if (!ATTEMPT_ID.test(attemptId)) throw new RunnerError("bad-input", `attemptId must match "<taskId>-a<N>" (got ${JSON.stringify(attemptId)})`);
    return this.enqueueSpawn(async () => {
      const records = await this.records();
      const tuple = records.filter((r) => r.kind === "attempt" && r.episodeId === t.episodeId && r.taskId === t.taskId && r.attemptId === attemptId);
      if (tuple.length === 0) throw new RunnerError("bad-input", `attempt ${attemptId} has no durable record for ${t.episodeId}/${t.taskId} — start it with run()`, { taskId: t.taskId, attemptId });
      const recordedSession = canonicalPath((tuple[tuple.length - 1] as AttemptRecord).sessionPath);
      if (recordedSession !== t.session) {
        throw new RunnerError("bad-input", `attempt ${attemptId} is durably bound to session ${JSON.stringify(recordedSession)} — resuming it on ${JSON.stringify(t.session)} would split the ownership fence across two paths`, { attemptId, recordedSession });
      }
      await this.fenceOrThrow(t, records, attemptId, true);
      return this.spawnAttempt(t, attemptId, true, nextSpawnGen(records, t.session));
    });
  }

  /** F7 critical section: chain run/resume bodies; the queue survives
   *  rejections; a closed runner refuses before any mutation. */
  private async enqueueSpawn<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) throw new RunnerError("bad-input", "runner is closed");
    this.spawnActive += 1; // F3: counted synchronously — queued AND active
    const prev = this.spawnQueue;
    let release!: () => void;
    this.spawnQueue = new Promise<void>((res) => { release = res; });
    try {
      await prev.catch(() => { /* prior caller's refusal is not ours to carry */ });
      this.assertOpen();
      return await fn();
    } finally {
      this.spawnActive -= 1;
      release();
    }
  }

  /**
   * Stop OUR child (never a discovered foreign process — killing a
   * process we did not spawn races I1; reconcile parks instead).
   * SIGTERM the process group, wait stopTimeoutMs, escalate to SIGKILL
   * (group) on timeout OR when the direct child died but the group is
   * still alive (F5: the leader exiting is not the group exiting).
   * `stopped:true` REQUIRES confirmed group death — kill(-pgid,0)
   * returning ESRCH after the child's exit event; a group still alive
   * after the SIGKILL sweep reports stopped:false/groupStatus:"alive"
   * (the fence holds), and an undeterminable group reports "unknown" —
   * never a silent stopped:true over survivors (audit F-5).
   */
  async stop(handle: Pick<AttemptHandle, "session">): Promise<StopResult> {
    this.assertOpen();
    const entry = this.children.get(canonicalPath(handle.session));
    if (!entry || entry.exited) throw new RunnerError("not-running", `no live child for session ${JSON.stringify(handle.session)} started by this runner instance`);
    let escalated = await this.terminate(entry);
    // E (audit): after an escalation the leader may be UNSIGNALABLE
    // (EPERM swallowed by signalGroup) — `await exitPromise` alone is
    // then a hang, not a stop. Bound the post-SIGKILL exit wait: on
    // timeout report the honest verdict (stopped:false / "unknown")
    // and return; the child stays tracked and the fence stays closed.
    const exit = await Promise.race([
      entry.exitPromise,
      escalated ? delay(POST_KILL_EXIT_WAIT_MS).then(() => undefined) : new Promise<never>(() => {}),
    ]);
    if (exit === undefined) {
      // Only reachable when escalated (the non-escalated race arm
      // never resolves): SIGKILL was sent but the leader never exited.
      return { attemptId: entry.attemptId, stopped: false, escalated, code: null, signal: null, groupStatus: "unknown" };
    }
    const { code, signal } = exit;
    if (!entry.pgid) {
      // D (audit) / G1 (P7 audit): Non-detached: the child shares
      // SOMEONE ELSE's group (typically this supervisor's own), so there
      // is no private group we can sweep or probe — the direct child's
      // waitpid-class exit disproves only the LEADER, and a forked
      // grandchild survives in the inherited group. `stopped:true`
      // would claim group death we do not possess: report stopped:false.
      // G1: groupStatus is "unknown", NOT "reaped" — "reaped" is defined
      // as CONFIRMED whole-group death (kill(-pgid,0) → ESRCH) and no
      // such evidence exists for an inherited group; reporting "reaped"
      // here invited callers to treat the stop as group-disproven. The
      // attempt keeps its survivor-class ownership fence (see
      // AttemptView.ownership): the session stays fenced across
      // reconcile / run / reopen / confirm until descendant ownership
      // is independently disproven.
      return { attemptId: entry.attemptId, stopped: false, escalated, code, signal, groupStatus: "unknown" };
    }
    // The exit event reaps the DIRECT child; the group may still hold
    // grandchildren (F5). Verify with kill(-pgid,0) — NOT `ps` (blocked
    // in some sandboxes, and its failure was being converted to "no
    // survivors"): ESRCH ⇒ group confirmed gone; 0 ⇒ survivors → one
    // SIGKILL sweep + re-verify; EPERM ⇒ undeterminable.
    let verdict = this.groupAlive(entry.pgid);
    if (verdict === "alive") {
      // F7 (audit): this post-exit sweep IS a SIGKILL escalation of the
      // stop — SIGTERM did not take (a grandchild survived the group
      // TERM) — so `escalated` reports true even when terminate()
      // returned false on an immediate leader exit.
      escalated = true;
      this.signalGroup(entry, "SIGKILL");
      // Bounded poll: a SIGKILL'd member's exit reaping is async in the
      // kernel; kill(-pgid,0) may still answer "alive" for a moment
      // after the sweep. Poll to ESRCH instead of gambling on one sleep.
      for (let i = 0; i < 25 && verdict === "alive"; i++) {
        await delay(20);
        verdict = this.groupAlive(entry.pgid);
      }
    }
    const stopped = verdict === "reaped";
    return { attemptId: entry.attemptId, stopped, escalated, code, signal, groupStatus: verdict };
  }

  /** Await the child's exit evidence without stopping it. Resolves
   *  immediately for an already-exited child of THIS instance. */
  async waitForExit(handle: Pick<AttemptHandle, "session">): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.assertOpen();
    const entry = this.children.get(canonicalPath(handle.session));
    if (!entry) throw new RunnerError("not-running", `no child (this instance) for session ${JSON.stringify(handle.session)}`);
    return entry.exitPromise;
  }

  // ─────────────────────────── reconcile (I1/I2) ────────────────────────────

  /**
   * Cross-check recorded (decisions.jsonl) vs observed (own children, ps
   * probes on recorded pids — journal-first, state.json as the legacy
   * hint path) for one task and return the advisory decision. This
   * OBSERVES and CLASSIFIES — it never spawns, kills, or repairs
   * records. `action:"park"` is the conservative fallback whenever
   * liveness cannot be disproven (I1/I2/I3).
   */
  async reconcile(task: AttemptTask): Promise<ReconcileResult> {
    this.assertOpen();
    const t = canonicalTask(task); // F4
    assertTask(t, this.episodeId);
    const records = await this.records();
    const probes: ReconcileResult["probes"] = [];
    const v = await this.analyze(t, records, probes);

    const parks: string[] = [];
    const runnings: string[] = [];
    for (const a of v.blocking) {
      if (a.ownership === true) {
        parks.push(a.probe && a.probe.running === true
          ? `attempt ${a.record.attemptId} (unjournalled-group survivor class) discovered RUNNING at pid ${a.probe.pid} (I1: park — never take over by killing)`
          : `attempt ${a.record.attemptId}: historical ok spawn without journalled group identity (NON-detached or mode unrecorded, no pgid) retains unprovable group ownership`);
        continue;
      }
      // H3-F7 (audit cycle R2): truthful diagnostic for the unprobeable
      // observed-ok claim — the latest record may be a later failed/ok
      // of a different cohort, so never describe this as "spawned ok"
      // of the latest or point at confirmStopped (nothing to probe).
      if (a.protectedOk !== undefined) {
        const o = a.protectedOk;
        parks.push(`attempt ${a.record.attemptId}: HISTORICAL spawn observed ok WITHOUT a journalled pid (ok record ${o.attemptId}${o === a.record ? "" : `, generation ${o.spawnGen ?? "legacy"}`}) — liveness UNPROVEN and undisprovable (no probeable identity); confirmStopped cannot help; manual journal repair`);
        continue;
      }
      if (a.record.spawnOutcome === undefined || a.record.spawnOutcome === null) {
        if (a.live === true || a.probe?.running === true) {
          parks.push(`unresolved spawn intent ${a.record.attemptId} (task ${a.record.taskId}) — process DISCOVERED RUNNING${a.probe ? ` (pid ${a.probe.pid})` : " (own child)"}`);
        } else {
          parks.push(`unresolved spawn intent ${a.record.attemptId} (task ${a.record.taskId}) — liveness UNPROVEN${a.probe?.running === undefined && a.probe ? ` (probe of pid ${a.probe.pid} inconclusive)` : ""}`);
        }
        continue;
      }
      // spawned-ok claim
      if (a.live === true) runnings.push(`attempt ${a.record.attemptId} (task ${a.record.taskId}) is a live child of this supervisor`);
      else if (a.probe?.running === true && a.probe.sameUid !== false) parks.push(`attempt ${a.record.attemptId} (task ${a.record.taskId}) discovered RUNNING at pid ${a.probe.pid} (I1: park — never take over by killing)`);
      else if (a.probe?.running === true) parks.push(`attempt ${a.record.attemptId}: pid ${a.probe.pid} hit a FOREIGN-uid process — cannot judge, park`);
      else if (a.probe && a.probe.running === undefined) parks.push(`attempt ${a.record.attemptId}: probe of pid ${a.probe.pid} inconclusive — liveness UNPROVEN`);
      // F5: leader pid gone (or unrecorded) — the recorded GROUP is the
      // remaining ownership claim; alive ⇒ park, undeterminable ⇒ park.
      else if (a.groupProbe?.running === true) parks.push(`attempt ${a.record.attemptId}: its process GROUP (pgid ${a.groupProbe.pgid}) still has members — leader death alone is not group death, park until the group is confirmed gone (stop it or confirm with group evidence)`);
      else if (a.groupProbe && a.groupProbe.running === undefined) parks.push(`attempt ${a.record.attemptId}: group liveness of pgid ${a.groupProbe.pgid} is undeterminable (EPERM — foreign-owner group?) — liveness UNPROVEN`);
      // F17 (audit cycle R4): deterministic GROUP death discharges the
      // claim even with NO leader pid journalled. kill(-pgid,0)→ESRCH
      // on a journalled pgid is the strongest negative evidence
      // available (stronger than any pid probe): group death covers
      // leader AND descendants. Reconcile must accept it — parking
      // here while the spawn fence (below, same fix) admits the spawn
      // is exactly the reconcile/spawn divergence F17 names.
      else if (!a.probe && a.live === undefined && a.groupProbe?.running !== false) parks.push(`attempt ${a.record.attemptId} spawned ok but NO pid is recorded and no hint matches — liveness UNPROVEN`);
      // else: own child exited (waitpid-class) AND the recorded group is
      // reaped, or a probe says the pid is gone with a reaped/absent
      // group claim — disproven.
    }
    for (const f of v.foreignLive) parks.push(`session path also used by live attempt ${f.attemptId} of task ${f.taskId}`);

    const reasons = [...parks, ...runnings];
    const action: ReconcileDecision["action"] = parks.length > 0 ? "park" : runnings.length > 0 ? "running" : "spawn";
    const ownership: OwnershipView = { episodeId: t.episodeId, taskId: t.taskId, latest: v.latest, unresolved: v.unresolved, live: v.live, foreignLive: v.foreignLive, blocking: v.blocking, superseded: v.supersededThisTask };
    return { episodeId: t.episodeId, taskId: t.taskId, decision: { episodeId: t.episodeId, taskId: t.taskId, action, reasons }, ownership, probes };
  }

  /**
   * Resolve an unresolved (or spawned-ok-but-unprovable) attempt against
   * POSITIVE evidence of stop (I3: silence is not evidence — this call
   * IS the evidence-bearing action; P8 wraps it in a decision record with
   * a stable actionId; the evidence string is a REQUIRED argument so no
   * call site can be an accident). Appends the resolving attempt record
   * (spawnOutcome:"failed") for the tuple and clears the stale pid hint.
   *
   * Refuses when the attempt is a live child of this instance, or a ps
   * probe discovered the recorded pid RUNNING — you cannot "confirm"
   * away a running worker. The confirming record carries `superseded:
   * true` when it resolves a tuple that a newer claim on the same
   * session path already displaced (F1 bookkeeping: the resolve is an
   * audit fact, but it no longer blocks anything).
   */
  async confirmStopped(task: AttemptTask, attemptId: string, evidence: string): Promise<AttemptRecord> {
    this.assertOpen();
    const t = canonicalTask(task); // F4
    assertTask(t, this.episodeId);
    if (!ATTEMPT_ID.test(attemptId)) throw new RunnerError("bad-input", `attemptId must match "<taskId>-a<N>" (got ${JSON.stringify(attemptId)})`);
    if (typeof evidence !== "string" || evidence.trim().length === 0) throw new RunnerError("bad-input", "confirmStopped requires a non-empty evidence string (what proves the worker stopped)");
    // F4 (audit): serialize with run()/resume() on the SAME spawn
    // mutex. A confirmation interleaved with a live spawn could read
    // pre-append records, judge the tuple dead, and append its
    // "failed" resolve under a generation a concurrent spawn already
    // superseded. Enqueue first, then re-read EVERYTHING (records,
    // state hint, probes) inside the critical section — the
    // revalidation IS the fresh read under the mutex.
    return this.enqueueSpawn(async () => {
    const records = await this.records();
    const tuple = records.filter((r) => r.kind === "attempt" && r.episodeId === t.episodeId && r.taskId === t.taskId && r.attemptId === attemptId);
    if (tuple.length === 0) throw new RunnerError("bad-input", `no attempt record for ${t.episodeId}/${t.taskId}/${attemptId}`, { attemptId });
    const latest = tuple[tuple.length - 1] as AttemptRecord;
    // R6-2: the journal binds an attempt to ONE session path (resume()
    // enforces this). Confirmation must judge the bound session — a
    // caller spelling a different path would select a different
    // (possibly empty) hint set and could confirm away a live worker
    // that analyze still sees on the recorded session.
    const boundSession = canonicalPath(latest.sessionPath);
    if (boundSession !== t.session) {
      throw new RunnerError("bad-input", `attempt ${attemptId} is durably bound to session ${JSON.stringify(boundSession)} — confirming it against ${JSON.stringify(t.session)} would evaluate a different hint set; confirm with the bound session`, { attemptId, boundSession });
    }
    const unresolved = latest.spawnOutcome === undefined || latest.spawnOutcome === null;
    // H2-2 (haiku cycle 2) / H3-2 (audit cycle 12): the G3 unknown-group
    // doctrine covers EVERY survivor-class claim in the tuple — resolved
    // ok spawns AND unresolved intents that journalled a pid with no
    // group identity (see `survivorTupleClaim`). A late confirmation of
    // the tuple's latest must not sail past a historical unknown-mode
    // pid whose group may still own the session. Refuse confirmation;
    // park. NOTE (sonnet follow-up cycle 12, resolved by audit of the
    // predicate): there is NO "detached survivor" subclass here — a
    // detached:true record with no pgid is a PROVEN-mode claim (the
    // hypothetical private group pgid===pid is determinable, so
    // survivorTupleClaim is false for such tuples and confirmStopped's
    // B/G3 hypothetical check governs them). Survivor class arises
    // exactly when some pid's spawn mode was never recorded (or
    // detached:false asserts a foreign inherited group) — cleared only
    // by same-cohort proven-mode enrichment (F8, audit cycle R2: an
    // unproven pid gains identity when a record OF ITS OWN cohort
    // journals it proven; until then this blanket refusal is the
    // accurate claim — a late confirmation of another cohort cannot
    // reach it).
    if (survivorTupleClaim(tuple)) {
      // F14 (audit cycle R3) / F19 (audit cycle R4): the witness is the
      // OFFENSE RECORD ITSELF — its unique journal UUID `id` (the
      // shared attemptId identifies the tuple, not the record), its
      // generation, and its timestamp.
      const w = survivorOffense(tuple);
      const witness = w ? ` (offense record ${w.id}, attempt ${w.attemptId}, generation ${w.spawnGen ?? "legacy"}${w.ts !== undefined ? ` at ${new Date(w.ts).toISOString()}` : ""}: ${w.detached === false ? "NON-detached (detached:false) — inherited foreign group" : `pid ${w.pid} with no pgid and no detached:true — spawn mode never recorded`})` : "";
      throw new RunnerError("ownership-fence", `attempt ${attemptId} has a historical spawn with NO journalled group identity${witness} — leader death can never disprove an unknown group; G3-class, park`, { attemptId: w?.attemptId ?? attemptId });
    }
    // H3-F6/F7 (audit cycle R2) / F12 (audit cycle R3) / F15+F16 (audit
    // cycle R4): a cohort-scoped observed-ok-WITHOUT-pid claim in the
    // tuple is undisprovable by ANY confirmation — UNLESS the S6 hint
    // rows supply the identity under the SAME contract analyze uses
    // (`hintEnrichment`: hint accepted only when the tuple journalled
    // no pid anywhere, matched on attemptId + sessionPath, EVERY
    // matching row across all task keys accepted — F16). Consumers must
    // not disagree: analyze probes the FULL accepted hint set for this
    // tuple, so confirmStopped must neither refuse it as identity-less
    // NOR accept a claim analyze still protects.
    const protectedOkState = await this.readState();
    const hintIds = hintEnrichment(records, protectedOkState, t.episodeId).get(tupleKey(latest)) ?? [];
    const protectedOk = unprobeableOkClaim(tuple, hintIds);
    if (protectedOk !== undefined) {
      throw new RunnerError("ownership-fence", `attempt ${attemptId} has a HISTORICAL spawn observed ok WITHOUT a journalled pid (ok record ${protectedOk.id}, attempt ${protectedOk.attemptId}${protectedOk === latest ? "" : `, generation ${protectedOk.spawnGen ?? "legacy"}`}${protectedOk.ts !== undefined ? ` at ${new Date(protectedOk.ts).toISOString()}` : ""}) — no probeable identity (no journal pid, no state.json hint for this attempt+session, and no confirmation of that cohort carried identity), so no confirmation can disprove it; manual journal repair after a full-process sweep`, { attemptId });
    }
    const historicalGroups = new Set(tuple.filter((r) => r.kind === "attempt" && !r.confirmation).map((r) => {
      const attempt = r as AttemptRecord;
      return attempt.pgid ?? (attempt.detached === true ? attempt.pid : undefined);
    }));
    for (const pgid of historicalGroups) {
      if (typeof pgid === "number" && this.groupAlive(pgid) !== "reaped") {
        throw new RunnerError("ownership-fence", `attempt ${attemptId} has a historical process group ${pgid} whose death is unproven`, { pgid });
      }
    }
    if (!unresolved && latest.spawnOutcome !== "ok") {
      throw new RunnerError("bad-input", `attempt ${attemptId} already resolved (spawnOutcome: ${latest.spawnOutcome}) — nothing to confirm`, { spawnOutcome: latest.spawnOutcome });
    }
    // live-child refusal
    for (const e of this.children.values()) {
      if (!e.exited && e.task.episodeId === t.episodeId && e.task.taskId === t.taskId && e.attemptId === attemptId) {
        throw new RunnerError("ownership-fence", `attempt ${attemptId} is a LIVE child of this supervisor (pid ${e.child.pid}) — stop() it, do not confirm it away`, { pid: e.child.pid });
      }
    }
    // discovered-running refusal: the recorded pid (journal-first, F6)
    // and a matching hint row both count as process evidence.
    // Reuse the same coherent hint snapshot that established `hintIds`;
    // public writeStateHint operations share this transaction queue, so
    // no supported writer can change accepted identities mid-confirmation.
    const state = protectedOkState;
    const candidatePids = new Set<number>();
    // H1-M1/M3 (audit): EVERY pid ever journalled for the tuple (not
    // just latest) must resolve to a deterministic negative — a hidden
    // historical worker under a later dead resume is the same class the
    // analyze-side loop just closed.
    for (const r of tuple) if (r.kind === "attempt" && !r.confirmation && typeof r.pid === "number") candidatePids.add(r.pid);
    // F16 (audit cycle R4): the accepted hint set is `hintEnrichment`'s
    // FULL set (every row matching attemptId+sessionPath across ALL
    // task keys — the same set analyze probes), not the R3 pair of
    // (first match, own-task row). Each accepted identity must resolve
    // to a deterministic negative below: confirmation may not succeed
    // while ANY accepted candidate is live, foreign, or inconclusive.
    // Process evidence is broader than enrichment eligibility: every
    // row bound to this tuple's attemptId+session is probed even when
    // journal pids exist. This is the same set analyze probes; an own-
    // task row is not privileged over matching cross-task rows.
    for (const hintRow of Object.values(state?.tasks ?? {})) {
      if (hintRow && hintRow.attemptId === attemptId && hintRow.session === t.session && typeof hintRow.pid === "number") candidatePids.add(hintRow.pid);
    }
    for (const pid of candidatePids) {
      const status = await this.probe(pid);
      if (status && status.running && status.sameUid !== false) {
        throw new RunnerError("ownership-fence", `pid ${pid} recorded for attempt ${attemptId} is RUNNING — the worker is alive; park, do not confirm`, { pid, evidence });
      }
      // H3-4 (audit cycle 12): a pid observed RUNNING under a FOREIGN
      // uid is neither "alive-ours" nor "dead" — our probe cannot judge
      // (let alone disprove) a process we do not own. Refuse with a
      // message that names the actual cause, so a refusal never reads
      // as a generic inconclusive.
      if (status && status.running && status.sameUid === false) {
        throw new RunnerError("ownership-fence", `pid ${pid} recorded for attempt ${attemptId} is RUNNING under a FOREIGN uid — liveness of a foreign-owned process cannot be disproven by our probe; park, do not confirm`, { pid, evidence });
      }
      // F (audit): an INCONCLUSIVE liveness probe is NOT acceptance —
      // absence of evidence is not evidence of absence. Every recorded
      // pid (journal FIRST, best-effort hint second) must resolve to a
      // DETERMINISTIC negative verdict (running:false); an undefined
      // probe verdict means ownership is undeterminable: refuse, keep
      // the fence closed. (Deterministic here means the probe ANSWERED
      // dead — ESRCH-class — not "the probe could not run".)
      if (status === undefined || status.running !== false) {
        throw new RunnerError("ownership-fence", `liveness of pid ${pid} (recorded for attempt ${attemptId}) is INCONCLUSIVE — the probe could not determine it; confirm requires deterministic negative evidence (running:false)`, { pid, evidence });
      }
    }
    // F (audit) / F12 (audit cycle R3): a tuple with neither pid, pgid,
    // nor ANY probed candidate identity (journal pids above AND an
    // accepted state.json hint row — both were required to resolve to
    // deterministic negatives in the loop) has nothing to probe —
    // confirming it rests on evidence-free absence. With a hint identity
    // that the loop just proved dead, absence IS evidenced: refusing
    // here would contradict analyze, which probes the same hint.
    const hasGroupIdentity = [...historicalGroups].some((g) => typeof g === "number");
    if (candidatePids.size === 0 && !hasGroupIdentity) {
      throw new RunnerError("ownership-fence", `attempt ${attemptId} recorded NO pid, NO pgid, and no state.json hint identity — nothing can be probed to prove the worker stopped; a confirmation over an identifier-less tuple is unverified absence`, { evidence });
    }
    // G3 doctrine applies to a HINT-supplied leader identity too: an
    // UNRESOLVED tuple's spawn mode was never recorded, and the hint
    // row names only the leader — its deterministic death disproves
    // nothing about an unrecorded group. Never confirm an unresolved
    // intent from hint-only identity (analyze parks the same tuple).
    if (unresolved && typeof latest.pid !== "number" && typeof latest.pgid !== "number") {
      throw new RunnerError("ownership-fence", `attempt ${attemptId} is UNRESOLVED with NO journalled identity — a state.json hint pid (probed dead) identifies at most the leader, and the tuple's spawn mode was never recorded, so the group can never be disproven — park, G3`, { evidence });
    }
    // B (audit) / G3 (P7 audit): an UNRESOLVED tuple that journalled no
    // pgid sat between the fork and the "ok" resolve — the spawn mode
    // (and hence the group) was NEVER recorded. Probing the recorded pid
    // AS a hypothetical private group (pgid === pid) is only sound when
    // the journal actually EVIDENCES a detached spawn: a non-detached
    // leader lives in SOMEONE ELSE's group, and ESRCH on the hypothetical
    // pgid proves nothing about descendants inherited into that foreign
    // group. Without journalled `detached:true` the group identity is
    // UNKNOWN — refusing keeps the fence closed instead of guessing a
    // private group that was never proven to exist.
    if ((unresolved || latest.detached === true) && typeof latest.pgid !== "number" && typeof latest.pid === "number") {
      // resume() keeps the attemptId but creates a NEW process. Only
      // the current record's mode describes this pid; historical modes
      // (even a successful detached spawn) cannot establish its group.
      const detachedEvidence = latest.detached === true;
      if (!detachedEvidence) {
        throw new RunnerError("ownership-fence", `attempt ${attemptId} is UNRESOLVED and journalled no pgid and NO detached evidence — the spawn mode was never recorded, so the hypothetical pgid===pid group is unsound (a non-detached leader inherits a FOREIGN group; ESRCH on the hypothetical pgid would prove nothing about its descendants): leader death alone can never disprove the group — park, G3`, { pid: latest.pid, evidence });
      }
      const hg = this.groupAlive(latest.pid);
      if (hg !== "reaped") {
        throw new RunnerError("ownership-fence", `attempt ${attemptId} is UNRESOLVED and journalled no pgid — leader pid ${latest.pid} is dead but group liveness of its unrecorded group is ${hg === "alive" ? "ALIVE (survivors in the group)" : "undeterminable"}; a spawn that crashed before journalling its group can never be confirmed from leader death alone`, { pid: latest.pid, evidence });
      }
    }
    // F5 (audit): a dead leader pid is NOT proof of group death. If the
    // tuple recorded a pgid, confirming requires the GROUP to be reaped
    // too — otherwise a grandchild still owns the session and
    // "confirmed stopped" would advertise a lie. External recovery:
    // `kill -9 -PGID`, then confirm again.
    if (typeof latest.pgid === "number") {
      const g = this.groupAlive(latest.pgid);
      if (g === "alive") throw new RunnerError("ownership-fence", `process group ${latest.pgid} (recorded for attempt ${attemptId}) still has members — leader death is not group death; kill -9 -${latest.pgid} the survivors and confirm with THAT evidence`, { pgid: latest.pgid, evidence });
      if (g === "unknown") throw new RunnerError("ownership-fence", `group liveness of pgid ${latest.pgid} is undeterminable (EPERM — foreign-owner group?) — cannot confirm stopped`, { pgid: latest.pgid, evidence });
    }
    // fresh envelope, identity carried from the tuple's latest record —
    // an out-of-band taskRevision must never mutate the tuple's recorded
    // identity, and (finding 3) the confirmation COPIES the tuple's
    // spawnGen: confirming is not a new spawn, so it must never reorder
    // ownership against a live higher-generation tuple. A legacy tuple
    // (no generation) confirms as legacy.
    // F15 (audit cycle R4): when the tuple journalled NO identity of
    // its own, the confirmation STAMPS the hint identity it probed to
    // a deterministic negative. Closure is then carried by the journal
    // itself — a later analyze sees this cohort's identity proven dead
    // — instead of R3's positional "window after any confirmation"
    // rule, which laundered claims the confirming implementation never
    // discharged. The stamp goes to this cohort ONLY (spawnGen copied),
    // and never claims more than was proven: a hint pid is leader
    // evidence only, so unresolved mode-less tuples keep refusing at
    // the G3 gate above and can never reach this stamp.
    const stampedIdentity: Partial<AttemptRecord> = typeof latest.pid === "number" || typeof latest.pgid === "number"
      ? {}
      : hintIds.length > 0 ? { pid: hintIds[0] } : {};
    const record: AttemptRecord = { ...latest, id: newDecisionId(), ts: Date.now(), ...stampedIdentity, spawnOutcome: "failed", confirmation: true, ...(typeof latest.spawnGen === "number" ? { spawnGen: latest.spawnGen } : {}) };
    // F4 (audit): generation-checked revalidation immediately before
    // the append — a spawn that raced in after our first read (only
    // possible pre-mutex-serialization) would have appended a HIGHER
    // spawnGen for this session; confirming a stale tuple then must
    // refuse rather than rewrite ownership. (Records are re-read
    // here so the check sees the exact durable state we append onto.)
    const fresh = await this.records();
    const tupleFresh = fresh.filter((r) => r.kind === "attempt" && r.episodeId === t.episodeId && r.taskId === t.taskId && r.attemptId === attemptId);
    const latestFresh = tupleFresh[tupleFresh.length - 1] as AttemptRecord | undefined;
    if (latestFresh && latestFresh.id !== latest.id) {
      // A different record is now the tuple's latest — a spawn/resume
      // appended under this tuple between our reads. Note: "ok" alone
      // is the NORMAL confirmation target (spawn-ok then stopped);
      // only a CHANGED latest id is evidence of a race.
      throw new RunnerError("ownership-fence", `attempt ${attemptId} changed under us (spawn revalidated it) — re-run confirmStopped against the new state`, { attemptId });
    }
    const sessionGenFresh = Math.max(0, ...(fresh.filter((r): r is AttemptRecord => r.kind === "attempt" && r.episodeId === t.episodeId && r.sessionPath === t.session).map((r) => r.spawnGen ?? 0)));
    if (typeof latest.spawnGen === "number" && sessionGenFresh > latest.spawnGen) {
      throw new RunnerError("ownership-fence", `session ${JSON.stringify(t.session)} has a newer spawn generation ${sessionGenFresh} than the confirmed tuple (${latest.spawnGen}) — this confirmation is stale`, { attemptId, sessionGenFresh });
    }
    // CONTRACT (R6-3): state.json is a cache. The ONLY supported writers
    // are this runner's serialized paths (run/resume/confirmStopped and
    // writeStateHint, all on one queue). External writers are outside
    // the ownership contract: this revalidation detects a change that
    // lands during the probe interval and fails closed, but it is
    // best-effort detection, NOT atomic protection — a foreign write
    // between this read and the append below is not excluded. Operators
    // editing state.json while a runner is open must stop the runner first.
    // Revalidate the full process-evidence set immediately before the
    // confirmation append; if membership changed while probes ran, fail
    // closed and let the caller retry against the new snapshot.
    const hintPids = (s: EpisodeState | undefined): number[] => [...new Set(Object.values(s?.tasks ?? {})
      .filter((row) => row && row.attemptId === attemptId && row.session === t.session && typeof row.pid === "number")
      .map((row) => row!.pid!))].sort((a, b) => a - b);
    const currentHintState = await this.readState();
    if (JSON.stringify(hintPids(state)) !== JSON.stringify(hintPids(currentHintState))) {
      throw new RunnerError("ownership-fence", `state.json pid identities for attempt ${attemptId} changed during confirmation — no closure appended; retry against the current hint set`, { attemptId });
    }
    await this.appendRecord(record);
    // Clear the stale hint ONLY when it still describes this tuple
    // (F12: never clobber a newer attempt's live row).
    const rowNow = (await this.readState())?.tasks?.[t.taskId];
    if (rowNow && rowNow.attemptId === attemptId && rowNow.session === t.session) {
      await this.writeStateHintLocked(t, attemptId, undefined, "paused");
    }
    return record;
    });
  }

  /** Re-write the S6 pid-hint row (e.g. after a hint-write failure).
   *  F12 + audit finding 9: the row may ADVANCE to a legitimately newer
   *  attempt (a fresh attemptId that just passed the ownership fence —
   *  attempt number strictly greater), and a same-tuple refresh is
   *  allowed; a STALE writer (lower attempt number than the row's, e.g.
   *  a late confirmStopped-clear or a retried hint from a dead attempt)
   *  is refused. Clearing (pid=undefined) for the row's own tuple stays
   *  allowed. state.json is a cache — the journal generation, not this
   *  row, decides ownership.
   *
   *  F18 (audit cycle R4) — explicit stale-refresh policy for the
   *  CONFIRMED tuple: once a tuple's LATEST journal record is a
   *  confirmation, the tuple is CLOSED — its process is proven gone and
   *  its hint row was cleared by confirmStopped. A pid-write over a
   *  closed tuple (same attemptId, or an older attempt number landing
   *  late from a wedged writer) would RE-CREATE an identity for a dead
   *  cohort and re-open enrichment (`hintEnrichment`) for it: the
   *  confirmation would stop closing what it proved. Such writes are
   *  REFUSED (returned as a warning string, state untouched). The
   *  legitimate paths survive: a fresh spawn uses a NEW attemptId (the
   *  closed tuple's policy never touches other tuples), and clearing
   *  (pid=undefined) always stays allowed — clearing a closed tuple's
   *  row is a no-op toward the dead cohort, not an enrichment. */
  async writeStateHint(task: AttemptTask, attemptId: string, pid: number | undefined, status: "running" | "paused"): Promise<string | undefined> {
    this.assertOpen();
    const t = canonicalTask(task); // F4
    assertTask(t, this.episodeId);
    // Refreshes participate in the same serialization boundary as
    // confirmStopped/run/resume. Otherwise a pid-write can pass the
    // CLOSED check, pause, and resurrect the hint after confirmation
    // clears it. The internal helper is used by already-serialized
    // spawn/confirmation transactions below.
    return this.enqueueSpawn(() => this.writeStateHintLocked(t, attemptId, pid, status));
  }

  private async writeStateHintLocked(task: AttemptTask, attemptId: string, pid: number | undefined, status: "running" | "paused"): Promise<string | undefined> {
    const t = task;
    try {
      // F18: refuse re-creating a hint identity over a CLOSED tuple.
      // CLOSED = the tuple's LATEST journal record (append order) is a
      // confirmation. A newer spawn record after the confirmation (a
      // resume — same attemptId, new process past the fence) re-opens
      // the tuple, so this is evaluated on the latest record only.
      if (pid !== undefined) {
        const journal = await this.records();
        let latest: AttemptRecord | undefined;
        for (const r of journal) {
          if (r.kind === "attempt" && r.episodeId === this.episodeId && r.taskId === t.taskId && r.attemptId === attemptId) latest = r as AttemptRecord;
        }
        if (latest !== undefined && latest.confirmation === true) {
          return `tuple ${t.taskId}/${attemptId} is CLOSED (its latest journal record ${latest.id} is a confirmation — the cohort's process identity was proven gone) — refusing to write a pid hint for a confirmed-dead cohort (F18 stale-refresh policy); a fresh process needs a spawn past the ownership fence (resume appends new records, then rewrites this row)`;
        }
      }
      const state = (await this.readState()) ?? { schema: STATE_SCHEMA_ID, episodeId: this.episodeId, tasks: {} } as EpisodeState;
      const prev = state.tasks[t.taskId] ?? { status };
      if (prev.attemptId !== undefined && prev.attemptId !== attemptId) {
        if (attemptNumber(attemptId) <= attemptNumber(prev.attemptId)) {
          return `state.json row for ${t.taskId} belongs to attempt ${JSON.stringify(prev.attemptId)} — refusing to rewind the hint to a stale attempt (clear it via confirmStopped, or advance it only from a newer fenced spawn)`;
        }
        // legitimate advancement (finding 9): this attemptId is newer
        // than the cached row's and (by construction at the spawn call
        // site) already passed the ownership fence.
      }
      const row = { ...prev, status, attemptId, session: t.session };
      if (pid !== undefined) row.pid = pid; else delete (row as Partial<typeof row>).pid;
      const next: EpisodeState = {
        ...state,
        supervisorPid: state.supervisorPid ?? process.pid,
        tasks: { ...state.tasks, [t.taskId]: row },
      };
      await writeEpisodeState(join(this.dir(), "state.json"), next);
      return undefined;
    } catch (e) {
      return `state.json hint write failed (journal authority intact): ${msg(e)}`;
    }
  }

  // ─────────────────────────────── fence ────────────────────────────────────

  /**
   * The spawn gate. Throws on ANY refusal; returns only when every claim
   * on the task's session path (across ALL tasks — §14.5) and every
   * live child on it has disproven liveness. Called after input
   * validation and attemptId allocation, BEFORE any mutation (the next
   * append is the intent record) — inside the F7 critical section.
   */
  private async fenceOrThrow(task: AttemptTask, records: SupervisorRecord[], newAttemptId: string, isResume: boolean): Promise<void> {
    // own-instance liveness first (no I/O needed)
    const child = this.children.get(task.session);
    if (child && !child.exited) {
      const same = child.task.episodeId === task.episodeId && child.task.taskId === task.taskId;
      if (same && isResume && child.attemptId === newAttemptId) {
        throw new RunnerError("already-running", `attempt ${newAttemptId} is already live in this supervisor (pid ${child.child.pid})`, { pid: child.child.pid });
      }
      throw new RunnerError("ownership-fence", `session ${JSON.stringify(task.session)} is being written by live attempt ${child.attemptId} of ${child.task.episodeId}/${child.task.taskId} (pid ${child.child.pid}) — I1: confirm stop first`, { attemptId: child.attemptId, taskId: child.task.taskId, pid: child.child.pid });
    }
    const probes: ReconcileResult["probes"] = [];
    const v = await this.analyze(task, records, probes);
    if (v.foreignLive.length > 0) {
      const f = v.foreignLive[0]!;
      throw new RunnerError("ownership-fence", `session ${JSON.stringify(task.session)} is claimed by live attempt ${f.attemptId} of task ${f.taskId} — I1: confirm stop first`, { attemptId: f.attemptId, taskId: f.taskId });
    }
    for (const a of v.blocking) {
      const foreign = a.record.taskId !== task.taskId;
      if (a.ownership === true) {
        if (a.probe && a.probe.running === true && a.probe.sameUid !== false) throw new RunnerError("prior-attempt-running", `attempt ${a.record.attemptId} (unjournalled-group survivor class) discovered RUNNING at pid ${a.probe.pid} — park (I1: never take over by killing)`, { attemptId: a.record.attemptId, pid: a.probe.pid });
        // F2 (sonnet follow-up) / H3-5 lesson: branch on the ACTUAL
        // claim, never a generalization. H3-R5/F3 (audit cycle R1): the
        // offense is identified by `survivorOffense` — the record that
        // CAUSES the survivor claim, scoped exactly like it (a
        // same-cohort-enriched pid is NOT an offense; a cross-cohort
        // proven pid laundering was fixed by R1) — and the message
        // quotes that record directly. mode-UNRECORDED survivors (pid,
        // no pgid, no detached:true) and detached:false claims genuinely
        // have no evidence path (G3). A detached-only tuple (detached:
        // true, no pgid) is PROVEN-mode and never survivor-class — it
        // never reaches this fence; its determinable hypothetical-group
        // path lives in confirmStopped, not here.
        const offense = survivorOffense(records.filter((r) => r.kind === "attempt" && r.episodeId === task.episodeId && tupleKey(r) === tupleKey(a.record)));
        if (offense !== undefined) {
          // F14 (audit cycle R3): quote the offense record fully (id,
          // generation, timestamp) and give the recovery path that
          // ACTUALLY applies to ITS class: a mode-unrecorded pid is
          // curable by same-cohort proven-mode enrichment, but a
          // detached:false contradiction is NOT — the classifier takes
          // the worse reading unconditionally, so its only exit is
          // manual repair of THAT record.
          const when = offense.ts !== undefined ? ` at ${new Date(offense.ts).toISOString()}` : "";
          if (offense.detached === false) {
            throw new RunnerError("prior-attempt-unresolved", `attempt ${offense.attemptId}: historical spawn (record ${offense.id}, generation ${offense.spawnGen ?? "legacy"}${when}) — detached:false asserts an inherited foreign group${offense.taskId !== task.taskId ? `, task ${offense.taskId}` : ""}; a later record cannot rehabilitate the contradiction — no probe or confirmation clears it: manual repair or removal of THAT journal record after a full-process sweep`, { attemptId: offense.attemptId, recordId: offense.id });
          }
          throw new RunnerError("prior-attempt-unresolved", `attempt ${offense.attemptId}: historical spawn (record ${offense.id}, generation ${offense.spawnGen ?? "legacy"}${when}) whose GROUP identity is UNPROVABLE (pid ${offense.pid} without pgid and without detached:true — spawn mode never recorded)${offense.taskId !== task.taskId ? `, task ${offense.taskId}` : ""} retains unprovable group ownership — no probe or confirmation clears it; recovery: same-cohort proven-mode journal repair (a record OF THAT SPAWN'S generation journalling this pid with detached:true/pgid — F8, audit cycle R2) or manual journal repair after a full-process sweep`, { attemptId: offense.attemptId, recordId: offense.id });
        }
        // Defensive: `ownership:true` arises EXACTLY when
        // `survivorOffense` finds a witness (the predicates are exact
        // complements), so this branch is unreachable by construction —
        // it fails closed with a truthful internal-inconsistency message
        // rather than the stale (F5) "death IS determinable" text, which
        // described a detached-survivor subclass the classifier excludes.
        throw new RunnerError("prior-attempt-unresolved", `attempt ${a.record.attemptId}: survivor-class ownership without an identifiable offense record — internal classification inconsistency; failing closed (manual journal inspection)`, { attemptId: a.record.attemptId });
      }
      // H3-F7 (audit cycle R2): the unprobeable observed-ok claim gets
      // its OWN truthful diagnostic — it is NOT the view's latest record
      // (which may be a later failed/ok of a DIFFERENT cohort), and
      // confirmStopped cannot help: a record with no pid has nothing to
      // probe, and a confirmation of the latest cohort leaves the
      // historical claim in the journal untouched. Recovery is manual
      // journal repair after a full-process sweep.
      if (a.protectedOk !== undefined) {
        const o = a.protectedOk;
        throw new RunnerError("prior-attempt-unresolved", `attempt ${a.record.attemptId}: a HISTORICAL spawn of this tuple was OBSERVED ok WITHOUT any journalled pid (ok record ${o.id}, attempt ${o.attemptId}${o === a.record ? "" : `, generation ${o.spawnGen ?? "legacy"}`}${o.ts !== undefined ? ` at ${new Date(o.ts).toISOString()}` : ""}) — the observation has no probeable identity, so its death can NEVER be disproven; ordering never releases it and confirmStopped has nothing to probe: manual journal repair after a full-process sweep${foreign ? ` (claim from task ${o.taskId})` : ""}`, { attemptId: a.record.attemptId, okAttemptId: o.attemptId, okRecordId: o.id });
      }
      if (a.record.spawnOutcome === undefined || a.record.spawnOutcome === null) {
        if (a.live === true) throw new RunnerError("prior-attempt-running", `unresolved attempt ${a.record.attemptId} is a live child of this supervisor`, { attemptId: a.record.attemptId });
        if (a.probe && a.probe.running === true && a.probe.sameUid !== false) {
          throw new RunnerError("prior-attempt-running", `unresolved attempt ${a.record.attemptId} discovered RUNNING at pid ${a.probe.pid} — park (I1: never take over by killing)`, { attemptId: a.record.attemptId, pid: a.probe.pid });
        }
        throw new RunnerError("prior-attempt-unresolved",
          `unresolved spawn intent ${a.record.attemptId}${foreign ? ` (task ${a.record.taskId} — same session path, §14.5)` : ""} (I2: no blind re-spawn)` +
          (a.live === false
            ? " — the process this supervisor spawned for it EXITED (waitpid-class): call confirmStopped with the exit evidence"
            : a.probe
            ? a.probe.running === false
              ? ` — probe of pid ${a.probe.pid} confirmed DEAD: call confirmStopped with stop evidence first`
              : ` — probe of pid ${a.probe.pid} inconclusive: park until liveness is established`
            : " — no process evidence exists: the worker may be alive with an unrecorded pid — park, or confirmStopped with stop evidence"),
          { attemptId: a.record.attemptId, taskId: a.record.taskId, live: a.live, probe: a.probe });
      }
      // resolved "ok": the process existed at least once; liveness must
      // be DISPROVEN (own child exited with a reaped group, or a
      // trustworthy probe says the pid is gone) before another worker
      // may open the session. Superseded tuples never reach this loop.
      if (a.live === true) {
        if (isResume && a.record.attemptId === newAttemptId) throw new RunnerError("already-running", `attempt ${newAttemptId} is already live in this supervisor (pid ${this.children.get(task.session)?.child.pid})`, { pid: this.children.get(task.session)?.child.pid });
        throw new RunnerError("ownership-fence", `attempt ${a.record.attemptId} is a live child of this supervisor and owns the session (I1)`, { attemptId: a.record.attemptId });
      }
      if (a.live === false) {
        // Our own exit event: waitpid-class disproof of the LEADER —
        // but F5: the recorded group may still have members, and the
        // fence never KILLS (I1). An alive group keeps ownership: park
        // (external `kill -9 -PGID` + confirmStopped is the recovery),
        // and an undeterminable group parks too.
        if (a.groupProbe?.running === true) throw new RunnerError("prior-attempt-running", `attempt ${a.record.attemptId}: its process GROUP (pgid ${a.groupProbe.pgid}) still has members — leader death alone is not group death (I1: park, do not re-spawn onto it)`, { attemptId: a.record.attemptId, pgid: a.groupProbe.pgid });
        if (a.groupProbe && a.groupProbe.running !== false) throw new RunnerError("prior-attempt-unresolved", `attempt ${a.record.attemptId}: group liveness of pgid ${a.groupProbe.pgid} is undeterminable (EPERM?) — park or confirmStopped with group evidence`, { attemptId: a.record.attemptId, pgid: a.groupProbe.pgid });
        // R6-1: the own child's exit disproves only ITS pid and group.
        // Independent journal/hint identities were probed by analyze
        // (the exited pid itself is excluded there). Their positive or
        // inconclusive verdicts still gate the spawn — the same verdicts
        // reconcile and confirmStopped apply.
        if (a.probe && a.probe.running === true && a.probe.sameUid !== false) throw new RunnerError("prior-attempt-running", `attempt ${a.record.attemptId}: an independent pid ${a.probe.pid} (journal or state hint, not the exited child) is RUNNING — park (I1)`, { attemptId: a.record.attemptId, pid: a.probe.pid });
        if (a.probe && a.probe.running !== false) throw new RunnerError("prior-attempt-unresolved", `attempt ${a.record.attemptId}: an independent pid ${a.probe.pid} (journal or state hint) is INCONCLUSIVE or foreign-owned — park or confirmStopped with evidence`, { attemptId: a.record.attemptId, pid: a.probe.pid });
        continue; // group reaped and no independent live/inconclusive identity: disproven
      }
      if (a.groupProbe?.running === true) throw new RunnerError("prior-attempt-running", `attempt ${a.record.attemptId}: its process GROUP (pgid ${a.groupProbe.pgid}) has members (I1: park, do not re-spawn onto it)`, { attemptId: a.record.attemptId, pgid: a.groupProbe.pgid });
      // F5 (audit): a DEAD leader pid + an UNDETERMINABLE group (EPERM
      // on kill(-pgid,0) — members owned by another uid) is NOT death
      // proof: grandchildren may still own the session. Every fence
      // branch parks on unknown group liveness — the own-exited-child
      // branch already did; the reopened/foreign branch must too, or
      // reconcile parks while run() spawns onto the survivor group.
      if (a.groupProbe && a.groupProbe.running === undefined) {
        throw new RunnerError("prior-attempt-unresolved", `attempt ${a.record.attemptId}: group liveness of pgid ${a.groupProbe.pgid} is undeterminable (EPERM — foreign-owner group?) — leader death alone is not group death: park or confirmStopped with group evidence`, { attemptId: a.record.attemptId, pgid: a.groupProbe.pgid });
      }
      if (a.probe && a.probe.running === true && a.probe.sameUid !== false) {
        throw new RunnerError("prior-attempt-running", `attempt ${a.record.attemptId} discovered RUNNING at pid ${a.probe.pid} — park (I1)`, { attemptId: a.record.attemptId, pid: a.probe.pid });
      }
      if (!a.probe || a.probe.running !== false) {
        // F17 (audit cycle R4): a LEADER-LESS claim (NO pid probe
        // exists at all — the tuple journalled/hinted no pid) whose
        // journalled GROUP resolved to a deterministic negative (ESRCH
        // via kill(-pgid,0) — filled in above) is DISPROVEN: group
        // death covers leader AND descendants, the strongest negative
        // evidence available. MUST stay consistent with reconcile (the
        // same guard on the "NO pid is recorded" park line). NOT
        // applied when a leader pid EXISTS with a non-negative probe
        // verdict: an INCONCLUSIVE leader probe keeps the tuple
        // protected even under group ESRCH — the leader may live
        // outside its journalled group (G2/H3-6 doctrine). An
        // INCONCLUSIVE GROUP (undefined) never reaches here: the EPERM
        // check above threw first.
        if (!a.probe && a.groupProbe && a.groupProbe.running === false) continue;
        // H3-5 (audit cycle 12): a tuple whose LATEST resolved "failed"
        // can still be admitted to blocking by H2-1 (a discovered-live
        // historical pid in the same tuple). The "was observed spawned
        // ok" wording would then misdescribe the evidence — branch on
        // what the record actually claims.
        const claim = a.record.spawnOutcome === "ok"
          ? "was observed spawned ok but its liveness is unprovable"
          : "resolved without an ok spawn, but a HISTORICAL process recorded in the same tuple is not disproven (H2-1: a failed resolve cannot delete a discovered-live pid)";
        throw new RunnerError("prior-attempt-unresolved",
          `attempt ${a.record.attemptId}${foreign ? ` (task ${a.record.taskId} — same session path, §14.5)` : ""} ${claim}` +
          (a.probe
            ? a.probe.running === true
              ? ` (probe of pid ${a.probe.pid} hit a FOREIGN-uid process — cannot judge)`
              : ` (probe of pid ${a.probe.pid} inconclusive)`
            : " (no pid was ever recorded for it)") +
          " — park or confirmStopped with evidence",
          { attemptId: a.record.attemptId, taskId: a.record.taskId, probe: a.probe });
      }
      // probe.running === false: the recorded process is gone (a pid miss
      // proves THAT process dead — pid reuse cannot resurrect it). a.live
      // === false: our own exit event. Either way: disproven.
    }
    // newest-tuple-per-session rule for the spawn's own tuple identity:
    // supersession + the spawn-mutex queue (enqueueSpawn) already fence
    // this — while the spawn critical section is held, a concurrent
    // caller can neither hold the fence slot nor allocate the same
    // attemptId (nextAttemptId derives from durable records under the
    // same mutex), so no separate reservation table is needed.
  }

  /**
   * Build AttemptViews from durable records + own children, joined on
   * the SESSION PATH across all tasks of this episode (§14.5 — F4).
   * Liveness discovery is JOURNAL-FIRST (F6): a tuple's recorded `pid`
   * (or a matching state.json hint row when the record predates P7
   * audit) is probed whenever we are not the parent. `blocking` is the
   * newest tuple PER SESSION PATH (F1: causality = journal append order,
   * F2); older tuples on the same path are superseded and reported under
   * `superseded*`. Pure observation.
   */
  private async analyze(task: AttemptTask, records: SupervisorRecord[], probes: ReconcileResult["probes"]): Promise<{
    all: AttemptView[]; latest?: AttemptView; unresolved: AttemptView[]; spawned: AttemptView[]; live: AttemptView[]; foreignLive: { attemptId: string; taskId: string }[]; blocking: AttemptView[]; supersededThisTask: AttemptView[];
  }> {
    // F1 (audit): causality index over the journal — append position IS
    // the causal order (first occurrence wins for a duplicated id).
    const seqOf = seqMapOf(records);
    // latest record per tuple, ACROSS tasks (the fence joins on session).
    // F1 (audit): "latest" is journal append order (causality), never
    // the wall-clock ts or the lexical UUID id.
    const byTuple = new Map<string, AttemptRecord>();
    for (const r of records) {
      if (r.kind !== "attempt" || r.episodeId !== task.episodeId) continue;
      const k = tupleKey(r);
      const prev = byTuple.get(k);
      if (!prev || (seqOf.get(r.id) ?? -1) > (seqOf.get(prev.id) ?? -1)) byTuple.set(k, r as AttemptRecord);
    }
    // newest tuple per session path (F1/F2): a tuple is newest if no
    // other tuple on the same session path is newer than it. An
    // unresolved intent does NOT supersede (its spawner may have died
    // before ever observing the prior); a resolved tuple does.
    const all: AttemptView[] = [];
    for (const record of byTuple.values()) {
      const child = this.children.get(record.sessionPath);
      const ours = child && child.task.episodeId === record.episodeId && child.task.taskId === record.taskId && child.attemptId === record.attemptId;
      const view: AttemptView = { record };
      if (ours) {
        view.live = !child.exited;
        if (child.exited) { view.exitCode = child.exitCode; view.signal = child.signal; }
      }
      all.push(view);
    }
    // Ownership newest-per-session by SPAWN GENERATION (audit finding 3),
    // with legacy generation-0 tuples ordered by DURABLE LOG POSITION
    // (audit F2) — never by the confirmation's wall clock. A confirmation
    // of an old tuple must never make that tuple "newest" and drop a
    // live newer tuple's claim from the fence, and a positively live
    // tuple (own child OR discovered live/group-live) is NEVER superseded
    // — liveness overrides any ordering. So the supersession pass runs
    // AFTER the probes below have filled in `view.probe`/`view.groupProbe`.
    // Successful spawns remain causal anchors even when the same attempt
    // resumes later. Attribute each anchor to ITS OWN generation/intent
    // position, never to the latest record of its stable attempt tuple.
    const segmentStart = new Map<string, number>();
    const anchors: { key: string; session: string; generation: number; position: number }[] = [];
    // H3-R2/F6: per-tuple UNPROBEABLE observed-ok claims (cohort-scoped,
    // see `unprobeableOkClaim`) — never released by ordering and never
    // exempted by a failed latest; only same-cohort enrichment (an
    // identifier journalled BY that cohort) discharges the claim.
    // S6 hint enrichment (F10/F6/F12): ONE identity-enrichment contract
    // (`hintEnrichment`) shared by every consumer here AND confirmStopped
    // — analyze never protects/refuses a tuple on an identity state
    // confirmation disagrees with. A state.json pid row is identity
    // evidence ONLY when the journal carries no pid at all for the
    // tuple, matched on attemptId + sessionPath exactly like the
    // legacy-hint probe path; per the hint contract it enriches only
    // the tuple's LATEST cohort (F10: failed generations count).
    const stateForEnrich = await this.readState();
    const hintByTuple = hintEnrichment(records, stateForEnrich, task.episodeId);
    const unprobeableOk = new Map<string, AttemptRecord | undefined>();
    for (const r of records) {
      if (r.kind !== "attempt" || r.episodeId !== task.episodeId) continue;
      const key = tupleKey(r);
      if (!unprobeableOk.has(key)) {
        // F15 (audit cycle R4): the claim is computed over the COMPLETE
        // tuple — no confirmation-window truncation. Closure is
        // evidence-carried (a confirmation journalling the claimed
        // cohort's identity, or an accepted hint row), never implied by
        // a historical confirmation record alone.
        unprobeableOk.set(key, unprobeableOkClaim(records.filter((x) => x.kind === "attempt" && tupleKey(x) === key), hintByTuple.get(key)));
      }
    }
    for (const view of all) {
      const offense = unprobeableOk.get(tupleKey(view.record));
      if (offense !== undefined) view.protectedOk = offense;
    }
    for (const r of records) {
      if (r.kind !== "attempt" || r.episodeId !== task.episodeId) continue;
      const key = tupleKey(r);
      const position = seqOf.get(r.id) ?? -1;
      if (!segmentStart.has(key) || (r.spawnOutcome == null && r.confirmation !== true)) segmentStart.set(key, position);
      if (r.spawnOutcome === "ok" && r.confirmation !== true) {
        anchors.push({ key, session: r.sessionPath, generation: r.spawnGen ?? 0, position: segmentStart.get(key)! });
      }
    }
    const markSuperseded = (): Set<AttemptView> => {
      const superseded = new Set<AttemptView>();
      for (const view of all) {
        // Process/group evidence and inherited survivor claims override
        // ordering, including historical groups hidden by a later resume.
        // H2-3 (haiku cycle 2): an INCONCLUSIVE probe is not a negative —
        // a view with a probe verdict of `undefined` is skipped here and
        // stays in the fence until evidence, exactly like the park branches.
        // H3-1 (audit cycle 12) / H3-R2 (audit review): a view with NO
        // probe identity at all (no pid anywhere, no pgid) is released by
        // ORDERING (ownership transfer), not by a deterministic negative —
        // but ONLY for NEVER-OBSERVED-OK tuples. That escape exists for
        // the structurally un-probeable never-resolved intent: it has zero
        // evidence-based exits after a crash between intent append and
        // spawn (confirmStopped refuses it too — nothing to probe, F
        // gate), so replacement by a newer tuple is its only release and
        // the F1/F2 cycle-1 contract pins it ("the latest tuple owns the
        // path; superseded tuples may still describe a live worker and
        // are reported as such for the operator"). NOTE (F4, audit cycle
        // R1): that escape is NOT autonomously reachable — creating the
        // newer anchor requires run(), which the intent itself fences,
        // so a journal-stamped identifier-less unresolved intent is
        // recovered only by operator journal repair (the deliberate
        // I2 posture: no blind re-spawn onto a possibly-live worker).
        // An OBSERVED "ok" without identifiers is a different claim: the journal POSITIVELY
        // observed a process, and append ordering adds nothing about its
        // death — the schema permits ok-without-pid (legacy journals), so
        // H3-R2 keeps it fenced (park; manual repair) instead of letting
        // a later anchor alone erase an observation. Survivor-class
        // tuples never reach either release — the ownership skip is
        // unconditional for them.
        if (view.ownership === true || view.live === true || (view.probe && view.probe.running !== false) || (view.groupProbe && view.groupProbe.running !== false)) continue;
        // H3-R2/F6: cohort-scoped unprobeable observed-ok — NEVER
        // released by ordering. Other cohorts' probes describe other
        // processes; only same-cohort enrichment (which clears the flag)
        // or manual repair changes the claim.
        if (view.protectedOk !== undefined) continue;
        const key = tupleKey(view.record);
        const generation = view.record.spawnGen ?? 0;
        const position = segmentStart.get(key) ?? -1;
        if (anchors.some((a) => a.key !== key && a.session === view.record.sessionPath &&
          (generation > 0 ? a.generation > generation : a.position > position))) superseded.add(view);
      }
      for (const view of all) view.superseded = superseded.has(view);
      return superseded;
    };
    // G1 (P7 audit) / H2-2 / H3-2 / F2 (sonnet follow-up): SURVIVOR-CLASS
    // ownership — see `survivorTupleClaim` for the shared predicate. Any
    // tuple whose history journalled a pid with NO group identity
    // (non-detached, or mode unrecorded with no pgid — including
    // unresolved intents, H3-2) keeps `ownership:true` (journal-derived:
    // reopen-proof) in reconcile parks and spawn fences, and is NEVER
    // released by ordering supersession (the ownership skip in
    // markSuperseded). The runner now FORCES detached spawns (group-leader
    // contract), so only LEGACY journals can carry this class. Within it:
    // mode-UNRECORDED claims (pid w/o pgid and without detached:true) are
    // cleared ONLY by same-cohort enrichment — a proven-mode record (
    // detached:true or explicit pgid) OF THE SAME SPAWN GENERATION that
    // journalled the pid (F8, audit cycle R2: the R1 `survivorOffense`
    // cohort scoping); cross-cohort proven records never launder it. A
    // detached:false claim asserts an inherited foreign group and is a
    // contradiction: NOT rehabilitable at all (worse reading wins), so
    // both classes end at manual journal repair for practical purposes.
    // A detached:true claim WITHOUT pgid is NOT ownership:
    // proven mode implies the hypothetical private group (pgid===pid),
    // whose death IS determinable, so it never gets `ownership:true` and
    // confirmStopped resolves it through the deterministic-evidence gate
    // (F5, audit cycle R1: the old fence carried an unreachable
    // "determinable survivor" branch describing exactly this
    // non-ownership case).
    // H3-R5/F3: the per-view `unprovableGroup` flag is DELETED. The
    // fence quotes the OFFENSE record from `survivorOffense` — scoped
    // exactly like the claim, never a same-cohort-enriched record.
    const survivorTuples = new Set<string>();
    for (const r of records) {
      if (r.kind !== "attempt" || r.episodeId !== task.episodeId) continue;
      const key = tupleKey(r);
      if (!survivorTuples.has(key) && survivorTupleClaim(records.filter((x) => x.kind === "attempt" && x.episodeId === task.episodeId && tupleKey(x) === key))) survivorTuples.add(key);
    }
    for (const view of all) {
      if (survivorTuples.has(tupleKey(view.record))) view.ownership = true;
    }
    // Probe ALL process evidence: every journalled pid plus every
    // matching attemptId+session hint row, regardless of whether the
    // journal already contains a pid. Journal identity controls cohort
    // enrichment; hints remain independent liveness evidence so analyze,
    // confirmation, and the spawn fence cannot disagree about a live row.
    const state = await this.readState();
    const probed = new Map<number, PidStatus | undefined>();
    for (const view of all) {
      // A LIVE own child is refused by the fence and reconcile before any
      // probe verdict matters, so it is not re-probed here. An EXITED own
      // child (live:false) is waitpid-disproven for its OWN pid only:
      // that one pid is excluded below, while independent journal and
      // matching hint identities are still probed (R6-1).
      if (view.live === true) continue;
      const ownExitedPid = view.live === false ? this.children.get(view.record.sessionPath)?.child.pid : undefined;
      // H1-M1 (audit): probe EVERY non-confirmation record's pid in the
      // tuple, not just the latest. A historical ok spawn whose pid was
      // recorded WITHOUT pgid/detached (unknown spawn mode) stays live
      // behind a later dead resume unless its pid is proven gone —
      // latest-only probing hid a live old worker and let run() spawn
      // over it. Verdict precedence across the tuple's pids: any
      // positive running wins; else any inconclusive (fail-closed:
      // undeterminable historical liveness is UNPROVEN); else gone.
      const tupleRecords = records.filter((r): r is AttemptRecord => r.kind === "attempt" && tupleKey(r) === tupleKey(view.record) && !r.confirmation);
      const candidatePids: number[] = [];
      for (const r of tupleRecords) if (typeof r.pid === "number" && r.pid !== ownExitedPid && !candidatePids.includes(r.pid)) candidatePids.push(r.pid);
      // Probe every matching row even when the journal carries pids.
      // Confirmation and the spawn fence treat a current S6 row as
      // process evidence (it may describe a child whose pid was not
      // durably resolved before a crash); omitting it here let run()
      // spawn while confirmStopped correctly refused the same live row.
      for (const [tid, row] of Object.entries(state?.tasks ?? {})) {
        void tid;
        if (row && row.attemptId === view.record.attemptId && row.session === view.record.sessionPath && typeof row.pid === "number" && row.pid !== ownExitedPid && !candidatePids.includes(row.pid)) candidatePids.push(row.pid);
      }
      let chosen: { pid: number; running: boolean | undefined; sameUid: boolean | undefined } | undefined;
      for (const pid of candidatePids) {
        if (!probed.has(pid)) probed.set(pid, await this.probe(pid));
        const status = probed.get(pid);
        const verdict = { pid, running: status?.running, sameUid: status?.sameUid };
        if (!probes.some((p) => p.pid === pid)) probes.push({ pid, running: status?.running, sameUid: status?.sameUid });
        if (!chosen || verdict.running === true || (verdict.running === undefined && chosen.running === false)) chosen = verdict;
      }
      view.probe = chosen;
    }
    // F5 (audit): the recorded GROUP outlives the leader. A dead leader
    // pid proves only the LEADER dead — grandchildren may own the
    // session file through the still-running process group. Probe
    // kill(-pgid,0) for every record carrying a pgid whose own-child /
    // pid-probe verdict is not a positive live: group death covers
    // leader AND descendants; group liveness KEEPS ownership even when
    // the leader pid is gone.
    for (const view of all) {
      const groupRecords = records.filter((r): r is AttemptRecord => r.kind === "attempt" && tupleKey(r) === tupleKey(view.record) && !r.confirmation);
      const pgids = new Set(groupRecords.map((r) => r.pgid ?? (r.detached === true ? r.pid : undefined)).filter((pgid): pgid is number => typeof pgid === "number"));
      for (const pgid of pgids) {
        const g = this.groupAlive(pgid);
        const running = g === "alive" ? true : g === "reaped" ? false : undefined;
        if (!view.groupProbe || running === true || (running === undefined && view.groupProbe.running === false)) view.groupProbe = { pgid, running };
      }
    }
    const supersededSet = markSuperseded(); // F2: after the probes — liveness overrides ordering

    const foreignLive: { attemptId: string; taskId: string }[] = [];
    const entry = this.children.get(task.session);
    if (entry && !entry.exited && !(entry.task.episodeId === task.episodeId && entry.task.taskId === task.taskId)) {
      foreignLive.push({ attemptId: entry.attemptId, taskId: entry.task.taskId });
    }

    const notSuperseded = (v: AttemptView): boolean => !supersededSet.has(v);
    const thisTask = (v: AttemptView): boolean => v.record.taskId === task.taskId;
    const unresolved = all.filter((v) => (v.record.spawnOutcome === undefined || v.record.spawnOutcome === null) && thisTask(v));
    // F6 (audit finding 6): a resolved "failed" outcome IS negative
    // spawn evidence — the runner observed 'error' before 'spawn', so
    // the process NEVER existed. It owns nothing, blocks nothing, and
    // must never be routed through the spawned-ok liveness branch.
    // H2-1 (haiku cycle 2): the F6 negative-evidence exemption for a
    // resolved "failed" latest applies only when the tuple's OWN probes
    // are negative — a failed record cannot delete a DISCOVERED-LIVE
    // (or inconclusive) process in the same tuple, or run() would spawn
    // over the very worker analyze just found running.
    // H3-R2/F1/F6 (audit cycles R1-R2): and the F6 exemption also
    // cannot erase a cohort-scoped UNPROBEABLE observed-ok claim — a
    // failed latest says the LATEST process never existed; it says
    // nothing about the death of an earlier observed-ok-without-pid
    // process, and identifiers from other cohorts (their probes exist
    // or not) are evidence about OTHER processes only.
    const blocking = all.filter((v) => notSuperseded(v) && (v.ownership === true || (v.groupProbe && v.groupProbe.running !== false) || (v.probe && v.probe.running !== false) || v.protectedOk !== undefined || v.record.spawnOutcome !== "failed") && (v.record.sessionPath === task.session || thisTask(v)));
    const live = all.filter((v) => v.live === true && thisTask(v));
    const spawned = all.filter((v) => v.record.spawnOutcome === "ok" && thisTask(v) && notSuperseded(v));
    const supersededThisTask = all.filter((v) => supersededSet.has(v) && thisTask(v));
    let latest: AttemptView | undefined;
    for (const view of all) if (thisTask(view) && (!latest || (seqOf.get(view.record.id) ?? -1) > (seqOf.get(latest.record.id) ?? -1))) latest = view;
    return { all, latest, unresolved, spawned, live, foreignLive, blocking, supersededThisTask };
  }

  // ─────────────────────────── spawn internals ──────────────────────────────

  private async spawnAttempt(task: AttemptTask, attemptId: string, resume: boolean, spawnGen: number): Promise<AttemptHandle> {
    // intent BEFORE act (I2): unresolved record durable first.
    const intent: AttemptRecord = {
      schema: "tre-supervisor/1", id: newDecisionId(), ts: Date.now(), episodeId: this.episodeId, taskId: task.taskId,
      kind: "attempt", attemptId, taskRevision: task.taskRevision, sessionPath: task.session, model: task.model, worktreePath: task.worktreePath,
      spawnOutcome: null, spawnGen,
    };
    await this.appendRecord(intent);

    // C2-C (cycle-2 audit): the spawner callback is USER code — a throw
    // here (after the intent is durable) must resolve the intent `failed`
    // and surface as RunnerError("spawn-failed"), not a raw Error with a
    // dangling unresolved intent parked in the journal.
    let spec: WorkerSpawn;
    try {
      spec = this.spawner.spawn(task, attemptId, { resume });
    } catch (e) {
      await this.appendRecord(resolveLike(intent, "failed", { spawnEvidence: true })).catch(() => { /* journal divergence surfaces below via records() */ });
      throw new RunnerError("spawn-failed", `spawner ${JSON.stringify(this.spawner.kind)} threw before producing a spawn spec: ${msg(e)}`, { cause: msg(e) });
    }
    const specError = validateSpawnSpec(spec, this.commandCheck);
    if (specError) {
      await this.appendRecord(resolveLike(intent, "failed", { spawnEvidence: true })).catch(() => { /* journal divergence surfaces below via records() */ });
      throw new RunnerError("spawn-failed", `spawner ${JSON.stringify(this.spawner.kind)} returned an invalid spawn spec: ${specError}`);
    }
    const detached = spec.detached ?? true;
    // F3 (audit): closure recheck immediately before the process is
    // created (forced close may have landed during the awaits above).
    this.assertOpen();
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = nodeSpawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, detached, stdio: "ignore" });
    } catch (e) {
      await this.appendRecord(resolveLike(intent, "failed", { spawnEvidence: true })).catch(() => {});
      throw new RunnerError("spawn-failed", `spawn(${spec.command}) threw: ${msg(e)}`, { cause: msg(e) });
    }
    let settle!: (v: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => { settle = res; });
    const entry: ChildEntry = { child, task, attemptId, exited: false, exitCode: null, signal: null, settle, exitPromise };
    child.once("exit", (code, signal) => {
      entry.exited = true; entry.exitCode = code; entry.signal = signal;
      settle({ code, signal });
    });
    child.once("error", () => { /* classified via the wait below / exit channel */ });

    // F3 (audit): closure gate before the "ok" resolve append. close()
    // refuses while a transaction is in flight, but close(true) forces
    // — after a forced close we must not advertise the spawn as ok on
    // a journal a reopened writer now owns; the child stays tracked
    // and the intent parks (I2-conservative).
    this.assertOpen();

    // Wait until the process provably EXISTS before claiming "ok" —
    // 'error' without 'spawn' means the process NEVER existed.
    try {
      await new Promise<void>((res, rej) => {
        const onError = (e: Error): void => rej(e);
        child.once("error", onError);
        child.once("spawn", () => { child.removeListener("error", onError); res(); });
      });
    } catch (e) {
      await this.appendRecord(resolveLike(intent, "failed", { spawnEvidence: true })).catch(() => {});
      throw new RunnerError("spawn-failed", `worker process ${spec.command} failed to spawn: ${msg(e)}`, { cause: msg(e) });
    }
    entry.pgid = detached ? child.pid : undefined;
    // Track BEFORE resolving the journal (F7: synchronous registration —
    // while the spawn critical section is held the second layer is the
    // only possible reader, but the entry must be visible before the
    // resolve append so a failed resolve still leaves a visible live
    // child; losing tracking of a live child is the worse failure).
    this.children.set(task.session, entry);
    // F3 (audit): last closure gate before the "ok" resolve append —
    // close() refuses while a transaction is in flight, but close(true)
    // forces; after a forced close we must not advertise the spawn ok
    // on a journal a reopened writer now owns. The child stays tracked
    // and the intent parks (I2-conservative).
    this.assertOpen();
    // "ok" resolve carries the process identity INTO THE JOURNAL (F6):
    // restart discovery no longer depends on the single-row state hint.
    await this.appendRecord({ ...resolveLike(intent, "ok", { detached }), pid: child.pid, ...(entry.pgid !== undefined ? { pgid: entry.pgid } : {}) });

    const stateWarning = await this.writeStateHintLocked(task, attemptId, child.pid, "running");
    return { episodeId: task.episodeId, taskId: task.taskId, attemptId, session: task.session, pid: child.pid, detached, exited: exitPromise, stateWarning };
  }

  /** SIGTERM the group (or bare pid), escalate SIGKILL after
   *  stopTimeoutMs OR when the direct child died but the group is still
   *  alive (F5). Returns whether escalation happened. ESRCH is the
   *  outcome we wanted (group already gone), never an error. */
  private async terminate(entry: ChildEntry): Promise<boolean> {
    this.signalGroup(entry, "SIGTERM");
    if (entry.exited) {
      // leader died immediately — still verify the group (F5).
      if (entry.pgid && this.groupAlive(entry.pgid) === "alive") {
        this.signalGroup(entry, "SIGKILL");
        return true;
      }
      return false;
    }
    const timedOut = await new Promise<boolean>((res) => {
      const timer = setTimeout(() => res(true), this.stopTimeoutMs);
      entry.exitPromise.then(() => { clearTimeout(timer); res(false); });
    });
    if (timedOut && !entry.exited) {
      this.signalGroup(entry, "SIGKILL");
      return true;
    }
    return false;
  }

  private signalGroup(entry: ChildEntry, sig: NodeJS.Signals): void {
    try {
      if (entry.pgid) process.kill(-entry.pgid, sig);
      else if (entry.child.pid) process.kill(entry.child.pid, sig);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // C2-1 (cycle-2 audit): EPERM means the group holds FOREIGN-uid
      // members we cannot signal — that is an UNDETERMINABLE liveness
      // state, not an error to propagate: stop() must return the
      // honest verdict (stopped:false / groupStatus:"unknown"), never
      // throw, or a caller treating a throw as "not stopped" could
      // loop into kill-then-rationalize. ESRCH = already gone (wanted).
      if (code === "ESRCH" || code === "EPERM") return;
      throw e;
    }
  }

  /** Group liveness via kill(-pgid, 0) (F5): signal 0 performs every
   *  permission/existence check without delivering a signal.
   *  ESRCH ⇒ group confirmed GONE (the strongest negative evidence
   *  available — stronger than any external listing, which can fail
   *  CLOSED); a successful return ⇒ members EXIST; EPERM (members of
   *  another uid) ⇒ "unknown" — never reported as gone. No subprocess:
   *  immune to `ps` being unavailable/limited in sandboxes. */
  private groupAlive(pgid: number): "reaped" | "alive" | "unknown" {
    try {
      process.kill(-pgid, 0);
      return "alive";
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return "reaped";
      if (code === "EPERM") return "unknown";
      return "unknown";
    }
  }

  // ─────────────────────────── state.json helpers ───────────────────────────

  private async readState(): Promise<EpisodeState | undefined> {
    const path = join(this.dir(), "state.json");
    try {
      const state = await readEpisodeState(path);
      if (state.episodeId !== this.episodeId) {
        // F6 (audit): a wrong-identity cache is not authoritative —
        // the journal is. Warn and treat as absent (rebuild-from-
        // journal); never let a stale/misplaced cache fail the run.
        this.warnStateOnce(`state.json episodeId ${JSON.stringify(state.episodeId)} does not match runner episode ${JSON.stringify(this.episodeId)} — ignoring the cache, deriving from the journal`);
        return undefined;
      }
      return state;
    } catch (e) {
      if (isEnoent(e)) return undefined;
      // F6 (audit): corrupt / half-written hint cache. The S6 contract
      // is explicit: a corrupt cache means rebuild-from-files, never a
      // failed run. The journal is the authority; the cache is a
      // derived accelerator. Surface ONE warning and continue with no
      // cache (legacy hints it held are then absent — the fence stays
      // conservative: absence of hint never proves liveness either
      // way, claims without journal evidence park as before).
      this.warnStateOnce(`state.json unreadable (${msg(e)}) — ignoring the cache, deriving from the journal`);
      return undefined;
    }
  }

  private stateWarned = false;
  private warnStateOnce(text: string): void {
    if (this.stateWarned) return;
    this.stateWarned = true;
    process.emitWarning(`AttemptRunner[${this.episodeId}]: ${text}`, "TreStateCacheWarning");
  }

  // ────────────────────────────── internals ─────────────────────────────────

  private dir(): string { return episodeDir(this.root, this.episodeId); }

  private assertOpen(): void {
    if (this.closed) throw new RunnerError("bad-input", "runner is closed");
  }

  private async probe(pid: number): Promise<PidStatus | undefined> {
    try { return await this.pidProbeImpl(pid); } catch { return undefined; }
  }

  private async appendRecord(record: AttemptRecord): Promise<void> {
    // F3 (audit): a closed runner never mutates the journal — close()
    // refuses while a transaction is in flight, but a forced close
    // (or a close between the last gate and this append) must still
    // stop writes dead rather than interleave with a reopened writer.
    this.assertOpen();
    try { await this.journal.append(record); }
    catch (e) { throw new RunnerError("journal-failed", `journal append failed: ${msg(e)}`, { record, cause: msg(e) }); }
  }
}

// ────────────────────────────── helpers ─────────────────────────────────────

function resolveLike(intent: AttemptRecord, outcome: "ok" | "failed", extra?: Partial<AttemptRecord>): AttemptRecord {
  // Fresh envelope ONLY — spawnGen (and every identity field) is COPIED
  // from the intent (finding 3): the resolve of a generation belongs to
  // that generation, whatever its wall-clock ts says. `extra` marks the
  // resolve's EPISTEMIC SOURCE (spawnEvidence / confirmation) — never
  // identity.
  return { ...intent, id: newDecisionId(), ts: Date.now(), spawnOutcome: outcome, ...extra };
}

/** Causal spawn generation for one session path (finding 3): 1 + the max
 *  generation of ANY existing record on the SAME canonical session
 *  (any task). Allocation happens inside the F7 critical section from
 *  the same record snapshot the fence was evaluated against, so two
 *  spawns on one session can never share a generation. */
function nextSpawnGen(records: SupervisorRecord[], session: string): number {
  let max = 0;
  for (const r of records) {
    if (r.kind === "attempt" && r.sessionPath === session && typeof r.spawnGen === "number" && r.spawnGen > max) max = r.spawnGen;
  }
  return max + 1;
}

const tupleKey = (r: { episodeId: string; taskId?: string; attemptId: string }): string => JSON.stringify([r.episodeId, r.taskId ?? "", r.attemptId]);

function attemptCandidates(records: SupervisorRecord[], taskId: string, state: EpisodeState | undefined, caller?: string): string[] {
  const out: string[] = [];
  for (const r of records) if (r.kind === "attempt" && r.taskId === taskId) out.push(r.attemptId);
  const st = state?.tasks?.[taskId]?.attemptId;
  if (st) out.push(st);
  if (caller) out.push(caller);
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Default executable check (F11): absolute path → exists & executable;
 *  bare/relative name → resolvable on $PATH. `~` was expanded by
 *  canonicalPath for task paths; spawner commands come from the spawner
 *  contract, not the task, and are checked literally. */
export function defaultCommandExists(command: string): boolean {
  if (command.includes("/")) {
    try {
      // static fs imports (audit F-e): `require` does not exist under ESM —
      // the old inline require made EVERY absolute command look
      // non-executable and threw on bare ones.
      accessSync(command, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const paths = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of paths) {
    try { accessSync(join(dir, command), fsConstants.X_OK); return true; } catch { /* keep looking */ }
  }
  return false;
}

/** Default pid probe: same-uid `ps -p`. Trustworthy verdicts:
 *  - empty stdout + exit 1   → running:false (ps ANSWERED: no such pid —
 *    the recorded process is GONE; pid reuse replaces dead pids, it does
 *    not resurrect them).
 *  - stdout with a uid       → running:true + sameUid flag (a foreign-uid
 *    hit on our hint row is unjudgeable → treated as unprovable upstream).
 *  - anything else (ps missing, EPERM, weird exit) → undefined (NOT dead
 *    — I3: absence of evidence is not evidence of absence). */
export async function defaultPidProbe(pid: number): Promise<PidStatus | undefined> {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 99_999_999) return undefined; // not a judgeable pid (conservative)
  // Kill-based probe (no exec dependency — `ps` is blocked under
  // sandboxed hosts, and an exec-based probe turns EVERY liveness check
  // into inconclusive, deadlocking the fence on a journalled pid).
  // kill(pid,0) semantics: success ⇒ the process exists and is ours to
  // signal; ESRCH ⇒ it does not exist (the honest negative the fence
  // needs — same miss-class evidence a `ps` no-such-pid answer gave);
  // EPERM ⇒ it EXISTS under another uid (positive existence, foreign
  // ownership — exactly the {running:true, sameUid:false} shape the
  // ps path produced). Any other errno is undeterminable: undefined.
  try {
    process.kill(pid, 0);
    const me = typeof process.getuid === "function" ? process.getuid() : undefined;
    // Our own reaped children: node reaps them, so ESRCH answers after
    // exit; a success here is a live (or zombie-unreaped) process.
    return { running: true, sameUid: me === undefined ? false : true };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "ESRCH") return { running: false, sameUid: false };
    if (code === "EPERM") return { running: true, sameUid: false };
    return undefined;
  }
}

function isEnoent(e: unknown): boolean { return (e as NodeJS.ErrnoException)?.code === "ENOENT"; }
function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }