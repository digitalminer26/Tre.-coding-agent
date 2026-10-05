/**
 * TUI telegram bridge (src/tui/telegram.ts) — the 2026-10-03 "bare
 * `Command failed:` with no detail" fix.
 *
 * Two regressions are pinned:
 *   1. A helper failure must surface the helper's STDERR (its die()
 *      messages, urllib tracebacks) in the thrown error — previously the
 *      bridge only destructured `{ stdout }`, so the driver logged
 *      `telegram poll error: Error: Command failed: python3 … poll` with
 *      zero diagnostics.
 *   2. The hard cap per helper call is a BACKSTOP above the helper's own
 *      worst case (60s HTTP read + a 429 `retry_after` sleep), not the
 *      15s poll cadence — a cap below that killed the helper on every slow
 *      response / rate limit. A timeout-kill must name itself in the error.
 *
 * The helper is a FAKE (a real `python3` script) placed in the PROJECT skill
 * root (`<cwd>/.tre/skills/telegram/telegram.py`) — the resolver probes
 * project before user, so the real `~/.tre/agent/skills` is never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  makeTelegramBridge,
  TELEGRAM_TIMEOUT_MS,
  TELEGRAM_POLL_MS,
} from "../src/tui/telegram.js";

function setup(): { cwd: string; home: string; cleanup: () => void } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tre-tg-tui-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tre-tg-tui-home-"));
  // Config (enables the bridge) is MACHINE-LEVEL (~/.tre/telegram.json) —
  // written to the fake home, not the workspace. The fake helper lives in
  // the PROJECT skill root.
  fs.mkdirSync(path.join(cwd, ".tre", "skills", "telegram"), { recursive: true });
  fs.mkdirSync(path.join(home, ".tre"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".tre", "telegram.json"),
    JSON.stringify({ token: "test-token", chatId: "0" }),
  );
  const helper = path.join(cwd, ".tre", "skills", "telegram", "telegram.py");
  const cleanup = (): void => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  };
  return { cwd, home, cleanup };
}

test("default cap clears the helper's worst case (60s HTTP + 60s 429 sleep)", () => {
  // The helper's HTTP read timeout is 60s and a 429 makes it sleep the full
  // retry_after (up to 60s) before retrying once — the cap must exceed that,
  // or every slow response / rate limit kills the helper mid-flight.
  assert.ok(
    TELEGRAM_TIMEOUT_MS >= 135_000,
    `TELEGRAM_TIMEOUT_MS is ${TELEGRAM_TIMEOUT_MS} — must clear 60+60s + margin`,
  );
  // The cap is a backstop, not the pacing: the cadence stays 15s.
  assert.equal(TELEGRAM_POLL_MS, 15_000);
});

test("helper failure surfaces its stderr in the error (no bare Command failed)", async () => {
  const { cwd, home, cleanup } = setup();
  try {
    // A helper that fails the way the real one does: die() → stderr + exit 1.
    fs.writeFileSync(
      path.join(cwd, ".tre", "skills", "telegram", "telegram.py"),
      "#!/usr/bin/env python3\nimport sys\n" +
        "print('telegram: HTTP Error 429: Too Many Requests', file=sys.stderr)\n" +
        "sys.exit(1)\n",
    );
    const bridge = makeTelegramBridge(cwd, home);
    assert.equal(bridge.enabled, true);
    let err: unknown;
    try {
      await bridge.poll();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "poll() must throw on helper failure");
    const msg = (err as Error).message;
    assert.match(msg, /Command failed/, "keeps the execFile base message");
    assert.match(msg, /HTTP Error 429/, "helper stderr is included");
  } finally {
    cleanup();
  }
});

test("a timeout-kill is named in the error (cap + likely cause)", async () => {
  const { cwd, home, cleanup } = setup();
  try {
    // A helper that outlives the (injected, short) cap.
    fs.writeFileSync(
      path.join(cwd, ".tre", "skills", "telegram", "telegram.py"),
      "#!/usr/bin/env python3\nimport time\ntime.sleep(30)\n",
    );
    const bridge = makeTelegramBridge(cwd, home, 500); // 0.5s cap for the test
    let err: unknown;
    try {
      await bridge.poll();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error, "poll() must throw on timeout-kill");
    const msg = (err as Error).message;
    assert.match(msg, /killed at the 1s cap/, "the kill + cap value are named");
    assert.match(msg, /429 retry_after|slow Telegram/, "the likely cause is named");
  } finally {
    cleanup();
  }
});

test("a clean poll still returns null (no regression on the happy path)", async () => {
  const { cwd, home, cleanup } = setup();
  try {
    fs.writeFileSync(
      path.join(cwd, ".tre", "skills", "telegram", "telegram.py"),
      "#!/usr/bin/env python3\nprint('telegram: no new messages')\n",
    );
    const bridge = makeTelegramBridge(cwd, home);
    assert.equal(await bridge.poll(), null);
  } finally {
    cleanup();
  }
});
