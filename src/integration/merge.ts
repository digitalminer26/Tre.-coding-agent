/**
 * P12 — Tested candidate integration (docs/16; docs/11 §5 merge-action
 * contract, §14.3 decision + acceptance records, Q5/R2/R3).
 *
 * Contract (docs/16):
 *   `integrateTestedCandidate(req, ports): Promise<IntegrationResult>` —
 *     integrates ONE task branch (`agent/<episodeId>/<taskId>`, derived —
 *     never caller-named) into an episode branch by the §5 contract:
 *     construct the candidate merge commit in the object store
 *     (`merge-tree --write-tree`, working tree untouched), run the
 *     trusted gate against the EXACT candidate SHA, advance the episode
 *     branch by three-argument `update-ref` CAS, and record acceptance
 *     {candidate, parents, gate id+result}. NEVER rejects.
 *
 * Invariants (docs/16 §0):
 *   M1 conflicts never resolved — any conflicted tree aborts BEFORE a
 *      commit object exists, before the gate, before any journal write.
 *      No strategy options, no `-X`, no rerere, v1.
 *   M2 the gate binds to the artifact — the gate port MUST return the
 *      sha it tested; sha mismatch (or an unreadable claim) is
 *      `gate-sha-mismatch`, never "tests looked green".
 *   M3 CAS is the only advance — the 3-arg update-ref; no code path
 *      advances a ref without the old-value operand. Head moved →
 *      `head-moved`, recovery is a NEW intent, never a forced retry.
 *   M4 ref-direction guards — task branch derived; episode branch must
 *      pass `check-ref-format`, stay out of `agent/**`, and never be
 *      `main` (episode→main promotion is human by default, Q5).
 *   M5 durable, observed-reality-only recovery — everything before the
 *      CAS is observation (journals nothing); the intent (carrying the
 *      candidate in `expectedEvidence`) lands immediately before the
 *      CAS, the outcome after. An open intent closes ONLY by proving
 *      the branch head descends from the recorded candidate (I2/I5).
 *      `no-effect:` is written only when nothing-happened is PROVABLE
 *      (docs/15 §4 step 7 invariant, carried over verbatim).
 *   M6 never throws — the whole body (including every property read of
 *      hostile input) runs inside one fence (docs/15 E5 pattern).
 *
 * Self-containment: imports only `node:` builtins (the P6 pattern). The
 * journal and gate arrive as injected ports (structural mirrors of P4 /
 * docs/12 §4).
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

// ─── git plumbing (P6 discipline: fixed argv, bounded, documented negatives) ─

const GIT_TIMEOUT_MS = 60_000;
// Cycle-2 audit F9: bound the gate port call. Operators may raise it via
// TRE_P12_GATE_TIMEOUT_MS (read per-call so tests exercise it without a
// module reload); values are clamped to [1s, 1h].
function gateTimeoutMs(): number {
  // Cycle-3 audit C3-F6: unset/invalid -> default; ANY valid positive value
  // CLAMPS into [1s, 1h] (the documented contract) — previously 1..999
  // silently fell back to the 10-minute default instead of the 1s floor.
  const raw = Number(process.env.TRE_P12_GATE_TIMEOUT_MS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return 600_000;
  return Math.min(Math.max(Math.round(raw), 1_000), 3_600_000);
}
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

// Cycle-2 audit F2: a caller-inherited GIT_DIR / GIT_WORK_TREE / ... would
// OVERRIDE `cwd` and silently retarget every command (including the CAS) at
// another repository. Strip every location-redirecting git env var and pin
// output parsing to C locale (probeExit0 matches English stderr).
// BUILT PER CALL: process.env is read at exec time, not module-load, so a
// test (or operator) that swaps PATH after import still sees it honored —
// the deletion list applies to the CURRENT environment each time.
// Cycle-3 audit C3-F3 extends the list: CONFIG redirectors (an inherited
// GIT_CONFIG_COUNT/KEY_n/VALUE_n can inject core.worktree — defeating the
// --show-toplevel identity pin — or core.hooksPath to run code during
// update-ref), the global/system config files, HOME (git reads
// $HOME/.gitconfig when GIT_CONFIG_GLOBAL is unset), the mktag/mkhash
// object-dir redirectors (GIT_OBJECT_DIRECTORY is stripped, but
// GIT_QUARANTINE_PATH / GIT_ALTERNATE_* also affect object resolution for
// merge-tree/merge-base), template dir, and GIT_REPLACE_REF_BASE (replays
// refs under a different base for rev parsing).
const GIT_ENV_STRIP = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_NAMESPACE",
  "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG",
  "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_SHELL", "GIT_SSH", "GIT_SSH_COMMAND",
  "GIT_EDITOR", "GIT_PAGER", "PAGER", "HOME", "XDG_CONFIG_HOME",
  "GIT_QUARANTINE_PATH", "GIT_TEMPLATE_DIR", "GIT_REPLACE_REF_BASE", "GIT_DIR_LINKS"];
// Pinned-empty config: strip alone still lets git read the INVOKING user's
// $HOME/.gitconfig / /etc/gitconfig (which can carry core.hooksPath,
// core.worktree-like aliases, fetch refspecs...). Point both config slots
// at /dev/null (git accepts an empty config file; verified on git 2.54)
// so EVERY call runs with a known-minimal config regardless of the host.
// Repo-LOCAL .git/config stays authoritative (it defines the very repo
// being operated on; trusting the repo's own config is the deployment
// trust boundary — docs/16 §9 C3-F3).
function gitEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  for (const k of GIT_ENV_STRIP) delete e[k];
  // Re-apply AFTER the strip: GIT_CONFIG_GLOBAL/SYSTEM are in the strip
  // list (an inherited one must not win), but here they are the PIN, set
  // post-delete so they survive it.
  e.GIT_CONFIG_GLOBAL = "/dev/null";
  e.GIT_CONFIG_SYSTEM = "/dev/null";
  return e;
}

type GitFail = Error & { code?: number | string; stderr?: string; stdout?: string };

function execCapture(cwd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: gitEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) {
          // The callback error does NOT reliably carry .stdout/.stderr —
          // attach them explicitly (the conflict payload and the
          // documented-negative stderr probes depend on both).
          const e = err as GitFail;
          e.stdout = stdout;
          e.stderr = stderr;
          reject(e);
          return;
        }
        resolve({ stdout });
      });
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execCapture(cwd, args);
  return stdout;
}

/** exit-0 probe: success → true, documented negatives (exit 1/128 ref/rev
 *  wording) → false, anything else throws. `rev-parse --verify --quiet`
 *  and `check-ref-format` answer with exit 1; a broken repo / permission
 *  failure / timeout is a HARD error, never collapsed (P6 audit F4). */
async function probeExit0(cwd: string, args: string[]): Promise<boolean> {
  try {
    // execCapture (NOT a bare awaited execFile — the callback API returns a
    // ChildProcess, not a Promise, and awaiting it resolves immediately
    // whatever the exit code).
    await execCapture(cwd, args);
    return true;
  } catch (err) {
    const e = err as GitFail;
    if (e.code === 1) return false;
    if (typeof e.code === "number" && e.code !== 0
      // git capitalizes its messages ("Not a valid commit name") — case-insensitive.
      && /not a git repository|must be run in a work tree|does not appear to be a git repository|unknown revision|ambiguous argument|not a valid commit name|not a valid object name/i.test(e.stderr ?? "")) {
      return false;
    }
    throw err;
  }
}

// ─── Validation tables (mirrors of the P11 executor — drift-pinned by test) ─

// Known limitation (audit C1 F5): SAFE_ID admits uppercase, and on a
// case-INSENSITIVE filesystem (macOS/Windows default) `ep1` and `EP1` are
// ONE physical ref while actionId (raw case) treats them as distinct
// identities. Verified probes: git refuses to create both branches
// ("a branch named ... already exists"), and `for-each-ref refs/heads/mix/t1`
// matches case-sensitively while `rev-parse` resolves either spelling.
// Disposition: documented, not normalized — actionId identity is the
// caller's exact string (mirrors P11), case-folding it would silently
// merge two supervisor identities; deployment note: host episode branches
// case-exactly on case-insensitive filesystems.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/; // 40 (sha1) or 64 (sha256) hex
// (A previous draft `(0|[1-9a-f](?:…))` silently rejected every hex string
//  starting with '0' — ~1/16 of real git SHAs. Pinned by test.)
const MAX_STR = 512;
const MAX_PATHS = 64;

/** The §5 task branch name — DERIVED, never caller-supplied (§0 M4).
 *  Mirrors P6 `taskBranchName` (leaf copy, compartment rule). */
export function taskBranchName(episodeId: string, taskId: string): string {
  return `agent/${episodeId}/${taskId}`;
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function own(o: Record<string, unknown>, key: string): unknown {
  // Cycle-3 audit C3-F2: the old try/catch swallowed a THROWING GETTER and
  // returned undefined — a hostile/buggy request with an `expectedTaskTip`
  // accessor that threw silently DROPPED the caller's reviewed-tip pin
  // (fail-OPEN: the merge proceeded against an unreviewed tip). Property
  // DESCRIPTORS never invoke a getter we cannot see coming: absent ->
  // undefined (no throw possible), data property -> value (no throw
  // possible), accessor -> invoke it and let any throw ESCAPE to the M6
  // fence (fail-closed: refused fence:context, nothing journaled).
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (d === undefined) return undefined;
  if ("value" in d) return d.value;
  return d.get ? d.get.call(o) : undefined;
}
function isStr(v: unknown, max = MAX_STR): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}
function isSha(v: unknown): v is string {
  return typeof v === "string" && SHA.test(v);
}

/** FNV-1a (mirror of the executor, docs/15 §4) — actionId digest only. */
// Cycle-2 audit F5: the actionId is the ONLY durable dedup key — a 32-bit
// digest collides by birthday at ~65k identities, and a collision makes one
// identity's acked outcome refuse another's execution (or close its intent
// falsely). sha256 (node:crypto, still a node: builtin) truncated to 128
// bits keeps the id readable and the collision space astronomical.
function idDigest(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

function describeError(e: unknown): { name: string; message: string } {
  if (e instanceof Error) {
    try { return { name: String(e.name), message: String(e.message).slice(0, MAX_STR) }; } catch { /* fall through */ }
  }
  return { name: "unknown", message: "non-Error thrown" };
}

// ─── Public surface ─────────────────────────────────────────────────────────

export interface IntegrationJournalPort {
  append(record: object): Promise<void>;
  read(): Promise<{ records: readonly unknown[] }>;
}

export interface GateRunRequest {
  candidateSha: string;
  episodeBranch: string;
  episodeId: string;
  taskId: string;
  actionId: string;
}

export interface GateRunResult {
  /** the gate's verdict for THIS candidate only. */
  pass: boolean;
  /** stable id for the acceptance record ("gate:<runId>"). */
  runId: string;
  /** REQUIRED: the exact SHA the gate actually tested (M2). */
  sha: string;
  detail?: string;
}

export interface IntegrationGatePort {
  run(req: GateRunRequest): Promise<GateRunResult>;
}

export interface IntegrationPorts {
  journal: IntegrationJournalPort;
  gate: IntegrationGatePort;
}

export interface IntegrationRequest {
  repoRoot: string;
  episodeId: string;
  taskId: string;
  /** refs/heads/<name>: legal ref, NOT in agent/**, NOT "main" (M4). */
  episodeBranch: string;
  /** optional pin: the task tip this integration was planned against. */
  expectedTaskTip?: string;
  now: number;
  executionSeq?: number;
  grantedBy: string;
}

export type IntegrationStage =
  | "context" | "dedup" | "resolve" | "construct" | "gate" | "reverify"
  | "intent" | "advance" | "verify" | "outcome";

export type IntegrationStatus =
  | "merged" | "already-merged" | "recovered"
  | "conflict" | "gate-failed" | "refused" | "failed";

export interface IntegrationResult {
  actionId: string;
  status: IntegrationStatus;
  stage: IntegrationStage;
  candidateSha?: string;
  episodeHead?: string;
  taskTip?: string;
  gateRunId?: string;
  /** populated on refused / conflict / gate-failed / failed. */
  reason?: string;
  evidenceRefs: string[];
  /** false when the advance landed but its outcome/acceptance record was lost (docs/15 E6). */
  outcomeDurable: boolean;
}

const SCHEMA_ID = "tre-supervisor/1";

// Journal record shapes (mirror of the P4 §14.3 record schema — the real
// DecisionJournal validates before write; these satisfy it).
interface IntentRecord {
  schema: string; id: string; ts: number; episodeId: string; taskId: string;
  kind: "decision-intent"; actionId: string; rung: 4; action: "merge";
  expectedEvidence: string;
  authority: { grantedBy: string; sideEffect: "external" };
  rationale: string;
}
interface OutcomeRecord {
  schema: string; id: string; ts: number; episodeId: string; taskId: string;
  kind: "decision-outcome"; actionId: string; acked: boolean; progress: "none";
  evidenceRefs?: string[]; notes?: string;
}
interface AcceptanceRecord {
  schema: string; id: string; ts: number; episodeId: string; taskId: string;
  kind: "acceptance"; verdict: "complete";
  criteria: { id: string; pass: true; evidenceRef: string; checkedAtSha: string }[];
  artifact: { sha: string };
}

/** Refusal factory — journals nothing (§2 step 1/2/3/4/5/6 refusals all
 *  happen before the intent exists). */
function refused(stage: IntegrationStage, reason: string, actionId = "", extra: Partial<IntegrationResult> = {}): IntegrationResult {
  return { actionId, status: "refused", stage, reason, evidenceRefs: [], outcomeDurable: true, ...extra };
}

// ─── The one call ───────────────────────────────────────────────────────────

// Cycle-3 audit C3-F1: in-process in-flight lock. Two concurrent
// integrateTestedCandidate calls with an IDENTICAL actionId (duplicate
// dispatch in the same supervisor) must not both race through the
// journal-dedup window (read → append is not atomic) and double-execute.
// The journal sticky-terminal scan closes the durable window; this Set
// closes the in-memory one. Released in the finally block below.
const inFlight = new Set<string>();

export async function integrateTestedCandidate(
  req: unknown,
  ports: IntegrationPorts,
): Promise<IntegrationResult> {
  // Cycle-3 audit C3-F1: the in-flight reservation is released HERE —
  // every return/throw path of the body funnels through this finally, so
  // a refused or fenced execution never leaks its lock (a leaked entry
  // would poison the identity for the life of the process).
  const held: { id?: string } = {};
  try {
    return await runMergeOnce(req, ports, held);
  } finally {
    if (held.id !== undefined) inFlight.delete(held.id);
  }
}

async function runMergeOnce(
  req: unknown,
  ports: IntegrationPorts,
  held: { id?: string }, // out-param: the actionId this call reserved (if any)
): Promise<IntegrationResult> {
  let stage: IntegrationStage = "context";
  let actionId = "";
  let now = 0;
  let outcomeSuffix = ""; // hoisted for the M6 fence (id parity with normal outcomes)
  let snap: { repoRoot: string; episodeId: string; taskId: string; episodeBranch: string; expectedTaskTip?: string; grantedBy: string; seq: number } | undefined;
  try {
    // ── 0. context — hostile snapshot, fail-closed (docs/16 §2 step 1) ───
    if (!isPlainObj(req)) return refused("context", "context:shape");
    const r = req as Record<string, unknown>;
    const repoRoot = own(r, "repoRoot");
    const episodeId = own(r, "episodeId");
    const taskId = own(r, "taskId");
    const episodeBranch = own(r, "episodeBranch");
    const nowRaw = own(r, "now");
    // Cycle-4 audit F5: `startsWith("/")` made the pathEq win32 case-fold
    // branch below UNREACHABLE (a win32 absolute path like `C:\\x\\repo`
    // was refused as context:repoRoot before the case-fold ever ran) — the
    // claimed Windows support was dead code. node:path isAbsolute is
    // platform-aware (POSIX: leading "/"; win32: drive letters and UNC),
    // so the identity pin below actually runs on every supported platform.
    if (!isStr(repoRoot) || !isAbsolute(repoRoot)) return refused("context", "context:repoRoot");
    if (typeof episodeId !== "string" || !SAFE_ID.test(episodeId) || episodeId === "." || episodeId === "..") return refused("context", "context:episodeId");
    if (typeof taskId !== "string" || !SAFE_ID.test(taskId) || taskId === "." || taskId === "..") return refused("context", "context:taskId");
    if (typeof episodeBranch !== "string" || !SAFE_ID.test(episodeBranch) || episodeBranch === "." || episodeBranch === "..") return refused("context", "context:episodeBranch");
    if (typeof nowRaw !== "number" || !Number.isFinite(nowRaw) || nowRaw < 0) return refused("context", "context:now");
    now = nowRaw;
    const seqRaw = own(r, "executionSeq");
    if (seqRaw !== undefined && (!Number.isInteger(seqRaw) || (seqRaw as number) < 0)) return refused("context", "context:executionSeq");
    const grantedBy = own(r, "grantedBy");
    if (!isStr(grantedBy)) return refused("context", "context:grantedBy");
    const expectedTaskTipRaw = own(r, "expectedTaskTip");
    if (expectedTaskTipRaw !== undefined && !isSha(expectedTaskTipRaw)) return refused("context", "context:expectedTaskTip");
    if (!isPlainObj(ports) || !isPlainObj(ports.journal) || typeof ports.journal?.append !== "function" || typeof ports.journal?.read !== "function") {
      return refused("context", "context:journal-port");
    }
    if (!isPlainObj(ports.gate) || typeof ports.gate?.run !== "function") {
      return refused("context", "context:gate-port");
    }
    snap = { repoRoot, episodeId, taskId, episodeBranch, grantedBy, seq: (seqRaw ?? 0) as number,
      ...(expectedTaskTipRaw !== undefined ? { expectedTaskTip: (expectedTaskTipRaw as string).toLowerCase() } : {}) };

    // M4 ref-direction guards, before ANY git call:
    // - the literal "main" is never an integration target (Q5 promotion is
    //   human by default). Case-INSENSITIVELY (cycle-2 audit F1, probed on
    //   macOS APFS: `update-ref refs/heads/MAIN` REWRITES refs/heads/main
    //   — a case-sensitive-only compare handed the guard bypass; the F5
    //   note's "identities stay distinct" reasoning does NOT apply to the
    //   main-governance invariant, so this ONE name is case-folded).
    // - the task branch is DERIVED — a caller cannot name it;
    // - SAFE_ID excludes "/" so a caller-named episode branch can never
    //   enter `agent/**`; "agent" itself would D/F-conflict the namespace.
    // - NOT checked (cycle-2 audit F3): whether episodeBranch is checked
    //   out in a linked worktree. The CAS moves the ref but no worktree
    //   syncs; that checkout shows the merged files as *reverted* until
    //   someone runs `git pull --ff-only` there. Auto-syncing a foreign
    //   worktree is out of authority — operator note: the episode
    //   integration flow keeps the episode branch unchecked-out (the
    //   supervisor's own checkout stays on a neutral branch, tests too).
    if (snap.episodeBranch.toLowerCase() === "main") return refused("context", "context:episodeBranch-main");
    if (snap.episodeBranch === "agent") return refused("context", "context:episodeBranch-agent-namespace");
    const taskBranch = taskBranchName(snap.episodeId, snap.taskId);
    // Cycle-3 audit C3-F5: the dedup identity hashed the RAW repoRoot, so
    // `/x/repo`, `/x/repo/`, and a symlink spelling of the SAME repository
    // produced DIFFERENT actionIds — an acked or act-unknown outcome under
    // one spelling was invisible under another (already-executed and
    // not-replayable guards bypassed, open intent ignored). The identity
    // git operates on IS the realpath (the resolve-stage probe verifies
    // it), so digest the realpath when obtainable. A realpath failure
    // (ENOENT/ELOOP/…) falls back to the raw string MINUS trailing slashes
    // — that request is refused at resolve (context:repoRoot-not-a-repo)
    // before anything is journaled, so the fallback id never becomes
    // durable for an existing repo under a second spelling.
    let canonicalRoot = repoRoot.replace(/\/+$/, "") || "/";
    try { canonicalRoot = realpathSync(repoRoot); } catch { /* resolve stage classifies */ }
    actionId = `a-${snap.taskId}-merge-${idDigest(canonical({
      repoRoot: canonicalRoot, episodeId: snap.episodeId, taskId: snap.taskId,
      episodeBranch: snap.episodeBranch, seq: snap.seq,
    }))}`;
    // Cycle-3 audit C3-F1 (second half): IN-PROCESS in-flight lock. Two
    // concurrent calls for one identity in THIS process both read the
    // journal before either appends — the journal-side rules cannot see
    // that race. The second caller is refused `dedup:in-flight` (the
    // outcome of the running execution is unknown to it; re-ask after
    // it returns). Cross-process races remain journal-ordered and are
    // handled by the sticky-terminal rule below; a true cross-process
    // append-race needs journal-side CAS (documented residual, docs/16 §9).
    if (inFlight.has(actionId)) return refused("dedup", "in-flight", actionId);
    inFlight.add(actionId);
    held.id = actionId;
    const journal = ports.journal;

    // ── 1. dedup (§14.3 I2; docs/16 §2 step 2) ───────────────────────────
    stage = "dedup";
    let records: readonly unknown[];
    try {
      const rr = await journal.read();
      if (!isPlainObj(rr) || !Array.isArray(rr.records)) return refused("dedup", "journal-unreadable", actionId);
      records = rr.records;
      for (const raw of records) {
        if (!isPlainObj(raw)) return refused("dedup", "journal-unreadable", actionId);
      }
    } catch {
      return refused("dedup", "journal-unreadable", actionId);
    }
    // Cycle-3 audit C3-F1: the scan is STICKY-TERMINAL, not last-wins.
    // The old loop let a LATER record clear an earlier acked outcome
    // (`done=false` on a no-effect/ intent), so two racing executions —
    // A acks, B (CAS loser) appends "no-effect: head-moved" under the
    // SAME identity — ended with the identity looking replayable: a
    // reissue after the task branch moved merged a NEW tip under an
    // identity the supervisor had already acknowledged. Terminal facts
    // are monotonic: an acked outcome (already-executed) and an
    // act-unknown outcome (not-replayable) are NEVER unset by any later
    // record; only the open/closed intent cursor follows record order.
    let open = false, ackedSeen = false, unknownSeen = false, nIntent = 0, nOutcome = 0;
    let openCandidate = "";
    try {
      for (const raw of records) {
        if (!isPlainObj(raw)) continue;
        if ((raw as Record<string, unknown>).actionId !== actionId) continue;
        const kind = (raw as Record<string, unknown>).kind;
        if (kind === "decision-intent") { open = true; nIntent++;
          const ev = (raw as Record<string, unknown>).expectedEvidence;
          openCandidate = typeof ev === "string" && ev.startsWith("candidate:") ? ev.slice("candidate:".length).toLowerCase() : "";
        } else if (kind === "decision-outcome") {
          open = false; nOutcome++;
          const acked = (raw as Record<string, unknown>).acked === true;
          const notes = (raw as Record<string, unknown>).notes;
          if (acked) ackedSeen = true;                                    // sticky: already-executed
          else if (typeof notes !== "string" || !notes.startsWith("no-effect:")) unknownSeen = true; // sticky: not-replayable
          // no-effect outcomes set nothing sticky: provable no-effect →
          // replayable (subject to the sticky terminals above).
        }
      }
    } catch {
      return refused("dedup", "journal-unreadable", actionId);
    }
    // Cycle-4 audit F1: the sticky TERMINALS used to return here, BEFORE
    // the open-intent recovery block — so the interleaving intent →
    // acked-outcome → LATE intent (a writer that appended its intent but
    // died before the outcome; §2 step 2 says the tail intent is closed
    // ONLY by observed reality) was unclosable forever: `done` short-
    // circuited the recovery probe. Terminals are STILL sticky for
    // replay, but the recovery branch below performs NO side effect
    // unless observed reality proves the closure — running it against an
    // open tail intent can only journal a truthful recovered outcome,
    // never re-execute — so when the TAIL is an open intent, fall
    // through: recovery first, terminals after (intent-tail discipline
    // outranks terminal-replay discipline).
    const done = ackedSeen;
    const notReplayable = !ackedSeen && unknownSeen;
    if (!open) {
      if (done) return refused("dedup", "already-executed", actionId);
      if (notReplayable) return refused("dedup", "not-replayable", actionId);
    }
    // Replay suffixes by per-actionId counts (distinct journal ids; the
    // real DecisionJournal's duplicate-id reporting stays advisory).
    const intentSuffix = nIntent === 0 ? `${snap.seq}` : `${snap.seq}r${nIntent}`;
    outcomeSuffix = nOutcome === 0 ? `${snap.seq}` : `${snap.seq}r${nOutcome}`;

    // Helper: append an outcome (best-effort on the failure paths).
    const appendOutcome = async (rec: Omit<OutcomeRecord, "schema" | "kind">): Promise<boolean> => {
      const full: OutcomeRecord = { schema: SCHEMA_ID, kind: "decision-outcome", ...rec };
      Object.freeze(full.evidenceRefs ?? (full as { evidenceRefs?: string[] }).evidenceRefs);
      Object.freeze(full);
      try { await journal.append(full); return true; } catch { return false; }
    };

    // ── 2. resolve (§2 step 3) ───────────────────────────────────────────
    stage = "resolve";
    const repo = snap.repoRoot;
    // Repo probe FIRST: a non-repo is `context:repoRoot` — documented
    // negative only (a broken repo / permission error stays a hard error).
    // Cycle-2 audit F8: a nonexistent repoRoot spawns as ENOENT with
    // path "git" (probed on this platform — the spawn error is
    // indistinguishable from a missing binary), so classify BEFORE
    // spawning: ENOENT/ENOTDIR from realpath is the documented negative
    // (nothing happened — the operator must not be told the outcome is
    // unknown). EACCES/ELOOP etc. rethrow: an unreadable path is an
    // environment failure, not a bad request.
    try {
      realpathSync(repo);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return refused("context", "context:repoRoot-not-a-repo", actionId);
      }
      throw e;
    }
    if (!(await probeExit0(repo, ["rev-parse", "--git-dir"]))) {
      return refused("context", "context:repoRoot-not-a-repo", actionId);
    }
    // Cycle-2 audit F2: pin the repository IDENTITY. `cwd` alone does not
    // pin it (an inherited GIT_DIR overrides cwd — now stripped, see
    // GIT_ENV), and a repoRoot nested INSIDE another repo would silently
    // target the outer one. The toplevel git reports must be exactly the
    // named repoRoot (git resolves symlinks; compare via realpath).
    let toplevel = "";
    try {
      toplevel = (await git(repo, ["rev-parse", "--show-toplevel"])).trim();
    } catch (e) {
      // Cycle-4 audit F3: `--show-toplevel` fails (exit 128) BOTH outside
      // any repo AND inside a BARE repo ("fatal: this operation must be
      // run in a work tree" — probed). Bare-ness is a legitimate repo
      // shape, so the two cases must not collapse into one reason (the
      // P6-F4 rule: documented negatives stay distinguishable). Probe
      // `--is-bare-repository`: exit 0 + "true" anywhere inside a repo
      // (bare or not), non-zero outside one. A merge needs a work tree
      // (no work-tree execution here), so a bare root refuses with its
      // OWN reason rather than masquerading as "not a git repo".
      const msg = (e as GitFail)?.stderr ?? "";
      const maybeBare = typeof (e as GitFail)?.code === "number"
        && /must be run in a work tree/i.test(msg);
      if (maybeBare) {
        let bare = false;
        try { bare = ((await git(repo, ["rev-parse", "--is-bare-repository"])).trim() === "true"); } catch { bare = false; }
        if (bare) return refused("context", "context:repoRoot-bare", actionId);
      }
      return refused("context", "context:repoRoot-not-a-repo", actionId);
    }
    // Cycle-3 audit C3-F9: on case-INSENSITIVE filesystems (APFS case-
    // insensitive — the macOS default — and Windows) the same directory
    // has several legal spellings and git may report the toplevel with a
    // different case than the caller spelled `repo`. A byte-exact compare
    // would fence every legitimate merge on those platforms, so compare
    // case-folded there (POSIX stays byte-exact).
    const pathEq = process.platform === "darwin" || process.platform === "win32"
      ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      : (a: string, b: string) => a === b;
    if (!pathEq(toplevel, realpathSync(repo))) {
      return refused("context", "context:repoRoot-outer-repo", actionId);
    }
    // Ref legality (git is the authority; a same-named tag can never
    // shadow these operands — everything is refs/heads/-qualified).
    if (!(await probeExit0(repo, ["check-ref-format", `refs/heads/${snap.episodeBranch}`]))) {
      return refused("resolve", "resolve:episodeBranch-illegal", actionId);
    }
    if (!(await probeExit0(repo, ["check-ref-format", `refs/heads/${taskBranch}`]))) {
      return refused("resolve", "resolve:taskBranch-illegal", actionId);
    }
    const resolveSha = async (branch: string): Promise<string> => {
      // `--verify --quiet` answers exit 1 for a missing ref (documented
      // negative → ""). Anything else (timeout, EPERM, corrupt repo) is a
      // HARD error (P6-F4 — the probeExit0 rule): it throws to the fence
      // instead of being collapsed into "branch missing", so the operator
      // is never told to go create a branch that exists.
      let out: string;
      try {
        out = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
      } catch (e) {
        if ((e as GitFail)?.code === 1) return "";
        throw e;
      }
      const sha = out.trim().toLowerCase();
      return isSha(sha) ? sha : "";
    };
    const episodeHead = await resolveSha(snap.episodeBranch);
    if (episodeHead === "") return refused("resolve", "resolve:episodeBranch-missing", actionId);
    const taskTip = await resolveSha(taskBranch);
    if (taskTip === "") return refused("resolve", `resolve:taskBranch-missing:${taskBranch}`, actionId);
    // Caller pin FIRST (docs/16 §2 step 3): a violated expectation is a
    // refusal even when the graph would answer already-merged.
    if (snap.expectedTaskTip !== undefined && snap.expectedTaskTip !== taskTip) {
      return refused("resolve", "resolve:expectedTaskTip-mismatch", actionId, { episodeHead, taskTip });
    }
    if (episodeHead === taskTip && !open) {
      return { actionId, status: "already-merged", stage: "resolve", episodeHead, taskTip,
        evidenceRefs: [`equal:head:${episodeHead}`], outcomeDurable: true };
    }
    const ancestor = await probeExit0(repo, ["merge-base", "--is-ancestor", taskTip, episodeHead]);

    // Open intent? Close it ONLY with observed reality (§2 step 2) — and
    // BEFORE the already-merged shortcut: a landed merge makes taskTip an
    // ancestor of head, so the shortcut would answer `already-merged` and
    // strand the intent forever. The recovery probe (candidate descends
    // from → ancestor of head) is the strictly stronger statement.
    if (open) {
      if (isSha(openCandidate) && openCandidate !== episodeHead) {
        const descended = await probeExit0(repo, ["merge-base", "--is-ancestor", openCandidate, episodeHead]);
        if (descended) {
          const ok = await appendOutcome({
            id: `${actionId}#o${outcomeSuffix}`, ts: now, episodeId: snap.episodeId, taskId: snap.taskId,
            actionId, acked: true, progress: "none",
            evidenceRefs: [`candidate:${openCandidate}`, "close:observed-descendant", `head:${episodeHead}`],
            notes: "recovered: observed head descends from candidate",
          });
          return { actionId, status: "recovered", stage: "outcome", candidateSha: openCandidate, episodeHead, taskTip,
            evidenceRefs: [`candidate:${openCandidate}`, "close:observed-descendant"], outcomeDurable: ok };
        }
      }
      if (isSha(openCandidate) && openCandidate === episodeHead) {
        // The candidate IS the current head — the advance landed and this
        // very execution's CAS (or an earlier one of ours) is the only
        // plausible writer. Close as recovered with the same evidence.
        const ok = await appendOutcome({
          id: `${actionId}#o${outcomeSuffix}`, ts: now, episodeId: snap.episodeId, taskId: snap.taskId,
          actionId, acked: true, progress: "none",
          evidenceRefs: [`candidate:${openCandidate}`, "close:head-equals-candidate", `head:${episodeHead}`],
          notes: "recovered: head equals recorded candidate",
        });
        return { actionId, status: "recovered", stage: "outcome", candidateSha: openCandidate, episodeHead, taskTip,
          evidenceRefs: [`candidate:${openCandidate}`, "close:head-equals-candidate"], outcomeDurable: ok };
      }
      if (episodeHead === taskTip || ancestor) {
        // Task work is contained AND the open candidate did not produce
        // this state (head === taskTip counts: task tip is its own
        // ancestor): some OTHER integration landed it. Close our intent
        // with that observation (acked, evidence = the containment fact).
        const ok = await appendOutcome({
          id: `${actionId}#o${outcomeSuffix}`, ts: now, episodeId: snap.episodeId, taskId: snap.taskId,
          actionId, acked: true, progress: "none",
          evidenceRefs: [`ancestor:task-tip:${taskTip}`, "close:contained-by-other", `head:${episodeHead}`],
          notes: "recovered: task tip contained by head (not via recorded candidate)",
        });
        return { actionId, status: "recovered", stage: "outcome", candidateSha: isSha(openCandidate) ? openCandidate : undefined,
          episodeHead, taskTip, evidenceRefs: ["close:contained-by-other"], outcomeDurable: ok };
      }
      return refused("dedup", openCandidate === "" ? "intent-open:candidate-unreadable" : "intent-open", actionId, { episodeHead, taskTip });
    }
    if (ancestor) {
      // Task work is already contained in the episode branch: the fact is
      // re-derivable from the graph; no journal write (§2 step 3).
      return { actionId, status: "already-merged", stage: "resolve", episodeHead, taskTip,
        evidenceRefs: [`ancestor:task-tip:${taskTip}`], outcomeDurable: true };
    }

    // ── 3. construct (§2 step 4) — object store only, working tree untouched
    stage = "construct";
    let candidateSha = "";
    let conflictedPaths: string[] = [];
    try {
      const out = await execFileCapture(repo, ["-c", "user.name=tre-supervisor", "-c", "user.email=tre@localhost",
        "merge-tree", "--write-tree", "--name-only", `refs/heads/${snap.episodeBranch}`, `refs/heads/${taskBranch}`]);
      candidateSha = out.trim().split("\n")[0]?.trim().toLowerCase() ?? "";
      if (!isSha(candidateSha)) {
        return { actionId, status: "failed", stage: "construct", reason: "git:merge-tree:output", episodeHead, taskTip, evidenceRefs: [], outcomeDurable: true };
      }
    } catch (e) {
      const err = e as GitFail;
      // A conflict ALWAYS carries the merged-tree OID as stdout line 1
      // (verified on git 2.54). exit 1 with empty stdout / a non-OID
      // first line is NOT a conflict — e.g. a ref deleted between
      // resolve and construct ("not something we can merge", audit C1
      // F1) — classify on the PAYLOAD, never the exit code alone.
      const body = (err.stdout ?? "").trim();
      if (err.code === 1 && isSha(body.split("\n")[0]?.trim().toLowerCase() ?? "")) {
        conflictedPaths = body.split("\n").slice(1)
          .map((l) => l.trim()).filter((l) => l !== "")
          .filter((l) => !/^(Auto-merging|CONFLICT)/.test(l))
          .slice(0, MAX_PATHS);
        return { actionId, status: "conflict", stage: "construct", reason: `conflict:paths:${conflictedPaths.join(",")}`.slice(0, MAX_STR * 4),
          candidateSha: undefined, episodeHead, taskTip, evidenceRefs: [`parents:${episodeHead},${taskTip}`], outcomeDurable: true };
      }
      return { actionId, status: "failed", stage: "construct", reason: `git:merge-tree:${describeError(e).name}`, episodeHead, taskTip, evidenceRefs: [], outcomeDurable: true };
    }
    // commit-tree the constructed tree with BOTH parents (episode first).
    try {
      const commitOut = await git(repo, ["-c", "user.name=tre-supervisor", "-c", "user.email=tre@localhost",
        "commit-tree", candidateSha, "-p", episodeHead, "-p", taskTip, "-m",
        `integrate ${snap.taskId} into ${snap.episodeBranch} [tre-p12]`]);
      candidateSha = commitOut.trim().toLowerCase();
      if (!isSha(candidateSha)) {
        return { actionId, status: "failed", stage: "construct", reason: "git:commit-tree:output", episodeHead, taskTip, evidenceRefs: [], outcomeDurable: true };
      }
    } catch (e) {
      return { actionId, status: "failed", stage: "construct", reason: `git:commit-tree:${describeError(e).name}`, episodeHead, taskTip, evidenceRefs: [], outcomeDurable: true };
    }

    // ── 4. gate (§2 step 5) — trusted, bound to the exact candidate (M2) ──
    stage = "gate";
    // Cycle-2 audit F9: "never throws" is not "always returns" — a hung
    // gate (stuck test runner) would hold the caller forever. Race the
    // port call against a deadline; timeout is gate-failed with no
    // journal write and no ref touched (same shape as gate-threw —
    // replayable with a new candidate identity). The racing promise is
    // abandoned, not cancelled: the gate adapter owns its subprocesses;
    // this module's contract is a bounded RETURN.
    let gateRes: GateRunResult;
    let gateTimer: ReturnType<typeof setTimeout> | undefined;
    // Cycle-3 audit C3-F7: the timeout was classified by regex-matching the
    // rejection MESSAGE — an adapter that itself throws an Error whose text
    // contains "gate-timeout" (a plausible retry-wrapper) was reported as
    // OUR deadline firing. Identity beats text: reject the race with a
    // private sentinel and compare by reference.
    const TIMEOUT_SENTINEL = Symbol("p12-gate-timeout");
    try {
      gateRes = await Promise.race([
        ports.gate.run({ candidateSha, episodeBranch: snap.episodeBranch, episodeId: snap.episodeId, taskId: snap.taskId, actionId }),
        new Promise<GateRunResult>((_, reject) => {
          gateTimer = setTimeout(() => reject(TIMEOUT_SENTINEL), gateTimeoutMs());
        }),
      ]);
    } catch (e) {
      // Gate threw: nothing happened (no ref write, and the gate is not
      // part of our durable intent yet) → no journal write; replayable.
      const timedOut = e === TIMEOUT_SENTINEL;
      const name = timedOut ? "Error" : describeError(e).name;
      return { actionId, status: "gate-failed", stage: "gate", reason: timedOut ? "gate-timeout" : `gate-threw:${name}`,
        candidateSha, episodeHead, taskTip, evidenceRefs: [`candidate:${candidateSha}`], outcomeDurable: true };
    } finally {
      if (gateTimer !== undefined) clearTimeout(gateTimer);
    }
    // Getter-guarded read (docs/15 R1-G1): the result is port-returned
    // data; a throwing getter becomes gate-failed, never an escape.
    let pass = false, runId = "", gateSha = "", detail = "";
    try {
      pass = (gateRes as GateRunResult)?.pass === true;
      const rid = (gateRes as GateRunResult)?.runId;
      const gsha = (gateRes as GateRunResult)?.sha;
      const det = (gateRes as GateRunResult)?.detail;
      runId = isStr(rid, MAX_STR) ? rid : "";
      gateSha = isStr(gsha) ? gsha.toLowerCase() : "";
      detail = isStr(det) ? det.slice(0, MAX_STR) : "";
    } catch {
      pass = false; runId = ""; gateSha = "";
    }
    if (!pass || runId === "") {
      return { actionId, status: "gate-failed", stage: "gate", reason: pass ? "gate-runid-invalid" : "gate-denied",
        candidateSha, episodeHead, taskTip, evidenceRefs: [`candidate:${candidateSha}`], outcomeDurable: true };
    }
    if (gateSha !== candidateSha) {
      return { actionId, status: "gate-failed", stage: "gate", reason: "gate-sha-mismatch",
        candidateSha, episodeHead, taskTip, gateRunId: runId, evidenceRefs: [`candidate:${candidateSha}`, `gate-claimed:${gateSha.slice(0, 64)}`], outcomeDurable: true };
    }

    // ── 5. re-verify (§2 step 6) — the tested tip is still the tip ───────
    stage = "reverify";
    const taskTipNow = await resolveSha(taskBranch);
    if (taskTipNow !== taskTip) {
      return refused("reverify", "task-tip-moved", actionId, { candidateSha, episodeHead, taskTip: taskTipNow });
    }

    // ── 6. intent BEFORE the CAS (§14.3 log-then-act, M5) ────────────────
    stage = "intent";
    const intent: IntentRecord = {
      schema: SCHEMA_ID, id: `${actionId}#i${intentSuffix}`, ts: now,
      episodeId: snap.episodeId, taskId: snap.taskId,
      kind: "decision-intent", actionId, rung: 4, action: "merge",
      expectedEvidence: `candidate:${candidateSha}`,
      authority: { grantedBy: snap.grantedBy, sideEffect: "external" },
      rationale: `integrate ${taskBranch} (tip ${taskTip}) into ${snap.episodeBranch}: candidate ${candidateSha} gate ${runId}${detail ? ` — ${detail}` : ""}`.slice(0, MAX_STR),
    };
    Object.freeze(intent.authority); Object.freeze(intent);
    try {
      await journal.append(intent);
    } catch (e) {
      // No intent, no advance (E2 log-then-act).
      return refused("intent", `intent-journal-failed:${describeError(e).name}`, actionId, { candidateSha, episodeHead, taskTip });
    }

    // ── 7. advance — the ONE ref write; three-argument CAS (M3) ──────────
    // Known limitation (audit C1 F4): if a previous update-ref was killed
    // mid-write (SIGTERM/timeout), a stale refs/heads/<ep>.lock strands
    // EVERY later CAS on this branch as advance-failed (git: "Unable to
    // create ... File exists." — probed). Each such call is CORRECTLY
    // refused with a provable no-effect outcome (the ref never moved), so
    // the journal stays truthful — but the branch is wedged until an
    // operator removes the stale lock. Auto-removing a lock file is a
    // destructive act outside this module's authority (it races a real
    // concurrent writer); operator runbook: verify no git process holds
    // it, then `rm .git/refs/heads/<ep>.lock` (or `git gc`).
    stage = "advance";
    let casCode = 0; // 0 = exited 0; non-zero = rejected/failed (ref NOT changed by this call)
    // Cycle-3 audit C3-F4: WHERE git FAILED matters. A numeric exit code is
    // git's own error path — the lockfile rename never ran (old-value check,
    // stale ref lock, bad argument), so "our call did not write" is
    // PROVABLE. A missing code (killed by signal / exec timeout) means the
    // process died without reporting: it may have died AFTER the rename
    // landed. The old code collapsed every non-zero into "code 1" and
    // later claimed provable no-effect off the re-read alone — a killed
    // writer plus an unrelated later reset read as "nothing happened".
    let casRejectedClean = true; // exited 0 → never consulted; stays true only for a clean report
    try {
      await git(repo, ["update-ref", `refs/heads/${snap.episodeBranch}`, candidateSha, episodeHead]);
    } catch (e) {
      const code = (e as GitFail)?.code;
      casRejectedClean = typeof code === "number" && Number.isFinite(code) && code !== 0;
      casCode = casRejectedClean ? (code as number) : 1; // legacy reporting value for signal/timeout kills
    }
    // ── 8. verify (§2 step 8/9) — observed reality decides the outcome ───
    // Local `update-ref` is atomic (lockfile rename): a non-zero exit
    // means THIS call did not change the ref; the re-read then proves
    // nothing-happened. An exit-0 contradicted by the re-read (or a head
    // at a third value after a claimed success) is UNKNOWN — the write
    // may have landed and been moved again; never `no-effect:` (docs/15
    // §4 step 7).
    stage = "verify";
    const headNow = await resolveSha(snap.episodeBranch);
    if (headNow === candidateSha) {
      // Advanced — the observation is the authority, including the case
      // where update-ref exited non-zero AFTER the write landed (a
      // transport error after the rename: indistinguishable, and equal
      // MERGED — §2 step 9 "treat as advanced").
      stage = "outcome";
      const evidenceRefs = [`candidate:${candidateSha}`, `parent:episode:${episodeHead}`, `parent:task:${taskTip}`, `gate:${runId}`,
        casCode === 0 ? "advance:observed" : "advance:observed-despite-cas-error"];
      const outcomeOk = await appendOutcome({
        id: `${actionId}#o${outcomeSuffix}`, ts: now, episodeId: snap.episodeId, taskId: snap.taskId,
        actionId, acked: true, progress: "none", evidenceRefs,
        notes: `merged via CAS candidate ${candidateSha}`,
      });
      const acc: AcceptanceRecord = {
        schema: SCHEMA_ID, id: `${actionId}#acc${outcomeSuffix}`, ts: now, episodeId: snap.episodeId, taskId: snap.taskId,
        kind: "acceptance", verdict: "complete",
        criteria: [{ id: "trusted-gate", pass: true, evidenceRef: `gate:${runId}`, checkedAtSha: candidateSha }],
        artifact: { sha: candidateSha },
      };
      Object.freeze(acc.criteria); Object.freeze(acc.artifact); Object.freeze(acc);
      let accOk = true;
      try { await journal.append(acc); } catch { accOk = false; }
      return { actionId, status: "merged", stage: "outcome", candidateSha, episodeHead: headNow, taskTip, gateRunId: runId,
        evidenceRefs, outcomeDurable: outcomeOk && accOk };
    }
    if (casCode !== 0 && headNow !== candidateSha) {
      // Cycle-2 audit F4 + cycle-3 audit C3-F4: when is "nothing happened"
      // PROVABLE? Three escape hatches from the naive rule:
      //  (a) candidate is an ANCESTOR of headNow — a plausible history
      //      exists where our write landed and a later writer advanced
      //      from it (the C2-F4 state) → UNKNOWN.
      //  (b) headNow === "" — the ref is absent/unreadable. We cannot even
      //      observe a state our call did not produce: it may have landed
      //      into a ref a later actor then DELETED (docs table: "head
      //      unreadable → UNKNOWN, never no-effect") → UNKNOWN.
      //  (c) the CAS died WITHOUT reporting an exit code (signal kill /
      //      timeout): the kill may have come AFTER the rename landed.
      //      Cycle-4 audit F4 extends this to head sitting back at the
      //      OLD value: landed-then-reverted-to-old (an ABA) is exactly
      //      as consistent with a killed writer as head at a third value
      //      is — "head equals the old value" is NOT evidence nothing
      //      happened once the writer's death is unreported (a later
      //      `update-ref old` erases the trace). Any unreported CAS exit
      //      is act-unknown, whatever the re-read shows.
      // A CLEAN numeric rejection (git's own old-value/stale-lock report,
      // exit before the rename) with head observable at a value is the
      // only state where no-effect is provable.
      const landedThenMoved = headNow !== "" && headNow !== episodeHead
        && await probeExit0(repo, ["merge-base", "--is-ancestor", candidateSha, headNow]).catch(() => true);
      if (landedThenMoved || headNow === "" || !casRejectedClean) {
        await appendOutcome({
          id: `${actionId}#o${outcomeSuffix}`, ts: now, episodeId: snap.episodeId, taskId: snap.taskId,
          actionId, acked: false, progress: "none",
          evidenceRefs: [`head:${headNow === "" ? "unreadable" : headNow}`, `candidate:${candidateSha}`,
            landedThenMoved ? "close:candidate-ancestor-of-head" : headNow === "" ? "close:head-unreadable"
              : headNow === episodeHead ? "close:aba" : "close:cas-kill-unverifiable"],
          notes: "act-unknown: advance-unverified",
        });
        return { actionId, status: "failed", stage: "verify", reason: "advance-unverified",
          candidateSha, episodeHead: headNow, taskTip, gateRunId: runId,
          evidenceRefs: [`candidate:${candidateSha}`, headNow === "" ? "head:unreadable" : "ancestor:head-has-candidate"], outcomeDurable: false };
      }
      // Clean rejection (git reported the failure itself — the lockfile
      // rename never ran, so THIS call provably wrote nothing) AND the
      // re-read observed a real value: nothing-happened is PROVABLE
      // (docs/15 §4 step 7). Head still at the old value → advance-failed;
      // head at a third value → ANOTHER writer moved it (old-operand
      // rejected before the write).
      const moved = headNow !== episodeHead;
      const ok = await appendOutcome({
        id: `${actionId}#o${outcomeSuffix}`, ts: now, episodeId: snap.episodeId, taskId: snap.taskId,
        actionId, acked: false, progress: "none",
        evidenceRefs: [`head:${headNow === "" ? "unreadable" : headNow}`, `candidate:${candidateSha}`],
        notes: moved ? "no-effect: head-moved" : "no-effect: advance-failed",
      });
      return { actionId, status: "refused", stage: "advance",
        reason: moved ? "head-moved" : "advance-failed", candidateSha, episodeHead: headNow, taskTip, gateRunId: runId,
        evidenceRefs: [`head:${headNow === "" ? "unreadable" : headNow}`], outcomeDurable: ok };
    }
    // Exit-0 contradicted by the re-read, or head at a third value after
    // a CAS attempt whose exit was ambiguous: the outcome is UNKNOWN.
    // Never `no-effect:`. The best-effort act-unknown outcome below
    // CLOSES the §14.3 pair (intent + outcome); a re-issue of THIS
    // identity is then refused not-replayable (docs/16 §2 step 2 —
    // pinned). Recovery is a NEW identity (bumped executionSeq): its
    // resolve stage re-derives the truth from the graph — if the
    // candidate landed, already-merged answers without a journal write;
    // if it did not, the merge runs fresh. (Audit C1 F2: the old comment
    // promised same-identity observed-reality closure, which the dedup
    // rule deliberately makes unreachable.)
    await appendOutcome({
      id: `${actionId}#o${outcomeSuffix}`, ts: now, episodeId: snap.episodeId, taskId: snap.taskId,
      actionId, acked: false, progress: "none",
      evidenceRefs: [`head:${headNow === "" ? "unreadable" : headNow}`, `candidate:${candidateSha}`],
      notes: "act-unknown: advance-unverified",
    });
    return { actionId, status: "failed", stage: "verify", reason: "advance-unverified",
      candidateSha, episodeHead: headNow, taskTip, gateRunId: runId, evidenceRefs: [`candidate:${candidateSha}`],
      outcomeDurable: false }; // act landed-unknown: never claim durable-close
  } catch (e) {
    // M6 fence: escaped value / internal bug. An escape at/after the
    // intent stage leaves the intent open (observed reality closes it —
    // we never claim no-effect for a possible CAS); pre-intent escapes
    // journal nothing (nothing happened).
    const d = describeError(e);
    const preIntent = stage === "context" || stage === "dedup" || stage === "resolve" || stage === "construct" || stage === "gate" || stage === "reverify";
    if (!preIntent && snap !== undefined) {
      // intent landed but nothing past it is known — record act-unknown
      // best-effort (the intent stays open even if this append fails).
      // Id carries the SAME per-actionId suffix as every other outcome
      // (audit C1 F7): a second escape for one actionId must not collide
      // on the journal id.
      try {
        await ports.journal?.append({
          schema: SCHEMA_ID, kind: "decision-outcome", id: `${actionId}#o${outcomeSuffix}f`, ts: now,
          episodeId: snap.episodeId, taskId: snap.taskId, actionId, acked: false, progress: "none",
          notes: `act-unknown: fence-${stage}:${d.name}`,
        });
      } catch { /* best effort */ }
    }
    return { actionId, status: "failed", stage, reason: `fence:${stage}:${d.name}`, evidenceRefs: [], outcomeDurable: false };
  }
}

/** execFile that EXPOSES exit 1 + stdout (merge-tree's conflicted output
 *  is the payload; the plain `git()` helper collapses failure stdout —
 *  never here). */
async function execFileCapture(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execCapture(cwd, args);
  return stdout;
}
