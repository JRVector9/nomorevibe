# 2026-10-15 근거 적체 회복

관측 기준은 2026-10-15 07:55 KST다. 신규 GitHub·Show HN 발굴은 중단되어 있고, 기존 출처·개발 도구 근거·AI 단계·별·README·썸네일 작업은 정상 작업 lease와 기존 재시도 정책으로 계속 처리한다. 아래 collector 변경은 로컬 검증을 마쳤으며 이 문서 작성 시점에는 운영 미배포다.

## 실제 진행

고정 회복 대상은 출처 54,526건과 개발 도구 근거 14,952개 저장소다. 시작 이후 출처 13,208건(24.22%)이 실제 성공 갱신됐고 205건은 실패를 남겼다. 출처 identity가 달라진 8건과 삭제된 0건도 별도로 센다. 개발 도구 근거는 1,405개를 시도했고 완료 1,303개(8.71%), 부분 102개, 최초 미시도 13,547개가 남았다. 오류 3개는 상태와 겹치는 별도 집계다. 예약을 미래로 옮긴 건을 성공으로 세지 않는다.

현재 워커 대상 출처는 50,939건, 개발 도구 근거는 15,119개가 due다. 최근 5분에 출처 140건과 개발 도구 근거 15개가 성공 저장됐다. 부분 진행은 개발 도구 근거 39개다. AI 단계는 due 0개, 최근 5분 성공 20개로 진행 중이며, 과거 `not_found` 91개는 기존 재시도 대기 중이다. 이 91개를 워커 정지나 새 실패 91개로 해석하지 않는다. 일감이 계속 유입·재도래하므로 고정 대상 진척과 현재 due 수는 다른 지표다.

07:54 KST 같은 트랜잭션에서 관리자와 워커 수치 차이를 확인했다. 관리자 전체 출처 due 54,595건에는 차단된 제품의 과거 출처 3,648건이 포함된다. 현재 공개 제품의 기존 출처 due는 50,947건이고, 워커가 세는 미생성 초기 출처 3건을 더하면 50,950건이다. 이때 차이 3,645건은 `3,648 - 3`이다. orphan·숨긴 링크·링크가 없는 출처는 없었다. 관리자 최장 약 34일은 차단된 제품의 과거 행이며, 현재 자동 일감의 최장은 약 2.87일이다. 이 행들을 완료로 바꾸거나 재시각을 조작하지 않았다.

## 확인한 collector 결함과 변경

실제 GitHub 요청에서 두 원인을 확인했다. 저장소 이름은 같아도 metadata의 GitHub ID가 바뀌면 이전 ID의 부분 커서가 `invalid`로 반복됐다. 공개 metadata와 저장된 ID가 일치하는 저장소에서도 pending 커밋 비교가 404이면 같은 커밋이 계속 남았다.

- ID 변경은 현재 공개 metadata의 ID와 default head로 새 수집을 시작한다. 이전 큐·캐시된 attribution·부분 관측을 새 ID의 근거로 재사용하지 않으며 기존 DB 기록은 보존한다.
- pending 커밋 또는 비교의 404는 공개 metadata·정상 숫자 ID·동일 ID와 현재 default head를 다시 확인한 뒤 처리한다. 현재 tree/blob를 실제로 읽고, 접근 불가 SHA·당시 head·404 종류를 `unavailableCommits`에 남긴다. 결과는 `coverageLimited=true`인 부분 수집이며 해당 attribution을 성공 근거로 세지 않는다.
- 재확인 중 비공개·ID 미확인·인증·rate limit·timeout·head 실패나 예산 부족이 생기면 pending과 기존 backoff를 유지한다. 기존 요청·시간·파일·바이트 제한, quota/abort, 탐지기 버전, source identity 및 publisher 판정은 유지한다.
- 같은 immutable scan에 과거 완료 기록이 있더라도 새 제한 범위를 저장하고 완료 시각을 갱신하지 않는다. 실제로 다시 확인된 완료 결과만 제한 표시를 해제한다. 기존 제한된 빈 커서의 24시간 재시도 정책을 유지한다.

현재 후보 집계는 `partial/unavailable`의 커밋·비교 큐 82개(즉시 due 22, backoff 60), `partial/invalid` 5개(커밋·비교 3, tree 2)다. 이는 같은 증상 후보이며 전부 동일 원인이라고 확정하지 않았다. 완료 기록의 `unavailable` 22개와 최초 실패 2개 등 metadata 접근 오류는 그대로 재시도한다. 외부 404·큰 페이지·HTTP·SSRF 거부 등을 모두 사람 검토로 바꾸지 않는다.

## 관리자 집계 정합

`source-demand.ts`의 공유 CTE를 관리자 요약과 워커 진행 집계가 함께 사용한다. 공개 제품의 보이는 링크와 현재 canonical site만 대상으로 삼고, 링크의 출처가 아직 없으면 LEFT JOIN으로 초기 수요를 센다. 출처·제품·링크가 생기기 전부터 밀린 것으로 표시하지 않도록 기존 워커의 실제 due clock을 그대로 사용한다. 현재 URL과 다른 출처의 실패·성공·상태를 현재 URL의 관측으로 표시하지 않는다.

관리자 숫자를 줄이기 위해 출처를 삭제하거나 예약·성공 시각·상태를 바꾸지 않았다. 테스트에서 관리자 수치와 워커 대기 수·최장 기한이 같고 조회 전후 실제 출처 행이 같은지 확인했다. 기존 워커의 80,000제품 규모 및 3초 statement timeout 검증도 통과했다.

## 검증

단위 재현은 기존 코드에서 9개 실패 후 통과했고, 재확인 metadata ID 형태가 불명확한 경우도 추가 RED 후 통과했다. DB 재현에서는 immutable upsert가 제한 표시를 버리는 1개 실패를 확인한 뒤 수정했다.

```sh
npx vitest run tests/agent-evidence-collect.test.ts tests/agent-evidence-summary.test.ts tests/agent-evidence-parse.test.ts
TZ=UTC TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55446/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/agent-evidence-cursor-recovery.test.ts tests/integration/agent-evidence-repository.test.ts tests/integration/agent-evidence-refresh.test.ts tests/integration/evidence-admin.test.ts tests/integration/worker-progress-query.test.ts
npx tsc --noEmit
npx eslint lib/domain/evidence/agents/collect.ts lib/domain/evidence/agents/repository.ts lib/domain/evidence/admin.ts lib/domain/evidence/source-demand.ts lib/operations/worker-progress-query.ts tests/agent-evidence-collect.test.ts tests/integration/agent-evidence-cursor-recovery.test.ts tests/integration/evidence-admin.test.ts
git diff --check
```

실행 결과: 관련 단위 3파일 74/74, 통합 5파일 90/90, TypeScript·ESLint·diff 검사는 성공했다. 관리자 집계 신규 2테스트는 기존 코드에서 RED를 확인한 뒤 통과했다. 테스트 DB는 별도 localhost 포트와 `pgvector/pgvector:0.8.6-pg17` 컨테이너를 사용했다. 일반 PostgreSQL 이미지의 첫 migration은 vector 확장 부재로 실패했고, KST 기본 timezone에서는 기존 due-clock 테스트 1개가 9시간 차이로 실패했다. 전용 pgvector DB와 `TZ=UTC`로 실행한 위 결과만 통과로 기록한다.

## 운영 확인과 남은 일

07:55 KST 두 GitHub core pool의 remaining은 4,599/5,000과 4,281/5,000으로 최신 관측이다. 기존 15% 여유 조건 아래에서 정상 수집을 이어가며, 이를 Cloudflare 비용 한도로 해석하지 않는다. 신규 발굴 작업의 실행 수는 GitHub 8,905·Show HN 1,681로 변하지 않았다. 별 갱신은 기존 scheduler가 due를 처리했고, README 갱신 대상은 없었으며, 썸네일은 기존 backoff를 지키며 계속 저장 중이다.

배포는 통합 PR의 최신 main CI를 확인한 뒤 정상 13개 앱 경로로 진행한다. 배포 후 새 collector로 ID 교체·커밋/비교 404 후보가 새 ID 또는 제한된 현재 head로 진전했는지 관측한다. 제한 수집을 완료로 세지 않고, source 성공 시각·고정 대상 진척·현재 due를 함께 확인한다. 관리자 출처 요약과 워커 current demand가 같은 관측 시각에 일치하는지도 확인한다.
