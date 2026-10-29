# Telegram integration

Two bridges share one helper (`telegram.py` in the skill dir) and one
machine-level config (`~/.tre/telegram.json`). They differ ONLY in how the
user talks to Telegram while tre. is running:

| mode | bridge | who polls |
|---|---|---|
| interactive TUI (`tre. -c`) | `src/tui/telegram.ts` | the TUI itself (`telegramTick`) |
| plain/one-shot (`tre. run "…"`) | `src/telegram/driver.ts` | the driver, while a task is in flight |

## The one rule that makes both correct

The helper's `poll` CONSUMES the Telegram updates (long-poll offset). So
whoever polls owns the messages — and if a poll happens outside a turn, the
messages vanish. Corollaries:

- **The TUI must NOT poll from an external loop** (a `watch`/cron/script
  calling `telegram.py poll`). It only competes with the TUI's own tick for
  the offset. Use the in-TUI bridge; if it's not working, diagnose it, do NOT
  add an external poller.
- plain/one-shot mode (`tre. run "…"`) runs the SAME in-process driver
  (`createTelegramDriver` — it is shared, not TUI-only), so it polls while a
  task is in flight and steers replies into the run; you do NOT need to poll.
  **Poll manually ONLY before the first turn starts** — the startup race below.

## The startup race (both modes)

The TUI tick starts only after the first LLM turn begins (`run.tsx` starts the
timer at the initial `setState`; plain-mode `installDriver` starts it after
`input()`). A message sent while tre. is still booting is therefore NOT seen
by the driver — it sits in Telegram's queue until either the next idle tick
(TUI) or never (plain, if nothing drains it).

Fix for plain mode: a single manual poll BEFORE the turn, then the turn. The
one-time poll consumes the backlog; the driver (started once the turn begins)
answers the result to the bot.

```bash
python3 ~/.tre/agent/skills/telegram/telegram.py poll
tre. run "telegram: answer the message(s) above"
```

In the TUI there is nothing to do: once the first turn ends, the tick drains
the backlog on its next 15s cycle.

## Driver contract (plain mode) — what we intend, and what we test

`createTelegramDriver(deps)` (pure, deps-injected — see
`test/telegram-driver.test.ts`) must, per poll:

1. **Busy** (a task is in flight) → STEER every new message into the running
   loop (as `[telegram from <sender>] <text>`) and return. The running loop's
   final text is the user's answer; do NOT send a reply here.
2. **Idle** → start ONE turn with the whole batch folded into a single prompt,
   then send the turn's final text to the bot (with failure retry).

Anti-contract to keep out: "drain one message + send + drain next" loops
(sequential runs), or sending a per-message acknowledgement. The whole-batch
fold is what stops a multi-message burst from producing N runs or a stale
steering queue.

`runPrompt` must NOT `setBusy(true)` itself — it asserts
`opts.assumeBusy === true` and trusts the CALLER to have flipped busy
synchronously before any await. The only two call sites that follow that
contract are the interactive TUI's `submitInput` (and, for a Telegram batch,
`src/tui/run.tsx` — see `submitInput` for the exact pattern). `promptOnce`
does NOT flip busy: a non-interactive single prompt has no Telegram driver,
and claiming busy there is a side effect without a purpose.

## Failure modes seen in the wild

- `HTTP 409 Conflict … webhook is set` → delete the webhook in @BotFather.
- `401` → token rotated in `~/.tre/telegram.json`; update it, don't retry.
- A backgrounded `tre. run … | tee` with no stdin can sit forever in
  `input()` — it never starts the driver (the driver starts AFTER input) and
  never produces a result. Always pipe the prompt in.
- A `tre. run` whose turn finishes WHILE a Telegram poll is in flight leaves
  the poll's messages undelivered (the driver is torn down at turn end) —
  drain them at the NEXT run with the pre-turn poll above.

## Testing under the sandbox

The helper is `/usr/bin/python3` stdlib. `curl`/`git` TLS is broken inside
the tre. sandbox and `node` is not on the sandboxed PATH; network calls only
work with `sandboxx -c 'allow network*'` (see `~/.tre/sandboxx.json`). The
driver's tests are hermetic (fake deps, no network, no real helper).
