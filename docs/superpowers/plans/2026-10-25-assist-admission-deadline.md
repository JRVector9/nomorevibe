# Assist admission deadline implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Stop assist admission early enough to preserve at least 60 seconds of the existing claim budget for native execution.

**Architecture:** Keep the existing 90-second claim, 100-second tick and runner deadline. Derive one absolute admission cutoff before evidence collection, subtracting 60 seconds from the claim end; both factual and introduction-correction calls share that cutoff. Existing capacity cancellation handles a pending or granted request when the cutoff is reached.

**Tech Stack:** TypeScript, Vitest, PostgreSQL 17 with pgvector, local HTTP fixture.

---

Execution complete: RED4 (9.96s), GREEN4 (8.69s), final integration51/51 (88.46s), unit16/16, typegen+tsc, ESLint, diff checks. Initial observation timeout and pre-typegen failure are preserved in `docs/CODEX_HANDOFF.md`. Parent changed delivery to a cherry-pick into PR658, with one combined CI/deployment.

### Task 1: Reproduce the late-dispatch failure

**Files:**
- Modify: `tests/integration/llm-assist-dispatch.test.ts`
- Modify: `tests/integration/intro-assist-dispatch.test.ts`

- [x] Add real DB/native fixture cases that advance only `Date.now`: collection alone consumes over 30 seconds; collection plus queue wait consumes over 30 seconds; late capacity grant after 31 seconds is withdrawn without native HTTP; intro factual completion after 31 seconds cannot open a fresh correction window.
- [x] Use the production-sized 100-second introduction fixture deadline, replacing its old 60-second deadline, which cannot leave a full native minute after claim setup.
- [x] Run `TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:32787/nomorevibe_test npm run test:integration -- tests/integration/llm-assist-dispatch.test.ts tests/integration/intro-assist-dispatch.test.ts -t '60초|공유 입장'`. Expect assertions showing native HTTP or retained waiting state under the old five-second cutoff.

### Task 2: Preserve the native execution budget

**Files:**
- Modify: `lib/jobs/products/llm-assist-review.ts`

- [x] Add `const NATIVE_EXECUTION_MS = 60_000;` next to `TICK_MS`.
- [x] Replace `Date.now() + claimBudgetMs - 5000` with `Date.now() + claimBudgetMs - NATIVE_EXECUTION_MS`.
- [x] Replace the post-collection `remaining() < 5000` check with `Date.now() >= admissionDeadlineAt`; defer through the existing `waiting_capacity` path without model dispatch or attempts.
- [x] Keep the same cutoff in `intro_correction`; do not change lease, provider timeout, model or capacity settings.
- [x] Re-run the reproduction command and verify passing tests.

### Task 3: Validate and prepare the isolated PR

**Files:**
- Modify: `docs/CODEX_HANDOFF.md` in this isolated worktree only.

- [x] Run the complete two dispatch integration files and existing `tests/local-model-capacity.test.ts` / `tests/llm-assist-capacity-binding.test.ts` unit files.
- [x] Run `npx tsc --noEmit`, `npx eslint lib/jobs/products/llm-assist-review.ts tests/integration/llm-assist-dispatch.test.ts tests/integration/intro-assist-dispatch.test.ts`, and `git diff --check`.
- [x] Record actual RED/GREEN, failed approaches, remaining production deployment and exact follow-up commands in the isolated handoff.
- [x] Parent superseded separate PR delivery: prepare the commit for the screen-expiry agent to cherry-pick into PR658. Do not create another PR or deploy.
