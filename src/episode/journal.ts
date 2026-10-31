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
import { appendFile, mkdir, open as fsOpen, readFile, rename, rm, stat, truncate } from "node:fs/promises";
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
  assertSchemaMatch(graph.schema, GRAPH_SCHEMA_ID, "graph.schema");
  const dir = episodeDir(root, episodeId);
  await mkdir(join(dir, "prompts"), { recursive: true });
  await mkdir(join(dir, "events"), { recursive: true });
  await mkdir(join(dir, "sessions"), { recursive: true });
  await mkdir(join(dir, "wt"), { recursive: true });
  await writeEpisodeGraph(join(dir, "graph.json"), graph);
  return dir;
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

const GRAPH_JSON_SCHEMA: JsonSchema = {
  type: "object",
  required: ["schema", "episodeId", "goal", "tasks"],
  properties: {
    schema: { type: "string", enum: [GRAPH_SCHEMA_ID] },
    episodeId: { type: "string" },
    goal: { type: "string" },
    maxRounds: { type: "integer" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "persona", "promptRef", "dependsOn"],
        properties: {
          id: { type: "string" },
          persona: { type: "string" },
          promptRef: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
          revision: { type: "integer" },
          status: { type: "string", enum: [...TASK_STATUSES] },
          result: {
            type: "object",
            required: ["verdict", "acceptance"],
            properties: {
              verdict: { type: "string" },
              acceptance: { type: "string", enum: ["complete", "incomplete", "blocked", "uncertain"] },
              artifacts: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  },
};

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

const STATE_JSON_SCHEMA: JsonSchema = {
  type: "object",
  required: ["schema", "episodeId", "tasks"],
  properties: {
    schema: { type: "string", enum: [STATE_SCHEMA_ID] },
    episodeId: { type: "string" },
    supervisorPid: { type: "integer" },
    tasks: {
      type: "object",
      properties: {},
    },
  },
};

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
}

export interface AcceptanceRecord extends RecordEnvelope {
  kind: "acceptance";
  taskRevision?: number;
  verdict: "complete" | "incomplete" | "blocked" | "uncertain";
  criteria: AcceptanceCriterion[];
  remainingWork?: string[];
  invalidatedBy?: string | null;
  modelAdvisory?: { judge: string; quote: string; confidence: number } | null;
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
 *  re-spawn. */
export interface AttemptRecord extends RecordEnvelope {
  kind: "attempt";
  attemptId: string;
  taskRevision?: number;
  sessionPath: string;
  model?: string;
  worktreePath?: string;
  spawnOutcome?: "ok" | "failed" | null;
}

export type SupervisorRecord =
  | DecisionIntentRecord
  | DecisionOutcomeRecord
  | AcceptanceRecord
  | DiagnosisRecord
  | AttemptRecord;

export type SupervisorRecordKind = SupervisorRecord["kind"];

const RECORD_KINDS = ["decision-intent", "decision-outcome", "acceptance", "diagnosis", "attempt"] as const;

/** Kind-level required fields (§14.3); deep field checks follow the same
 *  zero-dep validator. Unknown extra keys are tolerated (additive). */
const RECORD_SCHEMAS: Record<SupervisorRecordKind, JsonSchema> = {
  "decision-intent": {
    type: "object",
    required: ["schema", "id", "ts", "episodeId", "kind", "actionId", "rung", "action"],
    properties: {
      kind: { type: "string", enum: ["decision-intent"] },
      action: { type: "string", enum: [...SUPERVISOR_ACTIONS] },
      rung: { type: "number" },
      authority: {
        type: "object",
        required: ["grantedBy", "sideEffect"],
        properties: { sideEffect: { type: "string", enum: ["none", "worktree-local", "external"] } },
      },
    },
  },
  "decision-outcome": {
    type: "object",
    required: ["schema", "id", "ts", "episodeId", "kind", "actionId", "acked", "progress"],
    properties: {
      kind: { type: "string", enum: ["decision-outcome"] },
      progress: { type: "string", enum: ["none", "uptake", "task-relevant"] },
    },
  },
  acceptance: {
    type: "object",
    required: ["schema", "id", "ts", "episodeId", "kind", "verdict", "criteria"],
    properties: {
      kind: { type: "string", enum: ["acceptance"] },
      verdict: { type: "string", enum: ["complete", "incomplete", "blocked", "uncertain"] },
      criteria: {
        type: "array",
        items: { type: "object", required: ["id", "pass"], properties: { pass: { type: "boolean" } } },
      },
    },
  },
  diagnosis: {
    type: "object",
    required: ["schema", "id", "ts", "episodeId", "kind", "causeClass"],
    properties: {
      kind: { type: "string", enum: ["diagnosis"] },
      causeClass: {
        type: "string",
        enum: ["transient-endpoint", "premature-stop", "task-defect", "environment-blocker", "approval-boundary", "unknown"],
      },
    },
  },
  attempt: {
    type: "object",
    required: ["schema", "id", "ts", "episodeId", "kind", "attemptId", "sessionPath"],
    properties: {
      kind: { type: "string", enum: ["attempt"] },
      spawnOutcome: { type: "string", enum: ["ok", "failed"] },
    },
  },
};

/** Validate one record against its kind schema. Throws on violation. */
export function validateSupervisorRecord(record: SupervisorRecord): void {
  const envelope = record as unknown as Record<string, unknown>;
  if (envelope.schema !== DECISION_SCHEMA_ID) {
    throw new EpisodeSchemaError(`decision record: expected schema "${DECISION_SCHEMA_ID}", got ${JSON.stringify(envelope.schema)}`);
  }
  if (typeof envelope.id !== "string" || envelope.id === "") {
    throw new EpisodeSchemaError("decision record: id must be a non-empty string");
  }
  if (typeof envelope.ts !== "number" || !Number.isFinite(envelope.ts)) {
    throw new EpisodeSchemaError("decision record: ts must be a finite number");
  }
  const kind = envelope.kind as SupervisorRecordKind;
  const schema = RECORD_SCHEMAS[kind];
  if (!schema) throw new EpisodeSchemaError(`decision record: unknown kind ${JSON.stringify(String(envelope.kind))}`);
  const err = validateArgs(schema, envelope);
  if (err) throw new EpisodeSchemaError(`decision record invalid: schema invalid: ${err}`);
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
  private constructor(readonly path: string) {}

  /** Open the journal, repairing the tail (§13.1) when it exists.
   *  Mid-file corruption throws — repair only ever touches the tail. */
  static async open(path: string): Promise<DecisionJournal> {
    const journal = new DecisionJournal(path);
    await journal.repairTail();
    return journal;
  }

  /** Create (or open) the journal inside an episode's events/ dir. */
  static async forEpisode(episodePath: string): Promise<DecisionJournal> {
    const dir = join(episodePath, "events");
    await mkdir(dir, { recursive: true });
    return DecisionJournal.open(join(dir, "decisions.jsonl"));
  }

  /** Append one record: validate → single JSONL line → fsync → resolve.
   *  The line is written with O_APPEND in one write() call (never
   *  interleaved partials under a reader). */
  async append(record: SupervisorRecord): Promise<void> {
    validateSupervisorRecord(record); // envelope (id/ts) + kind schema
    const handle = await fsOpen(this.path, "a", 0o644);
    try {
      await handle.appendFile(JSON.stringify(record) + "\n", "utf8");
      await handle.sync(); // sync-before-ack (§13.1)
    } finally {
      await handle.close();
    }
  }

  /** Read every record. The LAST line may be torn (a crash mid-append): it
   *  is skipped and reported (same semantics as loadSession's
   *  droppedTornTail). Any OTHER malformed line is mid-file corruption and
   *  throws. Duplicate ids are reported, not silently dropped. */
  async read(): Promise<{ records: SupervisorRecord[]; tornTail: boolean; malformed: number; duplicateIds: string[] }> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { records: [], tornTail: false, malformed: 0, duplicateIds: [] };
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
    let malformed = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (i === lines.length - 1) {
          tornTail = true; // the crash cut; repair-on-open removes it
          continue;
        }
        malformed++;
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
    return { records: out, tornTail, malformed, duplicateIds };
  }

  /** §13.1 repair, journal edition: an unparseable tail line is truncated
   *  away; a complete record that lost only its terminating newline is
   *  KEPT and terminated. Idempotent; a clean file is untouched. */
  async repairTail(): Promise<void> {
    let st;
    try {
      st = await stat(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // nothing to repair
      throw e;
    }
    if (st.size === 0) return;
    const buf = await readFile(this.path);
    if (buf[buf.length - 1] === 0x0a) return; // terminated — clean
    const lastNL = buf.lastIndexOf(0x0a);
    const tail = buf.subarray(lastNL + 1).toString("utf8");
    try {
      JSON.parse(tail);
      // Complete record without its newline: keep it, terminate the line.
      await appendFile(this.path, "\n");
    } catch {
      // Partial tail: truncate everything after the last newline.
      await truncate(this.path, lastNL + 1);
    }
  }
}

// ───────────────────── I2 reconcile helpers (projections) ───────────────────

/**
 * Intents with no recorded outcome for their actionId are OPEN (I2):
 * recovery may close them only against observed reality — never by
 * re-issuing the action (I5 for sideEffect:"external").
 */
export function openIntents(records: SupervisorRecord[]): DecisionIntentRecord[] {
  const closedActionIds = new Set(
    records.filter((r): r is DecisionOutcomeRecord => r.kind === "decision-outcome").map((r) => r.actionId),
  );
  return records.filter((r): r is DecisionIntentRecord => r.kind === "decision-intent" && !closedActionIds.has(r.actionId));
}

/** The latest attempt record for a task (§14.5 derived ownership). */
export function latestAttempt(records: SupervisorRecord[], taskId: string): AttemptRecord | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (r.kind === "attempt" && r.taskId === taskId) return r;
  }
  return undefined;
}

/** Attempt records whose spawn intent never resolved (I2: discover-or-
 *  park — these must NOT be blindly re-spawned). */
export function unresolvedSpawns(records: SupervisorRecord[]): AttemptRecord[] {
  return records.filter((r): r is AttemptRecord => r.kind === "attempt" && (r.spawnOutcome === undefined || r.spawnOutcome === null));
}

/** Fresh id helper matching the S5 convention ("d-<uuid prefix>"). */
export function newDecisionId(): string {
  return `d-${randomUUID()}`;
}

// ────────────────────────────── internals ───────────────────────────────────

export class EpisodeSchemaError extends Error {}

function assertSchemaMatch(actual: string, expected: string, where: string): void {
  if (actual !== expected) {
    throw new EpisodeSchemaError(`${where}: expected schema "${expected}", got ${JSON.stringify(actual)}`);
  }
}

function parseValidated(text: string, schema: JsonSchema, what: string, path: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new EpisodeSchemaError(`${what} ${path}: not valid JSON (${(e as Error).message})`);
  }
  const err = validateArgs(schema, value);
  if (err) throw new EpisodeSchemaError(`${what} ${path}: schema invalid: ${err}`);
  return value;
}

/** Atomic replacement: write to a sibling tmp file, fsync, rename over the
 *  target, then unlink a FAILED tmp (best effort). A concurrent reader
 *  sees either the old file or the new one, never a partial write. */
async function writeJsonAtomic(path: string, value: unknown, schema: JsonSchema, what: string): Promise<void> {
  const err = validateArgs(schema, value);
  if (err) throw new EpisodeSchemaError(`${what}: refusing to write — schema invalid: ${err}`);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await fsOpen(tmp, "w", 0o644);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
  } catch (e) {
    await handle.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  await rename(tmp, path);
}
