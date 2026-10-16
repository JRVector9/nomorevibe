# HTTP timeout CI diagnosis — temporary draft only

This branch collects fixed subphases from the existing HTTP origin permit fixture in the CI runtime. It is not a production fix and must not be merged or deployed. PR453 remains unchanged.

## Observed problem

PR453 CI38866562519 and PR470 CI38867697249 each fail only the unread-response rival test at its unchanged20s deadline. The rival waits roughly14s after fetch entry; sampled PostgreSQL backends are idle/ClientRead with no blockers. Failure cleanup aborts and actually closes both children. These observations do not identify the pending JavaScript await or timeout signal lifetime.

## Instrumentation

Four temporary files add noexcept IPC for request/import, the first reservation transaction, the first abortable delay, native dispatch, and child runtime metadata. The parent accepts fixed bounded fields only. SQL47, original20case statements/assertions, await ordering, inline AbortSignal.any/timeout100, delay50, reservation5000ms, test20s and hook60s are unchanged. No new awaited operation, authority, provider request or DB policy is added.

The optional HTTP_TEST_GC=1 mode exposes GC only to fixture children and makes at most8calls at10ms intervals for the capped100ms rival. HTTP_TEST_OBSERVE_TIMEOUT=1 retains the existing optional timeout listener. Both remain off in ordinary CI. Instrumentation may affect scheduling; a passing instrumented run does not establish a fix.

## Executed local evidence

On Node24.18/Darwin arm64, the original unread case was run once per OFF/OFF-GC/ON mode against one fresh owned loopback DB. All three passed (6.49s/6.43s/6.37s), with the first delay rejecting at parent-observed101.006/101.328/101.055ms. GC occurred3times after import; cold-import GC was not directly stressed. Each run closed its two children without forced drain.

The exact four-file scoped TypeScript/ESLint and AST conformance checks passed before these runs. No manual full suite/build/typegen was run. Root independently compared captured88tables/90rawrows and catalog/ACL/roles/defaults/triggers against baseline and agent final; all matched. The normal event sequence change NULL→9 was preserved. Initial underlying sequence state was not captured. The root readback found0other connections, then normally stopped the exact owned container (exit0/OOMfalse) and removed only its volume. A first root comparison setup incorrectly required identical snapshot keys before the later-added sequence sample; that setup failure was preserved and corrected, without DB writes or case repetition.

## Next decision

Submit this separate draft to the unchanged required CI and inspect exact Node24/Linux child metadata and subphases. Do not rerun an unchanged failed CI, relax timeouts, count this as a production correction, or merge this diagnostic branch. If it passes, retain the unresolved intermittent-CI limitation. PR471 also has two separately investigated source-claim authority failures; those are not evidence for the HTTP cause.
