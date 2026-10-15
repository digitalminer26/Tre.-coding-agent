/**
 * WS12 — MCP tool adapter (scope: docs/10-mcp-scope.md §4.3).
 *
 * Turns a ready server's `McpTool[]` (from `client.start()`) into tre.
 * `Tool`s the loop can dispatch, plus the result mapping the loop expects.
 * The client already does the wire-level result mapping (`mapCallResult` →
 * `{ texts, isError }`); this adapter wraps that into a `ToolResult` and
 * carries the non-wire side-table fields the TUI / approval gate / logs read.
 *
 * Wire name (§4.3): `mcp__<server-identity>__<tool-identity>`, each
 * component a bounded ASCII slug plus a fixed-length hash of the ORIGINAL
 * UTF-8 identity (even for short names; only the slug is truncated). The
 * hash makes the encoding injective — it distinguishes `a.b` from `a_b` and
 * prevents embedded-`__` ambiguity. The wire name is the ONLY thing the
 * model, the approval gate, and the provider see; the human-facing name is
 * the separate `displayName` (`<server>/<tool>`, original identities). The
 * original MCP tool name is preserved for `tools/call`.
 *
 * Collision policy (§4.3): if a server's encoded tool name collides with a
 * built-in or another imported name, that server's import is rejected
 * ATOMICALLY (none of its tools register), the conflicting original
 * identities are reported, and the other servers continue. Duplicate
 * registration never aborts launch.
 *
 * `mcpTrusted` / `mcpServer` / `mcpTool` / `displayName` are NON-WIRE
 * fields on the adapted `Tool` (the same side-table posture the loop uses
 * for tool metadata) — the approval gate (§5.3) reads `mcpTrusted`, the TUI
 * reads `displayName`, and session entries store the wire name + the
 * server/tool pair.
 */
import { createHash } from "node:crypto";
import type { JsonSchema, TextBlock, Tool, ToolResult } from "../types.js";
import type { McpTool, McpToolCallResult } from "./client.js";

/** The wire-name constraint (scope §4.3): `mcp__<server>__<tool>` within
 *  `^[a-zA-Z0-9_-]{1,64}$`. */
const WIRE_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Per-component max length. `mcp__`(5) + 28 + `__`(2) + 28 = 63 ≤ 64, so
 *  the full wire name always satisfies the constraint by construction. */
const COMPONENT_MAX = 28;
/** Fixed-length hash of the original identity (hex). 10 chars = 40 bits —
 *  collision-resistant for a small tool set. */
const HASH_LEN = 10;

/** Replace every char outside `[a-zA-Z0-9_-]` with `_` (iterates code
 *  points, so multi-byte / emoji chars become a single `_`). */
function sanitizeSlug(identity: string): string {
  let s = "";
  for (const ch of identity) {
    s += /[a-zA-Z0-9_-]/.test(ch) ? ch : "_";
  }
  return s;
}

/** Fixed-length (HASH_LEN) hex prefix of the SHA-256 of the ORIGINAL UTF-8
 *  identity. This is what makes the encoding injective. */
function hashIdentity(identity: string): string {
  return createHash("sha256").update(identity, "utf8").digest("hex").slice(0, HASH_LEN);
}

/** Encode ONE identity (server or tool) into a bounded component: a
 *  truncated ASCII slug + `_` + a fixed-length hash of the original. The
 *  result is ≤ COMPONENT_MAX chars and only `[a-zA-Z0-9_-]`. */
function encodeComponent(identity: string): string {
  const suffix = "_" + hashIdentity(identity); // 1 + HASH_LEN chars
  const slugMax = COMPONENT_MAX - suffix.length;
  let slug = sanitizeSlug(identity).slice(0, slugMax);
  if (slug.length === 0) slug = "x"; // the identity was entirely non-ASCII
  return slug + suffix;
}

/** Encode the full WIRE name for a (server, tool) pair. Throws only if the
 *  (impossible-by-construction) result violates the wire constraint — a
 *  defensive invariant, not an expected path. */
export function encodeMcpToolName(server: string, tool: string): string {
  const name = "mcp__" + encodeComponent(server) + "__" + encodeComponent(tool);
  if (!WIRE_RE.test(name)) {
    throw new Error(`MCP wire name violates the constraint: ${name}`);
  }
  return name;
}

/** A tre. `Tool` adapted from an MCP tool. The non-wire fields (`displayName`,
 *  `mcpServer`, `mcpTool`, `mcpTrusted`, `mcpAnnotations`) are the side
 *  table the TUI / approval gate / logs read; the wire `name` is the only
 *  thing the model + provider + gate see. */
export interface AdaptedMcpTool extends Tool {
  /** Human-facing name: `<server>/<tool>` (original MCP identities). */
  displayName: string;
  /** Original MCP server identity. */
  mcpServer: string;
  /** Original MCP tool identity (the name sent to `tools/call`). */
  mcpTool: string;
  /** trust flag (§5.3) — the approval gate reads this. */
  mcpTrusted: boolean;
  /** The server's annotations (passed through, non-wire). */
  mcpAnnotations?: unknown;
}

/** The caller's call seam: invoke the server's tool by its ORIGINAL name and
 *  return the client's mapped result. `signal` is threaded so the caller can
 *  abort (e.g. via `client.abortCall(toolName)` on `signal.aborted`). */
export type McpCallFn = (
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<McpToolCallResult>;

/** Build ONE adapted `Tool` from an MCP tool. `wireName` is the encoded name
 *  (the caller computed it, so collision checks and the returned `Tool.name`
 *  agree). `trusted` is the server's `trust` flag (§5.3). */
export function makeMcpTool(
  server: string,
  tool: McpTool,
  wireName: string,
  call: McpCallFn,
  trusted: boolean,
  annotations?: unknown,
): AdaptedMcpTool {
  const t: AdaptedMcpTool = {
    name: wireName,
    description: tool.description ?? `MCP tool ${tool.name} (server ${server})`,
    parameters: (tool.inputSchema as JsonSchema) ?? { type: "object", properties: {} },
    execute: async (
      _toolCallId: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<ToolResult> => {
      // Preserve the ORIGINAL tool name for tools/call (the wire name is
      // transport-only). The client maps the result (texts + isError).
      const res = await call(tool.name, args, signal);
      const content: TextBlock[] = res.texts.map((text) => ({ type: "text", text }));
      const out: ToolResult = { content };
      if (res.isError) out.isError = true;
      return out;
    },
    displayName: `${server}/${tool.name}`,
    mcpServer: server,
    mcpTool: tool.name,
    mcpTrusted: trusted,
  };
  if (annotations !== undefined) t.mcpAnnotations = annotations;
  return t;
}

/** One successfully-imported tool (the adapted `Tool` + its original
 *  identities, so session entries can store the wire name + the pair). */
export interface McpImportedTool {
  tool: AdaptedMcpTool;
  serverName: string;
  toolName: string;
  wireName: string;
}

/** A rejected server import (atomic — none of its tools register). */
export interface McpImportRejection {
  server: string;
  /** The original tool identities that collided (with a built-in or another
   *  imported name, or a duplicate within this server). */
  conflicting: string[];
}

export interface McpImportOutcome {
  /** The adapted tools to register (empty when the server was rejected). */
  imported: McpImportedTool[];
  /** Set when the server's import was rejected atomically. */
  rejected: McpImportRejection | null;
}

/** Import ONE server's tools into tre. (scope §4.3). Pure with respect to
 *  `claimed`: it does NOT mutate it — the caller adds the returned
 *  `imported` wire names to `claimed` after a successful import.
 *
 *  Collision (→ atomic rejection of this server): an encoded name that is
 *  already in `claimed` (a built-in or a previously-imported MCP tool), or a
 *  duplicate within this server's own tool list. The other servers continue;
 *  a rejection is data (report it), never a launch abort. */
export function importMcpServerTools(
  server: string,
  tools: McpTool[],
  call: McpCallFn,
  claimed: ReadonlySet<string>,
  opts?: { trusted?: boolean; annotations?: unknown },
): McpImportOutcome {
  const trusted = opts?.trusted ?? false;
  const annotations = opts?.annotations;
  const seen = new Map<string, string>(); // wireName -> original tool name
  const collisions: string[] = [];
  const encoded: Array<{ tool: McpTool; wire: string }> = [];
  for (const t of tools) {
    const wire = encodeMcpToolName(server, t.name);
    if (claimed.has(wire)) {
      collisions.push(t.name);
    } else if (seen.has(wire)) {
      // Duplicate within this server (two tools encoding to the same name).
      collisions.push(t.name);
    } else {
      seen.set(wire, t.name);
      encoded.push({ tool: t, wire });
    }
  }
  if (collisions.length > 0) {
    return { imported: [], rejected: { server, conflicting: collisions } };
  }
  const imported = encoded.map(({ tool, wire }) => ({
    tool: makeMcpTool(server, tool, wire, call, trusted, annotations),
    serverName: server,
    toolName: tool.name,
    wireName: wire,
  }));
  return { imported, rejected: null };
}
