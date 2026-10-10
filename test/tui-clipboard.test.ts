/**
 * The TUI's `/copy` clipboard path — unit tests with an INJECTED adapter.
 *
 * `copyToClipboard(text, adapter)` never throws: it returns `{ ok: true }`
 * on success and `{ ok: false, error }` on failure (empty, oversized, or the
 * adapter rejects — no helper, timeout, non-zero exit). The default adapter
 * (pbcopy/xclip, stdin-piped, bounded, timed) is NOT exercised here (it would
 * need a real clipboard); the adapter is the seam. These tests pin the
 * result contract and the payload handed to the adapter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyToClipboard, type ClipboardAdapter } from "../src/tui/clipboard.js";
import { makeCopySelection } from "../src/tui/copy.js";
import {
  inputChar,
  makeInitialState,
  selectStart,
  selectUpdate,
  type SelectionAnchor,
  type TuiState,
} from "../src/tui/state.js";

/** A fake adapter that records the payload and resolves/rejects on demand. */
const fakeAdapter = (
  over: Partial<ClipboardAdapter> = {},
): { adapter: ClipboardAdapter; calls: string[] } => {
  const calls: string[] = [];
  const adapter: ClipboardAdapter = {
    copy(text) {
      calls.push(text);
      return over.copy ? over.copy(text) : Promise.resolve();
    },
  };
  return { adapter, calls };
};

test("success: resolves { ok: true } and hands the exact text to the adapter", async () => {
  const { adapter, calls } = fakeAdapter();
  const res = await copyToClipboard("hello world", adapter);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls, ["hello world"]);
});

test("empty text → { ok: false, error: 'nothing to copy' } (the adapter is NOT called)", async () => {
  const { adapter, calls } = fakeAdapter();
  const res = await copyToClipboard("", adapter);
  assert.deepEqual(res, { ok: false, error: "nothing to copy" });
  assert.deepEqual(calls, []);
});

test("oversized text → { ok: false, error: 'selection too large to copy' } (the adapter is NOT called)", async () => {
  const { adapter, calls } = fakeAdapter();
  // 1,000,001 bytes > MAX_COPY_BYTES (1,000,000).
  const big = "a".repeat(1_000_001);
  const res = await copyToClipboard(big, adapter);
  assert.deepEqual(res, { ok: false, error: "selection too large to copy" });
  assert.deepEqual(calls, []);
});

test("exactly at the byte limit → allowed (the bound is strict >)", async () => {
  const { adapter, calls } = fakeAdapter();
  const exact = "a".repeat(1_000_000);
  const res = await copyToClipboard(exact, adapter);
  assert.deepEqual(res, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.length, 1_000_000);
});

test("adapter rejection (no helper / timeout / non-zero exit) → { ok: false, error }", async () => {
  const { adapter } = fakeAdapter({
    copy: () => Promise.reject(new Error("pbcopy exited 127: command not found")),
  });
  const res = await copyToClipboard("some text", adapter);
  assert.deepEqual(res, { ok: false, error: "pbcopy exited 127: command not found" });
});

test("a non-Error rejection is stringified (never throws)", async () => {
  const { adapter } = fakeAdapter({
    copy: () => Promise.reject("raw string failure"),
  });
  const res = await copyToClipboard("some text", adapter);
  assert.deepEqual(res, { ok: false, error: "raw string failure" });
});

test("multi-line / unicode text is passed through verbatim", async () => {
  const { adapter, calls } = fakeAdapter();
  const text = "line one\nline two\n日本語";
  const res = await copyToClipboard(text, adapter);
  assert.deepEqual(res, { ok: true });
  assert.equal(calls[0], text);
});

// ── the driver's /copy handler (makeCopySelection) — concurrency contract ──
//
// The handler submits/clears the input SYNCHRONOUSLY and defers the clipboard
// I/O; on settlement it must spread the state AS IT IS THEN (read again from
// getState), so a draft typed, a streamed item, or a busy flip that happen
// while the write is in flight all survive the feedback item.

/** A deferred adapter: records the payload, settles on demand. */
function deferredAdapter(rejectWith?: unknown): {
  adapter: ClipboardAdapter;
  calls: string[];
  resolve: () => void;
  reject: () => void;
} {
  let resolveFn: () => void = () => {};
  let rejectFn: () => void = () => {};
  const calls: string[] = [];
  const adapter: ClipboardAdapter = {
    copy(text) {
      calls.push(text);
      return new Promise<void>((res, rej) => {
        resolveFn = res;
        rejectFn = () => rej(rejectWith ?? new Error("copy failed: simulated"));
      });
    },
  };
  return { adapter, calls, resolve: () => resolveFn(), reject: () => rejectFn() };
}

/** A state with a single assistant item and an active selection over it. */
function stateWithSelection(): { state: TuiState; anchor: SelectionAnchor } {
  const base = makeInitialState("test-model");
  const withItem: TuiState = {
    ...base,
    items: [{ kind: "assistant", text: "hello world", streaming: false, thinking: false, thinkingText: "" }],
  };
  // The rendered line is "◆ hello world" (the assistant icon prefix):
  // cols 2..7 select exactly "hello" (5 bytes).
  const anchor: SelectionAnchor = { itemIndex: 0, line: 0, col: 2 };
  const state = selectUpdate(selectStart(withItem, anchor), { itemIndex: 0, line: 0, col: 7 });
  assert.ok(state !== null);
  return { state, anchor };
}

test("/copy success: feedback lands on the CURRENT items (draft, streamed item, busy all preserved)", async () => {
  const { state: s0 } = stateWithSelection();
  const { adapter, calls, resolve } = deferredAdapter();
  let state = s0;
  const handler = makeCopySelection({
    getState: () => state,
    setStateNow: (s) => { state = s; },
    clipboardAdapter: adapter,
    isMounted: () => true,
    width: () => 80,
  });
  handler();
  // Synchronous part: the input is cleared and "/copy" lands in history.
  assert.equal(state.input, "");
  assert.deepEqual(state.history, ["/copy"]);
  assert.equal(calls.length, 1); // the deferred write is in flight
  // Concurrent mutations while the clipboard write is pending:
  state = inputChar(state, "d"); // draft typed
  state = { ...state, items: [...state.items, { kind: "assistant", text: "streamed", streaming: true, thinking: false, thinkingText: "" }] };
  state = { ...state, busy: true };
  resolve();
  await Promise.resolve(); await Promise.resolve(); // let the .then settle
  const last = state.items[state.items.length - 1];
  assert.equal(last?.kind, "info");
  assert.equal(last?.text, "copied 5 byte(s) to the clipboard");
  assert.equal(state.input, "d"); // the draft survives
  assert.equal(state.busy, true); // the busy flip survives
  assert.equal(state.items.length, 3); // item + streamed + feedback
  assert.equal(state.items[1]?.kind, "assistant");
  assert.equal((state.items[1] as { text: string }).text, "streamed");
});

test("/copy rejected adapter: the 'copy failed: …' variant lands the same way (current state preserved)", async () => {
  const { state: s0 } = stateWithSelection();
  const { adapter, reject } = deferredAdapter(new Error("pbcopy exited 127: command not found"));
  let state = s0;
  const handler = makeCopySelection({
    getState: () => state,
    setStateNow: (s) => { state = s; },
    clipboardAdapter: adapter,
    isMounted: () => true,
    width: () => 80,
  });
  handler();
  state = inputChar(state, "x"); // concurrent draft
  reject();
  await Promise.resolve(); await Promise.resolve();
  const last = state.items[state.items.length - 1];
  assert.equal(last?.kind, "info");
  assert.equal(last?.text, "copy failed: pbcopy exited 127: command not found");
  assert.equal(state.input, "x"); // concurrent draft preserved
  assert.equal(state.items.length, 2); // item + feedback
});

test("/copy with an empty selection: the info item lands and the adapter is NEVER called", async () => {
  const base = makeInitialState("test-model");
  const withItem: TuiState = {
    ...base,
    items: [{ kind: "assistant", text: "hello world", streaming: false, thinking: false, thinkingText: "" }],
  };
  const { adapter, calls } = deferredAdapter();
  let state = withItem; // no selection at all
  const handler = makeCopySelection({
    getState: () => state,
    setStateNow: (s) => { state = s; },
    clipboardAdapter: adapter,
    isMounted: () => true,
    width: () => 80,
  });
  handler();
  assert.equal(state.input, "");
  assert.deepEqual(state.history, ["/copy"]);
  const last = state.items[state.items.length - 1];
  assert.equal(last?.kind, "info");
  assert.equal(last?.text, "copy: nothing selected (drag in the output area with the mouse)");
  assert.equal(calls.length, 0); // the adapter is never invoked
});
