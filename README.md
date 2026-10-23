# Tre Coding Agent

Invoke as `tre.` (the legacy `coding-agent` command remains as an alias).

A small, fully-owned coding agent: a TypeScript harness that talks to an
OpenAI-compatible LLM endpoint (first target: the TKG llama.cpp server), runs
an agent loop with tools (`read`/`write`/`edit`/`bash`/`subtask`), and
persists sessions as JSONL.

Built from scratch using pi (MIT) as a *design reference* — no code vendored.
Every design decision is traceable to the walkthrough (a frozen record of the
v0.85.1 reference source; see `docs/03-citation-policy.md` for the borrowing
rules).

## Status

All planned workstreams are complete; the project is in ongoing hardening.

- [x] Phase A — WS0: repo scaffold + the three contracts (`src/types.ts`)
- [x] Phase B — WS1 wire · WS2 loop · WS3 tools · WS4 prompt · WS5 session · WS8 tests
- [x] Phase C — WS6 CLI integration · WS7 safety
- [x] Phase D — WS9 compaction · WS10 TUI (Ink) · WS11 bash kernel sandbox (macOS Seatbelt)

Since the MVP, hardening has added: mid-run steering, a scrollable TUI with
opt-in mouse tracking, `/models` switching, in-place `/restart` (same session,
same settings), a context/compaction readout, approval controls (`--yes` is
the default — auto-approve, with only systemic sensitive/destructive
operations blocked; `--ask` and `--no-approve` are alternatives),
deployability (`npm i -g .`
builds `dist/` on install), a Linux bash sandbox (Bubblewrap, alongside the
MVP's macOS Seatbelt), loop/stall guards that stop runaway and
sandbox-wall retry loops, an MCP client (tier 1 stdio servers + a
model-invoked `mcp_resource` reader; see `docs/10-mcp-scope.md`), and a session-scoped `subtask` tool (create/list/
mark) whose progress the TUI renders in a color-coded bottom field
(in-progress green, queued yellow, failed red) that settles to `none` once
the workstream is done and quiet — next to a header elapsed-time ticker.
The TUI's `/display-bottom` opens an interactive field picker (↑/↓ + space
+ enter/esc) for choosing which fields the bottom lines show. See
`HANDOFF.md` for the dated change log (entries through 2026-10-19 are in
`HANDOFF-archive.md`).

## Docs

- `docs/01-walkthrough-harness-llm.md` — how a coding-agent harness talks to an LLM endpoint (reference behavior, source-traceable; frozen record of the v0.85.1 reference)
- `docs/02-contracts.md` — WS0 contracts and subsequent contract increments (current types are authoritative)
- `docs/03-citation-policy.md` — the L1/L2/L3 borrowing rules for the pi reference (mandatory citations)
- `docs/04-skill-authoring.md` — skill constraints (load paths, write boundary, sandbox network, secrets)
- `docs/05-extra-roots-spec.md` — `--extra-root` + durable `tre.json` `extraRoots` (C35/C36) + the implicit, always-on `~/.tre` root (C38)
- `docs/06-compaction-cheap-wins.md` — compaction cheap wins + failure escalation (A1–A6, D)
- `docs/07-context-display-fidelity.md` — context display fidelity changes and remaining items
- `docs/08-loop-hardening.md` — loop/stall guard status and follow-ups
- `docs/09-linux-sandbox.md` — Linux bash sandbox (Bubblewrap) boundary and mount order (Darwin stays on Seatbelt)
- `docs/10-mcp-scope.md` — MCP (tier 1: stdio servers, tools only) design + the one CLI asymmetry (`--tools` filters built-ins only; MCP tools are additive, per-server `tools` allowlist is the MCP-scoped equivalent)
- `docs/tui-mouse-selection/PLAN.md` — TUI in-app mouse selection + `/copy` (implemented)
- `docs/workstream-input/plan.md` — responsive input during workstreams: stream-render coalescing + immediate interactive paints (implemented)
- `HANDOFF.md` — dated implementation history (historical statuses may be superseded)
- `PLAN.md` — original workstreams and decisions (historical; see status note there and HANDOFF for later increments)

## Quickstart

```bash
npm install
npm test        # tsc + node --test (contract tests, no network)
```

### Point it at an endpoint

The endpoint config is **not in git** (it's per-machine). Create it from the
template:

```bash
mkdir -p ~/.tre/tre
cp models.json.example ~/.tre/tre/models.json   # then edit that file
```

An explicit `--models <file>` overrides this path. `models.json` is not
searched for in the working directory; the checked-in example is a template,
not a discovered runtime config. Fill in `baseUrl` (your OpenAI-compatible
endpoint, e.g.
`http://<host>:<port>/v1`) and the model's `id`. `tre.` reads its endpoint catalog from `~/.tre/tre/models.json` (or an explicit `--models <file>`); it never picks up a generic `models.json` from your working directory. With **no**
`models.json` (or a blank `baseUrl`), `tre.` prints a step-by-step setup
guide — REQUIRED vs OPTIONAL fields — and exits.

### ChatGPT Plus (no API key)

`tre.` can also drive a model through your ChatGPT subscription — the same
Codex-style OAuth (authorization-code + PKCE) that the Codex CLI uses, then
the Responses API. No API key; rate limits are your subscription's.

```bash
tre. login            # opens the browser; tokens → ~/.tre/chatgpt-auth.json (0600)
tre. auth status      # show the stored login (email, plan, expiry)
tre. auth logout      # delete the stored tokens
```

Then add a model with `"api": "openai-responses"` + `"auth": "chatgpt-oauth"`
to `models.json` (see `models.json.example`). The access token is refreshed
automatically from the stored refresh token when it expires.

**Login uses fixed local ports.** The OAuth client is the one Codex ships,
and `auth.openai.com` only accepts its loopback redirect on the registered
ports — `127.0.0.1:1455` (default) or `:1457` (fallback). If a login fails
with "callback ports 1455 and 1457 are in use", another OpenAI sign-in
(e.g. `codex login`) is holding them — close it and retry. Headless/SSH:
the login also accepts a pasted redirect URL (from the address bar after
logging in on another machine).

### OpenRouter (any hosted model, one key)

[OpenRouter](https://openrouter.ai) fronts hundreds of hosted models behind
one OpenAI-compatible `/chat/completions` endpoint and one API key — so it
runs on the standard `openai-completions` wire, no special code. Create a key
at [openrouter.ai/keys](https://openrouter.ai/keys), then add one entry per
model you want (the `id` is OpenRouter's `vendor/model` slug, e.g.
`anthropic/claude-sonnet-4`):

```json
{
  "id": "<vendor/model-id>",
  "provider": "openrouter",
  "baseUrl": "https://openrouter.ai/api/v1",
  "api": "openai-completions",
  "apiKey": "sk-or-...",
  "contextWindow": 200000,
  "maxTokens": 8192,
  "headers": {
    "X-Title": "Tre. Coding Agent",
    "HTTP-Referer": "https://github.com/digitalminer26/Tre.-coding-agent"
  }
}
```

- `headers` (per-model, optional) is sent verbatim with every request —
  OpenRouter uses `X-Title`/`HTTP-Referer` for app attribution on its
  rankings page. Any custom header works here.
- Provider routing and reasoning knobs go through `compat.extraParams`
  (merged into the request body): `"provider": { "order": ["bedrock",
  "anthropic"] }`, `"reasoning": { "effort": "medium" }`, …
- `contextWindow`/`maxTokens` are per model — check the model's page on
  openrouter.ai.

## Releasing

`tre.` ships as a self-contained **offline tarball** (pre-built `dist/` + the
full prod-only `node_modules`, pure JS + WASM, no native addons) that a target
machine installs with **only a Node runtime** — no network, no npm, no GitHub,
no build step. The tarball is a build artifact (`.tre/deploy-out/`,
gitignored) and is distributed as a **GitHub Release** on this repo.

One command does the whole release (bump → test → commit → push → build →
publish):

```bash
scripts/release.sh X.Y.Z          # e.g. scripts/release.sh 0.2.0
```

`release.sh` runs `npm test` first (the bump is only committed if the gate
passes), commits `package.json`, pushes `main`, builds
`tre-coding-agent-X.Y.Z-offline.tgz`, and publishes tag `vX.Y.Z` with the
tarball as the release asset (`scripts/release-publish.py`, stdlib-only
Python; token from `$GITHUB_TOKEN`, then the machine-level
`~/.tre/github-token` file, then the macOS keychain `github.com`
credential). `TRE_PUSH=0` / `TRE_PUBLISH=0` skip those steps.

Installing on a target machine (Node ≥ 20; ≥ 22 recommended) is one command —
download and execute the versioned installer script from the release:

```bash
curl -fsSL https://github.com/digitalminer26/Tre.-coding-agent/releases/download/vX.Y.Z/install-tre-X.Y.Z.sh | sh
```

Replace `X.Y.Z` with the release version (e.g. `v0.4.3`). The script downloads the matching
offline bundle, installs it under `~/.tre/tre`, creates the `tre.` symlink,
updates the shell PATH configuration if needed, and smoke-tests the install.
Alternatively, download the `.tgz` asset and run its embedded
`install-tre.sh install` if you prefer a manual/offline transfer.

`install-tre.sh install` also adds `~/.local/bin` to your shell rc
(`.zshrc`/`.bashrc`/`.profile`) and tells you the one-line `export PATH`
for the current shell. In a new terminal, `tre. --help` just works.

Uninstall: `rm -rf ~/.tre/tre ~/.local/bin/tre.` (plus `~/.tre/` config/data
if you want the machine fully clean — see `install-tre.sh`'s `show` output).
