/**
 * Styling/copy agreement (audit recommendation): the cells the App
 * HIGHLIGHTS (SEL_BG #5f5f5f, a grapheme highlighted whole when it
 * intersects any selected display cell — highlightLine/splitRangeAtCols in
 * app.tsx) must be EXACTLY the cells /copy COPIES (copySelectionText —
 * the same grapheme-intersection rule over the same itemLines). Each test
 * asserts BOTH sides: the rendered frame carries the 256-color bg escape
 * (ESC[48;2;95;95;95m) around exactly the expected substring (and no other
 * span carries it), and copySelectionText(state, 100) equals it.
 *
 * chalk (via ink) computes its color level ONCE at import time from
 * FORCE_COLOR — so this file sets FORCE_COLOR=3 BEFORE importing ink
 * (top-level await). The in-test env pattern of tui-app.test.tsx works
 * only for text-presence assertions, never for ANSI escapes (node --test
 * runs each file in its own process, so the env var is local to this file).
 * Fake stdout is 100×24 (ink-testing-library), hence width 100.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TuiState } from "../src/tui/state.js";

process.env.FORCE_COLOR = "3";
const React = (await import("react")).default;
const { render } = await import("ink-testing-library");
const { App } = await import("../src/tui/app.js");
const { makeInitialState, copySelectionText } = await import("../src/tui/state.js");

const SEL_BG = "\u001b[48;2;95;95;95m";
const selState = (text: string, from: number, to: number): TuiState => ({
  ...makeInitialState("m"),
  items: [{ kind: "user", text }],
  selection: { from: { itemIndex: 0, line: 0, col: from }, to: { itemIndex: 0, line: 0, col: to }, anchor: { itemIndex: 0, line: 0, col: from } },
});
/** Render the one user item with the selection (100×24 fake stdout). */
const selFrame = (text: string, from: number, to: number): string => {
  const app = render(
    React.createElement(App, {
      state: selState(text, from, to),
      mouseEnabled: true,
      onChar: () => {}, onBackspace: () => {}, onScrollBy: () => {}, onScrollToTop: () => {},
      onScrollToBottom: () => {}, onMove: () => {}, onHistory: () => {}, onSubmit: () => {},
      onCtrlC: () => {}, onApproval: () => {}, onQuit: () => {}, onModelPickerNav: () => {},
      onModelPickerConfirm: () => {}, onModelPickerClose: () => {},
      onBottomFieldsNav: () => {}, onBottomFieldsToggle: () => {}, onBottomFieldsConfirm: () => {},
      onBottomFieldsClose: () => {}, onSelectStart: () => {},
      onSelectUpdate: () => {}, onSelectEnd: () => {}, onSelectClear: () => {},
    }),
  );
  try {
    return app.lastFrame()!;
  } finally {
    app.unmount();
  }
};
/** Assert the frame highlights EXACTLY `expected` (the bg escape wraps that
 * exact substring, no other span carries it) and copySelectionText agrees. */
const assertAgreement = (text: string, from: number, to: number, expected: string): void => {
  const frame = selFrame(text, from, to);
  const bgSpans = frame.match(new RegExp(SEL_BG.replace("[", "\\["), "g")) ?? [];
  assert.equal(bgSpans.length, 1, "exactly one highlighted span in the frame: " + JSON.stringify(frame));
  const m = new RegExp(SEL_BG.replace("[", "\\[") + "([^\\u001b]*)").exec(frame);
  assert.ok(m !== null, "frame must carry the 256-color bg escape: " + JSON.stringify(frame));
  assert.equal(m![1], expected, "the highlighted span must be exactly the expected substring");
  assert.equal(copySelectionText(selState(text, from, to), 100), expected, "copySelectionText must equal the highlighted substring");
};

test("styling/copy agreement: ordinary text (cols 2..7 of '❯ hello world')", () => {
  // ❯ gutter = cols 0..1; [2,7) = "hello" — the unselected " world" must
  // carry no bg escape (the single-span check above pins that).
  assertAgreement("hello world", 2, 7, "hello");
});

test("styling/copy agreement: combining cluster — selection ending BEFORE the cluster", () => {
  // "❯ cafe<U+0301>": the cluster (e + combining acute) sits at col 5.
  // [2,5) ends right before it → "caf" (the cluster is NOT copied).
  assertAgreement("cafe\u0301", 2, 5, "caf");
});

test("styling/copy agreement: combining cluster — selection ending AFTER the cluster", () => {
  // [2,6) ends right after it → the WHOLE cluster is highlighted+copied
  // (grapheme-intersection rule: any intersecting cell takes the grapheme).
  // itemLines NFC-normalizes the decomposed input, so the rendered+copied
  // cluster is the precomposed "é" (e9) — asserting it distinguishes the
  // whole cluster from an e-only copy ("cafe").
  assertAgreement("cafe\u0301", 2, 6, "caf\u00e9");
});

test("styling/copy agreement: wide CJK grapheme — start in the FIRST cell", () => {
  // "❯ 中文ab": 中 = cols 2-3, 文 = cols 4-5. [2,4) starts in 中's first
  // cell and ends in its second → the whole 中 (文 untouched).
  assertAgreement("\u4e2d\u6587ab", 2, 4, "\u4e2d");
});

test("styling/copy agreement: wide CJK grapheme — start in the SECOND cell", () => {
  // [3,4) starts in 中's SECOND cell → the whole 中 is still taken
  // (a 2-cell grapheme can't be split; 文 at col 4 is untouched).
  assertAgreement("\u4e2d\u6587ab", 3, 4, "\u4e2d");
});

test("styling/copy agreement: wide emoji (ZWJ) grapheme — start in the FIRST cell", () => {
  // "❯ A👩‍💻B": A = col 2, the 2-cell ZWJ emoji = cols 3-4, B = col 5.
  // [3,4) starts in the emoji's first cell → the whole emoji.
  assertAgreement("A\ud83d\udc69\u200d\ud83d\udcbbB", 3, 4, "\ud83d\udc69\u200d\ud83d\udcbb");
});

test("styling/copy agreement: wide emoji (ZWJ) grapheme — start in the SECOND cell", () => {
  // [4,5) starts in the emoji's second cell → the whole emoji (B untouched).
  assertAgreement("A\ud83d\udc69\u200d\ud83d\udcbbB", 4, 5, "\ud83d\udc69\u200d\ud83d\udcbb");
});
