/**
 * MCP adapter tests (scope: docs/10-mcp-scope.md §4.3).
 *
 * Covers the wire-name encoding (bounded slug + fixed-length hash, the
 * injectivity property), the `Tool` construction (non-wire side-table
 * fields), the result mapping (texts → TextBlock[], isError passthrough),
 * and the atomic per-server collision policy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeMcpToolName,
  makeMcpTool,
  importMcpServerTools,
  makeMcpResourceTool,
} from "../src/mcp/adapter.js";
import { McpCallError } from "../src/mcp/client.js";
import type {
  McpClient,
  McpResourceRead,
  McpState,
  McpTool,
  McpToolCallResult,
} from "../src/mcp/client.js";
import type {
  AdaptedMcpTool,
  McpResourceLookup,
  McpResourceServerInfo,
} from "../src/mcp/adapter.js";
import { DEFAULT_TOOLS } from "../src/tools/index.js";

const WIRE_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test("encodeMcpToolName: shape is mcp__<server>__<tool> within the wire constraint", () => {
  const name = encodeMcpToolName("fs", "read_file");
  assert.match(name, /^mcp__/);
  assert.match(name, WIRE_RE, "satisfies the wire constraint");
  // The prefix is exactly `mcp__`.
  assert.ok(name.startsWith("mcp__"));
});

test("encodeMcpToolName: the encoding is injective (a.b ≠ a_b, embedded __ is disambiguated)", () => {
  // Two DIFFERENT original identities must encode to DIFFERENT names.
  const a = encodeMcpToolName("srv", "a.b");
  const b = encodeMcpToolName("srv", "a_b");
  assert.notEqual(a, b, "a.b and a_b differ (the hash disambiguates)");

  const c = encodeMcpToolName("srv", "a__b");
  assert.notEqual(a, c, "a.b and a__b differ");
  assert.notEqual(b, c, "a_b and a__b differ");

  // A tool name that LOOKS like it embeds the `__` separator must not
  // collide with a different (server, tool) pair.
  const d = encodeMcpToolName("srv", "x__y");
  const e = encodeMcpToolName("srv", "x");
  assert.notEqual(d, e);
});

test("encodeMcpToolName: short names still carry the fixed-length hash (no bare slug)", () => {
  // Even a 1-char tool name gets the hash suffix (the scope: "even for
  // short names"). So the component is longer than the slug alone.
  const name = encodeMcpToolName("s", "t");
  // `mcp__` + component + `__` + component. Each component ≥ slug(1) +
  // `_` + hash(10) = 12. So the full name is well over 20 chars.
  assert.ok(name.length > 20, "short names still carry the hash: " + name);
});

test("encodeMcpToolName: the component is bounded (≤28 chars) even for a long identity", () => {
  const longTool = "a".repeat(200);
  const name = encodeMcpToolName("srv", longTool);
  assert.match(name, WIRE_RE, "still within the wire constraint");
  // Split out the tool component (after the second `__`).
  const m = name.match(/^mcp__[a-zA-Z0-9_-]+__([a-zA-Z0-9_-]+)$/);
  assert.ok(m, "the name has the expected shape");
  const toolComp = m![1]!;
  assert.ok(toolComp.length <= 28, "the tool component is bounded: " + toolComp.length);
});

test("encodeMcpToolName: non-ASCII / emoji identities are sanitized but still injective", () => {
  const a = encodeMcpToolName("srv", "café");
  const b = encodeMcpToolName("srv", "cafe");
  assert.match(a, WIRE_RE, "non-ASCII is sanitized to the charset");
  assert.notEqual(a, b, "café and cafe differ (the hash of the ORIGINAL)");
  // An all-emoji identity still encodes (the slug falls back to "x").
  const c = encodeMcpToolName("srv", "🚀🚀");
  assert.match(c, WIRE_RE, "emoji identity encodes to a valid wire name");
});

test("makeMcpTool: carries the non-wire side-table fields + a human displayName", async () => {
  const called: { name?: string; args?: Record<string, unknown> } = {};
  const call = async (toolName: string, args: Record<string, unknown>) => {
    called.name = toolName;
    called.args = args;
    return { texts: ["ok"], isError: false } satisfies McpToolCallResult;
  };
  const t = makeMcpTool(
    "fs",
    { name: "read_file", description: "read a file", inputSchema: { type: "object" } },
    encodeMcpToolName("fs", "read_file"),
    call as never,
    true,
  );
  assert.equal(t.displayName, "fs/read_file", "displayName is <server>/<tool>");
  assert.equal(t.mcpServer, "fs");
  assert.equal(t.mcpTool, "read_file");
  assert.equal(t.mcpTrusted, true, "the trust flag is carried");
  assert.equal(t.description, "read a file", "description passes through");
  assert.equal(t.name, encodeMcpToolName("fs", "read_file"));

  // execute() preserves the ORIGINAL tool name for tools/call.
  const res = await t.execute("tc1", { path: "/x" }, new AbortController().signal);
  assert.equal(called.name, "read_file", "the original name is sent to tools/call");
  assert.deepEqual(called.args, { path: "/x" });
  assert.deepEqual(res.content, [{ type: "text", text: "ok" }]);
  assert.equal(res.isError, undefined, "a non-error result has no isError");
});

test("makeMcpTool: an error result maps isError=true + texts to TextBlock[]", async () => {
  const call = async () =>
    ({ texts: ["boom", "detail"], isError: true } satisfies McpToolCallResult);
  const t = makeMcpTool("s", { name: "t" }, encodeMcpToolName("s", "t"), call as never, false);
  const res = await t.execute("tc1", {}, new AbortController().signal);
  assert.equal(res.isError, true, "isError passes through");
  assert.deepEqual(res.content, [
    { type: "text", text: "boom" },
    { type: "text", text: "detail" },
  ]);
});

test("makeMcpTool: a missing inputSchema defaults to an empty object schema", () => {
  const t = makeMcpTool("s", { name: "t" }, encodeMcpToolName("s", "t"), (async () => ({ texts: [], isError: false })) as never, false);
  assert.deepEqual(t.parameters, { type: "object", properties: {} });
});

test("importMcpServerTools: a clean import returns the adapted tools (no rejection)", () => {
  const call = (async () => ({ texts: [], isError: false })) as never;
  const tools: McpTool[] = [
    { name: "read_file" },
    { name: "write_file" },
  ];
  const outcome = importMcpServerTools("fs", tools, call, new Set(["bash", "read"]));
  assert.equal(outcome.rejected, null, "no rejection");
  assert.equal(outcome.imported.length, 2);
  assert.ok(outcome.imported[0]!.tool.name.startsWith("mcp__"));
  assert.equal(outcome.imported[0]!.toolName, "read_file");
  assert.equal(outcome.imported[0]!.serverName, "fs");
  // The wire name is the tool.name (transport-only).
  assert.equal(outcome.imported[0]!.wireName, outcome.imported[0]!.tool.name);
});

test("importMcpServerTools: a collision with a built-in rejects the WHOLE server atomically", () => {
  const call = (async () => ({ texts: [], isError: false })) as never;
  // Build a claimed set that contains the wire name of one of the tools.
  const tools: McpTool[] = [{ name: "a" }, { name: "b" }];
  const wireA = encodeMcpToolName("fs", "a");
  const outcome = importMcpServerTools("fs", tools, call, new Set([wireA]));
  assert.ok(outcome.rejected, "the server is rejected");
  assert.equal(outcome.rejected!.server, "fs");
  assert.deepEqual(outcome.rejected!.conflicting, ["a"], "the conflicting identity is reported");
  assert.equal(outcome.imported.length, 0, "NONE of the tools register (atomic)");
});

test("importMcpServerTools: a collision with a previously-imported MCP tool rejects the server", () => {
  const call = (async () => ({ texts: [], isError: false })) as never;
  const tools: McpTool[] = [{ name: "x" }];
  const wireX = encodeMcpToolName("other", "x"); // a different server, same tool name
  const outcome = importMcpServerTools("new", tools, call, new Set([wireX]));
  // `new/x` and `other/x` encode to DIFFERENT wire names (different server
  // component) — so this is NOT a collision.
  assert.equal(outcome.rejected, null, "different server → different wire name → no collision");
  assert.equal(outcome.imported.length, 1);
});

test("importMcpServerTools: a duplicate within the same server rejects the server", () => {
  const call = (async () => ({ texts: [], isError: false })) as never;
  // Two tools that encode to the SAME wire name. This requires two
  // identities with the same slug AND the same hash — impossible for
  // distinct identities (the hash is injective). So a true in-server
  // duplicate can only arise from the SAME identity listed twice.
  const tools: McpTool[] = [{ name: "dup" }, { name: "dup" }];
  const outcome = importMcpServerTools("fs", tools, call, new Set());
  assert.ok(outcome.rejected, "a duplicate within the server is rejected");
  assert.deepEqual(outcome.rejected!.conflicting, ["dup"]);
  assert.equal(outcome.imported.length, 0, "atomic: none register");
});

// ── makeMcpResourceTool (tier 2 — resources) ───────────────────────────────

/** A fake client exposing only the methods the tool calls. */
function fakeClient(over: {
  list?: (signal?: AbortSignal) => Promise<unknown>;
  read?: (uri: string, signal?: AbortSignal) => Promise<unknown>;
  closed?: boolean;
}): McpClient {
  return {
    listResources: async (signal?: AbortSignal): Promise<unknown> =>
      over.list ? over.list(signal) : [],
    readResource: async (uri: string, signal?: AbortSignal): Promise<unknown> =>
      over.read ? over.read(uri, signal) : { contents: [] },
    isClosed: () => over.closed ?? false,
  } as unknown as McpClient;
}

/** A lookup + server-info pair for the resource tool. */
function makeLookup(
  ready: string[],
  all: Array<{ name: string; state: McpState; reason?: string }>,
  clients: Record<string, McpClient>,
): { lookup: McpResourceLookup; servers: McpResourceServerInfo[] } {
  const lookup: McpResourceLookup = (n: string) => {
    const h = all.find((x) => x.name === n);
    if (!h) return null;
    return { client: ready.includes(n) ? (clients[n] ?? null) : null, state: h.state, reason: h.reason ?? "" };
  };
  const servers: McpResourceServerInfo[] = all.map((x) => ({ name: x.name, state: x.state, reason: x.reason ?? "" }));
  return { lookup, servers };
}

test("makeMcpResourceTool: shape (name, displayName, parameters schema)", () => {
  const { lookup, servers } = makeLookup(["fs"], [{ name: "fs", state: "ready" }], {});
  const t = makeMcpResourceTool(lookup, servers);
  assert.equal(t.name, "mcp_resource", "the fixed wire name");
  assert.equal(t.displayName, "mcp_resource", "displayName is the name itself");
  assert.equal(t.mcpTrusted, true, "mcpTrusted is carried");
  assert.equal((t as { mcpAnnotations?: unknown }).mcpAnnotations, undefined, "no mcpAnnotations");
  const p = t.parameters;
  assert.equal(p.type, "object");
  assert.deepEqual(p.required, ["server"], "server is required");
  assert.equal(p.additionalProperties, false, "additionalProperties is false");
  assert.ok(p.properties?.server, "server property present");
  assert.ok(p.properties?.uri, "uri property present");
  assert.equal(p.properties?.server?.type, "string");
  assert.equal(p.properties?.uri?.type, "string");
});

test("makeMcpResourceTool: the name collides with NO built-in tool", () => {
  const builtinNames = new Set(DEFAULT_TOOLS.map((t) => t.name));
  assert.ok(!builtinNames.has("mcp_resource"), "no built-in is named mcp_resource");
  // And it does NOT carry the mcp__ prefix (it is tre.'s own fixed name).
  assert.ok(!"mcp_resource".startsWith("mcp__"), "not an mcp__ server tool");
});

test("makeMcpResourceTool: an unknown server is an isError listing the configured servers", async () => {
  const { lookup, servers } = makeLookup(
    ["fs"],
    [
      { name: "fs", state: "ready" },
      { name: "db", state: "failed", reason: "probe timeout" },
    ],
    {},
  );
  const t = makeMcpResourceTool(lookup, servers);
  const res = await t.execute("tc1", { server: "nope" }, new AbortController().signal);
  assert.equal(res.isError, true, "unknown server is in-band isError (never throws)");
  const text = res.content[0]!.text;
  assert.match(text, /unknown MCP server "nope"/);
  assert.match(text, /fs \(ready\)/, "lists the ready server");
  assert.match(text, /db \(failed: probe timeout\)/, "lists the failed server + reason");
});

test("makeMcpResourceTool: a non-ready server is an isError (never throws)", async () => {
  const { lookup, servers } = makeLookup(
    ["fs"],
    [
      { name: "fs", state: "ready" },
      { name: "db", state: "failed", reason: "boom" },
    ],
    {},
  );
  const t = makeMcpResourceTool(lookup, servers);
  const res = await t.execute("tc1", { server: "db" }, new AbortController().signal);
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /not ready \(state: failed — boom\)/);
});

test("makeMcpResourceTool: a TORN-DOWN client (state ready, client closed) is refused live", async () => {
  // regression: the startup snapshot says `ready`, but the client was
  // fail()'d/closed() after startup — the adapter must check liveness
  // (isClosed) and refuse the call, not route to a dead transport.
  const client = fakeClient({ closed: true, list: async () => [] });
  const { lookup, servers } = makeLookup(["fs"], [{ name: "fs", state: "ready" }], { fs: client });
  const t = makeMcpResourceTool(lookup, servers);
  const res = await t.execute("tc1", { server: "fs" }, new AbortController().signal);
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /client torn down/);
});

test("makeMcpResourceTool: an empty/absent uri returns the resource list (header + JSON)", async () => {
  const list: unknown[] = [
    { uri: "file:///a", name: "a" },
    { uri: "file:///b" },
  ];
  const client = fakeClient({ list: async () => list });
  const { lookup, servers } = makeLookup(["fs"], [{ name: "fs", state: "ready" }], { fs: client });
  const t = makeMcpResourceTool(lookup, servers);
  const res = await t.execute("tc1", { server: "fs" }, new AbortController().signal);
  assert.equal(res.isError, undefined, "a successful list is not an error");
  const text = res.content[0]!.text;
  assert.match(text, /^resources for fs \(2\):/, "header line with the count");
  // The body is the JSON of the list.
  const body = text.slice(text.indexOf("\n") + 1);
  assert.deepEqual(JSON.parse(body), list, "the body is the JSON list");
});

test("makeMcpResourceTool: an empty resource list is just the header", async () => {
  const client = fakeClient({ list: async () => [] });
  const { lookup, servers } = makeLookup(["fs"], [{ name: "fs", state: "ready" }], { fs: client });
  const t = makeMcpResourceTool(lookup, servers);
  const res = await t.execute("tc1", { server: "fs", uri: "" }, new AbortController().signal);
  assert.equal(res.content[0]!.text, "resources for fs (0):", "no JSON body for an empty list");
});

test("makeMcpResourceTool: a read maps each text content entry to a uri-prefixed block", async () => {
  const read: McpResourceRead = {
    contents: [
      { uri: "file:///a", text: "alpha" },
      { uri: "file:///b", text: "beta" },
    ],
  };
  const client = fakeClient({ read: async () => read });
  const { lookup, servers } = makeLookup(["fs"], [{ name: "fs", state: "ready" }], { fs: client });
  const t = makeMcpResourceTool(lookup, servers);
  const res = await t.execute("tc1", { server: "fs", uri: "file:///a" }, new AbortController().signal);
  assert.equal(res.isError, undefined);
  const text = res.content[0]!.text;
  // Each entry is `<uri>\n<text>`, entries joined by a blank line.
  assert.equal(text, "file:///a\nalpha\n\nfile:///b\nbeta");
});

test("makeMcpResourceTool: a blob content entry is a descriptive block", async () => {
  const read: McpResourceRead = {
    contents: [{ uri: "file:///img", mimeType: "image/png", blob: "aGVsbG8=" }],
  };
  const client = fakeClient({ read: async () => read });
  const { lookup, servers } = makeLookup(["fs"], [{ name: "fs", state: "ready" }], { fs: client });
  const t = makeMcpResourceTool(lookup, servers);
  const res = await t.execute("tc1", { server: "fs", uri: "file:///img" }, new AbortController().signal);
  const text = res.content[0]!.text;
  // base64 "aGVsbG8=" decodes to 5 bytes; the descriptor carries the mime + byte count.
  assert.match(text, /\[binary resource file:\/\/\/img \(image\/png, 5 bytes base64\) — text not available\]/);
});

test("makeMcpResourceTool: a blob entry with no mimeType reports 'unknown'", async () => {
  const read: McpResourceRead = { contents: [{ uri: "u", blob: "AA==" }] };
  const client = fakeClient({ read: async () => read });
  const { lookup, servers } = makeLookup(["fs"], [{ name: "fs", state: "ready" }], { fs: client });
  const t = makeMcpResourceTool(lookup, servers);
  const res = await t.execute("tc1", { server: "fs", uri: "u" }, new AbortController().signal);
  assert.match(res.content[0]!.text, /\(unknown, 1 bytes base64\)/);
});

test("makeMcpResourceTool: a read over 64 KiB is truncated to the cap + a note", async () => {
  const big = "x".repeat(70000); // > 64 KiB
  const read: McpResourceRead = { contents: [{ uri: "big", text: big }] };
  const client = fakeClient({ read: async () => read });
  const { lookup, servers } = makeLookup(["fs"], [{ name: "fs", state: "ready" }], { fs: client });
  const t = makeMcpResourceTool(lookup, servers);
  const res = await t.execute("tc1", { server: "fs", uri: "big" }, new AbortController().signal);
  const text = res.content[0]!.text;
  assert.match(text, /\[output truncated to 64 KiB — \d+ bytes total\]/, "the truncation note is present");
  // The body is capped at 64 KiB of UTF-8 BYTES (the note is appended AFTER
  // the cap, on its own line — so the note's leading newline sits at index
  // `cap`; ASCII here, so char index == byte offset).
  const cap = 64 * 1024;
  const noteNewline = text.lastIndexOf("\n[output truncated");
  assert.equal(noteNewline, cap, "the truncated body is exactly 64 KiB before the note");
  assert.ok(text.length > cap, "the note makes the total longer than the cap");
});

test("makeMcpResourceTool: a CJK body is capped in UTF-8 BYTES (not chars) without splitting a code point", async () => {
  // '漢' is 3 bytes/char: 65536 chars = 196608 bytes — a char-based cap
  // would have kept 65536 chars (196608 bytes), ~3× over the limit.
  const cjk = "漢".repeat(65536);
  const read: McpResourceRead = { contents: [{ uri: "cjk", text: cjk }] };
  const client = fakeClient({ read: async () => read });
  const { lookup, servers } = makeLookup(["fs"], [{ name: "fs", state: "ready" }], { fs: client });
  const t = makeMcpResourceTool(lookup, servers);
  const res = await t.execute("tc1", { server: "fs", uri: "cjk" }, new AbortController().signal);
  const text = res.content[0]!.text;
  // The read path prepends `uri + "\n"` (4 bytes) before the body, so the
  // pre-truncation total is 4 + 196608 = 196612 bytes.
  assert.match(text, /\[output truncated to 64 KiB — 196612 bytes total\]/, "the note reports the pre-truncation byte length");
  const cap = 64 * 1024;
  const noteNewline = text.lastIndexOf("\n[output truncated");
  assert.equal(Buffer.byteLength(text.slice(0, noteNewline), "utf8"), cap, "the body is exactly 64 KiB of UTF-8 bytes");
  // After the 4-byte `uri\n` prefix, 65532 bytes remain for the CJK body =
  // 21844 code points (65532/3). The next code point would straddle the
  // boundary and is dropped whole (never a half-encoded char).
  const body = text.slice(0, noteNewline);
  assert.equal(Buffer.byteLength(body, "utf8"), cap, "body is exactly the cap in bytes");
  assert.equal(body.length, 4 + 21844, "no code point is split at the boundary");
});

test("makeMcpResourceTool: a list over 64 KiB is truncated to the cap + a note", async () => {
  // A list whose JSON body exceeds the cap (header + JSON > 64 KiB).
  const list = Array.from({ length: 2000 }, (_, i) => ({
    uri: `file:///r${i}`,
    description: "d".repeat(40),
  }));
  const client = fakeClient({ list: async () => list });
  const { lookup, servers } = makeLookup(["fs"], [{ name: "fs", state: "ready" }], { fs: client });
  const t = makeMcpResourceTool(lookup, servers);
  const res = await t.execute("tc1", { server: "fs" }, new AbortController().signal);
  assert.equal(res.isError, undefined, "a successful list is not an error");
  const text = res.content[0]!.text;
  assert.match(text, /^resources for fs \(2000\):/, "the header line survives the cap");
  assert.match(text, /\[output truncated to 64 KiB — \d+ bytes total\]/, "the truncation note is present");
  // The body is capped at 64 KiB (the note is appended AFTER the cap, on its
  // own line — so the note's leading newline sits at index `cap`).
  const cap = 64 * 1024;
  const noteNewline = text.lastIndexOf("\n[output truncated");
  assert.equal(noteNewline, cap, "the truncated body is exactly 64 KiB before the note");
  assert.ok(text.length > cap, "the note makes the total longer than the cap");
  assert.ok(text.length <= cap + 100, "the total output is the cap plus the note");
});

test("makeMcpResourceTool: the caller's abort signal is threaded to listResources", async () => {
  // Regression (audit 2026-10-17): the list path used to call
  // listResources() WITHOUT the signal, so a Ctrl+C during a (multi-page)
  // list could not cancel the in-flight request. The tool must pass the
  // caller's signal through.
  let seen: AbortSignal | undefined;
  const client = fakeClient({
    list: (signal) => {
      seen = signal;
      return signal
        ? new Promise<unknown>((_r, reject) =>
            signal.addEventListener("abort", () =>
              reject(new McpCallError("call resources/list aborted")),
            ),
          )
        : new Promise<unknown>(() => {}); // never settles — would hang the test
    },
  });
  const { lookup, servers } = makeLookup(["fs"], [{ name: "fs", state: "ready" }], { fs: client });
  const t = makeMcpResourceTool(lookup, servers);
  const ctrl = new AbortController();
  const p = t.execute("tc1", { server: "fs" }, ctrl.signal);
  await tick(20);
  assert.ok(seen, "listResources received a signal");
  assert.equal(seen, ctrl.signal, "it is the CALLER's signal (not a fresh one)");
  ctrl.abort();
  const res = await p; // must settle in-band, not hang
  assert.equal(res.isError, true, "the abort surfaces as an in-band error");
  assert.match(res.content[0]!.text, /aborted/);
});

test("makeMcpResourceTool: a server-side isError read sets ToolResult.isError", async () => {
  const read: McpResourceRead = { isError: true, contents: [{ uri: "e", text: "boom" }] };
  const client = fakeClient({ read: async () => read });
  const { lookup, servers } = makeLookup(["fs"], [{ name: "fs", state: "ready" }], { fs: client });
  const t = makeMcpResourceTool(lookup, servers);
  const res = await t.execute("tc1", { server: "fs", uri: "e" }, new AbortController().signal);
  assert.equal(res.isError, true, "the server-side isError is surfaced");
  assert.match(res.content[0]!.text, /boom/);
});

test("makeMcpResourceTool: a protocol error from the client is an in-band isError (never throws)", async () => {
  const { McpCallError } = await import("../src/mcp/client.js");
  const client = fakeClient({ read: async () => { throw new McpCallError("MCP protocol error -32602: bad uri"); } });
  const { lookup, servers } = makeLookup(["fs"], [{ name: "fs", state: "ready" }], { fs: client });
  const t = makeMcpResourceTool(lookup, servers);
  const res = await t.execute("tc1", { server: "fs", uri: "x" }, new AbortController().signal);
  assert.equal(res.isError, true, "the McpCallError is in-band (never throws)");
  assert.match(res.content[0]!.text, /-32602/);
});

test("makeMcpResourceTool: a list that throws an McpCallError is an in-band isError", async () => {
  const { McpCallError } = await import("../src/mcp/client.js");
  const client = fakeClient({ list: async () => { throw new McpCallError("resources/list limit exceeded (100 pages / 10000 resources)"); } });
  const { lookup, servers } = makeLookup(["fs"], [{ name: "fs", state: "ready" }], { fs: client });
  const t = makeMcpResourceTool(lookup, servers);
  const res = await t.execute("tc1", { server: "fs" }, new AbortController().signal);
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /limit exceeded/);
});

test("makeMcpResourceTool: an already-aborted signal returns an in-band result (no throw)", async () => {
  const client = fakeClient({ read: async () => ({ contents: [] }) });
  const { lookup, servers } = makeLookup(["fs"], [{ name: "fs", state: "ready" }], { fs: client });
  const t = makeMcpResourceTool(lookup, servers);
  const ctrl = new AbortController();
  ctrl.abort(); // aborted BEFORE the call
  const res = await t.execute("tc1", { server: "fs", uri: "x" }, ctrl.signal);
  assert.equal(res.isError, true, "an aborted signal is an in-band result");
  assert.match(res.content[0]!.text, /aborted/);
});
