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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
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
  const apiRaw = need("api") as string;
  if (apiRaw !== "openai-completions" && apiRaw !== "openai-responses") {
    throw new Error(
      `models.json: models[${i}].api must be "openai-completions" or "openai-responses" (got "${apiRaw}")`,
    );
  }
  const model: ModelConfig = {
    id: need("id") as string,
    provider: need("provider") as string,
    baseUrl: need("baseUrl") as string,
    api: apiRaw as ModelConfig["api"],
    contextWindow: need("contextWindow") as number,
    maxTokens: need("maxTokens") as number,
  };
  if (typeof o.apiKey === "string") model.apiKey = o.apiKey;
  if (typeof o.temperature === "number") model.temperature = o.temperature;
  if (o.auth === "chatgpt-oauth") model.auth = "chatgpt-oauth";
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
 * D19 — models.json lookup. `explicit` (from `--models`) wins and is
 * returned as-is, even if missing — the caller reports the error. Otherwise
 * walk UP from `start` (the launch directory, resolved) looking for a
 * `models.json` — the same convention as a `.git` directory — then fall
 * back to the permanent home location `~/.tre/models.json`. Returns null
 * when nothing is found.
 */
export function findModelsFile(
  explicit: string | undefined,
  start: string,
  home: string = homedir(),
): string | null {
  if (explicit !== undefined) return explicit;
  let dir = start;
  for (;;) {
    const candidate = join(dir, "models.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  const homeFile = join(home, ".tre", "models.json");
  return existsSync(homeFile) ? homeFile : null;
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

/**
 * Startup configuration guide (deployability).
 *
 * A fresh checkout / first run on a new machine has no endpoint wired up yet,
 * so `tre.` cannot start. Rather than a bare "models.json not found" error,
 * the CLI prints a step-by-step guide to the fields it needs.
 *
 * The guide is ADAPTIVE: it distinguishes REQUIRED vs OPTIONAL fields and
 * marks each REQUIRED field as either "populated" (already filled in — show
 * the value) or "needed" (still blank — show a placeholder + what to put).
 * A model with no endpoint configuration (baseUrl blank) is the trigger.
 */

/** Required model fields, in the order the guide lists them. */
const REQUIRED_FIELDS: (keyof ModelConfig)[] = [
  "id",
  "provider",
  "baseUrl",
  "api",
  "contextWindow",
  "maxTokens",
];

/** Optional model fields (the guide lists them, but they never block start). */
const OPTIONAL_FIELDS: (keyof ModelConfig)[] = ["apiKey", "auth", "temperature", "compat"];

function isPopulated(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return Number.isFinite(v) && v > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** A raw placeholder value for a not-yet-populated field (JSON.stringify
 *  adds the quotes for strings; numbers stay bare). */
function placeholder(f: keyof ModelConfig): string | number | object {
  switch (f) {
    case "id":
      return "<model-id>";
    case "provider":
      return "<provider-label>";
    case "baseUrl":
      return "http://<host>:<port>/v1";
    case "api":
      return "openai-completions";
    case "contextWindow":
      return 0;
    case "maxTokens":
      return 0;
    case "apiKey":
      return "<api-key>";
    case "auth":
      return "chatgpt-oauth";
    case "temperature":
      return 0.6;
    case "compat":
      return {};
  }
}

/** Render a populated value for the one-line list (compact; the template
 *  below uses the pretty form). */
function showValue(f: keyof ModelConfig, v: unknown): string {
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  return JSON.stringify(v);
}

/**
 * Build the step-by-step configuration guide for one model. `model` is the
 * (partially populated) config to describe; `fileLabel` is the path (or
 * "a new file") the user should edit.
 */
export function buildModelsSetupGuide(
  model: Partial<ModelConfig>,
  fileLabel: string,
): string {
  const lines: string[] = [];
  lines.push(`tre. needs a model endpoint to start — none is configured yet.`);
  lines.push(``);
  lines.push(`Edit ${fileLabel} and fill in the fields below. The model that`);
  lines.push(`"default" points at (or the first one) is the active model.`);
  lines.push(``);
  lines.push(`REQUIRED (tre. will not start until every one is set):`);
  let step = 1;
  for (const f of REQUIRED_FIELDS) {
    const v = model[f];
    if (isPopulated(v)) {
      lines.push(`  ${step}. ${f} — populated: ${showValue(f, v)}`);
    } else {
      lines.push(`  ${step}. ${f} — NEEDED: ${placeholder(f)}`);
    }
    step += 1;
  }
  lines.push(``);
  lines.push(`OPTIONAL (leave unset for the defaults; they never block start):`);
  for (const f of OPTIONAL_FIELDS) {
    const v = model[f];
    if (isPopulated(v)) {
      lines.push(`  - ${f} — populated: ${showValue(f, v)}`);
    } else {
      lines.push(`  - ${f} — (unset)`);
    }
  }
  lines.push(``);
  lines.push(`Template (fill the NEEDED fields):`);
  const modelObj: Record<string, unknown> = {};
  for (const f of REQUIRED_FIELDS) modelObj[f] = isPopulated(model[f]) ? model[f] : placeholder(f);
  for (const f of OPTIONAL_FIELDS) if (isPopulated(model[f])) modelObj[f] = model[f];
  const fileObj = {
    default: isPopulated(model.id) ? String(model.id) : "<model-id>",
    models: [modelObj],
  };
  for (const l of JSON.stringify(fileObj, null, 2).split("\n")) lines.push(`  ${l}`);
  lines.push(``);
  lines.push(`Then re-run tre.`);
  return lines.join("\n");
}

/** True when the model has a usable endpoint (baseUrl populated). */
export function hasEndpoint(model: Partial<ModelConfig>): boolean {
  return isPopulated(model.baseUrl);
}

/**
 * Lenient read of a models.json for the startup guide: returns the active
 * (or first) model's populated fields WITHOUT throwing on missing required
 * fields — so the guide can show which are already filled in. Returns null
 * when the file is unreadable or not valid JSON (the strict loader reports
 * those); returns {} when the file has no models at all (an empty config).
 */
export function readActiveModelLenient(path: string): Partial<ModelConfig> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = (j ?? {}) as { default?: unknown; models?: unknown };
  const arr = Array.isArray(o.models) ? (o.models as unknown[]) : [];
  if (arr.length === 0) return {};
  const asRec = (x: unknown): Record<string, unknown> =>
    x !== null && typeof x === "object" ? (x as Record<string, unknown>) : {};
  const first = asRec(arr[0]);
  const wanted =
    typeof o.default === "string"
      ? o.default
      : typeof first.id === "string"
        ? first.id
        : undefined;
  const match =
    wanted !== undefined ? arr.find((x) => asRec(x).id === wanted) : undefined;
  const m = asRec(match ?? first);
  const out: Record<string, unknown> = {};
  for (const f of [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]) {
    if (m[f] !== undefined) out[f] = m[f];
  }
  return out as Partial<ModelConfig>;
}
