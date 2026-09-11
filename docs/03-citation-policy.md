# 03 — Citation & Sourcing Policy

pi ([github.com/earendil-works/pi](https://github.com/earendil-works/pi), MIT, © Mario
Zechner) is the design reference for this project. We write our own code, but two
degrees of borrowing are allowed — each with a **mandatory citation**.

Reference implementation (read-only, for study and selective borrowing): the pi
packages installed at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`
— `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`, both **v0.85.1**
(compiled JS under each package's `dist/`).

## Levels

| Level               | Meaning                                                                            | Citation                                                                                     |
|---------------------|------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| **L1 verbatim**     | Lines copied directly from pi's source                                             | File header **and** an inline citation at each copied block (exact source file + symbol)     |
| **L2 adaptation**   | Structure/logic clearly derived from pi's code (renamed, simplified, restructured) | File header citing the source module(s) and what was derived                                 |
| **L3 independent**  | Written without reference to pi's code                                             | None                                                                                         |

## Format

File header (top of the file, before imports):

```ts
// L2: structure adapted from @earendil-works/pi-agent-core 0.85.1 (MIT, © Mario Zechner),
//      src/agent-loop.ts — turn dispatch + length→fail-all-calls guard.
//      Simplified: no steering/follow-up queues, single wire format, no grammar tools.
```

Inline (L1 only, directly above the copied block):

```ts
// L1: copied from @earendil-works/pi-ai 0.85.1 (MIT, © Mario Zechner),
//      dist/api/openai-completions.js — buildParams() stream_options handling.
```

## Rules

1. Every source file is either **L3** (no citation) or carries a header stating
   **L1/L2 + the source**.
2. L1 copies are marked **per block**, with the exact package + file + function.
3. Citations pin the version borrowed from: **0.85.1** (the reference audited on
   2026-09-10). Borrowing from a different version must pin that version in the
   citation.
4. MIT requires preserving the copyright notice and license: `THIRD_PARTY.md` at the
   repo root carries the aggregate citation table + the MIT text. **Update it in the
   same commit** as the code it covers.
5. Prefer L3 where feasible; L2 where pi's structure is clearly better; L1 only for
   small, stable, well-exercised snippets (e.g. SSE edge-case handling, JSON salvage).
   Never L1 an entire file — if a module is mostly pi's code, rewrite it as L2 or
   vendor it deliberately.
6. Wave B branches must not modify `src/types.ts` or `models.json`. If a contract is
   inadequate, work around it locally and flag it in the final report — contract
   changes are a broadcast decision (PLAN.md §7, risk 2).
