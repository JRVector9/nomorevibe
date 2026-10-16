# PR05b7 검색 키워드 생성의 모델 용량 연결 — 2026-10-16

`product-search-profile` 생성 작업을 실제 text 역할·job lease·현재 제품 근거와 연결해 모델 용량을 예약한다. 예약한 일감을 다시 확인하고 dispatch/event의 DB commit 응답을 받은 뒤 원 요청을 한 번 전송한다. 완료 근거는 과거 dispatch에 정산하며, 현재 제품/lease가 바뀌면 기존 writer가 결과 저장을 거절한다. EOF 등 종료를 확인하지 못한 호출은 전량 사용으로 남겨 다른 boot와 변경된 근거에서도 같은 제품의 재전송을 막는다.

기존 parser·품질 기준·wire·max_tokens500·lane2/BATCH12/45s call/54s tick과 verification writer를 유지한다. 신규 양성 경로 하나만 연결했으며 다른 여섯 text 호출의 Phase A 거절은 유지한다. 실제 원격 serving 계약을 아직 확인하지 않아 production resolver는 null이다. 이 PR로 실제 운영 호출이나 처리량 두 배를 입증하지 않는다.

## 구현과 직접 리뷰

Production11: capacity/schema/repository·0087/journal, gateway/고정 serving leaf, search-profile 원 wire 추출, 현재 profile reader/dispatch coordinator/job 연결이다. 새 tests4와 기존 callers/budget test의 승인된 고정 mock 경계 두 곳을 추가·적응했다. 기존 test body/기대·원4 CHECK literal·0084–0086·원journal87은 보존했다. 0087은 새 CHECK 분기와 journal tail1을 추가한다.

Root가 production/runtime·새 테스트·actual driver 전체를 읽었다. 읽기 전용 builder prefix로 전체0087과 schema 역변환·원literal/journal을 독립 확인했다. 기존2059 tracked 원문을 보호했다. B의 ledger/native/runtime 독립 리뷰에서 production 추가 P1/P2=0이며 fixture 대기 정산 문제 두 지점은 원 operation과의 race로 보완했다. Private native preparation/terminal instance와 원 reservation/owner/binding을 확인하며 단순 JSON·timeout·현재 TTL로 호출 종료를 인증하지 않는다.

## 실제 실행한 범위 검증

| 범위 | 실제 결과 |
| --- | --- |
| 신규 shape/protocol/native | 각 Assertion RED→같은 GREEN, 최종 ledger/native26 PASS |
| 원 frozen wire 별도 control | 1 PASS/14skip |
| coordinator와 실제 domain reader unit | 각 Assertion RED→GREEN, 최종10 PASS |
| 기존 profile/caller/job 영향 controls | 해당 좁은 회귀 PASS, 원 본문/시간·품질 보존 |
| 실제 DB+loopback8 | 7 PASS/EOF 기대1 FAIL → 기존 source reset 계약에 맞춰 그1만 보강 → 정확1 PASS/7skip |
| 최종 변경 범위 TypeScript·ESLint | 실제 exit0 |

전체8을 성공 상태로 재실행하지 않았으며 8개 distinct 경로의 성공을 합쳐 기록한다. 실제 경로는 실제 text 선거·job 요청/claim·capacity 대기 ID 재사용·DB blocking 뒤 예약 만료·event 오류 rollback·job 만료 뒤 historical terminal·원 writer/ACK·EOF crossboot/source fence다. C=8000은 localhost 테스트 descriptor이며 실제 serving bound나 원격 종료 증거가 아니다. Present profile raw µs는 reader에 보존되지만 실제8의 양성은 부재 profile이므로 실제 present µs 경합은 미검증이다.

## 보존한 실패와 전용 DB 원상태 확인

첫55573은 fixture가 lazy Drizzle thenable을 여러 번 동화해 seed INSERT23505와 cleanup 실패를 냈다. 나머지7은 미실행이며 기능 RED가 아니다. Root가 원 raw를 독립 저장했고 control/product1/role 차이를 보존했다. 복구 DML 없이 정상 STOP/exited0/OOMfalse/전용 container·volume 제거로 폐기했다. 이후 테스트 helper만 Promise.resolve 한 번으로 보완했다.

새55575에서는 첫8 중7 PASS/EOF 마지막 기대1 FAIL이었다. 제품 source 변경 시 원0048 trigger가 attempts=0/source_revision+1로 초기화하는 동작과 test가 충돌했다. 기존 attempts1 검사를 변경 전으로 옮겨 보존하고, reset0/revision+1 및 이후 defer가 값을 바꾸지 않음을 확인하도록 강화했다. 동일 EOF1만 재검증해 통과했으며 production 수정은 없었다. 원 실패 로그는 유지한다.

Root 독립 SELECT-only readback에서 공개90표10행·drizzle journal88·captured 정의/ACL/default·stage·ALWAYS2·다른 연결0을 확인했고 agent와 raw/catalog/sequence가 일치했다. Sequence4의 정상 증가를 보존하고 reset하지 않았다. 전체 pg_class 비교는 pages/tuples 차이로 false이며 원 delta와 첫 비교 실패를 보존했다. 원인을 관측한 것으로 주장하지 않는다. 이후55575도 정상 종료·전용 container/volume 제거했다. Retired DB 재접속은 없다.

근거: `/tmp/nomorevibe-pr05b7-root-{ledger-native-conformance,pre-db-source-proof,failed-db-proof,final-db-proof}-20261016.json`, 담당 `...a-pre-db-report...md`, 최종17 manifest `...a-prefinal-shas...json`, B `...b-runtime-independent-review...md`와 EOF 후속 proof다. 원실패/수정별 raw log는 같은 prefix에 보존했다.

## 운영과 남은 검증

운영 DB/DDL/SSH/실 provider/배포/consumer 활성화0이다. 실제 Oracle ARM 상시 번역·원격 hard C/종료·host 전체 DB/HTTP 합계·남은 여섯 route·복제/fencing/RPO/RTO·같은 품질30분 두 배·24h 관측은 남는다. 전체 수동 테스트는 모든 PR 개발 뒤 실행한다. 필수 CI와 이 테스트 파일의 fresh-first 배치는 취합 단계에서 추가한다.
