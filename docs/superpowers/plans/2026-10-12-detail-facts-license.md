# 상세 정보 크기·라이선스 안내·수집 정확성 구현 계획

**목표:** 기존 사실 항목을 유지하며 상세 정보 영역을 조금 줄이고, 라이선스 설명 표를 클릭으로 열 수 있게 한다. 다른 상세페이지의 데이터 누락과 라이선스 수집을 실제 근거로 검토하고 확인된 원인만 수정한다.

**구조:** 기존 FactsStrip 서버 컴포넌트와 작은 native dialog 클라이언트 컴포넌트를 사용한다. 라이선스 데이터는 GitHub 관측과 메이커 선언을 구분한다. 최초 상세 수집은 기존 crawler 요청 큐·lease·retry·예산을 사용한다. 새 의존성이나 새 스케줄러를 추가하지 않는다.

**사용자 제약:** gpt-6.1-sol/xhigh 서브에이전트 병렬 작업. 최소 코드. 사용자 직접 테스트: 새 테스트 작성 및 로컬 test/typecheck/lint/build/E2E 실행 없음. 운영 DB는 기본 read-only이며 광범위 갱신·provider 소급 위조·소개검수 재개 금지. 실제 실행한 확인만 완료로 기록한다.

## PR01 — 사실 영역 크기 축소·라이선스 설명 표

- 소유 파일: components/product-detail/FactsStrip.tsx, 새 components/product-detail/LicenseDialog.tsx, 필요 시 작은 guide 데이터 파일. 기존 모달 패턴과 설치된 Next CSS/서버·클라이언트 가이드를 먼저 읽는다.
- [x] 모든 기존 사실 항목·note·grid를 유지하고 tile padding과 글자 크기를 완만하게 줄인다(현재 값20px/px18/pt16/pb14 → 약18px/px14/py12). 화면 전체 스타일은 변경하지 않는다.
- [x] 라이선스 값 클릭 시 native dialog로 현재 라이선스 출처와 주요 라이선스 비교 표를 표시한다. table에 상용 이용/수정·재배포/공개 의무/핵심 조건을 넣고 모바일 overflow를 처리한다. Esc/닫기/바깥 클릭/포커스 복귀를 기존 패턴대로 구현한다.
- [x] MIT/Apache-2.0/BSD-2·3/GPL-2·3/LGPL/MPL/AGPL/ISC/Unlicense/CC0 등 실제 빈도에 맞춰 주요 조건을 공식 원문과 GitHub 공식 설명으로 확인한다. NOASSERTION·커스텀·복수 라이선스는 임의 단일 라이선스로 추정하지 않는다. 원문 링크를 제공하고 요약임을 간단히 표시한다.

## PR02 — 라이선스 수집·표시 정확성

- 소유 파일: lib/domain/evidence/providers/github.ts, lib/domain/products/detail-view.ts 내 라이선스 처리, 전용 audit 문서. PR01 UI와 PR03 큐 파일은 수정하지 않는다.
- [x] GitHub repository license 응답→정규화→DB 갱신→detail view 경로를 읽는다. null/NOASSERTION/메이커-only/충돌/캐시304/최근 실패/저장소 변경을 구분한다.
- [x] 공개 공식 GitHub 문서와 대표 저장소 API 응답을 확인하고 운영 DB allowlist를 통해 분포·오류·표시 차이를 조사한다. 요청 제한과 저장소 원문 범위 한계를 명시한다.
- [x] 실제 오류가 확인되면 최소 코드로 수정한다. SPDX 식별을 원문 전체 법적 해석으로 과장하거나 repository 전체/의존성의 모든 라이선스로 확장하지 않는다.

## PR03 — 다른 상세페이지 누락·최초 상세 수집 지연

- 소유 파일: lib/crawl/publish.ts, lib/domain/products/repository.ts 내 제품 생성 지점, lib/domain/evidence/refresh.ts 또는 lib/jobs/products/evidence-refresh.ts(원인에 필요한 최소 한두 지점), 전용 audit 문서. provider/detail view/UI 파일은 수정하지 않는다.
- [x] 운영 공개 제품의 현재 primary repository 링크와 detail view join/key/type 규칙을 SQL로 대조해 missing/no source/key mismatch/hidden/failure/stale를 집계한다. 대표·최신·오래된·설치형·미관측 페이지의 HTTP facts를 표본 확인한다.
- [x] ManimGX는 전용 facts가 0행이었고 수동 기존 큐 요청 후 6개 항목이 표시됐다. 일반 순회 slug 정렬과 발행 시 첫 요청 연결 여부를 확인한다.
- [x] 원인이 확인된 최초 수집 지연은 기존 요청 큐 재사용 또는 제한된 최초 수집 우선순위로 고친다. 전체 제품 강제 갱신·무제한 큐 채움·별도 worker·스크립트 신규 프레임워크 없이 기존 retry와 budget을 보존한다.

## 통합·리뷰·출시

- [x] 각 에이전트 결과와 수정 범위를 직접 리뷰하고 gpt-6.1-sol/xhigh read-only 독립 CLI 리뷰를 실행한다. 발견사항을 반영하고 git diff --check로 변경 형식을 확인한다.
- [x] 필요한 코드 변경을 PR별 커밋·푸시, 정상 PR을 통해 최신 base 필수 CI check 성공 후 일반 merge한다. 보고만 필요한 PR은 불필요한 코드로 만들지 않는다.
- [x] 기존 운영 승인 범위의 배포가 필요한 변경은 README/worker runbook에 따라 해당 역할·웹을 반영하고 런타임과 공개 GET만 확인한다. GitHub flags/인증키/중단 소개검수를 보존한다.
- [x] docs/CODEX_HANDOFF.md와 프로젝트 일지에 실제 결과·파일·실행 확인·미실행 테스트·남은 작업·다음 명령을 기록하고 최종 보고한다.
