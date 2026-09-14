# HANDOFF — WS11 done: bash kernel sandbox, e2e 13/13 verified (2026-09-14)

## State

**All 13 e2e scenarios verified PASS** (across runs; the suite is green). Unit
tests: 231 pass / 0 fail / 7 skip (live). Build clean.

| scenario | verified in |
|---|---|
| s1–s9, s11, s13 | full7 (`/tmp/e2e-full7.log`) — 12/13, s10 flipped to PASS |
| s10 sandbox-escape-block | full7 — **PASS** (kernel sandbox blocks the bash fallback) |
| s12 tui-compaction(✂) | `/tmp/e2e-s12-final.log` — **PASS** ("✂ rendered, compaction entry persisted, task completed across compaction") |

## WS11 — bash kernel sandbox (D12) — DONE

The bash tool's child now runs under a macOS Seatbelt profile (`sandbox-exec`),
closing the s10 gap (read tool blocked but bash fallback leaked `/etc/passwd`).

- `src/tools/sandbox.ts` — policy generation + `spawnSandboxedBash`. Denylist:
  reads denied for /etc, /private/etc, /var/root, /private/var/root,
  /private/var/db, /cores, /Library/Keychains, /System/Volumes/Preboot, /Users;
  writes denied for /etc, /private/etc, /usr, /bin, /sbin, /System, /Library,
  /var/root, /private/var/root, /cores, /dev, /Users; workspace re-allowed
  (last matching rule wins) + /dev/null|stdout|stderr for writes.
- `src/tools/bash.ts` — `createBashTool(cwd, { sandbox?: boolean })`; sandboxed
  when cwd set + darwin + not opted out. Description updated so the model knows
  the boundary.
- `src/cli/main.ts` — `--no-sandbox` flag.
- `test/sandbox.test.ts` — policy shape tests + a kernel-level OS probe (darwin,
  offline): /etc read+write denied, workspace read/write works, /dev/null works,
  children confined.

**Empirical kernel findings (D12, macOS 15 Apple Silicon)** — these cost real
debug time, keep them:
1. DENYLIST, not allowlist: a catchall `file-read-data` deny (regex `^/` or
   `subpath /`) + re-allowed system prefixes makes the exec'd process SIGABRT,
   even when the exec target is allowed. Targeted denies are fine.
2. Last matching rule wins (a later `allow` re-allows a denied path).
3. The kernel resolves symlinks BEFORE the MAC check → deny both /etc and
   /private/etc.
4. `file-read*` (not just -data) also denies metadata — `ls /etc` fails.
5. Profiles propagate across fork/exec.
6. `sandbox-exec` is NOT guaranteed at /usr/sbin — resolve /usr/bin vs
   /usr/sbin (this machine has a non-standard /usr tree: no /usr/bin/ls,
   no /usr/sbin/sandbox-exec).
7. Spawn the child with cwd = workspace: running under the policy from a cwd
   that is DENIED makes the shell's getcwd fail and pollutes stderr
   ("shell-init: error retrieving current directory").

Known v1 boundary: /var/folders + /opt stay accessible; commands needing
~/.ssh (git push over ssh) fail under the sandbox by design — `--no-sandbox`
for system-maintenance work.

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
FEED_DEBUG=1 nohup bash test/e2e.sh 1 13 > /tmp/e2e-full8.log 2>&1 &  # full, ~12–40 min
bash test/e2e.sh 12 12            # single scenario
```

History: `.history/snapshots/` + `.history/CHANGELOG.md` (also a git repo —
commit the WS11 work if you want a tagged checkpoint).
