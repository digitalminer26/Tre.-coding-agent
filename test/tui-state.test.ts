/**
 * WS10 — unit tests for the pure TUI state machine (applyEvent + input).
 * Events are the same AgentEvent stream the plain CLI prints.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AgentEvent,
  AssistantMessage,
  ContentBlock,
  ToolResultMessage,
} from "../src/types.js";
import {
  approvalAnswer,
  applyEvent,
  inputBackspace,
  inputChar,
  inputHistory,
  makeInitialState,
  noteError,
  pushUser,
  setApproval,
  submitInput,
  type TuiItem,
  type TuiState,
} from "../src/tui/state.js";

// ── fixtures ────────────────────────────────────────────────────────────────
const asst = (content: ContentBlock[] = [], extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: "assistant",
  content,
  model: "m",
  provider: "p",
  stopReason: "stop",
  timestamp: 0,
  ...extra,
});
const tres = (toolCallId: string, text: string, isError = false, name = "x"): ToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: name,
  content: [{ type: "text", text }],
  isError,
  timestamp: 0,
});
const startEv = (): AgentEvent => ({ type: "start", partial: asst() });
const deltaEv = (delta: string): AgentEvent => ({ type: "text_delta", delta, partial: asst() });
const doneEv = (content: ContentBlock[] = [], extra: Partial<AssistantMessage> = {}): AgentEvent => ({
  type: "done",
  message: asst(content, extra),
});
const toolStart = (id: string, name: string, args: Record<string, unknown>): AgentEvent => ({
  type: "tool_execution_start",
  toolCall: { type: "toolCall", id, name, arguments: args },
});
const toolEnd = (id: string, text: string, isError = false, name = "x"): AgentEvent => ({
  type: "tool_execution_end",
  toolCallId: id,
  result: tres(id, text, isError, name),
});

type ToolItem = Extract<TuiItem, { kind: "tool" }>;
type AsstItem = Extract<TuiItem, { kind: "assistant" }>;
const asTool = (it: TuiItem): ToolItem => (it.kind === "tool" ? it : assert.fail("expected tool item"));
const asAsst = (it: TuiItem): AsstItem => (it.kind === "assistant" ? it : assert.fail("expected assistant item"));

const fold = (events: AgentEvent[], s0 = makeInitialState("test-model")): TuiState =>
  events.reduce((s, ev) => applyEvent(s, ev), s0);

test("streaming: start → text_deltas → done accumulate one assistant item", () => {
  const s = fold([
    { type: "agent_start" },
    { type: "turn_start", turn: 1 },
    startEv(),
    deltaEv("Hel"),
    deltaEv("lo"),
    doneEv([{ type: "text", text: "Hello" }]),
  ]);
  assert.equal(s.items.length, 1);
  assert.equal(asAsst(s.items[0]!).text, "Hello");
  assert.equal(asAsst(s.items[0]!).streaming, false);
  assert.equal(s.turn, 1);
  assert.equal(s.busy, true); // agent_end not seen yet
});

test("streaming: second assistant message after a tool round-trip is a new item", () => {
  const s = fold([
    startEv(),
    deltaEv("calling"),
    doneEv(),
    startEv(),
    deltaEv("done!"),
    doneEv(),
  ]);
  assert.equal(s.items.length, 2);
  assert.equal(asAsst(s.items[0]!).text, "calling");
  assert.equal(asAsst(s.items[1]!).text, "done!");
});

test("thinking_delta shows a live hint, dropped on done", () => {
  const s = fold([startEv(), { type: "thinking_delta", delta: "hmm", partial: asst() }]);
  assert.equal(asAsst(s.items[0]!).thinking, true);
  assert.equal(asAsst(s.items[0]!).text, "");
  const done = applyEvent(s, doneEv([{ type: "text", text: "ok" }]));
  assert.equal(asAsst(done.items[0]!).thinking, false);
});

test("tool: start shows args; end matches by id (order-independent) with isError", () => {
  const s = fold([
    toolStart("id-1", "bash", { command: "ls" }),
    toolStart("id-2", "read", { path: "a.txt" }),
    toolEnd("id-2", "file body", false, "read"),
    toolEnd("id-1", "oops boom", true, "bash"),
  ]);
  // D19: the SUCCEEDED quiet tool (read) is dropped; only the bash line stays
  const tools = s.items.filter((i) => i.kind === "tool");
  assert.equal(tools.length, 1);
  const t1 = asTool(tools[0]!);
  assert.equal(t1.name, "bash");
  assert.equal(t1.running, false);
  assert.equal(t1.isError, true);
  assert.equal(t1.resultText, "oops boom");
});

test("tool: D19 quiet file tools — hidden mid-flight, dropped on success, unhidden on denial", () => {
  // Mid-flight: the placeholder exists but is hidden (height-0)
  const mid = fold([toolStart("r1", "read", { path: "a.txt" })]);
  assert.equal(mid.items.length, 1);
  assert.equal(asTool(mid.items[0]!).hidden, true);
  // Success → the item is dropped entirely (no line at all)
  const ok = applyEvent(mid, toolEnd("r1", "file body", false, "read"));
  assert.equal(ok.items.length, 0);
  // Denial → the item is unhidden with isError + the reason
  const denied = fold([
    toolStart("r2", "read", { path: "/etc/passwd" }),
    toolEnd("r2", 'path "/etc/passwd" resolves outside the workspace', true, "read"),
  ]);
  const t = asTool(denied.items[0]!);
  assert.equal(t.hidden, false);
  assert.equal(t.isError, true);
  assert.match(t.resultText!, /outside the workspace/);
  // write follows the same contract; bash (not quiet) stays visible
  const mixed = fold([
    toolStart("w1", "write", { path: "b.txt" }),
    toolStart("b1", "bash", { command: "ls" }),
    toolEnd("w1", "ok", false, "write"),
    toolEnd("b1", "a b", false, "bash"),
  ]);
  const tools = mixed.items.filter((i) => i.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(asTool(tools[0]!).name, "bash");
});

test("tool: D19 quiet edit — no diff computed, success dropped, denial shown", () => {
  const mid = fold([toolStart("e1", "edit", { path: "a.txt", oldText: "x = 1", newText: "x = 2" })]);
  assert.equal(asTool(mid.items[0]!).diff, undefined); // hidden → no diff work
  assert.equal(asTool(mid.items[0]!).hidden, true);
  const ok = applyEvent(mid, toolEnd("e1", "ok", false, "edit"));
  assert.equal(ok.items.length, 0);
  const denied = fold([
    toolStart("e2", "edit", { path: "/etc/a.txt", oldText: "x", newText: "y" }),
    toolEnd("e2", "denied: outside the workspace", true, "edit"),
  ]);
  const t = asTool(denied.items[0]!);
  assert.equal(t.hidden, false);
  assert.equal(t.isError, true);
  assert.equal(t.diff, undefined);
});

test("tool: update carries a live preview line, cleared by end", () => {
  let s = fold([toolStart("u1", "bash", { command: "long" })]);
  s = applyEvent(s, { type: "tool_execution_update", toolCallId: "u1", text: "partial output" });
  assert.equal(asTool(s.items[0]!).resultText, "partial output");
  s = applyEvent(s, toolEnd("u1", "final"));
  const t = asTool(s.items[0]!);
  assert.equal(t.resultText, "final");
  assert.equal(t.running, false);
});

test("tool: non-quiet (bash) calls still render normally, no diff", () => {
  const s = fold([toolStart("b1", "bash", { command: "ls" })]);
  assert.equal(asTool(s.items[0]!).diff, undefined);
  assert.equal(asTool(s.items[0]!).hidden, undefined);
});

test("context_compacted appends a compaction item", () => {
  const s = fold([{ type: "context_compacted", tokensBefore: 25341, messagesKept: 4, summaryChars: 809 }]);
  assert.equal(s.items[0]!.kind, "compaction");
});

test("agent_end: error/aborted/length become error items; busy + approval clear", () => {
  const withApproval = setApproval(makeInitialState("m"), "allow?", () => {});
  const cases: Array<[AgentEvent, string]> = [
    [
      {
        type: "agent_end",
        stopReason: "error",
        messages: [asst([], { stopReason: "error", errorMessage: "boom" })],
      },
      "boom",
    ],
    [
      { type: "agent_end", stopReason: "error", messages: [] },
      "provider error",
    ],
    [{ type: "agent_end", stopReason: "aborted", messages: [] }, "aborted"],
    [{ type: "agent_end", stopReason: "length", messages: [] }, "length"],
  ];
  for (const [ev, msg] of cases) {
    const s = applyEvent(withApproval, ev);
    const last = s.items[s.items.length - 1]!;
    assert.equal(last.kind, "error");
    assert.ok(last.kind === "error" && last.text.includes(msg), `expected ${msg} in ${last.text}`);
    assert.equal(s.busy, false);
    assert.equal(s.approval, null);
  }
});

test("agent_end: stop adds no noise and clears busy", () => {
  const s0 = fold([{ type: "agent_start" }]);
  const ok = applyEvent(s0, { type: "agent_end", stopReason: "stop", messages: [] });
  assert.equal(ok.items.length, 0);
  assert.equal(ok.busy, false);
});

test("input: char/backspace edit the line", () => {
  let s = inputChar(makeInitialState("m"), "h");
  s = inputChar(s, "i");
  assert.equal(s.input, "hi");
  s = inputBackspace(s);
  assert.equal(s.input, "h");
});

test("input: submit trims, appends history, marks busy; empty/busy/approving → null", () => {
  const s = inputChar(makeInitialState("m"), "  hi  ");
  const r = submitInput(s);
  assert.notEqual(r, null);
  assert.equal(r!.prompt, "hi");
  assert.equal(r!.state.input, "");
  assert.deepEqual(r!.state.history, ["hi"]);
  assert.equal(r!.state.busy, true);

  assert.equal(submitInput(makeInitialState("m")), null); // empty line
  assert.equal(submitInput({ ...s, busy: true }), null); // busy
  assert.equal(submitInput(setApproval(s, "q", () => {})), null); // approving
});

test("input: history navigation walks up to the top and back down to a fresh line", () => {
  let s: TuiState = { ...makeInitialState("m"), history: ["a", "b", "c"] };
  s = inputHistory(s, -1);
  assert.equal(s.input, "c");
  s = inputHistory(s, -1);
  assert.equal(s.input, "b");
  s = inputHistory(s, -1);
  assert.equal(s.input, "a");
  s = inputHistory(s, -1); // past the top → fresh empty line
  assert.equal(s.input, "");
  assert.equal(s.historyIdx, null);
  s = inputHistory(s, 1); // nothing newer than the fresh line
  assert.equal(s.input, "");
  s = inputHistory(s, -1);
  s = inputHistory(s, 1); // back down to the newest
  assert.equal(s.input, "c");
  s = inputHistory(s, 1); // at the newest, down stays
  assert.equal(s.input, "c");
});

test("input: history with no entries is a no-op", () => {
  const s = makeInitialState("m");
  assert.equal(inputHistory(s, -1), s);
  assert.equal(inputHistory(s, 1), s);
});

test("input: chars are locked while an approval is pending", () => {
  const s = setApproval(makeInitialState("m"), "allow?", () => {});
  assert.equal(inputChar(s, "x"), s);
  assert.equal(inputBackspace(s), s);
});

test("approval: answer resolves the promise and clears state", () => {
  let resolved: boolean | undefined;
  const s = setApproval(makeInitialState("m"), "allow?", (ok) => {
    resolved = ok;
  });
  const afterYes = approvalAnswer(s, true);
  assert.equal(resolved, true);
  assert.equal(afterYes.approval, null);
  assert.equal(approvalAnswer(makeInitialState("m"), false).approval, null); // no pending → no-op
});

test("items: pushUser / noteError append without mutating the prior state", () => {
  const s = makeInitialState("m");
  const u = pushUser(s, "hello");
  assert.equal(u.items.length, 1);
  assert.equal(s.items.length, 0);
  const e = noteError(u, "nope");
  assert.equal(e.items.length, 2);
  assert.equal(u.items.length, 1);
});

test("applyEvent: unknown/ignorable events are a no-op", () => {
  const s = makeInitialState("m");
  assert.equal(applyEvent(s, { type: "turn_end", turn: 2 }), s);
  const withTool = fold([toolStart("z", "bash", { command: "x" })]);
  // toolcall_* stream fragments are ignored by the TUI
  assert.equal(
    applyEvent(withTool, { type: "toolcall_start", index: 0, partial: asst() }),
    withTool,
  );
});
