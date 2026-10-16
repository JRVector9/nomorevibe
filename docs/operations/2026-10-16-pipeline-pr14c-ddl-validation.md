# PR14c 고정 DDL 구조 검증 — 2026-10-16

논리 복구 검증에 남은 CHECK·partial index·trigger WHEN의 표현 차이를 확인할 별도 검증기를 추가했다. 원본 46개 차이와 누락된 historical native context는 그대로 보존한다. 새 검증은 같은 새 PostgreSQL context에서 고정된 양쪽 exported DDL을 파싱한 구조만 비교하며 자동 DR을 허용하지 않는다.

새 파일은 `scripts/ops/oracle-dr/ddl_verification.py`, `ddl_probe.sql`, `tests/test_oracle_dr_ddl.py`다. Root가 Python/test 전체와 SQL builder/control을 읽고 원45쌍/20관계/전체209618bytes를 읽기 전용 재구성으로 확인했다. 기존2069 tracked 원문을 보존했고 B 독립 읽기 리뷰에서 발견한 두 P2를 최소 수정했다. 검증한 SQL bytes를 같은 실제 child 입력으로 유지하고, 오류 보고 저장 실패에도 원 SQL·observer 오류를 함께 보존한다. 새 unittest를 필수 CI에 명시했다.

## 실행한 범위

새 Python 파일의 offline23 PASS·scoped compile exit0, 두 리뷰 회귀는 각각 Assertion RED→같은1 GREEN, 인접2 controls PASS다. 최종25 전체는 반복하지 않았다. 원 raw JSONL을 읽는 실제 로컬 CLI는 46개 차이·설정 unsupported·historical unknown을 유지했다. 이 결과는 PostgreSQL native 실행 증거가 아니다.

Root 재구성 proof는 `/tmp/nomorevibe-pr14c-root-fixed-sql-conformance-20261016.json`, 소스 보호는 `...root-pre-db-source-proof...json`, B 독립 보고는 `...b-independent-review...md`, 담당 최종 보고/해시는 `...c-review-fixes-report...md`와 `...c-review-fixes-final-shas...json`에 보존했다.

첫 실제 localhost PG17.11 실행은 고정 probe의 child exit0, identity/context/45쌍/end 총48 frames, ROLLBACK·backend0이었다. 그러나 PostgreSQL의 OID JSON 값이 문자열이어서 엄격한 정수 reader가 `unknown: invalid_oid`로 거절했다. 비교 완료0이며 성공으로 세지 않았다. Root의 독립 readback에서 baseline=담당=Root의 raw97행·captured catalog·managed controls·36 sequences가 같았고 연결0을 확인한 뒤 전용 DB를 정상 종료·폐기했다. 내부 pg_class 전체는 이 inventory가 수집하지 않는다.

이 원결과를 보존하고 JSON 출력의 OID 값26개 고정 패턴·257개 위치에만 bigint 투영을 추가했다. 함수 인자 배열은 원 순서의 bigint[]로 출력하며 parser의 문자열 강제변환은 추가하지 않았다. 원90개 정의·20개 열 선언·45개 historical record는 byte exact다. Root가 새 builder의 읽기 전용 prefix로 SQL211676bytes 전체를 재구성했고 A 독립 리뷰의 추가 P1/P2는0이다. 신규 문자열 거절1+기존 정수·고정SQL control2가3 PASS, 범위 compile exit0이며 전체26개는 반복하지 않았다. 새 실제 실행은 별도 전용 DB에서 확인한다. 원48 frames와 unknown은 덮어쓰지 않는다.

## 고정된 실행 경계

실제 probe는 root가 배정한 새 localhost 전용 PG17.11에만 실행한다. strict Docker ID/name/image/scope/sole volume/loopback/memory와 source SHA를 먼저 확인한다. 고정된 historical column 선언으로 TEMP 관계20개에 원 정의90개를 재파싱하고 context·native node·metadata를 읽는다. SQL은 TEMP DDL을 포함하며 READ ONLY라고 표현하지 않는다. ROLLBACK·실제 child 종료·별도 backend0 관측이 필요하다. Artifact 파일만 읽으면 실행 provenance를 부여하지 않는다.

OID/type/typmod/cast/collation/상수 바이트/NULL/피연산자 순서·중복/OLD·NEW와 index·trigger metadata를 보존한다. 지원하지 않는 node/binding/context는 unknown이다. 원37 CHECK+7 partial index+1 trigger와 database setting1은 새 구조 비교와 별도로 남는다.

## 남은 운영 검증

`strictRestoreVerified=false`, `readiness=unknown`, `automaticDrAllowed=false`를 유지한다. Oracle ARM 운영·복제/promotion/fencing/RPO/RTO·같은 품질 두 배 처리량·최종 전체 수동 검증은 남는다. 운영 DB/SSH/provider/배포/활성화0이다.

## 수정 후 실제 실행

새55577 전용 PG17.11에서 초기 빈 상태 확인→기존87 migration→기준 상태 확인→고정 probe1→사후 readback을 순서대로 실행했다. 수정 후48 frames의 OID 값은 정수이며45쌍 전부 `exported_ddl_structural_match`다. 실제 child exit0·별도 backend0·ROLLBACK 뒤 probe 관계0을 확인했다. 이전55574의 문자열 OID `unknown` 결과는 별도 보존했다.

SQL 소유권 반환 후 Root가 같은 동결 helper로 독립 readback을 실행했다. baseline=담당=Root의 raw97행·captured catalog·managed controls·36 sequences가 byte exact이고 child·다른 연결0이다. source3는 그대로다. 전용 DB와 단독 volume을 정상 종료·폐기했다. `/tmp/nomorevibe-pr14c-root-numeric-final-db-proof-20261016.json` 및 `...pr14c-numeric-retry-root-cleanup...json`에 결과를 보존했다. 중간55576은 이름이 기존 guard에 맞지 않아 SQL0으로 폐기했고 guard를 완화하지 않았다.

이45쌍 일치는 같은 새 환경에서 exported DDL을 재파싱한 결과다. 원 historical bindings는 여전히 미수집이며 databaseSettings의 `jit=off` 차이는 unsupported·미복구다. 원46개 차이·`historicalEquivalenceProved=false`와 최상위 DR 차단 상태를 유지한다. 필수 자동 CI와 실제 Oracle 운영·최종 전체 수동 검증은 별도다.

## CI 타이밍 fixture 후속

PR479 최초 CI38905247443은 통합 세 묶음 모두 성공했으나 기존 native timeout prefire 검증의 GC가 76.759→108.648ms로 원100ms 창을 넘어 quality가 실패했다. 원 TimeoutError와 실제 child 종료는 정상이며 실패 로그를 보존했다. Child의 prefire GC 예약만75→0ms로 앞당겼다. 원100ms timeout·250ms 대기·postfire150ms·유효창 및 회귀 assertion·production fetch 원문은 유지했다. 첫 event-loop yield 뒤 실제 GC를 실행한다.

수정 후 원 실패 exact case 한 번은1 PASS/2skip(exit0)이다. 로컬 Darwin/Node24.18 결과이며 새 CI 성공을 대신하지 않는다. 원로그와 역치환 whole-byte proof는 `/tmp/nomorevibe-pr479-b-prefire-timer-final-proof-20261016.json`에 보존했다. 무변경 CI 재실행·성공 케이스 반복은 하지 않았다.
