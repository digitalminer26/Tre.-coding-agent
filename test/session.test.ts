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
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
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

// docs/11 §13.1 regression (repro 2026-10-30; audits 2026-10-30 widened it):
// before the fix, Session.open after a torn tail appended BEHIND the partial
// line, so the session became permanently unloadable ("corrupt line 3").
// A crash can interrupt the last append at ANY byte after the previous "\n",
// leaving the file unterminated in two ways:
//   - a PARTIAL tail line (unparseable)     → truncate it away;
//   - a COMPLETE record minus its "\n"      → it parses, loadSession counts
//     it as an entry, so a naive "repair only when droppedTornTail" fix
//     misses it and the next append welds two records onto one line.
// The matrix cuts a real appended record at EVERY byte position (0 == killed
// before any byte landed; record.length == the fully-written control, which
// must be left byte-for-byte alone) and asserts, at each cut, that open
// REPAIRS TO THE EXACT EXPECTED BYTES before any further append, that
// repeated opens are idempotent, and that the session stays loadable. The
// cut record carries multibyte UTF-8 and JSON escapes, so cuts inside
// characters and inside escape sequences are exercised (audit P2).
test("Session.open repairs every crash cut of the final append; the session stays loadable", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-repair-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const path = join(dir, "s.jsonl");
  const s0 = await Session.create(path, { cwd: dir });
  await s0.appendMessage(userMsg("hello", 1));
  await s0.close();
  const prefix = await readFile(path); // header + "hello" record, newline-terminated

  // The record the crash interrupts: multibyte content + JSON escapes.
  const resumeMsg = userMsg('after resume 🦊 漢字 "quote" \\ back\\nslash', 2);
  const record = Buffer.from(
    JSON.stringify({ type: "message", id: "cut", message: resumeMsg }) + "\n",
  );

  for (let cut = 0; cut <= record.length; cut++) {
    // Crash mid-append: the record's first `cut` bytes arrived. Only cuts
    // 1..length-1 leave the file unterminated; cut 0 is "no byte landed"
    // and cut record.length is the fully-written control.
    await writeFile(path, Buffer.concat([prefix, record.subarray(0, cut)]));

    // Which cuts leave a record that survives repair? The fixture record is
    // a minified JSON OBJECT, so every truncated prefix of it (cut <
    // record.length - 1) fails to parse and is dropped; the only surviving
    // tails are the complete record minus its "\n" (cut length-1, which
    // loadSession counts as an entry) and the fully-written control (cut
    // length). This mirrors loadSession's parse-based rule, not open's
    // implementation — a truncated scalar tail (e.g. "1" from "10") COULD
    // also parse, but the object fixture guarantees it cannot.
    const survives = cut >= record.length - 1;

    const s1 = await Session.open(path); // must repair, not append past the tear
    await s1.close();

    // Repair asserted on the EXACT bytes, independent of any new append:
    // surviving tail → terminated in place; non-parsing partial →
    // truncated away; fully-written control → untouched.
    const expected = survives
      ? Buffer.concat([prefix, record])
      : prefix;
    assert.deepEqual(
      await readFile(path),
      expected,
      `cut ${cut}: open must repair to the exact boundary bytes`,
    );

    // Repair is idempotent: reopening a repaired file changes nothing.
    const s2 = await Session.open(path);
    await s2.close();
    assert.deepEqual(
      await readFile(path),
      expected,
      `cut ${cut}: repeated open is idempotent`,
    );

    const s3 = await Session.open(path);
    await s3.appendMessage(resumeMsg);
    await s3.close();

    const again = await loadSession(path); // threw (or welded) before the fix
    assert.equal(again.droppedTornTail, false, `cut ${cut}: tail must be clean`);
    const bytes = await readFile(path);
    assert.ok(
      bytes.subarray(0, expected.length).equals(expected),
      `cut ${cut}: repaired bytes must be untouched by the resume append`,
    );
    if (survives) {
      // The complete record survived: open must KEEP it (loadSession
      // counted it) and terminate the line — so the transcript is
      // prefix + survived record + the resume append.
      assert.equal(again.entries.length, 4, `cut ${cut}: survived record + resume append`);
      assert.deepEqual(replayContext(again.entries), [
        userMsg("hello", 1),
        resumeMsg, // the survived record
        resumeMsg, // the resume append
      ]);
    } else {
      assert.equal(again.entries.length, 3, `cut ${cut}: header + hello + resume append`);
      assert.deepEqual(replayContext(again.entries), [
        userMsg("hello", 1),
        resumeMsg,
      ]);
    }
  }
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

// ─────────────── D33: the guardStop entry (docs/08 §10) ───────────────

test("D33: appendGuardStop round-trips through loadSession; replay ignores the entry", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-guard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "guard.jsonl");

  const s = await Session.create(path, { model: MODEL });
  const before = await s.appendMessage(userMsg("do the thing", 1));
  const evidence = {
    guard: "identical-batch",
    signature: 'read:{"path":"x"}',
    repeats: 3,
    stable: true,
    guardRetries: 1,
  } as const;
  const entryId = await s.appendGuardStop(evidence);
  await s.close();

  const loaded = await loadSession(path);
  const guard = loaded.entries.find((e) => e.type === "guardStop");
  assert.ok(guard && guard.type === "guardStop", "the guardStop entry is in the file");
  assert.equal(guard.id, entryId);
  assert.ok(guard.timestamp > 0);
  assert.deepEqual(guard.evidence, evidence);
  // Replay: harness metadata, NOT LLM context — the context is exactly the
  // messages, as if the entry were not there.
  assert.deepEqual(
    replayContext(loaded.entries),
    replayContext(loaded.entries.filter((e) => e.type !== "guardStop")),
  );
  assert.ok(before.length > 0);
});

test("D33: a guardStop before a compaction boundary does not break the kept-entry chain", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-guard-cx-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "guard-cx.jsonl");

  const s = await Session.create(path, { model: MODEL });
  const m1 = await s.appendMessage(userMsg("one", 1));
  await s.appendGuardStop({
    guard: "permission-stall",
    tool: "bash",
    denials: 3,
    window: 8,
    errorExcerpt: "Operation not permitted",
  });
  const m2 = await s.appendMessage(userMsg("two", 2));
  await s.appendCompaction("SUMMARY: earlier work", m2, 1000);
  await s.close();

  const loaded = await loadSession(path);
  const ctx = replayContext(loaded.entries);
  // [summary-as-user-message] + m2 — the guardStop entry is skipped and the
  // compaction's firstKeptEntryId (m2) still resolves.
  assert.equal(ctx.length, 2);
  assert.equal(ctx[1]!.content, "two");
  assert.ok(m1.length > 0);
});

test("D33: a reader that predates guardStop skips it (additive entry, format version stays 1)", async () => {
  // The pre-D33 replay loop, verbatim in behavior: message + compaction
  // branches only, everything else falls through. A file WITH a guardStop
  // entry replays to the same context as without it.
  const dir = await mkdtemp(join(tmpdir(), "om-sess-guard-old-"));
  const path = join(dir, "old.jsonl");
  try {
    const s = await Session.create(path, { model: MODEL });
    await s.appendMessage(userMsg("keep", 1));
    await s.appendGuardStop({
      guard: "repeat-failure",
      tool: "t",
      repeats: 3,
      window: 8,
      errorExcerpt: "same error",
    });
    await s.close();

    const loaded = await loadSession(path);
    assert.equal(SESSION_FORMAT_VERSION, 1, "the format version was NOT bumped");
    const legacy = loaded.entries
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);
    assert.deepEqual(replayContext(loaded.entries), legacy);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─────────── P1: the progressNudge entry (docs/11 §14.6) ───────────

test("P1: appendProgressNudge round-trips through loadSession; replay ignores the entry", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-nudge-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "nudge.jsonl");

  const s = await Session.create(path, { model: MODEL });
  await s.appendMessage(userMsg("do the thing", 1));
  const entryId = await s.appendProgressNudge({
    kind: "no-success",
    mode: "watch",
    turn: 3,
    count: 3,
  });
  await s.appendProgressNudge({
    kind: "no-verification",
    mode: "nudge",
    turn: 7,
    count: 5,
    target: "src/app.ts",
    runId: "run_01JX_TEST",
  });
  await s.close();

  const loaded = await loadSession(path);
  const nudges = loaded.entries.filter((e) => e.type === "progressNudge");
  assert.equal(nudges.length, 2, "both nudge entries are in the file");
  const first = nudges[0];
  assert.ok(first && first.type === "progressNudge");
  assert.equal(first.id, entryId);
  assert.ok(first.timestamp > 0);
  assert.equal(first.kind, "no-success");
  assert.equal(first.mode, "watch");
  assert.equal(first.turn, 3);
  assert.equal(first.count, 3);
  assert.equal(first.target, undefined);
  const second = nudges[1];
  assert.ok(second && second.type === "progressNudge");
  assert.equal(second.kind, "no-verification");
  assert.equal(second.mode, "nudge");
  assert.equal(second.target, "src/app.ts");
  assert.equal(second.runId, "run_01JX_TEST");

  // Replay: harness metadata, NOT LLM context (same contract as guardStop).
  assert.deepEqual(
    replayContext(loaded.entries),
    replayContext(loaded.entries.filter((e) => e.type !== "progressNudge")),
  );
});

test("P3a: a steer's envelope persists on the message entry; replay keeps it model-invisible (docs/11 §14.2)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-steerenv-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "steerenv.jsonl");

  const s = await Session.create(path, { model: MODEL });
  const plain = userMsg("typed line", 1);
  const steered = userMsg("[telegram from alice] focus", 2);
  const plainId = await s.appendMessage(plain);
  const steeredId = await s.appendMessage(steered, { requestId: "req-9", source: "telegram" });
  await s.close();

  const loaded = await loadSession(path);
  const msgs = loaded.entries.filter((e) => e.type === "message");
  assert.equal(msgs.length, 2);
  const legacy = msgs.find((e) => e.id === plainId);
  const env = msgs.find((e) => e.id === steeredId);
  assert.ok(legacy && env);
  assert.equal(legacy.steering, undefined, "a plain append has no envelope (legacy shape stays valid)");
  assert.deepEqual(env.steering, { requestId: "req-9", source: "telegram" });

  // Model-invisibility: the replayed CONTEXT is built from .message only —
  // identical whether or not the envelope field exists on disk.
  assert.deepEqual(
    replayContext(loaded.entries),
    replayContext(loaded.entries.map((e) => (e.type === "message" ? { ...e, steering: undefined } : e))),
  );
});

test("P1: a reader that predates progressNudge skips it (additive entry, format version stays 1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-nudge-old-"));
  const path = join(dir, "old.jsonl");
  try {
    const s = await Session.create(path, { model: MODEL });
    await s.appendMessage(userMsg("keep", 1));
    await s.appendProgressNudge({ kind: "no-success", mode: "stop", turn: 6, count: 4 });
    await s.close();

    const loaded = await loadSession(path);
    assert.equal(SESSION_FORMAT_VERSION, 1, "the format version was NOT bumped");
    const legacy = loaded.entries
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);
    assert.deepEqual(replayContext(loaded.entries), legacy);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─────────────── P2: the runEnd entry (docs/11 §2/§13.4) ───────────────

test("P2: appendRunEnd round-trips through loadSession; replay ignores the entry", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-runend-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "runend.jsonl");

  const s = await Session.create(path, { model: MODEL });
  await s.appendMessage(userMsg("do the thing", 1));
  const entryId = await s.appendRunEnd("run_01JX_ABC", "stop");
  await s.close();

  const loaded = await loadSession(path);
  const end = loaded.entries.find((e) => e.type === "runEnd");
  assert.ok(end && end.type === "runEnd", "the runEnd entry is in the file");
  assert.equal(end.id, entryId);
  assert.ok(end.timestamp > 0);
  assert.equal(end.runId, "run_01JX_ABC");
  assert.equal(end.reason, "stop");
  // Replay: harness metadata, NOT LLM context.
  assert.deepEqual(
    replayContext(loaded.entries),
    replayContext(loaded.entries.filter((e) => e.type !== "runEnd")),
  );
});

test("P2: driverRunEndReason maps the loop reasons and rejects toolUse (absence = unknown)", async () => {
  const { driverRunEndReason } = await import("../src/session/session.js");
  for (const r of ["stop", "length", "error", "aborted", "budget", "loop", "stall", "progress"] as const)
    assert.equal(driverRunEndReason(r), r);
  assert.equal(driverRunEndReason("toolUse"), undefined, "toolUse never terminates a run → no record");
});

test("P2: a reader that predates runEnd skips it (additive entry, format version stays 1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-runend-old-"));
  const path = join(dir, "old.jsonl");
  try {
    const s = await Session.create(path, { model: MODEL });
    await s.appendMessage(userMsg("keep", 1));
    await s.appendRunEnd("r1", "aborted");
    await s.close();
    const loaded = await loadSession(path);
    assert.equal(SESSION_FORMAT_VERSION, 1, "the format version was NOT bumped");
    const legacy = loaded.entries
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);
    assert.deepEqual(replayContext(loaded.entries), legacy);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("P1: a progressNudge before a compaction boundary does not break the kept-entry chain", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-nudge-cx-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "nudge-cx.jsonl");

  const s = await Session.create(path, { model: MODEL });
  await s.appendMessage(userMsg("one", 1));
  await s.appendProgressNudge({ kind: "no-verification", mode: "watch", turn: 2, count: 3, target: "a.ts" });
  const m2 = await s.appendMessage(userMsg("two", 2));
  await s.appendCompaction("SUMMARY: earlier work", m2, 1000);
  await s.close();

  const loaded = await loadSession(path);
  const ctx = replayContext(loaded.entries);
  assert.equal(ctx.length, 2);
  assert.equal(ctx[1]!.content, "two");
});

// ── P3b audit F3: steer receipts sync before the append resolves (§13.1) ──

/** Instrument FileHandle#sync for one test body: returns the call log and
 *  the unhook. The prototype is taken from a real handle instance (the
 *  @types surface declares FileHandle only as an interface — no runtime
 *  export). The append hook accumulates what each handle appended, so a
 *  sync call records whether the receipt line was in the append stream at
 *  sync time (the sync-before-resolve proof: a receipt must be durable
 *  before the caller can ack it). */
async function hookSync(): Promise<{ calls: { syncAt: () => string }[]; unhook: () => void }> {
  const probeDir = await mkdtemp(join(tmpdir(), "om-sess-probe-"));
  const probe = await open(join(probeDir, "h"), "a");
  type Hookable = { sync(): Promise<void>; appendFile(data: string | Uint8Array): Promise<void> };
  const proto = Object.getPrototypeOf(probe) as Hookable;
  await probe.close();
  const calls: { syncAt: () => string }[] = [];
  const realSync = proto.sync;
  const realAppend = proto.appendFile;
  const state = { current: "" };
  proto.appendFile = function (this: Hookable, data: string | Uint8Array) {
    state.current += typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    return realAppend.call(this, data);
  };
  proto.sync = function (this: Hookable) {
    const snapshot = state.current;
    calls.push({ syncAt: () => snapshot });
    return realSync.call(this);
  };
  return { calls, unhook: () => { proto.sync = realSync; proto.appendFile = realAppend; } };
}

test("F3: a request-carrying steer receipt is fsynced BEFORE the append resolves (ack authority, §13.1)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-fsync-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "receipt.jsonl");
  const s = await Session.create(path);
  const hook = await hookSync();
  t.after(hook.unhook);
  const id = await s.appendMessage(userMsg("steer text", 1), { requestId: "req-7", source: "file" });
  assert.equal(hook.calls.length, 1, "the receipt append is synced exactly once");
  assert.ok(hook.calls[0]!.syncAt().includes('"requestId":"req-7"'),
    "the recorded line is in the append buffer at sync time (sync comes after the append)");
  // A plain message (process-death durability only) must NOT sync — the
  // hot path keeps its performance profile (§13.1 R3 scoping).
  const before = hook.calls.length;
  await s.appendMessage(userMsg("plain", 2));
  await s.appendMessage(userMsg("telegram steer", 3), { requestId: "", source: "telegram" });
  assert.equal(hook.calls.length, before, "plain and empty-requestId appends never sync");
  await s.close();
  const loaded = await loadSession(path);
  assert.equal(loaded.entries.length, 4); // header + 3
  assert.ok(id);
});

test("F3: a failed receipt sync REJECTS the append AND rolls the line back (the queue must never observe an un-synced receipt)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-fsync-fail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "receipt-fail.jsonl");
  const s = await Session.create(path);
  const sizeBefore = (await readFile(path)).length;
  const probe = await open(join(dir, "probe"), "a");
  const proto = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
  await probe.close();
  const real = proto.sync;
  proto.sync = () => Promise.reject(new Error("simulated EIO"));
  t.after(() => { proto.sync = real; });
  await assert.rejects(
    () => s.appendMessage(userMsg("steer text", 1), { requestId: "req-8", source: "file" }),
    /simulated EIO/,
    "the sync failure propagates instead of resolving an undurable receipt",
  );
  // Cycle-1 audit: the appended-but-un-synced line must NOT stay visible
  // (the file-queue reads the transcript with its own readFileSync — an
  // observed un-synced receipt would settle pendingInjected and advance
  // the persisted offset, breaking the ack authority). Rollback to the
  // pre-append size:
  const after = await readFile(path);
  assert.equal(after.length, sizeBefore, "the failed receipt line is truncated away (rollback)");
  const loaded = await loadSession(path);
  assert.ok(!loaded.entries.some((e) => e.type === "message" && e.message.content === "steer text"),
    "no entry with the rejected receipt id is loadable");
  // The handle is still usable for non-sync appends (the write path did not
  // wedge): plain appends keep working after a failed receipt.
  await s.appendMessage(userMsg("plain after failure", 2));
  await s.close();
  const loaded2 = await loadSession(path);
  assert.ok(loaded2.entries.some((e) => e.type === "message" && e.message.content === "plain after failure"),
    "the session keeps appending after a failed receipt");
});

test("F3: rollback recovers when the pre-append stat fails (cycle-2 Q1a: path re-stat + exact-line truncate)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "om-sess-fsync-statfail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "stat-fail.jsonl");
  const s = await Session.create(path);
  const sizeBefore = (await readFile(path)).length;
  const probe = await open(join(dir, "probe"), "a");
  const proto = Object.getPrototypeOf(probe) as { sync(): Promise<void>; stat(): Promise<{ size: number }> };
  await probe.close();
  const realSync = proto.sync;
  const realStat = proto.stat;
  proto.stat = () => Promise.reject(new Error("simulated stat EIO"));
  proto.sync = () => Promise.reject(new Error("simulated sync EIO"));
  t.after(() => { proto.sync = realSync; proto.stat = realStat; });
  await assert.rejects(
    () => s.appendMessage(userMsg("steer with broken pre-stat", 1), { requestId: "req-9", source: "file" }),
    /simulated sync EIO/,
  );
  // The fallback re-stats via the path and truncates exactly the receipt
  // line through the fresh handle — the file is back to its committed state:
  const after = await readFile(path);
  assert.equal(after.length, sizeBefore, "the path re-stat fallback rolled the receipt line back");
  proto.stat = realStat;
  proto.sync = realSync;
  await s.appendMessage(userMsg("plain after stat-fail", 2));
  await s.close();
  const loaded = await loadSession(path);
  assert.ok(!loaded.entries.some((e) => e.type === "message" && e.message.content === "steer with broken pre-stat"),
    "the rolled-back receipt never loads");
  assert.ok(loaded.entries.some((e) => e.type === "message" && e.message.content === "plain after stat-fail"),
    "the session (with the swapped-in fresh handle) keeps appending cleanly");
});
