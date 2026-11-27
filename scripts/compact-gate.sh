#!/bin/sh
# Compaction-module gate: typecheck, the three suites the mutation sweep
# attributes kills to, and the compact mutation audit (revert each guard
# individually; the suites MUST kill every mutant — a survivor is an
# unguarded code path). 35 mutants, ~30 s each (~18 min).
# Wiring mirrors findings-gate.sh (g1s5-c1 D6 disposition): npm test
# already runs the TEST half (all suites); the MUTATION sweep lives
# OUTSIDE npm test (~28x rebuild cost) and runs via `npm run test:compact`
# — the module's own gate, which CI/the owner run per compact-surface
# change. Registry note: plan-keepfrom-floor-off was proven equivalent
# and retired (see scripts/compact-mutate.py) — the registry is the
# killable set, 36 -> 35.
# Usage: sh scripts/compact-gate.sh [--no-mutate]
set -e
cd "$(dirname "$0")/.."
node_modules/.bin/tsc
# EXACTLY the engine's three-suite baseline command (per-suite
# subprocesses, deterministic — see the 2026-11-27 sweep runs): the
# repo-wide `npm test` half lives in the CI `test` job and carries
# env-dependent flakes unrelated to compact; the sweep's green-baseline
# gate must not inherit them.
node --test dist/test/compact.test.js dist/test/session.test.js \
  dist/test/cli.test.js
if [ "$1" != "--no-mutate" ]; then
  python3 scripts/compact-mutate.py
fi
