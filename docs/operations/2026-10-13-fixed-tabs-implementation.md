# 2026-10-13 홈 필터·고정 탭 구현

## FILTER-01

분야·AI 칩에 현재 목록의 정렬 자격을 적용한다. 집계 바탕에서 선택 분야와 선택 AI는 제외하고, 분야 칩은 AI 조건을, AI 칩은 분야 조건을 유지해 클릭 결과를 예측한다. 분야 순서는 별도 전체 공개 집계로 유지하고 0건 분야도 표시한다. 선택 분야를 다시 누르면 해제한다. 검색·도구·빌더 상태의 숫자 숨김은 유지한다. 기존 방문 랭킹 모드에서는 전체 랭킹 자격 slug를 먼저 얻어 동일 대상을 집계한다. FILTER-02에서 주 탐색 탭의 이 전환 경로를 제거한다.

변경: app/page.tsx, components/BrowseFilters.tsx, lib/domain/products/repository.ts, tests/home-browse.test.ts(0건 분야의 기존 기대값 보정).

실제 실행 결과:

- `node node_modules/next/dist/bin/next typegen`: exit0.
- `node node_modules/typescript/bin/tsc --noEmit`: 최종 exit0.
- `node node_modules/eslint/bin/eslint.js app/page.tsx components/BrowseFilters.tsx lib/domain/products/repository.ts tests/home-browse.test.ts`: exit0.
- `npm run build -- --webpack`: 최종 exit0, Next16.3.8 production build.
- `git diff --check`: exit0.

초기 구현의 괄호/nullable closure/인자 수 오류로 타입 검사·빌드가 실패했고 보정 후 위 명령을 다시 실행해 성공했다. 기능·브라우저·E2E·로컬 단위/통합 테스트는 실행하지 않았다. 사용자의 직접 기능 테스트 범위를 대신 성공했다고 주장하지 않는다.

작업은 `/private/tmp/nomorevibe-browse-fixed-tabs-20261013`의 격리 worktree다. node_modules는 설치된 저장소 의존성의 symlink이며 .next·next-env·TypeScript 산출물은 이 worktree에 생성했다. .env는 복사하지 않았다. 배포·PR·통합과 docs/CODEX_HANDOFF.md 갱신은 주 에이전트가 담당한다.

다음 단계: FILTER-02에서 weekly를 공통8시간 회차 reader로 연결하고 최근 등록/총GitHub스타 탭 의미를 고정한다. 관측 잡·정책·DB schema·운영에는 변경하지 않는다.

## FILTER-02

세 탭의 이름과 기준을 `8시간 스타 급상승` / `최근 등록` / `GitHub 스타 많은 순`으로 고정한다. weekly/recent/all-time·기존 popular/featured/newest alias는 보존한다. weekly와 홈 띠·/rising은 같은 닫힌 T/T−8h reader를 사용한다. 기존 동일 저장소·연결 버전·GitHubID·관측창·7~9시간·스타50~1,999·순증가≥1·10시간 신선도·공개/생존 조건과 증가량→총스타→slug 순서를 유지한다. 관측 잡·수집 정책·schema는 수정하지 않는다. total/count/facet과 카드 구간은 하나의 repeatable-read/read-only transaction에서 읽는다. 새 분야/AI 조건은 limit 전에 적용한다.

Reader의 `category`, `aiLevels`, `query`, `builder`, `observedTool`, `includeFacets` 옵션과 bounded `limit`/`offset`/`end`를 추가했다. 응답 `offset`과 `facets`로 9개부터 더 보기·최대198개 trailing window·저장 후보100개를 유지한다. 현재 선택 분야/AI를 facet matrix에서 빼고 UI가 반대 facet을 적용한다. 0건 미선택 칩은 기존 칩 스타일의 disabled span, 0건 선택 칩은 해제 링크다. 목록 조회 실패 때는 알 수 없는 숫자를 숨긴다.

8시간 자료가 준비 중·지연·비교 불가이면 기존 회차 상태를 표시하고 일평균/총스타 목록으로 대체하지 않는다. 전체 회차에는 결과가 있지만 선택 조건이0건이면 `filtered-out` 상태로 안내한다. all-time은 검증 수와 무관하게 항상 GitHub 총스타다. 최근 등록은 서비스 등록·검증 시각과 검증 제품 우선순서를 유지하고 저장소 생성일과 구분해 설명한다. 별도 최근7일 생성 메뉴와 시즌 방문 랭킹 페이지는 유지한다. 숨긴 기존 trending URL은 방문 증가 기준·미클레임 구획 호환을 유지하며 주 탐색 탭 의미를 바꾸지 않는다.

MethodologyDialog의 기존 metric=rising 링크는 새8시간 설명으로 연결하고 자동 방문 전환·대체 목록 설명을 삭제했다. 실제 카드의 optional starGrowth 값은 그대로 통과해 ‘8시간 +N’ 지표를 쓴다. AI 전체 통계는 별도 전역 집계를 유지한다.

실제 실행 결과:

- `node node_modules/next/dist/bin/next typegen`: exit0.
- `node node_modules/typescript/bin/tsc --noEmit`: 최종 exit0.
- `node node_modules/eslint/bin/eslint.js app/page.tsx components/BrowseFilters.tsx components/home/browse-state.ts components/home/MethodologyDialog.tsx components/home/StarGrowthSummary.tsx lib/domain/products/star-growth.ts tests/home-browse.test.ts tests/home-sort.test.ts tests/home-ai-filter.test.ts tests/home-unclaimed.test.tsx`: exit0.
- `npm run build -- --webpack`: exit0.
- `git diff --check`: exit0.

기존 mock 응답에 offset/facets를 보충하고 폐기된 fallbackSort import/기대값, 고정 탭 라벨·0건 disabled 칩 기대값을 보정했다. 새 테스트 suite는 추가하지 않았다. 첫 타입 검사에서 기존 fixture의 새 필드 누락·삭제 API 참조가 나왔고 fixture 보정 후 통과했다. 로컬 단위/통합·브라우저·E2E·사용자 쓰기 테스트는 실행하지 않았다. 부모가 PR CI 결과·리뷰·통합·배포를 이어 확인해야 한다.

다국어 foundation은 기존 app/page.tsx와 app/home.css의 최종 변경을 이동된 locale 경로에 반영해야 한다. 컴포넌트·reader는 공유 코드 그대로 사용하며 새 `filtered-out` 이유와 고정 정렬 라벨의 번역을 포함한다. root handoff는 부모가 갱신한다.

```sh
cd /private/tmp/nomorevibe-browse-fixed-tabs-20261013
git status --short
git log -2 --oneline
git show --stat HEAD
# 다음 PR에서 GitHub 필수 check를 확인한 뒤 일반 병합·기존 runbook 배포를 수행한다.
```
