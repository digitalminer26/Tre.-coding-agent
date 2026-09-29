/**
 * Background Telegram driver for the PLAIN CLI (one-shot + REPL).
 *
 * It long-polls the bot in the background (one `getUpdates` per cycle,
 * blocking up to `TELEGRAM_LONG_POLL_SEC` seconds) and turns incoming
 * messages into agent actions:
 *   - a turn is in flight  → STEER the message into the running turn;
 *   - idle                 → run a turn and reply via the bot.
 *
 * The LLM endpoint is NOT involved in polling (a poll is one HTTPS GET);
 * the LLM is only spent when a real message arrives and a turn runs.
 *
 * ── LOOP PREVENTION (the core requirement) ────────────────────────────────
 * A naive `while (true) { poll(); }` has a hot-spin hazard: if a poll FAILS
 * FAST (network down, sandbox blocks the connection, a bad token → 401), it
 * returns in milliseconds instead of blocking 30s, and the loop then spawns
 * hundreds of processes/second, hammering the network and tripping Telegram
 * rate limits. This driver makes that impossible with THREE independent
 * mechanisms:
 *   1. LONG-POLL SELF-PACING — each poll blocks up to 30s, so a no-message
 *      cycle takes ~30s. The loop cannot run faster than ~1 poll/30s.
 *   2. MIN-INTERVAL GUARD — a hard backstop: even if a poll returns INSTANTLY
 *      (a helper that ignores --timeout, or a fast failure), the loop sleeps
 *      to keep ≥ `minIntervalMs` between poll STARTS. This is what kills the
 *      hot-spin regardless of how fast the poll returns.
 *   3. CAPPED EXPONENTIAL BACKOFF ON FAILURE — a fast-failing poll backs off
 *      `min(failBaseMs · 2ⁿ, failCapMs)`, so a PERSISTENT failure settles to
 *      one poll per `failCapMs` (default 60s) — never a spin. A success
 *      (even "no message") resets the backoff.
 * The driver is also INTERRUPTIBLE (stop() kills the in-flight poll child and
 * wakes any sleep) and SINGLE-FLIGHT (a turn mutex serializes user + telegram
 * turns, so two turns never run concurrently on the shared context).
 */
import { TELEGRAM_LONG_POLL_SEC, type TelegramBridge, type TelegramMessage } from "./bridge.js";

/** Sleep for `ms`, resolving early if `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface TelegramDriverHandlers {
  /** A message arrived while a turn is in flight: steer it into the run. */
  onSteer(msg: TelegramMessage): void;
  /** A message arrived while idle: run a turn and reply via the bot. Optional
   *  — a one-shot driver (allowIdleTurns: false) never calls it. */
  onIdle?(msgs: TelegramMessage[]): Promise<void>;
}

export interface TelegramDriverOptions {
  /** Base delay for the failure backoff (ms). Default 1000. */
  failBaseMs?: number;
  /** Cap on the failure backoff (ms). Default 60000 (a persistent failure
   *  settles to one poll per minute — never a hot loop). */
  failCapMs?: number;
  /** Minimum interval between poll STARTS (ms) — the loop-prevention hard
   *  cap. Default: TELEGRAM_LONG_POLL_SEC × 1000 (30s). */
  minIntervalMs?: number;
  /** When false (one-shot), a message that arrives with no turn in flight is
   *  NOT turned into a new run (one-shot is a single turn; it only steers).
   *  Default true (REPL). */
  allowIdleTurns?: boolean;
  /** Called on a poll failure with the computed backoff delay (ms). */
  onPollError?: (err: unknown, delayMs: number) => void;
  /** Called on an idle-turn (onIdle) failure. */
  onHandlerError?: (err: unknown) => void;
}

export class TelegramDriver {
  private stopped = false;
  private started = false;
  private abort = new AbortController();
  /** True while a turn body (user or telegram) is executing. */
  private holding = false;
  /** The turn mutex: a promise chain that serializes turn execution. */
  private turnChain: Promise<void> = Promise.resolve();

  constructor(
    private bridge: TelegramBridge,
    private handlers: TelegramDriverHandlers,
    private opts: TelegramDriverOptions = {},
  ) {}

  /** A turn (user or telegram) is currently in flight. */
  get turnInFlight(): boolean {
    return this.holding;
  }

  /** Run `fn` with the turn mutex held — serializes user + telegram turns so
   *  two turns never run concurrently on the shared context. `turnInFlight`
   *  is true for the duration of the body. */
  async withTurn<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.turnChain;
    let release!: () => void;
    this.turnChain = new Promise<void>((r) => (release = r));
    await prev;
    this.holding = true;
    try {
      return await fn();
    } finally {
      this.holding = false;
      release();
    }
  }

  /** Start the background poll loop (no-op if the bridge is not enabled or
   *  already started). Returns the loop's promise (resolves on stop). */
  start(): Promise<void> {
    if (this.started || this.stopped || !this.bridge.enabled) return Promise.resolve();
    this.started = true;
    return this.loop();
  }

  /** Stop the loop: kill the in-flight poll child and wake any sleep. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
  }

  private async loop(): Promise<void> {
    const minInterval = this.opts.minIntervalMs ?? TELEGRAM_LONG_POLL_SEC * 1000;
    const failBase = this.opts.failBaseMs ?? 1000;
    const failCap = this.opts.failCapMs ?? 60_000;
    let consecutiveFails = 0;
    while (!this.stopped) {
      const iterStart = Date.now();
      let msgs: TelegramMessage[] | null | undefined;
      try {
        msgs = await this.bridge.pollLong(TELEGRAM_LONG_POLL_SEC, this.abort.signal);
        consecutiveFails = 0; // a successful poll (even "no message") resets backoff
      } catch (err) {
        msgs = undefined; // sentinel: the poll FAILED (fast-fail)
        consecutiveFails += 1;
        // Capped exponential backoff — a persistent fast-failure settles to
        // one poll per failCap, NEVER a hot spin (loop-prevention #3).
        const delay = Math.min(failBase * 2 ** (consecutiveFails - 1), failCap);
        this.opts.onPollError?.(err, delay);
        await sleep(delay, this.abort.signal);
      }
      if (this.stopped) break;
      if (msgs !== undefined && msgs !== null) {
        // A message arrived. Steer if a turn is in flight; otherwise run an
        // idle turn (in the background, so the poll loop keeps steering).
        if (this.turnInFlight) {
          for (const m of msgs) this.handlers.onSteer(m);
        } else if (this.opts.allowIdleTurns !== false && this.handlers.onIdle) {
          void this.withTurn(async () => {
            try {
              await this.handlers.onIdle!(msgs);
            } catch (err) {
              this.opts.onHandlerError?.(err);
            }
          });
        }
      }
      // Loop-prevention #2 — the hard cap: enforce a minimum interval between
      // poll STARTS so a fast-returning poll can never hot-spin. The long-poll
      // normally provides the pacing; this is the backstop.
      const elapsed = Date.now() - iterStart;
      if (elapsed < minInterval) {
        await sleep(minInterval - elapsed, this.abort.signal);
      }
    }
  }
}
