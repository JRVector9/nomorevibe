# Provider 경계 종료 단건 회수 설계·실행 계획

목표는 실제 owner → 양 gateway old incarnation → Supa old engine 전체 process tree 종료를 관측한 뒤, 기존 indeterminate 요청 한 건의 점유만 withdrawn으로 끝내는 것이다. root가 이 설계와 별도 worktree 구현을 승인했다. 원래 terminal, 사용량, 업무 성공을 소급 생성하지 않는다.

기존 opaque terminal 정산은 원래 프로세스가 발급한 증인만 받는다. 기존 process/local-end 회수는 해당 owner 기록과 입증된 provider hard deadline이 필요하다. 이번 실제 요청은 두 기록 기능이 미설정이고 owner 사건 0건이므로 이 경로로 회수할 수 없다. 단순 client timeout·idle metrics·TTL은 증거가 아니다.

새 plan은 원 request/owner/token SHA/epoch/revision/policy/binding/dispatch 시각/budget/group/serving contract, draining control CAS와 이전 물리 identity를 고정한다. receipt는 같은 coordinator 시계의 실제 종료 관측과 artifact SHA를 포함한다. operator는 실제 raw 관측 artifact를 사전 검토한 privileged trust boundary다. JSON shape/hash 자체는 프로세스 종료를 증명하지 않는다. CLI는 사전 승인한 plan hash 및 artifact bytes를 확인하며 restart/stop 명령을 수행하지 않는다.

구현 순서:

- [x] 새 evidence를 기존 schema가 거절하는 RED를 실행한다.
- [x] strict plan/receipt·순서·identity·future/stale·누락 검증을 추가하고 순수 fixture를 GREEN으로 만든다.
- [x] fence → exact draining control → exact request lock 아래 기존 release hook을 재사용한다. 단건 CAS와 같은 TX operations audit를 검증한다.
- [x] migration0126은 기존 CHECK 전체를 왼쪽에 보존한다. 새 branch는 이전 logical/members/dispatch 술어를 indeterminate/terminal-null 행으로 재검증한다.
- [x] 격리 PostgreSQL에서 기존 CHECK 보존, 정확 한 행 withdrawn/event/audit, 충돌/fence/open/변경 증거 거절과 rollback을 실행한다. 실제 운영 DB·모델을 쓰지 않는다.
- [x] 범위 unit, tsc/lint 및 검증 결과·실패를 별도 문서와 handoff에 남긴다. merge와 운영 execute는 root만 수행한다.

다음 실행: `npx vitest run tests/provider-boundary-release.test.ts`; 격리 DB URL만 `TEST_DATABASE_URL`에 지정하고 `npx vitest run --config vitest.integration.config.ts tests/integration/provider-boundary-release.test.ts`를 실행한다.

구현·검증 및 실제 운영 실행 전제는 [검증 결과와 실행 순서](2026-10-25-provider-boundary-release-results.md)에 고정한다. commit/PR의 성공은 실제 provider 종료나 운영 회수 완료를 뜻하지 않는다.
