# PR-10 비공개 AI 소식 한국어 초안과 사실 검증

상태: **비공개 초안 backend·범위 검증 완료 · 공개 노출 제품 결정 대기** · 제안 브랜치: `feat/qwen-first-news-localization-integrated` · 설계 기준: `c37ae82f`

선행 PR: [PR-01](PR-01-contracts-evaluation.md), [PR-02](PR-02-direct-capacity.md), [PR-04](PR-04-work-uptime-candidates.md). 이 번호는 설계 순번이며 GitHub PR 번호가 아니다.

03은 M1 route 활성화에만 필요하며 GPU 구현의 선행 조건은 아니다.

## 구현 상태와 실제 검증

실제 통합 브랜치는 `feat/qwen-first-news-localization-integrated`다. GitHub PR URL은 발행 뒤 통합 담당자가 기록한다. 제품 결정 전에는 명시 수요 API `enqueueNewsLocalizationRuntimeDemand`와 공통 Qwen 소비자, `news_localizations`의 `draft/needs_review` 저장까지만 구현했다. `NEWS_LOCALIZATION_BACKEND_ENABLED`와 task 제어는 기본 off다. 공개 화면·원문 `title/summary/state` 쓰기를 연결하지 않았으며 원문 fallback을 유지한다.

news_item FK·nullable product target 제약, 기사별 active/source 고유 키, 정책을 포함한 뉴스 전용 source hash를 사용한다. 이전 기사도 현재 DB 원문 세대가 같으면 처리하며 게시 시각을 새 수집 시각으로 위조하지 않는다. 원격 종료가 불명인 기사는 새 revision으로 같은 논리 작업의 점유를 우회하지 못한다.

실제 DB/localhost 모델 HTTP native 20건이 통과했다. 정상 가격·입출력·한정·가중치 범위의 초안 저장, 의미 변형의 needs_review, pending/hidden·원문 microsecond 변경·응답 중 숨김/제어 중단·중복 수요·feature/origin/consumer 중단·잘못된 JSON·capacity 미허가·오래된 기사 보호를 확인했다. facts/backend unit 28건과 runtime 묶음 44건의 범위 검증, ESLint·Next typegen·tsc 기록이 있다. 서로 겹치는 회귀를 합산하지 않는다.

독립 리뷰에서 문서 전역 분모를 별도 가격 문장에 추정 상속하는 오류를 `2077ca93`으로 닫았다. 단위가 없는 독립 문장/절은 unsupported→needs_review다. 검증 성공도 `bounded_patterns`/`translation_candidate_only`이며 모든 자연어의 의미 정확도나 게시 승인이 아니다. 실제 뉴스 사람 검수·공개 노출 제품 결정·585건 일괄 처리는 실행하지 않았다. [backend 연결 문서](PR-10-backend-integration.md)를 함께 따른다.

## 문제와 결과

뉴스는원문title/summary만저장한다.단순번역은가격분모·출시상태·주장한정을잃을수있고문자열검사만으로잡히지않는다.

입력은원문title/summary/sourceHash/locale,출력은정규화사실과한국어후보다. 서버가가격금액/분모/단위·날짜·단계·불확실성·원문hash를검사한뒤언어별사본에저장한다.

## 수정 범위

- 공식 원문과 수집을 보존하며 비공개 초안의 명시 수요를 추가한다. 공개 조회 연결은 제품 결정 뒤 수행한다.
- M1우선/GPU여유슬롯에서원문명·가격분모/입출력·날짜·출시단계·공개범위·한정을정규화하고제목/요약을작성한다.
- 소스해시·모델·프롬프트버전으로구식결과를거르고원문상태approved/pending/hidden을번역이바꾸지못하게한다.
- 한국어노출과원문fallback은제품결정에맞춰조회계층에서선택한다.
- 제품 결정 항목은 한국어 노출 위치·요약 범위·게시 검수 방식이다. 결정 전에는 비공개 draft/needs_review 저장까지만 구현하고 공개 노출·585건 일괄 처리는 하지 않는다.
- 공통 work의 news_item 대상은 typed FK/제약으로 확장하고 기존 product 대상의 무결성을 유지한다. 기존 news-refresh에는 모델 대기를 추가하지 않는다.

## 포함하지 않는 변경

- 제품결정전공개노출
- news-refresh안에동기모델호출
- 585건을매번전량DeepSeek검토
- 원문제목/요약·공개상태덮어쓰기

## 파일과 데이터 변경

기존 파일:

- [lib/news/refresh.ts](../../../lib/news/refresh.ts)
- [lib/news/repository.ts](../../../lib/news/repository.ts)
- [lib/db/news-schema.ts](../../../lib/db/news-schema.ts)
- [lib/jobs/products/translations.ts (기존번역소스해시/시간예산패턴참고)](../../../lib/jobs/products/translations.ts)
- [app/(public)/[locale]/(content)/page.tsx](../../../app)
- [app/(operator)/admin/news/NewsBoard.tsx](../../../app)

신규 제안 파일:

- `lib/jobs/news/translations.ts` (신규 제안 경로, 구현 시 확정)

Migration: `0123_news_localization_drafts.sql`. news_localizations와 news_item target/FK·source/active 고유 키·binding을 가산 확장한다. news_items 원문·공개 상태를 덮어쓰지 않는다.

## 검증과 완료 조건

다음은 실행 결과가 아닌 구현 시 검증 항목이다. PR별로 관련 회귀·정적 검사만 수행하고 GitHub 필수 CI를 유지한다.

- tests/news-normalize.test.ts
- tests/integration/news.test.ts
- 신규: sourcehash변경·중복locale요청·hidden보호·원문fallback·가격분모·출시미래/연기·모델가중치와학습데이터구별·원문내지시문

완료 조건:

- 가격분모·입출력·예정/베타/연기·최대치/미재현이본문에보존된다.
- 부정문·음역을단순금지문자열만으로실패처리하지않는다.
- 원문변경중완료된번역이공개되지않고hidden뉴스가번역으로복구되지않는다.
- 기존작업예산내항목수로비동기처리한다.
- 새 job 또는 실행 줄을 추가하면 lib/jobs/catalog.ts, lib/jobs/registry.ts, scripts/worker.ts의 등록·시간 예산·lane 및 역할별 DB 풀/host budget을 같이 검토한다.
- lib/operations/stage-registry.ts의 단계 또는 제외 사유, app/(operator)/admin/status/work-owners.ts의 JOB_HOW, attention.tsx의 work 연결을 함께 맞춘다.
- tests/job-catalog.test.ts, tests/stage-registry.test.ts, tests/operations-work-owners.test.tsx와 관련 운영센터 회귀를 실행한다.
- 기존 admin-job-control의 legacy/versioned/draining 지원 범위를 따른다. pause가 신규 claim을 멈추는지, 진행 중 원격 호출·pending·capacity 점유가 어떻게 drain되는지 표시·회귀 검증한다. 실제 계속 도는 소비자를 멈춤으로 표시하지 않는다.
- 원 업무(originJob/task) pause도 공통 소비자의 해당 queued work에 적용한다. claim/dispatch 확정 시 제어를 확인하고, 다른 업무·이미 in-flight 호출·resume 동작을 별도로 회귀 검증한다.
- backend와 기반 모델 정체성을 구분해 GPU/M1의 용량은 따로, 같은 Qwen family의 독립 감사 자격은 같게 판정한다.

## 적용 전 확인

- 실제공식뉴스로사람이사실보존을검수한다. substring통과율과의미정확도를분리하고원문이름·가격단위·출시단계·한정의의미오류를별도집계한다. 제품결정과검수전노출은비활성화한다.

## 중단과 되돌림

- 번역consumer/노출을끄면원문title/summary로fallback한다. 원문과번역이분리되어역migration없이동작을되돌린다.

공통 정책·실데이터 평가·운영 전환 조건은 [전체 계획](README.md)을 따른다. PR 병합을 운영 쓰기·배포·기능 활성화 승인으로 간주하지 않는다.
