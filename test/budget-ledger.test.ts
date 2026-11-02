/**
 * P8 — budget ledger & spend authority (docs/12, docs/11 §14.1).
 *
 * Covers the invariants of docs/12 §5, each by name:
 *  A1 over-spending impossible at the gate (every cap class denies with a
 *    stable code; receipts are the only admission ticket).
 *  A2 reservations reconcile (open → settled/released/expired/abandoned;
 *    staleReservations lists what is still open; double-close refused).
 *  A3 grants durable (grantedBy/sideEffect/receiptDigest on the record).
 *  A4 check is the only path (forged handles refused; no raw res-open
 *    append API; reserve re-checks inside the queue — refresh-first).
 *  A5 durable trail (append resolves only after fsync; poisoned instances
 *    refuse further appends).
 *  A6 attempt accounting (run consumes a slot, resume never does, a
 *    released hold refunds it, resume-into-unknown-attempt denies).
 *  A7 projection determinism (same records → identical snapshot).
 *  A8 counted exactly once (ingest idempotent per entry id, across
 *    instances too; duplicate lineIds fold once).
 *  A9 no unpriced path (frozen rates on every spend; fallback-priced
 *    marked and visible; unpriced assistant entries refused).
 * Plus §13.1 durability: torn-tail repair (cut / terminate / keep),
 * mid-file corruption fails closed, duplicate-key lines refused,
 * duplicate record ids reported. And the compartment guards.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionReceipt,
  BudgetLedger,
  BudgetLedgerError,
  DEFAULT_RATES,
  FALLBACK_RATE,
  LEDGER_SCHEMA_ID,
  RESERVATION_TTL_MS,
  canonicalActionSpec,
  check,
  compartmentKey,
  computeCostUsd,
  projectLedger,
  resolveRate,
  staleReservations,
  validateLedgerRecord,
  type BudgetSnapshot,
  type CheckResult,
  type GatePolicy,
  type GateRequest,
  type LedgerRecord,
} from "../src/budget/ledger.js";

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "budget-test-"));
}
async function ledgerIn(dir: string): Promise<BudgetLedger> {
  return BudgetLedger.open(join(dir, "budget.jsonl"));
}

const AUTH = { grantedBy: "user:p8-suite", sideEffect: "none" } as const;

function policyOf(over: Partial<GatePolicy> = {}): GatePolicy {
  return {
    episodeId: "ep-1",
    caps: { usd: 100, turns: 1000 },
    perAttempt: { usd: 1, turns: 5 },
    allowExternalEffects: false,
    ...over,
  };
}
function requestOf(over: Partial<Omit<GateRequest, "authority">> & { authority?: GateRequest["authority"] } = {}): GateRequest {
  return { action: "run", actionId: "act-1", authority: AUTH, ...over };
}
const EMPTY: BudgetSnapshot = projectLedger([], 0);
const fixedClock = (t: number) => () => t;

// ───────────────────────────── pricing (D1 / A9) ────────────────────────────

test("pricing: exact model beats prefix beats provider beats fallback", () => {
  assert.equal(resolveRate("gpt-4o", "openai"), DEFAULT_RATES.find((e) => e.model === "gpt-4o")!.rate);
  assert.equal(resolveRate("gpt-4o-mini", "openai"), DEFAULT_RATES.find((e) => e.model === "gpt-4o-mini")!.rate);
  assert.equal(resolveRate("claude-sonnet-4-5", "anthropic"), DEFAULT_RATES.find((e) => e.model === "claude-sonnet*")!.rate);
  assert.equal(resolveRate("claude-opus-4", "anthropic"), DEFAULT_RATES.find((e) => e.model === "claude-*")!.rate);
  assert.equal(resolveRate("anything", "openrouter"), DEFAULT_RATES.find((e) => e.provider === "openrouter")!.rate);
  assert.equal(resolveRate("anything", "local"), FALLBACK_RATE);
});

test("pricing: episode overrides win over the built-in table (D1)", () => {
  const over = [{ model: "gpt-4o", rate: { input: 1, output: 2 } }];
  assert.deepEqual(resolveRate("gpt-4o", "openai", over), { input: 1, output: 2 });
  // override may also introduce a provider entry ahead of table prefixes
  const lab = [{ provider: "ollama", rate: { input: 0.01, output: 0.02 } }];
  assert.deepEqual(resolveRate("llama3", "ollama", lab), { input: 0.01, output: 0.02 });
});

test("pricing: cache components billed against input-inclusive usage", () => {
  const rate = { input: 2, output: 8, cacheRead: 0.5 };
  // 1000 total input of which 400 cached, 100 output
  assert.ok(Math.abs(computeCostUsd({ input: 1000, output: 100, cacheRead: 400 }, rate) - (600 * 2 + 400 * 0.5 + 100 * 8) / 1e6) < 1e-12);
  // cache components clamp to input; uncached never negative
  assert.ok(Math.abs(computeCostUsd({ input: 100, output: 0, cacheRead: 500 }, rate) - 100 * 0.5 / 1e6) < 1e-12);
});

test("A9: zero-price fallback is visible, never silent", () => {
  const policy = policyOf({ caps: { usd: 1e9 } }); // eslint-disable-line @typescript-eslint/no-unused-vars
  void policy;
  const rate = resolveRate("self-hosted-llama", "lab");
  assert.equal(rate, FALLBACK_RATE);
  assert.equal(computeCostUsd({ input: 1_000_000, output: 1_000_000 }, rate), 0);
});

// ─────────────────────── schema validation (closed set) ─────────────────────

test("schema: every kind validates; unknown kinds and bad fields refuse", () => {
  const base = { schema: LEDGER_SCHEMA_ID, id: "x-1", ts: 1, episodeId: "ep-1" };
  validateLedgerRecord({ ...base, kind: "wallclock", taskId: "t1", seconds: 3 });
  assert.throws(() => validateLedgerRecord({ ...base, kind: "timecard", seconds: 3 }), (e: unknown) => (e as BudgetLedgerError).code === "schema");
  assert.throws(() => validateLedgerRecord({ ...base, kind: "wallclock", seconds: -1 }), (e: unknown) => (e as BudgetLedgerError).code === "schema");
  assert.throws(() => validateLedgerRecord({ ...base, kind: "spend" }), (e: unknown) => (e as BudgetLedgerError).code === "schema");
  assert.throws(() => validateLedgerRecord({ ...base, schema: "other/2", kind: "wallclock", seconds: 1 }), (e: unknown) => (e as BudgetLedgerError).code === "schema");
});

// ────────────────────────── durability (§13.1 / A5) ─────────────────────────

test("append is append-only and ledger-stamps ts", async () => {
  const dir = await freshDir();
  const ledger = await ledgerIn(dir);
  const clock = fixedClock(12345);
  await ledger.recordManualSpend(
    { lineId: "m-1", model: "gpt-4o", provider: "openai", usage: { input: 1000, output: 500 } },
    { episodeId: "ep-1" },
    { clock },
  );
  const raw = await readFile(join(dir, "budget.jsonl"), "utf8");
  assert.ok(raw.endsWith("\n"));
  const rec = JSON.parse(raw.trim());
  assert.equal(rec.ts, 12345);
  assert.equal(rec.kind, "spend");
  assert.ok(rec.costUsd > 0);
  assert.ok(rec.id.startsWith("b-"));

  await ledger.recordManualSpend(
    { lineId: "m-2", model: "gpt-4o", provider: "openai", usage: { input: 1, output: 1 } },
    { episodeId: "ep-1" },
    { clock: fixedClock(12346) },
  );
  const after = (await readFile(join(dir, "budget.jsonl"), "utf8")).trim().split("\n");
  assert.equal(after.length, 2);
  assert.ok(after[0]!.startsWith(raw.trim()), "existing lines are never rewritten");
});

test("A5: a poisoned instance refuses further appends (reopen required)", async () => {
  const dir = await freshDir();
  const path = join(dir, "budget.jsonl");
  const ledger = await BudgetLedger.open(path);
  await ledger.recordManualSpend(
    { lineId: "m-1", model: "gpt-4o", provider: "openai", usage: { input: 1, output: 1 } },
    { episodeId: "ep-1" },
  );
  await chmod(path, 0o444); // read-only: the next append's open() fails
  await assert.rejects(
    ledger.recordManualSpend({ lineId: "m-2", model: "gpt-4o", provider: "openai", usage: { input: 1, output: 1 } }, { episodeId: "ep-1" }),
  );
  await assert.rejects(
    ledger.recordManualSpend({ lineId: "m-3", model: "gpt-4o", provider: "openai", usage: { input: 1, output: 1 } }, { episodeId: "ep-1" }),
    (e: unknown) => (e as BudgetLedgerError).code === "poisoned",
  );
  await chmod(path, 0o644);
  const reopened = await BudgetLedger.open(path);
  const snap = await reopened.snapshotAt(0);
  assert.equal(snap.fallbackPricedCount, 0);
  assert.equal((await reopened.read()).records.length, 1); // only m-1 is durable
});

test("torn tail: unterminated valid record is TERMINATED (kept) — a fsynced append that lost its newline is not lost money", async () => {
  const dir = await freshDir();
  const path = join(dir, "budget.jsonl");
  const ledger = await BudgetLedger.open(path);
  const spend = await ledger.recordManualSpend(
    { lineId: "m-1", model: "gpt-4o", provider: "openai", usage: { input: 100, output: 10 } },
    { episodeId: "ep-1" },
  );
  const full = await readFile(path, "utf8");
  await writeFile(path, full.slice(0, full.length - 1)); // remove the trailing newline
  const reopened = await BudgetLedger.open(path);
  assert.equal(reopened.tornTailRepaired, true);
  const read = await reopened.read();
  assert.equal(read.records.length, 1);
  assert.equal((read.records[0] as { id: string }).id, spend.id);
  const again = await readFile(path, "utf8");
  assert.ok(again.endsWith("\n"));
});

test("torn tail: garbage tail is CUT; repair is idempotent; whitespace tail is cut", async () => {
  const dir = await freshDir();
  const path = join(dir, "budget.jsonl");
  const ledger = await BudgetLedger.open(path);
  await ledger.recordManualSpend({ lineId: "m-1", model: "gpt-4o", provider: "openai", usage: { input: 1, output: 1 } }, { episodeId: "ep-1" });
  const clean = await readFile(path, "utf8");
  await writeFile(path, clean + '{"schema":"tre-budget/1","id":"half'); // torn mid-record
  const r1 = await BudgetLedger.open(path);
  assert.equal(r1.tornTailRepaired, true);
  assert.equal((await r1.read()).records.length, 1);
  const r2 = await BudgetLedger.open(path);
  assert.equal(r2.tornTailRepaired, false, "repair is idempotent");
  await writeFile(path, clean + "   \n"); // whitespace tail line
  const r3 = await BudgetLedger.open(path);
  assert.equal((await r3.read()).records.length, 1);
});

test("torn tail: ambiguous duplicate-key tail is CUT even when parseable", async () => {
  const dir = await freshDir();
  const path = join(dir, "budget.jsonl");
  const ledger = await BudgetLedger.open(path);
  await ledger.recordManualSpend({ lineId: "m-1", model: "gpt-4o", provider: "openai", usage: { input: 1, output: 1 } }, { episodeId: "ep-1" });
  const clean = await readFile(path, "utf8");
  // built as a raw string: JSON literal duplicate keys are a TS error,
  // and last-wins JSON.parse is exactly the ambiguity we refuse.
  const ambiguous = `{"schema":"${LEDGER_SCHEMA_ID}","id":"dup-key","ts":5,"episodeId":"ep-1","kind":"wallclock","seconds":1,"seconds":2}`;
  await writeFile(path, clean + ambiguous); // no newline, repeats "seconds"
  const reopened = await BudgetLedger.open(path);
  assert.equal(reopened.tornTailRepaired, true);
  assert.equal((await reopened.read()).records.length, 1, "the ambiguous tail was cut, not terminated");
});

test("mid-file corruption fails closed: corrupt line, blank line, duplicate-key line", async () => {
  const dir = await freshDir();
  const path = join(dir, "budget.jsonl");
  const line = (o: object) => JSON.stringify(o) + "\n";
  const ok = { schema: LEDGER_SCHEMA_ID, id: "ok-1", ts: 1, episodeId: "ep-1", kind: "wallclock", taskId: "t", seconds: 1 };
  await writeFile(path,
    line(ok) +
    line({ schema: LEDGER_SCHEMA_ID, id: "bad", ts: 2, episodeId: "ep-1", kind: "wallclock", seconds: -5 }) +
    line(ok));
  await assert.rejects(BudgetLedger.open(path), (e: unknown) => (e as BudgetLedgerError).code === "corrupt");
  await writeFile(path, line(ok) + "\n" + line(ok));
  await assert.rejects(BudgetLedger.open(path), (e: unknown) => (e as BudgetLedgerError).code === "corrupt");
  await writeFile(path,
    `{"schema":"${LEDGER_SCHEMA_ID}","id":"ok-1","ts":1,"episodeId":"ep-1","kind":"wallclock","taskId":"t","seconds":1,"seconds":2}\n` + line(ok));
  await assert.rejects(BudgetLedger.open(path), (e: unknown) => (e as BudgetLedgerError).code === "corrupt");
});

test("duplicate record ids are REPORTED by read(), never silently merged", async () => {
  const dir = await freshDir();
  const path = join(dir, "budget.jsonl");
  const rec = { schema: LEDGER_SCHEMA_ID, id: "same-1", ts: 1, episodeId: "ep-1", kind: "wallclock", taskId: "t1", seconds: 2 };
  await writeFile(path, JSON.stringify(rec) + "\n" + JSON.stringify(rec) + "\n");
  const ledger = await BudgetLedger.open(path);
  const read = await ledger.read();
  assert.deepEqual(read.duplicateIds, ["same-1"]);
  // a duplicate report never blocks honest appends (new uuids), and the
  // dup stays reported — operators see it until they repair the file.
  await ledger.recordWallclock({ episodeId: "ep-1", taskId: "t1" }, 1);
  const after = await ledger.read();
  assert.equal(after.records.length, 3);
  assert.deepEqual(after.duplicateIds, ["same-1"]);
});

test("forEpisode scaffolds events/ (S4 layout)", async () => {
  const dir = await freshDir();
  const ledger = await BudgetLedger.forEpisode(join(dir, "episode-A"));
  const stat = await readFile(join(dir, "episode-A", "events", "budget.jsonl")).then(
    () => "exists",
    () => "absent",
  );
  assert.equal(stat, "absent", "open() does not pre-create content");
  await ledger.recordWallclock({ episodeId: "episode-A", taskId: "t" }, 1);
  await readFile(join(dir, "episode-A", "events", "budget.jsonl")); // throws if missing
});

// ───────────────────────── projection (A7 / A8) ─────────────────────────────

test("A7: projection is deterministic — same records, identical snapshot", () => {
  const records = [
    { schema: LEDGER_SCHEMA_ID, id: "s1", ts: 1, episodeId: "ep", taskId: "t", attemptId: "a", kind: "spend", lineId: "e1", model: "gpt-4o", provider: "openai", usage: { input: 10, output: 5 }, rates: { input: 2.5, output: 10 }, costUsd: 0.000075, priced: "table", source: "session" },
    { schema: LEDGER_SCHEMA_ID, id: "r1", ts: 2, episodeId: "ep", taskId: "t", kind: "res-open", actionId: "act", action: "run", reservedUsd: 0.5, reservedTurns: 2, expiresAt: 100, grantedBy: "user:x", sideEffect: "none", receiptDigest: "a".repeat(64), estimateRaised: false },
    { schema: LEDGER_SCHEMA_ID, id: "w1", ts: 3, episodeId: "ep", taskId: "t", kind: "wallclock", seconds: 7 },
  ] as unknown as LedgerRecord[];
  const a = projectLedger(records, 50);
  const b = projectLedger(records, 50);
  assert.equal(JSON.stringify([...a.compartments]), JSON.stringify([...b.compartments]));
  assert.equal(JSON.stringify(a.openReservations), JSON.stringify(b.openReservations));
  // at/after expiry the hold vanishes from the gate's view
  const expired = projectLedger(records, 100);
  assert.equal(expired.openReservations.length, 0);
  assert.deepEqual(staleReservations(records, 99).map((r) => r.id), ["r1"]);
});

test("A8: spend lineIds fold exactly once; compartment chain charges attempt, task, episode", () => {
  const spend = (lineId: string, cost: number, id: string): LedgerRecord => ({
    schema: LEDGER_SCHEMA_ID, id, ts: 1, episodeId: "ep", taskId: "t", attemptId: "a",
    kind: "spend", lineId, model: "m", provider: "p", usage: { input: 1, output: 1 },
    rates: { input: 0, output: 0 }, costUsd: cost, priced: "fallback", source: "session",
  });
  const snap = projectLedger([spend("e-1", 0.4, "s1"), spend("e-1", 0.4, "s2"), spend("e-2", 0.6, "s3")], 0);
  const episode = snap.compartments.get(compartmentKey({ episodeId: "ep" }))!;
  const task = snap.compartments.get(compartmentKey({ episodeId: "ep", taskId: "t" }))!;
  const attempt = snap.compartments.get(compartmentKey({ episodeId: "ep", taskId: "t", attemptId: "a" }))!;
  assert.equal(episode.consumedUsd, 1.0);
  assert.equal(task.consumedUsd, 1.0);
  assert.equal(attempt.consumedUsd, 1.0);
  assert.equal(episode.consumedTurns, 2);
  assert.equal(snap.fallbackPricedCount, 2);
});

// ────────────────────────────── the gate (A1) ───────────────────────────────

function denialCodes(r: CheckResult): string[] {
  return r.denials.map((d) => d.code);
}

test("A1: every cap class denies with its code", () => {
  const mk = (over: Partial<GatePolicy>, snap: BudgetSnapshot, req?: Partial<GateRequest>) =>
    check(policyOf(over), requestOf(req), snap, 10);

  // episode usd
  const spentEpisode = projectLedger([{
    schema: LEDGER_SCHEMA_ID, id: "s1", ts: 1, episodeId: "ep-1", kind: "spend", lineId: "e1",
    model: "m", provider: "p", usage: { input: 1, output: 1 }, rates: { input: 1, output: 1 },
    costUsd: 99.5, priced: "table", source: "session",
  }] as unknown as LedgerRecord[], 0);
  assert.ok(denialCodes(mk({ caps: { usd: 100 } }, spentEpisode)).includes("episode-budget-exceeded"));

  // episode turns
  const turnsSnap = projectLedger(Array.from({ length: 996 }, (_, i) => ({
    schema: LEDGER_SCHEMA_ID, id: `t${i}`, ts: 1, episodeId: "ep-1", kind: "spend", lineId: `e${i}`,
    model: "m", provider: "p", usage: { input: 1, output: 1 }, rates: { input: 0, output: 0 },
    costUsd: 0, priced: "table", source: "session",
  })) as unknown as LedgerRecord[], 0);
  assert.ok(denialCodes(mk({ caps: { usd: undefined, turns: 1000 } }, turnsSnap)).includes("episode-turns-exceeded"));

  // episode wallclock
  const clockSnap = projectLedger([{ schema: LEDGER_SCHEMA_ID, id: "w", ts: 1, episodeId: "ep-1", taskId: "t", kind: "wallclock", seconds: 120 }] as unknown as LedgerRecord[], 0);
  assert.ok(denialCodes(mk({ caps: { wallclockS: 60 } }, clockSnap)).includes("episode-wallclock-exceeded"));

  // task usd / turns / attempts
  const taskSnap = projectLedger([{
    schema: LEDGER_SCHEMA_ID, id: "s2", ts: 1, episodeId: "ep-1", taskId: "tA", kind: "spend", lineId: "e9",
    model: "m", provider: "p", usage: { input: 1, output: 1 }, rates: { input: 1, output: 1 },
    costUsd: 0.9, priced: "table", source: "session",
  }, {
    schema: LEDGER_SCHEMA_ID, id: "w2", ts: 1, episodeId: "ep-1", taskId: "tA", attemptId: "aA", kind: "wallclock", seconds: 40,
  }] as unknown as LedgerRecord[], 0);
  assert.ok(denialCodes(mk({ perTask: { usd: 1 } }, taskSnap, { taskId: "tA" })).includes("task-budget-exceeded"));
  // the reservation FLOOR (the attempt cap, D2) is what gets projected
  // against the task cap — a cheap attempt class still cannot overspend a
  // task that is nearly full.
  assert.ok(denialCodes(mk({ perTask: { usd: 1 }, perAttempt: { usd: 0.5 } }, taskSnap, { taskId: "tA" })).includes("task-budget-exceeded"), "floor (attempt cap) reservation projects against the task cap");
  assert.ok(denialCodes(mk({ perAttempt: { wallclockS: 30 } }, taskSnap, { taskId: "tA", attemptId: "aA" })).includes("attempt-wallclock-exceeded"));

  const usedSlot = projectLedger([{
    schema: LEDGER_SCHEMA_ID, id: "r9", ts: 1, episodeId: "ep-1", taskId: "tA", kind: "res-open", actionId: "x", action: "run",
    reservedUsd: 0.001, reservedTurns: 1, expiresAt: 10_000, grantedBy: "user:x", sideEffect: "none", receiptDigest: "b".repeat(64), estimateRaised: false,
  }] as unknown as LedgerRecord[], 0);
  assert.ok(denialCodes(mk({ perTask: { attempts: 1 }, caps: {} }, usedSlot, { taskId: "tA", action: "run" })).includes("task-attempts-exhausted"));
  // A6: resume never consumes a slot
  assert.ok(!denialCodes(mk({ perTask: { attempts: 1 }, caps: {} }, usedSlot, { taskId: "tA", attemptId: "aA", action: "resume" })).includes("task-attempts-exhausted"));

  // authority half
  assert.ok(denialCodes(mk({}, EMPTY, { authority: { grantedBy: "  ", sideEffect: "none" } })).includes("authority-missing"));
  assert.ok(denialCodes(mk({}, EMPTY, { authority: { grantedBy: "u", sideEffect: "external" } })).includes("external-not-allowed"));
  assert.equal(denialCodes(mk({ allowExternalEffects: true }, EMPTY, { authority: { grantedBy: "u", sideEffect: "external" } })).length, 0);

  // estimate validation
  assert.ok(denialCodes(mk({}, EMPTY, { estimate: { usd: NaN } })).includes("estimate-invalid"));
  assert.ok(denialCodes(mk({}, EMPTY, { estimate: { turns: 1.5 } })).includes("estimate-invalid"));
});

test("D2: reservation floor = attempt cap; caller may raise, never lower; raise is flagged", () => {
  const p = policyOf({ perAttempt: { usd: 2, turns: 8 } });
  const noEstimate = check(p, requestOf(), EMPTY, 5);
  assert.equal(noEstimate.allowed, true);
  assert.deepEqual(noEstimate.reserve, { usd: 2, turns: 8 });
  assert.equal(noEstimate.estimateRaised, true, "defaulting up from nothing counts as a raise decision");

  const lower = check(p, requestOf({ estimate: { usd: 0.5, turns: 2 } }), EMPTY, 5);
  assert.deepEqual(lower.reserve, { usd: 2, turns: 8 }, "a caller lowering below the floor is clamped up");
  assert.equal(lower.estimateRaised, true);

  const higher = check(p, requestOf({ estimate: { usd: 3, turns: 8 } }), EMPTY, 5);
  assert.deepEqual(higher.reserve, { usd: 3, turns: 8 });
  assert.equal(higher.estimateRaised, false);
});

test("A4/D3: the receipt is opaque, spec-bound, expiry-enforced", () => {
  const p = policyOf();
  const req = requestOf({ taskId: "t1" });
  const good = check(p, req, EMPTY, 1000);
  assert.ok(good.allowed && good.receipt);
  const receipt = good.receipt!;

  assert.deepEqual(receipt.verify({ action: "run", actionId: "act-1", episodeId: "ep-1", taskId: "t1" }, 1000), { ok: true });
  assert.equal(receipt.verify({ action: "resume", actionId: "act-1", episodeId: "ep-1", taskId: "t1" }, 1000).ok, false);
  assert.equal(receipt.verify({ action: "run", actionId: "other", episodeId: "ep-1", taskId: "t1" }, 1000).ok, false);
  assert.equal(receipt.verify({ action: "run", actionId: "act-1", episodeId: "ep-2", taskId: "t1" }, 1000).ok, false);
  assert.equal(receipt.verify({ action: "run", actionId: "act-1", episodeId: "ep-1" }, 1000).ok, false);
  // expiry at the boundary: `at >= expiresAt` is expired
  assert.equal(receipt.verify({ action: "run", actionId: "act-1", episodeId: "ep-1", taskId: "t1" }, good.expiresAt - 1).ok, true);
  assert.equal(receipt.verify({ action: "run", actionId: "act-1", episodeId: "ep-1", taskId: "t1" }, good.expiresAt).ok, false);

  // a structurally-copied handle is NOT a receipt (WeakMap registry)
  const fake = new ActionReceipt();
  assert.equal(fake.verify({ action: "run", actionId: "act-1", episodeId: "ep-1", taskId: "t1" }, 1000).ok, false);
});

test("canonical spec digest changes with every identity field", () => {
  const p = policyOf();
  const r = requestOf({ taskId: "t1" });
  const reserve = { usd: 2, turns: 8 };
  const d = (policy: GatePolicy, request: GateRequest) => canonicalActionSpec(policy, request, reserve);
  const base = d(p, r);
  assert.notEqual(base, d(policyOf({ episodeId: "ep-2" }), r));
  assert.notEqual(base, d(p, requestOf({ taskId: "t2" })));
  assert.notEqual(base, d(p, requestOf({ taskId: "t1", action: "resume" })));
  assert.notEqual(base, d(p, requestOf({ taskId: "t1", actionId: "act-2" })));
  assert.notEqual(base, d(p, requestOf({ taskId: "t1", authority: { grantedBy: "someone-else", sideEffect: "none" } })));
  assert.notEqual(base, d(p, requestOf({ taskId: "t1", authority: { grantedBy: "user:p8-suite", sideEffect: "external" } })));
  assert.notEqual(canonicalActionSpec(p, r, { usd: 3, turns: 8 }), base);
  assert.notEqual(canonicalActionSpec(p, r, { usd: 2, turns: 9 }), base);
});

// ─────────────────── reservation flow (A2/A3/A5/A6) ─────────────────────────

async function openLedger(dir: string): Promise<BudgetLedger> {
  return BudgetLedger.open(join(dir, "budget.jsonl"));
}

test("reserve: receipt → durable res-open with the A3 authority trail", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const now = 1000;
  const p = policyOf({ reservationTtlMs: 60_000 });
  const req = requestOf({ taskId: "t1" });
  const checked = check(p, req, await ledger.snapshotAt(now), now);
  assert.ok(checked.allowed);
  const rec = await ledger.reserve(p, req, checked.receipt!, { clock: fixedClock(now) });
  assert.equal(rec.kind, "res-open");
  assert.equal(rec.grantedBy, AUTH.grantedBy);
  assert.equal(rec.sideEffect, "none");
  assert.match(rec.receiptDigest, /^[0-9a-f]{64}$/);
  assert.equal(rec.expiresAt, now + 60_000);
  assert.equal(rec.estimateRaised, true);

  // the hold is now visible to the gate
  const snap = await ledger.snapshotAt(now);
  const task = snap.compartments.get(compartmentKey({ episodeId: "ep-1", taskId: "t1" }))!;
  assert.equal(task.reservedUsd, checked.reserve.usd);

  // A2: settle it, then the hold is gone
  const closed = await ledger.closeReservation(rec.id, "settled", { clock: fixedClock(now + 5) });
  assert.equal(closed.reason, "settled");
  const after = await ledger.snapshotAt(now);
  assert.equal((after.compartments.get(compartmentKey({ episodeId: "ep-1", taskId: "t1" })) ?? { reservedUsd: 0 }).reservedUsd, 0);
  assert.deepEqual(staleReservations((await ledger.read()).records, now), []);
});

test("A2: double-close is refused; unknown ref refused; expired reservation self-releases from the gate view", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const p = policyOf({ reservationTtlMs: 100 });
  const now = 1000;
  const req = requestOf({ taskId: "t1" });
  const checked = check(p, req, await ledger.snapshotAt(now), now);
  const rec = await ledger.reserve(p, req, checked.receipt!, { clock: fixedClock(now) });
  await ledger.closeReservation(rec.id, "released", { clock: fixedClock(now + 1) });
  await assert.rejects(ledger.closeReservation(rec.id, "settled"), (e: unknown) => (e as BudgetLedgerError).code === "bad-ref");
  await assert.rejects(ledger.closeReservation("never-existed", "abandoned"), (e: unknown) => (e as BudgetLedgerError).code === "bad-ref");
  await assert.rejects(ledger.closeReservation(rec.id, "bogus" as never), (e: unknown) => (e as BudgetLedgerError).code === "bad-input");

  // expiry: after TTL the hold stops constraining without any close record
  const p2 = policyOf({ reservationTtlMs: 50, caps: { usd: 1.5 } });
  const req2 = requestOf({ actionId: "act-2" });
  const c2 = check(p2, req2, await ledger.snapshotAt(2000), 2000);
  const rec2 = await ledger.reserve(p2, req2, c2.receipt!, { clock: fixedClock(2000) });
  const liveAt2010 = await ledger.snapshotAt(2010);
  assert.ok(liveAt2010.openReservations.some((r) => r.id === rec2.id));
  const after2050 = await ledger.snapshotAt(2100);
  assert.ok(!after2050.openReservations.some((r) => r.id === rec2.id), "expired hold invisible to the gate");
  // …and closing an expired reservation is refused (nothing to release)
  await assert.rejects(ledger.closeReservation(rec2.id, "expired"), (e: unknown) => (e as BudgetLedgerError).code === "bad-ref");
});

test("A1: the reservation is what makes over-spend impossible — concurrent spawns cannot both fit", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const p = policyOf({ caps: { usd: 1.5, turns: 100 }, perAttempt: { usd: 1, turns: 1 } });
  const now = 1000;
  // Two spawns checked against the SAME snapshot both pass check()…
  const snap = await ledger.snapshotAt(now);
  const c1 = check(p, requestOf({ actionId: "act-1" }), snap, now);
  const c2 = check(p, requestOf({ actionId: "act-2" }), snap, now);
  assert.ok(c1.allowed && c2.allowed, "stale-snapshot checks both pass — the receipt alone is NOT enough");
  // …but only one reservation survives the refresh-first queue.
  const r1 = await ledger.reserve(p, requestOf({ actionId: "act-1" }), c1.receipt!, { clock: fixedClock(now) });
  assert.ok(r1);
  await assert.rejects(
    ledger.reserve(p, requestOf({ actionId: "act-2" }), c2.receipt!, { clock: fixedClock(now) }),
    (e: unknown) => (e as BudgetLedgerError).code === "denied",
  );
});

test("A4: forged/mismatched handles never produce a reservation", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const p = policyOf();
  const req = requestOf({ taskId: "t1" });
  const checked = check(p, req, await ledger.snapshotAt(0), 0);
  const receipt = checked.receipt!;

  await assert.rejects(ledger.reserve(p, req, new ActionReceipt(), { clock: fixedClock(0) }), (e: unknown) => (e as BudgetLedgerError).code === "bad-input");
  // right handle, wrong action in the request: spec verify refuses
  await assert.rejects(ledger.reserve(p, requestOf({ taskId: "t1", action: "resume" }), receipt, { clock: fixedClock(0) }), (e: unknown) => (e as BudgetLedgerError).code === "receipt-invalid");
  // wrong actionId: refused
  await assert.rejects(ledger.reserve(p, requestOf({ taskId: "t1", actionId: "act-X" }), receipt, { clock: fixedClock(0) }), (e: unknown) => (e as BudgetLedgerError).code === "receipt-invalid");
  // different policy identity (episode): refused
  await assert.rejects(ledger.reserve({ ...p, episodeId: "ep-Z" }, { ...req }, receipt, { clock: fixedClock(0) }), (e: unknown) => (e as BudgetLedgerError).code === "receipt-invalid");
  // expired receipt: refused
  const shortTtl = policyOf({ reservationTtlMs: 10 });
  const shortCheck = check(shortTtl, requestOf({ actionId: "act-3" }), await ledger.snapshotAt(0), 0);
  await assert.rejects(ledger.reserve(shortTtl, requestOf({ actionId: "act-3" }), shortCheck.receipt!, { clock: fixedClock(9999) }), (e: unknown) => (e as BudgetLedgerError).code === "receipt-invalid");
  // authority differs from the grant the receipt was minted for: refused
  const authReceipt = check(policyOf(), requestOf({ actionId: "act-4", authority: { grantedBy: "user:a", sideEffect: "none" } }), await ledger.snapshotAt(0), 0).receipt!;
  await assert.rejects(
    ledger.reserve(policyOf(), requestOf({ actionId: "act-4", authority: { grantedBy: "user:b", sideEffect: "none" } }), authReceipt, { clock: fixedClock(0) }),
    (e: unknown) => (e as BudgetLedgerError).code === "receipt-invalid",
  );

  const read = await ledger.read();
  assert.equal(read.records.filter((r) => r.kind === "res-open").length, 0, "no reservation ever reached the disk");
});

test("A6: run reserves the attempt (slot + known-to-gate); released refunds; resume never consumes", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const now = 1000;
  const p = policyOf({ perTask: { attempts: 2 }, caps: { usd: 100, turns: 100 }, perAttempt: { usd: 1, turns: 5 } });

  // resume into a never-reserved attempt denies (A6 trap)
  const resume = check(p, requestOf({ actionId: "r0", taskId: "t1", attemptId: "a0", action: "resume" }), await ledger.snapshotAt(now), now);
  assert.ok(denialCodes(resume).includes("attempt-budget-exceeded"));

  // run reserves attempt a1
  const c1 = check(p, requestOf({ actionId: "a-1", taskId: "t1", attemptId: "a1" }), await ledger.snapshotAt(now), now);
  const r1 = await ledger.reserve(p, requestOf({ actionId: "a-1", taskId: "t1", attemptId: "a1" }), c1.receipt!, { clock: fixedClock(now) });
  const snap1 = await ledger.snapshotAt(now);
  assert.equal(snap1.attemptsUsed.get(JSON.stringify(["ep-1", "t1"])), 1);

  // resume into a1 is now legal and consumes NO slot
  const c2 = check(p, requestOf({ actionId: "a-2", taskId: "t1", attemptId: "a1", action: "resume" }), snap1, now);
  assert.ok(c2.allowed, `expected allowed, got ${denialCodes(c2).join(",")}`);

  // second run fills the second slot; third denies
  const c3 = check(p, requestOf({ actionId: "a-3", taskId: "t1", attemptId: "a2" }), await ledger.snapshotAt(now), now);
  await ledger.reserve(p, requestOf({ actionId: "a-3", taskId: "t1", attemptId: "a2" }), c3.receipt!, { clock: fixedClock(now) });
  const snap2 = await ledger.snapshotAt(now);
  assert.equal(snap2.attemptsUsed.get(JSON.stringify(["ep-1", "t1"])), 2);
  const c4 = check(p, requestOf({ actionId: "a-4", taskId: "t1", attemptId: "a3" }), snap2, now);
  assert.ok(denialCodes(c4).includes("task-attempts-exhausted"));

  // releasing a-2's task slot… close the FIRST reservation released → slot refunds
  await ledger.closeReservation(r1.id, "released", { clock: fixedClock(now + 1) });
  const snap3 = await ledger.snapshotAt(now);
  assert.equal(snap3.attemptsUsed.get(JSON.stringify(["ep-1", "t1"])), 1, "released run-reservation gives the slot back");
});

// ─────────────────────── ingest: session → ledger (A8/A9) ───────────────────

const sessionEntry = (id: string, msg: object) => JSON.stringify({ type: "message", id, message: msg });

test("ingestSession: only assistant-usage entries ledger; zoo tolerated; idempotent (A8)", async () => {
  const dir = await freshDir();
  const sessionPath = join(dir, "session.jsonl");
  await writeFile(sessionPath, [
    JSON.stringify({ type: "header", id: "h1", sessionId: "s", ts: 1 }),
    sessionEntry("e-1", { role: "user", content: "hi" }),
    sessionEntry("e-2", { role: "assistant", model: "gpt-4o", provider: "openai", usage: { input: 1000, output: 500 }, content: "ok" }),
    sessionEntry("e-3", { role: "tool_result", toolCallId: "tc", content: "done" }),
    sessionEntry("e-4", { role: "assistant", model: "gpt-4o", provider: "openai", content: "no usage block" }),
  ].join("\n") + "\n");

  const ledger = await ledgerIn(dir);
  const scope = { episodeId: "ep-1", taskId: "t1", attemptId: "a1" };
  const first = await ledger.ingestSession(sessionPath, scope, { clock: fixedClock(5000) });
  assert.equal(first.length, 1);
  assert.equal(first[0]!.lineId, "e-2");
  assert.equal(first[0]!.priced, "table");
  assert.ok(first[0]!.costUsd > 0);

  // re-ingest: true no-op, even in a second instance over the same file
  const second = await ledger.ingestSession(sessionPath, scope, { clock: fixedClock(5001) });
  assert.equal(second.length, 0);
  const other = await ledgerIn(dir);
  const third = await other.ingestSession(sessionPath, scope, { clock: fixedClock(5002) });
  assert.equal(third.length, 0);
  const read = await ledger.read();
  assert.equal(read.records.filter((r) => r.kind === "spend").length, 1);
});

test("A9: unpriced ingest path refuses loud (missing model/provider); frozen rates land on the record", async () => {
  const dir = await freshDir();
  const ledger = await ledgerIn(dir);
  const scope = { episodeId: "ep-1" };
  await assert.rejects(
    ledger.ingestEntries([{ id: "e-x", message: { role: "assistant", provider: "openai", usage: { input: 1, output: 1 } } }], scope),
    (e: unknown) => (e as BudgetLedgerError).code === "bad-input",
  );
  await assert.rejects(
    ledger.ingestEntries([{ id: "e-y", message: { role: "assistant", model: "", provider: "openai", usage: { input: 1, output: 1 } } }], scope),
    (e: unknown) => (e as BudgetLedgerError).code === "bad-input",
  );
  // self-hosted model with no table match: fallback-priced but VISIBLE
  const recs = await ledger.ingestEntries(
    [{ id: "e-z", message: { role: "assistant", model: "llama-lab", provider: "lab", usage: { input: 10, output: 2 } } }],
    scope,
  );
  assert.equal(recs[0]!.priced, "fallback");
  assert.equal(recs[0]!.costUsd, 0);
  const snap = await ledger.snapshotAt(0);
  assert.equal(snap.fallbackPricedCount, 1);

  // frozen at ingest (D1): a later override never reprices history
  const frozen = (await ledger.read()).records[0] as { rates: object; costUsd: number };
  assert.deepEqual(frozen.rates, { input: 0, output: 0 });
  assert.equal(frozen.costUsd, 0);
});

test("manual spend: dup lineId refused in-instance and cross-instance; note persisted", async () => {
  const dir = await freshDir();
  const ledger = await ledgerIn(dir);
  const spend = { lineId: "m-1", model: "gpt-4o", provider: "openai", usage: { input: 1, output: 1 }, note: "claude api credit burn" };
  const rec = await ledger.recordManualSpend(spend, { episodeId: "ep-1" });
  assert.equal(rec.note, "claude api credit burn");
  await assert.rejects(ledger.recordManualSpend(spend, { episodeId: "ep-1" }), (e: unknown) => (e as BudgetLedgerError).code === "dup-line");
  const other = await ledgerIn(dir);
  await assert.rejects(other.recordManualSpend(spend, { episodeId: "ep-1" }), (e: unknown) => (e as BudgetLedgerError).code === "dup-line");
});

// ─────────────────────────────── wallclock ──────────────────────────────────

test("wallclock windows record per task and per attempt", async () => {
  const dir = await freshDir();
  const ledger = await ledgerIn(dir);
  await ledger.recordWallclock({ episodeId: "ep-1", taskId: "t1", attemptId: "a1" }, 10, { clock: fixedClock(1) });
  await ledger.recordWallclock({ episodeId: "ep-1", taskId: "t1" }, 5, { clock: fixedClock(2) });
  await assert.rejects(ledger.recordWallclock({ episodeId: "ep-1", taskId: "t1" }, -1), (e: unknown) => (e as BudgetLedgerError).code === "bad-input");
  const snap = await ledger.snapshotAt(0);
  assert.equal(snap.wallclockS.get("t1"), 15);
  assert.equal(snap.attemptWallclockS.get(JSON.stringify(["ep-1", "t1", "a1"])), 10);
});

// ────────────────────────── sweep: denial-code coverage ─────────────────────

test("mutation sweep: every DenialCode is reachable, and allowed is iff denials empty", async () => {
  const dir = await freshDir();
  const ledger = await ledgerIn(dir);
  const base: GatePolicy = {
    episodeId: "ep-1",
    caps: { usd: 5, turns: 10, wallclockS: 100 },
    perTask: { usd: 2, turns: 6, attempts: 2 },
    perAttempt: { usd: 1, turns: 4, wallclockS: 30 },
    allowExternalEffects: false,
  };
  // Seed a ledger state that pushes every compartment near its cap.
  const seed: LedgerRecord[] = [
    { schema: LEDGER_SCHEMA_ID, id: "g-spend-1", ts: 1, episodeId: "ep-1", kind: "spend", lineId: "le-1", model: "m", provider: "p", usage: { input: 1, output: 1 }, rates: { input: 1, output: 1 }, costUsd: 3, priced: "table", source: "session" },
    { schema: LEDGER_SCHEMA_ID, id: "g-spend-2", ts: 1, episodeId: "ep-1", taskId: "tA", kind: "spend", lineId: "le-2", model: "m", provider: "p", usage: { input: 1, output: 1 }, rates: { input: 1, output: 1 }, costUsd: 1.2, priced: "table", source: "session" },
    { schema: LEDGER_SCHEMA_ID, id: "g-turns", ts: 1, episodeId: "ep-1", taskId: "tA", kind: "spend", lineId: "le-3", model: "m", provider: "p", usage: { input: 1, output: 1 }, rates: { input: 0, output: 0 }, costUsd: 0, priced: "table", source: "session" },
    { schema: LEDGER_SCHEMA_ID, id: "g-spend-at", ts: 1, episodeId: "ep-1", taskId: "tA", attemptId: "aA", kind: "spend", lineId: "le-4", model: "m", provider: "p", usage: { input: 1, output: 1 }, rates: { input: 1, output: 1 }, costUsd: 0.9, priced: "table", source: "session" },
    { schema: LEDGER_SCHEMA_ID, id: "g-w-ep", ts: 1, episodeId: "ep-1", taskId: "tZ", kind: "wallclock", seconds: 95 },
    { schema: LEDGER_SCHEMA_ID, id: "g-w-at", ts: 1, episodeId: "ep-1", taskId: "tA", attemptId: "aA", kind: "wallclock", seconds: 40 },
    { schema: LEDGER_SCHEMA_ID, id: "g-res-1", ts: 1, episodeId: "ep-1", taskId: "tA", kind: "res-open", actionId: "old-1", action: "run", reservedUsd: 0.5, reservedTurns: 2, expiresAt: 1_000_000, grantedBy: "user:x", sideEffect: "none", receiptDigest: "c".repeat(64), estimateRaised: false },
  ];
  const snap = projectLedger(seed, 100);

  const cases: { want: string; request: GateRequest; policy?: GatePolicy }[] = [
    { want: "episode-budget-exceeded", request: requestOf({ actionId: "x1" }), policy: { ...base } },
    { want: "episode-turns-exceeded", request: requestOf({ actionId: "x2" }), policy: { ...base, caps: { usd: 1000, turns: 8 } } }, // 3 consumed + 2 reserved + 4 floor > 8
    { want: "episode-wallclock-exceeded", request: requestOf({ actionId: "x3" }), policy: { ...base, caps: { usd: 1000, turns: 1000, wallclockS: 99 } } },
    { want: "task-budget-exceeded", request: requestOf({ actionId: "x4", taskId: "tA" }), policy: { ...base, caps: { usd: 1000 } } },
    { want: "task-turns-exceeded", request: requestOf({ actionId: "x5", taskId: "tA" }), policy: { ...base, caps: { usd: 1000, turns: 1000 }, perTask: { turns: 6 } } },
    { want: "task-attempts-exhausted", request: requestOf({ actionId: "x6", taskId: "tA" }), policy: { ...base, caps: { usd: 1000 }, perTask: { attempts: 1 } } },
    { want: "attempt-budget-exceeded", request: requestOf({ actionId: "x7", taskId: "tA", attemptId: "aA" }), policy: { ...base, caps: { usd: 1000 }, perAttempt: { ...base.perAttempt, usd: 1 } } },
    { want: "attempt-turns-exceeded", request: requestOf({ actionId: "x8", taskId: "tA", attemptId: "aA" }), policy: { ...base, caps: { usd: 1000 }, perAttempt: { usd: 1000, turns: 4 } } },
    { want: "attempt-wallclock-exceeded", request: requestOf({ actionId: "x9", taskId: "tA", attemptId: "aA" }), policy: { ...base, caps: { usd: 1000 }, perAttempt: { ...base.perAttempt, wallclockS: 30 } } },
    { want: "external-not-allowed", request: requestOf({ actionId: "x10", authority: { grantedBy: "u", sideEffect: "external" } }), policy: { ...base, caps: { usd: 1000, turns: 1000, wallclockS: 1000 } } },
    { want: "authority-missing", request: requestOf({ actionId: "x11", authority: { grantedBy: "", sideEffect: "none" } }) },
    { want: "estimate-invalid", request: requestOf({ actionId: "x12", estimate: { turns: 2.5 } }) },
  ];
  const hit = new Set<string>();
  for (const c of cases) {
    const r = check(c.policy ?? base, c.request, snap, 100);
    assert.equal(r.allowed, r.denials.length === 0);
    assert.ok(r.denials.some((d) => d.code === c.want), `expected ${c.want}, got ${denialCodes(r).join(",") || "allowed"}`);
    hit.add(c.want);
  }
  // the closed set of codes: every one is exercised above except the
  // defense-in-depth ones which can only fire through reserve (covered there)
  const reachable = new Set([
    "authority-missing", "external-not-allowed", "episode-budget-exceeded", "episode-turns-exceeded",
    "episode-wallclock-exceeded", "task-budget-exceeded", "task-turns-exceeded", "task-attempts-exhausted",
    "attempt-budget-exceeded", "attempt-turns-exceeded", "attempt-wallclock-exceeded", "estimate-invalid",
  ]);
  assert.deepEqual([...reachable].sort(), [...hit].sort(), "sweep must cover every denial code");
  void ledger;
});

// ───────────────────────────── compartment guards ───────────────────────────

async function walkTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { recursive: true })) {
    const p = join(dir, String(e));
    if (p.endsWith(".ts")) out.push(p.replace(/\\/g, "/").replace(/^\.\//, ""));
  }
  return out.sort();
}

test("P8 guard: nothing outside src/budget/ imports the ledger module", async () => {
  const files = await walkTs("src");
  const offenders: string[] = [];
  for (const file of files) {
    if (file.startsWith("src/budget" + "/")) continue;
    const content = await readFile(file, "utf-8").catch(() => "");
    if (/(?:from\s+|import\s*\(\s*)["'][^"']*\/budget\/[a-z]+["']/.test(content)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `the budget authority stays compartmentalized until P9 wires it in: ${offenders.join(", ")}`);
});

test("P8 guard: src/budget imports nothing in the repo except node: builtins", async () => {
  const files = await walkTs(join("src", "budget"));
  assert.ok(files.length >= 1);
  for (const file of files) {
    const content = await readFile(file, "utf-8");
    const specifiers = [...content.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!);
    const foreign = specifiers.filter((s) => !s.startsWith("node:"));
    assert.deepEqual(foreign, [], `${file} must import only node: builtins (found: ${foreign.join(", ")})`);
  }
  const mod = await import("../src/budget/ledger.js");
  assert.equal(typeof mod.BudgetLedger, "function");
  assert.equal(typeof mod.check, "function");
  assert.equal(typeof mod.ActionReceipt, "function");
});
