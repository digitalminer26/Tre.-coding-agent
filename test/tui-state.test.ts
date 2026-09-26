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
  bottomLineColors,
  compactThreshold,
  contextBreakdown,
  contextReport,
  contextUrgencyColor,
  handleSlashCommand,
  inputBackspace,
  inputChar,
  inputHistory,
  makeInitialState,
  noteError,
  pushUser,
  scrollBy,
  scrollToBottom,
  scrollToTop,
  setApproval,
  statsLine,
  steerInput,
  submitInput,
  submitSlashBusy,
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

test("thinking_delta accumulates the reasoning text; the live flag drops on done but the text stays", () => {
  const s = fold([
    startEv(),
    { type: "thinking_delta", delta: "hmm", partial: asst() },
    { type: "thinking_delta", delta: ", let me check", partial: asst() },
  ]);
  assert.equal(asAsst(s.items[0]!).thinking, true);
  assert.equal(asAsst(s.items[0]!).thinkingText, "hmm, let me check");
  assert.equal(asAsst(s.items[0]!).text, "");
  // the reply then streams in (text_delta), and done closes the item
  const s2 = applyEvent(s, deltaEv("ok"));
  assert.equal(asAsst(s2.items[0]!).text, "ok");
  const done = applyEvent(s2, doneEv([{ type: "text", text: "ok" }]));
  assert.equal(asAsst(done.items[0]!).thinking, false);
  assert.equal(asAsst(done.items[0]!).thinkingText, "hmm, let me check");
  assert.equal(asAsst(done.items[0]!).text, "ok");
});

test("thinking_delta before any assistant item opens a streaming item with the text", () => {
  const s = fold([{ type: "thinking_delta", delta: "first", partial: asst() }]);
  assert.equal(s.items.length, 1);
  assert.equal(asAsst(s.items[0]!).thinking, true);
  assert.equal(asAsst(s.items[0]!).thinkingText, "first");
  assert.equal(asAsst(s.items[0]!).streaming, true);
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

test("contextTokens: tracks the last done usage; compaction resets to the new estimate", () => {
  // No usage yet → 0 (the `context` field shows the window, "no usage yet").
  const s0 = makeInitialState("m", {}, 131072, 32768);
  assert.equal(s0.contextTokens, 0);
  assert.equal(s0.contextWindow, 131072);
  assert.equal(s0.maxTokens, 32768);

  // done with usage → the last call's totalTokens (prompt+completion).
  const s1 = fold(
    [
      { type: "agent_start" },
      startEv(),
      deltaEv("hi"),
      doneEv([{ type: "text", text: "hi" }], { usage: { input: 20000, output: 5341, totalTokens: 25341 } }),
    ],
    s0,
  );
  assert.equal(s1.contextTokens, 25341);
  assert.equal(s1.totalTokens, 25341);

  // done WITHOUT usage (some endpoints) → keeps the previous estimate.
  const s2 = fold([doneEv([{ type: "text", text: "again" }])], s1);
  assert.equal(s2.contextTokens, 25341);

  // compaction → the event's estimate of the new [summary, …kept] context.
  const s3 = fold(
    [{ type: "context_compacted", tokensBefore: 25341, messagesKept: 4, summaryChars: 809, contextTokens: 9600 }],
    s2,
  );
  assert.equal(s3.contextTokens, 9600);
  assert.equal(s3.items[s3.items.length - 1]!.kind, "compaction");

  // a compaction event WITHOUT contextTokens (older emitter) → keeps the
  // last usage-based estimate rather than going blank.
  const s4 = fold(
    [{ type: "context_compacted", tokensBefore: 25341, messagesKept: 4, summaryChars: 809 }],
    s2,
  );
  assert.equal(s4.contextTokens, 25341);
});

// ── context breakdown: where the tokens come from + when compaction fires ──

test("compactThreshold = window − maxTokens − slack (the real shouldCompact trigger)", () => {
  assert.equal(compactThreshold(131072, 32768), 131072 - 32768 - 1024); // 97280
  assert.equal(compactThreshold(131072, 0), 131072 - 1024);
  assert.equal(compactThreshold(0, 32768), 0); // unknown window → 0
  assert.equal(compactThreshold(100, 32768), 0); // window < max → 0 (never compact)
});

test("contextBreakdown: system / summary / messages split; headroom vs the trigger", () => {
  // window 131072, maxTokens 32768 → threshold 97280. system 5000, summary 0,
  // total 25000 → messages = 25000 − 5000 = 20000, headroom = 97280 − 25000.
  const s = { ...makeInitialState("m", {}, 131072, 32768, [], 5000), contextTokens: 25000 };
  const bd = contextBreakdown(s);
  assert.deepEqual(
    { system: bd.system, summary: bd.summary, messages: bd.messages, total: bd.total },
    { system: 5000, summary: 0, messages: 20000, total: 25000 },
  );
  assert.equal(bd.threshold, 97280);
  assert.equal(bd.headroom, 97280 - 25000);

  // after a compaction the summary is a distinct bucket (summaryTokens set by
  // the context_compacted event).
  const s2 = { ...s, summaryTokens: 2000, contextTokens: 30000 };
  const bd2 = contextBreakdown(s2);
  assert.deepEqual(
    { system: bd2.system, summary: bd2.summary, messages: bd2.messages, total: bd2.total },
    { system: 5000, summary: 2000, messages: 23000, total: 30000 },
  );

  // over the trigger → negative headroom (compaction is due).
  const s3 = { ...s, contextTokens: 100000 };
  assert.ok(contextBreakdown(s3).headroom < 0);

  // unknown window (0) → threshold 0, headroom = −total (but the report
  // suppresses the compaction line when threshold is 0).
  const s4 = { ...makeInitialState("m"), contextTokens: 5000, systemPromptTokens: 1000 };
  assert.equal(contextBreakdown(s4).threshold, 0);
});

test("contextUrgencyColor: green < 70% ≤ yellow < 90% ≤ red; undefined when unknown", () => {
  const mk = (total: number): TuiState =>
    ({ ...makeInitialState("m", {}, 131072, 32768), contextTokens: total, systemPromptTokens: 0 });
  // threshold 97280. 50% → green, 75% → yellow, 95% → red.
  assert.equal(contextUrgencyColor(mk(Math.round(97280 * 0.5))), "green");
  assert.equal(contextUrgencyColor(mk(Math.round(97280 * 0.75))), "yellow");
  assert.equal(contextUrgencyColor(mk(Math.round(97280 * 0.95))), "red");
  // no usage yet → undefined (dim); unknown window → undefined.
  assert.equal(contextUrgencyColor({ ...makeInitialState("m", {}, 131072, 32768) }), undefined);
  assert.equal(contextUrgencyColor({ ...makeInitialState("m"), contextTokens: 5000 }), undefined);
});

test("contextReport: multi-line breakdown + compaction trigger (the /context body)", () => {
  // no usage yet → the window alone.
  assert.equal(
    contextReport({ ...makeInitialState("m", {}, 131072, 32768) }),
    "context: 131.1k window (no usage yet)",
  );
  // a live context: total/window + system/summary/messages + the trigger.
  const s = { ...makeInitialState("m", {}, 131072, 32768, [], 5000), contextTokens: 25000 };
  assert.equal(
    contextReport(s),
    [
      "context: 25k/131.1k (19%)",
      "  system prompt: 5k (fixed floor)",
      "  messages: 20k",
      "  compaction: at 97.3k — 72.3k headroom left",
    ].join("\n"),
  );
  // over the trigger → DUE.
  const over = { ...s, contextTokens: 100000 };
  assert.match(contextReport(over), /compaction: DUE — over the trigger by/);
});

test("handleSlashCommand: /context appends the breakdown as an info item", () => {
  const s = { ...makeInitialState("m", {}, 131072, 32768, [], 5000), contextTokens: 25000 };
  const r = handleSlashCommand(s, "/context");
  assert.equal(r.handled, true);
  const info = r.state.items[r.state.items.length - 1];
  assert.equal(info?.kind, "info");
  assert.equal((info as { text: string }).text, contextReport(s));
  // state otherwise untouched (no bottom change, no input change)
  assert.deepEqual(r.state.bottom, []);
  assert.equal(r.state.input, "");
  // unknown line still passes through
  assert.equal(handleSlashCommand(s, "/context now").handled, false);
});

test("bottomLineColors: the context line is tinted by urgency, the rest dim", () => {
  const s = {
    ...makeInitialState("m", {}, 131072, 32768, ["model", "context", "turn"]),
    contextTokens: Math.round(97280 * 0.75), // yellow zone
    systemPromptTokens: 0,
  };
  assert.deepEqual(bottomLineColors(s), [undefined, "yellow", undefined]);
  // unknown keys are skipped (mirrors bottomLines) and the rest pad to 3.
  const s2 = { ...s, bottom: ["bogus", "context"] };
  assert.deepEqual(bottomLineColors(s2), ["yellow", undefined, undefined]);
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
  // length-end wording is accurate per failure mode: with a tool call the
  // args may be truncated; without one (thinking ate the budget) it must not
  // claim a tool call was truncated.
  const noCall = applyEvent(
    makeInitialState("m"),
    {
      type: "agent_end",
      stopReason: "length",
      messages: [asst([{ type: "thinking", thinking: "..." }], { stopReason: "length" })],
    },
  );
  {
    const item = noCall.items[noCall.items.length - 1]!;
    assert.equal(item.kind, "error");
    assert.ok(item.kind === "error" && item.text.includes("before any tool call"));
  }
  const withCall = applyEvent(
    makeInitialState("m"),
    {
      type: "agent_end",
      stopReason: "length",
      messages: [
        asst(
          [
            {
              type: "toolCall",
              id: "c1",
              name: "write",
              arguments: { path: "a.txt", content: "cut" },
            },
          ],
          { stopReason: "length" },
        ),
      ],
    },
  );
  {
    const item = withCall.items[withCall.items.length - 1]!;
    assert.equal(item.kind, "error");
    assert.ok(item.kind === "error" && item.text.includes("tool-call arguments may be truncated"));
  }
  for (const [ev, msg] of cases) {
    const s = applyEvent(withApproval, ev);
    const last = s.items[s.items.length - 1]!;
    assert.equal(last.kind, "error");
    assert.ok(last.kind === "error" && last.text.includes(msg), `expected ${msg} in ${last.text}`);
    assert.equal(s.busy, false);
    assert.equal(s.approval, null);
  }
});

test("agent_end: budget → error item, busy + approval clear, TUI stays usable", () => {
  const withApproval = setApproval(makeInitialState("m"), "allow?", () => {});
  const s = applyEvent(
    { ...withApproval, busy: true },
    { type: "agent_end", stopReason: "budget", maxTurns: 4, messages: [] },
  );
  const last = s.items[s.items.length - 1]!;
  assert.equal(last.kind, "error");
  const text = last.kind === "error" ? last.text : "<not an error item>";
  assert.match(text, /budget: max 4 turns reached/);
  assert.match(text, /send another prompt to continue/);
  assert.equal(s.busy, false);
  assert.equal(s.approval, null);
  // The TUI stays usable: a fresh prompt can be submitted (a NEW run,
  // whose cap resets).
  const r = submitInput({ ...s, input: "keep going" });
  assert.notEqual(r, null);
  assert.equal(r!.prompt, "keep going");

  // No maxTurns on the event → the number is omitted, the note still lands.
  const s2 = applyEvent(makeInitialState("m"), {
    type: "agent_end",
    stopReason: "budget",
    messages: [],
  });
  const last2 = s2.items[s2.items.length - 1]!;
  assert.equal(last2.kind, "error");
  const text2 = last2.kind === "error" ? last2.text : "<not an error item>";
  assert.match(text2, /^budget: turns reached/);
  assert.equal(s2.busy, false);

  // C26: with maxCycles the note names both dimensions (max N turns × M
  // cycles) — the loop auto-continued per cycle before this final stop.
  const s3 = applyEvent(makeInitialState("m"), {
    type: "agent_end",
    stopReason: "budget",
    maxTurns: 64,
    maxCycles: 4,
    messages: [],
  });
  const last3 = s3.items[s3.items.length - 1]!;
  assert.equal(last3.kind, "error");
  const text3 = last3.kind === "error" ? last3.text : "<not an error item>";
  assert.match(text3, /budget: max 64 turns × 4 cycles reached/);
});

test("agent_end: loop → error item explaining the runaway stop (C26)", () => {
  const s = applyEvent(
    { ...makeInitialState("m"), busy: true },
    { type: "agent_end", stopReason: "loop", messages: [] },
  );
  const last = s.items[s.items.length - 1]!;
  assert.equal(last.kind, "error");
  const text = last.kind === "error" ? last.text : "<not an error item>";
  assert.match(text, /loop: the model repeated the same tool call\(s\) 3 times in a row/);
  assert.match(text, /send another prompt to continue/);
  assert.equal(s.busy, false);
});

test("turn_budget → info item, run stays busy (C26 auto-continue)", () => {
  const s = applyEvent(
    { ...makeInitialState("m"), busy: true },
    { type: "turn_budget", turn: 64, cycle: 1, maxCycles: 4, maxTurns: 64 },
  );
  const last = s.items[s.items.length - 1]!;
  assert.equal(last.kind, "info", "a continuation is informational, not an error");
  const text = last.kind === "info" ? last.text : "<not an info item>";
  assert.match(text, /turn budget \(64\) reached — continuing \(cycle 1\/4\)/);
  assert.equal(s.busy, true, "the run continues — still busy");
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

test("steerInput: busy + non-slash line → user item appended, input cleared, still busy", () => {
  const s = { ...makeInitialState("m"), busy: true, input: "fix the bug" };
  const r = steerInput(s, "fix the bug");
  assert.notEqual(r, null);
  assert.equal(r!.text, "fix the bug");
  assert.equal(r!.state.input, "");
  assert.equal(r!.state.cursorPos, 0);
  assert.equal(r!.state.busy, true, "steering does not end the run");
  assert.deepEqual(r!.state.history, ["fix the bug"]);
  assert.equal(r!.state.items.length, 1);
  assert.deepEqual(r!.state.items[0], { kind: "user", text: "fix the bug" });
});

test("steerInput: idle → null (a fresh prompt is a run, not a steer)", () => {
  const s = { ...makeInitialState("m"), busy: false, input: "hello" };
  assert.equal(steerInput(s, "hello"), null);
});

test("steerInput: empty or slash line → null (the driver owns /quit-abort)", () => {
  const busy = { ...makeInitialState("m"), busy: true };
  assert.equal(steerInput(busy, ""), null);
  assert.equal(steerInput(busy, "   "), null);
  assert.equal(steerInput(busy, "/quit"), null);
  assert.equal(steerInput(busy, "/stats"), null);
});

test("steerInput: approving → null (input is locked)", () => {
  const s = setApproval({ ...makeInitialState("m"), busy: true }, "allow?", () => {});
  assert.equal(steerInput(s, "go"), null);
});

test("applyEvent: steer is a no-op (the user item was pushed at submit time)", () => {
  const s = { ...makeInitialState("m"), busy: true, items: [{ kind: "user" as const, text: "fix the bug" }] };
  const r = applyEvent(s, { type: "steer", turn: 2, text: "fix the bug" });
  assert.equal(r, s, "no new item — no double-add");
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

// ─────────────────────── C28: output scrollback (content-anchored viewport) ───────────────────────
// viewTop = the content row at the viewport's top edge (null = follow).
// Pure transitions here; the row math (clipping, pinning) is pinned in
// tui-pinned-layout.test.ts.

test("C28: scrollBy pins the view in CONTENT space (no drift on growth)", () => {
  const s = makeInitialState("m"); // viewTop null = follow
  const up = scrollBy(s, 3, 100); // 3 rows up from the bottom
  assert.equal(up.viewTop, 97);
  assert.equal(scrollBy(up, 4, 100).viewTop, 93, "scrolling up moves the pinned top");
  // Content appended (maxScroll 100 → 120): the pinned view stays put —
  // the C27 "rows above bottom" offset would have slid here.
  assert.equal(scrollBy(up, 0, 120).viewTop, 97, "no drift as output appends");
  // Scrolling back to the bottom resumes following.
  assert.equal(scrollBy(up, -20, 100).viewTop, null, "reaching the bottom follows again");
  // Clamped at the top of the content.
  assert.equal(scrollBy(s, 500, 100).viewTop, 0);
  // Content shrank to the bottom (compaction): a stale pin resolves to follow.
  assert.equal(scrollBy({ ...s, viewTop: 42 }, 0, 10).viewTop, null);
});

test("C28: scrollBy returns the SAME state on a no-op (no rerender churn)", () => {
  const s = makeInitialState("m");
  assert.equal(scrollBy(s, -5, 100), s, "scrolling down at the bottom is a no-op");
  assert.equal(scrollBy(s, 0, 100), s);
  const pinned = { ...s, viewTop: 42 };
  assert.equal(scrollBy(pinned, 0, 100), pinned);
  assert.equal(scrollToBottom(s), s, "already following");
});

test("C28: scrollToBottom resumes following; scrollToTop pins content row 0", () => {
  const s = { ...makeInitialState("m"), viewTop: 42 };
  assert.equal(scrollToBottom(s).viewTop, null);
  const top = scrollToTop(s);
  assert.equal(top.viewTop, 0);
  assert.equal(scrollToTop(top), top, "idempotent");
});

test("C28: submitting a prompt follows the bottom again", () => {
  const s = { ...makeInitialState("m"), input: "do the thing", viewTop: 30 };
  const r = submitInput(s);
  assert.ok(r !== null);
  assert.equal(r.state.viewTop, null, "fresh run's output is at the bottom");
  assert.equal(r.state.busy, true);
});

test("C28: a new run (agent_start) follows the bottom; pinned view stays frozen", () => {
  const s = { ...makeInitialState("m"), viewTop: 12, busy: true };
  assert.equal(applyEvent(s, { type: "agent_start" }).viewTop, null, "agent_start → follow");
  // New output while pinned does NOT move the view (frozen window).
  const frozen = applyEvent(s, { type: "text_delta", delta: "more output", partial: asst() });
  assert.equal(frozen.viewTop, 12, "output lands below the window");
});

test("C28: makeInitialState starts following the bottom (viewTop null)", () => {
  assert.equal(makeInitialState("m").viewTop, null);
});

test("C32: makeInitialState seeds bottom from the persisted config", () => {
  assert.deepEqual(makeInitialState("m").bottom, [], "default: empty selection");
  assert.deepEqual(
    makeInitialState("m", {}, 0, 0, ["model", "context"]).bottom,
    ["model", "context"],
    "the driver passes the loaded config's bottom through",
  );
});

// ── /stats: tool-call tally + the pure stats line ─────────────────────────

test("applyEvent: tool_execution_start increments toolCalls (quiet tools too)", () => {
  let s = makeInitialState("m");
  assert.equal(s.toolCalls, 0);
  s = applyEvent(s, toolStart("1", "bash", { command: "ls" }));
  assert.equal(s.toolCalls, 1);
  // quiet file-access tools start as hidden placeholders — still counted
  s = applyEvent(s, toolStart("2", "read", { path: "a.txt" }));
  assert.equal(s.toolCalls, 2);
  s = applyEvent(s, toolEnd("1", "ok"));
  s = applyEvent(s, toolEnd("2", "ok"));
  assert.equal(s.toolCalls, 2, "tool_execution_end does not change the count");
  s = applyEvent(s, { type: "agent_end", stopReason: "stop", messages: [] });
  assert.equal(s.toolCalls, 2, "agent_end does not reset the count");
});

test("statsLine: one line with turns, tokens, tool calls, session size", () => {
  const base = makeInitialState("m");
  // no session path → "—"; unknown size → "?"
  assert.equal(
    statsLine(base),
    "stats: 0 turn(s), 0 tokens, 0 tool call(s), session: —",
  );
  const withVals = { ...base, turn: 3, totalTokens: 12345, toolCalls: 7, info: { session: "/tmp/s.jsonl" } };
  assert.equal(
    statsLine(withVals, 4321),
    "stats: 3 turn(s), 12345 tokens, 7 tool call(s), session: /tmp/s.jsonl (4321 bytes)",
  );
  // session path set, size unknown (missing/unreadable file) → "?"
  const noSize = { ...withVals, info: { session: "/tmp/missing.jsonl" } };
  assert.equal(
    statsLine(noSize),
    "stats: 3 turn(s), 12345 tokens, 7 tool call(s), session: /tmp/missing.jsonl (? bytes)",
  );
  // size 0 is a real value, not unknown
  const zero = { ...noSize, info: { session: "/tmp/empty.jsonl" } };
  assert.equal(
    statsLine(zero, 0),
    "stats: 3 turn(s), 12345 tokens, 7 tool call(s), session: /tmp/empty.jsonl (0 bytes)",
  );
});

test("C32: submitSlashBusy — busy + slash line clears the line, never steers", () => {
  const s = { ...makeInitialState("m"), busy: true, input: "/display-bottom model" };
  const r = submitSlashBusy(s);
  assert.notEqual(r, null);
  assert.equal(r!.line, "/display-bottom model");
  assert.equal(r!.state.input, "", "the line is cleared");
  assert.equal(r!.state.cursorPos, 0);
  assert.equal(r!.state.busy, true, "busy is untouched — the run continues");
  assert.deepEqual(r!.state.history, ["/display-bottom model"], "kept for ↑ navigation");
  assert.equal(r!.state.items.length, 0, "no user item — a slash line is NOT a steer");
  // idle → null (fresh prompts take submitInput's path)
  assert.equal(submitSlashBusy({ ...makeInitialState("m"), input: "/stats" }), null);
  // empty / non-slash → null (steering's path)
  assert.equal(submitSlashBusy({ ...makeInitialState("m"), busy: true, input: "   " }), null);
  assert.equal(submitSlashBusy({ ...makeInitialState("m"), busy: true, input: "fix it" }), null);
  // approving → null (input is locked)
  assert.equal(submitSlashBusy(setApproval({ ...makeInitialState("m"), busy: true }, "q?", () => {})), null);
});

test("C32: busy slash submit = submitSlashBusy + handleSlashCommand (the driver's route)", () => {
  const cleared = submitSlashBusy({ ...makeInitialState("m"), busy: true, input: "/display-bottom model" })!;
  const r = handleSlashCommand(cleared.state, cleared.line);
  assert.equal(r.handled, true);
  assert.deepEqual(r.state.bottom, ["model"]);
  assert.equal(r.state.busy, true, "the handler never touches busy — the run continues");
  assert.equal(r.state.input, "");
  assert.equal(r.state.items.length, 1);
  assert.equal((r.state.items[0] as { kind: string }).kind, "info", "the feedback lands as an info item");
  // An unhandled line (a typo) is left alone — the driver keeps the cleared
  // state and swallows the line (as before C32).
  const cleared2 = submitSlashBusy({ ...makeInitialState("m"), busy: true, input: "/nope" })!;
  const r2 = handleSlashCommand(cleared2.state, cleared2.line);
  assert.equal(r2.handled, false);
  assert.equal(r2.state, cleared2.state, "unhandled: the state is returned untouched");
});

test("handleSlashCommand: /stats appends one info line and touches nothing else", () => {
  const s = {
    ...makeInitialState("m", { session: "/tmp/s.jsonl" }),
    turn: 2,
    totalTokens: 99,
    toolCalls: 4,
    input: "left alone",
  };
  const r = handleSlashCommand(s, "/stats", 42);
  assert.equal(r.handled, true);
  assert.equal(r.state.items.length, s.items.length + 1, "exactly one item appended");
  const info = r.state.items[r.state.items.length - 1];
  assert.equal(info?.kind, "info");
  assert.equal(
    (info as { text: string }).text,
    "stats: 2 turn(s), 99 tokens, 4 tool call(s), session: /tmp/s.jsonl (42 bytes)",
  );
  // the rest of the state is untouched
  assert.equal(r.state.input, "left alone");
  assert.deepEqual(r.state.bottom, []);
  assert.equal(r.state.toolCalls, 4);
});
