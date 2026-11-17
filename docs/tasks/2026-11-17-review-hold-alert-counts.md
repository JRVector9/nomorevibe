# 심사 보류 알림 집계 — PR #982

- PR: https://github.com/JRVector9/nomorevibe/pull/982
- 브랜치: `fix/review-hold-alert-counts-20261117`, 시작 base `da81adec3931ff0946ba4db8c5662271f619be52`
- 금지: 병합·배포·운영 설정 변경·운영 DB 쓰기. `lib/crawl/agent-review-*` README 경로 변경 없음.

## 남은 일

- [x] 최신 main에서 전용 브랜치·빈 시작 커밋·Draft PR 생성 및 head/base 확인
- [x] 원인 확인: `readHoldCounts`의 updated_at, 모델의 ambiguous→judge 고정 매핑
- [x] 심사 이력 완료 시각·규칙 판단 시각 기반 집계와 규칙/AI 구분 구현
- [x] 단위·시험 DB 55435 회귀 시험 및 쿼리 계획 확인
- [x] DB·로그인 없는 mock 서버 컴포넌트 전후 화면 렌더·Playwright 캡처·기획 검수
- [x] 변경 범위 vitest·tsc·ESLint, 실제 deploy scope
- [x] 의미 단위 커밋·전용 브랜치 push, ready 및 구현 head GitHub PR CI 전부 확인
- [x] PR 본문 갱신·보고함/최종 보고용 영수증 준비(실제 접수 결과는 종료 보고에 기록)

## 결정과 근거

- 마이그레이션 없이 기존 `signals.agentReviewAttemptId`와 `crawl_review_attempts`의 candidate_id/kind/provider/state/outcome/completed_at을 사용한다.
- 적용된 AI 판단만 연결한다. observe 모드의 적용되지 않은 이력을 현재 규칙 보류로 오인하지 않는다.
- 같은 후보의 동일 종류 보류가 재심사되어도 최초 성공 보류 완료 시각으로 센다. 이력이 없는 규칙 보류는 해당 규칙 판단의 `judged_at`을 사용하고, 시각이 없으면 신규로 추정하지 않는다.

## 구현·로컬 검증 (2026-11-17 UTC)

- 구현 커밋: `b10ea744`.
- `review-hold-counts.ts`로 읽기 경로를 분리했다. 적용된 시도를 PK·candidate_id·성공·보류 결정으로 검증하고, `kind=automatic`, `provider IS NOT NULL AND provider <> 'rules'`인 ambiguous만 화면용 `ai_first_ambiguous` 묶음으로 만든다(DB reason 값은 바꾸지 않음).
- 같은 후보·같은 kind·규칙/비규칙 구분의 최초 성공 보류 `min(completed_at)`을 사용한다. 재사용·재심사로 후보와 포인터가 바뀌어도 최초 시각은 유지한다. 적용되지 않은 observe 이력으로 현재 규칙 보류를 AI로 분류하지 않는다.
- 이력이 없는 후보는 `judged_at`(규칙 심사 시각)을 사용한다. 원래부터 첫 보류 이력이 없는 기록의 최초 상태 전환을 복원할 수는 없다. null 시각은 신규 0건이다. 운영 과거 데이터를 읽거나 보정하지 않았다.
- 알림 ID·제목과 흐름의 AI 1차 칸·사람 확인 묶음 표시를 나눴다. 관리자 문구는 원래 한국어 직접 표기이며 해당 messages namespace는 없다. AI 링크는 기존 ambiguous/AI 보류 필터를 사용한다(새 목록 필터는 추가하지 않음).
- 마이그레이션 **0개**. 후보 상태 인덱스로 현재 보류만 고르고, 적용 시도 PK와 `crawl_review_input_idx(candidate_id, ...)`로 그 후보의 이력만 읽는다. 거절 누적은 상태 인덱스로 별도 count하므로 거절마다 이력을 찾지 않는다. 누적 count 자체는 해당 상태 전체를 읽으며, 실제 데이터 분포에 따라 PostgreSQL은 순차 읽기를 고를 수 있다. 3초 읽기 전용 TX 제한과 15초 공유 캐시는 유지하고 conveyor 캐시 키는 v6으로 변경했다.
- 시험 DB **55435**의 1,001 후보·4,001 심사 이력 fixture에서 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`을 기본 planner 설정으로 실행: 상태 인덱스 → 적용 시도 PK → 후보별 이력 인덱스, Seq Scan 없음. 상세 영수증은 보고함 `query-plan.json` 첨부. 운영 규모 성능을 실측한 것은 아니다.

### 품질 수치 (추정 아님)

- 같은 DB fixture의 오래된 보류 재집계: **1건 → 0건**. 48시간 전 처음 보류, 1시간 전 재심사·최근 updated_at. 기존 main의 updated_at SQL과 수정 함수를 같은 시험 안에서 비교했다.
- 명령: `REVIEW_HOLD_METRICS_PATH=<artifacts>/quality.json REVIEW_HOLD_PLAN_PATH=<artifacts>/query-plan.json npx vitest run --config vitest.integration.config.ts tests/integration/review-hold-alert-counts.test.ts`.
- 1440px mock 화면의 수평 넘침 **0px → 0px**, 규칙·AI 보류 표시 묶음 **1개 → 2개**. 실제 데이터가 아닌 문구 구분을 확인하는 고정 fixture다.

### 실제 실행 결과

- `npx vitest run tests/review-hold-alert-counts.test.ts tests/review-hold-alert-counts-page.test.tsx tests/admin-flow-conveyor.test.tsx tests/console-tasks.test.ts tests/console-alerts.test.ts tests/console-alerts-page.test.tsx tests/console-home.test.tsx tests/human-batch-model.test.ts`: **8파일 105시험 통과**.
- `npx vitest run --config vitest.integration.config.ts tests/integration/review-hold-alert-counts.test.ts`: **1파일 5시험 통과**, 시험 DB 55435.
- `npx next typegen` 뒤 `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`: **통과**.
- 바뀐 TS/TSX 9파일 `npx eslint <files>`: **통과**. `git diff --check`: 통과.
- DB·로그인 없는 vitest 모듈 mock으로 실제 알림 page 서버 컴포넌트와 FlowBoard를 렌더했다. 전후 HTML을 로컬 HTTP 서버로 열어 Playwright Chromium에서 캡처하고, AI 보류 링크를 눌러 기존 목록 URL로 이동함을 확인했다. 서버는 캡처 뒤 종료했다.
- `before.png` / `after.png` 직접 검수: 알림·규칙 심사·AI 1차 판단 용어 일치, 추가 창 없음, 글자 잘림·정렬 어긋남 없음. 저장 불가 상태는 읽기 전용 fixture임을 표시한다. HTML/이미지·클릭 영수증은 보고함 첨부이며 공개 저장소에는 넣지 않는다.
- 로컬 전체 unit·전체 DB·종합 시험은 실행하지 않았다. GitHub PR CI의 저장소 정책 검사는 별도로 확인한다.

### 실패·준비 문제 보존

- 첫 작은 DB fixture의 계획 시험: 동작 4시험은 통과했으나 planner가 PK를 선택해 특정 후보 인덱스 기대가 실패. 충분한 무관 이력을 넣고 기본 planner의 실제 계획을 확인하도록 수정했다.
- 12,000 후보·48,000 이력을 넣던 계획 fixture는 준비 INSERT가 statement timeout으로 실패. 최종 fixture는 1,000 무관 후보·4,000 무관 이력으로 줄여 완료했다. `integration-fixture-timeout.log` 보존.
- 첫 tsc는 공유 node_modules의 aws4fetch 누락·Next PageProps 미생성과 화면 시험 ConsoleAction narrowing 오류로 실패. 시험 오류를 고치고 격리 폴더에서 `npm ci --no-audit --no-fund --ignore-scripts`, `next typegen` 후 재실행해 통과했다. `tsc-initial.log` 보존. 의존성 파일 변경 없음.
- 첫 scope의 `--sha HEAD`는 40자리 SHA가 아니어서 `trusted:false / invalid_commit_identity`로 보수적 full을 반환했다. 정확한 SHA로 다시 실행한 결과를 아래 사용한다. plan/run은 실행하지 않았다.

### 배포 범위 (scope만 실행)

`npm run deploy -- scope --base da81adec3931ff0946ba4db8c5662271f619be52 --sha b10ea74445a8a0c7b39cbd62ec57c5d5b12c0d95`의 실제 출력은 보고함 `deploy-scope.txt`에 보존한다. 공유 lib·관리자 TSX 변경으로 **mode=full, 18앱 선택, retained 0**이다. 웹 전용이라고 축소하지 않는다. 병합·배포 및 운영 설정/DB 변경 없음.

## GitHub 검증

- Draft 착수의 `check` 실패는 저장소가 의도한 “draft PR — CI not run; mark ready for review”이며 코드 시험을 통과했다는 뜻이 아니다.
- Ready 전환 완료. 구현 head `0d8fa5ce55ad6451c027331571984e1caa4dd8e3`는 [CI 44021462201 attempt 2](https://github.com/JRVector9/nomorevibe/actions/runs/44021462201/attempts/2)에서 전체 선택 검사 성공(`check` 포함). 첫 실행 실패는 아래 보존했다.
- 이 결과를 담는 문서 커밋 뒤에도 최종 head의 실제 CI를 끝까지 확인한다. 최종 head/CI 및 보고함 접수 영수증은 PR 본문과 종료 개발 보고가 정본이다.
- PR 체크: https://github.com/JRVector9/nomorevibe/pull/982/checks

### 첫 GitHub CI 실패의 분리 확인

- 실행 `44021462201`, attempt 1: `integration (6)`의 기존 `role-worker-db-terminate-process.test.ts` 두 번째 시험이 240초 timeout. 같은 묶음의 나머지 733시험은 통과했고 다른 선택 검사 잡은 통과했다. `check`는 이 실패를 받아 실패했다. 저장소는 PUBLIC이었고 결제 차단은 아니었다.
- 해당 워커·시험 파일은 변경하지 않았다. 원인을 확정하지 않는다.
- `timeout 360s npx vitest run --config vitest.integration.config.ts tests/integration/role-worker-db-terminate-process.test.ts`를 55435에서 단독 실행: **2시험 모두 통과**, 84.74초(시험 본문 81.81초).
- 같은 head의 실패 잡만 `gh run rerun 44021462201 --repo JRVector9/nomorevibe --failed`로 재실행했다. 제한 시간·시험 기대·워커 코드를 완화하지 않았다. 첫 실패 발췌와 단독 실행 로그는 보고함 첨부에 보존한다.

- Attempt 2는 실패 묶음과 `check`가 실제 통과해 실행 전체 **SUCCESS**. `refresh-caches`와 PR에서 실행하지 않는 publish 잡은 **SKIPPED**이며 통과했다고 세지 않는다. 이전에 통과한 변경 없는 잡은 GitHub의 failed-only 재실행 결과로 보존된다.
- `origin/main`은 재확인 시에도 `da81adec`였고 병합하지 않았다. 작업 브랜치 이외 push·기록 고쳐 쓰기 없음. 배포할 코드는 PR에 준비되어 있으나 승인된 범위는 PR CI 확인까지이며 병합·배포하지 않았다.
