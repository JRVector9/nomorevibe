# 작업 ↔ AI 모델 1~3순위 (2026-11-02)

상태: **PR A — 표·관리 화면·가져오기만.** 잡은 아직 이 표를 읽지 않는다. 운영 적용(배포·migration)은 이 문서가 하지 않는다.

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
- 2차: 투표자끼리 같은 1순위 모델은 안 된다(대체 순위는 겹쳐도 된다).

## 다섯 PR

| PR | 하는 일 |
| --- | --- |
| **A (이 PR)** | 표 0162 · 작업 목록 · 관리 화면(AI 연결, 작업 ↔ 모델, 「지금 실제로 쓰는 모델」 비교) · 오늘 설정 가져오기. 실행 쪽 동작은 바꾸지 않는다 |
| B | 공통 실행 resolver(순위 대체) — 글 짓기·번역·검색 text 작업이 이 표를 읽는다 |
| C | 심사 묶음(1차·2차 투표자·직접 모델 단계·CLI 작업)이 이 표를 읽는다 |
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

## PR B~E 가 알아야 할 것

1. **같은 모델 이름을 두 서버에 둘 수 없다(오늘).** 계약은 (경로, 모델), 정책 route 는 (경로, provider, 모델)마다 하나라
   1순위 gpu3090·qwen 과 2순위 supa·qwen 을 가를 수 없다. PR A 는 막는다. PR B 는 계약·route 를 연결 단위로 나눠야 한다(예: 연결 id 를 route 이름이나 계약 열쇠에 넣기).
2. **2차 대체 목록은 오늘 투표자 모두가 나눠 쓴다.** 가져오기는 각 칸의 2·3순위에 같은 대체 모델을 넣는다. PR C 는 한 항목에서 같은 대체 모델이 두 표를 내지 않게 해야 한다.
3. **로컬 직접 경로(`local-*`)** 는 예산 = 계약 `backendId`, 장비 = `physicalGroup` 이어야 열린다. PR C 가 연결에서 로컬 계약(`local-model:<backendId>`)을 만들어야 한다.
   주의: `local-direct:<route>` 꼴의 계약 행(배정 표 저장 `saveModelAssignment` 의 local-direct 갈래가 쓴다)은 `tableLocalModelContracts` 에서 계약이 null 로 읽혀,
   같은 주소·모델의 env 계약을 `verifiedLocalModelContract` 에서 닫는다. PR A 는 로컬 계약을 쓰지 않는다.
4. **CLI 계약**(`CLI_SERVING_CONTRACTS`)은 connect 에이전트 쪽이라 웹이 확인하지 못한다. PR C/E 가 연결(`cli_tool`·`cli_models`)에서 만들게 옮긴다.
5. **보강 assist** 는 route 가 작업·장비마다 다르고(`local-assist-<작업>-<backend>`), **감사 캠페인** 은 시작할 때 모델을 굳힌다. PR C 가 규칙을 정한다.
6. **Oracle 소비자 권한**: 새 표는 아직 아무 역할도 읽지 않아 `deploy/oracle/least-privilege.sql`·`ORACLE_DB_PROFILES` 에 넣지 않았다. PR B 가 읽기 권한을 더한다
   (`api_key_ciphertext` 는 암호문이고 box key 는 Oracle 에 없다 — `model_serving_contracts` 와 같은 결정).
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
4. 필요하면 줄을 고쳐 저장한다(저장이 없는 계약·경로·장비를 만든다). 잡은 PR B 배포 전까지 이 순위를 읽지 않는다.

## 검증 (PR A)

- `npx tsc --noEmit`, 바뀐 파일의 eslint, 단위 시험 `tests/ai-task-model-ranks.test.tsx`·`tests/admin-first-review-ranks.test.tsx`·`tests/dr-web-fence.test.ts` 와 관련 화면 시험,
  통합 시험 `tests/integration/ai-task-model-ranks.test.ts`(자기 DB). 전체 단위·전체 DB 시험은 정책대로 통합 단계에서 돈다.
