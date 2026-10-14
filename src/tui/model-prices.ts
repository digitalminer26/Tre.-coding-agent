/**
 * OpenRouter model pricing for the TUI's `/models` picker (and the `/models`
 * list report).
 *
 * Data source: `GET https://openrouter.ai/api/v1/models` — a PUBLIC endpoint
 * (no API key) that returns the whole OpenRouter catalog with per-model
 * `pricing.prompt` / `pricing.completion` in USD PER TOKEN. The TUI converts
 * to the readable $/1M-tokens convention (`$0.10/M in · $0.50/M out`).
 *
 * Cache: a TTL file at `~/.tre/tre/openrouter-prices.json` (machine-level,
 * next to models.json — never in the repo). Refreshed on EVERY `tre.` run
 * (one background GET, fire-and-forget from the TUI driver — the fetch never
 * blocks startup or a turn). A fresh cache (age < TTL) is served WITHOUT a
 * network round-trip, so offline startups still show last-known prices; a
 * stale/missing cache triggers the fetch, and on success the file is
 * rewritten (the "updates every time tre. runs" behavior).
 *
 * Fail-open: prices are decoration, never a blocker. Any failure (no
 * network, non-200, malformed body, corrupt cache) resolves to the last
 * fresh cache, or to "no prices" — the picker renders exactly as it did
 * before this feature. The TUI state machine stays pure: it only receives
 * the resolved map (state.modelPrices) and renders it; all I/O lives here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** OpenRouter's public model list (no auth). */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
/** The models.json `provider` label that marks an OpenRouter entry. */
export const OPENROUTER_PROVIDER = "openrouter";
/** Cache TTL — 24h. A run with a fresh cache never touches the network. */
export const PRICE_TTL_MS = 24 * 60 * 60 * 1000;
/** Tolerance for clock skew when validating a cache timestamp. A far-future
 * `fetchedAt` (corrupt file / a huge-but-finite number) is rejected so it
 * cannot pin a stale cache as "fresh" forever (now − fetchedAt < TTL). */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Hard cap on the pricing fetch. Prices are decoration, never a blocker —
 * a hung connection must not keep the process alive (a one-shot plain run
 * exits after the run; the TUI aborts the fetch on quit). 10s is generous:
 * the endpoint answers in well under a second. */
export const FETCH_TIMEOUT_MS = 10_000;
/** Default cache file (machine-level, next to models.json). */
export const PRICE_CACHE_FILE = join(homedir(), ".tre", "tre", "openrouter-prices.json");

/** One model's price, USD PER 1M tokens (already converted from the
 * endpoint's per-token values). */
export interface ModelPrice {
  in: number;
  out: number;
}

/** model id → price. Keys are the catalog ids (OpenRouter `vendor/model`). */
export type PriceMap = Record<string, ModelPrice>;

/** The on-disk cache shape (versioned so a future layout change can
 * invalidate old files instead of misreading them). */
interface PriceCache {
  v: 1;
  /** Epoch ms the prices were fetched. */
  fetchedAt: number;
  prices: PriceMap;
}

/** The cache file path for a home dir (injectable for tests). */
export function priceCachePath(home: string = homedir()): string {
  return join(home, ".tre", "tre", "openrouter-prices.json");
}

/** True when a cached price entry is a usable {in, out} pair (finite,
 * non-negative). A corrupt entry (NaN / Infinity / negative / non-numeric)
 * is treated as "no cache" so it can never render a bogus price. */
function validPrice(v: unknown): v is ModelPrice {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.in === "number" &&
    Number.isFinite(p.in) &&
    p.in >= 0 &&
    typeof p.out === "number" &&
    Number.isFinite(p.out) &&
    p.out >= 0
  );
}

/**
 * Read the cache file. Returns null when it is absent, unreadable, not
 * valid JSON, not the current version, or has a non-object `prices` field
 * (a corrupt file is treated as "no cache" — fail-open, never a crash). An
 * empty `prices` object is VALID — a genuinely empty catalog is cacheable so
 * the TTL is honored (see the check below).
 */
export function readPriceCache(file: string = PRICE_CACHE_FILE): PriceCache | null {
  try {
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, "utf8")) as Partial<PriceCache>;
    if (j.v !== 1 || typeof j.fetchedAt !== "number" || !Number.isFinite(j.fetchedAt)) return null;
    // Reject a far-future timestamp (corrupt / huge-but-finite) so it cannot
    // pin a stale cache as "fresh" forever (now − fetchedAt < TTL).
    if (j.fetchedAt > Date.now() + CLOCK_SKEW_MS) return null;
    // An empty prices object is VALID: resolveModelPrices caches a genuinely
    // empty (but successfully-fetched) result so the TTL is honored and the
    // endpoint is not re-fetched every run until the cache expires. An ARRAY
    // is rejected even though typeof is "object" — the field must be a map
    // (id → price), and an array would silently yield no suffixes.
    if (!j.prices || typeof j.prices !== "object" || Array.isArray(j.prices)) return null;
    // Validate every entry — a single corrupt entry (NaN / Infinity /
    // negative / non-numeric) invalidates the WHOLE cache (fail-open) so no
    // bogus price can render.
    for (const key of Object.keys(j.prices)) {
      if (!validPrice(j.prices[key])) return null;
    }
    return { v: 1, fetchedAt: j.fetchedAt, prices: j.prices as PriceMap };
  } catch {
    return null;
  }
}

/** Write the cache file (the parent dir is created when missing). */
export function writePriceCache(
  cache: PriceCache,
  file: string = PRICE_CACHE_FILE,
): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cache, null, 2) + "\n", { mode: 0o644 });
}

/**
 * Fetch the OpenRouter catalog and reduce it to an id → price map (USD per
 * 1M tokens). Throws on transport failure or a non-200 (the caller
 * fail-opens). A model is included ONLY when BOTH `pricing.prompt` and
 * `pricing.completion` parse as finite non-negative values — a model with a
 * missing or invalid price is SKIPPED (it must not render as $0.00/M, which
 * would claim a paid model is free). A 200 with no parseable models yields
 * an empty map (still valid — the cache is written so the next run doesn't
 * refetch for a catalog that is genuinely empty).
 */
export async function fetchOpenRouterPrices(
  url: string = OPENROUTER_MODELS_URL,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PriceMap> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`OpenRouter pricing fetch failed (HTTP ${res.status})`);
  const body = await res.text();
  const j = JSON.parse(body) as { data?: unknown };
  const list = Array.isArray(j.data) ? j.data : [];
  const map: PriceMap = {};
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const id = typeof m.id === "string" ? m.id : "";
    if (id === "") continue;
    const p = (m.pricing ?? {}) as Record<string, unknown>;
    // The endpoint sends per-token USD as STRINGS ("0.0000001") — accept
    // numbers too (defensive). Returns null when the value is MISSING or
    // INVALID (non-numeric / negative / non-finite): such a model is SKIPPED
    // rather than shown as $0.00/M — a missing price is not a free model.
    // Round to cents per 1M (the display precision): per-token values are
    // 1e-8-scale, so the $/M figure has at most two meaningful decimals, and
    // the raw multiply carries float noise (0.0000001 * 1e6 = 0.099999…).
    const perM = (v: unknown): number | null => {
      const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
      if (!Number.isFinite(n) || n < 0) return null;
      return Math.round(n * 1_000_000 * 100) / 100;
    };
    const inp = perM(p.prompt);
    const outp = perM(p.completion);
    if (inp === null || outp === null) continue; // skip, don't show as free
    map[id] = { in: inp, out: outp };
  }
  return map;
}

/**
 * Resolve the price map for the TUI (fail-open). A fresh cache (age < TTL)
 * is returned without any network I/O. Otherwise a fetch is attempted: on
 * success the cache file is rewritten (fresh) and the new prices returned;
 * on failure the LAST FRESH cache is returned (stale-but-known beats
 * nothing), or an empty map when there is none.
 *
 * `now`/`file`/`fetchImpl` are injectable for tests.
 */
export async function resolveModelPrices(opts: {
  file?: string;
  now?: number;
  fetchImpl?: typeof fetch;
  /** Cancellation (the TUI driver aborts it on quit — the fetch must not
   * outlive the app and write a half-open connection's result). */
  signal?: AbortSignal;
  /** Hard cap on the fetch (default FETCH_TIMEOUT_MS). Injectable so tests
   * can exercise the timeout path without waiting 10s. */
  timeoutMs?: number;
} = {}): Promise<PriceMap> {
  const file = opts.file ?? PRICE_CACHE_FILE;
  const now = opts.now ?? Date.now();
  const cache = readPriceCache(file);
  if (cache !== null && now - cache.fetchedAt < PRICE_TTL_MS) return cache.prices;
  // Bound the fetch: link the caller's signal (TUI quit) with a hard timeout
  // so a HUNG connection can't keep the process alive (a one-shot plain run
  // exits after the run; the TUI aborts on quit). 10s is generous.
  const ac = new AbortController();
  const onOuterAbort = (): void => { ac.abort(); };
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const prices = await fetchOpenRouterPrices(OPENROUTER_MODELS_URL, opts.fetchImpl, ac.signal);
    writePriceCache({ v: 1, fetchedAt: now, prices }, file);
    return prices;
  } catch {
    // Fail-open: a stale cache still shows last-known prices; otherwise the
    // picker renders with no price suffix (the pre-feature behavior). An
    // abort (quit mid-fetch) or a timeout is a failure here too — the driver's
    // .then guards on the signal anyway, so nothing lands after unmount.
    if (cache !== null) return cache.prices;
    return {};
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onOuterAbort);
  }
}
