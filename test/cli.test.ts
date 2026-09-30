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
 *   - WS7: bash/write/edit/read go through the safety hooks — the
 *     classification + mode matrix (read-only/reversible run without a
 *     prompt; sensitive + destructive confirm in every mode; --no-approve
 *     allows only read-only non-sensitive bash), denial → isError result,
 *     path sandbox (absolute & ../ escapes, --cwd root)
 * Live vertical slice: test/cli-live.test.ts (RUN_LIVE=1).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fakeStream } from "./fake-stream.js";
import {
  behaviorSettingsLines,
  compactNow,
  defaultSkillDirs,
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

test("parseArgs: approval flags parse; default is ask (no flag set)", () => {
  assert.equal(parseArgs(["--ask"]).ask, true);
  assert.equal(parseArgs(["--yes"]).yes, true);
  assert.equal(parseArgs(["--no-approve"]).noApprove, true);
  assert.equal(parseArgs([]).ask, false);
  assert.equal(parseArgs([]).yes, false);
  assert.equal(parseArgs([]).noApprove, false);
  // --local no longer exists.
  assert.notDeepEqual(parseArgs(["--local"]).errors, []);
});

test("parseArgs: approval flags are mutually exclusive", () => {
  assert.match(parseArgs(["--yes", "--no-approve"]).errors.join(" "), /mutually exclusive/);
  assert.match(parseArgs(["--ask", "--no-approve"]).errors.join(" "), /mutually exclusive/);
  assert.match(parseArgs(["--ask", "--yes"]).errors.join(" "), /mutually exclusive/);
  // A single flag (or none) is fine.
  assert.deepEqual(parseArgs(["--ask"]).errors, []);
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
  assert.equal(parseArgs(["run", "x"]).ui, "auto");
});

test("parseArgs: bare launch defaults to ui auto (TTY→TUI, piped→REPL resolved in main)", () => {
  assert.deepEqual(parseArgs([]).errors, []);
  assert.equal(parseArgs([]).ui, "auto");
  assert.equal(parseArgs([]).oneShot, false);
});

test("parseArgs: --plain forces the plain REPL (even on a TTY)", () => {
  const a = parseArgs(["--plain"]);
  assert.deepEqual(a.errors, []);
  assert.equal(a.ui, "plain");
  assert.equal(a.oneShot, false);
  // --plain composes with the other interactive flags.
  const b = parseArgs(["--plain", "--yes", "--session-auto"]);
  assert.deepEqual(b.errors, []);
  assert.equal(b.ui, "plain");
  assert.equal(b.yes, true);
  assert.equal(b.sessionAuto, true);
});

test("parseArgs: tui and --plain are mutually exclusive (either order)", () => {
  assert.match(parseArgs(["tui", "--plain"]).errors.join(" "), /conflict/);
  assert.match(parseArgs(["--plain", "tui"]).errors.join(" "), /conflict/);
});

test("resolveTools: all / none / filter / unknown", () => {
  assert.equal(resolveTools("all").tools.length, 4);
  assert.equal(resolveTools("none").tools.length, 0);
  const f = resolveTools("bash,read");
  assert.deepEqual(f.tools.map((t) => t.name).sort(), ["bash", "read"]);
  assert.match(resolveTools("bash,nope")!.error ?? "", /unknown tool/);
});

test("defaultSkillDirs: project .tre/skills first, then user ~/.tre/agent/skills", () => {
  const dirs = defaultSkillDirs("/some/cwd");
  assert.equal(dirs.length, 2);
  assert.equal(dirs[0]!, "/some/cwd/.tre/skills");
  assert.match(dirs[1]!, /^.*\/\.tre\/agent\/skills$/);
});

test("exitCodeFor: stop 0, budget/loop/stall 3, error/length/toolUse 1, aborted 130", () => {
  assert.equal(exitCodeFor("stop"), 0);
  assert.equal(exitCodeFor("budget"), 3);
  assert.equal(exitCodeFor("loop"), 3);
  assert.equal(exitCodeFor("stall"), 3);
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

test("main: bare launch on piped stdin → plain REPL (ui auto), exits 0 on EOF", async (t) => {
  // node --test runs with non-TTY stdin; under a real TTY the auto resolver
  // would pick the TUI, so skip there.
  if (process.stdin.isTTY) t.skip("stdin is a TTY");
  const { dir, models } = await workspace(t);
  const S = mkSinks();
  // Feed one prompt + EOF into the REPL's input — the same burst the e2e
  // harness sends to a piped `tre.` (WS10 s8). An injectable stream (not
  // process.stdin) so multiple REPL tests can run in one process.
  const code = await main(["--tools", "none", "--models", models, "--cwd", dir], {
    streamFn: fakeStream([{ type: "text", text: "hi there" }]),
    sinks: S.sinks,
    stdin: pipedStdin(["say hi\n"]),
  });
  assert.equal(code, 0);
  assert.match(S.err(), /REPL/); // the plain REPL banner, not the Ink TUI
  assert.match(S.out(), /hi there/); // the scripted turn's text was streamed
});

/** A fresh piped REPL stdin (per test) — the shared process.stdin can only
 *  be pushed-to ONCE (EOF), so each REPL test owns its own stream. */
function pipedStdin(lines: string[]): NodeJS.ReadableStream {
  const r = new Readable({ read: () => {} });
  for (const l of lines) r.push(l);
  r.push(null);
  return r;
}

test("A6: REPL /compact forces a compaction (summarizer call + session entry + ✂ line)", async (t) => {
  const { dir, models } = await workspace(t);
  const session = join(dir, "s.jsonl");
  await seedHistory(dir, models, session);

  const S = mkSinks();
  // turn 1 (a normal run), then /compact (the silent summarizer call), EOF.
  const code = await main(
    ["--resume", session, "--tools", "none", "--models", models, "--cwd", dir],
    {
      streamFn: fakeStream([
        { type: "text", text: "ok" }, // turn 1
        { type: "text", text: "SUMMARY." }, // the /compact summarizer call
      ]),
      sinks: S.sinks,
      stdin: pipedStdin(["go\n", "/compact\n"]),
    },
  );
  assert.equal(code, 0);
  assert.match(S.err(), /✂ context compacted/, "the ✂ line prints like the auto path");
  const replayed = await replaySession(session);
  // [summary, a1, u2, a2] — the folded prefix (u1) became the summary.
  assert.equal(replayed.context.length, 4);
  const head = replayed.context[0]!;
  assert.equal(head.role, "user");
  if (head.role === "user") {
    assert.match(head.content, /Compaction summary of earlier context/);
    assert.match(head.content, /SUMMARY\./);
  }
  const compact = replayed.entries.find((e) => e.type === "compaction");
  assert.ok(compact, "a compaction entry was appended");
});

test("A6: REPL /compact with --no-compact → disabled note, no summarizer call", async (t) => {
  const { dir, models } = await workspace(t);
  const S = mkSinks();
  let calls = 0;
  const code = await main(
    ["--tools", "none", "--models", models, "--cwd", dir, "--no-compact"],
    {
      streamFn: (m, ctx, o) => {
        calls += 1;
        return fakeStream([{ type: "text", text: "x" }])(m, ctx, o);
      },
      sinks: S.sinks,
      stdin: pipedStdin(["/compact\n"]),
    },
  );
  assert.equal(code, 0);
  assert.match(S.err(), /compaction disabled/);
  assert.equal(calls, 0, "no LLM call");
});

test("A6: REPL /compact with nothing to fold → 'nothing to compact'", async (t) => {
  const { dir, models } = await workspace(t);
  const S = mkSinks();
  let calls = 0;
  const code = await main(["--tools", "none", "--models", models, "--cwd", dir], {
    streamFn: (m, ctx, o) => {
      calls += 1;
      return fakeStream([{ type: "text", text: "x" }])(m, ctx, o);
    },
    sinks: S.sinks,
    stdin: pipedStdin(["/compact\n"]),
  });
  assert.equal(code, 0);
  assert.match(S.err(), /nothing to compact/);
  assert.equal(calls, 0, "no LLM call (the plan check precedes it)");
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

// ─────────────────────── startup config guide (deployability) ───────────────────────

test("main: no models.json → step-by-step config guide (REQUIRED/NEEDED), exit 2", async (t) => {
  const { dir } = await workspace(t);
  const S = mkSinks();
  const code = await main(["run", "x", "--models", join(dir, "missing.json")], {
    streamFn: fakeStream([{ type: "text", text: "x" }]),
    sinks: S.sinks,
  });
  assert.equal(code, 2);
  const err = S.err();
  assert.match(err, /none is configured yet/);
  assert.match(err, /REQUIRED/);
  assert.match(err, /baseUrl — NEEDED/);
  assert.match(err, /OPTIONAL/);
  assert.match(err, /apiKey — \(unset\)/);
});

test("main: models.json with blank baseUrl → adaptive guide (populated shown, baseUrl NEEDED), exit 2", async (t) => {
  const { dir } = await workspace(t);
  const models = join(dir, "models.json");
  await writeFile(
    models,
    JSON.stringify({
      default: "m1",
      models: [{ id: "m1", provider: "vks", contextWindow: 131072, maxTokens: 32768, temperature: 0.6 }],
    }),
  );
  const S = mkSinks();
  const code = await main(["run", "x", "--models", models], {
    streamFn: fakeStream([{ type: "text", text: "x" }]),
    sinks: S.sinks,
  });
  assert.equal(code, 2);
  const err = S.err();
  // Populated fields are shown with their values…
  assert.match(err, /id — populated: "m1"/);
  assert.match(err, /provider — populated: "vks"/);
  assert.match(err, /contextWindow — populated: 131072/);
  assert.match(err, /temperature — populated: 0.6/);
  // …and the missing endpoint field is NEEDED.
  assert.match(err, /baseUrl — NEEDED/);
});

test("main: models.json WITH a baseUrl → no guide (proceeds to run)", async (t) => {
  const { dir, models } = await workspace(t);
  const S = mkSinks();
  const code = await main(["run", "say hi", "--tools", "none", "--models", models], {
    streamFn: fakeStream([{ type: "text", text: "hi" }]),
    sinks: S.sinks,
  });
  assert.equal(code, 0);
  // A configured endpoint never triggers the setup guide.
  assert.doesNotMatch(S.err(), /none is configured yet/);
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

test("steering: a steer typed during a run is answered (keep-alive) and persisted to the session", async (t) => {
  const { dir } = await workspace(t);
  const sessionPath = join(dir, "s.jsonl");
  const session = await Session.create(sessionPath, {
    cwd: dir,
    model: { id: MODEL.id, provider: "fake" },
  });
  t.after(() => session.close());
  const silent: PrintSinks = { out: { write: () => true }, err: { write: () => true } };

  const q: { list: string[] } = { list: [] };
  const steeringQueue = {
    push: (text: string) => q.list.push(text),
    drain: () => {
      const out = q.list;
      q.list = [];
      return out;
    },
  };

  // Turn 1: the stream starts, the user's steer arrives MID-turn (after the
  // per-turn drain), then the model finishes text-only — the pending steer
  // must keep the run alive for a turn-2 answer.
  let turn = 0;
  const streamFn: StreamFn = (model, _ctx, _opts) =>
    (async function* () {
      turn++;
      const base: AssistantMessage = {
        role: "assistant",
        content: [],
        model: model.id,
        provider: model.provider,
        stopReason: "stop",
        timestamp: Date.now(),
      };
      yield { type: "start", partial: base };
      if (turn === 1) steeringQueue.push("steer me left");
      const text = turn === 1 ? "turn one" : "steering received";
      const partial: AssistantMessage = {
        ...base,
        content: [{ type: "text", text }],
      };
      yield { type: "text_delta", delta: text, partial };
      yield { type: "done", message: partial };
    })();

  const { outcome, context } = await runTurn({
    model: MODEL,
    systemPrompt: "sys",
    tools: [],
    streamFn,
    controller: new AbortController(),
    context: [],
    session,
    prompt: "start the run",
    sinks: silent,
    maxTurns: 8,
    steeringQueue,
  });
  assert.equal(outcome.stopReason, "stop");

  // Context: prompt, assistant 1, steer (delivered mid-run), assistant 2.
  const users = context.filter((m) => m.role === "user");
  assert.equal(users.length, 2);
  if (users[1]!.role === "user") assert.equal(users[1]!.content, "steer me left");
  const assistants = context.filter((m) => m.role === "assistant");
  assert.equal(assistants.length, 2, "the pending steer kept the run alive");

  // Session persistence: the steer's user message must be in the file, so a
  // resumed run keeps the guidance the user gave mid-run.
  const replayed = await replaySession(sessionPath);
  const replayUsers = replayed.context.filter((m) => m.role === "user");
  assert.equal(replayUsers.length, 2, "prompt + steer are both persisted");
  if (replayUsers[1]!.role === "user") assert.equal(replayUsers[1]!.content, "steer me left");
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

test("WS7: mutating bash denied (--ask) → run completes, model gets an isError result", async (t) => {
  const { dir, models } = await workspace(t);
  const session = join(dir, "s.jsonl");
  const streamFn = fakeStream([
    { type: "toolcall", calls: [{ name: "bash", args: { command: "curl -s https://example.com" } }] },
    { type: "text", text: "the command was denied" },
  ]);
  const S = mkSinks();
  const asked: string[] = [];
  // The default mode is "ask" (prompt only sensitive + destructive); --ask
  // is explicit here to be unambiguous that we are exercising the
  // prompt-per-call path for a MUTATING command.
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
  assert.equal(asked.length, 1, "the mutating call was prompted");
  assert.match(asked[0]!, /bash/);
  assert.match(S.out(), /✗/, "blocked call prints an error line");
  assert.match(S.out(), /denied/);

  const replayed = await replaySession(session);
  const tr = replayed.context.find((m) => m.role === "toolResult");
  assert.ok(tr && tr.role === "toolResult", "the tool result is in the session");
  assert.equal(tr.isError, true, "the denial is an isError tool result (D7/I3)");
  assert.match(tr.content.map((c) => c.text).join(" "), /denied/);
});

test("WS7: read-only bash runs WITHOUT a prompt in default (ask) mode", async (t) => {
  const { dir, models } = await workspace(t);
  const streamFn = fakeStream([
    { type: "toolcall", calls: [{ name: "bash", args: { command: "ls -la" } }] },
    { type: "text", text: "ok" },
  ]);
  const S = mkSinks();
  let asked = 0;
  const code = await main(["run", "list files", "--tools", "bash", "--models", models], {
    streamFn,
    sinks: S.sinks,
    askApproval: async () => {
      asked++;
      return true;
    },
  });
  assert.equal(code, 0);
  assert.equal(asked, 0, "read-only bash must not prompt in ask mode");
  assert.match(S.out(), /total/, "the ls output is in the transcript");
});

test("WS7: --yes auto-approves read-only bash; sys destructive + sys sensitive are blocked (isError)", async (t) => {
  const { dir, models } = await workspace(t);
  const session = join(dir, "s.jsonl");
  const streamFn = fakeStream([
    // A read-only command is auto-approved under --yes (the default) and runs.
    { type: "toolcall", calls: [{ name: "bash", args: { command: "ls -la" } }] },
    // A system-level destructive (dd to a raw device) is BLOCKED in every mode.
    { type: "toolcall", calls: [{ name: "bash", args: { command: "dd if=x of=/dev/sda" } }] },
    // A system-level sensitive read (outside the workspace) is BLOCKED.
    { type: "toolcall", calls: [{ name: "read", args: { path: "~/.ssh/id_rsa" } }] },
    { type: "text", text: "done" },
  ]);
  const S = mkSinks();
  const asked: string[] = [];
  const code = await main(
    ["run", "go", "--tools", "bash,read", "--yes", "--models", models, "--session", session],
    {
      streamFn,
      sinks: S.sinks,
      askApproval: async (q) => {
        asked.push(q);
        return false;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(asked.length, 0, "read-only auto-approved; sys destructive + sys sensitive blocked (no prompt)");
  const replayed = await replaySession(session);
  const trs = replayed.context.filter((m) => m.role === "toolResult");
  assert.equal(trs.length, 3, "all three tool results are in the session");
  assert.equal(trs[0]?.isError, undefined, "read-only bash (ls) ran under --yes");
  assert.equal(trs[1]?.isError, true, "sys destructive (dd) is blocked");
  assert.match(trs[1]!.content.map((c) => c.text).join(" "), /systemic destructive/);
  assert.equal(trs[2]?.isError, true, "sys sensitive read is blocked");
  assert.match(trs[2]!.content.map((c) => c.text).join(" "), /system-level sensitive/);
});

test("WS7: sys sensitive read is blocked even under --yes (isError)", async (t) => {
  const { dir, models } = await workspace(t);
  const session = join(dir, "s.jsonl");
  const streamFn = fakeStream([
    { type: "toolcall", calls: [{ name: "read", args: { path: "~/.ssh/id_rsa" } }] },
    { type: "text", text: "denied" },
  ]);
  const S = mkSinks();
  const asked: string[] = [];
  const code = await main(
    ["run", "read the key", "--tools", "read", "--yes", "--models", models, "--session", session],
    {
      streamFn,
      sinks: S.sinks,
      askApproval: async (q) => {
        asked.push(q);
        return false;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(asked.length, 0, "sys sensitive reads are blocked, never prompted");
  const replayed = await replaySession(session);
  const tr = replayed.context.find((m) => m.role === "toolResult");
  assert.ok(tr && tr.role === "toolResult");
  assert.equal(tr.isError, true);
  assert.match(tr.content.map((c) => c.text).join(" "), /system-level sensitive/);
});

test("WS7: --no-approve allows read-only bash but blocks mutating (no prompts)", async (t) => {
  const { dir, models } = await workspace(t);
  const streamFn = fakeStream([
    { type: "toolcall", calls: [{ name: "bash", args: { command: "pwd" } }] },
    { type: "toolcall", calls: [{ name: "bash", args: { command: "mv a b" } }] },
    { type: "text", text: "done" },
  ]);
  const S = mkSinks();
  let asked = 0;
  const code = await main([
    "run", "run it", "--tools", "bash", "--no-approve", "--models", models,
    "--cwd", dir, "--session", join(dir, "s.jsonl"),
  ], {
    streamFn,
    sinks: S.sinks,
    askApproval: async () => {
      asked++;
      return true;
    },
  });
  assert.equal(code, 0);
  assert.equal(asked, 0, "--no-approve must never prompt");
  assert.match(S.out(), /✗.*no-approve/, "the mutating call is blocked");
  assert.match(S.out(), new RegExp(dir), "the read-only call ran (pwd printed the root)");
});

test("WS7: sandbox — absolute path outside root is refused even with --yes", async (t) => {
  const { dir, models } = await workspace(t);
  // Hermetic: pin an EMPTY tre.json (no durable extra roots) so the refusal
  // message is the no-extra-roots form, regardless of the repo's own
  // (gitignored) tre.json that findTreConfig would otherwise walk up to.
  const treConfig = join(dir, "tre.json");
  await writeFile(treConfig, JSON.stringify({ extraRoots: [] }));
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
    { streamFn, sinks: S.sinks, treConfigPath: treConfig },
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
  // Hermetic: pin an EMPTY tre.json (no durable extra roots) so the refusal
  // message is the no-extra-roots form, regardless of the repo's own
  // (gitignored) tre.json that findTreConfig would otherwise walk up to.
  const treConfig = join(dir, "tre.json");
  await writeFile(treConfig, JSON.stringify({ extraRoots: [] }));
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
    { streamFn, sinks: S.sinks, treConfigPath: treConfig },
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

// ──────────────────────────────── C35: extra roots ────────────────────────────────

test("C35 parseArgs: --extra-root is repeatable and collected in order", () => {
  const a = parseArgs(["run", "x", "--extra-root", "/a/b", "--extra-root", "/c/d"]);
  assert.deepEqual(a.extraRoots, ["/a/b", "/c/d"]);
  assert.deepEqual(parseArgs(["run", "x"]).extraRoots, []);
  // a bare --extra-root with no value is an error (like other value flags).
  assert.notDeepEqual(parseArgs(["run", "x", "--extra-root"]).errors, []);
});

test("C35 behaviorSettingsLines: extra roots render; empty → no extra line", () => {
  const none = behaviorSettingsLines("yes", true);
  assert.ok(none.some((l) => l.includes("sandbox:  on (bash confined to the workspace)")));
  assert.ok(!none.some((l) => l.includes("extra roots")));
  // durable (tre.json) and one-shot (--extra-root) roots render SEPARATELY,
  // each labeled; a one-shot root also earns the "not written to tre.json" note.
  const withRoots = behaviorSettingsLines("yes", true, ["/home/u/d"], ["/home/u/o"]);
  assert.ok(
    withRoots.some((l) => l.includes("sandbox:  on (bash confined to the workspace + extra roots)")),
  );
  assert.ok(
    withRoots.some((l) =>
      l.includes("extra roots (durable, from tre.json): /home/u/d  (read+write, in addition to the workspace)"),
    ),
  );
  assert.ok(
    withRoots.some((l) =>
      l.includes("extra roots (THIS LAUNCH ONLY, --extra-root): /home/u/o  (read+write, in addition to the workspace)"),
    ),
  );
  assert.ok(withRoots.some((l) => l.includes("is one-shot (this launch only) and is NOT written to tre.json")));
  // durable-only → no one-shot line, no note; one-shot-only → no durable line.
  const durableOnly = behaviorSettingsLines("yes", true, ["/home/u/d"]);
  assert.ok(durableOnly.some((l) => l.includes("extra roots (durable, from tre.json): /home/u/d")));
  assert.ok(!durableOnly.some((l) => l.includes("THIS LAUNCH ONLY")));
  const oneShotOnly = behaviorSettingsLines("yes", true, [], ["/home/u/o"]);
  assert.ok(oneShotOnly.some((l) => l.includes("extra roots (THIS LAUNCH ONLY, --extra-root): /home/u/o")));
  assert.ok(!oneShotOnly.some((l) => l.includes("durable, from tre.json")));
  // sandbox off still reports off (extra roots don't change that line's state).
  const off = behaviorSettingsLines("yes", false, ["/home/u/d"], ["/home/u/o"]);
  assert.ok(off.some((l) => l.includes("sandbox:  off (--no-sandbox)")));
});

test("C35 main: --extra-root pointing at a nonexistent dir → exit 2 + refusal", async (t) => {
  const { dir, models } = await workspace(t);
  const S = mkSinks();
  const code = await main(
    [
      "run", "x", "--models", models, "--cwd", dir,
      "--extra-root", join(dir, "does-not-exist"),
    ],
    { streamFn: fakeStream([{ type: "text", text: "x" }]), sinks: S.sinks },
  );
  assert.equal(code, 2);
  assert.match(S.err(), /--extra-root .*does not exist/);
});

test(
  "C35 main: --extra-root (valid dir under home) → exit 0, summary lists it",
  {
    // The valid e2e needs an EXISTING dir under home to point at. The repo
    // root qualifies (it is under ~ and non-sensitive); home is readable even
    // under an inherited kernel sandbox, so no write is required. Skip when
    // the repo is not under home (e.g. a CI checkout elsewhere).
    skip:
      !process.env.HOME ||
      !process.cwd().startsWith(process.env.HOME + "/")
        ? "repo is not under $HOME — no valid in-home extra root to point at"
        : false,
  },
  async (t) => {
    const { dir, models } = await workspace(t);
    const S = mkSinks();
    const code = await main(
      [
        "run", "x", "--models", models, "--cwd", dir,
        "--extra-root", process.cwd(),
      ],
      { streamFn: fakeStream([{ type: "text", text: "x" }]), sinks: S.sinks },
    );
    assert.equal(code, 0);
    // The --extra-root value is a ONE-SHOT root: it renders on the labeled
    // "THIS LAUNCH ONLY" line (not the durable tre.json line).
    assert.match(S.err(), /extra roots \(THIS LAUNCH ONLY, --extra-root\): .*\(read\+write, in addition to the workspace\)/);
  },
);

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

test("WS9: failed summary call → D ladder: retry fails too → rule-based fallback (degraded), run continues", async (t) => {
  const { dir, models } = await workspace(t);
  const session = join(dir, "s.jsonl");
  await seedHistory(dir, models, session);

  const base = fakeStream([
    { type: "toolcall", calls: [{ name: "bash", args: { command: "echo fresh" } }], usage: { input: 1890, output: 10, totalTokens: 1900 } },
    { type: "error", message: "summarizer down" }, // the silent call fails
    { type: "error", message: "summarizer still down" }, // the retry fails too
    { type: "text", text: "final" },
  ]);
  const S = mkSinks();
  const code = await main(["run", "new task", "--resume", session, "--tools", "bash", "--yes", "--models", models], {
    streamFn: base,
    sinks: S.sinks,
  });
  assert.equal(code, 0, "a failed summary call never fails the run");
  assert.match(S.err(), /retrying with a smaller transcript/, "the retry is announced");
  assert.match(S.err(), /rule-based shrink/, "the fallback is announced");
  assert.match(S.err(), /✂ context compacted.*degraded/, "the ✂ line notes the degraded mode");
  const replayed = await replaySession(session);
  // [notice, a1, u2, a1', tr] + turn 2's final answer = 6 — the folded
  // prefix (u1) is replaced by the rule-based notice.
  assert.equal(replayed.context.length, 6);
  const head = replayed.context[0]!;
  assert.equal(head.role, "user");
  if (head.role === "user") {
    assert.match(head.content, /Compaction summary of earlier context/);
    assert.match(head.content, /discarded without an LLM summary/);
  }
  // The fallback still wrote a compaction entry (replay boundary).
  const compact = replayed.entries.find((e) => e.type === "compaction");
  assert.ok(compact, "a compaction entry was appended");
  if (compact.type === "compaction") {
    assert.ok(replayed.contextEntryIds.includes(compact.firstKeptEntryId), "firstKeptEntryId resolves");
  }
});

// ─────────────────────────────── D: compactNow (failure escalation) ───────────────────────────────

/** A context that trips the trigger on SMALL_WINDOW (2000/100): the last
 *  assistant usage (1900) + maxTokens (100) + slack (1024) > 2000. */
function overBudgetContext(): AgentMessage[] {
  return [
    { role: "user", content: "q1".repeat(200), timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/a.ts" } }],
      model: "fake-model",
      provider: "fake",
      stopReason: "toolUse",
      timestamp: 2,
      usage: { input: 1890, output: 10, totalTokens: 1900 },
    },
    // Big folded tool result: the retry's shrunken clips (750/12000 vs
    // 1500/24000) actually make the retry prompt smaller.
    { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "r".repeat(10000) }], timestamp: 3 },
    // The kept tail must reach keepTokens (windowCap 876) so the folded
    // prefix includes the toolCall unit (its file op lands in the notice).
    { role: "user", content: "q2".repeat(2000), timestamp: 4 },
    {
      role: "assistant",
      content: [{ type: "text", text: "a2".repeat(2000) }],
      model: "fake-model",
      provider: "fake",
      stopReason: "stop",
      timestamp: 5,
      usage: { input: 1890, output: 10, totalTokens: 1900 },
    },
  ];
}

function compactNowDeps(streamFn: StreamFn, extra?: Record<string, unknown>) {
  const events: AgentEvent[] = [];
  const S = mkSinks();
  return {
    deps: {
      streamFn,
      model: SMALL_WINDOW,
      signal: new AbortController().signal,
      context: overBudgetContext(),
      session: null,
      ids: new Map<AgentMessage, string>(),
      systemPrompt: "sys",
      sinks: S.sinks,
      onEvent: async (ev: AgentEvent) => {
        events.push(ev);
      },
      ...extra,
    },
    events,
    err: S.err,
  };
}

test("D: compactNow — first call fails, retry succeeds (no degraded flag)", async () => {
  const { deps, events, err } = compactNowDeps(
    fakeStream([{ type: "error", message: "down" }, { type: "text", text: "SUMMARY." }]),
  );
  const r = await compactNow(deps);
  assert.ok(r, "the retry produced a new context");
  assert.equal(r![0]!.role, "user");
  if (r![0]!.role === "user") assert.match(r![0]!.content, /SUMMARY\./);
  assert.match(err(), /retrying with a smaller transcript/);
  assert.doesNotMatch(err(), /rule-based shrink/);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "context_compacted");
  if (events[0]!.type === "context_compacted") assert.equal(events[0]!.degraded, undefined);
});

test("D: compactNow — both calls fail → rule-based fallback, degraded: true", async () => {
  const { deps, events, err } = compactNowDeps(
    fakeStream([{ type: "error", message: "down" }, { type: "error", message: "still down" }]),
  );
  const r = await compactNow(deps);
  assert.ok(r, "the fallback produced a new context");
  assert.equal(r![0]!.role, "user");
  if (r![0]!.role === "user") {
    assert.match(r![0]!.content, /Compaction summary of earlier context/);
    assert.match(r![0]!.content, /discarded without an LLM summary/);
    // C3: the folded prefix's file ops survive in the notice.
    assert.match(r![0]!.content, /src\/a\.ts/);
  }
  assert.match(err(), /summary failed twice — fell back to rule-based shrink/);
  assert.equal(events.length, 1);
  if (events[0]!.type === "context_compacted") assert.equal(events[0]!.degraded, true);
  // The context strictly shrank.
  assert.ok(r!.length < deps.context.length);
});

test("D: compactNow — retry prompt is smaller than the first", async () => {
  const ctxs: LlmContext[] = [];
  const base = fakeStream([{ type: "error", message: "down" }, { type: "text", text: "S." }]);
  const fn: StreamFn = (m, ctx, o) => {
    ctxs.push({ ...ctx, messages: [...ctx.messages] });
    return base(m, ctx, o);
  };
  const { deps } = compactNowDeps(fn);
  const r = await compactNow(deps);
  assert.ok(r);
  assert.equal(ctxs.length, 2);
  const first = ctxs[0]!.messages[0]!;
  const second = ctxs[1]!.messages[0]!;
  assert.equal(first.role, "user");
  assert.equal(second.role, "user");
  assert.ok(second.content.length < first.content.length, "the retry prompt is smaller");
});

test("D: compactNow — trigger not met → undefined, no LLM call", async () => {
  let calls = 0;
  const fn: StreamFn = () => {
    calls += 1;
    return (async function* () {})();
  };
  const { deps, events } = compactNowDeps(fn, {
    context: [
      { role: "user", content: "q1", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "a1" }],
        model: "fake-model",
        provider: "fake",
        stopReason: "stop",
        timestamp: 2,
        usage: { input: 100, output: 10, totalTokens: 110 },
      },
    ],
  });
  const r = await compactNow(deps);
  assert.equal(r, undefined);
  assert.equal(calls, 0, "no summarizer call when the trigger is not met");
  assert.equal(events.length, 0);
});

test("D: compactNow — force: true compacts even when the trigger is not met", async () => {
  const { deps, events } = compactNowDeps(
    fakeStream([{ type: "text", text: "SUMMARY." }]),
    {
      force: true,
      // Sized so a plan exists (the tail reaches keepTokens 876 and the
      // first unit is foldable).
      context: [
        { role: "user", content: "q1".repeat(1000), timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "a1".repeat(1000) }],
          model: "fake-model",
          provider: "fake",
          stopReason: "stop",
          timestamp: 2,
          usage: { input: 100, output: 10, totalTokens: 110 },
        },
        { role: "user", content: "q2".repeat(1000), timestamp: 3 },
        {
          role: "assistant",
          content: [{ type: "text", text: "a2".repeat(1000) }],
          model: "fake-model",
          provider: "fake",
          stopReason: "stop",
          timestamp: 4,
          usage: { input: 100, output: 10, totalTokens: 110 },
        },
      ],
    },
  );
  const r = await compactNow(deps);
  assert.ok(r, "force compacts without the trigger");
  if (events[0]!.type === "context_compacted") assert.equal(events[0]!.degraded, undefined);
});

test("D: compactNow — force with a too-short context → undefined (no plan)", async () => {
  const { deps, err } = compactNowDeps(
    fakeStream([{ type: "text", text: "S." }]),
    { force: true, context: [{ role: "user", content: "q1", timestamp: 1 }] },
  );
  const r = await compactNow(deps);
  assert.equal(r, undefined);
  assert.match(err(), /no safe shrink is possible/);
});
