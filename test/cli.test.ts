/**
 * WS6 — CLI integration tests (in-process, fakeStream — no network).
 *
 * Exit criteria exercised (PLAN.md §WS6):
 *   - one-shot `run`: prompt → loop → streamed events → exit code
 *   - real tool round-trip through the CLI (bash tool, scripted LLM)
 *   - session persistence around a run (user msg BEFORE the run, run's new
 *     messages after) and resume (second run seeded with replayed context)
 *   - error-as-data: provider error → exit 1, no throw (I3)
 *   - arg parsing failures → exit 2
 *   - WS7: gated tool calls (bash/write/edit) go through the safety hooks —
 *     approval (injected askApproval / --yes / --no-approve), denial →
 *     isError result, path sandbox (absolute & ../ escapes, --cwd root)
 * Live vertical slice: test/cli-live.test.ts (RUN_LIVE=1).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fakeStream } from "./fake-stream.js";
import {
  exitCodeFor,
  main,
  parseArgs,
  printEvent,
  resolveTools,
  runTurn,
  type PrintSinks,
} from "../src/cli/main.js";
import { Session, replaySession } from "../src/session/session.js";
import { deriveMaxTurns } from "../src/loop/agent-loop.js";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  LlmContext,
  ModelConfig,
  StreamFn,
  UserMessage,
} from "../src/types.js";

const MODEL: ModelConfig = {
  id: "fake-model",
  provider: "fake",
  baseUrl: "http://fake.invalid/v1",
  api: "openai-completions",
  contextWindow: 32000,
  maxTokens: 4096,
};

async function makeModelsFile(dir: string): Promise<string> {
  const p = join(dir, "models.json");
  await writeFile(p, JSON.stringify({ default: MODEL.id, models: [MODEL] }));
  return p;
}

const userMsg = (text: string): UserMessage => ({
  role: "user",
  content: text,
  timestamp: 1,
});

/** Temp dir + models file, cleaned up in t.after. */
async function workspace(t: test.TestContext): Promise<{ dir: string; models: string }> {
  const dir = await mkdtemp(join(tmpdir(), "om-cli-"));
  t.after(() => import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true })));
  const models = await makeModelsFile(dir);
  return { dir, models };
}

/** String-buffer sinks for main() (Node 26's process.stdout is getter-only — no global swap). */
function mkSinks() {
  let out = "";
  let err = "";
  return {
    sinks: {
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
    } as PrintSinks,
    out: () => out,
    err: () => err,
  };
}

// ─────────────────────────────── parsing ───────────────────────────────

test("parseArgs: one-shot prompt + flags", () => {
  const a = parseArgs(["run", "create", "hello.txt", "--tools", "bash", "--model", "m1", "--max-turns", "8"]);
  assert.deepEqual(a.errors, []);
  assert.equal(a.oneShot, true);
  assert.equal(a.prompt, "create hello.txt");
  assert.equal(a.tools, "bash");
  assert.equal(a.modelId, "m1");
  assert.equal(a.maxTurns, 8);
});

test("parseArgs: C24 — maxTurns defaults to undefined (derive from model); --max-turns overrides", () => {
  // No --max-turns → undefined, so runLoop derives the cap from the model's
  // contextWindow/maxTokens (the runaway guard is still on, just resized).
  assert.equal(parseArgs(["run", "x"]).maxTurns, undefined);
  assert.equal(parseArgs([]).maxTurns, undefined);
  // An explicit --max-turns N (smaller or larger) is preserved.
  assert.equal(parseArgs(["run", "x", "--max-turns", "5"]).maxTurns, 5);
  assert.equal(parseArgs(["run", "x", "--max-turns", "999"]).maxTurns, 999);
});

test("parseArgs: REPL mode has no prompt requirement", () => {
  const a = parseArgs([]);
  assert.deepEqual(a.errors, []);
  assert.equal(a.oneShot, false);
});

test("parseArgs: D13 approval flags (--local / --ask) parse; default is neither", () => {
  assert.equal(parseArgs(["--local"]).local, true);
  assert.equal(parseArgs(["--ask"]).ask, true);
  assert.equal(parseArgs([]).local, false);
  assert.equal(parseArgs([]).ask, false);
});

test("parseArgs: D13 approval flags are mutually exclusive", () => {
  assert.match(parseArgs(["--local", "--yes"]).errors.join(" "), /mutually exclusive/);
  assert.match(parseArgs(["--ask", "--no-approve"]).errors.join(" "), /mutually exclusive/);
  assert.match(parseArgs(["--local", "--ask", "--yes"]).errors.join(" "), /mutually exclusive/);
  // A single flag (or none) is fine.
  assert.deepEqual(parseArgs(["--local"]).errors, []);
  assert.deepEqual(parseArgs(["--no-approve"]).errors, []);
});

test("parseArgs: errors", () => {
  assert.notDeepEqual(parseArgs(["run"]).errors, []);
  assert.notDeepEqual(parseArgs(["--bogus"]).errors, []);
  assert.notDeepEqual(parseArgs(["--model"]).errors, []);
  assert.notDeepEqual(parseArgs(["run", "x", "--session", "a", "--resume", "b"]).errors, []);
  assert.notDeepEqual(parseArgs(["run", "x", "--max-turns", "0"]).errors, []);
  assert.notDeepEqual(parseArgs(["tui", "a prompt"]).errors, []); // tui takes no prompt
});

test("parseArgs: --session-auto (D20) parses, defaults false, conflicts with --session/--resume", () => {
  assert.equal(parseArgs(["--session-auto"]).sessionAuto, true);
  assert.equal(parseArgs([]).sessionAuto, false);
  const a = parseArgs(["run", "x", "--session-auto"]);
  assert.deepEqual(a.errors, []);
  assert.match(
    parseArgs(["run", "x", "--session-auto", "--session", "s.jsonl"]).errors.join(" "),
    /conflict/,
  );
  assert.match(parseArgs(["--session-auto", "--resume", "r.jsonl"]).errors.join(" "), /conflict/);
});

test("parseArgs: tui subcommand", () => {
  const a = parseArgs(["tui", "--tools", "none"]);
  assert.deepEqual(a.errors, []);
  assert.equal(a.ui, "tui");
  assert.equal(a.oneShot, false);
  assert.equal(parseArgs(["run", "x"]).ui, "plain");
});

test("resolveTools: all / none / filter / unknown", () => {
  assert.equal(resolveTools("all").tools.length, 4);
  assert.equal(resolveTools("none").tools.length, 0);
  const f = resolveTools("bash,read");
  assert.deepEqual(f.tools.map((t) => t.name).sort(), ["bash", "read"]);
  assert.match(resolveTools("bash,nope")!.error ?? "", /unknown tool/);
});

test("exitCodeFor: stop 0, budget 3, error/length/toolUse 1, aborted 130", () => {
  assert.equal(exitCodeFor("stop"), 0);
  assert.equal(exitCodeFor("budget"), 3);
  assert.equal(exitCodeFor("aborted"), 130);
  assert.equal(exitCodeFor("error"), 1);
  assert.equal(exitCodeFor("length"), 1);
  assert.equal(exitCodeFor("toolUse"), 1);
});

test("main: tui without a TTY fails cleanly (exit 2, I3 — no Ink raw-mode dump)", async (t) => {
  // node --test runs with non-TTY stdin; under a real TTY this path can't
  // be reached, so skip there.
  if (process.stdin.isTTY) t.skip("stdin is a TTY");
  const { dir, models } = await workspace(t);
  const S = mkSinks();
  const code = await main(["tui", "--tools", "none", "--models", models, "--cwd", dir], {
    streamFn: fakeStream([{ type: "text", text: "unreachable" }]),
    sinks: S.sinks,
  });
  assert.equal(code, 2);
  assert.match(S.err(), /interactive terminal/);
  assert.doesNotMatch(S.out(), /unreachable/); // the fake stream was never used
});

// ─────────────────────────────── printer ───────────────────────────────

test("printEvent: text deltas, tool lines, end diagnostics", () => {
  let out = "";
  let err = "";
  const sinks: PrintSinks = {
    out: { write: (s) => (out += s) },
    err: { write: (s) => (err += s) },
  };
  const evs: AgentEvent[] = [
    { type: "text_delta", delta: "Hel", partial: {} as never },
    { type: "text_delta", delta: "lo", partial: {} as never },
    {
      type: "done",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        model: "m",
        provider: "p",
        stopReason: "stop",
        timestamp: 1,
      },
    },
    {
      type: "tool_execution_start",
      toolCall: { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la" } },
    },
    {
      type: "tool_execution_end",
      toolCallId: "c1",
      result: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: "a b c" }],
        timestamp: 2,
      },
    },
    {
      type: "agent_end",
      stopReason: "error",
      messages: [
        {
          role: "assistant",
          content: [],
          model: "m",
          provider: "p",
          stopReason: "error",
          errorMessage: "boom",
          timestamp: 3,
        },
      ],
    },
  ];
  for (const ev of evs) printEvent(ev, sinks);
  assert.equal(out, "Hello\n\n→ bash {\"command\":\"ls -la\"}\n  ✓ a b c\n");
  assert.match(err, /error: boom/);
});

test("printEvent: budget agent_end → stderr note (resume hint only with a session file)", () => {
  let err = "";
  const sinks: PrintSinks = {
    out: { write: () => {} },
    err: { write: (s) => (err += s) },
  };
  printEvent({ type: "agent_end", stopReason: "budget", maxTurns: 4, messages: [] }, sinks);
  assert.match(err, /budget: max 4 turns reached/);
  assert.doesNotMatch(err, /resume/);

  err = "";
  printEvent(
    { type: "agent_end", stopReason: "budget", maxTurns: 4, messages: [] },
    sinks,
    "/tmp/s.jsonl",
  );
  assert.match(err, /budget: max 4 turns reached \(resume: --resume \/tmp\/s\.jsonl\)/);

  err = "";
  // No maxTurns on the event (defensive) — the note still names the outcome.
  printEvent({ type: "agent_end", stopReason: "budget", messages: [] }, sinks);
  assert.match(err, /budget: turn cap reached/);
});

test("printEvent: D19 — read/write/edit silent on success, denial shown, bash unchanged", () => {
  let out = "";
  const sinks: PrintSinks = {
    out: { write: (s) => (out += s) },
    err: { write: () => {} },
  };
  const tc = (id: string, name: string, args: Record<string, unknown>) =>
    ({ type: "tool_execution_start", toolCall: { type: "toolCall", id, name, arguments: args } }) as AgentEvent;
  const te = (id: string, name: string, text: string, isError?: boolean) =>
    ({
      type: "tool_execution_end",
      toolCallId: id,
      result: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 1 },
    }) as AgentEvent;
  // Succeeded read/write: no line at all
  for (const ev of [tc("r1", "read", { path: "a.txt" }), te("r1", "read", "file body"), tc("w1", "write", { path: "b.txt" }), te("w1", "write", "ok")]) {
    printEvent(ev, sinks);
  }
  assert.equal(out, "");
  // Denied read: only the ✗ result line (the start line stays suppressed)
  for (const ev of [tc("r2", "read", { path: "/etc/passwd" }), te("r2", "read", "denied: outside the workspace", true)]) {
    printEvent(ev, sinks);
  }
  assert.equal(out, "  ✗ denied: outside the workspace\n");
  // bash is not quiet: start line + success line as before
  for (const ev of [tc("b1", "bash", { command: "ls" }), te("b1", "bash", "a b")]) {
    printEvent(ev, sinks);
  }
  assert.equal(out, "  ✗ denied: outside the workspace\n\n→ bash {\"command\":\"ls\"}\n  ✓ a b\n");
});

// ─────────────────────────── one-shot + session ───────────────────────────

test("main one-shot: prompt → streamed text → exit 0, session persisted", async (t) => {
  const { dir, models } = await workspace(t);
  const session = join(dir, "s.jsonl");
  const S = mkSinks();
  const code = await main(["run", "say hello", "--tools", "none", "--models", models, "--session", session], {
    streamFn: fakeStream([{ type: "text", text: "Hello there" }]),
    sinks: S.sinks,
  });
  assert.equal(code, 0);
  assert.match(S.out(), /Hello there/);

  const replayed = await replaySession(session);
  assert.equal(replayed.context.length, 2);
  assert.equal(replayed.context[0]!.role, "user");
  if (replayed.context[0]!.role === "user") {
    assert.equal(replayed.context[0]!.content, "say hello");
  }
  assert.equal(replayed.context[1]!.role, "assistant");
  assert.deepEqual(replayed.model, { id: MODEL.id, provider: "fake" });
});

test("--session-auto + --session → exit 2 conflict, no session file created (D20)", async (t) => {
  const { dir, models } = await workspace(t);
  const S = mkSinks();
  const code = await main(
    ["run", "hi", "--tools", "none", "--models", models, "--session-auto", "--session", join(dir, "s.jsonl")],
    { sinks: S.sinks },
  );
  assert.equal(code, 2);
  assert.match(S.err(), /conflict/);
  // The parse conflict is rejected BEFORE any session file exists.
  const { existsSync } = await import("node:fs");
  assert.ok(!existsSync(join(dir, "s.jsonl")));
});

test("main one-shot: real bash tool round-trip, 4-message session", async (t) => {
  const { dir, models } = await workspace(t);
  const session = join(dir, "s.jsonl");
  const streamFn = fakeStream([
    { type: "toolcall", calls: [{ name: "bash", args: { command: "echo roundtrip-ok" } }] },
    { type: "text", text: "done" },
  ]);
  const S = mkSinks();
  const code = await main(["run", "list files", "--tools", "bash", "--yes", "--models", models, "--session", session], {
    streamFn,
    sinks: S.sinks,
  });
  assert.equal(code, 0);
  assert.match(S.out(), /→ bash/);
  assert.match(S.out(), /roundtrip-ok/);

  const replayed = await replaySession(session);
  const roles = replayed.context.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "toolResult", "assistant"]);
  const tr = replayed.context[2]!;
  assert.equal(tr.role, "toolResult");
  if (tr.role === "toolResult") {
    assert.equal(tr.toolName, "bash");
    assert.match(tr.content.map((c) => c.text).join(" "), /roundtrip-ok/);
  }
});

test("main --resume: second run is seeded with the replayed context", async (t) => {
  const { dir, models } = await workspace(t);
  const session = join(dir, "s.jsonl");
  await main(["run", "first", "--tools", "none", "--models", models, "--session", session], {
    streamFn: fakeStream([{ type: "text", text: "one" }]),
  });
  const seen: number[] = [];
  const resumable = fakeStream([{ type: "text", text: "two" }]);
  const streamFn: typeof resumable = (model, ctx, opts) => {
    seen.push(ctx.messages.length);
    return resumable(model, ctx, opts);
  };
  const S = mkSinks();
  const code = await main(["run", "second", "--resume", session, "--models", models], {
    streamFn,
    sinks: S.sinks,
  });
  assert.equal(code, 0);
  assert.match(S.err(), /resumed .*: 2 context message/);
  // The first LLM call of the resumed run sees [u1, a1, u2] = 3 messages.
  assert.equal(seen[0], 3);
  const replayed = await replaySession(session);
  assert.equal(replayed.context.length, 4);
  assert.deepEqual(
    replayed.context.map((m) => (m.role === "user" ? m.content : m.role)),
    ["first", "assistant", "second", "assistant"],
  );
});

test("main --resume on a missing file: exit 2, no crash", async (t) => {
  const { dir, models } = await workspace(t);
  const S = mkSinks();
  const code = await main(["run", "x", "--resume", join(dir, "nope.jsonl"), "--models", models], {
    streamFn: fakeStream([{ type: "text", text: "no" }]),
    sinks: S.sinks,
  });
  assert.equal(code, 2);
  assert.match(S.err(), /session/);
});

test("main: provider error is data — exit 1, error printed", async (t) => {
  const { dir, models } = await workspace(t);
  const S = mkSinks();
  const code = await main(["run", "x", "--tools", "none", "--models", models], {
    streamFn: fakeStream([{ type: "error", message: "boom" }]),
    sinks: S.sinks,
  });
  assert.equal(code, 1);
  assert.match(S.err(), /error: boom/);
});

test("main: turn cap hit → budget note on stderr, exit 3", async (t) => {
  const { dir, models } = await workspace(t);
  const session = join(dir, "s.jsonl");
  const S = mkSinks();
  const code = await main(
    ["run", "x", "--tools", "none", "--max-turns", "1", "--max-continuations", "0",
     "--models", models, "--session", session],
    {
      streamFn: fakeStream([
        // The model wants another round; the cap breaks the loop first.
        // --max-continuations 0 pins the pre-C26 hard-stop (C26's default
        // would auto-continue — and this identical-batch model would trip
        // loop detection on the 3rd repeat instead).
        { type: "toolcall", calls: [{ name: "ghost", args: {} }] },
        { type: "text", text: "never reached" },
      ]),
      sinks: S.sinks,
    },
  );
  assert.equal(code, 3);
  assert.match(S.err(), /budget: max 1 turns reached/);
  assert.match(S.err(), /\(resume: --resume .+s\.jsonl\)/);
});

test("main: C26 — default auto-continue: budget note on stderr, run continues", async (t) => {
  const { dir, models } = await workspace(t);
  const S = mkSinks();
  const code = await main(
    ["run", "x", "--tools", "none", "--max-turns", "1", "--models", models],
    {
      streamFn: fakeStream([
        { type: "toolcall", calls: [{ name: "ghost", args: { n: 1 } }] },
        { type: "toolcall", calls: [{ name: "ghost", args: { n: 2 } }] },
        { type: "text", text: "done after the continuation" },
      ]),
      sinks: S.sinks,
    },
  );
  assert.equal(code, 0, "the run completes past the first budget hit");
  assert.match(S.err(), /turn budget \(1\) reached — continuing \(cycle 1\/4\)/);
  assert.doesNotMatch(S.err(), /budget: max 1 turns reached/);
});

test("main: C26 — every continuation spent → budget note names cycles, exit 3", async (t) => {
  const { dir, models } = await workspace(t);
  const S = mkSinks();
  const code = await main(
    ["run", "x", "--tools", "none", "--max-turns", "1", "--max-continuations", "1", "--models", models],
    {
      streamFn: fakeStream(
        Array.from({ length: 5 }, (_, i) => ({
          type: "toolcall",
          calls: [{ name: "ghost", args: { n: i } }],
        })),
      ),
      sinks: S.sinks,
    },
  );
  assert.equal(code, 3);
  assert.match(S.err(), /turn budget \(1\) reached — continuing \(cycle 1\/2\)/);
  assert.match(S.err(), /budget: max 1 turns × 2 cycles reached/);
});

test("main: C24 — no --max-turns → cap DERIVED from the model (guard stays on)", async (t) => {
  // A model whose derived cap is the floor (64): 1000-window / 16000-output
  // → 1000/16000 × 10 = 0.625 → floored to 64. The model loops forever (a
  // tool call every turn), so the run must STOP at the DERIVED 64 with
  // stopReason "budget" and exit 3 — proving the guard is on even though the
  // user passed no --max-turns.
  const { dir } = await workspace(t);
  const smallModel: ModelConfig = { ...MODEL, id: "small-model", contextWindow: 1000, maxTokens: 16000 };
  const models = join(dir, "models.json");
  await writeFile(models, JSON.stringify({ default: smallModel.id, models: [smallModel] }));
  const derived = deriveMaxTurns(smallModel.contextWindow, smallModel.maxTokens);
  assert.equal(derived, 64, "sanity: this model's derived cap is the floor");

  const S = mkSinks();
  const code = await main(
    ["run", "x", "--tools", "none", "--max-continuations", "0", "--models", models], // NO --max-turns
    {
      // Distinct args per turn so C26 loop detection (identical batch 3×)
      // never fires; --max-continuations 0 pins the pre-C26 hard stop so
      // the test isolates the DERIVED CAP, not the auto-continue.
      streamFn: fakeStream(
        Array.from({ length: 70 }, (_, i) => ({
          type: "toolcall",
          calls: [{ name: "ghost", args: { n: i } }],
        })),
      ),
      sinks: S.sinks,
    },
  );
  assert.equal(code, 3, "the derived cap is an explicit budget outcome (exit 3)");
  assert.match(S.err(), new RegExp(`budget: max ${derived} turns reached`));
});

test("main: bad model id / missing models file → exit 2", async (t) => {
  const { dir, models } = await workspace(t);
  const code1 = await main(["run", "x", "--model", "nope", "--models", models], {
    streamFn: fakeStream([{ type: "text", text: "x" }]),
    sinks: mkSinks().sinks,
  });
  assert.equal(code1, 2);
  const code2 = await main(["run", "x", "--models", join(dir, "missing.json")], {
    streamFn: fakeStream([{ type: "text", text: "x" }]),
    sinks: mkSinks().sinks,
  });
  assert.equal(code2, 2);
});

// ─────────────────────── mid-run kill keeps the prompt ───────────────────────

/** A stream that emits a partial, then hangs until the signal aborts (kill). */
function hangingStream(): StreamFn {
  return (model, _ctx, opts) =>
    (async function* () {
      const base: AssistantMessage = {
        role: "assistant",
        content: [],
        model: model.id,
        provider: model.provider,
        stopReason: "stop",
        timestamp: Date.now(),
      };
      yield { type: "start", partial: base };
      const partial: AssistantMessage = {
        ...base,
        content: [{ type: "text", text: "par" }],
      };
      yield { type: "text_delta", delta: "par", partial };
      await new Promise<void>((r) =>
        opts.signal.addEventListener("abort", () => r(), { once: true }),
      );
      yield { type: "done", message: { ...partial, stopReason: "aborted" } };
    })();
}

test("kill mid-run: prompt persisted before the run, partial kept on abort", async (t) => {
  const { dir } = await workspace(t);
  const sessionPath = join(dir, "s.jsonl");
  const session = await Session.create(sessionPath, {
    cwd: dir,
    model: { id: MODEL.id, provider: "fake" },
  });
  t.after(() => session.close());
  const silent: PrintSinks = { out: { write: () => true }, err: { write: () => true } };

  const controller = new AbortController();
  const pending = runTurn({
    model: MODEL,
    systemPrompt: "sys",
    tools: [],
    streamFn: hangingStream(),
    controller,
    context: [],
    session,
    prompt: "prompt that outlives the kill",
    sinks: silent,
    maxTurns: 8,
  });
  // Let the run start (user message appended, stream hung), then kill it.
  await new Promise((r) => setTimeout(r, 50));
  controller.abort();
  const { outcome } = await pending;
  assert.equal(outcome.stopReason, "aborted");

  const replayed = await replaySession(sessionPath);
  // user (persisted pre-run) + aborted partial (the loop keeps it, WS2).
  assert.equal(replayed.context.length, 2);
  assert.equal(replayed.context[0]!.role, "user");
  if (replayed.context[0]!.role === "user") {
    assert.equal(replayed.context[0]!.content, "prompt that outlives the kill");
  }
  assert.equal(replayed.context[1]!.role, "assistant");
  const asst = replayed.context[1]!;
  if (asst.role === "assistant") assert.equal(asst.stopReason, "aborted");
});

// ─────────────────────────────── WS7: safety ────────────────────────────────

test("parseArgs: --yes / --no-approve flags (mutually exclusive)", () => {
  const a = parseArgs(["run", "x", "--yes"]);
  assert.deepEqual(a.errors, []);
  assert.equal(a.yes, true);
  const b = parseArgs(["run", "x", "--no-approve"]);
  assert.deepEqual(b.errors, []);
  assert.equal(b.noApprove, true);
  assert.notDeepEqual(parseArgs(["run", "x", "--yes", "--no-approve"]).errors, []);
});

test("WS7: gated bash denied (--ask) → run completes, model gets an isError result", async (t) => {
  const { dir, models } = await workspace(t);
  const session = join(dir, "s.jsonl");
  const streamFn = fakeStream([
    { type: "toolcall", calls: [{ name: "bash", args: { command: "echo should-not-run" } }] },
    { type: "text", text: "the command was denied" },
  ]);
  const S = mkSinks();
  const asked: string[] = [];
  // D13: the default mode is "local" (this command would auto-approve),
  // so the pre-D13 prompt-per-call behavior is exercised via --ask.
  const code = await main(
    ["run", "run it", "--tools", "bash", "--models", models, "--session", session, "--ask"],
    {
      streamFn,
      sinks: S.sinks,
      askApproval: async (q) => {
        asked.push(q);
        return false;
      },
    },
  );
  assert.equal(code, 0, "a denial is data — the run continues");
  assert.equal(asked.length, 1, "the gated call was prompted");
  assert.match(asked[0]!, /bash/);
  assert.match(S.out(), /✗/, "blocked call prints an error line");
  assert.match(S.out(), /denied/);

  const replayed = await replaySession(session);
  const tr = replayed.context.find((m) => m.role === "toolResult");
  assert.ok(tr && tr.role === "toolResult", "the tool result is in the session");
  assert.equal(tr.isError, true, "the denial is an isError tool result (D7/I3)");
  assert.match(tr.content.map((c) => c.text).join(" "), /denied/);
});

test("WS7: gated bash approved via injected ask → executes", async (t) => {
  const { dir, models } = await workspace(t);
  const streamFn = fakeStream([
    { type: "toolcall", calls: [{ name: "bash", args: { command: "echo approved-yes" } }] },
    { type: "text", text: "ok" },
  ]);
  const S = mkSinks();
  const code = await main(["run", "run it", "--tools", "bash", "--models", models], {
    streamFn,
    sinks: S.sinks,
    askApproval: async () => true,
  });
  assert.equal(code, 0);
  assert.match(S.out(), /approved-yes/);
});

test("WS7: --yes auto-approves non-destructive bash (ask never called)", async (t) => {
  const { dir, models } = await workspace(t);
  const streamFn = fakeStream([
    { type: "toolcall", calls: [{ name: "bash", args: { command: "echo auto" } }] },
    { type: "text", text: "ok" },
  ]);
  const S = mkSinks();
  let asked = 0;
  const code = await main(["run", "run it", "--tools", "bash", "--yes", "--models", models], {
    streamFn,
    sinks: S.sinks,
    askApproval: async () => {
      asked++;
      return true;
    },
  });
  assert.equal(code, 0);
  assert.equal(asked, 0, "--yes must not prompt for non-destructive calls");
  assert.match(S.out(), /auto/);
});

test("WS7: --no-approve blocks gated bash without prompting", async (t) => {
  const { dir, models } = await workspace(t);
  const streamFn = fakeStream([
    { type: "toolcall", calls: [{ name: "bash", args: { command: "echo no" } }] },
    { type: "text", text: "blocked" },
  ]);
  const S = mkSinks();
  let asked = 0;
  const code = await main(["run", "run it", "--tools", "bash", "--no-approve", "--models", models], {
    streamFn,
    sinks: S.sinks,
    askApproval: async () => {
      asked++;
      return true;
    },
  });
  assert.equal(code, 0);
  assert.equal(asked, 0, "--no-approve must never prompt");
  assert.match(S.out(), /✗.*no-approve/);
});

test("WS7: sandbox — absolute path outside root is refused even with --yes", async (t) => {
  const { dir, models } = await workspace(t);
  // A SIBLING of the root — outside the sandbox (unique name per run).
  const target = join(dirname(dir), `ws7-evil-${basename(dir)}.txt`);
  const streamFn = fakeStream([
    { type: "toolcall", calls: [{ name: "write", args: { path: target, content: "x" } }] },
    { type: "text", text: "nope" },
  ]);
  const S = mkSinks();
  const session = join(dir, "s.jsonl");
  const code = await main(
    ["run", "write it", "--tools", "write", "--yes", "--models", models, "--cwd", dir, "--session", session],
    { streamFn, sinks: S.sinks },
  );
  assert.equal(code, 0);
  assert.match(S.out(), /✗/, "the blocked call prints an error line");
  // The printed line is truncated at 200 chars — the full reason lives in
  // the session's tool result (which the model reads).
  const replayed = await replaySession(session);
  const tr = replayed.context.find((m) => m.role === "toolResult");
  assert.ok(tr && tr.role === "toolResult");
  assert.match(tr.content.map((c) => c.text).join(" "), /outside the project root/);
  await assert.rejects(readFile(target, "utf8"), "the file must not be created");
});

test("WS7: sandbox — ../ escape is refused even with --yes", async (t) => {
  const { dir, models } = await workspace(t);
  // Root = dir/sub, so "../escape.txt" lands in dir (outside the root).
  const sub = join(dir, "sub");
  await mkdir(sub);
  const streamFn = fakeStream([
    { type: "toolcall", calls: [{ name: "write", args: { path: "../escape.txt", content: "x" } }] },
    { type: "text", text: "no" },
  ]);
  const S = mkSinks();
  const session = join(sub, "s.jsonl");
  const code = await main(
    ["run", "write it", "--tools", "write", "--yes", "--models", models, "--cwd", sub, "--session", session],
    { streamFn, sinks: S.sinks },
  );
  assert.equal(code, 0);
  assert.match(S.out(), /✗/);
  const replayed = await replaySession(session);
  const tr = replayed.context.find((m) => m.role === "toolResult");
  assert.ok(tr && tr.role === "toolResult");
  assert.match(tr.content.map((c) => c.text).join(" "), /outside the project root/);
  await assert.rejects(readFile(join(dir, "escape.txt"), "utf8"));
});

test("WS7: sandbox + --cwd — relative write lands under the project root", async (t) => {
  const { dir, models } = await workspace(t);
  const streamFn = fakeStream([
    { type: "toolcall", calls: [{ name: "write", args: { path: "a/b.txt", content: "rooted" } }] },
    { type: "text", text: "ok" },
  ]);
  const S = mkSinks();
  const code = await main(
    ["run", "write it", "--tools", "write", "--yes", "--models", models, "--cwd", dir],
    { streamFn, sinks: S.sinks },
  );
  assert.equal(code, 0);
  const onDisk = await readFile(join(dir, "a", "b.txt"), "utf8");
  assert.equal(onDisk, "rooted");
});

test("WS7: bash runs in the project root (--cwd)", async (t) => {
  const { dir, models } = await workspace(t);
  const streamFn = fakeStream([
    { type: "toolcall", calls: [{ name: "bash", args: { command: "pwd" } }] },
    { type: "text", text: "ok" },
  ]);
  const S = mkSinks();
  const code = await main(
    ["run", "where am i", "--tools", "bash", "--yes", "--models", models, "--cwd", dir],
    { streamFn, sinks: S.sinks },
  );
  assert.equal(code, 0);
  assert.match(S.out(), new RegExp(dir));
});

test("WS7: bad --cwd (nonexistent) → exit 2", async (t) => {
  const { dir, models } = await workspace(t);
  const S = mkSinks();
  const code = await main(["run", "x", "--models", models, "--cwd", join(dir, "nope")], {
    streamFn: fakeStream([{ type: "text", text: "x" }]),
    sinks: S.sinks,
  });
  assert.equal(code, 2);
  assert.match(S.err(), /not an existing directory/);
});

// ──────────────────────────────── WS9: compaction ────────────────────────────────

const SMALL_WINDOW: ModelConfig = { ...MODEL, contextWindow: 2000, maxTokens: 100 };

/** Seed a session with one old [user, assistant] exchange, small-window model. */
async function seedHistory(dir: string, models: string, session: string) {
  await writeFile(models, JSON.stringify({ default: SMALL_WINDOW.id, models: [SMALL_WINDOW] }));
  await main(["run", "old task", "--tools", "none", "--models", models, "--session", session], {
    streamFn: fakeStream([{ type: "text", text: "old answer" }]),
  });
}

test("WS9: parseArgs --no-compact / --compact-keep", () => {
  const a = parseArgs(["run", "x", "--no-compact", "--compact-keep", "1234"]);
  assert.deepEqual(a.errors, []);
  assert.equal(a.noCompact, true);
  assert.equal(a.compactKeepTokens, 1234);
  assert.notDeepEqual(parseArgs(["run", "x", "--compact-keep", "0"]).errors, []);
});

test("WS9: context over budget mid-run → silent summary call, compacted context, compaction entry persists", async (t) => {
  const { dir, models } = await workspace(t);
  const session = join(dir, "s.jsonl");
  await seedHistory(dir, models, session);

  const seen: { roles: string[]; tools: number; first: string }[] = [];
  const base = fakeStream([
    // turn 1: a tool call whose usage trips the trigger (1900+100+1024 > 2000)
    { type: "toolcall", calls: [{ name: "bash", args: { command: "echo fresh" } }], usage: { input: 1890, output: 10, totalTokens: 1900 } },
    // the SILENT summarizer call (no tools) — consumed between turns
    { type: "text", text: "SUMMARY: old task was answered earlier." },
    // turn 2: the model answers in the compacted context
    { type: "text", text: "final" },
  ]);
  const streamFn: StreamFn = (model, ctx, o) => {
    const first = ctx.messages[0]!;
    seen.push({
      roles: ctx.messages.map((m) => m.role),
      tools: ctx.tools.length,
      first: first.role === "user" ? first.content : String(first.role),
    });
    return base(model, ctx, o);
  };

  const S = mkSinks();
  const code = await main(["run", "new task", "--resume", session, "--tools", "bash", "--yes", "--models", models], {
    streamFn,
    sinks: S.sinks,
  });
  assert.equal(code, 0);
  assert.match(S.err(), /✂ context compacted/, "the compaction is reported to the user");

  assert.equal(seen.length, 3, "turn 1 + silent summary + turn 2");
  assert.deepEqual(seen[0]!.roles, ["user", "assistant", "user"], "turn 1 sees the resumed context");
  assert.equal(seen[1]!.tools, 0, "the summary call has no tools");
  assert.match(seen[1]!.first, /summarize/i, "the summary call carries the summarizer system prompt");
  assert.deepEqual(seen[2]!.roles, ["user", "assistant", "user", "assistant", "toolResult"], "turn 2 sees [summary, a1, u2, a1', tr]");
  assert.match(seen[2]!.first, /Compaction summary of earlier context/);
  assert.match(seen[2]!.first, /SUMMARY: old task was answered earlier\./);

  // The session file replayed must reproduce the compacted context
  // ([summary, a1, u2, a1', tr] + turn 2's final answer = 6).
  const replayed = await replaySession(session);
  assert.equal(replayed.context.length, 6);
  const head = replayed.context[0]!;
  assert.equal(head.role, "user");
  if (head.role === "user") {
    assert.match(head.content, /Compaction summary of earlier context/);
    assert.match(head.content, /SUMMARY: old task was answered earlier\./);
  }
  assert.equal(replayed.context[4]!.role, "toolResult");
  // The compaction entry itself is in the log with a resolvable firstKeptEntryId.
  const compact = replayed.entries.find((e) => e.type === "compaction");
  assert.ok(compact, "a compaction entry was appended");
  if (compact.type === "compaction") {
    assert.equal(compact.tokensBefore, 1900);
    assert.ok(replayed.contextEntryIds.includes(compact.firstKeptEntryId), "firstKeptEntryId resolves");
  }
});

test("WS9: --no-compact keeps the context unsummarized (no summary call)", async (t) => {
  const { dir, models } = await workspace(t);
  const session = join(dir, "s.jsonl");
  await seedHistory(dir, models, session);

  const seen: string[][] = [];
  const base = fakeStream([
    { type: "toolcall", calls: [{ name: "bash", args: { command: "echo fresh" } }], usage: { input: 1890, output: 10, totalTokens: 1900 } },
    { type: "text", text: "final" }, // NO scripted summarizer turn — the script must last exactly
  ]);
  const streamFn: StreamFn = (model, ctx, o) => {
    seen.push(ctx.messages.map((m) => m.role));
    return base(model, ctx, o);
  };

  const S = mkSinks();
  const code = await main(["run", "new task", "--resume", session, "--tools", "bash", "--yes", "--no-compact", "--models", models], {
    streamFn,
    sinks: S.sinks,
  });
  assert.equal(code, 0);
  assert.doesNotMatch(S.err(), /context compacted/);
  assert.equal(seen.length, 2, "no silent summary call happened");
  assert.deepEqual(seen[1]!, ["user", "assistant", "user", "assistant", "toolResult"], "turn 2 sees the FULL history");
  const replayed = await replaySession(session);
  assert.equal(replayed.context.length, 6, "full history + turn 2's final answer");
  assert.equal(replayed.entries.some((e) => e.type === "compaction"), false);
});

test("WS9: sessionless run still compacts (context management, not persistence)", async (t) => {
  const { dir, models } = await workspace(t);
  await writeFile(models, JSON.stringify({ default: SMALL_WINDOW.id, models: [SMALL_WINDOW] }));

  const seen: { roles: string[]; first: string }[] = [];
  const base = fakeStream([
    // turns 1-2: small tool turns — build a multi-unit context (planCompaction
    // needs ≥ 3 units: 1 foldable + 2 kept)
    { type: "toolcall", calls: [{ name: "bash", args: { command: "echo one" } }] },
    { type: "toolcall", calls: [{ name: "bash", args: { command: "echo two" } }] },
    // turn 3: usage trips the trigger (1900+100+1024 > 2000)
    { type: "toolcall", calls: [{ name: "bash", args: { command: "echo three" } }], usage: { input: 1890, output: 10, totalTokens: 1900 } },
    // the SILENT summarizer call (no tools) — consumed between turns
    { type: "text", text: "SUMMARY: the earlier turns were answered." },
    // turn 4: the model answers in the compacted context
    { type: "text", text: "final" },
  ]);
  const streamFn: StreamFn = (model, ctx, o) => {
    const first = ctx.messages[0]!;
    seen.push({
      roles: ctx.messages.map((m) => m.role),
      first: first.role === "user" ? first.content : String(first.role),
    });
    return base(model, ctx, o);
  };

  const S = mkSinks();
  // NO --session / --resume: a fresh sessionless one-shot run.
  const code = await main(["run", "do the thing", "--tools", "bash", "--yes", "--models", models], {
    streamFn,
    sinks: S.sinks,
  });
  assert.equal(code, 0);
  assert.match(S.err(), /✂ context compacted/, "compaction is reported even without a session");
  assert.equal(seen.length, 5, "turns 1-3 + silent summary + turn 4");
  assert.deepEqual(seen[3]!.roles, ["user"], "the summary call carries only the summarizer prompt");
  assert.match(seen[3]!.first, /summarize/i);
  assert.deepEqual(seen[4]!.roles, ["user", "assistant", "toolResult", "assistant", "toolResult", "assistant", "toolResult"], "turn 4 sees [summary, a1, tr1, a2, tr2, a3, tr3]");
  assert.match(seen[4]!.first, /Compaction summary of earlier context/);
  assert.match(seen[4]!.first, /SUMMARY: the earlier turns were answered\./);
});

test("WS9: failed summary call → run continues uncompacted (I3)", async (t) => {
  const { dir, models } = await workspace(t);
  const session = join(dir, "s.jsonl");
  await seedHistory(dir, models, session);

  const base = fakeStream([
    { type: "toolcall", calls: [{ name: "bash", args: { command: "echo fresh" } }], usage: { input: 1890, output: 10, totalTokens: 1900 } },
    { type: "error", message: "summarizer down" }, // the silent call fails
    { type: "text", text: "final" },
  ]);
  const S = mkSinks();
  const code = await main(["run", "new task", "--resume", session, "--tools", "bash", "--yes", "--models", models], {
    streamFn: base,
    sinks: S.sinks,
  });
  assert.equal(code, 0, "a failed summary call never fails the run");
  assert.doesNotMatch(S.err(), /context compacted/);
  const replayed = await replaySession(session);
  assert.equal(replayed.context.length, 6, "context kept whole (+ turn 2's final answer)");
  assert.equal(replayed.entries.some((e) => e.type === "compaction"), false, "no compaction entry");
});
