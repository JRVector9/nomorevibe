# Tokenizer preflight follow-up — 2026-11-01

This source-only follow-up separates unavailable tokenizer evidence from proven input overflow. It is separate from the Oracle/stage-alert reliability change and requires its own review and CI before integration. No production settings or services were changed.

The root agent's read-only observation at 14:10:18 KST found Supa search verification using `abcllm-search-verify-total-bound-v1` with direct transport, crawl tagline using its total-bound protocol, and AI1 using the raw total-bound protocol. Those routes do not take this tokenizer branch. The observed search-profile verification failures were `network=322`, `model_unavailable=77`, `exhausted=0`, and minimum/maximum verification attempts `0`. This patch does not establish the cause of those live failures or claim live product-budget exhaustion.

## API and dispatch policy

`lib/crawl/second-review-direct-tokenize.ts` exports `checkAi2TokenBudget()` with these outcomes:

- `within_budget`: a complete response matches the configured engine context and its token count plus the frozen output bound fits the request bound.
- `too_large`: the same complete, matching evidence proves the request exceeds its bound.
- `cancelled`: caller cancellation.
- `unavailable`: fixed reasons `request_mismatch`, `contract_mismatch`, `network`, `timeout`, `http_error`, `invalid_response`, or `response_too_large`.

The old `verifyAi2TokenBudget(): Promise<boolean>` remains as a compatibility wrapper and is true only for `within_budget`. Every production caller of the new API explicitly checks `.kind`; there are no object-truthiness dispatch gates.

Only `within_budget` creates AI1 direct or AI2 direct/request-budget prepared capabilities. Their existing `unsupported/provider_contract_unavailable` result remains unchanged for all other outcomes; no request, model judgment, or terminal proof is generated.

The shared text preflight in `lib/crawl/agent-review-gateway.ts` covers all seven native senders: search-profile generation, review-reason translation, demanded product translation, Korean tagline, crawl tagline, search verification, and search-query translation. A proven overflow remains `input_too_large`; unavailable evidence returns fixed `tokenizer_unavailable`, no completion HTTP request, no terminal, and the existing original one-use `gateway_not_started` proof. Only fixed unavailable reasons enter the warning log. No raw source, response, URL, or authentication data enters that diagnostic.

Cancellation follows the pre-existing path: the same aborted signal reaches the native fetch adapter, which alone determines whether it can issue zero-byte evidence. Unknown or partially sent chat requests remain subject to existing indeterminate/cancellation rules. No proof schema, terminal authority, capacity admission, or indeterminate-slot policy changed.

## Retry and attempt policy

The new fixed error participates in the existing provider circuit and provider-retry predicates. A missing mandatory tokenizer check stops further dispatch attempts on the shared route for that job tick; it does not prove an engine process stopped and grants no restart authority. Existing backoff schedules and configured circuit thresholds remain authoritative.

These writers preserve attempt counts for `tokenizer_unavailable` on both insert and update paths:

| Work | Writer / shared policy |
| --- | --- |
| Search-profile generation | `lib/domain/products/search-profiles.ts` |
| Search verification, legacy and reserved | `lib/domain/products/search-profile-retry.ts` and `search-profiles.ts` |
| Review-reason translation, legacy and reserved | `lib/crawl/translations.ts` |
| Crawl tagline, legacy and reserved | `lib/crawl/taglines.ts` |
| Demanded product fields, legacy and reserved | `lib/domain/products/translations.ts` shared writer |
| Korean tagline, legacy and reserved | `lib/domain/products/korean-taglines.ts` |

Writers still store the fixed error, future retry time, and updated timestamp. Their raw-row identity changes, allowing a new generation after the immutable `not_started` request; simply preserving an old generation would strand it. Source/version CAS checks, job and role fences, existing successes, quality counters, publication gates, and public untranslated fallbacks remain intact. Search-query translation has no per-product attempt counter and retains its existing failed-query cache policy.

The isolated and current integration sources have no `ModelErrorCode`/`modelErrorCode` declaration. Text result errors are strings; strict native terminal outcomes remain unchanged because unavailable preflight cannot issue a terminal. Review fixture/replay enums do not receive this text error. No strict evidence enum was broadened.

## Verification status

No local unit/integration tests, lint, typecheck, build, or compiler were run, following the owner's explicit restriction. Regressions were written for CI only:

- Typed tokenizer count boundary; non-200, malformed, mismatched-context, oversized, network, timeout, and cancellation evidence; boolean-wrapper compatibility.
- AI1 direct, AI2 direct, and AI2 optional request-budget preparation refusing unavailable evidence without completion requests.
- Native direct text profile returning `tokenizer_unavailable` with only original zero-byte proof and rejecting replay.
- Provider classification, route tick stop versus product overflow, and capped provider retry predicates.
- Repeated failure writes for profile generation, verification, reason translation, crawl tagline, Korean tagline, and demanded product fields retaining attempt budgets and retry clocks; demanded-field raw-row identity advancing; verification overflow still charging an ordinary attempt.

Source inspection traced all seven native text call sites and their existing reconciliation before domain-write ordering. Independent review and required GitHub CI remain outstanding for this follow-up. Live tokenizer-failure drills, response-identity readback, and provider desired-running versus operator-shutdown evidence were not obtained by this agent.

## Separate discovery monitoring plan

No discovery implementation is included here. `lib/crawl/discovery-progress.ts` best-effort observations alone cannot prove a cursor stall: zero new products can accompany successful scans, claims/defer writes refresh timestamps without progress, and intentional controls/backoff/capacity holds must suppress alarms. The follow-up must join current owner/child and enabled intent with durable scheduler, cursor, empty-scan completion, and backoff evidence for GitHub latest/full, Show HN, and Korean query/shared/language/apply stages. Missing, stale, partial, conflicting, or unreadable evidence remains unknown rather than clearing an incident. Local fenced supervisors retain recovery authority; Oracle remains a bounded observer and notifier.
