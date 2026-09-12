/**
 * WS1 — LIVE endpoint test (final integration gate; NOT the unit-test basis).
 *
 * Skipped unless RUN_LIVE=1. Runs against the local llama.cpp server from
 * models.json (default: TKG vks-llama):
 *   1. streams a real text reply (token deltas observed)
 *   2. makes a real tool call (toolcall events + parsed args)
 *
 * Note: the dev model is a *thinking* model (Qwen) — `reasoning_content`
 * chunks arrive before the visible reply, so maxTokens here is generous and
 * the tests tolerate thinking_delta events.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  completionsUrl,
  openAiStream,
} from "../src/wire/openai-completions.js";
import { loadModelsFile, resolveModel } from "../src/config/models.js";
import type { AgentMessage, Tool, ToolCallBlock } from "../src/types.js";

function liveModel() {
  const path = resolve(process.cwd(), "models.json");
  if (!existsSync(path)) throw new Error("models.json not found in cwd");
  const file = loadModelsFile(path);
  const model = resolveModel(file);
  // Thinking models burn budget on reasoning_content before visible output.
  return { ...model, maxTokens: Math.max(model.maxTokens, 8192) };
}

const BASH_TOOL: Tool = {
  name: "bash",
  description: "Run a shell command and return its output.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", description: "the command" } },
    required: ["command"],
  },
  execute: async () => ({ content: [{ type: "text", text: "(not executed in this test)" }] }),
};

test("live: streams a real text reply end to end", { timeout: 200_000 }, async (t) => {
  if (process.env.RUN_LIVE !== "1") {
    t.skip("set RUN_LIVE=1 to run against the live endpoint");
    return;
  }
  const model = liveModel();
  const ctx: Parameters<typeof openAiStream>[1] = {
    systemPrompt: "You are a terse assistant.",
    messages: [
      { role: "user", content: "Reply with exactly the word: ping", timestamp: Date.now() },
    ] as AgentMessage[],
    tools: [],
  };
  let deltas = 0;
  let thinking = 0;
  for await (const e of openAiStream(model, ctx, {
    signal: AbortSignal.timeout(180_000),
  })) {
    if (e.type === "text_delta") deltas += 1;
    if (e.type === "thinking_delta") thinking += 1;
    if (e.type === "done") {
      assert.equal(e.message.stopReason, "stop");
      const text = e.message.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      assert.ok(text.length > 0, "expected visible text");
      assert.match(text.toLowerCase(), /ping/);
      assert.ok(e.message.usage, "usage reported");
    }
  }
  assert.ok(deltas > 0, "expected streamed text deltas");
  assert.ok(thinking >= 0);
  // eslint-disable-next-line no-console
  console.log(`[live] text ok (deltas=${deltas}, thinking=${thinking}) → ${completionsUrl(model.baseUrl)}`);
});

test("live: makes a real tool call end to end", { timeout: 200_000 }, async (t) => {
  if (process.env.RUN_LIVE !== "1") {
    t.skip("set RUN_LIVE=1 to run against the live endpoint");
    return;
  }
  const model = liveModel();
  const ctx: Parameters<typeof openAiStream>[1] = {
    systemPrompt:
      "You are a coding agent. To answer, use the bash tool to run the requested command. Call the tool; do not answer from memory.",
    messages: [
      { role: "user", content: 'Run the command: echo "tool-call-works"', timestamp: Date.now() },
    ],
    tools: [BASH_TOOL],
  };
  let sawToolcallStart = false;
  for await (const e of openAiStream(model, ctx, {
    signal: AbortSignal.timeout(180_000),
  })) {
    if (e.type === "toolcall_start") sawToolcallStart = true;
    if (e.type === "done") {
      assert.equal(e.message.stopReason, "toolUse");
      const call = e.message.content.find((b): b is ToolCallBlock => b.type === "toolCall");
      assert.ok(call, "expected a tool call in the final message");
      assert.equal(call.name, "bash");
      assert.ok(typeof call.arguments.command === "string" && call.arguments.command.length > 0);
      assert.match(call.arguments.command as string, /echo/);
    }
  }
  assert.ok(sawToolcallStart, "expected toolcall_start event");
  // eslint-disable-next-line no-console
  console.log("[live] tool call ok");
});
