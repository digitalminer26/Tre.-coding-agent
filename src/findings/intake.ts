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
 * PAYLOAD-SHAPE FAILURE IS NOT A REFUSAL (g1s2-c1 MAJOR-1, NDR-f):
 * `checkClassOfRefusalCode("malformed-input")` is `draft-derivative`,
 * so a `malformed-input` record with null `adjudicatedDraftBytes` is
 * SELF-CONTRADICTORY (NDR-g: such a record is itself malformed). A
 * malformed `audit-filing` ACT PAYLOAD fails the act's op-schema
 * precondition BEFORE adjudication exists to produce bytes: it throws
 * the typed `MalformedOwnerActError` (the act must never have been
 * appended; act-append-side payload validation is the `faults.ts`
 * (step 5) surface) and NOTHING is recorded.
 *
 * I/O FAULTS ARE NOT DRIFT (g1s2-c1 MAJOR-3, §14.10.3: transient
 * failures are retried, never terminalized): `readSpool` reports
 * `absent` ONLY on ENOENT; every other read error (EPERM, ENOTDIR,
 * EIO…) throws `SpoolIoError` — a permission fault must never be
 * terminalized into an irrevocable drift refusal of the act.
 *
 * BYTES-PRESERVING TRANSPORT (g1s2-c1 MAJOR-2): `adjudicatedDraftBytes`
 * is a UTF-8 string wire field, so the PRODUCER refuses a non-UTF-8
 * draft AT INPUT (spoolDraft) and the CONSUMER embeds only after a
 * lossless round-trip check; a digest-valid spool whose bytes are not
 * losslessly embeddable is storage INTEGRITY territory
 * (`IntegrityFaultError`, thrown loudly — never a refusal carrying
 * lossy bytes).
 *
 * DURABILITY (g1s2-c1 MAJOR-9, `spool-a-write-fsync-order`): every
 * newly created durable object (spool entry, findingRef artifact,
 * gate-refusal journal) is fsynced AND its DIRECTORY ENTRY is
 * established through the containing directory before the dependent
 * ack — file fsync alone proves content survives, not the NAME.
 *
 * RUNNING-DIGEST ALGORITHM (implementation pin, v35 wire fold +
 * g1s2-c1 MAJOR-8): the schema pins the binding's SEMANTICS (id +
 * running digest of the last record of the prefix; no record ever
 * contains its own digest, NDR-i/R5-C10-1) but not the byte recipe;
 * this module defines it once and every consumer (adjudicate.ts,
 * recovery.ts) imports it from here so a single definition governs.
 * The digest folds the log's WRITER-CANONICAL LINE BYTES exactly as
 * the s5log writer emits them (`JSON.stringify(record)` per line,
 * s5log.ts:137) — supplied by the CALLER as `prefixLines`, NEVER a
 * re-serialization of parsed records (a reparsed object's property
 * order is not guaranteed to equal the durable line; the binding is
 * the digest of the prefix AS READ):
 *   D(-1) = sha256("tre-prefix-chain/1\n")
 *   D(i)  = sha256( D(i-1) bytes || "\n" || line_i )   per durable line.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
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
 * origin digest; both are stable and replay-re-checkable.
 *
 * g1s2-c1 MAJOR-8: the digest folds the WRITER-CANONICAL LINE BYTES
 * (s5log emits one `JSON.stringify(record)` per line), supplied here
 * as `prefixLines` — NEVER re-serialized from parsed records inside
 * this function. A reparsed object's property enumeration order is
 * not guaranteed to reproduce the durable line (a decoder may
 * reorder keys; an upstream writer may have written non-canonical
 * whitespace), so re-folding parsed objects can produce a digest the
 * log itself will never reproduce. `endId` comes from the LAST LINE:
 * it is parsed ONLY for the id field; a malformed final line yields
 * `endId:""` (the digest still folds the raw bytes as read). */
export function prefixBinding(prefixLines: readonly string[]): {
  intakePrefixEndId: string;
  intakePrefixSha256: string;
} {
  let d = prefixDigestInitial();
  for (const line of prefixLines) d = prefixDigestStep(d, line);
  let endId = "";
  const lastLine = prefixLines[prefixLines.length - 1];
  if (lastLine !== undefined) {
    try {
      const rec: unknown = JSON.parse(lastLine);
      if (rec !== null && typeof rec === "object" &&
          typeof (rec as { id?: unknown }).id === "string") {
        endId = (rec as { id: string }).id;
      }
    } catch {
      /* malformed tail line: endId stays "" — digest folded raw bytes */
    }
  }
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
  // g1s2-c1 MINOR-1: the owner-cli actor may produce ONLY owner-act
  // mode (an owner CLI cannot present an auditor-intake or
  // supervisor-derived triple).
  if (actor === "owner-cli" && mode !== "owner-act") return null;
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

/** A malformed `audit-filing` ACT PAYLOAD (g1s2-c1 MAJOR-1, NDR-f):
 * `malformed-input` is a DRAFT-DERIVATIVE code — its refusal record
 * must embed bytes re-digesting to the act's `draftSha256` — but a
 * payload-shape failure precedes any byte reading, so NO conforming
 * refusal is constructible. The act must never have been appended:
 * the typed error propagates (act-append-side payload validation is
 * the `faults.ts` step-5 surface); NOTHING is recorded. */
export class MalformedOwnerActError extends Error {}

/** An `audit-filing` act whose envelope `episodeId` differs from the
 * episode adjudicating it (g1s3-c5): the act belongs to a foreign
 * episode's log and must never be adjudicated (or have its refusal
 * appended) here. Thrown BEFORE any effect — the act must never have
 * been routed to this episode (the caller's routing/queue is the
 * surface that mis-routed it; nothing is recorded). */
export class ForeignActEpisodeError extends Error {}

/** A spool READ failure that is NOT absence (g1s2-c1 MAJOR-3,
 * §14.10.3: transient/permission I/O failures are RETRIED, never
 * terminalized into an irrevocable drift refusal). */
export class SpoolIoError extends Error {}

/** Digest-valid spool bytes that CANNOT be losslessly transported as
 * the `adjudicatedDraftBytes` UTF-8 wire string (g1s2-c1 MAJOR-2):
 * storage integrity territory — thrown loudly, never a refusal
 * carrying lossy bytes. */
export class IntegrityFaultError extends Error {}

/**
 * g1s2-c1 MAJOR-9 (`spool-a-write-fsync-order`): establish
 * DIRECTORY-ENTRY durability for a freshly created object — fsync
 * the containing directory so the NAME survives a crash (a file
 * fsync alone proves content survived, not that the directory entry
 * is durable). Best-effort per platform: directories cannot be
 * opened for fsync on some systems (e.g. Windows) — the failure is
 * swallowed ONLY there; on POSIX the fsync is real.
 */
export function syncDirEntry(dirPath: string): void {
  let dirFd: number;
  try {
    dirFd = openSync(dirPath, "r");
  } catch (e) {
    // A PLATFORM refusal to open a directory for fsync (Windows, some
    // network mounts) is the documented best-effort floor; a real I/O
    // fault on a directory that opened fine moments ago (EIO, ENOSPC)
    // is durability territory and rides the SAME retryable channel as
    // every other spool/journal I/O error (SpoolIoError). Swallowing
    // both alike let a genuine disk error silently pass the MAJOR-9
    // durability claim (g1s5-c1 audit finding 3).
    if (isDirFsyncPlatformRefusal(e)) return;
    throw new SpoolIoError(`syncDirEntry: cannot open "${dirPath}" for directory fsync: ${describeIoError(e)}`);
  }
  // g6-F2 (audit cycle 1) / g7-F3 (terra cycle 1): a close fault is
  // tracked SEPARATELY from the fsync outcome. The g6 shape let a
  // PLATFORM-REFUSED fsync (primary swallowed as "best effort") plus a
  // THROWING close fall into closeChecked, whose returned compound was
  // then re-classified as the platform refusal — the close fault
  // escaped nowheres and the durability step died silently. A close
  // fault is NEVER a platform refusal: even when the fsync itself was
  // legitimately refused, a fault releasing the descriptor is a real
  // I/O condition and must throw.
  let primary: unknown = null;
  let hadErr = false;
  let closeFault: unknown = null;
  let hadCloseFault = false; // MINOR-6: boolean sentinel — a seam close
  // throwing the literal `null` (or `undefined`) is STILL a fault; the
  // old `closeFault !== null` test returned SUCCESS for it (empirically
  // reproduced, g1s6-c2 audit).
  try {
    seamFsync(dirFd);
  } catch (e) {
    primary = e;
    hadErr = true;
  } finally {
    try {
      seamClose(dirFd);
    } catch (ce) {
      closeFault = ce;
      hadCloseFault = true;
    }
  }
  if (hadCloseFault) {
    // The close fault is the primary here: it is the error the caller
    // MUST see. The (possibly refused) fsync error rides along as the
    // cause chain when one exists.
    if (hadErr) {
      const wrapped = spoolIoWrapping(
        primary,
        `syncDirEntry: directory fsync of "${dirPath}" was refused AND the descriptor close faulted: ${describeIoError(closeFault)}; primary: `,
      );
      throw wrapped;
    }
    throw new SpoolIoError(`syncDirEntry: descriptor close fault while syncing "${dirPath}": ${describeIoError(closeFault)}`);
  }
  if (!hadErr) return;
  if (isDirFsyncPlatformRefusal(primary)) return;
  // g7-F4 (terra cycle 1): the wrapped SpoolIoError must RETAIN the
  // primary fsync error on its `cause` chain (spoolIoWrapping), not
  // flatten it into the message alone.
  throw spoolIoWrapping(
    primary,
    `syncDirEntry: directory fsync of "${dirPath}" failed: `,
  );
}

/** g7-F2 (terra cycle 1): create `dirPath` recursively AND establish
 * durability of EVERY name component on the path — up to and
 * including the filesystem root. The g6 shape (mkdir recursive + the
 * target + exactly ONE parent) left grandparent-and-above names
 * undurable when one recursive call created 2+ levels: an ack could
 * lose the episode dir's own name in ITS parent. The g6-F1 doctrine
 * ("an existing directory is visible, not durable") forbids trusting
 * any pre-existing ancestor either — so the sync walk climbs to the
 * root, where the chain terminates by definition (the root has no
 * name to lose). g7-F6 (terra cycle 1): the raw mkdirSync fault is
 * wrapped onto the retryable SpoolIoError channel — a broken-path or
 * disk fault here is an I/O condition, never a raw errno escape. */
function syncPathChain(dirPath: string): void {
  let d = path.resolve(dirPath);
  for (;;) {
    syncDirEntry(d);
    const parent = path.dirname(d);
    if (parent === d) break; // reached the filesystem root
    d = parent;
  }
}

/** g7-F6 (terra cycle 1): create `dirPath` recursively with the raw
 * mkdir fault wrapped onto the retryable SpoolIoError channel — a
 * broken-path or disk fault is an I/O condition, never a raw errno
 * escape. NAME durability is established by the caller's
 * `syncPathChain` BEFORE the ack (every write site walks the full
 * chain after the bytes land): a pre-write chain sync would be
 * redundant — the crash-atomicity question is answered at the ack
 * point, and every ack now walks the chain. */
function mkdirEnsured(dirPath: string): void {
  try {
    mkdirSync(dirPath, { recursive: true });
  } catch (e) {
    throw spoolIoWrapping(
      e,
      `mkdirEnsured: recursive mkdir of "${dirPath}" failed: `,
    );
  }
}

/** g6-F2 (audit cycle 1) / g7-F5 (terra cycle 1): close a descriptor
 * WITHOUT letting a close fault escape raw or clobber the primary
 * in-flight error (see `closeChecked` below).
 */
/** g7-F5: attach `secondary` as the cause of the DEEPEST error in
 * `primary`'s cause chain (never overwriting an existing link —
 * MINOR-4: a non-Error or cyclic tail slot ALREADY holds a value, and
 * assigning there would DESTROY forensic evidence, so an occupied
 * slot refuses: return false and let the caller's compound path
 * retain BOTH errors). Returns true on a clean attach, false if ANY
 * link in the chain refused the write (a frozen cause / occupied slot). */
function attachDeepestCause(primary: object, secondary: unknown): boolean {
  let node: { cause?: unknown } = primary as { cause?: unknown };
  // Walk to the deepest error that has no cause yet. Depth is bounded
  // by a cycle guard: a hand-built cyclic chain must not spin forever.
  const seen = new Set<unknown>([node]);
  for (;;) {
    if (node.cause === undefined || node.cause === null) {
      break; // this node is the deepest — attach here
    }
    const next: unknown = node.cause;
    if (!(next instanceof Error) || seen.has(next)) {
      // non-Error tail or cycle: the slot is OCCUPIED — attaching here
      // would overwrite it (MINOR-4: evidence destruction, not a
      // silent attach point). Refuse; the compound path keeps both.
      return false;
    }
    seen.add(next);
    node = next as { cause?: unknown };
  }
  try {
    const d = Object.getOwnPropertyDescriptor(node, "cause");
    if (d && (d.get || !d.writable || !d.configurable)) return false;
    node.cause = secondary;
    // VERIFY the attach stuck: a Proxy or exotic object can accept the
    // assignment silently yet not retain it.
    return node.cause === secondary;
  } catch {
    return false;
  }
}

/** g6-F2 / g7-F5 (terra cycle 1): close a descriptor WITHOUT letting a
 * close fault escape raw or clobber the primary in-flight error:
 *  - primary in flight + throwing close -> close fault appended to the
 *    DEEPEST cause of the chain (g6 blind `cause =` CLOBBERED an
 *    existing cause); a frozen chain -> a compound SpoolIoError
 *    retaining BOTH errors is thrown — nothing is dropped;
 *  - clean path + throwing close -> wrapped in SpoolIoError;
 *  - a silent close is UNACCEPTABLE for durability fds.
 */
function closeChecked(fd: number, primary: unknown, hadPrimaryError: boolean): unknown {
  try {
    seamClose(fd);
    return primary;
  } catch (ce) {
    if (hadPrimaryError) {
      // g7-F5: append to the deepest cause — a fresh primary gets the
      // close fault as its cause; a primary that already carries a
      // cause chain gets it appended at the END of the chain.
      if (primary !== null && typeof primary === "object" && attachDeepestCause(primary, ce)) {
        return primary;
      }
      // Frozen (or non-object) primary: the close fault cannot ride
      // its chain — throw a compound that retains BOTH errors. The
      // compound's cause is the primary; the close fault is in the
      // message AND is this error's own `closeCause` own-property so
      // programmatic access survives.
      const compound = new SpoolIoError(
        `descriptor close fault AFTER primary durability failure (compound — primary retained as cause): ${describeIoError(ce)} | primary: ${describeIoError(primary)}`,
      );
      try {
        (compound as { cause?: unknown }).cause = primary;
      } catch {
        /* a frozen compound — the primary is retained in the message */
      }
      // MINOR-4: the close fault is a FIRST-CLASS own property (not
      // just message text) so programmatic access survives even when
      // the primary could not attach anywhere on the chain.
      try {
        Object.defineProperty(compound, "closeCause", {
          value: ce,
          enumerable: false,
          writable: false,
          configurable: false,
        });
      } catch {
        /* a frozen compound object — the close fault survives in the message */
      }
      throw compound;
    }
    throw new SpoolIoError(`descriptor close fault after completed write path: ${describeIoError(ce)}`);
  }
}

/** g6-F2 (audit cycle 1): the outer wrap sites (write/fsync failure →
 * retryable SpoolIoError) must not DROP the primary fault — the wrapped
 * error carries it as `cause` so the full fault chain survives to the
 * retry/replay layer. */
function spoolIoWrapping(primary: unknown, prefix: string): SpoolIoError {
  const e = new SpoolIoError(`${prefix}${describeIoError(primary)}`);
  try {
    (e as { cause?: unknown }).cause = primary;
  } catch {
    /* frozen error object — nothing else can retain the primary */
  }
  return e;
}

/** Durability syscall seam (g6-F6, audit cycle 1): tests observe the
 * REAL fs calls this module makes (proving a durability step ran) and
 * inject faults at call sites a portable real fault cannot produce
 * (short write of a healthy fd, fsync of an openable file, close of a
 * healthy fd). Returns the restore function. Production code calls
 * with NO argument and the seam is a pass-through no-op. */
type FsSyscallPatch = {
  writeSync?: typeof writeSync;
  fsyncSync?: typeof fsyncSync;
  closeSync?: typeof closeSync;
};
let seamWrite: typeof writeSync = writeSync;
let seamFsync: typeof fsyncSync = fsyncSync;
let seamClose: typeof closeSync = closeSync;
export function __setFsSeam(patch: Partial<FsSyscallPatch>): () => void {
  const prev = { w: seamWrite, f: seamFsync, c: seamClose };
  seamWrite = patch.writeSync ?? writeSync;
  seamFsync = patch.fsyncSync ?? fsyncSync;
  seamClose = patch.closeSync ?? closeSync;
  return () => {
    seamWrite = prev.w;
    seamFsync = prev.f;
    seamClose = prev.c;
  };
}

/** g6-F3 (audit cycle 1): `writeSync` may return SHORT (a synchronous
 * write is allowed to write fewer bytes than requested without
 * throwing); a single call + fsync would then make only a PREFIX
 * durable under a success return. Loop until every byte is written —
 * the only correct durable-write primitive on this stack. */
function writeFully(fd: number, data: Buffer | string): void {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let offset = 0;
  while (offset < buf.length) {
    const written = seamWrite(fd, buf, offset);
    if (written <= 0) {
      throw new SpoolIoError(`writeSync made no progress at offset ${offset} of ${buf.length} bytes — never acked`);
    }
    offset += written;
  }
}

/** errno set of PLATFORM "this filesystem/OS cannot fsync a directory"
 * refusals — ONLY these are swallowed by syncDirEntry. (EACCES/EBADF
 * would be an implementation bug, EIO/ENOSPC a real fault — both
 * rethrown.) g1s5-c1: an error WITHOUT an errno code is no longer
 * swallowed — Node fs errors always carry `code`, so a codeless error
 * is an unknown fault, and the durability path fails closed toward
 * rethrow (same doctrine as MAJOR-3's "absent ONLY on ENOENT").
 * EPERM stays in the set: it is what Windows returns for opening a
 * directory (the documented cross-platform floor). */
function isDirFsyncPlatformRefusal(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  // g1s5-c4 (C4-F1): ENOTDIR LEFT the set — from openSync(path,"r") it
  // means a path component is a regular file (the directory ISN'T
  // THERE), a broken-path fault, never "this platform cannot fsync a
  // directory". Swallowing it let syncDirEntry pass MAJOR-9 silently
  // on a corrupt layout. EISDIR stays: it is what a platform may
  // return from fsync() itself on a directory handle.
  return code === "EINVAL" || code === "ENOTSUP" || code === "ENOSYS" || code === "EPERM" || code === "EISDIR";
}

function describeIoError(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return code ? `${code}: ${msg}` : msg;
}

/** g7-F6 (terra cycle 1): a readback fault on a JUST-WRITTEN durable
 * object is an operational I/O fault — it rides the retryable
 * SpoolIoError channel, never a raw errno escaping the intake (the
 * digest equality check itself stays a plain comparison at the call
 * site; only the READ is wrapped). */
function readbackBytes(filePath: string, what: string): Buffer {
  try {
    return readFileSync(filePath);
  } catch (e) {
    throw spoolIoWrapping(e, `${what}: readback of "${filePath}" failed: `);
  }
}

/** Recursive JSON-value equality (g1s6 audit F2): objects compare by
 * key SET and per-key value (insertion order irrelevant — JSON.parse
 * preserves line order but a reparsed record must agree regardless),
 * arrays by length and element order, scalars by ===, NaN never
 * equal, undefined key === missing key is NOT assumed: a key present
 * on one side with undefined is only equal if the other side lacks
 * it AND parses to undefined — JSON never emits undefined values, so
 * this stays inside the JSON domain. */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqualJson(x, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length || !ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k))) return false;
    return ak.every((k) => deepEqualJson(ao[k], bo[k]));
  }
  return false;
}

/**
 * PRODUCER (CLI side, §14.10.3): write the confirmed bytes to the
 * content-addressed spool and FSYNC BEFORE the act append (step (i)
 * of the two-step commit; a crash before (ii) leaves an inert orphan
 * spool object — no act exists to refuse, resolve, or owe). An
 * over-cap draft is refused AT INPUT (nothing written). An existing
 * entry must be byte-identical (content-addressing: an entry either
 * IS this byte-string or is corrupt — never silently replaced).
 *
 * BYTES-PRESERVING TRANSPORT (g1s2-c1 MAJOR-2): `adjudicatedDraftBytes`
 * is a UTF-8 STRING wire field, so a draft that is not valid UTF-8
 * can never produce a conforming draft-derivative refusal — the
 * PRODUCER refuses it AT INPUT like the over-cap case (nothing
 * written; no act may reference non-transportable bytes).
 */
export function spoolDraft(episodeDir: string, bytes: Buffer): string {
  if (bytes.length > DRAFT_CAP_BYTES) {
    throw new IntakeInputError(
      `draft is ${bytes.length} bytes > the ${DRAFT_CAP_BYTES}-byte cap — refused at input`,
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new IntakeInputError(
      "draft bytes are not valid UTF-8 — the adjudicated-bytes wire transport is lossless-UTF-8 only; refused at input (nothing written)",
    );
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  const p = spoolPath(episodeDir, sha);
  const dirPath = path.dirname(p);
  // g6-F1 (audit cycle 1): the `dirWasNew` existsSync VISIBILITY test
  // is GONE — "the directory already exists" proves nothing about its
  // name being DURABLE in the parent (a concurrent writer, or an
  // earlier crashed call, may have created it unsynced; existsSync
  // sees visible-but-undurable entries). The parent sync is now
  // UNCONDITIONAL on every ack path — an extra fsync of an
  // already-durable directory is harmless; the visibility assumption
  // was not.
  // g7-F2 (terra cycle 1): the g6 shape (mkdir recursive + target +
  // exactly ONE parent) left grandparent-and-above names undurable
  // when one recursive mkdir created 2+ levels (the episode dir's own
  // name in ITS parent could be lost after an ack). mkdirEnsured
  // creates the path (wrapped fault); the FULL chain is synced at the
  // ack point below (g7-F2) — before any ack, no ack, no claim.
  mkdirEnsured(dirPath);
  // g1s5-c2 (C2-F2): no existsSync-then-wx TOCTOU — "wx" IS the race
  // primitive (O_EXCL fails iff a concurrent writer won). On EEXIST the
  // entry is re-read and compared: byte-identical → dedup reuse;
  // divergent → integrity fault. The old check-then-write let a losing
  // racer's raw EEXIST escape the input-error channel.
  let fd: number;
  try {
    fd = openSync(p, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      // g1s6 (audit F1): every reuse-path I/O rides the retryable
      // SpoolIoError channel (MAJOR-3 doctrine) — a fault here is an
      // I/O condition, never a raw fs error escaping the intake.
      let prior: Buffer;
      try {
        prior = readFileSync(p);
      } catch (e2) {
        throw spoolIoWrapping(
          e2,
          `spoolDraft: existing entry ${path.basename(p)} could not be read for dedup comparison: `,
        );
      }
      if (!prior.equals(bytes)) {
        throw new IntakeInputError(
          `spool entry ${path.basename(p)} already stands with DIVERGENT bytes — integrity fault, never replaced`,
        );
      }
      // g1s6 (audit F1): byte-equality is NOT durability. The prior
      // write may be CRASH-PENDING (created but never fsynced) — acking
      // it here would let the act append proceed while the entry may
      // not survive. Establish durability for the reused entry too:
      // re-open and fsync the FILE, then the directory entry, before
      // returning. (Concurrent duplicate acks are idempotent — two
      // fsyncs of the same completed bytes are harmless.)
      let rfd: number;
      try {
        rfd = openSync(p, "r");
      } catch (e2) {
        throw spoolIoWrapping(
          e2,
          `spoolDraft: reused entry ${path.basename(p)} vanished/faulted before durability could be established: `,
        );
      }
      let rPrimary: unknown = null;
      let rHadErr = false;
      try {
        seamFsync(rfd);
      } catch (e2) {
        rPrimary = e2;
        rHadErr = true;
      } finally {
        // g6-F2 (audit cycle 1): the close rides the checked path — a
        // throwing close never escapes raw and never MASKS the fsync
        // fault (it is attached to it as `cause` instead).
        rPrimary = closeChecked(rfd, rPrimary, rHadErr);
      }
      if (rHadErr) {
        if (rPrimary instanceof SpoolIoError) throw rPrimary;
        throw spoolIoWrapping(
          rPrimary,
          `spoolDraft: reused entry ${path.basename(p)} could not be fsynced — never acked undurable: `,
        );
      }
      // g7-F2 (terra cycle 1): reuse re-establishes durability of the
      // file (above) AND the full name chain — the pre-existing dirs
      // are VISIBLE, not durable (g6-F1 doctrine), so the walk climbs
      // to the root rather than stopping at one parent.
      syncPathChain(dirPath);
      return sha; // verified existing entry reused (content-addressing dedup)
    }
    throw e;
  }
  let wPrimary: unknown = null;
  let wHadErr = false;
  try {
    writeFully(fd, bytes); // g6-F3: short writes looped, never acked short
    seamFsync(fd); // durable BEFORE the act append
  } catch (e) {
    wPrimary = e;
    wHadErr = true;
  } finally {
    wPrimary = closeChecked(fd, wPrimary, wHadErr); // g6-F2
  }
  if (wHadErr) {
    if (wPrimary instanceof SpoolIoError) throw wPrimary;
    throw spoolIoWrapping(
      wPrimary,
      `spoolDraft: write/fsync of the new entry failed — never acked undurable: `,
    );
  }
  // MAJOR-9: the NAME must survive too — directory-entry durability
  // before ack. g7-F2: the FULL chain (not just dir + one parent) —
  // every name component up to the root is synced before this ack
  // returns, so no acknowledged name can die in the crash window.
  syncPathChain(dirPath);
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
 * path and RE-HASH it against the act's `draftSha256`.
 *
 * g1s2-c1 MAJOR-3 (§14.10.3 "transient failures are retried, never
 * terminalized"): `absent` is reported ONLY on ENOENT — the path
 * genuinely not existing. EVERY other read failure (EPERM, ENOTDIR,
 * EIO, EISDIR…) throws `SpoolIoError`: a permission fault or a
 * transient I/O error must never be terminalized into an irrevocable
 * drift refusal of the act. */
export function readSpool(episodeDir: string, draftSha256: string): SpoolRead {
  // g1s5-c3 (C3-F1): validate OUTSIDE the io-catch — spoolPath's
  // IntakeInputError (bad digest) must escape on the INPUT channel,
  // never be laundered into a retryable SpoolIoError.
  const p = spoolPath(episodeDir, draftSha256);
  let raw: Buffer;
  try {
    raw = readFileSync(p);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { state: "absent" };
    throw new SpoolIoError(
      `spool read failed with a non-absence error (${(e as Error).message}) — retryable, never a drift refusal`,
    );
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
  // g1s2-c1 MAJOR-2: fatal UTF-8 decoding INSIDE the input-error
  // boundary — non-UTF-8 bytes are malformed INPUT (IntakeInputError),
  // never a raw TypeError escaping the adjudication's handled path
  // (the producer refuses such drafts at spoolDraft; reaching here
  // with them is still an input fault, never a crash class).
  let text: string;
  try {
    // g1s5-c1 C1-F2: `ignoreBOM: true` keeps a leading U+FEFF in the
    // decoded text (the WHATWG default silently STRIPS it), so a
    // BOM-prefixed draft fails the magic check below — the draft
    // contract is byte-exact from line 1, and a silently-stripped BOM
    // would accept bytes the sha256 re-hash already covered under a
    // text the parser never actually validated.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (e) {
    throw new IntakeInputError(`draft bytes are not valid UTF-8: ${(e as Error).message}`);
  }
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
   * may append) — the lineage authority */
  prefix: readonly PrefixRecord[];
  /** the SAME prefix as WRITER-CANONICAL LINES (the durable bytes as
   * read, one per record, in order) — the binding source per MAJOR-8;
   * the digest folds these raw lines, never a re-serialization */
  prefixLines: readonly string[];
  /** the audit-filing owner act being adjudicated (already durable) */
  act: OwnerAct<"audit-filing">;
  /** producer trio recorded on the CLI channel (§14.10.3 envelope
   * sources: the session on the confirming channel) */
  producer: AuditFinding["producer"];
  /** ids already standing (NDR-a collision refusal) */
  existingIds: ReadonlySet<string>;
  /** advisory timestamp */
  now: number;
  /** the injected G2 intake gate (MAJOR-7): REQUIRED on this path —
   * a code-fix record failing the gate is refused AND journaled as an
   * S5 decision record, never an `audit-filing-intake-refusal`. */
  normGate: NormGate;
  /** journal path for gate refusals (S5 decision log) */
  gateJournalPath: string;
}

export type FilingAdjudication =
  | { status: "applied"; finding: AuditFinding; artifactPath: string }
  | { status: "refused"; refusal: AuditFilingIntakeRefusal }
  /** MAJOR-7: the finding-shape-complete record failed the injected
   * G2 intake gate — an S5 DECISION refusal (journal entry), NEVER
   * an `audit-filing-intake-refusal` and never an admitted finding. */
  | { status: "refused-gate"; journal: NormGateRefusalJournalEntry };

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
  /** sha256 of the refused record's canonical JSONL line CONTENT
   * (`JSON.stringify(record)`, sans the trailing terminator — the
   * same line convention the prefix running digest folds); the
   * refused record is NEVER written anywhere, so this digest is the
   * reconstruction handle for a consumer holding the record (g1s4-c4
   * re-examined: a newline-inclusive digest would pin nothing) */
  lineSha256: string;
  /** non-null exactly when the gate ERRORED (fail-closed) — the
   * error message, journaled */
  gateError: string | null;
}

/**
 * g6-F1 (audit cycle 1, Terra): open a journal for a durable append
 * AND establish that the appended record will be INDEPENDENTLY
 * READABLE. `writeFully` can die after writing a PREFIX of the JSON
 * line (or after zero progress), leaving a torn tail; opening `"a"`
 * naively would append the retry's complete record DIRECTLY after the
 * partial bytes — one invalid line, both decisions unreadable.
 * (A torn tail is only possible if a PREVIOUS append failed: every
 * SUCCESSFUL append ends with a newline — the record is written as
 * `JSON + "\n"` and the ack requires the full loop.)
 *  - a trailing newline (or empty journal) -> a clean `"a"` open
 *    (the common path);
 *  - NO trailing newline -> ONLY THE TORN SUFFIX is quarantined
 *    (MAJOR-1 fix, g1s6-c2 audit): the bytes AFTER the last newline
 *    are COPIED (read + durable "wx" create) to a `.torn.*` sibling,
 *    THEN the LIVE journal is `ftruncateSync`-cut at the last newline
 *    so previously acked records STAY on the live path. (A hard link
 *    was tried first and is WRONG: the sibling shares the inode, so
 *    the truncation AND every later append mutate the "forensic"
 *    copy too — proven by probe.) The old shape renamed the WHOLE
 *    file aside, which silently hid every acked record BEFORE the
 *    torn tail from every reader (no reader merges `.torn.*`
 *    siblings).
 *    Durability ORDER is the recovery contract: the suffix copy AND
 *    its NAME (dir-sync, g1s7-F2) are durable BEFORE the truncation
 *    destroys those bytes. Any crash in between leaves either the
 *    live journal unmodified (next open recovers again) or a redundant
 *    forensic sibling — never a lost byte. (Cutting before the name
 *    sync left a window where the suffix was gone from the journal
 *    AND its name was not durable — a crash there loses the forensic
 *    bytes with the un-synced directory entry.) If any step faults,
 *    the append is REFUSED with the live journal unmodified (fail
 *    closed — nothing is ever appended behind a torn tail).
 */
function openJournalAppended(journalPath: string): { jfd: number; fence: JournalFenceToken } {
  // g1s7-F1 (audit of g1s6-c2): the FENCE is acquired HERE, before the
  // tail check, and travels back with the fd — every caller gets a
  // fenced journal and the release path can never be forgotten
  // (MAJOR-2's contract lives in the primitive that reads the tail).
  const fence = acquireJournalLock(journalPath);
  let jfd: number;
  try {
    // g7: "a+" (not "a") — the torn-tail check must READ the last
    // byte; append semantics are unchanged (every write goes to the
    // end regardless of the file offset).
    jfd = openSync(journalPath, "a+");
  } catch (e) {
    throw spoolIoWrapping(e, `norm-gate journal: could not open "${journalPath}" for append: `);
  }
  let endsWithNewline = true;
  let prior: import("node:fs").Stats | null = null;
  let priorFault: unknown = null;
  try {
    prior = fstatSync(jfd);
  } catch (e) {
    priorFault = e;
  }
  if (prior === null) {
    // fstat faulted on the freshly opened fd — close (checked) and
    // refuse the append (torn-record detection failed).
    closeChecked(jfd, priorFault, true);
    throw spoolIoWrapping(priorFault, `norm-gate journal: fstat of "${journalPath}" failed — torn-record detection failed, append refused: `);
  }
  if (prior.size > 0) {
    const last = Buffer.alloc(1);
    let got: number;
    try {
      got = readSync(jfd, last, 0, 1, prior.size - 1);
    } catch (e) {
      closeChecked(jfd, e, true);
      throw spoolIoWrapping(e, `norm-gate journal: could not read the tail of "${journalPath}" — torn-record detection failed, append refused: `);
    }
    if (got !== 1) {
      closeChecked(jfd, null, false);
      throw new SpoolIoError(`norm-gate journal: short read of the last byte of "${journalPath}" (got ${got}) — torn-record detection failed, append refused`);
    }
    endsWithNewline = last[0] === 0x0a;
  }
  if (endsWithNewline) return { jfd, fence };
  // ---- MAJOR-1 fix (g1s6-c2): torn tail — quarantine the SUFFIX
  // ONLY. Byte boundary: one past the LAST newline of the file (0 if
  // the whole file is one torn record). Read in bounded windows from
  // the tail; a short/failed window read REFUSES the append (the
  // boundary cannot be established).
  let prefixSize = 0;
  {
    const CHUNK = 65536;
    const buf = Buffer.alloc(CHUNK);
    let found = false;
    for (let end = prior.size; end > 0 && !found; end -= CHUNK) {
      const start = Math.max(0, end - CHUNK);
      let got = 0;
      try {
        got = readSync(jfd, buf, 0, end - start, start);
      } catch (e) {
        closeChecked(jfd, e, true);
        throw spoolIoWrapping(e, `norm-gate journal: could not scan the torn tail of "${journalPath}" for the last newline — append refused: `);
      }
      if (got !== end - start) {
        closeChecked(jfd, null, false);
        throw new SpoolIoError(`norm-gate journal: short window read scanning "${journalPath}" (got ${got} of ${end - start}) — last newline not established, append refused`);
      }
      const idx = buf.lastIndexOf(0x0a, got - 1);
      if (idx >= 0) {
        prefixSize = start + idx + 1;
        found = true;
      }
    }
  }
  // Forensic copy of the TORN SUFFIX (bytes [prefixSize, size)) to a
  // `.torn.*` sibling — durable BEFORE the live journal is cut, so
  // those bytes exist somewhere at every instant.
  const suffixLen = prior.size - prefixSize;
  const quarantine = `${journalPath}.torn.${process.pid}.${Date.now()}`;
  let qfd: number;
  try {
    qfd = openSync(quarantine, "wx");
  } catch (e) {
    closeChecked(jfd, e, true);
    throw spoolIoWrapping(e, `norm-gate journal: creating the torn-suffix quarantine "${quarantine}" failed — append refused (nothing is written behind a torn tail): `);
  }
  let qPrimary: unknown = null;
  let qHadErr = false;
  try {
    const CHUNK = 65536;
    const buf = Buffer.alloc(suffixLen);
    let off = 0;
    while (off < suffixLen) {
      const want = Math.min(CHUNK, suffixLen - off);
      const got = readSync(jfd, buf, off, want, prefixSize + off);
      if (got !== want) {
        throw new SpoolIoError(`norm-gate journal: short read copying the torn suffix of "${journalPath}" (got ${got} of ${want}) — append refused`);
      }
      off += got;
    }
    writeFully(qfd, buf); // g6-F3 loop
    seamFsync(qfd); // the forensic bytes are durable BEFORE the cut
  } catch (e) {
    qPrimary = e;
    qHadErr = true;
  } finally {
    qPrimary = closeChecked(qfd, qPrimary, qHadErr); // g6-F2
  }
  if (qHadErr) {
    // Live journal untouched (torn tail still in place): nothing was
    // destroyed, the next open recovers again.
    closeChecked(jfd, qPrimary, true);
    throw spoolIoWrapping(qPrimary, `norm-gate journal: durable quarantine of the torn suffix of "${journalPath}" failed — append refused: `);
  }
  // g1s7-F2 (audit of g1s6-c2): the quarantine NAME is made durable
  // BEFORE the truncation destroys the prefix bytes. The old order
  // (truncate → fsync truncate → sync the name) left a crash window
  // where the torn suffix was gone from the live journal AND its
  // quarantine name was not yet in the directory — the forensic bytes
  // existed only in the (unlinked-but-open-cap-free) sibling inode the
  // crash took with it. A filesystem that recovers by silently
  // re-creating a missing name is NOT a durability guarantee; the
  // ordering below makes the name's survival a prerequisite of the
  // cut. If the name sync faults, the append is REFUSED with the live
  // journal untouched (the quarantine sibling stays or is cleaned
  // below — never orphaned by a partial cut).
  // g1s7-F1: the quarantine fsync is a completed durable phase —
  // re-age before the next one (name sync) on a long recovery.
  journalHeartbeat(fence);
  try {
    syncPathChain(path.dirname(journalPath));
  } catch (e) {
    // Fail closed BEFORE the cut: the live journal still carries the
    // torn tail (the next open recovers it again), so the quarantine
    // sibling we just wrote is redundant, not required — remove it so
    // a failed recovery leaves no stray forensic duplicate, then
    // refuse. Cleanup is best-effort: its failure never masks the
    // refusal.
    try {
      unlinkSync(quarantine);
    } catch {
      /* best-effort: a surviving sibling is FORENSIC-REDUNDANT
         (the torn tail is still in the live journal — the next open
         re-quarantines under a fresh name and the duplicate suffix
         content is identical) — the refusal reason stands. */
    }
    closeChecked(jfd, e, true);
    if (e instanceof SpoolIoError) throw e;
    throw spoolIoWrapping(e, `norm-gate journal: durability of the quarantined torn suffix's name failed: `);
  }
  try {
    ftruncateSync(jfd, prefixSize);
  } catch (e) {
    closeChecked(jfd, e, true);
    throw spoolIoWrapping(e, `norm-gate journal: cutting "${journalPath}" at the last newline failed — append refused: `);
  }
  try {
    seamFsync(jfd); // the TRUNCATION is durable before any append
  } catch (e) {
    closeChecked(jfd, e, true);
    throw spoolIoWrapping(e, `norm-gate journal: fsync of the cut journal "${journalPath}" failed: `);
  }
  // The recovery below can be LONG (multi-MB torn tails); re-age the
  // fence before its next durable phase so a patient reader never
  // mistakes this holder for crashed (g1s7-F1 heartbeat).
  journalHeartbeat(fence);
  return { jfd, fence };
}

/* ================= MAJOR-2: cross-process single-writer fence ======= */

/** Lock file suffix (part of the journal's contract: ANY writer of a
 * journal path — in-process or a separate process over the same
 * directory — must hold `<journalPath>.lock` across the ENTIRE
 * tail-check + append, so a concurrent live append is never
 * classified as crash damage by another writer's torn-tail check
 * (MAJOR-2, g1s6-c2 audit). */
const JOURNAL_LOCK_SUFFIX = ".lock";
/** How long a writer waits for the fence before REFUSING (fail closed:
 * a contended journal append is never silently stacked behind
 * another writer's in-flight record). */
const JOURNAL_LOCK_TIMEOUT_MS = 2000;
const JOURNAL_LOCK_RETRY_MS = 10;
/** A lock whose mtime is older than this is STALE — its holder
 * crashed between create and release. Bounded-risk takeover: a
 * holder that survives its own append longer than this window could
 * be double-admitted, so the append+release window must stay far
 * inside it (journal appends are single-record, sub-second I/O). */
const JOURNAL_LOCK_STALE_MS = 30000;

/** Synchronous sleep for the lock retry loop (no event loop in the
 * intake path to yield to — Atomics.wait is the portable blocking
 * timer). */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Acquire the journal's single-writer fence: O_EXCL create is the
 * cross-process atomic test-and-set (the ONLY primitive here that two
 * processes cannot both win). Holder identity (pid) is recorded for
 * forensics; mutual exclusion comes from the exclusive create itself.
 * A live holder's lock is waited on up to JOURNAL_LOCK_TIMEOUT_MS,
 * then the append is REFUSED. A stale lock (crashed holder) is
 * unlinked and contested again — the unlink race between two takers
 * still ends in exactly one O_EXCL winner. */
/** The fence TOKEN handed back with the journal fd (g1s7-F1): the
 * path plus the holder identity WRITTEN INTO the fence at create.
 * Release and heartbeat are verified against this token — the old
 * shape released/aged the PATH whatever it now held, so a takeover
 * (stale window misjudged, clock rewind) let writer B hold the fence
 * while writer A's blind release removed it and admitted a third
 * writer onto a journal B was still appending to. */
interface JournalFenceToken {
  lockPath: string;
  /** `<pid>-<random hex>` — unique across processes AND across
   * re-acquires in one process (pid alone cannot tell two generations
   * of the same holder apart). */
  holderId: string;
  /** mtime of the last DURABLE phase (append fsync / quarantine
   * fsync / name sync) — the heartbeat clock. */
  lastDurableMs: number;
}

/** Heartbeat cadence: a fence is re-aged whenever it has been more
 * than this long since the last durable phase (so normal sub-second
 * appends issue ZERO heartbeats and the STALE window stays exactly a
 * crashed-holder bound). A holder that goes quiet for STALE_MS is
 * presumptively crashed; one that is merely SLOW between durable
 * phases keeps its fence — every long phase is itself fsync'd, and
 * heartbeat touch precedes the next fsync inside the still-held
 * window, so the durable state always survives the toucher. */
const JOURNAL_LOCK_HEARTBEAT_MS = 5000;

/** Age the fence (g1s7-F1) between durable phases of a long append.
 * ENOENT is NOT tolerated: the name being gone mid-append means a
 * staleness-taker already admitted another writer — the contract is
 * broken and the caller MUST NOT ack. The record may well be
 * journaled (append-only, at-least-once semantics) — which is why
 * the fault THROWS instead of releasing silently. */
function journalHeartbeat(token: JournalFenceToken): void {
  const now = Date.now();
  if (now - token.lastDurableMs < JOURNAL_LOCK_HEARTBEAT_MS) return;
  token.lastDurableMs = now;
  try {
    const t = new Date(now);
    utimesSync(token.lockPath, t, t);
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      throw new SpoolIoError(
        `norm-gate journal: the single-writer fence "${token.lockPath}" was TAKEN OVER mid-append (its name is gone) — the append is REFUSED for ack (journal-then-ack: the record may be journaled; a retry may duplicate it — never a silent ack behind a second writer)`,
      );
    }
    throw spoolIoWrapping(e, `norm-gate journal: heartbeat touch of the fence "${token.lockPath}" failed — append refused: `);
  }
}

function acquireJournalLock(journalPath: string): JournalFenceToken {
  const lockPath = journalPath + JOURNAL_LOCK_SUFFIX;
  const deadline = Date.now() + JOURNAL_LOCK_TIMEOUT_MS;
  const holderId = `${process.pid}-${randomBytes(8).toString("hex")}`;
  for (;;) {
    try {
      const lfd = openSync(lockPath, "wx");
      let lPrimary: unknown = null;
      let lHadErr = false;
      try {
        writeFully(lfd, `${process.pid} ${holderId}\n`); // holder identity (forensic + token-verified)
        seamFsync(lfd); // the FENCE is durable before the append
      } catch (e) {
        lPrimary = e;
        lHadErr = true;
      } finally {
        lPrimary = closeChecked(lfd, lPrimary, lHadErr);
      }
      if (lHadErr) throw lPrimary;
      return { lockPath, holderId, lastDurableMs: Date.now() };
    } catch (e) {
      if ((e as NodeJS.ErrnoException | null)?.code !== "EEXIST") {
        throw spoolIoWrapping(e, `norm-gate journal: could not create the single-writer fence "${lockPath}": `);
      }
      // EEXIST — holder alive or crashed?
      let mtimeMs: number;
      try {
        mtimeMs = statSync(lockPath).mtimeMs;
      } catch (se) {
        if ((se as NodeJS.ErrnoException | null)?.code === "ENOENT") continue; // released mid-race — contest again
        throw spoolIoWrapping(se, `norm-gate journal: could not stat the fence "${lockPath}": `);
      }
      if (Date.now() - mtimeMs > JOURNAL_LOCK_STALE_MS) {
        // g1s7-F1: the takeover contest is a RENAME, not an unlink.
        // rename moves the NAME: exactly one taker wins it, and the
        // loser's later verified release can never remove the NEW
        // fence (it reads content by path and finds another holder's
        // token). The old unlink+O_EXCL sequence let two takers both
        // win an O_EXCL round (taker 1 unlinks, taker 2 unlinks +
        // creates, taker 1 creates → EEXIST loop, then both cycle)
        // and — worse — freed the name for a non-contender while a
        // contest was still in flight. An ENOENT rename lost to a
        // racer (or a release) simply re-contests.
        const take = `${lockPath}.stale.${process.pid}.${randomBytes(6).toString("hex")}`;
        try {
          renameSync(lockPath, take);
          try {
            unlinkSync(take); // the ex-fence has no owner — remove it (best-effort)
          } catch (ue) {
            if ((ue as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
              throw spoolIoWrapping(ue, `norm-gate journal: could not remove the contested stale fence "${take}": `);
            }
          }
        } catch (ue) {
          if ((ue as NodeJS.ErrnoException | null)?.code === "ENOENT") continue; // lost the rename — contest again
          throw spoolIoWrapping(ue, `norm-gate journal: could not contest the stale fence "${lockPath}": `);
        }
        continue; // name freed with single-winner semantics — O_EXCL below admits exactly one writer
      }
      if (Date.now() >= deadline) {
        throw new SpoolIoError(
          `norm-gate journal: single-writer fence "${lockPath}" held by another writer for over ${JOURNAL_LOCK_TIMEOUT_MS}ms — append REFUSED (MAJOR-2: no append runs unguarded; retry later)`,
        );
      }
      sleepMs(JOURNAL_LOCK_RETRY_MS);
    }
  }
}

/** Release the fence BY TOKEN (g1s7-F1). The old blind unlink took
 * the PATH whatever it now held: after a takeover it removed the
 * NEW holder's fence and admitted a third writer onto a journal the
 * second holder still appended to. The verified release reads the
 * fence content first — OUR holderId or NO unlink. ENOENT (a
 * staleness-taker already removed it) is the contract surviving;
 * foreign content is a TAKEOVER: throw (never silently release —
 * the append's ack is refused by the thrower, journal-then-ack). */
function releaseJournalLock(token: JournalFenceToken): void {
  let content: string;
  try {
    content = readFileSync(token.lockPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return; // already taken — fence contract survives
    throw spoolIoWrapping(e, `norm-gate journal: could not read the fence "${token.lockPath}" before releasing: `);
  }
  if (!content.trim().split(/\s+/).some((f) => f === token.holderId)) {
    throw new SpoolIoError(
      `norm-gate journal: the single-writer fence "${token.lockPath}" was TAKEN OVER during the append (its content is not this holder's token) — refusing to release another writer's fence (journal-then-ack: the record is journaled, the ack is refused by this fault)`,
    );
  }
  try {
    unlinkSync(token.lockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return;
    throw spoolIoWrapping(e, `norm-gate journal: releasing the single-writer fence "${token.lockPath}" failed: `);
  }
}

/** @internal probe seam (g1s7-F1 tests): acquire a fence exactly as
 * the intake path does and drive heartbeat/release with the REAL
 * token logic. Not part of the intake contract. */
export function __journalFenceProbe(journalPath: string): { heartbeat: () => void; release: () => void } {
  const token = acquireJournalLock(journalPath);
  return { heartbeat: () => journalHeartbeat(token), release: () => releaseJournalLock(token) };
}

/** Run the gate over a candidate record and journal a refusal
 * (shared by BOTH admission paths — owner-filing and auditor —
 * MAJOR-7: the gate sits on every applicable code-fix admission).
 * Returns null on PASS. Journal write is durable BEFORE the ack
 * returns (journal-then-ack) with directory-entry durability
 * (MAJOR-9). */
function gateOrJournal(
  finding: AuditFinding,
  normGate: NormGate,
  journalPath: string,
  ids: { takenIds: ReadonlySet<string>; extraTaken?: string[] },
  meta: { ts: number; episodeId: string; taskId: string | null },
): NormGateRefusalJournalEntry | null {
  let gateResult: { pass: true } | { pass: false; code: string };
  let gateError: string | null = null;
  try {
    gateResult = normGate(finding);
  } catch (e) {
    // g1s5-c4 (C4-F2): a thrown non-Error (string/undefined) has no
    // `.message` — `(e as Error).message` was undefined and
    // JSON.stringify DROPPED the gateError key entirely, so the
    // journal recorded no gate error while claiming to. describeIoError
    // (Error-or-String extraction) is the same channel every I/O
    // description uses.
    gateError = describeIoError(e);
    gateResult = { pass: false, code: "gate-error" }; // fail-closed
  }
  if (gateResult.pass) return null;
  const line = JSON.stringify(finding);
  const taken = new Set(ids.takenIds);
  for (const x of ids.extraTaken ?? []) taken.add(x);
  // g1s4-c4 RE-EXAMINED: the refused finding is NEVER written to any
  // log, so there is no "line as written" to pin — the field's
  // contract is the digest of the refused record's CANONICAL LINE
  // CONTENT (the exact bytes s5log would emit as one line, sans the
  // terminator — the same line-content convention the prefix running
  // digest folds), reconstructed by any consumer that holds the
  // record. A newline-inclusive digest would pin nothing.
  const lineSha256 = createHash("sha256").update(line, "utf8").digest("hex");
  const journal: NormGateRefusalJournalEntry = {
    kind: "norm-gate-refusal",
    id: mintFindingId(taken),
    ts: meta.ts,
    episodeId: meta.episodeId,
    taskId: meta.taskId,
    refusalCode: gateResult.code,
    lineSha256,
    gateError,
  };
  const dirPath = path.dirname(journalPath);
  // g6-F1 (audit cycle 1): unconditional parent sync — visibility of
  // the journal dir proved nothing about the durability of ITS name.
  mkdirEnsured(dirPath); // g7-F2: full-chain durable creation + wrapped mkdir fault
  // MAJOR-2 (g1s6-c2 audit): the ENTIRE tail-check + append sequence
  // runs under the cross-process single-writer fence. Unlocked, a
  // second process appending to the same journalPath mid-write got
  // its partial record classified as crash damage by this writer's
  // torn-tail check and renamed away while its own writer still
  // fsync'd and returned success against the renamed inode — the
  // active path lost a record the reader side claims acked.
  // g1s7-F1 (audit of g1s6-c2): the FENCE, the fd, and the release
  // live INSIDE openJournalAppended — the caller receives
  // {jfd, lockPath} already fenced and releases by TOKEN. The old
  // shape (caller acquired, caller released around a helper it also
  // called) let a second acquire on the same path take over the
  // first holder's stale-looking fence and release the takeover
  // onto a journal the first writer still held.
  let jPrimary: unknown = null;
  let jHadErr = false;
  const { jfd, fence } = openJournalAppended(journalPath); // g6-F1: torn-tail-safe append, FENCED (g1s7-F1)
  try {
    try {
      writeFully(jfd, JSON.stringify(journal) + "\n"); // g6-F3
      seamFsync(jfd);
    } catch (e) {
      jPrimary = e;
      jHadErr = true;
    }
    try {
      jPrimary = closeChecked(jfd, jPrimary, jHadErr); // g6-F2
    } catch (ce) {
      // Close fault on an otherwise-clean path (or a compound): the
      // append is NOT acked — record the fault for the wrap site.
      if (!jHadErr) {
        jHadErr = true;
        jPrimary = ce;
      }
      // A primary fault already owns jPrimary; closeChecked returned
      // it with the close fault attached to its chain.
    }
  } finally {
    // g1s7-F1: every exit path releases the fence BY TOKEN (verified
    // against the holder written at create — never the blind unlink
    // of whatever path the fence happens to hold). A release FAULT
    // (takeover detected) must never mask a primary journal fault:
    // the journal outcome owns the error, the leaked fence self-heals
    // after JOURNAL_LOCK_STALE_MS. With a clean append the takeover
    // fault DOES propagate — the ack is refused (journal-then-ack).
    try {
      releaseJournalLock(fence);
    } catch (re) {
      if (jHadErr) {
        // Journal fault owns the outcome; release fault is secondary
        // (fence self-heals via the staleness window).
      } else {
        jHadErr = true;
        jPrimary = re;
      }
    }
  }
  if (jHadErr) {
    if (jPrimary instanceof SpoolIoError) throw jPrimary;
    throw spoolIoWrapping(
      jPrimary,
      `norm-gate journal append failed — refusal NOT journaled, never acked: `,
    );
  }
  syncPathChain(dirPath); // MAJOR-9 + g7-F2: full chain, not dir + one parent
  return journal;
}

/**
 * g1s2-c1 MAJOR-4: the COMPLETE `Repro` wire shape (§14.10.1;
 * `records.ts` `Repro`) — kind in the closed set AND all three
 * operand strings present; a NON-"none" kind requires all three
 * non-empty (falsifiability: an empty observed/expected pair is not
 * re-runnable next cycle). `kind:"none"` carries empty operands.
 * The NDR-b severity floor is a SEPARATE check (below this shape
 * check); this is the finding-schema floor every admission shares.
 */
export function reproWireShapeOk(repro: unknown): boolean {
  if (repro === null || typeof repro !== "object" || Array.isArray(repro)) return false;
  const r = repro as Record<string, unknown>;
  if (!inSet(REPRO_KIND_CLOSED_SET, r["kind"])) return false;
  const fields = ["command", "preFixObserved", "postFixExpected"];
  for (const f of fields) if (typeof r[f] !== "string") return false;
  if (r["kind"] !== "none") {
    for (const f of fields) if ((r[f] as string) === "") return false;
  }
  return true;
}

/**
 * g1s2-c1 MAJOR-5: the SHARED finding-schema floor every admission
 * path enforces (owner filing AND auditor intake): non-empty
 * single-line bounded `claim`, ≥1 non-empty `evidenceRefs` string,
 * complete `repro` wire shape. Returns the failure list (empty ⇒
 * conforms).
 */
export function findingSchemaFloorFails(h: {
  claim: unknown;
  evidenceRefs: unknown;
  repro: unknown;
}): string[] {
  const fails: string[] = [];
  const c = h.claim;
  if (typeof c !== "string" || c === "" || c.length > CLAIM_MAX_CHARS ||
      c.includes("\n") || c.includes("\r")) {
    fails.push("claim");
  }
  const e = h.evidenceRefs;
  if (!Array.isArray(e) || e.length < 1 ||
      e.some((x) => typeof x !== "string" || x === "") ||
      !e.every((x, i, arr) => arr.indexOf(x) === i)) {
    // g1s4-c3: DISTINCT evidence refs (§14.10.1 "distinct artifact
    // refs"); records.ts `isFindingClaimSatisfied` refuses duplicates,
    // so intake must never admit a record the terminal floor would
    // refuse.
    fails.push("evidenceRefs");
  }
  if (!reproWireShapeOk(h.repro)) fails.push("repro");
  return fails;
}

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
 *  (10) NDR-b intake repro floor + MAJOR-4 repro wire-shape floor
 *       → finding-intake-invalid
 *  (11) MAJOR-7 G2 intake gate (code-fix records): gate failure ⇒
 *       S5 DECISION journal refusal (`refused-gate`), never a
 *       filing-code refusal
 */
export function adjudicateFiling(input: FilingAdjudicationInput): FilingAdjudication {
  const { episodeDir, episodeId, prefix, act, producer, existingIds, now } = input;
  // g1s5-c4 (C4-F3): EQUAL LENGTH IS NOT AGREEMENT. The two views must
  // describe the SAME RECORDS — not just the same identities. An early
  // content check compared only `id`/`kind` (g1s6 audit F2: an
  // `owner-act` line could carry op:"audit-filing" while prefix[i]
  // claims op:"residual-cure" — cure resolution reads the CLAIMED
  // view while the refusal binding digests the FOREIGN bytes). The
  // check now pins the full record: line i must parse to a value
  // recursively identical to prefix[i] (key order irrelevant, arrays
  // ordered).
  if (input.prefixLines.length !== prefix.length) {
    throw new Error(`prefixLines (${input.prefixLines.length}) and prefix (${prefix.length}) diverge — implementation fault`);
  }
  for (let i = 0; i < prefix.length; i++) {
    const line = input.prefixLines[i] as string; // length guard above
    const claimed = prefix[i] as PrefixRecord; // length guard above
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`prefixLines[${i}] is not JSON while prefix[${i}] claims record ${claimed.id} — divergent views, implementation fault`);
    }
    if (!deepEqualJson(parsed, claimed)) {
      throw new Error(`prefixLines[${i}] does not carry record ${claimed.kind}/${claimed.id} — divergent views, implementation fault`);
    }
  }
  const binding = prefixBinding(input.prefixLines);
  // (0) act-episode binding (g1s3-c5, auditor-path symmetry): the
  // auditor envelope check refuses a candidate naming a foreign
  // episode; the owner path must not be weaker — an act whose
  // ENVELOPE episodeId differs from the episode adjudicating it was
  // routed wrong and must never have reached this episode's log.
  // Like the stage-(1) payload failure this PRECEDES any effect:
  // typed throw, nothing recorded.
  if (act.episodeId !== episodeId) {
    throw new ForeignActEpisodeError(
      `act ${act.id} carries episodeId ${JSON.stringify(act.episodeId)} but is adjudicated in ${JSON.stringify(episodeId)} — foreign-episode act, never adjudicated`,
    );
  }
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
  // v28 R5-C20P-2 — absence is not a third state). A failure here is
  // NOT a refusal (g1s2-c1 MAJOR-1): `malformed-input` is
  // draft-derivative — its record must embed bytes re-digesting to
  // `draftSha256` — yet a payload-shape failure precedes any byte
  // reading, so no conforming refusal is constructible. The act must
  // never have been appended; the typed error propagates.
  const okPayload =
    payload !== null && typeof payload === "object" &&
    typeof payload.findingDraftRef === "string" &&
    isSha256Hex(payload.draftSha256) &&
    typeof payload.claim === "string" &&
    typeof payload.cycle === "number" &&
    Number.isInteger(payload.cycle) && payload.cycle >= 0 &&
    (payload.taskId === null || typeof payload.taskId === "string") &&
    (payload.cureActRef === null || typeof payload.cureActRef === "string");
  if (!okPayload) throw new MalformedOwnerActError("audit-filing payload fails the closed 5+1-field shape");

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
  // MAJOR-2: `adjudicatedDraftBytes` preserves the EXACT adjudicated
  // bytes over a UTF-8 wire string — embeddable only after a
  // lossless round-trip check. The producer refuses non-UTF-8 drafts
  // at input, so reaching a non-round-tripping spool means storage
  // integrity has already failed: throw loudly, never embed lossy
  // bytes (a digest-valid-but-lossy refusal is unreplayable).
  const embed = (): string => {
    const s = draftBytes.toString("utf8");
    if (Buffer.from(s, "utf8").equals(draftBytes)) return s;
    throw new IntegrityFaultError(
      `spool bytes digest to draftSha256 ${payload.draftSha256} but are not losslessly embeddable as the adjudicated-bytes UTF-8 wire string — integrity fault, never a lossy refusal`,
    );
  };

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
      (h["evidenceRefs"] as unknown[]).some((x) => typeof x !== "string" || x === "") ||
      !(h["evidenceRefs"] as unknown[]).every(
        (x, i, arr) => (arr as unknown[]).indexOf(x) === i,
      )) {
    // g1s4-c3: distinct refs (§14.10.1) — parity with the shared
    // floor; the terminal claim floor refuses duplicates, so intake
    // must not admit them either.
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

  // (9) NDR-b intake floor + g1s2-c1 MAJOR-4 finding-schema floor:
  // the COMPLETE repro wire shape (§14.10.1: kind + all three operand
  // strings; a non-"none" kind requires non-empty operands) is
  // enforced for EVERY admission, and `repro.kind:"none"` is refused
  // for NON-MINOR findings for EVERY producer (route-free — the
  // canonical rule).
  const repro = h["repro"] as Repro;
  const severity = h["severity"] as Severity;
  if (!reproWireShapeOk(repro)) {
    return refusal("finding-intake-invalid", { adjudicatedDraftBytes: embed() });
  }
  if (!isFindingReproSatisfied({ severity, repro })) {
    return refusal("finding-intake-invalid", { adjudicatedDraftBytes: embed() });
  }

  // (10) applied: NDR-a mint, immutable artifact copy, claimDigest.
  const id = mintFindingId(existingIds);
  const findingRefRel = path.join("findings", id);
  const artifactPath = path.join(episodeDir, findingRefRel);
  {
    const artDir = path.dirname(artifactPath);
    // g7-F2/F6 (terra cycle 1): full-chain durable creation (wrapped
    // mkdir fault on the retryable channel); the artifact open rides
    // the same channel (a raw EACCES/EMFILE must reach the retry layer
    // as SpoolIoError, never raw errno).
    mkdirEnsured(artDir);
    let fd: number;
    try {
      fd = openSync(artifactPath, "wx");
    } catch (e) {
      throw spoolIoWrapping(
        e,
        `finding artifact: could not open "${artifactPath}" for exclusive write: `,
      );
    }
    let aPrimary: unknown = null;
    let aHadErr = false;
    try {
      writeFully(fd, draftBytes); // g6-F3
      seamFsync(fd);
    } catch (e) {
      aPrimary = e;
      aHadErr = true;
    } finally {
      aPrimary = closeChecked(fd, aPrimary, aHadErr); // g6-F2
    }
    if (aHadErr) {
      if (aPrimary instanceof SpoolIoError) throw aPrimary;
      throw spoolIoWrapping(
        aPrimary,
        `finding artifact write failed — admission NEVER acked: `,
      );
    }
    syncPathChain(artDir); // MAJOR-9 + g7-F2: full chain before ack
  }
  // self-check: stored bytes ARE the adjudicated bytes (confirmed /
  // spool / stored / attested digest — ONE byte-string).
  const storedDigest = createHash("sha256").update(readbackBytes(artifactPath, "owner finding artifact")).digest("hex");
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
  // (11) G2 intake gate on the OWNER-filing path too (g1s2-c1
  // MAJOR-7): a code-fix record failing the gate is refused and
  // JOURNALED as an S5 decision record — never an
  // `audit-filing-intake-refusal`, never an admitted finding (the
  // artifact written above stays UNREFERENCED; a corrected resubmis-
  // sion is a NEW act next cycle).
  if (finding.route === "code-fix") {
    const journal = gateOrJournal(finding, input.normGate, input.gateJournalPath,
      { takenIds: existingIds, extraTaken: [id] },
      { ts: now, episodeId, taskId: payload.taskId });
    if (journal !== null) return { status: "refused-gate", journal };
  }
  return { status: "applied", finding, artifactPath };
}

/** Wrapper-free top-level entry (g1s2-c1 MAJOR-1): the
 * malformed-payload case NO LONGER produces a refusal — the typed
 * `MalformedOwnerActError` propagates (see stage (1)). `intakeFiling`
 * is kept as the public entry name: every act intake runs through
 * it, so callers are insulated from stage reshuffles. */
export function intakeFiling(input: FilingAdjudicationInput): FilingAdjudication {
  return adjudicateFiling(input);
}

/* ================= G2-gate stub (MAJOR-7 fold) =====================
 * `NormGate` + `NormGateRefusalJournalEntry` are declared ABOVE (next
 * to `adjudicateFiling`, since both admission paths share them). */

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

/** The CLOSED wire-field set of an `audit-finding` record (the
 * envelope + body field list of §14.10.1 — nothing else may appear;
 * an unknown top-level field is smuggling territory). */
export const AUDIT_FINDING_WIRE_FIELDS = [
  "schema", "id", "ts", "episodeId", "taskId", "kind", "cycle", "origin", "producer",
  "ownerActRef", "originRef", "correctionOf", "route", "surface", "severity",
  "verdictBasis", "claim", "claimDigest", "findingRef", "scopeRefs", "repro",
  "evidenceRefs", "cureActRef", "affectedNorm",
] as const;

/**
 * g1s3-c1 (auditor-path wire strictness): the CLOSED-shape envelope
 * check an untrusted auditor submission must pass BEFORE any other
 * adjudication. The typed interface is compile-time-only; the wire is
 * JSON from an endpoint outside the trust boundary, so EVERY field the
 * record will carry is shape-checked here (the owner-filing path gets
 * the equivalents from the confirmed act + payload + draft-header
 * stages — the auditor path had NO equivalent and admitted a
 * `schema:"tre-supervisor/99"`, `kind:"owner-act"`, negative/NaN
 * `cycle`, foreign `episodeId`, non-array `scopeRefs`, a string
 * `affectedNorm`, malformed ULID operands, and arbitrary unknown
 * fields into durable records). Returns the failure list (empty ⇒
 * conforms). `route`/`surface`/`severity`/`verdictBasis`/`repro`/
 * `claim`/`evidenceRefs` are owned by the vocab + finding-schema
 * floors (not duplicated here); `origin`/`originRef`/`ownerActRef`
 * by the entry-mode + receipt-binding checks.
 */
export function auditorEnvelopeFails(
  candidate: Record<string, unknown>,
  arrival: { episodeId: string; taskId: string | null },
): string[] {
  const fails: string[] = [];
  // Closed envelope: unknown top-level fields refused (the durable
  // record is built by explicit projection, but a smuggling attempt
  // is refused LOUDLY, never silently dropped). `claimDigest` /
  // `findingRef` are supervisor-minted — a candidate carrying them is
  // the same class of attempt.
  for (const k of Object.keys(candidate)) {
    if (!(AUDIT_FINDING_WIRE_FIELDS as readonly string[]).includes(k) ||
        k === "claimDigest" || k === "findingRef") {
      fails.push(`unknown-field:${k}`);
    }
  }
  if (candidate["schema"] !== "tre-supervisor/1") fails.push("schema");
  if (candidate["kind"] !== "audit-finding") fails.push("kind");
  const ts = candidate["ts"];
  if (typeof ts !== "number" || !Number.isFinite(ts) || !Number.isInteger(ts) || ts < 0) {
    fails.push("ts");
  }
  // Arrival binding: the submission is admitted FOR the episode/task
  // it arrived on — a candidate naming a foreign episode is refused
  // (receipt-to-outcome accounting must not be smuggled cross-episode,
  // same doctrine as the receiptId binding below).
  if (typeof candidate["episodeId"] !== "string" || candidate["episodeId"] === "" ||
      candidate["episodeId"] !== arrival.episodeId) {
    fails.push("episodeId");
  }
  if (!(candidate["taskId"] === null ||
        (typeof candidate["taskId"] === "string" && candidate["taskId"] !== "")) ||
      candidate["taskId"] !== arrival.taskId) {
    fails.push("taskId");
  }
  // `cycle` parity with the owner payload check (>=0 integer, v9
  // R4-C3-1): the act payload is the sole source there; the auditor
  // candidate is that path's sole source here.
  const cycle = candidate["cycle"];
  if (typeof cycle !== "number" || !Number.isInteger(cycle) || cycle < 0) {
    fails.push("cycle");
  }
  // Producer: closed 3-field shape, each null-or-string (records.ts
  // `Producer`); extra producer keys are the same smuggling class.
  const p = candidate["producer"];
  if (p === null || typeof p !== "object" || Array.isArray(p) ||
      Object.keys(p).length !== 3 ||
      ["endpoint", "model", "sessionId"].some(
        (k) => (p as Record<string, unknown>)[k] !== null &&
               typeof (p as Record<string, unknown>)[k] !== "string",
      )) {
    fails.push("producer");
  }
  // Lineage operands: null or ULID-shaped id (§14.10.1 — the wire
  // operand for a record id is a ULID; the owner path resolves the
  // operand against the prefix, the auditor path has none, so the
  // shape pin is all intake can decide here).
  for (const f of ["correctionOf", "cureActRef"] as const) {
    const v = candidate[f];
    if (!(v === null || (typeof v === "string" && isUlid(v)))) fails.push(f);
  }
  // scopeRefs carry is OPAQUE (G5 semantics deferred) — string[]
  // shape only, parity with the owner header check.
  const sr = candidate["scopeRefs"];
  if (!Array.isArray(sr) || sr.some((x) => typeof x !== "string")) fails.push("scopeRefs");
  // originRef: closed per-variant shape with EXACT keys (the `producer`
  // trio carries the same excess-key pin, g1s3-c1): the union member
  // is `{origin:"intake", receiptId}` — anything else (extra keys,
  // missing receiptId, wrong origin) is the same smuggling class. The
  // value binding to the arrival receipt is checked in
  // `admitAuditorFinding` (MAJOR-6); this is the SHAPE pin.
  const or = candidate["originRef"];
  if (!(
    (
      typeof or === "object" && or !== null && !Array.isArray(or) &&
      Object.keys(or).length === 2 &&
      (or as OriginRef).origin === "intake" &&
      typeof (or as { receiptId?: unknown }).receiptId === "string" &&
      (or as { receiptId: string }).receiptId !== ""
    ) || (
      typeof or === "object" && or !== null && !Array.isArray(or) &&
      Object.keys(or).length === 2 &&
      (or as OriginRef).origin === "supervisor-derived" &&
      typeof (or as { fromRefusalId?: unknown }).fromRefusalId === "string" &&
      isUlid((or as { fromRefusalId: string }).fromRefusalId)
    )
  )) {
    fails.push("originRef");
  }
  // affectedNorm: null or {doc,anchor strings; sha256 absent|null|
  // string} — parity with the owner header check.
  const an = candidate["affectedNorm"];
  if (!(an === null || (
    typeof an === "object" && an !== null && !Array.isArray(an) &&
    typeof (an as AffectedNorm).doc === "string" &&
    typeof (an as AffectedNorm).anchor === "string" &&
    ((an as { sha256?: unknown }).sha256 === undefined ||
      (an as { sha256?: unknown }).sha256 === null ||
      typeof (an as { sha256?: string }).sha256 === "string")
  ))) {
    fails.push("affectedNorm");
  }
  // `id`: the interface tolerates a caller-supplied one (wire
  // tolerance for submissions that echo the envelope); the supervisor
  // ALWAYS mints its own — a present id must at least be ULID-shaped,
  // it is never used.
  if ("id" in candidate && !(typeof candidate["id"] === "string" && isUlid(candidate["id"]))) {
    fails.push("id");
  }
  return fails;
}

/**
 * Auditor-intake admission with the G2-gate stub on the SAME path:
 * g1s3-c1 CLOSED-envelope shape FIRST (untrusted wire), then vocab
 * validation (NDR-t), entry-mode validation (NDR-a — an auditor
 * endpoint may only produce auditor-intake mode) + the receipt
 * binding, the finding-schema floor, the NDR-b severity floor, the
 * artifact bounds (g1s3-c2), claimDigest + artifact over the
 * finding's cited bytes, then the gate — ONLY for `route:"code-fix"`
 * records (G2 gates intake, never re-routes, so only code-fix records
 * can fail it; the gate result NEVER mutates the record). A refused
 * line: journaled, never an `audit-finding`; a corrected resubmission
 * is a NEW record next cycle.
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
  // g1s3-c1: CLOSED-shape envelope check FIRST — an untrusted wire
  // submission is shape-checked before any vocabulary/floor/gate work
  // (see `auditorEnvelopeFails`).
  const env = auditorEnvelopeFails(
    candidate as unknown as Record<string, unknown>,
    { episodeId: input.episodeId, taskId: input.taskId },
  );
  if (env.length > 0) {
    throw new IntakeInputError(
      `auditor submission fails the closed envelope shape: ${env.join(", ")}`,
    );
  }
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
  // g1s2-c1 MAJOR-6 (NDR-a): the PROOF of auditor intake is the
  // submission's RECEIPT — the candidate's `originRef.receiptId` is
  // BOUND to the receipt the intake says the submission arrived on.
  // A candidate naming another receipt is refused: receipt-to-
  // outcome accounting must not be smuggled through the payload.
  if (candidate.originRef === null || candidate.originRef.origin !== "intake" ||
      candidate.originRef.receiptId !== input.receiptId) {
    throw new IntakeInputError(
      `candidate originRef.receiptId (${
        candidate.originRef !== null && candidate.originRef.origin === "intake"
          ? candidate.originRef.receiptId
          : "<not-an-intake-ref>"
      }) does not name the arrival receipt (${input.receiptId}) — NDR-a receipt binding`,
    );
  }
  // g1s2-c1 MAJOR-5 (NDR-b/§14.10.1): the SHARED finding-schema
  // floor — claim bound/shape, ≥1 evidenceRefs, complete repro wire
  // shape — applies to auditor intake exactly as to owner filing.
  const floor = findingSchemaFloorFails({
    claim: candidate.claim,
    evidenceRefs: candidate.evidenceRefs,
    repro: candidate.repro,
  });
  if (floor.length > 0) {
    throw new IntakeInputError(
      `auditor submission fails the finding-schema floor: ${floor.join(", ")}`,
    );
  }
  // NDR-b severity floor (route-free, every producer):
  if (!isFindingReproSatisfied({ severity: candidate.severity, repro: candidate.repro })) {
    throw new IntakeInputError(
      "a non-minor auditor finding with repro.kind:\"none\" is refused at intake (NDR-b)",
    );
  }
  // g1s3-c2 (durability & read-boundary): the artifact is the finding's
  // REQUIRED full-prose artifact (§14.10.1 R5-A) written into the
  // episode dir from UNTRUSTED endpoint bytes — it is capped to the
  // SAME 16 KiB draft cap the owner path enforces (uncapped bytes were
  // a disk-exhaustion vector: a 16 MiB submission admitted while an
  // owner draft of the same content could not exist) and refused EMPTY
  // (a zero-byte artifact is no prose; its digest would bind nothing).
  if (opts.artifactBytes.length === 0) {
    throw new IntakeInputError("artifactBytes is empty — the findingRef artifact is a REQUIRED full-prose artifact (§14.10.1 R5-A); refused at input, nothing written");
  }
  if (opts.artifactBytes.length > DRAFT_CAP_BYTES) {
    throw new IntakeInputError(
      `artifactBytes is ${opts.artifactBytes.length} bytes > the ${DRAFT_CAP_BYTES}-byte draft cap — the same input cap the owner path enforces; refused at input, nothing written`,
    );
  }
  const id = mintFindingId(opts.takenIds);
  const findingRefRel = path.join("findings", id);
  const artifactPath = path.join(episodeDir, findingRefRel);
  {
    const artDir = path.dirname(artifactPath);
    // g7-F2/F6 (terra cycle 1): full-chain durable creation; open
    // rides the retryable channel (see the owner-path note).
    mkdirEnsured(artDir);
    let fd: number;
    try {
      fd = openSync(artifactPath, "wx");
    } catch (e) {
      throw spoolIoWrapping(
        e,
        `auditor artifact: could not open "${artifactPath}" for exclusive write: `,
      );
    }
    let aPrimary: unknown = null;
    let aHadErr = false;
    try {
      writeFully(fd, opts.artifactBytes); // g6-F3
      seamFsync(fd);
    } catch (e) {
      aPrimary = e;
      aHadErr = true;
    } finally {
      aPrimary = closeChecked(fd, aPrimary, aHadErr); // g6-F2
    }
    if (aHadErr) {
      if (aPrimary instanceof SpoolIoError) throw aPrimary;
      throw spoolIoWrapping(
        aPrimary,
        `auditor artifact write failed — admission NEVER acked: `,
      );
    }
    syncPathChain(artDir); // MAJOR-9 + g7-F2: full chain before ack
  }
  const finding: AuditFinding = {
    ...candidate,
    id,
    // g1s4-c5 (envelope-field sources, §14.10.1 v9): `id`/`ts`/
    // `episodeId`/`findingRef`/`claimDigest` are SUPERVISOR-MINTED at
    // intake — an untrusted endpoint must not stamp its own admission
    // timestamp (a skewed clock reorders durable history). The
    // arrival-supplied `now` is the authority; the candidate's `ts`
    // passed the closed-shape check but never reaches the record.
    ts: input.now,
    claimDigest: createHash("sha256").update(readbackBytes(artifactPath, "auditor finding artifact")).digest("hex"),
    findingRef: findingRefRel,
  };

  if (finding.route === "code-fix") {
    const journal = gateOrJournal(finding, opts.normGate, opts.journalPath,
      { takenIds: opts.takenIds, extraTaken: [id] },
      { ts: input.now, episodeId: input.episodeId, taskId: input.taskId });
    if (journal !== null) {
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
