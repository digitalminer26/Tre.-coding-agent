/**
 * P4 — episode journal primitives (docs/11 §4/S3, §5/S4, §6/S5, §7/S6,
 * §14.3, §13.1 durability).
 *
 * Covers:
 *  - graph.json / state.json round-trips through the atomic-rename writer,
 *    schema rejection on BOTH write and read (bad schema id, missing
 *    required fields), and atomic replacement under concurrent writers
 *    (final file is one complete document, no torn JSON, no stray tmp).
 *  - decisions.jsonl append-only journal: validate-before-append, sync-
 *    before-return, torn-tail §13.1 repair (truncate vs terminate),
 *    mid-file corruption throws, duplicate-id reporting.
 *  - I2 reconcile projections: openIntents / latestAttempt / unresolvedSpawns.
 *  - S4 dir scaffold creation (idempotent).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  createEpisodeLayout,
  episodeDir,
  EpisodeSchemaError,
  GRAPH_SCHEMA_ID,
  latestAttempt,
  newDecisionId,
  openIntents,
  readEpisodeGraph,
  readEpisodeState,
  DecisionJournal,
  duplicateKeyIn,
  STATE_SCHEMA_ID,
  unresolvedSpawns,
  validateSupervisorRecord,
  writeEpisodeGraph,
  writeEpisodeState,
  type AttemptRecord,
  type DecisionIntentRecord,
  type DecisionOutcomeRecord,
  type EpisodeGraph,
  type EpisodeState,
  type SupervisorRecord,
} from "../src/episode/journal.js";

async function tmpEpisode(): Promise<{ root: string; dir: string }> {
  const root = await mkdtemp(join(tmpdir(), "tre-episodes-"));
  return { root, dir: episodeDir(root, "ep-test") };
}

const minimalGraph: EpisodeGraph = {
  schema: GRAPH_SCHEMA_ID,
  episodeId: "ep-test",
  goal: "land P4 primitives",
  tasks: [
    { id: "t1", persona: "implementer", promptRef: "prompts/t1.md", dependsOn: [] },
  ],
};

const minimalState: EpisodeState = {
  schema: STATE_SCHEMA_ID,
  episodeId: "ep-test",
  tasks: { t1: { status: "running", pid: 4242 } },
};

// ─────────────────────────── graph.json (S3) ────────────────────────────────

test("graph.json round-trips through the atomic writer", async () => {
  const { root, dir } = await tmpEpisode();
  const path = join(dir, "graph.json");
  await writeEpisodeGraph(path, minimalGraph);
  const back = await readEpisodeGraph(path);
  assert.deepEqual(back, minimalGraph);
});

test("graph write rejects a foreign schema id and missing required fields", async () => {
  const { dir } = await tmpEpisode();
  const path = join(dir, "graph.json");
  await assert.rejects(
    () => writeEpisodeGraph(path, { ...minimalGraph, schema: "tre-graph/0" } as never),
    EpisodeSchemaError,
  );
  await assert.rejects(
    () => writeEpisodeGraph(path, { ...minimalGraph, tasks: [{ id: "t1" }] } as never),
    /schema invalid/,
  );
  // rejected writes never touch the target: the failed writes left no file.
  await assert.rejects(() => readEpisodeGraph(path));
});

test("graph read rejects corrupt JSON and mid-file schema violation", async () => {
  const { dir } = await tmpEpisode();
  await mkdir(dir, { recursive: true });
  const path = join(dir, "graph.json");
  await writeFile(path, "{ not json");
  await assert.rejects(() => readEpisodeGraph(path), /not valid JSON/);
  await writeFile(path, JSON.stringify({ schema: GRAPH_SCHEMA_ID, episodeId: "x", goal: "g" }));
  await assert.rejects(() => readEpisodeGraph(path), /missing required property "tasks"/);
});

test("concurrent graph writes: final file is one complete document, no stray tmp", async () => {
  const { dir } = await tmpEpisode();
  const path = join(dir, "graph.json");
  const big: EpisodeGraph = {
    ...minimalGraph,
    goal: "g".repeat(100_000), // large enough that a naive write would interleave
  };
  await Promise.all([writeEpisodeGraph(path, minimalGraph), writeEpisodeGraph(path, big)]);
  const final = await readEpisodeGraph(path); // parses → one whole doc won
  assert.ok(final.goal === minimalGraph.goal || final.goal === big.goal);
  const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

// ─────────────────────────── state.json (S6) ────────────────────────────────

test("state.json round-trips and rejects a bad schema id", async () => {
  const { dir } = await tmpEpisode();
  const path = join(dir, "state.json");
  await writeEpisodeState(path, minimalState);
  assert.deepEqual(await readEpisodeState(path), minimalState);
  await assert.rejects(
    () => writeEpisodeState(path, { ...minimalState, schema: "tre-state/1" } as never),
    EpisodeSchemaError,
  );
});

// ────────────────────────── S4 dir scaffold ─────────────────────────────────

test("episode layout creates prompts/ events/ sessions/ wt/ and seeds graph", async () => {
  const { root, dir } = await tmpEpisode();
  const created = await createEpisodeLayout(root, "ep-test", minimalGraph);
  assert.equal(created, dir);
  for (const sub of ["prompts", "events", "sessions", "wt"]) {
    assert.ok((await stat(join(dir, sub))).isDirectory(), `${sub} missing`);
  }
  assert.deepEqual(await readEpisodeGraph(join(dir, "graph.json")), minimalGraph);
  // idempotent
  await createEpisodeLayout(root, "ep-test", minimalGraph);
});

// ────────────────────── decisions.jsonl (S5 / §14.3) ────────────────────────

function intent(over: Partial<DecisionIntentRecord> = {}): DecisionIntentRecord {
  return {
    schema: "tre-supervisor/1",
    id: "d-0042",
    ts: 1730231234000,
    episodeId: "ep-test",
    taskId: "t2",
    kind: "decision-intent",
    actionId: "a-0042-nudge-1",
    attemptId: "t2-a1",
    rung: 1,
    action: "nudge",
    ...over,
  };
}
function outcome(over: Partial<DecisionOutcomeRecord> = {}): DecisionOutcomeRecord {
  return {
    schema: "tre-supervisor/1",
    id: "d-0042-o",
    ts: 1730231290000,
    episodeId: "ep-test",
    taskId: "t2",
    kind: "decision-outcome",
    actionId: "a-0042-nudge-1",
    acked: true,
    progress: "uptake",
    ...over,
  };
}

test("journal append round-trips records in order; missing file reads empty", async () => {
  const { dir } = await tmpEpisode();
  const journal = await DecisionJournal.forEpisode(dir);
  await journal.append(intent());
  await journal.append(outcome());
  const { records, tornTail, duplicateIds } = await journal.read();
  assert.equal(records.length, 2);
  assert.equal(records[0]!.kind, "decision-intent");
  assert.equal(records[1]!.kind, "decision-outcome");
  assert.equal(tornTail, false);
  assert.deepEqual(duplicateIds, []);

  // a nonexistent journal reads empty (ENOENT → empty, not a throw)
  const missing = await DecisionJournal.open(join(dir, "nope", "decisions.jsonl"));
  assert.deepEqual(await missing.read(), { records: [], tornTail: false, duplicateIds: [] });
});

test("append validates before writing: bad action/kind never reaches the file", async () => {
  const { dir } = await tmpEpisode();
  const journal = await DecisionJournal.forEpisode(dir);
  await assert.rejects(
    () => journal.append(intent({ action: "reboot-datacenter" as never })),
    /schema invalid/,
  );
  await assert.rejects(
    () => journal.append({ ...intent(), kind: "vibes" } as unknown as SupervisorRecord),
    /unknown kind/,
  );
  const { records } = await journal.read();
  assert.equal(records.length, 0);
  // rejected appends never open the file (validation precedes fsOpen)
  await assert.rejects(() => readFile(join(dir, "events", "decisions.jsonl"), "utf8"), { code: "ENOENT" });
});

test("torn tail: unparseable partial line is truncated on open, complete records survive (§13.1)", async () => {
  const { dir } = await tmpEpisode();
  const journalPath = join(dir, "events", "decisions.jsonl");
  await mkdir(join(dir, "events"), { recursive: true });
  await writeFile(journalPath, JSON.stringify(intent()) + "\n" + JSON.stringify(outcome()).slice(0, 25));
  // read() reports the torn tail without throwing…
  const first = await (await DecisionJournal.open(journalPath)).read();
  // …open already repaired it, so the survivor set is exactly the good line:
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0]!.kind, "decision-intent");
  const after = await readFile(journalPath, "utf8");
  assert.ok(after.endsWith("\n"));
  assert.equal(after.split("\n").filter(Boolean).length, 1);
  // idempotent
  const j2 = await DecisionJournal.open(journalPath);
  assert.equal((await j2.read()).records.length, 1);
});

test("torn tail: complete record that lost only its newline is KEPT and terminated", async () => {
  const { dir } = await tmpEpisode();
  const journalPath = join(dir, "events", "decisions.jsonl");
  await mkdir(join(dir, "events"), { recursive: true });
  const line = JSON.stringify(intent());
  await writeFile(journalPath, JSON.stringify(outcome()) + "\n" + line);
  await DecisionJournal.open(journalPath);
  const after = await readFile(journalPath, "utf8");
  assert.ok(after.endsWith("\n"));
  const records = (await (await DecisionJournal.open(journalPath)).read()).records;
  assert.equal(records.length, 2);
});

test("mid-file corruption throws and leaves the file byte-identical (repair only touches the tail)", async () => {
  const { dir } = await tmpEpisode();
  const journalPath = join(dir, "events", "decisions.jsonl");
  await mkdir(join(dir, "events"), { recursive: true });
  const corrupt = JSON.stringify(intent()) + "\n{x corrupt\n" + JSON.stringify(outcome()) + "\n";
  await writeFile(journalPath, corrupt);
  await assert.rejects(async () => {
    const j = await DecisionJournal.open(journalPath);
    await j.read();
  }, /mid-file corruption/);
  // The parenthetical in the test name is the contract: a failed open must not
  // have mutated anything. Repair only ever touches an unterminated TAIL.
  assert.equal(await readFile(journalPath, "utf8"), corrupt);
});

test("duplicate ids are reported, not silently dropped", async () => {
  const { dir } = await tmpEpisode();
  const journal = await DecisionJournal.forEpisode(dir);
  await journal.append(intent());
  await journal.append(intent()); // same id
  const { records, duplicateIds } = await journal.read();
  assert.equal(records.length, 2);
  assert.deepEqual(duplicateIds, ["d-0042"]);
});

test("reconcile projections: openIntents / latestAttempt / unresolvedSpawns (I2)", async () => {
  const attempt = (over: Partial<AttemptRecord>): AttemptRecord => ({
    schema: "tre-supervisor/1",
    id: "d-a1",
    ts: 1,
    episodeId: "ep-test",
    taskId: "t2",
    kind: "attempt",
    attemptId: "t2-a1",
    sessionPath: "sessions/t2.jsonl",
    ...over,
  });
  const records: SupervisorRecord[] = [
    intent(), // actionId a-0042-nudge-1 — closed below
    intent({ id: "d-0043", actionId: "a-0043-swap-1", action: "model-swap" }), // stays OPEN
    outcome(),
    attempt({ attemptId: "t2-a1", spawnOutcome: "ok" }),
    attempt({ id: "d-a2", attemptId: "t2-a2", spawnOutcome: null }), // unresolved spawn
  ];
  assert.deepEqual(openIntents(records).map((r) => r.actionId), ["a-0043-swap-1"]);
  assert.equal(latestAttempt(records, "t2")!.attemptId, "t2-a2");
  assert.equal(latestAttempt(records, "t9"), undefined);
  assert.deepEqual(unresolvedSpawns(records).map((r) => r.attemptId), ["t2-a2"]);
});

test("validateSupervisorRecord enforces the envelope (schema/id/episodeId)", () => {
  assert.throws(() => validateSupervisorRecord(intent({ id: "" })), EpisodeSchemaError);
  assert.throws(
    () => validateSupervisorRecord({ ...intent(), schema: "tre-supervisor/2" } as never),
    /schema invalid/,
  );
  assert.doesNotThrow(() => validateSupervisorRecord(intent()));
});

test("newDecisionId is unique and prefixed", () => {
  const ids = new Set(Array.from({ length: 200 }, newDecisionId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.ok(id.startsWith("d-"));
});

test("no process in src/ references episode journal files yet (P4: primitives only)", async () => {
  // The P4 exit criterion: these primitives exist but NOTHING outside
  // src/episode/ touches graph.json / state.json / decisions.jsonl or
  // imports the journal module. Guards against a premature writer creeping
  // in before the supervisor (P6+) exists.
  const { execFileSync } = await import("node:child_process");
  let hits = "";
  try {
    hits = execFileSync(
      "grep",
      ["-rn", "--include=*.ts", "-e", "graph.json", "-e", "decisions.jsonl", "-e", "tre-graph", "-e", "tre-episode-state", "-e", "episode/journal", "src/"],
      { cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8" },
    );
  } catch (e) {
    // grep exits 1 on no match; anything else is a real error
    const err = e as { status?: number; stdout?: string };
    if (err.status !== 1) throw e;
  }
  const offenders = hits
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.startsWith("src/episode/"));
  assert.deepEqual(offenders, [], `episode journal files must have exactly one module owner (src/episode/) until the supervisor lands`);
});

// Audit regressions: data read from disk has no TypeScript guarantees.
test("complete graph/state validation rejects malformed known fields on read and write", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const invalidGraphs = [
    { ...minimalGraph, policy: { authority: { paths: [], notPaths: [], allowExternalEffects: "yes" } } },
    { ...minimalGraph, policy: { recoveryBudget: { maxEpisodeRecoveryUsd: "unlimited" } } },
    { ...minimalGraph, tasks: [{ ...minimalGraph.tasks[0], budget: { maxTurns: -1 } }] },
    { ...minimalGraph, tasks: [{ ...minimalGraph.tasks[0], scope: { files: 1, notFiles: [] } }] },
    { ...minimalGraph, tasks: [{ ...minimalGraph.tasks[0], acceptance: { criteria: [], requiredChecks: "gate", artifacts: [] } }] },
    { ...minimalGraph, tasks: [{ ...minimalGraph.tasks[0], revision: 0 }] },
    { ...minimalGraph, tasks: [{ ...minimalGraph.tasks[0], model: 12 }] },
    { ...minimalGraph, tasks: [{ ...minimalGraph.tasks[0], approval: "anything" }] },
  ];
  const invalidStates = [
    { ...minimalState, tasks: { t1: null } },
    { ...minimalState, tasks: { t1: { status: "imaginary" } } },
    { ...minimalState, tasks: { t1: { status: "running", offset: -1 } } },
    { ...minimalState, tasks: { t1: { status: "running", modelsTried: [4] } } },
    { ...minimalState, slots: { local: 1 } },
    { ...minimalState, telegram: {} },
  ];
  await mkdir(dir, { recursive: true });
  for (const bad of invalidGraphs) {
    const path = join(dir, "graph.json");
    await assert.rejects(writeEpisodeGraph(path, bad as never), EpisodeSchemaError);
    await writeFile(path, JSON.stringify(bad));
    await assert.rejects(readEpisodeGraph(path), EpisodeSchemaError);
  }
  for (const bad of invalidStates) {
    const path = join(dir, "state.json");
    await assert.rejects(writeEpisodeState(path, bad as never), EpisodeSchemaError);
    await writeFile(path, JSON.stringify(bad));
    await assert.rejects(readEpisodeState(path), EpisodeSchemaError);
  }
});

test("all record kinds enforce fields, closed enums, and own kind lookup", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await DecisionJournal.forEpisode(dir);
  const invalid = [
    null, [], { ...intent(), kind: "toString" }, { ...intent(), kind: "constructor" },
    { ...outcome(), actionId: 123 }, { ...outcome(), acked: "false" },
    { ...intent(), episodeId: 12 }, { ...intent(), taskId: false },
    { ...intent(), rung: 1.5 }, { ...intent(), rung: 6 },
    { ...intent(), authority: { grantedBy: 1, sideEffect: "none" } },
    { ...intent(), observation: { signals: [{ kind: "vibes" }] } },
    { ...intent(), kind: "acceptance", verdict: "complete", criteria: [{ id: 1, pass: true }] },
    { ...intent(), kind: "diagnosis", causeClass: "unknown", proposedActions: [{ rung: 2, action: "invalid-action" }] },
    { ...intent(), kind: "attempt", attemptId: 12, sessionPath: "x" },
  ];
  for (const bad of invalid) {
    assert.throws(() => validateSupervisorRecord(bad as never), EpisodeSchemaError);
    await assert.rejects(journal.append(bad as never), EpisodeSchemaError);
    await writeFile(journal.path, JSON.stringify(bad) + "\n");
    await assert.rejects(DecisionJournal.open(journal.path), EpisodeSchemaError);
  }
});

test("nullable attempts and acceptance fields round-trip; resolved spawn intent clears", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await DecisionJournal.forEpisode(dir);
  const attempt: AttemptRecord = { schema: "tre-supervisor/1", id: "spawn", ts: 1, episodeId: "ep-test", taskId: "t1", kind: "attempt", attemptId: "t1-a1", sessionPath: "sessions/t1.jsonl", spawnOutcome: null };
  await journal.append(attempt);
  await journal.append({ ...attempt, id: "spawn-outcome", spawnOutcome: "ok" });
  await journal.append({ schema: "tre-supervisor/1", id: "accept", ts: 2, episodeId: "ep-test", kind: "acceptance", verdict: "complete", criteria: [], invalidatedBy: null, modelAdvisory: null });
  const records = (await journal.read()).records;
  assert.equal(records.length, 3);
  assert.deepEqual(unresolvedSpawns(records), []);
  assert.deepEqual(unresolvedSpawns([attempt, { ...attempt, id: "failed", spawnOutcome: "failed" }]), []);
  assert.deepEqual(unresolvedSpawns([attempt, { ...attempt, episodeId: "other", spawnOutcome: "ok" }]), [attempt]);
});

test("corruption fails closed before repair or append; only unterminated invalid JSON is torn", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await DecisionJournal.forEpisode(dir);
  const good = JSON.stringify(intent()) + "\n";
  for (const bytes of [good + "{bad}\n", good + "{bad}\n{torn", good + "null", good + '{"kind":"vibes"}']) {
    await writeFile(journal.path, bytes);
    await assert.rejects(DecisionJournal.open(journal.path), EpisodeSchemaError);
    assert.equal(await readFile(journal.path, "utf8"), bytes);
  }
  await writeFile(journal.path, good + "{torn");
  assert.equal((await journal.read()).tornTail, true);
  const repaired = await DecisionJournal.open(journal.path);
  await repaired.append(outcome());
  assert.deepEqual((await repaired.read()).records, [intent(), outcome()]);
});

test("episode identity validation happens before any filesystem mutation", async (t) => {
  const { root } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const bad of ["", ".", "..", "../escape", "a/b", "a\\b", "/absolute", "a\0b"]) {
    assert.throws(() => episodeDir(root, bad), EpisodeSchemaError);
    await assert.rejects(createEpisodeLayout(root, bad, minimalGraph), EpisodeSchemaError);
  }
  await assert.rejects(createEpisodeLayout(root, "other", minimalGraph), /must match/);
  await assert.rejects(createEpisodeLayout(root, "ep-test", { ...minimalGraph, tasks: null } as never), EpisodeSchemaError);
  assert.deepEqual(await readdir(root), []);
});

test("concurrent large journal appends are serialized into complete records", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await DecisionJournal.forEpisode(dir);
  const records = Array.from({ length: 6 }, (_, i) => intent({ id: `large-${i}`, rationale: String(i).repeat(1_200_000) }));
  await Promise.all(records.map((r) => journal.append(r)));
  assert.deepEqual((await journal.read()).records, records);
});

test("partial append failure poisons queued and later appends until validated reopening", async (t) => {
  const { open } = await import("node:fs/promises");
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await DecisionJournal.forEpisode(dir);
  await journal.append(intent());
  const probe = await open(journal.path, "a");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.appendFile;
  let calls = 0;
  const mock = t.mock.method(prototype, "appendFile", async function (this: typeof probe, data: string) {
    calls++;
    await original.call(this, data.slice(0, 15), "utf8");
    throw new Error("injected partial write failure");
  });
  try {
    const results = await Promise.allSettled([journal.append(outcome()), journal.append(intent({ id: "queued" }))]);
    assert.ok(results.every((r) => r.status === "rejected"));
    await assert.rejects(journal.append(outcome()), /reopen/);
    assert.equal(calls, 1);
  } finally { mock.mock.restore(); }
  const reopened = await DecisionJournal.open(journal.path);
  await reopened.append(outcome());
  assert.deepEqual((await reopened.read()).records, [intent(), outcome()]);
});

test("atomic writers persist a validated snapshot unaffected by caller mutation", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const graph = structuredClone(minimalGraph);
  const pending = writeEpisodeGraph(join(dir, "graph.json"), graph);
  graph.tasks = null as never;
  await pending;
  assert.deepEqual(await readEpisodeGraph(join(dir, "graph.json")), minimalGraph);
  const state = structuredClone(minimalState);
  const pendingState = writeEpisodeState(join(dir, "state.json"), state);
  state.tasks = null as never;
  await pendingState;
  assert.deepEqual(await readEpisodeState(join(dir, "state.json")), minimalState);
  const before = await readFile(join(dir, "state.json"), "utf8");
  await assert.rejects(writeEpisodeState(join(dir, "state.json"), { ...minimalState, telegram: { pendingApproval: undefined } }), EpisodeSchemaError);
  assert.equal(await readFile(join(dir, "state.json"), "utf8"), before);
});

test("scaffold snapshots the seeded graph before yielding", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const graph = structuredClone(minimalGraph);
  const pending = createEpisodeLayout(root, "ep-test", graph);
  graph.tasks = null as never;
  await pending;
  assert.deepEqual(await readEpisodeGraph(join(dir, "graph.json")), minimalGraph);
});

// ── Spark 1.3 cycle-2 regressions ──────────────────────────────────────────

test("terminated blank lines are corruption, not silently skipped (spark-2 F1)", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await DecisionJournal.forEpisode(dir);
  await journal.append(intent());
  await appendFile(journal.path, "   \n");
  await assert.rejects(DecisionJournal.open(journal.path), EpisodeSchemaError);
  await writeFile(journal.path, JSON.stringify(intent()) + "\n\n" + JSON.stringify(outcome()) + "\n");
  await assert.rejects(DecisionJournal.open(journal.path), /blank line/);
  // A whitespace-only UNTERMINATED tail is torn, not corrupt.
  await writeFile(journal.path, JSON.stringify(intent()) + "\n   ");
  const reopened = await DecisionJournal.open(journal.path);
  assert.equal((await reopened.read()).records.length, 1);
});

test("openIntents closes only within (episodeId,taskId,actionId) — cross-task reuse cannot close (spark-2 F3)", async () => {
  const records = [
    intent({ id: "i1", taskId: "t1", actionId: "X" }),
    intent({ id: "i2", taskId: "t2", actionId: "X" }),
    outcome({ id: "o1", taskId: "t1", actionId: "X" }),
  ];
  assert.deepEqual(openIntents(records).map((r) => r.id), ["i2"]);
});

test("latestAttempt optionally scopes to episodeId (spark-2 F2)", () => {
  const mk = (id: string, episodeId: string, attemptId: string): AttemptRecord =>
    ({ schema: "tre-supervisor/1", id, ts: 1, episodeId, taskId: "t", kind: "attempt", attemptId, sessionPath: `sessions/${attemptId}.jsonl` });
  const foreign = mk("a1", "other", "t-a1");
  const mine = mk("a2", "ep-test", "t-a2");
  const records = [mine, foreign];
  assert.equal(latestAttempt(records, "t")!.attemptId, "t-a1");
  assert.equal(latestAttempt(records, "t", "ep-test")!.attemptId, "t-a2");
  assert.equal(latestAttempt(records, "t", "nope"), undefined);
});

test("circular input is rejected as EpisodeSchemaError, never a stack overflow (spark-2 F4)", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await DecisionJournal.forEpisode(dir);
  const circular = intent() as any;
  circular.observation = { signals: [{ kind: "guard-stop" }], context: {} };
  circular.observation.context.self = circular;
  await assert.rejects(journal.append(circular as SupervisorRecord), EpisodeSchemaError);
  const graph = structuredClone(minimalGraph) as any;
  graph.tasks[0]!.scope = { files: [graph], notFiles: [] };
  await assert.rejects(writeEpisodeGraph(join(dir, "graph.json"), graph), /circular/);
  assert.equal(existsSync(join(dir, "graph.json")), false);
});

test("unserializable (BigInt) records reject with EpisodeSchemaError and leave the journal usable (spark-2 F5)", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await DecisionJournal.forEpisode(dir);
  const bad = structuredClone(intent()) as any;
  bad.observation = { signals: [{ kind: "guard-stop" }], context: { x: 1n } };
  const good = intent();
  await assert.rejects(journal.append(bad as SupervisorRecord), EpisodeSchemaError);
  await journal.append(good); // not poisoned: nothing was written for the bad record
  const { records } = await journal.read();
  assert.deepEqual(records.map((r) => r.id), [good.id]);
});

test("stale .tmp-* siblings from a crashed writer are swept; fresh ones survive (spark-2 F6)", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  const target = join(dir, "graph.json");
  const stale = join(dir, "graph.json.tmp-999-" + "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12));
  await writeFile(stale, "garbage");
  const old = new Date(Date.now() - 120_000);
  await utimes(stale, old, old);
  const fresh = join(dir, "state.json.tmp-999-" + "1".repeat(8) + "-0000-0000-0000-" + "0".repeat(12));
  await writeFile(fresh, "in-flight");
  await writeEpisodeGraph(target, minimalGraph);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true); // under 60s: could belong to a live writer
  await rm(fresh, { force: true });
});

test("createEpisodeLayout failure before graph.json leaves no commit marker; retry completes (spark-2 F7)", async (t) => {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "p4-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const graphPath = join(root, "ep-retry", "graph.json");
  const retryGraph: EpisodeGraph = { ...structuredClone(minimalGraph), episodeId: "ep-retry" };
  // Force the seed write to fail AFTER the mkdirs: a DIRECTORY named graph.json
  // makes the rename EISDIR/ENOTDIR, proving the failure window is marker-less.
  await mkdir(join(root, "ep-retry"), { recursive: true });
  await mkdir(graphPath);
  await assert.rejects(createEpisodeLayout(root, "ep-retry", retryGraph));
  assert.equal((await stat(graphPath)).isDirectory(), true); // still no graph written
  await rm(graphPath, { recursive: true, force: true });
  await createEpisodeLayout(root, "ep-retry", retryGraph); // idempotent retry completes
  assert.deepEqual(await readEpisodeGraph(graphPath), retryGraph);
});

// ── Spark 1.3 cycle-3 regressions ──────────────────────────────────────────

test("poisoned-instance rejection is catchable as EpisodeSchemaError (spark-3 F1)", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await DecisionJournal.forEpisode(dir);
  const probe = await (await import("node:fs/promises")).open(journal.path, "a");
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const original = proto.appendFile;
  const mock = t.mock.method(proto, "appendFile", async function (this: typeof probe) {
    await original.call(this, "{\n", "utf8");
    throw new Error("injected io failure");
  });
  try { await assert.rejects(journal.append(intent())); } finally { mock.mock.restore(); }
  await assert.rejects(journal.append(outcome()), EpisodeSchemaError);
});

test("diamond-shared (non-cyclic) objects validate cleanly; only ancestor cycles reject (spark-3 F2)", () => {
  const shared = { kind: "guard-stop" as const };
  const ok = intent();
  ok.observation = { signals: [shared, shared], context: {} };
  validateSupervisorRecord(ok); // must not throw
  // (Ancestor cycles on schema-traversed paths are pinned by the F4 test above.)
});

test("tmp sweep ignores names outside our exact writer pattern (spark-3 F3)", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  const decoys = [
    join(dir, "graph.json.tmp-1-" + "-".repeat(36)), // 36 dashes: not canonical UUID
    join(dir, "graph.json.tmp-1-0000000Z-0000-0000-0000-000000000000"), // non-hex
    join(dir, "notes.tmp-9-00000000-0000-4000-8000-000000000000.extra"), // trailing suffix
  ];
  const old = new Date(Date.now() - 120_000);
  for (const decoy of decoys) { await writeFile(decoy, "keepme"); await utimes(decoy, old, old); }
  await writeEpisodeGraph(join(dir, "graph.json"), minimalGraph);
  for (const decoy of decoys) assert.equal(await readFile(decoy, "utf8"), "keepme");
});

// ── Post-commit audit (7a52bb7) regressions ────────────────────────────────

test("open() reports whether it repaired a torn tail (post-commit F2)", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const journalPath = join(dir, "events", "decisions.jsonl");
  await mkdir(join(dir, "events"), { recursive: true });

  // Clean file: nothing repaired.
  await writeFile(journalPath, JSON.stringify(intent()) + "\n");
  assert.equal((await DecisionJournal.open(journalPath)).tornTailRepaired, false);

  // Record whose newline was lost: repaired (kept + terminated).
  await writeFile(journalPath, JSON.stringify(intent()));
  const terminated = await DecisionJournal.open(journalPath);
  assert.equal(terminated.tornTailRepaired, true);
  assert.equal((await terminated.read()).records.length, 1);

  // File holding ONLY an unterminated fragment: repaired to empty — and this is
  // now distinguishable from "never wrote anything", which is the whole point.
  await writeFile(journalPath, '{"schema":"tre-supervisor/1","id":"d-9"');
  const emptied = await DecisionJournal.open(journalPath);
  assert.equal(emptied.tornTailRepaired, true);
  assert.deepEqual((await emptied.read()).records, []);
  assert.equal((await stat(journalPath)).size, 0);
});

test("duplicate JSON keys are rejected on every read boundary (post-commit F3)", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await DecisionJournal.forEpisode(dir);

  // Last-wins would forge the effective actionId; we reject the ambiguity.
  await writeFile(journal.path,
    '{"schema":"tre-supervisor/1","id":"d-1","ts":1,"episodeId":"ep","kind":"decision-outcome",'
    + '"actionId":"benign","actionId":"dangerous","acked":true,"progress":"none"}\n');
  await assert.rejects(journal.read(), /repeats the key "actionId"/);

  // Nested duplicates too.
  await writeFile(journal.path,
    '{"schema":"tre-supervisor/1","id":"d-1","ts":1,"episodeId":"ep","kind":"decision-intent","actionId":"a",'
    + '"rung":"r","action":"retry","observation":{"signals":[{"kind":"guard-stop","kind":"guard-stop"}]}}\n');
  await assert.rejects(journal.read(), /repeats the key "kind"/);

  // Escaped-unicode and plain spellings of one key are the SAME key.
  await writeFile(journal.path,
    '{"schema":"tre-supervisor/1","id":"d-1","notes":"a","not\\u0065s":"b","ts":1,"episodeId":"ep",'
    + '"kind":"decision-outcome","actionId":"a","acked":true,"progress":"none"}\n');
  await assert.rejects(journal.read(), /repeats the key "notes"/);

  // Legitimate JSON where the same string appears in different objects is fine.
  await writeFile(journal.path, JSON.stringify({ ...outcome(), notes: JSON.stringify({ id: 1, kind: "x" }) }) + "\n");
  assert.equal((await journal.read()).records.length, 1);

  // graph.json goes through the same boundary check.
  const graphPath = join(dir, "graph.json");
  await writeFile(graphPath, '{"schema":"tre-graph/1","episodeId":"ep","episodeId":"evil","goal":"x","tasks":[]}');
  await assert.rejects(readEpisodeGraph(graphPath), /repeated key "episodeId"/);
});

test("read() no longer advertises an unobservable malformed counter (post-commit F1)", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await DecisionJournal.forEpisode(dir);
  const result = await journal.read();
  assert.deepEqual(Object.keys(result).sort(), ["duplicateIds", "records", "tornTail"]);
  // Corruption throws instead of being counted, so no successful read can
  // ever carry a corrupt-record tally.
  await writeFile(journal.path, JSON.stringify(intent()) + "\n{bad\n" + JSON.stringify(outcome()) + "\n");
  await assert.rejects(journal.read(), EpisodeSchemaError);
});

// Deterministic fuzz of the duplicate-key scanner (audit c1, finding 1):
// the offline 600-document fuzz is now pinned in-repo. Seeded LCG (Math.imul)
// — fully reproducible, no Math.random. Well-formedness is checked by
// JSON.parse; the generator keeps keys unique per object.
test("duplicateKeyIn: deterministic seeded fuzz — no false positives or negatives", async (t) => {
  void t;
  let seed = 0xc0ffee;
  const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed % n; };
  const keys = ["id", "kind", "actionId", "notes", "obs", "a", "b", "nested"];
  const vals = ["1", "true", "null", "-2.5", JSON.stringify('s "q" x'), JSON.stringify('{"id":1}:,[]'), JSON.stringify('x\\y')];
  function genObj(depth: number): string {
    const n = 1 + rnd(5);
    const parts: string[] = [];
    const used = new Set<string>();
    for (let i = 0; i < n; i++) {
      let k = keys[rnd(keys.length)]!;
      for (let tries = 0; used.has(k) && tries < 32; tries++) k = keys[rnd(keys.length)]!;
      if (used.has(k)) continue; // extremely unlikely; skip rather than spin
      used.add(k);
      const r = rnd(6);
      const v = depth > 0 && r === 0 ? "{" + genObj(depth - 1) + "}"
        : depth > 0 && r === 1 ? "[{" + genObj(depth - 1) + "}]"
        : vals[rnd(vals.length)]!;
      parts.push(JSON.stringify(k) + ":" + v);
    }
    return parts.join(",");
  }
  let validCount = 0;
  for (let i = 0; i < 600; i++) {
    const doc = "{" + genObj(2) + "}";
    let parsed: unknown;
    try { parsed = JSON.parse(doc); } catch { continue; }
    void parsed;
    validCount++;
    assert.equal(duplicateKeyIn(doc), undefined, `false positive on ${doc.slice(0, 160)}`);
  }
  assert.ok(validCount >= 550, `only ${validCount}/600 generated docs parsed`);

  // Constructed duplicates: repeat the first key of every top-level object.
  const keyRe = /^("(?:[^"\\]|\\.)*"):/;
  let dupCount = 0;
  seed = 0xbeef01;
  for (let i = 0; i < 600; i++) {
    const body = genObj(2);
    const m = keyRe.exec(body);
    if (!m) continue;
    const dup = "{" + m[0].slice(0, -1) + ':{ "__dup__":1 },' + body + "}"; // sentinel prepended before the real "k":<val>
    // Independent verification of the constructed doc: it must still parse,
    // and JSON.parse's last-wins must collapse the pair onto the REAL value
    // (the generator can never emit the sentinel object) — proving the
    // scanner rejected genuine ambiguity, not a malformed document.
    const parsedDup = JSON.parse(dup) as Record<string, unknown>;
    const dupKey = JSON.parse(m[1]!) as string;
    assert.notDeepEqual(parsedDup[dupKey], { __dup__: 1 }, `last-wins kept the sentinel in ${dup.slice(0, 120)}`);
    dupCount++;
    const found = duplicateKeyIn(dup);
    assert.notEqual(found, undefined, `false negative on ${dup.slice(0, 160)}`);
  }
  assert.ok(dupCount >= 550, `only ${dupCount} duplicate docs constructed`);
});

test("duplicateKeyIn: adversarial scanner cases pinned from the offline audit", async (t) => {
  void t;
  const H = '{"schema":"tre-supervisor/1","id":"d-1","ts":1,"episodeId":"ep","kind":"decision-outcome","actionId":"a","acked":true,"progress":"none"';
  assert.equal(duplicateKeyIn(H + ',"notes":"x\\\\","n2":1}'), undefined);
  assert.equal(duplicateKeyIn(H + ',"notes":"x\\\\","n2":1,"n2":2}'), "n2");
  assert.equal(duplicateKeyIn(H + ',"notes":"{\\"id\\":1}:,[]"}'), undefined);
  assert.equal(duplicateKeyIn(H + ',"notes":"ok","obs":[{"k":1,"k":2}]}'), "k");
  assert.equal(duplicateKeyIn(H + ',"notes":"ok","obs":[{"k":1},{"k":2}]}'), undefined);
  assert.equal(duplicateKeyIn(H.replace(/,/g, ",\n  ") + ',\n "notes" :\t "ok"\n}'), undefined);
  assert.equal(duplicateKeyIn(H + ',"notes":"ok","kind" : "x"}'), "kind");
  assert.equal(duplicateKeyIn(H + ',"notes":"id","id2":"x"}'), undefined);
  // unicode-escape spelled key equals the plain key (JSON.parse last-wins)
  assert.equal(duplicateKeyIn('{"actionId":"a","\\u0061ctionId":"b"}'), "actionId");
});

// Audit c1 finding 2: the tail guard sees the RAW TAIL of an unterminated
// file — a shape the sequential open() path never hands it (read() rejects
// the duplicate first, and the write-side race is not deterministically
// triggerable from the public API). The guard's INPUT CONTRACT is the
// observable part: duplicateKeyIn must catch duplicates inside COMPLETE but
// UNTERMINATED JSON, and must not false-positive on clean tails. Together
// with the open() contract test above, #repairTail's guard line is now
// covered by committed tests.
test("duplicateKeyIn: unterminated-tail contract (the exact input #repairTail guards)", async (t) => {
  void t;
  assert.equal(duplicateKeyIn('{"a":1,"actionId":"x","actionId":"y"'), "actionId"); // complete-but-unterminated dup
  assert.equal(duplicateKeyIn('{"a":1,"b":{"c":1'), undefined);                      // clean partial tail
  assert.equal(duplicateKeyIn('{"a":"unterminated \\" string with ,\"a\":1 inside'), undefined); // inside a (torn) string
  assert.equal(duplicateKeyIn('{"obs":[{"k":1,"k":2}'), "k");                        // nested dup, unterminated
  assert.equal(duplicateKeyIn(""), undefined);
});

// NOTE (honest scope): #repairTail is private and open() calls read() first,
// which already rejects a complete duplicate-key tail — the in-function
// guard is not reachable through a deterministic public-API call (only via
// the write-side race open() closes). This test pins the END-TO-END
// contract; the guard's predicate on its exact raw-tail input is pinned by
// the unterminated-tail contract test above (audit c1, finding 2).
test("repair never terminates an unterminated record that repeats a key (d5447d8 audit)", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await DecisionJournal.forEpisode(dir);
  const dupTail = '{"schema":"tre-supervisor/1","id":"d-1","ts":1,"episodeId":"ep","kind":"decision-outcome","actionId":"a","actionId":"b","acked":true,"progress":"none"}';
  await writeFile(journal.path, dupTail); // complete JSON, newline lost
  await assert.rejects(DecisionJournal.open(journal.path), /repeats the key "actionId"/);
  assert.equal(await readFile(journal.path, "utf8"), dupTail); // not terminated, not mutated
});

test("pretty-printed (multi-line) record is rejected fail-closed, writer output is always one line", async (t) => {
  const { root, dir } = await tmpEpisode();
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await DecisionJournal.forEpisode(dir);
  await journal.append({ ...outcome(), notes: "line1\nline2" });
  const raw = await readFile(journal.path, "utf8");
  assert.equal(raw.split("\n").length - 1, 1); // embedded newline is escaped by JSON.stringify
  assert.equal((await journal.read()).records.length, 1);
  await writeFile(journal.path, JSON.stringify(outcome(), null, 2) + "\n");
  await assert.rejects(journal.read(), EpisodeSchemaError);
});
