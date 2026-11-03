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
import { EpisodeSchemaError, validateSupervisorRecord } from "../src/episode/journal.js";

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
        at: { sha: SHA }, // F3: funding claims bind to the artifact identity
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
  assert.ok(
    a.reasons.includes("verdict:no-current-non-model-evidence") ||
      (a.reasons.includes("verdict:check-missing") && a.reasons.includes("verdict:artifact-unobserved")),
    "F4 ladder: with zero current evidence the no-non-model-evidence floor fires (check/artifact detail then unreachable)",
  );
});

test("F4 (audit): claims-only spec caps at uncertain — complete needs >=1 current non-model evidence", () => {
  // spec whose ONLY requirement is a semantic criterion
  const a = evaluate(
    input({
      spec: spec({ criteria: [{ id: "crit:readability", kind: "semantic", required: true }], requiredChecks: [], artifacts: [] }),
      gates: [],
      artifacts: [],
    }),
  );
  assert.equal(a.verdict, "uncertain", "AC1 must hold unconditionally (F4)");
  assert.ok(a.reasons.includes("verdict:claims-only-spec"));
  // even with a maximal funding judgment the cap holds
  const b = evaluate(
    input({
      spec: spec({ criteria: [{ id: "crit:readability", kind: "semantic", required: true }], requiredChecks: [], artifacts: [] }),
      gates: [],
      artifacts: [],
      claims: [{ source: "model-judgment", judge: "j", claim: "perfect", verdict: "complete", confidence: 1, criteriaIds: ["crit:readability"], at: { sha: SHA } }],
    }),
  );
  assert.equal(b.verdict, "uncertain", "a claim alone never proves complete (F4 floor)");
  // and with the evidence shape present but no current observation
  const c = evaluate(
    input({
      spec: spec({ criteria: [{ id: "crit:readability", kind: "semantic", required: true }], requiredChecks: [], artifacts: [] }),
      gates: [],
      artifacts: [],
      claims: [{ source: "model-judgment", judge: "j", claim: "perfect", verdict: "complete", confidence: 1, criteriaIds: ["crit:readability"], at: { sha: SHA } }],
    }),
  );
  assert.equal(c.verdict, "uncertain");
  // the claims-only cap fires before the per-evidence floor (ladder order)
  assert.ok(c.reasons.includes("verdict:claims-only-spec"));
});
// and with the evidence SHAPE present (required checks declared) but zero
// current observations, the no-non-model-evidence floor fires:
test("F4 (audit): evidence shape present but zero current observations → no-current-non-model-evidence floor", () => {
  const d = evaluate(
    input({
      gates: [],
      artifacts: [],
      claims: [{ source: "model-judgment", judge: "j", claim: "perfect", verdict: "complete", confidence: 1, criteriaIds: ["crit:readability"], at: { sha: SHA } }],
    }),
  );
  assert.equal(d.verdict, "uncertain");
  assert.ok(d.reasons.includes("verdict:no-current-non-model-evidence"));
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
        { source: "model-judgment", judge: "j", claim: "the failure is pre-existing, ship it", verdict: "complete", confidence: 1, criteriaIds: ["gate:tests"], at: { sha: SHA } },
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
      claims: [{ ...input().claims[0]!, at: { ...ID_DIRTY } }], // F3: funding claim must bind to the dirty identity too
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
      claims: [{ source: "model-judgment", judge: "j", claim: "readability lacking", verdict: "incomplete", confidence: 0.95, criteriaIds: ["crit:readability"], at: { sha: SHA } }],
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
      claims: [{ source: "model-judgment", judge: "j", claim: "fine", verdict: "complete", confidence: 0.69, criteriaIds: ["crit:readability"], at: { sha: SHA } }],
    }),
  );
  assert.equal(low.verdict, "uncertain", "0.69 < 0.7 default");
  const ok = evaluate(
    input({
      semanticMinConfidence: 0.5,
      claims: [{ source: "model-judgment", judge: "j", claim: "fine", verdict: "complete", confidence: 0.69, criteriaIds: ["crit:readability"], at: { sha: SHA } }],
    }),
  );
  assert.equal(ok.verdict, "complete");
});

test("EV6: a claim naming a DIFFERENT criterion does not fund; self-report never funds", () => {
  const wrong = evaluate(
    input({ claims: [{ source: "model-judgment", judge: "j", claim: "x", verdict: "complete", confidence: 1, criteriaIds: ["crit:other"], at: { sha: SHA } }] }),
  );
  assert.equal(wrong.verdict, "uncertain");
  const self = evaluate(
    input({ claims: [{ source: "worker-self-report", judge: "w", claim: "x", verdict: "complete", confidence: 1, criteriaIds: ["crit:readability"], at: { sha: SHA } }] }),
  );
  assert.equal(self.verdict, "uncertain", "EV5: self-report never funds a criterion");
});

test("EV6: missing confidence counts as 0 (no implicit funding)", () => {
  const a = evaluate(input({ claims: [{ source: "model-judgment", judge: "j", claim: "x", verdict: "complete", criteriaIds: ["crit:readability"], at: { sha: SHA } }] }));
  assert.equal(a.verdict, "uncertain");
});

test("modelAdvisory: latest model-judgment wins (order = newest last)", () => {
  const a = evaluate(
    input({
      claims: [
        { source: "model-judgment", judge: "old", claim: "first", verdict: "incomplete", confidence: 0.9 },
        { source: "model-judgment", judge: "new", claim: "second", verdict: "complete", confidence: 0.99, criteriaIds: ["crit:readability"], at: { sha: SHA } },
      ],
    }),
  );
  assert.deepEqual(a.modelAdvisory, { judge: "new", quote: "second", confidence: 0.99 });
  assert.equal(a.verdict, "complete");
});

test("R2: funding claims are last-write-wins — a later complete supersedes an earlier incomplete", () => {
  const a = evaluate(input({
    claims: [
      { source: "model-judgment", judge: "j", claim: "no", verdict: "incomplete", confidence: 0.9, criteriaIds: ["crit:readability"], at: { sha: SHA } },
      { source: "model-judgment", judge: "j", claim: "ok", verdict: "complete", confidence: 0.9, criteriaIds: ["crit:readability"], at: { sha: SHA } },
    ],
  }));
  assert.equal(a.verdict, "complete"); // newest judgment wins, matching modelAdvisory order contract
  assert.equal(a.modelAdvisory!.quote, "ok");
});

test("modelAdvisory is null with no claims; incomplete-advisory still surfaces", () => {
  assert.equal(evaluate(input({ claims: [] })).modelAdvisory, null);
  const adv = evaluate(input({ claims: [{ source: "model-judgment", judge: "j", claim: "not done", verdict: "incomplete", confidence: 0.8, at: { sha: SHA } }] }));
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
        { source: "model-judgment", judge: "g", claim: "ok", verdict: "complete", confidence: 0.9, criteriaIds: ["crit:readability"], at: { sha: SHA } }, // good
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

// ───────────────── F1–F7 audit-fix regressions (independent review) ──────────

test("F1: artifact evidence with exists ABSENT is UNKNOWN → uncertain, never satisfied", () => {
  const a = evaluate(input({ artifacts: [{ path: "out/report.md", at: { ...ID }, evidenceRef: "fs:u" }] }));
  assert.equal(a.verdict, "uncertain");
  assert.ok(a.reasons.includes("verdict:artifact-unobserved"));
  // wrong-typed exists is garbage → bad-input, still not satisfied
  const b = evaluate(input({ artifacts: [{ path: "out/report.md", exists: "yes" as never, at: { ...ID }, evidenceRef: "fs:y" }] }));
  assert.equal(b.verdict, "uncertain");
  assert.ok(b.reasons.includes("bad-input:artifact 'out/report.md' exists not a boolean"));
  // wrong-typed digest is bad-input
  const c = evaluate(input({ artifacts: [{ path: "out/report.md", exists: true, digest: 7 as never, at: { ...ID }, evidenceRef: "fs:d" }] }));
  assert.equal(c.verdict, "uncertain");
  assert.ok(c.reasons.includes("bad-input:artifact 'out/report.md' digest not a non-empty string"));
  // empty digest with exists:true → bad-input (EV4), never satisfied
  const d = evaluate(input({ artifacts: [{ path: "out/report.md", exists: true, digest: "", at: { ...ID }, evidenceRef: "fs:e" }] }));
  assert.equal(d.verdict, "uncertain");
});

test("F2: every malformed evidence array is bad-input — never silently empty", () => {
  for (const [field, val] of [["gates", "x"], ["artifacts", 5], ["claims", {}], ["blockers", null]] as const) {
    const a = evaluate(input({ [field]: val } as never));
    assert.equal(a.verdict, "uncertain", `${field}`);
    assert.ok(a.reasons.includes(`bad-input:${field} not an array`), `${field} reason`);
  }
  // the audit's killer: broken blockers must NOT become proof of no blockers
  const b = evaluate(input({ blockers: "nope" as never }));
  assert.notEqual(b.verdict, "complete");
});

test("F3: a claim WITHOUT `at` funds nothing (unbound advice)", () => {
  const a = evaluate(input({ claims: [{ source: "model-judgment", judge: "j", claim: "ok", verdict: "complete", confidence: 1, criteriaIds: ["crit:readability"] }] }));
  assert.equal(a.verdict, "uncertain");
  assert.ok(a.reasons.includes("verdict:criterion-unfunded"));
});

test("F3: a claim at a STALE identity funds nothing; its refs surface as stale", () => {
  const a = evaluate(input({
    claims: [{ source: "model-judgment", judge: "j", claim: "old review", verdict: "complete", confidence: 1, criteriaIds: ["crit:readability"], at: { sha: SHA2 }, evidenceRefs: ["old-review"] }],
  }));
  assert.equal(a.verdict, "uncertain");
  assert.ok(a.staleEvidenceRefs.includes("old-review"));
  // the audit's killer repro: new sha + refreshed gate + OLD claim → uncertain
  const b = evaluate(input({ current: { sha: SHA2 }, gates: [{ gateId: "gate:tests", pass: true, at: { sha: SHA2 }, evidenceRef: "new-gate" }], artifacts: [{ path: "out/report.md", exists: true, digest: "d", at: { sha: SHA2 }, evidenceRef: "new-fs" }] }));
  assert.equal(b.verdict, "uncertain", "the stale claim must not fund the new artifact's judgment");
});

test("F3: a claim AT the current identity still funds (positive control)", () => {
  const a = evaluate(input());
  assert.equal(a.verdict, "complete");
});

test("F4: claims-only spec caps at uncertain even with a confidence-1 judgment", () => {
  const a = evaluate(input({
    spec: spec({ criteria: [{ id: "crit:only", kind: "semantic", required: true }], requiredChecks: [], artifacts: [] }),
    gates: [],
    artifacts: [],
    claims: [{ source: "model-judgment", judge: "j", claim: "perfect", verdict: "complete", confidence: 1, criteriaIds: ["crit:only"], at: { sha: SHA } }],
  }));
  assert.equal(a.verdict, "uncertain");
  assert.ok(a.reasons.includes("verdict:claims-only-spec"));
  assert.ok(a.remainingWork.includes("evidence:spec-requires-at-least-one-check-or-artifact"));
});

test("F6: judge-declared incomplete outranks MISSING gate/artifact evidence (concrete finding)", () => {
  const a = evaluate(input({
    gates: [], // required gate missing (missing evidence)
    artifacts: [],
    claims: [{ source: "model-judgment", judge: "j", claim: "readability lacking", verdict: "incomplete", confidence: 0.95, criteriaIds: ["crit:readability"], at: { sha: SHA } }],
  }));
  assert.equal(a.verdict, "incomplete", "presence of a finding outranks absence of evidence (F6)");
  assert.ok(a.reasons.includes("verdict:criterion-incomplete"));
});

test("F7: empty-sha stored artifact is never live (isStale true both directions)", () => {
  const a = evaluate(input());
  assert.equal(isStale({ ...a, artifact: { sha: "" } }, { taskRevision: 1, artifact: { sha: "" } }), true);
  assert.equal(isStale(a, { taskRevision: 1, artifact: { sha: "" } }), true);
  assert.equal(isStale({ ...a, artifact: { sha: "" } }, { taskRevision: 1, artifact: { ...ID } }), true);
});

test("F5: malformed claim OUTPUT fields (judge/evidenceRefs) are dropped as advice", () => {
  const a = evaluate(input({
    claims: [
      { source: "model-judgment", judge: 23 as never, claim: "x", verdict: "complete", confidence: 1, criteriaIds: ["crit:readability"], at: { sha: SHA } },
      { source: "model-judgment", judge: "j", claim: "y", verdict: "complete", confidence: 1, criteriaIds: ["crit:readability"], at: { sha: SHA }, evidenceRefs: [{}] as never },
    ],
  }));
  assert.equal(a.verdict, "uncertain", "both funding claims dropped → criterion unfunded");
  assert.ok(a.reasons.includes("dropped-claim:malformed-advice-ignored"));
  assert.equal(a.modelAdvisory, null, "no garbage emitted into the record");
});

test("F5: toAcceptanceRecord validates the COMPLETE shape — corrupted assessments throw TypeError", () => {
  const good = evaluate(input());
  const bads: [string, Record<string, unknown>][] = [
    ["criteria id number", { criteria: [{ id: 17, pass: "yes" }] }],
    ["criterion pass string", { criteria: [{ id: "g", pass: "yes" }] }],
    ["taskRevision negative", { taskRevision: -5 }],
    ["advisory with checkedAtSha (AC8)", { criteria: [{ id: "g", pass: true, advisory: true, checkedAtSha: SHA }] }],
    ["remainingWork non-strings", { remainingWork: [42] }],
    ["staleEvidenceRefs non-strings", { staleEvidenceRefs: [42] }],
    ["artifact bad sha", { artifact: { sha: 123 } }],
    ["modelAdvisory bad judge", { modelAdvisory: { judge: 1, quote: "x", confidence: 0.9 } }],
    ["verdict corrupt", { verdict: "ship-it" }],
  ];
  for (const [name, patch] of bads) {
    assert.throws(() => toAcceptanceRecord({ ...good, ...patch } as never), TypeError, name);
  }
});

// ───────────────── F5: P4 round-trip (the two-fence contract) ────────────────

test("F5: evaluate → toAcceptanceRecord → P4 validateSupervisorRecord round-trips (plain + amended fields)", async () => {
  const { validateSupervisorRecord } = await import("../src/episode/journal.js");
  const a = evaluate(input());
  const rec = { schema: "tre-supervisor/1" as const, id: "d-1", ts: 1, episodeId: "ep", taskId: "task-001", ...toAcceptanceRecord(a) };
  validateSupervisorRecord(rec); // must not throw
  // amended fields: advisory + staleEvidenceRefs + artifact
  const b = evaluate(input({
    gates: [...input().gates, { gateId: "gate:extra", pass: true, at: { sha: SHA2 }, evidenceRef: "oldg" }],
    claims: [{ ...input().claims[0]!, evidenceRefs: ["span:7"] }],
  }));
  const rec2 = { schema: "tre-supervisor/1" as const, id: "d-2", ts: 1, episodeId: "ep", ...toAcceptanceRecord(b) };
  validateSupervisorRecord(rec2);
  assert.ok(rec2.staleEvidenceRefs!.includes("oldg"));
  assert.deepEqual(rec2.artifact, ID);
  assert.ok(rec2.criteria.some((c) => c.advisory === true));
});

test("F5: P4 journal REJECTS malformed amended-field shapes (schema extension)", async () => {
  const { validateSupervisorRecord } = await import("../src/episode/journal.js");
  const env = { schema: "tre-supervisor/1" as const, id: "d-3", ts: 1, episodeId: "e", kind: "acceptance" as const, verdict: "complete" as const, criteria: [] };
  for (const [name, patch] of [
    ["staleEvidenceRefs with a number", { staleEvidenceRefs: [42] }],
    ["advisory not literal true", { criteria: [{ id: "s", pass: true, advisory: "yes" as never }] }],
    ["artifact non-string sha", { artifact: { sha: 123 } }],
    ["artifact missing sha", { artifact: { dirty: true } }],
    ["artifact dirtyDigest empty", { artifact: { sha: "x", dirtyDigest: "" } }],
  ] as const) {
    assert.throws(() => validateSupervisorRecord({ ...env, ...patch } as never), EpisodeSchemaError, name);
  }
  // pre-amendment record (no new fields) stays valid — additive amendment
  validateSupervisorRecord({ ...env });
});

test("AC9 guard positive fixtures: the extractor catches every import shape touching acceptance", () => {
  const shapes = [
    `import { evaluate } from "../acceptance/evaluator.js";`,
    `import { isStale } from "../acceptance/evaluator";`,
    `export { sameArtifact } from "../acceptance/evaluator.js";`,
    `export * from "./acceptance/evaluator.ts";`,
    `const m = await import("../acceptance/evaluator.js");`,
    `const m2 = require("../acceptance/evaluator.js");`,
    `import "../acceptance/evaluator.js";`,
    `const lazy = () => import("@app/acceptance/evaluator.mjs");`,
  ];
  for (const src of shapes) {
    assert.ok(specifiersOf(src).some(touchesAcceptance), `fixture MISSED by the extractor: ${src}`);
  }
  for (const src of [`import { x } from "../util/paths.js";`, `const fs = require("node:fs");`, `export { y } from "./journal.js";`]) {
    assert.ok(!specifiersOf(src).some(touchesAcceptance), `false positive: ${src}`);
  }
});

// ────────────── cycle-2 audit regressions (C2-F1…C2-F5, audit-p14-cycle2) ────

test("C2-F1: proven-missing artifact (exists:false) is incomplete EVEN WITH zero other evidence", () => {
  // The cycle-1 F4 fix put the evidence floor ABOVE the artifact branch,
  // so a spec with a required check whose gate is missing + an observed
  // exists:false artifact returned uncertain — the evaluator had POSITIVE
  // evidence of absence and called it unknown. The finding outranks the
  // floor (floor = completion eligibility, never finding suppression).
  const a = evaluate(input({
    gates: [], // required gate missing
    artifacts: [{ path: "out/report.md", exists: false, at: { ...ID }, evidenceRef: "fs:miss" }],
    claims: [],
  }));
  assert.equal(a.verdict, "incomplete", "exists:false is a concrete negative finding, never masked by the evidence floor");
  assert.ok(a.reasons.includes("verdict:artifact-missing"));
  assert.ok(!a.reasons.includes("verdict:no-current-non-model-evidence"), "the floor must not fire when a concrete finding exists");
  assert.ok(a.remainingWork.includes("artifact:out/report.md"));
  assert.ok(a.remainingWork.includes("check:gate:tests"), "the missing required check is still named work");
});

test("C2-F1: exists:false with EVERYTHING else absent (no gates, no claims) is still incomplete", () => {
  const a = evaluate(input({
    spec: spec({ criteria: [{ id: "gate:tests", kind: "deterministic", required: true }], requiredChecks: ["gate:tests"], artifacts: ["out/report.md"] }),
    gates: [],
    artifacts: [{ path: "out/report.md", exists: false, at: { ...ID }, evidenceRef: "fs:miss" }],
    claims: [],
  }));
  assert.equal(a.verdict, "incomplete");
  assert.ok(a.reasons.includes("verdict:artifact-missing"));
});

test("C2-F2: required DETERMINISTIC criterion (no requiredChecks) is not claims-only — PASS funds", () => {
  // EV7 binds criterion ids to gate ids; repeating them in requiredChecks
  // is redundant. A spec demanding a deterministic criterion IS an
  // evidence-shaped spec: with a current PASS + funding judgment the
  // verdict is complete, not claims-only uncertain.
  const a = evaluate(input({
    spec: spec({ criteria: [{ id: "gate:tests", kind: "deterministic", required: true }], requiredChecks: [], artifacts: [] }),
    gates: [{ gateId: "gate:tests", pass: true, at: { ...ID }, evidenceRef: "run:42" }],
    artifacts: [],
    claims: [{ source: "model-judgment", judge: "j", claim: "readable", verdict: "complete", confidence: 0.9, criteriaIds: ["crit:readability"], at: { sha: SHA } }],
  }));
  assert.equal(a.verdict, "complete", "a deterministic criterion PASS is current non-model evidence");
  assert.ok(!a.reasons.includes("verdict:claims-only-spec"));
});

test("C2-F2: required deterministic criterion current FAIL → incomplete (not claims-only, not uncertain)", () => {
  const a = evaluate(input({
    spec: spec({ criteria: [{ id: "gate:tests", kind: "deterministic", required: true }], requiredChecks: [], artifacts: [] }),
    gates: [{ gateId: "gate:tests", pass: false, at: { ...ID }, evidenceRef: "run:43" }],
    artifacts: [],
    claims: [{ source: "model-judgment", judge: "j", claim: "readable", verdict: "complete", confidence: 0.9, criteriaIds: ["crit:readability"], at: { sha: SHA } }],
  }));
  assert.equal(a.verdict, "incomplete");
  assert.ok(a.reasons.includes("verdict:current-fail"));
});

test("C2-F2: optional-only deterministic criterion with no checks/artifacts is still claims-only", () => {
  // C2-F2 corrects the classification for REQUIRED deterministic criteria
  // only — an optional criterion demands nothing, so a spec made solely
  // of semantic + optional-deterministic criteria still demands no
  // evidence and keeps the F4 cap.
  const a = evaluate(input({
    spec: spec({
      criteria: [
        { id: "crit:readability", kind: "semantic", required: true },
        { id: "gate:lint", kind: "deterministic", required: false },
      ],
      requiredChecks: [],
      artifacts: [],
    }),
    gates: [],
    artifacts: [],
    claims: [{ source: "model-judgment", judge: "j", claim: "perfect", verdict: "complete", confidence: 1, criteriaIds: ["crit:readability"], at: { sha: SHA } }],
  }));
  assert.equal(a.verdict, "uncertain");
  assert.ok(a.reasons.includes("verdict:claims-only-spec"));
});

test("C2-F3: judge '' claim is malformed-shape noise — dropped with a reason, never funds", () => {
  // An empty-judge claim fails the shape predicate (judge must be a
  // non-empty string), so it classifies as advisory noise and is dropped
  // — NOT promoted to bad-input (malformed shape ≠ malformed input).
  // The contract that matters: it never funds and the drop is visible.
  const a = evaluate(input({
    claims: [{ source: "model-judgment", judge: "", claim: "readable", verdict: "complete", confidence: 0.9, criteriaIds: ["crit:readability"], at: { sha: SHA } }],
  }));
  assert.equal(a.verdict, "uncertain", "empty-judge claim funds nothing");
  assert.ok(a.reasons.includes("dropped-claim:malformed-advice-ignored"), `drop is provenance-visible: ${a.reasons.join(",")}`);
});

test("C2-F3: converter + journal fences agree (parity matrix — nothing one accepts the other rejects)", () => {
  // Every assessment the converter accepts MUST pass validateSupervisorRecord
  // once given a valid envelope (converter set ⊆ journal set). Mutations
  // both fences reject, plus the documented converter-strict cases.
  const good = evaluate(input());
  const env = { schema: "tre-supervisor/1" as const, id: "d-parity", ts: 1, episodeId: "ep" };
  validateSupervisorRecord({ ...env, ...toAcceptanceRecord(good) } as never);
  const both = [
    ["judge empty", { modelAdvisory: { judge: "", quote: "q", confidence: 0.9 } }],
    ["confidence -1", { modelAdvisory: { judge: "j", quote: "q", confidence: -1 } }],
    ["artifact dirtyDigest empty", { artifact: { sha: SHA, dirty: true, dirtyDigest: "" } }],
  ] as const;
  for (const [name, patch] of both) {
    const mutated = { ...good, ...patch } as AcceptanceAssessment;
    assert.throws(() => toAcceptanceRecord(mutated), TypeError, `converter must reject: ${name}`);
    // and the journal shape also rejects it (parity: converter accepted
    // set ⊆ journal accepted set; shown here from the other side too)
    assert.throws(() => validateSupervisorRecord({ ...env, ...toAcceptanceRecord(evaluate(input())), ...patch } as never), EpisodeSchemaError, `journal must reject: ${name}`);
  }
  // Converter-strict cases: the journal's num shape carries no maximum and
  // its type check passes NaN through, so the converter is deliberately
  // stricter (confidence ∈ [0,1] finite). Strict-in-the-safe-direction:
  // garbage the journal would tolerate is refused before it can be emitted.
  for (const [name, conf] of [["confidence 2", 2], ["confidence NaN", NaN]] as const) {
    assert.throws(() => toAcceptanceRecord({ ...good, modelAdvisory: { judge: "j", quote: "q", confidence: conf } } as never), TypeError, `converter must reject (stricter): ${name}`);
  }
});

test("C2-F3: durable journal round-trips a full amended acceptance record; artifact:null is refused", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: pjoin } = await import("node:path");
  const { DecisionJournal, validateSupervisorRecord } = await import("../src/episode/journal.js");
  const dir = await mkdtemp(pjoin(tmpdir(), "p14-c2f3-"));
  try {
    const journal = await DecisionJournal.open(pjoin(dir, "decisions.jsonl"));
    const a = evaluate(input());
    const rec = { schema: "tre-supervisor/1" as const, id: "d-c2f3", ts: 1, episodeId: "ep", taskId: "task-001", ...toAcceptanceRecord(a) };
    await journal.append(rec as never);
    const { records } = await journal.read();
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], rec, "append → read is identity for the amended record");
    // artifact:null — the case the cycle-2 probe wrote to disk and the old
    // nullable shape accepted despite the TS interface declaring `artifact?:
    // { ... }` (optional-but-non-null): explicit null now fails validation…
    assert.throws(() => validateSupervisorRecord({ ...rec, artifact: null } as never), EpisodeSchemaError, "artifact:null refused");
    // …and the same record read back from disk fails closed on reopen.
    await import("node:fs/promises").then((fs) => fs.appendFile(pjoin(dir, "decisions.jsonl"), JSON.stringify({ ...rec, id: "d-c2f3-null", artifact: null }) + "\n"));
    await assert.rejects(() => DecisionJournal.open(pjoin(dir, "decisions.jsonl")), /\$\.artifact/, "torn-free file with artifact:null fails closed on open");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("C2-F4: isStale treats malformed revisions as stale (never 'false' from garbage)", () => {
  const good = evaluate(input());
  const cur = { taskRevision: 1, artifact: { sha: SHA } };
  // valid baseline: same rev + same artifact → live
  assert.equal(isStale(good, cur), false);
  for (const rev of [0, -1, 1.5, undefined, null, "1"] as const) {
    assert.equal(isStale({ ...good, taskRevision: rev as never }, cur), true, `stored revision ${String(rev)} is garbage → stale`);
  }
  for (const rev of [0, -1, 1.5, undefined] as const) {
    assert.equal(isStale(good, { taskRevision: rev as never, artifact: { sha: SHA } }), true, `current revision ${String(rev)} is garbage → stale`);
  }
  // Audit repro (efd1866): MATCHING malformed revisions on both sides used
  // to return false ("not stale") because `!==` held. Must be stale.
  for (const rev of [0, -1, 1.5, undefined] as const) {
    assert.equal(isStale({ ...good, taskRevision: rev as never }, { taskRevision: rev as never, artifact: { sha: SHA } }), true, `matching malformed revision ${String(rev)} → stale`);
  }
});

test("C2-F1/F2 ladder order: finding > floor > missing evidence (all three rungs, one input each)", () => {
  // rung 1: concrete finding wins over an otherwise floor-triggering input
  const withFinding = evaluate(input({
    spec: spec({ requiredChecks: [], artifacts: ["out/report.md"] }),
    gates: [],
    artifacts: [{ path: "out/report.md", exists: false, at: { ...ID }, evidenceRef: "fs:m" }],
    claims: [],
  }));
  assert.equal(withFinding.verdict, "incomplete");
  // rung 2: no finding, no current evidence, but evidence shape → floor
  const floorOnly = evaluate(input({
    gates: [],
    artifacts: [{ path: "out/report.md", exists: true, at: { ...ID }, evidenceRef: "fs:m", digest: "d" }],
    claims: [],
  }));
  // gate:tests missing is missing-evidence; exists:true DOES count as
  // current non-model evidence so the floor stands down and the missing
  // check decides. Use a claims-shape-less input with exists-unknown:
  const unknownOnly = evaluate(input({
    spec: spec({ requiredChecks: ["gate:tests"], artifacts: ["out/report.md"] }),
    gates: [],
    artifacts: [],
    claims: [],
  }));
  assert.equal(unknownOnly.verdict, "uncertain");
  assert.ok(unknownOnly.reasons.includes("verdict:check-missing") || unknownOnly.reasons.includes("verdict:no-current-non-model-evidence"));
  void floorOnly;
});
