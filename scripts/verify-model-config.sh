#!/usr/bin/env bash
set -euo pipefail
if [[ $# -eq 1 && $1 == --help ]]; then
  printf 'Usage: scripts/verify-model-config.sh (scoped unit + typegen + tsc + git grep metric)\n'
  exit 0
fi
[[ $# -eq 0 ]] || { printf 'Unexpected arguments. Use --help.\n' >&2; exit 2; }
cd "$(git rev-parse --show-toplevel)"

# Deliberately scoped to this lane. Never invoke the full unit/DB/e2e suites here.
tests=(
  tests/model-registry.test.ts tests/model-registry-deadlines.test.ts tests/model-registry-migration.test.ts tests/model-registry-http-routing.test.ts
  tests/model-registry-ai2-routing.test.ts tests/model-registry-operator.test.tsx
  tests/local-model-serving-contract.test.ts tests/local-model-capacity-schema.test.ts
  tests/local-model-terminal.test.ts tests/local-model-relay.test.ts tests/local-model-relay-readiness.test.ts
  tests/second-review-direct-native.test.ts tests/second-review-gateway-native.test.ts
  tests/second-review-model-capacity.test.ts tests/second-review-ownership.test.ts
  tests/second-review-domain-binding.test.ts tests/gateway-not-started-native.test.ts
  tests/held-qwen-retry-policy.test.ts tests/review-routing-preset.test.ts
  tests/second-review.test.ts tests/agent-review-gateway.test.ts tests/agent-review-cli.test.ts
  tests/review-cli-model-capacity.test.ts tests/agent-review-model-capacity.test.ts
  tests/qwen-direct-review.test.ts tests/product-audit-qwen-job.test.ts
  tests/human-deepseek-review.test.ts tests/crawl-tagline.test.ts tests/crawl-tagline-model-capacity.test.ts
  tests/automated-action-audit.test.ts tests/llm-assist-contract.test.ts tests/llm-assist-readiness.test.ts
  tests/llm-assist-audit-runtime.test.ts tests/intro-assist.test.ts tests/intro-assist-runtime.test.ts
  tests/search-profile.test.ts tests/search-verify.test.ts tests/intro-check.test.ts
  tests/text-profile-model-capacity.test.ts tests/search-verify-model-capacity.test.ts
  tests/product-translation-model-selection.test.ts tests/product-translation-model-capacity.test.ts
  tests/korean-translation-qwen.test.ts tests/korean-tagline-dual-model.test.ts
  tests/korean-tagline-model-capacity.test.ts tests/search-query-model-capacity.test.ts
  tests/operations-korean-translation.test.tsx tests/search-query.test.ts tests/search-query-gateway-native.test.ts
  tests/text-model-capacity-callers.test.ts tests/translation-model-prompts.test.ts
  tests/stage-registry.test.ts tests/operations-agent.test.ts tests/operations-claude.test.ts tests/classify.test.ts
  tests/pipeline-control.test.ts tests/pipeline-control-routes.test.ts tests/publication-classify-capacity.test.ts
  tests/publication-classify-readiness.test.ts tests/operations-publication-capacity.test.ts
  tests/admin-review-models.test.tsx tests/crawl-settings-form.test.ts tests/crawl-settings-changes.test.ts
  tests/second-voter-switch.test.tsx tests/operations-actions.test.ts tests/operations-work-owners.test.tsx
)
for test_file in "${tests[@]}"; do
  [[ -f "$test_file" ]] || { printf 'Missing scoped test: %s\n' "$test_file" >&2; exit 1; }
done
node_modules/.bin/vitest run "${tests[@]}"
# Next 16 generates PageProps; a fresh worktree cannot skip typegen.
node_modules/.bin/next typegen
node_modules/.bin/tsc --noEmit --incremental false

pattern='(qwen[0-9]|gpt-[0-9]|gpt-oss|gemma[- /0-9]|deepseek-v[0-9]|sonnet|opus|haiku|grok-[0-9])'
runtime_paths=(lib/crawl lib/domain 'app/(operator)' scripts/local-model-relay lib/operations lib/jobs lib/llm lib/db ':!*.test.*' ':!*.md')
count_model_lines() {
  local matches status
  if matches=$(git grep -I -n -i -E "$pattern" "$@" -- "${runtime_paths[@]}"); then
    printf '%s\n' "$matches" | wc -l | tr -d '[:space:]'
  else
    status=$?
    [[ $status -eq 1 ]] || return "$status"
    printf '0'
  fi
}
baseline=$(count_model_lines 199a3ebb)
current=$(count_model_lines)
printf 'Model-name literal lines (same git grep): %s -> %s\n' "$baseline" "$current"
if (( current >= baseline )); then
  printf 'Expected fewer model-name literal lines than baseline 199a3ebb.\n' >&2
  exit 1
fi
printf 'verify-model-config: PASS\n'
exit 0
