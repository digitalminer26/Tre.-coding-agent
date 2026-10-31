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
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  assert.deepEqual(await missing.read(), { records: [], tornTail: false, malformed: 0, duplicateIds: [] });
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

test("mid-file corruption throws (repair only touches the tail)", async () => {
  const { dir } = await tmpEpisode();
  const journalPath = join(dir, "events", "decisions.jsonl");
  await mkdir(join(dir, "events"), { recursive: true });
  await writeFile(journalPath, JSON.stringify(intent()) + "\n{x corrupt\n" + JSON.stringify(outcome()) + "\n");
  await assert.rejects(async () => {
    const j = await DecisionJournal.open(journalPath);
    await j.read();
  }, /mid-file corruption/);
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
    /expected schema "tre-supervisor\/1"/,
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
      { cwd: new URL("..", import.meta.url).pathname.replace(/\/$/, ""), encoding: "utf8" },
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
