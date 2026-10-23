# PR-08 Sonnet 기본 검수를 유지한 needs_editor 명시 재진입

상태: **구현 완료 · scoped 검증 통과** · 제안 브랜치: `feat/qwen-first-intro-recheck` · 설계 기준: `c37ae82f`

선행 PR: [PR-01](PR-01-contracts-evaluation.md), [PR-02](PR-02-direct-capacity.md), [PR-04](PR-04-work-uptime-candidates.md), [PR-06](PR-06-qwen-screen-prompts.md). 이 번호는 설계 순번이며 GitHub PR 번호가 아니다.

03은 M1 route 활성화에만 필요하며 GPU 구현의 선행 조건은 아니다.

## 문제와 결과

pendingIntroChecks는checkedTagline이같고성공처리된needs_editor를다시선택하지않는다.프롬프트교체만으로기존적체가재진입하지않는다.

입력은needs_editor의현재checkedTagline·원문·작성자/보호메타데이터와보강근거다. Qwen은keep/rewrite_candidate/human을제안한다. 최종교정은기존저장함수의원문·설명·출처·소유권·현재check 비교와규칙으로결정한다.

## 수정 범위

- 기존Sonnet product-intro-check는유지하고needs_editor에대한명시적보강요청·중복방지·재검수소비자를추가한다.
- 기존README와화면근거를보강해M1 Qwen우선/GPU공유큐가사실판정·교정후보를제공한다.
- 작성자·claimedAt·active maker·taglineSource·원문세대·lease보호는서버에서유지한다.
- 판정·교정문작성·최종적용을나누고기존decideIntro와저장검증을통과할때만교체한다.
- common consumer의 intro handler와 명시적 enqueue plan/apply 경로를 추가한다. 기존 Sonnet job을 새 모델로 대체하지 않는다. 107건은 문서 관측값이며 실행 시 현재 적격 건을 다시 산출한다.

## 포함하지 않는 변경

- Sonnet기본검수교체
- 메이커주장중립화
- placeholder/MAKER_JUNK조건확대
- 에러시도수를초기화해무한재검수

## 파일과 데이터 변경

기존 파일:

- [lib/domain/products/intro-check.ts](../../../lib/domain/products/intro-check.ts)
- [lib/domain/products/intro-checks.ts](../../../lib/domain/products/intro-checks.ts)
- [lib/domain/products/intro-editor.ts](../../../lib/domain/products/intro-editor.ts)
- [lib/jobs/products/intro-check.ts](../../../lib/jobs/products/intro-check.ts)
- [lib/domain/products/intro-check-model-capacity.ts](../../../lib/domain/products/intro-check-model-capacity.ts)
- [lib/screen-review/](../../../lib/screen-review)

신규 제안 파일:

- `lib/jobs/products/intro-editor-assist.ts` (신규 제안 경로, 구현 시 확정)

Migration: 있음:04의 kind·typed payload/binding을 intro_recheck로 가산 확장한다. 기존 product_intro_checks 성공행·attempts·original 문구는 유지하며 새 요청·버전·원결과 참조는 공통 원장을 사용한다. 실제 번호는 구현 시 최신 main의 journal을 확인해 배정한다.

## 검증과 완료 조건

다음은 실행 결과가 아닌 구현 시 검증 항목이다. PR별로 관련 회귀·정적 검사만 수행하고 GitHub 필수 CI를 유지한다.

- tests/intro-check.test.ts
- tests/integration/intro-check.test.ts
- tests/integration/intro-requests.test.ts
- 신규: 성공needs_editor재진입·중복요청·동시Sonnet/사람편집·maker보호·화면근거불일치·보강실패보류

완료 조건:

- 동일소개needs_editor를명시요청으로한번재진입시킨다.
- 그사이사람편집·메이커등장·소개변경·lease상실시결과를버린다.
- 기존Sonnet처리와claimedAt/active-maker/메이커wrong보호·placeholder예외의동작을보존한다.
- 새 job 또는 실행 줄을 추가하면 lib/jobs/catalog.ts, lib/jobs/registry.ts, scripts/worker.ts의 등록·시간 예산·lane 및 역할별 DB 풀/host budget을 같이 검토한다.
- lib/operations/stage-registry.ts의 단계 또는 제외 사유, app/(operator)/admin/status/work-owners.ts의 JOB_HOW, attention.tsx의 work 연결을 함께 맞춘다.
- tests/job-catalog.test.ts, tests/stage-registry.test.ts, tests/operations-work-owners.test.tsx와 관련 운영센터 회귀를 실행한다.
- 기존 admin-job-control의 legacy/versioned/draining 지원 범위를 따른다. pause가 신규 claim을 멈추는지, 진행 중 원격 호출·pending·capacity 점유가 어떻게 drain되는지 표시·회귀 검증한다. 실제 계속 도는 소비자를 멈춤으로 표시하지 않는다.
- 원 업무(originJob/task) pause도 공통 소비자의 해당 queued work에 적용한다. claim/dispatch 확정 시 제어를 확인하고, 다른 업무·이미 in-flight 호출·resume 동작을 별도로 회귀 검증한다.
- backend와 기반 모델 정체성을 구분해 GPU/M1의 용량은 따로, 같은 Qwen family의 독립 감사 자격은 같게 판정한다.

## 적용 전 확인

- 실제needs_editor에서근거보강이해결한건·계속불명인건·의미가변한교정안을사람이검토한다. 근거없는기능추가와작성자보호위반은별도실패로집계하고자동안내기준은실측후정한다.

## 중단과 되돌림

- 보강재진입consumer만끄고기존Sonnet과사람편집흐름을유지한다. 이미바뀐소개는기존originalTagline/originalSource/originalDescription과추가감사로검토한다.

공통 정책·실데이터 평가·운영 전환 조건은 [전체 계획](README.md)을 따른다. PR 병합을 운영 쓰기·배포·기능 활성화 승인으로 간주하지 않는다.

## 실제 공통 소비자 통합

명시needs_editor 요청→새page/README/화면수집→Qwen사실판정→별도native 교정문 생성→현재사진CAS/기존decideIntro 적용을 연결했다. 서로다른두request의실제settled·입력/wire/response/contracthash를검증한다. 같은TX에서첫사실결과를기록하고원Sonnet행·attempts·original*는보존한다. 실제 DB/localhost 모델HTTP 신규12+기존23=35건, 공통unit32건, ESLint·Nexttypegen·tsc 통과. 순환import로schema가미초기화되던실패를z.lazy로수정한뒤재검증했다. raw README는실제URL을유지하며현재GitHub저장소의정확한HEAD/README.md대응만가산허용한다. 기본off,실모델·운영DB·배포·활성화는하지않았다.
