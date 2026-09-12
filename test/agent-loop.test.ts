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
 *   - length guard: truncated tool calls are failed, never executed
 *   - batch dispatch: parallel by default, sequential when any tool opts
 *     in; results and end events always in call order
 *   - batch terminate, unknown tools, maxTurns, prepareNextTurn
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fakeStream, type FakeTurn } from "./fake-stream.js";
import { runLoop, type AgentLoopOptions } from "../src/loop/agent-loop.js";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
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

test("maxTurns caps the number of LLM turns", async () => {
  const { tool } = makeTool("read");
  const turns: FakeTurn[] = [
    { type: "toolcall", calls: [{ id: "c1", name: "read", args: {} }] },
    { type: "text", text: "never reached" },
  ];
  const events = await drainLoop(turns, [tool], { maxTurns: 1 });
  const end = agentEnd(events);
  assert.equal(events.filter((e) => e.type === "turn_start").length, 1);
  assert.equal(end.stopReason, "toolUse", "last assistant message's stopReason is kept");
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
