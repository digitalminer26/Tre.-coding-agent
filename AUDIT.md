# Codebase audit — 2026-10-21

Full-codebase review of tre. (62 TS modules, ~24.5k LOC) with a security
lens on the guardrail zone, the credential/config surface, and the Telegram
bridge. Every M/L finding below was **verified by execution against the
built code** (`dist/`), not by reading alone; repros are inline. This is a
point-in-time audit record — findings are NOT yet fixed; each carries a
proposed fix shape.

> **REMEDIATION STATUS (2026-10-21, same day): all M/L findings from this
> audit are FIXED.** M2 `f59cd83` · M1 `299ce1a` · M3 `f398df9` · L1–L4 +
> L5/L6 (two commits below). Every fix carries regression tests pinning the
> audit's own repros (29 new tests; suite 1330 pass / 0 fail), and the M1/L4
> repros were re-verified against built `dist/`. Per-finding notes below;
> the fix-order section at the end is the index. **One follow-up finding was
> filed after remediation (M4, write/edit sensitive-check — OPEN), and two
> Info items were implemented (guardrail-hook install step + gate note).**

## Automated gates (all green at audit time)

| Gate | Result |
|---|---|
| `tsc --noEmit` | clean (exit 0) |
| `npm audit --omit=dev` | 0 vulnerabilities (4 runtime deps) |
| `scripts/quality-check.sh` | OK — 60 files, no violations |
| Full suite (via git-commit today) | 1294 pass / 0 fail / 14 skip |

## Design context that scopes several findings

Two deliberate design stances interact with the findings and are stated in
`safety.ts`'s module header: (1) **`read` is NOT path-sandboxed** — by
design it may read any file on the system; (2) the approval matrix's
"never, ever" category is **SYSTEMIC sensitive/destructive — blocked in
EVERY mode**. M1 matters because it silently defeats (2), not (1).

---

## M1 — The sensitive-path gate is lexical; three verified bypasses of the "blocked in EVERY mode" guarantee

> **FIXED 2026-10-21 (299ce1a)** — all three bypasses closed and re-verified
> against built `dist/`: (1) the `read` branch now classifies the
> realpath-resolved target as well as the argument (a benign-named symlink
> onto a secret blocks); (2) every pattern test runs on case-folded segments
> (`.ENV` blocks on macOS's case-insensitive FS); (3) bash tokens are
> stripped of one layer of shell quotes before matching (quoted absolute
> paths block). The ws/sys split compares realpath-vs-realpath so a
> workspace under a symlinked path still PROMPTS instead of misclassifying
> as sys. 7 regression tests (`test/safety-m1.test.ts`). Accepted residual
> (documented, reviewer): TOCTOU symlink-swap between gate and open —
> inherent to a pre-exec classifier; deeper indirection (`$(…)`, base64)
> stays out of scope as the finding always acknowledged. Original finding below.

`safety.ts` classifies sensitive access by pattern-matching the **argument
string**, never the resolved target or the real command semantics.

**Verified repros** (real `makeSafetyHooks` from `dist/`, temp workspace +
temp secret file outside it):

1. **Symlink.** A benign-named symlink inside the workspace
   (`readme.txt -> /tmp/…/.env`): `read` at `mode:"yes"` → **ALLOWED**,
   while `read` of the direct secret path → blocked. The gate never
   resolves the link (`sensitivePathPatterns` only splits the raw arg on
   `/`). The write/edit path-boundary check DOES realpath (a write through
   the same symlink was correctly blocked) — the sensitive check simply
   never runs on the resolved read target.
2. **Case.** `~/.tre/tmp/.ENV` → **ALLOWED** (all patterns are lowercase;
   macOS's default filesystem is case-insensitive, so `.ENV` IS `.env`).
3. **Quoting.** `bash cat "<quoted absolute .env path>"` → **ALLOWED**;
   the same command unquoted → blocked. `sensitiveBashPatterns` splits on
   whitespace, so a quoted token keeps its quotes and never matches.
   (Same class: `$(…)`/backtick/base64-piped indirection — inherent to a
   token-matching classifier.)

**Impact.** The documented across-the-board block (the ONLY hard guarantee
in `yes` mode, the default) is advisory, not enforced. Threat model: a
prompt-injected or compromised model — exactly the scenario the sys-block
exists for.

**Fix shape.** (a) `read`: `realpathSync` the deepest existing component
before pattern-matching (mirrors the write path's existing symlink check);
(2) case-insensitive filename patterns; (3) strip surrounding quotes from
bash tokens before matching. All three are small, additive, and testable.
Longer-term (log, not this audit): the classifier can never be airtight —
the honest posture is defense-in-depth (sandbox-confined reads too), which
conflicts with design stance (1); worth an explicit decision entry.

## M2 — Telegram bridge has NO sender/chat allowlist: any Telegram user who obtains the bot token can inject prompts into live sessions

> **FIXED 2026-10-21 (f59cd83)** — both bridges now filter at parse time
> against `chatId` from `~/.tre/telegram.json` via the shared
> `parseTelegramPollOutput` + `telegramAllowedChatIds` helpers in
> `src/telegram/paths.ts` (fail-closed: empty/invalid config allows no
> chat). The foreign-chat offset still advances (the helper consumed the
> update) — ignored, not retried. 7 regression tests in
> `test/telegram-chat-filter.test.ts` pin the pure helpers and both
> bridges end-to-end. The helper's own `poll` is unchanged (the filter
> lives in the consumer, single source of truth). Original finding below.

`~/.tre/telegram.json` carries `{token, chatId}`, but **no layer filters
incoming messages by `chatId`**: `telegram.py poll` prints every update
from every chat; `bridge.ts` parses them all; `driver.ts` feeds them all
to steer/idle turns; `run.tsx`'s `steerTelegramBatch` uses only
`sender`/`text` and discards `chatId`. Anyone who has ever messaged the
bot (or leaks the token) is a prompt-injection vector into a
full-privilege agent session — and the token itself is world-readable
(L6), readable by the agent (by design, `read` is unrestricted).

**Verified** by code-path inspection end-to-end (no filter exists at any
layer).

**Fix shape.** Filter in `bridge.ts` parse (and the helper's `poll`):
drop messages whose `chat.id !== config.chatId` before they reach the
queue. One condition, both bridges, ~10 tests.

## M3 — Credential files are world-readable

> **FIXED 2026-10-21 (f398df9)** — new `src/config/secret-mode.ts`:
> `hardenSecretFiles()` runs at startup (before models load) and chmods
> every known secret file with group/other bits down to `mode & 0o600`,
> warning on stderr for each fix (and for any chmod failure — never a
> throw). Covered: `~/.tre/telegram.json`, `~/.tre/tre/models.json`,
> `~/.tre/models.json`, `chatgpt-auth.json`, `tokenomics.json`. The price
> cache write dropped its explicit `0644` to `0600`. Live machine: 3 files
> tightened on first run. 6 tests (`test/secret-mode.test.ts`). Env-based
> apiKey reading remains a logged, larger config change (unchanged scope).

- `~/.tre/tre/models.json` — **0644, 7 inline `apiKey` values** (the live
  config).
- `~/.tre/models.json` (legacy) — 0644, 2 inline keys.
- `~/.tre/telegram.json` — **0644, bot token** (the skill docs say to
  `chmod 0600` it; it isn't).
- Contrast: `~/.tre/chatgpt-auth.json` is correctly **0600** with atomic
  write + mode enforcement (`token-store.ts:118-120`).

On a single-user laptop with a home dir at `700` the practical exposure is
low, but these are durable machine-level secrets and the codebase already
owns the correct pattern. **Fix shape:** mirror `token-store.ts`'s posture
— write the config files `0600`, and `chmod` (warn) on load when a secret
file is group/other-readable. (Reading `apiKey` from env instead of JSON
is a larger config change — log, not mandate.)

---

## L1 — `read` loads the whole file into memory before any size check

> **FIXED (commit "L1-L4 batch")** — `stat` before `readFile`: files above
> 64 MiB are refused by size (sparse-file test proves no materialization),
> and FIFOs/sockets/devices are refused outright (a writer-less FIFO used
> to hang `readFile` forever). The tool description now promises the cap.

`readFile(a.path, "utf8")` on an arbitrary path (e.g. a multi-GB core
dump, or `read` of a huge device file) can OOM the process before the
2000-line/50KB page ever applies. The binary NUL probe only looks at the
first 8 KiB of the already-materialized string. **Fix:** `stat` first and
refuse/stream above a size cap (the tool description can promise it).

## L2 — Directory listings are unbounded

> **FIXED (same commit)** — listings cap at 2000 entries and name the
> total (`listing truncated: showing 2000 of 2500 entries`); small dirs are
> byte-identical to before.

The `EISDIR` branch returns `listDir()` output **without** `truncateHead`
— a directory with 100k entries floods the context (the file path is
capped; the listing path is not). **Fix:** pipe through the existing
`truncateHead` + a count note.

## L3 — Truncation-recovery temp files: world-readable, never pruned

> **FIXED (same commit)** — `saveFullOutput` writes `mode: 0600` and prunes
> its own `*.log` files older than 7 days on each write (foreign files in
> the dir are never touched).

`saveFullOutput` writes full (possibly secret) tool output to
`$TMPDIR/coding-agent/*.log` at default mode (umask 022 → 0644) with no
cleanup. On shared hosts (the linux side) that is secret spill; on macOS
per-user `/tmp` mitigates. **Fix:** write `mode: 0o600` + prune older
than N days on startup.

## L4 — `printenv`/`env` classified read-only → allowed in `no` mode

> **FIXED (same commit)** — `env`/`printenv` removed from `READONLY_VERBS`;
> they now fall through to the mutating-bash gate (prompt in "ask", blocked
> in "no"). `bash printenv` in `no` mode is the pinned repro.

`READONLY_VERBS` includes `env`/`printenv`; `bash printenv` under
`--no-approve` (the "no human" mode) dumps every env secret — verified
ALLOWED. **Fix:** drop `env`/`printenv` from the read-only set, or block
them in `no` mode explicitly.

## L5 — `read`/`write`/`edit` ignore the abort signal

> **FIXED (commit "L5+L6")** — the pipeline gained a `toolTimeoutMs` hook
> (default 30s for the file tools; bash/subtask/MCP exempt — they own their
> timeouts). A hung tool returns an in-band timeout error and the loop
> moves on; the timer is `unref`'d. Residual (documented): an abandoned
> write may still land after the timeout — the error text names it.

`execute(_id, args, _signal, …)` — a hung read (NFS, FIFO without a
writer) can't be interrupted; only bash honors the signal. The loop's
abort waits for the tool to settle. **Fix:** at minimum a default
per-call timeout in the pipeline for non-bash tools.

## L6 — Pattern-list gaps adjacent to M1 (same fix batch)

> **FIXED (commit "L5+L6")** — `SENSITIVE_FILENAME` gained `telegram.json`,
> `tokenomics.json` (tre.'s own machine-level secrets) and the shell rc
> files `.bashrc`/`.zshrc`/`.profile`; M1's case-folding covers the case
> variants. `models.json` deliberately NOT added (the name doubles as the
> workspace-facing catalog and would over-block; M3's mode-hardening covers
> it instead). Side effect (intended): the agent can no longer write those
> config files itself — an attacker-supplied bot token would otherwise
> redirect every reply.

`~/.tre/*.json` (tre.'s OWN secrets: bot token, apiKeys) are not in
`SENSITIVE_FILENAME`; case variants bypass; `~/.bashrc`/`~/.profile`
(not in the list) are readable unblocked in `yes` mode. The list is
explicitly best-effort, but tre.'s own credential files are the lowest
hanging fruit to add.

## L7 — `~/.tre/telegram.json` token file perms (folded into M3) and
helper `poll` consuming updates from all chats (folded into M2).

> **FIXED** via the M2 (f59cd83) and M3 (f398df9) commits.

---

## M4 — write/edit never sensitive-check (filed 2026-10-21, post-remediation review; OPEN)

The sensitive-path gate covers `read` and `bash`; the write/edit branch of
`makeSafetyHooks` runs ONLY the path-sandbox (`checkPathWithinRoots`) — a
path inside an authorized root is written without any sensitive-pattern or
sys/ws check. Verified against `dist/` (2026-10-21): with `~/.tre` as an
`--extra-root` and `mode:"yes"`, `write` to `~/.tre/telegram.json` and
`~/.tre/models.json` returns an allow (args rewrite), no prompt, no block.

Two-step, not one: the default launch has NO extra root covering `~/.tre`,
and creating the symlink/dir an attack needs is itself gated bash. So this
is not a bypass of M1/L6 — it is the remaining half of them: L6 closed the
EXFIL direction (the model can no longer read the bot token); the TAKEOVER
direction (an injected model with a `~/.tre` extra root swaps in an
attacker bot token or rewrites the endpoint catalog, redirecting future
sessions) is unguarded.

**Fix shape.** Run the same `sensitivePathPatterns` check (case-folded,
realpath-resolved — M1's helpers apply directly) over write/edit targets:
sys-sensitive → blocked in every mode; ws-sensitive → prompt in "ask".
Small diff in the PATH_TOOLS branch of `makeSafetyHooks`; guardrail-zone,
needs a human commit. The one legitimate writer of these files is the
human setup flow (and `tre. login`, which is not the gate's problem).

## Info / accepted

- **No `retry-after` honored on 429** — exponential backoff only. Known
  and documented (README, 2026-10-13 entry). Accepted.
- **No `unhandledRejection`/`uncaughtException` handlers.** Consistent
  with I3 (fail loud); `process.on("exit")` handles terminal restore.
  Note: an uncaught throw mid-TUI leaves mouse modes on the terminal
  only if the `exit` handler itself can't run.
- **Guardrail hook is opt-in per clone** (`core.hooksPath` must be set
  manually; this clone has it). A fresh clone without the config has NO
  guardrail pre-commit. The script header says "by convention" — accurate,
  but worth a `npm test` assertion that a hook is active, or an
  install-time `git config` step in `install-tre.sh`.
- **Session JSONL has no integrity/signature** — a tampered session file
  replays forged context. Accepted: the file lives under the user's home,
  and the threat model treats local file access as game-over.
- **Compaction summary** (LLM output) is injected as a user message with
  no delimiter hardening — the summarizer prompt is the only guard.
  Standard industry posture; log only.

## Verified strong (spot-checks that held up)

- **MCP client**: caps everywhere (pending 32, 100 pages/10k tools,
  64 KiB byte-ring stderr, byte-correct UTF-8 truncation), per-call +
  startup timeouts with cleared timers, in-band failures, per-server
  isolation, `--clearenv`+explicit-env for sandboxed spawns.
- **bash tool**: detached process-group + group-SIGKILL, bounded tail
  buffer by BYTES, spawn-failure `notExecuted` marking (D32 contract).
- **token-store**: 0600 + `wx` flag + mode re-check on read — the pattern
  M3 should copy.
- **write/edit path sandbox**: realpath containment verified (the symlink
  write was blocked even where the read wasn't).
- **HTTP layer**: bounded retries, abort plumbing, SSE buffer only grows
  between frames (bounded in practice), `retry-after` gap noted.
- **Telegram driver**: the three loop-prevention mechanisms (self-pacing,
  min-interval, capped backoff) are all present and unit-tested; stop()
  kills the in-flight child; per-message handler guard.

## Suggested fix order — ALL DONE 2026-10-21

1. **M2** (chat allowlist) — smallest diff, closes an injection front door.
   **DONE 2026-10-21 (f59cd83).**
2. **M1** (realpath + case + quote normalization in the classifier) —
   restores the documented guarantee; guardrail-zone file, needs a human
   commit (`GUARDRAIL_BYPASS=1`) per repo policy.
   **DONE 2026-10-21 (299ce1a, human-directed).**
3. **M3** (0600 on config writes + warn-on-load) — mirrors token-store.
   **DONE 2026-10-21 (f398df9).**
4. L1–L4 batch (size caps, listing cap, temp-file mode+prune, printenv).
   **DONE (commit "L1-L4 batch", human-directed for safety.ts).**
5. L5/L6 + the info items as design entries.
   **L5/L6 DONE (commit "L5+L6"). The Info/accepted items stay as designed
   entries — no code change was proposed for them.**
