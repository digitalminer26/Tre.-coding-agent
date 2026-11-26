#!/bin/sh
# Findings-module gate: typecheck, ALL findings suites (intake, records,
# s5log, the promoted g1s4 probe suite, and the mutate-driver unit suite
# pinning the sweep's judgment core), and the mutation audit
# (revert each guard individually; the suites MUST kill every mutant —
# a survivor is an unguarded code path).
# Wiring (g1s5-c1 finding D6, dispositioned intentional): npm test runs
# quality-check.sh + ALL suites incl. these four — the TEST half of this
# gate is inside npm test already. The MUTATION sweep is deliberately NOT
# in npm test / quality-check.sh (a ~28x rebuild cost on every repo-wide
# test run); it runs via `npm run test:findings` — the module's own gate,
# which CI/the owner run per findings-module change.
# Usage: sh scripts/findings-gate.sh [--no-mutate]
set -e
cd "$(dirname "$0")/.."
node_modules/.bin/tsc
node --test dist/test/findings-records.test.js dist/test/findings-intake.test.js \
  dist/test/findings-intake-probes.test.js dist/test/findings-s5log.test.js \
  dist/test/findings-mutate.test.js
if [ "$1" != "--no-mutate" ]; then
  python3 scripts/findings-mutate.py
fi
