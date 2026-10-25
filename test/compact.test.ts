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
  SUMMARIZER_MAX_TOKENS,
  calibrateCharsPerToken,
  compactContext,
  estimatePromptOverheadTokens,
  estimateTokens,
  extractFileOps,
  isSummaryMessage,
  makeSummaryMessage,
  compactionReserve,
  DEFAULT_COMPACTION_RESERVE,
  planCompaction,
  ruleBasedShrink,
  renderTranscript,
  shouldCompact,
  summarizerMaxTokens,
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
  // The trigger's reserve equals maxTokens here so the tiny-window trigger
  // math is unchanged by the maxTokens→compactionReserve separation (a real
  // model sets compactionReserve independently of its output cap).
  compactionReserve: 100,
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

test("shouldCompact: no usage → false; under reserve → false; over → true", () => {
  assert.equal(shouldCompact(undefined, 2000, 100), false);
  assert.equal(shouldCompact(usageOf(500), 2000, 100), false); // 500+100+1024 < 2000
  assert.equal(shouldCompact(usageOf(1500), 2000, 100), true); // 1500+100+1024 > 2000
});

test("compactionReserve: model's compactionReserve when set, else the default", () => {
  assert.equal(DEFAULT_COMPACTION_RESERVE, 16384);
  const base = {
    id: "m",
    provider: "p",
    baseUrl: "http://x",
    api: "openai-completions" as const,
    contextWindow: 131072,
    maxTokens: 32768,
  };
  // unset → default (the trigger's leading threshold)
  assert.equal(compactionReserve(base), 16384);
  // set → the model's own value (per-model tuning)
  assert.equal(compactionReserve({ ...base, compactionReserve: 8192 }), 8192);
  // the reserve is INDEPENDENT of maxTokens: a big output cap does not
  // (and should not) push the trigger earlier.
  assert.equal(compactionReserve({ ...base, maxTokens: 65536 }), 16384);
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

test("planCompaction: last-user preservation extends the kept suffix by more than one unit (bound is a planning target)", () => {
  // The keep budget is a PLANNING target, not a hard cap. planCompaction's
  // mandatory last-user preservation (`if (lastUser > 0 && lastUser < keepFrom)
  // keepFrom = lastUser`) moves the keep boundary back to the most recent user
  // message, which can be MANY units behind the backward-walk target — so the
  // kept suffix (and the candidate) can exceed the target by more than one
  // indivisible unit. This pins that behavior: with a small keep target the
  // walk stops at the last two units, but the most recent user message sits
  // several units back, so the kept suffix is extended to include it (plus the
  // intervening toolCall/result unit).
  const ctx: AgentMessage[] = [
    user("old"), // unit 0 (index 0) — folded
    assistantText("a"), // unit 1 (index 1) — folded
    user("recent task"), // unit 2 (index 2) — the most recent user message (lastUser)
    assistantToolCall("bash", { command: "ls" }), // unit 3 (index 3) — pulled in by the extension
    toolResult("ok"), // (index 4)
    assistantToolCall("bash", { command: "pwd" }), // unit 5 (index 5) — walk target keepFrom
    toolResult("ok"), // (index 6)
    assistantText("done"), // unit 7 (index 7)
  ];
  // keepTokens 5: the backward walk stops at keepFrom 5 (units 5+7), but
  // lastUser is 2, so the keep boundary is extended back to index 2.
  const plan = planCompaction(ctx, 5);
  assert.ok(plan, "a plan exists");
  assert.equal(plan.keepFrom, 2, "keepFrom lands on the most recent user message");
  assert.equal(plan.kept[0]!.role, "user", "the kept suffix starts at the user message");
  assert.ok(
    plan.kept.includes(ctx[3]!),
    "the intervening toolCall unit (before the walk target) is kept — the extension added more than one indivisible unit",
  );
  assert.equal(plan.toSummarize.length > 0, true, "the old units are folded");
  assert.deepEqual([...plan.toSummarize, ...plan.kept], ctx, "no overlap, no loss");
});

test("planCompaction shrinkToFit: folds the OLDEST whole units until the suffix fits (never splitting a tool unit)", () => {
  // 10-token units; a huge atomic toolCall/result unit (2050 tokens) sits at
  // index 2. With a 30-token keep target the walk overshoots to the huge
  // unit (suffix 2050 > target); shrinkToFit descends past it — and the
  // toolCall is never split from its result.
  const ctx: AgentMessage[] = [
    user("u0" + "x".repeat(39)), // 10 tok
    assistantText("a1" + "y".repeat(39)), // 10 tok
    assistantToolCall("bash", { command: "ls" }), // unit start
    toolResult("R".repeat(8200)), // ~2050 tok — huge atomic unit
    user("u4" + "x".repeat(39)), // 10 tok — the live prompt
    assistantText("a5" + "y".repeat(39)), // 10 tok
  ];
  const legacy = planCompaction(ctx, 30);
  assert.ok(legacy, "legacy plan exists");
  assert.ok(legacy!.keepFrom <= 2, "the legacy walk's overshoot keeps the huge unit (planning target only)");
  const shrunk = planCompaction(ctx, 30, 4, { preserveLastUser: true, shrinkToFit: true });
  assert.ok(shrunk, "shrunk plan exists");
  assert.ok(shrunk!.keepFrom > 3, "the descent folded the huge atomic unit away");
  assert.ok(shrunk!.kept.includes(ctx[4]!), "the live prompt survives (preserveLastUser)");
  assert.ok(!shrunk!.kept.some((m) => m.role === "toolResult"), "no tool result survives the descent");
});

test("planCompaction shrinkToFit: with preserveLastUser:false the descent may cross the live prompt (the caller proved it cannot fit)", () => {
  // The live prompt itself is the only thing over budget: the preserving
  // descent stops at it; the fold descent (preserveLastUser:false — used
  // only when compactContext proved every preserving rung cannot fit) folds
  // it too, leaving a suffix that fits.
  const live = user("C".repeat(12000)); // ~3000 tok, over the descent's 1000 cap
  const ctx: AgentMessage[] = [
    user("u0" + "x".repeat(39)),
    live,
    assistantText("tail"),
  ];
  const preserving = planCompaction(ctx, 1000, 4, { preserveLastUser: true, shrinkToFit: true });
  assert.ok(preserving, "preserving plan exists");
  assert.ok(preserving!.kept.includes(live), "the preserving descent stops AT the live prompt");
  const folding = planCompaction(ctx, 1000, 4, { preserveLastUser: false, shrinkToFit: true });
  assert.ok(folding, "folding plan exists");
  assert.ok(folding!.keepFrom > preserving!.keepFrom, "the fold descent goes deeper");
  assert.ok(!folding!.kept.includes(live), "the fold descent crosses the live prompt (task carried by the summary)");
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

test("compactContext: the keep plan reserves the summary budget, so the candidate fits the input budget (D26)", async () => {
  // 100 uniform units of 40 chars (10 est tokens each) = 1000 est tokens.
  // The keep walk lands on an atomic boundary; the candidate is
  // [summary, …kept] + overhead. Before the reservation the keep window was
  // sized to (budget − overhead) with NO room for the summary, so the
  // candidate exceeded the input budget by ~the summary's size. The fix
  // reserves the fixed prompt overhead AND the summarizer's output budget,
  // so the candidate fits (up to the overshoot of one indivisible unit).
  const unit = "x".repeat(40); // 10 est tokens
  const ctx: AgentMessage[] = Array.from({ length: 100 }, () => user("u" + unit.slice(1)));
  const summary = "S".repeat(200); // ~61 est tokens once the marker is added
  const r = await compactContext({
    streamFn: fakeStream([{ type: "text", text: summary }]),
    model: MODEL, // window 2000, maxTokens 100
    signal: new AbortController().signal,
    context: ctx,
    promptOverheadTokens: 100,
    force: true,
  });
  assert.ok(r, "compaction happened");
  const unitTokens = 10; // each message is 40 chars = 10 est tokens
  const summaryTokens = Math.ceil((SUMMARY_MARKER.length + 2 + summary.length) / 4);
  assert.ok(
    r!.estimatedTokensAfter <= r!.requestBudget + unitTokens,
    `candidate (${r!.estimatedTokensAfter}) is within one atomic unit of the input budget (${r!.requestBudget}); before the reservation it was ~the summary (${summaryTokens}) over`,
  );
});

test("compactContext: strict-fit deep fold — a huge atomic unit behind the prompt folds out and the candidate fits (D26 repro 1)", async () => {
  // Mid-conversation atomic toolCall/toolResult unit (10k tokens) is the only
  // reason the kept suffix busts the request budget; the live prompt is small.
  // The preserving descend rung (b) folds the huge unit away (never crossing
  // the live prompt), so the applied candidate fits with ONE summarizer call.
  const model: ModelConfig = { ...MODEL, contextWindow: 5000, maxTokens: 500 };
  const ctx: AgentMessage[] = [
    user("old chat"),
    assistantText("a".repeat(1000)),
    assistantToolCall("bash", { command: "ls" }),
    toolResult("R".repeat(40000)), // ~10k tokens — bigger than the whole budget
    assistantText("done with result"),
    user("next task"),
    assistantText("ok"),
  ];
  const { fn, ctxs } = withCapture(fakeStream([{ type: "text", text: "S".repeat(200) }]));
  const r = await compactContext({
    streamFn: fn,
    model,
    signal: new AbortController().signal,
    context: ctx,
    promptOverheadTokens: 0,
    force: true,
    strictFit: true,
  });
  assert.ok(r, "compaction happened");
  assert.equal(ctxs.length, 1, "the rung is chosen before the call — one summarizer call");
  assert.ok(r!.estimatedTokensAfter <= r!.requestBudget, "the applied candidate fits the request budget");
  assert.equal(r!.fitsInputBudget, true, "fit reported");
  assert.ok(!r!.kept.some((m) => m.role === "toolResult"), "the huge atomic tool unit was folded out");
  assert.ok(r!.kept.includes(ctx[5]!), "the live prompt survives verbatim on the preserving rung");
});

test("compactContext: strict-fit guard — a prompt fold is NOT selected when the rule-based notice still fits a preserving plan (D26)", async () => {
  // The kept suffix is the LIVE PROMPT ITSELF (~3000 tokens): it exceeds the
  // request budget with any LLM summary (cap 500) — so both LLM rungs fail —
  // yet it fits with the small rule-based notice (≤512 chars ≈ 139 tokens).
  // Even though the LLM candidate comes back over budget, compactContext
  // must keep the PRESERVING plan (prompt verbatim in `kept`): the fold would
  // lose the live prompt for nothing (compactNow can land the fitting
  // notice). Without the notice-carrier pre-check, the fold rung WOULD be
  // selected here (its bound fits) and the live prompt would be dropped.
  const model: ModelConfig = { ...MODEL, contextWindow: 5000, maxTokens: 500 };
  const live = user("L".repeat(12000)); // ~3000 tok: notice fits (≤3337), summary (cap 500) does not
  const ctx: AgentMessage[] = [
    ...Array.from({ length: 300 }, (_, i) => user(`u${i}` + "x".repeat(38))), // 10 tok each
    live,
    assistantText("ok"),
  ];
  // ~1911-token summary: candidate = suffix + summary busts the budget...
  const { fn } = withCapture(fakeStream([{ type: "text", text: "S".repeat(7600) }]));
  const r = await compactContext({
    streamFn: fn,
    model,
    signal: new AbortController().signal,
    context: ctx,
    promptOverheadTokens: 0,
    force: true,
    strictFit: true,
  });
  assert.ok(r, "a candidate is still produced (a strict reduction of the history)");
  assert.ok(r!.kept.includes(live), "the live prompt is NOT folded — the notice carrier preserves it");
  assert.ok(!r!.fitsInputBudget, "the LLM candidate is honestly reported over budget (compactNow falls through to the fitting notice)");
});

test("compactContext: strict-fit may fold a huge latest user prompt rather than violate the request budget", async () => {
  const model: ModelConfig = { ...MODEL, contextWindow: 5000, maxTokens: 500 };
  const livePrompt = "current task".repeat(8000);
  const ctx: AgentMessage[] = [
    user("old".repeat(1000)),
    assistantText("old answer".repeat(500)),
    user(livePrompt),
    assistantText("working"),
  ];
  const { fn, ctxs } = withCapture(
    fakeStream([{ type: "text", text: "The user's current goal is to finish the task." }]),
  );
  const r = await compactContext({
    streamFn: fn,
    model,
    signal: new AbortController().signal,
    context: ctx,
    keepTokens: 5,
    promptOverheadTokens: 100,
    force: true,
    strictFit: true,
  });
  assert.ok(r, "summary can carry the latest task when its verbatim prompt is too large");
  assert.ok(r!.estimatedTokensAfter <= r!.requestBudget, "strict fit is enforced after summary");
  assert.ok(!r!.kept.includes(ctx[2]!), "strict-fit folds the oversized last user message");
  assert.ok(r!.summary.length > 0, "summary content replaces the folded task");
  // priorityLastUser: the fold's whole job is carrying the live task, so the
  // summarizer transcript must deliver it — head AND tail (older turns are
  // dropped/shrunk first, the prompt is middle-clipped only as a last resort).
  const transcriptMsg = ctxs[0]?.messages[0];
  assert.ok(transcriptMsg && transcriptMsg.role === "user", "the summarizer call carries its prompt");
  const transcript = transcriptMsg.role === "user" ? transcriptMsg.content : "";
  assert.ok(transcript.includes("[User] " + livePrompt.slice(0, 100)), "the transcript carries the live prompt HEAD");
  assert.ok(transcript.includes(livePrompt.slice(-100)), "the transcript carries the live prompt TAIL (middle clip, not head-truncation)");
  assert.ok(!transcript.includes("old answer".repeat(5)), "older turns yield to the priority prompt");
});

test("compactContext: floor regime — the keep plan targets the reserved headroom, not the 512 floor", async () => {
  // window 3000 / maxTokens 200 → summaryBudget = min(1024, 200) = 200.
  // With a large prompt overhead (1276), the reserved headroom is
  //   3000 − 200 − 1024 − 1276 − 200 = 300  (a few hundred tokens, < 512).
  // Under the OLD 512 floor the keep target would be 512, so the walk would
  // keep 52 of the 10-token units (520 tokens) — leaving NO room for the
  // overhead + summary, so the candidate blew past the input budget by far
  // more than one atomic unit. The fix makes the keep plan target the
  // headroom (300) in ALL regimes: the walk keeps 30 units (300 tokens), so
  // the candidate [summary, …kept] + overhead stays within one indivisible
  // unit of requestBudget.
  const model: ModelConfig = { ...MODEL, contextWindow: 3000, maxTokens: 200 };
  const promptOverheadTokens = 1276;
  const unit = "x".repeat(40); // 10 est tokens each
  const ctx: AgentMessage[] = Array.from({ length: 100 }, () => user("u" + unit.slice(1)));
  const r = await compactContext({
    streamFn: fakeStream([{ type: "text", text: "S".repeat(200) }]),
    model,
    signal: new AbortController().signal,
    context: ctx,
    promptOverheadTokens,
    force: true,
  });
  assert.ok(r, "compaction happened");
  // The headroom is 300, so the keep walk stops at the 30th unit (300 est
  // tokens) — NOT the 512 floor, which would have kept 52 units.
  const unitTokens = 10;
  assert.equal(r!.kept.length, 30, "the keep plan targets the 300-token headroom, not the 512 floor");
  assert.equal(r!.kept[0], ctx[70]!, "the keep window starts at the headroom-sized boundary (unit 70)");
  assert.deepEqual(r!.kept, ctx.slice(70), "kept is the headroom-sized suffix");
  // The candidate is bounded by requestBudget + one indivisible unit.
  // (With the old 512 floor the keep walk would have kept 52 units — 520
  // tokens — and the candidate would have exceeded requestBudget by far more
  // than one atomic unit.)
  assert.ok(
    r!.estimatedTokensAfter <= r!.requestBudget + unitTokens,
    `candidate (${r!.estimatedTokensAfter}) is within one atomic unit of the input budget (${r!.requestBudget}); the 512 floor would have kept 52 units and blown the budget`,
  );
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

test("compactContext: truncated (length) summary WITH text is ACCEPTED (usable, not a total failure)", async () => {
  // #2: a summary that hits the output cap (stopReason "length") but still
  // produced a structured body is a strict reduction of the context — accept
  // it. The old code treated `length` as total failure, which (combined with
  // the 1024 cap) made every long-context compaction fall through to the
  // lossy rule-based notice.
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
  assert.ok(r, "a truncated-but-structured summary is usable — it shrinks the context");
  assert.equal(r!.summary, "partial GOAL only", "the truncated text is kept verbatim");
});

test("compactContext: truncated (length) summary with NO text is still rejected", async () => {
  // A `length` stop that yielded no text has nothing to fold the prefix into
  // (the text.trim() === "" guard) — still a failure, not a usable summary.
  const ctx: AgentMessage[] = [
    user("old goal " + "g".repeat(3000)), assistantText("old answer"), user("current"), assistantText("tail"),
  ];
  const empty = assistantText("");
  const fn: StreamFn = async function* () {
    yield { type: "done", message: { ...empty, stopReason: "length" } };
  };
  const r = await compactContext({
    streamFn: fn, model: MODEL, signal: new AbortController().signal, context: ctx, force: true,
  });
  assert.equal(r, undefined, "a length stop with no text is still a failure");
});

test("renderTranscript: zero and tiny clip limits never exceed their limit", () => {
  const source = "secret-content-".repeat(100);
  for (const limit of [0, 1, 2, 3, 32]) {
    const rendered = renderTranscript([user(source)], { totalChars: limit, perMessageChars: limit });
    assert.ok(rendered.length <= limit, `limit ${limit}: got ${rendered.length} chars`);
  }
});

test("renderTranscript priorityLastUser: the live prompt survives the total budget", () => {
  const old1 = user("o".repeat(1000));
  const old2 = assistantText("o".repeat(1000));
  const live = user("LIVE-PROMPT " + "x".repeat(400));
  // (preserve) Over the total, OLDEST whole groups drop first: the live
  // prompt survives whole while the older turns are sacrificed.
  const t = renderTranscript([old1, old2, user("y".repeat(600)), live], {
    totalChars: 500,
    perMessageChars: 50,
    priorityLastUser: true,
  });
  assert.ok(t.includes("LIVE-PROMPT"), "the priority prompt survives");
  assert.ok(!t.includes("o".repeat(50)), "older turns yield first");
  // (whole) Without priority mode the same prompt is per-message clipped
  // like everything else — the flag is what protects it.
  const plain = renderTranscript([old1, old2, user("y".repeat(600)), live], {
    totalChars: 500,
    perMessageChars: 50,
  });
  assert.ok(!plain.includes("LIVE-PROMPT" + "x".repeat(100)), "without the flag the live prompt is clipped");
  // (shrink-oldest) Dropping every older group still overflows: the priority
  // line shrinks to its share — a plain middle clip that honors the total
  // exactly (head AND tail of the live prompt survive; audit finding 4).
  const huge = user("H".repeat(4000) + "TAIL");
  const t2 = renderTranscript([user("a"), huge], { totalChars: 300, perMessageChars: 50, priorityLastUser: true });
  assert.ok(t2.length <= 300, `respects the total exactly (${t2.length})`);
  assert.ok(t2.startsWith("[User] HHH"), "head survives the last-resort middle clip");
  assert.ok(t2.endsWith("TAIL"), "tail survives the last-resort middle clip");
});

// Audit finding 4: the priority mode used to only drop groups BEFORE the
// live prompt — groups after it survived and the priority clip reserved no
// space for them, so the rendered transcript exceeded `totalChars`
// (151 chars at a budget of 0). The cap is now hard at any total.
test("renderTranscript priorityLastUser: totalChars is a hard cap at any budget (audit finding 4)", () => {
  const big = user("U".repeat(1000));
  const after = assistantText("A".repeat(1000));
  for (const total of [0, 1, 3, 20, 100, 300]) {
    const t = renderTranscript([big, after], { totalChars: total, priorityLastUser: true });
    assert.ok(t.length <= total, `totalChars ${total}: rendered ${t.length} must not exceed the budget`);
  }
  // The live prompt is sacrificed-to-last: at a tight budget the surviving
  // non-priority group yields its bytes to the prompt (priority first), and
  // the prompt keeps its head. At a budget that fits both, both survive.
  const tight = renderTranscript([user("LIVE " + "x".repeat(500)), assistantText("tail-note")], {
    totalChars: 120,
    priorityLastUser: true,
  });
  assert.ok(tight.length <= 120, `hard cap honored (${tight.length})`);
  assert.ok(tight.startsWith("[User] LIVE"), "the priority prompt keeps its head");
  const roomy = renderTranscript([user("LIVE " + "x".repeat(500)), assistantText("tail-note")], {
    totalChars: 600,
    priorityLastUser: true,
  });
  assert.ok(roomy.length <= 600, "cap honored with room for both");
  assert.ok(roomy.includes("tail-note"), "the non-priority group survives when everything fits");
  assert.ok(roomy.startsWith("[User] LIVE"), "priority intact when it fits");
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

test("summarizerMaxTokens: min(SUMMARIZER_MAX_TOKENS, model.maxTokens)", () => {
  assert.equal(SUMMARIZER_MAX_TOKENS, 2048);
  // A model with a big maxTokens → the fixed 2048 cap.
  assert.equal(summarizerMaxTokens({ ...MODEL, maxTokens: 32768 }), 2048);
  // Exactly at the cap → 2048.
  assert.equal(summarizerMaxTokens({ ...MODEL, maxTokens: 2048 }), 2048);
  // A model with a small maxTokens → clamped to the model's own cap.
  assert.equal(summarizerMaxTokens({ ...MODEL, maxTokens: 100 }), 100);
});

test("compactContext: the summarizer call uses the summarizer cap as its maxTokens", async () => {
  const model: ModelConfig = { ...MODEL, contextWindow: 4000, maxTokens: 8000 };
  const ctx: AgentMessage[] = [
    user("old " + "y".repeat(8000)),
    assistantText("x".repeat(8000)),
    user("current"),
    assistantText("ok", usageOf(3100)),
  ];
  let seenMax: number | undefined;
  const partial = assistantText("SUMMARY");
  const fn: StreamFn = (m, c, o) => {
    seenMax = m.maxTokens;
    return (async function* () {
      yield { type: "text_delta", delta: "SUMMARY", partial };
      yield { type: "done", message: partial };
    })();
  };
  const r = await compactContext({ streamFn: fn, model, signal: new AbortController().signal, context: ctx, force: true });
  assert.ok(r, "compaction happened");
  assert.equal(seenMax, summarizerMaxTokens(model), "the summarizer call's maxTokens is the summarizer cap");
  assert.equal(seenMax, 2048, "2048 for a model with maxTokens 8000");
});

test("compactContext: the keep plan reserves the summarizer cap (2048), not the old 1024", async () => {
  // A model (maxTokens 8000) reserves the summarizer cap (2048) in the keep
  // plan. The old code reserved min(1024, maxTokens)=1024, so its keep window
  // was 1024 tokens LARGER; the new reservation is 1024 tokens SMALLER (more
  // headroom for the now-larger summary), so the keep walk stops earlier.
  // headroom = 16000 − 8000 − 1024 − 0 − 2048 = 4928 (< the 8192 default, so
  // it is the keep target). 1200 units of 10 tokens: the walk keeps 493 units
  // (4930 ≥ 4928). The old 1024 reservation (headroom 5952) would have kept
  // 596 units — 103 more, ≈ the 1024-token difference.
  const model: ModelConfig = { ...MODEL, contextWindow: 16000, maxTokens: 8000 };
  const unit = "x".repeat(40); // 10 est tokens each
  const ctx: AgentMessage[] = Array.from({ length: 1200 }, () => user("u" + unit.slice(1)));
  const r = await compactContext({
    streamFn: fakeStream([{ type: "text", text: "S".repeat(200) }]),
    model,
    signal: new AbortController().signal,
    context: ctx,
    promptOverheadTokens: 0,
    force: true,
  });
  assert.ok(r, "compaction happened");
  assert.equal(
    r!.kept.length, 493,
    "the keep walk keeps 493 units (the 2048 reservation), not 596 (the old 1024 reservation)",
  );
  assert.ok(
    r!.estimatedTokensAfter <= r!.requestBudget + 10,
    `candidate (${r!.estimatedTokensAfter}) is within one atomic unit of the input budget (${r!.requestBudget})`,
  );
});


// ─── Audit follow-ups to D26 (2026-08-10 review findings 1, 2, 5) ───────────

test("compactContext: a failed prompt-fold attempt does NOT suppress the preserving candidate (finding 2)", async () => {
  // Budget = 4900 − 500 − 1024 = 3376. Tail: a 11800-char last-user unit
  // (2951) + a 1620-char last-assistant unit (405) = 3355 (+11 wrapper =
  // 3366 ≤ B: the preserving FLOOR fits, impossibility unproved), but the
  // rule-based notice does NOT fit (3355+52 = 3407 > B, probe-measured), so
  // the fold is attempted after the preserving summary demonstrates the bust.
  // The fold call ERRORS. Before the fix that error returned undefined — the
  // preserving candidate in hand was discarded and the session fell all the
  // way to compactNow's notice ladder; the notice's non-fit here proves the
  // fold was really in play. Now: the candidate survives, honestly over
  // budget, with the live prompt kept, and compactNow chooses its own best.
  const model: ModelConfig = { ...MODEL, contextWindow: 4900, maxTokens: 500 };
  const live = user("u".repeat(11800));
  const ctx: AgentMessage[] = [user("old"), assistantText("x".repeat(40000)), live, assistantText("w".repeat(1620))];
  const fn = fakeStream([
    { type: "text", text: "s".repeat(2000) }, // preserving attempt: fits no budget (busts → fold)
    { type: "error", message: "fold attempt must not sink the preserving candidate" },
  ]);
  const r = await compactContext({
    streamFn: fn,
    model,
    signal: new AbortController().signal,
    context: ctx,
    keepTokens: 5,
    promptOverheadTokens: 0,
    force: true,
    strictFit: true,
  });
  assert.ok(r, "the preserving candidate survives a failed fold attempt");
  assert.ok(r!.kept.includes(live), "the live prompt is preserved");
  assert.ok(!r!.fitsInputBudget, "honestly reported over budget — compactNow's own ladder (notice, then over-budget candidates) decides from here, not undefined (finding 2)");
});

test("compactContext: a user abort during the fold attempt is terminal — no candidate (finding 2 edge)", async () => {
  // Same geometry, but the fold stream ENDS with stopReason "aborted" (the
  // user pressed ESC while the fold summarizer was streaming). Unlike a
  // stream error, an abort must NOT fall back to the preserving candidate.
  const model: ModelConfig = { ...MODEL, contextWindow: 4900, maxTokens: 500 };
  const live = user("u".repeat(11800));
  const ctx: AgentMessage[] = [user("old"), assistantText("x".repeat(40000)), live, assistantText("w".repeat(1620))];
  const fn = fakeStream([
    { type: "text", text: "s".repeat(2000) },
    { type: "aborted" },
  ]);
  const r = await compactContext({
    streamFn: fn,
    model,
    signal: new AbortController().signal,
    context: ctx,
    keepTokens: 5,
    promptOverheadTokens: 0,
    force: true,
    strictFit: true,
  });
  assert.equal(r, undefined, "an abort during fold-after-demo is final — no candidate, no notice fallback");
});

test("compactContext: the fold rung caps the summarizer at the headroom over its kept tail (finding 1)", async () => {
  // Window 4096, maxTokens 2048 → budget 1024; the uncapped summarizer would
  // be allowed min(2048, 4096) = 2048 — twice the whole request budget!
  // Tail: the 1000-char last-user unit (250) alone after shrink (the huge
  // tool unit is folded); headroom = 1024 − 250 suffix − 11 wrapper − 100
  // overhead = 663. The fold call's maxTokens must EQUAL that headroom (the old code
  // sent the full 2048, letting an accepted response blow the fit the fold
  // existed to buy). Floor busts (preserving suffix 1253 > 1013) and the
  // notice busts too, so the fold runs as the SINGLE call — the one model
  // observed is the fold rung.
  const model: ModelConfig = { ...MODEL, contextWindow: 4096, maxTokens: 2048 };
  const live = user("u".repeat(4000));
  const ctx: AgentMessage[] = [user("old history"), assistantText("x".repeat(60000)), live, assistantText("w".repeat(1000))];
  const models: ModelConfig[] = [];
  const scripted = fakeStream([{ type: "text", text: "goal carried" }]);
  const fn: StreamFn = (m, c, o) => {
    models.push(m);
    return scripted(m, c, o);
  };
  const r = await compactContext({
    streamFn: fn,
    model,
    signal: new AbortController().signal,
    context: ctx,
    keepTokens: 5,
    promptOverheadTokens: 100,
    force: true,
    strictFit: true,
  });
  assert.ok(r, "a candidate is produced");
  assert.equal(models.length, 1, "the fold runs as the single summarizer call (floor busts immediately)");
  assert.equal(models[0]!.maxTokens, 663, "the fold call's max_tokens is exactly the headroom over its kept tail, not the uncapped 2048");
  assert.ok(r!.fitsInputBudget, "the capped fold candidate fits the request budget");
  assert.ok(!r!.kept.includes(live), "the fold carried the live task out of the tail (accepted because it bought the fit)");
});
