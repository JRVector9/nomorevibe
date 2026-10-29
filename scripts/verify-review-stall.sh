#!/usr/bin/env bash
# 미확인 요청 정체 차선(2026-10-28)이 바꾼 영역만 검사한다. 전체 저장소 시험 묶음은 돌리지 않는다.
#   1) next typegen + tsc --noEmit (CI와 같은 타입 검사)
#   2) 이 차선이 바꾼 TS 파일만 eslint
#   3) first-reviewers·기한/게이트웨이·relay·자동 해제 관련 vitest 단위 시험
#   4) Oracle 요청 감시·watchdog·recovery gateway 관련 회귀만
set -euo pipefail
cd "$(dirname "$0")/.."

# node 가 기본 PATH 에 없을 수 있다. 저장소가 쓰는 node(.nvmrc/.node-version 우선, 다음 nvm 최신, 다음 시스템)를 찾는다.
find_node() {
  if command -v node >/dev/null 2>&1; then dirname "$(command -v node)"; return; fi
  local want="" dir
  for file in .nvmrc .node-version; do [ -f "$file" ] && want="$(tr -d 'v \n' < "$file")" && break; done
  for root in "${NVM_DIR:-$HOME/.nvm}/versions/node" /usr/local/lib/nodejs /opt/homebrew/opt; do
    [ -d "$root" ] || continue
    if [ -n "$want" ] && dir="$(ls -d "$root"/v"$want"*/bin 2>/dev/null | sort -V | tail -1)" && [ -n "$dir" ]; then echo "$dir"; return; fi
    dir="$(ls -d "$root"/v*/bin 2>/dev/null | sort -V | tail -1 || true)"
    [ -n "$dir" ] && { echo "$dir"; return; }
  done
  for dir in /usr/local/bin /usr/bin /opt/homebrew/bin; do [ -x "$dir/node" ] && { echo "$dir"; return; }; done
  return 1
}
NODE_BIN="$(find_node)" || { echo "verify-review-stall: node 를 찾지 못했습니다" >&2; exit 1; }
export PATH="$NODE_BIN:$PATH"
echo "verify-review-stall: node $(node --version) ($NODE_BIN)"
[ -d node_modules ] || { echo "verify-review-stall: node_modules 가 없습니다. npm ci 후 다시 실행하세요" >&2; exit 1; }

TS_FILES=(
  lib/crawl/first-reviewers.ts lib/crawl/first-reviewer-blocks.ts lib/crawl/agent-review-repository.ts
  lib/crawl/agent-review-item-lifecycle.ts lib/crawl/consumers/first.ts lib/crawl/jobs/agent-review.ts
  lib/crawl/agent-review-gateway.ts lib/llm/deadline-ladder.ts lib/jobs/products/translations.ts
  lib/operations/model-capacity-auto-reclaim.ts lib/operations/dr/call-drain.ts lib/operations/dr/reclaim.ts lib/jobs/model-capacity-reclaim.ts
  lib/jobs/catalog.ts lib/jobs/registry.ts lib/operations/emergency-priority.ts lib/operations/stage-registry.ts
  lib/operations/contracts.ts "app/(operator)/admin/status/work-owners.ts"
  lib/operations/capacity-admission-block.ts lib/operations/model-capacity-unknowns.ts lib/operations/failover-monitor.ts
  lib/operations/dr/provider-boundary-relay.ts scripts/watch-failover-readiness.ts scripts/ops/model-provider-boundary-release.ts
  scripts/local-model-relay/service.ts scripts/local-model-relay/store.ts scripts/local-model-relay/config.ts
  scripts/local-model-relay/protocol.ts scripts/local-model-relay/deadline-release.ts scripts/local-model-relay/boundary-reconcile.ts
  tests/first-reviewers.test.ts tests/first-reviewer-blocks.test.ts tests/deadline-ladder.test.ts
  tests/local-model-relay-deadline.test.ts tests/model-capacity-auto-reclaim.test.ts tests/job-catalog.test.ts
  tests/capacity-admission-block.test.ts tests/model-capacity-unknowns.test.ts tests/provider-boundary-relay.test.ts
  tests/relay-boundary-reconcile.test.ts tests/local-model-relay.test.ts tests/provider-boundary-cli.test.ts
)
UNIT_TESTS=(
  tests/first-reviewers.test.ts tests/first-reviewer-blocks.test.ts tests/pipeline-first-consumer.test.ts
  tests/pipeline-consumer-gates.test.ts tests/agent-review-job.test.ts
  tests/deadline-ladder.test.ts tests/agent-review-gateway-capacity.test.ts
  tests/local-model-relay.test.ts tests/local-model-relay-deadline.test.ts tests/relay-boundary-reconcile.test.ts
  tests/provider-boundary-relay.test.ts tests/provider-boundary-cli.test.ts
  tests/model-capacity-auto-reclaim.test.ts tests/dr-reclaim.test.ts tests/dr-reclaim-outside.test.ts
  tests/capacity-admission-block.test.ts tests/model-capacity-unknowns.test.ts
  tests/job-catalog.test.ts tests/emergency-priority.test.ts tests/stage-registry.test.ts tests/operations-work-owners.test.tsx
  tests/text-model-capacity-callers.test.ts tests/product-translation-model-capacity.test.ts
)
existing() { local file; for file in "$@"; do if [ -f "$file" ]; then printf '%s\0' "$file"; fi; done; return 0; }

echo "== 1/4 typecheck"
node node_modules/next/dist/bin/next typegen
node node_modules/typescript/bin/tsc --noEmit --incremental false

echo "== 2/4 eslint (changed files)"
existing "${TS_FILES[@]}" | xargs -0 node node_modules/eslint/bin/eslint.js --max-warnings=0

echo "== 3/4 vitest (lane unit tests)"
existing "${UNIT_TESTS[@]}" | xargs -0 node node_modules/vitest/vitest.mjs run

echo "== 4/4 python Oracle tests"
for file in test_oracle_capacity_unknowns.py test_oracle_capacity_reclaim_overdue.py test_oracle_watchdog.py test_oracle_watchdog_provider.py test_oracle_watchdog_notifications.py; do
  if [ -f "tests/$file" ]; then python3 -B -m unittest discover -s tests -p "$file";
  else echo "verify-review-stall: $file is not introduced in this stage"; fi
done
# gateway(recovery_gateway.py)·catalog 파서도 이 차선이 바꾼 파일을 읽는다
python3 -B -m unittest discover -s tests -p 'test_recovery_provider.py'
python3 -B -m unittest discover -s tests -p 'test_release_catalog.py'

echo "verify-review-stall: all checks passed"
