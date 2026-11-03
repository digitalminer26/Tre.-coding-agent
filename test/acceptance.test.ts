/**
 * P14 — acceptance evaluator (docs/13; docs/11 §9.1/§14.3 + P14 amendment).
 *
 * Invariants, each by name (docs/13 §6):
 *  AC1 no receipt-for-completion: a stop / claim alone never yields
 *    complete — at best uncertain.
 *  AC2 judgment cannot waive a deterministic gate (failed OR missing).
 *  AC3 staleness cuts both ways (EV1): stale PASS neither passes nor
 *    fails; stored assessments stale exactly on artifact-identity or
 *    taskRevision change.
 *  AC4 determinism: same input → identical output.
 *  AC5 fail-closed: malformed input → uncertain + bad-input:… reasons,
 *    never a throw (unknown-never-crashed).
 *  AC6 a gate FAIL is never blocked; a blocker never rescues it.
 *  AC7 complete is the full conjunction (EV12): each conjunct
 *    independently defeatable by removing exactly that evidence.
 *  AC8 advisory never masquerades as deterministic (no checkedAtSha on
 *    advisory rows).
 *  AC9 compartment guards (the P8 C2-F13 pattern reused).
 * Plus precedence: missing-evidence > blocked; blocked > all-green;
 * artifact exists:false → incomplete (not uncertain); unobserved →
 * uncertain (EV9); contradictory current PASS+FAIL → bad-input (EV2);
 * EV4 no-digest exists:true → bad-input.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  BLOCKER_KINDS,
  DEFAULT_SEMANTIC_MIN_CONFIDENCE,
  evaluate,
  isStale,
  sameArtifact,
  toAcceptanceRecord,
} from "../src/acceptance/evaluator.js";
import type { AcceptanceAssessment, EvaluateInput } from "../src/acceptance/evaluator.js";

// ───────────────────────────────── fixtures ──────────────────────────────────

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const ID = { sha: SHA };
const ID_DIRTY = { sha: SHA, dirty: true, dirtyDigest: "d1" };

function spec(over: Partial<EvaluateInput["spec"]> = {}): EvaluateInput["spec"] {
  return {
    criteria: [
      { id: "gate:tests", kind: "deterministic", required: true },
      { id: "crit:readability", kind: "semantic", required: true },
    ],
    requiredChecks: ["gate:tests"],
    artifacts: ["out/report.md"],
    ...over,
  };
}

function input(over: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    taskId: "task-001",
    taskRevision: 1,
    current: { ...ID },
    spec: spec(),
    gates: [{ gateId: "gate:tests", pass: true, at: { ...ID }, evidenceRef: "run:42" }],
    artifacts: [{ path: "out/report.md", exists: true, digest: "sha256:aa", at: { ...ID }, evidenceRef: "fs:1" }],
    claims: [
      {
        source: "model-judgment",
        judge: "claude-x",
        claim: "readable and complete",
        verdict: "complete",
        confidence: 0.9,
        criteriaIds: ["crit:readability"],
        evidenceRefs: ["span:7"],
      },
    ],
    blockers: [],
    now: 1700000000,
    ...over,
  };
}

/** Deep-clone via structuredClone for purity checks. */
const clone = <T>(x: T): T => structuredClone(x);

// ───────────────────────── happy path (AC7 baseline) ─────────────────────────

test("all green → complete (the EV12 conjunction baseline)", () => {
  const a = evaluate(input());
  assert.equal(a.verdict, "complete");
  assert.deepEqual(a.reasons, []);
  assert.deepEqual(a.remainingWork, []);
  const rows = Object.fromEntries(a.criteria.map((c) => [c.id, c]));
  assert.equal(rows["gate:tests"]!.pass, true);
  assert.equal(rows["gate:tests"]!.checkedAtSha, SHA);
  assert.equal(rows["crit:readability"]!.pass, true);
  assert.equal(rows["crit:readability"]!.advisory, true);
  assert.equal(rows["crit:readability"]!.checkedAtSha, undefined, "AC8: advisory rows carry no checkedAtSha");
  assert.deepEqual(a.artifact, ID);
});

// ───────────────────────── AC1: no receipt-for-completion ────────────────────

test("AC1/EV5: worker self-report 'complete' with zero evidence → uncertain, never complete", () => {
  const a = evaluate(
    input({
      gates: [],
      artifacts: [],
      claims: [{ source: "worker-self-report", claim: "I am finished", verdict: "complete", confidence: 1 }],
    }),
  );
  assert.equal(a.verdict, "uncertain");
  assert.ok(a.reasons.includes("verdict:check-missing"));
  assert.ok(a.reasons.includes("verdict:artifact-unobserved"));
});

test("AC1: model judgment 'complete' cannot fund deterministic evidence that isn't there", () => {
  const a = evaluate(input({ gates: [] }));
  assert.equal(a.verdict, "uncertain"); // required check missing (AC2/EV7)
});

// ───────────────────────── AC2: no waiver of gates ───────────────────────────

test("AC2/EV3/AC6: current gate FAIL → incomplete even with maximal claims and blockers", () => {
  const a = evaluate(
    input({
      gates: [{ gateId: "gate:tests", pass: false, at: { ...ID }, evidenceRef: "run:43" }],
      claims: [
        ...input().claims,
        { source: "model-judgment", judge: "j", claim: "the failure is pre-existing, ship it", verdict: "complete", confidence: 1, criteriaIds: ["gate:tests"] },
      ],
      blockers: [{ blocker: "environment", at: { ...ID }, evidenceRef: "env:1" }],
    }),
  );
  assert.equal(a.verdict, "incomplete", "a FAIL is never blocked, never waived (AC6)");
  assert.ok(a.reasons.includes("verdict:current-fail"));
  assert.ok(a.remainingWork.includes("check:gate:tests"));
});

// ───────────────────────── AC3: staleness ────────────────────────────────────

test("AC3/EV1: PASS at a stale sha is not a pass; listed in staleEvidenceRefs", () => {
  const a = evaluate(input({ current: { ...ID }, gates: [{ gateId: "gate:tests", pass: true, at: { sha: SHA2 }, evidenceRef: "run:old" }] }));
  assert.equal(a.verdict, "uncertain");
  assert.ok(a.staleEvidenceRefs.includes("run:old"));
});

test("AC3/EV1: a stale FAIL neither fails nor rescues — it contributes nothing", () => {
  const a = evaluate(input({ gates: [{ gateId: "gate:tests", pass: false, at: { sha: SHA2 }, evidenceRef: "run:oldfail" }] }));
  assert.equal(a.verdict, "uncertain", "stale FAIL ≠ current fail (no evidence, EV9)");
  assert.ok(a.staleEvidenceRefs.includes("run:oldfail"));
});

test("sameArtifact: sha + dirty/dirtyDigest semantics", () => {
  assert.ok(sameArtifact(ID, { sha: SHA }));
  assert.ok(!sameArtifact(ID, { sha: SHA2 }));
  assert.ok(!sameArtifact(ID, ID_DIRTY), "dirty tree ≠ clean commit");
  assert.ok(sameArtifact(ID_DIRTY, { sha: SHA, dirty: true, dirtyDigest: "d1" }));
  assert.ok(!sameArtifact(ID_DIRTY, { sha: SHA, dirty: true, dirtyDigest: "d2" }), "different dirty deltas");
  assert.ok(!sameArtifact({ sha: SHA, dirty: true }, { sha: SHA, dirty: true }), "unmeasured deltas never assumed equal");
  assert.ok(!sameArtifact({ sha: SHA, dirty: true, dirtyDigest: "d1" }, { sha: SHA, dirty: true }), "measured ≠ unmeasured");
});

test("current identity is dirty: clean-sha evidence is stale; matching dirty identity counts", () => {
  const a = evaluate(input({ current: { ...ID_DIRTY } }));
  assert.equal(a.verdict, "uncertain", "clean evidence at dirty current is stale");
  const b = evaluate(
    input({
      current: { ...ID_DIRTY },
      gates: [{ gateId: "gate:tests", pass: true, at: { ...ID_DIRTY }, evidenceRef: "run:d" }],
      artifacts: [{ path: "out/report.md", exists: true, digest: "sha256:aa", at: { ...ID_DIRTY }, evidenceRef: "fs:d" }],
    }),
  );
  assert.equal(b.verdict, "complete", "evidence observed at the same dirty identity counts");
});

test("AC3: artifact evidence with no identity is unbound — never counted", () => {
  const a = evaluate(
    input({
      artifacts: [{ path: "out/report.md", exists: true, digest: "sha256:aa", evidenceRef: "fs:noid" }],
    }),
  );
  assert.equal(a.verdict, "uncertain");
  assert.ok(a.staleEvidenceRefs.includes("fs:noid"));
});

test("isStale: live at same revision+artifact; stale on revision bump (EV10) or artifact change", () => {
  const a = evaluate(input());
  assert.equal(a.verdict, "complete");
  assert.equal(isStale(a, { taskRevision: 1, artifact: { ...ID } }), false);
  assert.equal(isStale(a, { taskRevision: 2, artifact: { ...ID } }), true, "rung-4 rewrite makes priors stale");
  assert.equal(isStale(a, { taskRevision: 1, artifact: { sha: SHA2 } }), true, "new artifact invalidates");
  assert.equal(isStale(a, { taskRevision: 1, artifact: { ...ID_DIRTY } }), true);
  assert.equal(isStale({ ...a, artifact: undefined as never }, { taskRevision: 1, artifact: { ...ID } }), true, "malformed stored = not live");
});

// ───────────────────────── AC5: fail-closed, never throws ────────────────────

const malformed: { name: string; patch: () => Partial<EvaluateInput>; reason: string }[] = [
  { name: "taskId empty", patch: () => ({ taskId: "" }), reason: "bad-input:taskId" },
  { name: "taskRevision 0", patch: () => ({ taskRevision: 0 }), reason: "bad-input:taskRevision" },
  { name: "now negative", patch: () => ({ now: -5 }), reason: "bad-input:now" },
  { name: "current empty sha", patch: () => ({ current: { sha: "" } }), reason: "bad-input:current identity" },
  { name: "semanticMinConfidence 7", patch: () => ({ semanticMinConfidence: 7 }), reason: "bad-input:semanticMinConfidence" },
  { name: "missing requiredCheck id dup", patch: () => ({ spec: spec({ requiredChecks: ["gate:tests", "gate:tests"] }) }), reason: "bad-input:duplicate requiredCheck 'gate:tests'" },
  { name: "criterion dup", patch: () => ({ spec: spec({ criteria: [spec().criteria[0]!, spec().criteria[0]!] }) }), reason: "bad-input:duplicate criterion 'gate:tests'" },
  { name: "criterion bad kind", patch: () => ({ spec: spec({ criteria: [{ id: "x", kind: "vibes" as never, required: true }] }) }), reason: "bad-input:criterion 'x' kind" },
  { name: "exists:true without digest (EV4)", patch: () => ({ artifacts: [{ path: "out/report.md", exists: true, at: { ...ID }, evidenceRef: "fs:x" }] }), reason: "bad-input" },
  { name: "artifact empty evidenceRef", patch: () => ({ artifacts: [{ path: "out/report.md", exists: true, digest: "d", at: { ...ID }, evidenceRef: "" }] }), reason: "bad-input" },
  { name: "contradictory current gate (EV2)", patch: () => ({ gates: [{ gateId: "gate:tests", pass: true, at: { ...ID }, evidenceRef: "r1" }, { gateId: "gate:tests", pass: false, at: { ...ID }, evidenceRef: "r2" }] }), reason: "bad-input:contradictory gate" },
  { name: "blocker bad kind", patch: () => ({ blockers: [{ blocker: "vibes" as never, at: { ...ID }, evidenceRef: "b1" }] }), reason: "bad-input:blocker kind" },
  { name: "blocker empty ref", patch: () => ({ blockers: [{ blocker: "environment", at: { ...ID }, evidenceRef: "" }] }), reason: "bad-input" },
];

for (const m of malformed) {
  test(`AC5 fail-closed: ${m.name} → uncertain + bad-input, no throw`, () => {
    let a: AcceptanceAssessment;
    try {
      a = evaluate(input(m.patch()));
    } catch (e) {
      assert.fail(`evaluate threw on malformed input (${m.name}): ${e}`);
    }
    assert.equal(a.verdict, "uncertain", m.name);
    assert.ok(a.reasons.some((r) => r.startsWith("bad-input:") && r.includes(m.reason.replace(/^bad-input:/, ""))), `expected a bad-input reason covering '${m.reason}', got: ${a.reasons.join(" | ")}`);
  });
}

test("AC5: structurally destroyed inputs never throw (fuzz-lite)", () => {
  const junk: unknown[] = [
    {},
    { spec: null },
    { spec: { criteria: "nope" } },
    { gates: null, artifacts: null, claims: null, blockers: null },
    { current: null, spec: spec() },
    { current: ID, spec: spec({ criteria: [null, undefined] as never, requiredChecks: [42 as never], artifacts: [""] }), gates: [null, { gateId: "" }], artifacts: [null], claims: [null, { source: "alien" }, { source: "model-judgment", claim: "" }, { source: "model-judgment", claim: "ok", confidence: 2, verdict: "sideways" as never, criteriaIds: [7 as never] }], blockers: [null, { blocker: "x", at: null }] },
  ];
  for (const j of junk) {
    let a: AcceptanceAssessment;
    try {
      a = evaluate(j as EvaluateInput);
    } catch (e) {
      assert.fail(`evaluate threw on junk input ${JSON.stringify(j)}: ${e}`);
    }
    assert.equal(a.verdict, "uncertain");
  }
});

test("F7 (R2): null/undefined/non-object input returns the uncertain minimal record, never throws", () => {
  for (const j of [null, undefined, 7, "str"]) {
    const a = evaluate(j as never);
    assert.equal(a.verdict, "uncertain");
    assert.ok(a.reasons.includes("bad-input:input not an object"));
  }
  // array/object-shaped junk falls through to the spec-level bad-input
  for (const j of [[], {}, new Map()]) {
    const a = evaluate(j as never);
    assert.equal(a.verdict, "uncertain");
    assert.ok(a.reasons.some((r) => r.startsWith("bad-input:")));
  }
});

test("F8 (R2): a current FAIL gate NOT named in the spec still breaks complete (EV12: no current FAIL anywhere)", () => {
  const a = evaluate(input({ gates: [...input().gates, { gateId: "gate:stray", pass: false, at: { ...ID }, evidenceRef: "run:stray" }] }));
  assert.equal(a.verdict, "incomplete");
  assert.ok(a.remainingWork.includes("check:gate:stray"));
});

test("spec destroyed entirely → uncertain minimal record (not a throw)", () => {
  const a = evaluate({ ...(input() as Omit<EvaluateInput, "spec">), spec: undefined as never });
  assert.equal(a.verdict, "uncertain");
  assert.deepEqual(a.criteria, []);
  assert.ok(a.reasons.includes("bad-input:spec"));
});

// ───────────────────────── EV4: artifacts ────────────────────────────────────

test("EV4: artifact observed exists:false at current → incomplete (missing artifact is work)", () => {
  const a = evaluate(input({ artifacts: [{ path: "out/report.md", exists: false, at: { ...ID }, evidenceRef: "fs:miss" }] }));
  assert.equal(a.verdict, "incomplete");
  assert.ok(a.reasons.includes("verdict:artifact-missing"));
  assert.ok(a.remainingWork.includes("artifact:out/report.md"));
});

test("EV9: expected artifact with NO observation at current → uncertain (never inferred failed)", () => {
  const a = evaluate(input({ artifacts: [] }));
  assert.equal(a.verdict, "uncertain");
  assert.ok(a.reasons.includes("verdict:artifact-unobserved"));
});

test("artifact evidence at stale identity counts as unobserved, listed stale", () => {
  const a = evaluate(
    input({ artifacts: [{ path: "out/report.md", exists: true, digest: "d", at: { sha: SHA2 }, evidenceRef: "fs:stale" }] }),
  );
  assert.equal(a.verdict, "uncertain");
  assert.ok(a.staleEvidenceRefs.includes("fs:stale"));
});

// ───────────────────────── precedence ────────────────────────────────────────

test("precedence: current FAIL outranks blocker AND missing evidence", () => {
  const a = evaluate(
    input({
      gates: [
        { gateId: "gate:tests", pass: false, at: { ...ID }, evidenceRef: "run:f" },
        { gateId: "gate:lint", pass: false, at: { sha: SHA2 }, evidenceRef: "run:stale-f" },
      ],
      blockers: [{ blocker: "environment", at: { ...ID }, evidenceRef: "b:1" }],
    }),
  );
  assert.equal(a.verdict, "incomplete");
});

test("precedence: missing evidence outranks blocked (EV9: blocker is not a substitute)", () => {
  const a = evaluate(input({ gates: [], blockers: [{ blocker: "dependency-external", at: { ...ID }, evidenceRef: "b:2" }] }));
  assert.equal(a.verdict, "uncertain", "a blocker never substitutes for required evidence");
});

test("precedence: judge says required criterion incomplete → incomplete, blocker cannot outrank", () => {
  const a = evaluate(
    input({
      claims: [{ source: "model-judgment", judge: "j", claim: "readability lacking", verdict: "incomplete", confidence: 0.95, criteriaIds: ["crit:readability"] }],
      blockers: [{ blocker: "approval-required", at: { ...ID }, evidenceRef: "b:3" }],
    }),
  );
  assert.equal(a.verdict, "incomplete");
  assert.ok(a.reasons.includes("verdict:criterion-incomplete"));
});

test("blocked: positive current blocker, deterministic+artifact green, no semantic required", () => {
  const a = evaluate(
    input({
      spec: spec({ criteria: [{ id: "gate:tests", kind: "deterministic", required: true }] }),
      blockers: [{ blocker: "authority-denied", at: { ...ID }, evidenceRef: "b:4" }],
    }),
  );
  assert.equal(a.verdict, "blocked");
  assert.deepEqual(a.remainingWork, ["blocker:authority-denied"]);
});

test("stale blocker contributes nothing (EV8: positive CURRENT evidence required)", () => {
  const a = evaluate(
    input({
      spec: spec({ criteria: [{ id: "gate:tests", kind: "deterministic", required: true }] }),
      blockers: [{ blocker: "environment", at: { sha: SHA2 }, evidenceRef: "b:stale" }],
    }),
  );
  assert.equal(a.verdict, "complete", "a stale blocker never blocks");
  assert.ok(a.staleEvidenceRefs.includes("b:stale"));
});

// ───────────────────────── EV6: semantic funding ────────────────────────────

test("EV6: judgment below the confidence threshold does not fund; explicit threshold does", () => {
  const low = evaluate(
    input({
      claims: [{ source: "model-judgment", judge: "j", claim: "fine", verdict: "complete", confidence: 0.69, criteriaIds: ["crit:readability"] }],
    }),
  );
  assert.equal(low.verdict, "uncertain", "0.69 < 0.7 default");
  const ok = evaluate(
    input({
      semanticMinConfidence: 0.5,
      claims: [{ source: "model-judgment", judge: "j", claim: "fine", verdict: "complete", confidence: 0.69, criteriaIds: ["crit:readability"] }],
    }),
  );
  assert.equal(ok.verdict, "complete");
});

test("EV6: a claim naming a DIFFERENT criterion does not fund; self-report never funds", () => {
  const wrong = evaluate(
    input({ claims: [{ source: "model-judgment", judge: "j", claim: "x", verdict: "complete", confidence: 1, criteriaIds: ["crit:other"] }] }),
  );
  assert.equal(wrong.verdict, "uncertain");
  const self = evaluate(
    input({ claims: [{ source: "worker-self-report", judge: "w", claim: "x", verdict: "complete", confidence: 1, criteriaIds: ["crit:readability"] }] }),
  );
  assert.equal(self.verdict, "uncertain", "EV5: self-report never funds a criterion");
});

test("EV6: missing confidence counts as 0 (no implicit funding)", () => {
  const a = evaluate(input({ claims: [{ source: "model-judgment", judge: "j", claim: "x", verdict: "complete", criteriaIds: ["crit:readability"] }] }));
  assert.equal(a.verdict, "uncertain");
});

test("modelAdvisory: latest model-judgment wins (order = newest last)", () => {
  const a = evaluate(
    input({
      claims: [
        { source: "model-judgment", judge: "old", claim: "first", verdict: "incomplete", confidence: 0.9 },
        { source: "model-judgment", judge: "new", claim: "second", verdict: "complete", confidence: 0.99, criteriaIds: ["crit:readability"] },
      ],
    }),
  );
  assert.deepEqual(a.modelAdvisory, { judge: "new", quote: "second", confidence: 0.99 });
  assert.equal(a.verdict, "complete");
});

test("R2: funding claims are last-write-wins — a later complete supersedes an earlier incomplete", () => {
  const a = evaluate(input({
    claims: [
      { source: "model-judgment", judge: "j", claim: "no", verdict: "incomplete", confidence: 0.9, criteriaIds: ["crit:readability"] },
      { source: "model-judgment", judge: "j", claim: "ok", verdict: "complete", confidence: 0.9, criteriaIds: ["crit:readability"] },
    ],
  }));
  assert.equal(a.verdict, "complete"); // newest judgment wins, matching modelAdvisory order contract
  assert.equal(a.modelAdvisory!.quote, "ok");
});

test("modelAdvisory is null with no claims; incomplete-advisory still surfaces", () => {
  assert.equal(evaluate(input({ claims: [] })).modelAdvisory, null);
  const adv = evaluate(input({ claims: [{ source: "model-judgment", judge: "j", claim: "not done", verdict: "incomplete", confidence: 0.8 }] }));
  assert.deepEqual(adv.modelAdvisory, { judge: "j", quote: "not done", confidence: 0.8 });
});

// ───────────────────────── EV7: deterministic criteria ──────────────────────

test("EV7: criterion gate FAIL at current → incomplete; no claim flips it", () => {
  const a = evaluate(
    input({
      gates: [{ gateId: "gate:tests", pass: false, at: { ...ID }, evidenceRef: "run:5" }],
    }),
  );
  assert.equal(a.verdict, "incomplete");
});

test("EV7: deterministic criterion with a PASS gate gets checkedAtSha + evidenceRef", () => {
  const a = evaluate(input());
  const row = a.criteria.find((c) => c.id === "gate:tests")!;
  assert.deepEqual({ pass: row.pass, ref: row.evidenceRef, sha: row.checkedAtSha }, { pass: true, ref: "run:42", sha: SHA });
});

// ───────────────────────── AC4: determinism ─────────────────────────────────

test("AC4/EV11: same input → byte-identical output; caller objects never mutated", () => {
  const i = input();
  const before = clone(i);
  const a1 = evaluate(i);
  const a2 = evaluate(i);
  assert.deepEqual(a1, a2);
  assert.deepEqual(i, before, "evaluate() must not mutate caller input");
  // distinct object graphs
  assert.notEqual(a1.criteria, a2.criteria);
});

// ───────────────────────── AC7: the conjunction, one hole at a time ──────────

test("AC7/EV12: complete breaks when ANY single conjunct is removed", () => {
  const green = input();
  assert.equal(evaluate(green).verdict, "complete");
  const holes: { name: string; patch: Partial<EvaluateInput>; expect?: string }[] = [
    { name: "required gate PASS removed", patch: { gates: [] } },
    { name: "artifact evidence removed", patch: { artifacts: [] } },
    { name: "semantic funding removed", patch: { claims: [] } },
    { name: "blocker inserted", patch: { blockers: [{ blocker: "environment", at: { ...ID }, evidenceRef: "b:h" }] }, expect: "blocked" },
    { name: "gate at wrong sha", patch: { gates: [{ gateId: "gate:tests", pass: true, at: { sha: SHA2 }, evidenceRef: "r" }] } },
  ];
  for (const h of holes) {
    const a = evaluate({ ...green, ...h.patch });
    assert.equal(a.verdict, h.expect ?? "uncertain", `${h.name} must break complete`);
  }
  // FAIL hole → incomplete
  assert.equal(
    evaluate({ ...green, gates: [{ gateId: "gate:tests", pass: false, at: { ...ID }, evidenceRef: "r" }] }).verdict,
    "incomplete",
  );
});

test("non-required criterion unmet does not block complete but IS remaining work", () => {
  const a = evaluate(
    input({
      spec: spec({ criteria: [...spec().criteria, { id: "crit:nice", kind: "semantic", required: false }] }),
    }),
  );
  assert.equal(a.verdict, "complete");
  assert.ok(a.remainingWork.includes("criterion:crit:nice"));
});

// ───────────────────────── malformed claims are advice-dropped ───────────────

test("malformed claims drop individually and are reported; good claims still work", () => {
  const a = evaluate(
    input({
      claims: [
        { source: "model-judgment", judge: "j", claim: "x", verdict: "sideways" as never, confidence: 0.9 }, // bad verdict → dropped
        { source: "alien" as never, claim: "x" }, // bad source → dropped
        { source: "model-judgment", judge: "g", claim: "ok", verdict: "complete", confidence: 0.9, criteriaIds: ["crit:readability"] }, // good
      ],
    }),
  );
  assert.equal(a.verdict, "complete");
  assert.ok(a.reasons.includes("dropped-claim:malformed-advice-ignored"));
});

test("claims not an array is bad-input (structure), not droppable advice", () => {
  const a = evaluate(input({ claims: "yes" as never }));
  assert.equal(a.verdict, "uncertain");
  assert.ok(a.reasons.includes("bad-input:claims not an array"));
});

// ───────────────────────── toAcceptanceRecord (§7.4) ─────────────────────────

test("toAcceptanceRecord: complete record mirrors §14.3 + P14 amendment fields", () => {
  const rec = toAcceptanceRecord(evaluate(input()));
  assert.equal(rec.kind, "acceptance");
  assert.equal(rec.verdict, "complete");
  assert.equal(rec.taskRevision, 1);
  const rows = Object.fromEntries(rec.criteria.map((c) => [c.id, c]));
  assert.deepEqual(rows["gate:tests"], { id: "gate:tests", pass: true, evidenceRef: "run:42", checkedAtSha: SHA });
  assert.deepEqual(rows["crit:readability"], { id: "crit:readability", pass: true, advisory: true, evidenceRef: "span:7" });
  assert.equal(rec.remainingWork, undefined, "empty remainingWork is omitted");
  assert.equal(rec.staleEvidenceRefs, undefined);
  assert.deepEqual(rec.artifact, ID);
  assert.deepEqual(rec.modelAdvisory, { judge: "claude-x", quote: "readable and complete", confidence: 0.9 });
});

test("toAcceptanceRecord: stale refs + remaining work present when non-empty; corrupt verdict refused", () => {
  const rec = toAcceptanceRecord(evaluate(input({ gates: [], blockers: [{ blocker: "environment", at: { sha: SHA2 }, evidenceRef: "b:s" }] })));
  assert.deepEqual(rec.staleEvidenceRefs, ["b:s"]);
  assert.ok(rec.remainingWork!.includes("check:gate:tests"));
  assert.throws(() => toAcceptanceRecord({ ...evaluate(input()), verdict: "ship-it" as never }), /bad verdict/);
});

// ───────────────────────── misc pinned constants ────────────────────────────

test("pinned constants match the contract", () => {
  assert.equal(DEFAULT_SEMANTIC_MIN_CONFIDENCE, 0.7);
  assert.deepEqual([...BLOCKER_KINDS].sort(), [
    "approval-required",
    "authority-denied",
    "budget-exhausted",
    "dependency-external",
    "environment",
    "other",
  ]);
});

// ───────────────────────────── compartment guards ────────────────────────────

// The P8 C2-F13 specifier extractor (budget-ledger.test.ts): static /
// side-effect / dynamic import, require, export-from — no-op guards are
// pinned by the positive fixtures there; here the same regex guards the
// acceptance compartment.
const MODULE_SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+|\bexport\s*\[\s*\]\s*from\s*)["']([^"']+)["']/g;
function specifiersOf(content: string): string[] {
  return [...content.matchAll(MODULE_SPEC_RE)].map((m) => m[1]!);
}
const touchesAcceptance = (spec: string): boolean => /(^|\/)acceptance\//.test(spec);

async function walkTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { recursive: true })) {
    const p = join(dir, String(e));
    if (p.endsWith(".ts")) out.push(p.replace(/\\/g, "/").replace(/^\.\//, ""));
  }
  return out.sort();
}

test("AC9 guard: nothing outside src/acceptance/ imports the evaluator module", async () => {
  const files = await walkTs("src");
  const offenders: string[] = [];
  for (const file of files) {
    if (file.startsWith("src/acceptance" + "/")) continue;
    const content = await readFile(file, "utf-8").catch(() => "");
    if (specifiersOf(content).some(touchesAcceptance)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], "the evaluator stays compartmentalized until P9 wires it in: " + offenders.join(", "));
});

test("AC9 guard: src/acceptance imports nothing in the repo at all (pure function)", async () => {
  const files = await walkTs(join("src", "acceptance"));
  assert.ok(files.length >= 1);
  for (const file of files) {
    const content = await readFile(file, "utf-8");
    const foreign = specifiersOf(content).filter((s) => !s.startsWith("node:"));
    assert.deepEqual(foreign, [], `${file} must import nothing (docs/13 §0: no I/O, no deps)`);
  }
  const mod = await import("../src/acceptance/evaluator.js");
  for (const fn of ["evaluate", "isStale", "sameArtifact", "toAcceptanceRecord"]) {
    assert.equal(typeof (mod as Record<string, unknown>)[fn], "function", `${fn} exported`);
  }
});
