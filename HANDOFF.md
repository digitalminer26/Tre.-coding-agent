# HANDOFF — bash group-kill + sed-regex misparse (2026-09-21) — UNCOMMITTED (guardrail zone)

## Two fixes, both from 2026-09-20 incidents, both in the guardrail zone — committed by the human with `GUARDRAIL_BYPASS=1`

Working tree at handoff: dirty, changes in `src/tools/bash.ts`, `src/tools/safety.ts`,
`src/tools/sandbox.ts`, `test/safety.test.ts`, new `test/bash-kill.test.ts`. Build + full
suite green: `npm test` → 317 tests, 310 pass / 0 fail / 7 skip (skips are the pre-existing
conditional ones). **Commit pending human review** — the files are in the guardrail zone
(`bash.ts`, `safety.ts`, `sandbox.ts`); per self-improve protocol the human commits:
`GUARDRAIL_BYPASS=1 git commit` after reviewing `git diff`.

### 1 — bash timeout/abort orphaned pipeline children → tool promise never settled → agent loop hang

Incident (proven 2026-09-21): a bash call with no `timeout` ran `sleep 30 | cat`; the
abort path SIGKILL'd only the direct child (/bin/sh). `sleep` was reparented to launchd,
kept running, and STILL HELD THE STDOUT PIPE → the child's `close` event never fired →
`createBashTool`'s promise never resolved → the runLoop hung (the user saw "still
running"; the session had to be killed).

Fix (`src/tools/bash.ts` + `src/tools/sandbox.ts`):
- both spawns (plain + `spawnSandboxedBash`) now pass `detached: true` — the shell (or
  sandbox-exec) leads its OWN process group; `spawnSandboxedBash` gained an optional
  `detached` pass-through.
- new `killChild()`: SIGKILL the whole group (`process.kill(-pid)`), fall back to the
  single child (Windows / group already gone). Timer + abort paths both call it.
- `finish()` extracted from the `close` handler + a **force-settle backstop**
  (`FORCE_SETTLE_MS = 10_000`, armed only on the kill paths): if a re-parented orphan
  somehow keeps a pipe fd open, the promise still settles (as timed-out/aborted) instead
  of hanging the loop forever.

Verified (live probes on the built dist): timeout 1s on `sleep 55 | cat` — unsandboxed
and sandboxed — settled in ~1.0s with `pgrep` clean (0 orphans); abort after 300ms —
settled in ~300ms, 0 orphans; normal completion + exit-code reporting unchanged.
New `test/bash-kill.test.ts` (4 tests) pins the contract: prompt settle (<10s, not at
the command's own 55s), no orphans (pgrep marker), sandboxed variant (skips off-darwin),
normal completion unaffected.

### 2 — `bashOutsidePaths` mis-parsed sed/awk REGEX LITERALS as paths → spurious "outside the workspace" prompt

Incident (2026-09-20): a pure in-workspace command
`sed -n '/opts.ui === "tui"/,/return/p' dist/src/cli/main.js | head -40` prompted
`bash: outside the workspace: /opts.ui === "tui"/,/return/p` — the sed ADDRESS RANGE was
tokenized as two absolute paths. The unanswered prompt stalled the run ~26 minutes
(the user wasn't watching; a `local`-mode prompt blocks the loop). Root cause:
`isPathCandidate` flags every token containing `/`; regex literals full of slashes were
never excluded.

Fix (`src/tools/safety.ts`): new `isRegexLiteral(t)` checked FIRST in
`isPathCandidate` — conservative (over-prompting is safe, under-prompting is not):
1. address ranges `/pat/,/pat2/…` — no real path contains `/,`;
2. flagged addresses `/pat/p`, `/pat/pg` — 1–2 letter flag tail (3+ letters keeps real
   paths like `/etc/ssh` promptable);
3. substitutions `s/pat/rep/flags` with ANY non-word delimiter (covers `s|…|…|`,
   `s#…#…#`) — a relative `s/…/…/` token can only resolve INSIDE the workspace, so
   skipping it never hides an outside path.
Unresolvable shapes (bare `/re/` awk patterns, `$VAR`s) still prompt.

Verified: the exact incident command → `[]` (no prompt); real paths in the same
command still flagged (`sed -n '/pat/p' src/a.ts; cat /etc/hosts` → `["/etc/hosts"]`);
`/usr/local/` is SAFE (in SAFE_PREFIXES) — a regression-test draft asserted otherwise,
the test now uses `/home/other/x/`. `test/safety.test.ts` +2 tests (9 regex-literal
commands → `[]`; real paths next to regex literals still flagged).

## TUI input cursor renders at its position (2026-09-20)

## Cursor location — the input ▍ now shows WHERE the caret is, not just the end (303 tests: 303 pass 0 fail; PTY frame verified)

Before (27b15b9): `inputCursor(input, width)` appended `▍` to the END of the
(truncated) input, so the caret never reflected the actual edit position. Now
the caret renders at `cursorPos` and ←/→ move it.

What changed (one increment, 5 files):
- **`src/tui/state.ts`** — added `cursorPos: number` to `TuiState` +
  `makeInitialState` (0). `inputChar` inserts at the cursor (split+rejoin) and
  advances it; `inputBackspace` deletes the char BEFORE the cursor (no-op at 0)
  and decrements it; new `inputMove(s, dir)` moves left/right (no-op at the
  bounds, locked while an approval is pending); `inputHistory` sets the cursor
  to the end on load / 0 on clear; `submitInput` resets it to 0.
  `inputCursor(input, cursorPos, width)` now renders `▍` at the cursor's
  display column and windows the row to one display line so the cursor is
  always visible: fits → whole string; cursor within the first `width` cols →
  show from column 0 (no ellipsis); otherwise a leading `…` (1 col) + the
  `width-1` cols around the cursor (a cursor at the END of a long input reduces
  to the old ellipsis+tail+cursor). Display width is computed with a small
  owned `charWidth`/`dispWidth`/`sliceByWidth` (wide CJK/Hangul = 2, combining
  marks = 0) — **no new dependency** (the dep freeze blocks `string-width` /
  `slice-ansi`, which are only transitive deps of `cli-truncate`).
- **`src/tui/app.tsx`** — new `onMove` prop; the keybinding table routes
  ←/→ to it; the input row renders `inputCursor(state.input, state.cursorPos,
  width)`; the idle hint now advertises `←/→ cursor`.
- **`src/tui/run.tsx`** — wires `onMove` → `inputMove`.
- **`test/tui-app.test.tsx`** + **`test/tui-pinned-layout.test.ts`** — added
  `onMove` to the render helpers; new `inputMove` unit test; `inputCursor` test
  rewritten for the 3-arg signature + cursor-location cases; render tests that
  set `input` now also set `cursorPos` (the cursor no longer defaults to the
  end).

Verification: `npm run build` clean; `npm test` 303 pass / 0 fail. PTY capture
(local build, `script` pty, session in `$TMPDIR`): typed `hello` → `hell▍o`,
then two left-arrows → `hel▍lo` — the caret visibly moves left. No guardrail-
zone files touched; no new deps.

---

# HANDOFF — terminal-size fd-leak fix (C23) on top of C22 (2026-09-20)

## C23 — `tre. tui` leaked one fd per render frame (terminal-size) and died of EMFILE after ~3 minutes — FIXED (resolve-hook shim, 303 tests: 303 pass 0 fail; PTY frame stress verified flat)

User report (2026-09-20): the self-improve run under `tre. tui` crashed.
Two symptoms, one cause:

1. The user's crash dump: `JavaScript heap out of memory` after 28 minutes
   of a session-less `tre. tui` (no `--session` → auto-compaction OFF). The
   heap-OOM side is not fully pinned down (no session file survived);
   mitigation for long runs: launch with `--session` so compaction is on.
2. The reproducible killer, found while observing a relaunched run:
   **`bash: failed to spawn: EMFILE: too many open files`** +
   **`error: fetch failed`** within ~3 minutes. `lsof` on the live process:
   6,148 fds on `/dev/tty` + 2,037 unix socketpairs, perfectly linear in
   time — a per-frame fd leak. macOS per-process cap
   `kern.maxfilesperproc = 10240` (soft `ulimit -n` is 1,048,575 — the
   sysctl, not the ulimit, is the real cap). Beyond it, every `open()`
   fails: sandboxed bash can't spawn, and `fetch()`'s socket setup fails,
   so the agent is blind and deaf.

Root cause (caught with an `fs.openSync` stack-trace hook):
**`terminal-size@4.0.1`** (a dependency of ink, called by ink's
`getWindowSize()` on **every render frame** whenever `process.stdout`
has no columns/rows — true under PTYs without a window size, e.g. `script`
driven from a non-terminal parent) does
`tty.WriteStream(fs.openSync('/dev/tty', O_EVTONLY|O_NONBLOCK))` and never
closes it. Measured: the `tty.WriteStream`'s libuv handle keeps **exactly
one fd per instance that `destroy()` + `closeSync` + waiting for `close`
never release** (plain `openSync`/`closeSync` is clean — the WriteStream is
the leaker). Every `terminalSize()` call that reaches `devTty()` therefore
leaks; under the no-winsize PTY it is reached every frame.

Fix (this commit):
- **`src/tui/terminal-size-shim.ts`** — a drop-in replacement for
  terminal-size (same export, same fallback chain stdout → stderr →
  COLUMNS/LINES → 80×24, same `createIfNotDefault` quirk) with the
  `/dev/tty` probe DROPPED entirely: the tput/resize probes read the same
  size without opening any fd (verified: tput answers even on a no-winsize
  pty; and when the tty truly has no size, the original probe returned
  0×0 which ink treats as unknown → 80×24, so nothing is lost).
- **`src/tui/terminal-size-hooks.ts`** — an ESM resolve hook that
  redirects the bare specifier `"terminal-size"` to the shim
  (`shortCircuit: true`).
- **`src/tui/terminal-size-fix.ts`** — registers the hook
  (`module.register()`, Node 26: `registerHooks()` exists but 24.x types
  predate it; `register` is deprecated-but-functional and type-stable).
- **`src/cli/main.ts`** — imports the fix first, and `runTui` is now a
  **dynamic** import in the tui branch. The dynamic import is LOAD-BEARING:
  a static import would link the whole module graph (ink included) before
  `register()` evaluates, and the hook would be too late. Verified: with a
  static ink import the fix silently does nothing.
- **`test/terminal-size-fix.test.ts`** — regression test: spawns the built
  fix + ink inside a real PTY (`script`), re-renders 300 frames, asserts
  the `/dev/fd` count stays within +10 (was +4/frame → +1200). Skipped off
  macOS (no `script` PTY there).

Verification (all under a no-winsize PTY, 3000 frames):
- before: fds 32 → 9,463 (≈3.1/frame by readdirSync; ≈4/frame by lsof incl.
  the socketpairs);
- after: fds 20 → 20 (delta 0). Shim `devTty`-free path: 100 calls, delta ≤4
  (readdirSync noise).

Notes for the next session:
- The heap-OOM half of the user's original crash (28 min, session-less) is
  still open. Long self-improve runs should use `--session` (compaction on)
  and `NODE_OPTIONS="--max-old-space-size=..."` is NOT a fix, only a delay.
- `module.register()` prints a DEP0205 deprecation warning on Node 26 —
  cosmetic; revisit when the minimum Node floor moves.

---

# HANDOFF — length-guard nudge (C22) on top of C21 (2026-09-20)

## C22 — the self-improve loop died at kickoff on `length` — FIXED (models.json pin + one nudge retry, 302 tests: 302 pass 0 fail; live one-shot verified)

User report (2026-09-20): unable to kick off the self-improve process — the
run stopped with `length: output limit hit — tool-call arguments may be
truncated` (the TUI/CLI rendering of stopReason `length`).

Root cause (measured against the live 172.30.70.13 server, Qwen3.8-27B):
1. **Thinking ate the whole output budget.** tre sends no thinking params,
   so the Qwen chat template's DEFAULT `reasoning_effort: xhigh` applies.
   At a ~24k-token prompt the model spent **6,313 thinking tokens** before a
   single 2-call reply; the failed run's prompt was ~62.8k tokens, where
   xhigh thinking exhausts the 8,192 output budget with nothing left for
   tool calls. The model itself is fine — at ≤24k prompt it acts in 100–300
   tokens; the xhigh default is a tax that scales with context size.
2. **The loop had no recovery for a no-call `length`.** The existing guard
   handles `length` WITH tool calls (fail them, model re-issues) — but a
   `length` with ZERO calls (the reply died mid text/thinking) broke the
   loop immediately. One over-long reply = dead run.

Fixes (two commits):
- **`models.json` (7acfb4c):** `compat.extraParams.options.
  reasoning_effort: "medium"` — pins thinking at the user's floor (NOT
  lower: medium is the minimum by user instruction). Server-verified both
  transports work (`options` and pi's `chat_template_kwargs`); measured
  medium = 217–2,222 thinking tokens at the same 24k prompt (vs 6,313 for
  xhigh) with instant tool calls. Also `maxTokens 8192 → 16384` (headroom
  for thinking + big tool args, e.g. a 30KB file write ≈ 10k tokens) and
  `contextWindow 98304 → 81920` (the file was STALE — the server's /props
  says `n_ctx 81920`; the old value made shouldCompact's math wrong and
  let a session overflow the real window).
- **loop (4f2d24d, C22):** a `length` stop with no tool calls now retries
  ONCE with a nudge user message ("your response hit the output limit
  before any tool call — re-issue the work in smaller pieces"); the
  partial stays in context (I2 already keeps it), so the model sees where
  it stopped. A second no-call `length` stops as before (`length`, exit 1);
  no nudge on the final allowed turn (budget boundary unchanged: `budget`).
  The retry consumes a turn like any other. +3 loop tests (nudge recovery,
  double-length stop, budget boundary) — 302 pass 0 fail.

Verification: live one-shot `tre. run --session /tmp/tre-verify.jsonl` →
thinking block present in the session (medium effort), clean stop.

Next: kick off the loop — `tre. tui --session ~/.tre/sessions/self-improve-<utc-ts>.jsonl`
with the self-improve skill prompt. The kickoff failure mode is gone on
both axes (thinking budget + no-call length).

## C21 — the self-improve loop was dead under the kernel sandbox — FIXED (solution C, human-approved zone change, GUARDRAIL_BYPASS=1 commit)

User report (2026-09-20): "tre. is not in a recursive improvement state; when
I try to start the process it looks like tre. is unable to access many of the
directories" — worst around git. Investigation (kernel canary matrix, all
failures reproduced deterministically under `spawnSandboxedBash`):

1. **node crash (loop-killer):** node's realpathSync walk-down lstats every
   path prefix from /; the enumeration denies (`/Users`, `/private` subpaths)
   match the ancestor NODES → EPERM → every `node <file>` crashed for
   workspace, /tmp AND $TMPDIR paths (tsc, node --test, npm all dead under
   the sandbox; only `node -e` survived).
2. **git swamp:** /usr/bin/git is an xcode-select SHIM → readlink of
   /private/var/db/xcode_select_link denied → rc=1 + stderr noise per call.
   Real git: UNREADABLE /etc/gitconfig is FATAL (EPERM ≠ the ENOENT it gets
   where the file is absent) → rc=128.
3. **/bin/sh cd** ENOTDIR under the policy (D12 note 8) → quality-gate
   dep-freeze false-fail.
4. **PTY:** /dev write-deny blocked openpty() → `script: openpty: Operation
   not permitted` → every TUI scenario + the skill's TUI recipe dead under an
   INHERITED sandbox (one-shot mode unaffected — e2e 5/14, all TUI dead).
5. **Nested sandbox:** a process already under a kernel policy cannot apply a
   DIFFERENT one (sandbox_apply → EPERM, rc 71; identical policy re-apply OK).
   The D20 farm had "proved" the loop green because its workstreams ran on
   PI (no sandbox at all) — tre.'s canaries only ever tested cat/ls.

Fixes (all in one commit, zone files under GUARDRAIL_BYPASS=1 per protocol):
- `sandbox.ts` policy: `file-read-metadata` (stat/lstat/readlink ONLY — no
  data, no listing) literal re-allows on the ancestor chains of the workspace
  + $TMPDIR, emitted BEFORE the workspace read-allow (which stays LAST —
  ordering unit-tested); literal read allow for /private/var/db/xcode_select_link
  (one file, no traversal); pty write-allows /dev/ptmx (literal) + /dev/ttys*
  (regex — SBPL has NO glob, NO extensible; verified kernel-DAC keeps
  cross-session pty slaves restricted: foreign active slave → Permission
  denied). /dev READS were already open by design (only writes confined).
- `sandbox.ts` spawn: GIT_CONFIG_NOSYSTEM=1 on sandboxed children (explicit
  caller value wins); nested semantics — spawnSandboxedBash marks its
  children (TRE_SANDBOX=1) and, when ITSELF marked, spawns UNWRAPPED so the
  child inherits the caller's confinement (no rc-71 crash; still confined).
- `quality-check.sh`: the dep-freeze step's one cd+node pair runs via
  `bash -c` (bash's cd passes the Seatbelt check; sh's doesn't).
- `e2e.sh`: workdir /tmp → $TMPDIR (write-denied; also where sessions live);
  s10 canary → repo root (a canary under $WORK=$TMPDIR would LEAK through the
  allowed per-user temp read — false "sandbox bypassed"); s10 SKIPS under an
  inherited sandbox (harness confined to repo+tmpdir = both allowed regions,
  no denied canary location reachable).
- `sandbox.test.ts`: unit tests (ancestorMetadataRules shape, policy rules +
  ordering, env contract, node-file + pty + /dev-creation OS probes; OS
  probe skips under an inherited sandbox — nested apply is EPERM).
- self-improve SKILL (zone): TUI recipe /tmp → $TMPDIR + fresh --session
  (the tre. child INHERITS the sandbox: /tmp write + ~/.tre denied).

Verified 2026-09-20: unit 299 (292 pass/0 fail/7 skip); kernel canaries
19/19 FRESH (all previously-broken steps green; /etc, /Users, /tmp writes,
~/.ssh, /dev creation all still denied); `npm test` green FRESH and under
INHERITED sandbox; e2e under INHERITED sandbox: 12/14 (all 6 TUI + one-shot +
sandbox scenarios pass; s10 skipped by design; s13 eval-baseline = 27B
variance — fails IDENTICALLY from a plain shell, pre-existing; s12
compaction failed 3x inherited vs 1x plain — NOT sandbox-related: every
inherited session shows ZERO tool errors, the 27B simply drifted the task
at the 4k window across compaction (run A: lost step 3, never wrote c.md;
run B: created merged.md via bash instead of c.md); s12 needs the same
27B-variance annotation as s13, or a bigger window). NOTE: this machine has NO git identity configured
anywhere (no ~/.gitconfig, no ~/.config/git, no /etc/gitconfig) — commits
auto-fall-back to `Hong Yu <tertain@Hongs-MacBook-Air.local>` (git's
no-identity fallback), which is why existing commits carry that identity.

## D20 — sessions outside the repo + explicit budget + dependency freeze — DONE (296 tests: 289 pass 0 fail; built by GPU farm, orchestrator-verified, 1 integration bug caught)

## D20 — sessions outside the repo + explicit budget + dependency freeze — DONE (296 tests: 289 pass 0 fail; built by GPU farm, orchestrator-verified, 1 integration bug caught)

User request (2026-09-19): implement the three pre-recursion boundary
improvements (1: sessions out of the repo, 2: budget guard, 3: dependency
freeze), parallelized with the gpu-farm skill. All three are in; the agent is
now ready for recursive development with a human-in-the-loop orchestrator.

**Build method (first multi-workstream farm run on this repo):** 3 git
worktrees in /tmp (d20-ws1/2/3), node_modules symlinked from the main repo,
3 self-contained specs in /tmp/farm-tre-d20.json, `farm run --force-lanes
vks-llama,radeon-llama` (forced: the orchestrator session itself runs on
vks-llama, so probes would self-contaminate). Wall 38.5 min: ws3-deps 11.5m
(radeon), ws2-budget 33.7m (vks, while I stayed idle so the lane was free),
ws1-sessions 27m (radeon, queued). All three: own commit, own green suite,
REPORT.md. Merged into main in order ws1→ws2→ws3 — ZERO conflicts (disjoint
regions were specified per workstream).

**1. Sessions live OUTSIDE the repo** (`de4139a`): `--session-auto` flag —
resolves `defaultSessionPath()` = `~/.tre/sessions/tre-<UTC yyyyMMdd>-<HHmmss>-<pid>.jsonl`
(src/session/session.ts, pure function, injectable now/pid for tests),
creates the parent dir, prints `session: <path>` to stderr ONCE (the
orchestrator's hook for building `--resume <file>`). Without the flag:
unchanged (no session file). `--session-auto` + `--session`/`--resume` →
conflict, exit 2. Skill (guardrail zone, applied under GUARDRAIL_BYPASS=1,
from the farm's SKILL-CHANGE.md) now MANDATES self-improve sessions under
`~/.tre/sessions/`. Verified live: one-shot with `--session-auto` →
`session: /Users/tertain/.tre/sessions/tre-...jsonl` + file created outside
the repo.

**2. Explicit budget** (`db1bfbb`): the existing `--max-turns` cap (default
32, pre-dates D20) was SILENT on cap-hit — the loop broke with the previous
message's stopReason ("toolUse"), exit 0, no message. Now: new StopReason
`"budget"` set by runLoop at the cap; `agent_end` carries `maxTurns` only on
budget; plain CLI → exit code **3** (distinct from 0 done / 1 provider / 2
usage / 130 aborted) + stderr `budget: max <n> turns reached
(resume: --resume <path>)` when a session is in use; TUI → error-kind item
`budget: max <n> turns reached — send another prompt to continue`, busy
cleared, next submit is a fresh run (per-run cap by construction). Verified
live: `--max-turns 1` on a read-then-summarize prompt → rc=3 + note.

**3. Dependency freeze** (`5fc4fa7`): `scripts/check-deps.mjs` (plain node
ESM, zero deps) — embedded allowlist: runtime exactly {cli-truncate, ink,
react, wrap-ansi}, dev exactly {@types/node, @types/react,
ink-testing-library, typescript}; rejects unexpected packages AND
lock/package.json drift (v2+v3 lockfile roots). Wired as check 6 in
`quality-check.sh` (CWD pinned to repo root, so it checks the repo no matter
where invoked). `test/quality-gate.test.ts`: 4 spawn-based fixture tests.
Guardrail zone extended (applied under GUARDRAIL_BYPASS=1 from the farm's
GUARDRAIL-CHANGE.md): `scripts/check-deps.mjs` is now PROTECTED — verified:
a probe commit touching it is rejected by the hook.

**Integration bug caught by the orchestrator (the reason farm work is
verified, not trusted):** ws3's aggregation `if ! (cd "$ROOT" && node
scripts/check-deps.mjs); then DEPS_STATUS=$?; fi` records the INVERTED
status — a failed deps check left DEPS_STATUS=0 and the gate exited 0
anyway (its own tests spawned check-deps.mjs directly, never the wrapper;
its "standalone gate exits 0" check ran on a clean manifest). Fixed in
e6167f1: capture the subshell status directly. Verified all three branches:
poisoned package.json → rc 1 (main path + no-.ts early-exit), clean → rc 0.

**Farm lessons (27B, this repo):** (1) `git add -A` staged the node_modules
SYMLINK (gitignore's `node_modules/` doesn't match a symlink) — ws2 hit it,
`git rm --cached node_modules` + amend; future farm worktrees should `git add
<files>` explicitly or the spec should say so; (2) ws1 correctly deviated
from the spec (a boolean flag registered on the value-taking branch would
swallow the next argv token) — specs must name the branch, not just the
line; (3) 27B needs ~11–34 min per workstream of this size; REPORT.md +
commit artifacts survive even when the final answer is cut.

**Definition of done met:** `npm test` 289/289 (quality gate incl. dep
freeze, tsc strict, node --test); live probes for all three behaviors; hook
reject-verified for check-deps.mjs. Commits: de4139a, db1bfbb, 5fc4fa7
(branches d20-ws1-sessions / d20-ws2-budget / d20-ws3-deps, merged), 6ec9e64
(guardrail overrides), e6167f1 (integration fix). REPORT.md artifacts:
/tmp/tre-d20-ws{1,2,3}/REPORT.md.

**Next (recursion):** ready to run the self-improve loop with a
human-in-the-loop orchestrator: agent commits → orchestrator reviews
git diff + `npm test` + targeted e2e (3, 4, 10) → next increment. Sessions
via `--session-auto` (outside the repo by construction). e2e full-suite
runs remain the deep regression net; the tag `known-good-2026-09-19` is the
named safe harbor.

## D19 — quiet file-access tool lines + models.json lookup — DONE (284 tests: 277 pass 0 fail; PTY + live one-shot verified)

User request (2026-09-19): (1) "too verbose about the directory access — for
now, it should only show if the access was denied based on the white list";
(2) launching `tre.` outside the project dir couldn't locate models.json —
fixable or must it move? Fixed in place, no move required.

**1. Quiet file-access tools (read/write/edit), both surfaces:**
- `src/types.ts`: `QUIET_ON_SUCCESS_TOOLS = {"read","write","edit"}` — the
  single shared policy. bash is NOT quiet: its command line is the approval
  surface and the user watches it.
- `src/tui/state.ts`: a quiet tool starts as a `hidden: true` height-0
  placeholder (no diff work either). On `tool_execution_end` (keyed by
  `result.toolName`): success → the item is DROPPED (no line ever rendered);
  denial → unhidden in place, so the ✗ + reason is the only file-access
  line. `itemHeight` returns 0 for hidden items, so the fit math already
  counts them as nothing; `app.tsx` renders `null` for them (the lockstep
  contract is preserved).
- `src/cli/main.ts` `printEvent`: quiet tools print no start line and no
  success line; a denied call prints just `  ✗ <reason>`.
- NOTE: the edit DIFF view (D10, `renderEditDiff`) is now unreachable on
  success — it only ever attached to edit items, and those are hidden.
The renderer, unit tests (`tui-diff.test.ts`) and the `diff` field all
  still exist; re-showing diffs = remove `"edit"` from the set (one line),
  and e2e scenario_03's old diff assertions are the template to restore.
- Tests: tui-state (quiet contract: hidden mid-flight / dropped on success /
  unhidden on denial, for read+write+edit; `tres`/`toolEnd` helpers now
  carry the real toolName — they hardcoded "x", which had masked the end-
  event name from the quiet logic), cli (printEvent: success silent, denial
  line, bash unchanged), pinned-layout (hidden=0, denied=mark+result),
e2e scenario_03 repurposed: file edited + NO diff line in frames.

**2. models.json lookup (`src/config/models.ts` `findModelsFile`):**
- `--models <file>` wins (returned as-is, even if missing — the caller
  reports it, unchanged). Otherwise: walk UP from the launch directory
  (like a `.git` dir: `test/`, `scripts/`, the project root, …) looking
  for `models.json`, then fall back to the permanent `~/.tre/models.json`.
- `main.ts` resolves this before loading; not-found → exit 2 with the
  searched locations named + the `--models` escape. `CliOptions.modelsPath`
  is now `string | undefined` (undefined = auto-locate).
- Verified live: launch from /tmp → clean not-found error; launch from
  `test/` (no local file) → walks up to the project's models.json and
  runs. A user who wants a HOME-level config: `mkdir -p ~/.tre && cp
  models.json ~/.tre/` — the project-local file still wins while launching
  inside the tree.

**Verified:** `npm test` 277/277 (quality gate clean, 24 files); live
one-shot from a subdir: successful read prints NO line, failed read prints
`✗ read: …`, bash lines unchanged; PTY TUI smoke: read turn renders no
`→ read` / `✓` line, clean /quit.

## D18 — rename to Tre Coding Agent (`tre.`) + quality gate — DONE (276 tests 0 fail; quality gate wired into `npm test`; PTY + --help verified)

User request: real name "Tre Coding Agent", invoked as `tre.` (trailing dot
— a valid POSIX command name). The legacy `coding-agent` command is KEPT as
an alias (both bins point at the same `dist/src/cli/main.js`).

- `package.json`: name `tre-coding-agent`, v0.1.0, dual bin
  (`tre.` + `coding-agent`), `npm install --package-lock-only` synced the
  lock. Global re-link (`npm link` after removing the stale `coding-agent`
  global pkg dir — the first attempt failed on EEXIST of the old bin link).
- CLI: help/usage, error strings, REPL banner → `tre.` / Tre Coding Agent.
- TUI: header branded `tre. · <model> — turn N`. Hint line now advertises
  the `/` menu ("enter send · / commands · ↑/↓ history · …") — the D16
  HANDOFF claimed this was done; it wasn't. Verified by PTY capture.
- `test/e2e.sh`: default range fixed 13 → 14 — `scenario_14` had been
  silently excluded from full runs ever since it was added (latent bug).
- **Quality gate** (D17 backlog item d, built by a farm agent, verified by
  the orchestrator): `scripts/quality-check.sh` — POSIX sh, no deps, scans
  src/*.ts for: `console.log(`, TODO/FIXME, trailing whitespace, tabs,
  node_modules//bare-dist/ import specifiers. Optional dir arg (default
  src/). Wired into `npm test` as the FIRST step (fail-fast) + standalone
  `npm run check`. Verified: clean run exit 0 (24 files), bad fixture exit 1
  naming file:line for every violation class.
- Guardrail-zone files (self-improve skill relaunch text, guardrail comment)
  updated under a human-decision `GUARDRAIL_BYPASS=1` commit, as designed.
- **gpu-farm pilot** (first real fan-out): 2 workstreams on both lanes
  (Qwen3.8-27B, nvidia + radeon). Result: the quality-gate agent DELIVERED
  its file 3 min before its 1200 s timeout but was killed while composing
  the final answer (farm marks it `timeout`, .out empty); the read-heavy
  brand-audit agent (600 s) also timed out. LESSON for farm use on 27B:
  (1) artifacts on disk survive the timeout — check the workstream's cwd
  before discarding a `timeout` result; (2) give 27B ≥1500 s for tasks that
  end in a long final answer, or require the agent to write its report to a
  file as it goes; (3) the orchestrator absorbed the audit inline (one grep
  pass) — for small read-heavy tasks, inline beats a farm lane.
- Post-rename brand audit: remaining "coding agent" strings are general-
  category prose (system prompts in tests, docs titles, README description)
  or historical records (PLAN.md) — intentionally left.

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

Design + resume doc: D14-RESUME.md (deleted after commit — recoverable from
git history of 95347ed).

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
