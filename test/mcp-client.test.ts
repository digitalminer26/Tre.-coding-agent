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
  McpCallError,
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
  assert.equal(mock.killed, true, "failed = torn down (immediate kill; startup has nothing graceful to await)");
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

// AUDIT CYCLE 2 — NEW-F2: an envelope violation is TERMINAL (fail()), but the
// onStdout line loop used to CONTINUE processing the rest of the chunk. The
// lines AFTER the violation would still be dispatched on a closed client: a
// server request's mandatory reply would enqueue a frame and restore nonzero
// byte reservations after teardown was already running. The fix returns
// immediately after a dispatch that closed the client, AND admit() refuses
// frames once closed. This pins the coalesced case: one stdout chunk with an
// invalid envelope line FOLLOWED by a valid server request — the request's
// reply must NOT be enqueued (queued/undrained stay zero).
test("NEW-F2: envelope violation stops dispatch of the rest of its chunk (coalesced)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  // One coalesced chunk: an invalid envelope line (neither method nor id)
  // followed by a VALID server→client request. Both in the same data event.
  mock.stdout.write(
    '{"jsonrpc":"2.0"}\n' +
      '{"jsonrpc":"2.0","id":42,"method":"sampling/createMessage","params":{"messages":[]}}\n',
  );
  await tick();
  // The client failed on the first line.
  assert.equal(c.getState().state, "failed");
  assert.match(c.getState().reason, /neither method nor id/);
  // The rest of the chunk was NOT dispatched: no -32601 reply was enqueued
  // for the server request (id 42), and the queue/reservation accounting is
  // zero (the pre-fix repro left {undrained:82, queued:1, pending:0}).
  const stats = c.getStats();
  assert.equal(stats.queued, 0, "no reply frame enqueued after the terminal violation");
  assert.equal(stats.undrained, 0, "no byte reservations restored after teardown");
  assert.equal(stats.pending, 0, "no pending entries");
  // No reply line was ever sent to the mock for the server request.
  assert.equal(
    mock.inbound.some((l) => l.obj.id === 42 && l.obj.error),
    false,
    "no -32601 reply was sent for the post-violation server request",
  );
});

// AUDIT CYCLE 2 — NEW-F2 (notifications branch): a valid notification in the
// same chunk AFTER an envelope violation must not change diagnostics either
// (the loop stops at the violation). Pins the notification side of the fix.
test("NEW-F2: a notification after an envelope violation in the same chunk is not dispatched", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  // Snapshot the NUMBER: getDiagnostics() returns the live object, so
  // snapshotting the object would alias and the assertion could never fail.
  const before = c.getDiagnostics().unknownNotifications;
  // Coalesced: invalid envelope line + a valid unknown notification.
  mock.stdout.write(
    '{"jsonrpc":"2.0"}\n' +
      '{"jsonrpc":"2.0","method":"notifications/unknown_thing"}\n',
  );
  await tick();
  assert.equal(c.getState().state, "failed");
  const after = c.getDiagnostics();
  // The notification was NOT dispatched — its unknown-method counter is
  // unchanged (it would have incremented if the loop had continued).
  assert.equal(after.unknownNotifications, before);
});

// AUDIT CYCLE 2 — NEW-F1: a READ error on the child's stdout is transport
// death (the pipe is broken). Without an 'error' listener on the readable,
// the error is an UNHANDLED EventEmitter 'error' that crashes the host (the
// stdin path had an explicit handler; the readable pipes did not). The fix
// fails the server in-band (pending calls settle, state → failed) instead of
// throwing out of the stream.
test("NEW-F1: a stdout read error fails the server in-band (no unhandled 'error')", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  // An in-flight call — it must settle (not hang) when the pipe dies.
  const p = c.callTool("read_file", {});
  await tick();
  // Simulate a read error on the stdout readable (EIO / broken pipe).
  mock.stdout.emit("error", new Error("simulated read EIO"));
  await tick();
  assert.equal(c.getState().state, "failed", "a stdout read error is terminal");
  assert.match(c.getState().reason, /stdout read error/);
  // The pending call settled in-band (transport failure), not left hanging.
  const r = await p;
  assert.equal(r.isError, true);
  assert.match(r.texts[0] ?? "", /transport failure|stdout read error/i);
});

// AUDIT CYCLE 2 — NEW-F1 (stderr branch): a READ error on the child's stderr
// is NOT terminal — stderr is a diagnostic side-channel, and a broken stderr
// pipe must not tear down an otherwise-healthy server. The fix records it in
// the retained diagnostics (the ring) and swallows it (no unhandled 'error').
// AUDIT CYCLE 3 — stderr error marker must respect the byte bound and survive
// the next data chunk (both go through the one retention path).
test("audit NEW-F1 (cycle-3): stderr error marker stays within the byte ring and persists after data", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.stderr.write("漢".repeat(21000)); // ~63 KiB of multibyte stderr
  await tick();
  mock.stderr.emit("error", new Error("漢".repeat(30000))); // huge multibyte message
  await tick();
  // An oversized marker is trimmed to the byte ring (its prefix may be cut).
  assert.ok(
    Buffer.byteLength(c.getDiagnostics().stderr, "utf8") <= 64 * 1024,
    "view stays within the byte ring",
  );
  // A normal-size marker is retained whole, and survives the next data chunk.
  mock.stderr.emit("error", new Error("EIO-short"));
  await tick();
  assert.ok(c.getDiagnostics().stderr.includes("stderr read error: EIO-short"), "marker present");
  mock.stderr.write("NEXT");
  await tick();
  assert.ok(c.getDiagnostics().stderr.endsWith("NEXT"), "newest data retained");
  assert.ok(
    c.getDiagnostics().stderr.includes("stderr read error: EIO-short"),
    "the error marker survives the next data chunk",
  );
});

// AUDIT CYCLE 3 — an invalid lead byte followed by valid ASCII: the ASCII is
// kept (the bad byte is proven malformed by the byte after it, not "incomplete").
test("audit F2 (cycle-3): valid trailing ASCII after an invalid lead byte is not dropped", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.stderr.write(Buffer.from([0x50, 0x52, 0x45, 0xe6, 0x41])); // "PRE" 0xe6 "A"
  await tick();
  assert.ok(c.getDiagnostics().stderr.endsWith("A"), "the trailing ASCII is retained");
});

// AUDIT CYCLE 3 — RFC 3629 second-byte restrictions: E0 80, ED A0, F4 90 can
// never become valid, so they are MALFORMED (replacement chars), not an
// "incomplete" suffix that is silently dropped.
for (const [name, bytes] of [
  ["overlong E0 80", [0xe0, 0x80]],
  ["surrogate ED A0", [0xed, 0xa0]],
  ["above-range F4 90", [0xf4, 0x90]],
] as const) {
  test(`audit F2 (cycle-3): impossible prefix ${name} at the END of the buffer is malformed, not incomplete`, async () => {
    const mock = new MockMcpServer();
    modernMock(mock);
    const c = new McpClient("test", mock.transport, FAST);
    await c.start();
    // Prefix at the very end: nothing follows it, so only the second-byte
    // restriction can classify it. The old decoder dropped it to "A".
    mock.stderr.write(Buffer.from([0x41, ...bytes]));
    await tick();
    assert.ok(
      c.getDiagnostics().stderr.includes("\uFFFD"),
      "the impossible prefix is shown as a replacement char, not silently dropped",
    );
  });

  test(`audit F2 (cycle-3): impossible prefix ${name} followed by ASCII keeps the ASCII`, async () => {
    const mock = new MockMcpServer();
    modernMock(mock);
    const c = new McpClient("test", mock.transport, FAST);
    await c.start();
    mock.stderr.write(Buffer.from([0x41, ...bytes, 0x42]));
    await tick();
    assert.ok(c.getDiagnostics().stderr.endsWith("B"), "the trailing ASCII is retained");
  });
}

test("audit F2 (cycle-3): a genuinely incomplete VALID prefix at the tail end is still suppressed", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.stderr.write(Buffer.from([0x50, 0x52, 0x45, 0xe2, 0x82])); // "PRE" + valid 3-byte prefix, cut off
  await tick();
  assert.equal(c.getDiagnostics().stderr, "PRE", "no replacement char for a sequence that could still complete");
});

// AUDIT CYCLE 3 — invalid UTF-8 must not make the tail drop its newest bytes.
test("audit F3 (cycle-3): invalid-UTF-8 stderr keeps the newest bytes (tail, not prefix)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.stderr.write(Buffer.concat([Buffer.alloc(65530, 0xff), Buffer.from("TAIL")]));
  await tick();
  assert.ok(c.getDiagnostics().stderr.endsWith("TAIL"), "the newest bytes are retained");
});

// AUDIT CYCLE 3 — a client closed/killed in the window after the final
// tools/list response must NOT resolve startup as "ready" (close/kill set
// `closed` without changing `state`).
for (const how of ["close", "kill"] as const) {
  test(`audit (cycle-3): ${how}() after the final tools/list response fails startup`, async () => {
    const mock = new MockMcpServer();
    let client: McpClient | null = null;
    mock.onInbound((l) => {
      const id = l.obj.id as number;
      if (l.obj.method === "server/discover") {
        mock.respondError(id, MCP_ERR_METHOD_NOT_FOUND, "unknown method");
      } else if (l.obj.method === "initialize") {
        mock.respondResult(id, { protocolVersion: MCP_LEGACY_VERSION, capabilities: {}, serverInfo: { name: "x", version: "1" } });
      } else if (l.obj.method === "tools/list") {
        mock.respondResult(id, { tools: [] });
        // Tear the client down in the window before startup continues.
        queueMicrotask(() => (how === "close" ? client!.close() : client!.kill()));
      }
    });
    client = new McpClient("test", mock.transport, FAST);
    await assert.rejects(client.start(), /startup failed after tools\/list/);
    assert.equal(client.getState().state === "ready", false, "a closed client is never ready");
  });
}

// AUDIT CYCLE 3 — a stdout closed WITHOUT end/EOF is transport death too.
test("audit (cycle-3): stdout closed without EOF fails the server (not left ready)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  mock.stdout.destroy();
  await tick();
  assert.equal(c.getState().state, "failed");
});

test("NEW-F1: a stderr read error is recorded, not terminal (server stays ready)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  const before = c.getDiagnostics().stderr;
  mock.stderr.emit("error", new Error("simulated stderr EIO"));
  await tick();
  // The server is UNTOUCHED — stderr is not a transport.
  assert.equal(c.getState().state, "ready", "a stderr read error must not tear down the server");
  // The error was recorded in the retained diagnostics.
  const after = c.getDiagnostics().stderr;
  assert.ok(after.includes("stderr read error"), "the stderr read error is recorded");
  assert.ok(after.includes("simulated stderr EIO"), "the error message is retained");
  assert.notEqual(after, before, "the diagnostics changed");
});

// AUDIT CYCLE 2 — NEW-F1 (late echo): a stdout read error that arrives AFTER
// our own shutdown (close()/kill() ends the child's stdout, and a read still
// in flight can fail) must be ABSORBED, not re-fail an already-closed client.
test("NEW-F1: a late stdout read error after close() is absorbed (no re-fail)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  c.close();
  assert.equal(c.isClosed(), true);
  // A late echo of our own teardown — must be a no-op (no throw, no state
  // change, no unhandled 'error').
  mock.stdout.emit("error", new Error("late EPIPE after close"));
  await tick();
  assert.equal(c.isClosed(), true);
  // close() does not set state to "failed" (a clean shutdown) — it must stay
  // whatever close() left it, NOT become "failed" from the late echo.
  assert.notEqual(c.getState().state, "failed", "a late echo must not re-fail the client");
});

// AUDIT CYCLE 1 — F5 (startup-completion gap): runStartup used to return the
// tool list even when the client failed AFTER its last tools/list response —
// e.g. the final valid response and a framing violation coalesced in the SAME
// stdout chunk. The registry would then publish a "ready" handle whose client
// is actually dead (exporting a ghost tool). The fix rejects startup when the
// state is no longer "starting" after listToolsStartup resolves.
test("cycle-1 F5: a fatal line coalesced with the final tools/list response fails startup", async () => {
  const mock = new MockMcpServer();
  mock.onInbound((l) => {
    const id = l.obj.id as number;
    if (l.obj.method === "server/discover") {
      mock.respondResult(id, { resultType: "discovery", supportedVersions: [MCP_CLIENT_VERSION] });
    } else if (l.obj.method === "tools/list") {
      // Coalesce the VALID tools/list response with a FATAL line (not-json)
      // in the SAME stdout chunk. The response resolves listToolsStartup, but
      // the fatal line runs fail() in the same onStdout pass — so by the time
      // runStartup resumes, the client has already failed.
      mock.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [{ name: "ok" }] } }) + "\n" +
          "not-json\n",
      );
    }
  });
  const c = new McpClient("test", mock.transport, FAST);
  await assert.rejects(c.start(), /startup failed after tools\/list/);
  assert.equal(c.getState().state, "failed", "the coalesced fatal line tears the server down");
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

test("abort signal is scoped to its request when the same tool is concurrent", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  const a = new AbortController();
  const b = new AbortController();
  const first = c.callTool("read_file", { n: 1 }, a.signal);
  const second = c.callTool("read_file", { n: 2 }, b.signal);
  await tick();
  const requests = mock.inbound.filter((l) => l.obj.method === "tools/call");
  assert.equal(requests.length, 2);
  a.abort();
  const firstResult = await first;
  assert.match(firstResult.texts[0] ?? "", /aborted/);
  const cancelled = mock.inbound.filter((l) => l.obj.method === "notifications/cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0]!.obj.params && (cancelled[0]!.obj.params as {requestId:number}).requestId, requests[0]!.obj.id);
  const secondId = requests[1]!.obj.id as number;
  mock.respondResult(secondId, { resultType: "complete", content: [{ type: "text", text: "second survived" }] });
  assert.deepEqual((await second).texts, ["second survived"]);
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

// ── Finding #1: a transport write rejection must settle the pending call ──
// (in-band isError, no hang), fail the server, and tear the transport down.

test("write rejection: the pending call settles in-band (no hang), server fails, transport killed", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  assert.equal(c.getState().state, "ready");

  // The NEXT stdin write (the tools/call frame) rejects with a transport
  // error (EPIPE / broken pipe).
  mock.interceptWrites();
  mock.failNextWrite = true;

  // This MUST resolve (not hang) — the write-error path must settle the
  // pending entry in-band.
  const res = await c.callTool("read_file", { path: "/x" });
  assert.equal(res.isError, true, "the call fails in-band");
  assert.ok(res.texts.join(" ").length > 0, "a failure message is present");

  // The server is failed (a write error is a transport failure), the
  // transport was killed (fail() = immediate kill, not the graceful chain),
  // and no pending entry is left unsettled.
  assert.equal(c.getState().state, "failed");
  assert.ok(mock.killed, "the transport was killed (teardown ran)");
  assert.equal(c.getStats().pending, 0, "no unsettled pending entry");

  // A later call is rejected in-band (the server is not running) — it does
  // NOT hang either.
  const again = await c.callTool("read_file", { path: "/y" });
  assert.equal(again.isError, true);
  assert.match(again.texts.join(" "), /not running|closed|failed/i);
});

test("write rejection during STARTUP (the probe frame): start() rejects, no hang, transport killed", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  // The FIRST write (the probe frame) rejects.
  mock.interceptWrites();
  mock.failNextWrite = true;
  await assert.rejects(c.start(), /transport failure|stdin write error/i);
  assert.equal(c.getState().state, "failed");
  assert.ok(mock.killed, "the transport was killed");
  assert.equal(c.getStats().pending, 0, "no unsettled pending entry");
});

test("clean shutdown is GRACEFUL: close() closes (never kills) the transport + suppresses the EOF-is-death echo", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  c.close();
  assert.equal(mock.closed, true, "the transport got the graceful close");
  assert.equal(
    mock.killed,
    false,
    "close() must NOT SIGKILL (the escalation stdin EOF → SIGTERM → SIGKILL belongs to the spawn)",
  );
});

test("stdout EOF DURING graceful close is not transport death (no fail, no kill)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  // The real graceful-close sequence: close() first (stdin EOF sent), THEN
  // the child exits and its stdout flushes EOF. The EOF must be read as the
  // echo of our own close, not a transport failure.
  c.close();
  mock.closeStdout(); // EOF after close started
  await tick(30);
  assert.equal(mock.killed, false, "the EOF echo must not trigger kill()");
  assert.equal(c.isClosed(), true, "the client is closed");
});

// ── Finding #1 (audit): a LATE stdin EPIPE after OUR OWN shutdown must not
//    surface as an unhandled 'error' event that crashes the host. The real
//    repro: a write in flight when close()/kill() ends the child's stdin
//    fails with EPIPE. The fix keeps the stdin `error` listener attached
//    through teardown (it is removed for data/drain but NOT for error) and
//    makes the handler a no-op once `closed`. Before the fix, teardown()
//    removed the listener, so the late EPIPE had no handler → uncaught.
test("late stdin EPIPE after close() is a no-op (listener kept, not unhandled)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  assert.equal(c.getState().state, "ready");

  c.close(); // graceful shutdown: closed=true, state stays "ready"
  await tick(10);

  // The late EPIPE echo of our own stdin close. With the fix the handler is
  // still attached and no-ops on `closed`; WITHOUT it, this emit (on a
  // PassThrough with no error listener) throws synchronously (unhandled).
  let threw = false;
  try {
    mock.stdin.emit("error", new Error("write EPIPE (late, post-close)"));
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "the late EPIPE must not be an unhandled error event");
  assert.equal(c.getState().state, "ready", "close() is not a failure — state stays ready");
  assert.equal(c.isClosed(), true, "the client is closed");
});

test("late stdin EPIPE after kill() is a no-op (listener kept, not unhandled)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  c.kill(); // synchronous exit backstop: closed=true, transport killed
  await tick(10);
  let threw = false;
  try {
    mock.stdin.emit("error", new Error("write EPIPE (late, post-kill)"));
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "the late EPIPE must not be an unhandled error event");
  assert.equal(c.isClosed(), true, "the client is closed");
});

// ── Audit cycle 1 (gpt-sol) regressions ──────────────────────────────────────

test("audit F1: a multi-byte char split across stdout chunks is not corrupted", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  const p = c.callTool("read_file", {});
  await tick(40);
  const call = mock.lineFor("tools/call");
  assert.ok(call, "the request reached the mock");
  // A response whose text is CJK + emoji, delivered in TWO chunks with the
  // split in the MIDDLE of a multi-byte code point (the 2nd byte of 你).
  // Decoding each chunk independently would corrupt the char (replacement
  // chars) — the streaming decoder must reassemble it.
  const line =
    JSON.stringify({
      jsonrpc: "2.0",
      id: call.obj.id,
      result: { resultType: "complete", content: [{ type: "text", text: "你好🙂" }] },
    }) + "\n";
  const buf = Buffer.from(line, "utf8");
  const splitAt = line.indexOf("你") + 1; // byte offset (all prior chars ASCII)
  mock.stdout.write(buf.subarray(0, splitAt));
  await tick(20);
  mock.stdout.write(buf.subarray(splitAt));
  const r = await p;
  assert.equal(r.isError, false);
  assert.equal(r.texts[0], "你好🙂", "the split multi-byte char survived intact");
  c.close();
});

test("audit F7: the stderr ring is bounded in UTF-8 BYTES (not chars)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  // 65536 CJK chars = 196608 bytes — a char-based cap would retain all of it.
  mock.stderr.write("漢".repeat(65536));
  await tick();
  const d = c.getDiagnostics();
  assert.ok(
    Buffer.byteLength(d.stderr, "utf8") <= 64 * 1024,
    "ring bounded in bytes: " + Buffer.byteLength(d.stderr, "utf8"),
  );
  assert.ok(d.stderr.endsWith("漢"), "tail kept");
  c.close();
});

// AUDIT CYCLE 1 — F7 (trailing boundary): the tail may END mid-code-point —
// its last bytes are an incomplete sequence. Decoding them raw emits a
// replacement char that RE-ENCODES to 3 bytes for 1 input byte, inflating the
// exposed view PAST the cap (65535 ASCII + 0xe6 → 65538 bytes). The fix stops
// at the incomplete sequence, so the exposed view's re-encoded byte length is
// ≤ the tail's byte length (≤ the ring bound).
test("audit F7 (cycle-2): a trailing incomplete UTF-8 sequence does not inflate the exposed view", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  // 65535 ASCII bytes + a lone 0xe6 (a 3-byte lead with no continuation
  // bytes). The raw tail is 65536 bytes (exactly the cap).
  const buf = Buffer.concat([Buffer.from("A".repeat(65535), "utf8"), Buffer.from([0xe6])]);
  mock.stderr.write(buf);
  await tick();
  const d = c.getDiagnostics();
  const exposed = Buffer.byteLength(d.stderr, "utf8");
  assert.ok(exposed <= 64 * 1024, "exposed view ≤ the ring bound: " + exposed);
  assert.ok(exposed <= 65536, "no replacement-char inflation past the tail length: " + exposed);
  assert.ok(d.stderr.endsWith("A"), "the complete ASCII tail is kept");
  c.close();
});

// AUDIT CYCLE 1 — F7 (backing allocation): a subarray of a large concat OWNS
// the ENTIRE backing buffer — an 8 MiB stderr chunk would leave an 8 MiB
// allocation retained behind a 64 KiB logical tail. The fix copies the
// retained tail into a bounded allocation (Buffer.from), so the backing
// buffer is ~the tail size, not the whole concat.
test("audit F7 (cycle-2): the retained stderr tail owns a bounded allocation (not the whole concat)", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  // An inline 8 MiB stderr chunk: the ring retains only the last 64 KiB.
  const big = Buffer.from("B".repeat(8 * 1024 * 1024), "utf8");
  mock.stderr.write(big);
  await tick();
  const d = c.getDiagnostics();
  assert.ok(Buffer.byteLength(d.stderr, "utf8") <= 64 * 1024, "diagnostic view bounded");
  assert.ok(d.stderr.endsWith("B"), "tail kept");
  // White-box: the retained tail's BACKING allocation must be bounded, not the
  // 8 MiB concat (a subarray would report buffer.byteLength ≈ 8 MiB).
  const tail = (c as unknown as { stderrTail: Buffer }).stderrTail;
  assert.ok(tail.length <= 64 * 1024, "logical tail bounded: " + tail.length);
  assert.ok(
    tail.buffer.byteLength <= 128 * 1024,
    "backing allocation bounded (not the 8 MiB concat): " + tail.buffer.byteLength,
  );
  c.close();
});

test("audit F2: a timed-out QUEUED request is released and NOT re-sent after the pipe recovers", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, {
    callTimeoutMs: 60,
    probeTimeoutMs: 300,
    startupBudgetMs: 2500,
    stallMs: 200,
  });
  await c.start();
  // Stall the pipe AFTER ready: writes are held (no flush callback returns),
  // so frame 1 is "write-started" (its flush is pending) and frame 2 is
  // QUEUED behind it (writeNext is blocked on frame 1).
  mock.pauseWrites = true;
  mock.interceptWrites();
  const p1 = c.callTool("read_file", {}); // frame 1 — write held
  await tick(20);
  const p2 = c.callTool("read_file", {}); // frame 2 — queued behind frame 1
  // Both time out (60ms). Frame 1's frame is write-started (stays); frame 2's
  // frame is UNSENT — settle() must release it from the queue NOW. Without
  // this, frame 2 would be written to the server once the pipe recovered —
  // performing the (possibly mutating) call after the caller already timed out.
  await tick(150);
  assert.equal(c.getStats().queued, 0, "the timed-out queued frame was released on timeout");
  // Recover the pipe: fire the held flush (frame 1) so the client dispatches
  // the next queued frame. If frame 2 were still queued (the bug), it would be
  // written to the server here — after the caller already saw the timeout.
  mock.pauseWrites = false;
  mock.resumeWrites();
  await tick(50);
  const calls = mock.inbound.filter((l) => l.obj.method === "tools/call");
  assert.equal(calls.length, 0, "the timed-out queued request was NOT re-sent after recovery");
  const r1 = await p1;
  const r2 = await p2;
  assert.match(r1.texts[0] ?? "", /timed out/);
  assert.match(r2.texts[0] ?? "", /timed out/);
  c.close();
});

// AUDIT CYCLE 1 — F2 (probe branch): the cycle-1 fix released an unsent
// queued frame on settlement via settle(), but the PROBE settlement paths
// (settleProbeTimeout / settleProbe) bypassed that helper — they deleted the
// pending entry WITHOUT releasing the queued frame. Reproduction: a
// server→client request arrives BEFORE start() (its mandatory -32601 reply
// occupies a stalled active write), then the probe is queued behind it. When
// the probe times out while queued, its frame must be released NOW — or it
// would be sent to the server after the pipe recovers (the same original
// unsent-settlement defect on the probe branch). The fix factors a shared
// beginSettle() that releases the unsent frame for both paths.
test("audit F2 (probe): a probe that times out while queued behind a stalled write is released", async () => {
  const mock = new MockMcpServer();
  // The mock answers the probe (if it ever gets sent) with a modern
  // DiscoverResult, the legacy initialize, and tools/list — so whichever
  // path the startup takes, it can settle.
  mock.onInbound((l) => {
    const id = l.obj.id as number;
    if (l.obj.method === "server/discover") {
      mock.respondResult(id, { resultType: "discovery", supportedVersions: [MCP_CLIENT_VERSION] });
    } else if (l.obj.method === "initialize") {
      mock.respondResult(id, {
        protocolVersion: MCP_LEGACY_VERSION,
        capabilities: {},
        serverInfo: { name: "mock", version: "1" },
      });
    } else if (l.obj.method === "tools/list") {
      mock.respondResult(id, { tools: [{ name: "ok" }] });
    }
  });
  const c = new McpClient("test", mock.transport, {
    callTimeoutMs: 1500,
    probeTimeoutMs: 120,
    startupBudgetMs: 2500,
    stallMs: 200,
  });
  // Stall the pipe BEFORE start(): the first frame written holds its flush
  // callback (no flush-completion callback), so any later frame is QUEUED
  // behind it.
  mock.pauseWrites = true;
  mock.interceptWrites();
  // A server→client request arrives before start(). Its mandatory -32601
  // reply is the first frame — it occupies the stalled active write.
  mock.sendRequest(99, "sampling/createMessage", { messages: [] });
  await tick(20);
  // Now start: the probe (server/discover) is queued BEHIND the mandatory
  // reply (writing=true on the reply's frame, so the probe's writeNext is
  // blocked). Let the probe time out while it is still queued (unsent).
  const p = c.start();
  await tick(200); // > probeTimeoutMs (120) — the probe expired while queued
  // The probe's queued frame must have been RELEASED on timeout (the fix).
  // After the timeout the client falls back to legacy and sends `initialize`
  // (legitimately queued) — so the queue holds AT MOST that one frame.
  // WITHOUT the fix the expired probe frame would ALSO still be queued (2).
  const stats = c.getStats();
  assert.ok(
    stats.queued <= 1,
    "the timed-out queued probe frame was released (queue holds only the legacy initialize): " +
      stats.queued,
  );
  // Recover the pipe: the held mandatory reply flushes. If the expired probe
  // frame were still queued (the bug), writeNext would send it to the server
  // AFTER the probe already timed out.
  mock.pauseWrites = false;
  mock.resumeWrites();
  await tick(50);
  // The point: the expired probe frame was NOT re-sent. No server/discover
  // was ever written to the mock (it was released before recovery) — the
  // mock only saw the -32601 reply (and, after recovery, the initialize).
  const discovers = mock.inbound.filter((l) => l.obj.method === "server/discover");
  assert.equal(
    discovers.length,
    0,
    "the expired probe frame was NOT re-sent after the pipe recovered",
  );
  // The startup itself: the probe timed out → legacy fallback → the mock
  // (which answers initialize) completes it. Settle the start promise.
  try {
    await p;
  } catch {
    /* a startup failure is fine — the assertion above is the point */
  }
  c.close();
});

test("audit F3a: a legacy initialize returning an unknown version is a startup failure", async () => {
  const mock = new MockMcpServer();
  mock.onInbound((l) => {
    const id = l.obj.id as number;
    if (l.obj.method === "server/discover") {
      mock.respondError(id, MCP_ERR_METHOD_NOT_FOUND, "unknown method"); // legacy
    } else if (l.obj.method === "initialize") {
      mock.respondResult(id, {
        protocolVersion: "alien-version",
        capabilities: {},
        serverInfo: { name: "x", version: "1" },
      });
    }
  });
  const c = new McpClient("test", mock.transport, FAST);
  await assert.rejects(c.start(), /invalid initialize protocolVersion/);
  assert.equal(c.getState().state, "failed", "an unsupported version tears the server down");
});

test("audit F3b: a -32022 advertising only an unsupported version is a startup failure", async () => {
  const mock = new MockMcpServer();
  mock.onInbound((l) => {
    if (l.obj.method === "server/discover") {
      mock.respondError(l.obj.id as number, MCP_ERR_UNSUPPORTED_VERSION, "unsupported", {
        requested: MCP_CLIENT_VERSION,
        supported: ["alien-version"],
      });
    }
  });
  const c = new McpClient("test", mock.transport, FAST);
  await assert.rejects(c.start(), /no usable supported version/);
  assert.equal(c.getState().state, "failed");
});

// AUDIT CYCLE 1 — F3 (legacy version validation, cycle-2 completion): the
// legacy `initialize` protocolVersion must be a REAL calendar date (the
// format regex alone accepts "2099-99-99") AND in the legacy era the client
// speaks (at or before the client's modern revision — a version AT/AFTER it
// is contradictory: we are in the legacy handshake precisely because the
// server did NOT answer the modern probe). Pre-fix, "2099-99-99" and a
// future date both reached legacy ready.
test("audit F3 (cycle-2): a legacy initialize returning an impossible date (2099-99-99) is a startup failure", async () => {
  const mock = new MockMcpServer();
  mock.onInbound((l) => {
    const id = l.obj.id as number;
    if (l.obj.method === "server/discover") {
      mock.respondError(id, MCP_ERR_METHOD_NOT_FOUND, "unknown method"); // legacy
    } else if (l.obj.method === "initialize") {
      mock.respondResult(id, {
        protocolVersion: "2099-99-99", // format-valid (YYYY-MM-DD) but not a real date
        capabilities: {},
        serverInfo: { name: "x", version: "1" },
      });
    }
  });
  const c = new McpClient("test", mock.transport, FAST);
  await assert.rejects(c.start(), /invalid initialize protocolVersion/);
  assert.equal(c.getState().state, "failed");
});

// AUDIT CYCLE 3 — negotiation regression: the modern revision itself (equality)
// must be rejected on the legacy path. A `>`-only comparison admitted it.
test("audit F1 (cycle-3): a legacy initialize returning the modern version (equality) is a startup failure", async () => {
  const mock = new MockMcpServer();
  mock.onInbound((l) => {
    const id = l.obj.id as number;
    if (l.obj.method === "server/discover") {
      mock.respondError(id, MCP_ERR_METHOD_NOT_FOUND, "unknown method");
    } else if (l.obj.method === "initialize") {
      mock.respondResult(id, {
        protocolVersion: MCP_CLIENT_VERSION,
        capabilities: {},
        serverInfo: { name: "x", version: "1" },
      });
    }
  });
  const c = new McpClient("test", mock.transport, FAST);
  await assert.rejects(c.start(), /invalid initialize protocolVersion/);
  assert.equal(c.getState().state, "failed");
});

test("audit F3 (cycle-2): a legacy initialize returning a version NEWER than the client is a startup failure", async () => {
  const mock = new MockMcpServer();
  mock.onInbound((l) => {
    const id = l.obj.id as number;
    if (l.obj.method === "server/discover") {
      mock.respondError(id, MCP_ERR_METHOD_NOT_FOUND, "unknown method"); // legacy
    } else if (l.obj.method === "initialize") {
      // A real date, but NEWER than the client's modern revision (2026-07-28):
      // contradictory on the legacy path — the client does not speak it.
      mock.respondResult(id, {
        protocolVersion: "2027-01-01",
        capabilities: {},
        serverInfo: { name: "x", version: "1" },
      });
    }
  });
  const c = new McpClient("test", mock.transport, FAST);
  await assert.rejects(c.start(), /invalid initialize protocolVersion/);
  assert.equal(c.getState().state, "failed");
});

test("audit F8: a null tools/list entry in ready-state fails in-band (not a raw TypeError)", async () => {
  const mock = new MockMcpServer();
  let tl = 0;
  mock.onInbound((l) => {
    const id = l.obj.id as number;
    if (l.obj.method === "server/discover") {
      mock.respondResult(id, { resultType: "discovery", supportedVersions: [MCP_CLIENT_VERSION] });
    } else if (l.obj.method === "tools/list") {
      tl++;
      if (tl === 1) mock.respondResult(id, { tools: [{ name: "ok" }] }); // startup
      else mock.respondResult(id, { tools: [null] }); // ready-state re-list
    }
  });
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  assert.equal(c.getState().state, "ready");
  // A `tools: [null]` entry must reject with McpCallError (the in-band
  // result-payload failure), NOT throw a raw TypeError from entry.name.
  let e: unknown;
  try {
    await c.listTools();
  } catch (err) {
    e = err;
  }
  assert.ok(e instanceof McpCallError, "in-band McpCallError, got: " + String(e));
  assert.equal(c.getState().state, "ready", "a result-payload failure does NOT tear down");
  c.close();
});

test("audit F6: a tool frame rejected at admission detaches its abort listener", async () => {
  const mock = new MockMcpServer();
  modernMock(mock);
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  // A counting signal (a plain EventTarget standing in for an AbortSignal):
  // the client attaches an "abort" listener per request and must DETACH it
  // when the request settles. A tool frame rejected at admission (>1 MiB)
  // settles via settle() — a direct pending.delete() (the old behavior)
  // would LEAK the listener on the caller's signal.
  class CountingSignal extends EventTarget {
    adds = 0;
    removes = 0;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions | boolean): void {
      this.adds++;
      super.addEventListener(type, listener, opts);
    }
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, opts?: EventListenerOptions | boolean): void {
      this.removes++;
      super.removeEventListener(type, listener, opts);
    }
    get aborted(): boolean {
      return false;
    }
  }
  const sig = new CountingSignal();
  const p = c.callTool("read_file", { pad: "x".repeat(1100 * 1024) }, sig as unknown as AbortSignal);
  await tick(20);
  const r = await p;
  assert.equal(r.isError, true);
  assert.match(r.texts[0] ?? "", /busy/);
  assert.equal(sig.adds, 1, "one abort listener was attached");
  assert.equal(sig.removes, 1, "the abort listener was detached on rejection (no leak)");
  c.close();
});
