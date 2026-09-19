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
    { kind: "assistant", text: "On it.", streaming: false, thinking: false },
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
    items: [{ kind: "assistant", text: "partial", streaming: true, thinking: false } as TuiItem],
  };
  const app = makeApp(state);
  assert.match(app.lastFrame() ?? "", /working…/);
  assert.match(app.lastFrame() ?? "", /partial▍/);
  app.unmount();
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
