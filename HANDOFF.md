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
```

## Earlier (this file's prior life)

The previous HANDOFF (sandbox: re-allow `/private/etc/ssl/openssl.cnf` so
curl & git https work under the policy, 2026-09-28) was committed as
90209e6 and is superseded. The WS9-era fixes it referenced (e2e s5/s8/s12/s13,
compaction skipped-line) remain in git history.
