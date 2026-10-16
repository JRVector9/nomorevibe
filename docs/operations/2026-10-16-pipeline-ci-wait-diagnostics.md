# HTTP 대기·replay 비용 진단 — 2026-10-16

CI에서 멈추는 첫 await와 replay seal/report의 비용을 구분하기 위한 계측이다. 운영 처리량 개선이나 기존 CI 실패 해결을 뜻하지 않는다. SQL·업무 판정·권한·검증 횟수·시간 제한은 유지했다.

## 실제 실패와 변경

PR453의 CI38853251422는 integration3이20분 한도로 취소됐다.14사례 중6FAIL이었으며, legacy runner는 정상 종료했지만29.037초를 사용했다. 순수 report 구간은10.290초였다. Item5개는 scope 종료 뒤 seal11.223–15.216초에서 거절됐고 readback/report에는 진입하지 않았다. 같은5구간에 PostgreSQL idle-in-transaction FATAL5가 있었으나 session PID와 run의 직접 결합은 없어 단일 원인으로 확정하지 않는다.

`pipeline-replay-execution.ts`는 기존 journal 준비·packet SELECT/reducer 집계·최종 검사, artifact 구성·strict parse·마지막 UPDATE를 구분한다. `pipeline-replay-artifact.ts`는 verified report의 clone/classify/coverage를 구분한다. 고정 phase와 기존 배열의 count, wall 및 process CPU만 기록한다. Payload 재직렬화·추가 SQL·PID query·parse·clone·hash·인증 cache는 추가하지 않았다. CPU는 다른 동시 작업을 포함하는 process 값이며 query CPU가 아니다. 중첩 구간을 더해 총시간으로 사용하지 않는다.

`http-origin-permits.test.ts`는 child result와 exit, 최초 unread 사례의 await, 원 cleanup allSettled를 구분한다. `CI=true` 또는 `HTTP_FIXTURE_TRACE=1`에서 phase/PID/monotonicMs만 stderr에 기록한다. URL·SQL·token·환경·오류 원문을 기록하지 않는다. 기존 Promise·정산·assertion·timeout을 유지한다.

각 진단 sink는 자기 error listener만 공유하고 callback/error 순서를 처리한다. Listener 한도가 차면 출력만 생략하며 원 작업은 진단 출력을 기다리지 않는다. Callback/event가 영원히 오지 않는 비정상 sink에는 모듈당 guard1이 남을 수 있다. 진단 손실을 성공 근거로 쓰지 않는다.

## 변경 범위 검증

- HTTP: 원파일에서 진단만 역제거하면 byte exact. 원 업무AST·expect124·taggedSQL34·await145·fork1 exact, sink12controls 및 scoped 검사 exit0.
- Replay: 원33함수 업무AST·taggedSQL/parameter59·exports·업무 호출 순서 exact. 초기 비동기 sink 보호 누락의 실제2RED→동일2GREEN, 실제 Writable을 포함한20controls PASS. 최종 두 source 저장 후 scoped tsc/eslint를 실제 실행해 각각 exit0을 확인했다.
- 새55546 HTTP 원 disabled1+unread1: **2PASS/18skip,6.91초**. `--silent=true`에서도 고정 trace56개가 보였고 실제 child4개 exit와 cleanup3쌍이 정산됐다. 최초 `--silent` 옵션 오류는 CLI실패/0test로 별도 보존했다.
- 새55547 replay 원 legacy1+첫item1: **2PASS/12skip,13.74초**. Execution22/report6/gross8/fixture29 begin/end가 모두 정산됐고 reject0이었다. 원20초 case·120초 manifest·DB lock1초/statement5초/idle5초 제한은 바꾸지 않았다.

| local 구간(ms) | legacy | 첫 item |
| --- | ---: | ---: |
| seal |360.150|978.932|
| journal |333.787|518.007|
| packet SELECT 합계 |75.545|105.885|
| packet parse/hash/reducer 합계 |249.469|404.087|
| strict artifact parse/hash |6.157|440.232|
| report |717.572|1234.030|
| report coverage |716.534|1233.095|

각각49/47packet,23/26change,99/95interval이었다. 초기 projection 크기와 runtime 변화량은 다른 수치다. 이 local 측정만으로 공유 CI의 병목·idle timeout 원인 또는 개선 효과를 확정하지 않는다. 새 자동 CI의 동일 phase를 비교해야 한다.

## Root 독립 확인과 남은 일

55546은 root 독립87표8행·82journal·수집 catalog/ACL/default가 baseline/final과 exact이며 연결0이었다.55547은 root가 agent final과 전체 exact, baseline의 raw data·journal·default·jobs/stage µs exact를 확인했다.55547 raw catalog exact는 **false**다. 기존 profile.release의16관계와 DB ACL이 NULL→명시 default로 달라졌고, 그 표현만 제외한 effective 수집 catalog/OID/owner 등은 exact였다. 원형을 억지 복원하는 DML은0이다. 두 DB 모두 정상 STOP/exited0/OOMfalse 뒤 자기 container/volume만 정리했다. **55515–47은 retired이며 재접속·재생성하지 않는다.**

근거: `/tmp/nomorevibe-http-trace-a-focused-observation-20261016.md`, `...http-trace-root-independent-proof...json`, `...pr453-b-subphase-final-report...md`, `...pr453-root-subphase-independent-proof...json`와 각 cleanup proof. 원 CI 분석·실패 로그는 `/tmp/nomorevibe-pr453-b-fixed-phase-ci-analysis-20261016.md`의 정확한 경로를 따른다.

다음은 새 CI에서 최초 미정산 phase와 동기 계산/SQL 대기를 구분한 뒤 그 범위만 수정하는 것이다. 수동 전체 unit/DB/build/typegen은 모든 PR 개발 뒤 수행한다. 실모델·운영 배포·consumer 활성화·Oracle live/DR·처리량2배는 이 검증에 포함되지 않는다.
