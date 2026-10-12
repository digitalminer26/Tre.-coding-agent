/**
 * The `subtask` tool (src/tools/subtask.ts): create/list/mark round-trips
 * against an injectable home dir, I3 (failures are isError results, never
 * throws), the `details.subtasks` payload the TUI reads, atomic persistence,
 * and the pure helpers (normalizeSubtaskFile, formatSubtaskSummary).
 */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireSubtaskLock,
  createSubtaskTool,
  formatSubtaskSummary,
  normalizeSubtaskFile,
  readSubtaskState,
  readSubtasks,
  releaseSubtaskLock,
  subtaskDir,
  subtaskFilePath,
  subtaskKey,
  subtaskLockPath,
  writeSubtasks,
} from "../src/tools/subtask.js";
import type { SubtaskInfo } from "../src/types.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "subtask-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const sig = new AbortController().signal;
const SESSION_ID = "tre-20260101-000000-1.jsonl";
const KEY = subtaskKey(SESSION_ID);
const tool = (sessionId = SESSION_ID) => createSubtaskTool(sessionId, home);
const text = (r: { content: { type: string; text: string }[] }): string => r.content.map((c) => c.text).join("");

test("subtask: create replaces the list, ids are 1-based, all queued", async () => {
  const t = tool();
  const r = await t.execute("1", { action: "create", items: ["wire state", "add tests", "verify"] }, sig);
  assert.equal(r.isError, undefined);
  const details = r.details as { subtasks: SubtaskInfo[] } | undefined;
  assert.ok(details !== undefined, "details.subtasks is present (the TUI reads it)");
  assert.deepEqual(details!.subtasks, [
    { id: 1, name: "wire state", status: "queued" },
    { id: 2, name: "add tests", status: "queued" },
    { id: 3, name: "verify", status: "queued" },
  ]);
  assert.match(text(r), /progress: 0\/3/);
  // persisted (the file survives the process — the next run's `list` sees it)
  const file = subtaskFilePath(subtaskDir(home), KEY);
  assert.ok(existsSync(file), "list file exists");
  assert.ok(JSON.parse(readFileSync(file, "utf8")).items.length === 3);
});

test("subtask: create is idempotent-replace (a second create resets the list)", async () => {
  const t = tool();
  await t.execute("1", { action: "create", items: ["a", "b", "c"] }, sig);
  const r = await t.execute("2", { action: "create", items: ["x"] }, sig);
  const details = r.details as { subtasks: SubtaskInfo[] };
  assert.deepEqual(details.subtasks, [{ id: 1, name: "x", status: "queued" }]);
});

test("subtask: list returns the persisted list without mutation", async () => {
  const t = tool();
  await t.execute("1", { action: "create", items: ["a", "b"] }, sig);
  const r = await t.execute("2", { action: "list" }, sig);
  assert.equal(r.isError, undefined);
  const details = r.details as { subtasks: SubtaskInfo[] };
  assert.equal(details.subtasks.length, 2);
  assert.match(text(r), /1\. a \(queued\)/);
  assert.match(text(r), /progress: 0\/2/);
});

test("subtask: list on an empty session reports (no subtasks), details empty", async () => {
  const r = await tool().execute("1", { action: "list" }, sig);
  assert.equal(r.isError, undefined);
  assert.match(text(r), /\(no subtasks\)/);
  assert.deepEqual((r.details as { subtasks: SubtaskInfo[] }).subtasks, []);
});

test("subtask: mark updates one item and returns the full list", async () => {
  const t = tool();
  await t.execute("1", { action: "create", items: ["a", "b", "c"] }, sig);
  const r = await t.execute("2", { action: "mark", id: 2, status: "in-progress" }, sig);
  assert.equal(r.isError, undefined);
  const details = r.details as { subtasks: SubtaskInfo[] };
  assert.equal(details.subtasks[1]!.status, "in-progress");
  assert.equal(details.subtasks[0]!.status, "queued");
  assert.match(text(r), /2\. b → in-progress/);
  assert.match(text(r), /progress: 0\/3/);
  // done counts in the fraction
  await t.execute("3", { action: "mark", id: 1, status: "done" }, sig);
  const r2 = await t.execute("4", { action: "list" }, sig);
  assert.match(text(r2), /progress: 1\/3/);
});

test("subtask: mark with unknown id → isError naming the known ids", async () => {
  const t = tool();
  await t.execute("1", { action: "create", items: ["a", "b"] }, sig);
  const r = await t.execute("2", { action: "mark", id: 9, status: "done" }, sig);
  assert.equal(r.isError, true);
  assert.match(text(r), /no subtask with id 9/);
  assert.match(text(r), /known ids: 1, 2/);
});

test("subtask: mark with no list yet → isError suggesting create", async () => {
  const r = await tool().execute("1", { action: "mark", id: 1, status: "done" }, sig);
  assert.equal(r.isError, true);
  assert.match(text(r), /use 'create' first/);
});

test("subtask: bad args → isError, never throws (I3)", async () => {
  const t = tool();
  const r1 = await t.execute("1", { action: "frobnicate" }, sig);
  assert.equal(r1.isError, true);
  assert.match(text(r1), /unknown action/);
  const r2 = await t.execute("2", { action: "create" }, sig);
  assert.equal(r2.isError, true);
  assert.match(text(r2), /non-empty 'items'/);
  const r3 = await t.execute("3", { action: "create", items: [42, "ok", ""] }, sig);
  assert.equal(r3.isError, undefined, "non-strings and blanks are filtered, not fatal");
  assert.deepEqual((r3.details as { subtasks: SubtaskInfo[] }).subtasks, [{ id: 1, name: "ok", status: "queued" }]);
  const r4 = await t.execute("4", { action: "mark", status: "done" }, sig);
  assert.equal(r4.isError, true);
  assert.match(text(r4), /numeric 'id'/);
  const r5 = await t.execute("5", { action: "mark", id: 1, status: "exploded" }, sig);
  assert.equal(r5.isError, true);
  assert.match(text(r5), /'status'/);
});

test("subtask: corrupt list file → REFUSED (I3), the file is preserved", async () => {
  // A file that exists but is not a valid list must NOT be silently treated
  // as empty: the old behavior let the next `create` OVERWRITE the only copy
  // of the user's list. Now every action refuses and names the file, and
  // the file is left intact for the user to inspect or delete.
  const t = tool();
  const file = subtaskFilePath(subtaskDir(home), KEY);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "{ not json", "utf8");
  const r = await t.execute("1", { action: "list" }, sig);
  assert.equal(r.isError, true, "a corrupt file is an error, not an empty list");
  assert.match(text(r), /could not be read/);
  assert.match(text(r), /refusing to overwrite/);
  const rc = await t.execute("2", { action: "create", items: ["fresh"] }, sig);
  assert.equal(rc.isError, true, "'create' refuses to clobber a corrupt file");
  assert.match(text(rc), /refusing to overwrite/);
  assert.equal(readFileSync(file, "utf8"), "{ not json", "the corrupt file is preserved");
  const rm = await t.execute("3", { action: "mark", id: 1, status: "done" }, sig);
  assert.equal(rm.isError, true, "'mark' refuses too");
  // Deleting the file heals the session (the user's escape hatch).
  unlinkSync(file);
  const r2 = await t.execute("4", { action: "create", items: ["fresh"] }, sig);
  assert.equal(r2.isError, undefined, "after deleting the corrupt file, create works");
  const r3 = await t.execute("5", { action: "list" }, sig);
  assert.match(text(r3), /1\. fresh \(queued\)/);
});

test("subtask: unwritable dir → the call still succeeds in-memory (I3)", async () => {
  // A dir whose parent is a FILE: mkdirSync fails, the write is swallowed,
  // and the result still carries the list (the model sees the update).
  const blocker = path.join(home, "blocker");
  writeFileSync(blocker, "x", "utf8");
  const t = createSubtaskTool("s", path.join(home, "blocker"));
  const r = await t.execute("1", { action: "create", items: ["a"] }, sig);
  assert.equal(r.isError, undefined, "the write failure is swallowed (I3)");
  assert.deepEqual((r.details as { subtasks: SubtaskInfo[] }).subtasks, [{ id: 1, name: "a", status: "queued" }]);
});

test("subtask: session ids are sanitized for the filename", async () => {
  // A session id with path separators or odd chars must not escape the dir.
  const t = createSubtaskTool("../../etc/passwd", home);
  const res = await t.execute("1", { action: "list" }, sig);
  assert.equal(res.isError, undefined);
  assert.match(text(res), /\(no subtasks\)/);
  // prove isolation: create via the hostile id, then verify NO file exists
  // anywhere outside <home>/.tre/subtasks/ (the sanitized basename + path
  // hash is the stem — "../../etc/passwd" → "passwd-<hash>").
  await t.execute("2", { action: "create", items: ["a"] }, sig);
  const dir = subtaskDir(home);
  const entries = readdirSync(dir);
  const expected = subtaskKey("../../etc/passwd");
  assert.ok(entries.includes(`${expected}.json`), `sanitized stem, got: ${entries.join(", ")}`);
  assert.ok(!existsSync(path.join(home, "etc", "passwd.json")), "no escape outside the subtask dir");
});

test("subtask: two sessions with the SAME basename in DIFFERENT dirs do not collide", async () => {
  // The audit finding: basename-only scoping would key both sessions to one
  // list file. The full-path hash in subtaskKey keeps them apart.
  const a = path.join(home, "proj-a", "session.jsonl");
  const b = path.join(home, "proj-b", "session.jsonl");
  assert.notEqual(subtaskKey(a), subtaskKey(b), "different full paths → different keys");
  const t1 = createSubtaskTool(a, home);
  const t2 = createSubtaskTool(b, home);
  await t1.execute("1", { action: "create", items: ["a-list"] }, sig);
  await t2.execute("2", { action: "create", items: ["b-list"] }, sig);
  // Each session sees only its own list — no cross-contamination.
  const ra = await t1.execute("3", { action: "list" }, sig);
  const rb = await t2.execute("4", { action: "list" }, sig);
  assert.match(text(ra), /a-list/);
  assert.match(text(rb), /b-list/);
  assert.ok(!/a-list/.test(text(rb)), "b does not see a's items");
  assert.ok(!/b-list/.test(text(ra)), "a does not see b's items");
  // Both list files exist on disk (distinct stems).
  const dir = subtaskDir(home);
  const entries = readdirSync(dir);
  assert.ok(entries.includes(`${subtaskKey(a)}.json`), "session a's list file");
  assert.ok(entries.includes(`${subtaskKey(b)}.json`), "session b's list file");
});

test("subtask: subtaskKey is stable (a resumed session keeps its list file)", () => {
  // The key must be a pure function of the session path — a resume of the
  // same session file must map to the same stem (the list survives).
  const p = "/home/u/.tre/sessions/tre-20260101-000000-1.jsonl";
  assert.equal(subtaskKey(p), subtaskKey(p), "same path → same key");
  assert.match(subtaskKey(p), /^tre-20260101-000000-1\.jsonl-[0-9a-f]{8}$/, "stem is basename + 8-hex-char hash");
});

test("subtask: two sessions are isolated (per-session files)", async () => {
  const t1 = createSubtaskTool("s1.jsonl", home);
  const t2 = createSubtaskTool("s2.jsonl", home);
  await t1.execute("1", { action: "create", items: ["a"] }, sig);
  const r = await t2.execute("2", { action: "list" }, sig);
  assert.match(text(r), /\(no subtasks\)/, "s2 sees nothing from s1");
});

test("subtask: readSubtasks/writeSubtasks round-trip + readSubtasks never throws", () => {
  const dir = subtaskDir(home);
  writeSubtasks(dir, "x", { items: [{ id: 1, name: "a", status: "done" }], updatedAt: 123 });
  const f = readSubtasks(dir, "x");
  assert.deepEqual(f.items, [{ id: 1, name: "a", status: "done" }]);
  assert.equal(f.updatedAt, 123);
  assert.deepEqual(readSubtasks(dir, "missing").items, []);
  const file = subtaskFilePath(dir, "bad");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, "[]", "utf8"); // wrong shape (array, not object)
  assert.deepEqual(readSubtasks(dir, "bad").items, []);
});

test("subtask: normalizeSubtaskFile coerces bad fields, rejects wrong shapes", () => {
  assert.equal(normalizeSubtaskFile(null), null);
  assert.equal(normalizeSubtaskFile([]), null);
  assert.equal(normalizeSubtaskFile({ items: "nope" }), null);
  const ok = normalizeSubtaskFile({
    items: [
      { name: "a" }, // id missing → 1
      { id: 2, name: "b", status: "bogus" }, // status → queued
      "junk", // non-object → dropped
      { id: 4, name: "d", status: "failed" },
    ],
    updatedAt: "nope",
  });
  assert.ok(ok !== null);
  assert.deepEqual(ok!.items, [
    { id: 1, name: "a", status: "queued" },
    { id: 2, name: "b", status: "queued" },
    { id: 4, name: "d", status: "failed" },
  ]);
  assert.equal(ok!.updatedAt, 0);
});

test("subtask: formatSubtaskSummary — lines + progress fraction", () => {
  assert.equal(formatSubtaskSummary([]), "(no subtasks)");
  const s = formatSubtaskSummary([
    { id: 1, name: "a", status: "done" },
    { id: 2, name: "b", status: "in-progress" },
    { id: 3, name: "c", status: "queued" },
  ]);
  assert.equal(s, "1. a (done)\n2. b (in-progress)\n3. c (queued)\nprogress: 1/3");
});

// ── Cross-process lock (acquireSubtaskLock / releaseSubtaskLock) ──────────

test("subtask lock: claim, double-claim fails, release reclaims", () => {
  const dir = subtaskDir(home);
  const a = acquireSubtaskLock(dir, "s");
  assert.ok(a !== null, "first claim succeeds");
  assert.ok(existsSync(subtaskLockPath(dir, "s")), "lock file exists");
  assert.match(readFileSync(subtaskLockPath(dir, "s"), "utf8"), /^\d+:\d+$/, "token is pid:time");
  assert.equal(acquireSubtaskLock(dir, "s"), null, "a live lock blocks a second claim");
  releaseSubtaskLock(a);
  assert.ok(!existsSync(subtaskLockPath(dir, "s")), "release removes the lock");
  const b = acquireSubtaskLock(dir, "s");
  assert.ok(b !== null, "the lock can be reclaimed after release");
  releaseSubtaskLock(b);
});

test("subtask lock: a STALE lock (dead holder) is claimable; a fresh one is not", () => {
  const dir = subtaskDir(home);
  const lock = subtaskLockPath(dir, "s");
  mkdirSync(dir, { recursive: true });
  // Simulate a crashed holder: an old lock file (mtime 60s in the past).
  writeFileSync(lock, `99999:1`, "utf8");
  const past = new Date(Date.now() - 60_000);
  utimesSync(lock, past, past);
  const claim = acquireSubtaskLock(dir, "s", 30_000);
  assert.ok(claim !== null, "the stale lock was claimed (the dead holder's lock is gone)");
  releaseSubtaskLock(claim);
  // A FRESH lock (a live holder) must NOT be claimable.
  writeFileSync(lock, `99999:2`, "utf8");
  assert.equal(acquireSubtaskLock(dir, "s", 30_000), null, "a fresh lock is not stale-claimed");
  unlinkSync(lock);
});

test("subtask lock: an unwritable dir yields null (no lock, never throws)", () => {
  const blocker = path.join(home, "blocker");
  writeFileSync(blocker, "x", "utf8");
  const claim = acquireSubtaskLock(path.join(home, "blocker"), "s");
  assert.equal(claim, null, "a dir that cannot be created → no lock");
  releaseSubtaskLock(null); // a null claim is a no-op
});

test("subtask lock: release never removes a RE-CLAIMED lock (token check)", () => {
  const dir = subtaskDir(home);
  const a = acquireSubtaskLock(dir, "s");
  assert.ok(a !== null);
  // Another process stale-claims our lock while we are "working"…
  writeFileSync(subtaskLockPath(dir, "s"), "other-token", "utf8");
  releaseSubtaskLock(a);
  assert.ok(existsSync(subtaskLockPath(dir, "s")), "the other holder's lock survived our release");
  unlinkSync(subtaskLockPath(dir, "s"));
});

test("subtask lock: a LIVE holder's lock is heartbeated — a long critical section is not stolen", async () => {
  // The audit regression: the stale window (30s default) used to be measured
  // from the CLAIM, so a second process could steal a live lock the moment
  // the holder's critical section outlived the window. The heartbeat keeps
  // the mtime fresh for the whole hold, so a live lock is never claimable —
  // no matter how long it is held.
  const dir = subtaskDir(home);
  const lock = subtaskLockPath(dir, "s");
  const claim = acquireSubtaskLock(dir, "s", 30_000, undefined, 50);
  assert.ok(claim !== null, "first claim succeeds");
  // Simulate a critical section that runs PAST the stale window: age the
  // lock 45s (beyond the 30s window) — without a heartbeat this would be
  // claimable now.
  const past = new Date(Date.now() - 45_000);
  utimesSync(lock, past, past);
  // Wait for at least one heartbeat tick to refresh the mtime…
  await new Promise((r) => setTimeout(r, 180));
  const st = statSync(lock);
  assert.ok(Date.now() - st.mtimeMs < 30_000, "the heartbeat refreshed the mtime (the lock looks fresh)");
  // …so a second process must NOT be able to steal it.
  assert.equal(acquireSubtaskLock(dir, "s", 30_000), null, "a live (heartbeating) lock is not stale-claimed");
  releaseSubtaskLock(claim);
  assert.ok(!existsSync(lock), "release removes the lock");
});

test("subtask lock: abort stops the heartbeat", async () => {
  // An aborted run must not keep re-touching a lock it no longer needs.
  const dir = subtaskDir(home);
  const lock = subtaskLockPath(dir, "s");
  const ac = new AbortController();
  const claim = acquireSubtaskLock(dir, "s", 30_000, ac.signal, 50);
  assert.ok(claim !== null);
  ac.abort();
  // Age the lock past the stale window…
  const past = new Date(Date.now() - 45_000);
  utimesSync(lock, past, past);
  // …wait for several heartbeat periods — with the interval stopped, the
  // mtime must stay where we put it (a dead holder's lock is claimable).
  await new Promise((r) => setTimeout(r, 200));
  const st = statSync(lock);
  assert.ok(Date.now() - st.mtimeMs > 40_000, "no heartbeat after abort (the mtime was not refreshed)");
  // The stale lock is now claimable (the holder is "silent")…
  const stolen = acquireSubtaskLock(dir, "s", 30_000);
  assert.ok(stolen !== null, "a silent (aborted) holder's lock is claimable");
  releaseSubtaskLock(stolen);
  // …and releasing the original claim is a no-op (token mismatch).
  releaseSubtaskLock(claim);
});

test("subtask lock: a heartbeat does NOT re-touch a RE-CLAIMED lock (token check)", async () => {
  // If our lock is stale-claimed and re-created by another process while we
  // still hold the claim, our heartbeat must not re-touch it (that would
  // extend THEIR hold). The heartbeat callback's token check guards this —
  // verified here with a short, injectable refresh period.
  const dir = subtaskDir(home);
  const lock = subtaskLockPath(dir, "s");
  const claim = acquireSubtaskLock(dir, "s", 30_000, undefined, 50);
  assert.ok(claim !== null);
  // Another process stale-claims our lock while we are "working"…
  writeFileSync(lock, "other-token", "utf8");
  // …and ages it past the stale window.
  const past = new Date(Date.now() - 45_000);
  utimesSync(lock, past, past);
  // Wait for several heartbeat periods — the token check must prevent any
  // re-touch, so the mtime stays where the "other" process put it.
  await new Promise((r) => setTimeout(r, 200));
  const st = statSync(lock);
  assert.ok(Date.now() - st.mtimeMs > 40_000, "the heartbeat did not re-touch the re-claimed lock");
  // Releasing the original claim is a no-op (token mismatch)…
  releaseSubtaskLock(claim);
  assert.ok(existsSync(lock), "the other holder's lock survived our release");
  unlinkSync(lock);
});

test("subtask: readSubtaskState distinguishes missing / ok / corrupt", () => {
  const dir = subtaskDir(home);
  assert.deepEqual(readSubtaskState(dir, "nope"), { status: "missing" });
  writeSubtasks(dir, "x", { items: [{ id: 1, name: "a", status: "done" }], updatedAt: 7 });
  assert.deepEqual(readSubtaskState(dir, "x"), {
    status: "ok",
    file: { items: [{ id: 1, name: "a", status: "done" }], updatedAt: 7 },
  });
  const bad = subtaskFilePath(dir, "bad");
  mkdirSync(dir, { recursive: true });
  writeFileSync(bad, "{ not json", "utf8");
  assert.deepEqual(readSubtaskState(dir, "bad"), { status: "corrupt" });
  // A file that parses but is the wrong shape is corrupt too.
  writeFileSync(bad, "[]", "utf8");
  assert.deepEqual(readSubtaskState(dir, "bad"), { status: "corrupt" });
});

// ── In-memory mode (persist: false — sessionless runs) ─────────────────────

test("subtask in-memory: create/mark/list round-trip WITHOUT touching disk", async () => {
  const t = createSubtaskTool("default", home, false);
  const r = await t.execute("1", { action: "create", items: ["a", "b"] }, sig);
  assert.equal(r.isError, undefined);
  const r2 = await t.execute("2", { action: "mark", id: 1, status: "done" }, sig);
  assert.equal((r2.details as { subtasks: SubtaskInfo[] }).subtasks[0]!.status, "done");
  const r3 = await t.execute("3", { action: "list" }, sig);
  assert.match(text(r3), /progress: 1\/2/);
  // NOTHING was written: no list file, no lock file, no dir at all.
  assert.ok(!existsSync(subtaskFilePath(subtaskDir(home), "default")), "no list file");
  assert.ok(!existsSync(subtaskLockPath(subtaskDir(home), "default")), "no lock file");
  assert.ok(!existsSync(subtaskDir(home)), "no subtask dir created");
});

test("subtask in-memory: each tool instance is isolated (no shared state)", async () => {
  const t1 = createSubtaskTool("default", home, false);
  const t2 = createSubtaskTool("default", home, false);
  await t1.execute("1", { action: "create", items: ["a"] }, sig);
  const r = await t2.execute("2", { action: "list" }, sig);
  assert.match(text(r), /\(no subtasks\)/, "t2 sees nothing from t1");
});

test("subtask in-memory: a fresh process (new tool) starts empty — nothing survives", async () => {
  const t1 = createSubtaskTool("default", home, false);
  await t1.execute("1", { action: "create", items: ["a"] }, sig);
  // Simulate the process exiting and a new one starting: a new tool instance.
  const t2 = createSubtaskTool("default", home, false);
  const r = await t2.execute("2", { action: "list" }, sig);
  assert.match(text(r), /\(no subtasks\)/, "the in-memory list does not survive the process");
});

test("subtask persist: a session-bound tool still writes the file (the default)", async () => {
  const t = createSubtaskTool("s.jsonl", home, true);
  await t.execute("1", { action: "create", items: ["a"] }, sig);
  const key = subtaskKey("s.jsonl");
  assert.ok(existsSync(subtaskFilePath(subtaskDir(home), key)), "the list file is written");
  assert.ok(!existsSync(subtaskLockPath(subtaskDir(home), key)), "the lock is released after the call");
});
