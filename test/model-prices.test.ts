import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchOpenRouterPrices,
  priceCachePath,
  PRICE_TTL_MS,
  readPriceCache,
  resolveModelPrices,
  writePriceCache,
} from "../src/tui/model-prices.js";

/** A minimal OpenRouter-shaped response (the public endpoint's real shape:
 * `data[]` with `id` + `pricing` in USD per TOKEN, as strings). */
const PAYLOAD = {
  data: [
    { id: "a/b-1", pricing: { prompt: "0.0000001", completion: "0.0000005" } },
    { id: "a/c-free", pricing: { prompt: "0", completion: "0" } },
    // no pricing block at all → SKIPPED (a missing price is not a free model)
    { id: "a/d-noprice" },
    // one side missing → SKIPPED (incomplete pricing is not 0/0)
    { id: "a/e-half", pricing: { prompt: "0.0000001" } },
    // malformed entries are skipped, not fatal
    { pricing: { prompt: "x", completion: "y" } },
    null,
    "junk",
  ],
};

const okFetch: typeof fetch = async () => new Response(JSON.stringify(PAYLOAD), { status: 200 });

test("priceCachePath: machine-level, under <home>/.tre/tre/", () => {
  assert.equal(priceCachePath("/h"), join("/h", ".tre", "tre", "openrouter-prices.json"));
});

test("fetchOpenRouterPrices: per-token USD → per-1M; invalid/missing pricing is SKIPPED (not shown as free)", async () => {
  const map = await fetchOpenRouterPrices("https://example.invalid", okFetch);
  assert.deepEqual(map, {
    "a/b-1": { in: 0.1, out: 0.5 },
    "a/c-free": { in: 0, out: 0 }, // a REAL 0/0 (free) is kept
  });
  assert.ok(!("a/d-noprice" in map), "no pricing block → skipped, not $0.00/M");
  assert.ok(!("a/e-half" in map), "missing completion → skipped, not $0.00/M");
  // negative / non-numeric values are skipped too
  const neg: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: "a/neg", pricing: { prompt: "-1", completion: "0" } },
          { id: "a/bad", pricing: { prompt: "x", completion: "0" } },
          { id: "a/num", pricing: { prompt: 2e-6, completion: 1e-5 } },
        ],
      }),
      { status: 200 },
    );
  const m2 = await fetchOpenRouterPrices("https://example.invalid", neg);
  assert.deepEqual(m2, { "a/num": { in: 2, out: 10 } }, "numbers accepted; negative/non-numeric skipped");
});

test("fetchOpenRouterPrices: non-200 throws (the caller fail-opens)", async () => {
  const bad: typeof fetch = async () => new Response("nope", { status: 500 });
  await assert.rejects(fetchOpenRouterPrices("https://example.invalid", bad), /HTTP 500/);
});

test("readPriceCache: round-trips; corrupt/absent/wrong-version → null", () => {
  const dir = mkdtempSync(join(tmpdir(), "prices-"));
  try {
    const f = join(dir, "openrouter-prices.json");
    assert.equal(readPriceCache(f), null); // absent
    writePriceCache({ v: 1, fetchedAt: 123, prices: { "a/b": { in: 1, out: 2 } } }, f);
    assert.deepEqual(readPriceCache(f), { v: 1, fetchedAt: 123, prices: { "a/b": { in: 1, out: 2 } } });
    writeFileSync(f, "{ not json");
    assert.equal(readPriceCache(f), null); // corrupt
    writeFileSync(f, JSON.stringify({ v: 9, fetchedAt: 123, prices: { "a/b": { in: 1, out: 2 } } }));
    assert.equal(readPriceCache(f), null); // wrong version
    writeFileSync(f, JSON.stringify({ v: 1, fetchedAt: 123, prices: {} }));
    assert.deepEqual(readPriceCache(f), { v: 1, fetchedAt: 123, prices: {} }); // a valid empty map is cacheable
    writeFileSync(f, JSON.stringify({ v: 1, fetchedAt: 123, prices: [{ in: 1, out: 2 }] }));
    assert.equal(readPriceCache(f), null); // an ARRAY is not a map (typeof "object" but wrong shape)
    // STRICT validation: a corrupt entry or a far-future timestamp invalidates
    // the WHOLE cache (fail-open) so no bogus price can render.
    writeFileSync(f, JSON.stringify({ v: 1, fetchedAt: 123, prices: { "a/b": { in: NaN, out: 2 } } }));
    assert.equal(readPriceCache(f), null); // NaN price
    writeFileSync(f, JSON.stringify({ v: 1, fetchedAt: 123, prices: { "a/b": { in: -1, out: 2 } } }));
    assert.equal(readPriceCache(f), null); // negative price
    writeFileSync(f, JSON.stringify({ v: 1, fetchedAt: 123, prices: { "a/b": { in: "1", out: 2 } } }));
    assert.equal(readPriceCache(f), null); // non-numeric price
    writeFileSync(f, JSON.stringify({ v: 1, fetchedAt: 123, prices: { "a/b": { in: 1 } } }));
    assert.equal(readPriceCache(f), null); // missing `out`
    writeFileSync(f, JSON.stringify({ v: 1, fetchedAt: 123, prices: { "a/b": { in: 1, out: 2 }, "a/c": { in: NaN, out: 0 } } }));
    assert.equal(readPriceCache(f), null); // one bad entry invalidates the whole cache
    writeFileSync(f, JSON.stringify({ v: 1, fetchedAt: Date.now() + 10 * 60 * 60 * 1000, prices: { "a/b": { in: 1, out: 2 } } }));
    assert.equal(readPriceCache(f), null); // far-future timestamp (corrupt)
    writeFileSync(f, JSON.stringify({ v: 1, fetchedAt: Date.now() + 60 * 1000, prices: { "a/b": { in: 1, out: 2 } } }));
    assert.ok(readPriceCache(f) !== null, "small clock skew (1min ahead) is tolerated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveModelPrices: fresh cache is served WITHOUT a network round-trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prices-"));
  try {
    const f = join(dir, "openrouter-prices.json");
    writePriceCache({ v: 1, fetchedAt: 1_000_000, prices: { "a/b": { in: 1, out: 2 } } }, f);
    let fetched = false;
    const prices = await resolveModelPrices({
      file: f,
      now: 1_000_000 + PRICE_TTL_MS - 1, // still fresh (1ms of TTL left)
      fetchImpl: (async () => { fetched = true; return new Response("{}", { status: 200 }); }) as typeof fetch,
    });
    assert.equal(fetched, false, "a fresh cache must not touch the network");
    assert.deepEqual(prices, { "a/b": { in: 1, out: 2 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveModelPrices: a fresh EMPTY cache is honored (no refetch of a genuinely empty catalog)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prices-"));
  try {
    const f = join(dir, "openrouter-prices.json");
    // A successful fetch of a genuinely empty catalog wrote an empty map.
    writePriceCache({ v: 1, fetchedAt: 1_000_000, prices: {} }, f);
    let fetched = false;
    const prices = await resolveModelPrices({
      file: f,
      now: 1_000_000 + PRICE_TTL_MS - 1, // still fresh (1ms of TTL left)
      fetchImpl: (async () => { fetched = true; return new Response("{}", { status: 200 }); }) as typeof fetch,
    });
    assert.equal(fetched, false, "a fresh empty cache must not touch the network (the TTL is honored)");
    assert.deepEqual(prices, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveModelPrices: stale cache + success → fetches, rewrites the file, returns fresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prices-"));
  try {
    const f = join(dir, "openrouter-prices.json");
    writePriceCache({ v: 1, fetchedAt: 0, prices: { "a/old": { in: 9, out: 9 } } }, f);
    const prices = await resolveModelPrices({ file: f, now: PRICE_TTL_MS + 1, fetchImpl: okFetch });
    assert.deepEqual(prices, { "a/b-1": { in: 0.1, out: 0.5 }, "a/c-free": { in: 0, out: 0 } });
    const cache = readPriceCache(f);
    assert.ok(cache !== null);
    assert.equal(cache.fetchedAt, PRICE_TTL_MS + 1, "the file is rewritten on a successful refresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveModelPrices: no cache + failure → {} (fail-open, nothing to fall back to)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prices-"));
  try {
    const f = join(dir, "openrouter-prices.json");
    const prices = await resolveModelPrices({
      file: f,
      now: 0,
      fetchImpl: (async () => { throw new Error("network down"); }) as typeof fetch,
    });
    assert.deepEqual(prices, {});
    assert.equal(readPriceCache(f), null, "a failed fetch must not write a cache");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveModelPrices: stale cache + failure → the last known prices (stale beats nothing)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prices-"));
  try {
    const f = join(dir, "openrouter-prices.json");
    writePriceCache({ v: 1, fetchedAt: 0, prices: { "a/old": { in: 7, out: 8 } } }, f);
    const prices = await resolveModelPrices({
      file: f,
      now: PRICE_TTL_MS + 1,
      fetchImpl: (async () => new Response("down", { status: 503 })) as typeof fetch,
    });
    assert.deepEqual(prices, { "a/old": { in: 7, out: 8 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveModelPrices: abort mid-fetch → fail-open (no throw, no cache write)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prices-"));
  try {
    const f = join(dir, "openrouter-prices.json");
    const ac = new AbortController();
    const slow: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => reject(new Error("aborted"));
        if (init?.signal) {
          if (init.signal.aborted) { onAbort(); return; }
          init.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    const p = resolveModelPrices({ file: f, now: 0, fetchImpl: slow, signal: ac.signal });
    ac.abort();
    const prices = await p;
    assert.deepEqual(prices, {});
    assert.equal(readPriceCache(f), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveModelPrices: a hung fetch is bounded by the timeout (fail-open, no cache write)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prices-"));
  try {
    const f = join(dir, "openrouter-prices.json");
    // A fetch that hangs until the signal aborts (a hung connection) — a
    // real fetch REJECTS on abort, so the mock must too.
    const hang: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const t0 = Date.now();
    const prices = await resolveModelPrices({ file: f, now: 0, fetchImpl: hang, timeoutMs: 50 });
    assert.ok(Date.now() - t0 < 5_000, "the timeout fired, not the 10s default");
    assert.deepEqual(prices, {});
    assert.equal(readPriceCache(f), null, "a timed-out fetch must not write a cache");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
