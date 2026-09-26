/**
 * D14 — pinned input layout (WS-1b tests).
 *
 * The pure geometry functions in state.ts must stay in lockstep with the Item
 * rendering in app.tsx; the App render tests pin the frame shape on
 * ink-testing-library's fake stdout (columns getter = 100, NO rows property →
 * effective 100×24). Frame contract: exactly `rows` lines — header on top,
 * hint / ─ separator / input line (plain, no prefix, ▍ cursor rendered at
 * its location) / ─ separator / 3 bottom-display lines (D15: /display-bottom)
 * pinned
 * at the bottom (input row exactly 4 lines above the screen bottom).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/tui/app.js";
import {
  RESERVED_BOTTOM_LINES,
  PINNED_LINES,
  FIXED_NON_ITEM_LINES,
  applyEvent,
  wrapLineCount,
  itemHeight,
  itemsHeight,
  fitItems,
  fitItemsScrollable,
  scrollBy,
  scrollToBottom,
  itemAreaBudget,
  inputWrap,
  inputWrapLineCount,
  inputMove,
  approvalLine,
  bottomLines,
  handleSlashCommand,
  slashCandidates,
  suggestMenu,
  menuNav,
  menuComplete,
  MENU_MAX_LINES,
  SLASH_COMMANDS,
  makeInitialState,
  setApproval,
} from "../src/tui/state.js";
import { itemLines } from "../src/tui/lines.js";
import type { TuiItem, TuiState } from "../src/tui/state.js";

/**
 * Strip ANSI exactly like e2e scenario_14 (CSI sequences + charset selection).
 * lastFrame() is the RAW frame Ink wrote; chalk color support depends on how
 * npm test's stdout looks, so geometry asserts must run on stripped text.
 */
const stripAnsi = (s: string): string =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b[()][0-9A-B]/g, "");

/**
 * lastFrame() → exactly H lines. The frame string ends with a terminating
 * newline (strip one), and Ink TRIMS trailing whitespace per line — pad/reserved
 * lines arrive as "", not " " — so pad the tail with "" up to H. Do NOT strip
 * \n+: the 3 reserved lines ARE trailing blank lines.
 */
const frameLines = (frame: string | undefined): string[] => {
  const lines = stripAnsi(frame ?? "").replace(/\n$/, "").split("\n");
  while (lines.length < H) lines.push("");
  return lines;
};

const lineAt = (lines: string[], i: number): string => {
  const l = lines[i];
  if (l === undefined) throw new Error(`expected ≥ ${i + 1} frame lines, got ${lines.length}`);
  return l;
};

/** Static state for render tests: idle turn-1 with the given items. */
const mkState = (items: TuiItem[], over: Partial<TuiState> = {}): TuiState => ({
  ...makeInitialState("test-model"),
  items,
  busy: false,
  turn: 1,
  approval: null,
  ...over,
});

const renderApp = (state: TuiState) =>
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
    }),
  );

// ── constants ──────────────────────────────────────────────────────────

test("layout constants pin the bottom block", () => {
  assert.equal(RESERVED_BOTTOM_LINES, 3);
  // top separator + input line(1, MINIMUM — the input wraps at the terminal
  // width; the extra wrapped lines are added by the fitItems caller) +
  // bottom separator + reserved lines.
  // pinned block = top separator(1) + input line(1) + bottom separator(1) + reserved(3) = 6.
  assert.equal(PINNED_LINES, 3 + RESERVED_BOTTOM_LINES);
  // header (1) + hint (1) + pinned block
  assert.equal(FIXED_NON_ITEM_LINES, 2 + PINNED_LINES);
});

// ── wrapLineCount ──────────────────────────────────────────────────────

test("wrapLineCount mirrors Ink's {trim:false, hard:true} wrapping", () => {
  assert.equal(wrapLineCount("", 80), 0); // empty → no line
  assert.equal(wrapLineCount("hi", 80), 1);
  // 100 chars incl. trailing space (trim:false keeps it) → exactly 2 lines
  assert.equal(wrapLineCount("word ".repeat(20), 80), 2);
  // hard wrap: 80 + 80 + 40 → 3 lines
  assert.equal(wrapLineCount("x".repeat(200), 80), 3);
});

// ── itemHeight / itemsHeight ───────────────────────────────────────────

test("itemHeight per kind at width 80", () => {
  // user: plain text at full width (D15 removed the 'you ' prefix)
  const userLong: TuiItem = { kind: "user", text: "x".repeat(200) };
  assert.equal(itemHeight(userLong, 80), 3); // 80 + 80 + 40

  const userEmpty: TuiItem = { kind: "user", text: "" };
  assert.equal(itemHeight(userEmpty, 80), 1);

  // assistant: 200×'x' alone → 3 (80+80+40)
  const asstPlain: TuiItem = {
    kind: "assistant",
    text: "x".repeat(200),
    streaming: false,
    thinking: false,
    thinkingText: "",
  };
  assert.equal(itemHeight(asstPlain, 80), 3);
  // NOTE (see farm report): the spec bullet reads "thinking + 200×'x' → 3"
  // but the lockstep formula is additive — encode the FORMULA so drift
  // fails loudly. The reasoning renders as a distinct block (lines.ts): a
  // dim header, the reasoning under a "│ " gutter wrapped at width−2, and a
  // blank line before the reply — the height counts all of it.
  const asstThink: TuiItem = { ...asstPlain, thinking: true, thinkingText: "hmm" };
  assert.equal(itemHeight(asstThink, 80), 1 + 1 + 1 + itemHeight(asstPlain, 80)); // header + "hmm" + blank + 3
  // A bare `thinking` flag with NO accumulated text renders nothing extra.
  const asstFlagOnly: TuiItem = { ...asstPlain, thinking: true };
  assert.equal(itemHeight(asstFlagOnly, 80), itemHeight(asstPlain, 80));

  // tool (running): '→ bash a…a' (7 prefix cols + 100 args) hard-wraps to 2
  const toolRun: TuiItem = {
    kind: "tool",
    id: "t1",
    name: "bash",
    argsText: "a".repeat(100),
    running: true,
  };
  assert.equal(itemHeight(toolRun, 80), 2);

  // D19: hidden (quiet file-access mid-flight) counts as zero lines, but a
  // denied (unhidden) read renders mark + result
  const toolHidden: TuiItem = { kind: "tool", id: "t-h", name: "read", argsText: '{ path: "a.txt" }', running: true, hidden: true };
  assert.equal(itemHeight(toolHidden, 80), 0);
  const toolDenied: TuiItem = { kind: "tool", id: "t-d", name: "read", argsText: '{ path: "/etc/passwd" }', running: false, resultText: "denied: outside the workspace", isError: true, hidden: false };
  assert.equal(itemHeight(toolDenied, 80), 1 + 1);

  // tool (done): mark line + each non-empty diff line + result line
  const toolDone: TuiItem = {
    kind: "tool",
    id: "t2",
    name: "edit",
    argsText: '{ path: "a.txt" }',
    running: false,
    resultText: "edited",
    isError: false,
    diff: Array.from({ length: 10 }, (_, i) => `- l${i}`),
  };
  assert.equal(itemHeight(toolDone, 80), 1 + 10 + 1);

  // compaction / error: single line at width 80 (C31: the text hangs under
  // a 2-col icon, wrapped at width−2 — 70 chars = 1 line at 78)
  const compact: TuiItem = { kind: "compaction", tokensBefore: 4096, messagesKept: 2, summaryChars: 123 };
  assert.equal(itemHeight(compact, 80), 1);

  const err: TuiItem = { kind: "error", text: "boom" };
  assert.equal(itemHeight(err, 80), 1);

  // C31: the leading blank line — before a non-user item that follows a
  // user item, before every user item that is not first, and NOT between
  // other pairs (e.g. an error after a reply). Hidden tools render nothing,
  // separator included.
  const u: TuiItem = { kind: "user", text: "q" };
  const a: TuiItem = { kind: "assistant", text: "r", streaming: false, thinking: false, thinkingText: "" };
  const e: TuiItem = { kind: "error", text: "boom" };
  assert.equal(itemHeight(u, 80), 1, "first item: no separator");
  assert.equal(itemHeight(a, 80, u), 2, "reply after a prompt: blank + 1");
  assert.equal(itemHeight(u, 80, a), 2, "a new prompt: blank + 1");
  assert.equal(itemHeight(e, 80, u), 2, "error after a prompt: blank + 1");
  assert.equal(itemHeight(e, 80, a), 1, "error after a reply: no separator");
  assert.equal(itemHeight(a, 80, u), 2, "assistant after a prompt: blank + 1");
  const hidden: TuiItem = { kind: "tool", id: "h", name: "read", argsText: "{}", running: true, hidden: true };
  assert.equal(itemHeight(hidden, 80, u), 0, "hidden tool: no lines, no separator");
});

test("itemsHeight is the sum of itemHeights (C31: separators count)", () => {
  const a: TuiItem = { kind: "user", text: "hello" }; // 1 at w80
  const b: TuiItem = { kind: "assistant", text: "x".repeat(200), streaming: false, thinking: false, thinkingText: "" }; // 3 at w80 (78-wide hang)
  const c: TuiItem = { kind: "error", text: "boom" }; // 1 at w80
  // C31: b follows a user → +1 blank; c (error) follows an assistant → no
  // blank.
  assert.equal(itemsHeight([a, b, c], 80), itemHeight(a, 80) + itemHeight(b, 80, a) + itemHeight(c, 80, b));
  assert.equal(itemsHeight([a, b, c], 80), 6);
});

// ── fitItems ───────────────────────────────────────────────────────────

test("fitItems keeps the longest tail that fits and pads the rest (rows=24)", () => {
  const oneLiners: TuiItem[] = [
    { kind: "user", text: "q0" },
    { kind: "assistant", text: "a1", streaming: false, thinking: false, thinkingText: "" },
    { kind: "user", text: "q2" },
  ];
  // C31: a1 follows a user (+1 blank), q2 follows an assistant (+1 blank)
  // → heights 1 + 2 + 2 = 5 (the fit counts each item WITH its separator).

  // D16: the 4th arg is extraLines (approval + menu); 0 → budget 16
  const r1 = fitItems(oneLiners, 80, 24, 0);
  assert.equal(r1.visible.length, 3);
  assert.equal(itemsHeight(r1.visible, 80), 5); // 1 + 2 + 2 (C31 separators)
  assert.equal(r1.pad, 24 - FIXED_NON_ITEM_LINES - 5); // 11

  // a pending approval steals exactly one line of budget → pad shrinks by 1
  const r2 = fitItems(oneLiners, 80, 24, 1);
  assert.equal(r2.visible.length, 3);
  assert.equal(r2.pad, 24 - FIXED_NON_ITEM_LINES - 1 - 5); // 10

  // a 3-line completion menu steals exactly 3 lines of budget
  const r5 = fitItems(oneLiners, 80, 24, 3);
  assert.equal(r5.visible.length, 3);
  assert.equal(r5.pad, 24 - FIXED_NON_ITEM_LINES - 3 - 5); // 8

  // 30 items × exactly 5 lines (360 = 4×78+48 — the C31 2-col icon hang
  // wraps at width−2) → longest tail is the last 3 (assistants after
  // assistants add no separator, so the per-item height is unchanged)
  const big: TuiItem[] = Array.from({ length: 30 }, () => ({
    kind: "assistant" as const,
    text: "y".repeat(360),
    streaming: false,
    thinking: false,
    thinkingText: "",
  }));
  assert.equal(itemHeight(big[29] as TuiItem, 80, big[28]), 5); // sanity: exactly 5 lines each
  const r3 = fitItems(big, 80, 24, 0);
  assert.equal(r3.visible.length, 3); // floor(16/5) = 3 (15 ≤ 16 < 20)
  assert.ok(itemsHeight(r3.visible, 80) <= 16);
  assert.ok(r3.pad >= 0);
  assert.equal(r3.pad, 16 - itemsHeight(r3.visible, 80)); // 1
  for (let k = 0; k < r3.visible.length; k++) {
    // visible is the TAIL of `big`, same order — never reordered
    assert.equal(r3.visible[k], big[big.length - r3.visible.length + k]);
  }
  assert.equal(r3.visible[r3.visible.length - 1], big[29] as TuiItem); // newest last

  // a single item that alone exceeds the budget → keep just it, pad = 0
  // (4000 chars at the 78-wide hang = 52 lines)
  const monster: TuiItem = { kind: "assistant", text: "z".repeat(4000), streaming: false, thinking: false, thinkingText: "" };
  assert.equal(itemHeight(monster, 80, undefined), 52); // sanity: exactly 52 lines (51×78+22)
  const r4 = fitItems([monster], 80, 24, 0);
  assert.equal(r4.visible.length, 1);
  assert.equal(r4.visible[0], monster);
  assert.equal(r4.pad, 0);
});

// ── inputWrap / approvalLine ───────────────────────────────────────────

test("inputWrap: word-wraps at width, cursor at its LOCATION, every line ≤ width", () => {
  // empty input → the cursor alone (one line, never blank)
  assert.deepEqual(inputWrap("", 0, 80), ["\u258d"]);

  // short input, cursor at the end → one line, passes through + the cursor
  assert.deepEqual(inputWrap("hello", 5, 80), ["hello\u258d"]);

  // cursor in the MIDDLE → the ▍ is at that position, not the end
  assert.deepEqual(inputWrap("hello", 2, 80), ["he\u258dllo"]);
  assert.deepEqual(inputWrap("hello", 0, 80), ["\u258dhello"]); // at the start

  // long input (no spaces) hard-breaks at the column limit: 300×'x' →
  // 80 + 80 + 80 + (60 + cursor), the cursor at the end of the last line
  const long = inputWrap("x".repeat(300), 300, 80);
  assert.deepEqual(long, ["x".repeat(80), "x".repeat(80), "x".repeat(80), "x".repeat(60) + "\u258d"]);
  for (const l of long) assert.ok(wrapLineCount(l, 80) <= 1);

  // word-aware: an overflowing line breaks at the LAST space inside it —
  // the space is consumed (never repeated), a line never starts with a space.
  // cursorPos 20 = right after the space before "eeee" → the cursor leads
  // the last line.
  const words = inputWrap("aaaa bbbb cccc dddd eeee", 20, 10);
  assert.deepEqual(words, ["aaaa bbbb", "cccc dddd", "\u258deeee"]);

  // the cursor rides along at its position across the wrapped lines
  // (cursorPos 9 = after the space following "cc")
  const mid = inputWrap("aa bb cc dd ee ff", 9, 7);
  assert.deepEqual(mid, ["aa bb", "cc \u258ddd", "ee ff"]);

  // a space that would start a new line is dropped
  const leadSpace = inputWrap("aaaaa bbbbb", 10, 6);
  assert.deepEqual(leadSpace, ["aaaaa", "bbbb\u258db"]);

  // wide (CJK) chars count as 2 display columns (8 chars = 16 cols; the
  // cursor at pos 8 = the END of the string clamps to the end)
  const wide = inputWrap("漢字漢字漢字漢字", 8, 10);
  assert.deepEqual(wide, ["漢字漢字漢", "字漢字\u258d"]);
  assert.equal(inputWrapLineCount("漢字漢字漢字漢字", 8, 10), 2);

  // inputWrapLineCount: 1 for empty/short, more when wrapped (feeds the
  // fitItems budget so the frame stays exactly `rows` tall)
  assert.equal(inputWrapLineCount("", 0, 80), 1);
  assert.equal(inputWrapLineCount("hello", 5, 80), 1);
  assert.equal(inputWrapLineCount("x".repeat(300), 300, 80), 4);
});

test("inputWrap: no trailing space at a wrap point, no leading space on a wrapped line", () => {
  // The fuzz bug: the break lands on the LAST space, but an earlier space of
  // the same run would otherwise TRAIL the line ("aaa "). Trim at the wrap
  // point — the last line is never trimmed.
  const dbl = inputWrap("aaa  bbb", 8, 8);
  assert.deepEqual(dbl, ["aaa", "bbb\u258d"]);
  assert.ok(!dbl[0]!.endsWith(" "));

  // cursor inside the space run: the wrap trims the trailing space, the
  // cursor keeps its position (after the first space).
  assert.deepEqual(inputWrap("aaa  bbb", 4, 8), ["aaa \u258d", "bbb"]);

  // a leading space of the input is kept on line 0 only (it mirrors the
  // input), and is NOT repeated as a leading space on a wrapped line.
  const lead = inputWrap(" aaa bbb", 8, 8);
  assert.deepEqual(lead, [" aaa", "bbb\u258d"]);
  assert.equal(lead[0], " aaa"); // line 0 may start with a space
  assert.ok(!lead[1]!.startsWith(" ")); // line 1 must not

  // cursor at the very start, leading space present
  assert.deepEqual(inputWrap(" aaa bbb", 0, 8), ["\u258d aaa", "bbb"]);

  // hard-break (no space) still trims a trailing space that would otherwise
  // sit at the column limit; the cursor rides along.
  assert.deepEqual(inputWrap("aaaaaa b", 8, 8), ["aaaaaa", "b\u258d"]);
  assert.deepEqual(inputWrap("aaaaaa b", 7, 8), ["aaaaaa", "\u258db"]);

  // the plain single-space case the fuzz named: at w=8 "aaa bbb" fits on one
  // line (cursor included); at w=7 it wraps cleanly with no trailing space.
  assert.deepEqual(inputWrap("aaa bbb", 7, 8), ["aaa bbb\u258d"]);
  assert.deepEqual(inputWrap("aaa bbb", 4, 8), ["aaa \u258dbbb"]);

  // a SPACE RUN after the break point must not leak extra spaces onto the
  // start of the next line (only line 0 may start with a space).
  const run = inputWrap("a   b   c", 8, 6);
  assert.deepEqual(run, ["a   b", "\u258dc"]);
  assert.ok(!run[1]!.startsWith(" "));

  // invariant sweep: no non-last line ends with a space, no wrapped line
  // starts with a space, every line ≤ width (checked by the fuzzer too).
  const sweep: [string, number, number][] = [
    ["aaa  bbb", 8, 8], [" aaa bbb", 8, 8], ["aaaaaa b", 8, 8],
    ["aa bb cc dd ee ff", 9, 7], ["a   b   c", 8, 6],
  ];
  for (const [s, p, w] of sweep) {
    const lines = inputWrap(s, p, w);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (i < lines.length - 1) assert.ok(!line.endsWith(" "), `line ${i} of ${JSON.stringify(s)} trailing space`);
      if (i > 0) assert.ok(!line.startsWith(" "), `line ${i} of ${JSON.stringify(s)} leading space`);
      assert.ok(wrapLineCount(line, w) <= 1, `line ${i} of ${JSON.stringify(s)} over width`);
    }
  }
});

test("inputMove: moves the cursor left/right, no-op at the ends", () => {
  const s0 = { ...makeInitialState("m"), input: "hello", cursorPos: 5 };
  // left from the end → 4, right back → 5
  assert.equal(inputMove(s0, -1).cursorPos, 4);
  assert.equal(inputMove(inputMove(s0, -1), 1).cursorPos, 5);
  // no-op at the left end
  const atStart = { ...s0, cursorPos: 0 };
  assert.equal(inputMove(atStart, -1).cursorPos, 0);
  // no-op at the right end
  assert.equal(inputMove(s0, 1).cursorPos, 5);
  // a stale (overrun) index is clamped before moving
  const stale = { ...s0, cursorPos: 99 };
  assert.equal(inputMove(stale, -1).cursorPos, 4);
  // empty input: cursor stays 0
  const empty = makeInitialState("m");
  assert.equal(inputMove(empty, -1).cursorPos, 0);
  assert.equal(inputMove(empty, 1).cursorPos, 0);
  // locked while an approval is pending
  const appr = setApproval({ ...s0, cursorPos: 5 }, "q?", () => {});
  assert.equal(inputMove(appr, -1), appr);
});

// ── D15: bottom display ────────────────────────────────────────────────

test("bottomLines: values, order, truncation, unknown keys, padding", () => {
  const base = makeInitialState("m", { cwd: "/w", session: "s.jsonl" });

  // nothing selected → all three lines empty
  assert.deepEqual(bottomLines(base, 80), ["", "", ""]);

  // selected fields, in order, with live values
  const s = { ...base, bottom: ["model", "status", "turn"], busy: true, turn: 4 };
  assert.deepEqual(bottomLines(s, 80), [
    "model: m",
    "status: working…",
    "turn: 4",
  ]);

  // tokens: cumulative totalTokens vs the empty marker
  assert.equal(bottomLines({ ...base, bottom: ["tokens"], totalTokens: 0 }, 80)[0], "tokens: —");
  assert.equal(bottomLines({ ...base, bottom: ["tokens"], totalTokens: 1234 }, 80)[0], "tokens: 1234 total");

  // context: used/window with % of the window (makeInitialState defaults:
  // no window, no usage yet)
  assert.equal(bottomLines({ ...base, bottom: ["context"] }, 80)[0], "context: —");
  assert.equal(
    bottomLines({ ...base, bottom: ["context"], contextWindow: 131072 }, 80)[0],
    "context: 131.1k window (no usage yet)",
  );
  assert.equal(
    bottomLines({ ...base, bottom: ["context"], contextWindow: 81920, contextTokens: 25341 }, 80)[0],
    "context: 25.3k/81.9k (31%)",
  );
  // unknown window but known usage → no %
  assert.equal(
    bottomLines({ ...base, bottom: ["context"], contextTokens: 45234 }, 80)[0],
    "context: 45.2k/—",
  );
  // compaction drop: 120k → 9.6k reads as a visible reset
  assert.equal(
    bottomLines({ ...base, bottom: ["context"], contextWindow: 131072, contextTokens: 9600 }, 80)[0],
    "context: 9.6k/131.1k (7%)",
  );
  // big windows format as M
  assert.equal(
    bottomLines({ ...base, bottom: ["context"], contextWindow: 2_000_000, contextTokens: 2_100_000 }, 80)[0],
    "context: 2.1M/2M (105%)",
  );

  // static labels: cwd / session
  assert.equal(bottomLines({ ...base, bottom: ["cwd"] }, 80)[0], "cwd: /w");
  assert.equal(bottomLines({ ...base, bottom: ["session"], info: {} }, 80)[0], "session: —");

  // more fields than lines → only the first RESERVED_BOTTOM_LINES
  assert.equal(bottomLines({ ...base, bottom: ["model", "status", "turn", "tokens"] }, 80).length, 3);

  // unknown keys are skipped, the rest still render (fresh state: turn 0)
  assert.deepEqual(
    bottomLines({ ...base, bottom: ["bogus", "turn"] }, 80),
    ["turn: 0", "", ""],
  );

  // long values truncate to exactly one row at width
  const long = bottomLines({ ...base, bottom: ["cwd"], info: { cwd: "x".repeat(200) } }, 80)[0];
  assert.ok(wrapLineCount(long as string, 80) <= 1);
});

test("handleSlashCommand: /display-bottom set, clear, report, unknown, passthrough", () => {
  const s = makeInitialState("m");

  // report (no args): current selection + menu, state otherwise untouched
  const r0 = handleSlashCommand(s, "/display-bottom");
  assert.equal(r0.handled, true);
  assert.deepEqual(r0.state.bottom, []);
  const info0 = r0.state.items[r0.state.items.length - 1];
  assert.equal(info0?.kind, "info");
  assert.match((info0 as { text: string }).text, /display-bottom: \(none\) — fields: model status turn tokens context cwd session/);

  // set (deduped, order preserved)
  const r1 = handleSlashCommand(s, "/display-bottom status model status");
  assert.equal(r1.handled, true);
  assert.deepEqual(r1.state.bottom, ["status", "model"]);
  assert.match((r1.state.items[r1.state.items.length - 1] as { text: string }).text, /display-bottom: status model/);

  // off / none clear
  assert.deepEqual(handleSlashCommand(r1.state, "/display-bottom off").state.bottom, []);
  assert.deepEqual(handleSlashCommand(r1.state, "/display-bottom none").state.bottom, []);

  // unknown field → rejected with the menu, selection unchanged
  const r2 = handleSlashCommand(r1.state, "/display-bottom bogus");
  assert.equal(r2.handled, true);
  assert.deepEqual(r2.state.bottom, ["status", "model"]);
  assert.match((r2.state.items[r2.state.items.length - 1] as { text: string }).text, /unknown field 'bogus'/);

  // everything else passes through unhandled
  assert.equal(handleSlashCommand(s, "/quit").handled, false);
  assert.equal(handleSlashCommand(s, "/other").handled, false);
  assert.equal(handleSlashCommand(s, "not a command").handled, false);
});

test("handleSlashCommand: /stats appends one info line (turns, tokens, tool calls, session size)", () => {
  // no session configured → session part is "—", size unknown
  const r0 = handleSlashCommand(makeInitialState("m"), "/stats");
  assert.equal(r0.handled, true);
  const info0 = r0.state.items[r0.state.items.length - 1];
  assert.equal(info0?.kind, "info");
  assert.equal(
    (info0 as { text: string }).text,
    "stats: 0 turn(s), 0 tokens, 0 tool call(s), session: —",
  );

  // a state with values + a session path, size supplied by the caller
  const withVals = (info: Record<string, string>): TuiState => ({
    ...makeInitialState("m", info),
    turn: 3,
    totalTokens: 12345,
    toolCalls: 7,
  });
  const r1 = handleSlashCommand(withVals({ session: "/tmp/s.jsonl" }), "/stats", 4321);
  assert.equal(r1.handled, true);
  assert.equal(
    (r1.state.items[r1.state.items.length - 1] as { text: string }).text,
    "stats: 3 turn(s), 12345 tokens, 7 tool call(s), session: /tmp/s.jsonl (4321 bytes)",
  );

  // session path but unknown size (file missing/unreadable) → "?"
  const r2 = handleSlashCommand(withVals({ session: "/tmp/missing.jsonl" }), "/stats");
  assert.equal(
    (r2.state.items[r2.state.items.length - 1] as { text: string }).text,
    "stats: 3 turn(s), 12345 tokens, 7 tool call(s), session: /tmp/missing.jsonl (? bytes)",
  );

  // whitespace-padded form is the same command; args are not
  assert.equal(handleSlashCommand(makeInitialState("m"), "  /stats  ").handled, true);
  assert.equal(handleSlashCommand(makeInitialState("m"), "/stats now").handled, false);
  // state otherwise untouched by the command
  assert.deepEqual(r1.state.bottom, []);
  assert.equal(r1.state.input, "");
});

test("applyEvent done accumulates Usage.totalTokens", () => {
  let s = makeInitialState("m");
  const done = (total: number) => ({
    type: "done" as const,
    message: {
      role: "assistant" as const,
      content: [],
      model: "m",
      provider: "p",
      stopReason: "stop" as const,
      timestamp: 0,
      usage: { input: total - 4, output: 4, totalTokens: total },
    },
  });
  s = applyEvent(s, done(100));
  assert.equal(s.totalTokens, 100);
  s = applyEvent(s, done(50));
  assert.equal(s.totalTokens, 150);
  // no usage on the message → no change
  const noUsage = { ...done(1), message: { ...done(1).message, usage: undefined } };
  s = applyEvent(s, noUsage);
  assert.equal(s.totalTokens, 150);
});

// ── D16: slash-command completion menu ────────────────────────────────

test("slashCandidates: bare command words only, alphabetical prefix filter", () => {
  assert.deepEqual(slashCandidates(""), []); // no slash
  assert.deepEqual(slashCandidates("quit"), []); // no leading slash
  assert.deepEqual(slashCandidates("/quit"), ["/quit"]);
  assert.deepEqual(slashCandidates("/"), ["/display-bottom", "/exit", "/quit", "/stats"]); // all, alphabetical
  assert.deepEqual(slashCandidates("/d"), ["/display-bottom"]);
  assert.deepEqual(slashCandidates("/di"), ["/display-bottom"]);
  assert.deepEqual(slashCandidates("/display-bottom"), ["/display-bottom"]); // exact
  assert.deepEqual(slashCandidates("/st"), ["/stats"]);
  assert.deepEqual(slashCandidates("/zz"), []); // no match
  assert.deepEqual(slashCandidates("/display-bottom m"), []); // space → arguments, menu hides
  assert.deepEqual(slashCandidates("/quit "), []); // completed word (trailing space)
});

test("suggestMenu: grey lines with selection marker, capped, hidden for approval", () => {
  const s = makeInitialState("m");
  // no menu for a plain prompt
  assert.deepEqual(suggestMenu({ ...s, input: "hi" }, 80), []);

  // "/" → all commands, first selected ("> "), the rest ("  ")
  const all = suggestMenu({ ...s, input: "/" }, 80);
  assert.equal(all.length, 4);
  assert.deepEqual(all.map((m) => m.selected), [true, false, false, false]);
  assert.ok(all[0]!.line.startsWith("> /display-bottom — "));
  assert.ok(all[1]!.line.startsWith("  /exit — "));
  assert.ok(all[2]!.line.startsWith("  /quit — "));
  assert.ok(all[3]!.line.startsWith("  /stats — "));

  // each line is exactly one row at width
  for (const m of all) assert.ok(wrapLineCount(m.line, 80) <= 1);

  // selection moves with suggestIdx (and clamps when it overruns)
  assert.deepEqual(suggestMenu({ ...s, input: "/", suggestIdx: 2 }, 80).map((m) => m.selected),
    [false, false, true, false]);
  assert.deepEqual(suggestMenu({ ...s, input: "/", suggestIdx: 9 }, 80).map((m) => m.selected),
    [false, false, false, true]); // clamp to last

  // truncated to one row at a narrow width (marker survives)
  const narrow = suggestMenu({ ...s, input: "/" }, 20)[0]!;
  assert.ok(wrapLineCount(narrow.line, 20) <= 1);
  assert.ok(narrow.line.startsWith("> "));

  // hidden while an approval is pending
  const pending: TuiState = {
    ...s,
    input: "/",
    approval: { question: "q?", resolve: () => {} },
  };
  assert.deepEqual(suggestMenu(pending, 80), []);

  // MENU_MAX_LINES cap: temporarily grow the registry past the cap → the
  // menu shows only the first N candidates
  const saved = SLASH_COMMANDS.length;
  for (let i = 0; i < MENU_MAX_LINES + 2; i++) {
    SLASH_COMMANDS.push({ name: `zz${i}`, summary: "x" });
  }
  try {
    const capped = suggestMenu({ ...s, input: "/" }, 80);
    assert.equal(capped.length, MENU_MAX_LINES);
  } finally {
    SLASH_COMMANDS.length = saved;
  }
});

test("menuNav: arrows move the selection with wrap-around, null off-menu", () => {
  const s = makeInitialState("m");
  // off-menu: plain prompt / arguments / no match
  assert.equal(menuNav({ ...s, input: "hi" }, 1), null);
  assert.equal(menuNav({ ...s, input: "/display-bottom m" }, 1), null);
  assert.equal(menuNav({ ...s, input: "/zz" }, 1), null);

  // on-menu: down from null → 1, up from null → last (wrap)
  const base: TuiState = { ...s, input: "/" };
  assert.equal(menuNav(base, 1)!.suggestIdx, 1);
  assert.equal(menuNav(base, -1)!.suggestIdx, 3);
  // wrap at both ends
  assert.equal(menuNav({ ...base, suggestIdx: 3 }, 1)!.suggestIdx, 0);
  assert.equal(menuNav({ ...base, suggestIdx: 0 }, -1)!.suggestIdx, 3);
  // a stale (overrun) index is clamped before moving
  assert.equal(menuNav({ ...base, suggestIdx: 9 }, 1)!.suggestIdx, 0);
  // state otherwise untouched
  const nav = menuNav(base, 1) as TuiState;
  assert.equal(nav.input, "/");
  assert.deepEqual(nav.bottom, []);
});

test("menuComplete: enter completes the selected word, exact match submits", () => {
  const s = makeInitialState("m");
  // off-menu → null (normal submit path runs)
  assert.equal(menuComplete({ ...s, input: "hi" }), null);
  assert.equal(menuComplete({ ...s, input: "/quit ", suggestIdx: null }), null);

  // "/" + first selection → completes to the full command + space
  const c1 = menuComplete({ ...s, input: "/" });
  assert.equal(c1!.input, "/display-bottom ");
  assert.equal(c1!.suggestIdx, null);

  // a partial word completes the selected candidate
  const c2 = menuComplete({ ...s, input: "/q", suggestIdx: 0 });
  assert.equal(c2!.input, "/quit ");

  // the selected (navigated) candidate is the one completed
  const c3 = menuComplete({ ...s, input: "/", suggestIdx: 2 });
  assert.equal(c3!.input, "/quit ");
  const c4 = menuComplete({ ...s, input: "/", suggestIdx: 3 });
  assert.equal(c4!.input, "/stats ");

  // exact match → null (Enter submits; the completed trailing-space form
  // also has no menu → null)
  assert.equal(menuComplete({ ...s, input: "/quit" }), null);
  assert.equal(menuComplete({ ...s, input: "/quit " }), null);
});

test("approvalLine is one row ending in ' [y/N]'", () => {
  const line = approvalLine("Please allow: rm -rf /", 40);
  assert.ok(wrapLineCount(line, 40) <= 1);
  assert.ok(line.endsWith("[y/N]"));

  // short question passes through untouched + suffix
  assert.equal(approvalLine("ok?", 80), "ok? [y/N]");
});

// ── App render geometry (fake stdout: columns=100, no rows → 24) ───────

const W = 100; // ink-testing-library fake stdout `columns` getter
const H = 24; // Ink's rows fallback when stdout.rows is absent
const SEP_LINE = "\u2500".repeat(W);

test("App frame is exactly rows tall with the pinned block at the bottom", () => {
  const app = renderApp(
    mkState([
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "On it.", streaming: false, thinking: false, thinkingText: "" },
    ]),
  );
  try {
    const lines = frameLines(app.lastFrame());
    assert.equal(lines.length, H); // frame == rows always (pad fills the gap)
    assert.ok(lineAt(lines, 0).includes("turn 1")); // header row: "test-model — turn 1"
    assert.ok(lineAt(lines, 17).includes("enter send")); // hint line
    assert.equal(lineAt(lines, 18), SEP_LINE); // top separator (full width)
    // input row (empty input → the cursor alone): exactly 4 above the bottom
    assert.equal(lineAt(lines, 19), "\u258d",
      `input row not the bare cursor: ${JSON.stringify(lineAt(lines, 19))}`);
    assert.equal(lineAt(lines, 20), SEP_LINE); // bottom separator (full width)
    for (const i of [21, 22, 23]) {
      // Ink trims trailing whitespace per line, so the " " pad arrives as ""
      assert.ok(lineAt(lines, i) === "" || lineAt(lines, i) === " ",
        `reserved line ${i} not blank: ${JSON.stringify(lineAt(lines, i))}`);
    }
  } finally {
    app.unmount();
  }
});

test("App frame shows the approval question one line above the hint when pending", () => {
  const app = renderApp(
    mkState([{ kind: "user", text: "run it" }], {
      approval: { question: "Allow running `rm -rf /`?", resolve: () => {} },
    }),
  );
  try {
    const lines = frameLines(app.lastFrame());
    assert.equal(lines.length, H); // still exactly rows (budget shrank by 1)
    assert.ok(lineAt(lines, 16).endsWith("[y/N]")); // approval line above the hint
    // the hint SWITCHES to the approval hint while pending (pre-existing
    // behavior, pinned by tui-app.test.tsx) — not "enter send"
    assert.ok(lineAt(lines, 17).includes("y approve"));
    assert.equal(lineAt(lines, 18), SEP_LINE);
    assert.equal(lineAt(lines, 19), "\u258d"); // input row still pinned (bare cursor)
  } finally {
    app.unmount();
  }
});

test("App frame: input text on the input row, bottom fields in the reserved lines", () => {
  const app = renderApp(
    mkState([{ kind: "user", text: "run it" }], {
      input: "hello",
      cursorPos: 5,
      bottom: ["model", "status", "turn"],
    }),
  );
  try {
    const lines = frameLines(app.lastFrame());
    assert.equal(lines.length, H);
    assert.equal(lineAt(lines, 19), "hello\u258d"); // typed text + cursor, no 'you ' prefix
    assert.equal(lineAt(lines, 20), SEP_LINE);
    assert.equal(lineAt(lines, 21), "model: test-model");
    assert.equal(lineAt(lines, 22), "status: idle");
    assert.equal(lineAt(lines, 23), "turn: 1"); // bottom block still exactly 3 rows
  } finally {
    app.unmount();
  }
});

test("App frame: user item renders as plain text at full width (no 'you ' prefix)", () => {
  const app = renderApp(mkState([{ kind: "user", text: "the prompt" }]));
  try {
    const frame = app.lastFrame() ?? "";
    assert.match(frame, /the prompt/);
    assert.doesNotMatch(frame, /you/);
  } finally {
    app.unmount();
  }
});

test("App frame: '/' shows the grey menu above the top separator, frame stays rows tall", () => {
  const app = renderApp(mkState([], { input: "/", cursorPos: 1, suggestIdx: 1 }));
  try {
    const lines = frameLines(app.lastFrame());
    assert.equal(lines.length, H); // exactly rows (budget shrank by 4)
    // the menu sits between the hint and the top separator: with 4 menu
    // lines the hint moves up to row 13, the block stays pinned at the end
    assert.ok(lineAt(lines, 13).includes("enter send")); // hint line
    assert.ok(lineAt(lines, 14).startsWith("  /display-bottom")); // unselected: dim, two spaces
    assert.ok(lineAt(lines, 15).startsWith("> /exit")); // selected (idx 1): marked
    assert.ok(lineAt(lines, 16).startsWith("  /quit"));
    assert.ok(lineAt(lines, 17).startsWith("  /stats"));
    assert.equal(lineAt(lines, 18), SEP_LINE); // top separator still full width
    assert.equal(lineAt(lines, 19), "/\u258d"); // input row: the typed slash + cursor
    assert.equal(lineAt(lines, 20), SEP_LINE); // bottom separator
  } finally {
    app.unmount();
  }
});

test("App frame stays exactly rows tall when items grow (pad shrinks)", () => {
  const app = renderApp(
    mkState([
      { kind: "user", text: "fill it up" },
      // 200×'x' wraps to 2 lines at width 100 — pad must shrink, frame not grow
      { kind: "assistant", text: "x".repeat(200), streaming: false, thinking: false, thinkingText: "" },
    ]),
  );
  try {
    const lines = frameLines(app.lastFrame());
    assert.equal(lines.length, H);
    assert.equal(lineAt(lines, 19), "\u258d"); // input still pinned in place (bare cursor)
    assert.ok(lineAt(lines, 17).includes("enter send"));
  } finally {
    app.unmount();
  }
});
// ─────────────────────── C28: output scrollback (content-anchored viewport) ───────────────────────
// viewTop = the CONTENT row the viewport's top edge sits at (null = follow
// the bottom — exactly the legacy fitItems window). Pinned windows CLIP
// straddling items to the visible rows (no gap lines): the window always
// renders exactly `budget` content rows, so even a single item taller than
// the budget scrolls.

/** A user item that renders exactly 2 lines at width 80 (100 chars). */
const twoLineUser = (i: number): TuiItem => ({
  kind: "user",
  text: `item-${i} ` + "x".repeat(91), // 7 + 91 = 100 chars → 2 lines at 80
});

test("C28: fitItemsScrollable following the bottom is byte-identical to fitItems", () => {
  // Uniform-height content: 10 assistant items × 300 chars → 4 lines each
  // at width 80 (C31: 78-wide hang); assistants after assistants add no
  // separator, so every item is exactly 4 lines. 40 lines total, budget
  // 16 → W = 40 − 16 = 24 = an item boundary, so the legacy tail window
  // and the absolute window select the SAME items, full, with the same pad.
  const items: TuiItem[] = Array.from({ length: 10 }, (_, i) => ({
    kind: "assistant",
    text: `a${i} ` + "x".repeat(298), // 300 chars → 4 lines at 80 (C31)
    streaming: false,
    thinking: false,
    thinkingText: "",
  }));
  for (const extra of [0, 1, 3]) {
    const legacy = fitItems(items, 80, 24, extra);
    const s = fitItemsScrollable(items, 80, 24, extra, null);
    assert.deepEqual(
      s.visible.map((v) => v.item),
      legacy.visible,
      `visible identical (extra=${extra})`,
    );
    assert.ok(s.visible.every((v) => v.from === 0), "full items (no clip)");
    assert.equal(s.pad, legacy.pad, `pad identical (extra=${extra})`);
    assert.equal(s.eff, 0);
    assert.equal(s.total, 40);
  }
});

test("C28: maxScroll is total−budget; 0 when the content fits (even a stale pin follows)", () => {
  const ten = Array.from({ length: 10 }, (_, i) => twoLineUser(i)); // 29 lines (C31)
  assert.equal(fitItemsScrollable(ten, 80, 24, 0, 0).maxScroll, 13); // 29 − 16
  const four = Array.from({ length: 4 }, (_, i) => twoLineUser(i)); // 11 ≤ 16 (C31)
  assert.equal(fitItemsScrollable(four, 80, 24, 0, 999).maxScroll, 0);
  assert.equal(fitItemsScrollable(four, 80, 24, 0, 999).eff, 0, "clamped to the range");
  assert.equal(fitItemsScrollable(four, 80, 24, 0, 999).pad, 5, "legacy tail window + pad (16 − 11)");
});

test("C28: a pinned window holds exactly the budget rows (straddlers clipped, no gaps)", () => {
  const items: TuiItem[] = Array.from({ length: 10 }, (_, i) => twoLineUser(i)); // 29 lines (C31: 2 + 9×3)
  // maxScroll 13, viewTop 1 → window [1,17): item0 [0,2) straddles top
  // (clip line 1); item1 [2,5)…item5 [14,17) full (3 lines each: C31 blank
  // + 2); item6 [17,20) starts at the bottom edge → excluded. 6 pieces,
  // 16 lines, pad 0.
  const s = fitItemsScrollable(items, 80, 24, 0, 1);
  assert.deepEqual(s.visible.map((v) => v.item), items.slice(0, 6));
  assert.equal(s.visible[0]!.from, 1, "top straddler clipped from its 2nd line");
  assert.equal(s.visible[0]!.to, 2);
  assert.equal(s.visible[5]!.from, 0);
  assert.equal(s.visible[5]!.to, 3, "item5 ends exactly at the bottom edge");
  assert.equal(s.pad, 0, "no gap lines — the window is full");
  const shown = s.visible.reduce((a, v) => a + (v.to - v.from), 0);
  assert.equal(shown, 16, "exactly the budget rows");
  assert.equal(s.eff, 12, "12 rows between the window bottom and the content bottom");
});

test("C28: a SINGLE item taller than the budget scrolls (the C27 defect)", () => {
  // 42 lines > the 16-row budget (C31: 3200 chars hang at width−2=78):
  // C27's straddle-skip left every scroll position rendering the identical
  // overflow frame. C28 clips.
  const huge: TuiItem = { kind: "user", text: "y".repeat(3200) }; // 42 lines at 80 (C31)
  const atTop = fitItemsScrollable([huge], 80, 24, 0, 0);
  assert.equal(atTop.maxScroll, 26);
  assert.deepEqual(atTop.visible, [{ item: huge, from: 0, to: 16 }]);
  const mid = fitItemsScrollable([huge], 80, 24, 0, 12);
  assert.deepEqual(mid.visible, [{ item: huge, from: 12, to: 28 }], "window [12,28)");
  const atBottom = fitItemsScrollable([huge], 80, 24, 0, 26);
  assert.deepEqual(atBottom.visible, [{ item: huge, from: 26, to: 42 }]);
  assert.equal(atBottom.eff, 0, "at the bottom");
  assert.notDeepEqual(mid.visible, atTop.visible, "different positions render different rows");
});

test("C30: FOLLOW mode clips an over-budget tail item (no frame overflow, no scrollback clear)", () => {
  // The user's "output clears on a new turn, can't scroll back" bug: a
  // single reply (or big tool diff) taller than the item budget, while the
  // view follows the bottom (viewTop null). The legacy fitItems window kept
  // that item WHOLE, so the frame was taller than the viewport — Ink's
  // shouldClearTerminalForFrame then ran clearTerminal, and \u001b[3J erased
  // the TERMINAL SCROLLBACK. C30 clips the tail to the budget (the last
  // `budget` lines — follow the bottom), so the frame is exactly `rows`
  // tall and no clear is ever emitted.
  const budget = itemAreaBudget(24, 0); // 16 at 24 rows
  const huge: TuiItem = { kind: "user", text: "y".repeat(3200) }; // 42 lines at 80 (C31: width−2 hang)
  const s = fitItemsScrollable([huge], 80, 24, 0, null); // viewTop null = follow
  assert.equal(s.maxScroll, 26, "content still scrolls (maxScroll unchanged)");
  assert.deepEqual(s.visible, [{ item: huge, from: 42 - budget, to: 42 }], "clipped to the LAST budget lines");
  assert.equal(s.pad, 0, "window full");
  assert.equal(s.eff, 0, "following the bottom");
  // The frame (visible lines + pad) is exactly the budget — never taller,
  // so it never overflows the viewport and Ink never full-clears.
  const shown = s.visible.reduce((a, v) => a + (v.to - v.from), 0);
  assert.equal(shown + s.pad, budget, "frame content rows == budget (no overflow)");
  // The clip is a slice of the SAME item (the renderer does
  // itemLines(item).slice(from, to)) — height math stays in lockstep.
  assert.equal(itemHeight(s.visible[0]!.item, 80), 42, "the item itself is unchanged");

  // A short item before an over-budget tail: the legacy fitItems window
  // keeps only the over-budget tail (it alone fills the window), and C30
  // clips it to the FULL budget (the short item is excluded by the legacy
  // tail logic — unchanged behavior). C31: the tail's own height includes
  // its leading blank (it follows the short item) → 43 lines.
  const short: TuiItem = { kind: "user", text: "q" }; // 1 line
  const mixed = fitItemsScrollable([short, huge], 80, 24, 0, null);
  assert.deepEqual(
    mixed.visible.map((v) => [v.item, v.from, v.to]),
    [[huge, 43 - budget, 43]],
    "over-budget tail alone fills the window, clipped to the full budget",
  );
  const mixedShown = mixed.visible.reduce((a, v) => a + (v.to - v.from), 0);
  assert.equal(mixedShown + mixed.pad, budget, "still exactly the budget rows");

  // No-overflow regression for the common case: content that FITS is
  // byte-identical to the legacy window (full items, from 0). C31: 5 items
  // = 2 + 4×3 = 14 lines (first has no separator).
  const fits = Array.from({ length: 5 }, (_, i) => twoLineUser(i)); // 14 ≤ 16
  const f = fitItemsScrollable(fits, 80, 24, 0, null);
  assert.ok(f.visible.every((v) => v.from === 0), "no clip when it fits");
  assert.equal(f.pad, budget - 14);
});

test("C28: pinned view stays put as content appends (no drift), follows when it reaches the bottom", () => {
  // A pinned viewTop is an ABSOLUTE content row. Simulate output appending:
  // the window [2,18) at 29 lines (C31) is still [2,18) at 44 lines
  // (eff grows).
  const items10 = Array.from({ length: 10 }, (_, i) => twoLineUser(i)); // 29 lines (C31)
  const items15 = [...items10, ...Array.from({ length: 5 }, (_, i) => twoLineUser(10 + i))]; // 44
  const a = fitItemsScrollable(items10, 80, 24, 0, 2);
  const b = fitItemsScrollable(items15, 80, 24, 0, 2);
  assert.deepEqual(
    b.visible.map((v) => [v.item, v.from, v.to]),
    a.visible.map((v) => [v.item, v.from, v.to]),
    "same window, same clips — the view did not slide",
  );
  assert.equal(b.eff, 26, "new output landed BELOW the window (28 − 2)");
  // scrollBy(0, larger maxScroll) on the C28 value keeps the same content row.
  const s = scrollBy(scrollToBottom({ ...makeInitialState("m") }), 2, 4);
  assert.equal(s.viewTop, 2, "2 rows up from the bottom");
  assert.equal(scrollBy(s, 0, 14).viewTop, 2, "still row 2 at 44 lines");
  assert.equal(scrollBy(s, -2, 14).viewTop, 4, "scrolling DOWN moves the pinned top toward the bottom");
  assert.equal(scrollBy(s, -12, 14).viewTop, null, "reached the bottom → follow");
});

test("C28: a pinned window renders exactly the budget rows (no gaps)", () => {
  // 100×24 → item budget 16. C31: 200-char items hang at width−2=98 → 3
  // lines; the first renders 3 (no separator), the rest 4 (leading blank)
  // = 39 lines. maxScroll 23, viewTop 3 → window [3,19): item0 above;
  // items 1..4 full (4 each, starting exactly at the window top); item5
  // [19,23) at the bottom edge → excluded.
  const items: TuiItem[] = Array.from({ length: 10 }, (_, i) => ({
    kind: "user",
    text: `item-${i} ` + "x".repeat(192), // 200 chars → 3 lines at 100 (C31: 98-wide hang)
  }));
  const s = fitItemsScrollable(items, 100, 24, 0, 3);
  assert.deepEqual(s.visible.map((v) => [v.item, v.from, v.to]), [
    [items[1]!, 0, 4],
    [items[2]!, 0, 4],
    [items[3]!, 0, 4],
    [items[4]!, 0, 4],
  ]);
  const shown = s.visible.reduce((a, v) => a + (v.to - v.from), 0);
  assert.equal(shown + s.pad, 16, "window exactly budget tall (no gaps)");
});

test("C28: the rendered lines of a slice are EXACTLY the counted lines (the lockstep contract)", () => {
  const mk = (t: string): TuiItem => ({ kind: "user", text: t });
  // Contract: itemLines(item, w).length === itemHeight(item, w) for every
  // kind and every width — the fit counts lines, the renderer slices them.
  const samples: TuiItem[] = [
    mk(""),
    mk("x".repeat(200)),
    { kind: "assistant", text: "x".repeat(161), streaming: false, thinking: false, thinkingText: "" },
    { kind: "assistant", text: "x".repeat(161), streaming: true, thinking: false, thinkingText: "" },
    { kind: "assistant", text: "", streaming: true, thinking: false, thinkingText: "" },
    { kind: "assistant", text: "hello", streaming: true, thinking: true, thinkingText: "" },
    // reasoning: dimmed header + wrapped thinking text, live and settled
    { kind: "assistant", text: "hello", streaming: true, thinking: true, thinkingText: "thinking" },
    { kind: "assistant", text: "hello", streaming: false, thinking: false, thinkingText: "let me think about this for a while" },
    { kind: "tool", id: "1", name: "bash", argsText: "a".repeat(300), running: true },
    {
      kind: "tool",
      id: "2",
      name: "edit",
      argsText: '{ path: "a.txt" }',
      running: false,
      diff: ["+added line that is quite long and wraps at the width", "-removed", "+short"],
      resultText: "ok",
    },
    { kind: "tool", id: "3", name: "read", argsText: '{ path: "a.txt" }', running: false, hidden: true },
    { kind: "compaction", tokensBefore: 12345, summaryChars: 999, messagesKept: 7 },
    { kind: "error", text: "boom" },
    { kind: "info", text: "note" },
  ];
  for (const item of samples) {
    for (const width of [1, 7, 23, 80]) {
      assert.equal(itemLines(item, width).length, itemHeight(item, width), `${JSON.stringify(item.kind)} w=${width}`);
    }
  }
});

test("C31: itemLines shapes — icons, hanging indents, separators", () => {
  // user: a CYAN ❯ icon leads; the text HANGS under it — wrapped at
  // width−2, icon on line 1, 2-space indent on the rest. Empty text → one
  // blank (colored) line.
  assert.deepEqual(itemLines({ kind: "user", text: "" }, 80), [{ spans: [{ text: " ", color: "cyan" }] }]);
  assert.deepEqual(itemLines({ kind: "user", text: "hi" }, 80), [{ spans: [{ text: "❯ hi", color: "cyan" }] }]);
  assert.deepEqual(
    itemLines({ kind: "user", text: "aa bb" }, 6),
    [
      { spans: [{ text: "❯ aa ", color: "cyan" }] },
      { spans: [{ text: "  bb", color: "cyan" }] },
    ],
    "multi-line prompt: icon on line 1, hanging indent on the rest",
  );
  const asst = (t: string): TuiItem => ({ kind: "assistant", text: t, streaming: false, thinking: false, thinkingText: "" });
  // C31 spacing: a non-first user item leads with a blank line (a new
  // turn), and a non-user item after a user item leads with one too
  // (prompt | reply). FIRST items (no prev) have no separator.
  assert.deepEqual(
    itemLines({ kind: "user", text: "hi" }, 80, asst("r")),
    [
      { spans: [{ text: " " }] },
      { spans: [{ text: "❯ hi", color: "cyan" }] },
    ],
  );
  assert.deepEqual(
    itemLines(asst("r"), 80, { kind: "user", text: "q" }),
    [
      { spans: [{ text: " " }] },
      { spans: [{ text: "◆ r" }] },
    ],
  );
  // assistant: the cursor is part of the text (and of the height); ◆ leads.
  const streamed = itemLines({ kind: "assistant", text: "ab", streaming: true, thinking: false, thinkingText: "" }, 80);
  assert.deepEqual(streamed, [{ spans: [{ text: "◆ ab▍" }] }]);
  // reasoning: a distinct block above the reply — a dim "◦ thinking…"
  // header, the reasoning under a dim "│ " gutter (wrapped at width−2), a
  // blank line before the reply, and the reply under its ◆. Live
  // ("thinking…") while streaming, settled ("thinking") after done.
  const think = itemLines(
    { kind: "assistant", text: "ok", streaming: true, thinking: true, thinkingText: "hmm, check" },
    80,
  );
  assert.deepEqual(think, [
    { spans: [{ text: "◦ thinking…", dim: true }] },
    { spans: [{ text: "│ hmm, check", dim: true }] },
    { spans: [{ text: " " }] },
    { spans: [{ text: "◆ ok▍" }] },
  ]);
  const thinkDone = itemLines(
    { kind: "assistant", text: "ok", streaming: false, thinking: false, thinkingText: "hmm, check" },
    80,
  );
  assert.deepEqual(thinkDone, [
    { spans: [{ text: "◦ thinking", dim: true }] },
    { spans: [{ text: "│ hmm, check", dim: true }] },
    { spans: [{ text: " " }] },
    { spans: [{ text: "◆ ok" }] },
  ]);
  // tool running: colored mark span (YELLOW = in flight) + blue name span
  // + plain args; hard wrap splits the line (the header is unchanged by C31).
  const run = itemLines({ kind: "tool", id: "t", name: "bash", argsText: "a".repeat(100), running: true }, 80);
  assert.equal(run.length, 2);
  // line 1 = mark(1) + " bash "(6) + 73 args chars = 80 display columns.
  assert.deepEqual(run[0]!.spans, [
    { text: "\u2192", color: "yellow" },
    { text: " bash", color: "blue" },
    { text: " " + "a".repeat(73) },
  ]);
  assert.deepEqual(run[1]!.spans, [{ text: "a".repeat(27) }], "remaining args on line 2, plain");
  // tool done with diff + result: C31 — diff lines hang under the header
  // (2-space indent), colored runs; dim result (2-col indent).
  const done = itemLines(
    { kind: "tool", id: "t", name: "edit", argsText: "{}", running: false, diff: ["+a", "-b"], resultText: "ok" },
    80,
  );
  assert.deepEqual(done[0]!.spans, [
    { text: "\u2713", color: "green" },
    { text: " edit", color: "blue" },
    { text: " {}" },
  ]);
  // error tool: RED mark (the outcome color), blue name.
  const failed = itemLines(
    { kind: "tool", id: "t", name: "bash", argsText: "ls", running: false, resultText: "boom", isError: true },
    80,
  );
  assert.deepEqual(failed[0]!.spans, [
    { text: "\u2717", color: "red" },
    { text: " bash", color: "blue" },
    { text: " ls" },
  ]);
  assert.deepEqual(done[1]!.spans, [{ text: "  +a", color: "green" }], "diff hangs under the header (C31)");
  assert.deepEqual(done[2]!.spans, [{ text: "  -b", color: "red" }]);
  assert.deepEqual(done[3]!.spans, [{ text: "  ok", dim: true }]);
  // hidden tool: no lines at all — not even the C31 separator.
  assert.deepEqual(
    itemLines({ kind: "tool", id: "h", name: "read", argsText: "{}", running: true, hidden: true }, 80, { kind: "user", text: "q" }),
    [],
  );
  // VISIBLE tool after a prompt: the C31 separator leads (the tool case
  // used to shadow the separator — lockstep with itemHeight's +1).
  const toolAfterUser = itemLines({ kind: "tool", id: "t", name: "bash", argsText: "ls", running: true }, 80, { kind: "user", text: "q" });
  assert.deepEqual(toolAfterUser[0], { spans: [{ text: " " }] }, "separator first");
  assert.equal(toolAfterUser.length, 2);
  assert.equal(itemHeight({ kind: "tool", id: "t", name: "bash", argsText: "ls", running: true }, 80, { kind: "user", text: "q" }), toolAfterUser.length, "lockstep");
  // compaction: the ✂ icon leads (2 cols), the text hangs under it.
  const comp = itemLines({ kind: "compaction", tokensBefore: 2000, summaryChars: 5, messagesKept: 1 }, 80);
  assert.equal(comp.length, 1);
  assert.ok(comp[0]!.spans[0]!.text.startsWith("\u2702 "));
  assert.equal(comp[0]!.spans[0]!.color, "magenta");
  // error / info: ⚠ / ℹ lead (2 cols), the text hangs under it.
  assert.deepEqual(itemLines({ kind: "error", text: "x" }, 80), [{ spans: [{ text: "\u26a0 x", color: "red" }] }]);
  assert.deepEqual(itemLines({ kind: "info", text: "x" }, 80), [{ spans: [{ text: "\u2139 x", dim: true }] }]);
});

test("C28: itemAreaBudget mirrors the fit reservation", () => {
  assert.equal(itemAreaBudget(24, 0), 16);
  assert.equal(itemAreaBudget(24, 3), 13);
  assert.equal(itemAreaBudget(3, 0), 1, "clamped at 1");
});
