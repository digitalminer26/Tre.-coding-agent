# Coding Agent — Build Plan & Workstreams

Goal: build a working coding agent (harness ↔ LLM, like pi) in TypeScript, first endpoint =
the local llama.cpp server (OpenAI-compatible chat-completions + tool calling). This plan
divides the work into **independent, contract-first workstreams** that can be run in
parallel (by subagents or people), each with a clear deliverable and exit criteria.

Read `docs/01-walkthrough-harness-llm.md` first — it's the reference behavior. This plan is
*how to get there*.

---

## 0. Decisions (lock these before starting)

| #   | Decision         | Recommendation                                                                      | Why / alternative                                                                                                                                                                                                                                                                          |
|-----|------------------|-------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| D1  | Language/runtime | **LOCKED (2026-09-11): TypeScript + Node ≥ 20 (ESM), tsc, `node --test`**           | pi's source is a ready TS reference impl; same-language patterns are copyable. Python permitted only as a *cold satellite* (offline/batch tools that talk to the agent via session JSONL, e.g. the WS8 eval scorer) — never across the hot streaming path. Revisit the mix as we progress. |
| D2  | First endpoint   | **LOCKED: OpenAI-compatible `chat/completions`**, dev server = TKG `vks-llama`      | You own it, it's testable, it exercises the full wire path incl. tool calling. Add Anthropic native only if a target model demands it.                                                                                                                                                     |
| D3  | MVP toolset      | **LOCKED:** `read`, `write`, `edit`, `bash`                                         | The four pi defaults; everything else is added later.                                                                                                                                                                                                                                      |
| D4  | Sandbox          | **LOCKED: none for MVP** (`bash` + file mutators gated by approval, WS7)            | Keeps MVP small; safety is its own workstream (WS7).                                                                                                                                                                                                                                       |
| D5  | UI               | **LOCKED: plain CLI first** (print streaming events, read stdin). Ink TUI deferred. | The event vocabulary *is* the UI API; don't couple a fancy TUI to an unproven loop.                                                                                                                                                                                                        |
| D6  | Model for dev    | **LOCKED:** TKG-pinned `Qwen3.8-27B-UD-Q4_K_M` (ctx 131k)                           | Fast iteration, no cost, mirrors production. Keep an OpenAI/Anthropic key as a quality bar for evals.                                                                                                                                                                                      |

> These are the only blocking decisions. Everything below proceeds once D1–D5 are set.

## 1. Architecture & module map

One repo, mirroring pi's four layers but collapsed to a single package with clear internal
boundaries. The **boundary between modules is a TypeScript interface** — that's what makes
parallel work safe.

```
coding-agent/
├─ src/
│  ├─ types.ts            # WS0: AgentMessage union, ToolCall, ToolResult, Usage,
│  │                      #      StopReason, AgentEvent (start/text_*/thinking_*/
│  │                      #      toolcall_*/done/error), Tool interface, StreamFn type
│  ├─ config/
│  │  └─ models.ts        # WS0/WS1: model catalog + per-model compat descriptor
│  ├─ wire/
│  │  ├─ openai-completions.ts   # WS1: buildParams, convertMessages, SSE parse → events
│  │  └─ http.ts                 # WS1: fetch + retry + abort
│  ├─ loop/
│  │  └─ agent-loop.ts    # WS2: runLoop — stream, dispatch tools, feed back, steering
│  ├─ tools/
│  │  ├─ registry.ts      # WS3: tool registry, schema gen, execute pipeline
│  │  ├─ truncate.ts      # WS3: 2000-line / 50KB head & tail truncation
│  │  ├─ read.ts write.ts edit.ts bash.ts   # WS3
│  │  ├─ safety.ts        # WS7: beforeToolCall approval gate, path sandbox
│  │  └─ sandbox.ts       # WS11: Seatbelt (macOS) kernel sandbox for the bash child
│  ├─ prompt/
│  │  └─ system-prompt.ts # WS4: base + tools + guidelines + project ctx + skills index + cwd
│  │  └─ skills.ts        # WS4: skills index (name+desc), on-demand body
│  ├─ session/
│  │  └─ session.ts       # WS5: JSONL append + replay + resume
│  ├─ cli/
│  │  └─ main.ts          # WS6: wires it together, prints events, reads stdin
│  └─ index.ts            # public API
├─ test/
│  ├─ mock-sse.ts         # WS8: fake SSE server (deterministic loop tests)
│  └─ *.test.ts
├─ docs/
│  ├─ 01-walkthrough-harness-llm.md  # reference behavior (pi, source-verified)
│  ├─ 02-contracts.md                # WS0 contract spec + change protocol
│  └─ 03-citation-policy.md          # L1/L2/L3 citation rules for pi-derived code
├─ THIRD_PARTY.md        # aggregate citation table + MIT license text
└─ models.json           # local model registry (baseUrl, id, maxTokens, compat)
```

**The three contracts that decouple the workstreams** (defined in WS0, everyone codes
against them):

1. `StreamFn = (model, llmContext, opts) => AsyncIterable<AgentEvent>` — the loop's only
   dependency on the wire layer.
2. `Tool = { name; description; parameters; execute(id, args, signal, onUpdate) }` — the
   loop's only dependency on tools.
3. `AgentMessage` union + `AgentEvent` vocabulary — the shared language of loop, wire,
   session, and UI.

Get these three right and reviewed before parallel work starts. Everything else is
filling in behind a stable interface.

## 2. Workstreams

Legend: **deps** = what it needs; **parallel** = who it can run alongside; **owner** =
suggested subagent type (see §5); **size** = rough effort.

### WS0 — Contracts & scaffold *(blocking, do first)*
- **Purpose:** stand up the repo (tsconfig, ESM, test runner, `models.json`) and author
  `types.ts` with the three contracts above + the model-catalog descriptor shape.
- **Deliverable:** compiling skeleton + `types.ts` + a `README` of the contracts.
- **Exit criteria:** `tsc` passes; a 20-line fake `StreamFn` and a fake `Tool` both type-check
  against the interfaces; contract reviewed.
- **deps:** D1–D5.  **parallel:** — (it's the gate).  **owner:** `worker`.  **size:** S.

### WS1 — Wire layer (provider client)
- **Purpose:** `stream()` for OpenAI-compatible endpoints. `buildParams` (messages→wire,
  tools→JSON-schema, `stream:true`, `stream_options.include_usage`, per-model compat), SSE
  parser → normalized `AgentEvent`s, tool-call arg accumulation + JSON salvage parse, usage
  capture, retry + `AbortSignal`.
- **Deliverable:** `wire/openai-completions.ts` + `wire/http.ts` + `config/models.ts`.
- **Exit criteria:** against the **mock SSE server** (WS8) it yields the exact event
  sequence for a text reply and a multi-tool-call reply; against the **live llama.cpp**
  endpoint it streams a real model's tokens and a real tool call, end to end.
- **deps:** WS0 (types, `StreamFn`).  **parallel:** WS3, WS4, WS5, WS2, WS8.  **owner:**
  `worker`.  **size:** M.
- **Watch-outs:** assistant `content` is a *string* (not array); tool-call `arguments` is a
  JSON *string*; empty assistant messages skipped; tool-call-id normalization; `length`
  finish-reason surfaced faithfully.

### WS2 — Core loop
- **Purpose:** `runLoop`. Consume `StreamFn`, maintain context, extract tool calls, dispatch
  (parallel by default, per-tool sequential opt-out), append `toolResult` messages, handle
  the `length`→fail-all-calls guard, batch `terminate`, error/abort. Steering/follow-up =
  optional later (leave a hook, don't implement the UI for it).
- **Deliverable:** `loop/agent-loop.ts`.
- **Exit criteria:** with the **mock `StreamFn`** (a scripted fake, no network) it runs a full
  multi-turn: user → assistant(toolcall) → toolresult → assistant(text) → stop, and it stops
  cleanly on `error`/`aborted`/`length`. A unit test asserts the exact `AgentMessage[]` it
  produces.
- **deps:** WS0 (types). Only needs WS1's *interface*, not its body → **can start the moment
  WS0 lands.**  **parallel:** WS1, WS3, WS4, WS5, WS8.  **owner:** `worker`.  **size:** M.
- **Watch-outs:** replace the *same* context slot as the partial streams; never throw out of
  the loop (errors become messages); results appended in call order.

### WS3 — Tool system
- **Purpose:** registry + schema gen + execute pipeline (validate → `beforeToolCall` →
  execute(signal, onUpdate) → `afterToolCall` → result), error-as-`isError`-result, the
  2000-line/50KB truncation (head for `read`, tail for `bash`, temp-file recovery path),
  parallel/sequential dispatch support. Build `read`, `write`, `edit`, `bash`.
- **Deliverable:** `tools/*`.
- **Exit criteria:** each tool unit-tested against a temp dir; `edit`'s exact-match
  semantics (unique `oldText`, no overlap) tested incl. the failure paths; a too-long `bash`
  output truncates to ≤ limits and reports the full-output path; an unknown tool returns an
  error result, not a throw.
- **deps:** WS0 (Tool interface).  **parallel:** WS1, WS2, WS4, WS5, WS8.  **owner:**
  `worker`.  **size:** M–L (4 tools + framework).
- **Watch-outs:** `edit` must match the *original* file, not incrementally; `bash` tail
  truncation never splits lines; all tools honor `signal.aborted`.

### WS4 — System prompt & skills
- **Purpose:** `buildSystemPrompt` (base + per-tool one-liners + derived guidelines +
  project-context files + skills *index* + cwd) and the skills loader (index in prompt, body
  read on demand via `read`).
- **Deliverable:** `prompt/system-prompt.ts`, `prompt/skills.ts`.
- **Exit criteria:** given a fixture of enabled tools + a project context file + a skills
  dir, it produces a deterministic prompt; a test asserts skills appear as name+description
  only (no bodies) and that guidelines are derived from the tool set.
- **deps:** WS0.  **parallel:** everything.  **owner:** `researcher`/`worker`.  **size:** S.

### WS5 — Session persistence
- **Purpose:** JSONL append-only session (header, messages, modelChange, compaction entry
  slot) + replay/resume. Compaction itself is deferred (WS9) but the entry type and the
  "rebuild context honoring a compaction boundary" seam are defined now.
- **Deliverable:** `session/session.ts`.
- **Exit criteria:** append N messages → kill → replay → identical `AgentMessage[]`; resume
  continues a loop from the replayed context.
- **deps:** WS0.  **parallel:** everything.  **owner:** `worker`.  **size:** S.

### WS6 — CLI / integration
- **Purpose:** `main.ts` — load `models.json`, build prompt (WS4), register tools (WS3),
  construct the real `StreamFn` (WS1), run the loop (WS2), print events (streaming text,
  tool-call lines, tool results), read stdin, persist via WS5. This is the **integration
  seam** — the first place all modules meet.
- **Deliverable:** runnable `coding-agent` CLI.
- **Exit criteria:** the §4 vertical-slice scenarios all pass against live llama.cpp.
- **deps:** WS1+WS2+WS3+WS4+WS5 (real bodies). **Starts after the parallel batch; it's
  short because everything behind it was interface-tested already.**  **owner:** `worker`.
  **size:** S–M.

### WS7 — Safety & permissions
- **Purpose:** `beforeToolCall` approval gate (prompt the human before `bash`/`write`/`edit`
  when not `--yes`), path sandbox (confine `read`/`write`/`edit` to the project root by
  default), destructive-action confirmation. Later: VM sandbox.
- **Deliverable:** `tools/safety.ts` + CLI flags.
- **Exit criteria:** with approval off, a `bash` call is blocked and the block reason is fed
  back to the model as an error result; a `write` outside the root is refused.
- **deps:** WS3 (the hook it plugs into).  **parallel:** after WS3.  **owner:** `worker`.
  **size:** S.

### WS8 — Test & eval harness
- **Purpose:** (a) **mock SSE server** that replays canned SSE streams (text-only,
  multi-tool-call, truncation/`length`, error) — this is what makes WS1/WS2 testable with no
  network; (b) a **mock `StreamFn`** (scripted, in-process) for pure loop tests; (c) an eval
  script that runs a small set of tasks (e.g. "create a file", "fix this typo", "run a
  command and report exit code") against a chosen model and scores tool-call correctness.
- **Deliverable:** `test/mock-sse.ts`, `test/fake-stream.ts`, `test/eval.ts`.
- **Exit criteria:** WS1 and WS2's exit criteria are *expressed as tests using these mocks*;
  eval runs a 3-task suite and prints pass/fail per task.
- **deps:** WS0 (types). Buildable **in parallel with WS1** — it's a precondition for
  testing the wire layer.  **owner:** `worker`/`researcher`.  **size:** S–M.

### WS9 — Context management (compaction) — *DONE 2026-09-12 (D10)*
- Auto-compaction (trigger `last usage + maxTokens + slack > window`, keep-recent by
  estimated tokens snapped to unit boundaries, structured summary via one silent LLM
  call, never split a tool call from its results, iterative summaries that fold a
  previous summary). Wired through the loop's `prepareNextTurn` hook in the CLI;
  sessions persist a `compaction` entry (WS5's seam) so a resumed run sees
  [summary, …kept]. Failure of the summary call skips compaction (I3). CLI flags:
  `--no-compact`, `--compact-keep <n>`. **owner:** `worker`. **size:** M.

### WS10 — TUI (Ink) — *DONE 2026-09-12 (D11)*
- Streaming render, tool-call display, diff view, keybindings. Consumes the same
  `AgentEvent` stream the CLI already prints (D11: the TUI is a renderer of a pure
  `TuiState` folded by `applyEvent`; key handling is a small pure function set;
  the Ink layer is presentational). `coding-agent tui` subcommand; the REPL keeps
  working as `plain`. Edit diff = LCS over lines with `+`/`-`/context coloring
  (splitlines semantics, 500-line guard). Keybindings: enter=send, ↑/↓=prompt
  history, ctrl+c=abort-run/exit-130, y/n/esc=approval answer (D8 flow intact),
  `/quit` exit. Ink does not split `\r` in multi-char chunks (paste semantics) —
  the App splits prompt+Enter chunks itself. **owner:** `worker`. **size:** L.

### WS11 — bash kernel sandbox (macOS Seatbelt) — *DONE 2026-09-13 (D12); policy rewritten 2026-09-18*
- The bash tool runs arbitrary shell code; WS7's path sandbox covers only the file
  tools. WS11 confines the bash CHILD at the kernel level via `sandbox-exec`: a
  generated Seatbelt ALLOWLIST-BY-ENUMERATION policy (rewritten 2026-09-18 after
  s10's canary exposed the old denylist's /tmp hole — a canary outside the
  workspace but under /tmp was readable via bash). Reads AND writes are denied
  for /private (the resolved path of /tmp, /var, /etc — the kernel checks data
  access on the RESOLVED path), /Users, /Volumes, /Network, /cores, /dev, the
  Keychains + Preboot + /System/Volumes/Data/home surfaces, and by NODE deny
  (literal) /etc + /home (a subpath deny of a symlinked top is FATAL for a
  workspace under it — no re-allow survives); the workspace (REAL path),
  /private/var/folders (per-user temp) and /dev/null|stdout|stderr are
  RE-ALLOWED LAST (last matching rule wins). /usr, /bin, /sbin, /System,
  /Library stay readable so exec/dyld work. The sandboxed child runs /bin/bash
  (/bin/sh's cd is ENOTDIR under deny policies). Residual: `ls /tmp` / `ls /var`
  leak top-level names only. The policy file is a 0600 file in a random dir
  under the OS temp dir (sandbox-exec reads it before applying the profile);
  removed on command close. darwin only; elsewhere the bash tool runs
  unsandboxed (approval gate + destructive classifier still apply). Opt out:
  `--no-sandbox`. **owner:** `worker`. **size:** M.

## 3. Dependency graph

```
                ┌─────────────────────────── D1..D5 decisions ───────────────────────────┐
                └───────────────────────────────────┬─────────────────────────────────────┘
                                                    ▼
                                              ┌──────────┐
                                              │   WS0    │  contracts + scaffold (GATE)
                                              └────┬─────┘
      ┌───────────────┬───────────────┬────────────┼───────────────┬───────────────┐
      ▼               ▼               ▼            ▼               ▼               ▼
 ┌─────────┐    ┌─────────┐    ┌─────────┐   ┌─────────┐     ┌─────────┐   ┌─────────┐
 │  WS1    │    │  WS2    │    │  WS3    │   │  WS4    │     │  WS5    │   │  WS8    │
 │ wire    │    │ loop    │    │ tools   │   │ prompt  │     │ session │   │ tests   │
 └────┬────┘    └────┬────┘    └────┬────┘   └────┬────┘     └────┬────┘   └────┬────┘
      │   (WS2 needs only WS1's StreamFn *interface*, not its body)
      │               │               │            │               │             │
      └───────────────┴───────┬───────┴────────────┘               │             │
                              ▼                                    │             │
                       ┌───────────┐                               │             │
                       │   WS6     │  CLI / integration (all real bodies)      │
                       │  glue     │◄──────────────────────────────┘─────────────┘
                       └─────┬─────┘
                             ▼
                       ┌───────────┐   (WS7 plugs into WS3's hook; can run alongside WS6)
                       │   WS7     │
                       │  safety   │
                       └─────┬─────┘
                             ▼
                 Phase 3:  WS9 compaction · WS10 TUI
```

## 4. Build order & vertical slice

**Phase A — Gate (WS0).** One focused session. Do not start parallel work until the three
contracts compile and are reviewed.

**Phase B — Parallel batch (WS1, WS2, WS3, WS4, WS5, WS8).** All run concurrently against
the WS0 contracts + WS8 mocks. No network needed except WS1's final live-endpoint check.

**Phase C — Integrate (WS6 → WS7).** Short, because each module was already interface-tested.

**Vertical slice — first runnable thing (do this inside Phase C, before safety/TUI):**
1. `agent run "say hello"` → prompt built, one LLM call, streamed text printed. *(proves
   wire + loop + CLI with zero tools)*
2. Enable `bash` only → `agent run "list files in cwd"` → real tool call round-trip.
3. Enable `read`/`write`/`edit` → `agent run "create hello.txt with 'hi' and read it back"`.

At step 3 you have a real coding agent. Everything after is hardening.

## 5. Parallel execution plan (who runs what)

| Wave | Concurrent workstreams            | Notes                                                                            |
|------|-----------------------------------|----------------------------------------------------------------------------------|
| A    | WS0                               | single; gate                                                                     |
| B    | WS1 · WS2 · WS3 · WS4 · WS5 · WS8 | six independent streams; WS2 uses WS8's fake `StreamFn`, WS1 uses WS8's mock SSE |
| C    | WS6, then WS7                     | sequential (integration, then safety)                                            |
| D    | WS9, WS10                         | only after C is green                                                            |

Within Wave B, each workstream is sized for one focused subagent session. Suggested
owner mapping: `worker` for WS1/WS2/WS3/WS5/WS6/WS7, `researcher` for WS4/WS8 (WS8's eval
scoring may want a second opinion), `reviewer` to gate each workstream's exit criteria
before it merges.

## 6. Per-workstream "definition of done" checklist (use as merge gate)

- [ ] Type-checks against WS0 contracts with **no** changes to other modules.
- [ ] Exit-criteria test(s) exist and pass (unit +, where applicable, mock-integration).
- [ ] No exceptions cross the module boundary — failures become data (messages/results).
- [ ] Honors `AbortSignal` end to end.
- [ ] `reviewer` subagent has signed off on the diff.
- [ ] Citations per `docs/03-citation-policy.md` (L1/L2 headers present; `THIRD_PARTY.md` row added in the same commit).
- [ ] File-history snapshot taken before any edit to shared files.

## 7. Risks & mitigations

| Risk                                                           | Likelihood | Mitigation                                                                                                                                                        |
|----------------------------------------------------------------|------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Local model's tool calling is flaky (malformed/truncated JSON) | **High**   | WS8 eval suite gates model choice; the `length`→fail-all guard + JSON salvage (WS1/WS2) make bad calls non-destructive; keep an API model as the quality bar.     |
| Contract churn after parallel work starts                      | Med        | WS0 is explicitly the gate; any contract change is a *broadcast* — all of Wave B re-checks. Keep WS0 small and reviewed hard.                                     |
| SSE parser edge cases across endpoints                         | Med        | Mock SSE (WS8) encodes the tricky cases (split frames, multi-tool, `length`, error) as fixtures; live llama.cpp check is the final gate, not the unit-test basis. |
| Scope creep into TUI/compaction early                          | Med        | They're Phase 3 by design; the CLI prints the same event stream the TUI would render, so nothing is lost by deferring.                                            |
| Running `bash` unsandboxed on a live box                       | Med        | WS7 approval gate is the gate to "daily use"; until then run with `--yes` off by default.                                                                         |

## 8. Out of scope (MVP)

Anthropic-native wire, image inputs, subagents, branch/tree navigation, themes/keybindings,
VM sandboxing, multi-model routing, OAuth/expiring-token handling. All have seams reserved
in the contracts; none block the MVP.

## 9. Decision log

| Date       | Decision            | Ruling                                                                                                                                                                                                                                           |
|------------|---------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 2026-09-11 | D1 Language/runtime | TypeScript + Node ≥ 20 (ESM), tsc, `node --test` (no bundler, no Jest/Vitest). Python allowed only for cold/offline tools (boundary = session JSONL / one-shot stdio), starting candidate: the WS8 eval scorer. Revisit as the build progresses. |
| 2026-09-11 | D2 First endpoint   | OpenAI-compatible `chat/completions`; dev/test server = TKG `vks-llama`. Unit tests run against the mock SSE server (WS8); the live endpoint is the final integration gate, never the unit-test basis.                                           |
| 2026-09-11 | D3 MVP toolset      | `read`, `write`, `edit`, `bash`.                                                                                                                                                                                                                 |
| 2026-09-11 | D4 Sandbox          | None for MVP. `bash` and file mutators sit behind the WS7 approval gate; approval is OFF by default (`--yes` to bypass).                                                                                                                         |
| 2026-09-11 | D5 UI               | Plain CLI first: prints the `AgentEvent` stream, reads stdin. Ink TUI deferred to WS10.                                                                                                                                                          |
| 2026-09-11 | D6 Model for dev    | TKG-pinned `Qwen3.8-27B-UD-Q4_K_M` (ctx 131k). Hosted API key reserved as the eval-suite quality bar only.                                                                                                                                       |
| 2026-09-12 | D7 `ToolResult.isError` | Contract extension (WS3): `ToolResult` gains `isError?: boolean`. The tool pipeline reports failures in-band (invalid args, hook-block, tool error) and the loop marks the `ToolResultMessage.isError` from it — matching the contract doc's "the loop marks the message `isError`". Exceptions out of `executeToolCall` remain tolerated by the loop and are still marked isError (I3 safety net for broken tools). |
| 2026-09-12 | D8 Destructive confirmation | WS7: even with `--yes`, bash commands matching destructive patterns (recursive `rm`, `git push -f/--force/--force-with-lease`, `dd`/redirection to raw devices, `mkfs*`, fork bombs, `shutdown`/`reboot`/`halt`/`poweroff`) require an explicit human confirm. Rationale: `--yes` is convenience for "let the agent work in my project", not a standing permission to destroy the machine. Patterns are deliberately over-triggering (false positive = one extra prompt; false negative = a lost machine). Deliberately NOT listed: "dangerous but not destructive" (curl\|sh, sudo, exfiltration) — the approval gate covers those whenever `--yes` is off. WS7 also refines D4's default: approval is ON by default (mode `ask`; anything but y denies) with `--yes` (auto-approve) and `--no-approve` (fail-closed, never prompt) as the two opt-outs. |
| 2026-09-12 | D9 Eval scoring semantics | WS8 residual: the eval runner (`npm run eval`, `test/eval-run.ts`) scores each task in a single turn — the FIRST tool call of the first assistant message. Args match via `argsSubset` (deep-equal) plus the new `argsContains` (substring for open-ended string args, e.g. the model baking an exit-code report into the command itself). Rationale: an eval that fails a task because the model did *more* than the minimum is mismeasurement; an eval that passes a wrong first call (read before edit) is leniency. Live baseline 2026-09-12: 3/3 PASS on Qwen3.8-27B-UD-Q4_K_M; the 27B is run-to-run variable, so the eval is a regression baseline, not a gate. |
| 2026-09-12 | D10 Compaction semantics | WS9: auto-compaction runs BETWEEN LLM turns (the loop's `prepareNextTurn`), in the CLI, only when a session exists. Trigger: last assistant usage `totalTokens + maxTokens + 1024 slack > contextWindow` (usage = real prompt+completion ≈ next prompt size). Keep: the recent tail up to ~8192 ESTIMATED tokens (chars/4), snapped to unit boundaries (an assistant toolCall is never split from its ToolResultMessages) and always including the most recent user message. Summary: ONE silent LLM call (no tools, events not surfaced) producing a structured user message `[Compaction summary of earlier context]`; if the context already starts with a summary, the prompt folds it in (iterative). The session gets a `compaction` entry (`firstKeptEntryId` = the kept tail's first message entry), so replay reproduces [summary, …kept] exactly — that is why the CLI persists messages INCREMENTALLY (on `done`/`tool_execution_end`) and tracks message→entry-id. Failure (stream error / empty text) skips compaction for that turn — the run continues uncompacted (I3). UI: a `context_compacted` AgentEvent (CLI-emitted) + a `✂` line on stderr. Off: `--no-compact`. Live-verified 2026-09-12 (27B): two consecutive compactions in one run, summary captured a seeded fact verbatim. |
| 2026-09-12 | D11 TUI architecture | WS10: the TUI consumes the SAME `AgentEvent` stream the plain CLI prints — no parallel event path. Layering: (1) pure state machine `src/tui/state.ts` (`applyEvent` folds one event into a `TuiState`: items[], input line, prompt history, busy, turn, pending approval; input key handling is small pure functions — char/backspace/history/submit/approval-answer), (2) pure diff renderer `src/tui/diff.ts` (LCS over lines; `+`/`-`/context; splitlines semantics — a trailing newline is not a phantom line; 500-line guard), (3) presentational Ink app `src/tui/app.tsx` (holds NO agent logic; every key maps to a callback; the keybinding table is the ONLY place keys become intents), (4) driver `src/tui/run.tsx` (owns the Ink instance, runs one `runTurn` per submitted prompt — session persistence, compaction, safety hooks all identical to the REPL — with `tap` feeding events into the state machine; TUI sinks are no-ops: it renders the stream, it does not print it). Approval (D8): the safety ask blocks on a promise the TUI resolves on y/n/esc while locking input. Ctrl+c: abort the run when busy (same semantics as the REPL), exit 130 when idle. `/quit` = 0. Why: the testable surface (state + diff) has zero Ink/React imports; Ink quirks (e.g. `\r` inside multi-char chunks arrives as ONE paste-style string) are quarantined in one handler. Live-verified 2026-09-12 (27B): prompt→write→approve→file created; edit diff rendered `- x = 1`/`+ x = 2` under the edit call. |
| 2026-09-13 | D12 bash kernel sandbox | WS11: the bash child runs under a macOS Seatbelt profile (sandbox-exec) with a GENERATED denylist — reads denied for /etc, /private/etc, /var/root, /private/var/root, /private/var/db, /cores, /Library/Keychains, /System/Volumes/Preboot, /Users; writes denied for /etc, /private/etc, /usr, /bin, /sbin, /System, /Library, /var/root, /private/var/root, /cores, /dev, /Users; then the workspace is re-allowed (both) and /dev/null, /dev/stdout, /dev/stderr for writes. Rationale (empirical, macOS 15 Apple Silicon): (a) DENYLIST, not allowlist — a catchall `file-read-data` deny (path-regex `^/` or `subpath /`) plus re-allowing system prefixes makes the exec'd process SIGABRT even when the exec target IS allowed (the kernel/dyld interaction on this OS version is opaque; targeted denies have no such problem). (b) LAST matching rule wins — a later `allow` re-allows a denied path (verified; this is the workspace escape hatch from the /Users deny). (c) the kernel resolves symlinks BEFORE the MAC check, so /etc and /private/etc are both denied. (d) `file-read*` (not just -data) denies metadata too — `ls /etc` fails, hiding existence. (e) profiles propagate across fork/exec — the shell's children are confined. sandbox-exec location is RESOLVED (/usr/bin vs /usr/sbin — non-standard system trees exist; stock macOS is /usr/sbin). The policy file (0600, random name under the OS temp dir) is read by sandbox-exec BEFORE the profile applies, so it need not be readable under the policy; removed on command close. darwin only; --no-sandbox opts out. Known v1 boundary: /var/folders + /opt stay accessible (runtime temp/tool dirs); commands needing ~/.ssh etc. (git push over ssh) fail under the sandbox by design — run with --no-sandbox for system maintenance. Triggered by e2e s10 (sandbox-escape-block): the read tool was blocked but the model's bash fallback leaked /etc/passwd. Live-verified 2026-09-13: unit OS probe (kernel-level, offline) + tool-level smoke (workspace works, /etc read+write denied, grandchildren confined) + e2e full7. |
| 2026-09-14 | D13 Workspace-scoped approval (`local` mode, new default) | WS7 refinement of D8's default: the default approval mode is `local` — gated calls scoped to the workspace auto-approve; the human is prompted only when a bash command references a path OUTSIDE the safe locations (workspace + the system surfaces the D12 Seatbelt policy already allows: /usr /bin /sbin /System /Library /opt, /tmp + per-user temp, /dev fakes) or matches a destructive pattern (D8 — now enforced in EVERY mode, including local). Mechanism: a quote-aware static scan of the command string (`bashOutsidePaths`) — tokens that look like paths (leading /, ~, ., $, flag `=`, bare `/`) are resolved ($HOME/$PWD/$TMPDIR, ~, cwd-relative) and checked against the safe prefixes; unresolvable $VAR paths and exotic spellings fail toward the prompt (a prompt, never a silent pass). write/edit auto-approve in local mode because the path sandbox (WS7) already proves they cannot leave the root. Rationale: per-call prompts on every `ls` are the dominant cost of interactive use; the user's rule is "outside the safe locations → my explicit confirmation", and the D12 kernel sandbox remains the security boundary (the scanner is a prompt heuristic, not the boundary — it does not see network operations or dynamically built paths). Flags: `--local` (explicit default), `--ask` (pre-D13 prompt-per-call), `--yes`, `--no-approve` — mutually exclusive. 2026-09-14: unit suite green (246 pass), smoke-verified (workspace + /usr + /tmp quiet; /etc, ~, $VAR prompt with the outside path named; `rm -rf build` still confirms in-workspace; denial → block). || 2026-09-29 | D14 WS9 compaction hardening (A1–A6, D) | Refinement of D10 (auto-compaction semantics unchanged: between-turns, session-gated, keep-tail + silent single summarizer call). Four fixes: (A1) the chars/4 token estimate is calibrated from real usage — `calibrateCharsPerToken(usage, context, systemChars)` = `4 × estimated / actual`, clamped [1,4] (the estimate errs only by density; clamping keeps one noisy usage from corrupting the budget); one `cpt` per session lifetime, `compactContext(charsPerToken?)` so the keep window and post-compaction budget are honest for dense content. (A2+A3) transcript hygiene: the summarizer no longer sees thinking blocks (default off, opt-in) and each tool result gets a 2000-char middle-truncation clip; the total transcript budget scales with the model window — `max(24k, contextWindow/4)` instead of fixed 24k. (D) failure escalation: a failed summary call retries once with a shrunken transcript, then falls back to a rule-based shrink (no LLM — keep the recent tail, drop the oldest, placeholder summary) so the context still fits; the event carries `degraded: true` and the ✂ line says so; `prepareNextTurn`'s inline logic moved into a shared `compactNow` (the manual seam). (A6) manual `/compact`: TUI (intercepted before generic slash dispatch — busy → rejected info item, idle → silent `manualCompact` through `compactNow`, no turn) and REPL (`--no-compact` → disabled note; nothing to fold → "nothing to compact"); the TUI slash registry gains `compact`; `main()` gained an injectable REPL `stdin` (`MainDeps.stdin`) so multiple REPL tests can run in one process (the shared `process.stdin` can only be pushed-to once — EOF). 2026-09-29: unit suite green (484 pass / 0 fail / 9 skipped). |
| 2026-09-29 | D22 Durable extra roots (`tre.json`, C36) | C35's extra roots were flag-only (`--extra-root`, re-passed every launch); the user wanted the writable directory to be DURABLE as part of the feature (the spec's §6 deferred "a future `tre.json`"). Ruling: a new config file `tre.json` with a single field `extraRoots` (array of dir strings) is the durable baseline. Lookup mirrors D19's models.json convention (walk UP from the launch dir for a `tre.json`, then fall back to `~/.tre/tre.json`). Precedence: the CLI flag APPENDS to the config (tre.json = durable baseline, `--extra-root` = per-launch addition); both are validated. Fail-closed guard: every `tre.json` entry is validated at startup EXACTLY like a `--extra-root` value (`validateExtraRoot` — exists, non-sensitive, under home); a malformed file (bad JSON, non-array `extraRoots`, non-string/empty entry) or a refused entry REFUSES the startup (exit 2) — never a silent ignore. A missing `tre.json` = the flag-only C35 behavior. New module `src/config/tre-config.ts` (parse/load/find, mirroring `models.ts`); `main()` resolves the config before the C35 validation loop and appends the flag entries after. `tre.json` is the first durable config surface; `extraRoots` is its first (additive) field. 2026-09-29: unit suite green (498 pass / 0 fail / 9 skipped; +14 new in `test/tre-config.test.ts`). |
