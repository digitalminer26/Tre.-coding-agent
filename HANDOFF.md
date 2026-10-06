# Current project status (2026-10-05)

**Linux bwrap sandbox backend — implemented, one step from done (2026-10-05).**
The bash tool now has a Linux kernel sandbox (Bubblewrap), mirroring the
darwin Seatbelt contract. Built via parallel delegation (gpt-6-luna + the
.13 Qwen endpoint; plan at `.tre/delegation/linux-bwrap/plan.md`):
- `src/tools/sandbox-linux.ts` — empty-root model: host runtime self-binds
  first (/usr,/bin,/lib,/lib64,/sbin ro -try; /etc/ssl + /etc/resolv.conf
  ro), private /tmp tmpfs, minimal /dev, fresh /proc, then an empty dir
  ro-bound over / LAST (bwrap resolves each mount source against the
  CURRENT root — the ordering is load-bearing and test-pinned).
  user/pid/ipc/uts namespaces; network SHARED in v1. Availability = binary
  (candidates + caller-PATH scan for no-root installs) AND a real spawn
  probe (3s) — the binary existing is not enough.
- `test/sandbox-linux.test.ts` — 8 pure argv/dest tests (run on darwin) +
  3 linux-guarded kernel probes (uid=0, host root hidden, sibling-canary
  escape, workspace rw) that self-skip where bwrap is absent.
- `docs/09-linux-sandbox.md` — the full boundary spec.
- `src/tools/sandbox.ts` — the dispatch hunk (bashSandboxAvailable +
  spawnSandboxedBash, linux → bwrap backend; darwin path UNTOUCHED).
  GUARDRAIL FILE: the agent cannot commit it. The user commits with:
  `git add src/tools/sandbox.ts && GUARDRAIL_BYPASS=1 git commit -m "..."`
  (patch saved at `.tre/delegation/linux-bwrap/guardrail-hunk.patch`).
**State:** the commits for the new files (module+tests, then docs) are in;
the guardrail hunk is staged in the working tree (uncommitted). macOS gate
green: 686 tests, 673 pass, 13 skipped, 0 fail; the darwin banner is
byte-identical (verified live). The VM (192.168.50.154) runs the new build: bwrap 0.9.0
installed no-root, but Ubuntu 24.04's AppArmor blocks unprivileged
userns (`kernel.apparmor_restrict_unprivileged_userns = 1` — the
uid_map write is denied; a bare `unshare -U true` passes and is NOT a
valid probe), so the probe fails → honest C42 banner → unsandboxed
fallback (verified: real LLM turn OK). **UNLOCK (needs the user's sudo
password on the VM):** `echo 0 | sudo tee
/proc/sys/kernel/apparmor_restrict_unprivileged_userns` — then re-run the
kernel matrix on the VM (recipe in docs/09 §5) and the banner flips to
`on`. **Revert:** `git checkout pre-bwrap-9cd5978 -- src/tools/sandbox.ts`
(undoes the hunk) or `git checkout pre-bwrap-9cd5978 && npm run build`
(everything); runtime kill-switch `--no-sandbox` always works.

**C42 — the sandbox banner tells the truth on non-darwin.** On Linux the
startup banner used to claim `sandbox: on (bash confined to the workspace)`
while the bash tool actually ran UNSANDBOXED (kernel sandbox unavailable) —
a false sense of containment, verified live on the lab Ubuntu 24.04 VM
(192.168.50.154). `behaviorSettingsLines` now takes `true | false |
"unsupported"`; the call site computes the real state from
`bashSandboxAvailable()`; the unsupported state renders `off (no kernel
sandbox on this platform — bash runs UNSANDBOXED; the approval gate is the
only boundary)`. macOS rendering is byte-identical (verified on this
machine); all 665 tests pass.

**Ubuntu deployment verified end-to-end (2026-10-05).** v0.1.4 was deployed
on the lab VM (llmsandbox, Ubuntu 24.04.3 LTS, x86_64) — Node 22.23.3
(user-local, checksum-verified), the offline installer ran clean, a real
LLM turn against the lab llama.cpp endpoint (172.30.70.13:8080,
Qwen3.8-27B-UD-Q4_K_S) succeeded, and the bash tool works (unsandboxed, as
designed). The VM has unprivileged user namespaces enabled and Docker —
a viable target for prototyping a bwrap-based Linux sandbox.

**Release v0.1.4 — published (the C41 fix).** The `codex/models` endpoint
now requires a `client_version` query param (and version-gates the list);
`discoverChatGptModel` sends `client_version=1.0.0` (C41). Fresh-endpoint
logins from the v0.1.3 bundle still fail at discovery — deploy v0.1.4:
  curl -fsSL https://github.com/digitalminer26/Tre.-coding-agent/releases/download/v0.1.4/install-tre-0.1.4.sh | sh
Bundle sha256:
`4823d249cc6f4c2749f11762e5b3ca512d6bcfb9159d2141a4a3668cd73736d9`.
The release build also hit a CORRUPTED user npm cache (root-owned
`~/.npm/_cacache` files → EPERM in both offline and network `npm ci`), so
`scripts/build-offline-tarball.sh` gained a third fallback: a fresh private
cache under the staging temp dir (commit `877ef5f`). This bundle IS a fresh
`npm ci` prod install (40 packages) — full provenance.

**Release v0.1.3 — published.** The config-consistency changes are committed,
pushed, and now included in the new v0.1.3 offline bundle + installer release.
The normal `npm ci --omit=dev` bundle build failed (npm cache inaccessible;
network fallback failed), so the v0.1.2 bundle's production `node_modules`
were reused with the current freshly built v0.1.3 `dist/`, package metadata,
and installer. SHA-256:
`e87e71b9f0e7cb64450bd2a671ae8b766b17d8b98fab6e870f97f003d709f062`.
The assembled bundle passed a cleanroom CLI `--help` smoke test, resolved all
four declared direct dependencies, and passed the embedded installer smoke
test. This is a validated package, but NOT a fresh clean dependency install;
rebuild with `npm ci` in a network/cache-capable environment if that stronger
provenance is required. Release assets: `tre-coding-agent-0.1.3-offline.tgz`
and `install-tre-0.1.3.sh` at GitHub release v0.1.3.

The "config consistency" workstream is COMPLETE: machine-wide config/secrets
now live under `~/.tre`, not project-local `.tre/`. **C40** moved the
Telegram bot's config + poll state to `~/.tre/telegram.json` +
`~/.tre/telegram/` (machine-level, works from any launch dir; live machine
migrated, bridge verified enabled from an empty cwd). **W2** moved the
release tooling's GitHub-token lookup to `~/.tre/github-token` (with the
legacy repo-local `.tre/github-token` still honored as a fallback; live
machine migrated).

Release packaging now publishes both the offline `.tgz` and a versioned
`install-tre-X.Y.Z.sh` one-command installer. The installer validates Node >=20,
downloads the release bundle, extracts it, and invokes the embedded deployment
script. README release instructions updated accordingly.

The ChatGPT backend now recovers from a **stale-but-unexpired access token**
(C39). A token rejected by the server (401) while still nominally valid used
to fail every request forever — the token store only refreshes within 60s of
`expiresAt`, so the expiry check never fired. Now, when the Responses stream
gets a **pre-stream 401** on a `chatgpt-oauth` model, the wire layer forces a
refresh (`resolveAccessToken({ force: true })`) and retries the stream **once**;
a second 401, a non-401 error, or a rejected refresh is a clean `done(error)`
(no infinite loop). Static-key models are unaffected. This closes the follow-up
logged in the C38 entry.

`~/.tre` — tre.'s own state dir (sessions, `chatgpt-auth.json`, the model
catalog) — is an **implicit, always-on root** (C38): at startup `main()`
prepends it to the boundary, so the bash kernel sandbox and the write/edit path
sandbox reach tre.'s own state by construction, on every machine, with no
config. It flows through the existing C35 `extraRoots` mechanism, so **no
guardrail-zone file is touched**. A sibling of `~/.tre` (e.g. `~/other`) is
still outside the boundary.

ChatGPT login still discovers a model ID from the authenticated Codex model
catalog before writing `~/.tre/tre/models.json` (see the 2026-10-03 entry).
Build passes; the full test run has 8 unrelated environment-dependent failures
(session-path-permission and git-commit integration tests; `git` and `~/.tre`
are EPERM-denied under the inherited kernel sandbox).

The dated entries below are an append-only implementation history, not a
single up-to-date status report. Their test counts, “uncommitted” labels,
open-task lists, and proposed next steps describe the date shown and may have
been superseded. For current behavior, trust `src/` and the current tests;
README.md is the user-facing overview. No pending ChatGPT OAuth implementation
is implied by the historical incident entry below. The most recent work is
listed first; this log does not replace a fresh quality-gate run.

# HANDOFF — v0.1.4 release: npm-cache corruption fallback in the bundle build (2026-10-05)

**Problem.** The v0.1.4 release run (bump + gate + push all green) died in
`scripts/build-offline-tarball.sh` step 3: `npm ci` failed BOTH offline and
with network. Root cause: the user npm cache (`~/.npm/_cacache`) contains
root-owned files (an npm bug on some machines) — npm EPERM's on `stat` of a
cache file before fetching anything. Both existing fallbacks share the same
corrupt cache, so both die.

**Fix.** `scripts/build-offline-tarball.sh` — third fallback:
`npm ci --cache "$STAGE/npm-cache"` (a private cache under the staging temp
dir, immune to the corruption; the network fetch still happens, only the
cache location moves). The first two attempts are unchanged (offline warm
cache, then network).

**Verification.** Rebuilt the v0.1.4 bundle: the fresh-cache path produced
the full prod `node_modules` (40 packages) — so the published
`tre-coding-agent-0.1.4-offline.tgz` (sha256
`4823d249cc6f4c2749f11762e5b3ca512d6bcfb9159d2141a4a3668cd73736d9`) is a
clean `npm ci` install, not a reused node_modules. Release v0.1.4 published
with the one-command installer `install-tre-0.1.4.sh`; both assets verified
downloadable, bundle verified to contain the C41 `client_version` fix.

# HANDOFF — C41: ChatGPT model discovery 400 → `client_version` (2026-10-05)

**Problem.** `tre. login` on a fresh endpoint failed AFTER a successful OAuth
login with `login failed: ChatGPT model discovery failed (HTTP 400); model
catalog was not written`. The post-login discovery call
(`GET https://chatgpt.com/backend-api/codex/models`) now REQUIRES a
`client_version` query param — without it the endpoint answers
`400 {"error":{"message":"…'loc': ('query', 'client_version'), 'msg': 'Field
required'…"}}`. The OAuth token exchange itself is unaffected (tokens were
saved); only the model-list fetch 400'd, so the catalog write was skipped.

**Diagnosis (live, against this machine's stored token).** Reproduced the
exact 400, then probed the endpoint:
- `client_version` is a REQUIRED query param (Pydantic-style validation).
- The model list is VERSION-GATED: `1.0.0` → full catalog
  (`gpt-6.1-sol`, `gpt-6-astra`, …, `gpt-5.5`, `codex-auto-review`);
  `0.130.0` → only `gpt-5.5` + `codex-auto-review`; `0.50.0`/`0.40.0`/`0.1.0`
  → EMPTY list (a valid 200 with no models, which would trip the "no usable
  models" path). So the version value matters, not just its presence.
- The `/responses` endpoint does NOT require the param (a `store:false`
  stream to `gpt-6.1-sol` returned a normal SSE stream). Fix is scoped to the
  discovery call only.

**Fix (C41).** `src/cli/auth-commands.ts` — `discoverChatGptModel` now sends
`?client_version=1.0.0` (new `CODEX_CLIENT_VERSION` constant, documented with
the live-verification note). Picking `1.0.0` (a current 1.x) sees the full
catalog, so the first slug is a real, streamable model.
`test/chatgpt-model-discovery.test.ts` — the URL assertion now pins the
`?client_version=1.0.0` query.

**Verification.** `npm run build` clean; `npm test` 665 pass / 0 fail / 10
skipped. Live: `discoverChatGptModel(storedToken)` (built `dist/`) →
`gpt-6.1-sol` (200, full catalog). No guardrail-zone file touched.

**For the user's fresh endpoint:** deploy v0.1.4 (released with this fix —
see the v0.1.4 entry above), then re-run `tre. login`. The OAuth step already
succeeded there, so a re-login is just the browser step again; discovery will
now write the catalog.

# HANDOFF — W2: release tooling GitHub-token lookup → `~/.tre/github-token` (2026-10-05)

**Problem.** The release tooling looked for the GitHub token only in
`$GITHUB_TOKEN` and the macOS keychain — but this machine keeps it in the
repo-local `.tre/github-token` (gitignored), which neither path consulted.
That mismatch is exactly what broke the 2026-10-05 release push (the token
was present, but not where the tooling looked). Second increment of the
config-consistency workstream: the machine-level home for the token is
`~/.tre/github-token`.

**Fix (W2).**
- `scripts/release-publish.py` — `get_token()` now checks, in order:
  `$GITHUB_TOKEN` → `~/.tre/github-token` → the LEGACY repo-local
  `.tre/github-token` (still honored so unmigrated machines keep working) →
  the macOS keychain. The no-token error names all four sources.
- `scripts/release.sh` — the push step is now a fallback chain: plain
  `git push` → one-shot credential helper fed from `~/.tre/github-token` →
  the legacy `.tre/github-token` → the keychain helper. The token file is
  read by a `!f(){…}` helper (never printed, never written to git config).
- `README.md` — release section lists the token order.
- `.gitignore` — the `.tre/github-token` entry is now a legacy safety net
  (the machine-level file lives outside the repo).

**Migration (live machine).** `.tre/github-token` (41 bytes) copied to
`~/.tre/github-token` (chmod 600). The repo-local file is LEFT IN PLACE:
the tooling still honors it as a fallback, and deleting it is a user
decision (it is the credential that pushes this repo).

**Verification.** `sh -n` clean; `compile()` clean; functional checks:
`get_token()` returns the machine-level token, `$GITHUB_TOKEN` still takes
precedence, and the legacy repo-local file is honored when `~/.tre/
github-token` is absent (temp-HOME test). Full suite 665 pass / 0 fail /
10 skipped. No guardrail-zone file touched.

# HANDOFF — C40: machine-level Telegram config + state (2026-10-05)

**Problem.** The Telegram bot bridge (C37) read its config from
`<cwd>/.tre/telegram.json` and its poll state from `<cwd>/.tre/telegram/` —
workspace-relative. tre. is launched from arbitrary directories, so a bot
configured in one project was invisible from every other launch dir, breaking
the "launch tre. from any directory" deployment model. This was the first
increment of the "config consistency" workstream (machine-wide config/secrets
belong under `~/.tre`; the second increment, W2, moves the release tooling's
GitHub-token lookup to `~/.tre/github-token`).

**Fix (C40).**
- `src/telegram/paths.ts` — new exported helpers: `telegramConfigPath(home)`
  → `~/.tre/telegram.json` and `telegramStateDir(home)` → `~/.tre/telegram/`
  (`home` injectable, default `os.homedir()`); module header rewritten (the
  "CONFIG + STATE stay cwd-relative" paragraph is now the machine-level
  story). `resolveTelegramHelper` (code) is unchanged — still project-shadows-
  user across skill roots.
- `src/telegram/bridge.ts` — `makeTelegramBridge(cwd, home = homedir())`:
  `enabled` gates on `existsSync(telegramConfigPath(home))`; `send()` writes
  `out.txt` to `telegramStateDir(home)`.
- `src/tui/telegram.ts` — `makeTelegramBridge(cwd, home = homedir(),
  timeoutMs = TELEGRAM_TIMEOUT_MS)`: same enabled/outDir change; the
  stderr-surfacing + cap-naming behavior is byte-for-byte unchanged.
- `src/tui/run.tsx` — call site passes `homedir()`.
- `src/cli/main.ts` — call site passes `deps.home ?? homedir()` (the
  injectable home already in the deps type); comments updated.
- `telegram.py` (deployment helper, both copies) — config/state now resolve
  against `os.path.expanduser("~")`, NEVER the CWD (the driver pins the
  spawn's cwd to the workspace, but the bot is machine-level).
- `.gitignore` — the repo-local `.tre/telegram*` entries are now a legacy
  safety net (the real files live outside the repo).
- Docs: `docs/02-contracts.md` (C40 bullet + the C37 inert-condition line),
  `docs/04-skill-authoring.md` (Secrets + State sections now point at
  `~/.tre`), the always-active `~/.tre/agent/skills/telegram/SKILL.md`
  (setup/send/receiving paths).

**Migration (live machine).** `~/.tre/telegram.json` already existed and was
identical to the repo-local copy (same token + chatId). The poll offsets had
diverged (repo-local 52182712, machine 52182711) — merged to the MAX
(52182712) in `~/.tre/telegram/last_update_id`, then the repo-local
`.tre/telegram.json` + `.tre/telegram/` were deleted. A non-blocking
`telegram.py poll` from an empty cwd returned `no new messages` (exit 0) —
config + state resolve from `~/.tre`; the built bridge reports
`enabled: true` from an empty cwd.

**Files.** `src/telegram/paths.ts`, `src/telegram/bridge.ts`,
`src/tui/telegram.ts`, `src/tui/run.tsx`, `src/cli/main.ts`,
`test/telegram-paths.test.ts` (+3 machine-level path tests),
`test/tui-telegram.test.ts` (setup writes config to a fake HOME; the
timeout-call signature is now `(cwd, home, 500)`),
`test/telegram-driver.test.ts` (BRIDGE ENABLEMENT writes config to the fake
home; +1 "enabled from any cwd with no workspace .tre" test), `.gitignore`,
`docs/02-contracts.md`, `docs/04-skill-authoring.md`, `HANDOFF.md`.

**Verification.** `tsc` clean; full suite **665 pass / 0 fail / 10 skipped**
(baseline 661; +4 new tests). No guardrail-zone file touched. The deployment
helper + always-active SKILL.md are gitignored (deployment-specific) and were
updated in place.

**Follow-up (RESOLVED by W2).** The release tooling still looked for the
GitHub token only in `$GITHUB_TOKEN` + the macOS keychain — the repo-local
`.tre/github-token` (where this machine actually keeps it) was not
consulted. W2 (above) adds the `~/.tre/github-token` lookup (with the
legacy repo-local file as a fallback) + docs.

# HANDOFF — C38: implicit `~/.tre` root (2026-10-05)

**Problem.** The bash kernel sandbox and the write/edit path sandbox confine
tools to the workspace plus any user-assigned extra roots (C35 `--extra-root`,
C36 durable `tre.json`). But `~/.tre` — tre.'s OWN state dir — was NOT
reachable by those tools unless the user manually added it as an extra root.
So a sandboxed bash child could not read `~/.tre` (sessions, the model
catalog, the ChatGPT auth token) and the write/edit tools refused paths there.

**Fix (C38).** `~/.tre` is an implicit, always-on root, by construction:
- `src/cli/main.ts` — `main()` computes
  `implicitRoot = path.join(deps.home ?? homedir(), ".tre")` and prepends it:
  `extraRoots = [implicitRoot, ...durableRoots, ...oneShotRoots]`. A new
  injectable `MainDeps.home` (default `os.homedir()`) keeps the test hermetic.
  `behaviorSettingsLines` gains an `implicitRoot` param and renders
  `  implicit root: <path>  (tre.'s own state dir — always read+write)`.
- It rides the EXISTING C35 mechanism (kernel policy re-allow + `checkPathWithinRoots`
  + prompt Working-directory section) — **no new code in the guardrail zone**.
- It is NOT validated (`validateExtraRoot` applies to user-supplied roots only)
  and NOT persisted (never written to `tre.json`).
- A sibling of `~/.tre` is still OUTSIDE the boundary (kernel + file-tool hook).

**Files.** `src/cli/main.ts`, `test/cli.test.ts` (2 new C38 tests + the two
WS7 outside-boundary assertions updated to the multi-root refusal text),
`src/prompt/system-prompt.ts` (comment-only — rendered output unchanged),
`test/prompt.test.ts` (1 new C38 test), `docs/02-contracts.md` (C38 bullet),
`docs/05-extra-roots-spec.md` (§6 + renumbered §7–§10), `README.md`.

**Verification.** `tsc` clean; full suite green except the 8 pre-existing
environment-dependent failures (confirmed identical at HEAD via `git stash`).
New C38 tests pass (cli: implicit root writable + sibling refused; banner line;
prompt: implicit root renders). No guardrail-zone file touched.

**Note (numbering).** The implicit root was first documented as “C37” in the
parallel-delegation wave, but C37 is already the background Telegram driver.
It is **C38**; the docs were renumbered accordingly (the Telegram C37 bullet is
untouched).

**Follow-up (RESOLVED by C39).** The stored ChatGPT **access** token in
`~/.tre/chatgpt-auth.json` can be invalidated server-side while still
nominally unexpired; the token store only refreshes within 60s of `expiresAt`,
so a dead-but-unexpired access token yields a 401 with no auto-retry-refresh.
C39 (below) adds the 401 → force-refresh → one-retry path.

# HANDOFF — C39: ChatGPT 401 recovery (force-refresh + one retry) (2026-10-05)

**Problem.** The ChatGPT backend resolves its Bearer token from the local store
(`resolveAccessToken`), which refreshes only when the access token is within
60s of `expiresAt`. A token can be rejected by the server (HTTP 401) while
still nominally unexpired — then the expiry check never fires and EVERY request
keeps failing with the same dead token (the exact symptom seen in the C38
session: `~/.tre/chatgpt-auth.json` held a stale access token that OpenAI
rejected with 401 while it was still within its nominal window).

**Fix (C39).**
- `src/auth/token-store.ts` — `resolveAccessToken` gains a `force` option that
  bypasses the unexpired early-return (a 401 means the server rejected a
  nominally-valid token). Same refresh grant, rotation, and persistence as the
  expiry path. Test seam `__setTokenRefreshForTests` /
  `__resetTokenRefreshForTests` override the default token endpoint + transport
  so the wire's forced refresh (which passes no endpoint/fetch) can be pointed
  at a mock — no network in tests.
- `src/wire/openai-responses.ts` — the stream consumption is extracted into an
  inner `consume(bearer)` async generator (the SSE switch is unchanged). The
  outer loop attempts the stream; on a **pre-stream `HttpError` 401** with
  `model.auth === "chatgpt-oauth"` it calls `resolveAccessToken({ force: true })`
  and retries **once**. A second 401, a non-401 error, or a rejected refresh
  (4xx → `AuthRequiredError` → "run `tre. login chatgpt` again") is a clean
  `done(error)` — **no infinite retry**. Static-key models (no `chatgpt-oauth`)
  are unaffected: their 401 is a plain, non-retried error.

**Files.** `src/auth/token-store.ts` (`force` + test seam),
`src/wire/openai-responses.ts` (401 retry loop + header note),
`test/token-store.test.ts` (1 new `force` test), `test/openai-responses.test.ts`
(3 new 401-retry tests), `test/mock-responses.ts` (`401-then-ok` + `401-always`
scenarios, `authHistory`/`requestCount`), `docs/02-contracts.md` (C39 bullet).

**Verification.** `tsc` clean; full suite green except the 8 pre-existing
environment-dependent failures (confirmed identical at HEAD). New tests: the
401-retry success path (two requests — `Bearer AT-stale` then `Bearer
AT-fresh`, exactly one forced refresh, token rotated + persisted), the dead-
refresh path (one 401, refresh rejected, clean `done(error)`, no third request),
and the static-key 401 (not retried). No guardrail-zone file touched.

# HANDOFF — ChatGPT login: `invalid_authorize_request` (root cause + fix) (2026-10-02)

**Historical status (2026-10-02; superseded by the implementation note below).**
At the time this entry was opened, implementation and live verification were
still pending. The fix was subsequently implemented; see “Implementation”
below. This is a dated incident record, not the current project status.

> **Current-status note (2026-10-03):** Read this entry as a historical
> investigation. The implementation is recorded below; current source and
> tests are authoritative. The live browser-login smoke test was a one-time
> verification item and is not a pending implementation task.

The user ran
`tre. login chatgpt` and the browser landed on:
```json
{ "error": { "message": "Invalid authorize request",
             "type": "invalid_request_error", "param": null,
             "code": "invalid_authorize_request" } }
```
This section preserves the root cause, evidence, original proposed fix, and
implementation record as historical documentation.

> **Historical context only:** The following “D15 is uncommitted” and
> “spec for the implementer” statements describe the working tree on
> 2026-10-02 before the fix was applied. They are retained for provenance;
> do not treat them as current status or instructions.

**Historical context — D15 was uncommitted at the time of this incident.** The entire ChatGPT feature (D15:
`src/auth/*`, `src/wire/openai-responses.ts`, `src/wire/dispatcher.ts`,
`src/cli/auth-commands.ts`, `test/{chatgpt-oauth,openai-responses,
token-store,dispatcher}.test.ts`) is in the WORKING TREE, untracked/uncommitted
(delegation doc `.tre/delegation/chatgpt-oauth-responses.md` subtask 8 "docs +
commit" was still `todo`). The user built it (`tsc` → `dist`) and ran the login
from there. This fix lands ON TOP of that uncommitted D15 work. The 3
pre-existing WIP files (`src/tui/run.tsx`, `src/tui/telegram.ts`,
`test/tui-telegram.test.ts`) are still in the tree and must stay OUT of any
commit of this workstream.

## Root cause

The public OAuth client `app_EMoamEEZ73f0CkXaXp7hrann` (shared with the Codex
CLI) has a **fixed set of registered loopback redirect URIs**. OpenAI's
authorize endpoint rejects any `redirect_uri` outside that set with exactly
`invalid_authorize_request`. tre.'s login uses a **random port** + path
**`/callback`** (`src/auth/chatgpt-oauth.ts:145,155`, `server.listen(0, …)` at
`:141`) — neither of which is registered — so the request is rejected before
the user even logs in.

The registered shape (from the reference implementations, all using this same
client id):
- **host:** `127.0.0.1` (codex, nib) — some tools use `localhost` (clodex);
  treat `127.0.0.1` as primary, `localhost` as fallback if still rejected.
- **port:** `1455` (default) or `1457` (fallback) — NOT random.
- **path:** `/auth/callback` — NOT `/callback`.

## Evidence (fetched 2026-10-02; live handshake NOT possible — see caveat)

- **openai/codex `codex-rs/login/src/server.rs` (main):** `DEFAULT_PORT: 1455`,
  `FALLBACK_PORT: 1457`; `redirect_uri = http://127.0.0.1:{port}/auth/callback`.
  `build_authorize_url` also sends `id_token_add_organizations=true`,
  `codex_cli_simplified_flow=true`, `originator=<codex_cli_rs>`, and scope
  `openid profile email offline_access api.connectors.read api.connectors.invoke`.
- **bman654/clodex PR #141 (2026-08-22):** comment in `src/oauth/openai.ts` —
  *"The only redirect URIs registered for this client id (shared with the Codex
  CLI): `http://localhost:{1455|1457}/auth/callback`. Any other port is rejected
  by auth.openai.com, so the callback server must win one of these two."* Their
  working authorize URL omits `originator`.
- **karthink/gptel issue #1514 (2026-08-16):** same error. Their URL was
  double-encoded (`redirect_uri=http%253A%252F…`) — a SEPARATE bug — but it also
  carried `id_token_add_organizations` + `codex_cli_simplified_flow` +
  `originator` and used `localhost:1455/auth/callback`.
- **mudler/nib PR #127 (2026-09-27):** sets `CallbackHost: "127.0.0.1"`,
  `CallbackPath: "/auth/callback"`, `CallbackPort: 1455` for this client.

**Caveat (could not confirm live):** `auth.openai.com/oauth/authorize` returns
HTTP 403 (Cloudflare) to non-browser probes from this sandbox, so the exact
registered set is taken from the reference implementations, not a live
handshake (the same wall gptel's reporter hit). The port+path is the consistent
shape across every working tool; that is the fix.

## What is NOT the cause (do not re-investigate)

- `client_id` is correct (matches codex exactly).
- PKCE S256 + `state` generation are correct.
- The authorize URL is single-encoded (tre. uses `URLSearchParams`) — it does
  NOT have gptel's double-encoding bug.
- The token endpoint + exchange encoding are already correct (form-encoded for
  the authorization-code grant; JSON for refresh — matches codex,
  `src/auth/token-store.ts`). The failure is at the AUTHORIZE step, before any
  token exchange.

## Historical proposed fix (written before implementation)

> This section records the original implementation spec. It was executed as
> written and is retained for the investigation trail; it is not an open task.
> See “Implementation” below for what landed.

**1. `src/auth/constants.ts`** — add:
```ts
/** Registered loopback callback ports for the shared Codex client id (1455
 *  default, 1457 fallback) — a random port is unregistered and rejected. */
export const CHATGPT_CALLBACK_PORTS = [1455, 1457] as const;
/** Registered callback path (NOT `/callback`). */
export const CHATGPT_CALLBACK_PATH = "/auth/callback";
```

**2. `src/auth/chatgpt-oauth.ts` `runLogin`** — replace the random-port bind:
- Try to bind `127.0.0.1:1455`; on `EADDRINUSE` try `127.0.0.1:1457`; if BOTH
  are in use, **reject** with a clear message (e.g. "callback ports 1455 and
  1457 are in use — close the other OpenAI sign-in (e.g. `codex login`) and
  retry"). Do **NOT** fall back to a random port (that reproduces the bug).
- `redirectUri = http://127.0.0.1:{port}${CHATGPT_CALLBACK_PATH}`.
- Callback handler path check: `url.pathname !== CHATGPT_CALLBACK_PATH`.
- Keep the manual-paste (headless) fallback; its hint text should show the
  registered path (`…/auth/callback?code=…&state=…`).
- `buildAuthorizeUrl` signature is unchanged (it already takes `redirectUri`).

**3. Codex extra params (optional polish — NOT the fix).** The rejection is
about `redirect_uri`, not these. Recommendation: add
`id_token_add_organizations=true` + `codex_cli_simplified_flow=true` (harmless,
matches codex, the intended UX for this public client) and **omit** `originator`
(codex-internal telemetry; we are not codex). Flag as optional so the
implementer doesn't over-engineer — the MINIMAL fix is port+path only.

**4. Tests (`test/chatgpt-oauth.test.ts`):**
- Loopback test: assert the `redirect_uri` uses a registered port (1455/1457)
  and path `/auth/callback` (currently asserts `:4321/callback`).
- `buildAuthorizeUrl` unit test: use a registered shape.
- NEW: with 1455 pre-bound (dummy server), `runLogin` falls back to 1457.
- NEW: with BOTH 1455+1457 pre-bound, `runLogin` rejects with the "close the
  other sign-in" message (does NOT fall back to random).
- Manual-paste test: the pasted URL uses the registered path.

**5. Docs:** README "ChatGPT Plus" section + `models.json.example` — note the
login uses the fixed Codex loopback ports (1455/1457); if one is busy (e.g.
`codex login` running), close it. User-facing.

## Implementation (2026-10-02 — spec executed as written)

- `src/auth/constants.ts` — `CHATGPT_CALLBACK_PORTS = [1455, 1457]` +
  `CHATGPT_CALLBACK_PATH = "/auth/callback"` (exactly per spec item 1).
- `src/auth/chatgpt-oauth.ts` — the random-port bind (`server.listen(0, …)` +
  `AddressInfo`) is replaced by a `bindPort()` helper that tries 1455 then
  1457; non-`EADDRINUSE` errors rethrow as `AuthError` (so a real bind
  failure is not silently swallowed); both ports busy → `AuthError`
  "callback ports 1455 and 1457 are in use — close the other OpenAI sign-in
  (e.g. `codex login`) and retry". `redirectUri` now
  `http://127.0.0.1:{port}/auth/callback`; the handler's path check and the
  manual-paste hint use the constant. The `AddressInfo` import is gone.
- Codex extras (spec item 3, the "optional" one): `buildAuthorizeUrl` adds
  `id_token_add_organizations=true` + `codex_cli_simplified_flow=true`;
  `originator` deliberately omitted.
- `test/chatgpt-oauth.test.ts` — spec item 4, all of it: the
  `buildAuthorizeUrl` test uses the registered shape + asserts the two extras
  (and no `originator`); new `runLogin: binds the registered callback port +
  path` (asserts port ∈ {1455,1457} + path); new `1455 in use → falls back to
  1457` (real blocker server on 1455); new `1455 AND 1457 in use → rejects`
  (asserts the user-facing message, no random fallback). The manual-paste and
  loopback tests were already path-agnostic (they parse the redirect_uri out
  of the opened URL), so they needed no change.
- Docs (spec item 5): README gains a "ChatGPT Plus (no API key)" section
  (login/status/logout, the responses-API model entry, and the fixed-ports
  note — 1455/1457, close `codex login` if busy, headless paste fallback).
  `models.json.example` left untouched (strict JSON, no comments — the note
  lives in the README).

**Gate (run 2026-10-02).** `tsc` clean; `node --test dist/test/*.test.js` →
**604 tests, 594 pass, 0 fail, 10 skipped** (the 10 are the pre-existing
live-network/TTY skips; +3 new tests vs the 601-test D15 baseline).
`quality-check.sh` OK (43 files scanned, no violations; deps 4/4). No
guardrail-zone file touched (`src/auth/*` is not in the zone).

**Still open (user action required).** The live smoke test: `tre. login
chatgpt` in a real browser — the one thing this sandbox cannot do (Cloudflare
403s non-browser probes at auth.openai.com, so the registered port/path set
is proven by the reference implementations, not a live handshake). If the
browser STILL rejects after this fix, the next suspect per the evidence is
host: try `localhost` instead of `127.0.0.1` (clodex's working shape) —
everything else in the URL matches a known-good tool.

---

# HANDOFF — `/restart`: in-place TUI + REPL restart (2026-10-02)

**Status: implemented + tested (gate owned by the implementing workers); this
section is the docs record of the final behavior.** One behavior: `/restart`
relaunches tre. in place — TUI and plain REPL — no quit + re-invoke.

**What.** Typing `/restart` (TUI slash menu, or the plain REPL) restarts the
tre. process in place. The TUI appends the feedback line `restart:
relaunching tre. — the session resumes in the new process` and hands off to
the child.

**How.** The driver re-execs the SAME argv (the full `process.argv` minus the
node binary, same `execPath`) as a detached child with `stdio: "inherit"` and
`TRE_RESTARTED=1` in the env (a copy — the parent's env is never mutated).
stdio inherit means the child takes over the TTY, so the parent unmounts the
Ink app (TUI) / exits its REPL loop (REPL) and exits 0 in the same tick. The
child re-runs normal startup and resumes the session file automatically —
append-only JSONL, resume = replay — so the conversation continues exactly
where it left off; nothing is re-sent. In the TUI, `/restart` while a run is
in flight aborts the in-flight run first (the session log already holds every
completed message; a torn tail is dropped on replay by design).

**Caveat (session).** With an explicit `--session`/`--resume` file, the child
resumes THAT file. With `--session-auto`, the child gets a NEW session path —
the auto path is derived from the launch timestamp + pid (`tre-<UTC>-<pid>.jsonl`
under `~/.tre/sessions/`), so the restarted process starts a fresh log and the
conversation does NOT carry over. With no session file at all, the in-memory
context is lost — a fresh start.

**REPL note.** The plain REPL only re-execs when launched directly as the
entry file (`isDirectInvocation` — realpath of `argv[1]` matches the entry
path). A module import (tests) or a renamed binary that does not resolve has
no re-executable argv → a stderr note (`restart: not available in this launch
— quit and run tre. again`), no crash. The TUI reports the same case as an
info line.

**Where.** `src/tui/restart.ts` (pure core: `restartCommand` spawn spec +
`isDirectInvocation`, `TRE_RESTARTED` marker), `src/tui/state.ts` (registry
entry + feedback), `src/tui/run.tsx` (driver re-exec — busy and idle paths),
`src/cli/main.ts` (REPL branch + TUI wiring + HELP text). Tests:
`test/restart.test.ts` + the `/restart` section of `test/tui-state.test.ts`.

---

# HANDOFF — Tilde expansion for extra roots (`tre.json` + `--extra-root`) (2026-09-30)

**Historical status (2026-09-30; preserved for provenance, not current guidance):** At the time this entry was written, the change was awaiting a human commit in the guardrail zone. The durable-root behavior remains: `tre.json` is read as a baseline; `--extra-root` is a per-launch addition and does not write back to the file. The incident diagnosis and gate details below describe the state at that time. The user reported that a `--extra-root` they added "is not getting populated in `tre.json`." Root cause: `tre.json` (C36) is a DURABLE BASELINE that is only ever READ by the CLI — there is no code path that WRITES it. The user had to hand-edit `tre.json` to make a root durable. While fixing that, a second gap surfaced: `tre.json` entries were resolved with `path.resolve(dir)` (CWD-relative) and `~` was NEVER expanded, so a portable `~/kubeconfigs` entry would resolve to `<cwd>/~/kubeconfigs` and fail the C35 exists-check (fail-closed refusal). The spec's own shape example advertised `/abs/or/~/relative/dir`, implying `~` support that did not exist.

**Change (one behavior: `~`/`~/` expansion before C35 validation):**
- `src/config/tre-config.ts`: new exported `expandTilde(p, home=homedir())` — `~` alone → home; `~/x` → `home/x`; anything else (absolute, cwd-relative, or a bare `~name`) returned UNCHANGED (no user-lookup — a bare `~name` resolves to the literal `~name` path and fails the exists check, fail-closed). Module doc updated to state the `~`/`~/` convention and the `~name` non-expansion rule.
- `src/cli/main.ts`: both the `tre.json` baseline loop and the `--extra-root` flag loop now call `expandTilde` BEFORE `validateExtraRoot(path.resolve(...))`, so a `~/…` entry (config OR flag) is expanded against the home dir and then validated exactly like an absolute path. The behavior summary still shows the EXPANDED absolute path (the boundary is what it is — the `~/…` spelling is not echoed). Help text for `--extra-root` notes the `~`/`~/` support.
- `test/tre-config.test.ts`: 2 unit tests for `expandTilde` (expansion + non-expansion) and 1 CLI integration test (a `~/…` entry in `tre.json` is expanded to the absolute repo root and accepted, asserted in the boundary summary; the `~/…` spelling is NOT echoed).
- Docs: `docs/02-contracts.md` C36 gains a "Tilde (2026-09-30)" paragraph; `docs/05-extra-roots-spec.md` §6 notes it; `PLAN.md` decision log D24; this HANDOFF.

**Also this session — `validateExtraRoot` EPERM fix (guardrail zone, `safety.ts`).** The user challenged the "sandbox artifact" framing of the test caveat, and was right to: `tre.json` lists `~/.nvm`, which EXISTS on this machine, yet startup refused it as "does not exist". Mechanism (proven by probe): under this sandbox `existsSync('~/.nvm')` → `true` but `realpathSync('~/.nvm')` → throws `EPERM` (the process can't `lstat` it). `validateExtraRoot` caught EVERY `realpathSync` failure and reported `"does not exist"` — conflating `ENOENT` (genuinely missing) with `EPERM` (exists, unresolvable). Fix: distinguish the error codes — `ENOENT` → "does not exist" (unchanged); any other code → "cannot be verified (CODE) — the path exists but cannot be resolved; refusing to avoid a symlink/sensitive escape". Still FAIL-CLOSED (if we can't resolve the real path we can't prove the root isn't a symlink onto a secret surface), but the message is now accurate. `test/safety.test.ts`: new test (a `chmod 000` parent makes `realpathSync` throw EPERM hermetically; asserts "cannot be verified" and NOT "does not exist"; skipped under root, which bypasses permission checks).

**Gate.** `tsc` clean; `node --test` → **528 pass / 0 fail / 9 skipped** (the 9th skip is the "no tre.json" test, which un-skips when the repo's own gitignored `tre.json` is absent — expected). `quality-check.sh` source scan OK (35 files); `check-deps.mjs` OK (4 runtime, 4 dev) — run directly because the sandbox has no `node` on PATH. **The `tre.json` caveat, precisely:** 30 `cli.test.ts` tests call `main()` WITHOUT pinning `treConfigPath`, so `main()` walks up from the repo root and finds the repo's REAL `tre.json` (which lists `~/.nvm`), then validates it. In this sandbox that validation throws `EPERM` for `~/.nvm` → refusal → exit 2 → test fails. On a normal machine `~/.nvm` is `lstat`-able, so those tests pass with `tre.json` present. This is NOT caused by this change (proven: with the ORIGINAL `tre.json` — before `~/kubeconfigs` was added — `cli.test.js` fails the same 28 with the same `~/.nvm` error), and it is NOT a spec violation — it is the pre-existing "real `tre.json` leaks into unpinned tests" isolation gap (commit `d03d881` pinned some, not these 30), now surfaced with an ACCURATE message by the EPERM fix. The full-suite green count above was taken with the repo `tre.json` moved aside to isolate that pre-existing leak; on the user's machine the suite is green with `tre.json` in place.

**Verification (direct, against the user's real `tre.json`).** `~/kubeconfigs` → expands to `/Users/xilcilus/kubeconfigs` → `validateExtraRoot` returns `undefined` (accepted). The other two entries (`/Users/xilcilus/projects`, `/Users/xilcilus/.nvm`) are unchanged absolute paths and pass as before.

> **Historical user note (2026-09-30):** This was written for the then-current
> behavior. The durable model described here remains valid: `tre.json` is
> edited directly for persistence; `--extra-root` is one-launch-only and is
> never written back. Examples and machine-specific paths are historical.

**Also this session — expressive one-shot/durable messages (usability, no contract change).** The user noted that `--extra-root` is one-shot but the startup summary gave no signal of that, and asked that confusing commands/args be "as expressive as it can be." The contract is UNCHANGED (tre.json = durable baseline; `--extra-root` = per-launch addition, never written to tre.json) — only the OUTPUT is more explicit. `behaviorSettingsLines` now takes `durableRoots` + `oneShotRoots` (was a single `extraRoots`) and renders them on SEPARATE labeled lines: `extra roots (durable, from tre.json): …` and `extra roots (THIS LAUNCH ONLY, --extra-root): …`, plus a `note:` line stating `--extra-root` is one-shot and NOT written to tre.json (pointing to tre.json for durability). `main()` now tracks `durableRoots`/`oneShotRoots` separately (combined `extraRoots` = durable + one-shot is what's wired into the bash policy / write-edit sandbox / prompt — unchanged). The `--extra-root` HELP text and the Safety section now both say "ONE-SHOT (this launch only, never written to tre.json); the durable baseline is tre.json." Tests updated: `test/cli.test.ts` `behaviorSettingsLines` (separate labeled lines + note), `test/tre-config.test.ts` (durable vs one-shot lines), `test/cli.test.ts` C35 `--extra-root` (asserts the "THIS LAUNCH ONLY" line).

---

# HANDOFF — TUI: Ctrl+U/Ctrl+D half-page scroll (laptop fallback) (2026-09-30)

**Status: gate green — committed.** One behavior: the output viewport gains
two half-page scroll keys that exist on every keyboard.

**Why.** PgUp/PgDn/Home/End are the only built-in scroll keys, and they don't
exist on compact laptop keyboards (the user's machine: no PgUp/PgDn/Home
buttons; `Fn+arrow` is swallowed by macOS Terminal.app's own shortcuts). The
mouse-wheel path is opt-in (`TRE_MOUSE=1`) because enabling mouse tracking
kills native text selection on a read-mostly surface. So the default
scrolling had no usable binding on a laptop. Ctrl+letter always exists, so
`Ctrl+U` (half-page up) / `Ctrl+D` (half-page down) — the Emacs convention —
fill the gap with zero cost.

**Change (one behavior: two keys):**
- `src/tui/app.tsx`: two new routes in the keybinding table, placed BEFORE
  the `key.ctrl` catch-all (which previously swallowed them) and the char
  path. Raw `0x15`/`0x04` are parsed by Ink as `ctrl+u`/`ctrl+d` (name from
  the control byte), so the handler keys on `key.ctrl && input === "u"/"d"`
  and calls `onScrollBy(±halfPage)`. The idle hint now names them:
  `enter send · PgUp/PgDn/Ctrl+U/Ctrl+D scroll · …`.
- `test/tui-app.test.tsx`: new test (raw `0x15`/`0x04` → `onScrollBy(±8)`,
  half-page on the 24-row fake terminal); the two hint assertions updated to
  the new idle string.

**Gate.** `tsc` clean; `node --test` → **523 pass / 0 fail / 10 skipped**.
**TUI verification (PTY capture):** the pinned frame's hint line reads
`enter send · PgUp/PgDn/Ctrl+U/Ctrl+D scroll · ↑/↓ history · /quit exit`.

**Note:** this does NOT change the mouse-tracking default (still
selection-friendly, `TRE_MOUSE=1` for wheel). The two paths coexist: keyboard
scrolling is now laptop-proof, wheel remains opt-in.

---

# HANDOFF — docs/07 context display fidelity: items 1, 2, 4 (2026-09-30)

**Status: gate green — committed (4 commits, see git log).** All three
approved items of `docs/07-context-display-fidelity.md` are implemented.
Items 3 and 5 remain future work (spec §7). No guardrail-zone file touched
(`src/tui/state.ts` is NOT in the zone).

**Why.** The `context` bottom field and `/context` report received more data
than they displayed: the full per-call `usage` (cache read/write) was dropped
after `totalTokens` was tallied, the previous context size was forgotten (so
growth per turn was invisible), and compaction events were rendered as items
but never counted. This work adds the fidelity that costs nothing: display
what the events already carry.

**What changed** (all in `src/tui/state.ts` + `test/tui-state.test.ts`; the
`done`/`context_compacted` handlers, `contextBreakdown`/`contextReport`/
`bottomValue`, `BOTTOM_FIELDS`):

- **Item 1 — cache visibility.** New state: `lastUsage` (the last call's
  full usage), `cacheReadTotal`/`cacheWriteTotal` (session cumulative). New
  pinnable bottom field `cache` (added to `BOTTOM_FIELDS`): the last call's
  hit rate `cached 11k/12.1k (91%)`, or `—` when the endpoint reports no
  `cached_tokens` (absence ≠ 0% — never a misleading zero). `/context` gains
  `last call: in … (cached …) / out …` and `session cache: read … · write …`
  (both omitted without data). This also landed the H1 TUI stall message +
  assertion that the H1 commit had deferred (the WIP carried them).
- **Item 2 — growth per turn + turns-until-compaction.** New state:
  `contextDelta` (new − old on the last `done`/compaction) and
  `deltaHistory` (last 8 deltas; a compaction resets it to `[delta]`). The
  `context` field appends the last delta (`+1k` / `−170k`, U+2212 minus);
  `/context` gains `growth: +N last turn · +N avg (N turns)` (mean of the
  history, not the last value) and `~N turns until compaction`
  (`floor(headroom/avg)` — "compaction is not approaching" when `avg <= 0`,
  omitted when DUE or on the first turn).
- **Item 4 — compaction history.** New state: `compactionCount` +
  `lastCompaction` (tokensBefore/messagesKept/summaryChars/degraded). The
  `context` field appends `×N` (×1 already notable); `/context` gains
  `compactions: N · last: 90k → 9k summary + 12 msgs kept` with a
  `(degraded)` suffix for the rule-based fallback.

**Also this session (separate commit):** the two WS7 sandbox-refusal tests in
`test/cli.test.ts` were environment-fragile — `main()` walks up from
`process.cwd()` (the repo root) and finds the repo's gitignored `tre.json`
(extra roots), which changes the refusal message from "outside the project
root" to "outside the working directory … and its extra roots". They now pin
an EMPTY `tre.json` via the C36 `treConfigPath` seam, so the no-extra-roots
message is asserted deterministically on any machine.

**Gate.** `tsc` clean; quality-check clean (35 files); dep-freeze OK (4/4);
`node --test` → **522 pass / 0 fail / 10 skipped** (the 10 skips are the
TTY/TUI-live scenarios). +21 new tests across the three items.

**TUI verification (PTY capture, mock reporting `cached_tokens`):** the
bottom line renders `context: 13.2k/131.1k (10%) · sys 2.4k · msgs 10.8k ·
@97.3k · +1k` + `cache: cached 11k/12.1k (91%)`; the `+1k` appears only from
turn 2 (turn 1 has no prior size); `/context` shows `last call: in 12.1k
(cached 11k) / out 1.1k`, `session cache: read 22k` (2 turns × 11k), `growth:
+1k last turn · +1k avg (1 turn)`, `~84 turns until compaction`. No
compaction fired in the capture (item 4's `×N` + history line are unit-
covered). Mock: `.repro/mock-cache.mjs` + `.repro/feed-docs07.sh` (local,
gitignored).

**Remaining (future, spec §7):** item 3 (message composition — tools/model/
user split) and item 5 (system-prompt section split) are logged, not
designed. docs/08 H2–H4 (same-failure repetition, loop visibility,
checkpoint commits) also remain.

---

# HANDOFF — Loop hardening H1: windowed stall guard (docs/08) (2026-09-30)

**Status: committed (see git log). Gate NOT run in-session — see below.**

**Why.** The loop issue keeps happening (2026-09-30 WIP session: the model
displayed the same directory over and over and burned the session). The
three existing guards (C26 identical-batch, permission stall, turn budget)
have a gap: the stall guard counted CONSECUTIVE permission failures, so a
probe loop (denied call, legitimate successful call, denied call, …) never
reached 3-in-a-row and only the turn budget stopped it, late. Spec:
`docs/08-loop-hardening.md` (H1 approved; H2 same-failure repetition,
H3 loop visibility, H4 checkpoint commits logged).

**What changed.**

- `src/tools/pipeline.ts` — the stall guard is now WINDOWED: per tool, a
  window of its last `STALL_WINDOW` (8) calls (any outcome); the count is
  permission failures inside it; `STALL_THRESHOLD` (3) wall-hits in the
  window → in-band `stallText` + `details.stall` (stopReason `stall`,
  unchanged). A success or a non-permission failure no longer resets the
  count (it occupies a slot); the window sliding past a failure drops it;
  each tool has its own window/count. `stallText` updated ("3 times …
  within its last 8 calls").
- `test/tools.test.ts` — the "success resets" case replaced with the
  windowed behavior (probe loop fail/ok/fail/ok/fail → stall; window slide
  → no stall; non-permission failure no reset); the "different tool" case
  now asserts independent per-tool counts (stalls one call earlier).
- `docs/02-contracts.md` — stall bullet restated (window, not
  consecutive).
- User-facing stall messages + doc comments updated in `src/cli/main.ts`,
  `src/types.ts`, `src/loop/agent-loop.ts`.

**Carried in the WIP tree (NOT in this commit):** `src/tui/state.ts` (the
TUI stall error-item message) and `test/tui-state.test.ts` (its assertion)
are shared with the user's uncommitted docs/07 item-1 WIP — the message
update + assertion ride along with that WIP commit. The committed tree is
self-consistent (old message + old assertion).

**Gate caveat (RESOLVED 2026-09-30).** The gate was NOT run before this
commit (node under `~/.nvm` was outside the sandbox). It has since been
run and is GREEN (see the docs/07 section below): the `tre.json` extra root
for `~/.nvm` is in place (gitignored), so `npm test` runs in-session. The
H1 stall-guard tests (`test/tools.test.ts`) pass.

**Tree note (RESOLVED 2026-09-30).** This was committed on top of the
user's uncommitted docs/07 item-1 WIP (the WIP files were left out of this
commit deliberately). That WIP has since been committed — see the docs/07
section below (item 1 landed as its own commit, carrying the H1 TUI stall
message + assertion that this commit deferred).

---

# HANDOFF — `tre.json` gitignored: per-deployment durable extra roots (2026-09-29)

**Status: committed (see git log). Gate NOT run in-session** (node under
`~/.nvm` was outside the sandbox for the whole session) — low-risk change:
`.gitignore` + docs only, no code.

**Why.** C36's `tre.json` lookup finds the NEAREST file above the launch
dir, so a project-root `tre.json` is the natural place for durable extra
roots. But it was NOT gitignored — a project-root `tre.json` would be
committed and propagate to every clone/deployment, while the extra-root
boundary is a per-deployment decision (this machine's `/Users/xilcilus/projects`
is not another deployment's). The user wanted the project-dir location
(co-located with the project, found by the same walk-up) WITHOUT repo
propagation — i.e. the `models.json` pattern.

**What changed.**

- `.gitignore` — `tre.json` added next to `models.json` (same pattern:
  local file, never in git, documented shape in the comment). The
  `~/.tre/tre.json` home fallback is unchanged and remains an option for
  machine-wide roots.
- No code change: `findTreConfig` already prefers the nearest project-dir
  file; gitignoring it only stops it from being committed.

**Usage.** Create `<project>/tre.json` locally (now gitignored):
`{ "extraRoots": [ "/abs/or/~/relative/dir", ... ] }` — validated at
startup like `--extra-root` (exists, non-sensitive, under home).

---

# HANDOFF — L2 citation headers for the pi-modeled core + docs/01 §9 status (2026-09-29)

**Status: gate green — committed (see git log).**

**Why.** The user manually audited the code and found very few L1/L2
citations. Verification: the code is original — zero L1 (verbatim) code;
only `src/session/session.ts` carried a formal L2 header, while
`docs/01` §9 had explicitly planned "Copy"/"Copy exactly" for ~8 items.
The other files were defensible L3 (independent implementations of a
documented design), but the user asked to make the audit airtight: add the
L2 headers and update §9 to reflect what actually shipped.

**What changed.**

- L2 headers added (per `docs/03-citation-policy.md` format — level +
  source + what was taken + simplified/added): `src/types.ts` (message
  model, event vocabulary, Tool protocol), `src/loop/agent-loop.ts` (inner
  loop + hooks; lists the added guards: length fail-all, C22 nudge, C26
  budget/loop detection, stall stop, steering keep-alive),
  `src/tools/pipeline.ts` (validate → beforeToolCall → execute →
  afterToolCall; stall guard added), `src/tools/truncate.ts` (the
  truncation RULES are L2; implementation L3),
  `src/wire/openai-completions.ts` (wire shape + salvage parser;
  implementation L3), `src/prompt/system-prompt.ts` (section SHAPE is L2,
  contents L3), `src/prompt/skills.ts` (skills pattern L2; `always: true`
  added). `src/session/session.ts` already had one.
- `THIRD_PARTY.md` — aggregate table now has 8 L2 rows (was 1).
- `docs/01-walkthrough-harness-llm.md` §9 — gained a **Status (2026-09-29)**
  column: every row is **Done**, naming the implementing file(s) and the
  L2/L3 split, plus the simplifications and additions (steering replaced
  the planned follow-up queue; compaction and the Ink TUI — both "Defer" —
  shipped in Phase D). Intro notes that all "Copy" items are L2
  adaptations of pi's DESIGN, not its code, and that the repo has no L1.

Docs + comment-only; no behavior change. Gate green (tsc + full suite).

---

# HANDOFF — README/PLAN phase-naming fix + docs index refresh (2026-09-29)

**Status: gate green — committed (see git log).**

**Why.** The user audited README.md and found the Status section's phase
naming inconsistent: "Phase A / B / C / 3". The convention is A/B/C/D —
PLAN.md's own wave table (A, B, C, D) and prose (Phase A/B/C) agree; "Phase 3"
was the outlier, appearing in PLAN.md's ASCII build-order diagram and risk
table, and inherited by the README. The README's Docs section also listed
only 3 of the 6 docs, and PLAN.md's decision range was stale (D1–D6; the
log now runs to D23).

**What changed.**

- `README.md` — Status: "Phase 3" → "Phase D" (WS9/WS10/WS11 line). Docs
  section: added `docs/03-citation-policy.md`, `docs/04-skill-authoring.md`,
  `docs/05-extra-roots-spec.md`, `docs/06-compaction-cheap-wins.md`; PLAN.md
  line now says "locked decisions (D1–D23)".
- `PLAN.md` — ASCII diagram "Phase 3: WS9 compaction · WS10 TUI" → "Phase D";
  risk table "They're Phase 3 by design" → "Phase D by design".
- `docs/01-walkthrough-harness-llm.md` — §9 MVP-recommendation table:
  "Defer to Phase 3" → "Defer to Phase D" (our planning column, not the
  frozen pi record).

Docs-only; no code touched. Gate green; no "Phase 3"/"Phase <digit>"
references remain repo-wide (grep-verified).

---

# HANDOFF — Background Telegram driver for the plain CLI, with loop prevention (C37/D23) (2026-09-29)

**Status: gate green — committed (see git log).**

**Why.** The TUI already polls the bot every 30s, but the PLAIN CLI
(one-shot `tre. run` + `--plain` REPL) had no driver — a user's Telegram
message was only seen AFTER the workstream finished. The user asked for the
background long-poll driver and, after a prior infinite-loop incident, for a
robust loop-prevention mechanism.

**What changed.**

- `src/telegram/bridge.ts` (new) — the plain CLI's bridge over the skill's
  stdlib-`python3` helper (same spawn seam as the TUI's `src/tui/telegram.ts`,
  intentionally a small duplicate to keep the TUI untouched). Adds
  `pollLong(timeoutSec, signal)` — a LONG-POLL (blocks up to N seconds) that
  honors an `AbortSignal` (node kills the in-flight poll child on stop).
  `TELEGRAM_LONG_POLL_SEC = 30`.
- `src/telegram/driver.ts` (new) — the background poll loop + routing.
  **Loop prevention is the core requirement** — a naive
  `while (true) { poll(); }` hot-spins (hundreds of process spawns/sec,
  network hammering, Telegram 429s) when a poll FAILS FAST (network down,
  bad token → 401). Three independent mechanisms make it impossible:
  1. **Long-poll self-pacing** — each poll blocks up to 30s, so a no-message
     cycle takes ~30s; the loop cannot run faster than ~1 poll/30s.
  2. **Min-interval guard** — a hard cap keeps ≥30s between poll STARTS even
     if a poll returns instantly (a helper ignoring `--timeout`, or a fast
     failure). This is what kills the hot-spin regardless of poll speed.
  3. **Capped exponential backoff on failure** — a fast-failing poll backs
     off `min(base·2ⁿ, cap)` (default 1s → 60s), so a persistent failure
     settles to one poll per 60s, never a spin; a success (even "no message")
     resets the counter.
  The driver is also **interruptible** (`stop()` kills the in-flight poll
  child + wakes any sleep) and **single-flight** (a turn mutex serializes
  user + telegram turns — two turns never run concurrently on the shared
  context). Routing: a message STEERS the in-flight turn (the existing
  `SteeringQueue`) or, when idle, runs a turn + replies via the bot (REPL
  only; one-shot is `allowIdleTurns:false` — a single turn).
- `src/cli/main.ts` — wires the driver into the one-shot branch (steers the
  run; no idle turns) and the REPL (steers in-flight turns; idle turns run in
  the background under the driver's mutex and reply via the bot). `stop()`
  runs in the `finally` (and after the one-shot run) so the process exits
  cleanly. `finalAssistantText` (the reply extractor) added + exported.
  Inert when the bridge is disabled (no `.tre/telegram.json` + helper) — the
  no-telegram path is the old behavior.
- `.tre/skills/telegram/telegram.py` (LOCAL, gitignored — deployment-specific)
  — `poll` gains `--timeout N` (default 0 = the old non-blocking behavior);
  the api() HTTP read gets `60 + N` margin so the long-poll can block.
- `test/telegram-driver.test.ts` (new, 12 tests) — the loop-prevention
  mechanisms (backoff curve + cap, reset on success, the min-interval
  hot-spin guard), routing (steer-vs-idle, one-shot), lifecycle (stop,
  disabled bridge), the turn mutex, + no-telegram regressions (one-shot and
  REPL unchanged).
- Docs: `docs/02-contracts.md` (C37), `PLAN.md` (D23), this file.

**Gate.** `tsc` clean; source scan clean (35 files, +2); dep-freeze OK
(4/4, no new deps); `node --test dist/test/*.test.js` → **510 pass / 0 fail /
9 skipped** (+12 new). The 9 skips are the TTY/TUI-live scenarios.

**Note.** No guardrail-zone file touched (only `src/telegram/*`,
`src/cli/main.ts`, docs, tests) — committed directly, no `GUARDRAIL_BYPASS`.
The helper edit is local (gitignored); a fresh deployment's helper without
`--timeout` still works with the driver's non-blocking default (the driver
passes `--timeout 30`, which an old helper would ignore → the min-interval
guard still prevents a hot spin).

---

# HANDOFF — Durable extra roots: `tre.json` persists the C35 boundary (C36/D22) (2026-09-29)

**Status: gate green — committed (see git log).**

**Why.** C35's `--extra-root` was flag-only: the explicitly assigned writable
directory had to be re-passed on EVERY launch, so it was not durable. The user
confirmed the flag works (top-level session: the probe
`echo test > /Users/xilcilus/projects/.extra-root-probe` succeeds) and asked
for durability as part of the feature. The spec's §6 had deferred exactly this:
"Config-file persistence of extra roots … A future `tre.json` could carry them."

**What changed.** A new config file `tre.json` with a single field
`extraRoots` (array of directory strings) is the durable baseline for the C35
boundary.

- **Lookup** mirrors D19's models.json convention (`src/config/tre-config.ts`,
  new module mirroring `models.ts`): walk UP from the launch directory for a
  `tre.json` (same convention as a `.git` dir / a `models.json`), then fall
  back to `~/.tre/tre.json`. `parseTreConfig` / `loadTreConfig` /
  `findTreConfig`.
- **Precedence:** the CLI flag APPENDS to the config — `tre.json` is the
  durable baseline, `--extra-root` is the per-launch addition. Both go through
  the SAME `validateExtraRoot` (exists, non-sensitive, under home).
- **Fail-closed guard:** a malformed `tre.json` (bad JSON, non-array
  `extraRoots`, a non-string/empty entry) or a refused entry REFUSES the
  startup (exit 2, like a bad `--extra-root`) — never a silent ignore. A
  missing `tre.json` = the flag-only C35 behavior (no durable roots).
- `src/cli/main.ts` — resolves the config (via a new `MainDeps.treConfigPath`
  test seam) BEFORE the C35 validation loop; the flag entries are appended
  after the config entries. Help text updated.
- `docs/02-contracts.md` — C36 recorded. `docs/05-extra-roots-spec.md` — §6
  persistence item marked DONE (C36/D22); status line updated. `PLAN.md` — D22
  decision line.

**Gate.** `tsc` clean; source scan clean (33 files); dep-freeze OK (4/4, no new
deps); `node --test dist/test/*.test.js` → **498 pass / 0 fail / 9 skipped**
(+14 new in `test/tre-config.test.ts`: parse/load/find unit tests + the CLI
integration — config+flag append, and the fail-closed refusals for sensitive /
outside-home / missing / malformed entries). The 9 skips are the TTY/TUI-live
scenarios.

**Usage.** Add to a `tre.json` (project dir or `~/.tre/tre.json`):
```json
{ "extraRoots": [ "/Users/xilcilus/projects" ] }
```
then launch `tre.` normally — no `--extra-root` needed. The startup summary
lists the durable roots; `--extra-root` still works and appends.

**Note.** This increment touches NO guardrail-zone file (only
`src/config/tre-config.ts`, `src/cli/main.ts`, docs, tests) — the C35
guardrail files (`sandbox.ts`/`safety.ts`/`bash.ts`) are unchanged; the
durable roots flow through the EXISTING C35 wiring.

---

# HANDOFF — WS9 compaction hardening (A1–A6, D) (2026-09-29)

**Status: gate green — committed (A1 0bc3dfe · A2+A3 181fadf · D 4595815 ·
A6 3d9d76c). No work awaiting a human commit.**

**Why.** The WS9 auto-compaction (D10) worked end-to-end but its quality
rested on four assumptions that break on dense content and long sessions:
the chars/4 token estimate, a fixed 24k transcript budget, a summary prompt
that asked the LLM to remember file paths, and no way to compact on demand.
Each got a targeted fix.

## What changed

- **A1 — calibrated chars-per-token** (`src/context/compact.ts`):
  `calibrateCharsPerToken(usage, context, systemChars)` refines the estimate
  from the last assistant `usage` — `4 × estimatedTokens / actualTokens`,
  clamped to `[1, 4]` (the estimate can only be *wrong by density*, and
  clamping keeps a single noisy usage from corrupting the budget). The
  CLI/REPL/TUI carry one `cpt` per session lifetime; `compactContext` takes
  `charsPerToken?` so the keep window and the post-compaction budget are
  honest for dense (code) content instead of assuming chars/4.

- **A2+A3 — transcript hygiene** (`src/context/compact.ts`): the summarizer
  no longer sees thinking blocks (default off; opt-in via
  `compactIncludeThinking`) and each tool result gets its own 2000-char
  middle-truncation clip before the total budget. The total transcript
  budget scales with the model's window: `max(24_000, contextWindow / 4)`
  instead of a fixed 24k — a 131k model now folds up to ~32k chars of
  transcript, so the summary has room to actually summarize.

- **D — failure escalation** (`src/context/compact.ts`): a failed summary
  call (stream error / empty text) now (1) retries once with a shrunken
  transcript, then (2) falls back to a rule-based shrink (no LLM — keep the
  recent tail, drop the oldest, emit a `[Compaction summary of earlier
  context]` placeholder noting the failure) so the context STILL fits. The
  `context_compacted` event carries `degraded: true` and the `✂` stderr line
  says so. `prepareNextTurn`'s inline logic moved into a shared `compactNow`
  — the seam the manual `/compact` calls.

- **A6 — manual `/compact`** (`src/tui/run.tsx`, `src/cli/main.ts`): force a
  compaction on demand. TUI: intercepted before generic slash dispatch —
  busy → rejected with an info item (`compact: cannot compact while a run is
  in flight`), idle → `manualCompact` (silent summarizer call through
  `compactNow`, no turn). REPL: a `/compact` line before the generic slash
  handling; `--no-compact` → `compact: compaction disabled (--no-compact)`,
  nothing to fold → `compact: nothing to compact (context too short)`. The
  TUI slash registry gains `compact` (completion menu). `main()` gained an
  injectable REPL `stdin` (`MainDeps.stdin`) so multiple REPL tests can run
  in one process — the shared `process.stdin` can only be pushed-to once
  (EOF), which is what made the naive test approach hang.

## Gate

`tsc` clean; `node --test dist/test/*.test.js` → **484 pass / 0 fail /
9 skipped** (the 9 skips are the TTY/TUI-live scenarios that need a real
terminal). New coverage: `test/compact.test.ts` (A1 calibration — dense→2,
sparse→clamped 4, degenerate→4, last-assistant exclusion; D escalation —
retry-then-fallback, `degraded` flag; A6 REPL — forced compaction writes the
session `compaction` entry + `[Compaction summary…]` head, `--no-compact`
note, nothing-to-fold note) and the updated slash-menu expectations in
`test/tui-pinned-layout.test.ts` (7 commands, alphabetical).

## Re-run

```bash
npm test                          # tsc + node --test (offline, ~3 s)

---

# HANDOFF — sandbox: re-allow /private/etc/ssl/openssl.cnf so curl & git https work under the policy (2026-09-28)

**Status: gate green — AWAITING HUMAN COMMIT (guardrail zone: the user
commits with `GUARDRAIL_BYPASS=1`).**

**Why.** Under the kernel sandbox, every TLS-using CLI died: `curl` and
`git`'s https helper (both link macOS LibreSSL) open the system TLS config
`/private/etc/ssl/openssl.cnf` at init; the `/private` read-deny turned that
into EPERM → "Auto configuration failed" / `fatal: remote helper 'https'
aborted session` (verified 2026-09-20: the error names the exact path;
`OPENSSL_CONF=` does not help — libressl still probes the default path).
`python3` (stdlib ssl, no config file) was unaffected, which is why the
telegram skill works but curl/git don't. The documented escape hatch was
`--no-sandbox` for the whole session.

**What changed.** ONE line in `src/tools/sandbox.ts`,
`generateBashSandboxPolicy`: a single-file literal read re-allow
`(allow file-read* (literal "/private/etc/ssl/openssl.cnf"))`, emitted
right after the existing `xcode_select_link` literal (same pattern: one
file, no traversal; the system's own world-readable config, not a secret
surface). No other policy lines moved; the workspace re-allow stays LAST
in both read and write sections.

**Gate.** `tsc` clean; source scan clean (32 files); dep-freeze OK (4/4);
`node --test` → 458 pass / 0 fail / 9 skipped. (Inherited-sandbox note:
`npm` is unusable inside a sandboxed session — it's a symlink and the
policy has no readlink allowance for /Users — so the gate was run via the
absolute node path: `node node_modules/typescript/lib/tsc.js` +
`node --test dist/test/*.test.js` + `node scripts/check-deps.mjs`.)

**Verify after the commit** (inside a normal sandboxed session):
`curl -sS -o /dev/null -w '%{http_code}' https://example.com` → 200, and
`git ls-remote https://github.com/octocat/Hello-World` succeeds.
Could not be kernel-verified from inside this session: a process already
under a policy cannot apply a different one (sandbox_apply → EPERM), and
`sandbox-exec` from inside can't read a policy file outside the allowed
regions.

---

# HANDOFF — Telegram TUI poller: 30s background poll, incoming messages become prompts, replies go back via the bot (2026-09-27)

**Status: WORK COMPLETE, gate green — COMMITTED.**

**Why.** The telegram skill (always-active, previous increment) told the
agent to poll "at natural breakpoints," but the agent is TURN-BASED: while
the TUI is open and IDLE, no turn runs, so nothing ever polled — messages
the user sent from their phone sat unconsumed in the queue with no
acknowledgement. The user wanted: as long as `tre.` is running, respond and
acknowledge, and the reply must come back via Telegram.

**What changed.**
- `src/tui/telegram.ts` (NEW) — `makeTelegramBridge(cwd)`: wraps the skill's
  stdlib-`python3` helper (`.tre/skills/telegram/telegram.py`) as
  `poll()` (non-blocking `getUpdates` via a 15s-capped `execFile`, parsing
  the `[chatId from <name>] <text>` lines) and `send(text)` (writes the
  message to `.tre/telegram/out.txt` and runs `send`). `enabled` is false
  when `.tre/telegram.json` or the helper is missing → the driver never
  starts the timer (setup not done). `TELEGRAM_POLL_MS = 30_000`.
- `src/tui/run.tsx` — the driver owns a `setInterval` (unref'd, cleared on
  every exit path: finally + the SIGINT exit branch) that calls
  `telegramTick()` every 30s while the TUI is open. Tick logic:
  - skip when `state.busy` (a run is in flight) — messages accumulate in
    Telegram's queue until idle (getUpdates is offset-based, nothing is
    lost);
  - **busy** (checked again after the poll await, in case a user prompt
    started a run mid-poll) → steer every message into the ACTIVE
    steering queue (the one `runPrompt` installed), echo as user items,
    no reply sent (the running run's final text answers the user);
  - **idle** → fold the whole batch into ONE prompt (avoids the
    stale-queue trap: `runPrompt` installs a FRESH steering queue, so
    extra messages pushed before the run would be lost), set `busy: true`
    EAGERLY (the runPrompt→agent_start gap is async — session append runs
    first — so a concurrent user submit can't start a second runTurn on
    the same context; mirrors why `submitInput` sets busy eagerly), run it,
    then send the run's final assistant text back to the bot (fallback
    line when the run produced no text; no reply when the run errored).
  - `runPrompt` now returns the resulting context (null on the net-error
    case) so the reply path never reads the shared `context` var that would
    hold the PREVIOUS run's text on error.
  - All Telegram activity goes through `setState` (a bare `state =` would
    never repaint the Ink frame) and shows as info items:
    `telegram: polling every 30s (reply via bot)` at startup, plus
    steered/replied/error lines.
- `.tre/skills/telegram/SKILL.md` (LOCAL, gitignored) — Receiving section
  rewritten: in the TUI the DRIVER polls and replies; the agent must NOT
  run `telegram.py poll` itself (it would split the shared offset
  `.tre/telegram/last_update_id` and double-handle). Manual poll/ack
  remains the contract for plain/one-shot mode, which has no driver.

**Cost model (user question, answered before building).** Polling does NOT
touch the LLM endpoint: one non-blocking HTTPS GET to the Telegram Bot API
per 30s tick (free, far inside Bot API rate limits; `python3` is the
sandbox-safe network path). The LLM is only spent when a real message
arrives and a turn runs to answer it.

**Gate.** `tsc` clean; source scan clean (32 files); dep-freeze OK (4/4);
`node --test` → 458 pass / 0 fail. PTY capture (mock server on 127.0.0.1):
startup frame renders, `ℹ telegram: polling every 30s (reply via bot)`
present, `/display-bottom` + `/quit` unaffected. Bridge unit-verified:
`enabled: true`, `poll()` → null on the no-messages sentinel, parse regex
matches the helper's line format, `send()` delivered a real test message
(bot @Tredot_bot).

**Bugs caught during review (before commit).** (1) bare `state =` mutations
would never re-render the Ink app → routed through `setState`. (2)
`runPrompt` doesn't set `busy` (only `agent_start` does) → set it eagerly
before the run to close the async double-run gap. (3) extra batch messages
pushed before `runPrompt` would land in the stale steering queue → fold the
batch into one prompt. (4) on a run error the shared `context` var holds the
previous run's text → `runPrompt` returns its context; the reply path uses
it, sends nothing on null.

**Known limitations.** Not real-time: worst-case latency is one 30s tick.
While a long task is in flight, incoming messages steer into it and get no
separate reply (by design — one reply per run). Plain/one-shot mode has no
poller (the driver is TUI-only). The timer is unref'd, so it never keeps the
process alive on its own.

---

# HANDOFF — always-active skills: `always: true` frontmatter includes the SKILL.md body in the system prompt (2026-09-27)

**Status: WORK COMPLETE, gate green — COMMITTED.**

**Why.** On-demand skill loading (index in the prompt, body read via the
`read` tool only when a task matches the description) assumes the user is
present to trigger the read. A messaging channel like telegram must be active
even when the user is AWAY — if the skill body isn't loaded, the agent has
no way to know it should poll for incoming messages or send results, and the
user has no way to communicate with it.

**What changed.**
- `src/prompt/skills.ts` — `SkillIndexEntry` gains `always?: boolean` and
  `body?: string`. `parseSkillMd` now splits frontmatter from body
  (`splitSkillMd`); when the frontmatter has `always: true`, the trimmed
  body is captured on the entry. On-demand skills are unchanged (no body
  field → byte-identical index entries).
- `src/prompt/system-prompt.ts` — the `# Skills` section now splits skills:
  on-demand ones keep the existing index lines (name + description + path);
  always-active ones render under a `## Always-active skills` subsection with
  their body verbatim. When there are no on-demand skills the "read its
  SKILL.md" intro line is omitted; when there are no skills at all the
  section is absent (test-pinned).
- `src/cli/main.ts` — `loadSkills` now returns `SkillIndexEntry[]` (was an
  inline object type that would have dropped `always`/`body`).
- `.tre/skills/telegram/SKILL.md` — marked `always: true` (deployment-
  specific, gitignored, not committed).
- `docs/04-skill-authoring.md` — documents the `always: true` flag and the
  token-cost tradeoff (every always skill's body is in every prompt).
- `test/prompt.test.ts` — new tests: frontmatter parse (true captures body,
  false/absent does not), index load (always skill keeps body, plain skill
  doesn't), prompt rendering (always body verbatim, on-demand body never
  leaks, no path line for always skills, all-always omits the on-demand
  intro, no skills → no section).

**Gate.** `tsc` clean; `scripts/quality-check.sh` OK; `node --test
dist/test/*.test.js` → 458 pass / 0 fail. Verified against the REAL
`.tre/skills`: telegram loads with `always: true` + 4222-char body in the
prompt; git-commit/self-improve stay index-only (their bodies do NOT appear
in the prompt).

**Note for the user.** The previous top section below (--extra-root) is
stale — that work was already committed by the human (942af6a).

---

# HANDOFF — `--extra-root`: explicitly assigned non-sensitive dirs as extra read/write roots (C35/D21) (2026-09-27)

**Status: WORK COMPLETE, gate green — AWAITING HUMAN COMMIT (guardrail zone).**
This increment touches `src/tools/sandbox.ts`, `src/tools/safety.ts`, and
`src/tools/bash.ts` — all guardrail zone. Per the self-improve protocol the
pre-commit hook REJECTS an agent commit here. The agent did all the work (code
+ tests + docs, gate green); the **human commits** it:

```sh
GUARDRAIL_BYPASS=1 git add -A
GUARDRAIL_BYPASS=1 git commit -m "Add --extra-root: explicitly assigned non-sensitive dirs under home as additional read/write roots (C35/D21)"
```

**What it is.** `--extra-root <dir>` (repeatable) assigns an ADDITIONAL
read/write region in addition to the workspace (`--cwd`). The workspace stays
the primary root (working dir, skills, sessions, the prompt's "Working
directory"); extra roots are boundary regions only. This is the contract for
"I explicitly allow this one directory" short of `--no-sandbox` (which removes
the boundary entirely) — it covers the sibling-project case and gives a
deliberate alternative to the `git push`/`~/.ssh` sandbox wall.

**Design — one boundary concept, two layers that MUST move together.** The
boundary is a *set* of roots (workspace + extra roots), enforced in two layers:
(1) the bash kernel policy (`generateBashSandboxPolicy(root, extraRoots)`)
re-allows each extra root's subpath (real path, read **and** write, plus its
ancestor-metadata chain), emitted BEFORE the workspace rule so the workspace
stays the last matching rule (last-match-wins); (2) the write/edit path sandbox
(`checkPathWithinRoots(roots, p)`) allows a path under ANY root. `read` stays
unrestricted. An extra root re-allows **its own subpath only** — never its
parent or siblings — so a path outside every root is still denied by the kernel
and refused by the hook.

**The sensitive-root guard (what makes it a contract).** At startup each
`--extra-root` is validated and the run REFUSES to start (exit 2, like `--cwd`
on a missing dir) if its real path is sensitive (`~/.ssh`, `~/.aws`, `*.pem`,
`.env`-family, …) or outside the user's home dir (v1 rule: a non-sensitive dir
under `~`). The (ws)/(sys) sensitive split keeps using the PRIMARY root only —
an extra root widens the *boundary* but never downgrades a path from
(sys)-sensitive to (ws), so a `.env` under an extra root is still blocked in
every mode.

**Inherited-sandbox limitation (documented, not fixed).** When
`TRE_SANDBOX === "1"` (tre running inside another sandboxed tre), the bash
child spawns unwrapped (it inherits the caller's confinement and the per-call
policy is not re-applied), so extra roots are inert there — same as the
workspace re-allow today.

**Numbering correction.** The spec was filed as "C27/D14" (commit `40fabfb`)
and its header said "next decision = D17". Both were stale: the decision log
had already spent D14–D20 and the source contracts run to C34. The correct
identifiers are **C35** (next contract after C34) and **D21** (next decision
after D20). Recorded in the spec header, `docs/02-contracts.md`, and below.

**Files changed.**
- `src/tools/sandbox.ts` *(guardrail)* — `generateBashSandboxPolicy` gains an
  optional `extraRoots` arg (default `[]` → byte-identical policy for all
  existing callers); each extra root gets read+write subpath allows (real
  path) + ancestor-metadata rules, before the workspace rules.
  `spawnSandboxedBash` opts gain `extraRoots`.
- `src/tools/bash.ts` *(guardrail)* — `BashToolOptions.extraRoots?` forwarded
  into the spawn call.
- `src/tools/safety.ts` *(guardrail)* — `SafetyOptions.extraRoots?`; new
  `checkPathWithinRoots(roots, p)` (allowed under ANY root; refusal names the
  full boundary); the write/edit hook uses the root set for the boundary but
  the PRIMARY root for the (ws)/(sys) sensitive split; new
  `validateExtraRoot(dir, home?)` (exists + is a dir + non-sensitive + under
  home; never throws).
- `src/cli/main.ts` — `--extra-root <dir>` (repeatable) parse + help; startup
  validation (exit 2 on refusal); wired into the bash tool, the safety hooks,
  and the system prompt; `behaviorSettingsLines` reports the extra roots.
- `src/prompt/system-prompt.ts` — `SystemPromptOptions.extraRoots?`; the
  "Working directory" section lists the workspace + each extra root (omitted
  when empty → byte-identical prompt for existing runs).
- `docs/05-extra-roots-spec.md` — status → IMPLEMENTED (C35/D21); fixed the
  §4.1 snippet's missing-paren bug (the same bug the new unit test caught in
  the code); corrected the refusal-message format (exit 2) and the §8 commit
  ref.
- `docs/02-contracts.md` — C35 paragraph (after the stall paragraph).
- `test/sandbox.test.ts` — policy shape (extra-root read+write allows +
  ancestor metadata, ordered before the workspace; `[]` → byte-identical
  regression pin) + a kernel canary (extra root readable+writable, its sibling
  denied, workspace still works, /etc still denied, node realpathSync into the
  extra root) that skips under an inherited sandbox.
- `test/safety.test.ts` — `checkPathWithinRoots` (any root / outside all /
  single-root parity); write/edit allowed under an extra root, refused outside
  all; **a sensitive path under an extra root stays (sys)-sensitive and
  blocked** (the guardrail property); `validateExtraRoot` (accepts a plain dir
  under home; refuses missing / sensitive / not-a-dir / outside-home).
- `test/cli.test.ts` — `--extra-root` parse (repeatable, in order);
  `behaviorSettingsLines` (renders / omits); `main` exit 2 on a nonexistent
  root; `main` exit 0 + summary lists a valid root (skipped when the repo is
  not under `$HOME`).
- `test/prompt.test.ts` — extra roots render in the Working-directory section;
  absent → byte-identical.
- `test/e2e.sh` — scenario 19 `extra-root(C35)` (a live model writes into the
  assigned extra root via the write tool AND bash; a non-assigned sibling is
  refused/denied) — skips under an inherited sandbox, like s10.

**Gate (green).** `tsc` clean; full suite **463 tests → 454 pass / 0 fail / 9
skip** (was 451/443/8: +12 tests, +1 skip = the new kernel canary, which
skips under the inherited sandbox). Quality-check source scan clean (31
files); dependency freeze OK (4 runtime / 4 dev).

**Kernel canary — NOT run here (inherited sandbox).** This session's bash tool
runs under an inherited kernel sandbox (`TRE_SANDBOX=1`), where nested
`sandbox_apply` is EPERM (rc 71) and the per-call policy is not re-applied —
so the kernel canary (unit) and e2e s19 both correctly SKIP here. To
live-verify the kernel boundary, run from a FRESH (non-sandboxed) shell:

```sh
npm test                      # unit, incl. the C35 kernel canary
TRE_SANDBOX= bash test/e2e.sh 19 19   # e2e scenario 19 (live 27B)
```

The unit canary and the policy-shape tests are the guardrail evidence that ran
green in the gate; the kernel canary + s19 are the live confirmation the human
should run before/with the bypass commit.

**Out of scope (v1).** Extra roots outside the home dir (external mounts,
`/opt`); per-root read-only vs read-write; config-file persistence of extra
roots (flag-only). See `docs/05-extra-roots-spec.md` §6.

---

# HANDOFF — fix: the two sandbox-induced bash-truncation test failures (2026-09-27)

**Status: COMPLETED, committed.**

**Problem.** Two tests in `test/tools.test.ts` failed on this machine
(since the 2026-09-27 telegram increment, which noted them as
"pre-existing"): `bash: >2000 lines → tail-truncated…` and
`bash: byte limit (1000 × 60B lines) truncates…`. Both spawn a child
command `node -e "…"` through the bash tool and assert `isError ===
undefined` — but the child exits 127 with `node: command not found`.

**Root cause.** The child shell resolves `node` via PATH. On this machine
node lives in an nvm dir that the kernel sandbox denies stat access to
(verified: `ls <nvm bin dir>` → "Operation not permitted" from a
sandboxed shell, while the binary itself runs fine by absolute path).
So PATH lookup fails for the child's `node`. The product was correct —
it faithfully reported a failing command; the TEST was environment-fragile
(it passed on machines where the sandbox can stat the nvm dir).

**Fix.** The two commands now use `process.execPath` (the running node
binary, absolute — no PATH lookup) instead of bare `node`:
`test/tools.test.ts` (2 lines + comment). No product code changed.

**Gate:** `tsc` clean; full suite 451 tests → 443 pass / 0 fail / 8 skip.

---

# HANDOFF — telegram skill: send/receive via a Telegram bot (2026-09-27)

**Status: COMPLETED, committed (skill is LOCAL — deployment-specific, gitignored).**
Activated on this machine (token + chat id in; both directions verified).

**What it is.** A skill (`.tre/skills/telegram/`) so the agent can message
the user over Telegram — send (task results / notifications) and receive
(instructions the user sends to the bot). One helper script
(`telegram.py`, stdlib `python3`, no installs) + a `SKILL.md`.

**Deployment policy (decided by the user):** skills are UNIQUE TO
INDIVIDUAL DEPLOYMENTS — the repo's `.gitignore` now ignores `.tre/skills/`
wholesale, with force-include exceptions only for the repo's own protocol
skills (`git-commit`, `self-improve`). The telegram skill is therefore
UNTRACKED: it stays on this machine, it does not go to GitHub. The
constraints it taught are documented in the repo instead:
`docs/04-skill-authoring.md` (load paths, workspace-only write boundary,
read asymmetry, `python3`-only network under the sandbox, secret handling,
state, fake-credential verification, a checklist recipe).

**The one manual step.** The user creates a bot with @BotFather and gives
the agent the token (invasive, so the user does it). Everything else —
writing `.tre/telegram.json`, discovering the chat id (`chatids` peeks
without consuming), sending, polling — the agent does itself.

**Key design constraints (verified empirically; full set in
`docs/04-skill-authoring.md`):**
- Skills load ONLY from `<cwd>/.tre/skills/` (project) and
  `~/.tre/agent/skills/` (user). The agent can only WRITE inside the
  workspace (write tool root-confined; bash kernel-sandboxed), so an
  agent-created skill MUST live in `<cwd>/.tre/skills/`.
- `read` file tool is NOT kernel-sandboxed (root-confined + sensitive-path
  gated) → the model CAN read `~/.tre/...`; `bash` CANNOT.
- Under the sandbox, `curl`/`git` FAIL TLS (LibreSSL can't read
  `/private/etc/ssl/openssl.cnf`) but `python3` (`/usr/bin/python3`,
  stdlib urllib) and node `https` WORK. `node` is also NOT on the sandboxed
  bash PATH (nvm dir denied) → the helper is `/usr/bin/python3`.
- Secrets go in a gitignored workspace file (`.tre/telegram.json`); name it
  plainly (`.json`) — sensitive-path patterns (`*.key`, `.env`, …) would
  block the agent's own read.

**Files:** `.tre/skills/telegram/SKILL.md` + `telegram.py` (LOCAL,
gitignored — NOT committed), `docs/04-skill-authoring.md` (committed),
`.gitignore` (skill-ignore policy + credential/state ignores, committed).
No source files touched (no guardrail-zone file).

**Gate:** `tsc` clean; full suite 451 tests → 441 pass / 2 fail (the two
pre-existing sandbox-induced bash-truncation failures) / 8 skip. Verified:
script send/poll/chatids reach the Telegram API (clean `401` with a fake
token = network+TLS+script+config all work), no-chatId / no-config error
paths, chunking ≤4000, and the skill loader indexes `telegram` correctly.
**Live-verified with the real token:** bot @Tredot_bot, chat id
7846729185, test send delivered, user's "Hi" received via poll.

---

# HANDOFF — stall detection: a second, complementary loop guard for the sandbox wall (2026-09-27)

**Status: COMPLETED, committed.**

**Problem.** The C26 loop guard stops a run when the model re-issues the
SAME batch (same tool names + same JSON args) 3× in a row. But it only
fires on BYTE-IDENTICAL retries. A model that REPHRASES the command each
attempt (`git push` → `git push origin main` → `git push --set-upstream …`)
defeats it — every batch is "new" — and it keeps banging on the sandbox
boundary forever. That is exactly the failure mode that stuck a prior
session: the kernel sandbox denies `~/.ssh` (so `git push` over ssh fails
with "Operation not permitted"), and the model retried with rephrased args,
never tripping the identical-batch guard.

**Fix.** A second guard in the tool pipeline (`makeToolExecutor`,
`src/tools/pipeline.ts`) that keys on the TOOL, not the arguments. It counts
consecutive permission-signature failures per tool; the 3rd is replaced
in-band with `stallText(tool)` + `details.stall` (I3: every call gets a
result) and the loop maps that detail onto a new `stopReason: "stall"` and
stops (resumable, exit 3). The call WAS executed (a permission denial is a
harmless no-op), so a legitimate 3rd operation that SUCCEEDS never trips it.
A different tool, a success, or any non-permission failure (transient errors
are normal retries) resets the count. The two guards are now complementary:
byte-identical retries → `loop` (loop guard, pre-execution); rephrased
retries → `stall` (pipeline guard, post-execution).

**Permission signature** (`STALL_PERMISSION_PATTERNS`): "operation not
permitted", "permission denied", "EACCES", "EPERM" (case-insensitive). Only
these count — a non-zero exit / timeout / "command not found" is a transient
failure and never trips the guard.

**Files changed.**
- `src/tools/pipeline.ts` — the stall guard (per-tool count, post-execution
  state update, in-band `details.stall` on the 3rd), `stallText(tool)`,
  `isPermissionStallText`, `STALL_PERMISSION_PATTERNS`.
- `src/tools/index.ts` — re-exports the new symbols.
- `src/loop/agent-loop.ts` — maps `details.stall` → `stopReason: "stall"`.
- `src/types.ts` — `"stall"` added to `StopReason`.
- `src/cli/main.ts` — `exitCodeFor("stall")` → 3.
- `src/tui/state.ts` — `agent_end` with `stall` → an error item explaining
  the sandbox wall + `--no-sandbox`, busy → false.
- `docs/02-contracts.md` — `stall` in the stopReason table + a dedicated
  paragraph describing the guard.
- Tests: `test/tools.test.ts` (6 pipeline tests), `test/agent-loop.test.ts`
  (2 loop-mapping tests), `test/cli.test.ts` (exit-code),
  `test/tui-state.test.ts` (error item).

**Gate.** `tsc` clean; `quality-check.sh` clean (31 files scanned, no
violations; dep-freeze OK — 4 runtime / 4 dev); full suite 451 tests, 441
pass, 2 fail, 8 skip. The 2 failures are the PRE-EXISTING bash-truncation
tests (documented below) — confirmed by stashing this change and re-running
on clean HEAD (identical 2 failures). No guardrail-zone file touched.

**Note on the 2 pre-existing failures.** They spawn `node -e` in a
SANDBOXED child bash. The sandbox re-allows the workspace but DENIES the
node binary's directory (`/Users/xilcilus/.nvm/…`), so the child gets
`node: command not found` (exit 127) → `isError`. This is a sandbox
artifact, not a code bug — it passes when run outside the sandbox.

**Not done (next session).** (1) Push the commits to GitHub — the sandbox
denies `~/.ssh` and network, so `git push` must be run OUTSIDE the sandbox
(or with `--no-sandbox`). (2) Optional: an end-to-end PTY capture showing a
rephrased `git push` retry loop stopping at `stall` (the unit tests cover
the pipeline + loop mapping; a live TUI capture would be the
definition-of-done for a TUI-facing change).

---

# HANDOFF — default approval = `--yes` (auto-approve); startup behavior summary (2026-09-27)

**Status: COMPLETED, committed.**

**User decision:** make `--yes` the DEFAULT approval mode for `tre.` —
`--ask` becomes opt-in. And the default must ALSO allow sensitive and
destructive (workspace-scoped) operations: the kernel sandbox is the real
boundary, and the codebase is backed up to git (reversibility). The only
things that stay blocked in EVERY mode are SYSTEMIC (sys) sensitive reads
and destructive commands. At startup, show the current behavior settings
and explain the optional flags.

**The new mode matrix (the core of the change):**

| classification   | yes (default)   | ask                | no            |
| ──────────────── | ─────────────── | ───────────────── | ──────────── |
| read-only bash   | allow, no prompt| allow, no prompt  | ALLOW (only bash class) |
| reversible bash  | allow, no prompt| allow, no prompt  | block        |
| mutating bash    | allow, no prompt| prompt            | block        |
| write/edit       | allow, no prompt| allow, no prompt  | block        |
| read (plain)     | allow, no prompt| allow, no prompt  | block        |
| sensitive (ws)   | allow, no prompt| prompt [SENSITIVE]| block        |
| sensitive (sys)  | **BLOCK**       | **BLOCK**         | block        |
| destructive (ws) | allow, no prompt| prompt [DESTRUCTIVE] | block    |
| destructive (sys)| **BLOCK**       | **BLOCK**         | block        |

- **(ws)** = workspace-scoped (rm -rf, git push, git reset --hard, a project
  `.env`, …). Allowed in the default, prompted in `--ask`.
- **(sys)** = system-level: sensitive paths that resolve OUTSIDE the
  workspace (`~/.ssh/`, `~/.aws/`, `/etc/shadow`, …) and inherently
  system-wide destructive commands (dd to `/dev/*`, raw-device redirects,
  mkfs, fork bomb, shutdown/reboot). BLOCKED in every mode — the "never,
  ever" category, not a confirm.

**Files changed:**
- `src/tools/safety.ts`: the mode matrix reworked. New pure classifiers
  `systemicDestructiveLabels` / `isSystemicDestructive` (split destructive
  labels into ws/sys) and `isSystemicSensitivePath` /
  `systemicSensitiveBashPaths` (a sensitive path is sys when it resolves
  outside the workspace). `makeSafetyHooks` default mode is now `"yes"`; the
  `gate` blocks sys sensitive/destructive first (every mode), then
  fail-closed `no`, then auto-approve `yes`, then prompt `ask`.
  `systemicSensitiveBashPaths` only flags tokens that BOTH match a sensitive
  pattern AND resolve outside the workspace (so `rm -rf /` is NOT
  sys-sensitive — `/` is not a sensitive path). Module header matrix +
  comments updated.
- `src/cli/main.ts`: mode derivation is now
  `args.noApprove ? "no" : args.ask ? "ask" : "yes"` (default `yes`). New
  exported `behaviorSettingsLines(mode, sandboxOn)` builds the startup
  summary (current approval + sandbox + what's blocked + the optional
  flags). TUI seeds it as a single multi-line info item (`startupInfo`);
  the plain CLI (one-shot + REPL) prints it to stderr. HELP text + the
  `--ask`/`--yes`/`--no-approve` option comments updated.
- `src/tui/run.tsx`: new `TuiRunOptions.startupInfo` — when set, seeded as a
  single multi-line INFO item (ℹ gutter, dim, wrapped) so the user sees the
  current behavior before the first prompt; absent → unchanged.
- `test/safety.test.ts`, `test/tools.test.ts`, `test/cli.test.ts`: the
  mode-matrix + default-mode + `--yes` tests rewritten for the new matrix
  (ws auto-allowed in yes; sys blocked in every mode; ws prompted in ask;
  `--ask` exercised explicitly).
- `test/e2e.sh`: scenarios 04 (deny) + 05 (ctrl+c after approval) now pass
  `--ask` (they relied on the old default prompting; the default is now
  auto-approve). Scenarios 01/02 still pass — `approval_or_done` returns 1
  when the turn finishes first (no prompt), so an auto-approved write just
  completes.

**PTY verification (mock SSE):**
- TUI: the first frame shows the `ℹ Behavior:` info item —
  `approval: auto-approve (default) — workspace-scoped work runs without a
  prompt`, `sandbox: on (bash confined to the workspace)`,
  `blocked: system-level sensitive reads + destructive commands (across the
  board)`, `optional: --ask … · --no-approve … · --no-sandbox`. /quit rc=0.
- Plain REPL: the same 5-line summary is written to stderr (the transcript
  sink is the model's context; the summary is for the human).
- `behaviorSettingsLines` renders correctly for yes/ask/no × sandbox on/off.

**Gate:** tsc clean; node --test 431 pass / 2 fail — the 2 failures are
PRE-EXISTING on clean HEAD (verified by stash + rebuild: `tools.test.js`
bash byte-limit / >2000-line truncation asserts, which spawn `node -e` and
fail because `node` is not on the child's PATH in this sandbox — unrelated
to this change).

**For the user:** `tre.` now auto-approves by default (workspace-scoped
work runs without a prompt); the sandbox + git backup are the safety net.
`--ask` restores the prompt-per-call behavior; `--no-approve` stays
fail-closed. Systemic sensitive reads + destructive commands are blocked in
every mode. Every start shows the current behavior + the optional flags.

# HANDOFF — TUI: highlight/copy restored (mouse tracking now opt-in) (2026-09-27)

**Status: COMPLETED, committed.**

**User report:** "I cannot highlight and copy in the TUI."

**Root cause (confirmed by code, not guessed):** `src/tui/run.tsx` enabled
mouse-tracking modes `ESC[?1002h` + `ESC[?1006h` ON BY DEFAULT (added for
C27 wheel/trackpad scrolling). With any mouse-tracking mode active,
xterm-compatible terminals forward pointer events to the app INSTEAD of
doing their own highlight-and-copy — so text selection dies. The TUI is a
read-mostly surface and PgUp/PgDn/Home/End already cover scrolling, so the
wheel was not worth the selection.

**Change (one behavior: mouse tracking opt-in):**
- `src/tui/run.tsx`: mouse mode now requires `TRE_MOUSE=1` (and not
  `TRE_NO_MOUSE=1` — legacy env still honored; it can only keep what is
  already the default). Default: NO mouse modes → terminal keeps
  highlight-and-copy.
- `src/tui/app.tsx`: the hint line names the wheel ONLY when
  `TRE_MOUSE` is set (`enter send · PgUp/PgDn/wheel scroll` vs
  `enter send · PgUp/PgDn scroll`; same for the scrolled status). The
  hint must not promise a wheel the terminal never forwards.
- `test/e2e.sh`: scenario 15 (scrollback) now runs with
  `TRE_MOUSE=1` (subshell export — the pty child inherits it); NEW
  scenario 18 `tui-no-mouse-by-default` pins the default: TUI renders,
  and NEITHER `ESC[?1002h` NOR `ESC[?1006h` appears in the PTY capture
  (grep -F, fixed-string — the BSD-grep `[?` bracket trap is documented
  in the C27 section).
- `test/tui-app.test.tsx`: new test pins both hint variants (wheel
  named iff TRE_MOUSE set), restoring the env in a finally.

**PTY verification (mock SSE, 40-line reply):**
- Default: zero `1002h/1006h` bytes in the capture; hint
  `enter send · PgUp/PgDn scroll · …`; PgUp froze the view
  (`↑17/28 scrolled — PgDn ↓ to bottom`); /quit rc=0.
- `TRE_MOUSE=1`: `1002h`+`1006h` present, `1002l`+`1006l` on exit;
  hint carries `/wheel`; SGR wheel-up `ESC[<64;10;20M` scrolled
  16→19 (+3 lines); End back to the bottom.

**Gate:** tsc clean; node --test 432 pass / 2 fail / 8 skip — the 2
failures are PRE-EXISTING on clean HEAD (verified by stash + rebuild:
`tools.test.js` bash-truncation asserts, unrelated to this change).
TUI suites: 101/101 pass.

**For the user:** highlight + copy works out of the box now. If you want
trackpad/wheel scrolling in the TUI, set `TRE_MOUSE=1` (e.g.
`TRE_MOUSE=1 tre. tui`) — the trade-off is that selection is captured by
the app while it runs (PgUp/PgDn/Home/End scroll either way).

# HANDOFF — .pi → .tre rename + docs de-pi-ification (2026-09-27)

**Status: PARTIAL — two commits in (`21da855` code, `e5bccdf` docs), the
guardrail-zone commit staged for the user's `GUARDRAIL_BYPASS=1`.**

**Decision (user, 2026-09-27):** move the skills dir `.pi/` → `.tre/` and make
the documentation not rely on explicit pi references. The `pi` name is KEPT
where it is a factual citation of the upstream design reference
(`@earendil-works/pi-*` v0.85.1 — `docs/03`, `docs/01`, README,
`THIRD_PARTY.md`); what goes is the *convention* (`.pi/` paths in code,
hook, skills) and the docs' dependence on a local reference install that no
longer exists.

**Why a previous session looped on this (root cause, confirmed):** the
guardrail hook protects `.pi/skills/self-improve/SKILL.md` BY PATH. Renaming
the dir makes the old path vanish — a rename-only commit slips past the hook
while the zone's protection silently disappears; updating the hook's regex is
itself a zone edit, which the hook rejects. The two fixes are mutually
exclusive in separate commits → the agent bounced between "commit the rename
(hook says OK but protection is gone)" and "update the regex (hook says
NO)". Resolution: ONE atomic commit containing the rename + the hook-regex
update + the skill-text updates, committed by a human with
`GUARDRAIL_BYPASS=1`.

**Done (committed `21da855`):** default skills dirs in `src/cli/main.ts`
moved to `<cwd>/.tre/skills` + `~/.tre/agent/skills` (usage comment +
`defaultSkillDirs`), new test in `test/cli.test.ts`, and the
`docs/03-citation-policy.md` freeze note (the local reference install at
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/` is gone —
borrowing is frozen; L1/L2 already cited stands as-is).

**Staged for the user's bypass commit (do NOT commit without it):**
`git mv .pi .tre` (both skills) + `scripts/guardrail-check.sh`
(PROTECTED regex → `^\.tre/skills/self-improve/SKILL\.md) + the two
SKILL.md zone-list text updates. Verified: the wired hook REJECTS this exact
staged set without the bypass and names both zone files.
Command: `GUARDRAIL_BYPASS=1 git commit -m "<message>"`.
ALSO (repo-local, not in git): this clone was missing
`git config core.hooksPath scripts/git-hooks` (the documented setup step) —
the pre-commit guardrail was NOT running at all on this clone; it is now
wired and verified (reject + bypass paths). A fresh clone must still run
that command once (noted in the hook header).

**Docs increment (committed `e5bccdf`):** `docs/01-walkthrough-harness-llm.md`
gains a "Reference status" note (frozen record of the v0.85.1 source,
traceable to the published packages, not a local install); README's
"traceable to the walkthrough" line + docs list note the frozen status;
the two stale "Still open" lines in older sections are marked RESOLVED.
Gate re-run clean (433 pass / 0 fail / 8 skip).

**Still open (needs user decision, not started):** removing the `pi`
dependency — scope unresolved (all references vs the borrowed code /
`.pi/` convention). NOTE (2026-09-27): the convention half (`.pi/` paths)
is resolved by this section; the scope question is now only about the
factual citations + L1/L2 borrowed code, which the freeze note in
`docs/03` says stand as-is until the reference is re-audited.

# HANDOFF — TUI scroll: stop resetting the viewport when steering (IN PROGRESS, 2026-09-26)

**User report:** two-finger trackpad drag doesn't scroll the TUI, and the
screen "resets/clears" when steering (typing a line + Enter mid-run).
**User chose option 2:** keep the pinned TUI; (a) preserve scroll position
across steers, (b) make wheel/trackpad handling more robust. Two small
increments, PTY-verified.

**Root cause CONFIRMED (PTY repro, not guessed):**
- SGR wheel events DO work: feeding `ESC[<64;10;20M` under `script` scrolls the
  viewport (hint line goes `enter send` → `↑3/15 scrolled` → `↑22/22`).
- The single `ESC[3J`/`ESC[2J` in the capture is at the very end (documented
  one-time clear on unmount) — **no mid-run scrollback clear**.
- The "reset" = **`steerInput` in `src/tui/state.ts` sets `viewTop: null`**
  (follow bottom), so a steer yanks the viewport back to the bottom. Repro:
  scroll up to `↑22/22`, steer "be brief" → hint flips back to `enter send`.

**Increment 1 (next): preserve `viewTop` in `steerInput`.**
- Change: `src/tui/state.ts` `steerInput` — drop `viewTop: null` from the
  returned state (keep `input:""`, `cursorPos:0`, `historyIdx:null`, history
  push, user item, `busy:true`).
- Test: `test/tui-state.test.ts` — the "steerInput: busy + non-slash line"
  test (line ~605) must assert `viewTop` is preserved (set `viewTop: 30` on
  the input state, assert `r.state.viewTop === 30`).
- PTY verify: re-run `.repro/feed-steer.sh` flow (mock on `.repro/mock-port.txt`
  port, `script -q /dev/null node dist/src/cli/main.js tui --yes --models
  .repro/models.json --session .repro/s.jsonl --cwd .repro`), expect the hint
  to STAY at `↑N/M scrolled` after the steer (not flip to `enter send`).
- Then: build+test gate, commit (message: `fix(tui): keep scroll position when steering`),
  update this section to COMPLETED.

**Increment 2 (COMPLETED): enable base mouse-tracking mode 1002.**
- ROOT CAUSE of "two-finger drag doesn't scroll": `run.tsx` emitted ONLY
  `ESC[?1006h`. 1006 is the SGR *report format*, not a mouse-tracking mode —
  in xterm-compatible terminals it enables NO reporting, so the terminal
  never forwards the trackpad wheel. (The earlier PTY "proof" fed raw SGR
  bytes directly, bypassing the terminal's gesture-to-event translation.)
- FIX: `src/tui/run.tsx` now emits `ESC[?1002h` + `ESC[?1006h` at startup and
  `ESC[?1006l` + `ESC[?1002l` on every teardown path. 1002 (button-event) is
  the base mode that makes the terminal send events; 1006 shapes them as SGR.
  1002 chosen over 1003 (any-event) to avoid pointer-motion noise.
- e2e scenario 15 extended to assert 1002h+1002l too. ALSO fixed a
  PRE-EXISTING bug found while doing this: the 1006h/1006l greps used
  `grep -q $'ESC[?1006h'` (ESC = real escape byte) — BSD grep 2.6.0-FreeBSD
  parses `[?1006h` as an UNBALANCED bracket expression and exits 2 (error),
  so the scenario false-failed with "mouse mode 1006 never enabled" even
  though the bytes were present (grep -F proves it). All four mouse-mode
  greps are now `grep -qF` (fixed-string). Verified: scenario 15 PASSES
  against the mock ("40-line reply rendered AND scrolled ... mouse mode
  enabled+restored").
- Mock now complies with the prompt's line count (`.repro/mock-slow.mjs`
  parses "1 through N") so scenario 15's exact-40-lines check is meaningful.
- NOTE: a root `models.json` (gitignored) was created pointing at the mock for
  e2e, then DELETED so it can't shadow `~/.tre/models.json`.

**Repro assets (in `.repro/`, gitignored):**
- `mock-slow.mjs` — SSE mock streaming 60 lines @ 200ms on 127.0.0.1 (port in
  `.repro/mock-port.txt`; restart: `node .repro/mock-slow.mjs > .repro/mock-port.txt 2>&1 &`
  then `sed -i '' "s#http://127.0.0.1:[0-9]*/v1#http://127.0.0.1:$PORT/v1#" .repro/models.json`).
- `feed-steer.sh` — prompt, sleep 6s, 5× SGR wheel-up, sleep 1.5s, steer
  "be brief", sleep 1.5s, /quit.
- `out2.log` + python one-liner (strip ANSI, print lines containing
  'scrolled' or 'enter send') = the hint-sequence check.
- `out.log` / `out-clean.txt` — earlier plain wheel repro.

**State:** BOTH increments done. Increment 1 committed (`dd25cc6`).
Increment 2 (run.tsx 1002 + e2e.sh grep -qF fix + handoff) is staged for
commit. Mock server may still be running (`pkill -f mock-slow.mjs` to stop;
port in `.repro/mock-port.txt`). Root `models.json` deleted.

---

# HANDOFF — Deployable on another endpoint / another Mac (2026-09-26)

**Status: COMPLETED.** Three commits: `6de4856` (startup config guide),
`e83f96a` (build-on-install + files), `2f14df4` (files trim). Goal: `tre.`
deploys cleanly on a new machine (e.g. another macOS laptop) pointed at a new
LLM endpoint.

**What made it deployable (and verified end-to-end):**

1. **Build-on-install** (`e83f96a`): `package.json` gained `"prepare": "tsc"`
   + a `files` allowlist. `dist/` is gitignored, so a fresh clone had none and
   `npm i -g .` produced a broken bin. Now `npm install` runs `prepare` →
   `tsc` → builds `dist/` before the bin is linked; the `files` list makes
   `npm pack`/tarball include `dist` (`.gitignore` would otherwise exclude it).
   Verified: fresh clone → `npm install` → `npm i -g .` → working `tre.` bin;
   and `npm pack` → tarball (contains `dist`) → `npm i -g <tarball>` → works.
2. **Startup config guide** (`6de4856`): with no endpoint configured (no
   `models.json`, or the active model's `baseUrl` blank), `tre.` prints a
   step-by-step `models.json` setup (REQUIRED vs OPTIONAL; each required field
   `populated: <value>` or `NEEDED: <placeholder>`; + a fill-in template) and
   exits 2 — instead of a bare "not found". This is the config-time trigger
   (deterministic, no network probe).
3. **Endpoint-agnostic artifact** (`2f14df4`): the `files` list ships
   `dist/src/tsconfig/README/THIRD_PARTY` only — no dev `models.json` (the
   endpoint is supplied at deploy time via the guide) and no test source.

**The "another Mac" flow (proven against a mock OpenAI endpoint):**
fresh clone → `npm install` (builds `dist`) → `npm i -g .` → first run with no
endpoint prints the guide → user writes `models.json` with the new `baseUrl` →
re-run streams a real reply.

**Notes:**
- `tre.` is an interactive TUI *client* — it makes OUTBOUND calls to the LLM
  endpoint and listens on no inbound port. Deploy = install the package +
  provide `models.json` (or `--models <file>`); no ports/ufw/compose.
- `models.json` lookup (D19): `--models` → nearest `models.json` above cwd →
  `~/.tre/models.json`. Put the endpoint config in `~/.tre/models.json` for a
  machine-wide default.
- Docker was considered (Dockerfile + .dockerignore drafted) but removed to
  keep the tree clean — the npm-install path is the supported deploy. Re-add
  only if the registry/VM pipeline is actually wanted.
- `engines.node >= 20` (global fetch + ESM). A target Mac needs Node ≥ 20.

---

# HANDOFF — Startup config guide: step-by-step models.json setup when no endpoint is configured (2026-09-26)

**Status: COMPLETED.** One increment, one commit (see git log). Part of making
tre. deployable on another endpoint/machine.

**The problem.** A fresh checkout / first run on a new machine has no endpoint
wired up yet, so `tre.` could only print a bare "models.json not found" error
and exit 2 — dead end for someone deploying to a new endpoint.

**The fix.** At startup, when there is **no endpoint configuration populated**
(no models.json, or the active model's `baseUrl` is blank), `main()` prints a
step-by-step configuration guide to stderr and exits 2. The guide is
**adaptive**: it lists every field, marks each **REQUIRED** field as either
`populated: <value>` (already filled in — shows the value) or `NEEDED:
<placeholder>` (still blank), and lists the **OPTIONAL** fields (`apiKey`,
`temperature`, `compat`) as populated or `(unset)` — optionals never block
start. It ends with a ready-to-edit JSON template (populated values kept,
blank ones as placeholders).

- `src/config/models.ts`:
  - `buildModelsSetupGuide(model, fileLabel)` — pure guide generator (REQUIRED
    vs OPTIONAL, populated vs NEEDED, + template). `REQUIRED_FIELDS` /
    `OPTIONAL_FIELDS` drive it; `isPopulated` = non-empty string / finite
    positive number / non-empty object.
  - `hasEndpoint(model)` — true iff `baseUrl` is populated (the trigger).
  - `readActiveModelLenient(path)` — reads the active (default, else first)
    model's populated fields WITHOUT throwing on missing required fields, so
    the guide can show what's already filled in. `null` = unreadable/bad JSON
    (strict loader reports those); `{}` = no models at all.
- `src/cli/main.ts`: startup now (a) no models.json → empty guide to
  `~/.tre/models.json (or pass --models <file>)`; (b) models.json present but
  `!hasEndpoint(lenient)` → adaptive guide for that file; (c) otherwise
  proceeds to the strict load as before. Exit 2 in (a)/(b).
- Tests: `test/models.test.ts` (+7: hasEndpoint, guide empty/partial/optional,
  lenient partial/default-resolution/bad-json/empty), `test/cli.test.ts`
  (+3: no-file guide, blank-baseUrl adaptive guide, configured-endpoint
  proceeds without a guide).

Tests: full suite green (430 pass, 0 fail; 438 total, 8 live-skipped).
Verified against the compiled binary in a clean-HOME sandbox: missing file →
empty guide; blank-baseUrl file → adaptive guide (populated shown, baseUrl
NEEDED); configured endpoint → no guide.

Note: this is the CONFIG-TIME trigger (deterministic, no network probe), per
the spec — "no endpoint configuration populated" = `baseUrl` blank. A
reachable-vs-not check would be flaky (network/sandbox) and is intentionally
out of scope.

---

# HANDOFF — TUI /models: list the catalog + switch the active model (2026-09-26)

**Status: COMPLETED.** One increment (C34), one commit: `ac76b10`.

`/models` lists the models.json catalog and switches the active model
mid-session.

- `src/tui/state.ts`:
  - `ModelOption` (new, light: id + provider + contextWindow + maxTokens)
    and `TuiState.models` (the catalog) — the state machine is pure and
    never talks to the wire, so it carries only what it renders; the FULL
    ModelConfig (baseUrl, apiKey, compat) stays in the driver.
  - `modelsListReport(state)` — the multi-line `/models` body: one line per
    model, the active one marked `*`, each showing id + provider + window
    (so a switch's effect on the context field is visible before it
    happens). Empty catalog → "(no catalog supplied)".
  - `applyModelSwitch(state, id)` — the pure switch: re-seeds modelLabel +
    the context field (window + maxTokens); null on unknown id (a typo can
    never silently switch).
  - `/models` + `/models <id>` in `SLASH_COMMANDS` + `handleSlashCommand`
    (info item; works mid-run via the C32 busy route, like `/stats`).
  - **Menu-cap fix**: `visibleCandidates` (slashCandidates capped to
    MENU_MAX_LINES) is now the single source for `suggestMenu`, `menuNav`
    AND `menuComplete`. Before, the 6th command (`/models`) pushed the
    registry past the cap while menuNav/menuComplete still wrapped within
    the FULL list — navigating to index 5 (the hidden 6th) made the
    selection marker vanish. Now the marker is always on a visible line.
- `src/tui/run.tsx`: `modelsFile` + `rebuildSystemPrompt` options; the
  ACTIVE model + system prompt are now mutable (`let`), seeded from the
  catalog at startup; `runPrompt` reads the live ones; both slash call
  sites detect a switch (modelLabel changed) → `resolveSwitchedModel`
  re-resolves the full ModelConfig by id + rebuilds the prompt. A running
  turn keeps the old model; the NEXT run uses the new one.
- `src/cli/main.ts`: loads the full `ModelsFile` once (reused for the
  resume path too) and passes it + a `rebuildSystemPrompt` closure
  (buildSystemPrompt over the driver's cwd/tools/skills) to `runTui`.
- Tests: `test/tui-state.test.ts` (+3: list report, applyModelSwitch,
  `/models` handler), `test/tui-pinned-layout.test.ts` (menu tests updated
  for the 6-command registry capped to 5 visible — `/stats` drops off the
  menu; wrap/complete now within the visible 5).

Tests: full suite green (420 pass, 0 fail; 428 total, 8 live-skipped).
PTY verification (live 27B, 2-model catalog both pointing at the endpoint,
windows 32768 vs 200000): `/models` lists `* small [vks-llama] window
32.8k` + `big … 200k`; `/models big` → `models: switched to big (window
200k)`; the bottom field re-seeds from `context: 32.8k window (no usage
yet)` / `model: small` to `context: 1.6k/200k (1%) · sys 0.6k · msgs 1k ·
@190.8k` / `model: big` — the switch re-resolved the full config and the
context field reflects the new window + threshold.

Note: the slash menu now shows 5 of 6 commands (`/stats` is capped off the
`/` menu but still reachable by typing it). If a 7th command is ever
added, raise `MENU_MAX_LINES` or the cap silently hides more.

---

# HANDOFF — TUI context display: breakdown + compaction trigger + colors (2026-09-26)

**Status: COMPLETED.** One increment (C33), one commit: `f30e682`.

The `context` bottom field now answers TWO questions the old
`used/window (pct)` did not: **where** the context tokens come from and
**when** compaction fires.

- `src/tui/state.ts`:
  - `TuiState.systemPromptTokens` (new, `makeInitialState` 6th arg) —
    the fixed prompt floor, estimated chars/4 (the loop's estimator) and
    seeded by the driver from `opts.systemPrompt`.
  - `TuiState.summaryTokens` — estimated size of the current compaction
    summary (chars/4 from the event's `summaryChars`), set on each
    `context_compacted`; 0 until the first compaction.
  - `compactThreshold(window, maxTokens, slack=1024)` — the REAL
    `shouldCompact` trigger (`window − maxTokens − slack`, clamped ≥ 0),
    exported so the display and the loop can never drift.
  - `contextBreakdown(state)` — `{ system, summary, messages, total,
    threshold, headroom }`; messages = total − system − summary (the
    summary is a user message IN context, so it is part of total).
  - `contextReport(state)` — the multi-line `/context` body:
    total/window + `system prompt / summary / messages` split + the
    trigger with headroom (`DUE` when over).
  - `contextUrgencyColor(state)` — green < 70% ≤ yellow < 90% ≤ red of
    the THRESHOLD (not the window — compaction fires at the threshold);
    undefined (dim) when unknown.
  - `bottomLineColors(state)` — per-line colors aligned 1:1 with
    `bottomLines` (mirrors its unknown-key skip + padding), so the
    renderer pairs color with text.
  - The `context` bottom value is now
    `used/window (pct) · sys N · [sum N] · msgs N · @threshold|DUE`
    (compact: the headroom number lives in `/context`, not the one-liner,
    so it fits a bottom line). `fmtTokens(0)` → `"0"`.
  - `/context` added to `SLASH_COMMANDS` + `handleSlashCommand` (info
    item; works mid-run via the C32 busy route, like `/stats`).
- `src/tui/app.tsx`: the reserved bottom lines render through
  `bottomLineColors` — the context line is tinted by urgency, the rest
  stay dim.
- `src/tui/run.tsx`: seeds `systemPromptTokens` from `opts.systemPrompt`.
- Tests: `test/tui-state.test.ts` (+6: threshold, breakdown, urgency
  color, report, `/context` handler, bottomLineColors),
  `test/tui-pinned-layout.test.ts` (context field expectations enriched;
  menu tests updated for the 5th command — `/context` sorts first).

Tests: full suite green (417 pass, 0 fail; 425 total, 8 live-skipped).
PTY verification (live 27B, trivial prompt): the bottom field renders
`context: 1.6k/131.1k (1%) · sys 0.6k · msgs 1k · @97.3k` with the GREEN
urgency escape (`\u001b[32m`) in the raw frame; `/context` appends the
4-line report (system prompt 0.6k / messages 1k / compaction at 97.3k,
95.7k headroom).

---

# HANDOFF — TUI config: persisted `/display-bottom` + slash commands mid-run (2026-09-26)

**Status: COMPLETED.** Two increments (C32), three commits:

1. `975cd44` — the `/display-bottom` selection now survives between tre.
   sessions. New `src/tui/tui-config.ts`: the selection lives in
   `~/.tre/tui.json` (the TUI's permanent home, next to models.json and
   sessions/). `loadTuiConfig` never throws (missing/corrupt/non-object
   file → default; `bottom` normalized like the command itself — unknown
   fields dropped, deduped, order kept — so a hand-edited file can never
   select a nonexistent field); `saveTuiConfig` is best-effort (creates
   the parent dir, swallows write failures, returns bool). The driver
   (run.tsx) loads at startup into `makeInitialState` (new 5th arg) and
   saves after a handled slash command whose `bottom` array reference
   changed (exactly the `/display-bottom` set/off/unknown-field paths —
   `/stats` keeps the same array, so no spurious writes).
2. `1cc1839` — slash commands are handled WHILE A TASK IS RUNNING. A busy
   submit with a `/` prefix goes through the new pure `submitSlashBusy`
   (state.ts: clears the line like submitInput — input/cursor/history —
   and returns the trimmed line; null when idle/approving/empty/non-slash)
   + `handleSlashCommand` — so `/display-bottom` reconfigures the bottom
   lines mid-task (feedback lands as an info item, `busy` untouched, the
   run and the loop's next drain are unaffected), and `/stats` works
   mid-run too. A slash line is NEVER a steer (it must not be queued for
   the loop); unknown slash lines stay swallowed, non-slash lines still
   steer, and `/quit`-while-busy still aborts+exits (checked first).
3. `cd0b9c9` — e2e scenario 17 (`tui-slash-mid-run(C32)`): a 40-line
   reply (the wide mid-run window, scenario-15 task), `/display-bottom
   model turn` typed while the turn runs, then asserts on the
   ANSI-stripped frame (line-anchored greps need the clean text — raw
   capture lines carry `\r` + dim escapes): the feedback info line, the
   new bottom fields rendered, the reply completed after the mid-run
   command, and `~/.tre/tui.json` == `["model","turn"]`. HOME is pointed
   at the scenario dir so the real user's config is never touched.

Files: `src/tui/tui-config.ts` (new), `src/tui/state.ts` (`makeInitialState`
bottom seed + `submitSlashBusy`), `src/tui/run.tsx` (load at startup,
save-on-change, busy-slash route), `test/tui-config.test.ts` (new, 11
tests), `test/tui-state.test.ts` (seed + busy-route pins), `test/e2e.sh`
(scenario 17 + runner registration).

Tests: full suite green (411 pass, 0 fail; 419 total, 8 live-skipped).
PTY verification: (a) persistence — session 1 set `model context`,
`~/.tre/tui.json` written, fresh session 2 restored both fields with the
pinned frame intact; (b) mid-run — a `sleep 8` bash tool running,
`/display-bottom model turn` typed mid-tool: feedback info line rendered,
bottom lines switched live, tool finished, config persisted. E2E 17
passed live against the 27B.

Note for future work: the `edit` tool corrupted `test/e2e.sh` twice during
this task (truncated lines around the replacement point, duplicated tail) —
the file was restored from git and the scenario was patched via a
deterministic python script instead. If `edit` misbehaves on that file
again, `git checkout -- test/e2e.sh` and re-apply.

---

# HANDOFF — TUI readability: block icons, hanging indents, turn spacing (2026-09-26)

**Status: COMPLETED.** One increment (C31): the TUI rendered every block as
plain full-width text — a user prompt, an assistant reply, a tool line, an
error, and an info note all looked the same, and a long block's wrapped
lines ran back to column 0, so the eye had no anchors. New rendering in
`src/tui/lines.ts` (the single source of truth for line shapes; the height
math in `state.ts` mirrors it — the lockstep contract
`itemLines(item, width, prev).length === itemHeight(item, width, prev)`
still pins both sides):

- **Icons per block type** — `❯` user prompt (cyan), `◆` assistant reply
  (default fg), `◦` thinking header (dim), `⚠` error (red), `ℹ` info (dim),
  `✂` compaction (magenta); tool marks unchanged (`✓`/`✗`/`→`, colored).
- **Hanging indent** — every block's text wraps at `width−2` under its
  2-column icon: icon on line 1, 2-space indent on the rest, so a wrapped
  block reads as one unit (tool diff lines get the same 2-space hang under
  the header).
- **Turn spacing** — a blank line separates a user prompt from the block
  that follows it, and every block from the next user prompt (a new turn).
  Implemented as a LEADING line of the later item (`blankBefore(item, prev)`
  in lines.ts, mirrored in `itemHeight`): the per-item lockstep contract
  holds with the same `prev` on both sides, and a C30 clip of an over-budget
  item drops the separator first (it is the item's first line).
- **Menu highlight** — the selected slash-command candidate is YELLOW
  (was plain fg); the resting menu stays dim.

Files: `src/tui/lines.ts` (icons + hanging wraps + `blankBefore`; all
`itemLines` shapes), `src/tui/state.ts` (`itemHeight`/`itemsHeight`/
`fitItems`/`fitItemsScrollable` take and pass the `prev` predecessor),
`src/tui/app.tsx` (`Item` receives `prev` — its ABSOLUTE predecessor in
`state.items` via `prevOf`, so the render counts what the fit counted —
and the menu's selected line is yellow), `test/tui-pinned-layout.test.ts`
(rewritten geometry pins: C31 separator rules, hanging-wrap heights, the
C28/C30 window math at the new line counts, span shapes),
`test/tui-app.test.tsx` (pinned-frame test at the new geometry),
`test/e2e.sh` (scenario 15: reply lines hang 2 under `◆`, so the
"line 40 rendered" grep allows a leading indent).

Tests: full suite green (397 pass, 0 fail). PTY capture: fresh session,
`/display-bottom model` → `/quit` — frame exactly 24 rows, input row 4
above the bottom, pinned block (hint / `─` / input / `─` / display lines)
intact; icon shapes are pinned by the unit tests (the capture's empty
session has no content blocks to show).

---

# HANDOFF — TUI bottom display: `context` field — window, used, %, compaction reset (2026-09-26)

**Status: COMPLETED.** One increment: the bottom display (`/display-bottom`)
had no visibility into the model's context window — the `tokens` field is the
CUMULATIVE session total (grows forever, says nothing about pressure), so
when a compaction fired the user had no idea how full the window was, or how
much the compaction freed. New selectable field `context` (menu order:
`model status turn tokens context cwd session`):

- **Value** — `used/window (pct)`, e.g. `context: 25.3k/81.9k (31%)`.
  `used` = the LAST assistant `done` usage's `totalTokens` (prompt+completion
  of the last call — the SAME number `shouldCompact` compares against the
  window, so the field shows exactly what the trigger sees). Right after a
  compaction it is the estimate of the new `[summary, …kept]` context (the
  `context_compacted` event now carries an optional `contextTokens`,
  computed by the CLI via `estimateTokens`), so a 120k→9.6k compaction reads
  as a visible reset (`context: 9.6k/131.1k (7%)`). Numbers format compact:
  `131.1k`, `2.1M`.
- **Unknown sides** — no usage yet (fresh session): `131.1k window (no
  usage yet)`; no window in the model config: `—`; usage without a window:
  `45.2k/—` (no %). A `done` without usage keeps the previous estimate; a
  `context_compacted` without `contextTokens` (older emitter) keeps the last
  usage-based estimate — the field never blanks.

Files: `src/types.ts` (optional `contextTokens` on `context_compacted`),
`src/cli/main.ts` (emits it — `estimateTokens([summaryMsg, …kept])`),
`src/tui/state.ts` (`contextWindow`/`maxTokens`/`contextTokens` state +
`makeInitialState` params, folds in `done`/`context_compacted`, the
`context` field + `fmtTokens`), `src/tui/run.tsx` (seeds the window from
`ModelConfig`). The plain CLI's compaction line is untouched.

Tests: new `contextTokens` state-machine test (usage tracking, no-usage
keep, compaction reset, legacy-event fallback) in `test/tui-state.test.ts`;
`bottomLines` context cases (idle window, used/window/%, unknown window,
compaction drop, M formatting) + updated menu-order assertion in
`test/tui-pinned-layout.test.ts`. Full suite green (397 pass, 0 fail).
PTY capture: `/display-bottom context status model` renders
`context: 131.1k window (no usage yet)` in the pinned block, frame intact.

**Note for the user:** the field is opt-in like the others —
`/display-bottom context status model` (or add `context` to your current
selection). `/stats` is unchanged.

---

# HANDOFF — TUI no longer clears the terminal scrollback on a new turn (2026-09-26)

**Status: COMPLETED.** One increment (C30): the TUI wiped the terminal's
scrollback whenever a turn's output was tall enough to overflow the frame,
so the user could not scroll back. Root cause: in FOLLOW mode
(`viewTop === null`, the default), `fitItemsScrollable` fell back to
`fitItems`, whose documented behavior for a single item taller than the item
budget is to keep it WHOLE and let `pad = 0` — "the frame may then exceed
rows, which Ink handles by scrolling." Ink does NOT handle that gracefully:
an overflowing frame trips `shouldClearTerminalForFrame` → `clearTerminal`,
and `ansi-escapes.clearTerminal` is `\u001b[2J\u001b[3J\u001b[H` — **`\u001b[3J`
erases the terminal's scrollback buffer**. A long reply or a big tool diff
(the common "new turn" shape) overflows the ~16-row item budget at 24 rows,
so every such turn cleared the scrollback.

**Fix (state.ts only, `fitItemsScrollable` follow path).** When the legacy
tail window's last item alone exceeds the budget, CLIP it to the budget
instead of rendering it whole — show its LAST `budget` lines (follow the
bottom) by keeping the ORIGINAL item and recording the line range
`[h-budget, h)` (the renderer already slices `itemLines(item).slice(from, to)`,
the same mechanism the pinned path uses — no per-kind rebuild). The frame is
now exactly `rows` tall in every case, so `shouldClearTerminalForFrame` never
fires and no clear is ever emitted. When the tail fits (the common case) the
clip is a no-op and the frame is byte-identical to the legacy window.
`fitItems`'s own contract is unchanged (it still returns the whole item);
the doc comment now notes the caller clips it.

**Verification.** Unit probe (fake TTY, 24 rows): a 30-line single reply in
follow mode — before the fix the SECOND frame emitted
`\u001b[2J\u001b[3J\u001b[H`; after the fix, zero clears and the frame is
exactly 24 rows showing the last 16 lines (follow the bottom). End-to-end
(real `runTui` + `script` PTY + a fake model streaming a 40-line reply): the
turn emits NO `\u001b[3J`; the only clear in the whole run is the one-time
unmount teardown. New regression test `C30: FOLLOW mode clips an over-budget
tail item` pins the clip (single item, over-budget tail after a short item,
and the no-overflow no-op case). Full suite green (396 pass, 0 fail).

**Note for the user:** this is the TUI (the Ink app). The plain CLI/REPL
printer is untouched. The terminal's OWN scrollback now accumulates across
turns as expected — you can scroll back through prior turns. (The in-app
PgUp/wheel scroll still works as before for content beyond the viewport.)

---

# HANDOFF — TUI color pass: tool lines and busy state get distinct colors (2026-09-26)

**Status: COMPLETED.** One increment: the TUI's output area was mostly
monochrome — the user prompt (cyan), the outcome marks (✓/✗), the diff
lines, and compaction were colored, but the tool NAME/ARGS were plain
default-fg, the in-flight `→` mark was the same dim gray as idle chrome,
and the header's `· working…` was dim. Now the output reads by type:

- **Tool header** — the mark keeps its outcome color (red `✗` / green `✓`),
  the **in-flight `→` mark is yellow** (was gray — it now jumps out while a
  tool runs), and the **tool name is blue** (separates the tool line from
  the cyan user prompt and the plain assistant reply). The args stay
  default-fg. `src/tui/lines.ts`: the header is still wrapped as ONE string
  (the lockstep contract `itemLines.length === itemHeight` is untouched —
  wrap-ansi's hard wrap only inserts newlines, so the wrapped rows are
  contiguous slices of the original), then each row is re-split into
  colored spans by clipping the mark/name/args segment boundaries to the
  row's range (handles a name that itself wraps).
- **Busy header** — `· working…` is now yellow (the one moment the header
  should stand out; the dim chrome is the resting state). The dim base is
  truncated to leave room for the indicator, so the header is ALWAYS
  exactly one row (frame contract) — a long model label truncates instead
  of wrapping the frame to rows+1.

Tests: the span-shape pins in `test/tui-pinned-layout.test.ts` updated for
the new mark/name colors (incl. a new red-`✗` error-tool case), plus a new
frame-height regression in `test/tui-app.test.tsx` (busy frame == idle
frame height with a 90-char model label). Full suite green (395 pass, 0
fail). PTY capture: pinned block intact, 24 rows. Color codes verified in
a FORCE_COLOR render: 33m `→`, 34m name, 32m `✓`/diff+, 31m `✗`/diff-,
36m user, 33m `· working…`.

**Note for the user:** this is the TUI (the Ink app). The plain CLI/REPL
printer (`printEvent` in `src/cli/main.ts`) is deliberately untouched — it
prints to piped stdout where color is not assumed. If you also want the
one-shot/REPL output colored, that is a separate increment (it would need a
TTY/color-support check before emitting ANSI).

---

# HANDOFF — safe command substitution / heredoc no longer prompt (2026-09-25)

**Status: COMPLETED.** Implemented by tre. (one-shot runs, 27B Qwen3.8 on
the TKG NVIDIA cluster) across three 30-min chunks; the final two fixes
(label inheritance + git subcommand position) were finished by the
orchestrator after the last watchdog kill, per the session's standing
approval for guardrail-zone commits. `src/tools/safety.ts` is in the agent's
own cage — committed by the user's explicit instruction with
`GUARDRAIL_BYPASS=1`.

**Also in this increment (second fix).** The destructive git checks matched
their keyword ANYWHERE after `git` (`rest.indexOf("push")`), so
`git stash push -m wip` was falsely flagged "git push (publishes to a
remote)". Now each check requires the keyword to be the actual
SUBCOMMAND — the first positional after the git token, skipping global
flags (`-C <path>`, `-c <val>`, other leading flags) via the new
`gitSubcommand()` helper. `git -C /r push origin main` and
`git -c user.name=x push --force origin main` are still caught;
`git stash push`, `git commit -m push`, `git stash list` are not.

**What changed.** The bash approval gate used to treat ANY command
substitution (`$( … )`), backtick (`` `…` ``), `sudo`, or output redirect to a
real path as a blanket disqualifier: `git commit -m "$(date)"` and
`git add -A && git commit -m "$(cat <<'EOF' … EOF …)"` — the model's everyday
commit shapes — fell into unknown-mutating and prompted in the default `ask`
mode, even though the inner command is trivially read-only. Now a
substitution is a **safe opaque argument** when its INNER command is itself
read-only (or, for the reversible classifier, reversible); only an inner
command that is not provably safe still disqualifies. `sudo` and an output
redirect to a real path remain unsafe, and an unbalanced substitution fails
closed.

**Why.** The old rule was all-or-nothing: a `$( )` anywhere meant "not
read-only / not reversible", regardless of what the substitution actually
did. The model builds commit messages with `$(date)` / `$(git status)` /
heredocs constantly, so the default mode prompted on routine, side-effect-free
commands — asking for approval on a reversible action is out of spec. The fix
classifies the *inner* command and lets the outer command inherit its safety,
while keeping the fail-closed guarantees (unknown / mutating / destructive
inners, `sudo`, real-path redirects, and unbalanced substitutions still gate).

**How (safety.ts only).**
- New `constructVerdict(command, purpose, depth)` → `{ kind: "safe" | "unsafe"
  | "destructive" }`, evaluated for a classifier PURPOSE. `purpose` is
  `"readonly"` or `"reversible"`: a substitution whose inner is read-only is
  safe for BOTH; a substitution whose inner is merely reversible (mutating)
  is safe only for the reversible classifier (it has side effects, so it is
  NOT a read-only argument). `sudo` → unsafe; a redirect to a real path (not
  `/dev/null`, not an fd dup) → unsafe; a substitution whose inner is
  destructive → destructive (the whole command prompts in every mode).
- `substitutionInnerVerdict(inner, purpose, depth)` classifies one inner
  command: read-only inners are always acceptable; a reversible inner is
  acceptable only when `purpose === "reversible"`; anything else (unknown,
  mutating, deep nesting) is unsafe; a destructive inner is destructive.
- `findSubstitutions` now returns `null` on an UNBALANCED substitution
  (unterminated `$( ` or backtick) so the verdict fails closed (previously
  unbalanced substitutions were silently skipped and the command was treated
  as having no constructs).
- `isReadOnlyBash` / `isReversibleBash` delegate to
  `isReadOnlyBashDepth` / `isReversibleBashDepth`; at depth 0 they gate on
  `constructVerdict(…, purpose, 0)` and require `kind === "safe"`, then check
  every segment via the existing `isReadOnlySegment` / `isReversibleSegment`
  (a reversible compound still needs ≥1 mutating segment). Nested
  substitutions are checked by the outer substitution's verdict, not re-run
  here.

**Still prompts (unchanged, verified):** redirect to a real path
(`echo hi > out.txt`), `sudo <anything>`, and a substitution whose inner is
not provably safe (`echo $(rm -rf x)`, `git commit -m "$(rm -rf x)"`,
`$(curl …)`, backtick `$(mv a b)` for read-only). Sensitive and destructive
commands are untouched.

**Final details (orchestrator finish).** (1) Label inheritance:
`destructiveBashPatterns()` now recurses into every substitution's inner
command (raw scan extracted to `rawDestructiveHits()`; each inner is
strictly shorter, so the recursion terminates) — a destructive inner such as
`git commit -m "$(rm -rf /)"` is LABELED destructive on the outer command
(the prompt says destructive, not merely "not provably reversible"), nested
substitutions included. (2) Git subcommand position: see above.

**Verification.** `npm run build` clean; `npm test` (quality-check + tsc +
node --test) 402 tests: 395 pass / 0 fail / 7 skip (pre-existing
network/TTY skips). New assertions in test/safety.test.ts (read-only /
reversible substitution + heredoc suites, the fail-closed `$(rm -rf x)`
inner, unbalanced substitution, destructive-label inheritance incl. nested,
git subcommand-position matrix) and test/tools.test.ts (the read-only
disqualifier test now distinguishes safe vs unsafe inners; a new gate-level
test asserts the standard commit shapes do NOT prompt in ask mode while a
commit with an unsafe inner still prompts). Live 27-case classifier probe on
the built dist: ALL PASS — `git commit -m "$(date)"` and the multiline
heredoc commit form → reversible (no prompt in ask); `git stash push -m wip`
→ reversible, no destructive hit; `echo hi > out.txt` / `sudo ls` /
`echo $(rm -rf x)` / `$(curl …)` → neither read-only nor reversible (still
gate); `git commit -m "$(rm -rf /)"` → destructive label inherited.

**Still open (needs user decision, not started):** removing the `pi`
dependency — scope unresolved (all references vs the borrowed code /
`.pi/` convention). RESOLVED 2026-09-27 (see top section): the convention
half (`.pi/` paths) is done; the rest is the factual citations, frozen by
the `docs/03` freeze note.

# HANDOFF — reversible actions stop prompting; approval questions state reversibility (2026-09-25)

**Status: COMMITTED (efc7b28)** — guardrail zone, committed by the user's
explicit instruction with `GUARDRAIL_BYPASS=1` (2026-09-25).

Spec: a reversible action must not require approval — asking for it is out
of spec — and when approval IS asked, the question must indicate whether
the action is reversible. Two gaps:

1. **Reversible was git/npm-only.** `mv a b`, `mkdir -p d`, `sed -i …`,
   `chmod 755 s.sh` — all undoable in practice (mv back, rmdir, git
   restore, restore prior mode) — fell into unknown-mutating and prompted
   in ask mode.
2. **Prompts didn't say whether the action was reversible.** A plain
   mutating prompt (`Approve bash: curl …? [y/N]`) gave the human no
   reversibility signal to weigh.

Fix (safety.ts + help text in main.ts):
- New `REVERSIBLE_FS_VERBS`: `mv cp mkdir rmdir touch ln chmod chown sed tee`
  count as reversible (classified in `isReversibleSegment`). They are NOT
  read-only — the classifiers stay orthogonal; what makes them safe is the
  kernel sandbox confining them to the workspace plus the undo path.
  `sed` only in in-place form (`-i` / `--in-place`); bare `sed 's/…'` is
  read-only, not reversible.
- `approvalQuestion`: a gated call with no destructive/sensitive/outside
  tag now shows `Approve bash [not provably reversible]: <cmd>? [y/N]`.
  Destructive/sensitive tags are unchanged.
- `--ask` help text: "reversible git/npm/**filesystem** ops"; the Approval
  block lists the fs verbs.

Mode matrix (unchanged semantics, wider reversible set): ask → read-only +
reversible free, mutating/sensitive/destructive prompt; yes → sensitive +
destructive still confirm, rest auto; no → only read-only non-sensitive
bash allowed (reversible is blocked there, as before).

**Verification**: `npm run build` clean; `npm test` 394 tests: 386 pass
0 fail 8 skip (new assertions in safety.test.ts, tools.test.ts mode matrix,
cli.test.ts WS7). Live gate check: `mv a b` / `mkdir -p d` / `sed -i` run
without a prompt in ask mode; `curl -s …` prompts with the
`[not provably reversible]` tag; `rm -rf /` still prompts DESTRUCTIVE;
`--no-approve` still allows `ls` and blocks `mv a b`.

**Still open (needs user decision, not started):** removing the `pi`
dependency — scope unresolved (all references vs the borrowed code /
`.pi/` convention). RESOLVED 2026-09-27 (see top section): the convention
half (`.pi/` paths) is done; the rest is the factual citations, frozen by
the `docs/03` freeze note.

# HANDOFF — thinking block: the model's reasoning reads as a distinct, scannable block (2026-09-25)

Made the assistant's accumulated reasoning (the wire's `reasoning_content`)
read as the model's *aside*, not part of the answer. Before it rendered as a
dim, full-width text above the reply with a weak `thinking…` header — it
blended into the reply and long reasoning was hard to scan.

Now (lines.ts + the lockstep itemHeight in state.ts):
- a dim header — `thinking…` while it streams, `thinking` once done;
- the reasoning under a dim `│ ` gutter, wrapped at `width−2` so the gutter +
  text never exceed the terminal width;
- a blank line separating the block from the reply.

The gutter and blank line are part of the height (itemHeight counts them), so
the C28 lockstep contract (`itemLines.length === itemHeight`) holds. No change
to app.tsx (it renders the RLine spans generically).

**Verification**: `npm run build` clean; `npm test` 387 tests: 379 pass
0 fail 8 skip. Updated the pinned-layout height formula (header + gutter rows
+ blank + reply) and the itemLines shape assertions (gutter + blank line).
PTY capture (Qwen thinking model, "17 * 24? step by step") confirms the frame:
`thinking` header → `│ ` gutter with wrapped reasoning → blank line → reply.

# HANDOFF — classification fix: cd-prefixed + compound git/npm commands no longer prompt (2026-09-25)

**GUARDRAIL ZONE — pending USER commit.** `src/tools/safety.ts` is in the
agent's own cage, so this increment is staged in the working tree for the
user to commit with `GUARDRAIL_BYPASS=1` (same flow as the 8e66205 gate
change). Do NOT let an agent commit this file.

The 8e66205 gate works as designed — but two classification gaps made
harmless commands fall into the "unknown-mutating" (gated) bucket and
prompt:
1. **`cd` was not a read-only verb.** `cd X && git status && ls` →
   readOnly=false (the user's exact repeated prompt), so it gated.
2. **`isReversibleBash` rejected ALL compounds.** `git add -A && git commit -m "…"`
   and `npm run build 2>&1 | tail -3` (the model's standard commit flow and
   test pipeline) gated, despite every part being reversible/read-only.

Fix (safety.ts only):
- `cd`, `test`, `[`, `true`, `false`, `sleep`, `env`, `printenv` added to
  READONLY_VERBS (shell no-ops; `cd` changes only the subshell's cwd).
- `isReversibleBash` now accepts compounds where EVERY segment is
  individually reversible or read-only and at least one segment mutates
  (`ls` alone stays read-only, not "reversible" — classifiers stay
  orthogonal). Whole-command disqualifiers (backticks, `$( )`, sudo,
  redirect to a real path) are shared with `isReadOnlyBash` via
  `hasUnsafeConstructs`; fd dups (`2>&1`) and `/dev/null` remain fine.
- Still prompts (unchanged, verified): `… && git push`, `… && node script.js`,
  `… && npm install`, `git commit … > log.txt`, anything touching sensitive
  patterns (`cd ~/.ssh && ls` → sensitive).

**Verification**: `npm run build` clean; `npm test` 387 tests: 380 pass
0 fail 7 skip (14 new assertions in tools.test.ts). The user's exact
command now classifies readOnly=true.

# HANDOFF — steering: type guidance during a run (2026-09-24)

## The TUI now accepts a line WHILE A RUN IS IN FLIGHT — it is injected into the run as a user message and the model reacts on its next turn instead of waiting for a new prompt (387 tests: 380 pass 0 fail 7 skip; PTY verified)

Before: typing while `state.busy` did nothing (submitInput returned null);
the only busy-time input was /quit. Now:

- **Driver (src/tui/run.tsx)** — owns one per-app SteeringQueue. Enter while
  busy (non-empty, non-slash line) → pure `steerInput` (state.ts) echoes the
  line as a user item (same shape as pushUser — cyan, no new item kind) and
  the driver queues the text. /quit aborts as before.
- **Loop (src/loop/agent-loop.ts)** — new exported `SteeringQueue` contract
  ({ push, drain }) on AgentLoopOptions. Two drain points:
  - **A (per turn)**: after prepareNextTurn, before each LLM call — queued
    guidance is pushed as a user message into the context and a
    `{ type: "steer", turn, text }` event is yielded.
  - **B (keep-alive)**: when the model would stop with a text-only reply and
    a steer is pending → deliver it and `continue` — the run stays alive and
    the model answers the steering. This was proven LIVE in the PTY capture
    (turn counter advanced to 2 after a text-only turn 1).
- **Persistence (src/cli/main.ts)** — runTurn persists the steer's user
  message when the steer event fires, so a RESUMED session keeps the
  guidance (the message lives in the loop's context but travels only as an
  event — without this it would vanish from the session file).
- **Event (src/types.ts)** — `steer` added to AgentEvent; applyEvent treats
  it as a no-op (the item was already pushed at submit time — no double-add).
- **Help text** — new "Steering (TUI)" paragraph in `tre. --help`.

Edge cases (documented, intentional):
- Abort/error/budget/loop breaks do NOT drain — the queue is per-run; the
  driver starts each run with a fresh queue, so a steer typed right before
  /quit is discarded (the echoed line is NOT in the resumed context).
- Slash lines while busy are ignored (driver owns the /quit-abort path).
- The plain REPL (--plain) is a follow-up — steering is TUI-only for now.

**Verification**: `npm run build` clean; `npm test` 387 tests: 380 pass
0 fail 7 skip. New tests: 5 loop-level (delivery on next turn, multi-steer
order, keep-alive, no-steer normal stop, abort-discards) in
agent-loop.test.ts; steerInput unit cases in tui-state.test.ts; an
end-to-end runTurn test in cli.test.ts (mid-turn steer → turn-2 answer +
prompt+steer both in the replayed session). PTY frame (slow local model):
prompt echo, steer echo while busy, and the turn-2 reply all visible.

Note: dogfooded — tre. implemented the core across 2 resumed 27-min runs
(the session-persistence seam + e2e test + this section were finished by
the supervising agent after the second watchdog, from tre.'s own in-flight
PTY-harness work).

# HANDOFF — approval gate loosened: confirm only sensitive + destructive (2026-09-24)

## The default mode now runs read-only bash, reversible git/npm ops, and in-workspace write/edit WITHOUT a prompt; the user is only confirmed on SENSITIVE reads and DESTRUCTIVE/irreversible actions (376 tests: 369 pass 0 fail 7 skip)

Before: `ask` (default) prompted for EVERY bash/write/edit call, even
`ls`/`git status`/`git commit`. This change reclassifies every call into
five classes and gates each per mode (all in `src/tools/safety.ts`):

| classification  | ask (default)      | yes                | no                 |
|-----------------|--------------------|--------------------|--------------------|
| read-only bash  | no prompt          | no prompt          | ALLOW (only class) |
| reversible bash | no prompt          | no prompt          | block              |
| mutating bash   | prompt             | no prompt          | block              |
| write/edit      | no prompt          | no prompt          | block              |
| read (plain)    | no prompt          | no prompt          | block (fail-closed)|
| sensitive       | prompt [SENSITIVE] | prompt [SENSITIVE] | block              |
| destructive     | prompt [DESTRUCTIVE]| prompt [DESTRUCTIVE] | block           |

- **Classifiers (pure, exported, unit-tested)**: `destructiveBashPatterns`,
  `sensitiveBashPatterns`/`sensitivePathPatterns`, `isReadOnlyBash`,
  `isReversibleBash` (new). Bash check order: destructive → sensitive →
  read-only → reversible → mutating. Fail-closed everywhere: unrecognized
  commands, `$( )`, backticks, `sudo`, and output redirects to real paths
  disqualify read-only; `--no-approve` allows only read-only non-sensitive
  bash (reads are blocked too — they are unrestricted by design, so no
  human oversight = fail-closed).
- **Destructive list grew** (publishing/discarding is irreversible): ANY
  `git push` (not just force), `git reset --hard`, forced `git clean`
  (-f/-fd/-x; `-n` dry-run is NOT destructive), `git branch -D`,
  `git checkout . / -- <path> / git restore` (without --source). Existing
  patterns (recursive rm, dd to /dev/*, raw-device redirects, mkfs, fork
  bomb, shutdown/reboot) unchanged.
- **Sensitive class is new**: bash touching ~/.ssh/, ~/.aws/, ~/.gnupg/,
  ~/.kube/, ~/.config/gcloud/, ~/.docker/config.json, ~/.netrc, /etc/shadow,
  id_rsa*/id_ed25519*, *.pem/*.key/*.p12/*.pfx, .env-family files — and the
  `read` tool on resolved paths matching the same patterns. Confirms in
  EVERY mode (fail-closed denial when there is no human). All other reads
  stay unrestricted (no root restriction, no prompt).
- **write/edit**: still path-sandboxed to the project root in every mode
  (unchanged), but no prompt in ask/yes — reversible via git; still blocked
  under `--no-approve`.
- **Docs**: main.ts help (`--ask/--yes/--no-approve` + Safety/Approval
  paragraphs) and this HANDOFF updated.
- **Tests**: test/tools.test.ts gained pure-classifier suites (read-only
  verbs + git/kubectl/docker subcommands, compound/redirect/$( )/sudo
  disqualification, reversible list, sensitive patterns, new destructive
  patterns, full mode matrix incl. read, fail-closed without a human);
  test/safety.test.ts + test/cli.test.ts WS7 cases updated to the new spec.

**Verification**: `npm run build` clean; `npm test` 376 tests: 369 pass
0 fail 7 skip (live). Note: this increment was dogfooded — tre. itself ran
the self-improve loop (4 runs, session-resumed between 27-min windows);
its own run 3 was denied fail-closed when a command it built contained the
literal string `git clean -x` — live proof of the new destructive gate.

# HANDOFF — TUI user item is now cyan (2026-09-24)

## The echoed user prompt renders CYAN in the TUI, so it is distinguishable from the assistant's plain reply (366 tests: 358 pass 0 fail 8 skip; PTY verified)

Before: the user's echoed prompt and the assistant's reply both rendered in
the default foreground (plain), so in a long transcript the two were
indistinguishable. D15 had deliberately removed the cyan `you ` prefix (the
input row and the echoed user item are plain, full-width, no prefix) — that
decision is kept. This change restores distinguishability WITHOUT a prefix:
the echoed user item is colored.

- **lines.ts** — the `user` case of `itemLines` now emits each wrapped line
  as a single CYAN span (`{ text, color: "cyan" }`) instead of a plain span.
  Color only: no text/width/line-count change, so the lockstep contract
  (`itemLines(item, width).length === itemHeight(item, width)`) holds and the
  100×24 frame geometry is untouched. Empty user text still renders one blank
  (colored) row for height uniformity. The `Item` renderer in app.tsx already
  honors per-span `color`/`dim` generically, so no app.tsx change was needed.
- **test/tui-pinned-layout.test.ts** — the two `itemLines` user-span shape
  asserts now expect `color: "cyan"` (empty-text blank row and the "hi" row).
  The App frame test (`"the prompt"` present, no `you`) is text-only and
  unaffected — it strips ANSI before asserting, so color does not interfere.
- **Not touched**: `itemHeight` (line counts are unchanged), the input row
  (still plain, per D15), the assistant item (still plain default-fg), and the
  pinned bottom block.

**Verification**: `npm run build` clean; `npm test` 366 tests: 358 pass 0 fail
8 skip (live). PTY capture (local build, real prompt `hello`): raw frame shows
`ESC[36mhello ESC[39m` in the transcript; stripped frame is exactly 24 lines
tall with the input row 4 lines above the bottom and the pinned block
(hint / menu / `─` / input / `─` / 3×blank) intact.

## The TUI renders the model's actual thinking, not just a static `thinking…` hint (359 tests: 351 pass 0 fail 8 skip)

Before: the wire emits `thinking_delta` events carrying the model's
reasoning (`reasoning_content` from the OpenAI-completions wire), but the
TUI state machine only flipped a `thinking: true` flag and threw the text
away — so a reasoning model (e.g. the default Qwen3.8-27B with
`reasoning_effort: medium`) produced a static `thinking…` line and the
actual reasoning was never visible.

- **state.ts** — the assistant `TuiItem` now carries `thinkingText:
  string` (accumulated `thinking_delta` text). `thinking_delta` appends
  `ev.delta` to it (and opens a streaming assistant item if none exists);
  `start`/`text_delta` initialize it empty. On `done` the live `thinking`
  flag clears but `thinkingText` STAYS — the reasoning is part of the
  record. `itemHeight` counts exactly what the renderer draws:
  `1 + wrapLineCount(thinkingText, width)` when non-empty (header +
  wrapped text), keeping the height/lockstep contract with lines.ts.
- **lines.ts** — the assistant renderer emits, above the reply: a dimmed
  header line (`thinking…` while live, `thinking:` after done) plus the
  dimmed, width-wrapped `thinkingText`. No lines at all when the model
  did not think (`thinkingText === ""`), so non-reasoning models render
  exactly as before.
- **Resume path checked**: `replaySession` rebuilds only the LLM
  `context` (AgentMessage[]), never TuiItems — the TUI always starts from
  `makeInitialState` (empty items) and rebuilds items live via
  `applyEvent`, so there is no second place to initialize `thinkingText`.
- **Tests** — tui-state.test.ts: accumulation across deltas, persistence
  after `done` (reply streams in via `text_delta` first, then `done`
  closes the item with the reasoning intact), and a first
  `thinking_delta` opening a streaming assistant item with text.
  tui-pinned-layout.test.ts: `thinkingText: "hmm"` adds header + wrapped
  text to the item-height sample; a bare `thinking` flag with no text
  adds 0; two new lockstep samples (live + settled reasoning); itemLines
  shape assertions for the dimmed header + wrapped text above the reply
  (live `thinking…`/cursor and settled `thinking:`). All assistant-item
  literals updated for the new required field.

**Verification**: `npm run build` clean; `npm test` 359 tests: 351 pass
0 fail 8 skip (the 8 skips are the pre-existing network/TTY skips). PTY
capture (real prompt against the default Qwen thinking model): mid-stream
frame shows `thinking…` + accumulating reasoning + `▍` cursor; settled
frame shows `thinking:` + full wrapped reasoning + the `ok` reply.

---

# HANDOFF — read unrestricted + approval default `ask` (2026-09-23)

## `read` is now unrestricted (any file/directory, no prompt); `write`/`edit`/`bash` prompt by default (358 tests: 350 pass 0 fail 8 skip)

The user's rule: **reading is always allowed; writing and running
commands require explicit approval.** This reverses the D13 default and
removes `read` from both permission boundaries.

- **`read` — unrestricted** (safety.ts): removed from `PATH_TOOLS`
  (no root sandbox, no path rewrite) and from `GATED_TOOLS` (no
  approval prompt in any mode). The hook now passes `read` calls
  through untouched — `undefined`, never a block. The tool itself
  (read.ts) gained directory support: an `EISDIR` read lists the
  entries (`d` = directory, `-` = file, size in bytes) instead of
  erroring, so "read any file **or directory**" holds. Binary guard
  and paging are unchanged.
- **Approval default is `ask`** (safety.ts): `ApprovalMode` is
  `"ask" | "yes" | "no"` — the D13 `"local"` mode (workspace-scoped
  auto-approve + `bashOutsidePaths` scanner) is gone, along with the
  scanner's export. `makeSafetyHooks` defaults to `"ask"`: every
  gated call (bash/write/edit) prompts; anything but `y` denies
  (fail-closed). `"yes"` auto-approves non-destructive gated calls;
  destructive bash still confirms in EVERY mode (D8, unchanged).
  `"no"` blocks gated calls outright.
- **`write`/`edit`** stay sandboxed to the project root (lexical +
  realpath checks) AND gated — the sandbox is the boundary, the
  prompt is the permission. **`bash`** stays gated and, on macOS,
  runs under the D12 Seatbelt profile (sandbox.ts untouched).
- **CLI** (main.ts): `--local` flag removed (unknown option now).
  `--ask` is the default (explicit flag still accepted), `--yes`
  auto-approves, `--no-approve` blocks; the three remain mutually
  exclusive. Mode selection: `noApprove → "no" : yes → "yes" : "ask"`.
  Help text updated to match.
- **Tests**: safety.test.ts — the D13 section (bashOutsidePaths unit
  tests + 7 `local`-mode tests) is replaced with: read passes through
  untouched in all three modes (absolute outside + `../` escape),
  read never prompts, pipeline integration (outside-root read
  executes), directory listing, missing-path error result, default
  mode is `ask` (bash + write prompt), write/edit sandboxed in every
  mode. cli.test.ts — the two D13 parse tests now assert the
  ask/yes/no-approve flags and that `--local` is rejected.
  e2e.sh — scenario_10's prompt now forces **bash** (`cat ...`):
  with `read` unrestricted, "Read the file X" would legitimately
  succeed and false-fail the canary check; scenarios 04/05 comments
  updated (their prompts now work because the default is `ask`, not
  because the path is outside the workspace).

**Guardrail zone**: `src/tools/safety.ts` (and `src/cli/main.ts`
wiring) are in the DO-NOT-MODIFY zone — the pre-commit hook rejects
this commit. **The user commits it with `GUARDRAIL_BYPASS=1`.**
`git status --short` after this increment: `src/cli/main.ts`,
`src/tools/read.ts`, `src/tools/safety.ts`, `test/cli.test.ts`,
`test/e2e.sh`, `test/safety.test.ts`.

**Verification**: `npm run build` clean; `npm test` (quality-check +
tsc + node --test) 358 tests: 350 pass 0 fail 8 skip (the 8 skips
are the pre-existing network/TTY skips). No `src/tui/*` changes → no
PTY capture needed.

---

# HANDOFF — C28: scrollback rework — content-anchored viewport, clip straddlers (2026-09-22)

## C28 — the scroll viewport pins an ABSOLUTE content row and CLIPS straddling items; a single tall reply now actually scrolls (365 tests: 358 pass 0 fail 7 skip)

C27 (the first scrollback pass, built by a tre dogfood run) had a
reviewer-found defect: the viewport SKIPPED items straddling the window
edge (gap lines). A reply that is ONE item taller than the 16-row item
budget — the most common long-output shape — therefore could not be
scrolled at all: every scroll position rendered the identical overflow
frame, and the "scrolled" hint lied. C28 reworks the viewport math and,
with it, the height/render split that made the bug possible.

- **State** (state.ts): `TuiState.scrollUp: number` (rows above the
  bottom) → `viewTop: number | null` (the CONTENT row at the viewport's
  top edge; null = follow). Content-anchored, so a pinned view STAYS
  PUT as output appends — the C27 offset slid under new content.
  `scrollBy(s, delta, maxScroll)` takes the current scrollable range
  (from the last fit): scroll UP decreases viewTop, DOWN increases it,
  reaching maxScroll resumes following (null). `scrollToTop` is now
  exact (viewTop 0) — no MAX_SAFE_INTEGER sentinel. submitInput /
  agent_start reset to follow, as before.
- **New module src/tui/lines.ts**: `itemLines(item, width): RLine[]` —
  the rendered lines of an item as data (spans with color/dim). It is
  the SINGLE SOURCE OF TRUTH for both the height COUNTS (the fit math)
  and the RENDERING (the App). Contract, pinned in
  tui-pinned-layout.test.ts: `itemLines(item, w).length ===
  itemHeight(item, w)` for every kind/width. This is what lets the
  viewport slice a straddler to its visible lines instead of dropping it.
- **Viewport** (state.ts `fitItemsScrollable`): follow (viewTop null or
  content ≤ budget) = the legacy `fitItems` tail window, byte-identical
  (expressed as full-item slices). Pinned = window [W, W+budget) over
  the per-item line lists; every straddler is CLIPPED to [from, to),
  so the window always renders exactly `budget` rows (no gap lines).
  One wrap pass per frame (the old code wrapped once for the counts and
  the renderer wrapped AGAIN). `FitWithScroll.visible` is now
  `VisibleSlice[]` ({item, from, to}); `topPad` is gone.
- **Renderer** (app.tsx): `Item` draws exactly `itemLines(item, w)
  .slice(from, to)` — spans become nested Ink `<Text>` runs. No other
  rendering logic moved; key routing, approval lock, hints unchanged
  (the hint's `↑eff/maxScroll` now reads "rows between the window bottom
  and the content bottom").
- **Cursor counted** (state.ts `itemHeight`): the streaming cursor (▍)
  was always rendered but never counted — a cursor-only frame
  (`text:""` at stream start) overflowed the frame by one row. The
  cursor is now part of the counted text.
- **Terminal hygiene** (run.tsx): mouse mode 1006 restore now also runs
  on `process.exit` (covers uncaught errors + hard exits) and
  SIGTERM/SIGHUP are routed through `process.exit` so the finally-based
  restore runs (previously: bare-kill default → mode left ON for the
  shell). SIGKILL is uncatchable — the pty_feed watchdog's kill -9
  tears the PTY down with it.
- **Files:** `src/tui/lines.ts` (new), `src/tui/state.ts` (viewTop,
  scrollBy/ToTop/ToBottom, itemLines-based fit, cursor counting),
  `src/tui/app.tsx` (slice rendering, maxScroll plumbing), `src/tui/
  run.tsx` (exit handlers), tests: C28 sections in
  `test/tui-state.test.ts` + `test/tui-pinned-layout.test.ts` (the
  lockstep contract, clipping, drift, the single-tall-item case),
  `test/tui-app.test.tsx` (key routing with maxScroll; pinned frame
  render), `test/e2e.sh` scenario 15 strengthened to assert the pinned
  frame shows MIDDLE lines of a 40-line reply (line 40 gone) — the old
  assertion passed even with the defect, because the hint showed
  regardless.
- **Verified in a real PTY** (local 27B, 40-line reply in a 24-row PTY):
  PgUp + wheel pins the view; the pinned frame shows reply lines 14–29
  with line 40 absent (under C27 it was still present — the defect);
  End returns to the bottom (line 40 visible, follow hint restored);
  mouse mode 1006 enabled on entry, restored on exit.

# HANDOFF — the /stats slash command (session turns, tokens, tool calls, session size) (2026-09-22)

## /stats — one info line reporting session turn count, total tokens, tool-call count, and session file size in bytes (365 tests: 357 pass 0 fail 8 skip)

The TUI had no way to see how a session was shaping up mid-run — turns,
token burn, and how many tool calls had fired were only visible in the
bottom-line `tokens` field (and only if the user had pinned it). `/stats`
adds an on-demand report: type `/stats` (it now appears in the "/"
completion menu, alphabetically last), and ONE info line lands in the
output area:
`stats: N turn(s), T tokens, C tool call(s), session: <path> (<bytes> bytes)`.

- **State** (state.ts, pure): `TuiState.toolCalls` (new field, 0 in
  `makeInitialState`) is incremented on every `tool_execution_start` —
  including the QUIET file-access tools that render no line, so the count
  is the true number of executions started, not the number of visible
  tool rows. `turn` (turn_start) and `totalTokens` (done) were already
  tracked. `statsLine(state, sessionBytes?)` builds the line; `?` for the
  bytes when the caller could not measure them, `—` for the whole session
  part when no session path is configured. `handleSlashCommand` gained an
  optional third arg `sessionBytes` and a `/stats` branch (exact match,
  whitespace-trimmed; `/stats …` with args is NOT handled → falls through
  to the unknown-command error).
- **Driver** (run.tsx): the I/O lives here, not in state.ts.
  `sessionSizeBytes(opts.sessionPath)` does a `statSync` (try/catch →
  undefined when the path is unset or the file is missing/unreadable) and
  is passed into `handleSlashCommand` at the dispatch site. The session
  file is only ever READ for its size — never parsed or written.
- **Menu:** `/stats` is a fourth `SLASH_COMMANDS` entry, so the "/" menu
  now has 4 lines (still under `MENU_MAX_LINES` 5). Pinned-layout render
  test updated for the 4th line (hint moves to row 13) and the
  candidate/nav/complete tests for the new alphabetical position.
- **Files:** `src/tui/state.ts` (toolCalls, statsLine, handleSlashCommand
  /stats branch + sessionBytes arg), `src/tui/run.tsx` (statSync size
  helper + dispatch), tests: 3 new in `test/tui-state.test.ts`
  (toolCalls tally incl. quiet tools, statsLine formatting, handleSlash
  /stats isolation), 1 new in `test/tui-pinned-layout.test.ts` (handleSlash
  /stats), plus 4 existing menu tests re-pinned for the 4th candidate.
- **Verified in a real PTY** (local `node dist/src/cli/main.js tui`): the
  "/" menu renders all 4 candidates with `/stats` last; submitting
  `/stats` appends exactly one info line with the live session byte size
  (293 bytes for a fresh session), the pinned block (hint/─/input/─/3
  reserved) stays intact, and `/quit` still exits 0.

Note: the session SIZE is a single `statSync` at submit time (not live) —
it reflects the file at the moment `/stats` is sent, which is the honest
"how big is my session file right now" reading. The skip count in the
header is environment-dependent (live-endpoint + the OS sandbox probe),
not a regression: 0 fail.

# HANDOFF — C27: output display scrolling (scrollback) in the TUI (2026-09-22)

## C27 — the TUI output area is scrollable: wheel, PgUp/PgDn, Home/End (361 tests: 354 pass 0 fail 7 skip)

Long runs pushed older output off the top of the frame with no way back —
the item area only ever showed the TAIL that fit. Now the item area is a
viewport over the FULL content:

- **Keys** (app.tsx useInput, before the ctrl catch-all):
  - mouse wheel up/down (SGR mode 1006 + X11 4-byte encodings) → ±3 lines
  - PageUp/PageDown → ∓one item-area page (Shift halves the page)
  - Home / Ctrl+Home → top; End / xterm Ctrl+End → bottom
  - other SGR mouse events (clicks/drags/releases) are swallowed — never
    typed into the input. Pinned quirk: the alternate Ctrl+End encoding
    `[1;4~` is misparsed by Ink as shift+home → it goes to top (standard
    xterm `[1;5F` works correctly; not worth a raw pre-route).
- **State** (state.ts, pure): `scrollUp` rows above the bottom (0 = follow).
  `scrollBy` (clamped at 0), `scrollToBottom`, `scrollToTop` (sentinel;
  the render clamp lands it at the top). `submitInput` and `agent_start`
  reset to 0 — a fresh run's output is at the bottom. New output while
  scrolled does NOT move the view (frozen; it lands below the window).
- **Fit math** (`fitItemsScrollable`): scrollUp 0 is byte-identical to the
  legacy `fitItems` (every pre-C27 frame unchanged). Scrolled up, the
  viewport cuts `scrollUp` rows off the bottom of the content; items
  straddling the window edges are skipped and their rows become blank gap
  lines (topPad above, pad below) — the frame stays exactly `rows` tall.
  A window that fits no item degrades to the legacy tail view, never blank.
- **Mouse mode** (run.tsx, the DRIVER): `\x1b[?1006h` once before render,
  `\x1b[?1006l` on exit (and before the SIGINT process.exit path). Never in
  a component — a raw write inside render corrupts the frame stream
  (learned the hard way: 6 pinned-layout render tests broke). Opt out:
  `TRE_NO_MOUSE=1` (keeps terminal text selection).
- **Hint line doubles as scroll status**: at the bottom it now reads
  `enter send · PgUp/PgDn/wheel scroll · ↑/↓ history · /quit exit`; while
  frozen: `↑N/M scrolled — PgDn/wheel ↓ to bottom · Home top · /quit exit`.
- **Scroll is locked while an approval is pending** (approval keys win —
  they were always first in the key handler; pinned by test).
- **Files:** `src/tui/state.ts` (scrollUp, fitItemsScrollable, itemAreaBudget,
  scrollBy/scrollToBottom/scrollToTop), `src/tui/app.tsx` (key routing, gap
  render, hint), `src/tui/run.tsx` (handlers + mouse mode), tests: 9 new
  geometry tests, 6 state tests, 5 App key/frame tests, e2e scenario 15
  (tui-scrollback: real pty, PgUp + SGR wheel + End, mouse-mode enable +
  restore assertions). Verified in a real PTY: 30-line reply, `↑15/15
  scrolled` at the top, rc=0.

Known trade-off: SGR mouse mode means terminal text SELECTION inside the
TUI area is captured by the app (opt out: TRE_NO_MOUSE=1). Wheel scroll is
the point of enabling it.

# HANDOFF — C26: the turn problem is solved structurally (auto-continue + loop detection) (2026-09-22)

## C26 — the turn cap is now per-cycle with auto-continue, and the real runaway guard is loop detection (341 tests: 334 pass 0 fail 7 skip)

The user hit `budget: max 64 turns reached — send another prompt to continue`
mid-job in the TUI. The old design treated the turn count as a per-run hard
stop: a long legitimate job that crossed the cap died and forced a manual
"continue" prompt, while a genuinely STUCK model (re-issuing the same call)
would burn the ENTIRE cycle budget before anything noticed. Raising the cap
only delays the first problem and makes the second worse.

What changed (one increment):
- **Per-cycle budget + auto-continue.** `maxTurns` (derived from the model,
or explicit) now caps one CYCLE. At exhaustion the loop injects a
  continuation nudge (`BUDGET_CONTINUE_TEXT`: "summarize if done, else keep
  working") as a user message, emits a `turn_budget` event, and resets the
  counter — up to `maxContinuations` times (default 3 → 4 cycles). Only when
  every continuation is spent does the run stop with `stopReason: "budget"`
  (now carrying `maxTurns` + `maxCycles`). `maxContinuations: 0` (or CLI
  `--max-continuations 0`) restores the old hard-stop.
- **Loop detection (the real runaway guard).** The same tool-call batch —
  tool names + stable-JSON (key-order-insensitive) arguments, in call order
  — issued 3 times in a row is a runaway signature: the third repeat is
  failed in-band with `LOOP_GUARD_TEXT` (NEVER executed; I3 keeps every call
  answered) and the run stops with the new `stopReason: "loop"` (resumable,
  exit 3). Two identical batches stay allowed (legit retries exist). The
  signature counts length-guarded (truncated) batches too, so a model stuck
  re-issuing the same truncated call stops at the 3rd repeat, not after the
  whole budget.
- **Files:** `src/loop/agent-loop.ts` (cycle bookkeeping, `batchSignature`,
  `stableJson`, the guard, `DEFAULT_MAX_CONTINUATIONS`, the `BUDGET`/
  `LOOP_GUARD` texts), `src/types.ts` (`loop` stopReason, `turn_budget`
  event, `maxCycles` on agent_end), `src/cli/main.ts` (`--max-continuations`
  flag, exit-3 for `loop`, notes on stderr), `src/tui/state.ts` (`loop`
  error item, `turn_budget` info item, "N turns × M cycles" wording —
  cycles named only when > 1), `src/tui/run.tsx` + `main.ts` plumbing,
  `docs/02-contracts.md`, tests: 8 new agent-loop tests, 3 new CLI tests,
  3 new TUI-state assertions; 4 old cap tests re-pinned (distinct args / 
  `maxContinuations: 0` so they isolate the cap from the new behaviors).
- **Exit codes:** `loop` exits 3 like `budget` (both resumable). CLI prints
  `⏳ turn budget (N) reached — continuing (cycle i/M)` on `turn_budget`.

Known trade-off: a model that legitimately issues the SAME call 3× in a row
(e.g. polling a flaky endpoint with identical args) will be stopped — it
must change its approach (a different arg) to continue. That is the intended
semantics: identical repeats with unchanged inputs are almost always a
stuck model.

## The `length` banner no longer blames truncated tool calls when thinking ate the budget (329 tests: 322 pass 0 fail 7 skip)

The user hit `length: output limit hit — tool-call arguments may be truncated`
in the TUI. Two root causes, two fixes (this section) — plus the maxTokens
bump (previous section, config only).

The message was WRONG in one of its two failure modes. A run ends with
`stopReason: length` either (a) the last assistant message carries a tool call
whose arguments were cut mid-JSON, or (b) the model spent the entire output
budget on thinking/text and never emitted a call — observed in
`/tmp/tre-child2/wordwrap.jsonl`: a response of 60,096 chars of thinking hit
`output: 16384` with zero tool calls. Both the TUI (`src/tui/state.ts`
agent_end) and the CLI (`src/cli/main.ts` printEvent) claimed (a) unconditionally.

What changed (one increment, 4 files):
- **`src/types.ts`** — `lengthEndNote(messages)`: walks back to the last
  assistant message; a `toolCall` block → the truncated-arguments wording;
  none → `…response cut off before any tool call (thinking/text consumed the
  output budget)`. Shared by both UIs so they can't drift.
- **`src/tui/state.ts`** + **`src/cli/main.ts`** — the agent_end length
  branch now emits `lengthEndNote(ev.messages)`.
- **`test/tui-state.test.ts`** — pins both wordings (no-call → "before any
  tool call"; with-call → "tool-call arguments may be truncated").

The loop's guard behavior is unchanged: with-call length → calls discarded as
isError results, model re-issues (C22); no-call length → one nudge retry, then
stop. The nudge already worked in the observed session (the run continued to
turn 49). With maxTokens now 32768 the no-call case needs >32k tokens of
thinking in ONE response to recur.

## models.json: maxTokens 16384 → 32768 so the output cap covers thinking

Qwen3.8-27B (UD Q4_K_S, radeon) runs `reasoning_effort: medium`. Its thinking
alone regularly consumes 12–15k tokens (child2 session: two responses ended at
`stopReason: length` with `output: 16384` — exactly the cap — one of them
60k chars of thinking with no tool call at all). A 16384 output budget leaves
no room for text + tool-call arguments after thinking, so length stops were
routine. Bumped `maxTokens` to 32768 in `models.json` (the radeon default
model). The server's actual context (radeon slot `n_ctx`) is 81920 = the
declared `contextWindow`, and the auto-compaction trigger
(`totalTokens + maxTokens + 1024 > window`) still keeps prompt + max output
inside the window — it now fires at ~48k total instead of ~64k, which only
makes compaction EARLIER, never later. No code change; verified via
`loadModelsFile` + full gate.

## C25 — the 2GB OOM crash is fixed: React's User-Timing entries are swept (329 tests: 322 pass 0 fail)

Root cause of the recurring `JavaScript heap out of memory` crash (reproduced
live three times): the DEV build of react-reconciler — what ink runs under —
calls `performance.measure()` for EVERY component mount/update/render, and
Node keeps User-Timing marks/measures in an UNBOUNDED buffer. A TUI
re-renders constantly (every streamed token), so entries accumulated ~450/s;
each entry holds strings (component names, `tooltipText`) plus a detail
object — the heap grew ~40MB per turn and died at the ~2GB limit. Proven two
ways: (a) the crashed child's 3.3GB heap snapshot shows 53M nodes whose
strings are held under `track` / `color` / `tooltipText` / `trackGroup`
properties — fields that exist ONLY in react-reconciler's development.js
(reusable-component dev-tool details); (b) a live 10-minute session held
~600k `performance.getEntries()` entries, all React's `Mount`/`Update`
measures.

What changed (one increment, 3 files):
- **`src/tui/perf-sweep.ts`** (new) — `sweepPerfEntries()` (clearMeasures +
  clearMarks) and `startPerfEntrySweep(intervalMs=5000)` (unref'd interval,
  returns a stop fn). Safe: nothing in tre or ink ever reads these entries
  back — they exist for browser DevTools, which a TUI has no; production
  React builds create no entries, so the sweep is a no-op there.
- **`src/tui/run.tsx`** — starts the sweep after `render(...)`, stops it in
  the exit `finally`.
- **`test/perf-sweep.test.ts`** (new) — sweep clears planted marks/measures,
  no-op on empty buffer, live interval clears late entries, stop halts it,
  stop is idempotent.

Verification: full gate green (329 tests, 0 fail). LIVE before/after under an
identical TUI session: before — 742,662 entries / 604MB heap at 28 min,
growing ~450 entries/s; after — **1 entry / 18MB heap at 6+ min, flat**.
`/quit` exits cleanly (no lifecycle regression). This makes long
self-improvement runs (and any long interactive session) viable regardless
of model or work length; the compaction fix bounds the CONTEXT, this bounds
the RENDERING side effect.

## The runaway-loop turn cap is session-independent — derived from the model when `--max-turns` is omitted (325 tests: 317 pass 0 fail 8 skip)

Before: the agent loop's runaway guard used a HARDCODED cap (32 turns) unless
the caller passed an explicit one — so a large model window still stopped at 32
and a tiny one still allowed 32; the cap had nothing to do with the model.
Now (mirrors the auto-compaction fix, commit 2fbbddb) the cap is DERIVED from
the model's `contextWindow` / `maxTokens` — the same two fields `compact.ts`
uses — when the user omits `--max-turns`. An explicit `--max-turns N` still
overrides. The guard stays ALWAYS ON; only its size now tracks the model.

What changed (one increment, 5 files):
- **`src/loop/agent-loop.ts`** — new `deriveMaxTurns(contextWindow, maxTokens)`:
  `max(64, min(4096, floor(contextWindow / maxTokens × 10)))` — ~10 turns per
  full context re-fill, floored at 64 (ample for long work) and ceilinged at
  4096. `runLoop`'s `maxTurns` is now optional: `undefined` → derive from the
  model. `stopReason: "budget"` + `agent_end.maxTurns` unchanged.
- **`src/cli/main.ts`** — `--max-turns` is now optional (default `undefined`);
  `runLoop` receives `args.maxTurns` (undefined → derive). Help/usage updated.
- **`src/tui/run.tsx`** — `TuiRunOptions.maxTurns` optional (undefined → derive).
- **`test/agent-loop.test.ts`** — `deriveMaxTurns` unit tests (formula, floor/
  ceiling clamps, degenerate configs) + a runLoop test: no `maxTurns` → derived
  cap (78 for the 32k/4096 test model), `stopReason budget`, `agent_end.maxTurns
  78`; explicit `maxTurns 500` overrides (91 turns complete normally).
- **`test/cli.test.ts`** — parseArgs: `maxTurns` defaults `undefined`,
  `--max-turns` preserved; e2e: no `--max-turns` with a small-window model
  (derived cap 64) → run stops at 64 with `budget`, exit 3.

Caveat: the derived cap is a HEURISTIC (turns-per-context-refill), not a hard
token budget — a model that emits near-zero tokens per turn still gets the full
derived cap before the guard trips. Compaction bounds the CONTEXT; this bounds
the turn COUNT. Both stay on.

## Auto-compaction is ALWAYS ON now — `--no-compact` opts out (318 tests: 311 pass 0 fail 7 skip)

Defect: compaction was gated in `runTurn` on `session && !opts.noCompact` —
so a SESSIONLESS run (plain `tre. tui`, the default casual mode) had NO
compaction at all. Context grew unbounded: the 2026-09-20 sessionless TUI run
OOM'd at the 2GB Node ceiling after ~33 min (28-min "working…", heap at 2.03GB,
"Ineffective mark-compacts near heap limit"), and HANDOFF's earlier 62.8k-token
run 400'd at the model window. Compaction is CONTEXT management (staying under
the model's window); the session file only records the `compaction` entry for
resume. `compact.ts` was already session-agnostic — the gate was the only fence.

What changed (one increment, 2 files, commit 2fbbddb):
- **`src/cli/main.ts`** — `runTurn` gate is now `if (!opts.noCompact)`;
  the `appendCompaction` + message→entry-id bookkeeping moved INSIDE
  `if (session) { … }` (a sessionless compacted run still gets the context
  replacement `[summary, …kept]` + the `context_compacted` event, it just
  has no file to record the boundary in). Doc comments + `--no-compact`
  usage line updated.
- **`test/cli.test.ts`** — new WS9 test: a SESSIONLESS `run` with a
  small-window fake model (3 tool turns, turn 3 usage trips the trigger)
  → asserts the silent summary call happened, the report line was printed,
  and turn 4's context starts with the `Compaction summary` user message.

Caveat (still open, next increment): compaction bounds the CONTEXT, but a
separate ~15-25MB/turn heap growth was measured in a long sessionless TUI
run (live heap ≈ 2× the context size) — investigation with an instrumented
repro was in flight (heap snapshots + render-path harness), see session
notes. The OOM class is now much harder to hit (compaction keeps the context
small), but the growth should still be pinned down.

## The input line WRAPS at the terminal width instead of truncating (317 tests: 309 pass 0 fail; PTY frame verified)

Before (9c124b7): `inputCursor(input, cursorPos, width)` rendered ONE display
line — a long input was windowed (head ellipsis + tail around the cursor), so
the text beyond the window was invisible while editing. Now the input WRAPS:
every line is ≤ `width` display columns, the whole input is visible, and the
frame stays exactly `rows` tall (the extra wrapped lines steal item budget,
exactly like the approval line and the D16 menu).

What changed (one increment, 3 files):
- **`src/tui/state.ts`** — `inputCursor` + `sliceByWidth` replaced by
  `inputWrap(input, cursorPos, width): string[]` — the input with the type
  cursor (▍) at `cursorPos`, wrapped to at most `width` display columns per
  line (owned `charWidth`/`dispWidth`, wide CJK/Hangul = 2, combining = 0 —
  no new dependency). Word-aware: an overflowing line breaks at the LAST
  space inside it (the space is consumed, never repeated); with no space it
  hard-breaks at the column limit; a space that would start a new line is
  dropped (no leading spaces). The cursor always renders at its position,
  across the wrapped lines. New `inputWrapLineCount` (feeds the fit budget).
  `PINNED_LINES` stays 6 = the MINIMUM block (1 input line); the caller adds
  the extras.
- **`src/tui/app.tsx`** — the input row is now `inputLines.map(...)` (one
  `<Text>` per wrapped line; `""` → `" "` so a line never vanishes); the
  fitItems budget gains `(inputLines.length - 1)`. Frame comment updated.
- **`test/tui-pinned-layout.test.ts`** — the `inputCursor` test rewritten as
  `inputWrap`: empty/short/middle/start cursor, 300×'x' hard-break
  (80+80+80+60+cursor), word-aware break at the last space, cursor riding
  across lines, leading-space drop, CJK double-width, and
  `inputWrapLineCount` (feeds the budget).

Verification: `npm run build` clean; `npm test` 317 tests (309 pass / 0 fail
/ 8 skip). PTY capture (80-col `script` pty, long 109-char input typed with
NO trailing `\r` so it stays in the input line): the input renders as TWO
rows — 76 cols + 33 cols (cursor at the end of the second), the break at the
last space (space consumed), and the frame is EXACTLY 24 lines tall
(header + 16 pad + hint + ─ + 2 input + ─ + 3 reserved). No guardrail-zone
files touched; no new deps.

Next candidates (input-line family): auto-scroll the wrap window when the
cursor is on a non-visible line of a very long input (the whole input is
visible now, but a 5000-char paste fills the item area with pad=0 — the
frame may exceed rows, Ink scrolls); tab/space multi-space collapse at wrap
points; a `/wrap off` toggle back to the old one-line truncation.

Follow-up hardening (found by a tre child's own fuzzer, `dist/fuzz-inputwrap.mjs`):
three real edge bugs — (1) a space run at a wrap point trailed the previous
line ("aaa  bbb" w=8 → line 0 "aaa "); (2) a trailing space after a wide/CJK
char at the break; (3) extra spaces of the run leaked to the START of the
next line. Fix in `inputWrap` (src/tui/state.ts): trim trailing spaces at
each wrap point (the LAST line is never trimmed), and a space never starts a
WRAPPED line (line 0 may keep the input's leading space). Regression tests
in test/tui-pinned-layout.test.ts cover all three classes; full suite green.

---

# HANDOFF — bash group-kill + sed-regex misparse (2026-09-21) — UNCOMMITTED (guardrail zone)

## Two fixes, both from 2026-09-20 incidents, both in the guardrail zone — committed by the human with `GUARDRAIL_BYPASS=1`

Working tree at handoff: dirty, changes in `src/tools/bash.ts`, `src/tools/safety.ts`,
`src/tools/sandbox.ts`, `test/safety.test.ts`, new `test/bash-kill.test.ts`. Build + full
suite green: `npm test` → 317 tests, 310 pass / 0 fail / 7 skip (skips are the pre-existing
conditional ones). **Commit pending human review** — the files are in the guardrail zone
(`bash.ts`, `safety.ts`, `sandbox.ts`); per self-improve protocol the human commits:
`GUARDRAIL_BYPASS=1 git commit` after reviewing `git diff`.

### 1 — bash timeout/abort orphaned pipeline children → tool promise never settled → agent loop hang

Incident (proven 2026-09-21): a bash call with no `timeout` ran `sleep 30 | cat`; the
abort path SIGKILL'd only the direct child (/bin/sh). `sleep` was reparented to launchd,
kept running, and STILL HELD THE STDOUT PIPE → the child's `close` event never fired →
`createBashTool`'s promise never resolved → the runLoop hung (the user saw "still
running"; the session had to be killed).

Fix (`src/tools/bash.ts` + `src/tools/sandbox.ts`):
- both spawns (plain + `spawnSandboxedBash`) now pass `detached: true` — the shell (or
  sandbox-exec) leads its OWN process group; `spawnSandboxedBash` gained an optional
  `detached` pass-through.
- new `killChild()`: SIGKILL the whole group (`process.kill(-pid)`), fall back to the
  single child (Windows / group already gone). Timer + abort paths both call it.
- `finish()` extracted from the `close` handler + a **force-settle backstop**
  (`FORCE_SETTLE_MS = 10_000`, armed only on the kill paths): if a re-parented orphan
  somehow keeps a pipe fd open, the promise still settles (as timed-out/aborted) instead
  of hanging the loop forever.

Verified (live probes on the built dist): timeout 1s on `sleep 55 | cat` — unsandboxed
and sandboxed — settled in ~1.0s with `pgrep` clean (0 orphans); abort after 300ms —
settled in ~300ms, 0 orphans; normal completion + exit-code reporting unchanged.
New `test/bash-kill.test.ts` (4 tests) pins the contract: prompt settle (<10s, not at
the command's own 55s), no orphans (pgrep marker), sandboxed variant (skips off-darwin),
normal completion unaffected.

### 2 — `bashOutsidePaths` mis-parsed sed/awk REGEX LITERALS as paths → spurious "outside the workspace" prompt

Incident (2026-09-20): a pure in-workspace command
`sed -n '/opts.ui === "tui"/,/return/p' dist/src/cli/main.js | head -40` prompted
`bash: outside the workspace: /opts.ui === "tui"/,/return/p` — the sed ADDRESS RANGE was
tokenized as two absolute paths. The unanswered prompt stalled the run ~26 minutes
(the user wasn't watching; a `local`-mode prompt blocks the loop). Root cause:
`isPathCandidate` flags every token containing `/`; regex literals full of slashes were
never excluded.

Fix (`src/tools/safety.ts`): new `isRegexLiteral(t)` checked FIRST in
`isPathCandidate` — conservative (over-prompting is safe, under-prompting is not):
1. address ranges `/pat/,/pat2/…` — no real path contains `/,`;
2. flagged addresses `/pat/p`, `/pat/pg` — 1–2 letter flag tail (3+ letters keeps real
   paths like `/etc/ssh` promptable);
3. substitutions `s/pat/rep/flags` with ANY non-word delimiter (covers `s|…|…|`,
   `s#…#…#`) — a relative `s/…/…/` token can only resolve INSIDE the workspace, so
   skipping it never hides an outside path.
Unresolvable shapes (bare `/re/` awk patterns, `$VAR`s) still prompt.

Verified: the exact incident command → `[]` (no prompt); real paths in the same
command still flagged (`sed -n '/pat/p' src/a.ts; cat /etc/hosts` → `["/etc/hosts"]`);
`/usr/local/` is SAFE (in SAFE_PREFIXES) — a regression-test draft asserted otherwise,
the test now uses `/home/other/x/`. `test/safety.test.ts` +2 tests (9 regex-literal
commands → `[]`; real paths next to regex literals still flagged).

## TUI input cursor renders at its position (2026-09-20)

## Cursor location — the input ▍ now shows WHERE the caret is, not just the end (303 tests: 303 pass 0 fail; PTY frame verified)

Before (27b15b9): `inputCursor(input, width)` appended `▍` to the END of the
(truncated) input, so the caret never reflected the actual edit position. Now
the caret renders at `cursorPos` and ←/→ move it.

What changed (one increment, 5 files):
- **`src/tui/state.ts`** — added `cursorPos: number` to `TuiState` +
  `makeInitialState` (0). `inputChar` inserts at the cursor (split+rejoin) and
  advances it; `inputBackspace` deletes the char BEFORE the cursor (no-op at 0)
  and decrements it; new `inputMove(s, dir)` moves left/right (no-op at the
  bounds, locked while an approval is pending); `inputHistory` sets the cursor
  to the end on load / 0 on clear; `submitInput` resets it to 0.
  `inputCursor(input, cursorPos, width)` now renders `▍` at the cursor's
  display column and windows the row to one display line so the cursor is
  always visible: fits → whole string; cursor within the first `width` cols →
  show from column 0 (no ellipsis); otherwise a leading `…` (1 col) + the
  `width-1` cols around the cursor (a cursor at the END of a long input reduces
  to the old ellipsis+tail+cursor). Display width is computed with a small
  owned `charWidth`/`dispWidth`/`sliceByWidth` (wide CJK/Hangul = 2, combining
  marks = 0) — **no new dependency** (the dep freeze blocks `string-width` /
  `slice-ansi`, which are only transitive deps of `cli-truncate`).
- **`src/tui/app.tsx`** — new `onMove` prop; the keybinding table routes
  ←/→ to it; the input row renders `inputCursor(state.input, state.cursorPos,
  width)`; the idle hint now advertises `←/→ cursor`.
- **`src/tui/run.tsx`** — wires `onMove` → `inputMove`.
- **`test/tui-app.test.tsx`** + **`test/tui-pinned-layout.test.ts`** — added
  `onMove` to the render helpers; new `inputMove` unit test; `inputCursor` test
  rewritten for the 3-arg signature + cursor-location cases; render tests that
  set `input` now also set `cursorPos` (the cursor no longer defaults to the
  end).

Verification: `npm run build` clean; `npm test` 303 pass / 0 fail. PTY capture
(local build, `script` pty, session in `$TMPDIR`): typed `hello` → `hell▍o`,
then two left-arrows → `hel▍lo` — the caret visibly moves left. No guardrail-
zone files touched; no new deps.

---

# HANDOFF — terminal-size fd-leak fix (C23) on top of C22 (2026-09-20)

## C23 — `tre. tui` leaked one fd per render frame (terminal-size) and died of EMFILE after ~3 minutes — FIXED (resolve-hook shim, 303 tests: 303 pass 0 fail; PTY frame stress verified flat)

User report (2026-09-20): the self-improve run under `tre. tui` crashed.
Two symptoms, one cause:

1. The user's crash dump: `JavaScript heap out of memory` after 28 minutes
   of a session-less `tre. tui` (no `--session` → auto-compaction OFF). The
   heap-OOM side is not fully pinned down (no session file survived);
   mitigation for long runs: launch with `--session` so compaction is on.
2. The reproducible killer, found while observing a relaunched run:
   **`bash: failed to spawn: EMFILE: too many open files`** +
   **`error: fetch failed`** within ~3 minutes. `lsof` on the live process:
   6,148 fds on `/dev/tty` + 2,037 unix socketpairs, perfectly linear in
   time — a per-frame fd leak. macOS per-process cap
   `kern.maxfilesperproc = 10240` (soft `ulimit -n` is 1,048,575 — the
   sysctl, not the ulimit, is the real cap). Beyond it, every `open()`
   fails: sandboxed bash can't spawn, and `fetch()`'s socket setup fails,
   so the agent is blind and deaf.

Root cause (caught with an `fs.openSync` stack-trace hook):
**`terminal-size@4.0.1`** (a dependency of ink, called by ink's
`getWindowSize()` on **every render frame** whenever `process.stdout`
has no columns/rows — true under PTYs without a window size, e.g. `script`
driven from a non-terminal parent) does
`tty.WriteStream(fs.openSync('/dev/tty', O_EVTONLY|O_NONBLOCK))` and never
closes it. Measured: the `tty.WriteStream`'s libuv handle keeps **exactly
one fd per instance that `destroy()` + `closeSync` + waiting for `close`
never release** (plain `openSync`/`closeSync` is clean — the WriteStream is
the leaker). Every `terminalSize()` call that reaches `devTty()` therefore
leaks; under the no-winsize PTY it is reached every frame.

Fix (this commit):
- **`src/tui/terminal-size-shim.ts`** — a drop-in replacement for
  terminal-size (same export, same fallback chain stdout → stderr →
  COLUMNS/LINES → 80×24, same `createIfNotDefault` quirk) with the
  `/dev/tty` probe DROPPED entirely: the tput/resize probes read the same
  size without opening any fd (verified: tput answers even on a no-winsize
  pty; and when the tty truly has no size, the original probe returned
  0×0 which ink treats as unknown → 80×24, so nothing is lost).
- **`src/tui/terminal-size-hooks.ts`** — an ESM resolve hook that
  redirects the bare specifier `"terminal-size"` to the shim
  (`shortCircuit: true`).
- **`src/tui/terminal-size-fix.ts`** — registers the hook
  (`module.register()`, Node 26: `registerHooks()` exists but 24.x types
  predate it; `register` is deprecated-but-functional and type-stable).
- **`src/cli/main.ts`** — imports the fix first, and `runTui` is now a
  **dynamic** import in the tui branch. The dynamic import is LOAD-BEARING:
  a static import would link the whole module graph (ink included) before
  `register()` evaluates, and the hook would be too late. Verified: with a
  static ink import the fix silently does nothing.
- **`test/terminal-size-fix.test.ts`** — regression test: spawns the built
  fix + ink inside a real PTY (`script`), re-renders 300 frames, asserts
  the `/dev/fd` count stays within +10 (was +4/frame → +1200). Skipped off
  macOS (no `script` PTY there).

Verification (all under a no-winsize PTY, 3000 frames):
- before: fds 32 → 9,463 (≈3.1/frame by readdirSync; ≈4/frame by lsof incl.
  the socketpairs);
- after: fds 20 → 20 (delta 0). Shim `devTty`-free path: 100 calls, delta ≤4
  (readdirSync noise).

Notes for the next session:
- The heap-OOM half of the user's original crash (28 min, session-less) is
  still open. Long self-improve runs should use `--session` (compaction on)
  and `NODE_OPTIONS="--max-old-space-size=..."` is NOT a fix, only a delay.
- `module.register()` prints a DEP0205 deprecation warning on Node 26 —
  cosmetic; revisit when the minimum Node floor moves.

---

# HANDOFF — length-guard nudge (C22) on top of C21 (2026-09-20)

## C22 — the self-improve loop died at kickoff on `length` — FIXED (models.json pin + one nudge retry, 302 tests: 302 pass 0 fail; live one-shot verified)

User report (2026-09-20): unable to kick off the self-improve process — the
run stopped with `length: output limit hit — tool-call arguments may be
truncated` (the TUI/CLI rendering of stopReason `length`).

Root cause (measured against the live 172.30.70.13 server, Qwen3.8-27B):
1. **Thinking ate the whole output budget.** tre sends no thinking params,
   so the Qwen chat template's DEFAULT `reasoning_effort: xhigh` applies.
   At a ~24k-token prompt the model spent **6,313 thinking tokens** before a
   single 2-call reply; the failed run's prompt was ~62.8k tokens, where
   xhigh thinking exhausts the 8,192 output budget with nothing left for
   tool calls. The model itself is fine — at ≤24k prompt it acts in 100–300
   tokens; the xhigh default is a tax that scales with context size.
2. **The loop had no recovery for a no-call `length`.** The existing guard
   handles `length` WITH tool calls (fail them, model re-issues) — but a
   `length` with ZERO calls (the reply died mid text/thinking) broke the
   loop immediately. One over-long reply = dead run.

Fixes (two commits):
- **`models.json` (7acfb4c):** `compat.extraParams.options.
  reasoning_effort: "medium"` — pins thinking at the user's floor (NOT
  lower: medium is the minimum by user instruction). Server-verified both
  transports work (`options` and pi's `chat_template_kwargs`); measured
  medium = 217–2,222 thinking tokens at the same 24k prompt (vs 6,313 for
  xhigh) with instant tool calls. Also `maxTokens 8192 → 16384` (headroom
  for thinking + big tool args, e.g. a 30KB file write ≈ 10k tokens) and
  `contextWindow 98304 → 81920` (the file was STALE — the server's /props
  says `n_ctx 81920`; the old value made shouldCompact's math wrong and
  let a session overflow the real window).
- **loop (4f2d24d, C22):** a `length` stop with no tool calls now retries
  ONCE with a nudge user message ("your response hit the output limit
  before any tool call — re-issue the work in smaller pieces"); the
  partial stays in context (I2 already keeps it), so the model sees where
  it stopped. A second no-call `length` stops as before (`length`, exit 1);
  no nudge on the final allowed turn (budget boundary unchanged: `budget`).
  The retry consumes a turn like any other. +3 loop tests (nudge recovery,
  double-length stop, budget boundary) — 302 pass 0 fail.

Verification: live one-shot `tre. run --session /tmp/tre-verify.jsonl` →
thinking block present in the session (medium effort), clean stop.

Next: kick off the loop — `tre. tui --session ~/.tre/sessions/self-improve-<utc-ts>.jsonl`
with the self-improve skill prompt. The kickoff failure mode is gone on
both axes (thinking budget + no-call length).

## C21 — the self-improve loop was dead under the kernel sandbox — FIXED (solution C, human-approved zone change, GUARDRAIL_BYPASS=1 commit)

User report (2026-09-20): "tre. is not in a recursive improvement state; when
I try to start the process it looks like tre. is unable to access many of the
directories" — worst around git. Investigation (kernel canary matrix, all
failures reproduced deterministically under `spawnSandboxedBash`):

1. **node crash (loop-killer):** node's realpathSync walk-down lstats every
   path prefix from /; the enumeration denies (`/Users`, `/private` subpaths)
   match the ancestor NODES → EPERM → every `node <file>` crashed for
   workspace, /tmp AND $TMPDIR paths (tsc, node --test, npm all dead under
   the sandbox; only `node -e` survived).
2. **git swamp:** /usr/bin/git is an xcode-select SHIM → readlink of
   /private/var/db/xcode_select_link denied → rc=1 + stderr noise per call.
   Real git: UNREADABLE /etc/gitconfig is FATAL (EPERM ≠ the ENOENT it gets
   where the file is absent) → rc=128.
3. **/bin/sh cd** ENOTDIR under the policy (D12 note 8) → quality-gate
   dep-freeze false-fail.
4. **PTY:** /dev write-deny blocked openpty() → `script: openpty: Operation
   not permitted` → every TUI scenario + the skill's TUI recipe dead under an
   INHERITED sandbox (one-shot mode unaffected — e2e 5/14, all TUI dead).
5. **Nested sandbox:** a process already under a kernel policy cannot apply a
   DIFFERENT one (sandbox_apply → EPERM, rc 71; identical policy re-apply OK).
   The D20 farm had "proved" the loop green because its workstreams ran on
   PI (no sandbox at all) — tre.'s canaries only ever tested cat/ls.

Fixes (all in one commit, zone files under GUARDRAIL_BYPASS=1 per protocol):
- `sandbox.ts` policy: `file-read-metadata` (stat/lstat/readlink ONLY — no
  data, no listing) literal re-allows on the ancestor chains of the workspace
  + $TMPDIR, emitted BEFORE the workspace read-allow (which stays LAST —
  ordering unit-tested); literal read allow for /private/var/db/xcode_select_link
  (one file, no traversal); pty write-allows /dev/ptmx (literal) + /dev/ttys*
  (regex — SBPL has NO glob, NO extensible; verified kernel-DAC keeps
  cross-session pty slaves restricted: foreign active slave → Permission
  denied). /dev READS were already open by design (only writes confined).
- `sandbox.ts` spawn: GIT_CONFIG_NOSYSTEM=1 on sandboxed children (explicit
  caller value wins); nested semantics — spawnSandboxedBash marks its
  children (TRE_SANDBOX=1) and, when ITSELF marked, spawns UNWRAPPED so the
  child inherits the caller's confinement (no rc-71 crash; still confined).
- `quality-check.sh`: the dep-freeze step's one cd+node pair runs via
  `bash -c` (bash's cd passes the Seatbelt check; sh's doesn't).
- `e2e.sh`: workdir /tmp → $TMPDIR (write-denied; also where sessions live);
  s10 canary → repo root (a canary under $WORK=$TMPDIR would LEAK through the
  allowed per-user temp read — false "sandbox bypassed"); s10 SKIPS under an
  inherited sandbox (harness confined to repo+tmpdir = both allowed regions,
  no denied canary location reachable).
- `sandbox.test.ts`: unit tests (ancestorMetadataRules shape, policy rules +
  ordering, env contract, node-file + pty + /dev-creation OS probes; OS
  probe skips under an inherited sandbox — nested apply is EPERM).
- self-improve SKILL (zone): TUI recipe /tmp → $TMPDIR + fresh --session
  (the tre. child INHERITS the sandbox: /tmp write + ~/.tre denied).

Verified 2026-09-20: unit 299 (292 pass/0 fail/7 skip); kernel canaries
19/19 FRESH (all previously-broken steps green; /etc, /Users, /tmp writes,
~/.ssh, /dev creation all still denied); `npm test` green FRESH and under
INHERITED sandbox; e2e under INHERITED sandbox: 12/14 (all 6 TUI + one-shot +
sandbox scenarios pass; s10 skipped by design; s13 eval-baseline = 27B
variance — fails IDENTICALLY from a plain shell, pre-existing; s12
compaction failed 3x inherited vs 1x plain — NOT sandbox-related: every
inherited session shows ZERO tool errors, the 27B simply drifted the task
at the 4k window across compaction (run A: lost step 3, never wrote c.md;
run B: created merged.md via bash instead of c.md); s12 needs the same
27B-variance annotation as s13, or a bigger window). NOTE: this machine has NO git identity configured
anywhere (no ~/.gitconfig, no ~/.config/git, no /etc/gitconfig) — commits
auto-fall-back to `Hong Yu <tertain@Hongs-MacBook-Air.local>` (git's
no-identity fallback), which is why existing commits carry that identity.

## D21 — `--extra-root`: explicitly assigned non-sensitive dirs as extra read/write roots (C35) — WORK COMPLETE, gate green; awaiting human commit (guardrail zone)

`--extra-root <dir>` (repeatable) assigns an ADDITIONAL read/write region in
addition to the workspace. The boundary becomes a SET of roots (workspace +
extra roots) enforced in two layers that move together: the bash kernel policy
(`generateBashSandboxPolicy(root, extraRoots)` re-allows each extra root's
real-path subpath, read+write, + ancestor metadata, before the workspace rule
so the workspace stays last) and the write/edit path sandbox
(`checkPathWithinRoots(roots, p)` — allowed under ANY root). `read` stays
unrestricted. An extra root re-allows its own subpath only (never parent/
siblings).

**The guard (what makes it a contract):** each root is validated at startup and
the run REFUSES to start (exit 2) if its real path is sensitive (`~/.ssh`,
`~/.aws`, `*.pem`, `.env`-family, …) or outside the user's home (v1 rule: a
non-sensitive dir under `~`). The (ws)/(sys) sensitive split keeps using the
PRIMARY root only — an extra root never downgrades a path from (sys) to (ws),
so a `.env` under an extra root is still blocked in every mode.

**Inherited-sandbox limitation:** under `TRE_SANDBOX=1` the bash child spawns
unwrapped, so the per-call extra-root policy is inert (same as the workspace
re-allow). The kernel canary (unit) + e2e s19 skip under inheritance.

**Numbering note:** the spec was filed as "C27/D14" (commit `40fabfb`) and its
header said "next decision = D17" — both stale (the log had spent D14–D20; the
source contracts run to C34). Correct identifiers: **C35** (next after C34) +
**D21** (next after D20).

**Gate:** `tsc` clean; full suite **463 tests → 454 pass / 0 fail / 9 skip**
(451/443/8 before: +12 tests, +1 skip = the kernel canary, skipped under the
inherited sandbox). Quality-check source scan clean; dependency freeze OK.

**Commit (human, guardrail zone):**
```sh
GUARDRAIL_BYPASS=1 git add -A
GUARDRAIL_BYPASS=1 git commit -m "Add --extra-root: explicitly assigned non-sensitive dirs under home as additional read/write roots (C35/D21)"
```
Full spec: `docs/05-extra-roots-spec.md`; contract: `docs/02-contracts.md` C35.

## D20 — sessions outside the repo + explicit budget + dependency freeze — DONE (296 tests: 289 pass 0 fail; built by GPU farm, orchestrator-verified, 1 integration bug caught)

## D20 — sessions outside the repo + explicit budget + dependency freeze — DONE (296 tests: 289 pass 0 fail; built by GPU farm, orchestrator-verified, 1 integration bug caught)

User request (2026-09-19): implement the three pre-recursion boundary
improvements (1: sessions out of the repo, 2: budget guard, 3: dependency
freeze), parallelized with the gpu-farm skill. All three are in; the agent is
now ready for recursive development with a human-in-the-loop orchestrator.

**Build method (first multi-workstream farm run on this repo):** 3 git
worktrees in /tmp (d20-ws1/2/3), node_modules symlinked from the main repo,
3 self-contained specs in /tmp/farm-tre-d20.json, `farm run --force-lanes
vks-llama,radeon-llama` (forced: the orchestrator session itself runs on
vks-llama, so probes would self-contaminate). Wall 38.5 min: ws3-deps 11.5m
(radeon), ws2-budget 33.7m (vks, while I stayed idle so the lane was free),
ws1-sessions 27m (radeon, queued). All three: own commit, own green suite,
REPORT.md. Merged into main in order ws1→ws2→ws3 — ZERO conflicts (disjoint
regions were specified per workstream).

**1. Sessions live OUTSIDE the repo** (`de4139a`): `--session-auto` flag —
resolves `defaultSessionPath()` = `~/.tre/sessions/tre-<UTC yyyyMMdd>-<HHmmss>-<pid>.jsonl`
(src/session/session.ts, pure function, injectable now/pid for tests),
creates the parent dir, prints `session: <path>` to stderr ONCE (the
orchestrator's hook for building `--resume <file>`). Without the flag:
unchanged (no session file). `--session-auto` + `--session`/`--resume` →
conflict, exit 2. Skill (guardrail zone, applied under GUARDRAIL_BYPASS=1,
from the farm's SKILL-CHANGE.md) now MANDATES self-improve sessions under
`~/.tre/sessions/`. Verified live: one-shot with `--session-auto` →
`session: /Users/tertain/.tre/sessions/tre-...jsonl` + file created outside
the repo.

**2. Explicit budget** (`db1bfbb`): the existing `--max-turns` cap (default
32, pre-dates D20) was SILENT on cap-hit — the loop broke with the previous
message's stopReason ("toolUse"), exit 0, no message. Now: new StopReason
`"budget"` set by runLoop at the cap; `agent_end` carries `maxTurns` only on
budget; plain CLI → exit code **3** (distinct from 0 done / 1 provider / 2
usage / 130 aborted) + stderr `budget: max <n> turns reached
(resume: --resume <path>)` when a session is in use; TUI → error-kind item
`budget: max <n> turns reached — send another prompt to continue`, busy
cleared, next submit is a fresh run (per-run cap by construction). Verified
live: `--max-turns 1` on a read-then-summarize prompt → rc=3 + note.

**3. Dependency freeze** (`5fc4fa7`): `scripts/check-deps.mjs` (plain node
ESM, zero deps) — embedded allowlist: runtime exactly {cli-truncate, ink,
react, wrap-ansi}, dev exactly {@types/node, @types/react,
ink-testing-library, typescript}; rejects unexpected packages AND
lock/package.json drift (v2+v3 lockfile roots). Wired as check 6 in
`quality-check.sh` (CWD pinned to repo root, so it checks the repo no matter
where invoked). `test/quality-gate.test.ts`: 4 spawn-based fixture tests.
Guardrail zone extended (applied under GUARDRAIL_BYPASS=1 from the farm's
GUARDRAIL-CHANGE.md): `scripts/check-deps.mjs` is now PROTECTED — verified:
a probe commit touching it is rejected by the hook.

**Integration bug caught by the orchestrator (the reason farm work is
verified, not trusted):** ws3's aggregation `if ! (cd "$ROOT" && node
scripts/check-deps.mjs); then DEPS_STATUS=$?; fi` records the INVERTED
status — a failed deps check left DEPS_STATUS=0 and the gate exited 0
anyway (its own tests spawned check-deps.mjs directly, never the wrapper;
its "standalone gate exits 0" check ran on a clean manifest). Fixed in
e6167f1: capture the subshell status directly. Verified all three branches:
poisoned package.json → rc 1 (main path + no-.ts early-exit), clean → rc 0.

**Farm lessons (27B, this repo):** (1) `git add -A` staged the node_modules
SYMLINK (gitignore's `node_modules/` doesn't match a symlink) — ws2 hit it,
`git rm --cached node_modules` + amend; future farm worktrees should `git add
<files>` explicitly or the spec should say so; (2) ws1 correctly deviated
from the spec (a boolean flag registered on the value-taking branch would
swallow the next argv token) — specs must name the branch, not just the
line; (3) 27B needs ~11–34 min per workstream of this size; REPORT.md +
commit artifacts survive even when the final answer is cut.

**Definition of done met:** `npm test` 289/289 (quality gate incl. dep
freeze, tsc strict, node --test); live probes for all three behaviors; hook
reject-verified for check-deps.mjs. Commits: de4139a, db1bfbb, 5fc4fa7
(branches d20-ws1-sessions / d20-ws2-budget / d20-ws3-deps, merged), 6ec9e64
(guardrail overrides), e6167f1 (integration fix). REPORT.md artifacts:
/tmp/tre-d20-ws{1,2,3}/REPORT.md.

**Next (recursion):** ready to run the self-improve loop with a
human-in-the-loop orchestrator: agent commits → orchestrator reviews
git diff + `npm test` + targeted e2e (3, 4, 10) → next increment. Sessions
via `--session-auto` (outside the repo by construction). e2e full-suite
runs remain the deep regression net; the tag `known-good-2026-09-19` is the
named safe harbor.

## D19 — quiet file-access tool lines + models.json lookup — DONE (284 tests: 277 pass 0 fail; PTY + live one-shot verified)

User request (2026-09-19): (1) "too verbose about the directory access — for
now, it should only show if the access was denied based on the white list";
(2) launching `tre.` outside the project dir couldn't locate models.json —
fixable or must it move? Fixed in place, no move required.

**1. Quiet file-access tools (read/write/edit), both surfaces:**
- `src/types.ts`: `QUIET_ON_SUCCESS_TOOLS = {"read","write","edit"}` — the
  single shared policy. bash is NOT quiet: its command line is the approval
  surface and the user watches it.
- `src/tui/state.ts`: a quiet tool starts as a `hidden: true` height-0
  placeholder (no diff work either). On `tool_execution_end` (keyed by
  `result.toolName`): success → the item is DROPPED (no line ever rendered);
  denial → unhidden in place, so the ✗ + reason is the only file-access
  line. `itemHeight` returns 0 for hidden items, so the fit math already
  counts them as nothing; `app.tsx` renders `null` for them (the lockstep
  contract is preserved).
- `src/cli/main.ts` `printEvent`: quiet tools print no start line and no
  success line; a denied call prints just `  ✗ <reason>`.
- NOTE: the edit DIFF view (D10, `renderEditDiff`) is now unreachable on
  success — it only ever attached to edit items, and those are hidden.
The renderer, unit tests (`tui-diff.test.ts`) and the `diff` field all
  still exist; re-showing diffs = remove `"edit"` from the set (one line),
  and e2e scenario_03's old diff assertions are the template to restore.
- Tests: tui-state (quiet contract: hidden mid-flight / dropped on success /
  unhidden on denial, for read+write+edit; `tres`/`toolEnd` helpers now
  carry the real toolName — they hardcoded "x", which had masked the end-
  event name from the quiet logic), cli (printEvent: success silent, denial
  line, bash unchanged), pinned-layout (hidden=0, denied=mark+result),
e2e scenario_03 repurposed: file edited + NO diff line in frames.

**2. models.json lookup (`src/config/models.ts` `findModelsFile`):**
- `--models <file>` wins (returned as-is, even if missing — the caller
  reports it, unchanged). Otherwise: walk UP from the launch directory
  (like a `.git` dir: `test/`, `scripts/`, the project root, …) looking
  for `models.json`, then fall back to the permanent `~/.tre/models.json`.
- `main.ts` resolves this before loading; not-found → exit 2 with the
  searched locations named + the `--models` escape. `CliOptions.modelsPath`
  is now `string | undefined` (undefined = auto-locate).
- Verified live: launch from /tmp → clean not-found error; launch from
  `test/` (no local file) → walks up to the project's models.json and
  runs. A user who wants a HOME-level config: `mkdir -p ~/.tre && cp
  models.json ~/.tre/` — the project-local file still wins while launching
  inside the tree.

**Verified:** `npm test` 277/277 (quality gate clean, 24 files); live
one-shot from a subdir: successful read prints NO line, failed read prints
`✗ read: …`, bash lines unchanged; PTY TUI smoke: read turn renders no
`→ read` / `✓` line, clean /quit.

## D18 — rename to Tre Coding Agent (`tre.`) + quality gate — DONE (276 tests 0 fail; quality gate wired into `npm test`; PTY + --help verified)

User request: real name "Tre Coding Agent", invoked as `tre.` (trailing dot
— a valid POSIX command name). The legacy `coding-agent` command is KEPT as
an alias (both bins point at the same `dist/src/cli/main.js`).

- `package.json`: name `tre-coding-agent`, v0.1.0, dual bin
  (`tre.` + `coding-agent`), `npm install --package-lock-only` synced the
  lock. Global re-link (`npm link` after removing the stale `coding-agent`
  global pkg dir — the first attempt failed on EEXIST of the old bin link).
- CLI: help/usage, error strings, REPL banner → `tre.` / Tre Coding Agent.
- TUI: header branded `tre. · <model> — turn N`. Hint line now advertises
  the `/` menu ("enter send · / commands · ↑/↓ history · …") — the D16
  HANDOFF claimed this was done; it wasn't. Verified by PTY capture.
- `test/e2e.sh`: default range fixed 13 → 14 — `scenario_14` had been
  silently excluded from full runs ever since it was added (latent bug).
- **Quality gate** (D17 backlog item d, built by a farm agent, verified by
  the orchestrator): `scripts/quality-check.sh` — POSIX sh, no deps, scans
  src/*.ts for: `console.log(`, TODO/FIXME, trailing whitespace, tabs,
  node_modules//bare-dist/ import specifiers. Optional dir arg (default
  src/). Wired into `npm test` as the FIRST step (fail-fast) + standalone
  `npm run check`. Verified: clean run exit 0 (24 files), bad fixture exit 1
  naming file:line for every violation class.
- Guardrail-zone files (self-improve skill relaunch text, guardrail comment)
  updated under a human-decision `GUARDRAIL_BYPASS=1` commit, as designed.
- **gpu-farm pilot** (first real fan-out): 2 workstreams on both lanes
  (Qwen3.8-27B, nvidia + radeon). Result: the quality-gate agent DELIVERED
  its file 3 min before its 1200 s timeout but was killed while composing
  the final answer (farm marks it `timeout`, .out empty); the read-heavy
  brand-audit agent (600 s) also timed out. LESSON for farm use on 27B:
  (1) artifacts on disk survive the timeout — check the workstream's cwd
  before discarding a `timeout` result; (2) give 27B ≥1500 s for tasks that
  end in a long final answer, or require the agent to write its report to a
  file as it goes; (3) the orchestrator absorbed the audit inline (one grep
  pass) — for small read-heavy tasks, inline beats a farm lane.
- Post-rename brand audit: remaining "coding agent" strings are general-
  category prose (system prompts in tests, docs titles, README description)
  or historical records (PLAN.md) — intentionally left.

## D17 — self-improve readiness — DONE (baseline committed + tagged; skill + guardrail hook live; e2e s14 menu-aware and live-passing)

Goal: make it safe to run `coding-agent tui` INSIDE this repo and let it
improve itself. Assessment: possible — full toolset + red-teamed kernel
sandbox + a network-free verification loop (`npm test`, 276 tests) +
sessions/resume + git. A running process is immune to its own on-disk edits
(Node doesn't hot-reload); only the NEXT launch is affected.

What was set up (all committed on top of the D12–D16 baseline):

1. **Baseline commit + tag**: `95347ed` "D12-D16 …", tag
   `known-good-2026-09-19`. Clean tree. `dist/` is gitignored, so recovery
   from a broken build = `git checkout .` (sources) + `npm run build` —
   the tag is the named safe harbor.
2. **`.gitignore`**: added `.history/` (pi file-history snapshots — local
   safety net, not repo content) and `context-fold/` (pi byproduct).
3. **The self-improve skill**: `.pi/skills/self-improve/SKILL.md` — loads
   by default (project skills dir is `<cwd>/.pi/skills`, no flag needed).
   Encodes the mechanical protocol: clean-tree check → ONE increment →
   `npm run build` → `npm test` → commit → HANDOFF.md → repeat; failure
   recovery (`git checkout .` after 2 failed attempts, never leave a broken
   build); the guardrail zone; a PTY-capture recipe for TUI verification;
   turn-budget/session handoff rules; definition of done.
4. **Hard guardrail hook**: `scripts/guardrail-check.sh` (sh, no deps) +
   `scripts/git-hooks/pre-commit`, wired via `git config core.hooksPath
   scripts/git-hooks` (repo-local config — a fresh clone must run that
   command once; noted in the hook header). REJECTS any commit touching:
   `src/tools/sandbox.ts`, `src/tools/safety.ts`, `src/tools/bash.ts`,
   `scripts/guardrail-check.sh`, `scripts/git-hooks/*`,
   `.pi/skills/self-improve/SKILL.md`. Human override: `GUARDRAIL_BYPASS=1
   git commit`. Verified both ways (reject + bypass + normal commit pass).
5. **e2e `scenario_14` menu-aware + LIVE VERIFIED**: the D16 note below
   claiming it was unaffected was WRONG — the feeder types `/quit` (a
   registered command), so the LAST frame has the menu open between the
   hint and the top separator. The anchor now skips up to 5 menu lines
   (`"> /…"` or `"  /…"`) after the hint. Re-run `bash test/e2e.sh 14 14`:
   PASS against the live 27B (radeon).

**First recursive run (pilot, supervised)** — scoped, test-gated tasks, in
suggested order:
   a. tab-completes-first (shift-tab or plain tab completes the selected
      menu candidate instead of inserting a space — see D16 candidates)
   b. per-argument completion: `/display-bottom ` → field names (relax the
      "space hides the menu" rule for a known command's args)
   c. new bottom fields: `provider`, `sandbox` (on/off), per-turn tokens
      (registry entry + `bottomValue` case + label plumbing in run.tsx/main.ts)
   d. `npm run lint`-style quality gate (eslint or a minimal script) wired
      into `npm test` to stop style drift over many agent commits

Model note: the harness is model-agnostic (`models.json` → any
OpenAI-compatible endpoint). Currently served by Qwen3.8-27B Q4 (radeon
`172.30.70.13:8080`) — fine for (a)–(c); point at a stronger endpoint for
anything cross-cutting.

## D16 — `/` completion menu — DONE (unit 276/276 pass, 0 fail; live PTY verified: `/` → menu, ↓↓ → `/quit`, enter completes, enter exits)

User request: while more slash commands/settings are coming, typing `/` must
show GREY candidate options filtered by what's typed; nothing typed → all
commands alphabetical; arrow keys navigate.

Behavior (all pure in `src/tui/state.ts`, D16 block):

- **Registry**: `SLASH_COMMANDS: {name, summary}[]` — single source of truth.
  Adding a command = one entry here (+ its dispatch in run.tsx). Currently:
  `display-bottom`, `exit`, `quit`.
- **Visibility**: only for a BARE command word — input starts with `/` and
  contains NO space (a space = arguments → menu hides; this also hides it
  after completion, which leaves `/cmd ` with a trailing space). Hidden
  while an approval is pending.
- **Filtering**: the word's stem prefix-filters the registry; alphabetical;
  `/` alone → all commands. Capped at `MENU_MAX_LINES = 5`.
- **Render**: grey (dim) lines BETWEEN the hint and the top separator —
  `> /name — summary` (selected, non-dim) / `  /name — summary` (dim).
  Steals budget from the item area exactly like the approval line: `fitItems`
  now takes `extraLines: number` (was `hasApproval: boolean`); app.tsx passes
  `(approval?1:0) + menu.length`.
- **Keys** (run.tsx): ↑/↓ → `menuNav` (wrap-around; falls through to history
  when the menu is hidden); enter → `menuComplete` FIRST — if the typed word
  ≠ the selected candidate it completes the input to `/cmd ` (a second enter
  submits); exact match → normal submit path. The busy-`/quit` escape was
  changed to compare `state.input.trim()` (completion leaves a trailing space).

Files:

- `src/tui/state.ts` — `TuiState.suggestIdx`; `fitItems(..., extraLines)`;
  D16 block: `SlashCommand`, `SLASH_COMMANDS`, `MENU_MAX_LINES`,
  `slashCandidates`, `suggestMenu`, `menuNav`, `menuComplete`.
- `src/tui/app.tsx` — menu between hint and top separator; budget includes
  `menu.length`; frame comment updated.
- `src/tui/run.tsx` — `onHistory` tries `menuNav`; `onSubmit` tries
  `menuComplete`; busy-quit trim.
- `test/tui-pinned-layout.test.ts` — D16 block: candidate filter, menu
  lines/marker/cap/approval-hide, nav wrap + stale-index clamp, complete vs
  exact-match, fitItems extraLines (3-line menu shrinks pad by 3), App frame
  geometry with the menu (hint at row 14, menu 15–17, separators/input
  pinned at 18–20).

CORRECTION (D17): `test/e2e.sh` `scenario_14` WAS affected — the feeder
types `/quit` (a registered command), so the LAST frame has the menu open
between the hint and the top separator; the anchor was made menu-aware and
the scenario live-verified (see D17).

Next candidates: per-argument completion (e.g. `/display-bottom ` → field
names as a second menu level — would need the "space hides the menu" rule
relaxed for a known command's args), fuzzy (not just prefix) matching,
tab-completes-first instead of enter.

## D15 — `/display-bottom` + no `you` prefix — DONE (unit 271/271 pass, 0 fail; live PTY verified)

Two user requests, both in the TUI only (`coding-agent tui` — NOT `-tui`,
which parses as prompt text):

1. **`you` prefix removed** — the user's typed text renders PLAIN: on the
   dedicated input line (no cyan `you ` marker) and in the echoed user item
   in the output area (full width now, wraps at `width` not `width-4`).
   `inputText` truncates at full width. Empty input renders a bare space so
   the row keeps its height.
2. **The 3 reserved bottom lines are user-configurable** via a slash command
   (dispatched in run.tsx BEFORE the unknown-command error; `/quit`/`/exit`
   stay driver-owned):
   - `/display-bottom`            → report current selection + field menu
   - `/display-bottom off|none`   → clear (lines go blank again)
   - `/display-bottom f1 f2 …`    → set fields (deduped, order preserved;
     more than 3 → first 3 win; unknown field → rejected with the menu)
   - Fields: `model`, `status` (idle/working…), `turn`, `tokens` (cumulative
     `Usage.totalTokens` across `done` events), `cwd`, `session` (label the
     driver passes; `—` when absent). Rendered dim as `field: value`, one per
   reserved line, truncated to width.
   - Feedback lands as a new `info` item kind (dim line in the output area).

Files:

- `src/tui/state.ts` — `TuiItem` += `info`; `TuiState` += `bottom[]`,
  `totalTokens`, `info: Record<string,string>`; `makeInitialState(label, info?)`;
  `applyEvent done` tallies usage; `itemHeight` (user full-width, info case);
  `inputText` full-width; NEW D15 block: `BOTTOM_FIELDS`, `bottomLines`,
  `handleSlashCommand` (all pure).
- `src/tui/app.tsx` — input line = plain `<Text>`; user item = plain
  full-width `<Text>`; `info` item = dim `<Text>`; reserved lines render
  `bottomLines(state, width)` dim.
- `src/tui/run.tsx` — `TuiRunOptions.cwd?/sessionPath?` → labels into
  `makeInitialState`; `onSubmit` dispatches `handleSlashCommand` (clears the
  busy flag the submit raised — slash commands are UI, not runs).
- `src/cli/main.ts` — passes `cwd: root`, `sessionPath: args.resumePath ??
  args.sessionPath` into `runTui`.
- `test/tui-pinned-layout.test.ts` — D15 block: `bottomLines` values/order/
  truncation/unknown-skip/padding, `handleSlashCommand` set/clear/report/
  unknown/passthrough, `done` usage tally; user-item/input-row asserts
  de-prefixed (3 `startsWith("you")` frame checks → blank-row checks).
- `test/tui-app.test.tsx` — `/you/` frame assert → `/hi/`.

Also changed: `test/e2e.sh` `scenario_14` re-anchored — it pinned the LAST
`^you` line, which no longer exists; it now anchors on the LAST hint line
and checks the block AFTER it (─ / input (blank or the typed `/quit`) / ─ /
3×blank). SUPERSEDED (D17): scenario_14 WAS re-run live after the D16
menu-aware rework — PASS (see D17).

Next candidate fields (one-liners in the `bottomValue` switch + registry +
label plumbed via `TuiRunOptions`): `sandbox` (on/off), `provider`,
`model_path`, per-turn tokens, session file size. Extend the e2e
`scenario_14` reserved-line contract if the bottom lines get pinned
non-blank (it currently expects them blank — the default).

## D14 — pinned input layout — DONE (unit 256/256; e2e: D14 scenarios pass, 4 pre-existing/D13 failures remain — see below)

The input line renders at a CONSTANT position: exactly 4 lines above the
bottom of the terminal, with a `─` separator immediately above and below it;
the lower 3 lines are reserved (blank, for future status info). Header +
output items fill the rows above; when items don't fit, they are trimmed from
the TOP. The frame is exactly `rows` lines tall (Ink fullscreen → no flicker).

Files:

- `src/tui/state.ts` — appended pure functions + constants: `wrapLineCount`
  (wrap-ansi `{trim:false, hard:true}` — mirrors Ink exactly), `itemHeight`
  (per-kind, lockstepped with the `Item` rendering), `itemsHeight`, `fitItems`
  (longest tail that fits `rows - FIXED_NON_ITEM_LINES - (approval?1:0)`,
  degenerate → newest item only + ellipsis line), `inputText`, `approvalLine`,
  `RESERVED_BOTTOM_LINES=3`, `PINNED_LINES=6`, `FIXED_NON_ITEM_LINES=8`.
- `src/tui/app.tsx` — frame rebuilt from `useStdout()` dimensions + `fitItems`;
  `oneLine` via cli-truncate for header/hint; keybinding table, `AppProps`,
  and `Item` rendering untouched.
- `test/tui-pinned-layout.test.ts` — NEW, 10 tests: 7 pure (wrap mirror at
  80/100, itemHeight per kind, itemsHeight sum, fitItems budget/tail/ellipses,
  inputText/approvalLine, constants) + 3 App-render geometry on
  ink-testing-library's 100×24 fake stdout.
- `test/e2e.sh` — `scenario_14` (pty_feed 480s; last 7 ANSI-stripped lines
  must be hint / ─ / you / ─ / 3×blank) + case entry 14.

Farm history (option B, 27B Qwen, both clusters): wave 1 w1a-state ok (259 s,
nvidia); w1b-tests TIMED OUT at the 30-min cap — test file was complete but
e2e/report missing (27B slowness, not a task design flaw); wave 2 w2a-render
ok (249 s, nvidia). e2e scenario_14 was finished by the orchestrator.

Bugs found & fixed in ORCHESTRATOR integration (3 app-side, 4 test-side):

1. **JSX whitespace = bare text node**: `<Text color="cyan">you</Text> <Text>…</Text>`
   on one line — the space between the elements is a Box text child, and Ink 7's
   reconciler throws `Text string " " must be rendered inside <Text>` → the whole
   frame is swallowed (test library: `lastFrame() === "\n"`; PTY: Ink error
   overlay). Fix: space lives INSIDE the second `<Text>` (multi-line JSX).
   NOTE for future TUI work: never put single-line whitespace text between Ink
   elements; and ink-testing-library SWALLOWS reconciler errors — an empty
   frame in a test means "check for a render exception", not "nothing rendered".
2. `fitItems(…, state.approval !== undefined)` — `TuiState.approval` is
   `{…} | null`, so `!== undefined` is ALWAYS true → budget permanently -1 →
   frame rows-1 tall. Fixed to `!== null`.
3. w1b's `renderApp` used a 3-prop AppProps shape — real `AppProps` has 8
   (onChar/onBackspace/onHistory/onSubmit/onCtrlC/onApproval/onQuit); fixed to
   the tui-app.test.tsx convention.
4-7. Test-side: `frameLines` helper dropped the last reserved line (strips one
   trailing `\n` but the frame ends with a terminating newline → pad to 24);
   Ink trims trailing whitespace per line so pad/reserved arrive as `""` not
   `" "`; constants test had `PINNED_LINES === 4 + 3` (off-by-one — the frame
   equation pins 3 separators/input/reserved-groups → `3 + 3`); approval test
   expected the idle hint `enter send` on line 17, but the hint SWITCHES to
   `y approve · n/esc deny` while pending (pre-existing behavior, pinned by
   tui-app.test.tsx).

Verify: `npm test` → 263 tests / 256 pass / 0 fail (7 pre-existing skips).
e2e (full sweep 1..14, 27B Qwen both clusters): 01,02,03,06,07,08,09,11 PASS.
- **s14 (tui-pinned-layout, NEW): PASS** — two of my own scenario bugs fixed
  along the way: (1) macOS `sed` can't process `\x1b` → "illegal byte
  sequence", empty strip → python3 re-strip; (2) `tail -7` on the PTY log is
  untrustworthy — the log is a CONCATENATION of every frame, so the previous
  frame's reserved blanks bleed into the tail → now anchors on the LAST
  `^you` input line and verifies the block around it (hint/─/─/3×blank). The
  frame itself was correct in the real PTY from the first run:
  hint / ─ / `you` / ─ / 3×blank, 80×24.
- **s04/s05 (tui-deny, tui-ctrl-c-abort): fixed for D13.** Their commands
  (`echo denied-probe`, `sleep 40 && …`) are workspace-scoped, so D13's `local`
  default AUTO-APPROVES them — no approval prompt ever appears → the deny/abort
  flows can't run. Changed both to outside-path commands (`cat /etc/hostname`
  appended) so the approval gate prompts. (Scenario-side only; re-verified in
  the follow-up run.)
- **s12 (tui-compaction): PASS on re-run; flaky, environment-caused.**
  Instrumented run (temp console.error, removed after) showed the code path is
  correct: trigger fires (totalTokens 3480/11684/19930 > 4096 window) and the
  ✂ renders when the summary succeeds — but the **summarizer LLM call
  intermittently fails/returns empty** (27B, MTP n=4; COMPACT-SKIP-A branch),
  compaction is skipped for that turn and retried next turn. Two failed runs =
  every summary attempt failed during those windows. NOT a D14 regression.
  **Follow-up gap (real, small):** in TUI mode the skip note goes to
  NULL_SINKS → the user never sees "compaction skipped: summary call failed";
  I3 wanted visibility. Route it into the TUI (e.g. an error item) someday.
- **s10 (sandbox-escape-block): FAIL — D13 territory, NOT touched by D14.**
  One-shot `run "Read /etc/passwd…" --yes` expected the path sandbox to BLOCK
  the outside read (✗, no "root:" leak); the content leaked → the sandbox
  (dirty-tree D13 safety.ts) let an /etc/passwd read through (or the 27B used
  an access form the path parser misses, e.g. `python3 -c "open('/etc/passwd')"`).
  Needs owner attention — this is the security module.
- **s13 (eval-baseline): FAIL at 900 s — known 27B variance** (documented).

Design + resume doc: D14-RESUME.md (deleted after commit — recoverable from
git history of 95347ed).

## D13 — workspace-scoped approval (`local` mode, new default) — DONE

User request (2026-09-14): with the deployed `npm link` build, "anything that
requires bash also requires me to approve" — wants auto-approve for in-
workspace work, explicit confirmation only for bash that reaches OUTSIDE the
safe locations.

- New default approval mode `local` in `src/tools/safety.ts`: bash auto-
  approves when nothing destructive AND no path outside the safe locations;
  write/edit auto-approve (the path sandbox already proves they can't leave
  the root).
- `bashOutsidePaths(cmd, root)` — quote-aware static scan (tokens: leading
  /, ~, ., $, flag `=`, bare `/`; stuck + standalone redirects; $HOME/$PWD/
  $TMPDIR + ~ resolved; cwd-relative → workspace). Safe locations mirror the
  D12 Seatbelt allowlist: workspace, /usr /bin /sbin /System /Library /opt,
  /tmp + per-user temp, /dev fakes. Unresolvable $VAR paths → prompt
  (conservative).
- D8 destructive patterns now prompt in EVERY mode, incl. local, even
  in-workspace (`rm -rf build` still confirms).
- Flags (mutually exclusive): `--local` (default) / `--ask` (pre-D13 prompt-
  per-call) / `--yes` / `--no-approve`. Help text updated.
- The scanner is a PROMPT HEURISTIC, not the security boundary — D12
  Seatbelt stays the boundary. Not seen: network ops, dynamic paths.
- Tests: `test/safety.test.ts` (bashOutsidePaths unit + local-mode hook
  tests), `test/cli.test.ts` (flag parsing; the denial-path test now uses
  `--ask` since the default no longer prompts).
- Verified 2026-09-14: 246 unit tests pass / 0 fail / 7 skip; smoke: ws +
  /usr + /tmp quiet; /etc, ~, $VAR prompt naming the outside path; `rm -rf
  build` confirms; denial → block. **No e2e re-run needed for this change**
  (e2e uses --yes/--no-approve explicitly), but full8 remains a good
  regression gate before shipping further.
- The user's deployed build: re-run `npm run build` in the project dir to
  pick up D13 (the `npm link` symlink stays valid).

## State (WS11)

**All 13 e2e scenarios verified PASS** (across runs; the suite is green). Unit
tests: 246 pass / 0 fail / 7 skip (live, post-D13). Build clean.

| scenario | verified in |
|---|---|
| s1–s9, s11, s13 | full7 (`/tmp/e2e-full7.log`) — 12/13, s10 flipped to PASS |
| s10 sandbox-escape-block | full7 — **PASS** (kernel sandbox blocks the bash fallback) |
| s12 tui-compaction(✂) | `/tmp/e2e-s12-final.log` — **PASS** ("✂ rendered, compaction entry persisted, task completed across compaction") |

## WS11 — bash kernel sandbox (D12) — DONE

The bash tool's child now runs under a macOS Seatbelt profile (`sandbox-exec`),
closing the s10 gap (read tool blocked but bash fallback leaked `/etc/passwd`).

- `src/tools/sandbox.ts` — policy generation + `spawnSandboxedBash`.
  ALLOWLIST BY ENUMERATION (rewritten 2026-09-18 after s10's canary exposed
  that the old denylist left /tmp, /var and /Volumes readable/writable — a
  canary file OUTSIDE the workspace but under /tmp was readable via bash):
  reads + writes denied for /private (the real path of /tmp, /var, /etc —
  the kernel checks data access on the RESOLVED path), /Users, /Volumes,
  /Network, /cores, /Library/Keychains (+ its /System/Volumes/Data real
  spelling), /System/Volumes/Preboot, /System/Volumes/Data/home (the real
  target of the /home symlink), plus NODE denies (`(literal ...)`) on /etc
  and /home; the workspace (in its REAL path), /private/var/folders (per-user
  temp) and /dev/null|stdout|stderr are re-allowed LAST (last matching rule
  wins). /usr, /bin, /sbin, /System, /Library stay readable so exec/dyld work.
- `src/tools/bash.ts` — `createBashTool(cwd, { sandbox?: boolean })`; sandboxed
  when cwd set + darwin + not opted out. Description updated so the model knows
  the boundary.
- `src/cli/main.ts` — `--no-sandbox` flag.
- `test/sandbox.test.ts` — policy shape tests + a kernel-level OS probe (darwin,
  offline): /etc read+write denied, workspace read/write works, /dev/null works,
  children confined.

**Empirical kernel findings (D12, macOS 15 Apple Silicon)** — these cost real
debug time, keep them (2, 3, 4 refined by the 2026-09-18 kernel matrix):
1. A catchall deny (regex `^/` or `subpath /`) + re-allowed prefixes makes
   the exec'd process SIGABRT even when the exec target is allowed (Abort
   trap 6, re-verified 2026-09-18). TOP-LEVEL denies + a subpath re-allow are
   safe — hence the allowlist-by-enumeration.
2. Last matching rule wins (a later `allow` re-allows a denied path — the
   workspace escape hatch).
3. Data access (open/read/write) is checked against the RESOLVED path — one
   `(subpath "/private")` deny covers /tmp, /var and /etc, and the workspace
   re-allow must use the workspace's REAL path. SYMLINKED TOPS are special:
   a subpath deny of /tmp, /var or /etc is FATAL — it kills every
   literal-spelling open underneath and NO re-allow survives it (not even
   `allow subpath /`). So symlinked tops get NODE denies (literal) only —
   safe on /etc and /home (no workspace lives there); /tmp and /var get no
   node deny because a workspace under them must survive. Residual (accepted):
   `ls /tmp` / `ls /var` list top-level NAMES only (no contents, no descent).
4. `file-read*` (not just -data) also denies metadata — `ls /etc` fails.
5. Profiles propagate across fork/exec.
6. `sandbox-exec` is NOT guaranteed at /usr/sbin — resolve /usr/bin vs
   /usr/sbin (this machine has a non-standard /usr tree: no /usr/bin/ls,
   no /usr/sbin/sandbox-exec).
7. Spawn the child with cwd = workspace: running under the policy from a cwd
   that is DENIED makes the shell's getcwd fail and pollutes stderr
   ("shell-init: error retrieving current directory").
8. The sandboxed child runs /bin/bash, not /bin/sh: sh's `cd` fails with
   ENOTDIR on ANY path under a deny policy (its cd hits a check class
   subpath rules do not cover — even `cd .`); bash's cd passes. `cd`
   outside the workspace may "succeed" but every file op there is still
   denied — the chdir escape is inert.
9. /bin/sh probes /private/var/select/sh at startup (harmless stderr noise
   when denied) — re-allowed for quietness.

Known v1 boundary: per-user temp (/var/folders), /opt and /usr,/bin,/sbin,
/System,/Library stay accessible (exec/dyld + tool runtimes need them);
`ls /tmp` and `ls /var` leak top-level names only; commands needing ~/.ssh
(git push over ssh) fail under the sandbox by design — `--no-sandbox` for
system-maintenance work.

## s12 flakiness — server contention, not a code bug

s12 failed twice (full7 + a retry) and passed on the third run. Root cause:
the e2e and this agent session share the ONLY 27B server. A long agent turn
(88k-token context, one task generated 6,348 tokens in 253s — visible in the
llama.cpp pod logs) queues/starves the e2e's turns and the compaction summary
call. I3 then skips compaction (context unchanged) — previously SILENT.

Fix in: `src/cli/main.ts` now writes
`compaction skipped: summary call failed or returned empty (context unchanged)`
to stderr when the trigger fired but the summary failed — silent skips are
diagnosable.

**Ops rule (still the top one): keep agent turns quiet while e2e runs.**
Launch, then ONE long polling turn with zero side work. The pi session's
context grows each session — big turns get slower and hog the server longer.

## Earlier fixes (this project's WS10 era, for reference)

- e2e s5: `wait_pattern` closing-quote mismatch (pattern now matches the real
  tool line).
- REPL piped mode: burst lines queued instead of dropped; EOF only after the
  queue drains (s8).
- Compaction planner: window-aware keep cap + single-prompt fold (index-0 task
  survives via the summary) (s12).
- eval `--timeout` is per-task (total = timeout × tasks); s13 watchdog 900 s.

## Re-run

```bash
npm test                          # unit, offline (~2 s)
FEED_DEBUG=1 nohup bash test/e2e.sh 1 14 > /tmp/e2e-full.log 2>&1 &  # full incl. TUI pinned, ~12–40 min
bash test/e2e.sh 14 14            # single TUI pinned-layout scenario
```

History: `.history/snapshots/` + `.history/CHANGELOG.md` (also a git repo —
commit the WS11 work if you want a tagged checkpoint).
