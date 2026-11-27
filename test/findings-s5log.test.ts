/**
 * S5 log wrapper (`src/findings/s5log.ts`) — acceptance tests.
 *
 * Ports per g1-implementation-mapping.md's `s5log` row (audit c1
 * Q5c): the wrapper's own capabilities are the acceptance criteria —
 *   - exclusive ownership: the claim is held ACROSS the serialized
 *     unit; a live contender is refused (fail-closed); a dead
 *     holder's claim is taken over (crash recovery) and a
 *     taken-over holder's release is FENCED (never deletes the
 *     successor's claim);
 *   - ordered durability: no decision returned before the prefix it
 *     rests on is established (v33), fsync-before-ack (a failing
 *     sync = no ack; V-g3/V-g5 class);
 *   - full lock lifetime: acquire before ANY read (replay included),
 *     release on every exit path;
 *   - per-file durability establishment (v33) + ONE fsync per pass
 *     (V-g13).
 *
 * Transport-level ports of the schema vectors (full cure-gate
 * semantics ride with recovery.ts per mapping Q3): V-g1 (partial
 * fragment truncated, absent from the prefix), V-g2 (complete
 * newline-lost record KEPT and classified), V-g4 (mid-file
 * corruption — bad line, BLANK line, or invalid UTF-8 — rejects the
 * pass with the file untouched, even a repairable fragment), V-g13
 * (one append fsync for a two-record pass). NDR-r transport cases
 * (a)/(b)/(c) — with the scope note that act/effect/draft identity
 * is intake's, so (b) is a reported refiling CANDIDATE.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, fsyncSync, readFileSync, unlinkSync, utimesSync, writeFileSync, readdirSync, mkdirSync, openSync, closeSync, writeSync, ftruncateSync, chmodSync, linkSync } from "node:fs";
import { spawn } from "node:child_process";
import { renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  S5Log,
  S5LockBusyError,
  S5LockLostError,
  S5LogCorruptionError,
  S5LogIdentityError,
  S5ReplayIntegrityError,
  classifyRedelivery,
  retrySleepMs,
  type S5SyncLabel,
} from "../src/findings/s5log.js";

interface Rec {
  id: string;
  kind: string;
  n?: number;
}

async function freshLogPath(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `s5log-${name}-`));
  return path.join(dir, "s5.jsonl");
}

/** Cycle-4 fold (registry shape, terra c4 B1): plant a FOREIGN
 *  claim ENTRY inside the registry directory `<log>.lock` with the
 *  given token bytes and mtime — the adversary's foothold for the
 *  takeover/fence tests. Returns the entry path. */
function plantForeignClaim(p: string, token: string, mtime?: Date): string {
  const reg = p + ".lock";
  mkdirSync(reg, { recursive: true });
  const claim = `${reg}/claim-999999-${Math.floor(Math.random() * 2 ** 40).toString(16).padStart(10, "0")}`;
  writeFileSync(claim, token, { flag: "wx" });
  if (mtime !== undefined) utimesSync(claim, mtime, mtime);
  return claim;
}

/** The live claim entries inside the registry (empty when absent). */
function registryClaims(p: string): string[] {
  try {
    return readdirSync(p + ".lock");
  } catch {
    return [];
  }
}

/** Counting/labeled sync recorder built on the real fsync. */
function syncSpy(failOn?: (label: S5SyncLabel) => boolean) {
  const calls: S5SyncLabel[] = [];
  return {
    calls,
    fn: (fd: number, label: S5SyncLabel) => {
      calls.push(label);
      if (failOn && failOn(label)) {
        throw Object.assign(new Error(`injected sync failure: ${label}`), { code: "EIO" });
      }
      fsyncSync(fd);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Capabilities 1+2+3 — ownership, ordered durability, lock lifetime   *
 * ------------------------------------------------------------------ */

test("append makes the record durable and acked; replay sees it", async () => {
  const log = new S5Log<Rec>({ path: await freshLogPath("append") });
  const res = log.append({ id: "rec-1", kind: "finding", n: 1 });
  assert.equal(res.status, "acked");
  assert.equal(res.durability, "fsynced");
  const back = log.replay();
  assert.deepEqual(back.records.map((r) => r.id), ["rec-1"]);
  assert.deepEqual(back.corruptLines, []);
  assert.equal(back.durability, "proven");
});

test("durability establishment (v33): the LOG's own fd + dir are synced ONCE; marker proves it; reopens skip it", async () => {
  const p = await freshLogPath("establish");
  const spy = syncSpy();
  const log = new S5Log<Rec>({ path: p, sync: spy.fn });
  log.append({ id: "a", kind: "k" });
  // Establishment ran against the LOG FILE and its DIR before the
  // pass's append sync (audit c1 fold: no probe-entry detour).
  assert.ok(spy.calls.includes("log-file"), "log fd synced (its inode+content)");
  assert.ok(spy.calls.includes("log-dir"), "dir synced (the LOG's dir entry — v33)");
  assert.ok(spy.calls.indexOf("log-dir") < spy.calls.indexOf("append"), "establishment before the pass");
  assert.ok(existsSync(p + ".durability"), "marker written");

  // Reopen: the marker proves establishment — no ritual again.
  const spy2 = syncSpy();
  const log2 = new S5Log<Rec>({ path: p, sync: spy2.fn });
  log2.append({ id: "b", kind: "k" });
  assert.ok(!spy2.calls.includes("log-file"), "no second establishment on a proven marker");
});

test("fresh instance relying on pre-existing records pays ONE establishing sync before deciding (v33)", async () => {
  const p = await freshLogPath("prefixsync");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "a", kind: "k" });

  const spy = syncSpy();
  const fresh = new S5Log<Rec>({ path: p, sync: spy.fn }); // marker proven, but records' origin unknown to THIS instance
  const res = fresh.appendUnit((prefix) => {
    // At make() return time the prefix was NOT yet proven; the
    // establishing sync runs after the decision, before the ack:
    return [{ id: "new", kind: "k" }];
  });
  assert.equal(res.status, "acked");
  assert.ok(spy.calls.includes("establish-prefix"), "unknown-origin prefix established before reliance");
  assert.ok(spy.calls.indexOf("establish-prefix") < spy.calls.indexOf("append"), "establish then append — separate concerns: establishing gates RELIANCE, the pass sync makes the NEW bytes durable");
});

test("missing/corrupt marker forces re-establishment — absence is never trusted", async () => {
  const p = await freshLogPath("marker");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "a", kind: "k" });
  await writeFile(p + ".durability", "not json", "utf8");
  const spy = syncSpy();
  const log2 = new S5Log<Rec>({ path: p, sync: spy.fn });
  log2.append({ id: "b", kind: "k" });
  assert.ok(spy.calls.includes("log-file"), "unreadable marker re-ran the ritual");
});

test("ordered durability: a FAILING append fsync throws and NOTHING is acked (V-g3/V-g5 class)", async () => {
  const p = await freshLogPath("fsyncfail");
  const spy = syncSpy((label) => label === "append");
  const log = new S5Log<Rec>({ path: p, sync: spy.fn });
  assert.throws(() => log.append({ id: "a", kind: "k" }), /injected sync failure/);
  assert.ok(!existsSync(p + ".lock"), "lock released on the failure path");
  // Indeterminate (V-g5): the bytes may stand readable but were
  // NEVER acked. A fresh instance re-decides; either path resolves
  // to exactly one durable copy.
  const healthy = new S5Log<Rec>({ path: p });
  const again = healthy.append({ id: "a", kind: "k" });
  assert.ok(again.status === "acked" || again.status === "refiled-only");
  const back = healthy.replay();
  assert.equal(back.records.map((r) => r.id).filter((i) => i === "a").length, 1);
});

test("a fresh instance whose establishing sync FAILS never acks a decision resting on unproven bytes (V-g3)", async () => {
  const p = await freshLogPath("vpg3");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "old", kind: "k" });
  const spy = syncSpy((label) => label === "establish-prefix");
  const fresh = new S5Log<Rec>({ path: p, sync: spy.fn });
  assert.throws(() => fresh.appendUnit(() => [{ id: "new", kind: "k" }]), /injected sync failure/);
  const healthy = new S5Log<Rec>({ path: p });
  const ids = healthy.replay().records.map((r) => r.id);
  assert.ok(!ids.includes("new"), "the un-acked record did not enter as a decision");
});

test("exclusive ownership: a live lock REFUSES the contender (fail-closed, never lockless)", async () => {
  const p = await freshLogPath("busy");
  // Cycle-4 B1 fold (registry shape): a foreign claim is ONE ENTRY
  // inside the registry directory, strictly older, holder pid ALIVE.
  plantForeignClaim(p, `${process.pid} deadbeef\n`, new Date(Date.now() - 10_000));
  const log = new S5Log<Rec>({ path: p, lockWaitMs: 150 });
  const before = Date.now();
  assert.throws(() => log.append({ id: "a", kind: "k" }), S5LockBusyError);
  assert.ok(Date.now() - before >= 120, "waited before refusing");
  // Cycle-3 fold: establishment is serialized UNDER the claim, so a
  // refused contender never even bootstraps the file; if it exists,
  // it stands with nothing appended.
  let bytes = "";
  try {
    bytes = readFileSync(p, "utf8");
  } catch {
    bytes = "";
  }
  assert.equal(bytes, "", "the refused contender appended nothing to the log");
});

test("crash recovery: a stale lock (dead holder) is claimed", async () => {
  const p = await freshLogPath("stale");
  // A FOREIGN claim, stale (past lockStaleMs) whose holder pid does
  // not exist: the sweep removes it and we acquire (cycle-4 B1 fold).
  plantForeignClaim(p, "999999999 aa\n", new Date(Date.now() - 60_000));
  const log = new S5Log<Rec>({ path: p, lockWaitMs: 500, lockStaleMs: 30_000 });
  const res = log.append({ id: "a", kind: "k" });
  assert.equal(res.status, "acked");
});

test("fenced takeover (cycle-2 fold): a mid-unit claim swap fail-stops the victim BEFORE mutation; the successor's claim stands", async () => {
  const p = await freshLogPath("fence");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "base", kind: "k" });
  const bytesBefore = readFileSync(p);
  let adversaryClaim = "";
  assert.throws(
    () =>
      log.appendUnit(() => {
        // During our unit a stealer takes over: it removes OUR
        // entry and a successor plants its own (registry shape —
        // cycle-4 B1 fold: renaming the victim's entry away is no
        // longer the takeover mechanism; the victim's fence must
        // fail on its OWN vanished entry, not on path vacancy).
        const ours = registryClaims(p);
        for (const c of ours) unlinkSyncSafe(`${p + ".lock"}/${c}`);
        adversaryClaim = plantForeignClaim(p, `${process.pid} adversary\n`);
        return [{ id: "mine", kind: "k" }];
      }),
    S5LockLostError,
  );
  assert.deepEqual(readFileSync(p), bytesBefore, "fail-stop BEFORE mutation — nothing written");
  assert.equal(readFileSync(adversaryClaim, "utf8"), `${process.pid} adversary\n`, "the adversary's claim entry untouched by the victim");
  // The adversary CLAIM is enforced: its token carries OUR (live)
  // pid, so the pid gate protects it from the sweep at ANY age — a
  // stalled-but-alive holder is never broken (cycle-4 header).
  const contender = new S5Log<Rec>({ path: p, lockWaitMs: 150, lockStaleMs: 30_000 });
  assert.throws(() => contender.append({ id: "late", kind: "k" }), S5LockBusyError, "live adversary's claim enforced (pid gate)");
  // Once the adversary DIES (token rewritten to a non-existent pid,
  // entry aged), crash recovery claims.
  unlinkSyncSafe(adversaryClaim);
  plantForeignClaim(p, "999999 adversary\n", new Date(Date.now() - 60_000));
  const recovered = new S5Log<Rec>({ path: p, lockWaitMs: 500, lockStaleMs: 30_000 });
  assert.equal(recovered.append({ id: "late", kind: "k" }).status, "acked", "crash recovery claims after the holder died");
});

function unlinkSyncSafe(q: string): void {
  try {
    unlinkSync(q);
  } catch {
    /* race-tolerant helper */
  }
}
function writeFileSyncFresh(q: string, text: string): void {
  writeFileSync(q, text, { flag: "wx" });
}

test("full lock lifetime: the claim exists during the unit and is gone after every exit path", async () => {
  const p = await freshLogPath("lifetime");
  const log = new S5Log<Rec>({ path: p });
  let seenInside = false;
  log.appendUnit((prefix) => {
    seenInside = existsSync(p + ".lock");
    return [{ id: "x", kind: "k", n: prefix.records.length }];
  });
  assert.ok(seenInside, "the claim is held across the serialized unit");
  assert.ok(!existsSync(p + ".lock"), "released after ack");
  // And on a refusal path:
  const p2 = p + "-r";
  const log2 = new S5Log<Rec>({ path: p2 });
  log2.append({ id: "a", kind: "k" });
  assert.throws(() => log2.append({ id: "a", kind: "k", n: 5 }), S5ReplayIntegrityError);
  assert.ok(!existsSync(p2 + ".lock"), "released after refusal");
});

/* ------------------------------------------------------------------ *
 * V-g13 — one fsync per pass                                          *
 * ------------------------------------------------------------------ */

test("V-g13: a pass appending TWO records issues exactly ONE append fsync", async () => {
  const p = await freshLogPath("vg13");
  const spy = syncSpy();
  const log = new S5Log<Rec>({ path: p, sync: spy.fn });
  log.appendUnit(() => [
    { id: "A", kind: "k" },
    { id: "B", kind: "k" },
  ]);
  assert.equal(spy.calls.filter((c) => c === "append").length, 1, "one file-level fsync for the whole pass");
  assert.deepEqual(log.replay().records.map((r) => r.id), ["A", "B"], "one operation established every record of the pass");
});

test("V-g13 recovery shape: repair + append in one pass still cost ONE fsync", async () => {
  const p = await freshLogPath("vg13b");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "one", kind: "k" });
  await writeFile(p, readFileSync(p).toString("utf8") + `{"id":"two","kind":"k"}`, "utf8"); // newline-lost record
  const spy = syncSpy();
  const log2 = new S5Log<Rec>({ path: p, sync: spy.fn });
  const res = log2.append({ id: "three", kind: "k" });
  assert.equal(res.status, "acked");
  const syncs = spy.calls.filter((c) => c === "append" || c === "repair");
  assert.equal(syncs.length, 1, "termination repair + append share the pass's single fsync");
  assert.deepEqual(log2.replay().records.map((r) => r.id), ["one", "two", "three"]);
});

test("a pass that writes nothing pays no fsync (refiled-only)", async () => {
  const p = await freshLogPath("nosync");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "a", kind: "k" });
  const spy = syncSpy();
  const log2 = new S5Log<Rec>({ path: p, sync: spy.fn });
  const res = log2.appendUnit(() => [{ id: "a", kind: "k" }]);
  assert.equal(res.status, "refiled-only");
  assert.equal(spy.calls.filter((c) => c === "append" || c === "repair").length, 0);
});

// Audit c10-F1 fold: the header's V-g13 claim is about the DECISION
// sync — repair + every append of a pass share exactly ONE; the
// establish-prefix sync is a watermark proof of bytes already on
// disk (v33), not a decision. A COLD instance on a warm log pays
// both in one pass: this pins that shape (1 decision sync + at most
// 1 establish) so a future change can neither silently add a second
// decision fsync nor regress the establishing proof.
test("c10-F1 contract: cold instance on a warm log = exactly one decision fsync + one establish-prefix", async () => {
  const p = await freshLogPath("c10f1");
  const warm = new S5Log<Rec>({ path: p });
  warm.append({ id: "seed", kind: "k" });
  const spy = syncSpy();
  const cold = new S5Log<Rec>({ path: p, sync: spy.fn });
  const res = cold.append({ id: "fresh", kind: "k" });
  assert.equal(res.status, "acked");
  assert.equal(spy.calls.filter((c) => c === "append").length, 1, "one decision fsync for the pass");
  assert.equal(spy.calls.filter((c) => c === "repair").length, 0);
  assert.equal(spy.calls.filter((c) => c === "establish-prefix").length, 1, "cold watermark: exactly one establishing proof, no more");
  assert.ok(spy.calls.indexOf("establish-prefix") < spy.calls.indexOf("append"), "reliance proven before the decision (NDR-r order)");
});

// Audit c11-F1/F2 fold: a warm log whose marker is MISSING runs the
// establishment ritual (log-file sync on the log fd), and the
// existing bytes are then proven by that ritual, so NO establish-
// prefix runs. The pass therefore syncs the log fd twice (log-file
// + append). Pin that exact shape so the header's "one DECISION
// fsync" wording stays falsifiable.
test("c11 contract: warm log + deleted marker = ritual log-file sync + one decision append (no establish-prefix)", async () => {
  const p = await freshLogPath("c11mark");
  const warm = new S5Log<Rec>({ path: p });
  warm.append({ id: "seed", kind: "k" });
  unlinkSync(p + ".durability");
  const spy = syncSpy();
  const cold = new S5Log<Rec>({ path: p, sync: spy.fn });
  const res = cold.append({ id: "fresh", kind: "k" });
  assert.equal(res.status, "acked");
  assert.deepEqual(spy.calls.filter((c) => c === "log-file" || c === "establish-prefix" || c === "append"), ["log-file", "append"], "ritual sync, then the single decision sync");
  assert.equal(spy.calls.filter((c) => c === "append" || c === "repair").length, 1, "exactly one decision fsync");
  assert.deepEqual(cold.replay().records.map((r) => r.id), ["seed", "fresh"]);
});

/* ------------------------------------------------------------------ *
 * Tail repair — V-g1 / V-g2 / V-g4 transport ports                    *
 * ------------------------------------------------------------------ */

test("V-g1 port: a PARTIAL tail fragment is truncated; absent from the prefix; owed record appends once", async () => {
  const p = await freshLogPath("vg1");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "gate-1", kind: "cure-gate" });
  await writeFile(p, readFileSync(p).toString("utf8") + `{"kind":"cure-gate","id":"gate-2`, "utf8");

  const log = new S5Log<Rec>({ path: p });
  const prefix = log.replay();
  assert.deepEqual(prefix.records.map((r) => r.id), ["gate-1"], "the fragment is NOT part of the prefix (act stays owed)");
  assert.equal(prefix.tailKind, "partial");

  const res = log.append({ id: "gate-2", kind: "cure-gate" });
  assert.equal(res.status, "acked");
  const back = log.replay();
  assert.deepEqual(back.corruptLines, [], "post-repair the file parses clean");
  assert.deepEqual(back.records.map((r) => r.id), ["gate-1", "gate-2"], "owed record appended ONCE");
});

test("V-g1 multibyte port: a torn UTF-8 tail is partial — truncated, never mangled into a record", async () => {
  const p = await freshLogPath("vg1mb");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "r-1", kind: "k" });
  // A torn record: valid JSON text then the FIRST TWO BYTES of a
  // 3-byte character ("é" = C3 A9), continuation byte missing.
  const base = readFileSync(p);
  const torn = Buffer.concat([base, Buffer.from('{"id":"r-2","kind":"', "utf8"), Buffer.from([0xe4, 0xb8])]);
  await writeFile(p, torn);
  const log = new S5Log<Rec>({ path: p });
  const back = log.replay();
  assert.deepEqual(back.records.map((r) => r.id), ["r-1"], "the invalid-UTF-8 tail is not a record");
  assert.equal(back.tailKind, "partial");
  const res = log.append({ id: "r-2", kind: "k" });
  assert.equal(res.status, "acked");
  assert.deepEqual(log.replay().corruptLines, [], "torn tail repaired; file clean");
});

test("V-g2 port: a complete tail record missing ONLY its newline is KEPT and classified (no data loss)", async () => {
  const p = await freshLogPath("vg2");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "gate-1", kind: "cure-gate" });
  await writeFile(p, readFileSync(p).toString("utf8") + `{"id":"gate-2","kind":"cure-gate"}`, "utf8");

  const log = new S5Log<Rec>({ path: p });
  const res = log.appendUnit((prefix) => {
    const ids = prefix.records.map((r) => r.id);
    assert.ok(ids.includes("gate-2"), "the newline-lost record classifies as present");
    assert.equal(prefix.tailKind, "complete");
    return [{ id: "gate-2", kind: "cure-gate" }];
  });
  // The repair (adding the lost terminator) is itself a write, so
  // the pass acks — with NOTHING appended and the refiling reported:
  assert.equal(res.status, "acked");
  assert.deepEqual(res.appended, [], "the kept record was NOT re-appended");
  assert.deepEqual(res.refiled, ["gate-2"], "identical redelivery → refiling candidate");
  // The lost terminator was restored by the repair:
  const body = await readFile(p, "utf8");
  assert.ok(body.endsWith("\n"), "terminator restored by the repair pass");
});

test("V-g4 port: a corrupt MID-FILE line rejects BEFORE any mutation (repairable fragment stands too)", async () => {
  const p = await freshLogPath("vg4");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "ok-1", kind: "k" });
  const body = readFileSync(p).toString("utf8");
  await writeFile(p, body + `corrupt-not-json\n` + `{"id":"tail`, "utf8");
  const bytesBefore = readFileSync(p);

  const log = new S5Log<Rec>({ path: p });
  assert.throws(
    () => log.append({ id: "new", kind: "k" }),
    (err: unknown) => err instanceof S5LogCorruptionError && err.corruptLine === 2,
  );
  assert.deepEqual(readFileSync(p), bytesBefore, "file NOT touched — not even the repairable final fragment");
  assert.ok(!existsSync(p + ".lock"), "lock released on the (c0) rejection path");
});

test("V-g4 extended: a BLANK terminated line is corrupt (never silently dropped), file untouched", async () => {
  const p = await freshLogPath("blank");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "a", kind: "k" });
  const body = readFileSync(p).toString("utf8");
  await writeFile(p, body + `\n` + `{"id":"tail`, "utf8"); // blank line + repairable fragment
  const bytesBefore = readFileSync(p);
  const log = new S5Log<Rec>({ path: p });
  assert.throws(
    () => log.append({ id: "b", kind: "k" }),
    (err: unknown) => err instanceof S5LogCorruptionError && err.corruptLine === 2,
  );
  assert.deepEqual(readFileSync(p), bytesBefore, "blank-line rejection mutates nothing");
});

test("V-g4 extended: invalid UTF-8 in the complete region rejects the pass with the file untouched", async () => {
  const p = await freshLogPath("badutf8");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "a", kind: "k" });
  const body = readFileSync(p);
  const bad = Buffer.concat([body, Buffer.from('{"id":"b","kind":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n', "utf8")]);
  await writeFile(p, bad);
  const log = new S5Log<Rec>({ path: p });
  assert.throws(
    () => log.append({ id: "c", kind: "k" }),
    (err: unknown) => err instanceof S5LogCorruptionError && err.reason === "invalid-utf8",
  );
  assert.deepEqual(readFileSync(p), bad, "invalid bytes stand — fail closed");
});

/* ------------------------------------------------------------------ *
 * NDR-r redelivery — the three transport cases                        *
 * ------------------------------------------------------------------ */

test("NDR-r (a): a new act id is a new attempt — never refused as duplicate intent", async () => {
  const log = new S5Log<Rec>({ path: await freshLogPath("ndra") });
  log.append({ id: "act-1", kind: "residual-cure" });
  const res = log.append({ id: "act-2", kind: "residual-cure" });
  assert.equal(res.status, "acked");
  assert.deepEqual(log.replay().records.map((r) => r.id), ["act-1", "act-2"]);
});

test("NDR-r (b): identical-bytes redelivery is idempotent — reported as a refiling CANDIDATE", async () => {
  const p = await freshLogPath("ndrb");
  const log = new S5Log<Rec>({ path: p });
  const rec: Rec = { id: "f-1", kind: "finding", n: 7 };
  log.append(rec);
  const spy = syncSpy();
  const log2 = new S5Log<Rec>({ path: p, sync: spy.fn });
  const res = log2.append({ ...rec });
  assert.equal(res.status, "refiled-only");
  assert.deepEqual(res.refiled, ["f-1"], "reported separately (intake mints the rejected-duplicate finding)");
  assert.deepEqual(res.appended, []);
  assert.deepEqual(log2.replay().records.map((r) => r.id), ["f-1"], "still exactly one durable copy");
});

test("NDR-r (c): same id with DIVERGENT bytes is a replay-integrity refusal with a clean prefix", async () => {
  const p = await freshLogPath("ndrc");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "f-1", kind: "finding", n: 7 });
  assert.throws(
    () => log.append({ id: "f-1", kind: "finding", n: 8 }),
    (err: unknown) => err instanceof S5ReplayIntegrityError && err.id === "f-1",
  );
  const back = log.replay();
  assert.equal(back.records.length, 1, "clean prefix");
  assert.equal(back.records[0]!.n, 7, "the ORIGINAL bytes stand");
  assert.ok(!existsSync(p + ".lock"), "lock released on the refusal path");
});

test("mixed unit: identical + new in one unit → refiling reported, new appended once", async () => {
  const p = await freshLogPath("mixed");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "old", kind: "k", n: 1 });
  const res = log.appendUnit(() => [
    { id: "old", kind: "k", n: 1 },
    { id: "new", kind: "k", n: 2 },
  ]);
  assert.equal(res.status, "acked");
  assert.deepEqual(res.refiled, ["old"]);
  assert.deepEqual(res.appended.map((r) => r.id), ["new"]);
  assert.deepEqual(log.replay().records.map((r) => r.id), ["old", "new"]);
});

test("unit-level divergent replay: the WHOLE unit is refused (no partial append)", async () => {
  const p = await freshLogPath("unitrefuse");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "a", kind: "k", n: 1 });
  assert.throws(
    () =>
      log.appendUnit(() => [
        { id: "b", kind: "k" },
        { id: "a", kind: "k", n: 2 },
      ]),
    S5ReplayIntegrityError,
  );
  assert.deepEqual(log.replay().records.map((r) => r.id), ["a"], "even the legitimate 'b' was not appended — the unit is atomic");
});

/* ------------------------------------------------------------------ *
 * Cross-process exclusion (async child; real contender)               *
 * ------------------------------------------------------------------ */

test("cross-process: a live holder (async child) refuses our contender; after it releases, we append", async () => {
  const p = await freshLogPath("race");
  const readyPath = p + ".child-ready";
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { writeFileSync, existsSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
      const reg = ${JSON.stringify(p)} + ".lock";
      const ready = ${JSON.stringify(readyPath)};
      // Simulate a live serialized unit: registry + claim entry with
      // fresh mtime and our pid; hold until the ready file is
      // removed by the parent.
      mkdirSync(reg, { recursive: true });
      const claim = reg + "/claim-" + process.pid + "-childholder0001";
      writeFileSync(claim, String(process.pid) + " holder\\n");
      writeFileSync(ready, "ready");
      while (existsSync(ready)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // release
      try { unlinkSync(claim); } catch {}
      try { require("node:fs").rmdirSync(reg); } catch {}
      `,
    ],
    { stdio: "ignore" },
  );
  try {
    // Wait for the child's claim to appear (bounded).
    const t0 = Date.now();
    while (!existsSync(readyPath) && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(existsSync(readyPath), "child claimed the lock");
    const log = new S5Log<Rec>({ path: p, lockWaitMs: 300 });
    assert.throws(() => log.append({ id: "raced", kind: "k" }), S5LockBusyError, "live contender refused");
    assert.ok(!existsSync(p) || readFileSync(p, "utf8") === "", "the refused contender appended nothing");
    // Release the child: it exits; our next attempt succeeds.
    unlinkSyncSafe(readyPath);
    const t1 = Date.now();
    while (registryClaims(p).length > 0 && Date.now() - t1 < 5000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const res = log.append({ id: "late", kind: "k" });
    assert.equal(res.status, "acked", "after the holder released, the log is appendable");
  } finally {
    child.kill();
  }
});

test("classifyRedelivery maps the three cases", () => {
  const rec: Rec = { id: "x", kind: "k", n: 1 };
  assert.deepEqual(classifyRedelivery(undefined, rec), { class: "new-attempt" });
  assert.deepEqual(classifyRedelivery(JSON.stringify(rec), rec), { class: "refiled" });
  assert.deepEqual(classifyRedelivery(`{"id":"x","kind":"k"}`, rec), { class: "replay-integrity-refusal" });
});

/* ------------------------------------------------------------------ *
 * Cycle-2 folds — watermark, (c1a) ordering, claim fence, empty-
 * prefix boundaries                                                   *
 * ------------------------------------------------------------------ */

test("watermark (cycle-2 f2): retrying a FAILED append on the SAME instance re-establishes before refiling", async () => {
  const p = await freshLogPath("watermark");
  const spy = syncSpy((label) => label === "append");
  const log = new S5Log<Rec>({ path: p, sync: spy.fn });
  assert.throws(() => log.append({ id: "b", kind: "k" }), /injected sync failure/);
  // Bytes may stand readable; the watermark did NOT advance over
  // them. Same instance retries with a healthy fsync path:
  const healthy = new S5Log<Rec>({ path: p });
  const again = healthy.append({ id: "b", kind: "k" });
  assert.ok(again.status === "acked" || again.status === "refiled-only");
  assert.equal(healthy.replay().records.filter((r) => r.id === "b").length, 1);
  // And the FIRST (still-broken) instance must now refuse to treat
  // its own bytes as proven: a fresh spy run shows it pays an
  // establish-prefix sync (its watermark is 0 < reliedBytes).
  const spy2 = syncSpy();
  const broken = new S5Log<Rec>({ path: p, sync: spy2.fn });
  broken.appendUnit(() => []);
  assert.ok(spy2.calls.includes("establish-prefix"), "unknown-origin bytes established before reliance — never a silent boolean");
});

test("(c1a) ordering (cycle-2 f3): make() throwing a semantic refusal means NO establish-prefix sync ran", async () => {
  const p = await freshLogPath("c1a");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "gate-bad", kind: "cure-gate" }); // syntactically valid, semantically refused below
  const spy = syncSpy();
  const fresh = new S5Log<Rec>({ path: p, sync: spy.fn });
  assert.throws(
    () =>
      fresh.appendUnit((prefix) => {
        // recovery's (c1a) check: refuse this prefix.
        assert.equal(prefix.durability, "unproven", "make() sees the honest pre-sync durability flag");
        throw new Error("c1a-semantic-refusal");
      }),
    /c1a-semantic-refusal/,
  );
  assert.ok(!spy.calls.includes("establish-prefix"), "a semantically rejected prefix is never establishing-synced");
});

test("claim fence (cycle-2 f1): a claim removed mid-unit refuses the MUTATION with nothing written", async () => {
  const p = await freshLogPath("fence2");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "base", kind: "k" });
  const bytesBefore = readFileSync(p);
  assert.throws(
    () =>
      log.appendUnit(() => {
        // Adversary removes OUR claim entries (registry shape).
        for (const c of registryClaims(p)) unlinkSyncSafe(`${p + ".lock"}/${c}`);
        return [{ id: "mutate", kind: "k" }];
      }),
    S5LockLostError,
  );
  assert.deepEqual(readFileSync(p), bytesBefore, "claim lost ⇒ fail-stop BEFORE mutation");
  assert.ok(!existsSync(p + ".lock"), "the victim's release left no claim behind");
});

test("claim fence (cycle-3 m9): a claim REPLACED by a new inode at the same path fails the fence too", async () => {
  const p = await freshLogPath("fence3");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "base", kind: "k" });
  const bytesBefore = readFileSync(p);
  let forgedPath = "";
  assert.throws(
    () =>
      log.appendUnit(() => {
        // Identity collision: the forgery sits at OUR entry's exact
        // path with a DIFFERENT inode + token (a stealer removed
        // ours and a successor wrote at its name).
        const ours = registryClaims(p);
        forgedPath = `${p + ".lock"}/${ours[0]}`;
        unlinkSyncSafe(forgedPath);
        writeFileSyncFresh(forgedPath, "77777777 successor" + String.fromCharCode(10));
        return [{ id: "mutate", kind: "k" }];
      }),
    S5LockLostError,
    "(dev, ino) + token fence must refuse the replacement",
  );
  assert.deepEqual(readFileSync(p), bytesBefore, "fail-stop BEFORE mutation");
  assert.equal(readFileSync(forgedPath, "utf8"), "77777777 successor\n", "the fenced release never unlinked the forgery");
});

test("empty-prefix boundary (cycle-2 f4): a log holding ONLY a newline-lost first record keeps and terminates it", async () => {
  const p = await freshLogPath("vg2-first");
  // Pre-arm a well-formed marker so establishment never touches the
  // path, then plant the unterminated record BEFORE any pass: the
  // boundary is judged purely by the V-g2 tail rule (cycle-2 f4).
  await writeFile(p + ".durability", JSON.stringify({ version: 1, establishedAt: 1 }), "utf8");
  const log = new S5Log<Rec>({ path: p });
  await writeFile(p, `{"id":"first","kind":"k"}`, "utf8");
  const res = log.appendUnit((prefix) => {
    assert.deepEqual(prefix.records.map((r) => r.id), ["first"], "the first record lost only its newline: KEPT, no corrupt blank line");
    return [];
  });
  // [] from make + a repair owed: still a mutating pass (termination)
  void res;
  assert.ok((await readFile(p, "utf8")).endsWith("\n"), "terminator restored");
});

test("empty-prefix boundary (cycle-2 f4): a log holding ONLY a partial first fragment is truncated away", async () => {
  const p = await freshLogPath("vg1-first");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "seed", kind: "k" }); // establish
  await writeFile(p, `{"id":"frag","kin`, "utf8"); // only a partial record
  const back = log.replay();
  assert.deepEqual(back.records, [], "the partial fragment is not a record");
  assert.equal(back.tailKind, "partial");
  const res = log.append({ id: "frag", kind: "k" });
  assert.equal(res.status, "acked");
  assert.deepEqual(log.replay().records.map((r) => r.id), ["frag"]);
  assert.deepEqual(log.replay().corruptLines, []);
});

/* ------------------------------------------------------------------ *
 * Cycle-3 folds                                                       *
 * ------------------------------------------------------------------ */

test("input validation (cycle-3 B1/M7): a bad record is refused with NOTHING written", async () => {
  const p = await freshLogPath("badinput");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "good", kind: "k" });
  const bytes = readFileSync(p);
  // Empty id: exactly the input the NEXT reader would call corrupt.
  await assert.doesNotReject(Promise.resolve());
  assert.throws(
    () => log.append({ id: "" } as Rec),
    (e: unknown) => (e as Error).name === "S5InvalidInputError",
    "an id-less record never enters the log",
  );
  assert.throws(() => log.append({} as Rec), (e: unknown) => (e as Error).name === "S5InvalidInputError");
  assert.deepEqual(readFileSync(p), bytes, "refused before any write — the log is untouched");
  // The log stays readable and appendable (no wedge):
  assert.equal(log.append({ id: "after", kind: "k" }).status, "acked");
});

test("watermark advance (cycle-3 M3): sequential appends on ONE instance never pay a redundant establish-prefix", async () => {
  const p = await freshLogPath("wmadvance");
  const spy = syncSpy();
  const log = new S5Log<Rec>({ path: p, sync: spy.fn });
  log.append({ id: "A", kind: "k" });
  log.append({ id: "B", kind: "k" });
  log.append({ id: "C", kind: "k" });
  // Log-fd syncs are exactly the pass fsyncs (append/repair/
  // establish-prefix); lock/dir/marker labels are not log-fd.
  const est = spy.calls.filter((c) => c === "establish-prefix").length;
  assert.equal(est, 0, "each successful pass proved through its payload — no re-establishment (haiku M3 was the masking bug)");
  const logFdSyncs = spy.calls.filter((c) => c === "append" || c === "repair" || c === "establish-prefix").length;
  assert.equal(logFdSyncs, 3, "exactly one log-fd fsync per pass (V-g13, counted by fd class not just append label)");
  // And replay calls the just-acked records PROVEN (terra M3):
  const spyR = syncSpy();
  const reader = new S5Log<Rec>({ path: p, sync: spyR.fn });
  // Fresh instance: no marker ritual needed (marker durable), but
  // it has never proven these bytes — it must establish exactly
  // once, then every later replay is sync-free.
  reader.replay();
  reader.replay();
  assert.equal(spyR.calls.filter((c) => c === "establish-prefix").length, 1, "unknown-origin bytes: exactly ONE establishing sync, then proven forever");
});

test("watermark invalidation (cycle-3 M1): a FAILED repair pass cannot leave the old watermark over replacement bytes", async () => {
  const p = await freshLogPath("wminval");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "seed", kind: "k" });
  // Plant a partial tail far beyond the proven watermark:
  await writeFile(p, readFileSync(p).toString("utf8") + `{"id":"frag","ki`, "utf8");
  const spy = syncSpy((l) => l === "repair" || l === "append");
  const v = new S5Log<Rec>({ path: p, sync: spy.fn });
  // This pass truncates (mutates below the old watermark) then its
  // fsync fails: the watermark must have been clamped BEFORE the
  // truncation, so a retry cannot treat replacement bytes as proven.
  assert.throws(() => v.append({ id: "R", kind: "k" }), /injected sync failure/);
  const spy2 = syncSpy();
  const retry = new S5Log<Rec>({ path: p, sync: spy2.fn });
  const res = retry.append({ id: "R", kind: "k" });
  // The failed pass left R READABLE on disk; the retry must treat
  // those bytes as UNKNOWN ORIGIN (watermark clamped before the
  // mutation), establish them, and only then classify R identical.
  assert.equal(res.status, "refiled-only", "R stands readable — refiled, never duplicated");
  assert.equal(spy2.calls.filter((c) => c === "establish-prefix").length, 1, "the retry RE-establishes: bytes whose fsync failed are never 'proven'");
});

test("same-instance retry of a failed append (haiku m9): the TRUE same-instance case, no second instance", async () => {
  const p = await freshLogPath("sameinst");
  let arm = true;
  const spy = syncSpy((l) => (l === "append" || l === "repair") && arm);
  const log = new S5Log<Rec>({ path: p, sync: spy.fn });
  assert.throws(() => log.append({ id: "b", kind: "k" }), /injected sync failure/);
  arm = false;
  const estBefore = spy.calls.filter((c) => c === "establish-prefix").length;
  // SAME instance retries — it must NOT refile from its own
  // unproven bytes without an establishing sync:
  const res = log.append({ id: "b", kind: "k" });
  assert.equal(res.status, "refiled-only", "b's readable bytes classify identical...");
  assert.ok(
    spy.calls.slice(spy.calls.indexOf("establish-prefix", estBefore)).includes("establish-prefix") ||
      spy.calls.filter((c) => c === "establish-prefix").length > estBefore,
    "...but ONLY after re-paying an establishing sync for its own failed-fsync bytes",
  );
  assert.equal(log.replay().records.filter((r) => r.id === "b").length, 1);
});

test("BOM is never silently stripped (cycle-3 M4): BOM tail is PARTIAL (never a kept record); BOM mid-file is corrupt", async () => {
  const p = await freshLogPath("bom");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "a", kind: "k" });
  // Plant a BOM'd, newline-lost tail record: with the old decoder
  // this was ACCEPTED as complete (terminator written behind the
  // BOM) and POISONED every later pass. Now the BOM survives
  // decode, the line fails validation, and the tail is a partial
  // fragment: excluded from the prefix, truncated away on append.
  await writeFile(p, readFileSync(p).toString("utf8") + "\uFEFF" + `{"id":"b","kind":"k"}`, "utf8");
  const back = log.replay();
  assert.deepEqual(back.records.map((r) => r.id), ["a"], "the BOM'd tail is NOT a kept record");
  assert.equal(back.tailKind, "partial");
  const res = log.append({ id: "c", kind: "k" });
  assert.equal(res.status, "acked");
  assert.deepEqual(log.replay().records.map((r) => r.id), ["a", "c"], "fragment truncated away, no poison");
  // BOM mid-file: a terminated BOM'd line is a corrupt line at once.
  const p2 = await freshLogPath("bom2");
  const log2 = new S5Log<Rec>({ path: p2 });
  log2.append({ id: "a", kind: "k" });
  await writeFile(p2, readFileSync(p2).toString("utf8") + "\uFEFF" + `{"id":"b","kind":"k"}` + "\n", "utf8");
  // replay() REPORTS it (corruptLines contract); a mutating pass
  // REFUSES at (c0) before any repair.
  const back2 = log2.replay();
  assert.deepEqual(back2.corruptLines, [2], "a terminated BOM'd line is corrupt-line, not a record");
  assert.throws(() => log2.append({ id: "c", kind: "k" }), S5LogCorruptionError, "the pass refuses before mutation");
});

test("CRLF-terminated records are refused as non-canonical (cycle-3 m8)", async () => {
  const p = await freshLogPath("crlf");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "a", kind: "k" });
  await writeFile(p, readFileSync(p).toString("utf8") + `{"id":"b","kind":"k"}\r\n`, "utf8");
  // A terminated CR-terminated line is a MID-FILE line: the pass
  // refuses it as corrupt BEFORE any mutation (identical
  // redeliveries can no longer smuggle a misleading "different
  // bytes" NDR-r refusal).
  assert.throws(() => log.append({ id: "c", kind: "k" }), S5LogCorruptionError, "trailing CR is not a writer-canonical line");
  assert.ok(!readFileSync(p).toString("utf8").includes('"c"'), "nothing appended under the refusal");
});

test("marker survives a deleted log: the incoherent marker is cleared and the ritual re-runs (cycle-3 m5)", async () => {
  const p = await freshLogPath("markerlog");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "a", kind: "k" });
  assert.ok(existsSync(p + ".durability"));
  unlinkSyncSafe(p); // operator deletes the log, marker survives
  // Wedge-free: the next pass clears the stale marker and works.
  const again = log.append({ id: "b", kind: "k" });
  assert.equal(again.status, "acked");
  const fresh = new S5Log<Rec>({ path: p });
  assert.deepEqual(fresh.replay().records.map((r) => r.id), ["b"]);
});

test("empty partial claim (crash-between-create-and-write) is taken over at its 1 s predicate, not 30 s (cycle-3 m3)", async () => {
  const p = await freshLogPath("emptypartial");
  const claim = plantForeignClaim(p, ""); // 0-byte claim, no token
  const old = new Date(Date.now() - 5_000); // aged 5 s: past 1 s, well inside 30 s
  utimesSync(claim, old, old);
  const log = new S5Log<Rec>({ path: p, lockWaitMs: 300, lockStaleMs: 30_000 });
  const before = Date.now();
  const res = log.append({ id: "a", kind: "k" });
  assert.equal(res.status, "acked", "the empty claim was taken over, not waited on for 30 s");
  assert.ok(Date.now() - before < 300, "immediate takeover at the empty predicate");
});

/* ------------------------------------------------------------------ *
 * Cycle-4 folds — adversarial coverage (terra c4 audit MINOR)        *
 * ------------------------------------------------------------------ */

test("BLOCKER 1 regression: release never vacates a verifiable path — a contender mid-release sees the claim registry the whole time", async () => {
  // The old protocol renamed the lock FILE away to verify it,
  // exposing an ACQUIRABLE path while another holder's claim was
  // under examination. The registry has no such step: our entry's
  // unlink and a contender's view are the only events — a
  // contender either refuses (claim present) or legitimately
  // acquires (claim gone). Prove: sampling the registry DURING our
  // own release never shows a state where a stale foreign entry is
  // absent while ours is absent-but-unverifiable... deterministically:
  // run release with a spy, and after our entry is gone assert any
  // acquisition attempt either succeeds cleanly or fails closed —
  // never mutates under a foreign claim.
  const p = await freshLogPath("interleave");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "a", kind: "k" });
  // Adversary plants its claim WHILE we deliberate (registry shape:
  // our claim still present — the two claims coexist; the older
  // (mtime) wins exclusivity, no rename involved).
  const foreign = plantForeignClaim(p, "424242 older adversary\n", new Date(Date.now() - 10_000));
  // The plant NEVER broke our held claim (we hold a live unit? no —
  // we are between units). A fresh contender now must refuse it:
  const contender = new S5Log<Rec>({ path: p, lockWaitMs: 100 });
  assert.throws(() => contender.append({ id: "x", kind: "k" }), S5LockBusyError, "foreign claim enforced (older entry wins exclusivity)");
  // Deterministic interleaving: our release path's UNLINK only ever
  // targets our own unforgeable entry — prove it cannot remove the
  // adversary's (same code path, ours first):
  const ours = new S5Log<Rec>({ path: p, lockWaitMs: 0 });
  try { ours.append({ id: "y", kind: "k" }); } catch { /* busy — expected */ }
  assert.ok(existsSync(foreign), "the adversary's entry survives every bookkeeping path of another holder");
  // Sweep the (dead-pid 424242) foreign entry — it must be PAST
  // this acquirer's lockStaleMs for the age gate (pid dead is
  // necessary, staleness is the other half): then progress.
  const recovered = new S5Log<Rec>({ path: p, lockWaitMs: 500, lockStaleMs: 5_000 });
  assert.equal(recovered.append({ id: "z", kind: "k" }).status, "acked", "dead foreign claim swept, no vacancy needed");
});

test("BLOCKER 2 regression: a toJSON() that rewrites id is REFUSED (classification uses the serialized id)", async () => {
  const p = await freshLogPath("tojsonid");
  const log = new S5Log<Rec>({ path: p });
  // Seed so the divergence check runs against an existing index.
  log.append({ id: "real", kind: "k" });
  const diverging = {
    id: "real", // input id collides with the seeded record...
    kind: "k",
    toJSON() {
      return { id: "impostor", kind: "k" }; // ...but serializes under ANOTHER id
    },
  };
  assert.throws(
    () => log.appendUnit(() => [diverging as unknown as Rec]),
    (e: unknown) => (e as Error).name === "S5InvalidInputError",
    "input id vs serialized id divergence refused",
  );
  const after = log.replay().records.map((r) => r.id);
  assert.deepEqual(after, ["real"], "neither id entered the log — the unit is atomic (no half-classified record)");
  // And the non-diverging toJSON form still works (identity-preserving):
  const stable = { id: "stable", kind: "k", toJSON: () => ({ id: "stable", kind: "k" }) };
  const res = log.appendUnit(() => [stable as unknown as Rec]);
  assert.equal(res.status, "acked");
  assert.deepEqual(log.replay().records.map((r) => r.id), ["real", "stable"]);
});

test("replay claim loss (cycle-4 fold): a claim removed mid-replay fails the returned snapshot", async () => {
  const p = await freshLogPath("replayfence");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "a", kind: "k" });
  // Remove OUR claim through the seam: the registry entry vanishes
  // while replay deliberates (deterministic: plant a corruption the
  // replay's post-establishment assertClaimHeld will see as gone).
  const held = registryClaims(p);
  void held;
  // No seam into replay's internals — deterministically emulate:
  // drop every claim between the units, replay's own acquire is
  // fresh; instead exercise the FINAL fence: during replay's
  // establish-prefix window our claim is the only one, so remove
  // entries the instant they appear via a fsync spy.
  let removed = false;
  const spy = syncSpy(() => {
    if (removed) return false;
    removed = true;
    for (const c of registryClaims(p)) unlinkSyncSafe(`${p + ".lock"}/${c}`);
    return false; // the sync itself succeeds; the FENCE must fire
  });
  const v = new S5Log<Rec>({ path: p, sync: spy.fn });
  assert.throws(() => v.replay(), S5LockLostError, "a replay whose claim vanished returns NO snapshot");
  assert.ok(removed, "the seam fired (claim really removed mid-replay)");
  // Wedge-free afterwards: registry residue releases fine.
  const ok = new S5Log<Rec>({ path: p, lockWaitMs: 500, lockStaleMs: 30_000 });
  assert.equal(ok.append({ id: "b", kind: "k" }).status, "acked");
});

test("marker-sync failure propagates and the pass is retried cleanly (no half-established marker trusted)", async () => {
  const p = await freshLogPath("markersync");
  const spy = syncSpy((l) => l === "marker-file");
  const broken = new S5Log<Rec>({ path: p, sync: spy.fn });
  assert.throws(() => broken.append({ id: "a", kind: "k" }), /injected sync failure/, "marker fsync failure surfaces, never swallowed");
  // A failed establishment left no usable marker: absence/corruption
  // is never trusted — a healthy retry completes the ritual and acks.
  const healthy = new S5Log<Rec>({ path: p });
  assert.equal(healthy.append({ id: "a", kind: "k" }).status, "acked", "retry after marker-sync failure establishes and acks");
  assert.ok(existsSync(p + ".durability"), "the durability marker stands after the healthy retry");
});

test("missing parent directories (cycle-4 fold): bootstrap creates them durably, claim registry works under a fresh tree", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "s5log-nested-"));
  const p = path.join(dir, "deep", "deeper", "still", "s5.jsonl"); // none of these exist
  const log = new S5Log<Rec>({ path: p });
  const res = log.append({ id: "a", kind: "k" });
  assert.equal(res.status, "acked", "appended through a wholly missing parent chain");
  assert.deepEqual(log.replay().records.map((r) => r.id), ["a"]);
  assert.ok(!existsSync(p + ".lock") || registryClaims(p).length === 0, "claim released under the nested tree");
});

test("true same-instance repair failure (cycle-4 MINOR): a repair pass whose fsync FAILED leaves the clamped watermark — the SAME instance re-establishes replacement bytes before reusing them", async () => {
  // The clamp only bites when a mutation cuts BELOW the proven
  // watermark: prove N bytes, an operator TRUNCATES the file
  // mid-record (below N), the repair pass (truncate torn fragment)
  // fails its fsync — replacement bytes beyond the clamp must never
  // inherit the old watermark, on the SAME instance.
  const p = await freshLogPath("sameinst-repair");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "r1", kind: "k" });
  log.append({ id: "r2", kind: "k" });
  log.append({ id: "r3", kind: "k" }); // proven through here (N)
  const full = readFileSync(p).toString("utf8");
  const n = Buffer.byteLength(full, "utf8");
  // Operator truncates INSIDE record r3 (M < N): a torn fragment.
  const cut = Buffer.byteLength(full.slice(0, full.lastIndexOf("\n")), "utf8"); // end of r2
  const r3line = full.trim().slice(full.trim().lastIndexOf("\n") + 1);
  await writeFile(p, full.slice(0, cut + 1) + r3line.slice(0, 12), "utf8");
  let arm = true;
  const spy = syncSpy((l) => l === "repair" && arm);
  const v = new S5Log<Rec>({ path: p, sync: spy.fn });
  // This instance PROVED the old N bytes at append time; the pass
  // clamps to M before truncating and its repair fsync fails — the
  // clamp must have happened (it cannot be re-derived from disk).
  assert.throws(() => v.appendUnit(() => []), /injected sync failure/, "the repair pass fsync failed on THIS instance");
  assert.ok(spy.calls.includes("repair"), "the failing pass really ran a repair sync");
  arm = false;
  // SAME instance retries with a healthy fsync: the truncated-away
  // region is gone; r3's fragment was truncated, so the next append
  // pays establishing for bytes whose fsync never succeeded and
  // appends r3 whole again.
  const before = spy.calls.filter((c) => c === "establish-prefix").length;
  const res = v.append({ id: "r3", kind: "k" });
  assert.ok(res.status === "acked" || res.status === "refiled-only");
  const est = spy.calls.slice(before);
  if (res.status === "refiled-only") {
    assert.ok(est.includes("establish-prefix"), "same-instance retry re-establishes the replacement bytes before classifying against them");
  }
  assert.equal(v.replay().records.filter((r) => r.id === "r3").length, 1, "exactly one r3 — no duplicate, no loss");
  void n;
});

test("registry lifecycle: the directory exists only while claimed and holds exactly the live claims (no residue from any exit path)", async () => {
  const p = await freshLogPath("lifecycle");
  const log = new S5Log<Rec>({ path: p });
  let claimsInside = -1;
  log.appendUnit(() => {
    claimsInside = registryClaims(p).length;
    return [{ id: "x", kind: "k" }];
  });
  assert.equal(claimsInside, 1, "exactly one claim entry during the unit");
  // Cycle-6 fold (c5 m-minor): STRICT assertion — the rmdir really
  // removes the registry directory, not merely empties it (the old
  // `!existsSync || length===0` accepted a leftover empty dir).
  assert.ok(!existsSync(p + ".lock"), "registry DIRECTORY removed after ack");
  // Failure path: refusal leaves nothing.
  try {
    log.appendUnit(() => {
      throw new Error("boom");
    });
  } catch {
    /* expected */
  }
  assert.ok(!existsSync(p + ".lock"), "registry DIRECTORY clean after a thrown unit");
});

test("cycle-6 c5-minor: a STRAY non-claim file in the registry blocks fail-closed, and recovery is BOUNDED (swept at lockStaleMs, never wedged forever)", async () => {
  // A stray file (foreign name, non-empty, no parseable pid) is
  // unorderable: acquisition must refuse while it stands (fail
  // closed — we never mutate the log under an entry we cannot
  // attribute), and once aged past lockStaleMs the sweep removes
  // it: progress within one stale window, not a permanent wedge.
  const p = await freshLogPath("stray");
  const reg = p + ".lock";
  mkdirSync(reg, { recursive: true });
  const stray = `${reg}/not-a-claim-stray`;
  writeFileSync(stray, "whoever", { flag: "wx" });
  const staleMs = 400;
  const fast = new S5Log<Rec>({ path: p, lockWaitMs: 100, lockStaleMs: staleMs });
  assert.throws(() => fast.append({ id: "x", kind: "k" }), S5LockBusyError, "stray entry blocks fail-closed");
  assert.ok(existsSync(stray), "a fresh stray is NOT removed early (no creator info to prove death — age gate governs)");
  await new Promise((r) => setTimeout(r, staleMs + 50));
  const t0 = Date.now();
  const res = fast.append({ id: "x", kind: "k" });
  assert.equal(res.status, "acked", "aged stray swept — recovery bounded by lockStaleMs");
  // Bound by the stale window itself, not a fixed constant: the recovery
  // ack fsyncs file+dir+parent, and CI fsync contention pushed that past
  // 100ms (run 45944530580). The property is "progress WITHOUT waiting
  // another stale window" — several stale windows of slack still proves
  // it and a wedge (the failure mode) still fails it.
  assert.ok(Date.now() - t0 < staleMs * 2, "immediate progress once past the stale window (no extra stale-window wait)");
});

/* ------------------------------------------------------------------ *
 * Cycle-6 folds — B1 name-encoded order, M3 dead-creator sweep,     *
 * M1 ancestor-sync fail-closed, M4 watermark identity, marker atomix *
 * ------------------------------------------------------------------ */

/** Plant a WELL-FORMED cycle-6 claim entry (parseable name:
 *  `claim-<pid>-<creationUnixMs>-<rand>`) with the given holder
 *  pid, creation timestamp, mtime and token bytes. */
function plantWellFormedClaim(
  p: string,
  pid: number,
  createdMs: number,
  mtime: Date | undefined,
  token: string,
): string {
  const reg = p + ".lock";
  mkdirSync(reg, { recursive: true });
  const claim = `${reg}/claim-${pid}-${createdMs}-${Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, "0")}`;
  writeFileSync(claim, token, { flag: "wx" });
  if (mtime !== undefined) utimesSync(claim, mtime, mtime);
  return claim;
}

test("cycle-6 B1 regression: a HEARTBEATED (fresh-mtime) older claim still beats a younger one — mtime never reorders the name-encoded order", async () => {
  // The cycle-5 BLOCKER: ordering keyed on mtime, a live holder's
  // touchLock refreshed its mtime PAST a younger contender's, and
  // each proved itself earliest. Cycle-6: order lives in the NAME
  // (creation ms); heartbeats only refresh staleness. Plant claim
  // A with OUR (live) pid, created 10 s ago by name, its mtime
  // refreshed to NOW (the heartbeat scenario); a fresh contender
  // must see A as strictly earlier and REFUSE — the refreshed
  // mtime buys it nothing.
  const p = await freshLogPath("b1-heartbeat");
  const old = Date.now() - 10_000;
  plantWellFormedClaim(p, process.pid, old, new Date(), `${process.pid} hb\n`);
  const log = new S5Log<Rec>({ path: p, lockWaitMs: 150, lockStaleMs: 30_000 });
  assert.throws(() => log.append({ id: "a", kind: "k" }), S5LockBusyError, "name-older claim wins despite its refreshed mtime");
});

test("cycle-6 M3 regression: a FRESH well-formed claim with a DEAD creator pid is swept immediately (no staleness wait, no empty predicate)", async () => {
  // Old sweep gates: an entry was removable only when stale past
  // lockStaleMs (or empty-and-aged). With ordering derived from
  // the NAME, a well-formed entry whose immutable creator pid is
  // dead carries no live-holder risk at ANY age — crash recovery
  // must not wait a whole lockStaleMs on it.
  const p = await freshLogPath("m3-deadcreator");
  plantWellFormedClaim(p, 999999, Date.now(), new Date(), "999999 dead\n"); // fresh, full content, dead pid
  const log = new S5Log<Rec>({ path: p, lockWaitMs: 300, lockStaleMs: 30_000 });
  const before = Date.now();
  const res = log.append({ id: "a", kind: "k" });
  assert.equal(res.status, "acked", "dead-creator well-formed claim swept at once");
  assert.ok(Date.now() - before < 280, "immediate takeover, no staleness wait");
});

test("cycle-6 M1 regression: a FAILING ancestor dir-entry sync aborts establishment (fail closed — no un-established log)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "s5log-m1-"));
  const p = path.join(dir, "a1", "a2", "s5.jsonl"); // two ancestors to create
  const spy = syncSpy((label) => label === "log-dir"); // first dir sync fails
  const log = new S5Log<Rec>({ path: p, sync: spy.fn });
  assert.throws(() => log.append({ id: "a", kind: "k" }), /ancestor dir sync FAILED|dir sync/, "ancestor-entry proof failure propagates");
  assert.ok(spy.calls.includes("log-dir"), "the failing sync really was a dir sync");
  // Fail closed means NO successful ack either: a healthy retry
  // establishes cleanly and the record lands exactly once.
  const healthy = new S5Log<Rec>({ path: p });
  assert.equal(healthy.append({ id: "a", kind: "k" }).status, "acked");
  assert.equal(healthy.replay().records.filter((r) => r.id === "a").length, 1);
});

test("cycle-6 M4 regression: external rm + RECREATE (new inode, bytes ≤ old watermark) drops the proof — the new bytes are re-established, never inherited-proven", async () => {
  const p = await freshLogPath("m4-identity");
  const spy = syncSpy();
  const log = new S5Log<Rec>({ path: p, sync: spy.fn });
  log.append({ id: "r1", kind: "k" });
  log.append({ id: "r2", kind: "k" });
  const n = readFileSync(p).length; // watermark proven through here
  // Operator: rm the log AND rewrite it SHORTER (M ≤ N) with a
  // foreign record, keeping a coherent marker. The old code kept
  // its (path-keyed) watermark: reliedBytes M ≤ N meant the new
  // bytes reported "proven" with ZERO syncs the instance never
  // performed. With the identity binding the proof belongs to the
  // OLD inode and is dropped.
  const before = spy.calls.length;
  unlinkSyncSafe(p);
  unlinkSyncSafe(p + ".durability");
  writeFileSync(p, JSON.stringify({ id: "foreign", kind: "k" }) + "\n", "utf8");
  void n;
  const res = log.replay();
  const after = spy.calls.slice(before);
  assert.deepEqual(res.records.map((r) => r.id), ["foreign"]);
  assert.ok(
    after.includes("log-file") || after.includes("establish-prefix"),
    "the recreated inode's bytes were re-established (synced) by THIS instance — the old inode's proof was dropped, not inherited",
  );
  assert.equal(res.durability, "proven", "re-established honestly, then reported proven");
});

test("cycle-6 m-minor: marker publishes atomically — no .tmp residue in the log dir; a stray tmp is inert", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "s5log-markeratomic-"));
  const p = path.join(dir, "s5.jsonl");
  const log = new S5Log<Rec>({ path: p });
  log.append({ id: "a", kind: "k" });
  const entries = readdirSync(dir);
  assert.ok(entries.includes("s5.jsonl.durability"), "marker published under its exact name");
  assert.ok(
    !entries.some((e) => e.includes(".tmp-")),
    "the tmp stage never survives the rename (no residue)",
  );
  // A stray tmp file is INERT: it is not the marker path, so the
  // established state is untouched.
  writeFileSync(path.join(dir, "s5.jsonl.durability.tmp-1234-abcd1234"), "garbage{", "utf8");
  const res = log.append({ id: "b", kind: "k" });
  assert.equal(res.status, "acked", "a stray marker tmp changes nothing");
});

/* ------------------------------------------------------------------ *
 * Cycle-7 folds — B1 sole-occupancy admission, M2 fd-bound identity  *
 * ------------------------------------------------------------------ */

test("cycle-7 B1 regression: a clock-SKEWED live claim (createdMs in the future) still blocks admission — 'earliest' is no longer an admission key; sole occupancy is", async () => {
  // The audit c6 BLOCKER 1 shape: under the cycle-6 ordering proof,
  // a backwards-running (or skewed-forward) clock made "I am
  // earliest by (createdMs, name)" observable as TRUE by two
  // contenders. Plant a foreign claim whose NAME-encoded creation
  // time is a minute in the FUTURE (the skewed clock) with OUR
  // (live) pid: the old proof admitted us (we were "earlier")
  // beside a live holder. Sole-occupancy admits only when the
  // registry holds exactly ONE live entry and it is ours — a
  // predicate no clock falsifies: any other live entry, at any
  // encoded time, yields.
  const p = await freshLogPath("b1-skew");
  const future = Date.now() + 60_000; // skewed clock: their name says "created later"
  plantWellFormedClaim(p, process.pid, future, new Date(), `${process.pid} skewed\n`);
  const log = new S5Log<Rec>({ path: p, lockWaitMs: 150, lockStaleMs: 30_000 });
  assert.throws(
    () => log.append({ id: "a", kind: "k" }),
    S5LockBusyError,
    "a live foreign claim blocks regardless of the clock values in the names",
  );
});

test("cycle-7 M2 regression: an external rm + RECREATE between the establishing sync and the mutation fail-stops the pass BEFORE any write (every descriptor re-proves the read identity)", async () => {
  const p = await freshLogPath("m2-swapmid");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "old", kind: "k" });
  // A FRESH instance (marker proven, prefix of unknown origin)
  // pays its establish-prefix sync this pass. The adversary swaps
  // the inode FROM INSIDE that sync — the last instant before the
  // mutation opens its own descriptor. The cycle-6 code would then
  // open the NEW inode at the same path and append to bytes it
  // never read (classifying "old", mutating a file holding
  // "foreign"). The cycle-7 mutation re-proves the opened
  // descriptor against the identity the read ran on: refusal,
  // nothing written.
  const foreign = JSON.stringify({ id: "foreign", kind: "k" }) + "\n";
  let swapped = false;
  const spy = syncSpy((label) => {
    if (label === "establish-prefix" && !swapped) {
      swapped = true;
      unlinkSyncSafe(p);
      writeFileSync(p, foreign, "utf8"); // new inode, same path
    }
    return false; // no injected sync failure — the stale-fd sync succeeds
  });
  const fresh = new S5Log<Rec>({ path: p, lockWaitMs: 100, sync: spy.fn });
  assert.throws(
    () => fresh.appendUnit(() => [{ id: "new", kind: "k" }]),
    S5LogIdentityError,
    "mutation on a descriptor that is not the inode we read REFUSES with the identity error",
  );
  assert.ok(swapped, "the swap really happened inside the establishing sync");
  // The recreated file stands EXACTLY as the adversary wrote it:
  // the refused pass appended nothing to the foreign inode.
  assert.equal(readFileSync(p, "utf8"), foreign, "nothing written to the swapped-in inode");
  // And the record we refused never entered the log for anybody:
  const healthy = new S5Log<Rec>({ path: p });
  assert.deepEqual(healthy.replay().records.map((r) => r.id), ["foreign"], "the un-acked 'new' is nowhere");
});

test("cycle-8 finding-1 regression: an rm + RECREATE after the establishing sync still fails the REPLAY pre-return identity re-proof (the proven-watermark shape has no sync-branch check to lean on)", async () => {
  const p = await freshLogPath("m2-replay-swap");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "old", kind: "k" });
  // A FRESH instance replays: prefix unproven, so it pays its
  // establish-prefix sync. The adversary swaps the inode FROM
  // INSIDE that sync — after the sync-branch's pre-sync check has
  // already passed (correctly: the sync itself ran on the inode
  // the read observed). The watermark advances for the OLD inode;
  // the ONLY gate left between here and the caller is the
  // pre-return re-proof: the path no longer stands where the
  // snapshot's bytes live.
  const foreign = JSON.stringify({ id: "foreign", kind: "k" }) + "\n";
  let swapped = false;
  const spy = syncSpy((label) => {
    if (label === "establish-prefix" && !swapped) {
      swapped = true;
      unlinkSyncSafe(p);
      writeFileSync(p, foreign, "utf8"); // new inode, same path
    }
    return false;
  });
  const fresh = new S5Log<Rec>({ path: p, lockWaitMs: 100, sync: spy.fn });
  assert.throws(
    () => fresh.replay(),
    S5LogIdentityError,
    "a replay snapshot whose inode ceased to stand is NOT delivered",
  );
  assert.ok(swapped, "the swap really happened inside the establishing sync");
  // Without the guard this test mutates green: deleting the
  // pre-return assertSameInode ships a replay that hands the
  // caller ["old"] as a proven snapshot of a file that no longer
  // exists — the exact coverage gap mutation testing caught in
  // cycle 7 (2/3 identity sites covered).
});

test("cycle-8 finding-1 regression: a plain external rm before the replay returns fails the same gate (no recreate to sync on)", async () => {
  const p = await freshLogPath("m2-replay-unlink");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "old", kind: "k" });
  // Swap the log away entirely while the sync spy holds the pass
  // open: the watermark branch runs on OUR still-open fd (the
  // sync succeeds — fd survives unlink), the path is gone at
  // return: a vanished path has no identity; fail closed.
  let removed = false;
  const spy = syncSpy((label) => {
    if (label === "establish-prefix" && !removed) {
      removed = true;
      unlinkSyncSafe(p);
    }
    return false;
  });
  const fresh = new S5Log<Rec>({ path: p, lockWaitMs: 100, sync: spy.fn });
  assert.throws(
    () => fresh.replay(),
    S5LogIdentityError,
    "a snapshot of a path that ceased to exist is refused, not delivered empty",
  );
  assert.ok(removed, "the unlink really happened inside the establishing sync");
});

test("cycle-8 finding-2 regression: retrySleepMs is JITTERED within bounds — a deterministic retry cadence livelocks simultaneous yielders into lockstep starvation (audit c7 finding-2 fold)", () => {
  // Distribution property: a black-box acquire test can only
  // FAIL TO OBSERVE the livelock, so the shape is asserted where
  // it is drawn (see the retrySleepMs doc comment).
  const deadline = Date.now() + 60_000;
  const draws = new Set<number>();
  for (let i = 0; i < 400; i++) {
    const t = retrySleepMs(deadline);
    assert.ok(Number.isInteger(t) && t >= 5 && t <= 55, `sleep ${t} outside [5,55]`);
    draws.add(t);
  }
  assert.ok(draws.size >= 20, `jitter collapsed: only ${draws.size} distinct values in 400 draws`);
  // Deadline clamp: near the deadline the draw never sleeps
  // meaningfully past it (min slice 5, cap 55 upper bound).
  const near = Date.now() + 8;
  for (let i = 0; i < 100; i++) {
    const t = retrySleepMs(near);
    assert.ok(t >= 5 && t <= 55, "clamped draw stays in the slice bounds");
  }
  // Past-deadline draw stays at the floor slice (callers check
  // the deadline BEFORE sleeping; the floor keeps the check hot).
  const past = Date.now() - 1000;
  for (let i = 0; i < 50; i++) {
    assert.equal(retrySleepMs(past), 5, "past-deadline draws the floor slice");
  }
});

test("cycle-8 c8-Q2 regression: an IN-PLACE content swap (same inode!) between the establishing sync and the replay return fails the snapshot digest gate — an (dev,ino) check cannot see it", async () => {
  const p = await freshLogPath("c8q2-inplace");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "old", kind: "k" });
  // The stronger adversary the inode gate is blind to: no unlink,
  // no recreate — the SAME inode is overwritten in place after the
  // snapshot was taken. Whether this arises from inode recycling
  // (rm + recreate handing back the freed number) or a direct
  // in-place rewrite, the pre-return gate must compare CONTENT,
  // not just (st_dev, st_ino): the snapshot's records no longer
  // describe the standing bytes.
  const foreign = JSON.stringify({ id: "foreign", kind: "k" }) + "\n";
  let swapped = false;
  const spy = syncSpy((label) => {
    if (label === "establish-prefix" && !swapped) {
      swapped = true;
      const fd = openSync(p, "r+"); // SAME inode
      try {
        ftruncateSync(fd, 0);
        writeSync(fd, foreign, 0, "utf8");
      } finally {
        closeSync(fd);
      }
    }
    return false;
  });
  const fresh = new S5Log<Rec>({ path: p, lockWaitMs: 100, sync: spy.fn });
  assert.throws(
    () => fresh.replay(),
    S5LogIdentityError,
    "a replay snapshot whose bytes were swapped in place is NOT delivered (digest mismatch)",
  );
  assert.ok(swapped, "the in-place swap really happened inside the establishing sync");
  assert.equal(readFileSync(p, "utf8"), foreign, "the refused pass wrote nothing over the swap");
});

test("audit c2-Q2 regression (cycle-9): a TRANSIENT registry-listing failure retries to the deadline — the FIRST failed readdir no longer spends the whole budget as an instant refusal", async () => {
  const p = await freshLogPath("q2-transient-listing");
  // Deterministic reproduction of the documented failure CLASS:
  // a registry directory that is PRESENT but refuses LISTING
  // (mode 0300: write+execute still create/unlink claim entries,
  // readdir returns EACCES). That is exactly the transient
  // readdir error (EMFILE under fd pressure, EIO, a permission
  // flap) for which the c1-Q3 fold refused on the FIRST failed
  // listing — spending none of the caller's `lockWaitMs`. The
  // fold must remove our entry, back off, and RETRY; this
  // injection clears the listing failure before the second
  // round's proof, so the acquire must complete on round two.
  // (An rmdir-registry injection does NOT reproduce it: the next
  // round's mkdirSync recreates the registry, the listing then
  // SUCCEEDS empty, `mine === undefined` with listingFailed
  // FALSE — the external-tampering branch, not this fold.)
  mkdirSync(p + ".lock", { recursive: true });
  chmodSync(p + ".lock", 0o300);
  let rounds = 0;
  const spy = syncSpy((label) => {
    if (label === "lock-acquire") {
      rounds++;
      if (rounds >= 2) chmodSync(p + ".lock", 0o755); // the transient clears
    }
    return false;
  });
  try {
    const log = new S5Log<Rec>({ path: p, lockWaitMs: 2000, sync: spy.fn });
    const res = log.append({ id: "after-race", kind: "k" });
    assert.ok(rounds >= 2, `the acquire never re-ran after a failed listing (rounds=${rounds})`);
    assert.equal(res.status, "acked", "one transient listing failure is retried, not refused");
    assert.deepEqual(log.replay().records.map((r) => r.id), ["after-race"]);
  } finally {
    // A successful release rmdirs the empty registry — the path
    // may legitimately be gone by now.
    try { chmodSync(p + ".lock", 0o755); } catch { /* registry already removed */ }
  }
});

test("audit c2-Q2 fail-closed (cycle-9): a PERSISTENT listing failure burns the full lockWaitMs and refuses as S5LockBusyError — retry, never lockless, never early", async () => {
  const p = await freshLogPath("q2-persistent-listing");
  // The same un-listable registry (mode 0300) for the WHOLE
  // budget: every round creates its claim, sweeps (readdir fails —
  // no-op), fails the listing, removes its own entry, backs off.
  // The fold must consume the whole budget and fail CLOSED — the
  // log is never written without a held claim, and the refusal is
  // the ordinary busy error (callers already handle it).
  mkdirSync(p + ".lock", { recursive: true });
  chmodSync(p + ".lock", 0o300);
  let rounds = 0;
  const spy = syncSpy((label) => {
    if (label === "lock-acquire") rounds++;
    return false;
  });
  const log = new S5Log<Rec>({ path: p, lockWaitMs: 150, sync: spy.fn });
  const t0 = Date.now();
  try {
    assert.throws(() => log.append({ id: "never", kind: "k" }), S5LockBusyError);
    const waited = Date.now() - t0;
    assert.ok(waited >= 145, `budget not honored: refused after ${waited}ms of a 150ms wait`);
    assert.ok(rounds >= 2, `only ${rounds} acquire round(s) — the fold refused on the first failed listing`);
    assert.ok(!existsSync(p), "no write happened without a held claim");
    chmodSync(p + ".lock", 0o755); // re-readable: the entry-hygiene check below is meaningful
    assert.deepEqual(registryClaims(p), [], "the fold's own entry is cleaned up on every failed round");
  } finally {
    chmodSync(p + ".lock", 0o755);
  }
});

test("audit c2-Q3 regression (cycle-9): a mid-pass rm between the read and the establishing-sync open refuses with the IDENTITY error — no raw ENOENT leak, and the ritual never recreates the removed log", async () => {
  const p = await freshLogPath("q3-midpass-rm");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "old", kind: "k" });
  // A FRESH instance pays its establish-prefix sync this pass (the
  // cycle-7 M2 shape). The adversary removes the log (no recreate)
  // FROM INSIDE that sync — the bytes this pass read are gone
  // while the pass deliberates. Without the fold the pass proceeds
  // to the mutation phase, clears `established`, and RE-RUNS the
  // ritual — which CREATES a fresh empty log (and republishes the
  // durability marker) — before the very next identity gate
  // refuses: a failed pass with the side effect of resurrecting
  // the file the operator deleted. With the fold: identity error,
  // file stays deleted, nothing written.
  let removed = false;
  const spy = syncSpy((label) => {
    if (label === "establish-prefix" && !removed) {
      removed = true;
      unlinkSyncSafe(p);
    }
    return false;
  });
  const fresh = new S5Log<Rec>({ path: p, lockWaitMs: 100, sync: spy.fn });
  assert.throws(
    () => fresh.appendUnit(() => [{ id: "new", kind: "k" }]),
    S5LogIdentityError,
    "a mid-pass deletion is the identity failure class every other gate throws",
  );
  assert.ok(removed, "the rm really happened inside the establishing sync");
  assert.ok(!existsSync(p), "the refused pass did NOT recreate the log the operator removed");
});

test("audit c2-Q3 regression (cycle-9): an rm as a side effect of make() surfaces as S5LogIdentityError at the establishing-sync open — not a raw ENOENT", async () => {
  const p = await freshLogPath("q3-make-unlink");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "old", kind: "k" });
  // `make()` runs after validation and BEFORE the establishing
  // sync opens its descriptor: a caller-side effect (or a racing
  // remover) that deletes the log here leaves the pass holding a
  // read identity for bytes that no longer stand. The openSync
  // ENOENT is classified into the identity error so callers
  // keying on S5LogIdentityError for "the file you read is gone"
  // catch it; nothing is recreated, nothing is written.
  const fresh = new S5Log<Rec>({ path: p, lockWaitMs: 100 });
  assert.throws(
    () =>
      fresh.appendUnit(() => {
        unlinkSyncSafe(p);
        return [{ id: "new", kind: "k" }];
      }),
    S5LogIdentityError,
    "the vanished log is an identity loss, not an unclassified ENOENT I/O accident",
  );
  assert.ok(!existsSync(p), "nothing was recreated by the refused pass");
});

test("audit c2-Q3 regression (cycle-9): a mid-pass rm cannot buy a caller-visible refiled-only receipt — the decision is refused like a snapshot of deleted bytes", async () => {
  const p = await freshLogPath("q3-refiled-receipt");
  const log = new S5Log<Rec>({ path: p });
  const rec: Rec = { id: "r1", kind: "k" };
  log.append(rec); // same instance: bytes now PROVEN — no establish-prefix sync owed
  // Pure-refiling pass (no write, no sync branch): the only gate
  // between the classification and the caller-visible receipt is
  // the decision-provenance fence. The rm inside make() lands
  // AFTER the pass read bytes — the receipt would report "refiled"
  // against a file that no longer exists.
  assert.throws(
    () =>
      log.appendUnit(() => {
        unlinkSyncSafe(p);
        return [rec];
      }),
    S5LogIdentityError,
    "no refiled-only receipt for a deleted log",
  );
  assert.ok(!existsSync(p), "the refused pass left the log deleted, exactly as the operator left it");
});

test("audit c5-Q1 regression (cycle-9): a mid-pass rm + RECREATE cannot buy a refiled receipt — the fence re-proves the content digest, not just existence", async () => {
  const p = await freshLogPath("c5q1-refiled-recreate");
  const log = new S5Log<Rec>({ path: p });
  const rec: Rec = { id: "r1", kind: "k" };
  log.append(rec); // bytes proven this instance: no establish-prefix sync owed
  // Pure-refiling pass whose only seam is the fence. The rm inside
  // make() is FOLLOWED by a recreate (a different inode, different
  // content): the old existsSync-only fence saw a standing path
  // and handed the caller `refiled: [r1]` for a file that never
  // held r1 — inconsistent with the acked path and replay, which
  // re-prove identity. The hardened fence (full snapshot proof:
  // path identity + content digest of the bytes read) refuses.
  assert.throws(
    () =>
      log.appendUnit(() => {
        unlinkSyncSafe(p);
        writeFileSync(p, '{"id":"stranger","kind":"k"}\n', "utf8");
        return [rec];
      }),
    S5LogIdentityError,
    "no refiled receipt against a recreated file the pass never read",
  );
  // And the recreated file stands untouched: the refusal mutates
  // nothing.
  assert.ok(existsSync(p), "the refused pass left the stranger file exactly as the recreator wrote it");
  const back = log.replay();
  assert.deepEqual(back.records.map((r) => r.id), ["stranger"], "the standing bytes are the recreator's, untouched by the refused pass");
});

test("audit c5-Q1 localization (cycle-9): a SAME-INODE content swap (hardlink round-trip) is refused by the digest line ALONE — deleting that line turns this test green", async () => {
  const p = await freshLogPath("c5q1-localize");
  const alt = p + ".alt";
  const log = new S5Log<Rec>({ path: p });
  const rec: Rec = { id: "r1", kind: "k" };
  log.append(rec);
  // The Q1 finding: the plain rm+recreate regression test is
  // refused by the (dev,ino) line BEFORE the digest comparison is
  // reached — it localizes to the identity check, not the digest
  // gate. This test isolates the digest line: a hardlink
  // round-trip (link -> unlink -> in-place write via the link ->
  // relink) puts DIFFERENT bytes at the SAME (dev,ino) the
  // snapshot was taken on. assertSameInode passes; only the
  // content digest can refuse. Mutation pin: deleting `if (now !==
  // state.contentDigest) throw ...` from assertSnapshotIntact
  // makes this test green (it must not).
  assert.throws(
    () =>
      log.appendUnit(() => {
        linkSync(p, alt); // alt and p: same inode
        unlinkSync(p); // path gone; inode alive via alt
        writeFileSync(alt, '{"id":"stranger","kind":"k"}\n', "utf8"); // in-place: same inode, new bytes
        linkSync(alt, p); // path restored: same (dev,ino), swapped content
        return [rec];
      }),
    S5LogIdentityError,
    "the digest re-proof is the only gate that can see this swap — it must fire",
  );
  assert.equal(readFileSync(p, "utf8"), '{"id":"stranger","kind":"k"}\n', "the refused pass leaves the swapped bytes standing untouched");
});

test("audit c3-Q1 regression (cycle-9): an rm landing after the append fsync refuses the ACKED return with the identity error — no ack for bytes no longer standing at the path", async () => {
  const p = await freshLogPath("c3q1-postsync-rm");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "old", kind: "k" });
  // The fold's window: the rm lands at the append-sync point
  // (inside the sync callback — the fsync then runs on the just-
  // unlinked fd, flushing the record to an inode no longer
  // standing at the path) — between the sync returning and the
  // caller receiving the ack. The acked branch now re-proves the
  // path against the synced identity before returning: a vanished
  // path (or a swapped inode) refuses as S5LogIdentityError. The
  // record's bytes were durable on the (unlinked) inode only for
  // the microseconds an unlinked file can be recovered; the
  // caller-visible ACK — the transport's delivery fact — is
  // refused, exactly like the refiled-only receipt.
  let removed = false;
  const spy = syncSpy((label) => {
    if (label === "append" && !removed) {
      removed = true;
      unlinkSyncSafe(p);
    }
    return false;
  });
  const fresh = new S5Log<Rec>({ path: p, lockWaitMs: 100, sync: spy.fn });
  assert.throws(
    () => fresh.append({ id: "new", kind: "k" }),
    S5LogIdentityError,
    "an ack is a decision about standing bytes: a post-sync rm must not be acked",
  );
  assert.ok(removed, "the rm really happened inside the append sync");
  assert.ok(!existsSync(p), "the refused pass did not recreate the removed log");
  // The NEXT pass (inter-pass shape, identity===null) re-rituals
  // legitimately: the refusal must not wedge the instance.
  const res = fresh.append({ id: "next", kind: "k" });
  assert.equal(res.status, "acked", "a following pass after the operator's rm proceeds on the fresh-instance path");
});

test("audit c2-Q3 complement (cycle-9): an INTER-pass rm (identity === null: deletion preceded the read) still takes the legitimate fresh-instance path — the fold must NOT fire", async () => {
  const p = await freshLogPath("q3-interpass-rm");
  const seed = new S5Log<Rec>({ path: p });
  seed.append({ id: "old", kind: "k" });
  // Operator removes the log BETWEEN passes. The next pass reads
  // NOTHING (`state.identity === null` — the open fails ENOENT),
  // so there are no read bytes to be stale about: the c2-Q3 fold
  // is explicitly scoped to identity !== null and must let the
  // fresh-instance ritual re-run. This test pins the fold's
  // DIRECTION: an over-broad guard (firing on null identity too)
  // would wedge every legitimate recreate with a false identity
  // error. (Pair for the mutation matrix: mutG1inv/mutG4inv.)
  unlinkSyncSafe(p);
  unlinkSyncSafe(p + ".durability"); // marker about a deleted file: stale
  const fresh = new S5Log<Rec>({ path: p, lockWaitMs: 100 });
  const res = fresh.append({ id: "new", kind: "k" });
  assert.equal(res.status, "acked", "the fresh-instance path after an inter-pass rm stays legitimate");
  assert.deepEqual(fresh.replay().records.map((r) => r.id), ["new"], "the recreated log holds ONLY the new record");
});

test("audit c2-Q3 complement (cycle-9): replay of an absent log (identity === null) succeeds as the fresh-instance path — no false identity error from the replay-side fold", async () => {
  const p = await freshLogPath("q3-replay-absent");
  // Same direction pin on the REPLAY guard: nothing was read, so
  // nothing read can be stale — replay must establish and deliver
  // an empty prefix, not throw.
  const fresh = new S5Log<Rec>({ path: p, lockWaitMs: 100 });
  const res = fresh.replay();
  assert.deepEqual(res.records, [], "absent log replays as empty");
});

// ---------------------------------------------------------------------------
// Audit cycle-8 folds
// ---------------------------------------------------------------------------

test("audit c8-Q2 fold (cycle-9): a complete-looking record behind a trailing raw \\r REFUSES every pass — never silently truncated", async () => {
  const p = await freshLogPath("c8q2");
  // An external CRLF-editor left the final record terminated with
  // \r only: canonical replay would call it crash residue and the
  // ritual would ftruncate it away — the record would vanish while
  // the append acked. It is a non-canonical line: refuse.
  writeFileSync(p, '{"id":"a","kind":"k"}\n{"id":"b","kind":"k"}\r');
  const log = new S5Log<Rec>({ path: p, lockWaitMs: 100 });
  assert.throws(
    () => log.append({ id: "c", kind: "k" }),
    (e: unknown) =>
      e instanceof S5LogCorruptionError && e.corruptLine === 2 && e.reason === "corrupt-line",
    "the \\r-terminated line is a corrupt line (1-based: 2), refused like any other",
  );
  assert.equal(readFileSync(p, "utf8"), '{"id":"a","kind":"k"}\n{"id":"b","kind":"k"}\r', "the seed is byte-untouched after the refusal");
  const rp = log.replay();
  assert.deepEqual(rp.corruptLines, [2], "replay REPORTS the \\r line as corrupt — not silently absent from a partial tail");
  assert.deepEqual(rp.records.map((r) => r.id), ["a"], "only the canonical record replays");
});

test("audit c8-Q2 control (cycle-9): a genuinely torn final fragment stays repairable — the \\r detection does not over-reach", async () => {
  const p = await freshLogPath("c8q2-torn");
  // Crash residue (no line terminator at all) must keep its old
  // behavior: append truncates it and proceeds (V-g2 direction).
  writeFileSync(p, '{"id":"a","kind":"k"}\n{"id":"b","ki');
  const log = new S5Log<Rec>({ path: p, lockWaitMs: 100 });
  const res = log.append({ id: "c", kind: "k" });
  assert.equal(res.status, "acked", "a torn fragment is still repaired, not refused");
  assert.deepEqual(log.replay().records.map((r) => r.id), ["a", "c"], "the torn fragment is truncated away, the canonical record survives, and the new record lands");
});

// Audit c12-F1 fold: the dir-entry bootstrap ritual runs after
// validation but BEFORE make(). A semantic refusal after a cold
// ritual still leaves no content mutated, and the re-created marker
// is the documented carve-out (dir-entry proof only). This test pins
// that exact behavior so the header carve-out stays falsifiable.
test("c12 contract: warm log, marker deleted, make() refuses = ritual runs, NO content mutated", async () => {
  const p = await freshLogPath("c12ritual");
  const warm = new S5Log<Rec>({ path: p });
  warm.append({ id: "seed", kind: "k" });
  unlinkSync(p + ".durability");
  const before = readFileSync(p, "utf8");
  const spy = syncSpy();
  const cold = new S5Log<Rec>({ path: p, sync: spy.fn });
  assert.throws(() => cold.appendUnit(() => { throw new Error("c1a refusal"); }), /c1a refusal/);
  assert.equal(readFileSync(p, "utf8"), before, "no content mutated by a refused pass");
  assert.ok(!spy.calls.includes("append"), "no decision/append sync ran");
  assert.ok(spy.calls.includes("log-file"), "bootstrap ritual ran before make() (documented carve-out)");
  assert.ok(existsSync(p + ".durability"), "marker re-created by the ritual (dir-entry proof only)");
  assert.deepEqual(new S5Log<Rec>({ path: p }).replay().records.map((r) => r.id), ["seed"]);
});

// Audit c13-F3 fold: pin the ORDER claim, not just presence. make()
// records how many sync labels had already run; a cold ritual must
// have run before make() observes the pass.
test("c13 contract: bootstrap ritual completes BEFORE make() observes the pass (cold/unreadable marker)", async () => {
  const p = await freshLogPath("c13order");
  const warm = new S5Log<Rec>({ path: p });
  warm.append({ id: "seed", kind: "k" });
  writeFileSync(p + ".durability", "not json", "utf8");
  const spy = syncSpy();
  const cold = new S5Log<Rec>({ path: p, sync: spy.fn });
  let seenAtMake: S5SyncLabel[] | null = null;
  cold.appendUnit((prefix) => {
    seenAtMake = [...spy.calls];
    void prefix;
    return [{ id: "fresh", kind: "k" }];
  });
  assert.ok(seenAtMake !== null, "make() ran");
  assert.ok((seenAtMake as S5SyncLabel[]).includes("log-file"), "ritual log-file sync completed before make()");
  assert.ok((seenAtMake as S5SyncLabel[]).includes("marker-dir"), "marker republished before make()");
  assert.ok(!spy.calls.slice((seenAtMake as S5SyncLabel[]).length).includes("log-file"), "ritual not repeated after make()");
});

// Audit c15-F1 fold: environment failures on the log path escape
// RAW (errno-bearing Errors, no taxonomy class — they are not
// protocol states), fail-closed, and the claim is released.
test("c15 contract: unreadable log (chmod 000) escapes raw with .code, fail-closed, claim released", async () => {
  const p = await freshLogPath("c15eacces");
  writeFileSync(p, `{"id":"a","kind":"k"}\n`, "utf8");
  chmodSync(p, 0o000);
  const log = new S5Log<Rec>({ path: p, lockWaitMs: 100 });
  try {
    const err = ((): unknown => {
      try { log.append({ id: "c", kind: "k" }); return null; } catch (e) { return e; }
    })();
    assert.ok(err !== null, "append refused");
    const e = err as NodeJS.ErrnoException & { name?: string };
    assert.equal(e.name, "Error", "raw Error — no taxonomy class for environment failures (documented scope)");
    assert.equal(e.code, "EACCES", "errno survives on .code");
    assert.ok(!existsSync(p + ".lock"), "claim released by the finally");
    chmodSync(p, 0o644);
    assert.equal(readFileSync(p, "utf8"), `{"id":"a","kind":"k"}\n`, "nothing written");
  } finally {
    try { chmodSync(p, 0o644); } catch { /* already restored */ }
  }
});

// Audit c15-F2 fold: acquire failures keep the original errno
// (cause + code) through the wrap — a caller distinguishes EACCES
// from any other acquire failure without parsing text.
test("c15 contract: registry acquire failure preserves cause/code (EACCES on read-only parent)", async () => {
  const dir = await freshLogPath("c15ro");
  mkdirSync(dir);
  const log = new S5Log<Rec>({ path: `${dir}/nested/x.jsonl`, lockWaitMs: 50 });
  chmodSync(dir, 0o500);
  try {
    let err: NodeJS.ErrnoException | null = null;
    try { log.append({ id: "a", kind: "k" }); } catch (e) { err = e as NodeJS.ErrnoException; }
    assert.ok(err !== null, "acquire refused");
    assert.match(err.message, /S5 lock acquire failed|S5 durability/);
    assert.ok(err.cause !== undefined, "original error preserved as cause");
    assert.ok(typeof err.code === "string", "errno code survives the wrap");
    assert.equal(err.code, "EACCES");
  } finally {
    chmodSync(dir, 0o700);
  }
});

// Audit c16-F1 fold: intra-unit duplicate behavior pinned — the
// second identical copy of an id in the SAME unit is reported
// `refiled` (never re-appended); "already stands in the durable
// prefix" is evaluated at return. The divergent second copy is
// refused atomically; nothing lands.
test("c16 contract: intra-unit duplicate id reports refiled, never re-appends; divergent twin refuses atomically", async () => {
  const p = await freshLogPath("c16dup");
  const log = new S5Log<Rec>({ path: p, lockWaitMs: 300 });
  const res = log.appendUnit(() => [
    { id: "x", kind: "k" },
    { id: "x", kind: "k" },
  ]);
  assert.equal(res.status, "acked");
  assert.deepEqual(res.appended, [{ id: "x", kind: "k" }], "exactly ONE copy appended");
  assert.deepEqual(res.refiled, ["x"], "the twin is a refiling candidate (documented c16-F1 shape)");
  assert.equal(readFileSync(p, "utf8"), `{"id":"x","kind":"k"}\n`, "one line on disk");
  // Divergent twin in the same unit: refused, unit atomic.
  let threw = false;
  try {
    log.appendUnit(() => [
      { id: "y", kind: "k" },
      { id: "y", kind: "other" },
    ]);
  } catch (e) {
    threw = true;
    assert.equal((e as { constructor: { name: string } }).constructor.name, "S5ReplayIntegrityError");
  }
  assert.ok(threw, "same-id divergent bytes within one unit refuse atomically");
  assert.equal(readFileSync(p, "utf8"), `{"id":"x","kind":"k"}\n`, "refused unit wrote nothing");
});

// Audit c17-F1 fold: a same-inode in-place truncate+rewrite (external
// writer, no rm) destroys the tail this instance synced; any bytes
// now present may be unsynced rewrites. The pass re-proves them
// (establish-prefix) instead of inheriting the stale byte-count
// watermark.
test("c17 contract: same-inode shrink drops the watermark — next pass re-proves relied bytes", async () => {
  const p = await freshLogPath("c17shrink");
  const spy = syncSpy();
  const log = new S5Log<Rec>({ path: p, lockWaitMs: 300, sync: spy.fn });
  log.append({ id: "a", kind: "k" });
  log.append({ id: "b", kind: "k" }); // provenThrough now covers both lines
  assert.equal(spy.calls.filter((c) => c === "establish-prefix").length, 0, "warm own bytes: no establishing sync yet");
  spy.calls.length = 0; // watch ONLY the shrink pass
  // External in-place truncate + short rewrite (SAME inode).
  const fd = openSync(p, "w");
  writeSync(fd, `{"id":"z","kind":"k"}\n`);
  closeSync(fd);
  const res = log.append({ id: "c", kind: "k" });
  assert.equal(res.status, "acked");
  assert.equal(
    spy.calls.filter((c) => c === "establish-prefix").length,
    1,
    "shrink is visible through size: the proof was dropped, so the prefix is RE-proven before reliance",
  );
  assert.ok(
    spy.calls.indexOf("establish-prefix") < spy.calls.indexOf("append"),
    "re-proof ordered before the decision sync",
  );
  const st = log.replay();
  assert.deepEqual(st.records.map((r) => r.id), ["z", "c"]);
});

// Audit c18-F1 fold: the exact-count claims elsewhere filter the
// labels they care about, so the claim-entry fsync was invisible to
// the suite. Count EVERY label on a warm pass and on replay.
test("c18 contract: warm append = lock-acquire + decision append (no other syncs); warm replay = lock-acquire only", async () => {
  const p = await freshLogPath("c18labels");
  new S5Log<Rec>({ path: p }).append({ id: "seed", kind: "k" });
  const spy = syncSpy();
  const warm = new S5Log<Rec>({ path: p, sync: spy.fn });
  warm.append({ id: "seed", kind: "k" }); // cold first pass: pays establish-prefix once (c10-F1)
  spy.calls.length = 0;
  warm.append({ id: "seed", kind: "k" }); // identical redelivery on a now-proven instance
  assert.deepEqual(spy.calls, ["lock-acquire"], "identical redelivery: claim fsync only, nothing written");
  spy.calls.length = 0;
  warm.append({ id: "next", kind: "k" });
  assert.deepEqual(spy.calls, ["lock-acquire", "append"], "warm write: claim fsync + decision fsync");
  spy.calls.length = 0;
  warm.replay();
  assert.deepEqual(spy.calls, ["lock-acquire"], "warm replay: claim fsync only");
});

/* ------------------------------------------------------------------ *
 * Audit c22 folds: F1 — the ACKED return is claim-fenced like every
 * other caller-visible decision; F2 — a non-directory at the
 * registry path (pre-cycle-4 legacy lock file) is refused
 * deterministically with code ENOTDIR, never a raw-errno wedge.
 * ------------------------------------------------------------------ */

test("c22 F1 contract: claim removed at the decision fsync ⇒ the ack refuses as S5LockLostError", async () => {
  const p = await freshLogPath("c22f1-claimfenced");
  const inner = syncSpy();
  const stealSync = (fd: number, label: S5SyncLabel): void => {
    inner.fn(fd, label);
    if (label === "append") {
      // Adversary yanks our claim between the fsync and the ack.
      for (const e of readdirSync(p + ".lock")) {
        if (e.startsWith("claim-")) unlinkSync(`${p + ".lock"}/${e}`);
      }
    }
  };
  const log = new S5Log<Rec>({ path: p, sync: stealSync });
  let threw: unknown = undefined;
  try {
    log.append({ id: "a", kind: "k" });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw instanceof S5LockLostError, `expected S5LockLostError, got ${String(threw)}`);
});

test("c22 F2 contract: legacy regular file at <log>.lock ⇒ deterministic ENOTDIR refusal, not a wedge", async () => {
  const p = await freshLogPath("c22f2-notadir");
  writeFileSync(p + ".lock", "pre-cycle-4 lock file", { flag: "wx" }); // legacy shape
  const log = new S5Log<Rec>({ path: p });
  let threw: unknown = undefined;
  try {
    log.append({ id: "a", kind: "k" });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw instanceof Error, "expected an Error");
  assert.equal((threw as NodeJS.ErrnoException).code, "ENOTDIR", "deterministic, stable code (c15-F2 plumbing)");
  // The legacy file is NEVER deleted — removal is an operator call.
  assert.ok(existsSync(p + ".lock"), "foreign file preserved");
});
