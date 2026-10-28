# 미확인 요청 정체 차선 남은 일 (2026-10-28)

대표 지시(2026-10-28): AI1·AI2 미확인 요청 발생을 줄이고, 발생해도 사람 개입 없이 자동 해제·재개.
기준 origin/main `199a3ebb`(#708). 작업 공간 `xaegis/36694e57`(HEAD `8c10f0ad`, = `xaegis/cca48837`의 부모).

## 상태 요약

| 단계 | 코드 | 로컬 시험 | 커밋 | PR·CI·병합·배포·운영 확인 |
| --- | --- | --- | --- | --- |
| 1 재시작 보호(cca48837) | 작업 공간에 `8513cff8` 내용 그대로 반영 | 미실행(막힘) | 못 함(막힘) | 못 함(막힘) |
| 2 막힌 모델 우회 배정 | 끝 | 미실행(막힘) | 못 함 | 못 함 |
| 3 기한 사다리·M1 중계기 | 이 저장소 몫 끝, abcLLM 게이트웨이·엔진 설정은 저장소 밖 | 미실행 | 못 함 | 못 함 |
| 4 자동 해제 | 워커 잡·Oracle 지연 경보 끝, 선언(실측 후)은 남음 | 미실행 | 못 함 | 못 함·드릴 못 함 |
| 5 1차 심사 보고서 | 끝(`2026-10-28-first-review-content-and-rule-worker.md`), 비율 실측 없음 | — | 못 함 | — |

## 독립 코드 읽기 검토(실행 아님)와 반영

시험을 돌릴 수 없어 별도 에이전트가 변경을 읽어 검토했다(실행 결과 아님).

- 확인된 결함 1건 고침: claim 단계 재확인(`agent-review-repository.ts` `claimReview`)이 blocked 정보 없이 고정 칸을 다시 골라, 우회된 후보가 항상 `input_changed`로 건너뛰어졌을 것이다. 잠금 아래 재확인에서 "claim한 모델 외 풀 모델 = avoid"로 같은 선택 함수를 써서, 한 번도 보내지 않은 후보만 우회 모델을 유지하고 고정(시도·intent) 후보는 그대로 거절하게 했다. 시험 추가.
- 고침: 중계기가 이미 기한 경과로 열린 요청을 DB 경계 해제 연결 도구가 `already_cleared`로 끝낼 때 receipt의 wireHash·모델을 대조한다.
- 검사 스크립트에 `test_recovery_provider.py`, `test_release_catalog.py`, 번역 호출자 시험 2개 추가.
- 기준 차이(결함 아님): `lib/jobs/products/translations.ts`는 origin/main(#708) 형태(`deadlineAt`, 55초 예산)로 썼다. **이 작업 공간 기준(`8c10f0ad`)에서는 tsc가 실패하고 25초 기본 예산이 40초 HTTP 기한보다 짧다. 반드시 origin/main 위로 옮긴 뒤 검사·병합한다.**
- 남긴 위험: `.boundary-recovery.lock`이 프로세스 강제 종료로 남으면 중계기가 계속 닫힌다(cca48837의 의도된 동작 — 자동 만료 없음, 운영 절차로 확인 후 정리).

## 끝낸 것(작업 공간에 미커밋 변경으로 존재)

- 1단계: `git show 8513cff8:<경로> > <경로>`로 22개 파일을 그대로 옮겼다. `git diff --stat 8513cff8`에서 추적 파일 차이 0을 확인했다(새 파일은 미추적으로만 보임).
- 2단계: `selectFirstReviewer`의 `avoid` 인자. 활성 intent·시도 기록이 전혀 없는 후보만 막힌 모델(물리 그룹 또는 provider budget이 `indeterminate`로 꽉 참, 또는 이번 회차에 local deferral로 멈춘 모델)을 건너뛰어 고정 칸에서부터 돌아가며 다음 모델로 보낸다. 모두 막혔으면 고정 칸 그대로 기다린다. 이미 보낸 요청·재시도 고정·점유는 건드리지 않는다. `lib/crawl/first-reviewer-blocks.ts`(읽기 전용 hint, 실패하면 hint 없음). AI2는 후보별 고정 배정이 아니라 voter 전원+fallback 구조라 같은 문제가 없다(`lib/crawl/settings-schema.ts` `secondReview.voters`).
- 3단계: `lib/llm/deadline-ladder.ts`, 번역 클라이언트 20→40초, M1 중계기 `max_tokens` 강제·엔진 상한 선언 시 자동 재개. 근거 `docs/operations/2026-10-28-deadline-ladder.md`.
- 4단계: maintenance 잡 `model-capacity-reclaim`(1분) — 선언된 budget만 기존 `releaseEvidencedDispatches` 판정으로 해제. Oracle은 같은 요청이 5분 넘게 남으면 `model_reclaim_overdue` 별도 사건으로 사람에게 알린다(DB·모델 권한 추가 없음).
- `scripts/verify-review-stall.sh` 작성.

## 남은 것

1. (사람·권한 필요) 아래 막힌 명령 실행: 커밋, origin/main 기준 브랜치 정리, PR707 → PR(1단계) → PR(2~4단계) 순 push·PR·CI·병합.
2. `scripts/verify-review-stall.sh`를 node_modules가 있는 곳에서 실행해 0 종료 확인, 실패하면 고친다.
3. abcLLM 게이트웨이 요청별 기한·vLLM abort·종료 기록(별도 저장소).
4. 운영 실측(p95/p99, decode 속도, 게이트웨이 끊김 드릴) 후 `MODEL_CAPACITY_AUTO_RECLAIM`·`LOCAL_MODEL_RELAY_ENGINE_DEADLINE_MS`·`LOCAL_MODEL_RELAY_MAX_OUTPUT_TOKENS` 선언.
5. 표준 배포(`npm run deploy -- scope|plan|run`, PR707 drain 보호) → M3·mini 반영 → DB의 새 AI1·AI2 저장 건수 증가 확인.
6. 드릴(timeout·연결 끊김·owner 교체·응답 유실) 5분 내 자동 해제·재개, 이후 60분 AI1·AI2 저장 증가, 수동 해제 0.
7. 1차 심사 보고서의 대체 가능 비율 실측(측정 SQL은 보고서에 있음).

## 막힌 것(이유: 이 세션은 승인 화면이 없어 승인이 필요한 도구 호출이 모두 자동 거절됨)

거절된 실제 명령(그대로):

- `git fetch origin` — 원격 갱신 불가. 로컬 `origin/main`=`199a3ebb`를 기준으로 사용.
- `gh pr view 707 --json ...` — PR·CI 확인 불가. 따라서 push·PR·병합도 불가.
- 작업 공간 밖 읽기(`xaegis/ce0a1f81` 작업 공간 파일) — 커밋된 `6da7ea92`의 문서로 대신 읽음.
- `npm ci --ignore-scripts --no-audit --no-fund` — node_modules 없음 → tsc·eslint·vitest 실행 불가.
- `python3 -B -m unittest discover -s tests -p 'test_oracle_*.py'` — Python 시험 실행 불가.
- `git checkout -b fix/review-restart-protection-20261028 origin/main`, `git merge --no-edit origin/main`, `git add ...` — 브랜치 생성·병합·커밋 불가.
- `chmod +x scripts/verify-review-stall.sh`, `bash -n scripts/verify-review-stall.sh` — 실행 권한·문법 검사 불가(`bash scripts/verify-review-stall.sh`로 실행).
- 운영 DB·SSH·배포 명령은 위 결과로 보아 시도해도 같은 방식으로 거절된다고 판단해 시도하지 않았다. 따라서 운영 반영·드릴·저장 건수 측정 없음.

## 병합 순서 제안

1. PR707(`fix/review-stall-recovery-20261028`, drain 보호) — 먼저.
2. 1단계 PR: origin/main(707 병합 후)에서 `git cherry-pick 8513cff8`. 충돌 예상 파일(HEAD와 origin/main이 다른 파일): `scripts/ops/incident_notifications.py`, `scripts/ops/oracle_watchdog.py`, `scripts/ops/recovery_gateway.py`, `scripts/watch-failover-readiness.ts`, `tests/test_recovery_provider.py`.
3. 2~4단계 PR: 이 작업 공간의 나머지 변경. origin/main과 다른 파일 중 이 차선이 고친 것: `lib/crawl/jobs/agent-review.ts`(1줄), `lib/jobs/products/translations.ts`(main 줄 형태로 작성함), `lib/jobs/catalog.ts`, `lib/jobs/registry.ts`, `lib/operations/emergency-priority.ts`, `lib/operations/stage-registry.ts`, `app/(operator)/admin/status/work-owners.ts`, `tests/job-catalog.test.ts`, Oracle 두 파일.
