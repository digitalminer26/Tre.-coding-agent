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

import { appendFile, mkdir, readFile, rename, lstat, open, readlink, stat, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";

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
  type SupervisorRecord,
  type TaskAcceptance,
} from "../episode/journal.js";
import { evaluate as evaluateAcceptance } from "../acceptance/evaluator.js";
import type { GateResult, ArtifactEvidence, ArtifactIdentity, EvaluateInput, AcceptanceAssessment } from "../acceptance/evaluator.js";
import { runSupervisorEpisode, type ComposePorts, type GatePort, type GateRequestLike, type RunnerPort, type SupervisorConfig, type SupervisorResult } from "../supervisor/compose.js";
import { executeRecoveryAction } from "../executor/exec.js";
import { planRecovery } from "../planner/plan.js";
import { investigate as runInvestigation } from "../investigation/agent.js";
import { makeEscalationChannel, makeEscalationDispatcher, type DeliverPort } from "../escalation/channel.js";
import { AttemptRunner, type AttemptTask } from "../runner/attempt.js";
import { FileSteeringQueue } from "../steer/file-queue.js";
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
   *  stopped episode and for regression tests of the park handler. */
  parkTask: () => Promise<void>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const now = () => Date.now();

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
  GIT_TERMINAL_PROMPT: "0",
  GIT_PORCELAIN: "1",
};

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
export async function runObservedGit(repo: string, args: string[], timeoutS = 30, opts?: { maxBytes?: number; hashStdout?: boolean } | number): Promise<ShellResult> {
  // W7-A1 (audit of W6): the 4th param USED to be a bare `maxBytes`
  // number. A stale/untyped JS caller still passing a number would have
  // it treated as an OPTIONS OBJECT — i.e. `maxBytes` silently undefined
  // and the call falls back to the legacy 16 KiB TAIL, which is exactly
  // the W4-A1 blindness (PROVEN: 27300-byte status came back as 16384,
  // with `truncated` NOT set, so nothing failed closed). Coerce instead:
  // a numeric 4th arg is a maxBytes request, never a silent downgrade.
  const o: { maxBytes?: number; hashStdout?: boolean } = typeof opts === "number" ? { maxBytes: opts } : (opts ?? {});
  const pinned = [
    "git",
    "-c", "status.untrackedFiles=all",
    "-c", "core.excludesFile=/dev/null",
    "-c", "diff.ignoreSubmodules=none",
    "-c", "core.sparseCheckout=false",
    "-c", "core.sparseCheckoutCone=false",
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
  return runShell(pinned.map(shellQuote).join(" "), repo, timeoutS, { env: GIT_ENV, ...o });
}

/** Observe the working tree's identity: HEAD sha + a digest of tracked
 *  content (the index, hashed as raw object content — the staged blob,
 *  NOT `git diff --cached` whose OUTPUT bytes depend on diff
 *  machinery/config) + the worktree change over HEAD + every untracked
 *  file's content (W3-A1).
 *  W2-H1: EVERY argv is scrubbed and env-unified; a failed observation
 *  fails CLOSED (dirty with the failure in the digest, never clean). */
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

export async function observeIdentity(cwd: string, sha: string, maxBytes = 64 * 1024 * 1024): Promise<ArtifactIdentity> {
  // W3-A1: `-z` gives NUL-separated, UNSAFE-path-QUOTE-FREE records — a
  // filename containing a quote or newline can no longer forge a porcelain
  // line into (or out of) the digest text; the ?? paths are extracted raw.
  const dirty = await runObservedGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], 10, { maxBytes });
  if (dirty.code !== 0) {
    // W1-M1 fail CLOSED: status failed (index.lock, EACCES, timeout) —
    // a tree whose dirt cannot be verified is treated as dirty, never clean.
    return { sha, dirty: true, dirtyDigest: createHash("sha256").update(`status-failed:code=${dirty.cause}:${dirty.code}\x00${dirty.stderr.slice(-2048)}`).digest("hex") };
  }
  // W4-A1 fail CLOSED: a status output that hit the capture cap is a
  // list we cannot see the front of — treat it like a failed status.
  if (dirty.truncated) {
    return { sha, dirty: true, dirtyDigest: createHash("sha256").update(`status-truncated:${dirty.stdout.length}\x00${dirty.stderr.slice(-2048)}`).digest("hex") };
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
    return { sha, dirty: true, dirtyDigest: createHash("sha256").update(`ls-files-failed:code=${indexFlags.cause}:${indexFlags.code}\x00${indexFlags.stderr.slice(-2048)}`).digest("hex") };
  }
  if (indexFlags.truncated) {
    return { sha, dirty: true, dirtyDigest: createHash("sha256").update(`ls-files-truncated:${indexFlags.stdout.length}\x00${indexFlags.stderr.slice(-2048)}`).digest("hex") };
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
    return { sha, dirty: true, dirtyDigest: createHash("sha256").update(`ls-files-others-failed:code=${othersAll.cause}:${othersAll.code}\x00${othersAll.stderr.slice(-2048)}`).digest("hex") };
  }
  if (othersAll.truncated) {
    return { sha, dirty: true, dirtyDigest: createHash("sha256").update(`ls-files-others-truncated:${othersAll.stdout.length}\x00${othersAll.stderr.slice(-2048)}`).digest("hex") };
  }
  const porcelainUntracked = new Set<string>();
  for (const rec of dirty.stdout.split("\0")) {
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
    return { sha, dirty: true, dirtyDigest: createHash("sha256").update(`untracked-hidden:${String(hidden.length)}\x00${hidden.join("\n")}\x00${hiddenContent}`).digest("hex") };
  }
  if (flagged.length === 0 && dirty.stdout.trim() === "") return { sha };
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
    return { sha, dirty: true, dirtyDigest: createHash("sha256").update(`write-tree-failed:${indexTree.cause}:${indexTree.code}\x00${indexTree.stderr.slice(-2048)}`).digest("hex") };
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
  const filterDefs = await runObservedGit(cwd, ["config", "--get-regexp", "^filter\\..+\\.(clean|smudge)$"], 10, { maxBytes: 256 * 1024 });
  // git config --get-regexp exits 1 for "no matches" — that IS clean.
  if (filterDefs.code > 1 || filterDefs.truncated || (filterDefs.code !== 0 && !(filterDefs.code === 1 && filterDefs.stdout.trim() === ""))) {
    // fail closed: drivers we cannot enumerate may all be lying.
    return { sha, dirty: true, dirtyDigest: createHash("sha256").update(`filter-enum-failed:code=${filterDefs.cause}:${filterDefs.code}\x00${filterDefs.stderr.slice(-2048)}`).digest("hex") };
  }
  for (const line of filterDefs.stdout.split("\n")) {
    // Key = everything before the LAST ".clean"/".smudge" token (quoted
    // subsection names may contain spaces; values follow after it).
    const m = /^(filter\..+\.(?:clean|smudge))(?=[ \t]|$)/.exec(line);
    if (m?.[1] !== undefined) filterPinArgs.push("-c", `${m[1]}=cat`);
  }
  const diff = await runObservedGit(cwd, ["-c", "diff.algorithm=myers", "-c", "diff.ignoreBlankLines=false", "-c", "core.autocrlf=false", ...filterPinArgs, "diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", "--default-prefix", "--src-prefix=a/", "--dst-prefix=b/", "HEAD"], 60, { hashStdout: true });
  // W5-A1 (superseded by W6): a truncated diff used to fail closed as a
  // prefix marker; now any missing digest (stream cut short) or a failed
  // diff fails closed the same way — never a partial stamp.
  const diffPart = diff.code !== 0 || diff.stdoutDigest === undefined
    ? `diff-failed:code=${diff.cause}:${diff.code}:${diff.stdoutDigest ?? "no-digest"}`
    : `sha256:${diff.stdoutDigest}`;
  // W3-A1: untracked content is FOLDED IN (audit finding: two different
  // contents under the same ?? path used to share one identity, so a gate
  // PASS stamped on it could be re-used against bytes it never measured).
  const untrackedPart = await untrackedDigestPart(cwd, dirty.stdout);
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
  return {
    sha,
    dirty: true,
    dirtyDigest: createHash("sha256").update(`porcelain-all\n${dirty.stdout}\x00index-tree\n${indexPart}\x00diff-binary-head\n${diffPart}\x00untracked\n${untrackedPart}${flaggedContent.length > 0 ? `\x00index-flags\n${flaggedContent.sort().join("\n")}` : ""}`).digest("hex"),
  };
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
  let current: ArtifactIdentity = { sha: o.graph.policy?.baseCommit ?? "", dirty: true, dirtyDigest: createHash("sha256").update(`no-worktree:fallback=${o.worktreePath === undefined ? "episode-dir" : "worktree-unobservable"}`).digest("hex") };
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
  const root = opts.episodesRoot ?? join(process.env["HOME"] ?? "/tmp", ".tre", "episodes");
  const epPath = episodeDir(root, graph.episodeId);
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
        const preserve = `${statePath}.unreadable-${String(now())}`;
        try { await rename(statePath, preserve); log(`park: state.json unreadable (${code ?? (e as Error)?.name ?? "parse"}) — preserved as ${preserve}, durable park write SKIPPED`); }
        catch { log(`park: state.json unreadable (${code ?? (e as Error)?.name ?? "parse"}) AND preserve failed — NOTHING overwritten, durable park write SKIPPED`); }
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

  const ports: ComposePorts = {
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
  };

  try {
    const result = await runSupervisorEpisode(cfg, ports);
    return { result, episodePath: epPath, steerStats: { linesRead: steerQueue.getStats().linesRead, injected: steerQueue.getStats().injected, malformed: steerQueue.getStats().malformed }, parkTask: runPark };
  } finally {
    try { runner.close(true); } catch (e) { log(`runner-close: ${(e as Error)?.name ?? "error"}`); }
  }
}

// Re-exported so callers (and the integration test) can validate records
// without importing P4 directly through a second path.
export { validateSupervisorRecord };
