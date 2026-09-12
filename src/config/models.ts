/**
 * WS1 — model catalog: loads models.json into typed ModelConfig[].
 *
 * models.json shape:
 *   { "default": "<id>", "models": [ { id, provider, baseUrl, api,
 *     apiKey?, contextWindow, maxTokens, temperature?, compat? } ] }
 *
 * Swapping endpoints = editing models.json; the wire layer stays one code
 * path (per-model quirks live in `compat`).
 */
import { readFileSync } from "node:fs";
import type { ModelConfig } from "../types.js";

export interface ModelsFile {
  default: string;
  models: ModelConfig[];
}

export function parseModelsFile(raw: string): ModelsFile {
  const j = JSON.parse(raw) as { default?: string; models?: unknown };
  if (!Array.isArray(j.models) || j.models.length === 0) {
    throw new Error("models.json: 'models' must be a non-empty array");
  }
  const models: ModelConfig[] = j.models.map((m, i) => normalizeModel(m, i));
  const def = j.default;
  if (def !== undefined && !models.some((m) => m.id === def)) {
    throw new Error(`models.json: default "${def}" is not in models[]`);
  }
  return { default: def ?? models[0]!.id, models };
}

function normalizeModel(m: unknown, i: number): ModelConfig {
  const o = m as Record<string, unknown>;
  const need = (k: string): unknown => {
    if (o[k] === undefined || o[k] === null || o[k] === "") {
      throw new Error(`models.json: models[${i}].${k} is required`);
    }
    return o[k];
  };
  const model: ModelConfig = {
    id: need("id") as string,
    provider: need("provider") as string,
    baseUrl: need("baseUrl") as string,
    api: (need("api") as string) as ModelConfig["api"],
    contextWindow: need("contextWindow") as number,
    maxTokens: need("maxTokens") as number,
  };
  if (typeof o.apiKey === "string") model.apiKey = o.apiKey;
  if (typeof o.temperature === "number") model.temperature = o.temperature;
  if (o.compat && typeof o.compat === "object") {
    model.compat = o.compat as ModelConfig["compat"];
  }
  return model;
}

/** Read + parse a models.json from disk. */
export function loadModelsFile(path: string): ModelsFile {
  return parseModelsFile(readFileSync(path, "utf8"));
}

/**
 * Resolve a model by id (or the default when id is undefined).
 * Throws a descriptive error on unknown id — CLI-level input validation,
 * so it is allowed to throw before any StreamFn call.
 */
export function resolveModel(file: ModelsFile, id?: string): ModelConfig {
  const wanted = id ?? file.default;
  const found = file.models.find((m) => m.id === wanted);
  if (!found) {
    const known = file.models.map((m) => m.id).join(", ");
    throw new Error(`unknown model "${wanted}" (known: ${known})`);
  }
  return found;
}
