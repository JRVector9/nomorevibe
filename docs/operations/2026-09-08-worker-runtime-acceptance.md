# 독립 워커 실제 컨테이너 운영 검증 — 2026-09-08

상태: **30분 연속 관측과 시험 컨테이너 정상 종료 완료**.
이 보고서는 전용 로컬 시험 DB/컨테이너의 운영 동작을 확인한 기록이며 운영 서버 배포나 실제 AI 처리량 검증을 대신하지 않는다.

## 시험 격리와 대상

- 이미지: `nomorevibe-worker:workers-acceptance`.
- 30분 관측 이미지 ID: `sha256:1901c81cbb234a8f8558b46e86a9fb9c64e8c2d64d14399811d1f387f467fd59`.
- 빌드 완료 로그: `/tmp/nomorevibe-workers-worker-build-final.log`의 export DONE 확인 후 시작.
- PostgreSQL 17: 기존 `nomorevibe-test-db` 안에 신규 `nomorevibe_workers_runtime_test` DB 생성 후 이미지의 `scripts/migrate.mjs` 실행 성공.
- 종료 경계 사례는 추가 전용 `nomorevibe_workers_runtime_probe` DB 사용.
- 시험 컨테이너는 `nomorevibe-workers-runtime-*` 이름만 사용했다. 기존 웹·스케줄러·다른 시험 컨테이너는 중지/변경하지 않았다.
- 해당 시험 DB의 제품·후보·원본은 초기 0건. 이미지의 기본값을 직접 읽어 `enabled=false`, `reviewMode=off`, `agentEvidence.enabled=false` 확인.
- GitHub/Claude 자격 정보를 전달하지 않았고, 외부 수집을 켜지 않았다. 워커별 실제 수집·AI 판정 정확도는 별도 표본 검증 결과를 따른다.

## 완료한 운영 동작 검사

| 검사 | 실행 조건 | 결과 |
|---|---|---|
| 정상 운영 중 SIGTERM | 실제 이미지, DB 초기화와 idle poll 이후 종료 | 종료 코드 0, 0.133초 |
| 시작 직후 SIGTERM | 최초 IPC 직후 약 0.7초 이내 종료 | 기존 코드에서 종료 코드 1 재현 |
| 시작 직후 종료 수정 | `0466398`(통합 `74c60ba`)의 supervisor만 마운트, 실제 worker/tsx/DB 사용 | 3회 모두 종료 코드 0, 1.477/1.470/1.676초 |
| 수정 후 정상 종료 | 같은 수정 supervisor, 정상 idle 상태 | 종료 코드 0, 0.100초 |
| event loop 정지 | worker 리더에 SIGSTOP, heartbeat 15초, drain 5초, `on-failure:3` | RestartCount 1, 호스트 PID 변경, 30.339초 후 healthy |
| IPC 정상·작업 영구 대기 | 네트워크 없는 fixture가 IPC를 계속 보내면서 작업 Promise/자식 종료를 보류, job 상한 60초·drain 5초 | `job_timeout`과 강제 종료 기록, RestartCount 1, 76.165초 후 healthy |
| 작업 그룹 정리 | 위 fixture가 SIGTERM을 무시하는 Node 자식도 생성 | 최종 그룹 소멸 확인, `group_cleanup_incomplete` 없음 |
| 스케줄러 중단 | scheduler를 66.950초 중지하고 4개 소비자만 실행 | 정기 requestedVersion 증가 없음, 기존 접수 요청은 처리됨 |
| 스케줄러 재개 | 중단 뒤 같은 scheduler 재시작 | due fetch 요청 버전 정확히 +1, 밀린 회차만큼 폭증하지 않음 |

시작 직후 종료 실패는 supervisor가 프로세스 그룹 전체에 SIGTERM을 보내면서 tsx/esbuild도 중단시킨 것이 원인이었다.
`0466398`(통합 커밋 `74c60ba`)에서 우선 worker 리더에만 SIGTERM을 보내 자체 abort/drain을 수행하도록 수정했다.
유예 기한과 최종 정리의 **그룹 전체 SIGKILL은 유지**했다. 이미지를 다시 빌드하기 전 수정 파일을 별도로 마운트해 검증했으며,
30분 관측 컨테이너는 기존 이미지 그대로 유지했다. 따라서 장기 관측과 종료 수정 검증은 동일 실행물이라고 주장하지 않는다.

영구 대기 검사는 제품 코드에 테스트 분기를 추가하지 않았다. 전용 컨테이너에서만 fixture 진입점을 마운트하고
`--network none`을 사용했다. Docker Desktop의 `/tmp` 파일 마운트가 디렉터리로 해석되어 첫 fixture 기동은 실패했고,
프로젝트 작업 영역의 실제 파일을 마운트해 다시 실행했다. 이는 제품 코드의 실패가 아니다.

## 웹 없이 5개 역할 연속 관측

- 실제 시작: **2026-09-08 15:10:09.786 KST / 06:10:09.786 UTC**.
- 실제 완료: **2026-09-08 15:40:10.118 KST / 06:40:10.118 UTC**, monotonic clock 경과 **1800.307초**.
- 역할: scheduler, crawler, reviewer, publisher, maintenance.
- 역할별 pool 상한: 2/4/3/3/3, 합계 **15**. 각 컨테이너 CPU 상한 0.5, RAM 상한 512 MiB.
- 해당 DB를 사용하는 웹 컨테이너는 없고, 워커에는 웹 주소나 웹 health 의존성을 제공하지 않았다.
- 약 60초 간격으로 실제 컨테이너 health/PID/재시작 수, DB 요청·처리 버전·성공·오류·잠금·생존 시각, DB 연결 수를 기록했다.
- 이 구간은 **비활성 수집·빈 데이터의 독립 실행과 스케줄 유지 검사**다. 활성 크롤링/LLM 부하에서 필요한 사양을 입증하지 않는다.

**31개 표본 모두 5개 역할 healthy, 재시작 0회, 잡 오류 0건, 실제 DB 연결 최대 5개**였다.
마지막 집계에서 모든 요청 버전이 처리되었고 lease가 남지 않았다. 제품·frontier·원본·후보·AI 리뷰·저장소 스캔은 모두 0건이었다.
`agent_evidence.disabled`, `crawl.agent_review_skipped`의 `disabled` 로그도 확인했다.

| 잡 | 관측 중 요청 증가 | 실행 증가 | 최종 처리/요청 버전 |
|---|---:|---:|---:|
| agent-evidence-refresh | 30 | 30 | 32/32 |
| crawl-agent-review | 30 | 30 | 32/32 |
| crawl-fetch | 30 | 30 | 32/32 |
| product-evidence-refresh | 30 | 30 | 32/32 |
| crawl-judge | 6 | 6 | 7/7 |
| crawl-publish | 6 | 6 | 7/7 |
| crawl-seed | 2 | 2 | 3/3 |
| uptime-ping | 3 | 3 | 4/4 |
| click-rollup | 0 | 0 | 1/1 |
| ranking-refresh | 0 | 0 | 1/1 |

증가량 0인 maintenance 잡은 관측 시작 전 접수분을 처리했고, 이 30분 동안 추가 요청이 없었다.
maintenance의 workerSeenAt은 계속 갱신되었다. scheduler 관측 행인 heartbeat는 실행 잡이 아니며,
최종 workerSeenAt은 `2026-09-08T06:40:10.050461` UTC였다.

종료 직전 idle 메모리 표본은 scheduler 48.58 MiB, crawler 108.4 MiB, reviewer 103.4 MiB,
publisher 104.6 MiB, maintenance 104.7 MiB였다. 이는 단일 idle 표본이며 운영 사양의 근거로 확대 해석하지 않는다.

관측 후 scheduler를 먼저 중지하고 접수 요청이 모두 처리된 것을 확인한 뒤 4개 소비자를 중지했다.
**15:40:55.574 KST에 5개 컨테이너 모두 종료 코드 0**, 미처리 요청·남은 lease·잡 오류·DB 연결은 모두 0이었다.
시험 DB와 로그는 보존했다.

## 증거 파일

비밀값을 제외한 관측·복구·종료 요약은 저장소의 [JSON 증거](./evidence/2026-09-08-worker-runtime.json)에 보존했다.
작업 머신의 `/tmp/nomorevibe-runtime-acceptance/`에는 다음 원본 기록을 남겼다.

- `graceful.json/.log`: 기존 코드의 시작 직후 실패.
- `steady-original.json/.log`: 기존 코드의 정상 운영 중 종료.
- `startup-fixed-{1,2,3}.json/.log`, `steady-fixed.json/.log`: 종료 수정 검증.
- `recovery.json/.log`: SIGSTOP 감지와 자동 재시작.
- `job-hang.json/.log`: IPC와 작업 진행을 구분하는 강제 종료 검사.
- `scheduler.json`: 중단 전·후·재개 후 jobs 행과 비교 결과.
- `observation.jsonl`, `observation-summary.json`: 연속 관측 표본과 최종 요약.
- `scheduler.log`, `crawler.log`, `reviewer.log`, `publisher.log`, `maintenance.log`: 정상 종료까지 저장한 역할별 로그.
- `shutdown.json`, `final-stats.jsonl`: 종료 결과와 종료 직전 자원 표본.

핵심 실행 도구는 `docker run --init`, `docker kill --signal TERM`, child에 대한 `kill -STOP`,
`docker inspect`의 State/RestartCount, `docker logs`, 시험 DB만 대상으로 한 `psql` 조회였다.
컨테이너 healthcheck는 로컬 파일을 읽으며 웹/DB/LLM 요청을 실행하지 않는다.

## 한계와 인계

- 이 실행은 30분 관측이며 24시간 관측이나 무중단 보장을 뜻하지 않는다.
- 실제 수집·AI 리뷰 10건과 웹/DB 부하 검증은 주 통합 담당자의 별도 결과와 함께 판단해야 한다.
- 강제 종료 후 DB lease 회수는 기존 10분 stale 기준의 영향을 받을 수 있다. 이번 idle/fixture 복구 시간만으로 모든 작업의 복구 시간을 보장하지 않는다.
- 5개 역할의 연속 시험 컨테이너는 정상 중지 완료했다. 생성한 DB와 증거는 보존했다.
