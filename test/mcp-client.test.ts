/**
 * MCP client tests — the dual-era JSON-RPC transport (scope §4.2/§4.4).
 *
 * Uses the mock transport (test/mock-transport.ts): no child process.
 * Covers: era probe (modern/legacy/fatal rows), envelope validation,
 * id-multiplexing, pagination, tools/call mapping, abort, admission
 * classes, the stall deadline, and teardown.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  McpClient,
  MCP_CLIENT_VERSION,
  MCP_LEGACY_VERSION,
  MCP_ERR_UNSUPPORTED_VERSION,
  MCP_ERR_METHOD_NOT_FOUND,
} from "../src/mcp/client.js";
import { MockMcpServer } from "./mock-transport.js";
import type { InboundLine } from "./mock-transport.js";

const FAST = {
  callTimeoutMs: 1500,
  probeTimeoutMs: 300,
  startupBudgetMs: 2500,
  stallMs: 200,
};

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

/** A mock that answers a modern probe + tools/list (ready in ~2 ticks). */
function modernMock(
  mock: MockMcpServer,
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [
    { name: "read_file", description: "read", inputSchema: { type: "object" } },
  ],
): void {
  mock.onInbound((l) => {
    const id = l.obj.id as number;
    if (l.obj.method === "server/discover") {
      mock.respondResult(id, {
        resultType: "discovery",
        supportedVersions: [MCP_CLIENT_VERSION],
      });
    } else if (l.obj.method === "tools/list") {
      mock.respondResult(id, { tools });
    }
  });
}

/** A mock that answers the probe with a legacy error + initialize + tools/list. */
function legacyMock(
  mock: MockMcpServer,
  tools: Array<{ name: string }> = [{ name: "ping" }],
  probeError = MCP_ERR_METHOD_NOT_FOUND,
): void {
  mock.onInbound((l) => {
    const id = l.obj.id as number;
    if (l.obj.method === "server/discover") {
      mock.respondError(id, probeError, "unknown method");
    } else if (l.obj.method === "initialize") {
      mock.respondResult(id, {
        protocolVersion: MCP_LEGACY_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "mock", version: "1" },
      });
    } else if (l.obj.method === "tools/list") {
      mock.respondResult(id, { tools });
    }
  });
}

/** A mock that answers tools/call with a handler (per line, once). */
function callMock(
  mock: MockMcpServer,
  handler: (l: InboundLine, id: number) => void,
): void {
  mock.onInbound((l) => {
    if (l.obj.method === "tools/call") {
      handler(l, l.obj.id as number);
    }
  });
}

test("modern era: probe → tools/list, no initialize", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  const tools = await c.start();
  assert.equal(c.getState().state, "ready");
  assert.equal(c.getState().era, "modern");
  assert.deepEqual(
    tools.map((t) => t.name),
    ["read_file"],
  );
  // The probe was a single JSON line with the exact envelope.
  const probe = mock.lineFor("server/discover");
  assert.ok(probe, "probe sent");
  assert.ok(mock.isSingleLine(probe.raw), "probe is one line");
  const meta = (probe.obj.params as Record<string, unknown>)._meta as Record<string, unknown>;
  assert.equal(meta["io.modelcontextprotocol/protocolVersion"], MCP_CLIENT_VERSION);
  assert.ok(meta["io.modelcontextprotocol/clientCapabilities"], "clientCapabilities present");
  assert.ok(meta["io.modelcontextprotocol/clientInfo"], "clientInfo present");
  // NO initialize on the modern path.
  assert.equal(mock.lineFor("initialize"), undefined, "no initialize");
  // The modern tools/list carries the _meta envelope.
  const tl = mock.lineFor("tools/list");
  assert.ok(tl, "tools/list sent");
  assert.ok((tl.obj.params as Record<string, unknown>)._meta, "tools/list has _meta");
  c.close();
});

test("legacy era: probe -32601 → initialize handshake → tools/list", async () => {
  const mock = new MockMcpServer();
  legacyMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  assert.equal(c.getState().era, "legacy");
  const init = mock.lineFor("initialize");
  assert.ok(init, "initialize sent");
  assert.equal(
    (init.obj.params as Record<string, unknown>).protocolVersion,
    MCP_LEGACY_VERSION,
  );
  assert.deepEqual(
    (init.obj.params as Record<string, unknown>).capabilities,
    {},
    "tier 1 advertises NO capabilities",
  );
  // The initialized notification was sent (best-effort).
  assert.ok(mock.lineFor("notifications/initialized"), "initialized sent");
  // The legacy tools/list has NO _meta envelope.
  const tl = mock.lineFor("tools/list");
  assert.ok(tl);
  assert.equal(
    (tl.obj.params as Record<string, unknown>)._meta,
    undefined,
    "no _meta on legacy",
  );
  c.close();
});

test("legacy era: probe -32602 also falls back (not keyed to one code)", async () => {
  const mock = new MockMcpServer();
  legacyMock(mock, [{ name: "x" }], -32602);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  assert.equal(c.getState().era, "legacy");
  c.close();
});

test("modern era: -32022 → ONE bounded retry with a supported version", async () => {
  const mock = new MockMcpServer();
  let probes = 0;
  mock.onInbound((l) => {
    const id = l.obj.id as number;
    if (l.obj.method === "server/discover") {
      probes++;
      if (probes === 1) {
        mock.respondError(id, MCP_ERR_UNSUPPORTED_VERSION, "unsupported", {
          requested: MCP_CLIENT_VERSION,
          supported: ["2025-11-25"],
        });
      } else {
        mock.respondResult(id, {
          resultType: "discovery",
          supportedVersions: ["2025-11-25"],
        });
      }
    } else if (l.obj.method === "tools/list") {
      mock.respondResult(id, { tools: [{ name: "x" }] });
    }
  });
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  assert.equal(c.getState().era, "modern");
  assert.equal(probes, 2, "exactly one retry");
  // The retry probe declared the supported version.
  const probes2 = mock.inbound.filter((l) => l.obj.method === "server/discover");
  assert.equal(probes2.length, 2);
  const retryMeta = (probes2[1]!.obj.params as Record<string, unknown>)._meta as Record<string, unknown>;
  assert.equal(retryMeta["io.modelcontextprotocol/protocolVersion"], "2025-11-25");
  // Later requests carry the negotiated version.
  const tl = mock.lineFor("tools/list");
  assert.ok(tl);
  const tlMeta = (tl.obj.params as Record<string, unknown>)._meta as Record<string, unknown>;
  assert.equal(tlMeta["io.modelcontextprotocol/protocolVersion"], "2025-11-25");
  c.close();
});

test("modern era: a second probe failure is FATAL (not legacy)", async () => {
  const mock = new MockMcpServer();
  let probes = 0;
  mock.onInbound((l) => {
    if (l.obj.method === "server/discover") {
      probes++;
      if (probes === 1) {
        // First probe: -32022 → proves modern (not legacy) and triggers ONE retry.
        mock.respondError(l.obj.id as number, MCP_ERR_UNSUPPORTED_VERSION, "unsupported", {
          requested: MCP_CLIENT_VERSION,
          supported: ["2025-11-25"],
        });
      } else {
        // Retry (second probe): a non-32022 error → FATAL, not legacy fallback.
        mock.respondError(l.obj.id as number, -32603, "server error");
      }
    }
  });
  const c = new McpClient("test", mock.transport, FAST);
  await assert.rejects(c.start());
  assert.equal(c.getState().state, "failed");
  assert.equal(mock.killed, true, "torn down");
  assert.equal(probes, 2, "one retry then fatal");
});

test("FATAL: a valid probe result that fails DiscoverResult validation", async () => {
  const mock = new MockMcpServer();
  mock.onInbound((l) => {
    if (l.obj.method === "server/discover") {
      // No resultType / supportedVersions — invalid discovery document.
      mock.respondResult(l.obj.id as number, { foo: "bar" });
    }
  });
  const c = new McpClient("test", mock.transport, FAST);
  await assert.rejects(c.start(), /invalid DiscoverResult/);
  assert.equal(c.getState().state, "failed");
});

test("FATAL: transport death (EOF) during the probe", async () => {
  const mock = new MockMcpServer();
  mock.onInbound((l) => {
    if (l.obj.method === "server/discover") {
      mock.closeStdout(); // EOF — transport death.
    }
  });
  const c = new McpClient("test", mock.transport, FAST);
  await assert.rejects(c.start(), /transport death/);
  assert.equal(c.getState().state, "failed");
});

test("probe timeout (silence) → legacy fallback", async () => {
  const mock = new MockMcpServer();
  legacyMock(mock, [{ name: "x" }]);
  const c = new McpClient("test", mock.transport, FAST);
  // legacyMock answers the probe with -32601; to model SILENCE, strip the
  // probe answer: re-create a mock that only answers initialize/tools/list.
  const silent = new MockMcpServer();
  silent.onInbound((l) => {
    const id = l.obj.id as number;
    if (l.obj.method === "initialize") {
      silent.respondResult(id, { protocolVersion: MCP_LEGACY_VERSION, capabilities: {} });
    } else if (l.obj.method === "tools/list") {
      silent.respondResult(id, { tools: [{ name: "x" }] });
      // Never answer the probe → it times out → legacy.
    }
  });
  const c2 = new McpClient("test", silent.transport, FAST);
  await c2.start();
  assert.equal(c2.getState().era, "legacy");
  c2.close();
  c.close();
});

test("envelope: a non-matching (late/unknown) response is counted and dropped", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.respondResult(999, { ok: true });
  await tick();
  assert.equal(c.getDiagnostics().lateResponses, 1);
  assert.equal(c.getState().state, "ready", "server stays healthy");
  c.close();
});

test("envelope: a string id never matches our integer id (no coercion)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  const p = c.callTool("read_file", {});
  await tick();
  const call = mock.lineFor("tools/call");
  assert.ok(call);
  // Echo the integer id as a STRING — must NOT match.
  mock.respondResult(String(call.obj.id), { content: [{ type: "text", text: "hi" }] });
  const r = await p;
  assert.equal(r.isError, true, "the string-id response did not match");
  assert.match(r.texts[0] ?? "", /timed out|not running/);
  c.close();
});

test("envelope violation: a line with neither method nor id is terminal", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.sendRawLine('{"jsonrpc":"2.0"}');
  await tick();
  assert.equal(c.getState().state, "failed");
  assert.match(c.getState().reason, /neither method nor id/);
});

test("envelope violation: a response with both result and error is terminal", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.sendRawLine('{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":-1,"message":"x"}}');
  await tick();
  assert.equal(c.getState().state, "failed");
  assert.match(c.getState().reason, /both result and error/);
});

test("envelope violation: a notification with array params is terminal", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.sendRawLine('{"jsonrpc":"2.0","method":"notifications/whatever","params":[1,2]}');
  await tick();
  assert.equal(c.getState().state, "failed");
  assert.match(c.getState().reason, /notification params is not an object/);
});

test("envelope violation: a response with a fractional id is terminal", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.sendRawLine('{"jsonrpc":"2.0","id":1.5,"result":{}}');
  await tick();
  assert.equal(c.getState().state, "failed");
  assert.match(c.getState().reason, /fractional/);
});

test("envelope violation: a request carrying result is terminal", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.sendRawLine('{"jsonrpc":"2.0","id":5,"method":"x","result":{}}');
  await tick();
  assert.equal(c.getState().state, "failed");
  assert.match(c.getState().reason, /request carries result\/error/);
});

test("server request: answered -32601 with the id echoed verbatim", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.sendRequest(77, "sampling/createMessage", { messages: [] });
  await tick();
  const reply = mock.inbound.find((l) => l.obj.id === 77 && l.obj.error);
  assert.ok(reply, "-32601 reply sent");
  assert.equal((reply.obj.error as { code: number }).code, MCP_ERR_METHOD_NOT_FOUND);
  assert.equal(c.getDiagnostics().serverRequestsRejected, 1);
  assert.equal(c.getState().state, "ready", "non-fatal");
  c.close();
});

test("server request: id: null is a request (presence, not truthiness) and is echoed null", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.sendRequest(null, "sampling/createMessage");
  await tick();
  const reply = mock.inbound.find(
    (l) => Object.prototype.hasOwnProperty.call(l.obj, "id") && l.obj.id === null && l.obj.error,
  );
  assert.ok(reply, "reply with id null sent");
  assert.equal(c.getState().state, "ready");
  c.close();
});

test("server→client notifications/cancelled is unmatched and never aborts a call", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  // A slow call (never answered).
  const p = c.callTool("read_file", {});
  await tick();
  const call = mock.lineFor("tools/call");
  assert.ok(call);
  // The server sends a cancellation for the call's id (a collision).
  mock.sendNotification("notifications/cancelled", { requestId: call.obj.id });
  await tick();
  assert.equal(c.getDiagnostics().unmatchedCancelled, 1);
  // The call is NOT aborted — it times out (in-band), not aborted.
  const r = await p;
  assert.equal(r.isError, true);
  assert.match(r.texts[0] ?? "", /timed out/);
  c.close();
});

test("tools/list_changed is recorded (no tier-1 behavior)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.sendNotification("notifications/tools/list_changed");
  await tick();
  assert.equal(c.getDiagnostics().toolListChanged, 1);
  assert.equal(c.getState().state, "ready");
  c.close();
});

test("an unhandled notification is recorded and ignored (never an error)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.sendNotification("notifications/whatever", { x: 1 });
  await tick();
  assert.equal(c.getDiagnostics().unknownNotifications, 1);
  assert.equal(c.getState().state, "ready");
  c.close();
});

test("tools/call: text result maps to texts", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  callMock(mock, (_l, id) =>
    mock.respondResult(id, {
      resultType: "complete",
      content: [{ type: "text", text: "hello" }],
    }),
  );
  const r = await c.callTool("read_file", { path: "a" });
  assert.deepEqual(r.texts, ["hello"]);
  assert.equal(r.isError, false);
  c.close();
});

test("tools/call: structuredContent appended after text blocks", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  callMock(mock, (_l, id) =>
    mock.respondResult(id, {
      resultType: "complete",
      content: [{ type: "text", text: "note" }],
      structuredContent: { a: 1 },
    }),
  );
  const r = await c.callTool("read_file", {});
  assert.equal(r.texts[0], "note");
  assert.ok((r.texts[1] ?? "").startsWith("[structuredContent]\n"), "header present");
  c.close();
});

test("tools/call: structuredContent is the sole payload when content is empty", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  callMock(mock, (_l, id) =>
    mock.respondResult(id, { resultType: "complete", structuredContent: { a: 1 } }),
  );
  const r = await c.callTool("read_file", {});
  assert.equal(r.texts.length, 1);
  assert.equal(r.texts[0], JSON.stringify({ a: 1 }, null, 2), "no header");
  c.close();
});

test("tools/call: input_required is an in-band isError (never success)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  callMock(mock, (_l, id) => mock.respondResult(id, { resultType: "input_required" }));
  const r = await c.callTool("read_file", {});
  assert.equal(r.isError, true);
  assert.match(r.texts[0] ?? "", /input_required/);
  c.close();
});

test("tools/call: a MODERN result missing resultType is an in-band isError (regression)", async () => {
  // Scope §5.5: "Modern ordinary results require resultType: 'complete'".
  // A modern result that omits resultType is a result-payload failure —
  // in-band isError, NOT an envelope violation (the server is NOT torn down).
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  callMock(mock, (_l, id) =>
    mock.respondResult(id, { content: [{ type: "text", text: "hello" }] }),
  );
  const r = await c.callTool("read_file", {});
  assert.equal(r.isError, true);
  assert.match(r.texts[0] ?? "", /resultType/);
  assert.equal(c.getState().state, "ready", "server stays healthy (not torn down)");
  c.close();
});

test("tools/call: a LEGACY result may omit resultType (accepted)", async () => {
  // Scope §5.5: "legacy results may omit it". The same payload that is an
  // error in the modern era is a valid success in the legacy era.
  const mock = new MockMcpServer();
  legacyMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  callMock(mock, (_l, id) =>
    mock.respondResult(id, { content: [{ type: "text", text: "hi" }] }),
  );
  const r = await c.callTool("ping", {});
  assert.equal(r.isError, false);
  assert.deepEqual(r.texts, ["hi"]);
  c.close();
});

test("tools/call: a MODERN result with an unknown resultType is an in-band isError", async () => {
  // Scope §5.5: "a malformed/unknown result type on a tools/call result fails
  // THAT CALL in-band". Present-but-not-"complete" (and not "input_required").
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  callMock(mock, (_l, id) =>
    mock.respondResult(id, {
      resultType: "partial",
      content: [{ type: "text", text: "x" }],
    }),
  );
  const r = await c.callTool("read_file", {});
  assert.equal(r.isError, true);
  assert.match(r.texts[0] ?? "", /unknown resultType/);
  assert.equal(c.getState().state, "ready", "server stays healthy");
  c.close();
});

test("tools/call: a protocol error is an in-band isError (server not torn down)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  callMock(mock, (_l, id) => mock.respondError(id, -32602, "bad args"));
  const r = await c.callTool("read_file", {});
  assert.equal(r.isError, true);
  assert.match(r.texts[0] ?? "", /-32602/);
  assert.equal(c.getState().state, "ready", "server stays healthy");
  c.close();
});

test("tools/call: a malformed result (not an object) is an in-band isError", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  callMock(mock, (_l, id) => mock.respondResult(id, "just a string"));
  const r = await c.callTool("read_file", {});
  assert.equal(r.isError, true);
  assert.match(r.texts[0] ?? "", /malformed/);
  c.close();
});

test("concurrent calls: id-multiplexed pending map (parallel tools/call)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  const delays = [60, 20, 40];
  let i = 0;
  callMock(mock, (_l, id) => {
    const d = delays[i++ % delays.length];
    setTimeout(
      () =>
        mock.respondResult(id, {
          resultType: "complete",
          content: [{ type: "text", text: "n" + id }],
        }),
      d,
    );
  });
  const results = await Promise.all([
    c.callTool("read_file", {}),
    c.callTool("read_file", {}),
    c.callTool("read_file", {}),
  ]);
  assert.equal(results.length, 3);
  for (const r of results) assert.equal(r.isError, false);
  c.close();
});

test("saturation: request #33 is rejected in-band (server stays ready)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  // 32 in-flight calls (never answered).
  for (let k = 0; k < 32; k++) void c.callTool("read_file", {});
  await tick();
  // The 33rd is rejected immediately (busy) — in-band.
  const r = await c.callTool("read_file", {});
  assert.equal(r.isError, true);
  assert.match(r.texts[0] ?? "", /busy/);
  assert.equal(c.getState().state, "ready", "saturation is not a health failure");
  c.close();
});

test("abort: an unsent call is removed and NOT cancelled to the server", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  // Stall the pipe AFTER ready so the next frame is queued but not flushed.
  mock.pauseWrites = true;
  mock.interceptWrites();
  const p = c.callTool("read_file", {});
  await tick();
  assert.equal(c.abortCall("read_file"), true);
  // No notifications/cancelled was sent (the server never saw it).
  assert.equal(mock.lineFor("notifications/cancelled"), undefined, "no cancel sent");
  const r = await p;
  assert.equal(r.isError, true);
  assert.match(r.texts[0] ?? "", /aborted/);
  c.close();
});

test("abort: a write-started call gets a best-effort notifications/cancelled", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  const p = c.callTool("read_file", {});
  await tick(40);
  // The frame was written (write-started).
  const call = mock.lineFor("tools/call");
  assert.ok(call, "the request reached the mock");
  assert.equal(c.abortCall("read_file"), true);
  await tick();
  const cancel = mock.lineFor("notifications/cancelled");
  assert.ok(cancel, "cancelled sent");
  assert.equal((cancel.obj.params as { requestId: number }).requestId, call.obj.id);
  const r = await p;
  assert.equal(r.isError, true);
  assert.match(r.texts[0] ?? "", /aborted/);
  c.close();
});

test("stall: no progress for the deadline at/above 256 KiB → terminal failure", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.pauseWrites = true;
  mock.interceptWrites();
  // Enqueue 32 frames (the pending cap) sized so undrained >= 256 KiB
  // (32 × ~8.3 KiB ≈ 265 KiB). Frames 33+ would be rejected busy.
  const frames = [];
  for (let k = 0; k < 32; k++) {
    frames.push(c.callTool("read_file", { pad: "x".repeat(8000) }));
  }
  await tick(50);
  const stats = c.getStats();
  assert.ok(stats.undrained >= 256 * 1024, "undrained at/above threshold: " + stats.undrained);
  // Wait for the stall deadline (200ms in FAST).
  await tick(400);
  assert.equal(c.getState().state, "failed");
  assert.match(c.getState().reason, /write stall/);
  // All pending calls settled in-band.
  const r = (await frames[0]!);
  assert.equal(r.isError, true);
});

test("stall: a deadline signal (flush) resets the timer (no false trip)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.pauseWrites = true;
  mock.interceptWrites();
  // 32 frames (the pending cap) sized so undrained >= 256 KiB.
  const frames = [];
  for (let k = 0; k < 32; k++) {
    frames.push(c.callTool("read_file", { pad: "x".repeat(8000) }));
  }
  await tick(50);
  assert.ok(c.getStats().undrained >= 256 * 1024);
  // Produce a deadline signal (flush the first frame) well before the
  // 200ms deadline, then let the rest drain — the server must survive.
  mock.pauseWrites = false;
  mock.resumeWrites();
  await tick(300);
  assert.equal(c.getState().state, "ready", "a deadline signal reset the timer");
  // Settle the in-flight calls.
  for (const f of frames) await f;
  c.close();
});

test("teardown: a failed server's later calls fail in-band (not running)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  c.fail("test failure");
  const r = await c.callTool("read_file", {});
  assert.equal(r.isError, true);
  assert.match(r.texts[0] ?? "", /not running/);
});

test("stderr is retained in a bounded ring (tail kept)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.stderr.write("A".repeat(70000));
  await tick();
  const d = c.getDiagnostics();
  assert.ok(d.stderr.length <= 64 * 1024, "ring bounded");
  assert.ok(d.stderr.endsWith("A"), "tail kept");
  c.close();
});

test("startup: tools/list pagination (cursor loop is a startup failure)", async () => {
  const mock = new MockMcpServer();
  mock.onInbound((l) => {
    const id = l.obj.id as number;
    if (l.obj.method === "server/discover") {
      mock.respondResult(id, { resultType: "discovery", supportedVersions: [MCP_CLIENT_VERSION] });
    } else if (l.obj.method === "tools/list") {
      const params = l.obj.params as Record<string, unknown>;
      if (params.cursor === "c1") {
        // Repeat c1 → cursor loop.
        mock.respondResult(id, { tools: [{ name: "b" }], nextCursor: "c1" });
      } else {
        mock.respondResult(id, { tools: [{ name: "a" }], nextCursor: "c1" });
      }
    }
  });
  const c = new McpClient("test", mock.transport, FAST);
  await assert.rejects(c.start(), /cursor loop/);
  assert.equal(c.getState().state, "failed");
});

test("startup: tools/list pagination (multi-page cursor works)", async () => {
  const mock = new MockMcpServer();
  mock.onInbound((l) => {
    const id = l.obj.id as number;
    if (l.obj.method === "server/discover") {
      mock.respondResult(id, { resultType: "discovery", supportedVersions: [MCP_CLIENT_VERSION] });
    } else if (l.obj.method === "tools/list") {
      const params = l.obj.params as Record<string, unknown>;
      if (params.cursor === "c1") {
        mock.respondResult(id, { tools: [{ name: "b" }] });
      } else {
        mock.respondResult(id, { tools: [{ name: "a" }], nextCursor: "c1" });
      }
    }
  });
  const c = new McpClient("test", mock.transport, FAST);
  const tools = await c.start();
  assert.deepEqual(tools.map((t) => t.name), ["a", "b"]);
  c.close();
});

test("startup: a malformed tools/list result is a startup failure", async () => {
  const mock = new MockMcpServer();
  mock.onInbound((l) => {
    const id = l.obj.id as number;
    if (l.obj.method === "server/discover") {
      mock.respondResult(id, { resultType: "discovery", supportedVersions: [MCP_CLIENT_VERSION] });
    } else if (l.obj.method === "tools/list") {
      mock.respondResult(id, { noTools: true });
    }
  });
  const c = new McpClient("test", mock.transport, FAST);
  await assert.rejects(c.start(), /invalid tools\/list result/);
  assert.equal(c.getState().state, "failed");
});

test("ids are monotonically increasing positive integers starting at 1", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  const ids = mock.inbound
    .filter((l) => typeof l.obj.id === "number")
    .map((l) => l.obj.id as number);
  assert.ok(ids.length >= 2, "at least probe + tools/list");
  assert.equal(ids[0], 1, "first id is 1");
  for (let i = 1; i < ids.length; i++) {
    assert.ok((ids[i] ?? 0) > (ids[i - 1] ?? 0), "monotonic: " + ids.join(","));
  }
  c.close();
});

test("outbound ids are never strings (probe, handshake, and calls all use integers)", async () => {
  const mock = new MockMcpServer();
  legacyMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  for (const l of mock.inbound) {
    if (l.obj.id !== undefined) {
      assert.equal(typeof l.obj.id, "number", "id is a number: " + String(l.obj.method));
    }
  }
  c.close();
});
