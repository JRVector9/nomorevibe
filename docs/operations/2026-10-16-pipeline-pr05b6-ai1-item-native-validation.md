# PR05b6 AI1 소비자의 모델 예약·호출·정산 검증

AI1 독립 소비자가 기존 모델 용량 예약, 실제 fresh attempt와 item claim, native 호출, 과거 물리 완료 정산, 기존 결과 writer를 연결한다. 운영 serving resolver는 계속 null이며 운영 활성화·동일 품질 처리량 2배는 아직 검증하지 않았다.

## 구현과 보존 경계

- 기존 AI1 queue/private lock을 재사용하고 logical key `ai1:<candidate>`를 유지한다. 새 boot·입력 변경이나 기존 unbound 미정산 호출이 실제 진행 호출의 비용 한도를 우회하지 못한다.
- 0086은 기존 0085 CHECK 원문을 보존하며 고정 AI1 item binding·terminal 분기와 실제 claim 중복 방지 index를 추가한다. 0084/85, 기존 index·논리 fence·권한·ALWAYS trigger는 보존한다. Journal는 87개다.
- Native prepared 객체의 원 input JSON 순서·wire·model·serving contract·C를 보존한다. 원 prepared 객체와 native 호출의 private one-use 상태를 공유하고, 고정 parser가 확인한 완료만 별도 opaque terminal을 발급한다. EOF·취소는 full-C 미정산으로 남는다.
- Runtime은 control UPDATE→request UPDATE→S3/domain→실제 attempt/item→예약·항목 DB wall 검사를 같은 transaction에서 수행한다. Commit 확인 뒤 POST 한 번, 물리 정산과 진행 중 renewal을 기다린 뒤 기존 결과 writer를 사용한다. 기존 AI1 실패 backoff·MAX3·사람 판단 보호를 유지한다.
- 기존 source 함수와 564개 원 테스트는 보호한다. B가 소유한 native test 한 파일은 원 221행 전체를 보존한 append만 허용한다. 새 ledger/runtime 실제 DB 회귀는 기존 파일과 다른 새 경로에 둔다.

## 실행한 변경 범위 검증

| 범위 | 실제 결과 | 한계 |
| --- | --- | --- |
| Ledger unit | 신규24 PASS·기존 AI2 exact1 PASS | Repository/native verifier mock 포함 |
| Native | 신규18+기존 exact2=20 PASS, AI2 brand exact1 PASS | Localhost, 실 provider 없음 |
| Runtime unit | 원21 PASS·기존 영향37 PASS | 담당 실행; renewal은 fake timer |
| 실패 결과+renew 오류 보존 | 신규1 Assertion RED→같은1 PASS·기존 관련2 PASS | 원 실패와 renewal 오류 identity, 원 thrownError 우선순위 보존 |
| Ledger 실제 PG17 | 최초1회 서로 다른6개 모두 PASS, tests1.15초/총1.76초 | Generic item adapter/synthetic candidate·attempt, domain writer 증명은 runtime 별도 |
| Runtime 실제 PG17 | 서로 다른8개 PASS: 2개 RED→동일2개 GREEN, 나머지6 최초 PASS | Localhost PG17·실 provider/자연시간 renewal 검증 아님 |
| 범위 TypeScript·ESLint | 담당 agent 실제 exit0 | 수동 전체 테스트·전체 build/tsc 미실행 |

Root는 ledger7의 전체 소스·SQL·새 unit 및 344행 실제 driver, native append 전체와 독립 리뷰 원문을 읽었다. SQL/Drizzle literal 재조립, 세 소스 inverse·0084/85 whole bytes·journal append와 원563 테스트 보호를 독립 실행으로 확인했다. Source/driver 단위의 shape 일치를 운영 권한이나 실제 remote provider 종료 증명으로 사용하지 않는다.

Root는 전용55570의 정확 컨테이너·단독 볼륨·이미지·localhost·메모리·dummy 자격과 소스 SHA 14개 guard를 확인한 뒤 독립 READ ONLY REPEATABLE READ를 실행했다. Baseline=agent=root 91표/97행(공개90표10행+drizzle journal87), captured catalog·권한·roles·함수·trigger·default·원 stage 시각이 동일했고 타 연결은 0이었다. Agent/root sequence도 동일하며 event1→31, ordinal1→11의 정상 증가만 보존하고 reset하지 않았다. 정상 STOP/exited0/OOMfalse 뒤 해당 컨테이너와 볼륨만 제거했다. `/tmp/nomorevibe-pr05b6-c-root-independent-proof-20261016.json`, `...c-root-db-cleanup...json`.

## 발견한 문제와 남은 실제 검증

1. Native 실패 결과가 반환된 뒤 소유권 renewal 오류까지 발생하면 원 결과가 유실됐다. 새 fake15s 회귀의 실제 Assertion RED를 확인하고 두 원 객체를 AggregateError로 보존했다. 원 성공 결과의 renewal 오류와 native thrownError 우선순위는 기존 관련2개로 확인했다. Root 및 B 독립 읽기 추가 P1/P2=0이다.
2. Null serving 거절 전에 새 intent를 생성해 direct claim의 기존 거절 이유가 달라졌다. 실제 case1 Assertion RED 후 기존 null-serving 거절 뒤로 두 줄을 이동했고 같은 사례1 PASS/7 skip(tests932ms/총1.62초)를 확인했다.
3. Reserved re-entry에서 현재 firstReviewer의 provider/model 대조가 빠졌다. 같은 정책의 합법 A/B 두 route로 case3 Assertion RED를 확인하고 현재 설정과의 대조만 추가해 같은 사례1 PASS/7 skip(tests772ms/총1.52초)를 확인했다. 실제 attempt/item/dispatch/POST가 0이고 쓰지 않은 예약은 회수된다. JSON intent 자체는 권한이 아니다.
4. Root 공백 검사에서 caprepo 마지막 빈 줄1개를 발견했다. Ledger 실제 검증·DB 반환 후 해당 빈 줄만 제거했고 역변환·해당 ESLint·공백 검사 exit0을 확인했다. 의미 있는 소스/회귀/SQL 변경은 없어 DB 사례를 반복하지 않았다.

Runtime 새436행8사례를 root와 B가 전체 읽었다. 위 두 사례를 각각 닫은 후 미실행6만 최초 실행해 6 PASS/2 skip(tests2.64초/총3.36초/exit0)를 확인했다. 총8개의 서로 다른 성공 사례이며 전체8 반복은 없다. 실제 fresh attempt/item→commit 후 POST1→정산→원 writer/outbox, EOF 미정산/기존 backoff와 새 boot fence, 늦은 사람 판단 보호, 실제 후보 행 잠금 대기 중 예약 만료의 전체 rollback, own event INSERT fault rollback/POST0, item release·mode/epoch/policy 변경 뒤 과거 opaque 완료의 idempotent 정산을 검증했다. C가 두 source 보완을 독립 읽어 추가 P1/P2=0을 보고했고 root가 원문을 읽었다. 운영 DB·운영 migration·SSH·실 provider 호출은 이번 단계에서 실행하지 않는다. 실제15초 renewal 장기 관측·실 serving hard-C/물리 종료·전 text caller·서버 공통 예산·Oracle 운영/DR·동일 품질 2배는 남는다. 수동 전체 테스트는 모든 PR 개발 뒤다.

## 증거

- Root 사전 source/DDL 검증: `/tmp/nomorevibe-pr05b6-root-ledger-pre-db-proof-20261016.json`, `...root-runtime-pre-db-proof...json`.
- 담당 최종 manifest: `/tmp/nomorevibe-pr05b6-{c-ledger-final-shas,b-native-final-shas,a-runtime-final-shas}-20261016.json`. Runtime5는 실제 두 경계 수정 뒤의 최종 SHA다.
- Ledger 실제 원로그·exit: `/tmp/nomorevibe-pr05b6-c-db-actual-first6-20261016.log`, `...first6-20261016.exit`.
- 독립 리뷰: B ledger/runtime 및 renewal 보완, C native. 원문은 각 담당 `/tmp` 보고서에 보존한다.

## Runtime 독립 DB 확인과 CI 편성

Root는55571의 최종 source14 SHA·정확 컨테이너/이미지/단독 볼륨/localhost/메모리 guard actual0 뒤 독립 READ ONLY REPEATABLE READ로 baseline=agent=root raw91표97행, captured 정의·ACL·roles·함수·trigger·default·stage/journal87 및 agent=root sequence/타연결0을 확인했다. Full pg_class 비교는 false다. Baseline 대비11관계, agent 대비9관계에서 pages/tuples와 pipeline_item_leases.relfrozenxid753→950이 달랐다. 최초 whole-physical equality comparator 실패와 원 delta를 보존했으며 물리 변화 원인은 직접 관측하지 않았다. 정상 sequence 증가는 보존하고 reset0이다. 정상 STOP/exited0/OOMfalse 후 해당 컨테이너와 볼륨만 제거했다. 증거는 `/tmp/nomorevibe-pr05b6-root-runtime-independent-proof-20261016.json`, `...root-runtime-{agent,baseline}-physical-delta...json`, `...pr05b6-ai1-runtime-root-cleanup...json`이다.

Root가 CI 목록 확인 명령의 optional `--json` 인자를 잘못 배치해 test4개가 filesOnly JSON으로 덮인 오류가 있었다. 테스트 본문·SQL 실행은 없었다. Raw4와 원 명령/실패 guard를 보존하고 신규436은 고정 사본, 원3개는 실제HEAD 원문으로 복원했다. Source14 및 원563개 보호 SHA를 다시 대조했다. 이는 이미 끝난 actual 검증과 별도 명령 오류이며 테스트 반복으로 지우지 않았다. `/tmp/nomorevibe-pr05b6-root-ci-json-path-error-20261016/restoration-proof.json`.

설치 Vitest4.1.11 구현에서 optional JSON 출력경로를 확인한 후, 명시 `--json=/tmp/...json`으로 filesOnly 목록6개를 새로 얻었다(각 exit0). 설치 BaseSequencer와 workflow 원문 inverse로 **207파일=고립4+공유68/68/67**, 모든 이전205개와 신규2개가 정확히 한 번 편성됨을 확인했다. 고립 실행 순서는 AI1 native→AI2 native→AI2 consumer→AI1 consumer다. Source14·기존563 SHA는 목록 전후 동일하다. 이 검사는 파일 발견/CI 편성 검증이며 실제 CI나 테스트 본문 PASS가 아니다. `/tmp/nomorevibe-pr05b6-root-ci-coverage-20261016.json`.
