# s5log.ts adversarial audit arc — STATUS: EXTENDED (23 cycles)

Date closed: 2026-11-22 (through c10). Extended through c17 on
2026-11-23; five further cycles (c18–c22) plus a c23 verification
cycle on 2026-11-23/24. Tree left UNCOMMITTED per owner instruction.

## Result

10 haiku-auditor cycles (`s5log-c1..c10.txt`, prompts
`s5log-c*-prompt.txt`, driver `s5log-audit-cycle.py` — NOTE the
driver replaces its default source list when positional files are
given: pass BOTH `src/findings/s5log.ts` AND
`test/findings-s5log.test.ts`, else the auditor only sees what you
name — c9's first run was inconclusive for exactly this reason and
was re-run).

- c9 (whole-fold re-audit of tailCorrupt + localization test):
  **Findings: None.** Its boundary questions were closed
  empirically (probes below), not just from code.
- c10 (final, fresh-eyes + contract re-verification): **CLEAN
  except one minor, provable header-contract finding** (c10-F1:
  header claimed "exactly ONE fsync of the log fd" per writing
  pass, but a cold instance on a warm log pays establish-prefix +
  pass sync — two log-fd fsyncs). FOLD: header reworded to state
  V-g13 bounds the DECISION sync (repair + every append share one);
  the establish-prefix sync is a watermark proof of bytes already
  on disk (v33), not a decision. Pinned by a new test:
  `c10-F1 contract: cold instance on a warm log = exactly one
  decision fsync + one establish-prefix` (order-checked: establish
  < append).

## Folds landed in this arc's final stretch (all in working tree)

- **c8-Q2 tailCorrupt**: a `\r`-terminated tail that parses only
  after the \r-strip is classified CORRUPT (not complete):
  `readState.tailCorrupt`, (c0) refusal in `appendUnit` at line
  `lines.length+1` before any mutation, replay reports it in
  `corruptLines` via `buildPrefix(corruptTailLine?)` at both call
  sites. c9 confirmed: `tailCorrupt` implies `tailKind ===
  "partial"` (`lineIsValid` rejects any \r-ending text) — never
  double-counted in `recordTexts`/`reliedBytes`; line numbers
  cannot collide with mid-file `i+1`.
- **c8-Q1 localization** (c5-Q1): hardlink round-trip proves the
  digest line is the sole refusing gate (mutation-verified).
- **c10-F1**: header contract reword + pin test (above).

## Empirical probes closing auditor questions

- `{"x"}\r\r` tail -> append ACKED, tail truncated as ordinary
  torn residue (single-\r-strip rule; documented boundary).
- blank mid-line + `\r`-tail -> refusal @2 (mid-file blank caught
  first); replay `corruptLines [2,3]`; lone-`\r`-tail -> @1.
- mid-file corrupt + `\r`-tail -> replay reports both lines, no
  collision.

## Mutation matrix (G1 guards)

- `mutG1invert` (guard fires on wrong condition): 62 fail —
  KILLED.
- `mutG1drop` (remove both existsSync identity guards): 71 pass —
  SURVIVES, accepted as defense-in-depth: downstream fd-identity
  gates (assertSameInode on the establish fd and the mutation fd)
  refuse the same interleaving with the same error class before any
  write. Documented residual.

## Accepted residuals (proven, documented; unchanged unless noted)

S1/S5 guard-deletion survival; byte-identical recreation; rm after
final ack gate; pid-reuse/zombie; null-pid sweep; 2 GiB cap
raw-errno escape; cross-host flock; raw-errno taxonomy gap; c4-F1
one-pass appear refusal; mutG1drop redundancy; **NEW: `\r\r` tail
= ordinary torn residue, silently truncated per the single-\r-strip
rule** (c9-confirmed boundary).

## Extension cycles c11–c17 (post-close, same driver + auditor)

- **c11**: warm log + deleted marker ritual shape pinned (log-file +
  append, no establish-prefix) — test added.
- **c12**: bootstrap ritual proven non-mutating; carve-out
  documented; refusal-after-ritual test added.
- **c13**: (F1) lock/bootstrap syncs listed as ADDITIONAL to the
  decision fsync; (F2) unreadable/malformed marker named as a
  bootstrap trigger; (F3) order pinned — ritual completes BEFORE
  `make()` observes the pass (spy-label snapshot test).
- **c14**: header overstatements corrected — (F1) "warm marker-
  established pass = decision fsync and nothing else" reworded to
  the watermark-based shape (cold instance on marker-valid log pays
  establish-prefix); (F2) NULL-PID paragraph now names the
  emptyPartial gate (0-byte entries swept at 1 s, any shape;
  behavior already tested at cycle-3 m3).
- **c15**: error taxonomy — (F1) environment failures on the log
  path (EACCES/EISDIR/EPERM) documented as RAW errno-bearing
  escapes (not protocol states; `.code` survives; claim released
  by finally; probe-verified) and (F2) ALL plain-Error wrap sites
  (lock acquire x3, mkdirDurably, ancestor sync, establishment
  ritual x2) now preserve `cause` + `code`. Two EACCES-path tests
  added (chmod-000 log; read-only parent).
- **c16**: classification core (NDR-r, refile bounds, replay-vs-
  appendunit) held clean; (F1) intra-unit duplicate -> `refiled`
  documented (evaluated at return) + pinned incl. atomic refusal
  of a divergent twin; (F2) `classifyRedelivery` re-serialization
  caution documented.
- **c17**: (F1) REAL DEFECT FIXED — same-inode in-place shrink
  left stale byte-watermark "proven": `ensureEstablished` now
  drops the whole proof when `st.size < provenThrough` (a shrink
  may be followed by rewrites no past fsync covered); header's
  identity-not-content paragraph updated (shrink IS visible via
  size; same-size rewrite remains the documented residual);
  pinned by a spy test (establish-prefix re-runs after shrink).
  Q1/Q2/Q4 clean (marker-dir-sync-throw residual documented-safe).

## Known flake (unreproduced)

One full-suite failure (1 of ~5 runs at c13-fold time) occurred
whose test name was never captured (sandbox /tmp restriction ate
the log then). Suspected timing-sensitive lock/sweep test. Since
c17: 6 consecutive full-suite runs 3063/0 + 6 earlier s5log-only
runs clean; c18–c23 added ~10 more full-suite runs (3063→3066/0) —
all clean, no capture to chase. NOT reproduced; flagged for
re-investigation only if it recurs with a captured name.

## Extension cycles c18–c23 (owner-requested 5-cycle run: c19–c23;
c18 was the immediately-preceding cycle)

- **c18**: (F1) header claimed `lock-acquire` runs only on the
  cold/absent path — probe (`s5log-probe-c18.ts`) proved it runs on
  EVERY acquisition (claim-entry fsync; warm append =
  `lock-acquire, append`, warm replay = `lock-acquire`); header
  corrected to split claim fsync from cold-only ritual syncs.
  (F2) shrink wording: detection is size-SAMPLED at pass start, not
  continuous — reworded. New test counts EVERY sync label on warm
  append / identical redelivery / replay (after a priming pass —
  the cold first pass pays establish-prefix, the c10-F1 shape).
- **c19**: exhaustive line-by-line header sweep (blocks of 10).
  One FALSE: the takeover-rule list omitted the c6-M3 removal of a
  WELL-FORMED dead-creator claim at ANY age (code correct, doc
  incomplete) — header fold with the liveness-gate-is-same caveat;
  behavior was already pinned by the c6-M3 test (line ~1125 of the
  test file), so no new test.
- **c20**: CLEAN. Sweep TOCTOU closed by the re-verify block
  (dev/ino + mtime + token re-read before unlink; residual check-
  then-unlink gap documented); marker format: only
  `{version:1, establishedAt:int>=0}` JSON passes — trailing
  garbage/empty/directory all force the ritual, header-conform;
  pid edges: `pid>0` enforced at parse, own-pid entry fails closed
  (live creator never broken); replay's non-identity establish-sync
  errors honestly yield `durability:"unproven"`.
- **c21**: CLEAN on the JOINT interactions: shrink x marker-
  bootstrap carve-out (external truncate-0 + fresh marker: the
  marker is never consulted while established=true; the size check
  discards the proof first — nothing mislabeled proven);
  establish-prefix throws x V-g3/V-g5 (watermark/marker/claim
  state unmoved; replay -> honest unproven; only identity errors
  propagate); intra-unit refiled `[a,a]` x shrink x replay (the
  returned receipt made no claim about later bytes).
- **c22**: TWO CODE FOLDS. (F1) the ACKED return was the only
  caller-visible decision NOT claim-fenced — `assertClaimHeld(held)`
  now runs before it (after the mutation fsync, before the ack
  crosses); a test plants an adversary unlinking our claim at the
  `"append"` sync and asserts the ack refuses as `S5LockLostError`.
  (F2) a NON-DIRECTORY at `<log>.lock` (pre-cycle-4 legacy lock
  file) wedged every call with a raw ENOTDIR from the claim-open —
  now refused DETERMINISTICALLY in `acquireLock` with a stable
  `code:"ENOTDIR"` plain Error (never deleted; operator decision),
  pinned by a test. Q2 named test-scope residuals (accepted, not
  defects): "exactly ONE fsync" (V-g13) counts the decision label —
  the c18 all-labels test carries the full-set contract; "every
  exit path" covers ack + one refusal.
- **c23**: attack on the c22 code itself. Q1: the new ack-fence
  throw leaves the record durable + watermark advanced over bytes
  THIS pass synced (successor dedups via NDR-r — no false proven);
  header's DURABLE-BUT-REFUSED section extended to cover the
  `S5LockLostError` throw site (caller: throw ⇒ outcome UNKNOWN,
  never "throw ⇒ nothing written"). Q2: taxonomy sentence added —
  registry-path environment failures escape RAW with `.code`
  (ENOTDIR deterministic; NOT S5LockBusyError — waiting cannot fix
  it; no `catch(S5LockBusyError)` swallows it). Symlink-to-dir at
  the registry accepted as operator-visible placement. Q3: own
  claim can never orphan outside the registry. No code defects.

## Final verification (c23 state)

- `npx tsc --noEmit`: clean.
- s5log suite: **82 pass / 0 fail**.
- Full repo suite: **3080 tests, 3066 pass / 0 fail** (14 skipped),
  consecutive clean runs through every fold.
- Tree left uncommitted (owner instruction). An unrelated
  uncommitted edit exists in `docs/audits/g1-implementation-
  mapping.md` (s5log row) — flagged, owner confirmation pending.
