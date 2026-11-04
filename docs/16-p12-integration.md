# P12 — Tested candidate integration (contract & as-built surface)

> Status: CONTRACT (drafted 2026-11-05, implemented 2026-11-05). Module:
> `src/integration/merge.ts`. Consumed by P9/M1 composition (the executor's
> `merge` action is wired here — docs/15 §3 keeps `merge-unwired` inside the
> executor; the merge port P9 injects calls this module). Parent plan:
> docs/11 §5 (merge-action contract, Q5/R2/R3), §14.3 (decision records +
> acceptance record), §11.2 (compartment rules), docs/15 §4 (intent-before-act,
> `no-effect:` provability), docs/12 §4 (gate binds to an artifact).

## 0. Purpose & boundary

P12 answers exactly one question: **integrate ONE task branch into the
episode branch by the §5 merge-action contract — construct the candidate
merge commit, prove it against the episode's trusted gate at the exact
candidate SHA, advance the episode branch by compare-and-swap, and record
acceptance — without ever auto-resolving a conflict, force-advancing a
ref, or merging anything the request does not name.**

Normative source sentences (docs/11 §5):

- "(1) construct candidate merge commit from current episode-branch head +
  task branch; (2) run the episode's trusted gate (gate definition from
  episode policy, **never weakened by the task under test**) against the
  **exact candidate SHA**; (3) advance the episode branch with
  **compare-and-swap** — only if head is still the tested parent, else
  rebuild and retest; (4) record acceptance {candidate SHA, parent SHA(s),
  gate id+result, cleanliness-after}."
- "'Gate green' binds to an artifact, not to 'tests looked green.'"
- "No automatic conflict resolution or history rewriting in v1; clean
  merge proves mechanics, not design coherence."
- Q5: "promotion episode→main stays human by default" — this module
  advances EPISODE branches only; the literal `main` is refused.

Boundary rules:

1. **Conflicts never resolved.** `git merge-tree --write-tree` runs the
   real merge algorithm in the object store (working tree untouched); ANY
   conflict aborts with status `conflict` before a commit object exists,
   before the gate, and before any journal write. No rerere, no strategy
   options, no `-X`.
2. **The gate is a port, and its claim is verified.** The gate adapter
   (P8/P9-composed, docs/12 §4) materializes a clean checkout of the
   candidate and MUST return `{sha}` equal to the candidate it tested;
   any other value (or an unreadable one) is `gate-sha-mismatch` — the
   gate result never binds to "tests looked green."
3. **CAS is the only advance.** `git update-ref refs/heads/<branch>
   <candidate> <expected>` — three-argument form; the module has no code
   path that advances a ref without the old-value operand. Head moved →
   `head-moved`, the candidate stays an unreferenced object (gc-able),
   and recovery is a NEW integration request (new actionId), never a
   forced retry of this one.
4. **Ref-direction guards.** The task branch must be the canonical P6
   name `agent/<episodeId>/<taskId>`; the episode branch must be a valid
   `refs/heads/` name OUTSIDE the `agent/` namespace and never `main`.
   (An integration request naming `main` or a foreign branch is a
   governance violation, not a merge.)
5. **Durable, never-replayable logic:** the action is the ref advance.
   Everything before it (resolve, construct, gate) is observation and
   journals nothing. The intent (carrying the exact candidate SHA) is
   appended immediately before the CAS, the outcome after. An open
   intent is closed by OBSERVED REALITY only (§14.3 I2): the recovery
   scan closes it as merged when the branch head is proven to descend
   from the recorded candidate — never by re-advancing (I5).
6. **Compartment:** `src/integration/merge.ts` imports only `node:`
   builtins (the P6 pattern). Nothing outside tests imports it until P9
   wires the merge port. Journal and gate arrive as injected ports.

## 1. The one call

```ts
integrateTestedCandidate(
  req: unknown,                // IntegrationRequest — treated as HOSTILE input
  ports: IntegrationPorts,
): Promise<IntegrationResult>  // NEVER rejects (§5 fence, docs/15 E5 pattern)
```

`IntegrationRequest` (all fields read through the hostile fence, then
rebound to a frozen snapshot):

```ts
{ repoRoot: string;            // abs path; validated via `rev-parse --git-dir`
  episodeId: string;           // SAFE_ID (same table as P11)
  taskId: string;              // SAFE_ID
  episodeBranch: string;       // refs/heads/<name>: check-ref-format valid,
                               // NOT in agent/** , NOT "main" (§0.4)
  expectedTaskTip?: string;    // optional 40/64-hex pin, checked against refs/heads
  now: number;                 // finite, >= 0 — injected clock
  executionSeq?: number;       // default 0; the ONLY legitimate re-issuance
                               // disambiguator (docs/15 §4)
  grantedBy: string;           // non-empty: WHO authorized this integration
}
```

The task branch is NOT caller-supplied — it is derived as
`agent/<episodeId>/<taskId>` (P6 `taskBranchName`), so a hostile request
can never aim the module at an arbitrary ref as "the task branch".

```ts
interface IntegrationPorts {
  journal: {                                   // P4 DecisionJournal-shaped (docs/15 §3)
    append(r: object): Promise<void>;
    read(): Promise<{ records: readonly unknown[] }>;
  };
  gate: {                                      // trusted gate adapter (docs/12 §4)
    run(req: { candidateSha; episodeBranch; episodeId; taskId; actionId }):
      Promise<{ pass: boolean; runId: string; sha: string; detail?: string }>;
  };
}
```

```ts
type IntegrationStatus =
  'merged' | 'already-merged' | 'recovered'   // ref advanced (or proven advanced)
| 'conflict' | 'gate-failed' | 'refused' | 'failed';
interface IntegrationResult {
  actionId: string; status: IntegrationStatus; stage: IntegrationStage;
  candidateSha?: string; episodeHead?: string; taskTip?: string; gateRunId?: string;
  reason?: string;                     // populated on refused / conflict / failed
  evidenceRefs: string[];
  outcomeDurable: boolean;             // false = outcome/acceptance append lost after
                                       // the advance landed — reconcile, never re-run
}
```

## 2. Ordering (`stage` names the last one reached)

1. **context** — fence-snapshot the request, validate every field
   fail-closed. Any violation → `{status:"refused", reason:"context:<field>"}`,
   nothing else happens.
2. **dedup** — `journal.read()` (garbage/throw → `refused(journal-unreadable)`;
   same fail-closed rule as docs/15 §4 step 2). Scan for this `actionId`
   (`a-<taskId>-merge-<fnv1a(canonical{repoRoot, episodeId, taskId,
   episodeBranch, seq})>`):
   - **acked outcome** → `refused(already-executed)`.
   - **outcome, un-acked, `no-effect:` marker** → replay permitted (a fresh
     intent, distinct journal ids).
   - **outcome, un-acked, no marker** → `refused(not-replayable)`.
   - **open intent** → remember `{candidateSha}` recorded in it (from its
     `expectedEvidence`), and continue to §3 **resolve**; after the head
     is known, `merge-base --is-ancestor candidate head` decides:
     descended → status `recovered` (close the intent with an acked
     outcome, `notes:"recovered: observed head descends from candidate"` —
     I2 closure by observed reality, the ONLY path that closes an open
     merge intent) ; not descended → `refused(intent-open)`.
3. **resolve** — `rev-parse --git-dir` (repo), then BOTH refs with
   `rev-parse --verify --quiet refs/heads/<name>^{commit}`. Guards, each
   a refusal with zero side effects: refs exist; episodeBranch ≠ task
   branch; `expectedTaskTip` (when given) equals the task-tip sha
   (case-insensitive compare after lowercase). Episode head, task tip.
   **Already-merged:** `merge-base --is-ancestor taskTip episodeHead` →
   status `already-merged` (no journal write — the fact is re-derivable
   from the graph; the record of the integration that did it stays the
   evidence).
4. **construct** — `git -c user.name=tre-supervisor -c
   user.email=tre@localhost merge-tree --write-tree refs/heads/<episode>
   refs/heads/<task>` (no strategy options, no `-X`, no ancestor
   shortcuts): exit 1 (conflicted tree) → status `conflict` with the
   conflicted paths (bounded, ≤ 64 strings) in `reason`, **nothing
   committed, nothing journaled**; any other non-zero → `failed
   git:merge-tree`. Clean → `git commit-tree <tree> -p <episodeHead> -p
   <taskTip> -m "integrate <taskId> into <episodeBranch> [tre-p12]"` with
   `-c` identity the same; capture candidate sha. (Two parents, first =
   episode head — the integration direction is INTO the episode branch.)
5. **gate** — call `ports.gate.run` ONCE against the candidate; reads of
   the result are getter-guarded (docs/15 R1-G1): a throwing getter, a
   non-object result, `pass !== true`, a non-string/short `runId`, or
   `sha` not exactly equal to the candidate → the advance does not
   happen: `gate-failed` / `gate-sha-mismatch` with NO journal write
   (nothing has happened; §0.5). `pass === true` and a matching sha
   continue; `detail` never trusted further (≤ 512 copied for display).
6. **re-verify** — task tip re-resolved; changed since construct →
   `refused(task-tip-moved)` (the candidate was tested against a stale
   tip; the new tip is a NEW integration intent). No journal write.
7. **intent** — append §14.3 `decision-intent` (id `<actionId>#i<seq>`;
   `action:"merge"`, `rung:4`, `attemptId` omitted (a merge targets
   branches, not an attempt), `expectedEvidence:"candidate:<sha>"` — the
   observed-reality key for §2 recovery — authority
   `{grantedBy, sideEffect:"external"}`, rationale = one deterministic
   sentence). Deep-frozen before append (docs/15 R1-F3). Append failure
   → `refused(intent-journal-failed)`, **no ref touched** (log-then-act).
8. **advance (CAS)** — `git update-ref refs/heads/<episodeBranch>
   <candidate> <episodeHead>` — the ONLY ref write in the module.
   Local `update-ref` is atomic (lockfile rename): a NON-ZERO exit means
   this call did not change the ref. Re-read head:
   - head === candidate → treat as advanced regardless of the exit
     (a write landing followed by an error is indistinguishable; the
     observation is the authority) — step 9 merged path.
   - exit ≠ 0 AND head ≠ candidate → `no-effect:` outcome — PROVABLE
     (this call rejected + the re-read rules out our write): head at a
     third value → `refused head-moved`; head still at the old value →
     `refused advance-failed`.
   - exit === 0 but head ≠ candidate, or head unreadable → the outcome
     is UNKNOWN (step 9 act-unknown path) — never `no-effect:`.
9. **verify** — re-read `refs/heads/<episodeBranch>`: equal to the
   candidate → append outcome `{acked:true, progress:"none",
   evidenceRefs:["candidate:<sha>","parent:episode:<head>","parent:task:
   <tip>","gate:<runId>","advance:observed"]}` and the
   §14.3 **acceptance** record (id `<actionId>#acc<seq>`;
   `verdict:"complete"`, `criteria:[{id:"trusted-gate", pass:true,
   evidenceRef:"gate:<runId>", checkedAtSha:candidateSha}]`,
   `artifact:{sha:candidate}` — the §5 "record acceptance" in schema
   shape), both deep-frozen; status `merged`. Not equal → the advance
   outcome is UNKNOWN (update-ref succeeded but the observation
   contradicts, or the observation threw): append best-effort outcome
   `{acked:false, notes:"act-unknown: advance-unverified"}` (NOT
   replayable — docs/15 §4 step 7 table: a CAS that may have landed is
   never marked `no-effect:`), status `failed` with
   `outcomeDurable:false`.
   If the outcome/acceptance append throws AFTER a verified advance:
   status stays `merged` with `outcomeDurable:false` (the ref DID
   advance; the lost records are reconcile's job — docs/15 §6 E6).

## 3. Failure doctrine

| failure | status | journaled | replayable |
|---|---|---|---|
| context/refs/namespace violation | refused | nothing | yes (fresh request) |
| dedup: acked / unmarked / intent-open | refused | nothing | no / no / observed-only |
| conflict at construct | conflict | nothing | yes (after fixing files) |
| gate fail / sha mismatch / getter throw | gate-failed | nothing | yes (new candidate = new actionId) |
| gate never settles (hung runner) | gate-failed `gate-timeout` | nothing | yes (cycle-2 F9: deadline = `TRE_P12_GATE_TIMEOUT_MS`, default 600 s, clamped [1 s, 1 h]) |
| task-tip-moved before intent | refused | nothing | yes (fresh request) |
| intent append failed | refused | nothing | yes |
| CAS rejected (head moved) | refused head-moved | intent + `no-effect:` outcome | yes — replay IS the §5 "rebuild and retest" |
| CAS failed, head unchanged | refused advance-failed | intent + `no-effect:` outcome | yes |
| CAS failed, head moved but candidate IS its ancestor | failed advance-unverified | intent + `act-unknown:` outcome | no (cycle-2 F4: write may have landed and been moved on — never `no-effect:`) |
| CAS ok but verify contradicts/head unreadable | failed advance-unverified | intent + `act-unknown:` outcome | no |
| merged, outcome/acceptance lost | merged, `outcomeDurable:false` | intent (outcome lost) | no (reconcile closes) |

The `no-effect:` invariant carries over unchanged from docs/15 §4 step 7:
`no-effect:` is written only when nothing-happened is PROVABLE (the CAS
was rejected AND the head re-read rules out our write landing).

## 4. Never throws (top-level fence)

Same doctrine as docs/15 §5: the whole body — including every property
read of `req` and `ports` — runs inside one try/catch. An internal bug
or a hostile port throwing at any point yields
`{status:"failed", reason:"fence:<stage>:<name>", ...}` with the current
stage; the caller can always distinguish "the module refused" from "the
module broke." Port results are never trusted beyond the guards above.

## 5. Git usage (P6 discipline)

All git calls are fixed-argv `execFile` (never shell), always
`refs/heads/`-qualified (a same-named TAG can never shadow a branch in
our operands), `--quiet`/`--verify` where supported, `--` where paths
would parse as options. Ref names go through `git check-ref-format
refs/heads/<name>` BEFORE any command uses them. No call mutates
anything except the one `update-ref`. `merge-tree --write-tree` is the
only command that creates objects (unreferenced trees/commits; a failed
integration leaves them for gc — no ref, no merge).

## 6. Tests & guards

- Real-repo tests (P6 pattern): tmpdir repos with episode + task
  branches, clean merges, conflicts (same-file both-sides), head-moved
  CAS races, ancestor shortcuts (episode fully containing task tip →
  `already-merged`; task tip == episode head → already-merged),
  gate-pass/gate-fail/gate-sha-mismatch/hostile-gate-getter,
  intent-recovery (crash between intent and advance simulated by a
  journal pre-seeded with an open intent + head advanced to the recorded
  candidate → `recovered`; head not descended → `refused intent-open`),
  dedup matrix, `main`-and-`agent/**` direction guards, hostile request
  (throwing getters, revoked proxies, non-canonical ids), never-throws
  fence.
- Compartment guards: `src/integration` imports only `node:` builtins;
  nothing outside tests imports it (P5/P11 pattern).
- Drift pins: the SAFE_ID / rung-4 / sideEffect "external" choices are
  pinned against the executor's tables by test.

## 7. Cycle-1 audit disposition (p12-cycle1.out, findings F1–F10)

- **F1 (fixed)** construct classified the conflict on exit code alone; a
  ref vanishing between resolve and construct also exits 1 with EMPTY
  stdout. Classification now requires a tree-OID first stdout line —
  anything else is `git:merge-tree:*` failed. Pinned (git PATH shim).
- **F2 (fixed, comment)** the act-unknown comment promised same-identity
  observed-reality closure; the dedup rule deliberately makes it
  unreachable. Truth: recovery is a NEW identity (bumped executionSeq)
  whose resolve stage re-derives from the graph.
- **F3 (was already fixed)** `resolveSha` distinguishes documented exit 1
  from hard failures (throws to the fence), per the P6-F4 rule.
- **F4 (documented limitation)** a SIGTERM-killed update-ref can strand a
  stale `refs/heads/<ep>.lock`, wedging later CAS attempts as (correctly
  refused, provably no-effect) `advance-failed` until an operator removes
  the lock — auto-removal races a real writer and is outside this
  module's authority.
- **F5 (documented limitation)** SAFE_ID admits uppercase; on a
  case-insensitive filesystem `ep1`/`EP1` are one physical ref under two
  actionId identities. Not normalized — case-folding would silently
  merge supervisor identities; hosts use case-exact branch names.
- **F6 (pinned by test)** dedup precedes resolve: once merged, a re-issue
  answers `already-executed` even when expectedTaskTip would now
  mismatch (the acked outcome, not the stale pin, is the authority).
- **F7 (fixed)** the M6 fence outcome id now carries the same per-
  actionId outcomeSuffix as normal outcomes (`…#o<suffix>f`) — two fence
  escapes for one identity cannot collide.
- **F8 (fixed)** dead `noEffect` dedup variable removed (replayability is
  derived from `notes` prefixes; the open+no-effect shape is expressed
  there).
- **F9 (tests added)** observed-despite-cas-error (shim: real update-ref
  lands, exit forced to 1 → merged + `advance:observed-despite-cas-error`),
  M6 fence (shim: verify re-read hard-fails after the intent →
  `fence:verify`, act-unknown fence record), F1 empty-stdout construct,
  and no-effect→replay r-suffixed id interleaving. Injection is a
  deterministic PATH shim — never a race or a sleep.
- **F10 (fixed)** the compartment test resolves merge.ts source-relative
  in EITHER layout (dist/test or tsx test/) instead of ENOENT-crashing
  on the unexpected one.

Ambiguity doctrine held throughout: every path that cannot prove
nothing-happened fails closed toward refusal/act-unknown and never
advances a ref or claims durable-close falsely (no High/Critical found).

## 8. Cycle-2 audit dispositions (Haiku 5.5, second pass over the merged diff)

Second full read of the integration-merge module by a fresh model on the
post-cycle-1 diff. Ten findings; all resolved or dispositioned:

- **C2-F1 (critical, fixed + pinned)** the M4 "never main" guard was a
  case-SENSITIVE compare; on case-insensitive filesystems (macOS APFS —
  reproduced: `update-ref refs/heads/MAIN` rewrites `refs/heads/main`)
  `MAIN` bypassed the Q5 human-only promotion rule. The guard now
  case-folds ONLY the literal `main`; every other episode id stays
  case-exact (the C1-F5 identity doctrine is untouched).
- **C2-F2 (major, fixed + pinned)** location-redirecting git env vars
  (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_NAMESPACE`,
  `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CEILING_DIRECTORIES`,
  `GIT_DISCOVERY_ACROSS_FILESYSTEM`) are stripped from EVERY git call —
  and the env is BUILT PER CALL from `process.env` (a module-load
  snapshot would freeze PATH prepends and defeat both operators and the
  PATH-shim tests). The repo probe additionally pins identity:
  `rev-parse --show-toplevel` must equal `realpath(repoRoot)` — a
  non-repo dir nested inside another repo is
  `context:repoRoot-outer-repo`, never a silent retarget at the outer one.
- **C2-F3 (major, fixed)** the module carried a comment claiming a
  HEAD-symbolic guard that never existed. Removed. The REAL limitation
  is documented at the guard site: a CAS moves the ref but no linked
  worktree syncs — the episode flow keeps the episode branch
  unchecked-out; auto-syncing a foreign worktree is out of authority.
- **C2-F4 (major, fixed + pinned)** "CAS failed" + "head is not our
  candidate" was journaled `no-effect:` without checking reachability.
  update-ref's atomicity covers the rename, not the process — a write
  CAN land behind a non-zero exit. The verify path now probes
  `merge-base --is-ancestor candidate headNow`: ancestor (or probe
  failure — biased unknown) → `act-unknown: advance-unverified`, never
  a `no-effect:` that a replay would contradict. Shim test: update-ref
  lands → exits 1 → a late writer advances from the candidate →
  re-read sees a third sha with OUR candidate as ancestor →
  `failed advance-unverified`, not-replayable.
- **C2-F5 (minor, fixed)** the actionId digest was 32-bit FNV-1a — weak
  for a durable dedup key. Now `createHash("sha256")` truncated to 128
  bits (16 hex). Id shape: `a-<taskId>-merge-<16 hex>`.
- **C2-F6 (minor, fixed)** the DERIVED-branch test pinned `tempting` to
  the SAME sha as `agent/ep1/t1`, making it a tautology. `tempting` now
  sits on the base commit: honoring a caller-named branch would merge
  the base and fail the assertion.
- **C2-F7 (minor, fixed)** the REAL P4 validator now runs over records
  from EVERY journaled path (merged, no-effect:advance-failed,
  no-effect:head-moved, act-unknown:fence-verify,
  observed-despite-cas-error, recovered, r-suffixed replay) against an
  actual on-disk DecisionJournal — schema drift in any path fails the
  suite.
- **C2-F8 (minor, fixed + pinned)** a nonexistent `repoRoot` escaped as
  a fence `failed` (outcome-unknown) because the spawn ENOENT is
  platform-indistinguishable from a missing git binary. Classification
  now happens BEFORE spawning: `realpathSync` ENOENT/ENOTDIR → the
  documented `context:repoRoot-not-a-repo` refusal (zero side effects);
  EACCES/ELOOP rethrow as environment failures.
- **C2-F9 (minor, fixed + pinned)** the gate port call had no bound —
  "never throws" is not "always returns". The call races a deadline
  (`TRE_P12_GATE_TIMEOUT_MS`, default 600 s, clamped, read per call);
  expiry → `gate-failed gate-timeout` with no journal write and the ref
  untouched. The racing promise is abandoned, not cancelled — the gate
  adapter owns its subprocesses; this module's contract is a bounded
  return.
- **C2-F10 (documented limitation)** an intent journaled but never
  followed by a CAS (crash between append and advance, or an append
  that threw AFTER persisting) stays open forever: every reissue is
  `refused intent-open` until observed reality closes it (head equals /
  descends from / contains the candidate) or the operator bumps
  `executionSeq`. There is deliberately NO expiry — an open intent is
  the durable record that the action's effect is UNKNOWN, and expiring
  it would permit a second execution of a possibly-landed merge.
  Doctrine: reconcile by observation (recovery paths), or re-issue
  under a new identity (executionSeq bump) which strands the orphan
  harmlessly — the orphan names a candidate that dedup and recovery
  both still see. Liveness, not safety; listed here as required.

Ambiguity doctrine held throughout cycle 2 as well: every new path
(ancestor-of-head, env-stripped probe, gate deadline) fails closed
toward refusal/act-unknown and never advances a ref or writes a
`no-effect:` it cannot prove.

## 9. Cycle-3 audit dispositions (Haiku 5.5, third pass, p12-cycle3.out, findings C3-F1–C3-F9)

All nine findings dispositioned; eight fixed and pinned by tests, one
(F1 cross-process remainder) fixed to the durability the journal port
provides, with the true residual documented below. 53/53 module tests,
2135/2135 suite, `tsc --noEmit` clean.

- **C3-F1 (major, fixed)** dedup was last-record-wins: a later
  `no-effect:` outcome (the CAS loser's record) cleared an earlier
  ACKED outcome, making an already-executed identity replayable — and
  an act-unknown could be washed out the same way. The scan is now
  STICKY-TERMINAL: `ackedSeen` (→ `already-executed`) and
  `unknownSeen` (→ `not-replayable`, unless acked) are monotonic —
  never unset by any later record; only the open/closed intent cursor
  follows record order. Same-process concurrency got a second lock:
  `integrateTestedCandidate` reserves its actionId in a module-level
  `inFlight` set before the journal read and releases it in a finally
  on EVERY path (return, throw, fence); a duplicate dispatch while the
  first runs is `refused dedup:in-flight` and journals nothing.
  Residual (documented): two processes racing on ONE host (or across
  hosts) can both pass the journal read before either appends — the
  DecisionJournal port is append-only with advisory duplicate-id
  reporting, not CAS. The durable backstop is the append-then-observe
  order: the loser's CAS rejects cleanly, its no-effect record lands
  beside the acked one, and the sticky scan makes the identity
  permanently `already-executed`. A true append-race is therefore
  self-healing at read time; the acked outcome's `acked: true`
  acceptance remains the supervisor's only write-ack.
- **C3-F2 (fixed earlier this cycle)** `own()` uses
  `Object.getOwnPropertyDescriptor`: absent → undefined, data property
  → value, accessor → the getter runs and any throw ESCAPES to the M6
  fence (fail-closed). A throwing `expectedTaskTip` getter can no
  longer drop the caller's pin fail-open. The hostile-Proxy test now
  pins the fenced shape (`failed fence:context:*`, zero records).
- **C3-F3 (fixed earlier this cycle)** the git env strip list covers
  every redirector the audit named: `GIT_CONFIG_COUNT` /
  `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*` / `GIT_CONFIG_PARAMETERS`
  / `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` / `HOME` /
  `XDG_CONFIG_HOME` / `GIT_QUARANTINE_PATH` / `GIT_TEMPLATE_DIR` /
  `GIT_REPLACE_REF_BASE` (+ the older GIT_DIR/GIT_WORK_TREE/
  GIT_SSH_COMMAND set), and git runs `--no-optional-locks` against
  inherited hooks as pinned in §8 C2.
- **C3-F4 (major, fixed)** the verify path claimed provable no-effect
  in three states where it is NOT provable: head unreadable at re-read
  (`headNow === ""` — a landed-then-deleted ref reads identical to
  "we never wrote"), a CAS that died WITHOUT reporting an exit code
  (signal kill / exec timeout — it may have died after the rename
  landed; a later reset to an unrelated commit erases the ancestor
  evidence), and the old code's collapse of every failure into
  "rejected code 1". Now `casRejectedClean` records WHERE git failed:
  a numeric non-zero exit is git's own pre-rename error path
  (provable), a missing code is not. `headNow === ""` or an
  unreported-kill with a third-value head → `act-unknown` with a
  `close:head-unreadable` / `close:cas-kill-unverifiable` evidence
  tag, never `no-effect:`. Pinned by two shim tests (killed-writer +
  unrelated reset; clean-reject + deleted-ref re-read).
- **C3-F5 (major, fixed)** the actionId digests the REALPATH of
  `repoRoot` (canonicalizing trailing slashes and symlink spellings to
  one digest — an act-unknown under one spelling is no longer invisible
  under another). A realpath failure falls back to trailing-slash
  trim; such requests are refused at resolve before anything is
  journaled, so the fallback id never goes durable for an existing
  repo. Pinned by trailing-slash and symlinked-root dedup tests.
- **C3-F6 (minor, fixed)** `gateTimeoutMs()` clamps ANY valid positive
  value into [1 s, 1 h] — `TRE_P12_GATE_TIMEOUT_MS=500` now means the
  1 s floor, not the silent 600 s default. Pinned by a hung-gate test
  asserting the deadline fires at ~1 s.
- **C3-F7 (minor, fixed)** the gate deadline rejects the race with a
  module-private `TIMEOUT_SENTINEL` symbol and the catch compares by
  reference. An adapter that itself throws `Error("gate-timeout: …")`
  is `gate-threw:Error` (its true shape), never a false deadline
  report. Pinned by a text-throwing adapter test.
- **C3-F8 (minor, fixed — test)** the compartment guard was
  double-quote-static-only. It now scans static `from` (both quote
  styles), dynamic `import("…")`, and `require("…")`, filters
  relative specifiers, asserts it found ≥ the static-import count
  (a guard that loses specifiers fails), and rejects any non-`node:`
  specifier.
- **C3-F9 (minor, fixed)** the toplevel identity pin compares
  case-folded on case-INSENSITIVE platforms (darwin/win32) — a
  correctly-spelled repo path with different case no longer fences as
  `repoRoot-outer-repo`. POSIX stays byte-exact. Pinned by a
  case-spelling test (merged on darwin, clean refusal on POSIX).

Doctrine check for cycle 3: every new classification path (sticky scan,
kill-site distinction, realpath identity, case-folded pin) fails
closed toward refusal/act-unknown, journals nothing on refusals, and
never advances a ref. The two sticky terminals are the only monotonic
facts a journal may assert, and both forbid re-execution.
