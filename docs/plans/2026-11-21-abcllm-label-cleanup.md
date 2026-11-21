# abcllm 이름표 제거와 「API 주소 + 모델」 직접 연결 구조 — 계획 (2026-11-21)

소유자 결정(2026-11-21): **「abcllm은 다 제거하고 장비이름 쓰지말고 API 주소로, 모델에 바로 연결하는 구조로 진행해」.**

이 문서는 **계획만** 담는다(코드·운영 데이터 변경 0). 기준은 origin/main `c390c6b7`.
코드는 읽어서 확인했고 전체 시험은 돌리지 않았다. 운영 값은 조정자가 2026-11-21 에 읽기 전용으로 확인한 것만 적었다.
공개 저장소라 주소·호스트 이름은 쓰지 않고 「M3 Ultra :8010」 같은 기기 이름으로만 가리킨다(설계 안에서는 그 자리에 「API 주소」가 들어간다).

표기: **[코드]** 코드를 읽어 확인 · **[운영]** 조정자가 읽기 전용으로 확인 · **[미확인]** 확인하지 못함(무엇으로 확인하는지 함께 적음).
「조정자」는 이 작업을 맡아 운영을 읽고 실행하는 쪽(오케스트레이터)이다.

## 1. 결론

1. **env 는 이미 끝났다.** `ABCLLM_*`·`PRODUCT_TRANSLATION_MODEL`·`CRAWL_REVIEW_MODEL` 을 읽는 실행 코드는 main 에 없다. 남은 것은 시험 stub 과 문서, 그리고 운영 앱 env 에 이름이 남아 있는지 확인하는 일뿐이다(3.3절).
2. **남은 abcllm 은 「이름표」다.** 운영 호출은 전부 엔진에 바로 가지만(transport direct), 계약의 `provider`·`protocol`, 장부 행의 `provider`, 용량 정책 route, 심사 기록의 `provider` 에 `abcllm` 이 적힌다. 실행 코드에 문자열 `"abcllm"` 이 225곳 있다.
3. **장부 규칙은 새로 만들 필요가 거의 없다.** 열 경로 모두 장부 규칙에 `local-direct` 가지가 이미 있다(0132·0157·0161·0166·0184·0190). 그래서 새 provider 이름을 만들지 않고 **`local-direct` 하나로 모은다.** 새 이름을 만들면 여섯 검사 × 열 경로의 가지를 전부 다시 써야 한다.
4. **막는 것은 계약 모양과 코드의 가정이다.** 지금 `local-direct` 직접 계약(`direct-openai-chat-v1`)은 tokenizer 주소·장비 이름 칸을 요구하고 wire 도 다르다. tokenizer 는 gpu3090·Supa·M3 Ultra :8010 에만 있다 [운영]. 그래서 **tokenizer 가 없어도 되는 직접 계약 모양을 하나 새로 두고**(지금 abcllm 계약이 쓰는 총량 상한 계량 그대로) 열 경로가 그것만 쓰게 한다.
5. **순서는 「새 모양을 읽을 수 있게 → 저장을 새 모양으로 → 계약을 다시 저장(운영 데이터) → abcllm 코드 삭제 → 장비 이름을 API 주소로 → 뒷정리」** 다. 각 단계는 PR 하나 또는 운영 데이터 한 번이다(7절).
6. **끝까지 남는 abcllm 은 지난 기록뿐이다** — 마이그레이션 파일, 장부 규칙 행의 옛 가지, 아직 지워지지 않은 장부 행을 읽는 좁은 읽기 코드, 심사·감사 기록의 옛 값(6절).

## 2. 지금 구조 (코드로 확인)

### 2.1 모델을 고르고 부르는 길이 겹쳐 있다

| 층 | 무엇 | 열쇠 | 위치 |
| --- | --- | --- | --- |
| AI 연결 | API 주소(`…/v1`) + 키, 또는 CLI 도구 | 주소가 유일(`ai_connections_base_url_idx`) | `lib/db/operations-schema.ts:718-750` |
| 작업 ↔ 모델 순위 | (작업, 칸, 순위) → (연결, 모델) | 연결 id + 모델 이름 | `lib/db/operations-schema.ts:757`, `lib/llm/ai-tasks.ts:99-167` |
| 서빙 계약 | 경로·모델마다 켜진 계약 한 행 | (route_id, model) | `lib/db/operations-schema.ts:649-671` |
| 용량 정책 route | (경로, provider, 모델) → 예산·장비 | `providerBudgetId`·`groupId` | `lib/llm/capacity.ts:100-101` |
| 장비 한도 | 장비 이름마다 칸 수·경로 몫·모델 상한 | `device_id` | `lib/db/operations-schema.ts:246-283`, `lib/llm/capacity-devices.ts:7-63` |
| 등록부(옛 길) | `장비:이름` 키, provider, 주소, 장비 표지 | `equipment` | `lib/llm/model-registry.ts:45-72` |

소유자가 정한 목표는 위의 첫 두 줄이다 — **연결(API 주소) + 모델**. 2026-11-02 결정(「모든 AI 작업 1·2·3순위, API 주소나 CLI 로만」)으로 text 일곱 작업·1차·2차는 이미 순위 표를 읽는다(`lib/llm/ai-tasks.ts:8`). 나머지 층이 `abcllm` 이름표와 장비 이름을 들고 있다.

### 2.2 provider 가 정해지는 한 곳

- text 일곱 경로: 각 경로의 용량 호출 코드가 `<경로>ServingProvider(model)` 을 부른다(예: `lib/crawl/tagline-model-capacity.ts:34`, `lib/domain/products/product-translation-model-capacity.ts:43`). 그 함수는 `servingContractProvider` 다 — **abcllm 계약이 있으면 abcllm, 없고 local-direct 계약이 하나 닿으면 local-direct, 둘 다 없으면 abcllm**(`lib/llm/direct-serving-contract.ts:94-97`).
- 순위로 부를 때는 그 순위가 가리키는 계약 행의 provider 를 쓴다. 같은 연결·모델의 계약이 둘이면 abcllm 형을 먼저 고른다(`lib/llm/ai-task-resolver.ts:123-128, 208`, `lib/crawl/review-task-ranks.ts:73-74, 107`).
- 준비(prepare)는 요청 행의 provider 와 계약의 provider 가 다르면 보내지 않고 `provider_contract_unavailable` 로 미룬다(`lib/crawl/agent-review-gateway.ts:786, 878, 987, 1081, 1175, 1264, 1365`, 2차 `:609`). 그래서 **계약을 바꾸는 순간 줄에 서 있던 옛 provider 요청은 보내지지 않고 닫힌다**(안전한 쪽).

### 2.3 계약 모양 셋

| 모양 | provider | 쓰는 경로 | 특징 |
| --- | --- | --- | --- |
| 총량 상한(`abcllm-*-total-bound-v1`, 8종) | `abcllm`(1차만 `local-direct` 도 받음) | 열 경로(운영의 전부) | 주소·모델·`totalTokenBound` 만. `engineModel`·`reasoningTokenReserve`·`rateLimitBackoff`·`strictTerminalOptIn` 선택 칸 |
| 직접(`direct-openai-chat-v1`) | `local-direct` | 열 경로가 받기는 한다 | `tokenizerEndpoint`·`backendId`·`physicalGroup`·`requestTokenBound`(32000 고정)·`maxOutputTokens` 필수 |
| 로컬(`local-openai-chat-v1`) | `local-direct` | `local-*` 경로(사람 몫 위임·감사·보강 등) | `backendId`·`physicalGroup`·`modelFamily`·`thinking`·`termination` |

위치: `lib/llm/*-serving-contract.ts`(경로별 8개), `lib/crawl/agent-review-serving-contract.ts:11-31`, `lib/crawl/second-review-serving-contract.ts:15-42`, `lib/llm/direct-serving-contract.ts:33-49`, `lib/llm/local-model-serving-contract.ts:9-48`.

**두 길의 차이**(같은 엔진에 보내더라도 다르다) [코드]:

| 항목 | 총량 상한(지금 운영) | 직접(`direct-openai-chat-v1`) |
| --- | --- | --- |
| 장부 계량 | `totalTokenBound`(C) 전부 | 같다 — C 를 계량한다(`direct-serving-contract.ts:8-9`) |
| 보내기 전 확인 | 없음(2차만 `requestBudget` 이 있으면 tokenizer) | 엔진 `/tokenize` 로 입력 + 출력 상한 ≤ 32000 확인, 못 받으면 `tokenizer_unavailable` 로 미룸(`agent-review-gateway.ts:279-293`, 1차 `:486`, 2차 `:612-614`) |
| wire | 경로의 wire 그대로 — `context_strategy:"raw"`·`reasoning_effort:"low"` 포함(`agent-review-gateway.ts:153-170`) | 그 두 칸을 빼고, text 는 `enable_thinking:false` 강제·`max_tokens` 를 계약 상한으로 자른다(`:176-182, 211-221`) |
| 엔진에 보내는 이름 | `engineModel` 이 있으면 그것(같은 모델을 두 연결에 둔 순위) | 계약의 `model` 뿐 — `engineModel` 칸이 없다 |
| 추론 토큰 여유·429 쉼 정책 | 계약 칸으로 받는다(사유 번역·한국어 소개) | 칸이 없다(`agent-review-gateway.ts:245`) |
| 엄격 terminal | 번역 4경로는 `strictTerminalOptIn` 표시가 있어야 열리고 `X-Abcllm-Strict-Terminal` 헤더가 **엔진에도 그대로 나간다**(`gateway-serving-contract-config.ts:19-28`, `agent-review-gateway.ts:854-855`) | 표시·헤더 없음 |
| 리다이렉트 | `manual` | `error`(`agent-review-gateway.ts:294`) |
| 키 | 계약 행의 transport 가 `direct` 여야 열린다 | 행의 표시와 무관하게 직접(`serving-contract-store.ts:263-269`) |
| CLI 엔진(OpenCode) 계약 | 이 모양만 받는다 | `local-direct` 면 던진다(`agent-review-gateway.ts:232-234`, `ai-task-workload-selector.ts:80`) |
| 관리 화면 저장 | 엔진 연결·순위 저장이 이 모양을 만든다(`admin-engine-connect.ts:147`, `admin-ai-tasks.ts:738`) | 자동으로 만들지 않는다(`admin-engine-connect.ts:140-141`) |

핵심: **장부는 두 길을 구분하지 않는다.** 장부 행에는 계약이 아니라 계약 hash 만 남고, 규칙은 provider 글자와 binding 모양만 본다. 차이는 전부 TS 쪽이다.

## 3. 「abcllm」이 지금 뜻하는 것 (재고)

c390c6b7 에서 대소문자 무시 `abcllm` 은 **575개 파일 · 2,699줄**이다: lib 83개(330줄) · app 9개(17줄) · scripts 6개 · tests 365개(1,908줄, 그중 integration 149개) · docs 78개 · drizzle 32개 · 그 밖 2개.

### 3.1 (a) 장부 identity·binding·규칙의 provider

- 장부 kind 가 받는 provider 는 `["abcllm","local-direct"]` 둘이다(`lib/llm/capacity.ts:32-36`). binding 스키마가 이 enum 을 쓴다(`capacity.ts:195-` 이하).
- 준비 함수의 기본값이 `"abcllm"` 이다 — `options.provider ?? "abcllm"`(`agent-review-gateway.ts:601, 779, 871, 980, 1074, 1168, 1257, 1358`), 장부 읽기도 같다(`lib/llm/capacity-repository.ts:354, 398, 453`).
- 옛 행을 막는 울타리: binding 이 없던 시절의 abcllm 진행 행이 있으면 새 요청을 막는다(`capacity-repository.ts:659, 1185, 1476`).
- 용량 정책 route 의 provider(`admin-ai-tasks.ts:630-631`, `lib/llm/capacity-helpers.ts:116-118`), 엔진 연결의 「정책에 없는 경로」 안내(`admin-engine-connect.ts:235-237`).
- DB 규칙: `model_capacity_check_rules` 의 ordinal 1 은 0160 이 옮긴 **옛 CHECK 전체가 한 덩어리**다(`drizzle/0160_ledger_check_rules.sql:82`). abcllm 가지는 그 덩어리 안에 글자로 들어 있다. TS 거울은 `lib/db/operations-schema.ts:187-190, 234` 와 생성 상수(`lib/llm/gateway-local-direct-sql.ts`, `gateway-local-direct-binding-sql.ts`, `publication-classify-api-sql.ts`, `japanese-product-translation-sql.ts`).
- 심사 도메인도 provider 를 identity 로 쓴다: 1차 심사자는 (provider, model) 이 정확히 같아야 같은 심사자다(`lib/crawl/first-reviewers.ts:64-70`). 2차를 여는 코드는 provider 가 `abcllm`(또는 `claude-cli`)인 1차 성공 시도를 지금 심사자 목록과 견주지 않고 받아들이고, 그 밖의 provider 는 목록에 있어야 받는다(`lib/crawl/second-review.ts:233, 252`, `second-review-input.ts:64-69`). 표의 값: `lib/db/second-review-schema.ts:19, 47`, 설정 enum `lib/crawl/settings-schema.ts:377-396`.

### 3.2 (b) 계약 protocol·스키마

- protocol 8종 + 표시 1종: `abcllm-raw-total-bound-v1`(1차·2차·검색 키워드), `abcllm-crawl-tagline-…`, `abcllm-search-verify-…`, `abcllm-reason-…`, `abcllm-product-translation-…`, `abcllm-product-tagline-ko-…`, `abcllm-websearch-query-…`, `abcllm-crawl-publish-classify-…`, 그리고 `abcllm-strict-terminal-v1`.
- 고르는 규칙: `lib/llm/direct-serving-contract.ts:75-97`. 경로 목록·엄격 terminal: `lib/llm/gateway-serving-contract-config.ts:12-28`.
- 저장 표의 옛 칸: `auth` 의 `gateway`, `transport` 의 `gateway`(기본값이 gateway — `operations-schema.ts:655-658`), 막힘 사유 `gateway_auth`(`serving-contract-store.ts:171-178`).

### 3.3 (c) env

- 실행 코드가 읽는 곳 **0** [코드]. `grep` 으로 `lib`·`app`·`scripts` 에 남은 이름은 주석 두 곳뿐이다(`lib/llm/model-registry.ts:288`, `drizzle/0147_model_serving_contracts.sql:1`). 계약 env 는 지워졌고(`gateway-serving-contract-config.ts:7-8`), text 경로는 키가 아니라 직접 계약으로 연다(`serving-contract-store.ts:185-197`).
- 조정자가 받은 10-31 메모의 항목은 모두 바뀌어 있다: `lib/crawl/jobs/tagline.ts`·`translate-reasons.ts`·`lib/operations/text-progress.ts` 에 키 확인이 없고, `lib/crawl/translate.ts:143-194`·`lib/crawl/tagline.ts:174-181` 의 옛 송신은 보내지 않고 `no_key` 로 끝나는 **죽은 길**이다.
- 닫힌 PR #758 의 내용(직접 계약으로만 열기, 다섯 env 읽기 제거)은 다른 커밋으로 main 에 들어와 있다(`bf030379`·`61248ff2`). #758 의 rev13 정책 초안은 들어오지 않았다.
- 운영 env: 11-01 창 #4 에서 다섯 이름을 16앱에서 `--retire-setting` 으로 뺐다고 기록돼 있다(`docs/operations/2026-11-01-deploy-window-4.md:12, 30`). 문서가 드는 나머지 다섯 이름(`ABCLLM_BASE_URL`·`ABCLLM_MODEL`·`ABCLLM_MODEL_KEY`·`ABCLLM_PROFILE_MODEL`·`ABCLLM_PROFILE_MODEL_KEY`, `docs/operations/deployment-fast-path.md:80-82`)이 앱에 남아 있는지는 **[미확인]** — `npm run deploy -- plan` 출력의 `scope.retiredSettingCarriers`(이름만)로 확인한다.
- 시험: `tests/text-jobs-no-key.test.ts:41-77`, `tests/setup-env.ts:19`, 배포 도구 시험(`tests/test_deploy_release.py`·`test_deploy_release_flow.py` — 폐기 이름의 예시로 쓴다).

### 3.4 (d) 관리 화면

- 서빙 계약 화면: 「abcllm 등록부 모델만 엔진 연결」(`app/(operator)/admin/models/contracts/page.tsx:31, 40-45, 68`, `actions.ts:19`), 손 입력 틀이 abcllm 계약(`ContractForm.tsx:6`).
- 설정의 제공자 선택지 「abcllm · 직접 연결 계약」(`app/(operator)/admin/settings/ModelRows.tsx:11, 67`, `changes.ts:60`), 상태 화면(`app/(operator)/admin/status/work-owners.ts:81, 255`), 모델 표(`ModelStageTable.tsx:12, 115`, `ModelRegistryTable.tsx:23`), 조회 동작(`operation-actions.ts:27, 59, 65`).
- 보기 모델: `lib/operations/admin-models-view.ts:113-134, 182, 194-195`, `admin-first-review-ranks.ts:15-21`, `admin-ai-task-current.ts:90, 208, 219`, `admin-limits-view.ts:102`. 흐름 화면은 이미 글자를 가린다(`lib/operations/conveyor-llm.ts:217-220`).

### 3.5 (e) 게이트웨이 자체를 위한 죽은 코드

- 옛 송신 두 곳(위 3.3), 코드 기본 등록부의 abcllm 항목과 장비 표지(`model-registry.ts:55-56, 69-72, 92-99, 261`), 표지 마이그레이션 스크립트(`scripts/migrate-model-registry-m1.ts:9`).
- 엄격 terminal 헤더·표시(게이트웨이 PR3 용 — 지금은 엔진에 뜻 없는 헤더가 나간다).
- 감사의 abcllm 갈래: 「게이트웨이는 종료 근거가 없어 open 이면 늘 미룬다」(`lib/crawl/jobs/product-audit.ts:128-134, 165, 179, 369`, `lib/llm/cli-capacity-admission.ts:7-8`, `pipeline-control.ts:247`).
- 1차 미리 고르기(`lib/crawl/review-routing-preset.ts:6`), 장부 밖 호환 송신(`lib/crawl/jobs/agent-review.ts:311`, `second-review-transport.ts:26`).
- 게이트웨이 앱은 멈춰 있을 뿐 지워지지 않았다 [운영].

### 3.6 (f) 시험·fixture

- tests 365개 파일 · 1,908줄. fixture 6개(`tests/fixtures/replaced-path-boundary.ts`·`replaced-provider-boundary.ts`·`provider-boundary-release.ts`·`settings-schema-55389b48.ts`·`admin-models-preview.tsx`·`llm-ops.ts`).
- 성격이 둘이다: ① 장부 규칙·마이그레이션 이력 시험(옛 가지가 그대로인지 본다 — **남긴다**), ② 지금 동작 시험(provider 를 `abcllm` 으로 쓰는 것 — 새 모양으로 옮긴다).

## 4. 장부 규칙: 어디까지 이미 있나

`lib/db/operations-schema.ts` 의 여섯 검사를 맨 위 OR 가지로 쪼개 경로·provider 를 세었다(임시 스크립트, 글자 맞추기 방식이라 **훑어보기**다 — 아래 1단계의 실제 PostgreSQL 시험이 확정한다).

| 경로 | logical | members | dispatch | terminal | events terminal | 비고 |
| --- | --- | --- | --- | --- | --- | --- |
| crawl-agent-review | 둘 다 | — | 둘 다 | 둘 다 | 둘 다 | 0157 |
| second-review | 둘 다 | — | 둘 다 | 둘 다 | 둘 다 | 0132 |
| product-search-profile | 둘 다 | — | 둘 다 | 둘 다 | 둘 다 | 0157 + 0161 |
| crawl-tagline · product-search-verify · reason-translate · product-tagline-ko · search-query-translate | 둘 다 | 둘 다 | 둘 다 | 둘 다 | 둘 다 | 0157 + 0161, 검색어 번역의 ja·han 은 0190 이 양쪽에 |
| product-translate | 둘 다 | 둘 다 | 둘 다 | 둘 다 | 둘 다 | **ja 는 local-direct 가지에만**(0184). abcllm 쪽은 0193 이 채우는 중 |
| crawl-publish-classify | 한 가지에 `provider IN ('abcllm','local-direct')` | 같음 | 같음 | 같음 | 같음 | 0166(`lib/llm/publication-classify-api-sql.ts`) |

- 보내지 않음·HTTP 거절·로컬 종료·운영자 검토 가지(`gateway_not_started`·`gateway_http_rejected`·`local_call_ended`·`operator_review`)에는 provider 글자가 없다 [코드].
- 실제 장부 끝까지 가는 local-direct 통합 시험은 검색 키워드 한 경로뿐이다(`tests/integration/text-profile-local-direct-ledger.test.ts`). 나머지 아홉 경로는 **[미확인]** — 0184 처럼 한쪽 가지만 빠진 전례가 있으므로 1단계에서 경로 × 상태 전이를 실제 PostgreSQL 로 돈다. 빠진 가지가 나오면 그때만 0194 로 덧붙인다.

**결론: `local-direct` 로 모으는 데 새 규칙이 필요하다는 근거는 지금 없다.** 새 provider 이름(예: `direct`)을 만들면 위 표의 모든 칸에 세 번째 가지가 필요하다.

## 5. 경로별: 오늘 코드로 `local-direct` 로 옮길 수 있나

조정자 프로브(2026-11-21 05:55Z 무렵, 읽기 전용, 키 없이): `GET <주소>/models`, `POST <origin>/tokenize`.

| 서버 | /models | /tokenize | 비고 |
| --- | --- | --- | --- |
| gpu3090 | 200, 상한 50000 | 200 | |
| Supa (vLLM) | 200, 상한 131072 | 200(이름·별칭 둘 다) | |
| M3 Ultra :8010 (oMLX) | 200, 모델 1개(deepseek), 상한 262144 | 200 | **gpt-oss-120b 를 이 주소로 가리키는 운영 계약은 낡아 보인다**(목록에 없고 tokenize 404) |
| M3 Ultra :8014 (mlx-serve 프록시, gpt-oss-120b) | 200, 상한 없음 | 404 | |
| M1 Studio (mlx_lm.server) | 200, 상한 없음 | 404 | |
| M1 Max | 401(키 필요) | 404 | 상한 값 [미확인] |
| M3 :3031 (OpenCode 엔진) | 프로브 호스트에서 닿지 않음 | — | [미확인] |
| EXAONE(외부 API) | 프로브 안 함(문서상 /models 없음) | 없음 | |

오늘 코드에서 「`local-direct` 로 옮긴다」는 text·2차에서는 `direct-openai-chat-v1` 을 뜻한다. 막는 것의 종류: **코드** · **장부** · **서버**(프로브로 확정) · **결정**(소유자).

| 경로 | 운영 계약 [운영] | tokenizer 되는 서버 | 오늘 옮길 수 있나 | 막는 것 |
| --- | --- | --- | --- | --- |
| product-search-verify | 5 (gpu3090·Supa·M3 :8010) | 전부 | 못 옮김 — 서버는 되지만 공통 코드에 막힘 | 코드 ①②③ |
| product-search-profile | 5 (gpu3090·M3 :8010·:8014) | :8014 빼고 | 일부만 | 서버(:8014) · 코드 ①②③ |
| crawl-tagline | 5 (Supa·M3 :8014·M1 Studio) | Supa 만 | 일부만 | 서버 · 코드 ①②③ + **④** |
| reason-translate | 4 (M3 :8010·:8014·M1 Studio) | :8010 만 | 일부만 | 서버 · 코드 ①②③⑤ |
| product-tagline-ko | 5 (M3 :8010·:8014·EXAONE) | :8010 만 | 일부만 | 서버(EXAONE 은 tokenizer·목록 없음) · 코드 ①②③⑤ |
| product-translate | 5 (M3 :8014·M1 Max·M1 Studio) | **없음** | 못 옮김 | 서버 전부 · 코드 ①②③ |
| search-query-translate | 3 (M3 :8010·:8014) | :8010 만 | 일부만 | 서버 · 코드 ①②③ |
| crawl-publish-classify | 3 (gpu3090·M3 :3031·M3 :8010) | gpu3090·:8010 | 일부만 | 서버(:3031 미확인) · 코드 ②③**⑥** |
| second-review | 5 (gpu3090·Supa·M3 :8010·:8014·M1 Max) | 앞의 셋 | 일부만 | 서버 · 코드 ②③⑦ · 결정(심사자 identity) |
| crawl-agent-review | 7 (gpu3090·Supa·M3 :8010·M1 Max) | 앞의 셋 | 총량 상한 + `local-direct` 는 스키마가 이미 받는다 | 코드 ②③⑦ · 결정(심사자 identity) |

공통·개별 코드 걸림 [코드]:

- ① **OPEN 경로 판정이 text 경로를 abcllm 으로만 본다.** `usedModelRoutes` 가 text 일곱 경로를 `add(routeId, "abcllm", model)` 로 넣고(`lib/operations/pipeline-control.ts:288-292`), 경로 표는 abcllm 스키마로만 「serving」을 판정한다(`:214-215, 232-242`). 계약이 `local-direct` 가 되면 그 경로는 `no_contract`/`unmapped` 로 읽혀 OPEN·배포 관문이 미뤄질 수 있다.
- ② **wire 가 달라진다.** `reasoning_effort` 가 빠지고 text 는 `enable_thinking:false` 가 강제된다(2.3 표). gpt-oss 계열은 추론 강도에 출력이 민감하다 — 품질·잘림을 표본으로 보지 않고는 바꾸지 않는다.
- ③ **저장 쪽이 abcllm 형만 만든다.** 엔진 연결(`admin-engine-connect.ts:147, 192`), 순위 저장(`admin-ai-tasks.ts:665, 738, 902`), 배정 표(`capacity-helpers.ts:116-118`). `direct-openai-chat-v1` 에는 `engineModel` 이 없어 같은 모델을 두 연결에 둔 순위(`모델@연결 8자`)를 표현하지 못한다.
- ④ `lib/crawl/taglines.ts:449` 가 결과를 쓸 때 장부 행의 `provider !== "abcllm"` 이면 `CrawlTaglineChanged` 를 던진다.
- ⑤ 추론 토큰 여유·429 쉼 정책 칸이 직접 모양에 없다(EXAONE 계약이 쓴다 — `product-tagline-ko-serving-contract.ts:26-30`, `reason-translation-serving-contract.ts:25-27`).
- ⑥ OpenCode CLI 엔진 계약은 abcllm 형이어야 한다(`agent-review-gateway.ts:232-234`, `ai-task-workload-selector.ts:80`, `admin-ai-tasks.ts:665-676`).
- ⑦ 1차의 직접 준비는 `engineModel` 을 쓰지 않고(`agent-review-gateway.ts:176-182, 485`), 2차의 `local-direct` 는 tokenizer 확인이 필수다(`:612-614`).

장부 쪽 걸림은 찾지 못했다(4절). product-translate 의 ja 는 `local-direct` 가지가 이미 있어 옮기면 0193 과 무관하게 통한다.

## 6. 목표 구조

### 6.1 한 줄 요약

**연결 = API 주소(+키), 호출 대상 = (연결, 모델).** 계약·용량 경로·한도는 이 둘에서 저장이 만들어 내고, 운영자가 적는 것은 주소·키·모델·동시 처리 수뿐이다. 장비 이름을 적는 칸은 없다.

### 6.2 계약: tokenizer 가 없어도 되는 직접 모양 하나

새 모양(이름은 가칭 `openai-chat-total-bound-v1`), provider 는 `local-direct`:

- 필수: `version`·`protocol`·`routeId`·`provider`·`model`·`responseModel`·`deploymentRevision`·`endpoint`·`totalTokenBound`.
- 선택: `engineModel`, `reasoningTokenReserve`, `rateLimitBackoff`, `maxOutputTokens`, 그리고 **`tokenizer` 묶음**(주소·요청 상한). tokenizer 묶음이 있으면 보내기 전에 지금처럼 확인하고, 없으면 지금 abcllm 계약처럼 **총량 상한 C 만 계량**한다.
- 없는 것: `backendId`·`physicalGroup`(장비 이름), `strictTerminalOptIn`, 게이트웨이 표지.
- wire 는 **지금 운영이 보내는 바이트 그대로**(경로의 wire + `engineModel`). 엄격 terminal 헤더만 뺀다 — 직접 연결은 이미 그 응답 표시를 요구하지 않는다(`agent-review-gateway.ts:519-522`). 다만 헤더를 실제로 읽는 서버가 있으면(0-12) 그 서버의 계약에는 선택 칸으로 남긴다. `context_strategy:"raw"` 는 게이트웨이용 칸이지만 지금도 엔진에 나가고 있으므로 이 계획에서는 그대로 둔다. 빼는 것은 서버별 표본 비교 뒤의 별도 일이다(M3 Ultra :8014 는 프록시라 그 칸을 읽는지 **[미확인]**).
- 열 경로가 같은 모양을 쓴다(경로마다 받는 선택 칸만 다르다). 2차의 `requestBudget`(tokenizer 로 32k 확인)은 `tokenizer` 묶음으로 옮긴다.

왜 `direct-openai-chat-v1` 을 고치지 않나: 저장된 계약의 hash 가 칸 순서에 묶여 있고(`direct-serving-contract.ts:29-31`), 그 모양은 장비 이름 칸을 필수로 갖는다. 새 모양을 두고 옛 두 모양은 4단계에서 지운다.

### 6.3 provider 이름

- 직접 호출은 전부 `local-direct`. CLI 는 지금처럼 `claude-cli`·`codex-cli`·`grok-cli`·`opencode-cli`.
- `local-direct` 의 「local」은 EXAONE 같은 외부 API 에는 어색하다. 화면에는 이미 「직접 연결」로만 보인다(`conveyor-llm.ts:220`). 글자를 바꾸려면 4절의 모든 칸에 새 가지가 필요하므로 **바꾸지 않는 것을 권한다**(결정 D-1).

### 6.4 장비 이름 → API 주소

지금 장비 이름이 identity·한도·표시에 들어가는 곳 [코드]:

| 곳 | 지금 | 목표 |
| --- | --- | --- |
| `ai_connections.device_id`(`operations-schema.ts:729`) | 운영자가 적는 이름, 기본은 이름표의 slug(`admin-ai-tasks.ts:145, 199-200`) | 입력 칸 없음. 연결에서 정해지는 열쇠(아래) |
| `ai_connections.capacity_slots`(`:730`) | 장비 행이 없을 때 만드는 칸 수(`admin-ai-tasks.ts:639`) | **이 주소의 동시 처리 수** — 한도의 원천 |
| `model_capacity_devices`·`_device_roles`(`:246-312`) | 장비 이름마다 칸 수·경로 몫·모델 상한·역할 순위 | 표와 입장 SQL 은 그대로, **열쇠 값만 주소 열쇠**. 화면은 주소로 보인다 |
| 정책 route 의 `groupId`·`providerBudgetId`(`capacity.ts:100-101`) | 연결의 장비 이름 / 같은 장비의 예산 이름(`admin-ai-tasks.ts:612, 630-631`) | 둘 다 주소 열쇠 |
| 직접·로컬 계약의 `backendId`·`physicalGroup` | 등록부 키·장비 이름(`capacity-helpers.ts:130`, `capacity-helpers-repository.ts:454-463`) | 새 text·심사 계약에는 없음. 로컬 계약은 칸이 장부 binding 에 묶여 있어(`local-model-capacity-sql.ts:48-61, 111`) **칸은 남고 값이 주소 열쇠**가 된다. 연결에서 만드는 전례가 있다(`admin-ai-tasks-repository.ts:199`) |
| `ai_task_pool_members.device_id`(`:803`) | 구성원의 장비 | 연결에서 읽는다 |
| 도우미·감시자 표(`model_helper_assignments`·`model_device_signals`·`model_role_demand`, `:343-474`) | 장비 FK | 값만 주소 열쇠. 코드에 박힌 이름(`capacity-helpers.ts:194-195`)은 설정으로 |
| 등록부 `equipment`·`gatewayLabel`·코드 기본 주소(`model-registry.ts:48, 56, 75-110`) | `장비:이름` 키, **주소가 코드에 적혀 있다** | 코드 기본 등록부를 비운다(2026-11-02 「하드코딩·env 금지」와 같은 방향). 순위가 없는 작업이 아직 이 길을 타는지는 [미확인] |
| env `LOCAL_MODEL_PHYSICAL_LIMITS`(`local-model-capacity.ts:67-83`) | 장비 표에 없을 때의 대체 | 읽지 않는다 |
| 화면: 장비 한도(`app/(operator)/admin/models/devices`, `DevicesPanel.tsx`), 배정(`assignments`), 연결 폼의 「장비 이름」(`admin-ai-tasks.ts:1097`), 「장비 · 모델」 표시(`admin-first-review-ranks.ts:32`, `admin-engine-connect.ts:102-134`) | 장비 이름 | 주소(이름표 + API 주소)로 표시·입력 |

설계:

- **주소 열쇠 = 연결 행의 id.** 화면과 입력은 API 주소이고, 장부·정책에 적히는 값은 그 연결의 id 다. 주소를 그대로 열쇠로 쓰면 주소가 바뀔 때(망 주소 변경) 한도·정책·진행 중인 행의 열쇠가 모두 갈리고, 주소가 장부·감사 기록에 퍼진다. 연결 id 는 주소와 1:1 이고(주소가 유일 색인) 이미 장부 이름 가르기(`모델@연결 8자`, `ai-tasks.ts:173-178`)와 로컬 예산 이름에 쓰인다. 주소 문자열 자체를 열쇠로 쓰는 안도 가능하다(결정 D-2).
- **한 주소의 한도** = 그 주소의 동시 처리 수(지금의 `limit_slots`). 경로 몫·모델 상한·역할 순위는 지금 규칙 그대로 그 주소 안에서 돈다.
- **한 주소에 모델이 둘 이상**(Supa 의 이름·별칭, M1 Max 의 두 모델, M1 Studio 의 두 이름): 주소의 칸 수가 합계 상한이고, 모델마다의 상한은 지금의 모델 상한(0170, 장부의 모델 문자열 기준 — `capacity-devices.ts:47-53`)으로 둔다. 별칭은 장부 이름이 다르면 따로 세고 주소 합계는 함께 쓴다.
- **한 기기에 주소가 둘**(M3 Ultra :8010 과 :8014): 지금은 한 장비 이름 아래 공유 칸과 모델 상한을 함께 둔 예가 코드 주석에 있다(`capacity-devices.ts:48`). 운영의 실제 묶임은 [미확인]. 주소마다 한도를 따로 두면 기기 합계가 늘 수 있다. 그래서 **「이 주소는 저 주소와 칸을 함께 쓴다」** 를 연결에 둘 수 있게 한다(함께 쓰는 주소들은 같은 열쇠로 입장) — 장비 이름 없이 지금의 공유 한도를 유지하는 길이다. 따로 둘지 함께 둘지는 소유자 결정(D-3).

### 6.5 끝까지 남는 abcllm 과 까닭

| 남는 것 | 까닭 |
| --- | --- |
| `drizzle/*.sql` 32개 파일 | 적용된 마이그레이션은 고치지 않는다 |
| `model_capacity_check_rules` 의 abcllm 가지(+ TS 거울 `operations-schema.ts:187-190, 234`, 생성 상수) | 트리거는 INSERT 뿐 아니라 **UPDATE 에도** 돈다(`0160_ledger_check_rules.sql:86`). 아직 지워지지 않은 abcllm 행(미확정·운영자 검토 대기 등)이 정산될 때 그 가지가 받아야 한다. 가지는 ordinal 1 의 한 덩어리 안에 있어 떼어 내려면 덩어리를 다시 써야 한다 |
| 장부를 읽는 좁은 코드(binding 파싱의 provider enum, 옛 울타리 `capacity-repository.ts:659, 1185, 1476`) | abcllm 행이 하나도 없을 때까지. 끝난 행은 보관 기간(기본 14일, 8~90일 — `lib/llm/capacity-retention.ts:5-17`, `drizzle/0187_db_retention.sql`) 뒤 지워지므로 **영원히는 아니다** — 6단계에서 0건을 확인하고 지운다 |
| 심사·2차·감사 표의 옛 `provider` 값, `operations_audit`, 꺼진 계약 행 | 지난 사실의 기록(감사 로그는 지울 수 없다). 화면은 「직접 연결」로 옮겨 보인다 |
| 경계 증거의 이름(`replaced-path-boundary-contract.ts:31-39`, `replaced-provider-boundary-contract.ts:32`)과 그 fixture | 장부 terminal 증거의 글자다 |
| 지난 운영 기록 문서(`docs/operations/*`, `docs/CODEX_HANDOFF.md`) | 그날의 기록 |
| 배포 도구의 폐기 이름 예시·시험 | 이름은 임의 문자열이다 — 바꿔도 되고 두어도 된다 |

binding kind 의 `*_gateway` 글자(`text_profile_gateway` 등)는 abcllm 이 아니고 장부 규칙의 글자라 바꾸지 않는다.

## 7. 단계

마이그레이션 번호는 0194 부터(0193 은 다른 작업). 아래 번호는 가칭이고 먼저 병합되는 쪽이 앞 번호를 쓴다.
운영 데이터를 바꾸는 단계(3·5b·6 일부)는 **소유자의 명시 승인 뒤 조정자가 실행**한다 — 코드가 저절로 바꾸지 않는다.

### 0단계 — 읽기 전용 확인 (조정자)

끝난 것: 5절의 서버 프로브.

남은 것(비밀값·주소는 기록에 남기지 않는다):

| # | 무엇 | 어떻게 | 정하는 것 |
| --- | --- | --- | --- |
| 0-1 | M1 Max 의 상한 | 키와 함께 `GET <API 주소>/models` — `max_model_len` 유무 | 계약의 상한을 서버 값으로 할지 운영자 입력으로 할지 |
| 0-2 | M3 :3031 | 닿는 호스트에서 `GET <API 주소>/models` | 카테고리 분류의 OpenCode 엔진 계약 3단계 대상 여부 |
| 0-3 | EXAONE | `POST <API 주소>/chat/completions` `{model, stream:false, temperature:0, max_tokens:1, messages:[{role:"user",content:"OK"}]}` — `object`·`model`·`usage` 세 수의 합(관리 화면의 1토큰 시험과 같은 호출, `admin-engine-connect.ts:51-61`) | 응답 이름·사용량 보고 여부 |
| 0-4 | 서버마다 같은 1토큰 호출 | 위와 같음 — `usage` 가 오는지 | 총량 상한 계량에서 실제 사용량이 기록되는지 |
| 0-5 | 켜진 계약 전부 | 운영 DB 읽기: 경로·모델·provider·protocol·transport·auth·선택 칸 유무·`deploymentRevision` 종류(CLI 엔진인지) | 3단계 전환 목록. M3 Ultra :8010 을 가리키는 gpt-oss-120b 계약이 순위에서 쓰이는지 |
| 0-6 | 용량 정책 | route 수(상한 256 — `capacity.ts:98`)와 provider 별 목록, 현재 세대 | 3단계에서 약 47개가 늘 여유가 있는지 |
| 0-7 | 연결·장비 | 연결별 장비 이름·칸 수, 한 장비 이름을 함께 쓰는 연결, 장비 행의 칸·경로 몫·모델 상한·역할 순위 | 5단계 옮김표, D-3 |
| 0-8 | 순위·옛 길 | 작업별 순위 유무, 배정 표·단계 풀·`firstReview`/`secondReview` 설정에 남은 provider 값 | 옛 고르기 길을 지워도 되는지 |
| 0-9 | 장부 | provider=abcllm 행의 상태별 수·가장 오래된 것, 보관 일수 설정과 정리 잡이 실제로 도는지 | 6단계 시점 |
| 0-10 | 심사 대기 | 1차 성공 뒤 2차를 기다리는 후보 수, 진행 중 2차 표의 provider 분포 | 심사 두 경로 전환의 영향 범위 |
| 0-11 | 앱 env | `npm run deploy -- plan` 의 `scope.retiredSettingCarriers`(이름만) | 4단계 배포에 `--retire-setting` 을 줄지 |
| 0-12 | 헤더·게이트웨이 칸을 읽는 서버가 있나 | 번역 4경로가 쓰는 서버(M3 Ultra :8010·:8014, M1 Max, M1 Studio)에 0-3 의 1토큰 호출을 `X-Abcllm-Strict-Terminal: 1` 헤더가 있을 때와 없을 때 한 번씩 — 응답에 `usage_provenance` 가 생기는지, `usage` 가 달라지는지 | 새 모양에서 헤더를 그냥 뺄 수 있는지(6.2) |

### 1단계 — 새 모양을 읽고 부를 수 있게 (PR, 동작 변화 없음)

- 바꾸는 것:
  - 새 직접 계약 모양을 열 경로의 스키마가 **추가로** 받는다(옛 두 모양은 그대로 — 저장된 계약의 hash 불변).
  - 준비·송신이 새 모양을 `local-direct` 로 부른다: wire 는 지금과 같은 바이트, `engineModel`·추론 토큰 여유·429 쉼 정책·CLI 엔진 revision 을 받는다, tokenizer 묶음이 있을 때만 사전 확인, 엄격 terminal 헤더 없음(5절 ④⑤⑥⑦).
  - abcllm 을 가정한 판정을 provider 를 아는 꼴로: OPEN 경로 판정(5절 ①), `taglines.ts:449`, 기본값 `?? "abcllm"`, replay 실행기(`lib/operations/pipeline-replay-model-runner.ts:48, 60`), 한도 화면(`admin-limits-view.ts:102`).
  - **심사자 identity 규칙**: 같은 장부 이름의 (abcllm, M) 과 (local-direct, M) 을 같은 심사자로 본다 — 1차 유효 판정·2차 표 이어받기(`first-reviewers.ts:64-70`, `second-review.ts:233, 252`, `second-review-input.ts:64-69`). 규칙을 어디까지 넓힐지는 구현 PR 에서 호출 지점을 전부 읽고 정한다.
  - 시험: 열 경로 × (대기→예약→보냄→정산 / 미확정 / 보내지 않음 / HTTP 거절 / 로컬 종료 / 운영자 검토) 를 `local-direct` 로 실제 PostgreSQL 에서. 빠진 가지가 나오면 **0194**(가지 행 INSERT + guard 재생성, 0193 과 같은 꼴).
- 배포: `lib/llm`·`lib/crawl` 공통 코드라 worker 역할 전부 + 웹 + 소비자. 범위는 `npm run deploy -- scope|plan` 이 정한다. 새 잡이 없어 scheduler 선행은 필요 없다. 0194 가 생기면 **DRAIN 뒤에 migrate**(장부 guard 재생성은 OPEN 중에 걸면 잠금 대기로 진행 행이 고아가 된 전례가 있다 — 10-31 창 #3).
- 확인: 저장된 계약의 hash 가 그대로(기존 hash 고정 시험), OPEN dry-run 의 경로 판정이 배포 전과 같음, 장부 새 행의 provider 분포가 그대로.
- 되돌리기: 이전 판 재배포. 운영 데이터 변화 없음. (0194 는 가지를 더하기만 하므로 남겨도 된다.)

### 2단계 — 저장이 새 모양을 만들게 + 전환 도구 (PR)

- 바꾸는 것:
  - 엔진 연결·순위 저장·배정 저장이 새 모양(`local-direct`)과 그 정책 route 를 만든다(5절 ③). 손 입력 틀과 화면 문구도 새 모양으로.
  - **전환 동작**(관리 화면 단추 + 조정자용 스크립트, 둘 다 dry-run 먼저): 경로·모델의 켜진 abcllm 계약을 같은 주소·모델·`engineModel`·상한·여유·쉼 정책의 새 모양으로 다시 저장하고, 정책에 (경로, local-direct, 모델, 같은 예산, 같은 장비)를 덧붙인다. 키는 다시 넣지 않는다 — 저장이 앞 행의 암호문을 이어 쓴다(`admin-serving-contracts.ts:80-82`). 앞 행은 꺼진 채 남는다(`:83`).
  - 되돌리기 동작: 꺼진 앞 행의 계약을 다시 저장.
- 전제: 1단계가 **모든 프로세스**에 배포돼 있어야 한다. 옛 판은 모르는 protocol 을 「계약 없음」으로 읽어 그 경로를 닫는다(`gateway-serving-contract-config.ts:33-37`).
- 배포: 웹(관리 화면)과, 순위 저장 코드를 함께 쓰는 worker. 마이그레이션 없음.
- 확인: dry-run 이 0-5 의 목록과 같은 대상을 낸다. 시험 DB 에서 전환 → 호출 → 정산 → 되돌리기.
- 되돌리기: 이전 판 재배포(전환을 아직 누르지 않았으면 데이터 변화 없음).

### 3단계 — 계약을 다시 저장 (운영 데이터, 경로마다 승인·실행)

- 순서(위험이 낮은 것부터): 검색 키워드 짓기 → 키워드 검수 → 수집 소개 → 사유 번역 → 한국어 소개 → 제품 번역 → 검색어 번역(웹 요청 경로 — 한가한 시간에) → 카테고리 분류 → 2차 → 1차.
- 한 경로의 절차: ① 그 잡을 일시중지(관리 화면 job-pause) ② 그 경로의 abcllm 대기·예약·보냄 행이 0 인지 읽기 ③ 전환 dry-run → 실행 ④ 재개 ⑤ 확인.
- 용량 전체 DRAIN 은 필요 없다 [코드]: 정책은 route 덧붙이기만이고(`capacity-repository.ts:2967-`), 줄에 선 옛 provider 요청은 준비에서 닫힌다(2.2). 덧붙일 때마다 세대가 하나 올라가고 앞 세대는 사슬(상한 16 — `capacity.ts:125-129`)에 남으므로, 모델마다 따로 누르지 않고 **경로 단위로 한 번에** 덧붙인다. 다만 **배포 창 안에서는 하지 않는다** — 창 안의 정책 쓰기가 세대를 올려 OPEN dry-run 경고를 낸 전례가 있다(11-09).
- 낡은 계약(M3 Ultra :8010 의 gpt-oss-120b)은 전환하지 않고, 쓰이지 않음을 0-5 로 확인한 뒤 끈다(소유자 확인).
- 확인: 새 장부 행이 `local-direct` 로 정산됨, 23514 없음, 경로 판정 serving, 감시 progress ok, 산출물 품질(소개·번역은 표본을 읽는다 — 수만 보지 않는다). 제품 번역은 ja 묶음이 통하는지.
- 되돌리기: 그 경로·모델의 앞 계약을 다시 저장(abcllm 정책 route 는 남아 있다). 전환 뒤 쌓인 `local-direct` 장부 행은 그대로 유효하다.
- 심사 두 경로는 0-10 의 수와 1단계의 identity 규칙 시험을 본 뒤에만.

### 4단계 — abcllm 쓰는 쪽 삭제 (PR)

- 전제: 켜진 abcllm 계약 0, 순위·설정에 abcllm 값 0, 대기·예약·보냄 abcllm 행 0(0-5·0-8·0-9 를 다시 읽는다).
- 지우는 것: 총량 상한 스키마 8종과 `direct-openai-chat-v1`(쓰이지 않으면), `GATEWAY_CONTRACT_PROVIDERS` 의 abcllm 과 「없으면 abcllm」 대체, 엄격 terminal 헤더·표시, 계약 행의 gateway 전송·인증 처리, 등록부의 abcllm provider·장비 표지·코드 기본 항목, 단계 표의 provider 글자(`admin-model-stages.ts:14-20`, `stage-registry.ts:167-172`), 설정 enum 의 쓰기 쪽, 3.5 의 죽은 코드, 화면 문구(3.4), 시험·fixture 의 「지금 동작」 쪽.
- 설정에 저장된 옛 provider 값은 읽을 때 옮겨 읽는다(저장 문서를 고쳐 쓰는 것은 운영 데이터 변경이라 따로 승인).
- 남기는 것: 6.5 표.
- 마이그레이션(선택, 0195 가칭): `model_serving_contracts` 의 `transport`·`auth` 기본값을 `direct`·`none` 으로. 꺼진 옛 행에 `gateway` 값이 있어 CHECK 는 좁히지 않는다.
- 배포: 전 역할. 0-11 에서 이름이 나오면 `plan --retire-setting` 을 함께.
- 확인: 「abcllm」 grep 이 6.5 의 목록만 남는지 CI 에서 고정(허용 목록 시험).
- 되돌리기: 이전 판 재배포 — 새 모양 계약은 1단계 판부터 읽으므로 호출은 이어진다.

### 5단계 — 장비 이름을 API 주소로

**5a 코드(PR)**

- 연결이 한도의 열쇠가 된다: 연결 폼에서 「장비 이름」을 빼고 「이 주소의 동시 처리 수」「칸을 함께 쓰는 주소」를 둔다. 새 연결은 주소 열쇠로 한도 행·정책 route 를 만든다. 장비 한도 화면은 같은 표를 주소(이름표 + API 주소)로 보인다.
- 로컬 계약·도우미 배정이 열쇠를 연결에서 읽는다. 코드에 박힌 장비 이름과 코드 기본 등록부의 주소를 없앤다.
- 마이그레이션(0196 가칭): 「칸을 함께 쓰는 주소」 칸 하나(덧붙이기만). 표·열 이름(`model_capacity_devices`, `device_id`, `group_id`)은 **바꾸지 않는다** — 장부 규칙과 입장 SQL 이 그 이름에 묶여 있고 얻는 것이 없다.
- 기존 장비 이름 행은 5b 전까지 그대로 읽는다(두 열쇠 공존).

**5b 운영 데이터(DRAIN 창, 소유자 승인)**

- 0-7 의 옮김표대로: 주소 열쇠의 한도 행을 지금 값(칸·경로 몫·모델 상한·역할 순위) 그대로 만들고, 연결을 그 열쇠로 옮기고, 정책을 **새 세대**로 쓴다 — route 의 `groupId`·`providerBudgetId` 가 주소 열쇠가 되고 abcllm route 가 빠진다. route 를 고치고 빼는 것은 덧붙이기가 아니므로 DRAIN 에서만 된다(`capacity.ts:151-159`).
- 로컬 계약을 새 열쇠로 다시 저장한다. 계약 hash 가 바뀌므로 도우미 배정의 근거 열쇠도 바뀐다(`capacity-helpers-repository.ts:128-135`) — 실전 도우미는 다시 승격 확인이 필요할 수 있다.
- 확인: 주소별 점유·대기 수가 이전 장비별 수와 같은 꼴, 경로 몫·모델 상한이 그대로 먹는지, OPEN 판정.
- 되돌리기: 앞 세대 정책과 앞 계약으로 다시 저장(같은 창 안에서). 옛 한도 행은 끄기만 하고 지우지 않는다.

3단계와 5b 를 한 창에 묶을 수도 있다(정책을 한 번만 쓴다). 권하는 것은 따로 — 문제가 나면 원인이 이름표인지 열쇠인지 가를 수 있다.

### 6단계 — 뒷정리

- 0-9 를 다시 읽어 abcllm 장부 행이 0 이면(보관 기간이 지나고 미확정·검토 대기가 정리된 뒤) 읽기 쪽 enum 과 옛 울타리를 지운다(PR).
- 규칙 행에서 abcllm 가지를 떼어 내는 것은 **이 계획에 넣지 않는다.** ordinal 1 덩어리를 다시 써야 하고, 이득은 guard 가 조금 가벼워지는 것뿐이다. 하려면 따로 설계한다.
- 멈춰 있는 게이트웨이 앱 삭제(운영, 소유자 승인).
- 문서: `AGENTS.md`·`PENDING.md`·모델 운영 문서의 현재형 설명을 고친다. 지난 기록은 두지만 「지금은 쓰지 않는다」를 첫 줄에.

## 8. 위험

| 위험 | 까닭 | 다루는 법 |
| --- | --- | --- |
| **심사자 identity 가 갈린다** | 1차·2차는 (provider, model) 을 심사자로 본다. provider 만 바뀌어도 「다른 심사자」가 되어 이미 통과한 1차가 무효로 읽히거나 대량 재심사가 날 수 있다 | 1단계의 동등 규칙 + 0-10 의 수 + 심사 경로를 맨 뒤에. 전환 직후 재심사 수를 본다 |
| 전환 순간의 진행 중 호출 | 보낸 행은 abcllm binding 으로 정산된다(가지가 남아 있어 통과). 줄에 선 행은 닫히고 다음 틱이 새 provider 로 다시 선다 | 경로를 멈추고 0 을 확인한 뒤 전환. 닫힌 요청이 재시도 수를 깎지 않는지 1단계 시험에 넣는다 |
| OPEN·배포 관문 | 경로 판정이 provider 를 읽는다(5절 ①). 감시의 text 진행은 provider 가 아니라 계약 행을 읽어 영향이 작다(`lib/operations/text-progress.ts:30`, `serving-contract-store.ts:263-269`). 배포 도구(Python)는 provider 를 읽지 않는다 [코드] | 1단계가 먼저, 3단계는 창 밖에서 |
| 정책 route 수 | 전환이 route 를 약 47개 더한다(계약 수 합). 상한 256 | 0-6. 넘치면 5b 의 새 세대에서 옛 route 를 먼저 뺀다 |
| 한도가 풀린다 | 열쇠를 바꾸는 동안 옛 열쇠와 새 열쇠의 점유가 따로 세어진다 | 5b 는 DRAIN 에서만. 3단계는 `groupId` 를 그대로 둔다 |
| 한 기기의 두 주소 | 주소마다 한도를 두면 기기 합계가 늘 수 있다(M3 Ultra) | D-3. 기본은 「함께 쓴다」로 옮겨 지금 합계를 유지 |
| wire 가 달라져 품질이 변한다 | 직접 모양의 wire 는 추론 강도 칸을 뺀다 | 새 모양은 바이트를 그대로 둔다. 1단계에 wire hash 고정 시험 |
| 429 쉼·회로 상태 | 열쇠가 (경로, provider, 모델)이다(`provider-rate-limit.ts:33-38`) | 전환 때 쉼 상태가 지워진다 — EXAONE 은 전환 직후 호출 빈도를 본다 |
| 일본어 규칙 | product-translate 의 ja 는 `local-direct` 에 있고(0184) abcllm 은 0193 | 이 계획은 0193 에 기대지 않는다. 전환 뒤 새 규칙은 `local-direct` 가지에만 더하고, abcllm 가지를 새로 더하는 마이그레이션을 막는 시험을 둔다 |
| 옛 판 프로세스가 새 계약을 못 읽는다 | 모르는 protocol → 그 경로를 닫는다 | 2·3단계 전에 1단계가 18앱 전부에 있는지 확인(되돌려진 앱 포함) |
| 과거 장부의 유효성 | UPDATE 에도 guard 가 돈다 | 가지를 지우지 않는다(6.5) |
| 장부 guard 재생성 | 0194 가 필요해지면 | DRAIN 뒤 migrate |
| 공개 저장소의 주소 | 코드 기본 등록부에 주소가 적혀 있다(`model-registry.ts:75-110`) | 5a 에서 코드 기본을 비운다. 이 문서에는 적지 않았다 |

## 9. 소유자가 정할 것

| # | 물음 | 권고 |
| --- | --- | --- |
| D-1 | 직접 호출의 장부 이름표를 `local-direct` 로 둘지, 새 글자로 할지 | `local-direct`. 새 글자는 모든 경로·검사에 새 가지가 필요하다 |
| D-2 | 한도·정책의 열쇠를 연결 id 로 할지, 주소 문자열 그대로 할지 | 연결 id(화면·입력은 주소). 주소가 바뀌어도 한도가 따라간다 |
| D-3 | 한 기기의 두 주소가 칸을 함께 쓰게 둘지 | 지금 함께 쓰는 것은 그대로 함께(0-7 로 확인 뒤) |
| D-4 | 3단계와 5b 를 한 창에 묶을지 | 따로 |
| D-5 | 낡아 보이는 계약(M3 Ultra :8010 의 gpt-oss-120b)을 끌지 | 0-5 로 쓰임 0 을 확인한 뒤 끈다 |
| D-6 | `context_strategy` 를 wire 에서 뺄지 | 이 계획 밖. 하려면 서버별 표본 비교 뒤 |

## 10. 확인하지 못한 것

- 4절의 가지 표는 스키마 글자를 훑은 것이다. 아홉 경로의 `local-direct` 장부 전이는 실제 PostgreSQL 로 돌려 보지 않았다(1단계 시험이 확정).
- 운영의 연결 ↔ 장비 이름 묶임, 장비 행의 실제 값, 정책 route 수, 순위가 없는 작업이 옛 고르기 길(등록부·단계 풀·배정 표)을 아직 타는지(0-6·0-7·0-8).
- 심사자 identity 를 읽는 호출 지점 전체. 이 문서는 대표 지점만 읽었다 — 구현 PR 에서 `hasFirstReviewer`·`firstReviewIdentitySql` 을 부르는 다섯 파일(`agent-review-repository.ts`·`second-review.ts`·`second-review-input.ts`·`discovery-admission.ts`·`pipeline-capacity-repository.ts`)과 2차 표 이어받기를 전부 읽는다.
- `"abcllm"` 225곳을 하나하나 분류하지는 않았다. 종류와 대표 지점만 적었다.
- M1 Max 의 상한, M3 :3031, EXAONE 의 응답 모양(0-1~0-3). M3 Ultra :8014 프록시가 `context_strategy`·엄격 terminal 헤더를 읽는지(0-12).
- 운영 앱 env 에 옛 이름이 남았는지(0-11), 보관 정리가 운영에서 켜져 있는지(0-9).
- Next.js 동작에 기대는 주장은 없다.
