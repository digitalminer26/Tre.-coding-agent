#!/usr/bin/env python3
"""Mutation sweep for src/context/compact.ts, REUSING the hardened
findings-mutate engine (scripts/findings-mutate.py) unchanged.

Why a wrapper instead of a copy: the engine carries the whole
crash-safety contract — signal-atomic spawn, per-child deadlines,
journal+quarantine crash recovery, flock sweep exclusivity, dist
destroy-and-prove, fail-closed registry audit, isolation re-runs and
attribution judgment. Copying it forks all of that maintenance; this
file rebinds its module-level constants to the compact.ts sweep and
delegates everything else. The engine file itself is NOT modified.

Rebinding (the engine reads ALL of these as module globals at call
time, so assignment after import takes effect for main()):

  SRC / DIST      src/context/compact.ts -> dist/src/context/compact.js
  SUITES          the minimal set whose per-suite cost keeps the full
                  sweep a few-minute operation (measured 2026-10:
                  compact 0.1s + session 0.2s + cli 0.6s ~= 1.0s per
                  suite pass; build ~3s; ~30s per mutant, ~18 min for
                  35 mutants — was 36 until plan-keepfrom-floor-off was
                  proven equivalent and retired, see its registry note).
                  cli.test.ts spawns the BUILT dist cli
                  module, so a compact.ts mutant that breaks the CLI
                  wiring (the WS9 auto-compact paths) is caught here
                  too — attribution stays unambiguous because
                  compact.test.ts and cli.test.ts share no test names
                  (asserted at startup below).
  MUTS            mutant registry for compact.ts (anchors verified
                  unique against the pristine source; the sweep also
                  refuses on a patch miss, like the engine does).
  _JOURNAL_ROOT   a dedicated scratch root (tmp/compact-mutate-journal)
                  so this sweep's journal/lock can never collide with
                  a findings sweep's — the journal path already hashes
                  realpath(SRC), but an isolated root makes an
                  accidental double-sweep impossible to even see each
                  other's litter.

Run:  python3 scripts/compact-mutate.py [name-filter ...]
Exit 0 only when every selected mutant was killed AND every kill was
attributed to baseline-green tests (the engine's gate).

The MUTS registry is a literal in THIS file so the engine's
fail-closed duplicate-name audit runs against the registry the sweep
actually uses (the engine audits the file it is imported from — see
_RegistryAudit below: we rebind the audit to THIS file's source).
"""
from __future__ import annotations

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE_PATH = os.path.join(HERE, "findings-mutate.py")
WRAP_PATH = os.path.abspath(__file__)

_spec = importlib.util.spec_from_file_location("findings_mutate_engine", ENGINE_PATH)
eng = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(eng)

# ---- rebind the sweep target ------------------------------------------------
eng.SRC = "src/context/compact.ts"
eng.DIST = "dist/src/context/compact.js"
eng.SUITES = [
    "dist/test/compact.test.js",
    "dist/test/session.test.js",
    "dist/test/cli.test.js",
]
# Isolated journal root: engine's journal is keyed by realpath(SRC) hash
# already, but a dedicated dir makes cross-sweep collisions structurally
# impossible and keeps tmp/ litter names self-describing.
eng._JOURNAL_ROOT = os.path.join(HERE, "..", "tmp", "compact-mutate-journal")
# The engine's lock/journal open WITHOUT creating parents (fail-closed
# on any open error), so the root must exist before any engine call.
os.makedirs(eng._JOURNAL_ROOT, exist_ok=True)

# The engine's duplicate-name audit parses __file__ — which resolves to
# the ENGINE file, where MUTS is the findings registry. Rebind it to
# audit THIS file's literal (fail-closed contract preserved: None on any
# parse failure still refuses the sweep).
_wrap_src = open(WRAP_PATH, encoding="utf-8").read()


def _mutant_name_dupes_wrapped() -> list[str] | None:
    import ast
    try:
        tree = ast.parse(_wrap_src, filename=WRAP_PATH)
    except (OSError, SyntaxError, UnicodeDecodeError):
        return None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "MUTS" for t in node.targets
        ):
            if not isinstance(node.value, ast.Dict):
                return None
            keys = [
                k.value
                for k in node.value.keys
                if isinstance(k, ast.Constant) and isinstance(k.value, str)
            ]
            if len(keys) != len(node.value.keys):
                return None
            seen: dict[str, int] = {}
            for key in keys:
                seen[key] = seen.get(key, 0) + 1
            return sorted(n for n, c in seen.items() if c > 1)
    return None


eng._mutant_name_dupes = _mutant_name_dupes_wrapped

# ---- the mutant registry ----------------------------------------------------
# Every anchor is a UNIQUE string in the pristine source (verified by
# scripts/compact-mutate-anchor-check, also asserted in main below).
# `old` -> `new` is a single exact replacement; the engine refuses (and
# restores) on a patch miss, so an anchor drifting out of the source is
# a loud failure, never a silent no-op mutant.
MUTS = {
    # --- estimation core ---------------------------------------------------
    "estimate-default-cpt-4-to-3": (
        "charsPerToken = 4): number {\n  let chars = 0;",
        "charsPerToken = 3): number {\n  let chars = 0;",
    ),
    "estimate-asst-branch-zeroed": (
        '} else if (m.role === "assistant") {\n    for (const b of m.content) {',
        '} else if (m.role === "assistant") {\n    for (const b of []) {',
    ),
    "estimate-messages-default-4-to-8": (
        "export function estimateTokens(messages: AgentMessage[], charsPerToken = 4): number {",
        "export function estimateTokens(messages: AgentMessage[], charsPerToken = 8): number {",
    ),
    "overhead-default-4-to-6": (
        "  charsPerToken = 4,\n): number {",
        "  charsPerToken = 6,\n): number {",
    ),
    # --- calibration ---------------------------------------------------------
    "calib-exclude-last-asst-dropped": (
        'if (last && last.role === "assistant") est -= estimateMessageTokens(last);',
        "/* mutant: exclusion removed */",
    ),
    "calib-clamp-low-1-to-2": (
        "return Math.min(4, Math.max(1, (4 * est) / actual));",
        "return Math.min(4, Math.max(2, (4 * est) / actual));",
    ),
    "calib-uncalibrated-return-3": (
        "if (est <= 0 || actual <= 0) return 4;",
        "if (est <= 0 || actual <= 0) return 3;",
    ),
    # --- trigger & constants -------------------------------------------------
    "reserve-default-16384-to-8192": (
        "export const DEFAULT_COMPACTION_RESERVE = 16384;",
        "export const DEFAULT_COMPACTION_RESERVE = 8192;",
    ),
    "summmax-2048-to-4096": (
        "export const SUMMARIZER_MAX_TOKENS = 2048;",
        "export const SUMMARIZER_MAX_TOKENS = 4096;",
    ),
    "shouldcompact-slack-dropped": (
        "return usage.totalTokens + reserve + slack > contextWindow;",
        "return usage.totalTokens + reserve > contextWindow;",
    ),
    # --- planCompaction --------------------------------------------------------
    "plan-min-units-3-to-2": (
        "if (bounds.length < 3) return undefined;",
        "if (bounds.length < 2) return undefined;",
    ),
    "plan-keep-walk-greedy": (
        "if (acc >= keepTokens) break;",
        "if (acc >= keepTokens + 1000000) break;",
    ),
    "plan-lastuser-extend-dropped": (
        "if (lastUser > 0 && lastUser < keepFrom) keepFrom = lastUser;",
        "/* mutant: last-user extension removed */",
    ),
    "plan-descent-crosses-prompt": (
        "if (opts.preserveLastUser !== false && lastUser >= keepFrom && nextStart > lastUser) break;",
        "/* mutant: descent may cross the live prompt */",
    ),
    # plan-keepfrom-floor-off: REMOVED (round-36 analysis) as a PROVABLY
    # EQUIVALENT mutant — the findings-mutate.py entrymode precedent ("kept
    # in source as defense-in-depth; not mutant-able with a kill"). No input
    # distinguishes `keepFrom <= 0` from `keepFrom < -1` (or from removing
    # the guard entirely): every write to keepFrom is >= 1.
    #   - bounds = unitBoundaries(context) is strictly increasing (one index
    #     per non-toolResult message); the `bounds.length < 3` refusal above
    #     gives bounds[1] >= bounds[0] + 1 >= 1, and the init and every walk
    #     assignment take keepFrom = bounds[bi] with bi >= 1.
    #   - the last-user extension is gated by `lastUser > 0` (so >= 1).
    #   - the shrink descent only ever assigns nextStart > keepFrom.
    # Hence keepFrom >= 1 at the guard for EVERY caller, the predicate is
    # always false, and the mutant is behaviorally identical by construction.
    # The guard stays in source as defense-in-depth for future callers.
    # --- transcript rendering ---------------------------------------------------
    "clip-limit0-returns-text": (
        'if (limit === 0) return "";',
        'if (limit === 0) return s.slice(0, 1);',
    ),
    "fileops-cap-50-to-40": (
        "const FILE_OPS_CAP = 50;",
        "const FILE_OPS_CAP = 40;",
    ),
    "files-half-budget-to-full": (
        "const filesMax = available === undefined ? undefined : Math.max(0, Math.floor(available / 2) - 2);",
        "const filesMax = available === undefined ? undefined : Math.max(0, available - 2);",
    ),
    "thinking-included-in-summary": (
        "includeThinking: false, // A2: decisions live in text/tool calls, not reasoning traces",
        "includeThinking: true, // A2: decisions live in text/tool calls, not reasoning traces",
    ),
    "toolresult-clip-2000-to-1999": (
        "toolResultChars: Math.min(transcriptOpts?.toolResultChars ?? 2000, transcriptChars),",
        "toolResultChars: Math.min(transcriptOpts?.toolResultChars ?? 1999, transcriptChars),",
    ),
    # --- ruleBasedShrink ---------------------------------------------------------
    "shrink-growth-guard-off": (
        "if (after >= before) return undefined;",
        "if (false) return undefined;",
    ),
    # --- compactContext budgets ----------------------------------------------------
    "headroom-slack-1024-dropped": (
        "opts.model.contextWindow - opts.model.maxTokens - 1024 - promptOverhead - summaryBudget;",
        "opts.model.contextWindow - opts.model.maxTokens - promptOverhead - summaryBudget;",
    ),
    "keeptarget-default-8192-to-8193": (
        "const keepTokens = Math.min(opts.keepTokens ?? 8192, windowCap);",
        "const keepTokens = Math.min(opts.keepTokens ?? 8193, windowCap);",
    ),
    "requestbudget-output-dropped": (
        "const requestBudget = opts.model.contextWindow - opts.model.maxTokens - 1024;",
        "const requestBudget = opts.model.contextWindow - 1024;",
    ),
    "boundfits-summbudget-dropped": (
        "p !== undefined && suffixTokens(p) + summarizerMaxTokens(opts.model) + summaryWrapperTokens + promptOverhead <= requestBudget;",
        "p !== undefined && suffixTokens(p) + summaryWrapperTokens + promptOverhead <= requestBudget;",
    ),
    "floorfits-always-true": (
        "p !== undefined && suffixTokens(p) + summaryWrapperTokens + promptOverhead <= requestBudget;",
        "p !== undefined && suffixTokens(p) + summaryWrapperTokens + promptOverhead <= requestBudget + 1e9;",
    ),
    "fold-min-summary-64-to-200": (
        "p3 && p3.keepFrom > (p2?.keepFrom ?? 0) && foldHeadroom(p3) >= MIN_FOLD_SUMMARY_TOKENS ? p3 : undefined;",
        "p3 && p3.keepFrom > (p2?.keepFrom ?? 0) && foldHeadroom(p3) >= 200 ? p3 : undefined;",
    ),
    "fold-afterdemo-trigger-off": (
        "estimateTokens([makeSummaryMessage(outcome.text), ...plan.kept], cpt) + promptOverhead > requestBudget",
        "false",
    ),
    "foldcap-floor-64-to-1024": (
        "if (outHeadroom < maxOut) maxOut = Math.max(64, Math.floor(outHeadroom));",
        "if (outHeadroom < maxOut) maxOut = Math.max(1024, Math.floor(outHeadroom));",
    ),
    "summ-input-toobig-off": (
        'if (summaryInputTokens + summarizerModel.maxTokens > opts.model.contextWindow) return "too-big";',
        'if (false) return "too-big";',
    ),
    # --- outcomes & guards -----------------------------------------------------------
    "abort-not-terminal-failed-first": (
        'if (aborted || opts.signal.aborted) return "aborted";\n    if (failed) return "failed";',
        'if (failed) return "failed";\n    if (aborted || opts.signal.aborted) return "aborted";',
    ),
    "empty-summary-accepted": (
        'if (text.trim() === "") return "empty";',
        "/* mutant: empty summary no longer rejected */",
    ),
    "abort-sentinel-downgraded": (
        'if (outcome === "aborted") return COMPACT_ABORTED;',
        'if (outcome === "aborted") return undefined;',
    ),
    "fold-replace-fit-guard-off": (
        "if (foldEstimate <= requestBudget) {",
        "if (true) {",
    ),
    "strictfold-fit-reject-off": (
        "if (strictFoldRung && estimatedTokensAfter > requestBudget) return undefined;",
        "if (false) return undefined;",
    ),
    "growth-guard-exemption-dropped": (
        "if (estimatedTokensAfter >= estimatedTokensBefore && !(strictFoldRung && livePromptFolded)) return undefined;",
        "if (estimatedTokensAfter >= estimatedTokensBefore) return undefined;",
    ),
}


def main() -> int:
    # Engine setup order note: the engine acquires the sweep lock and
    # recovers a crash-journalled SRC inside eng.main() — the checks
    # below must run against the PRISTINE source, so recovery is
    # hoisted here. All three calls are idempotent (engine re-runs
    # them; a held lock returns True, a drained journal recovers to a
    # no-op), and hoisting does not weaken any guarantee: the lock is
    # still taken before anything is mutated, recovery is still the
    # first destructive-capable step, and a refusal below happens
    # BEFORE any mutant can be applied (the journal stays untouched).
    if not eng._acquire_sweep_lock():
        print("SWEEP LOCK BUSY — another sweep holds the journal for this source")
        return 1
    eng._DIST_SUSPECT = True
    try:
        eng._journal_recover()
    except (eng.JournalCorrupt, eng.JournalRecoverFailed) as e:
        print(f"JOURNAL RECOVERY FAILED ({type(e).__name__}) — sweep refused")
        return 1

    # Startup self-checks (fail fast, BEFORE the engine arms anything):
    # 1) test-name uniqueness across SUITES — the engine attributes a
    #    kill by test NAME across the merged suite map, so a name shared
    #    between compact.test.ts and cli.test.ts would make kills
    #    ambiguous. node --test reports duplicates as its own baseline
    #    refusal, but that fires AFTER a full build — this is free.
    # 2) every anchor is unique in the pristine source (the engine also
    #    refuses on a patch miss per-mutant; catching drift once here
    #    is cheaper than N refusals after N builds).
    import re
    import subprocess

    names: dict[str, str] = {}
    dupes: list[str] = []
    for suite in eng.SUITES:
        p = os.path.join(os.getcwd(), suite)
        if not os.path.exists(p):
            # dist may be stale/absent pre-build; the engine's baseline
            # build covers it. Uniqueness check only runs on what exists.
            continue
        with open(p, encoding="utf-8") as fh:
            txt = fh.read()
        for m in re.finditer(r'\b(?:test|it)\(\s*(["\'`])(.*?)\1', txt):
            nm = m.group(2)
            if nm in names and names[nm] != suite:
                dupes.append(f"{nm!r} in {suite} and {names[nm]}")
            names.setdefault(nm, suite)
    if dupes:
        print(f"WRITER CHECK FAILED — test names shared across SUITES "
              f"(kills would be unattributable): {dupes}")
        return 1

    try:
        src = open(eng.SRC, encoding="utf-8").read()
    except OSError as e:
        print(f"WRITER CHECK FAILED — SRC unreadable: {e}")
        return 1
    bad = [k for k, (old, _) in MUTS.items() if src.count(old) != 1]
    if bad:
        print(f"WRITER CHECK FAILED — anchors not unique in {eng.SRC}: {bad}")
        return 1

    eng.MUTS = MUTS
    return eng.main()


if __name__ == "__main__":
    sys.exit(main())
