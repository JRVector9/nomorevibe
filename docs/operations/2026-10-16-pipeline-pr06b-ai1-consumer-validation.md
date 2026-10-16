# PR06b AI1 독립 소비자 검증

AI1 대기를 기존 reviewer job 주기와 별도인 프로세스가 계속 소비하도록 연결했다. 이번 범위는 기존 규칙 판정과 유효한 이전 결과 재사용이다. 새 모델 호출은 실제 claim transaction 안에서 보류하며 운영 기본값은 비활성이다. 실제 처리량 2배 달성이나 AI1 item-native 모델 호출의 완성을 뜻하지 않는다.

## 동작

- `scripts/pipeline-first-consumer.ts [--once]`는 버전 opt-in이 없으면 DB/runtime import 전에 종료한다. 고유 AI1 소비자 service instance와 boot ID, 분리된 health 경로를 검증하고 기존 reviewer 관측을 사용한다.
- 소비자는 primary에서 준비된 후보를 24개씩 읽는다. 미검수 우선, 초기 ID 상한과 DB의 마이크로초 시각을 보존한 keyset, 한 pass 최대4페이지를 사용한다. 성공 뒤 짧은 페이지에서도 보충하며 빈 큐와 공통 의존성 대기는 취소 가능한5초 backoff다. 힌트 자체는 실행 권한이 아니다.
- 기존 `settings.enabled`/`reviewMode` 중단, 현재 원본·정책·사람 판단, 실제 건강한 legacy job/attempt 및 item 소유권을 유지한다. 새 claim은 control SHARE→stage/domain→attempt/item→실제 job 순서로 검사하며 충돌하면 tentative CAS까지 rollback한다.
- 기존 분류 준비를 추출해 규칙·스팸·접근성·제품 조회·근거 보류의 순서와 문구를 공유한다. 스팸 소비자는 원 writer transaction 안에서 재판정한 고정 보류 경로만 사용한다.
- 실제90초 item lease/15초 nonoverlap 갱신·현재성 observer·원 mandatory writer를 연결한다. 진행 중 갱신을 정산한 뒤 원 receipt로 기록하고 마지막 DB wall 검사를 유지한다. 새 모델이 필요한 item은 disabled/open/draining 모두 typed defer로 rollback한다.
- 기존 controller는 items/draining에서도 최대20개의 stale/exhaustion 작업과 생산자 요청을 처리하지만, legacy 모델 실행/완료 ACK로 우회하지 않는다. AI2 CLI/lifecycle/consumer 원3파일은 보존했다.

## 실행한 범위 검증

수동 전체 suite/build/typegen은 모든 PR 개발 뒤로 미뤘다. 중첩 집합은 합산하지 않는다.

| 범위 | 실제 결과 |
| --- | --- |
| 신규 runnable unit16 | 11 Assertion FAIL + 미연결 typed refusal2 / controls3 → 같은16 PASS,407ms |
| 기존 job/supervisor/health3파일 | 50 PASS + 기존 controller 기대1 FAIL |
| 승인된 controller title·두 assertions 적응 | 같은1 PASS/29 skip; 나머지50 반복0 |
| 변경 범위 TypeScript/ESLint | 담당자 실제 exit0; 전체 typegen/tsc 실행0 |
| 전용 DB의 원 actual8 최초1회 | 8 PASS, tests1.96초/total2.60초/exit0 |
| CI 편성 검증 | 설치 Vitest discovery + 실제 BaseSequencer,202파일 정확1회/교집합0/exit0 |

Actual 명령은 `TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55566/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/pipeline-first-consumer.test.ts --bail=1`이다. 실제 claim/observer/writer/controller/runJob/DB wall을 실행했다. 모델 adapter3개는 호출0 확인용 mock이다. Disabled/open/draining fresh-model rollback3, 실제 once 규칙 기록1, semantic reuse1, claim 뒤 사람 판단 보존1, 실제 legacy/item 중복 소유 보호1, items/draining controller·생산자 ACK 보호1을 검증했다.

짧은8개는 실제15초 갱신을 증명하지 않는다. 갱신/drain은 unit 제어흐름 증거이며 스팸 writer 전용 실제 DB case도 이8개에는 없다. 실 provider/호스트 총 예산/운영 readiness를 인증하지 않는다.

## 실패 기록

첫 scoped tsc의 nullable token 오류는 전체 running history의 건강한 소유자를 조회하는 EXISTS 보강으로 수정했다. 첫 baseline checker는 migration 행의 JSON-text 순서와 journal 순서를 잘못 비교해 실패했다. 뒤 독립 shell line의 actual8이 이어진 실행 순서 오류를 원로그로 보존했다. 이후 저장된 baseline만 id순으로 정렬한 checker가 통과했으며 최초 precheck가 성공했다고 바꾸거나 actual8을 반복하지 않았다.

기존 job test의 controller 기대는 controller가 legacy admission보다 먼저 실행되는 새 순서에 맞춰 title·두 assertions만 바꿨다. 나머지29개 본문과 신규 unit의 RED→GREEN driver bytes는 exact다.

## CI의 실행 순서

`.github/workflows/ci.yml`은 shard1에서 AI2 소비자 원파일을 먼저, AI1 소비자 원파일을 두 번째 별도 필수 step으로 실행하고, 뒤 공유3개 shard 모두에서 두 정확한 파일만 제외한다. README의 전체·shard 명령도 같다. 각 runner는 별도 Postgres를 사용한다. 두 소비자는 같은 행 기준 상태를 복원하며 sequence의 정상 증가는 보존한다.

Root가 원 workflow 역변환/YAML/동결12 SHA와 설치 Vitest의 실제 shard 배정을 검증했다. `202=isolated2+shared67/67/66`이며 모든 파일을 정확1회 배정한다. 목록 검증은 테스트 본문·SQL이나 새 GitHub CI 성공 증거가 아니다. 기존 필수 CI를 생략하거나 실패 기대·시간을 완화하지 않았다.

## 독립 읽기와 DB 정리

Root가 정확55566 Docker full ID/image/scope/loopback/768MiB/solevolume/dummy/독점 guard10개를 확인한 뒤 SELECT helper를 전체 읽고 독립 readback했다. Public+drizzle raw91표95행은 baseline=agent final=root,85 migration journal/defaults/권한·함수·ALWAYS trigger·stage 및 agent sequence는 exact, 다른 연결0이다. 후보/문서 sequence는1,false→10,true, attempt는1,false→12,true로 정상 증가했으며 reset0이다.

Captured catalog 전체는 exact가 아니다. Baseline 대비6관계, agent 대비4관계의 pages/tuples와 `jobs.relfrozenxid`753→924 차이를 원형 보존한다. 원인은 직접 관측하지 않았다. Root의 최초 stats-only comparator 실패도 보존했고 저장된 snapshot 비교만 수정했으며 추가 DB 읽기·DML·정규화0이다. 나머지 captured catalog 필드는 exact지만 전체 pg_catalog 증명으로 확대하지 않는다.

정상 STOP/exited0/OOMfalse 확인 뒤 자기 container·volume만 제거했다. Root 직접 소스 리뷰와 B의 읽기 전용 독립 리뷰에서 추가 확정 P1/P2는0이다. 독립 리뷰는 테스트·DB를 재실행하지 않았다.

증거는 `/tmp/nomorevibe-pr06b-a-final-report-20261016.md`, `...a-final-shas...json`, `...a-actual8-initial...log`, `...b-independent-review...md`, `...root-independent-proof...json`, `...root-catalog-delta...json`, `...root-db-cleanup...json`, `...root-ci-coverage...json`에 보존했다. Source12는 동결 SHA를 기준으로 인수하며 CI/README/이 문서/공유 인계문서는 root 소유다.

## 남은 검증

AI1 item-bound 양성 모델 예약·실제 native 종료·historical 정산, 실제 제공자 hard token bound, 전 caller 공정성, 장시간 갱신, 호스트 총 자원/DB/provider 예산, 같은 품질의30분2배 측정, Oracle 배치·DR와 운영 활성화는 남아 있다. 현재 source/domain lock이 item SKIP LOCKED 전에 대기할 수 있으므로 모든 claim이 비차단이라고 주장하지 않는다.
