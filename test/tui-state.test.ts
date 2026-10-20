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
  SubtaskInfo,
  ToolResultMessage,
  UserMessage,
} from "../src/types.js";
import { SUMMARY_MARKER } from "../src/context/compact.js";
import {
  approvalAnswer,
  applyEvent,
  applyModelSwitch,
  bottomFieldsClose,
  bottomFieldsConfirm,
  bottomFieldsMenu,
  bottomFieldsNav,
  bottomFieldsOpen,
  bottomFieldsToggle,
  bottomLineColors,
  bottomLines,
  bottomValue,
  BOTTOM_FIELDS,
  compactThreshold,
  computeMsgSplit,
  contextBreakdown,
  contextReport,
  contextUrgencyColor,
  handleSlashCommand,
  inputBackspace,
  inputChar,
  inputHistory,
  inputMove,
  makeInitialState,
  modelPickerClose,
  modelPickerConfirm,
  modelPickerInitialIndex,
  modelPickerMenu,
  modelPickerNav,
  modelPickerOpen,
  modelsListReport,
  noteError,
  pushUser,
  scrollBy,
  scrollToBottom,
  scrollToTop,
  setApproval,
  SLASH_COMMANDS,
  slashCandidates,
  statsLine,
  statsLoopGuardLine,
  steerInput,
  submitInput,
  submitSlashBusy,
  subtaskStatusColor,
  subtasksBottomValue,
  subtasksBusyArmed,
  subtasksExpired,
  subtaskItemsSig,
  subtasksLineAnsi,
  subtasksPollTick,
  type SubtasksPollTick,
  formatElapsedMs,
  normalizeSubtaskList,
  type ModelOption,
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

test("unmatched quiet-tool completion preserves selection indices", () => {
  const state: TuiState = { ...makeInitialState("m"), items: [{ kind: "user", text: "hello" }], selection: { from: { itemIndex: 0, line: 0, col: 0 }, to: { itemIndex: 0, line: 0, col: 3 }, anchor: { itemIndex: 0, line: 0, col: 0 } } };
  const result = applyEvent(state, toolEnd("missing-id", "", false, "read"));
  assert.deepEqual(result.items, state.items);
  assert.deepEqual(result.selection, state.selection);
});

test("duplicate quiet-tool completion is a no-op (items and selection unchanged)", () => {
  // A SUCCEEDED quiet tool is removed on its tool_execution_end and the
  // selection is remapped; a SECOND end for the same id finds no item
  // (removed < 0) and must leave items and selection UNCHANGED.
  let s: TuiState = { ...makeInitialState("m"), items: [
    { kind: "user" as const, text: "before" },
    { kind: "tool" as const, id: "read-1", name: "read", argsText: "{}", running: true, hidden: true },
    { kind: "user" as const, text: "after" },
  ] };
  s = { ...s, selection: { from: { itemIndex: 2, line: 0, col: 0 }, to: { itemIndex: 2, line: 0, col: 3 }, anchor: { itemIndex: 2, line: 0, col: 0 } } };
  // First end: the placeholder is removed and the selection remaps (2 → 1).
  s = applyEvent(s, toolEnd("read-1", "file body", false, "read"));
  assert.equal(s.items.length, 2);
  assert.equal(s.selection?.from.itemIndex, 1);
  const afterFirst = s;
  // Second end for the SAME id: no item matches → items and selection are
  // left exactly as they were (no double-removal, no double-remap).
  const s2 = applyEvent(afterFirst, toolEnd("read-1", "file body", false, "read"));
  assert.deepEqual(s2.items, afterFirst.items);
  assert.deepEqual(s2.selection, afterFirst.selection);
});

test("tool removal remaps surviving selection anchors and clears removed-item anchors", () => {
  let s: TuiState = { ...makeInitialState("m"), items: [
    { kind: "user" as const, text: "before" },
    { kind: "tool" as const, id: "read-id", name: "read", argsText: "{}", running: true, hidden: true },
    { kind: "user" as const, text: "after" },
  ] };
  s = { ...s, selection: { from: { itemIndex: 2, line: 0, col: 0 }, to: { itemIndex: 2, line: 0, col: 2 }, anchor: { itemIndex: 2, line: 0, col: 0 } } };
  s = applyEvent(s, toolEnd("read-id", "", false, "read"));
  assert.equal(s.selection?.from.itemIndex, 1);
  const onRemoved: TuiState = { ...s, items: [s.items[0]!, { kind: "tool", id: "read-id", name: "read", argsText: "{}", running: true, hidden: true }, s.items[1]!], selection: { from: { itemIndex: 1, line: 0, col: 0 }, to: { itemIndex: 1, line: 0, col: 1 }, anchor: { itemIndex: 1, line: 0, col: 0 } } };
  assert.equal(applyEvent(onRemoved, toolEnd("read-id", "", false, "read")).selection, null);
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

test("compaction_skipped appends an info item (the TUI's sinks are nulled)", () => {
  // compactNow fires (or is forced) but nothing can be compacted; the skip is
  // surfaced as this event so the TUI — whose sinks are nulled — still shows
  // it as a note item, and the context is left untouched.
  const s = fold([{ type: "compaction_skipped", reason: "no safe shrink is possible" }]);
  const last = s.items[s.items.length - 1]!;
  assert.equal(last.kind, "info");
  if (last.kind === "info") assert.equal(last.text, "no safe shrink is possible");
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

test("compactThreshold = window − reserve − slack (the real shouldCompact trigger)", () => {
  assert.equal(compactThreshold(131072, 32768), 131072 - 32768 - 1024); // 97280
  assert.equal(compactThreshold(131072, 16384), 131072 - 16384 - 1024); // 113664 (default reserve)
  assert.equal(compactThreshold(131072, 0), 131072 - 1024);
  assert.equal(compactThreshold(0, 32768), 0); // unknown window → 0
  assert.equal(compactThreshold(100, 32768), 0); // window < reserve → 0 (never compact)
});

test("contextBreakdown: system / summary / messages split; headroom vs the trigger", () => {
  // window 131072, reserve 16384 (default — no compactionReserve set) →
  // threshold 113664. system 5000, summary 0, total 25000 →
  // messages = 25000 − 5000 = 20000, headroom = 113664 − 25000.
  const s = { ...makeInitialState("m", {}, 131072, 32768, [], 5000), contextTokens: 25000 };
  const bd = contextBreakdown(s);
  assert.deepEqual(
    { system: bd.system, summary: bd.summary, messages: bd.messages, total: bd.total },
    { system: 5000, summary: 0, messages: 20000, total: 25000 },
  );
  assert.equal(bd.threshold, 113664);
  assert.equal(bd.headroom, 113664 - 25000);

  // A LEGITIMATE zero reserve ("compact as early as possible") must be
  // preserved, NOT conflated with "unset" (the default). The displayed
  // threshold must equal compact.ts's compactionReserve(model) = 0, i.e.
  // window − 0 − slack = 130048 — NOT the default's 113664. (Audit finding A:
  // the old `> 0` fallback mis-displayed a zero reserve as the default.)
  const sZero = { ...s, compactionReserve: 0 };
  assert.equal(contextBreakdown(sZero).threshold, 131072 - 0 - 1024); // 130048
  // unset (undefined) → the default 16384, as before.
  assert.equal(contextBreakdown({ ...s, compactionReserve: undefined }).threshold, 113664);

  // after a compaction the summary is a distinct bucket (summaryTokens set by
  // the context_compacted event).
  const s2 = { ...s, summaryTokens: 2000, contextTokens: 30000 };
  const bd2 = contextBreakdown(s2);
  assert.deepEqual(
    { system: bd2.system, summary: bd2.summary, messages: bd2.messages, total: bd2.total },
    { system: 5000, summary: 2000, messages: 23000, total: 30000 },
  );

  // over the trigger → negative headroom (compaction is due).
  const s3 = { ...s, contextTokens: 120000 };
  assert.ok(contextBreakdown(s3).headroom < 0);

  // unknown window (0) → threshold 0, headroom = −total (but the report
  // suppresses the compaction line when threshold is 0).
  const s4 = { ...makeInitialState("m"), contextTokens: 5000, systemPromptTokens: 1000 };
  assert.equal(contextBreakdown(s4).threshold, 0);
});

test("contextUrgencyColor: green < 70% ≤ yellow < 90% ≤ red; undefined when unknown", () => {
  const mk = (total: number): TuiState =>
    ({ ...makeInitialState("m", {}, 131072, 32768), contextTokens: total, systemPromptTokens: 0 });
  // threshold 113664 (default reserve 16384). 50% → green, 75% → yellow, 95% → red.
  assert.equal(contextUrgencyColor(mk(Math.round(113664 * 0.5))), "green");
  assert.equal(contextUrgencyColor(mk(Math.round(113664 * 0.75))), "yellow");
  assert.equal(contextUrgencyColor(mk(Math.round(113664 * 0.95))), "red");
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
      "  compaction: at 113.7k — 88.7k headroom left",
    ].join("\n"),
  );
  // over the trigger → DUE.
  const over = { ...s, contextTokens: 120000 };
  assert.match(contextReport(over), /compaction: DUE — over the trigger by/);
});

test("docs/07 item 1: done with usage tracks lastUsage + cumulative cache; absent cache stays unknown", () => {
  const withCache = doneEv([{ type: "text", text: "a" }], {
    usage: { input: 10000, output: 100, cacheRead: 9000, cacheWrite: 500, totalTokens: 10100 },
  });
  const s1 = applyEvent(makeInitialState("m"), withCache);
  assert.deepEqual(s1.lastUsage, { input: 10000, output: 100, cacheRead: 9000, cacheWrite: 500, totalTokens: 10100 });
  assert.equal(s1.cacheReadTotal, 9000);
  assert.equal(s1.cacheWriteTotal, 500);
  // a second call accumulates the cache totals; lastUsage is replaced.
  const s2 = applyEvent(s1, doneEv([], { usage: { input: 12000, output: 200, cacheRead: 10000, totalTokens: 12200 } }));
  assert.equal(s2.cacheReadTotal, 19000);
  assert.equal(s2.cacheWriteTotal, 500); // the second call reported no write
  assert.equal(s2.lastUsage?.input, 12000);
  // an endpoint that never reports cached_tokens: the field stays ABSENT
  // (not 0) and the cumulative stays 0 — the display must not call that a
  // 0% hit rate.
  const s3 = applyEvent(makeInitialState("m"), doneEv([], { usage: { input: 500, output: 50, totalTokens: 550 } }));
  assert.equal(s3.lastUsage?.cacheRead, undefined);
  assert.equal(s3.cacheReadTotal, 0);
  // a done without usage keeps the previous lastUsage (some endpoints).
  const s4 = applyEvent(s2, doneEv());
  assert.equal(s4.lastUsage?.input, 12000);
  assert.equal(s4.cacheReadTotal, 19000);
});

test("docs/07 item 1: the `cache` bottom field shows the last call's hit rate; — when unknown", () => {
  // no usage yet → "—".
  assert.equal(bottomValue(makeInitialState("m"), "cache"), "—");
  // usage without cached_tokens → "—" (absence ≠ 0%).
  const noCache = applyEvent(makeInitialState("m"), doneEv([], { usage: { input: 500, output: 50, totalTokens: 550 } }));
  assert.equal(bottomValue(noCache, "cache"), "—");
  // a warm cache: ratio of the LAST call, compact numbers, percent.
  const warm = applyEvent(makeInitialState("m"), doneEv([], {
    usage: { input: 12100, output: 340, cacheRead: 11000, totalTokens: 12440 },
  }));
  assert.equal(bottomValue(warm, "cache"), "cached 11k/12.1k (91%)");
  // cacheRead > input (an endpoint quirk) clamps to 100%, never >100%.
  const over = applyEvent(makeInitialState("m"), doneEv([], {
    usage: { input: 100, output: 10, cacheRead: 150, totalTokens: 110 },
  }));
  assert.equal(bottomValue(over, "cache"), "cached 0.2k/0.1k (100%)");
  // the field is pinnable and renders in bottomLines.
  assert.ok((BOTTOM_FIELDS as readonly string[]).includes("cache"));
  assert.equal(bottomLines({ ...warm, bottom: ["cache"] }, 80)[0], "cache: cached 11k/12.1k (91%)");
});

test("docs/07 item 1: /context report gains the last-call line + session cache; omitted without data", () => {
  // no usage → unchanged report (no cache lines at all).
  const s0 = { ...makeInitialState("m", {}, 131072, 32768, [], 5000), contextTokens: 25000 };
  assert.doesNotMatch(contextReport(s0), /last call|session cache/);
  // usage with a warm cache: the last-call line names the cached slice, and
  // the session line shows read (write only when non-zero).
  const s1 = applyEvent(s0, doneEv([], {
    usage: { input: 12100, output: 340, cacheRead: 11000, cacheWrite: 200, totalTokens: 12440 },
  }));
  const r1 = contextReport(s1);
  assert.match(r1, /  last call: in 12.1k \(cached 11k\) \/ out 0.3k/);
  assert.match(r1, /  session cache: read 11k · write 0.2k/);
  // usage without cached_tokens: the last-call line appears WITHOUT the
  // cached slice, and no session line (the cumulative is 0).
  const s2 = applyEvent(s0, doneEv([], { usage: { input: 500, output: 50, totalTokens: 550 } }));
  const r2 = contextReport(s2);
  assert.match(r2, /  last call: in 0.5k \/ out 0.1k/);
  assert.doesNotMatch(r2, /cached|session cache/);
  // cumulative across calls: the session line reflects the SUM, not the
  // last call.
  const s3 = applyEvent(s1, doneEv([], { usage: { input: 13000, output: 100, cacheRead: 12000, totalTokens: 13100 } }));
  assert.match(contextReport(s3), /  session cache: read 23k · write 0.2k/);
});

test("docs/07 item 2: done computes contextDelta (new−old) + appends to deltaHistory; first turn has none", () => {
  const s0 = makeInitialState("m", {}, 131072, 32768);
  // first turn: no prior size → no delta, empty history.
  const s1 = applyEvent(s0, doneEv([], { usage: { input: 9000, output: 1000, totalTokens: 10000 } }));
  assert.equal(s1.contextTokens, 10000);
  assert.equal(s1.contextDelta, null);
  assert.deepEqual(s1.deltaHistory, []);
  // second turn: delta = 11000 − 10000.
  const s2 = applyEvent(s1, doneEv([], { usage: { input: 10000, output: 1000, totalTokens: 11000 } }));
  assert.equal(s2.contextDelta, 1000);
  assert.deepEqual(s2.deltaHistory, [1000]);
  // third turn: delta = 13000 − 11000 (the average is over the history, not
  // the last value — 1500, not 2000).
  const s3 = applyEvent(s2, doneEv([], { usage: { input: 12000, output: 1000, totalTokens: 13000 } }));
  assert.equal(s3.contextDelta, 2000);
  assert.deepEqual(s3.deltaHistory, [1000, 2000]);
  // a done WITHOUT usage keeps the context size and records no delta.
  const s4 = applyEvent(s3, doneEv());
  assert.equal(s4.contextTokens, 13000);
  assert.equal(s4.contextDelta, null);
  assert.deepEqual(s4.deltaHistory, [1000, 2000]);
});

test("docs/07 item 2: the `context` bottom field appends the last delta; omitted on the first turn", () => {
  // first turn (context known, no delta yet) → no `+N` suffix.
  const first = { ...makeInitialState("m", {}, 131072, 32768), contextTokens: 11000 };
  assert.equal(
    bottomValue(first, "context"),
    "11k/131.1k (8%) · sys 0 · msgs 11k · @113.7k",
  );
  // a growth → `· +1k` at the end.
  const grown = { ...first, contextDelta: 1000 };
  assert.equal(
    bottomValue(grown, "context"),
    "11k/131.1k (8%) · sys 0 · msgs 11k · @113.7k · +1k",
  );
  // a shrink (e.g. after a compaction) → `· −170k` (U+2212 minus).
  const shrunken = { ...first, contextDelta: -170000 };
  assert.equal(
    bottomValue(shrunken, "context"),
    "11k/131.1k (8%) · sys 0 · msgs 11k · @113.7k · −170k",
  );
});

// docs/07 §7 F2 — the `sys` number in the `context` bottom field splits into
// the prompt's VARIABLE sections (project context · skills index) when the
// driver seeded them; 0/0 (unknown) → the bare `sys N` (byte-identical).

test("F2: makeInitialState defaults systemPromptSections to {0,0}", () => {
  const s = makeInitialState("m");
  assert.deepEqual(s.systemPromptSections, { ctx: 0, skills: 0 });
});

test("F2: the `sys` number splits into (ctx X · skills Y) when seeded", () => {
  // sys 5000 tokens; the variable sections are ctx 2000 + skills 1000 tokens.
  const s = {
    ...makeInitialState("m", {}, 131072, 32768, [], 5000),
    systemPromptSections: { ctx: 2000, skills: 1000 },
    contextTokens: 25000,
  };
  assert.equal(
    bottomValue(s, "context"),
    "25k/131.1k (19%) · sys 5k (ctx 2k · skills 1k) · msgs 20k · @113.7k",
  );
});

test("F2: 0/0 (unknown) → the bare `sys N` (byte-identical to before the split)", () => {
  // No split seeded (the default) → the `sys` number renders bare, exactly
  // as before F2.
  const s = {
    ...makeInitialState("m", {}, 131072, 32768, [], 5000),
    contextTokens: 25000,
  };
  assert.equal(
    bottomValue(s, "context"),
    "25k/131.1k (19%) · sys 5k · msgs 20k · @113.7k",
  );
});

test("F2: only one section seeded → the split still shows both (0 for the other)", () => {
  // ctx 2000, skills 0 → the split shows `ctx 2k · skills 0` (the 0 is shown
  // because at least one part is non-zero).
  const s = {
    ...makeInitialState("m", {}, 131072, 32768, [], 5000),
    systemPromptSections: { ctx: 2000, skills: 0 },
    contextTokens: 25000,
  };
  assert.equal(
    bottomValue(s, "context"),
    "25k/131.1k (19%) · sys 5k (ctx 2k · skills 0) · msgs 20k · @113.7k",
  );
});

// docs/07 §7 F1 — the `msgs` number splits into (t tools · m model · u user),
// computed from the `agent_end` message snapshot and normalized to the
// usage-derived msgs total; unknown → the bare `msgs N` (never a fake zero).

const f1User = (chars: number): UserMessage => ({ role: "user", content: "x".repeat(chars), timestamp: 0 });

test("F1: agent_end computes the split from the final context, normalized to the usage-derived msgs total", () => {
  // sys 5000, usage 25000 → contextTokens 25000, msgs total = 25000 − 5000 = 20000.
  const s0 = makeInitialState("m", {}, 131072, 32768, [], 5000);
  const user = f1User(400); // est 100
  const model = asst([
    { type: "text", text: "y".repeat(800) }, // est 200
    { type: "thinking", thinking: "z".repeat(400) }, // est 100 → thinking counts as model
    { type: "toolCall", id: "t1", name: "bash", arguments: { command: "w".repeat(400) } }, // est 104
  ]); // model est 404
  const tool = tres("t1", "v".repeat(1200)); // est ceil((1 + 1200) / 4) = 301
  const s = fold(
    [
      { type: "agent_start" },
      doneEv([{ type: "text", text: "y".repeat(800) }], {
        usage: { input: 20000, output: 5000, totalTokens: 25000 },
      }),
      { type: "agent_end", stopReason: "stop", messages: [user, model, tool] },
    ],
    s0,
  );
  assert.ok(s.msgSplit !== null, "split known after agent_end");
  // Normalized, not raw: the user bucket scales from its 100-char/4 estimate
  // up to a share of the 20000 usage-derived total (raw estimates sum to 805).
  assert.ok(s.msgSplit!.user > 100, "user bucket scaled to the usage-derived total");
  // Order follows the raw estimates (model 404 > tools 301 > user 100).
  assert.ok(s.msgSplit!.model > s.msgSplit!.tools);
  assert.ok(s.msgSplit!.tools > s.msgSplit!.user);
  // (6) the three parts sum to the msgs number within ±1 (independent rounding).
  const sum = s.msgSplit!.tools + s.msgSplit!.model + s.msgSplit!.user;
  assert.ok(Math.abs(sum - 20000) <= 1, `parts sum ${sum} within ±1 of 20000`);
});

test("F1: a SUMMARY_MARKER user message is excluded from the user bucket (it is the summary bucket)", () => {
  const s0 = makeInitialState("m", {}, 131072, 32768, [], 5000);
  const summary: UserMessage = { role: "user", content: `${SUMMARY_MARKER}\n\nearlier context…`, timestamp: 0 };
  const user = f1User(400); // est 100 — the ONLY counted message
  const s = fold(
    [
      { type: "agent_start" },
      doneEv([], { usage: { input: 19000, output: 1000, totalTokens: 20000 } }),
      { type: "agent_end", stopReason: "stop", messages: [summary, user] },
    ],
    s0,
  );
  // msgs total = 20000 − 5000 = 15000. Only the user message counts (est 100),
  // so it takes the ENTIRE total — if the summary leaked into the user bucket,
  // the est would be larger and the user share strictly smaller.
  assert.ok(s.msgSplit !== null);
  assert.equal(s.msgSplit!.user, 15000);
  assert.equal(s.msgSplit!.tools, 0);
  assert.equal(s.msgSplit!.model, 0);
});

test("F1: thinking counts as model (not user, not dropped)", () => {
  const split = computeMsgSplit([asst([{ type: "thinking", thinking: "a".repeat(400) }])], 100);
  assert.deepEqual(split, { tools: 0, model: 100, user: 0 });
});

test("F1: bare `msgs N` before the first split; the split suffix after", () => {
  const s0 = makeInitialState("m", {}, 131072, 32768, [], 5000);
  const bare = { ...s0, contextTokens: 25000 }; // msgSplit null (default)
  assert.equal(
    bottomValue(bare, "context"),
    "25k/131.1k (19%) · sys 5k · msgs 20k · @113.7k",
  );
  const s = fold(
    [
      { type: "agent_start" },
      doneEv([], { usage: { input: 20000, output: 5000, totalTokens: 25000 } }),
      { type: "agent_end", stopReason: "stop", messages: [f1User(400), asst([{ type: "text", text: "y".repeat(800) }])] },
    ],
    s0,
  );
  // tools = 0 renders as bare `t 0` (fmtTokens(0) = "0", no "k").
  assert.match(bottomValue(s, "context"), /msgs 20k \(t (0|\d+(\.\d)?k) · m \d+(\.\d)?k · u \d+(\.\d)?k\) · @113\.7k/);
  // The /context report line gains the long-form suffix too (tools = 0
  // renders as bare `0`, no "k").
  assert.match(contextReport(s), /  messages: 20k \(tools (0|\d+(\.\d)?k) · model \d+(\.\d)?k · user \d+(\.\d)?k\)/);
});

test("F1: a history with zero tool results renders `t 0` (real data, not absence)", () => {
  const s0 = makeInitialState("m", {}, 131072, 32768, [], 5000);
  const s = fold(
    [
      { type: "agent_start" },
      doneEv([], { usage: { input: 19000, output: 1000, totalTokens: 20000 } }),
      { type: "agent_end", stopReason: "stop", messages: [f1User(400), asst([{ type: "text", text: "y".repeat(800) }])] },
    ],
    s0,
  );
  assert.equal(s.msgSplit!.tools, 0);
  assert.match(bottomValue(s, "context"), /msgs 15k \(t 0 · m/);
});

test("F1: the three parts sum to the msgs number within ±1 (independent rounding drift)", () => {
  // Three DISTINCT buckets of est 33 each (estTotal 99) vs a msgs total of
  // 100 → each part rounds to 33, sum 99 — off by 1, never more (a single
  // bucket would scale exactly, hiding the drift).
  const split = computeMsgSplit(
    [f1User(132), asst([{ type: "text", text: "y".repeat(132) }]), tres("t1", "v".repeat(131))],
    100,
  );
  assert.deepEqual(split, { tools: 33, model: 33, user: 33 });
  assert.ok(split !== null);
  assert.ok(Math.abs(split.tools + split.model + split.user - 100) <= 1);
});

test("F1: context_compacted drops the split to unknown (the event carries no message snapshot)", () => {
  const s0 = makeInitialState("m", {}, 131072, 32768, [], 5000);
  const s1 = fold(
    [
      { type: "agent_start" },
      doneEv([], { usage: { input: 20000, output: 5000, totalTokens: 25000 } }),
      { type: "agent_end", stopReason: "stop", messages: [f1User(400), asst([{ type: "text", text: "y".repeat(800) }])] },
    ],
    s0,
  );
  assert.ok(s1.msgSplit !== null);
  const s2 = applyEvent(s1, {
    type: "context_compacted",
    tokensBefore: 25000,
    messagesKept: 3,
    summaryChars: 4000,
  });
  assert.equal(s2.msgSplit, null);
  // A stale split would misdescribe the new context — the bare `msgs N` renders.
  assert.match(bottomValue(s2, "context"), /msgs \d+(\.\d)?k · @/);
});

test("docs/07 item 2: /context report gains the growth line + turns-until-compaction prediction", () => {
  // window 131072, reserve 16384 (default) → threshold 113664. After a
  // 13000-context turn with deltas [1000, 2000]: headroom 100664, avg 1500
  // → ~67 turns.
  const s = {
    ...makeInitialState("m", {}, 131072, 32768),
    contextTokens: 13000,
    contextDelta: 2000,
    deltaHistory: [1000, 2000],
  };
  const r = contextReport(s);
  assert.match(r, /  growth: \+2k last turn · \+1\.5k avg \(2 turns\)/);
  assert.match(r, /  ~67 turns until compaction/);
  // the prediction uses the MEAN, not the last value (1500, not 2000).
  assert.ok(!r.includes("~50 turns"), "prediction must use the mean, not the last delta");
});

test("docs/07 item 2: prediction omitted when shrinking or DUE; the growth line still shows", () => {
  // shrinking (avgDelta <= 0) → "compaction is not approaching", no count.
  const shrinking = {
    ...makeInitialState("m", {}, 131072, 32768),
    contextTokens: 13000,
    contextDelta: -5000,
    deltaHistory: [1000, -6000],
  };
  const rs = contextReport(shrinking);
  assert.match(rs, /  growth: −5k last turn · −2\.5k avg \(2 turns\)/);
  assert.match(rs, /  compaction is not approaching/);
  assert.ok(!rs.includes("turns until compaction"));
  // DUE (headroom <= 0) → the DUE line covers it; no prediction at all.
  const due = {
    ...makeInitialState("m", {}, 131072, 32768),
    contextTokens: 120000,
    contextDelta: 1000,
    deltaHistory: [1000],
  };
  const rd = contextReport(due);
  assert.match(rd, /compaction: DUE — over the trigger by/);
  assert.match(rd, /  growth: \+1k last turn · \+1k avg \(1 turn\)/);
  assert.ok(!rd.includes("turns until compaction"));
  assert.ok(!rd.includes("not approaching"));
});

test("docs/07 item 2: deltaHistory caps at 8; a compaction resets it to [delta] (negative)", () => {
  // ten growing turns → the history keeps only the last 8.
  let s = makeInitialState("m", {}, 131072, 32768);
  for (let i = 1; i <= 10; i++) {
    s = applyEvent(s, doneEv([], { usage: { input: i * 900, output: 100, totalTokens: i * 1000 } }));
  }
  assert.equal(s.deltaHistory.length, 8);
  assert.deepEqual(s.deltaHistory, [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
  // a compaction SHRINKS the context: the delta is (new − old), a large
  // negative, and it RESETS the history to [delta].
  const pre = {
    ...makeInitialState("m", {}, 131072, 32768),
    contextTokens: 90000,
    contextDelta: 1000,
    deltaHistory: [1000, 1000, 1000],
  };
  const post = applyEvent(pre, {
    type: "context_compacted",
    tokensBefore: 90000,
    messagesKept: 12,
    summaryChars: 36000,
    contextTokens: 10000,
  });
  assert.equal(post.contextTokens, 10000);
  assert.equal(post.contextDelta, -80000);
  assert.deepEqual(post.deltaHistory, [-80000]);
  // a compaction WITHOUT the new estimate → no delta, history untouched.
  const noEst = applyEvent(pre, {
    type: "context_compacted",
    tokensBefore: 90000,
    messagesKept: 12,
    summaryChars: 36000,
  });
  assert.equal(noEst.contextDelta, null);
  assert.deepEqual(noEst.deltaHistory, [1000, 1000, 1000]);
});

test("docs/07 item 4: context_compacted increments compactionCount + captures the last event", () => {
  const s0 = { ...makeInitialState("m", {}, 131072, 32768), contextTokens: 90000 };
  assert.equal(s0.compactionCount, 0);
  assert.equal(s0.lastCompaction, null);
  // first compaction: count 1, the event captured (degraded defaults false).
  const s1 = applyEvent(s0, {
    type: "context_compacted",
    tokensBefore: 90000,
    messagesKept: 12,
    summaryChars: 36000,
    contextTokens: 10000,
  });
  assert.equal(s1.compactionCount, 1);
  assert.deepEqual(s1.lastCompaction, { tokensBefore: 90000, messagesKept: 12, summaryChars: 36000, degraded: false });
  // second compaction: count 2, the LAST event replaces the first.
  const s2 = applyEvent(s1, {
    type: "context_compacted",
    tokensBefore: 95000,
    messagesKept: 8,
    summaryChars: 20000,
    contextTokens: 9000,
    degraded: true,
  });
  assert.equal(s2.compactionCount, 2);
  assert.deepEqual(s2.lastCompaction, { tokensBefore: 95000, messagesKept: 8, summaryChars: 20000, degraded: true });
});

test("docs/07 item 4: the `context` bottom field appends ×N; omitted before the first compaction", () => {
  const base = { ...makeInitialState("m", {}, 131072, 32768), contextTokens: 11000 };
  // no compaction yet → no ×N.
  assert.equal(bottomValue(base, "context"), "11k/131.1k (8%) · sys 0 · msgs 11k · @113.7k");
  // ×1 is already notable (the count is the point).
  assert.equal(
    bottomValue({ ...base, compactionCount: 1 }, "context"),
    "11k/131.1k (8%) · sys 0 · msgs 11k · @113.7k · ×1",
  );
  assert.equal(
    bottomValue({ ...base, compactionCount: 2 }, "context"),
    "11k/131.1k (8%) · sys 0 · msgs 11k · @113.7k · ×2",
  );
  // ×N sits BEFORE the delta (item 2) when both are present.
  assert.equal(
    bottomValue({ ...base, compactionCount: 2, contextDelta: 1000 }, "context"),
    "11k/131.1k (8%) · sys 0 · msgs 11k · @113.7k · ×2 · +1k",
  );
});

test("docs/07 item 4: /context report gains the compactions line; (degraded) suffix; omitted before the first", () => {
  // no compaction → no compactions line.
  const s0 = { ...makeInitialState("m", {}, 131072, 32768), contextTokens: 25000 };
  assert.doesNotMatch(contextReport(s0), /compactions:/);
  // a normal compaction: count + tokensBefore → summary + msgs kept.
  const s1 = {
    ...makeInitialState("m", {}, 131072, 32768),
    contextTokens: 10000,
    compactionCount: 1,
    lastCompaction: { tokensBefore: 90000, messagesKept: 12, summaryChars: 36000, degraded: false },
  };
  // summaryChars 36000 → 9000 tokens (chars/4).
  assert.match(contextReport(s1), /  compactions: 1 · last: 90k → 9k summary \+ 12 msgs kept/);
  // a degraded compaction: the (degraded) suffix.
  const s2 = {
    ...s1,
    compactionCount: 2,
    lastCompaction: { tokensBefore: 95000, messagesKept: 8, summaryChars: 20000, degraded: true },
  };
  assert.match(contextReport(s2), /  compactions: 2 · last: 95k → 5k summary \+ 8 msgs kept \(degraded\)/);
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
    contextTokens: Math.round(113664 * 0.75), // yellow zone (threshold 113664)
    systemPromptTokens: 0,
  };
  assert.deepEqual(bottomLineColors(s), [undefined, "yellow", undefined]);
  // unknown keys are skipped (mirrors bottomLines) and the rest pad to 3.
  const s2 = { ...s, bottom: ["bogus", "context"] };
  assert.deepEqual(bottomLineColors(s2), ["yellow", undefined, undefined]);
});

// ── /models: list the catalog + switch the active model (C34) ─────────────

const CATALOG: ModelOption[] = [
  { id: "small", provider: "p", contextWindow: 32768, maxTokens: 4096 },
  { id: "big", provider: "p", contextWindow: 200000, maxTokens: 8192 },
];

test("modelsListReport: one line per model, active marked with *", () => {
  const s = { ...makeInitialState("small", {}, 32768, 4096), models: CATALOG };
  assert.equal(
    modelsListReport(s),
    [
      "models (2) — * = active:",
      "* small  [p]  window 32.8k",
      "  big  [p]  window 200k",
    ].join("\n"),
  );
  // no catalog supplied → the bare note (the driver seeds it, so this only
  // happens if it supplied none)
  assert.equal(modelsListReport(makeInitialState("m")), "models: (no catalog supplied)");
});

test("modelsListReport: OpenRouter rows append the shared price suffix (free models keep the $0.00/M shape)", () => {
  const OR: ModelOption[] = [
    { id: "openrouter/a", provider: "openrouter", contextWindow: 200000, maxTokens: 8192 },
    { id: "openrouter/free", provider: "openrouter", contextWindow: 1000000, maxTokens: 8192 },
    { id: "small", provider: "p", contextWindow: 32768, maxTokens: 4096 },
  ];
  const s = {
    ...makeInitialState("openrouter/a", {}, 200000, 8192),
    models: OR,
    modelPrices: {
      "openrouter/a": { in: 0.1, out: 0.5 },
      "openrouter/free": { in: 0, out: 0 },
    },
  };
  assert.equal(
    modelsListReport(s),
    [
      "models (3) — * = active:",
      "* openrouter/a  [openrouter]  window 200k  $0.10/M in · $0.50/M out",
      "  openrouter/free  [openrouter]  window 1M  $0.00/M in · $0.00/M out",
      "  small  [p]  window 32.8k",
    ].join("\n"),
  );
  // No resolved prices → every row renders exactly as before (fail-open shape).
  assert.equal(
    modelsListReport({ ...s, modelPrices: {} }),
    [
      "models (3) — * = active:",
      "* openrouter/a  [openrouter]  window 200k",
      "  openrouter/free  [openrouter]  window 1M",
      "  small  [p]  window 32.8k",
    ].join("\n"),
  );
});

test("applyModelSwitch: re-seeds label + context field; null on unknown id", () => {
  const s = { ...makeInitialState("small", {}, 32768, 4096), models: CATALOG };
  const toBig = applyModelSwitch(s, "big");
  assert.ok(toBig !== null);
  assert.equal(toBig.modelLabel, "big");
  assert.equal(toBig.contextWindow, 200000);
  assert.equal(toBig.maxTokens, 8192);
  // the rest of the state is untouched (items, bottom, context estimate)
  assert.equal(toBig.items, s.items);
  assert.equal(toBig.bottom, s.bottom);
  // unknown id → null (a typo can never silently switch)
  assert.equal(applyModelSwitch(s, "nope"), null);
  // no catalog → null
  assert.equal(applyModelSwitch(makeInitialState("m"), "big"), null);
});

// ── C38: the interactive model picker (↑/↓ + enter/esc) ───────────────────

test("modelPickerOpen: opens on the active model's row; no catalog → unchanged", () => {
  const s = { ...makeInitialState("big", {}, 200000, 8192), models: CATALOG };
  const open = modelPickerOpen(s);
  assert.equal(open.modelPicker, 1); // "big" is the second catalog row
  assert.equal(open.modelLabel, "big"); // no switch yet
  // active model not in the catalog (e.g. catalog replaced after startup)
  const orphan = modelPickerOpen({ ...makeInitialState("ghost"), models: CATALOG });
  assert.equal(orphan.modelPicker, null);
  // no catalog → the state is returned unchanged (same reference)
  const empty = makeInitialState("m");
  assert.equal(modelPickerOpen(empty), empty);
});

test("modelPickerInitialIndex: active row, null when absent", () => {
  const s = { ...makeInitialState("small", {}, 32768, 4096), models: CATALOG };
  assert.equal(modelPickerInitialIndex(s), 0);
  assert.equal(modelPickerInitialIndex({ ...s, modelLabel: "big" }), 1);
  assert.equal(modelPickerInitialIndex({ ...s, modelLabel: "ghost" }), null);
});

test("modelPickerNav: moves the highlight with wrap-around; null when closed", () => {
  const s = { ...makeInitialState("small", {}, 32768, 4096), models: CATALOG, modelPicker: 0 };
  assert.equal(modelPickerNav(s, 1)!.modelPicker, 1);
  assert.equal(modelPickerNav(s, -1)!.modelPicker, 1); // wraps to the last row
  const last = { ...s, modelPicker: 1 };
  assert.equal(modelPickerNav(last, 1)!.modelPicker, 0); // wraps to the first row
  assert.equal(modelPickerNav(last, -1)!.modelPicker, 0);
  // closed → null (the caller falls through to history navigation)
  assert.equal(modelPickerNav(makeInitialState("m", {}, 0, 0, [], 0, CATALOG), 1), null);
  // closed + empty catalog → null
  assert.equal(modelPickerNav(makeInitialState("m"), 1), null);
});

test("modelPickerConfirm: switches to the highlighted model and closes", () => {
  const s = { ...makeInitialState("small", {}, 32768, 4096), models: CATALOG, modelPicker: 0 };
  const toBig = modelPickerConfirm({ ...s, modelPicker: 1 });
  assert.ok(toBig !== null);
  assert.equal(toBig.modelPicker, null); // closed
  assert.equal(toBig.modelLabel, "big"); // switched (applyModelSwitch)
  assert.equal(toBig.contextWindow, 200000);
  assert.equal(toBig.maxTokens, 8192);
  // confirming the ACTIVE model → closes, no switch (label + fields as-is)
  const same = modelPickerConfirm(s);
  assert.ok(same !== null);
  assert.equal(same.modelPicker, null);
  assert.equal(same.modelLabel, "small");
  assert.equal(same.contextWindow, 32768);
  // closed → null (the caller runs the normal submit path)
  assert.equal(modelPickerConfirm({ ...s, modelPicker: null }), null);
  assert.equal(modelPickerConfirm(makeInitialState("m", {}, 0, 0, [], 0, CATALOG)), null);
});

test("modelPickerClose: esc closes without switching; null when closed", () => {
  const s = { ...makeInitialState("small", {}, 32768, 4096), models: CATALOG, modelPicker: 1 };
  const closed = modelPickerClose(s);
  assert.ok(closed !== null);
  assert.equal(closed.modelPicker, null);
  assert.equal(closed.modelLabel, "small"); // no switch
  assert.equal(closed.contextWindow, 32768);
  assert.equal(modelPickerClose(makeInitialState("m")), null);
});

test("modelPickerMenu: one line per model, highlighted row marked, hidden when closed", () => {
  const s = { ...makeInitialState("small", {}, 32768, 4096), models: CATALOG, modelPicker: 1 };
  const lines = modelPickerMenu(s, 80);
  assert.deepEqual(
    lines.map((l) => l.line),
    ["  small  [p]  window 32.8k", "> big  [p]  window 200k"],
  );
  assert.deepEqual(lines.map((l) => l.selected), [false, true]);
  // closed → no lines (the frame renders nothing)
  assert.deepEqual(modelPickerMenu(makeInitialState("m", {}, 0, 0, [], 0, CATALOG), 80), []);
  // an approval pending hides the picker (the input is locked then anyway)
  const appr = setApproval(s, "run rm -rf?", () => {});
  assert.deepEqual(modelPickerMenu(appr, 80), []);
});

test("modelPickerMenu: OpenRouter rows append the price suffix; narrow widths clip it (unchanged truncation)", () => {
  const OR: ModelOption[] = [
    { id: "openrouter/a", provider: "openrouter", contextWindow: 200000, maxTokens: 8192 },
    { id: "openrouter/free", provider: "openrouter", contextWindow: 1000000, maxTokens: 8192 },
  ];
  const s = {
    ...makeInitialState("openrouter/a", {}, 200000, 8192),
    models: OR,
    modelPicker: 0,
    modelPrices: {
      "openrouter/a": { in: 0.1, out: 0.5 },
      "openrouter/free": { in: 0, out: 0 },
    },
  };
  // wide enough → the full row with the shared suffix (same shape as /models)
  assert.deepEqual(
    modelPickerMenu(s, 80).map((l) => l.line),
    [
      "> openrouter/a  [openrouter]  window 200k  $0.10/M in · $0.50/M out",
      "  openrouter/free  [openrouter]  window 1M  $0.00/M in · $0.00/M out",
    ],
  );
  // narrow → the existing end-truncation clips the price FIRST (the window
  // stays visible); the truncation behavior itself is unchanged. The row
  // prefix (`> openrouter/a  [openrouter]  window 200k`) is exactly 41
  // cells, so a 42-cell width keeps the whole window and clips the entire
  // price suffix.
  const narrow = modelPickerMenu(s, 42).map((l) => l.line);
  const first = narrow[0] ?? "";
  assert.ok(first.endsWith("…"), "narrow rows are truncated");
  assert.ok(first.includes("window 200k"), "the window survives a narrow width");
  assert.ok(!first.includes("$"), "the price is what gets clipped");
  // no prices resolved → rows render exactly as before (fail-open)
  assert.deepEqual(
    modelPickerMenu({ ...s, modelPrices: {} }, 80).map((l) => l.line),
    ["> openrouter/a  [openrouter]  window 200k", "  openrouter/free  [openrouter]  window 1M"],
  );
});

test("C38: input is locked while the model picker is open", () => {
  const s = { ...makeInitialState("small", {}, 32768, 4096), models: CATALOG, modelPicker: 0 };
  assert.equal(inputChar(s, "x"), s); // same reference — nothing typed
  assert.equal(inputBackspace(s), s);
  assert.equal(inputMove(s, -1), s);
  assert.equal(submitInput(s), null); // enter confirms the picker, not a submit
});

test("handleSlashCommand: /models opens the picker, /models <id> switches, unknown reports", () => {
  const s = { ...makeInitialState("small", {}, 32768, 4096), models: CATALOG };

  // C38: bare /models → opens the interactive picker (modelPicker set to the
  // active model's row) — no info item, no switch yet
  const list = handleSlashCommand(s, "/models");
  assert.equal(list.handled, true);
  assert.equal(list.state.items.length, s.items.length);
  assert.equal(list.state.modelPicker, 0); // "small" is the first catalog row
  assert.equal(list.state.modelLabel, "small");

  // C38: bare /models with NO catalog → the old "no models" note (info item)
  const none = handleSlashCommand(makeInitialState("m"), "/models");
  assert.equal(none.handled, true);
  assert.equal(none.state.modelPicker, null);
  const noneInfo = none.state.items[none.state.items.length - 1] as { kind: string; text: string };
  assert.equal(noneInfo.kind, "info");
  assert.match(noneInfo.text, /no catalog supplied/);

  // /models big → switched: label + window re-seeded, feedback info item
  const sw = handleSlashCommand(s, "/models big");
  assert.equal(sw.handled, true);
  assert.equal(sw.state.modelLabel, "big");
  assert.equal(sw.state.contextWindow, 200000);
  const swInfo = sw.state.items[sw.state.items.length - 1] as { kind: string; text: string };
  assert.equal(swInfo.kind, "info");
  assert.match(swInfo.text, /switched to big/);

  // /models <unknown> → reported, NOT switched
  const bad = handleSlashCommand(s, "/models nope");
  assert.equal(bad.handled, true);
  assert.equal(bad.state.modelLabel, "small"); // unchanged
  const badInfo = bad.state.items[bad.state.items.length - 1] as { text: string };
  assert.match(badInfo.text, /unknown model 'nope'/);

  // /models with a trailing arg that is a real id still switches; a second
  // word is NOT a valid id (ids are single tokens) → unknown
  assert.equal(handleSlashCommand(s, "/models big extra").state.modelLabel, "small");
  // /modelsX (no space) is not the command → unhandled
  assert.equal(handleSlashCommand(s, "/modelsX").handled, false);
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

test("agent_end: stall → error item explaining the sandbox wall", () => {
  const s = applyEvent(
    { ...makeInitialState("m"), busy: true },
    { type: "agent_end", stopReason: "stall", messages: [] },
  );
  const last = s.items[s.items.length - 1]!;
  assert.equal(last.kind, "error");
  const text = last.kind === "error" ? last.text : "<not an error item>";
  assert.match(text, /stall: the same tool failed 3 times with a permission denial within its last 8 calls/);
  assert.match(text, /--no-sandbox/);
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

test("steerInput: scrolled-up viewTop is preserved (a steer must not yank the viewport to the bottom)", () => {
  const s = { ...makeInitialState("m"), busy: true, input: "be brief", viewTop: 30 };
  const r = steerInput(s, "be brief");
  assert.notEqual(r, null);
  assert.equal(r!.state.viewTop, 30, "scrolled-up position survives a steer");
});

test("steerInput: following the bottom (viewTop null) stays following", () => {
  const s = { ...makeInitialState("m"), busy: true, input: "be brief" };
  const r = steerInput(s, "be brief");
  assert.equal(r!.state.viewTop, null);
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
  const r = applyEvent(s, { type: "steer", turn: 2, text: "fix the bug", message: { role: "user", content: "fix the bug", timestamp: 1 } });
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

// ── WS12 (scope §7): /mcp status command ───────────────────────────────────

test("handleSlashCommand: /mcp appends the driver-supplied status as an info item", () => {
  const s = { ...makeInitialState("m"), input: "left alone" };
  const status = "fs — ready (3 tools)\ndb — failed (probe: -32603)\nremote — disabled";
  const r = handleSlashCommand(s, "/mcp", undefined, status);
  assert.equal(r.handled, true);
  assert.equal(r.state.items.length, s.items.length + 1, "exactly one item appended");
  const info = r.state.items[r.state.items.length - 1];
  assert.equal(info?.kind, "info");
  assert.equal((info as { text: string }).text, status);
  // the rest of the state is untouched
  assert.equal(r.state.input, "left alone");
  assert.deepEqual(r.state.bottom, []);
});

test("handleSlashCommand: /mcp with no status (no servers configured) reports that", () => {
  const s = makeInitialState("m");
  const r = handleSlashCommand(s, "/mcp");
  assert.equal(r.handled, true);
  const info = r.state.items[r.state.items.length - 1];
  assert.equal(info?.kind, "info");
  assert.equal((info as { text: string }).text, "mcp: no servers configured");
});

test("handleSlashCommand: /mcp is exact-only (/mcpX is not handled)", () => {
  const s = makeInitialState("m");
  assert.equal(handleSlashCommand(s, "/mcpX").handled, false);
});

test("SLASH_COMMANDS: /mcp is registered with a summary", () => {
  const cmd = SLASH_COMMANDS.find((c) => c.name === "mcp");
  assert.ok(cmd, "/mcp is in the registry");
  assert.match(cmd!.summary, /MCP server status/);
  assert.ok(slashCandidates("/mcp").includes("/mcp"), "the menu prefix-filters it");
});

// ── F2 (docs/08 §7): loop-guard telemetry — /stats_loop_guard ──────────────

test("F2: guard_retry increments the session fire count and marks the run", () => {
  let s = makeInitialState("m");
  s = applyEvent(s, { type: "agent_start" });
  s = applyEvent(s, { type: "guard_retry", turn: 5, retry: 1, maxRetries: 1 });
  assert.equal(s.guardRetry.fired, 1, "the session fire count increments");
  assert.equal(s.guardRetry.recovered, 0, "recovery is not known until agent_end");
  assert.equal(s.guardRetryRunFired, 1, "the current run is marked as having fired");
  // the info item still lands (H5 behavior unchanged)
  const last = s.items[s.items.length - 1];
  assert.equal(last?.kind, "info");
});

test("F2: a run that fires a retry and ends stop is recovered (one per run)", () => {
  let s = makeInitialState("m");
  s = applyEvent(s, { type: "agent_start" });
  s = applyEvent(s, { type: "guard_retry", turn: 5, retry: 1, maxRetries: 2 });
  s = applyEvent(s, { type: "guard_retry", turn: 7, retry: 2, maxRetries: 2 });
  assert.equal(s.guardRetry.fired, 1, "fired is per-RUN — two retries in one run count once");
  s = applyEvent(s, { type: "agent_end", stopReason: "stop", messages: [] });
  assert.equal(s.guardRetry.recovered, 1, "ONE recovered run, not one per retry");
  assert.equal(s.guardRetryRunFired, 0, "the per-run mark clears at agent_end");
});

test("F2: a run that fires a retry but ends budget/length/error is NOT recovered", () => {
  for (const stopReason of ["budget", "length", "error"] as const) {
    let s = makeInitialState("m");
    s = applyEvent(s, { type: "agent_start" });
    s = applyEvent(s, { type: "guard_retry", turn: 5, retry: 1, maxRetries: 1 });
    s = applyEvent(s, { type: "agent_end", stopReason, messages: [] });
    assert.equal(s.guardRetry.fired, 1, `${stopReason}: the fire is still counted`);
    assert.equal(s.guardRetry.recovered, 0, `${stopReason}: no completion — not recovered`);
  }
});

test("F2: a run that fires a retry and ends loop is NOT recovered", () => {
  let s = makeInitialState("m");
  s = applyEvent(s, { type: "agent_start" });
  s = applyEvent(s, { type: "guard_retry", turn: 5, retry: 1, maxRetries: 1 });
  s = applyEvent(s, { type: "agent_end", stopReason: "loop", messages: [] });
  assert.equal(s.guardRetry.fired, 1);
  assert.equal(s.guardRetry.recovered, 0, "the retry budget was spent — not recovered");
});

test("F2: the per-run mark clears at agent_end (a later no-fire run is not recovered)", () => {
  let s = makeInitialState("m");
  // run 1: fires and recovers
  s = applyEvent(s, { type: "agent_start" });
  s = applyEvent(s, { type: "guard_retry", turn: 3, retry: 1, maxRetries: 1 });
  s = applyEvent(s, { type: "agent_end", stopReason: "stop", messages: [] });
  assert.deepEqual(s.guardRetry, { fired: 1, recovered: 1 });
  assert.equal(s.guardRetryRunFired, 0, "agent_end clears the per-run mark");
  // run 2: no fire, ends stop → must NOT count as recovered (the mark is 0)
  s = applyEvent(s, { type: "agent_start" });
  s = applyEvent(s, { type: "agent_end", stopReason: "stop", messages: [] });
  assert.deepEqual(s.guardRetry, { fired: 1, recovered: 1 }, "unchanged — no new fire, no new recovery");
});

test("F2: multiple runs accumulate (recover then fail)", () => {
  let s = makeInitialState("m");
  s = applyEvent(s, { type: "agent_start" });
  s = applyEvent(s, { type: "guard_retry", turn: 2, retry: 1, maxRetries: 1 });
  s = applyEvent(s, { type: "agent_end", stopReason: "stop", messages: [] });
  s = applyEvent(s, { type: "agent_start" });
  s = applyEvent(s, { type: "guard_retry", turn: 4, retry: 1, maxRetries: 1 });
  s = applyEvent(s, { type: "agent_end", stopReason: "loop", messages: [] });
  assert.equal(s.guardRetry.fired, 2);
  assert.equal(s.guardRetry.recovered, 1);
});

test("statsLoopGuardLine: no fires → the 'not fired' note", () => {
  assert.equal(
    statsLoopGuardLine(makeInitialState("m")),
    "loop guard: no guard-retry fires this session (the loop guard has not fired)",
  );
});

test("statsLoopGuardLine: fires + recoveries → counts, rate, verdict", () => {
  const base = makeInitialState("m");
  // 2 fires, 1 recovered (50%)
  const half = { ...base, guardRetry: { fired: 2, recovered: 1 } };
  assert.equal(
    statsLoopGuardLine(half),
    "loop guard: 2 fire(s), 1 recovered (50%) — 1 fire(s) did not complete after the retry (this session)",
  );
  // all recovered
  const all = { ...base, guardRetry: { fired: 3, recovered: 3 } };
  assert.equal(
    statsLoopGuardLine(all),
    "loop guard: 3 fire(s), 3 recovered (100%) — every fire recovered (this session)",
  );
  // none recovered
  const none = { ...base, guardRetry: { fired: 2, recovered: 0 } };
  assert.equal(
    statsLoopGuardLine(none),
    "loop guard: 2 fire(s), 0 recovered (0%) — no fire recovered (none completed after the retry) (this session)",
  );
});

test("handleSlashCommand: /stats_loop_guard appends the telemetry line (pure, busy-safe)", () => {
  const s = {
    ...makeInitialState("m"),
    guardRetry: { fired: 1, recovered: 1 },
    input: "left alone",
    busy: true,
  };
  const r = handleSlashCommand(s, "/stats_loop_guard");
  assert.equal(r.handled, true);
  assert.equal(r.state.items.length, s.items.length + 1, "exactly one item appended");
  const info = r.state.items[r.state.items.length - 1];
  assert.equal(info?.kind, "info");
  assert.equal(
    (info as { text: string }).text,
    "loop guard: 1 fire(s), 1 recovered (100%) — every fire recovered (this session)",
  );
  // the rest of the state is untouched (busy stays — the run continues)
  assert.equal(r.state.input, "left alone");
  assert.equal(r.state.busy, true);
  assert.deepEqual(r.state.guardRetry, { fired: 1, recovered: 1 }, "the report does not mutate the counters");
});

test("SLASH_COMMANDS: /stats_loop_guard is registered with a summary", () => {
  const cmd = SLASH_COMMANDS.find((c) => c.name === "stats_loop_guard");
  assert.ok(cmd !== undefined, "stats_loop_guard is in the registry");
  assert.ok(cmd!.summary.length > 0, "the menu shows a summary");
  assert.ok(slashCandidates("/stats_").includes("/stats_loop_guard"), "the menu prefix-filters it");
});

// ── /restart: in-place relaunch (feedback here; the re-exec is the driver's) ──
test("SLASH_COMMANDS: /restart is registered with a summary", () => {
  const restart = SLASH_COMMANDS.find((c) => c.name === "restart");
  assert.ok(restart !== undefined, "restart is in the registry");
  assert.ok(restart!.summary.length > 0, "the menu shows a summary");
});

test("handleSlashCommand: /restart is handled and appends the relaunching feedback", () => {
  const s = makeInitialState("m");
  const r = handleSlashCommand(s, "/restart");
  assert.equal(r.handled, true);
  assert.equal(r.state.items.length, s.items.length + 1, "exactly one item appended");
  const info = r.state.items[r.state.items.length - 1];
  assert.equal(info?.kind, "info");
  const text = (info as { text: string }).text;
  assert.ok(text.includes("restart:"), `expected "restart:" in ${text}`);
  assert.ok(text.includes("relaunching"), `expected "relaunching" in ${text}`);
});

test("handleSlashCommand: /restart with a trailing space (menu completion) is still handled", () => {
  const s = makeInitialState("m");
  const r = handleSlashCommand(s, "/restart ");
  assert.equal(r.handled, true, "the handler trims — menu completion leaves a trailing space");
  const info = r.state.items[r.state.items.length - 1];
  assert.equal(info?.kind, "info");
  assert.ok((info as { text: string }).text.includes("relaunching"));
});

test("slashCandidates: /re offers /restart", () => {
  assert.ok(slashCandidates("/re").includes("/restart"), "the prefix /re matches restart");
});

test("handleSlashCommand: /restartX is NOT a command (unhandled)", () => {
  const s = makeInitialState("m");
  const r = handleSlashCommand(s, "/restartX");
  assert.equal(r.handled, false);
  assert.equal(r.state, s, "unhandled: the state is returned untouched");
});

test("handleSlashCommand: /restart touches no bottom/modelLabel/busy (pure feedback)", () => {
  const s = {
    ...makeInitialState("m", { session: "/tmp/s.jsonl" }, 131072, 32768, ["model", "context"]),
    busy: true,
    input: "left alone",
  };
  const r = handleSlashCommand(s, "/restart");
  assert.equal(r.handled, true);
  assert.deepEqual(r.state.bottom, ["model", "context"], "bottom unchanged");
  assert.equal(r.state.modelLabel, "m", "modelLabel unchanged");
  assert.equal(r.state.busy, true, "busy unchanged — the driver owns the re-exec");
  assert.equal(r.state.input, "left alone", "input unchanged");
});

// ── subtasks (the `subtask` tool's bottom field) ───────────────────────────

const subEnd = (
  id: string,
  subtasks: unknown,
  isError = false,
  action?: "create" | "list" | "mark",
  updatedAt?: number,
  rev?: number,
): AgentEvent => ({
  type: "tool_execution_end",
  toolCallId: id,
  result: {
    role: "toolResult",
    toolCallId: id,
    toolName: "subtask",
    content: [{ type: "text", text: "ok" }],
    isError,
    ...(isError
      ? {}
      : {
          details: {
            subtasks,
            ...(action === undefined ? {} : { action }),
            ...(updatedAt === undefined ? {} : { updatedAt }),
            ...(rev === undefined ? {} : { rev }),
          },
        }),
    timestamp: 0,
  },
});

test("applyEvent: subtask tool_execution_end mirrors details.subtasks into state", () => {
  let s = makeInitialState("m");
  assert.deepEqual(s.subtasks, []);
  s = applyEvent(s, subEnd("1", [
    { id: 1, name: "wire state", status: "in-progress" },
    { id: 2, name: "add tests", status: "queued" },
  ]));
  assert.deepEqual(s.subtasks, [
    { id: 1, name: "wire state", status: "in-progress" },
    { id: 2, name: "add tests", status: "queued" },
  ]);
  // a later mark replaces the whole list (the tool returns the full list)
  s = applyEvent(s, subEnd("2", [
    { id: 1, name: "wire state", status: "done" },
    { id: 2, name: "add tests", status: "in-progress" },
  ]));
  assert.equal(s.subtasks[0]!.status, "done");
  assert.equal(s.subtasks[1]!.status, "in-progress");
  assert.equal(s.subtasksExpired, false, "create/mark activity re-arms the display");
});

test("applyEvent: subtask ERROR result does NOT touch state.subtasks", () => {
  let s = makeInitialState("m");
  s = applyEvent(s, subEnd("1", [
    { id: 1, name: "a", status: "queued" },
  ]));
  const before = s.subtasks;
  s = applyEvent(s, subEnd("2", null, true)); // isError: no details
  assert.equal(s.subtasks, before, "error result leaves the list unchanged");
  // a non-subtask tool's details are ignored too
  s = applyEvent(s, {
    type: "tool_execution_end",
    toolCallId: "3",
    result: {
      role: "toolResult", toolCallId: "3", toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      details: { subtasks: [{ id: 9, name: "injected", status: "done" }] },
      timestamp: 0,
    },
  });
  assert.equal(s.subtasks, before, "another tool's details are not subtask data");
});

test("applyEvent: malformed details.subtasks is ignored (I3)", () => {
  let s = makeInitialState("m");
  s = applyEvent(s, {
    type: "tool_execution_end",
    toolCallId: "1",
    result: {
      role: "toolResult", toolCallId: "1", toolName: "subtask",
      content: [{ type: "text", text: "ok" }],
      details: { subtasks: "not-an-array" },
      timestamp: 0,
    },
  });
  assert.deepEqual(s.subtasks, []);
  s = applyEvent(s, {
    type: "tool_execution_end",
    toolCallId: "2",
    result: {
      role: "toolResult", toolCallId: "2", toolName: "subtask",
      content: [{ type: "text", text: "ok" }],
      details: { subtasks: [{ name: "real" }, "junk", { id: 2, name: "b", status: "bogus" }] },
      timestamp: 0,
    },
  });
  assert.deepEqual(s.subtasks, [
    { id: 1, name: "real", status: "queued" },
    { id: 2, name: "b", status: "queued" },
  ]);
});

test("subtasksBottomValue: none / active / next / all-done / failed-only", () => {
  assert.equal(subtasksBottomValue([]), "none");
  // active (in-progress) wins, by id order
  assert.equal(
    subtasksBottomValue([
      { id: 1, name: "a", status: "done" },
      { id: 2, name: "b", status: "in-progress" },
      { id: 3, name: "c", status: "in-progress" },
    ]),
    "1/3 b",
  );
  // nothing in-progress → the next queued one, marked (next)
  assert.equal(
    subtasksBottomValue([
      { id: 1, name: "a", status: "done" },
      { id: 2, name: "b", status: "queued" },
    ]),
    "1/2 b (next)",
  );
  // all done
  assert.equal(
    subtasksBottomValue([
      { id: 1, name: "a", status: "done" },
      { id: 2, name: "b", status: "done" },
    ]),
    "2/2 done",
  );
  // the only remaining item is failed (failed is NOT counted as done)
  assert.equal(
    subtasksBottomValue([
      { id: 1, name: "a", status: "done" },
      { id: 2, name: "b", status: "failed" },
    ]),
    "1/2 b (failed)",
  );
  // unsorted input: selection is by id, not array order
  assert.equal(
    subtasksBottomValue([
      { id: 2, name: "b", status: "queued" },
      { id: 1, name: "a", status: "in-progress" },
    ]),
    "0/2 a",
  );
});

test("bottomValue: the `subtasks` field renders the one-liner", () => {
  const st: SubtaskInfo[] = [
    { id: 1, name: "wire state", status: "done" },
    { id: 2, name: "add tests", status: "in-progress" },
  ];
  const s = { ...makeInitialState("m"), subtasks: st };
  assert.equal(bottomValue(s, "subtasks"), "1/2 add tests");
  assert.equal(bottomValue(makeInitialState("m"), "subtasks"), "none");
});

test("BOTTOM_FIELDS: `subtasks` is registered LAST (existing configs keep order)", () => {
  assert.equal(BOTTOM_FIELDS[BOTTOM_FIELDS.length - 1], "subtasks");
  assert.ok((BOTTOM_FIELDS as readonly string[]).includes("subtasks"));
  // /display-bottom accepts it and rejects unknown fields
  const r = handleSlashCommand(makeInitialState("m"), "/display-bottom subtasks");
  assert.equal(r.handled, true);
  assert.deepEqual(r.state.bottom, ["subtasks"]);
  const last = r.state.items[r.state.items.length - 1]!;
  assert.equal(last.kind, "info");
  assert.match(last.text, /display-bottom: subtasks/);
});

test("bottomLines: the subtasks line truncates to the width", () => {
  const st: SubtaskInfo[] = [
    { id: 1, name: "a very long subtask name that will not fit", status: "in-progress" },
    { id: 2, name: "b", status: "queued" },
  ];
  const s = { ...makeInitialState("m", {}, 0, 0, ["subtasks"]), subtasks: st };
  const lines = bottomLines(s, 20);
  assert.equal(lines.length, 3, "padded to RESERVED_BOTTOM_LINES");
  const line = lines[0]!;
  assert.ok(line.length <= 20, `line fits the width: ${JSON.stringify(line)}`);
  assert.ok(line.startsWith("subtasks: 0/2 a"));
});

// ── subtasks: status colors + expiry (the live-workstream QOL) ─────────────

test("subtaskStatusColor: in-progress green, queued yellow, done gray, failed red", () => {
  assert.equal(subtaskStatusColor("in-progress"), "green");
  assert.equal(subtaskStatusColor("queued"), "yellow");
  assert.equal(subtaskStatusColor("done"), "gray");
  assert.equal(subtaskStatusColor("failed"), "red");
});

test("subtasksLineAnsi: per-status color, dim fraction, code-stripped = plain one-liner", () => {
  const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");
  // in-progress → green name
  let line = subtasksLineAnsi(
    [
      { id: 1, name: "a", status: "done" },
      { id: 2, name: "b", status: "in-progress" },
    ],
    80,
  );
  assert.equal(strip(line), "subtasks: 1/2 b");
  assert.ok(line.includes("\u001b[32mb\u001b[0m"), "name is green");
  assert.ok(line.includes("\u001b[2msubtasks: \u001b[0m"), "prefix is dim");
  // next queued → yellow name
  line = subtasksLineAnsi(
    [
      { id: 1, name: "a", status: "done" },
      { id: 2, name: "b", status: "queued" },
    ],
    80,
  );
  assert.equal(strip(line), "subtasks: 1/2 b (next)");
  assert.ok(line.includes("\u001b[33m"), "name is yellow");
  // all done → gray "done"
  line = subtasksLineAnsi(
    [
      { id: 1, name: "a", status: "done" },
      { id: 2, name: "b", status: "done" },
    ],
    80,
  );
  assert.equal(strip(line), "subtasks: 2/2 done");
  assert.ok(line.includes("\u001b[90mdone\u001b[0m"), "'done' is gray");
  // failed-only → red name
  line = subtasksLineAnsi(
    [
      { id: 1, name: "a", status: "done" },
      { id: 2, name: "b", status: "failed" },
    ],
    80,
  );
  assert.equal(strip(line), "subtasks: 1/2 b (failed)");
  assert.ok(line.includes("\u001b[31m"), "name is red");
  // empty → dim "subtasks: none" (the expiry render path)
  line = subtasksLineAnsi([], 80);
  assert.equal(strip(line), "subtasks: none");
  assert.ok(line.startsWith("\u001b[2m"), "fully dim");
  // truncation is ANSI-aware and keeps ONE row
  line = subtasksLineAnsi(
    [{ id: 1, name: "a very long subtask name that will not fit", status: "in-progress" }],
    20,
  );
  assert.ok(strip(line).length <= 20, `stripped fits: ${JSON.stringify(strip(line))}`);
  assert.ok(!line.includes("\n"), "one row");
});

test("subtasksExpired: live+busy never expires; everything else after the quiet window", () => {
  const done: SubtaskInfo[] = [
    { id: 1, name: "a", status: "done" },
    { id: 2, name: "b", status: "failed" },
  ];
  const live: SubtaskInfo[] = [
    { id: 1, name: "a", status: "done" },
    { id: 2, name: "b", status: "in-progress" },
  ];
  const t0 = 1_000_000;
  // empty list → expired (nothing to show)
  assert.equal(subtasksExpired([], t0, t0, 90_000), true);
  // live + busy → never expired, even when ancient (a long tool call
  // between marks must not blank the field mid-run)
  assert.equal(subtasksExpired(live, t0, t0 + 999_999_999, 90_000, true), false);
  assert.equal(subtasksExpired([{ id: 1, name: "q", status: "queued" }], t0, t0 + 999_999_999, 90_000, true), false);
  // live + IDLE (audit F2: an abandoned workstream — aborted run, dead
  // loop) → follows the same quiet window as a settled list
  assert.equal(subtasksExpired(live, t0, t0 + 90_001, 90_000, false), true);
  assert.equal(subtasksExpired(live, t0, t0 + 10_000, 90_000, false), false);
  // settled + recent activity → still shown (the settle just happened)
  assert.equal(subtasksExpired(done, t0, t0 + 10_000, 90_000), false);
  // settled + quiet past the window → expired (the field settles to "none")
  assert.equal(subtasksExpired(done, t0, t0 + 90_001, 90_000), true);
  // exactly at the window boundary → still shown (strictly greater)
  assert.equal(subtasksExpired(done, t0, t0 + 90_000, 90_000), false);
  // busy defaults to false (the flag is only about the live exemption)
  assert.equal(subtasksExpired(live, t0, t0 + 999_999_999, 90_000), true);
});

test("applyEvent: create/mark un-expire the field; observational list does not", () => {
  let s = makeInitialState("m");
  s = { ...s, subtasksExpired: true }; // the poller settled the field
  s = applyEvent(s, subEnd("1", [{ id: 1, name: "a", status: "in-progress" }], false, "mark"));
  assert.equal(s.subtasksExpired, false, "a fresh mark re-arms the display");
  assert.equal(s.subtasks[0]!.status, "in-progress");
  s = { ...s, subtasksExpired: true };
  s = applyEvent(s, subEnd("2", [{ id: 1, name: "a", status: "done" }], false, "list"));
  assert.equal(s.subtasks[0]!.status, "done", "list still refreshes the displayed snapshot");
  assert.equal(s.subtasksExpired, true, "list does not re-arm a settled display");
});

test("applyEvent: create/mark arms the exemption for the CURRENT run (audit F1)", () => {
  // Activity during a run stamps subtasksArmedRun = runStartedAt.
  let s = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: 555 },
    subEnd("1", [{ id: 1, name: "a", status: "in-progress" }], false, "mark"),
  );
  assert.equal(s.subtasksArmedRun, 555, "the mark arms the exemption for this run");
  assert.equal(subtasksBusyArmed(s), true);
  // An observational list does NOT arm.
  let s2 = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: 777 },
    subEnd("1", [{ id: 1, name: "a", status: "done" }], false, "list"),
  );
  assert.equal(s2.subtasksArmedRun, null, "a list never arms the exemption");
  // A later run (fresh runStartedAt, no activity) is NOT armed — the
  // previous run's arm does not carry over: agent_start clears it.
  const armedMid = { ...s2, busy: true, runStartedAt: 555, subtasksArmedRun: 555 };
  const started = applyEvent(armedMid, { type: "agent_start" } as AgentEvent);
  assert.equal(started.subtasksArmedRun, null, "agent_start un-arms the previous run's exemption");
  assert.equal(started.subtasksExpired, s2.subtasksExpired, "agent_start leaves the flag to the poller");
  assert.equal(subtasksBusyArmed(started), false, "an unrelated run has no exemption");
});

test("applyEvent: subtask action resolution — start capture + content heuristic (audit F2)", () => {
  // (a) details.action wins: a tagged list never arms.
  let s = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: 100 },
    subEnd("t1", [{ id: 1, name: "a", status: "done" }], false, "list"),
  );
  assert.equal(s.subtasksArmedRun, null, "tagged list never arms");
  // (b) no details.action (older/custom tool), start captured `list` →
  // a read: no un-expire, no arm — even when the content CHANGES (the
  // OLD code armed on every untagged result).
  let s2: TuiState = { ...makeInitialState("m"), busy: true, runStartedAt: 100, subtasksExpired: true };
  s2 = applyEvent(s2, toolStart("t2", "subtask", { action: "list" }));
  s2 = applyEvent(s2, subEnd("t2", [{ id: 1, name: "a", status: "done" }], false));
  assert.equal(s2.subtasks[0]!.status, "done", "the list still refreshes the snapshot");
  assert.equal(s2.subtasksExpired, true, "start-captured list is a read — no un-expire");
  assert.equal(s2.subtasksArmedRun, null, "start-captured list never arms");
  // (c) no start event, no tag → CONTENT heuristic: identical snapshot
  // is a read (no arm), a changed snapshot is activity (arm).
  let s3: TuiState = {
    ...makeInitialState("m"),
    busy: true,
    runStartedAt: 200,
    subtasks: [{ id: 1, name: "a", status: "done" }],
  };
  s3 = applyEvent(s3, subEnd("t3", [{ id: 1, name: "a", status: "done" }], false));
  assert.equal(s3.subtasksArmedRun, null, "identical untagged snapshot = read");
  s3 = applyEvent(s3, subEnd("t4", [{ id: 1, name: "a", status: "in-progress" }], false));
  assert.equal(s3.subtasksArmedRun, 200, "changed untagged snapshot = activity");
});

test("applyEvent: details.updatedAt is mirrored into state.subtasksUpdatedAt", () => {
  let s = makeInitialState("m");
  assert.equal(s.subtasksUpdatedAt, 0);
  s = applyEvent(s, subEnd("1", [{ id: 1, name: "a", status: "queued" }], false, "create", 123_456));
  assert.equal(s.subtasksUpdatedAt, 123_456, "create stamps the activity clock (the sessionless expire source)");
  // a list result carries the file's (unchanged) updatedAt — still mirrored
  s = applyEvent(s, subEnd("2", [{ id: 1, name: "a", status: "queued" }], false, "list", 123_456));
  assert.equal(s.subtasksUpdatedAt, 123_456);
  // absent updatedAt on a LIST (older/custom tool) → the stamp is left
  // alone (a read is not activity — audit F1)
  s = applyEvent(s, subEnd("3", [{ id: 1, name: "a", status: "done" }], false, "list"));
  assert.equal(s.subtasksUpdatedAt, 123_456, "a list without updatedAt does not clobber the stamp");
  // audit A3: absent updatedAt on ACTIVITY (create/mark) → the stamp
  // falls back to the receipt time, so the settle window starts NOW
  // (before the fix the field kept the old stamp and a fresh legacy list
  // died on the next poll tick).
  const before = Date.now();
  s = applyEvent(s, subEnd("4", [{ id: 1, name: "a", status: "done" }], false, "mark"));
  assert.ok(s.subtasksUpdatedAt >= before, `receipt time stamped: ${s.subtasksUpdatedAt}`);
  assert.ok(s.subtasksUpdatedAt <= Date.now(), "receipt time is not in the future");
});

// ── the subtasks expiry poller's tick (the F1b self-heal) ──────────────────

const settled = [
  { id: 1, name: "a", status: "done" as const },
  { id: 2, name: "b", status: "done" as const },
];

test("subtasksPollTick: no push while the state and the file agree (no 5s churn)", () => {
  const t0 = 1_000_000;
  const file = { items: settled, updatedAt: t0 };
  const state = { subtasks: settled, subtasksExpired: false, subtasksUpdatedAt: t0 };
  const r = subtasksPollTick({ state, file, lastSig: JSON.stringify({ ...file, rev: 0 }), now: t0 + 10_000, staleMs: 90_000 });
  assert.equal(r.push, false);
});

test("subtasksPollTick: re-expiry (audit F1b) — an out-of-band un-expire self-heals", () => {
  // The exact pin sequence from the audit: settled file, the poller
  // expired the display, then applyEvent un-expired it (a `list` call
  // from an older tool without the action tag, or any flip). The OLD
  // signature folded `expired` in, so the poller saw its own last
  // signature and never re-expired — the display stuck FOREVER.
  const t0 = 1_000_000;
  const file = { items: settled, updatedAt: t0 };
  let state = { subtasks: settled, subtasksExpired: false, subtasksUpdatedAt: t0 };
  let sig: string | null = null;

  // tick 1: fresh settle window → push the file's view (expired=false)
  let r = subtasksPollTick({ state, file, lastSig: sig, now: t0 + 10_000, staleMs: 90_000 });
  assert.equal(r.push, true);
  sig = r.sig;

  // the window elapses → tick pushes expired=true (display: none)
  r = subtasksPollTick({ state, file, lastSig: sig, now: t0 + 90_001, staleMs: 90_000 });
  assert.equal(r.push, true, "the expiry flip pushes");
  state = { ...state, subtasksExpired: true };
  sig = r.sig;

  // applyEvent un-expires out-of-band (the pin trigger)
  state = { ...state, subtasksExpired: false };

  // the NEXT tick must re-push the file's view (expired=true) — this is
  // the self-heal; the old signature-based check no-oped here forever.
  r = subtasksPollTick({ state, file, lastSig: sig, now: t0 + 95_000, staleMs: 90_000 });
  assert.equal(r.push, true, "disagreement on the derived flag re-pushes (self-heal)");
  assert.equal(r.subtasksExpired, true, "the file's view wins");
  state = { ...state, subtasksExpired: r.subtasksExpired };

  // and then it settles: no further pushes while they agree
  r = subtasksPollTick({ state, file, lastSig: sig, now: t0 + 100_000, staleMs: 90_000 });
  assert.equal(r.push, false, "agreement → quiet");
});

test("subtasksPollTick: a file change (another process) is mirrored", () => {
  const t0 = 1_000_000;
  const state = { subtasks: settled, subtasksExpired: true, subtasksUpdatedAt: t0 };
  const file = { items: [{ id: 1, name: "a", status: "in-progress" as const }], updatedAt: t0 + 5_000 };
  const r = subtasksPollTick({ state, file, lastSig: JSON.stringify({ items: settled, updatedAt: t0 }), now: t0 + 6_000, staleMs: 90_000 });
  assert.equal(r.push, true);
  assert.equal(r.subtasks[0]!.status, "in-progress");
  assert.equal(r.subtasksExpired, false, "a fresh live item un-expires the display");
});

test("subtasksPollTick: sessionless (no file) expires from the state's own stamp (audit F3)", () => {
  const t0 = 1_000_000;
  // settled in-memory list, quiet past the window → expire
  let state: SubtasksPollTick = { subtasks: settled, subtasksExpired: false, subtasksUpdatedAt: t0 };
  let r = subtasksPollTick({ state, file: null, lastSig: null, now: t0 + 90_001, staleMs: 90_000 });
  assert.equal(r.push, true, "the sessionless list settles to none too");
  assert.equal(r.subtasksExpired, true);
  assert.equal(r.subtasks, settled, "the list itself is untouched");

  // live + armed (this run's own workstream) → exempt (a long tool call
  // between marks must not blank the field)
  state = { subtasks: [{ id: 1, name: "a", status: "in-progress" as const }], subtasksExpired: false, subtasksUpdatedAt: t0, busyArmed: true };
  r = subtasksPollTick({ state, file: null, lastSig: null, now: t0 + 999_999, staleMs: 90_000 });
  assert.equal(r.push, false, "live + armed never expires");

  // live + idle (abandoned) → expires on the same window (F2 sessionless)
  r = subtasksPollTick({ state: { ...state, busyArmed: false }, file: null, lastSig: null, now: t0 + 999_999, staleMs: 90_000 });
  assert.equal(r.push, true);
  assert.equal(r.subtasksExpired, true);

  // already expired → quiet (no repeated push)
  state = { ...state, subtasksExpired: true };
  r = subtasksPollTick({ state: { ...state, busyArmed: false }, file: null, lastSig: null, now: t0 + 999_999, staleMs: 90_000 });
  assert.equal(r.push, false);
});

test("subtasksExpired: the ARMED exemption replaces the sticky flag (audit F1)", () => {
  const live: SubtaskInfo[] = [{ id: 1, name: "a", status: "in-progress" }];
  const t0 = 1_000_000;
  // armed (the in-flight run owns the activity) → protected however old
  assert.equal(subtasksExpired(live, t0, t0 + 10_000, 90_000, true), false);
  assert.equal(subtasksExpired(live, t0, t0 + 999_999_999, 90_000, true), false);
  // NOT armed (a busy-but-unrelated run, or idle) → the deadline rules,
  // regardless of what the display flag currently says — nothing sticky
  assert.equal(subtasksExpired(live, t0, t0 + 90_001, 90_000, false), true);
  assert.equal(subtasksExpired(live, t0, t0 + 999_999_999, 90_000, false), true);
});

test("subtasksBusyArmed: the exemption belongs to the activity's own run (audit F1)", () => {
  const t0 = 1_000_000;
  // idle → never armed
  assert.equal(subtasksBusyArmed({ busy: false, runStartedAt: t0, subtasksArmedRun: t0 }), false);
  // busy but the list was never armed → no exemption
  assert.equal(subtasksBusyArmed({ busy: true, runStartedAt: t0, subtasksArmedRun: null }), false);
  // busy, armed by a PREVIOUS run → no exemption (the F1 hole)
  assert.equal(subtasksBusyArmed({ busy: true, runStartedAt: t0 + 500, subtasksArmedRun: t0 }), false);
  // busy and armed for THIS run → exempt
  assert.equal(subtasksBusyArmed({ busy: true, runStartedAt: t0, subtasksArmedRun: t0 }), true);
  // idle run (runStartedAt null) never matches the never-armed null
  assert.equal(subtasksBusyArmed({ busy: true, runStartedAt: null, subtasksArmedRun: null }), false);
});

// ── audit F1b: the arm is bound to the armed SNAPSHOT ───────────────────────

test("applyEvent: create/mark arms the snapshot identity (audit F1b)", () => {
  const t0 = 1_000_000;
  const live: SubtaskInfo[] = [{ id: 1, name: "a", status: "in-progress" }];
  let s = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: t0 },
    subEnd("t1", live, false, "create", t0),
  );
  assert.equal(s.subtasksArmedSig, subtaskItemsSig(live), "the arm carries the produced snapshot's identity");
  assert.equal(subtasksBusyArmed(s, live), true, "the armed snapshot is exempt");
  assert.equal(subtasksBusyArmed(s, [{ id: 1, name: "foreign", status: "in-progress" }]), false, "a foreign list is NOT exempt");
  // agent_start clears the identity with the run arm.
  const started = applyEvent({ ...s, busy: false }, { type: "agent_start" } as AgentEvent);
  assert.equal(started.subtasksArmedSig, "", "agent_start clears the armed identity");
});

test("subtasksBusyArmed: the snapshot check is additive (legacy states without an identity)", () => {
  const t0 = 1_000_000;
  const live: SubtaskInfo[] = [{ id: 1, name: "a", status: "in-progress" }];
  // armed run, no identity (hand-built/legacy) → the run-only check applies
  const legacy = { busy: true, runStartedAt: t0, subtasksArmedRun: t0 };
  assert.equal(subtasksBusyArmed(legacy, live), true, "no identity → no snapshot constraint");
  // identity armed but empty string → same ("" = never armed)
  assert.equal(subtasksBusyArmed({ ...legacy, subtasksArmedSig: "" }, live), true);
  // identity armed and matching / mismatching
  assert.equal(subtasksBusyArmed({ ...legacy, subtasksArmedSig: subtaskItemsSig(live) }, live), true);
  assert.equal(subtasksBusyArmed({ ...legacy, subtasksArmedSig: subtaskItemsSig(live) }, settled), false);
  // not busy → never exempt, identity or not
  assert.equal(subtasksBusyArmed({ ...legacy, busy: false }, live), false);
});

test("subtaskItemsSig: content identity, order-sensitive, stamp-independent", () => {
  const a: SubtaskInfo[] = [{ id: 1, name: "a", status: "in-progress" }];
  const a2: SubtaskInfo[] = [{ id: 1, name: "a", status: "in-progress" }];
  const b: SubtaskInfo[] = [{ id: 1, name: "a", status: "done" }];
  const swapped: SubtaskInfo[] = [{ id: 2, name: "a", status: "in-progress" }, ...a];
  assert.equal(subtaskItemsSig(a), subtaskItemsSig(a2), "same content → same sig");
  assert.notEqual(subtaskItemsSig(a), subtaskItemsSig(b), "status change → different sig");
  assert.notEqual(subtaskItemsSig(a), subtaskItemsSig(swapped), "identity/order change → different sig");
});

test("subtasksPollTick: an external replacement does NOT inherit the run's exemption (audit F1b)", () => {
  const t0 = 1_000_000;
  const mine: SubtaskInfo[] = [{ id: 1, name: "mine", status: "in-progress" }];
  const foreign: SubtaskInfo[] = [{ id: 1, name: "external abandoned work", status: "in-progress" }];
  // Run A created `mine` → armed (run + identity).
  let state: SubtasksPollTick = {
    subtasks: mine,
    subtasksExpired: false,
    subtasksUpdatedAt: t0,
    busyArmed: true,
    subtasksArmedSig: subtaskItemsSig(mine),
  };
  // tick 1: the file was replaced by a FRESH foreign list → mirrored, shown.
  const file = { items: foreign, updatedAt: t0 + 1_000 };
  let r = subtasksPollTick({ state, file, lastSig: JSON.stringify({ items: mine, updatedAt: t0, rev: 0 }), now: t0 + 2_000, staleMs: 90_000 });
  assert.equal(r.push, true, "the replacement is mirrored");
  assert.equal(r.subtasksExpired, false, "fresh → shown (the deadline rules, not the exemption)");
  state = { ...state, subtasks: r.subtasks, subtasksExpired: r.subtasksExpired, subtasksUpdatedAt: r.subtasksUpdatedAt };
  const sig = r.sig;
  // tick 2 (much later, run A STILL in flight and armed for its own
  // snapshot): the stale foreign list must expire — no inheritance.
  r = subtasksPollTick({ state, file, lastSig: sig, now: t0 + 500_000, staleMs: 90_000 });
  assert.equal(r.push, true, "the stale foreign list expires despite the armed run");
  assert.equal(r.subtasksExpired, true);
  // tick 3: stays expired (the mirror did not re-grant the exemption).
  state = { ...state, subtasksExpired: true };
  r = subtasksPollTick({ state, file, lastSig: r.sig, now: t0 + 505_000, staleMs: 90_000 });
  assert.equal(r.push, false, "no churn, no resurrection");
  assert.equal(r.subtasksExpired, true);
});

test("subtasksPollTick: the owning run's own snapshot keeps the exemption (audit F1b, no regression)", () => {
  const t0 = 1_000_000;
  const mine: SubtaskInfo[] = [{ id: 1, name: "mine", status: "in-progress" }];
  const file = { items: mine, updatedAt: t0 };
  const state: SubtasksPollTick = {
    subtasks: mine,
    subtasksExpired: false,
    subtasksUpdatedAt: t0,
    busyArmed: true,
    subtasksArmedSig: subtaskItemsSig(mine),
  };
  const r = subtasksPollTick({ state, file, lastSig: JSON.stringify({ ...file, rev: 0 }), now: t0 + 999_999, staleMs: 90_000 });
  assert.equal(r.push, false, "identity match + armed → the long tool call keeps the field alive");
  assert.equal(r.subtasksExpired, false);
});

test("subtasksPollTick: sessionless foreign state honors the identity the same way (audit F1b)", () => {
  const t0 = 1_000_000;
  const foreign: SubtaskInfo[] = [{ id: 1, name: "foreign", status: "in-progress" }];
  // The in-memory list does NOT match the armed identity (e.g. a replay
  // or hand-built state) → the deadline rules.
  const state: SubtasksPollTick = {
    subtasks: foreign,
    subtasksExpired: false,
    subtasksUpdatedAt: t0,
    busyArmed: true,
    subtasksArmedSig: subtaskItemsSig([{ id: 9, name: "other", status: "done" }]),
  };
  let r = subtasksPollTick({ state, file: null, lastSig: null, now: t0 + 90_001, staleMs: 90_000 });
  assert.equal(r.push, true);
  assert.equal(r.subtasksExpired, true, "identity mismatch → no sessionless exemption either");
  // identity match → exempt.
  r = subtasksPollTick({
    state: { ...state, subtasksArmedSig: subtaskItemsSig(foreign) },
    file: null, lastSig: null, now: t0 + 999_999, staleMs: 90_000,
  });
  assert.equal(r.push, false);
  assert.equal(r.subtasksExpired, false);
});

// ── rev model (audit F1c/F1-legacy/F2): the arm is bound to the armed WRITE
//    REVISION — content and stamps are not ownership, and a newer-rev write
//    DISARMS ──────────────────────────────────────────────────────────────────

test("applyEvent: create/mark arms the write rev (rev model)", () => {
  const t0 = 1_000_000;
  const live: SubtaskInfo[] = [{ id: 1, name: "a", status: "in-progress" }];
  const s = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: t0 },
    subEnd("t1", live, false, "create", t0, 5),
  );
  assert.equal(s.subtasksArmedRev, 5, "the arm carries the producing write's rev");
  assert.equal(s.subtasksRev, 5, "the mirrored list's rev moves with the mirror");
  assert.equal(s.subtasksUpdatedAt, t0, "updatedAt stays the expiry clock");
  assert.equal(subtasksBusyArmed(s, live, 5), true, "the armed write (rev match) is exempt");
  // Same content, a DIFFERENT rev (another process rewrote the same items —
  // even in the same millisecond): not exempt — only the armed write is.
  assert.equal(subtasksBusyArmed(s, live, 6), false, "same content, foreign rev → not exempt");
  assert.equal(subtasksBusyArmed(s, live, 4), false, "older rev → not the armed write");
  assert.equal(subtasksBusyArmed(s, live, 0), false, "a rev-less (legacy) snapshot vs a rev arm → not exempt");
  // A legacy content-only arm (rev 0 — a custom/legacy result without
  // details.rev) keeps the content check: a matching list is exempt
  // whatever its stamp (the F1-legacy fix — the receipt time is never an
  // identity), a foreign list still is not (F1b).
  const legacy = { busy: true, runStartedAt: t0, subtasksArmedRun: t0, subtasksArmedSig: subtaskItemsSig(live), subtasksArmedRev: 0 };
  assert.equal(subtasksBusyArmed(legacy, live, 12_345), true, "rev-0 arm → content match, stamp/rev unconstrained");
  assert.equal(subtasksBusyArmed(legacy, [{ id: 1, name: "foreign", status: "in-progress" }], 0), false, "rev-0 arm still rejects a foreign list");
  // agent_start clears the rev arm with the rest of the arm.
  const started = applyEvent(s, { type: "agent_start" } as AgentEvent);
  assert.equal(started.subtasksArmedRev, 0, "agent_start clears the armed rev");
});

test("applyEvent: a legacy result (no rev) arms rev 0 and mirrors rev 0 (rev model, F1-legacy)", () => {
  const t0 = 1_000_000;
  const live: SubtaskInfo[] = [{ id: 1, name: "a", status: "in-progress" }];
  const before = Date.now();
  const s = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: t0 },
    subEnd("t1", live, false, "create"), // no updatedAt, no rev
  );
  const after = Date.now();
  assert.equal(s.subtasksArmedRev, 0, "no details.rev → arm with NO write identity");
  assert.equal(s.subtasksArmedSig, subtaskItemsSig(live), "the content signature is the fallback identity");
  assert.ok(s.subtasksUpdatedAt >= before && s.subtasksUpdatedAt <= after, "the receipt time is the CLOCK only");
  assert.equal(s.subtasksRev, 0, "the mirrored list has no write identity either");
});

test("subtasksPollTick: a same-content external rewrite (newer rev) disarms the exemption (rev model, F2)", () => {
  const t0 = 1_000_000;
  const mine: SubtaskInfo[] = [{ id: 1, name: "mine", status: "in-progress" }];
  const state: SubtasksPollTick = {
    subtasks: mine,
    subtasksExpired: false,
    subtasksUpdatedAt: t0,
    busyArmed: true,
    subtasksArmedSig: subtaskItemsSig(mine),
    subtasksArmedRev: 5,
    subtasksRev: 5,
  };
  // Another process rewrites the SAME items (rev 6 — the same-content
  // same-millisecond case Date.now could not separate) while the run is
  // in flight: fresh → still shown (deadline rules), but the tick reports
  // the arm is over — the exemption belongs to rev 5, not to the content.
  const file = { items: mine, updatedAt: t0 + 1_000, rev: 6 };
  const r = subtasksPollTick({
    state,
    file,
    lastSig: JSON.stringify({ items: mine, updatedAt: t0, rev: 5 }),
    now: t0 + 2_000,
    staleMs: 90_000,
  });
  assert.equal(r.disarm, true, "a write with a newer rev supersedes the armed write → disarm");
  assert.equal(r.rev, 6, "the mirrored rev follows the file");
  assert.equal(r.subtasksExpired, false, "fresh → shown (deadline, not exemption)");
  // After the driver applies the disarm, the SAME file at deadline time
  // expires — the content match no longer rescues it.
  const after: SubtasksPollTick = {
    subtasks: mine,
    subtasksExpired: false,
    subtasksUpdatedAt: t0 + 1_000,
    busyArmed: false, // disarmed
    subtasksRev: 6,
  };
  const r2 = subtasksPollTick({ state: after, file, lastSig: JSON.stringify({ ...file, rev: 6 }), now: t0 + 92_000, staleMs: 90_000 });
  assert.equal(r2.push, true);
  assert.equal(r2.subtasksExpired, true, "post-disarm the deadline rules alone decide");
});

test("subtasksPollTick: an A→B→A stale restore cannot regain the exemption (rev model)", () => {
  const t0 = 1_000_000;
  const a: SubtaskInfo[] = [{ id: 1, name: "mine", status: "in-progress" }];
  const b: SubtaskInfo[] = [{ id: 1, name: "other work", status: "in-progress" }];
  // Run A creates A at rev 5 (arms run + rev via the real applyEvent path).
  let run = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: t0 },
    subEnd("t1", a, false, "create", t0, 5),
  );
  const snapshotOf = (st: TuiState): SubtasksPollTick => ({
    subtasks: st.subtasks,
    subtasksExpired: st.subtasksExpired,
    subtasksUpdatedAt: st.subtasksUpdatedAt,
    busyArmed: subtasksBusyArmed(st),
    subtasksArmedSig: st.subtasksArmedSig,
    subtasksArmedRev: st.subtasksArmedRev,
    subtasksRev: st.subtasksRev,
  });
  let state = snapshotOf(run);
  // tick 1: another process replaces the list with B (rev 6 > armed rev 5).
  const fileB = { items: b, updatedAt: t0 + 1_000, rev: 6 };
  let r = subtasksPollTick({
    state,
    file: fileB,
    lastSig: JSON.stringify({ items: a, updatedAt: t0, rev: 5 }),
    now: t0 + 1_001,
    staleMs: 90_000,
  });
  assert.equal(r.disarm, true, "the foreign B write (newer rev) disarms the arm");
  // The driver applies the disarm (clears the three arm fields) and
  // mirrors B. The run is still busy, but busyArmed is the driver's own
  // computation — with the arm cleared it is false.
  run = { ...run, subtasks: r.subtasks, subtasksExpired: r.subtasksExpired, subtasksUpdatedAt: r.subtasksUpdatedAt, subtasksRev: r.rev,
          subtasksArmedRun: null, subtasksArmedSig: "", subtasksArmedRev: 0 };
  assert.equal(subtasksBusyArmed(run), false, "disarmed: no exemption even while busy");
  state = snapshotOf(run);
  // tick 2: a stale restore puts A's CONTENT back with a newer rev
  // (A→B→A, rev 7). The content matches the old arm — but the arm is
  // gone, so once past the window it must expire (no resurrection).
  const fileA2 = { items: a, updatedAt: t0 + 5_000, rev: 7 };
  r = subtasksPollTick({
    state,
    file: fileA2,
    lastSig: JSON.stringify({ ...fileB, rev: 6 }),
    now: t0 + 96_000,
    staleMs: 90_000,
  });
  assert.equal(r.push, true);
  assert.equal(r.subtasksExpired, true, "A→B→A restore: content match without an arm → expired");
});

test("subtasksPollTick: the armed write never disarms; an older-rev snapshot is skipped, not mirrored (rev model, F3)", () => {
  const t0 = 1_000_000;
  const mine: SubtaskInfo[] = [{ id: 1, name: "mine", status: "in-progress" }];
  const state: SubtasksPollTick = {
    subtasks: mine,
    subtasksExpired: false,
    subtasksUpdatedAt: t0,
    busyArmed: true,
    subtasksArmedSig: subtaskItemsSig(mine),
    subtasksArmedRev: 5,
    subtasksRev: 5,
  };
  // The owning run's own snapshot (equal rev): exempt, no disarm — the
  // long-tool-call case stays protected.
  const file = { items: mine, updatedAt: t0, rev: 5 };
  const r = subtasksPollTick({ state, file, lastSig: JSON.stringify({ ...file, rev: 5 }), now: t0 + 999_999, staleMs: 90_000 });
  assert.equal(r.disarm, false, "equal rev → not a foreign write");
  assert.equal(r.push, false);
  assert.equal(r.subtasksExpired, false);
  // An OLDER-rev snapshot while the owning run is armed (a lagging read
  // racing the armed write, or a rollback): NOT mirrored (the display
  // keeps the owned snapshot), NOT disarmed (a lagging observation cannot
  // supersede the armed write — the arm survives for the real write).
  const restore = subtasksPollTick({
    state,
    file: { items: mine, updatedAt: t0 - 1_000, rev: 4 },
    lastSig: "stale",
    now: t0 + 999_999,
    staleMs: 90_000,
  });
  assert.equal(restore.disarm, false, "an older rev cannot supersede the armed write");
  assert.equal(restore.push, false, "the lagging snapshot is never accepted into state (F3)");
  assert.equal(restore.subtasksExpired, false, "the armed view survives the lagging read");
});

test("subtasksPollTick: a foreign write in the armed millisecond (newer rev) disarms; A→B→A cannot regain (rev model, F2)", () => {
  const t0 = 1_000_000;
  const a: SubtaskInfo[] = [{ id: 1, name: "mine", status: "in-progress" }];
  const b: SubtaskInfo[] = [{ id: 1, name: "other work", status: "in-progress" }];
  // Run A creates A at rev 5. A foreign B written in the SAME millisecond
  // (same updatedAt — invisible to the stamp model) carries rev 6: the rev
  // model sees it as the newer write it is → expire on deadline + disarm.
  let run = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: t0 },
    subEnd("t1", a, false, "create", t0, 5),
  );
  const snapshotOf = (st: TuiState): SubtasksPollTick => ({
    subtasks: st.subtasks,
    subtasksExpired: st.subtasksExpired,
    subtasksUpdatedAt: st.subtasksUpdatedAt,
    busyArmed: subtasksBusyArmed(st),
    subtasksArmedSig: st.subtasksArmedSig,
    subtasksArmedRev: st.subtasksArmedRev,
    subtasksRev: st.subtasksRev,
  });
  let state = snapshotOf(run);
  const r1 = subtasksPollTick({
    state,
    file: { items: b, updatedAt: t0, rev: 6 },
    lastSig: JSON.stringify({ items: a, updatedAt: t0, rev: 5 }),
    now: t0 + 200_000,
    staleMs: 90_000,
  });
  assert.equal(r1.subtasksExpired, true, "the same-millisecond foreign write expires (no exemption)");
  assert.equal(r1.disarm, true, "the newer-rev foreign write disarms the arm");
  // The driver applies the disarm…
  run = { ...run, subtasksArmedRun: null, subtasksArmedSig: "", subtasksArmedRev: 0 };
  state = snapshotOf(run);
  // …and a subsequent A→B→A restore (any rev) cannot regain the
  // exemption: the arm is gone, the deadline rules decide.
  const r2 = subtasksPollTick({
    state,
    file: { items: a, updatedAt: t0 + 5_000, rev: 7 },
    lastSig: JSON.stringify({ items: b, updatedAt: t0, rev: 6 }),
    now: t0 + 210_000,
    staleMs: 90_000,
  });
  assert.equal(r2.subtasksExpired, true, "A→B→A restore after the disarm → expired");
});

test("subtasksPollTick: a strictly-newer rev snapshot disarms (foreign rewrite, rev model)", () => {
  const t0 = 1_000_000;
  const mine: SubtaskInfo[] = [{ id: 1, name: "mine", status: "in-progress" }];
  const run = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: t0 },
    subEnd("t1", mine, false, "create", t0, 5),
  );
  const state: SubtasksPollTick = {
    subtasks: run.subtasks,
    subtasksExpired: run.subtasksExpired,
    subtasksUpdatedAt: run.subtasksUpdatedAt,
    busyArmed: subtasksBusyArmed(run),
    subtasksArmedSig: run.subtasksArmedSig,
    subtasksArmedRev: run.subtasksArmedRev,
    subtasksRev: run.subtasksRev,
  };
  const r = subtasksPollTick({
    state,
    file: { items: mine, updatedAt: t0 + 1_000, rev: 6 },
    lastSig: JSON.stringify({ items: mine, updatedAt: t0, rev: 5 }),
    now: t0 + 2_000,
    staleMs: 90_000,
  });
  assert.equal(r.subtasksExpired, false, "fresh → shown (deadline rules)");
  assert.equal(r.disarm, true, "a newer-rev same-content write is a foreign rewrite → disarm");
});

// ── audit cycle-1 finding 3: OBSERVATIONAL snapshot ingress (applyEvent
//    `list` results) goes through the same ownership reconciliation as the
//    poller — older observations are skipped, accepted newer ones disarm ────

test("applyEvent: an older observational list (rev < armed) is NOT accepted while armed (audit cycle-1 F3)", () => {
  const t0 = 1_000_000;
  const a: SubtaskInfo[] = [{ id: 1, name: "mine", status: "in-progress" }];
  const b: SubtaskInfo[] = [{ id: 1, name: "other work", status: "in-progress" }];
  let run = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: t0 },
    subEnd("t1", a, false, "create", t0, 5),
  );
  // A `list` result carrying an OLDER snapshot (rev 4 — a read that raced
  // the armed write, or a rollback read): the display keeps the owned
  // snapshot, the arm survives, and the older content is never staged for
  // an "exact restore" to revive.
  run = applyEvent(run, toolStart("t2", "subtask", { action: "list" }));
  run = applyEvent(run, subEnd("t2", b, false, "list", t0 - 5_000, 4));
  assert.deepEqual(run.subtasks, a, "the older observation is not mirrored");
  assert.equal(run.subtasksRev, 5, "the mirrored rev keeps the armed write's");
  assert.equal(run.subtasksArmedRev, 5, "the arm survives the older observation");
  assert.equal(run.subtasksArmedRun, t0, "the run arm survives too");
  assert.equal(run.subtasksUpdatedAt, t0, "the clock is not moved by the rejected observation");
  // Tool-completion bookkeeping is independent: the tool line still closed.
  const toolItem = run.items.find((it) => it.kind === "tool" && it.id === "t2");
  assert.ok(toolItem !== undefined && toolItem.kind === "tool" && toolItem.running === false, "the tool item still completes");
  // And the poller's exact-restore path stays correct (the armed write is
  // exempt) while the rejected snapshot never entered the view:
  const state: SubtasksPollTick = {
    subtasks: run.subtasks, subtasksExpired: run.subtasksExpired, subtasksUpdatedAt: run.subtasksUpdatedAt,
    busyArmed: subtasksBusyArmed(run), subtasksArmedSig: run.subtasksArmedSig,
    subtasksArmedRev: run.subtasksArmedRev, subtasksRev: run.subtasksRev,
  };
  const r = subtasksPollTick({
    state, file: { items: a, updatedAt: t0, rev: 5 },
    lastSig: JSON.stringify({ items: a, updatedAt: t0, rev: 5 }),
    now: t0 + 300_000, staleMs: 90_000,
  });
  assert.equal(r.subtasksExpired, false, "the armed write stays exempt (no stale exemption was revived — the older snapshot was never accepted)");
});

test("applyEvent: a newer observational list (rev > armed) is accepted AND disarms the arm (audit cycle-1 F3)", () => {
  const t0 = 1_000_000;
  const a: SubtaskInfo[] = [{ id: 1, name: "mine", status: "in-progress" }];
  const b: SubtaskInfo[] = [{ id: 1, name: "other work", status: "in-progress" }];
  let run = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: t0 },
    subEnd("t1", a, false, "create", t0, 5),
  );
  // A `list` result carrying a NEWER committed write (rev 6): the write
  // superseded the armed one — accept the snapshot AND clear the arm (the
  // poller's disarm rule), so a later exact restore of the armed content
  // cannot revive the exemption.
  run = applyEvent(run, subEnd("t2", b, false, "list", t0 + 1_000, 6));
  assert.deepEqual(run.subtasks, b, "the newer snapshot is mirrored");
  assert.equal(run.subtasksRev, 6, "the mirrored rev follows the newer write");
  assert.equal(run.subtasksArmedRun, null, "the superseded arm is cleared");
  assert.equal(run.subtasksArmedRev, 0, "the rev arm is cleared");
  assert.equal(run.subtasksArmedSig, "", "the sig arm is cleared");
  // The exact restore of A's CONTENT (rev 5 — older than the newest write)
  // after the window: expired, no resurrection (the arm is gone).
  const state: SubtasksPollTick = {
    subtasks: run.subtasks, subtasksExpired: run.subtasksExpired, subtasksUpdatedAt: run.subtasksUpdatedAt,
    busyArmed: subtasksBusyArmed(run), subtasksArmedSig: run.subtasksArmedSig,
    subtasksArmedRev: run.subtasksArmedRev, subtasksRev: run.subtasksRev,
  };
  const r = subtasksPollTick({
    state, file: { items: a, updatedAt: t0, rev: 5 },
    lastSig: JSON.stringify({ items: b, updatedAt: t0 + 1_000, rev: 6 }),
    now: t0 + 200_000, staleMs: 90_000,
  });
  assert.equal(r.subtasksExpired, true, "post-disarm the restored list follows the deadline (no revival)");
  assert.equal(r.disarm, false, "nothing left to disarm");
});

test("applyEvent: the observational reconciliation only gates a live positive-rev arm (no regressions)", () => {
  const t0 = 1_000_000;
  const a: SubtaskInfo[] = [{ id: 1, name: "mine", status: "in-progress" }];
  const b: SubtaskInfo[] = [{ id: 1, name: "other work", status: "in-progress" }];
  // (a) equal rev (the armed write itself re-observed via list): mirrored,
  //     arm intact.
  let run = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: t0 },
    subEnd("t1", a, false, "create", t0, 5),
  );
  run = applyEvent(run, subEnd("t2", a, false, "list", t0, 5));
  assert.deepEqual(run.subtasks, a);
  assert.equal(run.subtasksArmedRev, 5, "the armed write's own observation keeps the arm");
  // (b) NOT armed (idle): a list is a plain mirror, no reconciliation.
  let idle = applyEvent(makeInitialState("m"), subEnd("t1", b, false, "list", t0, 3));
  assert.deepEqual(idle.subtasks, b, "unarmed list mirrors normally");
  assert.equal(idle.subtasksRev, 3);
  // (c) legacy rev-0 arm (a legacy result armed by content): revs cannot
  //     order writes → the list mirrors normally (F1b semantics kept).
  let legacy = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: t0 },
    subEnd("t1", a, false, "create"), // no rev → rev-0 arm
  );
  legacy = applyEvent(legacy, subEnd("t2", b, false, "list", t0 + 1_000));
  assert.deepEqual(legacy.subtasks, b, "a rev-less arm cannot order observations");
  assert.equal(legacy.subtasksArmedRun, t0, "the rev-0 arm is not disarmed by rev");
  // (d) a different run's arm (subtasksArmedRun ≠ runStartedAt): no gate —
  //     the observation belongs to the current run's view.
  let other = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: t0 + 999, subtasksArmedRun: t0, subtasksArmedRev: 5, subtasksArmedSig: subtaskItemsSig(a), subtasks: a, subtasksRev: 5 },
    subEnd("t1", b, false, "list", t0 + 1_000, 4),
  );
  assert.deepEqual(other.subtasks, b, "an arm belonging to another run does not gate this run's mirror");
});

// ── audit cycle-1 finding 4: the lagging-read skip must NOT freeze the
//    expiry of the RETAINED view — settled lists expire even while the
//    owning run is busy and the file keeps reading old ──────────────────────

test("subtasksPollTick: a settled retained list expires during a lagging file read (audit cycle-1 F4)", () => {
  const t0 = 1_000_000;
  const doneList: SubtaskInfo[] = [{ id: 1, name: "mine", status: "done" }];
  // State: a SETTLED list mirrored from the armed write (rev 5), clock at
  // 1, not yet expired; the owning run is busy and armed (a long tool
  // call). The file lags behind (rev 4 — rollback / racing read).
  const state: SubtasksPollTick = {
    subtasks: doneList,
    subtasksExpired: false,
    subtasksUpdatedAt: 1,
    busyArmed: true,
    subtasksArmedSig: subtaskItemsSig(doneList),
    subtasksArmedRev: 5,
    subtasksRev: 5,
  };
  const r = subtasksPollTick({
    state,
    file: { items: [{ id: 1, name: "older rollback", status: "in-progress" }], updatedAt: 1, rev: 4 },
    lastSig: "lagging",
    now: 1_000_000,
    staleMs: 90_000,
  });
  assert.equal(r.subtasksExpired, true, "a settled list follows the quiet window even under the lagging-read skip");
  assert.equal(r.push, true, "the expiry-only flip is pushed (self-heal, not frozen)");
  assert.equal(r.disarm, false, "the lagging file still cannot supersede the armed write");
  assert.deepEqual(r.subtasks, doneList, "the older file snapshot is NOT mirrored");
  assert.equal(r.rev, 5, "the mirrored rev keeps the armed write's");
  // Once expired, agreement → no churn.
  const r2 = subtasksPollTick({
    state: { ...state, subtasksExpired: true },
    file: { items: [{ id: 1, name: "older rollback", status: "in-progress" }], updatedAt: 1, rev: 4 },
    lastSig: "lagging",
    now: 1_001_000,
    staleMs: 90_000,
  });
  assert.equal(r2.push, false, "agreement → quiet");
});

test("subtasksPollTick: the lagging-read skip still protects a LIVE retained list (F4, no over-expiry)", () => {
  const t0 = 1_000_000;
  const live: SubtaskInfo[] = [{ id: 1, name: "mine", status: "in-progress" }];
  const state: SubtasksPollTick = {
    subtasks: live,
    subtasksExpired: false,
    subtasksUpdatedAt: t0,
    busyArmed: true,
    subtasksArmedSig: subtaskItemsSig(live),
    subtasksArmedRev: 5,
    subtasksRev: 5,
  };
  // Same lagging file, same long tool call — but the retained list is
  // LIVE and owned (rev 5 = armed): the exemption applies, nothing moves.
  const r = subtasksPollTick({
    state,
    file: { items: [{ id: 1, name: "older rollback", status: "done" }], updatedAt: 1, rev: 4 },
    lastSig: "lagging",
    now: t0 + 1_000_000,
    staleMs: 90_000,
  });
  assert.equal(r.push, false, "the owned live list is untouched by the lagging read");
  assert.equal(r.subtasksExpired, false, "live + owned → exempt (the long tool call stays protected)");
  assert.equal(r.disarm, false);
});

// ── DESIGN.md "Acceptance" — the three findings, end-to-end through the
//    real applyEvent path + the driver's tick ────────────────────────────────

test("acceptance F1-legacy: a legacy file-backed result keeps the owning run's live list exempt (rev model)", () => {
  // A custom/legacy tool result carries NO details.updatedAt/rev: the TUI
  // stamps the RECEIPT time into the expiry clock and arms rev 0 (content
  // identity). The on-disk file's updatedAt is a DIFFERENT number (written
  // earlier by the tool) — under the old stamp model exact stamp matching
  // rejected the owning run's own live list during a long tool call. The
  // rev model: the clock never identifies the write, so the content-
  // matching live list stays exempt however far its updatedAt drifted.
  const t0 = 1_000_000;
  const live: SubtaskInfo[] = [{ id: 1, name: "a", status: "in-progress" }];
  const before = Date.now();
  // Legacy result: no updatedAt, no rev → arms rev 0 + content sig, clock =
  // receipt time (≫ the file's own write time).
  const run = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: t0 },
    subEnd("t1", live, false, "create"),
  );
  assert.equal(run.subtasksArmedRev, 0, "legacy result arms with NO write identity");
  assert.ok(run.subtasksUpdatedAt >= before, "the receipt time is the clock");
  // The file the tool actually wrote: same content, DIFFERENT (older)
  // updatedAt, no rev (legacy file). A long tool call: the deadline is
  // long past, the run is still in flight.
  const file = { items: live, updatedAt: t0 - 50_000 };
  const state: SubtasksPollTick = {
    subtasks: run.subtasks,
    subtasksExpired: run.subtasksExpired,
    subtasksUpdatedAt: run.subtasksUpdatedAt,
    busyArmed: subtasksBusyArmed(run),
    subtasksArmedSig: run.subtasksArmedSig,
    subtasksArmedRev: run.subtasksArmedRev,
    subtasksRev: run.subtasksRev,
  };
  // Tick 1: the poller syncs the expiry clock to the file's (pre-existing
  // behavior — the file is the clock's truth) but the list must NOT
  // expire: the exemption is content-based (rev-0 arm), so the receipt-
  // time/file-time divergence no longer rejects the owning run's own list.
  let r = subtasksPollTick({
    state,
    file,
    lastSig: JSON.stringify({ ...file, rev: 0 }),
    now: run.subtasksUpdatedAt + 90_001,
    staleMs: 90_000,
  });
  assert.equal(r.subtasksExpired, false, "the field survives the long tool call (no stamp-matching rejection)");
  assert.equal(r.disarm, false, "a legacy rev-0 arm cannot be ordered/disarmed by rev");
  // Tick 2 (driver applied tick 1's mirror): quiet, still not expired.
  r = subtasksPollTick({
    state: { ...state, subtasksUpdatedAt: file.updatedAt },
    file,
    lastSig: r.sig,
    now: run.subtasksUpdatedAt + 95_000,
    staleMs: 90_000,
  });
  assert.equal(r.push, false, "agreement → no churn");
  assert.equal(r.subtasksExpired, false, "still exempt");
});

test("acceptance F2: identical writes have distinct revs — the poller disarms on the second and the list follows the deadline", async () => {
  // Two identical writes stamped in the SAME millisecond (Date.now
  // collision): the tool gives them rev R and R+1 (the real tool's
  // lock-serialized allocation is covered in subtask-tool.test.ts; here
  // the revs are constructed fixtures for the poller's ownership rule).
  // Arming at the first, the poller observing the second (same
  // content, rev+1) DISARMS, and the list then follows the deadline rules
  // while the run stays busy.
  const t0 = 1_000_000;
  const same: SubtaskInfo[] = [{ id: 1, name: "same", status: "in-progress" }];
  // Arm at rev 5 (the run's own first write).
  const run = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: t0 },
    subEnd("t1", same, false, "create", t0, 5),
  );
  // A foreign identical rewrite in the SAME millisecond — rev 6 (what the
  // tool's lock-serialized bump guarantees for any second write).
  const file = { items: same, updatedAt: t0, rev: 6 };
  const state: SubtasksPollTick = {
    subtasks: run.subtasks,
    subtasksExpired: run.subtasksExpired,
    subtasksUpdatedAt: run.subtasksUpdatedAt,
    busyArmed: subtasksBusyArmed(run),
    subtasksArmedSig: run.subtasksArmedSig,
    subtasksArmedRev: run.subtasksArmedRev,
    subtasksRev: run.subtasksRev,
  };
  let r = subtasksPollTick({
    state, file,
    lastSig: JSON.stringify({ items: same, updatedAt: t0, rev: 5 }),
    now: t0 + 1, staleMs: 90_000,
  });
  assert.equal(r.disarm, true, "the same-content same-ms rewrite (rev+1) disarms");
  // Driver applies the disarm; past the window the list expires (the run
  // is STILL busy — no resurrection).
  const after: SubtasksPollTick = {
    subtasks: same, subtasksExpired: false, subtasksUpdatedAt: t0,
    busyArmed: false, subtasksRev: 6,
  };
  r = subtasksPollTick({ state: after, file, lastSig: JSON.stringify({ ...file, rev: 6 }), now: t0 + 92_000, staleMs: 90_000 });
  assert.equal(r.push, true);
  assert.equal(r.subtasksExpired, true, "post-disarm the list follows the deadline");
});

test("acceptance F3: older replacement is skipped (not mirrored, not disarmed); exact restore re-exempts; newer restore disarms", () => {
  // Armed at rev 5. The file rolls back to rev 4 with DIFFERENT content →
  // the tick must NOT mirror it and must NOT disarm (the display keeps the
  // owned snapshot, the arm survives for the real write). A later exact
  // restore to rev 5 with the armed content is genuinely the armed write
  // again → exempt (correct). A restore to rev 6 is a foreign write →
  // NOT exempt, and disarms.
  const t0 = 1_000_000;
  const a: SubtaskInfo[] = [{ id: 1, name: "mine", status: "in-progress" }];
  const b: SubtaskInfo[] = [{ id: 1, name: "other work", status: "in-progress" }];
  const run = applyEvent(
    { ...makeInitialState("m"), busy: true, runStartedAt: t0 },
    subEnd("t1", a, false, "create", t0, 5),
  );
  const snapshotOf = (st: TuiState): SubtasksPollTick => ({
    subtasks: st.subtasks,
    subtasksExpired: st.subtasksExpired,
    subtasksUpdatedAt: st.subtasksUpdatedAt,
    busyArmed: subtasksBusyArmed(st),
    subtasksArmedSig: st.subtasksArmedSig,
    subtasksArmedRev: st.subtasksArmedRev,
    subtasksRev: st.subtasksRev,
  });
  const state = snapshotOf(run);
  // 1) rolled-back older replacement (rev 4, different content, old clock):
  //    never accepted, arm survives.
  const rolled = { items: b, updatedAt: t0 - 5_000, rev: 4 };
  let r = subtasksPollTick({
    state, file: rolled,
    lastSig: JSON.stringify({ items: a, updatedAt: t0, rev: 5 }),
    now: t0 + 200_000, staleMs: 90_000,
  });
  assert.equal(r.push, false, "the older replacement is NOT mirrored");
  assert.equal(r.disarm, false, "an older rev cannot supersede the armed write");
  assert.equal(r.subtasksExpired, false, "the owned view survives");
  // 2) exact restore to rev 5 with the armed content → exempt (it IS the
  //    armed write — re-exempting is correct, no stale exemption revived
  //    because the older snapshot was never accepted).
  r = subtasksPollTick({
    state, file: { items: a, updatedAt: t0, rev: 5 },
    lastSig: JSON.stringify({ items: a, updatedAt: t0, rev: 5 }),
    now: t0 + 300_000, staleMs: 90_000,
  });
  assert.equal(r.subtasksExpired, false, "the exact restore (rev = armed) is the armed write → exempt");
  assert.equal(r.disarm, false, "the armed write itself never disarms");
  // 3) a restore carrying rev 6 (a foreign write at a newer rev) → NOT
  //    exempt (deadline rules) and disarms. Fresh clock → still shown,
  //    but on its own deadline, not on the exemption.
  r = subtasksPollTick({
    state, file: { items: a, updatedAt: t0 + 250_000, rev: 6 },
    lastSig: JSON.stringify({ items: a, updatedAt: t0, rev: 5 }),
    now: t0 + 250_001, staleMs: 90_000,
  });
  assert.equal(r.disarm, true, "rev > armed rev → supersede → disarm");
  assert.equal(r.subtasksExpired, false, "fresh clock → still shown (deadline rules, not the exemption)");
  // Past the window with the arm gone: expires, no resurrection.
  const after: SubtasksPollTick = {
    subtasks: a, subtasksExpired: false, subtasksUpdatedAt: t0 + 250_000,
    busyArmed: false, subtasksRev: 6,
  };
  r = subtasksPollTick({ state: after, file: { items: a, updatedAt: t0 + 250_000, rev: 6 }, lastSig: JSON.stringify({ items: a, updatedAt: t0 + 250_000, rev: 6 }), now: t0 + 340_001, staleMs: 90_000 });
  assert.equal(r.push, true);
  assert.equal(r.subtasksExpired, true, "post-disarm the restored list follows the deadline");
});

test("subtasksPollTick: an unrelated busy run does not resurrect an abandoned list (audit F1, file-backed)", () => {
  const t0 = 1_000_000;
  const abandoned = [{ id: 1, name: "a", status: "in-progress" as const }];
  const file = { items: abandoned, updatedAt: t0 };
  const sig = JSON.stringify({ ...file, rev: 0 });
  // The display expired while idle. A NEW unrelated run starts (busy,
  // but NOT armed — no subtask activity of its own) → the field stays
  // expired for the run's whole duration.
  const state = { subtasks: abandoned, subtasksExpired: true, subtasksUpdatedAt: t0, busyArmed: false };
  let r = subtasksPollTick({ state, file, lastSig: sig, now: t0 + 200_000, staleMs: 90_000 });
  assert.equal(r.push, false, "busy-but-unrelated must not resurrect the display");
  assert.equal(r.subtasksExpired, true, "the file's view is expired and stays expired");
  // Real activity (a create/mark → applyEvent arms the exemption) → the
  // run keeps the field alive.
  const armed = { ...state, subtasksExpired: false, busyArmed: true };
  r = subtasksPollTick({ state: armed, file, lastSig: sig, now: t0 + 200_000, staleMs: 90_000 });
  assert.equal(r.push, false, "armed live exemption → quiet, still shown");
  assert.equal(r.subtasksExpired, false, "the exemption protects the active workstream");
});

test("subtasksPollTick: an UNARMED busy run cannot exempt a newly-seen live list (audit F1 — the sticky-flag hole)", () => {
  // The exact F1 scenario: an external live list appears mid-run (the
  // poller never saw it; the display flag is false). The run did NOT do
  // the subtask work (busyArmed false) → the deadline applies even
  // though `busy` is true and the flag is false. The OLD signature
  // (busy && !alreadyExpired) exempted this forever.
  const t0 = 1_000_000;
  const live = [{ id: 1, name: "a", status: "in-progress" as const }];
  const file = { items: live, updatedAt: t0 };
  const state = { subtasks: [], subtasksExpired: true, subtasksUpdatedAt: 0, busyArmed: false };
  const r = subtasksPollTick({ state, file, lastSig: null, now: t0 + 200_000, staleMs: 90_000 });
  assert.equal(r.push, true, "first observation pushes the file's view");
  assert.equal(r.subtasksExpired, true, "busy alone (unarmed) does NOT exempt a foreign live list");
});

test("subtasksPollTick: same stamp, different displayed items → the file wins (audit A2)", () => {
  const t0 = 1_000_000;
  // The state shows an OLD list; the file holds a NEWER list written at
  // the SAME millisecond (a same-ms write, or applyEvent's mirror racing
  // a later file write). Neither the signature (lastSig tracks the file)
  // nor the derived flags move — only the item comparison catches it.
  const state = { subtasks: settled, subtasksExpired: false, subtasksUpdatedAt: t0 };
  const file = { items: [{ id: 1, name: "a", status: "in-progress" as const }], updatedAt: t0 };
  const r = subtasksPollTick({ state, file, lastSig: JSON.stringify({ ...file, rev: 0 }), now: t0 + 1_000, staleMs: 90_000 });
  assert.equal(r.push, true, "displayed items ≠ file items → push");
  assert.equal(r.subtasks[0]!.status, "in-progress", "the file's items win");
  // And once mirrored, they agree → quiet (no 5s churn from the new
  // comparison).
  const r2 = subtasksPollTick({
    state: { subtasks: file.items, subtasksExpired: r.subtasksExpired, subtasksUpdatedAt: t0 },
    file,
    lastSig: JSON.stringify({ ...file, rev: 0 }),
    now: t0 + 6_000,
    staleMs: 90_000,
  });
  assert.equal(r2.push, false, "agreement → quiet");
});

// ── /display-bottom field picker (the bottomFields modal) ──────────────────

test("bottomFieldsOpen: opens on the row the selection starts with (0 when empty)", () => {
  assert.equal(bottomFieldsOpen(makeInitialState("m")).bottomFields, 0);
  // selection starts with "subtasks" (the last field) → opens there
  assert.equal(bottomFieldsOpen({ ...makeInitialState("m"), bottom: ["subtasks"] }).bottomFields, 9);
  assert.equal(bottomFieldsOpen({ ...makeInitialState("m"), bottom: ["context", "model"] }).bottomFields, 0);
});

test("bottomFieldsNav: moves the highlight with wrap-around; null when closed", () => {
  const s = { ...makeInitialState("m"), bottomFields: 0 };
  assert.equal(bottomFieldsNav(s, 1)!.bottomFields, 1);
  assert.equal(bottomFieldsNav(s, -1)!.bottomFields, BOTTOM_FIELDS.length - 1); // wraps
  const last = { ...s, bottomFields: BOTTOM_FIELDS.length - 1 };
  assert.equal(bottomFieldsNav(last, 1)!.bottomFields, 0); // wraps
  assert.equal(bottomFieldsNav(last, -1)!.bottomFields, BOTTOM_FIELDS.length - 2);
  assert.equal(bottomFieldsNav(makeInitialState("m"), 1), null); // closed
});

test("bottomFieldsToggle: space toggles the highlighted field (order preserved); null when closed", () => {
  let s: TuiState = { ...makeInitialState("m"), bottomFields: 1 }; // "status"
  assert.equal(bottomFieldsToggle(makeInitialState("m")), null); // closed
  s = bottomFieldsToggle(s)!;
  assert.deepEqual(s.bottom, ["status"]);
  s = { ...s, bottomFields: 0 }; // "model"
  s = bottomFieldsToggle(s)!;
  assert.deepEqual(s.bottom, ["status", "model"], "appended — first-selection order kept");
  s = { ...s, bottomFields: 1 }; // "status" again
  s = bottomFieldsToggle(s)!;
  assert.deepEqual(s.bottom, ["model"], "removed — the rest keep their order");
});

test("bottomFieldsConfirm: enter applies (keeps the live selection) and closes; null when closed", () => {
  const s = { ...makeInitialState("m"), bottom: ["subtasks"], bottomFields: 0 };
  const c = bottomFieldsConfirm(s)!;
  assert.equal(c.bottomFields, null);
  assert.deepEqual(c.bottom, ["subtasks"], "the selection is the applied one");
  assert.equal(bottomFieldsConfirm(makeInitialState("m")), null); // closed
});

test("bottomFieldsClose: esc restores the open-time baseline (discards toggles); null when closed", () => {
  const baseline = ["subtasks"];
  const s = { ...makeInitialState("m"), bottom: ["subtasks", "model"], bottomFields: 0 };
  const c = bottomFieldsClose(s, baseline)!;
  assert.equal(c.bottomFields, null);
  assert.deepEqual(c.bottom, baseline, "the pending toggle is discarded");
  assert.equal(bottomFieldsClose({ ...makeInitialState("m"), bottomFields: null }, baseline), null); // closed
});

test("bottomFieldsMenu: one row per field, [x] when selected, * on the first-selected row", () => {
  const s = { ...makeInitialState("m"), bottom: ["subtasks"], bottomFields: 3 }; // "tokens"
  const rows = bottomFieldsMenu(s, 80);
  assert.equal(rows.length, BOTTOM_FIELDS.length);
  assert.deepEqual(
    rows.map((r) => r.line),
    [
      "  [ ] model",
      "  [ ] status",
      "  [ ] turn",
      "> [ ] tokens",
      "  [ ] context",
      "  [ ] cache",
      "  [ ] cwd",
      "  [ ] session",
      "  [ ] workers",
      "  [x] * subtasks",
    ],
  );
  assert.deepEqual(rows.map((r) => r.selected), [false, false, false, true, false, false, false, false, false, false]);
  assert.deepEqual(rows.map((r) => r.on), [false, false, false, false, false, false, false, false, false, true]);
  // closed → no rows (the frame renders nothing)
  assert.deepEqual(bottomFieldsMenu(makeInitialState("m"), 80), []);
  // an approval pending hides the picker (the input is locked then anyway)
  const appr = setApproval(s, "run rm -rf?", () => {});
  assert.deepEqual(bottomFieldsMenu(appr, 80), []);
});

test("input is locked while the display-bottom picker is open", () => {
  const s = { ...makeInitialState("m"), bottomFields: 2 };
  assert.equal(inputChar(s, "x"), s, "chars are swallowed");
  assert.equal(inputBackspace(s), s, "backspace is swallowed");
  assert.equal(inputMove(s, 1), s, "cursor moves are swallowed");
  assert.equal(submitInput(s), null, "enter confirms the picker, not a submit");
});

// ── elapsed time (header right-most item) ──────────────────────────────────

test("formatElapsedMs: s / m+ss / h+mm boundaries", () => {
  assert.equal(formatElapsedMs(0), "0s");
  assert.equal(formatElapsedMs(999), "0s");
  assert.equal(formatElapsedMs(42_000), "42s");
  assert.equal(formatElapsedMs(59_999), "59s");
  assert.equal(formatElapsedMs(60_000), "1m 00s");
  assert.equal(formatElapsedMs(157_000), "2m 37s");
  assert.equal(formatElapsedMs(3_599_000), "59m 59s");
  assert.equal(formatElapsedMs(3_600_000), "1h 00m");
  assert.equal(formatElapsedMs(3_924_000), "1h 05m");
  assert.equal(formatElapsedMs(-5_000), "0s", "negative (skewed clock) clamps");
});

test("applyEvent: agent_start sets runStartedAt, agent_end clears it", () => {
  let s = makeInitialState("m");
  assert.equal(s.runStartedAt, null);
  const t0 = Date.now();
  s = applyEvent(s, { type: "agent_start" });
  assert.equal(s.busy, true);
  assert.ok(s.runStartedAt !== null && s.runStartedAt >= t0, "runStartedAt stamped at start");
  s = applyEvent(s, { type: "agent_end", stopReason: "stop", messages: [] });
  assert.equal(s.busy, false);
  assert.equal(s.runStartedAt, null, "cleared on a clean stop");
  // every exit path clears it (the loop emits agent_end for all stopReasons)
  for (const stopReason of ["error", "aborted", "budget", "loop", "stall", "length"] as const) {
    let s2 = applyEvent(makeInitialState("m"), { type: "agent_start" });
    s2 = applyEvent(s2, { type: "agent_end", stopReason, messages: [] });
    assert.equal(s2.runStartedAt, null, `cleared on ${stopReason}`);
  }
});

// ─────────────── D33: guard-stop evidence in the stop lines (docs/08 §10) ───────────────

test("D33: agent_end loop WITH evidence → the error item names the trigger", () => {
  const s = applyEvent(
    { ...makeInitialState("m"), busy: true },
    {
      type: "agent_end",
      stopReason: "loop",
      messages: [],
      evidence: {
        guard: "identical-batch",
        signature: 'read:{"path":"x"}',
        repeats: 3,
        guardRetries: 1,
      },
    },
  );
  const last = s.items[s.items.length - 1]!;
  assert.equal(last.kind, "error");
  const text = last.kind === "error" ? last.text : "<not an error item>";
  assert.match(text, /loop: the model repeated the same tool call\(s\) 3 times in a row/);
  assert.match(text, /trigger: read:\{"path":"x"\} \(×3 in a row, after 1 auto-retry\)/);
});

test("D33: agent_end stall WITH permission evidence → tool, count, and the denial text", () => {
  const s = applyEvent(
    { ...makeInitialState("m"), busy: true },
    {
      type: "agent_end",
      stopReason: "stall",
      messages: [],
      evidence: {
        guard: "permission-stall",
        tool: "bash",
        denials: 3,
        window: 8,
        errorExcerpt: "bash: exit code 1 Operation not permitted",
      },
    },
  );
  const last = s.items[s.items.length - 1]!;
  const text = last.kind === "error" ? last.text : "<not an error item>";
  assert.match(text, /stall: the same tool failed 3 times with a permission denial/);
  assert.match(text, /trigger: bash failed 3\/8 calls — bash: exit code 1 Operation not permitted/);
});

test("D33: agent_end stall with repeat-failure evidence → the H2 wording, not the sandbox wall", () => {
  const s = applyEvent(
    { ...makeInitialState("m"), busy: true },
    {
      type: "agent_end",
      stopReason: "stall",
      messages: [],
      evidence: {
        guard: "repeat-failure",
        tool: "bash",
        repeats: 3,
        window: 8,
        errorExcerpt: "test failed: expected 1, got 2",
      },
    },
  );
  const last = s.items[s.items.length - 1]!;
  const text = last.kind === "error" ? last.text : "<not an error item>";
  assert.match(text, /identical error 3 times/);
  assert.doesNotMatch(text, /--no-sandbox/, "an H2 stall is not the sandbox wall");
  assert.match(text, /trigger: bash failed 3\/8 calls — test failed: expected 1, got 2/);
});
