# Spec — Compaction cheap wins + failure escalation

Status: **approved 2026-09-28; implemented 2026-09-29.** All items landed,
one behavior per commit (self-improve protocol): A4 `1fe6651`, A1 `0bc3dfe`,
D `4595815`, A2+A3 `181fadf`, A6 `3d9d76c` (handoff: `7fd70db`). A5 was
rejected (see below); A7/B/C/E/F remain deferred. All new logic is L3
(independent); prior art is cited in the PLAN.md decision log, not in code
headers (see `docs/03-citation-policy.md`).

Scope: `src/context/compact.ts`, `src/cli/main.ts`, `src/tui/state.ts`,
`src/tui/run.tsx`, `test/compact.test.ts`, `test/tui-state.test.ts`, and ONE
additive optional field in `src/types.ts` (item D — flagged per policy).
No guardrail-zone files. No `models.json` schema change.

## Improvement criteria (user-approved rubric)

An improvement counts only if it meets:

- **C1** — compaction happens *later* without losing fidelity
- **C2** — retains same-or-more data using same-or-less space
- **C3** — important information (goals, constraints, paths, decisions)
  survives losslessly

Items meeting the criteria are prioritized; QOL items that don't are kept
only by explicit decision.

## Prior art (for the PLAN.md decision log)

- Anthropic, "Effective context engineering for AI agents" + context
  management announcement: tool-result clearing is the safest lightest-touch
  compaction; tune prompts recall-first, then precision.
- OpenHands SDK `context/condenser/`: shrink-and-retry on summary failure;
  structured summary template (USER_CONTEXT / COMPLETED / PENDING /
  CODE_STATE / TESTS / …); HARD vs SOFT condensation requirements.
- Cline `extensions/context/`: basic (rule-based, no LLM) vs agentic (LLM)
  compaction; budget projection; 8192-token summary output budget;
  deterministic file-ops extraction into a FILES section; chars/token
  underestimate factor capped at 4.

## Assessment (why the order is what it is)

| Item | C1 later, no fidelity loss | C2 ≥data ≤space | C3 lossless important info | Verdict |
|---|---|---|---|---|
| **A4** structured prompt + deterministic FILES | ✅ same timing, higher fidelity | ✅ bounded output, more verified data per token | ✅ **flagship** — paths extracted deterministically, goals verbatim | meets all 3 — #1 |
| **A1** calibrated chars/token | ✅ prevents post-compact overflow → no immediate re-compact (double summarization = real fidelity loss) | ✅ keep budget becomes honest | ✅ net-positive | meets — #2 |
| **D** retry → rule-based shrink | ✅ normal path untouched | ✅ fallback tiny | ✅ degraded mode keeps recent tail verbatim + file ops; beats a crash that loses everything | meets (safety net) — #3 |
| **A2** drop thinking from transcript | ✅ | ✅ frees summarizer budget → more transcript summarized in the same space | ✅ low risk (decisions live in text/tool calls, not reasoning traces) | meets — #4 |
| **A3** tool-result cap | ✅ | ✅ (middle-truncation keeps both head and tail) | ✅ with the fix below | meets, fixed — #4 |
| **A6** manual `/compact` | ➖ neutral | ➖ neutral | ➖ neutral | **QOL — kept by explicit user decision, #5** |
| ~~A5~~ trigger headroom (+10%) | ❌ makes compaction happen EARLIER (current trigger already fires only when the next call would overflow — already as late as possible) | ➖ | ➖ | **REJECTED — dropped** |

Rejected/deferred:

- **A5 (dropped)**: the current trigger is already maximally late; adding
  headroom moves it earlier (fails C1), and its reliability benefit is
  redundant once D exists (shrunken-transcript retry + rule-based fallback
  cover the overflow edge). Revisit only as a user-facing knob.
- **A7 — prefix-cacheable summarizer call** (send folded messages verbatim
  so the provider's prompt cache covers the shared prefix; summary call
  costs ≈ output tokens only): more invasive; revisit if summary-call cost
  becomes visible.
- **B (Condenser seam), C (separate summarizer model), E (post-compact
  re-orientation), F (agentic memory)**: separate decisions.

---

## A4 — Structured summary prompt + deterministic FILES section

**Problem.** The current 4-bullet prompt leaves path enumeration to the
LLM; summaries drift on long runs.

**Design.**

1. New sectioned instructions in `summarizePrompt` (replaces the 4-bullet
   list; `SUMMARIZER_SYSTEM` unchanged):

   ```
   1. GOAL — the user's goal(s) and constraints, verbatim where possible.
   2. DONE — what was completed: files touched, commands run and their
      outcomes, decisions made.
   3. STATE — what is in progress, blocked or failed, open questions.
   4. FILES — copy the FILES section below VERBATIM (it was extracted
      from the transcript; do not guess paths).
   5. NEXT — the immediate next step(s) to continue the work.
   Be concrete (exact paths, commands, values). Omit chit-chat.
   Under 500 words.
   ```

   The iterative fold-in paragraph stays.

2. New pure function:

   ```ts
   export interface FileOps { read: string[]; modified: string[] }
   /** Deterministic file-ops extraction from assistant toolCall blocks.
    *  read → read list; write/edit → modified. bash is NOT parsed
    *  (ambiguous). Deduped, first-seen order, capped at 50 paths each. */
   export function extractFileOps(messages: AgentMessage[]): FileOps;
   ```

3. `summarizePrompt` appends, when non-empty:

   ```
   FILES (extracted from the transcript — verified):
   read: a.ts, b.ts
   modified: c.ts
   ```

**Tests.** `extractFileOps` (mixed transcript: dedup, order, cap, bash
ignored, non-path args ignored); prompt contains the section + the verbatim
instruction; empty ops → no section; iterative path unchanged.

## A1 — Calibrated token estimation

**Problem.** `estimateMessageTokens` uses chars/4. Dense code/JSON
tokenizes ~2–3× denser, so the keep window (and the post-compaction
`contextTokens` estimate) can be 2–3× larger than intended — the
compacted context may still overflow, forcing an immediate re-compaction
(double summarization = fidelity loss).

**Design.**

- `estimateMessageTokens(m, charsPerToken = 4)` and
  `estimateTokens(msgs, charsPerToken = 4)` — optional param, default 4
  (existing call sites unchanged).
- New pure function:

  ```ts
  /** Calibrated chars-per-token from one real usage sample.
   *  `systemChars` is the system prompt's char count (its tokens are in
   *  usage but not in the message list — subtract to avoid bias).
   *  Returns 4 (uncalibrated) when the sample is degenerate; clamped to
   *  [1, 4] so a pathological sample can't collapse the budget (Cline caps
   *  the same underestimate factor at 4). */
  export function calibrateCharsPerToken(
    usage: Usage,
    context: AgentMessage[],
    systemChars: number,
  ): number;
  ```

  Formula: `est = estimateTokens(context) + ceil(systemChars/4)`;
  `actual = usage.totalTokens - ceil(systemChars/4)`;
  `cpt = 4 * est / actual`, clamped to `[1, 4]`; return 4 when
  `est <= 0` or `actual <= 0`.

- `main.ts`: `cpt` persists across runs within a session (the REPL and
  TUI keep it alongside their `context` var — `runTurn` takes an optional
  `charsPerToken` and returns the updated value). In `prepareNextTurn`,
  before the trigger check, recompute `cpt` from the last assistant
  usage (systemChars = `systemPrompt.length`) and pass it to
  `compactContext` (new option `charsPerToken?: number`) and to the
  `estimateTokens(newContext, cpt)` used for the `context_compacted`
  event's `contextTokens`.
- `compactContext` uses `cpt` for the keep plan and the window cap.

**Tests.** dense sample (est 1000 / actual 3000 → cpt ≈ 1.33), sparse
sample (→ clamps at 4), degenerate (→ 4), clamp bounds; `estimateTokens`
honors the param.

## D — Failure escalation (retry → rule-based fallback)

**Problem.** A failed/empty summary call skips compaction (I3); with the
trigger already fired, the next call likely overflows the window and the
run dies on a wire error.

**Ladder** (in `compactNow`, when the trigger fired and `compactContext`
returned undefined):

1. **Retry once** with a shrunken transcript: `compactContext` gains
   `transcriptOpts?: { perMessageChars?: number; totalChars?: number }`;
   the retry passes `{ perMessageChars: 750, totalChars: 12000 }`
   (halved). Covers transient failures and "summarizer input too big".
2. **Rule-based fallback** (no LLM) if the retry also fails. New pure
   function:

   ```ts
   /** Deterministic shrink: same keep plan as planCompaction, but the
    *  folded prefix is replaced by a small notice user message
    *  (SUMMARY_MARKER + count + extractFileOps list) instead of an LLM
    *  summary. Returns undefined when no plan exists. */
   export function ruleBasedShrink(
     context: AgentMessage[],
     keepTokens: number,
     charsPerToken: number,
   ): { notice: UserMessage; kept: AgentMessage[] } | undefined;
   ```

   The notice starts with `SUMMARY_MARKER`, so session replay,
   `isSummaryMessage`, and the iterative fold-in all keep working
   unchanged. The context strictly shrinks (notice ≈ a few hundred chars
   vs. the folded prefix).
3. If even the fallback has no plan (context too short to fold) →
   today's behavior: skip, stderr message (unchanged).

**Wiring.** `main.ts`: extract the session-entry + event logic currently
inline in `prepareNextTurn` into a shared exported helper:

```ts
/** Manual (force) and auto (trigger) compaction share this: the trigger
 *  check (skipped when force), the retry+fallback ladder (D), the session
 *  compaction entry, and the context_compacted event. Returns the new
 *  context, or undefined when nothing could be compacted. */
export async function compactNow(deps: {
  streamFn: StreamFn;
  model: ModelConfig;
  signal: AbortSignal;
  context: AgentMessage[];
  session?: Session | null;
  ids: Map<AgentMessage, string>;
  systemPrompt: string;
  compactKeepTokens?: number;
  charsPerToken?: number;
  force?: boolean;
  sinks: PrintSinks;
  onEvent: (ev: AgentEvent) => Promise<void>;
}): Promise<AgentMessage[] | undefined>;
```

`prepareNextTurn` becomes a thin `compactNow({ force: false, … })` call.
Ladder stderr: "compaction: summary call failed — retrying with a smaller
transcript" → "compaction: summary failed twice — fell back to
rule-based shrink" → (no plan) "compaction failed and no safe shrink is
possible — the next call may exceed the window." The fallback emits
`context_compacted` with the new optional field `degraded: true`.

**types.ts (flagged, additive only).** `context_compacted` event gains
`degraded?: boolean` (optional; all existing consumers unaffected). This
is the only contract touch in the whole spec — flagged per
`docs/03-citation-policy.md` rule 6 / PLAN.md §7.

**Tests.** fake stream failing once → success on retry (assert the retry
prompt is smaller); failing twice → `ruleBasedShrink` invariants (unit
boundaries intact, last user message kept, marker present, result strictly
smaller than input, notice contains file ops); `ruleBasedShrink` pure
tests (short context → undefined; keep plan matches `planCompaction`);
event carries `degraded: true` on the fallback path.

## A2 — Drop thinking blocks from the summarizer transcript

**Problem.** `[Assistant thought]` blocks are the most ephemeral content
and pure summarizer-input waste; the summary needs decisions, not
reasoning traces (Cline's projection policy drops thinking for
compaction).

**Design.** `renderTranscript(messages, opts)` gains
`includeThinking?: boolean`, **default false**. `summarizePrompt` passes
it explicitly. Nothing else changes.

**Tests.** default output contains no thinking text; `includeThinking:
true` restores it (existing tests that assert thinking presence must be
updated to opt in).

## A3 — Tool-result cap in the transcript (fixed shape)

**Problem.** Tool outputs are the biggest token sink and the least
summary-worthy (Anthropic: "once a tool has been called deep in the
message history, why would the agent need to see the raw result again?").
The uniform 1500-char per-message clip is too coarse.

**Design (assessment fixes applied).**

- `renderTranscript` opts gain `toolResultChars?: number`, **default
  2000**. Tool-result blocks keep the EXISTING middle-truncation shape
  (`clip()` — head + tail): a `bash` result's important line is usually
  the tail (final error/exit), a `read` result's is the head
  (imports/structure). Head-only clipping was rejected on C3.
- `summarizePrompt` derives `totalChars` from the model's window instead
  of the fixed 24000: `Math.max(24000, floor(contextWindow / 4))` — the
  folded prefix must fit the window anyway, and A2 frees budget, so the
  summarizer should be allowed to use its full available input (C2).
  `compactContext` passes the window through to `summarizePrompt` (new
  optional param).
- The existing `perMessageChars` clip still applies to user/assistant
  lines.

**Tests.** long tool result → 2000 chars, head AND tail preserved, middle
marker; short result unchanged; `totalChars` scales with the window;
interaction with `perMessageChars`.

## A6 — Manual `/compact` (QOL, kept by explicit decision)

**Design.**

- `compactNow` with `force: true` skips the `shouldCompact` check; the
  plan still must exist (short context → undefined, as today).
- TUI: `SLASH_COMMANDS` gains `{ name: "compact", summary: "manually
  compact the context now (summarize older messages)" }`. Driver
  (`run.tsx`) intercepts `/compact` in BOTH submit paths (the pure state
  machine only gains the registry entry — side effects stay in the driver,
  consistent with `/models`):
  - **busy** → info item "cannot compact while a run is in flight"
    (never a steer).
  - **idle** → new `AbortController` + `compactNow({ force: true, … })`
    with `onEvent` wired through the same `applyEvent` tap as a run; on
    success the driver's `context` updates (the `context_compacted` event
    renders as today). `--no-compact` → info item "compaction disabled".
    Nothing compacted → info item "nothing to compact".
- REPL: `/compact` accepted in the loop (today: "unknown command"), same
  `compactNow`, prints the same `✂` line via the event printer.

**Tests.** `compactNow` with `force: true` (trigger not met → still
compacts); `force` with a too-short context → undefined; TUI registry
test includes `compact`.

---

## Commit plan (one behavior each, in criteria-first order)

1. **A4** — structured summary + `extractFileOps` + FILES section.
2. **A1** — calibrated estimation (compact.ts + main.ts wiring).
3. **D** — failure escalation (retry + `ruleBasedShrink` + `compactNow`
   extraction + types.ts `degraded` field). Depends on A4's
   `extractFileOps`.
4. **A2+A3** — transcript hygiene (one family: "the summarizer sees less
   ephemeral content, more real content").
5. **A6** — manual `/compact` (TUI + REPL).
6. **Docs** — HANDOFF.md, PLAN.md decision log (D12) with prior-art
   citation, README note for `/compact`.

## Open questions

1. **D's `degraded?: boolean`** — RESOLVED 2026-09-29: landed as specified
   (optional field on the `context_compacted` event, `src/types.ts`), commit
   `4595815`.
2. A6 while busy — RESOLVED 2026-09-29: reject, per spec (commit `3d9d76c`).

---

## D26 — Lossless fit policy (the auto trigger never sends an over-budget request if any fold sequence fits)

Problem the earlier rungs left open: the keep plan was a *planning target*, and
`compactNow` applied the first LLM candidate that strictly shrank the context —
even when that candidate still exceeded the request budget, while a deeper fold
(older units, or finally the live prompt) would have fit. The auto trigger could
therefore keep sending requests the provider rejects.

Contract (implemented):

- `planCompaction(context, keepTokens, cpt, opts?)` gained
  `{ preserveLastUser?, shrinkToFit? }`. `shrinkToFit` continues folding the
  OLDEST WHOLE units (never splitting a toolCall/result unit) until the kept
  suffix fits the budget or one unit remains; with `preserveLastUser` on the
  descent stops at the live prompt. Both default off → legacy behavior is
  byte-identical.
- `compactContext({ strictFit })` selects the plan over a descending ladder.
  Two verdicts drive it (audit findings 1+5): the candidate UPPER BOUND
  (kept suffix + summarizer maxTokens + summary wrapper + overhead) — above
  it no accepted response can EVER fit; and the FLOOR (kept suffix + the
  wrapper around an EMPTY summary + overhead) — above it even a zero-token
  summary cannot fit, the only impossibility proof a summary carrier has.
  (a) bound-fits → the legacy plan (live prompt verbatim);
  (b) else bound-fits → the same plan descended to the keep budget;
  (c) else: FIRST measure the cheap carrier compactNow still owns — the real
      rule-based NOTICE on the deepest preserving plan, as-is (the old gate
      bounded it by a hypothetical 512-char notice, proving nothing; the
      actual notice is usually far smaller — audit finding 2). The notice
      fits → the preserving plan is KEPT (the caller's notice rung lands that
      fit with the prompt verbatim). The notice doesn't fit → the prompt-fold
      rung (`preserveLastUser:false, shrinkToFit:true`) is legitimate ONLY if
      it BUYS A FIT: strictly deeper AND a usable summary budget is left over
      its kept tail (headroom = budget − suffix − wrapper − overhead ≥ a
      64-token stub). Its floor busts → the fold runs NOW as the single call
      (the preserving rung is provably hopeless); its floor fits but the
      bound doesn't → attempt the preserving plan first, and if the ACTUAL
      summary demonstrates the bust, the fold is tried next
      (fold-after-demonstration — a failed bound is uncertainty, not proof).
      On the fold rung the call's maxTokens is CAPped at that headroom, so
      an accepted response is sized to actually fit (audit finding 1: the
      old code let the fold emit up to the uncapped summarizer max — twice
      the budget on small windows — then rejected the result, guaranteeing
      the fallback the fold existed to prevent). A fold-attempt stream ERROR
      preserves the candidate in hand (compactNow's notice ladder decides);
      a fold-attempt ABORT is terminal (the user pressed ESC → no candidate).
      The task survives via the summary (the summarizer prompt requires the
      user's goal).
  The result always reports `fitsInputBudget`. On the fold rung the summary's
  whole job is carrying the live task, so the summarizer transcript is
  rendered with `priorityLastUser`: the last user message survives the
  transcript budget first (oldest turns drop, then shrink; the prompt is
  middle-clipped only when it alone exceeds the budget) — the fold never
  summarizes blind.
- `compactNow` owns the application policy: the AUTO trigger runs strict;
  manual `/compact` keeps the legacy best-effort policy (a smaller-than-history
  candidate is applied and flagged `overBudget`). Strict mode prefers a
  fitting candidate always; among non-fitting candidates it retries once with
  a shrunken transcript (skipped when the kept tail + overhead alone makes any
  fit impossible — no call is wasted), then applies the SMALLER non-fitting
  summary flagged `overBudget`. The rule-based notice wins only when it fits
  while the summaries don't. The auto `ruleBasedShrink` rung descends with
  `shrinkToFit: true` so the gate in (c) and the applied candidate agree.
- Token math: everything stays on the calibrated `charsPerToken`; the budget
  is `contextWindow − maxTokens − 1024` everywhere (trigger, plan, validation
  — one formula).

Tests (regression for the three audit repros):

1. *Deeper fold fits where the first candidate did not* — mid-conversation
   atomic tool result over the budget, live prompt small: the ladder descends
   past the huge unit, the applied candidate fits (`overBudget` absent), one
   summarizer call. `compactContext: strict-fit deep fold … (D26 repro 1)`
   and `D26 strict fit: applies a fitting deeper fold instead of the first
   over-budget candidate (repro 1)`.
2. *Prompt fold carries the live task* — the latest prompt is huge and nothing
   preserving fits: the fold rung is selected AND the summarizer transcript
   carries the live prompt head-to-tail (`priorityLastUser`).
   `compactContext: strict-fit may fold a huge latest user prompt …`.
3. *Fitting notice beats an over-budget summary; the fold is provably
   necessary* — the strict-descended suffix fits the ≤512-char notice but not
   an LLM summary: `compactContext` keeps the preserving plan (prompt
   verbatim in `kept`, `fitsInputBudget:false` honestly reported) and
   `compactNow` lands the fitting notice, never the over-budget summary.
   Without the notice-carrier pre-check the fold rung WOULD be selected here
   (its bound fits) and the live prompt would be dropped.
   `D26 strict-fit guard: a prompt fold is NOT selected when the rule-based
   notice still fits a preserving plan (D26)`,
   `D26 strict fit: a fitting rule-based notice beats an over-budget LLM
   candidate (repro 3)`. Plus `D26 strict fit: an irreducible kept tail skips
   the transcript retry and applies the best candidate flagged overBudget`.
   Unit-level support: the two `planCompaction shrinkToFit …` descent tests
   and `renderTranscript priorityLastUser: the live prompt survives the total
   budget`. `scripts/audit-d26-repro.mjs` is a property sweep (168 structured
   cases; the exact compactNow application policy replayed in-script)
   guarding the contract: exit 0 means no applied candidate exceeds the
   budget when any fold sequence fits. `test/cli.test.ts` (WS9 end-to-end on
   the auto path).

### D26 audit follow-up (2026-08-10 review: findings 1, 2, 5)

The first D26 cut still lost fits and burned the fold. Three gaps, three
regressions (`test/compact.test.ts`, "Audit follow-ups to D26"):

1. *The fold emitted over its own fit* — the fold rung let the summarizer run
   to the full cap; an accepted oversized summary was then rejected by the
   final fit check, so the fold lost the live prompt AND still missed the
   budget. Now the fold call's `max_tokens` is the headroom over its kept
   tail (`compactContext: the fold rung caps the summarizer at the headroom
   over its kept tail (finding 1)` — asserts the fold call's model.maxTokens
   equals budget − suffix − wrapper − overhead, 663 not 2048, and that only
   the fold rung is capped; the preserving rungs keep the full summarizer
   cap).
2. *A failed fold attempt sank the preserving candidate* — fold-after-demo
   returned `undefined` when the fold stream errored, discarding the fitting
   or over-but-smaller candidate already in hand (and the notice rung below
   it). An error now preserves it; an abort stays terminal
   (`… a failed prompt-fold attempt does NOT suppress the preserving
   candidate (finding 2)` — candidate survives, honestly `fitsInputBudget:
   false`; `… a user abort during the fold attempt is terminal — no
   candidate (finding 2 edge)` — `{ type: "aborted" }` mid-fold yields
   `undefined`). This needed `summarizeFor` to return "aborted" ahead of
   "failed": an aborted stream sets both flags, and the caller's move depends
   on the cause.
3. *The fold gate bounded by a hypothetical notice, not the real one* — the
   "even the notice can't fit" gate now runs `ruleBasedShrink` and measures
   the actual candidate (probe: 205 chars ≈ 52 tokens for the repro context,
   where the old 512-char bound implied 128); the summary wrapper (~11
   tokens: marker + separator) is included in every bound and floor so a
   "bound-fitting" fold can no longer miss by the wrapper while having
   already dropped the live prompt. Covered by the corrected geometry of the
   finding-2 test (the preserving floor fits, the real notice does NOT fit,
   so the fold is provably in play) plus `D26 strict-fit guard …` and
   `repro 3` from the first cut.
