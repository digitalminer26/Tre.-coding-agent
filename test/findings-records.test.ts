/**
 * G1 step 1 — `src/findings/records.ts` wire-shape tests.
 *
 * SCOPE: these are PREDICATE tests over the step-1 wires (closed sets,
 * nullability, determinism, the NDR-q registration seam). The schema's
 * worked EXAMPLE vectors (V-g1…V-g13, r4 chain, cure vectors) are NOT
 * ported here: per g1-implementation-mapping.md Q3 (CONFIRMED
 * verbatim) each port rides with the module that owns the behavior, so
 * the V-g ports land with step 7 (`recovery.ts` — V-g8…V-g13; the V-g13
 * per-file-establishment note in the step-1 row refers to those ports)
 * and the lineage/r4 vectors with step 3. Step 1 has no behavior to
 * vector against — only shapes.
 *
 * Check-10 (mapping Q4, CONFIRMED with the step-9 refinement): HARD
 * ENFORCEMENT waits for `inventory.ts` (step 9 closes the id set —
 * the mechanical analogue of NDR-q totality); until then every-NDR-id-
 * present is exercised HERE as the per-step self-discipline gate
 * (mapping: "Steps 1–8 carry the grep as a per-step self-discipline
 * gate") — see `every NDR id appears at its wire obligation`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENTRY_MODE_CLOSED_SET,
  FILING_REFUSAL_CODE_CLOSED_SET,
  KIND_TABLE,
  MIXED_CHECK_CODES,
  RECORD_KIND_CLOSED_SET,
  allRefusalCodesClassified,
  checkClassOfRefusalCode,
  conditionByCode,
  conditions,
  cureSettlementId,
  entryModeOf,
  inClosedSet,
  isBytesProvenanceValid,
  isDispositionRecordRefusalBindingValid,
  isFaultRecordNullabilityValid,
  isFindingReproSatisfied,
  isGreenOutcome,
  isMixedCheckCode,
  isMinorOwnerExceptionAccept,
  isOutcomeDependencyValid,
  isOutcomePinnedCombinationValid,
  isPinnedVerdictValid,
  isRecordKind,
  isRouteSurfaceValid,
  isSettlementWitnessValid,
  isSha256Hex,
  isUlid,
  isUpdateShapeValid,
  registerCondition,
  ROUTE_CLOSED_SET,
  SEVERITY_CLOSED_SET,
  SURFACE_CLOSED_SET,
  OWNER_ACT_OPS_CLOSED_SET,
  FAILING_CHECK_CLOSED_SET,
  UPDATE_TO_CLOSED_SET,
  type AuditFindingUpdate,
  type CanonicalCondition,
  type OwnerActPayloadMap,
  type LineageEdgeRetirePayload,
} from "../src/findings/records.js";
import * as recordsModule from "../src/findings/records.js";

/* ---------- primitives -------------------------------------------- */

test("isUlid: 26 Crockford base32, uppercase; rejects otherwise", () => {
  assert.equal(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"), true);
  assert.equal(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FA"), false); // 25
  assert.equal(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAVA"), false); // 27
  assert.equal(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAU"), false); // U not in alphabet
  assert.equal(isUlid("01arz3ndektsv4rrffq69g5fav"), false); // lowercase refused
});

test("isSha256Hex: 64 lowercase hex", () => {
  assert.equal(isSha256Hex("a".repeat(64)), true);
  assert.equal(isSha256Hex("A".repeat(64)), false);
  assert.equal(isSha256Hex("g".repeat(64)), false);
  assert.equal(isSha256Hex("a".repeat(63)), false);
});

/* ---------- route × surface (NDR-t(2)) ------------------------------ */

test("route×surface: spec×code-fix is the ONLY refused pair", () => {
  assert.equal(isRouteSurfaceValid("code-fix", "spec"), false);
  assert.equal(isRouteSurfaceValid("code-fix", "code"), true);
  assert.equal(isRouteSurfaceValid("code-fix", "test"), true);
  assert.equal(isRouteSurfaceValid("code-fix", "doc"), true);
  assert.equal(isRouteSurfaceValid("human-review", "spec"), true);
  assert.equal(isRouteSurfaceValid("human-review", "code"), true);
});

/* ---------- entry modes (v7 R4-C1-2 table) -------------------------- */

test("entryModeOf: the three legal rows of the §14.10.1 table", () => {
  assert.equal(
    entryModeOf({
      origin: "auditor",
      originRef: { origin: "intake", receiptId: "r1" },
      ownerActRef: null,
    }),
    "auditor-intake",
  );
  assert.equal(
    entryModeOf({ origin: "owner", originRef: null, ownerActRef: "a1" }),
    "owner-act",
  );
  assert.equal(
    entryModeOf({
      origin: "auditor",
      originRef: { origin: "supervisor-derived", fromRefusalId: "x" },
      ownerActRef: null,
    }),
    "supervisor-derived",
  );
  assert.equal(
    entryModeOf({
      origin: "owner",
      originRef: { origin: "supervisor-derived", fromRefusalId: "x" },
      ownerActRef: null,
    }),
    "supervisor-derived",
  );
  assert.equal(ENTRY_MODE_CLOSED_SET.length, 3);
});

test("entryModeOf: every refused combination returns null", () => {
  // both originRef and ownerActRef
  assert.equal(
    entryModeOf({
      origin: "owner",
      originRef: { origin: "intake", receiptId: "r" },
      ownerActRef: "a1",
    }),
    null,
  );
  // owner with neither ref
  assert.equal(entryModeOf({ origin: "owner", originRef: null, ownerActRef: null }), null);
  // owner-act row with originRef shape rejected: owner + intake originRef + no act
  assert.equal(
    entryModeOf({ origin: "owner", originRef: { origin: "intake", receiptId: "r" }, ownerActRef: null }),
    null,
  );
  // auditor with no originRef
  assert.equal(entryModeOf({ origin: "auditor", originRef: null, ownerActRef: null }), null);
  // supervisor-derived but ownerActRef set
  assert.equal(
    entryModeOf({
      origin: "auditor",
      originRef: { origin: "supervisor-derived", fromRefusalId: "x" },
      ownerActRef: "a1",
    }),
    null,
  );
});

/* ---------- repro shape (NDR-b) ------------------------------------- */

test("isFindingReproSatisfied: kind:none legal only for minor", () => {
  const none = { kind: "none", command: "", preFixObserved: "", postFixExpected: "" } as const;
  assert.equal(isFindingReproSatisfied({ severity: "minor", repro: none }), true);
  assert.equal(isFindingReproSatisfied({ severity: "major", repro: none }), false);
  assert.equal(isFindingReproSatisfied({ severity: "blocker", repro: none }), false);
  const probe = { kind: "probe", command: "c", preFixObserved: "p", postFixExpected: "q" } as const;
  assert.equal(isFindingReproSatisfied({ severity: "blocker", repro: probe }), true);
  // R1 fold (cycle-2 audit): the input shape is Pick<severity|repro>
  // BY DESIGN — the canonical NDR-b rule carries NO route clause
  // (docs/11:1739 "for every producer"), so the predicate is
  // route-free: a `human-review` + major + kind:none filing is
  // refused too. The route param would widen BEYOND the rule.
  type ReproCheckInput = Parameters<typeof isFindingReproSatisfied>[0];
  const routeFree: ReproCheckInput = { severity: "major", repro: none };
  void routeFree;
  assert.equal(isFindingReproSatisfied(routeFree), false);
});

/* ---------- update shape (NDR-b exception) --------------------------- */

const baseUpdate: AuditFindingUpdate = {
  schema: "tre-supervisor/1",
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAU".slice(0, 25) + "V",
  ts: 0,
  episodeId: "e1",
  kind: "audit-finding-update",
  findingId: "f1",
  to: "accepted-fix",
  dispositionBy: "owner",
  authority: null,
  reproRunRef: null,
  supersedes: null,
  reason: "r",
};

test("isUpdateShapeValid: required operands per closure", () => {
  assert.equal(isUpdateShapeValid(baseUpdate, "minor"), true, "minor accepted-fix: run optional");
  assert.equal(isUpdateShapeValid(baseUpdate, "major"), false, "non-minor accepted-fix: run REQUIRED");
  assert.equal(isUpdateShapeValid({ ...baseUpdate, reproRunRef: "rr" }, "major"), true);
  assert.equal(isUpdateShapeValid({ ...baseUpdate, to: "rejected-refuted", reproRunRef: null }, "minor"), false);
  assert.equal(isUpdateShapeValid({ ...baseUpdate, to: "rejected-refuted", reproRunRef: "rr" }, "blocker"), true);
  assert.equal(isUpdateShapeValid({ ...baseUpdate, to: "closed-residual", authority: null }, "minor"), false);
  assert.equal(isUpdateShapeValid({ ...baseUpdate, to: "closed-residual", authority: "pol" }, "minor"), true);
  assert.equal(isUpdateShapeValid({ ...baseUpdate, to: "rejected-duplicate", supersedes: null }, "minor"), false);
  assert.equal(isUpdateShapeValid({ ...baseUpdate, to: "rejected-duplicate", supersedes: "f0" }, "minor"), true);
  assert.equal(isUpdateShapeValid({ ...baseUpdate, to: "superseded", supersedes: "f0" }, "minor"), true);
});

test("isMinorOwnerExceptionAccept: in-record conditions only", () => {
  const ok = { to: "accepted-fix", dispositionBy: "owner", reproRunRef: null } as const;
  assert.equal(isMinorOwnerExceptionAccept("minor", ok), true);
  assert.equal(isMinorOwnerExceptionAccept("major", ok), false, "severity gate");
  assert.equal(
    isMinorOwnerExceptionAccept("minor", { ...ok, dispositionBy: "orchestrator" }),
    false,
    "dispositionBy gate",
  );
  assert.equal(
    isMinorOwnerExceptionAccept("minor", { ...ok, reproRunRef: "rr" }),
    false,
    "null-run gate (exception excuses ABSENCE)",
  );
});

/* ---------- refusal check classes (NDR-f) ---------------------------- */

test("NDR-f MIXED class is the CLOSED FIVE (v34 D1(a) fold)", () => {
  assert.deepEqual(
    [...MIXED_CHECK_CODES].sort(),
    [
      "correction-ambiguity",
      "correction-bad-target",
      "correction-route-mismatch",
      "correction-severity-decrease",
      "cure-unknown-act",
    ],
  );
  assert.equal(isMixedCheckCode("cure-unknown-act"), true);
  assert.equal(checkClassOfRefusalCode("cure-unknown-act"), "mixed");
});

test("checkClassOfRefusalCode: totality over the nine codes (strict post-v34)", () => {
  assert.equal(FILING_REFUSAL_CODE_CLOSED_SET.length, 9);
  assert.equal(allRefusalCodesClassified(), true);
  for (const code of FILING_REFUSAL_CODE_CLOSED_SET) {
    const cls = checkClassOfRefusalCode(code);
    assert.ok(cls !== null, `${code} must be classified`);
    assert.ok(["draft-derivative", "mixed", "filesystem-observation"].includes(cls ?? ""));
  }
  assert.equal(checkClassOfRefusalCode("not-a-code"), null);
});

/* ---------- fault nullability (NDR-h) -------------------------------- */

test("isFaultRecordNullabilityValid: refusalRecordId iff intake-refusal", () => {
  assert.equal(
    isFaultRecordNullabilityValid({ failingCheck: "intake-refusal", refusalRecordId: "r1" }),
    true,
  );
  assert.equal(
    isFaultRecordNullabilityValid({ failingCheck: "intake-refusal", refusalRecordId: null }),
    false,
  );
  assert.equal(
    isFaultRecordNullabilityValid({ failingCheck: "effect-record", refusalRecordId: null }),
    true,
  );
  assert.equal(
    isFaultRecordNullabilityValid({ failingCheck: "effect-record", refusalRecordId: "r1" }),
    false,
  );
});

test("isDispositionRecordRefusalBindingValid: binding iff intake-refusal+withdrawn", () => {
  const bound = {
    outcome: "withdrawn",
    refusalRecordId: "r1",
    readjudicationPrefixEndId: "e",
    readjudicationPrefixSha256: "h",
  } as const;
  assert.equal(isDispositionRecordRefusalBindingValid(bound, "intake-refusal"), true);
  assert.equal(isDispositionRecordRefusalBindingValid(bound, "effect-record"), false, "binding without intake-refusal fault");
  assert.equal(
    isDispositionRecordRefusalBindingValid({ ...bound, outcome: "refiled" }, "intake-refusal"),
    false,
    "binding on refiled",
  );
  assert.equal(
    isDispositionRecordRefusalBindingValid(
      { outcome: "withdrawn", refusalRecordId: null, readjudicationPrefixEndId: null, readjudicationPrefixSha256: null },
      "intake-refusal",
    ),
    false,
    "intake-refusal+withdrawn WITHOUT binding",
  );
});

/* ---------- outcome guards (NDR-i/e, v18 R5-C12-4) ------------------- */

test("isOutcomeDependencyValid: findingId xor refusalRecordId by outcome", () => {
  assert.equal(isOutcomeDependencyValid({ outcome: "applied", findingId: "f", refusalRecordId: null }), true);
  assert.equal(isOutcomeDependencyValid({ outcome: "applied", findingId: null, refusalRecordId: null }), false);
  assert.equal(isOutcomeDependencyValid({ outcome: "refused", findingId: null, refusalRecordId: "r" }), true);
  assert.equal(isOutcomeDependencyValid({ outcome: "refused", findingId: "f", refusalRecordId: "r" }), false);
});

test("isBytesProvenanceValid: observedSha256 iff fresh-spool (NDR-e)", () => {
  assert.equal(isBytesProvenanceValid({ bytesSource: "fresh-spool", observedSha256: "h" }), true);
  assert.equal(isBytesProvenanceValid({ bytesSource: "fresh-spool", observedSha256: null }), false);
  assert.equal(isBytesProvenanceValid({ bytesSource: "content-addressed", observedSha256: null }), true);
  assert.equal(isBytesProvenanceValid({ bytesSource: "content-addressed", observedSha256: "h" }), false);
  assert.equal(isBytesProvenanceValid({ bytesSource: "none", observedSha256: null }), true);
});

test("isPinnedVerdictValid / isOutcomePinnedCombinationValid (v18 R5-C12-4)", () => {
  assert.equal(isPinnedVerdictValid({ pinnedVerdict: "eligible", pinnedVerdictCode: null }), true);
  assert.equal(isPinnedVerdictValid({ pinnedVerdict: "eligible", pinnedVerdictCode: "c" }), false);
  assert.equal(isPinnedVerdictValid({ pinnedVerdict: "refused", pinnedVerdictCode: "c" }), true);
  assert.equal(isOutcomePinnedCombinationValid({ outcome: "applied", pinnedVerdict: "eligible", pinnedVerdictCode: null }), true);
  assert.equal(isOutcomePinnedCombinationValid({ outcome: "applied", pinnedVerdict: "refused", pinnedVerdictCode: "c" }), false, "a pinned refusal cannot mint an effect");
  // gate refusal (NDR-j): outcome refused + pinnedVerdict eligible + null code is LEGAL
  assert.equal(isOutcomePinnedCombinationValid({ outcome: "refused", pinnedVerdict: "eligible", pinnedVerdictCode: null }), true);
});

/* ---------- cure wires (NDR-u) ---------------------------------------- */

test("cureSettlementId: pure, deterministic (v26 R5-C18F-2)", () => {
  assert.equal(cureSettlementId("01ABC"), "cure-settlement-01ABC");
  assert.equal(cureSettlementId("x") === cureSettlementId("x"), true);
  assert.notEqual(cureSettlementId("x"), cureSettlementId("y"));
});

test("isSettlementWitnessValid: witness iff accepted-fix (v28 R5-C20-3)", () => {
  const w = { executedArtifactDigest: "d", expectedFixBaseline: "b", result: "ancestor-proper" } as const;
  assert.equal(isSettlementWitnessValid({ route: "accepted-fix", ancestryWitness: w }), true);
  assert.equal(isSettlementWitnessValid({ route: "accepted-fix", ancestryWitness: null }), false);
  assert.equal(isSettlementWitnessValid({ route: "fresh-finding-cycle", ancestryWitness: null }), true);
  assert.equal(isSettlementWitnessValid({ route: "fresh-finding-cycle", ancestryWitness: w }), false);
});

test("isGreenOutcome: only green is a green outcome (NDR-s three values)", () => {
  assert.equal(isGreenOutcome("green"), true);
  assert.equal(isGreenOutcome("red"), false);
  assert.equal(isGreenOutcome("not-reproduced"), false);
});

/* ---------- NDR-q registration seam ----------------------------------- */

test("registerCondition: exactly-once, frozen entries, lookup", () => {
  const before = conditions().length;
  const c = registerCondition({
    code: "test-only-condition-fixture",
    text: "test fixture — not a schema condition",
    faultClass: "O",
    ref: "test/findings-records.test.ts",
  });
  assert.equal(Object.isFrozen(c), true);
  assert.equal(conditionByCode("test-only-condition-fixture")?.faultClass, "O");
  assert.throws(
    () =>
      registerCondition({
        code: "test-only-condition-fixture",
        text: "duplicate",
        faultClass: "B",
        ref: "test",
      }),
    /already registered/,
    "duplicate registration throws",
  );
  assert.equal(conditions().length, before + 1, "list grows exactly once");
});

test("registerCondition: getter on `code` cannot bypass exactly-once (round-6 c1 fold)", () => {
  // The cycle-1 finding: `registerCondition` used to read `c.code`
  // for the duplicate check and AGAIN in the stored spread — a
  // getter returning different values per read registered a
  // duplicate of a seeded code. The fix snapshots the fields first.
  let reads = 0;
  const tricky = {
    get code() {
      reads += 1;
      // first read (duplicate check): unregistered; later reads
      // (spread/store): a seeded code
      return reads === 1 ? "getter-trick-unregistered" : "finding-hold";
    },
    text: "x",
    faultClass: "O" as const,
    ref: "test",
  };
  registerCondition(tricky);
  // Whatever the getter answered, the STORED entry and the duplicate
  // check must agree: a second registration attempt with the stored
  // code throws (no hidden duplicate of a seeded code).
  const stored = conditions().find((c) => c.ref === "test" && c.text === "x");
  assert.ok(stored, "entry stored");
  assert.throws(
    () => registerCondition({ code: stored.code, text: "y", faultClass: "A", ref: "test2" }),
    /already registered/,
    "stored code is the one guarded by the check",
  );
  // The seeded seed was not duplicated: "finding-hold" appears at most once
  // (fixture entries above used distinct codes).
  const holdCount = conditions().filter((c) => c.code === "finding-hold").length;
  assert.equal(holdCount, 1, "seeded finding-hold registered exactly once");
});

test("conditions(): defensive frozen snapshot — callers cannot mutate the registry (round-6 audit F1)", () => {
  const snap = conditions();
  const n = snap.length;
  assert.ok(n >= 19, "seeded registry present");
  assert.equal(Object.isFrozen(snap), true, "snapshot is frozen");
  // Every attempted mutation must fail (throw in strict mode, silent
  // no-op in sloppy mode) and leave the REGISTRY unchanged:
  for (const attempt of [
    () => (snap as CanonicalCondition[]).push({
      code: "mutated-in",
      text: "x",
      faultClass: "A",
      ref: "test",
    }),
    () => ((snap as CanonicalCondition[]).length = 0),
    () => ((snap as CanonicalCondition[])[0] as CanonicalCondition).code = "rewritten",
    () => ((snap as CanonicalCondition[])[0] = null as unknown as CanonicalCondition),
  ]) {
    try {
      attempt();
    } catch {
      /* strict-mode TypeError — the intended path */
    }
  }
  assert.equal(conditions().length, n, "registry length unchanged after mutation attempts");
  assert.notEqual(conditions()[0]?.code, "rewritten", "registry entries unharmed");
  assert.notEqual(conditions()[0], null, "registry entries unharmed (index write)");
  assert.ok(conditions()[0] !== undefined && conditions()[0] !== null, "entry 0 present");
  assert.equal(conditionByCode("mutated-in"), null, "no forged registration leaked in");
  assert.equal(conditionByCode("finding-hold")?.faultClass, "O", "seed survives");
  // Two calls are distinct arrays (later registrations must not leak
  // into an earlier snapshot's live identity) but same order:
  const a = conditions();
  const b = conditions();
  assert.notEqual(a, b, "fresh snapshot per call");
  assert.deepEqual(a.map((c) => c.code), b.map((c) => c.code), "stable order");
});

/* ---------- kind table -------------------------------------------------- */

test("kind table: 12 in-scope kinds, runtime membership, closed-set helper", () => {
  // SHAPE GUARD (F01 fold, cycle-3 audit): docs/11 carries NO single
  // closed enumeration of the in-scope kinds, so a "set-equal to the
  // schema" assertion is NOT mechanically checkable from this test
  // and an equality against a second hand transcription (an earlier
  // fold) would only catch transcription drift, not schema misread —
  // it is RETRACTED here. The authoritative cross-check is per-kind:
  // every RECORD_KIND_CLOSED_SET entry cites its defining docs/11
  // site in the PROVENANCE block on that comment (F02 fold); the
  // refs are mention-verified and their section labels were audited
  // in cycles 4–5 (definition-site labels corrected then). Strict
  // set-equality against a parsed closed list lands mechanically
  // with inventory.ts in step 9 (mapping Q4 hard-enforcement point).
  // This test keeps the honest parts.
  assert.equal(RECORD_KIND_CLOSED_SET.length, 12);
  // KIND_TABLE completeness over the set: asserts the BUILD maps
  // every member — a broken Object.fromEntries fold would fail this
  // even though the table is built from the set.
  assert.deepEqual(
    Object.keys(KIND_TABLE).sort(),
    [...RECORD_KIND_CLOSED_SET].sort(),
    "KIND_TABLE must cover exactly the closed set",
  );
  assert.equal(isRecordKind("audit-finding"), true);
  assert.equal(isRecordKind("quiesce-stall"), false, "out-of-scope S5 kind must NOT be a RECORD kind here");
  assert.equal(inClosedSet(["a", "b"] as const, "a"), true);
  assert.equal(inClosedSet(["a", "b"] as const, "c"), false);
});

test("KIND_TABLE: null prototype + frozen — inherited keys must not answer (round-6 audit F2)", () => {
  // F2 was: a plain-object table answers Object.prototype members
  // (functions — truthy), so a naive `KIND_TABLE[v]` membership
  // test accepted "constructor"/"toString" as kinds.
  assert.equal(Object.getPrototypeOf(KIND_TABLE), null, "null prototype");
  assert.equal(Object.isFrozen(KIND_TABLE), true, "table frozen");
  for (const inherited of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    assert.equal(
      Object.hasOwn(KIND_TABLE, inherited),
      false,
      `inherited key "${inherited}" must NOT be an own key`,
    );
    assert.equal(
      (KIND_TABLE as Record<string, unknown>)[inherited],
      undefined,
      `direct lookup of inherited key "${inherited}" must be undefined`,
    );
  }
  assert.equal(KIND_TABLE["audit-finding"], true, "own kind still answers");
  // Freeze: attempted widening fails and the key set is unchanged.
  try {
    (KIND_TABLE as Record<string, unknown>)["forged-kind"] = true;
  } catch {
    /* strict-mode TypeError — intended */
  }
  assert.equal(Object.hasOwn(KIND_TABLE, "forged-kind"), false, "no forged kind");
});

test("exported closed sets are frozen at runtime (round-6 audit F3)", () => {
  // `as const` is compile-time only; F3 was: a consumer (or test
  // fixture) could push onto any exported vocabulary at runtime and
  // change what `isRecordKind`/`inClosedSet` accept. Sample the
  // highest-consequence sets plus a mechanical sweep of EVERY
  // exported `*_CLOSED_SET` array the module exposes.
  const sample = [
    RECORD_KIND_CLOSED_SET,
    ROUTE_CLOSED_SET,
    SURFACE_CLOSED_SET,
    SEVERITY_CLOSED_SET,
    OWNER_ACT_OPS_CLOSED_SET,
    FILING_REFUSAL_CODE_CLOSED_SET,
    FAILING_CHECK_CLOSED_SET,
    ENTRY_MODE_CLOSED_SET,
    UPDATE_TO_CLOSED_SET,
  ] as const;
  for (const s of sample) {
    assert.equal(Object.isFrozen(s), true, "sampled closed set frozen");
    const n = s.length;
    try {
      (s as unknown as string[]).push("forged");
    } catch {
      /* strict-mode TypeError — intended */
    }
    assert.equal(s.length, n, "no runtime append accepted");
  }
  // Mechanical sweep over every export: any array whose name ends in
  // _CLOSED_SET must be frozen. (Reflects the module namespace —
  // drift-proof against future vocabularies.)
  for (const [name, value] of Object.entries(recordsModule)) {
    if (name.endsWith("_CLOSED_SET")) {
      assert.ok(Array.isArray(value), `${name} is an array`);
      assert.equal(Object.isFrozen(value), true, `${name} must be frozen`);
    }
  }
});

/* ---------- v35 D2(i): lineage-edge-retire op + payload shape --------- */

test("lineage-edge-retire: closed-set membership + payload SHAPE only (v35 D2(i), audit C6-M4; scope clarified v35 cycle-18 fold V18-1 — the §14.10.3 derivation rule and check order 0–3 are contract-declared, NOT exercised here: no op executor exists in src/ yet)", () => {
  // Closed-set membership: the op is in the vocabulary exactly once
  // and `inClosedSet` accepts it; a near-miss spelling is refused.
  assert.equal(
    OWNER_ACT_OPS_CLOSED_SET.filter((op) => op === "lineage-edge-retire")
      .length,
    1,
    "lineage-edge-retire listed exactly once",
  );
  assert.equal(inClosedSet(OWNER_ACT_OPS_CLOSED_SET, "lineage-edge-retire"), true);
  assert.equal(inClosedSet(OWNER_ACT_OPS_CLOSED_SET, "lineage-edge-retired"), false);

  // Payload shape: a well-formed LineageEdgeRetirePayload type-checks
  // against the map entry (compile-time) and both fields are required
  // strings — self-loop and two-node proof fixtures, SHAPE-LEVEL
  // ONLY (v35 cycle-18 fold V18-1: this test does not re-implement
  // the derivation rule or the check order). (The op's
  // effect set on the act envelope is `effectRecordIds: string[]`,
  // the same forward-only envelope field every owner act carries.)
  const selfLoop: OwnerActPayloadMap["lineage-edge-retire"] = {
    edgeSource: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    cycleProof: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
  };
  const twoNode: LineageEdgeRetirePayload = {
    edgeSource: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    cycleProof: ["01ARZ3NDEKTSV4RRFFQ69G5FAW"],
  };
  for (const p of [selfLoop, twoNode]) {
    assert.equal(typeof p.edgeSource, "string");
    assert.ok(Array.isArray(p.cycleProof) && p.cycleProof.length >= 1, "fixture is non-empty (NOT a shape rule — an EMPTY submission is a check-3 byte-comparison mismatch, lineage-cycle-proof-mismatch, per §14.10.3 C11-3; v35 cycle-28 fold minor-3)");
    // no id listed twice, except the SELF-LOOP case ([edgeSource])
    const dups = new Set(p.cycleProof);
    assert.ok(
      dups.size === p.cycleProof.length ||
        (p.cycleProof.length === 1 && p.cycleProof[0] === p.edgeSource),
      "no duplicate ids outside the self-loop exception",
    );
  }
});

/* ---------- check-10 self-discipline gate (mapping Q4, pre-step-9) ------ */

/* GATE SHAPE (R5 fold, cycle-2 audit): this is the MENTION gate the
 * mapping names as the steps-1–8 per-step self-discipline grep —
 * "every NDR id appears in the wire file" — NOT a semantic placement
 * proof (hard enforcement of id↔obligation mapping waits for
 * `inventory.ts`, step 9). The second test tightens the bar for the
 * predicate-home ids: their references must occur at real sites in the
 * BODY, not merely in the header's compressed enumeration. */

/** Resolve the records.ts SOURCE from either run mode deterministically
 * (F09 fold, cycle-4): the module lives at <root>/test/ (tsx run) or
 * <root>/dist/test/ (compiled run) — detect which by checking whether
 * the parent directory is literally "dist", then read exactly
 * <root>/src/findings/records.ts. NO candidate fallthrough (the
 * earlier try-loop's "../src/…" from test/ resolved OUTSIDE the repo
 * — a latent read of a hypothetical sibling projects/src tree), and
 * a missing records.ts throws loudly. F06 FOLD (cycle-5): the
 * two-up (compiled) branch additionally requires package.json AT the
 * detected root — a checkout whose own directory is named "dist"
 * would otherwise pattern-match as compiled mode in a tsx run and
 * ascend out of the repo; the guard makes that mis-detection a loud
 * ENOENT on the wrong root's missing package.json-qualified path
 * rather than a plausible read elsewhere. Residual pathological
 * case (parent dir ALSO holding package.json + the same source
 * path) is documented and accepted: it requires a nested duplicate
 * checkout of this repo named such that both roots qualify. */
async function readRecordsSource(): Promise<string> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  // compiled run: <root>/dist/test → root is two levels up;
  // tsx run: <root>/test → root is one level up.
  const twoUp = path.dirname(path.dirname(dir));
  const root =
    path.basename(dir) === "test" &&
    path.basename(path.dirname(dir)) === "dist" &&
    existsSync(path.join(twoUp, "package.json"))
      ? twoUp
      : path.dirname(dir);
  return readFile(path.join(root, "src", "findings", "records.ts"), "utf8");
}

test("every NDR id a…v is mentioned somewhere in records.ts (per-step self-discipline grep, mapping Q4 pre-step-9)", async () => {
  const src = await readRecordsSource();
  const ids = "abcdefghijklmnopqrstuv".split("");
  const missing = ids.filter((x) => {
    const re = new RegExp(`NDR-${x}\\b`);
    return !re.test(src);
  });
  assert.deepEqual(missing, [], `NDR ids missing from records.ts: ${missing.join(",")}`);
});

test("every predicate-home NDR id (b/c/g/j/n/r) is referenced at a body site, not just in the header enumeration", async () => {
  const src = await readRecordsSource();
  // Drop the header's compressed enumerations (e.g. "NDR-b/c/g/j/n/r"
  // and "NDR-x/§…" claim lists at the top) so a mere header mention
  // cannot satisfy the gate: the reference must live in the body.
  const body = src
    .split("\n")
    .filter((l) => !/NDR-[a-z](?:\/[a-z])+/.test(l))
    .join("\n");
  for (const id of ["b", "c", "g", "j", "n", "r"] as const) {
    const re = new RegExp(`NDR-${id}\\b`);
    assert.ok(re.test(body), `NDR-${id} must be referenced at a wire-operand site in the body (header-only mention fails the gate)`);
  }
});
