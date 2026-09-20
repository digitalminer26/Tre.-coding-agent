/**
 * C23 — stop the per-frame /dev/tty fd leak in ink's terminal-size
 * dependency (details: terminal-size-hooks.ts + terminal-size-shim.ts).
 *
 * terminal-size@4 (an ink dependency) leaks fds on macOS: devTty() wraps
 * fs.openSync('/dev/tty') in a tty.WriteStream whose libuv handle keeps an
 * fd that destroy()/close() never release — measured at exactly one fd per
 * call. ink's getWindowSize() falls back to terminalSize() on every render
 * frame whenever process stdout has no columns/rows (PTYs without a window
 * size — e.g. `script` driven from a non-terminal parent), so a long
 * `tre. tui` session leaks ~1-2 fds/frame and hits the macOS per-process
 * fd cap (kern.maxfilesperproc, 10240). Beyond the cap every open() fails
 * with EMFILE: sandboxed bash spawns die ("bash: failed to spawn: EMFILE")
 * and fetch() dies ("error: fetch failed") — that is how the self-improve
 * loop crashed after ~3 minutes of streaming.
 *
 * Fix: register an ESM resolve hook that redirects the bare specifier
 * "terminal-size" to ./terminal-size-shim.js — a drop-in replacement that
 * never opens /dev/tty (its tput probe reads the same size without any fd).
 * The hook only fires for the bare specifier "terminal-size"; nothing else
 * is affected.
 *
 * This module exports nothing and has no import-time side effects beyond
 * registering the hook. It MUST be imported (in source order) before ink
 * is loaded for the first time — main.ts imports it first, before
 * ../tui/run.js.
 */
import { register } from "node:module";

register(new URL("./terminal-size-hooks.js", import.meta.url), import.meta.url);
