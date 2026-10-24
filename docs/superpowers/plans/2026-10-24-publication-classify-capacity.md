# Publication classification CLI capacity

The approved scope is one `publication_classify_cli` binding for the existing publisher → ConnectAgent classification call. The remote process owns prepare, reserve, source/lease proof, dispatch, native execution and opaque-terminal settlement. Existing model settings, pools and publication CAS remain in use. No production mutation, inference or merge is part of this branch.

- [x] Add failing schema and typed-defer regressions; execute them and record RED.
- [x] Extend the fixed CLI binding/target and member overlap fence, preserving the existing kinds and constraints.
- [x] Bind the real publisher job and role lease, candidate/document/settings/decision snapshot, exact inputs/definitions and remote generation/config to dispatch.
- [x] Reuse native CLI invocation and terminal settlement in ConnectAgent; a missing terminal stops fallback and retains capacity.
- [x] Add the bounded authority RPC and typed defer response. Preserve disabled legacy and rolling old-agent compatibility; publisher deferral must not hold or fail candidates.
- [x] Add migration 0125 after checking latest main for collisions. Preserve every old constraint predicate and verify valid/invalid new rows in an isolated local pgvector database.
- [x] Execute final focused unit/integration, typegen, tsc, changed-file ESLint and diff checks. Review complete diff and return a frozen feature commit to root. Parent will integrate with the separately approved evaluation fix, canonical docs and full CI; do not merge or deploy here.

Primary files: `lib/llm/{capacity,capacity-repository,cli-serving-contract,cli-model-capacity}.ts`, new `lib/crawl/publication-classify-capacity.ts`, `lib/operations/{agent,agent-client,contracts,claude}.ts`, `lib/crawl/{classify,jobs/publish}.ts`, `scripts/connect-agent.ts`, DB schema/migration and focused tests.

Required negative cases: absent/stale job/role or source/manual decision/settings/config; overlapping batch across owners; unknown physical end; fallback before prior terminal; typed defer becoming a hold/failure; old-agent rejection under open. A JSON terminal copy cannot settle, and historical terminal settlement must remain possible after policy/owner changes.

Validation starts with `npm test -- tests/publication-classify-capacity.test.ts tests/operations-agent-client.test.ts`. Real DB tests use a dedicated loopback container/port rather than another agent's DB. No production credentials are needed.

Codex `totalTokenBound` is declared evidence, not a count-admission criterion. Current invocation has no output/cost hard flag. Primary CLI model cache/context metadata must support any proposed bound; otherwise readiness remains blocked. `costBound: null` is valid; no invented monetary bound.
