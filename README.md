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

- [x] Phase A — WS0: repo scaffold + the three contracts (`src/types.ts`)
- [ ] Phase B — WS1 wire · WS2 loop · WS3 tools · WS4 prompt · WS5 session · WS8 tests (parallel)
- [ ] Phase C — WS6 CLI integration · WS7 safety

## Docs

- `docs/01-walkthrough-harness-llm.md` — how a coding-agent harness talks to an LLM endpoint (reference behavior, source-traceable; frozen record of the v0.85.1 reference)
- `docs/02-contracts.md` — the three WS0 contracts (the gate for parallel work)
- `PLAN.md` — workstreams, locked decisions (D1–D6), build order

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
