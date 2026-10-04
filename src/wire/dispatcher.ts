/**
 * D15 — per-call wire dispatcher.
 *
 * The core of "don't pin the model at startup": instead of choosing ONE wire
 * at launch, we hand the agent loop a `StreamFn` that routes each call to the
 * wire matching the CURRENT model's `api`. The TUI/REPL re-resolve the active
 * `ModelConfig` on a `/models` switch and pass it to `runTurn`; the dispatcher
 * then selects the wire per call. That is what makes mid-session switching
 * work ACROSS backends (local chat/completions ↔ ChatGPT Responses).
 *
 * Pure + injectable so it is unit-testable without a network.
 */
import type { StreamFn } from "../types.js";

/**
 * Build a `StreamFn` that routes each call by the model's `api`.
 * @param completionsFn the chat/completions wire (default for `api: "openai-completions"`).
 * @param responsesFn the Responses wire (for `api: "openai-responses"`).
 */
export function makeStreamDispatcher(
  completionsFn: StreamFn,
  responsesFn: StreamFn,
): StreamFn {
  return (model, ctx, opts) =>
    model.api === "openai-responses" ? responsesFn(model, ctx, opts) : completionsFn(model, ctx, opts);
}
