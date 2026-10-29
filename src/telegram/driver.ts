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
 * returns in milliseconds instead of blocking 15s, and the loop then spawns
 * hundreds of processes/second, hammering the network and tripping Telegram
 * rate limits. This driver makes that impossible with THREE independent
 * mechanisms:
 *   1. LONG-POLL SELF-PACING — each poll blocks up to 15s, so a no-message
 *      cycle takes ~15s. The loop cannot run faster than ~1 poll/15s.
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
import type { SteeringQueue } from "../loop/agent-loop.js";

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
  onIdle?(msgs: TelegramMessage[], pendingSteers?: string[]): Promise<void>;
}

export interface TelegramDriverOptions {
  /** Base delay for the failure backoff (ms). Default 1000. */
  failBaseMs?: number;
  /** Cap on the failure backoff (ms). Default 60000 (a persistent failure
   *  settles to one poll per minute — never a hot loop). */
  failCapMs?: number;
  /** Minimum interval between poll STARTS (ms) — the loop-prevention hard
   *  cap. Default: TELEGRAM_LONG_POLL_SEC × 1000 (15s). */
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
  /** True while a turn (user or telegram) is queued or executing. */
  private pendingTurns = 0;
  private followUpQueued = false;
  /** The turn mutex: a promise chain that serializes turn execution. */
  private turnChain: Promise<void> = Promise.resolve();

  constructor(
    private bridge: TelegramBridge,
    private handlers: TelegramDriverHandlers,
    private opts: TelegramDriverOptions = {},
  ) {}

  /** A turn (user or telegram) is currently in flight. */
  get turnInFlight(): boolean {
    return this.pendingTurns > 0;
  }

  /** Reserve a turn synchronously, then execute its body under the mutex.
   * Polls can steer into the handoff buffer even before the body starts.
   *
   * F2 — `stop()` is a LIFECYCLE cancellation, not just a poll stop: a body
   * that was reserved but had not started when stop() fired (it was parked
   * on `await prev`) is CANCELLED — its `fn` never runs and the promise
   * resolves `undefined`. Without this check the body would start after the
   * previous holder released, and (for the idle path) build a fresh,
   * unaborted controller the caller's abort can no longer reach — violating
   * stopAndDrain()'s contract that no turn may run to completion during a
   * drain. A body already RUNNING is settled by the caller aborting the
   * turn's OWN controller (the shared `controller` in main.ts is reassigned
   * to it when the body starts); the drain then waits for its finallys. */
  async withTurn<T>(fn: () => Promise<T>): Promise<T | undefined> {
    this.pendingTurns += 1;
    const prev = this.turnChain;
    let release!: () => void;
    this.turnChain = new Promise<void>((r) => (release = r));
    await prev;
    if (this.stopped) {
      // Reserved-but-unstarted at stop time: release the mutex without
      // running the body (F2 lifecycle cancellation).
      this.pendingTurns -= 1;
      release();
      return undefined;
    }
    try {
      return await fn();
    } finally {
      this.pendingTurns -= 1;
      release();
      this.scheduleFollowUp();
    }
  }

  /** Steers whose dispatch raced a turn handoff (session-local ownership): claimed
   *  while no turn body had attached its steer queue yet. Cleared by the next
   *  attachSteerTarget — a steer that raced a turn START or a turn END
   *  reaches the next body's context drain instead of being lost. */
  private deferredSteers: string[] = [];
  /** Number of steers still waiting in the handoff buffer (diagnostics). */
  pendingSteers(): number { return this.deferredSteers.length; }

  /** The steer target of the turn currently holding the mutex (set by
   *  attachSteerTarget, cleared by detachSteerTarget). */
  private steerTarget: SteeringQueue | null = null;
  /** The label of the currently attached body (for direct-steer claims). */
  private steerTargetLabel: string | undefined = undefined;

  /** Attach the running turn's steer queue — call at the START of the turn
   *  body, inside withTurn; pass the SAME queue the loop drains. First
   *  drains the handoff buffer and returns the messages claimed while no
   *  queue was attached (in arrival order) — the body injects them like any
   *  steer. After this call, steers route directly into `queue`. `label`
   *  (when given) tags each claimed message with the body that claimed it —
   *  for tests and operator visibility into the buffer drain (e.g. a typed
   *  line's body claiming telegram text polled before the handoff). */
  attachSteerTarget(queue: SteeringQueue, label?: string): string[] {
    const claimed = this.deferredSteers;
    this.deferredSteers = [];
    this.steerTarget = queue;
    this.steerTargetLabel = label;
    if (label !== undefined) {
      for (const t of claimed) this.claim({ text: t, claimedBy: label });
    }
    return claimed;
  }

  /** Every steer the driver routed, in routing order: direct pushes name the
   *  attached body's label (`"<unlabeled>"` when attached without one);
   *  claims out of the handoff buffer are recorded only by a labeled
   *  attachSteerTarget. */
  readonly steerClaims: { text: string; claimedBy: string }[] = [];

  /** Detach at the END of the turn body (finally, inside the mutex). Any
   *  steer that races between the detach and the mutex release lands in the
   *  buffer instead of the finished turn's queue — and reaches the next
   *  turn via attachSteerTarget. */
  detachSteerTarget(): void {
    const queue = this.steerTarget;
    this.steerTarget = null;
    this.steerTargetLabel = undefined;
    if (queue) this.deferredSteers.push(...queue.drain());
    this.scheduleFollowUp();
  }

  /** A settled REPL turn must not strand messages until another user types.
   * Reserve one follow-up behind already queued turns; those turns get first
   * chance to claim the buffer. Never manufacture another one-shot turn. */
  private scheduleFollowUp(): void {
    if (this.stopped || this.pendingTurns > 0 || this.followUpQueued ||
        this.deferredSteers.length === 0 || this.opts.allowIdleTurns === false || !this.handlers.onIdle) return;
    this.followUpQueued = true;
    void this.withTurn(async () => {
      this.followUpQueued = false;
      if (this.stopped || this.deferredSteers.length === 0) return;
      const pending = this.deferredSteers;
      this.deferredSteers = [];
      try {
        await this.handlers.onIdle!([], pending);
      } catch (err) {
        this.opts.onHandlerError?.(err);
      }
    });
  }

  /** Route one message: direct to the attached queue, else into the
   *  handoff buffer (claimed by the next turn body). Use this from the
   *  onSteer handlers — pushing to a captured queue directly loses messages
   *  that race the mutex handoff. */
  steer(msg: string): void {
    if (this.steerTarget) {
      this.steerTarget.push(msg);
      this.claim({ text: msg, claimedBy: this.steerTargetLabel ?? "<unlabeled>" });
    } else {
      this.deferredSteers.push(msg);
    }
  }

  /** Append a claim, keeping the log bounded (long-lived REPLs route many
   *  direct steers; only the most recent claims are interesting). */
  private claim(entry: { text: string; claimedBy: string }): void {
    this.steerClaims.push(entry);
    if (this.steerClaims.length > 256) this.steerClaims.splice(0, this.steerClaims.length - 256);
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

  /** Stop dispatch and wait for all turns already queued/running to settle.
   *  The caller must first abort its active turn's controller: polling's
   *  AbortController is deliberately independent of the agent run. */
  async stopAndDrain(): Promise<void> {
    this.stop();
    await this.turnChain;
  }

  private async loop(): Promise<void> {
    const minInterval = this.opts.minIntervalMs ?? TELEGRAM_LONG_POLL_SEC * 1000;
    const failBase = this.opts.failBaseMs ?? 1000;
    const failCap = this.opts.failCapMs ?? 60_000;
    let consecutiveFails = 0;
    // The loop boundary contains ALL errors: `start()`'s promise must never
    // reject unhandled (callers discard it with `void driver.start()`, and an
    // unhandled rejection can terminate the host CLI/TUI process). An
    // unexpected error is reported and the loop stops gracefully.
    try {
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
            // Guard PER MESSAGE (mirrors the idle path): a throwing handler
            // must not lose the remaining messages or reject the loop.
            for (const m of msgs) {
              try {
                this.handlers.onSteer(m);
              } catch (err) {
                this.opts.onHandlerError?.(err);
              }
            }
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
    } catch (err) {
      // Unexpected error outside the poll's own try/catch (e.g. a throw from
      // an unguarded code path): report it and STOP the loop gracefully —
      // never let it reject `start()`'s promise.
      this.opts.onHandlerError?.(err);
      this.stopped = true;
    }
  }
}
