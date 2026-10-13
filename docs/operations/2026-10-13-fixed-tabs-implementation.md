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
