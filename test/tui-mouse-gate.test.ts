/**
 * The driver's mouse-selection GATE (makeMouseGate, mouse-gate.ts) — the
 * press→drag→release→subsequent-motion sequence, testable without the Ink
 * app: a press starts the selection AND opens the gate; a motion is applied
 * only while the gate is open; a release closes the gate (the selection
 * STAYS — the user may /copy it); a motion after the release is a no-op
 * (no setStateNow call at all); a motion before any press is ignored.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMouseGate } from "../src/tui/mouse-gate.js";
import {
  makeInitialState,
  selectStart,
  selectUpdate,
  type SelectionAnchor,
  type TuiState,
} from "../src/tui/state.js";

/** A state with a single assistant item (the selection target). */
function stateWithItem(): TuiState {
  return {
    ...makeInitialState("test-model"),
    items: [{ kind: "assistant", text: "hello world", streaming: false, thinking: false, thinkingText: "" }],
  };
}

const A: SelectionAnchor = { itemIndex: 0, line: 0, col: 0 };
const B: SelectionAnchor = { itemIndex: 0, line: 0, col: 5 };
const C: SelectionAnchor = { itemIndex: 0, line: 0, col: 10 };

test("press → drag → release → subsequent motion: the post-release motion is a no-op", () => {
  let state = stateWithItem();
  const writes: TuiState[] = [];
  const gate = makeMouseGate({
    getState: () => state,
    setStateNow: (s) => { state = s; writes.push(s); },
  });
  // press: selectStart applied, gate opens
  gate.onSelectStart(A);
  assert.deepEqual(state.selection, { from: A, to: A, anchor: A });
  assert.equal(writes.length, 1);
  // drag: selectUpdate applied (the endpoint moves)
  gate.onSelectUpdate(B);
  assert.ok(state.selection !== null);
  assert.deepEqual(state.selection.to, B);
  assert.equal(writes.length, 2);
  // release: the gate closes, the selection STAYS
  gate.onSelectEnd();
  assert.ok(state.selection !== null);
  assert.equal(writes.length, 2); // onSelectEnd never writes state
  // subsequent motion: NO state change — the handler must not call setStateNow
  const before = state;
  gate.onSelectUpdate(C);
  assert.equal(state, before); // same reference — no write happened
  assert.equal(writes.length, 2);
});

test("a motion BEFORE any press is ignored (no selection, no write)", () => {
  let state = stateWithItem();
  const writes: TuiState[] = [];
  const gate = makeMouseGate({
    getState: () => state,
    setStateNow: (s) => { state = s; writes.push(s); },
  });
  const before = state;
  gate.onSelectUpdate(B);
  assert.equal(state, before); // same reference — the gate was closed
  assert.equal(state.selection, null);
  assert.equal(writes.length, 0);
});

test("a second press after a release re-opens the gate (drag applies again)", () => {
  let state = stateWithItem();
  const gate = makeMouseGate({
    getState: () => state,
    setStateNow: (s) => { state = s; },
  });
  gate.onSelectStart(A);
  gate.onSelectUpdate(B);
  gate.onSelectEnd();
  gate.onSelectStart(C); // a fresh press replaces the selection
  assert.deepEqual(state.selection, { from: C, to: C, anchor: C });
  gate.onSelectUpdate(A); // the gate is open again
  assert.ok(state.selection !== null);
  assert.deepEqual(state.selection.from, A); // order-normalized
  assert.deepEqual(state.selection.to, C);
});

test("selectClear drops the selection (the gate is independent of it)", () => {
  let state = stateWithItem();
  const gate = makeMouseGate({
    getState: () => state,
    setStateNow: (s) => { state = s; },
  });
  gate.onSelectStart(A);
  gate.onSelectUpdate(B);
  gate.onSelectClear();
  assert.equal(state.selection, null);
  // the gate is still open (a release never came) — a further motion
  // applies to the (now null) selection: selectUpdate returns null, no write.
  const before = state;
  gate.onSelectUpdate(C);
  assert.equal(state, before);
});
