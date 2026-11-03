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
  resolveRateSource,
  staleReservations,
  validateLedgerRecord,
  type BudgetSnapshot,
  type CheckResult,
  type GatePolicy,
  type GateRequest,
  type LedgerRecord,
  type ReservationCloseRecord,
  type BudgetCloseRequestRecord,
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

test("pricing: exact model beats prefix beats provider; no match is UNKNOWN (A6, never a $0 rate)", () => {
  assert.equal(resolveRate("gpt-4o", "openai"), DEFAULT_RATES.find((e) => e.model === "gpt-4o")!.rate);
  assert.equal(resolveRate("gpt-4o-mini", "openai"), DEFAULT_RATES.find((e) => e.model === "gpt-4o-mini")!.rate);
  assert.equal(resolveRate("claude-sonnet-4-5", "anthropic"), DEFAULT_RATES.find((e) => e.model === "claude-sonnet*")!.rate);
  assert.equal(resolveRate("claude-opus-4", "anthropic"), DEFAULT_RATES.find((e) => e.model === "claude-*")!.rate);
  assert.equal(resolveRate("anything", "openrouter"), DEFAULT_RATES.find((e) => e.provider === "openrouter")!.rate);
  // A6: an unmatched model resolves to NO rate (the absence is meaningful;
  // the old implicit FALLBACK_RATE zero was the audit's unknown-as-zero bug).
  assert.equal(resolveRate("anything", "local"), undefined);
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

test("A6/A9: an unmatched model is the NONNUMERIC unknown state — never a silent zero", () => {
  // The resolver applies NO rate to an unmatched model; FALLBACK_RATE only
  // exists as an explicit operator opt-in (declared override entry), and
  // even that is provenance "override", never an inferred price.
  const src = resolveRateSource("self-hosted-llama", "lab");
  assert.equal(src.rate, undefined);
  assert.equal(src.priced, "unknown");
  const optIn = resolveRateSource("self-hosted-llama", "lab", [{ model: "self-hosted-llama", rate: FALLBACK_RATE }]);
  assert.equal(optIn.priced, "override");
  assert.equal(computeCostUsd({ input: 1_000_000, output: 1_000_000 }, optIn.rate!), 0);
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
  assert.equal(snap.unpricedCount, 0);
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
  // at/after expiry the HOLD REMAINS (A2/F3: an open reservation never
  // evaporates — expiry only blocks NEW admission), and its durable claim
  // survives for staleReservations.
  const expired = projectLedger(records, 100);
  assert.equal(expired.openReservations.length, 1);
  assert.deepEqual(staleReservations(records, 99).map((r) => r.id), ["r1"]);
});

test("A8: spend lineIds fold exactly once; compartment chain charges attempt, task, episode", () => {
  const spend = (lineId: string, cost: number, id: string): LedgerRecord => ({
    schema: LEDGER_SCHEMA_ID, id, ts: 1, episodeId: "ep", taskId: "t", attemptId: "a",
    kind: "spend", lineId, model: "m", provider: "p", usage: { input: 1, output: 1 },
    rates: { input: 0, output: 0 }, costUsd: cost, priced: "table", source: "session",
  });
  const snap = projectLedger([spend("e-1", 0.4, "s1"), spend("e-1", 0.4, "s2"), spend("e-2", 0.6, "s3")], 0);
  const episode = snap.compartments.get(compartmentKey({ episodeId: "ep" }))!;
  const task = snap.compartments.get(compartmentKey({ episodeId: "ep", taskId: "t" }))!;
  const attempt = snap.compartments.get(compartmentKey({ episodeId: "ep", taskId: "t", attemptId: "a" }))!;
  assert.equal(episode.consumedUsd, 1.0);
  assert.equal(task.consumedUsd, 1.0);
  assert.equal(attempt.consumedUsd, 1.0);
  assert.equal(episode.consumedTurns, 2);
  assert.equal(snap.unpricedCount, 0);
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
  assert.ok(denialCodes(mk({ caps: { usd: 99.6 } }, spentEpisode)).includes("episode-budget-exceeded"));

  // episode turns
  const turnsSnap = projectLedger(Array.from({ length: 996 }, (_, i) => ({
    schema: LEDGER_SCHEMA_ID, id: `t${i}`, ts: 1, episodeId: "ep-1", kind: "spend", lineId: `e${i}`,
    model: "m", provider: "p", usage: { input: 1, output: 1 }, rates: { input: 0, output: 0 },
    costUsd: 0, priced: "table", source: "session",
  })) as unknown as LedgerRecord[], 0);
  assert.ok(denialCodes(mk({ caps: { usd: undefined, turns: 996 } }, turnsSnap)).includes("episode-turns-exceeded"));

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

test("D2: reservation floor = class default; caller may raise, never lower; cap below default is a denial", () => {
  const p = policyOf({ perAttempt: { usd: 2, turns: 8 } });
  const noEstimate = check(p, requestOf(), EMPTY, 5);
  assert.equal(noEstimate.allowed, true);
  assert.deepEqual(noEstimate.reserve, { usd: 0.25, turns: 1 });
  assert.equal(noEstimate.estimateRaised, true, "defaulting up from nothing counts as a raise decision");

  const lower = check(p, requestOf({ estimate: { usd: 0.1, turns: 0 } }), EMPTY, 5);
  assert.deepEqual(lower.reserve, { usd: 0.25, turns: 1 }, "a caller lowering below the class default is clamped up (raise-only)");
  assert.equal(lower.estimateRaised, true);

  const higher = check(p, requestOf({ estimate: { usd: 0.5, turns: 3 } }), EMPTY, 5);
  assert.deepEqual(higher.reserve, { usd: 0.5, turns: 3 });
  assert.equal(higher.estimateRaised, false);

  // D2 (F20 fix): a cap BELOW the class default is a DENIAL — never a
  // silent redefinition of the estimate.
  const tiny = check(policyOf({ perAttempt: { usd: 0.1, turns: 1 } }), requestOf(), EMPTY, 5);
  assert.ok(denialCodes(tiny).includes("reserve-default-exceeds-cap"));
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
  assert.equal(rec.ts, now, "F15: the durable (and returned) ts is the injected clock, never 0");
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
  const closed = await ledger.closeReservation(rec.id, "settled", { outcome: "spawned-and-finished", evidence: "stdout:runs/act-1.log" }, { clock: fixedClock(now + 5) });
  assert.equal((closed as ReservationCloseRecord).reason, "settled");
  assert.equal(closed.ts, now + 5, "F15: res-close ts from the injected clock (audit F15)");
  const after = await ledger.snapshotAt(now);
  assert.equal((after.compartments.get(compartmentKey({ episodeId: "ep-1", taskId: "t1" })) ?? { reservedUsd: 0 }).reservedUsd, 0);
  assert.deepEqual(staleReservations((await ledger.read()).records, now), []);
});

test("A2: double-close refused; expired hold NEVER evaporates (A2/F2) — expiry blocks only NEW admission; terminal close required", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const p = policyOf({ reservationTtlMs: 100 });
  const now = 1000;
  const req = requestOf({ taskId: "t1" });
  const checked = check(p, req, await ledger.snapshotAt(now), now);
  const rec = await ledger.reserve(p, req, checked.receipt!, { clock: fixedClock(now) });
  await ledger.closeReservation(rec.id, "released", { outcome: "spawn-failed-unstarted", evidence: "spawn-error:e1", spawnStarted: false }, { clock: fixedClock(now + 1) });
  await assert.rejects(ledger.closeReservation(rec.id, "settled", undefined), (e: unknown) => (e as BudgetLedgerError).code === "bad-ref");
  await assert.rejects(ledger.closeReservation("never-existed", "abandoned", undefined), (e: unknown) => (e as BudgetLedgerError).code === "bad-ref");
  await assert.rejects(ledger.closeReservation(rec.id, "bogus" as never, undefined), (e: unknown) => (e as BudgetLedgerError).code === "bad-input");

  // F2 (audit): past receipt/hold expiry the DURABLE hold remains — it only
  // stops NEW admission (receipt expiry in reserve()); an open reservation
  // is removed exclusively by an evidence-backed terminal close.
  const p2 = policyOf({ reservationTtlMs: 50, caps: { usd: 0.45 } });
  const req2 = requestOf({ actionId: "act-2" });
  const c2 = check(p2, req2, await ledger.snapshotAt(2000), 2000);
  const rec2 = await ledger.reserve(p2, req2, c2.receipt!, { clock: fixedClock(2000) });
  const after2050 = await ledger.snapshotAt(2100);
  assert.ok(after2050.openReservations.some((r) => r.id === rec2.id), "expired-but-open hold still charges the caps (F2)");
  // and it denies NEW admission while it stands: 0.25 hold + 0.25 new floor > 0.5
  const blocked = check(p2, requestOf({ actionId: "act-3" }), after2050, 2100);
  assert.ok(denialCodes(blocked).includes("episode-budget-exceeded"), `expired hold still constrains the gate, got ${denialCodes(blocked).join(",") || "allowed"}`);
  // terminal close is the only way out — and it works even past expiry
  await ledger.closeReservation(rec2.id, "abandoned", { outcome: "supervisor-abandoned", evidence: "decision-intent:di-77" }, { clock: fixedClock(2200) });
  const cleared = await ledger.snapshotAt(2200);
  assert.ok(!cleared.openReservations.some((r) => r.id === rec2.id));
});

test("A1: the reservation is what makes over-spend impossible — concurrent spawns cannot both fit", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const p = policyOf({ caps: { usd: 0.4, turns: 100 }, perAttempt: { usd: 0.4, turns: 1 } });
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
  await ledger.closeReservation(r1.id, "released", { outcome: "spawn-failed-unstarted", evidence: "spawn-error:e0", spawnStarted: false }, { clock: fixedClock(now + 1) });
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
  assert.ok((first[0]!.costUsd ?? 0) > 0);

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
  // self-hosted model with no table match: the NONNUMERIC unknown state
  // (A6) — no costUsd, no rates, counted in unpricedCount, USD admission
  // blocked while any cap exists (never a silent $0).
  const recs = await ledger.ingestEntries(
    [{ id: "e-z", message: { role: "assistant", model: "llama-lab", provider: "lab", usage: { input: 10, output: 2 } } }],
    scope,
  );
  assert.equal(recs[0]!.priced, "unknown");
  assert.equal(recs[0]!.costUsd, undefined);
  const snap = await ledger.snapshotAt(0);
  assert.equal(snap.unpricedCount, 1);

  // frozen at ingest (D1): a later override never reprices history — the
  // record durably carries NO rates/cost even after the table gains an entry.
  const frozen = (await ledger.read()).records[0] as { rates?: unknown; costUsd?: unknown };
  assert.equal(frozen.rates, undefined);
  assert.equal(frozen.costUsd, undefined);
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
    { want: "episode-turns-exceeded", request: requestOf({ actionId: "x2" }), policy: { ...base, caps: { usd: 1000, turns: 5 } } }, // 3 consumed + 2 reserved + 1 floor > 5
    { want: "episode-wallclock-exceeded", request: requestOf({ actionId: "x3" }), policy: { ...base, caps: { usd: 1000, turns: 1000, wallclockS: 99 } } },
    { want: "task-budget-exceeded", request: requestOf({ actionId: "x4", taskId: "tA" }), policy: { ...base, caps: { usd: 1000 }, perTask: { usd: 1.8, turns: 6, attempts: 2 } } }, // 1.2 + 0.5 reserved + 0.25 floor > 1.8
    { want: "task-turns-exceeded", request: requestOf({ actionId: "x5", taskId: "tA" }), policy: { ...base, caps: { usd: 1000, turns: 1000 }, perTask: { turns: 4 } } }, // 2 consumed + 2 reserved + 1 floor > 4
    { want: "task-attempts-exhausted", request: requestOf({ actionId: "x6", taskId: "tA" }), policy: { ...base, caps: { usd: 1000 }, perTask: { attempts: 1 } } },
    { want: "attempt-budget-exceeded", request: requestOf({ actionId: "x7", taskId: "tA", attemptId: "aA" }), policy: { ...base, caps: { usd: 1000 }, perAttempt: { ...base.perAttempt, usd: 1 } } },
    { want: "attempt-turns-exceeded", request: requestOf({ actionId: "x8", taskId: "tA", attemptId: "aA" }), policy: { ...base, caps: { usd: 1000 }, perAttempt: { usd: 1000, turns: 1 } } }, // 1 consumed + 1 floor > 1
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

// C2-F13: one specifier extractor for both guards — static import,
// side-effect import, dynamic import(), export-from (re-export), and
// require(). The OLD ingress regex missed every ".js"-suffixed specifier
// ([a-z]+ before the quote), side-effect imports, and require(); these
// fixtures pin that a no-op guard cannot pass.
const MODULE_SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+|\bexport\s*\[\s*\]\s*from\s*)["']([^"']+)["']/g;
function specifiersOf(content: string): string[] {
  return [...content.matchAll(MODULE_SPEC_RE)].map((m) => m[1]!);
}
/** True when a specifier addresses the budget compartment, whatever the
 *  extension/alias shape (relative ../budget/ledger.js, ./budget/x,
 *  absolute /x/budget/y.ts, bare alias pkg/budget/mod). */
const touchesBudget = (spec: string): boolean => /(^|\/)budget\//.test(spec);

test("P8 guard C2-F13: the specifier extractor catches every import shape (positive fixtures)", () => {
  const shapes = [
    `import { BudgetLedger } from "../budget/ledger.js";`, // static, .js suffix
    `import { check } from "../budget/ledger";`, // extensionless
    `export { check } from "../budget/ledger.js";`, // re-export
    `export * from "./budget/ledger.ts";`, // star re-export
    `const m = await import("../budget/ledger.js");`, // dynamic import
    `const m2 = require("../budget/ledger.js");`, // require
    `import "../budget/ledger.js";`, // side-effect import
    `const lazy = () => import("@app/budget/ledger.mjs");`, // alias, .mjs
  ];
  for (const src of shapes) {
    const specs = specifiersOf(src);
    assert.ok(specs.some(touchesBudget), `fixture MISSED by the extractor: ${src}`);
  }
  // negative fixtures: unrelated modules must NOT trip
  for (const src of [`import { x } from "../util/paths.js";`, `const fs = require("node:fs");`, `export { y } from "./journal.js";`]) {
    assert.ok(!specifiersOf(src).some(touchesBudget), `false positive: ${src}`);
  }
});

test("P8 guard: nothing outside src/budget/ imports the ledger module", async () => {
  const files = await walkTs("src");
  const offenders: string[] = [];
  for (const file of files) {
    if (file.startsWith("src/budget" + "/")) continue;
    const content = await readFile(file, "utf-8").catch(() => "");
    if (specifiersOf(content).some(touchesBudget)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `the budget authority stays compartmentalized until P9 wires it in: ${offenders.join(", ")}`);
});

test("P8 guard: src/budget imports nothing in the repo except node: builtins", async () => {
  const files = await walkTs(join("src", "budget"));
  assert.ok(files.length >= 1);
  for (const file of files) {
    const content = await readFile(file, "utf-8");
    const specifiers = specifiersOf(content);
    const foreign = specifiers.filter((s) => !s.startsWith("node:"));
    assert.deepEqual(foreign, [], `${file} must import only node: builtins (found: ${foreign.join(", ")})`);
  }
  // C2-F13 positive fixture: the egress filter must catch a repo import
  // carrying a .js suffix (the class the old permissive regex missed).
  const egressProbe = `import { helper } from "../kernel/state.js"; import("node:path"); require("../orchestrator/loop.cjs");`;
  const probeForeign = specifiersOf(egressProbe).filter((s) => !s.startsWith("node:"));
  assert.deepEqual(probeForeign, ["../kernel/state.js", "../orchestrator/loop.cjs"], "egress guard must catch .js/.cjs repo imports (C2-F13)");
  const mod = await import("../src/budget/ledger.js");
  assert.equal(typeof mod.BudgetLedger, "function");
  assert.equal(typeof mod.check, "function");
  assert.equal(typeof mod.ActionReceipt, "function");
});

// ─────────────────── C2 fix regressions (audit cycle 2, R1) ─────────────────

const RES_OPEN_BASE = {
  schema: LEDGER_SCHEMA_ID, episodeId: "ep-1", kind: "res-open", actionId: "act-x", action: "run",
  reservedUsd: 0.25, reservedTurns: 1, expiresAt: 5000, grantedBy: "user:x", sideEffect: "none",
  receiptDigest: "a".repeat(64), estimateRaised: false, taskId: "t1", attemptId: "a1",
} as const;

test("C2-F4: a res-close recorded BEFORE its res-open still excludes the hold (order-independent closes)", () => {
  const close = { schema: LEDGER_SCHEMA_ID, id: "c1", ts: 5, episodeId: "ep-1", kind: "res-close", refId: "o1", reason: "expired", attest: { outcome: "ttl-expired-unobserved", evidence: "supervisor:ttl-sweep-1" } };
  const open = { ...RES_OPEN_BASE, id: "o1", ts: 9 };
  const snap = projectLedger([close, open] as unknown as LedgerRecord[], 100_000);
  assert.equal(snap.openReservations.length, 0, "close-before-open must NOT resurrect the hold");
  const usage = snap.compartments.get(compartmentKey({ episodeId: "ep-1", taskId: "t1" })) ?? { reservedUsd: 0 };
  assert.equal(usage.reservedUsd, 0, "no USD hold from a closed ref, whatever the file order");
});

test("C3-F4: an unattested terminal res-close is schema-INVALID and never erases a hold (evidence-only rebuild)", () => {
  // The validator no longer exempts "legacy/observed" bare terminal closes.
  assert.throws(
    () => validateLedgerRecord({ schema: LEDGER_SCHEMA_ID, id: "x1", ts: 1, episodeId: "ep-1", kind: "res-close", refId: "o1", reason: "settled" }),
    (e: unknown) => (e as BudgetLedgerError).code === "schema",
  );
  // A half-present attestation is a schema lie too.
  assert.throws(
    () => validateLedgerRecord({ schema: LEDGER_SCHEMA_ID, id: "x2", ts: 1, episodeId: "ep-1", kind: "res-close", refId: "o1", reason: "settled", attest: { outcome: "done" } }),
    (e: unknown) => (e as BudgetLedgerError).code === "schema",
  );
  // Defense in depth: a bare close that reaches the fold from an older
  // byte stream removes NOTHING — the hold stands until evidenced.
  const open = { ...RES_OPEN_BASE, id: "o-legacy", ts: 2 };
  const bareClose = { schema: LEDGER_SCHEMA_ID, id: "cc-legacy", ts: 3, episodeId: "ep-1", kind: "res-close", refId: "o-legacy", reason: "settled" };
  const snap = projectLedger([open, bareClose] as unknown as LedgerRecord[], 100);
  assert.equal(snap.openReservations.length, 1, "an unattested terminal record erases no hold");
  const attested = { ...bareClose, id: "cc-ev", attest: { outcome: "spawned-and-finished", evidence: "stdout:runs/act-1.log" } };
  const snap2 = projectLedger([open, attested] as unknown as LedgerRecord[], 100);
  assert.equal(snap2.openReservations.length, 0, "an evidenced terminal close DOES close the trail");
});

test("C2-F5: replayed res-open folds first-wins — no double attempt slot, no double strategy use", () => {
  const r1 = { ...RES_OPEN_BASE, id: "dup-o", strategyId: "s-1", ts: 2 };
  const snap = projectLedger([r1, { ...r1 }] as unknown as LedgerRecord[], 100);
  assert.deepEqual(snap.duplicateIds, ["dup-o"], "the replay is REPORTED");
  assert.equal(snap.attemptsUsed.get(JSON.stringify(["ep-1", "t1"])), 1, "one attempt used, not two");
  assert.equal(snap.strategyUses.get(JSON.stringify(["ep-1", "t1", "s-1"])), 1, "one strategy use, not two");
  assert.equal(snap.openReservations.length, 1);
});

test("C2-F6: unattested close is a recorded REQUEST only — hold stands; attested release requires negative spawn evidence", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const now = 1000;
  const p = policyOf({ reservationTtlMs: 60_000 });
  const req = requestOf({ taskId: "t1" });
  const checked = check(p, req, await ledger.snapshotAt(now), now);
  const rec = await ledger.reserve(p, req, checked.receipt!, { clock: fixedClock(now) });

  // unattested: writes close-request, changes nothing
  const reqd = await ledger.closeReservation(rec.id, "released", undefined, { clock: fixedClock(now + 1) });
  assert.equal(reqd.kind, "close-request", "unattested close never terminates the reservation (C2-F6)");
  const stillOpen = await ledger.snapshotAt(now + 2);
  assert.ok(stillOpen.openReservations.some((r) => r.id === rec.id), "the hold STANDS after a bare close request");

  // released WITHOUT spawnStarted===false is refused
  await assert.rejects(
    ledger.closeReservation(rec.id, "released", { outcome: "spawn-failed-unstarted", evidence: "log:x" }, { clock: fixedClock(now + 3) }),
    (e: unknown) => (e as BudgetLedgerError).code === "attest-required",
  );
  // malformed attestation refused before I/O
  await assert.rejects(
    ledger.closeReservation(rec.id, "settled", { outcome: "  ", evidence: "log:x" }, { clock: fixedClock(now + 4) }),
    (e: unknown) => (e as BudgetLedgerError).code === "bad-input",
  );

  // attested settled terminates
  const closed = await ledger.closeReservation(rec.id, "settled", { outcome: "spawned-and-finished", evidence: "stdout:runs/act-1.log" }, { clock: fixedClock(now + 5) });
  assert.equal(closed.kind, "res-close");
  const cleared = await ledger.snapshotAt(now + 6);
  assert.ok(!cleared.openReservations.some((r) => r.id === rec.id));
});

test("C3-F4 projection: a bare 'released' close is ignored (hold stands); an unevidenced attest removes the hold but NEVER refunds the attempt slot", () => {
  const open = { ...RES_OPEN_BASE, id: "o-slot", ts: 2 };
  // C3-F4: a terminal close with NO attest removes nothing (fold defense
  // in depth — the validator rejects these outright on read).
  const bareClose = { schema: LEDGER_SCHEMA_ID, id: "cc1", ts: 3, episodeId: "ep-1", kind: "res-close", refId: "o-slot", reason: "released" };
  const snapBare = projectLedger([open, bareClose] as unknown as LedgerRecord[], 100);
  assert.equal(snapBare.openReservations.length, 1, "an unattested terminal record erases no hold (C3-F4)");
  // An ATTESTED release without the negative-spawn evidence removes the
  // hold (terminal fact) but never refunds the slot (A8/C2-F6).
  const plainAttest = { ...bareClose, id: "cc1b", attest: { outcome: "abandoned-by-supervisor", evidence: "decision:abandon-7" } };
  const snap = projectLedger([open, plainAttest] as unknown as LedgerRecord[], 100);
  assert.equal(snap.openReservations.length, 0);
  assert.equal(snap.attemptsUsed.get(JSON.stringify(["ep-1", "t1"])), 1, "release without spawnStarted:false never refunds the slot (A8/C2-F6)");
  const attestClose = { ...bareClose, id: "cc2", attest: { outcome: "spawn-failed-unstarted", evidence: "spawn-error:e1", spawnStarted: false } };
  const snap2 = projectLedger([open, attestClose] as unknown as LedgerRecord[], 100);
  assert.equal(snap2.attemptsUsed.get(JSON.stringify(["ep-1", "t1"])), 0, "evidenced release DOES refund");
});

test("C2-F6 schema: half-present attest is refused; full attest validates", () => {
  const base = { schema: LEDGER_SCHEMA_ID, id: "ac1", ts: 1, episodeId: "ep-1", kind: "res-close", refId: "o", reason: "released" };
  assert.throws(() => validateLedgerRecord({ ...base, attest: { outcome: "x" } }), (e: unknown) => (e as BudgetLedgerError).code === "schema");
  assert.throws(() => validateLedgerRecord({ ...base, attest: { outcome: "", evidence: "e" } }), (e: unknown) => (e as BudgetLedgerError).code === "schema");
  assert.throws(() => validateLedgerRecord({ ...base, attest: { outcome: "x", evidence: "e", spawnStarted: "no" } }), (e: unknown) => (e as BudgetLedgerError).code === "schema");
  validateLedgerRecord({ ...base, attest: { outcome: "spawn-failed-unstarted", evidence: "spawn-error:e1", spawnStarted: false } });
  validateLedgerRecord({ schema: LEDGER_SCHEMA_ID, id: "cr1", ts: 1, episodeId: "ep-1", kind: "close-request", refId: "o", reason: "settled" });
});

test("C2-F7: a clock that jumps evil ONLY at the write stamp can no longer persist a ts past expiresAt", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const p = policyOf({ reservationTtlMs: 10 }); // expiresAt = 11
  const req = requestOf();
  const checked = check(p, req, await ledger.snapshotAt(1), 1);
  const stamps = [1, 1, 1000]; // preverify, admission, WRITE stamp
  let i = 0;
  await assert.rejects(
    ledger.reserve(p, req, checked.receipt!, { clock: () => stamps[Math.min(i++, stamps.length - 1)]! }),
    (e: unknown) => (e as BudgetLedgerError).code === "receipt-invalid" && /durable write/.test((e as Error).message),
  );
  const after = await ledger.read();
  assert.equal(after.records.length, 0, "nothing durable was written under the evil stamp");
});

test("C2-F9: a non-finite or negative `now` never mints an allow; overflow expiry arithmetic is refused", () => {
  const p = policyOf();
  assert.throws(() => check(p, requestOf(), EMPTY, NaN), (e: unknown) => (e as BudgetLedgerError).code === "bad-input");
  assert.throws(() => check(p, requestOf(), EMPTY, Infinity), (e: unknown) => (e as BudgetLedgerError).code === "bad-input");
  assert.throws(() => check(p, requestOf(), EMPTY, -5), (e: unknown) => (e as BudgetLedgerError).code === "bad-input");
  // MAX_VALUE + ttl must not mint expiresAt === now (comparison dead) — overflow refused
  assert.throws(() => check(p, requestOf(), EMPTY, Number.MAX_VALUE), (e: unknown) => (e as BudgetLedgerError).code === "bad-input");
});

test("C2-F9: verify() refuses a non-finite presented time (NaN comparisons never pass)", async () => {
  const p = policyOf({ reservationTtlMs: 60_000 });
  const checked = check(p, requestOf(), EMPTY, 1000);
  assert.ok(checked.allowed);
  const ok = await checked.receipt!.verify({ action: "run", actionId: "act-1", episodeId: "ep-1" }, NaN);
  assert.equal(ok.ok, false);
});

test("C2-F10: idempotent redelivery re-validates the policy — a poisoned cap or a revoked policy is typed, not silent success", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const p = policyOf({ reservationTtlMs: 60_000 });
  const req = requestOf();
  const checked = check(p, req, await ledger.snapshotAt(1000), 1000);
  await ledger.reserve(p, req, checked.receipt!, { clock: fixedClock(1000) });

  // poisoned policy (NaN caps) — even the idempotent branch must throw
  const poisoned = { ...p, caps: { usd: NaN } };
  await assert.rejects(
    ledger.reserve(poisoned, req, checked.receipt!, { clock: fixedClock(1000) }),
    (e: unknown) => (e as BudgetLedgerError).code === "bad-input",
  );
  // revoked policy (cap below the standing reservation) — typed policy-revoked, observation-only
  const revoked = policyOf({ reservationTtlMs: 60_000, caps: { usd: 0.01 } });
  await assert.rejects(
    ledger.reserve(revoked, req, checked.receipt!, { clock: fixedClock(1000) }),
    (e: unknown) => (e as BudgetLedgerError).code === "policy-revoked",
  );
});

test("C2-F11: rewriting the raw estimate (below floor or absent) after check refuses — raise provenance is the mint decision", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const p = policyOf({ reservationTtlMs: 60_000 });

  // no estimate at check time → supplying one before reserve is refused
  const reqNoEst = requestOf({ actionId: "act-r1" });
  const c1 = check(p, reqNoEst, await ledger.snapshotAt(1000), 1000);
  assert.ok(c1.allowed);
  await assert.rejects(
    ledger.reserve(p, { ...reqNoEst, estimate: { usd: 0.25, turns: 1 } }, c1.receipt!, { clock: fixedClock(1000) }),
    (e: unknown) => (e as BudgetLedgerError).code === "receipt-mismatch",
  );

  // .01 → .02 below-floor rewrite refused
  const reqLow = requestOf({ actionId: "act-r2", estimate: { usd: 0.01 } });
  const c2 = check(p, reqLow, await ledger.snapshotAt(1000), 1000);
  await assert.rejects(
    ledger.reserve(p, { ...reqLow, estimate: { usd: 0.02 } }, c2.receipt!, { clock: fixedClock(1000) }),
    (e: unknown) => (e as BudgetLedgerError).code === "receipt-mismatch",
  );
  const after = await ledger.read();
  assert.equal(after.records.filter((r) => r.kind === "res-open").length, 0, "neither rewrite wrote a hold");
});

test("C2-F1: mutation of the caller's request object across awaits changes NOTHING (frozen sync snapshot)", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const p = policyOf({ reservationTtlMs: 60_000 });
  const req = requestOf({ actionId: "orig-act", taskId: "orig-task", attemptId: "orig-attempt" });
  const checked = check(p, req, await ledger.snapshotAt(1000), 1000);
  // the audit's exploit: rebind identity fields the instant reserve() yields
  queueMicrotask(() => {
    req.actionId = "new-action";
    (req as { taskId?: string }).taskId = "unbound-task";
    (req as { attemptId?: string }).attemptId = "unbound-attempt";
  });
  const rec = await ledger.reserve(p, req, checked.receipt!, { clock: fixedClock(1000) });
  assert.equal(rec.actionId, "orig-act", "the durable intent names the SNAPSHOT, not the mutated live object");
  assert.equal(rec.taskId, "orig-task");
  assert.equal(rec.attemptId, "orig-attempt");
});

test("C2-F2: swapping policy.authority.root between check and reserve is refused (root is receipt-bound)", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const authA = { paths: ["**"], allowInstalls: false, allowNetwork: false, approvedModels: [] as string[] };
  const pA = policyOf({ reservationTtlMs: 60_000, authority: { ...authA, root: "/work/a" } });
  const pB = policyOf({ reservationTtlMs: 60_000, authority: { ...authA, root: "/work/b" } });
  const req = requestOf({ actionId: "act-root", paths: ["secret"] });
  const checked = check(pA, req, await ledger.snapshotAt(1000), 1000);
  assert.ok(checked.allowed, "granted under root A");
  await assert.rejects(
    ledger.reserve(pB, req, checked.receipt!, { clock: fixedClock(1000) }),
    (e: unknown) => (e as BudgetLedgerError).code === "receipt-mismatch",
  );
});

test("C2-F3: an injected real-path resolver denies symlink escape; absent resolver = documented lexical-only judgment", async () => {
  const { symlinkSync, mkdirSync, realpathSync, existsSync } = await import("node:fs");
  const dir = await freshDir();
  const mkdirRoot = join(dir, "root");
  const mkdirOutside = join(dir, "outside");
  mkdirSync(join(mkdirRoot, "inner"), { recursive: true });
  mkdirSync(mkdirOutside, { recursive: true });
  symlinkSync(mkdirOutside, join(mkdirRoot, "link"));
  // pin the policy root to its REAL path (macOS tmpdir is itself a
  // symlink; without this every resolve would look like an escape).
  const root = realpathSync(mkdirRoot);
  const outside = realpathSync(mkdirOutside);
  const resolver = (abs: string): string | undefined => {
    // contract: resolve the LONGEST EXISTING prefix through symlinks,
    // append the nonexistent remainder verbatim; failure → undefined.
    try {
      let cur = abs;
      const rest: string[] = [];
      while (!existsSync(cur)) {
        const parent = cur.slice(0, cur.lastIndexOf("/"));
        if (parent === "" || parent === cur) return undefined;
        rest.unshift(cur.slice(parent.length + 1));
        cur = parent;
      }
      const real = realpathSync(cur);
      return rest.length > 0 ? `${real}/${rest.join("/")}` : real;
    } catch { return undefined; }
  };
  const base = { paths: ["**"], root };
  // lexical-only: the gate sees root/link/secret — allowed (documented)
  const lex = check(policyOf({ authority: { ...base } }), requestOf({ paths: ["link/secret"] }), EMPTY, 1000);
  assert.ok(lex.allowed, "without a resolver the guarantee is lexical (pinned in docs)");
  // with the resolver: realpath escapes the root → denied
  const real = check(policyOf({ authority: { ...base, resolveRealPath: resolver } }), requestOf({ paths: ["link/secret"] }), EMPTY, 1000);
  assert.ok(denialCodes(real).includes("path-not-granted"), "symlink escape denied (C2-F3)");
  // a nonexistent leaf resolves safely (no throw, stays inside)
  const leaf = check(policyOf({ authority: { ...base, resolveRealPath: resolver } }), requestOf({ paths: ["inner/nope/deep.txt"] }), EMPTY, 1000);
  assert.ok(leaf.allowed, "nonexistent leaf under an in-root dir is fine");
  // resolver failure fails CLOSED
  const failing = check(policyOf({ authority: { ...base, resolveRealPath: () => undefined } }), requestOf({ paths: ["inner/x.txt"] }), EMPTY, 1000);
  assert.ok(denialCodes(failing).includes("path-not-granted"), "resolver failure denies (fail closed)");
});

test("C2-F12: a terminated trailing blank line is normalized DURABLY at open — later appends stay honest", async () => {
  const dir = await freshDir();
  const path = join(dir, "budget.jsonl");
  const ok = { schema: LEDGER_SCHEMA_ID, id: "w1", ts: 1, episodeId: "ep-1", kind: "wallclock", taskId: "t", seconds: 1 };
  await writeFile(path, JSON.stringify(ok) + "\n\n", "utf8"); // terminated + blank
  const ledger = await BudgetLedger.open(path);
  assert.equal(ledger.tornTailRepaired, true, "open normalized the terminated blank tail (C2-F12)");
  await ledger.recordWallclock({ episodeId: "ep-1", taskId: "t" }, 5, { clock: fixedClock(10) });
  const after = await ledger.read(); // the audit's poison-after-append: used to throw corrupt
  assert.equal(after.records.length, 2);
  const raw = await readFile(path, "utf8");
  assert.ok(raw.endsWith("\n") && !raw.endsWith("\n\n"), "no blank tail survives");
});

test("C2-F8: settle does not erase counted downtime; explicit windows are not double-counted with live intervals", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const p = policyOf({ reservationTtlMs: 60_000 });
  const req = requestOf({ actionId: "act-w", taskId: "t1", attemptId: "a1" });
  const checked = check(p, req, await ledger.snapshotAt(1000), 1000);
  const rec = await ledger.reserve(p, req, checked.receipt!, { clock: fixedClock(1000) });
  const mid = await ledger.snapshotAt(101_000); // 100s live downtime accrued
  const key = JSON.stringify(["ep-1", "t1", "a1"]);
  assert.equal(mid.attemptWallclockS.get(key), 100, "100s accrued while open");
  await ledger.closeReservation(rec.id, "settled", { outcome: "spawned-and-finished", evidence: "stdout:runs/act-w.log" }, { clock: fixedClock(101_000) });
  const after = await ledger.snapshotAt(101_000);
  assert.equal(after.attemptWallclockS.get(key), 100, "the closed [1000,101000] window still counts (C2-F8: no erase at close)");
  // explicit supervisor window takes precedence — no overlap double count
  const p2 = policyOf({ reservationTtlMs: 60_000 });
  const req2 = requestOf({ actionId: "act-w2", taskId: "t2", attemptId: "a2" });
  const c2 = check(p2, req2, await ledger.snapshotAt(2000), 2000);
  await ledger.reserve(p2, req2, c2.receipt!, { clock: fixedClock(2000) });
  await ledger.recordWallclock({ episodeId: "ep-1", taskId: "t2", attemptId: "a2" }, 100, { clock: fixedClock(2000) });
  const snap2 = await ledger.snapshotAt(102_000);
  assert.equal(snap2.attemptWallclockS.get(JSON.stringify(["ep-1", "t2", "a2"])), 100, "explicit window owns the attempt's time — no 200s double count (C2-F8)");
});

test("C2-F8: a ts=0 reservation is a valid interval anchor and contributes elapsed", () => {
  const open0 = { ...RES_OPEN_BASE, id: "o-zero", ts: 0 };
  const snap = projectLedger([open0] as unknown as LedgerRecord[], 100);
  assert.equal(snap.attemptWallclockS.get(JSON.stringify(["ep-1", "t1", "a1"])), 0.1, "epoch 0 anchors elapsed (C2-F8)");
});

// ─────────────────── C3 fix regressions (audit cycle 3) ────────────────────

test("C3-F7: idempotent redelivery under an UNCHANGED valid policy at its own cap is NOT false revocation (coverage, not a second hold)", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  // cap exactly equals the default run reservation: the old recheck added
  // a hypothetical SECOND .25 on top of the standing .25 and lied.
  const p = policyOf({ reservationTtlMs: 60_000, caps: { usd: 0.25, turns: 1000 } });
  const req = requestOf({ actionId: "act-cap" });
  const checked = check(p, req, await ledger.snapshotAt(1000), 1000);
  assert.ok(checked.allowed, ".25 reservation fits the .25 cap exactly");
  const first = await ledger.reserve(p, req, checked.receipt!, { clock: fixedClock(1000) });
  const again = await ledger.reserve(p, req, checked.receipt!, { clock: fixedClock(1000) });
  assert.equal(again.id, first.id, "same record back — no second reservation, no false policy-revoked");
  // and real revocation STILL refuses: cap lowered below the intent (C2-F10 suite)
  // or a flipped external flag on the policy PRESENTED to the redelivering call:
  const pNoExt = policyOf({ reservationTtlMs: 60_000, caps: { usd: 100, turns: 1000 }, allowExternalEffects: true });
  const reqExt = requestOf({ actionId: "act-cap-x", authority: { grantedBy: "user:p8-suite", sideEffect: "external" } });
  const cExt = check(pNoExt, reqExt, EMPTY, 1000);
  assert.ok(cExt.allowed);
  await ledger.reserve(pNoExt, reqExt, cExt.receipt!, { clock: fixedClock(1000) });
  const pRevoked = policyOf({ reservationTtlMs: 60_000, caps: { usd: 100, turns: 1000 }, allowExternalEffects: false });
  await assert.rejects(
    ledger.reserve(pRevoked, reqExt, cExt.receipt!, { clock: fixedClock(1000) }),
    (e: unknown) => (e as BudgetLedgerError).code === "policy-revoked",
    "flipping allowExternalEffects between the first reserve and the redelivery is real revocation",
  );
});

test("C3-F1: mutating the LIVE policy after reserve() began redirects NOTHING — the durable intent is the call-time snapshot", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const p = policyOf({ reservationTtlMs: 60_000, authority: { root: "/work/a", paths: ["**"] } });
  const req = requestOf({ actionId: "act-pol", paths: ["secret"] });
  const checked = check(p, req, await ledger.snapshotAt(1000), 1000);
  assert.ok(checked.allowed);
  const inflight = ledger.reserve(p, req, checked.receipt!, { clock: fixedClock(1000) });
  // the audit's attack, one tick into the call:
  p.episodeId = "changed";
  p.authority!.root = "/new";
  const rec = await inflight;
  assert.equal(rec.episodeId, "ep-1", "durable episode is the CALL-TIME snapshot, not the mutated object");
  assert.ok(rec.paths !== undefined && rec.paths.every((x) => x.startsWith("/work/a/")), "paths canonicalize under the call-time root (no /new/secret redirect)");
  // the contract is call-time policy: flipping external OFF mid-call cannot
  // retroactively poison a call that was external-granted when presented…
  const pE = policyOf({ reservationTtlMs: 60_000, allowExternalEffects: true });
  const reqE = requestOf({ actionId: "act-pol-ext", authority: { grantedBy: "user:p8-suite", sideEffect: "external" } });
  const cE = check(pE, reqE, EMPTY, 1000);
  const inflightE = ledger.reserve(pE, reqE, cE.receipt!, { clock: fixedClock(1000) });
  pE.allowExternalEffects = false;
  const recE = await inflightE;
  assert.equal(recE.sideEffect, "external", "the policy as PRESENTED at call time governs admission");
  // …while a FRESH revoked policy object on the next call refuses (C2-F10/C3-F7).
  await assert.rejects(
    ledger.reserve(policyOf({ reservationTtlMs: 60_000, allowExternalEffects: false }), reqE, cE.receipt!, { clock: fixedClock(1000) }),
    (e: unknown) => (e as BudgetLedgerError).code === "policy-revoked",
  );
});

test("C3-F2: overlapping intervals fold as a UNION per attempt — closed/live and closed/closed never double-count", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const p = policyOf({ reservationTtlMs: 60_000 });
  const run = requestOf({ actionId: "act-u1", taskId: "t1", attemptId: "a1" });
  const resume = requestOf({ action: "resume", actionId: "act-u2", taskId: "t1", attemptId: "a1" });
  const c1 = check(p, run, await ledger.snapshotAt(0), 0);
  assert.ok(c1.allowed);
  const runRec = await ledger.reserve(p, run, c1.receipt!, { clock: fixedClock(0) });
  const c2 = check(p, resume, await ledger.snapshotAt(10_000), 10_000);
  assert.ok(c2.allowed);
  await ledger.reserve(p, resume, c2.receipt!, { clock: fixedClock(10_000) });
  await ledger.closeReservation(runRec.id, "settled", { outcome: "spawned-and-finished", evidence: "stdout:runs/act-u1.log" }, { clock: fixedClock(100_000) });
  const key = JSON.stringify(["ep-1", "t1", "a1"]);
  const snap = await ledger.snapshotAt(100_000);
  // closed [0,100000] ∪ live [10000,100000] = 100s — the old sum said 190.
  assert.equal(snap.attemptWallclockS.get(key), 100, "run+resume on one attempt span 100s, never 190 (C3-F2)");
  // closed/closed overlap through the fold directly: [0,50000] ∪ [10000,60000] = 60s
  const o1 = { ...RES_OPEN_BASE, id: "ov1", ts: 0 };
  const o2 = { ...RES_OPEN_BASE, id: "ov2", ts: 10_000 };
  const cc1 = { schema: LEDGER_SCHEMA_ID, id: "occ1", ts: 50_000, episodeId: "ep-1", kind: "res-close", refId: "ov1", reason: "settled", attest: { outcome: "done", evidence: "stdout:o1.log" } };
  const cc2 = { schema: LEDGER_SCHEMA_ID, id: "occ2", ts: 60_000, episodeId: "ep-1", kind: "res-close", refId: "ov2", reason: "settled", attest: { outcome: "done", evidence: "stdout:o2.log" } };
  const snap2 = projectLedger([o1, o2, cc1, cc2] as unknown as LedgerRecord[], 100_000);
  assert.equal(snap2.attemptWallclockS.get(JSON.stringify(["ep-1", "t1", "a1"])), 60, "two overlapping settled windows count once (C3-F2)");
});

test("C3-F3: a duplicate-ID wallclock is dropped ENTIRELY — it never marks the attempt explicitly-timed and erases live elapsed", () => {
  const open = { ...RES_OPEN_BASE, id: "o", ts: 0 };
  const wall = { schema: LEDGER_SCHEMA_ID, id: "o", ts: 1, episodeId: "ep-1", kind: "wallclock", taskId: "t1", attemptId: "a1", seconds: 1 };
  const snap = projectLedger([open, wall] as unknown as LedgerRecord[], 100_000);
  assert.ok(snap.duplicateIds.includes("o"), "the cross-kind duplicate is still REPORTED");
  assert.equal(
    snap.attemptWallclockS.get(JSON.stringify(["ep-1", "t1", "a1"])),
    100,
    "the skipped wallclock contributes nothing AND suppresses nothing — live elapsed survives (C3-F3)",
  );
});

test("C3-F4 reopen: a file carrying an evidence-free terminal res-close is CORRUPTION at open — it cannot silently erase the hold", async () => {
  const dir = await freshDir();
  const path = join(dir, "budget.jsonl");
  const open = { ...RES_OPEN_BASE, id: "o-evil", ts: 1 };
  const bareClose = { schema: LEDGER_SCHEMA_ID, id: "cc-evil", ts: 2, episodeId: "ep-1", kind: "res-close", refId: "o-evil", reason: "settled" };
  await writeFile(path, JSON.stringify(open) + "\n" + JSON.stringify(bareClose) + "\n", "utf8");
  await assert.rejects(
    BudgetLedger.open(path),
    (e: unknown) => (e as BudgetLedgerError).code === "corrupt",
    "a legacy/untrusted bare terminal close fails closed on rebuild (C3-F4)",
  );
});

test("C3-F5: the standalone verifier refuses a NEGATIVE clock — the spawn-consumer seam matches check()/reserve admission", async () => {
  const p = policyOf({ reservationTtlMs: 60_000 });
  const checked = check(p, requestOf(), EMPTY, 1000);
  assert.ok(checked.allowed);
  const neg = await checked.receipt!.verify({ action: "run", actionId: "act-1", episodeId: "ep-1" }, -1);
  assert.equal(neg.ok, false, "verify(-1) must refuse — a negative clock is not a moment (C3-F5)");
  const ok = await checked.receipt!.verify({ action: "run", actionId: "act-1", episodeId: "ep-1" }, 1000);
  assert.equal(ok.ok, true, "the good path still passes");
});

for (const [name, suffix] of [["three blank lines", "\n\n\n"], ["blank + whitespace", "\n\n \t\n"]] as const) {
  test(`C3-F6: an EOF suffix of ${name} normalizes at open instead of throwing corrupt mid-read`, async () => {
    const dir = await freshDir();
    const path = join(dir, "budget.jsonl");
    const ok = { schema: LEDGER_SCHEMA_ID, id: "w1", ts: 1, episodeId: "ep-1", kind: "wallclock", taskId: "t", seconds: 1 };
    await writeFile(path, JSON.stringify(ok) + suffix, "utf8");
    const ledger = await BudgetLedger.open(path); // used to throw on the FIRST trailing blank
    assert.equal(ledger.tornTailRepaired, true, `the ${name} suffix is cut durably`);
    const before = await ledger.read();
    assert.equal(before.records.length, 1);
    await ledger.recordWallclock({ episodeId: "ep-1", taskId: "t" }, 5, { clock: fixedClock(10) });
    const after = await ledger.read();
    assert.equal(after.records.length, 2, "later honest appends work");
    const raw = await readFile(path, "utf8");
    assert.ok(raw.endsWith("\n") && !raw.endsWith("\n\n"), "no blank suffix survives");
  });
}

test("C3-F6: a whitespace-only multi-line ledger opens empty; a blank line BEFORE a real record stays fail-closed", async () => {
  const dir = await freshDir();
  const path1 = join(dir, "budget-ws.jsonl");
  await writeFile(path1, "\n\t\n", "utf8");
  const ws = await BudgetLedger.open(path1);
  assert.equal((await ws.read()).records.length, 0, "whitespace-only file is an empty ledger");
  const path2 = join(dir, "budget-mid.jsonl");
  const ok = { schema: LEDGER_SCHEMA_ID, id: "w2", ts: 1, episodeId: "ep-1", kind: "wallclock", taskId: "t", seconds: 1 };
  await writeFile(path2, "\n" + JSON.stringify(ok) + "\n", "utf8");
  await assert.rejects(
    BudgetLedger.open(path2),
    (e: unknown) => (e as BudgetLedgerError).code === "corrupt",
    "blank line 1 before a real record is mid-file corruption — unchanged (C3-F6 boundary)",
  );
});

// ─────────────────── audit c4 regressions ───────────────────

for (const [name, suffix] of [
  ["unterminated `\\n\\n \\t` (the audit-c4 repro)", "\n\n \t"],
  ["unterminated `\\n\\n\\n \\t`", "\n\n\n \t"],
  ["unterminated single trailing space", " "],
] as const) {
  test(`C4-F1: EOF suffix ${name} normalizes COMPLETELY — append then reopen stays clean`, async () => {
    const dir = await freshDir();
    const path = join(dir, "budget.jsonl");
    const ok = { schema: LEDGER_SCHEMA_ID, id: "w1", ts: 1, episodeId: "ep-1", kind: "wallclock", taskId: "t", seconds: 1 };
    await writeFile(path, JSON.stringify(ok) + suffix, "utf8"); // NO trailing newline — unterminated suffix
    const ledger = await BudgetLedger.open(path);
    assert.equal(ledger.tornTailRepaired, true, `the ${name} suffix is repaired at open`);
    await ledger.recordWallclock({ episodeId: "ep-1", taskId: "t" }, 5, { clock: fixedClock(10) });
    // the audit's killer step: the OLD repair left a blank line that the
    // honest append planted mid-file — the reopen threw corrupt:blank.
    const reopened = await BudgetLedger.open(path);
    const after = await reopened.read();
    assert.equal(after.records.length, 2, "both records survive the repair+append+reopen cycle");
    const raw = await readFile(path, "utf8");
    assert.ok(raw.endsWith("\n") && !raw.endsWith("\n\n"), "no blank suffix survives the cycle");
    assert.equal(JSON.parse(raw.split("\n")[0]!).id, "w1", "the first record kept its own terminator (no append fusion)");
  });
}

test("C4-F1: a record line with trailing spaces before an unterminated blank suffix keeps ITS newline (no unterminated survivor)", async () => {
  const dir = await freshDir();
  const path = join(dir, "budget.jsonl");
  const ok = { schema: LEDGER_SCHEMA_ID, id: "w3", ts: 1, episodeId: "ep-1", kind: "wallclock", taskId: "t", seconds: 1 };
  // trailing space on the RECORD's own line, then an unterminated blank suffix:
  // cutting to (last non-WS byte)+1 would drop the newline and fuse records.
  await writeFile(path, JSON.stringify(ok) + " \n \t", "utf8");
  const ledger = await BudgetLedger.open(path);
  assert.equal(ledger.tornTailRepaired, true, "suffix repaired at open");
  await ledger.recordWallclock({ episodeId: "ep-1", taskId: "t" }, 5, { clock: fixedClock(10) });
  const reopened = await BudgetLedger.open(path);
  const after = await reopened.read();
  assert.equal(after.records.length, 2, "the record did not fuse with the append (blank-line-2 corrupt)");
  assert.equal(after.records[0]!.id, "w3");
});

test("C4-F1: a whitespace-only UNTERMINATED file opens empty and stays writable", async () => {
  const dir = await freshDir();
  const path = join(dir, "budget-ws-unterm.jsonl");
  await writeFile(path, "\n \t", "utf8"); // no trailing newline
  const ws = await BudgetLedger.open(path);
  assert.equal((await ws.read()).records.length, 0, "whitespace-only file is an empty ledger");
  await ws.recordWallclock({ episodeId: "ep-1", taskId: "t" }, 5, { clock: fixedClock(10) });
  const reopened = await BudgetLedger.open(path);
  assert.equal((await reopened.read()).records.length, 1, "clean append + clean reopen");
});

test("C4-F2: redelivery after the attempt accrued past a TIGHTENED perAttempt wallclock cap refuses policy-revoked", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const p = policyOf({ reservationTtlMs: 1_000_000 });
  const req = requestOf({ actionId: "act-wc-att", taskId: "t-wc", attemptId: "a-wc" });
  const checked = check(p, req, await ledger.snapshotAt(0), 0);
  assert.ok(checked.allowed);
  const first = await ledger.reserve(p, req, checked.receipt!, { clock: fixedClock(0) });
  // 100 s of live hold accrue on the attempt...
  const mid = await ledger.snapshotAt(100_000);
  assert.ok((mid.attemptWallclockS.get(JSON.stringify(["ep-1", "t-wc", "a-wc"])) ?? 0) >= 100, "snapshot itself reports the accrued 100 s");
  // ...then the cap tightens to 50 s and the SAME receipt is redelivered.
  const pTight = policyOf({ reservationTtlMs: 1_000_000, perAttempt: { usd: 1, turns: 5, wallclockS: 50 } });
  await assert.rejects(
    ledger.reserve(pTight, req, checked.receipt!, { clock: fixedClock(100_000) }),
    (e: unknown) => (e as BudgetLedgerError).code === "policy-revoked",
    "accrued elapsed time is durable fact — a cap below it revokes the redelivery (C4-F2)",
  );
  // the standing record is untouched (observation-only revocation):
  const after = await ledger.read();
  assert.ok(after.records.some((r) => r.kind === "res-open" && r.id === first.id));
});

test("C4-F2: episode-level wallclock accrual revokes redelivery the same way", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const p = policyOf({ reservationTtlMs: 1_000_000 });
  // attemptId present so the live hold accrues interval time; the DENIAL
  // comes from the tightened EPISODE wallclock cap (summed over tasks).
  const req = requestOf({ actionId: "act-wc-ep", taskId: "t-ep", attemptId: "a-ep2" });
  const checked = check(p, req, await ledger.snapshotAt(0), 0);
  assert.ok(checked.allowed);
  await ledger.reserve(p, req, checked.receipt!, { clock: fixedClock(0) });
  const pTight = policyOf({ reservationTtlMs: 1_000_000, caps: { usd: 100, turns: 1000, wallclockS: 50 } });
  await assert.rejects(
    ledger.reserve(pTight, req, checked.receipt!, { clock: fixedClock(100_000) }),
    (e: unknown) => (e as BudgetLedgerError).code === "policy-revoked",
    "100 s accrued against a tightened 50 s episode cap — revoked (C4-F2)",
  );
});

test("C4-F2 boundary: accrued time UNDER the (tightened) cap — redelivery still succeeds, no C3-F7 double count", async () => {
  const dir = await freshDir();
  const ledger = await openLedger(dir);
  const p = policyOf({ reservationTtlMs: 1_000_000 });
  const req = requestOf({ actionId: "act-wc-ok", taskId: "t-ok", attemptId: "a-ok" });
  const checked = check(p, req, await ledger.snapshotAt(0), 0);
  assert.ok(checked.allowed);
  const first = await ledger.reserve(p, req, checked.receipt!, { clock: fixedClock(0) });
  const pRoomy = policyOf({ reservationTtlMs: 1_000_000, perAttempt: { usd: 1, turns: 5, wallclockS: 200 } });
  const again = await ledger.reserve(pRoomy, req, checked.receipt!, { clock: fixedClock(100_000) });
  assert.equal(again.id, first.id, "100 s accrued < 200 s cap — coverage check passes, same record back");
});
