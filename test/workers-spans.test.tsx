/**
 * Per-worker colors in the `workers` bottom field — Ink render tests
 * (ink-testing-library). Complements the pure tests in workers-tui.test.ts
 * (the span/ANSI math): here we pin what the App actually DRAWS — the
 * running worker is GREEN (not dimmed), a done/failed worker is GRAY, the
 * `workers: ` prefix + count + separators are dim, and the frame stays
 * exactly `rows` tall (the workers line is one row, never wraps).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/tui/app.js";
import { makeInitialState, type TuiState } from "../src/tui/state.js";
import type { WorkerStatus } from "../src/types.js";

const GREEN = "\u001b[32m";
const GRAY = "\u001b[90m";
const DIM = "\u001b[2m";

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

const makeApp = (state: TuiState) =>
  render(
    React.createElement(App, {
      state,
      onChar: () => {},
      onBackspace: () => {},
      onScrollBy: () => {},
      onScrollToTop: () => {},
      onScrollToBottom: () => {},
      onMove: () => {},
      onHistory: () => {},
      onSubmit: () => {},
      onCtrlC: () => {},
      onApproval: () => {},
      onQuit: () => {},
      onModelPickerNav: () => {},
      onModelPickerConfirm: () => {},
      onModelPickerClose: () => {},
      onSelectStart: () => {},
      onSelectUpdate: () => {},
      onSelectClear: () => {},
    }),
  );

const withWorkers = (workers: WorkerStatus[]): TuiState => ({
  ...makeInitialState("m"),
  bottom: ["workers"],
  workers,
});

/** The single row of the frame that carries the workers field. */
const workersRow = (frame: string): string =>
  frame.split("\n").find((l) => l.includes("workers:")) ?? "";

test("the running worker is GREEN and NOT dimmed; a done worker is GRAY", () => {
  const app = makeApp(
    withWorkers([
      worker({ id: "a", model: "gpt-6-luna", turn: 3, activity: "bash" }),
      worker({ id: "b", model: "qwen", turn: 5, activity: "working", status: "done" }),
    ]),
  );
  const row = workersRow(app.lastFrame() ?? "");
  // The running model is wrapped in the green code (bright — not dimmed).
  assert.ok(row.includes(`${GREEN}gpt-6-luna t3 bash`), "running worker is green");
  // The done model is wrapped in the gray code, with its ✓ mark.
  assert.ok(row.includes(`${GRAY}qwen t5 working ✓`), "done worker is gray");
  // The dim prefix + count are present.
  assert.ok(row.startsWith(DIM), "the row starts dim (the 'workers: ' prefix)");
  assert.ok(row.includes("workers: 2:"), "the count prefix is kept");
  app.unmount();
});

test("a failed worker is GRAY with its ✗ mark", () => {
  const app = makeApp(
    withWorkers([worker({ id: "a", model: "r", turn: 2, activity: "bash", status: "failed" })]),
  );
  const row = workersRow(app.lastFrame() ?? "");
  assert.ok(row.includes(`${GRAY}r t2 bash ✗`), "failed worker is gray with ✗");
  assert.ok(!row.includes(GREEN), "no green when nothing is running");
  app.unmount();
});

test("no workers → the dim 'workers: none' line (unchanged behavior)", () => {
  const app = makeApp(withWorkers([]));
  const row = workersRow(app.lastFrame() ?? "");
  assert.ok(row.includes("workers: none"), "shows 'none'");
  assert.ok(!row.includes(GREEN) && !row.includes(GRAY), "no colored segments");
  app.unmount();
});

test("the workers line is ONE row: the frame height does not change", () => {
  // The frame is exactly `rows` tall by construction; adding workers must not
  // add a row (the workers line is a single truncated row, never wraps).
  const idle = makeApp(withWorkers([]));
  const idleFrame = idle.lastFrame() ?? "";
  idle.unmount();
  const busy = makeApp(
    withWorkers([
      worker({ id: "a", model: "gpt-6-luna", turn: 3, activity: "bash" }),
      worker({ id: "b", model: "qwen", turn: 5, activity: "working", status: "done" }),
      worker({ id: "c", model: "r", turn: 2, activity: "bash", status: "failed" }),
    ]),
  );
  const busyFrame = busy.lastFrame() ?? "";
  busy.unmount();
  const strip = (s: string) => s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
  const lineCount = (f: string) => strip(f).replace(/\n$/, "").split("\n").length;
  assert.equal(lineCount(busyFrame), lineCount(idleFrame), "workers line adds no row");
});

test("a very long workers line truncates to one row (no wrap, SGR survives)", () => {
  const app = makeApp(
    withWorkers([
      worker({ model: "a-very-long-model-name-that-keeps-going", turn: 3, activity: "bash" }),
      worker({ id: "b", model: "another-long-model-name-here", turn: 9, activity: "working", status: "done" }),
    ]),
  );
  const frame = app.lastFrame() ?? "";
  const row = workersRow(frame);
  // Single row: the next row after the workers line is not a continuation.
  const lines = frame.split("\n");
  const i = lines.findIndex((l) => l.includes("workers:"));
  assert.ok(i !== -1, "workers row present");
  const next = lines[i + 1] ?? "";
  assert.ok(!next.includes("another-long-model-name-here"), "no wrapped continuation row");
  // The green span survives truncation.
  assert.ok(row.includes(GREEN), "green span survives");
  app.unmount();
});
