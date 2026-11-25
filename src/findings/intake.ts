/**
 * G1 step 2 — finding intake (`intake.ts`), per
 * docs/audits/g1-implementation-mapping.md row `intake.ts`:
 * entry-mode validation (NDR-a), id mint (fresh conforming ULID,
 * collision-refused, R7), claimDigest / findingRef artifact, scopeRefs
 * carry (opaque — G5 path validation DEFERRED; G1 validates
 * `string[]` shape only), the CONFIRMED-BYTES SPOOL admission
 * producer/consumer (§14.10.3: intake NEVER reads the live draft path
 * — it reads `drafts/sha256-<draftSha256>`, re-hashes, and a missing
 * or divergent spool is `owner-filing-draft-drift`, TERMINAL for the
 * act with an empty effect set, cleared only by a
 * `filing-drift-resolution` owner-act op), claim equality (NDR-c:
 * NFC-normalized decoded JSON string-value equality), closed-
 * vocabulary enforcement (NDR-t(1): an unknown enum value makes the
 * record invalid — the line is REFUSED and surfaced, never silently
 * dropped — and NDR-t(2): `surface:"spec"` × `route:"code-fix"` is
 * invalid), and the G2-gate stub refusal path with its journal
 * (MAJOR-7 fold: the stub is an injected interface
 * `normGate(record) => pass | fail(code)`; a `code-fix` record
 * failing the gate is refused at intake, the refusal-code is
 * JOURNALED as an S5 decision-log record naming the refused line's
 * content hash, the line NEVER becomes an `audit-finding`, and a
 * corrected resubmission is a NEW record next cycle; fail-closed — a
 * gate that ERRORS is a refusal with the error journaled).
 *
 * Refusal-record construction follows §14.10.3 (NDR-d/e): every
 * permanent refusal binds the intake-validation prefix
 * (`intakePrefixEndId` / `intakePrefixSha256` — the id + running
 * digest of the LAST record of the prefix intake read, the refusal
 * record's own predecessor), carries the NDR-f check class, and
 * embeds `adjudicatedDraftBytes` (≤16 KiB, re-digesting to the act's
 * `draftSha256`) for the draft-derivative and MIXED classes.
 *
 * HEADER↔PAYLOAD COMPARISONS ARE EXACTLY TWO (v28 R5-C20-4):
 * `claim` (byte-equal after NFC, NDR-c) and `cureActRef` (null=null
 * or identical id). `cycle` has NO header source (act payload only)
 * and is never compared (v9 R4-C3-1).
 *
 * RUNNING-DIGEST ALGORITHM (implementation pin, v35 wire fold): the
 * schema pins the binding's SEMANTICS (id + running digest of the
 * last record of the prefix; no record ever contains its own digest,
 * NDR-i/R5-C10-1) but not the byte recipe; this module defines it
 * once and every consumer (adjudicate.ts, recovery.ts) imports it
 * from here so a single definition governs:
 *   D(-1) = sha256("tre-prefix-chain/1\n")
 *   D(i)  = sha256( D(i-1) bytes || "\n" || line_i )   for the
 *           writer-canonical JSON line of each record in order.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  isFindingReproSatisfied,
  isRouteSurfaceValid,
  isSha256Hex,
  isUlid,
  entryModeOf,
  ROUTE_CLOSED_SET,
  SURFACE_CLOSED_SET,
  SEVERITY_CLOSED_SET,
  VERDICT_BASIS_CLOSED_SET,
  REPRO_KIND_CLOSED_SET,
  checkClassOfRefusalCode,
  type AuditFinding,
  type AuditFilingIntakeRefusal,
  type AuditFilingPayload,
  type FilingRefusalCode,
  type FindingEntryMode,
  type OwnerAct,
  type RefusalCheckClass,
  type Repro,
  type Route,
  type Severity,
  type Surface,
  type VerdictBasis,
  type Origin,
  type OriginRef,
  type AffectedNorm,
} from "./records.js";

/* ================= constants ================= */

/** Draft header magic, line 1 (§14.10.3 v7 R4-C1-4). */
export const DRAFT_MAGIC = "tre://audit-filing-draft/1";

/** 16 KiB cap on the confirmed/spooled artifact (§14.10.3: the CLI
 * refuses an over-cap draft AT INPUT — nothing is written). */
export const DRAFT_CAP_BYTES = 16 * 1024;

/** `claim` bound (§14.10.1): ≤2000 chars, single line. */
export const CLAIM_MAX_CHARS = 2000;

/* ================= NDR-c — claim equality ================= */

/**
 * NDR-c: claim equality is NFC-normalized DECODED JSON string-value
 * equality (v10 R5-C4-3) — the SAME normalization stage the
 * canonicalizer applies, run on BOTH operands before comparison.
 * Byte equality (the superseded v9 reading) is DEAD: byte-different,
 * NFC-equal pairs are EQUAL here (regression-pinned by `ndr-c-nfc-equality`).
 */
export function claimEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return a.normalize("NFC") === b.normalize("NFC");
}

/* ================= prefix running digest (NDR-d/e/i binding) ======== */

/** Running digest of the EMPTY prefix (the chain origin). */
export function prefixDigestInitial(): string {
  return createHash("sha256").update("tre-prefix-chain/1\n", "utf8").digest("hex");
}

/** Fold one canonical JSONL line into the running digest. */
export function prefixDigestStep(prev: string, canonicalLine: string): string {
  const h = createHash("sha256");
  h.update(Buffer.from(prev, "hex"));
  h.update("\n", "utf8");
  h.update(canonicalLine, "utf8");
  return h.digest("hex");
}

/** The `{intakePrefixEndId, intakePrefixSha256}` binding pair over a
 * record-terminated prefix (the records intake READ — the refusal's
 * own predecessors). An EMPTY prefix binds `endId:""` and the chain
 * origin digest; both are stable and replay-re-checkable. */
export function prefixBinding(prefix: readonly unknown[]): {
  intakePrefixEndId: string;
  intakePrefixSha256: string;
} {
  let d = prefixDigestInitial();
  for (const rec of prefix) d = prefixDigestStep(d, JSON.stringify(rec));
  const last = prefix[prefix.length - 1];
  const endId =
    last !== null && typeof last === "object" && last !== undefined &&
    typeof (last as { id?: unknown }).id === "string"
      ? (last as { id: string }).id
      : "";
  return { intakePrefixEndId: endId, intakePrefixSha256: d };
}

/* ================= NDR-a — id mint & entry mode ==================== */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Mint ONE fresh conforming ULID (R7): 128 random bits, Crockford
 * base32 — the first character is one of `0`–`7` by construction. */
export function mintUlid(): string {
  const b = randomBytes(16);
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  // 26 chars × 5 bits = 130 bits; the value occupies 128, so the
  // FIRST char carries only 3 bits ⇒ always ≤ `7`.
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return out;
}

/**
 * NDR-a / R7 id mint: a FRESH conforming ULID, COLLISION-REFUSED
 * against the ids already standing in the log. A collision throws —
 * it is never silently re-minted by the primitive; the caller retries
 * with a genuinely fresh instance. `taken` is the existing id set.
 */
export function mintFindingId(taken: ReadonlySet<string>, mint: () => string = mintUlid): string {
  const id = mint();
  if (!isUlid(id)) {
    throw new Error(`mintUlid produced a non-conforming id (${id}) — implementation fault`);
  }
  if (taken.has(id)) {
    throw new Error(`id collision refused: ${id} already stands in the log (R7)`);
  }
  return id;
}

/** The actor classing intake (NDR-a: supervisor-derived mode is a
 * SUPERVISOR privilege; an auditor caller can never mint one, and an
 * auditor never originates the owner line). */
export type IntakeActor = "supervisor" | "auditor-endpoint" | "owner-cli";

/**
 * NDR-a entry-mode validation at the intake boundary: the nullability
 * triple must map to exactly one mode via `entryModeOf` AND the actor
 * must be allowed to produce it — supervisor-derived REQUIRES the
 * supervisor actor; only the supervisor appends anything, so the two
 * endpoint-facing actors may produce ONLY their own mode (auditor-
 * intake for an auditor endpoint; owner-act input arrives through a
 * confirmed owner act, never as a claimed mode).
 * Returns the mode, or null (refused).
 */
export function validateEntryMode(
  actor: IntakeActor,
  f: Pick<AuditFinding, "origin" | "originRef" | "ownerActRef">,
): FindingEntryMode | null {
  const mode = entryModeOf(f);
  if (mode === null) return null;
  if (mode === "supervisor-derived" && actor !== "supervisor") return null;
  if (actor === "auditor-endpoint" && mode !== "auditor-intake") return null;
  return mode;
}

/* ================= NDR-t — closed vocabulary ======================= */

/** A vocabulary failure: the offending field + the offending value
 * (surfaced verbatim — NDR-t(1): refuse AND surface, never drop). */
export interface VocabFailure {
  field: string;
  value: unknown;
  closedSet: readonly string[];
}

function inSet<T extends string>(set: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (set as readonly string[]).includes(v);
}

/**
 * NDR-t(1)/(2) closed-vocabulary enforcement over the draft header's
 * classified fields: an unknown enum value makes the record INVALID —
 * the caller refuses the line and surfaces the failure (it is NEVER
 * silently dropped, never coerced). Also carries the NDR-t(2)
 * route×surface rule: `surface:"spec"` with `route:"code-fix"` is
 * invalid (`isRouteSurfaceValid`, records.ts).
 * Returns the failure list (empty = every value in its closed set).
 */
export function vocabValidate(h: Record<string, unknown>): VocabFailure[] {
  const fails: VocabFailure[] = [];
  const check = (field: string, set: readonly string[], required = true) => {
    const v = h[field];
    if (v === undefined && !required) return;
    if (!inSet(set, v)) fails.push({ field, value: v, closedSet: set });
  };
  check("route", ROUTE_CLOSED_SET);
  check("surface", SURFACE_CLOSED_SET);
  check("severity", SEVERITY_CLOSED_SET);
  check("verdictBasis", VERDICT_BASIS_CLOSED_SET);
  const repro = h["repro"];
  if (repro === null || typeof repro !== "object") {
    fails.push({ field: "repro", value: repro, closedSet: ["<object>"] });
  } else {
    const kind = (repro as Record<string, unknown>)["kind"];
    if (!inSet(REPRO_KIND_CLOSED_SET, kind)) {
      fails.push({ field: "repro.kind", value: kind, closedSet: REPRO_KIND_CLOSED_SET });
    }
  }
  // NDR-t(2): route×surface pairing (only fires when both enums are valid).
  if (inSet(ROUTE_CLOSED_SET, h["route"]) && inSet(SURFACE_CLOSED_SET, h["surface"])) {
    if (!isRouteSurfaceValid(h["route"] as Route, h["surface"] as Surface)) {
      fails.push({
        field: "route×surface",
        value: `${h["surface"]}×${h["route"]}`,
        closedSet: ["surface:'spec' requires route != 'code-fix'"],
      });
    }
  }
  return fails;
}

/* ================= spool admission (producer + consumer) =========== */

/** Content-addressed spool path for a draft digest (§14.10.3:
 * `drafts/sha256-<draftSha256>` under the episode dir). */
export function spoolPath(episodeDir: string, draftSha256: string): string {
  if (!isSha256Hex(draftSha256)) {
    throw new IntakeInputError(`draftSha256 is not 64-char lowercase hex: ${String(draftSha256)}`);
  }
  return path.join(episodeDir, "drafts", `sha256-${draftSha256}`);
}

/** Input-class refusal (over-cap draft, malformed digest arg): the
 * CLI refuses BEFORE writing anything. */
export class IntakeInputError extends Error {}

/**
 * PRODUCER (CLI side, §14.10.3): write the confirmed bytes to the
 * content-addressed spool and FSYNC BEFORE the act append (step (i)
 * of the two-step commit; a crash before (ii) leaves an inert orphan
 * spool object — no act exists to refuse, resolve, or owe). An
 * over-cap draft is refused AT INPUT (nothing written). An existing
 * entry must be byte-identical (content-addressing: an entry either
 * IS this byte-string or is corrupt — never silently replaced).
 */
export function spoolDraft(episodeDir: string, bytes: Buffer): string {
  if (bytes.length > DRAFT_CAP_BYTES) {
    throw new IntakeInputError(
      `draft is ${bytes.length} bytes > the ${DRAFT_CAP_BYTES}-byte cap — refused at input`,
    );
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  const p = spoolPath(episodeDir, sha);
  mkdirSync(path.dirname(p), { recursive: true });
  if (existsSync(p)) {
    const prior = readFileSync(p);
    if (!prior.equals(bytes)) {
      throw new IntakeInputError(
        `spool entry ${path.basename(p)} already stands with DIVERGENT bytes — integrity fault, never replaced`,
      );
    }
    return sha; // verified existing entry reused (content-addressing dedup)
  }
  const fd = openSync(p, "wx");
  try {
    writeSync(fd, bytes);
    fsyncSync(fd); // durable BEFORE the act append
  } finally {
    closeSync(fd);
  }
  return sha;
}

/** Spool read outcome (consumer side). `absent` and `mismatch` both
 * route to the drift refusal; the consumer NEVER reads the live
 * draft path (the live path is untrusted mutable state). */
export type SpoolRead =
  | { state: "ok"; bytes: Buffer }
  | { state: "absent" }
  | { state: "mismatch"; observedSha256: string };

/** CONSUMER (intake side): read the spool at the content-addressed
 * path and RE-HASH it against the act's `draftSha256`. */
export function readSpool(episodeDir: string, draftSha256: string): SpoolRead {
  let raw: Buffer;
  try {
    raw = readFileSync(spoolPath(episodeDir, draftSha256));
  } catch {
    return { state: "absent" };
  }
  const observed = createHash("sha256").update(raw).digest("hex");
  if (observed !== draftSha256) return { state: "mismatch", observedSha256: observed };
  return { state: "ok", bytes: raw };
}

/* ================= draft parsing =================================== */

/** Parsed draft artifact (§14.10.3 v7 R4-C1-4: line 1 = magic;
 * line 2 = ONE single-line JSON header object; free prose below). */
export interface ParsedDraft {
  header: Record<string, unknown>;
  prose: string;
}

export function parseDraft(bytes: Buffer): ParsedDraft {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const firstBreak = text.indexOf("\n");
  const magic = firstBreak === -1 ? text : text.slice(0, firstBreak);
  if (magic !== DRAFT_MAGIC) {
    throw new IntakeInputError(`draft line 1 is not the magic '${DRAFT_MAGIC}'`);
  }
  const rest = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
  const secondBreak = rest.indexOf("\n");
  const headerLine = secondBreak === -1 ? rest : rest.slice(0, secondBreak);
  if (headerLine.trim() === "") {
    throw new IntakeInputError("draft header (line 2) is missing or empty");
  }
  let header: unknown;
  try {
    header = JSON.parse(headerLine);
  } catch (e) {
    throw new IntakeInputError(`draft header is not valid JSON: ${(e as Error).message}`);
  }
  if (header === null || typeof header !== "object" || Array.isArray(header)) {
    throw new IntakeInputError("draft header is not a single JSON object");
  }
  return { header: header as Record<string, unknown>, prose: secondBreak === -1 ? "" : rest.slice(secondBreak + 1) };
}

/* ================= filing adjudication (owner-act path) ============ */

/** Prefix record shape needed for lineage resolution. */
export interface PrefixFindingRecord {
  kind: "audit-finding";
  id: string;
  severity: Severity;
  route: Route;
  correctionOf: string | null;
  claim: string;
}
export type PrefixRecord =
  | PrefixFindingRecord
  | { kind: "owner-act"; id: string; op: string }
  | { kind: "audit-finding-update"; id: string; findingId: string; to: string }
  | { kind: string; id: string };

function isPrefixFinding(r: PrefixRecord): r is PrefixFindingRecord {
  return r.kind === "audit-finding" && "severity" in r && "route" in r;
}

export interface FilingAdjudicationInput {
  episodeDir: string;
  episodeId: string;
  /** the log prefix intake READS (everything before the refusal it
   * may append) — the binding source AND the lineage authority */
  prefix: readonly PrefixRecord[];
  /** the audit-filing owner act being adjudicated (already durable) */
  act: OwnerAct<"audit-filing">;
  /** producer trio recorded on the CLI channel (§14.10.3 envelope
   * sources: the session on the confirming channel) */
  producer: AuditFinding["producer"];
  /** ids already standing (NDR-a collision refusal) */
  existingIds: ReadonlySet<string>;
  /** advisory timestamp */
  now: number;
}

export type FilingAdjudication =
  | { status: "applied"; finding: AuditFinding; artifactPath: string }
  | { status: "refused"; refusal: AuditFilingIntakeRefusal };

const SEVERITY_RANK: Record<Severity, number> = { blocker: 2, major: 1, minor: 0 };

/** The effective CURRENT closure of a finding over the prefix
 * (log-order updates only; the terminal taxonomy full state machine is
 * fold.ts's step 3 — this is the correction-target check's floor:
 * "closed by `rejected-refuted`" per `correction-bad-target`). */
function closedRejectedRefuted(prefix: readonly PrefixRecord[], findingId: string): boolean {
  let lastTo: string | null = null;
  for (const r of prefix) {
    if (r.kind === "audit-finding-update" && (r as { findingId: string }).findingId === findingId) {
      lastTo = (r as { to: string }).to;
    }
  }
  return lastTo === "rejected-refuted";
}

/**
 * Adjudicate ONE `audit-filing` owner act against the prefix and the
 * spool. Order of checks (§14.10.3 staging; first failure supplies the
 * diagnostic; every stage failure routes to a named closed outcome —
 * none to a silent drop):
 *   (1) payload closed-shape          → malformed-input
 *   (2) spool read + re-hash          → owner-filing-draft-drift (TERMINAL)
 *   (3) header parse                  → malformed-input
 *   (4) NDR-t vocab + route×surface   → malformed-input
 *   (5) header completeness (cureActRef REQUIRED-PRESENT, v28
 *       R5-C20P-2) + claim/scalar shape → owner-filing-mapping
 *   (6) header↔payload must-equal (claim NFC [NDR-c], cureActRef)
 *       → owner-filing-mapping
 *   (7) cureActRef IDENTITY resolution (v28 R5-C20P-5 intake split:
 *       resolves in-log to a `residual-cure` ACT; confirmed/unsettled
 *       is a SETTLEMENT-time check, NOT here) → cure-unknown-act
 *   (8) correction-lineage MIXED checks (`correction-bad-target`,
 *       `correction-ambiguity`, `correction-severity-decrease`,
 *       `correction-route-mismatch`)
 *   (9) NDR-b intake repro floor (non-minor + kind:"none")
 *       → finding-intake-invalid
 *  (10) NDR-a mint + artifact copy + claimDigest → applied
 */
export function adjudicateFiling(input: FilingAdjudicationInput): FilingAdjudication {
  const { episodeDir, episodeId, prefix, act, producer, existingIds, now } = input;
  const binding = prefixBinding(prefix);
  const payload = act.payload as unknown as AuditFilingPayload;

  const refusal = (
    code: FilingRefusalCode,
    opts: {
      adjudicatedDraftBytes?: string | null;
      spoolObserved?: "absent" | "mismatch" | null;
      observedSha256?: string | null;
    } = {},
  ): { status: "refused"; refusal: AuditFilingIntakeRefusal } => {
    // Every member of the closed nine-code set classifies non-null
    // (records.ts); the fallback is unreachable for well-typed codes.
    const checkClass: RefusalCheckClass =
      checkClassOfRefusalCode(code) ?? "draft-derivative";
    const rec: AuditFilingIntakeRefusal = {
      schema: "tre-supervisor/1",
      id: mintFindingId(existingIds),
      ts: now,
      episodeId,
      kind: "audit-filing-intake-refusal",
      refusedActId: act.id,
      diagnosticCode: code,
      checkClass,
      intakePrefixEndId: binding.intakePrefixEndId,
      intakePrefixSha256: binding.intakePrefixSha256,
      spoolObserved: opts.spoolObserved ?? null,
      observedSha256: opts.observedSha256 ?? null,
      adjudicatedDraftBytes: opts.adjudicatedDraftBytes ?? null,
    };
    return { status: "refused", refusal: rec };
  };

  // (1) act payload closed shape (five required members, v14 R5-C8-7 /
  // v28 R5-C20P-2 — absence is not a third state).
  const okPayload =
    payload !== null && typeof payload === "object" &&
    typeof payload.findingDraftRef === "string" &&
    isSha256Hex(payload.draftSha256) &&
    typeof payload.claim === "string" &&
    typeof payload.cycle === "number" &&
    Number.isInteger(payload.cycle) && payload.cycle >= 0 &&
    (payload.taskId === null || typeof payload.taskId === "string") &&
    (payload.cureActRef === null || typeof payload.cureActRef === "string");
  if (!okPayload) throw new RefusalMalformed("audit-filing payload fails the closed 5+1-field shape");

  // (2) spool admission — read the content-addressed spool ONLY.
  const spool = readSpool(episodeDir, payload.draftSha256);
  if (spool.state === "absent") {
    return refusal("owner-filing-draft-drift", { spoolObserved: "absent", observedSha256: null });
  }
  if (spool.state === "mismatch") {
    return refusal("owner-filing-draft-drift", {
      spoolObserved: "mismatch",
      observedSha256: spool.observedSha256,
    });
  }
  const draftBytes = spool.bytes;
  const embed = () => draftBytes.toString("utf8"); // ≤16 KiB by cap

  // (3) header parse.
  let draft: ParsedDraft;
  try {
    draft = parseDraft(draftBytes);
  } catch (e) {
    if (e instanceof IntakeInputError) {
      return refusal("malformed-input", { adjudicatedDraftBytes: embed() });
    }
    throw e;
  }
  const h = draft.header;

  // (4) NDR-t closed vocab + route×surface.
  const vf = vocabValidate(h);
  if (vf.length > 0) {
    return refusal("malformed-input", { adjudicatedDraftBytes: embed() });
  }

  // (5) header completeness + scalar shape. `cureActRef` REQUIRED-
  // PRESENT (explicit null allowed, v28 R5-C20P-2): omission is
  // `owner-filing-mapping` per §14.10.3 ("a header omitting the
  // field is malformed (owner-filing-mapping, refused)").
  if (!("cureActRef" in h) || (h["cureActRef"] !== null && typeof h["cureActRef"] !== "string")) {
    return refusal("owner-filing-mapping", { adjudicatedDraftBytes: embed() });
  }
  if (!("correctionOf" in h) || (h["correctionOf"] !== null && typeof h["correctionOf"] !== "string")) {
    return refusal("owner-filing-mapping", { adjudicatedDraftBytes: embed() });
  }
  if (!("evidenceRefs" in h) || !Array.isArray(h["evidenceRefs"]) || h["evidenceRefs"].length < 1 ||
      (h["evidenceRefs"] as unknown[]).some((x) => typeof x !== "string" || x === "")) {
    return refusal("owner-filing-mapping", { adjudicatedDraftBytes: embed() });
  }
  if (!("scopeRefs" in h) || !Array.isArray(h["scopeRefs"]) ||
      (h["scopeRefs"] as unknown[]).some((x) => typeof x !== "string")) {
    // scopeRefs carry is OPAQUE here (G1 validates string[] shape only,
    // §14.14.3 semantics DEFERRED to G5).
    return refusal("owner-filing-mapping", { adjudicatedDraftBytes: embed() });
  }
  const hClaim = h["claim"];
  if (typeof hClaim !== "string" || hClaim === "" || hClaim.length > CLAIM_MAX_CHARS ||
      hClaim.includes("\n") || hClaim.includes("\r")) {
    return refusal("owner-filing-mapping", { adjudicatedDraftBytes: embed() });
  }
  const affectedNormPresent = h["affectedNorm"] === null || (
    typeof h["affectedNorm"] === "object" && h["affectedNorm"] !== null &&
    typeof (h["affectedNorm"] as AffectedNorm).doc === "string" &&
    typeof (h["affectedNorm"] as AffectedNorm).anchor === "string" &&
    ((h["affectedNorm"] as { sha256?: unknown }).sha256 === undefined ||
      (h["affectedNorm"] as { sha256?: unknown }).sha256 === null ||
      typeof (h["affectedNorm"] as { sha256?: string }).sha256 === "string")
  );
  if (!("affectedNorm" in h) || !affectedNormPresent) {
    return refusal("owner-filing-mapping", { adjudicatedDraftBytes: embed() });
  }

  // (6) header↔payload must-equal — EXACTLY TWO comparisons (v28
  // R5-C20-4). `cycle` is NOT compared (no header source).
  if (!claimEqual(hClaim as string, payload.claim)) {
    return refusal("owner-filing-mapping", { adjudicatedDraftBytes: embed() });
  }
  if (h["cureActRef"] !== payload.cureActRef) {
    return refusal("owner-filing-mapping", { adjudicatedDraftBytes: embed() });
  }

  // (7) cureActRef identity resolution (MIXED class; IDENTITY ONLY at
  // intake per v28 R5-C20P-5 — unknown id or non-cure act ⇒ refusal;
  // confirmed+unsettled+not-cancelled rides the settlement prefix).
  if (payload.cureActRef !== null) {
    const cureAct = prefix.find(
      (r) => r.kind === "owner-act" && r.id === payload.cureActRef && (r as { op?: string }).op === "residual-cure",
    );
    if (cureAct === undefined) {
      return refusal("cure-unknown-act", { adjudicatedDraftBytes: embed() });
    }
  }

  // (8) correction-lineage MIXED checks (header operands from the
  // digest-verified bytes, target state/lineage from the bound
  // prefix — NDR-f joint shape).
  const correctionOf = h["correctionOf"] as string | null;
  if (correctionOf !== null) {
    const target: PrefixFindingRecord | undefined = prefix.find(
      (r): r is PrefixFindingRecord => isPrefixFinding(r) && r.id === correctionOf,
    );
    if (
      target === undefined ||
      !closedRejectedRefuted(prefix, correctionOf)
    ) {
      // targets are restricted to `rejected-refuted` closures
      return refusal("correction-bad-target", { adjudicatedDraftBytes: embed() });
    }
    // one correction per target (lineage linearity)
    const sibling = prefix.find(
      (r) => r.kind === "audit-finding" &&
        (r as { correctionOf: string | null }).correctionOf === correctionOf,
    );
    if (sibling !== undefined) {
      return refusal("correction-ambiguity", { adjudicatedDraftBytes: embed() });
    }
    // severity/route preservation (the correction fold's intake-time
    // preservation — a correction may NOT downgrade)
    const proposedSeverity = h["severity"] as Severity;
    const proposedRoute = h["route"] as Route;
    if (SEVERITY_RANK[proposedSeverity] < SEVERITY_RANK[target.severity]) {
      return refusal("correction-severity-decrease", { adjudicatedDraftBytes: embed() });
    }
    if (proposedRoute !== target.route) {
      return refusal("correction-route-mismatch", { adjudicatedDraftBytes: embed() });
    }
  }

  // (9) NDR-b intake floor: `repro.kind:"none"` refused for NON-MINOR
  // findings for EVERY producer (route-free — the canonical rule).
  const repro = h["repro"] as Repro;
  const severity = h["severity"] as Severity;
  if (!isFindingReproSatisfied({ severity, repro })) {
    return refusal("finding-intake-invalid", { adjudicatedDraftBytes: embed() });
  }

  // (10) applied: NDR-a mint, immutable artifact copy, claimDigest.
  const id = mintFindingId(existingIds);
  const findingRefRel = path.join("findings", id);
  const artifactPath = path.join(episodeDir, findingRefRel);
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  const fd = openSync(artifactPath, "wx");
  try {
    writeSync(fd, draftBytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // self-check: stored bytes ARE the adjudicated bytes (confirmed /
  // spool / stored / attested digest — ONE byte-string).
  const storedDigest = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
  if (storedDigest !== payload.draftSha256) {
    // post-write identity failure is an integrity fault territory,
    // never a silent accept:
    throw new Error(`findingRef artifact digest ${storedDigest} diverges from draftSha256 ${payload.draftSha256} immediately after write — integrity fault`);
  }

  const finding: AuditFinding = {
    schema: "tre-supervisor/1",
    id,
    ts: now,
    episodeId,
    taskId: payload.taskId,
    kind: "audit-finding",
    cycle: payload.cycle, // act payload is the SOLE source (v9 R4-C3-1)
    origin: "owner",
    producer,
    ownerActRef: act.id,
    originRef: null,
    correctionOf,
    route: h["route"] as Route,
    surface: h["surface"] as Surface,
    severity,
    verdictBasis: h["verdictBasis"] as VerdictBasis,
    claim: hClaim,
    claimDigest: storedDigest, // plain sha256 over the artifact bytes
    findingRef: findingRefRel,
    scopeRefs: h["scopeRefs"] as string[],
    repro,
    evidenceRefs: h["evidenceRefs"] as string[],
    cureActRef: payload.cureActRef,
    affectedNorm: h["affectedNorm"] as AffectedNorm | null,
  };
  // entry-mode self-check (defense in depth — the record we just
  // built MUST map to owner-act through the table):
  if (validateEntryMode("supervisor", finding) !== "owner-act") {
    throw new Error("internal: built finding fails its own entry-mode check");
  }
  return { status: "applied", finding, artifactPath };
}

/** Wrapper turning the malformed-payload internal throw into a
 * malformed-input refusal (kept out of the main flow for readability). */
class RefusalMalformed extends Error {}

/** Top-level entry: run adjudication with the malformed-payload guard
 * routed to the closed `malformed-input` refusal (bytes CANNOT be
 * embedded — a payload-shape failure precedes any byte reading, so
 * `bytesSource`/`adjudicatedDraftBytes` are null and the class is
 * draft-derivative per NDR-f). */
export function intakeFiling(input: FilingAdjudicationInput): FilingAdjudication {
  try {
    return adjudicateFiling(input);
  } catch (e) {
    if (e instanceof RefusalMalformed) {
      const binding = prefixBinding(input.prefix);
      return {
        status: "refused",
        refusal: {
          schema: "tre-supervisor/1",
          id: mintFindingId(input.existingIds),
          ts: input.now,
          episodeId: input.episodeId,
          kind: "audit-filing-intake-refusal",
          refusedActId: input.act.id,
          diagnosticCode: "malformed-input",
          checkClass: "draft-derivative",
          intakePrefixEndId: binding.intakePrefixEndId,
          intakePrefixSha256: binding.intakePrefixSha256,
          spoolObserved: null,
          observedSha256: null,
          adjudicatedDraftBytes: null,
        },
      };
    }
    throw e;
  }
}

/* ================= G2-gate stub (MAJOR-7 fold) ===================== */

/** The injected gate interface (no G2 implementation is scheduled —
 * §14.15 order honored). `pass` admits; `fail(code)` refuses with the
 * gate's own code; THROWING is fail-closed: a refusal with the error
 * journaled. */
export type NormGate = (record: AuditFinding) => { pass: true } | { pass: false; code: string };

/** S5 decision-log record for a gate refusal (§14.10.1 M9 fold: G2
 * is an intake gate; refusals are S5 DECISION records, never
 * `audit-filing-intake-refusal`s — the nine-code filing set governs
 * owner-FILING intake only). Names the refused line's content hash
 * (the finding record's canonical line digest) so the refused line
 * is durable evidence without re-admitting it. */
export interface NormGateRefusalJournalEntry {
  kind: "norm-gate-refusal";
  id: string;
  ts: number;
  episodeId: string;
  taskId: string | null;
  /** the gate's refusal code (its own vocabulary — NOT one of the
   * nine filing codes) */
  refusalCode: string;
  /** sha256 of the refused record's canonical JSONL line */
  lineSha256: string;
  /** non-null exactly when the gate ERRORED (fail-closed) — the
   * error message, journaled */
  gateError: string | null;
}

export interface AuditorAdmission {
  episodeId: string;
  taskId: string | null;
  /** the receipt id the submission arrived on (originRef operand) */
  receiptId: string;
  /** the finding candidate as parsed from the submission (no id /
   * claimDigest / findingRef yet — the supervisor mints those) */
  candidate: Omit<AuditFinding, "id" | "claimDigest" | "findingRef"> &
    Partial<Pick<AuditFinding, "id">>;
  now: number;
}

export type AuditorAdmissionResult =
  | { status: "admitted"; finding: AuditFinding; artifactPath: string }
  | { status: "refused-gate"; journal: NormGateRefusalJournalEntry };

/**
 * Auditor-intake admission with the G2-gate stub on the SAME path:
 * vocab validation (NDR-t), entry-mode validation (NDR-a — an auditor
 * endpoint may only produce auditor-intake mode), claimDigest +
 * artifact over the finding's cited bytes, then the gate — ONLY for
 * `route:"code-fix"` records (G2 gates intake, never re-routes, so
 * only code-fix records can fail it; the gate result NEVER mutates
 * the record). A refused line: journaled, never an `audit-finding`;
 * a corrected resubmission is a NEW record next cycle.
 */
export function admitAuditorFinding(
  episodeDir: string,
  input: AuditorAdmission,
  opts: {
    takenIds: ReadonlySet<string>;
    /** the finding's full-prose artifact bytes (evidence content the
     * submission carries; claimDigest binds them) */
    artifactBytes: Buffer;
    normGate: NormGate;
    journalPath: string;
  },
): AuditorAdmissionResult {
  const { candidate } = input;
  // NDR-t on the candidate's classified fields:
  const vf = vocabValidate({
    route: candidate.route,
    surface: candidate.surface,
    severity: candidate.severity,
    verdictBasis: candidate.verdictBasis,
    repro: candidate.repro,
  });
  if (vf.length > 0) {
    throw new IntakeInputError(
      `auditor submission fails the closed vocabulary: ${vf.map((f) => `${f.field}=${JSON.stringify(f.value)}`).join(", ")}`,
    );
  }
  // NDR-a: the candidate must map to auditor-intake for an auditor
  // endpoint (origin/originRef/ownerActRef triple + actor).
  const mode = validateEntryMode("auditor-endpoint", candidate);
  if (mode !== "auditor-intake") {
    throw new IntakeInputError(
      "an auditor endpoint may only produce auditor-intake mode records (NDR-a)",
    );
  }
  const id = mintFindingId(opts.takenIds);
  const findingRefRel = path.join("findings", id);
  const artifactPath = path.join(episodeDir, findingRefRel);
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  const fd = openSync(artifactPath, "wx");
  try {
    writeSync(fd, opts.artifactBytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const finding: AuditFinding = {
    ...candidate,
    id,
    claimDigest: createHash("sha256").update(readFileSync(artifactPath)).digest("hex"),
    findingRef: findingRefRel,
  };

  if (finding.route === "code-fix") {
    let gateResult: { pass: true } | { pass: false; code: string };
    let gateError: string | null = null;
    try {
      gateResult = opts.normGate(finding);
    } catch (e) {
      gateError = (e as Error).message;
      gateResult = { pass: false, code: "gate-error" }; // fail-closed
    }
    if (!gateResult.pass) {
      const line = JSON.stringify(finding);
      const journal: NormGateRefusalJournalEntry = {
        kind: "norm-gate-refusal",
        id: mintFindingId(opts.takenIds),
        ts: input.now,
        episodeId: input.episodeId,
        taskId: input.taskId,
        refusalCode: gateResult.code,
        lineSha256: createHash("sha256").update(line, "utf8").digest("hex"),
        gateError,
      };
      // durable BEFORE the ack returns (journal-then-ack):
      mkdirSync(path.dirname(opts.journalPath), { recursive: true });
      const jfd = openSync(opts.journalPath, "a");
      try {
        writeSync(jfd, JSON.stringify(journal) + "\n");
        fsyncSync(jfd);
      } finally {
        closeSync(jfd);
      }
      // The refused record NEVER becomes an `audit-finding`: the
      // artifact written above is UNREFERENCED by any record and the
      // caller receives NO finding — only the journal entry.
      return { status: "refused-gate", journal };
    }
  }
  return { status: "admitted", finding, artifactPath };
}

/* ================= NDR-r — re-filing identity ====================== */

/**
 * NDR-r case (2): a NEW confirmed act over identical draft bytes is a
 * NEW filing ATTEMPT with a NEW effect id — NEVER refused as
 * duplicate INTENT (duplicate intent is not a validation concept) —
 * but FULLY subject to every ordinary intake rule on its own content.
 * This is a delegation pin, not a parallel path: the attempt runs the
 * SAME `intakeFiling` adjudication (success ⇒ a SEPARATE
 * `audit-finding`; e.g. a resubmitted correction draft is refused
 * `correction-ambiguity` by lineage linearity per NDR-n). Case (1)
 * (same act id redelivered) is idempotent at the S5 transport layer
 * (s5log.ts), and case (3) (same act id, DIVERGENT bytes) is refused
 * there as replay-integrity — the act's bytes are pinned by its
 * `draftSha256` and re-digest-checked on every redelivery (NDR-r
 * owns this outright per v24 R5-C17-2; NDR-i governs withdrawal
 * only). Spool dedup is STORAGE dedup with no disposition meaning:
 * two successful filings of identical bytes are DISTINCT findings
 * (`rejected-duplicate` linking is the normal disposition path).
 */
export function refileAttempt(input: FilingAdjudicationInput): FilingAdjudication {
  return intakeFiling(input);
}

/* ================= drift resolution operand helpers ================ */

/**
 * A drift refusal is TERMINAL FOR THE ACT (empty effect set —
 * "empty-by-refusal": the act never becomes owed work and never
 * resolves by re-confirmation) and is cleared ONLY by a
 * `filing-drift-resolution` owner-act op naming (refusedActId,
 * refusalRecordId) — the dedup key (v15 R5-C9-3), `refiled` binding a
 * LATER APPLIED audit-filing act whose claim is NDR-c-equal, or
 * `withdrawn` (always admissible). This helper validates that the
 * resolution operands name a REAL drift refusal of the named act;
 * full op adjudication (liveness, one-per-drift) lands with
 * `faults.ts` (step 5).
 */
export function driftResolutionOperandsValid(
  refusal: AuditFilingIntakeRefusal,
  operands: { refusedActId: string; refusalRecordId: string },
): boolean {
  return (
    refusal.diagnosticCode === "owner-filing-draft-drift" &&
    operands.refusedActId === refusal.refusedActId &&
    operands.refusalRecordId === refusal.id
  );
}
