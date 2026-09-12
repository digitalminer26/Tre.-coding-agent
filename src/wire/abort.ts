/**
 * WS1 — abort detection helper.
 *
 * Node's fetch rejects with a `DOMException` (name "AbortError") when the
 * AbortSignal fires; we normalize that to our own `AbortError` so the rest
 * of the wire layer has one thing to check (I3: aborts become data).
 */
export class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

export function isAbort(err: unknown): boolean {
  if (err instanceof AbortError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}
