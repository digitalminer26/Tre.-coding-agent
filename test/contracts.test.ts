/**
 * WS0 exit criteria, expressed as tests:
 *  1. A small fake StreamFn type-checks against the StreamFn contract and
 *     yields a legal, cumulative event sequence (I2, done-last).
 *  2. A fake Tool type-checks against the Tool contract and executes.
 *  3. AgentMessage is plain JSON data (it doubles as the session format).
 * No network, no LLM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AgentMessage,
  AssistantMessage,
  AssistantStreamEvent,
  ModelConfig,
  StreamFn,
  Tool,
  ToolCallBlock,
} from "../src/types.js";

const model: ModelConfig = {
  id: "fake-7b",
  provider: "fake",
  baseUrl: "http://fake.invalid/v1",
  api: "openai-completions",
  contextWindow: 4096,
  maxTokens: 512,
};

const echoTool: Tool = {
  name: "echo",
  description: "Echoes the msg argument back.",
  parameters: {
    type: "object",
    properties: { msg: { type: "string", description: "text to echo" } },
    required: ["msg"],
  },
  async execute(_toolCallId, args) {
    return { content: [{ type: "text", text: String(args.msg) }] };
  },
};

/** Scripted fake: "Hello world" + one tool call, per the event contract. */
const fakeStream: StreamFn = async function* (m) {
  const msg: AssistantMessage = {
    role: "assistant",
    content: [],
    model: m.id,
    provider: m.provider,
    stopReason: "stop",
    timestamp: Date.now(),
  };
  yield { type: "start", partial: structuredClone(msg) };

  const text = { type: "text" as const, text: "" };
  msg.content.push(text);
  for (const d of ["Hello ", "world"]) {
    text.text += d;
    yield { type: "text_delta", delta: d, partial: structuredClone(msg) };
  }

  const call: ToolCallBlock = { type: "toolCall", id: "call_1", name: "echo", arguments: {} };
  msg.content.push(call);
  msg.stopReason = "toolUse";
  yield { type: "toolcall_start", index: 0, id: call.id, name: call.name, partial: structuredClone(msg) };
  for (const frag of ['{"msg":', '"hi"}']) {
    yield { type: "toolcall_delta", index: 0, argsDelta: frag, partial: structuredClone(msg) };
  }
  call.arguments = { msg: "hi" }; // salvage lands on done
  yield { type: "done", message: structuredClone(msg) };
};

test("fake StreamFn yields a legal, cumulative event sequence", async () => {
  const events: AssistantStreamEvent[] = [];
  const stream = fakeStream(
    model,
    { systemPrompt: "s", messages: [], tools: [echoTool] },
    { signal: new AbortController().signal },
  );
  for await (const ev of stream) events.push(ev);

  assert.equal(events[0]?.type, "start");
  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "text_delta", "text_delta", "toolcall_start", "toolcall_delta", "toolcall_delta", "done"],
  );

  // I2: partial content grows monotonically; every partial is a full message.
  let blocks = 0;
  for (const ev of events) {
    if (ev.type === "done") break;
    assert.equal(ev.partial.model, model.id);
    assert.ok(ev.partial.content.length >= blocks, "partial must be cumulative");
    blocks = ev.partial.content.length;
  }

  const done = events.at(-1);
  assert.ok(done && done.type === "done");
  assert.equal(done.message.stopReason, "toolUse");
  const call = done.message.content.find((b) => b.type === "toolCall");
  assert.deepEqual(call?.arguments, { msg: "hi" });
});

test("fake Tool executes within the Tool contract", async () => {
  const res = await echoTool.execute("call_1", { msg: "hi" }, new AbortController().signal);
  assert.deepEqual(res.content, [{ type: "text", text: "hi" }]);
});

test("AgentMessage is plain JSON data (it doubles as the session format)", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "hi", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      model: model.id,
      provider: model.provider,
      stopReason: "stop",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "echo",
      content: [{ type: "text", text: "hi" }],
      timestamp: 3,
    },
  ];
  const round = JSON.parse(JSON.stringify(messages)) as AgentMessage[];
  assert.deepEqual(round, messages);
});
