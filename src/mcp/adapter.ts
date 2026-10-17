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
import {
  McpBusyError,
  McpCallError,
  McpError,
  type McpClient,
  type McpState,
  type McpTool,
  type McpToolCallResult,
} from "./client.js";

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
  // Per-tool annotations (from the server's tools/list — the client preserves
  // them in McpTool.annotations) WIN over the import-level fallback: the
  // approval gate classifies EACH tool by its own readOnlyHint/destructiveHint.
  // The old code read only the import-level `annotations` (which the registry
  // never set), so real imported tools never carried mcpAnnotations.
  const ann = tool.annotations !== undefined ? tool.annotations : annotations;
  if (ann !== undefined) t.mcpAnnotations = ann;
  return t;
}

/**
 * The single `mcp_resource` tool (scope §Tier 2 — resources): ONE tool that
 * takes `server` + `uri` as arguments, covering `resources/list` (empty
 * `uri`) and `resources/read` (non-empty `uri`) across ALL ready servers.
 *
 * It is NOT a per-server, server-provided tool: the wire name is tre.'s own
 * fixed name `mcp_resource` (NOT `mcp__…`), so the per-server `tools`
 * allowlist does not apply to it, and the safety hooks' `mcp__`
 * classification branch never matches it — it falls through to allow in
 * every mode, the correct posture for a read-only resource reader.
 */
export interface McpResourceTool extends Tool {
  displayName: string;
  mcpTrusted: boolean;
}

/** A per-server resource lookup (built by the registry from its handles):
 *  the client to call (READY servers only), plus the server's LIVE state +
 *  reason (so a not-found / not-ready error can list every configured
 *  server and its state). `null` when the name is not configured at all.
 *  A torn-down client (fail/close ran) cannot serve calls — the lookup
 *  reports its startup state for the message but the ADAPTER also checks
 *  liveness itself, so routing matches reality rather than the snapshot. */
export type McpResourceLookup = (
  serverName: string,
) => { client: McpClient | null; state: McpState; reason: string } | null;

/** A configured server's summary (name + state + reason) — used to build
 *  the not-ready / unknown-server error so the model can self-correct. */
export interface McpResourceServerInfo {
  name: string;
  state: McpState;
  reason: string;
}

/** The total output cap for a resource read (64 KiB — UTF-8 BYTES, not
 *  chars: a char count would let a CJK body exceed the cap by up to 3×). */
const RESOURCE_OUTPUT_CAP = 64 * 1024;

/** Truncate `text` to at most `RESOURCE_OUTPUT_CAP` UTF-8 bytes WITHOUT
 *  splitting a multi-byte code point (a code point that would straddle the
 *  boundary is dropped whole). Returns the text unchanged when it fits.
 *  O(n) over code points — a resource body is at most a few MB, so a scan
 *  is fine (no binary search). */
function capToBytes(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= RESOURCE_OUTPUT_CAP) return text;
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    const cb = Buffer.byteLength(ch, "utf8");
    if (bytes + cb > RESOURCE_OUTPUT_CAP) break;
    bytes += cb;
    out += ch;
  }
  return out;
}

/** `a (ready), b (failed: reason), c (disabled)` — the configured-server
 *  list for the not-ready / unknown-server error. */
function describeServers(servers: McpResourceServerInfo[]): string {
  return servers
    .map((s) => s.name + " (" + s.state + (s.reason ? ": " + s.reason : "") + ")")
    .join(", ");
}

/** Build the single `mcp_resource` tool. `lookup` resolves a server name to
 *  its client + state (ready servers only are callable); `servers` is the
 *  full configured set (listed in the not-ready / unknown-server error so
 *  the model can self-correct). `execute` NEVER throws — every failure is an
 *  in-band isError result. */
export function makeMcpResourceTool(
  lookup: McpResourceLookup,
  servers: McpResourceServerInfo[],
): McpResourceTool {
  return {
    name: "mcp_resource",
    description:
      "Read a resource from a connected MCP server (read-only). List available resources first by calling this tool with an empty uri — it then returns the server's resource list.",
    parameters: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "The MCP server name (as shown by /mcp)",
        },
        uri: {
          type: "string",
          description:
            "The resource URI to read. Empty string = list the server's resources instead.",
        },
      },
      required: ["server"],
      additionalProperties: false,
    },
    execute: async (
      _toolCallId: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<ToolResult> => {
      const fail = (text: string): ToolResult => ({
        content: [{ type: "text", text }],
        isError: true,
      });
      const server = args.server;
      if (typeof server !== "string" || server.length === 0) {
        return fail("mcp_resource: `server` must be a non-empty string");
      }
      const entry = lookup(server);
      if (!entry) {
        return fail(
          `mcp_resource: unknown MCP server "${server}" — configured servers: ` +
            describeServers(servers),
        );
      }
      if (entry.state !== "ready" || !entry.client || entry.client.isClosed()) {
        const tornDown = entry.client?.isClosed() === true;
        return fail(
          `mcp_resource: MCP server "${server}" is not ready (state: ${entry.state}` +
            (tornDown ? " — client torn down" : "") +
            (entry.reason ? ` — ${entry.reason}` : "") +
            `) — configured servers: ${describeServers(servers)}`,
        );
      }
      const client = entry.client;
      const uri = typeof args.uri === "string" ? args.uri : "";
      // Cap the output at RESOURCE_OUTPUT_CAP UTF-8 BYTES (capToBytes never
      // splits a code point); when truncated, append the note on its own
      // line (N = the PRE-truncation byte length). Shared by the list and
      // read paths so both cap identically.
      const capText = (text: string): string =>
        Buffer.byteLength(text, "utf8") > RESOURCE_OUTPUT_CAP
          ? capToBytes(text) +
            `\n[output truncated to 64 KiB — ${Buffer.byteLength(text, "utf8")} bytes total]`
          : text;
      try {
        if (signal.aborted) {
          return fail("mcp_resource: aborted before the call was made");
        }
        if (uri === "") {
          // The caller's signal is threaded: an abort during a (possibly
          // multi-page) list cancels the in-flight request in-band, matching
          // the read path.
          const list = await client.listResources(signal);
          const header = `resources for ${server} (${list.length}):`;
          const text = list.length === 0
            ? header
            : header + "\n" + JSON.stringify(list, null, 2);
          return { content: [{ type: "text", text: capText(text) }] };
        }
        const read = await client.readResource(uri, signal);
        const blocks: TextBlock[] = [];
        for (const c of read.contents) {
          if (typeof c.text === "string") {
            blocks.push({ type: "text", text: c.uri + "\n" + c.text });
          } else if (c.blob !== undefined) {
            const mime = c.mimeType ?? "unknown";
            // Decoded byte count of the base64 blob (padding-aware; the blob
            // itself is NOT decoded into memory — only its size is computed).
            const bytes = Buffer.byteLength(c.blob, "base64");
            blocks.push({
              type: "text",
              text: `[binary resource ${c.uri} (${mime}, ${bytes} bytes base64) — text not available]`,
            });
          } else {
            blocks.push({
              type: "text",
              text: `[resource ${c.uri} has no text or blob content]`,
            });
          }
        }
        const out = capText(blocks.map((b) => b.text).join("\n\n"));
        const result: ToolResult = {
          content: [{ type: "text", text: out }],
        };
        if (read.isError) result.isError = true;
        return result;
      } catch (e) {
        if (e instanceof McpCallError || e instanceof McpBusyError || e instanceof McpError) {
          return fail(`mcp_resource: ${e.message}`);
        }
        throw e;
      }
    },
    displayName: "mcp_resource",
    mcpTrusted: true,
  };
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
