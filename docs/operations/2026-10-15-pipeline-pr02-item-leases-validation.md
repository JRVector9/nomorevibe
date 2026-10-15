# PR02 개별 item lease 기반 검증 기록

## 목적과 현재 경계

승인된 파이프라인 설계의 stage별 개별 소유권 기반을 추가한다. 기본 `legacy`와 `writer_contract_version=0`을 유지하고 운영 consumer·provider·CLI 전환 경로는 연결하지 않는다. PR03/04에서 legacy claim/writer까지 통합하기 전에는 stage mode column만으로 기존 실행이 drain됐다고 볼 수 없다.

이 문서는 실제 실행한 검증과 아직 남은 검증을 구분해 기록한다. 실제 모델 30분 baseline·2배 성능·Oracle 인계는 이 PR의 검증 범위가 아니다.

## 병렬 담당과 검토

- schema/types: `pr01_final_ai1`, operations schema·0077 migration/journal·strict binding·단위 테스트.
- repository: `pr01_final_ai2`, 짧은 transaction API·stage/item 잠금·CAS·별도 실제 DB 회귀. 전용 DB 55466.
- 독립 DB 검증: `provider_contract_evidence`, 두 연결 경합·rollback·역할/job 비간섭. 전용 DB 55467.
- root: 공통 계약 고정, 파일 소유권 관리, 직접/교차 코드 리뷰, 최종 전체 검증·문서·Git·CI.

모든 서브에이전트는 `gpt-6.1-sol` / `xhigh`를 사용한다. Git과 공통 문서는 root가 관리한다.

## 고정 설계

- work key는 frontier/candidate/vote의 논리 ID이며 입력 hash가 바뀌어도 살아 있는 동일 작업 owner를 우회하지 않는다. strict binding과 hash에 현재 claim/input/source/policy/generation/model 식별자를 보존한다.
- stage `FOR SHARE` → 기존 domain 순서 → item advisory/row → jobs/outbox. 전환은 transaction 시작에서 stage `FOR UPDATE`를 잡으며 domain을 역으로 잠그지 않는다.
- 신규 row의 unique INSERT 대기를 막기 위해 namespace1485804의 nonblocking item advisory lock 이후 `FOR UPDATE SKIP LOCKED`를 사용한다. hash 충돌은 소유권 부여가 아닌 보수적 skip이다.
- expiry는 필요한 잠금을 얻은 뒤 DB wall clock으로 검사한다. renew 전 lease 객체도 token/epoch/owner/binding이 유지되면 사용할 수 있다. `leaseUntil`의 JS Date equality를 소유권 CAS로 사용하지 않는다.
- drain 진입은 epoch를 유지하고 신규 claim을 닫는다. items에서 진입한 drain은 기존 owner의 renew/저장을 허용한다. live item이 없는 정상 전환에서 epoch를 증가시킨다. TTL/epoch fence를 외부 호출 종료 증거로 취급하지 않는다.
- 결과·release·후속 `requestJob`은 같은 caller transaction에 넣는다. stale assert/release는 예외로 결과와 요청을 함께 rollback한다. generic repository는 domain 입력 신선도·사람 판단·모델 독립성 자체를 증명하지 않는다.

## 실제 실행 결과

- strict binding/owner/key/hash behavioral RED: 2026-10-15 22:35 KST, 6개 중 5 FAIL/1 PASS. 실행 가능한 skeleton이 잘못된 입력을 허용하고 key/hash를 만들지 못하는 assertion 실패를 확인했다. import 누락을 RED로 세지 않았다. 로그 `/tmp/nomorevibe-pr02-item-types-red-20261015.log`.
- 최종 담당 보고: strict binding 단위6, repository DB19, 독립 DB14 GREEN; 담당 tsc·관련 lint exit0. 담당 55466/55467은 자체 lease0·세 stage legacy/epoch1/계약0·자체 연결0을 확인하고 컨테이너를 중지했다.
- 실제 P1: commit된 Drizzle transaction 객체와 guard를 함께 재사용하면 autocommit item claim이 성공했다. 독립 actual RED1(`/tmp/nomorevibe-pr02-independent-guard-red-20261015.log`) 뒤 실제 xid를 guard에 결합해 기존 guard·종료 객체에서 다시 만든 guard의 claim을 모두 차단했다. 단순 JS 객체 identity를 DB transaction 생존 증거로 쓰지 않는다.
- 추가 actual RED→GREEN: 종료된 tx 객체의 control begin/complete, 최초 child savepoint에 귀속된 stage 잠금, parent item→child control의 실제 잠금 대기를 재현했다. stage 잠금 뒤 실제 full xid와 permanent xid lock context를 검사하고 control UPDATE에도 xid CAS를 유지한다. deny-only transaction-local GUC로 같은 native transaction의 다른 child adapter에서도 item→control 혼용을 UPDATE 전에 거절한다. GUC는 권한을 부여하지 않으며 trusted raw SQL 변조 방어를 주장하지 않는다. 로그 `/tmp/nomorevibe-pr02-repository-{nested-red,child-control-red,frozen-green}-20261015.log`.
- root fresh DB55468: fixture reset 전에 migration exit0, 세 stage `legacy/epoch1/contract0`, item0과 SQL column defaults를 직접 readback했다. `/tmp/nomorevibe-pr02-root-{migration,initial-defaults}-20261015.log`. 기존 job의 requested7/processed3/cursor page19/미래 not_before를 넣고 migration 재실행 exit0 뒤 동일값 보존을 SQL assertion으로 확인했으며 자체 sentinel만 삭제했다. `/tmp/nomorevibe-pr02-root-migration-rerun-20261015.log`.
- root 최종 소스 동결 뒤: 새 DB 테스트2파일33PASS(3.65초), 전체 단위277파일2,849PASS(8.10초), tsc exit0, 전체 lint exit0(기존 vendor 미사용 변수 warning1), i18n exit0, Python23PASS, build exit0(기존 dynamic filesystem warning1), bundle 주요3route 기준 이내, diff check PASS. 로그 `/tmp/nomorevibe-pr02-root-{target-final,unit-frozen,tsc-final,lint-final,build-final,bundle-final}-20261015.log`.
- root 첫 전체 integration은162파일 중161PASS, 1,777PASS/1FAIL/기존TODO1(364.05초)였다. 실패는 기존 `pipeline-replay-first-final` 첫 테스트의 domain assertion이 아닌 `replay-setup.ts:13 publicAcl` 연결 준비에서 `write CONNECT_TIMEOUT localhost:55468`이다. 새 전용55469에서 같은 case를 수정 없이 실행해1PASS/14skipped(2.45초)를 확인했다. timeout·assertion·source는 바꾸지 않고 새 DB 단독 결과와 전체 재확인 결과를 각각 기록했다. 정확한 연결 지연 원인은 확정하지 않는다. 첫 실패 로그와 재확인 결과를 함께 보존한다.
- 진단55469는 replay schema/role·연결·item0 및 세 stage legacy/epoch1/계약0을 확인한 뒤 자체 컨테이너만 중지했다. 운영 DB·CI·적용은 아직 완료로 세지 않는다.

PostgreSQL의 [subtransaction 설명](https://www.postgresql.org/docs/17/subxacts.html)과 [pg_locks 설명](https://www.postgresql.org/docs/17/view-pg-locks.html)을 확인했다. backend의 영구 xid 잠금과 자식 row lock의 실제 관측을 함께 사용하며, SDK의 nestedIndex만으로 savepoint 여부를 판정하지 않는다. 이 adapter 검사는 PG17 지원 범위로 검증하며 버전 변경 시 회귀를 다시 확인한다.

## 재현 명령

전용 localhost `nomorevibe_test`만 사용한다. 운영 DB 또는 다른 작업자의 DB를 가리키지 않는다.

```sh
npm test -- tests/pipeline-item-types.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55466/nomorevibe_test npm run test:integration -- tests/integration/item-leases-repository.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55467/nomorevibe_test npm run test:integration -- tests/integration/item-leases.test.ts
```

## root 코드 리뷰

두 차례 직접 읽기와 담당 간 교차 리뷰로 SQL parameter·schema/DDL 일치·owner/boot/token/epoch·binding·clock·동일 logical key·rollback·요청/cursor/pause 비간섭을 확인했다. 마지막 소스 기준 미해결 P1/P2는 발견하지 않았다. 전체 integration에서 발견한 fixture 격리 오류를 아래와 같이 보완하고 전체 PASS를 재확인했다.
기존 handler가 신규 repository를 import하는 경로가 없음을 `rg`로 확인했다. 모델·프롬프트·품질 gate·발행 동작 변경이 없어 모델 eval과 화면 QA는 해당하지 않는다.
설치된 ship skill의 review checklist 부속 파일이 없어 upstream `garrytan/gstack`의 blob `ca5bd7934f360e97024a1e921db455c4517e1e99`를 읽기 전용으로 받아 두 pass 검토에 사용했다. 저장소에 별도 VERSION/CHANGELOG/TODOS 관례 파일이 없어 새 체계를 만들지 않았다.

## 전체 실행에서 발견한 fixture 격리 오류

두 번째 전체 실행은161파일 PASS, 1,772PASS/6FAIL/기존TODO1(358.47초)이었다. 6개 모두 소유권 거절·rollback 검증은 통과한 뒤 전역 jobs 조회가 다른 파일의 행을 자기 fixture로 읽어 실패했다. 현재 작업 대상은 `crawl-fetch` 또는 `crawl-agent-review`인데 모든 jobs의 첫 행/개수를 검사한 것이 원인이었다. frontier readback도 실제 ID로 한정했다.

자체 DB55467에 unrelated job(req13/proc5/cursor page71/pause2101)을 남긴 같은14회귀에서 기존 조회가 actual6FAIL/8PASS(2.24초)→수정 뒤14PASS(2.22초)였다. 매 테스트 뒤 unrelated job 불변도 검증하고 afterAll에서 자체 sentinel만 삭제한다. cleanup을 전체 삭제로 넓히지 않았고 timeout·생산 코드·기존 기대값을 바꾸지 않았다. 로그 `/tmp/nomorevibe-pr02-independent-scopes-{red,green,tsc,lint}-20261015.log`.
root도 기존 다른 fixture가 남은55468에서 마지막 두 파일33PASS(3.34초)를 확인했다. 최종 전체 integration은162파일/1,778PASS/기존TODO1, 350.72초로 완료했다. 로그 `/tmp/nomorevibe-pr02-root-db-scoped-final-20261015.log`.

최종 readback: 세 stage legacy/epoch1/계약0, item0, replay schema/role/trigger0, 다른 DB 연결0, 자체 PR02 sentinel job0을 확인했다. 자체 root55468 컨테이너만 중지했다. 운영 DB/DDL·provider 호출·수동 배포·새 consumer 활성화는 수행하지 않았다.

## 원격 납품 확인 — 2026-10-16 KST

[PR435](https://github.com/JRVector9/nomorevibe/pull/435)는 exact head a7e85457b7bac53b60d780f987fce8e257d6c2d1 / 최신 base d95c6c8의 필수 CI 성공 뒤 정상 squash 병합했다(2026-10-15T15:06:10Z, main8f2bdb3e4f0b009500fd4724a6319cd61f6e6885). [PR CI38756321978](https://github.com/JRVector9/nomorevibe/actions/runs/38756321978) 및 [main CI38757351403](https://github.com/JRVector9/nomorevibe/actions/runs/38757351403) quality·integration3·check·main 웹/워커 image 모두 SUCCESS를 직접 확인했다. 운영 migration·수동 배포·consumer 활성화는 수행하지 않았다.
