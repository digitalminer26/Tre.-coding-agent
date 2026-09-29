/**
 * WS9 — compaction logic (src/context/compact.ts) + the compactContext
 * driver. All in-process: fakeStream (no network).
 *
 * Covered:
 *   - estimateTokens / shouldCompact (the trigger)
 *   - calibrateCharsPerToken (A1: dense → <4, sparse → clamps 4, degenerate
 *     → 4, last-assistant exclusion) + compactContext honoring it
 *   - planCompaction invariants: unit boundaries (a toolCall is never split
 *     from its result), the last user message survives (verbatim, or via the
 *     summary when it is the only prompt), toSummarize non-empty, kept ≥ 2
 *     units, keepTokens target, short context → no plan
 *   - compactContext: keep target capped by the model's window
 *   - renderTranscript / summarizePrompt (incl. iterative)
 *   - extractFileOps (deterministic read/modified paths) + the structured
 *     summarizePrompt sections (GOAL/DONE/STATE/FILES/NEXT, FILES verbatim)
 *   - compactContext: happy path (silent call, no tools), not-needed,
 *     summary-call failure and empty summary → undefined, never throws (I3)
 */
import test from "node:test";
import assert from "node:assert/strict";
import type {
  AgentMessage,
  AssistantMessage,
  LlmContext,
  ModelConfig,
  StreamFn,
  Tool,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "../src/types.js";
import {
  SUMMARY_MARKER,
  calibrateCharsPerToken,
  compactContext,
  estimateTokens,
  extractFileOps,
  isSummaryMessage,
  makeSummaryMessage,
  planCompaction,
  ruleBasedShrink,
  renderTranscript,
  shouldCompact,
  summarizePrompt,
  SUMMARIZER_SYSTEM,
  type CompactionPlan,
} from "../src/context/compact.js";
import { fakeStream } from "./fake-stream.js";

const MODEL: ModelConfig = {
  id: "fake-model",
  provider: "fake",
  baseUrl: "http://fake.invalid/v1",
  api: "openai-completions",
  contextWindow: 2000,
  maxTokens: 100,
};

const user = (s: string): UserMessage => ({ role: "user", content: s, timestamp: 1 });
const usageOf = (totalTokens: number): Usage => ({
  input: Math.max(1, totalTokens - 10),
  output: 10,
  totalTokens,
});
const assistantText = (s: string, usage?: Usage): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: s }],
  model: "fake-model",
  provider: "fake",
  stopReason: "stop",
  timestamp: 2,
  ...(usage ? { usage } : {}),
});
const assistantToolCall = (
  name: string,
  args: Record<string, unknown>,
  usage?: Usage,
): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "toolCall", id: "call_1", name, arguments: args }],
  model: "fake-model",
  provider: "fake",
  stopReason: "toolUse",
  timestamp: 3,
  ...(usage ? { usage } : {}),
});
const toolResult = (text: string, isError = false): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "bash",
  content: [{ type: "text", text }],
  isError: isError || undefined,
  timestamp: 4,
});

/** A capturing wrapper: records each request's context, delegates the rest. */
function withCapture(fn: StreamFn): { fn: StreamFn; ctxs: LlmContext[] } {
  const ctxs: LlmContext[] = [];
  const wrapped = (m: ModelConfig, ctx: LlmContext, o: { apiKey?: string; signal: AbortSignal }) => {
    ctxs.push({ ...ctx, messages: [...ctx.messages] });
    return fn(m, ctx, o);
  };
  return { fn: wrapped, ctxs };
}

test("estimateTokens: ~chars/4, tool results count their text", () => {
  assert.equal(estimateTokens([user("a".repeat(4000))]), 1000);
  assert.ok(estimateTokens([toolResult("x".repeat(8000))]) >= 2000);
  assert.equal(estimateTokens([]), 0);
});

test("estimateTokens: honors a calibrated charsPerToken", () => {
  assert.equal(estimateTokens([user("a".repeat(4000))], 2), 2000);
  assert.equal(estimateTokens([user("a".repeat(4000))], 8), 500);
});

test("calibrateCharsPerToken: dense sample → below 4; sparse → clamps at 4", () => {
  // est: 4000-char user (1000 est) + 16000-char system (4000 est) = 5000
  // est; actual prompt = 10000 tokens → dense content (2× the estimate),
  // cpt = 4*5000/10000 = 2.
  const dense = calibrateCharsPerToken(
    usageOf(10010), // input 10000, output 10
    [user("a".repeat(4000))],
    16000, // system prompt char count
  );
  assert.equal(dense, 2);
  // Sparse: the same 5000 est tokens measured only 1250 actual prompt
  // tokens → 4*5000/1250 = 16 → clamped at 4 (the chars/4 default).
  const sparse = calibrateCharsPerToken(
    usageOf(1260), // input 1250, output 10
    [user("a".repeat(4000))],
    16000,
  );
  assert.equal(sparse, 4);
});

test("calibrateCharsPerToken: degenerate samples → 4 (uncalibrated)", () => {
  // no messages, no system → est 0
  assert.equal(calibrateCharsPerToken(usageOf(100), [], 0), 4);
  // zero usage
  assert.equal(calibrateCharsPerToken({ input: 0, output: 0, totalTokens: 0 }, [user("abc")], 0), 4);
});

test("calibrateCharsPerToken: excludes the last assistant message from the estimate", () => {
  // context includes the assistant message whose usage is the sample: its
  // tokens were NOT in the prompt. est = 4000-char user (1000) only;
  // actual 1000 → cpt 4 (ratio 1).
  const cpt = calibrateCharsPerToken(
    usageOf(1010), // input 1000, output 10
    [user("a".repeat(4000)), assistantText("b".repeat(4000))],
    0,
  );
  assert.equal(cpt, 4);
});

test("shouldCompact: no usage → false; under budget → false; over → true", () => {
  assert.equal(shouldCompact(undefined, 2000, 100), false);
  assert.equal(shouldCompact(usageOf(500), 2000, 100), false); // 500+100+1024 < 2000
  assert.equal(shouldCompact(usageOf(1500), 2000, 100), true); // 1500+100+1024 > 2000
});

test("planCompaction: context too short (fewer than 3 units) → undefined", () => {
  assert.equal(planCompaction([user("q")]), undefined);
  assert.equal(planCompaction([user("q"), assistantText("a")]), undefined);
  assert.equal(
    planCompaction([user("q"), assistantToolCall("bash", { command: "ls" }), toolResult("ok")]),
    undefined, // 3 messages but only 2 units
  );
});

test("planCompaction: keeps units whole, keeps the last user message, folds ≥1 unit", () => {
  const ctx: AgentMessage[] = [
    user("old question"), // unit 0
    assistantText("old answer"), // unit 1
    user("second question"), // unit 2
    assistantToolCall("bash", { command: "ls" }), // unit 3
    toolResult("file.txt"),
    assistantText("here you go"), // unit 4
  ];
  const plan = planCompaction(ctx, 8192);
  assert.ok(plan, "a plan exists for a 5-unit context");
  assert.equal(plan.toSummarize.length > 0, true, "something is folded");
  assert.equal(plan.kept.length >= 2, true);
  // unit boundaries: kept[0] must not be a toolResult, toSummarize must not END mid-unit
  assert.notEqual(plan.kept[0]!.role, "toolResult", "kept starts on a unit boundary");
  assert.notEqual(plan.toSummarize[plan.toSummarize.length - 1]!.role, "toolResult");
  // the last user message survives
  const lastUser = ctx[ctx.length - 3]!; // "second question"
  assert.ok(plan.kept.includes(lastUser), "the current task (last user message) is kept");
  // no overlap, no loss: toSummarize + kept == context
  assert.deepEqual([...plan.toSummarize, ...plan.kept], ctx);
  // small context with a big keepTokens → keepFrom is the 2nd unit (fold only unit 0)
  assert.equal(plan.keepFrom, 1);
  assert.deepEqual(plan.toSummarize, [ctx[0]!]);
});

test("planCompaction: single-prompt tool loop — the only user message folds into the summary", () => {
  // The ONLY user message (index 0) may be folded: forcing it into kept
  // (keepFrom 0) would make compaction impossible for single-prompt runs —
  // the task survives via the summary (the summarizer must record the goal).
  const ctx: AgentMessage[] = [
    user("the only question"),
    assistantText("a1"),
    assistantToolCall("bash", { command: "ls" }),
    toolResult("ok"),
    assistantText("done"),
  ];
  const plan = planCompaction(ctx, 8192);
  assert.ok(plan, "a single-prompt loop CAN compact");
  assert.equal(plan.toSummarize[0]!.role, "user", "the task prompt is folded");
  assert.ok(!plan.kept.includes(ctx[0]!), "the prompt is not kept verbatim");
  assert.equal(plan.kept[0]!.role, "assistant", "kept starts on a unit boundary");
  assert.deepEqual([...plan.toSummarize, ...plan.kept], ctx);
});

test("planCompaction: big keepTokens target is honored (keeps at least that many estimated tokens)", () => {
  const big = "x".repeat(4000); // 1000 estimated tokens each
  const ctx: AgentMessage[] = [
    user("old " + "y".repeat(4000)), // ~1000
    assistantText(big), // 1000
    user("new " + "y".repeat(4000)), // ~1000
    assistantText(big), // 1000
    user("current task"),
    assistantText("ok", usageOf(50)),
  ];
  const plan = planCompaction(ctx, 3000);
  assert.ok(plan);
  assert.ok(estimateTokens(plan.kept) >= 2000, "the kept suffix is substantial");
  assert.ok(estimateTokens(plan.toSummarize) > 0);
  assert.notEqual(plan.kept[0]!.role, "toolResult");
});

test("renderTranscript: user text, tool calls with args, results incl. (ERROR)", () => {
  const t = renderTranscript([
    user("do the thing"),
    assistantToolCall("bash", { command: "ls -la" }),
    toolResult("file.txt"),
    toolResult("boom", true),
  ]);
  assert.match(t, /\[User\] do the thing/);
  assert.match(t, /\[Assistant → tool\] bash/);
  assert.match(t, /"command":\s*"ls -la"/);
  assert.match(t, /\[Tool result: bash\] file\.txt/);
  assert.match(t, /\[Tool result: bash \(ERROR\)\] boom/);
});

test("renderTranscript: long messages are middle-truncated (head + tail survive)", () => {
  // line = "[User] HHHHHHHHHHMIDTTTTTTTTTT" (30 chars); perMessageChars 27
  // clips to head(13) + tail(13) — MID (indices 17-19) survives in the tail.
  const t = renderTranscript([user("H".repeat(10) + "MID" + "T".repeat(10))], { perMessageChars: 27 });
  assert.match(t, /MID/);
  assert.match(t, /truncated/);
  assert.doesNotMatch(t, /H{10}/, "the middle was cut");
});

test("extractFileOps: read → read, write/edit → modified; deduped, first-seen order", () => {
  const ctx: AgentMessage[] = [
    user("q"),
    assistantToolCall("read", { path: "a.ts" }),
    toolResult("..."),
    assistantToolCall("write", { path: "b.ts", content: "x" }),
    toolResult("ok"),
    assistantToolCall("read", { path: "a.ts" }), // deduped
    assistantToolCall("edit", { path: "c.ts", oldText: "x", newText: "y" }),
    assistantToolCall("bash", { command: "cat a.ts" }), // not parsed
    assistantToolCall("read", { offset: 1 }), // no path arg — ignored
    assistantToolCall("read", { path: "  " }), // whitespace path — ignored
  ];
  const ops = extractFileOps(ctx);
  assert.deepEqual(ops.read, ["a.ts"]);
  assert.deepEqual(ops.modified, ["b.ts", "c.ts"]);
});

test("extractFileOps: caps each list at 50, first-seen order", () => {
  const ctx: AgentMessage[] = [];
  for (let i = 0; i < 60; i++) {
    ctx.push(assistantToolCall("read", { path: `f${i}.ts` }));
    ctx.push(toolResult("ok"));
  }
  const ops = extractFileOps(ctx);
  assert.equal(ops.read.length, 50);
  assert.equal(ops.read[0], "f0.ts");
  assert.equal(ops.read[49], "f49.ts");
  assert.equal(ops.modified.length, 0);
});

test("summarizePrompt: contains the transcript; iterative asks to fold the earlier summary", () => {
  const plan = planCompaction(
    [user("a"), assistantText("b"), user("c"), assistantText("d"), user("e"), assistantText("f")],
    8192,
  )!;
  const p = summarizePrompt(plan);
  assert.match(p, /TRANSCRIPT/);
  assert.match(p, /User's goal/i);
  const iterative = { ...plan, isIterative: true };
  assert.match(summarizePrompt(iterative), /UPDATED summary/);
  assert.doesNotMatch(p, /UPDATED summary/);
});

test("summarizePrompt: structured sections + deterministic FILES section (verbatim)", () => {
  // Hand-built plan: the planner's keep-walk always keeps from the 2nd unit
  // (and the last user message), so a small context would never fold the
  // tool calls into toSummarize — the prompt is tested on a direct plan.
  const plan: CompactionPlan = {
    keepFrom: 3,
    toSummarize: [
      user("fix the bug"),
      assistantToolCall("read", { path: "src/a.ts" }),
      toolResult("code"),
      assistantToolCall("edit", { path: "src/b.ts", oldText: "x", newText: "y" }),
      toolResult("ok"),
    ],
    kept: [user("now check the tests"), assistantText("ok", usageOf(10))],
    isIterative: false,
  };
  const p = summarizePrompt(plan);
  for (const s of ["GOAL", "DONE", "STATE", "FILES", "NEXT"]) assert.match(p, new RegExp(`\\b${s}\\b`));
  assert.match(p, /copy the FILES section below VERBATIM/);
  assert.match(p, /read: src\/a\.ts/);
  assert.match(p, /modified: src\/b\.ts/);
  assert.match(p, /extracted from the transcript — verified/);
});

test("summarizePrompt: no file ops → no FILES section", () => {
  const plan: CompactionPlan = {
    keepFrom: 1,
    toSummarize: [user("a"), assistantText("b")],
    kept: [user("c"), assistantText("d")],
    isIterative: false,
  };
  const p = summarizePrompt(plan);
  assert.doesNotMatch(p, /FILES \(extracted/);
});

test("makeSummaryMessage / isSummaryMessage: marker round-trip", () => {
  const m = makeSummaryMessage("the summary", 123);
  assert.ok(m.content.startsWith(SUMMARY_MARKER));
  assert.match(m.content, /the summary/);
  assert.equal(isSummaryMessage(m), true);
  assert.equal(isSummaryMessage(user("plain")), false);
  assert.equal(isSummaryMessage(assistantText(SUMMARY_MARKER)), false);
});

test("compactContext: usage under budget → undefined, no LLM call", async () => {
  const ctx: AgentMessage[] = [
    user("q1"),
    assistantText("a1", usageOf(100)),
    user("q2"),
    assistantText("a2", usageOf(200)),
  ];
  const { fn, ctxs } = withCapture(fakeStream([{ type: "text", text: "should not be used" }]));
  const r = await compactContext({ streamFn: fn, model: MODEL, signal: new AbortController().signal, context: ctx });
  assert.equal(r, undefined);
  assert.equal(ctxs.length, 0, "no summarizer call");
});

test("compactContext: over budget → silent summary call (no tools, summarizer prompt), returns kept", async () => {
  const ctx: AgentMessage[] = [
    user("old question"),
    assistantText("old answer"),
    user("second question"),
    assistantToolCall("bash", { command: "ls" }, usageOf(1900)),
    toolResult("file.txt"),
  ];
  const { fn, ctxs } = withCapture(
    fakeStream([{ type: "text", text: "SUMMARY: the agent listed files earlier." }]),
  );
  const r = await compactContext({ streamFn: fn, model: MODEL, signal: new AbortController().signal, context: ctx });
  assert.ok(r, "compaction happened");
  assert.match(r!.summary, /SUMMARY: the agent listed files earlier\.$/);
  assert.equal(r!.tokensBefore, 1900);
  assert.equal(ctxs.length, 1, "exactly one (silent) LLM call");
  assert.deepEqual(ctxs[0]!.tools, [] as Tool[], "the summary call has no tools");
  assert.match(ctxs[0]!.systemPrompt, /summarize/i);
  assert.equal(ctxs[0]!.messages.length, 1);
  assert.equal(ctxs[0]!.messages[0]!.role, "user");
  assert.match(String(ctxs[0]!.messages[0]!.content), /old question/);
  assert.doesNotMatch(String(ctxs[0]!.messages[0]!.content), /file\.txt/, "kept tail is not re-sent");
  assert.deepEqual(r!.kept, ctx.slice(1), "the kept suffix is a suffix of the context");
});

test("compactContext: summary call fails (stream error) → undefined, never throws (I3)", async () => {
  const ctx: AgentMessage[] = [
    user("q1"),
    assistantText("a1"),
    user("q2"),
    assistantToolCall("bash", { command: "ls" }, usageOf(1900)),
    toolResult("ok"),
  ];
  const fn = fakeStream([{ type: "error", message: "summarizer is down" }]);
  const r = await compactContext({ streamFn: fn, model: MODEL, signal: new AbortController().signal, context: ctx });
  assert.equal(r, undefined);
});

test("compactContext: keep target is capped by the model's window (small-window models)", async () => {
  // window 4000 / maxTokens 100 → cap = max(512, 4000-100-1024) = 2876.
  // With the uncapped 8192 default the walk would end at unit 1 (kept ~6k
  // est — larger than the window); with the cap it stops at unit 2.
  const small: ModelConfig = { ...MODEL, contextWindow: 4000, maxTokens: 100 };
  const big = "x".repeat(8000); // ~2000 estimated tokens
  const ctx: AgentMessage[] = [
    user("old " + "y".repeat(8000)), // ~2000, unit 0
    assistantText(big), // ~2000, unit 1
    user("mid " + "y".repeat(8000)), // ~2000, unit 2
    assistantText(big), // ~2000, unit 3
    user("current task"), // unit 4
    assistantText("ok", usageOf(3100)), // unit 5 (trigger: 3100+100+1024 > 4000)
  ];
  const fn = fakeStream([{ type: "text", text: "SUMMARY." }]);
  const r = await compactContext({ streamFn: fn, model: small, signal: new AbortController().signal, context: ctx });
  assert.ok(r, "compaction happened");
  assert.equal(r!.kept[0], ctx[2]!, "the keep window stops at the capped size (unit 2)");
  assert.deepEqual(r!.kept, ctx.slice(2), "kept is the suffix from unit 2");
});

test("compactContext: calibrated charsPerToken shrinks the keep window for dense content", async () => {
  // Each big message ~2000 est tokens at chars/4. With cpt 2 (dense), each
  // counts ~4000, so the keep walk stops earlier (keeps fewer messages)
  // than the uncalibrated default.
  const big = "x".repeat(8000); // ~2000 est at chars/4
  const ctx: AgentMessage[] = [
    user("old " + "y".repeat(8000)), // unit 0
    assistantText(big), // unit 1
    user("mid " + "y".repeat(8000)), // unit 2
    assistantText(big), // unit 3
    user("current task"), // unit 4
    assistantText("ok", usageOf(3100)), // unit 5 (trigger: 3100+100+1024 > 4000)
  ];
  const small: ModelConfig = { ...MODEL, contextWindow: 4000, maxTokens: 100 };
  const sig = new AbortController().signal;
  const rDefault = await compactContext({
    streamFn: fakeStream([{ type: "text", text: "SUMMARY." }]),
    model: small,
    signal: sig,
    context: ctx,
  });
  const rDense = await compactContext({
    streamFn: fakeStream([{ type: "text", text: "SUMMARY." }]),
    model: small,
    signal: sig,
    context: ctx,
    charsPerToken: 2,
  });
  assert.ok(rDefault && rDense);
  assert.ok(
    rDense!.kept.length < rDefault!.kept.length,
    `dense cpt keeps fewer messages (${rDense!.kept.length} < ${rDefault!.kept.length})`,
  );
});

// ─────────────────────────────── D: failure escalation ───────────────────────────────

test("ruleBasedShrink: context too short → undefined (no plan)", () => {
  assert.equal(ruleBasedShrink([user("q"), assistantText("a")], 8192, 4), undefined);
});

test("ruleBasedShrink: same keep plan as planCompaction; marker; strictly smaller; file ops", () => {
  // Sizing: the tail (u2 + a2 = 8500 est) exceeds keepTokens (8192) so the
  // keep window stops at u2 and BOTH toolCall units are FOLDED (their file
  // ops land in the notice).
  const ctx: AgentMessage[] = [
    user("q1".repeat(200)),
    assistantToolCall("read", { path: "src/a.ts" }),
    toolResult("r".repeat(32000)),
    assistantToolCall("write", { path: "src/b.ts" }),
    toolResult("bbb"),
    user("q2".repeat(17000)),
    assistantText("a2".repeat(17000)),
  ];
  const shrink = ruleBasedShrink(ctx, 8192, 4);
  assert.ok(shrink);
  const plan = planCompaction(ctx, 8192, 4)!;
  assert.equal(shrink!.kept.length, plan.kept.length, "same keep plan (unit boundary)");
  assert.deepEqual(shrink!.kept, plan.kept);
  // The notice is a summary message (replay / iterative fold-in keep working).
  assert.ok(isSummaryMessage(shrink!.notice));
  assert.ok(shrink!.notice.content.startsWith(SUMMARY_MARKER));
  // The context strictly shrinks.
  assert.ok(
    estimateTokens([shrink!.notice, ...shrink!.kept]) < estimateTokens(ctx),
    "shrunken context is smaller than the original",
  );
  // The folded prefix's file ops survive in the notice (C3).
  assert.match(shrink!.notice.content, /src\/a\.ts/);
  assert.match(shrink!.notice.content, /src\/b\.ts/);
  // Unit boundaries intact: kept starts on a unit boundary, never a toolResult.
  assert.notEqual(shrink!.kept[0]!.role, "toolResult");
});

test("summarizePrompt: transcriptOpts shrink the prompt (D retry)", () => {
  const long = "x".repeat(5000);
  const ctx: AgentMessage[] = [
    user(long),
    assistantText("a".repeat(5000)),
    user("q2"),
    assistantText("a2"),
  ];
  const plan = planCompaction(ctx, 8192, 4)!;
  const full = summarizePrompt(plan);
  const shrunken = summarizePrompt(plan, { perMessageChars: 750, totalChars: 12000 });
  assert.ok(shrunken.length < full.length, "shrunken prompt is smaller");
  assert.ok(shrunken.length < 12000 + 2000, "bounded by totalChars + section overhead");
});

test("compactContext: transcriptOpts pass through to the summarizer prompt", async () => {
  const long = "x".repeat(5000);
  const ctx: AgentMessage[] = [
    user(long),
    assistantText("a".repeat(5000)),
    user("q2"),
    assistantToolCall("bash", { command: "ls" }, usageOf(1900)),
    toolResult("ok"),
  ];
  const { fn, ctxs } = withCapture(
    fakeStream([{ type: "text", text: "SUMMARY." }, { type: "text", text: "SUMMARY2." }]),
  );
  const sig = new AbortController().signal;
  await compactContext({ streamFn: fn, model: MODEL, signal: sig, context: ctx });
  await compactContext({
    streamFn: fn,
    model: MODEL,
    signal: sig,
    context: ctx,
    transcriptOpts: { perMessageChars: 750, totalChars: 12000 },
  });
  assert.equal(ctxs.length, 2);
  const first = ctxs[0]!.messages[0]!;
  const second = ctxs[1]!.messages[0]!;
  assert.equal(first.role, "user");
  assert.equal(second.role, "user");
  assert.ok(
    (second.content.length < first.content.length),
    "the retry prompt is smaller than the first",
  );
});

test("compactContext: empty summary text → undefined (skip, keep context)", async () => {
  const ctx: AgentMessage[] = [
    user("q1"),
    assistantText("a1"),
    user("q2"),
    assistantToolCall("bash", { command: "ls" }, usageOf(1900)),
    toolResult("ok"),
  ];
  const fn = fakeStream([{ type: "text", text: "   " }]);
  const r = await compactContext({ streamFn: fn, model: MODEL, signal: new AbortController().signal, context: ctx });
  assert.equal(r, undefined);
});
