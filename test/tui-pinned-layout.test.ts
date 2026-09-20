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
  inputCursor,
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
  // top separator + input line + bottom separator + reserved lines
  // pinned block = top separator(1) + input line(1) + bottom separator(1) + reserved(3) = 6.
  // (The original spec line said `4 + RESERVED` — off by one vs the design-doc
  // frame equation 1+visible+pad+(appr?1:0)+1+1+1+1+3==rows, which pins FIXED=8.)
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

  // assistant: thinking adds exactly one line; 200×'x' alone → 3 (80+80+40)
  const asstPlain: TuiItem = {
    kind: "assistant",
    text: "x".repeat(200),
    streaming: false,
    thinking: false,
  };
  assert.equal(itemHeight(asstPlain, 80), 3);
  // NOTE (see farm report): the spec bullet reads "thinking + 200×'x' → 3"
  // but the lockstep formula is (thinking?1:0) + wrapLineCount(text) = 4.
  // Encode the FORMULA additively so either reading fails loudly at worst.
  const asstThink: TuiItem = { ...asstPlain, thinking: true };
  assert.equal(itemHeight(asstThink, 80), itemHeight(asstPlain, 80) + 1);

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

  // compaction / error: single line at width 80
  const compact: TuiItem = { kind: "compaction", tokensBefore: 4096, messagesKept: 2, summaryChars: 123 };
  assert.equal(itemHeight(compact, 80), 1);

  const err: TuiItem = { kind: "error", text: "boom" };
  assert.equal(itemHeight(err, 80), 1);
});

test("itemsHeight is the sum of itemHeights", () => {
  const a: TuiItem = { kind: "user", text: "hello" }; // 1 at w80
  const b: TuiItem = { kind: "assistant", text: "x".repeat(200), streaming: false, thinking: false }; // 3 at w80
  const c: TuiItem = { kind: "error", text: "boom" }; // 1 at w80
  assert.equal(itemsHeight([a, b, c], 80), itemHeight(a, 80) + itemHeight(b, 80) + itemHeight(c, 80));
  assert.equal(itemsHeight([a, b, c], 80), 5);
});

// ── fitItems ───────────────────────────────────────────────────────────

test("fitItems keeps the longest tail that fits and pads the rest (rows=24)", () => {
  const oneLiners: TuiItem[] = [
    { kind: "user", text: "q0" },
    { kind: "assistant", text: "a1", streaming: false, thinking: false },
    { kind: "user", text: "q2" },
  ];

  // D16: the 4th arg is extraLines (approval + menu); 0 → budget 16
  const r1 = fitItems(oneLiners, 80, 24, 0);
  assert.equal(r1.visible.length, 3);
  assert.equal(itemsHeight(r1.visible, 80), 3);
  assert.equal(r1.pad, 24 - FIXED_NON_ITEM_LINES - 3); // 13

  // a pending approval steals exactly one line of budget → pad shrinks by 1
  const r2 = fitItems(oneLiners, 80, 24, 1);
  assert.equal(r2.visible.length, 3);
  assert.equal(r2.pad, 24 - FIXED_NON_ITEM_LINES - 1 - 3); // 12

  // a 3-line completion menu steals exactly 3 lines of budget
  const r5 = fitItems(oneLiners, 80, 24, 3);
  assert.equal(r5.visible.length, 3);
  assert.equal(r5.pad, 24 - FIXED_NON_ITEM_LINES - 3 - 3); // 10

  // 30 items × exactly 5 lines (360 = 4×80+40) → longest tail is the last 3
  const big: TuiItem[] = Array.from({ length: 30 }, () => ({
    kind: "assistant" as const,
    text: "y".repeat(360),
    streaming: false,
    thinking: false,
  }));
  assert.equal(itemHeight(big[29] as TuiItem, 80), 5); // sanity: exactly 5 lines each
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
  const monster: TuiItem = { kind: "assistant", text: "z".repeat(4000), streaming: false, thinking: false };
  assert.equal(itemHeight(monster, 80), 50); // sanity: exactly 50 lines (50×80)
  const r4 = fitItems([monster], 80, 24, 0);
  assert.equal(r4.visible.length, 1);
  assert.equal(r4.visible[0], monster);
  assert.equal(r4.pad, 0);
});

// ── inputCursor / approvalLine ──────────────────────────────────────────

test("inputCursor: always one row, cursor at its LOCATION, keeps the visible window", () => {
  // empty input → the cursor alone (the row is never blank)
  assert.equal(inputCursor("", 0, 80), "\u258d");

  // short input, cursor at the end → passes through + the cursor at the end
  assert.equal(inputCursor("hello", 5, 80), "hello\u258d");

  // cursor in the MIDDLE → the ▍ is at that position, not the end
  assert.equal(inputCursor("hello", 2, 80), "he\u258dllo");
  assert.equal(inputCursor("hello", 0, 80), "\u258dhello"); // at the start

  // long input, cursor at the END: tail kept + cursor = exactly one row
  const long = inputCursor("x".repeat(300), 300, 80);
  assert.notEqual(long, "x".repeat(300) + "\u258d"); // was truncated
  assert.ok(wrapLineCount(long, 80) <= 1); // one row at width
  assert.ok(long.endsWith("\u258d")); // cursor at the end
  assert.ok(long.startsWith("\u2026")); // head dropped → ellipsis
  assert.ok(long.endsWith("xxxxx\u258d")); // keeps the TAIL

  // long input, cursor in the MIDDLE: the window is centered on the cursor —
  // the cursor is visible (not the tail), head + tail both trimmed, one row.
  const mid = inputCursor("a".repeat(100) + "b".repeat(100), 100, 80);
  assert.ok(wrapLineCount(mid, 80) <= 1);
  assert.ok(mid.includes("\u258d")); // the cursor is on the row
  assert.ok(mid.startsWith("\u2026")); // head (the a's) dropped
  assert.ok(mid.endsWith("\u258d" + "b".repeat(78))); // tail (b's) after the cursor

  // long input, cursor near the START: shown from column 0 (no ellipsis head)
  const nearStart = inputCursor("x".repeat(300), 3, 80);
  assert.equal(nearStart.startsWith("\u2026"), false); // no head ellipsis
  assert.ok(wrapLineCount(nearStart, 80) <= 1);
  assert.ok(nearStart.includes("\u258d"));
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
  assert.match((info0 as { text: string }).text, /display-bottom: \(none\) — fields: model status turn tokens cwd session/);

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
  assert.deepEqual(slashCandidates("/"), ["/display-bottom", "/exit", "/quit"]); // all, alphabetical
  assert.deepEqual(slashCandidates("/d"), ["/display-bottom"]);
  assert.deepEqual(slashCandidates("/di"), ["/display-bottom"]);
  assert.deepEqual(slashCandidates("/display-bottom"), ["/display-bottom"]); // exact
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
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((m) => m.selected), [true, false, false]);
  assert.ok(all[0]!.line.startsWith("> /display-bottom — "));
  assert.ok(all[1]!.line.startsWith("  /exit — "));
  assert.ok(all[2]!.line.startsWith("  /quit — "));

  // each line is exactly one row at width
  for (const m of all) assert.ok(wrapLineCount(m.line, 80) <= 1);

  // selection moves with suggestIdx (and clamps when it overruns)
  assert.deepEqual(suggestMenu({ ...s, input: "/", suggestIdx: 2 }, 80).map((m) => m.selected),
    [false, false, true]);
  assert.deepEqual(suggestMenu({ ...s, input: "/", suggestIdx: 9 }, 80).map((m) => m.selected),
    [false, false, true]); // clamp to last

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
  assert.equal(menuNav(base, -1)!.suggestIdx, 2);
  // wrap at both ends
  assert.equal(menuNav({ ...base, suggestIdx: 2 }, 1)!.suggestIdx, 0);
  assert.equal(menuNav({ ...base, suggestIdx: 0 }, -1)!.suggestIdx, 2);
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
      { kind: "assistant", text: "On it.", streaming: false, thinking: false },
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
    assert.equal(lines.length, H); // exactly rows (budget shrank by 3)
    // the menu sits between the hint and the top separator: with 3 menu
    // lines the hint moves up to row 14, the block stays pinned at the end
    assert.ok(lineAt(lines, 14).includes("enter send")); // hint line
    assert.ok(lineAt(lines, 15).startsWith("  /display-bottom")); // unselected: dim, two spaces
    assert.ok(lineAt(lines, 16).startsWith("> /exit")); // selected (idx 1): marked
    assert.ok(lineAt(lines, 17).startsWith("  /quit"));
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
      { kind: "assistant", text: "x".repeat(200), streaming: false, thinking: false },
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
