/**
 * P3b — file-backed steering delivery (docs/11 §3/S2, §14.2, §13.1, §13.3).
 *
 * Covers:
 *  - drain delivery + pushed-before-file ordering, file created absent (§3).
 *  - §14.2 validation table: malformed lines skipped + counted (missing id,
 *    missing text, unknown priority, non-object), never fatal.
 *  - scope gate: managed mode (attemptId) skips mismatches (counted, warn
 *    once, never injected, never acked); unmanaged mode ignores attemptId.
 *  - transcript dedup (I4): recorded id + same text → acked no-op; same id
 *    + different text → conflictRejected with a stderr warning (not
 *    injected, not acked); startup scan picks up pre-existing envelopes.
 *  - §13.3 rows 1/2 (crash eligibility): a delivered-but-unrecorded steer
 *    holds the PERSISTED offset back (kill the process before the persist
 *    → restart redelivers); a recorded steer advances the offset (crash
 *    after persist → restart re-reads and dedups to a no-op, no duplicate
 *    transcript insertion).
 *  - torn trailing line: held, never delivered, joined on the next append;
 *    never repaired (§13.1 — repair belongs to the exclusive writer).
 *  - truncation (size < offset): reconcile to 0 + full rescan; re-delivered
 *    lines settle through dedup (row 2), never re-injected.
 *  - offset state: tmp+fsync+rename persistence, corrupt state = no state.
 *  - compartment guards (P5 pattern): nothing outside src/cli/ + src/steer/
 *    imports the module yet; src/steer imports nothing in the repo except
 *    node: builtins and type-only repo imports (erased at runtime).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, truncate, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSteeringQueue, type SteerRequest } from "../src/steer/file-queue.js";
import type { SteerEntry } from "../src/types.js";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "steer-file-"));
}

async function makeHarness(opts?: { attemptId?: string; sessionLine?: string }) {
  const dir = await freshDir();
  const steerPath = join(dir, "steer.jsonl");
  const sessionPath = join(dir, "session.jsonl");
  if (opts?.sessionLine !== undefined) {
    await writeFile(sessionPath, opts.sessionLine + "\n");
  }
  const warnings: string[] = [];
  const q = new FileSteeringQueue({
    path: steerPath,
    sessionPath,
    attemptId: opts?.attemptId,
    warn: (m) => warnings.push(m),
  });
  return { dir, steerPath, sessionPath, q, warnings };
}

/** Append one steer request line (framing the JSON with a newline). */
function appendSteer(steerPath: string, req: Partial<SteerRequest> & { id?: string; text?: string }): void {
  appendFileSync(steerPath, JSON.stringify(req) + "\n");
}

/** Append a raw line (already framed, or garbage). */
function appendRaw(steerPath: string, line: string): void {
  appendFileSync(steerPath, line.endsWith("\n") ? line : line + "\n");
}

/** Persist a steering envelope into the session file like the CLI's tap does. */
function recordSteer(sessionPath: string, requestId: string, text: string, source = "file"): void {
  const entry = {
    type: "message",
    id: `e-${requestId}`,
    message: { role: "user", content: text, timestamp: Date.now() },
    steering: { requestId, source },
  };
  appendFileSync(sessionPath, JSON.stringify(entry) + "\n");
}

function readState(steerPath: string): { offset: number } {
  return JSON.parse(readFileSync(`${steerPath}.offset.json`, "utf-8")) as { offset: number };
}

// ---------------------------------------------------------------------------
// Delivery & ordering
// ---------------------------------------------------------------------------

test("file created at startup if absent (§3); empty drain is empty", async () => {
  const { steerPath, q } = await makeHarness();
  assert.ok(existsSync(steerPath), "harness must create the steer file empty");
  assert.deepEqual(q.drain(), []);
  q.close();
});

test("appended lines drain as SteerEntry with envelope provenance; pushed items first", async () => {
  const { dir, steerPath, sessionPath, q } = await makeHarness();
  q.push("tty guidance");
  appendSteer(steerPath, { id: "s1", text: "use table joins", source: "orchestrator" });
  appendSteer(steerPath, { id: "s2", text: "no new deps" });
  const got = q.drain();
  assert.deepEqual(got, [
    "tty guidance",
    { text: "use table joins", requestId: "s1", source: "orchestrator" },
    { text: "no new deps", requestId: "s2", source: "file" },
  ] satisfies (string | SteerEntry)[]);
  // consumed: a second drain with no new appends yields nothing
  assert.deepEqual(q.drain(), []);
  void dir;
  void sessionPath;
  q.close();
});

test("torn trailing line is held (never delivered, never repaired), joined on next append", async () => {
  const { steerPath, q } = await makeHarness();
  appendFileSync(steerPath, '{"id":"t1","tex'); // torn: no newline yet
  assert.deepEqual(q.drain(), [], "a partial line must never be delivered");
  assert.ok(readFileSync(steerPath, "utf-8").includes('"tex'), "the reader never repairs/writes the file");
  appendFileSync(steerPath, 't":"fixed"}\n'); // completes the line
  const got = q.drain();
  assert.equal(got.length, 1);
  assert.equal((got[0] as SteerEntry).requestId, "t1");
  assert.equal((got[0] as SteerEntry).text, "fixed");
  q.close();
});

test("mixed batch (complete line + torn tail in ONE scan): tail joins exactly once, persisted offset is the partial's line start (audit F1)", async () => {
  // The two scan branches must share ONE consumed-offset convention: the
  // held bytes sit immediately BEFORE `offset`. Setting `offset` to just
  // past the last delivered line instead (the first cut) made the NEXT
  // scan re-read the held bytes and prepend them to the completed line —
  // the reframed line fails to parse, and the steer is silently lost
  // (counted malformed, never delivered). This test fails on the old code:
  // s2 comes back as a malformed line, not a delivery.
  const { dir, steerPath, sessionPath, q } = await makeHarness();
  appendFileSync(steerPath, JSON.stringify({ id: "m1", text: "first" }) + "\n" + '{"id":"m2","tex'); // complete line + torn tail, one write
  const got1 = q.drain();
  assert.deepEqual(got1.map((e) => (e as SteerEntry).requestId), ["m1"], "the complete line delivers, the tail is held");
  const got2pre = q.drain();
  assert.deepEqual(got2pre, [], "still held until the line completes");
  // Cycle-1 audit (clamp isolation): record the delivered line so
  // pendingInjected is EMPTY, forcing saveState's clamp to do the real
  // work: persisted offset must be the PARTIAL's line start (past line
  // m1), never buf.length — an implementation that drops the `- heldLen`
  // subtraction loses the torn bytes on restart.
  recordSteer(sessionPath, "m1", "first");
  q.drain();
  const midState = readState(steerPath);
  const line1Bytes = Buffer.byteLength(JSON.stringify({ id: "m1", text: "first" }) + "\n", "utf8");
  assert.equal(midState.offset, line1Bytes, "clamp holds the persisted offset at the torn line start (empty pendingInjected)");
  appendRaw(steerPath, 't":"joined"}\n'); // finish the torn line
  const got2 = q.drain();
  assert.equal(got2.length, 1, "the completed line delivers exactly once (no duplicated fragment, no malformed skip)");
  assert.equal((got2[0] as SteerEntry).requestId, "m2");
  assert.equal((got2[0] as SteerEntry).text, "joined");
  // The unified invariant also fixes the PERSISTED offset: saveState's
  // clamp (offset − heldLen) lands on the partial's line start, never
  // INSIDE the last delivered line.
  recordSteer(sessionPath, "m1", "first");
  recordSteer(sessionPath, "m2", "joined");
  q.drain();
  const state = readState(steerPath);
  const lineBytes =
    Buffer.byteLength(JSON.stringify({ id: "m1", text: "first" }) + "\n", "utf8") +
    Buffer.byteLength(JSON.stringify({ id: "m2", text: "joined" }) + "\n", "utf8");
  assert.equal(state.offset, lineBytes, "once settled, the offset sits at EOF — past both delivered lines");
  q.close();
});

// ---------------------------------------------------------------------------
// §14.2 validation table
// ---------------------------------------------------------------------------

test("malformed lines: skipped + counted, never fatal, valid lines still drain", async () => {
  const { steerPath, q, warnings } = await makeHarness();
  appendRaw(steerPath, "not json at all");
  appendRaw(steerPath, "[1,2,3]"); // non-object
  appendSteer(steerPath, { text: "no id" });
  appendSteer(steerPath, { id: "np", text: "bad prio", priority: "follow-up" });
  appendSteer(steerPath, { id: "ok", text: "valid" });
  const got = q.drain();
  assert.equal(got.length, 1);
  assert.equal((got[0] as SteerEntry).requestId, "ok");
  const st = q.getStats();
  assert.equal(st.malformed, 4);
  assert.equal(st.injected, 1);
  assert.equal(st.linesRead, 5);
  assert.ok(warnings.length >= 1, "malformed lines must warn (docs/11 §3: skipped count logged)");
  q.close();
});

// ---------------------------------------------------------------------------
// Scope gate (§14.2)
// ---------------------------------------------------------------------------

test("managed mode: attemptId mismatch skipped + counted, never injected, never acked", async () => {
  const { steerPath, q, warnings } = await makeHarness({ attemptId: "t2-a1" });
  appendSteer(steerPath, { id: "mine", attemptId: "t2-a1", text: "in scope" });
  appendSteer(steerPath, { id: "stale", attemptId: "t1-a9", text: "stale guidance" });
  appendSteer(steerPath, { id: "missing", text: "no attemptId" }); // managed mode requires it
  const got = q.drain();
  assert.deepEqual(got.map((e) => (e as SteerEntry).requestId), ["mine"]);
  const st = q.getStats();
  assert.equal(st.scopeMismatch, 2);
  assert.equal(st.injected, 1);
  assert.equal(warnings.filter((w) => w.includes("scope_mismatch")).length, 2);
  q.close();
});

test("unmanaged mode (no attemptId): attemptId on lines is ignored (§14.2 check off)", async () => {
  const { steerPath, q } = await makeHarness();
  appendSteer(steerPath, { id: "any", attemptId: "whatever", text: "delivered anyway" });
  const got = q.drain();
  assert.equal(got.length, 1);
  assert.equal(q.getStats().scopeMismatch, 0);
  q.close();
});

// ---------------------------------------------------------------------------
// Transcript dedup (I4) + conflict rejection
// ---------------------------------------------------------------------------

test("startup scan: ids recorded before this process are acked no-ops, same text", async () => {
  const line = JSON.stringify({
    type: "message",
    id: "e0",
    message: { role: "user", content: "already in", timestamp: 1 },
    steering: { requestId: "old-1", source: "file" },
  });
  const { steerPath, q } = await makeHarness({ sessionLine: line });
  appendSteer(steerPath, { id: "old-1", text: "already in" });
  appendSteer(steerPath, { id: "new-1", text: "fresh" });
  const got = q.drain();
  assert.deepEqual(got.map((e) => (e as SteerEntry).requestId), ["new-1"]);
  assert.equal(q.getStats().dedupAcked, 1);
  q.close();
});

test("same id + different text → conflictRejected: not injected, warned, counted", async () => {
  const { steerPath, q, warnings, sessionPath } = await makeHarness();
  appendSteer(steerPath, { id: "x", text: "original" });
  assert.equal(q.drain().length, 1);
  recordSteer(sessionPath, "x", "original"); // the persist lands
  appendSteer(steerPath, { id: "x", text: "DIFFERENT text" }); // supervisor retry, mutated
  const before = q.getStats().injected;
  assert.deepEqual(q.drain(), [], "a conflict must never be injected");
  assert.equal(q.getStats().injected, before, "a conflict is not an injection");
  assert.equal(q.getStats().conflictRejected, 1);
  assert.ok(warnings.some((w) => w.includes("REJECTED") && w.includes("x")));
  q.close();
});

test("same id + same text re-delivery after the record → dedupAcked no-op", async () => {
  const { steerPath, q, sessionPath } = await makeHarness();
  appendSteer(steerPath, { id: "y", text: "once" });
  q.drain();
  recordSteer(sessionPath, "y", "once");
  appendSteer(steerPath, { id: "y", text: "once" }); // supervisor retry
  assert.deepEqual(q.drain(), []);
  assert.equal(q.getStats().dedupAcked, 1);
  q.close();
});

// ---------------------------------------------------------------------------
// §13.3 rows 1/2 — crash eligibility via the persisted offset
// ---------------------------------------------------------------------------

test("row 1: delivered but NOT recorded → persisted offset held back; restart redelivers", async () => {
  const { dir, q, steerPath } = await makeHarness();
  appendSteer(steerPath, { id: "crash1", text: "lost with the process" });
  assert.equal(q.drain().length, 1); // handed off…
  q.close(); // …but never recorded in the session
  const state = readState(steerPath);
  assert.equal(state.offset, 0, "unrecorded line must NOT advance the persisted offset");
  // Simulate the crash-restart: fresh queue over the same files, unrecorded.
  const q2 = new FileSteeringQueue({
    path: steerPath,
    sessionPath: join(dir, "session.jsonl"),
    warn: () => {},
  });
  const got = q2.drain();
  assert.deepEqual(got.map((e) => (e as SteerEntry).requestId), ["crash1"], "eligible again after restart");
  q2.close();
});

test("row 2: recorded → offset advances; restart re-read re-delivery dedups to a no-op", async () => {
  const { steerPath, sessionPath, q } = await makeHarness();
  appendSteer(steerPath, { id: "rec1", text: "made it" });
  q.drain();
  recordSteer(sessionPath, "rec1", "made it");
  q.drain(); // settle + persist the advanced offset
  q.close();
  const state = readState(steerPath);
  assert.ok(state.offset > 0, "recorded line advances the persisted offset");
  const q2 = new FileSteeringQueue({ path: steerPath, sessionPath, warn: () => {} });
  assert.deepEqual(q2.drain(), [], "resume from the advanced offset sees no new bytes");
  assert.equal(q2.getStats().injected, 0, "no duplicate transcript insertion after restart");
  q2.close();
});

// ---------------------------------------------------------------------------
// Truncation (§13.1 reader reconciliation)
// ---------------------------------------------------------------------------

test("truncation under the reader: cursor reconciles to 0 and the rescan re-delivers", async () => {
  const { steerPath, q } = await makeHarness();
  appendSteer(steerPath, { id: "a1", text: "first" });
  q.drain();
  // The file is (violently) rewritten smaller — the append-only contract
  // broken under the reader. The reader must NOT poison its cursor.
  const replacement = JSON.stringify({ id: "b1", text: "rewritten" }) + "\n";
  await truncate(steerPath, 0);
  await writeFile(steerPath, replacement);
  const got = q.drain();
  assert.deepEqual(got.map((e) => (e as SteerEntry).requestId), ["b1"], "full rescan from 0 after shrink");
  q.close();
});

// ---------------------------------------------------------------------------
// Offset-state persistence
// ---------------------------------------------------------------------------

test("torn partial across close+restart: persisted offset never past the partial; line survives", async () => {
  // The held partial's bytes sit BEFORE the scanned offset; persisting
  // that offset would skip the partial's bytes in the file on restart
  // (lost steer, or a malformed reframe of the next line). saveState must
  // clamp back over the partial.
  const { dir, steerPath, sessionPath, q } = await makeHarness();
  appendSteer(steerPath, { id: "s1", text: "settled" });
  q.drain();
  recordSteer(sessionPath, "s1", "settled");
  q.drain(); // settle + advance the offset past line 1
  appendFileSync(steerPath, '{"id":"s2","tex'); // torn partial, consumed into the cursor
  assert.deepEqual(q.drain(), [], "the partial is held, never delivered");
  const state = readState(steerPath);
  const line1Bytes = Buffer.byteLength(JSON.stringify({ id: "s1", text: "settled" }) + "\n", "utf8");
  assert.equal(state.offset, line1Bytes, "persisted offset clamps back to the partial's line start");
  q.close();
  // Restart: fresh queue, then the supervisor finishes the line.
  const q2 = new FileSteeringQueue({ path: steerPath, sessionPath, warn: () => {} });
  appendFileSync(steerPath, 't":"survived"}\n');
  const got = q2.drain();
  assert.equal(got.length, 1, "the partial's line survives the restart exactly once");
  assert.equal((got[0] as SteerEntry).requestId, "s2");
  assert.equal((got[0] as SteerEntry).text, "survived");
  q2.close();
});

test("head fingerprint persists: same-size in-place replacement across restart is caught", async () => {
  // A replacement that leaves the file the SAME size passes a size-only
  // check; only the persisted head fingerprint catches it. Without
  // persistence the restart resumes at offset == size and never sees the
  // new (unrecorded) line — the steer would be lost.
  const { steerPath, sessionPath, q } = await makeHarness();
  appendSteer(steerPath, { id: "h1", text: "aaaa" });
  q.drain();
  recordSteer(sessionPath, "h1", "aaaa");
  q.drain();
  q.close();
  const state = readState(steerPath);
  assert.ok((state as { headB64?: string }).headB64, "close persists the head fingerprint");
  const replacement = JSON.stringify({ id: "h2", text: "bbbb" }) + "\n"; // same byte length as line 1
  assert.equal(Buffer.byteLength(replacement, "utf8"), state.offset, "test premise: replacement is size-identical");
  await writeFile(steerPath, replacement);
  const q2 = new FileSteeringQueue({ path: steerPath, sessionPath, warn: () => {} });
  const got = q2.drain();
  assert.deepEqual(got.map((e) => (e as SteerEntry).requestId), ["h2"], "head mismatch at the persisted size forces a rescan");
  q2.close();
});

test("offset state: tmp+rename durability, corrupt state = no state (full rescan, deduped)", async () => {
  const { steerPath, sessionPath, q } = await makeHarness();
  appendSteer(steerPath, { id: "p1", text: "persist me" });
  q.drain();
  recordSteer(sessionPath, "p1", "persist me");
  q.drain();
  const statePath = `${steerPath}.offset.json`;
  assert.ok(existsSync(statePath));
  assert.equal(readFileSync(statePath, "utf-8").indexOf("{"), 0, "the state file is valid JSON from byte 0");
  // Corrupt the state: a fresh queue treats it as NO state and rescans —
  // the recorded line dedups, the file has no other new lines.
  await writeFile(statePath, "{ not json");
  const q2 = new FileSteeringQueue({ path: steerPath, sessionPath, warn: () => {} });
  assert.deepEqual(q2.drain(), []);
  assert.equal(q2.getStats().injected, 0);
  q.close();
  q2.close();
});

test("close() is idempotent and drains nothing after", async () => {
  const { steerPath, q } = await makeHarness();
  q.close();
  q.close();
  appendSteer(steerPath, { id: "post", text: "after close" });
  assert.deepEqual(q.drain(), []);
});

// ---------------------------------------------------------------------------
// Compartment guards (P5 pattern)
// ---------------------------------------------------------------------------

test("P3b guard: nothing outside src/cli/ imports the steer-file module", async () => {
  const files = await walkTs("src");
  const offenders: string[] = [];
  for (const file of files) {
    if (file.startsWith("src/steer" + "/") || file.startsWith("src/cli" + "/")) continue;
    const content = await readFile(file, "utf-8").catch(() => "");
    if (/(?:from\s+|import\s*\(\s*)["'][^"']*\/steer\/file-queue["']/.test(content)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `the steer-file module stays compartmentalized until P9 wires the supervisor: ${offenders.join(", ")}`);
});

test("P3b guard: src/steer imports nothing in the repo except node: builtins and type-only repo types", async () => {
  const files = await walkTs(join("src", "steer"));
  assert.ok(files.length >= 1);
  for (const file of files) {
    const content = await readFile(file, "utf-8");
    for (const line of content.split("\n")) {
      // Value imports only: `import type` is erased at runtime (checked
      // separately below for the allowed pure-type surface).
      const m = /(?:^|\s)(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+["']([^"']+)["']/.exec(line);
      if (m === null) continue;
      const spec = m[1]!;
      if (spec.startsWith("node:")) continue;
      // The ONLY repo-relative imports allowed: value import of nothing —
      // src/steer is a leaf compartment. (Type-only imports are erased at
      // runtime and do not appear here because `import type` is excluded by
      // the regex's negative lookahead on the first `type` token.)
      assert.fail(`${file} must import only node: builtins at runtime (found: ${spec})`);
    }
    // Type-only imports are checked too: they must stay inside the repo's
    // pure type surface (../types.js, ../loop/agent-loop.js).
    const typeSpecs = [...content.matchAll(/^\s*import\s+type\s+[^;]*from\s+["']([^"']+)["']/gm)].map((x) => x[1]!);
    for (const spec of typeSpecs) {
      assert.ok(
        spec.startsWith("node:") || spec === "../types.js" || spec === "../loop/agent-loop.js",
        `${file}: unexpected type-only import ${spec}`,
      );
    }
  }
  const mod = await import("../src/steer/file-queue.js");
  assert.ok(mod.FileSteeringQueue);
});

/** Every *.ts file under `dir` (recursive), paths relative to the repo root. */
async function walkTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { recursive: true })) {
    const p = join(dir, String(e));
    if (p.endsWith(".ts")) out.push(p.replace(/\\/g, "/").replace(/^\.\//, ""));
  }
  return out.sort();
}