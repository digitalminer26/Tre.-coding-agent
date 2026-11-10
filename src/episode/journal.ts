/**
 * P4 — Episode journal primitives (docs/11 §4/S3, §5/S4, §6/S5, §7/S6,
 * §14.3/§14.7, §13.1 durability).
 *
 * Typed readers/writers for the supervisor's episode files:
 *   graph.json          (S3, schema "tre-graph/1")        — atomic-rename JSON
 *   state.json          (S6, schema "tre-episode-state/1") — atomic-rename JSON
 *   events/decisions.jsonl (S5, schema "tre-supervisor/1") — append-only JSONL,
 *                                                   fsync-before-return (sync
 *                                                   before ack, §13.1)
 *
 * These are PRIMITIVES ONLY: no process in the harness writes these files
 * yet (the supervisor arrives at P6+). What ships here is the durable shape
 * layer — schema validation on both read and write, atomic replacement for
 * the mutable files, repair-then-append for the journal (same torn-tail
 * discipline as §13.1/session.ts), and the I2 reconcile helpers over the
 * decision records (open intents, latest attempt).
 */
import { appendFile, link, mkdir, open as fsOpen, readdir, readFile, rename, rm, stat, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { validateArgs } from "../tools/validate.js";
import type { JsonSchema } from "../types.js";

// ─────────────────────────── layout (S4, Q3 decided) ───────────────────────

/** `<episodesRoot>` default — machine level, next to sessions/ (Q3). */
export function defaultEpisodesRoot(): string {
  return join(homedir(), ".tre", "episodes");
}

/** The canonical per-episode directory path. */
export function episodeDir(root: string, episodeId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(episodeId) || episodeId === "." || episodeId === "..") {
    throw new EpisodeSchemaError("episodeId must be a safe, non-empty path component");
  }
  return join(root, episodeId);
}

/**
 * Create the S4 directory scaffold for one episode (idempotent):
 *   <root>/<episodeId>/ graph.json prompts/ events/ sessions/ wt/
 * The graph is written through `writeEpisodeGraph` (schema-validated);
 * pass it in to seed desired state. NEVER call this from a worker process
 * — the supervisor is the only writer (S3 rule).
 */
export async function createEpisodeLayout(root: string, episodeId: string, graph: EpisodeGraph): Promise<string> {
  const dir = episodeDir(root, episodeId);
  const snapshot = serializeValidated(graph, GRAPH_JSON_SCHEMA, "graph");
  const seed = JSON.parse(snapshot) as EpisodeGraph;
  if (seed.episodeId !== episodeId) throw new EpisodeSchemaError("graph.episodeId must match episodeId");
  // An I/O failure between mkdirs and the graph write can leave a partial
  // scaffold (dirs, no graph.json). That is caller-reconciled: this function
  // is idempotent, so a retry completes in place, and no graph.json means
  // the episode never existed for any reader (graph presence is the commit
  // marker, §13.1 crash-scope discipline).
  //
  // P18-A3 (sol audit cycle 1): idempotent means SAFE-TO-REPEAT, not
  // overwrite-in-place. If graph.json already exists, the incoming seed
  // must be IDENTICAL desired state (canonically — key order-insensitive)
  // or this call throws WITHOUT touching anything: a caller whose episode
  // is already live (or who targets the wrong episode) used to replace
  // the running episode's desired scope before its own validation failed.
  // Legitimate evolution of a live graph (a rung-4 rewriteTask bump) goes
  // through writeEpisodeGraph, never through re-seeding here.
  const graphFile = join(dir, "graph.json");
  const existing = await readFile(graphFile, "utf8").catch((e: unknown) => {
    const err = e as NodeJS.ErrnoException;
    if (err && err.code === "ENOENT") return undefined;
    throw err;
  });
  if (existing !== undefined) {
    let current: unknown;
    try {
      current = JSON.parse(existing);
    } catch {
      // graph.json is the commit marker; a corrupt marker is corruption,
      // not a re-seed invitation. Fail closed — never overwrite blind.
      throw new EpisodeSchemaError(`episode ${episodeId}: existing graph.json is corrupt — refusing to overwrite`);
    }
    if (canonicalJson(current) !== canonicalJson(seed)) {
      throw new EpisodeSchemaError(
        `episode ${episodeId} already exists with a DIFFERENT graph — refusing to overwrite live desired state (P18-A3)`,
      );
    }
    // Identical seed: true idempotent no-op on the graph.
    return dir;
  }
  await mkdir(join(dir, "prompts"), { recursive: true });
  await mkdir(join(dir, "events"), { recursive: true });
  await mkdir(join(dir, "sessions"), { recursive: true });
  await mkdir(join(dir, "wt"), { recursive: true });
  await publishEpisodeGraph(graphFile, seed);
  return dir;
}

/**
 * P19-F2 (audit F2 of bda9d1f): the FIRST write of graph.json is race-free.
 * The P18-A3 compare protects an existing graph, but two concurrent first
 * creations both saw ENOENT and both renamed — last writer silently won.
 * Publishing now goes through a no-replace link: stage the serialized graph
 * beside the target, `link(tmp, graph.json)` (atomic EEXIST when the target
 * exists — never an overwrite), and on EEXIST re-read the WINNER's bytes and
 * apply the same P18-A3 identity rule (identical seed → idempotent no-op;
 * different → throw without touching the winner). An abandoned staging tmp
 * (its creator died between create and link, or link failed) is reclaimed
 * past STALE_TMP_MS by sweepStaleTmp on the next call. The full graph is
 * written + fsynced into the staging tmp BEFORE the link, so graph.json —
 * the commit marker — can never be observed partially published.
 */
async function publishEpisodeGraph(path: string, seed: EpisodeGraph): Promise<void> {
  const serialized = serializeValidated(seed, GRAPH_JSON_SCHEMA, "graph");
  const dir = dirname(path);
  await sweepStaleTmp(dir);
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const handle = await fsOpen(tmp, "wx", 0o644);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(tmp, path); // no-replace: EEXIST iff the marker exists
        return; // this call published the commit marker
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // Someone else's marker won — judge THEIR bytes, never overwrite.
        const winner = await readFile(path, "utf8").catch((re: unknown) => {
          if ((re as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw re;
        });
        if (winner === undefined) continue; // vanished between link and read: retry once
        let current: unknown;
        try {
          current = JSON.parse(winner);
        } catch {
          throw new EpisodeSchemaError(`episode ${seed.episodeId}: existing graph.json is corrupt — refusing to overwrite`);
        }
        if (canonicalJson(current) !== canonicalJson(seed)) {
          throw new EpisodeSchemaError(
            `episode ${seed.episodeId} already exists with a DIFFERENT graph — refusing to overwrite live desired state (P18-A3)`,
          );
        }
        return; // identical winner: idempotent success
      }
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
  throw new EpisodeSchemaError("graph.json vanished mid-publish (a racing unlink) — retry the call");
}

/** Canonical JSON for identity comparison: recursively key-sorted, so two
 *  parses of the same desired state always compare equal (P18-A3). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

// ────────────────────────────── S3 — graph.json ─────────────────────────────

export const GRAPH_SCHEMA_ID = "tre-graph/1";

export type TaskStatus = "queued" | "ready" | "running" | "paused" | "done" | "failed" | "parked";
export const TASK_STATUSES: readonly TaskStatus[] = ["queued", "ready", "running", "paused", "done", "failed", "parked"];

/** Derived projection written by the supervisor after acceptance (S3). */
export interface TaskResult {
  verdict: string;
  acceptance: "complete" | "incomplete" | "blocked" | "uncertain";
  artifacts: string[];
}

/** S3 desired-scope + §14.7 task policy fragments. */
export interface TaskScope {
  files: string[];
  notFiles: string[];
}
export interface TaskAcceptance {
  criteria: string[];
  requiredChecks: string[];
  artifacts: string[];
}
export interface TaskBudget {
  maxTurns: number;
  maxUsd?: number;
}

export interface EpisodeTask {
  id: string;
  persona: string;
  promptRef: string;
  dependsOn: string[];
  model?: string;
  approval?: "yes" | "auto" | "ask";
  /** §14.4: integer starting at 1, bumped ONLY by a rung-4 rewrite. */
  revision?: number;
  scope?: TaskScope;
  acceptance?: TaskAcceptance;
  budget?: TaskBudget;
  /** Derived projection (never an input to recovery, S3 authority rule). */
  status?: TaskStatus;
  result?: TaskResult;
}

/** §14.7 episode policy (defaults documented there). */
export interface RecoveryBudget {
  maxAttemptsPerTask?: number;
  maxNudgesPerTask?: number;
  maxStrategyRepeats?: number;
  maxEpisodeRecoveryUsd?: number;
  maxEpisodeRecoveryTurns?: number;
  maxWallclockPerAttemptS?: number;
}
export interface EpisodeAuthority {
  paths: string[];
  notPaths: string[];
  allowInstalls?: boolean;
  allowNetwork?: boolean;
  allowExternalEffects?: boolean;
  models?: string[];
  diagnostics?: { maxToolCalls: number; maxUsd: number };
}
export interface EpisodePolicy {
  baseCommit?: string;
  gate?: { cmd: string; timeoutS?: number };
  approval?: "auto" | "ask";
  maxParallel?: number;
  recoveryBudget?: RecoveryBudget;
  authority?: EpisodeAuthority;
  integration?: { autoMergeTested?: boolean; promoteToMain?: "auto" | "ask" };
}

export interface EpisodeGraph {
  schema: typeof GRAPH_SCHEMA_ID;
  episodeId: string;
  goal: string;
  maxRounds?: number;
  tasks: EpisodeTask[];
  policy?: EpisodePolicy;
}

// Local persistence shapes: unknown fields remain additive, but every known
// field is checked. Do not extend the deliberately lenient tool validator.
type Shape = JsonSchema & {
  nullable?: boolean;
  minimum?: number;
  nonEmpty?: boolean;
  values?: Shape;
  properties?: Record<string, Shape>;
  items?: Shape;
};
const str: Shape = { type: "string" };
const id: Shape = { type: "string", nonEmpty: true };
const bool: Shape = { type: "boolean" };
const num: Shape = { type: "number", minimum: 0 };
const count: Shape = { type: "integer", minimum: 0 };
const revision: Shape = { type: "integer", minimum: 1 };
const boolTrue: Shape = { type: "boolean", enum: [true] }; // P14: criteria[].advisory is literal true
const strings: Shape = { type: "array", items: str };
const choice = (...values: string[]): Shape => ({ type: "string", enum: values });
const obj = (properties: Record<string, Shape>, required: string[] = []): Shape => ({ type: "object", properties, required });
const nullable = (shape: Shape): Shape => ({ ...shape, nullable: true });
const status = choice(...TASK_STATUSES);
const GRAPH_JSON_SCHEMA: Shape = obj({
  schema: choice(GRAPH_SCHEMA_ID), episodeId: id, goal: str, maxRounds: revision,
  tasks: { type: "array", items: obj({
    id, persona: id, promptRef: id, dependsOn: { type: "array", items: id },
    model: id, approval: choice("yes", "auto", "ask"), revision, status,
    scope: obj({ files: strings, notFiles: strings }, ["files", "notFiles"]),
    acceptance: obj({ criteria: strings, requiredChecks: strings, artifacts: strings }, ["criteria", "requiredChecks", "artifacts"]),
    budget: obj({ maxTurns: count, maxUsd: num }, ["maxTurns"]),
    result: obj({ verdict: str, acceptance: choice("complete", "incomplete", "blocked", "uncertain"), artifacts: strings }, ["verdict", "acceptance", "artifacts"]),
  }, ["id", "persona", "promptRef", "dependsOn"]) },
  policy: obj({
    baseCommit: id, gate: obj({ cmd: id, timeoutS: num }, ["cmd"]), approval: choice("auto", "ask"), maxParallel: revision,
    recoveryBudget: obj({ maxAttemptsPerTask: count, maxNudgesPerTask: count, maxStrategyRepeats: count, maxEpisodeRecoveryUsd: num, maxEpisodeRecoveryTurns: count, maxWallclockPerAttemptS: num }),
    authority: obj({ paths: strings, notPaths: strings, allowInstalls: bool, allowNetwork: bool, allowExternalEffects: bool, models: strings,
      diagnostics: obj({ maxToolCalls: count, maxUsd: num }, ["maxToolCalls", "maxUsd"]) }, ["paths", "notPaths"]),
    integration: obj({ autoMergeTested: bool, promoteToMain: choice("auto", "ask") }),
  }),
}, ["schema", "episodeId", "goal", "tasks"]);

export async function readEpisodeGraph(path: string): Promise<EpisodeGraph> {
  return parseValidated(await readFile(path, "utf8"), GRAPH_JSON_SCHEMA, "graph", path) as EpisodeGraph;
}

/** Atomic replacement (atomic-rename JSON, S6 rule; process-death scope §13.1). */
export async function writeEpisodeGraph(path: string, graph: EpisodeGraph): Promise<void> {
  await writeJsonAtomic(path, graph, GRAPH_JSON_SCHEMA, "graph");
}

// ────────────────────────────── S6 — state.json ─────────────────────────────

export const STATE_SCHEMA_ID = "tre-episode-state/1";

/** One runtime row per task. Restart-resume anchor ONLY: anything
 *  rebuildable from files is not stored here beyond a cache (S6), and PIDs
 *  are hints, not ownership (§14.5/I1). */
export interface EpisodeTaskState {
  status: TaskStatus;
  pid?: number;
  attemptId?: string;
  session?: string;
  /** Tailed-session resume offset — an optimization, not authority (I4). */
  offset?: number;
  nudges?: number;
  stops?: number;
  modelsTried?: string[];
}

export interface EpisodeState {
  schema: typeof STATE_SCHEMA_ID;
  episodeId: string;
  supervisorPid?: number;
  tasks: Record<string, EpisodeTaskState>;
  slots?: Record<string, string | null>;
  telegram?: { pendingApproval: unknown | null };
}

const STATE_JSON_SCHEMA: Shape = obj({
  schema: choice(STATE_SCHEMA_ID), episodeId: id, supervisorPid: revision,
  tasks: { type: "object", values: obj({ status, pid: revision, attemptId: id, session: id, offset: count, nudges: count, stops: count, modelsTried: strings }, ["status"]) },
  slots: { type: "object", values: nullable(id) },
  telegram: obj({ pendingApproval: { nullable: true } as Shape }, ["pendingApproval"]),
}, ["schema", "episodeId", "tasks"]);

export async function readEpisodeState(path: string): Promise<EpisodeState> {
  return parseValidated(await readFile(path, "utf8"), STATE_JSON_SCHEMA, "state", path) as EpisodeState;
}

export async function writeEpisodeState(path: string, state: EpisodeState): Promise<void> {
  await writeJsonAtomic(path, state, STATE_JSON_SCHEMA, "state");
}

// ────────────────────── S5 / §14.3 — decisions.jsonl ────────────────────────

export const DECISION_SCHEMA_ID = "tre-supervisor/1";

/** Closed signal set — extensible ONLY via a docs/11 Change Ledger row. */
export const DECISION_SIGNAL_KINDS = [
  "guard-stop",
  "warn-rung",
  "semantic-loop",
  "verify-gap",
  "no-advance",
  "endpoint-error",
  "budget-threshold",
  "worker-exit",
  "worker-blocked-on-approval",
] as const;
export type DecisionSignalKind = (typeof DECISION_SIGNAL_KINDS)[number];

export interface DecisionSignal {
  kind: DecisionSignalKind;
  [extra: string]: unknown;
}

/** Closed action enum (S5 + P0 extension). No action executes whose type
 *  is not in this enum; new actions need a Change Ledger row first. */
export const SUPERVISOR_ACTIONS = [
  "nudge",
  "evidence-nudge-resume",
  "model-swap",
  "task-rewrite",
  "escalate",
  "kill",
  "park",
  "merge",
  "backoff-retry",
  "investigate",
  "repair",
  "accept-finish",
] as const;
export type SupervisorAction = (typeof SUPERVISOR_ACTIONS)[number];

export type SideEffectClass = "none" | "worktree-local" | "external";

export interface RecordEnvelope {
  schema: typeof DECISION_SCHEMA_ID;
  /** Caller-stable unique id (e.g. "d-0042"). */
  id: string;
  ts: number;
  episodeId: string;
  taskId?: string;
}

export interface DecisionIntentRecord extends RecordEnvelope {
  kind: "decision-intent";
  actionId: string;
  attemptId?: string;
  taskRevision?: number;
  rung: number;
  action: SupervisorAction;
  strategyId?: string;
  expectedEvidence?: string;
  observation?: { signals: DecisionSignal[]; context?: Record<string, unknown> };
  authority?: { grantedBy: string; sideEffect: SideEffectClass };
  rationale?: string;
}

export interface DecisionOutcomeRecord extends RecordEnvelope {
  kind: "decision-outcome";
  actionId: string;
  acked: boolean;
  progress: "none" | "uptake" | "task-relevant";
  evidenceRefs?: string[];
  closedById?: string | null;
  notes?: string;
}

export interface AcceptanceCriterion {
  id: string;
  pass: boolean;
  evidenceRef?: string;
  checkedAtSha?: string;
  /** P14 amendment (docs/13 EV6): pass funded ONLY by a model judgment —
   *  never set on a deterministic criterion (AC8). */
  advisory?: true;
}

export interface AcceptanceRecord extends RecordEnvelope {
  kind: "acceptance";
  taskRevision?: number;
  verdict: "complete" | "incomplete" | "blocked" | "uncertain";
  criteria: AcceptanceCriterion[];
  remainingWork?: string[];
  invalidatedBy?: string | null;
  modelAdvisory?: { judge: string; quote: string; confidence: number } | null;
  /** P14 amendment (docs/13): evidence seen but NOT at the record's
   *  artifact identity — ignored for the verdict, kept for visibility. */
  staleEvidenceRefs?: string[];
  /** P14 amendment (docs/13 §1): the artifact identity the verdict binds
   *  to — the staleness anchor for stored assessments. */
  artifact?: { sha: string; dirty?: boolean; dirtyDigest?: string; unobservable?: true };
}

export interface DiagnosisRecord extends RecordEnvelope {
  kind: "diagnosis";
  attemptId?: string;
  causeClass:
    | "transient-endpoint"
    | "premature-stop"
    | "task-defect"
    | "environment-blocker"
    | "approval-boundary"
    | "unknown";
  confidence?: number;
  evidenceRefs?: string[];
  proposedActions?: { rung: number; action: SupervisorAction; strategyId?: string; authorityNeeded?: SideEffectClass }[];
  limitsRespected?: { toolsUsed: number; spendUsd: number };
}

/** §14.1 attempt record — the durable answer to "which attempt owns which
 *  session file" (derived ownership, §14.5). spawnOutcome absent/null =
 *  intent without observed outcome ⇒ discover-or-park (I2), never blind
 *  re-spawn. pid/pgid (P7 audit F1/F2/F5/F6): stamped into the "ok"
 *  resolve record at spawn — the journal, not state.json, is the
 *  liveness-discovery source (state.json demoted to cache, S6); a
 *  supervisor restart never loses the process evidence, and a stale
 *  hint row can neither add nor remove a claim. */
export interface AttemptRecord extends RecordEnvelope {
  kind: "attempt";
  attemptId: string;
  taskRevision?: number;
  sessionPath: string;
  model?: string;
  worktreePath?: string;
  spawnOutcome?: "ok" | "failed" | null;
  /** Recorded by the runner on the "ok" resolve (the process existed). */
  pid?: number;
  /** Process-group id when spawned detached (stop() signals the group). */
  pgid?: number;
  /** Causal spawn generation per session path (P7 audit finding 3): the
   *  runner stamps 1 + the max generation of ANY record on the session
   *  when it writes the intent, and every later record for that spawn
   *  (resolve, confirmation) COPIES it — so a confirmation's later `ts`
   *  can never reorder ownership. Supersession compares generations,
   *  never wall-clock timestamps, where generations exist; records
   *  without the field are legacy (generation 0). */
  spawnGen?: number;
  /** A (audit): the spawn mode this tuple actually forked under —
   *  stamped on the "ok" resolve alongside pid/pgid (the mode is only
   *  known once the spec is built, which is AFTER the intent append).
   *  Confirmations COPY it via the latest-record spread. Consumers
   *  reading a stopped/group verdict must know whether a private group
   *  existed at all: non-detached children share a foreign group that
   *  the runner can neither sweep nor probe. Absent on records
   *  predating the field. */
  detached?: boolean;
  /** A (audit): true ONLY on a `failed` resolve produced by the spawn
   *  machinery AT SPAWN TIME (spawn error / invalid spec / user-spawner
   *  throw / child died before it could be confirmed). A confirmStopped
   *  "failed" is a CONFIRMATION (written at reopen): it says when a death
   *  was observed, never when the process spawned — it must never
   *  participate in spawn ordering (firstSpawnSeq). */
  spawnEvidence?: boolean;
  /** A (audit): true ONLY on the resolve written by confirmStopped —
   *  an explicit confirmation written at reopen time. Its append position
   *  reflects WHEN it was written, never when the process spawned, so it
   *  must never participate in legacy spawn ordering (firstSpawnSeq):
   *  a late confirmation of an old tuple would re-supersede the newer
   *  live tuple. */
  confirmation?: boolean;
}

/** p12c5 cycle-1 audit F3: durable seq HIGH-WATER record — the allocator's
 *  answer to "which integration seqs are already SPENT" that survives the
 *  loss of the counted outcomes. The host derives executionSeq from the
 *  count of ACKED merge outcomes; that derivation forgets a seq whose
 *  terminal sits above the count (e.g. spent under an operator-raised
 *  recovery bump). Reverting to a plain activation then RE-DERIVES a spent
 *  identity — P12 answers already-executed and refuses to integrate new
 *  work forever. One record per allocation at a NEW high-water durably
 *  allocates the seq: the allocator takes max(count, bump, records) and
 *  never re-issues a seq any record shows as spent. */
export interface SeqHighWaterRecord extends RecordEnvelope {
  kind: "seq-high-water";
  seq: number;
}

export type SupervisorRecord =
  | DecisionIntentRecord
  | DecisionOutcomeRecord
  | AcceptanceRecord
  | DiagnosisRecord
  | AttemptRecord
  | SeqHighWaterRecord;

export type SupervisorRecordKind = SupervisorRecord["kind"];

const sideEffect = choice("none", "worktree-local", "external");
const rung: Shape = { type: "integer", minimum: 0, enum: [0, 1, 2, 3, 4, 5] };
const envelope = { schema: choice(DECISION_SCHEMA_ID), id, ts: num, episodeId: id, taskId: id };
const recordShape = (properties: Record<string, Shape>, required: string[]): Shape =>
  obj({ ...envelope, ...properties }, ["schema", "id", "ts", "episodeId", "kind", ...required]);
const RECORD_SCHEMAS: Record<SupervisorRecordKind, Shape> = {
  "decision-intent": recordShape({
    kind: choice("decision-intent"), actionId: id, attemptId: id, taskRevision: revision, rung,
    action: choice(...SUPERVISOR_ACTIONS), strategyId: id, expectedEvidence: str,
    observation: obj({ signals: { type: "array", items: obj({ kind: choice(...DECISION_SIGNAL_KINDS) }, ["kind"]) }, context: { type: "object" } }, ["signals"]),
    authority: obj({ grantedBy: id, sideEffect }, ["grantedBy", "sideEffect"]), rationale: str,
  }, ["actionId", "rung", "action"]),
  "decision-outcome": recordShape({ kind: choice("decision-outcome"), actionId: id, acked: bool,
    progress: choice("none", "uptake", "task-relevant"), evidenceRefs: strings, closedById: nullable(id), notes: str,
  }, ["actionId", "acked", "progress"]),
  acceptance: recordShape({ kind: choice("acceptance"), taskRevision: revision,
    verdict: choice("complete", "incomplete", "blocked", "uncertain"),
    criteria: { type: "array", items: obj({ id, pass: bool, evidenceRef: id, checkedAtSha: id,
      advisory: boolTrue, // P14 amendment (docs/13): literal true only
    }, ["id", "pass"]) },
    remainingWork: strings, invalidatedBy: nullable(id),
    modelAdvisory: nullable(obj({ judge: id, quote: str, confidence: num }, ["judge", "quote", "confidence"])),
    staleEvidenceRefs: strings, // P14 amendment (docs/13)
    artifact: obj({ sha: id, dirty: bool, dirtyDigest: id, unobservable: boolTrue }, ["sha"]), // P14 amendment (docs/13 §1); C2-F3 (cycle 2): NOT nullable — the TS interface declares the field optional-but-non-null and an explicit null carried no meaning (an absent field is the "no identity" case); R3-F2 (round-3): `unobservable` is literal true (boolTrue) — an unmeasured identity rides through the durable record and refuses comparison on replay
  }, ["verdict", "criteria"]),
  diagnosis: recordShape({ kind: choice("diagnosis"), attemptId: id,
    causeClass: choice("transient-endpoint", "premature-stop", "task-defect", "environment-blocker", "approval-boundary", "unknown"),
    confidence: num, evidenceRefs: strings,
    proposedActions: { type: "array", items: obj({ rung, action: choice(...SUPERVISOR_ACTIONS), strategyId: id, authorityNeeded: sideEffect }, ["rung", "action"]) },
    limitsRespected: obj({ toolsUsed: count, spendUsd: num }, ["toolsUsed", "spendUsd"]),
  }, ["causeClass"]),
  attempt: recordShape({ kind: choice("attempt"), attemptId: id, taskRevision: revision, sessionPath: id,
    model: id, worktreePath: id, spawnOutcome: nullable(choice("ok", "failed")),
    pid: revision, pgid: revision, // P7 audit F1/F6: stamped on the "ok" resolve (see AttemptRecord)
    spawnGen: revision, // P7 audit finding 3: causal generation per session (see AttemptRecord)
    detached: bool, // A (audit): spawn mode stamped on the "ok" resolve (see AttemptRecord)
    spawnEvidence: bool, // A (audit): failed-resolve from the spawn machinery itself (see AttemptRecord)
    confirmation: bool, // A (audit): resolve written by confirmStopped — never spawn evidence (see AttemptRecord)
  }, ["attemptId", "sessionPath"]),
  "seq-high-water": recordShape({ kind: choice("seq-high-water"), seq: count, // ≥0: seq 0 is a real allocation
  }, ["seq"]),
};

/** Validate one record against its kind schema. Throws on violation. */
export function validateSupervisorRecord(record: SupervisorRecord): void {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new EpisodeSchemaError("decision record must be an object");
  }
  const kind = record.kind;
  if (!Object.hasOwn(RECORD_SCHEMAS, kind)) throw new EpisodeSchemaError(`decision record: unknown kind ${JSON.stringify(kind)}`);
  const err = validateShape(RECORD_SCHEMAS[kind], record);
  if (err) throw new EpisodeSchemaError(`decision record: schema invalid: ${err}`);
}

/**
 * Append-only journal (I4: never rewritten under a live reader).
 *
 * Durability (§13.1 scoping): decisions are a SYNC-BEFORE-ACK class —
 * `append` fsyncs the line before resolving, so a returned append is
 * durable across process death AND visible to a tailing supervisor.
 * A crash mid-append can leave a torn tail; `DecisionJournal.open`
 * performs the §13.1 repair (truncate unparseable tail / terminate a
 * complete-but-unterminated record) before any further appends.
 */
export class DecisionJournal {
  private pending: Promise<void> = Promise.resolve();
  private poisoned = false;
  private repaired = false;
  private constructor(readonly path: string) {}

  /** True when the last `open` actually repaired a torn tail (§13.1) — a
   *  truncated unparseable fragment or a record whose newline was lost.
   *  Without this, an episode whose only record was torn away is
   *  indistinguishable from one that never wrote anything. */
  get tornTailRepaired(): boolean {
    return this.repaired;
  }

  /** Open the journal, repairing the tail (§13.1) when it exists.
   *  Mid-file corruption throws — repair only ever touches the tail. */
  static async open(path: string): Promise<DecisionJournal> {
    const journal = new DecisionJournal(path);
    await journal.read(); // fail closed on any corruption except an unterminated JSON tail
    journal.repaired = await journal.#repairTail();
    return journal;
  }

  /** Create (or open) the journal inside an episode's events/ dir. */
  static async forEpisode(episodePath: string): Promise<DecisionJournal> {
    const dir = join(episodePath, "events");
    await mkdir(dir, { recursive: true });
    return DecisionJournal.open(join(dir, "decisions.jsonl"));
  }

  /** Serialized per instance under the caller's exclusive-writer ownership.
   * FileHandle.appendFile may use multiple syscalls: queue complete lines,
   * fsync before resolving, and poison on any I/O failure. Reopen to validate
   * and repair before retrying; never append behind an ambiguous failed write.
   * Separate instances/processes require the supervisor ownership fence (P7).
   */
  async append(record: SupervisorRecord): Promise<void> {
    let serialized: string;
    try { serialized = JSON.stringify(record); }
    catch (e) { throw new EpisodeSchemaError(`decision record: cannot serialize JSON (${(e as Error).message})`); }
    validateSupervisorRecord(JSON.parse(serialized) as SupervisorRecord);
    const line = serialized + "\n"; // validate the exact snapshot before yielding
    const operation = this.pending.then(async () => {
      if (this.poisoned) throw new EpisodeSchemaError("journal append failed; reopen before appending");
      try {
        const handle = await fsOpen(this.path, "a", 0o644);
        try {
          await handle.appendFile(line, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (e) {
        this.poisoned = true;
        throw e;
      }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  /** Read every record. The LAST line may be torn (a crash mid-append): it
   *  is skipped and reported (same semantics as loadSession's
   *  droppedTornTail). Any OTHER malformed line is mid-file corruption and
   *  THROWS — corrupt records are never skipped-and-counted, because a
   *  silently dropped decision would corrupt I2 reconcile. Duplicate ids
   *  are reported, not silently dropped. */
  async read(): Promise<{ records: SupervisorRecord[]; tornTail: boolean; duplicateIds: string[] }> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { records: [], tornTail: false, duplicateIds: [] };
      }
      throw e;
    }
    const out: SupervisorRecord[] = [];
    const seen = new Map<string, number>();
    const duplicateIds: string[] = [];
    const lines = raw.split("\n");
    // A trailing "" after the final newline is not a line.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    let tornTail = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") {
        if (i === lines.length - 1 && !raw.endsWith("\n")) { tornTail = true; continue; } // whitespace-only torn tail
        throw new EpisodeSchemaError(`decisions.jsonl: corrupt line ${i + 1} (blank line — records are exactly one JSON object per line)`);
      }
      const duplicated = duplicateKeyIn(line);
      if (duplicated !== undefined) {
        throw new EpisodeSchemaError(`decisions.jsonl: line ${i + 1} repeats the key ${JSON.stringify(duplicated)} (JSON.parse is last-wins — refusing an ambiguous record)`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (i === lines.length - 1 && !raw.endsWith("\n")) {
          tornTail = true; // the crash cut; repair-on-open removes it
          continue;
        }
        throw new EpisodeSchemaError(`decisions.jsonl: corrupt line ${i + 1} (mid-file corruption)`);
      }
      validateSupervisorRecord(parsed as SupervisorRecord);
      const id = (parsed as RecordEnvelope).id;
      if (seen.has(id)) {
        if (!duplicateIds.includes(id)) duplicateIds.push(id);
      } else {
        seen.set(id, i);
      }
      out.push(parsed as SupervisorRecord);
    }
    return { records: out, tornTail, duplicateIds };
  }

  /** §13.1 repair, journal edition: an unparseable tail line is truncated
   *  away; a complete record that lost only its terminating newline is
   *  KEPT and terminated. Idempotent; a clean file is untouched. */
  async #repairTail(): Promise<boolean> {
    let st;
    try {
      st = await stat(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; // nothing to repair
      throw e;
    }
    if (st.size === 0) return false;
    const buf = await readFile(this.path);
    if (buf[buf.length - 1] === 0x0a) return false; // terminated — clean
    const lastNL = buf.lastIndexOf(0x0a);
    const tail = buf.subarray(lastNL + 1).toString("utf8");
    // Same ambiguity boundary as read(): a complete-but-unterminated tail with
    // a repeated key must not be terminated into the journal. Checked here
    // rather than relying on open() calling read() first.
    const duplicated = duplicateKeyIn(tail);
    if (duplicated !== undefined) {
      throw new EpisodeSchemaError(`decisions.jsonl: unterminated tail repeats the key ${JSON.stringify(duplicated)} — refusing to repair an ambiguous record`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(tail); } catch {
      await truncate(this.path, lastNL + 1);
      return true;
    }
    validateSupervisorRecord(parsed as SupervisorRecord);
    await appendFile(this.path, "\n");
    return true;
  }
}

// ───────────────────── I2 reconcile helpers (projections) ───────────────────

/**
 * Intents with no recorded outcome for their actionId are OPEN (I2):
 * recovery may close them only against observed reality — never by
 * re-issuing the action (I5 for sideEffect:"external").
 */
export function openIntents(records: SupervisorRecord[]): DecisionIntentRecord[] {
  const closureKey = (r: { episodeId: string; taskId?: string; actionId: string }) =>
    JSON.stringify([r.episodeId, r.taskId ?? "", r.actionId]);
  const closed = new Set(
    records.filter((r): r is DecisionOutcomeRecord => r.kind === "decision-outcome").map(closureKey),
  );
  return records.filter((r): r is DecisionIntentRecord => r.kind === "decision-intent" && !closed.has(closureKey(r)));
}

/** The latest attempt record for a task (§14.5 derived ownership). When an
 *  episodeId is given the lookup is scoped to it — a journal fragment or a
 *  merged replay must never surface another episode's attempt. */
export function latestAttempt(records: SupervisorRecord[], taskId: string, episodeId?: string): AttemptRecord | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (r.kind === "attempt" && r.taskId === taskId && (episodeId === undefined || r.episodeId === episodeId)) return r;
  }
  return undefined;
}

/** Attempt records whose spawn intent never resolved (I2: discover-or-
 *  park — these must NOT be blindly re-spawned). */
export function unresolvedSpawns(records: SupervisorRecord[]): AttemptRecord[] {
  const latest = new Map<string, AttemptRecord>();
  for (const record of records) {
    if (record.kind === "attempt") latest.set(JSON.stringify([record.episodeId, record.taskId, record.attemptId]), record);
  }
  return [...latest.values()].filter((r) => r.spawnOutcome === undefined || r.spawnOutcome === null);
}

/** Fresh id helper matching the S5 convention ("d-<uuid prefix>"). */
export function newDecisionId(): string {
  return `d-${randomUUID()}`;
}

// ────────────────────────────── internals ───────────────────────────────────

export class EpisodeSchemaError extends Error {}

function validateShape(schema: Shape, value: unknown, path = "$", ancestors: Set<unknown> = new Set()): string | undefined {
  if (schema.nullable && value === null) return undefined;
  const isObject = typeof value === "object" && value !== null;
  if (isObject) {
    // Ancestry-only cycle detection: a node shared between SIBLING branches
    // (a diamond) is JSON-serializable and valid; only re-entering an
    // ancestor on the current path is a cycle.
    if (ancestors.has(value)) return `${path}: circular reference`;
    ancestors.add(value);
  }
  try {
    return validateShapeInner(schema, value, path, ancestors);
  } finally {
    if (isObject) ancestors.delete(value);
  }
}

function validateShapeInner(schema: Shape, value: unknown, path: string, ancestors: Set<unknown>): string | undefined {
  const err = validateArgs({ type: schema.type, enum: schema.enum }, value);
  if (err) return `${path}: ${err}`;
  if (schema.nonEmpty && value === "") return `${path}: must be non-empty`;
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) return `${path}: below minimum ${schema.minimum}`;
  if (schema.type === "object") {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(object, key)) return `${path}: missing required property "${key}"`;
    }
    for (const [key, entry] of Object.entries(object)) {
      const shape = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties![key] : schema.values;
      if (shape) { const error = validateShape(shape, entry, `${path}.${key}`, ancestors); if (error) return error; }
    }
  }
  if (schema.type === "array" && schema.items) {
    for (let i = 0; i < (value as unknown[]).length; i++) {
      const error = validateShape(schema.items, (value as unknown[])[i], `${path}[${i}]`, ancestors);
      if (error) return error;
    }
  }
  return undefined;
}

/** Duplicate keys in one raw JSON object. JSON.parse is LAST-WINS, so a
 *  repeated `kind`/`id`/`actionId` validates as a record the author never
 *  wrote — and decision records drive I2 reconcile. Check the boundary.
 *  @internal — exported ONLY so tests can pin this predicate directly
 *  (deterministic fuzz + the tail-repair guard's input contract); production
 *  callers are read(), parseValidated(), and #repairTail. Do not import. */
export function duplicateKeyIn(text: string): string | undefined {
  const stack: (Set<string> | null)[] = []; // null = array frame
  let expectKey = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === '"') break;
        j++;
      }
      const frame = stack[stack.length - 1];
      if (frame && expectKey) {
        let key: string;
        // Decode the key so `"a"` and `"\u0061"` are the SAME key (JSON.parse
        // would collapse them; a raw-slice comparison would not).
        try { key = JSON.parse(text.slice(i, j + 1)) as string; } catch { key = text.slice(i, j + 1); }
        if (frame.has(key)) return key;
        frame.add(key);
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (ch === "{") { stack.push(new Set()); expectKey = true; i++; continue; }
    if (ch === "[") { stack.push(null); i++; continue; }
    if (ch === "}" || ch === "]") { stack.pop(); i++; continue; }
    if (ch === ":") { expectKey = false; i++; continue; }
    if (ch === ",") { if (stack[stack.length - 1]) expectKey = true; i++; continue; }
    i++;
  }
  return undefined;
}

function parseValidated(text: string, schema: Shape, what: string, path: string): unknown {
  const duplicated = duplicateKeyIn(text);
  if (duplicated !== undefined) {
    throw new EpisodeSchemaError(`${what} ${path}: repeated key ${JSON.stringify(duplicated)} (JSON.parse is last-wins — refusing an ambiguous document)`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new EpisodeSchemaError(`${what} ${path}: not valid JSON (${(e as Error).message})`);
  }
  const err = validateShape(schema, value);
  if (err) throw new EpisodeSchemaError(`${what} ${path}: schema invalid: ${err}`);
  return value;
}

/** Snapshot and validate the persisted representation before yielding or I/O. */
function serializeValidated(value: unknown, schema: Shape, what: string): string {
  try {
    const serialized = JSON.stringify(value, null, 2) + "\n";
    const err = validateShape(schema, JSON.parse(serialized));
    if (err) throw new EpisodeSchemaError(`${what}: schema invalid: ${err}`);
    return serialized;
  } catch (e) {
    if (e instanceof EpisodeSchemaError) throw e;
    throw new EpisodeSchemaError(`${what}: cannot serialize JSON (${(e as Error).message})`);
  }
}

const STALE_TMP_MS = 60_000;

/** P20-F4 (audit cycle 2, finding 4): age ALONE was the sweep's safety
 *  bound, but a LIVE-but-paused publisher (SIGSTOP, fs stall, oversubscribed
 *  scheduler) can keep a staged tmp open past any age bound, and the sweep
 *  would unlink it under it — the resumed writer then died at rename/link
 *  with ENOENT. The tmp name embeds the writer's pid (`.tmp-<pid>-<uuid>`),
 *  so the sweep is now PID-AWARE (same rule as the lease tmp sweep in
 *  host/supervise.ts): a tmp owned by a LIVE pid is never touched; only a
 *  tmp whose embedded owner pid is provably dead (or unparseable, falling
 *  back to the age bound) is reclaimed. Best effort. */
const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code === "EPERM"; }
};

async function sweepStaleTmp(dir: string): Promise<void> {
  let names: string[];
  try { names = await readdir(dir); } catch { return; }
  const now = Date.now();
  await Promise.all(names
    .map((n) => {
      const m = /^(.*)\.tmp-([0-9]+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(n);
      return m === null ? null : { full: join(dir, n), ownerPid: Number(m[2]) };
    })
    .filter((e) => e !== null)
    .map(async ({ full, ownerPid }) => {
      try {
        // A live owner's stage survives whatever its age (P20-F4); an
        // uninterpretable pid is UNKNOWN (age-bound fallback), a dead one
        // is garbage at any age.
        if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
          if (pidAlive(ownerPid)) return; // live publisher: never touch
        } else if (now - (await stat(full)).mtimeMs <= STALE_TMP_MS) {
          return; // unknown owner, not yet aged
        }
        await rm(full, { force: true });
      } catch { /* racing writer or vanished */ }
    }));
}

/** Atomic replacement: write to a sibling tmp file, fsync, rename over the
 *  target, then unlink a FAILED tmp (best effort). A concurrent reader
 *  sees either the old file or the new one, never a partial write. */
async function writeJsonAtomic(path: string, value: unknown, schema: Shape, what: string): Promise<void> {
  const serialized = serializeValidated(value, schema, what);
  await mkdir(dirname(path), { recursive: true });
  await sweepStaleTmp(dirname(path)); // crash-leaked .tmp-* siblings are garbage
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await fsOpen(tmp, "w", 0o644);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
  } catch (e) {
    await handle.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  try { await rename(tmp, path); } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
