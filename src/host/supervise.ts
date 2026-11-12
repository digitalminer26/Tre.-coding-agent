/**
 * M2+ — The thin host (docs/18 §0.1): the ONE place the pure composition
 * loop (src/supervisor/compose.ts) meets the real singletons. The loop
 * imports NOTHING; this module is its caller and owns timers/IO:
 *
 *   planner  → planRecovery            (P10, src/planner/plan.ts)
 *   executor → executeRecoveryAction   (P11, src/executor/exec.ts)
 *   gate     → BudgetLedger + check()  (P8, src/budget/ledger.ts)
 *   runner   → AttemptRunner           (P7, src/runner/attempt.ts)
 *   journal  → DecisionJournal         (P4, src/episode/journal.ts)
 *   steer    → FileSteeringQueue       (P3b, src/steer/file-queue.ts)
 *   accept   → evaluate                (P14, src/acceptance/evaluator.ts)
 *   investigate → investigate          (P15, src/investigation/agent.ts)
 *   escalate → makeEscalationChannel   (P13, src/escalation/channel.ts)
 *
 * Shape of the wiring (docs/18 §2, §5): the host builds the GatePolicy
 * from the episode graph, opens every durable singleton under the
 * episode dir, adapts each to the loop's duck-typed ports, and hands
 * them to runSupervisorEpisode. The host adds NO policy of its own:
 * every authority decision stays with the ledger (P8), the planner
 * (P10), and the executor's revalidation (P11).
 */

import { appendFile, link, mkdir, readdir, readFile, rename, lstat, open, readlink, stat, realpath, writeFile, unlink, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve, sep, basename, relative } from "node:path";

import {
  check as ledgerCheck,
  BudgetLedger,
  type GatePolicy,
  type GateRequest as LedgerGateRequest,
  type ActionReceipt,
} from "../budget/ledger.js";
import {
  createEpisodeLayout,
  episodeDir,
  readEpisodeGraph,
  readEpisodeState,
  writeEpisodeState,
  DecisionJournal,
  openIntents,
  validateSupervisorRecord,
  type EpisodeGraph,
  type EpisodeState,
  type SupervisorRecord,
  type TaskAcceptance,
} from "../episode/journal.js";
import { evaluate as evaluateAcceptance } from "../acceptance/evaluator.js";
import type { GateResult, ArtifactEvidence, ArtifactIdentity, EvaluateInput, AcceptanceAssessment } from "../acceptance/evaluator.js";
import { runSupervisorEpisode, type ComposePorts, type GatePort, type GateRequestLike, type RunnerPort, type SupervisorConfig, type SupervisorResult } from "../supervisor/compose.js";
import { executeRecoveryAction } from "../executor/exec.js";
import { planRecovery } from "../planner/plan.js";
// P9 merge-port wiring (docs/16 §0.6): the host is the ONE sanctioned
// importer of the integration module — the seam opened when the compose
// loop grew its merge port. The executor's `merge-unwired` refusal
// (docs/15 §3) stays intact for every other caller.
import { integrateTestedCandidate, type IntegrationJournalPort, type IntegrationGatePort } from "../integration/merge.js";
import { investigate as runInvestigation } from "../investigation/agent.js";
import { makeEscalationChannel, makeEscalationDispatcher, type DeliverPort } from "../escalation/channel.js";
import { AttemptRunner, type AttemptTask } from "../runner/attempt.js";
import { FileSteeringQueue } from "../steer/file-queue.js";
import { runSchedulerEpisode, type SchedulerDeps, type SchedulerResult } from "../supervisor/schedule.js";
import { makeLedgerAdmissionCheck } from "./sched-gate.js";
import { WorktreeProvisioner } from "../worktree/provision.js";
import type { TaskAcceptanceSpec } from "../acceptance/evaluator.js";

// ─── Host options ──────────────────────────────────────────────────────────

export interface HostEpisodeOptions {
  /** Episodes root (S4). Default: ~/.tre/episodes via defaultEpisodesRoot. */
  episodesRoot?: string;
  /** Path to graph.json. When absent, `graph` is required and the S4
   *  scaffold is created idempotently (createEpisodeLayout). */
  graphPath?: string;
  graph?: EpisodeGraph;
  /** The task this supervisor loop drives (exactly one, M2). */
  taskId: string;
  /** Grant identity for every gate request + journal record (§14.7). */
  grantedBy: string;
  /** Worker session file. Default: <episode>/sessions/<taskId>.jsonl. */
  sessionPath?: string;
  /** Steer file for the loop's SteerPort + the executor's nudge pushes.
   *  Default: <episode>/steer.jsonl. */
  steerPath?: string;
  /** Worker spawn command override (default `tre.`). */
  workerCommand?: string;
  /** W1-C1 (audit cycle W1): the task's WORKING TREE. The worker spawns
   *  with this cwd and the acceptance evidence (identity, gate run,
   *  artifact digests) is measured HERE — never in the episode dir.
   *  Absent = the loop still runs, but the identity is disclosed as
   *  dirty-unknown: the episode dir is not the task's tree. */
  worktreePath?: string;
  /** P9 merge port (docs/16 §0.6): the integration branch the merge
   *  advances — a SINGLE git branch-name element matching
   *  ^[A-Za-z0-9][A-Za-z0-9._-]*$ (P12's SAFE_ID grammar — the SAME
   *  shape P12's context validator admits; slash-containing names like
   *  `integrate/ep1` are refused up front, NEVER a worker started for
   *  an integration that can only halt at `context:episodeBranch` —
   *  P9 audit cycle-2 F4). PRESENT = the
   *  host injects the compose loop's merge port: the planner's `merge`
   *  action routes to integrateTestedCandidate against `worktreePath`
   *  (which must be the git repo holding both the episode branch and
   *  the agent/** task branches). ABSENT = the port is not injected and
   *  the executor's `merge-unwired` refusal remains the behavior
   *  (docs/15 §3 — an un-wired merge is still a hard refusal). */
  episodeBranch?: string;
  /** P9 audit cycle-2 F3: operator-raised baseline for the integration
   *  executionSeq. A terminal act-unknown outcome SPENDS its seq forever
   *  (P12 refuses to replay it — docs/16 §2 the recovery is a NEW
   *  identity), so a journal-derived count alone can never reach past a
   *  stuck terminal. The host logs the exact remedy per activation;
   *  setting this field is the operator's authorization to start above
   *  the spent seq (e.g. after reconciling whether the CAS landed).
   *  ABSENT = derived from the journal (count of acked merge outcomes). */
  integrationSeqBump?: number;
  /** Loop-structure cap (docs/18 §3). */
  maxIterations?: number;
  /** Host sink (stderr by default). Never throws into the loop. */
  log?: (line: string) => void;
  /** P13/B-F1 (audit cycle P16): the delivery ACT for escalations
   *  (docs/19 §5/§6 — `makeTelegramDeliver(bridge)` is the one
   *  consumer). Before this the channel was built WITHOUT deliver/read:
   *  every raise returned `delivery:{ok:false,error:"port-missing:deliver"}`
   *  while the loop journalled the escalation as acked — the human was
   *  never asked (B-F1), and restart lost the pending view (B-F2).
   *  Absent = records are appended and the MISSING delivery is
   *  disclosed on the host log, never presented as delivered. */
  escalationDeliver?: DeliverPort["deliver"];
  /** P20c3-F1 (audit cycle 2, finding 1): hardening knob — hold the
   *  takeover lock for this many ms AFTER the swap completes, so any
   *  contender that reclaimed the lock before our swap observes the
   *  lease's fresh bytes or the lock's bumped 30s steal window. The
   *  primary defense is the post-swap lock-stamp ownership fence; this
   *  is the belt. Default 0 = no hold (pre-P20c3 behavior). */
  leaseSwapHoldMs?: number;
}

export interface HostEpisodeResult {
  result: SupervisorResult;
  episodePath: string;
  /** Cumulative steer stats (host-reported, never authority). */
  steerStats: { linesRead: number; injected: number; malformed: number };
  /** P16 (audit cycle, docs/19 §6): the park ACT as the loop dispatched it
   *  — the SAME closure behind `dispatch.park` (state write + durable
   *  escalation + disclosure), exposed so tests can pin the handler's
   *  contract. The planner's `park` SEED fires only for a LIVE worker &&
   *  !ownershipProvable && !ambiguousExternalEffect — a predicate the
   *  compose loop never produces (it always sends the worker stopped
   *  between turns), so the loop path cannot drive the handler in a test.
   *  NEVER call while the episode is running; it is for the finished/
   *  stopped episode and for regression tests of the park handler.
   *
   *  P9 audit cycle-1 F1 REMOVED the `mergeTask` seam this field used to
   *  sit beside: the closure acted AFTER the episode lease was released
   *  (the outer `finally` runs before the caller receives the result),
   *  stayed callable after parked/escalation-exhausted, and bypassed the
   *  loop's intent protocol. Integration now dispatches IN the loop via
   *  the operator-declared `integration: { trigger: 'on-finish' }`
   *  config (docs/16 §0.6) — under the lease, with the loop's intent
   *  pairing — and test/host-merge-port.test.ts drives that real route. */
  parkTask: () => Promise<void>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const now = () => Date.now();

/** W1-M7 preserve-aside (M2 audit c5): MOVE `statePath` to the first free
 *  `<statePath>.unreadable-<ts>[.N]` and return that name. `now()` is
 *  millisecond-granular and the three aside sites can fire for the same base
 *  in the same ms, so the name must be claimed ATOMICALLY. `link` is the
 *  POSIX primitive that does it: it fails with EEXIST when the name is
 *  taken, so a second writer cannot slip in between the probe and the move
 *  the way the old check-then-`rename` did (`rename` REPLACES its target,
 *  silently destroying the earlier preserved bytes). EEXIST is the ONLY
 *  tolerated probe failure; any OTHER `link` error (a filesystem without
 *  hardlink support, a cross-device aside, a vanished source) is NOT proof
 *  the name is free, so the probe stops and falls back to the old plain
 *  `rename` (same filesystem in practice — keep it simple). Bounded: `cap`
 *  probes, then the plain-rename fallback, never a hang. Throws when the
 *  fallback move itself fails OR the random tail exhausts (source then stays
 *  in place, nothing destroyed) — the caller logs the honest
 *  "preserve failed — NOTHING overwritten". cap must be >= 1.
 *  PRECONDITION: every caller holds the episode lease (acquired before all
 *  three call sites — runHostEpisode and runScheduledHostEpisode), so the
 *  probe→rename window on the fallback path has no second writer. */
export async function preserveAside(statePath: string, ts: number = now(), cap = 500): Promise<string> {
  if (cap < 1) throw new RangeError(`preserveAside: cap must be >= 1 (got ${cap})`); // cap=0 would skip every deterministic name (M2 audit c5c R1)
  const stem = `${statePath}.unreadable-${String(ts)}`;
  let probeMode = false; // sticky once link() proves unusable (see below)
  for (let n = 0; n < cap; n++) {
    const candidate = n === 0 ? stem : `${stem}.${String(n)}`;
    if (!probeMode) {
      try {
        await link(statePath, candidate); // atomic claim: EEXIST = taken
        // The link holds the bytes under the claimed name; drop the original
        // name. A failed unlink leaves BOTH names — the bytes are preserved
        // either way, so it is not a preserve failure.
        await unlink(statePath).catch(() => {});
        return candidate;
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "EEXIST") continue; // try the next candidate
        // link() is unusable here (no-hardlink filesystem, cross-device,
        // a directory source — EPERM on both): a non-EEXIST error proves
        // NOTHING about the candidate, so switch to occupancy-probe mode for
        // all remaining candidates instead of blindly renaming (a plain
        // rename REPLACES a taken name — that silently destroyed a same-ms
        // first copy, M2 audit c5 finding).
        probeMode = true;
      }
    }
    if (await asideTaken(candidate)) continue; // occupied: try the next name
    // No hardlink primitive here: check-then-rename is the best available.
    // The lease serializes episode writers, so the probe->rename window has
    // no second writer (M2 audit c4 note).
    await rename(statePath, candidate);
    return candidate;
  }
  // Cap exhausted (>=cap asides of one base in one ms): never rename onto a
  // name that has not been probed free — a plain `${stem}.${cap}` rename
  // WOULD overwrite an existing aside (M2 audit c5 finding). Random tail:
  // re-roll and probe until free. On exhaustion (all 8 rolls taken — with
  // fair 32-bit randomness a ~2^-256 event, or a hostile/degenerate
  // Math.random), THROW instead of renaming: the source stays in place and
  // nothing is destroyed; callers catch and log the honest
  // "preserve failed — NOTHING overwritten" (M2 audit c5c F1).
  for (let r = 0; r < 8; r++) {
    const last = `${stem}.${String(cap)}.${Math.floor(Math.random() * 4294967296).toString(36)}`;
    if (await asideTaken(last)) continue;
    await rename(statePath, last);
    return last;
  }
  throw new Error(`preserveAside: every deterministic name (cap=${cap}) and all 8 random tail candidates are occupied — refusing to overwrite (source kept at ${statePath})`);
}

/** Is `p` already claimed? lstat success = taken; ENOENT = free; any OTHER
 *  stat error counts as taken (conservative: step aside to the next name). */
async function asideTaken(p: string): Promise<boolean> {
  try { await lstat(p); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code !== "ENOENT"; }
}

function assertId(v: string, what: string): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) {
    throw new Error(`host: ${what} must be a safe, non-empty path component (got ${JSON.stringify(v)})`);
  }
  return v;
}

/** Graph acceptance (string criteria) → the P14 spec shape. */
export function acceptanceSpecFrom(graph: TaskAcceptance | undefined): TaskAcceptanceSpec {
  return {
    criteria: (graph?.criteria ?? []).map((id) => ({ id, kind: "deterministic" as const, required: true })),
    requiredChecks: graph?.requiredChecks ?? [],
    artifacts: graph?.artifacts ?? [],
  };
}

/** Outcome of a shell run. `cause` is the CLOSED reason the process ended
 *  (W1-M2, audit cycle W1): "exit" = normal exit (code holds it),
 *  "signal" = killed by a signal (code holds the signal name),
 *  "timeout" = the timeout fired and the whole process GROUP was killed,
 *  "spawn-error" = the child never started. `code` is only the numeric
 *  exit code when cause === "exit"; -1 otherwise. Conflating timeout and
 *  signal into exit=-1 mislabeled evidence, so the cause is carried. */
interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
  cause: "exit" | "signal" | "timeout" | "spawn-error" | "escaped-writer";
  signal?: string;
  /** W4-A1 (audit cycle W4): true when FULL-capture (opts.maxBytes) hit
   *  the cap and STOPPED collecting — the returned stdout is NOT the
   *  complete output. Observation paths must treat this as fail-closed;
   *  tail-mode callers never see it (undefined). */
  truncated?: boolean;
  /** W6 (audit cycle W5 follow-up): set ONLY in `hashStdout` mode — the
   *  SHA-256 (hex) of EVERY stdout byte the child wrote, with no cap and
   *  no stored copy (constant memory). ABSENT when the stream was cut
   *  short (timeout / signal / spawn-error): an unaccounted prefix is
   *  never handed out as a digest, so callers must treat its absence as
   *  fail-closed. */
  stdoutDigest?: string;
}

/** The git/gate execution environment (W2-M5, audit cycle W2): ONE
 *  env for every tree-touching command — the policy gate and the
 *  identity observation must see the SAME git the worker's tree does.
 *  Inheriting the full process env leaked unrelated vars into the gate
 *  (and made the gate's git disagree with the observed git whenever the
 *  ambient config differed); inheriting NOTHING broke git's need for
 *  HOME. This is the deliberate middle: minimal, identical on both
 *  paths, with the system-config read suppressed (the sandbox cannot
 *  read /etc/gitconfig, and host-level git config must not bend the
 *  observation either way). */
export const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  ...(process.env["HOME"] !== undefined ? { HOME: process.env["HOME"] } : {}),
  GIT_CONFIG_NOSYSTEM: "1",
  // MG-C4 (audit cycle-4, scenario global-config): NOSYSTEM alone still
  // reads $HOME/.gitconfig (and its include.path chain) — a gate that
  // mutates the invoking user's global config bends the effective
  // semantics of every observed command AND the gate itself while the
  // layout digest (which binds only repo-local files) never moves.
  // Pin the global slot to /dev/null: the observation runs with repo-
  // local config as the ONLY config source (same contract as merge.ts).
  // GIT_CONFIG_GLOBAL is honoured by git >= 2.32; NOSYSTEM covers the
  // system slot on all versions.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PORCELAIN: "1",
  // P9 audit cycle-2 F1: replacement refs silently REDIRECT object
  // interpretation (`git replace <cand> <safe>` made every observation
  // describe substituted content while the raw candidate stayed
  // different — proven). Every git run in this module resolves RAW
  // objects only; runObservedGit pins the CLI flag too.
  GIT_NO_REPLACE_OBJECTS: "1",
};

/** MG-C4-A3 (A3 BUG-tracked-eol): the empty tree's well-known OID.
 *  `GIT_ATTR_SOURCE` points git's attribute interpreter at a TREE
 *  object instead of the working tree's .gitattributes chain — the
 *  EMPTY tree carries no attributes, so every built-in conversion
 *  (text/eol/ident/export-ignore, no filter pin touches those) is
 *  pinned to identity FOR THAT COMMAND. Probe (git 2.54, this cycle):
 *  a candidate commit containing `base.txt text eol=crlf` made
 *  `worktree add` materialize CRLF bytes (≠ the raw blob), and post
 *  that, `status` read gate-rewritten CRLF bytes as CLEAN — exactly
 *  the stale-certification channel the A3 tracked-eol scenario rode.
 *  With GIT_ATTR_SOURCE=<empty tree> `worktree add` writes the RAW
 *  blob bytes and `status` compares raw (probe: " M base.txt"
 *  reappears). The empty tree is synthesised by git itself (cat-file
 *  -e succeeds on a fresh repo with no mktree), so no fixture is
 *  needed; a repo where it somehow cannot resolve fails the command
 *  — fail closed. An EMPTY env value is NOT a valid attr source
 *  (exit 128), hence the OID pin. */
export const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Run a command capturing output; never rejects (exit code + tails).
 *  W1-M2: the child is spawned detached as its OWN process group and a
 *  timeout SIGKILLs the GROUP (`kill(-pid)`), so backgrounded
 *  grandchildren (the `sleep 1000 & true` shape) die with it instead of
 *  surviving to mutate the observed tree while the harness only ever
 *  killed /bin/sh itself.
 *  W2-M4 (audit cycle W2): the group kill happens on EVERY exit path,
 *  not only the timeout — a grandchild that outlives a CLEAN exit-0
 *  shell mutated the tree after the "success" was recorded just as
 *  hard as one that outlived a timeout. ESRCH (group already reaped,
 *  the normal case) is fine.
 *  W4-A1 (audit cycle W4): the 16 KiB TAIL cap silently dropped the
 *  FRONT of `git status`/`git diff` output once a tree had enough dirt
 *  (PROVEN: 600 untracked files → exactly 16384 bytes returned, first
 *  files missing), so edits to files the cap had dropped never moved
 *  the digest — a PASS could be stamped on an identity blind to them.
 *  Observation callers now pass `maxBytes` for FULL capture: output is
 *  kept from the FRONT up to the cap, collection stops past it, and
 *  `truncated: true` fails the observation closed. Display/gate-log
 *  callers keep the 16 KiB tail (a truncated LOG is a display issue;
 *  a truncated IDENTITY is a soundness one). */
export function runShell(cmd: string, cwd: string, timeoutS = 60, opts?: { env?: NodeJS.ProcessEnv; maxBytes?: number; hashStdout?: boolean }): Promise<ShellResult> {
  const maxBytes = opts?.maxBytes; // undefined = legacy 16KiB tail mode
  const hashMode = opts?.hashStdout === true; // W6: digest-only capture
  return new Promise((res) => {
    let child;
    try {
      child = spawn("/bin/sh", ["-c", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, ...(opts?.env !== undefined ? { env: opts.env } : {}) });
    } catch (e) {
      res({ code: -1, stdout: "", stderr: String((e as Error)?.message ?? e), cause: "spawn-error" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let done = false;
    // W4-A1: full-capture mode buffers stdout chunks from the FRONT up
    // to maxBytes, then sets `truncated` and drains the rest (a
    // truncated identity fails closed upstream — nothing past the cap
    // is ever digested as if complete). Tail mode (no maxBytes) keeps
    // the legacy 16KiB-slice behavior for display/gate-log callers.
    const fullChunks: Buffer[] = [];
    // W6: hash mode digests every stdout byte as it streams (never
    // stored), so a diff of ANY size is fully bound at constant memory.
    const stdoutHash = createHash("sha256");
    let kept = 0;
    /** Resolve-once: composes the result, adding the full-capture stdout
     *  (and the truncated flag) in full mode, the tail string otherwise.
     *  `partial` passes the timeout/error case through untouched; in full
     *  mode the collected prefix is appended to it. */
    const finish = (r: ShellResult, partial = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (maxBytes !== undefined && !partial) res({ ...r, stdout: Buffer.concat(fullChunks).toString("utf8"), ...(truncated ? { truncated: true } : {}) });
      else if (maxBytes !== undefined) res({ ...r, stdout: r.stdout + Buffer.concat(fullChunks).toString("utf8"), ...(truncated ? { truncated: true } : {}) });
      else res(r);
    };
    const killGroup = () => {
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch { /* group already gone */ } }
    };
    // W11-A3 (audit cycle P16, finding A-M3): the leader's own exit was
    // observed but 'close' never fired (a setsid()-escaped grandchild
    // holds the inherited pipe), so the timer used to resolve a leader
    // that exited 0 as cause:"timeout"/code:-1 — the exact W1-M2
    // evidence mislabel re-created through the A-M2 escape. The cause is
    // now honest: a leader that already exited keeps ITS code/cause and
    // is disclosed with the escaped-writer marker.
    let leaderExit: { code: number | null; signal: string | null } | undefined;
    const timer = setTimeout(() => {
      if (!done) {
        killGroup();
        if (leaderExit !== undefined) {
          // Leader already exited; a pipe-holding escapee kept 'close'
          // from firing. Journal the leader's real outcome, disclosed.
          const le = leaderExit;
          finish({ code: le.code ?? -1, stdout: maxBytes !== undefined ? "" : stdout, stderr: stderr + "\n(escaped-writer: leader exited but a process outside its group held the pipe open to timeout)", cause: le.signal != null ? "signal" : "escaped-writer", ...(le.signal != null ? { signal: le.signal } : {}) }, true);
          return;
        }
        // Tail mode used to hand back the collected stdout on timeout;
        // finish() reproduces that from the closure in tail mode, and
        // prepends the collected prefix (marked truncated) in full mode.
        finish({ code: -1, stdout: maxBytes !== undefined ? "" : stdout, stderr: stderr + "\n(gate timeout: process group SIGKILLed)", cause: "timeout" }, true);
      }
    }, Math.max(1, timeoutS) * 1000);
    if (hashMode) {
      // W6: digest-only capture — bytes flow into the hash and are
      // dropped; stdout is never accumulated (constant memory for a
      // diff of ANY size). No cap, so no `truncated` concept here.
      child.stdout.on("data", (d: Buffer) => { stdoutHash.update(d); });
    } else if (maxBytes !== undefined) {
      child.stdout.on("data", (d: Buffer) => {
        if (truncated) return; // drain past the cap
        if (kept + d.length <= maxBytes) { fullChunks.push(d); kept += d.length; }
        else { fullChunks.push(d.subarray(0, maxBytes - kept)); kept = maxBytes; truncated = true; }
      });
    } else {
      child.stdout.on("data", (d: Buffer) => { stdout = (stdout + d.toString()).slice(-16 * 1024); });
    }
    child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-16 * 1024); });
    child.on("error", (e) => { finish({ code: -1, stdout: maxBytes !== undefined ? "" : stdout, stderr: String((e as Error)?.message ?? e), cause: "spawn-error" }); });
    // W2-M4: the LEADER dying is the moment to reap the group — a
    // backgrounded grandchild inherits the stdout/stderr pipes, so
    // 'close' would never fire while it lives (the W1-M2 evidence
    // mislabel: an exit-0 gate journalled as a 120s timeout because a
    // lingering `sleep &` held the pipe open). Kill on 'exit'; 'close'
    // (all pipe writers gone) then resolves the result.
    // W3-A3 (disclosed trade-off): the group is killed the moment the
    // leader exits, so a gate that legitimately DAEMONIZES (spawns a
    // server meant to outlive the gate) has its child SIGKILLed silently
    // here. That is deliberate: the supervisor's tree must never have a
    // writer alive after the gate's identity was stamped — a persistent
    // service does not belong inside an acceptance gate.
    child.on("exit", (code, signal) => { leaderExit = { code: code ?? null, signal: signal ?? null }; killGroup(); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // W2-M4: the leader exited — the GROUP may still hold survivors
      // (grandchildren, or the shell exited but a bg job lingers).
      // Kill the group on the success path too; close (not exit) means
      // the stdio pipes are closed, so no surviving WRITER to the
      // buffers we are about to return.
      killGroup();
      if (code === null) finish({ code: -1, stdout, stderr, cause: "signal", ...(signal != null ? { signal: String(signal) } : {}) });
      // W6: the digest covers EVERY byte only on a normal exit — a
      // signal-killed stream stopped mid-flight, so no stdoutDigest.
      else finish({ code, stdout, stderr, cause: "exit", ...(hashMode ? { stdoutDigest: stdoutHash.digest("hex") } : {}) });
    });
  });
}

/** Durable per-evaluation artifact: append the observation, return its ref. */
async function appendEvidence(epPath: string, sha: string, text: string): Promise<string> {
  const dir = join(epPath, "acceptance");
  await mkdir(dir, { recursive: true });
  const p = join(dir, "evidence.jsonl");
  await appendFile(p, JSON.stringify({ at: new Date().toISOString(), sha, text }) + "\n", "utf8");
  return `acceptance/evidence.jsonl#${sha.slice(0, 12)}`;
}

/** SHA-256 of a file's content (the exists-true proof, EV4); undefined on IO error.
 *  W8-A1 (audit of the W5/W6 streaming work): this used a whole-file
 *  `readFile`, so a big artifact was slurped into memory (probe: a
 *  1.5 GiB artifact took 1546 MB RSS) and anything past Node's buffer
 *  limit THREW — which the caller mapped to `exists: false`, i.e. a
 *  PRESENT artifact was reported "proven missing" (probe: a 3 GiB file
 *  that exists → exists:false → incomplete verdict). Now streamed in
 *  64 KiB chunks: constant memory, no size limit. */
export async function fileDigest(path: string): Promise<string | undefined> {
  try {
    const st = await stat(path);
    if (!st.isFile()) return undefined;
    const h = createHash("sha256");
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      let pos = 0;
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(64 * 1024, Math.max(0, st.size - pos)), pos);
        h.update(buf.subarray(0, bytesRead));
        pos += bytesRead;
        if (bytesRead === 0 || pos >= st.size) break;
      }
    } finally {
      await fh.close();
    }
    return h.digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * P16 — Real evidence collection for the acceptance evaluator. Runs the
 * episode's policy gate, observes the task's declared artifacts, and (when
 * the task names semantic criteria) asks a worker-judgment claim bound to
 * the observed identity. Every returned object is a TYPED EvaluateInput
 * fragment — the evaluator's fail-closed semantics mean a missing command
 * or unreadable artifact shows up as an honest fail/unknown, never as
 * fabricated proof.
 */
export interface AcceptEvidenceOptions {
  graph: EpisodeGraph;
  taskId: string;
  epPath: string;
  /** Working tree the gate + artifact observation run in. W1-C1 (audit
   *  cycle W1): when absent the identity falls back to baseCommit AND
   *  the fallback is DISCLOSED (the episode dir is not the task's tree —
   *  silently measuring it and stamping "clean @ baseCommit" was the
   *  critical mislabel). Callers pass the worker's worktreePath. */
  worktreePath?: string;
}

/** Observe the working tree's artifact identity (audit W1 M1/M4/minor-9,
 *  hardened W2-H1/H2, W3-A1). Fail-closed on every uncertain branch:
 *  - `git status` fails or times out       → the tree is DIRTY-UNKNOWN (a
 *    failed status can never stamp a tree clean);
 *  - CLEAN is only ever empty porcelain (untracked-files=all pinned,
 *    excludes disabled — a repo config can no longer hide files);
 *  - the dirty digest is CONTENT-bound on all three parts: `git
 *    write-tree` (the index's own content hash) + a config-pinned
 *    `git diff --binary HEAD` + the sha256 of every untracked file's
 *    content (W3-A1), so two different edits — tracked OR untracked —
 *    never collide and hostile repo diff config never bends it
 *    (W2-H1); unreadable untracked entries are
 *    disclosed in the digest (fail closed). */
/** Shell-quote one argv token for the /bin/sh -c route (single quotes;
 *  embedded single quotes re-emitted as '\''). Host-built argv only —
 *  but the observation command line is policy-critical, so it is quoted
 *  rather than interpolated. */
export function shellQuote(a: string): string {
  return `'${a.replace(/'/g, `'\\''`)}'`;
}

/** Run a git command for IDENTITY/CONTENT observation (W2-H1/H2, audit
 *  cycle W2): host policy-critical argv is EXPLICIT — host `-c`
 *  overrides beat a hostile repo's own .git/config (`git -c` has
 *  command-line precedence), pinning the observation so no repo-side
 *  config can bend it: `status.untrackedFiles=all` (a repo config
 *  `untrackedFiles=no` hid untracked files from porcelain),
 *  `core.excludesFile=/dev/null` (an ambient excludes file hid whole
 *  trees), `diff.ignoreSubmodules=none`, `--no-ext-diff` (an external
 *  diff driver rewrites the diff bytes), and sparse checkout OFF
 *  (skip-worktree entries hide on-disk deltas). The run gets the same
 *  minimal env (`GIT_ENV`) as the policy gate — the W1-era gate and
 *  observation inherited DIFFERENT things, so they could disagree about
 *  the same tree (the "clean gate passed @ dirty identity" shape). */
export async function runObservedGit(repo: string, args: string[], timeoutS = 30, opts?: { maxBytes?: number; hashStdout?: boolean; envExtra?: Record<string, string> } | number): Promise<ShellResult> {
  // W7-A1 (audit of W6): the 4th param USED to be a bare `maxBytes`
  // number. A stale/untyped JS caller still passing a number would have
  // it treated as an OPTIONS OBJECT — i.e. `maxBytes` silently undefined
  // and the call falls back to the legacy 16 KiB TAIL, which is exactly
  // the W4-A1 blindness (PROVEN: 27300-byte status came back as 16384,
  // with `truncated` NOT set, so nothing failed closed). Coerce instead:
  // a numeric 4th arg is a maxBytes request, never a silent downgrade.
  const o: { maxBytes?: number; hashStdout?: boolean; envExtra?: Record<string, string> } = typeof opts === "number" ? { maxBytes: opts } : (opts ?? {});
  const pinned = [
    "git",
    // P9 audit cycle-2 F1: replacement refs (refs/replace/*) REDIRECT
    // object interpretation — `git replace <cand-blob> <safe-blob>` made
    // `rev-parse HEAD`, `status`, and `ls-files` all describe the
    // SUBSTITUTED content while the raw candidate stayed UNSAFE (proven).
    // Every observed run resolves RAW objects only.
    "--no-replace-objects",
    "-c", "status.untrackedFiles=all",
    "-c", "core.excludesFile=/dev/null",
    "-c", "diff.ignoreSubmodules=none",
    "-c", "core.sparseCheckout=false",
    "-c", "core.sparseCheckoutCone=false",
    // R6-B1 (round-6 audit, repro .tre/review-probes/r6-observation-window.mjs):
    // `core.fsmonitor` is a repo-config-selected EXECUTABLE that every
    // index-touching command runs — it is NOT under core.hooksPath and
    // `--no-optional-locks` does not stop it. A helper that rewrites a
    // tracked file and answers "no changes" let the REAL-index reads that
    // follow the fresh status scan (ls-files, the staged check, write-tree)
    // observe a clean index over freshly modified bytes. The per-status/-diff
    // pins existed; every OTHER observed command was the open window. Pin
    // both caches off for EVERY runObservedGit invocation (cmd-line beats
    // config; the per-call duplicates are harmless).
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    // R7-B2 (round-7 audit): `core.fileMode=false` makes EVERY worktree
    // comparison (status, diff, write-tree's stat refresh) ignore the
    // exec bit — a bare `chmod` on a tracked file stayed invisible to
    // status AND to every mode-carrying digest input (probes
    // .tre/review-probes/t5,t6: a child submodule poisoned with
    // `core.fileMode=false` hid a chmod from its own status AND from
    // the parent's aggregate scan; parent status went blind too).
    // Command-line pins propagate into the submodule child scan that
    // the parent's status spawns (probe t5: `git -c core.filemode=true
    // status` reported `M sub` over a child whose own config said
    // false), so forcing the bit here closes the config-poisoning route
    // for the WHOLE observed tree; walkChildEntries binds the on-disk
    // bit directly as a config-independent second channel.
    "-c", "core.fileMode=true",
    // MG-C4 (audit cycle-4, INCONCLUSIVE #1): the supervisor-side git
    // runs shared no hook pin, unlike merge.ts — a repo-local (or
    // gate-written) core.hooksPath made post-checkout/reference-
    // transaction hooks fire INSIDE observed commands (worktree add
    // checks files out; a reference-transaction hook sees every ref
    // operation). No observed command here consumes hook output, so
    // the hook surface is pinned closed for every invocation.
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ];
  // W4-A1: identity/observation runs use FULL capture (front-kept) —
  // the 16 KiB display tail silently dropped the front of status/diff
  // output on dirty trees, blinding the digest to early entries. A cap
  // hit sets `truncated`, which observeIdentity fails CLOSED on;
  // nothing past the cap is ever digested as if complete.
  // W6: `hashStdout` replaces capture entirely for big streams — every
  // stdout byte is digested as it flows (constant memory, no cap), and
  // the digest is withheld on any cut-short stream.
  // W7-A2: hashStdout WINS over maxBytes when both are passed (probe
  // A4: the combo silently returned empty stdout WITH a digest, i.e. a
  // caller asking for a capped copy got no copy and no truncation flag).
  // Refuse the ambiguous combination rather than guess.
  if (o.maxBytes !== undefined && o.hashStdout === true) {
    throw new Error("host: runObservedGit maxBytes and hashStdout are mutually exclusive (a capped copy and a full digest cannot both be requested)");
  }
  // MG-C3-2 (cycle-3 audit): callers may add env vars (e.g.
  // GIT_INDEX_FILE for a throwaway observation index) on TOP of the
  // minimal GIT_ENV — the base stays minimal, only the named extras
  // are appended.
  const env = o.envExtra !== undefined ? { ...GIT_ENV, ...o.envExtra } : GIT_ENV;
  return runShell(pinned.map(shellQuote).join(" "), repo, timeoutS, { env, ...(o.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {}), ...(o.hashStdout !== undefined ? { hashStdout: o.hashStdout } : {}) });
}

/** Observe the working tree's identity: HEAD sha + a digest of tracked
 *  content (the index, hashed as raw object content — the staged blob,
 *  NOT `git diff --cached` whose OUTPUT bytes depend on diff
 *  machinery/config) + the worktree change over HEAD + every untracked
 *  file's content (W3-A1).
 *  W2-H1: EVERY argv is scrubbed and env-unified; a failed observation
 *  fails CLOSED (dirty with the failure in the digest, never clean). */
/** p12c5 cycle-1 audit F2 (extended by cycle-2 audit F1): enumerate
 *  every filter driver defined in the repo — clean AND smudge AND
 *  `process` — and return argv that NEUTRALIZES conversion: `-c
 *  <driver>=cat` (identity, command-line precedence beats the exact
 *  repo key; the W11-A4 probe showed wildcards lose) plus
 *  `core.attributesFile=/dev/null`.
 *  C2-F1: git's `process` driver REPLACES clean+smudge when set (real
 *  git 2.54 probe: a process-only driver answered the clean query and
 *  a clean/smudge override left it standing), so enumerating only
 *  clean|smudge let a process driver keep rewriting bytes under a
 *  "neutralized" status. The regex covers all three; any driver we can
 *  observe gets pinned to identity. Returns null when the driver set
 *  is UNOBSERVABLE (failed/truncated enumeration): drivers we cannot
 *  enumerate may all be lying, so the caller must fail closed. Same
 *  policy observeIdentity applies to its diff digest. */
/** MG-C3-1 (cycle-3 audit, probe `gitdir-redirect` + `alternates-invalid`
 *  on real git 2.54): the gitdir and the object-store layout are part of
 *  what the gate MEASURED. A gate could `rm .git; ln -s <shadow>/.git
 *  .git` — every post-gate read then resolves against a shadow store
 *  that merely CONTAINS the candidate (rev-parse HEAD matched, status
 *  read clean, integration accepted bytes that were never tested in the
 *  certified worktree) — or write `objects/info/alternates` (the local
 *  object dir is ALWAYS consulted, so a bogus entry is a silent warning
 *  and a real one is an object-confusion door for every later consumer).
 *  Snapshot the layout content (streamed, bounded memory, fail-closed
 *  on unreadable-vs-missing flips) pre-gate and re-verify post-gate:
 *  ANY change disqualifies the verdict. */
async function gitLayoutDigest(gitdir: string, common: string, worktreeDir: string): Promise<string> {
  const h = createHash("sha256");
  // MG-C4-1 (cycle-2 verifier, repros/A2): the OBJECT LAYOUT alone is
  // not the whole interpretation state. Probe evidence: a gate writing
  // `git config core.symlinks false` (or extensions.worktreeConfig, or
  // core.hooksPath for the CAS in merge.ts) into the SHARED common
  // config passed the digest and retargeted/neutralized the
  // post-gate observation (symlink→regular-file swap read clean), and a
  // `reference-transaction` hook under a gate-installed core.hooksPath
  // fired DURING the CAS update-ref and forged the merged branch. The
  // digest therefore binds every file that can change what a git read
  // MEANS: pointers, alternates, HEAD, config (worktree AND common —
  // repo-local config is the trust boundary but it must be the SAME
  // trust boundary pre- and post-gate), info/exclude + info/attributes
  // (conversion inputs), and every worktree admin dir (config,
  // config.worktree, gitdir) under the common dir.
  // MG-C4-A3 (cycle-3 A3 audit) extends the path set with the four
  // interpretation files the A3 probe showed were NOT bound:
  //  - common/config.worktree (scenario `main-config-worktree`: with
  //    extensions.worktreeConfig on, the PRIMARY worktree reads
  //    <common>/config.worktree, which only linked worktrees' copies
  //    were covered before — a write there bent merge.ts's semantics
  //    under an unmoving digest);
  //  - shallow (scenario `shallow`: writing <common>/shallow grafts
  //    history traversal — merge-base/ancestor answers change while
  //    HEAD/tree/digest stay identical);
  //  - objects/info/commit-graph (the cached history graph redirects
  //    traversal just like shallow);
  //  - the MATERIALIZED dot-git pointer in the gate worktree (scenario
  //    `dotgit-symlink`: `rm .git; ln -s <copy> .git` kept every
  //    resolved path equal; the pointer file itself was bound nowhere).
  const files = [
    join(worktreeDir, ".git"),
    join(gitdir, "HEAD"),
    join(gitdir, "objects", "info", "alternates"),
    join(common, "objects", "info", "alternates"),
    join(gitdir, "objects", "info", "commit-graph"),
    join(common, "objects", "info", "commit-graph"),
    join(gitdir, "commondir"),
    join(gitdir, "gitdir"),
    join(gitdir, "config"),
    join(common, "config"),
    join(gitdir, "config.worktree"),
    join(common, "config.worktree"),
    join(gitdir, "shallow"),
    join(common, "shallow"),
    join(gitdir, "info", "exclude"),
    join(common, "info", "exclude"),
    join(gitdir, "info", "attributes"),
    join(common, "info", "attributes"),
  ];
  // MG-C4-A3 (scenario `object-symlink`): the OBJECT STORE's own
  // topology is part of the identity — copying the objects aside and
  // replacing `objects` with a symlink to the copy left every read
  // answering normally (initially identical bytes) while severing the
  // store from its hash-path: a later in-place write to the copy
  // forges content under unchanged OIDs. Bind directory-vs-symlink
  // (and the link target string) for both object dirs.
  for (const d of [join(gitdir, "objects"), join(common, "objects")]) {
    try {
      const lst = await lstat(d);
      if (lst.isSymbolicLink()) {
        let tgt = "unreadable";
        try { tgt = await readlink(d); } catch { /* fail-stable marker */ }
        h.update(`dirlink:${d}->${tgt}\n`);
      } else if (lst.isDirectory()) {
        h.update(`dir:${d}\n`);
      } else {
        h.update(`nondir:${d}:${String(lst.mode)}\n`);
      }
    } catch {
      h.update(`dir-missing:${d}\n`);
    }
  }
  // Worktree admin dirs: enumerated through readdir so a NEWLY created
  // worktree registration also moves the digest (its absence-then-
  // presence sequence is caught by the per-entry digest below; the
  // directory listing itself is folded in first).
  let wtNames: string[] = [];
  try { wtNames = (await readdir(join(common, "worktrees"))).sort(); } catch { wtNames = []; }
  h.update(`worktrees:${wtNames.join(",")}\n`);
  for (const wt of wtNames) {
    files.push(
      join(common, "worktrees", wt, "gitdir"),
      join(common, "worktrees", wt, "config"),
      join(common, "worktrees", wt, "config.worktree"),
      join(common, "worktrees", wt, "HEAD"),
    );
  }
  for (const f of files) {
    // MG-C4-A3 (scenario `config-symlink`): binding CONTENT alone let a
    // gate replace a digested file with a SYMLINK to an identical copy —
    // open() follows the link, the digest never moved, and the file
    // became a mutable interpretation dependency pointing wherever the
    // gate likes. Bind the lstat TYPE first: a regular file's content,
    // a symlink's TARGET STRING (never read through a link), anything
    // else its mode. Regular→symlink (or symlink retarget) moves the
    // digest even when the bytes behind it are identical.
    let lst: Awaited<ReturnType<typeof lstat>> | null = null;
    try { lst = await lstat(f); } catch { lst = null; }
    if (lst === null) {
      h.update(`missing\0:${f}\0`); // a vanished file MUST move the digest
      continue;
    }
    if (lst.isSymbolicLink()) {
      let tgt = "unreadable";
      try { tgt = await readlink(f); } catch { /* fail-stable marker */ }
      // MG-C5-A2 (round-2 audit, repros/A3/audit-existing-attr-link.mjs):
      // binding the link TEXT alone let a pre-existing `.git/info/attributes
      // -> <external>` symlink keep its text while the GATE rewrote the
      // external target to `base.txt text eol=crlf` — same digest, bent
      // interpretation (info/attributes wins over GIT_ATTR_SOURCE and the
      // CRLF-mask forgery integrated). A digested symlink is CONSUMED
      // through its target, so fingerprint the CONSUMED bytes: resolve the
      // full indirection (realpath — ancestor indirection included) and
      // hash the target's bytes, folding in the link text (retargeting
      // still moves the digest) and the resolved path. Unresolvable
      // (dangling/ELOOP/unreadable target) is its OWN marker — never the
      // same value a readable target hashes to, so an unreadable-vs-
      // readable flip always moves the digest (fail closed). RESIDUAL:
      // the target racing back-and-forth BETWEEN the two digests is the
      // documented single-late-writer window, not new exposure here.
      h.update(`link\0${tgt}\0`);
      let real: string | null = null;
      try { real = await realpath(f); } catch { real = null; }
      if (real === null) {
        h.update("unresolvable");
      } else {
        try {
          const rl = await lstat(real);
          if (!rl.isFile()) {
            h.update(`nonreal:${String(rl.mode)}`);
          } else {
            const fh = await open(real, "r");
            try {
              const buf = Buffer.alloc(64 * 1024);
              for (;;) {
                const { bytesRead } = await fh.read(buf, 0, buf.length, null);
                if (bytesRead === 0) break;
                h.update(buf.subarray(0, bytesRead));
              }
            } finally {
              await fh.close();
            }
            h.update(`real:${real}`);
          }
        } catch {
          h.update("unreadable-target"); // fail closed on open/read races
        }
      }
      h.update(`\0:${f}\0`);
      continue;
    }
    if (!lst.isFile()) {
      h.update(`nonfile\0${String(lst.mode)}\0:${f}\0`);
      continue;
    }
    try {
      const fh = await open(f, "r");
      try {
        const buf = Buffer.alloc(64 * 1024);
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, buf.length, null);
          if (bytesRead === 0) break;
          h.update(buf.subarray(0, bytesRead));
        }
        h.update(`\0:${f}\0`);
      } finally {
        await fh.close();
      }
    } catch {
      h.update(`missing\0:${f}\0`); // fail closed on open/read races
    }
  }
  // MG-C4-A3 (scenario `include-config`): a gate editing a file PULLED
  // IN by `include.path`/`includeIf` changed the EFFECTIVE config while
  // every on-disk digested path stayed byte-identical — path-binding
  // cannot close a transitive dependency it cannot enumerate. Bind the
  // EFFECTIVE values of every setting that bends observation or the CAS:
  // hooks, ignore-case, eol/symlinks/sparse, fsmonitor, worktreeConfig,
  // attributesFile/excludesFile, partial clone (promisor re-fetches
  // "missing" objects), unpacked limit, and the index/version knobs.
  // The read uses the SAME pinned argv (runObservedGit) and fails
  // closed: an unreadable effective config is never "unchanged".
  const effKeys = [
    "core.hooksPath", "core.ignoreCase", "core.symlinks", "core.sparseCheckout",
    "core.sparseCheckoutCone", "core.fsmonitor", "core.untrackedCache",
    "core.worktree", "core.excludesFile", "core.attributesFile", "core.eol",
    // R7-B2 (round-7 audit): `core.fileMode=false` makes the worktree scan
    // IGNORE exec-bit changes — a gate flipping a tracked file's mode
    // stayed invisible to status AND to every mode-carrying digest input.
    // Bind the effective value: flipping the setting itself moves the
    // digest (and pins force the scan to honor the mode, see
    // PINNED_NEUTRALIZING_CONFIG).
    "core.fileMode",
    "core.autocrlf", "core.logAllRefUpdates", "core.repositoryFormatVersion",
    "core.preferSymlinkDirs",
    "extensions.worktreeConfig", "extensions.partialClone", "extensions.objectFormat",
    "core.packedGitLimit", "core.packedGitWindowSize", "core.bigFileThreshold",
    "gc.auto", "fetch.fsckObjects", "receive.fsckObjects", "uploadpack.allowFilter",
    "index.recordExpandedIndex",
  ];
  for (const k of effKeys) {
    // `--get-all`: exit 0 = value(s), exit 1 = unset, exit >1 = a
    // genuinely unreadable/invalid config → the marker moves the digest
    // and the post-gate comparison fails the verdict closed.
    const q = await runObservedGit(worktreeDir, ["config", "--get-all", k], 10, { maxBytes: 8192 });
    if (q.code === 0 && !q.truncated) h.update(`eff\0${k}=${q.stdout.trim()}\n`);
    else if (q.code === 1 && q.stdout.trim() === "") h.update(`eff\0${k}=(unset)\n`); // exit 1: no matching key
    else h.update(`eff\0${k}=unreadable:${q.code}\n`); // fail closed: digest moves
  }
  return h.digest("hex");
}

// MG-C5-A1 (round-2 audit, repros/A3/audit-autocrlf.mjs): the same
// `git config` write channel that installed filters also reaches every
// config-level transform that decides how checked-out bytes compare
// with the staged identity — `core.autocrlf` (a gate-set `true` made
// CRLF working bytes read CLEAN against the LF blob and corrupted the
// bytes on checkout), `core.eol`, `core.safecrlf`, `core.symlinks`
// (force-checkout plain files where symlinks are recorded — the
// fingerprint consumed then is NOT what the blob says), and
// `core.ident`. These pins ride on EVERY filterNeutralizeArgs consumer
// (checkout, both status scans, the diff) and are unconditional: they
// cost nothing when unset, and a conditional read would add an
// unfalsifiable path. A value predating the episode is caught by the
// layout digest (the effective-config key list includes autocrlf/eol/
// symlinks) and a mid-gate flip fails the post-gate re-observation.
// RESIDUAL closure note: the observed git runs all execute under the
// minimal GIT_ENV (GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null),
// so a value set ONLY in the system gitconfig or the user's global
// config cannot bend any observed content — it is invisible to the
// digest read AND inert in every observation. The repo/local layer
// (the attacker-reachable one, via `git config` inside the episode)
// is covered twice over: pinned here and hashed in the layout digest.
export const PINNED_NEUTRALIZING_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.autocrlf", "false"],
  ["core.eol", "native"],
  ["core.safecrlf", "false"],
  ["core.symlinks", "true"],
  ["core.ident", "false"],
];

// MG-C5-F1 (round-2 audit cycle 1, repro confirmed on git 2.54): the
// A2 fix fingerprints the info/attributes TARGET so a mid-episode
// rewrite moves the digest — but the deeper hole stays open: the repo's
// OWN `$GIT_DIR/info/attributes` OVERRIDES `GIT_ATTR_SOURCE` with a
// PRE-EXISTING conversion rule that never changes. A plain (or
// symlink-backed) `info/attributes` containing `base.txt text eol=crlf`
// seeded BEFORE the episode bent materialization AND both status scans
// identically — unchanged bytes sail through the digest while the
// worktree holds CRLF where the candidate has LF (`accepted-finish /
// integrated`, reproduced). `core.attributesFile` CANNOT help: the
// docs scope it to $XDG, and the XDG file ranks BELOW info/attributes.
// No `-c` pin re-ranks the source list (nor may the digest be trusted
// to "wait for a change" — the attack needs no change). Close it the
// only honest way: the interpretation of candidate bytes depends on
// this highest-precedence, per-repo, unoverridable source, so the
// gate requires it to be EMPTY/ABSENT or it refuses. Dangling symlink:
// git falls back to reading the LINK TEXT AS CONTENT (an attributes
// grammar error is a hard git error, not silently empty) — so only
// readable targets qualify; unresolvable/ELOOP/unreadable is "not
// observable" (fail closed). The path argument is a module constant,
// so no option-terminator is needed.
export async function attributesObservable(worktreeDir: string): Promise<boolean> {
  const r = await runObservedGit(worktreeDir, ["rev-parse", "--git-path", "info/attributes"], 10, { maxBytes: 4096 });
  if (r.code !== 0 || r.truncated || r.stdout.trim() === "") return false;
  const p = resolve(worktreeDir, r.stdout.trim());
  // F1 (audit round 2 follow-up): CONSERVATIVE emptiness. Git's own
  // comment rule is "a line whose FIRST character is #" — the old
  // blanket strip of `#…` anywhere plus JS `\s` (which includes NBSP)
  // treated `\u00a0# text eol=crlf` as empty while git applied it to
  // the path `\u00a0#`. Only a line that is wholly blank, or whose
  // first character is `#`, is ignorable; ANY other byte makes the
  // source a real rule (or unknown), so it is not observable.
  const effectiveEmpty = (buf: Buffer): boolean => {
    // Git's tokenizer (attr.c: `if (*line == '#' || !*line) continue`)
    // ignores ONLY a zero-byte line or one whose FIRST byte is `#`.
    // An empty line to git is "no bytes before the newline" — NOT
    // JS \s (which matches NBSP), and stripping `#…` anywhere turns
    // the real rule path `\u00a0#` into a fake comment. Work on
    // BYTES (latin1 round-trips every byte 1:1): split on \n, strip
    // one optional trailing \r, then require the first byte to be
    // SP-free... precisely: only "" or first char '#' is ignorable.
    const lines = buf.toString("latin1").split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      const body = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (body === "" || body.charCodeAt(0) === 0x23) continue;
      if (/^[ \t]*$/.test(body)) continue; // git trims leading blanks: blanks-only = no pattern
      return false; // NBSP-prefixed, an indented rule, a trailing-# rule: content
    }
    return true;
  };
  const MAX = 1024 * 1024; // a larger file is non-empty by construction
  try {
    const lst = await lstat(p);
    if (lst.isSymbolicLink()) {
      let real: string;
      try { real = await realpath(p); } catch { return false; }
      const rl = await lstat(real);
      if (!rl.isFile() || rl.size > MAX) return false;
      return effectiveEmpty(await readFile(real));
    }
    if (!lst.isFile() || lst.size > MAX) return false;
    return effectiveEmpty(await readFile(p));
  } catch (e) {
    // Absent is empty (nothing to interpret bytes with). Any OTHER
    // error (EACCES, ELOOP, race) means the highest-precedence
    // attribute source is NOT observable -> fail closed.
    return (e as NodeJS.ErrnoException)?.code === "ENOENT";
  }
}

export async function filterNeutralizeArgs(repo: string): Promise<string[] | null> {
  const filterDefs = await runObservedGit(repo, ["config", "--get-regexp", "^filter\\..+\\.(clean|smudge|process)$"], 10, { maxBytes: 256 * 1024 });
  if (filterDefs.code > 1 || filterDefs.truncated || (filterDefs.code !== 0 && filterDefs.stdout.trim() !== "")) return null;
  const args: string[] = ["-c", "core.attributesFile=/dev/null"];
  for (const [k, v] of PINNED_NEUTRALIZING_CONFIG) args.push("-c", `${k}=${v}`);
  for (const line of filterDefs.stdout.split("\n")) {
    const m = /^(filter\..+\.)(clean|smudge|process)(?=[ \t]|$)/.exec(line);
    if (m?.[1] !== undefined) {
      // C2-F1b (probe, git 2.54): a `process` driver MUST be pinned to
      // the EMPTY value — git's documented "disable this filter". The
      // naive `=cat` is WRONG for process keys: git SPAWNS `cat` as the
      // filter server, the handshake dies ("expected git-filter-server",
      // "cat died of signal 15") and `status` STILL EXITS 0 REPORTING
      // CLEAN — a false-clean oracle. An empty value disables the
      // driver outright; the (also-pinned) clean/smudge identity then
      // governs, or raw bytes are compared. clean/smudge keep `=cat`
      // (identity) — an empty value there would also disable, but `cat`
      // is the proven-neutral identity for the one-way conversion we
      // take through the index.
      args.push("-c", m[2] === "process" ? `${m[1]}${m[2]}=` : `${m[1]}${m[2]}=cat`);
    }
  }
  return args;
}

/** Fold every `??` (untracked) path from a `status -z --untracked-files=all`
 *  run into the digest as path + size + content sha256 (streamed, so any
 *  size is fully bound at constant memory; a path that cannot be statted or read
 *  contributes an unreadable marker so the digest MOVES — fail closed, an
 *  unreadable untracked file is dirt we cannot see, never "ignored"). */
async function untrackedDigestPart(repo: string, porcelainZ: string): Promise<string> {
  const paths: string[] = [];
  for (const rec of porcelainZ.split("\0")) {
    if (rec.startsWith("?? ")) paths.push(rec.slice(3));
  }
  paths.sort();
  const lines: string[] = [];
  for (const p of paths) {
    try {
      const st = await lstat(join(repo, p)); // lstat: never follow a hostile symlink
      if (st.isSymbolicLink()) {
        // W4-A2: a symlink's OWN content (as git sees it) is the target
        // STRING — bind it via readlink, which reads the stored link
        // without following it. Retargeting the link now moves the
        // digest; churn in whatever it points at still does NOT (the
        // target's bytes are not the link's content).
        try { lines.push(`symlink:${p}:${await readlink(join(repo, p))}`); }
        catch { lines.push(`unreadable:${p}`); }
        continue;
      }
      if (!st.isFile()) {
        lines.push(`nonfile:${p}:${String(st.mode)}`); // dir/socket/etc: path+kind, content N/A
        continue;
      }
      // W5-A2: no size-only fallback. Oversized files used to be recorded
      // as `oversized:<size>` — a same-size mid-file edit was INVISIBLE
      // (probe: digest unchanged). The hash below streams in 64 KiB chunks,
      // so the full file is bound at constant memory.
      const h = createHash("sha256");
      const fh = await open(join(repo, p), "r");
      try {
        const buf = Buffer.alloc(64 * 1024);
        let pos = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(64 * 1024, st.size - pos), pos);
          h.update(buf.subarray(0, bytesRead));
          pos += bytesRead;
          if (bytesRead === 0 || pos >= st.size) break;
        }
      } finally {
        await fh.close();
      }
      lines.push(`file:${p}:${st.size}:${h.digest("hex")}`);
    } catch {
      lines.push(`unreadable:${p}`); // fail closed: the digest moves, never silently drops
    }
  }
  return lines.join("\n");
}

/* ---------------------------------------------------------------------
 * R6-B2 / R6-B3 (round-6 audit): submodule child state is part of what
 * the tree IS, but the parent's status/diff only ever describe a child
 * in aggregate — never its bytes (B2: two distinct child content states
 * digested IDENTICALLY, so evidence stamped at S1 stayed "current" over
 * S2), and the child's OWN index can hide content behind `h`/`S` flags
 * or staged divergence the parent's porcelain never shows (B3: bare
 * {sha} over modified child bytes). Both close here: a raw content walk
 * of each populated child folds the child bytes into the dirty digest,
 * and a child blindness check (flags + staged-vs-HEAD, recursively)
 * guards the clean return. Names/paths only bound the failure markers;
 * caps bound the walk and fail closed. */
const SUBMODULE_CHECK_MAX_DEPTH = 3;
const SUBMODULE_WALK_MAX_ENTRIES = 20000;

/** gitlink (mode 160000) paths straight off the index — the authoritative
 *  submodule set (config-independent, unlike .gitmodules). */
async function listGitlinks(repo: string): Promise<{ ok: true; paths: string[] } | { ok: false; reason: string }> {
  const r = await runObservedGit(repo, ["ls-files", "-s", "-z"], 10, { maxBytes: 4 * 1024 * 1024 });
  if (r.code !== 0 || r.truncated) return { ok: false, reason: `code=${r.cause}:${r.code}` };
  const paths: string[] = [];
  for (const rec of r.stdout.split("\0")) {
    if (rec === "") continue;
    const tab = rec.indexOf("\t"); // "<mode> <sha> <stage>\t<path>"
    if (tab < 0) continue;
    if (rec.slice(0, tab).startsWith("160000 ")) paths.push(rec.slice(tab + 1));
  }
  paths.sort();
  return { ok: true, paths };
}

/** Raw worktree walk of a submodule child (content the parent's diff
 *  never binds). Deterministic (sorted, no git, no conversion), `.git`
 *  entries skipped at every level, symlinks bound as target strings,
 *  files streamed at constant memory. `partial` on ANY unreadable or a
 *  cap hit — the caller marks the identity unobservable. */
async function walkChildEntries(root: string, rel: string, lines: string[], state: { count: number; partial: boolean }): Promise<void> {
  if (state.partial) return;
  let names: string[];
  try { names = (await readdir(root === "" ? rel : join(root, rel), { withFileTypes: true })).map((e) => e.name).sort(); }
  catch { lines.push(`unreadable:${rel || "."}`); state.partial = true; return; }
  for (const name of names) {
    if (state.partial) return;
    if (name === ".git") continue; // the child's own repo dir / gitfile
    const relp = rel === "" ? name : `${rel}/${name}`;
    const abs = join(root, relp);
    state.count += 1;
    if (state.count > SUBMODULE_WALK_MAX_ENTRIES) { state.partial = true; return; }
    let st: Awaited<ReturnType<typeof lstat>>;
    try { st = await lstat(abs); } catch { lines.push(`unreadable:${relp}`); state.partial = true; return; }
    if (st.isSymbolicLink()) {
      try { lines.push(`sym:${relp}:${await readlink(abs)}`); }
      catch { lines.push(`unreadable:${relp}`); state.partial = true; }
      continue;
    }
    if (st.isDirectory()) { await walkChildEntries(root, relp, lines, state); continue; }
    if (!st.isFile()) { lines.push(`nonfile:${relp}`); continue; }
    // R7-B2 (round-7 audit): bind the ON-DISK exec bit (0/1) beside the
    // content — a raw `chmod` with unchanged bytes used to leave this
    // walk (and the parent's whole fold) untouched, so the identity
    // never moved. `st.mode` comes from lstat, not git: no repo config
    // can hide the bit from it. The child's INDEX modes are folded
    // separately (ls-files -s in submoduleStatePart).
    const execBit = (st.mode & 0o111) !== 0 ? 1 : 0;
    try {
      const h = createHash("sha256");
      const fh = await open(abs, "r");
      let total = 0;
      try {
        const buf = Buffer.alloc(64 * 1024);
        let pos = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, 64 * 1024, pos);
          h.update(buf.subarray(0, bytesRead));
          pos += bytesRead; total += bytesRead;
          if (bytesRead === 0) break;
        }
      } finally { await fh.close(); }
      lines.push(`f:${relp}:${total}:${execBit}:${h.digest("hex")}`);
    } catch { lines.push(`unreadable:${relp}`); state.partial = true; }
  }
}

/** Fold every gitlink child's state (its HEAD sha + a raw walk of its
 *  worktree) into digest input. Unpopulated children are recorded as a
 *  stable marker (no content exists to bind). */
async function submoduleStatePart(cwd: string, gitlinkPaths: string[]): Promise<{ part: string; partial: boolean }> {
  const chunks: string[] = [];
  let partial = false;
  for (const p of gitlinkPaths) {
    const child = join(cwd, p);
    let populated = false;
    try { await stat(join(child, ".git")); populated = true; } catch { populated = false; }
    if (!populated) { chunks.push(`child-unpopulated:${p}`); continue; }
    const head = await runObservedGit(child, ["rev-parse", "HEAD"], 10, { maxBytes: 64 });
    const headSha = head.code === 0 && !head.truncated && head.stdout.trim() !== "" ? head.stdout.trim() : "";
    if (headSha === "") partial = true;
    // R7-B2 (round-7 audit): fold the child's OWN INDEX as git's
    // path/mode/blob list (`ls-files -s -z` — mode and sha are digested,
    // the index's content, config-independent of core.fileMode). The
    // parent's write-tree hashes the gitlink sha only — child staged
    // content or a staged exec-bit change left it untouched, so the
    // dirty digest never bound the child index (e.g. staged-only child
    // divergence between two dirty observations).
    const childIdx = await runObservedGit(child, ["ls-files", "-s", "-z"], 10, { hashStdout: true });
    const idxPart = childIdx.code === 0 && childIdx.stdoutDigest !== undefined && !childIdx.truncated
      ? `idx-sha256:${childIdx.stdoutDigest}`
      : `idx-failed:${childIdx.cause}:${childIdx.code ?? "no-digest"}`;
    if (idxPart.startsWith("idx-failed:")) partial = true;
    const lines: string[] = [];
    const state = { count: 0, partial: false };
    await walkChildEntries(child, "", lines, state);
    if (state.partial) partial = true;
    chunks.push(`child:${p}:head=${headSha === "" ? "unreadable" : headSha}:${idxPart}\n${lines.join("\n")}`);
  }
  return { part: chunks.join("\x00"), partial };
}

/** Clean-branch guard: a child whose OWN index hides content (h/S flags)
 *  or diverges staged-vs-HEAD is invisible to the parent's porcelain and
 *  staged checks — dirt we cannot see from the parent, so the caller
 *  fails closed. "" = every populated child observable and consistent;
 *  any other string is the discriminator. Recurses (bounded depth). */
async function submoduleBlindnessCheck(root: string, depth = 0): Promise<string> {
  if (depth > SUBMODULE_CHECK_MAX_DEPTH) return "submodule-depth-exceeded";
  const gl = await listGitlinks(root);
  if (!gl.ok) return `gitlink-enum-failed:${gl.reason}`;
  for (const p of gl.paths) {
    const child = join(root, p);
    let populated = false;
    try { await stat(join(child, ".git")); populated = true; } catch { populated = false; }
    if (!populated) continue; // no checkout -> nothing to hide
    const flags = await runObservedGit(child, ["ls-files", "-v", "-z"], 10, { maxBytes: 4 * 1024 * 1024 });
    if (flags.code !== 0 || flags.truncated) return `child-flags-unreadable:${p}:${flags.cause}:${flags.code}`;
    for (const rec of flags.stdout.split("\0")) {
      if (rec === "") continue;
      if ((rec[0] ?? "?") !== "H") return `child-index-flag:${p}:${rec[0]}:${rec.slice(2, 128)}`;
    }
    const staged = await runObservedGit(child, ["--no-optional-locks", "diff-index", "--cached", "--quiet", "--ignore-submodules=none", "--no-ext-diff", "HEAD", "--"], 15, { maxBytes: 1024 * 1024 });
    if (staged.code !== 0 && staged.code !== 1) return `child-staged-check-failed:${p}:${staged.cause}:${staged.code}`;
    if (staged.truncated) return `child-staged-check-truncated:${p}`;
    if (staged.code === 1) return `child-staged-divergence:${p}`;
    // R7-B1 (round-7 audit): a child file excluded by the child's own
    // .gitignore/info/exclude is NO dirt to any status — the parent's
    // porcelain, the child's flags, and the staged check above all read
    // byte-equal clean over an ignored payload the bare {sha} never
    // binds (probe: `echo '*.bak' > child/.gitignore; echo X >
    // child/x.bak` → parent observed clean; r7-verify-blockers B1c).
    // `ls-files --others` WITHOUT exclude options lists every untracked
    // path regardless of any exclude source (W11-A3's rule, applied to
    // the child): on the clean branch it must be EMPTY, since plain
    // untracked child content already forces the dirty path. Anything
    // here is excluded content hidden inside a supposedly clean child —
    // fail closed naming the child (paths bound only by marker).
    const childOthers = await runObservedGit(child, ["ls-files", "--others", "-z"], 10, { maxBytes: 4 * 1024 * 1024 });
    if (childOthers.code !== 0) return `child-others-check-failed:${p}:${childOthers.cause}:${childOthers.code}`;
    if (childOthers.truncated) return `child-others-check-truncated:${p}`;
    for (const rec of childOthers.stdout.split("\0")) {
      if (rec !== "") return `child-excluded-content:${p}`;
    }
    const nested = await submoduleBlindnessCheck(child, depth + 1);
    if (nested !== "") return nested;
  }
  return "";
}

/** R4-B1 (round-4 audit, repro .tre/review-probes/r4-false-clean.mjs):
 *  a plain `git status` trusts the REPO's own conversion settings on a
 *  STAT-CACHED index — a tracked `.gitattributes` `filter=evil` whose
 *  clean driver maps any bytes to the committed blob made mutated bytes
 *  compare equal to HEAD, and a plain status run (the gate, a prior
 *  observation) refreshing the stat cache hid the change even after the
 *  filter was neutralized later. Acceptance verdicts (`complete`) were
 *  minted over forged bytes. This is the SAME attack class the
 *  integration gate already closed (supervise.ts fresh-index block):
 *  build a THROWAWAY index with `read-tree HEAD` under
 *  `GIT_ATTR_SOURCE=<empty tree>` + the pinned neutralizing drivers
 *  (filterNeutralizeArgs), so `status` has NO stat cache and no
 *  conversion path — it re-reads and re-hashes every tracked file raw
 *  and mutated bytes can only report as modified (probe r5: forged
 *  bytes report " M base.txt" where the poisoned chain said clean).
 *  Failure anywhere returns a reason — the caller marks the identity
 *  dirty+unobservable (never clean, never comparable). */
export type FreshObservationIndex = { dir: string; envExtra: { GIT_INDEX_FILE: string; GIT_ATTR_SOURCE: string } };

/** R5-F1 (round-4 audit flake hunt, probe .tre/review-probes/r5-flake-full.mjs):
 *  the fresh index is built ONCE per observation and SHARED by status AND
 *  the `diff HEAD` step. It used to be status-only, and the diff kept
 *  running against the REAL index's stat cache: a forged worktree file of
 *  the SAME SIZE as the committed blob (EVIL\n vs base\n) whose stat was
 *  stamped by a poisoned plain `git status` (evil clean filter mapped the
 *  bytes to the blob, so git recorded the stat as "unchanged") made
 *  `git diff HEAD` skip the content comparison ENTIRELY — empty diff on a
 *  tree porcelain called modified, i.e. two observations of one state
 *  digested differently (non-comparable dirty deltas) and a diff channel a
 *  stat-stamp can still blind. A pristine (stat-cleared) throwaway index
 *  forces every tracked file to be re-read and re-hashed raw: the diff is
 *  deterministic and stat-stamp-proof. Caller owns `dir` and MUST rm -rf
 *  it when done (observeIdentity does, in a finally). */
async function buildFreshObservationIndex(cwd: string): Promise<{ ok: true; fresh: FreshObservationIndex } | { ok: false; reason: string }> {
  const filterArgs = await filterNeutralizeArgs(cwd);
  if (filterArgs === null) return { ok: false, reason: "filter-neutralize-failed" };
  const envExtra = { GIT_INDEX_FILE: "", GIT_ATTR_SOURCE: EMPTY_TREE_OID };
  let idxDir: string;
  try {
    idxDir = await mkdtemp(join(tmpdir(), "tre-obs-idx-"));
  } catch {
    return { ok: false, reason: "index-dir-uncreatable" };
  }
  const idxPath = join(idxDir, "idx");
  envExtra.GIT_INDEX_FILE = idxPath;
  try {
    const tree = await runObservedGit(cwd, [...filterArgs, "read-tree", "HEAD"], 30, { maxBytes: 4 * 1024 * 1024, envExtra });
    if (tree.code !== 0 || tree.truncated) {
      await rm(idxDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: `fresh-index-build-failed:code=${tree.cause}:${tree.code}` };
    }
    // The index MUST exist and be non-empty: a read-tree that wrote
    // nothing would hand status an empty index whose answer ("every
    // file deleted+untracked") is noise, and an unwritten file is how
    // the integration gate catches a silently-failed build too.
    let idxStat: Awaited<ReturnType<typeof lstat>> | null = null;
    try { idxStat = await lstat(idxPath); } catch { /* fail closed below */ }
    if (idxStat === null || idxStat.size === 0) {
      await rm(idxDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: "fresh-index-unwritten" };
    }
    return { ok: true, fresh: { dir: idxDir, envExtra } };
  } catch (e) {
    await rm(idxDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: `fresh-index-build-threw:${String(e)}` };
  }
}

async function observeStatusFresh(cwd: string, maxBytes: number, fresh: FreshObservationIndex): Promise<{ ok: true; porcelain: string } | { ok: false; reason: string }> {
  const filterArgs = await filterNeutralizeArgs(cwd);
  if (filterArgs === null) return { ok: false, reason: "filter-neutralize-failed" };
  // fsmonitor/untrackedCache OFF: both can serve stale entries — the
  // whole point of the fresh index is that NOTHING is trusted.
  // 30s (not the plain status's 10): every tracked file is re-read
  // and re-hashed, and the clean-smudge identity runs over it.
  // R5-B1 (round-5 audit): `submodule.<name>.ignore=all` in REPO config
  // hides a populated submodule's modified bytes from status — proven:
  // with the setting, porcelain came back empty over modified child/a.
  // `diff.ignoreSubmodules=none` (the runObservedGit pin) does NOT cover
  // the status command; only `--ignore-submodules=none` on the COMMAND
  // LINE beats the per-submodule config (git precedence: cmd > config),
  // and it is harmless on uninitialized submodules (quiet, exit 0 —
  // verified). Child HEAD moves and child worktree dirt now both show.
  const st = await runObservedGit(cwd, [...filterArgs, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], 30, { maxBytes, envExtra: fresh.envExtra });
  if (st.code !== 0) return { ok: false, reason: `status-failed:code=${st.cause}:${st.code}` };
  if (st.truncated) return { ok: false, reason: `status-truncated:${String(st.stdout.length)}` };
  return { ok: true, porcelain: st.stdout };
}

export async function observeIdentity(cwd: string, sha: string, maxBytes = 64 * 1024 * 1024): Promise<ArtifactIdentity> {
  // MG-C5-F1 (round-2 audit cycle 1): a non-empty `$GIT_DIR/info/attributes`
  // is a highest-precedence conversion source that GIT_ATTR_SOURCE cannot
  // override and the layout digest cannot falsify (unchanged bytes pass).
  // identity as unverifiable (dirty), fail closed. In a NON-GIT dir
  // `rev-parse` fails -> not observable -> same dirty verdict the
  // failing status below would have produced.
  // F2 (audit round 2 follow-up): an UNOBSERVABLE identity must never be
  // comparable. A constant digest here made every unobservable tree equal
  // to every other one (sameArtifact + the post-gate comparison treat
  // equal nonempty dirty digests as the same artifact), so a gate could
  // swap the worktree contents and still read "unchanged". A fresh random
  // nonce is unequal to every other digest, including itself on a
  // re-observation, so the identity can never certify anything.
  if (!(await attributesObservable(cwd))) {
    return { sha, dirty: true, unobservable: true, dirtyDigest: createHash("sha256").update(`attributes-unobservable:${randomUUID()}`).digest("hex") };
  }
  // W3-A1: `-z` gives NUL-separated, UNSAFE-path-QUOTE-FREE records — a
  // filename containing a quote or newline can no longer forge a porcelain
  // line into (or out of) the digest text; the ?? paths are extracted raw.
  // R4-B1 (round-4 audit): this is now the FRESH-INDEX observation — the
  // plain `git status` it replaces trusted the repo's own conversion
  // settings (a tracked `filter=evil` .gitattributes collapsed mutated
  // bytes to the committed blob, probe r4-false-clean) AND a stat-cached
  // index (a prior plain status stamped the mutated file's stat so even a
  // later neutralized scan read it clean). A read-tree-built index under
  // GIT_ATTR_SOURCE=EMPTY_TREE + pinned identity drivers has neither
  // cache nor conversion: every tracked file is re-read and re-hashed
  // raw. A failed/unbuildable fresh observation is dirt we cannot see —
  // fail CLOSED as dirty+unobservable, never clean.
  // R5-F1: build the throwaway observation index ONCE; status AND the
  // `diff HEAD` below both run against it (never the real stat cache),
  // and it is removed when this observation ends.
  const freshBuilt = await buildFreshObservationIndex(cwd);
  if (!freshBuilt.ok) {
    return { sha, dirty: true, unobservable: true, dirtyDigest: createHash("sha256").update(`fresh-${freshBuilt.reason}\x00${sha}`).digest("hex") };
  }
  const fresh = freshBuilt.fresh;
  try {
  const dirty = await observeStatusFresh(cwd, maxBytes, fresh);
  if (!dirty.ok) {
    return { sha, dirty: true, unobservable: true, dirtyDigest: createHash("sha256").update(`fresh-${dirty.reason}\x00${sha}`).digest("hex") };
  }
  // W11-A1/A3 (audit cycle P16, findings A-C1/A-C2): a tracked entry
  // flagged `--assume-unchanged` (tag `h`) or `--skip-worktree` (tag
  // `S`) makes git status BLIND to its on-disk delta — a tampered file
  // observed byte-identically CLEAN (probe: `git update-index
  // --assume-unchanged src.ts; echo BACKDOOR > src.ts` → empty
  // porcelain → accepted-finish). `git ls-files -v` reads the flags
  // straight off the index, immune to the very blindness above: ANY
  // non-`H` entry (h, S, M/K from sparse trees, R reserved…) fails
  // closed. It runs on EVERY observation (not only the clean branch),
  // so flagged entries also move the dirty digest — the tree cannot be
  // stamped "unchanged" while its index flags hide content.
  // A-C2 variant note: the host's own `core.sparseCheckout=false` pin
  // SUPPRESSES the out-of-cone delta on git 2.54 (the flag-stripped
  // status sees nothing) — the ls-files check is what catches it, since
  // the S-tagged entries are what a cone leaves behind.
  const indexFlags = await runObservedGit(cwd, ["ls-files", "-v", "-z"], 10, { maxBytes });
  if (indexFlags.code !== 0) {
    // fail closed: an index we cannot read the flags of is dirt we
    // cannot see (same rule as a failed status).
    return { sha, dirty: true, unobservable: true, dirtyDigest: createHash("sha256").update(`ls-files-failed:code=${indexFlags.cause}:${indexFlags.code}\x00${indexFlags.stderr.slice(-2048)}`).digest("hex") };
  }
  if (indexFlags.truncated) {
    return { sha, dirty: true, unobservable: true, dirtyDigest: createHash("sha256").update(`ls-files-truncated:${indexFlags.stdout.length}\x00${indexFlags.stderr.slice(-2048)}`).digest("hex") };
  }
  // `ls-files -v -z` records are "XY path" (X = flag letter); the bare
  // `??`/`M ` one-char-plus-space form of a clean checkout is tag `H`.
  const flagged: string[] = [];
  for (const rec of indexFlags.stdout.split("\0")) {
    if (rec === "") continue;
    const tag = rec[0] ?? "?";
    if (tag !== "H") flagged.push(`${tag}:${rec.slice(2)}`);
  }
  // W11-A3 (finding A-C3): `core.excludesFile=/dev/null` only disables
  // the GLOBAL excludes file — `$GIT_DIR/info/exclude` is always active
  // and lives INSIDE the tree a worker owns (probe: an entry there hid
  // a whole payload → clean identity). `git ls-files --others` applies
  // NO exclude sources unless asked (`--exclude-standard` or explicit
  // `--exclude*`), so it lists every untracked file regardless of
  // .gitignore/info/exclude. Anything it sees that porcelain did not is
  // HIDDEN dirt: fail closed, disclosing the hidden paths' digest.
  const othersAll = await runObservedGit(cwd, ["ls-files", "--others", "-z"], 10, { maxBytes });
  if (othersAll.code !== 0) {
    return { sha, dirty: true, unobservable: true, dirtyDigest: createHash("sha256").update(`ls-files-others-failed:code=${othersAll.cause}:${othersAll.code}\x00${othersAll.stderr.slice(-2048)}`).digest("hex") };
  }
  if (othersAll.truncated) {
    return { sha, dirty: true, unobservable: true, dirtyDigest: createHash("sha256").update(`ls-files-others-truncated:${othersAll.stdout.length}\x00${othersAll.stderr.slice(-2048)}`).digest("hex") };
  }
  const porcelainUntracked = new Set<string>();
  for (const rec of dirty.porcelain.split("\0")) {
    if (rec.startsWith("?? ")) porcelainUntracked.add(rec.slice(3));
  }
  const hidden: string[] = [];
  for (const rec of othersAll.stdout.split("\0")) {
    if (rec === "") continue;
    if (!porcelainUntracked.has(rec)) hidden.push(rec);
  }
  hidden.sort();
  if (hidden.length > 0) {
    // Hidden untracked content is DIRTY by definition — and the digest
    // binds the hidden files' PATHS *and* CONTENT (streamed), so two
    // different payloads under one hidden path never collide either.
    const hiddenContent = await untrackedDigestPart(cwd, hidden.map((h) => `?? ${h}`).join("\0") + "\0");
    return { sha, dirty: true, unobservable: true, dirtyDigest: createHash("sha256").update(`untracked-hidden:${String(hidden.length)}\x00${hidden.join("\n")}\x00${hiddenContent}`).digest("hex") };
  }
  // R5-B2 (round-5 audit, REGRESSION of the fresh-index port): the fresh
  // index compares HEAD against the WORKTREE, so a staged divergence whose
  // worktree file was restored to HEAD content is invisible in porcelain
  // (proven: index holds `XXXX`, worktree holds `base`, porcelain empty,
  // every ls-files tag `H` → two DISTINCT staged states both observed
  // byte-equal CLEAN, while the integration gate refuses exactly this
  // state at its post-gate staged check). "Clean" must mean the REAL
  // index matches HEAD too — the same command the gate uses, run on the
  // real index (no fresh envExtra) with --no-optional-locks so the check
  // itself never writes that index. Only needed on the clean branch:
  // every dirty path already binds staged CONTENT via write-tree below.
  // exit 0 = index==HEAD, 1 = index!=HEAD (fall through dirty), >=128 or
  // truncated = unreadable -> fail closed as dirt-we-cannot-see.
  if (flagged.length === 0 && dirty.porcelain.trim() === "") {
    const staged = await runObservedGit(cwd, ["--no-optional-locks", "diff-index", "--cached", "--quiet", "--ignore-submodules=none", "--no-ext-diff", "HEAD", "--"], 15, { maxBytes: 1024 * 1024 });
    if (staged.code !== 0 && staged.code !== 1) {
      return { sha, dirty: true, unobservable: true, dirtyDigest: createHash("sha256").update(`staged-check-failed:code=${staged.cause}:${staged.code}\x00${staged.stderr.slice(-2048)}`).digest("hex") };
    }
    if (staged.truncated) {
      return { sha, dirty: true, unobservable: true, dirtyDigest: createHash("sha256").update(`staged-check-truncated:${String(staged.stdout.length)}`).digest("hex") };
    }
    if (staged.code === 1) {
      // Staged divergence: DIRTY. Fall through — the digest below folds in
      // `write-tree` of the REAL index, so distinct staged states get
      // distinct digests and never collide with a clean {sha}.
    } else {
      // R6-B3 (round-6 audit): the parent's porcelain is BLIND to what a
      // submodule child hides in its OWN index — an `h`/`S` flag inside
      // the child, or staged divergence there, leaves the parent reading
      // byte-equal clean over real content delta (probe: `cd sub && git
      // update-index --assume-unchanged f; echo X > f` → parent clean).
      // A child we cannot fully observe is dirt-we-cannot-see: fail
      // closed with the discriminator, never {sha}.
      const subBlind = await submoduleBlindnessCheck(cwd);
      if (subBlind !== "") {
        return { sha, dirty: true, unobservable: true, dirtyDigest: createHash("sha256").update(`submodule-blind-clean:${subBlind}\x00${sha}`).digest("hex") };
      }
      return { sha };
    }
  }
  // Clean means clean: empty porcelain AND a flag-free index AND an
  // exclude-blind others list is the ONLY path that may stamp a tree
  // clean — every failure beyond this point yields dirty-unknown.
  // (With flags present we fall through: the digest below folds the
  // flag list in, so a flagged tree is dirty-unknown AND discriminating.)
  // W2-H1: the index is hashed as CONTENT via `git write-tree` — the
  // returned tree sha is git's own content-addressed digest of every
  // staged path/mode/blob, so `diff.noprefix`, `diff.mnemonicPrefix`,
  // `core.symlinks`, `diff.ignoreSubmodules` and friends can never bend
  // it (unlike any diff OUTPUT).
  const indexTree = await runObservedGit(cwd, ["write-tree"], 10, { maxBytes: 4096 });
  if (indexTree.code !== 0 || indexTree.stdout.trim() === "" || indexTree.truncated) {
    // fail closed: an index we cannot hash (unmerged entries, EACCES,
    // timeout) is dirt we cannot see.
    return { sha, dirty: true, unobservable: true, dirtyDigest: createHash("sha256").update(`write-tree-failed:${indexTree.cause}:${indexTree.code}\x00${indexTree.stderr.slice(-2048)}`).digest("hex") };
  }
  const indexPart = indexTree.stdout.trim();
  // W2-H1: the worktree delta's OUTPUT bytes are pinned against
  // hostile repo config — `noprefix`/`mnemonicPrefix` were PROVEN to
  // bend `git diff --binary` bytes (experiment: same content, hostile
  // config, different digest); explicit prefixes beat both. ext-diff/
  // textconv could rewrite content wholesale; -c pins hold the rest.
  // W6 (fix round for the W5 cap finding): the diff runs in STREAMING-
  // HASH mode — every byte is digested as it flows, at constant memory,
  // so the 64 MiB capture cap no longer applies to the diff AT ALL: a
  // tracked delta of any size is fully bound (no prefix, no truncation,
  // no size-only marker). The digest is withheld on a cut-short stream
  // (timeout/signal/spawn-error) — fail closed exactly like the old
  // W5-A1 marker, but WITHOUT losing coverage on large deltas.
  // W11-A4 (finding A-M1): clean/smudge filters convert worktree bytes
  // BEFORE diffing, so two different tampered contents routed through a
  // worker-authored filter collapsed to ONE digest (probe: filter
  // `clean=cat >/dev/null; echo CONSTANT` + a .gitattributes the worker
  // wrote). A wildcard `-c filter.*.clean=cat` does NOT defeat it (probe
  // on git 2.54: config wildcards lose to exact keys, so the repo's own
  // `filter.evil.clean` still won). The drivers can only be DEFINED in
  // the repo config (GIT_CONFIG_NOSYSTEM + a closed GIT_ENV kill the
  // other sources), so enumerate every defined driver and override each
  // EXACT key on the command line — `-c <key>=cat` re-sets the same key
  // with command-line precedence, and bare `cat` is the identity
  // conversion (stdin → stdout). `core.attributesFile=/dev/null` cuts
  // the ambient attributes file too (a tracked .gitattributes that
  // assigns a filter survives it, but its driver is now identity).
  // (git 2.54 has no `--no-conversion` flag on diff — probe-verified.)
  const filterPinArgs: string[] = ["-c", "core.attributesFile=/dev/null"];
  // MG-C5-A1 (round-2): the SAME conversion-neutralizing pins the
  // checkout/status observations carry ride the diff too — a gate-set
  // `core.autocrlf`/`core.eol`/`core.symlinks`/`core.ident` must not
  // bend the diff bytes relative to the staged identity.
  for (const [k, v] of PINNED_NEUTRALIZING_CONFIG) filterPinArgs.push("-c", `${k}=${v}`);
  // C2-F1 (p12c5 cycle-2 audit): `process` is enumerated too — it
  // REPLACES clean+smudge when set, so pinning only clean|smudge left a
  // process driver live under a supposedly neutralized observation.
  const filterDefs = await runObservedGit(cwd, ["config", "--get-regexp", "^filter\\..+\\.(clean|smudge|process)$"], 10, { maxBytes: 256 * 1024 });
  // git config --get-regexp exits 1 for "no matches" — that IS clean.
  if (filterDefs.code > 1 || filterDefs.truncated || (filterDefs.code !== 0 && !(filterDefs.code === 1 && filterDefs.stdout.trim() === ""))) {
    // fail closed: drivers we cannot enumerate may all be lying.
    return { sha, dirty: true, unobservable: true, dirtyDigest: createHash("sha256").update(`filter-enum-failed:code=${filterDefs.cause}:${filterDefs.code}\x00${filterDefs.stderr.slice(-2048)}`).digest("hex") };
  }
  for (const line of filterDefs.stdout.split("\n")) {
    // Key = everything before the LAST ".clean"/".smudge"/".process"
    // token (quoted subsection names may contain spaces; values follow
    // after it). C2-F1b: a `process` driver pins to the EMPTY value
    // (git's documented disable) — `=cat` would SPAWN cat as a filter
    // server whose handshake failure leaves `status` exiting 0 CLEAN
    // (false-clean oracle, probe git 2.54).
    const m = /^(filter\..+\.)(clean|smudge|process)(?=[ \t]|$)/.exec(line);
    if (m?.[1] !== undefined) filterPinArgs.push("-c", m[2] === "process" ? `${m[1]}${m[2]}=` : `${m[1]}${m[2]}=cat`);
  }
  const diff = await runObservedGit(cwd, ["-c", "diff.algorithm=myers", "-c", "diff.ignoreBlankLines=false", "-c", "core.autocrlf=false", ...filterPinArgs, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", "--default-prefix", "--src-prefix=a/", "--dst-prefix=b/", "HEAD"], 60, { hashStdout: true, envExtra: fresh.envExtra });
  // W5-A1 (superseded by W6): a truncated diff used to fail closed as a
  // prefix marker; now any missing digest (stream cut short) or a failed
  // diff fails closed the same way — never a partial stamp.
  const diffPart = diff.code !== 0 || diff.stdoutDigest === undefined
    ? `diff-failed:code=${diff.cause}:${diff.code}:${diff.stdoutDigest ?? "no-digest"}`
    : `sha256:${diff.stdoutDigest}`;
  // W3-A1: untracked content is FOLDED IN (audit finding: two different
  // contents under the same ?? path used to share one identity, so a gate
  // PASS stamped on it could be re-used against bytes it never measured).
  const untrackedPart = await untrackedDigestPart(cwd, dirty.porcelain);
  // W11-A1 (finding A-C1/A-C2): the diff and status are BOTH blind to
  // h/S-flagged entries, so the flagged files' ON-DISK bytes are digested
  // directly here (streamed via fileDigest): two different tampers under
  // one flag must move the identity, not collide on the flag list alone.
  const flaggedContent: string[] = [];
  for (const f of flagged) {
    const p = f.slice(f.indexOf(":") + 1);
    const d = await fileDigest(join(cwd, p));
    flaggedContent.push(`${f}=${d ?? "unreadable"}`);
  }
  // R6-B2 (round-6 audit): the parent's status/diff describe a submodule
  // child only in AGGREGATE — never its bytes — so two distinct child
  // content states (e.g. child HEAD unmoved, worktree edited and
  // reverted between observations while another channel went dirty)
  // could digest IDENTICALLY, letting a PASS stamped on one state
  // certify the other. Fold a deterministic raw walk of every populated
  // child (its HEAD sha + every entry's path/size/content, `.git`
  // skipped) into the digest: child bytes are now part of the identity.
  const gitlinks = await listGitlinks(cwd);
  let subPart = "";
  let subPartial = false;
  if (gitlinks.ok) {
    const r = await submoduleStatePart(cwd, gitlinks.paths);
    subPart = r.part;
    subPartial = r.partial;
  } else {
    subPart = `gitlink-enum-failed:${gitlinks.reason}`;
    subPartial = true;
  }
  // R3-F2 (audit round-3): PARTIAL measurement is unmeasured measurement.
  // A digest built with a failed diff, an unreadable untracked file, or an
  // unreadable flagged file binds everything it COULD read but silently
  // omits what it could not — two observations of trees differing ONLY in
  // the unmeasured part compare equal. Mark such identities `unobservable`
  // (sameArtifact then refuses them, including against themselves). A
  // fully-measured dirty tree (every source digested, just not clean)
  // stays comparable — the F2 dirty-delta semantics are preserved.
  const partialMeasurement =
    diffPart.startsWith("diff-failed:") ||
    untrackedPart.split("\n").some((l) => l.startsWith("unreadable:")) ||
    flaggedContent.some((f) => f.endsWith("=unreadable")) ||
    subPartial;
  return {
    sha,
    dirty: true,
    ...(partialMeasurement ? { unobservable: true as const } : {}),
    dirtyDigest: createHash("sha256").update(`porcelain-all\n${dirty.porcelain}\x00index-tree\n${indexPart}\x00diff-binary-head\n${diffPart}\x00untracked\n${untrackedPart}${flaggedContent.length > 0 ? `\x00index-flags\n${flaggedContent.sort().join("\n")}` : ""}${subPart !== "" ? `\x00submodule-state\n${subPart}` : ""}`).digest("hex"),
  };
  } finally {
    await rm(fresh.dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function collectAcceptanceEvidence(o: AcceptEvidenceOptions): Promise<EvaluateInput> {
  const task = o.graph.tasks.find((t) => t.id === o.taskId);
  const spec = acceptanceSpecFrom(task?.acceptance);
  const cwd = o.worktreePath ?? o.epPath;

  // 1. Current artifact identity: HEAD of the working tree (authoritative
  //    when git answers). Without a usable git tree the fallback identity
  //    is marked dirty-unknown (W1-C1): the episode dir is not the task's
  //    tree, so claiming "clean @ baseCommit" about it — with gate and
  //    artifact rows measured somewhere else entirely — was the critical
  //    mislabel this closes. The digest labels WHY there is no identity:
  //    "episode-dir" = no worktree was given at all; "worktree-unobservable"
  //    = a worktree was given but git could not answer for it (not a repo,
  //    git missing, etc.) — never "given", which read like a reason.
  let current: ArtifactIdentity = { sha: o.graph.policy?.baseCommit ?? "", dirty: true, unobservable: true, dirtyDigest: createHash("sha256").update(`no-worktree:fallback=${o.worktreePath === undefined ? "episode-dir" : "worktree-unobservable"}`).digest("hex") };
  const head = await runShell("git rev-parse HEAD", cwd, 10, { env: GIT_ENV });
  const preIdentity: ArtifactIdentity = head.code === 0 && head.stdout.trim() !== ""
    ? await observeIdentity(cwd, head.stdout.trim())
    : current;

  const gates: GateResult[] = [];
  const artifacts: ArtifactEvidence[] = [];
  const claims: EvaluateInput["claims"] = [];
  const blockers: EvaluateInput["blockers"] = [];

  // 2. Policy gate — the ONE deterministic check the host can run itself
  //    (docs/18 §0.1: the host adds no policy; the gate command is the
  //    graph's grant). Evidence: the appended run record.
  //    W1-M3: timeoutS is VALIDATED (a NaN/huge value fired setTimeout
  //    immediately or overflowed); exec runs with a MINIMAL env (no
  //    inherited secrets) in the task's tree, and the unscored-ness of
  //    host gate exec is disclosed in the evidence line itself.
  const gateCmd = o.graph.policy?.gate?.cmd;
  const rawTimeout = o.graph.policy?.gate?.timeoutS;
  const gateTimeoutS = typeof rawTimeout === "number" && Number.isSafeInteger(rawTimeout) && rawTimeout >= 1 && rawTimeout <= 3600 ? rawTimeout : 120;
  // The identity the gate was actually RUN at, and (W1-M4) the identity
  // AFTER the gate — a mutating gate (e.g. `make dist`) must not have
  // its PASS stamped on the post-mutation tree, and post-gate artifact
  // digests must be stamped on the tree they were measured on.
  let gateRanAt = preIdentity;
  let postGate = preIdentity;
  if (typeof gateCmd === "string" && gateCmd.trim() !== "") {
    // W2-M5: the gate runs under the SAME minimal env (GIT_ENV) as the
    // identity observation — one env for every tree-touching command, so
    // a PASS measured by the gate and the identity stamped under it
    // cannot come from two different gits.
    const r = await runShell(gateCmd, cwd, gateTimeoutS, { env: GIT_ENV });
    const post = await runShell("git rev-parse HEAD", cwd, 10, { env: GIT_ENV });
    postGate = post.code === 0 && post.stdout.trim() !== "" ? await observeIdentity(cwd, post.stdout.trim()) : preIdentity;
    const changed = gateRanAt.sha !== postGate.sha || (gateRanAt.dirtyDigest ?? "") !== (postGate.dirtyDigest ?? "");
    const ref = await appendEvidence(o.epPath, gateRanAt.sha, `gate ${JSON.stringify(gateCmd)} exit=${r.cause === "exit" ? r.code : r.cause}${changed ? " [identity-changed-post-gate]" : ""}\n${r.stdout.slice(-2048)}\n${r.stderr.slice(-2048)}`);
    gates.push({ gateId: "policy-gate", pass: r.code === 0, at: gateRanAt, evidenceRef: ref });
  }
  // requiredChecks the host did not itself run have no current PASS —
  // reported as failed with an explicit ref so the evaluator's verdict
  // stays honest (the loop's executor records real check receipts; the
  // host cannot mint them).
  for (const check of spec.requiredChecks) {
    if (check === "policy-gate") continue;
    const ref = await appendEvidence(o.epPath, postGate.sha, `requiredCheck '${check}': no host-run receipt`);
    gates.push({ gateId: check, pass: false, at: postGate, evidenceRef: ref });
  }

  // 3. Artifact observation: exists + content digest (EV4 requires the
  //    digest as the exists-true proof; IO failure → unknown, never true).
  //    W1-M4: digests are taken AFTER the gate and stamped with the
  //    POST-gate identity — the tree they were measured on.
  //    W11-A5 (audit cycle P16, finding A-C4): spec.artifacts is
  //    graph-authored data, and an absolute or `../` path made
  //    `resolve(cwd, p)` mint an exists:true + digest PROOF for a file
  //    OUTSIDE the task's tree — probe A05/A06: a literal no-op worker
  //    declaring one pre-existing absolute file got `accepted-finish`
  //    with the artifact row as the sole structural constraint. Artifact
  //    paths are now CONFINED to the observed tree twice over: lexically
  //    (resolve must stay under the tree root) and by realpath (a symlink
  //    inside the tree pointing out is rejected — the digest must bind
  //    bytes that live in the tree the identity describes). A violating
  //    declaration is journalled as a REJECTED evidence line and yields
  //    exists:false — never a digest.
  const current2 = postGate;
  const rootAbs = resolve(cwd);
  let rootReal = rootAbs;
  try { rootReal = await realpath(rootAbs); } catch { /* tree vanished: digest path fails closed below */ }
  for (const p of spec.artifacts) {
    const full = resolve(rootAbs, p);
    const lexInside = full === rootAbs || full.startsWith(rootAbs + sep);
    let realInside = lexInside;
    if (lexInside) {
      try {
        const real = await realpath(full);
        realInside = real === rootReal || real.startsWith(rootReal + sep);
      } catch { /* ENOENT etc: fileDigest reports the honest exists:false */ }
    }
    if (!lexInside || !realInside) {
      const ref = await appendEvidence(o.epPath, current2.sha, `artifact '${p}': REJECTED — path escapes the observed tree (exists:false, no digest proof)`);
      artifacts.push({ path: p, exists: false, at: current2, evidenceRef: ref });
      continue;
    }
    const digest = await fileDigest(full);
    const ref = await appendEvidence(o.epPath, current2.sha, `artifact '${p}': ${digest !== undefined ? `exists digest=${digest.slice(0, 12)}` : "unreadable"}`);
    if (digest !== undefined) {
      artifacts.push({ path: p, exists: true, digest, at: current2, evidenceRef: ref });
    } else {
      artifacts.push({ path: p, exists: false, at: current2, evidenceRef: ref });
    }
  }

  // 4. No host-side blockers are asserted: worker authority denials and
  //    budget exhaustions are ledger/planner facts the loop already
  //    routes; inventing blockers here would fabricate blocked verdicts.
  return {
    taskId: o.taskId,
    taskRevision: task?.revision ?? 1,
    current: current2,
    spec,
    gates,
    artifacts,
    claims,
    blockers,
    now: now(),
  };
}

/** Build the P8 GatePolicy from the graph's episode policy (docs/12 §1).
 *  The graph is the authority grant; caps flow through verbatim. */
export function gatePolicyFromGraph(graph: EpisodeGraph, episodePath: string): GatePolicy {
  const authority = graph.policy?.authority;
  const rb = graph.policy?.recoveryBudget;
  return {
    episodeId: graph.episodeId,
    caps: {},
    ...(authority !== undefined
      ? {
          authority: {
            root: episodePath,
            paths: [...(authority.paths ?? [])],
            notPaths: [...(authority.notPaths ?? [])],
            ...(authority.allowInstalls !== undefined ? { allowInstalls: authority.allowInstalls } : {}),
            ...(authority.allowNetwork !== undefined ? { allowNetwork: authority.allowNetwork } : {}),
            ...(authority.models !== undefined ? { approvedModels: [...authority.models] } : {}),
            ...(authority.diagnostics !== undefined ? { diagnostics: { ...authority.diagnostics } } : {}),
          },
        }
      : {}),
    allowExternalEffects: authority?.allowExternalEffects === true,
    ...(rb?.maxAttemptsPerTask !== undefined ? { maxAttemptsPerTask: rb.maxAttemptsPerTask } : {}),
    ...(rb?.maxStrategyRepeats !== undefined ? { maxStrategyRepeats: rb.maxStrategyRepeats } : {}),
  };
}

function toLedgerRequest(req: GateRequestLike, taskIdDefault: string): LedgerGateRequest {
  const action = req.action === "resume" ? "resume" : "run"; // ledger gates only spawn classes
  const r = req as GateRequestLike & { paths?: string[]; install?: boolean; network?: boolean; toolCalls?: number; estimate?: { usd?: number; turns?: number } };
  return {
    action,
    actionId: req.actionId,
    ...(req.taskId !== undefined ? { taskId: req.taskId } : { taskId: taskIdDefault }),
    ...(req.attemptId !== undefined ? { attemptId: req.attemptId } : {}),
    authority: { grantedBy: req.authority.grantedBy, sideEffect: req.authority.sideEffect },
    ...(req.model !== undefined ? { model: req.model } : {}),
    ...(req.strategyId !== undefined ? { strategyId: req.strategyId } : {}),
    // W1-M5 support: the FULL §14.7 surface flows into BOTH check and
    // reserve (the same frozen object — see the executorGate cache), so
    // path authority is actually enforced at admission and the receipt's
    // field-by-field binding always has the fields to bind.
    ...(Array.isArray(r.paths) ? { paths: [...r.paths] } : {}),
    ...(r.install === true ? { install: true } : {}),
    ...(r.network === true ? { network: true } : {}),
    ...(typeof r.toolCalls === "number" ? { toolCalls: r.toolCalls } : {}),
    ...(r.estimate !== undefined && typeof r.estimate === "object" ? { estimate: { ...r.estimate } } : {}),
  };
}

// ─── The host ──────────────────────────────────────────────────────────────

/** Wire the real singletons for ONE task in ONE episode and run the
 *  closed recovery loop (docs/18 §1). Never throws for a recoverable
 *  cause — the loop itself never re-throws; host setup failures (bad
 *  graph, unreadable episode) do throw, before any loop state exists. */
const ACTIVE_RECLAIM_PATHS = new Set<string>();
const ACTIVE_STAGE_PATHS = new Set<string>();
/** Canonical same-episode key across caller spellings of the same directory.
 *  Protection sets above recognize one process's own live swap across
 *  separate runHostEpisode invocations, so every invocation must derive the
 *  SAME key for the same directory. The directory is created first (takeLease
 *  creates it anyway) so realpath always has a target; if the canonical path
 *  cannot be established the activation fails closed. No fallback key is
 *  used: a fallback could differ from a later successful realpath and split
 *  the in-process protection identity. */
const epPathIdentity = async (epPath: string): Promise<string> => {
  try {
    await mkdir(epPath, { recursive: true });
    return await realpath(epPath);
  } catch (e) {
    throw new Error(`host: cannot establish a canonical identity for ${epPath} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); refusing activation until the episode directory is resolvable`);
  }
};

/**
 * P9/M2 carve (mechanical, behavior-identical): the episode-lease
 * acquisition block extracted VERBATIM from runHostEpisode (the P18-A4
 * "one supervisor per episode" claim + every audit-cycle refinement up
 * through P20c11 — all findings and repro notes travel with the code).
 * Claims `host.lease` under `host.lease.lock`, refuses a live holder,
 * reclaims a dead one with disclosure, and returns an ownership handle:
 *   token   — the per-activation ownership identity (intentScope);
 *   path    — the lease file path (for release-failure disclosure);
 *   held()  — whether OUR claim is currently established;
 *   release — the strict, token-verified, RETRIED release (P20c6-F2).
 * All former closure variables (epPath, epId, episodeId, log,
 * leaseSwapHoldMs) are parameters; nothing else changed. See docs/20 §2
 * ("one supervisor per episode" — the scheduler holds THE lease).
 */
async function acquireEpisodeLease(args: {
  epPath: string;
  epId: string;
  episodeId: string;
  log: (line: string) => void;
  leaseSwapHoldMs?: number;
}): Promise<{ token: string; path: string; held: () => boolean; release: () => Promise<"released" | "absent" | "failed"> }> {
  const { epPath, epId, episodeId, log } = args;
  // P18-A4 (sol audit cycle 1, the "enforce the exclusion" half): ONE
  // supervisor per episode. The channel's dedup/cap machinery assumes a
  // serialized durable domain; two live `runHostEpisode` instances on one
  // episode (the A3/A4 repros) break that. Claim an exclusive lease file
  // BEFORE any mutation: a stale lease (holder pid dead) is taken over
  // with a disclosure; a live holder refuses this activation up front —
  // before graph, ledger, or runner are touched. This is ownership, not
  // policy: no decision content, only "who may run this episode".
  //
  // P18-C3 (audit cycle 2, finding 2): recovery is SERIALIZED, not
  // optimistic. Read-then-rename is NOT compare-and-swap — two contenders
  // that both observed the same stale bytes could both swap the lease in
  // and both enter protected setup (reproduced: barrier-synchronized
  // takeover, 2 swaps). Stale-checks now run under an `mkdir` lock
  // (atomic on every POSIX filesystem, unlike any lease-file operation),
  // staleness is RE-VERIFIED under the lock, an empty/partial lease is
  // treated as a creation IN PROGRESS (retried, never claimed), and an
  // abandoned lock is only stolen after an age bound. Release requires an
  // OWNERSHIP TOKEN (per-run, written into the body) — a pid alone could
  // delete a lease re-planted by a recycled pid.
  //
  // P19-F1 (follow-up audit of bda9d1f, finding 1): `writeFile(wx)` makes
  // the CREATE atomic but NOT the write that follows it — a reader could
  // observe a partial body (`{`), parse no pid, deem the lease stale, and
  // TAKE OVER from a live creator (reproduced: pause the original writer
  // after `{`, second activation takes over while the first still runs).
  // Every lease publication now goes through stage+link: the full body is
  // written and fsynced into a sibling tmp, then `link()` publishes it —
  // a reader sees either the COMPLETE claim or nothing, and a link never
  // replaces an existing lease (EEXIST = contention). Unparseable fresh
  // content (only producible by a legacy/foreign writer under this
  // protocol) is AMBIGUOUS, never proven-dead: it is takeover-eligible
  // only past the same mtime abandon bound as the empty case.
  const leasePath = join(epPath, "host.lease");
  const leaseLockPath = join(epPath, "host.lease.lock");
  const leaseToken = `${process.pid}.${Math.random().toString(36).slice(2, 12)}.${Date.now().toString(36)}`;
  // P20c8-F3 (R5 audit): pid EQUALS ownership only within one process
  // INCARNATION. The OS recycles pids, so an artifact whose mtime PREDATES
  // this activation cannot be ours — it belongs to a long-dead namesake.
  // NOTE: procStartMs is this ACTIVATION's start (runHostEpisode may run
  // several times in one process), not the OS process start. It drives
  // the STAGED-TMP incarnation rule in the sweep below (a pre-start
  // same-pid tmp is a dead namesake's stage; disk mtimes vs a wall-clock
  // start carry the disclosed clock-skew residual — bounded, and the
  // claim body itself is still pid+token judged at every acquisition).
  // It is NOT used for `.reclaim-` artifacts: a rename preserves the
  // SOURCE lease's old mtime, so an in-flight moved-aside claim cannot be
  // classified from its timestamp. Reclaim ownership is instead the
  // in-memory set below, keyed by canonical episode identity + basename
  // (added before the move, removed when the swap completes), so a live
  // swap is recognized whatever mtime its artifact inherited — and
  // equivalent path spellings of the same episode share the key.
  const procStartMs = Date.now();
  const activeReclaims = ACTIVE_RECLAIM_PATHS;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const pidAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
  };
  // P20-F2 (re-audit of 58c588f, finding 2): the OLD extractor regex-scanned
  // for `"pid":<digits>` anywhere in the bytes — an INCOMPLETE body like
  // `{"pid":2147483647` (truncated JSON, unparseable) yielded a pid and
  // bypassed every ambiguity guard, taking over immediately (reproduced:
  // 245ms, not the 10s abandon bound). A pid is only trustworthy when the
  // WHOLE claim parses as a JSON object with a positive safe-integer pid;
  // anything else is AMBIGUOUS content, not a holder.
  const leasePidOf = (raw: string): number | undefined => {
    let v: unknown;
    try { v = JSON.parse(raw); } catch { return undefined; }
    if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
    const pid = (v as { pid?: unknown }).pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
    return pid;
  };
  // MISSING (ENOENT) is not EMPTY: an absent lease is claimable on the
  // next loop (a holder that just released), while an empty-but-present
  // file is a creation IN PROGRESS and must never be claimed blind.
  // P20c11-F1 (R6 audit): an UNREADABLE lease is neither missing nor
  // empty — pre-P20c11 a non-ENOENT read error returned raw:"" , and an
  // aged (past ABANDON_AFTER) lease carrying a LIVE claim was then
  // classified abandoned-empty and taken over (reproduced: a live
  // holder's claim displaced and a second worker admitted while the
  // first ran). New contract: retry a transient failure a bounded 3x
  // (parity with releaseOursClaim); a persistent non-ENOENT error
  // THROWS — ownership that cannot be read is ownership that cannot be
  // judged, so the activation fails closed and the claim on disk is
  // left exactly as found.
  const readLease = async (): Promise<{ missing: boolean; raw: string }> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return { missing: false, raw: await readFile(leasePath, "utf8") }; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return { missing: true, raw: "" };
        if (attempt === 2) {
          throw new Error(`host: cannot read the lease at ${leasePath} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}) — ownership is unreadable, refusing activation rather than guessing (P20c11-F1)`);
        }
        await sleep(50); // P20c11 audit: backoff — three BACK-TO-BACK syscalls clear only an instantaneous error; 50ms spans a millisecond-scale transient (parity with the takeover loop's 25ms poll)
      }
    }
    throw new Error("unreachable: the readLease retry bound always returns or throws");
  };
  // P18-C3 F2 (sol audit cycle 3): an empty-but-present lease is a
  // creation IN PROGRESS — never claimable — UNLESS its mtime proves the
  // creator died before its first write. A write follows the create in
  // microseconds; 10s past mtime with still-zero bytes cannot be a live
  // writer on any sane scheduler. This bounds crash recovery (a creator
  // killed mid-init) without ever racing a live one.
  const ABANDON_AFTER_MS = 10_000;
  const leaseAbandoned = async (): Promise<boolean> => {
    try { const st = await stat(leasePath); return Date.now() - st.mtimeMs > ABANDON_AFTER_MS; }
    catch { return false; } // vanished (or unreadable): let the next read decide
  };
  let leaseHeld = false;
  // Strict lease-body ownership: the WHOLE body parses as an object whose
  // TOP-LEVEL token equals ours. Substring membership is NOT ownership
  // (P20c4-F3: {pid:1,token:"foreign",previous:{token:ours}} embeds ours
  // but belongs to the foreign writer — reproduced passing an includes()).
  const leaseBodyIsOurs = (raw: string): boolean => {
    try {
      const v: unknown = JSON.parse(raw);
      return v !== null && typeof v === "object" && !Array.isArray(v)
        && (v as { token?: unknown }).token === leaseToken;
    } catch { return false; }
  };
  // P20c6-F2 (R4 audit, finding 2): ONE release primitive for every path
  // that drops OUR claim, with DISTINCT, RETRIED outcomes. Pre-P20c6 the
  // takeover anomaly self-release and the outer-finally release each made
  // a SINGLE read + SINGLE unlink wrapped in one swallow-everything
  // catch: one transient EIO on either read (the identity check AND the
  // self-release re-read — reproduced CLEANUP_READ_EIO) or on the unlink
  // (reproduced CLEANUP_UNLINK_EIO) abandoned the release, and the outer
  // finally never re-considered it because `leaseHeld` was still false —
  // the episode kept a lease naming our LIVE pid until process exit.
  // New contract:
  //  - "released"   — our claim was there and is gone;
  //  - "absent"     — nothing to release (ENOENT / a holder already
  //                   released it); treated as done, never an error;
  //  - "failed"     — STILL OURS after the retry bound (a persistent
  //                   read/unlink error). The caller MUST disclose it:
  //                   it is a live-pid lease owned by this process, not
  //                   a silent no-op.
  // A transient error burns a retry (three bounded attempts — retries
  // beat a wedge; a claim we cannot prove ours is never touched, so the
  // P20c3-F3 foreign-lease rule stands unchanged).
  type LeaseReleaseOutcome = "released" | "absent" | "failed";
  const releaseOursClaim = async (): Promise<LeaseReleaseOutcome> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      let raw: string;
      try {
        raw = await readFile(leasePath, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent"; // vanished: nothing to release
        continue; // P20c6-F2: transient read error — retry (reproduced CLEANUP_READ_EIO)
      }
      if (!leaseBodyIsOurs(raw)) return "absent"; // not ours (replacement owner / embed) — never touched (P20c3-F3)
      try {
        await unlink(leasePath);
        return "released";
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent"; // raced a release: fine
        // P20c6-F2: transient unlink error — retry while the claim is still ours.
      }
    }
    // exhausted: the claim may still be ours on disk — caller must disclose, not swallow.
    return "failed";
  };
  const refuseSameProcess = (): never => {
    throw new Error(`host: episode ${episodeId} is already activated in this process (lease: ${leasePath}) — refusing a concurrent activation (P18-A4)`);
  };
  const refuseLive = (pid: number): never => {
    throw new Error(`host: episode ${episodeId} is already activated by pid ${pid} (lease: ${leasePath}) — refusing a concurrent activation (P18-A4)`);
  };
  const takeLease = async (): Promise<void> => {
    await mkdir(epPath, { recursive: true });
    const body = JSON.stringify({ pid: process.pid, token: leaseToken, episodeId: episodeId, claimedAt: Date.now() });
    // P19-F1: publish = stage a COMPLETE body (write + fsync), then
    // link() it into place. A concurrent reader never sees a partial
    // claim; link() is no-replace, so two racing creators get exactly
    // one winner (the loser sees EEXIST = contention).
    // The staged publish as a helper (shared by the lease and the lock):
    // full body written + fsynced into a unique tmp, then link()ed into
    // place (no-replace). P20-F3 (re-audit of 58c588f, finding 3): a
    // LIVE-but-paused publisher's staged tmp can age past any time bound
    // (SIGSTOP, fs stall), and a sweeper that judges on age alone unlinks
    // it under us — the resumed publisher died at link() with ENOENT
    // (reproduced). A vanished staging tmp is therefore a RETRY, not a
    // crash: relink once from a fresh stage. EEXIST is contention either
    // way; a second ENOENT (something is racing us aggressively) is
    // surfaced, not looped on.
    const stagedPublish = async (target: string, suffix: string): Promise<boolean> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const tmp = `${target}.tmp-${process.pid}.${leaseToken}${suffix}${attempt === 0 ? "" : `.${attempt}`}`;
        const protection = `${epId}:${basename(tmp)}`;
        ACTIVE_STAGE_PATHS.add(protection);
        try {
          const handle = await open(tmp, "wx", 0o644);
          try {
            await handle.writeFile(body + "\n", "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
          try {
            await link(tmp, target);
            return true;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
            if ((e as NodeJS.ErrnoException).code === "ENOENT" && attempt === 0) continue; // P20-F3: our stage was removed mid-publish — retry from fresh
            throw e;
          }
        } finally {
          ACTIVE_STAGE_PATHS.delete(protection);
          await unlink(tmp).catch(() => {});
        }
      }
      return false;
    };
    // P20c6-F1 (R4 audit, finding 1): the takeover lock is the single
    // serialization point for every decision about an EXISTING lease, so
    // a fresh EXCLUSIVE publish must yield while it exists. Pre-P20c6 the
    // fast path link()ed a claim against an absent lease even when a
    // recovery was mid-takeover (its swap had removed/replaced the lease
    // view): the reproduced OVERLAPPING_WORKERS schedule admitted a second
    // worker while the first was still running. EEXIST semantics already
    // race only another CREATE; the lock check adds "never ahead of a
    // recovery". An UNREADABLE lock dir is treated as existing (fail
    // closed). The takeover path passes underLock=true: it already holds
    // (and stamped) the lock, so it must not self-block.
    const takeoverLockActive = async (): Promise<boolean> => {
      try { await stat(leaseLockPath); return true; }
      catch (e) { return (e as NodeJS.ErrnoException).code !== "ENOENT"; }
    };
    const publishLease = async (underLock = false): Promise<boolean> => {
      if (!underLock && (await takeoverLockActive())) return false;
      return stagedPublish(leasePath, "");
    };
    // Takeover replacement UNDER the takeover lock (P18-C3 serialization
    // preserved): stage the full body (write + fsync) beside the lease,
    // move the stale claim aside, then link our complete body with
    // no-replace. Readers see complete claims or the brief disclosed gap;
    // a reader never sees a partial body.
    // P20-F1 belt: re-verify after the swap that the lease is still OURS —
    // a claim replaced under us mid-swap makes us walk away rather than
    // proceed believing we hold the episode.
    const replaceLeaseUnderLock = async (): Promise<void> => {
      const tmp = `${leasePath}.tmp-${process.pid}.${leaseToken}.takeover`;
      const gone = `${leasePath}.reclaim-${process.pid}.${leaseToken}`;
      const protection = `${epId}:${basename(gone)}`;
      activeReclaims.add(protection); // publish in-memory protection before staging/rename
      ACTIVE_STAGE_PATHS.add(`${epId}:${basename(tmp)}`);
      try {
        const handle = await open(tmp, "wx", 0o644);
        try {
          await handle.writeFile(body + "\n", "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        // P20c6-F1 (R4 audit, finding 1 — reproduced OVERLAPPING_WORKERS):
        // the swap is NO LONGER a blind rename over the lease. A blind
        // overwrite destroyed a live claim installed mid-swap by a lock
        // thief, and the P20c4 self-release then removed the replaced
        // lease — leaving the episode lease-less (absent) while the
        // thief's worker still ran, so a third process fast-pathed a
        // SECOND concurrent activation. New conditional swap:
        //  1. MOVE the fenced claim aside (rename lease -> .reclaim-*).
        //     ENOENT here = the lease was released under us: claim
        //     exclusive with a no-replace link instead.
        //  2. link() our staged claim in (no-replace): EEXIST means a
        //     rival re-presented the lease mid-swap — an ANOMALY, never
        //     an overwrite.
        //  3. On ANY anomaly after the move (a failed/errored claim-link
        //     or a failed post-swap admission): drop our claim (strict,
        //     retried — P20c6-F2), then link the moved-aside ORIGINAL
        //     back iff the lease is absent (hardlink preserves the old
        //     inode's mtime, so recovery eligibility survives). The
        //     lease never stays absent or ours when we walk away — the
        //     concurrent-activation window closes. A restore that fails
        //     persistently is SURFACED (a lease we moved away must never
        //     vanish silently); an original that was foreign or vanished
        //     is disclosed via `movedBody` for an honest error message.
        // DISCLOSED: steps 1-2 leave a microsecond absence window; it is
        // fenced for fresh creators by the lock-aware publishLease above
        // (this path holds the takeover lock across the swap). The CRASH
        // cost of the window is disclosed: a mover killed between the
        // move and its claim-link leaves the lease ABSENT with the lock
        // stamping its pid. Once that pid is DEAD the next creator's
        // reconcileReclaims links the `.reclaim-` original back
        // (restore-if-vacant, P20c7-F1/F2) and service self-heals
        // immediately — no wait for the steal bound. A mover ALIVE but
        // frozen mid-swap keeps fresh creators fail-closed ("contended",
        // bounded by the 30s steal bound) while its workspace survives
        // untouched. Availability-only, self-healing; the pre-P20c6
        // blind rename had no absence window but destroyed live
        // mid-swap claims (the reproduced OVERLAPPING_WORKERS) — a
        // correctness failure, strictly worse.
        const gone = `${leasePath}.reclaim-${process.pid}.${leaseToken}`;
        // P20c7-F1, hardened by P20c8-F4 (R5 audit): RE-VERIFY under the
        // lock, immediately before the move, that the lease holds no
        // LIVE claim — INCLUDING one naming THIS process. The eligibility
        // decision above was made before mkdir-raced rivals resolved; a
        // rival that re-admitted its LIVE claim in between must not have
        // it moved out from under it (the reproduced OVERLAPPING_WORKERS
        // destroyed exactly such a claim). P20c8: the pre-P20c8 version
        // skipped `prePid === process.pid`, but a second invocation of
        // THIS process takes over via the disclosed delayed-lock-removal
        // race and gets ADMITTED between our eligibility read and this
        // re-verify — its live claim moved aside anyway violated INV-B
        // before any check→act window. A live-pid holder is refused
        // regardless of whose pid it is (a same-pid body with a foreign
        // token is pid REUSE onto us: refuse that too; the F3 incarnation
        // rule never mistakes it for our own claim). This is a check→act
        // narrowing, NOT a fence: a rival frozen between THIS read and
        // the rename still gets its claim moved — the residual is the
        // disclosed P20c3-F1 class (no atomic compare-and-swap primitive
        // exists), and reconcileReclaims restores the moved copy if we
        // die before the relink.
        {
          const pre = await readLease();
          if (!pre.missing) {
            const prePid = leasePidOf(pre.raw);
            if (prePid !== undefined && pidAlive(prePid)) {
              throw new Error(`host: takeover claim on ${leasePath} refused pre-move re-verify (a live pid ${prePid} holds the lease — eligibility was disproved under the lock; P20c7-F1/P20c8-F4)`);
            }
          }
        }
        let movedAside = false;
        try {
          await rename(leasePath, gone);
          movedAside = true;
        } catch (e) {
          activeReclaims.delete(protection);
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          // Released under us (nothing to move): claim exclusive below.
        }
        // Shared anomaly exit: self-release our claim, restore the
        // moved-aside original iff the lease is absent, then throw. The
        // message names the TRUE outcome of each step (P20c6-F2,
        // refined by P20c7-F3/F4) — "released"/"absent"/"failed",
        // "restored"/"occupied by a live claim (pid N)"/"occupied by a
        // stale claim"/"vanished"/"restore failed (…)" /"not-moved" —
        // never a blanket claim that may not hold.
        // The restore is a NO-REPLACE link of exactly what we moved (a
        // replacement owner's live lease is never overwritten: EEXIST
        // means the lease path holds a claim and we leave it alone), so
        // it is a true undo of our move whatever body it carries.
        // P20c7-F3: `gone` is unlinked ONLY once it is provably garbage
        // (the restore linked it back, the occupant outranks it, or it
        // vanished). A FAILED restore keeps it: `gone` is the sole
        // recovery source and the pid-aware reconcile re-links it after
        // we exit.
        const anomaly = async (why: string): Promise<never> => {
          const release = await releaseOursClaim();
          let restore: string;
          let goneIsGarbage: boolean;
          if (!movedAside) {
            restore = "not-moved"; // nothing was moved aside; nothing to restore
            goneIsGarbage = false; // the gone name was never created
          } else {
            try {
              await link(gone, leasePath); // no-replace: EEXIST = the lease path holds a claim now
              restore = "restored";
              goneIsGarbage = true;
            } catch (e) {
              const code = (e as NodeJS.ErrnoException).code;
              if (code === "EEXIST") {
                // P20c7-F4, refined by P20c8-F5 (R5 audit, MEDIUM): the
                // occupant is classified ONLY from what this observation
                // proves. Pre-P20c8, malformed nonempty content was
                // reported as definitively "stale" (the protocol treats
                // it as AMBIGUOUS elsewhere) and an ENOENT on the
                // occupant read — the path is ABSENT now — was reported
                // as "occupied". `gone` is deleted only on outcomes that
                // prove a superseding state (restored, or an occupant
                // observed present); an occupant that vanished or is
                // unreadable keeps the source for reconcile, which
                // re-judges it against the lease path then.
                let occ: string | undefined;
                let occErr: string | undefined;
                try { occ = await readFile(leasePath, "utf8"); }
                catch (oe) { occErr = (oe as NodeJS.ErrnoException).code ?? "error"; }
                if (occ === undefined) {
                  restore = occErr === "ENOENT"
                    ? "the occupant vanished after EEXIST (lease path absent at observation) — recovery source preserved"
                    : `occupant unreadable (${occErr}) — recovery source preserved`;
                  goneIsGarbage = false;
                } else {
                  const occPid = leasePidOf(occ);
                  if (occPid !== undefined) {
                    restore = pidAlive(occPid)
                      ? `occupied by a live claim (pid ${occPid})`
                      : `occupied by a stale claim (dead pid ${occPid})`;
                  } else if (occ === "") {
                    restore = "occupied by an empty partial claim (a writer mid-create)";
                  } else {
                    restore = "occupied by ambiguous content (no trustworthy pid)";
                  }
                  goneIsGarbage = true; // the occupant was OBSERVED present — it outranks the moved copy
                }
              } else if (code === "ENOENT") {
                restore = "vanished"; // the moved original was removed under us
                goneIsGarbage = true; // the name is already gone; unlink is a no-op
              } else {
                restore = `restore failed (${code ?? (e as Error).message}) — recovery source preserved for reconcile`;
                goneIsGarbage = false;
              }
            }
          }
          // `gone` is garbage ONLY when a superseding state was PROVEN
          // (the restore linked the same inode back, or an occupant was
          // observed at the lease path) or it vanished. A FAILED or
          // UNPROVEN restore keeps it: it is the recovery source
          // (P20c7-F3, P20c8-F5).
          if (goneIsGarbage) await unlink(gone).catch(() => {});
          throw new Error(`host: takeover claim on ${leasePath} anomaly (${why}) — self-release ${release}, moved-aside original ${restore} (P20c6-F1/F2, P20c7-F3/F4, P20c8-F5)`);
        };
        try {
          await link(tmp, leasePath);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EEXIST") {
            // A rival re-presented the lease mid-swap: not ours to touch
            // or restore over; drop our staged claim and walk away.
            await unlink(gone).catch(() => {}); // not ours to restore over a live lease
            throw new Error(`host: takeover claim on ${leasePath} was replaced mid-swap (a rival re-presented the lease before our no-replace link landed) — refusing to proceed (P20c6-F1)`);
          }
          await anomaly(`claim link failed (${code ?? (e as Error).message})`);
        }
        // P20c3-F1 (audit cycle 2, finding 1): the post-swap READ is a
        // TOCTOU, not a fence — a contender frozen between its lock rmdir
        // and the swap passes every read-based check on its own fresh
        // bytes, and the delayed reclaim double-admits. A read-only fence
        // CANNOT exist: a process that destroys our lock and publishes a
        // fresh lease is indistinguishable (from our side) from the lease
        // being legitimately released and re-created. So the fence is a
        // TIME one: the takeover lock is held for leaseSwapHoldMs AFTER
        // the swap completes (default 0 = pre-P20c3 behavior). Any
        // contender that reclaimed the lock before our swap observes the
        // lock's fresh mtime (bumping its 30s steal bound) or times out
        // and re-observes our live lease. This closes the reproduced
        // delayed-reclaim double-admission; it is a deployment-chosen
        // bound, not a mathematical impossibility result.
        const swapHoldMs = args.leaseSwapHoldMs ?? 0;
        if (swapHoldMs > 0) await sleep(swapHoldMs);
        // Post-swap verification, REWRITTEN after the cycle-4 audit.
        // The cycle-3 version THREW on a lost/vanished stamp — (a) with
        // our just-renamed claim still on disk, never marked held, never
        // released: the reproduced walkaway-wedge left OUR live-pid lease
        // until this process exits; (b) a TRANSIENT stamp-read error was
        // reported as "vanished" and wedged the episode even with no
        // contender (reproduced POST_SWAP_EIO_WEDGE); and (c) the claim
        // identity test was includes(token) — a foreign body merely
        // EMBEDDING ours passed (reproduced POST_SWAP_EMBED).
        // New contract:
        //  - claim STRICTLY ours (whole body parses, top-level token ===
        //    ours) AND stamp ours (or its read errored — an error cannot
        //    disprove the lock we won) -> proceed;
        //  - ANY anomaly -> first ensure we leave NO claim naming our
        //    live pid: release-if-strictly-ours (a replacement owner's
        //    lease is never touched), then throw. A failed takeover can
        //    no longer wedge the episode on our live pid, by construction.
        //    DISCLOSED COST (cycle-5 audit, F4): when the claim is still
        //    intact but the lock stamp hit ENOENT (a rival reclaimed the
        //    lock dir and crashed before stamping), the sole survivor
        //    releases its own VALID claim and this activation fails —
        //    availability-only and self-healing (the next activation
        //    publishes cleanly; probe-verified), and keeping the claim
        //    instead would re-open the P20c3-F1 double-admission.
        let stampOurs = true;
        try {
          const s = await readFile(join(leaseLockPath, "owner"), "utf8");
          stampOurs = s === leaseToken;
        } catch (e) {
          // Same rule as the initial stamp read (P20c3-F2): ENOENT means
          // the lock was torn down (and possibly re-created) under us —
          // NOT ours. Any OTHER error (EIO, EAGAIN, ...) cannot disprove
          // the ownership we just won with a successful wx-create, so it
          // must not fail us — that was the reproduced self-wedge.
          if ((e as NodeJS.ErrnoException).code === "ENOENT") stampOurs = false;
        }
        const mine = await readFile(leasePath, "utf8").catch(() => "");
        const claimOurs = leaseBodyIsOurs(mine);
        if (!claimOurs || !stampOurs) {
          // Same shared anomaly exit (P20c6-F1/F2): self-release OUR
          // claim (strict, token-verified, RETRIED) and restore the
          // moved-aside original iff the lease is absent, so a failed
          // takeover leaves NEITHER a lease naming our live pid NOR the
          // previous owner's claim stranded under the gone name. The
          // message names the actual per-step outcomes; the episode
          // stays recoverable.
          await anomaly(`replaced mid-swap (claim ${claimOurs ? "intact" : "not ours"}, lock stamp ${stampOurs ? "ours/unverifiable" : "lost"})`);
        }
        // Admission complete: the lease path holds OUR verified claim, so
        // the moved-aside copy is definitively garbage (P20c7: even if
        // this unlink fails, the pid-aware reconcile reclaims it once we
        // exit — a dead mover's artifact with an occupied lease path is
        // unlink-only).
        if (movedAside) await unlink(gone).catch(() => {});
      } finally {
        activeReclaims.delete(protection);
        ACTIVE_STAGE_PATHS.delete(`${epId}:${basename(tmp)}`);
        await unlink(tmp).catch(() => {});
      }
    };
    // P20c3-F1: releasing the takeover lock is STAMP-CONDITIONAL. The
    // lock's `owner` file carries our token; deleting a lock whose stamp
    // is gone or names someone else destroys a live acquirer's lock (the
    // reproduced delayed-reclaim theft). DISCLOSED RESIDUAL (cycle-4
    // audit, F4): between the stamp read and the rmdir the stamp could
    // be replaced — an unavoidable check→act TOCTOU without an
    // atomic-compare-delete primitive; `leaseSwapHoldMs` shifts the
    // schedule window but is NOT a scheduler-independent bound.
    const rmIfLockOurs = async (): Promise<void> => {
      try {
        const stamp = await readFile(join(leaseLockPath, "owner"), "utf8");
        if (stamp === leaseToken) await rm(leaseLockPath, { recursive: true, force: true });
      } catch { /* vanished or unreadable: not ours to remove */ }
    };
    // P20c8-F2 (R5 audit, finding 2): a takeover lock whose `owner`
    // stamp names a provably DEAD pid is HELD BY NOBODY — no live
    // process carries that token. The 30s steal bound exists to fence a
    // thief frozen mid-acquisition, but a frozen thief's stamp names a
    // LIVE pid (SIGSTOP keeps it alive); a dead stamper can never
    // finish, and with the lease absent/vacant the episode sat wedged
    // for the whole bound (reproduced R5-F2: fresh dead-stamped lock +
    // reconcile-restored claim → "contended" for 30s despite the
    // disclosure claiming immediate self-heal). Clear it NOW: re-read
    // the stamp immediately before the rm to narrow the check→act
    // window, and disclose the residual (a lock recreated between the
    // re-read and the rm loses it — the same P20c4-F4 class already
    // accepted for rmIfLockOurs, and the swap's own no-replace/pre-move
    // checks still hold INV-A). An UNSTAMPED or uninterpretable-stamp
    // lock keeps the age bound; a stamp naming a REUSED live pid is
    // judged alive (conservative, disclosed).
    const clearDeadStampedLock = async (): Promise<boolean> => {
      let stampRaw: string;
      try { stampRaw = (await readFile(join(leaseLockPath, "owner"), "utf8")).trim(); }
      catch { return false; } // no/unreadable stamp: age bound decides
      if (stampRaw === leaseToken) return false; // OUR OWN lock: never self-steal
      const stampPid = Number(stampRaw.split(".")[0] ?? "");
      if (!Number.isSafeInteger(stampPid) || stampPid <= 0) return false;
      if (pidAlive(stampPid)) return false; // live (or reused-pid live): never torn down
      try {
        const recheck = (await readFile(join(leaseLockPath, "owner"), "utf8")).trim();
        if (recheck !== stampRaw) return false; // stamp changed under us: a new acquirer holds it
        await rm(leaseLockPath, { recursive: true, force: true });
        log(`host-lease: takeover lock stamped by dead pid ${stampPid} held by nobody — cleared immediately, no 30s steal wait (P20c8-F2)`);
        return true;
      } catch { return false; } // vanished/errored: next attempt decides
    };
    // Crash hygiene: a publisher killed between staging and linking leaves
    // an orphaned lease/lock tmp. Reclaim is PID-AWARE (P20-F3): our own
    // in-flight tmps are never touched, a tmp naming a DEAD process is
    // garbage at any age, and only FOREIGN tmps (no pid we can judge)
    // fall back to the age bound. An aged-but-LIVE publisher's stage now
    // survives; if some other remover still gets it, stagedPublish retries.
    // P20c7: `.reclaim-` artifacts are handled by reconcileReclaims BELOW
    // (run first) — they are potential recovery sources, not blind
    // garbage — so this sweep is staged-tmp names only.
    // ── P20c7 (audit cycle 4, F1/F2): reconcile crashed-mover artifacts. ──
    // A takeover's `.reclaim-<pid>` file IS the previous owner's claim
    // between the move and the relink. While a LIVE mover holds it the
    // artifact is its workspace (never touched); once its owner is dead
    // or uninterpretable it is EITHER the recovery source (lease path
    // vacant → restore it: a no-replace link, so a racing owner or a
    // concurrent restorer always wins) OR garbage (the lease path holds a
    // claim → the moved copy is stale). Restoring BEFORE discarding is
    // what makes a mover crash self-healing: the old cycle's pid-aware
    // sweep unlinked a dead mover's artifact sight-unseen, which — with
    // the lease absent — destroyed the only recovery source and left the
    // episode wedged (reproduced wedge: next creator "contended" until
    // the lock's steal bound).
    const isReclaimName = (n: string): boolean => n.startsWith("host.lease.reclaim-");
    const reclaimOwnerPid = (n: string): number | null => {
      const m = /^host\.lease\.reclaim-(\d+)\./.exec(n);
      if (m === null) return null;
      const pid = Number(m[1]);
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    };
    // Restore every DEAD/UNKNOWN-owner artifact whose lease path is
    // vacant. P20c8 (R5 audit, findings 1 & 3):
    //  - the source is unlinked ONLY after a PROVEN superseding outcome
    //    (restore linked; an occupant OBSERVED at the lease path). A
    //    transient link error (EIO, EAGAIN, ...) PRESERVES the source —
    //    pre-P20c8 an errored link fell through to unlink and destroyed
    //    the only recovery source (reproduced R5-F1: two reconcilers
    //    both failing their links with EIO lost the wedge permanently);
    //  - an own-pid artifact is skipped ONLY while it is in this
    //    process's active-reclaim set (an in-flight swap of this very
    //    invocation, registered by canonical episode identity +
    //    basename before the move). It is never judged by mtime: rename
    //    preserves the SOURCE lease's old mtime, so a live swap's
    //    artifact can look arbitrarily old. A same-pid artifact NOT in
    //    the set belongs to a dead namesake incarnation and IS
    //    reconciled (P20c8-F3).
    // Returns the number of claims restored.
    const reconcileReclaims = async (): Promise<number> => {
      let restored = 0;
      let names: string[];
      try {
        names = await readdir(epPath);
      } catch (e) {
        // Recovery cannot be judged if it cannot be observed. Fail closed:
        // a durable source may hold the only copy of a live claim.
        throw new Error(`host: cannot inspect recovery sources in ${epPath} (readdir failed: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); refusing activation until ownership is resolved`);
      }
      for (const n of names) {
        if (!isReclaimName(n)) continue;
        const ownerPid = reclaimOwnerPid(n);
        const full = join(epPath, n);
        if (ownerPid === process.pid) {
          // A rename preserves the original lease mtime, so only the
          // in-memory active set can identify this process's live swap.
          // The identity is the canonical episode directory plus the
          // basename, so equivalent path spellings cannot evade it.
          if (activeReclaims.has(`${epId}:${basename(n)}`)) continue;
        } else if (ownerPid !== null && pidAlive(ownerPid)) {
          continue; // live mover's workspace (namesake-reuse of a FOREIGN live pid is the disclosed residual — no portable start-time probe)
        } else if (ownerPid === null) {
          // Uninterpretable owner: UNKNOWN, not dead — same age bound as
          // the tmp sweep before touching it.
          try {
            if (Date.now() - (await stat(full)).mtimeMs <= ABANDON_AFTER_MS) continue;
          } catch { continue; } // vanished mid-reconcile
        }
        // no-replace link: vacant → we restore it. On EEXIST the occupant
        // is judged by OBSERVATION before the source is removed
        // (P20c8-F5 discipline): occupant present → the moved copy is
        // superseded garbage; occupant vanished/unreadable → the source
        // survives for the next reconcile. Any other link error preserves
        // the source (P20c8-F1).
        let proven: boolean;
        try {
          await link(full, leasePath);
          restored++;
          proven = true;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "ENOENT") continue; // the source vanished under us: nothing left either way
          if (code !== "EEXIST") {
            // A failed restore does not establish that the lease is vacant.
            // Fail closed: do not continue to the fresh-publish path while
            // a recovery source may hold the sole copy of a live claim.
            throw new Error(`host: cannot reconcile recovery source ${full} (restore link failed: ${code ?? (e as Error).message}); refusing activation until ownership is resolved`);
          }
          try { await readFile(leasePath, "utf8"); proven = true; }
          catch (oe) {
            if ((oe as NodeJS.ErrnoException).code === "ENOENT") {
              throw new Error(`host: cannot reconcile recovery source ${full} (lease path vanished after EEXIST); refusing activation until ownership is resolved`);
            }
            throw new Error(`host: cannot reconcile recovery source ${full} (lease occupant unreadable: ${(oe as NodeJS.ErrnoException).code ?? "error"}); refusing activation until ownership is resolved`);
          }
        }
        if (proven) await unlink(full).catch(() => {});
      }
      return restored;
    };
    await reconcileReclaims();
    const names = await readdir(epPath).catch((e) => {
      // Staged tmp cleanup is best-effort, but an unreadable directory is
      // inspected ownership — fail closed rather than sweeping blind.
      throw new Error(`host: cannot inspect tmp stages in ${epPath} (readdir failed: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); refusing activation until ownership is resolved`);
    });
    {
      const nowMs = Date.now();
      for (const n of names) {
        // Staged tmps ONLY (P20c7): `.reclaim-` originals are reconciled
        // above (restore-if-vacant) before any unlink is considered.
        const m = /^host\.lease(?:\.lock)?\.tmp-(\d+)\./.exec(n);
        if (m === null) continue;
        const ownerPid = Number(m[1]);
        const full = join(epPath, n);
        if (ACTIVE_STAGE_PATHS.has(`${epId}:${basename(n)}`)) continue; // another live activation in this process owns this exact stage
        // P20-F2/F3: the sweep is PID-AWARE. A tmp whose owner pid is
        // ALIVE is never touched — a live-but-paused (SIGSTOP) or stalled
        // publisher's stage can age past any time bound, and unlinking it
        // under the publisher was the reproduced crash (link ENOENT).
        // An owner we can prove DEAD makes its tmp garbage at any age.
        // An uninterpretable pid (out of the safe-integer range) is
        // UNKNOWN, not dead — reclaimed only past the age bound.
        // P20c8-F3: our own pid skips only POST-START tmps (incarnation
        // rule) — a pre-start same-pid tmp is a dead namesake's stage.
        if (ownerPid === process.pid) {
          try {
            if ((await stat(full)).mtimeMs < procStartMs) {
              await unlink(full).catch(() => {}); // old same-pid stage: dead namesake
            }
          } catch { /* vanished mid-sweep */ }
          continue; // a live stage from this pid is never touched
        }
        const interpretable = Number.isSafeInteger(ownerPid) && ownerPid > 0;
        try {
          if (interpretable) {
            if (!pidAlive(ownerPid)) { await unlink(full).catch(() => {}); continue; } // dead owner: garbage at any age
            continue; // live owner: its stage survives, whatever its age
          }
          if (nowMs - (await stat(full)).mtimeMs > ABANDON_AFTER_MS) await unlink(full).catch(() => {}); // unknown owner + aged: reclaim
        } catch { /* vanished mid-sweep */ }
      }
    }
    // Fast path: no lease at all — publish exclusive. This races ONLY
    // another creation (both stage+link; exactly one wins) and a recovery
    // (which holds the lock and re-verifies before replacing).
    // P20c7-F2: the reconcile ran BEFORE this path, so a crashed mover's
    // restored claim is judged normally below (live → refuse; stale →
    // re-take under the lock) instead of leaving the path falsely vacant.
    if (await publishLease()) {
      leaseHeld = true;
      return;
    }
    // A lease exists. Recovery loop: every decision about a STALE lease
    // is made under the takeover lock, and re-verified after it is held.
    for (let attempt = 0; attempt < 40; attempt++) {
      const { missing, raw } = await readLease();
      if (missing) {
        // The lease vanished since the failed publish (a holder released
        // it): a takeover lock stamped by a DEAD pid is held by nobody —
        // clear it first (P20c8-F2), or the lock-aware publish would
        // yield to a claim nobody owns until the 30s steal bound. Then
        // undo any crashed mover's pending swap (P20c7-F2 —
        // restore-if-vacant, so a falsely-vacant path is judged on the
        // restored claim), then claim exclusive — races only another
        // create.
        await clearDeadStampedLock();
        await reconcileReclaims();
        if (await publishLease()) {
          leaseHeld = true;
          return;
        }
        continue; // someone beat us: re-evaluate their lease
      }
      if (raw === "") {
        // Empty/partial: a creation IN PROGRESS (open→write window) or a
        // crashed creator. Never claim blind — give the writer a moment.
        // P18-C3 F2 recovery bound: a create→write window is microseconds;
        // an EMPTY lease whose mtime is older than ABANDON_AFTER is
        // evidence its creator died before its first write, so it may be
        // taken over — but only under the takeover lock, re-verified.
        if (!(await leaseAbandoned())) {
          await sleep(25);
          continue;
        }
        // fall through: abandoned-empty is recovery-eligible, serialize.
      }
      const holderPid = leasePidOf(raw);
      if (holderPid === process.pid) refuseSameProcess();
      if (holderPid !== undefined && pidAlive(holderPid)) refuseLive(holderPid);
      if (holderPid === undefined && raw !== "" && !(await leaseAbandoned())) {
        // P19-F1: unparseable FRESH content is AMBIGUOUS, not proven-dead.
        // Under this protocol a complete-but-broken body can only come
        // from a legacy/foreign writer; give it the same abandon bound as
        // the empty case before recovery touches it.
        await sleep(25);
        continue;
      }
      // Stale (dead pid) or abandoned-ambiguous content — take over,
      // disclosed. Serialize.
      //
      // P20-F1 (re-audit of 58c588f, finding 1): the OLD steal was an
      // UNFENCED read-age→rm→mkdir. A thief that read the lock age at T0,
      // froze (SIGSTOP), let the original holder's recovery time out and
      // release, and a THIRD creator publish, then resumed: its stale
      // age-read said "abandoned", rm'ed a FRESH lock, mkdir-ed its own,
      // and it stole the takeover from under a creator that had just won
      // (reproduced: 2 activations + 2 disclosed takeovers of one lease).
      // An unlink that is race-free against any re-creation is impossible
      // (no unlink-at-only-if-unmodified primitive exists), so the fence
      // is: (1) never rm a lock whose owner stamp proves a LIVE holder;
      // (2) after acquiring (mkdir), write an ownership stamp into the
      // lock directory and RE-READ it, then RE-VERIFY — under the lock
      // and before touching anything — that the lease is still exactly
      // the claim we set out to replace AND still stale. A thief frozen
      // between mkdir and verification finds its own lock torn down by a
      // new acquirer (stamp gone/mismatch) or its lease re-check fail,
      // and re-loops instead of stealing.
      let lockHeld = false;
      let outcome: "retry" | "takeover" | "published" = "retry";
      try {
        let mkdirErr: unknown = null;
        try { await mkdir(leaseLockPath); } catch (e) { mkdirErr = e; }
        if (mkdirErr === null) {
          lockHeld = true;
          const stampPath = join(leaseLockPath, "owner");
          try {
            await writeFile(stampPath, leaseToken, { flag: "wx" });
            // Verification re-read. P20c3-F2 (audit cycle 2, finding 2):
            // the old code bailed on ANY error here — a TRANSIENT read
            // error (EIO) after a SUCCESSFUL exclusive stamp-write threw
            // away an ownership we provably had AND left our lock (stamp:
            // our live pid) on disk un-reclaimable (the steal path sees a
            // live owner forever) — the reproduced self-wedge. ENOENT
            // means the lock was torn down and re-created under us (not
            // ours — retry); any other error cannot DISPROVE the
            // wx-create we just won, so ownership stands and the
            // lease-level re-verification below still fences the swap.
            try {
              if ((await readFile(stampPath, "utf8")) !== leaseToken) lockHeld = false;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === "ENOENT") lockHeld = false; // vanished: not ours
            }
          } catch {
            lockHeld = false; // stamp absent/occupied/failed: not ours — do NOT touch the lease
          }
          if (!lockHeld) {
            // P20c3-F2: a bail must not leave OUR freshly-created lock
            // (with our stamp, naming our live pid) wedging every future
            // acquirer. Stamp-conditional: removes only what is ours.
            await rmIfLockOurs();
          }
          if (lockHeld) {
            // Fence re-verification: the takeover premise must still hold.
            const cur0 = await readLease();
            if (cur0.missing) {
              // Released under us: claim exclusive (races only another
              // create). underLock=true: WE hold the takeover lock, so
              // the P20c6-F1 lock check must not self-block here.
              if (await publishLease(true)) outcome = "published";
            } else if (cur0.raw !== raw) {
              // The lease changed since our observation (a creator won or a
              // takeover happened): our staleness premise is dead — re-decide
              // from scratch, never act on stale bytes.
            } else if (cur0.raw.trim() === "") {
              if (await leaseAbandoned()) {
                log(`host-lease: empty lease on ${epPath} older than ${ABANDON_AFTER_MS}ms (creator died before first write) — taking over`);
                outcome = "takeover";
              }
            } else {
              const curPid0 = leasePidOf(cur0.raw);
              if (curPid0 === process.pid) refuseSameProcess(); // throws; finally releases the lock
              if (curPid0 !== undefined && pidAlive(curPid0)) refuseLive(curPid0); // holder revived/pid-reused: refuse; finally releases
              if (curPid0 === undefined && !(await leaseAbandoned())) {
                // P19-F1/P20-F2: unparseable FRESH content is ambiguous —
                // never proven dead, wait out the abandon bound.
              } else {
                log(`host-lease: stale lease on ${epPath} (holder ${curPid0 ?? "unknown"} not alive${curPid0 === undefined ? `, ambiguous content past ${ABANDON_AFTER_MS}ms abandon bound` : ""}) — taking over`);
                outcome = "takeover";
              }
            }
          }
        } else {
          const code = (mkdirErr as NodeJS.ErrnoException).code;
          if (code !== "EEXIST") throw mkdirErr;
          // P20c8-F2: a stamp naming a provably DEAD pid is held by
          // nobody — clear it immediately (any age), re-loop, and take
          // over on the next iteration. Pre-P20c8 a fresh dead-stamped
          // lock (crashed acquirer) forced the full 30s steal bound even
          // though no live process could ever resume it (reproduced
          // R5-F2 wedge with a reconcile-restored claim).
          if (await clearDeadStampedLock()) continue;
          // Lock held by someone else: steal ONLY if its owner stamp proves
          // the holder DEAD (or it carries no stamp — legacy) AND it is past
          // the age bound. A LIVE holder — even one that froze between its
          // age-observation and our check — is never torn down (P20-F1).
          // (The dead-stamp case no longer needs the bound — see
          // clearDeadStampedLock above; this legacy path now covers
          // UNSTAMPED locks and stamps with an uninterpretable pid.)
          try {
            const st = await stat(leaseLockPath);
            if (Date.now() - st.mtimeMs > 30_000) {
              let ownerAlive = false;
              let stamped = false;
              try {
                const ownerStamp = (await readFile(join(leaseLockPath, "owner"), "utf8")).trim();
                stamped = true;
                const ownerPid = Number(ownerStamp.split(".")[0] ?? "");
                if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && pidAlive(ownerPid)) ownerAlive = true;
              } catch { /* no stamp: judge on age alone (legacy format) */ }
              if (!ownerAlive) {
                await rm(leaseLockPath, { recursive: true, force: true });
                log(`host-lease: takeover lock abandoned ${stamped ? "(owner not alive)" : "(no owner stamp)"} past 30s — reclaimed (P20-F1)`);
              }
            }
          } catch { /* vanished: next attempt may take it */ }
        }
      } finally {
        // NEVER leave our own lock on disk unless we are carrying it into
        // the swap below: normal retry, a published return, AND a refuse
        // throw all release it (the pre-P20 code leaked the lock on the
        // throw paths, wedging recovery behind a stamp naming our own
        // live pid).
        if (lockHeld && outcome !== "takeover") await rmIfLockOurs();
      }
      if (lockHeld && outcome === "takeover") {
        // Lock still ours and fence-verified: swap the claim atomically
        // (rename — a reader never sees a mix), then release the lock.
        // replaceLeaseUnderLock re-checks after the swap that the lease is
        // still OUR claim and that our LOCK still carries our stamp
        // (P20c3-F1: a delayed-reclaim thief makes us walk away).
        // P20c3: release is stamp-conditional — if the lock directory was
        // reclaimed under us, it is NOT ours to delete; the pre-P20c3
        // unconditional rm destroyed a fresh thief lock (the F1 repro).
        try {
          await replaceLeaseUnderLock();
          leaseHeld = true;
          return;
        } finally {
          await rmIfLockOurs();
        }
      }
      if (outcome === "published") {
        leaseHeld = true;
        return;
      }
      await sleep(50);
    }
    throw new Error(`host: episode ${episodeId} lease claim stayed contended (40 attempts on ${leasePath}) — refusing to activate (P18-C3)`);
  };
  await takeLease();
  return { token: leaseToken, path: leasePath, held: () => leaseHeld, release: releaseOursClaim };
}

export async function runHostEpisode(opts: HostEpisodeOptions): Promise<HostEpisodeResult> {
  const log = opts.log ?? ((line: string) => { process.stderr.write(`supervisor-host: ${line}\n`); });
  const episodeId = opts.graph?.episodeId ?? "unknown";

  // ── graph + S4 scaffold ─────────────────────────────────────────────────
  let graph: EpisodeGraph;
  if (opts.graphPath !== undefined) {
    graph = await readEpisodeGraph(opts.graphPath);
  } else if (opts.graph !== undefined) {
    graph = opts.graph;
  } else {
    throw new Error("host: either graphPath or graph is required");
  }
  assertId(graph.episodeId, "episodeId");
  assertId(opts.taskId, "taskId");
  assertId(opts.grantedBy, "grantedBy");
  // P9 audit cycle-2 F4: the merge-port branch is validated against
  // P12's EXACT grammar (SAFE_ID — a single path element) BEFORE any
  // worker starts, so a name P12 would refuse at integration (e.g.
  // `integrate/ep1`) fails fast at activation instead of burning a
  // whole episode into `context:episodeBranch`. The policy guards
  // (never `main` — case-folded, never the `agent` namespace) stay
  // P12's own per-call authority; this is only the contract alignment.
  if (opts.episodeBranch !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.episodeBranch)) {
    throw new Error(`host: episodeBranch must match ^[A-Za-z0-9][A-Za-z0-9._-]*$ (P12's SAFE_ID grammar — a single git branch-name element, e.g. "episode-${graph.episodeId}")`);
  }
  if (opts.integrationSeqBump !== undefined && (!Number.isSafeInteger(opts.integrationSeqBump) || opts.integrationSeqBump < 0)) {
    throw new Error("host: integrationSeqBump must be a non-negative safe integer");
  }
  const root = opts.episodesRoot ?? join(process.env["HOME"] ?? "/tmp", ".tre", "episodes");
  const epPath = episodeDir(root, graph.episodeId);
  const epId = await epPathIdentity(epPath);

  const lease = await acquireEpisodeLease({ epPath, epId, episodeId: graph.episodeId, log, leaseSwapHoldMs: opts.leaseSwapHoldMs });
  // P18-A4: everything after the claim runs under the lease — a setup
  // throw (bad graph, task-absent, journal open) must release it too,
  // or the dead run keeps the episode locked to this (alive) process.
  try {

  await createEpisodeLayout(root, graph.episodeId, graph); // idempotent

  const task = graph.tasks.find((t) => t.id === opts.taskId);
  if (task === undefined) throw new Error(`host: task ${JSON.stringify(opts.taskId)} not in graph ${graph.episodeId}`);

  const sessionPath = opts.sessionPath ?? join(epPath, "sessions", `${opts.taskId}.jsonl`);
  const steerPath = opts.steerPath ?? join(epPath, "steer.jsonl");

  // ── durable singletons ──────────────────────────────────────────────────
  const journal = await DecisionJournal.forEpisode(epPath);
  const ledger = await BudgetLedger.forEpisode(epPath);
  const policy = gatePolicyFromGraph(graph, epPath);
  const runner = await AttemptRunner.open({
    root,
    episodeId: graph.episodeId,
    ...(opts.workerCommand !== undefined ? { spawner: { kind: `tre:${opts.workerCommand}`, spawn: (t: AttemptTask, attemptId: string, o?: { resume?: boolean }) => ({
      command: opts.workerCommand ?? "tre.",
      args: [o?.resume ? "--resume" : "--session", sessionPath],
      cwd: t.worktreePath ?? opts.worktreePath,
      env: { ...process.env, TRE_ATTEMPT_ID: attemptId, TRE_EPISODE_ID: t.episodeId, TRE_TASK_ID: t.taskId },
    }) } } : {}),
  });

  // P3b: one queue for the loop's poll; unmanaged (the supervisor IS the
  // writer of nudges, the worker consumes them under its own attempt id).
  const steerQueue = new FileSteeringQueue({ path: steerPath, sessionPath });

  // P13: the escalation channel appends to its own durable store (the
  // decision journal validates its record kinds — escalations are not
  // supervisor records, so they live beside it).
  // B-F1/B-F2 (audit cycle P16, docs/19 §6): the channel is built with
  // the FULL composition — `read` (durable replay for pending()/dedup
  // across restarts) and `deliver` (the delivery ACT). A missing port
  // used to be silent: raises returned port-missing:deliver while the
  // loop journalled acked escalations nobody received, and every restart
  // re-noticed without a pending view. The deliver port is injectable;
  // without it the MISSING delivery is disclosed on the host log below.
  const escalationPath = join(epPath, "events", "escalations.jsonl");
  const escalation = makeEscalationChannel({
    now,
    append: async (rec) => { await appendFile(escalationPath, JSON.stringify(rec) + "\n", "utf8"); },
    read: async () => {
      // Durable replay source (docs/19 §3): JSONL lines; missing file is
      // an EMPTY log (fresh episode), any other failure THROWS — the
      // channel degrades pending() honestly rather than guessing.
      const raw = await readFile(escalationPath, "utf8").catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return "";
        throw e;
      });
      return raw.split("\n").filter((l) => l !== "").map((l) => {
        try { return JSON.parse(l) as unknown; } catch { return l; } // channel's own view rejects bad lines + counts them
      });
    },
    ...(opts.escalationDeliver !== undefined ? { deliver: opts.escalationDeliver } : {}),
  });
  // P13 dispatcher (docs/19 §6): conforms to the executor's DispatchPorts
  // and discloses every non-delivery on the host log — an escalation the
  // loop marks acked but nobody received was B-F1's exact failure mode.
  const escalationDispatcher = makeEscalationDispatcher({ channel: escalation });

  // ── ports ───────────────────────────────────────────────────────────────

  const journalPort: ComposePorts["journal"] = {
    // DecisionJournal.append validates on the way in (P4 §14.7).
    append: async (record) => { await journal.append(record as SupervisorRecord); },
    read: async () => journal.read(),
  };

  /** The loop's gate port (docs/18 §0.2): refresh-first check, reserve
   *  with the minted receipt, real attestation on close. */
  const loopGate: GatePort = {
    check: async (req) => {
      const snapshot = await ledger.snapshotAt(now());
      return ledgerCheck(policy, toLedgerRequest(req, opts.taskId), snapshot, now());
    },
    reserve: async (req, receipt) => {
      const openRec = await ledger.reserve(policy, toLedgerRequest(req, opts.taskId), receipt as ActionReceipt);
      return { id: openRec.id };
    },
    closeReservation: async (refId, reason, attest) => ledger.closeReservation(refId, reason, attest),
    ingestSession: async (session, scope) => ledger.ingestSession(session, scope),
    recordManualSpend: async (spend, scope) => ledger.recordManualSpend(spend, scope),
    recordWallclock: async (scope, seconds) => ledger.recordWallclock(scope, seconds),
  };

  /** The executor's gate port (docs/15 §3): the executor calls
   *  check(undefined, req) then reserve(undefined, req) — the receipt the
   *  loop's wrapper needs comes back from reserve as the OPEN RECORD, so
   *  this adapter performs check→reserve itself and caches the receipt
   *  under the actionId (the receipt's own verify() binds action/actionId/
   *  episode/task, so a cache hit for a different action is refused). */
  // W1-M5 (audit cycle W1): reserve must present the ledger EXACTLY the
  // request the receipt was minted from — sideEffect, paths, estimate,
  // model and strategyId all pass the receipt's field-by-field sameOpt +
  // digest checks. The old rebuild forced sideEffect:"none" with no
  // fields, so every non-none/path/estimate-bearing executor action died
  // at reserve (fail-closed but DEAD). The fix caches the CHECKED ledger
  // request alongside the receipt and replays it verbatim — a cache hit
  // is only ever the request that check admitted, so no substitution is
  // possible (the receipt's own verify binds action/actionId/episode/task).
  // W1-minor: the cache is capped — check-only (never-reserved) entries
  // evict FIFO past the cap instead of leaking for the process lifetime.
  const RECEIPT_CACHE_CAP = 64;
  const receiptCache = new Map<string, { receipt: ActionReceipt; req: LedgerGateRequest }>();
  const executorGate = {
    check: async (_policy: unknown, req: { action: string; actionId: string; taskId?: string; attemptId?: string; authority: { grantedBy: string; sideEffect: "none" | "worktree-local" | "external" }; model?: string; strategyId?: string }) => {
      const snapshot = await ledger.snapshotAt(now());
      const ledgerReq = toLedgerRequest(req as GateRequestLike, opts.taskId);
      const res = ledgerCheck(policy, ledgerReq, snapshot, now());
      if (res.allowed && res.receipt !== undefined) {
        if (receiptCache.size >= RECEIPT_CACHE_CAP) {
          const oldest = receiptCache.keys().next();
          if (!oldest.done) receiptCache.delete(oldest.value);
        }
        receiptCache.set(req.actionId, { receipt: res.receipt, req: ledgerReq });
      }
      return { allowed: res.allowed, denials: res.denials.map((d) => ({ code: d.code, detail: d.detail })) };
    },
    reserve: async (_policy: unknown, req: { actionId: string }) => {
      const hit = receiptCache.get(req.actionId);
      if (hit === undefined) throw new Error(`host gate: no check receipt for ${req.actionId} (check must precede reserve)`);
      receiptCache.delete(req.actionId);
      const openRec = await ledger.reserve(policy, hit.req, hit.receipt);
      return openRec;
    },
    // Close doors for the loop's wrapper (docs/18 §11): the loop owns the
    // close of executor-side reservations; the executor never calls these.
    closeReservation: async (refId: string, reason: "settled" | "released", attest?: { outcome: string; evidence: string }) => ledger.closeReservation(refId, reason, attest),
  };

  /** Session derivation: the executor's runner task carries no session
   *  path (P11 §2), the P7 AttemptTask requires one — the host owns the
   *  episode layout, so it fills it in. */
  const sessionFor = (t: { taskId?: string }): string =>
    t.taskId === undefined || t.taskId === opts.taskId ? sessionPath : join(epPath, "sessions", `${t.taskId}.jsonl`);

  const runnerPort: RunnerPort = {
    run: async (t) => runner.run({ episodeId: graph.episodeId, taskId: t.taskId, session: t.session || sessionFor(t), ...(t.attemptId ? { attemptId: t.attemptId } : {}), ...(t.model ? { model: t.model } : {}), ...((t.worktreePath ?? opts.worktreePath) ? { worktreePath: t.worktreePath ?? opts.worktreePath } : {}) }),
    reconcile: async (t) => runner.reconcile({ episodeId: graph.episodeId, taskId: (t as { taskId: string }).taskId, session: (t as { session?: string }).session ?? sessionFor(t as { taskId?: string }) }),
    resume: async (t, attemptId) => runner.resume({ episodeId: graph.episodeId, taskId: (t as { taskId: string }).taskId, session: (t as { session?: string }).session ?? sessionFor(t as { taskId?: string }) }, attemptId),
    stop: async (h) => runner.stop({ session: h.session }),
    // docs/18 step A: preflight reports open intents (reconcile territory
    // stays with P7; the host only surfaces what the journal shows).
    preflight: async () => {
      const { records } = await journal.read();
      const open = openIntents(records as SupervisorRecord[]);
      if (open.length > 0) log(`preflight: ${open.length} open intent(s): ${open.map((r) => r.actionId).join(", ")}`);
    },
  };

  /** P16 (audit cycle, docs/19 §6): the park ACT — ONE body, two doors.
   *  dispatch.park drives it in the loop; parkTask is the test seam (the
   *  planner seed `park` fires only for a LIVE worker && !ownershipProvable
   *  && !ambiguousExternalEffect — a predicate the compose loop never
   *  produces, which always sends the worker stopped between turns, so the
   *  handler's contract is driven directly by tests). */
  const runPark = async (): Promise<void> => {
    const statePath = join(epPath, "state.json");
    let state;
    try {
      state = await readEpisodeState(statePath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        // Genuinely absent: starting fresh is the only safe case.
        state = { schema: "tre-episode-state/1" as const, episodeId: graph.episodeId, tasks: {} };
      } else {
        // W1-M7 (audit cycle W1): a CORRUPT or unreadable (EACCES)
        // state.json may hold other tasks' state — the old blind
        // `state = fresh` overwrote it silently. Fail closed: move
        // the bytes aside (never destroyed), skip the durable write,
        // disclose on the host log.
        const preserve = await preserveAside(statePath).catch(() => undefined);
        if (preserve === undefined) { log(`park: state.json unreadable (${code ?? (e as Error)?.name ?? "parse"}) AND preserve failed — NOTHING overwritten, durable park write SKIPPED`); }
        else { log(`park: state.json unreadable (${code ?? (e as Error)?.name ?? "parse"}) — preserved as ${preserve}, durable park write SKIPPED`); }
        return;
      }
    }
    state.tasks[opts.taskId] = { status: "parked" };
    await writeEpisodeState(statePath, state);
    // B-F2 (audit cycle P16, docs/19 §6): a parked task is an open
    // question — 'repeated-strategy' with the approve/rewrite/abort
    // decision, raised through the dispatcher so it is durable AND
    // delivered. W12-F1 (P16 audit W5): the dispatcher's delivery record
    // is DISCLOSED here exactly as escalate's is — before, park journalled
    // the question and stayed silent about a human who was never asked
    // (the B-F1 defect on the park path).
    try {
      const r = await escalationDispatcher.park({ episodeId: graph.episodeId, taskId: opts.taskId });
      // W12-F1 + W13-F2c (P16 audit): ONE rule — the dispatcher namespaces
      // EVERY non-delivery as 'escalation:…' (invalid/recorded/re-notice/
      // redeliver-cap/refused:<channel>), so no channel-name matching is
      // needed here and a new refusal channel cannot log as dispatched.
      if (r.channel.startsWith("escalation:")) {
        // W13-F4 (audit): same cause-threading as escalate — the why,
        // not just the what (dedup when the error repeats the channel).
        let parkCause = "";
        if (r.error !== undefined) {
          const de = r.error.startsWith("deliver:") ? r.error.slice(8) : r.error;
          if (!r.channel.includes(de)) parkCause = `: ${r.error}`;
        }
        log(`park: question NOT delivered (${r.channel.slice(11)}${parkCause}) — the human has NOT been asked; see ${escalationPath}`);
      } else {
        log(`park: question dispatched via ${r.channel}`);
      }
    } catch (e) {
      log(`park: escalation raise failed (${String((e as Error)?.message ?? e).slice(0, 120)}) — state written, human NOT notified`);
    }
  };

  const executorPorts: ComposePorts["executorPorts"] = {
    journal: journalPort,
    // NOTE: the executor's runner arrives via the loop's wrapper
    // (compose.ts step 6) seeded from the top-level `runner` port below —
    // ExecutorPortsBase intentionally has no runner field.
    gate: executorGate,
    // Nudges append to the steer file (the supervisor is the file writer;
    // FileSteeringQueue.push is memory-only for shared drivers).
    steer: {
      push: async (req: { id: string; text: string; source?: string; attemptId?: string; taskId?: string }) => {
        await mkdir(epPath, { recursive: true });
        await appendFile(steerPath, JSON.stringify(req) + "\n", "utf8");
      },
    },
    dispatch: {
      investigate: async (req: object) => {
        const diag = await runInvestigation({ id: `inv-dispatch-${String((req as { actionId?: string }).actionId ?? now())}`, episodeId: graph.episodeId, taskId: (req as { taskId?: string }).taskId, attemptId: (req as { attemptId?: string }).attemptId }, { now });
        return { evidenceRefs: Array.isArray(diag.evidenceRefs) ? [...diag.evidenceRefs] : [] };
      },
      repair: async () => { throw new Error("host: repair act is unwired in M2 (no repair executor yet)"); },
      rewriteTask: async (req: object) => {
        // The revision bump IS the act (P11 §act): rewrite graph.json.
        // W1-M6: the bump must also land on the host's LIVE closures —
        // the in-memory graph task (evidence collection reads it) and
        // cfg.taskRevision (the loop forwards it to evaluate + journals
        // the acceptance record). Before this, only the on-disk graph
        // advanced and every subsequent verdict carried the stale N.
        const g = opts.graphPath !== undefined ? await readEpisodeGraph(opts.graphPath) : graph;
        const t = g.tasks.find((x) => x.id === opts.taskId);
        const bump = opts.graphPath !== undefined
          ? await (async () => { const cur = (t?.revision ?? 1) + 1; if (t) t.revision = cur; await (await import("../episode/journal.js")).writeEpisodeGraph(opts.graphPath!, g); return cur; })()
          : (task.revision ?? 1) + 1;
        task.revision = bump; // live in-memory graph (same object as `graph` when no graphPath)
        cfg.taskRevision = bump; // live loop config closure (evaluate + plan inputs read it per iteration)
        void req;
        return { taskRevision: bump };
      },
      escalate: async (req: object) => {
        // B-F1/F2 (audit cycle P16): route through the docs/19 §6
        // dispatcher (closed blocker mapping, fenced copies, evidence
        // markers) and DISCLOSE a failed delivery on the host log — the
        // loop journalling an acked escalation nobody received was the
        // exact defect. The executor keeps its own intent/outcome
        // journaling around this call (docs/15 §4).
        const r = req as { episodeId?: string; taskId?: string; actionId?: string; rationale?: string[] };
        const res = await escalationDispatcher.escalate({
          episodeId: graph.episodeId,
          taskId: typeof r.taskId === "string" ? r.taskId : opts.taskId,
          ...(typeof r.actionId === "string" ? { actionId: r.actionId } : {}),
          ...(Array.isArray(r.rationale) ? { rationale: r.rationale } : {}),
        });
        // The dispatcher returns {channel, error?}: a delivered send carries
        // the port's channel name (e.g. 'telegram'); every NON-delivery
        // is namespaced 'escalation:…' (invalid/recorded/re-notice/
        // redeliver-cap/refused:<channel>) — B-F1 demanded that
        // distinction reach the host log instead of a bare acked.
        // W13-F2c: the refusal case is namespaced AT THE SOURCE, so this
        // host has ONE rule and no channel-name set to maintain.
        // W13-F4 (audit): the delivery error rides home on the result —
        // the log names it (class name for a throw; describeErr never
        // surfaces an untrusted message), not just the fact of the
        // non-delivery.
        if (res.channel.startsWith("escalation:")) {
          // A refusal's error is `deliver:refused:<name>` — the channel
          // already carries that tail, so the cause only prints when it
          // adds information (a throw's name, e.g. ': Error').
          let cause = "";
          if (res.error !== undefined) {
            const de = res.error.startsWith("deliver:") ? res.error.slice(8) : res.error;
            if (!res.channel.includes(de)) cause = `: ${res.error}`;
          }
          log(`escalate NOT delivered (${res.channel.slice(11)}${cause}) — the human has NOT been asked; see ${escalationPath}`);
        } else {
          log(`escalate dispatched via ${res.channel}`);
        }
        return { channel: res.channel };
      },
      // The in-loop park act: ONE body (runPark above) — the handler the
      // loop's dispatch and the test seam share.
      park: runPark,
      // P16 test seam (audit cycle, docs/19 §6): the `park` seed fires only
      // when the planner sees the worker LIVE (isLive: thinking|tool|warned)
      // && !ownershipProvable && !ambiguousExternalEffect — a predicate the
      // compose loop cannot produce (it always sends the worker stopped
      // between turns, which is correct for the real loop). parkTask is the
      // ONE entry that drives the real park handler (same closure as the
      // in-loop action: state write + durable escalation + disclosure), so
      // tests assert the handler's contract without faking the planner seed.
      parkTask: async (): Promise<void> => {
        await runPark();
      },
    },
  };

  const acceptPort: ComposePorts["accept"] = {
    // P16: collect REAL evidence (policy gate run, artifact digests,
    // identity from the working tree) and hand the evaluator a fully
    // typed EvaluateInput — no spread/cast. Async is allowed: the loop
    // awaits this port (compose.ts).
    evaluate: async (input): Promise<AcceptanceAssessment> => {
      // W1-C1 (audit cycle W1): evidence is measured in the worker's
      // WORKING TREE (opts.worktreePath — the same cwd the worker spawns
      // in), never silently in the episode dir. Without an explicit
      // worktree the collector marks the identity dirty-unknown instead
      // of claiming a clean baseCommit.
      const ev = await collectAcceptanceEvidence({ graph, taskId: opts.taskId, epPath, ...(opts.worktreePath !== undefined ? { worktreePath: opts.worktreePath } : {}) });
      // The loop owns the spec/identity scalars (cfg); the four evidence
      // arrays are exclusively the host's collection (the loop always
      // forwards empty arrays — merging them would erase the evidence).
      // `current` too stays with the host: every evidence row below is
      // stamped with the OBSERVED identity, and the loop's current is
      // only the graph baseCommit the host itself seeded into cfg —
      // letting it win would mark all post-work evidence stale by
      // construction.
      const i = input as Partial<EvaluateInput>;
      const merged: EvaluateInput = {
        ...ev,
        ...(typeof i.taskId === "string" && i.taskId.length > 0 ? { taskId: i.taskId } : {}),
        ...(typeof i.taskRevision === "number" ? { taskRevision: i.taskRevision } : {}),
        ...(i.spec !== undefined && typeof i.spec === "object" ? { spec: i.spec } : {}),
        ...(typeof i.now === "number" ? { now: i.now } : {}),
      };
      return evaluateAcceptance(merged);
    },
  };

  // ── P9 merge port (docs/16 §0.6 seam — "nothing outside … imports
  // [merge] UNTIL P9 wires the merge port"; the host is that wiring) ────
  // Injected ONLY when the operator declared the integration branch:
  // absent, the executor's `merge-unwired` refusal stays the whole story
  // (docs/15 §3). The journal adapter feeds the SAME DecisionJournal the
  // loop appends to (P12's record shapes mirror P4 §14.3 and validate),
  // so dedup and the sticky terminals are durable across restarts.
  // The gate adapter must test the EXACT candidate (M2): P12 builds a
  // merge commit that no ref points at yet, so the honest way to run the
  // graph gate on it is to materialize the candidate in a detached git
  // worktree under the episode dir, run the gate command THERE under the
  // same minimal env the acceptance gate uses, and report the sha the
  // worktree actually checked out — never the requested one unchecked.
  // The repo the merge acts on: the SAME tree the worker runs in must
  // hold both refs/heads/<episodeBranch> and the agent/** task branch —
  // P12's resolve stage re-verifies this per call and refuses honestly
  // when the cwd fallback is not a git repo (never a silent elsewhere).
  const repoForMerge = opts.worktreePath ?? epPath;
  const integrationJournal: IntegrationJournalPort = {
    append: async (record) => { await journal.append(record as SupervisorRecord); },
    read: async () => journal.read(),
  };
  const integrationGate: IntegrationGatePort = {
    run: async (greq) => {
      const runId = `host-gate:${greq.actionId}`.slice(0, 256);
      const shaOk = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(greq.candidateSha);
      const gateCmd = graph.policy?.gate?.cmd;
      if (!shaOk) return { pass: false, runId, sha: "", detail: "candidate-sha-invalid" };
      if (typeof gateCmd !== "string" || gateCmd.trim() === "") return { pass: false, runId, sha: greq.candidateSha, detail: "no-gate-cmd" };
      const rawT = graph.policy?.gate?.timeoutS;
      const timeoutS = typeof rawT === "number" && Number.isSafeInteger(rawT) && rawT >= 1 && rawT <= 3600 ? rawT : 120;
      // P9 audit cycle-1 F3: the directory is UNIQUE per invocation (was
      // actionId-derived: a failed/partial `worktree add` left a
      // deterministic path behind and the RETRY collided with its own
      // residue instead of starting clean). mkdir with the exclusive
      // default (no recursive) proves we own the directory BEFORE git
      // ever sees it, and the retry loop re-rolls on the (astronomical)
      // name collision.
      // F3 (audit round 2 follow-up): every PRE-GATE refusal is decided
      // BEFORE a gate directory is allocated, so a refusal can never leak
      // an empty merge-gate/g-* directory. The attributes check is pure
      // (no writes), and the filter-neutralize check likewise.
      const preGateFilterArgs = await filterNeutralizeArgs(repoForMerge);
      if (preGateFilterArgs === null) {
        return { pass: false, runId, sha: greq.candidateSha, detail: "filter-neutralize-unobservable-pre-gate" };
      }
      if (!(await attributesObservable(repoForMerge))) {
        return { pass: false, runId, sha: greq.candidateSha, detail: "attributes-source-not-empty-pre-gate" };
      }
      const parent = join(epPath, "merge-gate");
      await mkdir(parent, { recursive: true });
      let dir = "";
      for (let attempt = 0; attempt < 8 && dir === ""; attempt++) {
        const cand = join(parent, `g-${greq.actionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64)}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
        try { await mkdir(cand); dir = cand; } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") {
            return { pass: false, runId, sha: greq.candidateSha, detail: `gate-dir:${(e as NodeJS.ErrnoException)?.code ?? "mkdir-error"}`.slice(0, 512) };
          }
        }
      }
      if (dir === "") return { pass: false, runId, sha: greq.candidateSha, detail: "gate-dir:collision-exhausted" };
      // OWNERSHIP-COVERED CLEANUP (F3): the add attempt itself is inside
      // the try — git can register a worktree and fail DURING checkout,
      // and a timeout/kill after successful add leaves the same residue.
      // The first `git worktree add` into a mkdir-owned empty dir fails
      // if a registration for that path exists (fresh unique names make
      // that impossible in the normal case), so cleanup is ours on EVERY
      // path: removal is best-effort (a half-added path may answer neither
      // `remove` nor need it) and prune closes the registration window.
      let added = false;
      // p12c5 cycle-1 audit F2: a clean filter that maps altered bytes
      // back to the committed blob makes a REWRITTEN worktree read clean
      // (and a pre-existing smudge driver would convert the checkout
      // itself). The candidate is defined by RAW blob content (merge-tree/
      // commit-tree never applied filters), so the gate worktree is
      // materialized with every conversion neutralized — the on-disk
      // bytes are the candidate's bytes. An unobservable driver set
      // fails closed BEFORE the worktree is even added (checked above,
      // before the gate directory is allocated — F3).
      // MG-C5-F1: the attributes-source refusal is also decided above.
      try {
        // The candidate objects exist in the repo (P12 commit-tree'd them
        // moments ago) even though no ref names them — a detached worktree
        // materializes them without touching the task's tree.
        // MG-C4-A3 (A3 BUG-tracked-eol): a CANDIDATE COMMIT containing a
        // .gitattributes with a conversion rule (e.g. `text eol=crlf`)
        // bends the materialization itself — the commit-tree'd blob is
        // raw, checkout would apply the rule and write CRLF bytes, so
        // the bytes under the gate ≠ the candidate's bytes BEFORE the
        // gate even runs (probe git 2.54). GIT_ATTR_SOURCE pins the
        // attribute interpreter to the empty tree (see EMPTY_TREE_OID).
        const add = await runObservedGit(repoForMerge, [...preGateFilterArgs, "worktree", "add", "--detach", dir, greq.candidateSha], Math.min(timeoutS, 120), { envExtra: { GIT_ATTR_SOURCE: EMPTY_TREE_OID } });
        added = add.code === 0;
        if (!added) {
          return { pass: false, runId, sha: greq.candidateSha, detail: `worktree-add:${(add.stderr.trim() !== "" ? add.stderr : add.stdout).slice(-384)}`.slice(0, 512) };
        }
        const head = await runObservedGit(dir, ["rev-parse", "HEAD"], 30);
        const tested = head.code === 0 ? head.stdout.trim().toLowerCase() : "";
        if (tested !== greq.candidateSha) return { pass: false, runId, sha: tested, detail: "identity-mismatch-materialized" };
        // MG-C3-1 (cycle-3 audit): snapshot the gitdir IDENTITY and the
        // object-store layout (alternates/commondir/gitdir files) BEFORE
        // the command runs — any change during the gate disqualifies the
        // verdict post-run.
        const gitDirBefore = await runObservedGit(dir, ["rev-parse", "--absolute-git-dir"], 10, { maxBytes: 4096 });
        const commonDirBefore = await runObservedGit(dir, ["rev-parse", "--git-common-dir"], 10, { maxBytes: 4096 });
        let layoutBefore = "";
        if (gitDirBefore.code === 0 && gitDirBefore.stdout.trim() !== "" && commonDirBefore.code === 0 && commonDirBefore.stdout.trim() !== "") {
          const gdRaw = gitDirBefore.stdout.trim();
          const cdRaw = commonDirBefore.stdout.trim();
          const gdAbs = resolve(dir, gdRaw);
          const cdAbs = resolve(dir, cdRaw);
          let gdReal = "";
          let cdReal = "";
          try { gdReal = await realpath(gdAbs); } catch { /* fail closed below */ }
          try { cdReal = await realpath(cdAbs); } catch { /* fail closed below */ }
          if (gdReal !== "" && cdReal !== "") layoutBefore = `${gdReal}\n${cdReal}\n${await gitLayoutDigest(gdReal, cdReal, dir)}`;
        }
        if (layoutBefore === "") return { pass: false, runId, sha: greq.candidateSha, detail: "git-layout-unobservable-pre-gate" };
        const r = await runShell(gateCmd, dir, timeoutS, { env: GIT_ENV });
        // P9 audit cycle-1 F2: a PASSING command only measures the
        // candidate if what was tested IS the candidate. `rev-parse HEAD`
        // is a commit POINTER, not the bytes under it: a gate that mutates
        // tracked content, restages, or checks out a different commit
        // before exiting zero would have its verdict stamped on a sha it
        // never tested. Re-observe AFTER the command: HEAD must still be
        // the candidate, and the tracked state must still be the
        // candidate's checkout. UNTRACKED additions are tolerated — the
        // integration candidate is built from COMMITTED content, so files
        // a build step created (dist/) do not change what merges — but a
        // modified/staged/deleted TRACKED path (or any other state we
        // cannot read) fails closed: the tested bytes are no longer the
        // candidate's bytes.
        let mutated = "";
        if (r.cause === "exit" && r.code === 0) {
          const headAfter = await runObservedGit(dir, ["rev-parse", "HEAD"], 30);
          const shaAfter = headAfter.code === 0 ? headAfter.stdout.trim().toLowerCase() : "";
          if (shaAfter !== greq.candidateSha) {
            mutated = `head-moved-post-gate:${shaAfter.slice(0, 12) || "unreadable"}`;
          } else {
            // p12c5 cycle-1 audit F2: a gate can DEFINE a clean filter
            // during its own run (the linked worktree shares the common
            // .git/config), map rewritten bytes back to the committed
            // blob, assign it via .git/info/attributes, and exit 0 with
            // UNSAFE bytes on disk while `status` reads clean — the exact
            // W11-A4 class observeIdentity already neutralizes for its
            // diff. So the re-observation enumerates the driver set
            // FRESH (the config may have changed during the gate — a
            // pre-gate enumeration would be stale) and runs `status`
            // with every conversion pinned to identity: a rewrite can
            // only hide behind a filter, and a neutralized status can
            // only report clean when the ON-DISK bytes really are the
            // candidate's blobs. Unobservable driver set → fail closed.
            const postFilterArgs = await filterNeutralizeArgs(dir);
            if (postFilterArgs === null) {
              mutated = "filter-neutralize-unobservable-post-gate";
            } else {
            // MG-C3-2 (cycle-3 audit): overriding the drivers is NOT
            // enough — cleanliness is also CACHED in the index stat
            // entries. Probe on real git 2.54: a gate defines clean
            // filter mapping altered bytes to the committed blob,
            // rewrites a tracked file, runs a plain `git status` INSIDE
            // the gate (refreshing the stat cache under the poison), and
            // exits 0 — our NEUTRALIZED `update-index --really-refresh`
            // + `status` then still reported the tree CLEAN (empty
            // tracked output) while raw bytes differed. The refresh
            // busted the cache but git re-stamped the entries from
            // on-disk size+mtime without re-converting in the
            // status's window. Fix: a FRESH INDEX BUILT DURING THE
            // OBSERVATION CANNOT CARRY POISON — `read-tree HEAD` into a
            // throwaway GIT_INDEX_FILE materializes pristine stat data,
            // so the following status re-reads and re-converts every
            // tracked file with the pinned identity drivers; altered
            // raw bytes can only report as modified. Verified on the
            // exact reproduction: fresh-index status reports the mutated
            // file (" M base.txt") where the old chain said clean.
            // Unobservable build → fail closed.
            const idxDir = await mkdtemp(join(tmpdir(), "tre-gate-idx-"));
            const idxPath = join(idxDir, "idx");
            try {
              const tree = await runObservedGit(dir, [...postFilterArgs, "read-tree", "HEAD"], 30, { maxBytes: 4 * 1024 * 1024, envExtra: { GIT_INDEX_FILE: idxPath, GIT_ATTR_SOURCE: EMPTY_TREE_OID } });
              if (tree.code !== 0 || tree.truncated) {
                mutated = "fresh-index-build-failed-post-gate";
              } else {
                let idxStat: Awaited<ReturnType<typeof lstat>> | null = null;
                try { idxStat = await lstat(idxPath); } catch { /* fail closed below */ }
                if (idxStat === null || idxStat.size === 0) {
                  mutated = "fresh-index-unwritten-post-gate";
                } else {
                // R5-B1: command-line --ignore-submodules=none — repo-local
                // submodule.<name>.ignore=all must not hide child dirt here
                // either (cmd-line beats config; quiet on uninitialized subs).
                const st = await runObservedGit(dir, [...postFilterArgs, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"], 10, { maxBytes: 4 * 1024 * 1024, envExtra: { GIT_INDEX_FILE: idxPath, GIT_ATTR_SOURCE: EMPTY_TREE_OID } });
                if (st.code !== 0 || st.truncated) {
                  mutated = "tree-state-unreadable-post-gate";
                } else {
                  for (const entry of st.stdout.split("\0")) {
                    if (entry === "") continue;
                    const xy = entry.slice(0, 2);
                    // MG-C4-2 (cycle-2 verifier, repros/A2/eol): "??"
                    // entries are tolerated as CONTENT additions, but
                    // NOT when the path is an ATTRIBUTES file: the gate
                    // materializes exactly the candidate commit, so a
                    // .gitattributes present as untracked was CREATED
                    // during the gate — and attributes files feed git's
                    // BUILT-IN text/eol/ident conversions that no
                    // filter pin can neutralize (probe: `base.txt text
                    // eol=crlf` + rewritten CRLF bytes read clean).
                    // Same class: .gitmodules (submodule interpretation).
                    // MG-C4-A3 (A3 BUG-ignored-staged/ignored-attrs):
                    // the check above is blind to an interpretation file
                    // that the CANDIDATE'S OWN .gitignore excludes (e.g.
                    // a pattern matching `.gitattributes` hides the
                    // gate-written poison from `??`) — `--ignored`
                    // without a value does not consult gitignore-style
                    // patterns at all, so require `--ignored=matching`
                    // and police the `!!` entries by the same segment
                    // rule. Names only are ever read/disclosed here.
                    const p = entry.slice(3);
                    const seg = p.split("/").pop() ?? "";
                    if (xy === "??" || xy === "!!") {
                      if (seg === ".gitattributes" || seg === ".gitmodules" || seg === ".gitignore") { mutated = `untracked-attributes-post-gate:${p.slice(0, 128)}`; break; }
                      continue;
                    }
                    // "!!" with any other name is a gate-created file the
                    // merge never consumes (the CAS moves COMMIT objects,
                    // not the worktree) — tolerated as content.
                    // MG-C4-A3 (A3 BUG-staged-divergence): ANY other
                    // status code means the staged tree or the on-disk
                    // tracked content diverged from HEAD during the gate.
                    mutated = `tracked-mutation-post-gate:${xy}`; break;
                  }
                }
                }
              }
            } finally {
              await rm(idxDir, { recursive: true, force: true }).catch(() => undefined);
            }
            // P9 audit cycle-2 F1: `git status` is BLIND to on-disk deltas
            // of entries flagged `--assume-unchanged` (tag h) or
            // `--skip-worktree` (tag S) — probe: a gate that flags the
            // file, rewrites it, and exits 0 had its PASS stamped on the
            // candidate (accepted-finish/integrated with forged content
            // NEVER tested). Same blindness observeIdentity already fails
            // closed on (W11-A1/A3): read the index tags straight off with
            // `ls-files -v`; any non-`H` entry means the tested bytes are
            // not the candidate's bytes. The read itself failing or
            // truncating is the same blindness class — fail closed.
            if (mutated === "") {
              const flags = await runObservedGit(dir, ["ls-files", "-v", "-z"], 10, { maxBytes: 4 * 1024 * 1024 });
              if (flags.code !== 0 || flags.truncated) {
                mutated = `index-flags-unreadable-post-gate:${flags.code}`;
              } else {
                for (const rec of flags.stdout.split("\0")) {
                  if (rec === "") continue;
                  if ((rec[0] ?? "?") !== "H") { mutated = `index-flag-post-gate:${rec[0]}:${rec.slice(2, 128)}`; break; }
                }
              }
            }
            // MG-C4-A3 (A3 BUG-staged-divergence): the fresh-index
            // status above proves ON-DISK bytes match HEAD, but the
            // gate worktree's OWN index is a second tree the audit
            // showed could diverge while every status stayed clean
            // (the gate `git add`s altered content, then restores the
            // worktree file — status clean, staged tree forged). A
            // staged-vs-HEAD comparison goes straight through the
            // INDEX ENTRIES' content (the stat cache plays no part in
            // a --cached tree comparison): any difference fails the
            // verdict closed. --quiet: exit 0 identical, 1 differs,
            // ≥128 unreadable — all three handled.
            if (mutated === "") {
              // --quiet (= --exit-code, no output): exit 1 means the
              // index differs from HEAD. Without it diff-index exits 0
              // even when entries differ — the staged-only fixture
              // integrated under exactly that (audit finding 1).
              const staged = await runObservedGit(dir, ["--no-optional-locks", "diff-index", "--cached", "--quiet", "--ignore-submodules=none", "--no-ext-diff", "HEAD", "--"], 15, { maxBytes: 1024 * 1024 });
              if (staged.code !== 0 || staged.truncated) {
                mutated = `staged-tree-divergence-post-gate:exit=${staged.code}${staged.truncated ? "+truncated" : ""}`;
              }
            }
            // MG-C4-A3 (A3 BUG-blob-overwrite class): the object store's
            // INTERNAL consistency is part of what the candidate IS. A
            // gate that overwrites a loose object at its hash path (or
            // prunes/grafts the store) makes the SAME sha resolve to
            // different bytes for the next reader while every PATH-level
            // digest stays silent. Empirical (git 2.54, this cycle):
            // `--connectivity-only` EXITED 0 on an overwritten loose
            // blob — it never re-hashes object CONTENT — so the check
            // must be the FULL fsck, which reports "hash-path mismatch"
            // + "missing blob" and exits 1. Run ONCE post-gate (the
            // verdict only needs to prove the store the merge will
            // consume is self-consistent NOW); --no-dangling/--no-root
            // keep the noise down and no path content is read or
            // disclosed (hashes only). Cost: a full store walk per
            // gate — accepted as the price of closing the
            // reinterpretation-at-identity class; a walk that CANNOT
            // finish inside the cap is an unknown, so truncation/
            // timeout fails closed like every other unobservability.
            if (mutated === "") {
              const fs = await runObservedGit(dir, ["fsck", "--no-progress", "--no-dangling", "--"], 300, { maxBytes: 512 * 1024 });
              if (fs.code !== 0 || fs.truncated) {
                mutated = `object-store-fsck-post-gate:exit=${fs.code}${fs.truncated ? "+truncated" : ""}:${fs.stdout.slice(0, 180).replace(/\s+/g, " ")}`;
              }
            }
            // P9 audit cycle-2 F1: replacement refs survive EVERY
            // observation honest-looking if the objects are substituted
            // (proven: HEAD, status, and ls-files all described the
            // SAFE substitute while the raw candidate stayed UNSAFE).
            // --no-replace-objects pins our OWN reads to raw objects, but
            // the refs' mere existence means the repository's shared
            // state was tampered with during the gate — any consumer
            // without the pin (a later operator, a tool on the repo)
            // resolves the substitute. Fail CLOSED: the presence of ANY
            // refs/replace entry after a candidate gate disqualifies it.
            if (mutated === "") {
              const rep = await runObservedGit(repoForMerge, ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/replace"], 10, { maxBytes: 256 * 1024 });
              if (rep.code !== 0 || rep.truncated) {
                mutated = "replace-refs-unreadable-post-gate";
              } else if (rep.stdout.trim() !== "") {
                mutated = "replacement-refs-post-gate";
              }
            }
            // MG-C3-1 (cycle-3 audit): the gate runs with write access
            // to its own worktree's .git — `git worktree move` or
            // `mv .git <evil> && ln -s <evil> .git` (or rewriting the
            // gitdir/commondir pointers) makes every post-gate read
            // describe a DIFFERENT repository while HEAD still resolves
            // to the candidate sha (the evil repo is an identical clone
            // — probe: post-gate status passed while the real worktree
            // held UNSAFE bytes). Re-check the gitdir identity
            // (realpath'd) AND the object-store layout digest taken
            // pre-gate: any drift fails the verdict closed.
            if (mutated === "") {
              const gitDirAfter = await runObservedGit(dir, ["rev-parse", "--absolute-git-dir"], 10, { maxBytes: 4096 });
              const commonDirAfter = await runObservedGit(dir, ["rev-parse", "--git-common-dir"], 10, { maxBytes: 4096 });
              if (gitDirAfter.code !== 0 || gitDirAfter.stdout.trim() === "" || commonDirAfter.code !== 0 || commonDirAfter.stdout.trim() === "") {
                mutated = "git-layout-unobservable-post-gate";
              } else {
                let gdRealAfter = "";
                let cdRealAfter = "";
                try { gdRealAfter = await realpath(resolve(dir, gitDirAfter.stdout.trim())); } catch { /* mismatch below */ }
                try { cdRealAfter = await realpath(resolve(dir, commonDirAfter.stdout.trim())); } catch { /* mismatch below */ }
                const beforeLines = layoutBefore.split("\n");
                if (gdRealAfter === "" || cdRealAfter === "" || gdRealAfter !== beforeLines[0] || cdRealAfter !== beforeLines[1]) {
                  mutated = "gitdir-relocated-post-gate";
                } else {
                  const layoutAfter = await gitLayoutDigest(gdRealAfter, cdRealAfter, dir);
                  if (layoutAfter !== (beforeLines[2] ?? "")) mutated = "git-layout-drift-post-gate";
                }
              }
            }
            }
          }
        }
        // MG-C4-A3 (A3 BUG timing-status residual) — KNOWN LIMITATION,
        // not closed. The chain above is a sequence of observations taken
        // while a gate-escaped writer (setsid) can still run. A writer
        // that rewrites tracked bytes after the fresh-index status and
        // before this verdict is accepted: reproduced on this build
        // (trace: status END #2 → MUTATE → verdict accepted; the final
        // scan below ran BEFORE the write). Re-running the observation
        // here narrows nothing it cannot prove — only preventing
        // concurrent writes (an enforced isolation boundary or an
        // immutable snapshot) closes it. The merged blob is object-
        // fetched and was proven original in that fixture, so the
        // impact is stale certification of the worktree, not a
        // changed merged tree. Tracked as the deferred enforcement item.
        if (mutated === "") {
          const postFilterArgsFinal = await filterNeutralizeArgs(dir);
          if (postFilterArgsFinal === null) {
            mutated = "filter-neutralize-unobservable-final-quiescence";
          } else {
            const idxDirF = await mkdtemp(join(tmpdir(), "tre-gate-idx-f-"));
            const idxPathF = join(idxDirF, "idx");
            try {
              const treeF = await runObservedGit(dir, [...postFilterArgsFinal, "read-tree", "HEAD"], 30, { maxBytes: 4 * 1024 * 1024, envExtra: { GIT_INDEX_FILE: idxPathF, GIT_ATTR_SOURCE: EMPTY_TREE_OID } });
              let idxStatF: Awaited<ReturnType<typeof lstat>> | null = null;
              try { idxStatF = await lstat(idxPathF); } catch { /* fail closed below */ }
              if (treeF.code !== 0 || treeF.truncated || idxStatF === null || idxStatF.size === 0) {
                mutated = "final-quiescence-index-unobservable";
              } else {
                // R5-B1: same cmd-line submodule pin as the post-gate status.
                const stF = await runObservedGit(dir, [...postFilterArgsFinal, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"], 10, { maxBytes: 4 * 1024 * 1024, envExtra: { GIT_INDEX_FILE: idxPathF, GIT_ATTR_SOURCE: EMPTY_TREE_OID } });
                if (stF.code !== 0 || stF.truncated) {
                  mutated = "final-quiescence-status-unreadable";
                } else {
                  for (const entry of stF.stdout.split("\0")) {
                    if (entry === "") continue;
                    const xy = entry.slice(0, 2);
                    const p = entry.slice(3);
                    const seg = p.split("/").pop() ?? "";
                    if (xy === "??" || xy === "!!") {
                      if (seg === ".gitattributes" || seg === ".gitmodules" || seg === ".gitignore") { mutated = `untracked-attributes-final-quiescence:${p.slice(0, 128)}`; break; }
                      continue;
                    }
                    mutated = `tracked-mutation-final-quiescence:${xy}`; break;
                  }
                }
              }
            } finally {
              await rm(idxDirF, { recursive: true, force: true }).catch(() => undefined);
            }
          }
        }
        const pass = r.cause === "exit" && r.code === 0 && mutated === "";
        try {
          const ref = await appendEvidence(epPath, greq.candidateSha, `merge-gate ${JSON.stringify(gateCmd)} exit=${r.cause === "exit" ? r.code : r.cause}${mutated !== "" ? ` [${mutated}]` : ""}\n${r.stdout.slice(-2048)}\n${r.stderr.slice(-2048)}`);
          return { pass, runId, sha: tested, detail: `exit=${r.cause === "exit" ? r.code : r.cause}${mutated !== "" ? `;${mutated}` : ""}; evidence=${ref}`.slice(0, 512) };
        } catch {
          // Evidence append failed — the verdict stands (the sha binding
          // is the worktree identity, not the evidence file), disclosed.
          return { pass, runId, sha: tested, detail: `exit=${r.cause === "exit" ? r.code : r.cause}${mutated !== "" ? `;${mutated}` : ""}; evidence-append-failed`.slice(0, 512) };
        }
      } finally {
        // NEVER leave a worktree registration or directory behind on ANY
        // path — including a failed or half-completed add (F3).
        if (added) await runObservedGit(repoForMerge, ["worktree", "remove", "--force", dir], 60).catch(() => undefined);
        try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        await runObservedGit(repoForMerge, ["worktree", "prune"], 60).catch(() => undefined);
      }
    },
  };
  const mergePort: ComposePorts["merge"] | undefined = opts.episodeBranch !== undefined
    ? {
        integrate: async (mreq) => {
          // P12's dedup identity is (repoRoot, episodeId, taskId,
          // episodeBranch, executionSeq) — WITHOUT a bumped seq a second
          // activation replays the first's terminal identity and P12
          // honestly answers already-executed (docs/16 §2: "recovery is a
          // NEW identity (bumped executionSeq)"). The host derives the
          // seq from the journal: the count of ACKED merge outcomes is
          // exactly the number of terminal identities already spent, so
          // the next integration gets the next unused seq — and a
          // restart with an OPEN (unacked) intent recomputes the SAME
          // seq the open intent carries, keeping recovery reachable.
          // P9 audit cycle-2 F2: the OLD count matched actionId by
          // PREFIX `a-${taskId}-merge-` — `t1-merge-x` outcomes embed
          // that prefix and bumped `t1`'s seq (skipping its recovery
          // identity). Count now requires the EXACT P12 action-id
          // grammar (`a-<taskId>-merge-<16 hex>`, the idDigest width)
          // AND the record's OWN episodeId/taskId identity — never
          // another task's terminal.
          // P9 audit cycle-2 F3: a terminal act-unknown outcome spends
          // the seq forever (never counted: counting it would authorize
          // a second external act under a fresh identity blindly). The
          // documented recovery is a NEW identity after reconciliation —
          // so the operator can raise the baseline explicitly via
          // opts.integrationSeqBump, and every act-unknown terminal is
          // DISCLOSED with that remedy on every activation.
          let executionSeq = opts.integrationSeqBump ?? 0;
          // p12c5 cycle-1 audit F3 (durable allocation): the count alone
          // LOSES spent seqs — a merge that ran under an operator-raised
          // bump leaves its terminal ABOVE the count, and the next plain
          // activation re-derives that spent identity: P12 honestly answers
          // already-executed and the task can never integrate new work.
          // Two-part fix: (a) the allocator takes max(bump, count, every
          // persisted seq-high-water record) — a LOWER bump can no longer
          // re-expose a spent seq; (b) each allocation at a NEW high-water
          // appends a seq-high-water record BEFORE the act (log-then-act),
          // so recovery no longer depends on the operator remembering the
          // historical bump flag. Re-deriving the SAME seq across a restart
          // stays reachable (max is idempotent): open-intent recovery under
          // an unchanged journal head computes the identical seq.
          let highWater = 0;
          try {
            const { records } = await integrationJournal.read();
            const exactMergeId = new RegExp(`^a-${(mreq.taskId as string).replace(/[^A-Za-z0-9._-]/g, "\\$&")}-merge-[0-9a-f]{16}$`);
            let actUnknown = 0;
            for (const r of records) {
              if (typeof r !== "object" || r === null) continue;
              const rec = r as { kind?: unknown; acked?: unknown; actionId?: unknown; episodeId?: unknown; taskId?: unknown; notes?: unknown };
              if (rec.kind !== "decision-outcome" || typeof rec.actionId !== "string" || !exactMergeId.test(rec.actionId)) continue;
              if (rec.episodeId !== mreq.episodeId || rec.taskId !== mreq.taskId) continue;
              // P9 audit cycle-3 F2: mirror P12's OWN sticky rule
              // (merge.ts dedup scan): an unacked outcome is a terminal
              // act-unknown ONLY when its notes do not start with
              // "no-effect:" — a PROVABLY effect-free refusal (clean CAS
              // rejection, stale-lock refusal) stays replayable under the
              // SAME identity and must never be announced as stranded.
              if (rec.acked === true) executionSeq++;
              else if (typeof rec.notes !== "string" || !rec.notes.startsWith("no-effect:")) actUnknown++;
            }
            // MG-C5-A3 (round-2 audit): the remedy hint is NOT emitted
            // here any more — see the post-derivation block below. The
            // bump recommendation must exceed the FINAL seq (count AND
            // held high-water); advising before the high-water is folded
            // in recommended a bump that the same journal still refused.
            // F3 (a): a persisted high-water beats a stale/lower bump —
            // spent seqs are remembered DURABLY, not by operator flag.
            // p12c5 cycle-2 audit C2-F3: a high-water record only
            // PROVES its seq was SPENT when the identity reached an
            // ACKED terminal outcome. The old unconditional
            // `rec.seq + 1` advanced past a CRASHED allocation (intent
            // appended, no outcome) — the next activation derived a
            // NEW actionId and P12's open-intent recovery could never
            // see the stranded intent; an act-unknown terminal likewise
            // got advanced past, executing a fresh identity WITHOUT
            // the reconciliation + explicit operator bump the contract
            // requires (the act-unknown terminal lives on the OLD seq,
            // so P12 cannot refuse the new one). Terminal facts are
            // read from the outcome's OWN identity: the record id
            // embeds the allocation seq (`<actionId>#o<seq>[r<k>][f]`
            // — the exact suffix grammar merge.ts lines pin); an
            // unparseable id consumes nothing (fail toward holding,
            // never toward a blind new identity).
            const consumedSeq = new Set<number>();
            for (const r of records) {
              if (typeof r !== "object" || r === null) continue;
              const rec = r as { kind?: unknown; acked?: unknown; actionId?: unknown; episodeId?: unknown; taskId?: unknown; id?: unknown };
              if (rec.kind !== "decision-outcome" || rec.acked !== true) continue;
              if (typeof rec.actionId !== "string" || !exactMergeId.test(rec.actionId)) continue;
              if (rec.episodeId !== mreq.episodeId || rec.taskId !== mreq.taskId) continue;
              if (typeof rec.id !== "string") continue;
              const tail = rec.id.slice(`${rec.actionId}#o`.length);
              const m = /^(\d+)(?:r\d+)?f?$/.exec(tail);
              const allocated = m?.[1] === undefined ? Number.NaN : Number.parseInt(m[1], 10);
              if (Number.isSafeInteger(allocated) && allocated >= 0) consumedSeq.add(allocated);
            }
            for (const r of records) {
              if (typeof r !== "object" || r === null) continue;
              const rec = r as { kind?: unknown; episodeId?: unknown; taskId?: unknown; seq?: unknown };
              if (rec.kind !== "seq-high-water" || rec.episodeId !== mreq.episodeId || rec.taskId !== mreq.taskId) continue;
              if (typeof rec.seq !== "number" || !Number.isSafeInteger(rec.seq) || rec.seq < 0) continue;
              // C2-F3: advance ONLY past CONSUMED allocations (acked
              // terminal observed for that identity). An open intent
              // or an act-unknown/no-effect terminal holds the line:
              // the next activation re-derives the SAME seq, where
              // P12 either recovers the intent on observed reality,
              // replays a provable no-effect, or refuses
              // not-replayable with the operator-bump remedy disclosed
              // above — the three dispositions the contract names.
              // Audit finding 3: an UNRESOLVED allocation (no acked
              // outcome) must still be HELD, not skipped. Skipping it
              // let a restart re-derive seq 0 while the open intent
              // (or act-unknown terminal) lived at the bumped seq,
              // bypassing its recovery. Hold = the allocator must not
              // go BELOW the highest persisted allocation: an
              // unresolved seq is re-derived (executionSeq = seq), so
              // P12 recovers it; a consumed seq advances past it.
              if (consumedSeq.has(rec.seq)) {
                if (rec.seq + 1 > highWater) highWater = rec.seq + 1;
              } else if (rec.seq > highWater) {
                highWater = rec.seq;
              }
            }
            if (highWater > executionSeq) executionSeq = highWater;
            // MG-C5-A3 (round-2 audit): emit the act-unknown remedy ONLY
            // after the final seq is derived (count AND held high-water).
            // Seeding an act-unknown terminal at seq7 + high-water7 made
            // the old pre-derivation hint advise `--integration-seq-bump
            // 1` (count was 0): following it re-derived seq 7 — under the
            // held high-water — and P12 refused AGAIN, one bump short.
            // The remedy must EXCEED the derivation the same journal
            // produces, so a fresh actUnknown set recomputes the advice
            // from the completed state: max(executionSeq, seq of each
            // act-unknown terminal) + 1.
            if (actUnknown > 0) {
              let strandedSeq = executionSeq;
              try {
                for (const r of records) {
                  if (typeof r !== "object" || r === null) continue;
                  const rec = r as { kind?: unknown; acked?: unknown; actionId?: unknown; episodeId?: unknown; taskId?: unknown; id?: unknown; notes?: unknown };
                  if (rec.kind !== "decision-outcome" || rec.acked === true) continue;
                  if (typeof rec.actionId !== "string" || !exactMergeId.test(rec.actionId)) continue;
                  if (rec.episodeId !== mreq.episodeId || rec.taskId !== mreq.taskId) continue;
                  if (typeof rec.notes === "string" && rec.notes.startsWith("no-effect:")) continue;
                  const m = typeof rec.id === "string" ? /^(\d+)(?:r\d+)?f?$/.exec(rec.id.slice(`${rec.actionId}#o`.length)) : null;
                  const seqOfTerminal = m?.[1] === undefined ? Number.NaN : Number.parseInt(m[1], 10);
                  if (Number.isSafeInteger(seqOfTerminal) && seqOfTerminal > strandedSeq) strandedSeq = seqOfTerminal;
                }
              } catch { /* hint degrades to executionSeq+1 */ }
              log(`integration-act-unknown: ${actUnknown} merge terminal(s) with unverified side effect at/below the current seq — P12 refuses replay (not-replayable, docs/16 §2); after RECONCILING observed reality (did the CAS land?), an operator-authorized recovery runs with --integration-seq-bump ${String(strandedSeq + 1)}`);
            }
            // F3 (b): log-then-act. Record the allocation BEFORE the
            // merge runs (id-stable per (episode, task, seq), so a retry
            // after a failed append re-records the same tuple). An append
            // failure DEGRADES to the pre-fix derivation — the CAS and
            // P12's dedup still refuse a double act — and is disclosed.
            // Re-deriving the SAME seq across a restart re-appends the
            // same value: max is idempotent, open-intent recovery under
            // an unchanged journal head still computes the identical seq.
            if (executionSeq >= highWater) {
              try {
                await integrationJournal.append({
                  schema: "tre-supervisor/1", kind: "seq-high-water",
                  id: `seqhw-${mreq.episodeId}-${mreq.taskId}-${String(executionSeq)}`,
                  ts: Math.floor(mreq.now), episodeId: mreq.episodeId, taskId: mreq.taskId,
                  seq: executionSeq,
                });
              } catch (e) {
                log(`integration-seq-high-water:append-failed seq=${String(executionSeq)} ${(e as Error)?.name ?? "error"} (spent-seq memory degraded for this allocation)`);
              }
            }
          } catch { /* a read failure falls back to the bumped baseline;
                      P12's own journal guards still refuse a replay honestly */ }
          return integrateTestedCandidate(
            {
              repoRoot: repoForMerge,
              episodeId: mreq.episodeId,
              taskId: mreq.taskId,
              episodeBranch: opts.episodeBranch as string,
              now: mreq.now,
              grantedBy: mreq.grantedBy,
              executionSeq,
            },
            { journal: integrationJournal, gate: integrationGate },
          );
        },
      }
    : undefined;
  if (mergePort !== undefined) {
    // Disclosure, not policy: the operator sees WHAT the merge acts on.
    // Without an explicit worktree the declared repo is the process cwd
    // and P12's own resolve stage refuses honestly (never a silent
    // merge somewhere else) — that is disclosed too.
    log(`merge-port:injected branch=${opts.episodeBranch} repo=${repoForMerge}${opts.worktreePath === undefined ? " (cwd fallback: merges will resolve-refuse)" : ""}`);
  }

  const ports: ComposePorts = {
    ...(mergePort !== undefined ? { merge: mergePort } : {}),
    planner: { planRecovery: (input) => planRecovery(input as Parameters<typeof planRecovery>[0]) },
    executor: { executeRecoveryAction: (plan, ctx, p) => executeRecoveryAction(plan, ctx as never, p as never) },
    executorPorts,
    runner: runnerPort,
    gate: loopGate,
    accept: acceptPort,
    investigate: async (packet, limits) => runInvestigation(packet as never, { now }, Object.keys(limits).length > 0 ? { limits } : undefined),
    journal: journalPort,
    steer: {
      poll: async () => {
        const items = steerQueue.drain();
        const texts: string[] = [];
        let shutdown = false;
        for (const item of items) {
          const text = typeof item === "string" ? item : item.text;
          if (text.trim() === "shutdown") { shutdown = true; continue; }
          texts.push(text);
        }
        return { texts, shutdown };
      },
    },
    now,
    log,
  };

  const cfg: SupervisorConfig = {
    episodeId: graph.episodeId,
    taskId: opts.taskId,
    ...(task.revision !== undefined ? { taskRevision: task.revision } : {}),
    grantedBy: opts.grantedBy,
    worker: { session: sessionPath, ...(task.model !== undefined ? { model: task.model } : {}), ...(opts.worktreePath !== undefined ? { worktreePath: opts.worktreePath } : {}) },
    authority: graph.policy?.authority ?? { paths: [], notPaths: [] },
    acceptance: { spec: acceptanceSpecFrom(task.acceptance), ...(graph.policy?.baseCommit !== undefined ? { current: { sha: graph.policy.baseCommit } } : {}) },
    ...(graph.policy?.recoveryBudget !== undefined ? { recoveryBudget: { ...graph.policy.recoveryBudget } } : {}),
    ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
    // P9 audit cycle-1 F4: activation-unique intent namespace. The lease
    // token is exactly the activation's ownership identity; deriving the
    // scope from it means a restarted activation can never reissue the
    // previous one's intent ids (and thus never mask its orphaned merge).
    intentScope: lease.token,
    // P9 audit cycle-1 F5: the operator's declared branch IS the
    // integration trigger — a COMPLETE verdict dispatches the merge act
    // inside the loop under the lease (no post-run seam exists anymore).
    ...(mergePort !== undefined ? { integration: { trigger: "on-finish" as const } } : {}),
  };

  try {
    const result = await runSupervisorEpisode(cfg, ports);
    return {
      result,
      episodePath: epPath,
      steerStats: { linesRead: steerQueue.getStats().linesRead, injected: steerQueue.getStats().injected, malformed: steerQueue.getStats().malformed },
      // c5d BUG-1 (Sol audit): the OLD seam returned the raw `runPark`
      // closure — callable after this lease was released, so a STALE
      // activation could move/write the CURRENT owner's state.json under
      // the new owner's lease (reproduced: lease-seam probe). The seam now
      // re-establishes ownership PER CALL: it claims a FRESH lease and
      // refuses (throws, state untouched) while any live holder owns the
      // episode — the same exclusion every activation path obeys. (Note
      // `lease.held()` could NOT gate this: the release above never clears
      // the flag, and by contract the caller receives this object only
      // after the release ran — post-run ownership is NEVER ours.) The
      // IN-LOOP park act stays direct (ports.park = runPark, under the
      // activation's own lease). Releases on completion.
      parkTask: async (): Promise<void> => {
        const own = await acquireEpisodeLease({ epPath, epId, episodeId: graph.episodeId, log, ...(opts.leaseSwapHoldMs !== undefined ? { leaseSwapHoldMs: opts.leaseSwapHoldMs } : {}) });
        try { await runPark(); } finally {
          // c5e BUG-1 (Sol round 2): release() RETURNS "failed" on a
          // persistent read/unlink error — it never throws — and the
          // P20c6-F2 contract says the caller MUST disclose (a live-pid
          // claim of ours is still on disk). The old one-liner swallowed
          // it (reproduced: silent wedge until process exit). Same
          // disclosure as the two activation finallys.
          if (await own.release() === "failed") log(`c5e-BUG-1: parkTask lease release FAILED after 3 attempts on ${own.path} — our claim may persist until this process exits (recoverable: takeover reclaims a dead-pid lease with disclosure)`);
        }
      },
      // P9 audit cycle-1 F1: NO post-run merge seam — integration
      // dispatches IN the loop (cfg.integration.trigger, docs/16 §0.6)
      // while the lease is held. A closure returned here would act
      // outside our ownership (the release above runs before the caller
      // receives this object).
    };
  } finally {
    try { runner.close(true); } catch (e) { log(`runner-close: ${(e as Error)?.name ?? "error"}`); }
  }
  } finally {
    // P18-A4 / P18-C3 F2: release ONLY a lease carrying OUR ownership
    // token — a pid alone is ambiguous after pid reuse or after another
    // process's takeover.
    // P20c3-F3 (audit cycle 2, finding 3): the old release used
    // raw.includes(token) — a SUBSTRING match anywhere in the body. A
    // foreign lease merely EMBEDDING our token (e.g. a forensic
    // `{previous:{token:...}}` written by a predecessor) released the
    // wrong lease (reproduced). Release now requires the WHOLE body to
    // parse as an object whose TOP-LEVEL token equals ours — nested
    // occurrences never match. (The read→unlink window is a residual
    // TOCTOU of any check-then-unlink without a compare-and-delete
    // primitive; the takeover side fences it by re-verifying staleness
    // under the lock before acting.)
    if (lease.held()) {
      // P20c6-F2: the release is the SAME strict, token-verified,
      // RETRIED path as the takeover anomaly self-release. The old
      // single-shot read+unlink in one swallow-everything catch could
      // leave our claim on disk on a transient I/O error with NO
      // evidence anywhere — the next activation then faced (and could
      // wedge on) a lease naming our live pid until exit. A failed
      // release is now surfaced on the log; it stays recoverable (the
      // lease holds a real pid: takeover refuses while we live,
      // reclaims with disclosure after we exit).
      const outcome = await lease.release();
      if (outcome === "failed") {
        log(`P20c6-F2: lease release FAILED after 3 attempts on ${lease.path} — our claim may persist until this process exits (recoverable: takeover reclaims a dead-pid lease with disclosure)`);
      }
    }
  }
}

export interface HostScheduleEpisodeOptions extends Omit<HostEpisodeOptions, "taskId"> {
  maxParallel?: number;
  /** In-process test seam: never a CLI option, never starts another host. */
  loop?: typeof runSupervisorEpisode;
}

export interface HostScheduleEpisodeResult {
  result: SupervisorResult;
  episodePath: string;
  taskOutcomes: SchedulerResult["tasks"];
  admissions: number;
  denials: SchedulerResult["denials"];
  disclosures: string[];
}

/** M2 admission + supervision slice. Deliberately separate from M1's
 * closure-heavy wiring. Merge, repair, and revision rewrite are NOT wired:
 * requested integration remains an on-finish trigger and therefore fails
 * closed through merge-unwired, never reports an unintegrated success.
 * Without policy.repoPath no isolation is promised (shared cwd, disclosed).
 * Shutdown source: <episode>/shutdown marker; sticky until operator removes
 * it. Both scheduler admission and task steer boundaries observe it.
 */
export async function runScheduledHostEpisode(opts: HostScheduleEpisodeOptions): Promise<HostScheduleEpisodeResult> {
  const log = (line: string): void => { try { (opts.log ?? ((s) => process.stderr.write(`${s}\n`)))(`sched: ${line}`); } catch { /* reporting only */ } };
  const graph = opts.graphPath !== undefined ? await readEpisodeGraph(opts.graphPath) : opts.graph;
  if (!graph) throw new Error("host: either graphPath or graph is required");
  assertId(graph.episodeId, "episodeId");
  assertId(opts.grantedBy, "grantedBy");
  for (const task of graph.tasks) assertId(task.id, "taskId");
  if (opts.maxParallel !== undefined && (!Number.isSafeInteger(opts.maxParallel) || opts.maxParallel < 1)) throw new Error("host: maxParallel must be a positive integer");
  const root = opts.episodesRoot ?? join(process.env["HOME"] ?? "/tmp", ".tre", "episodes");
  const epPath = episodeDir(root, graph.episodeId);
  const epId = await epPathIdentity(epPath);
  const lease = await acquireEpisodeLease({ epPath, epId, episodeId: graph.episodeId, log, leaseSwapHoldMs: opts.leaseSwapHoldMs });
  try {
    await createEpisodeLayout(root, graph.episodeId, graph);
    const journal = await DecisionJournal.forEpisode(epPath);
    const ledger = await BudgetLedger.forEpisode(epPath);
    const policy = gatePolicyFromGraph(graph, epPath);
    const disclosures = ["merge/repair/rewrite ports unwired in schedule mode; requested integration fails closed"];
    const paths = new Map<string, string>();
    // Additive graph policy extension; P4 preserves unknown policy fields.
    const repoPath = (graph.policy as { repoPath?: unknown } | undefined)?.repoPath;
    let worktrees: SchedulerDeps["worktrees"];
    if (typeof repoPath === "string" && repoPath.length > 0) {
      // Open lazily inside ensure: a provisioning refusal parks that task,
      // rather than throwing the entire episode out of activation.
      let provisioner: Promise<WorktreeProvisioner> | undefined;
      worktrees = { ensure: async (taskId) => {
        try {
          provisioner ??= WorktreeProvisioner.open({ repoRoot: repoPath, wtRoot: join(epPath, "worktrees"), warn: log });
          if (!graph.policy?.baseCommit) return { refused: "missing-baseCommit" };
          const wt = await (await provisioner).ensureTaskWorktree({ episodeId: graph.episodeId, taskId, baseCommit: graph.policy.baseCommit });
          paths.set(taskId, wt.path);
          return { path: wt.path };
        } catch (e) { return { refused: String((e as { code?: string }).code ?? "provision-failed") }; }
      },
      // M3 (D4 lift): conservative auto-removal on accepted `done`.
      // UNFORCED removeTaskWorktree — a dirty tree, a lock, a foreign
      // branch or a stale registration is KEPT and returned as `{ kept }`
      // for the scheduler's journal; the branch is NEVER deleted (P12
      // territory). Removal failure can never fail the task: the fate
      // was already decided; this only reclaims disk.
      release: async (taskId) => {
        // Audit-haiku F5: every no-removal path returns a DISTINCT
        // outcome — a missing provisioner or a git-level noop means
        // NOTHING was removed (journalized `noop` by the scheduler),
        // never a false `released`.
        if (provisioner === undefined) return { noop: true, detail: "nothing was ever provisioned" };
        try {
          const rep = await (await provisioner).removeTaskWorktree({ episodeId: graph.episodeId, taskId });
          paths.delete(taskId);
          return rep.noop ? { noop: true, detail: "no registered worktree" } : undefined;
        } catch (e) {
          const code = String((e as { code?: string }).code ?? "remove-failed");
          const msg = (e as Error)?.message;
          return typeof msg === "string" && msg.length > 0 ? { kept: code, detail: msg.slice(0, 300) } : { kept: code };
        }
      } };
    } else {
      disclosures.push("NO per-task isolation: policy.repoPath absent; tasks run in the shared tree");
    }
    disclosures.forEach(log);
    const sessionFor = (id: string): string => join(epPath, "sessions", `${id}.jsonl`);
    const treeFor = (id: string): string | undefined => paths.get(id) ?? opts.worktreePath;
    const escalationPath = join(epPath, "events", "escalations.jsonl");
    const escalation = makeEscalationChannel({ now,
      append: async (rec) => { await appendFile(escalationPath, JSON.stringify(rec) + "\n", "utf8"); },
      read: async () => {
        const raw = await readFile(escalationPath, "utf8").catch((e: unknown) => {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
          throw e;
        });
        return raw.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) as unknown; } catch { return line; } });
      },
      ...(opts.escalationDeliver ? { deliver: opts.escalationDeliver } : {}),
    });
    const dispatcher = makeEscalationDispatcher({ channel: escalation });
    const acceptanceKeys = new Map<string, { ts: number; id: string }>();
    const journalPort: ComposePorts["journal"] = {
      append: async (rec) => {
        const r = rec as SupervisorRecord;
        await journal.append(r);
        if (r.kind === "acceptance" && r.taskId) acceptanceKeys.set(r.taskId, { ts: r.ts, id: r.id });
      },
      read: async () => journal.read(),
    };
    // P4 has a closed record-kind set. Preserve scheduler payloads in
    // decision-outcome notes, with the scheduler's activation-unique id.
    const schedulerJournal = { append: async (record: object): Promise<void> => {
      const r = record as { episodeId: string; taskId: string; actionId: string; ts: number; seq: number };
      await journal.append({ kind: "decision-outcome", schema: "tre-supervisor/1", episodeId: r.episodeId, taskId: r.taskId,
        id: `sched-${r.actionId}`, actionId: r.actionId, ts: r.ts, acked: true, progress: "none", notes: JSON.stringify(record) } as SupervisorRecord);
    } };
    const shutdown = { poll: async (): Promise<boolean> => {
      try { await stat(join(epPath, "shutdown")); return true; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
    } };
    const firstReservation = new Map<string, string>();
    const admissionCheck = makeLedgerAdmissionCheck({ ledger, policy, now, log,
      reservationActionIdOf: (id) => firstReservation.get(id),
      // No estimate field is defined in P4; honor additive raised estimates.
      floorOf: (id) => {
        const task = graph.tasks.find((t) => t.id === id) as { estimate?: { usd: number; turns: number } } | undefined;
        return task?.estimate ?? { usd: 0, turns: 0 }; // adapter clamps to class default
      },
    });
    const runner = await AttemptRunner.open({ root, episodeId: graph.episodeId,
      ...(opts.workerCommand ? { spawner: { kind: `tre:${opts.workerCommand}`, spawn: (t: AttemptTask, attemptId: string, o?: { resume?: boolean }) => ({
        command: opts.workerCommand!, args: [o?.resume ? "--resume" : "--session", t.session], cwd: t.worktreePath,
        env: { ...process.env, TRE_ATTEMPT_ID: attemptId, TRE_EPISODE_ID: t.episodeId, TRE_TASK_ID: t.taskId },
      }) } } : {}),
    });
    try {
      // M2 audit cycle 2 (R2): docs/20 §12 describes S6 state.json slots
      // as a DERIVED projection rebuilt from the scheduler's live set on
      // each write. Before this, the host wrote state.json exactly once —
      // at episode end, when the live set was necessarily empty — so a
      // mid-run reader only ever saw `slots: {}`. The scheduler now
      // publishes its live set (taskId -> endpoint) on every admission/
      // terminal/swap via deps.onLiveSet; this projection rebuilds the
      // scheduler endpoint-shape into state.json's slots shape and writes
      // it. The projection is OUTPUT ONLY — never read back as admission
      // authority (the scheduler's in-memory live set is the single source
      // of truth) — and each write RMWs to preserve any task rows the
      // runner's state.json hint cache wrote concurrently. Writes are
      // serialized behind a promise chain (last publish wins) and a
      // failure is disclosed, never fatal: state.json is a cache (S6).
      let stateWrite = Promise.resolve();
      const liveSlots = new Map<string, string>();
      const writeSlotsProjection = (): void => {
        const slots = Object.fromEntries([...liveSlots.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
        stateWrite = stateWrite.then(async () => {
          const statePath = join(epPath, "state.json");
          let existing: EpisodeState | undefined;
          try {
            existing = await readEpisodeState(statePath);
          } catch (e) {
            const code = (e as NodeJS.ErrnoException)?.code;
            // W1-M7 (audit cycle W1), the SAME rule runPark applies: ENOENT
            // is the only "genuinely absent" case — starting fresh there is
            // safe. Any OTHER read failure (corrupt JSON, EACCES) means the
            // bytes may hold other tasks' state AND are forensic evidence
            // (an M2 audit c2 finding: the old `catch { existing = undefined }`
            // then OVERWROTE the file, destroying it mid-run). Fail closed:
            // move the bytes aside, disclose on the host log, and SKIP this
            // projection write. Never throw — a projection is disclosure
            // only and the scheduler's admission/terminal path must be
            // unaffected (state.json is a cache, S6).
            if (code !== "ENOENT") {
              const preserve = await preserveAside(statePath).catch(() => undefined);
              if (preserve === undefined) { log(`state.json projection: state.json unreadable (${code ?? (e as Error)?.name ?? "parse"}) AND preserve failed — NOTHING overwritten, slots projection write SKIPPED`); }
              else { log(`state.json projection: state.json unreadable (${code ?? (e as Error)?.name ?? "parse"}) — preserved as ${preserve}, slots projection write SKIPPED`); }
              return;
            }
            existing = undefined;
          }
          const merged: EpisodeState = { ...(existing ?? { schema: "tre-episode-state/1", episodeId: graph.episodeId, tasks: {} }) };
          await writeEpisodeState(statePath, { ...merged, slots });
        }).catch((e: unknown) => { log(`state.json projection write failed (cache only, S6): ${String((e as Error)?.message ?? e).slice(0, 120)}`); });
      };
      const deps: SchedulerDeps = {
        activation: lease.token,
        graph: { read: async () => graph },
        loop: (cfg, ports) => (opts.loop ?? runSupervisorEpisode)(cfg as SupervisorConfig, ports as ComposePorts),
        loopConfig: (t): SupervisorConfig => {
          const task = graph.tasks.find((x) => x.id === t.id)!;
          return {
            episodeId: graph.episodeId, taskId: t.id, taskRevision: task.revision,
            grantedBy: opts.grantedBy, intentScope: lease.token,
            worker: { session: sessionFor(t.id), model: t.model, worktreePath: treeFor(t.id) },
            authority: graph.policy?.authority ?? { paths: [], notPaths: [] },
            acceptance: { spec: acceptanceSpecFrom(task.acceptance), ...(graph.policy?.baseCommit ? { current: { sha: graph.policy.baseCommit } } : {}) },
            recoveryBudget: graph.policy?.recoveryBudget, maxIterations: opts.maxIterations,
            ...(opts.episodeBranch ? { integration: { trigger: "on-finish" as const } } : {}),
          };
        },
        loopPorts: (t, hooks): ComposePorts => {
          const session = sessionFor(t.id);
          const steerPath = join(epPath, "steer", `${t.id}.jsonl`);
          const queue = new FileSteeringQueue({ path: steerPath, sessionPath: session });
          const gate: GatePort = {
            check: async (req) => ledgerCheck(policy, toLedgerRequest(req, t.id), await ledger.snapshotAt(now()), now()),
            reserve: async (req, receipt) => {
              const rec = await ledger.reserve(policy, toLedgerRequest(req, t.id), receipt as ActionReceipt);
              if (!firstReservation.has(t.id)) firstReservation.set(t.id, req.actionId);
              return { id: rec.id };
            },
            closeReservation: (ref, why, attest) => ledger.closeReservation(ref, why, attest),
            ingestSession: (s, scope) => ledger.ingestSession(s, scope),
            recordManualSpend: (s, scope) => ledger.recordManualSpend(s, scope),
            recordWallclock: (scope, seconds) => ledger.recordWallclock(scope, seconds),
          };
          const receipts = new Map<string, { req: LedgerGateRequest; receipt: ActionReceipt }>();
          const executorGate = {
            check: async (_p: unknown, req: GateRequestLike) => {
              const lr = toLedgerRequest(req, t.id);
              const res = ledgerCheck(policy, lr, await ledger.snapshotAt(now()), now());
              if (res.allowed && res.receipt) {
                if (receipts.size >= 64) receipts.delete(receipts.keys().next().value!);
                receipts.set(req.actionId, { req: lr, receipt: res.receipt });
              }
              return res;
            },
            reserve: async (_p: unknown, req: { actionId: string }) => {
              const hit = receipts.get(req.actionId);
              if (!hit) throw new Error("host gate: check receipt required");
              receipts.delete(req.actionId);
              const rec = await ledger.reserve(policy, hit.req, hit.receipt);
              if (!firstReservation.has(t.id)) firstReservation.set(t.id, req.actionId);
              return rec;
            },
            closeReservation: gate.closeReservation,
          };
          let model = t.model;
          const runnerPort: RunnerPort = {
            run: (task) => runner.run({ ...task, episodeId: graph.episodeId, session, worktreePath: treeFor(t.id) }),
            reconcile: () => runner.reconcile({ episodeId: graph.episodeId, taskId: t.id, session, worktreePath: treeFor(t.id) }),
            resume: async (task, attemptId) => {
              const target = (task as { model?: string }).model ?? model;
              if (!hooks.capacitySwap(target, model)) throw new Error("capacity:full");
              model = target;
              return runner.resume({ episodeId: graph.episodeId, taskId: t.id, session, model, worktreePath: treeFor(t.id) }, attemptId);
            },
            stop: (h) => runner.stop({ session: h.session }),
          };
          const discloseDelivery = (r: { channel: string }): void => {
            log(`${t.id}: ${r.channel.startsWith("escalation:") ? "question NOT delivered" : "question dispatched"} (${r.channel})`);
          };
          return {
            planner: { planRecovery: (input) => planRecovery(input as Parameters<typeof planRecovery>[0]) },
            executor: { executeRecoveryAction: (plan, ctx, ports) => executeRecoveryAction(plan, ctx as never, ports as never) },
            executorPorts: { journal: journalPort, gate: executorGate,
              steer: { push: async (req: object) => { await appendFile(steerPath, JSON.stringify(req) + "\n", "utf8"); } },
              dispatch: {
                investigate: async (req: object) => {
                  const diag = await hooks.investigate({ ...req, episodeId: graph.episodeId, taskId: t.id }, {});
                  return { evidenceRefs: (diag as { evidenceRefs?: string[] }).evidenceRefs ?? [] };
                },
                repair: async () => { throw new Error("host: schedule repair unwired"); },
                rewriteTask: async () => { throw new Error("host: schedule rewrite unwired"); },
                escalate: async (req: object) => {
                  const res = await dispatcher.escalate({ ...req, episodeId: graph.episodeId, taskId: t.id });
                  discloseDelivery(res); return { channel: res.channel };
                },
                park: async () => { discloseDelivery(await dispatcher.park({ episodeId: graph.episodeId, taskId: t.id })); },
              },
            },
            runner: runnerPort, gate, journal: journalPort,
            investigate: hooks.investigate,
            accept: { evaluate: async () => evaluateAcceptance(await collectAcceptanceEvidence({ graph, taskId: t.id, epPath, worktreePath: treeFor(t.id) })) },
            steer: { poll: async () => {
              let stopped = await shutdown.poll();
              const texts: string[] = [];
              for (const item of queue.drain()) {
                const text = typeof item === "string" ? item : item.text;
                if (text.trim() === "shutdown") stopped = true; else texts.push(text);
              }
              return { texts, shutdown: stopped };
            } }, now, log,
          };
        },
        investigate: (_t, packet, limits) => runInvestigation(packet as never, { now }, Object.keys(limits).length ? { limits } : undefined),
        capacity: { read: async () => readFile(join(process.env["HOME"] ?? "/tmp", ".tre", "episodes", "capacity.json"), "utf8").catch((e: unknown) => {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw e;
        }) },
        maxParallel: opts.maxParallel, worktrees, admissionCheck, journal: schedulerJournal,
        onLiveSet: (live) => {
          liveSlots.clear();
          for (const { taskId, endpoint } of live) liveSlots.set(`${endpoint}#${taskId}`, taskId);
          writeSlotsProjection();
        },
        acceptanceFor: async (t) => {
          const { records } = await journal.read();
          const key = acceptanceKeys.get(t.id);
          const rec = [...records].reverse().find((r) => r.kind === "acceptance" && r.taskId === t.id && key !== undefined && r.id === key.id);
          return rec?.kind === "acceptance" ? rec.verdict : undefined;
        },
        shutdown, clock: { now }, log,
      };
      const res = await runSchedulerEpisode({ episodeId: graph.episodeId }, deps);
      // runSchedulerEpisode returns ONLY after draining its live map. Thus
      // the terminal live projection is empty, including shutdown. Never
      // read or use state.json as admission authority — it is OUTPUT. The
      // final write folds the derived terminal task rows in and stamps the
      // empty terminal live set; it waits for the last mid-run projection
      // write to settle, and RMWs to preserve any concurrent runner hint
      // rows (S6 cache semantics — the scheduler remains the sole source
      // of the slots projection).
      await stateWrite;
      let finalState: EpisodeState | undefined;
      let finalWritable = true;
      const finalPath = join(epPath, "state.json");
      try {
        finalState = await readEpisodeState(finalPath);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") {
          // W1-M7 (audit cycle W1), the SAME rule runPark applies — chosen
          // here explicitly as "preserve-aside + SKIP the merge write
          // entirely" (matching runPark's precedent), NOT "write a fresh
          // object after preserving": the corrupt bytes are forensic
          // evidence and this terminal write is a derived cache refresh,
          // so there is nothing worth reconstructing at the cost of
          // producing a file that looks like a clean terminal state. The
          // bytes are moved aside (never destroyed), disclosed on the host
          // log, and the terminal merge write is skipped; the episode
          // result below is unaffected (state.json is a cache, S6).
          finalWritable = false;
          const preserve = await preserveAside(finalPath).catch(() => undefined);
          if (preserve === undefined) { log(`state.json final write: state.json unreadable (${code ?? (e as Error)?.name ?? "parse"}) AND preserve failed — NOTHING overwritten, terminal merge write SKIPPED`); }
          else { log(`state.json final write: state.json unreadable (${code ?? (e as Error)?.name ?? "parse"}) — preserved as ${preserve}, terminal merge write SKIPPED`); }
        }
        finalState = undefined;
      }
      if (finalWritable) {
        await writeEpisodeState(finalPath, {
          ...(finalState ?? { schema: "tre-episode-state/1", episodeId: graph.episodeId, tasks: {} }),
          tasks: Object.fromEntries(Object.entries(res.tasks).map(([id, fate]) => [id, { status: fate.status }])),
          slots: {},
        });
      }
      return {
        result: { stopped: res.stopped === "quiesced-complete" ? "completed" : res.stopped === "shutdown" ? "shutdown" : "halt", detail: res.detail ?? res.stopped, iterations: [], investigationCount: res.observerGrants },
        episodePath: epPath, taskOutcomes: res.tasks, admissions: res.admissions, denials: res.denials,
        disclosures: [...disclosures, ...res.disclosures],
      };
    } finally { try { runner.close(true); } catch { log("runner-close failed"); } }
  } finally {
    if (lease.held() && await lease.release() === "failed") log(`lease release FAILED after 3 attempts on ${lease.path}`);
  }
}

// Re-exported so callers (and the integration test) can validate records
// without importing P4 directly through a second path.
export { validateSupervisorRecord };
