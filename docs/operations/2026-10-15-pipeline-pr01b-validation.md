# PR01b 격리 실행 기반 — 검증 기록

2026-10-15. PR01a [#429](https://github.com/JRVector9/nomorevibe/pull/429)의 후속 첫 구현이다.
이 단계는 실제 검수 handler 연결 전의 DB 경계·기준 시각·호출 예약 기반이다.
실제 모델 replay, 최종 전이·준비 coverage,30분 비교 및 PR01 전체 완료는 아직 아니다.

## 구현 범위

- `lib/operations/pipeline-replay-database.ts`와 bootstrap CLI: 사전에 만든 local test DB의
  database/schema/role/owner OID와 nonce를 읽어 확인한다. 별도 제한 계정은 공개 제품 테이블,
  marker 쓰기, 임시 테이블·schema 생성, 역할 권한 변경을 수행할 수 없다. 매 transaction에서
  실제 session을 재확인하며, raw JSON·복사한 객체는 verified handle을 만들 수 없다.
  private identity는 exclusive0600 정규 파일이며 CLI 출력에는 URL/password/nonce가 없다.
- `lib/crawl/review-replay-context.ts`와 기존 검수 경계: AsyncLocalStorage로 evidence/rule freshness만
  기준 시각에 고정한다. 실제 event·lease·backoff·owner 변경 시간은 유지한다. 저장된 현재 버전
  README가 없으면 fetch 전에 `replay_readme_evidence_missing`으로 거절한다. AI2 gate SQL 자체는 변경하지 않았다.
- `scripts/sql/pipeline-replay-ledger.sql`: 격리 schema의 run/input/call/append-only transition 네 테이블이다.
  운영 drizzle migration에 포함하지 않는다. 초기 bootstrap은 marker만 만들고 장부 DDL/grant는
  별도 trusted test/bootstrap administrator가 설치한다. 런타임은 고정 identity/manifest/input/request를
  수정하거나 event를 지울 수 없다. 이 단계에서 공개 제품 테이블 권한은 부여하지 않는다.
- `lib/operations/pipeline-replay-ledger.ts`: 기존 입력 hash 함수를 사용해 manifest·정책·고정 원본을
  결합한다. 외부 callback 전에 호출1건과 토큰 상한 전체를 DB에 예약하고 commit한다.
  AI1/AI2는 같은 concurrency/call/token 예산을 쓴다. 미사용·전송 전 취소 예약도 환불하지 않는다.
  retry/fallback은 반드시 다른 call ID와 예약을 필요로 한다. 별도 연결의 run 시작은 전역 advisory lock으로 직렬화한다.
- `lib/operations/pipeline-replay-transport.ts`: fixture callback만 한 번 호출한다. gateway URL,
  credential 조회, fetch, CLI spawn 또는 실제 심사 엔진을 포함하지 않는다. `model-replay`는
  장부와 wrapper 양쪽에서 `unsupported_provider_budget`으로 차단한다.

run은 prepared→running→draining이다. 이번 단계에는 seal/resume/takeover API가 없다.
원격 호출 종료를 입증하지 못하는 dispatching/in_flight/indeterminate는 새 run과 겹쳐 시작할 수 없다.
응답·usage가 불명확하거나 상한을 초과하면 비용을 유지하고 admission을 닫는다. 불명 상태의 DB 기록까지
실패하면 opaque run의 메모리 fence가 즉시 새 호출을 막고, 재시작은 durable active run 때문에 거절된다.

## 실제 발견·수정한 회귀

- DB unit 최초 구현 전9건 RED 후 GREEN. 추가 ambient PGPORT 우회는 supplied env:{}와 실제 process.env
  차이로 재현했다. 실제 PG*/replica/migration override도 검사하고 driver의 host/port/user/password/DB를 명시한다.
- marker의 column-level UPDATE 권한과 허용 schema의 SECURITY DEFINER 함수는 초기 검사로 거절되지 않았다.
  실제 DB RED 두 건 후 effective column privilege·callable security-definer 검사로 수정했다.
- 장부는 drain 후 기존 예약의 dispatch를 허용했다. 실제 assertion RED 후 dispatch 직전 admission 재검사로 수정했다.
- 응답 유실의 indeterminate 기록 실패 후 다음 예약이 허용됐다. 실제 DB의 event INSERT를 회수해 RED를 재현하고,
  저장보다 먼저 run의 admission을 메모리에서 닫도록 수정했다.
- SELECT FOR UPDATE의 clock_timestamp 투영은 잠금 대기 전에 계산될 수 있었다. 실제400ms deadline을550ms
  잠금 대기로 넘겨도 호출이 허용되는 RED를 재현했다. 잠금을 얻은 뒤 별도 wall-clock SELECT로 수정했다.
- CI는 optional TEST_DATABASE_URL을 설정하지 않는다. 테스트는 기존 setup의 resolved 상수를 사용한다.
  새 CI 파일은 자기 schema/role만 정리하고 기존 PUBLIC ACL을 grantor/권한/grant option까지 복구한다.
  명시 PIPELINE_REPLAY_IDENTITY_FILE을 사용하는 로컬 재사용은 객체를 삭제·복구하지 않는다.

transport 최초 missing-module RED 후7건 GREEN, clock의 behavior RED8건과 SQL/claim RED4건을 확인했다.
장부 전체를 구현 전에 실행한 것으로 보고하지 않는다. 위 실제 behavioral RED와 이후 통합 결과를 구분한다.

## 실제 실행 결과

- `npm test`:267파일/2,669PASS (최종 helper 수정 후).
- dedicated55453의 boundary+ledger:2파일/24PASS (최종 독립 run-start 경합 테스트 추가 전).
- 새 dedicated55454의 boundary+ledger+clock:3파일/32PASS (최종 독립 run-start 경합 테스트 추가 전).
- clock agent 관련 unit6파일/99PASS, 관련 DB6파일/128PASS.
- `npx next typegen`, `npx tsc --noEmit`, `npm run lint`, `npm run check:i18n`, `git diff --check`:PASS.
  기존 vendor `_ctx` lint 경고1이 있다.
- build PASS. bundle PASS(home148.7/product159.0/launch136.2KB br). Python deploy23PASS.
- 전체 integration:151파일/1,657PASS/기존TODO1,257.27초. 마지막 계획 토큰 산술 회귀 추가 전 결과다.
- 최종 변경 뒤 새55454에서 boundary+ledger+clock3파일/35PASS 및 TypeScript/diff 검사PASS.
  동일 DB에서 fresh bootstrap/정리/PUBLIC ACL 복구를 반복 확인했다.
- 마지막 계획 예산 산술 회귀는 허용되지 않아야 할 manifest가 준비되는 RED 후 사전 거절로 수정했다.
  정확한 모델 route 대신 canonical 별칭을 받는 RED도 exact+canonical 동시 확인으로 수정했다.

전용 container:
`nomorevibe-pipeline-pr01b-test-db-20261015`(127.0.0.1:55453),
`nomorevibe-pipeline-pr01b-ci-test-db-20261015`(127.0.0.1:55454).
둘 다 `pgvector/pgvector:0.8.6-pg17`로 만들었다. 운영/개발 DB를 사용하지 않았고 최종 검증 뒤 두 container를 stop했다.

## 제공자 계약과 남은 작업

현재 모델은 AI1 `[MLX] gpt-oss-120b`, AI2 `[supa] Qwen3.8-27B-NVFP4` 그대로다.
인증된 GET metadata는 backend:vllm을 보고했지만 AI1 context가 API별8192/32768로 충돌했다.
listing created가 요청 시각에 따라 바뀌어 serving revision 증거로 사용할 수 없다.
OpenAPI의 nullable integer max_tokens/max_completion_tokens와 추천 prompt 길이는 총 토큰 강제 상한이 아니다.
실제 serving revision·reasoning 포함 상한·무단 clipping 없음·숨은 retry/fallback 횟수·취소 계약은 미확인이다.
진단 metadata나 manifest boolean으로 실제 모델 호출을 허용하지 않는다.

후속으로 로컬 abcLLM clean HEADfc0f972를 읽기 검토했다. backend 표시가 hardcoded이고 display prefix는
실제 서버 identity를 고정하지 않았다. Qwen400/422 재시도는 thinking 옵션을 제거하며 최대2번 POST할 수 있고,
usage가 없을 때 추정 usage를 정상처럼 반환했다. 요청의 reasoning_effort/response_format도 해당 checkout에서
forward하지 않았다. 실제 배포가 같은 revision인지 미확인이므로 runtime 동작으로 단정하지 않는다.
정확한 경로·줄·남은 readback은 [provider audit](2026-10-15-pipeline-pr01b-provider-audit.md)에 기록했다.

다음 단계는 실제 handler가 같은 검수 writer/gate를 사용하도록 명시 connection·downstream 경계에 연결하고,
실제 writer transaction의 최종 전이 및 준비/보류/재개 coverage를 기록하는 것이다.
새 ledger artifact는 semantic validity와 실제 event 시간을 구분해야 한다.
기존 v1 as_of_snapshot_only/unverified 판정은 유지한다. 제공자 강제 상한을 확인한 다음에만 실모델을 실행한다.
모델 교체·기준 완화·운영 migration·공개 발행·실부하·2배 성능 주장은 이번 단계에 없다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe-pipeline-pr01b
# 아래 URL은 직접 만든 전용 test cluster만 가리켜야 한다.
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55454/nomorevibe_test npm run test:integration
npm test
npx next typegen
npx tsc --noEmit
npm run lint
npm run check:i18n
DATABASE_URL=postgres://build:build@localhost:5432/build npm run build
node scripts/bundle-size.mjs
python3 -m unittest tests/test_deploy_shared_images.py
git diff --check
```
