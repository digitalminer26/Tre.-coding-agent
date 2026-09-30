# Spec — Context display fidelity (bottom field + `/context` report)

Status: **approved 2026-09-29 (scope: items 1, 2, 4); not yet implemented.**
Items 3 and 5 are logged as future work (§7). All new logic is L3
(independent); no pi prior art is involved (see `docs/03-citation-policy.md`).

Scope: `src/tui/state.ts` (state fields, `applyEvent`, `contextBreakdown` /
`contextReport` / `bottomValue`, `BOTTOM_FIELDS`), `test/tui-state.test.ts`.
No `src/types.ts` change (the `done` event's `usage` already carries
`cacheRead`/`cacheWrite`; `context_compacted` already carries `degraded`).
No wire-layer change (usage parsing already exists). No guardrail-zone files.
No `models.json` schema change.

## Why

The `context` bottom field and the `/context` report show a three-way split
(system / summary / messages) plus the compaction trigger. The state machine
already RECEIVES more than it displays: the full per-call `usage` (input,
output, cache read/write) is dropped after `totalTokens` is tallied, the
previous context size is forgotten (so growth per turn is invisible), and
compaction events are rendered as items but never counted. This spec adds the
fidelity that costs nothing: display what the events already carry.

## Items

### 1 — Cache visibility (data already in hand)

**What.** The endpoint's prompt-cache behavior is invisible today. Show it.

**State.** On each assistant `done` with `usage`:

- `lastUsage: { input: number; output: number; cacheRead?: number;
  cacheWrite?: number } | null` — the LAST call's usage (replaces nothing;
  `contextTokens` keeps its own semantics).
- `cacheReadTotal`, `cacheWriteTotal: number` — session cumulative (0 when the
  endpoint never reports them).

**Display.**

- New bottom field `cache` (added to `BOTTOM_FIELDS`, user-pinnable via
  `/display-bottom`): the last call's cache ratio —
  `cached 11.0k/12.1k (91%)` — or `—` when the endpoint reports no
  `cached_tokens` (never show `0%`: absence of the field is not a zero hit
  rate).
- `/context` report gains two lines (only when data exists):
  `last call: in 12.1k (cached 11.0k) / out 340`
  `session cache: read 45.2k · write 2.1k` (write line only when > 0).

**Edge cases.** Endpoints that never report `prompt_tokens_details` → the
field stays `—` and the report lines are omitted (no misleading zeros). A
`cacheWrite` of 0 with `cacheRead` > 0 is normal (warm cache) — show only
what is non-zero.

### 2 — Growth per turn + turns-until-compaction (derived)

**What.** `contextTokens` is a single point; the user cannot see how fast the
context is filling or how many turns compaction is away.

**State.**

- `contextDelta: number | null` — `new − old` context size, computed on each
  `done` (usage-based) and `context_compacted` (estimate-based) when BOTH old
  and new are known. After a compaction the delta is large and negative —
  recorded as-is, and it RESETS the average history (the trend before the
  compaction is not comparable to after).
- `deltaHistory: number[]` — the last up to 8 deltas (compaction resets it to
  `[delta]`). The prediction uses the MEAN of the history, not the last
  value, so one noisy turn doesn't wreck the estimate.

**Display.**

- Bottom `context` field: append ` +820` (last delta, `fmtTokens`-compact;
  negative renders ` −170k`) when `contextDelta` is known.
- `/context` report gains (when computable):
  `growth: +820 last turn · +740 avg (8 turns)`
  `~14 turns until compaction` — `floor(headroom / avgDelta)` when
  `headroom > 0` and `avgDelta > 0`; `compaction is not approaching` when
  `avgDelta <= 0`; omitted when the headroom is already negative (the DUE
  line covers that case).

**Edge cases.** First turn (no previous size) → no delta, no prediction.
`avgDelta <= 0` (context shrinking, e.g. after compaction) → no prediction,
growth line still shown. Unknown window (no threshold) → prediction omitted,
growth line still shown.

### 4 — Compaction history (cheap count)

**What.** The breakdown reflects only the CURRENT summary; the user cannot
tell how often compaction has fired or how much it has compressed.

**State.** On each `context_compacted`:

- `compactionCount: number` (increment).
- `lastCompaction: { tokensBefore: number; messagesKept: number;
  summaryChars: number; degraded: boolean } | null`.

**Display.**

- Bottom `context` field: append ` ×2` when `compactionCount > 0`.
- `/context` report gains (when `compactionCount > 0`):
  `compactions: 2 · last: 180k → 9.1k summary + 12 msgs kept`
  with a ` (degraded)` suffix when the last one used the rule-based fallback
  (item D of `docs/06-compaction-cheap-wins.md`).

**Edge cases.** `×1` renders as ` ×1` (the count is the point — one
compaction is already notable). The `summary` line of the existing breakdown
still reflects the current summary; the history line is additive.

## Exit criteria (per item)

- New state fields are seeded in `makeInitialState` and round-trip through
  `applyEvent` without touching existing fields' semantics
  (`contextTokens`, `summaryTokens`, `totalTokens` unchanged).
- Bottom field and report render the exact formats above; `—`/omission rules
  hold for endpoints without cache data and for the pre-first-turn state.
- `test/tui-state.test.ts`: cases for (1) cache ratio + cumulative + the
  no-cache omission, (2) delta across two turns, the average over a history,
  the compaction reset, the turns-until-compaction math + its omission
  cases, (4) count increment, last-event capture, the degraded suffix.
- `npm run build` + `npm test` green. TUI frame check per the self-improve
  protocol (bottom line + `/context` info item).

## 7. Future items (logged, not designed)

- **F1 — Message composition.** Split the `messages` bucket into
  tools / model text / user input (per-message chars/4 estimates tracked in
  `applyEvent`). Biggest fidelity jump; needs new state tracking, so it is a
  separate increment.
- **F2 — System-prompt section split.** The driver measures the prompt's
  sections (identity/tools, guidelines, project-context files, skills index,
  cwd) at build time; the `sys` number becomes `sys 4.2k (ctx 1.8k · skills
  0.9k)`.
- **Rejected for now:** cost tracking (no pricing fields in `models.json`;
  the design deliberately omits cost — a scope decision, not a display one);
  per-message token counts (belongs in a `/history`-style command, not the
  bottom line — the TUI state machine stays lean).
