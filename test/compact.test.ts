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
  estimatePromptOverheadTokens,
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

test("estimatePromptOverheadTokens: system prompt + tool schemas (name/description/parameters)", () => {
  // No tools: just the system prompt, chars/cpt.
  assert.equal(estimatePromptOverheadTokens(400, []), 100);
  // One tool: name + description + JSON.stringify(parameters) chars, then
  // ceil'd per part (system and tools are ceil'd SEPARATELY — the CLI's
  // original expression). 10 + 20 + 50 = 80 chars → 20 tokens.
  const tool = { name: "read", description: "d".repeat(20), parameters: { type: "object", properties: { path: { type: "string" } } } };
  const toolChars = tool.name.length + tool.description.length + JSON.stringify(tool.parameters).length;
  assert.equal(estimatePromptOverheadTokens(400, [tool]), 100 + Math.ceil(toolChars / 4));
  // Calibrated cpt scales both parts.
  assert.equal(estimatePromptOverheadTokens(400, [tool], 2), 200 + Math.ceil(toolChars / 2));
  // Zero system prompt: only the tools count.
  assert.equal(estimatePromptOverheadTokens(0, [tool]), Math.ceil(toolChars / 4));
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
  // The rendered line includes the 7-character [User] prefix; preserve the
  // head and tail around the middle-truncation marker.
  const t = renderTranscript([user("H".repeat(20) + "X".repeat(20) + "T".repeat(20) + "MID")], { perMessageChars: 40 });
  assert.match(t, /MID/);
  assert.match(t, /truncated/);
  assert.doesNotMatch(t, /X{10}/, "the middle was cut");
});

test("extractFileOps: read → read, write/edit → modified; deduped, first-seen order", () => {
  const ctx: AgentMessage[] = [
    user("q"),
    assistantToolCall("read", { path: "a.ts" }),
    toolResult("..."),
    assistantToolCall("write", { path: "b.ts", content: "x" }),
    toolResult("ok"),
    assistantToolCall("read", { path: "a.ts" }), // deduped
    toolResult("read ok"),
    assistantToolCall("edit", { path: "c.ts", oldText: "x", newText: "y" }),
    toolResult("edit ok"),
    assistantToolCall("bash", { command: "cat a.ts" }), // not parsed
    toolResult("bash ok"),
    assistantToolCall("read", { offset: 1 }), // no path arg — ignored
    toolResult("read ok"),
    assistantToolCall("read", { path: "  " }), // whitespace path — ignored
    toolResult("read ok"),
  ];
  const ops = extractFileOps(ctx);
  assert.deepEqual(ops.read, ["a.ts"]);
  assert.deepEqual(ops.modified, ["b.ts", "c.ts"]);
});

test("extractFileOps: a later reused call id cannot certify a call without an adjacent result", () => {
  const mkCall = (path: string): AgentMessage => ({ role: "assistant", content: [{ type: "toolCall", id: "same", name: "edit", arguments: { path } }], model: "fake", provider: "fake", stopReason: "toolUse", timestamp: 1 });
  const result: AgentMessage = { role: "toolResult", toolCallId: "same", toolName: "edit", content: [{ type: "text", text: "ok" }], timestamp: 2 };
  assert.deepEqual(extractFileOps([mkCall("unverified.ts"), mkCall("verified.ts"), result]), { read: [], modified: ["verified.ts"] });
});

test("extractFileOps: a path may be both read and modified; failed tools are excluded", () => {
  const ctx: AgentMessage[] = [
    assistantToolCall("read", { path: "a.ts" }),
    toolResult("ok"),
    assistantToolCall("edit", { path: "a.ts" }),
    toolResult("denied", true),
    assistantToolCall("write", { path: "b.ts" }),
    toolResult("ok", true),
  ];
  assert.deepEqual(extractFileOps(ctx), { read: ["a.ts"], modified: [] });
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

test("A2: renderTranscript drops thinking by default; includeThinking restores it", () => {
  const think: AssistantMessage = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "SECRET-REASONING" }, { type: "text", text: "answer" }],
    model: "fake-model",
    provider: "fake",
    stopReason: "stop",
    timestamp: 2,
  };
  const t = renderTranscript([think]);
  assert.doesNotMatch(t, /SECRET-REASONING/, "thinking is excluded by default");
  assert.match(t, /\[Assistant\] answer/);
  const t2 = renderTranscript([think], { includeThinking: true });
  assert.match(t2, /\[Assistant thought\] SECRET-REASONING/);
});

test("A2: summarizePrompt never includes thinking (even if the model emits it)", () => {
  const plan: CompactionPlan = {
    keepFrom: 1,
    toSummarize: [
      user("q"),
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "SECRET-REASONING" }, { type: "text", text: "a" }],
        model: "fake-model",
        provider: "fake",
        stopReason: "stop",
        timestamp: 2,
      },
    ],
    kept: [user("c"), assistantText("d")],
    isIterative: false,
  };
  assert.doesNotMatch(summarizePrompt(plan), /SECRET-REASONING/);
});

test("A3: tool results are middle-truncated at toolResultChars (default 2000, head + tail survive)", () => {
  const head = "IMPORTS-HEAD";
  const tail = "FINAL-ERROR";
  const body = "x".repeat(10000);
  const t = renderTranscript([toolResult(head + body + tail)]);
  assert.match(t, /IMPORTS-HEAD/, "the head survives");
  assert.match(t, /FINAL-ERROR/, "the tail survives");
  assert.match(t, /truncated/, "the middle was cut");
  // The clip is 2000 total: the surviving x's (head + tail halves) are far
  // below the 10000 in the middle.
  const xCount = (t.match(/x/g) ?? []).length;
  assert.ok(xCount < 2000, `only the clipped head+tail survive (${xCount} < 2000)`);
  // The clip is at 2000, not the 1500 per-message default.
  const t1500 = renderTranscript([toolResult(head + body + tail)], { toolResultChars: 1500 });
  assert.ok(t.length > t1500.length, "2000 keeps more than 1500");
  // Short results are unchanged.
  assert.match(renderTranscript([toolResult("short ok")]), /\[Tool result: bash\] short ok/);
});

test("A3: summarizePrompt scales totalChars to the model's window", () => {
  // 30 lines of ~1000 chars each: under the per-message clip (1500), over
  // the small-window total (24000), under the big-window total (32768).
  const many: AgentMessage[] = [];
  for (let i = 0; i < 30; i++) many.push(user(`m${i} ` + "a".repeat(1000)));
  const plan: CompactionPlan = {
    keepFrom: 1,
    toSummarize: many,
    kept: [user("c"), assistantText("d")],
    isIterative: false,
  };
  // Small window (2000): totalChars = max(24000, 500) = 24000.
  const pSmall = summarizePrompt(plan, undefined, 2000);
  // Big window (131072): totalChars = 32768 — the transcript survives longer.
  const pBig = summarizePrompt(plan, undefined, 131072);
  assert.ok(pBig.length > pSmall.length, "the bigger window keeps more of the transcript");
  // D retry's explicit totalChars wins over the window-derived one.
  const pRetry = summarizePrompt(plan, { totalChars: 1000 }, 131072);
  assert.ok(pRetry.length < pBig.length);
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
    // The folded prefix must be substantial: the candidate (marker +
    // summary + kept) must be a STRICT reduction of the old context.
    user("old question " + "y".repeat(3000)),
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

test("compactContext: the keep budget is a planning target, not a hard guard", async () => {
  // The kept suffix (atomic units can't be split) may exceed the keep
  // budget; compaction is best-effort and returns the smaller context.
  // Here the tail units are each larger than the tiny budget, so the kept
  // suffix far exceeds it — the result is still produced (the folded
  // prefix is large enough that the candidate is a strict reduction).
  const ctx: AgentMessage[] = [
    user("old " + "o".repeat(4000)),
    assistantText("old " + "a".repeat(4000)),
    user("current".repeat(500)),
    assistantText("tail".repeat(500)),
  ];
  const r = await compactContext({
    streamFn: fakeStream([{ type: "text", text: "a deliberately long summary" }]),
    model: MODEL,
    signal: new AbortController().signal,
    context: ctx,
    keepTokens: 5,
    force: true,
  });
  assert.ok(r, "the compacted context is returned even over the keep budget");
  assert.ok(estimateTokens(r!.kept) > 5, "the kept suffix exceeds the tiny budget");
  assert.ok(r!.estimatedTokensAfter > 5, "the estimate exceeds the target");
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
  // A large window: the first prompt's transcript budget is window-derived
  // (huge), so the FULL ~16k-char transcript goes in; the retry's explicit
  // totalChars (12000) is the smaller hard cap and visibly shrinks it.
  const big: ModelConfig = { ...MODEL, contextWindow: 131072 };
  const long = "x".repeat(8000);
  const ctx: AgentMessage[] = [
    user(long),
    assistantText("a".repeat(8000)),
    user("q2"),
    assistantToolCall("bash", { command: "ls" }, usageOf(1900)),
    toolResult("ok"),
  ];
  const { fn, ctxs } = withCapture(
    fakeStream([{ type: "text", text: "SUMMARY." }, { type: "text", text: "SUMMARY2." }]),
  );
  const sig = new AbortController().signal;
  await compactContext({ streamFn: fn, model: big, signal: sig, context: ctx, force: true });
  await compactContext({
    streamFn: fn,
    model: big,
    signal: sig,
    context: ctx,
    transcriptOpts: { perMessageChars: 750, totalChars: 12000 },
    force: true,
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
  assert.match(second.content, /truncated/, "the retry clipped the transcript to its totalChars");
});

test("compactContext: calibrated dense transcripts are clipped to fit before the request guard", async () => {
  const denseModel: ModelConfig = { ...MODEL, contextWindow: 12000, maxTokens: 100 };
  const ctx: AgentMessage[] = [
    user("old goal"),
    ...Array.from({ length: 10 }, () => assistantText("x".repeat(12000))),
  ];
  let calls = 0;
  let promptChars = 0;
  const fn: StreamFn = (model, context, options) => {
    calls++;
    const first = context.messages[0];
    if (first?.role === "user") promptChars = first.content.length;
    return fakeStream([{ type: "text", text: "SUMMARY." }])(model, context, options);
  };
  const r = await compactContext({
    streamFn: fn,
    model: denseModel,
    signal: new AbortController().signal,
    context: ctx,
    keepTokens: 1,
    charsPerToken: 1,
    force: true,
    transcriptOpts: { perMessageChars: 12000, totalChars: 12000, toolResultChars: 12000 },
  });
  assert.equal(calls, 1, "the request fits after calibrated clipping rather than being rejected");
  assert.ok(promptChars > 0 && promptChars < 12000, `prompt was clipped (${promptChars} chars)`);
  assert.ok(r, "the successful summary is accepted");
});

test("compactContext: truncated summary with partial text is rejected", async () => {
  const ctx: AgentMessage[] = [
    user("old goal " + "g".repeat(3000)), assistantText("old answer"), user("current"), assistantText("tail"),
  ];
  const partial = assistantText("partial GOAL only");
  const fn: StreamFn = async function* () {
    yield { type: "text_delta", delta: "partial GOAL only", partial };
    yield { type: "done", message: { ...partial, stopReason: "length" } };
  };
  const r = await compactContext({
    streamFn: fn, model: MODEL, signal: new AbortController().signal, context: ctx, force: true,
  });
  assert.equal(r, undefined, "an incomplete summary must not replace history");
});

test("renderTranscript: zero and tiny clip limits never exceed their limit", () => {
  const source = "secret-content-".repeat(100);
  for (const limit of [0, 1, 2, 3, 32]) {
    const rendered = renderTranscript([user(source)], { totalChars: limit, perMessageChars: limit });
    assert.ok(rendered.length <= limit, `limit ${limit}: got ${rendered.length} chars`);
  }
});

test("summarizePrompt: zero FILES budget omits paths even when fixed instructions do not fit", () => {
  const call: AgentMessage = {
    role: "assistant", content: [{ type: "toolCall", id: "c", name: "read", arguments: { path: "p".repeat(12000) } }],
    model: "fake", provider: "fake", stopReason: "toolUse", timestamp: 1,
  };
  const result = toolResult("ok");
  if (result.role === "toolResult") result.toolCallId = "c";
  const plan = { keepFrom: 2, toSummarize: [call, result], kept: [], isIterative: false };
  const prompt = summarizePrompt(plan, undefined, 512);
  // The fixed instructions alone exceed this toy 512-token window, so the
  // complete request cannot fit; compactContext refuses to send it (tested
  // below). Even so, the path list must not bypass a zero FILES budget.
  assert.ok(!prompt.includes("\nread: "), "the oversized deterministic FILES list is omitted");
});

test("summarizePrompt: FILES separator is included in the request token budget", () => {
  const call: AgentMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: "c", name: "read", arguments: { path: "src/verified-file.ts" } }],
    model: "fake", provider: "fake", stopReason: "toolUse", timestamp: 1,
  };
  const result = toolResult("ok");
  if (result.role === "toolResult") result.toolCallId = "c";
  const plan = {
    keepFrom: 2,
    toSummarize: [call, result, user("transcript " + "x".repeat(10000))],
    kept: [],
    isIterative: false,
  };
  const contextWindow = 2500;
  const charsPerToken = 1;
  const outputTokens = 100;
  const prompt = summarizePrompt(
    plan,
    { perMessageChars: 10000, totalChars: 10000, toolResultChars: 10000 },
    contextWindow,
    { charsPerToken, outputTokens },
  );
  const completeRequestTokens = Math.ceil((SUMMARIZER_SYSTEM.length + prompt.length) / charsPerToken) + outputTokens;
  assert.ok(prompt.includes("FILES (extracted"), "the verified FILES section is retained");
  assert.ok(completeRequestTokens <= contextWindow, `${completeRequestTokens} tokens must fit in ${contextWindow}`);
});

test("summarizePrompt: a long FILES list cannot starve the transcript (goal survives)", () => {
  // MANY verified paths whose TOTAL length exceeds the available budget.
  // If FILES were allowed to fill the whole budget (uncapped), the transcript
  // allowance would collapse to a sliver and the user's goal/constraints —
  // the tail of the first message — would be clipped out of the summarizer
  // request. The cap (FILES ≤ half the available budget) must bound the path
  // list so the transcript keeps enough room for the goal.
  //
  // The discriminator is a marker at the TAIL of the goal message: under an
  // uncapped FILES list the per-message clip for the transcript shrinks to a
  // handful of chars and the marker is cut; with the cap the goal line is kept
  // whole and the marker survives. A single oversized path would NOT
  // discriminate — it simply cannot fit and is dropped, freeing the budget.
  const N = 40;
  const plen = 40; // each path ~40 chars → ~1600 total, over half the budget
  const calls: AgentMessage[] = [];
  for (let i = 0; i < N; i++) {
    calls.push({
      role: "assistant",
      content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `p${i}${".".repeat(plen)}` } }],
      model: "fake", provider: "fake", stopReason: "toolUse", timestamp: 1,
    });
    const r = toolResult("ok");
    if (r.role === "toolResult") r.toolCallId = `c${i}`;
    calls.push(r);
  }
  const goal = "goal " + "x".repeat(30) + "CONSTRAINT-TAIL"; // marker at the tail
  const charsPerToken = 1;
  const outputTokens = 100;
  for (const isIterative of [false, true]) {
    const plan = {
      keepFrom: 1,
      toSummarize: [user(goal), ...calls],
      kept: [],
      isIterative,
    };
    const contextWindow = 2000;
    const prompt = summarizePrompt(
      plan,
      { perMessageChars: 10000, totalChars: 10000, toolResultChars: 10000 },
      contextWindow,
      { charsPerToken, outputTokens },
    );
    assert.ok(prompt.includes("FILES (extracted"), `iterative=${isIterative}: the FILES section is retained`);
    assert.ok(prompt.includes("goal"), `iterative=${isIterative}: the goal head survives`);
    assert.ok(
      prompt.includes("CONSTRAINT-TAIL"),
      `iterative=${isIterative}: the goal's tail marker survives (transcript not starved by FILES)`,
    );
    const completeRequestTokens = Math.ceil((SUMMARIZER_SYSTEM.length + prompt.length) / charsPerToken) + outputTokens;
    assert.ok(completeRequestTokens <= contextWindow, `${completeRequestTokens} tokens must fit in ${contextWindow}`);
  }
});

test("summarizePrompt: a FILES section that fills the budget still fits the window (boundary sweep)", () => {
  const call: AgentMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: "c", name: "read", arguments: { path: "p".repeat(100) } }],
    model: "fake", provider: "fake", stopReason: "toolUse", timestamp: 1,
  };
  const result = toolResult("evidence".repeat(10000));
  if (result.role === "toolResult") result.toolCallId = "c";
  const charsPerToken = 1;
  const outputTokens = 100;
  // Smallest window in which the FIXED prompt (system + instructions + label
  // + output reservation) fits — below it, compactContext refuses to send
  // (separate, tested behavior), so the sweep starts there.
  const fixedRequestTokens = (isIterative: boolean) =>
    Math.ceil(
      SUMMARIZER_SYSTEM.length +
        summarizePrompt({ keepFrom: 1, toSummarize: [], kept: [], isIterative }).length,
    ) + outputTokens;
  // Sweep every window size so the exact boundary where FILES (not the
  // transcript) fills the remaining budget is covered, for both the
  // iterative and non-iterative prompt shapes.
  for (const isIterative of [false, true]) {
    const floor = fixedRequestTokens(isIterative);
    const plan = {
      keepFrom: 3,
      toSummarize: [user("goal " + "g".repeat(10000)), call, result],
      kept: [],
      isIterative,
    };
    for (let window = floor; window <= floor + 2200; window++) {
      const prompt = summarizePrompt(plan, { totalChars: 10000 }, window, { charsPerToken, outputTokens });
      const completeRequestTokens = Math.ceil(SUMMARIZER_SYSTEM.length + prompt.length) + outputTokens;
      assert.ok(
        completeRequestTokens <= window,
        `iterative=${isIterative} window=${window}: ${completeRequestTokens} tokens must fit in ${window}`,
      );
    }
    // The sweep must actually exercise the FILES path (a budget where the
    // verified path list is retained), not pass vacuously on an empty section.
    const midPrompt = summarizePrompt(plan, { totalChars: 10000 }, floor + 400, { charsPerToken, outputTokens });
    assert.ok(midPrompt.includes("FILES (extracted") && midPrompt.includes("\nread: "),
      "the sweep covers a window where the FILES section with its path list is retained");
  }
});

test("compactContext: refuses to call summarizer when fixed prompt exceeds the model window", async () => {
  const ctx: AgentMessage[] = [user("old goal " + "g".repeat(3000)), assistantText("old answer"), user("current"), assistantText("tail")];
  let calls = 0;
  const fn: StreamFn = (model, context, options) => {
    calls++;
    return fakeStream([{ type: "text", text: "summary" }])(model, context, options);
  };
  const tiny: ModelConfig = { ...MODEL, contextWindow: 512 };
  const r = await compactContext({
    streamFn: fn,
    model: tiny,
    signal: new AbortController().signal,
    context: ctx,
    force: true,
    charsPerToken: 1,
  });
  assert.equal(calls, 0, "the summarizer request cannot fit its fixed instructions");
  assert.equal(r, undefined);
});

test("compactContext: aborted summary with partial text is rejected", async () => {
  const ctx: AgentMessage[] = [user("q1"), assistantText("a1"), user("q2"), assistantText("a2")];
  const partial = assistantText("partial");
  const fn: StreamFn = async function* () {
    yield { type: "text_delta", delta: "partial", partial };
    yield { type: "done", message: { ...partial, stopReason: "aborted" } };
  };
  const r = await compactContext({
    streamFn: fn, model: MODEL, signal: new AbortController().signal, context: ctx, force: true,
  });
  assert.equal(r, undefined);
});

test("ruleBasedShrink: refuses a result that would grow the context", () => {
  const tiny = [user("g"), assistantText("a"), assistantText("b")];
  assert.equal(ruleBasedShrink(tiny, 1, 4), undefined);
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
