# PR10 비활성 번역 초안 backend 연결

이 구현은 공식 원문을 보존하는 한국어 **초안 저장** backend다. 제품 결정과 실제 공식 뉴스의 사람 검수 전 공개 번역 선택은 제공하지 않는다. `NEWS_LOCALIZATION_BACKEND_ENABLED`의 기본값은 off이며, 명시적 `true`와 common news task의 dispatch가 모두 필요하다. 이 플래그의 활성화나 기존 585건 일괄 처리는 이번 구현에 포함하지 않는다.

## 부모가 소유하는 공통 변경

- `lib/db/schema.ts`에서 `newsLocalizations`를 export하고 migration journal에 `0123_news_localization_drafts`를 등록한다. 이 agent는 두 공유 파일을 수정하지 않았다.
- `AssistWorkTask`와 control/work task check에 `news`를 추가한다. 새 control은 mode=`off`, dispatch/apply=`false`로 seed한다.
- `llm_assist_work.product_id`를 nullable로 바꾸고 `news_item_id integer REFERENCES news_items(id) ON DELETE CASCADE`를 추가한다. `task='news'`면 product가 null/news가 nonnull이고 그 외 task면 그 반대인 typed-target check를 둔다.
- 기존 product 대상 unique/active unique는 유지한다. news 대상 `(task,news_item_id,source_hash)` unique 및 `(task,news_item_id) WHERE state IN ('claimed','indeterminate')` active unique를 추가한다. source는 `newsLocalizationCandidateSchema`의 `{kind:'news',locale:'ko',news:{…}}`다.
- claim의 product/health-only join을 task별로 분기한다. news는 현재 `news_items`의 raw `decided_at::text`, `created_at::text`, title/summary/url/state를 source와 대조하며 hidden을 claim하지 않는다. source hash를 SQL JSON 재직렬화로 만들지 말고 `newsLocalizationSourceHash`를 사용한다.
- control revision, origin job pause, claim ownership, capacity request의 실제 terminal, contract/input/prompt/response hash와 backend/model 계보는 common consumer가 검증한다. 모델 confidence는 권한이 아니다.

## producer와 same-TX 결과 저장

`enqueueNewsLocalizationDemand(tx,newsItemId,deps)`의 deps는 `readAssistControl('news',tx)`, `lockNewsLocalizationSource`, common 큐의 `enqueueWork`다. 단일 article의 명시적 수요를 합치며 모델 호출을 하지 않는다. 원문 hidden은 거절하고 pending은 pending 상태를 보존한 초안 수요로만 만든다. 기존 `news-refresh`에는 동기 모델 호출을 추가하지 않는다. 새로운 실행 job은 등록하지 않았다.

common consumer는 `llm_assist_results`를 insert한 **같은 TX**, 아직 claim을 보유한 상태에서 `recordNewsLocalizationCompletion`을 호출한다. `loadSource`는 `lockNewsLocalizationSource`, `saveDraft`는 `saveNewsLocalizationDraft`를 연결한다. 이 hook은 source generation/control을 다시 검사하고 결과를 `draft` 또는 `needs_review`로만 저장한다. 검증 통과는 `bounded_patterns`/`translation_candidate_only`이며 의미 정확도 전반이나 게시 승인이 아니다. shadow의 초안 보관은 공개 apply와 구분한다. applyEnabled나 confirm이 켜져도 이 API가 게시 권한을 발급하지 않는다.

completion의 `sourceHash`는 news source hash이며 `inputHash`는 `assistInputHash(buildNewsLocalizationInput(source))`다. `modelId`는 serving contract의 실제 모델 ID를 전달하고 backend ID와 model family를 별도 필드에 보존한다. `resultId`를 PK/FK로 사용해 terminal 중복 전달은 한 번만 저장한다. source·result·work 삭제는 FK cascade한다.

`originalNewsLocalizationFallback`은 항상 공식 title/summary를 반환한다. public/admin 화면과 news-refresh는 이번 변경으로 연결하지 않았으며 원문 상태 쓰기도 없다. 0123 SQL은 이 초안 테이블만 생성하고 공통 target 확장은 부모 통합 단계에서 함께 반영한다.

## 실제 검증 범위

관련 단위 회귀·ESLint·TypeScript만 수행한다. DB migration의 실제 실행, 공통 queue/typed-target 통합 DB 회귀, 실모델 호출, 실제 뉴스의 의미 정확도 평가는 아직 수행하지 않았으며 기존 261회 요청 결과를 승계하지 않는다. 날짜는 ISO·영문 전체 월명·한글 년월일의 명시적 형식만 지원하고 모호한 숫자 날짜는 보류한다. 한정·공개범위·가격 문장도 유한한 패턴의 검증이며 모든 가능한 자연어를 판정하지 않는다.
