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

// ───────────────────────── v2: cache rates + long-context tiers ─────────────────────────

test("fetchOpenRouterPrices v2: cacheRead/cacheWrite/1h + overrides tiers captured; invalid optionals dropped, base kept", async () => {
  const payload = {
    data: [
      {
        id: "openai/gpt-x",
        pricing: {
          prompt: "0.0000001", completion: "0.0000005",
          input_cache_read: "0.00000001", input_cache_write: "0.000000125",
          overrides: [
            { min_prompt_tokens: 272000, prompt: "0.0000002", completion: "0.00000075", input_cache_read: "0.00000002" },
            { min_prompt_tokens: 1000, prompt: "0.00000015", completion: "0.0000006" }, // unsorted input
            { prompt: "0.0000002" }, // no min_prompt_tokens → tier dropped
          ],
        },
      },
      { id: "a/nocache", pricing: { prompt: "0.000002", completion: "0.00001" } },
      { id: "a/badcache", pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "-1" } },
      { id: "a/tinycache", pricing: { prompt: "0.00000015", completion: "0.00000047", input_cache_read: "0.000000005" } },
      { id: "a/badoverrides", pricing: { prompt: "0.000002", completion: "0.00001", overrides: "junk" } },
    ],
  };
  const f: typeof fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
  const map = await fetchOpenRouterPrices("https://example.invalid", f);
  assert.deepEqual(map["openai/gpt-x"], {
    in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
    overrides: [
      { minPromptTokens: 1000, in: 0.15, out: 0.6 },
      { minPromptTokens: 272000, in: 0.2, out: 0.75, cacheRead: 0.02 },
    ],
  }, "tiers sorted ascending; invalid tier dropped; per-1M conversion");
  assert.deepEqual(map["a/nocache"], { in: 2, out: 10 }, "absent cache rates stay ABSENT (not 0)");
  assert.deepEqual(map["a/badcache"], { in: 2, out: 10 }, "invalid cacheRead dropped, base price kept");
  assert.deepEqual(map["a/tinycache"], { in: 0.15, out: 0.47, cacheRead: 0.005 },
    "6-decimal precision preserves $0.005/M cache-read rates");
  assert.deepEqual(map["a/badoverrides"], { in: 2, out: 10 }, "non-array overrides ignored");
});

test("readPriceCache v2: v2 round-trips; v1 stays READABLE; corrupt v2 optionals invalidate the whole cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "prices-"));
  try {
    const f = join(dir, "openrouter-prices.json");
    // v2 round-trip with all optional fields.
    const v2 = { v: 2 as const, fetchedAt: 123, prices: {
      "a/b": { in: 1, out: 2, cacheRead: 0.1, cacheWrite: 0.125, cacheWrite1h: 0.25,
        overrides: [{ minPromptTokens: 1000, in: 2, out: 4 }] },
    } };
    writePriceCache(v2, f);
    assert.deepEqual(readPriceCache(f), v2);
    // A v1 file (no optional fields) must still load — an old cache beats
    // "no prices" on an offline host.
    writePriceCache({ v: 1, fetchedAt: 456, prices: { "a/b": { in: 1, out: 2 } } }, f);
    const got = readPriceCache(f);
    assert.ok(got !== null && got.v === 1 && got.fetchedAt === 456);
    // Corrupt v2 optionals → whole cache invalid (fail-open), same contract
    // as the base fields.
    for (const bad of [
      { in: 1, out: 2, cacheRead: -1 },
      { in: 1, out: 2, cacheRead: "x" },
      { in: 1, out: 2, overrides: {} },
      { in: 1, out: 2, overrides: [{ minPromptTokens: 1, in: NaN, out: 2 }] },
      { in: 1, out: 2, overrides: [{ in: 1, out: 2 }] }, // no minPromptTokens
    ]) {
      writePriceCache({ v: 2, fetchedAt: 123, prices: { "a/b": bad } } as never, f);
      assert.equal(readPriceCache(f), null, `corrupt optional rejected: ${JSON.stringify(bad)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveModelPrices: a successful refresh WRITES v2 (the tokenomics shipper reads this file)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prices-"));
  try {
    const f = join(dir, "openrouter-prices.json");
    const payload = { data: [{ id: "a/b-1", pricing: { prompt: "0.0000001", completion: "0.0000005", input_cache_read: "0.00000001" } }] };
    await resolveModelPrices({ file: f, now: 5_000_000, fetchImpl: (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch });
    const raw = JSON.parse(readFileSync(f, "utf8"));
    assert.equal(raw.v, 2, "refreshed caches are written as v2");
    assert.deepEqual(raw.prices["a/b-1"], { in: 0.1, out: 0.5, cacheRead: 0.01 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
