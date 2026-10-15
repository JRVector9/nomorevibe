# PR01a Capacity CLI Error Boundary Plan

**Goal:** Keep both advertised capacity CLIs from echoing artifact contents, credentials, file paths, queries or database error details through their final error handler.

**Approved design:** Parent accepted a shared pure error formatter. A Zod error produces `invalid_capacity_artifact`; only exact internally fixed diagnostic strings are preserved; every other value produces `capacity_operation_failed`. No DB/provider/publication path is added. Parent owns URL admission changes and existing test files.

**Files:**

- Create `lib/operations/pipeline-capacity-cli.ts`: shared formatter and explicit exact-string allowlist.
- Update only the final catch handlers in `scripts/measure-pipeline-capacity.ts` and `scripts/export-pipeline-capacity.ts` to call it.
- Create `tests/pipeline-capacity-cli.test.ts`: pure formatter cases and subprocess CLI error regressions.
- This plan records actual verification; no commits, production access, model calls or DB calls are permitted in this subtask.

## Execution steps

1. Write dedicated tests before implementation. Pure cases cover a Zod unknown-key error, known fixed own diagnostics, unknown Error/FS/DB-shaped errors, non-Error values, and rejection of prefix/suffix variations of known codes. Subprocess cases pass valid JSON containing an unknown key named with a private canary through both CLIs; each must return only `invalid_capacity_artifact`, exit 1, and empty stdout. Also cover fixed malformed-JSON and missing-explicit-test-DB errors. Use temporary artifacts and an environment with DB/PG override variables removed; no subprocess case may reach a DB import.
2. Run the dedicated suite and record actual RED. The missing formatter is an initial failure; observe the existing CLI canary disclosure assertion fail before replacing the handlers.
3. Implement the pure formatter with `ZodError` detection and an explicit `Set` of exact fixed errors already thrown by the two CLIs/core/snapshot. Preserve existing expected guard codes and exact usage strings. Arbitrary messages never pass by a regex/prefix check.
4. Update both CLI catch handlers. Run the dedicated suite plus existing CLI guard/core tests. Run scoped ESLint and TypeScript if the parent has generated route types available. Record actual command results without claiming DB integration.
5. Report modified files, resolved boundary, review findings outside this ownership and remaining work to the parent. Parent integrates repository handoff and wider validation.

## Acceptance

- Every canary remains absent from stdout/stderr.
- JSON syntax errors remain `invalid_artifact_json`; existing DB admission guards retain their fixed codes.
- Unexpected filesystem/database errors become `capacity_operation_failed` without printing path/query/URL/cause.
- `replay` remains unimplemented, and this change never constructs a DB client or invokes a provider/publisher.

## Execution record

Executed RED before implementation:

```sh
npx vitest run tests/pipeline-capacity-cli.test.ts
# exit 1: 18 tests, 15 failed / 3 passed.
```

The missing formatter caused the programmatic failures. Both subprocess canary assertions also failed against the existing handlers and displayed the valid JSON unknown key in Zod's diagnostic. Existing malformed JSON and missing-explicit-test-DB checks already passed. The initial dynamic missing-module loader was replaced with a normal static import once the module existed; the behavioral assertions were retained.

Implemented the shared pure formatter, exact diagnostic allowlist and both final catch-handler replacements. No core/repository/parent test file was modified by this agent.

Actual GREEN and validation:

```sh
npx vitest run tests/pipeline-capacity-cli.test.ts
# exit 0: 18 passed.
npx vitest run tests/pipeline-capacity-cli.test.ts tests/pipeline-capacity-export.test.ts tests/pipeline-capacity.test.ts
# exit 0: 3 files / 86 passed.
npx eslint lib/operations/pipeline-capacity-cli.ts scripts/measure-pipeline-capacity.ts scripts/export-pipeline-capacity.ts tests/pipeline-capacity-cli.test.ts
# exit 0.
npx tsc --noEmit
# exit 0.
git diff --check
# exit 0.
```

Vitest emitted the existing Vite native-config compatibility warning. No DB integration, client construction, production call, provider call or publication call was executed in this subtask.

The independent boundary review also found a distinct postgres.js first-`@`/multihost parsing discrepancy that could bypass a WHATWG-only hostname guard. The parent owns and implemented the admission fix and regression tests. Static review confirmed equality between the raw first-`@` host segment and canonical single loopback authority rejects that reproduced bypass while percent-encoded `@` in credentials remains safe. Installed postgres.js's IPv6 host splitting has a preexisting functional limitation; no remote escape remained visible in the corrected admission guard. Those core/test-database changes are outside this agent's ownership.

Remaining: parent repository handoff, wider validation and review integration. PR01b real-model replay stays unimplemented and PR01a reports remain unverified snapshots.
