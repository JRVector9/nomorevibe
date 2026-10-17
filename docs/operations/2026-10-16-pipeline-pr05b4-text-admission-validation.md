# PR05b4-A 번역·검색 모델 admission 검증

번역·태그라인·검색 검증이 공통 모델 용량을 기다릴 때 처리 시도·실패 캐시·작업 완료 위치를 소비하지 않도록 연결했다. 현재 단계는 disabled의 기존 동작과 draining/open의 정확한 대기를 구현하며 양성 text 예약·dispatch는 아직 지원하지 않는다. 모델·prompt·wire·품질 기준은 유지한다.

## 변경 동작

- 닫힌7 route(reason-translate, product-tagline-ko, product-translate, crawl-tagline, product-search-profile, product-search-verify, search-query-translate)의 값·모델을 첫 await 전에 고정하고 실제 capacity control을 짧은 primary SHARE transaction에서 읽는다. disabled에서는 기존 transport를 유지한다. Draining/open의 미매핑 또는 미지원 계약은 typed defer다. 이 단계에서 request/reservation/dispatch/event는 발급하지 않는다.
- 기존 no_key·POST0 반환은 앞에 보존한다. Admission은 넓은 transport catch 앞에 있어 용량 대기를 일반 network failure로 바꾸지 않는다. Malformed/hash 오류는 원오류로 전파한다. Disabled에도 DB read는 추가되며 DB접근0이라고 주장하지 않는다.
- 병렬 태그라인·검색 profile/verify 작업은 capacity defer 때 새 admission만 멈추고 이미 시작한 peer를 정산한다. 실제 오류가 있으면 우선 전파하고 일반 실패의 기존 abort 동작은 유지한다. 단일 lane 작업은 기존 throw-before-writer가 충분해 source를 수정하지 않았다.
- 검색어 번역은 내부 translated/unavailable/deferred를 구분한다. Defer는 실패 cache/attempt/backoff를 쓰지 않고 원 검색과 translationPending을 유지한다. Cached 결과와 실제 network 실패의 기존 cache 쓰기는 보존한다.

## 범위 검증

수동 전체 suite/build/typegen은 모든 PR 개발 뒤에 실행한다. 중첩 집합을 합산하지 않는다.

| 범위 | 실제 결과 |
| --- | --- |
| 새 unit2 원35 | 21 Assertion FAIL/14 controls → 동일35 PASS(437ms) |
| 고정7 route·이유 번역 job controls 추가 unit3 | 51 PASS |
| 기존 transport4파일 | 고정 disabled read mock setup만 추가, 원본문·기대 유지,71 PASS |
| 실제 첫3 --bail1 | fixture policy CHECK23514 setup실패, 나머지2 미실행 |
| 최소 fixture 수정 후 disabled1만 | 1 PASS/2 skip, total1.32초/tests718ms |
| 최초 미실행 나머지2만 | 2 PASS/1 skip, total1.29초/tests777ms |
| 최종18파일 scoped TypeScript/ESLint | 각각 exit0 |

원35 frozen driver prefix·기존 transport4의 원본문·네 wire JSON.stringify AST·actual3의 it 이후 suffix 전체를 byteexact로 보존했다. 실제3 전체를 성공 뒤 반복하지 않았다. 설정 파서 보조 key 오류와 fixture setup 실패는 기능 Assertion RED로 세지 않는다.

실제 DB에서는 disabled SHARE transaction이 종료된 뒤 legacy transport stub 실행/idle TX0, actual runJob이 control row lock을 기다리는 동안 real requestJob으로 요청 버전 증가와 exact-token pause 변경, 이후 typed defer에서 token/locked_at만 해제하고 producer/cursor/pause/history·업무/attempt/cache/slot 미소모를 확인했다. Malformed policy 원오류·POST0도 확인했다. 입력 reason corpus는 실제 selector 증거이며 AI 제공자 양성 결과가 아니다.

첫 fixture는 JSON.stringify 문자열을 ::jsonb에 bind해 object 대신 JSON string이 됐다. READ ONLY SQL의 동일 문자열·parameter OID로 direct jsonb_typeof=string/text→jsonb=object와 CHECK를 확인했다. Root가 patch 전체를 읽고 승인한 bound placeholder6곳의 ::text::jsonb만 바꿨다. SQL JSON literal·production·시간·본문은 유지했다. 원23514와 수정 전후 raw를 보존했다.

## 원형·자원 정리

Root가 반환된 readback helper 전체와 정확55564 ID/image/scope/loopback/768MiB/solevolume/독점/dummy/running guard를 직접 확인한 뒤 별도 읽었다. Public90표10행 raw µs·captured catalog·권한·함수·constraints/indexes·ALWAYS triggers·journal85·3stage timestamp·model control/jobs/settings가 baseline=agent final=root다. 다른 연결0이다.

Candidate/attempt sequence2개는 last_value1 그대로 is_called false→true인 정상 소모만 보존했다. Reset/trigger disable/ACL 정규화0이다. 정상STOP/exited0/OOMfalse 확인 뒤 자기 container와 volume만 삭제했다. Captured public/drizzle/catalog 범위 밖 전체 cluster 검증으로 표현하지 않는다.

증거: `/tmp/nomorevibe-pr05b4-c-final-report-20261016.md`, `...c-final-shas-20261016.json`, `...root-independent-proof-20261016.json`, `...root-db-cleanup-20261016.json`. Source/test18파일만 개발했고 runner/schema/migration/native gateway/운영은 바꾸지 않았다.

## 남은 경계

양성 text request/slot/native dispatch/opaque terminal, AI2·CLI·embedding 전체 caller, 실제 provider hard C·종료·계약 배포, 실제 호스트 예산·30분 동일 품질 2배·Oracle 및 DR는 남아 있다. 현재 resolver unsupported/model disabled를 유지한다. 이 단계의 범위 PASS를 전체 CI·실제 운영 양성 호출·2배 합격으로 주장하지 않는다.
