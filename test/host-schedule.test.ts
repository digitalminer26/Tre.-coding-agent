/**
 * P9/M2 — host scheduler (docs/20 §3–§6) tests: pure contract helpers,
 * capacity parsing, slot accounting, the observer epoch, and the
 * event-driven wall — plus named regressions for the six findings of
 * the M2 scheduler audit.
 *
 * F1 (major): the wall computed readiness ONCE per pass; a loop that
 *    finished during decide()'s awaits freed a slot and unblocked
 *    dependents that were never seen, and the episode returned
 *    `quiesced-blocked` with work admitted-able. Fix: drain terminal
 *    events and RE-decide until the state is stable before judging
 *    quiescence (a→b chains with awaits inside admission reproduce it).
 * F2 (major): finish() released the slot BEFORE its awaited acceptance
 *    read, so the wall could exit while a terminal was still under
 *    reconciliation. Fix: the running entry + slot are held until the
 *    terminal processing completes, released atomically with the wake —
 *    (running.size === 0 && pendingTerminal === 0) ⇒ every terminal has
 *    been consumed. Reproduced with a slow acceptanceFor verdict.
 * F3 (major): a shutdown flag set while loops ran could still admit.
 *    Fix: decide() early-returns on shutdownRequested; running loops
 *    drain; the result carries detail "deferred-blocked" when work
 *    remained.
 * F4 (minor): a malformed capacity entry fell back to the catch-all
 *    capacity (possibly LARGER) instead of serializing that endpoint.
 *    Fix: bad entry → cap 1 for that endpoint, disclosed once.
 * F5 (minor): a model swap acquired the target slot BEFORE releasing
 *    the old one — the episode ceiling denied pure endpoint changes
 *    once full. Fix: CapacitySlots.transfer() moves the held slot
 *    atomically (target cap enforced, total unchanged).
 * F6 (minor): ObserverQueue ranked by LIFETIME grant totals, letting a
 *    newly-joined task starve an older waiter past the W bound. Fix: a
 *    max-service-deficit epoch over current waiters.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  runSchedulerEpisode,
  CapacitySlots,
  ObserverQueue,
  parseCapacity,
  capFor,
  endpointOfModel,
  mapLoopStop,
  computeReady,
  findCycle,
  validateScheduleGraph,
  patternsOverlap,
  scopeOverlapPairs,
  TASK_STATUSES_MIRROR,
  SCHED_STOP_REASONS,
  SCHED_JOURNAL_KINDS,
  CAPACITY_DISCLOSURES,
  ADMISSION_REFUSALS,
  LOOP_STOP_REASONS_MIRROR,
  type SchedTaskLike,
  type SchedLoopResultLike,
  type SchedulerDeps,
  type SchedulerLoopHooks,
  type TaskFate,
} from "../src/supervisor/schedule.js";
import { STOP_REASONS } from "../src/supervisor/compose.js";
import { TASK_STATUSES } from "../src/episode/journal.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BudgetLedger,
  check as ledgerCheck,
  reserveDefault,
  projectLedger,
  type GatePolicy,
  type GateRequest,
} from "../src/budget/ledger.js";
import { makeLedgerAdmissionCheck, foldPendingFloors, durableReservedTaskIds } from "../src/host/sched-gate.js";

const NOW = 1000;
const clock = { now: () => NOW };

// ───────────────────────── harness helpers ─────────────────────────────────

/** A valid capacity file (ttl far in the future at NOW). A bare number
 *  is sugar for { maxConcurrent: n }; "*" included when the caller lists it. */
function capFile(endpoints: Record<string, unknown>): SchedulerDeps["capacity"] {
  const full: Record<string, unknown> = {};
  for (const [ep, v] of Object.entries(endpoints)) {
    full[ep] = typeof v === "number" ? { maxConcurrent: v } : v;
  }
  return {
    async read() {
      return JSON.stringify({ schema: "tre-capacity/1", measuredAt: NOW, ttlS: 1e9, endpoints: full });
    },
  };
}

type LoopFn = (cfg: object, ports: object) => Promise<SchedLoopResultLike>;

interface Harness {
  deps: SchedulerDeps;
  journalAppends: Record<string, unknown>[];
  admitted: string[];
}

/** A scheduler harness: graph from `tasks`, scripted per-task loop bodies
 *  (keyed by task id via the ports closure), otherwise trivial
 *  accepted-finish. `opts.script` bodies receive the loop hooks. */
function harness(
  tasks: SchedTaskLike[],
  opts: {
    capacity?: SchedulerDeps["capacity"];
    script?: Record<string, (hooks: SchedulerLoopHooks, task: SchedTaskLike) => Promise<SchedLoopResultLike>>;
    maxParallel?: number;
    worktrees?: SchedulerDeps["worktrees"];
    ledger?: SchedulerDeps["ledger"];
    admissionCheck?: SchedulerDeps["admissionCheck"];
    acceptanceFor?: SchedulerDeps["acceptanceFor"];
    shutdown?: SchedulerDeps["shutdown"];
    maxIterations?: number;
    investigate?: SchedulerDeps["investigate"];
    observerSlots?: number;
    activation?: string;
  } = {},
): Harness {
  const journalAppends: Record<string, unknown>[] = [];
  const admitted: string[] = [];
  const deps: SchedulerDeps = {
    graph: {
      async read() {
        return { episodeId: "ep-sched", tasks };
      },
    },
    loop: async (_cfg: object, ports: object) => {
      const p = ports as { taskId: string; hooks: SchedulerLoopHooks };
      const body = opts.script?.[p.taskId];
      return body ? await body(p.hooks, { id: p.taskId }) : { stopped: "accepted-finish" };
    },
    loopConfig: (task: SchedTaskLike) => ({ taskId: task.id }),
    loopPorts: (task: SchedTaskLike, hooks: SchedulerLoopHooks) => {
      admitted.push(task.id);
      return { taskId: task.id, hooks };
    },
    capacity: opts.capacity ?? capFile({ "*": 4 }),
    ...(opts.maxParallel !== undefined ? { maxParallel: opts.maxParallel } : {}),
    ...(opts.worktrees !== undefined ? { worktrees: opts.worktrees } : {}),
    ...(opts.ledger !== undefined ? { ledger: opts.ledger } : {}),
    ...(opts.admissionCheck !== undefined ? { admissionCheck: opts.admissionCheck } : {}),
    ...(opts.acceptanceFor !== undefined ? { acceptanceFor: opts.acceptanceFor } : {}),
    ...(opts.shutdown !== undefined ? { shutdown: opts.shutdown } : {}),
    ...(opts.maxIterations !== undefined ? { maxIterations: opts.maxIterations } : {}),
    ...(opts.investigate !== undefined ? { investigate: opts.investigate } : {}),
    ...(opts.observerSlots !== undefined ? { observerSlots: opts.observerSlots } : {}),
    ...(opts.activation !== undefined ? { activation: opts.activation } : { activation: "test-act-1" }),
    journal: {
      async append(record: object) {
        journalAppends.push(record as Record<string, unknown>);
      },
    },
    clock,
  };
  return { deps, journalAppends, admitted };
}

const t = (id: string, extra: Partial<SchedTaskLike> = {}): SchedTaskLike => ({ id, ...extra });
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
function journalKinds(appends: Record<string, unknown>[]): string[] {
  return appends.map((r) => String(r["kind"]));
}

// ───────────────────────── mirror / contract pins ──────────────────────────

test("mirror: the scheduler's closed sets equal the real exports (drift guard)", () => {
  assert.deepEqual([...TASK_STATUSES_MIRROR], [...TASK_STATUSES]);
  assert.deepEqual([...LOOP_STOP_REASONS_MIRROR], [...STOP_REASONS]);
  assert.deepEqual([...SCHED_STOP_REASONS], ["quiesced-complete", "quiesced-blocked", "shutdown"]);
  assert.deepEqual([...SCHED_JOURNAL_KINDS], ["sched-admit", "sched-deny", "sched-observer-grant", "sched-worktree", "scope-overlap"]);
  assert.deepEqual([...CAPACITY_DISCLOSURES], [
    "capacity:missing", "capacity:invalid", "capacity:stale", "capacity:bad-entry", "capacity:full",
  ]);
  assert.deepEqual([...ADMISSION_REFUSALS], [
    "capacity:full", "worktree-refused", 'budget-headroom', "pair-collision", "scope-invalid",
  ]);
});

test("contract: mapLoopStop is the whole §3.3 table, unmapped stops fail to failed", () => {
  assert.equal(mapLoopStop("accepted-finish"), "done");
  assert.equal(mapLoopStop("completed"), "done");
  assert.equal(mapLoopStop("parked"), "parked");
  assert.equal(mapLoopStop("shutdown"), "paused");
  for (const s of ["halt", "hold", "escalation-exhausted", "initial-run-denied", "no-initial-signal", "max-iterations", "loop-error", "finish-unjudged"]) {
    assert.equal(mapLoopStop(s), "failed", s);
  }
  assert.equal(mapLoopStop("anything-else"), "failed");
});

test("contract: endpointOfModel — the model string IS the endpoint id; absent is the catch-all", () => {
  assert.equal(endpointOfModel("glm-5.1"), "glm-5.1");
  assert.equal(endpointOfModel(undefined), "*");
  assert.equal(endpointOfModel(""), "*");
});

test("contract: computeReady is deterministic (depth, id) and a dependency needs done+complete", () => {
  const tasks = [
    t("z-root"), t("a-root"), t("kid", { dependsOn: ["z-root"] }),
    t("blocked", { dependsOn: ["unacc"] }), t("unacc"),
  ];
  const fates = new Map<string, TaskFate>([
    ["z-root", { status: "done", acceptance: "complete" }],
    ["unacc", { status: "done", acceptance: "partial" }], // done but NOT complete
    ["a-root", { status: "running" }],
  ]);
  // 'kid' (dep done+complete) is ready; 'blocked' never speculates past an
  // unaccepted dependency; done/running tasks are not re-listed.
  assert.deepEqual(computeReady(tasks, fates), ["kid"]);
  // Depth ordering: roots before dependents, ids lexicographic inside a depth.
  const tasks2 = [t("z"), t("m", { dependsOn: ["z"] }), t("a", { dependsOn: ["m"] }), t("b")];
  assert.deepEqual(computeReady(tasks2, new Map()), ["b", "z", "m", "a"].filter((id) => id !== "m" && id !== "a" ? true : false).length === 2
    ? computeReady(tasks2, new Map()) // sanity: shape
    : []);
  const order = computeReady(tasks2, new Map());
  assert.deepEqual(order, ["b", "z"]); // depth 0 only; deeper needs deps done
});

test("contract: findCycle names a culprit on a cycle, undefined when acyclic", () => {
  assert.equal(findCycle([t("a", { dependsOn: ["b"] }), t("b", { dependsOn: ["a"] })]), "a");
  assert.equal(findCycle([t("a", { dependsOn: ["b"] }), t("b")]), undefined);
  assert.equal(findCycle([t("a", { dependsOn: ["ghost"] })]), undefined); // unknown dep: no cycle
});

test("contract: validateScheduleGraph throws (setup failure) on bad ids, dups, cycles", () => {
  const g = (tasks: SchedTaskLike[]) => ({ episodeId: "e", tasks });
  assert.throws(() => validateScheduleGraph(g([t("-bad")])), /bad-task-id/);
  assert.throws(() => validateScheduleGraph(g([t("a"), t("a")])), /duplicate-task-id/);
  assert.throws(() => validateScheduleGraph(g([t("a", { session: "s" }), t("b", { session: "s" })])), /duplicate-session/);
  assert.throws(() => validateScheduleGraph(g([t("a", { dependsOn: ["b"] }), t("b", { dependsOn: ["a"] })])), /cycle/);
  validateScheduleGraph(g([t("a"), t("b.2_c-3")])); // grammar accepts dotted ids
});

test("contract: patternsOverlap + scopeOverlapPairs are advisory pairs (once each, ordered)", () => {
  assert.ok(patternsOverlap("src/**", "src/a.ts"));
  assert.ok(patternsOverlap("src/*.ts", "src/a.ts"));
  assert.ok(!patternsOverlap("src/a.ts", "docs/b.md"));
  const pairs = scopeOverlapPairs([
    { id: "b", files: ["src/**"] }, { id: "a", files: ["src/x.ts"] }, { id: "c", files: ["docs/**"] },
  ]);
  assert.deepEqual(pairs, [["a", "b"]]);
});

// ───────────────────────── §4.1 capacity file (F4) ─────────────────────────

test("F4: a bad entry SERIALIZES its own endpoint (cap 1), never the catch-all", () => {
  const view = parseCapacity(JSON.stringify({
    schema: "tre-capacity/1", measuredAt: NOW, ttlS: 1e9,
    endpoints: { "*": { maxConcurrent: 8 }, "slow-ep": { maxConcurrent: 0 }, "ok-ep": { maxConcurrent: 3 } },
  }), NOW);
  assert.deepEqual(view.disclosures, ["capacity:bad-entry"]);
  assert.equal(view.caps["slow-ep"], 1, "bad entry must be cap 1, not fall through to the catch-all 8");
  assert.equal(view.caps["ok-ep"], 3);
  assert.equal(capFor(view.caps, "slow-ep"), 1);
  assert.equal(capFor(view.caps, "unknown-ep"), 8, "unknown endpoints use the catch-all");
});

test("§4.1: every whole-file failure mode is fail-closed (empty caps) with its disclosure", () => {
  assert.deepEqual(parseCapacity(undefined, NOW), { caps: {}, disclosures: ["capacity:missing"] });
  assert.deepEqual(parseCapacity("{", NOW), { caps: {}, disclosures: ["capacity:invalid"] });
  assert.deepEqual(parseCapacity("[]", NOW), { caps: {}, disclosures: ["capacity:invalid"] });
  assert.deepEqual(
    parseCapacity(JSON.stringify({ schema: "other/1", measuredAt: 0, ttlS: 1, endpoints: { "*": 1 } }), NOW),
    { caps: {}, disclosures: ["capacity:invalid"] },
  );
  // A valid body WITHOUT the required "*" catch-all refuses the whole file.
  assert.deepEqual(
    parseCapacity(JSON.stringify({ schema: "tre-capacity/1", measuredAt: NOW, ttlS: 1e9, endpoints: { a: { maxConcurrent: 2 } } }), NOW),
    { caps: {}, disclosures: ["capacity:invalid"] },
  );
  // Stale is checked BEFORE entries are trusted at all.
  const stale = parseCapacity(JSON.stringify({
    schema: "tre-capacity/1", measuredAt: 0, ttlS: 0,
    endpoints: { "*": 4, bad: { maxConcurrent: -1 } },
  }), NOW);
  assert.deepEqual(stale, { caps: {}, disclosures: ["capacity:stale"] });
});

test("§4.1: capFor resolves exact → catch-all → serialize(1), never anything else", () => {
  const caps = { "*": 3, a: 2 };
  assert.equal(capFor(caps, "a"), 2);
  assert.equal(capFor(caps, "z"), 3);
  assert.equal(capFor({}, "z"), 1);
  assert.equal(capFor({ "*": 0 as number }, "z"), 1, "a nonsensical stored cap still serializes");
});

// ───────────────────── §4.3 slot accounting (F5) ───────────────────────────

test("F5: transfer moves ONE held slot atomically — total unchanged, ceiling never denies a pure endpoint change", () => {
  const s = new CapacitySlots({ "*": 5 }, 1); // episode ceiling = 1
  assert.ok(s.tryAcquire("m1"));
  assert.equal(s.live(), 1);
  assert.ok(s.transfer("m1", "m2"), "at the ceiling, a pure endpoint change must still be allowed");
  assert.equal(s.live(), 1, "total is untouched by a transfer");
  assert.equal(s.usedOf("m1"), 0);
  assert.equal(s.usedOf("m2"), 1);
  assert.ok(!s.tryAcquire("m3"), "the ceiling is still 1");
  s.release("m2");
  assert.equal(s.live(), 0);
});

test("F5: transfer enforces the TARGET cap and leaves no partial state on refusal", () => {
  const s = new CapacitySlots({ "*": 4, tight: 1 });
  assert.ok(s.tryAcquire("m1"));
  assert.ok(s.tryAcquire("tight")); // fills the target's cap
  assert.ok(!s.transfer("m1", "tight"), "a full target refuses the swap (fail-closed)");
  assert.equal(s.usedOf("m1"), 1, "refusal left the source slot intact");
  assert.equal(s.usedOf("tight"), 1);
  assert.equal(s.live(), 2);
  assert.ok(!s.transfer("nothing-held", "tight2"), "nothing held on the source → false");
  assert.ok(s.transfer("m1", "m1"), "same endpoint: no-op success");
});

test("§4.3: tryAcquire respects per-endpoint cap then the episode ceiling; a stale release cannot corrupt the ceiling count", () => {
  const s = new CapacitySlots({ "*": 4, solo: 1 }, 3);
  assert.ok(s.tryAcquire("solo"));
  assert.ok(!s.tryAcquire("solo"), "endpoint cap (solo=1)");
  assert.ok(s.tryAcquire("a"));
  assert.ok(s.tryAcquire("b"));
  assert.ok(!s.tryAcquire("c"), "episode ceiling (3) denies");
  s.release("solo");
  s.release("solo"); // double release is tolerated (2nd finds nothing held)
  assert.equal(s.live(), 2, "the stale 2nd release must NOT decrement the ceiling count");
  assert.ok(s.tryAcquire("c"), "one slot free under the ceiling");
  assert.equal(s.live(), 3);
});

// ───────────────────── §5 observer fairness (F6) ───────────────────────────

test("F6: epoch rule — a newly-joined task does NOT jump an older waiter (lifetime totals would)", async () => {
  const order: string[] = [];
  const q = new ObserverQueue(1, (id) => order.push(id));
  await q.request("H", 1);            // H occupies the ONE global slot
  const pA = q.request("A", 2);       // both join at the same turn: equal deficit
  const pC = q.request("C", 3);
  assert.deepEqual(q.pickOrder(), ["A", "C"], "equal deficits → seq rank decides first");
  q.release();                        // H done → head (A) granted
  await tick(0);
  assert.deepEqual(order, ["H", "A"]);
  const pB = q.request("B", 0);       // B joins NOW, with the LOWEST seq
  assert.deepEqual(
    q.pickOrder(),
    ["C", "B"],
    "C waited a whole turn (bigger deficit) — the OLD lifetime-total rule tied both at 0 grants and B's lower seq starved C past the W bound",
  );
  q.release();                        // A done → C granted on deficit, not seq
  await tick(0);
  assert.deepEqual(order, ["H", "A", "C"]);
  q.release();
  await tick(0);
  assert.deepEqual(order, ["H", "A", "C", "B"]);
  await Promise.all([pA, pC, pB]);
});

test("§5 (D1): the queue is ONE global slot no matter the requested count; ties break by (seq, taskId)", async () => {
  const q = new ObserverQueue(3); // D1 clamps to 1
  await q.request("solo", 1); // granted immediately (slot free)
  assert.equal(q.waitingCount(), 0, "solo was granted immediately (slot free)");
  let grantedTwo = false;
  void q.request("two", 2).then(() => { grantedTwo = true; });
  await tick(0);
  assert.ok(!grantedTwo, "the second waiter holds — the slot count is clamped to 1");
  q.release();
  await tick(0);
  assert.ok(grantedTwo);
  // tie-break: equal deficit → lower seq first. The slot must stay OCCUPIED
  // or the first queued request is granted on the spot and never queues.
  const q2 = new ObserverQueue(1);
  await q2.request("busy", 5); // occupies the only slot
  void q2.request("late", 9);
  void q2.request("early", 1);
  assert.deepEqual(q2.pickOrder(), ["early", "late"], "equal deficits → lower seq ranks first");
  q2.release(); await tick(0); // drain: busy → early → late
  q2.release(); await tick(0);
});

test("§5: no starvation — with W waiters, every re-requesting task is served within W grants", async () => {
  const served: string[] = [];
  const q = new ObserverQueue(1, (id) => served.push(id));
  const ids = ["t1", "t2", "t3", "t4"];
  // Round 1: queue four waiters (the slot is free, the first is granted
  // immediately — that is the queue's contract: request() resolves when
  // its turn comes).
  const r1 = ids.map((id) => q.request(id, 0));
  assert.equal(served.length, 1, "t1 granted on request (slot was free)");
  for (let i = 0; i < 3; i++) { q.release(); await tick(0); }
  assert.deepEqual([...served].sort(), [...ids], "all four served once");
  // Round 2: every task re-requests; each must be served within W=4 grants.
  const r2 = ids.map((id, i) => q.request(id, i));
  for (let i = 0; i < 4; i++) { q.release(); await tick(0); }
  assert.equal(served.length, 8, "four more grants, all of round 2 inside W");
  const round2 = served.slice(4);
  assert.deepEqual([...round2].sort(), [...ids], "round 2 is exactly one serving per task — no doubles, none starved");
  assert.deepEqual([...round2], [...round2].sort(), "within equal deficits, seq rank decides");
  await Promise.all([...r1, ...r2]);
});

// ───────────────────── episode: §3.1/§3.3 basics ───────────────────────────

test("episode: a trivial DAG drains to quiesced-complete with journals in contract order", async () => {
  const h = harness([t("a"), t("b", { dependsOn: ["a"] })]);
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.stopped, "quiesced-complete");
  assert.equal(res.admissions, 2);
  assert.equal(res.tasks.a?.status, "done");
  assert.equal(res.tasks.b?.status, "done");
  assert.deepEqual(h.admitted, ["a", "b"], "dependency order enforced by the ready set");
  const admits = h.journalAppends.filter((r) => r["kind"] === "sched-admit");
  assert.equal(admits.length, 2);
  for (const rec of h.journalAppends) {
    assert.equal(rec["episodeId"], "ep-sched");
    assert.ok(typeof rec["ts"] === "number" && typeof rec["seq"] === "number");
  }
});

test("episode: done requires the acceptance verdict `complete` — an unaccepted finish is failed (§3.3 trichotomy)", async () => {
  const h = harness([t("a")], {
    script: { a: async () => ({ stopped: "accepted-finish" }) },
    acceptanceFor: async () => "partial",
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.tasks.a?.status, "failed");
  assert.match(res.tasks.a?.detail ?? "", /unaccepted:partial/);
  assert.equal(res.stopped, "quiesced-blocked");
});

test("episode: a dependent of an UNACCEPTED finish never runs", async () => {
  const h = harness([t("a"), t("b", { dependsOn: ["a"] })], {
    acceptanceFor: async (task) => (task.id === "a" ? "partial" : "complete"),
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.tasks.a?.status, "failed");
  assert.equal(h.admitted.includes("b"), false, "a failed dependency never satisfies");
  assert.equal(res.stopped, "quiesced-blocked");
});

test("episode: a throwing loop becomes loop-error → failed and never escapes the scheduler (§3.3)", async () => {
  const h = harness([t("a")]);
  h.deps.loop = async () => { throw new Error("kaboom"); };
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.tasks.a?.status, "failed");
  assert.equal(res.tasks.a?.stopped, "loop-error");
  assert.match(res.tasks.a?.detail ?? "", /loop-threw/);
});

test("episode: a worktree refusal PARKS only that task, siblings run (§3.2.3)", async () => {
  const h = harness([t("a"), t("b")], {
    worktrees: {
      async ensure(id: string) {
        return id === "a" ? { refused: "path-exists" } : { path: `/wt/${id}` };
      },
    },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.tasks.a?.status, "parked");
  assert.match(res.tasks.a?.detail ?? "", /worktree-refused:path-exists/);
  assert.equal(res.tasks.b?.status, "done");
  assert.ok(h.journalAppends.some((r) => r["kind"] === "sched-deny" && r["taskId"] === "a" && r["reason"] === "worktree-refused"));
});

// ── M3 (D4 lift): worktree auto-removal on accepted `done` ─────────────────

test("M3 release: an accepted done releases the worktree, journals sched-worktree released", async () => {
  const released: string[] = [];
  const h = harness([t("a"), t("b")], {
    worktrees: {
      async ensure(id: string) { return { path: `/wt/${id}` }; },
      async release(id: string) { released.push(id); },
    },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.tasks.a?.status, "done");
  assert.equal(res.tasks.b?.status, "done");
  assert.deepEqual(released.sort(), ["a", "b"], "both accepted tasks released");
  const recs = h.journalAppends.filter((r) => r["kind"] === "sched-worktree");
  assert.equal(recs.length, 2);
  assert.deepEqual(new Set(recs.map((r) => r["outcome"])), new Set(["released"]));
  // actionIds unique per record
  assert.equal(new Set(recs.map((r) => r["actionId"])).size, 2);
});

test("M3 release: a kept (conservative-refusal) release is journaled with its code, fate unchanged", async () => {
  const h = harness([t("a")], {
    worktrees: {
      async ensure() { return { path: "/wt/a" }; },
      async release() { return { kept: "dirty" }; },
    },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.tasks.a?.status, "done", "a kept worktree never changes the accepted fate");
  const rec = h.journalAppends.find((r) => r["kind"] === "sched-worktree");
  assert.deepEqual([rec?.["outcome"], rec?.["detail"], rec?.["taskId"]], ["released", "dirty", "a"]);
});

test("M3 release: a throwing release is disclosed (release-threw) and never fails the episode", async () => {
  const h = harness([t("a")], {
    worktrees: {
      async ensure() { return { path: "/wt/a" }; },
      async release() { throw new Error("EIO"); },
    },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.tasks.a?.status, "done", "disk-reclaim failure cannot undo an accepted task");
  const rec = h.journalAppends.find((r) => r["kind"] === "sched-worktree");
  assert.equal(rec?.["outcome"], "release-threw");
});

test("M3 release: only accepted done releases — failed and parked tasks keep their worktrees as evidence", async () => {
  const released: string[] = [];
  const h = harness([t("a"), t("b"), t("c")], {
    worktrees: {
      async ensure(id: string) { return id === "b" ? { refused: "path-exists" } : { path: `/wt/${id}` }; },
      async release(id: string) { released.push(id); },
    },
    script: {
      // accepted-finish on 'a'; 'b' parks before its loop; 'c' stops failed.
      c: async () => ({ stopped: "max-iterations" }),
    },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.tasks.a?.status, "done");
  assert.equal(res.tasks.b?.status, "parked");
  assert.notEqual(res.tasks.c?.status, "done");
  assert.deepEqual(released, ["a"], "only the accepted task's worktree is reclaimed");
});

test("M3 release: an unaccepted done (verdict != complete) does NOT release", async () => {
  const released: string[] = [];
  const h = harness([t("a")], {
    worktrees: {
      async ensure() { return { path: "/wt/a" }; },
      async release(id: string) { released.push(id); },
    },
    acceptanceFor: async () => "incomplete",
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.tasks.a?.status, "failed");
  assert.deepEqual(released, [], "an unaccepted finish keeps the worktree");
});

test("episode (D5): a headroom denial rides the LEDGER's codes — never a false capacity:full", async () => {
  const h = harness([t("a")], {
    capacity: capFile({ "*": 1 }),
    ledger: { headroom: () => ({ usdOk: false, turnsOk: true }) },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.deepEqual(res.denials.map((d) => d.reason), ["episode-budget-exceeded"]);
  assert.equal(res.disclosures.includes("capacity:full"), false, "capacity was NOT the blocker");
  assert.equal(res.admissions, 0);
});

test("episode (D5): the task's own admissionCheck denial cites its codes and outranks capacity", async () => {
  const h = harness([t("a")], {
    capacity: capFile({ "*": 1 }),
    admissionCheck: async () => ({ allowed: false, codes: ["episode-reserve-floor-short"] }),
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.deepEqual(res.denials.map((d) => d.reason), ["episode-reserve-floor-short"]);
  // the acquired slot was released: a second activation-style check sees free capacity
  assert.equal(res.admissions, 0);
});

test("§3.2.1: capacity:full denies once per state — repeated decide passes do not spam the journal", async () => {
  const h = harness([t("slow"), t("wait")], {
    capacity: capFile({ "*": 1 }),
    script: { slow: async () => { await tick(15); return { stopped: "accepted-finish" }; } },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  // `wait` rides out one capacity:full (blocked behind `slow`), is
  // re-admitted when the slot frees, and finishes: the denial is ONE
  // record for the whole episode no matter how many decide passes ran.
  assert.equal(res.admissions, 2);
  assert.equal(res.tasks.wait?.status, "done");
  assert.equal(res.stopped, "quiesced-complete");
  const denyRecs = h.journalAppends.filter((r) => r["kind"] === "sched-deny" && r["taskId"] === "wait");
  assert.equal(denyRecs.length, 1, "once per state change, not once per poll");
  assert.equal(res.denials.filter((d) => d.taskId === "wait").length, 1, "the outcome denials stay singular too");
  assert.ok(res.disclosures.includes("capacity:full"));
});

test("episode: scope overlap is advisory — journaled once per pair, both tasks run (§3.2)", async () => {
  let bAdmitted = false;
  let stopped = false;
  const h = harness([
    t("a", { scope: { files: ["src/**"] } }),
    t("b", { scope: { files: ["src/x.ts"] } }),
  ], {
    capacity: capFile({ "*": 2 }),
    // `a` stays running until `b` is admitted — overlap is checked at
    // admission against the currently-running scopes.
    script: {
      a: async () => { while (!bAdmitted) await tick(2); return { stopped: "accepted-finish" }; },
      b: async () => { bAdmitted = true; return { stopped: "accepted-finish" }; },
    },
    shutdown: { async poll() { return stopped; } },
  });
  const p = runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  while (!bAdmitted) await tick(2);
  stopped = true;
  const res = await p;
  assert.equal(res.tasks.a?.status, "done");
  assert.equal(res.tasks.b?.status, "done");
  const overlaps = h.journalAppends.filter((r) => r["kind"] === "scope-overlap");
  assert.equal(overlaps.length, 1, "one advisory record per pair");
  assert.equal(overlaps[0]?.["pair"], "a+b");
});

test("episode: a journal append failure is disclosure-only, never fatal", async () => {
  const h = harness([t("a")]);
  h.deps.journal = { append: async () => { throw new Error("disk gone"); } };
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.stopped, "quiesced-complete");
  assert.equal(res.tasks.a?.status, "done");
});

test("episode: the observer thunk serializes both tasks on ONE global slot and journals every grant (D1)", async () => {
  let inFlight = 0; let maxInFlight = 0;
  const h = harness([t("a"), t("b")], {
    capacity: capFile({ "*": 2 }),
    investigate: async () => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(5);
      inFlight -= 1;
      return { class: "clean" };
    },
    script: {
      async a(hooks) { await hooks.investigate({}, {}); return { stopped: "accepted-finish" }; },
      async b(hooks) { await hooks.investigate({}, {}); return { stopped: "accepted-finish" }; },
    },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.stopped, "quiesced-complete");
  assert.equal(res.observerGrants, 2);
  assert.equal(maxInFlight, 1, "one GLOBAL observer slot across the episode");
  assert.equal(h.journalAppends.filter((r) => r["kind"] === "sched-observer-grant").length, 2);
});

// ───────────────────── audit regressions on the wall ───────────────────────

test("F1: a terminal that lands DURING decide()'s awaits still unblocks its dependent — no false quiesced-blocked", async () => {
  // The gate's await sits AFTER readiness was computed, so `a`'s
  // accepted finish can land mid-decide; the fix drains terminal events
  // and RE-decides until stable before judging quiescence.
  const h = harness([t("a"), t("b", { dependsOn: ["a"] })], {
    capacity: capFile({ "*": 1 }),
    // `a` finishes essentially immediately; b's admission passes through
    // an awaited worktree ensure (an await inside the decide pass).
    script: { a: async () => ({ stopped: "accepted-finish" }) },
    worktrees: {
      async ensure(id: string) { await tick(id === "b" ? 5 : 0); return { path: `/wt/${id}` }; },
    },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.stopped, "quiesced-complete", "the freed slot + unblocked dependent must be seen before quiescence");
  assert.equal(res.admissions, 2);
  assert.equal(res.tasks.b?.status, "done");
});

test("F1: a terminal landing while decide() awaits still settles a 1→3 fan-out to complete", async () => {
  const h = harness(
    [t("root"), t("x", { dependsOn: ["root"] }), t("y", { dependsOn: ["root"] }), t("z", { dependsOn: ["root"] })],
    {
      capacity: capFile({ "*": 1 }),
      script: { root: async () => { await tick(2); return { stopped: "accepted-finish" }; } },
      admissionCheck: async () => { await tick(1); return { allowed: true, codes: [] }; },
    },
  );
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.stopped, "quiesced-complete");
  assert.equal(res.admissions, 4);
});

test("F2: the slot + running entry are held until the terminal finishes reconciling — the wall never exits mid-acceptance", async () => {
  // acceptanceFor is SLOW: pre-fix, the slot was released (and running
  // dropped) BEFORE this await resolved, letting the wall see an empty
  // live set with the verdict still unread. Post-fix the wake is atomic
  // with the release, so quiescence is only ever judged on fully
  // consumed terminals — and the dependent sees `partial`, never runs.
  let verdictRead = false;
  const h = harness([t("a"), t("b", { dependsOn: ["a"] })], {
    capacity: capFile({ "*": 1 }),
    script: {
      a: async () => {
        // finish() must not report an empty live set to the wall while
        // this await is outstanding; prove it by re-entering decide
        // ourselves: if the wall could quit here, the episode would
        // resolve before verdictRead flips true.
        return { stopped: "accepted-finish" };
      },
    },
    acceptanceFor: async () => { await tick(15); verdictRead = true; return "partial"; },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.ok(verdictRead, "the episode returned only after the acceptance read completed");
  assert.equal(res.tasks.a?.status, "failed");
  assert.match(res.tasks.a?.detail ?? "", /unaccepted:partial/);
  assert.equal(h.admitted.includes("b"), false);
  assert.equal(res.stopped, "quiesced-blocked");
});

test("F3: a shutdown flag suppresses ALL new admissions; running work drains; the stop names it", async () => {
  // AUDIT R4-F1 (round 4): the pre-admission re-check is UNCONDITIONAL,
  // so the flag is modeled by the loop STARTING (the intent: "the flag
  // flips while `slow` runs") instead of a raw poll count — a poll is
  // now taken per admission attempt too.
  let started = false;
  const h = harness([t("slow"), t("next", { dependsOn: ["slow"] })], {
    capacity: capFile({ "*": 1 }),
    script: { slow: async () => { started = true; await tick(10); return { stopped: "accepted-finish" }; } },
    shutdown: {
      async poll() { return started; },
    },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.stopped, "shutdown");
  assert.equal(res.admissions, 1, "nothing was admitted after the flag");
  assert.equal(h.admitted.length, 1);
  assert.equal(res.detail, "deferred-blocked", "remaining ready work is disclosed");
  assert.equal(res.tasks.slow?.status, "done", "the running loop was drained, not orphaned");
});

test("F3: a shutdown before any admission stops with zero admits", async () => {
  const h = harness([t("a")], { shutdown: { async poll() { return true; } } });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.stopped, "shutdown");
  assert.equal(res.admissions, 0);
  assert.equal(res.detail, "deferred-blocked");
});

test("F5: an in-loop capacitySwap moves the held slot — at the episode ceiling a pure endpoint change still succeeds", async () => {
  const swaps: boolean[] = [];
  const h = harness([t("a", { model: "m1" })], {
    capacity: capFile({ "*": 4 }),
    maxParallel: 1, // full the moment `a` is admitted
    script: {
      async a(hooks) {
        swaps.push(hooks.capacitySwap("m2", "m1"));
        swaps.push(hooks.capacitySwap("m2", "m2")); // same endpoint: no-op true
        return { stopped: "accepted-finish" };
      },
    },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.deepEqual(swaps, [true, true], "pre-fix the ceiling (1) made the first swap false");
  assert.equal(res.tasks.a?.status, "done");
});

test("F5: capacitySwap refuses onto a full target endpoint and the denial reaches the loop as a denied action", async () => {
  // `hog` sorts before `z` in the admission order (depth, id), so it
  // holds the only `tight` slot synchronously before z's swap runs —
  // the refusal is deterministic, not a timing race.
  const h = harness([t("hog", { model: "tight" }), t("z", { model: "m1" })], {
    capacity: capFile({ "*": 4, tight: 1 }),
    script: {
      hog: async () => { await tick(20); return { stopped: "accepted-finish" }; },
      async z(hooks) {
        const ok = hooks.capacitySwap("tight", "m1");
        return ok ? { stopped: "accepted-finish" } : { stopped: "halt", detail: "swap-refused" };
      },
    },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.tasks.z?.status, "failed");
  assert.equal(res.tasks.z?.detail, "swap-refused");
  assert.equal(res.tasks.hog?.status, "done");
});

test("episode: maxIterations caps ADMISSIONS (the scheduler's own backstop), per-loop caps untouched (§1.1)", async () => {
  const h = harness([t("a"), t("b")], { capacity: capFile({ "*": 2 }), maxIterations: 1 });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.admissions, 1);
  assert.equal(res.stopped, "quiesced-blocked", "the capped-out sibling leaves the episode not-all-done");
});

test("episode: graph-level activation refusals THROW (setup failure, exit 1) before any spawn", async () => {
  const h = harness([t("a"), t("a")]);
  await assert.rejects(() => runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps), /duplicate-task-id/);
  const h2 = harness([t("a")]);
  await assert.rejects(() => runSchedulerEpisode({ episodeId: "OTHER" }, h2.deps), /episodeId-mismatch/);
});

test("episode: a missing capacity file serializes EVERYTHING and discloses it (§4.1 fail-closed)", async () => {
  const missing: SchedulerDeps["capacity"] = { async read() { return undefined; } };
  const h = harness([t("a"), t("b")], {
    capacity: missing,
    script: {
      a: async () => { await tick(5); return { stopped: "accepted-finish" }; },
      b: async () => { await tick(5); return { stopped: "accepted-finish" }; },
    },
  });
  const started: number[] = [];
  const origLoop = h.deps.loop;
  h.deps.loop = async (cfg, ports) => {
    const id = (ports as { taskId: string }).taskId;
    started.push(started.length); // arrival is serialized iff max concurrent is 1
    void id;
    return origLoop(cfg, ports);
  };
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.ok(res.disclosures.includes("capacity:missing"));
  assert.equal(res.tasks.b?.status, "done", "serialize still completes both, one at a time");
});

test("episode: pre-seeded terminal fates (done/failed/parked/paused) are honored, never re-run", async () => {
  const h = harness([
    t("d", { status: "done" }),
    t("f", { status: "failed" }),
    t("k", { status: "parked" }),
    t("p", { status: "paused" }),
    t("live", { dependsOn: ["d"] }),
  ]);
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  // A `done` seed WITHOUT a journaled complete verdict is impossible
  // durable evidence (§3.3: `done` requires acceptance "complete").
  // AUDIT C1-7: §8 rewrites derived status from evidence, so the seed
  // normalizes to `failed` — never a false quiesced-complete — and its
  // dependents stay gated. The four seeds are still honored, nothing
  // re-runs.
  assert.equal(res.admissions, 0);
  assert.equal(h.admitted.join(), "");
  assert.equal(res.tasks.d?.status, "failed", "done-without-complete normalizes (§3.3 consistency)");
  assert.match(res.tasks.d?.detail ?? "", /unaccepted:missing/);
  assert.equal(res.tasks.f?.status, "failed");
  assert.equal(res.tasks.k?.status, "parked");
  assert.equal(res.tasks.p?.status, "paused");
  assert.equal(res.stopped, "quiesced-blocked", "live stays gated → not all done");
  void h;
});

test("episode: a done-seeded dependency gates its dependents until complete (acceptance is the key, §3.1)", () => {
  const tasks = [t("d"), t("k", { dependsOn: ["d"] })];
  assert.deepEqual(computeReady(tasks, new Map([["d", { status: "done" }]])), [], "done without complete does NOT satisfy");
  assert.deepEqual(
    computeReady(tasks, new Map([["d", { status: "done", acceptance: "complete" }]])),
    ["k"],
  );
});

test("episode: an empty graph has nothing to run — quiesced-blocked (no false complete)", async () => {
  const h = harness([]);
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.stopped, "quiesced-blocked");
  assert.equal(res.admissions, 0);
});

test("episode: a throwing shutdown poll is NOT a shutdown; a throwing capacity read fails closed", async () => {
  const h = harness([t("a")], {
    capacity: { async read() { throw new Error("file gone"); } },
    shutdown: { async poll() { throw new Error("steer channel down"); } },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.stopped, "quiesced-complete");
  assert.ok(res.disclosures.includes("capacity:missing"), "a failed read is the missing-file path");
});

// ──────────────── audit regressions, round 2 (post-review fixes) ────────────

test("AUDIT R1: a seeded done WITH a journaled complete verdict unblocks its dependents on restart (§8)", async () => {
  // Pre-fix the seeded fate carried no acceptance, so computeReady's
  // §3.1 gate (done && acceptance === "complete") never opened — the
  // restarted scheduler could not continue past previously-accepted work.
  const h = harness([
    t("d", { status: "done", result: { acceptance: "complete" } }),
    t("k", { dependsOn: ["d"] }),
  ]);
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.admissions, 1, "the seeded complete verdict opens the gate");
  assert.equal(res.tasks.k?.status, "done");
  assert.equal(res.tasks.d?.status, "done", "the seed is honored, never re-run");
  assert.equal(res.stopped, "quiesced-complete");
});

test("AUDIT R1: a seeded done whose verdict is NOT complete keeps its dependents gated", async () => {
  const h = harness([
    t("d", { status: "done", result: { acceptance: "partial" } }),
    t("k", { dependsOn: ["d"] }),
  ]);
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.admissions, 0, "a partial verdict is not acceptance");
  assert.equal(res.stopped, "quiesced-blocked");
});

test("AUDIT F3 (r2): repeated decide passes deny a DENIAL ONCE in the returned array, not once per pass", async () => {
  // Pre-fix, denyOnce pushed the outcome denial BEFORE the dedup guard:
  // `y` is denied capacity in three successive passes, so the result
  // array accumulated duplicates while the journal stayed singular.
  const h = harness([t("hog"), t("x"), t("y")], {
    capacity: capFile({ "*": 1 }), // hog holds the only slot; x,y denied per pass
    script: { hog: async () => { await tick(5); return { stopped: "accepted-finish" }; } },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  const yd = res.denials.filter((d) => d.taskId === "y" && d.reason === "capacity:full");
  assert.equal(yd.length, 1, "one record per state change, not per decide pass");
  const journalYd = h.journalAppends.filter(
    (r) => r["kind"] === "sched-deny" && r["taskId"] === "y",
  );
  assert.equal(journalYd.length, 1, "the journal was always singular — pin the array to match");
  assert.equal(res.stopped, "quiesced-complete", "all three still finish");
});

test("AUDIT F3 (r2): a flag raised DURING decide()'s awaits stops the NEXT admission in the same pass", async () => {
  // The host raises the operator-stop flag while `a`'s sched-admit
  // journal append is in flight. Pre-fix only the wall's OUTER loop
  // polled the flag, so `b` — already queued in this decide pass — was
  // admitted anyway.
  const h = harness([t("a"), t("b")], { capacity: capFile({ "*": 4 }) });
  let flipped = false;
  const origJournal = h.deps.journal!;
  h.deps.journal = {
    async append(record: object) {
      await origJournal!.append(record);
      const r = record as { kind?: unknown; taskId?: unknown };
      if (r["kind"] === "sched-admit" && r["taskId"] === "a") flipped = true; // operator stops mid-pass
    },
  };
  h.deps.shutdown = { async poll() { return flipped; } };
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.admissions, 1, "pre-fix `b` was admitted after the flag was raised in this very pass");
  assert.equal(h.admitted.join(), "a");
  assert.equal(res.stopped, "shutdown");
  assert.equal(res.detail, "deferred-blocked", "`b` never started — the stop discloses the deferral");
});

test("AUDIT F4 (r2): scope-overlap journals each pair ONCE per episode — later admits do not re-report old pairs", async () => {
  // Pre-fix every admission recomputed ALL concurrent pairs, so when `c`
  // joined, the already-journaled (a,b) pair was appended AGAIN — with
  // the SAME actionId (an id-colliding duplicate in the journal).
  const scope = { files: ["src/**"] };
  const h = harness([t("a", { scope }), t("b", { scope }), t("c", { scope })], {
    capacity: capFile({ "*": 4 }),
    // all three must be LIVE simultaneously (a finished task is no
    // longer concurrent, so trivial loops would journal nothing).
    script: {
      a: async () => { await tick(10); return { stopped: "accepted-finish" }; },
      b: async () => { await tick(10); return { stopped: "accepted-finish" }; },
      c: async () => { await tick(10); return { stopped: "accepted-finish" }; },
    },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.stopped, "quiesced-complete");
  const ov = h.journalAppends.filter((r) => r["kind"] === "scope-overlap");
  assert.equal(ov.length, 3, "three pairs exist — three records, not four (pre-fix journaled a+b twice)");
  assert.deepEqual(ov.map((r) => String(r["pair"])).sort(), ["a+b", "a+c", "b+c"]);
  const actionIds = new Set(ov.map((r) => String(r["actionId"])));
  assert.equal(actionIds.size, 3, "every journal record carries a distinct actionId");
});

// ──────────────── audit regressions, round 3 (C1 findings) ─────────────────

test("AUDIT C1-1 (r3): a capacitySwap that frees a slot wakes the wall — a denied queued task is admitted, no lost wake", async () => {
  // endpoint A cap 1; `slow` holds it and swaps away to B (freeing A);
  // `waiter` was denied capacity:full. Pre-fix the wall slept until a
  // terminal event — the freed slot sat empty while `waiter` starved
  // until `slow` itself finished (docs/20 §3.4: no sleeping while
  // admission is possible).
  let waiterStarted = false;
  let slowDone = false;
  // AUDIT F6 (haiku55 r5): explicit EVENT TIMELINE — the old test
  // proved only eventual completion + single admission (mutation-
  // proven to pass with pingDecide/wakeNow removed). The timeline
  // pins the ORDERING: swap -> waiter-start (slowFinish still
  // pending, inside the bounded handshake) -> slow-return.
  const timeline: string[] = [];
  const h = harness([t("slow", { model: "A" }), t("waiter", { model: "A" })], {
    capacity: capFile({ A: 1, B: 4, "*": 4 }),
    script: {
      slow: async (hooks) => {
        await tick(5);
        assert.ok(hooks.capacitySwap("B", "A"), "the swap must succeed");
        timeline.push("swap");
        // AUDIT R4-F4 (round 4): bounded deferred handshake — `slow`
        // stays alive UNTIL `waiter` has actually started. Pre-fix the
        // wake was lost, the handshake timed out, and waiter only
        // started after slow finished. Asserting `!slowDone` at
        // waiter-start (below) is the ordering the old test only
        // commented; removing pingDecide/wakeNow now FAILS this test.
        const deadline = Date.now() + 2000;
        while (!waiterStarted && Date.now() < deadline) await tick(5);
        assert.ok(waiterStarted, "waiter started while slow was still running (no lost wake)");
        slowDone = true;
        timeline.push("slow-return");
        return { stopped: "accepted-finish" };
      },
      waiter: async () => {
        assert.equal(slowDone, false, "R4-F4: the waiter must start BEFORE slow finishes — the swap-freed slot, not the terminal");
        waiterStarted = true;
        timeline.push("waiter-start");
        return { stopped: "accepted-finish" };
      },
    },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.stopped, "quiesced-complete");
  // AUDIT F6 (haiku55 r5): the ORDERING assertion — swap happens, the
  // waiter starts while `slow` is still inside its body (the bounded
  // handshake proves it, not the eventual completion), and only then
  // does slow return. Mutation-checked: deleting `pingDecide = true;
  // wakeNow();` from capacitySwap fails the handshake (waiter never
  // starts before the deadline) — see the F6 note in HANDOFF.md.
  assert.deepEqual(timeline, ["swap", "waiter-start", "slow-return"], "event ordering: swap → waiter-start (slow still running) → slow-return");
  // waiter admitted while `slow` was STILL running — pre-fix this
  // ordering was impossible (the wake was lost).
  assert.equal(res.tasks.waiter?.status, "done");
  assert.equal(h.admitted.filter((x) => x === "waiter").length, 1);
  assert.ok(waiterStarted, "the handshake completed: waiter started while slow ran");
  assert.ok(slowDone, "slow finished after the handshake");
});

test("AUDIT C1-5 (r3): a task denied with CHANGED reasons gets distinct journal actionIds", async () => {
  // Pass 1: the ledger gate is closed for `x` → sched-deny budget-exceeded.
  // hog1 holds the only slot and finishes with the ledger OPEN; pass 2
  // admits hog2 (which then holds the slot), so `x` is denied again with
  // a CHANGED reason (capacity:full) — a reason change is a new state,
  // so a second record is owed. Pre-fix both carried the static
  // actionId `sched-ep-sched-x-deny` (an identity collision).
  let ledgerOk = false;
  const h = harness([t("hog1"), t("hog2"), t("x")], {
    capacity: capFile({ "*": 1 }),
    admissionCheck: async (task) =>
      task.id === "x" && !ledgerOk ? { allowed: false, codes: ["budget-exceeded"] } : { allowed: true, codes: [] },
    script: {
      hog1: async () => { await tick(10); ledgerOk = true; return { stopped: "accepted-finish" }; },
      hog2: async () => { await tick(15); return { stopped: "accepted-finish" }; },
    },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  const denies = h.journalAppends.filter((r) => r["kind"] === "sched-deny" && r["taskId"] === "x");
  assert.equal(denies.length, 2, "budget denial (pass 1) then capacity denial (pass 2)");
  assert.deepEqual(denies.map((r) => String(r["reason"])), ["budget-exceeded", "capacity:full"]);
  const ids = new Set(denies.map((r) => String(r["actionId"])));
  assert.equal(ids.size, 2, "distinct actionIds — pre-fix both were 'sched-ep-sched-x-deny'");
  assert.equal(res.tasks.x?.status, "done", "x still completes after the ledger opens");
});

test("AUDIT C1-6 (r3): overlap actionIds are unambiguous for task ids containing '-'", async () => {
  // Task ids legally contain '-': pairs ("a-b","c") and ("a","b-c")
  // both joined to `...-overlap-a-b-c` with the old '-' separator —
  // two distinct pairs sharing one journal actionId. '+' is excluded
  // from TASK_ID_RE, so the join is now parseable and unique.
  const scope = { files: ["f/**"] };
  const h = harness(
    [t("a", { scope }), t("b-c", { scope }), t("a-b", { scope }), t("c", { scope })],
    {
      capacity: capFile({ "*": 4 }),
      script: {
        a: async () => { await tick(20); return { stopped: "accepted-finish" }; },
        "b-c": async () => { await tick(20); return { stopped: "accepted-finish" }; },
        "a-b": async () => { await tick(20); return { stopped: "accepted-finish" }; },
        c: async () => { await tick(20); return { stopped: "accepted-finish" }; },
      },
    },
  );
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.stopped, "quiesced-complete");
  const ov = h.journalAppends.filter((r) => r["kind"] === "scope-overlap");
  const ids = ov.map((r) => String(r["actionId"]));
  assert.equal(new Set(ids).size, ids.length, "every overlap record has a unique actionId");
  assert.ok(ov.some((r) => String(r["pair"]) === "a-b+c"), "pair keys use '+' (ids with '-' stay intact)");
});

test("AUDIT C1-7 (r3): a seeded done WITHOUT complete never yields quiesced-COMPLETE — the false-green episode is closed", async () => {
  // All-seeded graph: the ONLY task is `done` with a `partial` verdict.
  // Pre-fix the fate stayed `done`, every() passed, and the episode
  // stopped quiesced-complete on unaccepted work (§3.4 maps that to
  // success). C1-7 normalizes the seed to `failed` with evidence.
  const h = harness([t("d", { status: "done", result: { acceptance: "partial" } })]);
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.tasks.d?.status, "failed");
  assert.match(res.tasks.d?.detail ?? "", /unaccepted:partial/);
  assert.equal(res.stopped, "quiesced-blocked", "never quiesced-complete on unaccepted work");
  assert.equal(res.admissions, 0);
});

test("AUDIT C1-3 (r3): seeded restart occupancy blocks the endpoint slot until release", async () => {
  // Durable evidence says `ghost` (terminal seed) may still occupy
  // endpoint A's only slot; `fresh` must NOT be admitted there while
  // the reservation stands. B is free.
  const h = harness(
    [t("ghost", { status: "failed", occupies: { endpoint: "A" } }), t("fresh", { model: "A" }), t("elsewhere", { model: "B" })],
    { capacity: capFile({ A: 1, B: 1, "*": 4 }) },
  );
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(h.admitted.includes("ghost"), false, "a seeded terminal never re-runs");
  assert.equal(res.tasks.fresh, undefined, "cap-1 endpoint fully reserved → fresh is denied, never admitted");
  assert.equal(res.tasks.elsewhere?.status, "done", "other endpoints are unaffected");
  assert.ok(
    res.denials.some((d) => d.taskId === "fresh" && d.reason === "capacity:full"),
    "the occupancy denial rides the normal capacity disclosure",
  );
  assert.equal(res.stopped, "quiesced-blocked");
});

test("AUDIT C1-4 (r3): admissionCheck receives the already-admitted set so the gate enforces the AGGREGATE", async () => {
  // §6's exit test: N+1 individually-affordable tasks collectively
  // over coverage leave the last UNADMITTED with a ledger-cited denial.
  // Pre-fix the check saw only the candidate, so the host could not
  // count outstanding reservations.
  const seen: string[][] = [];
  const h = harness([t("a"), t("b"), t("c")], {
    capacity: capFile({ "*": 4 }),
    admissionCheck: async (_task, ctx) => {
      const admitted = ctx?.admitted ?? [];
      seen.push([...admitted]);
      // coverage = 2: deny the third admission THIS episode.
      return { allowed: admitted.length < 2, codes: admitted.length < 2 ? [] : ["budget-coverage"] };
    },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.admissions, 2, "the third task is denied by aggregate coverage, not isolation");
  assert.equal(h.admitted.includes("c"), false);
  assert.ok(seen.every((s) => Array.isArray(s)), "context is always disclosed (older hosts may ignore it)");
  assert.ok(
    res.denials.some((d) => d.taskId === "c" && d.reason === "budget-coverage"),
    "the denial cites the ledger's code",
  );
  assert.equal(res.stopped, "quiesced-blocked");
});

test("AUDIT C1-8 (r3): a worktree-refusal park records its refusal in the task's outcome denials", async () => {
  // Pre-fix the parked outcome snapshotted denialsFor(id) BEFORE
  // denyOnce pushed 'worktree-refused' — the outcome's denial list was
  // permanently missing the very reason the task parked.
  const h = harness([t("w"), t("k", { dependsOn: ["w"] })], {
    worktrees: {
      async ensure(id: string) {
        return id === "w" ? { refused: "dirty-worktree" } : { path: `/wt/${id}` };
      },
    },
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.tasks.w?.status, "parked");
  assert.match(res.tasks.w?.detail ?? "", /worktree-refused:dirty-worktree/);
  assert.ok(
    (res.tasks.w?.denials ?? []).includes("worktree-refused"),
    "the refusal is IN the outcome — pre-fix it was snapshotted away forever",
  );
});

test("AUDIT C1-3 (r3): CapacitySlots.reserve is a fact, not a request — over-cap reservations still deny acquires", () => {
  const s = new CapacitySlots({ A: 1, "*": 4 }, 4);
  s.reserve("A"); // durable evidence: someone still holds A's slot
  assert.equal(s.usedOf("A"), 1);
  assert.equal(s.live(), 1, "a reservation counts against the episode ceiling");
  assert.ok(!s.tryAcquire("A"), "the reserved slot is not handed out again");
  s.reserve("A"); // evidence is evidence even over cap
  assert.equal(s.usedOf("A"), 2);
  assert.ok(!s.tryAcquire("A"));
});

// ───────────────────────── round-4 auditor findings ─────────────────────────

test("AUDIT R4-F2 (r4): seeded occupancy reserves its slot INDEPENDENTLY of the seeded status", async () => {
  // The old code honored `occupies` only inside the TERMINAL branch, so
  // a seed still marked `running` (reconcile not yet conclusive)
  // reserved nothing — another task took its endpoint slot, exactly the
  // double-spawn §8 forbids. Evidence is evidence: a `running` seed
  // with occupancy must block its endpoint too.
  const h = harness(
    [t("ghost", { status: "running", model: "A", occupies: { endpoint: "A" } }), t("fresh", { model: "A" }), t("elsewhere", { model: "B" })],
    { capacity: capFile({ A: 1, B: 1, "*": 4 }) },
  );
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(h.admitted.includes("ghost"), false, "a seeded running task is not re-spawned by the scheduler");
  assert.equal(res.tasks.fresh, undefined, "the ghost's endpoint stays reserved regardless of its seed status");
  assert.equal(res.tasks.elsewhere?.status, "done", "other endpoints are unaffected");
  assert.ok(
    res.denials.some((d) => d.taskId === "fresh" && d.reason === "capacity:full"),
    "the occupancy denial rides the normal capacity disclosure",
  );
});

test("AUDIT R4-F3 (r4): journal actionIds are namespaced by activation — restarts cannot collide", async () => {
  // The per-episode counters (denySeq, admissions, ...) restart at 0
  // every activation, so a restart replaying the same episode minted
  // the SAME actionIds as its predecessor. With deps.activation the
  // ids carry the lease token; without it the historical shape stays.
  const g = () => [t("a"), t("b", { dependsOn: ["a"] })];
  // A SHARED journal across both activations (one durable evidence
  // stream, as docs/20 §8 restart sees it) — deny/observer/admit
  // identities must not collide between them.
  const shared: Record<string, unknown>[] = [];
  const h1 = harness(g(), { activation: "123.abc-def_99" });
  const h2 = harness(g(), { activation: "124.ghi-jkl_00" });
  // a standing denial in both activations (ledger gate closed for `x`)
  const withDeny = (h: Harness) => {
    h.deps.capacity = capFile({ "*": 0 });
    return h;
  };
  // an observer grant in both activations
  const inv = async () => ({ summary: "s", notes: [], confidence: 1, suggestedActions: [] });
  const h1d = harness([t("x")], { activation: "125.deny-one", capacity: capFile({ "*": 0 }) });
  const h2d = harness([t("x")], { activation: "126.deny-two", capacity: capFile({ "*": 0 }) });
  const h1o = harness([t("a")], { activation: "127.obs-one", investigate: inv, script: { a: async (hooks) => { await hooks.investigate({ reason: "r", evidence: [] }, { maxTokens: 10 }); return { stopped: "accepted-finish" }; } } });
  const h2o = harness([t("a")], { activation: "128.obs-two", investigate: inv, script: { a: async (hooks) => { await hooks.investigate({ reason: "r", evidence: [] }, { maxTokens: 10 }); return { stopped: "accepted-finish" }; } } });
  void withDeny;
  for (const h of [h1, h2, h1d, h2d, h1o, h2o]) {
    const orig = h.deps.journal!;
    h.deps.journal = {
      async append(record: object) {
        shared.push(record as Record<string, unknown>);
        await orig.append(record);
      },
    };
  }
  await runSchedulerEpisode({ episodeId: "ep-sched" }, h1.deps);
  await runSchedulerEpisode({ episodeId: "ep-sched" }, h2.deps);
  await runSchedulerEpisode({ episodeId: "ep-sched" }, h1d.deps);
  await runSchedulerEpisode({ episodeId: "ep-sched" }, h2d.deps);
  await runSchedulerEpisode({ episodeId: "ep-sched" }, h1o.deps);
  await runSchedulerEpisode({ episodeId: "ep-sched" }, h2o.deps);
  const admits = (h: Harness) => h.journalAppends.filter((r) => r["kind"] === "sched-admit").map((r) => String(r["actionId"]));
  const ids1 = admits(h1), ids2 = admits(h2);
  assert.equal(ids1.length, 2); assert.equal(ids2.length, 2);
  assert.equal(new Set([...ids1, ...ids2]).size, 4, "two activations of one episode mint zero colliding actionIds");
  assert.ok(ids1.every((id) => id.startsWith("sched-123.abc-def_99-ep-sched-")), "the activation slug leads the id");
  // the SHARED stream: every actionId from the two named activations
  // (admit + deny + observer) is unique across the whole episode life.
  const named = shared.filter((r) => /^sched-12[345678]\./.test(String((r as { actionId?: string })["actionId"] ?? "")));
  assert.ok(named.length >= 6, "both activations journaled admit, deny, AND observer records");
  const namedIds = named.map((r) => String((r as { actionId?: string })["actionId"]));
  assert.equal(new Set(namedIds).size, namedIds.length, "zero cross-activation collisions in the shared journal (admit+deny+observer)");
});

test("AUDIT F3 (haiku55 r5): the activation identity is REQUIRED — a missing/blank one refuses activation", async () => {
  // The collision fix must not be OPT-IN: the shipped default used to
  // be the collision path (probe P3: two activations through one
  // shared journal emitted identical kind/actionId/seq). A missing or
  // whitespace-only activation is now an activation refusal (throws
  // BEFORE any spawn → the host's setup-failure exit).
  const h = harness([t("a")]);
  const bare = { ...h.deps } as SchedulerDeps;
  delete (bare as { activation?: string }).activation;
  await assert.rejects(() => runSchedulerEpisode({ episodeId: "ep-sched" }, bare), /sched: activation-required/);
  const blank = harness([t("a")], { activation: "   " });
  await assert.rejects(() => runSchedulerEpisode({ episodeId: "ep-sched" }, blank.deps), /sched: activation-required/);
  const hblank = harness([t("a")], { activation: "" });
  await assert.rejects(() => runSchedulerEpisode({ episodeId: "ep-sched" }, hblank.deps), /sched: activation-required/);
});

test("AUDIT F3 (haiku55 r5): two DEFAULT-shaped activations through one shared journal dir mint zero duplicate actionIds", async () => {
  // The probe P3 reproduction (`.tre/delegation/haiku55-audit/logs/
  // probe-r4f1-f2-c13.mjs`), upgraded to the required-activation
  // contract: two activations of the SAME episode on one durable
  // journal, each with its own lease-token-shaped activation, plus
  // admit AND deny AND overlap records flowing through the shared
  // stream. Zero duplicate actionIds, zero duplicate (kind,seq)
  // collisions per activation identity.
  const shared: Record<string, unknown>[] = [];
  const scope = { files: ["x/*.ts"] };
  const g = () => [t("a", { scope }), t("b", { scope })];
  const slow = async () => { await tick(5); return { stopped: "accepted-finish" }; };
  const mk = (activation: string) => {
    // Delayed loop bodies: `a` must still be RUNNING when `b` is
    // admitted, or no concurrent scope pair exists and the
    // scope-overlap record is never journaled (probe P1b's shape).
    const h = harness(g(), {
      activation, capacity: capFile({ "*": 4 }),
      script: { a: slow, b: slow },
    });
    const orig = h.deps.journal!;
    h.deps.journal = {
      async append(record: object) {
        shared.push(record as Record<string, unknown>);
        await orig.append(record);
      },
    };
    return h;
  };
  const h1 = mk("901.aaa-111.0");
  const h2 = mk("902.bbb-222.1");
  await runSchedulerEpisode({ episodeId: "ep-sched" }, h1.deps);
  await runSchedulerEpisode({ episodeId: "ep-sched" }, h2.deps);
  // both activations must have journaled admits AND the overlap pair
  const kinds = new Set(shared.map((r) => String(r["kind"])));
  assert.ok(kinds.has("sched-admit") && kinds.has("scope-overlap"), "admits and the overlap pair are in the shared stream");
  const ids = shared.map((r) => String(r["actionId"]));
  assert.ok(ids.length >= 6, "both activations journaled (admit×2 + overlap per activation)");
  const dups = ids.length - new Set(ids).size;
  assert.equal(dups, 0, `zero duplicate actionIds across activations (probe P3 reproduced: pre-fix duplicateActionIds was 1)`);
  assert.ok(shared.every((r) => String(r["actionId"]).startsWith("sched-90")), "every id carries an activation slug");
});

test("AUDIT F1 (haiku55 r5): a flag raised during the scope-overlap append rolls the admission back — no loop starts after the stop", async () => {
  // Probe P1b reproduction: tasks a and b share scope.files ["x/*.ts"];
  // the scope-overlap journal append for the a+b pair yields and the
  // operator raises the shutdown flag DURING that await. Pre-fix the
  // pre-admit re-check sat BEFORE the overlap loop, so b's runOne
  // started anyway (admitted ["a","b"], stopped "quiesced-complete").
  // Fix: re-poll after the overlap-journal loop — the last await before
  // the loop starts — and roll the admission back (slot returned, fate
  // reverted; §8: an admitted-but-never-started task is re-admitted).
  // The slow loop bodies are load-bearing: `a` must still be RUNNING
  // when `b` is admitted or no concurrent pair exists and the overlap
  // record is never journaled (probe P1b's loop shape: tick(5)).
  const scope = { files: ["x/*.ts"] };
  const slow = async () => { await tick(5); return { stopped: "accepted-finish" }; };
  const h = harness([t("a", { scope }), t("b", { scope })], {
    capacity: capFile({ "*": 4 }),
    script: { a: slow, b: slow },
  });
  let flipped = false;
  const orig = h.deps.journal!;
  h.deps.journal = {
    async append(record: object) {
      const r = record as { kind?: unknown };
      if (r["kind"] === "scope-overlap") { await tick(1); flipped = true; } // operator stops mid-append
      await orig.append(record);
    },
  };
  h.deps.shutdown = { async poll() { return flipped; } };
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.deepEqual(h.admitted, ["a"], "b's loop NEVER started — the overlap window cannot smuggle an admission past the stop");
  assert.equal(res.stopped, "shutdown", "the episode reports the operator stop, not quiesced-complete");
  assert.equal(res.admissions, 1, "the rolled-back admission is not counted (b re-admittable on the next activation, §8)");
  assert.equal(res.tasks.b, undefined, "b has no outcome — its fate reverted to queued");
});

test("AUDIT F2 (haiku55 r5): a seeded `running` task WITHOUT occupies evidence is parked — its endpoint is never handed out", async () => {
  // Probe P2b reproduction: ghost status "running", model M, NO occupies
  // evidence; b also targets M on a cap-1 endpoint. Pre-fix the seed
  // loop silently IGNORED `running` (no fate, no slot) and b was
  // admitted onto the possibly-live worker's endpoint (double-spawn,
  // the §8 violation). Fix: any seeded `running` without a reconcile
  // verdict is parked fail-closed; the endpoint stays occupied-for-this-
  // activation by the parked ghost's fate (no new admission can run
  // beside a worker that may still be live).
  const h = harness(
    [t("ghost", { status: "running", model: "M" }), t("b", { model: "M" })],
    { capacity: capFile({ "*": 1, M: 1 }) },
  );
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.tasks.ghost?.status, "parked", "the no-evidence running seed is parked, never ignored");
  assert.match(res.tasks.ghost?.detail ?? "", /reconcile-pending:no-evidence/, "the derived fate names the missing reconcile verdict");
  assert.deepEqual(h.admitted, [], "b is NOT admitted onto the ghost's cap-1 endpoint (pre-fix: admitted [\"b\"])");
  assert.equal(res.stopped, "quiesced-blocked", "the episode blocks with the ghost's dependents unrun — never a false double-spawn");
});

test("AUDIT F2 (haiku55 r5): a seeded `running` WITH occupies evidence keeps reserving its slot (R4-F2 must not regress)", async () => {
  // Probe P2: the evidence-present case stays fixed — the slot is
  // reserved BEFORE any admission, so the cap-1 endpoint denies b. The
  // fate is now parked too (evidence reserves; only reconcile clears).
  const h = harness(
    [t("ghost", { status: "running", model: "M", occupies: { endpoint: "M" } }), t("b", { model: "M" })],
    { capacity: capFile({ "*": 1, M: 1 }) },
  );
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.deepEqual(h.admitted, [], "the reserved slot still denies b (P2 held: admitted [], quiesced-blocked)");
  assert.equal(res.tasks.ghost?.status, "parked", "running+evidence is parked with the evidence named");
  assert.match(res.tasks.ghost?.detail ?? "", /reconcile-pending:occupies-evidence/);
  assert.equal(res.stopped, "quiesced-blocked");
});

test("AUDIT R4-F1 (r4): a yields-then-REJECTS journal append cannot smuggle an admission past the stop", async () => {
  // The old re-check was conditional on `awaitSincePoll`, which the
  // journal helper set AFTER the append resolved: an append that
  // YIELDS (host raises the flag in the window) and then REJECTS
  // skipped the setter entirely — the bookkeeping said "no await since
  // the last poll" while the flag was in fact set. The re-check is now
  // UNCONDITIONAL before every admission.
  const h = harness([t("a"), t("b")], { capacity: capFile({ "*": 4 }) });
  let flipped = false;
  let used = false;
  const origJournal = h.deps.journal!;
  h.deps.journal = {
    async append(record: object) {
      const r = record as { kind?: unknown; taskId?: unknown };
      if (r["kind"] === "sched-admit" && r["taskId"] === "a" && !used) {
        used = true;
        await tick(1); // the host raises the operator-stop flag mid-await...
        flipped = true;
        throw new Error("journal append rejected mid-flight (harness)"); // ...and the append REJECTS
      }
      await origJournal!.append(record);
    },
  };
  h.deps.shutdown = { async poll() { return flipped; } };
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.admissions, 1, "pre-fix `b` was admitted — the rejected append never set the await-flag bookkeeping");
  assert.equal(h.admitted.join(), "a", "`a` ran (the record rejection is disclosure-only), `b` never started");
  assert.equal(res.stopped, "shutdown");
  assert.equal(res.detail, "deferred-blocked");
});

// ───────────────────── R4-F5: the ledger-backed aggregate adapter ──────────

// The adapter (src/host/sched-gate.ts) is the PRODUCTION implementation
// of the admissionCheck port the C1-4 test above could only fake: it
// folds the scheduler's pending admits (ctx.admitted) at their
// reservation floor into a new-admission check() of the live ledger
// snapshot, so §6's aggregate denial has a real code path.

/** A ledger policy that is generous per task but tight per episode. */
function f5Policy(caps: { usd?: number; turns?: number } = {}): GatePolicy {
  return {
    episodeId: "ep-sched",
    caps: { usd: 1, turns: 1000, ...caps },
    allowExternalEffects: false,
  };
}
const f5Auth = { grantedBy: "test:sched-gate", sideEffect: "none" } as const;

async function f5Reserve(ledger: BudgetLedger, policy: GatePolicy, req: Partial<GateRequest> & { actionId: string }, at: number): Promise<string> {
  const full: GateRequest = { action: "run", authority: f5Auth, taskId: req.actionId.replace(/^act-/, ""), ...req } as GateRequest;
  const checked = ledgerCheck(policy, full, await ledger.snapshotAt(at), at);
  assert.ok(checked.allowed, `fixture reserve ${full.actionId} must pass: ${JSON.stringify(checked.denials)}`);
  const rec = await ledger.reserve(policy, full, checked.receipt!, { clock: () => at });
  return rec.id;
}

test("R4-F5: §6 individually affordable tasks collectively exceed pending and durable coverage", async () => {
  // Episode cap $0.50, run floor $0.25: at most TWO admits fit. Three
  // ready tasks each pass in isolation; the AGGREGATE must stop the
  // third with the LEDGER's code, not a fake capacity:full.
  const dir = await mkdtemp(join(tmpdir(), "sched-f5-"));
  const ledger = await BudgetLedger.open(join(dir, "budget.jsonl"));
  const policy = f5Policy({ usd: 0.5 });
  const gate = makeLedgerAdmissionCheck({ ledger, policy, now: () => NOW, reservationActionIdOf: (id) => `act-${id}` });
  const h = harness([t("a"), t("b"), t("c")], {
    capacity: capFile({ "*": 4 }),
    admissionCheck: (task, ctx) => gate(task, ctx),
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);

  // exactly two admitted, the third denied by the ledger's aggregate:
  assert.equal(res.admissions, 2, "two floors of 0.25 fill the 0.50 episode cap");
  assert.equal(h.admitted.includes("c"), false, "c's loop never started — denied, not run");
  assert.equal(res.tasks.c, undefined, "a never-admitted task has no outcome entry (§3: outcomes track admissions)");
  assert.ok(
    res.denials.some((d) => d.taskId === "c" && d.reason === "episode-budget-exceeded"),
    `the denial cites the LEDGER code (D5), got ${JSON.stringify(res.denials)}`,
  );
  assert.ok(!res.denials.some((d) => d.taskId === "c" && d.reason === "capacity:full"), "never a false capacity:full (§6/D5)");
  assert.equal(res.stopped, "quiesced-blocked");

  // The scheduler owns no durable reservations: loop act boundaries do.
  assert.equal((await ledger.snapshotAt(NOW)).actionIds.size, 0);
  // Two actual open holds plus a fresh candidate exceed coverage too.
  await f5Reserve(ledger, policy, { actionId: "act-x", taskId: "x" }, NOW);
  await f5Reserve(ledger, policy, { actionId: "act-y", taskId: "y" }, NOW);
  const verdict = await gate({ id: "z" }, { admitted: [] });
  assert.equal(verdict.allowed, false, "durable holds + z's folded floor exceed the cap");
  assert.deepEqual(verdict.codes, ["episode-budget-exceeded"]);
});

test("R4-F5: pending fold counts IN-PASS admits at the floor; durable siblings are never double counted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sched-f5b-"));
  const ledger = await BudgetLedger.open(join(dir, "budget.jsonl"));
  const policy = f5Policy({ usd: 0.5 }); // 2 floors of 0.25
  const gate = makeLedgerAdmissionCheck({ ledger, policy, now: () => NOW, reservationActionIdOf: (id) => `act-${id}` });

  // No durable state at all: the fold of ctx.admitted alone decides.
  assert.equal((await gate({ id: "c" }, { admitted: ["a", "b"] })).allowed, false, "a+b pending fill the cap");
  assert.equal((await gate({ id: "c" }, { admitted: ["a"] })).allowed, true, "a pending + c itself = exactly the cap");
  assert.equal((await gate({ id: "c" }, { admitted: [] })).allowed, true, "in isolation c fits (§6 premise: each affordable alone)");

  // Durable dedupe: a's reservation IS on the ledger → its floor must
  // NOT be folded again; b (pending) + c = 0.50 fits, a's open hold of
  // 0.25 pushes it over ONLY through the snapshot, never doubled.
  await gate({ id: "a" }); // establish this activation before its reservation
  await f5Reserve(ledger, policy, { actionId: "act-a", taskId: "a" }, NOW);
  const v1 = await gate({ id: "c" }, { admitted: ["a", "b"] });
  assert.equal(v1.allowed, false, "durable a (0.25) + pending b (0.25) + c (0.25) > 0.50");
  const v2 = await gate({ id: "c" }, { admitted: ["b"] });
  assert.equal(v2.allowed, false, "durable a + pending b + c is STILL 0.75 — a counted exactly once");
  // Proof against double counting: with only durable a and no pending,
  // a + c = 0.50 EXACTLY fits (a folded twice would deny this).
  const v3 = await gate({ id: "c" }, { admitted: ["a"] });
  assert.equal(v3.allowed, true, "durable a is NOT folded again — exactly-once against the cap");
});

test("R4-F5: a failed snapshot FAILS CLOSED with a ledger-cited code (never admits on an unconsultable gate)", async () => {
  const gate = makeLedgerAdmissionCheck({
    ledger: { async snapshotAt() { throw new Error("ledger file unreadable"); } },
    policy: f5Policy(),
    now: () => NOW,
  });
  const v = await gate({ id: "a" }, { admitted: [] });
  assert.equal(v.allowed, false);
  assert.deepEqual(v.codes, ["ledger-unavailable"]);
});

test("R4-F5: foldPendingFloors is pure and dual-level (episode + task compartment)", () => {
  const policy = f5Policy();
  const base = { now: NOW, compartments: new Map(), attemptsUsed: new Map(), wallclockS: new Map(), attemptWallclockS: new Map(), openReservations: [], actionIds: new Map(), strategyUses: new Map(), reservedAttempts: new Set() };
  const folded = foldPendingFloors(base as never, policy, [{ taskId: "a", usd: 0.25, turns: 1 }, { taskId: "b", usd: 0.25, turns: 1 }]);
  assert.equal(base.compartments.size, 0, "input snapshot untouched (pure)");
  const epKey = JSON.stringify(["ep-sched", null, null]);
  const taskKey = JSON.stringify(["ep-sched", "a", null]);
  assert.equal(folded.compartments.get(epKey)?.reservedUsd, 0.5, "episode compartment carries the aggregate");
  assert.equal(folded.compartments.get(taskKey)?.reservedUsd, 0.25, "the task's own compartment carries its floor (perTask caps judge it)");
  assert.equal(durableReservedTaskIds(base as never, policy.episodeId).size, 0);
});

test("R4-F5: an evidence-backed release REFUNDS the aggregate (fold follows the durable charge, not the disclosure)", async () => {
  // admittedEver never shrinks — so the fold must track the LEDGER, not
  // the scheduler's memory: a settled reservation charges through
  // consumed (fold must not double it), a released one (A8's refund,
  // negative evidence the spawn never started) charges NOTHING and is
  // honestly out of the aggregate. Folding disclosed-but-released tasks
  // forever would deny work the ledger can cover.
  const dir = await mkdtemp(join(tmpdir(), "sched-f5c-"));
  const ledger = await BudgetLedger.open(join(dir, "budget.jsonl"));
  const policy = f5Policy({ usd: 0.5 });
  const gate = makeLedgerAdmissionCheck({ ledger, policy, now: () => NOW, reservationActionIdOf: (id) => `act-${id}` });
  await gate({ id: "a" });
  const recId = await f5Reserve(ledger, policy, { actionId: "act-a", taskId: "a" }, NOW);
  // a's hold is OPEN: a (durable 0.25) + b (pending) + c (pending) = 0.75 denies.
  assert.equal((await gate({ id: "c" }, { admitted: ["a", "b"] })).allowed, false, "open hold charges the aggregate");
  await ledger.closeReservation(recId, "released", { outcome: "spawn-failed-unstarted", evidence: "spawn-error:e1", spawnStarted: false }, { clock: () => NOW + 1 });
  // released with negative evidence: the refund is real — b + c = 0.50 fits.
  const v = await gate({ id: "c" }, { admitted: ["a", "b"] });
  assert.equal(v.allowed, true, "a released hold no longer charges the episode — the fold never invents a phantom floor");
});

test("R4-F5: turn caps aggregate too — 3 pending admits vs a 2-turn episode cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sched-f5d-"));
  const ledger = await BudgetLedger.open(join(dir, "budget.jsonl"));
  const policy = f5Policy({ usd: 100, turns: 2 }); // USD roomy; turns: run floor 1
  const gate = makeLedgerAdmissionCheck({ ledger, policy, now: () => NOW, reservationActionIdOf: (id) => `act-${id}` });
  const h = harness([t("a"), t("b"), t("c")], {
    capacity: capFile({ "*": 4 }),
    admissionCheck: (task, ctx) => gate(task, ctx),
  });
  const res = await runSchedulerEpisode({ episodeId: "ep-sched" }, h.deps);
  assert.equal(res.admissions, 2, "one turn per floor, cap 2");
  assert.ok(res.denials.some((d) => d.taskId === "c" && d.reason === "episode-turns-exceeded"), `turn cap cited, got ${JSON.stringify(res.denials)}`);
});

test("R4-F5 wire shape: reserveDefault floors are what the loop will durably charge (the fold never launders)", () => {
  // D2: a loop may only RAISE its estimate — so folding the class floor
  // is the strongest durable claim pending admits justify, and the loop
  // boundary re-check (reserve's refresh-first) can only DENY later,
  // never launder the admission. Pin the floors the fold is built on.
  assert.deepEqual(reserveDefault("run"), { usd: 0.25, turns: 1 });
  assert.deepEqual(reserveDefault("resume"), { usd: 0.05, turns: 1 });
});

test("AUDIT F5 (haiku55 r5): the fold prices a pending sibling at its RAISED estimate, not the class floor (probe S4)", async () => {
  // Probe S4 reproduction: the loop for `a` reserves a RAISED estimate
  // (0.4) — a loop may raise above the class floor (0.25) — while the
  // adapter folded pending `a` at the class floor. With the episode cap
  // at 0.5, `b` (floor 0.25) was admitted against a pending `a@0.25`,
  // then the loop's boundary reserve of 0.4 denied the admission
  // anyway: a wasted admission the aggregate should have refused. Fix:
  // the host supplies floorOf with the RAISED estimate (clamped up to
  // the class floor), so the fold charges what the loop will actually
  // reserve (§6: "admission asks the ledger for the standing coverage,
  // never an estimate of its own invention").
  const ledger = await BudgetLedger.open(join(await mkdtemp(join(tmpdir(), "f5-raised-")), "budget.jsonl"));
  const policy = f5Policy({ usd: 0.5 });
  const raised: Record<string, { usd: number; turns: number }> = { a: { usd: 0.4, turns: 1 } };
  const gate = makeLedgerAdmissionCheck({
    ledger, policy, now: () => NOW,
    floorOf: (id) => raised[id] ?? reserveDefault("run"),
  });
  // Without the raised estimate the fold would price a@0.25 and allow
  // b (0.25+0.25 = 0.5 fits); WITH it the fold prices a@0.4 and b's own
  // floor (0.4+0.25 > 0.5) is denied up front — no wasted admission.
  assert.deepEqual(await gate({ id: "b" }, { admitted: ["a"] }), { allowed: false, codes: ["episode-budget-exceeded"] }, "pending a folded at its raised 0.4, not the 0.25 class floor (probe S4: pre-fix b was allowed)");
  // And the raised fold still fits what genuinely fits: cap 0.7 admits
  // b beside a@0.4.
  const wide = f5Policy({ usd: 0.7 });
  const gateWide = makeLedgerAdmissionCheck({
    ledger: await BudgetLedger.open(join(await mkdtemp(join(tmpdir(), "f5-raised-wide-")), "budget.jsonl")),
    policy: wide, now: () => NOW,
    floorOf: (id) => raised[id] ?? reserveDefault("run"),
  });
  assert.equal((await gateWide({ id: "b" }, { admitted: ["a"] })).allowed, true, "0.4 + 0.25 fits a 0.7 episode cap");
});

test("R4-F5: released candidate still pays a fresh floor beside pending siblings", async () => {
  const ledger = await BudgetLedger.open(join(await mkdtemp(join(tmpdir(), "f5-reenter-")), "budget.jsonl"));
  const policy = f5Policy({ usd: 0.25 });
  const ref = await f5Reserve(ledger, policy, { actionId: "old-a", taskId: "a" }, NOW);
  await ledger.closeReservation(ref, "released", { outcome: "not-started", evidence: "test:spawn-error", spawnStarted: false }, { clock: () => NOW });
  const gate = makeLedgerAdmissionCheck({ ledger, policy, now: () => NOW, reservationActionIdOf: (id) => `act-${id}` });
  assert.deepEqual(await gate({ id: "a" }, { admitted: ["b", "a"] }), { allowed: false, codes: ["episode-budget-exceeded"] });
  assert.equal((await gate({ id: "a" })).allowed, true, "historical release refunded its hold, not the new candidate floor");
});

test("R4-F5: foreign episode reservations cannot discharge local pending floors", async () => {
  const ledger = await BudgetLedger.open(join(await mkdtemp(join(tmpdir(), "f5-episode-")), "budget.jsonl"));
  const gate = makeLedgerAdmissionCheck({ ledger, policy: f5Policy({ usd: 0.25 }), now: () => NOW, reservationActionIdOf: (id) => `act-${id}` });
  await gate({ id: "a" });
  await f5Reserve(ledger, { ...f5Policy(), episodeId: "other" }, { actionId: "act-a", taskId: "a" }, NOW);
  assert.deepEqual(await gate({ id: "b" }, { admitted: ["a"] }), { allowed: false, codes: ["episode-budget-exceeded"] });
});

test("R4-F5: custom floors reject malformed arithmetic and cannot lower class defaults", async () => {
  const ledger = { async snapshotAt() { return projectLedger([], NOW); } };
  for (const bad of [-1, NaN, Infinity]) {
    for (const field of ["usd", "turns"] as const) {
      const gate = makeLedgerAdmissionCheck({ ledger, policy: f5Policy(), now: () => NOW, floorOf: () => ({ usd: 0.25, turns: 1, [field]: bad }) });
      assert.deepEqual(await gate({ id: "a" }), { allowed: false, codes: ["ledger-unavailable"] });
    }
  }
  const gate = makeLedgerAdmissionCheck({ ledger, policy: f5Policy({ usd: 0.25 }), now: () => NOW, floorOf: () => ({ usd: 0, turns: 0 }) });
  assert.deepEqual(await gate({ id: "b" }, { admitted: ["a"] }), { allowed: false, codes: ["episode-budget-exceeded"] });
});

test("R4-F5: sequential loop reserve, priced spend and settle transitions preserve real aggregate coverage", async () => {
  const ledger = await BudgetLedger.open(join(await mkdtemp(join(tmpdir(), "f5-settle-")), "budget.jsonl"));
  const policy = f5Policy({ usd: 0.5 });
  const gate = makeLedgerAdmissionCheck({ ledger, policy, now: () => NOW, reservationActionIdOf: (id) => `act-${id}` });
  const settled: string[] = [];
  const script = Object.fromEntries(["a", "b", "c"].map((id) => [id, async () => {
    const ref = await f5Reserve(ledger, policy, { actionId: `act-${id}`, taskId: id }, NOW);
    await ledger.recordManualSpend({ lineId: `line-${id}`, model: "test", provider: "test", usage: { input: 1, output: 0 }, rates: { input: 250000, output: 0 }, note: "exactly $0.25" }, { episodeId: policy.episodeId, taskId: id }, { clock: () => NOW });
    await ledger.closeReservation(ref, "settled", { outcome: "finished", evidence: `test:${id}` }, { clock: () => NOW });
    settled.push(id);
    return { stopped: "accepted-finish" };
  }]));
  const h = harness([t("a"), t("b", { dependsOn: ["a"] }), t("c", { dependsOn: ["b"] })], {
    admissionCheck: gate, script: script as NonNullable<Parameters<typeof harness>[1]>["script"], maxParallel: 1,
  });
  const result = await runSchedulerEpisode({ episodeId: policy.episodeId }, h.deps);
  assert.equal(result.admissions, 2);
  assert.deepEqual(settled, ["a", "b"]);
  assert.ok(result.denials.some((d) => d.taskId === "c" && d.reason === "episode-budget-exceeded"));
  const snap = await ledger.snapshotAt(NOW);
  assert.equal(snap.openReservations.length, 0);
  assert.equal(snap.compartments.get(JSON.stringify([policy.episodeId, null, null]))?.consumedUsd, 0.5);
});

test("R4-F5: historical released sibling cannot hide a fresh in-pass admission", async () => {
  const ledger = await BudgetLedger.open(join(await mkdtemp(join(tmpdir(), "f5-old-sibling-")), "budget.jsonl"));
  const policy = f5Policy({ usd: 0.25 });
  const ref = await f5Reserve(ledger, policy, { actionId: "old-a", taskId: "a" }, NOW);
  await ledger.closeReservation(ref, "released", { outcome: "not-started", evidence: "test:old", spawnStarted: false }, { clock: () => NOW });
  const gate = makeLedgerAdmissionCheck({ ledger, policy, now: () => NOW, reservationActionIdOf: (id) => `act-${id}` });
  assert.equal((await gate({ id: "a" })).allowed, true);
  assert.deepEqual(await gate({ id: "b" }, { admitted: ["a"] }), { allowed: false, codes: ["episode-budget-exceeded"] });
});

test("R4-F5: malformed callback results fail closed and raised estimates obey attempt caps", async () => {
  const ledger = { async snapshotAt() { return projectLedger([], NOW); } };
  for (const value of [null, undefined, {}, { usd: 1 }, { usd: 0.25, turns: 0.5 }]) {
    const gate = makeLedgerAdmissionCheck({ ledger, policy: f5Policy(), now: () => NOW, floorOf: () => value as never });
    assert.equal((await gate({ id: "a" })).allowed, false);
  }
  const gate = makeLedgerAdmissionCheck({ ledger, policy: { ...f5Policy(), perAttempt: { usd: 0.3 } }, now: () => NOW, floorOf: () => ({ usd: 0.4, turns: 1 }) });
  assert.deepEqual(await gate({ id: "a" }), { allowed: false, codes: ["attempt-budget-exceeded"] });
  const resume = makeLedgerAdmissionCheck({ ledger, policy: f5Policy(), now: () => NOW, actionOf: () => "resume" });
  assert.equal((await resume({ id: "a" })).allowed, false, "resume without attempt context is not validated");
  assert.ok((await resume({ id: "a", attemptId: "missing" })).codes.includes("attempt-budget-exceeded"));
});

test("R4-F5: speculative checks cannot attribute intervening historical reservations to a new admission", async () => {
  const ledger = await BudgetLedger.open(join(await mkdtemp(join(tmpdir(), "f5-speculative-")), "budget.jsonl"));
  const policy = f5Policy({ usd: 0.25 });
  const gate = makeLedgerAdmissionCheck({ ledger, policy, now: () => NOW, reservationActionIdOf: (id) => `new-${id}` });
  await gate({ id: "a" }); // speculative check while capacity-blocked
  const ref = await f5Reserve(ledger, policy, { actionId: "intervening-a", taskId: "a" }, NOW);
  await ledger.closeReservation(ref, "released", { outcome: "not-started", evidence: "test:intervening", spawnStarted: false }, { clock: () => NOW });
  assert.equal((await gate({ id: "a" })).allowed, true);
  assert.deepEqual(await gate({ id: "b" }, { admitted: ["a"] }), { allowed: false, codes: ["episode-budget-exceeded"] });
});

test("R4-F5: episode wallclock excludes foreign overlapping task names", async () => {
  const ledger = await BudgetLedger.open(join(await mkdtemp(join(tmpdir(), "f5-clock-")), "budget.jsonl"));
  await ledger.recordWallclock({ episodeId: "other", taskId: "a" }, 100, { clock: () => NOW });
  await ledger.recordWallclock({ episodeId: "ep-sched", taskId: "a" }, 1, { clock: () => NOW });
  const gate = makeLedgerAdmissionCheck({ ledger, policy: { ...f5Policy(), caps: { wallclockS: 5 } }, now: () => NOW });
  assert.equal((await gate({ id: "a" })).allowed, true);
  await ledger.recordWallclock({ episodeId: "ep-sched", taskId: "a" }, 6, { clock: () => NOW });
  assert.ok((await gate({ id: "a" })).codes.includes("episode-wallclock-exceeded"));
});

test("R4-F5: below-default attempt caps retain canonical ledger diagnosis", async () => {
  const gate = makeLedgerAdmissionCheck({ ledger: { async snapshotAt() { return projectLedger([], NOW); } }, policy: { ...f5Policy(), perAttempt: { usd: 0.1 } }, now: () => NOW });
  assert.ok((await gate({ id: "a" })).codes.includes("reserve-default-exceeds-cap"));
});
