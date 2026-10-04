/**
 * Endpoint visibility — unit tests for the PURE `workers` bottom field in
 * state.ts (the field rendering). The poller in run.tsx (timers + Ink) is
 * not tested here; the frozen registry read (readWorkerStatuses) is covered
 * by its own tests. These pin the one-liner format, the done/failed marks,
 * the +N overflow, and the running/done/none color.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkerStatus } from "../src/types.js";
import {
  bottomLineColors,
  bottomLines,
  bottomValue,
  BOTTOM_FIELDS,
  makeInitialState,
  type TuiState,
} from "../src/tui/state.js";

// ── fixtures ────────────────────────────────────────────────────────────────
/** A minimal WorkerStatus (id/model/status are the required contract fields). */
const worker = (over: Partial<WorkerStatus> = {}): WorkerStatus => ({
  id: "w1",
  model: "gpt-6-luna",
  endpoint: "http://a/v1",
  status: "running",
  turn: 3,
  activity: "bash",
  updatedAt: 0,
  startedAt: 0,
  cwd: "/w",
  task: "t",
  ...over,
});

/** A TuiState with the given workers set (the poller's job, done by hand). */
const withWorkers = (workers: WorkerStatus[]): TuiState => ({
  ...makeInitialState("m"),
  workers,
});

// ── BOTTOM_FIELDS registry ──────────────────────────────────────────────────

test("BOTTOM_FIELDS includes 'workers' (pinnable via /display-bottom)", () => {
  assert.ok(
    (BOTTOM_FIELDS as readonly string[]).includes("workers"),
    "workers must be a selectable bottom field",
  );
});

// ── bottomValue: the one-liner format ───────────────────────────────────────

test("bottomValue workers: empty set → 'none'", () => {
  assert.equal(bottomValue(withWorkers([]), "workers"), "none");
  // makeInitialState defaults the field to an empty set (no poller yet).
  assert.equal(bottomValue(makeInitialState("m"), "workers"), "none");
});

test("bottomValue workers: one running worker shows model, turn, activity", () => {
  const s = withWorkers([worker({ model: "gpt-6-luna", turn: 3, activity: "bash" })]);
  const v = bottomValue(s, "workers");
  assert.equal(v, "1: gpt-6-luna t3 bash");
  assert.ok(v.includes("gpt-6-luna"), "model id present");
  assert.ok(v.includes("t3"), "turn number present");
  assert.ok(v.includes("bash"), "activity present");
});

test("bottomValue workers: multiple running workers are joined with ' · '", () => {
  const s = withWorkers([
    worker({ id: "a", model: "gpt-6-luna", turn: 3, activity: "bash" }),
    worker({ id: "b", model: "qwen", turn: 1, activity: "working" }),
  ]);
  assert.equal(bottomValue(s, "workers"), "2: gpt-6-luna t3 bash · qwen t1 working");
});

test("bottomValue workers: a done worker is marked ✓", () => {
  const s = withWorkers([worker({ status: "done", turn: 5, activity: "working" })]);
  const v = bottomValue(s, "workers");
  assert.ok(v.includes("✓"), "done mark present");
  assert.ok(!v.includes("✗"), "no failed mark");
  assert.equal(v, "1: gpt-6-luna t5 working ✓");
});

test("bottomValue workers: a failed worker is marked ✗", () => {
  const s = withWorkers([worker({ status: "failed", turn: 2, activity: "bash" })]);
  const v = bottomValue(s, "workers");
  assert.ok(v.includes("✗"), "failed mark present");
  assert.ok(!v.includes("✓"), "no done mark");
  assert.equal(v, "1: gpt-6-luna t2 bash ✗");
});

test("bottomValue workers: running workers carry no mark", () => {
  const s = withWorkers([worker({ status: "running" })]);
  const v = bottomValue(s, "workers");
  assert.ok(!v.includes("✓") && !v.includes("✗"), "running = unmarked");
});

test("bottomValue workers: 4 workers → first 3 segments + a '+1' suffix", () => {
  const s = withWorkers([
    worker({ id: "a", model: "a", turn: 0, activity: "" }),
    worker({ id: "b", model: "b", turn: 0, activity: "" }),
    worker({ id: "c", model: "c", turn: 0, activity: "" }),
    worker({ id: "d", model: "d", turn: 0, activity: "" }),
  ]);
  const v = bottomValue(s, "workers");
  assert.ok(v.includes("a"), "first worker shown");
  assert.ok(v.includes("b"), "second worker shown");
  assert.ok(v.includes("c"), "third worker shown");
  assert.ok(!v.includes("d"), "fourth worker collapsed");
  assert.ok(v.includes("+1"), "+1 overflow suffix present");
  // empty activity is omitted from the segment.
  assert.equal(v, "4: a t0 · b t0 · c t0 +1");
});

test("bottomValue workers: exactly 3 workers → no overflow suffix", () => {
  const s = withWorkers([
    worker({ id: "a", model: "a", turn: 0, activity: "" }),
    worker({ id: "b", model: "b", turn: 0, activity: "" }),
    worker({ id: "c", model: "c", turn: 0, activity: "" }),
  ]);
  const v = bottomValue(s, "workers");
  assert.ok(!v.includes("+"), "no +N at exactly 3");
  assert.equal(v, "3: a t0 · b t0 · c t0");
});

// ── bottomLineColors: the workers tint ──────────────────────────────────────

test("bottomLineColors workers: green when a worker is running", () => {
  const s = { ...withWorkers([worker({ status: "running" }), worker({ status: "done" })]), bottom: ["workers"] };
  assert.deepEqual(bottomLineColors(s), ["green", undefined, undefined]);
});

test("bottomLineColors workers: yellow when only done/failed are present", () => {
  const s = { ...withWorkers([worker({ status: "done" }), worker({ status: "failed" })]), bottom: ["workers"] };
  assert.deepEqual(bottomLineColors(s), ["yellow", undefined, undefined]);
});

test("bottomLineColors workers: undefined (dim) when empty", () => {
  const s = { ...withWorkers([]), bottom: ["workers"] };
  assert.deepEqual(bottomLineColors(s), [undefined, undefined, undefined]);
});

// ── bottomLines: the field renders as 'workers: <value>' ────────────────────

test("bottomLines: the workers field renders 'workers: <one-liner>'", () => {
  const s = {
    ...withWorkers([worker({ model: "gpt-6-luna", turn: 3, activity: "bash" })]),
    bottom: ["workers"],
  };
  assert.equal(bottomLines(s, 80)[0], "workers: 1: gpt-6-luna t3 bash");
});
