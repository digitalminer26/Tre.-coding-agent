# Telegram bridge — architecture

The bridge lets the user talk to a running `tre.` session from Telegram. It is
**one bridge per session, no daemon**: each session creates its own bridge
and driver at startup, polls the bot on the user's chat, and stops with the
session. There is no relay and no inbox file; a message is consumed by
whichever poller reads it first, which is why running `telegram.py poll` by
hand races the drivers (see "How to run"). The helper's offset
(`~/.tre/telegram/last_update_id`) is **machine-level, not per-session**:
concurrent sessions on one bot config share it and race each other's
updates (see "Single-consumer contract").

## Architecture (as shipped)

Two bridges + one driver class, one shared path/state module:

```
Telegram cloud
   │  getUpdates / sendMessage
   ▼
telegram.py   (machine skill: ~/.tre/agent/skills/telegram/ — python3 stdlib)
   ▲  spawned as `python3 <helper> poll [--timeout N]` / `send <file>`
   │  helper resolved across the skill roots by src/telegram/paths.ts
   │  (project <cwd>/.tre/skills first, then user ~/.tre/agent/skills);
   │  config ~/.tre/telegram.json + state ~/.tre/telegram/ are machine-level
   │
   ├── TUI: TelegramBridge (src/tui/telegram.ts)
   │     Non-blocking poll (`poll` with no --timeout → getUpdates timeout 0),
   │     driven by the TUI itself: a self-rescheduling setTimeout tick every
   │     TELEGRAM_POLL_MS (15 s) in src/tui/run.tsx — never holds the TUI
   │     open. The tick skips while a previous poll is in flight (overlapping
   │     polls could double-consume the offset). Hard cap per helper call is
   │     TELEGRAM_TIMEOUT_MS (135 s) — a backstop above the helper's own
   │     worst case (60 s HTTP read + a 429 retry_after sleep), not the
   │     pacing. Routing (src/tui/run.tsx `telegramTick`): idle → fold the
   │     whole batch into ONE prompt, run it, send the run's final text back
   │     (fallback text when the turn produced none); busy → steer every
   │     message into the active run's steering queue (pure helpers
   │     `steerTelegramBatch` / `steerTelegramBusy` in run.tsx) and echo
   │     "telegram: N message(s) steered into the running turn". Messages
   │     polled during a quit (/restart window are dropped — the poll is
   │     in flight when stopTelegram() runs).
   │
   └── Plain CLI (one-shot + REPL): TelegramBridge (src/telegram/bridge.ts)
         Same helper, with a LONG-POLL seam: `pollLong(timeoutSec, signal)`
         runs `poll --timeout N` and honors `signal` (node kills the child,
         so stop() ends an in-flight poll promptly). Enabled only when
         ~/.tre/telegram.json AND the helper exist; either missing →
         `enabled: false` and the driver never starts.
              ▲
              │  injected as a seam (MainDeps.telegramBridge; tests use a
              │  fake — no network)
         TelegramDriver (src/telegram/driver.ts — ONE class, TWO wirings)
               Handlers: { onSteer(msg), onIdle?(msgs) }. Options:
               { allowIdleTurns (default true), failBaseMs, failCapMs,
                 minIntervalMs, onPollError, onHandlerError }.
               • one-shot wiring (src/cli/main.ts): allowIdleTurns=false,
                 onSteer pushes into the run's steering queue; the run
                 executes inside driver.withTurn(...). A message that
                 arrives while the run is in flight (including the backlog
                 already queued at startup, which the first poll round
                 returns) is STEERED in as guidance; a message with no run
                 in flight is DROPPED — one-shot is a single turn and never
                 replies via the bot.
               • REPL wiring (src/cli/main.ts, also used by --plain):
                 busy → onSteer pushes Telegram messages into the driver's
                 attached turn queue (or handoff buffer); idle → onIdle runs a
                 full turn and replies via the bot (the reply IS the ack;
                 fallback text when the turn produced none). The idle queue
                 remains attached through the asynchronous reply send; typed
                 guidance during that window is drained to the handoff buffer
                 at detach and claimed by the next turn, not lost in a stale
                 queue. Typed REPL lines have their own contract: with no
                 pending prompt consumer they steer the active turn; when the
                 user prompt is pending, a line resolves that prompt and queues
                 a user turn behind the mutex. The mutex (`withTurn`) serializes
                 user and Telegram idle turns on shared context — two turns
                 never run concurrently. `stop()` prevents reserved-but-not-yet-
                 started turn bodies from running; `stopAndDrain()` waits for
                 queued/running turns to settle. `/restart` stops dispatch and
                 drains the mutex before tearing down MCP.
```

**Loop prevention and lifecycle** (the driver's core requirement): a naive
`while (true) { poll(); }` hot-spins whenever a poll fails fast (network
down, bad token → 401). The driver makes that impossible with three
independent mechanisms: long-poll self-pacing (each poll blocks up to 15 s,
so a no-message cycle takes ~15 s), a min-interval guard (hard cap between
poll STARTS even if a poll returns instantly), and capped exponential backoff
on failure (a persistent fast-failure settles to one poll per `failCapMs`,
default 60 s; any success resets it). The loop boundary contains all errors
— `start()`'s promise never rejects unhandled. `stop()` aborts the in-flight
long-poll and wakes any sleep. It is also lifecycle cancellation: any turn
reserved on the mutex but not yet started resolves `undefined` without
running its body. Already-running turns still need their own controller
aborted by the caller; `stopAndDrain()` then waits for all queued/running
turns to settle. Closing/restarting a driver must abort the active run before
draining when the run may be blocked on model/tool work.

Per-message routing inside the loop: steer when a turn is in flight; run an
idle turn when `allowIdleTurns` is not false and `onIdle` exists; drop
otherwise. A throwing handler is guarded per message (one bad message never
loses the batch or kills the loop).

**Chat allowlist (M2)**: a bot's `getUpdates` queue carries every chat that
ever talked to it. Both bridges filter at parse time
(`parseTelegramPollOutput` + `telegramAllowedChatIds` in
`src/telegram/paths.ts`) — messages from any chat other than the configured
`chatId` never reach the model.

## How to run

1. **Setup once**: create a bot with @BotFather, write the token and chat id
   into `~/.tre/telegram.json` (never committed — machine-level state). The
   skill (`~/.tre/agent/skills/telegram/SKILL.md`) walks through it; the
   chat id comes from `telegram.py chatids` after the user messages the bot.
2. **Start a session** — the TUI (`tui`), the plain REPL (bare `tre.`, or
   `--plain` on a TTY), or one-shot (`run "…"`). When the config and the
   helper exist, the poller starts
   automatically and announces itself:
   - TUI: `telegram: polling every 15s (reply via bot)` (a chat item)
   - REPL: `telegram: polling every 15s (long-poll; reply via bot)` (stderr)
   - one-shot: silent — the driver starts with the run and steers only.

   Per-mode routing of incoming messages:

   | mode | idle | busy (turn in flight) |
   | --- | --- | --- |
   | TUI | a message starts a real run; the run's final text is sent back (fallback text when the turn produced none) | steered into the running turn; the batch is echoed as `telegram: N message(s) steered into the running turn` |
   | REPL | idle message runs a turn and replies via bot; typed guidance during the reply-send await is preserved for the next turn | Telegram messages steer the attached turn queue; typed lines steer only when no REPL prompt consumer is pending, otherwise they resolve that prompt and its turn waits behind the mutex |
   | one-shot | **no reply path** — dropped (single-turn contract) | steered into the run as guidance (startup backlog included) |
   | `--plain` | forces the REPL path above — same idle+busy behavior | — |

3. **Do NOT run `telegram.py poll` manually while a session is open** — the
   poll consumes the pending updates from Telegram's queue (`getUpdates`
   advances the offset), so the driver's next poll can never see the
   message. No manual subcommand is a proven-safe peek while a session
   runs: `chatids` uses `getUpdates offset=-20`, and a negative-offset
   request FORGETS older updates in Telegram's buffer — it can drop the
   backlog a session poller has not read yet. Chat discovery is a
   setup-time step: do it before starting a session, or inside one started
   with `--no-telegram` (any mode — it disables this process's poller, so no
   consumer races you).
4. **Send a notification without a live session** (the drivers only exist
   while their session runs): write the text to the machine state dir and
   invoke the helper directly —

   ```bash
   printf '%s\n' "<message text>" > ~/.tre/telegram/out.txt
   python3 ~/.tre/agent/skills/telegram/telegram.py send ~/.tre/telegram/out.txt
   ```

5. **Single-consumer contract — one bot, one machine, one consumer.** The
   offset file (`~/.tre/telegram/last_update_id`) is shared by every helper
   invocation on the machine, and Telegram allows only one
   `getUpdates` consumer per bot at a time (a second one gets 409). So:
   never run a second tre. session (or any poller) against the same bot
   while one is open, and never put the same bot config on two machines.
   Concurrent pollers race on the shared offset and can consume, skip, or
   duplicate each other's updates. One bot config = one session at a time.
6. **Disable**: delete or rename `~/.tre/telegram.json` — every startup
   falls back to plain stdin/TUI behavior (the bridges are `enabled: false`
   and never spawn).

## Testing

- `test/telegram-paths.test.ts` — helper-path resolution across the two
  skill roots (the 2026-10-02 "message sat undelivered" fix).
- `test/telegram-chat-filter.test.ts` — M2 cross-chat leak: pure parse +
  both bridges end-to-end with fake python3 helpers emitting multi-chat
  batches.
- `test/tui-telegram.test.ts` — the TUI bridge's error surfacing (helper
  stderr in the thrown error, the 135 s backstop cap naming a timeout-kill)
  and the pure TUI steer helpers (`steerTelegramBatch` / `steerTelegramBusy`).
- `test/telegram-driver.test.ts` — the plain-CLI driver + bridge + main.ts
  wiring: loop prevention (backoff growth/cap, success reset, min-interval
  guard against an instantly-returning poll), steer-vs-idle routing,
  `allowIdleTurns=false` never starting an idle turn, handler/loop error
  containment, stop/stopAndDrain lifecycle, disabled-bridge no-ops, the
  turn mutex, and the real `main()` paths (one-shot mid-run steer with no
  bot reply, REPL mid-run steer, REPL idle turn + reply, and the disabled
  regressions) driven through the injectable `telegramBridge` /
  `telegramDriverOpts` seams in `MainDeps`.
