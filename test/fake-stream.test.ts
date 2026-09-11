/**
 * WS8 — self-tests for fake-stream (the scripted StreamFn).
 * Pins the invariants WS2's loop tests will rely on:
 *   - start first, done last
 *   - every event carries a cumulative `partial` (I2)
 *   - tool-call args accumulate as JSON fragments; final parse is authoritative
 *   - error/aborted/length turns end with the right stopReason (I3)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { collectEvents, fakeStream, type FakeTurn } from "./fake-stream.js";
import type {
  AssistantStreamEvent,
  ModelConfig,
  TextBlock,
  ToolCallBlock,
} from "../src/types.js";

const MODEL: ModelConfig = {
  id: "fake-model",
  provider: "fake",
  baseUrl: "http://fake.invalid/v1",
  api: "openai-completions",
  contextWindow: 32000,
  maxTokens: 4096,
};

function firstAndLast(events: AssistantStreamEvent[]): {
  first: AssistantStreamEvent;
  last: Extract<AssistantStreamEvent, { type: "done" }>;
} {
  assert.ok(events.length > 0, "expected at least one event");
  const first = events[0]!;
  const last = events[events.length - 1]!;
  assert.equal(first.type, "start", "first event must be start");
  assert.equal(last.type, "done", "last event must be done");
  return { first, last: last as Extract<AssistantStreamEvent, { type: "done" }> };
}

test("text turn: start → text_deltas → done, partial accumulates (I2)", async () => {
  const streamFn = fakeStream([{ type: "text", text: "hello world" }]);
  const events = await collectEvents(streamFn, MODEL);
  const { last } = firstAndLast(events);

  const deltas = events.filter(
    (e): e is Extract<AssistantStreamEvent, { type: "text_delta" }> =>
      e.type === "text_delta",
  );
  assert.ok(deltas.length >= 2, "text should be split into multiple deltas");
  assert.equal(deltas.map((d) => d.delta).join(""), "hello world");

  // Every event's partial must be the cumulative message so far.
  let seen = "";
  for (const e of events) {
    const partial =
      e.type === "done" ? e.message : "partial" in e ? e.partial : undefined;
    assert.ok(partial, "every event carries the in-progress message (I2)");
    if (e.type === "text_delta") seen += e.delta;
    const text = partial!.content.find((b): b is TextBlock => b.type === "text");
    assert.equal(text?.text ?? "", seen, "partial text accumulates");
  }

  assert.equal(last.message.stopReason, "stop");
  assert.equal(last.message.model, "fake-model");
  assert.equal(last.message.content.find((b) => b.type === "text")!.text, "hello world");
});

test("toolcall turn: two calls, args arrive as fragments, final parse authoritative", async () => {
  const turns: FakeTurn[] = [
    {
      type: "toolcall",
      calls: [
        { id: "c1", name: "read", args: { path: "a.txt" } },
        { id: "c2", name: "bash", args: { command: "ls -la", timeout: 30 } },
      ],
    },
  ];
  const events = await collectEvents(fakeStream(turns), MODEL);
  const { last } = firstAndLast(events);

  const starts = events.filter(
    (e): e is Extract<AssistantStreamEvent, { type: "toolcall_start" }> =>
      e.type === "toolcall_start",
  );
  assert.equal(starts.length, 2);
  assert.deepEqual(
    starts.map((s) => [s.index, s.id, s.name]),
    [
      [0, "c1", "read"],
      [1, "c2", "bash"],
    ],
  );

  const argDeltas = events.filter(
    (e): e is Extract<AssistantStreamEvent, { type: "toolcall_delta" }> =>
      e.type === "toolcall_delta",
  );
  assert.ok(argDeltas.length >= 4, "each call's args split into fragments");
  // Replaying the raw fragments per index must reconstruct the JSON exactly.
  const byIndex: Record<number, string> = {};
  for (const d of argDeltas) byIndex[d.index] = (byIndex[d.index] ?? "") + d.argsDelta;
  assert.equal(byIndex[0], JSON.stringify({ path: "a.txt" }));
  assert.equal(byIndex[1], JSON.stringify({ command: "ls -la", timeout: 30 }));

  // Done message: authoritative parsed args.
  assert.equal(last.message.stopReason, "toolUse");
  const calls = last.message.content.filter(
    (b): b is ToolCallBlock => b.type === "toolCall",
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.arguments, { path: "a.txt" });
  assert.deepEqual(calls[1]!.arguments, { command: "ls -la", timeout: 30 });
});

test("mid-stream partial arguments are best-effort; final partial is complete", async () => {
  const events = await collectEvents(
    fakeStream([
      { type: "toolcall", calls: [{ name: "write", args: { path: "x", content: "y" } }] },
    ]),
    MODEL,
  );
  const argDeltas = events.filter(
    (e): e is Extract<AssistantStreamEvent, { type: "toolcall_delta" }> =>
      e.type === "toolcall_delta",
  );
  assert.ok(argDeltas.length >= 2, "args should arrive as fragments");
  // After the final fragment the partial must carry the fully-parsed args.
  const lastDelta = argDeltas[argDeltas.length - 1]!;
  const call = lastDelta.partial.content.find(
    (b): b is ToolCallBlock => b.type === "toolCall",
  );
  assert.deepEqual(call!.arguments, { path: "x", content: "y" });
});

test("error turn ends with stopReason error + errorMessage (I3)", async () => {
  const events = await collectEvents(
    fakeStream([{ type: "error", message: "boom" }]),
    MODEL,
  );
  const { last } = firstAndLast(events);
  assert.equal(last.message.stopReason, "error");
  assert.equal(last.message.errorMessage, "boom");
});

test("length turn (truncated tool call) ends with stopReason length", async () => {
  const events = await collectEvents(
    fakeStream([{ type: "length", calls: [{ name: "read", args: { path: "a.txt" } }] }]),
    MODEL,
  );
  const { last } = firstAndLast(events);
  assert.equal(last.message.stopReason, "length");
});

test("abort mid-stream: stream ends with stopReason aborted (I3)", async () => {
  const controller = new AbortController();
  const streamFn = fakeStream([{ type: "text", text: "aaaaaaaaaaaaaaaaaaaaaaaa" }]);
  const events: AssistantStreamEvent[] = [];
  const iter = streamFn(MODEL, { systemPrompt: "", messages: [], tools: [] }, {
    signal: controller.signal,
  });
  for await (const e of iter) {
    events.push(e);
    if (events.length >= 2) controller.abort();
  }
  const last = events[events.length - 1]!;
  assert.equal(last.type, "done");
  if (last.type === "done") assert.equal(last.message.stopReason, "aborted");
});

test("script exhaustion throws (test bug, not a stream error)", async () => {
  const streamFn = fakeStream([{ type: "text", text: "one" }]);
  await collectEvents(streamFn, MODEL); // call 1 ok
  await assert.rejects(
    async () => {
      for await (const _e of streamFn(MODEL, { systemPrompt: "", messages: [], tools: [] }, {
        signal: new AbortController().signal,
      })) {
        void _e;
      }
    },
    /script exhausted/,
  );
});
