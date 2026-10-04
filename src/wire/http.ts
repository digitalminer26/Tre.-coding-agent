/**
 * WS1 — HTTP transport for OpenAI-compatible endpoints.
 *
 *   - `httpJson`    — POST a JSON body, bounded retry (network errors, 5xx,
 *                     429) with backoff, AbortSignal support. Throws
 *                     `HttpError` on terminal failure (caller converts to
 *                     data per I3 — the wire module never lets this cross
 *                     the StreamFn boundary).
 *   - `sseStream`   — POST a JSON body and yield parsed SSE frames from the
 *                     response body. Retries like httpJson, but only BEFORE
 *                     the first frame is yielded (a started stream cannot be
 *                     replayed). Inline `{"error": …}` data frames are
 *                     yielded as `{ event: "error" }` so the caller can map
 *                     them to a done(error).
 *
 * Zero dependencies: global fetch (Node ≥ 20) + built-in streams.
 */
import { AbortError, isAbort } from "./abort.js";

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface HttpOpts {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Request body (JSON-serialized by the caller). */
  body?: string;
  apiKey?: string;
  signal: AbortSignal;
  /** Max total attempts. Default 3 (1 + 2 retries). */
  retries?: number;
  /** Base backoff ms. Default 500; doubles per retry, capped at 4000. */
  backoffMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new AbortError());
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        reject(new AbortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

/** Retryable: network failure, 429, or 5xx. */
function retryable(err: unknown): boolean {
  if (isAbort(err)) return false;
  if (err instanceof HttpError) {
    const s = err.status;
    return s === 429 || (s !== undefined && s >= 500);
  }
  return true; // fetch TypeError (DNS/refused/TLS…)
}

async function attempt(opts: HttpOpts): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    ...opts.headers,
  };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  try {
    return await fetch(opts.url, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body,
      signal: opts.signal,
    });
  } catch (err) {
    if (isAbort(err)) throw new AbortError();
    throw err;
  }
}

export async function httpJson(opts: HttpOpts): Promise<unknown> {
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? 500;
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    if (opts.signal.aborted) throw new AbortError();
    try {
      const res = await attempt(opts);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new HttpError(
          `HTTP ${res.status} from ${opts.url}`,
          res.status,
          body,
        );
        if (!retryable(err) || i === retries - 1) throw err;
        lastErr = err;
      } else {
        const body = await res.text().catch(() => "");
        try {
          return JSON.parse(body);
        } catch {
          throw new HttpError(
            `malformed JSON in successful response from ${opts.url}`,
            res.status,
            body,
          );
        }
      }
    } catch (err) {
      if (err instanceof AbortError) throw err;
      if (!retryable(err) || i === retries - 1) throw err;
      lastErr = err;
    }
    await sleep(Math.min(backoff * 2 ** i, 4000), opts.signal);
  }
  throw lastErr;
}

/** One parsed SSE event: joined `data:` payload + optional `event:` name. */
export interface SseFrame {
  /** Raw data payload (e.g. a JSON string, or "[DONE]"). */
  data: string;
  /** `event:` field, if present. */
  event?: string;
}

/**
 * Stream SSE frames from an OpenAI-compatible endpoint.
 * Yields frames until the stream ends or an error/abort occurs.
 */
export async function* sseStream(opts: HttpOpts): AsyncGenerator<SseFrame> {
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? 500;

  let res: Response | undefined;
  for (let i = 0; i < retries; i++) {
    if (opts.signal.aborted) throw new AbortError();
    try {
      res = await attempt(opts);
      if (res.ok) break;
      const body = await res.text().catch(() => "");
      const err = new HttpError(
        `HTTP ${res.status} from ${opts.url}`,
        res.status,
        body,
      );
      if (!retryable(err) || i === retries - 1) throw err;
      await sleep(Math.min(backoff * 2 ** i, 4000), opts.signal);
    } catch (err) {
      if (err instanceof AbortError) throw err;
      if (!retryable(err) || i === retries - 1) throw err;
      await sleep(Math.min(backoff * 2 ** i, 4000), opts.signal);
    }
  }
  if (!res || !res.ok || !res.body) {
    throw new HttpError("SSE stream did not start", res?.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (opts.signal.aborted) return; // caller maps to done(aborted)
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line; tolerate \r\n.
      buffer = buffer.replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const frame = parseEventBlock(rawEvent);
        if (frame) yield frame;
      }
    }
    // Flush a trailing block without a final blank line.
    const frame = parseEventBlock(buffer);
    if (frame) yield frame;
  } finally {
    reader.releaseLock();
    // Best-effort drain on early exit (abort/error).
    await res.body?.cancel().catch(() => undefined);
  }
}

function parseEventBlock(block: string): SseFrame | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    // ":", "id:", "retry:" lines are ignored (not used by chat completions).
  }
  if (dataLines.length === 0) return undefined;
  return { data: dataLines.join("\n"), event };
}
