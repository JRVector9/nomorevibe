# PR06a AI2 독립 소비자 검증

AI2 대기 item을 기존 reviewer 역할 선거·job 실행 주기와 별도인 프로세스가 계속 소비하도록 연결했다. `scripts/pipeline-consumer.ts --stage=ai2 [--once]`는 명시한 버전·고유 instance/boot로 실행하며, 기본값은 DB·runtime import 전에 비활성 종료한다. 운영 양성 모델 경로는 아직 unsupported이므로 이 변경을 운영 처리량 2배 달성으로 해석하지 않는다.

## 동작과 경계

- 새 `lib/crawl/consumers/second.ts`가 primary의 pending 힌트를 fallback-first/id keyset으로 24개씩 읽고, 한 번에 한 item을 실제 lifecycle에 넘긴다. once/busy pass는 최대4페이지, 빈 큐와 공통 의존성 대기는 취소 가능한5초 backoff, 성공 뒤에는 짧은 마지막 페이지에서도 바로 보충한다. 힌트 자체에는 claim 권한이 없다.
- Consumer 전용 claim은 기존 private claim과 capacity SHARE→stage/domain/item 순서·현재 소유권 검사를 공유한다. Disabled도 같은 transaction 안에서 소비자 admission을 거절하며 앞선 CAS는 rollback된다. Open/draining/unmapped 역시 typed defer다. 예약·시도·실패·fallback·outbox를 만들지 않는다. 기존 compatibility/replay 경로를 보존한다.
- 기존 실제 lifecycle의90초 item lease/15초 갱신·observer·mandatory writer를 공유한다. Shutdown은 진행 중 실제 Promise 정산을 기다린다. Legacy job token을 소비자 소유권으로 위장하지 않는다.
- 기존 job controller는 items/draining에서도 생산자 요청을 확인하고 enqueue하되 legacy 처리 완료로 ACK하지 않는다. 기존 활성 job 소유권 최종 검사와 사람 판단·심사 정책을 유지한다.
- Supervisor opt-in은 reviewer에서만 허용한다. 소비자 전용 `SERVICE_INSTANCE_ID`의 ai2-consumer- 접두사와 비어 있지 않은 suffix, 전용 health 경로를 요구하고 기존 reviewer health 경로 충돌은 거절한다. 기존 운영 관측을 사용하지만 heartbeat를 readiness로 해석하지 않는다. 실제 호스트 총 예산과 replica별 고유 ID·경로는 활성화 전 확인한다.

## 실행한 범위 검증

수동 전체 suite/build/typegen은 모든 PR 개발 뒤로 미뤘다. 아래 중첩 집합을 합산하지 않는다.

| 범위 | 실제 결과 |
| --- | --- |
| 새 소비자 runnable scaffold | 13 Assertion FAIL/3 controls → 같은16 PASS |
| 짧은 페이지 즉시 보충 | 새1 Assertion FAIL →1 PASS |
| 관련 unit4파일 | 92 PASS |
| 독립 관측 ID·health 충돌 | 새1 Assertion FAIL →1 PASS, 범위 정적0 |
| 실제 첫 disabled | body 기대 통과 후 fixture own vote cleanup 실패; 기능 RED로 세지 않음 |
| 최소 fixture 수정 뒤 disabled만 | 1 PASS/7 skip, total1.30초 |
| 최초 미실행 나머지7만 | 7 PASS/1 skip, total2.43초 |
| 변경 범위 TypeScript/ESLint | 실제 exit0 |

실제8개는 disabled/open/draining의 transaction rollback3, 실제 once loop의 global hint disabled 대기1, compatibility actual claim→취소 writer1, items/draining actual controller enqueue/noACK2, 발급 후 release된 실제 job token 거절1이다. 외부 transport adapter3개만 mock해 POST0을 검증한다. 실제 제공자 양성 호출 증거가 아니다. 최종8 전체를 반복하지 않았다.

첫 fixture는 candidate 삭제가 second_reviews도 지운다고 잘못 가정했다. Root가 실제 own vote ID/candidate/repo/fullraw CAS 선삭제 patch와 원형 checkpoint를 읽고 승인했다. 같은 failed whole snapshot 안에서 자기 tuple만 복원하고 baseline 전체 일치 뒤 commit했다. 원 assertions/시간/production은 그대로다. 원실패·복원·분리실행 로그를 `/tmp/nomorevibe-pr06a-*20261016.*`에 보존했다.

## CI의 빈 DB 전제

Root 리뷰에서 기존 통합 shard는 앞선 파일의 데이터를 남길 수 있음을 확인했다. `.github/workflows/ci.yml`은 shard1의 npm ci 직후 소비자 원파일을 빈 DB에서 필수 실행하고, 뒤 모든 shard에서 그 파일만 exclude한다. 원형 guard·테스트 본문·시간제한을 완화하지 않았다. README의 최종 전체·shard 재현 명령도 같은 순서다.

YAML 파싱/완전 역변환/원 source10 SHA 보존/설치된 Vitest BaseSequencer.shard로 목록 배정 검증은 exit0이다. 총201파일을 isolated1+공유67/67/66으로 정확1회 배정하고 교집합0을 확인했다. `list --filesOnly` 자체는 shard를 적용하지 않으므로 실제 설치 export를 사용했다. 테스트 본문·SQL을 실행한 검증이나 실제 GitHub CI 성공 주장은 아니다. `/tmp/nomorevibe-pr06a-ci-isolation-final-report-20261016.md`와 coverage JSON에 원목록·명령을 보존했다.

## Root 독립 읽기와 자원 정리

Root는 반환 뒤 정확55562 Docker ID/image/scope/768MiB/loopback/solevolume/dummy/독점 guard를 재검사했다. Public+drizzle raw91표95행은 baseline=agent final=root, 권한·함수·index·constraint·트리거·stage µs·journal85·기본 설정도 exact, 다른 연결0이다. Candidate/document/attempt/secondreview sequence4개의 정상소모1(false)→9(true)는 reset하지 않았다.

Catalog 전체 raw는 exact가 아니다. Agent final 이후 root 읽기까지 jobs/operations_observations와 두 PK의 relpages/reltuples 통계4개가 추가로 변했고, baseline 대비 총6관계 통계 delta를 원형 보존했다. Root 최초 comparator의 catalog exact 가정 실패도 별도 기록했다. 이 외 captured catalog 필드는 exact이며 전체 pg_catalog를 증명한 것으로 표현하지 않는다. 정상STOP/exited0/OOMfalse 뒤 자기 container/volume만 삭제했다.

증거: `/tmp/nomorevibe-pr06a-root-independent-proof-20261016.json`, `...root-db-cleanup-20261016.json`. 최종 source11 SHA는 `...final11-shas-20261016.json`, 담당 source/CI 보고는 `...final-report...md`, `...ci-isolation-final-report...md`다.

## 독립 리뷰에서 보강한 두 경계

C 독립 리뷰와 root 직접 재검토에서 P2 두 건을 확인해 제출 전에 수정했다. `--once`의 성공 페이지가 스캔 횟수를 초기화하던 문제는 신규5 full-page control에서120 vs96 Assertion FAIL을 재현한 뒤, continuous 모드에서만 횟수를 초기화하는 조건1개로 고쳤다. 같은 신규+기존busy4page/short-refill3개 PASS/13skip, 두 파일 scoped tsc/eslint0이다. 원 기존 본문·기대는 유지했다.

소비자 기본 health 파일을 Docker healthcheck가 읽지 않거나 남은 legacy standby 파일만으로 정상 판정하던 문제는 reserved service ID와 같은 env path resolver를 공유해 고쳤다. 소비자 healthcheck는 전용 reviewer heartbeat만 읽고 legacy role 파일을 무시한다. 실제 spawn 전 programmatic option 경로가 env/default와 resolved 동일해야 한다. Legacy 역할의 원 파일 우선순위·기대는 유지한다.

새 health/config 검증은 원 code에서4 Assertion FAIL/2 controls → 같은6+가까운기존3=9 PASS/12skip(1.12초), 실제 healthcheck CLI5개 모두 actual close/정상 stdio/강제종료0이다. 초기 ESM spy2 setup오류는 별도 보존했고 기능 RED로 세지 않았다. 변경4파일 scoped tsc/eslint0, 원supervisor15 it/기존health함수·branch bytes 보존을 확인했다. Actual 소비자 실행이나 DB/원actual8/92전체를 재실행하지 않았다. 최종 source는11에서13파일로 늘었으며 `/tmp/nomorevibe-pr06a-c-final13-shas-20261016.json`과 followups patch를 기준으로 한다. Root가 두 수정 전체를 직접 읽고 원 실제8의 경계와 분리해 인수했다.

## 남은 작업

AI2 item-bound 양성 예약·native terminal, AI1 독립 소비자, 감사·소개 lane 공정성, 실제 provider 상한·종료, 호스트 총 자원 예산, 같은 품질의30분2배 측정, 운영 활성화와 Oracle 배치는 남아 있다. Source/domain lock이 item SKIP LOCKED 이전에 대기할 수 있으므로 모든 claim이 비차단이라고 주장하지 않는다. 현재 stage/사람 판단/기존 중단 설정·품질을 유지한다.
