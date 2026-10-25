# 역사 소유자와 직접 native boot 경계 V4 검증

## 목적과 현재 상태

원래 reviewer 컨테이너가 종료·교체된 뒤에도, 이미 기록된 원래 process-group 종료와 direct native GPU boot 증거를 함께 검증할 수 있도록 버전4를 추가했다. 기반은 `87ecc4b1bf2a3803fdc62ad10c77ebff0f43b05b`이며 격리 작업 트리는 `/Users/jr/Desktop/projects/nomorevibe-provider-boot-historical-v4-20261025`, 브랜치는 `codex/provider-boot-historical-owner-v4-20261025`다.

설계 문서와 실행 계획은 `0252c8de`에 먼저 커밋했다. root는 설계와 최종 코드 검토를 승인했다. root와 audit_hold의 독립 검토는 blocker0으로 완료했고 구현 commit/push/PR 생성을 승인받았다. 이 문서는 검증 완료 시점의 기록이며 PR 최신 base CI와 운영은 후속 단계다. 이 단계에서 운영 SSH/API/DB/마이그레이션/모델/서비스/제품 판정 실행은 모두0이다. 로컬 disposable PostgreSQL17만 사용했다. 운영의 capacity·unknown2·기존6 assist pause·LLM 설정은 변경하지 않았다.

## 구현과 보존 규칙

- V4는 V2의 `originalOwner` 원장을 그대로 사용하고 실제 현재 `currentIngressOwner` namespace 종료를 별도로 요구한다. `owner` 투영이나 과거 Swarm 종료값을 Docker wait ACK로 바꾸는 경로는 없다.
- direct native serving contract, single-direct HTTP, boot witness, endpoint/machine/node/boot, conservative interval, microsecond clock, 5초 sandwich·5분 freshness·30분 plan 유효시간은 V3와 같다. gateways는 빈 배열이다.
- association은 정확한 원래 group의 spawned ID/PID/run hash를 가리킨다. 두 local-end 증거는 같은 event ID를 사용한다. `originalOwner.localEndEvidenceHash`는 PostgreSQL `evidence::text`의 SHA이며 `localEnd.evidenceHash`는 ASCII canonical SHA다. 두 해시를 같다고 가정하지 않는다.
- 원래 local-end는 native boot보다 앞서야 하지만 원래 group의 종료는 계획 이전이면 된다. 실제 회귀의 group 종료는 native boot 뒤다.
- 기존 fence/control/request lock, token/binding/epoch/revision/policy/control timestamp CAS, before artifact, 단일 audit, usage unknown/settled_at NULL, 재실행 불변성은 유지한다.
- additive `0131_historical_direct_provider_boot_boundary.sql`과 journal idx131/when1794086400043만 추가했다. 이전 SQL bytes는 바꾸지 않았다. V3 source의 검증된 fragment로 새 V4 함수만 파생하며 예상 predecessor fragment가 없으면 마이그레이션을 거절한다.
- 기존 helper body/OID·CHECK OID/definition/validation은 보존한다. 두 public dispatch 함수의 OID를 유지하고 이전 본문은 새 archive에 그대로 보관해 V1/V2/V3로 delegate한다.

새 함수는 정확히 네 개다.

1. `nmv_provider_boundary_release_v4_valid(jsonb)`
2. `nmv_boot_historical_records_valid(jsonb,jsonb)`
3. `nmv_boot_historical_previous_release_valid(jsonb)`
4. `nmv_boot_historical_previous_transition_guard()`

## 실행한 검증

설치된 `node_modules/next/dist/docs/01-app/02-guides/testing/vitest.md`를 구현 전에 읽었다. 로컬 DB 전용 컨테이너는 `nomorevibe-provider-boot-historical-v4-test-20261025`, 포트는 `127.0.0.1:32790`, 이미지 `pgvector/pgvector:0.8.6-pg17`이다. 테스트 파일은 매번 별도 random DB를 만들고 자기 DB만 정리한다.

```sh
npm test -- tests/provider-boot-historical-owner.test.ts tests/provider-boot-boundary.test.ts tests/provider-boundary-historical-owner.test.ts tests/provider-boundary-release.test.ts tests/provider-boundary-launchd.test.ts tests/provider-boundary-cli.test.ts
```

최종 **6파일25 PASS**, 1.27초. 새 V4 5건, 기존 계약·CLI 경로를 포함한다. 300개 이상의 missing/null/extra/native topology negative, 원래 group 배열 원소/중복/범위, 두 proof hash domain, current ingress, 혼합 버전, microsecond lower-bound를 검사한다.

```sh
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:32790/nomorevibe_test npm run test:integration -- tests/integration/provider-boot-historical-owner.test.ts tests/integration/provider-boot-boundary.test.ts tests/integration/provider-boundary-historical-owner.test.ts tests/integration/provider-boundary-release.test.ts tests/integration/provider-boundary-launchd.test.ts
```

이 실행은 **5파일36 PASS**, 38.41초였다(기존4파일28건 + 당시 V4 8건). 이후 stock 단일 호출 회귀와 group 배열/microsecond matrix를 보강하고 다음 최종 V4 파일을 실행했다.

```sh
BOUNDARY_CATALOG_OUTPUT_DIR=/private/tmp/nomorevibe-provider-boot-historical-v4-validation-20261025 TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:32790/nomorevibe_test npm run test:integration -- tests/integration/provider-boot-historical-owner.test.ts
```

최종 **V4 9 PASS**, tests11.83초/전체15.10초. 따라서 검증한 고유 DB 회귀는 기존28 + 최종V4 9 = **37건**이다. 마지막37건을 한 명령으로 다시 실행했다고 주장하지 않는다.

- nonempty130→131→132 경로: 131 직전 전체 함수34개와 132후38개를 비교해 정확히4개 증가, 이전 helper OID/본문/전체 definition 불변, 두 wrapper의 원래 본문 archive 일치, request row와 CHECK20개의 OID/definition/validation 불변을 확인했다. journal132개 전부의 실제 SQL SHA/when이 일치했다.
- 별도 fresh nonempty130 DB: unresolved request·local-end event·DR process-group 원문을 복제하고 **정규 `migrate()` 한 호출**로 pending0130+0131을 적용했다. 132 journal, 양쪽 SQL hash, 세 테이블 원문 불변, V4 physical/records 양성까지 확인했다.
- 잘못된 owner/group/intent/spawn/PID/run/exit/event/time/두 hash, 새로운 미종료 group·sequence gap, native binding, control/token/binding/fence CAS, direct INSERT/UPDATE 우회는 거절했다.
- dry-run rollback, apply 한 행/이벤트/audit, unknown usage·NULL settled_at·binding/charge 보존, idempotent replay/terminal immutable를 확인했다.

```sh
npx next typegen
npx tsc --noEmit --incremental false
npx eslint lib/llm/provider-boundary-contract.ts lib/llm/capacity-repository.ts lib/operations/dr/provider-boundary-owner.ts scripts/ops/model-provider-boundary-release.ts tests/fixtures/provider-boot-historical-owner.ts tests/provider-boot-historical-owner.test.ts tests/provider-boundary-cli.test.ts tests/integration/provider-boot-historical-owner.test.ts tests/integration/provider-boot-boundary.test.ts tests/integration/provider-boundary-historical-owner.test.ts
git diff --check
```

모두 실제 exit0. 최종 changed-file eslint warning0. 전체 unit/전체 DB/build는 이 PR 범위에서 실행하지 않았다. Vitest는 기존 CommonJS config의 향후 native-loader 경고를 출력했으며 테스트 실패는 아니다.

## 실패와 수정

- 구현 전 unit 양성2건이 미지원 version4 때문에 실패했다. CLI V4도 `receipt.owner`만 보던 기존 분기에서 실패했다. 실제 PG에서는 journal131≠132, 새 records 함수 부재, 정규 UPDATE 거절을 확인한 뒤 구현했다.
- 초기 negative fixture가 null request를 읽어 TypeError를 냈고, 초기 PG fixture는 새 association PID와 historical group PID가 달라 parse가 실패했다. fixture를 고친 뒤 RED를 재확인했다.
- Zod refine가 잘못된 uptime `1.5`를 BigInt로 바꾸며 throw하는 회귀를 발견했다. V3와 같은 base safeParse guard를 V4 conversion 앞에 넣어 fail-closed false로 검증했다.
- stock 테스트 추가 중 공통 문자열 치환이 beforeAll의 connection 이름을 잘못 바꿨다. 중복 predecessor setup을 기존 helper 호출로 정리한 뒤 최종9건이 통과했다. 긴 random DB 이름은 PostgreSQL identifier 한도 안으로 줄였다.
- 초기 eslint unused fixture 변수2 warning을 실제 사용되는 ingress identity/observation 구성으로 정리하고 warning0을 확인했다.

## 변경 파일과 산출물

Source: `lib/llm/provider-boundary-contract.ts`, `lib/llm/capacity-repository.ts`, `lib/operations/dr/provider-boundary-owner.ts`(type만 확대), `scripts/ops/model-provider-boundary-release.ts`, 새0131 SQL과 journal.

Tests: 새 V4 fixture/unit/PG 파일, 기존 CLI tests, 이전 boot PG의 journal count와 historical-owner PG의 추가 archive/trigger 기대값. 문서: spec/plan, 이 기록, 이 격리 WT의 CODEX_HANDOFF section.

원본 SQL SHA256:

- 0130: `e9c8f2b84c5f77cab77b6948eac22ebc50c392263f84bd3dfaad294e6ed628ab` (unchanged)
- 0131: `c40d787adeaf26c1e7a589cbdc54a6ea1b86239b2cf5c170b813e05960cb3ed5`

합성 실제 DB 카탈로그 원문(운영 데이터 아님)은 `/private/tmp/nomorevibe-provider-boot-historical-v4-validation-20261025/`에 있다.

- `v4-before-130.safe.json`: journal130, functions19, request1, checks20.
- `v4-before-131.safe.json`: journal131, functions34.
- `v4-after-132.safe.json`: journal132, functions38, request1, checks20.
- `v4-stock-130-to-132.safe.json`: stock 단일 migrate 호출 수1, 보존한 세 테이블과132 journal.

## 다음 단계

root와 독립 검토 승인에 따라 구현 commit/push/PR 최신-base 필수 CI를 진행한다. `git fetch origin` 재조회 결과 현재 base는 여전히87ecc4b1이었다. 운영은 root가 새 trusted main/image/양 SQL hash를 pin한 별도 plan과 once 도구로 수행한다. 현재 운영 DB130을 변경하거나 역사 owner/native 증거를 새로 추정하는 행위는 이 구현에 포함하지 않는다. 원래 감사·거절 LLM 설정은 그대로 유지한다.
