# P18 follow-up audit — bda9d1f

Scope: HEAD against 58542d5. Initial working tree clean. No production code modified.

Verification: `npm run build` passed; `node --test dist/test/p18-cycle1.test.js dist/test/p18-cycle2.test.js dist/test/host-activation.test.js dist/test/host-supervise.test.js` passed 86/86 (0 skip).

## F1 — Major: fresh non-empty partial lease is eligible for takeover

Locations: src/host/supervise.ts:969-973,1027-1033; initial publication at 924-925.
The code treats only an exactly empty string as a publication in progress. A fresh prefix such as `{` has no pid and is taken over immediately, even while its creator remains live. The takeover lock excludes other recovery paths but does not exclude the original wx writer. Both writers can therefore believe they own the lease. A deterministic interleaving probe in `.tre/p18-audit-probe.mjs` intercepts the original exclusive write, publishes `{`, pauses, starts a second activation, and resumes the first after the takeover. Result: the second activation proceeds; the first reaches protected setup and is rejected only by AttemptRunner's same-process guard. This is NOT a two-process split-brain reproduction, but it demonstrates that the lease itself does not provide the claimed exclusion; the same-process runner guard would not apply across processes.

Recommendation: serialize all publication/recovery paths under one ownership protocol; publish only complete validated records atomically without replacing a live claim. Treat partial/unparseable fresh records as ambiguous, not proven-dead. Add a barrier-controlled writer/recovery test, ideally in distinct processes.

## F2 — Medium: seed immutability still has a first-creation TOCTOU

Locations: src/episode/journal.ts:68-72,90-94.
The existing-graph comparison only protects graphs present at the initial read. Concurrent `createEpisodeLayout(root,id,A)` and `createEpisodeLayout(root,id,B)` both see ENOENT, both successfully publish through rename, and the latter overwrites the former. Reproduced with Promise.allSettled: both fulfilled, persisted goal B. This is a residual hole in the P18 immutability hardening, not a newly introduced concurrency behavior. The sanctioned host path is intended to be serialized by the lease, so severity is medium for the exported layout API (higher if host exclusion is bypassed as in F1).

Recommendation: publish initial graph with atomic no-replace semantics and compare the winner on EEXIST, or enforce the same initialization lock inside this API. Add a concurrent different-seed test: exactly one winner, the loser must reject without changing the winner's bytes.

No full-suite run in this audit. No fixes applied. W16 from the preceding assistant message was never implemented and is not part of this diff.
