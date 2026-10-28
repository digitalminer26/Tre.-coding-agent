/**
 * WS2 — tests for the core agent loop (runLoop) against the scripted
 * fakeStream from test/fake-stream.ts (no network).
 *
 * Covers the WS2 exit criteria (PLAN.md) and the behaviors pinned in
 * docs/01-walkthrough-harness-llm.md §4–5:
 *   - full multi-turn: user → assistant(toolcall) → toolresult → assistant(text) → stop,
 *     with the EXACT AgentMessage[] asserted
 *   - I2: one context slot, replaced as the partial streams (aborts keep a
 *     consistent partial)
 *   - I3: error/aborted stop cleanly (no throw); throwing tools become
 *     isError results
 *   - length guard: truncated tool calls are failed, never executed;
 *     a no-call `length` stop retries once with a nudge (C22), then stops
 *   - batch dispatch: parallel by default, sequential when any tool opts
 *     in; results and end events always in call order
 *   - batch terminate, unknown tools, maxTurns, prepareNextTurn
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fakeStream, type FakeTurn } from "./fake-stream.js";
import {
  ABORTED_CALL_TEXT,
  BUDGET_CONTINUE_TEXT,
  CYCLE_CAP,
  GUARD_RETRY_TEXT,
  MAX_PROGRESS_NUDGES,
  NO_SUCCESS_NUDGE_TEXT,
  NO_SUCCESS_TURNS,
  POLL_CAP,
  UNVERIFIED_EDITS,
  batchSignature,
  deriveMaxTurns,
  progressTargetOf,
  runLoop,
  type AgentLoopOptions,
} from "../src/loop/agent-loop.js";
import { guardRetryNote, loopStopNote } from "../src/types.js";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  AssistantStreamEvent,
  ExecuteToolCall,
  LlmContext,
  ModelConfig,
  StreamFn,
  Tool,
  UserMessage,
} from "../src/types.js";
import { makeToolExecutor } from "../src/tools/pipeline.js";
import { makeSafetyHooks } from "../src/tools/safety.js";
import { createBashTool } from "../src/tools/bash.js";
import { resolve } from "node:path";
import { applyEvent, makeInitialState } from "../src/tui/state.js";

const MODEL: ModelConfig = {
  id: "fake-model",
  provider: "fake",
  baseUrl: "http://fake.invalid/v1",
  api: "openai-completions",
  contextWindow: 32000,
  maxTokens: 4096,
};

const userMsg = (text: string): UserMessage => ({
  role: "user",
  content: text,
  timestamp: 0,
});

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Collect a runLoop generator's full event stream. */
async function drain(gen: AsyncGenerator<AgentEvent, void, unknown>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

/** Run the loop with a fresh fakeStream and drain all events. */
async function drainLoop(
  turns: FakeTurn[],
  tools: Tool[],
  extra: Partial<AgentLoopOptions> = {},
): Promise<AgentEvent[]> {
  return drain(
    runLoop({
      model: MODEL,
      systemPrompt: "sys",
      initialMessages: [userMsg("hi")],
      tools,
      streamFn: fakeStream(turns, { model: MODEL }),
      signal: new AbortController().signal,
      ...extra,
    }),
  );
}

/** A fake Tool that records every {id, args} it was executed with. */
function makeTool(
  name: string,
  over: Partial<Omit<Tool, "name" | "parameters">> = {},
): { tool: Tool; calls: { id: string; args: Record<string, unknown> }[] } {
  const calls: { id: string; args: Record<string, unknown> }[] = [];
  const inner: Tool["execute"] =
    over.execute ??
    (async () => ({ content: [{ type: "text" as const, text: `${name} ran` }] }));
  const tool: Tool = {
    name,
    description: `fake ${name}`,
    parameters: { type: "object" },
    ...(over.executionMode !== undefined ? { executionMode: over.executionMode } : {}),
    execute: async (id, args, signal, onUpdate) => {
      calls.push({ id, args });
      return inner(id, args, signal, onUpdate);
    },
  };
  return { tool, calls };
}

/**
 * Normalize messages for exact deep-equality: JSON round-trip drops
 * `undefined`-valued own keys (fake messages carry `usage: undefined`),
 * and timestamps are zeroed (Date.now() at stream time).
 */
function normalize(msgs: AgentMessage[]): AgentMessage[] {
  const cloned = JSON.parse(JSON.stringify(msgs)) as AgentMessage[];
  for (const m of cloned) if ("timestamp" in m) m.timestamp = 0;
  return cloned;
}

function agentEnd(events: AgentEvent[]): Extract<AgentEvent, { type: "agent_end" }> {
  const end = events[events.length - 1]!;
  assert.equal(end.type, "agent_end", "last event must be agent_end");
  return end as Extract<AgentEvent, { type: "agent_end" }>;
}

/** Event types with consecutive delta runs collapsed (robust to chunking). */
function coarse(events: AgentEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const t =
      e.type === "text_delta" ||
      e.type === "thinking_delta" ||
      e.type === "toolcall_delta"
        ? "delta"
        : e.type;
    if (out[out.length - 1] !== t) out.push(t);
  }
  return out;
}

const toolEndEvents = (events: AgentEvent[]) =>
  events.filter(
    (e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
      e.type === "tool_execution_end",
  );

const toolResultMessages = (msgs: AgentMessage[]) =>
  msgs.filter((m): m is Extract<AgentMessage, { role: "toolResult" }> => m.role === "toolResult");

// ─────────────────────────── full multi-turn ───────────────────────────

test("full multi-turn: user → toolcall → toolResult → text → stop (exact context)", async () => {
  const { tool } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: { path: "a.txt" } }] },
    { type: "text", text: "all done" },
  ];
  const events = await drainLoop(turns, [tool]);
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stop");

  assert.deepEqual(normalize(end.messages), [
    { role: "user", content: "hi", timestamp: 0 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } }],
      model: "fake-model",
      provider: "fake",
      stopReason: "toolUse",
      timestamp: 0,
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "read ran" }],
      timestamp: 0,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "all done" }],
      model: "fake-model",
      provider: "fake",
      stopReason: "stop",
      timestamp: 0,
    },
  ]);

  assert.deepEqual(coarse(events), [
    "agent_start",
    "turn_start",
    "start",
    "toolcall_start",
    "delta",
    "done",
    "turn_end",
    "tool_execution_start",
    "tool_execution_end",
    "turn_start",
    "start",
    "delta",
    "done",
    "turn_end",
    "agent_end",
  ]);
});

// ─────────────────────────── error / abort (I3) ───────────────────────────

test("error turn: clean stop, errorMessage kept, no throw", async () => {
  const events = await drainLoop([{ type: "error", message: "boom" }], []);
  const end = agentEnd(events);
  assert.equal(end.stopReason, "error");
  assert.deepEqual(normalize(end.messages), [
    { role: "user", content: "hi", timestamp: 0 },
    {
      role: "assistant",
      content: [],
      model: "fake-model",
      provider: "fake",
      stopReason: "error",
      errorMessage: "boom",
      timestamp: 0,
    },
  ]);
});

test("scripted aborted turn: partial kept in context, stopReason aborted", async () => {
  const events = await drainLoop([{ type: "aborted" }], []);
  const end = agentEnd(events);
  assert.equal(end.stopReason, "aborted");
  assert.deepEqual(normalize(end.messages), [
    { role: "user", content: "hi", timestamp: 0 },
    {
      role: "assistant",
      content: [],
      model: "fake-model",
      provider: "fake",
      stopReason: "aborted",
      timestamp: 0,
    },
  ]);
});

test("real AbortSignal fired mid-turn → stopReason aborted, partial kept in context (I2)", async () => {
  const controller = new AbortController();
  const streamFn = fakeStream([{ type: "text", text: "a".repeat(24) }], { model: MODEL });
  const gen = runLoop({
    model: MODEL,
    systemPrompt: "sys",
    initialMessages: [userMsg("hi")],
    tools: [],
    streamFn,
    signal: controller.signal,
  });
  const events: AgentEvent[] = [];
  for await (const e of gen) {
    events.push(e);
    if (e.type === "text_delta") controller.abort(); // abort after the first delta
  }
  const end = agentEnd(events);
  assert.equal(end.stopReason, "aborted");

  // The aborted partial lives in context as a consistent assistant message.
  // (fakeStream pre-builds its deltas, so the fake's live partial is already
  // complete by the time of the abort — what this test pins is the loop's
  // behavior: I2 slot consistency + clean stop, no throw.)
  assert.equal(end.messages.length, 2);
  const last = end.messages[end.messages.length - 1]!;
  assert.equal(last.role, "assistant");
  if (last.role === "assistant") {
    assert.equal(last.stopReason, "aborted");
    const text = last.content.find((b) => b.type === "text");
    assert.ok(text && text.type === "text" && text.text.length > 0,
      "partial text must be kept in context");
  }
});

// ─────────────────────────── length guard ───────────────────────────

test("length guard: calls failed (isError, 'truncated'), never executed, run continues", async () => {
  const { tool, calls } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "length", calls: [{ id: "l1", name: "read", args: { path: "x.txt" } }] },
    { type: "text", text: "reissued later" },
  ];
  const events = await drainLoop(turns, [tool]);
  const end = agentEnd(events);

  assert.equal(calls.length, 0, "truncated tool calls must never execute");
  assert.equal(end.stopReason, "stop", "the run continues to the next turn and stops there");

  const ends = toolEndEvents(events);
  assert.equal(ends.length, 1);
  const r = ends[0]!.result;
  assert.equal(r.toolCallId, "l1");
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /truncated/i);

  // Context: user, assistant(length), failed toolResult, assistant(stop).
  assert.equal(end.messages.length, 4);
  const result = toolResultMessages(end.messages)[0]!;
  assert.equal(result.toolCallId, "l1");
  assert.equal(result.isError, true);
});

test("length guard (C22): no tool calls → one nudge retry, run continues", async () => {
  const turns: FakeTurn[] = [
    { type: "length", text: "I was in the middle of" },
    { type: "text", text: "recovered and finished" },
  ];
  const events = await drainLoop(turns, []);
  const end = agentEnd(events);

  assert.equal(end.stopReason, "stop", "the nudged turn runs and stops normally");
  assert.equal(events.filter((e) => e.type === "turn_start").length, 2);

  // Context: user, assistant(partial), user(nudge), assistant(stop).
  const msgs = end.messages;
  assert.equal(msgs.length, 4);
  assert.equal(msgs[1]!.role, "assistant");
  assert.ok(
    (msgs[1]!.content[0] as { type: string }).type === "text",
    "the partial assistant text stays in context",
  );
  const nudge = msgs[2]!;
  assert.equal(nudge.role, "user", "the retry is driven by a user nudge");
  assert.match(
    nudge.role === "user" ? nudge.content : "",
    /output token limit/i,
  );
});

test("length guard (C22): no-call length twice → stops after the single nudge", async () => {
  const turns: FakeTurn[] = [
    { type: "length", text: "first truncation" },
    { type: "length", text: "second truncation" },
  ];
  const events = await drainLoop(turns, []);
  const end = agentEnd(events);

  assert.equal(end.stopReason, "length", "the second no-call length stops the run");
  assert.equal(events.filter((e) => e.type === "turn_start").length, 2);
  // user, partial, nudge, partial — no second nudge
  assert.equal(end.messages.length, 4);
  assert.equal(
    end.messages.filter((m) => m.role === "user").length,
    2,
  );
});

test("length guard (C22): no room for the retry on the last turn → stops with length", async () => {
  const events = await drainLoop(
    [{ type: "length", text: "truncated on the final turn" }],
    [],
    { maxTurns: 1 },
  );
  const end = agentEnd(events);
  assert.equal(end.stopReason, "length");
  assert.equal(end.messages.length, 2, "user + partial — no nudge pushed");
});

// ─────────────────────────── batch terminate ───────────────────────────

test("terminate: true on EVERY result → loop stops (scripted 2nd turn not consumed)", async () => {
  const t1 = makeTool("t1", {
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], terminate: true }),
  });
  const t2 = makeTool("t2", {
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], terminate: true }),
  });
  const turns: FakeTurn[] = [
    {
      type: "toolcall",
      calls: [{ id: "a", name: "t1", args: {} }, { id: "b", name: "t2", args: {} }],
    },
    { type: "text", text: "must not be consumed" }, // fakeStream throws if this runs
  ];
  const events = await drainLoop(turns, [t1.tool, t2.tool]);
  const end = agentEnd(events);
  assert.equal(end.stopReason, "toolUse");
  assert.equal(events.filter((e) => e.type === "turn_start").length, 1);
});

test("one result WITHOUT terminate → loop continues to the next turn", async () => {
  const t1 = makeTool("t1", {
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], terminate: true }),
  });
  const t2 = makeTool("t2"); // default: no terminate
  const turns: FakeTurn[] = [
    {
      type: "toolcall",
      calls: [{ id: "a", name: "t1", args: {} }, { id: "b", name: "t2", args: {} }],
    },
    { type: "text", text: "second turn" },
  ];
  const events = await drainLoop(turns, [t1.tool, t2.tool]);
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stop");
  assert.equal(events.filter((e) => e.type === "turn_start").length, 2);
});

// ─────────────────────────── dispatch ordering ───────────────────────────

test("parallel batch: slow-first call, but results + end events in CALL order", async () => {
  const log: string[] = [];
  const slow = makeTool("slow", {
    execute: async () => {
      log.push("start:slow");
      await delay(50);
      log.push("end:slow");
      return { content: [{ type: "text" as const, text: "slow done" }] };
    },
  });
  const fast = makeTool("fast", {
    execute: async () => {
      log.push("start:fast");
      log.push("end:fast");
      return { content: [{ type: "text" as const, text: "fast done" }] };
    },
  });
  const turns: FakeTurn[] = [
    {
      type: "toolcall",
      calls: [{ id: "s1", name: "slow", args: {} }, { id: "f1", name: "fast", args: {} }],
    },
    { type: "text", text: "end" },
  ];
  const events = await drainLoop(turns, [slow.tool, fast.tool]);
  const end = agentEnd(events);

  // They really ran in parallel: fast finished before slow.
  assert.deepEqual(log, ["start:slow", "start:fast", "end:fast", "end:slow"]);
  // Yet events and context results land in call order.
  assert.deepEqual(
    toolEndEvents(events).map((e) => e.toolCallId),
    ["s1", "f1"],
  );
  assert.deepEqual(
    toolResultMessages(end.messages).map((m) => m.toolCallId),
    ["s1", "f1"],
  );
});

test("executionMode 'sequential' on ANY call serializes the whole batch in call order", async () => {
  const log: string[] = [];
  const slow = makeTool("slow", {
    executionMode: "sequential",
    execute: async () => {
      log.push("start:slow");
      await delay(30);
      log.push("end:slow");
      return { content: [{ type: "text" as const, text: "slow" }] };
    },
  });
  const fast = makeTool("fast", {
    execute: async () => {
      log.push("start:fast");
      log.push("end:fast");
      return { content: [{ type: "text" as const, text: "fast" }] };
    },
  });
  const turns: FakeTurn[] = [
    {
      type: "toolcall",
      calls: [{ id: "s1", name: "slow", args: {} }, { id: "f1", name: "fast", args: {} }],
    },
    { type: "text", text: "end" },
  ];
  await drainLoop(turns, [slow.tool, fast.tool]);

  // Serialized: slow fully finished before fast started.
  assert.deepEqual(log, ["start:slow", "end:slow", "start:fast", "end:fast"]);
});

// ─────────────────────────── tool failure modes (I3) ───────────────────────────

test("unknown tool → error result 'not found', no throw", async () => {
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "g1", name: "ghost", args: {} }] },
    { type: "text", text: "recovered" },
  ];
  const events = await drainLoop(turns, []);
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stop", "run survives an unknown tool");

  const ends = toolEndEvents(events);
  assert.equal(ends.length, 1);
  assert.equal(ends[0]!.result.isError, true);
  assert.match(ends[0]!.result.content[0]!.text, /not found/);
});

test("tool that throws (I3 violation) → error result, run survives", async () => {
  const boom = makeTool("boom", {
    execute: async () => {
      throw new Error("kaboom");
    },
  });
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "b1", name: "boom", args: {} }] },
    { type: "text", text: "still alive" },
  ];
  const events = await drainLoop(turns, [boom.tool]);
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stop");

  const ends = toolEndEvents(events);
  assert.equal(ends.length, 1);
  assert.equal(ends[0]!.result.isError, true);
  assert.match(ends[0]!.result.content[0]!.text, /threw/);
});

// ─────────────────────────── caps & hooks ───────────────────────────

test("maxTurns caps the number of LLM turns (cap-hit is an explicit budget outcome)", async () => {
  // maxContinuations: 0 — the pre-C26 hard-stop semantics (no auto-continue).
  const { tool } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: {} }] },
    { type: "text", text: "never reached" },
  ];
  const events = await drainLoop(turns, [tool], { maxTurns: 1, maxContinuations: 0 });
  const end = agentEnd(events);
  assert.equal(events.filter((e) => e.type === "turn_start").length, 1);
  assert.equal(end.stopReason, "budget", "the cap-hit is an explicit budget outcome");
  assert.equal(end.maxTurns, 1, "agent_end carries the cap it hit");
});

test("maxTurns=2 with a model that keeps issuing tool calls → agent_end stopReason budget + maxTurns", async () => {
  const { tool } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: {} }] },
    { type: "toolcall", calls: [{ id: "c2", name: "read", args: {} }] },
    { type: "text", text: "never reached" },
  ];
  const events = await drainLoop(turns, [tool], { maxTurns: 2, maxContinuations: 0 });
  const end = agentEnd(events);
  assert.equal(events.filter((e) => e.type === "turn_start").length, 2);
  assert.equal(end.stopReason, "budget");
  assert.equal(end.maxTurns, 2);
});

test("normal short run is unaffected: agent_end stopReason stop, no maxTurns on the event", async () => {
  const { tool } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: {} }] },
    { type: "text", text: "all done" },
  ];
  const events = await drainLoop(turns, [tool], { maxTurns: 8 });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stop");
  assert.equal(end.maxTurns, undefined, "a normal stop carries no cap");
});

// ─────────────────────── C24: model-derived turn cap ───────────────────────

test("deriveMaxTurns: scales with contextWindow/maxTokens, ample for large windows", () => {
  // The headline case: a 200k-window / 8k-output model must get HUNDREDS of
  // turns of runway (the old hardcoded 32 was far too tight for long jobs).
  assert.equal(deriveMaxTurns(200_000, 8_000), 250);
  // Scales with the window (same output cap): bigger window → more turns.
  assert.ok(deriveMaxTurns(400_000, 8_000) > deriveMaxTurns(200_000, 8_000));
  // Scales with the output cap (same window): bigger output → fewer turns.
  assert.ok(deriveMaxTurns(200_000, 16_000) < deriveMaxTurns(200_000, 8_000));
  // Smaller models scale down; the floor keeps them sane.
  assert.equal(deriveMaxTurns(80_000, 16_000), 64); // 50 → floored to 64
  assert.equal(deriveMaxTurns(32_000, 4_096), 78); // 7.8125 × 10 → 78
});

test("deriveMaxTurns: floor (64) and ceiling (4096) clamp degenerate configs", () => {
  // Tiny window / huge output cap → ratio < 64 → floored to 64.
  assert.equal(deriveMaxTurns(1_000, 16_000), 64);
  // maxTokens <= 0 (degenerate) → no finite ratio → ceiling, not 0/Infinity.
  assert.equal(deriveMaxTurns(200_000, 0), 4096);
  assert.equal(deriveMaxTurns(200_000, -5), 4096);
  // Huge window → ceiling, so a stuck loop still terminates in bounded time.
  assert.equal(deriveMaxTurns(10_000_000, 8_000), 4096);
  // Never below the floor, never above the ceiling, always a positive int.
  for (const [w, m] of [[1, 100], [100, 1], [200_000, 8_000], [1, 1]] as const) {
    const n = deriveMaxTurns(w, m);
    assert.ok(Number.isInteger(n) && n >= 64 && n <= 4096, `(${w},${m}) -> ${n}`);
  }
});

test("runLoop with NO maxTurns uses the model-derived cap (guard stays on)", async () => {
  // A model with a small derived cap (32k/4k → 80) — but we make the model
  // loop forever (always a tool call) and assert the run STOPS with
  // stopReason "budget" and agent_end.maxTurns === the derived value.
  // This proves the guard is ON even when maxTurns is not passed.
  // maxContinuations: 0 pins the pre-C26 semantics for this test (the
  // point here is the DERIVED cap, not auto-continuation). Distinct args
  // per turn so C26 loop detection (identical batch 3×) never interferes.
  const { tool } = makeTool("read");
  const turns: FakeTurn[] = Array.from({ length: 90 }, (_, i) => ({
    type: "toolcall",
    calls: [{ id: `c${i}`, name: "read", args: { n: i } }],
  }));
  const events = await drainLoop(turns, [tool], { maxContinuations: 0 }); // no maxTurns → derived (78)
  const end = agentEnd(events);
  assert.equal(end.stopReason, "budget", "the derived cap is an explicit budget outcome");
  assert.equal(end.maxTurns, 78, "agent_end carries the DERIVED cap it hit");
  assert.equal(events.filter((e) => e.type === "turn_start").length, 78);
});

test("explicit maxTurns overrides the derived cap (smaller and larger)", async () => {
  const { tool } = makeTool("read");
  // Smaller than the derived 78: the explicit cap wins.
  const small = await drainLoop(
    Array.from({ length: 20 }, (_, i) => ({
      type: "toolcall",
      calls: [{ id: `s${i}`, name: "read", args: { n: i } }], // distinct: no loop detection
    })),
    [tool],
    { maxTurns: 3, maxContinuations: 0 }, // pre-C26 hard stop (this test is about the cap)
  );
  assert.equal(agentEnd(small).stopReason, "budget");
  assert.equal(agentEnd(small).maxTurns, 3);
  assert.equal(small.filter((e) => e.type === "turn_start").length, 3);

  // Larger than the derived 78: a run that would budget at 78 is allowed to
  // run PAST it (90 tool turns + a final stop) and complete normally — proving
  // the raised cap is honored, not the derived one.
  const big = await drainLoop(
    [
      ...Array.from({ length: 90 }, (_, i) => ({
        type: "toolcall" as const,
        calls: [{ id: `b${i}`, name: "read", args: { n: i } }], // distinct: no loop detection
      })),
      { type: "text", text: "done" },
    ],
    [tool],
    { maxTurns: 500 },
  );
  assert.equal(agentEnd(big).stopReason, "stop");
  assert.equal(agentEnd(big).maxTurns, undefined);
  assert.equal(big.filter((e) => e.type === "turn_start").length, 91);
});

test("prepareNextTurn can rewrite the next turn's context", async () => {
  const { tool } = makeTool("read");
  const seen: LlmContext[] = [];
  const base = fakeStream(
    [
      { type: "toolcall", calls: [{ id: "c1", name: "read", args: { path: "a" } }] },
      { type: "text", text: "final" },
    ],
    { model: MODEL },
  );
  // LlmContext.messages is a LIVE reference to the loop's context array
  // (the loop mutates it in place), so clone at capture time.
  const streamFn: StreamFn = (m, ctx, o) => {
    seen.push({ ...ctx, messages: JSON.parse(JSON.stringify(ctx.messages)) });
    return base(m, ctx, o);
  };
  const summary: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "summary" }],
    model: "fake-model",
    provider: "fake",
    stopReason: "stop",
    timestamp: 0,
  };
  const gen = runLoop({
    model: MODEL,
    systemPrompt: "sys",
    initialMessages: [userMsg("hi")],
    tools: [tool],
    streamFn,
    signal: new AbortController().signal,
    prepareNextTurn: (_ctx, turn) =>
      turn === 2 ? [userMsg("rewritten"), summary] : undefined, // turn 1: keep
  });
  const events = await drain(gen);
  const end = agentEnd(events);

  // Turn 2's LlmContext saw the rewritten context (turn 1's did not).
  assert.equal(seen.length, 2);
  assert.deepEqual(normalize(seen[0]!.messages), [userMsg("hi")]);
  assert.deepEqual(normalize(seen[1]!.messages), [userMsg("rewritten"), summary]);

  // Final context = rewritten base + turn 2's assistant message.
  assert.deepEqual(normalize(end.messages), [
    userMsg("rewritten"),
    summary,
    {
      role: "assistant",
      content: [{ type: "text", text: "final" }],
      model: "fake-model",
      provider: "fake",
      stopReason: "stop",
      timestamp: 0,
    },
  ]);
});

// ─────────────────────── C26: smart turn budget ───────────────────────
// The turn cap is per-CYCLE: at exhaustion the loop injects a continuation
// nudge and resets the counter (up to maxContinuations times). The real
// runaway protection is LOOP DETECTION: the same batch 3× in a row is not
// executed on the third repeat and the run stops with stopReason "loop".

test("C26: budget exhaustion auto-continues — nudge injected, counter reset, run completes", async () => {
  const { tool, calls } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: { n: 1 } }] },
    { type: "toolcall", calls: [{ id: "c2", name: "read", args: { n: 2 } }] },
    { type: "text", text: "done after the continuation" },
  ];
  const events = await drainLoop(turns, [tool], { maxTurns: 2 }); // default continuations
  const end = agentEnd(events);
  // Turn 3 was only possible because the budget hit auto-continued.
  assert.equal(end.stopReason, "stop", "the run completes past the first budget hit");
  assert.equal(events.filter((e) => e.type === "turn_start").length, 3);
  const budget = events.filter((e) => e.type === "turn_budget");
  assert.equal(budget.length, 1, "one turn_budget event at the first exhaustion");
  assert.deepEqual(
    budget[0],
    { type: "turn_budget", turn: 2, cycle: 1, maxCycles: 4, maxTurns: 2 },
  );
  // The nudge text is in the final context (the model saw it).
  const nudges = end.messages.filter(
    (m) => m.role === "user" && m.content === BUDGET_CONTINUE_TEXT,
  );
  assert.equal(nudges.length, 1, "BUDGET_CONTINUE_TEXT injected into context");
  // Both tool calls executed (the budget hit happened BETWEEN turns).
  assert.equal(calls.length, 2);
});

test("C26: every continuation spent → stopReason budget + maxCycles on agent_end", async () => {
  const { tool, calls } = makeTool("read");
  const turns: FakeTurn[] = Array.from({ length: 5 }, (_, i) => ({
    type: "toolcall",
    calls: [{ id: `c${i}`, name: "read", args: { n: i } }],
  }));
  const events = await drainLoop(turns, [tool], { maxTurns: 1, maxContinuations: 1 });
  const end = agentEnd(events);
  // Cycle 1: turn 1. Budget. Continuation 1: turn 2. Budget. Spent → stop.
  assert.equal(end.stopReason, "budget");
  assert.equal(end.maxTurns, 1);
  assert.equal(end.maxCycles, 2, "agent_end carries the cycle count");
  assert.equal(events.filter((e) => e.type === "turn_start").length, 2);
  assert.equal(events.filter((e) => e.type === "turn_budget").length, 1);
  assert.equal(calls.length, 2);
});

test("C26: maxContinuations 0 → legacy hard stop at the first budget hit", async () => {
  const { tool, calls } = makeTool("read");
  const turns: FakeTurn[] = Array.from({ length: 5 }, (_, i) => ({
    type: "toolcall",
    calls: [{ id: `c${i}`, name: "read", args: { n: i } }],
  }));
  const events = await drainLoop(turns, [tool], { maxTurns: 2, maxContinuations: 0 });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "budget");
  assert.equal(events.filter((e) => e.type === "turn_start").length, 2);
  assert.equal(events.filter((e) => e.type === "turn_budget").length, 0);
});

test("C26: loop detection — same batch 3× → guarded, auto-retry once, then stopReason loop", async () => {
  const { tool, calls } = makeTool("read");
  const same = { id: "c1", name: "read", args: { path: "x" } };
  // SIX identical turns: the first 3 fire the guard (→ 1 auto-retry), the
  // next 3 re-fire it (the retry is spent) → the run stops with "loop".
  const turns: FakeTurn[] = Array.from({ length: 6 }, () => ({
    type: "toolcall",
    calls: [same],
  }));
  const events = await drainLoop(turns, [tool], { maxTurns: 50 });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "loop", "the guard re-fires after the retry is spent");
  assert.equal(end.maxTurns, undefined, "a loop stop is not a budget stop");
  // One autonomous retry happened (default maxGuardRetries = 1).
  const retries = events.filter((e) => e.type === "guard_retry");
  assert.equal(retries.length, 1, "one guard_retry event (the single auto-retry)");
  assert.deepEqual(retries[0], {
    type: "guard_retry",
    turn: 3,
    retry: 1,
    maxRetries: 1,
    // loop-v2: the event names the pattern that fired (audit re-fix
    // 2026-11-02) so the transcript never claims "3× in a row" for cycles;
    // the fired guard's own repeat count rides along (re-audit 2026-11-02).
    reason: "identical",
    repeats: 3,
  });
  // The guarded batches (turns 3 and 6) were NOT executed; turns 1,2,4,5 were.
  assert.equal(calls.length, 4, "the two guarded batches were not executed");
  // Both guarded batches got in-band error results (I3).
  const guardedResults = events.filter(
    (e) => e.type === "tool_execution_end" && e.result.isError === true,
  );
  assert.equal(guardedResults.length, 2, "each guarded batch got an error result");
  for (const g of guardedResults) {
    const text = (g as Extract<AgentEvent, { type: "tool_execution_end" }>)
      .result.content[0] as { type: "text"; text: string };
    assert.match(text.text, /Runaway loop detected/);
  }
  // The approach-changing nudge is in the final context (the model saw it).
  const nudges = end.messages.filter(
    (m) => m.role === "user" && m.content === GUARD_RETRY_TEXT,
  );
  assert.equal(nudges.length, 1, "GUARD_RETRY_TEXT injected into context");
  // No turn_budget was involved.
  assert.equal(events.filter((e) => e.type === "turn_budget").length, 0);
});

test("loop guard: maxGuardRetries 0 → legacy hard stop at the first guard hit", async () => {
  const { tool, calls } = makeTool("read");
  const same = { id: "c1", name: "read", args: { path: "x" } };
  const turns: FakeTurn[] = Array.from({ length: 4 }, () => ({
    type: "toolcall",
    calls: [same],
  }));
  const events = await drainLoop(turns, [tool], { maxTurns: 50, maxGuardRetries: 0 });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "loop", "0 retries = stop at the first guard hit");
  assert.equal(events.filter((e) => e.type === "guard_retry").length, 0, "no retry");
  assert.equal(calls.length, 2, "only the first two repeats executed");
  assert.equal(
    events.filter((e) => e.type === "tool_execution_end" && e.result.isError === true).length,
    1,
    "the 3rd identical batch was not executed (one guarded result)",
  );
  // The 4th scripted turn was never consumed (the run stopped at turn 3).
  assert.equal(events.filter((e) => e.type === "turn_start").length, 3);
});

test("loop guard: the auto-retry lets a model that changes approach recover", async () => {
  const { tool, calls } = makeTool("read");
  const a = { id: "c1", name: "read", args: { path: "x" } };
  const b = { id: "c2", name: "read", args: { path: "y" } };
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [a] },
    { type: "toolcall", calls: [a] },
    { type: "toolcall", calls: [a] }, // 3rd identical → guard fires → auto-retry
    { type: "toolcall", calls: [b] }, // nudged: the model picks a different action
    { type: "text", text: "recovered" },
  ];
  const events = await drainLoop(turns, [tool], { maxTurns: 50 });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stop", "the run recovers and completes normally");
  const retries = events.filter((e) => e.type === "guard_retry");
  assert.equal(retries.length, 1, "one auto-retry");
  // a ran twice (executed), the 3rd a was guarded, then b ran once.
  assert.equal(calls.length, 3, "a×2 + b×1 executed; the guarded a was not");
  const nudges = end.messages.filter(
    (m) => m.role === "user" && m.content === GUARD_RETRY_TEXT,
  );
  assert.equal(nudges.length, 1, "the approach-changing nudge is in context");
});

test("stall: a result with details.stall → run stops with stopReason stall", async () => {
  // The tool pipeline's stall guard answers the 3rd identical permission
  // failure in-band with details.stall (never executed). The loop maps that
  // detail onto stopReason "stall" and stops — resumable like "loop".
  //
  // NOTE: the batches use DIFFERENT arguments each turn so the loop's own
  // C26 batch guard (3 identical batches, checked pre-execution) does NOT
  // fire first — this test isolates the stall mapping. (When the model
  // re-issues the EXACT same call 3×, the loop guard fires first and wins;
  // the stall guard then covers the case where the batch varies but the
  // same call keeps failing — see the pipeline tests in tools.test.ts.)
  const { tool } = makeTool("bash");
  let n = 0;
  const executor: ExecuteToolCall = async (t, c, sig, onUpdate) => {
    n += 1;
    if (n >= 3) {
      // Simulate the pipeline's stall guard on the 3rd failure.
      return {
        content: [{ type: "text", text: "STALL_TEXT (not executed)" }],
        isError: true,
        details: { stall: true },
      };
    }
    return tool.execute(c.id, c.arguments, sig, onUpdate);
  };
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "bash", args: { command: "cat /etc/shadow" } }] },
    { type: "toolcall", calls: [{ id: "c2", name: "bash", args: { command: "cat /etc/shadow; echo 2" } }] },
    { type: "toolcall", calls: [{ id: "c3", name: "bash", args: { command: "cat /etc/shadow; echo 3" } }] },
  ];
  const events = await drainLoop(turns, [tool], { maxTurns: 50, executeToolCall: executor });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stall", "the stall detail stops the run");
  const guarded = events.filter(
    (e) => e.type === "tool_execution_end" && e.result.isError === true,
  ) as Extract<AgentEvent, { type: "tool_execution_end" }>[];
  assert.equal(guarded.length, 1, "the guarded call got one in-band error result (I3)");
  assert.match(guarded[0]!.result.content[0]!.text, /STALL_TEXT/);
});

test("stall-skip (2026-11-27 audit): a sequential batch stops dispatching AFTER a stall result", async () => {
  // A sequential tool (edit) in the batch opts the WHOLE batch into call
  // order; when the first call comes back details.stall, every LATER call
  // is skipped with a synthetic notExecuted result — the only path where
  // a queued call is prevented from running, and evidence.skipped says
  // how many.
  const executed: string[] = [];
  const staller = makeTool("staller", {
    executionMode: "sequential",
    execute: async () => ({
      content: [{ type: "text" as const, text: "stalled" }],
      isError: true,
      details: {
        stall: true,
        stallEvidence: {
          guard: "same-error-stall",
          tool: "staller",
          repeats: 5,
          consecutive: true as const,
          errorExcerpt: "boom",
        },
      },
    }),
  });
  const later = makeTool("later", {
    execute: async (id) => {
      executed.push(id);
      return { content: [{ type: "text" as const, text: "ran" }] };
    },
  });
  const turns: FakeTurn[] = [
    {
      type: "toolcall",
      calls: [
        { id: "s1", name: "staller", args: {} },
        { id: "l1", name: "later", args: {} },
        { id: "l2", name: "later", args: {} },
      ],
    },
    { type: "text", text: "should not be reached" },
  ];
  const events = await drainLoop(turns, [staller.tool, later.tool], { maxTurns: 50 });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stall");
  assert.deepEqual(executed, [], "calls queued AFTER the stall never ran");
  const skipped = toolResultMessages(end.messages).filter((m) =>
    /call was skipped/.test(m.content.map((c) => ("text" in c ? c.text : "")).join("")),
  );
  assert.equal(skipped.length, 2, "both queued calls got in-band skip results (I3)");
  assert.equal(end.evidence?.guard, "same-error-stall");
  assert.equal(
    "skipped" in (end.evidence ?? {}) ? (end.evidence as { skipped?: number }).skipped : undefined,
    2,
    "evidence names how many calls were prevented",
  );
});

test("stall-skip: a PARALLEL batch runs all calls (documented limit)", async () => {
  // Parallel dispatch is in flight before any result exists — the guards
  // cannot un-run it. The stall still stops the run AFTER the batch, but
  // every call executed. Pinned so the limitation stays explicit and any
  // future change to it is a deliberate contract change.
  let executed = 0;
  const failing = makeTool("par", {
    execute: async () => {
      executed += 1;
      return {
        content: [{ type: "text" as const, text: "boom" }],
        isError: true,
        details: { stall: true },
      };
    },
  });
  const turns: FakeTurn[] = [
    {
      type: "toolcall",
      calls: [
        { id: "p1", name: "par", args: {} },
        { id: "p2", name: "par", args: {} },
      ],
    },
  ];
  const events = await drainLoop(turns, [failing.tool], { maxTurns: 50 });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stall");
  assert.equal(executed, 2, "parallel calls are already in flight — both ran (honest limit)");
});

test("stall: a stall stop is NOT a budget or loop stop", async () => {
  const { tool } = makeTool("bash");
  const executor: ExecuteToolCall = async (t, c, sig, onUpdate) => {
    const r = await tool.execute(c.id, c.arguments, sig, onUpdate);
    return { ...r, details: { stall: true } };
  };
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "bash", args: { command: "x" } }] },
  ];
  const events = await drainLoop(turns, [tool], { maxTurns: 50, executeToolCall: executor });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stall");
  assert.equal(events.filter((e) => e.type === "turn_budget").length, 0);
});

test("C26: two identical batches are ALLOWED (legit retry) — only 3 in a row trips", async () => {
  const { tool, calls } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: { path: "x" } }] },
    { type: "toolcall", calls: [{ id: "c2", name: "read", args: { path: "x" } }] },
    { type: "toolcall", calls: [{ id: "c3", name: "read", args: { path: "y" } }] },
    { type: "text", text: "ok" },
  ];
  const events = await drainLoop(turns, [tool], { maxTurns: 50 });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stop");
  assert.equal(calls.length, 3, "all three batches executed (2×x then y)");
  assert.equal(events.filter((e) => e.type === "tool_execution_end").length, 3);
});

test("C26: loop history resets when a DIFFERENT batch intervenes", async () => {
  const { tool, calls } = makeTool("read");
  const a = { id: "a", name: "read", args: { path: "a" } };
  const b = { id: "b", name: "read", args: { path: "b" } };
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [a] },
    { type: "toolcall", calls: [a] }, // two a's — not yet a loop
    { type: "toolcall", calls: [b] }, // different batch breaks the chain
    { type: "toolcall", calls: [a] }, // a again — chain is [b, a], no loop
    { type: "text", text: "ok" },
  ];
  const events = await drainLoop(turns, [tool], { maxTurns: 50 });
  assert.equal(agentEnd(events).stopReason, "stop");
  assert.equal(calls.length, 4);
});

test("C26: length-guarded batches count toward the loop signature too", async () => {
  // A model stuck re-issuing the SAME truncated call: length-guard errors
  // on repeats 1–2, the loop guard fires on repeat 3 (→ 1 auto-retry), the
  // pattern repeats, and the guard re-fires on the 6th (retry spent) → stop.
  const { tool, calls } = makeTool("read");
  const truncated = { id: "t1", name: "read", args: { path: "x" } };
  const turns: FakeTurn[] = Array.from({ length: 6 }, () => ({
    type: "length",
    calls: [truncated],
  }));
  const events = await drainLoop(turns, [tool], { maxTurns: 50 });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "loop", "the guard re-fires after the retry is spent");
  assert.equal(calls.length, 0, "truncated calls are never executed");
  assert.equal(
    events.filter((e) => e.type === "guard_retry").length,
    1,
    "one auto-retry",
  );
  // Repeats 1–2 got the length-guard text, repeat 3 the loop text (→ retry),
  // then 4–5 length-guard, 6 loop text (retry spent → stop).
  const ends = events.filter(
    (e) => e.type === "tool_execution_end" && e.result.isError === true,
  ) as Extract<AgentEvent, { type: "tool_execution_end" }>[];
  assert.equal(ends.length, 6);
  assert.match(ends[0]!.result.content[0]!.text, /truncated/);
  assert.match(ends[1]!.result.content[0]!.text, /truncated/);
  assert.match(ends[2]!.result.content[0]!.text, /Runaway loop detected/);
  assert.match(ends[5]!.result.content[0]!.text, /Runaway loop detected/);
});

test("C26: batchSignature — stable across key order, sensitive to tool/args", () => {
  const s1 = batchSignature([{ type: "toolCall", id: "x", name: "read", arguments: { a: 1, b: [2, 3] } }]);
  const s2 = batchSignature([{ type: "toolCall", id: "y", name: "read", arguments: { b: [2, 3], a: 1 } }]);
  assert.equal(s1, s2, "key order and call ids do not change identity");
  assert.notEqual(
    s1,
    batchSignature([{ type: "toolCall", id: "x", name: "read", arguments: { a: 2, b: [2, 3] } }]),
    "different args → different signature",
  );
  assert.notEqual(
    s1,
    batchSignature([{ type: "toolCall", id: "x", name: "write", arguments: { a: 1, b: [2, 3] } }]),
    "different tool → different signature",
  );
  assert.notEqual(
    s1,
    batchSignature([
      { type: "toolCall", id: "x", name: "read", arguments: { a: 1 } },
      { type: "toolCall", id: "z", name: "read", arguments: { b: 2 } },
    ]),
    "different batch shape → different signature",
  );
});

// ────────────────── loop detection v2 (2026-10-31 audit) ──────────────────
// Result-aware identical guard, period-2 cycle guard, hard poll caps, and
// the digest/evidence hardening from the 2026-11-02 re-audit.

test("loop v2: stable identical repeat still stops at 3 (notExecuted, retry, evidence)", async () => {
  const { tool, calls } = makeTool("read");
  const same = { id: "c1", name: "read", args: { path: "x" } };
  const turns: FakeTurn[] = Array.from({ length: 6 }, () => ({
    type: "toolcall",
    calls: [same],
  }));
  const events = await drainLoop(turns, [tool], { maxTurns: 50 });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "loop");
  // 4 executed (1,2 + 4,5 after the single retry), 3rd + 6th guarded.
  assert.equal(calls.length, 4, "guarded batches were not executed");
  for (const turn of [3, 6]) {
    const fill = events.filter(
      (e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
        e.type === "tool_execution_end" &&
        e.result.details?.notExecuted === true &&
        e.result.content.some((c) => c.text.includes("Runaway loop detected")),
    );
    assert.equal(fill.length, 2, `both guard fills present (turns ${turn} context)`);
    for (const f of fill) assert.equal(f.result.details?.notExecuted, true);
  }
  assert.deepEqual(end.evidence, {
    guard: "identical-batch",
    signature: batchSignature([
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } },
    ]),
    repeats: 3,
    stable: true,
    guardRetries: 1,
  });
});

test("loop v2: fresh-result identical repeats are progress until the poll cap", async () => {
  // 11 fresh-result identical batches + a text finish: allowed through
  // (progress), no guard text in context.
  let n = 0;
  const probe2 = makeTool("read", {
    execute: (async () => ({
      content: [{ type: "text", text: `revision ${++n}` }],
    })) as Tool["execute"],
  });
  const fresh2 = probe2.tool;
  const turns: FakeTurn[] = [
    ...Array.from({ length: 11 }, () => ({
      type: "toolcall" as const,
      calls: [{ id: "c1", name: "read", args: { path: "x" } }],
    })),
    { type: "text" as const, text: "done" },
  ];
  const events = await drainLoop(turns, [fresh2], { maxTurns: 50 });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stop", "fresh results are progress, not a loop");
  assert.equal(probe2.calls.length, 11, "all 11 executed (none refused)");
  assert.ok(
    !events.some(
      (e) =>
        e.type === "tool_execution_end" &&
        e.result.content.some((c) => c.text.includes("Runaway loop detected")),
    ),
    "no guard text",
  );
});

test("loop v2: fresh-result identical repeats stop at the cap with cap text + cap evidence", async () => {
  let n = 0;
  const probe2b = makeTool("read", {
    execute: (async () => ({
      content: [{ type: "text", text: `revision ${++n}` }],
    })) as Tool["execute"],
  });
  const fresh3 = probe2b.tool;
  const turns: FakeTurn[] = Array.from({ length: 30 }, () => ({
    type: "toolcall",
    calls: [{ id: "c1", name: "read", args: { path: "x" } }],
  }));
  const events = await drainLoop(turns, [fresh3], {
    maxTurns: 100,
    maxGuardRetries: 0,
  });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "loop");
  assert.equal(probe2b.calls.length, POLL_CAP - 1, `the first ${POLL_CAP - 1} execute; the ${POLL_CAP}th is refused`);
  const fills = events.filter(
    (e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
      e.type === "tool_execution_end" && e.result.isError === true,
  );
  assert.equal(fills.length, 1, "one cap fill");
  assert.match(
    fills[0]!.result.content.map((c) => (c.type === "text" ? c.text : "")).join(" "),
    /issued 12 times[\s\S]*Repeating is bounded/,
    "cap text names the pattern size neutrally (no results claim either way)",
  );
  assert.deepEqual(end.evidence, {
    guard: "identical-batch",
    signature: batchSignature([
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } },
    ]),
    repeats: POLL_CAP,
    stable: false,
    capReason: "fresh",
    guardRetries: 0,
  });
});

test("loop v2: stable alternation stops at the 3rd cycle of the current position", async () => {
  // X,Y,X,Y then the third X is refused (5th batch issued in-pattern).
  const xa = makeTool("a");
  const xb = makeTool("b");
  const alternating = (i: number): FakeTurn => ({
    type: "toolcall",
    calls: [{ id: `c${i}`, name: i % 2 ? "b" : "a", args: { q: 1 } }],
  });
  const turns: FakeTurn[] = [
    alternating(0),
    alternating(1),
    alternating(2),
    alternating(3),
    alternating(4),
  ];
  const tools = [xa.tool, xb.tool];
  const events = await drainLoop(turns, tools, {
    maxTurns: 50,
    maxGuardRetries: 0,
  });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "loop");
  assert.equal(
    xa.calls.length + xb.calls.length,
    4,
    "X,Y,X,Y executed; the 3rd X refused",
  );
  assert.match(
    events
      .filter(
        (e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
          e.type === "tool_execution_end" && e.result.isError === true,
      )[0]!
      .result.content.map((c) => (c.type === "text" ? c.text : ""))
      .join(" "),
    /alternately[\s\S]*unchanged results/,
    "stable cycle text",
  );
  const ev = end.evidence;
  assert.equal(ev?.guard, "cycle-batch");
  if (ev?.guard === "cycle-batch") {
    assert.equal(ev.cycleLength, 2);
    assert.equal(ev.repeats, 5, "unified unit: 4 issued + the refused batch");
    assert.equal(ev.stable, true);
    assert.equal(ev.guardRetries, 0);
  }
});

test("loop v2: fresh-result alternation is progress until the cycle cap", async () => {
  const mkCounter = (name: string, prefix: string) => {
    let n = 0;
    return makeTool(name, {
      execute: (async () => ({
        content: [{ type: "text", text: `${prefix}${++n}` }],
      })) as Tool["execute"],
    });
  };
  const xa = mkCounter("a", "A");
  const xb = mkCounter("b", "B");
  // 10 fresh alternating batches + finish: allowed (below the cap).
  const turns: FakeTurn[] = [
    ...Array.from({ length: 10 }, (_, i) => ({
      type: "toolcall" as const,
      calls: [{ id: `c${i}`, name: i % 2 ? "b" : "a", args: { q: 1 } }],
    })),
    { type: "text" as const, text: "done" },
  ];
  const events = await drainLoop(turns, [xa.tool, xb.tool], { maxTurns: 50 });
  assert.equal(agentEnd(events).stopReason, "stop", "changing A/B results are progress");
});

test("loop v2: fresh-result alternation stops at the cycle cap with cap text", async () => {
  const mkCounter = (name: string, prefix: string) => {
    let n = 0;
    return makeTool(name, {
      execute: (async () => ({
        content: [{ type: "text", text: `${prefix}${++n}` }],
      })) as Tool["execute"],
    });
  };
  const xa = mkCounter("a", "A");
  const xb = mkCounter("b", "B");
  const turns: FakeTurn[] = Array.from({ length: 30 }, (_, i) => ({
    type: "toolcall",
    calls: [{ id: `c${i}`, name: i % 2 ? "b" : "a", args: { q: 1 } }],
  }));
  const events = await drainLoop(turns, [xa.tool, xb.tool], {
    maxTurns: 100,
    maxGuardRetries: 0,
  });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "loop");
  assert.equal(
    xa.calls.length + xb.calls.length,
    CYCLE_CAP - 1,
    `${CYCLE_CAP - 1} executed; the ${CYCLE_CAP}th refused`,
  );
  const ev = end.evidence;
  assert.equal(ev?.guard, "cycle-batch");
  if (ev?.guard === "cycle-batch") {
    assert.equal(ev.stable, false, "cap stop, not stable");
    assert.equal(ev.repeats, CYCLE_CAP, "unified unit: issued batches incl. the refused one");
    assert.equal(ev.capReason, "fresh", "live results were still arriving");
  }
  assert.match(
    events
      .filter(
        (e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
          e.type === "tool_execution_end" && e.result.isError === true,
      )[0]!
      .result.content.map((c) => (c.type === "text" ? c.text : ""))
      .join(" "),
    /alternately/,
    "cap cycle text names the pattern (neutral: no results claim)",
  );
});

test("loop v2: multi-block results cannot collide across block boundaries", async () => {
  // Batch 1: ["a", "b"] as TWO blocks; batch 2: ["a\u0000b"] as ONE block;
  // batch 3 repeats batch 1's exact blocks. The old raw-join digest made
  // batch 2 look identical to batches 1/3 and fired; JSON digests keep
  // them distinct (comparison is batch1 === batch3: 2 apart, not 2 in a row).
  let n = 0;
  const shapedProbe = makeTool("read", {
    execute: (async () => {
      n += 1;
      return n === 2
        ? { content: [{ type: "text", text: "a\u0000b" }] }
        : {
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          };
    }) as Tool["execute"],
  });
  const shaped = shapedProbe.tool;
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: { path: "x" } }] },
    { type: "toolcall", calls: [{ id: "c2", name: "read", args: { path: "x" } }] },
    { type: "toolcall", calls: [{ id: "c3", name: "read", args: { path: "x" } }] },
    { type: "text", text: "done" },
  ];
  // maxGuardRetries: 0 — WITH the default auto-retry a false guard hit is
  // masked (history clears, the run finishes) and this test would pass on
  // the buggy digest. Hard stop: only a correct digest keeps the run green.
  const events = await drainLoop(turns, [shaped], { maxTurns: 50, maxGuardRetries: 0 });
  assert.equal(agentEnd(events).stopReason, "stop", "no false stable match from block-boundary text");
});

test("loop v2: successful text resembling the failure marker is not failure", async () => {
  // Stable X,Y cycles whose SUCCESSFUL text contains "\u0001E:" — the old
  // regex failure test on the raw joined digest mistook these for FAILED
  // batches and exempted them; the stored flag keeps the stable cycle
  // guard firing.
  const mk = (name: string, marker: string) =>
    makeTool(name, {
      execute: (async (_id: string, args: Record<string, unknown>) => ({
        content: [{ type: "text", text: `${String(args.q)}${marker}` }],
      })) as Tool["execute"],
    });
  const xa = mk("a", "\u0001E:decoy");
  const xb = mk("b", "\u0001E:decoy");
  const alternating = (i: number): FakeTurn => ({
    type: "toolcall",
    calls: [{ id: `c${i}`, name: i % 2 ? "b" : "a", args: { q: 1 } }],
  });
  const events = await drainLoop(
    [alternating(0), alternating(1), alternating(2), alternating(3), alternating(4)],
    [xa.tool, xb.tool],
    { maxTurns: 50, maxGuardRetries: 0 },
  );
  assert.equal(agentEnd(events).stopReason, "loop", "decoy text does not hide success-stable cycling");
});

test("loop v2: failed repeats stay exempt from the stable cycle rule", async () => {
  // Alternating X,Y where every call FAILS identically: the cycle guard
  // must not fire (the H2/pipeline stall path owns repeated failures).
  // Each batch errors; the guard's identical rule (pre-execution) matches
  // the v1 contract — exercise with distinct args so only the cycle rule
  // could fire, and expect NO loop stop within the scripted turns.
  const fail = (name: string) =>
    makeTool(name, {
      execute: (async () => ({
        content: [{ type: "text", text: `${name} exploded` }],
        isError: true,
      })) as Tool["execute"],
    });
  const xa = fail("a");
  const xb = fail("b");
  const turns: FakeTurn[] = [
    ...Array.from({ length: 4 }, (_, i) => ({
      type: "toolcall" as const,
      calls: [{ id: `c${i}`, name: i % 2 ? "b" : "a", args: { q: 1 } }],
    })),
    { type: "text" as const, text: "done" },
  ];
  const events = await drainLoop(turns, [xa.tool, xb.tool], { maxTurns: 50 });
  assert.equal(agentEnd(events).stopReason, "stop", "failed alternation never trips the cycle guard");
});

test("loop v2: batchSignature treats __proto__ args as ordinary keys", async () => {
  const s1 = batchSignature([
    {
      type: "toolCall",
      id: "x",
      name: "read",
      arguments: JSON.parse('{"__proto__":{"evil":1}}') as Record<string, unknown>,
    },
  ]);
  const s2 = batchSignature([
    {
      type: "toolCall",
      id: "x",
      name: "read",
      arguments: JSON.parse('{"__proto__":{"evil":2}}') as Record<string, unknown>,
    },
  ]);
  assert.notEqual(s1, s2, "different __proto__ payloads → different signatures");
});

// ─────────────────────────────── steering ───────────────────────────────────

/** A SteeringQueue backed by a plain array (the driver's shape). */
function makeQueue(): { q: string[]; queue: { push(t: string): void; drain(): string[] } } {
  const q: string[] = [];
  return {
    q,
    queue: {
      push: (t) => q.push(t),
      drain: () => {
        const out = [...q]; // copy: the loop iterates the snapshot
        q.length = 0; // clear the live array the test observes
        return out;
      },
    },
  };
}

/** Run the loop, pushing `steers` before the Nth stream call (1-based). */
async function drainSteered(
  turns: FakeTurn[],
  tools: Tool[],
  steerAtCall: number,
  steers: string[],
  extra: Partial<AgentLoopOptions> = {},
): Promise<{ events: AgentEvent[]; seen: LlmContext[]; queue: string[] }> {
  const { q, queue } = makeQueue();
  const seen: LlmContext[] = [];
  const base = fakeStream(turns, { model: MODEL });
  let call = 0;
  const streamFn: StreamFn = (m, ctx, o) => {
    call += 1;
    if (call === steerAtCall) for (const s of steers) q.push(s);
    seen.push({ ...ctx, messages: JSON.parse(JSON.stringify(ctx.messages)) });
    return base(m, ctx, o);
  };
  const events = await drain(
    runLoop({
      model: MODEL,
      systemPrompt: "sys",
      initialMessages: [userMsg("hi")],
      tools,
      streamFn,
      signal: new AbortController().signal,
      steeringQueue: queue,
      ...extra,
    }),
  );
  return { events, seen, queue: q };
}

test("steering: a steer typed during turn 1 is delivered as a user message before turn 2", async () => {
  const { tool } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: { path: "a" } }] },
    { type: "text", text: "done" },
  ];
  const { events, seen, queue } = await drainSteered(turns, [tool], 1, ["focus on the tests"]);
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stop");
  assert.equal(queue.length, 0, "the queue was drained");

  // The steer event was emitted, tagged with the turn it was delivered on.
  const steers = events.filter((e) => e.type === "steer");
  assert.equal(steers.length, 1);
  assert.equal(steers[0]!.type, "steer");
  if (steers[0]!.type === "steer") {
    assert.equal(steers[0]!.text, "focus on the tests");
    assert.equal(steers[0]!.turn, 2);
  }

  // Turn 2's LLM context carries the steer as a user message (after the
  // tool result); turn 1's did not.
  assert.equal(seen.length, 2);
  assert.deepEqual(normalize(seen[0]!.messages), [userMsg("hi")]);
  const ctx2 = seen[1]!.messages;
  assert.equal(ctx2.length, 4, "user, assistant, toolResult, steer");
  assert.equal(ctx2[3]!.role, "user");
  if (ctx2[3]!.role === "user") assert.equal(ctx2[3]!.content, "focus on the tests");

  // The steer is part of the final context the session persists.
  const last = end.messages[end.messages.length - 1]!;
  assert.equal(last.role, "assistant");
  assert.equal(end.messages.filter((m) => m.role === "user").length, 2);
});

test("steering: two steers are drained in order", async () => {
  const { tool } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: { path: "a" } }] },
    { type: "text", text: "done" },
  ];
  const { events, seen, queue } = await drainSteered(turns, [tool], 1, ["first steer", "second steer"]);
  assert.equal(queue.length, 0);
  const steers = events.filter((e) => e.type === "steer") as Extract<AgentEvent, { type: "steer" }>[];
  assert.equal(steers.length, 2);
  assert.equal(steers[0]!.text, "first steer");
  assert.equal(steers[1]!.text, "second steer");
  // Both landed as user messages, in order, before turn 2's LLM call.
  const ctx2 = seen[1]!.messages;
  assert.equal(ctx2[3]!.role, "user");
  assert.equal(ctx2[4]!.role, "user");
  if (ctx2[3]!.role === "user") assert.equal(ctx2[3]!.content, "first steer");
  if (ctx2[4]!.role === "user") assert.equal(ctx2[4]!.content, "second steer");
});

test("steering keep-alive: a pending steer keeps a text-only stop alive for one more turn", async () => {
  const { tool } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "text", text: "I think I am done" },
    { type: "text", text: "ok, actually finished" },
  ];
  const { events, seen, queue } = await drainSteered(turns, [tool], 1, ["no, fix the bug first"]);
  const end = agentEnd(events);
  assert.equal(queue.length, 0);
  assert.equal(end.stopReason, "stop");
  assert.equal(seen.length, 2, "the steer forced a second LLM call");
  const steers = events.filter((e) => e.type === "steer");
  assert.equal(steers.length, 1);
  if (steers[0]!.type === "steer") assert.equal(steers[0]!.turn, 1);
  // The steer was injected right after the text-only reply.
  const ctx2 = seen[1]!.messages;
  assert.equal(ctx2.length, 3, "user, assistant(text), steer");
  assert.equal(ctx2[2]!.role, "user");
  if (ctx2[2]!.role === "user") assert.equal(ctx2[2]!.content, "no, fix the bug first");
});

test("steering: no steer → normal stop, no steer events", async () => {
  const { tool } = makeTool("read");
  const turns: FakeTurn[] = [{ type: "text", text: "done" }];
  const { events, queue } = await drainSteered(turns, [tool], 1, []);
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stop");
  assert.equal(queue.length, 0);
  assert.equal(events.filter((e) => e.type === "steer").length, 0);
});

test("steering ordering: a steer is drained BEFORE prepareNextTurn — the hook sees it in context", async () => {
  const { tool } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: { path: "a" } }] },
    { type: "text", text: "done" },
  ];
  const hookContexts: AgentMessage[][] = [];
  const { events, seen, queue } = await drainSteered(
    turns,
    [tool],
    1,
    ["focus on the tests"],
    {
      prepareNextTurn: (ctx) => {
        hookContexts.push(JSON.parse(JSON.stringify(ctx)));
        return undefined;
      },
    },
  );
  assert.equal(queue.length, 0, "the queue was drained");
  assert.equal(hookContexts.length, 2, "the hook ran once per turn");
  // Turn 1: nothing queued yet.
  assert.equal(hookContexts[0]!.length, 1, "turn 1 hook context is just the user message");
  // Turn 2: the steer is ALREADY in the context the hook receives — a hook
  // deciding here (e.g. auto-compaction) sees the queued user guidance.
  const turn2 = hookContexts[1]!;
  const steerIdx = turn2.findIndex(
    (m) => m.role === "user" && m.content === "focus on the tests",
  );
  assert.notEqual(steerIdx, -1, "the steer is in the hook's context on turn 2");
  // The steer event is emitted before turn 2's stream starts (delivery
  // precedes the LLM call, and the hook runs in between).
  const turnStartIdx = events.findIndex((e) => e.type === "turn_start" && e.turn === 2);
  const steerEventIdx = events.findIndex((e) => e.type === "steer");
  const streamStartIdx = events.findIndex((e) => e.type === "start" && events.indexOf(e) > turnStartIdx);
  assert.ok(steerEventIdx > turnStartIdx, "the steer event follows turn 2's turn_start");
  assert.ok(steerEventIdx < streamStartIdx, "the steer event precedes turn 2's stream start");
  // The LLM context carries the steer too, after the tool result.
  const ctx2 = seen[1]!.messages;
  assert.equal(ctx2[3]!.role, "user");
  if (ctx2[3]!.role === "user") assert.equal(ctx2[3]!.content, "focus on the tests");
  // One push → exactly one steer event and one user message in the final
  // context (no duplicate delivery through the hook path).
  assert.equal(events.filter((e) => e.type === "steer").length, 1);
  const end = agentEnd(events);
  assert.equal(
    end.messages.filter((m) => m.role === "user" && m.content === "focus on the tests").length,
    1,
    "the steer appears exactly once in the final context",
  );
});

test("steering ordering: a compaction-style rewrite by prepareNextTurn keeps the steer", async () => {
  const { tool } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: { path: "a" } }] },
    { type: "text", text: "done" },
  ];
  const summary: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "summary" }],
    model: "fake-model",
    provider: "fake",
    stopReason: "stop",
    timestamp: 0,
  };
  // Turn 2: the hook folds the context down to [summary, …last 2 messages].
  // Because the steer was drained BEFORE the hook, it is among the "recent"
  // messages and survives the rewrite.
  const { events, seen, queue } = await drainSteered(
    turns,
    [tool],
    1,
    ["fix the bug first"],
    {
      prepareNextTurn: (ctx, turn) =>
        turn === 2 ? [summary, ...ctx.slice(-2)] : undefined,
    },
  );
  assert.equal(queue.length, 0);
  // The LLM context for turn 2 is the rewritten one — steer included.
  assert.deepEqual(normalize(seen[1]!.messages), [
    summary,
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "read ran" }],
      timestamp: 0,
    },
    userMsg("fix the bug first"),
  ]);
  // The steer was delivered exactly once and survives into the final
  // context the session persists.
  assert.equal(events.filter((e) => e.type === "steer").length, 1);
  const end = agentEnd(events);
  assert.equal(
    end.messages.filter((m) => m.role === "user" && m.content === "fix the bug first").length,
    1,
    "the steer appears exactly once in the final context",
  );
});

test("steering: an abort with a steer typed mid-stream discards it (queue is per-run)", async () => {
  const { q, queue } = makeQueue();
  const turns: FakeTurn[] = [{ type: "aborted" }];
  const base = fakeStream(turns, { model: MODEL });
  let call = 0;
  const streamFn: StreamFn = (m, ctx, o) => {
    call += 1;
    if (call === 1) q.push("typed too late"); // typed while turn 1's stream is in flight
    return base(m, ctx, o);
  };
  const events = await drain(
    runLoop({
      model: MODEL,
      systemPrompt: "sys",
      initialMessages: [userMsg("hi")],
      tools: [],
      streamFn,
      signal: new AbortController().signal,
      steeringQueue: queue,
    }),
  );
  const end = agentEnd(events);
  assert.equal(end.stopReason, "aborted");
  assert.equal(events.filter((e) => e.type === "steer").length, 0, "no steer was delivered");
  assert.equal(q.length, 1, "the abort left the queue undrained — the driver discards it");
  assert.equal(end.messages.length, 2, "user + aborted assistant; no steer message");
});

// ─────────────────────────────── D27 (steering/loop audit) ───────────────────

test("D27 F1: guidance arriving during the async prepareNextTurn hook is delivered on the same request", async () => {
  const { tool } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: { path: "a" } }] },
    { type: "text", text: "done" },
  ];
  const q: string[] = [];
  const queue = {
    push: (t: string) => q.push(t),
    drain: () => {
      const out = [...q];
      q.length = 0;
      return out;
    },
  };
  const seen: LlmContext[] = [];
  const base = fakeStream(turns, { model: MODEL });
  let call = 0;
  const streamFn: StreamFn = (m, ctx, o) => {
    call += 1;
    seen.push({ ...ctx, messages: JSON.parse(JSON.stringify(ctx.messages)) });
    return base(m, ctx, o);
  };
  const events = await drain(
    runLoop({
      model: MODEL,
      systemPrompt: "sys",
      initialMessages: [userMsg("hi")],
      tools: [tool],
      streamFn,
      signal: new AbortController().signal,
      steeringQueue: queue,
      prepareNextTurn: async (_ctx, turn) => {
        if (turn === 2) {
          // Simulate the async hook (auto-compaction) taking time; guidance
          // arrives WHILE it runs (after the one-shot pre-hook drain).
          await new Promise((r) => setTimeout(r, 10));
          q.push("late guidance");
        }
        return undefined;
      },
    }),
  );
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stop");
  // The late guidance was delivered on turn 2's request (seen[1]), NOT
  // deferred to a turn 3 — the second drain (post-hook) caught it.
  assert.equal(seen.length, 2, "exactly two LLM calls — the steer was not deferred");
  const ctx2 = seen[1]!.messages;
  const steerIdx = ctx2.findIndex((m) => m.role === "user" && m.content === "late guidance");
  assert.notEqual(steerIdx, -1, "the late guidance is in turn 2's LLM context");
  const steers = events.filter((e) => e.type === "steer");
  assert.equal(steers.length, 1);
  if (steers[0]!.type === "steer") assert.equal(steers[0]!.turn, 2);
});

test("D27 F2: fresh user guidance resets the identical-batch loop guard", async () => {
  const { tool, calls } = makeTool("read");
  const a = { id: "c1", name: "read", args: { path: "a" } };
  // Two identical batches (chain builds to [S, S]), then a steer, then one
  // more identical batch. Without the reset, the post-steer repeat (the 3rd
  // S in a row) would trip the loop guard. With the reset, the steer clears
  // sigHistory so the chain restarts and the repeat is legitimate.
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [a] },
    { type: "toolcall", calls: [a] },
    { type: "toolcall", calls: [a] },
    { type: "text", text: "done" },
  ];
  // steerAtCall=2: the steer is pushed during turn 2's stream, so it is
  // drained in turn 3's pre-hook drain — right before turn 3's batch is
  // checked against sigHistory.
  const { events, queue } = await drainSteered(
    turns,
    [tool],
    2,
    ["I changed a externally; read it again"],
  );
  const end = agentEnd(events);
  assert.equal(queue.length, 0, "the steer was drained");
  assert.equal(end.stopReason, "stop", "the post-steer repeat did NOT trip the loop guard");
  assert.equal(calls.length, 3, "all three reads executed (the steer reset the batch history)");
});

test("D27 F3: an abort during the async prepareNextTurn hook stops the run without a stream call", async () => {
  const { tool } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: { path: "a" } }] },
    { type: "text", text: "done" },
  ];
  const controller = new AbortController();
  const base = fakeStream(turns, { model: MODEL });
  let call = 0;
  const streamFn: StreamFn = (m, ctx, o) => {
    call += 1;
    return base(m, ctx, o);
  };
  const events = await drain(
    runLoop({
      model: MODEL,
      systemPrompt: "sys",
      initialMessages: [userMsg("hi")],
      tools: [tool],
      streamFn,
      signal: controller.signal,
      prepareNextTurn: async (_ctx, turn) => {
        if (turn === 2) {
          // Simulate an abort landing while the async hook (auto-compaction)
          // is in flight.
          await new Promise((r) => setTimeout(r, 10));
          controller.abort();
        }
        return undefined;
      },
    }),
  );
  const end = agentEnd(events);
  assert.equal(end.stopReason, "aborted", "the abort during the hook stops the run");
  assert.equal(call, 1, "the stream was called only for turn 1 — turn 2's stream was skipped");
  assert.equal(events.filter((e) => e.type === "steer").length, 0);
});

test("D27 coverage: a steer that becomes the first kept message keeps its identity for replay", async () => {
  const { tool } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: { path: "a" } }] },
    { type: "text", text: "done" },
  ];
  const summary: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "summary" }],
    model: "fake-model",
    provider: "fake",
    stopReason: "stop",
    timestamp: 0,
  };
  // A compaction that folds the context down to [summary, steer] makes the
  // steer the FIRST kept message — the case the identity fix exists for.
  const { events, queue } = await drainSteered(
    turns,
    [tool],
    1,
    ["early guidance"],
    {
      prepareNextTurn: (ctx, turn) => {
        if (turn === 2) {
          const steer = ctx.find(
            (m) => m.role === "user" && m.content === "early guidance",
          ) as UserMessage;
          return [summary, steer];
        }
        return undefined;
      },
    },
  );
  assert.equal(queue.length, 0);
  const steers = events.filter((e) => e.type === "steer") as Extract<AgentEvent, { type: "steer" }>[];
  assert.equal(steers.length, 1);
  const end = agentEnd(events);
  // Final context: [summary, steer, assistant(done)]. The steer is the first
  // KEPT message (right after the summary) — the case the identity fix exists
  // for.
  assert.equal(end.messages.length, 3, "summary + steer + final assistant");
  assert.equal(end.messages[0]!.role, "assistant");
  assert.equal(end.messages[1]!.role, "user");
  if (end.messages[1]!.role === "user") assert.equal(end.messages[1]!.content, "early guidance");
  // Message identity: the steer event carries the SAME object the compaction
  // kept — the CLI keys its entry-id map by this identity, so a resumed
  // session resolves the steer to the entry persisted on delivery.
  assert.equal(
    steers[0]!.message,
    end.messages[1],
    "the steer event's message is the same reference the compaction kept",
  );
});

test("D27 audit: an abort during the hook leaves hook-time guidance undrained", async () => {
  const { tool } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: { path: "a" } }] },
    { type: "text", text: "done" },
  ];
  const q: string[] = [];
  const queue = {
    push: (t: string) => q.push(t),
    drain: () => {
      const out = [...q];
      q.length = 0;
      return out;
    },
  };
  const controller = new AbortController();
  const base = fakeStream(turns, { model: MODEL });
  let call = 0;
  const streamFn: StreamFn = (m, ctx, o) => {
    call += 1;
    return base(m, ctx, o);
  };
  const events = await drain(
    runLoop({
      model: MODEL,
      systemPrompt: "sys",
      initialMessages: [userMsg("hi")],
      tools: [tool],
      streamFn,
      signal: controller.signal,
      prepareNextTurn: async (_ctx, turn) => {
        if (turn === 2) {
          // Simulate the async hook (auto-compaction) in flight: guidance
          // arrives, THEN the user aborts — before the post-hook drain.
          await new Promise((r) => setTimeout(r, 10));
          q.push("guidance typed during the hook");
          controller.abort();
        }
        return undefined;
      },
    }),
  );
  const end = agentEnd(events);
  assert.equal(end.stopReason, "aborted", "the abort during the hook stops the run");
  assert.equal(call, 1, "the stream was called only for turn 1 — turn 2's stream was skipped");
  assert.equal(
    events.filter((e) => e.type === "steer").length,
    0,
    "no steer was delivered — the hook-time guidance was left undrained",
  );
  assert.equal(
    q.length,
    1,
    "the guidance is still in the queue — the driver discards it on abort",
  );
});

// ─────────────────────── D27b (steering/loop audit, second pass) ───────────────

test("D27b F1: an abort while the consumer handles turn_start leaves pre-hook guidance undrained", async () => {
  const { q, queue } = makeQueue();
  const turns: FakeTurn[] = [{ type: "text", text: "done" }];
  q.push("guidance"); // queued before turn 1 (hits the pre-hook drain)
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const gen = runLoop({
    model: MODEL,
    systemPrompt: "sys",
    initialMessages: [userMsg("hi")],
    tools: [],
    streamFn: fakeStream(turns, { model: MODEL }),
    signal: controller.signal,
    steeringQueue: queue,
  });
  for await (const e of gen) {
    events.push(e);
    if (e.type === "turn_start") controller.abort(); // abort while the consumer handles turn_start
  }
  const end = agentEnd(events);
  assert.equal(end.stopReason, "aborted");
  assert.equal(events.filter((ev) => ev.type === "steer").length, 0, "no steer was delivered");
  assert.equal(q.length, 1, "the pre-hook guidance was left undrained");
});

test("D27b F1: an abort while the consumer handles turn_end leaves keep-alive guidance undrained", async () => {
  const { q, queue } = makeQueue();
  const turns: FakeTurn[] = [{ type: "text", text: "done" }];
  const base = fakeStream(turns, { model: MODEL });
  let call = 0;
  const streamFn: StreamFn = (m, c, o) => {
    call += 1;
    if (call === 1) q.push("guidance"); // typed while turn 1's stream is in flight
    return base(m, c, o);
  };
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const gen = runLoop({
    model: MODEL,
    systemPrompt: "sys",
    initialMessages: [userMsg("hi")],
    tools: [],
    streamFn,
    signal: controller.signal,
    steeringQueue: queue,
  });
  for await (const e of gen) {
    events.push(e);
    if (e.type === "turn_end") controller.abort(); // abort while the consumer handles turn_end
  }
  const end = agentEnd(events);
  assert.equal(end.stopReason, "aborted", "the abort is reported, not a normal stop");
  assert.equal(events.filter((ev) => ev.type === "steer").length, 0, "no steer was delivered");
  assert.equal(q.length, 1, "the keep-alive guidance was left undrained");
});

// ─────────────────── D27b F1 (tool calls on abort) ───────────────────

test("D27b F1: an abort while the consumer handles turn_end fails pending tool calls in-band (no dangling calls)", async () => {
  const { tool, calls } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: { path: "a.txt" } }] },
  ];
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const gen = runLoop({
    model: MODEL,
    systemPrompt: "sys",
    initialMessages: [userMsg("hi")],
    tools: [tool],
    streamFn: fakeStream(turns, { model: MODEL }),
    signal: controller.signal,
  });
  for await (const e of gen) {
    events.push(e);
    if (e.type === "turn_end") controller.abort(); // abort while the consumer handles turn_end
  }
  const end = agentEnd(events);
  assert.equal(end.stopReason, "aborted", "the abort is reported");
  assert.equal(calls.length, 0, "the tool call was NOT executed");

  // The completed assistant message carried one tool call; it must not be
  // left dangling — it gets an in-band error result so the history is valid.
  const results = toolResultMessages(end.messages);
  assert.equal(results.length, 1, "the pending tool call got a result");
  assert.equal(results[0]!.toolCallId, "c1");
  assert.equal(results[0]!.isError, true, "the aborted call is marked isError");
  assert.match(results[0]!.content[0]!.text, /aborted/i);

  // The matching events were emitted so a consumer can render them.
  assert.equal(toolEndEvents(events).length, 1, "a tool_execution_end was emitted");

  // Context shape: user, assistant(toolCall), toolResult(failed).
  assert.equal(end.messages.length, 3);
  assert.equal(end.messages[1]!.role, "assistant");
  assert.equal(end.messages[2]!.role, "toolResult");
});

test("D27b F1: a stream-side abort that already emitted tool calls fails them in-band (no dangling calls)", async () => {
  const { tool, calls } = makeTool("read");
  // A StreamFn that emits a tool call, then ends with stopReason "aborted"
  // (the wire layer does this when the signal aborts mid-turn after calls
  // have already been streamed).
  const asst = (stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
    role: "assistant",
    content: [
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } },
    ],
    model: MODEL.id,
    provider: MODEL.provider,
    stopReason,
    timestamp: 0,
  });
  const streamFn: StreamFn = async function* () {
    const startEv: AssistantStreamEvent = { type: "start", partial: asst("stop") };
    yield startEv;
    const doneEv: AssistantStreamEvent = { type: "done", message: asst("aborted") };
    yield doneEv;
  };
  const events: AgentEvent[] = [];
  const gen = runLoop({
    model: MODEL,
    systemPrompt: "sys",
    initialMessages: [userMsg("hi")],
    tools: [tool],
    streamFn,
    signal: new AbortController().signal,
  });
  for await (const e of gen) events.push(e);
  const end = agentEnd(events);
  assert.equal(end.stopReason, "aborted", "the stream-side abort is reported");
  assert.equal(calls.length, 0, "the tool call was NOT executed");

  const results = toolResultMessages(end.messages);
  assert.equal(results.length, 1, "the pending tool call got a result");
  assert.equal(results[0]!.toolCallId, "c1");
  assert.equal(results[0]!.isError, true, "the aborted call is marked isError");
  assert.match(results[0]!.content[0]!.text, /aborted/i);

  // Context shape: user, assistant(toolCall), toolResult(failed).
  assert.equal(end.messages.length, 3);
  assert.equal(end.messages[1]!.role, "assistant");
  assert.equal(end.messages[2]!.role, "toolResult");
});

test("D27b F1: a text-only abort leaves no tool results (regression guard for the in-band path)", async () => {
  const turns: FakeTurn[] = [{ type: "text", text: "done" }];
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const gen = runLoop({
    model: MODEL,
    systemPrompt: "sys",
    initialMessages: [userMsg("hi")],
    tools: [],
    streamFn: fakeStream(turns, { model: MODEL }),
    signal: controller.signal,
  });
  for await (const e of gen) {
    events.push(e);
    if (e.type === "turn_end") controller.abort();
  }
  const end = agentEnd(events);
  assert.equal(end.stopReason, "aborted");
  assert.equal(toolResultMessages(end.messages).length, 0, "no tool calls → no results");
  assert.equal(toolEndEvents(events).length, 0, "no tool events emitted");
  // Context shape: user, assistant(text). No dangling call, no synthetic result.
  assert.equal(end.messages.length, 2);
});

// ─────────────── D27b F1 (tool calls on the "error" path) ───────────────
// The wire layer ends a stream with stopReason "error" when an error payload
// or a network failure lands mid-turn — AFTER tool calls have already been
// streamed. Those calls must not run, yet they must not be left dangling in
// context either (I3: every call gets a result). The loop fails them in-band.

test("D27b F1 (error path): an error turn that emitted tool calls fails them in-band (no dangling calls)", async () => {
  const { tool, calls } = makeTool("read");
  // A StreamFn that emits a tool call, then ends with stopReason "error"
  // (the wire layer does this when an error payload / network failure lands
  // after the calls have already been streamed).
  const asst = (stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
    role: "assistant",
    content: [
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } },
    ],
    model: MODEL.id,
    provider: MODEL.provider,
    stopReason,
    timestamp: 0,
  });
  const streamFn: StreamFn = async function* () {
    yield { type: "start", partial: asst("stop") };
    yield { type: "done", message: asst("error") };
  };
  const events: AgentEvent[] = [];
  const gen = runLoop({
    model: MODEL,
    systemPrompt: "sys",
    initialMessages: [userMsg("hi")],
    tools: [tool],
    streamFn,
    signal: new AbortController().signal,
  });
  for await (const e of gen) events.push(e);
  const end = agentEnd(events);
  assert.equal(end.stopReason, "error", "the error is reported");
  assert.equal(calls.length, 0, "the tool call was NOT executed");

  // The errored assistant message carried one tool call; it must not be left
  // dangling — it gets an in-band error result so the history is valid (I3).
  const results = toolResultMessages(end.messages);
  assert.equal(results.length, 1, "the pending tool call got a result");
  assert.equal(results[0]!.toolCallId, "c1");
  assert.equal(results[0]!.isError, true, "the errored call is marked isError");
  assert.match(results[0]!.content[0]!.text, /error/i);

  // The matching events were emitted so a consumer can render them.
  assert.equal(toolEndEvents(events).length, 1, "a tool_execution_end was emitted");

  // Context shape: user, assistant(toolCall), toolResult(failed). Every
  // toolCall block has a matching toolResult (I3).
  assert.equal(end.messages.length, 3);
  assert.equal(end.messages[1]!.role, "assistant");
  assert.equal(end.messages[2]!.role, "toolResult");
});

test("D27b F1 (error path): a multi-call error turn fails EVERY pending call in-band", async () => {
  const { tool, calls } = makeTool("read");
  const asst = (stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
    role: "assistant",
    content: [
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } },
      { type: "toolCall", id: "c2", name: "read", arguments: { path: "b.txt" } },
    ],
    model: MODEL.id,
    provider: MODEL.provider,
    stopReason,
    timestamp: 0,
  });
  const streamFn: StreamFn = async function* () {
    yield { type: "start", partial: asst("stop") };
    yield { type: "done", message: asst("error") };
  };
  const events: AgentEvent[] = [];
  const gen = runLoop({
    model: MODEL,
    systemPrompt: "sys",
    initialMessages: [userMsg("hi")],
    tools: [tool],
    streamFn,
    signal: new AbortController().signal,
  });
  for await (const e of gen) events.push(e);
  const end = agentEnd(events);
  assert.equal(end.stopReason, "error");
  assert.equal(calls.length, 0, "neither call was executed");

  // Both calls got results, in call order.
  const results = toolResultMessages(end.messages);
  assert.equal(results.length, 2, "both pending calls got results");
  assert.deepEqual(
    results.map((r) => r.toolCallId),
    ["c1", "c2"],
    "results land in call order",
  );
  assert.ok(results.every((r) => r.isError === true), "both are isError");
  assert.equal(toolEndEvents(events).length, 2, "two tool_execution_end events");
});

test("D27b F1 (error path): a text-only error turn leaves no tool results (regression guard)", async () => {
  // The existing "error turn" test pins the no-call shape; this one pins that
  // the in-band failure does NOT fabricate results when there are no calls.
  const events = await drainLoop([{ type: "error", message: "boom" }], []);
  const end = agentEnd(events);
  assert.equal(end.stopReason, "error");
  assert.equal(toolResultMessages(end.messages).length, 0, "no tool calls → no results");
  assert.equal(toolEndEvents(events).length, 0, "no tool events emitted");
  assert.equal(end.messages.length, 2, "user + errored assistant — no synthetic result");
});

// ─────────────── D27b F1 (tool calls on the no-`done` contract violation) ─────
// A StreamFn that violates its own contract (WS8's fakeStream does this ON
// PURPOSE) can emit tool-call events and then end WITHOUT a `done` event. The
// loop's "keep what we have" fallback must not keep those calls DANGLING.

test("D27b F1 (no done): a StreamFn that emits calls but no `done` fails them in-band (no dangling calls)", async () => {
  const { tool, calls } = makeTool("read");
  // A StreamFn that emits a tool call and then simply ends — no `done` event
  // (a contract violation). The loop's `message === undefined` fallback must
  // still give the emitted call a result.
  const streamFn: StreamFn = async function* () {
    yield {
      type: "start",
      partial: {
        role: "assistant",
        content: [],
        model: MODEL.id,
        provider: MODEL.provider,
        stopReason: "stop",
        timestamp: 0,
      },
    };
    yield {
      type: "toolcall_start",
      index: 0,
      id: "c1",
      name: "read",
      partial: {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
        model: MODEL.id,
        provider: MODEL.provider,
        stopReason: "stop",
        timestamp: 0,
      },
    };
    // No `done` — the stream ends here (contract violation).
  };
  const events: AgentEvent[] = [];
  const gen = runLoop({
    model: MODEL,
    systemPrompt: "sys",
    initialMessages: [userMsg("hi")],
    tools: [tool],
    streamFn,
    signal: new AbortController().signal,
  });
  for await (const e of gen) events.push(e);
  const end = agentEnd(events);
  assert.equal(end.stopReason, "aborted", "no `done` → the fallback stop reason");
  assert.equal(calls.length, 0, "the tool call was NOT executed");

  // The emitted tool call must not be left dangling — it gets an in-band
  // error result so the history is valid (I3).
  const results = toolResultMessages(end.messages);
  assert.equal(results.length, 1, "the pending tool call got a result");
  assert.equal(results[0]!.toolCallId, "c1");
  assert.equal(results[0]!.isError, true, "the orphaned call is marked isError");
  assert.match(results[0]!.content[0]!.text, /error/i);
  assert.equal(toolEndEvents(events).length, 1, "a tool_execution_end was emitted");
});

test("D27b F1 (no done + abort): a consumer abort on turn_end still fails the partial's calls in-band (I3)", async () => {
  const { tool, calls } = makeTool("read");
  // The overlap the plain no-`done` test does not cover: the StreamFn
  // violates its contract (emits a tool call, then ends WITHOUT a `done`
  // event — `message` stays undefined) AND the consumer aborts on
  // `turn_end`. The `signal.aborted` branch fires first and must fail the
  // partial slot's calls in-band (abort text — this is an abort, not an
  // error) before breaking; otherwise the toolCall is left orphaned (I3).
  const streamFn: StreamFn = async function* () {
    yield {
      type: "start",
      partial: {
        role: "assistant",
        content: [],
        model: MODEL.id,
        provider: MODEL.provider,
        stopReason: "stop",
        timestamp: 0,
      },
    };
    yield {
      type: "toolcall_start",
      index: 0,
      id: "c1",
      name: "read",
      partial: {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
        model: MODEL.id,
        provider: MODEL.provider,
        stopReason: "stop",
        timestamp: 0,
      },
    };
    // No `done` — the stream ends here (contract violation).
  };
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const gen = runLoop({
    model: MODEL,
    systemPrompt: "sys",
    initialMessages: [userMsg("hi")],
    tools: [tool],
    streamFn,
    signal: controller.signal,
  });
  for await (const e of gen) {
    events.push(e);
    if (e.type === "turn_end") controller.abort();
  }
  const end = agentEnd(events);
  assert.equal(end.stopReason, "aborted", "the consumer abort wins");
  assert.equal(calls.length, 0, "the tool call was NOT executed");

  // I3: every toolCall in the resulting history has a matching toolResult.
  const results = toolResultMessages(end.messages);
  const resultIds = new Set(results.map((r) => r.toolCallId));
  for (const m of end.messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.type === "toolCall") {
        assert.ok(resultIds.has(b.id), `toolCall ${b.id} has a matching toolResult (I3)`);
      }
    }
  }
  assert.equal(results.length, 1, "the pending tool call got a result");
  assert.equal(results[0]!.toolCallId, "c1");
  assert.equal(results[0]!.isError, true, "the orphaned call is marked isError");
  assert.equal(results[0]!.content[0]!.text, ABORTED_CALL_TEXT, "failed as an abort, not an error");
  assert.equal(toolEndEvents(events).length, 1, "a tool_execution_end was emitted");
});

test("D27b F2: keep-alive at the budget boundary leaves the steer undrained (no turn left to send it)", async () => {
  const turns: FakeTurn[] = [{ type: "text", text: "done" }];
  const { events, queue } = await drainSteered(turns, [], 1, ["guidance"], {
    maxTurns: 1,
    maxContinuations: 0,
  });
  const end = agentEnd(events);
  // The model completed its turn normally (text-only) — "stop", not "budget":
  // the budget cap only means no FURTHER turn is possible, which we don't need
  // because the model already stopped. (Before the D27b fix the keep-alive
  // `continue` re-entered the budget check and the run reported "budget".)
  assert.equal(end.stopReason, "stop", "the text-only turn completed normally");
  assert.equal(events.filter((e) => e.type === "steer").length, 0, "the steer was not delivered");
  assert.equal(queue.length, 1, "the steer is still in the queue — no turn was left to send it");
});

// ─────────────────────── D33: guard-stop evidence (docs/08 §10) ───────────────────────

test("D33: a loop stop carries the identical-batch evidence (signature, repeats, retries spent)", async () => {
  // Six identical turns: the guard fires at 3 (→ 1 auto-retry), re-fires at
  // 6 with the retry spent → stop "loop" WITH the evidence naming the batch.
  const { tool } = makeTool("read");
  const same = { id: "c1", name: "read", args: { path: "x" } };
  const turns: FakeTurn[] = Array.from({ length: 6 }, () => ({
    type: "toolcall",
    calls: [same],
  }));
  const events = await drainLoop(turns, [tool], { maxTurns: 50 });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "loop");
  assert.deepEqual(end.evidence, {
    guard: "identical-batch",
    signature: batchSignature([
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } },
    ]),
    repeats: 3,
    stable: true,
    guardRetries: 1,
  });
});

test("D33: the legacy hard stop (maxGuardRetries 0) reports guardRetries 0", async () => {
  const { tool } = makeTool("read");
  const same = { id: "c1", name: "read", args: { path: "x" } };
  const turns: FakeTurn[] = Array.from({ length: 4 }, () => ({
    type: "toolcall",
    calls: [same],
  }));
  const events = await drainLoop(turns, [tool], { maxTurns: 50, maxGuardRetries: 0 });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "loop");
  assert.equal(end.evidence?.guard, "identical-batch");
  assert.equal(
    end.evidence?.guard === "identical-batch" ? end.evidence.guardRetries : -1,
    0,
  );
});

test("D33: a stall stop copies the pipeline's stallEvidence off details", async () => {
  const { tool } = makeTool("bash");
  const executor: ExecuteToolCall = async (t, c, sig, onUpdate) => {
    if (c.arguments.command === "third") {
      return {
        content: [{ type: "text", text: "STALL_TEXT" }],
        isError: true,
        details: {
          stall: true,
          stallEvidence: {
            guard: "permission-stall",
            tool: "bash",
            denials: 3,
            window: 8,
            errorExcerpt: "Operation not permitted",
          },
        },
      };
    }
    return tool.execute(c.id, c.arguments, sig, onUpdate);
  };
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "bash", args: { command: "first" } }] },
    { type: "toolcall", calls: [{ id: "c2", name: "bash", args: { command: "first" } }] },
    { type: "toolcall", calls: [{ id: "c3", name: "bash", args: { command: "third" } }] },
  ];
  const events = await drainLoop(turns, [tool], { maxTurns: 50, executeToolCall: executor });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stall");
  assert.deepEqual(end.evidence, {
    guard: "permission-stall",
    tool: "bash",
    denials: 3,
    window: 8,
    errorExcerpt: "Operation not permitted",
  });
});

test("D33: a stall WITHOUT stallEvidence (legacy/custom executor) → no evidence, stop unchanged", async () => {
  const { tool } = makeTool("bash");
  const executor: ExecuteToolCall = async (t, c, sig, onUpdate) => {
    const r = await tool.execute(c.id, c.arguments, sig, onUpdate);
    return { ...r, details: { stall: true } };
  };
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "bash", args: { command: "x" } }] },
  ];
  const events = await drainLoop(turns, [tool], { maxTurns: 50, executeToolCall: executor });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stall", "details.stall still stops the run");
  assert.equal(end.evidence, undefined, "no evidence to name — the display falls back");
});

test("D33: a clean stop carries no evidence", async () => {
  const turns: FakeTurn[] = [{ type: "text", text: "done" }];
  const events = await drainLoop(turns, []);
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stop");
  assert.equal(end.evidence, undefined);
});

// ───────────────────────────────────────────────────────────────────────────
// F1 (docs/08 §9, D32) — no-progress detection: variant B (zero-success
// turns) + variant A3 (same-target edits with no executed bash between).
// ───────────────────────────────────────────────────────────────────────────

/** Run with per-call context capture: `seen[i]` is the i-th LLM request. */
async function drainSeen(
  turns: FakeTurn[],
  tools: Tool[],
  extra: Partial<AgentLoopOptions> = {},
): Promise<{ events: AgentEvent[]; seen: LlmContext[] }> {
  const seen: LlmContext[] = [];
  const base = fakeStream(turns, { model: MODEL });
  const streamFn: StreamFn = (m, ctx, o) => {
    seen.push({ ...ctx, messages: JSON.parse(JSON.stringify(ctx.messages)) });
    return base(m, ctx, o);
  };
  const events = await drain(
    runLoop({
      model: MODEL,
      systemPrompt: "sys",
      initialMessages: [userMsg("hi")],
      tools,
      streamFn,
      signal: new AbortController().signal,
      ...extra,
    }),
  );
  return { events, seen };
}

/** A tool whose result is always an error (variant B's failing call). */
function failingTool(name: string): Tool {
  return {
    name,
    description: `failing ${name}`,
    parameters: { type: "object" },
    execute: async () => ({
      content: [{ type: "text" as const, text: `${name} failed` }],
      isError: true,
    }),
  };
}

const progressEvents = (events: AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { type: "progress_nudge" }> => e.type === "progress_nudge");

test("F1 B: 3 all-failed turns → one progress_nudge (kind no-success, mode watch) and the run CONTINUES", async () => {
  const tool = failingTool("bash");
  // Varying args per turn so the C26 identical-batch guard never fires —
  // this isolates the no-success detector.
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "bash", args: { command: "a" } }] },
    { type: "toolcall", calls: [{ id: "c2", name: "bash", args: { command: "b" } }] },
    { type: "toolcall", calls: [{ id: "c3", name: "bash", args: { command: "c" } }] },
    { type: "text", text: "giving up" },
  ];
  const { events, seen } = await drainSeen(turns, [tool], { maxTurns: 50 });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stop", "watch mode: the run continues to its normal end");
  const p = progressEvents(events);
  assert.equal(p.length, 1, "the condition fires exactly once (episode, not per-turn spam)");
  assert.equal(p[0]!.kind, "no-success");
  assert.equal(p[0]!.mode, "watch", "the landing default is pure observation");
  assert.equal(p[0]!.count, 3, "the count is the streak that crossed the threshold");
  assert.equal(p[0]!.target, undefined, "no target for no-success");
  assert.equal(p[0]!.turn, 3);
  // Watch: NOTHING was injected — no nudge text in any later request.
  assert.equal(seen.length, 4, "the 4th turn was requested (the run continued)");
  for (const ctx of seen) {
    assert.equal(
      ctx.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("No progress detected")),
      false,
      "watch mode injects nothing",
    );
  }
});

test("F1 B: a success on turn 2 of 3 → no fire", async () => {
  const ok = makeTool("read");
  const bad = failingTool("bash");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "bash", args: { command: "a" } }] },
    { type: "toolcall", calls: [{ id: "c2", name: "read", args: { path: "x" } }] }, // success resets
    { type: "toolcall", calls: [{ id: "c3", name: "bash", args: { command: "c" } }] },
    { type: "toolcall", calls: [{ id: "c4", name: "bash", args: { command: "d" } }] },
    { type: "text", text: "done" },
  ];
  const events = await drainLoop(turns, [ok.tool, bad], { maxTurns: 50 });
  assert.equal(progressEvents(events).length, 0, "the success reset the streak");
  assert.equal(agentEnd(events).stopReason, "stop");
});

test("F1 B: a steer between failing turns resets the streak → no fire", async () => {
  const bad = failingTool("bash");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "bash", args: { command: "a" } }] },
    { type: "toolcall", calls: [{ id: "c2", name: "bash", args: { command: "b" } }] },
    { type: "toolcall", calls: [{ id: "c3", name: "bash", args: { command: "c" } }] },
    { type: "text", text: "thanks, done" },
  ];
  const { events } = await drainSteered(turns, [bad], 2, ["try a different approach"], { maxTurns: 50 });
  assert.equal(progressEvents(events).length, 0, "the steer reset the no-success streak (D27 F2 rule)");
  assert.equal(agentEnd(events).stopReason, "stop");
});

test("F1 B: a mixed batch (one ok, one failed) → no fire", async () => {
  const ok = makeTool("read");
  const bad = failingTool("bash");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "bash", args: { command: "a" } }, { id: "c2", name: "read", args: { path: "x" } }] },
    { type: "toolcall", calls: [{ id: "c3", name: "bash", args: { command: "c" } }] },
    { type: "toolcall", calls: [{ id: "c4", name: "bash", args: { command: "d" } }] },
    { type: "text", text: "done" },
  ];
  const events = await drainLoop(turns, [ok.tool, bad], { maxTurns: 50 });
  assert.equal(progressEvents(events).length, 0, "a non-empty batch with ANY success is not a no-success turn");
});

test("F1 B: mode nudge → the nudge rides the next request's context, and no event carries it (not persisted)", async () => {
  const bad = failingTool("bash");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "bash", args: { command: "a" } }] },
    { type: "toolcall", calls: [{ id: "c2", name: "bash", args: { command: "b" } }] },
    { type: "toolcall", calls: [{ id: "c3", name: "bash", args: { command: "c" } }] },
    { type: "text", text: "ok, stopping" },
  ];
  const { events, seen } = await drainSeen(turns, [bad], { maxTurns: 50, progressMode: "nudge" });
  const p = progressEvents(events);
  assert.equal(p.length, 1);
  assert.equal(p[0]!.mode, "nudge");
  // The nudge is in the 4th request's context (the model saw it)…
  const fourth = seen[3]!;
  assert.ok(
    fourth.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content === NO_SUCCESS_NUDGE_TEXT),
    "the no-success nudge is in the next request's context",
  );
  // …but NO event carries it (the session persists only event-borne
  // messages — done/tool_execution_end/steer), so nothing lands in the file.
  for (const e of events) {
    if (e.type === "done") assert.ok(!JSON.stringify(e.message).includes("No progress detected"));
    if (e.type === "steer") assert.notEqual(e.text, NO_SUCCESS_NUDGE_TEXT);
  }
  assert.equal(agentEnd(events).stopReason, "stop", "nudge mode never stops");
});

test("F1 B: mode stop → recurrence after the nudge stops with stopReason progress + progress on agent_end", async () => {
  const bad = failingTool("bash");
  // 3 failed turns → nudge (ladder 1/1); the condition persists → turn 6
  // recurs with the ladder spent → stop.
  const turns: FakeTurn[] = Array.from({ length: 7 }, (_, i) => ({
    type: "toolcall" as const,
    calls: [{ id: `c${i}`, name: "bash", args: { command: `cmd-${i}` } }],
  }));
  const { events, seen } = await drainSeen(turns, [bad], { maxTurns: 50, progressMode: "stop" });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "progress", "recurrence with no ground truth stops the run");
  assert.deepEqual(end.progress, { kind: "no-success", count: 4 }, "the turn AFTER the nudge recurs → stop");
  assert.equal(end.evidence, undefined, "progress is not a loop/stall stop");
  const p = progressEvents(events);
  assert.equal(p.length, 1, "one announcement event for the episode");
  assert.equal(p[0]!.mode, "stop");
  // The nudge was injected on the first hit (the model got its chance).
  assert.ok(
    seen.some((ctx) =>
      ctx.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content === NO_SUCCESS_NUDGE_TEXT),
    ),
    "the nudge was injected before the stop",
  );
});

test("F1 B: maxProgressNudges 0 (mode stop) → hard stop on the first hit, no nudge", async () => {
  const bad = failingTool("bash");
  const turns: FakeTurn[] = Array.from({ length: 4 }, (_, i) => ({
    type: "toolcall" as const,
    calls: [{ id: `c${i}`, name: "bash", args: { command: `cmd-${i}` } }],
  }));
  const { events, seen } = await drainSeen(turns, [bad], {
    maxTurns: 50,
    progressMode: "stop",
    maxProgressNudges: 0,
  });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "progress", "0 = legacy hard stop at the first hit");
  assert.deepEqual(end.progress, { kind: "no-success", count: 3 });
  const p = progressEvents(events);
  assert.equal(p.length, 1, "the event still fires (the observation channel survives any mode)");
  assert.equal(p[0]!.mode, "stop");
  for (const ctx of seen) {
    assert.equal(
      ctx.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content === NO_SUCCESS_NUDGE_TEXT),
      false,
      "a run capped at 0 nudges never injects",
    );
  }
});

test("F1 A3: 4 edits of the same path with nothing in between → fire (mode watch)", async () => {
  const w = makeTool("write");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "write", args: { path: "src/x.ts", content: "1" } }] },
    { type: "toolcall", calls: [{ id: "c2", name: "write", args: { path: "src/x.ts", content: "2" } }] },
    { type: "toolcall", calls: [{ id: "c3", name: "write", args: { path: "src/x.ts", content: "3" } }] },
    { type: "toolcall", calls: [{ id: "c4", name: "write", args: { path: "src/x.ts", content: "4" } }] },
    { type: "text", text: "done" },
  ];
  const events = await drainLoop(turns, [w.tool], { maxTurns: 50 });
  const p = progressEvents(events);
  assert.equal(p.length, 1);
  assert.equal(p[0]!.kind, "no-verification");
  assert.equal(p[0]!.count, 4);
  assert.ok(p[0]!.target !== undefined && p[0]!.target.endsWith("src/x.ts"), "the normalized target is named");
  assert.equal(agentEnd(events).stopReason, "stop", "watch: the run continues");
});

test("F1 A3: 4 edits with a FAILED npm test between → no fire (the measurement happened)", async () => {
  const w = makeTool("write");
  const failingBash: Tool = {
    name: "bash",
    description: "failing bash",
    parameters: { type: "object" },
    execute: async () => ({ content: [{ type: "text" as const, text: "tests failed" }], isError: true }),
  };
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "write", args: { path: "src/x.ts", content: "1" } }] },
    { type: "toolcall", calls: [{ id: "c2", name: "write", args: { path: "src/x.ts", content: "2" } }] },
    { type: "toolcall", calls: [{ id: "c3", name: "write", args: { path: "src/x.ts", content: "3" } }] },
    { type: "toolcall", calls: [{ id: "c4", name: "bash", args: { command: "npm test" } }] }, // a FAILING test is a measurement
    { type: "toolcall", calls: [{ id: "c5", name: "write", args: { path: "src/x.ts", content: "4" } }] },
    { type: "text", text: "done" },
  ];
  const events = await drainLoop(turns, [w.tool, failingBash], { maxTurns: 50 });
  assert.equal(progressEvents(events).length, 0, "the executed bash reset the counter, whatever it returned");
});

test("F1 A3: a gate-BLOCKED bash (details.notExecuted) does NOT reset", async () => {
  const w = makeTool("write");
  const blockedBash: Tool = {
    name: "bash",
    description: "blocked bash",
    parameters: { type: "object" },
    execute: async () => ({
      content: [{ type: "text" as const, text: "blocked by safety gate" }],
      isError: true,
      details: { notExecuted: true },
    }),
  };
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "write", args: { path: "src/x.ts", content: "1" } }] },
    { type: "toolcall", calls: [{ id: "c2", name: "write", args: { path: "src/x.ts", content: "2" } }] },
    { type: "toolcall", calls: [{ id: "c3", name: "write", args: { path: "src/x.ts", content: "3" } }] },
    { type: "toolcall", calls: [{ id: "c4", name: "bash", args: { command: "rm -rf /" } }] }, // never ran
    { type: "toolcall", calls: [{ id: "c5", name: "write", args: { path: "src/x.ts", content: "4" } }] },
    { type: "text", text: "done" },
  ];
  const events = await drainLoop(turns, [w.tool, blockedBash], { maxTurns: 50 });
  const p = progressEvents(events);
  assert.equal(p.length, 1, "a blocked call is not ground contact — the 4th edit still fires");
  assert.equal(p[0]!.kind, "no-verification");
});

test("F1 A3: read never counts; write and edit to the same path share a counter; ./x and x normalize together", async () => {
  const w = makeTool("write");
  const e = makeTool("edit");
  const r = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: { path: "src/x.ts" } }] }, // read: neutral
    { type: "toolcall", calls: [{ id: "c2", name: "write", args: { path: "src/x.ts", content: "1" } }] },
    { type: "toolcall", calls: [{ id: "c3", name: "edit", args: { path: "./src/x.ts", oldText: "a", newText: "b" } }] },
    { type: "toolcall", calls: [{ id: "c4", name: "read", args: { path: "src/x.ts" } }] },
    { type: "toolcall", calls: [{ id: "c5", name: "edit", args: { path: "src/x.ts", oldText: "b", newText: "c" } }] },
    { type: "toolcall", calls: [{ id: "c6", name: "write", args: { path: "./src/x.ts", content: "4" } }] },
    { type: "text", text: "done" },
  ];
  const events = await drainLoop(turns, [w.tool, e.tool, r.tool], { maxTurns: 50 });
  const p = progressEvents(events);
  assert.equal(p.length, 1, "3 writes + 2 edits (reads free) cross the threshold once");
  assert.equal(p[0]!.kind, "no-verification");
  assert.equal(p[0]!.count, 4, "the shared counter reached 4 (./x and x are one target)");
});

test("F1 A3: separate paths keep separate counters", async () => {
  const w = makeTool("write");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "write", args: { path: "a.ts", content: "1" } }] },
    { type: "toolcall", calls: [{ id: "c2", name: "write", args: { path: "b.ts", content: "1" } }] },
    { type: "toolcall", calls: [{ id: "c3", name: "write", args: { path: "a.ts", content: "2" } }] },
    { type: "toolcall", calls: [{ id: "c4", name: "write", args: { path: "b.ts", content: "2" } }] },
    { type: "text", text: "done" },
  ];
  const events = await drainLoop(turns, [w.tool], { maxTurns: 50 });
  assert.equal(progressEvents(events).length, 0, "2+2 edits of two paths touch neither threshold");
});

test("F1: the guard paths never feed the counters (synthetic results excluded)", async () => {
  // 3 identical batches: the loop guard fires at turn 3 and the guarded
  // in-band results (isError, never executed) must NOT count as a no-success
  // turn — the run stops with "loop", and F1 stays silent.
  const { tool } = makeTool("read");
  const same = { id: "c1", name: "read", args: { path: "x" } };
  const turns: FakeTurn[] = Array.from({ length: 6 }, () => ({ type: "toolcall" as const, calls: [same] }));
  const events = await drainLoop(turns, [tool], { maxTurns: 50 });
  assert.equal(agentEnd(events).stopReason, "loop");
  assert.equal(progressEvents(events).length, 0, "the loop guard's synthetic results are not model activity");
});

test("F1 A3: an executed bash LATER in the same batch cancels the detection (audit fix)", async () => {
  // [write ×3] then a batch of [4th write, bash]: the bash measures the
  // edits, so the turn must NOT fire — pre-fix, the threshold crossed
  // earlier in the batch survived the reset and stopped the run in "stop"
  // mode despite the measurement.
  const w = makeTool("write");
  const okBash: Tool = {
    name: "bash",
    description: "ok bash",
    parameters: { type: "object" },
    execute: async () => ({ content: [{ type: "text" as const, text: "tests passed" }] }),
  };
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "write", args: { path: "src/x.ts", content: "1" } }] },
    { type: "toolcall", calls: [{ id: "c2", name: "write", args: { path: "src/x.ts", content: "2" } }] },
    { type: "toolcall", calls: [{ id: "c3", name: "write", args: { path: "src/x.ts", content: "3" } }] },
    { type: "toolcall", calls: [
      { id: "c4", name: "write", args: { path: "src/x.ts", content: "4" } },
      { id: "c5", name: "bash", args: { command: "npm test" } },
    ] },
    { type: "text", text: "done" },
  ];
  const events = await drainLoop(turns, [w.tool, okBash], { maxTurns: 50, progressMode: "stop", maxProgressNudges: 0 });
  assert.equal(progressEvents(events).length, 0, "the same-batch bash cancelled the threshold");
  assert.equal(agentEnd(events).stopReason, "stop", "no progress stop despite the 4th edit");
});

test("F1 A3: edits AFTER the same-bash bash still count toward the next threshold", async () => {
  const w = makeTool("write");
  const okBash: Tool = {
    name: "bash",
    description: "ok bash",
    parameters: { type: "object" },
    execute: async () => ({ content: [{ type: "text" as const, text: "ran" }] }),
  };
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "write", args: { path: "src/x.ts", content: "1" } }] },
    { type: "toolcall", calls: [{ id: "c2", name: "write", args: { path: "src/x.ts", content: "2" } }] },
    { type: "toolcall", calls: [
      { id: "c3", name: "bash", args: { command: "ls" } },
      { id: "c4", name: "write", args: { path: "src/x.ts", content: "3" } },
      { id: "c5", name: "write", args: { path: "src/x.ts", content: "4" } },
    ] },
    { type: "toolcall", calls: [{ id: "c6", name: "write", args: { path: "src/x.ts", content: "5" } }] },
    { type: "toolcall", calls: [{ id: "c7", name: "write", args: { path: "src/x.ts", content: "6" } }] },
    { type: "text", text: "done" },
  ];
  const events = await drainLoop(turns, [w.tool, okBash], { maxTurns: 50 });
  const p = progressEvents(events);
  assert.equal(p.length, 1, "the two post-bash edits need four MORE to fire");
  assert.equal(p[0]!.count, 4);
});

test("F1 A3: a VALIDATION-rejected bash (never executed) does NOT reset (audit fix)", async () => {
  // Through the REAL pipeline: a malformed bash call (missing its required
  // arg) never reaches the tool — `details.notExecuted` must mark it, or a
  // malformed command would masquerade as a measurement.
  const w = makeTool("write");
  const realBash: Tool = {
    name: "bash",
    description: "bash",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    execute: async () => ({ content: [{ type: "text" as const, text: "ran" }] }),
  };
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "write", args: { path: "src/x.ts", content: "1" } }] },
    { type: "toolcall", calls: [{ id: "c2", name: "write", args: { path: "src/x.ts", content: "2" } }] },
    { type: "toolcall", calls: [{ id: "c3", name: "write", args: { path: "src/x.ts", content: "3" } }] },
    { type: "toolcall", calls: [{ id: "c4", name: "bash", args: { nope: 1 } }] }, // rejected: never ran
    { type: "toolcall", calls: [{ id: "c5", name: "write", args: { path: "src/x.ts", content: "4" } }] },
    { type: "text", text: "done" },
  ];
  const events = await drainLoop(turns, [w.tool, realBash], { maxTurns: 50, executeToolCall: makeToolExecutor() });
  const p = progressEvents(events);
  assert.equal(p.length, 1, "a rejected call is not ground contact — the 4th edit still fires");
  assert.equal(p[0]!.kind, "no-verification");
});

test("F1: synthetic loop-guard fills carry notExecuted (audit fix)", async () => {
  // The loop guard's in-band results must be marked never-executed: a
  // guarded `bash` fill would otherwise look like ground contact to the
  // TUI's recovery tracking (and to A3's reset).
  const tool: Tool = {
    name: "bash",
    description: "bash",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    execute: async () => ({ content: [{ type: "text" as const, text: "denied" }], isError: true }),
  };
  const same = { id: "c1", name: "bash", args: { command: "same" } };
  const turns: FakeTurn[] = Array.from({ length: 6 }, () => ({ type: "toolcall" as const, calls: [same] }));
  const events = await drainLoop(turns, [tool], { maxTurns: 50 });
  assert.equal(agentEnd(events).stopReason, "loop");
  const ends = events.filter((e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end");
  const guardFills = ends.filter((e) => e.result.content.some((c) => c.text.includes("Runaway loop detected")));
  assert.ok(guardFills.length > 0, "the guard filled at least one result");
  for (const e of guardFills)
    assert.equal(e.result.details?.notExecuted, true, "the fill says the call never ran");
});

test("F1 A3: effective workspace paths unify relative and absolute aliases", async () => {
  const root = resolve("src"); // differs from process.cwd(); fake tool never writes
  const w = makeTool("write", { executionMode: "sequential" });
  const turns: FakeTurn[] = Array.from({ length: 4 }, (_, i) => ({
    type: "toolcall",
    calls: [{ name: "write", args: { path: i % 2 ? resolve(root, "audit-target.ts") : "audit-target.ts", content: String(i) } }],
  }));
  const events = await drainLoop([...turns, { type: "text", text: "done" }], [w.tool], {
    executeToolCall: makeToolExecutor({ beforeToolCall: makeSafetyHooks({ root, mode: "yes" }) }),
  });
  assert.equal(new Set(w.calls.map((c) => c.args.path)).size, 1);
  const p = progressEvents(events);
  assert.equal(p.length, 1);
  assert.equal(p[0]!.target, resolve(root, "audit-target.ts"));
  assert.equal(p[0]!.count, 4);
});

test("F1 A3: simultaneous B detection defers A3 to a read-only turn", async () => {
  const edit = makeTool("edit", {
    executionMode: "sequential",
    execute: async () => ({ content: [], isError: true }),
  });
  const bad = failingTool("bad");
  const read = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ name: "bad", args: { n: 1 } }] },
    { type: "toolcall", calls: [{ name: "bad", args: { n: 2 } }] },
    { type: "toolcall", calls: Array.from({ length: 4 }, (_, n) => ({ name: "edit", args: { path: "x", n } })) },
    { type: "toolcall", calls: [{ name: "read", args: { path: "x" } }] },
    { type: "text", text: "done" },
  ];
  const events = await drainLoop(turns, [edit.tool, bad, read.tool]);
  assert.deepEqual(progressEvents(events).map((e) => [e.kind, e.turn]), [["no-success", 3], ["no-verification", 4]]);
  // A measurement on the deferred turn cancels A3 instead of announcing it.
  const bash = makeTool("bash");
  const measured = await drainLoop([
    ...turns.slice(0, 3),
    { type: "toolcall", calls: [{ name: "bash", args: { command: "check" } }] },
    { type: "text", text: "done" },
  ], [edit.tool, bad, bash.tool]);
  assert.deepEqual(progressEvents(measured).map((e) => e.kind), ["no-success"]);
});

test("F1: real length and not-found fills cannot recover A3 in the TUI", async () => {
  for (const kind of ["length", "not-found"] as const) {
    const w = makeTool("write", { executionMode: "sequential" });
    const bash = makeTool("bash");
    const edits: FakeTurn[] = Array.from({ length: 4 }, (_, n) => ({
      type: "toolcall", calls: [{ name: "write", args: { path: "x", content: String(n) } }],
    }));
    const tail: FakeTurn = kind === "length"
      ? { type: "length", calls: [{ name: "bash", args: { command: "never run" } }] }
      : { type: "toolcall", calls: [{ name: "bash", args: { command: "not installed" } }] };
    const events = await drainLoop([...edits, tail, { type: "text", text: "done" }], kind === "length" ? [w.tool, bash.tool] : [w.tool]);
    const end = events.find((e) => e.type === "tool_execution_end" && e.result.toolName === "bash");
    assert.ok(end?.type === "tool_execution_end");
    assert.equal(end.result.details?.notExecuted, true, kind);
    assert.equal(bash.calls.length, 0);
    let state = makeInitialState("fake");
    for (const ev of events) state = applyEvent(state, ev);
    assert.deepEqual(state.progressStats["no-verification"], { fired: 1, recovered: 0 }, kind);
  }
});

test("F1: a bash SPAWN failure does not reset A3, and does not recover it in the TUI (audit fix)", async () => {
  // The real bash tool pointed at a nonexistent cwd: no shell ever starts.
  // Such a failure must not count as a measurement (loop side) nor as
  // ground truth closing a fired episode (TUI side).
  const deadCwd = resolve("this-dir-does-not-exist-f1-audit");
  const bashTool = createBashTool(deadCwd, { sandbox: false });
  const w = makeTool("write", { executionMode: "sequential" });
  const edits: FakeTurn[] = Array.from({ length: 4 }, (_, n) => ({
    type: "toolcall", calls: [{ name: "write", args: { path: "x", content: String(n) } }],
  }));
  const fourthEdit: FakeTurn = { type: "toolcall", calls: [{ name: "write", args: { path: "x", content: "4" } }] };
  const spawnFail: FakeTurn = { type: "toolcall", calls: [{ name: "bash", args: { command: "echo hi" } }] };

  // Loop side: [w, w, w, spawnFail, w] — the spawn failure neither counts
  // nor resets, so the 4th edit fires.
  const es = await drainLoop([...edits.slice(0, 3), spawnFail, fourthEdit, { type: "text", text: "done" }], [w.tool, bashTool]);
  const p = progressEvents(es);
  assert.equal(p.length, 1, "a spawn failure is not ground contact — the 4th edit still fires");
  assert.equal(p[0]!.kind, "no-verification");

  // TUI side: A3 fires, then a spawn failure arrives — no recovery.
  const fired = await drainLoop([...edits, spawnFail, { type: "text", text: "done" }], [w.tool, bashTool]);
  let state = makeInitialState("fake");
  for (const ev of fired) state = applyEvent(state, ev);
  assert.deepEqual(state.progressStats["no-verification"], { fired: 1, recovered: 0 }, "a shell that never started is not ground truth");
});

test("F1: the H2 stall replacement PRESERVES notExecuted (real executor, audit fix)", async () => {
  // The third identical failure gets its result REPLACED by the H2 notice.
  // The replacement must not erase the execution fact: an unmarked stall
  // notice reads to the TUI as an executed bash and falsely recovers A3.
  const bashTool = createBashTool(resolve("this-dir-does-not-exist-f1-h2"), { sandbox: false });
  const w = makeTool("write", { executionMode: "sequential" });
  const edits: FakeTurn[] = Array.from({ length: 4 }, (_, n) => ({
    type: "toolcall", calls: [{ name: "write", args: { path: "x", content: String(n) } }],
  }));
  // Same command each time (the H2 signature), separated by a successful
  // read so the identical-BATCH guard never fires.
  const shell: FakeTurn = { type: "toolcall", calls: [{ name: "bash", args: { command: "echo hi" } }] };
  const readOnce: FakeTurn = { type: "toolcall", calls: [{ name: "read", args: { path: "x" } }] };
  const events = await drainLoop(
    [...edits, shell, readOnce, shell, readOnce, shell, { type: "text", text: "done" }],
    [w.tool, bashTool, makeTool("read").tool],
    { executeToolCall: makeToolExecutor() },
  );
  const bashEnds = events.filter(
    (e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
      e.type === "tool_execution_end" && e.result.toolName === "bash",
  );
  assert.equal(bashEnds.length, 3);
  for (const e of bashEnds)
    assert.equal(e.result.details?.notExecuted, true, "every spawn failure keeps its marker, incl. the H2 replacement");
  assert.match(
    bashEnds[2]!.result.content.map((c) => c.text).join(" "),
    /was NOT executed/,
    "the H2 notice says the truth about a never-executed call",
  );
  let state = makeInitialState("fake");
  for (const ev of events) state = applyEvent(state, ev);
  assert.deepEqual(state.progressStats["no-verification"], { fired: 1, recovered: 0 }, "the stall notice is not ground contact");
});

test("F1: an afterToolCall rewrite that drops details cannot fake an A3 recovery (audit fix)", async () => {
  // The audit probe: a real bash spawn failure (missing cwd) runs through
  // a redaction-shaped afterToolCall hook (new content, keep isError, drop
  // details). Without the execution-fact restoration the unmarked result
  // reads as an executed bash: it resets A3 in the loop AND falsely
  // recovers a fired episode in the TUI.
  const bashTool = createBashTool(resolve("this-dir-does-not-exist-f1-redact"), { sandbox: false });
  const w = makeTool("write", { executionMode: "sequential" });
  const redactor = { afterToolCall: (_t: unknown, _c: unknown, r: { isError?: boolean }) => ({ content: [{ type: "text" as const, text: "REDACTED" }], isError: r.isError }) };
  const edits: FakeTurn[] = Array.from({ length: 4 }, (_, n) => ({
    type: "toolcall", calls: [{ name: "write", args: { path: "x", content: String(n) } }],
  }));
  const fourthEdit: FakeTurn = { type: "toolcall", calls: [{ name: "write", args: { path: "x", content: "4" } }] };
  const spawnFail: FakeTurn = { type: "toolcall", calls: [{ name: "bash", args: { command: "echo hi" } }] };

  // Loop side: the redacted spawn failure must neither count nor reset.
  const es = await drainLoop([...edits.slice(0, 3), spawnFail, fourthEdit, { type: "text", text: "done" }], [w.tool, bashTool], {
    executeToolCall: makeToolExecutor(redactor),
  });
  const p = progressEvents(es);
  assert.equal(p.length, 1, "the redacted spawn failure is still not ground contact");
  assert.equal(p[0]!.kind, "no-verification");

  // TUI side: A3 fires, then the redacted spawn failure arrives — no recovery.
  const fired = await drainLoop([...edits, spawnFail, { type: "text", text: "done" }], [w.tool, bashTool], {
    executeToolCall: makeToolExecutor(redactor),
  });
  const bashEnd = fired.find(
    (e): e is Extract<AgentEvent, { type: "tool_execution_end" }> =>
      e.type === "tool_execution_end" && e.result.toolName === "bash",
  );
  assert.ok(bashEnd, "the spawn failure produced a result");
  assert.equal(bashEnd.result.content.map((c) => c.text).join(""), "REDACTED", "the hook did rewrite the content");
  assert.equal(bashEnd.result.details?.notExecuted, true, "and the marker survived the rewrite");
  let state = makeInitialState("fake");
  for (const ev of fired) state = applyEvent(state, ev);
  assert.deepEqual(state.progressStats["no-verification"], { fired: 1, recovered: 0 }, "a redacted never-run call is not ground truth");
});

test("F1: the tunables are exported for tests/tuning", () => {
  assert.equal(NO_SUCCESS_TURNS, 3);
  assert.equal(UNVERIFIED_EDITS, 4);
  assert.equal(MAX_PROGRESS_NUDGES, 1);
});

test("F1: progressTargetOf — write/edit paths resolve, reads and non-strings do not count", () => {
  assert.equal(
    progressTargetOf({ type: "toolCall", id: "x", name: "write", arguments: { path: "./src/x.ts" } }),
    progressTargetOf({ type: "toolCall", id: "y", name: "edit", arguments: { path: "src/x.ts" } }),
  );
  assert.ok((progressTargetOf({ type: "toolCall", id: "x", name: "write", arguments: { path: "x" } }) ?? "").startsWith("/"));
  assert.equal(progressTargetOf({ type: "toolCall", id: "x", name: "read", arguments: { path: "x" } }), undefined);
  assert.equal(progressTargetOf({ type: "toolCall", id: "x", name: "bash", arguments: { path: "x" } }), undefined);
  assert.equal(progressTargetOf({ type: "toolCall", id: "x", name: "edit", arguments: {} }), undefined);
  assert.equal(progressTargetOf({ type: "toolCall", id: "x", name: "write", arguments: { path: "" } }), undefined);
});
test("loopStopNote header: evidence-driven for every stop kind, never '3 times' for caps or cycles", () => {
  const stable = loopStopNote({
    guard: "identical-batch",
    signature: "bash:{}\u0000read:{}",
    repeats: 3,
    stable: true,
    guardRetries: 1,
  });
  assert.match(stable, /^loop: the model repeated/);
  assert.match(stable, /3 times in a row with no change in results/);
  assert.match(stable, /after 1 auto-retry/);
  assert.doesNotMatch(stable, /without progress/);

  const cap = loopStopNote({
    guard: "identical-batch",
    signature: "bash:{}",
    repeats: POLL_CAP,
    stable: false,
    capReason: "fresh",
    guardRetries: 0,
  });
  assert.match(cap, /12 times in a row without progress/);
  assert.doesNotMatch(cap, /changing results/);
  assert.doesNotMatch(cap, /no change in results/);
  assert.doesNotMatch(cap, /3 times/);

  const cycle = loopStopNote({
    guard: "cycle-batch",
    signature: "a:{}\u0001b:{}",
    cycleLength: 2,
    repeats: 5,
    stable: true,
    guardRetries: 0,
  });
  assert.match(cycle, /^loop: the same two tool-call batches alternated/);
  assert.match(cycle, /5 times \(X, Y, X, Y, X …\) with no change in results/);
  assert.doesNotMatch(cycle, /repeated the same tool call\(s\)/);

  const capCycle = loopStopNote({
    guard: "cycle-batch",
    signature: "a:{}\u0001b:{}",
    cycleLength: 2,
    repeats: CYCLE_CAP,
    stable: false,
    capReason: "fresh",
    guardRetries: 0,
  });
  assert.match(capCycle, /12 times \(X, Y, X, Y, X …\) without progress/);
  assert.doesNotMatch(capCycle, /no change in results|changing results/);

  // Legacy: evidence without `stable` (pre-loop-v2 session) makes no claim
  // about results either way.
  const legacy = loopStopNote({
    guard: "identical-batch",
    signature: "bash:{}",
    repeats: 3,
    guardRetries: 0,
  } as Parameters<typeof loopStopNote>[0]);
  assert.match(legacy, /stopped to avoid a runaway loop/);
  assert.doesNotMatch(legacy, /no change in results|without progress/);
});

// ── Re-audit 2026-11-02: synthetic-history exemption + honest retry texts ──

test("loop v2: alternating length-guarded batches never trip the stable cycle guard", async () => {
  // Re-audit finding 1: length-guarded fills are SYNTHETIC (nothing ran).
  // Recorded as failed batches they are exempt from the stable cycle rule;
  // before the fix [A,B,A,B] of constant fill digests looked like a stable
  // alternation and the 5th (COMPLETE) batch was refused with a stable
  // cycle stop — zero real results ever repeated.
  const a = makeTool("a");
  const b = makeTool("b");
  const turns: FakeTurn[] = [
    { type: "length", calls: [{ id: "t1", name: "a", args: { path: "x" } }] },
    { type: "length", calls: [{ id: "t2", name: "b", args: { path: "x" } }] },
    { type: "length", calls: [{ id: "t3", name: "a", args: { path: "x" } }] },
    { type: "length", calls: [{ id: "t4", name: "b", args: { path: "x" } }] },
    { type: "toolcall", calls: [{ id: "t5", name: "a", args: { path: "x" } }] },
    { type: "text", text: "done" },
  ];
  const events = await drainLoop(turns, [a.tool, b.tool], {
    maxTurns: 50,
    maxGuardRetries: 0,
  });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "stop", "the complete batch runs; no false cycle stop");
  assert.equal(a.calls.length, 1, "the complete call executed exactly once");
  assert.equal(b.calls.length, 0);
});

test("loop v2: a cycle fire injects the ALTERNATING nudge with its true count", async () => {
  // Re-audit finding 2: the injected retry nudge names the pattern that
  // fired (X, Y, X, Y, X …) with the fired guard's own repeat count — not
  // the old constant's false "3 times in a row".
  const xa = makeTool("a");
  const xb = makeTool("b");
  const alternating = (i: number): FakeTurn => ({
    type: "toolcall",
    calls: [{ id: `c${i}`, name: i % 2 ? "b" : "a", args: { q: 1 } }],
  });
  const turns: FakeTurn[] = [
    alternating(0),
    alternating(1),
    alternating(2),
    alternating(3),
    alternating(4),
    { type: "text", text: "done" },
  ];
  const events = await drainLoop(turns, [xa.tool, xb.tool], { maxTurns: 50 });
  const retries = events.filter((e) => e.type === "guard_retry") as Extract<
    AgentEvent,
    { type: "guard_retry" }
  >[];
  assert.equal(retries.length, 1);
  assert.equal(retries[0]!.reason, "cycle");
  assert.equal(retries[0]!.repeats, 5, "5 batches issued incl. the refused one");
  const end = agentEnd(events);
  const nudge = end.messages.filter((m) => m.role === "user").at(-1);
  assert.ok(typeof nudge !== "string" && nudge && typeof nudge.content === "string");
  const text = nudge!.role === "user" ? String(nudge!.content) : "";
  assert.match(text, /alternately \(X, Y, X, Y, X …\) 5 times/);
  assert.doesNotMatch(text, /in a row/, "no false '3 times in a row' on a cycle fire");
});

test("loop v2: a cap fire nudges with the cap count (12), not 3", async () => {
  let n = 0;
  const counter = makeTool("read", {
    execute: (async () => ({ content: [{ type: "text", text: `rev ${++n}` }] })) as Tool["execute"],
  });
  const turns: FakeTurn[] = [
    ...Array.from({ length: 12 }, (_, i) => ({
      type: "toolcall" as const,
      calls: [{ id: `c${i}`, name: "read", args: { path: "x" } }],
    })),
    { type: "text", text: "done" },
  ];
  const events = await drainLoop(turns, [counter.tool], { maxTurns: 50 });
  const retries = events.filter((e) => e.type === "guard_retry") as Extract<
    AgentEvent,
    { type: "guard_retry" }
  >[];
  assert.equal(retries.length, 1, "the cap fire auto-retries once (default budget)");
  assert.equal(retries[0]!.reason, "identical");
  assert.equal(retries[0]!.repeats, POLL_CAP);
  const end = agentEnd(events);
  const nudge = end.messages.filter((m) => m.role === "user").at(-1);
  const text = nudge && nudge.role === "user" ? String(nudge.content) : "";
  assert.match(text, new RegExp(`${POLL_CAP} times in a row`));
  assert.doesNotMatch(text, /3 times in a row/);
});

test("guardRetryNote: honest per-pattern transcript line (shared CLI/TUI)", () => {
  const identical = guardRetryNote("identical", 3);
  assert.match(identical, /same tool call\(s\) repeated, 3 batches issued incl\. the refused one/);
  const cycle = guardRetryNote("cycle", 5);
  assert.match(cycle, /two tool-call batches alternating, 5 batches issued/);
  assert.doesNotMatch(cycle, /3×|3 times|two tool calls/);
  const cap = guardRetryNote("identical", POLL_CAP);
  assert.match(cap, /12 batches issued/);
  // Legacy producer without reason/repeats: no pattern, no count claim.
  const legacy = guardRetryNote(undefined, undefined);
  assert.match(legacy, /repeated tool-call batch\) — retrying with a changed approach/);
  assert.doesNotMatch(legacy, /3×|3 times|alternating|incl\./);
});

// Parameterized audit coverage (2026-11-02): ONE synthetic record among the
// four stable-cycle history entries [X, Y, X₂, Y₂] must veto the guard. The
// original single case (synthetic SECOND pair) caught the shipped bug but
// could miss a regression dropping just ONE of the four failed-flag checks;
// iterating all 16 subsets of {X, Y, X₂, Y₂} exercises every check the rule
// performs individually.

const SYNTHETIC_POS_NAMES = ["X", "Y", "X2", "Y2"];

function syntheticMaskLabel(mask: number): string {
  if (mask === 0) return "all four genuine — the stable cycle fires";
  const names = SYNTHETIC_POS_NAMES.filter((_, i) => mask & (1 << i));
  return `synthetic ${names.join("+")} — the guard must not fire`;
}

test("loop v2: EVERY synthetic stable-cycle position vetoes the guard (all 16 subsets)", async (t) => {
  // Executions 0..3 ARE the four history records (batches A, B, A, B of the
  // alternating run); execution 4 is the 5th batch, whose refusal would be
  // the guard stop. Every synthetic record answers with the SAME text as the
  // genuine results ("same") but carries details.notExecuted — it digests
  // exactly like a real result, so only the failed-flag checks can see it.
  // Mask bit i marks execution i synthetic. With the empty subset (mask 0:
  // all four genuine) the stable alternation is proven and the guard MUST
  // stop before the 5th batch; with any non-empty subset it MUST NOT.
  for (let mask = 0; mask < 16; mask++) {
    await t.test(syntheticMaskLabel(mask), async () => {
      let executions = 0;
      const mk = (name: string) =>
        makeTool(name, {
          execute: (async () => {
            const i = executions++;
            return {
              content: [{ type: "text", text: "same" }],
              ...(mask & (1 << i) ? { details: { notExecuted: true } } : {}),
            };
          }) as Tool["execute"],
        });
      const a = mk("a");
      const b = mk("b");
      const alternating = (i: number): FakeTurn => ({
        type: "toolcall",
        calls: [{ id: `c${i}`, name: i % 2 ? "b" : "a", args: { q: 1 } }],
      });
      const turns: FakeTurn[] = [
        alternating(0),
        alternating(1),
        alternating(2),
        alternating(3),
        alternating(4),
        { type: "text", text: "done" },
      ];
      const events = await drainLoop(turns, [a.tool, b.tool], {
        maxTurns: 50,
        maxGuardRetries: 0,
      });
      const end = agentEnd(events);
      if (mask === 0) {
        assert.equal(end.stopReason, "loop", "all-genuine stable alternation still stops");
        assert.equal(end.evidence?.guard, "cycle-batch");
        assert.equal(executions, 4, "the 5th batch refused");
      } else {
        assert.equal(end.stopReason, "stop", "a synthetic history record vetoes the stable cycle");
        assert.equal(executions, 5, "the 5th batch executed");
      }
    });
  }
});
