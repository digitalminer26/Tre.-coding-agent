/**
 * WS3 — tool registry. The single place tools get looked up by name.
 */
import type { Tool } from "../types.js";

export class ToolRegistry {
  private byName = new Map<string, Tool>();

  /** Register a tool. Throws on duplicate name (developer error, not a
   *  runtime boundary — the CLI registers a fixed set once at startup). */
  add(tool: Tool): this {
    if (this.byName.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    this.byName.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  list(): Tool[] {
    return [...this.byName.values()];
  }

  get size(): number {
    return this.byName.size;
  }
}
