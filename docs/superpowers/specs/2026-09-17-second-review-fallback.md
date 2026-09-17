# Second-review fallback

User explicitly requested automatic fallback on technical review failure. Extend deployed PR116 without changing the decision policy or first reviewer.

- Configurable ordered fallback pool, at most two models; final production pool Claude CLI Sonnet only (user disallowed Opus; Spark account currently access_denied). Exclude evaluated qwen3-coder:30b after 8/12 completed calls timed out. Cross-provider first fallback avoids sharing the primary gateway failure. Empty pool preserves old behavior.
- A failed call atomically creates a pending replacement row with the actual fallback provider/model and a pointer to the original primary row; retain the failed row as resolved/fallback history. Prioritize replacement rows on the next worker tick. All source/generation/lease guards still apply.
- Exclude configured primary voters and any model already attempted in the candidate/input generation. Prefer a model different from the first reviewer; a same-first fallback is reference-only and forces human review, never independent consensus. Concurrent failures cannot claim the same fallback as two independent votes.
- Share the three-failure budget across each primary plus replacements. When no eligible replacement exists, bounded original retry/human escalation remains. Valid reject or needs_review outcomes do not trigger fallback. Cancellation/source change do not trigger fallback.
- Display actual fallback model and a replacement marker, preserve links/history, expose ordered pool in admin settings. Removing the primary or backup invalidates its current replacement opinions.
- Verify atomic replacement, exhausted chains, independent votes, provider failures, stale/late results, UI/settings round trip, complete suites and live primary/fallback responses. Deployment requires additive migration before code. Model settings switch is audited after rollout.

Alternatives considered: retrying only the same model does not cover a provider outage; substituting another primary would duplicate a vote. The ordered independent pool addresses both.
