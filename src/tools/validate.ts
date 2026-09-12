/**
 * WS3 — minimal JSON-Schema validation (zero deps).
 *
 * Covers what tool parameter schemas actually use: `type` (object/array/
 * string/number/integer/boolean), `required`, `properties`, `items`, `enum`.
 * Unknown keywords are ignored (lenient) — the goal is to catch obviously
 * malformed LLM arguments, not to be a spec-complete validator.
 */
import type { JsonSchema } from "../types.js";

const isInteger = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v);

function check(schema: JsonSchema, value: unknown, path: string): string | undefined {
  // enum wins over everything
  if (schema.enum !== undefined) {
    if (!schema.enum.includes(value as never)) {
      return `${path}: expected one of [${schema.enum.map((e) => JSON.stringify(e)).join(", ")}], got ${JSON.stringify(value)}`;
    }
  }

  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `${path}: expected object, got ${describe(value)}`;
      }
      const obj = value as Record<string, unknown>;
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (!(key in obj)) return `${path}: missing required property "${key}"`;
        }
      }
      if (schema.properties) {
        for (const [key, sub] of Object.entries(schema.properties)) {
          if (key in obj) {
            const err = check(sub, obj[key], `${path}.${key}`);
            if (err) return err;
          }
        }
      }
      return undefined;
    }
    case "array": {
      if (!Array.isArray(value)) {
        return `${path}: expected array, got ${describe(value)}`;
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const err = check(schema.items, value[i], `${path}[${i}]`);
          if (err) return err;
        }
      }
      return undefined;
    }
    case "string":
      return typeof value === "string" ? undefined : `${path}: expected string, got ${describe(value)}`;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? undefined
        : `${path}: expected number, got ${describe(value)}`;
    case "integer":
      return isInteger(value) ? undefined : `${path}: expected integer, got ${describe(value)}`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `${path}: expected boolean, got ${describe(value)}`;
    default:
      return undefined; // no type constraint
  }
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "object") return Array.isArray(v) ? "array" : "object";
  return `${typeof v} ${JSON.stringify(v)}`;
}

/**
 * Validate `value` against `schema`. Returns a human/model-readable error
 * string, or undefined when valid. Never throws.
 */
export function validateArgs(schema: JsonSchema, value: unknown): string | undefined {
  try {
    return check(schema, value, "arguments");
  } catch {
    return "arguments: validation failed (malformed schema or value)";
  }
}
