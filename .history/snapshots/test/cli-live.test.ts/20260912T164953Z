/**
 * WS6 — LIVE vertical slice (PLAN.md §4). Gated behind RUN_LIVE=1
 * (mirrors test/wire-live.test.ts): `RUN_LIVE=1 npm test`.
 *
 * Scenarios (each is one CLI `run` against the real endpoint in models.json):
 *   1. tools none  — "say hello" → one LLM call, streamed text
 *   2. bash only   — "list files in cwd" → a real tool-call round-trip
 *   3. read/write/edit — create hello.txt with 'hi', read it back → the file
 *      actually exists on disk with the right content.
 * At scenario 3 the harness is a real coding agent.
 *
 * Note: the local server runs --parallel 1 (single slot) — long generations
 * can queue briefly; each scenario gets 5 minutes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { main } from "../src/cli/main.js";
import { replaySession } from "../src/session/session.js";

const RUN_LIVE = process.env.RUN_LIVE === "1";
const LIVE_TIMEOUT_MS = 300_000;

// Tests run from the repo root (npm test). Resolve the models file to an
// ABSOLUTE path up front: slice 3 process.chdir()s into a temp dir.
const MODELS = resolve(process.cwd(), "models.json");

async function liveRun(t: test.TestContext, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  // The write callback is load-bearing: main() awaits it in flushSinks.
  const sinks = {
    out: {
      write: (s: string, cb?: () => void) => {
        out += s;
        cb?.();
        return true;
      },
    },
    err: {
      write: (s: string, cb?: () => void) => {
        err += s;
        cb?.();
        return true;
      },
    },
  };
  const code = await main(argv, { sinks: sinks as never });
  return { code, out, err };
}

test("live slice 1: 'say hello' with zero tools", { skip: !RUN_LIVE, timeout: LIVE_TIMEOUT_MS }, async (t) => {
  const { code, out, err } = await liveRun(t, [
    "run",
    "Say hello. Reply with exactly one short sentence.",
    "--tools",
    "none",
    "--models",
    MODELS,
  ]);
  assert.equal(code, 0, `exit ${code}; stderr: ${err}`);
  assert.match(out.trim(), /\S/, "expected streamed assistant text");
  assert.match(out, /hello/i, "expected the model to actually say hello");
});

test("live slice 2: bash-only 'list files in cwd' does a real tool round-trip", {
  skip: !RUN_LIVE,
  timeout: LIVE_TIMEOUT_MS,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-cli-live2-"));
  t.after(() => import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true })));
  const session = join(dir, "s.jsonl");
  const { code, out, err } = await liveRun(t, [
    "run",
    "Use the bash tool to list the files in your working directory, then summarize what you found.",
    "--tools",
    "bash",
    "--models",
    MODELS,
    "--session",
    session,
  ]);
  assert.equal(code, 0, `exit ${code}; stderr: ${err}`);
  assert.match(out, /→ bash/, "expected a bash tool-call line");
  const replayed = await replaySession(session);
  const trs = replayed.context.filter((m) => m.role === "toolResult");
  assert.ok(trs.length >= 1, "expected at least one toolResult in the session");
  const tr = trs[0]!;
  if (tr.role === "toolResult") assert.equal(tr.toolName, "bash");
});

test("live slice 3: read/write/edit — create hello.txt with 'hi', read it back", {
  skip: !RUN_LIVE,
  timeout: LIVE_TIMEOUT_MS,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-cli-live3-"));
  t.after(() => import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true })));
  const session = join(dir, "s.jsonl");
  // Tools resolve relative paths against the PROCESS cwd — chdir the test
  // process so 'hello.txt' lands in the temp dir (WS7 will sandbox this).
  const prevCwd = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(prevCwd));
  const { code, out, err } = await liveRun(t, [
    "run",
    "Create a file named hello.txt in your working directory containing exactly the text 'hi' (no quotes), then read it back and tell me its content.",
    "--tools",
    "read,write,edit",
    "--cwd",
    dir,
    "--models",
    MODELS,
    "--session",
    session,
  ]);
  assert.equal(code, 0, `exit ${code}; stderr: ${err}`);
  assert.match(out, /→ (write|read|edit)/, "expected file tool calls");
  const content = await readFile(join(dir, "hello.txt"), "utf8");
  assert.equal(content, "hi");
});
