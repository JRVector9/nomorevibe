# HTTP integration fixture terminal settlement

Actual worker error IPC previously left a headers waiter pending. A clean worker exit before ready also left the startup waiter pending. Registering ready/result/headers terminal listeners immediately after fork now settles both waits, keeps the original result payload/error name/message, and still awaits actual child exit. Production HTTP admission, charge settlement, TTL and timeouts are unchanged.

Two real regressions each produced one assertion failure (pending versus rejected), then the same two bodies passed after the helper change: 2 PASS/18 skipped, 824ms tests, exit0. The original reader-cancel/follower case passed alone (925ms), and the original unread-body case passed alone (6.00s). A second unread-only observation exposed the ready→headers→rival error→consume→result→two exit0 order with verbose/disableConsoleIntercept; it did not change the original case. The original 18-case region (16,251bytes, SHA18a5d8b188675ee2c289c4eb2f1b3f216e95c606ad607528f0934a7d14d8ebe1) is byte unchanged. The whole 20-case file was not rerun.

Scoped two-file ESLint and TypeScript both exited0. Whole TypeScript exited2 on six missing generated Next PageProps names in the new worktree; no typegen/build/whole rerun was performed. Full manual tests are deferred until every PR development task is complete.

Root read the complete change, original/final reports and RED/GREEN logs, verified both test SHAs and unchanged production fetch/origin adapter SHAs, and independently checked the assigned loopback55529 DB. All85 public tables, original stage timestamps, catalog/ACL/roles/functions/triggers/defaults matched the fresh baseline; HTTP hops/events0, two append-only guards ALWAYS, other connections0. Exact own container/volume were normally stopped (exit0/OOMfalse) and removed.55529 must not be reconnected or recreated.

The initial readback helper compared a postgres Result prototype to a plain JSON array and failed; a subsequent shell exit0 was initially mistaken for its result. Original failed logs were preserved. Serialized raw values were independently equal; the comparison helper was corrected and final/root readback actually exited0. This was not a product failure or a functional RED.

The first timeout in main CI38835756288 is still not causally identified. These two proven fixture boundary defects must not be represented as proof of that CI root cause.

Evidence (local /tmp):

- nomorevibe-pr454-c-http-terminal-fix-20261016.md and terminal-final-shas JSON
- nomorevibe-pr454-c-http-{terminal-red,startup-red,terminal-green,cancel-control-green,original-unread-observed,original-unread-trace,terminal-scoped-tsc,terminal-eslint}-20261016.log
- nomorevibe-pr454-c-http-root-final-20261016.json
- nomorevibe-pr454-root-http-terminal-cleanup-20261016.json
