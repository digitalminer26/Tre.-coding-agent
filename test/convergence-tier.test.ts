// v36 F5 — executable conformance vectors for the §14.12.1 per-kind
// convergence predicate, the §14.13.3 mint-time recoveryClass rule, and
// the §14.13.3 reconciled-amount precedence.
// LIMITATION (v36 cycle-4 minor 1, stated honestly): these vectors execute
// a STANDALONE reference model transcribed from the contract prose; they
// do NOT read the schema document, so a prose edit that changes outcomes
// does not fail them. They pin the worked examples and fail-closed edges
// against MODEL regressions; prose<->model consistency is the audit's job
// (terra cycles), not this file's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

type Kind = null | "prose-contract";
interface Round { kind: Kind; clean: boolean; legacy?: boolean; abandoned?: boolean }

const REQUIRED: Record<string, number> = { null: 2, "prose-contract": 3 };
const keyOf = (k: Kind) => (k === null ? "null" : k);

// sufK0: consecutive clean suffix over rounds of kind k0 ONLY.
// v36 cycle-15 blocker 1: a LEGACY round (manifest with NO declared
// roundKind, only legal before A_class) is a BARRIER for every kind —
// it never counts toward any streak and the walk STOPS there (fail
// closed): unclassifiable history never establishes convergence.
function sufFor(rounds: Round[], k0: Kind): number {
  let n = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const r = rounds[i];
    if (!r) continue;
    // v36 cycle-19 major 2: a round covered by a `round-abandoned`
    // record is TERMINATED-BAD — it breaks the consecutive-clean
    // suffix of EVERY kind exactly as a legacy barrier does.
    if (r.legacy || r.abandoned) break;
    if (r.kind !== k0) continue;
    if (!r.clean) break;
    n++;
  }
  return n;
}

// Convergence at the boundary whose CURRENT round is the last entry.
// A legacy CURRENT round never converges under the tiered rule at all
// (replay refuses the verdict as unestablishable — here: false).
function converged(rounds: Round[]): boolean {
  const cur = rounds[rounds.length - 1];
  if (!cur) return false;
  // An abandoned current round is TERMINATED-BAD: never a round of any
  // kind, satisfies no tier, and the boundary NEVER converges on it
  // (v36 cycle-19 major 2 — a fresh round is opened).
  if (cur.legacy || cur.abandoned) return false;
  if (!cur.clean) return false;
  return sufFor(rounds, cur.kind) >= (REQUIRED[keyOf(cur.kind)] ?? Infinity);
}

const C = (k: Kind = null): Round => ({ kind: k, clean: true });
const U = (k: Kind = null): Round => ({ kind: k, clean: false });
// v36 cycle-15 blocker 1: clean legacy round (no declared roundKind).
const L = (): Round => ({ kind: null, clean: true, legacy: true });

test("F1 worked: clean code x2 then clean prose x1 is NOT converged", () => {
  assert.equal(converged([C(), C(), C("prose-contract")]), false);
});

test("F1 worked: clean prose x3 then clean code x1 is NOT converged (prose does not substitute for the code floor)", () => {
  assert.equal(converged([C("prose-contract"), C("prose-contract"), C("prose-contract"), C()]), false);
});

test("F1 worked: clean prose x3 then clean code x2 IS converged on the second code round", () => {
  const r = [C("prose-contract"), C("prose-contract"), C("prose-contract"), C(), C()];
  assert.equal(converged(r), true);
});

test("F1: clean prose x3 then unclean prose then clean prose x2 is NOT converged", () => {
  const r = [C("prose-contract"), C("prose-contract"), C("prose-contract"), U("prose-contract"), C("prose-contract"), C("prose-contract")];
  assert.equal(converged(r), false);
});

test("F1: clean prose x3 converges on the prose round", () => {
  assert.equal(converged([C("prose-contract"), C("prose-contract"), C("prose-contract")]), true);
});

test("F1: an unclean current round never converges", () => {
  assert.equal(converged([C(), C(), U()]), false);
});

test("F1: unkinded rounds take the floor of 2 and no more", () => {
  assert.equal(converged([C(), C()]), true);
  assert.equal(converged([C()]), false);
});

// v36 cycle-39 major 1: the §14.12.3 replay RECURRENCE is an explicit
// forward transition per round, INCLUDING barriers: a legacy round or a
// round TERMINATED-BAD by `round-abandoned` resets EVERY kind's suffix
// to 0 (and confirmingUsed with it) — a cached streak can never retain
// pre-barrier rounds. Model of the cache recurrence (the authoritative
// check remains the sufFor walk above; the two must AGREE).
function recurrence(rounds: Round[]): { suf: Record<string, number>; confirmingUsed: number } {
  const suf: Record<string, number> = { null: 0, "prose-contract": 0 };
  // v36 cycle-41 major 2: confirmingUsed counts clean rounds AFTER the
  // FIRST clean candidate of the current run — the candidate itself is
  // NOT counted (candidate state is explicit; 0 after the candidate,
  // 1 after its first confirmation).
  let confirmingUsed = 0;
  let hasCandidate = false;
  for (const r of rounds) {
    if (r.legacy || r.abandoned) {
      for (const k of Object.keys(suf)) suf[k] = 0; // BARRIER: every suffix resets
      confirmingUsed = 0; hasCandidate = false;      // and the candidate run ends
      continue;
    }
    const k = keyOf(r.kind);
    if (r.clean) {
      suf[k] = (suf[k] ?? 0) + 1;
      if (hasCandidate) confirmingUsed++; // confirmations only (v41-M2)
      else hasCandidate = true;           // the first clean candidate: counts 0
    }
    else { suf[k] = 0; confirmingUsed = 0; hasCandidate = false; }
  }
  return { suf, confirmingUsed };
}
const A = (): Round => ({ kind: null, clean: true, abandoned: true }); // terminated-bad round

test("c39-M1: the replay recurrence resets EVERY suffix at a legacy barrier (clean code x2, legacy, clean code x1 -> sufCode = 1, never 3)", () => {
  const r = [C(), C(), L(), C()];
  assert.equal(recurrence(r).suf["null"], 1, "auditor's vector: 1, not 3");
  // The recurrence AGREES with the authoritative suffix walk:
  assert.equal(recurrence(r).suf["null"], sufFor(r, null), "recurrence agrees with the walk (legacy barrier)");
});

test("c39-M1: the replay recurrence resets EVERY suffix at an abandoned barrier (clean prose x3, abandoned, clean prose x1 -> sufProse = 1)", () => {
  const r = [C("prose-contract"), C("prose-contract"), C("prose-contract"), A(), C("prose-contract")];
  assert.equal(recurrence(r).suf["prose-contract"], 1, "terminated-bad breaks the prose run");
  assert.equal(recurrence(r).confirmingUsed, 0, "post-barrier clean round is the fresh run's CANDIDATE: counts 0 (v41-M2)");
  // v41-M2: candidate state asserted directly.
  assert.equal(recurrence([C("prose-contract")]).confirmingUsed, 0, "the first clean candidate itself is not counted");
  assert.equal(recurrence([C("prose-contract"), C("prose-contract")]).confirmingUsed, 1, "the first confirmation after the candidate counts 1");
  assert.equal(recurrence([C("prose-contract"), C("prose-contract"), U("prose-contract"), C("prose-contract")]).confirmingUsed, 0,
    "unclean ends the confirming run: the post-unclean clean round is the new candidate at 0");
  assert.equal(recurrence([A(), C("prose-contract"), C("prose-contract")]).confirmingUsed, 1,
    "post-barrier candidate + one confirmation = 1");
  assert.equal(recurrence(r).suf["prose-contract"], sufFor(r, "prose-contract"), "recurrence agrees with the walk (abandoned barrier)");
});

test("c39-M1: a barrier resets BOTH kinds (a mid-run barrier cannot spare the other kind's streak)", () => {
  const r = [C("prose-contract"), C("prose-contract"), C(), L(), C("prose-contract")];
  const { suf } = recurrence(r);
  assert.equal(suf["prose-contract"], 1);
  assert.equal(suf["null"], 0);
});

// v36 cycle-41 major 1: the recurrence input is the STREAK STREAM —
// boundary lines MERGED (in cycle-slot order) with `round-abandoned`
// records. An abandoned manifest produces NO boundary line (delivery
// permanently forbidden), so a boundary-only replay would SKIP the
// barrier entirely. Stream events are ordered by cycle slot; a
// boundary-less abandonment occupies its own slot.
type StreamEvent = { kind: "boundary"; round: Round } | { kind: "abandoned" };
function recurrenceStream(events: StreamEvent[]): { suf: Record<string, number>; confirmingUsed: number } {
  return recurrence(events.map((e) => e.kind === "abandoned" ? A() : e.round));
}

test("c41-M1: an abandoned manifest WITHOUT a boundary line still breaks the streak (stream includes abandonment events)", () => {
  // clean code x2, abandoned manifest (NO boundary line), clean code x1.
  const stream: StreamEvent[] = [
    { kind: "boundary", round: C() },
    { kind: "boundary", round: C() },
    { kind: "abandoned" },
    { kind: "boundary", round: C() },
  ];
  assert.equal(recurrenceStream(stream).suf["null"], 1, "the abandonment event sits in the stream: suffix = 1, never 3 (v41-M1)");
  // The defect shape: replaying boundary lines ONLY skips the barrier.
  const boundariesOnly = stream.filter((e) => e.kind === "boundary").map((e) => (e as { round: Round }).round);
  assert.equal(recurrence(boundariesOnly).suf["null"], 3, "boundary-only replay would retain 3 — the stream rule is what forbids it");
});

// ---- v36 cycle-15 blocker 1: legacy rounds are streak barriers ----------
test("c15-B1: two legacy clean rounds never converge (current legacy round: verdict unestablishable)", () => {
  assert.equal(converged([L(), L()]), false);
  assert.equal(converged([L()]), false);
});

test("c15-B1: two legacy clean rounds cannot feed a later code-kind boundary", () => {
  // The auditor's defeat vector: legacy clean x2 then one clean code round
  // must NOT converge — the pre-barrier legacy rounds never count.
  assert.equal(converged([L(), L(), C()]), false);
  // Even three code rounds after the barrier converge on their OWN kind:
  // the third post-barrier code round converges on 2 self-counted rounds.
  assert.equal(converged([L(), C(), C()]), true); // 2 code rounds after barrier
});

test("c15-B1: a legacy round breaks every streak (walk stops, no extension across it)", () => {
  // clean code, clean code, LEGACY, clean code -> sufCode = 1 (barrier stops
  // the walk before the legacy round; the two pre-legacy code rounds do not
  // resume the run).
  assert.equal(converged([C(), C(), L(), C()]), false);
  // same shape for prose: barrier truncates the prose suffix to 1.
  assert.equal(
    converged([C("prose-contract"), C("prose-contract"), L(), C("prose-contract")]),
    false,
  );
});

test("c15-B1: post-barrier rounds converge on their own counted streak", () => {
  // barrier then a full qualifying prose streak -> converges legitimately.
  assert.equal(
    converged([L(), C("prose-contract"), C("prose-contract"), C("prose-contract")]),
    true,
  );
});

// ---- v36 cycle-16 blocker 1: namespace-lock model ------------------------
// Reference model of the §14.12.4 record 1 name-binding protocol. A
// "namespace" maps path -> inode; an open fd pins the INODE; classification
// is by pinned identity vs the listed entries' pinned identities. The
// directory-swap attack renames a listed entry's parent and reinstates the
// listed path as a hard link to the target's inode: every held fd's fstat
// (inode content/metadata) is UNCHANGED, but the listed path now resolves
// to the target. Pinning alone classifies wrong; the lock + openat re-walk
// catches it. Models BOTH: pinned-only classification (defeated) and the
// protocol (re-walk under the namespace lock must agree).
type NS = Map<string, number>; // path -> inode
const RESOLVE = (ns: NS, p: string): number | null => ns.get(p) ?? null;

// Cycle-15 (insufficient) model: at resolution time the supervisor opens
// each pinned path and records its fd's inode; membership is thereafter
// decided by comparing the PINNED INODES (held-fd fstats), never the
// namespace again. Returns the classification the pinned-only rule gives.
function classifyPinnedOnly(
  pinnedTarget: number | null, pinnedListed: Array<number | null>,
): boolean {
  if (pinnedTarget === null) return false;
  return pinnedListed.some((id) => id !== null && id === pinnedTarget);
}

function classifyUnderProtocol(
  nsAtResolve: NS, nsNow: NS, targetPath: string, listed: string[], locked: boolean,
): boolean | "REFUSED" {
  if (!locked) return "REFUSED"; // lock acquisition failure: fail closed
  // openat re-walk from the root under the lock: every listed path's
  // CURRENT identity must equal its resolution-pass identity, and the
  // target's current identity must equal the classified target identity.
  const tThen = RESOLVE(nsAtResolve, targetPath);
  const tNow = RESOLVE(nsNow, targetPath);
  if (tThen === null || tNow === null || tThen !== tNow) return "REFUSED";
  for (const lp of listed) {
    const lThen = RESOLVE(nsAtResolve, lp);
    const lNow = RESOLVE(nsNow, lp);
    if (lThen === null || lNow === null || lThen !== lNow) return "REFUSED";
  }
  return listed.some((lp) => RESOLVE(nsNow, lp) === tNow);
}

test("c16-B1 directory-swap vector: pinned-only classification is DEFEATED (models the auditor's attack)", () => {
  // Resolution pass: target inode 7 at "src/app.ts" (unlisted); listed
  // entry "docs/11-orch.md" is inode 9.
  const nsBefore: NS = new Map([["src/app.ts", 7], ["docs/11-orch.md", 9]]);
  // Attack: rename docs/ -> docsOld/, recreate docs/ with 11-orch.md as a
  // HARD LINK to inode 7 (the target). Held fds' fstats unchanged (7 and 9
  // both alive); the LISTED PATH now resolves to 7.
  const nsAfter: NS = new Map([...nsBefore, ["docs/11-orch.md", 7]]);
  assert.equal(classifyPinnedOnly(7, [9]), false,
    "pinned-only: contract-text target classifies null — the cycle-15 defeat");
});

test("v36 cycle-17: pinned-only rule works when the namespace is stable, fails the swap", () => {
  // Positive control: stable namespace, pinned identities match -> true.
  assert.equal(classifyPinnedOnly(70, [70]), true, "stable namespace: pinned membership holds");
  // Swap: pinned target inode 80, pinned listed inode 81 (different) -> false.
  assert.equal(classifyPinnedOnly(80, [81]), false, "post-swap: stale pinned identities never match");
});

test("v36 cycle-17: post-append in-place write cannot change delivered bytes (snapshot delivery)", () => {
  // Delivery model: the immutable in-memory snapshot taken at digest time
  // is the sole source of auditor bytes; later filesystem writes are inert.
  const snapshot = Buffer.from('{"roundKind":"text","summary":"v1"}', "utf8");
  const targetDigest = createHash("sha256").update(snapshot).digest("hex");
  // ... append happens, auditor is dispatched ... then an in-place write:
  const malicious = Buffer.from('{"roundKind":"text","summary":"EVIL"}', "utf8");
  malicious.toString(); // bytes on disk change; the snapshot never does
  const delivered = Buffer.from(snapshot); // re-delivered FROM THE SNAPSHOT
  assert.equal(createHash("sha256").update(delivered).digest("hex"), targetDigest,
    "delivered bytes' digest equals targetDigest despite the post-append write");
  assert.ok(!delivered.toString().includes("EVIL"), "auditors receive the hashed bytes, never the post-append rewrite");
});

test("c16-B1: namespace lock + re-walk REFUSES the directory-swap; clean re-walk classifies prose-contract", () => {
  const nsBefore: NS = new Map([["src/app.ts", 7], ["docs/11-orch.md", 9]]);
  const nsAfter: NS = new Map([...nsBefore, ["docs/11-orch.md", 7]]);
  // swap between resolution and append -> listed path identity diverged
  assert.equal(classifyUnderProtocol(nsBefore, nsAfter, "src/app.ts", ["docs/11-orch.md"], true),
    "REFUSED");
  // no lock available -> refuse, never assume the binding
  assert.equal(classifyUnderProtocol(nsBefore, nsBefore, "src/app.ts", ["docs/11-orch.md"], false),
    "REFUSED");
  // stable namespace, hard-linked listed entry from the START -> legitimate
  // prose-contract (cycle-4 hard-link closure holds under re-walk)
  const nsHl: NS = new Map([["src/app.ts", 7], ["docs/11-orch.md", 7]]);
  assert.equal(classifyUnderProtocol(nsHl, nsHl, "src/app.ts", ["docs/11-orch.md"], true), true);
  // stable namespace, unrelated listed entry -> null (code round)
  assert.equal(classifyUnderProtocol(nsBefore, nsBefore, "src/app.ts", ["docs/11-orch.md"], true), false);
});

// ---- v36 cycle-44 major 1: alias-refusal vs "never refuse" precedence ----
// A byte-identical COPY of a listed contract at an unlisted path satisfies
// BOTH prose descriptions at once: its identity matches NO listed entry
// (which read alone says "never refuse"), while its bytes equal a listed
// contract's (the alias test says REFUSE). The precedence rule: the alias
// test is open-validation, runs FIRST, and the listed-entries sentence is
// only about digest DIFFERENCE never being a refusal ground — it never
// licenses admitting a suspected alias. Model: entries carry (identity,
// bytes); openOrder = did the alias test run before classification.
interface PathEntry { identity: number; bytes: string }
function classifyWithAliasPrecedence(
  target: PathEntry, listed: PathEntry[], aliasTestFirst: boolean,
): boolean | "REFUSED" {
  const identityMatches = listed.some((e) => e.identity === target.identity);
  const bytesMatchSomeListed = listed.some((e) => e.bytes === target.bytes);
  if (aliasTestFirst) {
    // Correct contract order: alias suspected => REFUSED, single outcome.
    if (!identityMatches && bytesMatchSomeListed) return "REFUSED";
    return identityMatches;
  }
  // Defeated order (cycle-44 ambiguity): the "never refuse" clause applied
  // without qualification admits the byte-identical copy unkinded.
  return identityMatches;
}

test("c44-M1: byte-identical copy at unlisted path is REFUSED by the alias test (precedence)", () => {
  const contract: PathEntry = { identity: 9, bytes: "contract-text" };
  const copy: PathEntry = { identity: 42, bytes: "contract-text" }; // unlisted alias
  const code: PathEntry = { identity: 50, bytes: "code-text" };
  // Correct precedence: alias first => the copy is REFUSED, never null-kinded.
  assert.equal(classifyWithAliasPrecedence(copy, [contract], true), "REFUSED",
    "byte-identical copy with no identity match is refused as a suspected alias");
  // The "never refuse" sentence holds for its intended case: a DIFFERENT
  // file (different bytes AND no identity match) classifies null, never
  // refuses merely because a listed digest differs.
  assert.equal(classifyWithAliasPrecedence(code, [contract], true), false,
    "different file: listed-digest difference is never a refusal ground");
  // Positive control: same identity => legitimate prose-contract.
  assert.equal(classifyWithAliasPrecedence({ identity: 9, bytes: "contract-text" }, [contract], true), true);
  // Models the defeat the qualification closes: skipping the alias test
  // admits the copy as null (unclassified contract text through code tier).
  assert.equal(classifyWithAliasPrecedence(copy, [contract], false), false,
    "defeated order: unqualified 'never refuse' admits the alias — why the precedence is normative");
});

// ---- v36 cycle-18: trust-boundary exclusivity + durable snapshot ---------
// DirStat models the fstat of a chain directory at the commit instant.
interface DirStat { uid: number; mode: number } // mode: low 9 bits
const MODE_NO_GROUP_OTHER_WRITE = (m: number) => (m & 0o022) === 0;

interface CommitCtx {
  locked: boolean;                 // namespace lock held through append
  supervisorEuid: number;
  attestedDedicatedEuid: number | null; // deployment manifest attestation
  chainDirs: DirStat[];            // every dir in every chain, root -> leaf parent
  nsAtResolve: NS; nsNow: NS;
  targetPath: string; listed: string[];
}

// Cycle-17 mode-bit proof was claimed universal; cycle-18 blocker 1: a
// same-euid non-cooperating writer defeats it. The corrected mechanism:
// mode proof (all dirs) AND supervisorEuid === attestedDedicatedEuid;
// missing/mismatched attestation => REFUSED (shared-uid deployments cannot
// mint). Same-euid/privileged writers INSIDE the attested euid are declared
// TCB: the contract makes no claim against them (models: they are NOT a
// counterexample; see the adversarial vector).
function commitUnderTrustBoundary(c: CommitCtx): boolean | "REFUSED" {
  if (!c.locked) return "REFUSED";
  if (c.attestedDedicatedEuid === null || c.attestedDedicatedEuid !== c.supervisorEuid) return "REFUSED";
  for (const d of c.chainDirs) {
    if (d.uid !== c.supervisorEuid || !MODE_NO_GROUP_OTHER_WRITE(d.mode)) return "REFUSED";
  }
  const r = classifyUnderProtocol(c.nsAtResolve, c.nsNow, c.targetPath, c.listed, true);
  return r; // re-walk divergence still refuses
}

const CHAIN_OK: DirStat[] = [{ uid: 5001, mode: 0o750 }, { uid: 5001, mode: 0o750 }];
const NS_STABLE: NS = new Map([["src/app.ts", 7], ["docs/11-orch.md", 9]]);
const NS_SWAP: NS = new Map([["src/app.ts", 7], ["docs/11-orch.md", 7]]);

test("v36 cycle-18: exclusivity requires mode proof AND dedicated-euid attestation; refuse otherwise", () => {
  const base: CommitCtx = {
    locked: true, supervisorEuid: 5001, attestedDedicatedEuid: 5001,
    chainDirs: CHAIN_OK, nsAtResolve: NS_STABLE, nsNow: NS_STABLE,
    targetPath: "src/app.ts", listed: ["docs/11-orch.md"],
  };
  // positive: attested dedicated euid + clean chains -> classifies normally
  assert.equal(commitUnderTrustBoundary(base), false, "code target, stable -> null");
  // attestation missing -> REFUSED (cannot establish exclusivity vs same-uid writers)
  assert.equal(commitUnderTrustBoundary({ ...base, attestedDedicatedEuid: null }), "REFUSED");
  // attestation names a different euid -> REFUSED
  assert.equal(commitUnderTrustBoundary({ ...base, attestedDedicatedEuid: 5002 }), "REFUSED");
  // group-writable chain dir -> REFUSED even with attestation
  assert.equal(commitUnderTrustBoundary({ ...base, chainDirs: [{ uid: 5001, mode: 0o770 }, ...CHAIN_OK] }), "REFUSED");
  // foreign-owned chain dir -> REFUSED
  assert.equal(commitUnderTrustBoundary({ ...base, chainDirs: [...CHAIN_OK, { uid: 0, mode: 0o750 }] }), "REFUSED");
});

test("v36 cycle-18 adversarial: same-euid post-re-walk swap is INSIDE the declared TCB (mode bits alone would have accepted it — attestation shared-uid refuses before the swap matters)", () => {
  // Attacker runs at the supervisor's euid (shared account, attestation
  // absent/shared): swaps a listed path AFTER the final re-walk. The mode
  // proof passes (same uid, clean bits) — proving mode bits cannot refute
  // this writer. The corrected mechanism never reaches that state in a
  // shared-uid deployment: no dedicated attestation => REFUSED up front.
  const shared: CommitCtx = {
    locked: true, supervisorEuid: 5001, attestedDedicatedEuid: null, // shared account
    chainDirs: CHAIN_OK, nsAtResolve: NS_STABLE, nsNow: NS_SWAP,
    targetPath: "src/app.ts", listed: ["docs/11-orch.md"],
  };
  assert.equal(commitUnderTrustBoundary(shared), "REFUSED",
    "shared-euid deployment: open dies before the swap window is even reachable");
  // In an ATTESTED deployment the same swap by a same-euid process is a TCB
  // breach (declared in-scope compromise, integrity-fault territory), not
  // a contract counterexample — the contract claims cover only processes
  // OUTSIDE the attested boundary.
});

// Durable snapshot store model: content-addressed, verified at recovery.
// v36 cycle-20 major 1: recovery is SPLIT by delivery-acceptance state —
// `deliveryAccepted` says whether the round's delivery was already
// accepted (or a boundary verdict covering it issued). A missing entry
// BEFORE acceptance is an unfinished round => abandonable; a missing entry
// AFTER acceptance is an INTEGRITY FAULT (accepted verdicts are never
// retroactively recomputed from later store state).
type SnapStore = Map<string, Buffer>; // targetDigest -> stored bytes
type Recovery =
  | { ok: true; delivered: Buffer }
  | { abandoned: true }
  | { integrityFault: true };

function recoverDeliver(
  store: SnapStore, targetDigest: string, livePathBytes: Buffer, deliveryAccepted = false,
): Recovery {
  const entry = store.get(targetDigest);
  if (entry === undefined) {
    // eligible lifecycle state: only an UNACCEPTED round may be abandoned
    return deliveryAccepted ? { integrityFault: true } : { abandoned: true };
  }
  if (createHash("sha256").update(entry).digest("hex") !== targetDigest) return { integrityFault: true };
  void livePathBytes; // under NO recovery path is the live path re-read
  return { ok: true, delivered: entry };
}

test("v36 cycle-18: crash recovery resumes only from the verified content-addressed snapshot", () => {
  const good = Buffer.from('{"roundKind":"text","summary":"v1"}', "utf8");
  const digest = createHash("sha256").update(good).digest("hex");
  const live = Buffer.from("MUTATED-AFTER-CRASH", "utf8");
  // healthy store -> delivery from snapshot, live path ignored
  const ok = recoverDeliver(new Map([[digest, good]]), digest, live);
  assert.ok("delivered" in ok && ok.delivered.equals(good), "resume delivers the snapshot bytes");
  // missing entry (delivery not yet accepted) -> abandoned, never re-digested from the live path
  assert.deepEqual(recoverDeliver(new Map(), digest, live, false), { abandoned: true });
  // tampered entry -> integrity fault, live path still never read
  assert.deepEqual(recoverDeliver(new Map([[digest, live]]), digest, live), { integrityFault: true });
});

test("v36 cycle-20: missing snapshot AFTER delivery acceptance is an integrity fault, never a retroactive abandonment", () => {
  const good = Buffer.from('{"roundKind":null,"summary":"delivered"}', "utf8");
  const digest = createHash("sha256").update(good).digest("hex");
  const live = Buffer.from("irrelevant", "utf8");
  // accepted round, store entry later lost -> integrity fault; the round
  // STAYS a round of its streak (no abandon transition is eligible)
  assert.deepEqual(recoverDeliver(new Map(), digest, live, true), { integrityFault: true });
  // streak consequence: an accepted round's history is untouched by the
  // later store loss — its rounds still count
  const rounds: Round[] = [C(), C()]; // two accepted clean code rounds
  assert.equal(converged(rounds), true, "accepted convergence is not retroactively undone");
});

// ---- v36 cycle-19 blocker 1: effective-ACL proof (mode bits are NOT the
// full access model). A chain dir can pass owner + `st_mode & 0o022 == 0`
// while a POSIX/NFSv4 ACL grants w to an unrelated principal. Model: each
// dir carries acls[] of {principalUid, writable}; ANY writable entry whose
// principal is not the supervisor euid fails the proof. A null ACL query
// result models an unenumerable platform -> proof UNESTABLISHABLE -> refuse
// (absence of evidence is failure of evidence).
// v36 cycle-20 blocker 1: `writable` alone is INCOMPLETE — on platforms
// whose ACL grants DELETE-CHILD (rename/delete of a child) independently
// of write, an unrelated principal holding ONLY delete_child can mutate
// the namespace while the w-only proof stands green. The covered set is
// every directory-entry-modifying permission: writable OR deleteChild.
interface AclEntry {
  principalUid: number | "group" | "other";
  writable: boolean;
  deleteChild?: boolean; // NFSv4 delete_child/rename_child equivalents (directory level)
  deletes?: boolean;     // v36 cycle-21 blocker 1: child-object OWN delete/rename authority
}
interface ChainDir extends DirStat { acls: AclEntry[] | null } // null: no ACL API

// v36 cycle-22 blocker 1 / cycle-23 blocker 1: the child-object scope is
// EVERY OBJECT THE PATH CONSUMES — workspace root + every intermediate
// directory of the target and each listed-entry path (each observed via
// its re-walk descriptor) + the leaf files. On platforms where an
// object's own ACL authorizes delete/rename independently, a grant on ANY
// of them (including the workspace root as child of its parent — the
// root-binding anchor: the walk terminates at a mount point whose binding
// is kernel-immutable, EBUSY on rename) breaks the path binding after the
// re-walk while everything below stays green.
function enumerateChildObjects(paths: string[]): string[] {
  const objs = new Set<string>(["<workspace-root>"]);
  for (const p of paths) {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) objs.add(segs.slice(0, i).join("/")); // intermediates
    objs.add(p); // leaf
  }
  return [...objs].sort();
}

// v36 cycle-23 minor 1: child-object evidence is REQUIRED per enumerated
// object — build a full-evidence map (every scope object clean) and set
// exceptions on top; omitting evidence is a refusal, not a skip.
function childEvidence(
  paths: string[], exceptions?: Record<string, AclEntry[] | null>,
): Map<string, AclEntry[] | null> {
  const m = new Map<string, AclEntry[] | null>();
  for (const o of enumerateChildObjects(paths)) m.set(o, []);
  for (const [k, v] of Object.entries(exceptions ?? {})) m.set(k, v);
  return m;
}

// v36 cycle-24 blocker 1 + major 1: ROOT-BINDING ANCHOR — the upward walk
// modeled explicitly. The workspace root is itself a child of its parent;
// the walk goes up from the workspace root and terminates at the first
// KERNEL-IMMUTABLE BINDING: `/` (isFsRoot — no parent entry exists at any
// permission level) or a MOUNT POINT (dev != parentDev; cross-boundary
// rename fails EBUSY at kernel level). Every directory BELOW the anchor
// (exclusive) gets the ANCESTOR PROOF — effective AUTHORITY, not
// ownership (cycle-23's ownership requirement refused every ordinary
// deployment with root-owned ancestors and never terminated on `/`, whose
// st_dev equals its own parent's — WITHDRAWN): (i) A's parent's effective
// entry-modifying authority grants write/delete-child to NO principal
// outside the declared TCB; (ii) A's own object delete/rename ACL grants
// delete to no principal outside the declared TCB. Declared TCB = the
// supervisor's attested euid + uid 0 (root) per clause (c): a root-owned
// 0755 ancestor PASSES (its effective authority reaches only root, an
// inside-TCB principal) — proven by authority, never required to re-owner.
interface AncestorDir {
  name: string;
  dev: number;          // st_dev reported for A
  parentDev: number;    // st_dev reported for A's parent directory
  isFsRoot?: boolean;   // `/` — the structurally terminal anchor
  parentEntryAcls: AclEntry[] | null; // effective entry-modifying authority of A's parent (null: unenumerable)
  ownDeleteAcls: AclEntry[] | null;   // A's own-object delete/rename ACL (null: unenumerable)
}

function insideDeclaredTcb(principal: number | "group" | "other", supervisorEuid: number): boolean {
  if (principal === "group" || principal === "other") return false; // ambiguous identity is never inside
  return principal === supervisorEuid || principal === 0;            // supervisor euid + root (clause (c))
}

function verifyRootBinding(ancestors: AncestorDir[] | null, supervisorEuid: number): "OK" | "REFUSED" {
  if (ancestors === null || ancestors.length === 0) return "REFUSED"; // walk not completable => UNESTABLISHABLE
  if (ancestors.length > 64) return "REFUSED"; // no anchor established within 64 hops
  let anchorIdx = -1;
  for (let i = 0; i < ancestors.length; i++) {
    const a = ancestors[i];
    if (!a) return "REFUSED";
    if (a.isFsRoot === true || a.dev !== a.parentDev) { anchorIdx = i; break; } // kernel-immutable binding
  }
  if (anchorIdx === -1) return "REFUSED"; // no mount point, no `/` — the chain floats
  for (let i = 0; i < anchorIdx; i++) {
    const a = ancestors[i];
    if (!a) return "REFUSED";
    if (a.parentEntryAcls === null) return "REFUSED"; // (i) evidence missing => UNESTABLISHABLE
    for (const e of a.parentEntryAcls) {
      if ((e.writable || e.deleteChild === true) && !insideDeclaredTcb(e.principalUid, supervisorEuid)) return "REFUSED";
    }
    if (a.ownDeleteAcls === null) return "REFUSED"; // (ii) evidence missing => UNESTABLISHABLE
    for (const e of a.ownDeleteAcls) {
      if ((e.deletes ?? false) && !insideDeclaredTcb(e.principalUid, supervisorEuid)) return "REFUSED";
    }
  }
  return "OK"; // anchor found; every dir below it proven by EFFECTIVE AUTHORITY (no ownership demanded)
}

// Ordinary deployment on the ROOT filesystem: workspace under root-owned
// ancestors (uid 0, 0755 — grants reach only root, inside the declared TCB),
// terminating at `/`. This deployment OPENS (the cycle-23 blocker refused
// every one of these).
const ANCESTORS_CLEAN: AncestorDir[] = [
  { name: "ws", dev: 42, parentDev: 42,
    parentEntryAcls: [{ principalUid: 0, writable: true, deleteChild: true }],
    ownDeleteAcls: [{ principalUid: 0, writable: false, deletes: true }] },
  { name: "Users", dev: 42, parentDev: 42, parentEntryAcls: [{ principalUid: 0, writable: true }], ownDeleteAcls: [] },
  { name: "/", dev: 42, parentDev: 42, isFsRoot: true, parentEntryAcls: [], ownDeleteAcls: [] },
];

function commitWithAclProof(
  c: CommitCtx & { chainAcls: (AclEntry[] | null)[]; childAcls: Map<string, AclEntry[] | null>; ancestors: AncestorDir[] | null },
): boolean | "REFUSED" {
  if (!c.locked) return "REFUSED";
  if (c.attestedDedicatedEuid === null || c.attestedDedicatedEuid !== c.supervisorEuid) return "REFUSED";
  for (let i = 0; i < c.chainDirs.length; i++) {
    const d = c.chainDirs[i];
    if (!d) continue;
    if (d.uid !== c.supervisorEuid || !MODE_NO_GROUP_OTHER_WRITE(d.mode)) return "REFUSED";
    const acls = c.chainAcls[i] ?? null; // missing entry: unenumerable, same as null
    if (acls === null) return "REFUSED"; // unenumerable => proof fails
    for (const a of acls) {
      // v36 cycle-20 blocker 1: EVERY entry-modifying permission counts —
      // write OR delete-child (a foreign principal with ONLY delete_child
      // can still mutate the namespace between re-walk and append).
      if ((a.writable || a.deleteChild === true) && a.principalUid !== c.supervisorEuid) return "REFUSED";
    }
  }
  // v36 cycle-21 blocker 1 + cycle-22 blocker 1 + cycle-23 minor 1:
  // child-object delete authority is a REQUIRED proof — exactly one ACL
  // result per enumerated object (root, every intermediate, every leaf).
  // A missing Map entry is MISSING EVIDENCE and an explicit null is
  // UNENUMERABLE child semantics: both are UNESTABLISHABLE => refuse
  // (absence of evidence is failure of evidence; the proof can never be
  // silently skipped by omitting the argument).
  const scope = enumerateChildObjects([c.targetPath, ...c.listed]);
  for (const obj of scope) {
    if (!c.childAcls.has(obj)) return "REFUSED"; // missing-entry: no evidence
    const ca = c.childAcls.get(obj);
    if (ca === null || ca === undefined) return "REFUSED"; // unenumerable
    for (const a of ca) {
      if ((a.deletes ?? false) && a.principalUid !== c.supervisorEuid) return "REFUSED";
      // v36 cycle-25 major 1: CONTENT-write authority on the leaf FILES
      // (target + every listed-entry file) is in the same covered set —
      // an outside writer mutates the pinned inode's bytes after the final
      // pre-append re-fstat, so the manifest's targetDigest would not
      // match the target's bytes at append. Directories are excluded here
      // (their entry-modifying authority is the chain proof's job; `w` on
      // a dir is not content-write).
      const isLeafFile = obj === c.targetPath || c.listed.includes(obj); // leaves are FILES in scope
      if (isLeafFile && a.writable && !insideDeclaredTcb(a.principalUid, c.supervisorEuid)) return "REFUSED"; // doc: outside the declared TCB
    }
  }
  // v36 cycle-24: the namespace proof must terminate at a kernel-immutable
  // binding — the ancestor walk is part of the open, not optional.
  if (verifyRootBinding(c.ancestors, c.supervisorEuid) !== "OK") return "REFUSED";
  return classifyUnderProtocol(c.nsAtResolve, c.nsNow, c.targetPath, c.listed, true);
}

test("v36 cycle-19: ACL-widened chain dir REFUSES the open though mode bits pass", () => {
  const base = {
    locked: true, supervisorEuid: 5001, attestedDedicatedEuid: 5001,
    nsAtResolve: NS_STABLE, nsNow: NS_STABLE,
    targetPath: "src/app.ts", listed: ["docs/11-orch.md"],
    ancestors: ANCESTORS_CLEAN,
  };
  // mode proof alone would ACCEPT an ACL-widened dir — positive control
  // that the ACL entry is invisible to st_mode:
  const widened: DirStat = { uid: 5001, mode: 0o750 };
  assert.ok(MODE_NO_GROUP_OTHER_WRITE(widened.mode), "mode bits pass on the ACL-widened dir (the cycle-18 defect)");
  assert.equal(commitWithAclProof({
    ...base, chainDirs: [widened, ...CHAIN_OK],
    chainAcls: [[{ principalUid: 6002, writable: true }], [], []],
    childAcls: childEvidence(["src/app.ts", "docs/11-orch.md"]),
  }), "REFUSED", "an unrelated uid holding w via ACL => exclusion proof fails");
  // group-writable ACL entry also fails (principal is not the euid)
  assert.equal(commitWithAclProof({
    ...base, chainDirs: CHAIN_OK,
    chainAcls: [[{ principalUid: "group", writable: true }], [], []],
    childAcls: childEvidence(["src/app.ts", "docs/11-orch.md"]),
  }), "REFUSED");
  // unenumerable ACL => UNESTABLISHABLE => refuse, never assume absence
  assert.equal(commitWithAclProof({
    ...base, chainDirs: CHAIN_OK, chainAcls: [null, [], []],
    childAcls: childEvidence(["src/app.ts", "docs/11-orch.md"]),
  }), "REFUSED");
  // clean: every ACL entry read-only for non-supervisor principals -> classifies
  assert.equal(commitWithAclProof({
    ...base, chainDirs: CHAIN_OK,
    chainAcls: [[{ principalUid: 6002, writable: false }], [], []],
    childAcls: childEvidence(["src/app.ts", "docs/11-orch.md"]),
  }), false, "read-only foreign ACL entry does not widen write access");
});

test("v36 cycle-20: delete-child-only ACL entry REFUSES though the w-only proof would pass", () => {
  const base = {
    locked: true, supervisorEuid: 5001, attestedDedicatedEuid: 5001,
    chainDirs: CHAIN_OK, nsAtResolve: NS_STABLE, nsNow: NS_STABLE,
    targetPath: "src/app.ts", listed: ["docs/11-orch.md"],
    ancestors: ANCESTORS_CLEAN,
  };
  // Positive control for the cycle-20 defect: an entry granting ONLY
  // delete_child (no write) is invisible to the w-only test — that
  // principal can still remove/rename a child between re-walk and append.
  const deleteOnly: AclEntry = { principalUid: 6002, writable: false, deleteChild: true };
  const wOnly = (e: AclEntry) => e.writable; // the superseded w-only test
  assert.equal(wOnly(deleteOnly), false, "w-only proof would ACCEPT the delete-child grant (the defeat)");
  assert.equal(commitWithAclProof({
    ...base, chainAcls: [[deleteOnly], [], []],
    childAcls: childEvidence(["src/app.ts", "docs/11-orch.md"]),
  }), "REFUSED",
    "entry-modifying set covers delete-child: the grant fails the proof");
  // rename-child equivalent folds into the same flag; read-only+no-delete stays accepted
  assert.equal(commitWithAclProof({
    ...base, chainAcls: [[{ principalUid: 6002, writable: false, deleteChild: false }], [], []],
    childAcls: childEvidence(["src/app.ts", "docs/11-orch.md"]),
  }), false);
  // v36 cycle-23 minor 1: OMITTING child-object evidence REFUSES — the
  // proof can never be skipped by leaving the argument out.
  assert.equal(commitWithAclProof({ ...base, chainAcls: [[], [], []], childAcls: new Map() }), "REFUSED",
    "missing child-object evidence => UNESTABLISHABLE");
});

test("v36 cycle-21: child-object delete ACL REFUSES though every parent-directory proof passes", () => {
  const base = {
    locked: true, supervisorEuid: 5001, attestedDedicatedEuid: 5001,
    chainDirs: CHAIN_OK, nsAtResolve: NS_STABLE, nsNow: NS_STABLE,
    targetPath: "src/app.ts", listed: ["docs/11-orch.md"],
    ancestors: ANCESTORS_CLEAN,
    chainAcls: [[], [], []], // all parent dirs provably clean
  };
  const clean = childEvidence(["src/app.ts", "docs/11-orch.md"]);
  // v36 cycle-23 minor 1: child evidence is REQUIRED — a context with no
  // child-object evidence REFUSES (missing evidence = failed evidence);
  // the proof can no longer be silently skipped.
  assert.equal(commitWithAclProof({ ...base, childAcls: new Map() }), "REFUSED",
    "no child-object evidence => UNESTABLISHABLE");
  // full clean evidence -> classifies
  assert.equal(commitWithAclProof({ ...base, childAcls: clean }), false);
  // foreign principal holds delete on the target file itself -> REFUSED
  assert.equal(commitWithAclProof({
    ...base,
    childAcls: childEvidence(["src/app.ts", "docs/11-orch.md"],
      { "src/app.ts": [{ principalUid: 6002, writable: false, deletes: true }] }),
  }), "REFUSED", "child-object delete authority breaks the binding after re-walk");
  // unenumerable child semantics -> UNESTABLISHABLE -> REFUSED
  assert.equal(commitWithAclProof({
    ...base, childAcls: childEvidence(["src/app.ts", "docs/11-orch.md"], { "docs/11-orch.md": null }),
  }), "REFUSED");
  // read-only foreign entry on the child (no delete) -> accepted
  assert.equal(commitWithAclProof({
    ...base,
    childAcls: childEvidence(["src/app.ts", "docs/11-orch.md"],
      { "src/app.ts": [{ principalUid: 6002, writable: false, deletes: false }] }),
  }), false);
});

test("v36 cycle-22: child-object scope covers intermediate directories, not just leaves", () => {
  const objs = enumerateChildObjects(["src/app.ts", "docs/11-orch.md"]);
  assert.deepEqual(objs, [
    "<workspace-root>",
    "docs",            // intermediate of listed entry
    "docs/11-orch.md", // leaf
    "src",             // intermediate of target — REQUIRED in scope
    "src/app.ts",
  ]);
  // Model effect: the child-acl loop refuses on ANY in-scope object whose
  // own ACL grants a foreign principal delete — an entry at index for the
  // "src" intermediate is checked exactly like a leaf entry.
  const base = {
    locked: true, supervisorEuid: 5001, attestedDedicatedEuid: 5001,
    chainDirs: CHAIN_OK, nsAtResolve: NS_STABLE, nsNow: NS_STABLE,
    targetPath: "src/app.ts", listed: ["docs/11-orch.md"],
    ancestors: ANCESTORS_CLEAN,
    chainAcls: [[], [], []],
  };
  // foreign delete on the intermediate "src" -> REFUSED even though it is
  // not the target and not a parent-of-leaf write grant
  assert.equal(commitWithAclProof({
    ...base,
    childAcls: childEvidence(["src/app.ts", "docs/11-orch.md"],
      { "src": [{ principalUid: 6002, writable: false, deletes: true }] }),
  }), "REFUSED", "intermediate directory is a child object in scope");
  // foreign delete on the WORKSPACE ROOT (as child of its parent) -> REFUSED
  assert.equal(commitWithAclProof({
    ...base,
    childAcls: childEvidence(["src/app.ts", "docs/11-orch.md"],
      { "<workspace-root>": [{ principalUid: 6002, writable: false, deletes: true }] }),
  }), "REFUSED", "root is in child scope — its own delete authority is checked (cycle-23 root anchor)");
  // unenumerable intermediate -> UNESTABLISHABLE
  assert.equal(commitWithAclProof({
    ...base, childAcls: childEvidence(["src/app.ts", "docs/11-orch.md"], { src: null }),
  }), "REFUSED");
  // MISSING evidence for one object (cycle-23 minor 1) -> UNESTABLISHABLE
  const partial = childEvidence(["src/app.ts", "docs/11-orch.md"]);
  partial.delete("docs");
  assert.equal(commitWithAclProof({ ...base, childAcls: partial }), "REFUSED",
    "one enumerated object without evidence => the whole proof fails");
});

test("v36 cycle-25: outside CONTENT-write on a leaf file REFUSES — the in-place-write window is closed at authority level", () => {
  const base = {
    locked: true, supervisorEuid: 5001, attestedDedicatedEuid: 5001,
    chainDirs: CHAIN_OK, nsAtResolve: NS_STABLE, nsNow: NS_STABLE,
    targetPath: "src/app.ts", listed: ["docs/11-orch.md"],
    ancestors: ANCESTORS_CLEAN, chainAcls: [[], [], []],
  };
  // Positive control for the defect: a foreign write grant on the target
  // FILE is invisible to the delete-only child test — that principal can
  // rewrite the pinned bytes after the final re-fstat, stranding
  // targetDigest against stale bytes at append.
  const writeGrant: AclEntry = { principalUid: 6002, writable: true };
  const deleteOnlyTest = (e: AclEntry) => e.deletes ?? false; // superseded covered set
  assert.equal(deleteOnlyTest(writeGrant), false, "delete-only test ACCEPTS the write grant (the defeat)");
  assert.equal(commitWithAclProof({
    ...base,
    childAcls: childEvidence(["src/app.ts", "docs/11-orch.md"],
      { "src/app.ts": [writeGrant] }),
  }), "REFUSED", "outside content-write on the target fails the exclusion proof");
  // Same on a listed-contract file (alias check would rest on stale bytes)
  assert.equal(commitWithAclProof({
    ...base,
    childAcls: childEvidence(["src/app.ts", "docs/11-orch.md"],
      { "docs/11-orch.md": [{ principalUid: "other", writable: true }] }),
  }), "REFUSED", "outside content-write on a listed entry fails the proof");
  // Read-only foreign entry on a leaf file stays accepted (no content authority)
  assert.equal(commitWithAclProof({
    ...base,
    childAcls: childEvidence(["src/app.ts", "docs/11-orch.md"],
      { "src/app.ts": [{ principalUid: 6002, writable: false }] }),
  }), false, "read-only foreign file entry grants no content authority");
});

// v36 cycle-26 hardening: the snapshot write PATH (.tre and .tre/snapshots)
// carries the SAME permission + effective-ACL proofs as workspace chain
// dirs — the doc says "its chain directories pass the same permission +
// effective-ACL checks"; a carve-out here would let an outside principal
// plant or redirect the snapshot entry before creation. Missing evidence
// for any path dir is UNESTABLISHABLE (absence of evidence is failure of
// evidence), exactly as for workspace chain dirs.
function prepareSnapshotWithDirs(
  pathDirs: Map<string, StoreEntry>, digest: string, bytes: Buffer, supervisorEuid: number,
): "WRITTEN" | "REFUSED-AMBIGUOUS" {
  for (const d of [".tre", ".tre/snapshots"]) {
    const e = pathDirs.get(d);
    if (e === undefined) return "REFUSED-AMBIGUOUS"; // missing evidence
    if (e.uid !== supervisorEuid || (e.mode & 0o022) !== 0) return "REFUSED-AMBIGUOUS";
    const acls = e.fileAcls === undefined ? null : e.fileAcls; // undefined => unenumerable
    if (acls === null) return "REFUSED-AMBIGUOUS";
    for (const a of acls) {
      if ((a.writable || a.deleteChild === true) && a.principalUid !== supervisorEuid) return "REFUSED-AMBIGUOUS";
    }
  }
  return "WRITTEN"; // path proven; the entry-level proof applies as before
}

test("v36 cycle-26: snapshot write-path directories carry the SAME proofs as workspace chain dirs — no exception", () => {
  const good = Buffer.from('{"roundKind":null,"summary":"path"}', "utf8");
  const digest = createHash("sha256").update(good).digest("hex");
  // .tre and .tre/snapshots dirs: supervisor-owned, clean mode, no foreign ACL
  const cleanDir: StoreEntry = { bytes: Buffer.alloc(0), uid: 5001, mode: 0o700, kind: "dir", fileAcls: [] };
  const aclWidened: StoreEntry = {
    bytes: Buffer.alloc(0), uid: 5001, mode: 0o700, kind: "dir",
    fileAcls: [{ principalUid: 6002, writable: true }], // passes mode, fails ACL
  };
  const foreignOwned: StoreEntry = { bytes: Buffer.alloc(0), uid: 6002, mode: 0o700, kind: "dir", fileAcls: [] };
  // Positive control: mode bits alone ACCEPT the ACL-widened dir (the defeat)
  assert.ok(MODE_NO_GROUP_OTHER_WRITE(aclWidened.mode));
  // healthy path -> WRITTEN
  const okStore = new Map<string, StoreEntry>([
    [".tre", cleanDir], [".tre/snapshots", cleanDir],
  ]);
  assert.equal(prepareSnapshotWithDirs(okStore, digest, good, 5001), "WRITTEN");
  // ACL-widened .tre/snapshots -> REFUSED-AMBIGUOUS (mode proof passes!)
  const widened = new Map<string, StoreEntry>([
    [".tre", cleanDir], [".tre/snapshots", aclWidened],
  ]);
  assert.equal(prepareSnapshotWithDirs(widened, digest, good, 5001), "REFUSED-AMBIGUOUS",
    "snapshot path dir with foreign ACL write grant refuses — the exact defect class");
  // foreign-owned path dir -> REFUSED-AMBIGUOUS
  const foreign = new Map<string, StoreEntry>([
    [".tre", cleanDir], [".tre/snapshots", foreignOwned],
  ]);
  assert.equal(prepareSnapshotWithDirs(foreign, digest, good, 5001), "REFUSED-AMBIGUOUS");
  // missing dir evidence -> UNESTABLISHABLE -> REFUSED
  const partial = new Map<string, StoreEntry>([[".tre", cleanDir]]);
  assert.equal(prepareSnapshotWithDirs(partial, digest, good, 5001), "REFUSED-AMBIGUOUS");
});

test("v36 cycle-24: root-binding anchor — ordinary root-fs deployment OPENS; foreign ancestor authority REFUSES", () => {
  const cleanChild = childEvidence(["src/app.ts", "docs/11-orch.md"]);
  const base = {
    locked: true, supervisorEuid: 5001, attestedDedicatedEuid: 5001,
    chainDirs: CHAIN_OK, nsAtResolve: NS_STABLE, nsNow: NS_STABLE,
    targetPath: "src/app.ts", listed: ["docs/11-orch.md"],
    chainAcls: [[], [], []], childAcls: cleanChild,
  };
  // Ordinary deployment: root-owned ancestors, terminating at `/` — the
  // cycle-23 rule refused this (dev-change never fires on `/`); the
  // corrected term rule anchors it and effective authority passes (root
  // is inside the declared TCB by clause (c)).
  assert.equal(commitWithAclProof({ ...base, ancestors: ANCESTORS_CLEAN }), false,
    "root-fs workspace with root-owned ancestors OPENS (cycle-24 blocker 1 regression guard)");
  // Separate mount: workspace root sits on its own device below the anchor
  const mounted: AncestorDir[] = [
    { name: "ws", dev: 77, parentDev: 42, // mount point: dev != parentDev
      parentEntryAcls: [{ principalUid: 0, writable: true }], ownDeleteAcls: [] },
    { name: "/", dev: 42, parentDev: 42, isFsRoot: true, parentEntryAcls: [], ownDeleteAcls: [] },
  ];
  assert.equal(commitWithAclProof({ ...base, ancestors: mounted }), false,
    "mount-point anchor (dev change) terminates the walk");
  // Foreign uid holds delete_child on an ancestor's parent entry -> REFUSED
  assert.equal(commitWithAclProof({
    ...base,
    ancestors: [
      { name: "ws", dev: 42, parentDev: 42,
        parentEntryAcls: [{ principalUid: 6002, writable: false, deleteChild: true }], // outside TCB
        ownDeleteAcls: [] },
      ...ANCESTORS_CLEAN.slice(1),
    ],
  }), "REFUSED", "non-TCB principal with delete_child on the ancestor chain breaks the anchor proof");
  // Foreign uid holds delete on an ancestor's OWN object -> REFUSED
  assert.equal(commitWithAclProof({
    ...base,
    ancestors: [
      { name: "ws", dev: 42, parentDev: 42, parentEntryAcls: [],
        ownDeleteAcls: [{ principalUid: 6002, writable: false, deletes: true }] }, // outside TCB
      ...ANCESTORS_CLEAN.slice(1),
    ],
  }), "REFUSED", "outside delete authority on an ancestor object fails the proof");
  // Missing ancestor evidence (null ACL) -> UNESTABLISHABLE -> REFUSED
  assert.equal(commitWithAclProof({
    ...base,
    ancestors: [
      { name: "ws", dev: 42, parentDev: 42, parentEntryAcls: null, ownDeleteAcls: [] },
      ...ANCESTORS_CLEAN.slice(1),
    ],
  }), "REFUSED", "unenumerable ancestor authority is failure of evidence");
  // No anchor at all (chain never hits `/` or a mount within 64) -> REFUSED
  const floating: AncestorDir[] = Array.from({ length: 40 }, (_, k) => ({
    name: `d${k}`, dev: 42, parentDev: 42, parentEntryAcls: [], ownDeleteAcls: [],
  }));
  assert.equal(verifyRootBinding(floating, 5001), "REFUSED", "a chain with no kernel-immutable anchor floats -> refuse");
  assert.equal(commitWithAclProof({ ...base, ancestors: null }), "REFUSED",
    "walk not completable => UNESTABLISHABLE");
  // Direct unit checks of the anchor rule itself
  assert.equal(verifyRootBinding(ANCESTORS_CLEAN, 5001), "OK");
  assert.equal(verifyRootBinding([], 5001), "REFUSED");
});

test("v36 cycle-21: snapshot file's own write ACL defeats verification timing — REFUSED on reuse", () => {
  const good = Buffer.from('{"roundKind":null,"summary":"acl"}', "utf8");
  const digest = createHash("sha256").update(good).digest("hex");
  // owner+mode pass, but a file ACL grants an outside uid write: the
  // verified bytes could be changed after verification -> refuse.
  const store = new Map<string, StoreEntry>();
  store.set(digest, {
    bytes: good, uid: 5001, mode: 0o600, kind: "file",
    fileAcls: [{ principalUid: 6002, writable: true }],
  });
  assert.equal(prepareSnapshot(store, digest, good, 5001), "REFUSED-AMBIGUOUS");
  // unenumerable file ACL -> UNESTABLISHABLE -> refuse
  store.set(digest, { bytes: good, uid: 5001, mode: 0o600, kind: "file", fileAcls: null });
  assert.equal(prepareSnapshot(store, digest, good, 5001), "REFUSED-AMBIGUOUS");
  // read-only foreign file ACL -> clean reuse
  store.set(digest, {
    bytes: good, uid: 5001, mode: 0o600, kind: "file",
    fileAcls: [{ principalUid: 6002, writable: false }],
  });
  assert.equal(prepareSnapshot(store, digest, good, 5001), "REUSED");
});

// ---- v36 cycle-19 major 1: content-addressed store REUSE branch. O_EXCL
// applies ONLY when the entry is absent; an existing entry is verified
// (regular, digest match, owner+mode exclusion) and REUSED with zero
// writes — repeated clean rounds over unchanged bytes must form streaks.
type StoreEntry = {
  bytes: Buffer; uid: number; mode: number; kind: "file" | "symlink" | "dir";
  // v36 cycle-21 major 1: the snapshot FILE's own effective ACL — a file
  // ACL write grant passes the mode check yet lets an outside principal
  // mutate the entry after verification. null => unenumerable => refuse.
  fileAcls?: (AclEntry[] | null);
};

function prepareSnapshot(
  store: Map<string, StoreEntry>, digest: string, bytes: Buffer, supervisorEuid: number,
): "WRITTEN" | "REUSED" | "REFUSED-AMBIGUOUS" | "INTEGRITY-FAULT" {
  const e = store.get(digest);
  if (e === undefined) {
    // O_EXCL branch: exclusive create then the creator ENUMERATES the fresh
    // object — the recorded empty list is an affirmative proof captured at
    // creation, not an absence of evidence.
    store.set(digest, { bytes, uid: supervisorEuid, mode: 0o600, kind: "file", fileAcls: [] });
    return "WRITTEN";
  }
  if (e.kind !== "file") return "INTEGRITY-FAULT";            // never followed, never overwritten
  if (createHash("sha256").update(e.bytes).digest("hex") !== digest) return "INTEGRITY-FAULT";
  if (e.uid !== supervisorEuid || (e.mode & 0o022) !== 0) return "REFUSED-AMBIGUOUS";
  // v36 cycle-21 major 1: file-level effective-ACL proof on the entry itself.
  // v36 cycle-29 minor 1: MISSING evidence (fileAcls omitted) is UNENUMERABLE
  // — absence of evidence is failure of evidence, exactly as in the directory
  // proof; only an explicitly enumerated list (possibly empty) proves.
  const fa = e.fileAcls === undefined ? null : e.fileAcls;
  if (fa === null) return "REFUSED-AMBIGUOUS"; // unenumerable (or unevidenced) file ACL => UNESTABLISHABLE
  for (const a of fa) {
    if (a.writable && a.principalUid !== supervisorEuid) return "REFUSED-AMBIGUOUS";
  }
  return "REUSED"; // zero writes — the designed steady state
}

test("v36 cycle-29 minor 1: existing entry with fileAcls OMITTED (unenumerable evidence) REFUSES reuse", () => {
  // An existing snapshot entry whose file ACL was never enumerated carries
  // no exclusion proof — reuse would trust bytes an outside principal may
  // steer. Missing evidence REFUSES, same as explicit null (unenumerable).
  const good = Buffer.from('{"roundKind":null,"summary":"stable"}', "utf8");
  const digest = createHash("sha256").update(good).digest("hex");
  const store = new Map<string, StoreEntry>();
  store.set(digest, { bytes: good, uid: 5001, mode: 0o600, kind: "file" }); // fileAcls omitted
  assert.equal(prepareSnapshot(store, digest, good, 5001), "REFUSED-AMBIGUOUS",
    "omitted fileAcls is absence of evidence, not an empty ACL");
  // contrast: explicitly enumerated empty ACL still reuses
  store.set(digest, { bytes: good, uid: 5001, mode: 0o600, kind: "file", fileAcls: [] });
  assert.equal(prepareSnapshot(store, digest, good, 5001), "REUSED");
});

test("v36 cycle-19: second clean round over UNCHANGED bytes reuses the snapshot (streaks can form)", () => {
  const good = Buffer.from('{"roundKind":null,"summary":"stable"}', "utf8");
  const digest = createHash("sha256").update(good).digest("hex");
  const store = new Map<string, StoreEntry>();
  assert.equal(prepareSnapshot(store, digest, good, 5001), "WRITTEN", "round 1: absent-entry branch, exclusive create");
  assert.equal(prepareSnapshot(store, digest, good, 5001), "REUSED", "round 2: existing verified entry reused with zero writes");
  assert.equal(prepareSnapshot(store, digest, good, 5001), "REUSED", "N clean rounds, one entry — dedup is the point");
  // non-regular existing entry -> integrity fault, never followed/overwritten
  store.set(digest, { bytes: Buffer.alloc(0), uid: 5001, mode: 0o777, kind: "symlink" });
  assert.equal(prepareSnapshot(store, digest, good, 5001), "INTEGRITY-FAULT");
  // digest mismatch on an existing entry -> integrity fault, never replaced
  store.set(digest, { bytes: Buffer.from("tampered"), uid: 5001, mode: 0o600, kind: "file" });
  assert.equal(prepareSnapshot(store, digest, good, 5001), "INTEGRITY-FAULT");
  // entry writable from outside the TCB -> refused ambiguous regardless of bytes
  store.set(digest, { bytes: good, uid: 5001, mode: 0o666, kind: "file" });
  assert.equal(prepareSnapshot(store, digest, good, 5001), "REFUSED-AMBIGUOUS");
});

// ---- v36 cycle-19 major 2: `round-abandoned` replay effect on streaks ----

test("v36 cycle-19: a round-abandoned record breaks every kind's streak like a legacy barrier", () => {
  // abandoned CURRENT round: boundary never converges, fresh round needed
  assert.equal(converged([C(), C(), A()]), false);
  // abandoned entry between clean rounds: walk stops there, pre-abandonment
  // rounds never resume the run (same shape as the legacy-barrier vector)
  assert.equal(converged([C(), C(), A(), C()]), false);
  // post-barrier streak converges on its own counted rounds (abandonment
  // is a barrier, not a poison for later legitimate history)
  assert.equal(converged([A(), C(), C()]), true);
  // prose shape identical to the legacy vector
  assert.equal(
    converged([C("prose-contract"), C("prose-contract"), A(), C("prose-contract")]),
    false,
  );
});

// ---- §14.13.3 mint-time recoveryClass (v36 F3, cycle-2 fixes) -----------
// Mirrors the contract: attemptAtDispatch is read through the dispatch-intent
// of THIS dispatchId (never the task's highest attempt); lineage root
// settlement is read from the prefix; every refusal throws (no default).
type Rec =
  | { kind: "attempt"; taskId: string; attemptNumber: number; sessionId: string | null } // v36 c10 M1: join key
  | { kind: "dispatch-intent"; dispatchId: string; taskId: string; taskAttemptNumber: number; sessionId: string }
  | { kind: "intent-phase"; id: string; ts: number;               // §14.13.4a CLOSED shape, all 12 members,
      dispatchId: string; callId: string; attemptNumber: number;  // v36 cycle-10 major 2 — every field
      phase: "call-started" | "call-settled";                     // participates in byte identity
      idempotencyKey: string | null; retryOfCallId: string | null;
      requestDigest: string | null; evidenceRef: string | null;
      outcome: SettlementOutcome | null; recoveryClass: "initial" | "recovery" | null };
const SETTLE_OUTCOMES = ["issued", "no-call", "proven-not-issued", "superseded-attempt"] as const;
type SettlementOutcome = (typeof SETTLE_OUTCOMES)[number];
type IntentPhase = Extract<Rec, { kind: "intent-phase" }>;

// Deterministic key-sorted serialization = the model's canonical bytes.
function canonicalize(r: object): string {
  const keys = Object.keys(r).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + JSON.stringify((r as Record<string, unknown>)[k])).join(",") + "}";
}

function mintClass(prefix: Rec[], dispatchId: string, callId: string, retryOf: string | null): "initial" | "recovery" {
  // Prefix-wide append validation (v36 cycle-10 major 2): any two records
  // sharing an id must be BYTE-IDENTICAL over the complete closed record,
  // checked before any classification so no field can slip past a
  // classification-specific scan.
  {
    const seenCanon = new Map<string, string>();
    for (const r of prefix) {
      if (!("id" in r)) continue;
      const c = canonicalize(r);
      const prev = seenCanon.get(r.id);
      if (prev !== undefined && prev !== c)
        throw new Error("refused: same-id settlement with divergent bytes (history-integrity-fault)");
      seenCanon.set(r.id, c);
    }
  }
  const intents = prefix.filter((r): r is Extract<Rec, { kind: "dispatch-intent" }> =>
    r.kind === "dispatch-intent" && r.dispatchId === dispatchId);
  if (intents.length === 0) throw new Error("refused: no dispatch-intent for dispatchId");
  // Full-ownership-identity conflict (v36 cycle-13 major 3): ANY two
  // intents for one dispatchId whose complete identity tuple
  // (taskId, taskAttemptNumber, sessionId) differs REFUSE the mint —
  // order-independent (attempt number alone let same-number/different-
  // task pairs pass with first-wins order dependence).
  {
    const idset = new Set(intents.map(i => `${i.taskId}\u0000${i.taskAttemptNumber}\u0000${i.sessionId}`));
    if (idset.size > 1) throw new Error("refused: conflicting dispatch-intent ownership identities");
  }
  // Conflicting call-started records for any callId REFUSE the mint,
  // regardless of which lineage is walked (contract: identity is
  // unique). Full validation (v36 cycle-14 major 2): >1 DISTINCT
  // record ids per callId violates record-once; a same-id redelivery
  // is byte-identical only (already enforced by the canonical-id
  // scan above). Complete canonical record, not a field subset.
  const allStarts = prefix.filter((r): r is Extract<Rec, { kind: "intent-phase" }> =>
    r.kind === "intent-phase" && r.phase === "call-started");
  {
    const idsPerCall = new Map<string, Set<string>>();
    for (const r of allStarts) {
      let s = idsPerCall.get(r.callId);
      if (!s) { s = new Set(); idsPerCall.set(r.callId, s); }
      s.add(r.id);
    }
    for (const [, s] of idsPerCall)
      if (s.size > 1)
        throw new Error("refused: multiple call-started record ids for one callId (record-once violated)");
  }
  const intent0 = intents[0];
  if (!intent0) throw new Error("refused: no dispatch-intent for dispatchId");
  const { taskId, taskAttemptNumber } = intent0;
  const owning = prefix.some(r => r.kind === "attempt" && r.taskId === taskId && r.attemptNumber === taskAttemptNumber);
  if (!owning) throw new Error("refused: dispatch-intent names no attempt record in prefix");
  // Session join (v36 cycles 10–11): fold the attempt IDENTITY's
  // observations (multiple intent/outcome records per attempt, fresh
  // record id each); the identity's established session is the set of
  // non-null sessionIds — exactly 1 value, agreeing with the claim.
  const claimed = prefix.filter((r): r is Extract<Rec, { kind: "attempt" }> =>
    r.kind === "attempt" && r.taskId === taskId && r.attemptNumber === taskAttemptNumber);
  const nonNull: string[] = [];
  for (const r of claimed) if (r.sessionId !== null && !nonNull.includes(r.sessionId)) nonNull.push(r.sessionId);
  if (nonNull.length !== 1)
    throw new Error("refused: session join failed — claimed attempt establishes 0 or conflicting sessions");
  if (nonNull[0] !== intent0.sessionId)
    throw new Error("refused: session join failed — intent sessionId differs from the attempt's established session (spoilage)");
  // No OTHER attempt identity — of ANY task — may establish the same
  // session (v36 cycle-13 major 2: episode-wide ownership check).
  for (const r of prefix) {
    if (r.kind === "attempt" && r.sessionId !== null && r.sessionId === intent0.sessionId &&
        !(r.taskId === taskId && r.attemptNumber === taskAttemptNumber))
      throw new Error("refused: session join failed — session also claimed by another attempt identity");
  }
  const attemptAtDispatch = taskAttemptNumber;

  let rootSettled = false;
  if (retryOf !== null) {
    const startedList = prefix.filter((r): r is Extract<Rec, { kind: "intent-phase" }> =>
      r.kind === "intent-phase" && r.phase === "call-started");
    // Full call-identity validation (v36 cycle-14 major 2): duplicate
    // call-started records are checked over the COMPLETE canonical
    // record and phase cardinality — not a selected field subset —
    // before the lineage walk reads any of them. >1 distinct ids for
    // one callId violates record-once; same id tolerates ONLY
    // byte-identical redelivery.
    const startedById = new Map<string, Map<string, string>>(); // callId -> (id -> canonical)
    for (const r of startedList) {
      let byId = startedById.get(r.callId);
      if (!byId) { byId = new Map(); startedById.set(r.callId, byId); }
      const canon = canonicalize(r);
      const prev = byId.get(r.id);
      if (prev !== undefined && prev !== canon)
        throw new Error("refused: same-id call-started with divergent bytes (history-integrity-fault)");
      byId.set(r.id, canon);
    }
    const started = new Map<string, IntentPhase>();
    for (const [, byId] of startedById) {
      if (byId.size > 1)
        throw new Error("refused: multiple call-started record ids for one callId (record-once violated)");
      const first = startedList.find(r => r.id === [...byId.keys()][0]);
      if (first) started.set(first.callId, first);
    }
    const visited = new Set<string>();
    let cur: string | null = retryOf;
    for (;;) {
      if (cur !== null && visited.has(cur)) throw new Error("refused: lineage cycle");
      if (cur !== null) visited.add(cur);
      if (cur === null) break;
      const st = started.get(cur);
      if (!st) throw new Error("refused: lineage ancestor missing from prefix");
      if (st.retryOfCallId === null) {
        // v36 cycle-27 minor 1: a settlement joins the root ONLY under the
        // FULL canonical identity (callId AND dispatchId AND attemptNumber
        // of the root's call-started — docs/11-orchestrator-schema.md
        // §14.13.4a canonical identity rule). A settlement carrying the
        // root's callId but a different dispatch/attempt is NOT a
        // settlement of this root: it is refused as identity-inconsistent
        // (never silently used, never silently dropped — an unjoined
        // settlement of a live callId is a malformed history).
        const roots = prefix.filter((r): r is Extract<Rec, { kind: "intent-phase" }> =>
          r.kind === "intent-phase" && r.phase === "call-settled" && r.callId === cur);
        for (const r of roots) {
          if (r.dispatchId !== st.dispatchId || r.attemptNumber !== st.attemptNumber)
            throw new Error("refused: settlement identity does not match root call-started (canonical identity violated)");
        }
        // record-once-per-phase: >1 settlement under DISTINCT ids is malformed;
        // an identical-id redelivery is tolerated ONLY if BYTE-IDENTICAL —
        // same id with divergent canonical bytes is a history-integrity
        // refusal, never a last-write-wins dedup (v36 cycle-8 major 2).
        const byId = new Map<string, string>();
        for (const r of roots) {
          // COMPLETE canonical record (v36 cycle-9 major 2): every field of
          // the closed shape participates, not a selected subset.
          const canon = canonicalize(r);
          const prev = byId.get(r.id);
          if (prev !== undefined && prev !== canon)
            throw new Error("refused: same-id settlement with divergent bytes (history-integrity-fault)");
          byId.set(r.id, canon);
        }
        if (byId.size > 1) throw new Error("refused: multiple settlement record ids (record-once violated)");
        const uniq = roots.filter((r, i) => roots.findIndex(x => x.id === r.id) === i);
        const outs = new Set(uniq.map(r => {
          const o = r.outcome;
          if (o === null || !(SETTLE_OUTCOMES as readonly string[]).includes(o))
            throw new Error("refused: settlement outcome absent or outside closed enum");
          return o;
        }));
        if (outs.size > 1) throw new Error("refused: inconsistent root settlements (history-integrity-fault)");
        // true iff the (single) outcome is proven-not-issued; false for
        // issued | no-call | superseded-attempt (all CLOSED outcomes defined).
        rootSettled = outs.has("proven-not-issued");
        break;
      }
      cur = st.retryOfCallId;
    }
  }
  return attemptAtDispatch >= 2 || rootSettled ? "recovery" : "initial";
}

// Session ids are namespaced by task (episode-wide uniqueness —
// v36 cycle-13 major 2 — makes cross-task session collision a refusal).
const att = (taskId: string, n: number, sessionId: string | null = `sess-${taskId}-${n}`): Rec =>
  ({ kind: "attempt", taskId, attemptNumber: n, sessionId });
const di = (dispatchId: string, taskId: string, n: number, sessionId = `sess-${taskId}-${n}`): Rec =>
  ({ kind: "dispatch-intent", dispatchId, taskId, taskAttemptNumber: n, sessionId });
let seq = 0;
const started = (callId: string, dispatchId = "d", retryOf: string | null = null): Rec =>
  ({ kind: "intent-phase", id: `s${seq++}`, ts: 1000, dispatchId, callId, attemptNumber: 1,
     phase: "call-started", idempotencyKey: `ik-${callId}`, retryOfCallId: retryOf,
     requestDigest: `rd-${callId}`, evidenceRef: null, outcome: null, recoveryClass: "initial" });
const settled = (callId: string, outcome: SettlementOutcome, dispatchId = "d", id?: string,
                 ts = 1000, evidenceRef: string | null = null): IntentPhase =>
  ({ kind: "intent-phase", id: id ?? `t${seq++}`, ts, dispatchId, callId, attemptNumber: 1,
     phase: "call-settled", idempotencyKey: null, retryOfCallId: null,
     requestDigest: null, evidenceRef, outcome, recoveryClass: null });

test("F3: attempt-1 torn-tail retry with UNSETTLED root mints initial (conservative)", () => {
  // Prefix is the durable state BEFORE the minted call's call-started append.
  const p = [att("t", 1), di("d", "t", 1), started("c1")];
  assert.equal(mintClass(p, "d", "c2", "c1"), "initial");
});

test("F3: attempt-1 retry whose root is ALREADY proven-not-issued at mint is recovery", () => {
  const p = [att("t", 1), di("d", "t", 1), started("c1"), settled("c1", "proven-not-issued")];
  assert.equal(mintClass(p, "d", "c2", "c1"), "recovery");
});

test("F3: dispatch on attempt >= 2 is recovery regardless of lineage", () => {
  const p = [att("t", 1), att("t", 2), di("d", "t", 2)];
  assert.equal(mintClass(p, "d", "c9", null), "recovery");
});

test("F3: an ordinary SECOND call within attempt 1 is initial (per-call counter is not attempt)", () => {
  const p = [att("t", 1), di("d", "t", 1), started("c1"), settled("c1", "issued")];
  assert.equal(mintClass(p, "d", "c2", null), "initial");
});

test("F3 multi-task: ANOTHER task's attempt 2 does not reclassify this task's attempt-1 dispatch", () => {
  const p = [att("t", 1), att("u", 1), att("u", 2), di("d", "t", 1)];
  assert.equal(mintClass(p, "d", "c1", null), "initial");
});

test("F3 wrong-dispatch: a different dispatch's attempt 2 does not affect this dispatch", () => {
  const p = [att("t", 1), att("t", 2), di("other", "t", 2), di("d", "t", 1)];
  assert.equal(mintClass(p, "d", "c1", null), "initial");
});

test("F3: missing dispatch-intent REFUSES the mint", () => {
  assert.throws(() => mintClass([att("t", 1)], "d", "c1", null), /no dispatch-intent/);
});

test("F3: dispatch-intent naming no attempt record REFUSES the mint", () => {
  assert.throws(() => mintClass([di("d", "t", 3)], "d", "c1", null), /names no attempt/);
});

test("F3: conflicting dispatch-intent attempt numbers REFUSE the mint", () => {
  const p = [att("t", 1), att("t", 2), di("d", "t", 1), di("d", "t", 2)];
  assert.throws(() => mintClass(p, "d", "c1", null), /conflicting/);
});

test("F3 missing-ancestor: a retry whose lineage ancestor is absent REFUSES the mint (not silently initial)", () => {
  const p = [att("t", 1), di("d", "t", 1)];
  assert.throws(() => mintClass(p, "d", "c2", "c-missing"), /ancestor missing/);
});

test("F3 cycle: a cyclic retry lineage in the PREFIX refuses a new retry (minted call not in prefix)", () => {
  const p = [att("t", 1), di("d", "t", 1), started("a", "d", "b"), started("b", "d", "a")];
  assert.throws(() => mintClass(p, "d", "c-new", "a"), /lineage cycle/);
});

test("F3: a settlement arriving AFTER mint does not re-class (mint prefix is the only input)", () => {
  const atMint = [att("t", 1), di("d", "t", 1), started("c1")];
  assert.equal(mintClass(atMint, "d", "c2", "c1"), "initial");
  // The stored value is never recomputed; the contract forbids re-deriving.
  // This assertion documents that a later prefix WOULD differ — the record
  // rule, not this function, prevents the re-derivation.
  const later = [...atMint, settled("c1", "proven-not-issued")];
  assert.equal(mintClass(later, "d", "c2", "c1"), "recovery");
});

test("F3 conflict: two call-started records for one callId with different lineage REFUSE the mint", () => {
  const p = [att("t", 1), di("d", "t", 1), started("c1"), started("c1", "d", "c0")];
  assert.throws(() => mintClass(p, "d", "c2", "c1"), /call-started/);
});

test("F3 divergent duplicate call-started in a NON-lineage field REFUSES the mint (v36 cycle-14 major 2)", () => {
  // Same callId, distinct record ids, disagreement in attemptNumber /
  // ts (fields the v36 cycle-13 model ignored — last-write-wins): the
  // full canonical record is validated before the lineage walk.
  const s1 = started("c1");
  const s2: IntentPhase = { ...(s1 as IntentPhase), id: `x${seq++}`, attemptNumber: 2 };
  const p = [att("t", 1), di("d", "t", 1), s1, s2];
  assert.throws(() => mintClass(p, "d", "c2", "c1"), /record-once violated/);
});

test("F3 byte-identical call-started redelivery is tolerated (v36 cycle-14 major 2)", () => {
  const s1 = started("c1");
  const p = [att("t", 1), di("d", "t", 1), s1, { ...s1 }];
  assert.equal(mintClass(p, "d", "c2", "c1"), "initial");
});

test("F3 cycle detection uses a visited set (durable self-loop refused)", () => {
  const p = [att("t", 1), di("d", "t", 1), started("a", "d", "a")];
  assert.throws(() => mintClass(p, "d", "c-new", "a"), /lineage cycle/);
});

// ---- root settlement outcomes (v36 cycle-4 major 1) ---------------------
for (const outcome of ["issued", "no-call", "superseded-attempt"] as const) {
  test(`F3 root settled ${outcome} is defined: false (initial unless attempt>=2)`, () => {
    const p = [att("t", 1), di("d", "t", 1), started("c1"), settled("c1", outcome)];
    assert.equal(mintClass(p, "d", "c2", "c1"), "initial");
  });
}

test("F3 root with TWO settlement RECORDS (distinct ids) REFUSES the mint — record-once fires first", () => {
  const p = [att("t", 1), di("d", "t", 1), started("c1"),
    settled("c1", "issued", "d", "tA"), settled("c1", "proven-not-issued", "d", "tB")];
  assert.throws(() => mintClass(p, "d", "c2", "c1"), /record-once|inconsistent/);
});

// ---- §14.13.3 reconciled-amount precedence (v36 cycles 3-6) -------------
// classSplit sums EXACTLY to acceptedUsd. Allocation (cycle-6 bounded
// residual fill, INITIAL-FIRST): R = max(0, accepted - (oi+or_));
// shortfall_c = max(0, split_c - observed_c);
// initialProj = oi + min(shortfall_i, R); recoveryProj = or_ + (R - that).
// Class sum == max(accepted, observedTotal) — NEVER more (cycle-6 blocker).
// All amounts finite safe integers; overflows refuse (cycle-6 minor 2).
function assertMicroUsd(n: unknown, name: string): number {
  if (typeof n !== "number" || !Number.isSafeInteger(n))
    throw new Error(`refused: ${name} must be a finite safe integer (micro-USD)`);
  return n;
}
function safeAdd(a: number, b: number, name: string): number {
  const r = a + b;
  if (!Number.isSafeInteger(r)) throw new Error(`refused: ${name} left the safe integer domain`);
  return r;
}
// v36 cycle-34 major 1: TRUE discriminated union — the quarantined
// variant exposes ONLY heldUsd; the projected variant exposes ONLY the
// class sums. No consumer can sum class fields off a quarantined result
// (they do not exist on that variant); an exhaustive discriminant check
// is required before any aggregation. projOf/heldOf fail closed.
type ProjResult =
  | { quarantined: false; initialProj: number; recoveryProj: number }
  | { quarantined: true; heldUsd: number };
function heldOf(r: ProjResult): number {
  if (r.quarantined) return r.heldUsd;
  throw new Error("refused: heldOf on a non-quarantined projection");
}
function projOf(r: ProjResult): { initialProj: number; recoveryProj: number } {
  if (!r.quarantined) return { initialProj: r.initialProj, recoveryProj: r.recoveryProj };
  throw new Error("refused: class sums do not exist on a quarantined dispatch");
}
function project(acceptedUsd: number, split: { initialUsd: number; recoveryUsd: number } | null,
                 observedInitial: number, observedRecovery: number): ProjResult {
  assertMicroUsd(acceptedUsd, "acceptedUsd");
  assertMicroUsd(observedInitial, "observedInitial");
  assertMicroUsd(observedRecovery, "observedRecovery");
  if (acceptedUsd < 0 || observedInitial < 0 || observedRecovery < 0)
    throw new Error("refused: negative amount");
  // v36 cycle-31 blocker 1 folded, then rule B2 (cycles 30–33, liveness
  // option chosen by the owner): with NO split the owner declared no
  // recovery intent (F4 whole-amount initial), while observed recovery
  // is measured evidence that may not be relabelled (O-G4-3) nor
  // charged twice against one accepted amount (cycle-6 blocker). The
  // three invariants cannot all hold -> the dispatch is QUARANTINED:
  // it contributes NOTHING to either class (no asserted split), and
  // its full RESOLVED TOTAL max(accepted, Σobs) is held as unknown
  // spend (O-G4-4) consuming all headroom until the exit: a
  // superseding reconciliation (chain tip named) carrying an explicit
  // {initialUsd, recoveryUsd} split. Other dispatches project normally.
  if (!split && observedRecovery > 0)
    return { quarantined: true,
      heldUsd: Math.max(acceptedUsd, safeAdd(observedInitial, observedRecovery, "observed total")) };
  let si = acceptedUsd, sr = 0;
  if (split) {
    assertMicroUsd(split.initialUsd, "initialUsd");
    assertMicroUsd(split.recoveryUsd, "recoveryUsd");
    if (split.initialUsd < 0 || split.recoveryUsd < 0) throw new Error("refused: negative split part");
    if (safeAdd(split.initialUsd, split.recoveryUsd, "split sum") !== acceptedUsd)
      throw new Error("refused: classSplit must sum exactly to acceptedUsd");
    si = split.initialUsd; sr = split.recoveryUsd;
  }
  const observedTotal = safeAdd(observedInitial, observedRecovery, "observed total");
  const R = Math.max(0, acceptedUsd - observedTotal);
  const shortI = Math.max(0, si - observedInitial);
  const fillI = Math.min(shortI, R);
  const initialProj = safeAdd(observedInitial, fillI, "initialProj");
  const recoveryProj = safeAdd(observedRecovery, R - fillI, "recoveryProj");
  return { quarantined: false, initialProj, recoveryProj };
}

test("F4 cycle-5 blocker: ALL-UNOBSERVED reconciliation charges both split parts (not 0)", () => {
  assert.deepEqual(project(10, { initialUsd: 6, recoveryUsd: 4 }, 0, 0),
    { quarantined: false, initialProj: 6, recoveryProj: 4 });
});

test("F4 observed initial 4 (split 6+4) projects the split exactly, not 10+0", () => {
  assert.deepEqual(project(10, { initialUsd: 6, recoveryUsd: 4 }, 4, 0),
    { quarantined: false, initialProj: 6, recoveryProj: 4 });
});

test("F4 cycle-6 blocker: observed recovery 5 (split 6+4) totals accepted, NEVER 11", () => {
  const r = project(10, { initialUsd: 6, recoveryUsd: 4 }, 0, 5);
  assert.deepEqual(r, { quarantined: false, initialProj: 5, recoveryProj: 5 });
  const p0 = projOf(r); assert.equal(p0.initialProj + p0.recoveryProj, 10);
});

test("F4 class sum equals max(accepted, observedTotal) in every case", () => {
  for (const [a, oi, or_] of [[10, 0, 0], [10, 4, 0], [10, 0, 5], [10, 3, 3], [10, 7, 9], [10, 10, 10]] as const) {
    const r = project(a, { initialUsd: 6, recoveryUsd: 4 }, oi, or_);
    const p = projOf(r); assert.equal(p.initialProj + p.recoveryProj, Math.max(a, oi + or_), `a=${a} oi=${oi} or=${or_}`);
  }
});

test("F4 observed never moves across classes: each projection >= its observed", () => {
  const r = project(10, { initialUsd: 6, recoveryUsd: 4 }, 0, 5);
  assert.ok(projOf(r).recoveryProj >= 5);
  const r2 = project(10, { initialUsd: 6, recoveryUsd: 4 }, 8, 0);
  assert.deepEqual(r2, { quarantined: false, initialProj: 8, recoveryProj: 2 }); // R=2 tops initial shortfall? fill=min(max(0,6-8),2)=0 -> recovery gets 2
});

test("F4 null split defaults entirely to initial", () => {
  assert.deepEqual(project(10, null, 3, 0), { quarantined: false, initialProj: 10, recoveryProj: 0 });
});

test("F4 rule B2 (cycles 30-33): null split + observed recovery QUARANTINES the dispatch (no class sums, O-G4-4 hold, owner-split exit)", () => {
  // F4 whole-amount initial + anti-relabel + one-cap-charge cannot all
  // hold when classSplit is null and observedRecovery > 0. The owner
  // chose LIVENESS (option B): the dispatch is quarantined per-dispatch
  // — it asserts NO class allocation, its full resolved total
  // max(accepted, Σobs) is held by O-G4-4 consuming all headroom, the
  // cycle's clean boundary is denied, episode is needs-owner — and the
  // ONLY exit is a superseding reconciliation carrying an explicit
  // {initialUsd, recoveryUsd} split. Worked case: accepted 10, null
  // split, observed recovery 5.
  const q = project(10, null, 0, 5);
  assert.equal(q.quarantined, true, "must quarantine, not allocate");
  // v36 cycle-34 major 1: the QUARANTINED VARIANT HAS NO CLASS FIELDS —
  // reading/summing them off q is a compile error; projOf fails closed at
  // runtime too (no silent 0-contribution into a class sum).
  // @ts-expect-error — quarantined variant exposes no initialProj (the defect c34 M1 found)
  void q.initialProj;
  // @ts-expect-error — quarantined variant exposes no recoveryProj
  void q.recoveryProj;
  assert.throws(() => projOf(q), /class sums do not exist/);
  assert.equal(heldOf(q), 10, "O-G4-4 holds the resolved total max(10, 5) = 10 (never 5 alone, never 15)");
  assert.throws(() => heldOf(project(10, null, 3, 0)), /heldOf on a non-quarantined/);
  // observed on both classes with null split: same predicate, hold covers Σobs
  const q2 = project(10, null, 2, 3);
  assert.equal(q2.quarantined, true);
  assert.equal(q2.heldUsd, 10);
  const q3 = project(10, null, 8, 5); // Σobs 13 > accepted
  assert.equal(q3.quarantined, true);
  assert.equal(q3.heldUsd, 13, "resolved total, never netted below the observations");
  // consistent null-split cases (zero observed recovery) are NOT quarantined
  assert.equal(project(10, null, 3, 0).quarantined, false);
  assert.deepEqual(project(10, null, 3, 0), { quarantined: false, initialProj: 10, recoveryProj: 0 });
  assert.deepEqual(project(10, null, 0, 0), { quarantined: false, initialProj: 10, recoveryProj: 0 });
  // the EXIT: supersede with an explicit split -> normal allocation, no hold
  assert.deepEqual(project(10, { initialUsd: 6, recoveryUsd: 4 }, 0, 5),
    { quarantined: false, initialProj: 5, recoveryProj: 5 });
  // quarantine is per-dispatch, replay-stable: null split with zero
  // observed recovery never quarantines regardless of observed initial
  for (const [a, oi] of [[10, 0], [10, 3], [10, 7], [10, 10]] as const) {
    const r = project(a, null, oi, 0);
    assert.equal(r.quarantined, false, `a=${a} oi=${oi}`);
    assert.equal(r.initialProj + r.recoveryProj, Math.max(a, oi), `a=${a} oi=${oi}`);
  }
});

test("F4 rule B2 liveness: a quarantined dispatch does not refuse sibling dispatches", () => {
  // cycle projection = Σ non-quarantined initialProj + cycle component;
  // quarantined dispatches contribute nothing and hold exposure instead.
  const siblings = [
    project(10, null, 0, 5),                 // quarantined
    project(10, { initialUsd: 6, recoveryUsd: 4 }, 4, 0), // normal: 6+4
    project(8, null, 2, 0),                  // normal null-split default: 8+0
  ];
  const quarantined = siblings.filter((d) => d.quarantined);
  assert.equal(quarantined.length, 1, "exactly the inconsistent dispatch quarantines");
  const cycleInitial = siblings.filter((d) => !d.quarantined)
    .reduce((s, d) => safeAdd(s, d.initialProj, "cycle initial"), 0);
  const cycleRecovery = siblings.filter((d) => !d.quarantined)
    .reduce((s, d) => safeAdd(s, d.recoveryProj, "cycle recovery"), 0);
  const held = quarantined.reduce((s, d) => safeAdd(s, d.heldUsd, "held"), 0);
  assert.deepEqual({ cycleInitial, cycleRecovery, held }, { cycleInitial: 14, cycleRecovery: 4, held: 10 },
    "siblings project normally; exposure is held, not projected into a class");
});

// ---- v36 cycle-34 folds: exposure-ledger composition, precedence, ----
// ---- predicate gate, correction release (blockers 1-2, majors 2-4, minor 1) ----
test("c34-B2: exposure ledger — held floors sum over quarantined dispatches, disjoint from projected spend", () => {
  // One replayable cycle-level calculation: per dispatch EXACTLY ONE of
  // (i) resolved total (projected, cap-charged), (ii) held floor
  // (quarantined), (iii) unresolved-unknown exposure (unreconciled).
  // Positive control from the audit: two "all remaining headroom"
  // holds must sum their floors (10 + 13 = 23) — never 2x headroom,
  // never the headroom once.
  // v36 cycle-35 blocker 1 alignment: the CYCLE-CAP charge is
  // initialProj ONLY; recoveryProj rides the ring fence separately
  // (the worked control: initial 0 + recovery 3 charges the cap 0).
  const cap = 30;
  const siblings = [
    project(10, { initialUsd: 6, recoveryUsd: 4 }, 4, 0), // reconciled normal: 6 initial + 4 ring-fenced
    project(8, null, 2, 0),                               // reconciled null-split: 8 initial + 0
    project(0, { initialUsd: 0, recoveryUsd: 0 }, 0, 3),  // c35-B1 control: initial 0, recovery 3 (Σobs 3 > accepted 0)
    project(10, null, 0, 5),                              // quarantined floor 10
    project(10, null, 8, 5),                              // quarantined floor 13
  ];
  let cycleCap = 0, ringFence = 0, held = 0;
  for (const d of siblings) {
    if (d.quarantined) held = safeAdd(held, heldOf(d), "held");
    else { const p = projOf(d); cycleCap = safeAdd(cycleCap, p.initialProj, "cycle cap"); ringFence = safeAdd(ringFence, p.recoveryProj, "ring fence"); }
  }
  assert.equal(cycleCap, 14, "cycle-cap charge is initialProj ONLY (6 + 8 + 0) — ring-fenced recovery never rides the cap");
  assert.equal(ringFence, 7, "recoveryProj rides the recovery budget (4 + 0 + 3)");
  assert.equal(held, 23, "held floors SUM (10 + 13), never 2x headroom (32), never headroom-once (16)");
  // Admission: any standing quarantine => no defined admission value
  // (the unknown rule denies the next cycle) — the spent FLOOR is 18+23=41
  // which independently exceeds the cap here, but the DENIAL MECHANISM is
  // the unknown rule, not arithmetic: with held>0 admit() returns false
  // regardless of the estimate.
  const admit = (spentFloor: number, estimate: number, standingUnknown: boolean) =>
    !standingUnknown && spentFloor + estimate <= cap;
  assert.equal(admit(cycleCap + held, 5, true), false, "quarantine standing => admission denied whatever the arithmetic");
  assert.equal(admit(24, 5, false), true, "control: clean spend admits within cap");
});

test("c34-M2/c35-M1: predicate gate — unreconciled dispatches NEVER quarantine (measured project, unmeasured are unknown spend)", () => {
  // project() is only reached by reconciled dispatches and
  // unreconciled-MEASURED ones (acceptedUsd is a reconciliation field,
  // so the reconciled arm enters through it; measured arms enter through
  // the observed sums). The gate lives in the PREDICATE: no reconciliation
  // record -> quarantined(d) is FALSE by definition, whichever evidence
  // arm the dispatch is in (v36 cycle-35 major 1: missing owner
  // reconciliation is NOT unknown spend — complete call-ledger usage
  // projects observed class sums; only missing/unrecoverable usage is
  // the 14.13.2 unknown). Model: reconciliation presence and usage
  // completeness are explicit inputs to the gating function.
  const quarantineGate = (reconciled: boolean, split: { initialUsd: number; recoveryUsd: number } | null,
                          observedRecovery: number) =>
    reconciled && split === null && observedRecovery > 0;
  assert.equal(quarantineGate(false, null, 5), false, "unreconciled + observed recovery: NEVER quarantined");
  // v36 cycle-36 major 1: usage completeness is NOT a free input — it is
  // a deterministic predicate over the dispatch's call records (the
  // doc's usageComplete): every call-started reached a terminal
  // settlement AND every settled-issued call has a usage record AND no
  // observed-but-unledgered request remains.
  // PARTIAL IS WHOLLY: any failure makes the WHOLE dispatch unknown —
  // the measured fragment is never projected alongside.
  // v36 cycle-37 major 1: superseded-attempt settlements are terminal
  // (no separate charge) but count ONLY when the lineage is complete —
  // derived from the modeled RECORDS, never a summary flag (v36
  // cycle-38 major 1: a claimed-but-absent winner, a winner without
  // usage, or an open coverage fold must fail; lineage state is
  // computed from the call set + a per-lineage coverage record).
  // v36 cycle-37 major 2: NO VACUOUS PASS — zero call records fail
  // closed unless the dispatch carries a zero-call-closure attestation
  // (disjunction form, v36 cycle-38 minor 1).
  // v36 cycle-37 major 3: condition (c) is an explicit input — the
  // unresolved observed-but-unledgered request set.
  type CallRec = {
    settled: "issued" | "no-call" | "proven-not-issued" | "superseded-attempt" | null;
    usage: number | null;
    lineage?: string;          // retry lineage key
  };
  type Lineage = { key: string; coverageClosed: boolean }; // durable coverage-fold record
  const usageComplete = (calls: CallRec[], opts: { zeroCallClosure?: boolean; unresolvedUnledgered?: number; lineages?: Lineage[] }) => {
    if ((opts.unresolvedUnledgered ?? 0) > 0) return false; // (c) fail closed, both disjuncts
    if (calls.length === 0) return opts.zeroCallClosure === true; // (v37-M2/v38-m1) disjunction
    if (!calls.every((c) => c.settled !== null)) return false;
    // v36 cycle-43 major 1: WINNER MODEL — evaluated for EVERY lineage
    // key present in the call set (chronological member array), not
    // only when a superseded attempt appears (the c43 fold's own
    // defect: two closing no-call attestations with no superseded
    // sibling must still be caught as ambiguous).
    const lineageKeys = [...new Set(calls.map((c) => c.lineage).filter((k): k is string => k !== undefined))];
    for (const key of lineageKeys) {
      const members = calls.filter((x) => x.lineage === key);
      const L = opts.lineages?.find((l) => l.key === key);
      if (!L || !L.coverageClosed) return false; // named, closed coverage fold (v38-M1)
      const issued = members.filter((x) => x.settled === "issued");
      if (issued.length > 1) return false; // double charge
      const negIdx = members.map((x, i) => [x, i] as const)
        .filter(([x]) => x.settled === "no-call" || x.settled === "proven-not-issued");
      const winner = issued.length === 1
        ? issued[0]!
        : (negIdx.length === 0 ? null : members[negIdx[negIdx.length - 1]![1]]!);
      if (!winner) return false; // no candidate closure
      for (const m of members) {
        if (m === winner) continue;
        if (m.settled === "superseded-attempt") continue; // legal at any position
        if (m.settled === "proven-not-issued") continue;   // antecedent, charge 0 — legal before OR after the winner (chain shape)
        return false; // non-winner `no-call`: a second CLOSING attestation is ambiguous
      }
      if (winner.settled === "issued" && winner.usage === null) return false;
    }
    for (const c of calls) {
      if (c.lineage === undefined && c.settled === "issued" && c.usage === null) {
        return false;
      }
    }
    return true;
  };
  const arm = (reconciled: boolean, calls: CallRec[], opts: { zeroCallClosure?: boolean; unresolvedUnledgered?: number; lineages?: Lineage[] } = {}) =>
    reconciled ? "reconciled" : usageComplete(calls, opts) ? "observed-class projection" : "unknown spend (14.13.2)";
  const complete = [{ settled: "issued" as const, usage: 3 }, { settled: "no-call" as const, usage: null }];
  const partial  = [{ settled: "issued" as const, usage: 3 }, { settled: "issued" as const, usage: null }];
  const openIntent = [{ settled: "issued" as const, usage: 3 }, { settled: null, usage: null }];
  assert.equal(arm(false, complete), "observed-class projection", "unreconciled + complete usage (issued+usage, no-call attests 0): projects, not unknown");
  assert.equal(arm(false, partial), "unknown spend (14.13.2)", "PARTIAL usage: wholly unknown, the measured 3 is never projected");
  assert.equal(arm(false, openIntent), "unknown spend (14.13.2)", "open intent phase: not complete");
  assert.equal(arm(false, []), "unknown spend (14.13.2)", "no calls + no closure attestation: fail closed, never measured-at-zero (v37-M2)");
  assert.equal(arm(false, [], { zeroCallClosure: true }), "observed-class projection", "zero-call-closure attestation: measured at 0 (the ONLY call-free path, v37-M2)");
  // v37-M1 / v38-M1 retry lineage: winner issued+usage, loser superseded-attempt.
  const L1 = [{ key: "L1", coverageClosed: true }];
  const lineage = [
    { settled: "issued" as const, usage: 4, lineage: "L1" },
    { settled: "superseded-attempt" as const, usage: null, lineage: "L1" },
  ];
  assert.equal(arm(false, lineage, { lineages: L1 }), "observed-class projection", "settled retry lineage: superseded attempt is terminal, folds once (v37-M1)");
  assert.equal(arm(false, lineage.slice(1), { lineages: L1 }), "unknown spend (14.13.2)", "claimed lineage whose WINNER IS ABSENT from the records: unknown (v38-M1)");
  const noUsage = [
    { settled: "issued" as const, usage: null, lineage: "L1" },
    { settled: "superseded-attempt" as const, usage: null, lineage: "L1" },
  ];
  assert.equal(arm(false, noUsage, { lineages: L1 }), "unknown spend (14.13.2)", "winner WITHOUT usage evidence: unknown (v38-M1)");
  assert.equal(arm(false, lineage, { lineages: [{ key: "L1", coverageClosed: false }] }), "unknown spend (14.13.2)", "coverage fold OPEN: unknown (v38-M1)");
  assert.equal(arm(false, lineage, {}), "unknown spend (14.13.2)", "no named lineage record at all: unknown (v38-M1)");
  const doubleCharged = [
    { settled: "issued" as const, usage: 4, lineage: "L1" },
    { settled: "issued" as const, usage: 5, lineage: "L1" },
    { settled: "superseded-attempt" as const, usage: null, lineage: "L1" },
  ];
  assert.equal(arm(false, doubleCharged, { lineages: L1 }), "unknown spend (14.13.2)", "double-charged lineage (two settled attempts): unknown in full (v37-M1 negative control)");
  // v38(c39)-M2: a settled winner of no-call / proven-not-issued is
  // complete with zero usage (the negative attestations ARE evidence).
  const noCallWinner = [
    { settled: "no-call" as const, usage: null, lineage: "L1" },
    { settled: "superseded-attempt" as const, usage: null, lineage: "L1" },
  ];
  assert.equal(arm(false, noCallWinner, { lineages: L1 }), "observed-class projection", "no-call winner + superseded sibling: complete, usage 0 (v39-M2)");
  const provenWinner = [
    { settled: "proven-not-issued" as const, usage: null, lineage: "L1" },
    { settled: "superseded-attempt" as const, usage: null, lineage: "L1" },
  ];
  assert.equal(arm(false, provenWinner, { lineages: L1 }), "observed-class projection", "proven-not-issued winner: complete, usage 0 (v39-M2)");
  // v36 cycle-43 major 1: WINNER MODEL — the full retry lifecycle from a
  // proven-not-issued root through a recovery retry that settles issued.
  // Chronological member array = the lifecycle as settled (c1 pni first).
  const lifecycle = [
    { settled: "proven-not-issued" as const, usage: null, lineage: "L1" }, // c1: antecedent, outcome NEVER rewritten
    { settled: "issued" as const, usage: 7, lineage: "L1" },               // c2: recovery retry, winner
  ];
  assert.equal(arm(false, lifecycle, { lineages: L1 }), "observed-class projection",
    "c43-M1 lifecycle: pni root + issued recovery retry closes with c2 as winner, usage once (7)");
  const chainRetry = [
    { settled: "proven-not-issued" as const, usage: null, lineage: "L1" }, // c1 licenses c2
    { settled: "proven-not-issued" as const, usage: null, lineage: "L1" }, // c2 licenses c3
    { settled: "no-call" as const, usage: null, lineage: "L1" },           // c3 closes the lineage
  ];
  assert.equal(arm(false, chainRetry, { lineages: L1 }), "observed-class projection",
    "c43-M1 chain: multiple pni antecedents + final closing attestation: legal (usage 0, one closure)");
  const twoClosers = [
    { settled: "no-call" as const, usage: null, lineage: "L1" },
    { settled: "no-call" as const, usage: null, lineage: "L1" },
  ];
  assert.equal(arm(false, twoClosers, { lineages: L1 }), "unknown spend (14.13.2)",
    "c43-M1 negative: two closing no-call attestations: ambiguous, unknown");
  const pniAfterWinner = [
    { settled: "issued" as const, usage: 7, lineage: "L1" },               // winner
    { settled: "proven-not-issued" as const, usage: null, lineage: "L1" }, // sibling proven never-issued: charge 0, legal
  ];
  assert.equal(arm(false, pniAfterWinner, { lineages: L1 }), "observed-class projection",
    "c43-M1: pni sibling AFTER the winner: charge-0, never rewritten: legal");
  // v37-M3 condition (c): otherwise-complete calls + an unresolved
  // observed-but-unledgered request => wholly unknown.
  assert.equal(arm(false, complete, { unresolvedUnledgered: 1 }), "unknown spend (14.13.2)", "complete calls but unresolved unledgered request: (c) fails closed (v37-M3)");
  assert.equal(arm(false, [], { zeroCallClosure: true, unresolvedUnledgered: 1 }), "unknown spend (14.13.2)", "(c) applies to the closure disjunct too (v38-m1)");
  assert.equal(quarantineGate(true, null, 5), true, "reconciled + null split + observed recovery: quarantined");
  assert.equal(quarantineGate(true, { initialUsd: 6, recoveryUsd: 4 }, 5), false, "explicit split: normal allocation");
  assert.equal(quarantineGate(true, null, 0), false, "zero observed recovery: consistent null split");
});

test("c34-B1: verdict precedence — a standing quarantine is needs-owner, budget-exhausted outranks it", () => {
  // The §14.12.3 precedence with the new needs-owner clause:
  // budget-exhausted > needs-owner > converged.
  // v36 cycle-35 major 3: next-cycle necessity and admission are
  // DERIVED from the same boundary state — never free inputs.
  // v36 cycle-36 major 2: necessity follows the NORMATIVE TABLE exactly
  // — the exhausted row counts ANY needs-owner condition as making a
  // next cycle REQUIRED (its parenthetical is "(the predicate FAILS —
  // streak short — OR any needs-owner condition)"), and a standing
  // quarantine denies admission — so a standing quarantine is ALWAYS
  // budget-exhausted, streak satisfied or not (the prior fixture's
  // streak-satisfied vector still produced the needs-owner verdict,
  // the second-verdict-for-one-state defect). One state -> one verdict.
  // The model separates needs-owner conditions that REFUSE admission
  // (quarantine, unknown spend/elapsed — the 14.13.2 mechanism) from a
  // plain owner question awaiting decision (required + admissible ->
  // needs-owner at the verdict line).
  type Boundary = { streakOk: boolean; quarantineStanding: boolean; unknownElapsed: boolean; ownerQuestionPending: boolean };
  const needsOwnerCond = (b: Boundary) => b.quarantineStanding || b.unknownElapsed || b.ownerQuestionPending;
  const needsNextCycle = (b: Boundary) => !b.streakOk || needsOwnerCond(b);
  const admissionRefused = (b: Boundary) => b.quarantineStanding || b.unknownElapsed;
  const verdict = (b: Boundary) => {
    if (needsNextCycle(b) && admissionRefused(b)) return "budget-exhausted";
    if (needsOwnerCond(b)) return "needs-owner";
    if (b.streakOk) return "converged";
    return "continue";
  };
  const Q = { quarantineStanding: true, unknownElapsed: false, ownerQuestionPending: false };
  const O = { quarantineStanding: false, unknownElapsed: false, ownerQuestionPending: true };
  const CLEAN = { quarantineStanding: false, unknownElapsed: false, ownerQuestionPending: false };
  const U = { quarantineStanding: false, unknownElapsed: true, ownerQuestionPending: false };
  // Streak NOT yet satisfied + quarantine: next cycle required, admission
  // denied by the quarantine => budget-exhausted outranks (the exact
  // two-verdicts-for-one-boundary defect the audit found):
  assert.equal(verdict({ streakOk: false, ...Q }), "budget-exhausted");
  // Streak satisfied + quarantine standing: the quarantine is ITSELF a
  // needs-owner condition making the next cycle required, admission
  // denied => budget-exhausted too (terminal until the exit act lands;
  // the owner question rides the merged P13 exhaustion ask):
  assert.equal(verdict({ streakOk: true, ...Q }), "budget-exhausted",
    "a standing quarantine is NEVER converged and NEVER reads needs-owner at the verdict line");
  assert.equal(verdict({ streakOk: true, ...CLEAN }), "converged", "control");
  assert.equal(verdict({ streakOk: false, ...U }), "budget-exhausted",
    "control: the unknown-elapsed arm behaves identically");
  // A plain owner question (needs-owner WITHOUT admission refusal):
  // required next cycle, admissible -> needs-owner outranks converged:
  assert.equal(verdict({ streakOk: true, ...O }), "needs-owner",
    "clean streak with an outstanding owner decision is NOT converged");
  assert.equal(verdict({ streakOk: false, ...CLEAN }), "continue", "control: no needs-owner condition, streak short");
});

test("c34-m1: correction release — a valid usage correction to zero recovery releases the quarantine by replay", () => {
  // The predicate is replay-derived: corrected observations that drive
  // observedRecovery to 0 make quarantined(d) false WITHOUT an owner
  // act (the owner act remains the only path that moves money INTO
  // recovery). Model: the projection is recomputed over the corrected
  // observation set.
  const before = project(10, null, 3, 5);
  assert.equal(before.quarantined, true);
  assert.equal(heldOf(before), 10);
  // §14.13.4a correction fold lands: the recovery observation is
  // corrected away (provider evidence shows no recovery spend).
  const after = project(10, null, 3, 0);
  assert.equal(after.quarantined, false, "predicate false after correction: released by replay, no stored state to clear");
  assert.deepEqual(projOf(after), { initialProj: 10, recoveryProj: 0 }, "whole-amount initial default resumes");
});

test("F4 split parts not summing to acceptedUsd are refused at append", () => {
  assert.throws(() => project(10, { initialUsd: 6, recoveryUsd: 3 }, 0, 0), /sum exactly/);
  assert.throws(() => project(10, { initialUsd: -1, recoveryUsd: 11 }, 0, 0), /negative/);
});

test("F4 cycle-6 minor: non-integer / non-finite amounts are refused (micro-USD domain)", () => {
  assert.throws(() => project(10.5, null, 0, 0), /safe integer/);
  assert.throws(() => project(10, { initialUsd: 6.5, recoveryUsd: 3.5 }, 0, 0), /safe integer|sum exactly/);
  assert.throws(() => project(10, null, NaN, 0), /safe integer/);
  assert.throws(() => project(10, null, Infinity, 0), /safe integer/);
  assert.throws(() => project(Number.MAX_SAFE_INTEGER + 2, null, 0, 0), /safe integer/);
  assert.deepEqual(project(Number.MAX_SAFE_INTEGER, null, 0, 0),
    { quarantined: false, initialProj: Number.MAX_SAFE_INTEGER, recoveryProj: 0 });
});

test("F4 cycle-6 minor 2: overflow in a sum refuses (fail closed, no wrap)", () => {
  const M = Number.MAX_SAFE_INTEGER;
  // split sum overflow: two safe parts whose sum is unsafe
  assert.throws(() => project(M + 1, { initialUsd: M, recoveryUsd: 1 }, 0, 0), /safe integer|sum exactly/);
  // observed-total overflow through project (split supplied so the
  // cycle-31 rule-B refusal is not the first check reached)
  assert.throws(() => project(10, { initialUsd: 10, recoveryUsd: 0 }, M, 1), /safe integer/);
});

// ---- settlement shape + record-once (v36 cycle-6 majors 2 / minor 1) ----
test("F3 settlement with ABSENT outcome REFUSES the mint (never defaulted false)", () => {
  const bad: Rec = { kind: "intent-phase", id: "tX", phase: "call-settled",
    callId: "c1", dispatchId: "d", attemptNumber: 1, retryOfCallId: null } as Rec;
  const p = [att("t", 1), di("d", "t", 1), started("c1"), bad];
  assert.throws(() => mintClass(p, "d", "c2", "c1"), /closed enum/);
});

test("F3 settlement with MISMATCHED canonical identity (foreign dispatch/attempt) REFUSES", () => {
  // v36 cycle-27 minor 1: a settlement for the root's callId but a
  // DIFFERENT dispatch (a fabricated proven-not-issued from another
  // lineage) must never join the root's outcome — full canonical
  // identity (callId AND dispatchId AND attemptNumber) or refuse.
  const forged: Rec = { ...settled("c1", "proven-not-issued", "d"), dispatchId: "other-dispatch" };
  const p = [att("t", 1), di("d", "t", 1), started("c1"), att("u", 2), di("d2", "u", 1),
    { ...started("c9"), dispatchId: "other-dispatch" }, forged, started("c2", "d", "c1")];
  assert.throws(() => mintClass(p, "d", "c2", "c1"), /canonical identity/);
  // attemptNumber mismatch alone also refuses
  const forged2: Rec = { ...settled("c1", "proven-not-issued", "d"), attemptNumber: 9 };
  const p2 = [att("t", 1), di("d", "t", 1), started("c1"), forged2, started("c2", "d", "c1")];
  assert.throws(() => mintClass(p2, "d", "c2", "c1"), /canonical identity/);
  // control: matching identity still resolves (recovery)
  const p3 = [att("t", 1), di("d", "t", 1), started("c1"), settled("c1", "proven-not-issued", "d"),
    started("c2", "d", "c1")];
  assert.equal(mintClass(p3, "d", "c2", "c1"), "recovery");
});

test("F3 settlement under a SECOND record id REFUSES (record-once-per-phase)", () => {
  const p = [att("t", 1), di("d", "t", 1), started("c1"),
    settled("c1", "issued", "d", "tA"), settled("c1", "issued", "d", "tB")];
  assert.throws(() => mintClass(p, "d", "c2", "c1"), /record-once/);
});

test("F3 byte-identical redelivery of the SAME settlement id is idempotent (tolerated)", () => {
  const rec = settled("c1", "proven-not-issued", "d", "tA");
  const p = [att("t", 1), di("d", "t", 1), started("c1"), rec, rec];
  assert.equal(mintClass(p, "d", "c2", "c1"), "recovery");
});

test("F3 same-id settlement differing ONLY in ts/evidenceRef REFUSES too (v36 cycle-9 major 2)", () => {
  const a = settled("c1", "proven-not-issued", "d", "tA", 1000, null);
  const b = settled("c1", "proven-not-issued", "d", "tA", 1001, "ev-2"); // same outcome, other fields diverge
  const p1 = [att("t", 1), di("d", "t", 1), started("c1"), a, b];
  const p2 = [att("t", 1), di("d", "t", 1), started("c1"), b, a];
  assert.throws(() => mintClass(p1, "d", "c2", "c1"), /divergent bytes/);
  assert.throws(() => mintClass(p2, "d", "c2", "c1"), /divergent bytes/);
});

test("F3 same-id settlement diverging in ANY closed field REFUSES (v36 cycle-10 major 2 — every field)", () => {
  const base = settled("c1", "proven-not-issued", "d", "tA");
  const fields: Array<Partial<typeof base>> = [
    { ts: 999 }, { attemptNumber: 2 }, { idempotencyKey: "x" }, { retryOfCallId: "c0" },
    { requestDigest: "rd-x" }, { evidenceRef: "ev-x" }, { recoveryClass: "initial" },
    { dispatchId: "d2" }, { callId: "c9" }, { phase: "call-started" },
  ];
  for (const f of fields) {
    const diverged: typeof base = { ...base, ...f };
    const p = [att("t", 1), di("d", "t", 1), started("c1"), base, diverged];
    assert.throws(() => mintClass(p, "d", "c2", "c1"), /divergent bytes/,
      `field ${JSON.stringify(f)} must participate in byte identity`);
  }
});

test("F3 lifecycle-shaped join: multiple observations of one attempt are ONE owner (v36 cycle-11 major 1)", () => {
  // intent observation (session null), then outcome observation establishing sess-1.
  const a1i: Rec = { kind: "attempt", taskId: "t", attemptNumber: 1, sessionId: null };
  const a1o: Rec = { kind: "attempt", taskId: "t", attemptNumber: 1, sessionId: "sess-1" };
  const p = [a1i, a1o, di("d", "t", 1, "sess-1"), started("c1")];
  assert.equal(mintClass(p, "d", "c2", "c1"), "initial"); // valid: fold establishes one session
});

test("F3 conflicting observations (two session ids on one attempt identity) REFUSE the mint (v36 cycle-11)", () => {
  const a1a: Rec = { kind: "attempt", taskId: "t", attemptNumber: 1, sessionId: "sess-1" };
  const a1b: Rec = { kind: "attempt", taskId: "t", attemptNumber: 1, sessionId: "sess-2" };
  const p = [a1a, a1b, di("d", "t", 1, "sess-1"), started("c1")];
  assert.throws(() => mintClass(p, "d", "c2", "c1"), /session join/);
});

test("F3 all-null observations establish no session — join REFUSES (v36 cycle-11)", () => {
  const p = [att("t", 1, null), di("d", "t", 1, "sess-1"), started("c1")];
  assert.throws(() => mintClass(p, "d", "c2", "c1"), /session join/);
});

test("F3 dispatch-intent naming an attempt number whose SESSION belongs to another attempt REFUSES the mint (v36 cycle-10 major 1)", () => {
  // attempt 1 owns session sess-1; attempt 2 exists; a spoofed intent claims attempt 2 but names sess-1.
  const diSpoof: Rec = { kind: "dispatch-intent", dispatchId: "d", taskId: "t", taskAttemptNumber: 2, sessionId: "sess-t-1" };
  const p = [att("t", 1), att("t", 2), diSpoof, started("c1")];
  assert.throws(() => mintClass(p, "d", "c2", "c1"), /session join/);
});

test("F3 cross-attempt session uniqueness: claimed fold agrees but ANOTHER identity carries the same session — REFUSE (v36 cycle-12 major 2)", () => {
  // Both folds are internally consistent (each identity carries ONE session value),
  // but sess-1 is carried by TWO attempt identities: the claim (attempt 2, sess-1)
  // passes the claimed-identity check yet violates one-session-one-owner.
  const a1: Rec = { kind: "attempt", taskId: "t", attemptNumber: 1, sessionId: "sess-1" };
  const a2: Rec = { kind: "attempt", taskId: "t", attemptNumber: 2, sessionId: "sess-1" };
  const p = [a1, a2, di("d", "t", 2, "sess-1"), started("c1")];
  assert.throws(() => mintClass(p, "d", "c2", "c1"), /another attempt identity/);
});

test("F3 cross-TASK session collision REFUSES the mint (v36 cycle-13 major 2)", () => {
  // Another task's attempt-2 record wears task t's attempt-1 session;
  // its own fold is internally consistent, so only the episode-wide
  // uniqueness check catches it.
  const u2: Rec = { kind: "attempt", taskId: "u", attemptNumber: 2, sessionId: "sess-1" };
  const diU: Rec = { kind: "dispatch-intent", dispatchId: "d", taskId: "u", taskAttemptNumber: 2, sessionId: "sess-1" };
  const p = [att("t", 1, "sess-1"), u2, diU, started("c1")];
  assert.throws(() => mintClass(p, "d", "c2", "c1"), /another attempt identity/);
});

test("F3 duplicate dispatch-intents with the SAME full identity are idempotent (v36 cycle-13 major 3)", () => {
  const p = [att("t", 1), di("d", "t", 1), di("d", "t", 1), started("c1")];
  assert.equal(mintClass(p, "d", "c2", "c1"), "initial");
});

test("F3 duplicate dispatch-intents differing in ANY identity component REFUSE in BOTH orders (v36 cycle-13 major 3)", () => {
  const i1 = di("d", "t", 1, "sess-1");
  const i2: Rec = { kind: "dispatch-intent", dispatchId: "d", taskId: "u", taskAttemptNumber: 1, sessionId: "sess-1" }; // different task
  const i3: Rec = { kind: "dispatch-intent", dispatchId: "d", taskId: "t", taskAttemptNumber: 1, sessionId: "sess-9" }; // different session
  const i4: Rec = { kind: "dispatch-intent", dispatchId: "d", taskId: "t", taskAttemptNumber: 2, sessionId: "sess-1" }; // different number
  for (const other of [i2, i3, i4]) {
    assert.throws(() => mintClass([att("t", 1), att("u", 1, "sess-1"), att("t", 2, "sess-1"), i1, other, started("c1")], "d", "c2", "c1"), /conflicting dispatch-intent/,
      "differing full identity must refuse (order 1)");
    assert.throws(() => mintClass([att("t", 1), att("u", 1, "sess-1"), att("t", 2, "sess-1"), other, i1, started("c1")], "d", "c2", "c1"), /conflicting dispatch-intent/,
      "differing full identity must refuse (order 2)");
  }
});

test("F3 same-id settlement with divergent bytes REFUSES in BOTH arrival orders (v36 cycle-8 major 2)", () => {
  const a = settled("c1", "proven-not-issued", "d", "tA");
  const b = settled("c1", "issued", "d", "tA"); // same id + identities, different outcome bytes
  const p1 = [att("t", 1), di("d", "t", 1), started("c1"), a, b];
  const p2 = [att("t", 1), di("d", "t", 1), started("c1"), b, a];
  assert.throws(() => mintClass(p1, "d", "c2", "c1"), /divergent bytes/);
  assert.throws(() => mintClass(p2, "d", "c2", "c1"), /divergent bytes/);
});

// ---- Legacy replay classification (v36 cycles 12–14) --------------------
// Mirrors the §14.13.4a LEGACY RULE: one ordered, exhaustive truth table
// over a legacy call-started (no recoveryClass; intent may lack
// taskAttemptNumber/sessionId; history may predate the closed-outcome
// enum). Row order matters; exactly one row hits.
type LegRec =
  | { kind: "attempt"; taskId: string; attemptNumber: number }
  // legacy intent: taskAttemptNumber may be absent (v36 cycle-12 major 1)
  | { kind: "dispatch-intent"; dispatchId: string; taskId: string; taskAttemptNumber?: number }
  | { kind: "leg-start"; callId: string; dispatchId: string; retryOfCallId: string | null }
  // legacy settlement: outcome may be absent or outside the closed enum
  | { kind: "leg-settle"; callId: string; dispatchId: string; outcome?: string };

function legacyClass(prefix: LegRec[], dispatchId: string, callId: string): "initial" | "recovery" {
  const intents = prefix.filter((r): r is Extract<LegRec, { kind: "dispatch-intent" }> =>
    r.kind === "dispatch-intent" && r.dispatchId === dispatchId);
  if (intents.length === 0) throw new Error("legacy: no intent");
  const n = intents[0]?.taskAttemptNumber; // possibly undefined
  // Row 1: attempt >= 2 -> recovery, lineage NOT consulted.
  if (n !== undefined && n >= 2) return "recovery";
  const startOf = (cid: string) => prefix.find((r): r is Extract<LegRec, { kind: "leg-start" }> =>
    r.kind === "leg-start" && r.callId === cid);
  const root = startOf(callId);
  // Row 2: head of lineage (retryOf null/absent) -> initial.
  if (!root || root.retryOfCallId === null) return "initial";
  // Walk the chain; row 4 catches incomplete/ambiguous/cyclic.
  const visited = new Set<string>();
  let cur: string | null = callId;
  for (;;) {
    if (cur === null) return "initial"; // row 4: incomplete
    if (visited.has(cur)) return "initial"; // row 4: cyclic
    visited.add(cur);
    const st = startOf(cur);
    if (!st) return "initial"; // row 4: missing ancestor (incomplete)
    if (st.retryOfCallId === null) break; // st IS the root
    cur = st.retryOfCallId;
  }
  const settles = prefix.filter((r): r is Extract<LegRec, { kind: "leg-settle" }> =>
    r.kind === "leg-settle" && r.callId === cur);
  if (settles.length === 0) return "initial"; // row 3: root unsettled
  if (settles.length > 1) return "initial"; // row 4: ambiguous
  const o = settles[0]?.outcome;
  if (o === "proven-not-issued") return "recovery"; // row 3
  if (o !== undefined && (SETTLE_OUTCOMES as readonly string[]).includes(o)) return "initial"; // row 3
  // Row 3 (v36 cycle-14 major 1): settlement exists but outcome is
  // ABSENT or OUT-OF-ENUM -> conservative "initial", never an error.
  return "initial";
}

const ls = (callId: string, retryOf: string | null = null): LegRec =>
  ({ kind: "leg-start", callId, dispatchId: "d", retryOfCallId: retryOf });
const lsi = (dispatchId: string, taskId: string, n?: number): LegRec =>
  ({ kind: "dispatch-intent", dispatchId, taskId, ...(n !== undefined ? { taskAttemptNumber: n } : {}) });
const lsettle = (callId: string, outcome?: string): LegRec =>
  ({ kind: "leg-settle", callId, dispatchId: "d", ...(outcome !== undefined ? { outcome } : {}) });

test("legacy row 1: attempt >= 2 -> recovery, lineage NOT consulted (missing lineage stays recovery)", () => {
  assert.equal(legacyClass([lsi("d", "t", 2)], "d", "c1"), "recovery");
  assert.equal(legacyClass([lsi("d", "t", 2), ls("c1", "c-gone")], "d", "c1"), "recovery");
});

test("legacy rows 2–3: head -> initial; complete chain classifies by root settlement", () => {
  assert.equal(legacyClass([lsi("d", "t", 1), ls("c1")], "d", "c1"), "initial");
  assert.equal(legacyClass([lsi("d", "t"), ls("c2", "c1"), ls("c1"), lsettle("c1", "proven-not-issued")], "d", "c2"), "recovery");
  assert.equal(legacyClass([lsi("d", "t"), ls("c2", "c1"), ls("c1"), lsettle("c1", "issued")], "d", "c2"), "initial");
  assert.equal(legacyClass([lsi("d", "t"), ls("c2", "c1"), ls("c1")], "d", "c2"), "initial"); // root unsettled
});

test("legacy row 4: incomplete / cyclic chain -> initial (never rejects legacy history)", () => {
  assert.equal(legacyClass([lsi("d", "t", 1), ls("c2", "c1")], "d", "c2"), "initial"); // ancestor missing
  assert.equal(legacyClass([lsi("d", "t", 1), ls("a", "b"), ls("b", "a")], "d", "a"), "initial"); // cyclic
});

test("legacy row 3 (v36 cycle-14 major 1): root settlement with ABSENT or OUT-OF-ENUM outcome -> initial", () => {
  const absent = [lsi("d", "t", 1), ls("c2", "c1"), ls("c1"), lsettle("c1")];
  assert.equal(legacyClass(absent, "d", "c2"), "initial", "absent outcome -> conservative initial");
  const oob = [lsi("d", "t", 1), ls("c2", "c1"), ls("c1"), lsettle("c1", "pre-enum-value")];
  assert.equal(legacyClass(oob, "d", "c2"), "initial", "out-of-enum outcome -> conservative initial, never an error");
});

test("legacy row 4 (v36 cycle-14 major 1): AMBIGUOUS root (two settlements) -> initial, never a pick", () => {
  const p = [lsi("d", "t", 1), ls("c2", "c1"), ls("c1"), lsettle("c1", "proven-not-issued"), lsettle("c1", "issued")];
  assert.equal(legacyClass(p, "d", "c2"), "initial");
});
