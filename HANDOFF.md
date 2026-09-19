# HANDOFF — self-improve readiness (D17), on top of D16 (2026-09-19)

## D17 — self-improve readiness — DONE (baseline committed + tagged; skill + guardrail hook live; e2e s14 menu-aware and live-passing)

Goal: make it safe to run `coding-agent tui` INSIDE this repo and let it
improve itself. Assessment: possible — full toolset + red-teamed kernel
sandbox + a network-free verification loop (`npm test`, 276 tests) +
sessions/resume + git. A running process is immune to its own on-disk edits
(Node doesn't hot-reload); only the NEXT launch is affected.

What was set up (all committed on top of the D12–D16 baseline):

1. **Baseline commit + tag**: `95347ed` "D12-D16 …", tag
   `known-good-2026-09-19`. Clean tree. `dist/` is gitignored, so recovery
   from a broken build = `git checkout .` (sources) + `npm run build` —
   the tag is the named safe harbor.
2. **`.gitignore`**: added `.history/` (pi file-history snapshots — local
   safety net, not repo content) and `context-fold/` (pi byproduct).
3. **The self-improve skill**: `.pi/skills/self-improve/SKILL.md` — loads
   by default (project skills dir is `<cwd>/.pi/skills`, no flag needed).
   Encodes the mechanical protocol: clean-tree check → ONE increment →
   `npm run build` → `npm test` → commit → HANDOFF.md → repeat; failure
   recovery (`git checkout .` after 2 failed attempts, never leave a broken
   build); the guardrail zone; a PTY-capture recipe for TUI verification;
   turn-budget/session handoff rules; definition of done.
4. **Hard guardrail hook**: `scripts/guardrail-check.sh` (sh, no deps) +
   `scripts/git-hooks/pre-commit`, wired via `git config core.hooksPath
   scripts/git-hooks` (repo-local config — a fresh clone must run that
   command once; noted in the hook header). REJECTS any commit touching:
   `src/tools/sandbox.ts`, `src/tools/safety.ts`, `src/tools/bash.ts`,
   `scripts/guardrail-check.sh`, `scripts/git-hooks/*`,
   `.pi/skills/self-improve/SKILL.md`. Human override: `GUARDRAIL_BYPASS=1
   git commit`. Verified both ways (reject + bypass + normal commit pass).
5. **e2e `scenario_14` menu-aware + LIVE VERIFIED**: the D16 note below
   claiming it was unaffected was WRONG — the feeder types `/quit` (a
   registered command), so the LAST frame has the menu open between the
   hint and the top separator. The anchor now skips up to 5 menu lines
   (`"> /…"` or `"  /…"`) after the hint. Re-run `bash test/e2e.sh 14 14`:
   PASS against the live 27B (radeon).

**First recursive run (pilot, supervised)** — scoped, test-gated tasks, in
suggested order:
   a. tab-completes-first (shift-tab or plain tab completes the selected
      menu candidate instead of inserting a space — see D16 candidates)
   b. per-argument completion: `/display-bottom ` → field names (relax the
      "space hides the menu" rule for a known command's args)
   c. new bottom fields: `provider`, `sandbox` (on/off), per-turn tokens
      (registry entry + `bottomValue` case + label plumbing in run.tsx/main.ts)
   d. `npm run lint`-style quality gate (eslint or a minimal script) wired
      into `npm test` to stop style drift over many agent commits

Model note: the harness is model-agnostic (`models.json` → any
OpenAI-compatible endpoint). Currently served by Qwen3.8-27B Q4 (radeon
`172.30.70.13:8080`) — fine for (a)–(c); point at a stronger endpoint for
anything cross-cutting.

## D16 — `/` completion menu — DONE (unit 276/276 pass, 0 fail; live PTY verified: `/` → menu, ↓↓ → `/quit`, enter completes, enter exits)

User request: while more slash commands/settings are coming, typing `/` must
show GREY candidate options filtered by what's typed; nothing typed → all
commands alphabetical; arrow keys navigate.

Behavior (all pure in `src/tui/state.ts`, D16 block):

- **Registry**: `SLASH_COMMANDS: {name, summary}[]` — single source of truth.
  Adding a command = one entry here (+ its dispatch in run.tsx). Currently:
  `display-bottom`, `exit`, `quit`.
- **Visibility**: only for a BARE command word — input starts with `/` and
  contains NO space (a space = arguments → menu hides; this also hides it
  after completion, which leaves `/cmd ` with a trailing space). Hidden
  while an approval is pending.
- **Filtering**: the word's stem prefix-filters the registry; alphabetical;
  `/` alone → all commands. Capped at `MENU_MAX_LINES = 5`.
- **Render**: grey (dim) lines BETWEEN the hint and the top separator —
  `> /name — summary` (selected, non-dim) / `  /name — summary` (dim).
  Steals budget from the item area exactly like the approval line: `fitItems`
  now takes `extraLines: number` (was `hasApproval: boolean`); app.tsx passes
  `(approval?1:0) + menu.length`.
- **Keys** (run.tsx): ↑/↓ → `menuNav` (wrap-around; falls through to history
  when the menu is hidden); enter → `menuComplete` FIRST — if the typed word
  ≠ the selected candidate it completes the input to `/cmd ` (a second enter
  submits); exact match → normal submit path. The busy-`/quit` escape was
  changed to compare `state.input.trim()` (completion leaves a trailing space).

Files:

- `src/tui/state.ts` — `TuiState.suggestIdx`; `fitItems(..., extraLines)`;
  D16 block: `SlashCommand`, `SLASH_COMMANDS`, `MENU_MAX_LINES`,
  `slashCandidates`, `suggestMenu`, `menuNav`, `menuComplete`.
- `src/tui/app.tsx` — menu between hint and top separator; budget includes
  `menu.length`; frame comment updated.
- `src/tui/run.tsx` — `onHistory` tries `menuNav`; `onSubmit` tries
  `menuComplete`; busy-quit trim.
- `test/tui-pinned-layout.test.ts` — D16 block: candidate filter, menu
  lines/marker/cap/approval-hide, nav wrap + stale-index clamp, complete vs
  exact-match, fitItems extraLines (3-line menu shrinks pad by 3), App frame
  geometry with the menu (hint at row 14, menu 15–17, separators/input
  pinned at 18–20).

CORRECTION (D17): `test/e2e.sh` `scenario_14` WAS affected — the feeder
types `/quit` (a registered command), so the LAST frame has the menu open
between the hint and the top separator; the anchor was made menu-aware and
the scenario live-verified (see D17).

Next candidates: per-argument completion (e.g. `/display-bottom ` → field
names as a second menu level — would need the "space hides the menu" rule
relaxed for a known command's args), fuzzy (not just prefix) matching,
tab-completes-first instead of enter.

## D15 — `/display-bottom` + no `you` prefix — DONE (unit 271/271 pass, 0 fail; live PTY verified)

Two user requests, both in the TUI only (`coding-agent tui` — NOT `-tui`,
which parses as prompt text):

1. **`you` prefix removed** — the user's typed text renders PLAIN: on the
   dedicated input line (no cyan `you ` marker) and in the echoed user item
   in the output area (full width now, wraps at `width` not `width-4`).
   `inputText` truncates at full width. Empty input renders a bare space so
   the row keeps its height.
2. **The 3 reserved bottom lines are user-configurable** via a slash command
   (dispatched in run.tsx BEFORE the unknown-command error; `/quit`/`/exit`
   stay driver-owned):
   - `/display-bottom`            → report current selection + field menu
   - `/display-bottom off|none`   → clear (lines go blank again)
   - `/display-bottom f1 f2 …`    → set fields (deduped, order preserved;
     more than 3 → first 3 win; unknown field → rejected with the menu)
   - Fields: `model`, `status` (idle/working…), `turn`, `tokens` (cumulative
     `Usage.totalTokens` across `done` events), `cwd`, `session` (label the
     driver passes; `—` when absent). Rendered dim as `field: value`, one per
   reserved line, truncated to width.
   - Feedback lands as a new `info` item kind (dim line in the output area).

Files:

- `src/tui/state.ts` — `TuiItem` += `info`; `TuiState` += `bottom[]`,
  `totalTokens`, `info: Record<string,string>`; `makeInitialState(label, info?)`;
  `applyEvent done` tallies usage; `itemHeight` (user full-width, info case);
  `inputText` full-width; NEW D15 block: `BOTTOM_FIELDS`, `bottomLines`,
  `handleSlashCommand` (all pure).
- `src/tui/app.tsx` — input line = plain `<Text>`; user item = plain
  full-width `<Text>`; `info` item = dim `<Text>`; reserved lines render
  `bottomLines(state, width)` dim.
- `src/tui/run.tsx` — `TuiRunOptions.cwd?/sessionPath?` → labels into
  `makeInitialState`; `onSubmit` dispatches `handleSlashCommand` (clears the
  busy flag the submit raised — slash commands are UI, not runs).
- `src/cli/main.ts` — passes `cwd: root`, `sessionPath: args.resumePath ??
  args.sessionPath` into `runTui`.
- `test/tui-pinned-layout.test.ts` — D15 block: `bottomLines` values/order/
  truncation/unknown-skip/padding, `handleSlashCommand` set/clear/report/
  unknown/passthrough, `done` usage tally; user-item/input-row asserts
  de-prefixed (3 `startsWith("you")` frame checks → blank-row checks).
- `test/tui-app.test.tsx` — `/you/` frame assert → `/hi/`.

Also changed: `test/e2e.sh` `scenario_14` re-anchored — it pinned the LAST
`^you` line, which no longer exists; it now anchors on the LAST hint line
and checks the block AFTER it (─ / input (blank or the typed `/quit`) / ─ /
3×blank). SUPERSEDED (D17): scenario_14 WAS re-run live after the D16
menu-aware rework — PASS (see D17).

Next candidate fields (one-liners in the `bottomValue` switch + registry +
label plumbed via `TuiRunOptions`): `sandbox` (on/off), `provider`,
`model_path`, per-turn tokens, session file size. Extend the e2e
`scenario_14` reserved-line contract if the bottom lines get pinned
non-blank (it currently expects them blank — the default).

## D14 — pinned input layout — DONE (unit 256/256; e2e: D14 scenarios pass, 4 pre-existing/D13 failures remain — see below)

The input line renders at a CONSTANT position: exactly 4 lines above the
bottom of the terminal, with a `─` separator immediately above and below it;
the lower 3 lines are reserved (blank, for future status info). Header +
output items fill the rows above; when items don't fit, they are trimmed from
the TOP. The frame is exactly `rows` lines tall (Ink fullscreen → no flicker).

Files:

- `src/tui/state.ts` — appended pure functions + constants: `wrapLineCount`
  (wrap-ansi `{trim:false, hard:true}` — mirrors Ink exactly), `itemHeight`
  (per-kind, lockstepped with the `Item` rendering), `itemsHeight`, `fitItems`
  (longest tail that fits `rows - FIXED_NON_ITEM_LINES - (approval?1:0)`,
  degenerate → newest item only + ellipsis line), `inputText`, `approvalLine`,
  `RESERVED_BOTTOM_LINES=3`, `PINNED_LINES=6`, `FIXED_NON_ITEM_LINES=8`.
- `src/tui/app.tsx` — frame rebuilt from `useStdout()` dimensions + `fitItems`;
  `oneLine` via cli-truncate for header/hint; keybinding table, `AppProps`,
  and `Item` rendering untouched.
- `test/tui-pinned-layout.test.ts` — NEW, 10 tests: 7 pure (wrap mirror at
  80/100, itemHeight per kind, itemsHeight sum, fitItems budget/tail/ellipses,
  inputText/approvalLine, constants) + 3 App-render geometry on
  ink-testing-library's 100×24 fake stdout.
- `test/e2e.sh` — `scenario_14` (pty_feed 480s; last 7 ANSI-stripped lines
  must be hint / ─ / you / ─ / 3×blank) + case entry 14.

Farm history (option B, 27B Qwen, both clusters): wave 1 w1a-state ok (259 s,
nvidia); w1b-tests TIMED OUT at the 30-min cap — test file was complete but
e2e/report missing (27B slowness, not a task design flaw); wave 2 w2a-render
ok (249 s, nvidia). e2e scenario_14 was finished by the orchestrator.

Bugs found & fixed in ORCHESTRATOR integration (3 app-side, 4 test-side):

1. **JSX whitespace = bare text node**: `<Text color="cyan">you</Text> <Text>…</Text>`
   on one line — the space between the elements is a Box text child, and Ink 7's
   reconciler throws `Text string " " must be rendered inside <Text>` → the whole
   frame is swallowed (test library: `lastFrame() === "\n"`; PTY: Ink error
   overlay). Fix: space lives INSIDE the second `<Text>` (multi-line JSX).
   NOTE for future TUI work: never put single-line whitespace text between Ink
   elements; and ink-testing-library SWALLOWS reconciler errors — an empty
   frame in a test means "check for a render exception", not "nothing rendered".
2. `fitItems(…, state.approval !== undefined)` — `TuiState.approval` is
   `{…} | null`, so `!== undefined` is ALWAYS true → budget permanently -1 →
   frame rows-1 tall. Fixed to `!== null`.
3. w1b's `renderApp` used a 3-prop AppProps shape — real `AppProps` has 8
   (onChar/onBackspace/onHistory/onSubmit/onCtrlC/onApproval/onQuit); fixed to
   the tui-app.test.tsx convention.
4-7. Test-side: `frameLines` helper dropped the last reserved line (strips one
   trailing `\n` but the frame ends with a terminating newline → pad to 24);
   Ink trims trailing whitespace per line so pad/reserved arrive as `""` not
   `" "`; constants test had `PINNED_LINES === 4 + 3` (off-by-one — the frame
   equation pins 3 separators/input/reserved-groups → `3 + 3`); approval test
   expected the idle hint `enter send` on line 17, but the hint SWITCHES to
   `y approve · n/esc deny` while pending (pre-existing behavior, pinned by
   tui-app.test.tsx).

Verify: `npm test` → 263 tests / 256 pass / 0 fail (7 pre-existing skips).
e2e (full sweep 1..14, 27B Qwen both clusters): 01,02,03,06,07,08,09,11 PASS.
- **s14 (tui-pinned-layout, NEW): PASS** — two of my own scenario bugs fixed
  along the way: (1) macOS `sed` can't process `\x1b` → "illegal byte
  sequence", empty strip → python3 re-strip; (2) `tail -7` on the PTY log is
  untrustworthy — the log is a CONCATENATION of every frame, so the previous
  frame's reserved blanks bleed into the tail → now anchors on the LAST
  `^you` input line and verifies the block around it (hint/─/─/3×blank). The
  frame itself was correct in the real PTY from the first run:
  hint / ─ / `you` / ─ / 3×blank, 80×24.
- **s04/s05 (tui-deny, tui-ctrl-c-abort): fixed for D13.** Their commands
  (`echo denied-probe`, `sleep 40 && …`) are workspace-scoped, so D13's `local`
  default AUTO-APPROVES them — no approval prompt ever appears → the deny/abort
  flows can't run. Changed both to outside-path commands (`cat /etc/hostname`
  appended) so the approval gate prompts. (Scenario-side only; re-verified in
  the follow-up run.)
- **s12 (tui-compaction): PASS on re-run; flaky, environment-caused.**
  Instrumented run (temp console.error, removed after) showed the code path is
  correct: trigger fires (totalTokens 3480/11684/19930 > 4096 window) and the
  ✂ renders when the summary succeeds — but the **summarizer LLM call
  intermittently fails/returns empty** (27B, MTP n=4; COMPACT-SKIP-A branch),
  compaction is skipped for that turn and retried next turn. Two failed runs =
  every summary attempt failed during those windows. NOT a D14 regression.
  **Follow-up gap (real, small):** in TUI mode the skip note goes to
  NULL_SINKS → the user never sees "compaction skipped: summary call failed";
  I3 wanted visibility. Route it into the TUI (e.g. an error item) someday.
- **s10 (sandbox-escape-block): FAIL — D13 territory, NOT touched by D14.**
  One-shot `run "Read /etc/passwd…" --yes` expected the path sandbox to BLOCK
  the outside read (✗, no "root:" leak); the content leaked → the sandbox
  (dirty-tree D13 safety.ts) let an /etc/passwd read through (or the 27B used
  an access form the path parser misses, e.g. `python3 -c "open('/etc/passwd')"`).
  Needs owner attention — this is the security module.
- **s13 (eval-baseline): FAIL at 900 s — known 27B variance** (documented).

Design + resume doc: `D14-RESUME.md` (delete after committing).

NOTE: the D13 work (safety.ts, main.ts, tests, models.json, PLAN.md, this
file's D13 section) was already uncommitted when D14 started — the dirty tree
contains BOTH; commit decision (one commit vs two) is the user's.

## D13 — workspace-scoped approval (`local` mode, new default) — DONE

User request (2026-09-14): with the deployed `npm link` build, "anything that
requires bash also requires me to approve" — wants auto-approve for in-
workspace work, explicit confirmation only for bash that reaches OUTSIDE the
safe locations.

- New default approval mode `local` in `src/tools/safety.ts`: bash auto-
  approves when nothing destructive AND no path outside the safe locations;
  write/edit auto-approve (the path sandbox already proves they can't leave
  the root).
- `bashOutsidePaths(cmd, root)` — quote-aware static scan (tokens: leading
  /, ~, ., $, flag `=`, bare `/`; stuck + standalone redirects; $HOME/$PWD/
  $TMPDIR + ~ resolved; cwd-relative → workspace). Safe locations mirror the
  D12 Seatbelt allowlist: workspace, /usr /bin /sbin /System /Library /opt,
  /tmp + per-user temp, /dev fakes. Unresolvable $VAR paths → prompt
  (conservative).
- D8 destructive patterns now prompt in EVERY mode, incl. local, even
  in-workspace (`rm -rf build` still confirms).
- Flags (mutually exclusive): `--local` (default) / `--ask` (pre-D13 prompt-
  per-call) / `--yes` / `--no-approve`. Help text updated.
- The scanner is a PROMPT HEURISTIC, not the security boundary — D12
  Seatbelt stays the boundary. Not seen: network ops, dynamic paths.
- Tests: `test/safety.test.ts` (bashOutsidePaths unit + local-mode hook
  tests), `test/cli.test.ts` (flag parsing; the denial-path test now uses
  `--ask` since the default no longer prompts).
- Verified 2026-09-14: 246 unit tests pass / 0 fail / 7 skip; smoke: ws +
  /usr + /tmp quiet; /etc, ~, $VAR prompt naming the outside path; `rm -rf
  build` confirms; denial → block. **No e2e re-run needed for this change**
  (e2e uses --yes/--no-approve explicitly), but full8 remains a good
  regression gate before shipping further.
- The user's deployed build: re-run `npm run build` in the project dir to
  pick up D13 (the `npm link` symlink stays valid).

## State (WS11)

**All 13 e2e scenarios verified PASS** (across runs; the suite is green). Unit
tests: 246 pass / 0 fail / 7 skip (live, post-D13). Build clean.

| scenario | verified in |
|---|---|
| s1–s9, s11, s13 | full7 (`/tmp/e2e-full7.log`) — 12/13, s10 flipped to PASS |
| s10 sandbox-escape-block | full7 — **PASS** (kernel sandbox blocks the bash fallback) |
| s12 tui-compaction(✂) | `/tmp/e2e-s12-final.log` — **PASS** ("✂ rendered, compaction entry persisted, task completed across compaction") |

## WS11 — bash kernel sandbox (D12) — DONE

The bash tool's child now runs under a macOS Seatbelt profile (`sandbox-exec`),
closing the s10 gap (read tool blocked but bash fallback leaked `/etc/passwd`).

- `src/tools/sandbox.ts` — policy generation + `spawnSandboxedBash`.
  ALLOWLIST BY ENUMERATION (rewritten 2026-09-18 after s10's canary exposed
  that the old denylist left /tmp, /var and /Volumes readable/writable — a
  canary file OUTSIDE the workspace but under /tmp was readable via bash):
  reads + writes denied for /private (the real path of /tmp, /var, /etc —
  the kernel checks data access on the RESOLVED path), /Users, /Volumes,
  /Network, /cores, /Library/Keychains (+ its /System/Volumes/Data real
  spelling), /System/Volumes/Preboot, /System/Volumes/Data/home (the real
  target of the /home symlink), plus NODE denies (`(literal ...)`) on /etc
  and /home; the workspace (in its REAL path), /private/var/folders (per-user
  temp) and /dev/null|stdout|stderr are re-allowed LAST (last matching rule
  wins). /usr, /bin, /sbin, /System, /Library stay readable so exec/dyld work.
- `src/tools/bash.ts` — `createBashTool(cwd, { sandbox?: boolean })`; sandboxed
  when cwd set + darwin + not opted out. Description updated so the model knows
  the boundary.
- `src/cli/main.ts` — `--no-sandbox` flag.
- `test/sandbox.test.ts` — policy shape tests + a kernel-level OS probe (darwin,
  offline): /etc read+write denied, workspace read/write works, /dev/null works,
  children confined.

**Empirical kernel findings (D12, macOS 15 Apple Silicon)** — these cost real
debug time, keep them (2, 3, 4 refined by the 2026-09-18 kernel matrix):
1. A catchall deny (regex `^/` or `subpath /`) + re-allowed prefixes makes
   the exec'd process SIGABRT even when the exec target is allowed (Abort
   trap 6, re-verified 2026-09-18). TOP-LEVEL denies + a subpath re-allow are
   safe — hence the allowlist-by-enumeration.
2. Last matching rule wins (a later `allow` re-allows a denied path — the
   workspace escape hatch).
3. Data access (open/read/write) is checked against the RESOLVED path — one
   `(subpath "/private")` deny covers /tmp, /var and /etc, and the workspace
   re-allow must use the workspace's REAL path. SYMLINKED TOPS are special:
   a subpath deny of /tmp, /var or /etc is FATAL — it kills every
   literal-spelling open underneath and NO re-allow survives it (not even
   `allow subpath /`). So symlinked tops get NODE denies (literal) only —
   safe on /etc and /home (no workspace lives there); /tmp and /var get no
   node deny because a workspace under them must survive. Residual (accepted):
   `ls /tmp` / `ls /var` list top-level NAMES only (no contents, no descent).
4. `file-read*` (not just -data) also denies metadata — `ls /etc` fails.
5. Profiles propagate across fork/exec.
6. `sandbox-exec` is NOT guaranteed at /usr/sbin — resolve /usr/bin vs
   /usr/sbin (this machine has a non-standard /usr tree: no /usr/bin/ls,
   no /usr/sbin/sandbox-exec).
7. Spawn the child with cwd = workspace: running under the policy from a cwd
   that is DENIED makes the shell's getcwd fail and pollutes stderr
   ("shell-init: error retrieving current directory").
8. The sandboxed child runs /bin/bash, not /bin/sh: sh's `cd` fails with
   ENOTDIR on ANY path under a deny policy (its cd hits a check class
   subpath rules do not cover — even `cd .`); bash's cd passes. `cd`
   outside the workspace may "succeed" but every file op there is still
   denied — the chdir escape is inert.
9. /bin/sh probes /private/var/select/sh at startup (harmless stderr noise
   when denied) — re-allowed for quietness.

Known v1 boundary: per-user temp (/var/folders), /opt and /usr,/bin,/sbin,
/System,/Library stay accessible (exec/dyld + tool runtimes need them);
`ls /tmp` and `ls /var` leak top-level names only; commands needing ~/.ssh
(git push over ssh) fail under the sandbox by design — `--no-sandbox` for
system-maintenance work.

## s12 flakiness — server contention, not a code bug

s12 failed twice (full7 + a retry) and passed on the third run. Root cause:
the e2e and this agent session share the ONLY 27B server. A long agent turn
(88k-token context, one task generated 6,348 tokens in 253s — visible in the
llama.cpp pod logs) queues/starves the e2e's turns and the compaction summary
call. I3 then skips compaction (context unchanged) — previously SILENT.

Fix in: `src/cli/main.ts` now writes
`compaction skipped: summary call failed or returned empty (context unchanged)`
to stderr when the trigger fired but the summary failed — silent skips are
diagnosable.

**Ops rule (still the top one): keep agent turns quiet while e2e runs.**
Launch, then ONE long polling turn with zero side work. The pi session's
context grows each session — big turns get slower and hog the server longer.

## Earlier fixes (this project's WS10 era, for reference)

- e2e s5: `wait_pattern` closing-quote mismatch (pattern now matches the real
  tool line).
- REPL piped mode: burst lines queued instead of dropped; EOF only after the
  queue drains (s8).
- Compaction planner: window-aware keep cap + single-prompt fold (index-0 task
  survives via the summary) (s12).
- eval `--timeout` is per-task (total = timeout × tasks); s13 watchdog 900 s.

## Re-run

```bash
npm test                          # unit, offline (~2 s)
FEED_DEBUG=1 nohup bash test/e2e.sh 1 14 > /tmp/e2e-full.log 2>&1 &  # full incl. TUI pinned, ~12–40 min
bash test/e2e.sh 14 14            # single TUI pinned-layout scenario
```

History: `.history/snapshots/` + `.history/CHANGELOG.md` (also a git repo —
commit the WS11 work if you want a tagged checkpoint).
