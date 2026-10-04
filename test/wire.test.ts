/**
 * WS1 — exit-criteria tests: against the WS8 mock SSE server, assert the
 * EXACT AssistantStreamEvent sequence for a text reply and a multi-tool-call
 * reply, plus error/abort/length behavior. No network beyond 127.0.0.1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startMockSse } from "./mock-sse.js";
import { httpJson, HttpError } from "../src/wire/http.js";
import { AbortError } from "../src/wire/abort.js";
import {
  buildParams,
  collectStream,
  completionsUrl,
  convertMessages,
  openAiStream,
  parseToolArgs,
  sanitizeCallId,
} from "../src/wire/openai-completions.js";
import type {
  AgentMessage,
  AssistantMessage,
  AssistantStreamEvent,
  LlmContext,
  ModelConfig,
  ToolCallBlock,
} from "../src/types.js";

const MODEL: ModelConfig = {
  id: "mock-model",
  provider: "mock",
  baseUrl: "http://should-be-replaced/v1",
  api: "openai-completions",
  contextWindow: 32000,
  maxTokens: 512,
  temperature: 0.2,
};

const TOOL = {
  name: "read",
  description: "read a file",
  parameters: {
    type: "object" as const,
    properties: { path: { type: "string" as const, description: "file" } },
    required: ["path"],
  },
  execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

const noToolsCtx = (messages: AgentMessage[] = []): LlmContext => ({
  systemPrompt: "sys",
  messages,
  tools: [],
});

function typeSeq(events: AssistantStreamEvent[]): string[] {
  return events.map((e) => e.type);
}

test("text reply: exact event sequence start → 3 text_deltas → done", async () => {
  const mock = await startMockSse("text");
  const model = { ...MODEL, baseUrl: mock.baseUrl };
  const events = await collectStream(
    openAiStream,
    model,
    noToolsCtx(),
    { signal: new AbortController().signal },
  );
  await mock.close();

  assert.deepEqual(
    typeSeq(events),
    ["start", "text_delta", "text_delta", "text_delta", "done"],
  );
  const [start, d1, d2, d3, done] = events as [
    Extract<AssistantStreamEvent, { type: "start" }>,
    Extract<AssistantStreamEvent, { type: "text_delta" }>,
    Extract<AssistantStreamEvent, { type: "text_delta" }>,
    Extract<AssistantStreamEvent, { type: "text_delta" }>,
    Extract<AssistantStreamEvent, { type: "done" }>,
  ];

  assert.deepEqual(start.partial.content, []);
  assert.equal(d1.delta, "Hel");
  assert.equal(d2.delta, "lo ");
  assert.equal(d3.delta, "world");
  // I2: partials accumulate
  assert.equal(start.partial.model, "mock-model");
  assert.equal((d1.partial.content[0] as { type: "text"; text: string }).text, "Hel");
  assert.equal((d3.partial.content[0] as { type: "text"; text: string }).text, "Hello world");

  assert.equal(done.message.stopReason, "stop");
  assert.equal(
    (done.message.content[0] as { text: string }).text,
    "Hello world",
  );
  assert.deepEqual(done.message.usage, {
    input: 11,
    output: 22,
    totalTokens: 33,
  });

  // Request shape: streaming params sent correctly.
  const req = mock.lastRequest!;
  assert.equal(req.stream, true);
  assert.deepEqual(req.stream_options, { include_usage: true });
  // (stream_options from parsed JSON is a distinct object — deepEqual)
  assert.equal(req.model, "mock-model");
  assert.equal(req.max_tokens, 512);
  assert.equal(req.temperature, 0.2);
  assert.deepEqual((req.messages as unknown[])[0], { role: "system", content: "sys" });
});

test("multi-tool reply: exact sequence, two calls, full args, usage", async () => {
  const mock = await startMockSse("multi-tool");
  const model = { ...MODEL, baseUrl: mock.baseUrl };
  const events = await collectStream(
    openAiStream,
    model,
    { systemPrompt: "sys", messages: [{ role: "user", content: "do it", timestamp: 0 }], tools: [TOOL] },
    { signal: new AbortController().signal },
  );
  await mock.close();

  assert.deepEqual(
    typeSeq(events),
    [
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_delta",
      "done",
    ],
  );
  const done = events[events.length - 1] as Extract<AssistantStreamEvent, { type: "done" }>;
  assert.equal(done.message.stopReason, "toolUse");
  const calls = done.message.content.filter((b): b is ToolCallBlock => b.type === "toolCall");
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => [c.id, c.name]),
    [
      ["call_abc123", "read"],
      ["call_def456", "bash"],
    ],
  );
  assert.deepEqual(calls[0]!.arguments, { path: "a.txt" });
  assert.deepEqual(calls[1]!.arguments, { command: "ls -la", timeout: 30 });
  assert.deepEqual(done.message.usage, { input: 11, output: 22, totalTokens: 33 });

  // tools were sent in OpenAI shape
  const req = mock.lastRequest!;
  assert.deepEqual((req.tools as unknown[])[0], {
    type: "function",
    function: { name: "read", description: "read a file", parameters: TOOL.parameters },
  });
});

test("length scenario: truncated args → stopReason length, salvaged args, no throw", async () => {
  const mock = await startMockSse("length");
  const model = { ...MODEL, baseUrl: mock.baseUrl };
  const events = await collectStream(
    openAiStream,
    model,
    noToolsCtx(),
    { signal: new AbortController().signal },
  );
  await mock.close();

  const done = events[events.length - 1] as Extract<AssistantStreamEvent, { type: "done" }>;
  assert.equal(done.message.stopReason, "length");
  const call = done.message.content.find((b) => b.type === "toolCall") as ToolCallBlock;
  // '{"path":"a.tx' → repair closes string + brace → { path: "a.tx" }
  assert.deepEqual(call.arguments, { path: "a.tx" });
});

test("http-error scenario: done(error) with status + provider message (I3)", async () => {
  const mock = await startMockSse("http-error");
  const model = { ...MODEL, baseUrl: mock.baseUrl };
  const events = await collectStream(
    openAiStream,
    model,
    noToolsCtx(),
    { signal: new AbortController().signal },
  );
  await mock.close();

  assert.deepEqual(typeSeq(events), ["start", "done"]);
  const done = events[1] as Extract<AssistantStreamEvent, { type: "done" }>;
  assert.equal(done.message.stopReason, "error");
  assert.match(done.message.errorMessage ?? "", /HTTP 400/);
  assert.match(done.message.errorMessage ?? "", /Invalid request/);
});

test("stream-error scenario: partial text then done(error)", async () => {
  const mock = await startMockSse("stream-error");
  const model = { ...MODEL, baseUrl: mock.baseUrl };
  const events = await collectStream(
    openAiStream,
    model,
    noToolsCtx(),
    { signal: new AbortController().signal },
  );
  await mock.close();

  assert.deepEqual(typeSeq(events), ["start", "text_delta", "done"]);
  const done = events[2] as Extract<AssistantStreamEvent, { type: "done" }>;
  assert.equal(done.message.stopReason, "error");
  assert.match(done.message.errorMessage ?? "", /simulated upstream failure/);
  // The partial text is kept in context (I2) even though the stream failed.
  const text = done.message.content.find((b): b is { type: "text"; text: string } => b.type === "text");
  assert.equal(text?.text, "partial ");
});

test("abort before request: done(aborted) without throwing", async () => {
  const mock = await startMockSse("text");
  const model = { ...MODEL, baseUrl: mock.baseUrl };
  const controller = new AbortController();
  controller.abort();
  const events = await collectStream(
    openAiStream,
    model,
    noToolsCtx(),
    { signal: controller.signal },
  );
  await mock.close();

  assert.deepEqual(typeSeq(events), ["start", "done"]);
  const done = events[1] as Extract<AssistantStreamEvent, { type: "done" }>;
  assert.equal(done.message.stopReason, "aborted");
});

test("convertMessages: assistant text+calls → wire format, toolResult → tool msg", () => {
  const msgs: AgentMessage[] = [
    { role: "user", content: "read a.txt", timestamp: 0 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "let me read it" },
        { type: "toolCall", id: "c!1", name: "read", arguments: { path: "a.txt" } },
      ],
      model: "m",
      provider: "p",
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "c!1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      timestamp: 2,
    },
  ];
  const wire = convertMessages(MODEL, { systemPrompt: "s", messages: msgs, tools: [] });
  assert.deepEqual(wire, [
    { role: "system", content: "s" },
    { role: "user", content: "read a.txt" },
    {
      role: "assistant",
      content: "let me read it",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "file contents" },
  ]);
});

test("convertMessages: empty assistant messages are skipped", () => {
  const msgs: AgentMessage[] = [
    {
      role: "assistant",
      content: [],
      model: "m",
      provider: "p",
      stopReason: "stop",
      timestamp: 0,
    },
    { role: "user", content: "hi", timestamp: 1 },
  ];
  const wire = convertMessages(MODEL, { systemPrompt: "", messages: msgs, tools: [] });
  assert.deepEqual(wire, [{ role: "user", content: "hi" }]);
});

test("convertMessages: requiresAssistantAfterToolResult inserts synthetic assistant", () => {
  const model = { ...MODEL, compat: { requiresAssistantAfterToolResult: true } };
  const msgs: AgentMessage[] = [
    { role: "user", content: "go", timestamp: 0 },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: "out" }],
      timestamp: 1,
    },
    { role: "user", content: "more", timestamp: 2 },
  ];
  const wire = convertMessages(model, { systemPrompt: "", messages: msgs, tools: [] });
  assert.deepEqual(
    wire.map((m) => m.role),
    ["user", "tool", "assistant", "user"],
  );
});

test("buildParams: compat flags steer the request body", () => {
  const ctx = noToolsCtx();
  const base = buildParams(MODEL, ctx);
  assert.deepEqual(base.stream_options, { include_usage: true });

  const noUsage = buildParams({ ...MODEL, compat: { supportsUsageInStreaming: false } }, ctx);
  assert.equal(noUsage.stream_options, undefined);

  const maxCompletion = buildParams({ ...MODEL, compat: { maxTokensField: "max_completion_tokens" } }, ctx);
  assert.equal(maxCompletion.max_completion_tokens, 512);
  assert.equal(maxCompletion.max_tokens, undefined);

  const extra = buildParams({ ...MODEL, compat: { extraParams: { enable_thinking: false } } }, ctx);
  assert.equal(extra.enable_thinking, false);
});

test("parseToolArgs: salvage cases", () => {
  assert.deepEqual(parseToolArgs('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArgs('{"path":"a.tx'), { path: "a.tx" });
  assert.deepEqual(parseToolArgs('{"a":1,"b":2'), { a: 1, b: 2 });
  assert.deepEqual(parseToolArgs('{"a":'), { a: null });
  assert.deepEqual(parseToolArgs('{"a":1,["b":2'), { a: 1 });
  assert.deepEqual(parseToolArgs(""), {});
  assert.deepEqual(parseToolArgs("not json"), {});
  assert.deepEqual(parseToolArgs("[1,2]"), {});
});

test("sanitizeCallId: charset + length + fallback", () => {
  assert.equal(sanitizeCallId("call_abc-123"), "call_abc-123");
  assert.equal(sanitizeCallId("a:b/c.d"), "abcd");
  assert.equal(sanitizeCallId("x".repeat(100)).length, 64);
  const fallback = sanitizeCallId("", 3);
  assert.match(fallback, /^call_4_/);
  const fallback2 = sanitizeCallId("!!!", 0);
  assert.match(fallback2, /^call_1_/);
});

test("completionsUrl: joins baseUrl without double slash", () => {
  assert.equal(completionsUrl("http://h:1/v1"), "http://h:1/v1/chat/completions");
  assert.equal(completionsUrl("http://h:1/v1/"), "http://h:1/v1/chat/completions");
});

/** Stub globalThis.fetch with a canned Response; counts calls, restores on cleanup. */
function stubFetch(res: Response): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return res;
  }) as typeof fetch;
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("httpJson: 200 with malformed JSON body is NOT retried (M2)", async () => {
  const mock = stubFetch(new Response("not-json", { status: 200 }));
  try {
    await assert.rejects(
      httpJson({ url: "http://x/v1", signal: new AbortController().signal }),
      (err: unknown) =>
        err instanceof HttpError &&
        err.status === 200 &&
        /malformed JSON/.test(err.message),
    );
    assert.equal(mock.calls(), 1); // server already succeeded — no re-POST
  } finally {
    mock.restore();
  }
});

test("httpJson: abort during backoff rejects promptly with AbortError (M1)", async () => {
  const mock = stubFetch(new Response("boom", { status: 500 }));
  const controller = new AbortController();
  const started = Date.now();
  const p = httpJson({
    url: "http://x/v1",
    signal: controller.signal,
    backoffMs: 1000, // first backoff sleep is 1000ms
  });
  // Let the first 500 attempt land, then abort mid-backoff.
  await new Promise((r) => setTimeout(r, 100));
  controller.abort();
  await assert.rejects(p, (err: unknown) => err instanceof AbortError);
  // An abort-aware sleep wakes immediately; the old one would wait ~1000ms.
  assert.ok(
    Date.now() - started < 500,
    `abort should wake the backoff sleep promptly (took ${Date.now() - started}ms)`,
  );
  assert.equal(mock.calls(), 1);
  mock.restore();
});
