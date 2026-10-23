# PR-10 제품 결정 후 AI 소식 한국어 제목·요약

상태: **조건부: 제품 결정 뒤 착수** · 제안 브랜치: `feat/qwen-first-news-localization` · 설계 기준: `c37ae82f`

선행 PR: [PR-01](PR-01-contracts-evaluation.md), [PR-02](PR-02-direct-capacity.md), [PR-04](PR-04-work-uptime-candidates.md). 이 번호는 설계 순번이며 GitHub PR 번호가 아니다.

03은 M1 route 활성화에만 필요하며 GPU 구현의 선행 조건은 아니다.

## 문제와 결과

뉴스는원문title/summary만저장한다.단순번역은가격분모·출시상태·주장한정을잃을수있고문자열검사만으로잡히지않는다.

입력은원문title/summary/sourceHash/locale,출력은정규화사실과한국어후보다. 서버가가격금액/분모/단위·날짜·단계·불확실성·원문hash를검사한뒤언어별사본에저장한다.

## 수정 범위

- 제품결정후공식원문과수집을보존하며독립된한국어번역수요큐를추가한다.
- M1우선/GPU여유슬롯에서원문명·가격분모/입출력·날짜·출시단계·공개범위·한정을정규화하고제목/요약을작성한다.
- 소스해시·모델·프롬프트버전으로구식결과를거르고원문상태approved/pending/hidden을번역이바꾸지못하게한다.
- 한국어노출과원문fallback은제품결정에맞춰조회계층에서선택한다.
- 제품 결정 항목은 한국어 노출 위치·원문 fallback·요약 범위·게시 검수 방식이다. 결정 전에는 계약·fixture 초안까지만 가능하며 공개 노출·585건 일괄 처리는 하지 않는다.
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

Migration: 있음:news_translations(제안)의 item FK·locale·source hash·한국어 사본·검증/모델/판 버전과 고유 키를 추가하고 공통 큐의 news_item target/kind·binding을 가산 확장한다. news_items 원문·공개 상태를 덮어쓰지 않는다. 실제 번호는 구현 시 최신 main의 journal을 확인해 배정한다.

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
