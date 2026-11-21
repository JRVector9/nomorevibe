# 관리자 흐름판의 용량 대기 표시

PR [#984](https://github.com/JRVector9/nomorevibe/pull/984), 기준 main `a9c53498`. 마이그레이션 없음. 운영 데이터 변경·병합·배포 없음.

## 원인과 변경

`job:product-search-verify`의 `ai_task.ranks = {"ranks":1,"unusable.1.capacity":2}`를 `textRankStatusFromCounts`가 순위 사유로 읽는다. 기존 `slotsOf`는 이를 영구 사용 불가와 똑같은 `problem`으로 붙여, 모델이 등록되어 있어도 `anyUsable=false` → `stuck` → `stopped`로 만들었다. `applyStationLlm`의 일부 작업 멈춤 문구는 무조건 “모델 없음 — 일부 멈춤”이었다. 홈의 `flowStageBadge`도 `stopped`를 빨간 “설정 필요”로 표시했다.

- 용량·큐·몫 부족은 `waiting/capacity`, deferred·요청 빈도 제한·이번 틱 쉼은 `waiting/retry`로 구별한다. 문구는 “칸 부족 — 일부 대기” 또는 “일부 재시도 대기”, 홈 카드는 황색 대기다.
- 같은 작업의 일부 순위가 키 없음이고 다른 순위가 용량 부족이면 회복 가능한 순위를 기다린다. 상세에는 두 사유를 함께 남긴다. 같은 순위에 두 사유가 있으면 영구 오류가 우선한다.
- 별도 작업의 실제 멈춤, 워커 장애, 처리 정체, 명시적 일시정지는 그대로 우선한다. 순위 없음(`none`)과 등록됐으나 못 쓰는 상태(`stuck`)도 유지한다.
- 분산 모드는 현재 구성/개정과 일치하는 명시적 전체 사용 불가 관측이 있어야 대기·멈춤을 판정한다. 구성원 한 명의 카운터만으로 전체 상태를 바꾸지 않는다.
- 기존 30분 freshness와 설정 저장 시각 검사를 유지한다. 공개 5개 언어 메시지가 아닌 기존 한국어 전용 관리자 문구 체계를 따른다.

## 직접 잰 품질 수치와 검증

- 신규 회귀 시험 21개: 기준 main에 적용하면 **8 통과·13 실패 → 21 통과·0 실패**. 명령: `npx vitest run tests/conveyor-capacity-label.test.tsx`. 최초 실패 로그 보존.
- `npx vitest run conveyor`: **87/87 통과**, 3개 파일.
- `npx vitest run conveyor tests/flow-rank-editor.test.tsx tests/admin-prototype-pages.test.tsx`: **114/114 통과**, 5개 파일.
- `npx next typegen`, `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit`, 변경 TS/TSX 범위 `npx eslint ...`, `npm run check:i18n`, `git diff --check`: 통과.
- 초기 tsc가 신규 시험의 readonly 배열 `.push`를 거절했다. 불변 배열 재할당으로 고친 뒤 시험·ESLint·tsc 재검증 통과. 초기 오류 로그도 보존했다.
- 로컬 전체 unit·전체 DB 시험은 저장소 정책에 따라 실행하지 않았다. GitHub CI 결과는 PR 최신 head의 `check`가 근거다.

## 화면 확인

기존 시험과 같은 `renderToStaticMarkup`으로 실제 `PrototypeFlow`·`TableView`를 렌더하고 저장소 CSS를 PostCSS/Tailwind로 처리해 Chromium으로 촬영했다. 운영 데이터 조회 없이 동일 fixture를 기준 main과 수정 코드에 넣었다. 보고된 24시간 5,728건은 24시간 칸에만 넣었고, 최근 1시간 장부 호출로 바꾸어 쓰지 않았다.

개발 보고함에 `conveyor-before/after-row.png`(키워드 등록 줄), `conveyor-before/after-overview.png`(실제 홈 카드), `conveyor-before/after.png`(선택 단계 상세)를 첨부한다. 현재 홈의 단계 이름은 기존 코드대로 “검색·후처리”이며 표의 이름은 “키워드 등록”이다.

- 홈 카드 상태: 빨강 “설정 필요”(`rgb(179,57,44)`) → 황색 “칸 대기”(`rgb(143,100,0)`). Chromium `getComputedStyle` 실측.
- 수정한 상태 설명 영역의 overflow 요소: **0 → 0** (`scrollWidth > clientWidth + 1` 검사).
- 문구·단계 이름 일치, 모델 이름/사유, 정렬·잘림을 전후 스크린숏으로 확인했다. 정적 렌더 확인이며 로그인·DB 연결·실제 제어 버튼 동작을 검증한 것은 아니다.

## 배포 범위 예상

전체 40자리 base/head SHA로 `npm run deploy -- scope --base <base> --sha <head>` 실행 결과 `trusted:true`, `exact_ancestor_tree_diff`, **mode:full / 18앱**이다. 이유는 `unclassified_runtime_change`(관리자 TSX·operations 코드), `web_stylesheet`, `no_runtime_change`다. 관리자 표시 수정이어도 자동 웹 전용 분류가 아니다. 최초 축약 SHA/HEAD 입력은 `invalid_commit_identity`였으며 유효한 범위 근거로 쓰지 않았다.

`scope`는 로컬 두 커밋의 예상이다. 실제 앱별 baseline plan과 배포는 실행하지 않았다. 이 변경은 검토·병합 후 별도 승인된 배포에서 올릴 준비가 된 관리자 표시 코드다.
