# coding-agent

A small, fully-owned coding agent: a TypeScript harness that talks to an
OpenAI-compatible LLM endpoint (first target: the TKG llama.cpp server), runs
an agent loop with tools (`read`/`write`/`edit`/`bash`), and persists sessions
as JSONL.

Built from scratch using pi (MIT) as a *design reference* — no code vendored.
Every design decision is traceable to the walkthrough.

## Status

- [x] Phase A — WS0: repo scaffold + the three contracts (`src/types.ts`)
- [ ] Phase B — WS1 wire · WS2 loop · WS3 tools · WS4 prompt · WS5 session · WS8 tests (parallel)
- [ ] Phase C — WS6 CLI integration · WS7 safety

## Docs

- `docs/01-walkthrough-harness-llm.md` — how a coding-agent harness talks to an LLM endpoint (reference behavior, source-traceable)
- `docs/02-contracts.md` — the three WS0 contracts (the gate for parallel work)
- `PLAN.md` — workstreams, locked decisions (D1–D6), build order

## Quickstart

```bash
npm install
npm test        # tsc + node --test (contract tests, no network)
```
