/**
 * D15 — wire dispatcher: the "don't pin the model at startup" guarantee.
 *
 * Proves the SAME dispatcher instance routes each call to the wire matching
 * the CURRENT model's `api` — so a mid-session `/models` switch (local
 * chat/completions ↔ ChatGPT Responses) changes the wire with no restart.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeStreamDispatcher } from "../src/wire/dispatcher.js";
import type { AssistantStreamEvent, LlmContext, ModelConfig } from "../src/types.js";

const done = (tag: string): AssistantStreamEvent => ({
  type: "done",
  message: {
    role: "assistant",
    content: [{ type: "text", text: tag }],
    model: "m",
    provider: "p",
    stopReason: "stop",
    timestamp: 0,
  },
});

const ctx: LlmContext = { systemPrompt: "s", messages: [], tools: [] };
const opts = { signal: new AbortController().signal };

const completionsModel: ModelConfig = {
  id: "local", provider: "llama", baseUrl: "http://x/v1",
  api: "openai-completions", contextWindow: 8000, maxTokens: 512, temperature: 0.2,
};
const responsesModel: ModelConfig = {
  id: "chatgpt", provider: "openai", baseUrl: "http://y/v1",
  api: "openai-responses", auth: "chatgpt-oauth", contextWindow: 200000, maxTokens: 4096, temperature: 0.4,
};

async function* fake(tag: string, seen: string[]): AsyncGenerator<AssistantStreamEvent> {
  seen.push(tag);
  yield done(tag);
}

test("dispatcher routes by the CURRENT model's api, per call (no startup pin)", async () => {
  const seen: string[] = [];
  const streamFn = makeStreamDispatcher(
    (m, c, o) => fake("completions", seen),
    (m, c, o) => fake("responses", seen),
  );

  // Call 1: local model → completions wire.
  const e1 = await (async () => {
    const it = streamFn(completionsModel, ctx, opts)[Symbol.asyncIterator]();
    const r = await it.next();
    return r.value;
  })();
  assert.equal(e1!.type, "done");
  assert.deepEqual(seen, ["completions"]);

  // Call 2: SAME dispatcher, now a Responses model → responses wire.
  const e2 = await (async () => {
    const it = streamFn(responsesModel, ctx, opts)[Symbol.asyncIterator]();
    const r = await it.next();
    return r.value;
  })();
  assert.equal(e2!.type, "done");
  assert.deepEqual(seen, ["completions", "responses"]);

  // Call 3: back to completions — the wire follows the model every time.
  await (async () => {
    const it = streamFn(completionsModel, ctx, opts)[Symbol.asyncIterator]();
    await it.next();
  })();
  assert.deepEqual(seen, ["completions", "responses", "completions"]);
});

test("dispatcher: unknown api falls through to the completions wire (default)", async () => {
  const seen: string[] = [];
  const streamFn = makeStreamDispatcher(
    (m, c, o) => fake("completions", seen),
    (m, c, o) => fake("responses", seen),
  );
  const odd = { ...completionsModel, api: "something-else" } as unknown as ModelConfig;
  await (async () => {
    const it = streamFn(odd, ctx, opts)[Symbol.asyncIterator]();
    await it.next();
  })();
  assert.deepEqual(seen, ["completions"]);
});

test("dispatcher: affinity key injects into every completions call, never responses", async () => {
  const got: Array<{ api: string; key: string | undefined }> = [];
  const streamFn = makeStreamDispatcher(
    (m, c, o) => {
      got.push({ api: "completions", key: c.affinityKey });
      return fake("c", []);
    },
    (m, c, o) => {
      got.push({ api: "responses", key: c.affinityKey });
      return fake("r", []);
    },
    "tre-session-42",
  );
  await (async () => {
    const it = streamFn(completionsModel, ctx, opts)[Symbol.asyncIterator]();
    await it.next();
  })();
  await (async () => {
    const it = streamFn(responsesModel, ctx, opts)[Symbol.asyncIterator]();
    await it.next();
  })();
  // A dispatcher-built key always wins over any key the context carries:
  // every completions call from this process — including the compaction
  // summarizer, which builds its own context — pins to the same slot.
  await (async () => {
    const it = streamFn(completionsModel, { ...ctx, affinityKey: "inner" }, opts)[Symbol.asyncIterator]();
    await it.next();
  })();
  assert.deepEqual(got, [
    { api: "completions", key: "tre-session-42" },
    { api: "responses", key: undefined }, // Responses wire never sees the local key
    { api: "completions", key: "tre-session-42" }, // dispatcher key wins
  ]);
});
