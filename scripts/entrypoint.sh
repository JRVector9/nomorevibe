#!/bin/sh
# 마이그레이션을 먼저 적용하고 서버를 띄운다.
# 마이그레이션이 실패하면 서버를 시작하지 않는다 — 스키마가 어긋난 채로 도는 것이 더 나쁘다.
set -e

echo "[entrypoint] 마이그레이션 적용"
node scripts/migrate.mjs

echo "[entrypoint] 서버 시작"
exec node server.js
