# Tre Coding Agent

Invoke as `tre.` (the legacy `coding-agent` command remains as an alias).

A small, fully-owned coding agent: a TypeScript harness that talks to an
OpenAI-compatible LLM endpoint (first target: the TKG llama.cpp server), runs
an agent loop with tools (`read`/`write`/`edit`/`bash`), and persists sessions
as JSONL.

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
same settings), a context/compaction readout, an
approval-mode matrix (`--yes` default · `--ask` · `--no-approve`, with
systemic sensitive/destructive ops blocked in every mode), deployability
(`npm i -g .` builds `dist/` on install), and loop/stall guards that stop
runaway and sandbox-wall retry loops. See `HANDOFF.md` for the dated change log.

## Docs

- `docs/01-walkthrough-harness-llm.md` — how a coding-agent harness talks to an LLM endpoint (reference behavior, source-traceable; frozen record of the v0.85.1 reference)
- `docs/02-contracts.md` — the three WS0 contracts (the gate for parallel work)
- `docs/03-citation-policy.md` — the L1/L2/L3 borrowing rules for the pi reference (mandatory citations)
- `docs/04-skill-authoring.md` — skill constraints (load paths, write boundary, sandbox network, secrets)
- `docs/05-extra-roots-spec.md` — `--extra-root` + durable `tre.json` `extraRoots` (C35/C36)
- `docs/06-compaction-cheap-wins.md` — compaction cheap wins + failure escalation (A1–A6, D)
- `PLAN.md` — workstreams, locked decisions (D1–D23), build order

## Quickstart

```bash
npm install
npm test        # tsc + node --test (contract tests, no network)
```

### Point it at an endpoint

The endpoint config is **not in git** (it's per-machine). Create it from the
template:

```bash
cp models.json.example models.json   # then edit models.json
```

Fill in `baseUrl` (your OpenAI-compatible endpoint, e.g.
`http://<host>:<port>/v1`) and the model's `id`. `tre.` finds `models.json`
by walking up from the launch dir, then `~/.tre/models.json`. With **no**
`models.json` (or a blank `baseUrl`), `tre.` prints a step-by-step setup
guide — REQUIRED vs OPTIONAL fields — and exits.
