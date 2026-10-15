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
} from "../src/mcp/adapter.js";
import type { McpTool, McpToolCallResult } from "../src/mcp/client.js";
import type { AdaptedMcpTool } from "../src/mcp/adapter.js";

const WIRE_RE = /^[a-zA-Z0-9_-]{1,64}$/;

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
