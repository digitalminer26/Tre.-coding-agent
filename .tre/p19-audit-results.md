# P19 audit — 3 cycles on the F1/F2 fixes (post-bda9d1f)

## Cycle 1 — fixes + adversarial tests (landed)

F1 (major, supervise.ts): lease creation was atomic (wx) but the WRITE
that followed was not — a reader could observe a partial body, parse no
pid, classify the lease stale, and take over from a live creator.
Fix: every lease publication stages the COMPLETE body (open wx + write +
fsync) into `host.lease.tmp-*` and publishes with `link()` (no-replace);
takeover replacement stages and `rename`s over the stale claim UNDER the
takeover lock. Unparseable fresh content is AMBIGUOUS (refused until the
mtime abandon bound, then disclosed recovery). Orphaned tmps older than
the bound are swept on the next takeLease.

F2 (medium, journal.ts): createEpisodeLayout checked graph.json ENOENT
then renamed — two concurrent first-creations both renamed, last writer
silently won. Fix: first publication goes through a no-replace `link()`;
the racing loser judges the WINNER's bytes with the P18-A3 identity rule
(identical → idempotent success; different → throw, winner untouched).

Tests: test/p19-fixes.test.ts — 7 named regressions (deterministic
link-moment pause proving COMPLETE-or-ABSENT; ambiguous fresh/stale;
tmp sweep age bound; concurrent same/different-seed first-creation;
byte-complete marker on first sight). 8 consecutive green runs; the
different-seed race test pins the INVARIANT (file == winner's bytes),
not which link wins.

## Cycle 2 — TOCTOU re-audit of the takeover paths (clean)

- replaceLeaseUnderLock: the only theoretical stomp (re-verify sees the
  old stale claim; between that and rename the path is released AND a
  fresh creator links a new lease, which our rename would clobber) is
  closed: a fresh creator cannot pass the fast path while the stale
  claim is present (EEXIST → recovery loop → needs the takeover lock we
  hold), and a live releaser would have been refused at re-verify
  (live-pid). The ambiguous-content branch re-judges `leaseAbandoned()`
  UNDER the lock (freshness is never assumed from the pre-lock check).
- Release is ownership-TOKEN gated (`"token":…` substring), so a pid
  reuse or a post-takeover unlink by a former holder cannot release a
  lease that is no longer ours.

## Cycle 3 — edge cases (clean) + probe (rewritten, passing)

- Cross-device link(): impossible by construction — the staging tmp is
  a sibling in the same directory, so EXDEV cannot occur.
- Tmp sweep racing a live publisher: sweep unlinks only tmps whose mtime
  is older than ABANDON_AFTER_MS (10s); a live publisher stages in
  microseconds (write+fsync+link of a <1KB body), so none of its own
  can be that old. Pinned by test (old tmp reclaimed, fresh tmp left).
- Rename over a concurrently released lease: covered in cycle 2; and if
  re-verify sees MISSING we take the exclusive publish path instead of
  rename, so takeover never renames over "absent" races blindly.
- .tre/p18-audit-probe.mjs intercepted `writeFile(…, {flag:"wx"})` —
  retired with the code path (it could no longer fire). Rewritten as
  .tre/p19-audit-probe.mjs: pauses publisher #1 at its `link()` moment
  (complete staged tmp, lease ABSENT — `leaseMissingAtLinkPause:true`),
  races activator #2, then lets both links collide. Result: #2 claims
  exclusive; #1 meets the winner's COMPLETE lease at its own link and
  refuses fail-closed (same-process contention error). One holder, zero
  partial reads, zero takeovers — the old protocol's window is closed.

## Verdict

F1 and F2 are fixed; the 3-cycle audit found no remaining race in the
publication, takeover, ambiguous-content, sweep, or release paths.
Suite: p18-cycle1/2 + host-supervise (79) + host-activation +
episode-journal (57) + p19 (7) all green.
