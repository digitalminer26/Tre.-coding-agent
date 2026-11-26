/**
 * g1s4 adversarial probe suite — the C2–C6 probes from the round-2 audit
 * promoted from staging scratch to pinned regression tests (F3 audit fix:
 * probe checks must be `assert`-based and run under `npm test`, so a
 * regression FAILS the build instead of printing a line nobody reads).
 *
 * Every probe here previously lived (as a boolean-returning closure) in
 * `staging/g1s4/probe.mjs`; the semantics are unchanged, the enforcement
 * is new. Cycle coverage:
 *   C2 entry boundary   — spool caps, traversal, transport, parse fuzz
 *   C3 lineage fold     — correction targets, chains, cure identity
 *   C4 refusal binding  — prefix digest, checkClass, observed digests
 *   C5 refile/replay    — NDR-r identity, drift resolution operands
 *   C6 applied path     — artifact bytes, gate journal, distinct ids
 *   g6-F6 durability    — syscall OBSERVATION + fault injection over the
 *                         g6 durability fixes (short-write loop, checked
 *                         close, unconditional parent-dir sync)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync as realCloseSync,
  existsSync,
  fstatSync,
  fsyncSync as realFsync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync as realWriteSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  checkClassOfRefusalCode,
  isUlid,
  type AuditFilingPayload,
  type AuditFinding,
  type OwnerAct,
  type Repro,
} from "../src/findings/records.js";
import {
  DRAFT_CAP_BYTES,
  DRAFT_MAGIC,
  IntakeInputError,
  admitAuditorFinding,
  driftResolutionOperandsValid,
  intakeFiling,
  parseDraft,
  prefixDigestInitial,
  prefixDigestStep,
  refileAttempt,
  spoolDraft,
  spoolPath,
  syncDirEntry,
  SpoolIoError,
  __setFsSeam,
  type FilingAdjudication,
  type FilingAdjudicationInput,
  type PrefixRecord,
} from "../src/findings/intake.js";

/* ================= fixtures (mirrors findings-intake.test.ts) ====== */

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "g1s4-"));
const PASS_GATE = () => ({ pass: true } as const);
const gJournal = (dir: string) => path.join(dir, "g.jsonl");

const OK_REPRO: Repro = { kind: "probe", command: "npm t", preFixObserved: "x", postFixExpected: "y" };
const NO_REPRO: Repro = { kind: "none", command: "", preFixObserved: "", postFixExpected: "" };
const PRODUCER = { endpoint: "ep", model: "m", sessionId: "s" };

const draftBytes = (h: Record<string, unknown>, prose = "prose") =>
  Buffer.from(`${DRAFT_MAGIC}\n${JSON.stringify(h)}\n${prose}`, "utf8");

const baseHeader = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  route: "code-fix",
  surface: "code",
  severity: "major",
  verdictBasis: "repro",
  claim: "c",
  correctionOf: null,
  cureActRef: null,
  scopeRefs: ["s"],
  evidenceRefs: ["e1"],
  repro: OK_REPRO,
  affectedNorm: null,
  ...over,
});

const payloadFor = (bytes: Buffer, over: Partial<AuditFilingPayload> = {}): AuditFilingPayload => ({
  findingDraftRef: "drafts/live.md",
  draftSha256: sha(bytes),
  claim: "c",
  cycle: 1,
  taskId: null,
  cureActRef: null,
  ...over,
});

const filingAct = (payload: AuditFilingPayload, over: Partial<OwnerAct<"audit-filing">> = {}): OwnerAct<"audit-filing"> => ({
  schema: "tre-supervisor/1",
  id: "01ACT0000000000000000000AA",
  ts: 1,
  episodeId: "ep-1",
  kind: "owner-act",
  op: "audit-filing",
  payload,
  payloadDigest: sha("unused"),
  channel: "tty:dev",
  sessionRef: null,
  effectRecordIds: [],
  ...over,
});

/** One filing over `bytes` with the standard seam (empty prefix, pass
 * gate) — every override applied to the FULL input. */
const filing = (
  dir: string,
  bytes: Buffer,
  over: Partial<FilingAdjudicationInput> = {},
): FilingAdjudication =>
  intakeFiling({
    episodeDir: dir,
    episodeId: "ep-1",
    prefix: [],
    prefixLines: [],
    normGate: PASS_GATE,
    gateJournalPath: gJournal(dir),
    act: filingAct(payloadFor(bytes)),
    producer: PRODUCER,
    existingIds: new Set<string>(),
    now: 1,
    ...over,
  });

/** Filing over a non-empty prefix (lineage probes). */
const filingWith = (dir: string, bytes: Buffer, prefix: PrefixRecord[]): FilingAdjudication =>
  filing(dir, bytes, {
    prefix,
    prefixLines: prefix.map((r) => JSON.stringify(r)),
    existingIds: new Set(prefix.map((r) => r.id)),
  });

const findRec = (id: string, over: Partial<Extract<PrefixRecord, { kind: "audit-finding" }>> = {}): PrefixRecord => ({
  kind: "audit-finding",
  id,
  severity: "major",
  route: "code-fix",
  correctionOf: null,
  claim: "old " + id,
  ...over,
});
const updRec = (findingId: string, to: string): PrefixRecord => ({
  kind: "audit-finding-update",
  id: `01UPD${findingId.slice(2, 12)}${to.slice(0, 8)}`,
  findingId,
  to,
});

/* ================= C2 — entry boundary ============================ */

test("g1s4-C2.1: over-cap spool refuses IntakeInputError, nothing written", () => {
  const dir = tmp();
  try {
    assert.throws(
      () => spoolDraft(dir, Buffer.alloc(DRAFT_CAP_BYTES + 1, 0x61)),
      IntakeInputError,
    );
    assert.equal(existsSync(path.join(dir, "drafts")), false, "the drafts dir was created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C2.2: EXACTLY-cap draft spools (boundary is inclusive)", () => {
  const dir = tmp();
  try {
    const head = Buffer.from(`${DRAFT_MAGIC}\n{}\n`, "utf8");
    const bytes = Buffer.concat([head, Buffer.alloc(DRAFT_CAP_BYTES - head.length, 0x61)]);
    assert.equal(bytes.length, DRAFT_CAP_BYTES);
    assert.equal(spoolDraft(dir, bytes), sha(bytes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C2.3: spoolPath traversal refused (digest must be lowercase hex)", () => {
  const dir = tmp();
  try {
    for (const evil of ["../../etc/passwd", "a/b", "ABCD", "", "0".repeat(63) + "g"]) {
      assert.throws(() => spoolPath(dir, evil), IntakeInputError, `traversal accepted: ${JSON.stringify(evil)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C2.4: claim exactly-2000 admits; 2001 refuses owner-filing-mapping", () => {
  const dir = tmp();
  try {
    const okBytes = draftBytes(baseHeader({ claim: "k".repeat(2000) }));
    spoolDraft(dir, okBytes);
    const r1 = filing(dir, okBytes, { act: filingAct(payloadFor(okBytes, { claim: "k".repeat(2000) })) });
    assert.equal(r1.status, "applied");
    const badDir = tmp();
    try {
      const badBytes = draftBytes(baseHeader({ claim: "k".repeat(2001) }));
      spoolDraft(badDir, badBytes);
      const r2 = filing(badDir, badBytes, { act: filingAct(payloadFor(badBytes, { claim: "k".repeat(2001) })) });
      assert.equal(r2.status, "refused");
      if (r2.status === "refused") assert.equal(r2.refusal.diagnosticCode, "owner-filing-mapping");
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C2.5: NUL-byte claim is transportable (valid UTF-8) — applied, embed round-trips", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader({ claim: "with\u0000nul" }));
    spoolDraft(dir, bytes);
    const res = filing(dir, bytes, { act: filingAct(payloadFor(bytes, { claim: "with\u0000nul" })) });
    assert.equal(res.status, "applied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C2.6: UTF-8-encoded-surrogate bytes refused at spool input", () => {
  const dir = tmp();
  try {
    const raw = Buffer.from([0xef, 0xbf, 0xbd, 0xed, 0xa0, 0x80]); // encoded surrogate half = invalid UTF-8
    assert.throws(() => spoolDraft(dir, raw), IntakeInputError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C2.7: CRLF draft — magic mismatch is a malformed-input refusal WITH bytes embedded", () => {
  const dir = tmp();
  try {
    const bytes = Buffer.from(`${DRAFT_MAGIC}\r\n${JSON.stringify(baseHeader())}\r\nprose`, "utf8");
    spoolDraft(dir, bytes);
    const res = filing(dir, bytes);
    assert.equal(res.status, "refused");
    if (res.status === "refused") {
      assert.equal(res.refusal.diagnosticCode, "malformed-input");
      assert.notEqual(res.refusal.adjudicatedDraftBytes, null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C2.8: corrupted spool entry re-spool refused; the tampered ORIGINAL is untouched", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    const s = spoolDraft(dir, bytes);
    const p = spoolPath(dir, s);
    writeFileSync(p, "tampered");
    assert.throws(() => spoolDraft(dir, bytes), IntakeInputError);
    assert.equal(readFileSync(p, "utf8"), "tampered", "never silently replaced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// g1s6 (audit F1): the EEXIST reuse path used to `return sha` on mere
// byte-equality — a CRASH-PENDING entry (created by a racer that died
// before fsync) would be acked and the act append proceed against
// bytes that may not survive. The path now establishes durability
// (re-open + fsync the file, sync the directory entry) before reuse,
// and EVERY reuse-path fault rides the retryable SpoolIoError channel
// instead of escaping raw. Pinned here: an existing entry the caller
// cannot read is a typed SpoolIoError (pre-fix: a raw EACCES escaped
// the intake). The fsync-side of the reuse block is the documented
// unmutateable floor (same reasoning as syncDirEntry's fsync side: no
// portable way to fault ONLY the fsync of an openable file).
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
test("g1s6-F1 spool-reuse-unreadable-spoolio: EEXIST reuse of an UNREADABLE entry is SpoolIoError (retryable), never a raw fs error", (t) => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    const s = spoolDraft(dir, bytes);
    const p = spoolPath(dir, s);
    // happy reuse first: identical re-spool returns the same digest
    assert.equal(spoolDraft(dir, bytes), s);
    if (IS_ROOT) {
      t.skip("chmod 0o000 does not block root (CAP_DAC_OVERRIDE) — fault path untestable");
      return;
    }
    chmodSync(p, 0o000);
    try {
      assert.throws(() => spoolDraft(dir, bytes), SpoolIoError);
    } finally {
      chmodSync(p, 0o644);
    }
    // readable again → the durability-establishing reuse still succeeds
    assert.equal(spoolDraft(dir, bytes), s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C2.9: zero-byte draft spools OK; intake refuses malformed-input", () => {
  const dir = tmp();
  try {
    const bytes = Buffer.alloc(0);
    spoolDraft(dir, bytes);
    const res = filing(dir, bytes);
    assert.equal(res.status, "refused");
    if (res.status === "refused") assert.equal(res.refusal.diagnosticCode, "malformed-input");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C2.10: header JSON array/number/string/null -> IntakeInputError, never a crash", () => {
  for (const h of ["[1,2]", "42", '"str"', "null", "{}]", "{,}"]) {
    const bytes = Buffer.from(`${DRAFT_MAGIC}\n${h}\n`, "utf8");
    assert.throws(() => parseDraft(bytes), IntakeInputError, `header ${h} did not refuse`);
  }
});

test("g1s4-C2.11: auditor artifact exactly-cap admits; +1 refuses; EMPTY refuses", () => {
  const dir = tmp();
  try {
    const cand = () =>
      ({
        schema: "tre-supervisor/1",
        ts: 1,
        episodeId: "ep-1",
        taskId: null,
        kind: "audit-finding",
        cycle: 1,
        origin: "auditor",
        producer: PRODUCER,
        ownerActRef: null,
        originRef: { origin: "intake", receiptId: "r" },
        correctionOf: null,
        route: "human-review",
        surface: "spec",
        severity: "minor",
        verdictBasis: "opinion",
        claim: "c",
        scopeRefs: [],
        repro: NO_REPRO,
        evidenceRefs: ["e"],
        cureActRef: null,
        affectedNorm: null,
      }) as Parameters<typeof admitAuditorFinding>[1]["candidate"];
    const adm = (art: Buffer) =>
      admitAuditorFinding(
        dir,
        { episodeId: "ep-1", taskId: null, receiptId: "r", candidate: cand(), now: 1 },
        { takenIds: new Set<string>(), artifactBytes: art, normGate: PASS_GATE, journalPath: path.join(dir, "j") },
      );
    const cap = Buffer.alloc(DRAFT_CAP_BYTES, 0x61);
    assert.equal(adm(cap).status, "admitted");
    assert.throws(() => adm(Buffer.concat([cap, Buffer.from("a")])), IntakeInputError);
    assert.throws(() => adm(Buffer.alloc(0)), IntakeInputError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ================= C3 — lineage-fold edges ======================== */

test("g1s4-C3.1: correctionOf naming nothing in the prefix -> correction-bad-target", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader({ correctionOf: "01BBBBBBBBBBBBBBBBBBBBBBBBB2" }));
    spoolDraft(dir, bytes);
    const res = filingWith(dir, bytes, []);
    assert.equal(res.status, "refused");
    if (res.status === "refused") assert.equal(res.refusal.diagnosticCode, "correction-bad-target");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C3.2: target rejected-refuted then REOPENED -> correction-bad-target (closure must be FINAL)", () => {
  const dir = tmp();
  try {
    const A = findRec("01AAAAAAAAAAAAAAAAAAAAAAAAAA");
    const prefix = [A, updRec(A.id, "rejected-refuted"), updRec(A.id, "pending")];
    const bytes = draftBytes(baseHeader({ correctionOf: A.id }));
    spoolDraft(dir, bytes);
    const res = filingWith(dir, bytes, prefix);
    assert.equal(res.status, "refused");
    if (res.status === "refused") assert.equal(res.refusal.diagnosticCode, "correction-bad-target");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C3.3: correcting a rejected-refuted CORRECTION is admissible (chains fold)", () => {
  const dir = tmp();
  try {
    const A = findRec("01AAAAAAAAAAAAAAAAAAAAAAAAAA");
    const B = findRec("01BBBBBBBBBBBBBBBBBBBBBBBBBB", { correctionOf: A.id });
    const prefix = [A, updRec(A.id, "rejected-refuted"), B, updRec(B.id, "rejected-refuted")];
    const bytes = draftBytes(baseHeader({ correctionOf: B.id }));
    spoolDraft(dir, bytes);
    const res = filingWith(dir, bytes, prefix);
    assert.equal(res.status, "applied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C3.4: second correction of the same target -> correction-ambiguity", () => {
  const dir = tmp();
  try {
    const A = findRec("01AAAAAAAAAAAAAAAAAAAAAAAAAA");
    const B = findRec("01BBBBBBBBBBBBBBBBBBBBBBBBBB", { correctionOf: A.id });
    const prefix = [A, updRec(A.id, "rejected-refuted"), B];
    const bytes = draftBytes(baseHeader({ correctionOf: A.id }));
    spoolDraft(dir, bytes);
    const res = filingWith(dir, bytes, prefix);
    assert.equal(res.status, "refused");
    if (res.status === "refused") assert.equal(res.refusal.diagnosticCode, "correction-ambiguity");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C3.5: cureActRef is IDENTITY-only — any residual-cure act in the prefix satisfies it", () => {
  const dir = tmp();
  try {
    const cure: PrefixRecord = { kind: "owner-act", id: "01CCCCCCCCCCCCCCCCCCCCCCCCCC", op: "residual-cure" };
    const bytes = draftBytes(baseHeader({ cureActRef: cure.id }));
    spoolDraft(dir, bytes);
    const res = filing(dir, bytes, {
      prefix: [cure],
      prefixLines: [JSON.stringify(cure)],
      existingIds: new Set([cure.id]),
      act: filingAct(payloadFor(bytes, { cureActRef: cure.id })),
    });
    assert.equal(res.status, "applied");
    if (res.status === "applied") assert.equal(res.finding.cureActRef, cure.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C3.6: severity UPLIFT (minor target -> blocker filing) is allowed (only DECREASE refuses)", () => {
  const dir = tmp();
  try {
    const A = findRec("01AAAAAAAAAAAAAAAAAAAAAAAAAA", { severity: "minor" });
    const prefix = [A, updRec(A.id, "rejected-refuted")];
    const bytes = draftBytes(baseHeader({ correctionOf: A.id, severity: "blocker" }));
    spoolDraft(dir, bytes);
    const res = filingWith(dir, bytes, prefix);
    assert.equal(res.status, "applied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ================= C4 — refusal binding =========================== */

test("g1s4-C4.1: refusal carries the prefix binding (endId + running digest of the LINES)", () => {
  const dir = tmp();
  try {
    const pfx = [findRec("01AAAAAAAAAAAAAAAAAAAAAAAAAA")];
    const bytes = draftBytes(baseHeader({ severity: "bogus" }));
    spoolDraft(dir, bytes);
    const res = filingWith(dir, bytes, pfx);
    assert.equal(res.status, "refused");
    if (res.status !== "refused") return;
    let dig = prefixDigestInitial();
    for (const l of pfx.map((r) => JSON.stringify(r))) dig = prefixDigestStep(dig, l);
    assert.equal(res.refusal.intakePrefixEndId, pfx[0]?.id);
    assert.equal(res.refusal.intakePrefixSha256, dig);
    assert.equal(res.refusal.checkClass, checkClassOfRefusalCode("malformed-input"));
    assert.notEqual(res.refusal.adjudicatedDraftBytes, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C4.2: drift refusal carries spoolObserved=absent + checkClass per the records.ts table", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    const res = filing(dir, bytes); // spool never written
    assert.equal(res.status, "refused");
    if (res.status !== "refused") return;
    assert.equal(res.refusal.diagnosticCode, "owner-filing-draft-drift");
    assert.equal(res.refusal.spoolObserved, "absent");
    assert.equal(res.refusal.checkClass, checkClassOfRefusalCode("owner-filing-draft-drift"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C4.3: mismatch drift carries observedSha256 of the spool bytes AS FOUND (post-tamper)", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    const s = spoolDraft(dir, bytes);
    writeFileSync(spoolPath(dir, s), "tampered-bytes");
    const res = filing(dir, bytes);
    assert.equal(res.status, "refused");
    if (res.status !== "refused") return;
    assert.equal(res.refusal.spoolObserved, "mismatch");
    assert.equal(res.refusal.observedSha256, sha("tampered-bytes"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C4.4: every draft-derivative refusal's embedded bytes re-digest to draftSha256", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader({ route: "surface-x" }));
    spoolDraft(dir, bytes);
    const res = filing(dir, bytes);
    assert.equal(res.status, "refused");
    if (res.status !== "refused") return;
    assert.notEqual(res.refusal.adjudicatedDraftBytes, null);
    assert.equal(sha(Buffer.from(res.refusal.adjudicatedDraftBytes as string, "utf8")), sha(bytes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ================= C5 — refile / replay =========================== */

test("g1s4-C5.1: refile of identical bytes under a fresh act -> SECOND applied finding, distinct ids, same digest", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    spoolDraft(dir, bytes);
    const a1 = refileAttempt({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [],
      normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytes), { id: "01AAAAAAAAAAAAAAAAAAAAAAAA1" }),
      producer: PRODUCER, existingIds: new Set<string>(), now: 1,
    });
    assert.equal(a1.status, "applied");
    if (a1.status !== "applied") return;
    const a2 = refileAttempt({
      episodeDir: dir, episodeId: "ep-1", prefix: [], prefixLines: [],
      normGate: PASS_GATE, gateJournalPath: gJournal(dir),
      act: filingAct(payloadFor(bytes), { id: "01AAAAAAAAAAAAAAAAAAAAAAAA2" }),
      producer: PRODUCER, existingIds: new Set([a1.finding.id]), now: 2,
    });
    assert.equal(a2.status, "applied");
    if (a2.status !== "applied") return;
    assert.notEqual(a2.finding.id, a1.finding.id);
    assert.equal(a2.finding.claimDigest, a1.finding.claimDigest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C5.2: driftResolutionOperandsValid is true ONLY for the exact (actId, refusalId) pair", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    const res = filing(dir, bytes);
    assert.equal(res.status, "refused");
    if (res.status !== "refused") return;
    const r = res.refusal;
    assert.equal(driftResolutionOperandsValid(r, { refusedActId: r.refusedActId, refusalRecordId: r.id }), true);
    assert.equal(driftResolutionOperandsValid(r, { refusedActId: "other", refusalRecordId: r.id }), false);
    assert.equal(driftResolutionOperandsValid(r, { refusedActId: r.refusedActId, refusalRecordId: "other" }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C5.3: a NON-drift refusal is never a valid drift-resolution operand", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader({ severity: "nope" }));
    spoolDraft(dir, bytes);
    const res = filing(dir, bytes);
    assert.equal(res.status, "refused");
    if (res.status !== "refused") return;
    assert.notEqual(res.refusal.diagnosticCode, "owner-filing-draft-drift");
    assert.equal(
      driftResolutionOperandsValid(res.refusal, { refusedActId: res.refusal.refusedActId, refusalRecordId: res.refusal.id }),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ================= C6 — applied path =============================== */

test("g1s4-C6.1: applied artifact is BYTE-IDENTICAL to the draft; claimDigest = sha256(artifact) = draftSha256", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    spoolDraft(dir, bytes);
    const res = filing(dir, bytes);
    assert.equal(res.status, "applied");
    if (res.status !== "applied") return;
    const stored = readFileSync(res.artifactPath);
    assert.ok(stored.equals(bytes));
    assert.equal(sha(stored), res.finding.claimDigest);
    assert.equal(res.finding.claimDigest, sha(bytes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C6.2: gate-refused owner filing returns the journal and NO finding", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    spoolDraft(dir, bytes);
    const res = filing(dir, bytes, { normGate: () => ({ pass: false, code: "norm-unbound" }) });
    assert.equal(res.status, "refused-gate");
    assert.ok(!("finding" in res));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s4-C6.3: two filings of identical bytes -> distinct artifact paths, both intact", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    spoolDraft(dir, bytes);
    const r1 = filing(dir, bytes, { act: filingAct(payloadFor(bytes), { id: "01AAAAAAAAAAAAAAAAAAAAAAAA1" }) });
    assert.equal(r1.status, "applied");
    if (r1.status !== "applied") return;
    const r2 = filing(dir, bytes, {
      act: filingAct(payloadFor(bytes), { id: "01AAAAAAAAAAAAAAAAAAAAAAAA2" }),
      existingIds: new Set([r1.finding.id]),
    });
    assert.equal(r2.status, "applied");
    if (r2.status !== "applied") return;
    assert.notEqual(r2.artifactPath, r1.artifactPath);
    assert.ok(readFileSync(r2.artifactPath).equals(bytes));
    assert.ok(readFileSync(r1.artifactPath).equals(bytes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ================= g6-F6 — durability syscall observation =========== */

/* The g6 durability fixes (F1 unconditional parent sync, F2 checked
 * close, F3 short-write loop) must be PINNED at the syscall level: a
 * suite that only checks the returned verdict passes even when the
 * fsync/write loop was deleted. These probes ride the module's test
 * seam (`__setFsSeam`) to OBSERVE the real fs calls (proving each
 * durability step ran) and inject the faults a portable real fs cannot
 * produce (short write / fsync fault / close fault on a healthy fd).
 * `__setFsSeam` is never called by production code. */

type FsPatch = {
  writeSync?: typeof realWriteSync;
  fsyncSync?: typeof realFsync;
  closeSync?: typeof realCloseSync;
};
const setSeam = (p: FsPatch): (() => void) =>
  (__setFsSeam as (patch: FsPatch) => () => void)(p);

const passthroughFs = (): FsPatch => ({
  writeSync: ((...a: unknown[]) => (realWriteSync as (...x: unknown[]) => number)(...a)) as typeof realWriteSync,
  fsyncSync: ((fd: number) => realFsync(fd)) as typeof realFsync,
  closeSync: ((fd: number) => realCloseSync(fd)) as typeof realCloseSync,
});

/** Observe every fsync's target inode (files AND directories). */
const fsyncObserver = () => {
  const inodes = new Set<number>();
  const patch: FsPatch = {
    ...passthroughFs(),
    fsyncSync: ((fd: number) => {
      inodes.add(fstatSync(fd).ino);
      realFsync(fd);
    }) as typeof realFsync,
  };
  return { inodes, patch };
};

const ioErr = (code: string, msg: string) => {
  const e = new Error(msg) as NodeJS.ErrnoException;
  e.code = code;
  return e;
};

test("g6-F3 spool-shortwrite-looped: a 2-chunk short write still lands EVERY byte (write looped, never acked short)", () => {
  const dir = tmp();
  const bytes = draftBytes(baseHeader());
  let calls = 0;
  let chunked = false;
  const half = new Set<number>();
  const restore = setSeam({
    ...passthroughFs(),
    writeSync: ((fd: number, buf: string | NodeJS.ArrayBufferView, offset?: unknown) => {
      calls++;
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
      // first write to a fresh fd: complete only HALF (a legitimate
      // short-return — writeSync is allowed to do this without error)
      if (offset === 0 && b.length > 16 && !half.has(fd)) {
        half.add(fd);
        chunked = true;
        return realWriteSync(fd, b.subarray(0, Math.floor(b.length / 2)));
      }
      return (realWriteSync as (...a: unknown[]) => number)(fd, buf, offset as number | undefined);
    }) as typeof realWriteSync,
  });
  try {
    const s = spoolDraft(dir, bytes);
    assert.ok(chunked, "the fault injector never short-wrote (probe vacuous)");
    assert.ok(calls > 1, `writeSync was called ${calls}x — the short return was NOT looped`);
    assert.equal(readFileSync(spoolPath(dir, s)).length, bytes.length, "short-acked file");
    assert.ok(readFileSync(spoolPath(dir, s)).equals(bytes), "looped bytes diverge");
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g6-F3 zero-progress-write-refused: a write returning 0 is a typed SpoolIoError, never an infinite loop or a short ack", () => {
  const dir = tmp();
  const restore = setSeam({
    ...passthroughFs(),
    writeSync: ((fd: number, buf: string | NodeJS.ArrayBufferView) => {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
      if (b.length > 16) return 0; // healthy fd, zero progress
      return (realWriteSync as (...a: unknown[]) => number)(fd, buf);
    }) as typeof realWriteSync,
  });
  try {
    assert.throws(() => spoolDraft(dir, draftBytes(baseHeader())), (err: unknown) => {
      assert.ok(err instanceof SpoolIoError, `escaped as ${String(err)}`);
      assert.match((err as Error).message, /no progress/);
      return true;
    });
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g6-F1 unconditional-parent-sync: EVERY durable write fsyncs the CONTAINING dir AND its parent — even when the dir already existed (the deleted existsSync visibility test)", () => {
  const dir = tmp();
  try {
    // first spool: everything fresh
    const b1 = draftBytes(baseHeader({ claim: "one" }));
    spoolDraft(dir, b1);
    // second spool into the SAME drafts dir: PRE-FIX the existsSync
    // visibility test concluded "dir existed" and SKIPPED the parent
    // fsync — visibility proves nothing about entry durability.
    const b2 = draftBytes(baseHeader({ claim: "two" }));
    const obs = fsyncObserver();
    const restore = setSeam(obs.patch);
    let s2: string;
    try {
      s2 = spoolDraft(dir, b2);
    } finally {
      restore();
    }
    const draftsIno = statSync(path.join(dir, "drafts")).ino;
    const epIno = statSync(dir).ino;
    assert.ok(obs.inodes.has(statSync(spoolPath(dir, s2)).ino), "spool FILE never fsynced on the fresh-entry path (MAJOR-8 regression)");
    assert.ok(obs.inodes.has(draftsIno), "drafts dir itself was never fsynced");
    assert.ok(obs.inodes.has(epIno), "g6-F1 regressed: the drafts dir's PARENT was not fsynced on the existing-dir path");
    assert.equal(readFileSync(spoolPath(dir, s2)).equals(b2), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g6-F1+F6 owner-artifact syscalls observed: applied filing fsyncs artifact, findings dir AND episode dir (parent)", () => {
  const dir = tmp();
  const bytes = draftBytes(baseHeader());
  spoolDraft(dir, bytes);
  const obs = fsyncObserver();
  // g7 census (lesson of g6-F9): the INODE of every seam-closed fd,
  // not a bare count — a mutant closing the artifact fd with a raw
  // closeSync ran BELOW the seam and below a count that the dir-walk
  // closes alone satisfied.
  const closedInodes = new Set<number>();
  const restore = setSeam({
    ...obs.patch,
    closeSync: ((fd: number) => {
      try { closedInodes.add(fstatSync(fd).ino); } catch { /* fault */ }
      realCloseSync(fd);
    }) as typeof realCloseSync,
  });
  try {
    const res = filing(dir, bytes);
    assert.equal(res.status, "applied", "observation seam must not change the verdict");
    assert.ok(closedInodes.size >= 3, `only ${closedInodes.size} seam closes — a durability fd was left open`);
    assert.ok(obs.inodes.has(statSync(path.join(dir, "findings")).ino), "findings dir never fsynced (name may not survive)");
    assert.ok(obs.inodes.has(statSync(dir).ino), "g6-F1: findings dir's parent never fsynced");
    // the artifact FILE itself must be among the fsynced inodes
    assert.ok(
      obs.inodes.has(statSync(res.artifactPath).ino),
      "artifact bytes never fsynced before ack (MAJOR-8 regression)",
    );
    // ...AND its fd closed THROUGH the checked seam (a raw-close
    // mutant is invisible to fault injection — g7-F2 census).
    assert.ok(
      closedInodes.has(statSync(res.artifactPath).ino),
      "artifact fd never seam-closed — raw close bypassed closeChecked (fault-injection blind, g7 census)",
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g6-F2 close-fault-clean-path-spoolio: a throwing close after a COMPLETED write path is a SpoolIoError (retryable), never a raw escape", () => {
  const dir = tmp();
  const closeFault = ioErr("EBADF", "injected close fault");
  const restore = setSeam({
    ...passthroughFs(),
    closeSync: ((fd: number) => {
      try { realCloseSync(fd); } catch { /* fault is simulated, fd really released */ }
      throw closeFault;
    }) as typeof realCloseSync,
  });
  try {
    assert.throws(() => spoolDraft(dir, draftBytes(baseHeader())), (err: unknown) => {
      assert.ok(err instanceof SpoolIoError, `raw close fault escaped the typed channel: ${String(err)}`);
      assert.match((err as Error).message, /close fault/);
      return true;
    });
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g6-F2+F5 primary-not-masked: write fault + throwing close -> the PRIMARY (write) fault leads, the close fault rides the cause chain", () => {
  const dir = tmp();
  const writeFault = ioErr("EIO", "injected write fault");
  const closeFault = ioErr("EBADF", "injected close fault");
  let sawHalf = false;
  const restore = setSeam({
    ...passthroughFs(),
    writeSync: ((fd: number, buf: string | NodeJS.ArrayBufferView) => {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
      if (b.length > 16) { sawHalf = true; throw writeFault; }
      return (realWriteSync as (...a: unknown[]) => number)(fd, buf);
    }) as typeof realWriteSync,
    closeSync: ((fd: number) => {
      try { realCloseSync(fd); } catch { /* ignore */ }
      throw closeFault;
    }) as typeof realCloseSync,
  });
  try {
    assert.throws(() => spoolDraft(dir, draftBytes(baseHeader())), (err: unknown) => {
      assert.ok(sawHalf, "injector never fired (probe vacuous)");
      assert.ok(err instanceof SpoolIoError, `escaped as ${String(err)}`);
      // the wrap site must NOT silently drop the primary…
      assert.equal((err as Error).cause, writeFault, "primary write fault DROPPED from the chain");
      // …and closeChecked must not have MASKED it — the close fault
      // hangs off the primary, not the other way around.
      assert.equal((writeFault as { cause?: unknown }).cause, closeFault, "close fault lost/masked");
      return true;
    });
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g6-F2 journal-close-fault: gate-refusal journal close fault -> SpoolIoError, refusal never acked undurable", () => {
  const dir = tmp();
  const bytes = draftBytes(baseHeader());
  spoolDraft(dir, bytes);
  const closeFault = ioErr("EBADF", "injected close fault");
  const restore = setSeam({
    ...passthroughFs(),
    closeSync: ((fd: number) => {
      try { realCloseSync(fd); } catch { /* ignore */ }
      throw closeFault;
    }) as typeof realCloseSync,
  });
  try {
    assert.throws(
      () => filing(dir, bytes, { normGate: () => ({ pass: false, code: "norm-unbound" }) }),
      (err: unknown) => {
        assert.ok(err instanceof SpoolIoError, `escaped as ${String(err)}`);
        assert.match((err as Error).message, /close fault/);
        return true;
      },
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g6-F6 auditor-artifact syscalls observed + fsync fault never admitted: F1 parent sync and fail-closed on the auditor path", () => {
  const dir = tmp();
  const cand = () =>
    ({
      schema: "tre-supervisor/1", ts: 1, episodeId: "ep-1", taskId: null,
      kind: "audit-finding", cycle: 1, origin: "auditor", producer: PRODUCER,
      ownerActRef: null, originRef: { origin: "intake", receiptId: "r" },
      correctionOf: null, route: "human-review", surface: "spec",
      severity: "minor", verdictBasis: "opinion", claim: "c", scopeRefs: [],
      repro: NO_REPRO, evidenceRefs: ["e"], cureActRef: null, affectedNorm: null,
    }) as Parameters<typeof admitAuditorFinding>[1]["candidate"];
  const art = Buffer.from("auditor prose artifact bytes — long enough to be real", "utf8");
  const adm = () =>
    admitAuditorFinding(
      dir,
      { episodeId: "ep-1", taskId: null, receiptId: "r", candidate: cand(), now: 1 },
      { takenIds: new Set<string>(), artifactBytes: art, normGate: PASS_GATE, journalPath: path.join(dir, "j") },
    );

  const obs = fsyncObserver();
  // g7 census: inode of every seam-closed fd (a bare count let a
  // raw-close mutant of the AUDITOR artifact fd pass — g6-F9 lesson).
  const closedInodes = new Set<number>();
  const restore = setSeam({
    ...obs.patch,
    closeSync: ((fd: number) => {
      try { closedInodes.add(fstatSync(fd).ino); } catch { /* fault */ }
      realCloseSync(fd);
    }) as typeof realCloseSync,
  });
  try {
    const admres = adm();
    assert.equal(admres.status, "admitted");
    // artifact fd + artDir + parent chain seam closes (raw-close
    // mutants bypass the seam and come up short).
    assert.ok(closedInodes.size >= 3, `only ${closedInodes.size} seam closes on admission — a durability fd closed raw — g6-F2 regression`);
    assert.ok(obs.inodes.has(statSync(path.join(dir, "findings")).ino), "findings dir never fsynced");
    assert.ok(obs.inodes.has(statSync(dir).ino), "g6-F1: auditor artifact's parent dir never fsynced");
    // g7-F2: the auditor artifact FILE's fd must close THROUGH the
    // seam AND its bytes must be fsynced — a raw-close mutant (the
    // bare-closeSync finally) is invisible to fault injection, and a
    // dropped seamFsync acks undurable bytes.
    assert.ok(
      closedInodes.has(statSync(admres.artifactPath).ino),
      "auditor artifact fd never seam-closed (raw close bypassed closeChecked — g7 census)",
    );
    assert.ok(
      obs.inodes.has(statSync(admres.artifactPath).ino),
      "auditor artifact bytes never fsynced before ack (MAJOR-8 regression — fsync-off-auditor mutant)",
    );
  } finally {
    restore();
  }

  // fsync fault on a healthy fd (unconstructible with real syscalls):
  // admission must NEVER be acked — a success return under a failed
  // fsync is exactly the silent-durability-loss g6-F2/F3 doctrine forbids.
  const fsFault = ioErr("EIO", "injected fsync fault");
  const restore2 = setSeam({
    ...passthroughFs(),
    fsyncSync: ((fd: number) => {
      void fd;
      throw fsFault;
    }) as typeof realFsync,
  });
  try {
    const dir2 = tmp();
    try {
      assert.throws(() =>
        admitAuditorFinding(
          dir2,
          { episodeId: "ep-1", taskId: null, receiptId: "r", candidate: cand(), now: 1 },
          { takenIds: new Set<string>(), artifactBytes: art, normGate: PASS_GATE, journalPath: path.join(dir2, "j") },
        ),
      (err: unknown) => {
        assert.ok(err instanceof SpoolIoError, `escaped as ${String(err)}`);
        assert.equal((err as Error).cause, fsFault, "fsync fault dropped from the chain (never retryable-identifiable)");
        return true;
      });
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    restore2();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g6 journal-append-not-truncate: two gate refusals leave TWO journal lines (append mode, durable decision history)", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    spoolDraft(dir, bytes);
    const failGate = () => ({ pass: false, code: "norm-unbound" }) as const;
    const r1 = filing(dir, bytes, { normGate: failGate });
    assert.equal(r1.status, "refused-gate");
    const r2 = filing(dir, bytes, {
      normGate: failGate,
      act: filingAct(payloadFor(bytes), { id: "01AAAAAAAAAAAAAAAAAAAAAAAA2" }),
    });
    assert.equal(r2.status, "refused-gate");
    if (r1.status !== "refused-gate" || r2.status !== "refused-gate") return;
    const lines = readFileSync(gJournal(dir), "utf8").split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2, "the second refusal TRUNCATED the journal (append mode lost)");
    const j1 = JSON.parse(lines[0] ?? "");
    const j2 = JSON.parse(lines[1] ?? "");
    assert.equal(j1.kind, "norm-gate-refusal");
    assert.equal(j2.kind, "norm-gate-refusal");
    assert.notEqual(j1.id, j2.id, "distinct decision records");
    assert.equal(j2.refusalCode, "norm-unbound");
    assert.equal(j1.id, r1.journal.id);
    assert.equal(j2.id, r2.journal.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g6-F2+F5 spool-new fsync fault: never acked, primary fsync fault rides the cause chain", () => {
  const dir = tmp();
  const fsFault = ioErr("EIO", "injected fsync fault (spool)");
  let fired = false;
  const restore = setSeam({
    ...passthroughFs(),
    fsyncSync: ((fd: number) => {
      // fault the SPOOL fd (open "wx" → fstat size 0 while writing?
      // unreliable) — instead fault only fds that already wrote the
      // draft bytes: the first fsync of the call IS the spool fd.
      if (!fired) { fired = true; throw fsFault; }
      realFsync(fd);
    }) as typeof realFsync,
  });
  try {
    assert.throws(() => spoolDraft(dir, draftBytes(baseHeader())), (err: unknown) => {
      assert.ok(fired, "injector never fired (probe vacuous)");
      assert.ok(err instanceof SpoolIoError, `escaped as ${String(err)}`);
      assert.equal((err as Error).cause, fsFault, "fsync fault dropped — retry layer cannot identify it");
      return true;
    });
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g6-F2+F5 owner-artifact fsync fault: admission NEVER acked, cause chain intact, journal survives (no throw)", () => {
  const dir = tmp();
  const bytes = draftBytes(baseHeader());
  spoolDraft(dir, bytes); // clean first
  const fsFault = ioErr("EIO", "injected fsync fault (artifact)");
  let fired = false;
  const restore = setSeam({
    ...passthroughFs(),
    fsyncSync: ((fd: number) => {
      // the artifact fd is the FIRST fd this filing fsyncs (spool was
      // fsynced above, outside the seam window)
      if (!fired) { fired = true; throw fsFault; }
      realFsync(fd);
    }) as typeof realFsync,
  });
  try {
    assert.throws(() => filing(dir, bytes), (err: unknown) => {
      assert.ok(fired, "injector never fired (probe vacuous)");
      assert.ok(err instanceof SpoolIoError, `escaped as ${String(err)}`);
      assert.equal((err as Error).cause, fsFault, "owner-artifact wrap dropped the primary (cause)");
      return true;
    });
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g6-F1 journal syscalls observed: refusal fsyncs journal file, journal dir AND its parent", () => {
  const dir = tmp();
  const bytes = draftBytes(baseHeader());
  spoolDraft(dir, bytes);
  // g7: TWO journal dir levels — the ARTIFACT chain syncs `dir`
  // itself, so the journal's own chain walk is only attributable via
  // an ancestor the artifact never touches (`gnest`). A journal chain
  // walk skipped back to one level still synced `dir` through the
  // artifact path and survived the old one-level probe.
  const jpath = path.join(dir, "gnest", "gnest2", "g.jsonl");
  const obs = fsyncObserver();
  // g7 census: inode of every seam-closed fd (a bare count let a
  // raw-close mutant of the JOURNAL fd pass — g6-F9 lesson).
  const closedInodes = new Set<number>();
  const restore = setSeam({
    ...obs.patch,
    closeSync: ((fd: number) => {
      try { closedInodes.add(fstatSync(fd).ino); } catch { /* fault */ }
      realCloseSync(fd);
    }) as typeof realCloseSync,
  });
  try {
    const res = filing(dir, bytes, { normGate: () => ({ pass: false, code: "norm-unbound" }), gateJournalPath: jpath });
    assert.equal(res.status, "refused-gate");
    // every durability fd closes THROUGH THE SEAM: artifact fd +
    // findings-dir + journal fd + journal-dir chain. A mutant closing
    // raw (pre-fix closeSync) runs BELOW the seam.
    assert.ok(closedInodes.size >= 4, `only ${closedInodes.size} seam closes — a durability fd closed raw (fault injection blind) — g6-F2 regression`);
    assert.ok(obs.inodes.has(statSync(jpath).ino), "journal FILE never fsynced (decision bytes may not survive)");
    assert.ok(obs.inodes.has(statSync(path.dirname(jpath)).ino), "journal dir never fsynced");
    assert.ok(obs.inodes.has(statSync(dir).ino), "g6-F1: journal dir's PARENT never fsynced");
    // g7-F2: the journal chain walk must reach the ancestor the
    // artifact chain NEVER touches — a skipped journal chain dies here.
    assert.ok(
      obs.inodes.has(statSync(path.join(dir, "gnest")).ino),
      "journal chain walk skipped an ancestor dir (g7-F2: full chain before ack, not one parent)",
    );
    // g7-F2: the refusal's journal fd must close THROUGH the seam —
    // a raw-close mutant is invisible to every fault injector.
    assert.ok(closedInodes.has(statSync(jpath).ino), "journal FILE fd never seam-closed (raw close bypassed closeChecked — g7 census)");
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g6-F1+F2 spool-reuse durability observed: reused entry fsyncs FILE + dir + parent even though the dir pre-existed", () => {
  const dir = tmp();
  const bytes = draftBytes(baseHeader());
  const s = spoolDraft(dir, bytes); // drafts dir exists, entry durable
  const obs = fsyncObserver();
  // g6-F9 (audit cycle 1, Terra): the bare `closes >= 1` census did
  // NOT pin the REUSE fd's close — replacing only the reuse path's
  // closeChecked with a raw closeSync left the two dir-sync closes
  // and every inode assertion passing. The census now records the
  // INODE of every seam-closed fd and requires the reuse FILE itself
  // among them (a raw-close mutant drops that inode and fails), plus
  // the full ancestor chain (g7-F2: every name walked must have been
  // opened AND closed through the seam).
  const closedInodes = new Set<number>();
  const restore = setSeam({
    ...obs.patch,
    closeSync: ((fd: number) => {
      try { closedInodes.add(fstatSync(fd).ino); } catch { /* fault */ }
      realCloseSync(fd);
    }) as typeof realCloseSync,
  });
  try {
    assert.equal(spoolDraft(dir, bytes), s, "byte-identical re-spool must reuse");
    const fileIno = statSync(spoolPath(dir, s)).ino;
    assert.ok(closedInodes.has(fileIno), "the reuse FILE's fd was never closed THROUGH THE SEAM (a raw closeChecked bypass — g6-F9 mutant)");
    assert.ok(obs.inodes.has(fileIno), "g6-F1/F1: reused entry FILE was never fsynced (crash-pending entry acked)");
    assert.ok(obs.inodes.has(statSync(path.join(dir, "drafts")).ino), "drafts dir never fsynced on reuse");
    assert.ok(obs.inodes.has(statSync(dir).ino), "g6-F1: drafts dir's PARENT never fsynced on reuse");
    // g7-F2: the chain walk must have OPENED AND CLOSED every ancestor.
    assert.ok(closedInodes.has(statSync(path.join(dir, "drafts")).ino), "drafts dir fd never seam-closed (chain walk truncated?)");
    assert.ok(closedInodes.has(statSync(dir).ino), "episode dir fd never seam-closed (chain walk truncated?)");
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// g7-F3 probe: per-call vs process-state input (mutation probe).
// The gate NO live registry exists in this module — the process state
// that COULD shadow a per-call input is a cached gate: every test in
// this file files with PASS_GATE, so an implementation that cached the
// first gate seen (process state) and ignored the `normGate` parameter
// of later calls would pass the entire suite gate-by-gate. The only
// way to probe it: file MANY times with a passing gate FIRST (this
// file already does, in process order), then file with a DIFFERENT,
// refusing gate — the per-call parameter MUST win. A mutant that
// consults cached state admits the second filing and this probe dies.
// ---------------------------------------------------------------------------

test("g7-F3: the per-call normGate parameter wins over any gate seen earlier this process", () => {
  const dir = tmp();
  // MINOR-5 (g1s6-c2 audit): this probe USED to rely on other tests
  // having filed through PASS_GATE earlier in the process — run in
  // isolation (--test-name-pattern) it vacuously passed a
  // first-call-caching mutant. The PASSING filing now happens INSIDE
  // the probe: the process-state gate is demonstrably a PASSING gate
  // before the refusing call runs, and BOTH outcomes are asserted.
  const passBytes = draftBytes(baseHeader(), "pass-probe");
  spoolDraft(dir, passBytes);
  const passRes = filing(dir, passBytes);
  assert.equal(passRes.status, "applied", "the PASSING filing must apply (probe precondition)");
  // Now a refusing gate must take over, per call — live process state
  // (a cached PASS_GATE) must NOT beat the per-call input:
  const bytes = draftBytes(baseHeader(), "refuse-probe");
  spoolDraft(dir, bytes);
  let sawRecord = false;
  const res = filing(dir, bytes, {
    normGate: (rec) => {
      sawRecord = true;
      return { pass: false, code: "norm-unbound" };
    },
  });
  assert.equal(res.status, "refused-gate", "a refusing gate was ignored — the filing ran on a gate cached from an earlier call (live process state beat the per-call input)");
  assert.ok(sawRecord, "the refusing gate was never invoked (normGate parameter ignored entirely)");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// g7-F5 probe: the findingRef artifact is BYTE-IDENTITY ADDRESSED.
// The applied record's `claimDigest` is defined as sha256 over the
// artifact BYTES, and the artifact bytes are defined as the adjudicated
// draft bytes (spool digest == draftSha256 == storedDigest is checked
// INSIDE intake — but only inside; a mutant moving the digest
// computation to sha(header JSON) or re-serializing the draft before
// writing it would break the external contract every downstream
// consumer relies on: draftSha256 == claimDigest == sha256(file).
// Mutation that survived every existing test: write the artifact as
// the parsed-and-re-serialized header (valid JSON, different bytes)
// while `storedDigest` still claims the draft digest — inside the
// module the self-check passes against its own re-serialization.
// The external triangle (spool digest / record claimDigest / bytes on
// disk) is what pins the contract from the OUTSIDE.
// ---------------------------------------------------------------------------

test("g7-F5: artifact bytes, draft spool digest, and the finding claimDigest are ONE byte-string", () => {
  const dir = tmp();
  const bytes = draftBytes(baseHeader());
  const s = spoolDraft(dir, bytes);
  const res = filing(dir, bytes);
  assert.equal(res.status, "applied");
  if (res.status !== "applied") return; // type narrowing
  // 1. The artifact lives at exactly the record's findingRef, and its
  //    name is the finding's own fresh id (not the act id, not the digest).
  assert.equal(res.artifactPath, path.join(dir, res.finding.findingRef), "artifactPath diverges from the record's findingRef");
  assert.ok(isUlid(res.finding.id), "finding id is not a ULID");
  // 2. The bytes ON DISK are the adjudicated draft bytes, byte for byte.
  const onDisk = readFileSync(res.artifactPath);
  assert.equal(onDisk.equals(bytes), true, "artifact bytes are not the adjudicated draft bytes (re-serialization mutant)");
  // 3. The external digest triangle: spool == claimDigest == sha256(file).
  assert.equal(res.finding.claimDigest, s, "claimDigest diverges from the spool digest of the draft");
  assert.equal(res.finding.claimDigest, sha(onDisk), "claimDigest is not sha256 over the artifact bytes on disk");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// g7-F6 probe: contract agreement between the two durable records a
// gate refusal leaves behind. The journal entry's `lineSha256` is the
// ONLY handle to the refused record (it is never written anywhere),
// and its contract is sha256 over `JSON.stringify(record)` — the
// canonical line content, NOT newline-inclusive, NOT over a
// re-serialized or filtered copy. The gate itself RECEIVES the record
// — so the probe captures the exact refused record through the gate
// parameter and verifies the journal pins THAT record's canonical
// line. Mutation that survives per-record tests: digest the record
// plus a trailing newline (the newline-inclusive bug g1s4-c4
// re-examined), or digest the
// header rather than the built finding — every consumer holding the
// record reconstructs a DIFFERENT digest and silently fails to find
// the refused line. Pin the pair: record seen by the gate == the
// bytes the journal claims to pin.
// ---------------------------------------------------------------------------

test("g7-F6: the gate journal's lineSha256 pins EXACTLY the record the gate refused", () => {
  const dir = tmp();
  const bytes = draftBytes(baseHeader());
  spoolDraft(dir, bytes);
  let refused: AuditFinding | null = null;
  const res = filing(dir, bytes, {
    normGate: (rec) => {
      refused = rec; // capture the record the gate actually saw
      return { pass: false, code: "norm-unbound" };
    },
  });
  assert.equal(res.status, "refused-gate");
  assert.ok(refused !== null, "the gate never saw a record (nothing to pin)");
  const rec = refused as unknown as AuditFinding;
  assert.ok(res.status === "refused-gate");
  // The contract: digest of the canonical line CONTENT (no terminator).
  assert.equal(
    res.journal.lineSha256,
    sha(JSON.stringify(rec)),
    "journal lineSha256 does not pin the refused record's canonical line (newline-inclusive or wrong-object digest)",
  );
  // The refusal names the gate's OWN code and the right episode/task.
  assert.equal(res.journal.refusalCode, "norm-unbound");
  assert.equal(res.journal.episodeId, "ep-1");
  // Durable: the journal file on disk carries the SAME line the entry
  // describes (the write site and the ack agree).
  const lines = readFileSync(gJournal(dir), "utf8").split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1, "journal must hold exactly the one refusal line");
  const firstLine = lines[0];
  assert.ok(firstLine !== undefined, "journal must hold exactly the one refusal line");
  const stored = JSON.parse(firstLine);
  assert.equal(stored.id, res.journal.id, "journal line and returned entry disagree on id");
  assert.equal(stored.lineSha256, res.journal.lineSha256, "journal line and returned entry disagree on the pinned digest");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// g7 probes for the two mutation survivors (round audit):
//   syncdir-close-raw-off — syncDirEntry's finally-block swallowed the
//   close fault: a PLATFORM-REFUSED dir fsync (EINVAL) plus a throwing
//   close fell through the durability step silently. Probe: inject BOTH
//   conditions on DIRECTORY fds only (a portable fs cannot produce the
//   pair) — the compound must throw, never best-effort-return.
//   torn-tail-detect-off — openJournalAppended stopped detecting a
//   trailing partial record. Probe: plant a torn journal (no final
//   newline); the append must QUARANTINE (rename, forensic keep) and
//   recreate, never stack a record behind the torn tail.
// ---------------------------------------------------------------------------

test("g7: dir fsync platform-refusal + throwing dir close must THROW, never best-effort-return", () => {
  const dir = tmp();
  const bytes = draftBytes(baseHeader());
  spoolDraft(dir, bytes);
  let sawDirFsyncRefusal = false;
  let sawDirCloseFault = false;
  const closeFault = ioErr("EBADF", "injected dir close fault");
  const refusal = ioErr("EINVAL", "injected platform dir-fsync refusal");
  const restore = setSeam({
    ...passthroughFs(),
    fsyncSync: ((fd: number) => {
      if (fstatSync(fd).isDirectory()) {
        sawDirFsyncRefusal = true;
        throw refusal; // platform refusal — swallowable on its own
      }
      realFsync(fd);
    }) as typeof realFsync,
    closeSync: ((fd: number) => {
      const isDir = fstatSync(fd).isDirectory();
      realCloseSync(fd);
      if (isDir) {
        sawDirCloseFault = true;
        throw closeFault; // a close fault is NEVER a platform refusal
      }
    }) as typeof realCloseSync,
  });
  try {
    assert.throws(
      () => filing(dir, bytes, { normGate: () => ({ pass: false, code: "norm-unbound" }) }),
      (err: unknown) => {
        assert.ok(sawDirFsyncRefusal && sawDirCloseFault, "injector pair never fired on a dir fd (probe vacuous)");
        assert.ok(err instanceof SpoolIoError, `escaped as ${String(err)}`);
        // the g7-F3 contract: refused fsync + faulting close = a real
        // I/O condition naming BOTH faults, never a silent return.
        assert.match((err as Error).message, /close fault/i, "close fault not reported alongside the refusal");
        assert.ok(
          (err as Error).message.includes("EINVAL") || (err as Error).message.includes("platform") || (err as Error).cause === refusal,
          "the refused fsync dropped out of the reported chain",
        );
        return true;
      },
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g7: torn journal tail is quarantined (forensic), never appended behind", () => {
  const dir = tmp();
  const bytes = draftBytes(baseHeader());
  spoolDraft(dir, bytes);
  // Plant a torn journal: a partial record WITHOUT the final newline
  // (what a crash mid-append leaves behind).
  const jpath = gJournal(dir);
  mkdirSync(path.dirname(jpath), { recursive: true });
  const tornContent = '{"kind":"norm-gate-refusal","id":"01PARTIAL";"tru';
  writeFileSync(jpath, tornContent, "utf8");
  const res = filing(dir, bytes, { normGate: () => ({ pass: false, code: "norm-unbound" }) });
  assert.equal(res.status, "refused-gate");
  // The new journal holds ONLY the new record — every line parses.
  const lines = readFileSync(jpath, "utf8").split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1, "journal gained more than the one new record (stacked behind the torn tail?)");
  const rec = JSON.parse(lines[0] ?? "");
  assert.equal(rec.kind, "norm-gate-refusal");
  assert.equal(rec.refusalCode, "norm-unbound");
  // The torn bytes are FORENSIC: renamed aside, content intact, the
  // fresh journal did not overwrite or delete them.
  const quarantined = readdirSync(dir).filter((n) => n.startsWith("g.jsonl.torn."));
  assert.equal(quarantined.length, 1, "the torn journal was not quarantined to exactly one .torn.* sibling");
  assert.equal(readFileSync(path.join(dir, quarantined[0] ?? ""), "utf8"), tornContent, "quarantined bytes diverge from the planted torn record");
  rmSync(dir, { recursive: true, force: true });
});

test("g1s6-c2 MAJOR-2: a live fence holder REFUSES the append (fail closed)", () => {
  const dir = tmp();
  const bytes = draftBytes(baseHeader());
  spoolDraft(dir, bytes);
  const jpath = gJournal(dir);
  // A CONCURRENT writer holds the fence (fresh mtime = alive).
  writeFileSync(jpath + ".lock", `${process.pid + 1}\n`, "utf8");
  const t0 = Date.now();
  assert.throws(
    () => filing(dir, bytes, { normGate: () => ({ pass: false, code: "norm-unbound" }) }),
    (e: unknown) => e instanceof SpoolIoError && /single-writer fence/.test((e as Error).message),
    "an append ran UNSHIELDED against a held fence",
  );
  assert.ok(Date.now() - t0 >= 1500, "the writer did not actually wait for the holder");
  // The refusal wrote NOTHING to the journal path and left the fence.
  assert.ok(!existsSync(jpath), "a refused append created the journal anyway");
  assert.ok(existsSync(jpath + ".lock"), "the refusal removed someone else's fence");
  rmSync(jpath + ".lock", { force: true });
  rmSync(dir, { recursive: true, force: true });
});

test("g1s6-c2 MAJOR-2: a STALE fence (crashed holder) is taken over", () => {
  const dir = tmp();
  const bytes = draftBytes(baseHeader());
  spoolDraft(dir, bytes);
  const jpath = gJournal(dir);
  writeFileSync(jpath + ".lock", "99999999\n", "utf8");
  // mtime pushed past the staleness window: the holder crashed.
  const past = new Date(Date.now() - 60_000);
  utimesSync(jpath + ".lock", past, past);
  const res = filing(dir, bytes, { normGate: () => ({ pass: false, code: "norm-unbound" }) });
  assert.equal(res.status, "refused-gate");
  const lines = readFileSync(jpath, "utf8").split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0] ?? "").refusalCode, "norm-unbound");
  // The fence is RELEASED after the append (no leak for the next writer).
  assert.ok(!existsSync(jpath + ".lock"), "the fence leaked after the append completed");
  rmSync(dir, { recursive: true, force: true });
});

test("g1s6-c2 MAJOR-2: two PROCESSES appending one journal — every record survives whole", () => {
  // True cross-process regression: before the fence, process A's
  // torn-tail check could quarantine process B's IN-FLIGHT partial
  // record while B still returned success against the renamed inode.
  // Here two child processes each append 12 journaled refusals to
  // the SAME journal; with the fence, every line parses and no live
  // append is ever quarantined.
  const dir = tmp();
  const jpath = gJournal(dir);
  const childSrc = `
import { createHash } from "node:crypto";
import { intakeFiling, spoolDraft, DRAFT_MAGIC } from ${JSON.stringify(new URL("../src/findings/intake.js", import.meta.url).href)};
const sha = (s) => createHash("sha256").update(s).digest("hex");
const [dir, jpath, seed] = [process.argv[2], process.argv[3], process.argv[4]];
const CROCK = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = (n) => { let s = ""; for (let i = 0; i < 26; i++) s += CROCK[(n * 31 + i * 7 + seed.charCodeAt(0)) % 32]; return s; };
for (let i = 0; i < 12; i++) {
  const header = { route: "code-fix", surface: "code", severity: "major", verdictBasis: "repro",
    claim: "c" + i, correctionOf: null, cureActRef: null, scopeRefs: ["s"], evidenceRefs: ["e" + i],
    repro: { kind: "probe", command: "npm t", preFixObserved: "x", postFixExpected: "y" }, affectedNorm: null };
  const bytes = Buffer.from(\`\${DRAFT_MAGIC}\\n\${JSON.stringify(header)}\\nprose\`, "utf8");
  spoolDraft(dir, bytes);
  try {
    intakeFiling({
      episodeDir: dir, episodeId: "ep-race", prefix: [], prefixLines: [],
      normGate: () => ({ pass: false, code: "norm-unbound" }),
      gateJournalPath: jpath,
      act: {
        schema: "tre-supervisor/1", id: ulid(i), ts: 1, episodeId: "ep-race",
        kind: "owner-act", op: "audit-filing",
        payload: { findingDraftRef: "drafts/live.md", draftSha256: sha(bytes), claim: "c" + i, cycle: 1, taskId: null, cureActRef: null },
        payloadDigest: sha("d" + i), channel: "tty:dev", sessionRef: null, effectRecordIds: [],
      },
      producer: { endpoint: "ep", model: "m", sessionId: "s" },
      existingIds: new Set(), now: 1,
    });
  } catch (e) {
    // A contended-fence refusal is ITSELF a correct fail-closed
    // outcome — the parent asserts journal integrity either way.
    if (!/single-writer fence/.test(String(e && e.message))) { process.exitCode = 3; console.error(String(e && e.stack)); }
  }
}
`;
  const childFile = path.join(dir, "race-child.mjs");
  writeFileSync(childFile, childSrc, "utf8");
  // CONCURRENT: both children are spawned before either is awaited.
  const kids = ["aa", "bb"].map((seed) => {
    const child = spawn(process.execPath, [childFile, dir, jpath, seed]);
    let err = "";
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    return new Promise<{ code: number | null; err: string }>((resolve) =>
      child.on("close", (code) => resolve({ code, err })),
    );
  });
  return Promise.all(kids).then(async (results) => {
    for (const k of results) assert.equal(k.code, 0, `child failed: ${k.err}`);
  const lines = readFileSync(jpath, "utf8").split("\n").filter((l) => l.length > 0);
  let refusals = 0;
  for (const l of lines) {
    const rec = JSON.parse(l); // every line parses — no interleaved record
    assert.equal(rec.kind, "norm-gate-refusal");
    refusals++;
  }
  assert.ok(refusals >= 2, "the race produced no usable refusals at all");
  assert.ok(!readdirSync(dir).some((n) => n.includes(".torn.")),
    "a live concurrent append was quarantined as crash damage (MAJOR-2)");
  assert.ok(!existsSync(jpath + ".lock"), "the fence leaked after both writers finished");
  rmSync(dir, { recursive: true, force: true });
  });
});

test("g1s6-c2 MAJOR-1: torn tail with ACKED records before it — the prefix stays on the live path", () => {
  const dir = tmp();
  const bytes = draftBytes(baseHeader());
  spoolDraft(dir, bytes);
  const jpath = gJournal(dir);
  mkdirSync(path.dirname(jpath), { recursive: true });
  // Plant: TWO complete acked records + a torn tail. The MAJOR-1
  // defect renamed the WHOLE file aside — both acked records vanished
  // from the live journal path (no reader merges .torn.* siblings).
  const ackedA = '{"kind":"norm-gate-refusal","id":"01AAAAAAAAAAAAAAAAAAAA","forensic":"A"}\n';
  const ackedB = '{"kind":"norm-gate-refusal","id":"01BBBBBBBBBBBBBBBBBBBB","forensic":"B"}\n';
  const tornSuffix = '{"kind":"norm-gate-refusal","id":"01CCCCCCCCCCCCCCCCCCCC";"tr';
  writeFileSync(jpath, ackedA + ackedB + tornSuffix, "utf8");
  const res = filing(dir, bytes, { normGate: () => ({ pass: false, code: "norm-unbound" }) });
  assert.equal(res.status, "refused-gate");
  // The live journal holds BOTH acked records + the new refusal, in
  // order, and EVERY line parses — the acked prefix was never hidden.
  const lines = readFileSync(jpath, "utf8").split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 3, "live journal lost acked records or stacked behind the torn tail");
  assert.equal(lines[0], ackedA.trimEnd(), "acked record A vanished from the live journal");
  assert.equal(lines[1], ackedB.trimEnd(), "acked record B vanished from the live journal");
  const rec = JSON.parse(lines[2] ?? "");
  assert.equal(rec.refusalCode, "norm-unbound");
  // The forensic sibling is EXACTLY the torn suffix (the bytes after
  // the last newline) — durable before the live journal was cut.
  const quarantined = readdirSync(dir).filter((n) => n.startsWith("g.jsonl.torn."));
  assert.equal(quarantined.length, 1, "torn suffix was not quarantined to exactly one .torn.* sibling");
  assert.equal(
    readFileSync(path.join(dir, quarantined[0] ?? ""), "utf8"),
    tornSuffix,
    "the forensic sibling must be exactly the torn suffix, byte for byte",
  );
  rmSync(dir, { recursive: true, force: true });
});

/* ================= MINOR-4: cause-preservation edge cases ========== */

/** Run spoolDraft with an fsync fault carrying a crafted cause, and a
 * close fault on top — exercising closeChecked's attach/compound
 * paths over primaries with occupied / frozen / cyclic cause chains. */
const spoolWithCauseChain = (primaryCause: unknown, freezePrimary = false) => {
  const dir = tmp();
  const fsFault = ioErr("EIO", "injected fsync fault");
  if (primaryCause !== undefined) (fsFault as { cause?: unknown }).cause = primaryCause;
  if (freezePrimary) Object.freeze(fsFault);
  const closeFault = ioErr("EBADF", "injected close fault (MINOR-4)");
  let firedSync = false;
  const restore = setSeam({
    ...passthroughFs(),
    fsyncSync: ((fd: number) => {
      if (!firedSync) { firedSync = true; throw fsFault; }
      realFsync(fd);
    }) as typeof realFsync,
    closeSync: ((fd: number) => {
      try { realCloseSync(fd); } catch { /* ignore */ }
      throw closeFault;
    }) as typeof realCloseSync,
  });
  try {
    spoolDraft(dir, draftBytes(baseHeader()));
    return { threw: null as unknown, dir };
  } catch (e) {
    return { threw: e, dir };
  } finally {
    restore();
  }
};

test("g1s6-c2 MINOR-4: non-Error cause on the primary is NEVER overwritten — compound keeps both", () => {
  const { threw, dir } = spoolWithCauseChain("a-string-cause");
  try {
    assert.ok(threw instanceof SpoolIoError, `escaped as ${String(threw)}`);
    // The compound retains the primary as cause; the close fault rides
    // its OWN closeCause property (MINOR-4), and the primary's own
    // non-Error cause slot survived untouched.
    const compound = threw as SpoolIoError;
    assert.ok(String(compound.message).includes("close fault AFTER primary durability failure"),
      "not the compound path");
    assert.ok((compound as { closeCause?: unknown }).closeCause !== undefined,
      "closeCause own-property missing — close fault survives only as text (MINOR-4)");
    assert.ok(compound.cause instanceof Error, "primary lost from the compound");
    assert.equal((compound.cause as Error).message, "injected fsync fault");
    assert.equal((compound.cause as { cause?: unknown }).cause, "a-string-cause",
      "the primary's occupied non-Error cause slot was CLOBBERED (MINOR-4)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s6-c2 MINOR-4: cyclic cause chain refuses the attach, compound keeps both, cycle intact", () => {
  const a = ioErr("EIO", "cycle node a");
  const b = ioErr("EIO", "cycle node b");
  (a as { cause?: unknown }).cause = b;
  (b as { cause?: unknown }).cause = a;
  const { threw, dir } = spoolWithCauseChain(a);
  try {
    assert.ok(threw instanceof SpoolIoError, `escaped as ${String(threw)}`);
    const compound = threw as SpoolIoError;
    assert.ok(String(compound.message).includes("close fault AFTER primary durability failure"),
      "cyclic primary chain accepted an attach (would corrupt the cycle)");
    assert.ok((compound as { closeCause?: unknown }).closeCause !== undefined,
      "closeCause own-property missing on the cyclic-chain compound");
    assert.equal((a as { cause?: unknown }).cause, b, "cycle node a was rewritten");
    assert.equal((b as { cause?: unknown }).cause, a, "cycle node b was rewritten");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s6-c2 MINOR-4: FROZEN primary -> compound carries cause AND a closeCause own property", () => {
  const { threw, dir } = spoolWithCauseChain(undefined, true);
  try {
    assert.ok(threw instanceof SpoolIoError, `escaped as ${String(threw)}`);
    const compound = threw as SpoolIoError;
    assert.ok(String(compound.message).includes("close fault AFTER primary durability failure"),
      "frozen primary did not take the compound path");
    assert.ok(compound.cause !== undefined, "primary lost from the frozen-path compound");
    assert.match((compound.cause as Error).message, /injected fsync fault/);
    const cc = Object.getOwnPropertyDescriptor(compound, "closeCause");
    assert.ok(cc && cc.value !== undefined,
      "closeCause own-property missing despite the comment claiming one (MINOR-4)");
    assert.match((cc!.value as Error).message, /injected close fault/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g1s6-c2 MINOR-6: a dir-close fault carrying literal null is STILL a fault — never a silent return", () => {
  const dir = tmp();
  const restore = setSeam({
    ...passthroughFs(),
    closeSync: ((fd: number) => {
      const isDir = fstatSync(fd).isDirectory();
      realCloseSync(fd);
      if (isDir) {
        // MINOR-6: the OLD sentinel (`closeFault !== null`) treated a
        // thrown null as NO fault and returned success. A close that
        // faults is a fault whatever it carries.
        // eslint-disable-next-line no-throw-literal
        throw null;
      }
    }) as typeof realCloseSync,
  });
  try {
    assert.throws(
      () => syncDirEntry(dir),
      (err: unknown) => {
        assert.ok(err instanceof SpoolIoError, `a null-carrying close fault escaped as ${String(err)} (MINOR-6)`);
        assert.match((err as Error).message, /close fault while syncing/, "not the close-fault path");
        return true;
      },
      "syncDirEntry RETURNED SUCCESS on a null-carrying close fault (MINOR-6)",
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
