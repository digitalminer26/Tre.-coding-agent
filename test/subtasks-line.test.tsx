/**
 * Per-status colors + expiry in the `subtasks` bottom field — Ink render
 * tests (ink-testing-library). Complements the pure tests in tui-state.test.ts
 * (the ANSI math): here we pin what the App actually DRAWS — the shown
 * subtask's name is tinted by its status (in-progress GREEN, queued YELLOW,
 * done GRAY, failed RED), the `subtasks: ` prefix + fraction are dim, and
 * the EXPIRED flag (the workstream settled and went quiet — the workers
 * field's pruneWorkerDir behavior) renders the dim "subtasks: none".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/tui/app.js";
import { makeInitialState, type TuiState } from "../src/tui/state.js";
import type { SubtaskInfo } from "../src/types.js";

const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const GRAY = "\u001b[90m";
const RED = "\u001b[31m";
const DIM = "\u001b[2m";

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
      onBottomFieldsNav: () => {},
      onBottomFieldsToggle: () => {},
      onBottomFieldsConfirm: () => {},
      onBottomFieldsClose: () => {},
      onSelectStart: () => {},
      onSelectUpdate: () => {},
      onSelectClear: () => {},
    }),
  );

const withSubtasks = (subtasks: SubtaskInfo[], over: Partial<TuiState> = {}): TuiState => ({
  ...makeInitialState("m"),
  bottom: ["subtasks"],
  subtasks,
  ...over,
});

/** The single row of the frame that carries the subtasks field. */
const subtasksRow = (frame: string): string =>
  frame.split("\n").find((l) => l.includes("subtasks:")) ?? "";

test("the active (in-progress) subtask's name is GREEN, not dimmed", () => {
  const app = makeApp(
    withSubtasks([
      { id: 1, name: "wire state", status: "done" },
      { id: 2, name: "add tests", status: "in-progress" },
      { id: 3, name: "run gate", status: "queued" },
    ]),
  );
  const row = subtasksRow(app.lastFrame() ?? "");
  assert.ok(row.includes(`${GREEN}add tests`), "active name is green");
  assert.ok(row.startsWith(DIM), "the row starts dim (the 'subtasks: ' prefix)");
  assert.ok(row.includes("subtasks: 1/3"), "the fraction is kept");
  app.unmount();
});

test("the next (queued) subtask's name is YELLOW with its (next) marker", () => {
  const app = makeApp(
    withSubtasks([
      { id: 1, name: "a", status: "done" },
      { id: 2, name: "b", status: "queued" },
    ]),
  );
  const row = subtasksRow(app.lastFrame() ?? "");
  assert.ok(row.includes(`${YELLOW}b (next)`), "next name is yellow");
  app.unmount();
});

test("all-done shows a GRAY 'done'; failed-only shows a RED name", () => {
  let app = makeApp(
    withSubtasks([
      { id: 1, name: "a", status: "done" },
      { id: 2, name: "b", status: "done" },
    ]),
  );
  let row = subtasksRow(app.lastFrame() ?? "");
  assert.ok(row.includes(`${GRAY}done`), "all-done 'done' is gray");
  app.unmount();

  app = makeApp(
    withSubtasks([
      { id: 1, name: "a", status: "done" },
      { id: 2, name: "b", status: "failed" },
    ]),
  );
  row = subtasksRow(app.lastFrame() ?? "");
  assert.ok(row.includes(`${RED}b (failed)`), "failed name is red");
  app.unmount();
});

test("no subtasks yet → the dim 'subtasks: none'", () => {
  const app = makeApp(withSubtasks([]));
  const row = subtasksRow(app.lastFrame() ?? "");
  assert.ok(row.startsWith(DIM), "the row is fully dim");
  assert.ok(row.includes("subtasks: none"), "shows none");
  app.unmount();
});

test("EXPIRED (settled + quiet) → the dim 'subtasks: none' even with a full list", () => {
  // The list is settled (all done) and the poller flipped subtasksExpired —
  // the field settles to "none" like the workers field does.
  const app = makeApp(
    withSubtasks(
      [
        { id: 1, name: "a", status: "done" },
        { id: 2, name: "b", status: "done" },
      ],
      { subtasksExpired: true },
    ),
  );
  const row = subtasksRow(app.lastFrame() ?? "");
  assert.ok(row.includes("subtasks: none"), "expired renders none");
  assert.ok(row.startsWith(DIM), "the row is fully dim");
  app.unmount();

  // NOT expired (the settle is recent) → the full list still renders.
  const app2 = makeApp(
    withSubtasks(
      [
        { id: 1, name: "a", status: "done" },
        { id: 2, name: "b", status: "done" },
      ],
      { subtasksExpired: false },
    ),
  );
  const row2 = subtasksRow(app2.lastFrame() ?? "");
  assert.ok(row2.includes("subtasks: 2/2"), "not expired → the list shows");
  app2.unmount();
});

test("the picker modal renders above the separator with [x] marks and a * on the first-selected row", () => {
  const app = makeApp({
    ...makeInitialState("m"),
    bottom: ["subtasks"],
    bottomFields: 0, // highlight on "model"
  });
  const frame = app.lastFrame() ?? "";
  assert.ok(frame.includes("> [ ] model"), "the highlighted row is marked");
  assert.ok(frame.includes("[x] * subtasks"), "the selected field is checked + starred");
  assert.ok(frame.includes("[ ] workers"), "unselected fields are unchecked");
  app.unmount();
});
