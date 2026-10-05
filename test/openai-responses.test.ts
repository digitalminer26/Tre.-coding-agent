/**
 * D15 — Responses wire: exit-criteria tests against the mock Responses SSE
 * server. Asserts the EXACT AssistantStreamEvent sequence for text and
 * multi-tool replies, plus length/failed/http-error behavior, usage mapping,
 * and Bearer auth (static key + ChatGPT token store). No network beyond
 * 127.0.0.1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockResponses } from "./mock-responses.js";
import {
  buildResponsesParams,
  collectResponsesStream,
  convertToItems,
  openAiResponsesStream,
  responsesUrl,
} from "../src/wire/openai-responses.js";
import {
  __resetTokenRefreshForTests,
  __setTokenRefreshForTests,
  readTokens,
  writeTokens,
} from "../src/auth/token-store.js";
import type {
  AgentMessage,
  AssistantStreamEvent,
  LlmContext,
  ModelConfig,
  ToolCallBlock,
} from "../src/types.js";

const MODEL: ModelConfig = {
  id: "gpt-mock",
  provider: "mock",
  baseUrl: "http://should-be-replaced/v1",
  api: "openai-responses",
  contextWindow: 200000,
  maxTokens: 4096,
  temperature: 0.4,
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

async function run(scenario: Parameters<typeof startMockResponses>[0]) {
  const mock = await startMockResponses(scenario);
  const model = { ...MODEL, baseUrl: mock.baseUrl, apiKey: "static-key" };
  const events = await collectResponsesStream(
    openAiResponsesStream,
    model,
    noToolsCtx(),
    { signal: new AbortController().signal },
  );
  await mock.close();
  return { events, mock, model };
}

test("text reply: exact sequence start → 3 text_deltas → done; usage mapped", async () => {
  const { events, mock } = await run("text");
  assert.deepEqual(typeSeq(events), [
    "start",
    "text_delta",
    "text_delta",
    "text_delta",
    "done",
  ]);
  const done = events[events.length - 1]!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.equal(done.message.stopReason, "stop");
  assert.deepEqual(
    done.message.content,
    [{ type: "text", text: "Hello world" }],
  );
  assert.deepEqual(done.message.usage, {
    input: 11,
    output: 22,
    totalTokens: 33,
    cacheRead: 5,
  });
  // The request carried the right shape + static Bearer.
  assert.equal(mock.lastAuth, "Bearer static-key");
  const body = mock.lastRequest;
  assert.ok(body);
  assert.equal(body!.model, "gpt-mock");
  assert.equal(body!.stream, true);
  assert.equal(body!.instructions, "sys");
  assert.equal(body!.max_output_tokens, 4096);
});

test("multi-tool: two tool calls, args salvaged from split deltas, stopReason toolUse", async () => {
  const { events } = await run("multi-tool");
  const done = events[events.length - 1]!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.equal(done.message.stopReason, "toolUse");
  const calls = done.message.content.filter(
    (b): b is ToolCallBlock => b.type === "toolCall",
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.name, "read");
  assert.deepEqual(calls[0]!.arguments, { path: "/a.txt" });
  assert.equal(calls[1]!.name, "write");
  assert.deepEqual(calls[1]!.arguments, { content: "hi" });
  // The toolcall_delta events carried the raw fragments.
  const deltas = events.filter((e) => e.type === "toolcall_delta");
  assert.equal(deltas.length, 3);
});

test("length: incomplete (max_output_tokens) → stopReason length", async () => {
  const { events } = await run("length");
  const done = events[events.length - 1]!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.equal(done.message.stopReason, "length");
  assert.equal(done.message.usage?.totalTokens, 33);
});

test("failed: response.failed → stopReason error + message", async () => {
  const { events } = await run("failed");
  const done = events[events.length - 1]!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.equal(done.message.stopReason, "error");
  assert.match(done.message.errorMessage ?? "", /boom: upstream 500/);
});

test("http-error: non-200 JSON → stopReason error, no stream", async () => {
  const { events } = await run("http-error");
  const done = events[events.length - 1]!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.equal(done.message.stopReason, "error");
  assert.match(done.message.errorMessage ?? "", /upstream exploded/);
});

test("convertToItems: user/assistant/call/toolResult mapping", () => {
  const asst: AgentMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "let me read it" },
      { type: "toolCall", id: "call_9", name: "read", arguments: { path: "/x" } },
    ],
    model: "m",
    provider: "p",
    stopReason: "toolUse",
    timestamp: 0,
  };
  const result: AgentMessage = {
    role: "toolResult",
    toolCallId: "call_9",
    toolName: "read",
    content: [{ type: "text", text: "file contents" }],
    timestamp: 0,
  };
  const ctx: LlmContext = {
    systemPrompt: "sys",
    messages: [
      { role: "user", content: "read /x", timestamp: 0 },
      asst,
      result,
    ],
    tools: [TOOL],
  };
  assert.deepEqual(convertToItems(ctx), [
    { type: "message", role: "user", content: [{ type: "input_text", text: "read /x" }] },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "let me read it" }],
    },
    { type: "function_call", call_id: "call_9", name: "read", arguments: '{"path":"/x"}' },
    { type: "function_call_output", call_id: "call_9", output: "file contents" },
  ]);
});

test("buildResponsesParams: tools serialized as Responses function tools", () => {
  const params = buildResponsesParams(MODEL, {
    systemPrompt: "sys",
    messages: [{ role: "user", content: "hi", timestamp: 0 }],
    tools: [TOOL],
  });
  assert.deepEqual(params.tools, [
    {
      type: "function",
      name: "read",
      description: "read a file",
      parameters: TOOL.parameters,
    },
  ]);
  assert.equal(responsesUrl("http://h:1/v1/"), "http://h:1/v1/responses");
});

// ─────────────── auth: ChatGPT token store (mock file, no network) ───────────────

test("auth: chatgpt-oauth resolves the stored access token (unexpired)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-resp-auth-"));
  const file = path.join(dir, "auth.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeTokens(
    {
      accessToken: "AT-live",
      refreshToken: "RT",
      expiresAt: Date.now() + 3_600_000,
      savedAt: Date.now(),
    },
    file,
  );
  const prev = process.env.TRE_CHATGPT_AUTH;
  process.env.TRE_CHATGPT_AUTH = file;
  try {
    const mock = await startMockResponses("text");
    const model: ModelConfig = {
      ...MODEL,
      baseUrl: mock.baseUrl,
      auth: "chatgpt-oauth",
    };
    const events = await collectResponsesStream(
      openAiResponsesStream,
      model,
      noToolsCtx(),
      { signal: new AbortController().signal },
    );
    await mock.close();
    assert.equal(mock.lastAuth, "Bearer AT-live");
    assert.equal(events[events.length - 1]!.type, "done");
  } finally {
    if (prev === undefined) delete process.env.TRE_CHATGPT_AUTH;
    else process.env.TRE_CHATGPT_AUTH = prev;
  }
});

test("auth: no login on record → clean done(error) naming the fix", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-resp-noauth-"));
  const file = path.join(dir, "absent.json"); // never written
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Point the token store at the empty file via env.
  const prev = process.env.TRE_CHATGPT_AUTH;
  process.env.TRE_CHATGPT_AUTH = file;
  try {
    const model: ModelConfig = { ...MODEL, auth: "chatgpt-oauth" };
    const events = await collectResponsesStream(
      openAiResponsesStream,
      model,
      noToolsCtx(),
      { signal: new AbortController().signal },
    );
    const done = events[events.length - 1]!;
    assert.equal(done.type, "done");
    if (done.type !== "done") return;
    assert.equal(done.message.stopReason, "error");
    assert.match(done.message.errorMessage ?? "", /tre\. login chatgpt/);
  } finally {
    if (prev === undefined) delete process.env.TRE_CHATGPT_AUTH;
    else process.env.TRE_CHATGPT_AUTH = prev;
  }
});

// ─────────────── 401 → force-refresh → retry (stale unexpired token) ───────────────

/**
 * Point the token store at a temp file and the wire's forced refresh at a
 * mock endpoint (no network). Returns the file + cleanup.
 */
function authFixture(t: { after(fn: () => void): void }): { file: string; prev: string | undefined } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tre-resp-401-"));
  const file = path.join(dir, "auth.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    __resetTokenRefreshForTests();
  });
  const prev = process.env.TRE_CHATGPT_AUTH;
  process.env.TRE_CHATGPT_AUTH = file;
  return { file, prev };
}

test("auth: 401 on a stale unexpired token → force-refresh + retry once, success", async (t) => {
  const { file, prev } = authFixture(t);
  t.after(() => {
    if (prev === undefined) delete process.env.TRE_CHATGPT_AUTH;
    else process.env.TRE_CHATGPT_AUTH = prev;
  });
  // Stored token is NOMINALLY unexpired (the 401 means the server rejected
  // it anyway) — the bug this fixes.
  writeTokens(
    { accessToken: "AT-stale", refreshToken: "RT", expiresAt: Date.now() + 3_600_000, savedAt: Date.now() },
    file,
  );
  // Mock the token endpoint the wire's forced refresh will hit.
  let refreshCalls = 0;
  const mockFetch = (async () => {
    refreshCalls++;
    return new Response(
      JSON.stringify({ access_token: "AT-fresh", refresh_token: "RT2", expires_in: 3600 }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  __setTokenRefreshForTests({ tokenUrl: "http://127.0.0.1:1/token", fetchImpl: mockFetch });

  const mock = await startMockResponses("401-then-ok");
  try {
    const model: ModelConfig = { ...MODEL, baseUrl: mock.baseUrl, auth: "chatgpt-oauth" };
    const events = await collectResponsesStream(
      openAiResponsesStream,
      model,
      noToolsCtx(),
      { signal: new AbortController().signal },
    );
    const done = events[events.length - 1]!;
    assert.equal(done.type, "done");
    if (done.type !== "done") return;
    assert.equal(done.message.stopReason, "stop");
    // Exactly two requests: the 401, then the retry with the fresh token.
    assert.equal(mock.requestCount, 2);
    assert.deepEqual(mock.authHistory, ["Bearer AT-stale", "Bearer AT-fresh"]);
    // The forced refresh fired exactly once and rotated the stored token.
    assert.equal(refreshCalls, 1);
    assert.equal(readTokens(file)!.accessToken, "AT-fresh");
  } finally {
    await mock.close();
  }
});

test("auth: 401 with a dead refresh token → clean done(error), no infinite loop", async (t) => {
  const { file, prev } = authFixture(t);
  t.after(() => {
    if (prev === undefined) delete process.env.TRE_CHATGPT_AUTH;
    else process.env.TRE_CHATGPT_AUTH = prev;
  });
  writeTokens(
    { accessToken: "AT-stale", refreshToken: "RT", expiresAt: Date.now() + 3_600_000, savedAt: Date.now() },
    file,
  );
  // The refresh is rejected (4xx) → AuthRequiredError (re-login needed).
  const mockFetch = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
  __setTokenRefreshForTests({ tokenUrl: "http://127.0.0.1:1/token", fetchImpl: mockFetch });

  const mock = await startMockResponses("401-always");
  try {
    const model: ModelConfig = { ...MODEL, baseUrl: mock.baseUrl, auth: "chatgpt-oauth" };
    const events = await collectResponsesStream(
      openAiResponsesStream,
      model,
      noToolsCtx(),
      { signal: new AbortController().signal },
    );
    const done = events[events.length - 1]!;
    assert.equal(done.type, "done");
    if (done.type !== "done") return;
    assert.equal(done.message.stopReason, "error");
    // The refresh was attempted (and rejected) — the error names the fix.
    assert.match(done.message.errorMessage ?? "", /tre\. login chatgpt/);
    // No infinite retry: the 401 was hit, a refresh was attempted, then it
    // gave up (no third request to the model).
    assert.equal(mock.requestCount, 1);
  } finally {
    await mock.close();
  }
});

test("auth: 401 on a static-key model is NOT retried (no token store)", async (t) => {
  const mock = await startMockResponses("401-always");
  try {
    // No `auth: "chatgpt-oauth"` → static key path → a 401 is a plain error.
    const model: ModelConfig = { ...MODEL, baseUrl: mock.baseUrl, apiKey: "static-key" };
    const events = await collectResponsesStream(
      openAiResponsesStream,
      model,
      noToolsCtx(),
      { signal: new AbortController().signal },
    );
    const done = events[events.length - 1]!;
    assert.equal(done.type, "done");
    if (done.type !== "done") return;
    assert.equal(done.message.stopReason, "error");
    // sseStream retries 401? No — 401 is not retryable, so exactly one request.
    assert.equal(mock.requestCount, 1);
  } finally {
    await mock.close();
  }
});
