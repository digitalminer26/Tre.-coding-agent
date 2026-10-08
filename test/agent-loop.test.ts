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
  LOOP_GUARD_TEXT,
  batchSignature,
  deriveMaxTurns,
  runLoop,
  type AgentLoopOptions,
} from "../src/loop/agent-loop.js";
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

test("C26: loop detection — same batch 3× → third NOT executed, stopReason loop", async () => {
  const { tool, calls } = makeTool("read");
  const same = { id: "c1", name: "read", args: { path: "x" } };
  const turns: FakeTurn[] = Array.from({ length: 4 }, () => ({
    type: "toolcall",
    calls: [same],
  }));
  const events = await drainLoop(turns, [tool], { maxTurns: 50 });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "loop", "three identical batches stop the run");
  assert.equal(end.maxTurns, undefined, "a loop stop is not a budget stop");
  // Only the first TWO repeats executed — the third was guarded.
  assert.equal(calls.length, 2, "the 3rd identical batch was not executed");
  // The guarded batch still got in-band error results (I3).
  const guardedResults = events.filter(
    (e) => e.type === "tool_execution_end" && e.result.isError === true,
  );
  assert.equal(guardedResults.length, 1, "the guarded call got one error result");
  const text = (guardedResults[0] as Extract<AgentEvent, { type: "tool_execution_end" }>)
    .result.content[0] as { type: "text"; text: string };
  assert.match(text.text, /Runaway loop detected/);
  // No turn_budget was involved.
  assert.equal(events.filter((e) => e.type === "turn_budget").length, 0);
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
  // on repeats 1–2, loop detection stops it on repeat 3 (not after the
  // full cycle budget).
  const { tool, calls } = makeTool("read");
  const truncated = { id: "t1", name: "read", args: { path: "x" } };
  const turns: FakeTurn[] = Array.from({ length: 4 }, () => ({
    type: "length",
    calls: [truncated],
  }));
  const events = await drainLoop(turns, [tool], { maxTurns: 50 });
  const end = agentEnd(events);
  assert.equal(end.stopReason, "loop", "3× identical truncated batch → loop");
  assert.equal(calls.length, 0, "truncated calls are never executed");
  // Repeats 1–2 got the length-guard text, repeat 3 got the loop text.
  const ends = events.filter(
    (e) => e.type === "tool_execution_end" && e.result.isError === true,
  ) as Extract<AgentEvent, { type: "tool_execution_end" }>[];
  assert.equal(ends.length, 3);
  assert.match(ends[0]!.result.content[0]!.text, /truncated/);
  assert.match(ends[1]!.result.content[0]!.text, /truncated/);
  assert.match(ends[2]!.result.content[0]!.text, /Runaway loop detected/);
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
