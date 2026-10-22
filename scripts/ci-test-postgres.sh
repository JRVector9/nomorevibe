#!/usr/bin/env bash
# CI 통합 테스트 전용 PostgreSQL(pgvector, 프로드와 같은 0.8.6-pg17).
#
#   scripts/ci-test-postgres.sh start   이미지 받기·기동을 뒤에서 시작한다(npm ci 와 겹친다)
#   scripts/ci-test-postgres.sh wait    TCP 로 접속될 때까지 기다리고 설정을 확인한다
#
# runner 가 끝나면 사라지는 일회용 DB 라 내구성 설정을 끈다: 데이터 디렉터리는 tmpfs, fsync·synchronous_commit·
# full_page_writes 는 off. 테스트가 보는 SQL 의미(트랜잭션·잠금·제약)는 그대로고 디스크 flush 만 없앤다.
# 로컬 재현은 README 의 docker run 명령을 쓴다(이 스크립트는 runner 전용 이름·포트를 쓴다).
set -euo pipefail

NAME=nmv-ci-test-pg
LOG=${RUNNER_TEMP:-/tmp}/nmv-ci-test-pg.log

case "${1:-}" in
  start)
    nohup docker run -d --name "$NAME" -p 127.0.0.1:55435:5432 \
      --tmpfs /var/lib/postgresql/data:rw \
      -e POSTGRES_USER=nomorevibe -e POSTGRES_PASSWORD=nomorevibe -e POSTGRES_DB=nomorevibe_test \
      pgvector/pgvector:0.8.6-pg17 \
      -c fsync=off -c synchronous_commit=off -c full_page_writes=off >"$LOG" 2>&1 &
    ;;
  wait)
    for _ in $(seq 1 120); do
      # 초기화 중 임시 서버는 unix socket 만 연다 — TCP 로 확인해야 최종 서버를 기다린다
      if docker exec "$NAME" pg_isready -h 127.0.0.1 -U nomorevibe -d nomorevibe_test >/dev/null 2>&1; then
        docker exec "$NAME" psql -h 127.0.0.1 -U nomorevibe -d nomorevibe_test -Atc \
          "select name || '=' || setting from pg_settings where name in ('fsync','synchronous_commit','full_page_writes') order by name"
        exit 0
      fi
      sleep 1
    done
    cat "$LOG" >&2 || true
    docker logs "$NAME" >&2 || true
    echo "test postgres did not become ready" >&2
    exit 1
    ;;
  *)
    echo "usage: $0 start|wait" >&2
    exit 2
    ;;
esac
