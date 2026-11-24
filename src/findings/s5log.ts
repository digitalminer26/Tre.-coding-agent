/**
 * S5 log wrapper — the append primitive the audit-finding contracts
 * require (docs/audits/g1-implementation-mapping.md `s5log` row;
 * schema NDR-r(1), NDR-i critical section, v33 per-file durability
 * establishment).
 *
 * Thin-wrapper contract (audit c1 Q5c, verbatim): "thin" is a
 * DECOUPLING claim, not a capability claim — this module does not
 * reuse `src/session/session.ts`'s fsync policy, and it MUST provide
 * the three capabilities itself:
 *
 *  1. EXCLUSIVE OWNERSHIP (NDR-i, DIRECTORY-REGISTRY CLAIMS — the
 *     cycle-4 B1 fold, cycle-6 ordering fold): the claim lives in a
 *     registry DIRECTORY `<log>.lock`; one CLAIM is one uniquely-
 *     named FILE inside it (`claim-<pid>-<creationUnixMs>-<rand>`,
 *     holding the token "`pid` hex\n"), created O_EXCL — the NAME
 *     is an append-only immutable fact (content is refreshed in
 *     place; the name is never rewritten). The holder set is the
 *     directory's entries: acquisition = create OUR entry, sweep
 *     FOREIGN entries that are stale AND whose holder pid is DEAD
 *     (crash recovery — see the takeover rules below), and prove
 *     OUR entry is then the ONLY one; release = unlink OUR OWN
 *     entry. No verification step EVER exposes an acquirable path:
 *     a successor's claim is a DISTINCT NAME (random) that its own
 *     creator alone removes — the single-file rename-verify(-undo)
 *     protocol of earlier cycles is GONE (terra c4 B1: renaming a
 *     foreign claim away to verify it vacated the path and let a
 *     third contender in; this protocol has no rename, no vacancy,
 *     and release can never remove a claim it did not create). The
 *     claim is held ACROSS the whole unit (prefix read → (c0) validation →
 *     `make()` → unit serialization/validation → establishment →
 *     NDR-r classification → repair+append → ONE fsync → ack).
 *     Takeover is crash recovery only:
 *       - a foreign entry stale past `lockStaleMs` (or fresh-but-
 *         empty past 1 s — a crash between create and write) is
 *         removed ONLY after its holder pid fails the signal-0
 *         liveness probe (a stalled-but-alive holder is NEVER
 *         broken; mtime staleness alone is not proof of death);
 *       - additionally (audit c19-F1; cycle-6 M3 in code): a
 *         WELL-FORMED cycle-6 name whose immutable creator pid
 *         probes DEAD is removable at ANY age — crash recovery
 *         must not wait a whole lockStaleMs to clear residue that
 *         blocks sole-occupancy admission (the liveness gate is
 *         the same signal-0 probe; only the AGE predicate differs);
 *       - the claim's identity is our entry's (st_dev, st_ino)
 *         PLUS its exact token bytes, re-proven at every phase
 *         boundary (see the fence below).
 *     Combined with the bounded-unit requirement below, a LIVE
 *     holder's claim is never broken. A contender that cannot
 *     acquire within `lockWaitMs` is REFUSED (fail closed — never
 *     lockless progress).
 *     SOLE-CLAIM ADMISSION — NO CLOCK, NO ORDER, NO TIE-BREAK
 *     (cycle-7 B1 fold): acquisition is admitted by EXCLUSIVITY
 *     OBSERVED AFTER OUR OWN ENTRY EXISTS: create our entry O_EXCL,
 *     sweep dead residue, and admit ONLY when the registry holds
 *     EXACTLY ONE live entry — ours. Any other live entry (of ANY
 *     shape, ANY creation time, ANY name) means we yield: unlink
 *     OUR OWN entry (never a foreign one), back off, retry until
 *     `lockWaitMs`, then REFUSE. Why this replaced the
 *     (createdMs, name) ordering proof of cycle-6 (audit c6
 *     BLOCKER 1): a BACKWARDS-RUNNING or skewed clock lets a
 *     LATER-created claim carry a SMALLER createdMs than an
 *     earlier one; "I am earliest" is then observable as TRUE by
 *     two contenders (the earlier holder admitted before the
 *     skewed claim appeared; the skewed claim sees itself as
 *     earliest afterwards) — mutual exclusion needs a predicate
 *     NO clock can falsify. "Exactly one entry, and it is mine"
 *     is that predicate: every contender enumerates AFTER its own
 *     create, so no contender can observe "alone" while another
 *     live entry exists, regardless of what any clock says. Cost:
 *     simultaneous claimers both yield and retry (liveness is
 *     bounded-random-backoff + deadline, and fail-closed refusal
 *     — never two mutators). The claim's MTIME serves ONLY
 *     staleness (who may sweep a foreign entry). BOUNDED-UNIT
 *     REQUIREMENT + MUTATION-TIME FENCE
 *     (cycle-2 fold, registry shape): a live holder refreshes its
 *     claim's mtime at every phase boundary (acquire, post-`make()`,
 *     post-pass) and must finish any phase well within
 *     `lockStaleMs`. A claim is removable by a stealer only after
 *     it is stale AND its pid is dead — so the wrapper additionally
 *     fences every MUTATION and every caller-visible decision: OUR
 *     entry must still exist with OUR (st_dev, st_ino) and OUR
 *     exact token, else S5LockLostError is thrown fail-stop
 *     (nothing written / no decision returned). The fence is
 *     defense-in-depth — the registry itself closed the vacancy
 *     windows the fence used to be the primary cure for.
 *  2. ORDERED DURABILITY (NDR-i, §13.1 R3 sync-before-ack, v33
 *     byte-watermark — cycle-2 fold): durability proof is tracked as
 *     a BYTE WATERMARK per instance (`provenThrough`), not a
 *     boolean: an instance has proven the log's first N bytes by a
 *     successful fsync it observed. A pass whose relied bytes extend
 *     past the watermark — bytes from another instance or from this
 *     instance's own FAILED (indeterminate, V-g5) pass — pays one
 *     `establish-prefix` fsync before the NDR-r decision and before
 *     any ack; the watermark never advances over bytes whose fsync
 *     failed. Pass order: acquire → read → (c0) validate without
 *     mutation (V-g4) → bootstrap ritual if the marker is missing or unreadable
 *     (dir-entry durability only, c12-F1 carve-out) → `make()` = the
 *     (c1a) semantic checks (they may throw before any content
 *     sync or mutation) → (c1c) establishing sync when needed → NDR-r classification → repair+append under
 *     ONE fsync (V-g13) → ack. V-g13 bounds the DECISION sync —
 *     repair and every append of a pass share exactly one; the
 *     establish-prefix sync is a durability proof of bytes already
 *     on disk (the watermark, v33), not a decision, so a cold
 *     instance whose watermark lags pays it in addition. A failing
 *     fsync throws with no ack;
 *     readable ≠ durable until the watermark covers the bytes.
 *  3. FULL LOCK LIFETIME (NDR-i): acquisition happens before any
 *     read of the prefix — including reads by `replay()`, which also
 *     runs under the claim — and release happens only after the
 *     pass's last fsync, on EVERY exit path (ack, refusal, throw)
 *     via a finally-scoped release.
 *
 * SCOPE LIMITS (cycle-3 fold, haiku m7/m8 + M5 residual):
 *  - readState reads the WHOLE file via readFileSync: Node refuses
 *    files >= 2 GiB (ERR_FS_FILE_TOO_LARGE) — this transport is
 *    for structured streams far below that; compaction is intake's
 *    job (streamed reads deliberately out of scope here).
 *    Environment failures on the log path (EACCES on an unreadable
 *    log, EISDIR when it is a directory, EPERM & friends) escape
 *    RAW as errno-bearing Errors — audit c15-F1: they are NOT
 *    protocol states, so they get no taxonomy class; each carries
 *    `.code` for the caller, fail-closed (nothing is read, written,
 *    or acked), with the claim released by the pass's finally.
 *    Same rule for the REGISTRY path (audit c22-F2/c23-Q2 fold):
 *    a NON-DIRECTORY at `<log>.lock` (pre-cycle-4 legacy lock
 *    file, or any foreign entry) is refused deterministically as a
 *    plain Error with stable `code: "ENOTDIR"` — NOT an
 *    S5LockBusyError (nothing is being waited for; waiting cannot
 *    fix it) and never a silent deletion of the foreign file.
 *    A dir→file swap AFTER the guard races to the same ENOTDIR
 *    code from the claim-open wrap. (Symlink note, c23-Q3/Q4:
 *    path resolution FOLLOWS symlinks — a symlink at `<log>.lock`
 *    whose target is a directory is accepted as the registry;
 *    same trust level as choosing the parent directory, and an
 *    operator-visible placement.)
 *  - Writer-canonical lines are JSON.stringify output + "\n":
 *    trailing-CR (CRLF) lines are REFUSED as non-canonical, BOMs
 *    are refused by strict decode+parse (never stripped).
 *  - Stale-claim takeover additionally requires the holder pid to
 *    be DEAD (signal 0); a stalled-but-live holder is never
 *    broken. Pid REUSE (cycle-4 m9 fold, honest wording): a reused
 *    live pid makes the claim look alive INDEFINITELY — not merely
 *    until lockStaleMs — and a ZOMBIE holder also passes signal 0
 *    until its parent reaps it. Both are fail-closed (waiting,
 *    never two mutators) but the recovery waits for the impostor
 *    process to exit, not for the stale clock; a deployment that
 *    must never wedge on this needs a process-identity mechanism
 *    (boot time / start-time check) beyond this transport's scope.
 *    Cross-host exclusion (flock/NFS) is out of scope.
 *  - The watermark is bound to the log's file IDENTITY
 *    `(st_dev, st_ino)` — and the identity is taken FROM THE FD
 *    THAT WAS SYNCED (cycle-7 M2 fold; cycle-6 M4 took it from a
 *    later path stat, which an `rm`+recreate between sync and stat
 *    could relabel): every advance of `provenThrough` records the
 *    (st_dev, st_ino) of the descriptor its establishing fsync ran
 *    on, and every later mutation re-proves the opened descriptor's
 *    identity BEFORE writing (an external rm+recreate mid-unit
 *    fail-stops with S5LogIdentityError, nothing written). If the
 *    path resolves to a DIFFERENT file than the proof was earned
 *    on, the proof is dropped — bytes the instance never synced
 *    are never reported "proven". This is identity, NOT content
 *    binding: an external writer that MUTATES the same inode in
 *    place cannot be detected at transport level (no content
 *    hashes in records — out of scope by the thin-wrapper
 *    contract); readers requiring tamper-evidence need
 *    intake-level hashes. ONE size-shaped exception is detected
 *    (audit c17-F1): when a pass begins, `ensureEstablished`
 *    compares st_size with the watermark and drops the whole proof
 *    if the file is now SHORTER than it (sampled between passes,
 *    not continuous — a truncate and a regrow that both happen
 *    inside one external window are seen only through the relied-
 *    bytes comparison). A same-size in-place rewrite remains the
 *    undetectable residual described above.
 *  - NULL-PID SWEEP RESIDUAL (cycle-7 m4, honest wording): a
 *    foreign entry carrying NO pid anywhere (name or token) cannot
 *    be attributed to any holder, so no liveness probe is possible
 *    for it; it blocks acquisition fail-closed while fresh and is
 *    removed once aged past `lockStaleMs` — or, if it is EMPTY
 *    (0 bytes: it carries no token either), already past the 1 s
 *    crash-between-create-and-write window (audit c14-F2: the
 *    emptyPartial gate applies to every shape, pid present or not).
 *    By protocol a live
 *    acquirer's entry carries its pid in its NAME from the instant
 *    of creation, so an entry lacking a pid entirely was not
 *    created by this protocol (tampering or a pre-cycle-6 legacy
 *    format) — removing it after a full stale window is the
 *    bounded recovery, with the residual risk confined to an
 *    adversary planting pids-less files inside the registry.
 *
 * ONE FSYNC PER PASS / PER-FILE ESTABLISHMENT (v33, vector V-g13):
 * a writing pass = open + (repair | append | both) + exactly ONE
 * DECISION fsync of the log fd — the single sync establishes EVERY
 * mutation of the pass together (the "record A's sync succeeded but
 * record B's sync failed" combination is UNREACHABLE). Establishment
 * syncs are NOT decision syncs: a cold instance (or a warm log whose
 * marker is missing) may add a `log-file` ritual sync or an
 * `establish-prefix` sync of the same fd before the decision, to
 * prove bytes already on disk (v33). Lock and bootstrap syncs
 * (`log-dir`, `marker-file`, `marker-dir`) are ADDITIONAL to the
 * decision fsync and run only on the cold/absent/marker-unusable
 * path (audit c13-F1). `lock-acquire` is different: it is the
 * claim-entry fsync and runs on EVERY acquisition (warm passes and
 * replay included — audit c18-F1; probe: a warm append issues
 * `lock-acquire, append`, a warm replay issues `lock-acquire`).
 * An instance whose watermark already covers every relied byte
 * therefore issues the decision fsync plus the claim fsync and
 * nothing else; a COLD instance on a marker-valid log additionally
 * pays the `establish-prefix` proof above (the c10-F1 shape).
 * No record
 * ever pays a second per-record sync.
 *
 * DURABILITY ESTABLISHMENT per file (v33 — "a test fsync on a fresh
 * file proves nothing until the file has been durable once"): on the
 * first operation of a log the wrapper runs the ritual ONCE against
 * THE LOG FILE ITSELF (audit c1 fold: a probe on an unrelated entry
 * proves nothing about the log's own dir entry):
 *   open the log O_CREAT|O_RDWR, fsync(its fd), fsync(dir) — the
 *   log's dir ENTRY is durable — then record the result in a
 *   versioned marker `<log>.durability` (marker written, fd-synced,
 *   dir-synced) BEFORE the first real pass. Reopening trusts ONLY a
 *   well-formed marker; a missing/corrupt one RE-RUNS the ritual —
 *   absence is never evidence.
 *
 * TAIL MODEL (§13.1 validate → repair → append under exclusive
 * ownership; vectors V-g1/V-g2/V-g4 ported to the transport layer —
 * the full cure-gate semantics of the originals ride with
 * `recovery.ts`, step 7, per mapping Q3):
 *  - V-g4: a CORRUPT MID-FILE line — INCLUDING an empty terminated
 *    line and any invalid UTF-8 in the complete region — rejects
 *    the pass BEFORE the file is touched: the repair is applied
 *    only AFTER validation passed AND after `make()` returned its
 *    decision, so a rejected pass mutates nothing, not even an
 *    independently repairable final fragment, and recovery's (c1a)
 *    semantic checks run before any WATERMARK-establishing sync of
 *    the bytes relied on (audit c1 fold: repair no longer syncs on
 *    its own — the pass's single decision fsync covers repair and
 *    appends together, after decisions). Carve-out (audit c12-F1):
 *    the dir-entry BOOTSTRAP ritual (`log-file`, `log-dir`, marker
 *    writes) runs after validation but BEFORE `make()` when the
 *    marker is missing, UNREADABLE (malformed), or the log is absent;
 *    it proves directory
 *    entries, not content, and a `make()` refusal after it leaves
 *    the re-created marker in place (no content is mutated).
 *  - V-g1: bytes after the final newline that do NOT parse (or fail
 *    strict UTF-8 decoding) are a PARTIAL fragment: repair
 *    truncates them; the record is absent from the prefix (its act
 *    stays owed at the caller's level).
 *  - V-g2: a COMPLETE record that lost only its terminating newline
 *    is KEPT (it classifies in the prefix, visible to `make()`) and
 *    terminated by the repair — never truncated away.
 *  Strict UTF-8: the complete region and the tail are decoded with
 *  `TextDecoder(fatal)`; a mid-file invalid sequence rejects (V-g4
 *  class), a torn tail's invalid continuation bytes classify it as
 *  partial. Newlines cannot split a multi-byte character
 *  ambiguously (continuation bytes are ≥ 0x80).
 *
 * DURABLE-BUT-REFUSED ACK (audit self-review fold on the c3-Q1 gate):
 * the acked-return gate re-proves the path after the pass's fsync
 * — and since audit c22-F1, it FIRST re-proves the CLAIM
 * (assertClaimHeld: path, (dev,ino), token). Either gate firing is
 * the SAME class: when it fires, the record IS durable on the
 * inode that was synced (the fsync completed and the write is
 * intact there; the watermark advanced over bytes THIS pass
 * synced — c23-Q1: a successor re-appending them is deduped via
 * NDR-r, never a false proven), but the PATH
 * no longer holds that inode — so the wrapper refuses to hand the
 * caller an ack whose decision-path relationship is broken. This is
 * a designed outcome, not a contradiction: durability was proven for
 * the BYTES, and the ack additionally promises the path still routes
 * to them AND the claim still stands. A caller catching
 * `S5LogIdentityError` OR `S5LockLostError` (c22-F1 fence) from a
 * unit that may have written must treat the write outcome as
 * UNKNOWN — the
 * record may be durable at the path (a later pass that re-reads the
 * file will dedup via NDR-r, making retry safe once the path again
 * holds a readable log), or absent. Never assume "throw ⇒ nothing
 * written" for the post-fsync window; assume "throw ⇒ the ack was
 * owed and not owed-able".
 *
 * REDelivery IDEMPOTENCE — the NDR-r three cases, decided inside the
 * critical section against the current prefix (the FIRST durable
 * occurrence of an id is its predecessor). TRANSPORT-LEVEL SCOPE
 * (audit c1 fold): the wrapper's idempotence key is the envelope
 * `id` plus the record's exact bytes; the NDR-r act/effect/draft
 * identity work (same-act redelivery with divergent draft bytes,
 * pinned `draftSha256` rechecks, the rejected-duplicate FINDING)
 * belongs to intake — this layer reports byte-identical
 * redeliveries as separate refiling CANDIDATES and never mints or
 * claims findings:
 *   (a) id absent           → new attempt: appended (a new act is
 *                             NEVER refused as duplicate intent);
 *   (b) id present, BYTES
 *       IDENTICAL           → refiling candidate: idempotent normal
 *                             path — nothing re-appended, reported
 *                             separately per record;
 *   (c) id present, BYTES
 *       DIVERGENT           → REFUSED at transport level: throws
 *                             S5ReplayIntegrityError with a clean
 *                             prefix (nothing appended; the whole
 *                             unit is atomic).
 *
 * The `sync` option is the documented test seam (failure injection
 * for the V-g3/V-g5/V-g6 class, fsync counting for V-g13);
 * production code never passes it.
 */

import {
  type Stats,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  futimesSync,
  linkSync,
  renameSync,
  writeFileSync,
  writeSync,
  ftruncateSync,
  fstatSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { TextDecoder } from "node:util";

/* ------------------------------------------------------------------ *
 * Options & errors                                                    *
 * ------------------------------------------------------------------ */

/** Labeled fsync sink (test seam; see the `sync` option). */
export type SyncFn = (fd: number, label: S5SyncLabel) => void;

export type S5SyncLabel =
  | "log-file"
  | "log-dir"
  | "marker-file"
  | "marker-dir"
  | "lock-acquire"
  | "establish-prefix"
  | "repair"
  | "append";

export interface S5LogOptions {
  /** Path of the append-only JSONL log. */
  readonly path: string;
  /** Max wall time (ms) to wait for the lock before refusing
   *  (default 5000). Fail-closed: refusal, never lockless progress. */
  readonly lockWaitMs?: number;
  /** A lock whose mtime is older than this (ms) has a dead holder
   *  and is claimable (default 30000). See the bounded-unit
   *  requirement in the header: a live holder refreshes at every
   *  phase boundary, so units bounded well below this never lose
   *  their claim. */
  readonly lockStaleMs?: number;
  /** TEST SEAM: replaces every fsync the wrapper performs (labeled).
   *  Default `fsyncSync`. Tests inject failure (V-g3/V-g5/V-g6
   *  class) or count calls (V-g13 one-fsync-per-pass). Production
   *  code never passes this. */
  readonly sync?: SyncFn;
}

/** The lock is held by a live (or at least fresh) contender. */
export class S5LockBusyError extends Error {
  constructor(
    readonly lockPath: string,
    readonly waitedMs: number,
  ) {
    super(
      `S5 lock refused: lock ${lockPath} held (waited ${Math.round(waitedMs)}ms) — fail-closed, no lockless append`,
    );
    this.name = "S5LockBusyError";
  }
}

/** The claim was taken over (post-stale-window) before the
 *  MUTATION phase began: the pass fail-stops with NOTHING mutated
 *  (cycle-2 fold — a renamed-away or replaced claim never permits
 *  a write; at most one claim-holder ever mutates, see the
 *  mutation-time ownership fence). */
export class S5LockLostError extends Error {
  constructor(readonly lockPath: string) {
    super(
      `S5 claim lost on ${lockPath} (taken over or removed mid-unit): mutation REFUSED, fail-stop, nothing written`,
    );
    this.name = "S5LockLostError";
  }
}

/** V-g4 ((c0) validate-without-mutation): a corrupt mid-file line
 *  (bad JSON, empty line, missing string id) or invalid UTF-8 in
 *  the complete region rejects the pass BEFORE the file is touched
 *  — the bytes (even an independently repairable final fragment)
 *  stand unchanged. `corruptLine` is 1-based; 0 means the complete
 *  region failed strict UTF-8 decoding as a whole. */
export class S5LogCorruptionError extends Error {
  constructor(
    readonly logPath: string,
    readonly corruptLine: number,
    readonly reason: "corrupt-line" | "invalid-utf8",
  ) {
    super(
      `S5 log ${logPath} ${reason === "invalid-utf8" ? "holds invalid UTF-8" : `line ${corruptLine} is corrupt`} mid-file: pass REFUSED before any mutation (§13.1 validate-before-repair)`,
    );
    this.name = "S5LogCorruptionError";
  }
}

/** Transport-level NDR-r case (c): the same envelope id with
 *  DIVERGENT bytes — a replay-integrity violation, refused with a
 *  clean prefix. (The act/effect-level NDR-r adjudication is
 *  intake's, per the header scope note.) */
/**
 * An incoming record is not a valid unit payload (cycle-3 fold): a
 * non-object or an id that is not a non-empty string would serialize
 * into bytes the NEXT reader rejects as corruption — a caller may
 * never smuggle an invalid line into the log. Input error, never
 * corruption; nothing was written.
 */
export class S5InvalidInputError extends Error {
  readonly name = "S5InvalidInputError";
  constructor(public readonly id: string) {
    super(`record has no valid string id (got ${JSON.stringify(id)}) — refused before any write`);
  }
}

export class S5ReplayIntegrityError extends Error {
  constructor(
    readonly id: string,
    readonly storedLine: string,
    readonly incomingLine: string,
  ) {
    super(
      `S5 replay-integrity refusal: record ${id} already durable with different bytes (clean prefix, nothing appended)`,
    );
    this.name = "S5ReplayIntegrityError";
  }
}

/** The log path stopped resolving to the inode the durability proof
 *  was earned on (cycle-7 M2 fold): an external `rm` + recreate
 *  (or any inode swap) landed between our read/establishment and
 *  the moment a descriptor was opened for a sync or a mutation.
 *  Fail-stop BEFORE any write: the bytes we classified belong to a
 *  DIFFERENT file than the one now standing — nothing is written,
 *  nothing is acked, and the watermark is dropped (a retry
 *  re-establishes against the new inode). */
export class S5LogIdentityError extends Error {
  constructor(readonly logPath: string) {
    super(
      `S5 log ${logPath} no longer resolves to the established inode (external rm + recreate mid-unit): mutation REFUSED, nothing written`,
    );
    this.name = "S5LogIdentityError";
  }
}

/* ------------------------------------------------------------------ *
 * Strict decoding & line validation                                   *
 * ------------------------------------------------------------------ */

// ignoreBOM (haiku c3 M4 fold): the DEFAULT strips a leading BOM
// from the decoded text while leaving the bytes on disk — a BOM'd
// V-g2 tail would be accepted (terminator written behind it) and
// then poison every later pass. With ignoreBOM a BOM stays U+FEFF
// in the decoded text and fails line validation (validateLine /
// JSON.parse both reject it) LOUDLY at first sight instead of
// silently at second.
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Strict UTF-8 decode: returns null on any invalid sequence. */
function decodeStrict(buf: Buffer): string | null {
  try {
    return strictDecoder.decode(buf);
  } catch {
    return null;
  }
}

/** Transport validation of one line (on its ORIGINAL text): a JSON
 *  object with a non-empty string `id`. An EMPTY line is corrupt
 *  (audit c1 fold: blank terminated lines are never silently
 *  dropped). Schema validation is `records.ts`/intake's job. */
function lineIsValid(line: string): boolean {
  // CRLF boundary (haiku c3 m8 fold): a trailing \r parses fine in
  // JS but is never produced by this writer; accepting it would let
  // the NDR-r exact-byte comparison refuse an IDENTICAL redelivery
  // with a misleading "different bytes" message. Reject it here,
  // where the reason is honest: the line is not writer-canonical.
  if (line.length === 0 || line.endsWith("\r")) return false;
  // A leading BOM must be rejected HERE (cycle-4 m1 fold corrects
  // the earlier claim): JSON.parse does NOT skip a leading U+FEFF —
  // verified on this runtime, it throws (U+FEFF is invalid JSON
  // syntax), so a BOM'd line would be refused with the misleading
  // reason "malformed JSON". Reject it here, where the reason is
  // honest: the line carries a BOM and is not writer-canonical.
  if (line.charCodeAt(0) === 0xfeff) return false;
  try {
    const rec = JSON.parse(line) as { id?: unknown };
    return rec !== null && typeof rec === "object" && typeof rec.id === "string" && rec.id !== "";
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Durability establishment (v33, per file — against the LOG itself)   *
 * ------------------------------------------------------------------ */

const DURABILITY_VERSION = 1;
const MARKER_SUFFIX = ".durability";

type MarkerState =
  | { readonly status: "missing" }
  | { readonly status: "unreadable"; reason: string }
  | { readonly status: "established"; since: number };

function readMarker(logPath: string): MarkerState {
  const p = logPath + MARKER_SUFFIX;
  if (!existsSync(p)) return { status: "missing" };
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as {
      version?: unknown;
      establishedAt?: unknown;
    };
    if (
      j.version === DURABILITY_VERSION &&
      typeof j.establishedAt === "number" &&
      Number.isInteger(j.establishedAt) &&
      j.establishedAt >= 0
    ) {
      return { status: "established", since: j.establishedAt };
    }
    return { status: "unreadable", reason: "malformed-marker" };
  } catch (err) {
    return {
      status: "unreadable",
      reason: err instanceof Error ? err.constructor.name : String(err),
    };
  }
}

function syncDir(dir: string, label: S5SyncLabel, sync: SyncFn): void {
  // `fsyncSync(<path string>)` throws ERR_INVALID_ARG_TYPE on this
  // runtime — the dir is opened and its fd synced.
  const fd = openSync(dir, "r");
  try {
    sync(fd, label);
  } finally {
    closeSync(fd);
  }
}

/**
 * Establish durability for this log file ONCE (v33), against the
 * log file ITSELF (audit c1 fold): create-if-absent + fsync(its fd)
 * + fsync(dir) proves the LOG's dir entry durable (the probe-entry
 * detour proved nothing about it); the versioned marker records the
 * result. Skipped only when a well-formed marker proves it —
 * absence/corruption re-runs the ritual. Runs UNDER the log claim
 * (cycle-3 fold corrected the pre-cycle-3 wording: bootstrap is
 * serialized with every log operation; the marker is a separate
 * file, published atomically via tmp+rename — cycle-6 m-minor).
 */
/** mkdir(2) each missing component, fsyncing each NEW component's
 *  parent dir entry (haiku c3 m6 fold). mkdir failure propagates
 *  (EEXIST from a raced creator is fine); fsyncs are best-effort
 *  on platform quirks. */
function mkdirDurably(dir: string, sync: SyncFn): void {
  const missing: string[] = [];
  let cur = dir;
  while (!existsSync(cur)) {
    missing.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break; // reached root without a hit
    cur = parent;
  }
  // Cycle-5 M2 fold: EEXIST is per-COMPONENT (a racer created THAT
  // one) — tolerate it and keep going; the deeper components still
  // do not exist and must be created. (The old loop aborted the
  // whole chain on the first EEXIST, leaving `dir` itself missing
  // and the caller failing with a confusing ENOENT on retry.)
  try {
    for (const d of [...missing].reverse()) {
      try {
        mkdirSync(d);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
  } catch (err) {
    // Audit c15-F2 fold: errno survives the wrap (cause + code).
    throw Object.assign(
      new Error(
        `S5 durability: cannot create dir ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      ),
      { cause: err, code: (err as NodeJS.ErrnoException)?.code },
    );
  }
  // Cycle-5 M1 fold: an ancestor dir-entry fsync FAILS — propagate
  // (fail closed). Swallowing it let establishment report a log
  // whose ancestor dir entry was never proven durable: exactly the
  // crash-window the ritual exists to close. (syncDir quirks on
  // some platforms manifest as ENOENT/EINVAL on the OPEN — those
  // too are propagated: no un-proven establishment.)
  for (const d of missing) {
    try {
      syncDir(dirname(d), "log-dir", sync);
    } catch (err) {
      throw Object.assign(
        new Error(
          `S5 durability: ancestor dir sync FAILED for ${dir}: ${err instanceof Error ? err.message : String(err)} — fail closed, no un-established log`,
        ),
        { cause: err, code: (err as NodeJS.ErrnoException)?.code },
      );
    }
  }
}

/** A file's identity as the proof knows it (cycle-7 M2 fold):
 *  `(st_dev, st_ino)` taken FROM THE DESCRIPTOR THE SYNC RAN ON —
 *  never from a later path stat, which an `rm` + recreate between
 *  the fsync and the stat could relabel onto a foreign inode. */
interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** Identity of an OPEN descriptor (cycle-7 M2 fold). */
function identityOfFd(fd: number): FileIdentity {
  const st = fstatSync(fd);
  return { dev: st.dev, ino: st.ino };
}

/** Identity of the file currently STANDING AT A PATH (audit c7
 *  finding-1 fold): used only where no descriptor of ours tracks
 *  the path any more and the question is "is the path still the
 *  file we read?". A vanished path has no identity to report —
 *  fail closed as an identity error (the caller's expected
 *  inode certainly is not standing). */
function identityOfPath(logPath: string): FileIdentity {
  try {
    const st = statSync(logPath);
    return { dev: st.dev, ino: st.ino };
  } catch {
    throw new S5LogIdentityError(logPath);
  }
}

/** Re-prove that an opened descriptor IS the file the pass read
 *  (cycle-7 M2 fold): an external `rm` + recreate under the same
 *  path between readState/establishment and this open swaps the
 *  inode — fail-stop BEFORE any sync or write (the bytes we
 *  classified belong to a DIFFERENT file than the one standing).
 *  A null expectation means the pass read NO file at all: any file
 *  now standing is unaccounted for — same refusal, fail closed. */
function assertSameInode(expected: FileIdentity | null, actual: FileIdentity, logPath: string): void {
  if (expected === null || expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new S5LogIdentityError(logPath);
  }
}

/** Audit c8 Q2 fold: the PRE-RETURN gate for a snapshot. An
 *  (st_dev, st-inode) equality is not enough — filesystems recycle
 *  freed inode numbers, so rm + recreate can put a DIFFERENT file
 *  at the path with the SAME identity the snapshot was taken on.
 *  Re-read the standing bytes and compare their digest against the
 *  snapshot's recorded digest: identical bytes are the only escape
 *  (then the delivered records still describe the file exactly),
 *  and a vanished path fails closed. One extra read per replay,
 *  only at the caller-visible boundary — the mutation path keeps
 *  the cheaper fd-identity gates because its claim fence excludes
 *  other writers. When the pass read NO file (`state.identity ===
 *  null`) the old inode semantics apply: the only file the
 *  snapshot may describe is the one THIS instance established. */
function assertSnapshotIntact(state: FileState, provenOn: FileIdentity | null, logPath: string): void {
  if (state.identity === null) {
    assertSameInode(provenOn, identityOfPath(logPath), logPath);
    return;
  }
  assertSameInode(state.identity, identityOfPath(logPath), logPath);
  let buf: Buffer;
  try {
    const fd = openSync(logPath, "r");
    try {
      buf = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new S5LogIdentityError(logPath);
    throw err;
  }
  const now = createHash("sha256").update(buf).digest("hex");
  if (now !== state.contentDigest) throw new S5LogIdentityError(logPath);
}

function statOrNull(logPath: string): Stats | null {
  try {
    return statSync(logPath);
  } catch {
    return null;
  }
}

function readIdentityOrNull(logPath: string): FileIdentity | null {
  const st = statOrNull(logPath);
  return st === null ? null : { dev: st.dev, ino: st.ino };
}

function establishDurability(logPath: string, sync: SyncFn): { provenBytes: number; identity: FileIdentity | null } {
  const marker = readMarker(logPath);
  // Records predating the marker: the marker proves the DIR-ENTRY
  // establishment, NOT that earlier records' originating syncs
  // succeeded — their content is unproven until an
  // `establish-prefix` fsync (v33). Returns whether the log
  // ALREADY EXISTED when establishment ran.
  if (marker.status === "established") {
    // Marker-vs-log coherence (haiku c3 m5 fold): a surviving
    // marker with a DELETED log would wedge every later pass on an
    // opaque ENOENT. The marker proves a dir entry that no longer
    // exists — clear it and fall through to re-run the ritual
    // (which recreates the log and republishes the marker).
    if (!existsSync(logPath)) {
      try {
        unlinkSync(logPath + MARKER_SUFFIX);
      } catch {
        /* raced — the ritual below re-evaluates anyway */
      }
    } else {
      // No fsync ran HERE: zero proven bytes and NO identity to
      // bind (cycle-7 M2) — a later pass earns the identity the
      // moment its establishing sync runs on a real descriptor.
      return { provenBytes: 0, identity: null };
    }
  }
  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    // Ancestor fsyncs (haiku c3 m6 fold): `mkdir -p` may create
    // several missing ancestors, and a crash can lose ANY of their
    // dir entries. Create component by component from the deepest
    // existing ancestor, fsyncing each new directory's PARENT (the
    // entry lives in the parent) as we go up.
    mkdirDurably(dir, sync);
  }
  let fd: number | null = null;
  let preSyncSize = 0;
  let syncedIdentity: FileIdentity | null = null;
  try {
    // Create the log if absent (O(1) on an existing file), sync ITS
    // fd — content + inode; then sync the DIR — the log's dir ENTRY.
    // Cycle-3 fold: the proven byte count is the fstat taken BEFORE
    // the sync (everything written before the fsync returns is
    // proven), NEVER a later path stat — a foreign append landing
    // between our sync and a post-sync stat must not be counted
    // proven by a ritual that never synced it.
    fd = openSync(logPath, "a+");
    preSyncSize = fstatSync(fd).size;
    // Cycle-7 M2 fold: the identity the proof binds is the SYNCED
    // DESCRIPTOR's (fstat of the open fd, before the sync returns —
    // same discipline as the byte count above). A post-sync path
    // stat could relabel the proof onto an inode that replaced the
    // file between the fsync and the stat.
    syncedIdentity = identityOfFd(fd);
    sync(fd, "log-file");
    closeSync(fd);
    fd = null;
    syncDir(dir, "log-dir", sync);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    }
    throw Object.assign(
      new Error(
        `S5 durability establishment FAILED for ${logPath}: ${err instanceof Error ? err.message : String(err)} — fail closed, no un-established log`,
      ),
      { cause: err, code: (err as NodeJS.ErrnoException)?.code },
    );
  }
  // Marker: published ATOMICALLY (cycle-6 m-minor): write a temp
  // file, fsync it, rename over the marker path (rename never
  // exposes a half-written marker), fsync the dir. A crash leaves
  // either the OLD marker or the NEW one — never a torn file that
  // readMarker would call "unreadable" and force a re-ritual.
  const markerPath = logPath + MARKER_SUFFIX;
  const tmpPath = `${markerPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const mfd = openSync(tmpPath, "wx");
  try {
    writeFileSync(mfd, JSON.stringify({ version: DURABILITY_VERSION, establishedAt: Date.now() }) + "\n");
    sync(mfd, "marker-file");
    closeSync(mfd);
    renameSync(tmpPath, markerPath);
  } catch (err) {
    try {
      closeSync(mfd);
    } catch {
      /* already closed on the rename path */
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best effort */
    }
    throw Object.assign(
      new Error(
        `S5 durability establishment FAILED for ${logPath}: ${err instanceof Error ? err.message : String(err)} — fail closed, no un-established log`,
      ),
      { cause: err, code: (err as NodeJS.ErrnoException)?.code },
    );
  }
  syncDir(dir, "marker-dir", sync);
  // The ritual synced the log's own fd: every byte that existed at
  // the pre-sync fstat instant (a fresh file has none) is proven —
  // ON the identity of that synced descriptor (cycle-7 M2 fold).
  return { provenBytes: preSyncSize, identity: syncedIdentity };
}

/* ------------------------------------------------------------------ *
 * Lock (NDR-i exclusive ownership, takeover + fenced release)         *
 * ------------------------------------------------------------------ */

function lockPathOf(logPath: string): string {
  return logPath + ".lock";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Jittered retry SLEEP LENGTH for the yield-and-retry loop
 *  (audit c7 finding-2 fold): two contenders that yielded
 *  SIMULTANEOUSLY must not re-sleep for identical durations —
 *  with a deterministic backoff they re-claim in lockstep (both
 *  create, both observe two entries, both unlink, both sleep the
 *  same slice) and can starve each other until BOTH refuse at
 *  the deadline. Safety was never at risk (refusal is
 *  fail-closed); this restores LIVELOCK-FREEDOM: uniform jitter
 *  in `[5, cap]` ms decorrelates the contenders so one claims
 *  strictly between the other's attempts with probability 1.
 *  Exported for direct testing: a deterministic backoff is a
 *  single-distribution property no black-box acquire test can
 *  prove absent (it can only fail to observe), so the shape of
 *  the distribution is asserted where it is drawn. */
export function retrySleepMs(deadline: number): number {
  const cap = Math.min(55, Math.max(5, deadline - Date.now()));
  return 5 + Math.floor(Math.random() * (cap - 4)); // uniform [5, cap]
}

function backoffSleepSync(deadline: number): void {
  sleepSync(retrySleepMs(deadline));
}

interface HeldLock {
  readonly path: string;
  readonly fd: number;
  /** (st_dev, st_ino) of OUR claim, for the fenced release. */
  readonly dev: number;
  readonly ino: number;
  /** The token WE wrote — a content fence: a restore/recreate of
   *  our path must carry OUR exact bytes (cycle-3 fold). */
  readonly token: string;
}

/** Parsed view of a registry entry's NAME (cycle-6 B1+M3 fold;
 *  cycle-7 B1: the createdMs field remains part of the NAME —
 *  uniqueness and the unforgeability of the name — but is NO
 *  LONGER an ordering key: admission is sole-occupancy):
 *  `claim-<pid>-<creationUnixMs>-<rand>` — the creator pid is a
 *  fact of the NAME (immutable: content is refreshed in place,
 *  names never are), which is what the liveness sweep judges.
 *  Foreign/legacy names (planted files, pre-cycle-6 formats)
 *  parse to null — the sweep then falls back to the token's pid,
 *  and admission counts the entry as an occupant regardless of
 *  shape (fail-closed: any live entry that is not ours blocks). */
interface ClaimNameInfo {
  readonly pid: number;
  readonly createdMs: number;
}

/** Strict cycle-6 parse (all three fields). */
function parseClaimName(name: string): ClaimNameInfo | null {
  const m = /^claim-(\d+)-(\d+)-([0-9a-f]+)$/.exec(name);
  if (!m) return null;
  const pid = Number(m[1]);
  const ns = Number(m[2]);
  return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ns) && ns >= 0
    ? { pid, createdMs: ns }
    : null;
}

/** Best-effort pid extraction from ANY name shape (planted or
 *  legacy `claim-<pid>-<rand>`): the first numeric field after
 *  `claim-`. Null when no usable pid is present. */
function parseClaimNamePid(name: string): number | null {
  const m = /^claim-(\d+)/.exec(name);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** A live entry of the claim registry. CYCLE-7 B1 fold: there is
 *  NO ordering any more — admission is SOLE-OCCUPANCY (this
 *  instance's entry is the registry's ONLY live file), a predicate
 *  no clock can falsify. The cycle-6 (createdMs, name) total order
 *  died with audit c6 BLOCKER 1 (a backwards-running clock made
 *  "I am earliest" observable as true by two contenders); its
 *  ordering keys are REMOVED from this view rather than kept
 *  unused — an entry is a name plus a staleness clock, nothing
 *  else. MTIME serves ONLY staleness (what the sweep may remove);
 *  heartbeats refresh it, which is exactly why it was never an
 *  order (cycle-5 B1) and why NO order survived (cycle-7 B1). */
interface ClaimEntry {
  readonly name: string;
  /** Staleness key only — never ordering, never admission. */
  readonly mtimeMs: number;
}

/** Enumerate the registry's claim files (vanished-underneath
 *  entries are skipped; subdirectories cannot exist by protocol).
 *  Cycle-7 B1 fold: EXISTENCE is the only fact that matters for
 *  admission, so a stat race that hides an entry must never make
 *  the registry look emptier than it is — readdir entries whose
 *  stat vanished are KEPT (an unreadable/stale entry still counts
 *  as an occupant; the admission predicate is "exactly one entry
 *  and it is mine", fail-closed toward MORE occupants). */
function liveClaims(regPath: string): { entries: ClaimEntry[]; listingFailed: boolean } {
  const out: ClaimEntry[] = [];
  let names: string[];
  try {
    // Cycle-6 fold: a releaser's rmdir can win between our create
    // and this snapshot — a raw ENOENT here used to escape with our
    // fd open. Tolerated: the entry check below (mine === undefined)
    // fails closed with our descriptor closed.
    names = readdirSync(regPath);
  } catch {
    // c1-Q3 fold (audit c8): an EMPTY list read identically to a
    // FAILED one. Every consumer that treats "empty" as "no
    // occupants" must now also consult listingFailed; consumers
    // that fail closed toward MORE occupants (the sole-claim proof)
    // keep treating a failed listing as blocking.
    return { entries: out, listingFailed: true };
  }
  for (const name of names) {
    try {
      const st = statSync(`${regPath}/${name}`);
      if (!st.isFile()) continue; // subdirectories cannot exist by protocol
      out.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      // Raced release OR a stat the fs refused: keep the entry as
      // an occupant (cycle-7 B1 fail-closed direction) — a stale
      // entry that blocks admission is swept next round; one that
      // silently disappeared admits two mutators.
      out.push({ name, mtimeMs: -1 });
    }
  }
  return { entries: out, listingFailed: false };
}

/** The creator pid to judge a claim entry by (cycle-6 M3 fold):
 *  the NAME's pid first (immutable — the content token may not be
 *  written yet), then the token's pid (planted/legacy shapes). */
function claimHolderPid(name: string, token: string): number | null {
  return parseClaimName(name)?.pid ?? parseClaimNamePid(name) ?? parseHolderPid(token);
}

/**
 * Crash-recovery sweep of the registry (cycle-4 B1 fold; cycle-6
 * M3 fold): remove FOREIGN claims that are stale past
 * `lockStaleMs` (or empty-and-aged past 1 s — the crash between
 * create and token-write) AND whose CREATOR pid (taken from the
 * claim NAME when parseable — an immutable fact; the token may
 * never have been written) fails the signal-0 liveness probe.
 * Cycle-5 M3 fix: gating on the TOKEN's pid alone let a live-but-
 * stalled creator — crashed after create, before its token write
 * — have its in-progress claim broken by a fresh-but-empty sweep.
 * Deletion is VERIFY-THEN-UNLINK on the entry's OWN path: same
 * (st_dev, st_ino), unchanged mtime, unchanged token bytes. No
 * rename is involved ANYWHERE — the old single-file quarantine
 * dance vacated the lock path while it verified (terra c4
 * B1/BLOCKER 1); here a foreign entry is a distinct random name
 * that never vacates anything, and a verified-unchanged re-check
 * means a raced re-creation (different inode) is never removed as
 * "stale". A stalled-but-ALIVE creator is never broken; pid-reuse
 * wedges recovery fail-closed exactly as the header documents.
 */
function sweepStaleClaims(regPath: string, lockStaleMs: number): void {
  let names: string[];
  try {
    names = readdirSync(regPath);
  } catch {
    return; // registry gone (a raced cleanup) — caller re-creates
  }
  for (const name of names) {
    const path = `${regPath}/${name}`;
    let st: ReturnType<typeof statSync>;
    let token: string;
    try {
      st = statSync(path);
      token = readFileSync(path, "utf8");
    } catch {
      continue; // vanished underneath us
    }
    const age = Date.now() - st.mtimeMs;
    const stale = age > lockStaleMs;
    const emptyPartial = st.size <= 0 && age > 1000;
    // Removal eligibility by entry SHAPE (cycle-6 M3 fold;
    // cycle-7 B1: the same gates ride the sole-occupancy model —
    // ANY residue, dead or foreign, blocks admission, so removing
    // dead residue at any age matters even more than before):
    //  - stale past lockStaleMs, or empty-and-aged (crash between
    //    create and token-write) — the pre-cycle-6 gates;
    //  - OR a WELL-FORMED cycle-6 name whose immutable creator pid
    //    probes DEAD — removable at ANY age: crash recovery must
    //    not wait a whole lockStaleMs to clear residue that blocks
    //    sole-occupancy admission.
    // Then the liveness gate: a LIVE creator (any shape) is never
    // broken — judged from the NAME's pid first (immutable), the
    // token's pid as fallback (cycle-5 M3: the token may never
    // have been written).
    const holderPid = claimHolderPid(name, token);
    const wellFormedDead =
      parseClaimName(name) !== null && holderPid !== null && !pidAlive(holderPid);
    if (!stale && !emptyPartial && !wellFormedDead) continue;
    if (holderPid !== null && pidAlive(holderPid)) continue;
    // Verify the entry is UNCHANGED since observed (same inode,
    // same mtime — a live holder's touchLock refresh defeats this —
    // same token bytes) before removing it.
    try {
      const now = statSync(path);
      if (now.dev !== st.dev || now.ino !== st.ino) continue;
      if (now.mtimeMs !== st.mtimeMs) continue;
      if (readFileSync(path, "utf8") !== token) continue;
      unlinkSync(path);
    } catch {
      /* raced release/touch — inert this round, swept next */
    }
  }
}

/**
 * Claim a place in the registry directory `<log>.lock` (cycle-4
 * B1 fold — see the header's EXCLUSIVE OWNERSHIP section):
 *  1. ensure the registry exists; a missing PARENT is created
 *     durably first (cycle-4 fold: `new/subdir/log.jsonl` must not
 *     wedge bootstrap on an ENOENT claim path);
 *  2. create OUR entry `claim-<pid>-<creationUnixMs>-<rand>`
 *     O_EXCL, token "`pid` hex\n", fsynced (diagnostic; no
 *     durability is owed to a claim — a crash clears the registry
 *     by itself). CREATION ORDER LIVES IN THE NAME (cycle-6 B1
 *     fold): creation time (Date.now() ms) is recorded once, when
 *     the contended path ends; heartbeats never rewrite it;
 *  3. sweep dead stale claims (crash recovery — sweepStaleClaims);
 *  4. PROVE EXCLUSIVITY (cycle-7 B1 fold): after our entry exists
 *     and the dead residue is swept, the registry must hold
 *     EXACTLY ONE live entry and it must be OURS — a predicate no
 *     clock can falsify (the cycle-6 (createdMs, name) ordering
 *     proof admitted two contenders under a backwards-running
 *     clock, audit c6 BLOCKER 1). Any other live entry means we
 *     unlink OUR OWN entry (never a foreign one — no rename, no
 *     vacancy, nothing acquirable is ever exposed by another
 *     holder's bookkeeping) and retry until `lockWaitMs`, then
 *     REFUSE (fail closed, never lockless).
 * A failed token-write/fsync cleans up our own descriptor and entry
 * before rethrowing (audit c1 fold).
 */
function acquireLock(
  logPath: string,
  opts: { lockWaitMs: number; lockStaleMs: number },
  sync: SyncFn,
): HeldLock {
  const regPath = lockPathOf(logPath);
  const started = Date.now();
  const deadline = started + opts.lockWaitMs;
  for (;;) {
    // (1) Registry directory. EEXIST = already there (fine); ENOENT
    // = missing parent(s): create them DURABLY before any claim
    // exists (race-safe: mkdir -p semantics; fail-closed on real
    // errors), then retry.
    try {
      mkdirSync(regPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        if (code === "ENOENT") {
          // Audit c8 Q3 fold: a parent that keeps vanishing under
          // mkdirDurably must not spin past `lockWaitMs` — honour
          // the deadline before re-looping.
          if (Date.now() >= deadline) throw new S5LockBusyError(regPath, Date.now() - started);
          mkdirDurably(dirname(regPath), sync);
          continue;
        }
        throw Object.assign(
          new Error(
            `S5 lock acquire failed on ${regPath}: ${err instanceof Error ? err.message : String(err)}`,
          ),
          {
            cause: err,
            // Audit c15-F2 fold: the original errno survives the
            // wrap — a caller distinguishes EACCES (permissions)
            // from EIO/EEXIST by `code`, not by parsing text.
            code: (err as NodeJS.ErrnoException)?.code,
          },
        );
      }
    }
    // Audit c22-F2 fold: EEXIST alone does not prove a DIRECTORY —
    // a pre-cycle-4 protocol left a REGULAR FILE at `<log>.lock`,
    // and every later claim-open then fails ENOTDIR (raw errno on
    // every call, sweep unreachable). Validate the shape here and
    // refuse DETERMINISTICALLY with a stable code; never delete a
    // foreign file — a non-directory here may be arbitrary user
    // data, and removal is an operator/migration decision.
    try {
      if (!statSync(regPath).isDirectory()) {
        throw Object.assign(
          new Error(
            `S5 lock registry path ${regPath} exists but is NOT a directory (pre-cycle-4 legacy lock file or foreign entry) — refusing; the operator must remove or migrate it`,
          ),
          { code: "ENOTDIR" },
        );
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOTDIR") throw e;
      // raced deletion: the loop retries mkdirSync.
    }
    // (2) Our claim entry, O_EXCL on a name nothing else can carry
    // (our pid + creation-ms + 64 random bits — cycle-6 m-minor
    // fold: honest wording, `randomBytes(8)` is 64 bits, not 128).
    // The pid field is the sweep's liveness handle; the creation-ms
    // + random bits keep the name unique and unforgeable (cycle-7
    // B1: createdMs is NO LONGER an ordering key — admission is
    // sole-occupancy, and a clock field that only ever identified
    // its creator is exactly the residue the ordering proof used
    // to weaponize).
    const claimName = `claim-${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`;
    const claimPath = `${regPath}/${claimName}`;
    let fd: number;
    try {
      fd = openSync(claimPath, "wx", 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST") {
        // ENOENT: a releaser's rmdir won the race against the
        // registry — recreate next round. EEXIST: astronomically
        // improbable name collision — retry likewise.
        if (Date.now() >= deadline) throw new S5LockBusyError(regPath, Date.now() - started);
        backoffSleepSync(deadline);
        continue;
      }
      throw Object.assign(
        new Error(
          `S5 lock acquire failed on ${regPath}: ${err instanceof Error ? err.message : String(err)}`,
        ),
        { cause: err, code: (err as NodeJS.ErrnoException)?.code },
      );
    }
    let token: string;
    let st: ReturnType<typeof fstatSync>;
    try {
      token = `${process.pid} ${randomBytes(8).toString("hex")}\n`;
      writeFileSync(fd, token);
      sync(fd, "lock-acquire");
      st = fstatSync(fd);
    } catch (err) {
      // Audit c1 fold: never leak a half-created claim/descriptor.
      // Our entry's NAME is unforgeable, so the cleanup unlink
      // cannot hit a successor's claim (the old fenced-cleanup dance
      // protected a SHARED path name — there is no shared name here).
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
      try {
        unlinkSync(claimPath);
      } catch {
        /* best effort */
      }
      throw Object.assign(
        new Error(
          `S5 lock acquire failed on ${regPath} after claim: ${err instanceof Error ? err.message : String(err)}`,
        ),
        { cause: err, code: (err as NodeJS.ErrnoException)?.code },
      );
    }
    // (3) Crash recovery, then (4) the exclusivity proof.
    sweepStaleClaims(regPath, opts.lockStaleMs);
    const listing = liveClaims(regPath);
    const live = listing.entries;
    const mine = live.find((e) => e.name === claimName);
    if (mine === undefined) {
      // c1-Q3 fold (audit c8): an empty list from a FAILED listing
      // does NOT prove our entry vanished — a transient readdir
      // error (EMFILE, EIO) reads the same as an absent registry.
      // Our claim NAME is unforgeable, so if the entry exists it is
      // ours: unlink it best-effort and refuse busy. Leaving it
      // would carry OUR LIVE pid, which sweepStaleClaims never
      // removes — every later acquirer (including other processes)
      // would refuse until this process exits: a self-wedge.
      if (listing.listingFailed) {
        // Audit c2-Q2 fold (cycle-9): the c1-Q3 refusal fired on the
        // FIRST failed listing, spending none of `lockWaitMs` — a
        // single transient readdir error (EMFILE under fd pressure,
        // EIO) rejected the whole acquire while the caller's budget
        // for waiting had not even begun. The listing is re-tried
        // every round, so one error is not proof of contention:
        // remove OUR entry (leaving it would carry OUR LIVE pid,
        // which sweepStaleClaims never removes — a self-wedge), then
        // fall through to the deadline path: backoff and retry
        // until `lockWaitMs` is exhausted, where it fails CLOSED as
        // S5LockBusyError — never lockless, never an early refusal.
        try {
          closeSync(fd);
        } catch {
          /* best effort */
        }
        try {
          unlinkSync(claimPath);
        } catch {
          /* already gone */
        }
        if (Date.now() >= deadline) {
          throw new S5LockBusyError(logPath, Date.now() - started);
        }
        backoffSleepSync(deadline);
        continue;
      }
      // Our OWN entry vanished mid-acquire (external tampering with
      // an unforgeable name — fail closed, nothing gained).
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
      throw new S5LockLostError(claimPath);
    }
    // SOLE-CLAIM EXCLUSIVITY PROOF (cycle-7 B1 fold, audit c6
    // BLOCKER 1): admitted ONLY when the registry holds exactly one
    // live entry and it is OURS. This replaced the (createdMs,
    // name) ordering proof: a backwards-running or skewed clock
    // makes "I am earliest" observable as TRUE by two contenders
    // (the earlier holder admitted before the skewed claim appeared;
    // the skewed claim sees itself as earliest afterwards). Every
    // contender enumerates AFTER its own create, so no contender
    // can observe "alone" while another live entry exists — no
    // clock, no order, no tie-break falsifies this predicate. Any
    // other live entry (ANY shape, ANY creation time, ANY name —
    // including foreign/legacy residue the sweep cannot yet remove)
    // means we yield.
    if (live.length === 1) {
      // ACQUIRED: sole occupant by observation AFTER our own entry
      // existed. Live-later claimers see us and yield (their
      // entries are never touched by us); dead-stale ones were
      // swept above. The unit runs; the fence re-proves the claim
      // at every mutation.
      return { path: claimPath, fd, dev: st.dev, ino: st.ino, token };
    }
    // Not alone: another entry occupies the registry. Give up OUR
    // entry (ours alone — no vacancy of any other claim is
    // created). Before waiting, distinguish a LIVE occupant from
    // stale residue the sweep could not reach this round (a fresh-
    // but-empty partial, or one aged past lockStaleMs only while we
    // deliberated): re-sweep and re-enumerate NOW — waiting on dead
    // residue would wedge recovery for a whole lockStaleMs. A live
    // occupant (or one the pid gate protects) still refuses at the
    // deadline: fail closed, never lockless.
    try {
      unlinkSync(claimPath);
    } catch {
      /* already gone */
    }
    try {
      closeSync(fd);
    } catch {
      /* best effort */
    }
    sweepStaleClaims(regPath, opts.lockStaleMs);
    const after = liveClaims(regPath);
    // c1-Q3 fold: a FAILED listing says nothing about residue —
    // keep waiting (fail closed); only a CONFIRMED-empty registry
    // short-circuits the deadline.
    if (!after.listingFailed && after.entries.length === 0) {
      continue; // residue cleared — claim fresh next round
    }
    if (Date.now() >= deadline) {
      throw new S5LockBusyError(regPath, Date.now() - started);
    }
    backoffSleepSync(deadline);
  }
}

/** Holder pid from a claim token ("`pid` hex\n"); null when the
 *  claim carries none (crash-between-create-and-write partial). */
function parseHolderPid(token: string): number | null {
  const m = /^(\d+)\s/.exec(token);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** signal(pid, 0) probe: EPERM (exists, not ours) counts as alive;
 *  only ESRCH (no such process) means dead. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Release a held claim (cycle-4 B1 fold — see the header's
 * EXCLUSIVE OWNERSHIP section): unlink OUR OWN entry (its
 * unforgeable name is the fence — nothing else can own it, so no
 * stat-verify/rename dance is needed and NONE is wanted: the old
 * rename-verify(-undo) protocol briefly exposed the lock path as
 * acquirable while it verified a foreign claim — terra c4
 * BLOCKER 1), then attempt to remove the registry with rmdir —
 * which succeeds ONLY when the directory is empty, so it can never
 * evict a live claim (a racing acquirer's entry makes it fail
 * ENOTEMPTY, harmless; a racing mkdir-then-create keeps the new
 * claim either way). Diagnostics-only: no fsync is owed to a claim
 * being torn down — one fsync per pass is owed to the LOG.
 */
function releaseLock(held: HeldLock): void {
  const regPath = dirname(held.path);
  // Fenced unlink (audit c1 fold, registry shape): remove our entry
  // only while the path still identifies OUR inode. By protocol the
  // name is unforgeable, so this only fires against an adversary
  // that removed our entry and FORGED a file at its path — in which
  // case the claim was already lost and the forgery is not ours to
  // delete (cycle-3 m9 scenario).
  try {
    const now = statSync(held.path);
    if (now.dev === held.dev && now.ino === held.ino) unlinkSync(held.path);
  } catch {
    /* already gone (swept/tampered) — the claim was lost, not ours */
  }
  // Registry cleanup: rmdir succeeds only with zero live claims.
  try {
    rmdirSync(regPath);
  } catch {
    /* still claimed, already removed, or vanished — all fine */
  }
  try {
    closeSync(held.fd);
  } catch {
    /* best effort — release must not hang */
  }
}

/** Refresh the claim's mtime at a phase boundary (bounded-unit
 *  heartbeat; see the header's bounded-unit requirement).
 *  CYCLE-6 B1 FOLD: the heartbeat governs ONLY staleness (who may
 *  sweep this entry). It is NOT part of the acquisition order —
 *  that is the immutable creation time encoded in the claim NAME.
 *  Refreshing mtime therefore can never move a live holder ahead
 *  of (or behind) another contender in the exclusivity proof. */
function touchLock(held: HeldLock): void {
  // haiku c3 m2 fold: futimes on OUR held fd — a zombie holder
  // whose claim was taken over must not refresh its SUCCESSOR's
  // mtime through the path (utimes cannot resurrect a claim, but
  // liveness credit must stay with the holder that owns the fd).
  const now = new Date();
  try {
    futimesSync(held.fd, now, now);
  } catch {
    /* best effort */
  }
}

/** MUTATION-TIME OWNERSHIP FENCE (cycle-2 fold): a stale-takeover
 *  race can admit a third contender while a victim's claim is
 *  briefly renamed away — READ phases may overlap harmlessly, but
 *  MUTATION may not: immediately before any write, the claim must
 *  still be ours (the path resolving to OUR inode — inode identity
 *  is exact while our fd keeps the inode pinned). Lost claim ⇒
 *  fail-stop BEFORE mutation; the successor owns the log alone.
 *  Success also refreshes mtime (post-check stealer window =
 *  bounded-unit rule). */
function assertClaimHeld(held: HeldLock): void {
  let now: ReturnType<typeof statSync>;
  try {
    now = statSync(held.path);
  } catch {
    throw new S5LockLostError(held.path);
  }
  if (now.dev !== held.dev || now.ino !== held.ino) {
    throw new S5LockLostError(held.path);
  }
  // Content fence (cycle-3 fold): our inode's name may be restored
  // or recreated while pinned; require OUR exact token bytes too
  // before any mutation proceeds.
  try {
    if (readFileSync(held.path, "utf8") !== held.token) throw new S5LockLostError(held.path);
  } catch (err) {
    if (err instanceof S5LockLostError) throw err;
    throw new S5LockLostError(held.path);
  }
  touchLock(held);
}

/* ------------------------------------------------------------------ *
 * Transport read + (c0)-class validation                              *
 * ------------------------------------------------------------------ */

export type TailKind = "none" | "complete" | "partial";

interface FileState {
  /** Terminated lines (no empty-line filtering: empty lines are
   *  corrupt and reported; validated before any mutation). */
  readonly lines: string[];
  /** Bytes through the final newline (repair-truncate offset). */
  readonly completeBytes: number;
  readonly tailKind: TailKind;
  /** Decoded tail text (valid UTF-8 iff tailKind === "complete";
   *  null when the tail failed strict decoding → partial). */
  readonly tailText: string | null;
  readonly tailBytes: number;
  /** A tail that decodes strictly, ends with `\r`, and whose text
   *  WITHOUT the trailing `\r` is a valid line: a complete record
   *  touched by an external CRLF editor (audit c8 Q2 fold). A
   *  writer can never produce it (writes end in `\n`), so V-g1
   *  crash-residue semantics do not apply — classifying it partial
   *  and silently ftruncating it would discard a parseable record
   *  the same bytes mid-file would have refused as corrupt.
   *  appendUnit refuses the pass (V-g4 class, S5LogCorruptionError,
   *  repair untouched); replay() reports it in corruptLines. */
  readonly tailCorrupt: boolean;
  /** Set when the complete region itself is not valid UTF-8. */
  readonly invalidUtf8: boolean;
  /** (st_dev, st_ino) of the descriptor THIS read ran on (cycle-7
   *  M2 fold), or null when the log did not exist. Every later
   *  sync/mutation of the pass re-proves its opened descriptor
   *  against this — an external rm + recreate between the read
   *  and the write fail-stops with S5LogIdentityError. */
  readonly identity: FileIdentity | null;
  /** sha256 (hex) of the EXACT bytes read through that descriptor
   *  (audit c8 Q2 fold), or null when the log did not exist. An
   *  (st_dev, st_ino) match cannot see CONTENT: on filesystems that
   *  recycle freed inode numbers, rm + recreate can hand the path
   *  a NEW file with the OLD inode number and the identity gate
   *  alone would vouch for bytes that are gone. The pre-return
   *  replay gate re-reads and re-digests, so a reused-inode swap is
   *  caught unless the recreation is byte-IDENTICAL — the only
   *  escape, and it is indistinguishable from an unchanged file. */
  readonly contentDigest: string | null;
}

function readState(logPath: string): FileState {
  const empty: FileState = {
    lines: [],
    completeBytes: 0,
    tailKind: "none",
    tailText: null,
    tailBytes: 0,
    tailCorrupt: false,
    invalidUtf8: false,
    identity: null,
    contentDigest: null,
  };
  // Cycle-7 M2 fold: read through ONE descriptor and take the
  // identity from its fstat — a path-keyed read cannot say WHICH
  // inode the bytes it classified came from, and an rm+recreate
  // between read and mutation would then be invisible (audit c6
  // BLOCKER 2: the proof and the mutation can name different
  // files while both spell the same path).
  let fd: number;
  try {
    fd = openSync(logPath, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw err;
  }
  let buf: Buffer;
  let identity: FileIdentity;
  try {
    identity = identityOfFd(fd);
    buf = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  // Audit c8 Q2 fold: fingerprint the exact bytes this descriptor
  // read (see FileState.contentDigest).
  const contentDigest = createHash("sha256").update(buf).digest("hex");
  if (buf.length === 0) return { ...empty, identity, contentDigest };
  const lastNl = buf.lastIndexOf(0x0a);
  const complete = lastNl < 0 ? buf.subarray(0, 0) : buf.subarray(0, lastNl + 1);
  const tail = lastNl < 0 ? Buffer.from(buf) : Buffer.from(buf.subarray(lastNl + 1));
  if (complete.length === 0) {
    // No terminated region at all: ZERO lines ("" must never split
    // into [""] — a log whose FIRST record lost its newline is a
    // pure V-g2 tail, a partial first byte-run a pure V-g1 tail;
    // cycle-2 fold).
    if (tail.length === 0) return { ...empty, identity, contentDigest };
    const t0 = decodeStrict(tail);
    // c8-Q2 fold (audit cycle-8): a strict-decoding tail ending in
    // a raw \r whose text WITHOUT the \r is a valid record is an
    // external CRLF-editor's complete record, not crash residue —
    // a writer can never produce it (writes are `json` + "\n"; raw
    // \r lives only inside escaped string bytes). Classifying it
    // partial would silently ftruncate a record that the SAME
    // bytes mid-file refuse as corrupt. Refuse instead. A tail
    // ending \r that does NOT parse even without the \r stays
    // ordinary torn residue (the "\r\n" half-write cannot be
    // distinguished from any partial fragment).
    const c0 = t0 !== null && t0.endsWith("\r") && lineIsValid(t0.slice(0, -1));
    const k0: TailKind =
      t0 !== null && lineIsValid(t0) && !t0.endsWith("\n") ? "complete" : "partial";
    return { lines: [], completeBytes: 0, tailKind: k0, tailText: t0, tailBytes: tail.length, tailCorrupt: c0, invalidUtf8: false, identity, contentDigest };
  }
  const completeText = decodeStrict(Buffer.from(complete));
  if (completeText === null) {
    return { ...empty, invalidUtf8: true, tailBytes: tail.length, identity, contentDigest };
  }
  // Keep empty lines: `a\n\nb\n` → ["a", "", "b"]; the artifact after
  // the trailing newline is dropped, interior blanks survive as
  // validation targets.
  const lines = completeText.slice(0, -1).split("\n");
  if (tail.length === 0) {
    return { lines, completeBytes: lastNl + 1, tailKind: "none", tailText: null, tailBytes: 0, tailCorrupt: false, invalidUtf8: false, identity, contentDigest };
  }
  const tailText = decodeStrict(tail);
  // A tail that strictly decodes AND parses as one JSON record (no
  // newline inside JSON strings — they are escaped) is a complete
  // record whose terminator was lost (V-g2). Anything else is a
  // partial fragment (V-g1) — including invalid UTF-8 (a torn
  // multi-byte character). c8-Q2 fold: a tail ending in a raw \r
  // that parses once the \r is stripped is a CRLF-editor's record
  // (never writer-produced) — tailCorrupt, refused, not silently
  // truncated (see the no-complete-region branch above).
  const tailCorrupt =
    tailText !== null && tailText.endsWith("\r") && lineIsValid(tailText.slice(0, -1));
  const kind: TailKind =
    tailText !== null && tailText.length > 0 && lineIsValid(tailText) && !tailText.endsWith("\n")
      ? "complete"
      : "partial";
  return { lines, completeBytes: lastNl + 1, tailKind: kind, tailText, tailBytes: tail.length, tailCorrupt, invalidUtf8: false, identity, contentDigest };
}

export interface ReplayResult<T> {
  /** Complete records in append order (incl. a V-g2 complete-but
   *  unterminated tail record — it CLASSIFIES; repair only adds the
   *  newline). */
  readonly records: T[];
  /** 1-based numbers of lines that fail transport validation. */
  readonly corruptLines: number[];
  readonly tailKind: TailKind;
  /** Bytes after the final newline. */
  readonly tornTailBytes: number;
  /** Durability of the returned prefix as seen by THIS instance:
   *  "proven" once a successful fsync established the readable
   *  bytes (v33); "unproven" until then. */
  readonly durability: "proven" | "unproven";
}

/* ------------------------------------------------------------------ *
 * The wrapper                                                         *
 * ------------------------------------------------------------------ */

/** Outcome of a serialized append unit. */
export type UnitResult<T> =
  | {
      readonly status: "acked";
      /** The records this unit made durable (all of them — one
       *  write, one fsync, V-g13). */
      readonly appended: T[];
      /** NDR-r case (b) at transport level: incoming records whose
       *  id+bytes already stand in the durable prefix — reported
       *  separately as refiling CANDIDATES (intake mints the
       *  rejected-duplicate finding; this layer never claims
       *  findings). Not re-appended. Intra-unit note (audit c16-F1):
       *  a SECOND identical copy of an id within the SAME unit is
       *  also reported refiled — its first copy stands in the
       *  prefix by this commit, so "already stands" is evaluated
       *  at return, not strictly pre-unit; the second copy is never
       *  written and never acked as appended. */
      readonly refiled: string[];
      readonly durability: "fsynced";
    }
  | {
      readonly status: "refiled-only";
      readonly appended: [];
      /** Every incoming record was an identical transport redelivery
       *  (and nothing needed repair): the pass writes nothing, so it
       *  owes no log fsync — one-fsync-per-PASS. The prefix it
       *  rests on was established by this instance (an
       *  `establish-prefix` fsync runs when needed, v33/audit c1
       *  fold) — the decision is never returned on unproven bytes. */
      readonly refiled: string[];
      readonly durability: "nothing-written";
    };

/** Write the whole buffer at `position`, looping over short writes. */
function writeAll(fd: number, buf: Buffer, position: number): void {
  let off = 0;
  for (;;) {
    const n = writeSync(fd, buf, off, buf.length - off, position + off);
    if (n <= 0) {
      // Zero progress is not a short write to retry: fail-stop
      // rather than hold the claim looping (cycle-3 fold).
      throw new Error(`S5 writeAll: zero-byte write at offset ${position + off} (fail-stop)`);
    }
    off += n;
    if (off >= buf.length) return;
  }
}

export class S5Log<T extends { id: string }> {
  private readonly opts: {
    path: string;
    lockWaitMs: number;
    lockStaleMs: number;
    sync: SyncFn;
  };
  private established = false;
  /** Byte watermark: this instance has PROVEN durability for the
   *  log's first `provenThrough` bytes (v33; cycle-2 fold — an
   *  instance-wide boolean was wrong: a pass that wrote bytes and
   *  then FAILED its fsync left the flag true over unproven bytes,
   *  and a foreign append between passes escaped the proof). Any
   *  re-read whose terminated region ends beyond the watermark (or
   *  whose tail holds bytes past it) re-establishes before the
   *  bytes are relied upon.
   *  CYCLE-6 M4 FOLD + CYCLE-7 M2 REFINEMENT: the watermark is
   *  bound to the file IDENTITY `(dev, ino)` it was earned on
   *  (`provenOn`). An external `rm` + recreate (or a plain `rm`
   *  with later re-creation) swaps the inode; the OLD proof says
   *  nothing about the NEW file's bytes. Enforcement is layered:
   *  the HARD layer is per-descriptor — every sync and every
   *  mutation re-proves the opened descriptor's identity against
   *  the identity the pass READ (`assertSameInode`), so a proof
   *  can never be earned or spent on a foreign inode. The SOFT
   *  layer is `ensureEstablished`'s between-passes path stat: it
   *  exists only to DISCARD a stale proof early (so the ritual
   *  re-runs against the new file); a swap it cannot see is
   *  harmless, because the hard layer refuses at the descriptor.
   *  The path is never the ENFORCER — an `(dev, ino)`-keyed
   *  watermark would be TOCTOU-rotten on reuse, so the proof
   *  advances ONLY in lockstep with a sync that ran (cycle-7 M2). */
  private provenThrough = 0;
  private provenOn: { dev: number; ino: number } | null = null;

  constructor(options: S5LogOptions) {
    this.opts = {
      path: options.path,
      lockWaitMs: options.lockWaitMs ?? 5000,
      lockStaleMs: options.lockStaleMs ?? 30_000,
      sync: options.sync ?? ((fd) => fsyncSync(fd)),
    };
  }

  /** Durability establishment ONCE per file (v33), against the log
   *  itself, before the first operation touching it. Cycle-6 M4
   *  fold: establishment RECORDS the identity `(dev, ino)` the
   *  proof was earned on (taken with the claim held — no window). */
  private ensureEstablished(): void {
    if (this.established) {
      // Identity re-check under the claim (cycle-6 M4): an
      // external rm + recreate swaps the inode between passes;
      // the OLD proof is about a DIFFERENT file — drop it and re-
      // run the ritual against the new one. (With cycle-7 M2 a
      // proof EXISTS only once a sync actually ran, so
      // `provenOn === null` with bytes still owed is the normal
      // marker-skipped shape — nothing to drop yet.)
      if (this.provenOn !== null) {
        try {
          const st = statSync(this.opts.path);
          if (this.provenOn.dev !== st.dev || this.provenOn.ino !== st.ino) {
            this.established = false;
            this.provenThrough = 0;
            this.provenOn = null;
          } else if (st.size < this.provenThrough) {
            // Audit c17-F1 fold: same inode, SHRUNK — an external
            // truncate (in place, no rm) destroyed the tail this
            // instance synced, and any bytes now under the new
            // size may be REWRITTEN ones that no past fsync ever
            // covered. Clamping to `st.size` would still label
            // fresh unsynced bytes proven, so the whole proof is
            // dropped: the next pass re-establishes via
            // `establish-prefix` for whatever bytes it relies on.
            // (Shrink can only be SEEN through the size; a same-
            // size in-place rewrite stays the documented
            // identity-not-content residual.)
            this.provenThrough = 0;
          }
        } catch {
          this.established = false; // deleted (ENOENT) — ritual recreates
          this.provenThrough = 0;
          this.provenOn = null;
        }
      }
      if (this.established) return;
    }
    const est = establishDurability(this.opts.path, this.opts.sync);
    // Cycle-7 M2 fold: the identity arrives WITH the proof — the
    // (dev, ino) of the descriptor the ritual's fsync ran on (or
    // null when no sync ran, i.e. the marker-skipped path). The
    // OLD shape re-statted the PATH after the ritual returned:
    // an rm + recreate in that window relabeled the proof onto a
    // foreign inode.
    this.provenThrough = est.provenBytes;
    this.provenOn = est.identity;
    this.established = true;
    // The ritual's log-fd sync (when it ran) proved every byte that
    // existed at that instant; a marker-skipped establishment synced
    // nothing here, so the watermark is 0 and the first pass pays an
    // `establish-prefix` sync for the bytes it relies on (v33).
  }

  /**
   * The serialized unit (NDR-i critical section), in the restart's
   * ORDERED shape (audit c1 fold: `make()` — carrying the caller's
   * semantic checks, e.g. recovery's (c1a) — runs after validation,
   * BEFORE any mutation, and before the establishing sync of the
   * decision it returns ((c1a) → (c1c) order; sync-before-ack)):
   *   acquire → read → (c0) validate WITHOUT mutation (V-g4:
   *   corrupt mid-file line/blank line/invalid UTF-8 rejects here,
   *   repair untouched) → classify the tail and build the prefix
   *   (V-g2's complete tail CLASSIFIES) → `make()` → NDR-r
   *   classification → establishing sync (when this instance must
   *   rely on unknown-origin bytes; failure fail-stops, V-g3) →
   *   repair (V-g1 truncate / V-g2 terminate) + append under ONE
   *   fsync → ack → release. Any throw before the mutation phase
   *   mutates nothing; the lock releases on every path.
   *
   * `make()` CONTRACT (terra c3 fold): it must be side-effect free
   * and MUST NOT use `prefix.durability` as a semantic input — the
   * label reflects THIS instance's pre-sync watermark and `make()`
   * is never re-run after the establishing sync, so a decision
   * conditioned on it could differ from one made on the now-proven
   * prefix. Use it for VALIDATION of the prefix and DERIVATION of
   * the outgoing records only; durability never changes what the
   * unit should append.
   */
  appendUnit(make: (prefix: ReplayResult<T>) => readonly T[]): UnitResult<T> {
    const held = acquireLock(this.opts.path, this.opts, this.opts.sync);
    try {
      const state = readState(this.opts.path);

      // (c0) VALIDATION WITHOUT MUTATION (V-g4): blank/corrupt
      // mid-file lines and invalid UTF-8 in the complete region
      // reject the pass before ANY repair — the repairable final
      // fragment stands untouched too.
      if (state.invalidUtf8) {
        throw new S5LogCorruptionError(this.opts.path, 0, "invalid-utf8");
      }
      for (let i = 0; i < state.lines.length; i++) {
        if (!lineIsValid(state.lines[i]!)) {
          throw new S5LogCorruptionError(this.opts.path, i + 1, "corrupt-line");
        }
      }
      // c8-Q2 fold (audit cycle-8): a complete-looking record lost
      // behind a raw \r (external CRLF editor) refuses like any
      // other non-canonical line — it is NEVER silently truncated
      // as if it were crash residue.
      if (state.tailCorrupt) {
        throw new S5LogCorruptionError(this.opts.path, state.lines.length + 1, "corrupt-line");
      }

      // Audit c2-Q3 fold (cycle-9): an external `rm` that lands
      // AFTER this pass read bytes (`state.identity !== null`) must
      // never be healed by the ritual below — the ritual CREATES a
      // log the operator just removed (and republishes its
      // durability marker) only for the inode gates to refuse the
      // pass anyway. The fresh-instance path (recreate + re-ritual)
      // is legitimate ONLY when this pass read nothing
      // (`state.identity === null`: the deletion preceded the
      // read). Refuse the mid-pass deletion here, before any
      // side-effect, with the same error class every other
      // identity gate throws: nothing written, nothing recreated.
      if (state.identity !== null && !existsSync(this.opts.path)) {
        throw new S5LogIdentityError(this.opts.path);
      }

      // ESTABLISHMENT UNDER THE CLAIM, AFTER VALIDATION (cycle-3
      // fold): the bootstrap ritual (dir-entry durability; it never
      // mutates content) is serialized with all log operations —
      // two racing bootstraps can no longer interleave marker
      // writes or let one instance count another's unproven bytes
      // proven — and runs only after the current content validated,
      // so a corrupt log is never establishing-synced.
      this.ensureEstablished();

      // Prefix incl. the V-g2 complete tail record (it classifies).
      const recordTexts = state.tailKind === "complete" && state.tailText !== null
        ? [...state.lines, state.tailText]
        : state.lines;
      // The bytes RELIED ON by any decision this pass makes: the
      // terminated region plus a complete tail record (a partial
      // fragment is never relied on — it is repaired away).
      const reliedBytes = state.completeBytes + (state.tailKind === "complete" ? state.tailBytes : 0);
      let prefix = buildPrefix<T>(recordTexts, state.tailKind, state.tailBytes, this.provenThrough >= reliedBytes ? "proven" : "unproven");

      // (c1a) SEMANTIC CHECKS FIRST (cycle-2 fold): `make()` — where
      // recovery.ts runs its O1/O2/O3 and one-per-act checks — sees
      // the byte-validated prefix (its `durability` flag honestly
      // says whether this instance has proven the bytes yet) and may
      // THROW before any sync or mutation happens.
      const incoming = make(prefix);

      // (c1c) ESTABLISHING SYNC (v33; byte-watermarked per cycle-2
      // fold): the bytes this pass relies on beyond what THIS
      // instance already proved get one fsync BEFORE the NDR-r
      // decision and before any ack — an indeterminate record from a
      // failed pass of this or any other instance is established
      // before it can classify a redelivery. A rejected pass threw
      // above, so a bad file is still never synced. Sync failure
      // fail-stops (V-g3): no ack, watermark unmoved.
      if (this.provenThrough < reliedBytes) {
        let efd: number;
        try {
          efd = openSync(this.opts.path, "r+");
        } catch (err) {
          // Audit c2-Q3 fold (cycle-9): a mid-pass deletion that
          // lands between the read and this open (e.g. as a
          // side effect of `make()`) must surface as the SAME
          // identity error every other gate throws — a raw ENOENT
          // escaping here would classify the disappearance as an
          // I/O accident, and callers keying on S5LogIdentityError
          // for "the file you read is gone" would miss it. With
          // bytes read, a vanished path IS an identity loss.
          if ((err as NodeJS.ErrnoException).code === "ENOENT" && state.identity !== null) {
            throw new S5LogIdentityError(this.opts.path);
          }
          throw err;
        }
        // Cycle-7 M2 fold: the sync must run on the SAME inode the
        // pass READ — an external rm + recreate between readState
        // and this open means the bytes classified are not the
        // bytes standing. Refuse before the sync: they are never
        // proven, nothing is acked.
        assertSameInode(state.identity, identityOfFd(efd), this.opts.path);
        try {
          this.opts.sync(efd, "establish-prefix");
        } catch (err) {
          // V-g3 class: fail-stop — no ack, nothing relied upon.
          throw err;
        } finally {
          closeSync(efd);
        }
        this.provenThrough = reliedBytes;
        // The watermark now belongs to the descriptor just synced
        // (cycle-7 M2: proof and identity advance together).
        this.provenOn = state.identity;
        prefix = buildPrefix<T>(recordTexts, state.tailKind, state.tailBytes, "proven");
      }
      touchLock(held);

      // NDR-r classification against the current prefix, under the
      // lock; the FIRST durable occurrence of an id is its
      // predecessor. Transport key: envelope id + exact bytes
      // (scope note in the header).
      const existing = new Map<string, string>();
      for (const text of recordTexts) {
        const rec = JSON.parse(text) as { id: string };
        if (!existing.has(rec.id)) existing.set(rec.id, text);
      }
      const refiled: string[] = [];
      const toAppend: Array<{ rec: T; line: string }> = [];
      for (const recIn of incoming) {
        // Cycle-3 fold: each incoming record is SERIALIZED EXACTLY
        // ONCE and the bytes are transport-validated here — the same
        // immutable bytes drive classification AND the payload
        // (a stateful toJSON() can no longer classify one byte
        // string and write another), and an input like {id:""} is
        // refused NOW rather than acknowledged and rejected by the
        // next reader as a corrupt line.
        if (recIn === null || typeof recIn !== "object" || typeof recIn.id !== "string") {
          throw new S5InvalidInputError(String((recIn as { id?: unknown })?.id ?? ""));
        }
        const line = JSON.stringify(recIn);
        if (!lineIsValid(line)) {
          throw new S5InvalidInputError(recIn.id);
        }
        // Cycle-4 fold (BLOCKER 2, terra audit): identity is read
        // back FROM the once-serialized bytes. A stateful toJSON()
        // that REWRITES `id` would classify the record under its
        // input id while every reader (and every replay) indexes the
        // durable bytes by the SERIALIZED id — one record, two
        // identities, dedup semantics forked. Divergence is REFUSED
        // here (pre-mutation, so the unit stays atomic); with equal
        // ids classification and durable indexing are the same
        // operation by construction.
        const rec = JSON.parse(line) as T & { id: string };
        if (rec.id !== recIn.id) {
          throw new S5InvalidInputError(recIn.id);
        }
        const prev = existing.get(rec.id);
        if (prev === undefined) {
          // The record the caller gets back is deserialized FROM
          // THE ONCE-SERIALIZED BYTES (structured-clone shape;
          // post-append caller mutation cannot alias stored state).
          toAppend.push({ rec, line });
          existing.set(rec.id, line); // intra-unit base
          continue;
        }
        if (prev === line) {
          refiled.push(rec.id); // (b) refiling candidate — not re-appended
          continue;
        }
        // (c) divergent bytes — transport replay-integrity refusal:
        // NOTHING appended (the unit is atomic), clean prefix.
        throw new S5ReplayIntegrityError(rec.id, prev, line);
      }

      // MUTATION PHASE (post-decision; repaired-then-appended under
      // exclusive ownership; ONE fsync covers repair + appends).
      if (toAppend.length === 0 && state.tailKind === "none") {
        // Nothing written: no pass fsync owed; prefix already
        // proven above if it was relied upon. The CLAIM must still
        // stand when the decision is handed to the caller: a
        // refiling report returned under a lost claim could be
        // stale (cycle-3 fold) — fence before ANY caller-visible
        // decision, not only before writes.
        assertClaimHeld(held);
        // Audit c2-Q3 fold (cycle-9), hardened by audit c5-Q1 fold
        // (cycle-9): the refiled-only report is a caller-visible
        // decision about bytes that were in the log — the same
        // decision-provenance rule as replay's pre-return snapshot
        // proof. The original `!existsSync` fence caught a bare
        // deletion but NOT an rm + RECREATE: the receipt could
        // report `refiled: [X]` while the standing file was a
        // different inode (and content) that never held X — the
        // acked path and replay() re-prove identity, so an
        // existsSync-only fence left this return inconsistent with
        // the stated rule. Now: the FULL c8 snapshot proof (path
        // (dev,ino) AND the content digest of the bytes this pass
        // read) before the receipt is handed over. (Null read
        // identity: the deletion preceded the read — nothing was
        // read, `refiled` is necessarily empty, and the fresh-
        // instance premise stands.)
        if (state.identity !== null) {
          assertSnapshotIntact(state, this.provenOn, this.opts.path);
        }
        return { status: "refiled-only", appended: [], refiled, durability: "nothing-written" };
      }

      // The claim must still be OURS before ANY mutation (cycle-2
      // fold; the loss window is closed for units honoring the
      // bounded-phase rule — an overrunning holder forfeits).
      assertClaimHeld(held);
      // Same-instance log DELETION (cycle-3 m5 fold): the operator
      // removed the log after our establishment; our in-instance
      // `established` flag is stale. Clear it and re-run the ritual
      // (it recreates the file and republishes the marker — the
      // fresh-instance path) before opening for mutation.
      // Audit c2-Q3 fold (cycle-9): that ritual is for a deletion
      // BETWEEN passes — readState already saw nothing, so the pass
      // classified zero bytes and the fresh-instance path is exact.
      // When this pass DID read bytes (`state.identity !== null`)
      // and the path is now gone, the deletion happened MID-pass:
      // the ritual would recreate the file only for the very next
      // `assertSameInode` to refuse (the fd is the new inode, the
      // proof is the deleted one) — a failed pass with the side
      // effect of recreating a log the operator just removed, and
      // an `rm` indistinguishable from the rm+recreate this gate
      // already refuses as S5LogIdentityError. Refuse BEFORE the
      // ritual: same error class as the recreate case, and the
      // failed pass leaves no file behind.
      if (!existsSync(this.opts.path)) {
        if (state.identity !== null) {
          throw new S5LogIdentityError(this.opts.path);
        }
        this.established = false;
        this.ensureEstablished();
      }
      // Watermark INVALIDATION before mutation (cycle-3 fold): from
      // the first byte the pass may truncate or overwrite, nothing
      // is proven until this pass's fsync succeeds. A failed repair
      // (or failed write) can therefore never leave the OLD
      // watermark covering replacement bytes.
      this.provenThrough = Math.min(this.provenThrough, state.completeBytes);
      const fd = openSync(this.opts.path, "r+");
      try {
        // Cycle-7 M2 fold: identity re-proven on the MUTATION
        // descriptor before a byte is written. With bytes read this
        // pass, the fd must BE the inode we read; with none (the
        // log was absent), the only file we may mutate is the one
        // this instance established — bound through `provenOn`
        // (null on both sides ⇒ an unattributable file appeared
        // while we read nothing: fail-stop, nothing written).
        assertSameInode(state.identity ?? this.provenOn, identityOfFd(fd), this.opts.path);
        let size = fstatSync(fd).size;
        if (state.tailKind === "partial") {
          // V-g1: truncate the fragment away.
          ftruncateSync(fd, state.completeBytes);
          size = state.completeBytes;
        } else if (state.tailKind === "complete") {
          // V-g2: KEEP the record, add back the lost terminator.
          writeAll(fd, Buffer.from("\n", "utf8"), size);
          size += 1;
        }
        if (toAppend.length > 0) {
          // Exactly the bytes classified above — serialized once.
          const payload = Buffer.from(toAppend.map((r) => r.line + "\n").join(""), "utf8");
          writeAll(fd, payload, size);
          size += payload.length;
        }
        // ONE fsync for the whole pass (V-g13): repair and every
        // appended record are established by the same operation.
        this.opts.sync(fd, toAppend.length > 0 ? "append" : "repair");
        // Successful fsync: every byte up to the final written
        // boundary is now proven (cycle-3 fold: advance THROUGH the
        // payload — the pre-append-only accounting made a just-acked
        // record read back as "unproven") — ON this descriptor's
        // identity (cycle-7 M2: the pass's proof belongs to exactly
        // the inode its fsync ran on).
        this.provenThrough = Math.max(this.provenThrough, size);
        this.provenOn = identityOfFd(fd);
      } finally {
        closeSync(fd);
      }
      // Audit c3-Q1 fold (cycle-9): the ACKED return is a
      // caller-visible decision about the bytes this pass wrote —
      // the same decision-provenance rule as the refiled-only
      // fence and replay's pre-return snapshot proof. An external
      // `rm` landing after our fsync (between the sync returning
      // and the caller receiving the ack) means the acked record
      // is not standing at the path: re-check before handing the
      // ack over. A vanished path (ENOENT) or a REPLACED inode
      // refuses as S5LogIdentityError. HONEST LIMIT (auditor-
      // accepted): this narrows the window to the few
      // instructions between this stat and the caller's use of
      // the ack — a rm after the check, or a byte-identical
      // recreation, cannot be distinguished by any in-process
      // gate; the ack is provenance-bounded, not rm-proof.
      // (identityOfPath fails closed as S5LogIdentityError on a
      //  vanished path; the (dev,ino) comparison refuses an rm +
      //  recreate swapping the file under our ack.)
      // Audit c22-F1 fold: the SAME fence the refiled-only receipt
      // and replay pay — our CLAIM must still stand at the moment
      // the ack crosses to the caller. Bytes were mutated under
      // proven ownership, but an ack handed over after the claim
      // was removed (stale-takeover or adversary) could describe
      // a log a successor is already mutating; the acked decision
      // is claim-fenced like every other caller-visible decision.
      assertClaimHeld(held);
      assertSameInode(this.provenOn, identityOfPath(this.opts.path), this.opts.path);
      touchLock(held);
      return { status: "acked", appended: toAppend.map((r) => r.rec), refiled, durability: "fsynced" };
    } finally {
      releaseLock(held);
    }
  }

  /** Single-record append unit (the common shape of `append()`). */
  append(record: T): UnitResult<T> {
    return this.appendUnit(() => [record]);
  }

  /** Read the durable log (transport replay) UNDER the same claim
   *  (full lock lifetime covers reads, audit c1 fold): bytes visible
   *  outside a writer's unit belong to completed passes — except the
   *  indeterminate V-g5 class, which THIS instance establishes with
   *  one fsync before reporting "proven" (a failing sync yields
   *  "unproven" records: readable, not relied-upon). A partial tail
   *  is excluded (V-g1: not part of the durable prefix); a complete
   *  unterminated tail classifies (V-g2). */
  replay(): ReplayResult<T> {
    const held = acquireLock(this.opts.path, this.opts, this.opts.sync);
    try {
      const state = readState(this.opts.path);
      // Cycle-3 fold: a complete region that is not valid UTF-8 has
      // NO line decomposition at all — report it as corruption
      // (throw, matching the pass path) rather than a clean empty
      // prefix that a consumer could mistake for an empty log.
      if (state.invalidUtf8) {
        throw new S5LogCorruptionError(this.opts.path, 0, "invalid-utf8");
      }
      // Audit c2-Q3 fold (cycle-9): same refuse-before-ritual rule
      // as appendUnit — a reader whose snapshot came from bytes now
      // deleted must not have the ritual recreate the file it will
      // then refuse to describe. Null read identity (deletion
      // preceded the read) still takes the fresh-instance path.
      if (state.identity !== null && !existsSync(this.opts.path)) {
        throw new S5LogIdentityError(this.opts.path);
      }
      // Establishment UNDER the claim, after validation — the same
      // ordering as appendUnit (terra c3): two racing bootstraps
      // (one via replay, one via a writer) can never interleave
      // marker writes or count each other's unproven bytes proven.
      this.ensureEstablished();
      const recordTexts = state.tailKind === "complete" && state.tailText !== null
        ? [...state.lines, state.tailText]
        : state.lines;
      const reliedBytes = state.completeBytes + (state.tailKind === "complete" ? state.tailBytes : 0);
      // c8-Q2 fold: a \r-tail record is reported at line
      // lines.length+1 (the tail is the next line after the
      // terminated region), never silently absent.
      const corruptTailLine = state.tailCorrupt ? state.lines.length + 1 : undefined;
      let result = buildPrefix<T>(recordTexts, state.tailKind, state.tailBytes, this.provenThrough >= reliedBytes ? "proven" : "unproven", corruptTailLine);
      if (this.provenThrough < reliedBytes) {
        try {
          const fd = openSync(this.opts.path, "r+");
          try {
            // Cycle-7 M2 fold (audit c6 BLOCKER 2): a reader's
            // watermark may only advance to bytes the sync ran on
            // the SAME inode the read observed — otherwise an
            // rm+recreate mid-pass marks FOREIGN bytes proven.
            assertSameInode(state.identity, identityOfFd(fd), this.opts.path);
            this.opts.sync(fd, "establish-prefix");
          } finally {
            closeSync(fd);
          }
          this.provenThrough = reliedBytes;
          this.provenOn = state.identity;
        } catch (err) {
          if (err instanceof S5LogIdentityError) throw err;
          // Unproven, not an error for a reader: records are
          // delivered with the honest durability flag.
        }
      }
      result = buildPrefix<T>(recordTexts, state.tailKind, state.tailBytes, this.provenThrough >= reliedBytes ? "proven" : "unproven", corruptTailLine);
      // PRE-RETURN IDENTITY + CONTENT RE-PROOF (audit c7 finding-1
      // fold; content extended by audit c8 Q2): the snapshot handed
      // to the caller describes the bytes of ONE inode AND one
      // content digest — the pair `readState` observed. If the path
      // is no longer that inode (an external rm + recreate, or a
      // plain rm) — or IS that inode number but holds different
      // bytes (recycled inode) — the snapshot is fiction: fail-stop
      // rather than deliver records a consumer could act on after
      // the file they came from ceased to exist. The sync-branch
      // check above cannot cover the proven-watermark shape (no
      // sync runs there at all), and it runs BEFORE the watermark
      // advances; this check is the last gate before the caller
      // sees anything. With a null read identity (the log was
      // absent), the only file the snapshot may describe is the
      // one THIS instance established (`provenOn`) — an
      // unattributable file at return time is fail-closed.
      assertSnapshotIntact(state, this.provenOn, this.opts.path);
      // Cycle-4 fold (terra c4 MINOR, replay claim loss): the
      // replay result is a CALLER-VISIBLE decision — a result
      // handed over under a lost claim could have interleaved with
      // a takeover's repair and describe bytes no longer canonical.
      // Re-prove the claim before returning; lost claim ⇒ fail
      // stop (never a possibly-stale snapshot).
      assertClaimHeld(held);
      return result;
    } finally {
      releaseLock(held);
    }
  }
}

function buildPrefix<T>(
  texts: readonly string[],
  tailKind: TailKind = "none",
  tornTailBytes = 0,
  durability: "proven" | "unproven" = "unproven",
  corruptTailLine?: number,
): ReplayResult<T> {
  const records: T[] = [];
  const corruptLines: number[] = [];
  texts.forEach((text, i) => {
    if (lineIsValid(text)) records.push(JSON.parse(text) as T);
    else corruptLines.push(i + 1);
  });
  // c8-Q2 fold (audit cycle-8): a complete-looking record behind a
  // raw \r (external CRLF editor) is reported, not silently absent
  // from a partial tail — replay's snapshot must show it as a
  // corrupt line (1-based), the same class as mid-file \r lines.
  if (corruptTailLine !== undefined) corruptLines.push(corruptTailLine);
  return { records, corruptLines, tailKind, tornTailBytes, durability };
}

/* ------------------------------------------------------------------ *
 * Pure NDR-r transport classifier — exported for callers wanting a
 * pre-flight decision; the AUTHORITATIVE decision (and the
 * act/effect-level NDR-r adjudication) lives above intake / in
 * appendUnit respectively.                                             *
 * CAUTION (audit c16-F2): this helper re-serializes `incoming`
 * (JSON.stringify at call time) to compare against `existingLine`,
 * while appendUnit serializes EXACTLY ONCE and classifies from
 * those bytes (BLOCKER 2 rule). For a record with a stateful
 * toJSON() the two serializations can differ, so a pre-flight here
 * may classify what appendUnit would later refuse, or vice versa —
 * pre-flight equality is NOT a promise of the authoritative
 * verdict. Equal-id divergence is refused by appendUnit pre-
 * mutation. Pass a plain (stateless-toJSON) record for a
 * meaningful pre-flight.                                             *
 * ------------------------------------------------------------------ */

export type RedeliveryClass =
  | { readonly class: "new-attempt" } // NDR-r: new act, never duplicate-refused
  | { readonly class: "refiled" } // NDR-r case (b): identical bytes
  | { readonly class: "replay-integrity-refusal" }; // NDR-r case (c)

export function classifyRedelivery<T extends { id: string }>(
  existingLine: string | undefined,
  incoming: T,
): RedeliveryClass {
  if (existingLine === undefined) return { class: "new-attempt" };
  return existingLine === JSON.stringify(incoming)
    ? { class: "refiled" }
    : { class: "replay-integrity-refusal" };
}
