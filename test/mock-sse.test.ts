/**
 * WS8 — self-tests for the mock SSE server (fixture pinning).
 * These tests assert the RAW wire format of each scenario, so WS1's parser
 * tests can build on a stable, known-correct fixture set.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startMockSse, parseSseFrames, type MockSseScenario } from "./mock-sse.js";

async function postSse(
  baseUrl: string,
  body: Record<string, unknown> = { model: "mock-model", stream: true },
): Promise<{ status: number; raw: string }> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  return { status: res.status, raw };
}

const SCENARIOS: MockSseScenario[] = [
  "text",
  "multi-tool",
  "length",
  "http-error",
  "stream-error",
];

test("mock SSE: server starts, captures request, closes cleanly", async () => {
  const mock = await startMockSse("text");
  assert.ok(mock.baseUrl.startsWith("http://127.0.0.1:"));
  await postSse(mock.baseUrl, { model: "m1", stream: true, tools: [] });
  assert.deepEqual(mock.lastRequest, { model: "m1", stream: true, tools: [] });
  await mock.close();
});

test("mock SSE: unknown path → 404", async () => {
  const mock = await startMockSse("text");
  const res = await fetch(`${mock.baseUrl}/nope`, { method: "POST" });
  assert.equal(res.status, 404);
  await mock.close();
});

test("mock SSE: text scenario — 3 content frames, finish stop, usage, [DONE]", async () => {
  const mock = await startMockSse("text");
  const { status, raw } = await postSse(mock.baseUrl);
  await mock.close();
  assert.equal(status, 200);

  const frames = parseSseFrames(raw);
  assert.equal(frames.at(-1)?.data, "[DONE]");
  const chunks = frames
    .filter((f) => f.data !== "[DONE]")
    .map((f) => JSON.parse(f.data) as Record<string, unknown>);
  const contentDeltas = chunks
    .map((c) => (c.choices as { delta: { content?: string } }[])?.[0]?.delta?.content)
    .filter((c): c is string => typeof c === "string");
  assert.equal(contentDeltas.join(""), "Hello world");
  const finishes = chunks
    .map((c) => (c.choices as { finish_reason?: string }[])?.[0]?.finish_reason)
    .filter((f) => f !== null && f !== undefined);
  assert.deepEqual(finishes, ["stop"]);
  assert.ok(chunks.some((c) => c.usage !== undefined), "usage frame present");
});

test("mock SSE: multi-tool scenario — two calls, split args, finish tool_calls", async () => {
  const mock = await startMockSse("multi-tool");
  const { status, raw } = await postSse(mock.baseUrl);
  await mock.close();
  assert.equal(status, 200);

  const frames = parseSseFrames(raw);
  assert.equal(frames.at(-1)?.data, "[DONE]");
  const chunks = frames
    .filter((f) => f.data !== "[DONE]")
    .map((f) => JSON.parse(f.data) as {
      choices: {
        delta: {
          tool_calls?: {
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
        finish_reason?: string | null;
      }[];
    });

  // Reassemble per tool-call index, exactly as a real parser would.
  const names: Record<number, string> = {};
  const ids: Record<number, string> = {};
  const args: Record<number, string> = {};
  for (const c of chunks) {
    for (const tc of c.choices[0]?.delta?.tool_calls ?? []) {
      if (tc.function?.name) names[tc.index] = tc.function.name;
      if (tc.id) ids[tc.index] = tc.id;
      if (tc.function?.arguments) args[tc.index] = (args[tc.index] ?? "") + tc.function.arguments;
    }
  }
  assert.deepEqual(
    [names[0], names[1]],
    ["read", "bash"],
  );
  assert.deepEqual(
    [ids[0], ids[1]],
    ["call_abc123", "call_def456"],
  );
  assert.equal(args[0], JSON.stringify({ path: "a.txt" }));
  assert.equal(args[1], JSON.stringify({ command: "ls -la", timeout: 30 }));

  const finish = chunks
    .map((c) => c.choices[0]?.finish_reason)
    .find((f) => f !== null && f !== undefined);
  assert.equal(finish, "tool_calls");
});

test("mock SSE: length scenario — arg JSON cut mid-string, finish length", async () => {
  const mock = await startMockSse("length");
  const { raw } = await postSse(mock.baseUrl);
  await mock.close();

  const chunks = parseSseFrames(raw)
    .filter((f) => f.data !== "[DONE]")
    .map((f) => JSON.parse(f.data) as {
      choices: {
        delta: { tool_calls?: { function?: { arguments?: string } }[] };
        finish_reason?: string | null;
      }[];
    });
  const args = chunks
    .flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])
    .map((tc) => tc.function?.arguments ?? "")
    .join("");
  assert.ok(args.length > 0);
  assert.throws(() => JSON.parse(args), "truncated args must not be valid JSON");
  const finish = chunks
    .map((c) => c.choices[0]?.finish_reason)
    .find((f) => f !== null && f !== undefined);
  assert.equal(finish, "length");
});

test("mock SSE: http-error scenario — 400 JSON error body", async () => {
  const mock = await startMockSse("http-error");
  const { status, raw } = await postSse(mock.baseUrl);
  await mock.close();
  assert.equal(status, 400);
  const body = JSON.parse(raw) as { error: { message: string; type: string } };
  assert.ok(body.error.message.includes("Invalid request"));
  assert.equal(body.error.type, "invalid_request_error");
});

test("mock SSE: stream-error scenario — content frame then inline error frame", async () => {
  const mock = await startMockSse("stream-error");
  const { status, raw } = await postSse(mock.baseUrl);
  await mock.close();
  assert.equal(status, 200, "stream starts OK, fails mid-stream");

  const frames = parseSseFrames(raw);
  assert.ok(!raw.includes("[DONE]"), "no [DONE] after an error");
  const errorFrame = frames.find((f) => f.data.includes('"error"'));
  assert.ok(errorFrame, "inline error frame present");
  const err = JSON.parse(errorFrame!.data) as { error: { message: string; type: string } };
  assert.equal(err.error.type, "server_error");
  assert.ok(err.error.message.includes("simulated upstream failure"));
});

test("mock SSE: all scenarios start and close without leaking the port", async () => {
  for (const scenario of SCENARIOS) {
    const mock = await startMockSse(scenario);
    await postSse(mock.baseUrl).catch(() => undefined);
    await mock.close();
  }
});
