# PR10b 서버별 DB client quota 실제 연결 — 2026-10-16

기존 선언용 host budget을 실제 primary/READ client factory와 부모·자식 entry에 연결했다.
Production은 `lib/db/{host-budget,pool,index}.ts`와 role-worker/worker-supervisor/worker/scheduler 7파일이다.
기존 test4와 신규 integration1을 포함하며 새 migration/권한/운영 설정은 없다.

`HOST_DB_BUDGET` 부재 또는 strict disabled는 기존 pool 옵션과 동작을 보존한다. Enabled는 UTF8 16KiB 이하
단일 strict JSON `{mode:"enabled",policy,process}`이며 runtime overrides는 받지 않는다. 실제 WORKER_ROLE,
PHYSICAL_HOST, RELEASE_TAG와 process/policy host·release·role·kind·replica·copy를 대조한다. 알려진 네 entry는
첫 DB/heartbeat/spawn 전에 검사하며 supervisor는 같은 identity에서 child kind만 바꾼다.

`dbPoolConfig(env,purpose)`와 `createDbClient(url,config?,purpose)`는 primary/read를 구분한다. 명시 max가 없으면
선언 quota를 쓰고, ENV/명시 config max가 quota 초과 또는 양의 safe integer가 아니면 driver 생성 전에 거절한다.
READ는 별도 readMax로 검사하고 nonweb/read0을 거절한다. 기존 2인자 호출·deadline/queue 취소/SQL 동작은 유지한다.
설정은 process startup 계약이며 기존 singleton hot reconfigure는 지원하지 않는다.

## 실제 범위 검증

| 검증 | 실제 결과와 범위 |
| --- | --- |
| 원 public API/mock postgres 생성 경계 | 원 4 AssertionFAIL/4 controls → 같은 8PASS. Actual PG RED가 아니다 |
| 누락된 explicit max | 추가 1 AssertionRED → 같은 1PASS; 최종 factory 파일 18PASS/444ms |
| 관련 pure/runtime 7파일 | 92PASS/2.11s, 후속 missing-max patch 전 기록. 최종 전체 반복0 |
| 실제 supervisor spawn 조립 | 신규2 포함 파일15PASS. Child process는 mock이며 실제 child factory는 아래 별도 검증 |
| Native Node+실제 PG3 | 3PASS/tests516ms/총945ms. Quota1 대기 INSERT/BEGIN DB_POOL_WAIT_TIMEOUT·callback0·TEMP행0·TX재사용9, disabled 원2arg control, derivedchild max3/SELECT7 |
| B 최종 scoped TypeScript/ESLint | 각각 실제 exit0. Whole tsc/typegen/build0 |
| C 발견 fixture 종료 P2 | 같은 AST driver/실제 TERM무시 child2: 원 2AssertionRED → 같은 2PASS. 아래 별도 범위 |
| C 변경 두 test scoped TypeScript/ESLint | 각각 실제 exit0/0byte. DB/기존 actual3 재실행0 |

원 caller tests69개 callback, pure resolver, 기존 deadline adapter/factory business suffix를 byte/AST로 대조했다.
Root가 production7과 test5 전체 diff·정산 보완을 직접 읽었고 C 독립 최초 리뷰는 production P1/P2=0,
fixture P2=1을 반환했다. 보완 뒤 A 최종 독립 읽기 리뷰도 추가 P1/P2=0이다. Root가 해당 보고를 완독했다.

## Fixture child 정산 보완

원 unit spawner는 TERM만 보낸 뒤 close를 기다려 finally의 KILL에 도달하지 못할 수 있었고, integration
spawner는 검증 대상 pool 취소가 고장나면 holder/query 교착의 child close를 제한 없이 기다릴 수 있었다.
두 test-local helper에 원 await 전 독립 TERM→KILL timer(unit4→5초/integration15→16초)를 설치했다.
원 결과/오류와 actual close를 분리하고 active registry는 close까지 보존한다. Kill을 성공으로 바꾸지 않는다.

/tmp 고정 driver가 원 helper 선언만 AST로 추출해 실제 native child를 실행했다. 동일 SHA driver에서 원래는
외부 watchdog이6.509/17.509초에 자기 child를 KILL해야 했고, 보완 뒤 helper가5.011/16.009초에 KILL/actualclose했다.
Watchdog0/active0/기록 child잔류0이다. DB factory 동작을 증명한 시험과 구분한다. Helper 밖 전체 bytes와
production7/다른test3/nativeProbe/원3it/SQL/case20s·hook60s는 동일하다. 새 framework/export는 없다.

## DB 독립 readback·정리

새 전용55552만 사용했고 migration/영구DDL·DML0, TEMP만 사용했다. Public table0/stage·journal absent이므로
이 시험은 앱 schema 권한·실제 job/heartbeat 경합의 증거가 아니다. Root가 exact container identity를 직접 확인하고
동일 readback을 독립 실행해 agent final 및 stable public raw/catalog/roles/ACL/default와 baseline exact를 확인했다.
TEMP 사용으로 pg_temp namespace metadata0→4 차이는 남아 whole catalog exact=false다. 정규화/DROP0,
잔류 TEMP relation0/타연결0 뒤 정상STOP/exited0/OOMfalse로 자기 container/volume만 정리했다. **55552는 retired**다.

## 미완료 경계와 기록

Trusted 환경 선언은 물리 host/process 독점 증거가 아니다. 중복 replica/copy/다수 factory/alternate endpoint,
host 전체 합계·PgBouncer/backend·READ cluster 상한·실제 heartbeat SLA·번역 physical1·Oracle 운영 활성은 미확인이다.
Pure 결과는 enforcement unknown/readyfalse/activationAllowedfalse를 유지한다. Preflight/migration은 catalog reserve만이며
DbRole 일반 factory 미지원으로 fail closed다. 별도 migration direct client나 preflight consumer를 연결 완료로 쓰지 않는다.

원 보고 `/tmp/nomorevibe-pr10b-host-runtime-final-report-20261016.md`, C독립 리뷰와 child-drain final report/conformance,
root `/tmp/nomorevibe-pr10b-host-runtime-root-independent-proof-20261016.json`,
`...pr10b-host-runtime-root-db-cleanup...json`에 실제 명령·exit·실패 접근·범위별 SHA를 보존했다.
첫 READ 오류 우선순위/JSON 순서 assertion/scoped type 진단 및 C 첫 driver 전제 오류는 기능RED와 구분했다.
수동 전체 unit/DB/build는 모든 PR 개발 뒤이며, 이 PR에서 운영DB/DDL/배포/SSH/실모델/consumer를 실행하지 않았다.

## CI Next.js ambient environment type follow-up

PR470 CI38866821534 quality failed with TS2741: the helper accepted a partial environment but promised NodeJS.ProcessEnv, whose Next.js global augmentation requires NODE_ENV. The exact one error was independently reproduced with a scoped TypeScript configuration including the installed Next global declaration, helper, supervisor and existing host-budget test. No whole typegen/build/suite was run manually.

Two overloads now distinguish a complete NodeJS.ProcessEnv input (preserving its complete return type) from a partial record input. Runtime environment cloning is unchanged. The first Omit-based generic attempt failed scoped compilation because ProcessEnv's string index loses the declared NODE_ENV property through Omit; its failure log is preserved and excluded from GREEN. Final same scoped compilation and ESLint exit0, emitted JavaScript before/after byte-exact. No fake NODE_ENV value or cast was introduced.

Evidence: /tmp/nomorevibe-pr470-root-ci38866821534-quality-20261016.log, /tmp/nomorevibe-pr470-root-nodeenv-red-20261016.log, /tmp/nomorevibe-pr470-root-nodeenv-omit-attempt-20261016.log, /tmp/nomorevibe-pr470-root-nodeenv-final-green-20261016.log, /tmp/nomorevibe-pr470-root-nodeenv-runtime-conformance-20261016.json. New mandatory CI remains pending at the corrected head.

## Latest item-consumer parent integration (2026-10-16 12:16 UTC)

Root prepared a normal merge of PR477/db4e061de821df80de65dd413ccf970146c6faa0 into PR470/63d645ed. The seven production files match Git's three-way merge result exactly. Only the shared handoff and supervisor-test imports/mock had conflicts. The complete latest supervisor test body remains byte-exact; the two incoming host tests use its existing mocked spawn.

The merged supervisor file passed 19 cases. Scoped TypeScript exposed a test-only TS2345 because the typed spawn mock rejected the former partial EventEmitter fixture. Root preserved that failure and replaced only the new host fixture with an unspawned real ChildProcess, removing the unused EventEmitter import. The two affected host cases then passed (17 skipped), scoped TypeScript and ESLint exited 0. No new DB/native PG run or manual whole suite was performed. Original host PG proof and retired55552 remain as recorded above. Latest base's other2054 tracked files were byte-exact.

Exact logs and final source hashes: `/tmp/nomorevibe-pr470-root-latest-{source-protection,supervisor,tsc,tsc-green,host-tests-green,eslint,eslint-test-green}-20261016.*`. B independently read the entire production7/test5 delta and surrounding consumer-health/pool code, confirmed all12 hashes and inverse/base preservation, and reported additional P1/P2=0. Review `/tmp/nomorevibe-pr470-b-latest-parent-independent-review-20261016.md`. New CI is pending at this writing; no merge to main, deploy, or activation is claimed.
