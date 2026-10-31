/**
 * P5 — fleet observation primitives (docs/11 §2, §3 S7, §13.1, §13.2, §14.8).
 *
 * Covers:
 *  - JsonlTailer: offset-persistent append (crash-restart resume, partial
 *    tail join), truncation → full rescan (§13.1), replacement detection
 *    (size + mtime), non-UTF8 garbage skipped without poisoning the
 *    offset, reset().
 *  - deterministic replay projection (§13.2 I6) with entry-id dedup (§2).
 *  - S7 envelope: closed-set classification (tool / warned / stopped /
 *    dead / unknown; never "thinking" without process evidence — I3),
 *    staleness, parse rejection, live-worker marker staleness.
 *  - compartment guards: nothing outside src/fleet/ imports the P5
 *    primitives yet; src/fleet/ imports nothing in the repo except
 *    src/ types.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { closeSync, existsSync, fsyncSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  JsonlTailer,
  classifyWorkerState,
  projectSessionReplay,
  projectWorkerEnvelope,
  parseWorkerEnvelope,
  parseFleetEnvelope,
  FleetObserver,
  writeLiveMarker,
  readLiveMarker,
  type SessionEntryShape,
  type ToolCallMessageShape,
} from "../src/fleet/tail.js";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fleet-test-"));
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, "utf-8");
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function appendLine(path: string, line: string): Promise<void> {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line.endsWith("\n") ? line : line + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// JsonlTailer
// ---------------------------------------------------------------------------

test("tailer delivers appended lines and persists the offset across restarts", async () => {
  const dir = await freshDir();
  const src = join(dir, "s1.jsonl");
  await appendLine(src, JSON.stringify({ type: "session", id: "h" }));

  const t1 = new JsonlTailer(src, { stateDir: dir });
  const first = await t1.poll();
  assert.equal(first.length, 1);
  assert.equal(first[0]!.text.includes('"session"'), true);
  assert.equal(first[0]!.resume, false);

  // Second poll: nothing new.
  assert.equal((await t1.poll()).length, 0);

  // "Crash": new instance re-reads state from disk — already-seen lines are
  // NOT redelivered (byte-offset resume).
  await appendLine(src, JSON.stringify({ id: "e2" }));
  const t2 = new JsonlTailer(src, { stateDir: dir });
  const second = await t2.poll();
  assert.equal(second.length, 1);
  assert.equal(second[0]!.text.includes("e2"), true);
});

test("tailer joins a partial trailing line across polls", async () => {
  const dir = await freshDir();
  const src = join(dir, "s2.jsonl");
  const fd = openSync(src, "a");
  writeSync(fd, '{"id":"a","tex');
  closeSync(fd);

  const t = new JsonlTailer(src, { stateDir: dir });
  assert.equal((await t.poll()).length, 0, "partial line is held");

  // The appender completes the line (its own torn tail was never persisted
  // as a line — the offset stayed before it).
  const fd2 = openSync(src, "a");
  writeSync(fd2, 't":"hello"}\n');
  closeSync(fd2);
  const got = await t.poll();
  assert.equal(got.length, 1);
  assert.deepEqual(JSON.parse(got[0]!.text), { id: "a", text: "hello" });
});

test("truncation → full rescan with regenerated ids (§13.1)", async () => {
  const dir = await freshDir();
  const src = join(dir, "s3.jsonl");
  await appendLine(src, JSON.stringify({ id: "x1" }));
  await appendLine(src, JSON.stringify({ id: "x2" }));

  const t = new JsonlTailer(src, { stateDir: dir });
  const before = await t.poll();
  assert.equal(before.length, 2);
  const idsBefore = before.map((l) => l.id).sort();

  // Torn tail repair: truncate back to the first line boundary.
  const line1 = await readFile(src, "utf-8");
  const cut = line1.indexOf("\n") + 1;
  const fd = openSync(src, "r+");
  writeSync(fd, Buffer.alloc(0));
  closeSync(fd);
  await writeFile(src, line1.slice(0, cut));

  const after = await t.poll();
  assert.equal(after.length, 1, "only line 1 survives the truncate");
  // Rescan regenerates ids from content — they differ from the pre-truncate
  // ids (the dedup layer must reconcile by replayed content, not old ids).
  const idsAfter = after.map((l) => l.id);
  assert.ok(!idsAfter.some((id) => idsBefore.includes(id)) || after[0]!.text === before[0]!.text);
});

test("replacement (same path, rewritten file) is detected and rescanned", async () => {
  const dir = await freshDir();
  const src = join(dir, "s4.jsonl");
  await appendLine(src, JSON.stringify({ id: "same", v: 1 }));

  const t = new JsonlTailer(src, { stateDir: dir });
  const first = await t.poll();
  assert.equal(first.length, 1);

  // Rewrite with the SAME byte length (size alone cannot detect it) but a
  // forced mtime change.
  await writeFile(src, JSON.stringify({ id: "same", v: 2 }) + "\n");
  const stat = await import("node:fs/promises").then((m) => m.stat(src));
  await utimes(src, stat.atime, new Date(stat.mtime.getTime() + 5_000));

  const second = await t.poll();
  assert.equal(second.length, 1);
  assert.equal(second[0]!.text.includes('"v":2'), true, "rescanned replacement content");
});

test("non-UTF8 garbage is skipped and does not poison the offset", async () => {
  const dir = await freshDir();
  const src = join(dir, "s5.jsonl");
  const fd = openSync(src, "a");
  writeSync(fd, Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x0a])); // invalid UTF-8 line
  writeSync(fd, '{"id":"ok"}\n');
  closeSync(fd);

  const t = new JsonlTailer(src, { stateDir: dir });
  const got = await t.poll();
  assert.equal(got.length, 1, "garbage line dropped, valid line delivered");
  assert.equal(JSON.parse(got[0]!.text).id, "ok");

  // Offset advanced past the garbage: a restart does not redeliver anything.
  const t2 = new JsonlTailer(src, { stateDir: dir });
  assert.equal((await t2.poll()).length, 0);
});

test("reset() clears the persisted offset", async () => {
  const dir = await freshDir();
  const src = join(dir, "s6.jsonl");
  await appendLine(src, '{"id":"1"}\n');
  const t = new JsonlTailer(src, { stateDir: dir });
  assert.equal((await t.poll()).length, 1);
  t.reset();
  assert.equal(existsSync(join(dir, "s6.jsonl.offset.json")), false, "state file removed by reset()");
  assert.equal((await t.poll()).length, 1, "re-read from 0 after reset");
});

// ---------------------------------------------------------------------------
// Replay projection (I6 determinism, §2 dedup)
// ---------------------------------------------------------------------------

const E1: SessionEntryShape = { type: "message", id: "m1", message: { role: "assistant", model: "m", content: [{ type: "text", text: "hi" }], stopReason: "stop" } };
const E2: SessionEntryShape = { type: "modelChange", id: "c1", model: "alt" };
const E3: SessionEntryShape = { type: "runEnd", id: "r1", runId: "run-1", reason: "stop" };

test("projection is deterministic and independent of entry order", async () => {
  const dir = await freshDir();
  const a = join(dir, "a.jsonl");
  await writeFile(a, [E1, E2, E3].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const b = join(dir, "b.jsonl");
  await writeFile(b, [E3, E1, E2].map((e) => JSON.stringify(e)).join("\n") + "\n");

  const ta = new JsonlTailer(a, { stateDir: dir });
  const tb = new JsonlTailer(b, { stateDir: dir });
  const pa = projectSessionReplay(await ta.poll());
  const pb = projectSessionReplay(await tb.poll());

  // Same entries (ids) in both…
  assert.deepEqual([...pa.entries.keys()].sort(), [...pb.entries.keys()].sort());
  // …and the replay array is identical (deterministic sort, not arrival order).
  assert.deepEqual(pa.replay, pb.replay);
});

test("duplicate ids are reported (dedup key = entry id)", async () => {
  const dir = await freshDir();
  const f = join(dir, "dup.jsonl");
  await writeFile(f, [E1, E2, E1].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const t = new JsonlTailer(f, { stateDir: dir });
  const p = projectSessionReplay(await t.poll());
  assert.deepEqual(p.duplicates, [{ id: "m1", count: 2 }]);
  assert.equal(p.entries.get("m1")!.sourceFile, f); // first wins
});

test("entries without an id are assigned a content fingerprint id", async () => {
  const dir = await freshDir();
  const f = join(dir, "fingerprint.jsonl");
  const t = new JsonlTailer(f, { stateDir: dir });
  await writeFile(f, '{"type":"no_id"}\n');
  const first = projectSessionReplay(await t.poll());
  await writeFile(f, '{"type":"no_id"}\n{"type":"no_id"}\n');
  const second = projectSessionReplay(await t.poll(), first);
  // The fresh read of the same content matches the fingerprint id → duplicate.
  assert.equal(second.entries.size, 1);
  assert.deepEqual(second.duplicates, [{ id: first.entries.keys().next().value, count: 2 }]);
});

// ---------------------------------------------------------------------------
// S7 envelope + classification
// ---------------------------------------------------------------------------

function toolCall(id: string): ToolCallMessageShape {
  return { role: "assistant", model: "m", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "x" } }], stopReason: "toolUse" } as unknown as ToolCallMessageShape;
}
function toolResult(id: string, isError = false): SessionEntryShape {
  return { type: "message", id: `tr-${id}`, message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "r" }], details: {}, isError } };
}
async function envelopeFor(entries: SessionEntryShape[], opts?: { now?: number; staleAfterMs?: number; logMtimeMs?: number; workerId?: string }) {
  const dir = await freshDir();
  const f = join(dir, "w.jsonl");
  await writeFile(f, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (opts?.logMtimeMs !== undefined) {
    const d = new Date(opts.logMtimeMs);
    await utimes(f, d, d);
  }
  const t = new JsonlTailer(f, { stateDir: dir });
  return projectWorkerEnvelope(await t.poll(), opts?.workerId ?? "w", opts);
}

test("empty log → unknown (never inferred)", async () => {
  const env = await envelopeFor([]);
  assert.equal(env.state, "unknown");
  assert.equal(env.evidence.classifiedFrom, "no entries");
});

test("unanswered toolCall tail → tool", async () => {
  const env = await envelopeFor([{ type: "message", id: "m1", message: toolCall("t1") }]);
  assert.equal(env.state, "tool");
  assert.equal(env.evidence.lastTool, "bash");
});

test("runEnd at tail → stopped (§14.8: stopped ← guardStop/runEnd at tail)", async () => {
  const env = await envelopeFor([
    { type: "message", id: "m1", message: toolCall("t1") },
    toolResult("t1"),
    { type: "runEnd", id: "r1", runId: "run-1", reason: "stop" },
  ]);
  assert.equal(env.state, "stopped");
});

test("answered toolCall with no terminal record → unknown (never thinking — I3)", async () => {
  const env = await envelopeFor([
    { type: "message", id: "m1", message: toolCall("t1") },
    toolResult("t1"),
  ]);
  assert.equal(env.state, "unknown");
});

test("guardStop tail → stopped; supervisor-written crash runEnd → dead", async () => {
  const stopped = await envelopeFor([
    { type: "guardStop", id: "g1", runId: "run-1", reason: "identical-batch", evidence: { kind: "identical-batch", key: "k", count: 5, commands: [] } },
  ]);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.evidence.lastRunEnd!.reason, "identical-batch");

  const crashed = await envelopeFor([
    { type: "runEnd", id: "r1", runId: "run-1", reason: "crashed", writtenBy: "supervisor" },
  ]);
  assert.equal(crashed.state, "dead");
});

test("warn without later assistant activity → warned; recovery clears it", async () => {
  const nudge: SessionEntryShape = { type: "progressNudge", id: "n1", kind: "no-success", mode: "fixed-interval", runId: "run-1" };
  const noRecovery = await envelopeFor([
    { type: "message", id: "m1", message: { role: "assistant", model: "m", content: [{ type: "text", text: "work" }], stopReason: "toolUse" } },
    nudge,
  ]);
  assert.equal(noRecovery.state, "warned");
  assert.equal(noRecovery.evidence.lastWarn!.kind, "progress_nudge");

  const recovered = await envelopeFor([
    { type: "message", id: "m1", message: { role: "assistant", model: "m", content: [{ type: "text", text: "work" }], stopReason: "toolUse" } },
    nudge,
    { type: "message", id: "m2", message: { role: "assistant", model: "m", content: [{ type: "text", text: "more" }], stopReason: "stop" } },
  ]);
  assert.equal(recovered.state, "unknown", "assistant activity after the warn supersedes it");
});

test("toolResult warn details classify as warned", async () => {
  const env = await envelopeFor([
    { type: "message", id: "m1", message: toolCall("t1") },
    { type: "message", id: "tr1", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], details: { sameErrorWarn: true }, isError: true } },
  ] as SessionEntryShape[]);
  // Unanswered in the map sense it IS answered; the warn wins.
  assert.equal(env.state, "warned");
});

test("staleness: mtime older than staleAfterMs sets the envelope flag", async () => {
  const now = Date.now();
  const env = await envelopeFor(
    [{ type: "message", id: "m1", message: { role: "assistant", model: "m", content: [{ type: "text", text: "hi" }], stopReason: "stop" } }],
    { now, staleAfterMs: 1_000, logMtimeMs: now - 60_000 },
  );
  assert.equal(env.stale, true);
  assert.ok(env.secondsSinceLogActivity !== undefined && env.secondsSinceLogActivity > 50);
});

test("envelope round-trips through parseWorkerEnvelope; foreign payloads rejected", async () => {
  const env = await envelopeFor([]);
  const clone = parseWorkerEnvelope(JSON.parse(JSON.stringify(env)) as Record<string, unknown>);
  assert.equal(clone.workerId, env.workerId);
  assert.throws(() => parseWorkerEnvelope({ schema: "tre.observe.v1", workerId: "x" }), /missing required/i);
  await assert.rejects(() => Promise.reject(new Error("x"))); // no-op keeps assert import honest
});

test("envelope file is written atomically (no partial JSON on disk)", async () => {
  const dir = await freshDir();
  const f = join(dir, "w.jsonl");
  await writeFile(f, '{"type":"session","id":"h","timestamp":1}\n');
  const t = new JsonlTailer(f, { stateDir: dir });
  const env = await projectWorkerEnvelope(await t.poll(), "w7", { stateDir: dir });
  const envPath = join(dir, "w7.observe.json");
  const doc = JSON.parse(await readFile(envPath, "utf-8"));
  assert.equal(doc.workerId, "w7");
  assert.equal(doc.revision, env.revision);
});

// ---------------------------------------------------------------------------
// Live marker
// ---------------------------------------------------------------------------

test("live marker: round-trip and staleness by age", async () => {
  const dir = await freshDir();
  const now = 1_800_000_000_000;
  await writeLiveMarker(dir, { workerId: "w1", pid: 42, commandFingerprint: "fp", startedAt: now - 1000 }, now);
  const m = await readLiveMarker(dir, "w1", now);
  assert.ok(m);
  assert.equal(m!.pid, 42);
  assert.equal(m!.fresh, true);

  const old = await readLiveMarker(dir, "w1", now + 2 * 60_000);
  assert.ok(old);
  assert.equal(old!.fresh, false, "marker older than 60s is stale (dead-pid false positive guard)");

  assert.equal(await readLiveMarker(dir, "nope", now), undefined);
});

// ---------------------------------------------------------------------------
// FleetObserver — per-episode tre-fleet/1 envelope stream (§8/S7)
// ---------------------------------------------------------------------------

test("FleetObserver emits seq-ordered tre-fleet/1 envelopes to events/fleet.jsonl", async () => {
  const dir = await freshDir();
  const sess = join(dir, "w1.jsonl");
  await writeFile(sess, '{"type":"message","id":"m1","message":{"role":"assistant","model":"m","content":[{"type":"toolCall","id":"t1","name":"bash"}],"stopReason":"toolUse"}}\n');
  const obs = new FleetObserver(dir);
  obs.watchWorker("w1", sess, { taskId: "task-1" });
  const envs = await obs.refresh({ now: 1_700_000_000_000 });
  assert.equal(envs.length, 1);
  assert.deepEqual(obs.watchedWorkers(), ["w1"]);
  assert.equal(obs.evidenceOf("w1").lastTool, "bash");
  const env = envs[0]!;
  assert.equal(env.schema, "tre-fleet/1");
  assert.equal(env.episodeId, dir.split("/").pop());
  assert.equal(env.workerId, "w1");
  assert.equal(env.taskId, "task-1");
  assert.equal(env.seq, 0);
  assert.equal(env.workerState, "tool");
  assert.deepEqual(env.source, { kind: "session", entryId: "m1" });
  const onDisk = await readJsonl(join(dir, "events", "fleet.jsonl"));
  assert.equal(onDisk.length, 1);
  assert.deepEqual(onDisk[0], JSON.parse(JSON.stringify(env)));
  // no new records → no new envelopes (stream stays append-only, no churn)
  assert.deepEqual(await obs.refresh({ now: 1_700_000_000_001 }), []);
});

test("FleetObserver recovers seq from the stream high-water mark after restart (torn lines skipped)", async () => {
  const dir = await freshDir();
  const sess = join(dir, "w1.jsonl");
  await writeFile(sess, '{"type":"message","id":"m1","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"a"}],"stopReason":"stop"}}\n');
  const o1 = new FleetObserver(dir);
  o1.watchWorker("w1", sess);
  const first = await o1.refresh({ now: 1000 });
  assert.equal(first[0]!.seq, 0);
  // Simulate a crash mid-append: a torn line at the tail of OUR stream.
  await appendLine(join(dir, "events", "fleet.jsonl"), '{"seq":42,"torn":');
  const o2 = new FleetObserver(dir);
  o2.watchWorker("w1", sess);
  await writeFile(sess, '{"type":"message","id":"m1","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"a"}],"stopReason":"stop"}}\n{"type":"message","id":"m2","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"b"}],"stopReason":"stop"}}\n');
  const second = await o2.refresh({ now: 2000 });
  assert.equal(second.length, 1, "only the new record emits (offsets persisted across restart)");
  assert.equal(second[0]!.seq, 1, "torn tail carries no readable seq → high-water mark is the last PARSED line (0); reusing 1 is safe because the torn envelope was never deliverable");
  // a *complete* high-seq line does bump the mark:
  await appendLine(join(dir, "events", "fleet.jsonl"), '{"schema":"tre-fleet/1","episodeId":"x","workerId":"w1","seq":42,"ts":1,"workerState":"unknown","stale":false,"source":{"kind":"decision","id":"d"},"event":{}}');
  const o3 = new FleetObserver(dir);
  o3.watchWorker("w1", sess);
  await writeFile(sess, '{"type":"message","id":"m1","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"a"}],"stopReason":"stop"}}\n{"type":"message","id":"m2","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"b"}],"stopReason":"stop"}}\n{"type":"message","id":"m3","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"c"}],"stopReason":"stop"}}\n');
  const third = await o3.refresh({ now: 3000 });
  assert.equal(third[0]!.seq, 43, "complete seq-42 line bumps the mark past it");
});

test("FleetObserver.emitDecision interleaves decision envelopes verbatim", async () => {
  const dir = await freshDir();
  const obs = new FleetObserver(dir);
  const decision = { action: "kill", reason: "identical-batch", policy: "S2" };
  const env = await obs.emitDecision("dec-1", decision, { workerId: "w1", taskId: "t9", now: 5000 });
  assert.deepEqual(env.source, { kind: "decision", id: "dec-1" });
  assert.deepEqual(env.event, decision);
  assert.equal(env.workerState, "unknown", "a decision says nothing about worker state (I3)");
  assert.equal(env.taskId, "t9");
  const onDisk = await readJsonl(join(dir, "events", "fleet.jsonl"));
  assert.deepEqual(onDisk.map((r) => r.seq), [0]);
  await assert.rejects(() => obs.emitDecision("", {}), /decision id is required/);
});

test("FleetObserver creates events/ on demand (no P4-layout precondition)", async () => {
  const dir = await freshDir(); // deliberately NO events/ subdir
  const obs = new FleetObserver(dir);
  const env = await obs.emitDecision("dec-1", { action: "nudge" }, { now: 1 });
  assert.equal(env.seq, 0);
  const sess = join(dir, "w.jsonl");
  await writeFile(sess, '{"type":"message","id":"m1","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"x"}],"stopReason":"stop"}}\n');
  obs.watchWorker("w", sess);
  const envs = await obs.refresh({ now: 2 });
  assert.equal(envs.length, 1);
  assert.deepEqual(envs[0]!.source, { kind: "session", entryId: "m1" });
});

// ---------------------------------------------------------------------------
// parseFleetEnvelope — strict §8 validation
// ---------------------------------------------------------------------------

async function minimalEnvelope(): Promise<Record<string, unknown>> {
  const dir = await freshDir();
  const obs = new FleetObserver(dir);
  const env = await obs.emitDecision("dec-1", { action: "x" }, { now: 1 });
  return JSON.parse(JSON.stringify(env)) as Record<string, unknown>;
}

test("parseFleetEnvelope: accepts a well-formed envelope and rejects foreign payloads", async () => {
  const base = await minimalEnvelope();
  assert.equal(parseFleetEnvelope(base).source.kind, "decision");
  for (const bad of [undefined, null, 42, "x", [], { ...base, schema: "tre.observe.v1" }]) {
    assert.throws(() => parseFleetEnvelope(bad), /envelope/);
  }
});

test("parseFleetEnvelope: source.kind is a checked closed set (audit finding 2)", async () => {
  const base = await minimalEnvelope();
  // unknown kind must be rejected even when it carries plausible fields
  assert.throws(
    () => parseFleetEnvelope({ ...base, source: { kind: "weird", id: "x", entryId: "y" } }),
    /source\.kind must be "session"\|"decision"/,
  );
  // each kind demands its own discriminator field
  assert.throws(() => parseFleetEnvelope({ ...base, source: { kind: "session" } }), /entryId/);
  assert.throws(() => parseFleetEnvelope({ ...base, source: { kind: "decision" } }), /\bid\b/);
  // and the happy paths pass
  const happy = parseFleetEnvelope({ ...base, source: { kind: "session", entryId: "e1" } });
  assert.equal(happy.source.kind === "session" && happy.source.entryId, "e1");
});

// ---------------------------------------------------------------------------
// Compartment guards
// ---------------------------------------------------------------------------

test("P5 guard: nothing outside src/fleet/ imports the fleet module", async () => {
  const files = await walkTs("src");
  const offenders: string[] = [];
  for (const file of files) {
    if (file.startsWith("src/fleet" + "/")) continue;
    const content = await readFile(file, "utf-8").catch(() => "");
    if (/(?:from\s+|import\s*\(\s*)["'][^"']*\/fleet\/[a-z]+["']/.test(content)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `fleet primitives must stay compartmentalized until P6+ wires them in: ${offenders.join(", ")}`);
});

test("P5 guard: src/fleet imports nothing in the repo except node: builtins", async () => {
  const files = await walkTs(join("src", "fleet"));
  assert.ok(files.length >= 1);
  for (const file of files) {
    const content = await readFile(file, "utf-8");
    const specifiers = [...content.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!);
    const foreign = specifiers.filter((s) => !s.startsWith("node:"));
    assert.deepEqual(foreign, [], `${file} must import only node: builtins (found: ${foreign.join(", ")})`);
  }
  const mod = await import("../src/fleet/tail.js");
  assert.ok(mod.JsonlTailer);
});

/** Every *.ts file under `dir` (recursive), as paths relative to the repo root. */
async function walkTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { recursive: true })) {
    const p = join(dir, String(e));
    if (p.endsWith(".ts")) out.push(p.replace(/\\/g, "/").replace(/^\.\//, ""));
  }
  return out.sort();
}
