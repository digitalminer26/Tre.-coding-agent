/**
 * The `subtask` tool (src/tools/subtask.ts): create/list/mark round-trips
 * against an injectable home dir, I3 (failures are isError results, never
 * throws), the `details.subtasks` payload the TUI reads, atomic persistence,
 * and the pure helpers (normalizeSubtaskFile, formatSubtaskSummary).
 */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  acquireSubtaskLock,
  acquireSubtaskLockWait,
  canonicalSessionPath,
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

test("subtask: every action's details carry action + updatedAt (the TUI's settle-window inputs)", async () => {
  // Audit F1a: the TUI's applyEvent decides "activity vs observational"
  // from details.action, and the poller's snapshot signature includes the
  // file's updatedAt — a list result WITHOUT action re-armed the display
  // and pinned a settled list on screen forever.
  const t = tool();
  const c = await t.execute("1", { action: "create", items: ["a"] }, sig);
  const cd = c.details as { action?: string; updatedAt?: number };
  assert.equal(cd.action, "create");
  assert.ok(typeof cd.updatedAt === "number" && cd.updatedAt > 0, "create stamps updatedAt");

  const l = await t.execute("2", { action: "list" }, sig);
  const ld = l.details as { action?: string; updatedAt?: number };
  assert.equal(ld.action, "list", "list is TAGGED (observational — must not re-arm the display)");
  assert.equal(ld.updatedAt, cd.updatedAt, "a read does not move updatedAt");

  const m = await t.execute("3", { action: "mark", id: 1, status: "done" }, sig);
  const md = m.details as { action?: string; updatedAt?: number };
  assert.equal(md.action, "mark");
  assert.ok(md.updatedAt! >= cd.updatedAt!, "mark stamps a fresh updatedAt");
});

test("subtask: every action's details carry rev (the write identity) — bump on write, stable on read", async () => {
  // Rev model (DESIGN.md): `rev` is the monotonic per-write identity,
  // separate from the updatedAt clock. create/mark bump it; list reports
  // the CURRENT file rev without bumping.
  const t = tool();
  const c = await t.execute("1", { action: "create", items: ["a"] }, sig);
  const cd = c.details as { rev?: number };
  assert.equal(cd.rev, 1, "the first write is rev 1");
  const l = await t.execute("2", { action: "list" }, sig);
  const ld = l.details as { rev?: number };
  assert.equal(ld.rev, 1, "a read does not bump rev");
  const m = await t.execute("3", { action: "mark", id: 1, status: "done" }, sig);
  const md = m.details as { rev?: number };
  assert.equal(md.rev, 2, "the next write is rev 2");
  // The file on disk carries the same rev the result reported.
  const file = JSON.parse(readFileSync(subtaskFilePath(subtaskDir(home), KEY), "utf8"));
  assert.equal(file.rev, 2, "the persisted file carries the write's rev");
});

test("subtask: identical writes get DISTINCT revs (audit F2 — Date.now collision cannot inherit ownership)", async () => {
  // The audit F2 fix: two identical create writes — even inside the same
  // millisecond — are distinct writes (rev R and R+1), so a foreign
  // same-content rewrite can never masquerade as the armed write.
  const t = tool();
  const a = await t.execute("1", { action: "create", items: ["same"] }, sig);
  const b = await t.execute("2", { action: "create", items: ["same"] }, sig);
  const ra = (a.details as { rev: number }).rev;
  const rb = (b.details as { rev: number }).rev;
  assert.equal(rb, ra + 1, "an identical rewrite bumps rev");
  // A mark that rewrites identical content (same status) bumps it too.
  const m = await t.execute("3", { action: "mark", id: 1, status: "queued" }, sig);
  assert.equal((m.details as { rev: number }).rev, rb + 1, "a no-op mark still bumps rev");
});

test("subtask: rev survives a legacy file (no rev on disk reads as 0, next write is 1)", async () => {
  // A file written before revisions existed (or hand-edited without rev)
  // reads as rev 0 = no write identity; the next create/mark continues the
  // sequence from there (rev 1) — strictly increasing from then on.
  const dir = subtaskDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    subtaskFilePath(dir, KEY),
    JSON.stringify({ items: [{ id: 1, name: "legacy", status: "queued" }], updatedAt: 42 }),
    "utf8",
  );
  const l = await tool().execute("1", { action: "list" }, sig);
  assert.equal((l.details as { rev?: number }).rev, 0, "a legacy file reads as rev 0");
  const m = await tool().execute("2", { action: "mark", id: 1, status: "done" }, sig);
  assert.equal((m.details as { rev?: number }).rev, 1, "the first rev-aware write continues from 0 → 1");
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

test("subtask: unwritable dir → the write failure is VISIBLE, no details published (audit cycle-1 F2)", async () => {
  // A dir whose parent is a FILE: mkdirSync fails. The pre-cycle-2 behavior
  // swallowed the failure and reported success WITH the list + a rev —
  // publishing an uncommitted revision as an ownership identity (the
  // audit's failed-write finding: a later foreign write reuses that rev
  // and inherits the first write's exemption). Now the failure is an
  // isError result and, crucially, carries NO details: nothing to mirror,
  // nothing to arm.
  const blocker = path.join(home, "blocker");
  writeFileSync(blocker, "x", "utf8");
  const t = createSubtaskTool("s", path.join(home, "blocker"));
  const r = await t.execute("1", { action: "create", items: ["a"] }, sig);
  assert.equal(r.isError, true, "the write failure is visible (no fake success)");
  assert.match(text(r), /could not be written/);
  assert.equal(r.details, undefined, "no details → the uncommitted rev is never published");
  // A failed write does not poison the session either: `list` still
  // answers (a read of nothing), and every retry fails visibly.
  const l = await t.execute("2", { action: "list" }, sig);
  assert.equal(l.isError, undefined);
  const r2 = await t.execute("3", { action: "create", items: ["a"] }, sig);
  assert.equal(r2.isError, true);
  assert.equal(r2.details, undefined);
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

test("subtask: canonicalSessionPath — symlink and target key to the SAME list", () => {
  // The audit finding: path.resolve does not resolve symlinks, so the
  // symlink spelling and the target spelling of the SAME physical session
  // file key to different lists. Canonicalization must unify them.
  const real = path.join(home, "sessions", "tre-20260101-000000-1.jsonl");
  mkdirSync(path.dirname(real), { recursive: true });
  writeFileSync(real, "{}\n", "utf8");
  const link = path.join(home, "link.jsonl");
  symlinkSync(real, link);
  assert.equal(
    subtaskKey(canonicalSessionPath(link)),
    subtaskKey(canonicalSessionPath(real)),
    "symlink and target → the same subtask key",
  );
  assert.equal(
    canonicalSessionPath(link),
    canonicalSessionPath(real),
    "both spellings canonicalize to the same path",
  );
});

test("subtask: canonicalSessionPath — fresh session (missing file) keeps a stable key", () => {
  // A session that does not exist yet: canonicalize the existing parent and
  // re-append the tail. The key must be STABLE across runs — a later run
  // with the file present must map to the same list (resume survives).
  const real = path.join(home, "sessions", "fresh.jsonl");
  mkdirSync(path.dirname(real), { recursive: true });
  const before = canonicalSessionPath(real);
  writeFileSync(real, "{}\n", "utf8");
  const after = canonicalSessionPath(real);
  assert.equal(before, after, "key is stable across file creation (resume survives)");
  assert.equal(subtaskKey(before), subtaskKey(after), "same list before/after creation");
});

test("subtask: canonicalSessionPath — fresh session via a BROKEN symlink follows the link", () => {
  // The file does not exist yet, but the path is a symlink whose target is
  // also missing. The first run must key to the TARGET spelling — a later
  // run (file present) canonicalizes to the target too.
  const real = path.join(home, "sessions", "target.jsonl");
  mkdirSync(path.dirname(real), { recursive: true });
  const link = path.join(home, "link.jsonl");
  symlinkSync(real, link); // target does not exist → broken link
  const before = canonicalSessionPath(link);
  writeFileSync(real, "{}\n", "utf8");
  const after = canonicalSessionPath(link);
  assert.equal(before, after, "broken symlink → target spelling, stable after creation");
  assert.equal(before, canonicalSessionPath(real), "link spelling → the target's canonical path");
});

test("subtask: canonicalSessionPath — unresolvable path returns the input unchanged", () => {
  // A path that EXISTS but cannot be resolved (EPERM under a strict
  // sandbox — the C35 case) must fall back to the input unchanged: the key
  // stays a stable function of the input. Hermetically: a chmod-000 parent
  // makes realpathSync throw EPERM (skipped under root).
  const base = mkdtempSync(path.join(tmpdir(), "subtask-eperm-"));
  const locked = path.join(base, "locked");
  const target = path.join(locked, "dir", "s.jsonl");
  mkdirSync(target, { recursive: true });
  try {
    if (process.getuid?.() !== 0) {
      chmodSync(locked, 0o000);
      try {
        assert.equal(canonicalSessionPath(target), target, "EPERM → input unchanged (fail-safe)");
      } finally {
        chmodSync(locked, 0o755);
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("subtask: canonicalSessionPath — a symlink cycle does not loop", () => {
  const a = path.join(home, "a.jsonl");
  const b = path.join(home, "b.jsonl");
  symlinkSync(b, a);
  symlinkSync(a, b);
  const r = canonicalSessionPath(a); // must return (no infinite loop)
  assert.equal(typeof r, "string");
  assert.ok(r.length > 0);
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
  writeSubtasks(dir, "x", { items: [{ id: 1, name: "a", status: "done" }], updatedAt: 123, rev: 5 });
  const f = readSubtasks(dir, "x");
  assert.deepEqual(f.items, [{ id: 1, name: "a", status: "done" }]);
  assert.equal(f.updatedAt, 123);
  assert.equal(f.rev, 5, "the write revision round-trips");
  assert.deepEqual(readSubtasks(dir, "missing").items, []);
  assert.equal(readSubtasks(dir, "missing").rev, 0, "a missing file reads as rev 0");
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
  // A file without a rev (or with a bad/non-positive one) reads as rev 0 =
  // "no write identity" (the legacy fallback) — never a rejection.
  assert.equal(ok!.rev, 0);
  assert.equal(normalizeSubtaskFile({ items: [], rev: "nope" })!.rev, 0);
  assert.equal(normalizeSubtaskFile({ items: [], rev: -2 })!.rev, 0);
  assert.equal(normalizeSubtaskFile({ items: [], rev: 7 })!.rev, 7);
  assert.equal(normalizeSubtaskFile({ items: [], rev: 2.4 })!.rev, 2, "rev is rounded");
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
  writeSubtasks(dir, "x", { items: [{ id: 1, name: "a", status: "done" }], updatedAt: 7, rev: 3 });
  assert.deepEqual(readSubtaskState(dir, "x"), {
    status: "ok",
    file: { items: [{ id: 1, name: "a", status: "done" }], updatedAt: 7, rev: 3 },
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

// ── audit cycle-1 finding 1: the lock is NOT best-effort for mutations ─────
//
// The rev ownership identity is only sound if EVERY allocation runs under
// the session lock. The pre-fix code acquired the lock once and proceeded
// UNLOCKED when a live holder owned it — two processes could both read R
// and both publish R+1. Now create/mark WAIT for the lock and are REFUSED
// (visible error, nothing written, no rev published) when it cannot be
// acquired; `list` stays a lock-free read.

test("acquireSubtaskLockWait: waits for a live holder and claims after release", async () => {
  const dir = subtaskDir(home);
  const a = acquireSubtaskLock(dir, "s");
  assert.ok(a !== null);
  // A waiter with a short budget gives up while the holder is live…
  const t0 = Date.now();
  const missed = await acquireSubtaskLockWait(dir, "s", 120);
  assert.equal(missed, null, "no claim while a live holder owns the lock");
  assert.ok(Date.now() - t0 >= 100, "the waiter actually waited (not an instant null)");
  // …and claims as soon as the holder releases.
  const waiter = acquireSubtaskLockWait(dir, "s", 5_000);
  setTimeout(() => releaseSubtaskLock(a), 80);
  const got = await waiter;
  assert.ok(got !== null, "the waiter claimed the lock after the release");
  releaseSubtaskLock(got);
});

test("acquireSubtaskLockWait: an un-writable dir returns null immediately (no budget burn)", async () => {
  const blocker = path.join(home, "blocker");
  writeFileSync(blocker, "x", "utf8");
  const t0 = Date.now();
  const got = await acquireSubtaskLockWait(path.join(home, "blocker", "sub"), "s", 60_000);
  assert.equal(got, null, "no lock is possible → null");
  assert.ok(Date.now() - t0 < 5_000, "fails fast instead of waiting the whole budget");
});

test("acquireSubtaskLockWait: an aborted signal never claims", async () => {
  const dir = subtaskDir(home);
  const ac = new AbortController();
  ac.abort();
  const got = await acquireSubtaskLockWait(dir, "s", 5_000, ac.signal);
  assert.equal(got, null, "an aborted run does not wait or claim");
});

test("subtask: a mutation REFUSES while another process holds the lock (audit cycle-1 F1)", async () => {
  // A LIVE holder (another process's lock file, fresh mtime) must block a
  // create/mark — the old behavior proceeded unlocked and could publish a
  // duplicate rev. The refusal writes nothing and publishes no revision.
  const dir = subtaskDir(home);
  mkdirSync(dir, { recursive: true });
  const holder = acquireSubtaskLock(dir, KEY);
  assert.ok(holder !== null, "the fixture holds the session lock");
  const t = createSubtaskTool(SESSION_ID, home, true, 150); // short wait for the test
  const r = await t.execute("1", { action: "create", items: ["a"] }, sig);
  assert.equal(r.isError, true, "the mutation is refused, not run unlocked");
  assert.match(text(r), /could not acquire the session subtask lock/);
  assert.equal(r.details, undefined, "no details → no rev published");
  assert.ok(!existsSync(subtaskFilePath(dir, KEY)), "nothing was written");
  // `list` still works under contention (a read allocates nothing).
  const l = await t.execute("2", { action: "list" }, sig);
  assert.equal(l.isError, undefined, "list is a lock-free read");
  releaseSubtaskLock(holder);
  // After the holder releases, the same tool writes normally.
  const r2 = await t.execute("3", { action: "create", items: ["a"] }, sig);
  assert.equal(r2.isError, undefined);
  assert.equal((r2.details as { rev: number }).rev, 1, "the rev sequence starts clean");
});

test("subtask: an aborted signal refuses the mutation instead of writing unlocked", async () => {
  const t = createSubtaskTool(SESSION_ID, home, true, 5_000);
  const ac = new AbortController();
  ac.abort();
  const r = await t.execute("1", { action: "create", items: ["a"] }, ac.signal);
  assert.equal(r.isError, true, "an aborted call never writes");
  assert.equal(r.details, undefined);
});

type Outcome = { out: string; err: string; code: number | null };
type ChildRun = {
  proc: ReturnType<typeof spawn>;
  ready: Promise<void>;
  done: Promise<Outcome>;
  /** Settles on the child's `close` event (process gone AND stdio drained). */
  closed: Promise<void>;
};

test("subtask: concurrent processes writing the same session get DISTINCT revs (audit cycle-1 F1, cross-process contention)", async () => {
  // Cross-process contention, proven from the PRODUCTION path. The parent
  // holds the session lock. Each child runs the real `create` tool, whose
  // lock wait reports (via the injectable contention observer) every claim
  // it sees REFUSED by the live holder. A child prints `ready` only from
  // that observer — so readiness means "this child's claim was actually
  // refused by the held lock", not merely "the child booted". The parent
  // releases only after all N children have been refused, so every child
  // must then serialize through the lock. Under the pre-fix code a refused
  // child wrote anyway and could reuse a rev; the mid-test assertion
  // (no commit while held) and the distinct-rev assertion catch that.
  const dir = subtaskDir(home);
  mkdirSync(dir, { recursive: true });
  writeSubtasks(dir, KEY, { items: [{ id: 1, name: "seed", status: "queued" as const }], updatedAt: 1, rev: 0 });
  const N = 6;
  const parent = acquireSubtaskLock(dir, KEY);
  assert.ok(parent !== null, "the parent claims the lock for the contention phase");

  // From HERE to the end of the test, every started child and the parent
  // lock are inside the try/finally: a synchronous throw during child
  // setup (spawn CAN throw — e.g. an invalid environment value) still
  // releases the lock and reaps the children that DID start.
  const runs: ChildRun[] = [];
  try {
    const childSrc = [
      // Absolute module URL (this file compiles to dist/test/) — a
      // CWD-relative path only resolves when the suite runs from the repo root.
      `import { createSubtaskTool } from ${JSON.stringify(new URL("../src/tools/subtask.js", import.meta.url).href)};`,
      `const sig = new AbortController().signal;`,
      `let announced = false;`,
      `const t = createSubtaskTool(${JSON.stringify(SESSION_ID)}, ${JSON.stringify(home)}, true, 30_000, () => {`,
      `  if (!announced) { announced = true; process.stdout.write("ready\\n"); }`,
      `});`,
      `const r = await t.execute("c", { action: "create", items: ["p-" + process.pid] }, sig);`,
      `process.stdout.write(JSON.stringify({ err: r.isError === true, rev: r.details?.rev ?? null }) + "\\n");`,
    ].join("\n");

    // Bounds: every wait is deadline-raced; nothing can hang the test.
    const WAIT_MS = 60_000;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const withDeadline = <T>(p: Promise<T>, what: string): Promise<T> =>
      Promise.race([
        p,
        new Promise<never>((_, rej) => {
          deadlineTimer = setTimeout(() => rej(new Error(`deadline (${WAIT_MS}ms): ${what}`)), WAIT_MS);
        }),
      ]).finally(() => clearTimeout(deadlineTimer));

    for (let i = 0; i < N; i++) runs.push(startChild(childSrc));

    // Readiness = each child's claim was refused by the held lock.
    await withDeadline(Promise.all(runs.map((r) => r.ready)), "waiting for contended-claim readiness");
    // Contention proven: while the lock is held, no child may commit.
    assert.equal(readSubtasks(dir, KEY).rev, 0, "no child committed while the parent held the lock");
    releaseSubtaskLock(parent);
    const outs = await withDeadline(Promise.all(runs.map((r) => r.done)), "waiting for children to finish");
    const results = outs.map((p, i) => {
      assert.equal(p.code, 0, `child ${i} exited cleanly: ${p.err}`);
      const lines = p.out.trimEnd().split("\n");
      assert.equal(lines[0], "ready", `child ${i} announced contention before its result`);
      return JSON.parse(lines[lines.length - 1]!);
    });
    const ok = results.filter((r) => !r.err);
    assert.equal(ok.length, N, `every contended child eventually got the lock (got ${ok.length}/${N})`);
    const revs = ok.map((r) => r.rev).sort((a, b) => a - b);
    assert.deepEqual(revs, [1, 2, 3, 4, 5, 6], "six contended writes → six DISTINCT revs 1..6");
    assert.equal(readSubtasks(dir, KEY).rev, N, "the persisted rev is the number of committed writes");
  } finally {
    releaseSubtaskLock(parent); // idempotent
    // Guaranteed, escalating cleanup: SIGTERM, bounded grace, then
    // SIGKILL, then await every child's CLOSE event (not merely process
    // exit — exit fires while the child's stdio may still be open, e.g.
    // a descendant holding the pipe; the fixture must not be deleted
    // under a still-connected writer). A child that survives SIGKILL is
    // a hard failure.
    const terminate = async (sig: NodeJS.Signals, graceMs: number): Promise<boolean> => {
      for (const r of runs) if (r.proc.exitCode === null && r.proc.signalCode === null) r.proc.kill(sig);
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        Promise.all(runs.map((r) => r.closed)).then(() => "closed" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), graceMs);
        }),
      ]);
      clearTimeout(timer);
      return outcome === "closed";
    };
    const closedInGrace = await terminate("SIGTERM", 2_000);
    if (!closedInGrace) {
      const killed = await terminate("SIGKILL", 5_000);
      assert.ok(killed, "every contention child reached its close event (none survived SIGKILL)");
    }
  }

  // One child: spawn + persistent collectors + the three promises.
  // `ready` resolves from the contention line (a real refused claim);
  // `done` settles on the RESULT (exit code + full output); `closed`
  // settles ONLY on the `close` event (process gone AND stdio drained) —
  // exitCode/signalCode alone do not mean the streams are finished.
  // Every promise gets its rejection handler at creation, so neither a
  // spawn `error` nor an early `close` can leave an unhandled rejection.
  function startChild(childSrc: string): ChildRun {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", childSrc], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    const ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    let resolveDone!: (o: Outcome) => void;
    let rejectDone!: (e: Error) => void;
    const done = new Promise<Outcome>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((res) => {
      resolveClosed = res;
    });
    ready.catch(() => {}); // consumed below; never an unhandled rejection
    done.catch(() => {});
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => {
      out += d;
      if (out.includes("ready\n")) resolveReady();
    });
    proc.stderr.on("data", (d: string) => (err += d));
    proc.once("error", (e) => {
      // A failed spawn (ENOENT etc.) NEVER runs the child — but Node still
      // emits `close` after `error`, so `closed` is resolved there (its
      // contract: settles ONLY on `close`).
      rejectReady(e);
      rejectDone(e);
    });
    proc.once("close", (code) => {
      // A child that exits before announcing readiness fails the barrier
      // promptly, not at the full deadline.
      rejectReady(new Error(`child exited before ready (code ${code}): ${err}`));
      resolveDone({ out, err, code });
      resolveClosed();
    });
    return { proc, ready, done, closed };
  }
});

// ── audit cycle-1 finding 2: a failed write must not publish its revision ──

test("subtask: an obstructed tmp path fails VISIBLE and the rev is not reused for a foreign exemption (audit cycle-1 F2)", async () => {
  // The audit's exact repro: `<list>.<pid>.tmp` is a DIRECTORY, so the
  // rename fails. Pre-fix: create reported success + rev 1 while disk
  // stayed empty; a later foreign write then committed rev 1 and — fed
  // through applyEvent (arm at the first rev 1) and the poller (the
  // foreign rev 1) — inherited the exemption forever. Now: the failure is
  // an error with NO details (nothing armed), and after clearing the
  // obstruction the retry commits rev 1 cleanly — an identity that was
  // never armed is never inherited.
  const dir = subtaskDir(home);
  mkdirSync(dir, { recursive: true });
  const file = subtaskFilePath(dir, KEY);
  const tmp = `${file}.${process.pid}.tmp`;
  mkdirSync(tmp, { recursive: true }); // obstruct the atomic rename
  const t = createSubtaskTool(SESSION_ID, home);
  const r = await t.execute("1", { action: "create", items: ["mine"] }, sig);
  assert.equal(r.isError, true, "the failed write is visible");
  assert.equal(r.details, undefined, "no details → the uncommitted rev 1 is never published");
  assert.ok(!existsSync(file), "disk unchanged by the failed write");
  // The TUI armed NOTHING (no details), so there is no exemption to
  // inherit — assert the state-layer half in the same breath: an event
  // without details leaves the arm untouched.
  // (Full applyEvent coverage lives in test/tui-state.test.ts; here the
  // tool contract is what matters: no details on failure.)
  // Clear the obstruction → the retry succeeds and IS the first rev.
  rmSync(tmp, { recursive: true, force: true });
  const r2 = await t.execute("2", { action: "create", items: ["mine"] }, sig);
  assert.equal(r2.isError, undefined, "after fixing the path the write lands");
  assert.equal((r2.details as { rev: number }).rev, 1, "the retry re-allocates from the committed file (never double-bumps)");
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.rev, 1, "the reported rev is the COMMITTED rev");
  // And a mark continues the sequence from the committed file.
  const r3 = await t.execute("3", { action: "mark", id: 1, status: "done" }, sig);
  assert.equal((r3.details as { rev: number }).rev, 2);
});

test("subtask: a failed mark is visible with no details too (audit cycle-1 F2, mark path)", async () => {
  const dir = subtaskDir(home);
  mkdirSync(dir, { recursive: true });
  const t = createSubtaskTool(SESSION_ID, home);
  const c = await t.execute("1", { action: "create", items: ["a", "b"] }, sig);
  assert.equal((c.details as { rev: number }).rev, 1);
  const file = subtaskFilePath(dir, KEY);
  const tmp = `${file}.${process.pid}.tmp`;
  mkdirSync(tmp, { recursive: true });
  const r = await t.execute("2", { action: "mark", id: 1, status: "done" }, sig);
  assert.equal(r.isError, true);
  assert.equal(r.details, undefined, "no details on the failed mark");
  const still = readSubtasks(dir, KEY);
  assert.equal(still.rev, 1, "the file still holds the last COMMITTED rev");
  assert.equal(still.items[0]!.status, "queued", "the failed mark did not touch disk");
  rmSync(tmp, { recursive: true, force: true });
});
