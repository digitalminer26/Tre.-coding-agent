/**
 * C23 — terminal-size fd-leak fix, part 2: the drop-in shim.
 *
 * This module replaces terminal-size@4 (redirected here by the resolve hook
 * in terminal-size-hooks.ts). It mirrors the original implementation
 * (stdout -> stderr -> env COLUMNS/LINES -> tput/resize -> 80x24) with ONE
 * difference: the /dev/tty probe is dropped entirely.
 *
 * Why: the original's devTty() is
 *
 *   const {columns, rows} = tty.WriteStream(fs.openSync('/dev/tty', flags));
 *
 * — and the WriteStream's libuv handle holds an fd that destroy()/close()
 * do not release (measured: exactly one fd per instance survives, forever).
 * So every terminalSize() call that reaches devTty() leaks a fd. ink's
 * getWindowSize() calls terminalSize() on every render frame whenever the
 * process stdout has no columns/rows (PTYs without a window size — e.g.
 * `script` driven from a non-terminal parent), so a long `tre. tui`
 * session exhausts the macOS per-process fd cap (kern.maxfilesperproc,
 * 10240) and then dies of EMFILE (bash spawn + fetch failures).
 *
 * Dropping devTty loses nothing useful: when stdout has no size, either
 * the controlling tty has one too (tput reports it — verified) or it has
 * none (size 0x0, which ink treats as "unknown" and falls back to 80x24 —
 * the same result devTty produced). Everything else is identical, including
 * the 80x24 fallback and the createIfNotDefault quirk (an explicit 80x24
 * from tput is treated as "unknown" so the next fallback wins).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const defaultColumns = 80;
const defaultRows = 24;

type TerminalSize = { columns: number; rows: number };

const exec = (
  command: string,
  args: string[],
  { shell, env }: { shell?: boolean; env?: NodeJS.ProcessEnv } = {}
): string =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 500,
    shell,
    env,
  }).trim();

const create = (columns: number | string, rows: number | string): TerminalSize => ({
  columns: Number.parseInt(String(columns), 10),
  rows: Number.parseInt(String(rows), 10),
});

const createIfNotDefault = (
  maybeColumns: number | string,
  maybeRows: number | string
): TerminalSize | undefined => {
  const { columns, rows } = create(maybeColumns, maybeRows);
  if (Number.isNaN(columns) || Number.isNaN(rows)) {
    return undefined;
  }
  if (columns === defaultColumns && rows === defaultRows) {
    return undefined;
  }
  return { columns, rows };
};

const tput = (): TerminalSize | undefined => {
  try {
    // `tput` requires the `TERM` environment variable to be set.
    const columns = exec("tput", ["cols"], { env: { TERM: "dumb", ...process.env } });
    const rows = exec("tput", ["lines"], { env: { TERM: "dumb", ...process.env } });
    if (columns && rows) {
      return createIfNotDefault(columns, rows);
    }
  } catch {
    // fall through
  }
  return undefined;
};

const isForegroundProcess = (): boolean => {
  if (process.platform !== "linux") {
    return true;
  }
  try {
    const statContents = fs.readFileSync("/proc/self/stat", "utf8");
    const closingParenthesisIndex = statContents.lastIndexOf(") ");
    if (closingParenthesisIndex === -1) {
      return false;
    }
    const statFields = statContents
      .slice(closingParenthesisIndex + 2)
      .trim()
      .split(/\s+/);
    const processGroupId = Number.parseInt(statFields[2] ?? "", 10);
    const foregroundProcessGroupId = Number.parseInt(statFields[5] ?? "", 10);
    if (Number.isNaN(processGroupId) || Number.isNaN(foregroundProcessGroupId)) {
      return false;
    }
    if (foregroundProcessGroupId <= 0) {
      return false;
    }
    return processGroupId === foregroundProcessGroupId;
  } catch {
    return false;
  }
};

const resize = (): TerminalSize | undefined => {
  // `resize` is preferred as it works even when all file descriptors are
  // redirected (https://linux.die.net/man/1/resize)
  try {
    if (!isForegroundProcess()) {
      return undefined;
    }
    const size = exec("resize", ["-u"]).match(/\d+/g);
    if (size && size.length === 2) {
      return createIfNotDefault(size[0] ?? "", size[1] ?? "");
    }
  } catch {
    // fall through
  }
  return undefined;
};

export default function terminalSize(): TerminalSize {
  const { env, stdout, stderr } = process;

  if (stdout?.columns && stdout?.rows) {
    return create(stdout.columns, stdout.rows);
  }
  if (stderr?.columns && stderr?.rows) {
    return create(stderr.columns, stderr.rows);
  }
  // These values are static, so not the first choice.
  if (env.COLUMNS && env.LINES) {
    return create(env.COLUMNS, env.LINES);
  }

  const fallback: TerminalSize = {
    columns: defaultColumns,
    rows: defaultRows,
  };

  if (process.platform === "win32") {
    return tput() ?? fallback;
  }
  // darwin: tput (no /dev/tty open — see header).
  if (process.platform === "linux") {
    return tput() ?? resize() ?? fallback;
  }
  return tput() ?? fallback;
}
