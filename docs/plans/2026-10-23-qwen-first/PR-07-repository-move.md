# PR-07 저장소 공식 이전 확인과 안전한 주소 변경 후보

상태: **도메인·생산자 구현 및 범위 검증 완료 · 공통 consumer 통합 대기** · 브랜치: `feat/qwen-first-repository-move` · 설계 기준: `c37ae82f`

구현 경계·연결 함수·실행한 검증은 [개발 기록](../../operations/2026-10-23-repository-move-development.md)에 있다. 공식 GitHub redirect가 확인된 단일 후보만 주소 변경 후보로 인정하며, 실제 자동 적용은 기본 off다. 실데이터 평가·운영 적용은 수행하지 않았다.

선행 PR: [PR-01](PR-01-contracts-evaluation.md), [PR-02](PR-02-direct-capacity.md), [PR-04](PR-04-work-uptime-candidates.md). 이 번호는 설계 순번이며 GitHub PR 번호가 아니다.

03은 M1 route 활성화에만 필요하며 GPU 구현의 선행 조건은 아니다.

## 문제와 결과

현재decideGoneRepository는살아있는관련저장소를human으로만보내며,이름·포크만으로자동주소변경하면다른프로젝트로잘못연결될수있다.

입력은옛URL·제품세대·새저장소근거,출력은관계판정과변경후보다. URL수정은서버가현재oldURL·세대·공식이전근거를비교한CAS/트랜잭션으로만수행한다.

## 수정 범위

- GPU·M1공유비동기큐에서옛/새README·제품설명·공식링크·저자연속성을비교한다.
- project_identity/code_lineage/official_continuity를별도판정하고비공식포크는보류한다.
- 공식이전이검증된same_project만URL변경후보로만든다. 실제자동갱신과사람확인표시방식은정책확정후활성화한다.
- unrelated도기존내림한도·운영자keep·현재저장소상태의서버재검증을거친다.
- 공통 consumer의 repo handler를 등록한다. 생산자는 기존 product-repo-review에 둬 새 text lane을 만들지 않는다. M1 사설 경로 준비 전 GPU부터 검증한다.

## 포함하지 않는 변경

- 모든살아있는링크를공식이전으로간주
- MAX_RELATED_LINKS·pageConclusive·내림한도완화
- 새text lane/role중복추가

## 파일과 데이터 변경

기존 파일:

- [lib/domain/products/repo-review.ts](../../../lib/domain/products/repo-review.ts)
- [lib/domain/products/repo-reviews.ts](../../../lib/domain/products/repo-reviews.ts)
- [lib/jobs/products/repo-review.ts](../../../lib/jobs/products/repo-review.ts)
- [lib/domain/products/repository.ts](../../../lib/domain/products/repository.ts)
- [lib/db/schema.ts (productRepoReviews)](../../../lib/db/schema.ts)

신규 제안 파일:

- `lib/domain/products/repo-move-review.ts` (신규 제안 경로, 구현 시 확정)

Migration: 있음:04의 task kind·typed payload/binding 제약을 repo_move로 가산 확장한다. 기존 product_repo_reviews.answers 형식은 유지하고 새 판정은 공통 결과 원장에 저장한다. 제품 GitHub 연결·이전 이력의 추가 컬럼이 필요하면 해당 nullable 변경만 이 PR에서 소유한다. 실제 번호는 구현 시 최신 main의 journal을 확인해 배정한다.

## 검증과 완료 조건

다음은 실행 결과가 아닌 구현 시 검증 항목이다. PR별로 관련 회귀·정적 검사만 수행하고 GitHub 필수 CI를 유지한다.

- tests/repo-review.test.ts
- 신규integration: 공식이전후URL CAS·비공식fork무수정·동명무관저장소·다중링크미확인·관측불명·일일한도·operator_keep
- tests/operations-work-owners.test.tsx
- tests/stage-registry.test.ts

완료 조건:

- 공식이전·저자연속성·비공식포크·의존라이브러리·이름중복을구분한다.
- 오래된결과나그사이운영자수정은URL변경/내림을못한다.
- MAX_REPO_GONE_DELISTS_PER_DAY=100과operator_keep를보존한다.
- 새 job 또는 실행 줄을 추가하면 lib/jobs/catalog.ts, lib/jobs/registry.ts, scripts/worker.ts의 등록·시간 예산·lane 및 역할별 DB 풀/host budget을 같이 검토한다.
- lib/operations/stage-registry.ts의 단계 또는 제외 사유, app/(operator)/admin/status/work-owners.ts의 JOB_HOW, attention.tsx의 work 연결을 함께 맞춘다.
- tests/job-catalog.test.ts, tests/stage-registry.test.ts, tests/operations-work-owners.test.tsx와 관련 운영센터 회귀를 실행한다.
- 기존 admin-job-control의 legacy/versioned/draining 지원 범위를 따른다. pause가 신규 claim을 멈추는지, 진행 중 원격 호출·pending·capacity 점유가 어떻게 drain되는지 표시·회귀 검증한다. 실제 계속 도는 소비자를 멈춤으로 표시하지 않는다.
- 원 업무(originJob/task) pause도 공통 소비자의 해당 queued work에 적용한다. claim/dispatch 확정 시 제어를 확인하고, 다른 업무·이미 in-flight 호출·resume 동작을 별도로 회귀 검증한다.
- backend와 기반 모델 정체성을 구분해 GPU/M1의 용량은 따로, 같은 Qwen family의 독립 감사 자격은 같게 판정한다.

## 적용 전 확인

- 실제repo_link_alive와공식rename·포크·템플릿·의존라이브러리표본으로잘못된URL교체율과기권율을독립검토한다. URL자동적용은false update 검토와정책승인전까지끄고후보만보인다.

## 중단과 되돌림

- LLM보강과주소자동적용을끄고기존human흐름으로돌린다. 이미변경한URL은이전URL·세대·감사근거로검토하고운영자변경을덮지않는다.

공통 정책·실데이터 평가·운영 전환 조건은 [전체 계획](README.md)을 따른다. PR 병합을 운영 쓰기·배포·기능 활성화 승인으로 간주하지 않는다.
