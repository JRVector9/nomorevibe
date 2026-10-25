# Historical direct provider boot boundary V4 Implementation Plan

> **For agentic workers:** Execute inline with TDD and root review checkpoints. No additional subagent, push or production action is authorized in this phase.

**Goal:** Release an unresolved direct native request after a proved original-owner group exit and native host reboot, while separately proving the current ingress has ended.

**Architecture:** New strict V4 composes V2 durable original-owner proof with V3 boot/contract/transport evidence. Additive0131 delegates all historical versions and adds same-transaction records enforcement. Existing state, usage and audit semantics remain intact.

**Tech Stack:** TypeScript/Zod, PostgreSQL17/Drizzle, Vitest, existing privileged boundary CLI.

---

## Task 1: Strict V4 contract and fixture, RED then GREEN

Files: `lib/llm/provider-boundary-contract.ts`; new `tests/fixtures/provider-boot-historical-owner.ts`; new `tests/provider-boot-historical-owner.test.ts`.

- [x] Build a synthetic V4 fixture from bootBoundaryFixture, with historicalOwnerFixture's originalOwner, matching ownerAssociation group and localEnd ID, and currentIngressOwner born after dispatch. Keep old owner out of the new plan.
- [x] Assert `providerBoundaryPlanSchema.safeParse(plan).success === true`, receipt version4 accepted, and full modelDispatchReleaseEvidenceSchema accepted only with correct hashes/evaluatedAt. Run `npm test -- tests/provider-boot-historical-owner.test.ts` and preserve actual RED from unsupported version4.
- [x] Add strict version4 plan/receipt members. Keep V1/V2/V3 declarations and branch behavior intact. Require original group association, same local-end ID, canonical original proof hash, real ingress exit and all existing direct boot conditions.
- [x] Test V4 current ingress after dispatch allowed, late/absent original groups invalid, mixed plan/receipt versions invalid, fake original owner rejected, PG-text-vs-canonical local-end hashes distinct but both bound, and boot lower-bound microseconds retained.
- [x] Run the new unit test plus existing provider-boot/historical-owner/release/launchd tests and record GREEN.

## Task 2: Additive records/SQL authority, actual PostgreSQL RED then GREEN

Files: new `drizzle/0131_historical_direct_provider_boot_boundary.sql`; `drizzle/meta/_journal.json`; `lib/operations/dr/provider-boundary-owner.ts`; `lib/llm/capacity-repository.ts`; new `tests/integration/provider-boot-historical-owner.test.ts`.

- [x] Make a disposable test database with130 migrations and a nonempty direct local request plus actual synthetic owner_opened/spawn_intent/spawned/group_exited/local-end rows. Preserve complete before-row, CHECK and function catalogs. V4 physical SQL must return false before new migration; preserve that actual result.
- [x] Append journal `{idx:131,version:'7',when:1794086400043,tag:'0131_historical_direct_provider_boot_boundary',breakpoints:true}` using the journal's existing version format.
- [x] Implement new V4 physical validator by checked V3 source substitutions. The target strict key sets add originalOwner/currentIngressOwner and originalOwnerProofHash. Replace current ingress birth bound with createdAt; keep original association owner=request owner and the direct native topology/clock checks.
- [x] Add `nmv_boot_historical_records_valid(p,v)` requiring `nmv_boundary_original_owner_records_valid(p,v)`, exact serving/binding fields, ownerAssociation matching a complete original group, same authoritative local-end event ID under both hash domains, exact DB time and dispatches/terminals1. No fake identity projection or weakened old validator.
- [x] Archive current public release/trigger bodies, add only a version4 dispatch branch and same-TX V4 records guard. Existing public OIDs/CHECKs stay intact.
- [x] Widen the original-owner helper's type to the shared request/originalOwner fields and call it for version2 or4. Add V4 records check under the existing locked release transaction before any row mutation.
- [x] Migrate130→132 in the fixture. Assert both new journal hashes, untouched old rows/CHECK OIDs/definitions and old function OIDs/bodies/archive bytes. V4 SQL becomes true. Root-reviewed old V1/V2/V3 fixtures continue to validate their own routes.
- [x] Add direct SQL and official callback negatives for forged event/owner/run/PID/hash, omitted/live/new process group, wrong association/local-end event, wrong binding/provider/model/backend/group/token bound, fence/control/token/binding CAS, wrong timestamp and direct withdrawn INSERT.
- [x] Assert dry-run rollback; apply writes exactly one withdrawn row/released event/audit with NULL settled_at/unknown usage, unchanged binding/charge and immutable idempotent replay. Run the new PG file and existing boot/historical/release/launchd PG files.

## Task 3: Artifact CLI and targeted static checks

Files: `scripts/ops/model-provider-boundary-release.ts`; `tests/provider-boundary-cli.test.ts`; existing/new V4 unit fixture.

- [x] Add CLI tests requiring originalOwner artifact, currentIngressOwner actual exit artifact and all V3 endpoint/journal/boot/transport artifacts for V4. Missing/wrong SHA must refuse before release.
- [x] Extend only version-specific artifact selection: V2/V4 use currentIngressOwner and originalOwner; V3/V4 use native endpoint/journals/boot/transport. Keep launchd and V1 paths intact.
- [x] Read the installed Next guide before any source implementation, then run `npx next typegen`, `npx tsc --noEmit --incremental false`, eslint on changed TS files, and `git diff --check` after targeted tests pass. Do not rerun unrelated full suites.
- [x] Record exact commands/results and failures in this plan or a dedicated operations note. Preserve original/other worktrees and private operational tools. Root owns common CODEX_HANDOFF integration.
- [x] Root and audit_hold independent review completed with no blocking finding; root authorized implementation commit/push/PR. Required CI and root-only operations follow. No production call has occurred. Exact test evidence and migration hashes are in `docs/operations/2026-10-25-historical-direct-provider-boot-boundary.md`.
