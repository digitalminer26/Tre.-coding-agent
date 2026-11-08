/**
 * Telegram bridge for the PLAIN CLI (one-shot + REPL) — the same stdlib-
 * `python3` helper the TUI uses, resolved across the canonical skill roots
 * (`<cwd>/.tre/skills` then `~/.tre/agent/skills`; see ./paths.ts), but with
 * a LONG-POLL seam (`pollLong`) for the background driver.
 *
 * Why python3 (not node/curl): under the tre. kernel sandbox, curl and git
 * fail TLS and node is not on the sandboxed PATH; python3 (/usr/bin/python3)
 * is on the PATH and its urllib TLS works — verified. The LLM endpoint is
 * NOT involved in polling: a poll is one HTTPS GET to the Telegram Bot API
 * (`getUpdates`); the LLM is only spent when a real message arrives and a
 * turn runs to answer it.
 *
 * The TUI keeps its own bridge (src/tui/telegram.ts) with a non-blocking
 * `setInterval` poller; this one adds `pollLong(timeoutSec, signal)` so the
 * background driver can block up to N seconds per poll (lower latency, fewer
 * spawns) and be interrupted on stop. The spawn logic is intentionally a
 * small duplicate of the TUI's rather than a shared refactor — keeping the
 * TUI untouched (see HANDOFF for the future consolidation).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  resolveTelegramHelper,
  telegramConfigPath,
  telegramStateDir,
  telegramAllowedChatIds,
  parseTelegramPollOutput,
} from "./paths.js";

const pExecFile = promisify(execFile);

/** The poll's long-poll window (seconds) — the driver blocks up to this per
 *  poll, so the loop self-paces (no hot loop). 15s is the default. */
export const TELEGRAM_LONG_POLL_SEC = 15;
/** Hard cap per helper call. The helper's own HTTP read is
 *  `60 + pollTimeoutSec`; this spawn timeout is a BACKSTOP above that (a hung
 *  python process must not wedge the driver). */
const TELEGRAM_SPAWN_MARGIN_MS = 90_000;

export interface TelegramMessage {
  chatId: string;
  sender: string;
  text: string;
}

/** P18-A1 (sol audit cycle 1): the outcome of one helper `send`. A zero
 *  helper exit is NOT an acknowledgment of a fresh network send — the
 *  installed helper's duplicate guard prints and exits 0 WITHOUT touching
 *  the API. Callers that claim delivery (docs/19 §5: delivered vs refused)
 *  must consume this outcome, never infer delivery from process success. */
export interface TelegramSendOutcome {
  /** True when the helper reported it actually sent (`sent N message(s)`). */
  sent: boolean;
  /** True when the helper explicitly SUPPRESSED the send (duplicate guard). */
  skippedDuplicate: boolean;
  /** The helper's stdout, newline-flattened + bounded — safe for logs. */
  detail: string;
}

const HELPER_DETAIL_CAP = 200;

// P18-C3 (audit cycle 2, finding 1): the grammar below is PINNED TO THE
// INSTALLED HELPER'S REAL PRINTS (telegram.py: `telegram: sent {n}
// message(s) to chat {chat}` and `telegram: skipped duplicate send (same
// content sent {age}s ago < {cooldown}s cooldown; --force to override)`).
// An earlier revision matched a SHORT HYPOTHETICAL form (`telegram: sent
// 1 message(s)`, no destination) that the real helper never prints — so
// every genuine send classified as unattested and every real suppression
// burned its budget. Short forms are now NOT believed: only the full real
// grammar, at column zero, counts. Fail-closed directions are preserved:
// unrecognized output is unattested (no delivery claim), and a
// contradictory transcript attests nothing at all.
const HELPER_SENT_RE = /^telegram: sent ([1-9]\d*) message\(s\) to chat \S+\r?$/;
const HELPER_SKIP_RE = /^telegram: skipped duplicate send \(same content sent \d+s ago < \d+s cooldown; --force to override\)\r?$/;

/** Classify helper send stdout (P18-A1). Pure: no I/O. `sent:` requires
 *  the helper's success line at COLUMN ZERO matching the complete helper
 *  grammar with a POSITIVE message count and a destination — a hostile
 *  line embedded in task text can't fake it (P18-C2 F8, sol audit cycle
 *  1: an indented line, `sent 0 message(s)`, or a suffixed line used to
 *  attest delivery; and success + suppression in one transcript is
 *  contradictory output, so NEITHER claim stands — fail closed).
 *  Unrecognized output is `sent:false` (no delivery claim); the escalation
 *  consumer turns that into a failed send so it is disclosed, and an
 *  explicit suppression refunds the redeliver budget. */
export function classifyTelegramSendOutput(stdout: string): TelegramSendOutcome {
  const detail = String(stdout).replace(/\s+/g, " ").trim().slice(0, HELPER_DETAIL_CAP);
  let sent = false;
  let skippedDuplicate = false;
  for (const line of String(stdout).split("\n")) {
    // Column-zero, whole-line match against the REAL helper prints (an
    // optional trailing CR from a CRLF-spawning helper is the ONLY
    // tolerated suffix).
    if (HELPER_SENT_RE.test(line)) sent = true;
    if (HELPER_SKIP_RE.test(line)) skippedDuplicate = true;
  }
  // F8: contradictory status output attests NOTHING — neither delivery
  // nor an intentional suppression. Both claims fall to false (unattested).
  if (sent && skippedDuplicate) {
    sent = false;
    skippedDuplicate = false;
  }
  return { sent, skippedDuplicate, detail };
}

/** The driver's I/O seam. `pollLong` blocks up to `timeoutSec` for a message
 *  (returning null on timeout) and MUST honor `signal` (the driver kills the
 *  in-flight poll on stop). Throws on a helper failure (the driver backs off). */
export interface TelegramBridge {
  /** True once the `~/.tre/telegram.json` config + the helper exist (setup done). */
  enabled: boolean;
  /** One long-poll: block up to `timeoutSec` seconds. Null when no message. */
  pollLong(timeoutSec: number, signal?: AbortSignal): Promise<TelegramMessage[] | null>;
  /** Send `text` to the configured chat (chunked by the helper). Resolves
   *  void for driver compatibility; `sendResult` carries the classified
   *  outcome (P18-A1) for delivery-claiming callers. */
  send(text: string): Promise<void>;
  /** Send AND report the classified helper outcome (P18-A1). Throws only
   *  when the helper itself failed (non-zero exit / spawn failure). */
  sendResult?(text: string): Promise<TelegramSendOutcome>;
}

/**
 * Build a bridge for the workspace `cwd`. `enabled` is false when the
 * machine-level config (`~/.tre/telegram.json`) or the helper is missing
 * (setup not done) — the driver then never starts. The helper resolves its
 * config/state against `~/.tre` (machine-level, see ./paths.ts), so the
 * spawn's cwd does not affect the bot's paths. `home` is injectable for
 * tests.
 */
export function makeTelegramBridge(
  cwd: string,
  home: string = homedir(),
): TelegramBridge {
  // Resolve the helper across the canonical skill roots (project then user
  // agent-skills) — see ./paths.ts. The config + state are MACHINE-LEVEL
  // (~/.tre) — a bot configured once works from any launch dir.
  const script = resolveTelegramHelper(cwd, home);
  const outDir = telegramStateDir(home);
  // M2 (cross-chat leak): the owner's chat id, from the machine-level config
  // — foreign-chat messages are dropped at parse time (see ./paths.ts).
  const allowedChats = telegramAllowedChatIds(home);
  const enabled =
    existsSync(telegramConfigPath(home)) && script !== null;
  const run = async (args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> => {
    if (script === null) {
      throw new Error(
        "telegram: helper not found in any skill root " +
          "(<cwd>/.tre/skills or ~/.tre/agent/skills) — the bridge is disabled",
      );
    }
    const { stdout } = await pExecFile("python3", [script, ...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      signal, // on abort, node kills the child (the in-flight long-poll ends)
    });
    return stdout;
  };
  const parse = (out: string): TelegramMessage[] | null => {
    const t = out.trim();
    if (t === "" || t.startsWith("telegram: no new messages")) return null;
    // M2: shared parse + chat allowlist (see ./paths.ts) — messages from a
    // chat other than the configured one never reach the model.
    const msgs: TelegramMessage[] = parseTelegramPollOutput(out, allowedChats).map(
      ([chatId, sender, text]) => ({ chatId, sender, text }),
    );
    return msgs.length > 0 ? msgs : null;
  };
  // P18-C2 F6 (sol audit cycle 1): a per-send EXCLUSIVE file, not the
  // shared out.txt. Two concurrent sends (driver idle-reply + escalation
  // deliver, or two episodes on one machine) used to overwrite each other
  // before the helper read the file — A's helper could send B's body and
  // print a legitimate success line, attesting delivery of a message the
  // human never received. `wx` proves the name is fresh; the file is
  // removed once the helper has returned.
  let sendSeq = 0;
  const sendImpl = async (text: string): Promise<TelegramSendOutcome> => {
    // The write tool is workspace-confined, but this is the driver (not the
    // agent under test) — a direct fs write of the message body is the same
    // boundary the skill's send flow uses.
    mkdirSync(outDir, { recursive: true });
    let file = "";
    for (let tries = 0; tries < 5; tries++) {
      sendSeq += 1;
      const candidate = join(outDir, `out.${process.pid}.${sendSeq}.${Math.floor(Math.random() * 2 ** 32).toString(36)}.txt`);
      try {
        writeFileSync(candidate, text, { encoding: "utf8", flag: "wx" });
        file = candidate;
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // name collision (astronomically unlikely): retry with a new one
      }
    }
    if (file === "") throw new Error("telegram: could not create an exclusive send file");
    try {
      // P18-A1: capture the helper's stdout — exit 0 alone is NOT a send
      // (the duplicate guard prints and exits 0 without the API).
      const out = await run(["send", file], 60_000);
      return classifyTelegramSendOutput(out);
    } finally {
      try { rmSync(file, { force: true }); } catch { /* best effort */ }
    }
  };
  return {
    enabled,
    async pollLong(timeoutSec, signal) {
      // The spawn timeout is the long-poll window + the helper's HTTP margin
      // + headroom — a backstop, not the primary pacing (the long-poll is).
      const out = await run(
        ["poll", "--timeout", String(timeoutSec)],
        (timeoutSec + 60 + TELEGRAM_SPAWN_MARGIN_MS / 1000) * 1000,
        signal,
      );
      return parse(out);
    },
    async send(text) {
      await sendImpl(text);
    },
    async sendResult(text) {
      return sendImpl(text);
    },
  };
}
