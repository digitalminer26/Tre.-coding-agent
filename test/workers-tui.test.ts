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
  workersBottomSpans,
  workersLineAnsi,
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

// ── workersBottomSpans: the per-worker colored segments ─────────────────────
// The new per-worker color contract: running → green (the active endpoint for
// the current workstream), done/failed → gray (a model that already ran keeps
// its name + turn count visible, dimmed). The segment TEXT is byte-identical
// to the old one-liner (pinned above); only the color is new.

test("workersBottomSpans: running → green, done/failed → gray, text unchanged", () => {
  const spans = workersBottomSpans([
    worker({ id: "a", model: "gpt-6-luna", turn: 3, activity: "bash" }), // running
    worker({ id: "b", model: "qwen", turn: 5, activity: "working", status: "done" }),
    worker({ id: "c", model: "r", turn: 2, activity: "bash", status: "failed" }),
  ]);
  assert.equal(spans.count, 3);
  assert.equal(spans.extra, 0);
  assert.deepEqual(spans.spans, [
    { text: "gpt-6-luna t3 bash", color: "green" },
    { text: "qwen t5 working ✓", color: "gray" },
    { text: "r t2 bash ✗", color: "gray" },
  ]);
});

test("workersBottomSpans: first 3 shown, overflow → extra (count preserved)", () => {
  const spans = workersBottomSpans([
    worker({ id: "a", model: "a", turn: 0, activity: "" }),
    worker({ id: "b", model: "b", turn: 0, activity: "" }),
    worker({ id: "c", model: "c", turn: 0, activity: "" }),
    worker({ id: "d", model: "d", turn: 0, activity: "", status: "done" }),
  ]);
  assert.equal(spans.count, 4);
  assert.equal(spans.extra, 1);
  assert.equal(spans.spans.length, 3, "only the first 3 become spans");
  assert.deepEqual(
    spans.spans.map((s) => s.text),
    ["a t0", "b t0", "c t0"],
  );
});

test("workersBottomSpans: empty set → no spans, count 0, extra 0", () => {
  const spans = workersBottomSpans([]);
  assert.deepEqual(spans, { spans: [], extra: 0, count: 0 });
});

test("workersBottomSpans: exactly 3 → extra 0 (no overflow)", () => {
  const spans = workersBottomSpans([
    worker({ id: "a", model: "a", turn: 0, activity: "" }),
    worker({ id: "b", model: "b", turn: 0, activity: "" }),
    worker({ id: "c", model: "c", turn: 0, activity: "" }),
  ]);
  assert.equal(spans.count, 3);
  assert.equal(spans.extra, 0);
  assert.equal(spans.spans.length, 3);
});

// ── workersLineAnsi: the per-worker colored line (one row) ──────────────────
// The SGR codes match Ink's palette: dim \x1b[2m, green \x1b[32m, gray \x1b[90m.
// The whole line is truncated to one row at `width` (cli-truncate is ANSI-aware).

const DIM = "\u001b[2m";
const RESET = "\u001b[0m";
const GREEN = "\u001b[32m";
const GRAY = "\u001b[90m";

test("workersLineAnsi: one running worker → dim prefix + count + green segment", () => {
  const s = withWorkers([worker({ model: "gpt-6-luna", turn: 3, activity: "bash" })]);
  assert.equal(
    workersLineAnsi(s, 80),
    `${DIM}workers: ${RESET}${DIM}1: ${RESET}${GREEN}gpt-6-luna t3 bash${RESET}`,
  );
});

test("workersLineAnsi: running + done → green then gray, joined by a dim ' · '", () => {
  const s = withWorkers([
    worker({ id: "a", model: "gpt-6-luna", turn: 3, activity: "bash" }),
    worker({ id: "b", model: "qwen", turn: 5, activity: "working", status: "done" }),
  ]);
  assert.equal(
    workersLineAnsi(s, 80),
    `${DIM}workers: ${RESET}${DIM}2: ${RESET}` +
      `${GREEN}gpt-6-luna t3 bash${RESET}${DIM} · ${RESET}${GRAY}qwen t5 working ✓${RESET}`,
  );
});

test("workersLineAnsi: empty set → dim 'workers: none' (no count, no spans)", () => {
  assert.equal(workersLineAnsi(withWorkers([]), 80), `${DIM}workers: none${RESET}`);
});

test("workersLineAnsi: 4 workers → 3 spans + a dim ' +1' suffix", () => {
  const s = withWorkers([
    worker({ id: "a", model: "a", turn: 0, activity: "" }),
    worker({ id: "b", model: "b", turn: 0, activity: "", status: "done" }),
    worker({ id: "c", model: "c", turn: 0, activity: "", status: "failed" }),
    worker({ id: "d", model: "d", turn: 0, activity: "" }),
  ]);
  assert.equal(
    workersLineAnsi(s, 80),
    `${DIM}workers: ${RESET}${DIM}4: ${RESET}` +
      `${GREEN}a t0${RESET}${DIM} · ${RESET}${GRAY}b t0 ✓${RESET}` +
      `${DIM} · ${RESET}${GRAY}c t0 ✗${RESET}${DIM} +1${RESET}`,
  );
});

test("workersLineAnsi: a long line truncates to ONE row at width (ANSI-aware)", () => {
  const s = withWorkers([
    worker({ model: "a-very-long-model-name", turn: 3, activity: "bash" }),
  ]);
  const line = workersLineAnsi(s, 40);
  // cli-truncate is ANSI-aware: no trailing newline, and the SGR codes survive.
  assert.ok(!line.includes("\n"), "single row");
  assert.ok(line.includes(GREEN), "green span survives truncation");
  // The VISIBLE (code-stripped) text ends with the ellipsis and is at most
  // `width` columns (the SGR codes do not count toward the visible width).
  const visible = line.replace(/\u001b\[[0-9;]*m/g, "");
  assert.ok(visible.endsWith("…"), "truncated with an ellipsis");
  assert.ok(visible.length <= 40, `visible width ${visible.length} <= 40`);
});

test("workersLineAnsi: the code-stripped text equals the old one-liner", () => {
  // The per-worker coloring must not change the VISIBLE text — stripping the
  // SGR codes yields exactly what the plain one-liner (bottomValue) produced.
  const workers = [
    worker({ id: "a", model: "gpt-6-luna", turn: 3, activity: "bash" }),
    worker({ id: "b", model: "qwen", turn: 5, activity: "working", status: "done" }),
  ];
  const s = withWorkers(workers);
  // Drop the SGR codes AND the "workers: " field prefix (bottomValue returns
  // the value only) — the remainder must equal the old one-liner exactly.
  const stripped = workersLineAnsi(s, 80)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/^workers: /, "");
  assert.equal(stripped, bottomValue(s, "workers"));
});
