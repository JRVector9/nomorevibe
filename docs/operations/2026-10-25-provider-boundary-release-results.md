# Provider 경계 종료 단건 회수: 구현·검증과 운영 순서

2026-10-25 KST. 기준 main은 `b4647e806def7a914789e8eb3f362ac1325ea9ee`다. 이 변경은 운영 요청의 물리 점유만 정직하게 끝낼 수 있는 수동 경로를 추가한다. 구현 중 운영 DB 변경·모델 HTTP 호출·프로세스 종료·배포는 모두 0이다. 아래 PostgreSQL 행과 종료 receipt는 명시적인 격리 테스트 fixture이며 실제 native 종료 증거가 아니다.

## 실제 장애와 증거 한계

실제 요청 `2bfed63a-42d5-4255-ae42-e7c61543a104`는 `ai2-consumer-m3` boot `3f4fd03e-c759-4514-baf3-183bb7cd5044`가 Supa budget `abcllm-supa`로 보낸 `ai2_item_gateway`다. dispatch는 2026-10-24 17:49:27.596Z, transport unknown은 17:50:28.070Z이며 원래 terminal과 hash는 없다. 실제 second review는 timeout이었다. 같은 시각대 사용량 1건과 idle metrics에는 요청 UUID가 없어 동일 요청의 원격 종료를 소급 증명할 수 없다.

당시 `MODEL_CAPACITY_LOCAL_END`와 `PROCESS_GROUP_RECORDING`은 미설정이었다. 해당 boot의 process event와 `dispatch_local_ended`도 없으므로 기존 세 release 종류를 사용할 근거가 없다. gateway의 non-stream 응답은 upstream 전체를 buffer하며 이 client timeout에 대한 upstream 종료 증거를 남기지 않는다. httpx read timeout은 전체 실행 hard deadline이 아니다. 이 사실은 사업 결과 실패와 물리 점유 종료를 구분해야 하는 이유다.

## 새 경로의 범위

- `provider_boundary_exit`는 기존 indeterminate 한 행을 withdrawn으로 바꾼다. `settled_at`, 사용량, 모델 verdict, 업무 결과는 생성하지 않는다.
- 실제 owner old incarnation 종료 후 두 gateway old incarnation을 종료하고, 마지막으로 Supa old engine 전체 process tree가 종료됐음을 privileged operator가 관측한다. ingress와 auto-restart를 닫고 replacement 0도 확인한다. 각 layer의 host boot, service revision, incarnation, PID/start ticks, PID namespace, cgroup, 시작 시각을 plan에 고정한다.
- Linux systemd/cgroup 경로는 old PID 부재와 cgroup populated false·빈 PID 목록을 관측한다. Docker private PID namespace 경로는 host/container 공유 PID 모드를 거절하며, 사전 namespace PID1 identity와 실제 Docker wait exit를 사용한다. exact old CID가 제거됐으면 `containerStatus=removed`로 기록하며 관측하지 않은 cgroup empty를 만들지 않는다. namespace init 종료 시 전체 namespace가 종료되고 다시 process를 만들 수 없다는 근거는 [Linux pid_namespaces(7)](https://kernel.googlesource.com/pub/scm/docs/man-pages/man-pages/+/refs/tags/man-pages-6.04.01/man7/pid_namespaces.7)다.
- hash와 strict JSON은 검토한 실제 관측 bytes를 묶는다. 그것만으로 물리 종료 권한이 생기지 않는다. 운영자가 실제 원문과 장비 identity를 검토하는 trust boundary를 유지한다.
- plan은 요청 owner/token SHA/epoch/revision/policy/binding/dispatch/budget/group/serving contract와 draining control의 정확한 UTC 소수 6자리 `updated_at`을 고정한다. 후자는 같은 revision으로 open→draining이 돌아오는 ABA도 거절한다. 감사행 commit 시각을 control 갱신 시각 대신 쓰지 않는다.
- 기존 hook의 fence → control → request lock 순서와 DB trigger가 함께 검사한다. 임의 direct SQL은 지원 실행 경로가 아니다. direct INSERT와 이미 회수한 행의 NULL/다른 kind/상태 역전·수정을 거절한다. 같은 원문·operator·reference의 재호출은 추가 event/audit 없이 `already_released`, 다른 값은 충돌이다. 실제 one-shot 운영에서 맹목적인 재실행은 하지 않는다.
- provider receipt 5분, plan 30분과 DB evaluatedAt 30초 제한은 추가 freshness guard다. 시간 경과나 TTL이 물리 종료 증거를 대신하지 않는다. control/fence가 바뀌면 새 exact plan 검토가 필요하다.

새 boundary 전용 `providerBoundaryCanonicalHash`는 recursive ASCII key 정렬·compact UTF-8 JSON SHA256이다. plan hash, 새 evidence hash, SQL C 정렬 및 Python `json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)`가 같다. `startedAt`/`startTicks`를 포함한 고정 plan fixture SHA는 `d6984a8aeacca0da1b575aeecd047d1707cf36edcf12547abd607b1f7c9ca487`다. 기존 전역 `reviewHash`와 이전 세 evidence 종류의 해시는 변경하지 않았다.

## Migration과 구 앱 호환성

`drizzle/0126_provider_boundary_release.sql`은 journal index126, 전체 127번째 migration이다. 기존 requests logical/members/dispatch/terminal 및 events kind CHECK 전체를 왼쪽에 보존한다. 새 branch도 이전 logical/members/dispatch 원문 술어 전체를 indeterminate/terminal-null 형태로 다시 검사한다. binding/charged C/member key 제약을 단순 OR로 우회하지 않는다. 새 terminal hash는 SQL canonical SHA와 정확히 일치해야 한다.

실제 기존 배포 e0ef의 `pipeline-observation-repository.ts`, `pipeline-control-status.ts`, `pipeline-capacity-live-repository.ts`, `pipeline-capacity-budget.ts`는 이 branch와 byte 동일하다. pending/점유 쿼리는 waiting/reserved/dispatched/indeterminate만 읽는다. 사용량은 settled와 upstream_reported일 때만 읽고 `dispatch_released`는 이미 exit event다. 격리 DB에서 새 withdrawn 행이 pending=false, usage=null로 읽히는 것도 확인했다. 기존 앱의 terminal schema로 새 evidence를 정산하는 경로는 사용하지 않는다.

## 실제 실행한 검증

```sh
npx next typegen
npx tsc --noEmit --incremental false
npx vitest run tests/provider-boundary-release.test.ts tests/provider-boundary-cli.test.ts tests/dr-reclaim.test.ts tests/dr-reclaim-outside.test.ts tests/dr-process-owner-wiring.test.ts tests/model-capacity-ai2-terminal.test.ts
TEST_DATABASE_URL=postgresql://postgres:boundary-test-only@127.0.0.1:32781/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/provider-boundary-release.test.ts tests/integration/publication-classify-capacity.test.ts tests/integration/model-capacity-ai2-terminal.test.ts
npx eslint lib/llm/provider-boundary-contract.ts lib/llm/capacity.ts lib/llm/capacity-repository.ts lib/operations/dr/provider-boundary-release.ts scripts/ops/model-provider-boundary-release.ts tests/fixtures/provider-boundary-release.ts tests/provider-boundary-release.test.ts tests/provider-boundary-cli.test.ts tests/integration/provider-boundary-release.test.ts lib/db/operations-schema.ts
git diff --check
```

범위 unit 6파일 44건, 통합 3파일 33건을 실제 실행해 통과했다. 통합은 새 PG17/pgvector master에 127개 migration을 적용하며, 별도 side DB에 0125까지 적용한 뒤 기존 valid indeterminate·waiting 행을 넣고 0126을 적용한다. 기존 행 전체와 모든 CHECK validated 상태를 보존했다. exact 1행 withdrawn/event/audit, dry-run rollback, audit insert 실패 시 전체 rollback, 틀린 request tuple/control US/순서/누락/NULL/hash/fence/open, 직접 INSERT·charge 변경·오래된 증거의 evaluatedAt 소급·종료 역전 거절을 확인했다. 실제 publication/native child fixture와 AI2 정산 회귀도 포함한다. tsc/lint/diff check는 exit0이다. Vite의 기존 CJS/ESM config 경고는 있었으며 테스트 실패는 아니다.

실제 RED→GREEN으로 확인한 반례는 신규 kind 미허용, private namespace/removed variant, canonical hash 불일치, OLD terminal→NULL 역전, JSON null pidMode 통과, DB 시각 대신 과거 evaluatedAt을 사용한 freshness 우회다. 초기 기본 postgres17 이미지는 vector 확장이 없어 pgvector PG17로 바꿨다. 새 worktree의 generated Next PageProps 부재는 `next typegen` 뒤 해결했다. 기존 binding CHECK가 거절한 부정확한 fixture work key/reserved_until도 올바른 원래 계약으로 고쳤다. 운영 guard를 낮추지 않았다.

## root 운영 실행 순서

1. root가 코드·migration·실제 물리 경계 도구와 pinned plan을 검토하고 main 최신 base CI를 통과시킨다. 운영 capacity draining 및 유지보수 job pause를 보존한다.
2. root local exact main에서 기존 primary migrator로 127번째 migration을 적용한다. 대상 primary5432/DB identity/active writer fence와 직전 journal/hash를 확인한다. 앱 새 버전 배포를 이 release의 선행조건으로 만들지 않는다.
3. 승인된 실제 도구로 owner → 양 gateway → Supa old engine 종료를 관측한다. no-respawn/ingress 차단, 사전 identity, 실제 stop/wait/empty 관측 원문과 hash를 private0700/0600에 보존한다. 이 문서 작성 시 실제 종료와 receipt 생성은 아직 0이다.
4. root가 아래 CLI를 exact main에서 한 번 실행한다. plan raw SHA와 다섯 artifact SHA를 사전에 검토한다. DB URL은 root의 기존 memory-only wrapper가 stdin으로 전달하며 PG*/fallback 환경을 제거하고 primary/5432/DB identity를 고정한다. 비밀을 argv·일반 출력·repo에 쓰지 않는다.

   ```sh
   # root private wrapper가 primary DATABASE_URL을 stdin으로 전달한다.
   npx tsx scripts/ops/model-provider-boundary-release.ts \
     --plan=/private/approved/plan.json --plan-sha=REVIEWED_RAW_SHA256 \
     --receipt=/private/approved/receipt.json --artifact-dir=/private/approved/artifacts \
     --operator=codex:jr-authorized --reference=REVIEWED_OPERATOR_REFERENCE \
     --database-url-stdin --apply
   ```

   `--apply`를 빼면 rollback하는 dry-run이다. dry-run도 유효한 실제 receipt가 필요하다. 새 CLI는 stop/restart/model 요청을 하지 않는다. 실패 시 원 unknown을 보존하며 근거를 추정해 재실행하지 않는다.
5. 같은 request가 withdrawn, settled_at null, 원 binding/C/logical keys 불변이고 release event와 operations audit가 각각 1건인지 확인한다. 사용량과 업무 성공을 주장하지 않는다. 실제 원서비스 복원·새 incarnation readback 뒤 최종 17앱 고정 release를 진행한다.

향후 두 recorder flag는 이미 supervisor/role-worker의 spawn 전 기록 실패 시 fail-closed와 gateway-local-end 경로에서 지원한다. 이 PR은 flag를 바꾸지 않는다. 새 boot에서 정확히 `1`을 쓰고 실제 관측을 확인하는 별도 운영 검토가 필요하다. local call 종료 기록만으로 provider 종료가 되지는 않으며 기존 reclaim의 provider hard deadline 조건은 유지한다. 과거 boot의 누락 사실은 복구되지 않는다.

## 첫 CI의 역사 검사 후속 수정

첫 head `d3eae2bb`의 CI40122428088 unit(1)은 3,211 PASS/2 FAIL이었다. 두 실패 모두 `tests/local-model-capacity-schema.test.ts`가 literal ADD CONSTRAINT만 읽어 0126의 `pg_get_constraintdef`+format 동적 확장을 놓치고 0125를 최신으로 오인한 것이다. 로컬에서도 같은 두 RED를 실행했다. 생산 DDL·guard·hash는 바꾸지 않고 역사 검사에서 실제 FOREACH 대상과 format template을 읽어 선행 expression 전체를 확장하도록 고쳤다. 0125 member 분기 전체 및 신규 오른쪽 분기를 동시에 정확 비교하며 검사를 생략하지 않는다. regex의 `$'` 같은 문자열이 치환 의미로 해석되지 않도록 literal callback을 쓴다. 해당 schema+boundary+CLI 3파일8건을 다시 실행해 PASS했고 scoped lint/diff check도 exit0이다. 전체 CI 결과는 새 push에서 별도로 확인한다.

같은 run의 integration(4)는 639 PASS/1 FAIL이었다. `gateway-not-started-ledger`의 역사 검사는 0126이 이전 CHECK 전체를 감싼 뒤에도 옛 문자 prefix를 기대했고 events kind를 unchanged로 분류했다. 로컬 RED를 재현한 뒤 0101→0102 exact 검사와 0125까지의 기존 prefix 검사를 유지하고, 0126의 request4개/events kind에 대해 이전 predicate 전체와 새 branch를 격리 DB의 임시 CHECK로 다시 parse해 `pg_get_constraintdef` 전체를 정확 비교했다. PostgreSQL이 재parse 중 중복 OR/AND 괄호와 array cast를 정리하므로 임의 괄호 삭제나 술어 생략으로 비교하지 않는다. 실제 전체파일7/7 PASS, scoped lint exit0이며 생산 코드·migration hash는 불변이다.
