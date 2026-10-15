/**
 * MCP client resource tests (scope §Tier 2 — resources).
 *
 * Uses the mock transport (test/mock-transport.ts): no child process.
 * Covers `listResources` (single page, pagination, cursor loop, page cap,
 * malformed results, dead server, the modern `_meta` envelope) and
 * `readResource` (text / blob / multi-content, malformed result, protocol
 * error, abort). Result-payload failures are IN-BAND (McpCallError — the
 * server is NOT torn down), same posture as tools/list in ready-state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  McpClient,
  McpCallError,
  MCP_CLIENT_VERSION,
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

/** A mock that starts modern (probe + tools/list) and then answers
 *  resources/list and resources/read via the given handlers. */
function resourceMock(
  mock: MockMcpServer,
  handlers: {
    list?: (params: Record<string, unknown>, id: number) => void;
    read?: (params: Record<string, unknown>, id: number) => void;
  } = {},
): void {
  mock.onInbound((l: InboundLine) => {
    const id = l.obj.id as number;
    if (l.obj.method === "server/discover") {
      mock.respondResult(id, {
        resultType: "discovery",
        supportedVersions: [MCP_CLIENT_VERSION],
      });
    } else if (l.obj.method === "tools/list") {
      mock.respondResult(id, { tools: [] });
    } else if (l.obj.method === "resources/list") {
      handlers.list?.(l.obj.params as Record<string, unknown>, id);
    } else if (l.obj.method === "resources/read") {
      handlers.read?.(l.obj.params as Record<string, unknown>, id);
    }
  });
}

/** Start a ready modern client over the mock. */
async function readyClient(mock: MockMcpServer): Promise<McpClient> {
  const c = new McpClient("test", mock.transport, FAST);
  await c.start();
  assert.equal(c.getState().state, "ready");
  return c;
}

// ── listResources ──────────────────────────────────────────────────────────

test("listResources: a single page returns the resources", async () => {
  const mock = new MockMcpServer();
  resourceMock(mock, {
    list: (_p, id) =>
      mock.respondResult(id, {
        resources: [
          { uri: "file:///a", name: "a", mimeType: "text/plain" },
          { uri: "file:///b" },
        ],
      }),
  });
  const c = await readyClient(mock);
  const res = await c.listResources();
  assert.equal(res.length, 2);
  assert.equal(res[0]!.uri, "file:///a");
  assert.equal(res[0]!.name, "a");
  assert.equal(res[0]!.mimeType, "text/plain");
  assert.equal(res[1]!.uri, "file:///b");
  assert.equal(res[1]!.name, undefined, "absent optional fields are undefined");
  assert.equal(res[1]!.mimeType, undefined);
  assert.equal(c.getState().state, "ready");
  c.close();
});

test("listResources: pagination across 2 pages (the cursor is threaded)", async () => {
  const mock = new MockMcpServer();
  resourceMock(mock, {
    list: (params, id) => {
      if (params.cursor === "c1") {
        mock.respondResult(id, { resources: [{ uri: "b" }] });
      } else {
        mock.respondResult(id, { resources: [{ uri: "a" }], nextCursor: "c1" });
      }
    },
  });
  const c = await readyClient(mock);
  const res = await c.listResources();
  assert.deepEqual(
    res.map((r) => r.uri),
    ["a", "b"],
  );
  // The second request carried the cursor.
  const listLines = mock.inbound.filter((l) => l.obj.method === "resources/list");
  assert.equal(listLines.length, 2, "two pages requested");
  assert.equal(
    (listLines[1]!.obj.params as Record<string, unknown>).cursor,
    "c1",
    "the second page used the cursor",
  );
  c.close();
});

test("listResources: a repeated cursor is a cursor loop (McpCallError, not torn down)", async () => {
  const mock = new MockMcpServer();
  resourceMock(mock, {
    list: (_p, id) =>
      mock.respondResult(id, { resources: [{ uri: "x" }], nextCursor: "c1" }),
  });
  const c = await readyClient(mock);
  await assert.rejects(c.listResources(), /cursor loop/);
  assert.equal(c.getState().state, "ready", "a malformed result does NOT tear down");
  c.close();
});

test("listResources: more than 100 pages is a limit error (McpCallError)", async () => {
  const mock = new MockMcpServer();
  let n = 0;
  resourceMock(mock, {
    list: (_p, id) => {
      n++;
      // A distinct cursor each page (no loop) — the page cap trips first.
      mock.respondResult(id, { resources: [{ uri: "r" + n }], nextCursor: "c" + n });
    },
  });
  const c = await readyClient(mock);
  await assert.rejects(c.listResources(), /limit exceeded/);
  assert.equal(n, 100, "exactly 100 pages were requested");
  assert.equal(c.getState().state, "ready");
  c.close();
});

test("listResources: 10000 resources in one page is a limit error (McpCallError)", async () => {
  const mock = new MockMcpServer();
  // A single page of 10000 valid entries: the cap check fires after the
  // page is appended (resources.length reaches 10000 on the last push).
  const page = Array.from({ length: 10000 }, (_, i) => ({ uri: "file:///r" + i }));
  resourceMock(mock, { list: (_p, id) => mock.respondResult(id, { resources: page }) });
  const c = await readyClient(mock);
  await assert.rejects(c.listResources(), /limit exceeded \(10000 resources\)/);
  assert.equal(c.getState().state, "ready", "a limit error does NOT tear down");
  c.close();
});

test("listResources: a malformed result (no resources array) is an McpCallError", async () => {
  const mock = new MockMcpServer();
  resourceMock(mock, { list: (_p, id) => mock.respondResult(id, { noResources: true }) });
  const c = await readyClient(mock);
  await assert.rejects(c.listResources(), /resources array missing/);
  assert.equal(c.getState().state, "ready", "not torn down");
  c.close();
});

test("listResources: a resource entry without a string uri is an McpCallError", async () => {
  const mock = new MockMcpServer();
  resourceMock(mock, { list: (_p, id) => mock.respondResult(id, { resources: [{ name: "no-uri" }] }) });
  const c = await readyClient(mock);
  await assert.rejects(c.listResources(), /uri missing/);
  assert.equal(c.getState().state, "ready", "not torn down");
  c.close();
});

test("listResources: a dead (closed) server rejects with a not-running error", async () => {
  const mock = new MockMcpServer();
  resourceMock(mock, { list: (_p, id) => mock.respondResult(id, { resources: [] }) });
  const c = await readyClient(mock);
  c.close();
  await assert.rejects(c.listResources(), /not running/);
});

test("listResources (modern era): the request carries the _meta envelope", async () => {
  const mock = new MockMcpServer();
  resourceMock(mock, { list: (_p, id) => mock.respondResult(id, { resources: [] }) });
  const c = await readyClient(mock);
  await c.listResources();
  const rl = mock.lineFor("resources/list");
  assert.ok(rl, "resources/list sent");
  const meta = (rl.obj.params as Record<string, unknown>)._meta as Record<string, unknown>;
  assert.ok(meta, "resources/list has _meta");
  assert.equal(meta["io.modelcontextprotocol/protocolVersion"], MCP_CLIENT_VERSION);
  c.close();
});

// ── readResource ───────────────────────────────────────────────────────────

test("readResource: a text content entry maps to the result", async () => {
  const mock = new MockMcpServer();
  resourceMock(mock, {
    read: (params, id) => {
      assert.equal(params.uri, "file:///a");
      mock.respondResult(id, {
        contents: [{ uri: "file:///a", mimeType: "text/plain", text: "hello" }],
      });
    },
  });
  const c = await readyClient(mock);
  const res = await c.readResource("file:///a");
  assert.equal(res.contents.length, 1);
  assert.equal(res.contents[0]!.uri, "file:///a");
  assert.equal(res.contents[0]!.text, "hello");
  assert.equal(res.contents[0]!.mimeType, "text/plain");
  assert.equal(res.contents[0]!.blob, undefined);
  c.close();
});

test("readResource: a blob content entry is opaque (not decoded)", async () => {
  const mock = new MockMcpServer();
  resourceMock(mock, {
    read: (_p, id) =>
      mock.respondResult(id, {
        contents: [{ uri: "file:///b", mimeType: "image/png", blob: "aGVsbG8=" }],
      }),
  });
  const c = await readyClient(mock);
  const res = await c.readResource("file:///b");
  assert.equal(res.contents[0]!.blob, "aGVsbG8=");
  assert.equal(res.contents[0]!.text, undefined, "text is absent for a blob");
  c.close();
});

test("readResource: multiple content entries are all returned (in order)", async () => {
  const mock = new MockMcpServer();
  resourceMock(mock, {
    read: (_p, id) =>
      mock.respondResult(id, {
        contents: [
          { uri: "a", text: "1" },
          { uri: "b", text: "2" },
          { uri: "c", mimeType: "application/octet-stream", blob: "AA==" },
        ],
      }),
  });
  const c = await readyClient(mock);
  const res = await c.readResource("multi");
  assert.equal(res.contents.length, 3);
  assert.deepEqual(
    res.contents.map((x) => x.uri),
    ["a", "b", "c"],
  );
  c.close();
});

test("readResource: a server-side isError flag is surfaced", async () => {
  const mock = new MockMcpServer();
  resourceMock(mock, {
    read: (_p, id) =>
      mock.respondResult(id, {
        isError: true,
        contents: [{ uri: "file:///err", text: "boom" }],
      }),
  });
  const c = await readyClient(mock);
  const res = await c.readResource("file:///err");
  assert.equal(res.isError, true);
  c.close();
});

test("readResource: a malformed result (no contents array) is an McpCallError", async () => {
  const mock = new MockMcpServer();
  resourceMock(mock, { read: (_p, id) => mock.respondResult(id, { noContents: true }) });
  const c = await readyClient(mock);
  await assert.rejects(c.readResource("file:///x"), /contents array missing/);
  assert.equal(c.getState().state, "ready", "not torn down");
  c.close();
});

test("readResource: a content entry without a string uri is an McpCallError", async () => {
  const mock = new MockMcpServer();
  resourceMock(mock, {
    read: (_p, id) => mock.respondResult(id, { contents: [{ text: "no-uri" }] }),
  });
  const c = await readyClient(mock);
  await assert.rejects(c.readResource("file:///x"), /uri missing/);
  assert.equal(c.getState().state, "ready", "not torn down");
  c.close();
});

test("readResource: a protocol error from the server is an McpCallError (in-band)", async () => {
  const mock = new MockMcpServer();
  resourceMock(mock, { read: (_p, id) => mock.respondError(id, -32602, "bad uri") });
  const c = await readyClient(mock);
  await assert.rejects(c.readResource("file:///x"), McpCallError);
  assert.equal(c.getState().state, "ready", "a protocol error does NOT tear down");
  c.close();
});

test("readResource: an abort before the response settles as aborted (in-band, no hang)", async () => {
  const mock = new MockMcpServer();
  // The mock NEVER answers resources/read — the call must settle via the
  // abort signal, not the 60s timeout.
  resourceMock(mock, {});
  const c = await readyClient(mock);
  const ctrl = new AbortController();
  const p = c.readResource("file:///slow", ctrl.signal);
  // Let the request frame be written (write-started), then abort.
  await tick(40);
  assert.ok(mock.lineFor("resources/read"), "the request reached the mock");
  ctrl.abort();
  let e: unknown;
  try {
    await p;
  } catch (err) {
    e = err;
  }
  assert.ok(e instanceof McpCallError, "the aborted read rejects with McpCallError");
  assert.match((e as Error).message, /aborted/);
  assert.equal(c.getState().state, "ready", "an abort does NOT tear down");
  c.close();
});
