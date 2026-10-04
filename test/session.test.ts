/**
 * WS5 — tests for session persistence (JSONL append + replay/resume).
 *
 * Covers the WS5 exit criteria (PLAN.md):
 *   - append N messages → kill → replay → identical AgentMessage[].
 *     The kill is real: a child process creates the session, appends the
 *     messages, then exits with code 1 WITHOUT close() — so torn-tail and
 *     durability behavior is exercised, not simulated in-process.
 *   - resume continues the loop from the replayed context (runLoop seeded
 *     with the replayed messages, scripted fakeStream).
 * Plus: the compaction-boundary seam WS9 will build on (single + chained
 * boundaries, invalid reference), modelChange tracking, torn-tail drop,
 * mid-file corruption, and create/open boundary behavior.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeStream } from "./fake-stream.js";
import { runLoop } from "../src/loop/agent-loop.js";
import {
  Session,
  aggregateSessionUsage,
  defaultSessionPath,
  defaultUsageDirs,
  loadSession,
  replayContext,
  replaySession,
  SESSION_FORMAT_VERSION,
  type CompactionEntry,
  type SessionEntry,
} from "../src/session/session.js";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  LlmContext,
  ModelConfig,
  StreamFn,
  ToolResultMessage,
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

const userMsg = (text: string, ts: number): UserMessage => ({
  role: "user",
  content: text,
  timestamp: ts,
});

/**
 * One full mini-conversation: user → assistant(thinking + text + toolCall)
 * → toolResult → assistant(stop). Exercises every AgentMessage role and
 * every content-block kind, so a replay that is deep-equal proves the
 * JSON round-trip preserves the whole union (contract: JSON-serializable,
 * no runtime-only fields).
 */
function fixtureMessages(): AgentMessage[] {
  const user: UserMessage = userMsg("create hello.txt", 1_000);
  const call: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "use the write tool" },
      { type: "text", text: "Creating the file." },
      {
        type: "toolCall",
        id: "call_1",
        name: "write",
        arguments: { path: "hello.txt", content: "hi" },
      },
    ],
    model: MODEL.id,
    provider: MODEL.provider,
    stopReason: "toolUse",
    usage: { input: 100, output: 40, cacheRead: 60, totalTokens: 140 },
    timestamp: 2_000,
  };
  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "write",
    content: [{ type: "text", text: "Wrote 2 bytes to hello.txt" }],
    details: { bytesWritten: 2 },
    timestamp: 3_000,
  };
  const done: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    model: MODEL.id,
    provider: MODEL.provider,
    stopReason: "stop",
    usage: { input: 140, output: 10, totalTokens: 150 },
    timestamp: 4_000,
  };
  return [user, call, result, done];
}

/** Absolute path of the COMPILED session module (tests run from dist/test/). */
const SESSION_MODULE = fileURLToPath(
  new URL("../src/session/session.js", import.meta.url),
);

/**
 * Run a child process that creates a session, appends `messages`, and then
 * dies without close() — a simulated kill. Resolves with the exit code.
 */
async function appendAndKill(
  path: string,
  messages: AgentMessage[],
): Promise<number> {
  const script = `
    const { Session } = await import(${JSON.stringify(SESSION_MODULE)});
    const s = await Session.create(process.argv[1], {
      cwd: "/tmp",
      model: { id: "fake-model", provider: "fake" },
    });
    const messages = JSON.parse(process.argv[2]);
    for (const m of messages) await s.appendMessage(m);
    process.exit(1); // the kill: unclean exit, no close()
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, path, JSON.stringify(messages)], {
    stdio: "pipe",
  });
  const stderr = await new Promise<string>((resolve) => {
    let buf = "";
    child.stderr.on("data", (d) => (buf += String(d)));
    child.on("close", () => resolve(buf));
  });
  const code = child.exitCode;
  assert.equal(code, 1, `child should exit 1 (the simulated kill), got ${code}: ${stderr}`);
  // A clean kill prints nothing. Non-empty stderr means the child crashed
  // BEFORE the simulated kill (e.g. a bad module path) — surface it.
  assert.equal(stderr, "", `child wrote to stderr (crashed before the kill?): ${stderr}`);
  return code;
}

test("append N messages → kill → replay → identical AgentMessage[]", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-kill-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const fixture = fixtureMessages();
  const path = join(dir, "killed.jsonl");
  await appendAndKill(path, fixture);

  const replayed = await replaySession(path);
  assert.equal(replayed.header.version, SESSION_FORMAT_VERSION);
  assert.equal(replayed.droppedTornTail, false);
  // Exit criterion: the replayed context is DEEP-EQUAL to what was appended.
  assert.deepEqual(replayed.context, fixture);
  // The initial modelChange (passed to create) is part of the log.
  assert.deepEqual(replayed.model, { id: "fake-model", provider: "fake" });
});

test("clean close → replay is identical (happy path)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-clean-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const fixture = fixtureMessages();
  const path = join(dir, "clean.jsonl");
  const s = await Session.create(path, { model: MODEL });
  for (const m of fixture) await s.appendMessage(m);
  await s.close();

  const replayed = await replaySession(path);
  assert.deepEqual(replayed.context, fixture);
});

test("resume: the loop continues from the replayed context", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-resume-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const fixture = fixtureMessages();
  const path = join(dir, "resume.jsonl");
  const s = await Session.create(path, { model: MODEL });
  for (const m of fixture) await s.appendMessage(m);
  await s.close();

  const { context } = await replaySession(path);
  assert.deepEqual(context, fixture);

  // Seed a fresh run with the replayed context and verify the loop
  // (a) sends the replayed context to the wire, and
  // (b) ends with replayed + the new assistant message.
  const seen: LlmContext[] = [];
  const streamFn: StreamFn = (model, ctx, opts) => {
    // Snapshot: ctx.messages is the loop's live context array (I2 slot
    // replacement appends to it as the run proceeds).
    seen.push({ systemPrompt: ctx.systemPrompt, messages: ctx.messages.slice(), tools: ctx.tools });
    return fakeStream([{ type: "text", text: "continued" }])(model, ctx, opts);
  };
  const events: AgentEvent[] = [];
  for await (const ev of runLoop({
    model: MODEL,
    systemPrompt: "sys",
    initialMessages: context,
    tools: [],
    streamFn,
    signal: new AbortController().signal,
  })) {
    events.push(ev);
  }

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.messages, context);

  const end = events[events.length - 1]!;
  assert.equal(end.type, "agent_end");
  assert.equal(end.stopReason, "stop");
  assert.equal(end.messages.length, context.length + 1);
  assert.deepEqual(end.messages.slice(0, context.length), context);
  const last = end.messages[end.messages.length - 1]!;
  assert.equal(last.role, "assistant");
  if (last.role === "assistant") {
    const text = last.content.find((b) => b.type === "text");
    assert.deepEqual(text, { type: "text", text: "continued" });
  }
});

test("compaction boundary: context = summary + entries from firstKeptEntryId on", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-compact-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const m1 = userMsg("m1", 1);
  const m2 = userMsg("m2", 2);
  const m3 = userMsg("m3", 3);
  const m4 = userMsg("m4", 4);
  const m5 = userMsg("m5", 5);
  const m6 = userMsg("m6", 6);

  const path = join(dir, "compact.jsonl");
  const s = await Session.create(path);
  const ids: string[] = [];
  for (const m of [m1, m2, m3, m4, m5]) ids.push(await s.appendMessage(m));
  // Keep from m3 onward; m1/m2 are replaced by the summary.
  await s.appendCompaction(
    "EARLIER: user asked for a report; agent read A.md and wrote B.md.",
    ids[2]!,
    999,
  );
  await s.appendMessage(m6);
  await s.close();

  const replayed = await replaySession(path);
  assert.equal(replayed.context.length, 5);
  const first = replayed.context[0]!;
  assert.equal(first.role, "user");
  if (first.role === "user") {
    assert.ok(first.content.includes("EARLIER: user asked for a report"));
  }
  assert.deepEqual(replayed.context.slice(1), [m3, m4, m5, m6]);
});

test("chained compactions: a boundary may keep an earlier summary", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-chain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const path = join(dir, "chain.jsonl");
  const s = await Session.create(path);
  const id1 = await s.appendMessage(userMsg("m1", 1));
  const id2 = await s.appendMessage(userMsg("m2", 2));
  const c1 = await s.appendCompaction("SUMMARY ONE", id1, 500);
  await s.appendMessage(userMsg("m3", 3));
  const c2 = await s.appendCompaction("SUMMARY TWO", c1, 1200);
  await s.close();

  const replayed = await replaySession(path);
  // c1 kept from m1 onward, so: [summaryTwo, summaryOne (kept), m1, m2, m3]
  assert.equal(replayed.context.length, 5);
  assert.ok(replayed.context[0]!.role === "user" && (replayed.context[0] as UserMessage).content.includes("SUMMARY TWO"));
  assert.ok(replayed.context[1]!.role === "user" && (replayed.context[1] as UserMessage).content.includes("SUMMARY ONE"));
  assert.deepEqual(replayed.context.slice(2), [userMsg("m1", 1), userMsg("m2", 2), userMsg("m3", 3)]);
  // Both compaction entries remain in the log (immutable history).
  assert.equal(replayed.entries.filter((e) => e.type === "compaction").length, 2);
});

test("compaction referencing an unknown entry makes the session unreplayable (throws)", () => {
  const entries: SessionEntry[] = [
    { type: "header", version: SESSION_FORMAT_VERSION, id: "h", createdAt: 0 },
    { type: "message", id: "m1", message: userMsg("m1", 1) },
    {
      type: "compaction",
      id: "c1",
      summary: "s",
      firstKeptEntryId: "nope",
      tokensBefore: 1,
      timestamp: 2,
    } satisfies CompactionEntry,
  ];
  assert.throws(() => replayContext(entries), /unknown entry/);
});

test("torn trailing line is dropped and reported; earlier lines survive", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-torn-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const header = JSON.stringify({
    type: "header",
    version: SESSION_FORMAT_VERSION,
    id: "h",
    createdAt: 0,
  });
  const msg = JSON.stringify({ type: "message", id: "m1", message: userMsg("ok", 1) });
  const torn = '{"type":"message","id":"m2","message":{"role":"us'; // cut mid-line, no newline
  const path = join(dir, "torn.jsonl");
  await writeFile(path, header + "\n" + msg + "\n" + torn);

  const loaded = await loadSession(path);
  assert.equal(loaded.droppedTornTail, true);
  assert.equal(loaded.entries.length, 2);
  assert.deepEqual(replayContext(loaded.entries), [userMsg("ok", 1)]);
});

test("mid-file corruption throws (not a torn tail)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-bad-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const header = JSON.stringify({
    type: "header",
    version: SESSION_FORMAT_VERSION,
    id: "h",
    createdAt: 0,
  });
  const path = join(dir, "bad.jsonl");
  await writeFile(path, header + "\n" + "{not json\n");

  await assert.rejects(loadSession(path), /corrupt line 2/);
});

test("create refuses an existing file; open refuses a missing one", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-io-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });

  const path = join(dir, "x.jsonl");
  const s = await Session.create(path);
  await s.close();
  await assert.rejects(Session.create(path), /EEXIST|exist/);
  const reopened = await Session.open(path);
  await reopened.close();
  await assert.rejects(Session.open(join(dir, "missing.jsonl")));
});

test("appends after close() throw (I3: failure is a rejection, not a crash)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-closed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const path = join(dir, "closed.jsonl");
  const s = await Session.create(path);
  await s.close();
  await assert.rejects(s.appendMessage(userMsg("late", 9)), /closed/);
});

test("aggregateSessionUsage: sums assistant usage by model across .jsonl and .session files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-agg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const header = JSON.stringify({
    type: "header",
    version: SESSION_FORMAT_VERSION,
    id: "h",
    createdAt: 0,
  });
  // A realistic JSONL session: real newlines between entries, user +
  // toolResult entries mixed in (they carry no usage and must not count).
  const a1 = JSON.stringify({
    type: "message", id: "a1",
    message: { role: "assistant", model: "model-a", provider: "p", stopReason: "toolUse",
      content: [{ type: "text", text: "x" }],
      usage: { input: 100, output: 40, cacheRead: 60, totalTokens: 140 }, timestamp: 1 },
  });
  const u1 = JSON.stringify({ type: "message", id: "u1", message: userMsg("hi", 2) });
  const a2 = JSON.stringify({
    type: "message", id: "a2",
    message: { role: "assistant", model: "model-a", provider: "p", stopReason: "stop",
      content: [{ type: "text", text: "done" }],
      usage: { input: 140, output: 10, totalTokens: 150 }, timestamp: 3 },
  });
  await writeFile(join(dir, "one.jsonl"), [header, a1, u1, a2].join("\n") + "\n");

  // A second session in the .session spelling (delegation fanout logs) for
  // a different model, with a torn trailing line that must be ignored.
  const b1 = JSON.stringify({
    type: "message", id: "b1",
    message: { role: "assistant", model: "model-b", provider: "p", stopReason: "stop",
      content: [{ type: "text", text: "y" }],
      usage: { input: 50, output: 20, totalTokens: 70 }, timestamp: 4 },
  });
  await writeFile(join(dir, "two.session"), header + "\n" + b1 + "\n" + '{"type":"message","id":"b2","mess');

  const totals = await aggregateSessionUsage(dir);
  // model-a: 140 + 150 = 290 total; promptNew = (100-60) + 140 = 180;
  // promptCached = 60 + 0 = 60; generated = 40 + 10 = 50.
  assert.deepEqual(totals["model-a"], { total: 290, promptNew: 180, promptCached: 60, generated: 50 });
  // model-b: the torn tail is dropped, the valid entry counts.
  assert.deepEqual(totals["model-b"], { total: 70, promptNew: 50, promptCached: 0, generated: 20 });
  // No other buckets (user/toolResult/header entries must not create one).
  assert.equal(Object.keys(totals).length, 2);
});

test("aggregateSessionUsage: missing/empty directory and non-session files yield empty totals", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-agg-empty-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A file with the wrong extension must be ignored.
  await writeFile(join(dir, "notes.txt"), '{"type":"message","id":"x","message":{"role":"assistant","model":"m","usage":{"input":1,"output":1,"totalTokens":2}}}');
  assert.deepEqual(await aggregateSessionUsage(dir), {});
  // A missing directory is data, not an error.
  assert.deepEqual(await aggregateSessionUsage(join(dir, "nope")), {});
});

test("aggregateSessionUsage: recursive scan, multiple dirs, node_modules pruned, overlap de-duplicated", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-agg-rec-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const entry = (id: string, model: string, total: number): string =>
    JSON.stringify({ type: "message", id, message: { role: "assistant", model, provider: "p", stopReason: "stop", content: [{ type: "text", text: "x" }], usage: { input: total, output: 0, totalTokens: total }, timestamp: 1 } });

  // Nested layout, like the delegation fanout: <task>/logs/<id>.session.
  await mkdir(join(dir, "task-a", "logs"), { recursive: true });
  await writeFile(join(dir, "task-a", "logs", "w1.session"), entry("w1", "m-nested", 100));
  // node_modules must be pruned even when it contains a session-shaped file.
  await mkdir(join(dir, "node_modules", "x"), { recursive: true });
  await writeFile(join(dir, "node_modules", "x", "y.session"), entry("nm", "m-nested", 999999));
  // A second, separate directory contributes its own bucket.
  const dir2 = join(dir, "elsewhere");
  await mkdir(dir2, { recursive: true });
  await writeFile(join(dir2, "s.jsonl"), entry("e1", "m-other", 50));

  const totals = await aggregateSessionUsage([dir, dir2, dir2]); // dir2 listed twice
  assert.deepEqual(totals["m-nested"], { total: 100, promptNew: 100, promptCached: 0, generated: 0 });
  assert.deepEqual(totals["m-other"], { total: 50, promptNew: 50, promptCached: 0, generated: 0 });
  assert.equal(Object.keys(totals).length, 2); // node_modules entry excluded, no double count
});

test("defaultUsageDirs: flat session dirs + delegation trees, home and root", () => {
  const root = "/work/proj";
  assert.deepEqual(defaultUsageDirs(root), [
    join(homedir(), ".tre", "sessions"),
    join(root, ".tre", "sessions"),
    join(root, ".tre", "delegation"),
    join(homedir(), ".tre", "delegation"),
  ]);
});

test("defaultSessionPath (D20): deterministic UTC name under ~/.tre/sessions/, outside any repo", () => {
  // Sep 19, 2026, 10:05:03 UTC (month index 8 = September) — exercises the
  // zero-padding of month, day, and every time field.
  const at = new Date(Date.UTC(2026, 8, 19, 10, 5, 3));
  const p = defaultSessionPath(at, 4242);
  assert.equal(p, join(homedir(), ".tre", "sessions", "tre-20260919-100503-4242.jsonl"));
  // Starts under ~/.tre/sessions/ (never inside a repository) and is JSONL.
  assert.ok(p.startsWith(join(homedir(), ".tre", "sessions") + "/"), `expected prefix, got ${p}`);
  assert.ok(p.endsWith(".jsonl"));
  // Two different injected seconds produce two different paths.
  const oneSecondLater = defaultSessionPath(new Date(Date.UTC(2026, 8, 19, 10, 5, 4)), 4242);
  assert.notEqual(oneSecondLater, p);
});
