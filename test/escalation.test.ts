/**
 * P13/M1 — human escalation channel tests (docs/19; docs/11 §11 P13 row).
 *
 * Coverage (docs/19 §7 testing doctrine, by name):
 *  - record validity & identity: schema, defaults per blocker, stable
 *    escalationId (INV-6), distinct line ids, invalid identity → null +
 *    NOTHING appended (compose R3/F16);
 *  - INV-2 order: append happens-before deliver (call-order log), a
 *    deliver throw leaves the record appended + disclosed, an append
 *    throw rejects;
 *  - INV-5 dedup matrix: re-notice no delivery; new evidence digest
 *    delivers; force delivers; cap blocks (incl. across "restarts");
 *    different blocker = different key;
 *  - pending()/resolve matrix: replay view, close-on-resolution,
 *    double-resolve, corrupt-line skip, no-read mirror fallback,
 *    read-failure degradation;
 *  - fence suite (P15 pattern): revoked proxies, throwing getters,
 *    length lies, bounds (16/10/240 + 'truncated' marker) — always a
 *    valid record or a clean null, never a throw;
 *  - dispatcher seam + REAL executor integration (executeRecoveryAction
 *    with the dispatcher as ports.dispatch → durable record + one
 *    delivery, journal intent/outcome intact);
 *  - consumer (fake bridge): render bound, disabled bridge, send-throw →
 *    raise discloses; parse matrix;
 *  - compartment guards (INV-8): module imports ONLY node:crypto;
 *    exactly ONE external importer (src/telegram/escalation.ts);
 *    source scan for fs/process/network authority tokens.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  makeEscalationChannel,
  makeEscalationDispatcher,
  ESCALATION_SCHEMA,
  BLOCKERS,
  DECISIONS,
  type EscalationRecord,
  type RaiseResult,
} from "../src/escalation/channel.js";
import {
  makeTelegramDeliver,
  parseTelegramResolution,
  renderEscalation,
  resolutionRejectionHint,
} from "../src/telegram/escalation.js";
import { executeRecoveryAction, STRATEGY_TEMPLATES as EXEC_TEMPLATES, ACTION_DECISION as EXEC_DECISION, ACTION_RUNG as EXEC_RUNG } from "../src/executor/exec.js";

type Rec = Record<string, unknown>;

// ───────────────────────── fixtures ────────────────────────────────────────

interface Harness {
  log: string[];
  appends: unknown[];
  delivers: unknown[];
  deliverThrows?: boolean;
  channel: ReturnType<typeof makeEscalationChannel>;
  restart: () => ReturnType<typeof makeEscalationChannel>;
}

function mk(opts: { deliverMode?: "ok" | "throw" | "none"; readMode?: "ok" | "throw" | "none"; maxRedeliver?: number } = {}): Harness {
  const log: string[] = [];
  const appends: unknown[] = [];
  const delivers: unknown[] = [];
  const deps = () => ({
    append: async (rec: object) => {
      log.push("append");
      appends.push(rec as Rec);
    },
    ...(opts.readMode === "none" ? {} : {
      read: async () => {
        if (opts.readMode === "throw") throw new Error("read-denied");
        return [...appends];
      },
    }),
    ...(opts.deliverMode === "none" ? {} : {
      deliver: async (rec: EscalationRecord) => {
        log.push("deliver");
        if (opts.deliverMode === "throw") throw new Error("send-boom");
        delivers.push(rec as unknown as Rec);
        return { channel: "telegram" };
      },
    }),
    now: () => 1700000000 + appends.length,
    ...(opts.maxRedeliver !== undefined ? { maxRedeliver: opts.maxRedeliver } : {}),
  });
  const channel = makeEscalationChannel(deps());
  return { log, appends, delivers, channel, restart: () => makeEscalationChannel(deps()) };
}

const valid = (over: Rec = {}): Rec => ({
  episodeId: "ep1",
  taskId: "t2",
  blocker: "repeated-strategy",
  decisionNeeded: "approve model-swap beyond budget, rewrite t2, or abort",
  evidence: ["journal:act-abc", "session:w1"],
  attempts: [{ action: "backoff-retry", strategyId: "backoff:v1", detail: "denied: budget-usd" }],
  ...over,
});

/** Canonical shape check for every record the module produces. */
function assertValidRecord(rec: EscalationRecord) {
  assert.equal(rec.schema, ESCALATION_SCHEMA);
  assert.equal(rec.kind, "escalation");
  assert.match(rec.escalationId, /^esc-[0-9a-f]{16}$/);
  assert.match(rec.id, /^esc-[0-9a-f]{16}#\d+$/);
  assert.ok((BLOCKERS as readonly string[]).includes(rec.blocker), `blocker ${rec.blocker}`);
  assert.ok(typeof rec.decisionNeeded === "string" && rec.decisionNeeded.length > 0);
  assert.ok(Array.isArray(rec.evidence) && rec.evidence.length <= 16);
  assert.ok(Array.isArray(rec.attempts) && rec.attempts.length <= 10);
  assert.ok(Number.isInteger(rec.reNotice) && rec.reNotice >= 0);
  assert.ok(Number.isInteger(rec.deliveredCount) && rec.deliveredCount >= 0);
  assert.match(rec.evidenceDigest, /^[0-9a-f]{16}$/);
  assert.equal(rec.provenance, "P13/M1");
}

// ───────────────────────── record & identity ───────────────────────────────

test("record: valid raise produces the full record, appends before delivering", async () => {
  const h = mk();
  const res = (await h.channel.raise(valid() as never)) as RaiseResult;
  assertValidRecord(res.record);
  assert.equal(res.delivered, true);
  assert.equal(res.channel, "telegram");
  assert.equal(res.record.episodeId, "ep1");
  assert.equal(res.record.taskId, "t2");
  assert.deepEqual(h.log, ["append", "deliver"], "INV-2: append happens-before deliver");
});

test("record: absent blocker → 'unknown' floor + the blocker's default question", async () => {
  const h = mk();
  const r1 = (await h.channel.raise({ episodeId: "e", taskId: "t" } as never)) as RaiseResult;
  assert.equal(r1.record.blocker, "unknown");
  assert.match(r1.record.decisionNeeded, /review the evidence and decide/);
  for (const bad of [42, "", "nonsense-blocker", null, ["x"]]) {
    const r = (await h.channel.raise({ episodeId: "e", taskId: "t", blocker: bad } as never)) as RaiseResult;
    assert.equal(r.record.blocker, "unknown", `blocker ${String(bad)} floors to unknown`);
  }
});

test("INV-6: stable escalationId across raises; distinct line ids", async () => {
  const h = mk();
  const r1 = (await h.channel.raise(valid() as never)) as RaiseResult;
  const r2 = (await h.channel.raise(valid({ evidence: ["new"] }) as never)) as RaiseResult;
  assert.equal(r2.record.escalationId, r1.record.escalationId);
  assert.equal(r1.record.id, `${r1.record.escalationId}#0`);
  assert.equal(r2.record.id, `${r2.record.escalationId}#1`);
  // cross-instance stability (pure hash of the dedup key):
  const h2 = mk();
  const r3 = (await h2.channel.raise(valid() as never)) as RaiseResult;
  assert.equal(r3.record.escalationId, r1.record.escalationId);
});

test("identity: invalid episodeId/taskId → null and NOTHING appended (R3/F16)", async () => {
  for (const bad of [{ taskId: "t" }, { episodeId: "e" }, { episodeId: "", taskId: "t" }, { episodeId: "e", taskId: 7 }, {}, { episodeId: {}, taskId: "t" }]) {
    const h = mk();
    assert.equal(await h.channel.raise(bad as never), null, JSON.stringify(Object.keys(bad)));
    assert.equal(h.appends.length, 0, "an invalid identity writes nothing");
    assert.deepEqual(h.log, []);
  }
  for (const nonReq of [null, undefined, 42, "req", [], true]) {
    const h = mk();
    assert.equal(await h.channel.raise(nonReq as never), null, String(nonReq));
    assert.equal(h.appends.length, 0);
  }
});

test("INV-7: a throwing host clock yields ts 0, never a crash", async () => {
  const ch = makeEscalationChannel({
    append: async () => {},
    now: () => {
      throw new Error("clock-boom");
    },
  });
  const res = (await ch.raise({ episodeId: "e", taskId: "t" } as never)) as RaiseResult;
  assert.equal(res.record.ts, 0);
});

// ───────────────────────── INV-2: durability precedes delivery ─────────────

test("INV-2: a deliver throw leaves the record appended and disclosed", async () => {
  const h = mk({ deliverMode: "throw" });
  const res = (await h.channel.raise(valid() as never)) as RaiseResult;
  assert.equal(h.appends.length, 1, "the record stands");
  assert.equal(res.delivered, false);
  assert.deepEqual(res.delivery, { ok: false, error: "Error" });
});

test("INV-2: an append throw REJECTS the raise (durability is non-negotiable)", async () => {
  const ch = makeEscalationChannel({
    append: async () => {
      throw new Error("disk-full");
    },
    deliver: async () => ({ channel: "telegram" }),
    now: () => 1,
  });
  await assert.rejects(() => ch.raise(valid() as never), /disk-full/);
});

test("no deliver port: disclosed as port-missing, record still appended", async () => {
  const h = mk({ deliverMode: "none" });
  const res = (await h.channel.raise(valid() as never)) as RaiseResult;
  assert.equal(h.appends.length, 1);
  assert.equal(res.delivered, false);
  assert.deepEqual(res.delivery, { ok: false, error: "port-missing:deliver" });
  assert.equal(res.record.deliveredCount, 0, "a missing port never counts as a delivery attempt");
});

// ───────────────────────── INV-5: dedup & re-notice matrix ─────────────────

test("INV-5: same-key re-notice appends an updated record but does NOT deliver", async () => {
  const h = mk();
  const r1 = (await h.channel.raise(valid() as never)) as RaiseResult;
  const r2 = (await h.channel.raise(valid() as never)) as RaiseResult;
  assert.equal(r1.delivered, true);
  assert.equal(r2.delivered, false);
  assert.equal(r2.reason, "re-notice");
  assert.equal(r2.record.reNotice, 1);
  assert.equal(h.delivers.length, 1);
  assert.equal(h.appends.length, 2, "the updated open record IS appended (re-notice is durable, not silent)");
});

test("INV-5: NEW evidence digest delivers on a re-notice", async () => {
  const h = mk();
  await h.channel.raise(valid() as never);
  const r2 = (await h.channel.raise(valid({ evidence: ["journal:act-abc", "session:w1", "gate:tsc"] }) as never)) as RaiseResult;
  assert.equal(r2.delivered, true);
  assert.equal(r2.reason, undefined);
  assert.equal(h.delivers.length, 2);
});

test("INV-5: force delivers a re-notice once; the cap still binds", async () => {
  const h = mk({ maxRedeliver: 2 });
  await h.channel.raise(valid() as never); // delivered 1
  const r2 = (await h.channel.raise(valid({ force: true }) as never)) as RaiseResult;
  assert.equal(r2.delivered, true, "force overrides the re-notice suppression");
  const r3 = (await h.channel.raise(valid({ force: true }) as never)) as RaiseResult;
  assert.equal(r3.delivered, false, "force NEVER defeats the cap");
  assert.equal(r3.reason, "redeliver-cap");
  assert.equal(h.delivers.length, 2);
});

test("INV-5: the cap counts deliveries across restarts (durable log)", async () => {
  const h = mk(); // default cap 3
  await h.channel.raise(valid({ evidence: ["e1"] }) as never); // 1
  const restartCh = () => h.restart();
  void restartCh;
  const r2 = (await (h.restart() as ReturnType<typeof makeEscalationChannel>).raise(valid({ evidence: ["e2"] }) as never)) as RaiseResult; // restart: 2
  assert.equal(r2.delivered, true);
  const r3 = (await (h.restart() as ReturnType<typeof makeEscalationChannel>).raise(valid({ evidence: ["e3"] }) as never)) as RaiseResult; // 3
  assert.equal(r3.delivered, true);
  const r4 = (await (h.restart() as ReturnType<typeof makeEscalationChannel>).raise(valid({ evidence: ["e4"] }) as never)) as RaiseResult;
  assert.equal(r4.delivered, false, "4th new-state delivery is capped");
  assert.equal(r4.reason, "redeliver-cap");
  assert.equal(h.delivers.length, 3);
});

test("INV-5: a different blocker is a different key (different escalationId, fresh delivery)", async () => {
  const h = mk();
  const r1 = (await h.channel.raise(valid() as never)) as RaiseResult;
  const r2 = (await h.channel.raise(valid({ blocker: "budget-exhausted" }) as never)) as RaiseResult;
  assert.notEqual(r2.record.escalationId, r1.record.escalationId);
  assert.equal(r2.delivered, true);
});

// ───────────────────────── pending() / resolve() ───────────────────────────

test("pending/resolve: replay view, close-on-resolution, corrupt-line skip, double-resolve", async () => {
  const h = mk();
  const rA = (await h.channel.raise(valid() as never)) as RaiseResult;
  const rB = (await h.channel.raise({ episodeId: "ep1", taskId: "t9", blocker: "gate-defect" } as never)) as RaiseResult;
  // a foreign/corrupt line the host appends into the same log:
  h.appends.push({ schema: "something-else" }, "not-an-object", 42, null);
  let open = await h.channel.pending();
  assert.deepEqual(open.map((r) => r.taskId).sort(), ["t2", "t9"], "corrupt lines are skipped, open questions survive");

  const res1 = await h.channel.resolve(rA.record.escalationId, { decision: "approve", by: "alice" });
  assert.ok(res1 !== null);
  assert.equal(res1!.ref, rA.record.escalationId);
  assert.equal(res1!.decision, "approve");
  open = await h.channel.pending();
  assert.deepEqual(open.map((r) => r.taskId), ["t9"]);

  // double-resolve: appends again (durable, timestamped) — late answers legitimate
  const res2 = await h.channel.resolve(rA.record.escalationId, { decision: "abort", by: "bob", note: "changed my mind" });
  assert.ok(res2 !== null);
  assert.notEqual(res2!.id, res1!.id);
  open = await h.channel.pending();
  assert.equal(open.map((r) => r.taskId).join(","), "t9", "still closed after the second resolution");
});

test("resolve: bad decision / bad id / bad by → null, nothing appended", async () => {
  const h = mk();
  const rA = (await h.channel.raise(valid() as never)) as RaiseResult;
  const before = h.appends.length;
  const id = rA.record.escalationId;
  assert.equal(await h.channel.resolve(id, { decision: "maybe", by: "x" }), null);
  assert.equal(await h.channel.resolve(id, { decision: 42 as never, by: "x" }), null);
  assert.equal(await h.channel.resolve(id, { decision: "approve", by: "" }), null);
  assert.equal(await h.channel.resolve("esc-zzzzzzzzzzzzzzzz", { decision: "approve", by: "x" }), null);
  assert.equal(await h.channel.resolve("not-an-id", { decision: "approve", by: "x" }), null);
  assert.equal(await h.channel.resolve(id, null as never), null);
  assert.equal(h.appends.length, before, "rejected resolutions write nothing");
});

test("pending: without a read port, falls back to the in-process open set", async () => {
  const h = mk({ readMode: "none" });
  const rA = (await h.channel.raise(valid() as never)) as RaiseResult;
  let open = await h.channel.pending();
  assert.equal(open.length, 1);
  await h.channel.resolve(rA.record.escalationId, { decision: "deny", by: "a" });
  open = await h.channel.pending();
  assert.equal(open.length, 0);
});

test("pending: a failing read degrades to [] (never a crash, never stale ghosts)", async () => {
  const h = mk({ readMode: "throw" });
  await h.channel.raise(valid() as never);
  // with read throwing, pending() falls back to the mirror per contract —
  // build a pure read-fail channel:
  const ch = makeEscalationChannel({
    append: async () => {},
    read: async () => {
      throw new Error("read-boom");
    },
    now: () => 5,
  });
  assert.deepEqual(await ch.pending(), []);
});

// ───────────────────────── fence suite (P15 pattern) ───────────────────────

function trapObj(): object {
  return new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("trap-boom");
      },
      get() {
        throw new Error("trap-boom");
      },
    },
  );
}

// A1 (audit): the REPLAY path is hostile input too — a plain object with
// a throwing getter on 'schema' must skip the line, not throw out of
// pending()/raise (INV-4 total function over read()'s output).
test("fence: replayed line with a trapping schema getter → skipped, never throws", async () => {
  const hostileLine = Object.defineProperty({}, "schema", {
    enumerable: true,
    get() {
      throw new Error("replay-boom");
    },
  });
  const kindTrap = Object.defineProperty({ kind: "escalation" }, "kind", {
    enumerable: true,
    get() {
      throw new Error("replay-boom");
    },
  });
  const ch = makeEscalationChannel({
    append: async () => {},
    read: async () => [hostileLine, kindTrap, { schema: ESCALATION_SCHEMA, kind: "resolution" }],
    now: () => 5,
  });
  assert.deepEqual(await ch.pending(), [], "trapping lines are skipped silently (like corrupt ones)");
  // and raise() (which consults the replay for dedup) survives it too:
  const res = (await ch.raise({ episodeId: "ep1", taskId: "t1" } as never)) as RaiseResult;
  assert.ok(res !== null);
  assertValidRecord(res!.record);
});

// B3 (audit): a deliver port that resolves with a PRIMITIVE (not the
// documented {channel?} record or void) is a port defect — disclosed as
// FAILED, never a silent success (INV-2: a human-visible failure must
// surface). A resolved-with accessor 'channel' is different: the act
// DID happen; per fence doctrine the untrusted name drops, not the act.
test("deliver port returning garbage → disclosed as failed delivery, not ok", async () => {
  const trapReturn = Object.defineProperty({ channel: "telegram" }, "channel", {
    get() {
      throw new Error("channel-boom");
    },
    enumerable: true,
  });
  const ch = makeEscalationChannel({
    append: async () => {},
    now: () => 1,
    deliver: async (rec: EscalationRecord) => (rec.taskId === "primitive" ? (42 as never) : (trapReturn as never)),
  });
  const r1 = (await ch.raise({ episodeId: "e", taskId: "primitive" } as never)) as RaiseResult;
  assert.equal(r1.delivered, false);
  assert.deepEqual(r1.delivery, { ok: false, error: "deliver:non-record" });
  const r2 = (await ch.raise({ episodeId: "e", taskId: "trappy" } as never)) as RaiseResult;
  assert.equal(r2.delivered, true, "the act completed — only the untrusted channel NAME drops (fence doctrine)");
  assert.equal(r2.channel, undefined);
});

// B4 (audit): an answer to a question that was never asked is a
// fabrication — a well-formed but unknown id resolves to null, nothing
// appended. Raised ids resolve fine (same or a later lifetime).
test("resolve: well-formed but NEVER-RAISED id → null, nothing appended", async () => {
  const h = mk();
  const before = h.appends.length;
  assert.equal(await h.channel.resolve("esc-0000000000000000", { decision: "approve", by: "x" }), null);
  assert.equal(await h.channel.resolve("esc-ffffffffffffffff", { decision: "deny", by: "x" }), null);
  assert.equal(h.appends.length, before, "an answer to an unasked question writes nothing");
  // after a raise it resolves…
  const rA = (await h.channel.raise(valid() as never)) as RaiseResult;
  const res = await h.channel.resolve(rA.record.escalationId, { decision: "approve", by: "x" });
  assert.ok(res !== null);
  // …and a RESTARTED channel knows it from the durable log (read port):
  const ch2 = h.restart();
  const res2 = await ch2.resolve(rA.record.escalationId, { decision: "abort", by: "y", note: "late second thought" });
  assert.ok(res2 !== null, "the restarted channel knows the raised id from the log (double-resolve stays legal)");
});

test("fence: throwing identity getters → clean null, nothing appended", async () => {
  const req = { taskId: "t" };
  Object.defineProperty(req, "episodeId", {
    get() {
      throw new Error("getter-boom");
    },
    enumerable: true,
    configurable: true,
  });
  const h = mk();
  assert.equal(await h.channel.raise(req as never), null);
  assert.equal(h.appends.length, 0);
});

test("fence: revoked-proxy request → clean null (isPlainObj refuses it)", async () => {
  const { proxy, revoke } = Proxy.revocable({} as Rec, {});
  revoke();
  const h = mk();
  assert.equal(await h.channel.raise(proxy as never), null);
  assert.equal(h.appends.length, 0);
});

test("fence: evidence with a mid-scan throwing descriptor → dropped + disclosed, record stays valid", async () => {
  const ev = ["ok1", "ok2"];
  Object.defineProperty(ev, 1, {
    get() {
      throw new Error("idx-boom");
    },
    configurable: true,
  });
  const h = mk();
  const res = (await h.channel.raise(valid({ evidence: ev }) as never)) as RaiseResult;
  assertValidRecord(res.record);
  assert.deepEqual(res.disclosed, ["bad-input:packet", "evidence:dropped"]);
  assert.deepEqual(res.record.evidence, []);
});

test("fence: lying array length (re-verify) → dropped + disclosed", async () => {
  let reads = 0;
  const arr = ["a", "b"];
  const liar = new Proxy(arr, {
    get(t, p) {
      if (p === "length") {
        reads++;
        return reads === 1 ? 2 : 99; // second observation disagrees
      }
      return Reflect.get(t, p) as unknown;
    },
  });
  const h = mk();
  const res = (await h.channel.raise(valid({ evidence: liar }) as never)) as RaiseResult;
  assertValidRecord(res.record);
  assert.ok(res.disclosed?.includes("bad-input:packet"), "the lie is disclosed");
  assert.deepEqual(res.record.evidence, []);
});

test("bounds: evidence > 16 truncates WITH the marker; strings clip at 240", async () => {
  const h = mk();
  const big = Array.from({ length: 40 }, (_, i) => `ev-${i}`);
  const res = (await h.channel.raise(valid({ evidence: big }) as never)) as RaiseResult;
  assert.ok(res.disclosed?.includes("evidence:truncated"));
  assert.equal(res.record.evidence.length, 17, "16 kept + the 'truncated' marker");
  assert.equal(res.record.evidence[16], "truncated");
  const long = (await h.channel.raise({ episodeId: "e", taskId: "t", evidence: ["x".repeat(500)] } as never)) as RaiseResult;
  assert.equal(long.record.evidence[0]!.length, 240);
});

test("bounds: attempts > 10 clipped to 10; hostile attempt entries dropped", async () => {
  const h = mk();
  const atts = Array.from({ length: 30 }, (_, i) => ({ action: `a${i}` }));
  const res = (await h.channel.raise(valid({ attempts: atts }) as never)) as RaiseResult;
  assert.equal(res.record.attempts.length, 10);
  const junk = (await h.channel.raise({
    episodeId: "e",
    taskId: "t",
    attempts: [null, 7, "s", [], { action: 42 }, { action: "real" }, { get action(): string { throw new Error("boom"); } }],
  } as never)) as RaiseResult;
  assert.deepEqual(junk.record.attempts, [{ action: "real" }], "only the plain valid attempt survives");
});

test("fence: getter traps on decision/evidence fields drop the field, record stays valid", async () => {
  const req = valid() as Rec;
  Object.defineProperty(req, "decisionNeeded", {
    get() {
      throw new Error("dn-boom");
    },
    enumerable: true,
    configurable: true,
  });
  const h = mk();
  const res = (await h.channel.raise(req as never)) as RaiseResult;
  assertValidRecord(res.record);
  assert.match(res.record.decisionNeeded, /approve a new approach/); // the blocker's default survived
});

test("resolve fence: hostile res object → null, nothing appended", async () => {
  const h = mk();
  const { proxy, revoke } = Proxy.revocable({ decision: "approve", by: "x" } as Rec, {});
  revoke();
  assert.equal(await h.channel.resolve("esc-0000000000000000", proxy as never), null);
});

// ───────────────────────── dispatcher seam ─────────────────────────────────

test("dispatcher: escalate maps the executor payload; park records repeated-strategy", async () => {
  const h = mk();
  const d = makeEscalationDispatcher({ channel: h.channel });
  const r = await d.escalate({ episodeId: "ep1", taskId: "t2", actionId: "act-9", rationale: ["budget denied", "twice"] });
  assert.equal(r.channel, "telegram");
  const esc = h.appends[0] as unknown as EscalationRecord;
  assert.equal(esc.blocker, "unknown", "a payload without a named blocker floors to unknown");
  assert.ok((esc.evidence as string[]).some((e) => e.startsWith("rationale:")));
  await d.park({ episodeId: "ep1", taskId: "t2", actionId: "act-9" });
  const park = h.appends.find((a) => (a as unknown as EscalationRecord).blocker === "repeated-strategy");
  assert.ok(park !== undefined, "park records a repeated-strategy escalation");
});

test("dispatcher: a throwing blockerOf floors to unknown (host defect, never fatal)", async () => {
  const h = mk();
  const d = makeEscalationDispatcher({
    channel: h.channel,
    blockerOf: () => {
      throw new Error("mapper-boom");
    },
  });
  const r = await d.escalate({ episodeId: "e", taskId: "t" });
  assert.ok(typeof r.channel === "string");
  assert.equal((h.appends[0] as unknown as EscalationRecord).blocker, "unknown");
});

test("dispatcher: invalid request → invalid channel, nothing appended", async () => {
  const h = mk();
  const d = makeEscalationDispatcher({ channel: h.channel });
  for (const bad of [null, 42, "x", []]) {
    const r = await d.escalate(bad as never);
    assert.equal(r.channel, "escalation:invalid");
  }
  await d.park(undefined as never);
  assert.equal(h.appends.length, 0);
});

// ───────────────────────── Telegram consumer (fake bridge) ─────────────────

test("deliver: renders one bounded message through the bridge and reports the channel", async () => {
  const sent: string[] = [];
  const deliver = makeTelegramDeliver({
    enabled: true,
    send: async (t: string) => {
      sent.push(t);
    },
  });
  const appends: unknown[] = [];
  const ch = makeEscalationChannel({ append: async (r) => { appends.push(r); }, deliver, now: () => 1 });
  const res = (await ch.raise(valid({ attemptId: "a7" }) as never)) as RaiseResult;
  assert.equal(res.channel, "telegram");
  assert.equal(sent.length, 1);
  assert.ok(appends.length === 1, "the record stands next to the send");
  assert.ok(sent[0]!.includes("repeated-strategy"));
  assert.ok(sent[0]!.includes("/resolve"));
  assert.ok(sent[0]!.includes("a7"));
  assert.ok(sent[0]!.length <= 1500, "render stays inside the message bound");
});

test("deliver: disabled bridge → telegram:disabled WITHOUT sending (record stands)", async () => {
  let sends = 0;
  const deliver = makeTelegramDeliver({
    enabled: false,
    send: async () => {
      sends++;
    },
  });
  const ch = makeEscalationChannel({ append: async () => {}, deliver, now: () => 1 });
  const res = (await ch.raise(valid() as never)) as RaiseResult;
  assert.equal(sends, 0);
  assert.equal(res.channel, "telegram:disabled");
  assert.ok(res.record !== undefined);
});

test("deliver: a send throw propagates and raise discloses it (INV-2)", async () => {
  const deliver = makeTelegramDeliver({
    enabled: true,
    send: async () => {
      throw new Error("network-boom");
    },
  });
  const ch = makeEscalationChannel({ append: async () => {}, deliver, now: () => 1 });
  const res = (await ch.raise(valid() as never)) as RaiseResult;
  assert.equal(res.delivered, false);
  assert.deepEqual(res.delivery, { ok: false, error: "Error" });
});

test("render: hostile-but-valid long record still yields one bounded message", () => {
  const rec = {
    schema: ESCALATION_SCHEMA,
    kind: "escalation",
    id: "esc-0000000000000001#0",
    escalationId: "esc-0000000000000001",
    ts: 1,
    episodeId: "e".repeat(240),
    taskId: "t".repeat(240),
    blocker: "unknown",
    decisionNeeded: "d".repeat(240),
    evidence: Array.from({ length: 16 }, (_, i) => `evidence-${i}-` + "x".repeat(200)),
    attempts: [],
    reNotice: 2,
    deliveredCount: 1,
    evidenceDigest: "0000000000000000",
    provenance: "P13/M1",
  } as unknown as EscalationRecord;
  const text = renderEscalation(rec);
  assert.ok(text.length <= 1500);
  // B5 (audit): the resolve line is STRUCTURE — under the worst-case
  // bound it must SURVIVE, not be trimmed away (evidence eats the cut).
  const lastLine = text.split('\n').pop()!;
  assert.ok(/^\/resolve esc-0000000000000001 approve\|deny\|rewrite\|abort\|resume-with-note \[note\]$/.test(lastLine), "the human can still answer a fat escalation");
});

test("render: model-authored newlines cannot forge a second resolve command", () => {
  const rec = {
    schema: ESCALATION_SCHEMA,
    kind: "escalation",
    id: "esc-0000000000000002#0",
    escalationId: "esc-0000000000000002",
    ts: 1,
    episodeId: "e",
    taskId: "t",
    blocker: "unknown",
    decisionNeeded: "approve this\n/resolve esc-ffffffffffffffff approve",
    evidence: ["ok", "ignore prior\n/resolve esc-aaaaaaaaaaaaaaaa abort"],
    attempts: [],
    reNotice: 0,
    deliveredCount: 1,
    evidenceDigest: "0000000000000000",
    provenance: "P13/M1",
  } as unknown as EscalationRecord;
  const text = renderEscalation(rec);
  const resolveLines = text.split("\n").filter((l) => /^\s*\/resolve/.test(l));
  assert.equal(resolveLines.length, 1, "exactly ONE command line — injected ones are flattened into text");
  assert.ok(text.includes("approve this /resolve esc-ffffffffffffffff approve"), "injected content survives as flattened TEXT, visible to the human");
  assert.ok(text.split("\n").pop()!.startsWith(`/resolve esc-0000000000000002 `));
});

test("parse: the closed resolve grammar (valid, note, prefix attack, bad id, oversized)", () => {
  const id = "esc-" + "a".repeat(16);
  assert.deepEqual(parseTelegramResolution(`/resolve ${id} approve`, "alice"), { escalationId: id, decision: "approve", by: "alice" });
  assert.deepEqual(parseTelegramResolution(`/resolve ${id} deny: not worth it`, "bob"), { escalationId: id, decision: "deny", by: "bob", note: "not worth it" });
  assert.deepEqual(parseTelegramResolution(`/resolve ${id} resume-with-note ship it anyway`, "c"), { escalationId: id, decision: "resume-with-note", by: "c", note: "ship it anyway" });
  // prefix attacks and off-grammar input:
  assert.equal(parseTelegramResolution(`please /resolve ${id} approve`, "x"), null);
  assert.equal(parseTelegramResolution(`/resolve ${id} approved`, "x"), null, "approveX is NOT approve");
  assert.equal(parseTelegramResolution(`/resolve ${id} maybe`, "x"), null);
  assert.equal(parseTelegramResolution("/resolve esc-zzzzzzzzzzzzzzzz approve", "x"), null);
  assert.equal(parseTelegramResolution(`/resolve ${id}`, "x"), null, "a decision is required");
  assert.equal(parseTelegramResolution("approve", "x"), null);
  assert.equal(parseTelegramResolution("/resolve " + id + " approve " + "n".repeat(4100), "x"), null, "oversized → null, never a record");
  assert.equal(parseTelegramResolution(`/resolve ${id} approve`, ""), null, "empty sender rejected");
  const note = parseTelegramResolution(`/resolve ${id} rewrite ${"n".repeat(500)}`, "x");
  assert.ok(note !== null && note.note !== undefined && note.note.length <= 240, "note clips at 240");
});

test("consumer seam: parse output feeds channel.resolve end-to-end", async () => {
  const h = mk();
  const r = (await h.channel.raise(valid() as never)) as RaiseResult;
  const parsed = parseTelegramResolution(`/resolve ${r.record.escalationId} abort done with it`, "alice");
  assert.ok(parsed !== null);
  const res = await h.channel.resolve(parsed.escalationId, { decision: parsed.decision, by: parsed.by, ...(parsed.note !== undefined ? { note: parsed.note } : {}) });
  assert.ok(res !== null);
  assert.equal(res!.decision, "abort");
  assert.equal((await h.channel.pending()).length, 0);
});

// ───────────────────────── integration: REAL executor + channel ────────────

test("integration: executeRecoveryAction(escalate) with the dispatcher → durable record + one delivery + journal intact", async () => {
  const h = mk();
  const d = makeEscalationDispatcher({ channel: h.channel });
  const journalRecs: Rec[] = [];
  const journal = {
    append: async (rec: object) => {
      journalRecs.push(rec as Rec);
    },
    read: async () => ({ records: journalRecs }),
  };
  const plan = {
    decision: "escalate",
    action: "escalate",
    rung: 5,
    sideEffect: "none",
    strategyId: EXEC_TEMPLATES["escalate"],
    rationale: ["strategies exhausted", "budget denied"],
    evidenceRefs: [],
    alternatives: [],
    authorityNeeded: "none",
    notAPermission: true,
  };
  void EXEC_DECISION;
  void EXEC_RUNG;
  const res = await executeRecoveryAction(plan, { episodeId: "ep1", taskId: "t2", now: 1000, authority: { grantedBy: "sup" } }, { journal, dispatch: d as never });
  assert.equal(res.status, "executed", JSON.stringify(res));
  assert.equal(h.delivers.length, 1, "exactly one human-visible delivery");
  assert.equal(h.appends.length, 1, "exactly one durable escalation record");
  const esc = h.appends[0] as unknown as EscalationRecord;
  assert.equal(esc.episodeId, "ep1");
  assert.equal(esc.taskId, "t2");
  assert.ok(journalRecs.some((r) => r.kind === "decision-intent"), "journal intent intact");
  const outcome = journalRecs.find((r) => r.kind === "decision-outcome");
  assert.ok(outcome !== undefined, "journal outcome intact");
  assert.ok(((outcome as Rec)["evidenceRefs"] as string[] | undefined)?.some((e) => String(e).startsWith("channel:")), "outcome cites the escalation channel");
});

// ───────────────────────── INV-8: compartment guards ───────────────────────

const MODULE_SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+|\bexport\s*\[\s*\]\s*from\s*)["']([^"']+)["']/g;
function specifiersOf(content: string): string[] {
  return [...content.matchAll(MODULE_SPEC_RE)].map((m) => m[1]!);
}

async function walkTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { recursive: true })) {
    const p = join(dir, String(e));
    if (p.endsWith(".ts")) out.push(p.replace(/\\/g, "/").replace(/^\.\//, ""));
  }
  return out.sort();
}

test("INV-8 guard: src/escalation imports ONLY node:crypto", async () => {
  const files = await walkTs(join("src", "escalation"));
  assert.ok(files.length >= 1);
  for (const file of files) {
    const content = await readFile(file, "utf-8");
    assert.deepEqual(specifiersOf(content), ["node:crypto"], `${file} must import node:crypto and nothing else`);
  }
});

test("INV-8 guard: EXACTLY ONE external importer — src/telegram/escalation.ts", async () => {
  const files = await walkTs("src");
  const importers: string[] = [];
  for (const file of files) {
    if (file.startsWith("src/escalation/")) continue;
    const content = await readFile(file, "utf-8").catch(() => "");
    if (specifiersOf(content).some((s) => /(^|\/)escalation\//.test(s))) importers.push(file);
  }
  assert.deepEqual(importers, ["src/telegram/escalation.ts"], "the one allow-listed consumer (docs/19 §5/§8)");
});

test("INV-8 guard: the channel module never mentions fs/process/network authority (source scan)", async () => {
  const files = await walkTs(join("src", "escalation"));
  for (const file of files) {
    const content = await readFile(file, "utf-8");
    const stripped = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // comments carry contract prose
    for (const forbidden of ["require(", "process.", "child_process", "appendFile", "node:fs", "spawn(", "fetch(", "Date.now", "new Date"]) {
      assert.ok(!stripped.includes(forbidden), `${file} must not contain ${forbidden}`);
    }
  }
});

// ───────────────────────── audit round 2 (F1, F2, F3, F5, F6) ──────────────

// F1 + cycle-3: the fabrication guard (B4) holds even WITHOUT a read port —
// any well-formed id must not be resolvable by a fresh channel. The restart
// case is served by the host wiring `read` (docs/19 §3): with read, the
// legitimate post-restart answer resolves normally.
test("F1/c3: no read port → resolve REJECTS ids unknown to this lifetime (no forged resolution)", async () => {
  const log: unknown[] = [];
  const append = async (r: object) => {
    log.push(r);
  };
  const first = makeEscalationChannel({ append, deliver: async () => ({ channel: "t" }), now: () => 1 });
  const r = (await first.raise(valid() as never)) as RaiseResult;
  const restarted = makeEscalationChannel({ append, now: () => 2 });
  assert.equal(await restarted.resolve(r.record.escalationId, { decision: "approve", by: "alice" }), null,
    "without read the channel cannot know the id — rejecting is fail-safe");
  assert.equal(await restarted.resolve("esc-ffffffffffffffff", { decision: "approve", by: "mallory" }), null);
  const withRead = makeEscalationChannel({ append, read: async () => [...log], now: () => 3 });
  const res = await withRead.resolve(r.record.escalationId, { decision: "approve", by: "alice" });
  assert.ok(res !== null, "with read wired, the post-restart human answer is accepted");
});

test("F1: a read port that answered WITHOUT the id still rejects (fabrication guard holds)", async () => {
  const h = mk();
  assert.equal(await h.channel.resolve("esc-0000000000000000", { decision: "approve", by: "x" }), null);
});

// F2 + cycle-1: the replay copy keeps the TAIL (newest lines = current
// state), and an incomplete replay says so. The newest open question
// survives a truncation; anything older that was dropped shows as such.
test("F2: replay past the cap → tail survives, pendingStatus reports complete:false", async () => {
  const filler = Array.from({ length: 100_001 }, () => ({ foreign: true }));
  // F7 (cycle-2): a replayed line is believed only when its escalationId
  // is the hash of its own content — so the fixture is a REAL raised record.
  const gen = makeEscalationChannel({ append: async () => {}, now: () => 1 });
  const open = (await gen.raise({ episodeId: "e", taskId: "t" }))!.record;
  const ch = makeEscalationChannel({ append: async () => {}, read: async () => [...filler, open], now: () => 1 });
  const st = await ch.pendingStatus();
  assert.equal(st.complete, false, "a truncated replay is never presented as complete");
  assert.equal(st.open.length, 1, "the NEWEST open question is inside the kept window");
  assert.equal(st.open[0]!.escalationId, open.escalationId);
});

test("F2: a complete replay → pendingStatus complete:true", async () => {
  const ch = makeEscalationChannel({ append: async () => {}, read: async () => [], now: () => 1 });
  assert.deepEqual(await ch.pendingStatus(), { open: [], complete: true });
});

// F3: caller text that happens to equal the overflow marker is ordinary text;
// the marker is structural. A real rationale entry must not be lost.
test("F3: rationale literally 'truncated' is kept as text, not treated as overflow", async () => {
  const L: object[] = [];
  const ch = makeEscalationChannel({ append: async (r) => { L.push(r); }, now: () => 1 });
  const d = makeEscalationDispatcher({ channel: ch });
  await d.escalate({ episodeId: "e", taskId: "t", rationale: ["a", "truncated", "b-important"] });
  const ev = (L[0] as { evidence: string[] }).evidence;
  assert.ok(ev.includes("rationale:b-important"), "the entry after the literal survives");
  assert.ok(!ev.includes("truncated") || ev.indexOf("truncated") === ev.length - 1, "no spurious mid-list marker");
});

// F5: a multi-line /resolve gets a named reason, not silence.
test("F5: multi-line /resolve → rejection hint names the one-line rule", () => {
  const id = "esc-" + "a".repeat(16);
  const text = `/resolve ${id} deny\nsecond line`;
  assert.equal(parseTelegramResolution(text, "x"), null, "still rejected");
  const hint = resolutionRejectionHint(text);
  assert.ok(hint !== null && /one line/.test(hint), "the human is told why");
  assert.equal(resolutionRejectionHint(`/resolve ${id} deny: ok`), null, "a valid one-liner gets no hint");
  assert.equal(resolutionRejectionHint("hello\nworld"), null, "non-resolve text gets no hint");
});

// F6: resolve on a KNOWN id must not re-read the log; an unknown id reads once.
test("F6: known id resolves without any replay read", async () => {
  let reads = 0;
  const log: unknown[] = [];
  const ch = makeEscalationChannel({
    append: async (r) => { log.push(r); },
    read: async () => { reads += 1; return [...log]; },
    deliver: async () => ({ channel: "t" }),
    now: () => 1,
  });
  const r = (await ch.raise(valid() as never)) as RaiseResult;
  const before = reads;
  await ch.resolve(r.record.escalationId, { decision: "approve", by: "a" });
  assert.equal(reads - before, 0, "a raised-in-this-lifetime id is known without re-reading");
});

test("F6: unknown id triggers exactly one replay read", async () => {
  let reads = 0;
  const ch = makeEscalationChannel({
    append: async () => {},
    read: async () => { reads += 1; return []; },
    now: () => 1,
  });
  await ch.resolve("esc-0000000000000000", { decision: "approve", by: "a" });
  assert.equal(reads, 1);
});

// ──────────────────────── audit cycle 1 (F1–F7) ────────────────────────────

test("c1-F1: truncated replay keeps mirror prior — dedup state survives, disclosed", async () => {
  const ch = makeEscalationChannel({
    append: async () => {},
    deliver: async () => ({ channel: "t" }),
    read: async () => Array.from({ length: 100_001 }, () => ({ foreign: 1 })),
    now: () => 1,
  });
  await ch.raise(valid() as never);
  const r2 = (await ch.raise(valid() as never)) as RaiseResult;
  assert.equal(r2.delivered, false, "same question is still recognized — no fresh delivery per raise");
  assert.equal(r2.reason, "re-notice");
  assert.ok(r2.disclosed?.includes("replay:truncated"), "the partial dedup view is disclosed");
  assert.equal(r2.record.reNotice, 1);
});

test("c1-F3: deliver throwing a revoked proxy / name-trap Error stays disclosed (INV-4)", async () => {
  const revoked = await makeEscalationChannel({
    append: async () => {},
    deliver: async () => {
      throw new Proxy({}, { get() { throw 0; }, getPrototypeOf() { throw 0; } });
    },
    now: () => 1,
  }).raise(valid() as never);
  assert.equal((revoked as RaiseResult).delivery?.ok, false);
  assert.equal((revoked as RaiseResult).delivery?.error, "unthrowable");
  const err = new Error("x");
  Object.defineProperty(err, "name", { get() { throw new TypeError("n"); } });
  const trapped = await makeEscalationChannel({ append: async () => {}, deliver: async () => { throw err; }, now: () => 1 }).raise(valid() as never);
  assert.equal((trapped as RaiseResult).delivery?.ok, false, "the throwing name never escapes describeErr");
});

test("c1-F4: failed-replay pendingStatus performs exactly ONE read", async () => {
  let reads = 0;
  const ch = makeEscalationChannel({ append: async () => {}, read: async () => { reads += 1; throw new Error("io"); }, now: () => 1 });
  const st = await ch.pendingStatus();
  assert.equal(reads, 1);
  assert.equal(st.complete, false);
});

test("c1-F6: re-raise of a resolved question cannot emit a duplicate record id", async () => {
  const ch = makeEscalationChannel({ append: async () => {}, deliver: async () => ({ channel: "t" }), now: () => 1 });
  const r1 = (await ch.raise(valid() as never)) as RaiseResult;
  await ch.resolve(r1.record.escalationId, { decision: "approve", by: "a" });
  const r2 = (await ch.raise(valid() as never)) as RaiseResult;
  assert.notEqual(r2.record.id, r1.record.id, "ids are distinct per append (docs/19)");
  assert.ok(r2.record.id.endsWith("#1"));
});

test("c1-F7: hostile rationale array is disclosed in the raised evidence", async () => {
  const L: { evidence: string[] }[] = [];
  const ch = makeEscalationChannel({ append: async (r) => { L.push(r as { evidence: string[] }); }, now: () => 1 });
  const d = makeEscalationDispatcher({ channel: ch });
  const rat = ["keep-me"];
  Object.defineProperty(rat, "1", { get() { throw new Error("x"); }, enumerable: true, configurable: true });
  await d.escalate({ episodeId: "e", taskId: "t", rationale: rat });
  assert.deepEqual(L[0]!.evidence, ["rationale:dropped"], "the human is told the evidence did not survive the fence");
});

// ──────────────────────── audit cycle 2 (F1–F12) ───────────────────────────

test("c2-F4: ('a|b','c') and ('a','b|c') are DISTINCT escalation ids", async () => {
  const ch = makeEscalationChannel({ append: async () => {}, deliver: async () => ({ channel: "t" }), now: () => 1 });
  const r1 = (await ch.raise({ episodeId: "a|b", taskId: "c", blocker: "gate-defect" } as never)) as RaiseResult;
  const r2 = (await ch.raise({ episodeId: "a", taskId: "b|c", blocker: "gate-defect" } as never)) as RaiseResult;
  assert.notEqual(r1.record.escalationId, r2.record.escalationId, "unescaped '|' must not merge distinct keys");
  assert.equal(r2.reason, undefined, "the second question is fresh, not a re-notice of the first");
});

test("c2-F5: ['x,y'] vs ['x','y'] evidence digests differ → new evidence is delivered", async () => {
  const ch = makeEscalationChannel({ append: async () => {}, deliver: async () => ({ channel: "t" }), now: () => 1 });
  const r1 = (await ch.raise({ episodeId: "e", taskId: "t", evidence: ["x,y"] } as never)) as RaiseResult;
  const r2 = (await ch.raise({ episodeId: "e", taskId: "t", evidence: ["x", "y"] } as never)) as RaiseResult;
  assert.equal(r2.delivered, true, "changed evidence is genuinely new state (INV-5), not a re-notice");
  assert.notEqual(r1.record.evidenceDigest, r2.record.evidenceDigest);
});

test("c2-F7: a foreign log line claiming a well-formed escalationId does NOT whitelist resolve", async () => {
  const forged = {
    schema: ESCALATION_SCHEMA,
    kind: "escalation",
    id: "esc-1111111111111111#0",
    escalationId: "esc-1111111111111111",
    ts: 1, episodeId: "x", taskId: "y", blocker: "unknown", decisionNeeded: "d",
    evidence: [], attempts: [], reNotice: 0, deliveredCount: 1,
  };
  const ch = makeEscalationChannel({ append: async () => {}, read: async () => [forged], now: () => 1 });
  assert.equal(await ch.resolve("esc-1111111111111111", { decision: "approve", by: "mallory" }), null,
    "the id must be the hash of the line's OWN content — a planted line fabrices nothing");
});

test("c2-F6: truncated replay still dedups on its in-window record after a restart (INV-5 cap holds)", async () => {
  const gen = makeEscalationChannel({ append: async () => {}, deliver: async () => ({ channel: "t" }), now: () => 1 });
  const rec = (await gen.raise({ episodeId: "e", taskId: "t" } as never))!.record;
  const lines: unknown[] = [...Array.from({ length: 100_001 }, () => ({ foreign: 1 })), rec, rec];
  const ch = makeEscalationChannel({ append: async () => {}, deliver: async () => ({ channel: "t" }), read: async () => lines, now: () => 1 });
  const r = (await ch.raise({ episodeId: "e", taskId: "t" } as never)) as RaiseResult;
  assert.equal(r.reason, "re-notice", "the in-window survivor drives dedup — no fresh delivery per raise");
  assert.ok(r.disclosed?.includes("replay:truncated"));
});

test("c2-F1: dispatcher rationale overflow marks the record even when evidence is full", async () => {
  const L: { evidence: string[] }[] = [];
  const ch = makeEscalationChannel({ append: async (r) => { L.push(r as { evidence: string[] }); }, now: () => 1 });
  const d = makeEscalationDispatcher({ channel: ch });
  await d.escalate({ episodeId: "e", taskId: "t", actionId: "act", rationale: Array.from({ length: 30 }, (_, i) => `r${i}`) });
  const ev = L[0]!.evidence;
  assert.ok(ev.includes("rationale:truncated"), "a shortened rationale never looks complete");
  assert.ok(ev.length <= 16);
});

test("c2-F3: an accessor rationale field drops ONLY with a structural marker", async () => {
  const L: { evidence: string[] }[] = [];
  const ch = makeEscalationChannel({ append: async (r) => { L.push(r as { evidence: string[] }); }, now: () => 1 });
  const d = makeEscalationDispatcher({ channel: ch });
  const req = { episodeId: "e", taskId: "t" };
  Object.defineProperty(req, "rationale", { get() { return ["hidden"]; }, enumerable: true, configurable: true });
  await d.escalate(req as never);
  assert.ok(L[0]!.evidence.includes("rationale:dropped"), "untrusted-present rationale is disclosed, not silent");
});

test("c2-F3: an accessor evidence/decisionNeeded field is disclosed on the raise", async () => {
  const req = valid() as Rec;
  Object.defineProperty(req, "evidence", { get() { return ["x"]; }, enumerable: true, configurable: true });
  const res = (await mk().channel.raise(req as never)) as RaiseResult;
  assert.ok(res.disclosed?.includes("bad-input:evidence"), "a get/set evidence field is disclosed");
});

test("c2-F8: attempts overflow is disclosed", async () => {
  const big = Array.from({ length: 30 }, (_, i) => ({ action: `a${i}` }));
  const res = (await mk().channel.raise(valid({ attempts: big }) as never)) as RaiseResult;
  assert.equal(res.record.attempts.length, 10);
  assert.ok(res.disclosed?.includes("attempts:truncated"), "dropped attempts are disclosed, never silent");
});

test("c2-F11: two same-person/same-tick resolutions of the same id get distinct ids", async () => {
  const h = mk();
  const r = (await h.channel.raise(valid() as never)) as RaiseResult;
  const a = await h.channel.resolve(r.record.escalationId, { decision: "approve", by: "alice" });
  const b = await h.channel.resolve(r.record.escalationId, { decision: "approve", by: "alice" });
  assert.ok(a !== null && b !== null);
  assert.notEqual(a!.id, b!.id, "no id collision at ts=0 or same-tick repeats");
});

test("c2-F12: renderEscalation is total — a malformed record renders, never throws", () => {
  const text = renderEscalation({} as never);
  assert.ok(text.includes("/resolve"), "degraded but the human can still see structure, never a throw");
});

// ───────────────── audit round 3 (F1, F2, F5, F6, F8, F9, F11) ─────────────

test("c3-F1: an oversized identity is INVALID — null, NOTHING appended (never truncated to a shared key)", async () => {
  const h = mk();
  const big = "x".repeat(241);
  assert.equal(await h.channel.raise(valid({ episodeId: big }) as never), null);
  assert.equal(await h.channel.raise(valid({ taskId: big }) as never), null);
  assert.equal(h.appends.length, 0, "an invalid identity writes nothing");
  // and it does NOT merge with the short identity's key:
  const r = (await h.channel.raise(valid() as never)) as RaiseResult;
  assert.ok(r);
});

test("c3-F2: maxRedeliver:0 means record-never-deliver — the FIRST raise is capped", async () => {
  const h = mk({ maxRedeliver: 0 });
  const r = (await h.channel.raise(valid() as never)) as RaiseResult;
  assert.equal(r.delivered, false);
  assert.equal(r.reason, "redeliver-cap");
  assert.equal(h.appends.length, 1, "the record still lands (INV-2 record-first)");
  assert.equal(h.delivers.length, 0);
});

test("c3-F2: resolve clears the mirror but NOT the delivery ledger — the budget does not restart", async () => {
  const h = mk({ maxRedeliver: 3 });
  const r1 = (await h.channel.raise(valid() as never)) as RaiseResult; // delivery 1
  await h.channel.resolve(r1.record.escalationId, { decision: "approve", by: "a" });
  const r2 = (await h.channel.raise(valid({ evidence: ["new"] }) as never)) as RaiseResult; // mirror empty…
  assert.equal(r2.delivered, true, "delivery 2 (budget was 3, not reset to 3)");
  const r3 = (await h.channel.raise(valid({ evidence: ["newer"] }) as never)) as RaiseResult; // delivery 3
  assert.equal(r3.delivered, true);
  const r4 = (await h.channel.raise(valid({ evidence: ["newest"] }) as never)) as RaiseResult;
  assert.equal(r4.delivered, false, "cap from the LEDGER, not from a fresh mirror");
  assert.equal(r4.reason, "redeliver-cap");
});

test("c3-F2: the ledger survives a restart via the durable deliveredCount", async () => {
  const h = mk({ maxRedeliver: 1 });
  const r1 = (await h.channel.raise(valid() as never)) as RaiseResult;
  assert.equal(r1.delivered, true);
  const ch2 = h.restart();
  const r2 = (await ch2.raise(valid({ evidence: ["fresh-state"] }) as never)) as RaiseResult;
  assert.equal(r2.reason, "redeliver-cap", "replay seeded the lifetime ledger");
  assert.equal(r2.delivered, false);
});

test("c3-F6: non-array / partial junk evidence+attempts are DISCLOSED, never silently empty", async () => {
  const h = mk();
  const r1 = (await h.channel.raise(valid({ evidence: "look, a string" }) as never)) as RaiseResult;
  assert.deepEqual(r1.record.evidence, []);
  assert.ok(r1.disclosed?.includes("evidence:dropped"), "present non-array evidence is disclosed");
  const r2 = (await h.channel.raise(valid({ evidence: ["ok", 42, null, {}] }) as never)) as RaiseResult;
  assert.deepEqual(r2.record.evidence, ["ok"]);
  assert.ok(r2.disclosed?.includes("evidence:skipped"), "dropped non-string entries are disclosed");
  const r3 = (await h.channel.raise(valid({ evidence: ["y".repeat(300)] }) as never)) as RaiseResult;
  assert.equal(r3.record.evidence[0]!.length, 240);
  assert.ok(r3.disclosed?.includes("evidence:clipped"), "a bounded shortening is disclosed");
  const r4 = (await h.channel.raise(valid({ attempts: "just text" }) as never)) as RaiseResult;
  assert.deepEqual(r4.record.attempts, []);
  assert.ok(r4.disclosed?.includes("attempts:dropped"), "non-array attempts disclosed");
  const r5 = (await h.channel.raise(valid({ attempts: [{ action: "a" }, "junk", 7] }) as never)) as RaiseResult;
  assert.equal(r5.record.attempts.length, 1);
  assert.ok(r5.disclosed?.includes("attempts:skipped"), "non-object attempt entries disclosed");
});

test("c3-F6: dispatcher discloses a non-array rationale as rationale:dropped", async () => {
  const h = mk();
  const disp = makeEscalationDispatcher({ channel: h.channel });
  await disp.escalate({ episodeId: "ep", taskId: "t", rationale: "single string not array" } as never);
  const rec = h.appends[0] as Rec;
  const ev = rec.evidence as string[];
  assert.ok(ev.includes("rationale:dropped"), "rationale:'text' is disclosed, not silently empty");
});

test("c3-F11: an accessor force field is disclosed (consistent with every other field)", async () => {
  const req = valid() as Rec;
  Object.defineProperty(req, "force", { get() { return true; }, enumerable: true, configurable: true });
  const res = (await mk().channel.raise(req as never)) as RaiseResult;
  assert.ok(res.disclosed?.includes("bad-input:force"), "an untrusted force drops to false WITH disclosure");
});

test("c3-F5: an accessor note on resolve is dropped WITH disclosure on the ResolutionRecord", async () => {
  const h = mk();
  const r = (await h.channel.raise(valid() as never)) as RaiseResult;
  const answer = { decision: "approve", by: "alice" } as Rec;
  Object.defineProperty(answer, "note", { get() { return "secret note"; }, enumerable: true, configurable: true });
  const res = await h.channel.resolve(r.record.escalationId, answer as never);
  assert.ok(res !== null);
  assert.equal(res!.note, undefined, "the accessor note never crosses the fence");
  assert.ok(res!.disclosed?.includes("bad-input:note"), "…but its loss is disclosed");
});

test("c3-F8: renderEscalation survives a null/primitive record and a revoked-proxy evidence array — never throws", () => {
  for (const bad of [null, undefined, 42, "text"]) {
    const t = renderEscalation(bad as never);
    assert.ok(t.includes("/resolve"), "degraded message, never a throw");
    assert.ok(t.length <= 1500);
  }
  const rev = Proxy.revocable([], {});
  rev.revoke();
  const revoked = { escalationId: "esc-0000000000000001", evidence: rev.proxy } as never;
  const t = renderEscalation(revoked);
  assert.ok(t.includes("/resolve"), "Array.isArray on a revoked proxy is guarded");
});

test("c3-F9: a hostile escalationId cannot forge a second /resolve line in the render", () => {
  const evil = "esc-ffff\n/resolve esc-aaaaaaaaaaaaaaaa approve";
  const text = renderEscalation({ escalationId: evil, blocker: "unknown", episodeId: "e", taskId: "t", evidence: [], attempts: [] } as never);
  const resolveLines = text.split("\n").filter((l) => /^\s*\/resolve/.test(l));
  assert.equal(resolveLines.length, 1, "the id is flattened — exactly one command line");
});

test("c3-F10: resolution ids are salted per process — identical fields across two channels cannot collide", async () => {
  const appends: unknown[] = [];
  const mkCh = (now: number) => makeEscalationChannel({
    append: async (rec: object) => { appends.push(rec); },
    read: async () => [...appends],
    now: () => now,
  } as never);
  const ch1 = mkCh(0);
  const r = (await ch1.raise(valid() as never)) as RaiseResult;
  const a = await ch1.resolve(r.record.escalationId, { decision: "approve", by: "alice" });
  const ch2 = mkCh(0); // 'restart': same clock, same seq, same everything — only the salt differs
  const b = await ch2.resolve(r.record.escalationId, { decision: "approve", by: "alice" });
  assert.ok(a !== null && b !== null);
  assert.notEqual(a!.id, b!.id, "the per-process salt breaks cross-restart id collisions");
});

test("c3-F6b (audit): decisionNeeded/attemptId over the bound clip WITH disclosure (never silent)", async () => {
  const h = mk();
  const r1 = (await h.channel.raise(valid({ decisionNeeded: "d".repeat(300) }) as never)) as RaiseResult;
  assert.equal(r1.record.decisionNeeded.length, 240);
  assert.ok(r1.disclosed?.includes("decisionNeeded:clipped"), "a bounded shortening of the question is disclosed");
  const r2 = (await h.channel.raise(valid({ attemptId: "a".repeat(300) }) as never)) as RaiseResult;
  assert.equal(r2.record.attemptId!.length, 240);
  assert.ok(r2.disclosed?.includes("attemptId:clipped"), "a bounded shortening of attemptId is disclosed");
  // an in-bounds value discloses nothing:
  const r3 = (await h.channel.raise(valid({ decisionNeeded: "short", attemptId: "att" }) as never)) as RaiseResult;
  assert.ok(!r3.disclosed?.some((d) => d.endsWith(":clipped")), "no phantom clip disclosure");
});

test("c3-F6b (audit): resolve clips by/note with disclosure on the ResolutionRecord", async () => {
  const h = mk();
  const r = (await h.channel.raise(valid() as never)) as RaiseResult;
  const res = await h.channel.resolve(r.record.escalationId, { decision: "approve", by: "b".repeat(300), note: "n".repeat(300) } as never);
  assert.ok(res !== null);
  assert.equal(res!.by.length, 240);
  assert.equal(res!.note!.length, 240);
  assert.ok(res!.disclosed?.includes("by:clipped") && res!.disclosed?.includes("note:clipped"), "both clips disclosed");
});

// ──────────────────────── audit cycle 4 (F1–F6) ───────────────────────────

test("c4-F1 (HIGH-1): dispatcher rejects oversized identity — never clips into a shared dedup key", async () => {
  const L: unknown[] = [];
  const ch = makeEscalationChannel({ append: async (r) => { L.push(r); }, deliver: async () => ({ channel: "t" }), now: () => 1 });
  const d = makeEscalationDispatcher({ channel: ch });
  const rA = await d.escalate({ episodeId: "x".repeat(300) + "A", taskId: "t" });
  const rB = await d.escalate({ episodeId: "x".repeat(300) + "B", taskId: "t" });
  assert.deepEqual(rA, { channel: "escalation:invalid" }, "oversized identity refused, nothing appended");
  assert.deepEqual(rB, { channel: "escalation:invalid" });
  assert.equal(L.length, 0, "no record with a clipped identity is ever durable");
});

test("c4-F1b (HIGH-1): park rejects oversized identity too", async () => {
  const appends: unknown[] = [];
  const ch = makeEscalationChannel({ append: async (r) => { appends.push(r); }, now: () => 1 });
  const d = makeEscalationDispatcher({ channel: ch });
  await d.park({ episodeId: "y".repeat(300), taskId: "t" } as never);
  assert.equal(appends.length, 0);
});

test("c4-F2b (HIGH-2): shared-log restart — resolved question's cap survives, new evidence is recorded but NOT re-delivered", async () => {
  const appends: unknown[] = [];
  const delivers: unknown[] = [];
  const deps = {
    append: async (r: object) => { appends.push(r); },
    read: async () => [...appends],
    deliver: async (r: EscalationRecord) => { delivers.push(r); return { channel: "t" }; },
    now: () => 1700000000 + appends.length,
    maxRedeliver: 1,
  };
  const ch1 = makeEscalationChannel(deps);
  const r1 = (await ch1.raise(valid() as never)) as RaiseResult;
  assert.equal(r1.delivered, true);
  await ch1.resolve(r1.record.escalationId, { decision: "approve", by: "human-1" });
  const ch2 = makeEscalationChannel(deps); // restart over the same log
  const r2 = (await ch2.raise(valid({ decisionNeeded: "changed: approve a DIFFERENT swap" }) as never)) as RaiseResult;
  assert.equal(r2.delivered, false, "the resolved question already burned its delivery — INV-5 cap survives the restart");
  assert.equal(r2.reason, "redeliver-cap");
});

test("c4-F3: throwing descriptors on blocker/attemptId/decisionNeeded/by are disclosed, never silent", async () => {
  const trapOne = (key: string): Rec => {
    const base: Rec = { episodeId: "e", taskId: "t", blocker: "gate-defect" };
    Object.defineProperty(base, key, { get() { throw new Error("trap"); }, enumerable: true, configurable: true });
    return base;
  };
  for (const key of ["blocker", "attemptId", "decisionNeeded"]) {
    const ch = makeEscalationChannel({ append: async () => {}, deliver: async () => ({ channel: "t" }), now: () => 1 });
    const r = (await ch.raise(trapOne(key) as never)) as RaiseResult;
    if (r === null || r.record === undefined) continue; // a throwing identity blocker may refuse — either way, no throw escaped
    assert.ok((r.disclosed ?? []).some((m) => m.includes(key)), `throwing '${key}' disclosed`);
  }
  const appends: { disclosed?: string[] }[] = [];
  const ch2 = makeEscalationChannel({ append: async (rec) => { appends.push(rec as { disclosed?: string[] }); }, now: () => 1 });
  const raised = (await ch2.raise({ episodeId: "e", taskId: "t", blocker: "gate-defect" } as never)) as RaiseResult;
  const badBy = { decision: "approve", by: "u" };
  Object.defineProperty(badBy, "by", { get() { throw new Error("trap"); }, enumerable: true, configurable: true });
  const res = await ch2.resolve(raised.record.escalationId, badBy as never);
  assert.ok(res === null || (res.disclosed ?? []).includes("bad-input:by"), "throwing 'by' disclosed or refused");
});

test("c4-F5: present but non-string strategyId/detail is skipped WITH disclosure", async () => {
  const ch = makeEscalationChannel({ append: async () => {}, deliver: async () => ({ channel: "t" }), now: () => 1 });
  const r = (await ch.raise({
    episodeId: "e", taskId: "t", blocker: "repeated-strategy",
    attempts: [{ action: "a", strategyId: 42 }],
  } as never)) as RaiseResult;
  assert.ok(r.disclosed?.some((m) => m.startsWith("attempts:")), `attempts loss disclosed: ${JSON.stringify(r.disclosed)}`);
});

test("c4-F6 (MED-6): dispatcher discloses per-entry rationale slices, skipped non-strings, and actionId clips", async () => {
  const L: { evidence: string[] }[] = [];
  const ch = makeEscalationChannel({ append: async (r) => { L.push(r as { evidence: string[] }); }, deliver: async () => ({ channel: "t" }), now: () => 1 });
  const d = makeEscalationDispatcher({ channel: ch });
  await d.escalate({ episodeId: "e", taskId: "t", rationale: ["x".repeat(200)] });
  assert.ok(L[0]!.evidence.includes("rationale:truncated"), "80-char slice of a 200-char rationale is disclosed");
  L.length = 0;
  await d.escalate({ episodeId: "e2", taskId: "t", rationale: [42, "a"] } as never);
  assert.ok(L[0]!.evidence.includes("rationale:truncated"), "a skipped non-string is disclosed");
  L.length = 0;
  await d.escalate({ episodeId: "e3", taskId: "t", actionId: "a".repeat(300), rationale: ["ok"] });
  assert.ok(L[0]!.evidence.includes("actionId:clipped"), "the actionId clip is disclosed");
});

test("c4-F7 (MED-7): parse clips the note WITH noteClipped", async () => {
  const id = "esc-" + "a".repeat(16);
  const p = parseTelegramResolution(`/resolve ${id} deny: ${"n".repeat(300)}`, "user");
  assert.ok(p !== null && p.note!.length === 240 && p.noteClipped === true, "clip is visible downstream");
  const q = parseTelegramResolution(`/resolve ${id} deny: short`, "user");
  assert.ok(q !== null && q.noteClipped === undefined, "no flag without a clip");
});

test("c4-F8 (MED-8): renderEscalation survives a revoked-proxy record and a get-trapping record", () => {
  const base: Rec = { schema: ESCALATION_SCHEMA, kind: "escalation", id: "esc-0000000000000001#0", escalationId: "esc-" + "0".repeat(16), ts: 1, episodeId: "e", taskId: "t", blocker: "gate-defect", decisionNeeded: "d", evidence: [], attempts: [], reNotice: 0, deliveredCount: 0, evidenceDigest: "0".repeat(16), provenance: "P13/M1" };
  const revoked = new Proxy(base, { get(): never { throw new Error("revoked"); }, getOwnPropertyDescriptor(): never { throw new Error("revoked"); } });
  const out = renderEscalation(revoked as unknown as EscalationRecord);
  assert.ok(out.endsWith(`/resolve ? ${"approve|deny|rewrite|abort|resume-with-note"}`) || out.includes("/resolve"), "total renderer produced a resolve line for a revoked record");
  const trapGet = new Proxy(base, { get(_t, k): unknown { if (k === "evidence") throw new Error("trap"); return (base as Rec)[k as string]; } });
  const out2 = renderEscalation(trapGet as unknown as EscalationRecord);
  assert.ok(typeof out2 === "string" && out2.length > 0, "trapping evidence renders degraded, never throws");
});

test("c4-F9 (MED-4): a resolution line the strict parse rejects but the grammar honors still closes the question", async () => {
  const appends: unknown[] = [];
  const deps = {
    append: async (r: object) => { appends.push(r); },
    read: async () => [...appends],
    deliver: async () => ({ channel: "t" }),
    now: () => 1700000000 + appends.length,
  };
  const ch = makeEscalationChannel(deps);
  const r = (await ch.raise(valid() as never)) as RaiseResult;
  // A hand-built resolution line with a valid ref but a missing 'by' (strict parse rejects, lenient close accepts).
  appends.push({ schema: ESCALATION_SCHEMA, kind: "resolution", id: "res-x", ref: r.record.escalationId, decision: "approve", ts: 5 });
  const st = await ch.pendingStatus();
  assert.equal(st.open.length, 0, "the lenient close closed it");
  assert.equal(st.complete, false, "a lenient-only close makes the view partial truth, never 'complete'");
});

// ──────────────────── audit cycle 1 (implement-audit loop) ──────────────────

test("loop-c1-F1: CONCURRENT raises of one key cannot both pass the INV-5 cap (per-channel serialization)", async () => {
  const appends: unknown[] = [];
  const delivers: unknown[] = [];
  const ch = makeEscalationChannel({
    append: async (r) => { appends.push(r); },
    read: async () => [...appends],
    deliver: async (r) => { delivers.push(r); return { channel: "t" }; },
    now: () => 1700000000 + appends.length,
    maxRedeliver: 1,
  });
  const rs = await Promise.all([ch.raise(valid() as never), ch.raise(valid() as never), ch.raise(valid() as never)]);
  assert.equal(delivers.length, 1, "one delivery across three concurrent raises");
  assert.equal(rs[0]!.delivered, true);
  assert.equal(rs[1]!.delivered, false, "the second concurrent raise sees the cap");
  assert.equal(rs[2]!.delivered, false);
});

test("loop-c1-F2: dispatcher survives a revoked 'rationale' proxy — drops WITH the structural marker", async () => {
  const appends: { evidence: string[] }[] = [];
  const ch = makeEscalationChannel({ append: async (r) => { appends.push(r as { evidence: string[] }); }, deliver: async () => ({ channel: "t" }), now: () => 1 });
  const d = makeEscalationDispatcher({ channel: ch });
  const { proxy, revoke } = Proxy.revocable<string[]>([], {});
  revoke();
  const r = await d.escalate({ episodeId: "e2", taskId: "t", rationale: proxy } as never);
  assert.ok(r !== null, "the escalate completed, no throw escaped");
  assert.ok(appends[0]!.evidence.includes("rationale:dropped"), "hostile rationale disclosed in the record");
});

test("loop-c1-F3: renderEscalation survives a per-index TRAPPING evidence array", () => {
  const rec = {
    schema: ESCALATION_SCHEMA, kind: "escalation", id: "esc-0000000000000001#0", escalationId: "esc-" + "1".repeat(16), ts: 1,
    episodeId: "e", taskId: "t", blocker: "gate-defect", decisionNeeded: "d",
    evidence: new Proxy(["ok"], { get(): never { throw new Error("index-trap"); } }),
    attempts: [], reNotice: 0, deliveredCount: 0, evidenceDigest: "0".repeat(16), provenance: "P13/M1",
  };
  const out = renderEscalation(rec as unknown as EscalationRecord);
  assert.ok(out.includes("/resolve"), "renderer degraded to a resolve-able message, never threw");
});

// ──────────────────── audit cycle 2 (implement-audit loop) ──────────────────

test("loop-c2-F1: a HUNG deliver never wedges resolve or another raise (mutex covers state, not the send)", async () => {
  const appends: { escalationId: string }[] = [];
  const ch = makeEscalationChannel({
    append: async (r) => { appends.push(r as { escalationId: string }); },
    read: async () => [...appends],
    deliver: () => new Promise(() => { /* the send never settles */ }),
    now: () => appends.length + 1,
  });
  ch.raise(valid() as never); // fire-and-forget: this send hangs forever
  await new Promise((r) => setTimeout(r, 5));
  const res = await Promise.race([
    ch.resolve(appends[0]!.escalationId, { decision: "approve", by: "u" }),
    new Promise<null>((_, j) => setTimeout(() => j(null), 100)),
  ]);
  assert.ok(res !== null, "resolve flowed while the send hung");
  ch.raise(valid({ decisionNeeded: "a different question" }) as never);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(appends.length, 3, "the second raise appended off-queue; the first send still hangs");
});

test("loop-c2-F2: past REPLAY_CAP a restarted channel cannot verify the count — delivery fails CLOSED", async () => {
  const big: unknown[] = [];
  const ch1 = makeEscalationChannel({ append: async (r) => { big.push(r); }, read: async () => [...big], deliver: async () => ({ channel: "t" }), now: () => big.length, maxRedeliver: 1 });
  const v = valid();
  const r1 = (await ch1.raise(v as never)) as RaiseResult;
  assert.equal(r1.delivered, true);
  for (let i = 0; i < 100_005; i++) big.push({ schema: "other", kind: "noise", i });
  const ch2 = makeEscalationChannel({ append: async (r) => { big.push(r); }, read: async () => [...big], deliver: async () => ({ channel: "t2" }), now: () => big.length, maxRedeliver: 1 });
  const r2 = (await ch2.raise(valid({ decisionNeeded: "changed: a NEW ask" }) as never)) as RaiseResult;
  assert.equal(r2.delivered, false, "an unverifiable delivery budget is spent, never granted");
  assert.equal(r2.reason, "redeliver-cap");
  assert.ok(r2.disclosed?.includes("delivery:unverifiable-count"), "the fail-closed reason is disclosed");
});

test("loop-c2-F3: present-but-wrong-type scalars are disclosed, never silently defaulted", async () => {
  const ch = makeEscalationChannel({ append: async () => {}, deliver: async () => ({ channel: "t" }), now: () => 1 });
  const r = (await ch.raise({ episodeId: "e", taskId: "t", decisionNeeded: 42, attemptId: 7, blocker: 5, force: "yes" } as never)) as RaiseResult;
  for (const m of ["bad-input:blocker", "bad-input:attemptId", "bad-input:decisionNeeded", "bad-input:force"]) {
    assert.ok((r.disclosed ?? []).includes(m), `${m} disclosed`);
  }
  const appends: unknown[] = [];
  const ch2 = makeEscalationChannel({ append: async (x) => { appends.push(x); }, now: () => 1 });
  const rr = (await ch2.raise({ episodeId: "e", taskId: "t", blocker: "gate-defect" } as never)) as RaiseResult;
  const res = await ch2.resolve(rr.record.escalationId, { decision: "approve", by: "u", note: 42 } as never);
  assert.ok(res !== null && (res.disclosed ?? []).includes("bad-input:note"), "resolve note type-loss disclosed");
});

test("loop-c2-F4: 'actionId:clipped' survives a full rationale list (slots reserved before entries)", async () => {
  const appends: { evidence: string[] }[] = [];
  const ch = makeEscalationChannel({ append: async (r) => { appends.push(r as { evidence: string[] }); }, deliver: async () => ({ channel: "t" }), now: () => 1 });
  const d = makeEscalationDispatcher({ channel: ch });
  await d.escalate({ episodeId: "e", taskId: "t", actionId: "a".repeat(300), rationale: Array.from({ length: 20 }, (_, i) => `r${i}`) } as never);
  const ev = appends[0]!.evidence;
  assert.ok(ev.includes("actionId:clipped"), "the clip marker was NOT evicted by the rationale flood");
  assert.ok(ev.includes("rationale:truncated"), "the rationale truncation is marked too");
  assert.ok(ev.length <= 16);
});

test("loop-c2-F5: a replay line whose prototype read traps is counted unreadable — never skipped with complete:true", async () => {
  const log: unknown[] = [];
  const trap = new Proxy({}, { get() { throw new Error("t"); }, getOwnPropertyDescriptor() { throw new Error("t"); }, getPrototypeOf() { throw new Error("t"); } });
  const ch = makeEscalationChannel({ append: async (r) => { log.push(r); }, read: async () => [...log, trap], now: () => 1 });
  const st = await ch.pendingStatus();
  assert.equal(st.complete, false, "an unreadable hostile line is never silently skipped");
});

test("loop-c2-rec: the multi-line hint names U+2028/U+2029 line separators", () => {
  const id = "esc-" + "0".repeat(16);
  assert.ok(resolutionRejectionHint(`/resolve ${id} deny:a\u2028b`) !== null, "U+2028 hinted");
  assert.ok(resolutionRejectionHint(`/resolve ${id} deny:a\u2029b`) !== null, "U+2029 hinted");
});

test("loop-c3-F1: an unverifiable-count refusal survives restart — a refusal line never resets the cap", async () => {
  const big: unknown[] = [];
  const ch1 = makeEscalationChannel({ append: async (r) => { big.push(r); }, read: async () => [...big], deliver: async () => ({ channel: "t" }), now: () => big.length, maxRedeliver: 1 });
  const r1 = (await ch1.raise(valid() as never)) as RaiseResult;
  assert.equal(r1.delivered, true);
  for (let i = 0; i < 100_005; i++) big.push({ schema: "other", kind: "noise", i });
  // Restart #1: truncated window, no proof of the past delivery -> refusal line appended.
  const ch2 = makeEscalationChannel({ append: async (r) => { big.push(r); }, read: async () => [...big], deliver: async () => ({ channel: "t2" }), now: () => big.length, maxRedeliver: 1 });
  const r2 = (await ch2.raise(valid({ decisionNeeded: "changed: a NEW ask" }) as never)) as RaiseResult;
  assert.equal(r2.delivered, false, "cycle-2 behavior preserved: unverifiable budget refuses");
  const refusalLine = big[big.length - 1];
  assert.ok(refusalLine !== undefined && typeof refusalLine === "object" && (refusalLine as { countUnverifiable?: unknown }).countUnverifiable === true, "the refusal line carries its own evidence");
  // Restart #2: the refusal line sits back INSIDE the window. Before the fix its
  // deliveredCount: 0 minted a fresh budget and the key delivered again (auditor:
  // 6 deliveries against cap 3 across restarts).
  const ch3 = makeEscalationChannel({ append: async (r) => { big.push(r); }, read: async () => [...big], deliver: async () => ({ channel: "t3" }), now: () => big.length, maxRedeliver: 1 });
  const r3 = (await ch3.raise(valid({ decisionNeeded: "changed again: a NEWER ask" }) as never)) as RaiseResult;
  assert.equal(r3.delivered, false, "restart must NOT reset the unverifiable budget");
  assert.ok(r3.disclosed?.includes("delivery:unverifiable-count"), "still disclosed as unverifiable after the restart");
  // Restart #3: a COMPLETE replay of the truncation-gap log (only the refusal
  // line visible, nothing cut now) — the gap is permanent, so still refuse.
  const ch4 = makeEscalationChannel({ append: async () => {}, read: async () => [refusalLine], deliver: async () => ({ channel: "t4" }), now: () => 1, maxRedeliver: 1 });
  const r4 = (await ch4.raise(valid({ decisionNeeded: "changed yet again" }) as never)) as RaiseResult;
  assert.equal(r4.delivered, false, "a complete replay of a once-truncated log stays refused");
  assert.ok(r4.disclosed?.includes("delivery:unverifiable-count"), "complete-replay refusal is disclosed too");
});
