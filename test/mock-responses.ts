/**
 * D15 — deterministic fake OpenAI Responses-API SSE server.
 *
 * Plain node:http, zero dependencies. Replays canned Responses SSE streams in
 * the exact wire format (event: response.* + data: {"type":…} frames) so the
 * Responses wire tests can assert the precise `AssistantStreamEvent` sequence
 * without a network. Mirrors test/mock-sse.ts (the chat/completions fake).
 *
 * Scenarios:
 *   "text"        — text reply, output_text.delta split across 3 frames,
 *                   output_item.done (message), completed + usage
 *   "multi-tool"  — two function calls; arguments split across frames (one
 *                   mid-token), output_item.done carries authoritative args,
 *                   completed + usage
 *   "length"      — one function call whose arguments are cut, incomplete
 *                   (reason max_output_tokens)
 *   "failed"      — response.failed with an error message
 *   "http-error"  — non-200 JSON error body (no SSE)
 *
 * The last request body is captured on `lastRequest` for assertions.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type MockResponsesScenario =
  | "text"
  | "multi-tool"
  | "length"
  | "failed"
  | "http-error"
  | "401-then-ok"
  | "401-always";

export interface MockResponses {
  /** e.g. http://127.0.0.1:PORT — use as baseUrl (the wire appends /responses). */
  baseUrl: string;
  /** Parsed body of the most recent request, or null. */
  lastRequest: Record<string, unknown> | null;
  /** The Authorization header of the most recent request, or null. */
  lastAuth: string | null;
  /** Every Authorization header seen, in order (401-retry assertions). */
  authHistory: string[];
  /** Total requests received. */
  requestCount: number;
  close(): Promise<void>;
}

interface SseFrame {
  data: string;
  event?: string;
}

const frame = (type: string, extra: Record<string, unknown> = {}): SseFrame => ({
  event: type,
  data: JSON.stringify({ type, ...extra }),
});

const USAGE = {
  input_tokens: 11,
  output_tokens: 22,
  total_tokens: 33,
  input_tokens_details: { cached_tokens: 5 },
};

function framesFor(
  scenario: MockResponsesScenario,
): SseFrame[] | { status: number; body: string } {
  switch (scenario) {
    case "text":
      return [
        frame("response.created", { response: { id: "resp-1" } }),
        frame("response.output_item.added", {
          item: { type: "message", id: "msg_1", role: "assistant", content: [] },
        }),
        frame("response.output_text.delta", { item_id: "msg_1", delta: "Hel" }),
        frame("response.output_text.delta", { item_id: "msg_1", delta: "lo " }),
        frame("response.output_text.delta", { item_id: "msg_1", delta: "world" }),
        frame("response.output_item.done", {
          item: {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello world" }],
          },
        }),
        frame("response.completed", { response: { id: "resp-1", status: "completed", usage: USAGE } }),
      ];
    case "multi-tool":
      return [
        frame("response.created", { response: { id: "resp-2" } }),
        // call 1
        frame("response.output_item.added", {
          item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read" },
        }),
        frame("response.function_call_arguments.delta", { item_id: "fc_1", delta: "{\"pat" }),
        frame("response.function_call_arguments.delta", { item_id: "fc_1", delta: "h\":\"/a.txt\"}" }),
        frame("response.output_item.done", {
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "read",
            arguments: '{"path":"/a.txt"}',
          },
        }),
        // call 2
        frame("response.output_item.added", {
          item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "write" },
        }),
        frame("response.function_call_arguments.delta", { item_id: "fc_2", delta: '{"content":"hi"}' }),
        frame("response.output_item.done", {
          item: {
            type: "function_call",
            id: "fc_2",
            call_id: "call_2",
            name: "write",
            arguments: '{"content":"hi"}',
          },
        }),
        frame("response.completed", { response: { id: "resp-2", status: "completed", usage: USAGE } }),
      ];
    case "length":
      return [
        frame("response.created", { response: { id: "resp-3" } }),
        frame("response.output_item.added", {
          item: { type: "function_call", id: "fc_3", call_id: "call_3", name: "read" },
        }),
        // arguments cut mid-string — never completed
        frame("response.function_call_arguments.delta", { item_id: "fc_3", delta: '{"path":"/' }),
        frame("response.incomplete", {
          response: {
            id: "resp-3",
            status: "incomplete",
            usage: USAGE,
            incomplete_details: { reason: "max_output_tokens" },
          },
        }),
      ];
    case "failed":
      return [
        frame("response.created", { response: { id: "resp-4" } }),
        frame("response.failed", {
          response: {
            id: "resp-4",
            status: "failed",
            error: { code: "server_error", message: "boom: upstream 500" },
          },
        }),
      ];
    case "http-error":
      return {
        status: 500,
        body: JSON.stringify({ error: { message: "upstream exploded", code: "server_error" } }),
      };
    case "401-then-ok":
      // The server rejects the FIRST request with 401 (stale token); every
      // subsequent request (the retry, with the refreshed token) gets the
      // normal text frames.
      return framesFor("text");
    case "401-always":
      return {
        status: 401,
        body: JSON.stringify({ error: { message: "invalid token", code: "invalid_request_error" } }),
      };
  }
}

export async function startMockResponses(
  scenario: MockResponsesScenario,
): Promise<MockResponses> {
  const lastRequest: { body: Record<string, unknown> | null; auth: string | null } = {
    body: null,
    auth: null,
  };
  const authHistory: string[] = [];
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requestCount++;
      try {
        lastRequest.body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        lastRequest.body = null;
      }
      lastRequest.auth = req.headers.authorization ?? null;
      authHistory.push(lastRequest.auth ?? "");

      // 401-then-ok: the first request is rejected (stale token), the retry
      // (with the refreshed token) succeeds with the normal text frames.
      if (scenario === "401-then-ok" && requestCount === 1) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid token", code: "invalid_request_error" } }));
        return;
      }
      const frames = framesFor(scenario);
      if (typeof frames === "object" && !Array.isArray(frames)) {
        res.writeHead(frames.status, { "content-type": "application/json" });
        res.end(frames.body);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const f of frames) {
        res.write(`event: ${f.event}\ndata: ${f.data}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get lastRequest() {
      return lastRequest.body;
    },
    get lastAuth() {
      return lastRequest.auth;
    },
    get authHistory() {
      return authHistory;
    },
    get requestCount() {
      return requestCount;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close();
        resolve();
      }),
  };
}
