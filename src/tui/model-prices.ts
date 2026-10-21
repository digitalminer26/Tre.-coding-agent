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
 * endpoint's per-token values). `in`/`out` round to 2 decimals (the TUI's
 * display precision); the cache-rate fields keep 6 decimals because real
 * cache-read rates go as low as $0.005/M and 2-decimal rounding would
 * destroy them (tokenomics consumes these rates for cost math). */
export interface ModelPrice {
  in: number;
  out: number;
  /** USD/1M for prompt tokens served from cache (`pricing.input_cache_read`).
   * ABSENT when the endpoint doesn't publish one — consumers must NOT assume
   * a blanket discount: `:free` → 0, otherwise treat as `in` (no benefit). */
  cacheRead?: number;
  /** USD/1M for cache writes (`pricing.input_cache_write`). */
  cacheWrite?: number;
  /** USD/1M for 1-hour-tier cache writes (`pricing.input_cache_write_1h`). */
  cacheWrite1h?: number;
  /** Long-context pricing tiers (`pricing.overrides`): the tier applies when
   * a request's prompt tokens cross `minPromptTokens`. Sorted ascending. */
  overrides?: PriceOverrideTier[];
}

/** One long-context price tier. Same field semantics as ModelPrice. */
export interface PriceOverrideTier {
  minPromptTokens: number;
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** model id → price. Keys are the catalog ids (OpenRouter `vendor/model`). */
export type PriceMap = Record<string, ModelPrice>;

/** The on-disk cache shape (versioned so a future layout change can
 * invalidate old files instead of misreading them). v2 adds the optional
 * cache-rate + override-tier fields; v1 files stay READABLE (they simply
 * carry no cache rates), so a version bump never strands an offline host
 * with "no prices". */
export interface PriceCache {
  v: 1 | 2;
  /** Epoch ms the prices were fetched. */
  fetchedAt: number;
  prices: PriceMap;
}

/** The cache file path for a home dir (injectable for tests). */
export function priceCachePath(home: string = homedir()): string {
  return join(home, ".tre", "tre", "openrouter-prices.json");
}

/** True when a cached price entry is a usable {in, out} pair (finite,
 * non-negative) plus well-formed OPTIONAL fields (cacheRead / cacheWrite /
 * cacheWrite1h / overrides). A corrupt entry (NaN / Infinity / negative /
 * non-numeric, or a malformed tier) is treated as "no cache" so it can
 * never render a bogus price. Absent optional fields are VALID (v1 files
 * and models the endpoint doesn't publish cache rates for). */
function validNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function validPrice(v: unknown): v is ModelPrice {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  if (!validNum(p.in) || !validNum(p.out)) return false;
  for (const k of ["cacheRead", "cacheWrite", "cacheWrite1h"] as const) {
    if (p[k] !== undefined && !validNum(p[k])) return false;
  }
  if (p.overrides !== undefined) {
    if (!Array.isArray(p.overrides)) return false;
    for (const t of p.overrides as unknown[]) {
      if (!t || typeof t !== "object") return false;
      const tier = t as Record<string, unknown>;
      if (
        typeof tier.minPromptTokens !== "number" || !Number.isFinite(tier.minPromptTokens) || tier.minPromptTokens < 0 ||
        !validNum(tier.in) || !validNum(tier.out) ||
        (tier.cacheRead !== undefined && !validNum(tier.cacheRead)) ||
        (tier.cacheWrite !== undefined && !validNum(tier.cacheWrite))
      ) return false;
    }
  }
  return true;
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
    // v1 (in/out only) and v2 (+ cache rates / tiers) are both readable;
    // anything else invalidates the file.
    if (j.v !== 1 && j.v !== 2) return null;
    if (typeof j.fetchedAt !== "number" || !Number.isFinite(j.fetchedAt)) return null;
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
    return { v: j.v, fetchedAt: j.fetchedAt, prices: j.prices as PriceMap };
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
    // Cache rates keep 6 decimals: real cache-read rates reach $0.005/M
    // (e.g. qwen flash tiers), which 2-decimal rounding would zero out —
    // the tokenomics cost math consumes these rates directly.
    const perM6 = (v: unknown): number | null => {
      const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
      if (!Number.isFinite(n) || n < 0) return null;
      return Math.round(n * 1_000_000 * 1e6) / 1e6;
    };
    const inp = perM(p.prompt);
    const outp = perM(p.completion);
    if (inp === null || outp === null) continue; // skip, don't show as free
    const price: ModelPrice = { in: inp, out: outp };
    // Optional cache rates: a MISSING or INVALID value leaves the field
    // absent (never coerced to 0 — "absent" and "free" are different facts;
    // see the ModelPrice doc).
    const cr = perM6(p.input_cache_read);
    if (cr !== null) price.cacheRead = cr;
    const cw = perM6(p.input_cache_write);
    if (cw !== null) price.cacheWrite = cw;
    const cw1h = perM6(p.input_cache_write_1h);
    if (cw1h !== null) price.cacheWrite1h = cw1h;
    // Long-context override tiers: a tier needs a finite minPromptTokens and
    // valid in/out to be kept; a tier with an invalid cache rate just drops
    // that field. A malformed overrides value (non-array / junk items) is
    // ignored — the base price stands on its own.
    if (Array.isArray(p.overrides)) {
      const tiers: PriceOverrideTier[] = [];
      for (const t of p.overrides) {
        if (!t || typeof t !== "object") continue;
        const o = t as Record<string, unknown>;
        const min = typeof o.min_prompt_tokens === "number" && Number.isFinite(o.min_prompt_tokens) && o.min_prompt_tokens >= 0
          ? Math.trunc(o.min_prompt_tokens)
          : null;
        const tin = perM(o.prompt);
        const tout = perM(o.completion);
        if (min === null || tin === null || tout === null) continue;
        const tier: PriceOverrideTier = { minPromptTokens: min, in: tin, out: tout };
        const tcr = perM6(o.input_cache_read);
        if (tcr !== null) tier.cacheRead = tcr;
        const tcw = perM6(o.input_cache_write);
        if (tcw !== null) tier.cacheWrite = tcw;
        tiers.push(tier);
      }
      if (tiers.length > 0) {
        tiers.sort((a, b) => a.minPromptTokens - b.minPromptTokens);
        price.overrides = tiers;
      }
    }
    map[id] = price;
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
    writePriceCache({ v: 2, fetchedAt: now, prices }, file);
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
