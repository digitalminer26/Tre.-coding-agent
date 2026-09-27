/**
 * WS3 — the default MVP toolset (D3): read, write, edit, bash.
 */
import { ToolRegistry } from "./registry.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import type { Tool } from "../types.js";

export { readTool } from "./read.js";
export { writeTool } from "./write.js";
export { editTool } from "./edit.js";
export { bashTool, createBashTool } from "./bash.js";
export { ToolRegistry } from "./registry.js";
export {
  makeToolExecutor,
  isPermissionStallText,
  stallText,
  STALL_PERMISSION_PATTERNS,
  type ToolPipelineHooks,
  type BeforeToolCall,
  type AfterToolCall,
} from "./pipeline.js";
export { validateArgs } from "./validate.js";
export {
  truncateHead,
  truncateTail,
  truncationMarker,
  saveFullOutput,
  MAX_LINES,
  MAX_BYTES,
  type TruncateResult,
} from "./truncate.js";

export const DEFAULT_TOOLS: Tool[] = [readTool, writeTool, editTool, bashTool];

/** A fresh registry pre-loaded with the MVP toolset. */
export function defaultRegistry(): ToolRegistry {
  return new ToolRegistry().add(readTool).add(writeTool).add(editTool).add(bashTool);
}
