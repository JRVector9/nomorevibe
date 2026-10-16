# HTTP timeout source 수명 보존 검증

`fetchCapped`가 caller signal과 native timeout을 결합할 때 원 timeout source를 같은 composite signal의 수명 동안 보존한다. Native `AbortSignal.any`의 timeout source가 만료 후 최초 소비 전에 GC되면 원 deadline을 관측하지 못하는 현상을 로컬에서 재현했다. Private WeakMap(composite→timeout)과 private signal factory만 추가했다. Caller가 없으면 원 native timeout을 직접 반환한다.

WeakMap은 key를 영구 보유하지 않으며 public API, 추가 abort listener, headers 시점 삭제를 도입하지 않는다. 원 SSRF·redirect·body 상한·각 hop timeout·caller reason·permit 예약/실제 reader 정산은 유지한다. Timeout 또는 lease 만료만으로 charge를 해제하지 않는다. 진단 전용 PR472의 임시 계측 4파일은 이 변경에 포함하지 않는다.

## 실행한 범위 검증

| 범위 | 실제 결과 |
| --- | --- |
| Native causal 3변형, 각 최초1회 | prefire GC와 postfire+WeakMap은 원 TimeoutError/exit0, postfire GC만 deadline 소실·실제 watchdog caller abort/exit1; overall1 보존 |
| 실제 `fetchCapped` 신규3 driver, 원 source | 유효2 Assertion FAIL/대조1 PASS, 실제200 성공이 timeout 기대와 불일치 |
| 같은 동결3 driver, 최소 수정 뒤 | 3 PASS, tests1.19초/총1.27초 |
| 기존 conditional controls | 2 PASS |
| 변경 범위 TypeScript/ESLint | 실제 exit0 |
| 원 unread 통합 사례 최초1회 | 1 PASS/19 skip, tests6.04초/총6.48초/exit0 |

신규 driver는 실제 Node child와 native100ms timeout/실제250ms await/GC75 또는150ms를 사용한다. 최초 소비 전 signal/source를 읽거나 listener를 추가하지 않는다. Headers 이후에는 실제 ReadableStream pull이 같은 signal을 소비한다. 실제 close 뒤에만 단언하며 watchdog/강제 TERM·KILL은 성공으로 인정하지 않는다. 최초 child bootstrap3 실패는 별도 setup 오류로 보존했고 정확 원인은 미확정이다. 유효 원 RED와 구분한다. GREEN의 개별 GC 숫자는 runner가 출력을 숨겨 보존되지 않았으며 strict assertions 통과 범위만 주장한다.

원 unread 사례는 test20초/hook60초/caller100ms/worker/assertions/SQL/TTL을 변경하지 않았다. 기존 fixed phase trace만 켰고 observer·GC·prewarm 변형은 추가하지 않았다. 실제 child2개 모두 PG end와 close, held hop charge 보존과 drain/epoch 뒤 원 정산 기대를 통과했다. 강제종료·cleanup 실패는0이다.

```sh
TEST_DATABASE_URL=<전용 로컬 테스트 DB> HTTP_FIXTURE_TRACE=1 npx vitest run --config vitest.integration.config.ts tests/integration/http-origin-permits.test.ts -t '^a native-ended but unread response retains its charge past the reservation deadline and across drain/epoch changes$'
```

수동 전체 suite/build/typegen은 모든 PR 개발 뒤 실행한다. 위 중첩 검증 수를 합산하지 않는다.

## 독립 검토와 DB 정리

Root와 C가 최종3파일을 전부 읽고 원 fetch 역변환 전체 byte 일치·보호6파일 SHA 일치·유효 RED/GREEN driver 일치를 확인했다. 추가 P1/P2는0이다. Shared coordinator가 request/body에서 init.signal을 보유하는 경로와 기존 native settlement도 읽었다.

Root 배정55565의 pinned PG17 image/loopback/768MiB/dummy 계정/정확 ID와 전용 volume에서만 실행했다. Source/DB journal은 실제82개였다. 반환 뒤 root 독립 snapshot은 agent final과 모든 captured field 일치, baseline과 raw88표90행·captured catalog/권한/defaults/ALWAYS6·stage/journal82·다른 연결0 일치다. HTTP event sequence만 정상적으로 (1,false)→(3,true), pg_sequences.last_value NULL→3으로 증가했고 reset하지 않았다. 전체 pg_catalog 검증으로 확대하지 않는다.

최초 root exclusivity guard는 Docker의 축약 ID를 full ID와 비교해 실패했으나 orchestration이 다음 readback을 시작했다. 나머지9 identity guard는 일치했다. `--no-trunc`를 사용한 수정 guard10개 모두 일치함을 확인하고, 이미 생성된 readback과 이 실패를 보존했다. 추가 SQL 반복·DB 변경은0이다. Allocation metadata의 created는 Docker state가 아니라 생성 완료 표시이며 생성 helper는 실제 docker run -d/Running=true를 확인한다. Agent의 빈 NODE_OPTIONS 가정 실패도 원환경 보존으로 정정했으며 SQL/test 전 중단이었다.

독립 확인 뒤 정상 STOP/exited0/OOMfalse를 확인하고 자기 container/volume만 삭제했다. 증거:

- `/tmp/nomorevibe-http-deadline-fix-final-report-20261016.md`, `...c-independent-review...md`
- `/tmp/nomorevibe-http-deadline-unread-final-report-20261016.md`, `...unread-final-manifest...json`
- `/tmp/nomorevibe-http-deadline-root-independent-proof-20261016.json`, `...root-docker-guard...json`, `...root-db-cleanup...json`

## 남은 확인

실행 환경은 Node24.18/Darwin arm64다. 공식 Node24.21의 관련6함수 byte 일치를 읽었지만 CI24.21/Linux의 실제 GC·내장 source·과거 실패 원인은 직접 관측하지 않았다. 이 로컬 회귀 통과를 CI hang 해결이나 운영 용량 증거로 해석하지 않는다. 변경을 인수한 새 head의 필수 CI 결과를 확인해야 하며 운영 배포·처리량2배 실측은 별도 남은 작업이다.
