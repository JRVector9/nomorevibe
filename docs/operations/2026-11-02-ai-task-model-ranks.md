# 작업 ↔ AI 모델 1~3순위 (2026-11-02)

상태: **PR A — 표·관리 화면·가져오기(#794).** **PR B — 글 짓기·번역·검색 text 일곱 작업이 이 표만 읽는다(공통 resolver·순위 대체, #795).**
**PR C1 — 1차 AI 검수·2차 AI 검수(투표자 1·2·3)·Grok 로그인 유지가 이 표만 읽는다(심사 계약 묶기·칸별 대체·CLI 계약 DB 행).**
직접 모델 단계·보강·감사·소개 검수·분류·벡터 작업은 아직 오늘의 설정으로 고른다(PR C2~D). 운영 적용(배포·migration)은 이 문서가 하지 않는다 — 순서는 아래 「운영 적용 순서」.

## 소유자 결정 (2026-11-02)

- 설계를 「작업 ↔ AI 모델(1~3순위 지정)」으로 바꾼다.
- 앞으로 모든 AI 연결은 하드코딩 없이, 환경변수 등록 없이 **API 주소로만** 연결하거나 **CLI 만** 쓴다.
- 모델 드롭다운은 각 서버가 실제로 내놓는 모델 전부(「서버 · 모델」)와 CLI 를 보인다.
- 2차 심사(AI2)는 투표자 칸(투표자 1·2·3)마다 따로 1·2·3순위를 둔다.

## 설계

### 표 두 개 (migration 0162)

`ai_connections` — 연결 하나 = 엔진 하나 또는 CLI 도구 하나.

| 열 | 뜻 |
| --- | --- |
| `id` (uuid) | 연결 id. 키 암호문의 AAD 이기도 하다(`ai_connections\n<id>`) |
| `label` | 화면 이름(예: `gpu3090`, `M3 gpt-oss`). 대소문자 무시하고 하나뿐 |
| `kind` | `api` 또는 `cli` |
| `base_url` | API 만. OpenAI 호환 `origin/v1`. 하나뿐 |
| `api_key_ciphertext` | API 만, 선택. secret-box(NMV_SECRET_BOX_KEY) 암호문. 화면·감사에 다시 나가지 않는다 |
| `cli_tool`, `cli_models` | CLI 만. `claude`·`codex`·`grok` + 운영자가 적은 모델 이름(CLI 에는 /models 가 없다) |
| `models`, `models_read_at`, `models_error` | API 만. 마지막 `GET {base_url}/models` 결과(`[{id, maxModelLen}]`)·시각·실패 이유 |
| `device_id`, `capacity_slots` | 용량 장비 이름(`model_capacity_devices`)과, 장비 행이 없을 때 만들 칸 수 |
| `options` | 연결별 덧붙임. PR A 는 `contextTokens`(/models 가 최대 길이를 주지 않는 엔진의 상한)만 쓴다 |
| `enabled`, `version`, `note`, `updated_by`, 시각 | 켜짐·판(compare-and-set)·메모 |

CHECK: 종류별 칸(API 는 주소, CLI 는 도구·모델 이름 1~32개이고 주소·키·목록 없음), 주소 꼴(`^https?://…/v1$`), 칸 수 1~256, 목록·옵션 크기.

`ai_task_models` — (작업, 칸, 순위) 하나에 (연결, 모델) 하나.

| 열 | 뜻 |
| --- | --- |
| `task` | 작업 id(코드 목록이 검사한다 — 새 작업은 표를 바꾸지 않고 코드에 더한다) |
| `slot` | 같은 작업 안의 나란한 칸. 2차 = 투표자 1·2·3, 나머지 = 1 (1~8) |
| `rank` | 1·2·3 |
| `connection_id`, `model` | 어느 연결의 어느 모델 |
| `options` | 순위별 덧붙임(예: 분류 CLI 의 `effort`) |
| `enabled`, `note`, `updated_by`, 시각 | |

유일: `(task, slot, rank)`, `(task, slot, connection_id, model)`. 연결을 쓰는 순위가 있으면 연결을 지울 수 없다(FK RESTRICT).

### 작업 목록 (코드, `lib/llm/ai-tasks.ts`)

작업은 기능이라 코드에 둔다. **모델 이름·주소·환경변수 이름은 없다.** 작업마다 id·쉬운 이름·종류(대화·이미지·벡터·재정렬)·받는 연결(API, CLI 도구)·칸 수와,
오늘의 실행 경로를 찾는 열쇠(용량 route id·지금 고르기 출처의 단계 id·잡 이름)만 있다. 27개 작업, 2차가 3칸이라 29줄이다.

| 묶음 | 작업 |
| --- | --- |
| 심사 | 1차 AI 검수 · 2차 AI 검수(투표자 1·2·3) · 사람 몫 위임 검수 · 2차 갈림 재확인 · 2차 갈림 판가름 · 보류 재심사 |
| 글 짓기·번역 | 수집 소개 짓기 · 심사 사유 번역 · 제품 다국어 번역 · 한국어 소개 번역 · 한국어 소개 번역 직접 경로 |
| 검색 | 검색어 번역 · 검색 키워드 짓기 · 검색 키워드 검수 · 제품 의미 검색 벡터 · 검색어 벡터 · 검색 재정렬 |
| 감사·보강 | 발행분 감사 직접 모델 · 감사 두 번째 의견 · 공개분 추가 검수 · 화면 판별 · 발행분 감사 캠페인 · LLM 보강 · LLM 보강 독립 감사 |
| CLI 전용 | 소개 검수(Claude) · 카테고리 분류(Codex·Claude) · Grok 로그인 유지(Grok) |

### 순위 규칙 (저장 검증)

- 빈 칸 뒤 순위는 안 된다. 같은 연결·모델은 한 순위만.
- 작업이 받지 않는 연결(API 를 안 받는 작업, 받지 않는 CLI 도구)은 안 된다.
- 연결이 지금 내놓는 모델만 고른다. 목록에서 빠진 저장 값은 「(저장된 값 · 지금 목록에 없음)」으로 남고 그대로 다시 저장할 수 있다.
- 벡터·재정렬: 2·3순위도 1순위와 **같은 모델**이어야 한다(다른 서버의 같은 모델만 대체). 검색어 벡터는 제품 벡터의 1순위 모델과 같아야 한다.
- 2차(PR C1 부터): **한 모델은 한 투표자 칸에만** 둔다 — 순위가 무엇이든(1·2·3), 같은 가중치(앞 대괄호·배포자 접두어·연결로 가른 이름의 꼬리를 뗀 이름)면
  다른 칸에 둘 수 없다. 칸마다 1순위를 쓸 수 없으면 그 칸의 2·3순위가 표를 내므로, 두 칸에 같은 모델이 있으면 한 항목에 같은 모델이 두 표를 낼 수 있다.
  (PR A 까지는 「투표자끼리 같은 1순위 모델만 안 된다, 대체는 겹쳐도 된다」였다.)

## 다섯 PR

| PR | 하는 일 |
| --- | --- |
| **A (이 PR)** | 표 0162 · 작업 목록 · 관리 화면(AI 연결, 작업 ↔ 모델, 「지금 실제로 쓰는 모델」 비교) · 오늘 설정 가져오기. 실행 쪽 동작은 바꾸지 않는다 |
| **B** | 공통 실행 resolver(순위 대체) — 글 짓기·번역·검색 text 일곱 작업이 이 표를 읽는다. migration 없음 |
| **C1** | 1차 AI 검수·2차 AI 검수(투표자 칸별 1·2·3순위)·Grok 로그인 유지가 이 표를 읽는다. 심사 계약에 연결별 장부 이름, CLI 계약을 DB 행으로. migration 없음 |
| C2 | 직접 모델 단계(`local-*`)·한국어 Qwen 직접 경로·소개 검수·발행분 감사·LLM 보강·카테고리 분류(connect)·화면 판별이 이 표를 읽는다 |
| D | 임베딩·재정렬이 이 표를 읽는다 |
| E | 환경변수·코드 기본값 등록부를 지우고, 다시 생기지 않게 CI 검사를 더한다 |

## PR A 가 바꾸는 것

- 새 표 두 개(0162). 기존 표·CHECK·트리거·함수는 그대로다.
- 관리 화면 `/admin/models/tasks`(모델 운영 현황 상단 띠의 「작업 ↔ 모델 →」).
  - **AI 연결**: API(주소 + 선택 키 — 저장할 때 `GET /models` 를 읽어 목록을 둔다, 못 읽으면 이유를 한국어로) 또는 CLI(도구 + 모델 이름).
    「다시 읽기」는 엔진 자동 확인(#791)과 같은 1분 간격이다. 쓰는 순위가 없을 때만 지울 수 있다.
  - **작업 ↔ 모델**: 줄마다 1·2·3순위 드롭다운(「연결 이름 · 모델」 + 「없음」, 기존 `RankSelects` 를 그대로 쓴다)·「지금 실제로 쓰는 모델」·준비 상태.
  - **지금 설정 가져오기**: 계획 보기(쓰지 않는다) → 확인 「가져오기」 + 적용.
- 모든 저장이 `operations_audit` 에 한 줄을 남긴다: `ai-connection-save`·`ai-connection-models-read`·`ai-connection-delete`·`ai-task-models-save`·`ai-task-models-import`.

### 순위를 저장하면 함께 만드는 것

다음 단계(PR B)가 오늘의 장부·계약 길을 그대로 쓸 수 있게, **없는 것만** 같은 TX 에서 만든다. 있는 것은 바꾸지 않는다.

- 연결의 **장비 행**(`model_capacity_devices`) — 칸 수는 정책 `groupLimits` 값(없으면 연결의 칸 수), 낮은 순위 상한 = 칸 수, 순위 없음.
  정책 대체로 돌던 장비는 같은 값으로 행이 생기므로 입장 결과가 같다. **장비 역할 순위는 쓰지 않는다.**
- **엔진 직접 계약**(글 짓기·번역·검색 text 경로와 1차) — 엔진 연결과 같은 readback(`/models`) + 1토큰 시험 뒤 `transport direct`, 키가 있으면 `stored`.
  게이트웨이 계약 행(지금 열리지 않는다)만 있으면 엔진 직접 계약으로 바꾼다.
- **정책 route** — `appendCompatibleRoutes`(덧붙이기만, DRAIN 없음). abcllm 경로는 예산 이름 = 같은 장비의 다른 route 가 쓰는 이름(없으면 장비 이름),
  CLI 경로는 같은 경로의 다른 모델이 쓰는 예산 이름을 따른다.

만들 수 없는 것이 빠진 순위는 **저장하지 않고** 무엇이 없는지 보인다: 같은 경로·모델 계약이 다른 서버를 가리킴, 정책 route 가 다른 장비에 있음,
로컬 직접 경로(`local-*`)의 정책 route·로컬 계약 없음(예산·장비 이름이 계약의 backendId·physicalGroup 과 같아야 해서 만들지 않는다), 2차 계약 없음,
꺼진 장비, 정책을 못 읽음, 한 작업의 두 순위가 같은 모델을 다른 서버로 씀. 확인할 수 없는 것(CLI 계약, 보강·감사 캠페인 경로)은 경고로만 알린다.

### 가져오기

오늘 실행 쪽이 고르는 모델을 그대로 옮긴다 — 첫날 순위 = 오늘 동작.

- 읽는 곳: 1차 `firstReviewers`(배정 표 또는 설정), 2차 `secondReviewVoterSets`(투표자 k → 칸 k 의 1순위, 대체 목록 → 각 칸의 2·3순위),
  text 경로 `currentModelEnv`(단계 풀 + 등록부·env), 직접 모델 단계 `withAdminStagePools`·`withAdminModelStage` 안의 등록부·env 고르기, 화면 판별 `screenModelConfig`,
  보강 `assistBackendDrains`, 분류 connect 에이전트 설정(effort 는 순위 옵션), 실행 중 감사 캠페인, 임베딩·재정렬 `EMBEDDING_URL`·`RERANK_URL`.
- 서버 주소는 지어내지 않는다: text·1차·2차는 켜진 연결 계약의 endpoint, 직접 모델 단계는 그 단계가 실제로 부르는 등록부·env 주소다. 주소를 모르는 순위는 건너뛰고 경고한다.
- 연결: 엔진 주소마다 하나(이름 = 정책 route 의 장비 이름, 없으면 등록부 장비, 없으면 호스트), CLI 는 도구마다 하나.
  키는 그 엔진의 저장 키 계약 또는 env(`AUDIT_SECOND_OPINION_API_KEY`·`SCREEN_REVIEW_MODEL_API_KEY`)에서 옮겨 암호화한다(계획에는 이름만 싣는다).
  보강 키(`LLM_ASSIST_API_KEYS`)는 옮기지 않는다.
- 계획 보기는 아직 연결이 없는 엔진 주소의 `GET /models` 만 읽는다. 임베딩·재정렬은 요청에 모델 이름을 싣지 않아 그 목록이 하나뿐일 때만 그 이름으로 옮긴다.
- 이미 순위가 있는 칸은 덮지 않는다. 적용은 계약·정책 route·장비를 만들지 않는다(오늘 없는 것은 오늘도 없다 — 표의 「준비 상태」가 알린다).
- 단계 풀에 모델이 여럿이면 오늘은 잡마다 돌아가며 나눠 쓰고, 순위로 옮기면 1순위 먼저·나머지 대체가 된다(계획이 경고한다).

### 바꾸지 않는 것

- 잡이 고르는 모델·부르는 주소·용량 입장 판정. (순위 저장이 만든 새 계약·정책 route·장비 행은 그 모델이 오늘 이미 고르는 모델일 때만 쓰인다.)
- 배포 도구·운영 DB.

## PR B 가 바꾸는 것

대상: 수집 소개 짓기(`crawl-tagline`)·심사 사유 번역(`reason-translate`)·제품 다국어 번역(`product-translate`)·한국어 소개 번역(`product-tagline-ko`, GPT 경로만 —
Qwen 직접 경로는 PR C)·검색어 번역(`search-query-translate`, 웹 요청)·검색 키워드 짓기(`product-search-profile`)·검색 키워드 검수(`product-search-verify`).
작업 id = 용량 route id 다(`AI_TEXT_TASK_IDS`, lib/llm/ai-tasks.ts).

### 실행 쪽 resolver

- **스냅숏** `lib/llm/ai-task-models-snapshot.ts`: `ai_task_models JOIN ai_connections` 를 30초마다 한 번 읽는다(serving-contract-store 와 같은 규칙, 실패하면 마지막 값).
  워커와 웹 둘 다 읽는다. 연결 키(secret-box 암호문, AAD `ai_connections\n<id>`)는 이 프로세스 메모리에서만 연다. 한 번도 못 읽었으면 「순위 없음」과 갈라
  `task_models_unreadable` 이다. `MODEL_SERVING_CONTRACTS_DB=0` 이면 읽지 않는다(계약과 같은 끄기 스위치 — 모든 text 작업이 멈춘다).
- **resolver** `lib/llm/ai-task-resolver.ts`: `taskModels(task, slot)` = 순위 차례의 (연결, 모델). text 작업은 순위마다 **그 연결을 가리키는 엔진 직접 계약**
  (그 경로의 켜진 계약 중 끝점 = `<연결 주소>/chat/completions`, 엔진 모델 = 순위 모델, abcllm 형은 transport direct)에 묶는다 →
  장부 이름(identity = 계약 행 열쇠)·provider·**연결의 키**. 계약이 없거나 닫혔으면 그 순위는 쓸 수 없다(까닭을 남긴다).
- **범위** `lib/llm/ai-task-rank-scope.ts`: 순위 하나로 부르는 동안 AsyncLocalStorage 범위를 연다. 깊은 코드(장부 요청·계약 고르기·결과 기록)는 예전
  `scopedModel(route, 환경변수 상수)` 자리에서 `textTaskModel(route)` 를 읽는다 — **범위 밖이면 던진다**(코드 기본값·환경변수로 떨어지지 않는다).
  범위 안의 `textRouteAccess` 는 계약 행의 키가 아니라 연결의 키를 보낸다(계약이 닫힌 까닭은 그대로 막는다).
- 일곱 작업에서 지운 읽기: `TAGLINE_MODEL`·`TRANSLATE_MODEL`·`KOREAN_TAGLINE_MODEL`·`SEARCH_QUERY_MODEL`·`PRODUCT_TRANSLATE_MODEL`·`PROFILE_MODEL`·`VERIFY_MODEL`
  (= `MODEL_PURPOSE_ENV`·`ABCLLM_MODEL*`·`ABCLLM_PROFILE_MODEL*`·`SEARCH_VERIFY_MODEL*`·등록부 용도 기본값·배정 표 기본값), 단계 풀(`stageModelPools`, 다섯 잡을
  `MODEL_POOL_JOBS` 에서 뺐다 — product-tagline-ko 는 Qwen 경로 때문에 남는다), `pooledTextModels`. 한도·시간은 경로 한도만 읽는다
  (`modelRequestBudget`·`modelRouteTimeoutMs` — runtime_settings routes 와 코드 기본 경로 한도. 등록부의 모델별 상한은 읽지 않는다; 코드 기본값에서는 예전 값과 같다).

### 순위 대체(한 틱)

`TextTaskRanks`(resolver) — PR #792 의 1차 순위 대체와 같은 뜻이다.

- 1순위부터 부른다. **그 모델만의 까닭**(`ModelCapacityDeferredError` 범위 model: 용량 정책에 경로 없음 `unmapped`·장비 행 없음 `device_unconfigured`·
  전송 계약 닫힘 `provider_contract_unavailable`·포화 `capacity`·대기열 가득 `queue_full`·도우미 경로 닫힘)이면 **같은 일**(후보·제품·묶음)을 2순위로,
  그다음 3순위로 넘기고 그 순위는 이 틱 동안 쉰다. 범위 안에서 계약이 닫힌 것도(예전에는 게이트웨이 길 → no_key) 이제 `provider_contract_unavailable` 이다.
- 이 일만의 미룸(`dispatched`·`work_busy`·`ledger_mismatch`…)은 다음 순위로 넘기지 않는다 — 그 일만 넘긴다(예전 그대로). 전역 미룸(`draining`·`owner_unavailable`…)도 예전 그대로.
- 엔진이 내려갔음이 증명되면(`engine-down.ts`: no_key·model_unavailable·tokenizer_unavailable 한 번, 연결 거절 세 번) **그 순위만** 쉬고 다음 일은 다음 순위로 간다
  (그 일의 실패 시도는 이미 적혔다 — 같은 틱에 다른 순위로 다시 묻지 않는다). 쓸 수 있던 순위가 모두 엔진 까닭으로 쉬면 예전처럼 틱을 접는다(`done: true`).
  사유 번역·한국어 소개 번역은 예전에 실패·느린 묶음 하나로 틱을 접었다 — 이제 그 순위만 쉰다(순위가 하나면 예전과 같다).
- 수집 소개 짓기의 둘째 물음(빈 줄 다시 묻기)은 첫 물음과 같은 순위다(장부의 이어 묻기가 모델에 묶인다) — 둘째 물음에서 그 순위를 쓸 수 없으면 그 순위를 쉬게 하고 그 후보만 넘긴다.
- 검색 키워드 짓기는 순위마다 이 프로세스가 줄에 세워 둔 요청을 먼저 이어받고, 그 일은 그 순위로 먼저 부른다(`prefer`).
- 검색어 번역(웹)은 요청마다 순위를 연다: 순위가 없거나 모두 쓸 수 없으면 번역 없이 찾는다(포화면 `translationPending` — 나중에 다시). 1분에 한 번 `search.translate_ranks_unusable` 경고.

### 순위가 없거나 모두 쓸 수 없을 때(조용히 대신 부르지 않는다)

| 코드 | 언제 | 잡 결과 |
| --- | --- | --- |
| `no_task_models` | 이 작업에 순위가 없다 | `{ done: true, degraded }` — 성공 시각을 옮기지 않고 상태 화면 「조치할 일」에 「제 일 못 함 no_task_models」 |
| `task_models_unreadable` | 순위 표를 아직 한 번도 못 읽었다(권한·migration) | 같다 |
| `all_ranks_unusable` | 틱을 시작할 때 모든 순위를 쓸 수 없다(계약 없음 등), 또는 틱 안에서 모든 순위가 쉬었고 한 건도 못 했다 | 같다. detail 에 순위마다 「N순위 연결 · 모델: 까닭」 |
| (포화) | 모든 순위가 쉬었고 그중 포화가 있다 | 예전처럼 `deferred: model_capacity`(장부의 대기 행 → 진행 감시의 capacity-admission-block) |

- 진행 감시: 이 세 코드는 1차의 `agent_review_all_skipped` 처럼 「설정의 일 — 재시작이 고치지 못한다」로 본다(`worker-progress-query.ts` `ALL_SKIPPED_CODES`,
  text 단계는 원래 재시작 대상이 아니지만 같은 표에 넣어 둔다). 틱마다 마지막 이벤트로 `ai_task.ranks`(순위 수·`served.<순위>`·`unusable.<순위>.<까닭>`)를 남긴다.

### 같은 모델을 두 연결에(연결별 장부 이름 — PR A 의 남은 일 1)

- 계약 행은 (경로, model), 정책 route 는 (경로, provider, model) 하나라 같은 모델 이름을 두 서버에 둘 수 없었다. PR B 는 **schema 를 바꾸지 않고**
  연결로 가른 장부 이름을 쓴다: `<모델>@<연결 id 앞 8자>`(`aiTaskAliasIdentity`). 그 계약의 `model` 이 이 이름이고 새 칸 `engineModel` 이 엔진 모델 이름이다
  (text 일곱 경로의 abcllm 형 계약 스키마에 선택 칸으로 더했다 — 없는 계약의 parse 결과·hash 는 그대로다). wire 에는 `engineModel` 이 나간다.
  장부(`model_capacity_requests.model`)·binding·정책 route 의 model 은 장부 이름이다 — **migration·CHECK 재구성 없음**(0161 의 `binding->>'model'=model` 은 그대로 맞는다).
- 순위 저장(`aiRanksReadiness`): 그 연결을 가리키는 계약이 있으면 그것을 쓴다. 없고 같은 모델 이름의 직접 계약이 **다른 서버**에 있으면 별칭 계약·정책 route 를
  만든다(경고로 알린다). 한 줄의 두 순위가 계약 없는 같은 모델을 다른 연결로 고르면 1순위는 이름 그대로, 2순위는 별칭이다. 별칭 이름의 계약이 다른 서버를 가리키면 막는다.
- 심사 묶음(1차·2차·직접 모델 단계)은 아직 예전 실행 쪽이라 같은 모델을 다른 서버로 두 순위에 둘 수 없다 — 그대로 막는다(PR C).
- 결과 행(예: `crawl_taglines.model`·`product_search_profiles.model`)에는 장부 이름이 적힌다(별칭이면 `@…` 가 붙는다).

### 화면

- `/admin/models/tasks`: text 일곱 줄의 오른쪽에 「실행(마지막 틱 · 시각): N순위 M건」·「아래 순위를 쓴 까닭 — 1순위: 용량 정책에 이 경로·모델이 없음 ×3」·
  그 틱의 degraded(제 일 못 함)를 보인다. 잡 여섯은 `job:<잡>` 관측의 마지막 `ai_task.ranks`, 검색어 번역은 이 웹 프로세스의 마지막 요청(다른 웹 복제본과 다를 수 있다).
  text 일곱 줄의 「지금 실제로 쓰는 모델」은 저장한 순위 그대로다(쓸 수 없는 순위에는 까닭).
- 상태 화면 진단 탭의 「작업 ↔ 모델 · text 작업 순위」 칸(`TextTaskRanksStatus`): 일곱 작업마다 저장한 순위·쓸 수 없는 순위의 까닭·마지막 틱에서 몇 순위가 일했고 아래 순위를 쓴 까닭.
  그 밖에 잡 health 의 「제 일 못 함 <코드>(detail) 연속 N회」, 흐름 상세의 text 자리(`TASK_MODEL_SLOTS`, 출처 「작업 ↔ 모델 1순위」), 한국어 번역 카드의 「사용 모델 설정」,
  모델 1시간 집계의 키워드 짓기 모델, `pipeline-control`·`currentModelEnv` 의 text route 판정(순위마다 장부 이름)이 순위를 읽는다.

### Oracle 소비자 권한(PR A 의 남은 일 6)

- 일을 도는 모든 Oracle 역할(`LIVE_SETTINGS`)에 `ai_task_models`·`ai_connections` SELECT 를 더했다(`lib/runtime/oracle-db-profile.ts`, `deploy/oracle/least-privilege.sql` 다시 만듦).
  `api_key_ciphertext` 는 암호문뿐이고 Oracle 에는 `NMV_SECRET_BOX_KEY` 가 없다 — `model_serving_contracts` 와 같은 결정. 키가 필요한 연결의 순위는 Oracle 에서
  `stored_key_unreadable` 로 쓸 수 없고(키 없이 보내지 않는다), GRANT 가 없으면 `task_models_unreadable` 로 멈춘다(기본값으로 대신 부르지 않는다). 운영자가 B 배포 전에 적용한다.

## PR C1 가 바꾸는 것

대상: 1차 AI 검수(`first-review` — 잡 `crawl-agent-review`·AI1 소비자), 2차 AI 검수(`second-review` 투표자 칸 1·2·3 — 잡 `second-review`·AI2 소비자),
Grok 로그인 유지(`grok-session-check`). migration 없음 — 계약 행은 기존 `model_serving_contracts` 에, CLI 버전은 `ai_connections.options.cliVersion` 에 둔다.

### 1차(AI1) — 순위만 읽는다

- 심사자 = 「작업 ↔ 모델」 1차 AI 검수 칸 1 의 1·2·3순위(`lib/crawl/review-task-ranks.ts` `firstReviewRanks`, `first-reviewers.ts` `firstReviewers`).
  지운 읽기: `crawl_settings.firstReview`·`firstReviewAdditional`(고르기), 배정 표 ai1 길(`selectTableFirstReviewer`·`tableFirstReviewers`·`firstReviewTableRows`·
  `AI1_TABLE_PROVIDERS` — `stageTableRows` 는 ai1·ai2 에 늘 빈 목록), 등록부 기본 후보 `DEFAULT_MODEL_CANDIDATES["first-review"]`(`firstReviewCandidates`),
  단일 모드/풀 모드 갈림(`firstReviewAdditional === undefined` 분기 — 이제 늘 순위 고르기·모델별 쉼·쪽 커서).
- PR #792 의 뜻 그대로(`selectFirstReviewer`·`chooseFirstReviewForCandidate`): 살아 있는 의도·보내진 중인 호출이 있으면 그 모델에 묶고, 아니면 쓸 수 있는 가장 높은 순위.
  그 모델만의 거절이면 그 모델을 이 틱 동안 쉬게 하고 **같은 후보**를 다음 순위로. 모두 쓸 수 없으면 그 후보는 `all_ranks_unusable` 로 건너뛰고 대기열은 지나간다.
  틱에 들인 후보가 모두 그렇게 건너뛰면 `degraded: all_ranks_unusable`(감시가 재시작하지 않는다). AI1 소비자(`consumers/first.ts`)도 같은 출처·같은 순위 대체다
  (예전에는 그 모델만 쉬고 다음 후보로 갔다 — 이제 같은 후보를 다음 순위로 다시 고른다, 최대 3번).
- 「지금 1차 심사자」 목록(결과 재사용·발행 조건 SQL·2차 입력 검사)은 identity 를 아는 순위 전부다 — 계약이 닫혔거나 CLI 계약이 없는 순위도 그 결과는 지금 심사자의
  결과로 남고, 고르기만 그 순위를 비켜 간다(틱 처음부터 쉰다). 계약이 없어 장부 이름을 모르는 API 순위·꺼진 순위·꺼진 연결은 목록에서 빠진다.
- 틱 머리: 순위 없음 `no_task_models`·표 못 읽음 `task_models_unreadable`·모두 쓸 수 없음 `all_ranks_unusable` 이면 `{ done: true, degraded }`(성공 시각을 옮기지 않고
  상태 화면 「조치할 일」). 단계(items·legacy) 확인보다 앞이라 소비자가 맡는 items 모드에서도 1차 잡이 그 까닭을 보인다. 틱 끝에 `ai_task.ranks`(순위별 호출 수·까닭).

### 2차(AI2) — 투표자 칸마다 1·2·3순위

- 투표자 = 칸(1·2·3)마다 **쓸 수 있는 가장 높은 순위**(표를 만들기 전 확인: 순위·연결 켜짐, 계약이 그 연결을 가리킴, 키를 엶, CLI 계약 있음·버전 같음).
  1순위를 쓸 수 없으면 그 칸의 2순위가, 그다음 3순위가 표를 낸다(`secondReviewRanks`·`secondReviewRankSets`). 대체(목록 검사용) = 그 밖의 identity 를 아는 순위.
  지운 읽기: `crawl_settings.secondReview.voters`·`fallbacks`, 배정 표 ai2(`tableSecondReviewVoters`), 설정 기본 투표자(`settings-schema.ts` 의 `modelForPurpose("ai2-cli")` —
  이제 기본 `voters: []`, 칸은 비어도 된다).
- **한 모델이 한 항목에 두 표를 내지 않는다**(PR A 의 남은 일 2): 저장이 막고(위 순위 규칙), 실행 쪽도 막는다 — 대체는 첫 표(root)가 든 칸의 다음 순위에서만 고르고
  (`secondReviewFallbacksFor`), 이미 그 항목에 표를 낸 모델·지금 투표자인 모델은 다시 뺀다(`withoutTakenModels`). 옛 행이 두 칸에 같은 모델을 가져도 앞 칸만 쓴다.
- 대체가 생기는 곳 셋 모두 같은 칸 안이다: 표 실패(`recordSecondReview`), 엔진 직접 표의 준비 실패(`primary_preflight_failed`)·줄에서 15초 넘게 기다림
  (`capacity_wait_timeout`, `fallbackWaitingSecondReview`). 뒤 둘은 예전에 local-direct 첫 표 + abcllm 대체만 받았다 — 이제 첫 표가 abcllm 형 직접 계약이어도 되고
  (`withdrawUndispatchedAi2ItemForFallback` 이 abcllm 도 물린다, AI2 소비자의 오래 기다린 줄 hint 도), 대체는 그 칸의 순위면 provider 를 가리지 않는다
  (정책 route 가 있고, API 는 계약이 그 모델을 가리키며, CLI 는 CLI 계약이 있어야 한다).
- 틱 머리: 순위 없음·표 못 읽음·모든 칸을 쓸 수 없음이면 `{ done: true, degraded }` 로 **정비(올리기·정리·재조정)도 하지 않는다** — 빈 투표자 목록으로 대기 표를
  `model_removed` 로 닫지 않는다. 표를 한 번도 못 읽은 프로세스의 올리기·정리·입력 검사는 `assignments_unavailable` 로 미룬다(`requireReviewTaskRanks`, 예전 배정 표 관문 자리).
  AI2 소비자는 그동안 5초씩 쉰다. `ai_task.ranks` 의 `served.<순위>` 는 그 순위가 표를 내는 칸 수다(호출 수가 아니다).
- `AI2_DIRECT_SERVING_CONTRACTS`(env local-direct 계약)는 읽지 않는다. 2차 계약은 DB 행뿐이고 DB 행은 abcllm 형(total-bound)과 direct-openai-chat-v1(local-direct) 둘 다 받는다.

### 심사 계약 묶기(연결별 장부 이름 — PR B 의 남은 일 1)

- 순위 하나 → 그 경로(`crawl-agent-review`·`second-review`)의 켜진 계약 중 끝점 = `<연결 주소>/chat/completions`, 엔진 모델(`engineModel` 또는 `model`) = 순위 모델인 것
  (abcllm 형 transport direct 먼저, 그다음 local-direct). 장부 이름 = 계약 행의 model. 같은 모델을 다른 연결에도 두면 `<모델>@<연결 id 앞 8자>` 이고
  엔진에는 `engineModel` 이 나간다 — AI1 raw·AI2 raw 계약 스키마에 선택 칸 `engineModel` 을 더했다(없는 계약의 parse 결과·hash 는 그대로).
- 고른 방식(쪽 정리): API 연결의 1차·2차는 **abcllm 형 total-bound 계약 + transport direct**(엔진에 바로, 게이트웨이 없음)로 만든다 — 엔진 연결·text 경로가 이미 쓰는
  모양이고 엔진의 /models·1토큰 시험만으로 만들 수 있다. local-direct(direct-openai-chat-v1)는 tokenizer readback 이 따로 필요해 저장이 만들지 않는다(있으면 쓴다).
- 보내는 키는 **연결의 키**다: 심사 계약이 가리키는 엔진 주소의 연결이 그 작업의 순위에 있으면 `textRouteAccess` 가 연결의 키를 준다(순위 범위 없이 — 1차·2차의
  모든 길이 같은 판정). 연결 키를 열 수 없으면 `stored_key_unreadable`.
- 같은 모델인가의 판정(`canonicalReviewModel`·`bareModelName`·SQL `underlyingModelSql` 과 2차 SQL 의 이름 비교)은 장부 이름의 꼬리 `@<8자>` 를 뗀다 — 별칭 1차와
  같은 모델의 2차 투표가 독립 표로 세어지지 않는다.

### CLI 계약을 env 없이(1차·2차·Grok 로그인 유지)

- 계약 = `model_serving_contracts` 의 `cli:<provider>:<route>` 행(`cliContractRouteId`, 같은 이름의 API 계약과 겹치지 않는다). 순위 저장이 CLI 연결의 **CLI 버전**
  (`ai_connections.options.cliVersion` — 연결 화면에 새 칸)과 그 route 의 argv 상한(`lib/llm/cli-db-contracts.ts`: Claude 심사 derived — 2턴·출력 32,000/턴·
  overhead 20,000·입력 200,000 바이트·0.15 USD, Grok 심사 declared 200,000, Grok 로그인 유지 declared 32,768)으로 만든다. 모델 이름·주소는 계약에 박지 않는다(순위의 것).
- 웹은 CLI 를 띄우지 않아 버전을 확인하지 못한다 — 운영자가 적은 버전으로 행을 만들고, 워커가 부를 때 예전처럼 `<도구> --version` 과 견준다(프로세스마다 한 번,
  `probeCliServingContracts` 가 claude·grok 을 띄워 `cli_contract.probe` 로그에 `observedVersion` 을 남긴다 — 운영자가 연결에 적을 값). 다르면 그 순위는
  `cli_version_mismatch`(이 워커의 버전을 까닭에 붙인다)로 쓸 수 없다.
- 이 route 들에는 env `CLI_SERVING_CONTRACTS` 를 읽지 않는다(그 항목은 `route_reads_db`). 실행 파일은 PATH 의 도구 이름(`claude`·`grok`)이다 — `CLAUDE_CLI`·`GROK_CLI`
  를 읽지 않는다(`cliCommandFor`, 심사 CLI 의 장부 길·장부 밖 길·Grok 로그인 유지 모두). 운영 이미지는 두 CLI 를 `/usr/local/bin` 에 둔다(Dockerfile).
- 경로 한도 `review-cli` 의 출력 토큰을 32,000 넘게 올리면 Claude 심사 계약과 맞지 않아 그 순위는 쓰이지 않는다(되돌리면 풀린다).

### Grok 로그인 유지

- 모델 = 「작업 ↔ 모델」의 Grok 로그인 유지 순위(1·2·3, 그 모델만의 거절이면 다음 순위). 1·2차 설정에서 찾지 않는다. 순위가 없는데 1·2차 순위에 Grok CLI 가 있으면
  `degraded: no_task_models`(로그인이 갱신 없이 만료될 수 있다), Grok 을 아무 데서도 안 쓰면 조용히 넘긴다.

### 화면

- 옛 편집 칸을 없앴다: 크롤 설정(SettingsForm)의 1차 모델·추가 1차·2차 투표·대체 칸, 단계별 모델 선택(ReviewModelsForm)의 1차 순위·2차 투표·대체 칸,
  운영센터 머리의 「2차 표 바로 바꾸기」(SecondVoterSwitch·`switchSecondVoter`·박힌 `GROK_MODELS`·`CLAUDE_MODELS` 의 `review/voters.ts`). 그 자리에
  「작업 ↔ 모델」로 가는 안내(`TaskRanksPointer`). 저장 길(`saveReviewModels`·설정 폼 저장)은 그 칸을 쓰지 않는다 — 저장된 옛 값은 가져오기 출처로 남는다.
- `/admin/models/tasks`: 1차·2차 줄의 「지금 실제로 쓰는 모델」은 저장한 순위와 묶기 결과(쓸 수 없는 까닭·장부 이름), 「실행」 줄은 `job:crawl-agent-review`·
  `job:second-review` 의 마지막 `ai_task.ranks`, Grok 로그인 유지는 그 잡의 degraded. 연결 표의 CLI 줄에 CLI 버전.
- 상태 화면·모델 운영 현황의 1차·2차 자리(stage-registry `resolveModelSlots`, 모델 1시간 집계, 카드 자리, Grok 연결 확인 표시)는 순위를 읽는다.
  진행 감시: `second-review`·`grok-session-check` 와 `crawl-agent-review` 의 세 순위 코드도 「설정의 일 — 재시작하지 않음」(`ALL_SKIPPED_CODES`).

### 가져오기(PR A) 확인

- 1차: 옛 `firstReview` → 1순위, `firstReviewAdditional[i]` → 2·3순위(같은 가중치는 한 번). 2차: 투표자 k → 칸 k 의 1순위, 옛 대체 → 2·3순위.
- C1 에서 고친 것: 옛 대체 목록은 투표자 모두가 나눠 썼다 — 이제 **대체 모델은 그것을 받을 수 있는 첫 칸에만** 넣고 다음 칸에서는 빼며 경고한다. 투표자와 같은 모델의
  대체도 뺀다. 가져오기 출처는 C1 뒤에도 옛 설정 값이다(편집 칸이 없어 마지막 저장값 그대로) — C1 을 먼저 배포했어도 가져오기로 첫 순위를 채울 수 있다.

### 바꾸지 않는 것·남은 것

- 2차 정책 hash(`secondReviewPolicyHash`)는 저장된 옛 `firstReview`·`secondReview` 를 그대로 hash 한다 — 배포만으로 진행 중 2차 receipt 가 깨지지 않게.
- 격리 replay(`currentReplayDb`)와 replay 스냅숏 판정(`assessReplayAi2Target`·replay 준비 판정 — `withSettingsReviewers` 범위)은 예전처럼 그 스냅숏의 설정 행
  (firstReview·voters·fallbacks)을 읽는다 — 인증된 replay 입력이고 운영 프로세스는 이 길을 타지 않는다. 고정 입력 replay 실행(`runFixedInputReplay`)은 격리 DB 에 순위가
  없으므로 manifest 가 선언한 모델을 그 실행 동안 순위로 고정한다(`pinReviewTaskRanks` — 1차 = 옛 풀 차례, 2차 = 투표자 k → 칸 k, 대체 → 칸 1 의 2·3순위).
- 두 칸에 같은 모델이 있는 옛 행(저장이 막는다)은 그 모델이 표를 내는 칸, 없으면 앞 칸의 것으로 본다 — 대체 차례도 그 칸에만 든다.
- 되돌리기 주의: 예전 코드의 스키마는 2차 투표자를 하나 이상 요구한다. C1 은 기본 투표자를 비웠으므로, 저장된 설정 행에 `secondReview` 가 없던 설치에서 C1 이 설정을
  저장하면(빈 투표자) 예전 코드로 되돌릴 때 그 행이 읽히지 않는다. 운영 행에는 투표자가 저장돼 있고 C1 화면은 그 칸을 보내지 않아 그대로 남는다.
- 발행분 감사 캠페인 시작(`product-audit.ts`)은 아직 옛 `firstReview` 를 읽는다(편집 칸이 없어 마지막 저장값) — PR C2.
- 용량 측정 artifact(`pipeline-capacity-live-repository.ts`)는 아직 옛 설정의 모델을 선언한다 — 순위로 옮겨야 측정이 실제 심사자와 맞는다(PR C2/E). 인증 스냅숏
  (`pipeline-capacity-repository.ts`)은 순위를 견준다(1차 순위가 둘 이상이면 `unsupported_capacity_first_review_pool`).
- 로그인: Claude 는 CLI 가 스스로 읽는 env `CLAUDE_CODE_OAUTH_TOKEN`(compose reviewer)·자기 로그인, Grok 은 `GROK_AUTH_PATH`(운영 `/var/lib/nomorevibe-grok/auth.json`,
  기본 `~/.grok/auth.json`)를 그대로 쓴다 — 모델·계약·실행 파일 선택이 아니라 그 CLI 의 로그인 자리라 PR E 가 정한다(지금 지우면 운영 Grok 이 auth 로 실패한다).

## 운영 적용 순서

1. **PR A 배포**(migration 0162 — 새 표 둘, 기존 표·CHECK 는 그대로라 DRAIN 이 필요 없다).
2. **가져오기**(운영자): `/admin/models/tasks#import` 에서 「계획 보기」(쓰지 않는다) → 경고를 읽는다 → 확인 「가져오기」 + 적용.
3. **확인**: text 일곱 줄마다 「저장한 순위 = 지금 동작」(PR A 화면 — 웹 프로세스 env 기준이다)인지, 준비 상태에 빨간 줄이 없는지 본다. 빠진 계약·경로·장비가 있으면
   그 줄을 다시 저장해 만든다. 워커의 env 가 웹과 다르면(예전 `ABCLLM_MODEL`) 워커가 실제로 쓰던 모델(결과 행의 model·장부)과도 견준다.
4. **Oracle GRANT**(Oracle 소비자를 돌리면): `deploy/oracle/least-privilege.sql` 의 `ai_task_models`·`ai_connections` SELECT 를 적용한다.
5. **PR B 배포**. 배포 뒤 상태 화면에 `no_task_models`·`all_ranks_unusable` 이 없는지, `/admin/models/tasks` 의 「실행」 줄이 1순위로 도는지 본다.

6. **PR C1 앞**(운영자, PR C1 배포 전·후 아무 때나 웹에서): 1차·2차·Grok 로그인 유지 줄의 순위가 가져오기로 채워졌는지 본다. CLI 연결에는 「CLI 버전」을 적는다
   (워커 로그 `cli_contract.probe` 의 `observedVersion`). C1 웹이 배포된 뒤 그 줄들을 **다시 저장**해 빠진 것을 만든다 — 2차 엔진 직접 계약(예전 env
   `AI2_DIRECT_SERVING_CONTRACTS` 를 대신한다)·심사 CLI 계약 행(예전 env `CLI_SERVING_CONTRACTS` 를 대신한다)·정책 route(2차가 local-direct → abcllm 형으로 바뀌면
   새 route 를 덧붙인다, DRAIN 없음)·장비 행. 저장 전에는 그 순위가 `no_direct_contract`·`cli_contract_missing` 으로 쓸 수 없고 상태 화면에 보인다.
7. **PR C1 배포**(migration 없음). 배포 뒤 상태 화면에 1차·2차·Grok 로그인 유지의 `no_task_models`·`all_ranks_unusable` 이 없는지, `/admin/models/tasks` 1차·2차 줄의
   「실행」이 1순위로 도는지 본다. 2차 투표자의 provider 가 바뀐 칸(local-direct → abcllm 형)의 대기 표는 다음 2차 틱이 `model_removed` 로 닫고 새 표를 올린다.

**가져오기 전에 PR B 를 배포하면** 일곱 작업이 모두 `no_task_models` 로 멈춘다 — 의도한 동작이다(조용히 기본값으로 부르지 않고 상태 화면에 보인다). 가져오기·순위 저장이
끝나면 30초 안에(스냅숏) 다시 돈다. 되돌리기는 PR B 를 되돌려 배포하는 것이다(표·계약·정책 route 는 그대로 두어도 예전 코드는 읽지 않는다 — 별칭 계약은 예전 코드에서
그 모델의 선택이 없어 쓰이지 않는다).

**1차·2차 순위가 생기기 전에 PR C1 을 배포하면** 1차·2차가 `no_task_models` 로 멈춘다 — 의도한 동작이다(옛 설정·기본 투표자로 조용히 부르지 않고 상태 화면에 보인다).
2차는 그동안 대기 표를 닫지도 올리지도 않는다. 가져오기(옛 설정이 출처라 C1 뒤에도 된다)·순위 저장이 끝나면 30초 안에 다시 돈다. 되돌리기는 PR C1 을 되돌려 배포하는 것이다
(순위 저장이 만든 계약·CLI 계약 행·정책 route 는 남아도 예전 코드는 옛 설정으로 고른다 — 별칭·CLI 계약 행은 예전 코드가 읽지 않는다. 예전 코드는 env CLI 계약·
`AI2_DIRECT_SERVING_CONTRACTS` 를 다시 읽는다).

## PR C~E 가 알아야 할 것(PR B 이후)

1. **연결별 장부 이름은 text 일곱 경로만**(abcllm 형 계약의 `engineModel`). 1차(`crawl-agent-review`)·2차·로컬 직접 경로(`local-*`, 계약 `backendId`·`physicalGroup`)는
   PR C 가 같은 규칙(별칭 identity + 엔진 이름)을 옮겨야 같은 모델을 두 서버에 둘 수 있다. `aiRankReadiness` 의 review-ai1·review-ai2·local-direct 갈래는 아직 막는다.
2. **resolver 는 text 일곱 작업만 계약에 묶는다**(`bindTextTaskRank`). 심사 묶음은 provider(abcllm·local-direct·CLI)·계약 꼴이 달라 PR C 가 묶기 함수를 더한다.
   `TextTaskRanks` 의 순위 대체·degraded·`ai_task.ranks` 요약은 그대로 쓸 수 있다(이름의 text 는 역사적 — 필요하면 일반화).
3. 순위 대체가 포화(`capacity`) 때 다음 순위로 넘기면 앞 순위의 대기 행이 장부에 남는다(그 일이 다른 순위로 끝나면 TTL 로 사라진다). 1차 #792 와 같은 성질이다 — PR C 에서
   대기 행을 물리는 길이 필요한지 본다.
4. `korean-translation-direct`(한국어 Qwen 직접 경로)는 아직 `KOREAN_TRANSLATION_QWEN_ENABLED`·단계 풀을 읽는다(PR C). product-tagline-ko 잡이 `MODEL_POOL_JOBS` 에 남은 까닭이다.
5. PR E: 일곱 경로는 env·등록부 기본값을 더 읽지 않는다 — `ABCLLM_MODEL`·`ABCLLM_PROFILE_MODEL`·`SEARCH_VERIFY_MODEL`(+`_KEY`)은 소개 검수(`INTRO_CHECK_MODEL`)·
   직접 모델 단계가 더 읽지 않는지 확인한 뒤 지운다. `pipeline-control` 의 text route 판정은 provider 를 늘 `abcllm` 으로 적는다(local-direct 계약이면 「경로 없음」으로 보일 수 있다 — 예전 그대로).
6. 「지금 실제로 쓰는 모델」(PR A)은 text 일곱 줄에서 이제 저장한 순위 그대로다 — 가져오기 계획도 그 줄은 「그대로」다.
7. 운영 CLI `scripts/ops/pipeline-control.ts` 의 route 판정은 그 프로세스가 순위를 읽을 때만(앱 `DATABASE_URL` 이 있을 때) text 경로를 「계약 있음」으로 본다.
   `DATABASE_URL` 없이(`PIPELINE_CONTROL_DATABASE_URL` 만) 돌리면 text 일곱 경로는 모델 「모름」(unknown)이라 capacity OPEN 이 `deferred_routes` 로 막힌다 —
   예전에도 그 경우 계약을 읽지 못해 「계약 없음」으로 막혔다(같은 결과). 배포 도구가 이 CLI 로 OPEN 을 판정하면 `DATABASE_URL` 을 함께 준다.

## PR C2~E 가 알아야 할 것(PR C1 이후)

1. **심사 묶기는 `lib/crawl/review-task-ranks.ts`** — 1차·2차의 순위 → (provider, 장부 이름, 엔진 이름) 묶기·쓸 수 없는 까닭·degraded·`ai_task.ranks` 요약.
   text 쪽(`ai-task-resolver.ts`)과 까닭 문장 표(`TEXT_RANK_UNUSABLE_TEXT`)를 나눠 쓴다. C2 의 직접 모델 단계도 같은 꼴(순위 → 계약 → identity)로 묶기 함수를 더하면 된다.
2. **로컬 직접 경로(`local-*`)는 아직 막는다**: `aiRankReadiness` 의 `local-direct` 갈래(예산 = 계약 `backendId`, 장비 = `physicalGroup` 이어야 열린다 — 저장이 만들지 않는다)와
   `crossRankIssues`(같은 모델을 두 서버로 두 순위에 둘 수 없음). 주의(PR A 의 남은 일 3 그대로): `local-direct:<route>` 꼴의 계약 행(배정 표 저장 `saveModelAssignment` 의
   local-direct 갈래)은 `tableLocalModelContracts` 에서 계약이 null 로 읽혀 같은 주소·모델의 env 계약을 `verifiedLocalModelContract` 에서 닫는다 — C2 가 로컬 계약을
   연결에서 만들 때 이 행과 겹치지 않게(또는 그 행을 함께 정리하게) 한다.
3. C2 대상: 사람 몫 위임·2차 갈림 재확인·판가름·보류 재심사·감사 직접 모델·감사 두 번째 의견·공개분 추가 검수·화면 판별(`local-*` 단계 풀·등록부·env),
   한국어 Qwen 직접 경로(`KOREAN_TRANSLATION_QWEN_ENABLED`·단계 풀 — product-tagline-ko 잡이 `MODEL_POOL_JOBS` 에 남은 까닭), 소개 검수(`INTRO_CHECK_MODEL`·
   env `CLI_SERVING_CONTRACTS`·`CLAUDE_CLI`), 발행분 감사 캠페인(시작이 옛 `firstReview` 를 읽는다 — 이제 편집 칸이 없어 마지막 저장값이 굳는다; 감사 작업 순위로 옮긴다),
   LLM 보강(`LLM_ASSIST_BACKENDS`), 카테고리 분류(connect 에이전트 — env CLI 계약·`CODEX_CLI`·`CLAUDE_CLI`, 분류 기본값 `classificationDefaultConfig`).
   CLI 계약을 DB 행으로 옮기려면 `CLI_DB_CONTRACT_ROUTES` 에 route 를 더하고 `cli-db-contracts.ts` 에 그 route 의 argv 상한을 적는다(connect 에이전트는
   `probeCliServingContracts` 를 부르므로 같은 버전 확인을 탄다).
4. **2차의 줄 대기 대체**(`capacity_wait_timeout`)는 첫 표가 엔진 직접(local-direct·abcllm 형)일 때만이다 — CLI 첫 표는 줄에서 기다려도 다른 순위로 넘기지 않는다
   (실패하면 표 실패 대체로 넘어간다). 1차의 포화 대체는 PR B 의 남은 일 3 처럼 앞 순위의 대기 행을 TTL 로 남긴다.
5. **격리 replay**(인증 replay 도구 `scripts/pipeline-replay-fixed-input.ts`·`pipeline-replay-*`)는 아직 replay 설정 행의 firstReview·voters·fallbacks 를 선언·읽는다
   (`currentReplayDb` 갈래 — `first-reviewers.ts`·`second-review-voters.ts`). 운영 1·2차가 순위를 읽게 됐으니 replay manifest 도 순위를 선언하게 옮겨야
   측정이 실제와 맞는다(C2/E). 용량 측정 artifact(`pipeline-capacity-live-repository.ts`)도 같다.
6. **PR E 가 지울 것(C1 이 더 읽지 않게 된 것)**: `AI2_DIRECT_SERVING_CONTRACTS`(코드에서 읽기 없음), 1·2차·Grok 로그인 유지의 `CLI_SERVING_CONTRACTS` 항목(나머지 route 는
   C2), `CLAUDE_CLI`·`GROK_CLI`(1·2차·Grok 로그인 유지는 PATH 이름 — 소개 검수·감사·분류·`lib/operations/agent.ts`·`claude.ts` 는 아직 읽는다), 크롤 설정의
   `firstReview`·`firstReviewAdditional`·`secondReview.voters`·`fallbacks` 칸(가져오기·replay·2차 정책 hash·감사 시작만 읽는다 — hash 를 바꾸면 진행 중 2차 receipt 가
   한 번 깨진다), `DEFAULT_MODEL_CANDIDATES`·`modelCandidates`(부르는 곳 없음), 배정 표의 ai1·ai2 행·가져오기(`assignment-import.ts`), 리뷰 라우팅 프리셋
   (`review-routing-preset.ts` — 옛 설정만 바꾼다), `admin-engine-connect` 의 옛 설정 이름 바꾸기(1차 칸). 로그인 env(`CLAUDE_CODE_OAUTH_TOKEN`·`GROK_AUTH_PATH`)는 남길지 정한다.
7. `pipeline-control` 의 route 판정: 1차·2차·Grok 로그인 유지는 순위에서 읽는다(CLI `scripts/ops/pipeline-control.ts` 가 순위 스냅숏도 읽는다). 순위를 못 읽는 프로세스에서는
   1차가 「모름」(provider claude-cli, model 없음)이라 capacity OPEN 이 막힌다 — text 경로와 같다(배포 도구는 `DATABASE_URL` 을 함께 준다).

## PR A 가 남긴 것(B 가 푼 것은 표시)

1. ~~같은 모델 이름을 두 서버에 둘 수 없다~~ — **PR B 가 text 일곱 경로, PR C1 이 1차·2차에서 풀었다.** 직접 모델 단계는 PR C2.
2. ~~2차 대체 목록은 오늘 투표자 모두가 나눠 쓴다~~ — **PR C1 이 풀었다**(저장·실행 둘 다 한 모델 한 칸, 가져오기는 대체를 첫 칸에만).
3. **로컬 직접 경로(`local-*`)** 는 예산 = 계약 `backendId`, 장비 = `physicalGroup` 이어야 열린다. PR C 가 연결에서 로컬 계약(`local-model:<backendId>`)을 만들어야 한다.
   주의: `local-direct:<route>` 꼴의 계약 행(배정 표 저장 `saveModelAssignment` 의 local-direct 갈래가 쓴다)은 `tableLocalModelContracts` 에서 계약이 null 로 읽혀,
   같은 주소·모델의 env 계약을 `verifiedLocalModelContract` 에서 닫는다. PR A 는 로컬 계약을 쓰지 않는다.
4. **CLI 계약**(`CLI_SERVING_CONTRACTS`)은 connect 에이전트 쪽이라 웹이 확인하지 못한다. — **PR C1 이 1차·2차·Grok 로그인 유지를 옮겼다**(연결의 CLI 버전 → DB 행,
   버전은 워커가 견준다). 소개 검수·감사·분류는 PR C2.
5. **보강 assist** 는 route 가 작업·장비마다 다르고(`local-assist-<작업>-<backend>`), **감사 캠페인** 은 시작할 때 모델을 굳힌다. PR C 가 규칙을 정한다.
6. ~~Oracle 소비자 권한~~ — **PR B 가 더했다**(위 「Oracle 소비자 권한」).
7. 「지금 실제로 쓰는 모델」은 **웹 프로세스 env** 기준이다. 워커의 env 가 다르면(예: `EMBEDDING_URL`) 다를 수 있다.
8. 임베딩·재정렬은 요청에 모델 이름을 싣지 않는다. PR D 가 순위의 모델 이름을 서버 확인(목록에 있는가)에 쓴다.

## PR E 가 지울 환경변수·코드 기본값

환경변수(모델·주소·키·계약을 고르는 것):

- `AUDIT_SECOND_OPINION_URL`·`AUDIT_SECOND_OPINION_API_KEY`·`AUDIT_SECOND_OPINION_MODEL`·`AUDIT_SECOND_OPINION_LABEL`
- `SCREEN_REVIEW_MODEL`·`SCREEN_REVIEW_MODEL_URL`·`SCREEN_REVIEW_MODEL_API_KEY`
- `LLM_ASSIST_BACKENDS`·`LLM_ASSIST_API_KEYS`
- `LOCAL_MODEL_SERVING_CONTRACTS`·`LOCAL_MODEL_VERIFIED_CONTRACT_HASHES`·`LOCAL_MODEL_PHYSICAL_LIMITS`·`AI2_DIRECT_SERVING_CONTRACTS`·`CLI_SERVING_CONTRACTS`
- `LOCAL_MODEL_RELAY_MODEL`(`_KEY`)·`LOCAL_MODEL_RELAY_UPSTREAM_URL`
- `EMBEDDING_URL`·`RERANK_URL`
- `ABCLLM_BASE_URL`·`ABCLLM_MODEL`·`ABCLLM_PROFILE_MODEL`(그리고 `*_KEY` 선택자), `SEARCH_VERIFY_MODEL`(`_KEY`), `INTRO_CHECK_MODEL`(`_KEY`)
- `MODEL_REGISTRY_CONFIG`·`MODEL_ASSIGNMENT_TABLE`
- `KOREAN_TRANSLATION_QWEN_ENABLED`·`KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED`(켜기는 「한국어 소개 번역 · 직접 경로」에 순위가 있는가로)
- CLI 실행 파일·로그인(`CLAUDE_CLI`·`GROK_CLI`·`CODEX_CLI`·`GROK_AUTH_PATH`·`CLAUDE_CODE_OAUTH_TOKEN`)은 모델 선택이 아니라 도구 위치·로그인이다 — 남길지 PR E 에서 정한다.

코드 기본값:

- `lib/llm/model-registry.ts` 의 `DEFAULT_MODEL_DEFINITIONS`(박힌 주소 `http://100.77.43.63:8090/v1`·`http://100.92.77.66:8010/v1`·`https://abcllm-api.brut.bot/v1` 과 모델 이름),
  `DEFAULT_MODEL_CANDIDATES`, `MODEL_PURPOSE_ENV`, 관리자 덮어쓰기 `model_registry_overrides`(0148)를 읽는 길.
- 단계 풀(`stageModelPools`)·`firstReview`·`firstReviewAdditional`·`secondReview.voters`·`fallbacks`·배정 표(`model_helper_assignments` role primary)의 모델 고르기.
- `lib/crawl/settings-schema.ts` 의 2차 기본 투표자(`modelForPurpose("ai2-cli")`), `lib/operations/classification-models.ts` 의 분류 기본값(`classificationDefaultConfig`).
- `lib/crawl/korean-translation-config.ts`·`lib/crawl/qwen-direct-review.ts` 의 등록부 기본 주소·모델 읽기.
- `lib/domain/products/embedding.ts` 의 `EMBEDDING_MODEL` 은 벡터 공간 이름(저장된 벡터의 판)이라 모델 선택과 따로 남길지 PR D 가 정한다.

## 쓰는 순서 (운영자)

1. `/admin/models/tasks#import` 에서 「계획 보기」 → 경고를 읽는다(주소 모름·꺼짐·풀 나눠 쓰기).
2. 확인 「가져오기」 + 적용 → 연결과 순위가 생긴다.
3. 「작업 ↔ 모델」 줄마다 「저장한 순위 = 지금 동작」인지, 준비 상태에 빨간 줄이 없는지 본다.
4. 필요하면 줄을 고쳐 저장한다(저장이 없는 계약·경로·장비를 만든다). 잡은 PR B 배포 전까지 이 순위를 읽지 않는다 — PR B 배포 뒤 text 일곱 작업은 저장 30초 안에 새 순위로 돈다.

## 검증 (PR C1)

- `npx tsc --noEmit -p .`(시험 포함) 깨끗, 바뀐 파일 128개의 eslint 깨끗.
- 바뀐 범위의 단위 시험 260개 파일(1차·2차·CLI·계약·화면·상태·replay 판정을 건드리는 파일 + 새 시험 `tests/review-task-ranks.test.ts`·
  `tests/second-review-slot-fallbacks.test.ts`·`tests/cli-db-contracts.test.ts`) — 4,121 통과·실패 0(vitest 가 일꾼 프로세스 heap 종료 2건을 「Unhandled error」로
  알렸지만 260개 파일 모두 결과가 났다; base 와 견주지는 않았다).
- 바뀐 범위의 통합 시험 79개 파일 — 1,028개 모두 통과(자기 DB 3개, 파일마다 DB 를 새로 만들어 하나씩). 새 통합 시험: `tests/integration/ai-task-model-ranks.test.ts` 의
  「1차·2차 심사(PR C1)」(2차 칸 계약·정책 경로·칸 겹침 막음·DB 스냅숏 묶기·연결 키, CLI 버전 없으면 막음·cli 계약 행).
- 통합 시험의 설정 기반 순위 고정: `tests/integration/env.ts` 가 마지막으로 읽은 크롤 설정을 순위로 옮겨 고정한다(파이프라인 시험이 예전과 같은 심사자로 돈다).
  순위 표·계약 묶기 자체는 위 새 시험이 고정을 풀고 진짜 DB 로 본다. spawn 하는 스크립트 시험은 `tests/integration/fixtures/review-ranks-child-preload.ts` 로 같은 고정을 준다.
- 전체 단위·전체 DB 시험은 정책대로 통합 단계에서 돈다(돌리지 않았다).

## 검증 (PR B)

- `npx tsc --noEmit`, 바뀐 파일의 eslint, 새 단위 시험 `tests/ai-task-resolver.test.ts`(묶기·순위 대체·degraded·키·진행 감시)·`tests/ai-task-alias-wire.test.ts`
  (별칭 계약의 wire = 엔진 이름), `tests/ai-task-model-ranks.test.tsx`(별칭 준비 확인), 바뀐 범위의 기존 단위·통합 시험(일곱 작업의 잡·깊은 모듈·화면),
  통합 시험 `tests/integration/ai-task-model-ranks.test.ts`(두 연결 같은 모델 저장 → DB 스냅숏 → resolver, 자기 DB). 전체 단위·전체 DB 시험은 정책대로 통합 단계에서 돈다.

## 검증 (PR A)

- `npx tsc --noEmit`, 바뀐 파일의 eslint, 단위 시험 `tests/ai-task-model-ranks.test.tsx`·`tests/admin-first-review-ranks.test.tsx`·`tests/dr-web-fence.test.ts` 와 관련 화면 시험,
  통합 시험 `tests/integration/ai-task-model-ranks.test.ts`(자기 DB). 전체 단위·전체 DB 시험은 정책대로 통합 단계에서 돈다.
