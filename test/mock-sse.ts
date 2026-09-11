/**
 * WS8 — deterministic fake OpenAI-compatible chat/completions SSE server.
 *
 * Plain node:http, zero dependencies. Replays canned SSE streams in the exact
 * OpenAI wire format (data: {...}\n\n frames, tool_calls argument fragments,
 * usage chunk, [DONE]) so WS1's wire tests can assert the precise
 * `AssistantStreamEvent` sequence without a network.
 *
 * Scenarios:
 *   "text"         — text reply, content split across 3 frames, finish "stop"
 *   "multi-tool"   — two tool calls; argument JSON split across frames
 *                    (one split mid-token), finish "tool_calls", usage chunk
 *   "length"       — one tool call whose argument JSON is cut mid-string,
 *                    finish "length"
 *   "http-error"   — non-200 JSON error body (no SSE)
 *   "stream-error" — SSE starts, one content frame, then an inline
 *                    {"error": ...} data frame and the connection closes
 *
 * The last request body is captured on `lastRequest` for assertions.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type MockSseScenario =
  | "text"
  | "multi-tool"
  | "length"
  | "http-error"
  | "stream-error";

export interface MockSse {
  /** e.g. http://127.0.0.1:PORT — use as baseUrl, append /chat/completions. */
  baseUrl: string;
  /** Parsed body of the most recent request, or null. */
  lastRequest: Record<string, unknown> | null;
  close(): Promise<void>;
}

interface SseFrame {
  /** Raw payload of one `data:` frame (string, usually JSON). */
  data: string;
  /** Optional `event:` name for the frame. */
  event?: string;
  /** Pause this many ms before the frame (0 = none). */
  delayMs?: number;
}

const base = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "chatcmpl-mock",
  object: "chat.completion.chunk",
  created: 1700000000,
  model: "mock-model",
  system_fingerprint: "mock",
  ...extra,
});

const delta = (index: number, d: Record<string, unknown>, finish?: string): SseFrame => ({
  data: JSON.stringify(
    base({ choices: [{ index, delta: d, finish_reason: finish ?? null }] }),
  ),
});

const usageFrame = (usage: Record<string, unknown>): SseFrame => ({
  data: JSON.stringify(
    base({ choices: [], usage }),
  ),
});

const DONE: SseFrame = { data: "[DONE]" };

const USAGE = {
  prompt_tokens: 11,
  completion_tokens: 22,
  total_tokens: 33,
};

function framesFor(scenario: MockSseScenario): SseFrame[] | { status: number; body: string } {
  switch (scenario) {
    case "text":
      return [
        delta(0, { role: "assistant", content: "" }),
        delta(0, { content: "Hel" }),
        delta(0, { content: "lo " }),
        delta(0, { content: "world" }),
        delta(0, {}, "stop"),
        usageFrame(USAGE),
        DONE,
      ];
    case "multi-tool": {
      // call 1: read { path: "a.txt" }  — argument split mid-token
      const args1 = JSON.stringify({ path: "a.txt" });
      const mid = 8; // '{"path":"a' | '.txt"}'
      const call1: SseFrame[] = [
        delta(0, { role: "assistant", content: "" }),
        delta(0, {
          tool_calls: [
            { index: 0, id: "call_abc123", type: "function", function: { name: "read", arguments: "" } },
          ],
        }),
        delta(0, { tool_calls: [{ index: 0, function: { arguments: args1.slice(0, mid) } }] }),
        delta(0, { tool_calls: [{ index: 0, function: { arguments: args1.slice(mid) } }] }),
      ];
      // call 2: bash { command: "ls -la", timeout: 30 } — split into 3 fragments
      const args2 = JSON.stringify({ command: "ls -la", timeout: 30 });
      const t1 = Math.floor(args2.length / 3);
      const t2 = Math.floor((2 * args2.length) / 3);
      const call2: SseFrame[] = [
        delta(0, {
          tool_calls: [
            { index: 1, id: "call_def456", type: "function", function: { name: "bash", arguments: "" } },
          ],
        }),
        delta(0, { tool_calls: [{ index: 1, function: { arguments: args2.slice(0, t1) } }] }),
        delta(0, { tool_calls: [{ index: 1, function: { arguments: args2.slice(t1, t2) } }] }),
        delta(0, { tool_calls: [{ index: 1, function: { arguments: args2.slice(t2) } }] }),
      ];
      return [...call1, ...call2, delta(0, {}, "tool_calls"), usageFrame(USAGE), DONE];
    }
    case "length": {
      // Argument JSON cut mid-string: model hit the output token cap.
      const truncated = '{"path":"a.tx'; // missing closing quote + brace
      return [
        delta(0, { role: "assistant", content: "" }),
        delta(0, {
          tool_calls: [
            { index: 0, id: "call_cut999", type: "function", function: { name: "read", arguments: "" } },
          ],
        }),
        delta(0, { tool_calls: [{ index: 0, function: { arguments: truncated } }] }),
        delta(0, {}, "length"),
        DONE,
      ];
    }
    case "http-error":
      return {
        status: 400,
        body: JSON.stringify({
          error: {
            message: "Invalid request: max_tokens must be positive",
            type: "invalid_request_error",
            code: "invalid_request",
          },
        }),
      };
    case "stream-error":
      return [
        delta(0, { role: "assistant", content: "" }),
        delta(0, { content: "partial " }),
        {
          data: JSON.stringify({
            error: {
              message: "simulated upstream failure",
              type: "server_error",
              code: null,
            },
          }),
        },
      ];
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export async function startMockSse(
  scenario: MockSseScenario = "text",
): Promise<MockSse> {
  const state: { lastRequest: Record<string, unknown> | null } = { lastRequest: null };

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    const raw = await readBody(req);
    try {
      state.lastRequest = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      state.lastRequest = null;
    }

    const frames = framesFor(scenario);
    if ("status" in frames) {
      res.writeHead(frames.status, { "content-type": "application/json" });
      res.end(frames.body);
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const f of frames) {
      if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
      res.write((f.event ? `event: ${f.event}\n` : "") + `data: ${f.data}\n\n`);
    }
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get lastRequest() {
      return state.lastRequest;
    },
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/**
 * Parse a raw SSE body into data-frame payloads (test helper; mirrors what the
 * real wire parser must handle: multiple `data:` lines per event block are
 * joined with "\n", "event:" lines are namespaced).
 */
export function parseSseFrames(raw: string): { event?: string; data: string }[] {
  const out: { event?: string; data: string }[] = [];
  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) out.push({ event, data: dataLines.join("\n") });
  }
  return out;
}
