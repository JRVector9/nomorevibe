# Delegated human review after infrastructure interruptions

Source base: `85e240f84c4679a5aece4c82d2b44af6f03969c3`. This review and patch used filesystem/source inspection only. No local tests, lint, typecheck, compiler, build, provider calls, or production actions were run.

## Concrete failure path

`claimHumanReview` commits a delegated `running` attempt before inference. A later result transaction rejected with PostgreSQL `25006`, or an owner disappearing before that transaction, leaves the claim running. After 120 seconds, a subsequent healthy claim proves the old job token has no live owner and records `failed/owner_lost`.

Previously the same function counted every same-input/generation delegated attempt except `model_capacity_deferred` toward its three-attempt limit. Three abandoned owners therefore exhausted the model retry budget permanently for that input/generation. The worker also recorded a generic `cancelled` model failure when its budget closed before entering model capacity, including while waiting for the local DeepSeek slot.

This establishes a source-level failure scenario. It does not establish which production candidates experienced it.

## Focused change

- Repository-proven `failed/owner_lost` and the new `superseded/not_started_before_transport` record do not consume the three model attempts. Three such infrastructure interruptions in a rolling 24-hour window throttle further claims, matching AI1's separate owner-change throttle. The throttle expires without a generation reset, provided the candidate, input, source freshness, settings, and ownership remain eligible.
- A new unsent release is used only before the worker enters `withLocalModelCapacity`. It preserves an attempt record and waits 60 seconds. A `cancelled` result returned after entering that wrapper remains on the existing counted failure path; historical generic cancellations are not refunded.
- Claim/reclaim and the new unsent release use the canonical fence-first `withJobLeaseWrite` guard. The existing stage/domain/attempt/job ordering and final wall-time lease checks remain inside that guard. No state, retry history, generation, manual pause, model-completion record, capacity ledger, or AI2 vote is reset.
- Successful abstentions remain final. Model failures, uncertain cancellations, quality limits, current source/policy checks, live AI1 owners, pending AI2 work, and held-Qwen ownership retain their existing behavior. Model-capacity deferral and the final model-result writer are unchanged.

## Written regressions; execution deferred to required CI

`tests/integration/human-review-infrastructure-retry.test.ts` writes coverage for transaction-scoped `25006` rollback leaving a running claim, real abandoned-owner recovery, bounded infrastructure throttling and expiry, the unsent cooldown, the unchanged three-cancellation limit, rollback after job-lease loss, and an intentional pause installed during drain. Fixture timestamps are aged instead of sleeping through production bounds; no production time override was added. The read-only regression uses `SET TRANSACTION READ ONLY` inside one transaction and does not change a connection default.

The unit sources distinguish budget expiry immediately after claim and while waiting for the local slot from a cancellation returned through model capacity. Repository unit sources retain successful-abstention and model-failure checks and add abandoned-owner throttling and unsent records. These are written expectations, not passing test results. They do not constitute a full live provider/DB outage drill.

## Adjacent recovery already present

The job runner retains pending request/cursor state and applies a 30-second failure backoff while preserving intentional far-future pauses. Failed result/error writes can leave a lock until normal lease expiry or role takeover. Role DB failures retry election, abort uncertain active ownership, and can exit for the existing restart policy; primary quarantine is time-bounded at 15 minutes.

Legacy collection refunds abandoned frontier claims in `recoverAbandonedFrontier`, called before dequeue. AI1 excludes `owner_changed` from model failures and separately throttles three changes in 24 hours. AI2 leaves pending work/counters unchanged when its result transaction rolls back and does not count a cancelled result. Product translation increments attempts only in its final guarded result transaction, so a rolled-back DB write does not consume its attempt counter. None of these findings authorizes clearing operator pauses, a DR fence, or ambiguous dispatch records.
