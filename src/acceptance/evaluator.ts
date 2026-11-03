/**
 * P14 — Acceptance Evaluator (docs/13; docs/11 §9.1 "Acceptance", §13.3
 * "work changes after a passing check" rows; produces the S5
 * kind:"acceptance" payload shape, §14.3 + P14 amendment).
 *
 * One question, one pure answer: given approved criteria and the evidence
 * OBSERVED at an artifact identity, what is the acceptance verdict —
 * complete | incomplete | blocked | uncertain — with evidence refs and
 * remaining work?
 *
 * Boundary (docs/13 §0): NO side effects, NO model calls, NO subprocesses,
 * NO graph mutation, NO budget authority. evaluate() is a pure function of
 * its inputs (EV11); gate execution is a supervisor act, the evaluator
 * judges gate RESULTS. P8 facts enter as plain facts; P10 re-checks with
 * P8 — a verdict is never a permission. Self-contained compartment (the
 * P6/P7/P8 fleet pattern): node: builtins only (the guard test enforces;
 * there are currently no imports at all).
 *
 * Invariants (docs/13 §6 — each has named tests):
 *  AC1 a normal stop / steer receipt / any claim alone never proves
 *     complete — no current deterministic evidence ⇒ at best uncertain.
 *  AC2 model judgment cannot waive a failed or missing deterministic gate.
 *  AC3 stale evidence never counts at the current identity in EITHER
 *     direction; stored assessments go stale exactly on artifact-identity
 *     or taskRevision change (isStale).
 *  AC4 determinism: same input → identical output (pure fold, injected
 *     now, no I/O, no Date(), no env reads).
 *  AC5 fail-closed: malformed input yields uncertain + a "bad-input:…"
 *     reason — never a throw, never an optimistic verdict.
 *  AC6 a gate FAIL is never `blocked`; a blocker never rescues it.
 *  AC7 `complete` is the full conjunction (EV12) — each conjunct
 *     independently defeatable by removing exactly that evidence.
 *  AC8 modelAdvisory is advisory: it never appears as the evidence of a
 *     deterministic criterion.
 *  AC9 compartment: no runtime imports outside src/acceptance/.
 */

// ───────────────────────────── types (docs/13 §1–§2) ─────────────────────────

/** §1 artifact identity — the staleness anchor evidence binds to. */
export interface ArtifactIdentity {
  sha: string;
  dirty?: boolean;
  dirtyDigest?: string;
}

export interface AcceptanceCriterionSpec {
  id: string;
  kind: "deterministic" | "semantic";
  required: boolean;
  note?: string;
}

export interface TaskAcceptanceSpec {
  criteria: AcceptanceCriterionSpec[];
  requiredChecks: string[]; // gate ids; each needs a current PASS
  artifacts: string[]; // expected artifact paths (S3 acceptance.artifacts)
}

export interface GateResult {
  gateId: string;
  pass: boolean;
  at: ArtifactIdentity;
  evidenceRef: string; // non-empty; surfaced on the record
  runId?: string;
}

export interface ArtifactEvidence {
  path: string;
  exists?: boolean; // observed by the caller
  at?: ArtifactIdentity;
  digest?: string; // content digest (the exists-true proof, EV4)
  evidenceRef: string;
}

export interface ClaimEvidence {
  source: "worker-self-report" | "model-judgment";
  judge?: string;
  claim: string;
  verdict?: "complete" | "incomplete" | "blocked";
  confidence?: number;
  criteriaIds?: string[]; // semantic criteria this judgment names (EV6)
  evidenceRefs?: string[];
  at?: ArtifactIdentity; // F3: identity the judgment was MADE at — a claim
  // funds/fails a criterion ONLY at its own identity; a claim without `at`
  // is unbound advice and funds nothing.
}

export type BlockerKind =
  | "authority-denied"
  | "environment"
  | "approval-required"
  | "dependency-external"
  | "budget-exhausted"
  | "other";

export interface BlockerEvidence {
  blocker: BlockerKind;
  at: ArtifactIdentity;
  evidenceRef: string;
}

export interface EvaluateInput {
  taskId: string;
  taskRevision: number;
  current: ArtifactIdentity;
  spec: TaskAcceptanceSpec;
  gates: GateResult[];
  artifacts: ArtifactEvidence[];
  claims: ClaimEvidence[];
  blockers: BlockerEvidence[];
  now: number; // injected clock (EV11)
  semanticMinConfidence?: number; // [0.7] EV6 funding threshold
}

export const VERDICTS = ["complete", "incomplete", "blocked", "uncertain"] as const;
export type AcceptanceVerdict = (typeof VERDICTS)[number];

/** §5 output — mirrors the S5 §14.3 acceptance payload (docs/13 §5). */
export interface AcceptanceAssessment {
  taskId: string;
  taskRevision: number;
  verdict: AcceptanceVerdict;
  criteria: {
    id: string;
    pass: boolean;
    advisory?: boolean;
    evidenceRef?: string;
    checkedAtSha?: string;
  }[];
  remainingWork: string[];
  staleEvidenceRefs: string[];
  artifact: ArtifactIdentity;
  modelAdvisory: { judge: string; quote: string; confidence: number } | null;
  reasons: string[];
}

export const DEFAULT_SEMANTIC_MIN_CONFIDENCE = 0.7;

// ───────────────────────── artifact identity (§1) ────────────────────────────

function validIdentity(a: ArtifactIdentity | undefined | null): a is ArtifactIdentity {
  return (
    !!a &&
    typeof a === "object" &&
    typeof a.sha === "string" &&
    (a.dirty === undefined || typeof a.dirty === "boolean") &&
    (a.dirtyDigest === undefined || typeof a.dirtyDigest === "string")
  );
}

/**
 * sameArtifact: equal iff same sha AND (both dirty with equal
 * dirtyDigest, or neither dirty). A dirty tree is a DIFFERENT artifact
 * from the clean commit; two dirty trees are the same only if their
 * delta digests match (missing digest on a dirty tree is a distinct
 * identity from any digest — an unmeasured delta never equals a
 * measured one, and never equals the clean sha either… it equals
 * another unmeasured delta ONLY if we can say nothing; the fail-closed
 * reading: undefined digests on dirty trees are NOT assumed equal).
 */
export function sameArtifact(a: ArtifactIdentity, b: ArtifactIdentity): boolean {
  // F7: an empty sha is not an identity (docs/13 §1) — a malformed
  // identity never equals anything, including another malformed one.
  if (
    !validIdentity(a) || !validIdentity(b) ||
    a.sha.length === 0 || b.sha.length === 0
  ) return false;
  if (a.sha !== b.sha) return false;
  const da = a.dirty === true;
  const db = b.dirty === true;
  if (!da && !db) return true;
  if (da !== db) return false;
  // both dirty: both digests required and equal (fail-closed on absent)
  return (
    typeof a.dirtyDigest === "string" &&
    a.dirtyDigest.length > 0 &&
    a.dirtyDigest === b.dirtyDigest
  );
}

// ───────────────────────── input validation (§2) ────────────────────────────

/**
 * Collects every malformed-input defect (fail-closed listing, not
 * first-fail — the caller sees the FULL damage in one pass). Any
 * non-empty result forces verdict `uncertain` + reasons prefixed
 * `bad-input:` (AC5).
 */
function validateInput(input: EvaluateInput, current: ArtifactIdentity): string[] {
  const bad: string[] = [];
  const idRe = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

  if (typeof input.taskId !== "string" || !idRe.test(input.taskId)) {
    bad.push("bad-input:taskId");
  }
  if (!Number.isInteger(input.taskRevision) || input.taskRevision < 1) {
    bad.push("bad-input:taskRevision");
  }
  if (!Number.isFinite(input.now) || input.now < 0) {
    bad.push("bad-input:now");
  }
  const msc = input.semanticMinConfidence ?? DEFAULT_SEMANTIC_MIN_CONFIDENCE;
  if (typeof msc !== "number" || !Number.isFinite(msc) || msc < 0 || msc > 1) {
    bad.push("bad-input:semanticMinConfidence");
  }
  if (!validIdentity(current) || current.sha.length === 0) {
    bad.push("bad-input:current identity");
  }

  // spec
  const s = input.spec;
  if (!s || typeof s !== "object") {
    bad.push("bad-input:spec");
    return bad; // nothing else is checkable
  }
  if (!Array.isArray(s.criteria) || !Array.isArray(s.requiredChecks) || !Array.isArray(s.artifacts)) {
    bad.push("bad-input:spec arrays");
    return bad;
  }
  const seenCrit = new Set<string>();
  for (const c of s.criteria) {
    if (!c || typeof c.id !== "string" || !idRe.test(c.id)) {
      bad.push("bad-input:criterion id");
      continue;
    }
    if (seenCrit.has(c.id)) bad.push(`bad-input:duplicate criterion '${c.id}'`);
    seenCrit.add(c.id);
    if (c.kind !== "deterministic" && c.kind !== "semantic") {
      bad.push(`bad-input:criterion '${c.id}' kind`);
    }
    if (typeof c.required !== "boolean") bad.push(`bad-input:criterion '${c.id}' required`);
  }
  const seenCheck = new Set<string>();
  for (const g of s.requiredChecks) {
    if (typeof g !== "string" || !idRe.test(g)) {
      bad.push("bad-input:requiredCheck id");
      continue;
    }
    if (seenCheck.has(g)) bad.push(`bad-input:duplicate requiredCheck '${g}'`);
    seenCheck.add(g);
  }
  const seenArt = new Set<string>();
  for (const a of s.artifacts) {
    if (typeof a !== "string" || a.length === 0 || a.includes("\0")) {
      bad.push("bad-input:artifact path");
      continue;
    }
    if (seenArt.has(a)) bad.push(`bad-input:duplicate artifact '${a}'`);
    seenArt.add(a);
  }

  // gates: identity validity; duplicate gateId ACROSS CURRENT results only
  // (stale duplicates are shadowed, EV1 — but a current PASS+FAIL pair is
  // a contradiction the caller must reconcile, EV2)
  const currentById = new Map<string, GateResult>();
  for (const g of input.gates) {
    if (!g || typeof g.gateId !== "string" || !idRe.test(g.gateId)) {
      bad.push("bad-input:gate id");
      continue;
    }
    if (typeof g.pass !== "boolean") bad.push(`bad-input:gate '${g.gateId}' pass`);
    if (typeof g.evidenceRef !== "string" || g.evidenceRef.length === 0 || g.evidenceRef.includes("\0")) {
      bad.push(`bad-input:gate '${g.gateId}' evidenceRef`);
    }
    if (!validIdentity(g.at) || g.at.sha.length === 0) {
      bad.push(`bad-input:gate '${g.gateId}' identity`);
      continue;
    }
    if (sameArtifact(g.at, current)) {
      const prev = currentById.get(g.gateId);
      if (prev && prev.pass !== g.pass) {
        bad.push(`bad-input:contradictory gate '${g.gateId}' (pass+fail at current)`);
      }
      currentById.set(g.gateId, g);
    }
  }

  // artifacts evidence
  const seenArtEv = new Set<string>();
  for (const a of input.artifacts) {
    if (!a || typeof a.path !== "string" || a.path.length === 0 || a.path.includes("\0")) {
      bad.push("bad-input:artifact evidence path");
      continue;
    }
    if (typeof a.evidenceRef !== "string" || a.evidenceRef.length === 0 || a.evidenceRef.includes("\0")) {
      bad.push(`bad-input:artifact '${a.path}' evidenceRef`);
    }
    // EV4 (+F1): exists:true REQUIRES a non-empty string digest; a
    // PRESENT exists that is not a boolean is malformed (unknown is only
    // for ABSENT exists — a wrong-typed value is garbage, not silence);
    // a present digest that is not a non-empty string is malformed too.
    if (a.exists === true && (typeof a.digest !== "string" || a.digest.length === 0)) {
      bad.push(`bad-input:artifact '${a.path}' exists:true without digest (EV4)`);
    }
    if (a.exists !== undefined && typeof a.exists !== "boolean") {
      bad.push(`bad-input:artifact '${a.path}' exists not a boolean`);
    }
    if (a.digest !== undefined && (typeof a.digest !== "string" || a.digest.length === 0)) {
      bad.push(`bad-input:artifact '${a.path}' digest not a non-empty string`);
    }
    if (a.at !== undefined && (!validIdentity(a.at) || a.at.sha.length === 0)) {
      bad.push(`bad-input:artifact '${a.path}' identity`);
    }
    if (seenArtEv.has(a.path)) bad.push(`bad-input:duplicate artifact evidence '${a.path}'`);
    seenArtEv.add(a.path);
  }

  // claims: shape-checked in evaluate() on the RAW input (arrays) and
  // per-claim there — malformed advice is DROPPED, never fatal: a claim
  // can never carry a verdict, so refusing the whole input for noisy
  // advice would let it DENY everything (dropped claims are reported).

  // blockers
  for (const b of input.blockers) {
    if (!b || typeof b.blocker !== "string" || !BLOCKER_KINDS.includes(b.blocker)) {
      bad.push("bad-input:blocker kind");
      continue;
    }
    if (typeof b.evidenceRef !== "string" || b.evidenceRef.length === 0 || b.evidenceRef.includes("\0")) {
      bad.push(`bad-input:blocker '${b.blocker}' evidenceRef`);
    }
    if (!validIdentity(b.at) || b.at.sha.length === 0) {
      bad.push(`bad-input:blocker '${b.blocker}' identity`);
    }
  }

  return bad;
}

export const BLOCKER_KINDS: readonly BlockerKind[] = [
  "authority-denied",
  "environment",
  "approval-required",
  "dependency-external",
  "budget-exhausted",
  "other",
];

// ───────────────────────── evaluate (§3–§5) ─────────────────────────────────

/**
 * The verdict function (docs/13 §4 total precedence). NEVER throws —
 * every malformed input path ends `uncertain` with `bad-input:…`
 * reasons (AC5). Pure in its input (AC4/EV11).
 */
export function evaluate(input: EvaluateInput): AcceptanceAssessment {
  // F7 (R2 audit): a null/undefined input cannot even be spread — AC5
  // says no input shape may throw.
  if (!input || typeof input !== "object") {
    return {
      taskId: "", taskRevision: 0, verdict: "uncertain", criteria: [],
      remainingWork: [], staleEvidenceRefs: [], artifact: { sha: "" },
      modelAdvisory: null, reasons: ["bad-input:input not an object"],
    };
  }
  // Defensive shallow copy so nothing downstream mutates caller state.
  const arr = <T,>(x: unknown): T[] => (Array.isArray(x) ? x as T[] : []);
  const inp: EvaluateInput = {
    ...input,
    gates: arr<GateResult>(input.gates),
    artifacts: arr(input.artifacts),
    claims: arr(input.claims), // element checks below operate on this array
    blockers: arr(input.blockers),
  };
  // An invalid current identity is normalized AFTER validation records
  // it (bad-input:current identity); downstream identity comparisons
  // then simply find nothing current.
  const current: ArtifactIdentity = validIdentity(inp.current) ? inp.current : { sha: "" };
  const reasons: string[] = [];
  const staleRefs: string[] = [];

  let spec = inp.spec;
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.criteria) || !Array.isArray(spec.requiredChecks) || !Array.isArray(spec.artifacts)) {
    // can't even build output criteria rows: minimal record
    reasons.push("bad-input:spec");
    return {
      taskId: typeof inp.taskId === "string" ? inp.taskId : "",
      taskRevision: typeof inp.taskRevision === "number" ? inp.taskRevision : 0,
      verdict: "uncertain",
      criteria: [],
      remainingWork: [],
      staleEvidenceRefs: [],
      artifact: validIdentity(current) ? { ...current } : { sha: "" },
      modelAdvisory: null,
      reasons,
    };
  }

  const bad = validateInput(inp, current);
  // F2: all four evidence arrays are validated on the RAW input — a
  // non-array never collapses to "empty" (that would manufacture proof
  // of no blockers / no evidence).
  if (!Array.isArray(input.gates)) bad.push("bad-input:gates not an array");
  if (!Array.isArray(input.artifacts)) bad.push("bad-input:artifacts not an array");
  if (!Array.isArray(input.claims)) bad.push("bad-input:claims not an array");
  if (!Array.isArray(input.blockers)) bad.push("bad-input:blockers not an array");
  for (const b of bad) if (!reasons.includes(b)) reasons.push(b);

  // Malformed claims are dropped on the local copies (advice shape
  // defects never fail the whole input — advice is never load-bearing).
  // F5: every field the OUTPUT consumes is part of claim shape — a claim
  // with a malformed judge/evidenceRefs is dropped (its garbage must not
  // be emitted into a durable record).
  const claims: ClaimEvidence[] = [];
  for (const c of inp.claims ?? []) {
    const ok =
      !!c && (c.source === "worker-self-report" || c.source === "model-judgment") &&
      typeof c.claim === "string" && c.claim.length > 0 &&
      (c.confidence === undefined || (typeof c.confidence === "number" && Number.isFinite(c.confidence) && c.confidence >= 0 && c.confidence <= 1)) &&
      (c.verdict === undefined || c.verdict === "complete" || c.verdict === "incomplete" || c.verdict === "blocked") &&
      (c.criteriaIds === undefined || (Array.isArray(c.criteriaIds) && c.criteriaIds.every((x) => typeof x === "string"))) &&
      (c.judge === undefined || typeof c.judge === "string") &&
      (c.evidenceRefs === undefined || (Array.isArray(c.evidenceRefs) && c.evidenceRefs.every((x) => typeof x === "string" && x.length > 0))) &&
      // F3: `at`, when present, must be a WELL-FORMED identity — a claim
      // with a garbage identity is unbound (funds nothing), not "current".
      (c.at === undefined || (validIdentity(c.at) && c.at.sha.length > 0));
    if (ok) claims.push(c);
    else reasons.push("dropped-claim:malformed-advice-ignored");
  }

  // ── current-identity views (EV1) ──────────────────────────────────────
  // F3: claims bind to their own identity — only claims made AT the
  // current artifact fund or fail criteria. Unbound (no `at`) and stale
  // claims are advice about a DIFFERENT artifact: they surface in
  // modelAdvisory only if they are the latest judgment (advice is never
  // load-bearing) but fund/flip nothing, and their evidenceRefs are
  // listed as stale.
  const currentClaims = claims.filter(
    (c) => c.source === "model-judgment" && c.at !== undefined && validIdentity(c.at) && sameArtifact(c.at, current),
  );
  for (const c of claims) {
    if (c.at === undefined || !sameArtifact(c.at, current)) {
      for (const r of c.evidenceRefs ?? []) if (r) staleRefs.push(r);
    }
  }
  const currentGate = new Map<string, GateResult>();
  for (const g of inp.gates) {
    if (!g) continue;
    if (validIdentity(g.at) && sameArtifact(g.at, current)) currentGate.set(g.gateId, g);
    else if (typeof g.evidenceRef === "string" && g.evidenceRef) staleRefs.push(g.evidenceRef);
  }
  const currentArt = new Map<string, ArtifactEvidence>();
  for (const a of inp.artifacts) {
    if (!a) continue;
    if (a.at !== undefined && validIdentity(a.at) && sameArtifact(a.at, current)) currentArt.set(a.path, a);
    else if (a.at !== undefined && typeof a.evidenceRef === "string" && a.evidenceRef) staleRefs.push(a.evidenceRef);
    // artifact evidence with NO identity is unbound: never counts (§1);
    // recorded as stale so the caller sees it was ignored.
    if (a.at === undefined && typeof a.evidenceRef === "string" && a.evidenceRef) staleRefs.push(a.evidenceRef);
  }
  const currentBlockers = inp.blockers.filter((b) => !!b && validIdentity(b.at) && sameArtifact(b.at, current));
  for (const b of inp.blockers) if (b && !currentBlockers.includes(b) && typeof b.evidenceRef === "string" && b.evidenceRef) staleRefs.push(b.evidenceRef);
  // claim evidenceRefs are advice pointers (unverified); not evidence-owned

  // model advisory: latest model-judgment claim among ALL claims
  // (including stale/unbound — advice is never load-bearing, so showing
  // a stale judgment here is honest visibility, not evidence). Input
  // order = newest last, documented contract.
  let advisory: AcceptanceAssessment["modelAdvisory"] = null;
  for (const c of claims) {
    if (c.source === "model-judgment") {
      advisory = {
        judge: c.judge ?? "unknown",
        quote: c.claim,
        confidence: typeof c.confidence === "number" ? c.confidence : 0,
      };
    }
  }

  // ── criterion rows ────────────────────────────────────────────────────
  interface Row {
    id: string;
    pass: boolean;
    advisory?: boolean;
    evidenceRef?: string;
    checkedAtSha?: string;
    required: boolean;
    kind: "deterministic" | "semantic";
  }
  const rows: Row[] = [];
  const judgedIncomplete = new Set<string>(); // EV6: judge explicitly named incomplete
  const msc = inp.semanticMinConfidence ?? DEFAULT_SEMANTIC_MIN_CONFIDENCE;

  for (const c of spec.criteria) {
    if (!c || typeof c !== "object") continue; // bad-input already recorded
    const row: Row = { id: c.id, pass: false, required: c.required === true || c.required === false ? c.required : false, kind: c.kind };
    if (c.kind === "deterministic") {
      const g = currentGate.get(c.id);
      if (g) {
        row.pass = g.pass; // EV7: deterministic pass only by a current PASS gate (id IS gate id)
        row.evidenceRef = g.evidenceRef;
        row.checkedAtSha = g.at.sha;
      }
    } else {
      // EV6 (+F3): funded by a model-judgment made AT the current
      // identity, naming the criterion
      for (const cl of currentClaims) {
        if (cl.source !== "model-judgment") continue;
        const named = Array.isArray(cl.criteriaIds) && cl.criteriaIds.includes(c.id);
        if (!named) continue;
        if (cl.verdict === "complete" && (typeof cl.confidence === "number" ? cl.confidence : 0) >= msc) {
          row.pass = true;
          row.advisory = true;
          row.evidenceRef = cl.evidenceRefs?.[0] ?? `claim:${cl.judge ?? "unknown"}`;
          // AC8: NO sha on advisory rows — a model judgment is not an
          // artifact check; pinning the current sha here would make it
          // indistinguishable from a deterministic pass.
        } else if (cl.verdict === "incomplete") {
          row.pass = false; // a judge's "incomplete" is respected, never waived upward
          judgedIncomplete.add(c.id);
          row.evidenceRef = cl.evidenceRefs?.[0];
        }
      }
    }
    rows.push(row);
  }

  // ── required checks (EV2) ─────────────────────────────────────────────
  const missingChecks: string[] = [];
  const failedCurrent: string[] = [];
  for (const gid of spec.requiredChecks) {
    if (typeof gid !== "string") continue; // bad-input already recorded
    const g = currentGate.get(gid);
    if (!g) missingChecks.push(gid);
    else if (!g.pass) failedCurrent.push(gid);
  }

  // current FAILs among criteria (EV3)
  for (const r of rows) if (r.kind === "deterministic" && currentGate.has(r.id) && !r.pass) failedCurrent.push(r.id);
  // F8 (R2 audit): EV12 says NO current FAIL ANYWHERE — a current FAIL of
  // a gate the spec never mentions is still work-to-do evidence, never a
  // rescuable complete.
  for (const [gid, g] of currentGate) {
    if (!g.pass && !failedCurrent.includes(gid)) failedCurrent.push(gid);
  }
  // semantic current fails are work, not verdict-flipping failures — but a
  // required semantic criterion the judge explicitly called incomplete IS
  // a current negative finding: it blocks `complete`, it is not `blocked`.

  // ── expected artifacts (EV4, F1 strictness) ───────────────────────────
  // Satisfied ONLY by the exact shape exists===true + non-empty digest at
  // current. exists:false → proven missing (incomplete). exists ABSENT or
  // non-boolean → UNKNOWN observation (uncertain, EV9 — never inferred).
  const missingArtifacts: string[] = [];
  const unobservedArtifacts: string[] = [];
  for (const p of spec.artifacts) {
    if (typeof p !== "string") continue; // bad-input already recorded
    const ev = currentArt.get(p);
    if (!ev) unobservedArtifacts.push(p);
    else if (ev.exists === true) {
      // EV4: the digest is the exists-true proof; malformed shape was
      // bad-input'd in validateInput, but judge defensively here too —
      // a truthy-but-wrong digest type never satisfies.
      if (typeof ev.digest !== "string" || ev.digest.length === 0) unobservedArtifacts.push(p);
    } else if (ev.exists === false) {
      missingArtifacts.push(p);
    } else {
      // exists undefined / wrong type (already bad-input'd if wrong type)
      unobservedArtifacts.push(p);
    }
  }

  // ── §4 total precedence (F4/F6 amendments — docs/13 §8) ───────────────
  // Order: bad input > claims-only cap (F4) > current FAIL > judge-declared
  // incomplete (F6: a CONCRETE finding, same rung as a current FAIL) >
  // artifact exists:false > artifact unobserved > required gate missing >
  // criterion unfunded > blockers (blocked) > all green (complete) >
  // default uncertain. Missing-evidence rules outrank blocked; a concrete
  // negative FINDING (FAIL or judge-incomplete) outranks missing evidence
  // — absence of evidence never outranks presence of a finding.
  const badInput = bad.some((m) => m.startsWith("bad-input:"));
  const currentFails: string[] = [];
  const judgeIncomplete: string[] = [];
  for (const gid of failedCurrent) currentFails.push(gid);
  for (const r of rows) {
    if (r.pass) continue;
    if (r.kind === "deterministic" && currentGate.has(r.id)) continue; // already in currentFails
    if (r.required && judgedIncomplete.has(r.id)) judgeIncomplete.push(r.id); // F6: concrete finding
  }
  // F4: the AC1 floor — complete requires ≥1 current NON-MODEL evidence
  // (a current gate result or a satisfied artifact observation). A
  // claims-only spec (no required checks, no expected artifacts) can
  // never rise above uncertain: judgment alone is not proof.
  const hasRequiredEvidenceShape = spec.requiredChecks.length > 0 || spec.artifacts.length > 0;
  const hasCurrentNonModelEvidence =
    currentGate.size > 0 ||
    [...currentArt.values()].some((ev) => ev.exists === true && typeof ev.digest === "string" && ev.digest.length > 0);

  let verdict: AcceptanceVerdict;
  if (badInput) {
    verdict = "uncertain";
    reasons.push("verdict:bad-input");
  } else if (!hasRequiredEvidenceShape) {
    // F4: a spec demanding NO deterministic evidence is malformed by
    // construction — the caller must provide gates or artifacts.
    reasons.push("verdict:claims-only-spec");
    verdict = "uncertain";
  } else if (judgeIncomplete.length > 0) {
    // F6: a judge explicitly calling a required semantic criterion
    // incomplete is a concrete negative finding — it outranks the
    // missing-evidence rules below (they describe ABSENCE of evidence,
    // this is PRESENCE of a finding) and can never be outranked by
    // blocked. It sits above the F4 floor too: with zero evidence at
    // current AND an explicit negative finding, the finding is still
    // the answer (the work is what the judge named, not "unknown").
    reasons.push("verdict:criterion-incomplete");
    verdict = "incomplete";
  } else if (!hasCurrentNonModelEvidence) {
    reasons.push("verdict:no-current-non-model-evidence");
    verdict = "uncertain";
  } else if (currentFails.length > 0 || missingArtifacts.length > 0) {
    if (currentFails.length > 0) reasons.push("verdict:current-fail");
    if (missingArtifacts.length > 0) reasons.push("verdict:artifact-missing");
    verdict = "incomplete";
  } else if (missingChecks.length > 0 || unobservedArtifacts.length > 0) {
    // missing evidence outranks blocked (EV9: the floor, not a weapon;
    // a blocker never substitutes for required evidence)
    if (missingChecks.length > 0) reasons.push("verdict:check-missing");
    if (unobservedArtifacts.length > 0) reasons.push("verdict:artifact-unobserved");
    verdict = "uncertain";
  } else {
    // EV12 conjunction checks FIRST (spec §4 order): every required
    // criterion must pass before a blocker may say `blocked` —
    // missing/failing judgment evidence outranks blocked (EV9).
    const reqUnmet = rows.filter((r) => r.required && !r.pass);
    if (reqUnmet.length > 0) {
      reasons.push("verdict:criterion-unfunded");
      verdict = "uncertain";
    } else if (currentBlockers.length > 0) {
      reasons.push("verdict:blocked");
      verdict = "blocked";
    } else {
      // all green: required gates PASS (no missingChecks, no current
      // fails), every required criterion passes, artifacts satisfied,
      // no current blockers. Non-required unsatisfied items do NOT
      // block complete — they DO appear in remainingWork.
      verdict = "complete";
    }
  }

  // remainingWork: every unmet required item + non-required misses (ordered
  // deterministic-first so a safe resume sees concrete work first)
  const remaining = new Set<string>();
  if (verdict === "uncertain" && (reasons.includes("verdict:claims-only-spec") || reasons.includes("verdict:no-current-non-model-evidence"))) {
    // F4: name the missing evidence shape so the resume knows what to gather
    if (!hasRequiredEvidenceShape) {
      remaining.add("evidence:spec-requires-at-least-one-check-or-artifact");
    } else {
      remaining.add("evidence:no-current-gate-or-artifact-observation");
    }
  }
  for (const gid of missingChecks) remaining.add(`check:${gid}`);
  for (const gid of failedCurrent) remaining.add(`check:${gid}`);
  for (const r of rows) if (!r.pass) remaining.add(`criterion:${r.id}`);
  for (const p of missingArtifacts) remaining.add(`artifact:${p}`);
  for (const p of unobservedArtifacts) remaining.add(`artifact:${p}`);
  if (currentBlockers.length > 0 && verdict === "blocked") {
    remaining.clear();
    for (const b of currentBlockers) remaining.add(`blocker:${b.blocker}`);
  }

  return {
    taskId: inp.taskId,
    taskRevision: inp.taskRevision,
    verdict,
    criteria: rows.map(({ id, pass, advisory, evidenceRef, checkedAtSha }) => {
      const c: AcceptanceAssessment["criteria"][number] = { id, pass };
      if (advisory) c.advisory = true;
      if (evidenceRef) c.evidenceRef = evidenceRef;
      if (checkedAtSha) c.checkedAtSha = checkedAtSha;
      return c;
    }),
    remainingWork: [...remaining],
    staleEvidenceRefs: [...new Set(staleRefs)],
    artifact: { ...current },
    modelAdvisory: advisory,
    reasons: [...new Set(reasons)],
  };
}

// ───────────────────── stored-assessment staleness (§5.1) ───────────────────

/**
 * A stored assessment is LIVE iff same taskRevision AND
 * sameArtifact(stored.artifact, current). Anything else is stale.
 * Staleness NEVER converts a complete into a failure — it removes the
 * assessment from evidence (§13.3; the supervisor persists invalidation
 * via the S5 invalidatedBy field; P14 does not write journals).
 */
export function isStale(stored: AcceptanceAssessment, current: { taskRevision: number; artifact: ArtifactIdentity }): boolean {
  // F7: a malformed stored assessment (or one bound to a non-identity —
  // empty sha is not an identity, §1) is never live; the current
  // identity must be well-formed too.
  if (!validIdentity(stored?.artifact) || stored.artifact.sha.length === 0) return true;
  if (!validIdentity(current?.artifact) || current.artifact.sha.length === 0) return true;
  if (stored.taskRevision !== current.taskRevision) return true;
  return !sameArtifact(stored.artifact, current.artifact);
}

// ───────────────────── S5 record conversion (§7.4) ──────────────────────────

export interface AcceptanceRecordFields {
  kind: "acceptance";
  taskRevision?: number;
  verdict: AcceptanceVerdict;
  criteria: { id: string; pass: boolean; evidenceRef?: string; checkedAtSha?: string; advisory?: true }[];
  remainingWork?: string[];
  invalidatedBy?: string | null;
  modelAdvisory?: { judge: string; quote: string; confidence: number } | null;
  staleEvidenceRefs?: string[];
  artifact?: ArtifactIdentity;
}

/**
 * Field-copy to the §14.3 acceptance shape (+ P14 amendment fields).
 * Validates the OUTPUT contract (a corrupted assessment object cannot
 * become a durable record); does NOT append — the P4 journal owns
 * writing, the supervisor owns envelope fields (id/ts/episodeId).
 */
export function toAcceptanceRecord(a: AcceptanceAssessment): AcceptanceRecordFields {
  // F5: validate the COMPLETE record shape — a corrupted assessment
  // object cannot become a durable record. Throws TypeError (§7.4
  // contract) on any malformed field; P4 validation is the second fence.
  assertAssessment(a);
  const rec: AcceptanceRecordFields = {
    kind: "acceptance",
    verdict: a.verdict,
    criteria: a.criteria.map((c) => {
      const out: AcceptanceRecordFields["criteria"][number] = { id: c.id, pass: c.pass };
      if (c.evidenceRef) out.evidenceRef = c.evidenceRef;
      if (c.checkedAtSha) out.checkedAtSha = c.checkedAtSha;
      if (c.advisory) out.advisory = true;
      return out;
    }),
    modelAdvisory: a.modelAdvisory,
  };
  if (a.taskRevision !== undefined) rec.taskRevision = a.taskRevision;
  if (a.remainingWork.length > 0) rec.remainingWork = a.remainingWork;
  if (a.staleEvidenceRefs.length > 0) rec.staleEvidenceRefs = a.staleEvidenceRefs;
  if (a.artifact.sha.length > 0) rec.artifact = a.artifact;
  return rec;
}

/** F5: full-shape validation of an AcceptanceAssessment (throws TypeError).
 *  Mirrors the §14.3 + P14-amendment wire shape field by field. */
function assertAssessment(a: AcceptanceAssessment): void {
  const fail = (what: string): never => { throw new TypeError(`toAcceptanceRecord: bad ${what}`); };
  if (!a || typeof a !== "object") fail("assessment (not an object)");
  if (!VERDICTS.includes(a.verdict)) fail(`verdict '${String(a.verdict)}'`);
  if (typeof a.taskId !== "string" || a.taskId.length === 0) fail("taskId");
  if (!Number.isInteger(a.taskRevision) || a.taskRevision < 1) fail("taskRevision");
  if (!Array.isArray(a.criteria)) fail("criteria (not an array)");
  for (const c of a.criteria) {
    if (!c || typeof c !== "object") fail("criterion (not an object)");
    if (typeof c.id !== "string" || c.id.length === 0) fail(`criterion id '${String(c.id)}'`);
    if (typeof c.pass !== "boolean") fail(`criterion '${c.id}' pass`);
    if (c.advisory !== undefined && c.advisory !== true) fail(`criterion '${c.id}' advisory`);
    if (c.evidenceRef !== undefined && (typeof c.evidenceRef !== "string" || c.evidenceRef.length === 0)) fail(`criterion '${c.id}' evidenceRef`);
    if (c.checkedAtSha !== undefined && (typeof c.checkedAtSha !== "string" || c.checkedAtSha.length === 0)) fail(`criterion '${c.id}' checkedAtSha`);
    // AC8: an advisory row carries no checkedAtSha — a model judgment is
    // not an artifact check.
    if (c.advisory === true && c.checkedAtSha !== undefined) fail(`criterion '${c.id}' advisory with checkedAtSha`);
  }
  if (!Array.isArray(a.remainingWork) || !a.remainingWork.every((w) => typeof w === "string" && w.length > 0)) fail("remainingWork");
  if (!Array.isArray(a.staleEvidenceRefs) || !a.staleEvidenceRefs.every((r) => typeof r === "string" && r.length > 0)) fail("staleEvidenceRefs");
  if (!a.artifact || typeof a.artifact !== "object" || typeof a.artifact.sha !== "string" || (a.artifact.dirty !== undefined && typeof a.artifact.dirty !== "boolean") || (a.artifact.dirtyDigest !== undefined && typeof a.artifact.dirtyDigest !== "string")) fail("artifact");
  if (a.modelAdvisory !== null && (typeof a.modelAdvisory !== "object" || typeof a.modelAdvisory.judge !== "string" || typeof a.modelAdvisory.quote !== "string" || typeof a.modelAdvisory.confidence !== "number" || !Number.isFinite(a.modelAdvisory.confidence))) fail("modelAdvisory");
  if (!Array.isArray(a.reasons) || !a.reasons.every((r) => typeof r === "string" && r.length > 0)) fail("reasons");
}
