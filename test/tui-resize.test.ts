/**
 * The driver's terminal-resize handler (makeResizeHandler, resize.ts) —
 * unit tests with a FAKE EventEmitter stream. A resize clears an active
 * selection (the anchors are content coordinates — a reflow changes the
 * rendered lines); after detach, firing "resize" does nothing; with no
 * selection, firing is a no-op (the SAME state reference, no re-render).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeResizeHandler, type ResizeStream } from "../src/tui/resize.js";
import {
  makeInitialState,
  selectStart,
  selectUpdate,
  type TuiState,
} from "../src/tui/state.js";

/** A minimal fake of process.stdout's "resize" event surface. */
function fakeStream(): { stream: ResizeStream; fire: () => void } {
  let handler: (() => void) | null = null;
  const stream: ResizeStream = {
    on(event, h) {
      assert.equal(event, "resize");
      handler = h as () => void;
      return null;
    },
    off(event, h) {
      assert.equal(event, "resize");
      if (handler === (h as () => void)) handler = null;
      return null;
    },
  };
  return { stream, fire: () => handler?.() };
}

/** A state with an active selection over a single assistant item. */
function stateWithSelection(): TuiState {
  const base: TuiState = {
    ...makeInitialState("test-model"),
    items: [{ kind: "assistant", text: "hello world", streaming: false, thinking: false, thinkingText: "" }],
  };
  const started = selectStart(base, { itemIndex: 0, line: 0, col: 0 });
  const updated = selectUpdate(started, { itemIndex: 0, line: 0, col: 5 });
  assert.ok(updated !== null);
  return updated;
}

test("resize with an active selection: the selection is cleared", () => {
  const { stream, fire } = fakeStream();
  let state = stateWithSelection();
  const { attach, detach } = makeResizeHandler({
    stream,
    getState: () => state,
    setStateNow: (s) => { state = s; },
  });
  attach();
  fire();
  assert.equal(state.selection, null);
  // the item survives (only the selection is dropped)
  assert.equal(state.items.length, 1);
  detach();
});

test("after detach, firing resize does nothing (selection survives)", () => {
  const { stream, fire } = fakeStream();
  let state = stateWithSelection();
  const { attach, detach } = makeResizeHandler({
    stream,
    getState: () => state,
    setStateNow: (s) => { state = s; },
  });
  attach();
  detach();
  fire();
  assert.ok(state.selection !== null); // untouched
});

test("resize with no selection: no-op — the SAME state reference (no re-render)", () => {
  const { stream, fire } = fakeStream();
  let state = makeInitialState("test-model");
  let writes = 0;
  const { attach } = makeResizeHandler({
    stream,
    getState: () => state,
    setStateNow: (s) => { state = s; writes += 1; },
  });
  const before = state;
  attach();
  fire();
  assert.equal(writes, 0); // setStateNow was never called
  assert.equal(state, before); // same reference — no re-render
  assert.equal(state.selection, null);
});
