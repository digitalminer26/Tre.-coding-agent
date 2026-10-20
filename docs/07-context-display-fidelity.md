# Spec — Context display fidelity (bottom field + `/context` report)

Status: **approved 2026-09-29 (scope: items 1, 2, 4); implemented
2026-09-30.** Items 1, 2, 4 landed, one behavior per commit (self-improve
protocol): item 1 `b97a7e6`, item 2 `a7d0a31`, item 4 `6f0373c` (handoff:
top section of `HANDOFF.md`). The two items once logged as future work have
since landed: item 5 (system-prompt section split) as §8's F2, resolved
2026-10-11 (`f11f8d9`), and item 3 (message composition) as §7's F1,
designed + implemented 2026-10-13. All new logic is L3 (independent); no
pi prior art is involved (see `docs/03-citation-policy.md`).

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

## 7. F1 — Message composition (designed 2026-10-13; implemented this increment)

Split the `messages` bucket into **tools / model / user**. The split is
computed from the message snapshot the `agent_end` event carries (the run's
final context — `agent_end.messages`), so no per-event accumulation is
needed: the loop emits `agent_end` at every run end, so the split refreshes
at least once per prompt. Per-message estimates use the loop's own
estimator (`estimateMessageTokens`, `src/context/compact.ts`, chars/4) so
the split is consistent with the compaction math. Thinking text counts as
model — the model emitted it; a compaction summary (the `SUMMARY_MARKER`
user message) is excluded — it is already the `summary` bucket; user input =
user messages that are NOT the summary.

**State.** The three buckets are session-CUMULATIVE splits of the context's
message tokens, kept in proportion rather than as absolute sums (the context
itself shrinks on compaction — absolute sums would drift upward forever):

- `msgSplit: { tools: number; model: number; user: number } | null` — the
  CURRENT breakdown of `contextTokens − systemPromptTokens − summaryTokens`
  (the `messages` bucket), estimated from the message snapshot the last
  `agent_end` carried. null = unknown (no turn yet, or the estimator has no
  data). Mid-run `done`s keep the PREVIOUS split (they carry no full
  snapshot the state machine uses for this).
- On `agent_end`: recompute the split from `ev.messages` (the final
  context), normalized against the CURRENT breakdown's `msgs` number
  (`contextTokens − sys − summary` — the `done` that preceded `agent_end`
  already refreshed `contextTokens`, so the basis is current, not stale).
- On `context_compacted`: the split drops to null — the event carries only
  counts (`messagesKept`, `summaryChars`), no message snapshot, so the old
  split would misdescribe the new [summary, …kept] context; the next
  `agent_end` recomputes it.

**Normalization.** `est = estTools + estModel + estUser`; the raw buckets
sum to the message-history estimate, but the displayed `messages` number is
`contextTokens − sys − summary` (usage-derived, more accurate). The state
scales each bucket by `messages / est` and rounds each part independently,
so the three displayed parts sum to the `msgs` number the breakdown already
shows within ±1 per bucket (rounding drift). `est = 0` (empty history) →
split stays null.

**Display.**

- Bottom `context` field: `msgs 38.1k` becomes
  `msgs 38.1k (t 22.3k · m 11.4k · u 4.4k)` — always the three-way split
  (t=tools, m=model, u=user) once known; the bare `msgs N` renders before
  the first split (unknown → never a fake zero).
- `/context` report: the `messages:` line gains the same suffix
  (`messages: 38.1k (tools 22.3k · model 11.4k · user 4.4k)`).

**Edge cases.** Compaction: the recomputed split on the next `agent_end`
naturally reflects the new [summary, …kept] context (the summary message is
excluded from the user bucket, so the `summary` bucket never double-counts
it). A history with zero tool results → `t 0` shown (that is real data, not
absence). Split unknown (no message snapshot yet) → both displays omit the
split (byte-identical to today's rendering).

**Exit criteria.** `test/tui-state.test.ts`: (1) split computed from the
`agent_end` message snapshot and normalized to the usage-derived msgs total;
(2) user bucket excludes a `SUMMARY_MARKER` message; (3) thinking counts as
model; (4) bare `msgs N` before the first split, split suffix after;
(5) zero-tool history renders `t 0`; (6) the three parts sum to the `msgs`
number within ±1 per bucket. `npm run build` + `npm test` green; TUI frame
check (bottom line + `/context` info item).

## 8. Future items (logged, not designed)
- **F2 — System-prompt section split.** The driver measures the prompt's
  sections (identity/tools, guidelines, project-context files, skills index,
  cwd) at build time; the `sys` number becomes `sys 4.2k (ctx 1.8k · skills
  0.9k)`.
- **Rejected for now:** cost tracking (no pricing fields in `models.json`;
  the design deliberately omits cost — a scope decision, not a display one);
  per-message token counts (belongs in a `/history`-style command, not the
  bottom line — the TUI state machine stays lean). F2 was resolved 2026-10-11
  (see the `sys (ctx · skills)` suffix); F1 was designed in §7 and implemented
  (2026-10-13).
