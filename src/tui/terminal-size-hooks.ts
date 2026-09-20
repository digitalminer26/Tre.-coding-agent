/**
 * C23 — terminal-size fd-leak fix, part 1: the ESM resolve hook.
 *
 * terminal-size@4 (ESM, a dependency of ink) leaks on macOS: devTty() does
 * `tty.WriteStream(fs.openSync('/dev/tty', ...))` to read .columns/.rows
 * and never closes the stream or the fd — one /dev/tty fd plus one libuv
 * socketpair leaked per call. ink's getWindowSize() falls back to
 * terminalSize() on every render frame whenever stdout has no columns/rows
 * (observed under PTYs such as `script`), so a long `tre. tui` session
 * leaks ~2 fds/frame and hits the macOS per-process fd cap
 * (kern.maxfilesperproc, default 10240). Beyond the cap every open() fails
 * with EMFILE: sandboxed bash spawns die ("bash: failed to spawn: EMFILE")
 * and fetch() dies ("error: fetch failed") — that is how the self-improve
 * loop crashed.
 *
 * This module is loaded on Node's module-customization (hooks) thread and
 * redirects the bare specifier "terminal-size" to
 * ./terminal-size-shim.js — a drop-in replacement that never opens
 * /dev/tty (the original's /dev/tty probe leaks one fd per call). See
 * terminal-size-shim.ts.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shimUrl = pathToFileURL(path.join(here, "terminal-size-shim.js")).href;

interface HookContext {
  parentURL?: string | null;
  [key: string]: unknown;
}

type NextResolve = (
  specifier: string,
  context?: HookContext
) => Promise<{ url: string; shortCircuit?: boolean } | { url: string }>;

export async function resolve(
  specifier: string,
  context: HookContext,
  nextResolve: NextResolve
): Promise<{ url: string }> {
  if (specifier === "terminal-size") {
    // shortCircuit: true is required (we bypass the rest of the chain)
    // though @types/node 24 predates it in the return type.
    return {
      url: shimUrl,
      shortCircuit: true,
    } as unknown as { url: string };
  }
  return nextResolve(specifier, context);
}
