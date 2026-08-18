#!/bin/sh
# 수집 파이프라인 스케줄러.
#
# 크론 데몬 대신 루프 하나를 돈다. 이 스택에 붙일 것이 네 작업뿐이고, 주기가 분 단위이며,
# 실패해도 다음 틱이 이어받기 때문이다 — 크론 표현식과 데몬을 들일 이유가 없다.
#
# 겹쳐 호출해도 안전하다. 작업 러너가 이름별 잠금을 걸어 이미 도는 작업은 건너뛴다.
#
# 주기는 GitHub 한도에 맞춘다.
#   fetch  : 레포 조회 5000회/시간. 한 틱에 30건 남짓이므로 1분마다 돌려도 여유가 있다.
#   seed   : 검색 30회/분. 프론티어는 한 번 돌면 한참 차 있으므로 드물게 돈다.
#   judge  : 계산만 한다. 원본이 쌓이는 속도를 따라가면 된다.
#   publish: 판정 직후에 돌아야 통과한 것이 바로 목록에 오른다
#   uptime : 제품이 죽는 것은 분 단위로 급한 일이 아니다. 한 바퀴를 천천히 돈다.
set -eu

BASE="${BASE_URL:-http://app:3000}"
INTERVAL="${TICK_SECONDS:-60}"

: "${CRON_SECRET:?CRON_SECRET이 필요합니다}"

run() {
  code=$(
    curl -sS -X POST "$BASE/api/cron/$1" \
      -H "Authorization: Bearer $CRON_SECRET" \
      -o /tmp/cron-out -w '%{http_code}'
  ) || code="000"
  # 응답 본문은 있으면 같이 남긴다. 연결 자체가 안 되면 파일이 없으므로 조용히 넘긴다
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $1 $code $(head -c 300 /tmp/cron-out 2>/dev/null || true)"
}

echo "스케줄러 시작 — $BASE, ${INTERVAL}초 간격"
tick=0
while true; do
  tick=$((tick + 1))

  run crawl-fetch
  # 나머지는 첫 틱에 한 번 돌고 그 뒤로 주기를 지킨다. 띄우자마자 한 바퀴가 돌아야
  # 스케줄이 살아 있는지 곧바로 보인다.
  if [ $((tick % 5)) -eq 1 ]; then
    run crawl-judge
    run crawl-publish
  fi
  if [ $((tick % 15)) -eq 1 ]; then
    run crawl-seed
  fi
  if [ $((tick % 10)) -eq 5 ]; then
    run uptime-ping
  fi

  sleep "$INTERVAL"
done
