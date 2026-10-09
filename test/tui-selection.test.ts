/**
 * Mouse selection (opt-in, TRE_MOUSE=1) — pure state-machine tests.
 *
 * The selection is two content-coordinate anchors (itemIndex, line, col)
 * folded by selectStart / selectUpdate / selectClear; selectedRanges and
 * selectedText derive the highlighted cells and the plain copy text. These
 * tests pin the model without touching the terminal or the clipboard:
 *   · press starts an empty (coincident) selection
 *   · motion moves the endpoint, order-normalized (a drag up/left flips)
 *   · a motion with no active selection is ignored (null)
 *   · Esc / selectClear drops it
 *   · a new turn (agent_start) and a compaction (context_compacted) clear it
 *   · single-line, multi-line (same item), and multi-item ranges/text
 *   · empty (coincident) selection → no ranges, "" text
 *   · copySelectionText renders the real item lines at a width
 *
 * The coordinate→anchor MAPPING (terminal row/col → content anchor) lives in
 * app.tsx (it needs the fit) and is covered by the App render tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../src/types.js";
import {
  applyEvent,
  copySelectionText,
  makeInitialState,
  selectClear,
  selectStart,
  selectUpdate,
  selectedRanges,
  selectedText,
  type SelectionAnchor,
  type TuiState,
} from "../src/tui/state.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/** A fixed rendered-line table for the range/text tests (content space). */
const linesOf = (i: number): string[] => {
  if (i === 0) return ["hello world", "second line"];
  if (i === 1) return ["another item"];
  if (i === 2) return ["third item", "third line two"];
  return [];
};

const anchor = (itemIndex: number, line: number, col: number): SelectionAnchor => ({
  itemIndex,
  line,
  col,
});

const base = (): TuiState => makeInitialState("m");

// ── selectStart / selectUpdate / selectClear ────────────────────────────────

test("selectStart: a press anchors both ends (an empty selection)", () => {
  const s = selectStart(base(), anchor(0, 0, 3));
  assert.deepEqual(s.selection, { from: anchor(0, 0, 3), to: anchor(0, 0, 3) });
});

test("selectStart: a new press replaces a prior selection", () => {
  let s = selectStart(base(), anchor(0, 0, 1));
  s = selectUpdate(s, anchor(0, 0, 5))!;
  s = selectStart(s, anchor(1, 0, 2));
  assert.deepEqual(s.selection, { from: anchor(1, 0, 2), to: anchor(1, 0, 2) });
});

test("selectUpdate: motion moves the endpoint (from stays at the press)", () => {
  let s = selectStart(base(), anchor(0, 0, 0));
  s = selectUpdate(s, anchor(0, 0, 5))!;
  assert.deepEqual(s.selection, { from: anchor(0, 0, 0), to: anchor(0, 0, 5) });
});

test("selectUpdate: a drag up/left is order-normalized (from precedes to)", () => {
  // press at (0,1,5), drag to (0,0,2) — the endpoint is BEFORE the press.
  let s = selectStart(base(), anchor(0, 1, 5));
  s = selectUpdate(s, anchor(0, 0, 2))!;
  assert.deepEqual(s.selection, { from: anchor(0, 0, 2), to: anchor(0, 1, 5) });
});

test("selectUpdate: a motion with no active selection returns null", () => {
  const r = selectUpdate(base(), anchor(0, 0, 2));
  assert.equal(r, null);
});

test("selectUpdate: motion to the same endpoint returns the same state (no-op)", () => {
  const s = selectStart(base(), anchor(0, 0, 2));
  const r = selectUpdate(s, anchor(0, 0, 2));
  assert.equal(r, s); // identical reference — nothing to re-render
});

test("selectClear: drops an active selection", () => {
  let s = selectStart(base(), anchor(0, 0, 2));
  s = selectUpdate(s, anchor(0, 0, 5))!;
  assert.notEqual(s.selection, null);
  s = selectClear(s);
  assert.equal(s.selection, null);
});

test("selectClear: a no-selection clear is a no-op (same reference)", () => {
  const s = base();
  assert.equal(selectClear(s), s);
});

// ── lifecycle: a selection does not survive a content replacement ───────────

test("agent_start clears an active selection (a new turn replaces the content)", () => {
  let s = selectStart(base(), anchor(0, 0, 2));
  s = selectUpdate(s, anchor(0, 0, 5))!;
  const ev: AgentEvent = { type: "agent_start" };
  s = applyEvent(s, ev);
  assert.equal(s.selection, null);
  assert.equal(s.busy, true);
});

test("context_compacted clears an active selection (the context was replaced)", () => {
  let s = selectStart(base(), anchor(0, 0, 2));
  s = selectUpdate(s, anchor(0, 0, 5))!;
  const ev: AgentEvent = {
    type: "context_compacted",
    tokensBefore: 1000,
    messagesKept: 3,
    summaryChars: 200,
  };
  s = applyEvent(s, ev);
  assert.equal(s.selection, null);
});

// ── selectedRanges / selectedText ───────────────────────────────────────────

test("no selection → no ranges, empty text", () => {
  assert.deepEqual(selectedRanges(base(), linesOf), []);
  assert.equal(selectedText(base(), linesOf), "");
});

test("empty (coincident) selection → no ranges, empty text", () => {
  const s = selectStart(base(), anchor(0, 0, 3));
  assert.deepEqual(selectedRanges(s, linesOf), []);
  assert.equal(selectedText(s, linesOf), "");
});

test("single-line partial selection → the selected columns only", () => {
  let s = selectStart(base(), anchor(0, 0, 0));
  s = selectUpdate(s, anchor(0, 0, 5))!;
  assert.deepEqual(selectedRanges(s, linesOf), [
    { itemIndex: 0, line: 0, from: 0, to: 5 },
  ]);
  assert.equal(selectedText(s, linesOf), "hello");
});

test("single-line selection offset from the start → only the span", () => {
  let s = selectStart(base(), anchor(0, 0, 6));
  s = selectUpdate(s, anchor(0, 0, 11))!;
  assert.deepEqual(selectedRanges(s, linesOf), [
    { itemIndex: 0, line: 0, from: 6, to: 11 },
  ]);
  assert.equal(selectedText(s, linesOf), "world");
});

test("multi-line selection (one item) → first line partial, last line partial, middle whole", () => {
  // (0,0,2) → (0,1,3): "llo world" then "sec".
  let s = selectStart(base(), anchor(0, 0, 2));
  s = selectUpdate(s, anchor(0, 1, 3))!;
  assert.deepEqual(selectedRanges(s, linesOf), [
    { itemIndex: 0, line: 0, from: 2, to: 11 },
    { itemIndex: 0, line: 1, from: 0, to: 3 },
  ]);
  assert.equal(selectedText(s, linesOf), "llo world\nsec");
});

test("multi-line selection spanning 3 lines → middle lines are whole lines", () => {
  // A 3-line item: first partial, middle whole, last partial.
  const three = (i: number): string[] => (i === 0 ? ["alpha line one", "beta line two", "gamma line three"] : []);
  let s = selectStart(base(), anchor(0, 0, 2));
  s = selectUpdate(s, anchor(0, 2, 4))!;
  assert.deepEqual(selectedRanges(s, three), [
    { itemIndex: 0, line: 0, from: 2, to: 14 },
    { itemIndex: 0, line: 1, from: 0, to: 13 },
    { itemIndex: 0, line: 2, from: 0, to: 4 },
  ]);
  assert.equal(selectedText(s, three), "pha line one\nbeta line two\ngamm");
});

test("multi-item selection → whole lines between the anchors, partial ends", () => {
  // (0,0,2) → (2,1,4): item0 line0 partial, item0 line1 whole, item1 whole,
  // item2 line0 whole, item2 line1 partial.
  let s = selectStart(base(), anchor(0, 0, 2));
  s = selectUpdate(s, anchor(2, 1, 4))!;
  assert.deepEqual(selectedRanges(s, linesOf), [
    { itemIndex: 0, line: 0, from: 2, to: 11 },
    { itemIndex: 0, line: 1, from: 0, to: 11 },
    { itemIndex: 1, line: 0, from: 0, to: 12 },
    { itemIndex: 2, line: 0, from: 0, to: 10 },
    { itemIndex: 2, line: 1, from: 0, to: 4 },
  ]);
  assert.equal(
    selectedText(s, linesOf),
    "llo world\nsecond line\nanother item\nthird item\nthir",
  );
});

test("multi-item selection: the last line of the FROM item is whole (not dropped)", () => {
  // (0,1,0) → (1,0,5): item0 line1 whole, item1 line0 partial.
  let s = selectStart(base(), anchor(0, 1, 0));
  s = selectUpdate(s, anchor(1, 0, 5))!;
  assert.deepEqual(selectedRanges(s, linesOf), [
    { itemIndex: 0, line: 1, from: 0, to: 11 },
    { itemIndex: 1, line: 0, from: 0, to: 5 },
  ]);
  assert.equal(selectedText(s, linesOf), "second line\nanoth");
});

test("selection clamps to the line's display width (a col past the end)", () => {
  // line "hello world" is 11 wide; a to-col of 99 clamps to 11.
  let s = selectStart(base(), anchor(0, 0, 0));
  s = selectUpdate(s, anchor(0, 0, 99))!;
  assert.deepEqual(selectedRanges(s, linesOf), [
    { itemIndex: 0, line: 0, from: 0, to: 11 },
  ]);
  assert.equal(selectedText(s, linesOf), "hello world");
});

// ── copySelectionText (bound to the real item lines at a width) ─────────────

test("copySelectionText: renders the real item lines and copies the selected cells", () => {
  const st: TuiState = {
    ...makeInitialState("m"),
    items: [
      { kind: "user", text: "fix the bug" },
      { kind: "assistant", text: "done", streaming: false, thinking: false, thinkingText: "" },
    ],
  };
  // The assistant item follows a user item, so a blank line precedes it:
  // item 1's lines are [" ", "◆ done"]. "◆ done" is LINE 1 (◆=1 col, space=1,
  // "done"=4 → 6 wide); "done" occupies display cols 2..6 of that line.
  let s = selectStart(st, anchor(1, 1, 2));
  s = selectUpdate(s, anchor(1, 1, 6))!;
  assert.equal(copySelectionText(s, 80), "done");
});

test("copySelectionText: no selection → empty string", () => {
  const st: TuiState = {
    ...makeInitialState("m"),
    items: [{ kind: "user", text: "fix the bug" }],
  };
  assert.equal(copySelectionText(st, 80), "");
});

test("copySelectionText: a user prompt copies its visible text (icon included)", () => {
  const st: TuiState = {
    ...makeInitialState("m"),
    items: [{ kind: "user", text: "fix the bug" }],
  };
  // The user line renders as "❯ fix the bug". Select the whole line (col 0..end).
  let s = selectStart(st, anchor(0, 0, 0));
  s = selectUpdate(s, anchor(0, 0, 14))!;
  assert.equal(copySelectionText(s, 80), "❯ fix the bug");
});
