# PR01b-5 — 준비 coverage·writer fence·인증 artifact 검증

2026-10-15. [실행 계획](../superpowers/plans/2026-10-15-pipeline-pr01b-coverage.md), base main `4af0589` / [PR433](https://github.com/JRVector9/nomorevibe/pull/433).
병렬 구현과 root/담당 간 교차 리뷰를 완료했다. 전체 로컬 필수 검증을 통과했고 PR/최신 base CI를 준비한다. 운영 적용 전이다.

## 구현과 리뷰 책임

사용자 지정 `gpt-6.1-sol / xhigh` 담당 3명이 readiness, lifecycle/SQL, artifact/compare를 단독 소유했다.
root는 공통 계약·파일 소유권을 관리하고 DB scope/runner/jobs/profile/CLI/실제 통합을 작성했다.
담당 소유권 밖 수정은 root 인계 뒤 진행했으며 최종 코드를 root가 직접 읽고 교차 리뷰를 취합한다.

- readiness: 전체 고정 입력·actual 원본/정책 초기 hash, 실제 eligibility·rules/reuse/hold·job/lease·expiry, OLD/NEW reducer와 commit 상한.
- lifecycle: 새 admission과 기존 writer drain 분리, DB 공유/배타 fence, 공통 마지막 journal flush, 별도 실제 COMMIT 확인, 비공개 quiescence와 seal.
- artifact: strict 별도 ledger 형식, JSON은 unverified, 고정 protected DB readback만 verified handle, 보수적 완료/지연/품질/실패 집계.
- root: 제한 DB transaction에 hook 연결, `handlers-v4` 고정 권한·DB-owned trigger, 실제 두 review handler runner, 새 tick admission, export/report/verify/compare CLI.

## 실제 실행한 검증

| 범위 | 실제 결과 | 상태 |
| --- | --- | --- |
| root 전체 unit | 276파일 / **2,843 PASS**, 9.98초 | 최종 production 소스 고정 후 실행. 후속 변경은 DB test fixture/종료 assertion과 문서뿐 |
| root scope/runner/transport 관련 unit | 71 PASS | 공통 hook 연결 후 |
| root 실제 coverage runtime | 3 PASS, 31.45초 | 실제 2단계→seal/DB 인증/CLI, 위조 초기 hash 거절, 실제 15초 heartbeat 대기 |
| root handlers-v4 권한/profile | 실제 DB 13 PASS | trigger drift·금지 UPDATE/INSERT 경계 포함 |
| 신규 tick admission | 실제 RED1→GREEN | closeAdmission 뒤 새 runJob 실행은 거절하고 기존 writer는 drain |
| readiness 담당 | unit21 / 실제 DB10 PASS 보고 | 전체101번째 입력·SQL differential·µs 신선도·요청 조건·초기 foreign owner·현재 실행 claim 증명 |
| lifecycle 담당 | 최종 lifecycle13 + ledger20 = 실제33 PASS, 기존 관련48 PASS 별도 | rollback·outside-scope writer·양방향 fence 선점·미확인 commit·단일 실행 진입·native DB µs·실제 분류 충돌 거절 |
| artifact 담당 | unit38 PASS 보고 | JSON 인증·commit upper·µs·later-ready 지연 미판정·slot/root binding·actual 신규/재검수/unknown |
| next typegen / tsc / 전체 lint | 실제 PASS | 분류 보완 후 tsc/lint 재확인, fixture 보완 후 tsc/관련 lint PASS |
| root 관련 실제 DB | 최초54 PASS / 1 FAIL→두 단계 target GREEN, 후속 격리3파일 **27 PASS** | seal timestamp µs 수정 및 테스트 상태 격리 반영 |
| root 전체 DB | **160파일 / 1,745 PASS / 기존 TODO1**, 345.55초 | 격리 보완 후 전체 실행 성공. 마지막 child-close/CLI assertion target도 별도로1PASS(14.43초) 재확인 |
| i18n / Python / build / bundle | 실제 PASS / **23 PASS** / PASS / 공개3경로 한도 이내 | build의 기존 dynamic filesystem tracing warning1 포함 |

최신 base CI는 PR 제출 뒤 확인한다. 최초 전체 DB 시도는 첫 테스트 timeout 후 연쇄 실패하여 INT 종료했으며 합격으로 세지 않는다.

## 실제 RED와 수정·실패 접근

공통 hook이 누락된 scope의 3개 실제 단위 회귀를 RED로 확인해 연결했다. admission 종료 뒤 새 tick을 시작하는 실제 결함도 RED로 확인해 claim transaction 첫 줄에서 차단했다.
drain이 진행 중 final writer까지 막는 실제 DB 회귀를 확인해 admission와 writer fence를 분리했다.
초기 hash 위조, 100개 조회 제한 밖 준비량, OLD/NEW 위조, DB microsecond 신선도·job 요청 조건은 실제 반례로 검증했다.

통합 과정에서 Drizzle이 native postgres JSON serializer를 변경해 object parameter 오류와 이중 JSON 인코딩이 발생했다. 공통 raw flush/final의 직렬 JSON은 `::text::jsonb`로 바꿨다.
DB 생성 event 시각을 runtime INSERT 권한에 추가하는 대신 DB DEFAULT/RETURNING을 사용했다. native PG UTC 문자열의 microsecond를 보존했고 call failure_class 스키마를 실제 SQL과 맞췄다. 후속 packet DB 시각도 native timestamp serializer가 ms로 자르는 것을 실제 두 단계 실패로 발견해 `::text::timestamptz`로 보존했다.
fixture 타입/날짜 hydration·import 오류는 동작의 RED로 세지 않는다.

공유 writer fence 1줄을 잠시 제거한 canary에서 actual `pg_blocking_pids` count0으로 RED1을 확인했고 `finally`로 즉시 원복했다.
원복 전후 SHA256은 동일(`0d2713a6c962db9d50971f13a12c5578f4b272dbe9eda84582c0dcd6f556a915`)이며 같은 target GREEN1을 다시 확인했다.
RED 실행의 5초 barrier에는 DB idle timeout과 겹친 보조 `CONNECTION_CLOSED` unhandled1이 있어 함께 기록한다. 정상 실행 오류는 0이었다.

## 보장 범위와 남은 작업

fixture는 실제 handler/transaction/종료 장부의 구현 검증이다. 실제 serving identity·숨은 retry/fallback 전체 비용·취소 계약과 30분 baseline이 없어 provider budget과 2배 성능은 미판정이다.
JSON 파일의 hash/sealed 표시는 인증이 아니며 비교도 unverified다. export는 0600/exclusive이고 identity credentials/nonce를 포함하지 않는다.
restart의 투명 재진입은 지원하지 않는다. 미확인 commit/호출·quiescence 부족은 seal과 겹친 새 run을 거절한다.

운영 DB/DDL·수동 배포·실제 provider inference·새 consumer 활성화는 수행하지 않았다. M3/mini/Oracle 처리량과 DR 합격을 이 검증으로 주장하지 않는다.
전용 loopback DB는 readiness55462, lifecycle55463, root55464이며 운영 DB와 분리했다. 최종에 세 담당 DB cleanup과 container 중지를 확인했다. root55464의 schema/role/trigger/잔여 연결은 모두0이며 PUBLIC ACL은 database CONNECT/TEMPORARY, public schema USAGE로 복원됐다.

## 전체 suite 격리와 종료 보완

최초 전체 DB 시도에서 첫 coverage runtime의 45초 제한을 넘었고 profile/source trigger가 남아 후속 실패가 이어졌다. timeout 뒤 실행/CLI가 계속되면 runtime 연결을 검사하는 cleanup이 거절되는 경로가 있으나, 최초 cleanup 예외 종류는 로그만으로 확정하지 않는다. 이 run을 INT로 종료하고 잔여 runtime 연결0을 확인한 뒤, 소유 identity/nonce/DB owner를 인증해 이 전용 test profile/schema/role만 정리하고 신규 container의 원래 PUBLIC ACL을 복원했다.

초기 projection에는 앞서 실행한 fixture의 문서105개와 observations10개가 남아 있었다. 다른 품질 작업 없이 같은 target을 실행하면 33.33초 PASS였고 깨끗한 담당 DB의 약4초와 차이가 있었다. 전체 projection/readback/reducer를 반복하는 테스트의 상태 누적과 동시 부하가 timeout에 기여한다는 증거이며, 최초 cleanup 예외 종류는 INT 전 마지막 stack이 없어 확정하지 않는다.

새 DB 테스트3개의 준비에서 표준 resetTables와 projection public11개 테이블을 초기화했다. runner/CLI에는 공유30초 AbortSignal, 각 CLI child에는10초 제한을 적용하고 자식 close를 finally에서 기다린다. 중복 export는 정상 CLI exit1/비-killed/고정 stderr를 확인해 취소·timeout을 성공으로 보지 않는다. 이 signal이 prepare/seal/readback/동기 report 전체의 hard30초 상한이라고 주장하지 않는다.

담당 간 교차 읽기와 root 직접 리뷰에서 지적된 준비 요청·foreign owner·실패 writer·초기 재검수 분류·child 정리 경계를 수정했다. 현재 보고된 미해결 P1/P2는 없다. 전체 로컬 필수 검증은 통과했다. 최신 base CI와 병합 상태는 PR 메타데이터로 별도 확인한다.

## 재현 명령

```sh
npm test
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55464/nomorevibe_test npm run test:integration
npx next typegen
npx tsc --noEmit
npm run lint
npm run check:i18n
python3 -m unittest tests/test_deploy_shared_images.py
DATABASE_URL=postgres://build:build@localhost:5432/build npm run build
node scripts/bundle-size.mjs
```

장부 CLI는 명시적 격리 identity와 run ID를 사용한다. 아래 경로는 예시이며 실제 credentials를 문서에 넣지 않는다.

```sh
node --import tsx scripts/measure-pipeline-replay.ts export IDENTITY RUN OUTPUT
node --import tsx scripts/measure-pipeline-replay.ts report OUTPUT
node --import tsx scripts/measure-pipeline-replay.ts verify IDENTITY RUN
node --import tsx scripts/measure-pipeline-replay.ts compare BASELINE_JSON CANDIDATE_JSON
node --import tsx scripts/measure-pipeline-replay.ts compare-db BASELINE_IDENTITY BASELINE_RUN CANDIDATE_IDENTITY CANDIDATE_RUN
```
