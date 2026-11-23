/**
 * G1 step 1 — TypeScript wire types for the audit-finding contracts
 * (docs/11-orchestrator-schema.md §14.10.1 / §14.10.2 / §14.10.3 /
 * §14.12.4 / §14.12.4b; register §14.10.0 NDR-a…v).
 *
 * WIRES ONLY: the JSONL record shapes the S5 log carries, the closed
 * vocabularies (§14.10.1: an unknown value makes the record invalid —
 * the receiver refuses the line and surfaces it, never silently drops
 * it — NDR-t(1)), the owner-act op payload schemas (§14.10.3 closed
 * per-op payloads), the NDR-q canonical condition list + registration
 * interface (exported BEFORE its consumers, per
 * g1-implementation-mapping.md step 1 / row q), and the `faultsIfc`
 * seam (MINOR-1: `fold.ts` consumes faults through this interface;
 * `faults.ts` lands step 5 with the real impl behind it).
 *
 * Record kinds (G1 wire kinds; per-kind defining sites in the
 * RECORD_KIND_CLOSED_SET PROVENANCE block — docs/11 has no single
 * closed enumeration; the §14.12.4b inventory covers only the
 * boundary-protocol kinds): `audit-finding`,
 * `audit-finding-update`, `owner-act`, `audit-filing-intake-refusal`,
 * `owner-filing-integrity-fault`, `filing-integrity-disposition`,
 * `audit-filing-readjudication-outcome` (NDR-i serialized unit, §14.10.3),
 * `repro-run` (§14.12.4: NDR-s three-value `result`,
 * `reproDigest`/`executedArtifactDigest`/`runner`/`runEvidenceRef` +
 * `cureGateId` v28 R5-C20-2), `cure-gate` (§14.10.3 v28 R5-C20-2,
 * shape + nonce rule only — append/recovery/binding clauses are
 * §14.10.3's text, the ordering-witness predicate is NDR-u para (3)),
 * `residual-cure-settlement` (NDR-u phase 2, deterministic id
 * `cure-settlement-<cureActId>` + `ancestryWitness` closed shape
 * consumed — never recomputed — by replay), `finding-hold` /
 * `finding-hold-lift` (§14.12.4 owner records, NDR-q hold row —
 * WIRE DEPENDENCIES per g1-implementation-mapping row q: the shapes
 * + intake vocab ship in step 1 so the row's closer ref resolves;
 * sign-off-counting semantics + the lift CLOSER transition land
 * with G3), plus the `audit-filing-readjudication-outcome`-adjacent
 * re-adjudication vocabulary (NDR-i/e).
 *
 * NDR grep discipline (mapping "each site carries a `// NDR-x`
 * comment"): every register id NDR-a … NDR-v appears at least once
 * in this file at the wire obligation it governs — ids whose PREDICATE
 * homes in a later module (NDR-b/c/g/j/n/r land in
 * `disposition.ts`/`intake.ts`/`faults.ts`/`adjudicate.ts`/`fold.ts`)
 * are carried as a `per NDR-x` reference at their wire operand.
 *
 * NO behavior, NO mutation, NO policy decisions live here:
 *  - emission authority (§14.10.3) is expressed by naming each kind's
 *    producer + the kind table; the append API owns the gate;
 *  - intake validation lives in `intake.ts` (step 2); this module only
 *    makes the shapes + vocabularies expressible;
 *  - lifecycle transitions / edge fold live in `fold.ts` /
 *    `disposition.ts`.
 *
 * Envelope (all records, §14.10.1): `{schema:"tre-supervisor/1", id,
 * ts, episodeId, taskId?}` — `id` is supervisor-minted at intake:
 * fresh conforming ULID, collision-refused (R7). `ts` is advisory;
 * S5 append order is the truth. Filing identity and re-delivery
 * semantics over identical bytes are owned by NDR-r (redelivery
 * idempotence vs a new filing attempt vs same-act divergent bytes).
 */

/* ================= envelope & primitives ================= */

/** The one envelope schema string (§14.10.1). */
export const ENVELOPE_SCHEMA = "tre-supervisor/1" as const;
export type EnvelopeSchema = typeof ENVELOPE_SCHEMA;

// Conforming ULID (§14.10.1 R7 "fresh conforming ULID"): 26-char
// Crockford base32 over the 128-bit space — the FIRST character is
// restricted to 0–7 (G2 round-5 cycle-2 fold, terra G2-3: any first
// char above `7` exceeds 2^128−1, which no conforming ULID can).
const ULID_RE = /^[0-7][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{25}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** True iff `v` is a conforming 26-char Crockford-base32 ULID. */
export function isUlid(v: string): boolean {
  return typeof v === "string" && ULID_RE.test(v);
}

/** True iff `v` is 64-char lowercase sha256 hex. */
export function isSha256Hex(v: string): boolean {
  return typeof v === "string" && SHA256_HEX_RE.test(v);
}

/** True iff `v` is a `sha256:<hex>` digest string (§14.10.1 examples). */
export function isDigest(v: string): boolean {
  return typeof v === "string" && DIGEST_RE.test(v);
}

/** True iff `v` is a 64-char lowercase-hex value (cure-gate nonce /
 * artifact digest wire shape, §14.10.3 v28 R5-C20-2). */
export function isHex64(v: string): boolean {
  return typeof v === "string" && SHA256_HEX_RE.test(v);
}

/** Common envelope members carried by every record (§14.10.1). */
export interface Envelope {
  schema: EnvelopeSchema;
  /** supervisor-minted fresh conforming ULID (R7); caller-supplied ids
   * are test-only */
  id: string;
  /** advisory epoch ms; append order is the truth */
  ts: number;
  episodeId: string;
  /** optional (§14.10.1): a finding may name a contract, not a task */
  taskId?: string | null;
}

/* ================= §14.10.1 audit-finding — vocabularies ============ */

/**
 * `route` — THE routing field (R1-B): `code-fix` re-enters the
 * implementation loop, `human-review` goes to the owner ledger.
 * G2 gates intake, never re-routes.
 */
export const ROUTE_CLOSED_SET = Object.freeze(["code-fix", "human-review"] as const);
export type Route = (typeof ROUTE_CLOSED_SET)[number];

/** `surface` — artifact domain (R1-B). */
export const SURFACE_CLOSED_SET = Object.freeze(["code", "test", "doc", "spec"] as const);
export type Surface = (typeof SURFACE_CLOSED_SET)[number];

/** Intake rule (§14.10.1): `surface:"spec"` with `route:"code-fix"` is
 * invalid; everything else may pair freely. */
export function isRouteSurfaceValid(route: Route, surface: Surface): boolean {
  return !(route === "code-fix" && surface === "spec");
}

/** `severity` — the repo's blocker/major/minor audit vocabulary. */
export const SEVERITY_CLOSED_SET = Object.freeze(["blocker", "major", "minor"] as const);
export type Severity = (typeof SEVERITY_CLOSED_SET)[number];

/** `verdictBasis` (§14.10.1). */
export const VERDICT_BASIS_CLOSED_SET = Object.freeze([
  "repro",
  "evidence-only",
  "opinion",
] as const);
export type VerdictBasis = (typeof VERDICT_BASIS_CLOSED_SET)[number];

/** `origin` (v5 R2-2). Entry mode is derived, not a value of origin —
 * see `entryModeOf`. */
export const ORIGIN_CLOSED_SET = Object.freeze(["auditor", "owner"] as const);
export type Origin = (typeof ORIGIN_CLOSED_SET)[number];

/** `repro.kind` wire enum (v15 R5-C9-6: `command` is OUTSIDE the wire
 * enum). */
export const REPRO_KIND_CLOSED_SET = Object.freeze([
  "probe",
  "fixture",
  "session-log",
  "none",
] as const);
export type ReproKind = (typeof REPRO_KIND_CLOSED_SET)[number];

/** `repro` object (§14.10.1). Required (`kind` ≠ "none") for every
 * NON-MINOR finding for EVERY producer — the canonical NDR-b
 * acceptance-evidence rule (docs/11:1732–1740) refuses a `kind:"none"`
 * filing of a non-minor finding regardless of route; §14.10.1's
 * narrower "required when `route:"code-fix"` AND severity ≠ minor"
 * (docs/11:2579) states the intake floor subsumed by it — an
 * unfalsifiable blocker/major is refused at intake
 * (`finding-intake-invalid`). A minor `kind:"none"` finding is not
 * itself refused at filing; it reaches `accepted-fix` ONLY via the
 * owner minor exception (G3 round-5 cycle-3 fold, terra G3-2: the
 * exception restricts the accepted-fix route, not filing generally). */
export interface Repro {
  kind: ReproKind;
  command: string;
  preFixObserved: string;
  postFixExpected: string;
}

/** `affectedNorm` (R6): an OBJECT or null (null = pure-code finding).
 * A finding binds AT MOST ONE norm. */
export interface AffectedNorm {
  doc: string;
  /** free-text locant */
  anchor: string;
  /** digest of the anchored text at reference time; **optional until
   * G2 rules** whether digests are mandatory (§14.10 R6 — the field
   * may be OMITTED; reserved now while amendment is free). When
   * present it is the digest (or null — the R6 round-1 shape spells
   * the field `sha256|null`; omission carries the same "no digest
   * yet" meaning). */
  sha256?: string | null;
}

/** producer trio (v5: names whichever session produced the finding;
 * nullable for owner audits performed outside tre.). */
export interface Producer {
  endpoint: string | null;
  model: string | null;
  sessionId: string | null;
}

/** `originRef` binding (§14.12.4 c4-B2; entry-mode table v7 R4-C1-2). */
export type OriginRef =
  | { origin: "intake"; receiptId: string }
  | { origin: "supervisor-derived"; fromRefusalId: string };

/** The three entry modes (v7 R4-C1-2 — "exactly three modes; a
 * validator refuses every other field combination"). */
export const ENTRY_MODE_CLOSED_SET = Object.freeze([
  "auditor-intake",
  "owner-act",
  "supervisor-derived",
] as const);
export type FindingEntryMode = (typeof ENTRY_MODE_CLOSED_SET)[number];

/**
 * Derive the entry mode from the nullability triple, per the §14.10.1
 * entry-mode table (the single normative statement; wire comments are
 * signposts). Returns null for any combination the table refuses.
 *
 * | mode               | origin            | originRef                          | ownerActRef |
 * |--------------------|-------------------|------------------------------------|-------------|
 * | auditor intake     | "auditor"         | {origin:"intake",…} REQUIRED       | null        |
 * | owner act          | "owner"           | null                               | REQUIRED    |
 * | supervisor-derived | "auditor"|"owner" | {origin:"supervisor-derived",…} REQ| null        |
 */
export function entryModeOf(
  f: Pick<AuditFinding, "origin" | "originRef" | "ownerActRef">,
): FindingEntryMode | null {
  if (f.originRef !== null && f.ownerActRef !== null) return null; // never both
  if (f.origin === "owner" && f.originRef === null) {
    return f.ownerActRef !== null ? "owner-act" : null; // owner-act requires the act
  }
  if (f.originRef === null) return null; // the other two modes require originRef
  if (f.ownerActRef !== null) return null;
  if (f.originRef.origin === "intake") {
    return f.origin === "auditor" ? "auditor-intake" : null;
  }
  if (f.originRef.origin === "supervisor-derived") {
    // supervisor-derived permits either origin (who OBSERVED the defect)
    return "supervisor-derived";
  }
  return null;
}

/**
 * `audit-finding` record (§14.10.1). Immutable, starts `open` —
 * carries NO disposition field; all state changes flow through
 * `audit-finding-update` (§14.10.2). Producer: supervisor at intake
 * (all three entry modes).
 */
export interface AuditFinding extends Envelope {
  kind: "audit-finding";
  /** episode-wide round that produced it (v5 R2-5) */
  cycle: number;
  origin: Origin;
  producer: Producer;
  /** the filing ACT id (NOT a finding id); non-null ONLY in owner-act
   * mode, null otherwise (entry-mode nullability, §14.12.4) */
  ownerActRef: string | null;
  /** REQUIRED {origin:"intake",receiptId} in auditor-intake mode;
   * REQUIRED {origin:"supervisor-derived",fromRefusalId} in
   * supervisor-derived mode; null in owner-act mode */
  originRef: OriginRef | null;
  /** v6 F1: REQUIRED non-null findingId ONLY for the owner re-filing
   * that corrects a WRONG refutation (targets restricted to
   * rejected-refuted closures — `correction-bad-target`); REQUIRED
   * null otherwise; may only be non-null in owner-act mode */
  correctionOf: string | null;
  route: Route;
  surface: Surface;
  severity: Severity;
  verdictBasis: VerdictBasis;
  /** bounded summary, ≤2000 chars, single line */
  claim: string;
  /** supervisor-computed at intake over the findingRef artifact bytes
   * (plain sha256 — the artifact is evidence, not policy) */
  claimDigest: string;
  /** REQUIRED: full-prose artifact in the episode dir (R5-A);
   * append-only after filing — an edit is a NEW findingRef + NEW
   * record superseding the old, legal ONLY while the old is OPEN */
  findingRef: string;
  /** G5 (§14.14.1): repo-relative paths/#anchors; [] = unscoped.
   * OPAQUE here — G1 validates `string[]` shape only (no §14.14.3
   * semantics claimed at step 1) */
  scopeRefs: string[];
  repro: Repro;
  /** ≥1 session-log or decision-log entry id required */
  evidenceRefs: string[];
  /** v27 R5-C19-3 REQUIRED PRESENT (may be null): the DURABLE lineage
   * operand for the fresh-finding-cycle cure settlement route (NDR-u
   * (3)). A finding curing a residual names the `residual-cure` ACT's
   * record id; intake checks IDENTITY only over the intake-validation
   * prefix (unknown id / non-cure act ⇒ `cure-unknown-act`);
   * confirmed + unsettled + not-cancelled is a SETTLEMENT-prefix
   * check. This is the ONLY encoding of cure lineage — prose or
   * evidenceRefs citations settle nothing (v28 R5-C20P-5). */
  cureActRef: string | null;
  affectedNorm: AffectedNorm | null;
}

/** Intake-shape check (NDR-b): `repro.kind:"none"` is refused for
 * non-minor findings for EVERY producer. The refusal predicate NDR-b
 * states carries NO route clause (docs/11:1739: "`repro.kind:\"none\"`
 * is refused for non-minor findings for every producer"), so it binds
 * across routes — this severity-only check is the ONLY implementation
 * satisfying both rule bodies: §14.10.1's narrower "required when
 * `route:\"code-fix\"` AND severity ≠ minor" (docs/11:2579) is the
 * intake floor (silence on ¬code-fix licenses nothing — a record must
 * satisfy EVERY rule, and NDR-b refuses kind:none + non-minor +
 * human-review outright). Register doctrine (OWNER DECISION D3): the
 * canonical NDR entry governs over narrower diverging prose. */
export function isFindingReproSatisfied(
  f: Pick<AuditFinding, "severity" | "repro">,
): boolean {
  return !(f.severity !== "minor" && f.repro.kind === "none");
}

/* ================= §14.10.2 audit-finding-update ==================== */

/** The five named closures (transitions). */
export const UPDATE_TO_CLOSED_SET = Object.freeze([
  "accepted-fix",
  "rejected-refuted",
  "rejected-duplicate",
  "closed-residual",
  "superseded",
] as const);
export type UpdateTo = (typeof UPDATE_TO_CLOSED_SET)[number];

/** `dispositionBy` (§14.10.2). */
export const DISPOSITION_BY_CLOSED_SET = Object.freeze(["orchestrator", "owner"] as const);
export type DispositionBy = (typeof DISPOSITION_BY_CLOSED_SET)[number];

/**
 * `audit-finding-update` record (§14.10.2). NO `from` field — current
 * state is derivable by log order. Intake refuses a transition over an
 * already-closed finding; reopening happens ONLY through the two
 * named edges (NDR-p, jointly exhaustive):
 *  (1) owner minor-exception accepted-fix over rejected-duplicate OR
 *      superseded (minor + dispositionBy "owner" + act-bound +
 *      matching reason + reproRunRef === null);
 *  (2) owner closed-residual over rejected-duplicate OR superseded
 *      for an r4 strand ((a) owner-retired-by-withdrawal or (b)
 *      validly-refuted survivor + owner-authorized member link).
 * Both FORWARD-ONLY; every other transition over any closed state is
 * invalid. Predicates enforced in `disposition.ts` (step 4).
 */
export interface AuditFindingUpdate extends Envelope {
  kind: "audit-finding-update";
  /** MUST reference an existing audit-finding id */
  findingId: string;
  to: UpdateTo;
  dispositionBy: DispositionBy;
  /** REQUIRED non-null for closed-residual (owner authority / pinned
   * policy clause); names the owning owner-act id for owner
   * dispositions */
  authority: string | null;
  /** REQUIRED non-null for accepted-fix when severity ≠ minor, and
   * ALWAYS for rejected-refuted (v11 R5-C5-3); the minor-owner
   * exception excuses the ABSENCE of a run only where the reference
   * is null (v12 R5-C6-4) — for an accepted-fix, a non-null
   * reference must pass ordinary green-run validation regardless of
   * owner reason; for a rejected-refuted, the referenced run must
   * satisfy NDR-s (`result:"not-reproduced"` against the pre-fix
   * baseline — never green/red) */
  reproRunRef: string | null;
  /** REQUIRED non-null findingId for rejected-duplicate AND superseded */
  supersedes: string | null;
  /** bounded single line, advisory; must EQUAL the owning
   * finding-disposition act payload's reason
   * (`disposition-reason-mismatch`) */
  reason: string | null;
}

/**
 * The minor-owner-exception predicate (§14.10.1 acceptance contract,
 * completed v12 R5-C6-4; consumer rule §14.12.2; NDR-b): PARTIAL
 * predicate — true means the transition is to "accepted-fix" AND the
 * three IN-RECORD exception conditions hold (severity minor,
 * dispositionBy "owner", reproRunRef === null). It is NOT a
 * biconditional for act-bound validity: the fourth exception
 * condition (the owner act's non-empty echoed matching reason) is
 * unobservable here and checked disposition-side, so a true result
 * does not by itself establish act-bound validity. The exception
 * excuses the ABSENCE of a run, never a bad one.
 */
export function isMinorOwnerExceptionAccept(
  findingSeverity: Severity,
  update: Pick<AuditFindingUpdate, "to" | "dispositionBy" | "reproRunRef">,
): boolean {
  return (
    update.to === "accepted-fix" &&
    findingSeverity === "minor" &&
    update.dispositionBy === "owner" &&
    update.reproRunRef === null
  );
}

/**
 * Conditional-field check for an update's REQUIRED-nullability
 * (intake-shape level only; transition legality is disposition.ts):
 *  - accepted-fix (severity ≠ minor) ⇒ reproRunRef non-null
 *  - rejected-refuted ⇒ reproRunRef non-null
 *  - closed-residual ⇒ authority non-null
 *  - rejected-duplicate / superseded ⇒ supersedes non-null
 */
export function isUpdateShapeValid(
  update: AuditFindingUpdate,
  findingSeverity: Severity,
): boolean {
  switch (update.to) {
    case "accepted-fix":
      return findingSeverity === "minor" || update.reproRunRef !== null;
    case "rejected-refuted":
      return update.reproRunRef !== null;
    case "closed-residual":
      return update.authority !== null;
    case "rejected-duplicate":
    case "superseded":
      return update.supersedes !== null;
  }
}

/* ================= §14.10.3 owner-act & closed op payloads ========== */

/**
 * `owner-act` — the durable provenance anchor every privileged record
 * binds (v6 c4-M11: the record stores the FULL canonical payload, not
 * a digest alone; validation replays the act, re-digests the payload,
 * refuses on ANY mismatch of op/digest/channel). `payloadDigest` is
 * `tre-canonical-json/1` domain-separated by
 * `"tre-owner-act/1\n" + op + "\n"`.
 */
export const OWNER_ACT_OPS_CLOSED_SET = Object.freeze([
  "finding-disposition",
  "audit-filing",
  "finding-hold",
  "finding-hold-lift",
  "norm-transition",
  "policy-revision",
  "scope-escape-resolution",
  "scope-escape-waiver",
  "remote-terminal-disposition",
  "history-integrity-disposition",
  "budget-extension",
  "spend-reconciliation",
  "elapsed-reconciliation",
  "dispatch-authorization-drop",
  "evidence-invalidation",
  "deferral-loop-disposition",
  "residual-cure",
  "residual-cure-cancel",
  "filing-drift-resolution",
  "filing-integrity-disposition",
] as const);
export type OwnerActOp = (typeof OWNER_ACT_OPS_CLOSED_SET)[number];

/** Channel classification (§14.10.3 R6: a tty path that is not a
 * character device makes the act invalid ⇒ nothing was authorized —
 * the classification predicate is `ttyCharacterDevice` in
 * `intake.ts`, step 2, because it touches the filesystem). */
export type OwnerActChannel = string;

/** G1-scope op payloads (closed schemas; omitted optional fields are
 * explicit null so absence is digest-visible). Ops outside G1 carry
 * their own contracts' payloads and are not re-typed here. */
export interface AuditFilingPayload {
  /** v14 R5-C8-7: intake re-hashes the SPOOL at
   * `drafts/sha256-<draftSha256>` — the live draft path is NEVER read */
  findingDraftRef: string;
  draftSha256: string;
  claim: string;
  cycle: number;
  /** explicit-NULL closed (v10 R5-C4-1) */
  taskId: string | null;
  /** explicit-NULL closed (v28 R5-C20P-2): the CLI copies the
   * confirmed header's cureActRef before the act append; intake
   * compares payload-to-header (`owner-filing-mapping` on mismatch) */
  cureActRef: string | null;
}

export interface FindingDispositionPayload {
  findingId: string;
  fromStatus: string;
  toStatus: UpdateTo;
  basisRef: string | null;
  reproRunRef: string | null;
  /** REQUIRED non-empty for an accepted-fix on a minor with
   * reproRunRef:null (the carve-out); advisory string or null
   * otherwise. The update record's reason must EQUAL it (≤1000 chars,
   * single line). */
  reason: string | null;
}

export interface FindingHoldPayload {
  findingId: string;
}

/** PHASE 1 cure commitment: the re-checkable pair (v26 R5-C18F-1) —
 * `digest` = sha256 of the exact `preimage` bytes; the preimage is
 * canonical single-line JSON, keys in the order shown. */
export interface CureCommitment {
  digest: string;
  preimage: string;
}

export interface CurePreimageAcceptedFix {
  route: "accepted-fix";
  reproDigest: string;
  expectedFixBaseline: string;
}

export interface CurePreimageFreshFindingCycle {
  route: "fresh-finding-cycle";
  claimDigest: string;
  /** resolved AT CONFIRMATION by deterministic rule: bind the
   * survivor's machine-checkable reproDigest if one exists, else null
   * (a null commits no digest and none may be invented,
   * v27 R5-C19-3) */
  reproDigestOrNull: string | null;
}

export type CurePreimage =
  | CurePreimageAcceptedFix
  | CurePreimageFreshFindingCycle;

/** The cure routes (payload.route — the NDR-u cure route, distinct
 * from the finding's routing `route`). */
export const CURE_ROUTE_CLOSED_SET = Object.freeze([
  "accepted-fix",
  "fresh-finding-cycle",
] as const);
export type CureRoute = (typeof CURE_ROUTE_CLOSED_SET)[number];

export interface ResidualCurePayload {
  findingId: string;
  /** names the SURVIVOR's owner-accepted residual disposition (refused
   * if never owner-accepted; a second unsettled cure on the same pair
   * refused — no forked cure) */
  survivorId: string;
  route: CureRoute;
  commitment: CureCommitment;
}

export interface ResidualCureCancelPayload {
  /** REQUIRED target CONFIRMED + UNSETTLED + not already cancelled;
   * refused `cure-already-settled` / `cure-unknown-act` /
   * `cure-already-cancelled` */
  cureActId: string;
}

export interface FilingDriftResolutionPayload {
  /** names ANY permanent-refused filing act (drift OR mapping OR any
   * exhaustive-rule intake refusal, v10 R5-C4-2 / v11 R5-C5-5;
   * renamed from driftedActId — DRAFT, no migration) */
  refusedActId: string;
  /** REQUIRED (v15 R5-C9-3): the LOG RECORD ID of the LIVE refusal
   * being resolved; dedup key is (refusedActId, refusalRecordId) */
  refusalRecordId: string;
  outcome: "refiled" | "withdrawn";
  /** refiled: REQUIRED a LATER audit-filing act with
   * effectApplied === true whose filed claim EQUALS the refused act's
   * payload claim — equality is the NDR-c rule (NFC-normalized decoded
   * JSON string values, never raw bytes of serialized payloads);
   * withdrawn: null (always admissible) */
  newActId: string | null;
}

export interface FilingIntegrityDispositionPayload {
  /** names the durable owner-filing-integrity-fault record */
  faultId: string;
  outcome: "refiled" | "withdrawn";
  /** refiled binds the equal-claim (and, for finding-named fault
   * kinds, severity/route-PRESERVING — v14 R5-C8-4 / v17 R5-C11-1
   * kind dependence) APPLIED later audit-filing act;
   * act-payload / readjudication-group kinds are withdrawn-ONLY */
  newActId: string | null;
}

/** Map a G1-scope op name to its closed payload type (type-level
 * closed set — an op outside the map belongs to another contract). */
export interface OwnerActPayloadMap {
  "finding-disposition": FindingDispositionPayload;
  "audit-filing": AuditFilingPayload;
  "finding-hold": FindingHoldPayload;
  "finding-hold-lift": FindingHoldPayload;
  "residual-cure": ResidualCurePayload;
  "residual-cure-cancel": ResidualCureCancelPayload;
  "filing-drift-resolution": FilingDriftResolutionPayload;
  "filing-integrity-disposition": FilingIntegrityDispositionPayload;
}
/** Ops whose payloads G1 does not type (other contracts; the op
 * names stay in the closed enum for validation). */
export type NonG1OwnerActOp = Exclude<OwnerActOp, keyof OwnerActPayloadMap>;

export interface OwnerAct<K extends OwnerActOp = OwnerActOp>
  extends Envelope {
  kind: "owner-act";
  op: K;
  /** FULL canonical payload bytes (v11 c9-B3: payload AND digest — a
   * digest-only act is unrecoverable exactly when recovery needs it
   * most); ≤16 KiB */
  payload: K extends keyof OwnerActPayloadMap ? OwnerActPayloadMap[K] : unknown;
  /** tre-canonical-json/1 over the payload, domain-separated
   * "tre-owner-act/1\n" + op + "\n" */
  payloadDigest: string;
  /** "tty:<dev>" — WHERE the confirmation was collected; the string
   * alone is never proof — validation re-digests the bound payload */
  channel: string;
  sessionRef: string | null;
  /** Effect binding (v10 c8-B1): ids of the authorized privileged
   * record(s) — exactly one id, or exactly the member ids of the
   * authorized atomic group. `effectApplied` is replay-DERIVED (true
   * iff every named record exists and validates against the act's op
   * schema), with the named exceptions: filing-class terminal-by-
   * refusal (v9 R4-C3-2 / v11 R5-C5-5 exhaustive) and the two-phase
   * residual-cure act (v26 R5-C18F-2 — effectRecordIds is the
   * SINGLETON of the derived settlement id `cure-settlement-<actId>`
   * before it exists). Derivation lives in `fold.ts` (step 3). */
  effectRecordIds: string[];
}

/* ================= §14.10.3 intake refusal / fault / disposition ==== */

/**
 * Closed diagnostic codes for permanent filing refusals
 * (v11 R5-C5-5 exhaustive terminal-by-refusal rule — EVERY intake
 * refusal of an audit-filing re-deriving on replay is
 * terminal-by-refusal, cleared ONLY by filing-drift-resolution;
 * `malformed-input` is the parse-or-schema class, §14.12.4 c4-M15).
 * G2 round-5 cycle-2 fold (terra G2-1): the set now carries the two
 * documented intake diagnostics it previously omitted —
 * `finding-intake-invalid` (non-minor finding without a falsifiable
 * repro, §14.10.1 docs/11:2580-2582 — the `repro` rule) and
 * `cure-unknown-act` (header `cureActRef` failing identity resolution
 * at intake, v28 R5-C20P-2 / R5-C20P-5 intake split, docs/11:
 * 3235-3250 — the `cureActRef` header-mapping prose).
 */
export const FILING_REFUSAL_CODE_CLOSED_SET = Object.freeze([
  "owner-filing-draft-drift",
  "owner-filing-mapping",
  "correction-bad-target",
  "correction-ambiguity",
  "correction-severity-decrease",
  "correction-route-mismatch",
  "finding-intake-invalid",
  "cure-unknown-act",
  "malformed-input",
] as const);
export type FilingRefusalCode =
  (typeof FILING_REFUSAL_CODE_CLOSED_SET)[number];

/** Check-class taxonomy (v15 R5-C9-2 draft-derivative consumes the
 * confirmed draft bytes and must embed them; v16 R5-C10-3 / NDR-f
 * FOURTH class MIXED — the MIXED diagnostics (four correction codes
 * + `cure-unknown-act`, NDR-f v34 D1(a)) read BOTH the bound
 * prefix AND the draft bytes, re-derived JOINTLY; prefix-only or
 * bytes-only validation is INCOMPLETE for this class). */
export const REFUSAL_CHECK_CLASS_CLOSED_SET = Object.freeze([
  "log-derivative",
  "filesystem-observation",
  "draft-derivative",
  "mixed",
] as const);
export type RefusalCheckClass =
  (typeof REFUSAL_CHECK_CLASS_CLOSED_SET)[number];

/** The MIXED class (NDR-f, v16 R5-C10-3; FIFTH member per owner
 * decision D1(a), v34 fold — `cure-unknown-act` joins: its header
 * operand `cureActRef` comes from the digest-verified draft bytes and
 * its check is identity resolution against the intake prefix (TA-1),
 * the joint prefix+bytes shape the class defines). Closed set of
 * exactly these five — no membership by any other rule. For the
 * correction codes: header operands (`correctionOf` target id,
 * proposed severity, proposed route) from the digest-verified
 * `adjudicatedDraftBytes`, the target's state/lineage from the bound
 * prefix, the code re-derives only from the combination. */
export const MIXED_CHECK_CODES: readonly FilingRefusalCode[] = Object.freeze([
  "correction-bad-target",
  "correction-ambiguity",
  "correction-severity-decrease",
  "correction-route-mismatch",
  "cure-unknown-act",
] as const);

/** True iff `code` is a MIXED-class diagnostic (NDR-f). */
export function isMixedCheckCode(code: string): code is FilingRefusalCode {
  return (MIXED_CHECK_CODES as readonly string[]).includes(code);
}

/**
 * NDR-f class rule (closed, TOTAL over the wire filing-refusal
 * diagnostics — all nine, no gaps as of the v34 D1(a) fold):
 * `mixed` ⟺ `MIXED_CHECK_CODES` (the four correction codes AND
 * `cure-unknown-act` — NDR-f closes this set at five; no membership
 * by any other rule);
 * `draft-derivative` ⟺ the mapping/schema conditions that read the
 * draft bytes (§14.10.3 (iii): header parse/enum/claim comparisons —
 * on the wire `owner-filing-mapping`, the parse-or-schema class
 * `malformed-input`, and the header/schema class
 * `finding-intake-invalid`; see the branch below); `filesystem-observation` ⟺ the drift code
 * (spool absent/mismatch evidenced by the record's own
 * `spoolObserved`/`observedSha256`). As of v16 NO filing-refusal code
 * is log-only (R5-C10-3: the LOG-DERIVATIVE class is retained for
 * record-only conditions, none of them intake refusal codes) — so
 * nothing in `FILING_REFUSAL_CODE_CLOSED_SET` classifies
 * `log-derivative`. A record carrying a `checkClass` this function
 * contradicts is self-contradictory ⇒ malformed (NDR-g).
 */
export function checkClassOfRefusalCode(
  code: string,
): RefusalCheckClass | null {
  // MIXED first (NDR-f v34 D1(a) fold): the four correction codes
  // AND `cure-unknown-act` — the latter's `cureActRef` operand comes
  // from the digest-verified draft bytes while its identity check is
  // resolution against the intake prefix (v28 R5-C20P-5 intake
  // split, TA-1): jointly prefix-AND-bytes, the MIXED shape
  // (G3 round-5 cycle-3 gap CLOSED by owner decision D1(a); was
  // returned UNCLASSIFIED awaiting this schema fold).
  if (isMixedCheckCode(code)) return "mixed";
  // §14.10.3 (iii): draft-derivative = "mapping/schema conditions
  // that read the draft bytes" — every code below adjudicates the
  // spooled bytes and MUST embed them (R5-C9-2). G2 round-5 cycle-2
  // fold (terra G2-1): `finding-intake-invalid` is a header/schema
  // failure of the spooled finding draft (severity/repro check over
  // header values, §14.10.1) — draft-derivative.
  if (
    code === "owner-filing-mapping" ||
    code === "malformed-input" ||
    code === "finding-intake-invalid"
  ) {
    return "draft-derivative";
  }
  if (code === "owner-filing-draft-drift") return "filesystem-observation";
  return null;
}

/** Totality pin (NDR-f/R5-C10-5, strict as of the v34 D1(a) fold —
 * the G3 named-gap exemption is RETIRED: every closed filing-refusal
 * code has a check class). */
export function allRefusalCodesClassified(): boolean {
  return FILING_REFUSAL_CODE_CLOSED_SET.every(
    (c) => checkClassOfRefusalCode(c) !== null,
  );
}

/** The draft-derivative CHECK FAMILY (v15 R5-C9-2: "header parse/
 * enum/claim-comparison" checks). These are DESCRIPTIONS of the
 * checks whose re-derivation consumes the draft bytes — NOT wire
 * diagnostic codes: the wire diagnostics of this class are
 * `owner-filing-mapping`, `malformed-input`, and
 * `finding-intake-invalid` (header/schema failure over the spooled
 * draft; G2 round-5 cycle-2 fold; see `checkClassOfRefusalCode`).
 * The `claim-mismatch` check's equality rule is NDR-c (NFC-normalized
 * decoded string values). Carried as a named family so
 * `adjudicate.ts` (step 6) can key its byte-consuming check list to
 * the R5-C9-2 wording; never appears in a record field. */
export const DRAFT_DERIVATIVE_CHECK_FAMILY = Object.freeze([
  "header-parse",
  "header-enum",
  "claim-mismatch",
] as const);
export type DraftDerivativeCheck =
  (typeof DRAFT_DERIVATIVE_CHECK_FAMILY)[number];

/** Filesystem-observation self-evidence (v15 R5-C8-2): a LATER spool
 * restoration NEVER converts an absence-refusal into a forgery. */
export type SpoolObserved = "absent" | "mismatch";

/**
 * `audit-filing-intake-refusal` record (supervisor-authored, §14.10.3
 * NDR-d/e): binds the exact prefix adjudicated
 * (`intakePrefixEndId` / `intakePrefixSha256`, v7 c7-B3 — replay
 * re-derives the diagnostic over the bound prefix BEFORE honoring; a
 * binding-less / non-re-deriving refusal fails closed to an
 * `intake-refusal` integrity fault). Draft-derivative refusals embed
 * `adjudicatedDraftBytes` (≤16 KiB) re-digesting to the act's
 * draftSha256.
 */
export interface AuditFilingIntakeRefusal extends Envelope {
  kind: "audit-filing-intake-refusal";
  /** the refused audit-filing act id */
  refusedActId: string;
  /** The diagnostic code (closed set above; the policy-class codes
   * journaled by intake are the NDR-t(2) lineage). Canonical name
   * `diagnosticCode` per NDR-k/§14.10.3 dot-references (docs/11:
   * 1947, 1962, 5106, 5191, 5213, 5231 — the register doctrine: canonical
   * NDR entries GOVERN over diverging text). The two divergent prose
   * sites (§14.11.4 intake protocol, §14.12.4 kind text) are RENAMED
   * to this canonical name per OWNER DECISION D3 (folded: docs/11
   * :6212/:7760 now read `diagnosticCode`; historical changelog rows
   * keep the old name — they are records). G5R-1 surfacing, round-5
   * cycle-5 terra audit; D3 fold. */
  diagnosticCode: string;
  checkClass: RefusalCheckClass;
  /** prefix binding pair (permanent refusals bind the exact prefix
   * adjudicated; the intake-refusal fault check resolves THIS record:
   * refusedActId == fault.actId) */
  intakePrefixEndId: string;
  intakePrefixSha256: string;
  /** filesystem-observation class: self-contained evidence fields */
  spoolObserved: SpoolObserved | null;
  observedSha256: string | null;
  /** draft-derivative OR MIXED class: REQUIRED the exact bytes
   * adjudicated (≤16 KiB), re-digesting to the act's draftSha256
   * (v15 R5-C9-2 / v16 R5-C10-3 NDR-f — a MIXED refusal without
   * valid embedded bytes is malformed → integrity fault, exactly as
   * for draft-derivative); null only for the other classes */
  adjudicatedDraftBytes: string | null;
}

/**
 * `owner-filing-integrity-fault` record (supervisor-authored, class
 * O): one undispositioned record per IDENTITY. Identity: DAMAGE kinds
 * `(actId, failingCheck)` for all time (v15 R5-C7-5);
 * `intake-refusal` is EVENTFUL `(actId, failingCheck,
 * refusalRecordId)` (v16 R5-C8-2).
 */
export const FAILING_CHECK_CLOSED_SET = Object.freeze([
  "effect-record",
  "findingRef-artifact",
  "act-payload",
  "readjudication-group",
  "intake-refusal",
] as const);
export type FailingCheck = (typeof FAILING_CHECK_CLOSED_SET)[number];

/** The DAMAGE kinds (refusalRecordId REQUIRED null; class-B exclusion
 * keys on record EXISTENCE for these kinds —
 * disposition-independent, v15 R5-C8-1). */
export const DAMAGE_FAILING_CHECKS: readonly FailingCheck[] = Object.freeze([
  "effect-record",
  "findingRef-artifact",
  "act-payload",
  "readjudication-group",
] as const);

/** Kinds whose `refiled` disposition outcome is INEXPRESSIBLE
 * (withdrawn-only): a corrupt payload establishes no
 * claim/severity/route (v15 R5-C8-5), a corrupted candidate group
 * establishes no result to replace (v17 R5-C11-3). */
export const WITHDRAWN_ONLY_FAILING_CHECKS: readonly FailingCheck[] = Object.freeze([
  "act-payload",
  "readjudication-group",
] as const);

export interface OwnerFilingIntegrityFault extends Envelope {
  kind: "owner-filing-integrity-fault";
  /** advisory fault time (faultTs names the observation; envelope ts
   * is the append instant) */
  faultTs: number;
  /** the faulted audit-filing act id */
  actId: string;
  failingCheck: FailingCheck;
  /** REQUIRED non-null for intake-refusal (resolves in-log to an
   * audit-filing-intake-refusal whose refusedActId == actId AND which
   * appears among evidenceRefs — any clause failed ⇒ malformed,
   * never minted); REQUIRED null for the DAMAGE kinds
   * (v15 R5-C9-4) */
  refusalRecordId: string | null;
  evidenceRefs: string[];
}

/** The v15 R5-C9-4 refusalRecordId nullability rule, isolated. */
export function isFaultRecordNullabilityValid(
  f: Pick<OwnerFilingIntegrityFault, "failingCheck" | "refusalRecordId">,
): boolean {
  return f.failingCheck === "intake-refusal"
    ? f.refusalRecordId !== null
    : f.refusalRecordId === null;
}

/**
 * Durable `filing-integrity-disposition` RECORD (the disposition the
 * owner-act authorizes; supervisor-stamped). A `withdrawn`
 * disposition of an intake-refusal fault carries the re-adjudication
 * prefix binding (v15 R5-C9-5 / v16 R5-C10-1: P(W) = predecessor id +
 * running digest at the disposition append; the record NEVER contains
 * its own digest).
 */
export interface FilingIntegrityDispositionRecord extends Envelope {
  kind: "filing-integrity-disposition";
  faultId: string;
  outcome: "refiled" | "withdrawn";
  /** the authorizing owner-act record id */
  actId: string;
  /** REQUIRED null unless the fault's failingCheck is
   * "intake-refusal" AND outcome "withdrawn"; names the refusal
   * record the re-adjudication P(W) binding is over */
  refusalRecordId: string | null;
  /** the P(W) prefix binding (predecessor id + running digest at the
   * disposition append), non-null exactly with refusalRecordId.
   * Wire field names per NDR-i / §14.10.3 (`readjudicationPrefix*`,
   * v15 R5-C9-5). */
  readjudicationPrefixEndId: string | null;
  readjudicationPrefixSha256: string | null;
}

/** nullability: refusal binding present iff intake-refusal + withdrawn */
export function isDispositionRecordRefusalBindingValid(
  d: Pick<
    FilingIntegrityDispositionRecord,
    "outcome" | "refusalRecordId" | "readjudicationPrefixEndId" | "readjudicationPrefixSha256"
  >,
  faultFailingCheck: FailingCheck,
): boolean {
  const wants = faultFailingCheck === "intake-refusal" && d.outcome === "withdrawn";
  const has =
    d.refusalRecordId !== null &&
    d.readjudicationPrefixEndId !== null &&
    d.readjudicationPrefixSha256 !== null;
  return wants === has && (has || (d.refusalRecordId === null && d.readjudicationPrefixEndId === null && d.readjudicationPrefixSha256 === null));
}

/* ================= §14.10.3 fault records (supervisor-authored) ===== */

// G1 REVIEW ROUND 5 cycle-1 fold (terra G1-6): the `FindingFault`
// interface and its asserted `FAULT_CODE_CLOSED_SET` wire enum are
// REMOVED — `finding-fault` appears nowhere in docs/11 (the schema's
// fault records are `owner-filing-integrity-fault` with the NDR-h
// five-value `failingCheck` — see `OwnerFilingIntegrityFault` above —
// plus the §14.12.3 history-integrity fault kinds), and an invented
// record kind with an invented closed vocabulary silently CHANGES the
// wire contract. There is no generic ledger "Fault" envelope kind;
// fault CODES are carried in the NDR-q canonical condition list
// (below), whose entries are seeded only from codes documented in
// §14.10/§14.12.2 — the registration interface is the extension
// seam, not a wire enum.

/* ================= §14.12.4b repro run & hold ====================== */

/**
 * `result` — the NDR-s THREE-value closed enum (§14.12.4 v25
 * R5-C18-2; the semantics are OWNED by NDR-s, §14.12.2's
 * result-semantics site is a citation): `green` = the repro executed
 * and the post-fix expectation held; `red` = executed, the defect
 * reproduced (post-fix expectation failed); `not-reproduced` =
 * executed on a tree where the defect did NOT reproduce — the
 * refutation-grade result (NDR-s: valid refutation evidence ONLY on
 * a pre-fix baseline, owner-grade). A run that did not complete
 * (crash/timeout/harness error/environment mismatch) is NO RECORD
 * and no evidence of anything (NDR-s) — there is deliberately NO
 * blocked/error value; the v28 example's stale two-value comment
 * would refuse every refutation run (v28 R5-C20F-3).
 */
export const REPRO_RESULT_CLOSED_SET = Object.freeze([
  "green",
  "red",
  "not-reproduced",
] as const);
export type ReproRunResult = (typeof REPRO_RESULT_CLOSED_SET)[number];

/** `runner` — WHO executed the run (§14.12.4; supervisor-authored
 * records only — the record's authority is the supervisor, the
 * runner field says which execution lane produced the result). */
export const REPRO_RUNNER_CLOSED_SET = Object.freeze(["trusted-gate", "supervisor"] as const);
export type ReproRunner = (typeof REPRO_RUNNER_CLOSED_SET)[number];

/** Green-set membership (NDR-s): ONLY `result === "green"` counts;
 * `red` and `not-reproduced` are both non-green (refutation evidence
 * is graded `not-reproduced`, never green). */
export function isGreenOutcome(r: ReproRunResult): boolean {
  return r === "green";
}

/**
 * `repro-run` record (§14.12.4, v5 c3 / v28 R5-C20-2/-F3): the
 * machine-checkable evidence an accepted-fix must reference
 * (14.12.2 rule 4) — with the sole NDR-b minor owner exception
 * (severity minor + owner act + echoed reason + null `reproRunRef`)
 * excusing the absence of any run (v12 R5-C6-4), supervisor-authored
 * ONLY. A run that did not complete is NO RECORD (NDR-s). Field list
 * is the canonical one:
 * the run names its DEFINITION by `findingId`; `reproDigest` must
 * equal `reproDigest(F)` of THAT finding for every run naming a
 * finding with a non-`none` repro (NDR-u para (3), v29 R5-C21-8 —
 * one operation, every site).
 */
export interface ReproRun extends Envelope {
  kind: "repro-run";
  /** the finding whose repro definition this run executed */
  findingId: string;
  /** == the finding's repro-definition digest, `reproDigest(F)`
   * (sha256 over the `tre-canonical-json/1` bytes of the finding's
   * `repro` object, NDR-u para (3)); a run whose digest does not
   * re-derive to its finding's definition is not green evidence */
  reproDigest: string;
  /** the tested tree/candidate (git sha) the run actually executed
   * against (§14.12.2 r4 artifact binding: accepted-fix requires it
   * equal the accepted candidate's sha or a proven ancestor; NDR-s
   * refutation requires it equal the PRE-FIX baseline) */
  executedArtifactDigest: string;
  runner: ReproRunner;
  result: ReproRunResult;
  /** gate log / command record; supervisor-authored only. For a run
   * dispatched under a cure-gate the gate's `nonce` MUST appear
   * verbatim in the DURABLE CONTENT NAMED BY this reference (the
   * predicate `cureGateOk`, R5-C20F-2: gate nonce substring-of the
   * durable evidence content named by runEvidenceRef — not of the
   * reference string itself) */
  runEvidenceRef: string;
  /** v28 R5-C20-2, split v28 R5-C20F-3: REQUIRED non-null iff the
   * run was DISPATCHED UNDER a cure-gate (names its `cure-gate` id;
   * APPEND-DECIDABLE at write time — the producer knows whether a
   * gate dispatch happened); null otherwise. Whether the run is cure
   * EVIDENCE is a CONSUMER judgment (NDR-u para (3) conjunct (b3) +
   * the settlement check — incl. that the gate's `cureActId` equals
   * the `cureActId` of the `residual-cure-settlement` citing this
   * run), never a producer judgment. */
  cureGateId: string | null;
}

/* G1 REVIEW ROUND 5 cycle-1 fold (terra G1-8): the former `isHeldBy`
 * helper is REMOVED — computing hold/lift lifecycle order is G3
 * behavior (g1-implementation-mapping row q: step 1 ships the hold
 * wire shapes + intake vocab only; "the sign-off-counting semantics
 * and the finding-hold-lift CLOSER transition land with G3"). A
 * wire-only module must not decide the last-act-wins rule. */

/* ================= §14.12.4 finding-hold / -lift ==================== */

/**
 * `finding-hold` / `finding-hold-lift` records (§14.12.4; the NDR-q
 * hold row — a hold keeps the finding OPEN (it is NOT a disposition),
 * a held minor counts as a sign-off holder for §14.12.2 rule 3 until
 * the owner lifts it). SUPERVISOR-STAMPED from the owner's
 * `finding-hold`/`finding-hold-lift` ACT (payload `{findingId}`):
 * `dispositionBy`/`authority` are supervisor-stamped, NOT act-bound —
 * the act binds the finding it escalates, the record carries the
 * resulting owner disposition stamp + authority (v9 c7-B1: without
 * these ops a TTY hold confirmation would be refused by the
 * closed-schema rule itself).
 *
 * G1 WIRE DEPENDENCY (g1-implementation-mapping row q, c5 MAJOR fix):
 * the shapes + intake vocab ship in step 1 so the NDR-q row's closer
 * ref resolves; the sign-off-counting semantics and the lift CLOSER
 * TRANSITION land with G3 (row marked `closer: G3`). The G1 emitter
 * is real: `fold.ts` registers the hold condition from a conforming
 * `finding-hold` record against the canonical condition list.
 */
export interface FindingHoldRecord extends Envelope {
  kind: "finding-hold";
  /** the held finding (§14.12.4) */
  findingId: string;
  /** §14.12.4 fixes the stamp: an owner escalation is NEVER
   * "orchestrator" — the closed literal is "owner" */
  dispositionBy: "owner";
  /** REQUIRED non-null — the owner authority (§14.12.4 authority
   * REQUIRED, e.g. "tty:…") */
  authority: string;
}

export interface FindingHoldLiftRecord extends Envelope {
  kind: "finding-hold-lift";
  /** the lifted finding — hold stops counting as sign-off holder */
  findingId: string;
  /** supervisor-stamped, as `finding-hold` (closed literal "owner") */
  dispositionBy: "owner";
  /** REQUIRED non-null — the owner authority */
  authority: string;
}

/* ================= §14.10.3 / §14.12.4b cure-gate & settlement ===== */

/**
 * `cure-gate` record (§14.10.3 v28 R5-C20-2; §14.12.4b inventory row
 * v28 R5-C20F-1): the pre-execution gate appended by the SUPERVISOR
 * after the `residual-cure` act's confirmation record and only ever
 * after it (normally IMMEDIATELY after as a SEPARATE append — the
 * pair is append-then-dispatch, D1=A; in the owed-completion case
 * R5-C20F-4 it is appended at recovery time, still after the act,
 * never before, never for a cancelled OR settled act —
 * R5-C20P-6 / v29 R5-C21-1). Replay-checked ordering: O1 every gate
 * follows its act; O2 IF a gated run exists its gate precedes that
 * run (an unused gate is valid history, v29 R5-C21-9, valid only
 * when it passes ALL applicable checks O1+O3+one-per-act, v33 C3-2);
 * O3 a gate for an act extinguished BEFORE it by a terminal record
 * (cancel/settlement for the same act) is refused (v33 C2-1). ONE
 * gate per cure act — a second gate for the same act is refused
 * (R5-C20F-4). The nonce is minted by the SUPERVISOR (fresh 32
 * random bytes, hex; TA-2: the runner's obligation is the honest
 * echo of it into the run evidence, never the mint), durable ONLY in
 * this record (lost gate record ⇒ runs citing it are refused,
 * R5-C20F-2). Shape + nonce/recovery rules are OWNED by §14.10.3.
 */
export interface CureGate extends Envelope {
  kind: "cure-gate";
  /** the owning `residual-cure` owner-act record id */
  cureActId: string;
  /** 32 random bytes, lowercase hex — supervisor-minted (TA-2); the
   * durable gate predicate (`cureGateOk`) is: gate nonce verbatim
   * substring of the durable evidence CONTENT NAMED BY the gated
   * run's `runEvidenceRef` (not of the reference string itself) */
  nonce: string;
}

/** The gate nonce wire shape (64 lowercase hex chars = 32 bytes). */
export function isCureGateNonce(v: string): boolean {
  return isHex64(v);
}

/**
 * `CureGateProtocolIfc` — the cure-gate protocol SEAM (G2 round-5
 * cycle-2 fold, terra G2-6; g1-implementation-mapping step-1 row /
 * step-7 seam note c3 m2, same pattern as `FaultsIfc`): step 1 ships
 * the gate/settlement/cancel RECORD TYPES plus this interface, step
 * 7 (`recovery.ts`) tests the D1=A complete-the-pair protocol
 * against FAKES of it, and step 8 (`cure.ts`) lands the real
 * protocol behind the same shape (the step-7/8 differential test
 * lands in step 8). DECLARATIONS ONLY — no policy is decided here;
 * the normative protocol body is §14.10.3 (per NDR-u, recovery
 * direction D1=A per TA-5).
 */
export interface CureGateProtocolIfc {
  /** Whether a confirmed `residual-cure` act is in the crash-window
   * state whose `cure-gate` is still OWED (act confirmed, no gate
   * yet, act not cancelled and not settled — §14.10.3 owed-
   * completion, R5-C20F-4 / R5-C20P-6 / v29 R5-C21-1). */
  owesGate(cureActId: string): boolean;
  /** D1=A complete-the-pair: append the owed gate for the act
   * (after the act, never before; refused for a cancelled or
   * settled act; one gate per act forever). */
  completePair(cureActId: string): CureGate;
}

/**
 * `ancestryWitness` — the ONE closed shape (v28 R5-C20-3, defined
 * once at §14.10.3, mirrored in the §14.12.4b inventory by reference
 * only): the settlement's durable b1 git-ancestry witness. Produced
 * by the supervisor AT settlement-append by walking the pinned gated
 * lineage ONCE (ancestor-of-connected from `expectedFixBaseline`,
 * ≠ baseline; missing/pruned/unverifiable closure FAILS CLOSED — no
 * settlement). Replay CONSUMES this field and NEVER re-walks git
 * (NDR-u para (3), §14.12.2 chain rule).
 */
export const ANCESTRY_WITNESS_RESULT_CLOSED_SET =
  Object.freeze(["ancestor-proper"] as const);
export type AncestryWitnessResult =
  (typeof ANCESTRY_WITNESS_RESULT_CLOSED_SET)[number];

export interface AncestryWitness {
  /** the gated candidate artifact the walk started from */
  executedArtifactDigest: string;
  /** the cure commitment's expected pre-fix baseline */
  expectedFixBaseline: string;
  /** closed single-value result: a failed walk produces NO
   * settlement record (fail closed), so the only value a durable
   * witness ever carries is `ancestor-proper` */
  result: AncestryWitnessResult;
}

/**
 * `residual-cure-settlement` record (§14.12.4b v25 cycle-18;
 * producer: the supervisor NEVER the owner directly — phase 2 of the
 * NDR-u two-phase protocol). `id` is the DETERMINISTIC
 * `cure-settlement-<cureActId>` (v26 R5-C18F-2): the id-collision
 * refusal IS the one-settlement-per-act guarantee. `route` is copied
 * VERBATIM from the cure act (a settlement whose route differs from
 * its act's is malformed, refused); `evidenceRef` names the green
 * `repro-run` record (accepted-fix) or the filed finding
 * (fresh-finding-cycle) passing the §14.10.3 single evidence check
 * against the act's commitment PREIMAGE (v26 R5-C18F-1).
 * `ancestryWitness` is REQUIRED non-null for `accepted-fix` and null
 * for `fresh-finding-cycle` (v28 R5-C20-3 / v29 R5-C21-6). A
 * settlement for a CANCELLED cure act is refused (the vacated
 * settlement id may never be filled, NDR-u para 4). Replayed as the
 * sole clearing evidence of the residual-inherited uncleanliness
 * forward of its append position.
 */
export interface ResidualCureSettlement extends Envelope {
  kind: "residual-cure-settlement";
  /** the owning `residual-cure` owner-act record id */
  cureActId: string;
  route: CureRoute;
  /** green repro-run record id (accepted-fix) or filed finding id
   * (fresh-finding-cycle) — the single evidence check operand */
  evidenceRef: string;
  /** REQUIRED non-null for accepted-fix, null for
   * fresh-finding-cycle (v28 R5-C20-3) */
  ancestryWitness: AncestryWitness | null;
}

/** The deterministic settlement id (v26 R5-C18F-2): pure, total —
 * minting it is not a policy decision, it is the wire identity rule
 * (`cure-settlement-<cureActId>`). */
export function cureSettlementId(cureActId: string): string {
  return `cure-settlement-${cureActId}`;
}

/** Witness nullability by route (v28 R5-C20-3), isolated. */
export function isSettlementWitnessValid(
  s: Pick<ResidualCureSettlement, "route" | "ancestryWitness">,
): boolean {
  return s.route === "accepted-fix"
    ? s.ancestryWitness !== null
    : s.ancestryWitness === null;
}

/* ============ §14.10.3 re-adjudication outcome (NDR-i/e) =========== */

/**
 * `bytesSource` — the CANONICAL byte-provenance labels (NDR-e,
 * v19 R5-C13-3: `"embedded-R1"` DELETED — physical source is
 * unobservable from durable records; the label is a content-only
 * function, one label per content state): `"content-addressed"`
 * exactly when the consumed bytes re-digest to the act's
 * `draftSha256`; `"fresh-spool"` is a RESERVED label with no current
 * domain (the validator NEVER fabricates it); `"none"` only for
 * FILESYSTEM-OBSERVATION (drift) refusals where no draft bytes exist
 * to consume.
 */
export const BYTES_SOURCE_CLOSED_SET = Object.freeze([
  "content-addressed",
  "fresh-spool",
  "none",
] as const);
export type BytesSource = (typeof BYTES_SOURCE_CLOSED_SET)[number];

/** `pinnedVerdict` — the P(W) adjudication's own verdict recorded
 * separately from the landed outcome (v18 R5-C12-4): `"eligible"` =
 * the pinned-prefix verdict found the effect appendable (the
 * legality gate then decided the landing); `"refused"` = the pinned
 * verdict itself refused (the landed refusal derives from P(W) and
 * binds P(W) per the pinned class of the NDR-d two-class exception). */
export const PINNED_VERDICT_CLOSED_SET = Object.freeze(["eligible", "refused"] as const);
export type PinnedVerdict = (typeof PINNED_VERDICT_CLOSED_SET)[number];

/**
 * `audit-filing-readjudication-outcome` record (supervisor-authored,
 * §14.10.3 v15 R5-C9-5 serialized adjudication protocol, extended v16
 * R5-C10-6 / v17 R5-C11-4 / v18 R5-C12-4 / v19 R5-C13-3 / v20
 * R5-C14-4): appended LAST in the W→effect→outcome critical section
 * (NDR-i append order). `withdrawalDispositionId` is the durable 1:1
 * identity — exactly ONE outcome per withdrawal, a second is
 * malformed, never appended. Shape guards are pure wire predicates
 * below; the deterministic re-derivation of the labels from durable
 * records (the NDR-e expansion algorithm) and the recovery duty
 * (NDR-k) live in `adjudicate.ts` / `recovery.ts`, not here.
 */
export interface FilingReadjudicationOutcome extends Envelope {
  kind: "audit-filing-readjudication-outcome";
  /** the withdrawal disposition record this outcome belongs to
   * (durable 1:1 identity) */
  withdrawalDispositionId: string;
  outcome: "applied" | "refused";
  /** outcome "applied": REQUIRED non-null — the log record id of the
   * finding the adjudication minted (resolves in-log to an
   * `audit-finding` whose originating act is the fault's act,
   * same critical section); "refused": MUST be null (v16 R5-C10-6) */
  findingId: string | null;
  /** outcome "refused": REQUIRED non-null — resolves in-log to an
   * intake-refusal of act A (`refusedActId == A`), appended in the
   * same critical section, bound per NDR-d; "applied": MUST be null */
  refusalRecordId: string | null;
  /** REQUIRED (v17 R5-C11-4 / v19 R5-C13-3 canonical labels) */
  bytesSource: BytesSource;
  /** non-null EXACTLY when `bytesSource === "fresh-spool"` (NDR-e) */
  observedSha256: string | null;
  /** REQUIRED (v18 R5-C12-4) */
  pinnedVerdict: PinnedVerdict;
  /** REQUIRED null when pinnedVerdict "eligible"; REQUIRED non-null
   * (the P(W)-derived refusal diagnostic code) when "refused". An
   * APPEND-LEGALITY-GATE refusal (NDR-j) is NOT this branch: the gate
   * outcome records `pinnedVerdict:"eligible"` + `pinnedVerdictCode:
   * null` with `outcome:"refused"` — the collision diagnostic is
   * ordinary, not pinned */
  pinnedVerdictCode: string | null;
}

/** Outcome-dependence nullability (v16 R5-C10-6): applied ⇒
 * findingId non-null + refusalRecordId null; refused ⇒
 * refusalRecordId non-null + findingId null. */
export function isOutcomeDependencyValid(
  o: Pick<FilingReadjudicationOutcome, "outcome" | "findingId" | "refusalRecordId">,
): boolean {
  return o.outcome === "applied"
    ? o.findingId !== null && o.refusalRecordId === null
    : o.refusalRecordId !== null && o.findingId === null;
}

/** Byte-provenance nullability (NDR-e): `observedSha256` is non-null
 * EXACTLY when `bytesSource === "fresh-spool"`. */
export function isBytesProvenanceValid(
  o: Pick<FilingReadjudicationOutcome, "bytesSource" | "observedSha256">,
): boolean {
  return o.bytesSource === "fresh-spool"
    ? o.observedSha256 !== null
    : o.observedSha256 === null;
}

/** Pinned-verdict code nullability (v18 R5-C12-4): REQUIRED null on
 * "eligible", REQUIRED non-null on "refused". */
export function isPinnedVerdictValid(
  o: Pick<FilingReadjudicationOutcome, "pinnedVerdict" | "pinnedVerdictCode">,
): boolean {
  return o.pinnedVerdict === "eligible"
    ? o.pinnedVerdictCode === null
    : o.pinnedVerdictCode !== null;
}

/** Outcome × pinned-verdict combination guard (v18 R5-C12-4 replay
 * binding clause (3)): `applied` ⇒ `pinnedVerdict:"eligible"` +
 * null code — a pinned refusal cannot mint an effect. (The
 * refused-side clauses (1)/(2) consume R2's binding class —
 * replay-derived per NDR-d in `adjudicate.ts`, not an
 * envelope-local predicate.) */
export function isOutcomePinnedCombinationValid(
  o: Pick<
    FilingReadjudicationOutcome,
    "outcome" | "pinnedVerdict" | "pinnedVerdictCode"
  >,
): boolean {
  if (o.outcome !== "applied") return true;
  return o.pinnedVerdict === "eligible" && o.pinnedVerdictCode === null;
}

/* ================= NDR-v effect-binding exceptions ================= */

/**
 * NDR-v — the CLOSED set of effect-binding exceptions: an act may
 * legally hold `effectApplied:false` without being class B ONLY in
 * one of the named members (a consumer classifying an exception act
 * as class B from its own text is a DEFECT; every caller site —
 * `fold.ts#effectException`, `queue.ts` P3 / drain-excuse /
 * quiesce-stall — carries its own exclusion clause citing NDR-v, one
 * prefix one classification):
 *  1. `permanent-refusal-filing` — a filing-class act whose intake
 *     appended a PERMANENT refusal (NDR-d/NDR-l: the refusal IS the
 *     effect appended, terminal-by-refusal; its unresolved refusal
 *     CONDITION is the class-O item, NDR-m/NDR-o);
 *  2. `unsettled-residual-cure` — a confirmed, UNSETTLED,
 *     UN-cancelled `residual-cure` act (NDR-u: the derived effect id
 *     `cure-settlement-<cureActId>` is absent until evidence
 *     arrival; neither `effectApplied:true` nor class B nor a
 *     quiescence item nor a quiesce-stall candidate; the owed
 *     cure-gate completion in the crash window shares its parent
 *     act's classification and is NEVER ITSELF a B item,
 *     quiescence item, or stall candidate — recovery-pass work, not
 *     drain work, v29 G1-V29-C6-1).
 * The set is disjoint from the integrity-fault exclusion
 * (terminal-by-damage, NDR-h/NDR-l) and from
 * terminal-by-cancellation (NDR-l, via NDR-u).
 */
export const EFFECT_BINDING_EXCEPTION_CLOSED_SET = Object.freeze([
  "permanent-refusal-filing",
  "unsettled-residual-cure",
] as const);
export type EffectBindingException =
  (typeof EFFECT_BINDING_EXCEPTION_CLOSED_SET)[number];

/* ================= NDR-q canonical condition list ================== */

/**
 * The canonical condition list (NDR-q): the ONE ordered list both the
 * ledger (intake/fold refusals) and the faults module (fault-kind →
 * class) consume, so ledger and faults can never diverge on a code
 * (NDR-q's stated point). Registration is additive and ordered:
 * `registerCondition` refuses duplicate codes (a code registers
 * exactly once) and the list's ORDER is the canonical order —
 * consumers iterate `conditions()` and must not re-sort.
 *
 * The `FaultClass` typing here is LOCAL (a string-union mirror): the
 * real class logic is `faults.ts` step 5 behind `FaultsIfc`; the
 * condition entry carries the class as data so the ledger can answer
 * class questions without importing faults.
 *
 * The three members are the §14.12.2 finalization classes (v10 c8-B2
 * precedence table): A = met/disposed (contributes clean), B =
 * drain-progressing (the boundary append holds; the supervisor can
 * still resolve), O = owner-only (boundary appends UNCLEAN +
 * needs-owner). G1 REVIEW ROUND 5 cycle-1 fold (terra G1-5): the
 * former "A refusal / B integrity / C advisory" reading was NOT the
 * schema's classification — an unresolved permanent filing refusal
 * and an undispositioned integrity fault are class-O conditions
 * (§14.12.2 O row), and no condition in the NDR-q list is advisory.
 */
export type FaultClass = "A" | "B" | "O";

export interface CanonicalCondition {
  /** the machine code — unique across the list */
  code: string;
  /** one-line diagnostic text (bounded, single line) */
  text: string;
  /** finalization class (§14.12.2): A met/disposed, B drain-
   * progressing (append holds), O owner-only (UNCLEAN + needs-owner) */
  faultClass: FaultClass;
  /** the §14.x reference that introduced it */
  ref: string;
}

const CANONICAL_CONDITIONS: CanonicalCondition[] = [];

/**
 * Register a condition in the canonical list (NDR-q registration
 * interface; exported here, before its consumers, per
 * g1-implementation-mapping step 1 row q). Throws on a duplicate
 * code — registration is exactly-once; returns the frozen entry.
 */
export function registerCondition(c: CanonicalCondition): CanonicalCondition {
  // Round-6 audit F1 fold: read `code` ONCE (a getter on the input
  // object could otherwise answer the duplicate check with a fresh
  // code and the stored spread with a registered one — snapshot first,
  // check the snapshot, store the snapshot).
  const entry: CanonicalCondition = {
    code: c.code,
    text: c.text,
    faultClass: c.faultClass,
    ref: c.ref,
  };
  if (CANONICAL_CONDITIONS.some((x) => x.code === entry.code)) {
    throw new Error(`canonical condition code already registered: ${entry.code}`);
  }
  const frozen = Object.freeze(entry);
  CANONICAL_CONDITIONS.push(frozen);
  return frozen;
}

/** Iterate the canonical condition list in registration order.
 * G1 step-1 round-6 fold (audit F1): returns a DEFENSIVE FROZEN
 * SNAPSHOT (shallow copy + `Object.freeze`), not the backing array —
 * the `readonly` return type is compile-time only, and returning the
 * array itself let a JS caller (or a cast) clear/reorder/append
 * entries past the duplicate-code check. The entries themselves are
 * individually frozen at registration; the snapshot keeps a stable
 * order and length per call site. Copy cost is O(list) per call —
 * the list is bounded (schema conditions + step-3+ registrations),
 * so this is fine at ledger cadence. */
export function conditions(): readonly CanonicalCondition[] {
  return Object.freeze(CANONICAL_CONDITIONS.slice());
}

/** Look up one condition by code (null when unregistered). */
export function conditionByCode(code: string): CanonicalCondition | null {
  return CANONICAL_CONDITIONS.find((c) => c.code === code) ?? null;
}

// Seed the canonical list from the documented condition sites —
// the NDR-q closing inventory (§14.10.0) and the §14.12.2 B/O rows.
// G1 REVIEW ROUND 5 cycle-1 fold (terra G1-5): the seeds are now
// ONLY conditions the schema names (the former loop over the
// removed invented FAULT_CODE_CLOSED_SET is gone), permanent filing
// refusals carry class O per the §14.12.2 O row ("ANY permanent
// intake refusal of an `audit-filing`" v11 R5-C5-5), and the
// NDR-q rows `quiesce-stall` and `finding-hold` are seeded (both
// were missing). Consumers (fold.ts / queue.ts, steps 3+) register
// their emitted conditions AGAINST this list (totality test, step 9).
for (const code of FILING_REFUSAL_CODE_CLOSED_SET) {
  registerCondition({
    code: `refused:${code}`,
    text: `permanent filing intake refusal (${code}) — terminal-by-refusal, cleared only by filing-drift-resolution (per NDR-l/NDR-o)`,
    faultClass: "O",
    ref: "§14.12.2 O row",
  });
}
registerCondition({
  code: "integrity-fault-open",
  text: "undispositioned owner-filing-integrity-fault (any NDR-h failingCheck kind) — the OPEN condition is the owed-owner item (per NDR-m), cleared by filing-integrity-disposition",
  faultClass: "O",
  ref: "§14.12.2 O row / NDR-q",
});
registerCondition({
  code: "chain-unclean-retired",
  text:
    "r4 chain UNCLEAN — survivor owner-retired-by-withdrawal; each member's OWN route: OPEN member -> this table's ordinary disposition rows, ALREADY-CLOSED member -> owner closed-residual strand citation (NDR-p edge (2) strand (a); §14.12.2 withdrawn-survivor row)",
  faultClass: "O",
  ref: "NDR-q inventory / §14.12.2 withdrawn-survivor row",
});
registerCondition({
  code: "chain-unclean-link-uncheckable",
  text: "r4 chain UNCLEAN — owner-authorized member link fails machine-check (vector (d)); minor: owner minor-exception accepted-fix, non-minor: closed-residual (NDR-p edge (2)(b))",
  faultClass: "O",
  ref: "NDR-q inventory",
});
registerCondition({
  code: "residual-inherited",
  text: "residual-inherited chain member — round unclean until the NDR-u two-phase cure settles (forward-only)",
  faultClass: "O",
  ref: "NDR-q inventory / NDR-u",
});
registerCondition({
  code: "cure-locked-pair",
  text: "confirmed cure whose commitment can never be satisfied — owner residual-cure-cancel re-eligibilizes the pair (NDR-u (4))",
  faultClass: "O",
  ref: "NDR-q inventory (v27 R5-C19-5)",
});
registerCondition({
  code: "quiesce-stall",
  text: "drain stalled past quiesceWaitMaxMs — durable quiesce-stall needs-owner record; closes when the stalled condition drains (no act)",
  faultClass: "O",
  ref: "NDR-q / §14.12.2 B row (conversion rule)",
});
registerCondition({
  code: "finding-hold",
  text: "active finding-hold — held finding counts as sign-off holder until the owner finding-hold-lift record (closer: G3)",
  faultClass: "O",
  ref: "NDR-q hold row / §14.12.2 O row",
});
registerCondition({
  code: "correction-lineage-cycle",
  text: "correction/duplicate edge fold reaches a cycle (NDR-n step-4 case / visit-once repeat, v25 R5-C18-4) — NO effective tip, chain UNCLEAN + needs-owner naming the lineage. NOTE (G2 round-5 cycle-2 fold, terra G2-2): the §14.10 schema names this needs-owner condition but the NDR-q closing inventory carries NO row for it (no closing act documented) — an unlisted reachable hold is itself a contract defect per NDR-q's closing sentence; surfaced here as fail-closed until a schema fold registers the row",
  faultClass: "O",
  ref: "NDR-n step 4 / NDR-q (row MISSING upstream)",
});
registerCondition({
  code: "readjudication-owed",
  text: "intake-refusal fault withdrawn with no re-adjudication outcome record yet — named durable state, drain-progressing until the outcome lands (per NDR-l/NDR-i/NDR-k)",
  faultClass: "B",
  ref: "§14.12.2 B row (v13 R5-C7-1 exception)",
});
registerCondition({
  code: "effect-owed",
  text: "drained owner-act with an outstanding effect (effectRecordIds not all present in the log, v10 c8-B1) — excluding the NDR-v/NDR-l exclusion set (terminal-by-refusal/damage/cancellation, unsettled residual-cure)",
  faultClass: "B",
  ref: "§14.12.2 B row (v10 c8-B1)",
});

/* ================= faults seam (MINOR-1) ============================ */

/**
 * `FaultsIfc` — the seam `fold.ts` consumes faults through (MINOR-1):
 * fold NEVER imports `faults.ts`; the real implementation lands step 5
 * (`src/findings/faults.ts`) and is injected here. Kept small on
 * purpose: fold needs class answers and edge-authorization checks,
 * nothing else.
 */
export interface FaultsIfc {
  /** Class of a fault code (A met/disposed / B drain-progressing /
   * O owner-only — §14.12.2 classes). Consults the canonical
   * condition list (NDR-q). */
  classOf(code: string): FaultClass | null;
  /** Whether an integrity fault of this kind blocks the given
   * lifecycle edge (step-4 semantics; seam keeps the signature,
   * fold.ts never re-implements the table). */
  blocksEdge(code: string, edge: UpdateTo): boolean;
}

/* ================= kind table (NDR-q "kind table") ================== */

/**
 * The kind table (g1-implementation-mapping row q; §14.10 "closed
 * kind enum"): the closed set of §14.10 finding-record wire kinds
 * this module defines, each with its interface. SCOPE (G2 round-5
 * cycle-2 fold, terra G2-5; g1-implementation-mapping row q
 * MINOR-3 envelope/record-kind scope note): this table is scoped to
 * **G1's OWN wire kinds plus the named wire dependencies** — it is
 * NOT a claim about the global S5 log inventory: other documented
 * supervisor records (e.g. the §14.12.2 `quiesce-stall` needs-owner
 * record) are valid S5 kinds owned by other sections/steps, and
 * `isRecordKind`/`KIND_TABLE` must NEVER be used to reject them.
 * Within scope an unknown `kind` makes the finding-record line
 * invalid (§14.10.1 unknown-value rule). The map type is the
 * PROVENANCE (F02 fold cycle-3; refs corrected cycles 4–5 — each ref
 * grepped AND section-checked; definition sites, with register/constraint
 * rows labelled as such where docs/11 defines by constraint):
 *   audit-finding                     §14.10.1 wire shape (docs/11:2501)
 *   audit-finding-update              §14.10.2 transition shape (docs/11:2691)
 *   owner-act                         shape §14.10.3 (docs/11:3355); owner-act mode row of the audit-finding entry-mode table §14.10.1 (docs/11:2643)
 *   audit-filing-intake-refusal       constraint sites §14.10.3: fault-resolution rule (docs/11:4759), prefix-binding pair (docs/11:3060), spoolObserved/observedSha256 (docs/11:4807) — docs/11 defines this record BY CONSTRAINT across §14.10.3, no single field-level block
 *   owner-filing-integrity-fault      field list §14.10.3 (docs/11:4739 ff); disposition cross-ref (docs/11:5433)
 *   filing-integrity-disposition      payload definition §14.10.3 (docs/11:4585); NDR-q closing-inventory row, cites NDR-m as authority (docs/11:2151)
 *   audit-filing-readjudication-outcome canonical register statement §14.10.0 (docs/11:1894); field shape §14.10.3 (docs/11:4936)
 *   repro-run                         §14.12.4 record shape (docs/11:7834)
 *   cure-gate                         shape §14.10.3 (docs/11:3608); §14.12.4b inventory bullet (docs/11:8051)
 *   residual-cure-settlement          shape §14.10.3 (docs/11:4407); §14.12.4b inventory bullet (docs/11:8031)
 *   finding-hold                      §14.12.4 shape (docs/11:7845); payload §14.10.3 (docs/11:3457); rule-5 usage §14.12.2 (docs/11:6786)
 *   finding-hold-lift                 §14.12.4 (docs/11:7847)
 */
export const RECORD_KIND_CLOSED_SET = Object.freeze([
  "audit-finding",
  "audit-finding-update",
  "owner-act",
  "audit-filing-intake-refusal",
  "owner-filing-integrity-fault",
  "filing-integrity-disposition",
  "audit-filing-readjudication-outcome",
  "repro-run",
  "cure-gate",
  "residual-cure-settlement",
  "finding-hold",
  "finding-hold-lift",
] as const);
export type RecordKind = (typeof RECORD_KIND_CLOSED_SET)[number];

/** kind → interface map (type-level; consumed by `intake.ts`
 * discriminant dispatch). */
export interface KindTable {
  "audit-finding": AuditFinding;
  "audit-finding-update": AuditFindingUpdate;
  "owner-act": OwnerAct;
  "audit-filing-intake-refusal": AuditFilingIntakeRefusal;
  "owner-filing-integrity-fault": OwnerFilingIntegrityFault;
  "filing-integrity-disposition": FilingIntegrityDispositionRecord;
  "audit-filing-readjudication-outcome": FilingReadjudicationOutcome;
  "repro-run": ReproRun;
  "cure-gate": CureGate;
  "residual-cure-settlement": ResidualCureSettlement;
  "finding-hold": FindingHoldRecord;
  "finding-hold-lift": FindingHoldLiftRecord;
}

/** Any IN-SCOPE finding record (discriminated union over the kind
 * table — G1's own wire kinds + named dependencies ONLY; other valid
 * S5 kinds like §14.12.2's `quiesce-stall` are outside this union,
 * per the kind-table scope note above). */
export type AnyRecord = KindTable[RecordKind];

/** The kind table as a value (closed set membership at runtime; the
 * keys are exactly `RECORD_KIND_CLOSED_SET`). G1 step-1 round-6 fold
 * (audit F2): NULL-PROTOTYPE and FROZEN — a plain object answers
 * `KIND_TABLE["constructor"]` / `["toString"]` with inherited Object
 * members (truthy — a naive `if (KIND_TABLE[v])` membership test
 * would accept them as kinds); with a null prototype ONLY the own
 * kind keys answer, and the freeze makes the table immutable. The
 * test pins both properties. */
export const KIND_TABLE: Readonly<Record<RecordKind, true>> =
  Object.freeze(
    Object.assign(
      Object.create(null) as Record<string, true>,
      Object.fromEntries(
        RECORD_KIND_CLOSED_SET.map((k) => [k, true as const]),
      ),
    ),
  ) as Readonly<Record<RecordKind, true>>;

/** Runtime kind membership. */
export function isRecordKind(v: string): v is RecordKind {
  return (RECORD_KIND_CLOSED_SET as readonly string[]).includes(v);
}

/**
 * Runtime vocabulary membership helper (NDR-t(1): an unknown value of
 * a closed vocabulary makes the record invalid — the caller refuses
 * the line, never silently drops).
 */
export function inClosedSet<T extends readonly string[]>(
  set: T,
  v: string,
): v is T[number] {
  return (set as readonly string[]).includes(v);
}
