# PR10c 사이트 근거 수집 역할 분리 검증

기존 crawler의 제품 전체 갱신에서 canonical website 수집을 versioned `site-evidence` 역할의 고정 `product-site-evidence-refresh` 잡으로 분리한다. 기본 legacy/disabled는 유지한다. 제품/GitHub/media/all-required 완료는 기존 제품 consumer가 계속 담당한다.

## 구현과 검토

A runtime13파일/B source8파일의 고유20파일을 root가 직접 읽고 C가 독립 읽기리뷰했다. 미해결 P1/P2는 없다. source-claims는 B동결본449ccf… 뒤 실제 역할 만료 재현에 따른 A최종9b0c114f…가 승인된 override다. 운영 권한·최초 canary·Oracle 기동은 이번 검증에 포함하지 않는다.

- 새 잡은 version1/60초의 site-only lane이며 기존 legacy5역할에 들어가지 않는다. direct/cron도 같은 admission 검사를 받는다. scheduler는 batch SHARE를 잡은 동일 TX에서 versioned contract1일 때만 새 due descriptor를 처리한다.
- claim은 batch→role→source control→domain→jobs 순서와 마지막 실제 role wall을 검사한다. transition은 batch UPDATE→source control UPDATE→roles/jobs→최종 DBwall/live source 순서이며 기존 renew/result의 역잠금과 건강한 원 owner 선점을 막는다.
- 원 owner의 renew/result/abandon은 모드 변경만으로 거절하지 않는다. 결과 저장은 원receipt/token/epoch/binding과 실제 원행의 raw expiry로 인증한다.
- 두 고정 wakeup을 이름순으로 모두 잠근 뒤 같은 domain TX에 기록한다. source/progress/outbox/clear/cursor 뒤 job·source wall/abort 오류는 전체 rollback한다.
- 실제 변경 facts의 positive 결과만 ACK evidence를 남긴다. capability와 별도 후행 domain readback이 없으면 ready=false다. test의 operator seed는 운영 canary가 아니다.

## 실제 실행한 변경 범위 검사

| 검사 | 실제 결과 |
| --- | --- |
| 새 runtime baseline | 9 Assertion FAIL/41 PASS, exit1 |
| runtime4파일 | 52 PASS, exit0/448ms |
| source-control transition 추가 경계 | 1 Assertion RED+control1 → 동일2 GREEN |
| 마지막 신규 runtime파일 | 10 PASS, exit0/480ms; 위52와 중복 합산하지 않음 |
| 실제 site role의 source-control 대기 중 만료 | 정상1PASS/만료1AssertionFAIL → 같은2PASS/8skip, exit0/1.21s |
| 나머지 신규 실제 DB8개 | 8PASS/2skip, exit0/2.24s |
| B source 단위 경계 | 16AssertionRED+legacycontrol1 → 동일17PASS/564ms |
| B 관련4파일 | 72PASS/674ms;17과 중복 합산하지 않음 |
| A/B scoped 타입·lint | 각각exit0; A lint 기존 `_hash` warning1 |

새 actual10개는 역할 만료2+나머지8의 **분리 실행**이다. 하나의 전체 suite 실행이라고 기록하지 않는다. 실제 DB role/job/source/progress/ACK/readback과 두 번째 outbox의 오류·자연 wall-expiry rollback을 검증했고 외부 canonical HTTP 함수 경계만 mock했다. 원 제품 consumer의 versioned genuine crawler-role 양성 전체 경로는 별도 미실행이다.

명령은 `npx vitest run tests/job-catalog.test.ts tests/job-batches.test.ts tests/worker-runtime.test.ts tests/site-evidence-runtime.test.ts`, 신규 runtime파일 단독, `TEST_DATABASE_URL=<전용55532> npx vitest run --config vitest.integration.config.ts tests/integration/site-evidence-job.test.ts -t 'new source claim checks'` 및 동일 driver의 나머지8 필터였다. 전체 unit/전체 DB/종합 build는 실행하지 않았고 모든 PR 개발이 끝난 최종 통합 단계로 남긴다. 필수 자동 CI는 유지한다.

초기 tsc의 없는 next-env 입력, catalog의 aggregate 함수 pg_get_functiondef, fixture timestamp timezone 오류는 setup/진단 실패로 원로그를 남겼으며 기능 RED에 포함하지 않았다. 시간제한/TTL/기대/권한 완화는 없다.

## root 인수·데이터 복원

root가 source20의 동결 hash와 actual405행 driver를 직접 검토했다. 새 DB55532의 public89테이블/9행 raw와 캡처한 relations ACL/role/default/function/trigger catalog가 원형과 일치했다. migration83 및 마지막0080/81/82의 hash/time을 독립 조회했고 다른 client는0이었다. fresh DB의 foreign업무행은0이어서 nonempty foreign µs 복원 물리실험으로 확대하지 않는다. ACL normalization DML은0이다.

정상STOP/exited0/OOMfalse를 확인하고 정확한 자기 container/volume만 삭제했다. 55532는 retired이며 재접속하지 않는다.

인수 증거: `/tmp/nomorevibe-pr10c-a-final-report-20261016.md`, `...pr10c-b-final-report...md`, `...pr10c-c-readonly-review...md`, `...pr10c-root-independent-readback-proof...json`, `...pr10c-root-site-cleanup...json`. A13/B8 SHA manifest와 별도 role override patch/원 RED·GREEN 로그를 보존했다. Git 제출·CI·운영 적용은 별도 기록한다.
