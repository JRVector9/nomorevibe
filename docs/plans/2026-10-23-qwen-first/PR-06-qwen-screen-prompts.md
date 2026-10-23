# PR-06 운영 Qwen v3와 화면 shot2의 정책 범위·근거 출처를 바로잡는다

상태: **구현·관련 단위 검증 완료 · 실제 모델 평가/운영 전환 전** · 브랜치: `feat/qwen-first-qwen-screen-prompts` · 구현 기준: `12fbf0bc`

선행 PR: [PR-01](PR-01-contracts-evaluation.md). 이 번호는 설계 순번이며 GitHub PR 번호가 아니다.

## 문제와 결과

운영 Qwen v2의 pageText 우선 문장이 installable 예외와 충돌할 수 있고, 화면 note는 실제로 교체하지 않은 본문도 렌더링 본문이라고 설명한다.

website/installable 조건을 분리한 새 Qwen v3와 crawler/rendered 본문을 출처·시각별로 전달하는 shot2를 평가한다. 기존 v2/shot1을 같은 버전 이름으로 덮어쓰지 않는다.

## 수정 범위

- 공통 적격성 정책을 유지하고 website에 해당하는 Page-first 지침만 범위를 명확히 한다. 홈페이지가 없는 installable은 현재 README·설치형 요건으로 평가한다.
- crawler_page_text와 rendered_page_text, 각 관측 시각·완전성·이미지 해시를 별도 전달한다. 긴 옛 본문을 현재 화면의 근거로 단정하지 않는다.
- Qwen v3/shot2의 prompt source·hash·wire·캐시·결과 recordedModel·운영 표시를 함께 버전 관리한다. 시험용 exploratory-v2와 운영 v3는 다른 산출물이다.
- 새 판은 명시 선택 전 기존 운영 경로에 적용하지 않는다. 기존 의견의 삭제·덮어쓰기나 918건 일괄 적용을 포함하지 않는다.
- 기존 화면 검수는 틱당1건과0.95 기준을 보존한다. M1 렌더 주소와 추론 backend를 별도 운영 표시한다.

## 포함하지 않는 변경

- 적격성·별 수·placeholder 규칙 완화
- 화면 틱당1건·기존0.95 기준 변경
- 기존 결과와 새 결과의 무조건 교체

## 파일과 데이터 변경

기존 파일:

- [lib/crawl/qwen-direct-review.ts](../../../lib/crawl/qwen-direct-review.ts)
- [lib/crawl/agent-review.ts](../../../lib/crawl/agent-review.ts)
- [lib/crawl/audit-import-sources.ts](../../../lib/crawl/audit-import-sources.ts)
- [lib/screen-review/vision-review.ts](../../../lib/screen-review/vision-review.ts)
- [lib/screen-review/job.ts](../../../lib/screen-review/job.ts)
- [lib/crawl/review-model-identity.ts](../../../lib/crawl/review-model-identity.ts)

신규 제안 파일:

- `tests/qwen-v3-policy.test.ts` (신규 제안 경로, 구현 시 확정)
- `tests/screen-review-shot2.test.ts` (신규 제안 경로, 구현 시 확정)

Migration: 목표 없음. 기존 immutable promptVersion과 결과 출처를 새 판으로 기록하며 옛 행을 수정하지 않는다. 현재 enum/CHECK가 새 출처를 제한한다면 새 값만 허용하는 가산 migration을 PR에 명시한다. 실제 번호는 구현 시 최신 main의 journal을 확인해 배정한다.

## 검증과 완료 조건

다음은 실행 결과가 아닌 구현 시 검증 항목이다. PR별로 관련 회귀·정적 검사만 수행하고 GitHub 필수 CI를 유지한다.

- tests/qwen-direct-review.test.ts, tests/integration/audit-screen-review.test.ts, tests/screen-review-client.test.ts 영향 범위
- homepage 없는 정상 installable, 실제 제품·단순 API 문서, 체크포인트·JS 미렌더와 실제 빈 제품을 고정 정책으로 구분
- 짧은 현재 오류 화면+긴 과거 본문, 빈 렌더 본문, 이미지·본문 불일치에서 출처·시각을 섞지 않는 회귀
- 운영 v2/shot1 해시 보존, 새 source hash와 cache generation, 구버전 결과의 재사용 금지

완료 조건:

- 현재 정책을 바꾸지 않고 모순된 범위·출처 설명이 해결되며 새 판의 결과·운영 표시가 구판과 구분된다.

## 적용 전 확인

- 실제 installable/website/렌더링 사례에서 기준판과 비교한다. 실제 근거·새 계약 평가를 수행한 뒤 새 판을 선택한다. 기존 261회 공통 합성 점수를 v3/shot2 성적으로 쓰지 않는다.

## 중단과 되돌림

- 새 판 선택을 중지하고 구판 의견을 보존한다. 신판으로 인한 제품 조치를 자동 복구하거나 기존 화면 의견으로 무조건 덮지 않는다.

공통 정책·실데이터 평가·운영 전환 조건은 [전체 계획](README.md)을 따른다. PR 병합을 운영 쓰기·배포·기능 활성화 승인으로 간주하지 않는다.

## 구현한 선택 경계와 출처

- `reviewWithQwenDirect(..., { promptVersion: QWEN_V3_PROMPT_VERSION })`만 텍스트 v3를 선택한다. 기존 자동 의견·held retry·판가름 호출은 기본 v2를 유지한다. 텍스트 환경변수만으로 기존 자동 경로의 판을 바꾸지 않는다.
- v3는 `2026-10-23.v3`, 출처 `qwen-v3-eval`, recordedModel의 `+prompt-v3`로 구분한다. wire 모델은 실제 호출 모델 그대로다. 정책 본문과 v2 덧붙임은 바꾸지 않았다.
- 화면은 `SCREEN_REVIEW_PROMPT_VERSION=2026-10-23.v3+shot2`를 명시할 때만 shot2를 선택한다. 생략하면 shot1이고 알 수 없는 값은 설정 오류로 호출하지 않는다. shot2 출처는 `qwen-vision-shot2-auto`, recordedModel은 `<wire 모델>+vision-shot2`다.
- shot2는 원래 crawler 본문을 교체하지 않고 렌더 본문을 별도 비신뢰 증거로 전달한다. crawler 관측 시각, 렌더 요청/수신 구간, 완전성, 최종 URL, 본문·이미지 해시가 입력 지문에 반영된다. protocol1이 주지 않는 정확한 촬영 시각과 crawler 완전성은 `null`이다.
- 결과와 관측의 판·출처·wire hash·input hash·cache generation을 구분하고 운영 화면에 렌더 서버와 모델 서버를 따로 표시한다. 구판의 성공/실패 캐시를 신판 관측으로 재사용하지 않는다. 기존 의견을 지우거나 다시 큐에 넣는 일괄 재판정은 추가하지 않았다.
- 같은 가중치의 `+prompt-v3`·`+vision-shot2` 기록 이름을 독립 모델로 오인하지 않도록 JS/SQL의 underlying model 정규화를 맞췄다. 기존 행/슬롯 비교용 모델 이름은 서로 구분한다.

## 이번 검증 결과

- Node 24.22.1에서 관련 단위 테스트 9개 파일, 69개 테스트 통과: 새 v3/shot2/관측 판별 캐시 회귀와 기존 direct·screen client·출처·held policy·운영 표시·보류 모델 규칙.
- 변경 파일과 신규 테스트를 포함한 범위 TypeScript 검사, 변경 TypeScript/TSX 파일 ESLint, `git diff --check` 통과.
- 초기 전체 TypeScript 검사는 `.next`의 `PageProps` 생성물 누락과 수정 중 타입 오류로 실패했다. 수정 후 범위 검사는 통과했으며 이 PR에서 전체 typegen·전체 검사 통과를 주장하지 않는다.
- 실제 LLM·운영 DB·배포는 실행하지 않았다. DB 통합 테스트와 새 판의 실제 판정 품질·분산 부하 검증은 미실행이다. 프롬프트 범위/전송 회귀 통과는 새 모델 판정 정확도나 기존 261회 점수 승계를 뜻하지 않는다.
