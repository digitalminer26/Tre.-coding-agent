# 10 — MCP support: scope (pre-implementation)

Status: **scope only — no code written.** **FROZEN 2026-10-14 (tier 1 is the
build scope; tiers 2–3 deferred — see §4).** Changes to this doc are made as
needed when an inconsistency surfaces, not by re-scoping. Scoped against
protocol revision **2026-07-28** (current; re-checked against the live spec
2026-10-14 — see §8.5). Tier 1 is a **dual-era** stdio client: it probes `server/discover`
first (modern, 2026-07-28) and falls back to the `initialize` handshake
(legacy, 2025-11-25 — what the ecosystem ships today), so it speaks both
eras (ruling in §5.9, re-audited 2026-10-14). This doc maps MCP (Model
Context Protocol) onto tre.'s existing seams, decides the open design
questions, and splits the work into tiers. Its implementation workstream
is WS12 in PLAN.md.

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
design). The modern era is believed to be implemented by the official SDK's
**v2 line** (`@modelcontextprotocol/{core,client,server}` 2.x, reportedly
stable since 2026-10-05) — **STATUS: UNVERIFIED, single source of truth
for this status is THIS paragraph.** The claim rests on a temporary
probe that has since been removed, and that probe produced contradictory
evidence (its reported latest protocol version and its `serveStdio`
export did not match the assumptions above). Until re-verified, treat
the following as UNCONFIRMED: that a v2 line exists and is stable; that
it implements 2026-07-28 (era negotiation, `server/discover`, MRTR);
that a modern reference implementation and buildable modern test server
exist. The spec requirements in this doc stand on the spec itself. The
modern path is spec-defined and testable with a spec-derived mock even
if the SDK claim proves false. **Oracle verification gate (before the
oracle is used — NOT a gate on implementation):** the REQUIRED
modern-path tests run against the spec-derived mock (§4.2 framing
contract), so implementation may proceed mock-first without any SDK;
the oracle is a cross-check that may be used only once verified.
Verification: re-run the oracle probe (§4.8) and RETAIN in the
repo — not merely in a commit message — a pinned fixture + the raw wire
transcript (e.g. `test/mcp-oracle/`), plus the exact SDK version, its
actual imports, and the negotiated protocol version (the commit message
names the version and points at the retained evidence); flip this
paragraph to VERIFIED only with that evidence in the repo and
reproducible.
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
| `tools/sandbox.ts` | **None (guardrail zone — do not edit).** The stdio bridge lives in `src/mcp/spawn.ts`. On darwin it IMPORTS `generateBashSandboxPolicy` read-only (exported); on linux it IMPORTS `buildBwrapArgs` from `tools/sandbox-linux.ts` (NOT guardrail-protected — `scripts/guardrail-check.sh` lists only `sandbox.ts`). Availability is checked with `bashSandboxAvailable()` / `linuxSandboxAvailable()`. Both backends are used for `sandbox:true` (§5.4). It also mirrors the process-group teardown pattern. Unsandboxed servers need no sandbox code at all. Any change that DOES need to touch `sandbox.ts` (e.g. a cache-dir allowance, §6) requires a human commit with `GUARDRAIL_BYPASS=1`. `spawnSandboxedBash` is not reused: it accepts shell text and uses `stdio: ["ignore","pipe","pipe"]`, so it cannot carry MCP stdin. |
| `cli/main.ts` | **Medium.** Config load, server spawn/teardown, `wiredTools` assembly, `--mcp` flags. This is the wiring home (like `wiredTools` today). |
| `config/tre-config.ts` | **Small.** New `mcpServers` field, same fail-closed parse posture as `extraRoots`. |
| `prompt/system-prompt.ts` | **None.** Descriptions flow through. (Context cost noted in §6.) |
| `loop/agent-loop.ts`, `wire/*`, `session/*`, `context/compact.ts` | **None** for tier 1. |
| `tui/*` | **Tiny.** The `/mcp` status command (a slash-registry entry + an info item — the same plumbing as `/stats`); tool items render by name unchanged. |

New modules (proposed): `src/mcp/config.ts`, `src/mcp/spawn.ts` (stdio
child spawn: argv, persistent pipes, process-group teardown, env
construction; imports `generateBashSandboxPolicy` read-only when
`sandbox:true`), `src/mcp/client.ts` (JSON-RPC stdio, dual-era:
`server/discover` probe → modern, `initialize` fallback → legacy — §5.9),
`src/mcp/adapter.ts` (MCP tool → `Tool` + result mapping + display name).

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
   (default is `false` — §5.4). `cwd` resolves relative to the launch
   directory, must exist as a directory, and is NOT added to sandbox
   roots. Confinement roots are the validated tre. workspace + configured
   extra roots, independent of `cwd`. **Environment contract (minimal
   by default, NOT inherited):** the child env is constructed in three
   layers, in order: (1) a small allowlisted baseline — PATH, HOME,
   TMPDIR, locale/term/identity, the SAME list `sandbox-linux.ts`
   exports as `BWRAP_ENV_ALLOWLIST` (import the constant; do not copy
   it); (2) the explicit per-server `env` entries (win over baseline;
   forward-declared variables the parent does not have are passed as
   declared); (3) `inheritEnv: true` ADDS the full parent environment
   UNDER the explicit entries (explicit `env` wins; the parent env may
   hold tokens/keys, so this key carries a documented credential-
   exposure warning). **Final layer — platform/sandbox markers (applied
   LAST, non-overridable):** after the three layers, the marker function
   `markerEnv(...)` in `src/mcp/config.ts` (alongside the three-layer
   env-construction function, so the whole construction is one pure,
   unit-testable module — §4.8) applies the markers, and they WIN
   over any explicit `env` or inherited value of the same name. It is a NEW
   function, separate from `buildBwrapChildEnv` (which is bash-only and
   drops explicit entries). **Owner and conditions, exact:**
   `TRE_SANDBOX=1` — set when the child is directly sandboxed (`sandbox:true`,
   either platform) OR when the parent process already has
   `TRE_SANDBOX=1` (inherited enclosing sandbox, WS11/D12 nesting). For an
   UNSANDBOXED child with no inherited sandbox, `TRE_SANDBOX` is NOT set
   by tre.; a server `env` entry still cannot set it to a falsified value
   in either case (the marker value wins when it applies, and the explicit
   value is ignored). `GIT_CONFIG_NOSYSTEM=1` — set for every child
   (cheap, harmless when unsandboxed).
   `TMPDIR` (set to `/tmp` ONLY for linux `sandbox:true` children — the
   bwrap rootfs is new and the host TMPDIR does not exist there; not forced
   for other children),
   `GIT_CONFIG_NOSYSTEM=1` (the system git config is denied by the policy;
   an unreadable-but-present `/etc/gitconfig` is fatal to git — EPERM is
   not the ENOENT it gets where the file is absent), and the PATH fallback
   (Linux: `BWRAP_DEFAULT_PATH` when the merged env has no usable PATH).
   These markers are part of the sandbox contract, not configurable
   server env: an explicit `env` entry that sets one of them is ignored
   for that key (the marker value wins), and the same applies to
   `inheritEnv`-supplied values. Do NOT spread the parent environment by default:
   file/network confinement does not protect secrets already passed
   into the child (outbound network is allowed under the sandbox, §8.1).
   `inheritEnv` and `sandbox` are independent axes: `inheritEnv: true`
   on an UNSANDBOXED child is plain `spawn` with the full parent env
   (tre.'s normal child process posture; no additional filtering is
   applied, and none is claimed). `inheritEnv: true` on a SANDBOXED
   Linux child must NOT route the merged env through
   `buildBwrapChildEnv` — that function re-applies the allowlist and
   would silently drop the parent variables the user opted in. The
   bwrap invocation gets the already-merged env directly (bwrap does
   not filter env; `--cleanenv`-style scrubbing is out of scope). This
   is the documented exception to reusing the bash path as-is. If tre.
   already runs sandboxed, `sandbox:false` means no additional child
   policy and cannot remove inherited confinement. Malformed entries
   fail startup (exit 2), like a bad `extraRoots`.
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
   version, `2026-07-28`, on the probe. **Framing rule (load-bearing,
   do not "simplify"):** the probe request is written as ONE JSON-RPC
   line — `{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{...}}`
   — with the envelope INSIDE `params`, and the line ends with a single
   `\n`. No `Content-Length` headers, no blank line, no pretty-printed
   multi-line JSON: the server's newline-delimited reader (and the
   mock's) treats the first `\n` as the message boundary, so a
   multi-line or header-framed probe is either misparsed (→ FATAL) or
   never answered (→ the 2s timeout misclassifies a modern server as
   LEGACY, and the legacy `initialize` then fails → the server is
   wrongly reported dead). The mock MUST parse the probe line as raw
   JSON and reject (fail the test) if it cannot, and MUST assert the
   envelope keys on it. The response maps to exactly ONE of three
   outcomes — per the spec's stdio binding, the fallback is NOT keyed
   to one specific error code: legacy servers respond to unknown
   pre-`initialize` requests with implementation-defined errors
   (commonly `-32601` or `-32602`) or not at all:

   | Probe response | Outcome | Action |
   |---|---|---|
   | `result` validating as `DiscoverResult` (`resultType` + `supportedVersions` present) **or** error `-32022` (UnsupportedProtocolVersionError — the recognized modern error, `data.requested`/`data.supported`) | **MODERN** | ONE bounded retry of the probe with a mutually supported version picked from `data.supported`/`supportedVersions`; a second failure of that retry (any non-success) is FATAL, NOT legacy (the server already proved modern); cache the era; every later request carries the `_meta` envelope (`protocolVersion` = negotiated, `clientCapabilities`, `clientInfo`) |
   | any other JSON-RPC error on a valid frame (any code — `-32601`, `-32602`, implementation-defined, …) **or** the bounded probe timeout (2s) | **LEGACY** | `initialize` handshake → `notifications/initialized` (2025-11-25); cache the era |
   | transport death — process exit / EOF during the probe, a stdout line that is not valid JSON (an envelope/framing violation — the §4.2 envelope rule), or a `result` that fails `DiscoverResult` validation (a server claiming the modern era but emitting an invalid discovery document — reported, not silently reclassified) | **FATAL** | do NOT fall back; report the observed error (server name + what arrived); tools absent |

   The fallback triggers on ANY non-modern JSON-RPC error or on
   silence — keying it to a single code would mask a working legacy
   server that answers with `-32602` or something exotic. Transport
   death stays FATAL: a peer that is gone, or one that cannot frame
   its own output, gains nothing from a second probe path — report
   the precise failure instead. The era
   is cached per server process. A server that fails both the probe and
   `initialize` is reported once with the observed error, its tools
   absent. **Whole-startup budget:** the 5s startup timeout (§4.4) covers
   the ENTIRE sequence — probe, the possible negotiation retry, and
   `initialize`/`initialized`; each request ALSO has its own 2s probe
   timeout, so the retry is bounded (≤2×2s) AND inside the 5s ceiling,
   whichever hits first. Size: `client.ts` ≈ 600–800 lines (framing, era probe,
envelope validation, pending map, frame queue and admission, cancellation).
Zero runtime dependencies (test-only oracle is conditional under §4.8).

   **Incoming server messages — dispatch contract (both eras).** Parse
   JSON, then validate the JSON-RPC envelope BEFORE classification or id
   lookup. Each line must be one non-null object (no arrays/batches) with
   `jsonrpc: "2.0"`. Requests/notifications have a string `method` and no
   `result`/`error`. For a NOTIFICATION, `params` must be absent or a JSON
   object — a DELIBERATE narrowing of raw JSON-RPC (array/by-position
   `params` are rejected; MCP uses named parameters). An inbound REQUEST's
   `id` and `params` are NOT validated at all: the request is answered
   `-32601` with its `id` echoed verbatim, whatever their shapes.
   **Our outbound ids are monotonically increasing POSITIVE INTEGERS
   starting at 1** (never strings, never reused within a process).
   Responses have NO `method` or `params`, require an `id` (string, finite
   integer, or null for an uncorrelated error; an id that is an object,
   boolean, array, or non-finite/fractional number is a violation), and
   exactly ONE own property of `result` or `error` (presence, not
   truthiness — `result: null` is valid). An `error` must be a non-null
   object with integer `code` and string `message`; `data` is optional.
   A null response id is allowed only for an error and never matches a
   pending call. **Id identity is by type AND value, with NO coercion:** a
   response matches a pending request only when both the JSON type and the
   value are equal — our integer id is matched ONLY by an integer response
   id (JSON integers are exact; fractionals/`1e21`-scale magnitudes are
   out of the matched-id domain), never by its canonical string form (a server that echoes our `1` as
   the string `"1"` produces a NON-match). A non-matching response is a
   late/unknown id (counted, dropped), so the call it was meant for expires
   on its 60s per-call timeout — a bounded, TESTED consequence, not a hang.
   **Envelope-violation disposition (one exception):** invalid JSON OR an
   invalid envelope is a terminal protocol failure: fail the server,
   settle all pending calls with transport failure, and tear down; during
   the probe this is FATAL, never legacy fallback. Invalid envelopes are
   (by class): a non-object line; wrong/absent `jsonrpc`; a `method` that is
   present but NOT a string (unclassifiable); a NON-response line (request
   or notification) carrying `result` or `error`; a NOTIFICATION with
   array `params`; and a RESPONSE with a missing `id`, a stray `params`
   property, an `id` that is an
   object/boolean/array/fractional/non-finite number, BOTH `result` AND
   `error` present (either alone is valid; `result: null` is valid), or a
   malformed `error`; and a line with NEITHER `method` NOR `id` (JSON-RPC
   permits no such message — unclassifiable, terminal). THE ONE EXCEPTION: an incoming
   server REQUEST (string `method` plus a PRESENT `id` — presence is the
   own-property test, not truthiness) is answered `-32601` whenever the
   transport is healthy, with its `id` echoed VERBATIM (`id: null` stays
   `null`) and its `params` NOT inspected — request-id shape and request
   params are never themselves violations, because tier 1 answers every
   server request non-fatally (the request-dispatch rules just below). A malformed response can never
   resolve a call as success.
   **Result-payload validation is a SEPARATE, LATER tier** than envelope
   validation, and its disposition depends on the REQUEST CLASS: a
   malformed payload on a `tools/call` (or other non-startup) result fails
   that call IN-BAND (`isError`); a malformed `server/discover` /
   `initialize` / startup `tools/list` result is a STARTUP failure (§4.2,
   §4.4) with no in-band channel.
   Every valid stdout message is classified BEFORE handling — by JSON-RPC SHAPE first
   (presence of `method` and of `id`), and only then by pending state,
   so an id collision can never be misread: **response** (NO `method`,
   has `id`) → if `id` matches a pending request, resolve/reject that
   request; if it matches NO pending request (late or unknown id),
   record it in the diagnostics coalescing counter and drop it — a
   response is NEVER treated as a server request;
   **notification** (a `method`, NO `id`) → dispatch by method:
   `notifications/cancelled` is dispatched by direction and request
   ownership: it may cancel a pending server→client request only.
   Tier 1 immediately rejects unsupported server requests with
   `-32601`, so a later server cancellation has no pending target;
   record it as unmatched and never abort a client→server call on an
   id collision. The legacy spec requires same-direction cancellation;
   the modern spec allows server-sent cancellation only for
   `subscriptions/listen` teardown (tier 1 has no subscriptions).
   `notifications/tools/list_changed` is RECORDED for the tier-2 re-list
   rule but has NO tier-1 behavior; any OTHER envelope-VALID notification
   with an unhandled method is recorded (bounded counter) and ignored —
   never an error, never a crash. (This leniency covers UNHANDLED METHODS
   only; a line failing envelope validation is the terminal case above,
   not a notification.)
   **request** (a method WITH a PRESENT `id` — presence is the OWN-PROPERTY
   test, NOT truthiness, so `id: null` is a request — the server expects a response):
   tier 1 implements NO server-request method (sampling/elicitation/roots
   are deprecated and out of scope, MRTR is tier 3) → reply promptly
   with standard JSON-RPC error `-32601` referencing the server's `id`
   (echoing `id: null` verbatim when it was null) —
   do NOT leave unanswered, treat as a response, prompt the user, invoke
   the model, or disclose roots. This reply is per-request and non-fatal.
   The `-32601` replies are protocol responses, NOT diagnostics:
   while the transport remains healthy, send one reply for each server
   request; never coalesce replies. **Total queued outbound bytes**
   (request frames, `-32601` replies, cancellation notifications, and the
   `initialized` notification) are capped at **4 MiB** (active + queued);
   queue overflow follows the four-class per-frame policy defined ONCE in
   §4.4 (the single source of truth) — this paragraph does not restate
   it. Diagnostics
   coalescing applies only to the bounded COUNTER of replies sent, not
   the replies. The legacy
   `initialize` request carries the CLIENT's `capabilities` — and tier 1
   advertises NOTHING: an EMPTY `{}`. The client implements no server-
   request method, so it advertises none of them. Do not confuse this
   with the SERVER's capabilities in the `initialize` result (e.g.
   `tools.listChanged`) — tier 1 records it but does not subscribe.
3. **Adapter.** Encode the WIRE name as
   `mcp__<server-identity>__<tool-identity>` within
   `^[a-zA-Z0-9_-]{1,64}$`. The wire name is the only thing the model,
   the approval gate, and the provider see; the human-facing name is a
   separate `displayName` field on the adapted `Tool` (non-wire, same
   side-table posture as `mcpAnnotations`/`mcpTrusted`) rendered as
   `<server>/<tool>` (the original MCP identities) in the TUI, `/mcp`,
   the approval prompt, and the session/transcript view. Session entries
   store the wire name (for replay correctness) plus the server/tool
   pair, so logs remain readable without relying on the hashed form. Both components use a bounded ASCII slug plus
   a fixed-length hash of the ORIGINAL UTF-8 identity, even for short
   names; truncate only the slug. This distinguishes `a.b` from `a_b` and
   prevents embedded-`__` ambiguity. Preserve original MCP names for
   `tools/call`. If the final name collides with a built-in or another
   imported name, reject that server's tool import atomically, report the
   conflicting original identities, and continue other servers; duplicate
   registration must not abort launch. `description` and `inputSchema` are
   passed through. Results map text blocks to `TextBlock[]`, `isError` to
   `ToolResult.isError`, and non-text blocks to descriptive text notes
   (§5.5). Modern `resultType: "input_required"` is unsupported: return an
   in-band `isError` explaining interactive input is unsupported; never
   expose `inputRequests` as success content, retry, or send
   `inputResponses` (MRTR is tier 3). Modern ordinary results require
   `resultType: "complete"`; legacy results may omit it. Ignore valid
   `ttlMs`/`cacheScope` hints (no tier-1 cache); a malformed/unknown
   result type on a `tools/call` result fails THAT CALL in-band
   (`isError`) — it is a result-payload failure, not an envelope
   violation, so the server is NOT torn down. **`structuredContent` — deterministic rule.** If
   `content` has ≥1 non-empty text block, the result is `[text blocks…]`
   then `structuredContent` APPENDED as one final text block
   (`JSON.stringify`, 2-space indent, header `[structuredContent]`); if
   `content` is absent/empty/all-blank, `structuredContent` is the SOLE
   payload (no header). Presence and emptiness decide — there is no
   "generic text" heuristic.
4. **Lifecycle.** Per-server isolation: **one server's startup failure
   never aborts the launch** — each server fails independently (its
   tools absent, a one-line notice), the others proceed. Spawn at
   startup (after config load). **Terminal startup failure = full
   teardown:** whenever a server reaches `failed` — at STARTUP
   (probe/handshake error, startup timeout, pagination limit, fatal
   probe row, tool import rejected, startup-frame admission failure) OR
   LATER while `ready` (a stall-deadline expiry, a write callback/stdin
   error, an outbound frame/queue admission failure in the MANDATORY
   class, or a stdout frame bound violation) — the client rejects all
   its pending requests,
   removes its stdout listeners and timers, disposes its sandbox
   policy file, and tears down its process group — a server that
   stays alive after a fatal startup response must not be left
   running. The stdio spawn is new; reuse the bash.ts process-group
   kill pattern, not its spawn API. Concrete timeouts: **probe 2s**,
   **startup 5s total**, **per-call 60s**. On clean shutdown or
   handled SIGINT/SIGTERM: close stdin → wait 2s → SIGTERM group →
   wait 2s → SIGKILL group. Register idempotent async teardown for
   clean quit/restart and handled signals, plus a synchronous
   group-SIGKILL backstop for immediate `process.exit` paths — this
   covers every exit path tre. can reach; there is no cleanup
   guarantee after uncatchable parent death (`SIGKILL`, kernel
   crash, power loss), where the OS may reparent the child. Test
   clean/signal paths, the synchronous exit backstop, and terminal
   startup-failure teardown. A dead server's calls fail in-band
   (`isError`: "MCP server X is not running"). State is
   `disabled | starting | ready | failed`, with reason. **Resource
   bounds — FIXED values with a PER-LIMIT failure policy (not one
   blanket "fail closed"):**
   - **Outbound frames, aggregate write queue, and write-stall policy.**
     **Per-frame admission (UTF-8 bytes, including the final newline):**
     no serialized outbound frame may exceed 1 MiB. Apply the limit
     BEFORE queueing/writing. **Outbound frame classes (exhaustive):**
     (1) TOOL REQUEST — admission failure → in-band `isError`, server
     healthy; (2) STARTUP frame (the probe, `initialize`, startup
     `tools/list`, and any other frame sent during the startup sequence)
     — admission failure (over the frame OR queue cap) → explicit startup
     failure and full teardown; (3) MANDATORY control = a `-32601` reply
     — admission failure → terminal transport failure; (4) BEST-EFFORT
     control = `notifications/cancelled` and the legacy
     `notifications/initialized` — admission failure → dropped + counted,
     NO teardown (a dropped `initialized` degrades gracefully: it is only
     a SHOULD for a well-behaved server, and the legacy session
     continues). Never truncate an echoed id to fit a reply. The total
     undrained queue (the frame currently being written plus all frames
     still queued — request frames, `-32601`/`cancelled` control frames,
     and the `initialized` notification) has a hard 4 MiB byte cap.
     Queue overflow is handled by the SAME four classes: (1) a TOOL
     REQUEST that would exceed the cap is rejected in-band as busy
     without killing the server; (2) a STARTUP frame over the queue cap →
     startup failure; (3) a MANDATORY
     control frame (a `-32601` reply to a server request — dropping it
     would leave the server request unanswered and can stall the server)
     that does not fit terminal-fails the server and settles all pending
     calls; (4) a BEST-EFFORT control frame (a client→server
     `notifications/cancelled` on user abort, or `initialized`) that does
     not fit does NOT
     tear the server down — the notification is dropped, recorded in the
     diagnostics counter, and the pending call is still settled in-band
     as aborted (the abort is client-side; the server MAY ignore the
     notification). Queued frames at teardown are not guaranteed
     delivered.
     **Write-chunking, byte accounting, and the progress signal (exact,
     testable).** Each frame (≤ 1 MiB) is written to the child's stdin
     `Writable` with a SINGLE `write(frameBytes, onFlush)` call; the
     client starts the next queued frame only after the callback fires
     (one active write at a time). Two distinct signals — do not conflate
     them:
     - **Byte accounting (queue size + admission): reserve on enqueue,
       release exactly once per frame.** There are TWO normal release
       paths: removing an UNSENT frame on settlement releases its full
       reserved byte count immediately; a WRITE-STARTED frame releases
       its bytes ONLY on its error-free `onFlush` (flushed to the child's
       stdin pipe), never merely because its call settled. A `drain`
       event NEVER changes byte accounting or advances the frame queue
       — it is a deadline signal only (see below). Unsent removal is
       NOT write progress; re-evaluate the threshold and cancel the
       timer if the remaining byte count is below 256 KiB.
       **Terminal teardown:** stop dispatch first, clear the queue and
       reset accounting to zero, marking all outstanding reservations
       released. Late callbacks/drain events from that failed transport
       are inert: no second decrement, timer reset, or next-frame
       dispatch. Use per-frame release guards and a terminal-state guard
       so races cannot make the count negative or restart writes.
     - **Deadline signal (resets the 10s no-progress timer): a
       SUCCESSFUL flush-completion — the error-free write callback OR a
       `drain` event.** That is the ONLY signal that resets the deadline
       — polling the byte count is not progress.
     A callback invoked WITH an error, or any stdin `error` event, is
     NEITHER signal: it is a transport failure — terminal-fail the server
     and settle all pending calls (the child cannot consume stdin;
     continuing writes would only grow the queue).
     **The 10s no-progress deadline.** The 256 KiB value is only the
     threshold for STARTING the deadline, not the memory bound. Start it
     when undrained bytes first reach 256 KiB (AT 256 KiB exactly, not
     strictly above); reset it on each deadline
     signal (an error-free `onFlush` OR a `drain`); cancel it when
     undrained bytes drop below 256 KiB. It trips ONLY if no deadline
     signal occurs for a full 10s while undrained bytes are at/above
     256 KiB. Honest bound: a reader that produces a deadline signal at
     least every 10s never trips (even if slow); a reader that STOPS
     (the pipe fills, no more flush-completions) trips after 10s. We do NOT claim an arbitrarily slow
     reader is exempt — a reader slow enough that a single large frame's
     flush takes >10s trips (that call also has its 60s per-call
     timeout; the 4 MiB cap bounds memory). A sub-threshold stalled
     request (undrained < 256 KiB) is not watched by this deadline — it
     expires on its 60s per-call timeout without terminal-failing the
     server.
     **Expiry:** the server transitions to `failed` (terminal teardown)
     and ALL its pending calls settle in-band with transport failure,
     including the active frame; the per-call 60s timeout is only a
     healthy-server bound, not survival across teardown.
     **Cancellation semantics (user abort of OUR outbound call):** ONE
     ORDER, settle exactly once: (1) capture the frame's WRITE STATE
     (UNSENT vs WRITE-STARTED — independent of whether the frame is
     currently active); (2) settle the pending entry in-band EXACTLY
     ONCE, as aborted; (3) then act on the write state: UNSENT (still
     queued, its `write()` never called) → remove it from the queue; do
     NOT send `notifications/cancelled` (the server never saw the
     request); WRITE-STARTED (its `write()` was called, whether the
     active write is still in flight or already flushed) → attempt the
     client→server `notifications/cancelled` best-effort (drop + count
     if the queue is at the 4 MiB cap). Notification delivery must NOT
     delay local settlement. A write-started frame is NEVER removed or
     truncated mid-write; the active write runs to completion (or
     errors → transport failure) and the notification is queued behind
     it. A late response for an aborted id matches no pending request
     and is a late/unknown response. Never cancel legacy `initialize`
     (spec prohibition). A server→client `notifications/cancelled` is valid
     only for a server request previously sent in that direction; tier 1
     immediately answers unsupported server requests with `-32601` and
     retains no such pending entry, so any server cancellation is
     recorded as unmatched and does NOT abort a client→server call even
     on a JSON-RPC id collision. (Modern servers may send it only for
     `subscriptions/listen` teardown; tier 1 has no subscriptions.)
     **Queue accounting:** remove an unsent request frame when its
     request settles (timeout/abort/terminal failure); the hard 4 MiB
     total-queue cap — not the 32-pending cap — bounds aggregate memory
     including control frames. Admission is limited by the 1 MiB
     per-frame cap, the 32-pending cap, and the 4 MiB total-queue cap.
     Admission failure (in-band rejection, drop+count, or terminal
     policy) releases no reservation: it happens BEFORE reserve, so a
     rejected frame is never enqueued.
   - **concurrent pending requests ≤ 32 per server.** Admission is
     bounded: request #33 is rejected IMMEDIATELY in-band
     ("server busy") WITHOUT killing the server — the server stays
     `ready`, earlier calls continue. Saturation is not a health
     failure.
   - **stdout frame > 1 MiB or no-newline growth** → the reader fails
     the frame and the server is transitioned to `failed` IMMEDIATELY
     (terminal teardown) — a single oversized frame is a protocol
     violation, not a retryable glitch (no strike counter: a server
     that cannot frame its own output cannot be trusted to recover).
     Retained stderr stays a 64 KiB ring.
   - **diagnostics coalescing:** repeated unknown/late response IDs and
     stderr noise are rate-limited into a bounded counter + tail (no
     per-event growth). Coalescing applies ONLY to diagnostics (unknown/
     late ids, stderr, and the COUNTER of `-32601` replies sent for
     server requests): a line classified as a RESPONSE to a pending
     request is NEVER coalesced, rate-limited, or dropped — it resolves
     its request — and a `-32601` REPLY is a protocol response, never a
     diagnostic: attempt one reply per request while transport is
     healthy; replies not written before teardown are not guaranteed.
   Rationale: caller-side rejection (an oversized TOOL REQUEST, or
   saturation) is an `isError` tool result, not a process-health event;
   a transport failure (stall expiry, a stdout frame blowout) OR a
   STARTUP/MANDATORY-class admission failure IS a process-health event
   and tears the server down.
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
   reply with a NON-MODERN error (a `-32601` by default, plus one
   variant answering `-32602` — the spec says the fallback must not be
   keyed to a single code)** — the fallback is a tested contract, not
   an accident. **The modern mock MUST assert the exact `_meta` envelope**
   on `tools/list` and `tools/call` (`protocolVersion` = negotiated,
   `clientCapabilities` present, `clientInfo`), and assert the client
   sends NO `initialize`. The modern mock MUST also assert the exact
   `_meta` envelope on the `server/discover` probe itself (all three
   keys, declared version `2026-07-28`) — the probe is where the era is
   decided, so the envelope regression is pinned there, not only on
   later requests. **Negotiation-failure coverage (the §4.2 table, one
   test per row):** `-32022` → modern (the recognized modern error — ONE
   bounded probe retry with a version from `data.supported`; a second
   non-success is FATAL, NOT legacy — the server proved modern; it does
   NOT fall back); other error on a valid frame (`-32601`, `-32602`,
   implementation-defined) → legacy fallback; probe timeout (no reply)
   → legacy; process EXIT during the probe / EOF → fatal; a
   `DiscoverResult` that fails validation → fatal; malformed JSON on
   stdout → fatal; `initialize` also rejected after a legacy probe →
   reported, no crash. **Envelope-validation coverage:** valid JSON with
   missing/wrong `jsonrpc`, scalar/array envelopes, a requested-line with a
   non-string `method`, a REQUEST/NOTIFICATION carrying `result`/`error`,
   a NOTIFICATION with array `params`, a RESPONSE id that is an object/
   boolean/array/fractional, a missing response id, both `result` AND
   `error` present, a line with neither `method` nor `id`, or malformed
   error fields → terminal failure and pending calls
   settled, never success. (Inbound REQUEST ids and request params are NOT
   in this list — a request is echoed non-fatally, below.)
   Test this during probe (no fallback) and ready-state calls. Also pin
   valid `result: null`, uncorrelated null-id errors, and numeric vs string
   id distinction (no accidental pending match): our integer id echoed as
   the STRING form does NOT match → counted as late/unknown and the call
   expires on its 60s timeout (assert the timeout, not a hang). The
   ONE envelope exception: an incoming server REQUEST with `id: null`
   (present-but-null) is answered `-32601` echoing `id: null`, NON-fatally
   (as is a request with an array/object `id` and array `params` — echoed
   verbatim, never inspected), the server is not torn down; assert the
   connection stays usable. And
   an envelope-VALID unknown notification is recorded+ignored, while an
   envelope-INVALID line (e.g. non-string method) is terminal — the two
   are distinguished in tests.
   **Incoming-message coverage:** a legacy mock
   that SENDS a `sampling/createMessage` request (with an id) after
   handshake → the mock asserts it receives a `-32601` error response
   referencing that id, and the test asserts NO user prompt, NO model
   invocation, NO root disclosure, the original tool call is
   unaffected, and the connection stays usable; a notification flood
   (unknown notifications) → bounded counters, no growth, no error.
   ID-direction collision test: while a client→server call is pending,
   send a server→client request with the same id, assert `-32601` and
   normal client-call resolution; server-sent `notifications/cancelled`
   for that id is unmatched and MUST NOT abort the client call. **Lifecycle coverage:** per-call timeout, abort
   (`notifications/cancelled`), clean/handled-signal teardown and
   synchronous immediate-exit backstop (no guarantee after uncatchable
   parent death), and one server failing at startup leaves others ready.
   Bound stdout frames (1 MiB), retained stderr (64 KiB ring), and list
   pagination (100 pages/10,000 tools); reject repeated cursors and fail
   closed at limits. **Per-limit policy tests:** outbound request too
   large → rejected BEFORE write, server stays alive; an inbound request
   with a near-limit string id whose `-32601` reply exceeds 1 MiB →
   terminal failure, no oversized write or truncated id; oversized
   best-effort cancellation → drop + count, server stays healthy;
   oversized startup frame → explicit startup failure and full teardown;
   a legacy `notifications/initialized` that cannot be admitted for any
   reason (frame or queue cap) is dropped + counted and the legacy session
   CONTINUES (assert the server stays usable — drop is not a teardown)
   (unit-test frame admission where generated frames are normally small).
   Pin byte limits including newline and the timer starting at EXACTLY
   256 KiB. Unsent abort/timeout releases reserved bytes exactly once,
   restores admission capacity, and cancels the timer when below threshold
   without counting write progress. Terminal teardown followed by late
   success/error callbacks and drain events leaves count zero, dispatches
   nothing, and restarts no timer. 33rd concurrent
   request → in-band "server busy", server stays ready; write stall
   (non-reading server: no SUCCESSFUL flush-completion occurs while the
   undrained queue is at/over 256 KiB for 10s) → server terminal-failed
   and ALL pending calls settled in-band with the transport failure —
   including the active frame (teardown kills the group; no survival
   promised); a write callback invoked with an error (or a stdin
   `error` event) → terminal transport failure immediately (NOT a
   deadline reset, NOT a counted progress event), all pending calls
   settled; progressing writes (successful flush-completions keep
   firing) do not trip the no-progress timer even at/over threshold; a
   sub-threshold stalled frame (< 256 KiB) expires on its per-call 60s
   timeout without terminal-failing the server; total queued bytes stay
   ≤4 MiB, unsent request frames are removed on settlement; BYTE-
   ACCOUNTING regression: a backpressured write that emits BOTH a
   `drain` event and a successful `onFlush` decrements the undrained
   byte count EXACTLY ONCE (by the frame's byte count) and dispatches
   the next queued frame EXACTLY ONCE — a `drain` alone never decrements
   or advances the queue; aborting a
   call whose frame is UNSENT removes it and sends NO
   `notifications/cancelled`, while aborting a call whose frame is
   WRITE-STARTED (still active OR already flushed and awaiting its
   response) settles in-band as aborted and best-effort-queues the
   `notifications/cancelled` — the active write is never truncated;
   a server-request flood to a
   non-reading child reaches the hard queue cap and a MANDATORY `-32601`
   reply that does not fit triggers terminal teardown (queued replies
   need not be delivered after teardown); a BEST-EFFORT
   `notifications/cancelled` that does not fit is dropped + counted and
   the server stays `ready` (the call settles in-band as aborted);
   stdout frame blowout (ONE oversized frame) →
   server terminal-failed immediately; diagnostics coalesce into bounded
   counters. Ignore/record late response IDs; a late discovery response
   after timeout must never switch an initialized legacy session.
   **Id-collision test:** a server request whose `id` EQUALS a pending
   client request id is classified by shape (it has a `method`) — the
   client replies `-32601` referencing that id AND the pending call
   still resolves normally with its own response (the collision is not
   misread as the pending request's answer, and the pending request is
   not left hanging). Also, server-sent `notifications/cancelled` for
   that id is unmatched and MUST NOT abort the pending client call. Test oversized/no-newline output floods, endless
   valid-small-frame floods, a non-reading server, cursor loops, and
   late discovery replies. Unit tests cover config (`disabled`, `trust`,
   `sandbox`, `cwd`, `inheritEnv`), naming collisions and server-isolated
   import failure, modern result types/MRTR/cache hints, `structuredContent`,
   result-payload disposition split (a malformed `tools/call` result type →
   in-band `isError`, server stays ready; a malformed startup
   `server/discover`/`initialize`/`tools/list` result → startup failure, no
   in-band channel),
   and the safety matrix. **Env construction matrix (all four combos):**
   `inheritEnv` × `sandbox` on/off — (a) sandbox OFF + inheritEnv OFF:
   baseline + explicit `env` only; a parent-secret var (e.g.
   `ACME_TOKEN`) is ABSENT; (b) sandbox OFF + inheritEnv ON: parent
   secret present, an explicit `env` entry wins over an inherited
   same-name variable; (c) sandbox ON + inheritEnv OFF: same assertions
   as (a) under the bwrap/Seatbelt child; (d) sandbox ON + inheritEnv
   ON: parent secret present in the child, explicit wins, and the
   merged env reaches the bwrap child WITHOUT a second
   `buildBwrapChildEnv` scrub (assert an explicit var that the allowlist
   would drop — e.g. `MY_SERVER_VAR=1` — survives). **Marker layer (combos
   c and d):** the child env carries `TRE_SANDBOX=1` and
   `GIT_CONFIG_NOSYSTEM=1` (and on Linux `TMPDIR=/tmp`), and an explicit
   `env` entry that sets any of them (e.g. `"TRE_SANDBOX": "0"` or
   `"TMPDIR": "/nonexistent"`) is IGNORED for that key — the marker wins
   (assert both that the marker is present and that the explicit value
   did not leak). Run combos (c)/(d)
   as unit tests against the env-construction function and, when
   Bubblewrap is available, as a spawn-level test asserting the real
   child env. **One
   GATED live-model `e2e.sh` scenario** (opt-in like `RUN_LIVE=1`, not
   in the default gate — it needs credentials and can flake): live model
   calls a mock-server tool. The **deterministic mock-server tests are
   the required gate**; the live scenario is optional confirmation.
   **SDK oracle(s) — CANDIDATE, pending verification.** The oracle is a
   cross-check, not a gate: the REQUIRED modern-path tests run against
   the spec-derived mock (§4.2 framing contract), and the oracle is
   used only once its status is verified. Modern path: the v2 SDK
   (`@modelcontextprotocol/server`) is the CANDIDATE — its status is
   UNVERIFIED (§2 is the single source of truth for that status); the
   exact version is UNPINNED until verification. Fallback path: a v1
   SDK or a legacy-only fixture (enveloped `server/discover` → `-32601`
   → `initialize` + `notifications/initialized`); direct `initialize`
   against dual-era v2 does not test fallback. **Verification gate
   (before the oracle is used):** pick the candidate version, then
   RETAIN in the repo — not merely in a commit message — the exact
   version, its actual imports, the negotiated protocol version, and a
   raw wire transcript (a pinned fixture + transcript file under
   `test/`, e.g. `test/mcp-oracle/`), so the verification is
   reproducible from the checkout; flip §2 to VERIFIED only with that
   evidence in the repo and reproducible. An in-tree SDK devDependency
   requires human approval of the `check-deps.mjs` allowlist (the gate
   checks manifests, not imports); otherwise run the oracle out-of-tree
   and retain the fixture/transcript from that run in the repo.

**Test layout (exact).** The repo's runner is `node --test dist/test/*.test.js`
and `tsconfig` compiles `test/**/*.ts` to `dist/test/`. Therefore:
- Test files are `test/mcp-*.test.ts` (compiled, matched by the glob).
- Mock stdio servers are PLAIN `.mjs` files in `test/fixtures/mcp/`. They
  are not `.ts`, are not compiled, and do not match `*.test.js`, so they are
  never run as tests. Tests spawn them by path resolved from
  `import.meta.url` (the compiled test lives at `dist/test/`, so the path is
  `../../test/fixtures/mcp/<name>.mjs`).
- The oracle fixture and raw transcripts live in `test/mcp-oracle/` as data
  (`.json`/`.jsonl`), not test files. No SDK is added to `package.json`
  unless the human-approved allowlist change lands.

**Size: M.** One focused workstream, ≈2–2.5k lines total incl. tests:
`client.ts` ≈600–800 (above); `spawn.ts` ≈200–300; `config.ts` + `adapter.ts`
≈300; tests ≈1000+ (mock servers, negotiation/envelope/limit/lifecycle
matrices). These are estimates from this scope, not measured.

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
- **MRTR (`input_required`)**: interactive server requests remain tier 3.
  Tier 1 returns an in-band unsupported-interaction error; it does not
  expose requests as success content, solicit input, retry, or send
  `inputResponses`. Tier 3 requires reviewed user-consent and retry design.
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

2. **Naming:** see §4.3. Encoded names are deterministic and collision
  resistant; any residual collision rejects that server's tool import,
  not process startup.

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
  opt-in.** Keep the confinement roots (validated workspace + extra
  roots) distinct from configured child `cwd`. Resolve relative `cwd`
  against launch directory, require a directory, and do not grant it as
  a sandbox root. Environment: three-layer construction per §4.1 —
  `BWRAP_ENV_ALLOWLIST` baseline + explicit `env` + `inheritEnv` only
  when opted in; NOT full parent inheritance by default (the parent
  env may hold secrets). `sandbox:false` cannot remove an enclosing
  tre. sandbox. With `sandbox:true`, the child runs under the same
  Seatbelt profile as bash (file-confined to workspace + extra roots,
  network-open — §8.1); on Linux the env contract is built once (§4.1)
  and passed to the bwrap invocation directly — the bash-only
  `buildBwrapChildEnv` re-scrub is NOT applied to MCP children, or it
  would drop the explicitly configured `env` entries and defeat
  `inheritEnv`. Default is no added child sandbox. Rationale: MCP servers
  routinely read their own state (config files, caches, token stores)
  outside the workspace — the filesystem server reads the directories it
  serves, which are exactly the paths a user points it at and may sit
  outside the roots; sandboxing by default would break the common case
  on day one. The config entry is still the consent (the user chose to
  run this process), `trust` (§5.3) controls model-driven calls, and
  `"sandbox": true` is the extra backstop for servers the user does not
  fully trust. **Platform split (exact).** `sandbox:true` uses the host's
backend and nothing else: **darwin** → `generateBashSandboxPolicy` (Seatbelt,
`sandbox.ts`); **linux** → `buildBwrapArgs` (Bubblewrap, `sandbox-linux.ts`),
invoked DIRECTLY with the merged MCP env (after the caller creates the empty root with `createEmptyRootSkeleton`, as `spawnLinuxSandboxedBash` does; bwrap args do NOT unshare the net namespace, so the posture is network-open) — NOT via `spawnLinuxSandboxedBash`
or `buildBwrapChildEnv`, which are bash-only (§4.1). **Fail-closed:** if
`sandbox:true` and the host backend is unavailable (`bashSandboxAvailable()`
/ `linuxSandboxAvailable()` false, or the nested-marker case needs no wrapper
but the backend is absent), that server fails startup with an explicit
reason. It never falls back to an unsandboxed spawn.

**`sandbox:true` + `npx` — SPIKE (EMPIRICALLY VERIFIED, 2026-10-14,
no-sandbox mode).** The open item was whether a sandboxed `npx` server can
reach its `~/.npm` cache. Run empirically in NO-SANDBOX mode (the D12
nested-sandbox limit that blocked the earlier attempt is absent —
`TRE_SANDBOX` unset, so `sandbox-exec` applies a fresh policy) using the
REAL `generateBashSandboxPolicy` from `dist` and the REAL spawn shape
(`sandbox-exec -f <policy> /bin/bash -c <cmd>`); the reproducible 13-probe
battery is retained at `test/spike-sandbox-npx.mjs` (run:
`node test/spike-sandbox-npx.mjs <workspace>`). **The CONCLUSION holds** —
a sandboxed `npx` server fails at spawn — **but the earlier REASONING was
wrong.** The node *binary* execs fine under the policy (probe P1:
`node --version` → `v20.20.2`, rc 0); it is NOT "denied." `npx` fails for
two independent reasons, both a consequence of the file-confined policy
(denies `/Users` read AND write; re-allows only workspace + extra roots +
per-user temp `/private/var/folders`):
  1. **`npx` is a shell script** (`#!/usr/bin/env node`), not a binary. The
     kernel's shebang handler must `file-read` the script to find the
     interpreter; under the `/Users` read-deny that read is `EPERM`, so the
     exec fails (`/bin/bash: …/npx: Operation not permitted`, rc 126 — probe
     P4). The same read-deny blocks `file-read` of the node binary itself
     (P2/P3) — but a binary's *exec* does not need that read, so the runtime
     still runs (P1).
  2. **The npx-installed server code can't be loaded.** Even if the script
     were exec'd, node must `file-read` the installed JS from `~/.npm`
     (and the nvm runtime's own modules from `~/.nvm`); both are under the
     denied `/Users` top, so module resolution fails (`Cannot find module` /
     loader error — probes P6/P7/P8). A pre-warmed cache does not help: the
     code files themselves are denied.
The constructive alternative the ruling recommends **works**: a server whose
runtime + code live in an ALLOWED top (the workspace) runs fine under
`sandbox:true` (probe P5: `node <workspace>/server.js` → ok), and outbound
network stays OPEN under the policy (probe P12: `dns.lookup` → ok), matching
§8.1. **Ruling (unchanged):** `sandbox:true` is for servers whose runtime
and state live OUTSIDE the denied tops (a system node at `/usr/local`, an
installed binary, or a server that carries its own runtime). For
`npx`-launched servers the default (`sandbox:false`) is the working
configuration — the network-open posture of §8.1 still applies, and the
`trust` flag (§5.3) is the model-driving backstop. If a sandboxed
`npx`/`~/.npm` path is ever required, it needs an explicit cache-dir
allowance in `sandbox.ts` (a guardrail-zone change → human
`GUARDRAIL_BYPASS` commit).

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
  pending entry client-side (the spec: receivers MAY ignore
  `notifications/cancelled`; the response that still arrives for an
  aborted id is a late/unknown response), never sending
  `notifications/cancelled` for the legacy `initialize` request (the
  spec forbids cancelling it) (+ kill if the server misbehaves).

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
  decision table is §4.2: modern on a valid `DiscoverResult` or the
  recognized modern error `-32022` (which gets ONE bounded probe retry;
  a second non-success is FATAL, not legacy); legacy on ANY other JSON-RPC
  error on a valid frame or on probe silence — the spec's fallback
  is not keyed to one error code; FATAL only on transport death,
  framing violations, a discovery document that fails
  validation, or a second negotiation failure); the negotiated version is cached per server process;
  both eras share the same JSON-RPC plumbing (framing, id-multiplexed
  pending map, timeout, abort, death detection). A server failing both
  probes is reported with an actionable message naming the observed
  error, its tools absent.
  **Audit correction (2026-10-14).** An earlier same-day re-rule had
  narrowed this to legacy-only on the premise that "the official
  TypeScript SDK has no modern-era support — no reference implementation
  to validate against." That premise was wrong: it is true of the v1
  *package* (`@modelcontextprotocol/sdk` 1.x — the maintenance line),
  but the modern era is believed to be implemented by the official
  **v2 line** (`@modelcontextprotocol/{core,client,server}` 2.x,
  reportedly stable since 2026-10-05: era negotiation,
  `server/discover`, MRTR) — **STATUS: UNVERIFIED, per §2 (the single
  source of truth for SDK status); the dual-era ruling stands on the
  spec's compatibility matrix regardless.** Until re-verified, do NOT
  rely on the v2 line as a reference implementation or test server —
  the required modern-path tests use the spec-derived mock (§4.8); the
  SDK oracle is a to-be-verified cross-check (§4.8). Modern-era
  *features* beyond tools (MRTR-driven elicitation,
  `subscriptions/listen`) remain tier 3 on capability grounds, not
  reference-implementation grounds.

**Attribution (exact).** The MCP implementation is written from the
2026-07-28 and 2025-11-25 specs; no pi or SDK code is adapted. Spec text is
CITED in comments, not copied. If any implementation code is later adapted
from a third-party source, it must carry the L1/L2 header per
`docs/03-citation-policy.md` and add a `THIRD_PARTY.md` row in the same
commit. None exists today.

## 6. Costs and risks

- **Context cost.** Every MCP tool adds a one-liner to the system prompt
  AND its full JSON schema to every request body. A 50-tool server is a
  real token tax. Mitigations: per-server `tools` allowlist, per-server
  `disabled` flag, and `--mcp none` (all tier 1). Document the cost in
  the config docs.
- **Third-party code execution.** An MCP server is an arbitrary process
  the model can steer. The explicit config entry is the consent; MCP
  tools default to ASK until the server is trusted (§5.3); the kernel
  sandbox (§5.4) is the opt-in backstop; any future MRTR-driven
  elicitation (tier 3) requires its own reviewed user-consent design —
  deprecated sampling/roots are deliberately NOT planned. State all
  four in the README.
- **Wire name constraint.** Encode at the adapter (§4.3) with a slug plus
  fixed hash of original identities; test awkward names and distinct inputs
  that sanitize to the same slug.
- **Orphaned servers.** Use idempotent teardown for clean quit/restart and
  handled SIGINT/SIGTERM, with a synchronous process-group SIGKILL backstop
  for immediate `process.exit` paths. Test reachable paths; do not promise
  cleanup after uncatchable parent death (SIGKILL, kernel crash, power loss),
  where the OS may reparent the child.
- **Era probe is a new startup failure surface.** Every server now gets
  one extra request before it is usable; a server that answers neither
  probe (or answers wrongly) is a new class of startup failure. The
  three-way table (§4.2) is deliberately strict (fall back only on a
  non-modern JSON-RPC error on a valid frame, or on probe silence;
  FATAL on transport death, framing violations, discovery-document
  validation failure, and a SECOND `-32022` negotiation failure; `-32022`
  itself is modern by definition and gets ONE bounded probe retry) so a
  broken server is named, not silently downgraded — and it matches the
  spec's rule that the fallback must NOT be keyed to one error code.
  Pin this with the negotiation-failure tests
  (§4.8) — a regression to any narrower keying (e.g. `-32601`-only) is
  the failure mode to guard.
- **Protocol drift.** Dual-era by design (§5.9): pin the negotiated
  version from the probe result — the `initialize` result in the legacy
  era, the `DiscoverResult` / `_meta` version in the modern era; an
  unknown server version → startup error naming both versions.
- **`tools/list` pagination and framing bounds.** Follow `nextCursor` with
  a 100-page/10,000-tool cap; reject repeated cursors and fail closed at
  limits. Bound each stdout frame to 1 MiB and retained stderr to a 64 KiB
  ring. Also bound the stdin write queue to 4 MiB total (active + queued).
  The byte-accounting, no-progress-deadline, and per-class admission
  policy (the four outbound frame classes and what each does on
  admission failure, for BOTH the 1 MiB frame cap and the 4 MiB queue
  cap) are defined ONCE in §4.4, which is the single source of truth —
  this summary deliberately does NOT restate them, to avoid drift. The
  concrete numbers are: stdout frame 1 MiB, stderr 64 KiB, write queue
  4 MiB, no-progress threshold 256 KiB / 10s, pending calls 32,
  pagination 100 pages / 10,000 tools. Teardown
  does not guarantee delivery of queued replies. Unsent frames are
  removed on settlement.
  cap concurrent pending requests per server (32 — request #33 gets an
  immediate in-band "server busy" rejection; the server is NOT killed by
  saturation), and coalesce repeated unknown/late response IDs and stderr
  noise into bounded counters + tail — size limits alone do not stop
  small-frame floods or a stopped reader. Caller-side limits (an
  oversized TOOL REQUEST, saturation) reject in-band without killing the
  server; a transport failure (stall expiry, a stdout frame over the
  1 MiB bound — terminal IMMEDIATELY, no strike counter) OR a
  STARTUP/MANDATORY admission failure tears the
  server down and settles every pending call in-band (§4.4). Ignore/record
  late response IDs; after probe timeout a late discovery response cannot
  switch the selected legacy era. Test oversized/no-newline output
  floods, endless valid-small-frame floods, a non-reading server,
  cursor loops, and late responses.

## 7. Effort summary

| Tier | Scope | Size |
|---|---|---|
| 1 | stdio + tools + config + safety + lifecycle + tests | **M** |
| 2 | resources, prompts, list-changed | S–M |
| 3a | streamable HTTP + OAuth | M+ |
| 3b | MRTR interaction (`input_required` + reviewed user-consent retry) | M+ (tier 3, planned) |
| 3c | Deprecated sampling/roots | Not planned (deliberate) |

Tier 1 is the shippable unit: after it, `tre.` can use local stdio MCP
servers with existing safety/TUI/session/compaction behavior. It needs a
new stdio spawn module in `src/mcp/spawn.ts` (NOT `tools/sandbox.ts` — that
file is guardrail-protected and the bridge does not need to edit it); an
approved in-tree SDK oracle also changes `scripts/check-deps.mjs`. MCP registration remains disabled
until the human-committed `tools/safety.ts` branch is present.

## 8. Open questions — RESOLVED (2026-10-14)

1. **Sandbox profile / network: outbound network IS allowed — and the
   sandbox is now OPT-IN (§5.4).** The generated Seatbelt policy
   (`generateBashSandboxPolicy`, `sandbox.ts`, darwin; the linux bwrap backend
in `sandbox-linux.ts` likewise shares the network-open posture) contains NO network rules
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
2. **Naming:** collision-resistant slug + fixed hash per original identity; residual collisions isolate the affected server.
   The dot form is cleaner but OpenAI tool-name constraints reject
   dots. The double-underscore form is sortable. Readability is NOT
   carried by the wire name (the hash makes it opaque by design); it is
   carried by the `displayName` (`<server>/<tool>`) shown in the TUI and
   logs — see §4.3. The adapter encoder (§4.3: slug + fixed hash
   per component) must enforce `^[a-zA-Z0-9_-]{1,64}$` at registration
   time and fail the server's import if violated. The wire helpers
   inspected here sanitize call IDs, not tool names; do not rely on
   wire-layer renaming or validation for MCP tool names. Never silently
   truncate or rename an encoded identity, which would break the
   `tools/call` name mapping.
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
               "trust": false, "sandbox": false, "inheritEnv": false }
   } }
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
   no modern-era support; the official v2 line is REPORTED to implement
   2026-07-28 — SDK STATUS: UNVERIFIED (see §2, the single source of
   truth for SDK status), and the §4.2 fallback is any non-modern
   error (the spec's rule, not `-32601`-keyed) — so the dual-era
   ruling stands on the spec's compatibility matrix regardless (§5.9)).
