# 배포 시간 단축 Implementation Plan

> **For agentic workers:** 이 작업은 현재 세션에서 순서대로 수행한다. 각 단계는 실제 결과를 기록한다.

**Goal:** CI의 반복 검사를 줄이고 두 immutable image를 여러 Dokploy 앱에서 재사용한다.

**Architecture:** 변경 범위를 먼저 판별하고 코드 PR에서는 quality와 DB가 분리된 세 integration shard를 병렬 실행한다. main `check` 성공 뒤 web/worker 이미지를 GHCR에 빌드하고, 운영자는 검증된 digest를 예비→주 순서로 배포한다.

**Tech Stack:** GitHub Actions, Vitest 4, PostgreSQL 17, Docker Buildx, GHCR, Dokploy.

---

## Task 1 — 변경 범위와 필수 check

- [x] 문서 전용, 코드 혼합, 빈 diff, 수동 실행의 분류 테스트를 추가하고 실패를 확인한다.
- [x] `scripts/ci-scope.mjs`에 안전한 Git diff 및 분류를 구현해 테스트를 통과시킨다.
- [x] `.github/workflows/ci.yml`에 항상 실행하는 scope와 aggregate `check`를 추가한다.
- [x] 문서 변경은 quality/integration을 건너뛰되 `check`가 성공하고, 분류 실패는 `check`가 실패하게 한다.

## Task 2 — 통합 테스트 격리와 병렬 실행

- [x] `integration` matrix 1/3·2/3·3/3을 runner/DB별로 분리한다.
- [x] 기존 `fileParallelism: false`와 `assertLocalTestDatabase`를 유지한다.
- [x] 로컬 격리 DB 3개 또는 hosted CI에서 세 shard의 파일 수/테스트 수/성공을 확인한다.
- [x] `quality` 잡의 typegen/tsc/lint/unit/build가 별도로 성공하고 aggregate `check`가 통과하는지 확인한다.

## Task 3 — web/worker 이미지 한 번씩 빌드

- [x] current Dokploy web build secret과 Actions secret의 동일성을 값 노출 없이 확인한다.
- [x] GHCR pull 접근을 두 서버에서 검증한다. 기존 Dokploy registry 자격 정보가 거부돼 웹 Docker provider에는 검증된 자격 정보를 직접 설정했다.
- [x] main code-change `check` 성공 후 `worker`/`runner` 두 image를 Buildx로 빌드·푸시한다.
- [x] 이미지 label, SHA 태그, immutable digest와 web/worker 실행·healthcheck를 확인한다.
- [x] 웹 이미지 package가 private이고 익명 manifest 조회가 거부되는지 빌드 전후 확인한다.
- [x] 이전 공개 웹 빌드 키를 회전하고 두 운영 웹의 build/runtime 키를 새 값으로 일치시킨다.

## Task 4 — 운영 이미지 배포 전환

- [x] 8개 앱의 source/config/env/release 상태를 백업하고 대상 신원을 검증한다.
- [x] 예비 worker 3개를 같은 worker digest로 전환·배포·상태 확인한다.
- [x] M3 worker 3개를 같은 digest로 전환·배포·상태 확인한다.
- [x] mini/M3 web을 같은 web digest로 전환·배포하고 양쪽 health를 확인한다.
- [x] failover readiness/progress 및 각 앱의 실제 image digest를 확인한다.

## Task 5 — 문서 전용 경로와 기록

- [x] README/runbook/handoff에 새 빌드·배포·롤백 절차와 측정 결과를 기록한다.
- [ ] 문서 전용 PR의 required `check`가 전체 테스트 없이 통과하는지 실측한다.
- [x] PENDING.md에 아직 직접 확인하지 않은 장기 관측만 남긴다.
