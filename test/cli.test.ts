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
 * Live vertical slice: test/cli-live.test.ts (RUN_LIVE=1).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
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

test("parseArgs: REPL mode has no prompt requirement", () => {
  const a = parseArgs([]);
  assert.deepEqual(a.errors, []);
  assert.equal(a.oneShot, false);
});

test("parseArgs: errors", () => {
  assert.notDeepEqual(parseArgs(["run"]).errors, []);
  assert.notDeepEqual(parseArgs(["--bogus"]).errors, []);
  assert.notDeepEqual(parseArgs(["--model"]).errors, []);
  assert.notDeepEqual(parseArgs(["run", "x", "--session", "a", "--resume", "b"]).errors, []);
  assert.notDeepEqual(parseArgs(["run", "x", "--max-turns", "0"]).errors, []);
});

test("resolveTools: all / none / filter / unknown", () => {
  assert.equal(resolveTools("all").tools.length, 4);
  assert.equal(resolveTools("none").tools.length, 0);
  const f = resolveTools("bash,read");
  assert.deepEqual(f.tools.map((t) => t.name).sort(), ["bash", "read"]);
  assert.match(resolveTools("bash,nope")!.error ?? "", /unknown tool/);
});

test("exitCodeFor: stop 0, aborted 130, error/length/toolUse 1", () => {
  assert.equal(exitCodeFor("stop"), 0);
  assert.equal(exitCodeFor("aborted"), 130);
  assert.equal(exitCodeFor("error"), 1);
  assert.equal(exitCodeFor("length"), 1);
  assert.equal(exitCodeFor("toolUse"), 1);
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

test("main one-shot: real bash tool round-trip, 4-message session", async (t) => {
  const { dir, models } = await workspace(t);
  const session = join(dir, "s.jsonl");
  const streamFn = fakeStream([
    { type: "toolcall", calls: [{ name: "bash", args: { command: "echo roundtrip-ok" } }] },
    { type: "text", text: "done" },
  ]);
  const S = mkSinks();
  const code = await main(["run", "list files", "--tools", "bash", "--models", models, "--session", session], {
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
