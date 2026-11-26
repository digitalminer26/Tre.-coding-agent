/**
 * G1 step 2 — `src/findings/intake.ts` tests.
 *
 * Ports the intake-behavior vectors that ride WITH this module per
 * g1-implementation-mapping.md (Q3: vectors ride with the module that
 * owns the behavior). Covers: NDR-c NFC claim equality (byte-different
 * / NFC-equal REGRESSION pin against the superseded v9 byte reading),
 * NDR-a mint + entry-mode actor refusal, NDR-t closed vocab +
 * route×surface, the §14.10.3 spool admission producer/consumer
 * (intake reads ONLY `drafts/sha256-<digest>`; absent/mismatch ⇒
 * `owner-filing-draft-drift`, filesystem-observation class), the
 * exactly-two header↔payload comparisons (v28 R5-C20-4), the MIXED
 * correction/cure refusals (NDR-f: bytes embedded + mixed class), the
 * NDR-b intake repro floor, refusal prefix-binding (NDR-d/e/i — the
 * binding is over the prefix intake READ, never the refusal itself),
 * and the MAJOR-7 G2-gate stub seam (journal-then-ack, fail-closed on
 * gate error, refusal is NOT an `audit-filing-intake-refusal`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  chmodSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isSha256Hex,
  isUlid,
  type AuditFinding,
  type AuditFilingPayload,
  type OwnerAct,
  type Repro,
} from "../src/findings/records.js";
import {
  DRAFT_CAP_BYTES,
  DRAFT_MAGIC,
  IntakeInputError,
  IntegrityFaultError,
  MalformedOwnerActError,
  ForeignActEpisodeError,
  SpoolIoError,
  admitAuditorFinding,
  adjudicateFiling,
  claimEqual,
  driftResolutionOperandsValid,
  intakeFiling,
  mintFindingId,
  mintUlid,
  parseDraft,
  prefixBinding,
  prefixDigestInitial,
  prefixDigestStep,
  readSpool,
  refileAttempt,
  spoolDraft,
  spoolPath,
  syncDirEntry,
  validateEntryMode,
  vocabValidate,
  type PrefixRecord,
} from "../src/findings/intake.js";

/* ================= fixtures ================= */

const sha = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), "intake-"));
}

const OK_REPRO: Repro = {
  kind: "probe",
  command: "node probe.js",
  preFixObserved: "observed defect",
  postFixExpected: "no defect",
};

/** Build a valid draft (magic line + JSON header + prose). */
function draftBytes(header: Record<string, unknown>, prose = "full prose evidence"): Buffer {
  return Buffer.from(`${DRAFT_MAGIC}\n${JSON.stringify(header)}\n${prose}`, "utf8");
}

function baseHeader(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    route: "code-fix",
    surface: "code",
    severity: "major",
    verdictBasis: "repro",
    claim: "parser drops trailing token",
    correctionOf: null,
    cureActRef: null,
    scopeRefs: ["src/x.ts#L1"],
    evidenceRefs: ["sess-1"],
    repro: OK_REPRO,
    affectedNorm: null,
    ...over,
  };
}

const PRODUCER = { endpoint: "ep", model: "m", sessionId: "s" };

/** MAJOR-7/MAJOR-8 test seam: the engine REQUIRES writer-canonical
 * prefix lines + an injected G2 gate on every filing call. */
const PASS_GATE = () => ({ pass: true } as const);
const linesOf = (pfx: readonly unknown[]): string[] => pfx.map((r) => JSON.stringify(r));
/** the gate journal path for a filing test dir */
const gJournal = (dir: string) => path.join(dir, "g.jsonl");


function filingAct(
  payload: AuditFilingPayload,
  over: Partial<OwnerAct<"audit-filing">> = {},
): OwnerAct<"audit-filing"> {
  return {
    schema: "tre-supervisor/1",
    id: "01ACT0000000000000000000AA",
    ts: 1,
    episodeId: "ep-1",
    kind: "owner-act",
    op: "audit-filing",
    payload,
    payloadDigest: sha("unused-in-step-2"),
    channel: "tty:dev",
    sessionRef: null,
    effectRecordIds: [],
    ...over,
  };
}

function payloadFor(bytes: Buffer, over: Partial<AuditFilingPayload> = {}): AuditFilingPayload {
  return {
    findingDraftRef: "drafts/live.md",
    draftSha256: sha(bytes),
    claim: "parser drops trailing token",
    cycle: 3,
    taskId: null,
    cureActRef: null,
    ...over,
  };
}

/* ================= NDR-c — NFC claim equality ================= */

test("ndr-c: byte-different but NFC-equal claims are EQUAL (v10 R5-C4-3 regression pin)", () => {
  const nfd = "cafe\u0301"; // e + combining acute
  const nfc = "caf\u00e9"; // precomposed
  assert.notEqual(nfd, nfc, "byte-different by construction");
  assert.equal(claimEqual(nfd, nfc), true);
  assert.equal(claimEqual(nfc, nfd), true);
});

test("ndr-c: NFC-different claims are unequal; non-strings unequal", () => {
  assert.equal(claimEqual("a", "b"), false);
  assert.equal(claimEqual("a", 1 as unknown as string), false);
});

/* ================= NDR-a — mint & entry mode ================= */

test("ndr-a: mintUlid yields conforming ids (first char 0-7), distinct across mints", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const id = mintUlid();
    assert.equal(isUlid(id), true, `non-conforming: ${id}`);
    seen.add(id);
  }
  assert.equal(seen.size, 200, "mints must be distinct");
});

test("ndr-a/R7: mintFindingId refuses a colliding id instead of re-minting", () => {
  const taken = new Set<string>();
  const id = mintFindingId(taken); // fresh: accepted
  taken.add(id);
  // deterministic collision (mint injected): refused, never re-minted
  assert.throws(() => mintFindingId(taken, () => id), /collision refused/);
  // non-conforming mint output is an implementation fault:
  assert.throws(() => mintFindingId(new Set(), () => "not-an-ulid"), /non-conforming/);
});

test("ndr-a: entry-mode actor matrix", () => {
  const ownerMode = { origin: "owner", originRef: null, ownerActRef: "act-1" } as const;
  const auditorMode = {
    origin: "auditor",
    originRef: { origin: "intake", receiptId: "r-1" },
    ownerActRef: null,
  } as const;
  const supDerived = {
    origin: "auditor",
    originRef: { origin: "supervisor-derived", fromRefusalId: "f-1" },
    ownerActRef: null,
  } as const;
  assert.equal(validateEntryMode("supervisor", ownerMode), "owner-act");
  assert.equal(validateEntryMode("auditor-endpoint", auditorMode), "auditor-intake");
  // an auditor endpoint can NEVER produce owner-act or supervisor-derived:
  assert.equal(validateEntryMode("auditor-endpoint", ownerMode), null);
  assert.equal(validateEntryMode("auditor-endpoint", supDerived), null);
  // supervisor-derived REQUIRES the supervisor actor:
  assert.equal(validateEntryMode("supervisor", supDerived), "supervisor-derived");
  // both-refs combination maps to no mode at all:
  assert.equal(
    validateEntryMode("supervisor", {
      origin: "owner",
      originRef: { origin: "intake", receiptId: "r" },
      ownerActRef: "a",
    }),
    null,
  );
  // g1s2-c1 MINOR-1: owner-cli may produce ONLY owner-act mode:
  assert.equal(validateEntryMode("owner-cli", ownerMode), "owner-act");
  assert.equal(validateEntryMode("owner-cli", auditorMode), null);
  assert.equal(validateEntryMode("owner-cli", supDerived), null);
});

/* ================= NDR-t — closed vocabulary ================= */

test("ndr-t(1): unknown enum values are surfaced failures, never dropped", () => {
  const fails = vocabValidate(baseHeader({ severity: "critical", route: "fix-everything" }));
  const fields = fails.map((f) => f.field).sort();
  assert.deepEqual(fields, ["route", "severity"]);
  assert.ok(fails.some((f) => f.value === "critical"));
});

test("ndr-t(2): surface:spec x route:code-fix is invalid", () => {
  const fails = vocabValidate(baseHeader({ surface: "spec" }));
  assert.equal(fails.length, 1);
  assert.equal(fails[0]?.field, "route\u00d7surface");
  // spec x human-review is fine:
  assert.equal(vocabValidate(baseHeader({ surface: "spec", route: "human-review" })).length, 0);
});

test("ndr-t: valid header passes; bad repro.kind flagged", () => {
  assert.equal(vocabValidate(baseHeader()).length, 0);
  const fails = vocabValidate(baseHeader({ repro: { kind: "vibes" } }));
  assert.equal(fails.length, 1);
  assert.equal(fails[0]?.field, "repro.kind");
});

// g1s5-c1 (C1b, vocab-repro-object mutant): the repro-must-be-object
// guard must report the repro-object failure DIRECTLY (field "repro")
// and must never dereference a non-object repro (the removed-guard
// mutant turns repro:null into an internal TypeError and repro:'x'
// into a mislabeled "repro.kind" failure). Pinned directly on the
// predicate — integration refusal codes alone cannot tell the two
// apart (both malformed-input).
test("ndr-t: non-object repro reports field 'repro' without dereferencing (g1s5-c1 vocab-repro-object guard)", () => {
  for (const bad of [null, "x", 7, undefined]) {
    const fails = vocabValidate(baseHeader({ repro: bad }));
    assert.ok(fails.length >= 1, `repro=${String(bad)} must fail`);
    assert.equal(fails[0]?.field, "repro", `repro=${String(bad)} must report field 'repro'`);
  }
});

/* ================= spool admission (§14.10.3) ================= */

test("spool-a-write-fsync-order: producer entry durable (fsync) BEFORE the act append; consumer re-hashes OK", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    const digest = spoolDraft(dir, bytes);
    assert.equal(digest, sha(bytes));
    assert.equal(spoolPath(dir, digest), path.join(dir, "drafts", `sha256-${digest}`));
    assert.ok(existsSync(spoolPath(dir, digest)));
    const read = readSpool(dir, digest);
    assert.equal(read.state, "ok");
    if (read.state === "ok") assert.ok(read.bytes.equals(bytes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// g1s5-c1 finding 3: syncDirEntry used to swallow EVERY fsyncSync/open
// error, so a real durability fault (EACCES/EIO on the directory step)
// silently passed the MAJOR-9 claim. Contract now: platform "cannot
// fsync a directory" refusals (EINVAL/ENOTSUP/…) stay best-effort;
// real I/O faults throw SpoolIoError (the retryable channel, same as
// MAJOR-3's readSpool split). Pinned via a chmod fault (same pattern
// as spool-a-io-error-not-drift). g1s5-c1 (C1b): root IS skipped —
// the uid check is REAL now (the old comment claimed a skip the code
// never implemented; under root CAP_DAC_OVERRIDE the chmod fault is a
// no-op and the assertion would fail a CI container run).
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
test("syncdir-fault-throws (g1s5-c1 finding 3): a permission fault on the directory fsync step throws SpoolIoError — never swallowed", (t) => {
  const dir = tmp();
  const sub = path.join(dir, "obj");
  try {
    // happy path: a readable dir syncs without ceremony
    mkdirSync(sub);
    syncDirEntry(sub);
    if (IS_ROOT) {
      t.skip("chmod 0o000 does not block root (CAP_DAC_OVERRIDE) — fault path untestable");
      return;
    }
    // fault path: open of the directory itself fails (EACCES is NOT a
    // platform fsync refusal) → typed, retryable error
    chmodSync(sub, 0o000);
    let threw = false;
    try {
      assert.throws(() => syncDirEntry(sub), SpoolIoError);
      threw = true;
    } finally {
      chmodSync(sub, 0o755);
    }
    assert.ok(threw, "the fault-path assertion must have run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spool-a-overcap-refused: over-cap draft refused AT INPUT, nothing written", () => {
  const dir = tmp();
  try {
    const big = Buffer.alloc(DRAFT_CAP_BYTES + 1, 0x61);
    assert.throws(() => spoolDraft(dir, big), IntakeInputError);
    assert.equal(existsSync(path.join(dir, "drafts")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spool-a-preact-crash-no-act: crash after (i) fsync before (ii) act append — the orphan spool object is inert storage", () => {
  // The crash state reproduced directly: spool bytes durable, NO act
  // appended — NOTHING exists to refuse, resolve, or owe. The orphan
  // is inert: intake is act-driven, so no refusal record can exist
  // (drift resolution names a refusal record — impossible here), and
  // a later normal filing re-uses the same content-addressed entry.
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    const digest = spoolDraft(dir, bytes); // step (i) durable…
    // …crash BEFORE step (ii): no act was ever appended.
    assert.ok(existsSync(spoolPath(dir, digest)));
    // inert: drift resolution names (refusedActId, refusalRecordId)
    // of a standing drift refusal — with NO act appended there is no
    // refusal record, so NO resolution operand can ever be formed
    // (the predicate's shape check is unsatisfiable — nothing to
    // resolve and nothing owed):
    const standingRefusals: { refusedActId: string }[] = []; // none exist
    assert.equal(standingRefusals.length, 0);
    // the owner re-confirms normally: same bytes dedup to the entry,
    // and the filing applies over the pre-existing spool object:
    assert.equal(spoolDraft(dir, bytes), digest);
    const res = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytes)), producer: PRODUCER, existingIds: new Set(), now: 9,
    });
    assert.equal(res.status, "applied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spool: byte-identical re-spool dedups; divergent entry is an integrity refusal (never replaced)", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    const d1 = spoolDraft(dir, bytes);
    const d2 = spoolDraft(dir, bytes);
    assert.equal(d1, d2);
    const other = draftBytes(baseHeader(), "different prose");
    const dOther = spoolDraft(dir, other);
    assert.notEqual(dOther, d1); // different content ⇒ different address
    // force corruption AT an address:
    writeFileSync(spoolPath(dir, d1), Buffer.from("tampered", "utf8"));
    assert.throws(() => spoolDraft(dir, bytes), IntakeInputError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spool-a-rerehash-mismatch-drift: intake re-hashes the spool only (live path NEVER read); absent vs mismatch self-evidence", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    const digest = sha(bytes);
    assert.deepEqual(readSpool(dir, digest), { state: "absent" });
    mkdirSync(path.dirname(spoolPath(dir, digest)), { recursive: true });
    writeFileSync(spoolPath(dir, digest), Buffer.from("not-the-draft", "utf8"));
    const r = readSpool(dir, digest);
    assert.equal(r.state, "mismatch");
    if (r.state === "mismatch") assert.equal(r.observedSha256, sha("not-the-draft"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spool-a-bad-digest-input-channel: readSpool/spoolPath refuse a non-hex digest on the INPUT channel, never as SpoolIoError (g1s5-c3 C3-F1)", () => {
  // g1s5-c3 (C3-F1): the io-catch used to wrap spoolPath's validation,
  // laundering IntakeInputError into a retryable SpoolIoError.
  const dir = tmp();
  try {
    for (const bad of ["not-hex", "", "0".repeat(63), "A".repeat(64)]) {
      assert.throws(() => readSpool(dir, bad), IntakeInputError, `digest '${bad}' must be an INPUT refusal`);
      assert.throws(() => spoolPath(dir, bad), IntakeInputError);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ================= MAJOR-2 / MAJOR-3: byte-preserving transport &
   absence-vs-IO split ================= */

test("spool-a-nonutf8-refused-at-input (MAJOR-2): a 0xFF draft never reaches the spool — the lossless UTF-8 adjudicated-bytes transport is enforced at the producer entry, nothing written", () => {
  const dir = tmp();
  try {
    const bad = Buffer.concat([Buffer.from(`${DRAFT_MAGIC}\n{"claim":"x"}\n`, "utf8"), Buffer.from([0xff, 0xfe])]);
    assert.throws(() => spoolDraft(dir, bad), IntakeInputError);
    assert.equal(existsSync(path.join(dir, "drafts")), false);
    // parseDraft agrees (fatal decoding): the same bytes fail there too
    assert.throws(() => parseDraft(bad), IntakeInputError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spool-a-io-error-not-drift (MAJOR-3): a permission fault is SpoolIoError (retryable), NEVER a terminal absent-drift refusal", (t) => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    const digest = sha(bytes);
    mkdirSync(path.dirname(spoolPath(dir, digest)), { recursive: true });
    writeFileSync(spoolPath(dir, digest), bytes);
    if (IS_ROOT) {
      // g1s5-c1 (C1b): chmod 0o000 does not block root — skip the fault
      // path (previously the test failed under a CI root run).
      t.skip("chmod 0o000 does not block root (CAP_DAC_OVERRIDE) — fault path untestable");
      return;
    }
    chmodSync(spoolPath(dir, digest), 0o000);
    let threw = false;
    try {
      assert.throws(() => readSpool(dir, digest), SpoolIoError);
      threw = true;
    } finally {
      chmodSync(spoolPath(dir, digest), 0o644);
    }
    if (!threw) throw new Error("unreadable spool entry must throw SpoolIoError");
    // and the intake path propagates it (not a refusal):
    const res = () =>
      intakeFiling({
        episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
        act: filingAct(payloadFor(bytes)), producer: PRODUCER, existingIds: new Set(), now: 1,
      });
    chmodSync(spoolPath(dir, digest), 0o000);
    try {
      assert.throws(res, SpoolIoError);
    } finally {
      chmodSync(spoolPath(dir, digest), 0o644);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ================= draft parse ================= */

test("parseDraft: magic required; header must be one JSON object", () => {
  const good = draftBytes(baseHeader());
  const parsed = parseDraft(good);
  assert.equal(parsed.header["claim"], "parser drops trailing token");
  assert.equal(parsed.prose, "full prose evidence");
  assert.throws(() => parseDraft(Buffer.from("nope\n{}\n")), IntakeInputError);
  assert.throws(() => parseDraft(Buffer.from(`${DRAFT_MAGIC}\nnot json\n`)), IntakeInputError);
  assert.throws(() => parseDraft(Buffer.from(`${DRAFT_MAGIC}\n[1,2]\n`)), IntakeInputError);
  assert.throws(() => parseDraft(Buffer.from(`${DRAFT_MAGIC}\n\n`)), IntakeInputError);
});

/* ================= prefix binding (NDR-d/e/i) ================= */

test("prefix binding: empty prefix binds empty id + chain origin; non-empty binds last record id", () => {
  const empty = prefixBinding([]);
  assert.equal(empty.intakePrefixEndId, "");
  assert.equal(empty.intakePrefixSha256, prefixDigestInitial());
  const pfx: PrefixRecord[] = [
    { kind: "audit-finding", id: "01A", severity: "major", route: "code-fix", correctionOf: null, claim: "c" },
    { kind: "owner-act", id: "01B", op: "audit-filing" },
  ];
  const b = prefixBinding(linesOf(pfx));
  assert.equal(b.intakePrefixEndId, "01B");
  // running digest = fold of canonical lines, order-sensitive:
  let d = prefixDigestInitial();
  for (const r of pfx) d = prefixDigestStep(d, JSON.stringify(r));
  assert.equal(b.intakePrefixSha256, d);
  assert.notEqual(prefixBinding(linesOf(pfx.slice(0, 1))).intakePrefixSha256, d);
});

/* ================= filing adjudication ================= */

test("owner-path stage (4) vocab guard (g1s3-c7): a draft header with an out-of-set severity refuses malformed-input with embedded bytes", () => {
  const dir = tmp();
  try {
    // The guard `if (vf.length > 0) return refusal("malformed-input"…)`
    // had NO filing-level test (unit tests covered vocabValidate alone,
    // so the mutation survived) — this pins the wiring on the owner path.
    const bytes = draftBytes(baseHeader({ severity: "critical" }));
    spoolDraft(dir, bytes);
    const res = intakeFiling({
      episodeDir: dir,
      episodeId: "ep-1",
      prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytes)),
      producer: PRODUCER,
      existingIds: new Set(),
      now: 5,
    });
    assert.equal(res.status, "refused");
    if (res.status !== "refused") return;
    assert.equal(res.refusal.diagnosticCode, "malformed-input");
    assert.equal(res.refusal.checkClass, "draft-derivative");
    assert.equal(sha(res.refusal.adjudicatedDraftBytes ?? ""), sha(bytes));
    assert.equal(existsSync(path.join(dir, "findings")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("embed-lossless guard (g1s3-c7): spool bytes matching the claimed digest but NOT losslessly UTF-8-embeddable throw IntegrityFaultError — never a lossy refusal", () => {
  const dir = tmp();
  try {
    // Simulate storage integrity failure: the spool entry carries
    // non-UTF-8 bytes whose digest the act still claims (bypassing
    // the producer's spoolDraft UTF-8 gate). readSpool re-hashes OK
    // (state "ok"), parseDraft's fatal decode raises IntakeInputError,
    // and the refusal builder's embed() MUST refuse to emit lossy
    // adjudicated bytes — an unreplayable digest is worse than a crash.
    const good = draftBytes(baseHeader());
    spoolDraft(dir, good);
    const evil = Buffer.from([0xff, 0xfe, 0x00, 0x41]); // invalid UTF-8
    writeFileSync(spoolPath(dir, sha(evil)), evil);
    const res = intakeFiling({
      episodeDir: dir,
      episodeId: "ep-1",
      prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(evil)),
      producer: PRODUCER,
      existingIds: new Set(),
      now: 11,
    });
    // With the guard live this THROWS (never reaches a refusal).
    void res;
    assert.fail("expected IntegrityFaultError — lossy embed must never produce a refusal");
  } catch (e) {
    assert.ok(e instanceof IntegrityFaultError, `expected IntegrityFaultError, got ${String(e)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MAJOR-8 prefixLines/prefix divergence guard (g1s3-c7): adjudicateFiling throws an implementation fault when the two views of the prefix disagree in length", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    spoolDraft(dir, bytes);
    const pfx: PrefixRecord[] = [{ kind: "note", id: "01P" }];
    assert.throws(
      () =>
        adjudicateFiling({
          episodeDir: dir,
          episodeId: "ep-1",
          prefix: pfx,
          prefixLines: [], // divergent view — canonical lines missing the record
          act: filingAct(payloadFor(bytes)),
          producer: PRODUCER,
          existingIds: new Set(),
          now: 12,
          normGate: PASS_GATE,
          gateJournalPath: gJournal(dir),
        }),
      /diverge/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s6-F2 prefix-same-identity-divergent-fields: a line with the SAME id/kind but a different op is the divergent-views fault (full-record equality, not identity-only)", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    spoolDraft(dir, bytes);
    // The auditor's exact F2 repro: the CLAIMED view says the act is a
    // residual-cure (cure resolution would resolve against it), while
    // the canonical line the binding digests says op:"audit-filing" —
    // the adjudication would bind foreign bytes. Identity-only
    // checking (pre-fix) passed this pair.
    const pfx: PrefixRecord[] = [
      { kind: "owner-act", id: "01CURE0000000000000000CC", op: "residual-cure" },
    ];
    const foreignLine = JSON.stringify({ kind: "owner-act", id: "01CURE0000000000000000CC", op: "audit-filing" });
    assert.throws(
      () =>
        adjudicateFiling({
          episodeDir: dir,
          episodeId: "ep-1",
          prefix: pfx,
          prefixLines: [foreignLine],
          act: filingAct(payloadFor(bytes)),
          producer: PRODUCER,
          existingIds: new Set(),
          now: 12,
          normGate: PASS_GATE,
          gateJournalPath: gJournal(dir),
        }),
      /divergent views/,
    );
    // an EXTRA field on the line the claimed record lacks is equally
    // divergent (key-set equality, not just common keys)
    assert.throws(
      () =>
        adjudicateFiling({
          episodeDir: dir,
          episodeId: "ep-1",
          prefix: pfx,
          prefixLines: [JSON.stringify({ kind: "owner-act", id: "01CURE0000000000000000CC", op: "residual-cure", extra: 1 })],
          act: filingAct(payloadFor(bytes)),
          producer: PRODUCER,
          existingIds: new Set(),
          now: 12,
          normGate: PASS_GATE,
          gateJournalPath: gJournal(dir),
        }),
      /divergent views/,
    );
    // NOT a fault: key ORDER is irrelevant to record identity — the
    // same record serialized with permuted keys must adjudicate.
    const res = adjudicateFiling({
      episodeDir: dir,
      episodeId: "ep-1",
      prefix: pfx,
      prefixLines: [JSON.stringify({ op: "residual-cure", id: "01CURE0000000000000000CC", kind: "owner-act" })],
      act: filingAct(payloadFor(bytes)),
      producer: PRODUCER,
      existingIds: new Set(),
      now: 12,
      normGate: PASS_GATE,
      gateJournalPath: gJournal(dir),
    });
    assert.ok(res.status === "applied" || res.status === "refused" || res.status === "refused-gate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s5-c4 C4-F3: equal-length but CONTENT-divergent prefix views are an implementation fault (foreign bytes could never bind)", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    spoolDraft(dir, bytes);
    const pfx: PrefixRecord[] = [{ kind: "note", id: "01A" }];
    // same LENGTH, different content: line carries id "01B" not "01A"
    assert.throws(
      () =>
        adjudicateFiling({
          episodeDir: dir,
          episodeId: "ep-1",
          prefix: pfx,
          prefixLines: [JSON.stringify({ kind: "note", id: "01B" })],
          act: filingAct(payloadFor(bytes)),
          producer: PRODUCER,
          existingIds: new Set(),
          now: 12,
          normGate: PASS_GATE,
          gateJournalPath: gJournal(dir),
        }),
      /divergent views/,
    );
    // a non-JSON line against a claimed record is the same fault
    assert.throws(
      () =>
        adjudicateFiling({
          episodeDir: dir,
          episodeId: "ep-1",
          prefix: pfx,
          prefixLines: ["not json"],
          act: filingAct(payloadFor(bytes)),
          producer: PRODUCER,
          existingIds: new Set(),
          now: 12,
          normGate: PASS_GATE,
          gateJournalPath: gJournal(dir),
        }),
      /divergent views/,
    );
    // LONGER-view case the content loop cannot see: extra canonical
    // lines beyond the claimed records would fold into the digest
    // unchecked — only the LENGTH guard refuses (g1s5-c4 mutant check).
    assert.throws(
      () =>
        adjudicateFiling({
          episodeDir: dir,
          episodeId: "ep-1",
          prefix: pfx,
          prefixLines: [JSON.stringify({ kind: "note", id: "01A" }), JSON.stringify({ kind: "note", id: "01EXTRA" })],
          act: filingAct(payloadFor(bytes)),
          producer: PRODUCER,
          existingIds: new Set(),
          now: 12,
          normGate: PASS_GATE,
          gateJournalPath: gJournal(dir),
        }),
      /diverge/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s5-c4 C4-F1: ENOTDIR is NOT a platform fsync refusal — a broken path component (dir is a regular file) rides the durability channel", () => {
  const dir = tmp();
  try {
    const blocker = path.join(dir, "regular");
    writeFileSync(blocker, "not a dir");
    // openSync("<regular file>/child" , "r") is ENOTDIR: pre-fix this
    // was swallowed as a "platform refusal" and MAJOR-9 passed silently.
    assert.throws(() => syncDirEntry(path.join(blocker, "child")), SpoolIoError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s5-c4 C4-F2: a gate throwing a NON-Error still journals a gateError (string message, never a dropped key)", () => {
  const dir = tmp();
  try {
    const res = admitAuditorFinding(
      dir,
      { episodeId: "ep-1", taskId: "t1", receiptId: "r-9", candidate: auditorCandidate(), now: 5 },
      {
        takenIds: new Set(),
        artifactBytes: Buffer.from("x", "utf8"),
        normGate: () => {
          // eslint-disable-next-line no-throw-literal
          throw "plain string boom";
        },
        journalPath: path.join(dir, "j.jsonl"),
      },
    );
    assert.equal(res.status, "refused-gate");
    if (res.status !== "refused-gate") return;
    assert.equal(res.journal.refusalCode, "gate-error");
    // pre-fix: (e as Error).message on a string is undefined and
    // JSON.stringify dropped the key — the journal lied.
    assert.ok(typeof res.journal.gateError === "string" && res.journal.gateError.includes("plain string boom"),
      `gateError must carry the thrown string, got ${JSON.stringify(res.journal.gateError)}`);
    const journaled = readFileSync(path.join(dir, "j.jsonl"), "utf8");
    assert.ok(journaled.includes("gateError"), "the durable line must carry the gateError key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filing applied: artifact durable, claimDigest = sha256(artifact), cycle from ACT payload only", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    spoolDraft(dir, bytes);
    const res = intakeFiling({
      episodeDir: dir,
      episodeId: "ep-1",
      prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytes)),
      producer: PRODUCER,
      existingIds: new Set(),
      now: 42,
    });
    assert.equal(res.status, "applied");
    if (res.status !== "applied") return;
    const f = res.finding;
    assert.equal(isUlid(f.id), true);
    assert.equal(f.claimDigest, sha(bytes));
    assert.ok(existsSync(res.artifactPath));
    assert.deepEqual(readFileSync(res.artifactPath), bytes);
    assert.equal(f.cycle, 3);
    assert.equal(f.origin, "owner");
    assert.equal(f.ownerActRef, "01ACT0000000000000000000AA");
    assert.equal(f.originRef, null);
    assert.equal(f.findingRef, path.join("findings", f.id));
    assert.deepEqual(f.scopeRefs, ["src/x.ts#L1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spool-a-act-present-spool-missing: act exists, re-hash fails — terminal drift + resolution path, empty-by-refusal (bytes NOT embedded)", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    const pfx: PrefixRecord[] = [{ kind: "note", id: "01P" }];
    const res = intakeFiling({
      episodeDir: dir,
      episodeId: "ep-1",
      prefix: pfx, prefixLines: linesOf(pfx), normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytes)),
      producer: PRODUCER,
      existingIds: new Set(),
      now: 7,
    });
    assert.equal(res.status, "refused");
    if (res.status !== "refused") return;
    const r = res.refusal;
    assert.equal(r.diagnosticCode, "owner-filing-draft-drift");
    assert.equal(r.checkClass, "filesystem-observation");
    assert.equal(r.spoolObserved, "absent");
    assert.equal(r.observedSha256, null);
    assert.equal(r.adjudicatedDraftBytes, null);
    // NDR-d/e: binds the prefix intake READ (the refusal's predecessor)
    const b = prefixBinding(linesOf(pfx));
    assert.equal(r.intakePrefixEndId, b.intakePrefixEndId);
    assert.equal(r.intakePrefixSha256, b.intakePrefixSha256);
    assert.equal(r.refusedActId, "01ACT0000000000000000000AA");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift: spool mismatch carries the observed digest (self-evidence)", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    const digest = sha(bytes);
    mkdirSync(path.dirname(spoolPath(dir, digest)), { recursive: true });
    writeFileSync(spoolPath(dir, digest), Buffer.from("tampered", "utf8"));
    const res = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytes)), producer: PRODUCER, existingIds: new Set(), now: 7,
    });
    assert.equal(res.status, "refused");
    if (res.status !== "refused") return;
    assert.equal(res.refusal.diagnosticCode, "owner-filing-draft-drift");
    assert.equal(res.refusal.spoolObserved, "mismatch");
    assert.equal(res.refusal.observedSha256, sha("tampered"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mapping: claim mismatch is owner-filing-mapping with EMBEDDED bytes re-digesting to draftSha256", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    spoolDraft(dir, bytes);
    const res = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytes, { claim: "a DIFFERENT claim" })),
      producer: PRODUCER, existingIds: new Set(), now: 7,
    });
    assert.equal(res.status, "refused");
    if (res.status !== "refused") return;
    const r = res.refusal;
    assert.equal(r.diagnosticCode, "owner-filing-mapping");
    assert.equal(r.checkClass, "draft-derivative");
    assert.ok(r.adjudicatedDraftBytes !== null);
    assert.equal(sha(Buffer.from(r.adjudicatedDraftBytes as string, "utf8")), sha(bytes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mapping: NFC-equal claim (byte-different in payload) is EQUAL — applied (NDR-c governs the comparison)", () => {
  const dir = tmp();
  try {
    const header = baseHeader({ claim: "unicode caf\u00e9 defect" });
    const bytes = draftBytes(header);
    spoolDraft(dir, bytes);
    const res = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytes, { claim: "unicode cafe\u0301 defect" })),
      producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(res.status, "applied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mapping: cureActRef header/payload divergence refused; header omission refused (v28 R5-C20P-2)", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader({ cureActRef: "cure-1" }));
    spoolDraft(dir, bytes);
    const r1 = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytes, { cureActRef: null })),
      producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(r1.status, "refused");
    if (r1.status === "refused") assert.equal(r1.refusal.diagnosticCode, "owner-filing-mapping");

    const bytesNoField = draftBytes({ ...baseHeader(), cureActRef: undefined });
    spoolDraft(dir, bytesNoField);
    const r2 = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytesNoField)),
      producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(r2.status, "refused");
    if (r2.status === "refused") assert.equal(r2.refusal.diagnosticCode, "owner-filing-mapping");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cycle has NO header source: a header cycle is ignored — act payload is the sole source (v9 R4-C3-1)", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader({ cycle: 99 } as Record<string, unknown>));
    spoolDraft(dir, bytes);
    const res = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytes, { cycle: 5 })),
      producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(res.status, "applied");
    if (res.status === "applied") assert.equal(res.finding.cycle, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cure-unknown-act: unknown id refused (MIXED class, bytes embedded); resolves only to a residual-cure act", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader({ cureActRef: "01NOPE0000000000000000BB" }));
    spoolDraft(dir, bytes);
    const res = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytes, { cureActRef: "01NOPE0000000000000000BB" })),
      producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(res.status, "refused");
    if (res.status !== "refused") return;
    assert.equal(res.refusal.diagnosticCode, "cure-unknown-act");
    assert.equal(res.refusal.checkClass, "mixed");
    assert.ok(res.refusal.adjudicatedDraftBytes !== null);

    // resolves when the prefix carries a residual-cure act with that id
    // (header AND payload carry the cure id — step-6 comparison):
    const cureBytes = draftBytes(baseHeader({ cureActRef: "01CURE0000000000000000CC" }));
    spoolDraft(dir, cureBytes);
    const curePrefix: PrefixRecord[] = [
      { kind: "owner-act", id: "01CURE0000000000000000CC", op: "residual-cure" },
    ];
    const res2 = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: curePrefix, prefixLines: linesOf(curePrefix), normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(cureBytes, { cureActRef: "01CURE0000000000000000CC" })),
      producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(res2.status, "applied");
    if (res2.status === "applied") {
      assert.equal(res2.finding.cureActRef, "01CURE0000000000000000CC");
      // identity binds the cure prefix in the refusal-free path too:
      assert.equal(res2.finding.cycle, 3);
    }

    // a NON-cure act with the right id is still unknown (op must
    // match) — header AND payload carry the id so step 6 passes:
    const res3 = intakeFiling({
      episodeDir: dir, episodeId: "ep-1",
      prefix: [{ kind: "owner-act", id: "01CURE0000000000000000CC", op: "audit-filing" }],
      prefixLines: [JSON.stringify({ kind: "owner-act", id: "01CURE0000000000000000CC", op: "audit-filing" })],
      normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(cureBytes, { cureActRef: "01CURE0000000000000000CC" })),
      producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(res3.status, "refused");
    if (res3.status === "refused") assert.equal(res3.refusal.diagnosticCode, "cure-unknown-act");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ================= correction lineage (MIXED) ================= */

function correctionFixture(over: {
  targetClosed: "rejected-refuted" | "accepted-fix" | "none";
  sibling?: boolean;
  headerOver?: Record<string, unknown>;
}) {
  const dir = tmp();
  const targetId = "01TGT0000000000000000000TT";
  const pfx: PrefixRecord[] = [
    { kind: "audit-finding", id: targetId, severity: "major", route: "code-fix", correctionOf: null, claim: "old claim" },
  ];
  if (over.targetClosed !== "none") {
    pfx.push({ kind: "audit-finding-update", id: "01U0", findingId: targetId, to: over.targetClosed });
  }
  if (over.sibling) {
    pfx.push({ kind: "audit-finding", id: "01SIB00000000000000000SS", severity: "major", route: "code-fix", correctionOf: targetId, claim: "sibling correction" });
  }
  return { dir, pfx, targetId };
}

test("correction-bad-target: unknown target or non-rejected-refuted closure refused (MIXED + bytes)", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader({ correctionOf: "01GHOST000000000000000GG" }));
    spoolDraft(dir, bytes);
    const r1 = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytes)), producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(r1.status, "refused");
    if (r1.status === "refused") {
      assert.equal(r1.refusal.diagnosticCode, "correction-bad-target");
      assert.equal(r1.refusal.checkClass, "mixed");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const fx = correctionFixture({ targetClosed: "accepted-fix" });
  try {
    const bytes = draftBytes(baseHeader({ correctionOf: fx.targetId }));
    spoolDraft(fx.dir, bytes);
    const res = intakeFiling({
      episodeDir: fx.dir, episodeId: "ep-1", prefix: fx.pfx, prefixLines: linesOf(fx.pfx), normGate: PASS_GATE, gateJournalPath: gJournal(fx.dir),
      act: filingAct(payloadFor(bytes)), producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(res.status, "refused");
    if (res.status === "refused") assert.equal(res.refusal.diagnosticCode, "correction-bad-target");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("correction-ambiguity: a second correction of the same target refused", () => {
  const fx = correctionFixture({ targetClosed: "rejected-refuted", sibling: true });
  try {
    const bytes = draftBytes(baseHeader({ correctionOf: fx.targetId }));
    spoolDraft(fx.dir, bytes);
    const res = intakeFiling({
      episodeDir: fx.dir, episodeId: "ep-1", prefix: fx.pfx, prefixLines: linesOf(fx.pfx), normGate: PASS_GATE, gateJournalPath: gJournal(fx.dir),
      act: filingAct(payloadFor(bytes)), producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(res.status, "refused");
    if (res.status === "refused") assert.equal(res.refusal.diagnosticCode, "correction-ambiguity");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("correction-severity-decrease / correction-route-mismatch refused; preserved correction applied", () => {
  const fx = correctionFixture({ targetClosed: "rejected-refuted" });
  try {
    const down = draftBytes(baseHeader({ correctionOf: fx.targetId, severity: "minor" }));
    spoolDraft(fx.dir, down);
    const r1 = intakeFiling({
      episodeDir: fx.dir, episodeId: "ep-1", prefix: fx.pfx, prefixLines: linesOf(fx.pfx), normGate: PASS_GATE, gateJournalPath: gJournal(fx.dir),
      act: filingAct(payloadFor(down)), producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(r1.status, "refused");
    if (r1.status === "refused") assert.equal(r1.refusal.diagnosticCode, "correction-severity-decrease");

    const rerouted = draftBytes(baseHeader({ correctionOf: fx.targetId, route: "human-review" }));
    spoolDraft(fx.dir, rerouted);
    const r2 = intakeFiling({
      episodeDir: fx.dir, episodeId: "ep-1", prefix: fx.pfx, prefixLines: linesOf(fx.pfx), normGate: PASS_GATE, gateJournalPath: gJournal(fx.dir),
      act: filingAct(payloadFor(rerouted)), producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(r2.status, "refused");
    if (r2.status === "refused") assert.equal(r2.refusal.diagnosticCode, "correction-route-mismatch");

    const good = draftBytes(baseHeader({ correctionOf: fx.targetId, severity: "blocker" }));
    spoolDraft(fx.dir, good);
    const r3 = intakeFiling({
      episodeDir: fx.dir, episodeId: "ep-1", prefix: fx.pfx, prefixLines: linesOf(fx.pfx), normGate: PASS_GATE, gateJournalPath: gJournal(fx.dir),
      act: filingAct(payloadFor(good)), producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(r3.status, "applied");
    if (r3.status === "applied") assert.equal(r3.finding.correctionOf, fx.targetId);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

/* ================= NDR-b floor & malformed ================= */

test("finding-intake-invalid: non-minor + repro.kind none refused at the NDR-b floor (route-free)", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader({
      severity: "major",
      repro: { kind: "none", command: "", preFixObserved: "", postFixExpected: "" },
    }));
    spoolDraft(dir, bytes);
    const res = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytes)), producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(res.status, "refused");
    if (res.status === "refused") {
      assert.equal(res.refusal.diagnosticCode, "finding-intake-invalid");
      assert.equal(res.refusal.checkClass, "draft-derivative");
      assert.ok(res.refusal.adjudicatedDraftBytes !== null);
    }
    // minor + none is admitted:
    const minorBytes = draftBytes(baseHeader({
      severity: "minor",
      repro: { kind: "none", command: "", preFixObserved: "", postFixExpected: "" },
    }));
    spoolDraft(dir, minorBytes);
    const r2 = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(minorBytes)), producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(r2.status, "applied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// g1s5-c1 C1-F1: stage (9/10)'s reproWireShapeOk on the OWNER path is NOT
// redundant with vocabValidate — vocab only checks repro.kind membership, so
// a header with a CLOSED kind and malformed operand strings passes vocab and
// must be refused by the wire-shape guard. (The mutation script's old
// "equivalent mutant" note was false: removing the guard admits
// `{kind:"probe", command:"x"}` at severity minor — proven by this test +
// the repro-shape-off mutant.) Non-minor was NOT chosen deliberately: with
// severity major the SAME input would refuse at the NDR-b floor anyway if
// wire-shape were removed... it would not — kind "probe" passes the floor.
// Use probe/x at minor so ONLY wire-shape can refuse.
test("repro-wire-shape (g1s5-c1 C1-F1): closed kind with malformed operand strings refused — vocab alone does NOT catch it", () => {
  const dir = tmp();
  try {
    // valid closed kind, missing two operand strings entirely:
    const badMissing = draftBytes(baseHeader({
      severity: "minor",
      repro: { kind: "probe", command: "x" },
    }));
    spoolDraft(dir, badMissing);
    const r1 = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(badMissing)), producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(r1.status, "refused");
    if (r1.status === "refused") assert.equal(r1.refusal.diagnosticCode, "finding-intake-invalid");
    // non-string operand (numeric) — same refusal:
    const badType = draftBytes(baseHeader({
      severity: "minor",
      repro: { kind: "probe", command: 7, preFixObserved: "p", postFixExpected: "q" },
    }));
    spoolDraft(dir, badType);
    const r2 = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(badType)), producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(r2.status, "refused");
    // EMPTY operands on a non-none kind — refused (kind none + empties is
    // the only empty-operand shape that stands):
    const badEmpty = draftBytes(baseHeader({
      severity: "minor",
      repro: { kind: "trace", command: "", preFixObserved: "", postFixExpected: "" },
    }));
    spoolDraft(dir, badEmpty);
    const r3 = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(badEmpty)), producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(r3.status, "refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BOM-rejection (g1s5-c1 C1-F2): a UTF-8 BOM before the magic is refused — TextDecoder never silently strips it", () => {
  const dir = tmp();
  try {
    const clean = draftBytes(baseHeader());
    const bommed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), clean]);
    // direct parseDraft: BOM bytes survive decoding → magic mismatch:
    assert.throws(() => parseDraft(bommed), /magic/);
    // through intake: stage (3) catches the input fault and refuses with
    // malformed-input (the adjudicated channel), nothing admitted:
    spoolDraft(dir, bommed);
    const r = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bommed)), producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(r.status, "refused");
    if (r.status === "refused") assert.equal(r.refusal.diagnosticCode, "malformed-input");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed-input (g1s2-c1 MAJOR-1): bad act payload shape THROWS MalformedOwnerActError — never a refusal (bytes unread)", () => {
  const dir = tmp();
  try {
    const bad = { findingDraftRef: "x", draftSha256: "not-hex", claim: "c", cycle: 1, taskId: null, cureActRef: null };
    // A payload-shape failure precedes ANY byte reading, so no
    // draft-derivative refusal (bytes embedding draftSha256) is
    // constructible — the typed error propagates and the act must
    // never have been appended.
    assert.throws(
      () =>
        intakeFiling({
          episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
          act: filingAct(bad as unknown as AuditFilingPayload),
          producer: PRODUCER, existingIds: new Set(), now: 1,
        }),
      MalformedOwnerActError,
    );
    assert.equal(existsSync(path.join(dir, "drafts")), false);
    assert.equal(existsSync(gJournal(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("act-episode binding (g1s3-c5): an act whose envelope episodeId differs THROWS ForeignActEpisodeError — never adjudicated here", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    spoolDraft(dir, bytes);
    const payload = payloadFor(bytes);
    // Same doctrine as the stage-(1) payload failure and the auditor
    // path's foreign-episode refusal: a foreign-episode act must never
    // be adjudicated (or have its refusal appended) in this episode.
    assert.throws(
      () =>
        intakeFiling({
          episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
          act: filingAct(payload, { episodeId: "ep-OTHER" }),
          producer: PRODUCER, existingIds: new Set(), now: 1,
        }),
      ForeignActEpisodeError,
    );
    // Throws BEFORE any effect: no gate journal, no artifacts.
    assert.equal(existsSync(gJournal(dir)), false);
    assert.equal(existsSync(path.join(dir, "findings")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refusal id is minted and NOT among existing ids (collision refusal shared)", () => {
  const dir = tmp();
  try {
    const taken = new Set<string>();
    // drift refusal (spool absent): the payload is shape-valid so
    // intake reaches the refusal stage and mints the refusal id.
    const bytes = draftBytes(baseHeader());
    const res = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytes)),
      producer: PRODUCER, existingIds: taken, now: 1,
    });
    assert.equal(res.status, "refused");
    if (res.status === "refused") {
      assert.equal(isUlid(res.refusal.id), true);
      taken.add(res.refusal.id);
      assert.equal(taken.size, 1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ================= G2-gate stub (MAJOR-7) ================= */

function auditorCandidate(over: Record<string, unknown> = {}): any {
  return {
    schema: "tre-supervisor/1",
    ts: 1,
    episodeId: "ep-1",
    taskId: "t1",
    kind: "audit-finding",
    cycle: 1,
    origin: "auditor",
    producer: PRODUCER,
    ownerActRef: null,
    originRef: { origin: "intake", receiptId: "r-9" },
    correctionOf: null,
    route: "code-fix",
    surface: "code",
    severity: "major",
    verdictBasis: "repro",
    claim: "auditor claim",
    scopeRefs: [],
    repro: OK_REPRO,
    evidenceRefs: ["sess-1"],
    cureActRef: null,
    affectedNorm: null,
    ...over,
  };
}

test("gate: pass admits with claimDigest over artifact bytes", () => {
  const dir = tmp();
  try {
    const art = Buffer.from("auditor full prose", "utf8");
    const res = admitAuditorFinding(
      dir,
      { episodeId: "ep-1", taskId: "t1", receiptId: "r-9", candidate: auditorCandidate(), now: 1 },
      {
        takenIds: new Set(),
        artifactBytes: art,
        normGate: () => ({ pass: true }),
        journalPath: path.join(dir, "s5", "decisions.jsonl"),
      },
    );
    assert.equal(res.status, "admitted");
    if (res.status !== "admitted") return;
    assert.equal(res.finding.claimDigest, sha(art));
    assert.equal(isUlid(res.finding.id), true);
    assert.equal(res.finding.originRef?.origin, "intake");
    assert.equal(existsSync(path.join(dir, "s5", "decisions.jsonl")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ndr-t2-gate-journal: fail refuses, journals the line hash; record NEVER becomes an audit-finding (ndr-t2-gate-never-finding)", () => {
  const dir = tmp();
  try {
    const journalPath = path.join(dir, "s5", "decisions.jsonl");
    // MINOR-2: capture the ACTUAL gated record and independently
    // recompute its canonical-line sha256 — the journal entry must
    // name the refused line's content hash, not merely look like it.
    let gated: AuditFinding | null = null;
    const res = admitAuditorFinding(
      dir,
      { episodeId: "ep-1", taskId: "t1", receiptId: "r-9", candidate: auditorCandidate(), now: 5 },
      {
        takenIds: new Set(),
        artifactBytes: Buffer.from("x", "utf8"),
        normGate: (rec) => {
          gated = rec;
          return { pass: false, code: "norm-unbound" };
        },
        journalPath,
      },
    );
    assert.equal(res.status, "refused-gate");
    if (res.status !== "refused-gate") return;
    assert.equal(res.journal.refusalCode, "norm-unbound");
    assert.equal(res.journal.gateError, null);
    assert.ok(isSha256Hex(res.journal.lineSha256));
    assert.ok(gated !== null, "the gate must have been handed the record");
    assert.equal(
      res.journal.lineSha256,
      sha(JSON.stringify(gated)),
      "journal names the sha256 of the gated record's canonical JSONL line",
    );
    const lines = readFileSync(journalPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const j = JSON.parse(lines[0] as string);
    assert.equal(j.kind, "norm-gate-refusal"); // NOT audit-filing-intake-refusal
    assert.equal(j.lineSha256, res.journal.lineSha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate: THROWING gate is fail-closed — refusal with the error journaled", () => {
  const dir = tmp();
  try {
    const res = admitAuditorFinding(
      dir,
      { episodeId: "ep-1", taskId: "t1", receiptId: "r-9", candidate: auditorCandidate(), now: 5 },
      {
        takenIds: new Set(),
        artifactBytes: Buffer.from("x", "utf8"),
        normGate: () => {
          throw new Error("gate exploded");
        },
        journalPath: path.join(dir, "j.jsonl"),
      },
    );
    assert.equal(res.status, "refused-gate");
    if (res.status !== "refused-gate") return;
    assert.equal(res.journal.refusalCode, "gate-error");
    assert.equal(res.journal.gateError, "gate exploded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate: only code-fix records are gated (human-review passes untouched); NDR-a/-t still enforced", () => {
  const dir = tmp();
  try {
    let gateCalls = 0;
    const res = admitAuditorFinding(
      dir,
      { episodeId: "ep-1", taskId: null, receiptId: "r-9", candidate: auditorCandidate({ route: "human-review", surface: "spec", taskId: null }), now: 1 },
      {
        takenIds: new Set(),
        artifactBytes: Buffer.from("y", "utf8"),
        normGate: () => {
          gateCalls++;
          return { pass: false, code: "never-reached" };
        },
        journalPath: path.join(dir, "j.jsonl"),
      },
    );
    assert.equal(res.status, "admitted");
    assert.equal(gateCalls, 0);

    // g1s4-c7 (mutation-audit finding): the two checks below were
    // pinned with a DELIBERATE receipt mismatch (receiptId "r" vs the
    // candidate's bound "r-9") — the receipt-binding refusal threw the
    // SAME IntakeInputError type, so BOTH tests passed VACUOUSLY with
    // the vocab check and the mode check mutated off (two surviving
    // mutants proven NON-equivalent: with them off, a severity
    // "critical" candidate and an entry-mode-invalid candidate are
    // ADMITTED). Fix: every input is receipt-consistent so ONLY the
    // intended check can refuse, and the refusal REASON is asserted
    // (a test must name the gate it pins, not merely the error type).
    const auditorOpts = (j: string): Parameters<typeof admitAuditorFinding>[2] => ({
      takenIds: new Set<string>(),
      artifactBytes: Buffer.from("z"),
      normGate: () => ({ pass: true }),
      journalPath: path.join(dir, j),
    });
    // vocab violation refused BEFORE the gate (NDR-t(1)) — receipt-
    // consistent, so the ONLY throwing check is the vocabulary one:
    assert.throws(
      () =>
        admitAuditorFinding(
          dir,
          { episodeId: "ep-1", taskId: null, receiptId: "r-9", candidate: auditorCandidate({ severity: "critical", taskId: null }), now: 1 },
          auditorOpts("j2.jsonl"),
        ),
      /closed vocabulary.*severity/,
    );
    assert.throws(
      () =>
        admitAuditorFinding(
          dir,
          { episodeId: "ep-1", taskId: null, receiptId: "r-9", candidate: auditorCandidate({ route: "nonsense", taskId: null }), now: 1 },
          auditorOpts("j2b.jsonl"),
        ),
      /closed vocabulary.*route/,
    );
    // Entry-mode-invalid candidate refused by NDR-a (g1s4-c7): an
    // `origin:"owner"` candidate presenting a well-shaped intake
    // originRef passes the envelope shape + vocab + receipt binding —
    // ONLY the mode check can refuse it (`entryModeOf` maps that
    // triple to NO mode: intake originRef with a non-auditor origin).
    assert.throws(
      () =>
        admitAuditorFinding(
          dir,
          { episodeId: "ep-1", taskId: null, receiptId: "r-9", candidate: auditorCandidate({ origin: "owner", taskId: null }), now: 1 },
          auditorOpts("j3.jsonl"),
        ),
      /auditor-intake mode.*NDR-a/,
    );
    // The original owner-triple candidate is refused EARLIER by the
    // envelope shape pin (originRef must be intake-shaped) — pinned
    // separately so its refusal source stays explicit.
    assert.throws(
      () =>
        admitAuditorFinding(
          dir,
          { episodeId: "ep-1", taskId: null, receiptId: "r-9", candidate: auditorCandidate({ origin: "owner", originRef: null, ownerActRef: "a-1", taskId: null }), now: 1 },
          auditorOpts("j4.jsonl"),
        ),
      /envelope shape: originRef/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// g1s5-c1 finding 1 (MAJOR-6 receipt binding was UNPINNED): removing
// `candidate.originRef.receiptId !== input.receiptId` failed ZERO tests
// — every suite input was receipt-consistent. Pin it now: a FOREIGN
// (well-shaped, valid-ULID) receiptId must refuse with the receipt
// reason named (not merely any IntakeInputError), before the gate,
// with nothing written. A different-but-valid receiptId is exactly
// what the guard exists for: the candidate must attest to THIS
// arrival's receipt, not merely to some past admission.
test("ndr-a-receipt-bind (g1s5-c1 finding 1): well-shaped candidate bound to a FOREIGN receiptId is refused — refusal names the receipt, nothing written", () => {
  const dir = tmp();
  try {
    const journalPath = path.join(dir, "s5", "receipt-j.jsonl");
    // foreign-but-valid receiptId (distinct ULID-shaped id)
    const foreign = mintUlid();
    assert.notEqual(foreign, "r-9");
    let gateCalls = 0;
    const before = readdirSync(dir).length;
    let thrown: unknown = null;
    try {
      admitAuditorFinding(
        dir,
        { episodeId: "ep-1", taskId: "t1", receiptId: "r-9", candidate: auditorCandidate({ originRef: { origin: "intake", receiptId: foreign } }), now: 1 },
        {
          takenIds: new Set<string>(),
          artifactBytes: Buffer.from("must-never-be-written", "utf8"),
          normGate: () => { gateCalls++; return { pass: true }; },
          journalPath,
        },
      );
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof IntakeInputError, `expected IntakeInputError, got ${String(thrown)}`);
    // The refusal REASON must name the receipt binding (a test that
    // only asserts the error TYPE cannot tell this guard from any
    // other IntakeInputError — the vacuity trap pinned at g1s4-c7).
    assert.match(String((thrown as Error).message), /receiptId/);
    assert.match(String((thrown as Error).message), /NDR-a receipt binding/);
    assert.equal(gateCalls, 0, "refused BEFORE the gate");
    assert.equal(existsSync(journalPath), false, "a throw-refusal journals nothing");
    assert.equal(existsSync(path.join(dir, "findings")), false, "no artifact written");
    assert.equal(readdirSync(dir).length, before, "episode dir untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* g1s3-c1: CLOSED-envelope strictness on the auditor path. Every
 * mutation below is a wire-level forgery the typed interface cannot
 * express; the runtime MUST refuse each (IntakeInputError) before the
 * candidate reaches the floors/gate — these admitted as durable
 * findings before the fold. */
test("g1s3-c1 envelope: forged envelope fields refused at intake", () => {
  const dir = tmp();
  try {
    const refuse = (name: string, mutate: (c: any) => void) => {
      const c: any = auditorCandidate();
      mutate(c);
      let threw = false;
      try {
        admitAuditorFinding(
          dir,
          { episodeId: "ep-1", taskId: "t1", receiptId: "r-9", candidate: c, now: 1 },
          { takenIds: new Set(), artifactBytes: Buffer.from("a"), normGate: () => ({ pass: true }), journalPath: path.join(dir, `j-${name}.jsonl`) },
        );
      } catch (e) {
        threw = e instanceof IntakeInputError;
      }
      assert.ok(threw, `${name}: expected IntakeInputRefused`);
    };
    refuse("schema", (c) => { c.schema = "tre-supervisor/99"; });
    refuse("kind", (c) => { c.kind = "owner-act"; });
    refuse("cycle-neg", (c) => { c.cycle = -1; });
    refuse("cycle-fractional", (c) => { c.cycle = 1.5; });
    refuse("cycle-string", (c) => { c.cycle = "3"; });
    refuse("episode-foreign", (c) => { c.episodeId = "OTHER"; });
    refuse("episode-empty", (c) => { c.episodeId = ""; });
    refuse("task-empty", (c) => { c.taskId = ""; });
    refuse("ts-string", (c) => { c.ts = "now"; });
    refuse("scopeRefs-string", (c) => { c.scopeRefs = "src/x.ts"; });
    refuse("affectedNorm-string", (c) => { c.affectedNorm = "docs/11 §14.10"; });
    refuse("correctionOf-nonULID", (c) => { c.correctionOf = "01bogus"; });
    refuse("cureActRef-nonULID", (c) => { c.cureActRef = "01bogus"; });
    refuse("producer-missing", (c) => { delete c.producer; });
    refuse("producer-extraKey", (c) => { c.producer = { ...PRODUCER, extra: 1 }; });
    refuse("field-smuggled", (c) => { c.notInSchema = { evil: true }; });
    refuse("claimDigest-smuggled", (c) => { c.claimDigest = "00".repeat(32); });
    refuse("findingRef-smuggled", (c) => { c.findingRef = "findings/forged"; });

    // Arrival binding: the candidate MUST name the arrival's
    // episode/task (receipt-to-outcome accounting, cross-episode
    // smuggling refused).
    let crossTask = false;
    try {
      admitAuditorFinding(
        dir,
        { episodeId: "ep-1", taskId: null, receiptId: "r-9", candidate: auditorCandidate(), now: 1 },
        { takenIds: new Set(), artifactBytes: Buffer.from("a"), normGate: () => ({ pass: true }), journalPath: path.join(dir, "j-cross.jsonl") },
      );
    } catch (e) {
      crossTask = e instanceof IntakeInputError;
    }
    assert.ok(crossTask, "candidate taskId != arrival taskId refused");

    // Supervisor-mint override: a VALID echoed ULID is shape-tolerated
    // but the durable record carries the MINTED id, never the echo.
    const echoed = "01HXQZK8V6R9F9WZ9Q9HQ9T9Q9";
    const res = admitAuditorFinding(
      dir,
      { episodeId: "ep-1", taskId: "t1", receiptId: "r-9", candidate: auditorCandidate({ id: echoed }) as any, now: 1 },
      { takenIds: new Set(), artifactBytes: Buffer.from("a"), normGate: () => ({ pass: true }), journalPath: path.join(dir, "j-echo.jsonl") },
    );
    assert.equal(res.status, "admitted");
    if (res.status === "admitted") {
      assert.notEqual(res.finding.id, echoed, "the supervisor mints the id — the echoed candidate id is never used");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* g1s3-c2: the auditor artifact is untrusted endpoint bytes written
 * into the episode dir — the SAME input cap the owner draft path
 * enforces, and never empty (a zero-byte artifact binds no prose). */
test("g1s3-c2 artifact bounds: over-cap and empty artifactBytes refused at input, nothing written", () => {
  const dir = tmp();
  try {
    for (const [name, bytes] of [
      ["overcap", Buffer.alloc(DRAFT_CAP_BYTES + 1, 0x41)],
      ["empty", Buffer.alloc(0)],
    ] as const) {
      let threw = false;
      try {
        admitAuditorFinding(
          dir,
          { episodeId: "ep-1", taskId: "t1", receiptId: "r-9", candidate: auditorCandidate(), now: 1 },
          { takenIds: new Set(), artifactBytes: bytes, normGate: () => ({ pass: true }), journalPath: path.join(dir, `j-${name}.jsonl`) },
        );
      } catch (e) {
        threw = e instanceof IntakeInputError;
      }
      assert.ok(threw, `${name}: IntakeInputError expected`);
    }
    assert.equal(existsSync(path.join(dir, "findings")), false, "no artifact directory created by refused submissions");

    // Fail-closed journal: a gate FAIL whose journal path is unusable
    // (an existing DIRECTORY squatting the journal file path) THROWS —
    // never returns admitted, never silently drops the refusal line.
    mkdirSync(path.join(dir, "j2.jsonl"));
    let journalThrew = false;
    try {
      admitAuditorFinding(
        dir,
        { episodeId: "ep-1", taskId: "t1", receiptId: "r-9", candidate: auditorCandidate(), now: 1 },
        { takenIds: new Set(), artifactBytes: Buffer.from("a"), normGate: () => ({ pass: false, code: "norm-unbound" }), journalPath: path.join(dir, "j2.jsonl") },
      );
    } catch {
      journalThrew = true;
    }
    assert.ok(journalThrew, "an unwritable journal on a gate FAIL is fail-closed (throws), never an admitted record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ================= NDR-r — re-filing identity (intake side) ========= */

test("ndr-r: identical-bytes refiling under a NEW act succeeds as a SEPARATE finding (never duplicate-intent)", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    spoolDraft(dir, bytes);
    const base = {
      episodeDir: dir, episodeId: "ep-1", prefix: [] as PrefixRecord[],
      prefixLines: [] as string[], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      producer: PRODUCER, now: 1,
    };
    const act1 = filingAct(payloadFor(bytes), { id: "01ACT10000000000000000A1" });
    const r1 = refileAttempt({ ...base, act: act1, existingIds: new Set() });
    assert.equal(r1.status, "applied");
    if (r1.status !== "applied") return;
    // second attempt: new act id, identical draft bytes; the first
    // finding now stands IN THE PREFIX (its id is taken) — the
    // coverage note (g1s2-c1) demands the claimed pin be real: a
    // duplicate-intent rejection conditioned on an existing matching
    // finding would fire here.
    const taken = new Set<string>([r1.finding.id]);
    const pfx2: PrefixRecord[] = [
      { kind: "audit-finding", id: r1.finding.id, severity: r1.finding.severity, route: r1.finding.route, correctionOf: r1.finding.correctionOf, claim: r1.finding.claim },
    ];
    const act2 = filingAct(payloadFor(bytes), { id: "01ACT20000000000000000A2" });
    const r2 = refileAttempt({ ...base, prefix: pfx2, prefixLines: linesOf(pfx2), act: act2, existingIds: taken });
    assert.equal(r2.status, "applied");
    if (r2.status === "applied") {
      assert.notEqual(r2.finding.id, r1.finding.id);
      assert.notEqual(r2.finding.ownerActRef, r1.finding.ownerActRef);
      assert.equal(r2.finding.claimDigest, r1.finding.claimDigest); // same bytes
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ndr-r: resubmitted correction draft is refused correction-ambiguity by lineage linearity", () => {
  const fx = correctionFixture({ targetClosed: "rejected-refuted" });
  try {
    const bytes = draftBytes(baseHeader({ correctionOf: fx.targetId }));
    spoolDraft(fx.dir, bytes);
    const base = {
      episodeDir: fx.dir, episodeId: "ep-1", producer: PRODUCER, now: 1,
      normGate: PASS_GATE, gateJournalPath: gJournal(fx.dir),
    };
    const r1 = refileAttempt({
      ...base, prefix: fx.pfx, prefixLines: linesOf(fx.pfx), normGate: PASS_GATE, gateJournalPath: gJournal(fx.dir),
      act: filingAct(payloadFor(bytes), { id: "01CFT10000000000000000C1" }),
      existingIds: new Set(),
    });
    assert.equal(r1.status, "applied");
    if (r1.status !== "applied") return;
    // the first correction now stands in the prefix:
    const pfx2: PrefixRecord[] = [
      ...fx.pfx,
      { kind: "audit-finding", id: r1.finding.id, severity: "major", route: "code-fix", correctionOf: fx.targetId, claim: "correction" },
    ];
    const r2 = refileAttempt({
      ...base, prefix: pfx2, prefixLines: linesOf(pfx2),
      act: filingAct(payloadFor(bytes), { id: "01CFT20000000000000000C2" }),
      existingIds: new Set([r1.finding.id]),
    });
    assert.equal(r2.status, "refused");
    if (r2.status === "refused") assert.equal(r2.refusal.diagnosticCode, "correction-ambiguity");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

/* ================= drift resolution operands ================= */

test("driftResolutionOperandsValid: only real drift refusals match on the dedup pair", () => {
  const drift = {
    kind: "audit-filing-intake-refusal",
    id: "01R0",
    refusedActId: "01A0",
    diagnosticCode: "owner-filing-draft-drift",
  } as const;
  assert.equal(driftResolutionOperandsValid(drift as never, { refusedActId: "01A0", refusalRecordId: "01R0" }), true);
  assert.equal(driftResolutionOperandsValid(drift as never, { refusedActId: "01A0", refusalRecordId: "01OTHER" }), false);
  const mapping = { ...drift, diagnosticCode: "owner-filing-mapping" } as const;
  assert.equal(driftResolutionOperandsValid(mapping as never, { refusedActId: "01A0", refusalRecordId: "01R0" }), false);
});

/* ================= g1s4 fresh-eyes round 2 — C7 fixes ============= */

test("g1s4-c3: duplicate evidenceRefs refuse on BOTH paths (owner-filing-mapping / schema floor; §14.10.1 'distinct')", () => {
  const dir = tmp();
  try {
    // owner path: header carries a duplicated ref → owner-filing-mapping
    const bytes = draftBytes(baseHeader({ evidenceRefs: ["sess-1", "sess-1"] }));
    spoolDraft(dir, bytes);
    const res = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytes)),
      producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(res.status, "refused");
    if (res.status !== "refused") return;
    assert.equal(res.refusal.diagnosticCode, "owner-filing-mapping");
    // auditor path: the SAME shared floor refuses
    assert.throws(
      () =>
        admitAuditorFinding(
          dir,
          { episodeId: "ep-1", taskId: "t1", receiptId: "r-9", candidate: auditorCandidate({ evidenceRefs: ["a", "a"] }), now: 1 },
          { takenIds: new Set(), artifactBytes: Buffer.from("x"), normGate: PASS_GATE, journalPath: path.join(dir, "s5", "d.jsonl") },
        ),
      IntakeInputError,
    );
    // NFC-distinct-but-equal refs: §14.10.1's rule is exact-string
    // ('"a" and "a"' — literal duplicates); "a\u0301" vs "\u00e1" are
    // distinct JSON string values and stay admissible (pinned so a
    // future "NFC-dedupe" read doesn't tighten the contract).
    const okBytes = draftBytes(baseHeader({ evidenceRefs: ["\u00e1", "a\u0301"] }));
    const dir2 = tmp();
    try {
      spoolDraft(dir2, okBytes);
      const ok = intakeFiling({
        episodeDir: dir2, episodeId: "ep-1", prefix: [], prefixLines: [], normGate: PASS_GATE, gateJournalPath: gJournal(dir2),
        act: filingAct(payloadFor(okBytes)),
        producer: PRODUCER, existingIds: new Set(), now: 1,
      });
      assert.equal(ok.status, "applied");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-c4: lineSha256 pins the refused record's canonical LINE CONTENT (no terminator — the record is never written; reconstruction handle)", () => {
  const dir = tmp();
  try {
    const journalPath = path.join(dir, "s5", "decisions.jsonl");
    let gated: AuditFinding | null = null;
    const res = admitAuditorFinding(
      dir,
      { episodeId: "ep-1", taskId: "t1", receiptId: "r-9", candidate: auditorCandidate(), now: 1 },
      {
        takenIds: new Set(),
        artifactBytes: Buffer.from("x", "utf8"),
        normGate: (rec) => { gated = rec; return { pass: false, code: "norm-unbound" }; },
        journalPath,
      },
    );
    assert.equal(res.status, "refused-gate");
    if (res.status !== "refused-gate" || gated === null) return;
    // reconstructible from the record WITHOUT the terminator, and NOT
    // the with-terminator digest (the recipe is pinned both ways)
    assert.equal(res.journal.lineSha256, sha(JSON.stringify(gated)));
    assert.notEqual(res.journal.lineSha256, sha(JSON.stringify(gated) + "\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-c5: the admission ts is supervisor-stamped (arrival `now`), never the candidate's", () => {
  const dir = tmp();
  try {
    const res = admitAuditorFinding(
      dir,
      { episodeId: "ep-1", taskId: "t1", receiptId: "r-9", candidate: auditorCandidate({ ts: 1_700_000_000 }), now: 42 },
      { takenIds: new Set(), artifactBytes: Buffer.from("x"), normGate: PASS_GATE, journalPath: path.join(dir, "s5", "d.jsonl") },
    );
    assert.equal(res.status, "admitted");
    if (res.status !== "admitted") return;
    assert.equal(res.finding.ts, 42, "envelope-field sources (§14.10.1 v9): ts is supervisor-minted at intake");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-c6: originRef shape pin — non-intake variant and excess keys refuse the closed envelope", () => {
  const dir = tmp();
  try {
    // supervisor-derived variant must not ride an auditor arrival
    assert.throws(
      () =>
        admitAuditorFinding(
          dir,
          { episodeId: "ep-1", taskId: "t1", receiptId: "r-9", candidate: auditorCandidate({ originRef: { origin: "supervisor-derived", fromRefusalId: mintUlid() } }), now: 1 },
          { takenIds: new Set(), artifactBytes: Buffer.from("x"), normGate: PASS_GATE, journalPath: path.join(dir, "s5", "d.jsonl") },
        ),
      IntakeInputError,
    );
    // excess key on the intake variant (smuggling class — producer
    // trio carries the same pin)
    assert.throws(
      () =>
        admitAuditorFinding(
          dir,
          { episodeId: "ep-1", taskId: "t1", receiptId: "r-9", candidate: auditorCandidate({ originRef: { origin: "intake", receiptId: "r-9", extra: 1 } }), now: 1 },
          { takenIds: new Set(), artifactBytes: Buffer.from("x"), normGate: PASS_GATE, journalPath: path.join(dir, "s5", "d.jsonl") },
        ),
      IntakeInputError,
    );
    // empty receiptId refuses on shape (before the value-binding check)
    assert.throws(
      () =>
        admitAuditorFinding(
          dir,
          { episodeId: "ep-1", taskId: "t1", receiptId: "", candidate: auditorCandidate({ originRef: { origin: "intake", receiptId: "" } }), now: 1 },
          { takenIds: new Set(), artifactBytes: Buffer.from("x"), normGate: PASS_GATE, journalPath: path.join(dir, "s5", "d.jsonl") },
        ),
      IntakeInputError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
