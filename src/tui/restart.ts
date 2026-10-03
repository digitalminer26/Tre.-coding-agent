/**
 * /restart — the pure, testable core of the in-place restart. The driver
 * (run.tsx / the plain REPL in main.ts) owns the spawn + unmount; this
 * module only builds the spawn spec (restartCommand) and decides whether a
 * re-exec is even possible (isDirectInvocation). Zero runtime deps beyond
 * node builtins.
 */
import { realpathSync } from "node:fs";

export interface RestartCommand {
  execPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * The spawn spec for an in-place restart: re-exec the same argv with the
 * same node binary, marked via TRE_RESTARTED=1 (the env copy is made —
 * the caller's env object is never mutated). null when there is nothing
 * to re-exec (empty argv or no entry script).
 */
export function restartCommand(argv: string[], baseEnv: NodeJS.ProcessEnv): RestartCommand | null {
  if (argv.length === 0 || argv[1] === undefined) return null;
  return {
    execPath: process.execPath,
    args: argv.slice(1),
    env: { ...baseEnv, TRE_RESTARTED: "1" },
  };
}

/**
 * True only when the process was launched DIRECTLY as this module's entry
 * file (the same realpath comparison the CLI's entry-point guard uses).
 * A module import (tests) or a renamed binary that does not resolve to
 * entryPath → false (restart is then unavailable, by design).
 */
export function isDirectInvocation(processArgv1: string | undefined, entryPath: string): boolean {
  if (processArgv1 === undefined) return false;
  try {
    return realpathSync(processArgv1) === entryPath;
  } catch {
    return false;
  }
}
