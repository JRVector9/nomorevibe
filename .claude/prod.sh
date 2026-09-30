#!/bin/bash
# nomorevibe의 이전 수동 운영 도우미. 현재 13개 앱 공통 이미지 배포에는
# scripts/ops/deploy_shared_images.py와 docs/operations/independent-workers-runbook.md를 따른다.
# 이 파일은 아래에 열거한 앱의 상태 조회·개별 환경 진단을 위한 로컬 보조 명령이다.
#
# 허용 규칙을 좁게 걸려고 배포에 쓰는 명령을 이 파일 하나로 모았다. 규칙은 이 파일만 허용한다 —
# curl 이나 node 를 통째로 허용하지 않기 위해서다.
#
#   prod.sh status <앱>...   배포 상태(applicationStatus 와 마지막 배포)
#   prod.sh deploy <앱>...   배포 요청. 200 은 큐에 넣었다는 뜻일 뿐이다 — status 로 done 을 확인한다
#   prod.sh migrate          현재 디렉터리의 drizzle/ 를 프로드에 적용(직접 연결 5432)
#   prod.sh env-names <앱>   그 앱에 걸린 환경변수 이름만 (값은 찍지 않는다)
#   prod.sh copy-env <이름> <원본앱> <대상앱>...
#                            환경변수 한 줄을 앱 사이에 그대로 옮긴다(값은 찍지 않는다).
#                            같은 이름이 대상에 이미 있으면 그 줄만 바꾼다. 옮긴 뒤 배포는 따로 한다.
#
# 앱 이름: web-m3 web-mini crawler reviewer publisher scheduler maintenance connect-agent text
# mini 역할 예비 5개는 이 수동 목록에 없으며 공통 배포 스크립트/운영 절차가 관리한다.
# 키는 키체인에서만 읽고 출력하지 않는다. 아래 목록에 없는 앱은 거부한다.
set -euo pipefail

API="https://deploy.brut.bot/api"

app_id() {
  case "$1" in
    web-m3) echo "oipo2OAnIrtcnILBCRoG2" ;;
    web-mini) echo "llv4rlABSJOcFauSxaHdx" ;;
    crawler) echo "AFHDBGCCY4zT9XkkcnzGd" ;;
    reviewer) echo "4RlA9EeKvtKGdR6c6AV4j" ;;
    publisher) echo "AeTaWnZbZKzzv94h7c8Vw" ;;
    scheduler) echo "uAjLU7MslLIGpORD9h6LQ" ;;
    maintenance) echo "7OlFqQdacbyQseQM72E7b" ;;
    connect-agent) echo "xJK6CoRUOs_bpVVNmJDBF" ;;
    # 2026-09-21 다른 세션이 만든 text 워커(사유 번역·소개 짓기·검색 키워드). appName nomorevibe-text-m3
    text) echo "Pi0loosJrKsse_UQ0mln9" ;;
    *) echo "알 수 없는 앱: $1" >&2; exit 2 ;;
  esac
}

key() { security find-generic-password -a deploy.brut.bot -s dokploy-api-key -w; }

cmd="${1:-}"; shift || true
case "$cmd" in
  status)
    [ $# -gt 0 ] || { echo "앱 이름을 주세요" >&2; exit 2; }
    KEY="$(key)"
    for name in "$@"; do
      id="$(app_id "$name")"
      curl -sf "$API/application.one?applicationId=$id" -H "x-api-key: $KEY" \
        | jq -r --arg n "$name" '"\($n)\t\(.applicationStatus)\t" + ((.deployments // []) | sort_by(.createdAt) | last | if . then "\(.status) \(.createdAt) \((.title // "") | split("\n")[0])" else "-" end)'
    done
    ;;
  deploy)
    [ $# -gt 0 ] || { echo "앱 이름을 주세요" >&2; exit 2; }
    KEY="$(key)"
    for name in "$@"; do
      id="$(app_id "$name")"
      code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/application.deploy" \
        -H "x-api-key: $KEY" -H "Content-Type: application/json" -d "{\"applicationId\":\"$id\"}")"
      echo "$name 배포 요청 → HTTP $code"
    done
    ;;
  probe-env)
    # 읽기 전용 진단 — 저장에 필요한 항목이 지금 어떤 모양인지만 본다(값은 찍지 않는다)
    KEY="$(key)"
    app="$(curl -sf "$API/application.one?applicationId=$(app_id "${1:?앱 이름}")" -H "x-api-key: $KEY")"
    printf '%s' "$app" | jq '{envType: (.env|type), buildSecrets: (.buildSecrets|type), createEnvFile: (.createEnvFile|type), buildArgs: (.buildArgs|type)}'
    ;;
  api-schema)
    # 읽기 전용 — Dokploy 가 받는 몸체 모양을 확인할 때만 쓴다(값은 오가지 않는다)
    [ -n "${1:-}" ] || { echo "엔드포인트 이름을 주세요 (예: application.saveEnvironment)" >&2; exit 2; }
    KEY="$(key)"
    for u in "https://deploy.brut.bot/api/openapi.json" "https://deploy.brut.bot/openapi.json" \
             "https://deploy.brut.bot/swagger/json" "https://deploy.brut.bot/api/swagger.json"; do
      out="$(curl -s -w '\n%{http_code}' "$u" -H "x-api-key: $KEY")"
      [ "$(printf '%s' "$out" | tail -1)" = "200" ] || continue
      echo "# $u" >&2
      printf '%s' "$out" | sed '$d'
      exit 0
    done
    echo "OpenAPI 문서를 찾지 못했습니다" >&2; exit 2
    ;;
  env-names)
    [ $# -gt 0 ] || { echo "앱 이름을 주세요" >&2; exit 2; }
    KEY="$(key)"
    for name in "$@"; do
      id="$(app_id "$name")"
      names="$(curl -sf "$API/application.one?applicationId=$id" -H "x-api-key: $KEY" \
        | jq -r '.env // ""' | grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' | tr -d '=' | sort | tr '\n' ' ')"
      echo "$name: $names"
    done
    ;;
  copy-env)
    # 값을 우리 쪽에 적거나 찍지 않는다 — 원본 앱에서 읽어 대상 앱에 바로 넣는다.
    # Dokploy 는 환경변수를 통째로 한 덩이 글로 저장하므로, 지금 글을 읽어 그 줄만 바꿔 다시 저장한다.
    name="${1:-}"; from="${2:-}"; shift 2 || true
    [ -n "$name" ] && [ -n "$from" ] && [ $# -gt 0 ] || { echo "사용법: copy-env <이름> <원본앱> <대상앱>..." >&2; exit 2; }
    case "$name" in *[!A-Za-z0-9_]*) echo "환경변수 이름이 이상합니다" >&2; exit 2 ;; esac
    KEY="$(key)"
    src="$(curl -sf "$API/application.one?applicationId=$(app_id "$from")" -H "x-api-key: $KEY" | jq -r '.env // ""')"
    line="$(printf '%s\n' "$src" | grep -m1 "^$name=")" || { echo "$from 에 $name 이 없습니다" >&2; exit 2; }
    [ -n "$line" ] || { echo "$from 의 $name 이 비어 있습니다" >&2; exit 2; }
    for target in "$@"; do
      id="$(app_id "$target")"
      app="$(curl -sf "$API/application.one?applicationId=$id" -H "x-api-key: $KEY")"
      cur="$(printf '%s' "$app" | jq -r '.env // ""')"
      had="$(printf '%s\n' "$cur" | grep -c "^$name=" || true)"
      next="$(printf '%s\n' "$cur" | grep -v "^$name=" || true)"
      next="$(printf '%s\n%s\n' "${next%$'\n'}" "$line")"
      before="$(printf '%s\n' "$cur" | grep -c . || true)"
      after="$(printf '%s\n' "$next" | grep -c . || true)"
      # 옮기는 것은 한 줄뿐이다 — 줄 수가 줄면 무언가 잘못 지운 것이므로 저장하지 않는다
      [ "$after" -ge "$before" ] || { echo "$target 저장 안 함: 줄이 $before → $after 로 줄었습니다" >&2; exit 3; }
      # env 만 바꾸고 나머지 항목(빌드 비밀·env 파일 생성 여부·빌드 인자)은 지금 값을 그대로 돌려준다
      body="$(printf '%s' "$app" | jq --arg id "$id" --arg env "$next" \
        '{applicationId:$id, env:$env, buildSecrets:(.buildSecrets // ""), createEnvFile:(.createEnvFile // false), buildArgs:(.buildArgs // "")}' \
        | curl -s -w '\n%{http_code}' -X POST "$API/application.saveEnvironment" \
            -H "x-api-key: $KEY" -H "Content-Type: application/json" -d @-)"
      code="$(printf '%s' "$body" | tail -1)"
      # 실패 사유만 짧게 — 응답 본문에 값이 실려 올 수 있으므로 통째로 찍지 않는다
      # 실패 사유와 "어느 항목이 문제인지"만 — 값은 찍지 않는다
      why="$(printf '%s' "$body" | sed '$d' | jq -r '
        ([.message, .error.message, .code, .error.code] | map(select(.)) | .[0] // "")
        + (([.issues, .error.issues, (.error.json.data.zodError.fieldErrors | if . then to_entries | map(.key) else null end)]
            | map(select(.)) | .[0] // []) | if length > 0 then " / 항목: " + ((. | map(if type=="object" then ((.path // []) | join(".")) else tostring end)) | join(", ")) else "" end)' 2>/dev/null | cut -c1-200 || true)"
      echo "$target $name $([ "$had" -gt 0 ] && echo 바꿈 || echo 넣음) → HTTP $code${why:+ ($why)} (줄 ${after}개)"
    done
    ;;
  migrate)
    # main 과 같은 코드에서만 돌린다 — 머지 안 된 마이그레이션이 프로드에 먼저 들어가지 않게
    git fetch -q origin
    [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
      || { echo "HEAD 가 origin/main 이 아닙니다 — main 체크아웃에서 돌리세요" >&2; exit 2; }
    [ -z "$(git status --porcelain -- drizzle)" ] || { echo "drizzle/ 에 커밋 안 된 변경이 있습니다" >&2; exit 2; }
    MIGRATION_DATABASE_URL="$(cat /tmp/nmv-prod-db-direct)" node scripts/migrate.mjs
    ;;
  *)
    sed -n '2,13p' "$0"; exit 2 ;;
esac
