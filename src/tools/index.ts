/**
 * WS3 — the default MVP toolset (D3): read, write, edit, bash — plus the
 * `subtask` tool (workstream tracking; the TUI's `subtasks` bottom field
 * reads its results).
 */
import { ToolRegistry } from "./registry.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { subtaskTool } from "./subtask.js";
import type { Tool } from "../types.js";

export { readTool } from "./read.js";
export { writeTool } from "./write.js";
export { editTool } from "./edit.js";
export { bashTool, createBashTool } from "./bash.js";
export { subtaskTool, createSubtaskTool, canonicalSessionPath, subtaskKey } from "./subtask.js";
export { ToolRegistry } from "./registry.js";
export {
  makeToolExecutor,
  isPermissionStallText,
  stallText,
  STALL_PERMISSION_PATTERNS,
  REPEAT_FAILURE_WINDOW,
  REPEAT_FAILURE_THRESHOLD,
  familyFailureKey,
  pruneExpiredFamilyEntries,
  SAME_FAMILY_WARN_THRESHOLD,
  SAME_FAMILY_WINDOW,
  type ToolExecutor,
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

export const DEFAULT_TOOLS: Tool[] = [readTool, writeTool, editTool, bashTool, subtaskTool];

/** A fresh registry pre-loaded with the MVP toolset. */
export function defaultRegistry(): ToolRegistry {
  return new ToolRegistry().add(readTool).add(writeTool).add(editTool).add(bashTool).add(subtaskTool);
}
