# PR14a 논리 DR 카탈로그 관측 도구

이 도구는 명시한 PostgreSQL 17 DB의 카탈로그를 읽고 source/target 관측 파일을 비교한다.
모든 성공 보고도 `readiness: "unknown"`, `automaticDrAllowed: false`다. exit0은 수집/파일 비교의
완료만 뜻한다. dump·복원·publication/subscription·replication slot·설치·승격·사용자 데이터
쓰기 기능이 없으며 기존 worker/모델/HTTP permit을 활성화하지 않는다.

## 실행 범위

현재 확인은 root가 배정한 격리 local PG17 fixture다. 운영 source/Oracle target 수집·디스크
여유·성장률·보관 기간·RPO/RTO·복원·writer fencing·기존 외부 호출 종료는 미확인이다.
실행기 CPU architecture를 DB 서버/Oracle의 hardware 증거로 쓰지 않는다. source와 target은
각각 별도 수집 시각과 DB identity를 가지며 두 보고서가 같은 시점 snapshot이라는 보장은 없다.
client와 DB의 clock도 서로 동기화됐다고 가정하지 않으며 두 clock의 시각을 합쳐 latency나 clock bound를 인증하지 않는다.

도구는 Python3 표준 라이브러리와 명시한 `psql`을 사용한다. 패키지 설치·Docker 자동 발견·SSH·
배포 도구 호출은 하지 않는다. `--psql`을 생략하면 PATH의 psql만 사용하며 없으면 실패한다.
허용되지 않은 실행 대상에 접속하는 승인을 이 runbook으로 대신하지 않는다.

## 수집과 offline 비교

허가된 연결 URL은 입력 직전에 별도 비밀 입력 수단으로 준비한다. URL을 명령 인자나 로그에
쓰지 않고 stdin으로만 전달한다. 다음은 실행 형식이다. `ORACLE_DR_DATABASE_URL`은 도구가
자동 읽는 환경 변수가 아니다. 사용자가 명시적으로 stdin에 보낸 경우에만 사용한다.

```sh
printf '%s' "$ORACLE_DR_DATABASE_URL" | python3 scripts/ops/oracle-dr/preflight.py capture \
  --database-url-stdin --side source --label approved-local-source \
  --expect-database nomorevibe_test --expect-user nomorevibe > /tmp/pr14a-source.json
```

target은 별도로 허가된 연결과 `--side target --label approved-local-target`을 사용한다.
첫 수집 URL을 자동 재사용하지 않는다. 원격 수집은 이번 검증 범위가 아니다.

```sh
python3 scripts/ops/oracle-dr/preflight.py compare \
  --source /tmp/pr14a-source.json --target /tmp/pr14a-target.json
```

compare는 strict v1 JSON 두 파일만 읽으며 DB/psql을 열지 않는다. source/target의 label,
actual DB identity, 각각의 수집 시작·종료 시각, 미해결 findings를 보존한다. 관계는
`(schema,name)`으로 비교하고 서로 다른 cluster의 OID가 같아야 한다고 요구하지 않는다.
관측된 relation/column/index/sequence 설정과 extension version/schema 차이는 표시하지만
전체 schema/data 호환성 판정은 하지 않는다. 차이0도 자동 DR 허용으로 바뀌지 않는다.

URL은 postgres/postgresql URI, 단일 host와 명시 port·user·DB가 필요하다. 기대 DB/user와
일치해야 하며 query는 단일 `sslmode=disable|require|verify-ca|verify-full`만 허용한다.
libpq service/options/다중 host/환경의 production URL fallback은 없다. 비밀번호를 child
argv에 전달하지 않고 전용 child env의 PGDATABASE로만 전달한다. 이 도구는 DB credential
발급기나 최소권한 역할 설치기가 아니다.

## SQL과 단위

고정 `inventory.sql`만 `shell=False`로 실행한다. psql은 `-X`, `ON_ERROR_STOP=1`을 사용하고
READ ONLY REPEATABLE READ 안에서 transaction-local statement timeout5초/lock timeout1초를
설정한다. 마지막은 ROLLBACK이다. 설정은 현재 세션/TX에 한정되고 DB/role 기본값은 바꾸지 않는다.
전체 child 한도는15초이며 timeout 때 실제 local child를 kill→communicate→wait 후 반환한다.
이 local process 정산을 원격 query/외부 provider 종료 proof로 쓰지 않는다.

수집은 비시스템/non-temp schema의 r/p/f/v/m/S 관계 전체이며 LIMIT로 잘라내지 않는다.
schema·이름·OID·종류·persistence·replica identity·partition parent·extension 소속·RLS·관측
계정의 schema USAGE/table SELECT를 담는다. index의 primary/replident와 valid/ready/live,
key attr와 INCLUDE의 구별을 반영한다. 컬럼의 타입/typmod·nullability·identity/generated·
collation과 sequence의 고정 설정·a/i ownership을 수집한다. SQL의 OID는 bigint로 명시해
JSON numeric이 되게 한다. 문자열형 OID를 strict parser가 임의 coercion하지 않는다.

- table SELECT/USAGE는 이 role의 해당 권한 관측이며 publication/복원/승격 권한이 아니다.
- PK 없는 default/nothing/무효 selected identity는 UPDATE/DELETE identity 미확인으로 표시한다.
  FULL과 partition은 추가 검토 대상으로 남긴다. 전체 DDL/default/function/trigger body는 수집하지 않는다.
- sequence는 현재 last_value를 읽거나 nextval/setval로 변경하지 않는다. 숫자 설정은64bit 정밀도
  보존용 decimal 문자열이다. sequence 상태 동기화는 unknown이다.
- large object는 metadata count만 읽으며 내용/바이너리는 읽지 않는다. count0은 해당 snapshot의
  metadata 관측이고 권한 오류를0으로 바꾼 값이 아니다. LO 내용 복원은 확인하지 않았다.
- extension 이름/version은 installed catalog row다. ARM binary 설치/실제 load/호환 증거가 아니다.
- 사용자 행·subscription conninfo·foreign server options·role password·함수/기본값 원문을 읽지 않는다.

필요한 catalog 권한이 없거나 PG17/기대 identity/strict shape와 다르면 수집은 실패한다.
부분 empty를 정상 전체 보고로 출력하지 않는다. stderr/DSN/예외 원문을 출력하지 않고 고정
오류 code와 확보된 process exit만 반환한다. 실패 JSON도 readiness unknown/autoDRfalse이며 exit2다.
동일하게 보이는 보고 파일은 서명된 운영 인증서나 실제 DB 접근 권한이 아니다.

## 공식 PostgreSQL 17 근거

관계 종류/replica identity flag는 [pg_class](https://www.postgresql.org/docs/17/catalog-pg-class.html),
index 상태는 [pg_index](https://www.postgresql.org/docs/17/catalog-pg-index.html), 컬럼은
[pg_attribute](https://www.postgresql.org/docs/17/catalog-pg-attribute.html)를 따른다. reltuples 같은
추정값을 exact 사용자 행 수로 쓰지 않는다. [pg_depend](https://www.postgresql.org/docs/17/catalog-pg-depend.html)의
a/i/e dependency와 [pg_sequence](https://www.postgresql.org/docs/17/catalog-pg-sequence.html)의 설정,
[pg_extension](https://www.postgresql.org/docs/17/catalog-pg-extension.html)의 installed metadata를 구별한다.

[논리 복제 제약](https://www.postgresql.org/docs/17/logical-replication-restrictions.html)에 따라
DDL/sequence 상태/large object와 non-table 관계는 별도 후속이다. FULL/partition도 target 적용
조건을 확인해야 한다. [psql](https://www.postgresql.org/docs/17/app-psql.html)의 -X/ON_ERROR_STOP과
[BEGIN](https://www.postgresql.org/docs/17/sql-begin.html)의 read-only repeatable read를 사용한다.

## scoped 검증과 실제 확인 범위

```sh
python3 -m unittest discover -s tests -p test_oracle_dr_preflight.py -v
PYTHONPYCACHEPREFIX=/tmp/pr14a-pycache python3 -m py_compile \
  scripts/ops/oracle-dr/preflight.py scripts/ops/oracle-dr/report_contract.py tests/test_oracle_dr_preflight.py
```

기본 Python 검사는 offline pure/실제 local fake-psql process만 사용하고 actual DB case는 skip한다.
root가 별도 배정한 DB에서만 `ORACLE_DR_TEST_DATABASE_URL`과 `ORACLE_DR_TEST_PSQL`을 명시해
`-k OracleDrActualCatalogTests` 한 case를 실행한다. 이름 없는 기본 DB로 접속하는 경로는 없다.
fixture는 사전 부재인 pr14a_fixture schema에 한정하며 all actual process 정산 뒤 exact object를
NO CASCADE로 정리한다. 원본문/정리 오류가 함께 나면 ExceptionGroup으로 보존한다.

2026-10-16 격리 PG17 actual case는 PK+owned sequence/noPK/FULL/partition root·leaf/view와105개
tiny table을 포함한112개 자체 관계, 전체 카탈로그의 uncapped 관계 목록을 독립 SQL과 대조했다.
actual transaction은 readOnly/repeatable read였고 자체 sequence의 원값도 유지됐다. root 허용
exact-container adapter를 명시 `--psql` 경계에 사용했다. 이는 같은 PG의 카탈로그 SQL/process
검증이며 host-native psql/TCP URI 인증이나 Oracle ARM 수집 검증은 아니다. 새role/GRANT/extension/
LO data를 만들지 않았다. 첫 OID JSON형 거절과 최초 로컬 의존 누락 실패는 별도 원로그에 보존했다.
최종 scoped 결과·정확 SHA·raw/catalog 복구 증거는 /tmp 최종 보고서에서 root가 취합한다.

실제 source/Oracle target inventory, 크기·retention·논리 dump 복원, publication/DDL/sequence 재동기화,
독립 writer fencing·외부 call drain·수동 전환·RPO/RTO는 후속이다. 이번 도구가 이를 실행하거나
준비 완료로 표시하지 않는다. 수동 전체 테스트/build는 모든 PR 개발 후 최종 통합에서만 수행한다.

## Root 최종 인수와 setup 응답 실패 회귀

Root는 도구3파일·test·runbook 전체를 직접 검토했다. A 독립 리뷰는 production 추가 P1/P2=0,
actual fixture의 setup COMMIT 뒤 adapter 응답 실패 시 cleanup을 건너뛰는 P2=1을 발견했다.
Test helper가 사전 namespace 부재 확인 후 setup 전송 전에 attempt를 기록하고, 실패 후에도 실제
namespace owner·고정 전체 relation 이름/kind/owner·함수0을 대조한 뒤 원 NO CASCADE 정리를 한다.
Partial/unknown 구성은 DROP하지 않고 원 오류와 정리 오류를 함께 보존한다.

새 actual 회귀는 pass-through가 genuine COMMIT의 exit0을 받은 단1회만 exit86 ack로 바꾼다.
원 setup 오류 보존과 namespace0를 각각 요구한다. 기존 helper는 정상control1PASS+내부 AssertionError
(schema1!=0)를 보존한 ExceptionGroup ERROR1로 실패했고, 보강 후 같은2 PASS(2.233초)였다.
마지막 checkpoint 정적 catalog 투영만 보완한 뒤 새 회귀1 PASS(1.291초), scoped py_compile0을 확인했다.
기존 offline22·원 actual 업무 영역·새 RED/GREEN 본문은 byte exact이며 전체 검사를 반복하지 않았다.
이 회귀는 정산된 setup child의 nonzero 응답 실패이며 실제 원격 timeout/임의 concurrent namespace 교체를
시험한 것은 아니다. RED의 별도 recovery를 정상 fixture cleanup 성공으로 세지 않았다.

첫55548과 후속55550의 root 독립 readback은 각각 baseline 및 agent final과 raw87표8행/catalog·ACL·
함수/trigger/default/82journal exact, 자기 schema/function·다른 연결0이었다. 정상 STOP/exited0/OOMfalse
뒤 정확 자기 container/volume만 삭제했으며 두 DB는 retired다. Source/Oracle 운영 DB에 접속하지 않았다.
최종5파일 manifest와 실행 원문은 `/tmp/nomorevibe-pr14a-ack-c-final-report-20261016.md`,
root 원형 복구·정리는 `...pr14a-ack-root-independent-proof-20261016.json` 및
`...pr14a-ack-root-oracle-dr-cleanup-20261016.json`에 보존한다.
