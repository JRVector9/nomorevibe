# Operations Center Implementation Plan

**Goal:** implement all four tabs and controls of the approved operations v2 concept in the real administrator.
**Architecture:** reuse jobs/candidates/publication guard and shared admin layout. Add bounded DB observations and category decisions. A single internal connect-agent owns encrypted credentials, runtime Codex home, model validation and classification; the publisher invokes it over an authenticated internal RPC. No Docker socket or credential webhook is required because credentials stay with this owner.
**Tech Stack:** Next server actions, PostgreSQL/Drizzle, React, Node HTTP, pinned Codex CLI.

## Work sequence
- [x] Add `operations_observations`, `category_decisions`, `operations_audit` via additive migration0023; safe snapshots never store CLI output or credentials.
- [x] Add throttled supervisor observations (role/process state/current job/timestamps/RSS), job requests with row-lock coalescing and administrator audit.
- [x] Implement `lib/operations/agent.ts` and `scripts/connect-agent.ts`: authenticated bounded RPC, one CLI at a time, encrypted atomic vault, isolated login directory, device URL/code allowlist, cancellation/expiry, full auth.json validation, model/config/generation-bound verification, compare-and-swap apply and persistent public status. Preserve active credential on failed reconnect. No credential text returned by any route.
- [x] Extend classifier with explicit models and attempt callback; agent calls existing strict structured-output classifier. Publisher uses internal RPC and records failure holds; manual category decisions bind current source/candidate hash and taxonomy. Publication guard checks decision revision in the same transaction as insertion. Candidate state stays approved.
- [x] Replace summary-only UI with overview, jobs, AI and manual tabs: original card/detail hierarchy, queue counts, worker filters, modal job detail/request, reconnect dialog/poll/cancel, model selectors/test/apply, real manual candidate form. Keep existing operational evidence/ranking panels.
- [x] Update Compose with internal connect-agent and encrypted vault volume; migrate then build/drain/recreate relevant local services while preserving per-service environment/credentials.
- [x] Verify security/contract tests, whole unit suite, type/lint/build; use isolated DB for manual stale decision/coalescing tests; browser desktop/mobile every tab/control; real local worker heartbeat and publication loop. OAuth approval requires operator interaction and is not simulated as success.

## Decisions and rollback
Credential actions require a real allowlisted administrator cookie; ADMIN_LOCAL_LOGIN does not authorize them. Local read-only view and existing queue management continue. Model settings apply to the next batch only and cannot be saved unless every selected model returned valid classification output for the exact credential generation. At most one model/config operation runs; RPC limits and timeouts prevent unbounded work. One owner persists refreshed full auth.json after CLI closes, encrypted with a separate derivation of the server secret. The internal network is the RPC transport boundary, authenticated with a derived token. Failure policy is hold (one-hour cooldown), manual classification leaves AI review requirements intact. Rollback stops new publisher/connect-agent, restores previous image/environment, leaves additive tables intact; restoring old publisher restores its rule fallback policy.

Validation completed with contract fixtures for OAuth/model success, plus real local stack observations. Real operator OpenAI approval was not performed; current local GitHub OAuth client/secret are absent and the UI reports this configuration gap.
