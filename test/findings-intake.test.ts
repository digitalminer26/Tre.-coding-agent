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
  readFileSync,
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
  admitAuditorFinding,
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

/* ================= spool admission (§14.10.3) ================= */

test("spool: producer writes content-addressed durable entry; consumer re-hashes OK", () => {
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

test("spool: over-cap draft refused AT INPUT, nothing written", () => {
  const dir = tmp();
  try {
    const big = Buffer.alloc(DRAFT_CAP_BYTES + 1, 0x61);
    assert.throws(() => spoolDraft(dir, big), IntakeInputError);
    assert.equal(existsSync(path.join(dir, "drafts")), false);
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

test("spool consumer: absent vs mismatch outcomes carry self-evidence", () => {
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
  const b = prefixBinding(pfx);
  assert.equal(b.intakePrefixEndId, "01B");
  // running digest = fold of canonical lines, order-sensitive:
  let d = prefixDigestInitial();
  for (const r of pfx) d = prefixDigestStep(d, JSON.stringify(r));
  assert.equal(b.intakePrefixSha256, d);
  assert.notEqual(prefixBinding(pfx.slice(0, 1)).intakePrefixSha256, d);
});

/* ================= filing adjudication ================= */

test("filing applied: artifact durable, claimDigest = sha256(artifact), cycle from ACT payload only", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    spoolDraft(dir, bytes);
    const res = intakeFiling({
      episodeDir: dir,
      episodeId: "ep-1",
      prefix: [],
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

test("drift: missing spool is owner-filing-draft-drift (filesystem-observation; bytes NOT embedded)", () => {
  const dir = tmp();
  try {
    const bytes = draftBytes(baseHeader());
    const pfx: PrefixRecord[] = [{ kind: "note", id: "01P" }];
    const res = intakeFiling({
      episodeDir: dir,
      episodeId: "ep-1",
      prefix: pfx,
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
    const b = prefixBinding(pfx);
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
      episodeDir: dir, episodeId: "ep-1", prefix: [],
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
      episodeDir: dir, episodeId: "ep-1", prefix: [],
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
      episodeDir: dir, episodeId: "ep-1", prefix: [],
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
      episodeDir: dir, episodeId: "ep-1", prefix: [],
      act: filingAct(payloadFor(bytes, { cureActRef: null })),
      producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(r1.status, "refused");
    if (r1.status === "refused") assert.equal(r1.refusal.diagnosticCode, "owner-filing-mapping");

    const bytesNoField = draftBytes({ ...baseHeader(), cureActRef: undefined });
    spoolDraft(dir, bytesNoField);
    const r2 = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [],
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
      episodeDir: dir, episodeId: "ep-1", prefix: [],
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
      episodeDir: dir, episodeId: "ep-1", prefix: [],
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
      episodeDir: dir, episodeId: "ep-1", prefix: curePrefix,
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
      episodeDir: dir, episodeId: "ep-1", prefix: [],
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
      episodeDir: fx.dir, episodeId: "ep-1", prefix: fx.pfx,
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
      episodeDir: fx.dir, episodeId: "ep-1", prefix: fx.pfx,
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
      episodeDir: fx.dir, episodeId: "ep-1", prefix: fx.pfx,
      act: filingAct(payloadFor(down)), producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(r1.status, "refused");
    if (r1.status === "refused") assert.equal(r1.refusal.diagnosticCode, "correction-severity-decrease");

    const rerouted = draftBytes(baseHeader({ correctionOf: fx.targetId, route: "human-review" }));
    spoolDraft(fx.dir, rerouted);
    const r2 = intakeFiling({
      episodeDir: fx.dir, episodeId: "ep-1", prefix: fx.pfx,
      act: filingAct(payloadFor(rerouted)), producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(r2.status, "refused");
    if (r2.status === "refused") assert.equal(r2.refusal.diagnosticCode, "correction-route-mismatch");

    const good = draftBytes(baseHeader({ correctionOf: fx.targetId, severity: "blocker" }));
    spoolDraft(fx.dir, good);
    const r3 = intakeFiling({
      episodeDir: fx.dir, episodeId: "ep-1", prefix: fx.pfx,
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
      episodeDir: dir, episodeId: "ep-1", prefix: [],
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
      episodeDir: dir, episodeId: "ep-1", prefix: [],
      act: filingAct(payloadFor(minorBytes)), producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(r2.status, "applied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed-input: bad act payload shape refuses with null bytes (draft never read)", () => {
  const dir = tmp();
  try {
    const bad = { findingDraftRef: "x", draftSha256: "not-hex", claim: "c", cycle: 1, taskId: null, cureActRef: null };
    const res = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [],
      act: filingAct(bad as unknown as AuditFilingPayload),
      producer: PRODUCER, existingIds: new Set(), now: 1,
    });
    assert.equal(res.status, "refused");
    if (res.status !== "refused") return;
    assert.equal(res.refusal.diagnosticCode, "malformed-input");
    assert.equal(res.refusal.adjudicatedDraftBytes, null);
    assert.equal(res.refusal.spoolObserved, null);
    assert.equal(existsSync(path.join(dir, "drafts")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refusal id is minted and NOT among existing ids (collision refusal shared)", () => {
  const dir = tmp();
  try {
    const taken = new Set<string>();
    const res = intakeFiling({
      episodeDir: dir, episodeId: "ep-1", prefix: [],
      act: filingAct({ findingDraftRef: "x", draftSha256: "zz", claim: "c", cycle: 1, taskId: null, cureActRef: null } as unknown as AuditFilingPayload),
      producer: PRODUCER, existingIds: taken, now: 1,
    });
    assert.equal(res.status, "refused");
    if (res.status === "refused") assert.equal(isUlid(res.refusal.id), true);
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

test("gate: fail refuses, journals the line hash, record NEVER becomes an audit-finding", () => {
  const dir = tmp();
  try {
    const journalPath = path.join(dir, "s5", "decisions.jsonl");
    const res = admitAuditorFinding(
      dir,
      { episodeId: "ep-1", taskId: "t1", receiptId: "r-9", candidate: auditorCandidate(), now: 5 },
      {
        takenIds: new Set(),
        artifactBytes: Buffer.from("x", "utf8"),
        normGate: () => ({ pass: false, code: "norm-unbound" }),
        journalPath,
      },
    );
    assert.equal(res.status, "refused-gate");
    if (res.status !== "refused-gate") return;
    assert.equal(res.journal.refusalCode, "norm-unbound");
    assert.equal(res.journal.gateError, null);
    assert.ok(isSha256Hex(res.journal.lineSha256));
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
      { episodeId: "ep-1", taskId: null, receiptId: "r-9", candidate: auditorCandidate({ route: "human-review", surface: "spec" }), now: 1 },
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

    // vocab violation refused BEFORE the gate (NDR-t(1)):
    assert.throws(
      () =>
        admitAuditorFinding(
          dir,
          { episodeId: "ep-1", taskId: null, receiptId: "r", candidate: auditorCandidate({ severity: "critical" }), now: 1 },
          { takenIds: new Set(), artifactBytes: Buffer.from("z"), normGate: () => ({ pass: true }), journalPath: path.join(dir, "j2.jsonl") },
        ),
      IntakeInputError,
    );
    // owner-mode candidate through an auditor endpoint refused (NDR-a):
    assert.throws(
      () =>
        admitAuditorFinding(
          dir,
          { episodeId: "ep-1", taskId: null, receiptId: "r", candidate: auditorCandidate({ origin: "owner", originRef: null, ownerActRef: "a-1" }), now: 1 },
          { takenIds: new Set(), artifactBytes: Buffer.from("z"), normGate: () => ({ pass: true }), journalPath: path.join(dir, "j3.jsonl") },
        ),
      IntakeInputError,
    );
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
      producer: PRODUCER, now: 1,
    };
    const act1 = filingAct(payloadFor(bytes), { id: "01ACT10000000000000000A1" });
    const r1 = refileAttempt({ ...base, act: act1, existingIds: new Set() });
    assert.equal(r1.status, "applied");
    if (r1.status !== "applied") return;
    // second attempt: new act id, identical draft bytes; the first
    // finding now stands in the prefix (its id is taken):
    const taken = new Set<string>([r1.finding.id]);
    const act2 = filingAct(payloadFor(bytes), { id: "01ACT20000000000000000A2" });
    const r2 = refileAttempt({ ...base, prefix: [], act: act2, existingIds: taken });
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
    };
    const r1 = refileAttempt({
      ...base, prefix: fx.pfx,
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
      ...base, prefix: pfx2,
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
