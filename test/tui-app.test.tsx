/**
 * WS10 — Ink render tests (ink-testing-library): the App renders the state
 * and routes keys to the injected callbacks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/tui/app.js";
import {
  applyEvent,
  makeInitialState,
  setApproval,
  type TuiItem,
} from "../src/tui/state.js";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
// Bare escape sequences are held ~20ms by Ink's input parser (they may be
// the first byte of a longer escape) — wait past that for the esc test.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

interface Cbs {
  onChar?: (ch: string) => void;
  onBackspace?: () => void;
  onScrollBy?: (delta: number, maxScroll: number) => void;
  onScrollToTop?: () => void;
  onScrollToBottom?: () => void;
  onMove?: (dir: -1 | 1) => void;
  onHistory?: (dir: -1 | 1) => void;
  onSubmit?: () => void;
  onCtrlC?: () => void;
  onApproval?: (ok: boolean) => void;
  onQuit?: () => void;
}

const makeApp = (state: ReturnType<typeof makeInitialState>, cbs?: Cbs) =>
  render(
    React.createElement(App, {
      state,
      onChar: (ch: string) => cbs?.onChar?.(ch),
      onBackspace: () => cbs?.onBackspace?.(),
      onScrollBy: (delta: number, maxScroll: number) => cbs?.onScrollBy?.(delta, maxScroll),
      onScrollToTop: () => cbs?.onScrollToTop?.(),
      onScrollToBottom: () => cbs?.onScrollToBottom?.(),
      onMove: (dir: -1 | 1) => cbs?.onMove?.(dir),
      onHistory: (dir: -1 | 1) => cbs?.onHistory?.(dir),
      onSubmit: () => cbs?.onSubmit?.(),
      onCtrlC: () => cbs?.onCtrlC?.(),
      onApproval: (ok: boolean) => cbs?.onApproval?.(ok),
      onQuit: () => cbs?.onQuit?.(),
    }),
  );

test("renders header, items (user/assistant/tool/diff/compaction/error), prompt and hints", async () => {
  const items: TuiItem[] = [
    { kind: "user", text: "fix the bug" },
    { kind: "assistant", text: "On it.", streaming: false, thinking: false, thinkingText: "" },
    { kind: "tool", id: "t1", name: "edit", argsText: '{ path: "a.txt", … }', diff: ["- x = 1", "+ x = 2"], running: false, resultText: "edited", isError: false },
    { kind: "compaction", tokensBefore: 25341, messagesKept: 4, summaryChars: 809 },
    { kind: "error", text: "error: boom" },
  ];
  const state = { ...makeInitialState("m"), items, turn: 3 };
  const app = makeApp(state);
  const frame = app.lastFrame() ?? "";
  assert.match(frame, /m — turn 3/);
  assert.match(frame, /fix the bug/);
  assert.match(frame, /On it\./);
  assert.match(frame, /edit/);
  assert.match(frame, /- x = 1/);
  assert.match(frame, /\+ x = 2/);
  assert.match(frame, /compact/);
  assert.match(frame, /error: boom/);
  assert.match(frame, /enter send/);
  app.unmount();
});

test("renders a busy indicator and the streaming caret", () => {
  const state = {
    ...makeInitialState("m"),
    busy: true,
    items: [{ kind: "assistant", text: "partial", streaming: true, thinking: false, thinkingText: "" } as TuiItem],
  };
  const app = makeApp(state);
  assert.match(app.lastFrame() ?? "", /working…/);
  assert.match(app.lastFrame() ?? "", /partial▍/);
  app.unmount();
});

test("the busy header stays ONE row: a long model label truncates, never wraps", () => {
  // The frame is exactly `rows` tall by construction; the busy suffix
  // (" · working…") is appended to the dim base, so the base must be
  // truncated to leave room — a wrap would add a row and break the frame.
  const longModel = "a".repeat(90);
  const mk = (busy: boolean) => {
    const s = { ...makeInitialState(longModel), busy, items: [] as TuiItem[] };
    const a = makeApp(s);
    return a;
  };
  const idle = mk(false);
  const idleFrame = idle.lastFrame() ?? "";
  idle.unmount();
  const busy = mk(true);
  const busyFrame = busy.lastFrame() ?? "";
  busy.unmount();
  const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const lineCount = (f: string) => strip(f).replace(/\n$/, "").split("\n").length;
  assert.match(busyFrame, /working…/);
  // The busy indicator shows (the label truncates, the indicator does not).
  assert.equal(lineCount(busyFrame), lineCount(idleFrame), "busy frame is the same height as idle");
});

test("typing routes chars and backspace to callbacks; enter submits", async () => {
  const calls: string[] = [];
  const app = makeApp(makeInitialState("m"), {
    onChar: (ch: string) => calls.push(`char:${ch}`),
    onBackspace: () => calls.push("bs"),
    onSubmit: () => calls.push("submit"),
  });
  app.stdin.write("hi");
  await tick();
  app.stdin.write("\x7f"); // backspace
  await tick();
  app.stdin.write("\r"); // enter
  await tick();
  // Ink delivers a multi-char write as ONE input event (paste-style)
  // — the TUI's onChar appends the whole string, so both orders work.
  assert.deepEqual(calls, ["char:hi", "bs", "submit"]);
  // D15: no 'you' prefix — the typed text sits on the plain input row
  assert.match(app.lastFrame() ?? "", /hi/);
  app.unmount();
});

test("a coalesced chunk (prompt + enter in ONE write) types then submits", async () => {
  const calls: string[] = [];
  const app = makeApp(makeInitialState("m"), {
    onChar: (ch: string) => calls.push(`char:${ch}`),
    onSubmit: () => calls.push("submit"),
  });
  // Real terminals coalesce fast typing into chunks containing \r — Ink
  // passes such a chunk through as one string (paste semantics), so the
  // App must split it: typed part, then submit.
  app.stdin.write("fix the bug\r");
  await tick();
  assert.deepEqual(calls, ["char:fix the bug", "submit"]);
  app.unmount();
});

test("/quit at an approval prompt denies the call and quits (no stuck user)", async () => {
  const calls: string[] = [];
  const app = makeApp(setApproval(makeInitialState("m"), "run rm -rf?", () => {}), {
    onApproval: (ok: boolean) => calls.push(ok ? "approved" : "denied"),
    onQuit: () => calls.push("quit"),
  });
  app.stdin.write("/quit\r");
  await tick();
  app.unmount();
  assert.deepEqual(calls, ["denied", "quit"]);
});

test("a coalesced approval chunk (y + enter in ONE write) approves", async () => {
  const calls: string[] = [];
  const app = makeApp(setApproval(makeInitialState("m"), "run rm -rf?", () => {}), {
    onApproval: (ok: boolean) => calls.push(ok ? "yes" : "no"),
  });
  app.stdin.write("y\r");
  await tick();
  assert.deepEqual(calls, ["yes"]);
  app.unmount();
});

test("arrows and ctrl+c route to their callbacks", async () => {
  const calls: string[] = [];
  const app = makeApp(makeInitialState("m"), {
    onHistory: (dir: -1 | 1) => calls.push(`hist:${dir}`),
    onCtrlC: () => calls.push("c-c"),
  });
  app.stdin.write("\x1b[A"); // up
  await tick();
  app.stdin.write("\x1b[B"); // down
  await tick();
  app.stdin.write("\x03"); // ctrl+c
  await tick();
  assert.deepEqual(calls, ["hist:-1", "hist:1", "c-c"]);
  app.unmount();
});

test("while an approval is pending, y/n/esc/enter answer it and nothing else types", async () => {
  const calls: string[] = [];
  const state = setApproval(makeInitialState("m"), "Run rm -rf? [y/N]", () => {});
  const app = makeApp(state, {
    onApproval: (ok: boolean) => calls.push(ok ? "yes" : "no"),
    onChar: (ch: string) => calls.push(`char:${ch}`),
    onSubmit: () => calls.push("submit"),
  });
  const frame = app.lastFrame() ?? "";
  assert.match(frame, /Run rm -rf\?/);
  assert.match(frame, /y approve · n\/esc deny/);

  app.stdin.write("x"); // typed chars are ignored
  await tick();
  app.stdin.write("y"); // → approve
  await tick();
  app.unmount();
  assert.deepEqual(calls, ["yes"]);

  // n → deny; esc → deny; enter → approve
  const mk = (label: string) => {
    const out: string[] = [];
    const a = makeApp(setApproval(makeInitialState("m"), "q?", () => {}), {
      onApproval: (ok: boolean) => out.push(ok ? "yes" : "no"),
    });
    return { a, out, label };
  };
  const t1 = mk("n");
  t1.a.stdin.write("n");
  await tick();
  t1.a.unmount();
  assert.deepEqual(t1.out, ["no"]);

  const t2 = mk("esc");
  t2.a.stdin.write("\x1b");
  await settle();
  t2.a.unmount();
  assert.deepEqual(t2.out, ["no"]);

  const t3 = mk("enter");
  t3.a.stdin.write("\r");
  await tick();
  t3.a.unmount();
  assert.deepEqual(t3.out, ["yes"]);
});

test("a folded event stream renders as the driver would fold it (state + app integration)", () => {
  let s = makeInitialState("m");
  s = applyEvent(s, { type: "agent_start" });
  s = applyEvent(s, {
    type: "tool_execution_start",
    toolCall: { type: "toolCall", id: "x", name: "bash", arguments: { command: "ls -la" } },
  });
  s = applyEvent(s, {
    type: "tool_execution_end",
    toolCallId: "x",
    result: { role: "toolResult", toolCallId: "x", toolName: "bash", content: [{ type: "text", text: "a.txt b.txt" }], isError: false, timestamp: 0 },
  });
  const app = makeApp(s);
  const frame = app.lastFrame() ?? "";
  assert.match(frame, /bash/);
  assert.match(frame, /ls -la/);
  assert.match(frame, /a\.txt b\.txt/);
  app.unmount();
});

// ─────────────────────── C27: output scrollback keys ───────────────────────
// Key → callback routing (the pure math is pinned in tui-pinned-layout /
// tui-state). Fake terminal: rows=24 → item-area page = 24 − 8 = 16,
// half-page = 8.

test("C27: PageUp/PageDown route to onScrollBy with ±page (Shift halves)", async () => {
  const calls: number[] = [];
  const app = makeApp(makeInitialState("m"), {
    onScrollBy: (d: number) => calls.push(d),
  });
  app.stdin.write("\x1b[5~"); // PageUp
  await tick();
  app.stdin.write("\x1b[6~"); // PageDown
  await tick();
  app.stdin.write("\x1b[5;2~"); // Shift+PageUp
  await tick();
  app.stdin.write("\x1b[6;2~"); // Shift+PageDown
  await tick();
  assert.deepEqual(calls, [16, -16, 8, -8]);
  app.unmount();
});

test("C27: Home/End route to onScrollToTop/onScrollToBottom (incl. Ctrl-modified)", async () => {
  let top = 0, bottom = 0;
  const app = makeApp(makeInitialState("m"), {
    onScrollToTop: () => top++,
    onScrollToBottom: () => bottom++,
  });
  app.stdin.write("\x1b[H"); // Home
  await tick();
  app.stdin.write("\x1b[4~"); // End
  await tick();
  app.stdin.write("\x1b[1;5H"); // Ctrl+Home (parsed as home+ctrl)
  await tick();
  app.stdin.write("\x1b[1;5F"); // xterm Ctrl+End (parsed as end+ctrl)
  await tick();
  assert.equal(top, 2, "Home + Ctrl+Home → top");
  assert.equal(bottom, 2, "End + xterm Ctrl+End → bottom");
  // Pinned quirk: the alternate Ctrl+End encoding `[1;4~` is misparsed by
  // Ink's keypress parser as shift+home — it lands on top, not bottom.
  // (Standard xterm sends `[1;5F`, which works. Not worth a raw-input
  // pre-route for the minority encoding.)
  app.stdin.write("\x1b[1;4~");
  await tick();
  assert.equal(top, 3);
  assert.equal(bottom, 2);
  app.unmount();
});

test("C27: SGR/X11 mouse wheel routes to onScrollBy(±3); clicks are swallowed", async () => {
  const calls: number[] = [];
  const chars: string[] = [];
  const app = makeApp(makeInitialState("m"), {
    onScrollBy: (d: number) => calls.push(d),
    onChar: (ch: string) => chars.push(ch),
  });
  app.stdin.write("\x1b[<64;10;20M"); // SGR wheel up
  await tick();
  app.stdin.write("\x1b[<65;10;20M"); // SGR wheel down
  await tick();
  app.stdin.write("\x1b[<62;3;7M"); // X11 wheel up
  await tick();
  app.stdin.write("\x1b[<63;3;7M"); // X11 wheel down
  await tick();
  app.stdin.write("\x1b[<0;10;20M"); // left click — must NOT be typed
  await tick();
  app.stdin.write("\x1b[<64;10;20m"); // wheel release — must NOT double-scroll
  await tick();
  assert.deepEqual(calls, [3, -3, 3, -3]);
  assert.deepEqual(chars, [], "mouse SGR sequences never land in the input");
  app.unmount();
});

test("C27: scroll keys are ignored while an approval is pending", async () => {
  const calls: number[] = [];
  let answered: boolean | null = null;
  const s = setApproval(makeInitialState("m"), "run rm -rf / ?", () => {});
  const app = makeApp(s, {
    onScrollBy: (d: number) => calls.push(d),
    onScrollToTop: () => calls.push(-1e9),
    onScrollToBottom: () => calls.push(1e9),
    onApproval: (ok: boolean) => {
      answered = ok;
    },
  });
  app.stdin.write("\x1b[5~");
  await tick();
  app.stdin.write("\x1b[H");
  await tick();
  assert.deepEqual(calls, [], "scrolling is locked while approving");
  app.stdin.write("n\r");
  await tick();
  assert.equal(answered, false, "approval keys still work");
  app.unmount();
});

test("C28: pinned frame shows older items, clipped straddlers, and the scroll status", () => {
  // Test terminal: width 100, rows 24 → item budget 16. 10 items of 200
  // chars each: C31 hanging indent at width−2=98 → 3 lines; the first
  // renders 3 (no separator), the rest 4 (leading blank) = 39 lines total,
  // maxScroll 23.
  const items: TuiItem[] = Array.from({ length: 10 }, (_, i) => ({
    kind: "user",
    text: `item-${i} ` + "x".repeat(192),
  }));
  const state = { ...makeInitialState("m"), items, viewTop: 1 }; // window [1,17)
  const app = makeApp(state);
  const frame = app.lastFrame() ?? "";
  // item-0 straddles the top edge: its FIRST line is above the window —
  // only its 2nd/3rd lines (clipped x-runs) may appear, never the "item-0"
  // label. item-4 straddles the bottom edge: its "item-4" label shows
  // (line 0 is inside); item-5 starts at the bottom edge → excluded.
  assert.doesNotMatch(frame, /item-0/);
  assert.match(frame, /item-1/);
  assert.match(frame, /item-4/);
  assert.doesNotMatch(frame, /item-5/);
  // The hint line carries the scroll status (22 rows above the bottom).
  assert.match(frame, /↑22\/23 scrolled/);
  assert.doesNotMatch(frame, /enter send ·/);
  app.unmount();
});

test("hint: the wheel is named only when mouse tracking is enabled (TRE_MOUSE)", () => {
  // The driver enables mouse tracking only when TRE_MOUSE is set (run.tsx);
  // the hint must not promise a wheel that the terminal never forwards.
  // Selection is the default — no mouse mode — so the default hint omits it.
  // 10 items of 200 chars = 39 content lines > the 16-row item budget
  // (same geometry as the C28 test: maxScroll 23).
  const items: TuiItem[] = Array.from({ length: 10 }, (_, i) => ({
    kind: "user",
    text: `item-${i} ` + "x".repeat(192),
  }));
  const prev = process.env.TRE_MOUSE;
  try {
    delete process.env.TRE_MOUSE;
    const idle = makeApp(makeInitialState("m"));
    const idleFrame = idle.lastFrame() ?? "";
    assert.match(idleFrame, /enter send · PgUp\/PgDn scroll ·/);
    assert.doesNotMatch(idleFrame, /wheel/);
    idle.unmount();

    const scrolled = makeApp({ ...makeInitialState("m"), items, viewTop: 1 });
    const scrolledFrame = scrolled.lastFrame() ?? "";
    assert.match(scrolledFrame, /scrolled — PgDn ↓ to bottom/);
    assert.doesNotMatch(scrolledFrame, /wheel/);
    scrolled.unmount();

    process.env.TRE_MOUSE = "1";
    const idle2 = makeApp(makeInitialState("m"));
    assert.match(idle2.lastFrame() ?? "", /enter send · PgUp\/PgDn\/wheel scroll ·/);
    idle2.unmount();

    const scrolled2 = makeApp({ ...makeInitialState("m"), items, viewTop: 1 });
    assert.match(scrolled2.lastFrame() ?? "", /scrolled — PgDn\/wheel ↓ to bottom/);
    scrolled2.unmount();
  } finally {
    if (prev === undefined) delete process.env.TRE_MOUSE;
    else process.env.TRE_MOUSE = prev;
  }
});
