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

  // D26 fold cap (audit round 2): compat.extraParams merges LAST, so an
  // endpoint config CAN override the output cap (this is why the compaction
  // fold's real-size guard, not the cap, is the authority). Pin the
  // precedence: extraParams wins over the model's maxTokens field.
  const capped = buildParams(
    { ...MODEL, compat: { extraParams: { max_tokens: 64 } } },
    ctx,
  );
  assert.equal(capped.max_tokens, 64, "extraParams overrides the output cap");
  const altField = buildParams(
    {
      ...MODEL,
      compat: { maxTokensField: "max_completion_tokens", extraParams: { max_completion_tokens: 32 } },
    },
    ctx,
  );
  assert.equal(altField.max_completion_tokens, 32, "override works on the alternate cap field too");

  // OpenRouter automatic prompt caching: opt-in sends a top-level
  // `cache_control`; unset/absent sends nothing (other endpoints must not
  // see the field).
  const cached = buildParams({ ...MODEL, compat: { promptCaching: true } }, ctx);
  assert.deepEqual(cached.cache_control, { type: "ephemeral" });
  assert.equal(base.cache_control, undefined);
  assert.equal(
    buildParams({ ...MODEL, compat: { promptCaching: false } }, ctx).cache_control,
    undefined,
  );
});

test("cached-usage: cached_tokens and cache_write_tokens map to cacheRead/cacheWrite", async () => {
  const mock = await startMockSse("cached-usage");
  const events = await collectStream(
    openAiStream,
    { ...MODEL, baseUrl: mock.baseUrl },
    noToolsCtx(),
    { signal: new AbortController().signal },
  );
  await mock.close();
  const done = events[events.length - 1] as Extract<AssistantStreamEvent, { type: "done" }>;
  assert.deepEqual(done.message.usage, {
    input: 100,
    output: 10,
    totalTokens: 110,
    cacheRead: 80,
    cacheWrite: 12,
  });
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

// Audit finding 1 (2026-10-25): the leak repair is OPT-IN
// (compat.repairsLeakedToolProtocol). A value ENDING in a closing protocol
// tag is textually indistinguishable from a leak, and unstripped parsing is
// the safe default — valid JSON arguments are returned VERBATIM.
test("parseToolArgs: DEFAULT is verbatim — a trailing protocol tag is NOT stripped (audit finding 1)", () => {
  assert.deepEqual(
    parseToolArgs('{"command":"printf hello\\n</parameter>\\n</function>\\n</tool_call>"}'),
    { command: "printf hello\n</parameter>\n</function>\n</tool_call>" },
  );
  // The exact corruptions the audit filed against always-on repair:
  assert.deepEqual(parseToolArgs('{"content":"<function>hello</function>"}'), {
    content: "<function>hello</function>",
  });
  assert.deepEqual(parseToolArgs('{"oldText":"</parameter>","newText":"replacement"}'), {
    oldText: "</parameter>",
    newText: "replacement",
  });
});

test("parseToolArgs: repairLeakedProtocol strips leaked Qwen XML suffix from string values", () => {
  assert.deepEqual(
    parseToolArgs('{"command":"printf hello\\n</parameter>\\n</function>\\n</tool_call>"}', {
      repairLeakedProtocol: true,
    }),
    { command: "printf hello" },
  );
  // Salvage path too: markers spliced text-wide are stripped only under repair.
  assert.deepEqual(
    parseToolArgs('{"command":"ls\\n</parameter>\\n,"path":"a.ts"', { repairLeakedProtocol: true }),
    { command: "ls", path: "a.ts" },
  );
  // Audit round 2 (finding 1): LOSSLESS-FIRST ordering. When the leak sits
  // inside an unterminated value, the plain strip keeps ALL the content and
  // truncation repair closes the string; the quote-restoring variant would
  // close the value at the leak and DROP the trailing text. The ordering
  // must prefer the lossless parse.
  assert.deepEqual(
    parseToolArgs('{"command":"echo\\n</function>\\n, keep-going"', { repairLeakedProtocol: true }),
    { command: "echo\n, keep-going" },
  );
  assert.deepEqual(
    parseToolArgs('{"command":"echo\\n</function>\\n, keep-going', { repairLeakedProtocol: true }),
    { command: "echo\n, keep-going" },
  );
  // Audit round 3 (finding 1): a member-dropping salvage of the plain
  // variant must NOT suppress the quote-restoring variant's FULL recovery.
  // Plain-cleaned, this document parses only by dropping `path` at the
  // stray comma; quote restore closes the eaten quote and keeps all three.
  assert.deepEqual(
    parseToolArgs('{"other":1,"command":"ls\\n</parameter>\\n,"path":"a.ts"', { repairLeakedProtocol: true }),
    { other: 1, command: "ls", path: "a.ts" },
  );
  // Audit round 4 (finding 1): CONSECUTIVE leaked markers. The endpoint
  // leaks the whole closing chain but swallowed exactly ONE quote — each
  // marker replaced individually produced `"ls""` + stray tags (no parse)
  // and the first match's trailing newline ate the next match's leading
  // one. A run of markers must restore ONE quote.
  const fullChain = { other: 1, command: "ls", path: "a.ts" };
  assert.deepEqual(
    parseToolArgs('{"other":1,"command":"ls\\n</parameter>\\n</function>\\n</tool_call>\\n,"path":"a.ts"', {
      repairLeakedProtocol: true,
    }),
    fullChain,
  );
  assert.deepEqual(
    parseToolArgs('{"other":1,"command":"ls\\n</parameter>\\n</function>\\n,"path":"a.ts"', {
      repairLeakedProtocol: true,
    }),
    fullChain,
  );
  assert.deepEqual(
    parseToolArgs('{"other":1,"command":"ls\\n</parameter>\\n</function>,"path":"a.ts"', {
      repairLeakedProtocol: true,
    }),
    fullChain,
  );
  // Same chain with REAL newlines (the endpoint may emit either shape).
  assert.deepEqual(
    parseToolArgs('{"other":1,"command":"ls\n</parameter>\n</function>\n</tool_call>\n,"path":"a.ts"}', {
      repairLeakedProtocol: true,
    }),
    fullChain,
  );
  // Lossless-first still wins on a chain spliced INSIDE an unterminated
  // value: the plain strip deletes only the leaked marker garbage and
  // repair closes the string, so the model's content after the chain
  // (", keep-going") survives in the value — the quote-restoring variant
  // would close the value at the chain and drop it.
  assert.deepEqual(
    parseToolArgs('{"command":"echo\\n</function>\\n</parameter>\\n, keep-going"', {
      repairLeakedProtocol: true,
    }),
    { command: "echo\n, keep-going" },
  );
  // A literal backslash followed by `n` before a leaked marker is user
  // content, not the JSON newline separator. Odd/even backslash parity must
  // prevent normalization from starting inside that escaped content.
  const literalBackslashN = JSON.stringify({ content: "literal \\n</parameter>\n" });
  const literalBackslashNValue = "literal \\n";
  assert.deepEqual(parseToolArgs(literalBackslashN, { repairLeakedProtocol: true }), {
    content: literalBackslashNValue,
  });
  assert.deepEqual(
    parseToolArgs(literalBackslashN.slice(0, -1), { repairLeakedProtocol: true }),
    { content: literalBackslashNValue },
  );
  assert.deepEqual(
    parseToolArgs(`${literalBackslashN.slice(0, -1)},"n":oops`, { repairLeakedProtocol: true }),
    { content: literalBackslashNValue },
  );
  assert.deepEqual(
    parseToolArgs(`${literalBackslashN.slice(0, -1)},"n":oops}`, { repairLeakedProtocol: true }),
    { content: literalBackslashNValue },
  );
  // Literal `\n` text (escaped backslash + n) directly before a leaked marker
  // with an ERASED closing quote: the user's escape pair is kept and the
  // quote is restored from structural context (audit finding: 36 mismatches).
  const literalPrefix = String.raw`{"content":"prefix\\n</parameter>\n,"path":"a.ts"}`;
  assert.deepEqual(parseToolArgs(literalPrefix, { repairLeakedProtocol: true }), {
    content: "prefix\\n",
    path: "a.ts",
  });
  // Same literal prefix with an intact closing brace and a closing-brace
  // missing object terminator: no spurious quote, the literal stays verbatim.
  assert.deepEqual(parseToolArgs(String.raw`{"content":"prefix\\n</parameter>\n}`, { repairLeakedProtocol: true }), {
    content: "prefix\\n",
  });
  // Audit follow-up: a surviving quote after a marker run must be recognized
  // even when the run has trailing horizontal whitespace. The truncated and
  // complete forms recover identical exact-match text.
  for (const ws of [" ", "\\t", "\\n\\t"]) {
    const complete = `{"content":"hello\\n</parameter>${ws}","path":"a.ts"}`;
    assert.deepEqual(
      parseToolArgs(complete, { repairLeakedProtocol: true }),
      { content: "hello", path: "a.ts" },
    );
    assert.deepEqual(
      parseToolArgs(complete.slice(0, -1), { repairLeakedProtocol: true }),
      { content: "hello", path: "a.ts" },
    );
  }
  // CRLF is a protocol separator like LF, both as JSON escapes and as
  // actual line endings; the marker and its surrounding separators are removed.
  for (const crlf of [String.raw`\r\n`, "\r\n"]) {
    const eaten = `{"content":"hello${crlf}</parameter>${crlf},"path":"a.ts"}`;
    assert.deepEqual(parseToolArgs(eaten, { repairLeakedProtocol: true }), {
      content: "hello",
      path: "a.ts",
    });
  }
  // Direct parsing must strip CRLF leaked tails too, not only the invalid-JSON
  // salvage path. Include escaped, actual, and mixed line endings, plus
  // complete and missing-brace forms to keep both paths equivalent.
  for (const [lead, tail] of [
    [String.raw`\r\n`, String.raw`\r\n`],
    ["\\r\\n", "\\r\\n"],
    ["\\r\\n", "\\n"],
  ]) {
    const complete = `{"content":"hello${lead}</parameter>${tail}","path":"a.ts"}`;
    const expected = { content: "hello", path: "a.ts" };
    assert.deepEqual(parseToolArgs(complete, { repairLeakedProtocol: true }), expected);
    assert.deepEqual(parseToolArgs(complete.slice(0, -1), { repairLeakedProtocol: true }), expected);
  }
  // On invalid JSON requiring trailing-member salvage, prefer the plain
  // marker strip when it preserves more intact argument content. The shorter
  // quote-restored variant otherwise closes `command` early and drops its
  // surviving suffix along with the malformed later member.
  assert.deepEqual(
    parseToolArgs(String.raw`{"command":"echo\n</parameter>\n, keep-going","path":"a.ts","n":oops`, {
      repairLeakedProtocol: true,
    }),
    { command: "echo\n, keep-going", path: "a.ts" },
  );
  // Same ambiguity with only one valid field: member count ties, so retain
  // the candidate that preserves more intact string content rather than
  // choosing the shorter, prematurely closed value.
  assert.deepEqual(
    parseToolArgs(String.raw`{"command":"echo\n</parameter>\n, keep-going","n":oops`, {
      repairLeakedProtocol: true,
    }),
    { command: "echo\n, keep-going" },
  );
  // Blank separators inside intact marker tails are protocol, not extra
  // payload to reward during malformed-member salvage (exact-match edits).
  assert.deepEqual(
    parseToolArgs(String.raw`{"path":"a.ts","oldText":"hello\n</parameter>\n\n</function>","newText":"world\n</parameter>\n\n</function>","n":oops`, {
      repairLeakedProtocol: true,
    }),
    { path: "a.ts", oldText: "hello", newText: "world" },
  );
  // ── Audit round 5 (finding 1): RUN-AWARE quote restoration. Within one
  // document a value may have lost its closing quote while another kept
  // its own (a stray `"` after a marker run means the quote SURVIVED).
  // Inserting a quote into an intact run corrupted the survivor; the
  // repair now deletes an intact run and inserts a quote only where the
  // run is followed by non-quote context. All four eaten/intact orders
  // (well-formed documents — the doc ends at its closing brace):
  assert.deepEqual(
    parseToolArgs('{"other":1,"command":"ls\\n</parameter>\\n,"path":"a.ts\\n</parameter>\\n}', {
      repairLeakedProtocol: true,
    }),
    fullChain, // eaten / eaten — the round-5 finding-1 repro
  );
  assert.deepEqual(
    parseToolArgs('{"other":1,"command":"ls\\n</parameter>","path":"a.ts\\n</parameter>\\n}', {
      repairLeakedProtocol: true,
    }),
    fullChain, // intact / eaten
  );
  assert.deepEqual(
    parseToolArgs('{"other":1,"command":"ls\\n</parameter>\\n,"path":"a.ts\\n</parameter>"}', {
      repairLeakedProtocol: true,
    }),
    fullChain, // eaten / intact
  );
  assert.deepEqual(
    parseToolArgs('{"other":1,"command":"ls\\n</parameter>","path":"a.ts\\n</parameter>"}', {
      repairLeakedProtocol: true,
    }),
    fullChain, // intact / intact
  );
  // Systematic: both values leak with the same 1-3-marker chain, each value
  // independently eaten/intact, single- and blank-line separators, literal
  // \\n and real newlines (the shapes llama.cpp emits). Quote accounting:
  // a MID value needs its own closing quote (`"` after the run when intact,
  // none when eaten — the comma separator follows the swallowed quote's
  // newline); the LAST value's closing quote is the char right after the
  // run region, so intact ends `run"}"` and eaten ends `run}` after a
  // newline (the round-5 finding-1 repro shape).
  for (const [shape, nl] of [
    ["literal \\n", "\\n"],
    ["real newline", "\n"],
  ] as const) {
    for (const len of [1, 2, 3]) {
      const run = ["</parameter>", "</function>", "</tool_call>"].slice(0, len).join(nl);
      const runBlank = ["</parameter>", "</function>", "</tool_call>"].slice(0, len).join(nl + nl);
      for (const [sep, sepName] of [
        [run, "single"],
        [runBlank, "blank"],
      ] as const) {
        for (const q1 of [1, 0]) for (const q2 of [1, 0]) {
          const cmdTail = q1 ? `${sep}"` : `${sep}${nl}`;
          const pathValueTail = q2 ? `${sep}"` : `${sep}${nl}`;
          // Include malformed trailing members, with and without an object
          // close: all 96 salvage variants must clean separators just like
          // the original 48 end-of-document variants.
          for (const tail of ["}", ',"n":oops', ',"n":oops}']) {
            const raw = `{"other":1,"command":"ls${nl}${cmdTail},"path":"a.ts${nl}${pathValueTail}${tail}`;
            assert.deepEqual(
              parseToolArgs(raw, { repairLeakedProtocol: true }),
              fullChain,
              `${shape} / ${len}-marker ${sepName} chain / command=${q1 ? "intact" : "eaten"} path=${q2 ? "intact" : "eaten"} / tail=${tail}`,
            );
          }
        }
      }
    }
  }
  // ── Audit round 5 (finding 2): blank lines INSIDE a closing chain ────
  assert.deepEqual(
    parseToolArgs('{"other":1,"command":"ls\\n</parameter>\\n\\n</function>\\n,"path":"a.ts"', {
      repairLeakedProtocol: true,
    }),
    fullChain,
  );
  assert.deepEqual(
    parseToolArgs('{"other":1,"command":"ls\\n</parameter>\\n\\n</function>\\n\\n\\n</tool_call>\\n,"path":"a.ts"', {
      repairLeakedProtocol: true,
    }),
    fullChain,
  );
  assert.deepEqual(
    parseToolArgs('{"other":1,"command":"ls\n</parameter>\n\n</function>\n,"path":"a.ts"}', {
      repairLeakedProtocol: true,
    }),
    fullChain,
  );
  // Blank-line chain followed by a SURVIVING quote (intact run) still restores cleanly.
  assert.deepEqual(
    parseToolArgs('{"other":1,"command":"ls\\n</parameter>\\n\\n</function>","path":"a.ts"', {
      repairLeakedProtocol: true,
    }),
    fullChain,
  );
  // An in-value chain with a blank line: lossless-first keeps the content.
  assert.deepEqual(
    parseToolArgs('{"command":"echo\\n</function>\\n\\n</parameter>\\n, keep-going', {
      repairLeakedProtocol: true,
    }),
    { command: "echo\n\n, keep-going" },
  );
  // Without repair the same invalid input falls back to plain truncation
  // salvage (the text-wide marker strip does not run).
  assert.notDeepEqual(
    parseToolArgs('{"command":"ls\\n</parameter>\\n,"path":"a.ts"'),
    { command: "ls", path: "a.ts" },
  );
});

// Audit finding 3: the strip must touch ONLY a leaked marker at the END of
// a value — legitimate arguments containing tag-like content (XML fixtures,
// heredocs, exact-match edits) are returned verbatim.
test("parseToolArgs: interior tag-like content is preserved verbatim (audit finding 3)", () => {
  assert.deepEqual(
    parseToolArgs(JSON.stringify({ content: "first\n</function>\nlast" })),
    { content: "first\n</function>\nlast" },
  );
  assert.deepEqual(
    parseToolArgs(JSON.stringify({ newText: "<parameter>example</parameter>\nsomething" })),
    { newText: "<parameter>example</parameter>\nsomething" },
  );
  // A marker in an inner string of a nested object is interior content too.
  assert.deepEqual(
    parseToolArgs(JSON.stringify({ outer: { inner: "a</tool_call>b" }, n: 2 })),
    { outer: { inner: "a</tool_call>b" }, n: 2 },
  );
});

test("parseToolArgs: a leaked tail after legitimate interior markers is still stripped", () => {
  assert.deepEqual(
    parseToolArgs(JSON.stringify({ command: "cat x\n</function>\necho hi\n</parameter>" })),
    { command: "cat x\n</function>\necho hi\n</parameter>" },
    "without repair the trailing marker survives (default is verbatim)",
  );
  assert.deepEqual(
    parseToolArgs(JSON.stringify({ command: "cat x\n</function>\necho hi\n</parameter>" }), {
      repairLeakedProtocol: true,
    }),
    { command: "cat x\n</function>\necho hi" },
  );
});

test("parseToolArgs: leak repair stays fast on long whitespace/newline runs", () => {
  // The repair grammar once scanned superlinearly: an 8k-space run took
  // ~1s and 32k ~20s (regex forms re-scanning at every start index). A
  // malformed stream must never stall the event loop — bound the cost.
  const ws = (n: number) =>
    JSON.stringify({ content: " ".repeat(n) + "x" }).slice(0, -1) +
    " ".repeat(n) +
    "</parameter>";
  const nl = (n: number) =>
    JSON.stringify({ content: "x\n</parameter>" + "\n".repeat(n) + "x" }).slice(0, -1);
  const t0 = performance.now();
  for (const n of [8000, 32000]) {
    parseToolArgs(ws(n), { repairLeakedProtocol: true });
    parseToolArgs(nl(n), { repairLeakedProtocol: true });
  }
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 1500, "repair on 8k/32k whitespace runs took " + elapsed.toFixed(0) + "ms");
});

test("parseToolArgs: eaten-quote chains recover up to the 64-marker bound", () => {
  // The bounded grammar caps chains at 64 separator units (a measured, free
  // bound — see the runRe comment). Chains at and under the bound recover
  // both fields; the audit's 12-marker case stays covered.
  for (const n of [4, 12, 64]) {
    const chain = Array(n).fill("</parameter>").join("\\n");
    assert.deepEqual(
      parseToolArgs(`{"c":"hi\\n${chain},"p":"a"`, { repairLeakedProtocol: true }),
      { c: "hi", p: "a" },
      `${n}-marker eaten chain`,
    );
  }
  // A 65-marker chain exceeds the quoted bound but still recovers both
  // fields: the run match covers the leading portion and the plain-strip
  // pass removes the remaining markers individually.
  assert.deepEqual(
    parseToolArgs('{"c":"hi\\n' + Array(65).fill("</parameter>").join("\\n") + ',"p":"a"', {
      repairLeakedProtocol: true,
    }),
    { c: "hi", p: "a" },
    "65-marker chain still recovers",
  );
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

test("model.headers: sent verbatim with the request (OpenRouter attribution)", async () => {
  const mock = await startMockSse("text");
  try {
    const model: ModelConfig = {
      ...MODEL,
      baseUrl: mock.baseUrl,
      apiKey: "test-key",
      headers: {
        "X-Title": "tre.",
        "HTTP-Referer": "https://github.com/digitalminer26/Tre.-coding-agent",
      },
    };
    await collectStream(openAiStream, model, noToolsCtx(), {
      signal: new AbortController().signal,
    });
    const h = mock.lastHeaders;
    assert.ok(h, "mock captured the request headers");
    assert.equal(h?.["x-title"], "tre.");
    assert.equal(h?.["http-referer"], "https://github.com/digitalminer26/Tre.-coding-agent");
    // The default headers are still present (model.headers merges UNDER them,
    // not replacing the whole header set).
    assert.equal(h?.["content-type"], "application/json");
    assert.ok(String(h?.["authorization"] ?? "").startsWith("Bearer test-key"));
  } finally {
    await mock.close();
  }
});

test("model.headers: absent → no custom headers on the wire", async () => {
  const mock = await startMockSse("text");
  try {
    await collectStream(openAiStream, { ...MODEL, baseUrl: mock.baseUrl }, noToolsCtx(), {
      signal: new AbortController().signal,
    });
    const h = mock.lastHeaders;
    assert.ok(h, "mock captured the request headers");
    assert.equal(h?.["x-title"], undefined);
    assert.equal(h?.["http-referer"], undefined);
  } finally {
    await mock.close();
  }
});
