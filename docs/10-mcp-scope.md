# 10 — MCP support: scope (pre-implementation)

Status: **scope only — no code written.** Scoped against protocol revision
**2026-07-28** (current; re-checked against the live spec 2026-10-14 — see
§8.5). Tier 1 is a **dual-era** stdio client: it probes `server/discover`
first (modern, 2026-07-28) and falls back to the `initialize` handshake
(legacy, 2025-11-25 — what the ecosystem ships today), so it speaks both
eras (ruling in §5.9, re-audited 2026-10-14). This doc maps MCP (Model
Context Protocol) onto tre.'s existing seams, decides the open design
questions, and splits the work into tiers. It is the input to a future
PLAN.md workstream entry, not a workstream itself.

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
(the remote case, with OAuth 2.1).

**Protocol eras (2026-07-28 revision).** The current spec is STATELESS: the
`initialize`/`notifications/initialized` handshake is REMOVED — every request
carries its protocol version + client capabilities in `_meta`
(`io.modelcontextprotocol/protocolVersion`, `…/clientCapabilities`), and
servers MUST implement `server/discover` (version/capability/identity probe).
Versions `2025-11-25` and earlier are "legacy" (handshake-based) — and they
are what the ecosystem's published servers still ship: the official
`@modelcontextprotocol/server-*` packages depend on the v1 SDK line
(`@modelcontextprotocol/sdk` 1.x — the *maintenance* line, legacy-only by
design). The modern era IS implemented by the official SDK: the **v2 line**
(`@modelcontextprotocol/{core,client,server}` 2.x, stable since 2026-10-05)
implements 2026-07-28 (era negotiation, `server/discover`, MRTR) — a
reference implementation and a buildable modern test server both exist.
**Ruling (§5.9): tier 1 is DUAL-ERA** — the client probes `server/discover`
first and falls back to `initialize`, so it speaks both eras (the spec's
own compatibility matrix: a modern-only client FAILS against a legacy
server, so a client that reaches the ecosystem must handle legacy).

Protocol surface, by relevance to tre. (2026-07-28):

| Area | Methods | Relevance |
|---|---|---|
| Tools | `tools/list` (paginated: `nextCursor`), `tools/call` | **the core** |
| Legacy startup | `initialize` / `notifications/initialized` | 2025-11-25 era — tier 1 (probe fallback, §5.9) |
| Resources | `resources/list`, `resources/read` | read-only context; tier 2 |
| Prompts | `prompts/list`, `prompts/get` | canned prompts; tier 2 |
| List changes | `tools/list_changed` (legacy era) | dynamic tool sets — tier 2 (we do NOT subscribe; §4) |
| Discovery | `server/discover` | modern-era probe — **era detection** in tier 1 (§5.9) |
| MRTR | `resultType: "input_required"` + `inputRequests`/`inputResponses` | modern era; replaces server-initiated requests — tier 3 |
| Elicitation | via MRTR (`elicitation/create` inside `inputRequests`) | server asks the USER for input — tier 3 |
| Sampling | via MRTR — **DEPRECATED** (removal ≥ 2027-07-28) | do not implement (§4 tier 3) |
| Roots | `roots/list` — **DEPRECATED** (removal ≥ 2027-07-28) | do not implement (§4 tier 3) |

Tool result shape: `{ content: ContentBlock[], isError? }` where
`ContentBlock` is `text` | `image` (base64) | `audio` (base64) |
`resource_link` | `embedded_resource`. Tools carry optional **annotations**:
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.

## 3. Seam map — where MCP lands in tre.

| tre. module | Change |
|---|---|
| `types.ts` | **None.** `Tool`/`ToolResult`/`JsonSchema` already fit. (`JsonSchema` has an index signature `[key: string]: unknown` — `$defs`, `oneOf`, `anyOf` from MCP schemas pass type-checking.) |
| `tools/pipeline.ts` | **None.** The adapter's `execute` is just another tool body; validate → safety → execute → afterToolCall all apply. |
| `tools/validate.ts` | **None** (see §5.6 — lenient validation is acceptable). |
| `tools/safety.ts` | **Medium.** `makeSafetyHooks` classifies tools by NAME (`bash`, `read`, `write`, `edit`); any other name falls through to allow — in every mode, including `--no`. MCP tools need an explicit `mcp__` branch (default-ask + per-server trust, §5.3) or they bypass the approval gate. |
| `tools/sandbox.ts` | **Small.** Server processes are NOT sandboxed by default (§5.4); the opt-in path reuses the existing spawn. |
| `cli/main.ts` | **Medium.** Config load, server spawn/teardown, `wiredTools` assembly, `--mcp` flags. This is the wiring home (like `wiredTools` today). |
| `config/tre-config.ts` | **Small.** New `mcpServers` field, same fail-closed parse posture as `extraRoots`. |
| `prompt/system-prompt.ts` | **None.** Descriptions flow through. (Context cost noted in §6.) |
| `loop/agent-loop.ts`, `wire/*`, `session/*`, `context/compact.ts` | **None** for tier 1. |
| `tui/*` | **Tiny.** The `/mcp` status command (a slash-registry entry + an info item — the same plumbing as `/stats`); tool items render by name unchanged. |

New modules (proposed): `src/mcp/config.ts`, `src/mcp/client.ts`
(JSON-RPC stdio, dual-era: `server/discover` probe → modern, `initialize`
fallback → legacy — §5.9), `src/mcp/adapter.ts` (MCP tool → `Tool` +
result mapping).

## 4. Tiers

### Tier 1 — core: stdio servers, tools only (the MVP)

1. **Config.** `mcpServers` in `tre.json` (same walk-up + `~/.tre/tre.json`
   fallback as `extraRoots` — consistent with C36):
   ```json
   { "mcpServers": {
       "fs":   { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
                 "env": { "FOO": "bar" }, "cwd": "/path",
                 "tools": ["read_file"], "trust": true, "sandbox": true } } }
   ```
   `tools` = optional per-server allowlist (context-cost control, §6);
   `disabled` = skip the server entirely (no spawn, no tools — §8.3);
   `trust` = opt the server's tools into the default-`yes` mode (default
   is `false` — MCP tools prompt in `ask`/gate in `no` until trusted,
   §5.3); `sandbox` = opt the server PROCESS into the kernel sandbox
   (default is `false` — §5.4). Malformed entries fail startup (exit 2),
   like a bad `extraRoots`.
2. **Client (dual-era).** Hand-rolled JSON-RPC 2.0 over stdio
   (newline-delimited JSON — NOT LSP `Content-Length` framing): spawn →
   **era probe** (§5.9) → `tools/list`. id-multiplexed pending-request
   map (the loop runs tool batches in parallel → concurrent `tools/call`
   to one server must work), per-call timeout, abort
   (`notifications/cancelled` referencing the request id), server-death
   detection. Both eras share the same plumbing (framing, pending map,
   timeout, abort, death detection) — only the startup path and the
   per-request `_meta` envelope differ.

   **Era probe — exact contract.** The probe is one `server/discover`
   request carrying the modern envelope: `RequestParams` REQUIRES
   `_meta`, and `RequestMetaObject` requires
   `io.modelcontextprotocol/protocolVersion` +
   `io.modelcontextprotocol/clientCapabilities` (plus the SHOULD
   `…/clientInfo` {name, version}). The client declares its highest
   version, `2026-07-28`, on the probe. The response maps to exactly ONE
   of three outcomes — there is deliberately NO "any other response =
   legacy" bucket:

   | Probe response | Outcome | Action |
   |---|---|---|
   | `result` validating as `DiscoverResult` (`resultType` + `supportedVersions` present) **or** error `-32022` (UnsupportedProtocolVersionError, `data.requested`/`data.supported`) | **MODERN** | pick a mutually supported version from `supported`/`supportedVersions`; cache the era; every later request carries the `_meta` envelope (`protocolVersion` = negotiated, `clientCapabilities`, `clientInfo`) |
   | error `-32601` (MethodNotFound) **or** the bounded probe timeout (2s) | **LEGACY** | `initialize` handshake → `notifications/initialized` (2025-11-25); cache the era |
   | anything else — transport failure (process exit, non-JSON stdout, EOF), `-32700` ParseError, any other error code (`-32600`/`-32602`/`-32603`/…), or a `result` that fails `DiscoverResult` validation | **FATAL** | do NOT fall back; report the observed error (server name + what arrived); tools absent |

   Only `-32601` and the probe timeout trigger the legacy fallback; a
   genuine server fault is surfaced, never masked as "legacy". The era
   is cached per server process. A server that fails both the probe and
   `initialize` is reported once with the observed error, its tools
   absent. ~600 lines, zero dependencies (fits the dep freeze;
   `@modelcontextprotocol/sdk` would add a runtime dep and is
   unnecessary for stdio — the v2 line is available as a PINNED test
   oracle, §4.8/§5.9).
3. **Adapter.** MCP tool → `Tool`: name sanitized to
   `mcp__<server>__<tool>` (OpenAI completions function names are
   `^[a-zA-Z0-9_-]{1,64}$` — the wire constraint, not MCP's);
   `description` verbatim; `inputSchema` verbatim as `parameters`;
   `execute` = `tools/call` with result mapping: text blocks →
   `TextBlock[]`; `isError` → `ToolResult.isError`; non-text blocks
   (image/audio/resource) → descriptive text note (true support is a
   wire-layer change — out of scope, §5.5). **`structuredContent` —
   deterministic rule.** If `content` has ≥1 non-empty text block, the
   result is `[text blocks…]` then `structuredContent` APPENDED as one
   final text block (`JSON.stringify`, 2-space indent, header
   `[structuredContent]`); if `content` is absent/empty/all-blank,
   `structuredContent` is the SOLE payload (no header). Presence and
   emptiness decide — there is no "generic text" heuristic.
4. **Lifecycle.** Per-server isolation: **one server's startup failure
   never aborts the launch** — each server fails independently (its
   tools absent, a one-line notice), the others proceed. Spawn at
   startup (after config load), kill the process group on every exit
   path (reuse the bash.ts detached-group + SIGKILL pattern). Concrete
   timeouts: **probe 2s** (§4.2), **startup 5s total** (spawn + probe +
   `initialize` + `tools/list`), **per-call 60s**, **shutdown grace**:
   close stdin → wait 2s → SIGTERM → wait 2s → SIGKILL (mirrors the
   bash kill pattern). A dead server makes its tool calls fail in-band
   (`isError`: "MCP server X is not running") — I3, no exceptions. State
   is one of `disabled | starting | ready | failed`, where `failed`
   carries the observed reason (probe error / handshake error / exit
   code).
5. **Safety.** §5.3 — MCP tools default to ASK (prompt in `yes`/`ask`,
   block in `no`) unless the server is `"trust": true`; `readOnlyHint` is
   honored even for untrusted servers.
6. **CLI.** `--mcp <file>` (explicit config path, tests) and
   `--mcp none` (disable all servers for a launch). `--tools` keeps
   filtering the built-in set; MCP tools are additive from enabled
   servers, so `--tools` **cannot name or filter MCP tools** — the
   per-server `tools` allowlist (§4.1) is the MCP-scoped equivalent.
   Document this explicitly (it is the one CLI asymmetry).
7. **`/mcp` status command** (TUI + REPL info line): one line per
   configured server, reflecting the §4.4 state —
   `ready (N tools) | starting | failed (<reason>) | disabled`,
   e.g. `fs — ready (3 tools)`, `db — failed (probe: -32603)`,
   `remote — disabled`. Driver-side, like `/stats`.
8. **Tests.** Mock MCP servers as stdlib node scripts speaking
   newline-delimited JSON-RPC on stdio (the `test/mock-sse.ts` pattern):
   a LEGACY server (`initialize` handshake, 2025-11-25 — paginated
   `tools/list`, `tools/call` success / protocol error / `isError`,
   `structuredContent`, crash mid-call, slow call (timeout), concurrent
   calls) and a MODERN server (answers `server/discover`). **The legacy
   mock MUST assert it receives the initial `server/discover` probe and
   reply `-32601`** (the documented fallback trigger) — the fallback is
   a tested contract, not an accident. **The modern mock MUST assert the
   exact `_meta` envelope** on `tools/list` and `tools/call`
   (`protocolVersion` = negotiated, `clientCapabilities` present,
   `clientInfo`), and assert the client sends NO `initialize`.
   **Negotiation-failure coverage (the §4.2 table, one test per row):**
   `-32022` → modern; `-32601` → legacy; probe timeout → legacy; a
   `DiscoverResult` that fails validation → fatal; `-32603` / other
   error → fatal; malformed JSON on stdout → fatal; process exit during
   probe → fatal; `initialize` also rejected after a legacy probe →
   reported, no crash. **Lifecycle coverage:** per-call timeout, abort
   (`notifications/cancelled`), a killed `tre.` leaves no server child
   (the `bash-kill.test.ts` precedent), and one server failing at
   startup leaves the others ready. Unit tests for config parse (incl.
   `disabled`, `trust`, `sandbox`), name sanitization (awkward names:
   dots, unicode, >64 chars), result-mapping (`structuredContent`
   append-vs-sole rule), and safety classification (trusted vs untrusted
   × mode matrix, incl. the `readOnlyHint` boundary of §5.3). **One
   GATED live-model `e2e.sh` scenario** (opt-in like `RUN_LIVE=1`, not
   in the default gate — it needs credentials and can flake): live model
   calls a mock-server tool. The **deterministic mock-server tests are
   the required gate**; the live scenario is optional confirmation.
   **SDK oracle:** the official v2 SDK (`@modelcontextprotocol/server`)
   is a **dev-only dependency with a PINNED exact version** — added to
   `devDependencies` only, never imported by `src/`, so `check-deps.mjs`
   (which scans `src/`) stays green; used to cross-check the modern path
   in a dedicated test, not to drive runtime behavior.

**Size: M.** One focused workstream; ~1.5–2.5k lines incl. tests.

### Tier 2 — resources, prompts, dynamic lists (S–M)

- `resources/list` + `resources/read` exposed as a single
  `mcp_resource` tool (`{ server, uri }`) — consistent with "tools are
  the only seam"; no context auto-injection (that fights compaction).
- `prompts/list` + `prompts/get` as a `/mcp-prompt <server> <name>`
  slash command (expands into the input line) — prompts are user-facing,
  not model-facing.
- `tools/list_changed`: legacy era delivers it as
  `notifications/tools/list_changed` after the handshake (modern era: an
  opt-in `subscriptions/listen` stream). We do NOT subscribe — we
  re-list at **run start** (cheap; `LlmContext.tools` is per-run anyway)
  + a `/mcp refresh` TUI command. Mid-run hot-swap is out of scope (the
  running turn keeps its tool set — same rule as `/models` switching).

### Tier 3 — remote + interactive (L; each item is independently M+)

- **Streamable HTTP transport** for remote servers (2026-07-28 shape:
  stateless — no `Mcp-Session-Id`; required `Mcp-Method`/`Mcp-Name`
  headers; no SSE resumability — a broken response stream loses the
  request, which must be re-issued with a new id) + OAuth 2.1 (PKCE),
  RFC 9207 `iss` validation, credentials keyed by issuer (re-register on
  authorization-server change), Client ID Metadata Documents (Dynamic
  Client Registration is deprecated). Network surface, token storage
  (the ChatGPT-OAuth token store is the in-house precedent), refresh
  handling.
- **MRTR (`input_required`)**: server requests for additional input
  mid-call (elicitation, sampling, roots all arrive this way in the
  modern era). tre. drives the loop: `resultType: "input_required"` →
  surface `inputRequests` to the user (TUI approval UI) → retry the
  original `tools/call` with `inputResponses`. Security-sensitive
  (a server can prompt the user or ask tre.'s model to run — results go
  back to the server) — explicit per-server capability opt-in + approval
  prompt.
- **NOT implemented (deliberate):** `sampling/createMessage` and
  `roots/list` — both DEPRECATED in 2026-07-28 (removal eligible
  2027-07-28); the spec's own migration is "integrate directly with LLM
  provider APIs" / "pass directories via tool parameters or server
  configuration". Building them would be adopting a sunset feature.

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

3. **Safety: MCP tools default to ASK — trust is per-server, explicit.**
   MCP tools do NOT inherit the mode-matrix defaults, because the mode
   matrix's `yes`/`no` semantics are about tre.'s OWN tools (whose
   behavior the user knows); an MCP server is third-party code the model
   can steer, and its annotations are untrusted data (the spec says
   annotations are only meaningful from a trusted server). Default
   posture: **`ask` mode → prompt per call; `no` mode → block; `yes`
   mode → still prompt, unless the server is trusted.** Per-server
   `"trust": true` opts the server into the default `yes` behavior
   (allow in `yes`, prompt in `ask`, block in `no`) — i.e. the same
   posture as built-in mutating tools.
   | MCP annotations | tre. classification | trusted: `yes` | trusted: `ask` | trusted: `no` | untrusted: any mode |
   |---|---|---|---|---|---|
   | `readOnlyHint: true` | read-only | allow | allow | allow | allow |
   | `destructiveHint: true` | ws-destructive | allow | prompt | block | prompt |
   | (no annotations) | gated (mutating) | allow | prompt | block | prompt |

   (Untrusted + `no` mode: the "prompt" cells become block — `no` mode
   allows no prompts.) Rationale: configuring a server in tre.json is
   consent to RUN it, not consent to let the model drive it unattended —
   the same distinction as `extraRoots` (a root lets tre. touch files; it
   does not auto-approve writes). Untrusted servers are read-only by
   default: `readOnlyHint: true` is honored (a read-only tool doing reads
   is what the user configured), everything else prompts. A server that
   lies in its annotations is a server the user chose to run; the kernel
   sandbox (§5.4, opt-in) is the backstop, and `--ask` gives the cautious
   posture for built-ins.
   Implementation: a `mcp__` branch in `makeSafetyHooks` — the adapter
   stores the annotations + trust flag on the `Tool` (a non-wire field,
   e.g. `tool.mcpAnnotations` / `tool.mcpTrusted` — or a side table in
   main.ts to keep `types.ts` untouched).

   **`readOnlyHint` boundary (important).** Honoring `readOnlyHint` for
   an untrusted server means only "classify this call as read-only for
   the APPROVAL POLICY" — it is NOT a grant of filesystem or network
   access, and it does not relax process permissions. Annotation trust
   and process confinement are independent axes: a server that lies in
   its annotations still runs under exactly the same process posture
   (§5.4: unsandboxed by default, sandboxed only on opt-in). Nothing
   about `readOnlyHint` changes what the process may touch.

4. **Kernel sandbox for server processes: OFF by default, per-server
   opt-in.** The server is a child of tre.; it runs under the same
   Seatbelt profile as bash (file-confined to workspace + extra roots,
   network-open — §8.1) only when the config entry sets
   `"sandbox": true`. Default is no sandbox. Rationale: MCP servers
   routinely read their own state (config files, caches, token stores)
   outside the workspace — the filesystem server reads the directories it
   serves, which are exactly the paths a user points it at and may sit
   outside the roots; sandboxing by default would break the common case
   on day one. The config entry is still the consent (the user chose to
   run this process), `trust` (§5.3) controls model-driven calls, and
   `"sandbox": true` is the extra backstop for servers the user does not
   fully trust. Linux: same policy via `sandbox-linux.ts`.

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

9. **Dual-era client (2026-07-28 ruling, re-audited 2026-10-14).** The
   current spec revision removed the `initialize` handshake (stateless,
   per-request `_meta`, `server/discover`), and the ecosystem's published
   servers are overwhelmingly legacy (2025-11-25 and earlier — every
   official `@modelcontextprotocol/server-*` package depends on the v1
   SDK line). The spec's own compatibility matrix says a modern-only
   client FAILS against a legacy server — so a client that wants to reach
   the ecosystem MUST handle legacy. Ruling: tier 1 is DUAL-ERA via the
   spec's stdio probe — `server/discover` first (the exact three-way
   decision table is §4.2: modern on a valid `DiscoverResult`/`-32022`,
   legacy on `-32601`/timeout, FATAL on anything else); the negotiated
   version is cached per server process; both eras
   share the same JSON-RPC plumbing (framing, id-multiplexed pending map,
   timeout, abort, death detection). A server failing both probes is
   reported with an actionable message naming the observed error, its
   tools absent.
   **Audit correction (2026-10-14).** An earlier same-day re-rule had
   narrowed this to legacy-only on the premise that "the official
   TypeScript SDK has no modern-era support — no reference implementation
   to validate against." That premise was wrong: it is true of the v1
   *package* (`@modelcontextprotocol/sdk` 1.x — the maintenance line),
   but the modern era is implemented by the official **v2 line**
   (`@modelcontextprotocol/{core,client,server}` 2.x, stable since
   2026-10-05: era negotiation, `server/discover`, MRTR). A reference
   implementation and a buildable modern test server therefore DO exist,
   and the dual-era ruling is restored. Modern-era *features* beyond
   tools (MRTR-driven elicitation, `subscriptions/listen`) remain tier 3
   on capability grounds, not reference-implementation grounds.

## 6. Costs and risks

- **Context cost.** Every MCP tool adds a one-liner to the system prompt
  AND its full JSON schema to every request body. A 50-tool server is a
  real token tax. Mitigations: per-server `tools` allowlist, per-server
  `disabled` flag, and `--mcp none` (all tier 1). Document the cost in
  the config docs.
- **Third-party code execution.** An MCP server is an arbitrary process
  the model can steer. The explicit config entry is the consent; MCP
  tools default to ASK until the server is trusted (§5.3); the kernel
  sandbox (§5.4) is the opt-in backstop; tier-3 sampling/elicitation are
  opt-in capabilities. State all four in the README.
- **Wire name constraint.** Sanitize at the adapter (§5.2); test with a
  server exposing awkward names (`my.tool`, unicode, >64 chars).
- **Orphaned servers.** Crash paths must kill the process group on every
  exit path (the TUI has several — SIGINT force-exit, `/restart`,
  `process.exit` handlers). Reuse the bash.ts kill pattern; add a test
  that a killed tre. leaves no server child (the `bash-kill.test.ts`
  precedent). Scope it honestly: the automated test covers the exit
  paths it can drive (SIGINT/SIGTERM, clean quit, `/restart`); the
  `process.exit`-handler paths that a test cannot reach deterministically
  are covered by construction (a single registered teardown that all
  paths call) plus a manual check — state which is which in the test.
- **Era probe is a new startup failure surface.** Every server now gets
  one extra request before it is usable; a server that answers neither
  probe (or answers wrongly) is a new class of startup failure. The
  three-way table (§4.2) is deliberately strict (only `-32601`/timeout
  fall back; everything else is fatal) so a broken server is named, not
  silently downgraded. Pin this with the negotiation-failure tests
  (§4.8) — a regression to "any error = legacy" is the failure mode to
  guard.
- **Protocol drift.** Dual-era by design (§5.9): pin the negotiated
  version from the probe result — the `initialize` result in the legacy
  era, the `DiscoverResult` / `_meta` version in the modern era; an
  unknown server version → startup error naming both versions.
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

1. **Sandbox profile / network: outbound network IS allowed — and the
   sandbox is now OPT-IN (§5.4).** The generated Seatbelt policy
   (`generateBashSandboxPolicy`, `sandbox.ts`) contains NO network rules
   — it is `(allow default)` plus file-read/write denies only, so
   sockets pass through. Verified empirically 2026-10-14 from inside a
   sandboxed tre. session (`TRE_SANDBOX=1`): `cat /etc/passwd` →
   `Operation not permitted` (file deny works) while a plain HTTPS GET
   to `openrouter.ai/api/v1/models` → `200 OK` (network works).
   Consequence for §5.4: when `"sandbox": true` is set, the posture is
   **file-confined but network-open** — a server can reach its own APIs
   but cannot read tre.'s files outside the roots. That is the opt-in
   backstop, not the default; the default (no sandbox) is the
   ecosystem's common case (servers reading their own state outside the
   roots). The config docs must say exactly both.
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
4. **`/mcp` status command: IN tier 1.** One line per server, reflecting
   the §4.4 state: `name — ready (N tools) | starting | failed (<reason>)
   | disabled`. It is the only
   way to see server health, it reuses the existing slash-command
   plumbing (a `handleSlashCommand` entry like `/stats`, which already
   takes a measured value from the driver), and the driver already
   tracks liveness for in-band failure messages.

   The config shape gains `disabled` accordingly (and `trust` /
   `sandbox` per §5.3/§5.4):
   ```json
   { "mcpServers": {
       "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
               "env": { "FOO": "bar" }, "cwd": "/path",
               "tools": ["read_file"], "disabled": false,
               "trust": false, "sandbox": false } } }
   ```
5. **Spec revision check (2026-10-14): the current revision is
   2026-07-28, and it is a breaking overhaul of the 2025-11-25 draft
   this scope was first written against.** Changes that matter here:
   (a) the `initialize` handshake is REMOVED — the protocol is stateless,
   every request carries version + capabilities in `_meta`, and servers
   MUST implement `server/discover`; (b) server-initiated requests
   (sampling/elicitation/roots) are gone, replaced by the MRTR pattern
   (`resultType: "input_required"` → client retries with
   `inputResponses`); (c) results carry a required `resultType` and an
   optional `structuredContent`; (d) list results gain `ttlMs`/
   `cacheScope` caching hints; (e) sampling, roots, and logging are
   DEPRECATED (removal eligible 2027-07-28) — we do not implement them;
   (f) streamable HTTP is stateless (no `Mcp-Session-Id`), requires
   `Mcp-Method`/`Mcp-Name` headers, and drops SSE resumability.
   UNCHANGED: stdio framing (newline-delimited JSON-RPC), id-multiplexed
   concurrency, `tools/call` shape, cancellation, shutdown, and the
   entire seam analysis (§3 — the adapter is still thin). Ruling:
   DUAL-ERA tier 1 — `server/discover` probe first, `initialize` fallback
   (the spec's own compatibility matrix requires a client to handle
   legacy to reach the ecosystem); §5.9. (A same-day interim re-rule to
   legacy-only was based on the false premise that the official SDK has
   no modern-era support; the official v2 line implements 2026-07-28, so
   the dual-era ruling stands — §5.9.)
