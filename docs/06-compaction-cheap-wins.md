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
