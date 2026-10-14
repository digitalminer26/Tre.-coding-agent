# 10 — MCP support: scope (pre-implementation)

Status: **scope only — no code written.** This doc maps MCP (Model Context
Protocol) onto tre.'s existing seams, decides the open design questions, and
splits the work into tiers. It is the input to a future PLAN.md workstream
entry, not a workstream itself.

## 1. Bottom line

MCP support is a **thin adapter, not an architecture change**. tre.'s WS0
contracts already contain the exact seam MCP needs:

- an MCP tool IS a `Tool` (`types.ts`): `name` + `description` +
  `parameters` (JSON Schema) + `execute(id, args, signal, onUpdate)`.
- the tool pipeline (`tools/pipeline.ts`) already provides, per call:
  validate → `beforeToolCall` (the safety/approval hook) → execute →
  `afterToolCall`. An MCP tool rides the same pipeline unchanged.
- the wire layers send `t.parameters` **verbatim** as the function schema —
  MCP `inputSchema` objects pass through without translation.
- the system prompt derives one-liners from `tool.description` — MCP tool
  descriptions flow in for free.

**Nothing in the loop, wire, session, compaction, or TUI state machine
changes** for the core tier. The work is: a JSON-RPC-over-stdio client, a
tool adapter, a config surface, safety classification, and process
lifecycle.

## 2. What MCP is (the parts that matter here)

JSON-RPC 2.0. Transports: **stdio** (newline-delimited JSON over a child
process's stdin/stdout — the common local case) and **streamable HTTP**
(SSE; the remote case, with optional OAuth 2.1).

Protocol surface, by relevance to tre.:

| Area | Methods | Relevance |
|---|---|---|
| Lifecycle | `initialize` / `notifications/initialized` | version + capability handshake |
| Tools | `tools/list` (paginated: `nextCursor`), `tools/call` | **the core** |
| Resources | `resources/list`, `resources/read`, `resources/subscribe` | read-only context; tier 2 |
| Prompts | `prompts/list`, `prompts/get` | canned prompts; tier 2 |
| List changes | `tools/list_changed`, `resources/list_changed`, … | dynamic tool sets |
| Sampling | `sampling/createMessage` | server asks the CLIENT to run its LLM — security-sensitive, tier 3 |
| Elicitation | `elicitation/create` | server asks the USER for input — tier 3 |
| Roots | `roots/list` | server asks for workspace roots — tier 3 |

Tool result shape: `{ content: ContentBlock[], isError? }` where
`ContentBlock` is `text` | `image` (base64) | `resource_link` |
`embedded_resource`. Tools carry optional **annotations**:
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.

## 3. Seam map — where MCP lands in tre.

| tre. module | Change |
|---|---|
| `types.ts` | **None.** `Tool`/`ToolResult`/`JsonSchema` already fit. (`JsonSchema` has an index signature `[key: string]: unknown` — `$defs`, `oneOf`, `anyOf` from MCP schemas pass type-checking.) |
| `tools/pipeline.ts` | **None.** The adapter's `execute` is just another tool body; validate → safety → execute → afterToolCall all apply. |
| `tools/validate.ts` | **None** (see §5.6 — lenient validation is acceptable). |
| `tools/safety.ts` | **Small.** MCP tools need a classification (see §5.3). No new mode-matrix class required if annotations map onto existing classes. |
| `tools/sandbox.ts` | **Small.** Decide whether server *processes* run under the kernel sandbox (§5.4). |
| `cli/main.ts` | **Medium.** Config load, server spawn/teardown, `wiredTools` assembly, `--mcp` flags. This is the wiring home (like `wiredTools` today). |
| `config/tre-config.ts` | **Small.** New `mcpServers` field, same fail-closed parse posture as `extraRoots`. |
| `prompt/system-prompt.ts` | **None.** Descriptions flow through. (Context cost noted in §6.) |
| `loop/agent-loop.ts`, `wire/*`, `session/*`, `context/compact.ts` | **None** for tier 1. |
| `tui/*` | **Tiny.** The `/mcp` status command (a slash-registry entry + an info item — the same plumbing as `/stats`); tool items render by name unchanged. |

New modules (proposed): `src/mcp/config.ts`, `src/mcp/client.ts`
(JSON-RPC stdio), `src/mcp/adapter.ts` (MCP tool → `Tool` + result
mapping).

## 4. Tiers

### Tier 1 — core: stdio servers, tools only (the MVP)

1. **Config.** `mcpServers` in `tre.json` (same walk-up + `~/.tre/tre.json`
   fallback as `extraRoots` — consistent with C36):
   ```json
   { "mcpServers": {
       "fs":   { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
                 "env": { "FOO": "bar" }, "cwd": "/path",
                 "tools": ["read_file"] } } }
   ```
   `tools` = optional per-server allowlist (context-cost control, §6);
   `disabled` = skip the server entirely (no spawn, no tools — §8.3).
   Malformed entries fail startup (exit 2), like a bad `extraRoots`.
2. **Client.** Hand-rolled JSON-RPC 2.0 over stdio (newline-delimited
   JSON — NOT LSP `Content-Length` framing): spawn, `initialize`
   handshake, id-multiplexed pending-request map (the loop runs tool
   batches in parallel → concurrent `tools/call` to one server must work),
   per-call timeout, abort, server-death detection. ~300–400 lines,
   zero dependencies (fits the dep freeze; `@modelcontextprotocol/sdk`
   would add a runtime dep and is unnecessary for stdio).
3. **Adapter.** MCP tool → `Tool`: name sanitized to
   `mcp__<server>__<tool>` (OpenAI completions function names are
   `^[a-zA-Z0-9_-]{1,64}$` — the wire constraint, not MCP's);
   `description` verbatim; `inputSchema` verbatim as `parameters`;
   `execute` = `tools/call` with result mapping: text blocks →
   `TextBlock[]`; `isError` → `ToolResult.isError`; non-text blocks →
   descriptive text note (image support is a wire-layer change — out of
   scope, §5.5).
4. **Lifecycle.** Spawn at startup (after config load), kill the process
   group on every exit path (reuse the bash.ts detached-group + SIGKILL
   pattern); startup timeout (~5s); a dead server makes its tool calls
   fail in-band (`isError`: "MCP server X is not running") — I3, no
   exceptions.
5. **Safety.** §5.3 — annotations mapped onto the existing mode matrix.
6. **CLI.** `--mcp <file>` (explicit config path, tests) and
   `--mcp none` (disable all servers for a launch). `--tools` keeps
   filtering the built-in set; MCP tools are additive from enabled
   servers (the `--tools` spec is parsed before servers spawn, so it
   cannot name MCP tools — document this).
7. **`/mcp` status command** (TUI + REPL info line): one line per
   configured server — `alive (N tools)` / `dead (exit code)` /
   `disabled` (§8.4). Driver-side, like `/stats`.
8. **Tests.** Mock MCP server as a stdlib node script speaking
   newline-delimited JSON-RPC on stdio (the `test/mock-sse.ts` pattern):
   handshake, paginated `tools/list`, `tools/call` success / error /
   `isError`, crash mid-call, slow call (timeout), concurrent calls.
   Unit tests for config parse (incl. `disabled`), name sanitization,
   result mapping. One `e2e.sh` scenario: live model calls a
   mock-server tool.

**Size: M.** One focused workstream; ~1.5–2.5k lines incl. tests.

### Tier 2 — resources, prompts, dynamic lists (S–M)

- `resources/list` + `resources/read` exposed as a single
  `mcp_resource` tool (`{ server, uri }`) — consistent with "tools are
  the only seam"; no context auto-injection (that fights compaction).
- `prompts/list` + `prompts/get` as a `/mcp-prompt <server> <name>`
  slash command (expands into the input line) — prompts are user-facing,
  not model-facing.
- `tools/list_changed`: re-list at **run start** (cheap; `LlmContext.tools`
  is per-run anyway) + a `/mcp refresh` TUI command. Mid-run hot-swap is
  out of scope (the running turn keeps its tool set — same rule as
  `/models` switching).

### Tier 3 — remote + interactive (L; each item is independently M+)

- **Streamable HTTP transport** + SSE parsing + OAuth 2.1 (PKCE) for
  remote servers. Network surface, token storage (the ChatGPT-OAuth
  token store is the in-house precedent), refresh handling.
- **`sampling/createMessage`**: server-initiated LLM calls through tre.'s
  own `StreamFn`. Security-sensitive (a server can prompt the model with
  arbitrary content, and results go back to the server) — needs an
  explicit per-server capability opt-in + approval prompt.
- **`elicitation/create`**: server-initiated user prompts → TUI approval
  UI.
- **`roots/list`**: expose workspace + extra roots to servers (opt-in).

## 5. Design decisions

1. **Config home: `tre.json`.** Project-scoped servers belong to the
   project (same convention as `extraRoots`, C36); the walk-up + home
   fallback gives a global default for free. A separate `mcp.json` adds a
   second lookup convention for no benefit. `--mcp <file>` for tests and
   one-off launches.

2. **Naming: `mcp__<server>__<tool>`.** Deterministic, collision-free
   (the registry throws on duplicates), and it survives the wire's
   function-name constraint after sanitization (`-`/`_`/alnum, ≤64 —
   truncate + hash suffix if longer). The full name also makes the TUI
   and session log self-explanatory (which server a call hit).

3. **Safety: map annotations onto the EXISTING mode matrix — no new
   class.**
   | MCP annotations | tre. classification | yes (default) | ask | no |
   |---|---|---|---|---|
   | `readOnlyHint: true` | read-only | allow | allow | allow |
   | `destructiveHint: true` | ws-destructive | allow | prompt | block |
   | (no annotations) | gated (mutating) | allow | prompt | block |

   Rationale: the trust boundary is "the user configured this server in
   tre.json" — the same explicit trust as an `extraRoot`. The mode matrix
   then behaves exactly as users already expect. A server that lies in
   its annotations is a server the user chose to run; the kernel sandbox
   (§5.4) is the backstop, and `--ask` gives the cautious posture.
   Implementation: a few lines in `makeSafetyHooks` — MCP tools are
   recognized by name prefix (`mcp__`) and classified from the
   annotations the adapter stored on the `Tool` (a non-wire field, e.g.
   `tool.mcpAnnotations` — or re-derive from a side table in main.ts to
   keep `types.ts` untouched).

4. **Kernel sandbox for server processes: sandbox by default,
   per-server opt-out.** The server is a child of tre.; on macOS it runs
   under the same Seatbelt profile as bash (confined to workspace +
   extra roots) unless the config entry sets `"sandbox": false`.
   Verified 2026-10-14: that profile is FILE-confined but
   NETWORK-OPEN (no socket rules; see §8.1), so the default posture is
   "the server may talk to the network but may only touch files inside
   the roots" — exactly the right default for a server that calls its
   own APIs. Document it verbatim in the config docs.
   Linux: same policy via `sandbox-linux.ts`.

5. **Result mapping: text only in tier 1.** `ToolResult.content` is
   `TextBlock[]`; image / resource blocks become a one-line text note
   (`[mcp: server returned an image (42 KB) — not displayed]`). True
   image support means extending `ContentBlock`/`ToolResult` AND both
   wire layers' tool-message encoding — a contract change, deferred.

6. **Schema validation stays lenient.** `validate.ts` covers
   `type/required/properties/items/enum` and ignores unknown keywords —
   MCP schemas with `$defs`/`oneOf`/`anyOf` pass unchecked and the
   SERVER is the source of truth for argument validity. This is
   acceptable: the validator's job is catching obviously malformed LLM
   output, and a server rejecting bad args returns an in-band error the
   model reads (I3). Do NOT grow `validate.ts` into a spec-complete
   validator for MCP's sake.

7. **Concurrency: id-multiplexed, one connection per server.** JSON-RPC
   allows multiple in-flight requests on one connection; the pending map
   keys by request id. No per-call connection. Abort = cancel the
   pending entry (+ kill if the server misbehaves).

8. **No new runtime dependencies.** The stdio JSON-RPC client is small
   enough to hand-roll; the dep freeze (`scripts/check-deps.mjs`) stays
   green. (If tier 3's HTTP+OAuth lands, reconsider — but even there the
   in-house `wire/http.ts` + the OAuth token-store precedent make an SDK
   avoidable.)

## 6. Costs and risks

- **Context cost.** Every MCP tool adds a one-liner to the system prompt
  AND its full JSON schema to every request body. A 50-tool server is a
  real token tax. Mitigations: per-server `tools` allowlist, per-server
  `disabled` flag, and `--mcp none` (all tier 1). Document the cost in
  the config docs.
- **Third-party code execution.** An MCP server is an arbitrary process
  the model can steer. The explicit config entry is the consent; the
  sandbox (§5.4) confines the default case; tier-3 sampling/elicitation
  are opt-in capabilities. State all three in the README.
- **Wire name constraint.** Sanitize at the adapter (§5.2); test with a
  server exposing awkward names (`my.tool`, unicode, >64 chars).
- **Orphaned servers.** Crash paths must kill the process group on every
  exit path (the TUI has several — SIGINT force-exit, `/restart`,
  `process.exit` handlers). Reuse the bash.ts kill pattern; add a test
  that a killed tre. leaves no server child (the `bash-kill.test.ts`
  precedent).
- **Protocol drift.** Pin the negotiated version from `initialize`;
  unknown server versions → startup error naming both versions.
- **`tools/list` pagination.** Servers with many tools paginate; the
  client must follow `nextCursor` to the end (test with a paginating
  mock).

## 7. Effort summary

| Tier | Scope | Size |
|---|---|---|
| 1 | stdio + tools + config + safety + lifecycle + tests | **M** |
| 2 | resources, prompts, list-changed | S–M |
| 3a | streamable HTTP + OAuth | M+ |
| 3b | sampling / elicitation / roots | M each |

Tier 1 is the shippable unit: after it, `tre.` can use any local stdio
MCP server with the existing safety, TUI, session, and compaction
behavior, and zero changes outside `src/mcp/*`, `safety.ts`,
`tre-config.ts`, `main.ts`, and the TUI slash registry.

## 8. Open questions — RESOLVED (2026-10-14)

1. **Sandbox profile / network: outbound network IS allowed.** The
   generated Seatbelt policy (`generateBashSandboxPolicy`, `sandbox.ts`)
   contains NO network rules — it is `(allow default)` plus
   file-read/write denies only, so sockets pass through. Verified
   empirically 2026-10-14 from inside a sandboxed tre. session
   (`TRE_SANDBOX=1`): `cat /etc/passwd` → `Operation not permitted`
   (file deny works) while a plain HTTPS GET to
   `openrouter.ai/api/v1/models` → `200 OK` (network works).
   Consequence for §5.4: the sandboxed default posture is
   **file-confined but network-open** — a server can reach its own APIs
   (the normal case) but cannot read tre.'s files outside the roots.
   The config docs must say exactly that; no profile change needed.
2. **Naming: `mcp__<server>__<tool>` (double underscore) confirmed.**
   The dot form is cleaner but the completions wire sends tool names
   verbatim as OpenAI function names, and real-world function-name
   constraints reject dots (the Responses wire already sanitizes call
   IDs to `[A-Za-z0-9_-]` for the same reason — `sanitizeCallId`).
   Double underscores survive both wires unsanitized, are sortable, and
   make the TUI/session log self-explanatory. The adapter still runs
   the sanitizer as a backstop (truncate to 64 + hash suffix for
   pathological server/tool names).
3. **Per-server `disabled` flag: IN tier 1.** It is the cheapest context
   control (a one-key config parse + a skip in the wiring loop — no new
   code path), and §6's context cost is the top practical complaint
   about MCP adoption. Shape: `"disabled": true` on the server entry —
   the server is NOT spawned and its tools are absent; `/mcp` (Q4)
   lists it as `disabled`.
4. **`/mcp` status command: IN tier 1.** One line per server:
   `name — alive (N tools) | dead (exit 1) | disabled`. It is the only
   way to see server health, it reuses the existing slash-command
   plumbing (a `handleSlashCommand` entry like `/stats`, which already
   takes a measured value from the driver), and the driver already
   tracks liveness for in-band failure messages.

   The config shape gains `disabled` accordingly:
   ```json
   { "mcpServers": {
       "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
               "env": { "FOO": "bar" }, "cwd": "/path",
               "tools": ["read_file"], "disabled": false } } }
   ```
