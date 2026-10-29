# 모델 레지스트리와 장비별 선택

이 문서는 설정 준비 절차다. 이 차선은 배포·운영 DB 갱신·실제 모델 서버 호출을 수행하지 않았다. 현재 모델의 운영 참여는 실제 dispatch, terminal, 품질 검사 및 저장 영수증으로 따로 확인한다.

## 설정 위치와 우선순위

`lib/llm/model-registry.ts`가 호환 기본값과 검증기를 한 곳에 둔다. 기존 `LOCAL_MODEL_SERVING_CONTRACTS`와 같은 versioned JSON 환경설정 방식을 사용하며 새 DB 테이블·마이그레이션·인증 설정을 만들지 않는다.

`MODEL_REGISTRY_CONFIG`는 `{version:1, models:[...], selections:{...}, limits:{...}, deadlines:{...}, timeouts:{...}, candidates:{...}}`다. 생략하면 중앙 기본값을 사용한다. 지정하면 **models 전체 목록**을 대체한다. 잘못된 JSON, 중복 키, 다른 장비를 가리키는 키/게이트웨이 label, 존재하지 않는 선택은 거절한다. 현재 배포 이미지의 코드 수정·재빌드 없이 설정과 프로세스 재시작으로 교체할 수 있다. import 시 읽는 기존 상수와 검증 계약은 프로세스 재시작이 필요하며, 실행 중인 프로세스의 env를 고친 것만으로 즉시 바뀐다고 주장하지 않는다. 웹·실제 소비 워커·connect/relay에 필요한 같은 설정을 전달한다. 브라우저 번들에 고정되는 `NEXT_PUBLIC_*`는 사용하지 않는다.

전체 기본 설정의 비밀 없는 편집 사본은 아래 명령으로 만든다. 원본 목록을 먼저 보존하고 필요한 entry/selection/limit만 편집한다.

```bash
node --import tsx -e 'const {readModelRegistry}=require("./lib/llm/model-registry.ts"); console.log(JSON.stringify(readModelRegistry({}), null, 2))' > model-registry.json
```

각 entry에는 다음 값이 있다.

| 필드 | 의미 |
| --- | --- |
| `key` | `장비:모델 식별자` 형식의 고유 키. `gpu3090:review`, `m1:translation`처럼 실제 요청 이름과 분리된 안정된 모델 entry 식별자다. 같은 장비의 다른 모델은 다른 entry/key를 쓴다. |
| `equipment`, `displayName` | 장비 식별자와 운영자 표시 이름 |
| `provider` | 기존 어댑터: abcllm/local-direct/claude-cli/codex-cli/grok-cli/llama-server. 해당 작업이 지원하지 않는 어댑터로의 변경은 거절하며 임의의 다른 전송으로 바꾸지 않는다. |
| `baseUrl` | HTTP 기본 주소(`/v1`까지), CLI는 null. 계정·비밀·query·fragment를 넣지 않는다. |
| `model`, `family` | 실제 요청 모델 이름과 독립성 판정 family. family를 장비별로 다르게 꾸며 같은 가중치 두 표를 독립 표로 만들면 안 된다. |
| `gatewayLabel` | abcllm의 명시적 장비 label. `equipment`와 일치해야 한다(MLX 대소문자 허용). wire는 `[m1] 실제모델`처럼 생성하고 label을 제거하지 않는다. |
| `timeoutMs`, `deadlineLadder` | 모델 클라이언트 예산과 선택적 전체 기한 사다리. 사다리는 engineMs < relayMs < gatewayMs < clientMs 및 이웃 간 2초 이상 여유를 로드 시 검증한다. relay가 없는 경로는 relayMs=null. timeoutMs는 선언한 clientMs와 일치해야 한다. 외부 엔진·gateway가 실제로 강제하는지는 별도 증명이 필요하다. |
| `maxTokens`, `concurrency` | 모델 상한. 목적별 예산과 검증된 serving/capacity 상한도 충족해야 한다. relay의 한 요청 보존·실행 중/unknown 차단은 별도 안전장치다. |
| `purposes` | AI1·AI2·번역·보강 등 허용 용도. 용도마다 후보가 여럿이면 `selections[용도]=key`로 하나를 고른다. |

`limits[용도]`는 `{maxTokens, concurrency, timeoutMs?}`이며 기존 요청별 예산 기본값을 대체한다. 모델 상한과 더 작은 값을 사용한다. 번역처럼 입력 크기에 따라 계산하는 요청은 그 예산보다 작을 수 있다. 네트워크·수집·DB 대기열 동시성, 문맥 상한 C, tokenizer 증명, byte 제한은 모델의 요청 예산과 별개다.

텍스트·직접 심사의 우선순위는 해당 기존 변수의 `*_MODEL_KEY` → 기존 모델 env → registry selection → 중앙 기본 entry다. 예를 들어 `PRODUCT_TRANSLATION_MODEL_KEY=m1:translation`이 옛 `PRODUCT_TRANSLATION_MODEL`보다 우선한다. `ABCLLM_MODEL_KEY`는 공용 사유·한국어 소개·검색 질의에 적용한다. 기존 `ABCLLM_BASE_URL`, `AUDIT_SECOND_OPINION_URL`의 명시적 override는 보존한다. 모델별 주소를 사용할 때는 오래된 공용 URL override도 확인한다. 옛 모델 env 값은 그 용도의 route로 해석한다(`resolvePurposeModel`). 여러 장비에 있는 bare 이름은 그 용도의 selection(없으면 purposes)이 가리키는 entry가 정확히 하나일 때만 그 entry로 정하고, 아니면 `ambiguous_model_identity`로 거절한다. 첫 번째 장비로 추측하지 않는다. 등록된 장비 label인데 그 장비에 등록되지 않은 모델(예: `[m1] qwen3.8-flash-next`)은 같은 장비에서 그 용도의 현재 등록 모델로 해석한다. 다른 장비 label과 등록되지 않은 label·기존 모델 이름은 호환 목적으로 그대로 유지한다. `configuredModelRoute(용도)`가 key·장비·route·wire 이름·주소를 함께 돌려준다.

M1 relay의 허용 모델도 같은 등록부에서 읽는다: `LOCAL_MODEL_RELAY_EQUIPMENT`(기본 `m1`) 장비의 `relay` 용도 entry. 중앙 기본값에서 `relay` 용도는 `m1:translation`에 있다. 기존 JSON을 쓰면 M1 entry에 `relay` 용도를 넣는다(`scripts/migrate-model-registry-m1.ts --print-migration`이 함께 준비한다).

## M1 Gemma 4 26B로 번역 설정하기 (main PR732 기준)

대표가 실제로 실행할 순서·읽기 명령·성공 조건은 [M1 relay·상품 번역 등록부 연결 — 대표 실행 안내](2026-10-29-m1-relay-registry-rollout.md)가 기준이다. 이 절은 그 안내가 기대는 코드 기본값과 우선순위만 정리한다.

현재 코드 기본 entry는 `m1:translation`(표시 이름 `M1 · Gemma 4 26B`, provider=abcllm, gatewayLabel=m1, 공용 gateway 주소, timeoutMs 40초)이고 wire 이름은 `[m1] mlx-community--gemma-4-26b-a4b-it-4bit`다. purposes는 `product-translate`·`reason-translate`·`relay`다. 확인되지 않은 M1 직접 주소는 만들지 않으며, HTTP entry의 baseUrl 누락은 `model_base_url_required`로 거절한다.

`MODEL_REGISTRY_CONFIG`가 **없을 때** 실제 해석(2026-10-29 이 저장소에서 `configuredModel` 실행으로 확인):

| 설정 | 상품 번역 | 사유 번역 | 한국어 소개·검색 질의 |
| --- | --- | --- | --- |
| 아무 env 없음 | `[m1] mlx-community--gemma-4-26b-a4b-it-4bit` | 같음 | `[MLX] gpt-oss-120b` |
| 옛 `PRODUCT_TRANSLATION_MODEL=[m1] qwen3.8-flash-next`만 남음 | 같은 M1 장비의 현재 등록 모델(Gemma)로 해석 | Gemma | gpt-oss |
| `PRODUCT_TRANSLATION_MODEL_KEY=m1:translation` | Gemma(KEY가 옛 변수보다 우선) | Gemma | gpt-oss |
| `ABCLLM_MODEL=gpt-oss-120b`가 설정됨 | Gemma | **gpt-oss**(공용 env가 등록부 기본값보다 우선) | gpt-oss |

따라서 운영 반영에 필요한 설정은 다음뿐이다. 모두 대표가 승인된 절차로 수행하며, 이 차선은 운영 env·DB·relay를 바꾸지 않았다.

1. 상품 번역 소비자(text-m3·mini 예비 text)와 표시용 web에 `PRODUCT_TRANSLATION_MODEL_KEY=m1:translation`을 둔다. 오래된 `PRODUCT_TRANSLATION_MODEL`은 KEY가 있으면 무시되며 정리 대상으로 기록한다.
2. 운영 앱이 `MODEL_REGISTRY_CONFIG`를 쓰고 있으면 코드 기본값이 그 JSON을 바꾸지 않는다. 오프라인 도구로 후보를 만들고 diff를 검토한다. 기대 diff는 `m1:translation`의 model·family·displayName이 Gemma 값이 되고 purposes·selections에 `product-translate`·`reason-translate`·`relay`가 들어가는 것뿐이다.

   ```bash
   node --import tsx scripts/migrate-model-registry-m1.ts --print-migration < registry-before.json > registry-candidate.json
   ```

3. 사유 번역도 M1로 옮기려면 그 소비자의 `ABCLLM_MODEL`/`ABCLLM_MODEL_KEY`와 DB 단계 풀을 먼저 확인한다. 우선순위는 `*_MODEL_KEY` → 모델 env → `selections` → 기본값이므로, `ABCLLM_MODEL`이 설정된 소비자에서는 `selections["reason-translate"]`만으로는 바뀌지 않는다(확인: selection+`ABCLLM_MODEL=gpt-oss-120b` → `[MLX] gpt-oss-120b`). 공용 변수를 바꾸면 한국어 소개·검색 질의도 함께 바뀐다. 사유 번역만 옮기려면 `/admin/models`의 «심사 사유 번역» 단계 풀에 `m1:translation`을 저장한다(그 용도의 실행 범위에만 KEY를 준다). 공용 env가 없는 소비자는 JSON `selections["reason-translate"]`로도 된다.
4. 용량 정책의 `product-translate`(필요 시 `reason-translate`) route 모델이 `[m1] mlx-community--gemma-4-26b-a4b-it-4bit`이고 같은 이름의 `ABCLLM_SERVING_CONTRACTS`가 있어야 호출이 열린다. 없으면 호출은 deferred이며 레지스트리 등록만으로 OPEN/ready가 되지 않는다. 정책 변경은 기존 감사된 DRAINING → 검증된 계약/정책 → OPEN 절차로만 한다.
5. M1 relay는 설치기 plist가 `MODEL_REGISTRY_CONFIG`를 넘기지 않으므로 중앙 기본값(`relay` 용도 = `m1:translation`)을 읽는다. 재설치 SHA·plist 모델 값·시점 제약은 위 대표 실행 안내를 따른다.
6. 이미 전송된 요청과 unknown은 원래 세대/모델/정책에 남는다. 이름을 바꿨다고 취소·정산·재전송하지 않는다. 실제 참여는 M1 dispatch·strict terminal·번역 저장 model label 증가로만 기록한다.

롤백은 보존한 정확한 entry/env/계약/정책을 같은 감사 절차로 되돌리는 것이다. 공유 번역 기본값으로 추측해 바꾸거나 번역 행·재시도·품질 보류·unknown 요청을 초기화하지 않는다.

## AI2 직접 모델의 장비 키

AI2의 새 직접 모델 선택지는 `model: gpu3090:review`, provider=local-direct다. 실제 요청 모델 이름은 이 키의 entry와 **주소까지 일치하는 검증 계약**에서 가져온다. capacity binding/policy route는 장비 키를 사용하고 실제 HTTP body/tokenizer는 계약의 model을 사용한다. 계약의 hash·C·revision을 레지스트리 값으로 재작성하지 않는다. 기존 bare 모델 선택은 단 하나의 계약과 맞을 때만 호환된다. 같은 이름의 두 직접 계약은 backendId로 각각 보존하며 bare 이름만으로는 선택하지 않는다.

전환할 때 AI2 설정과 policy route의 model을 같은 키로 준비하고 provider budget/physical group을 원래 검증된 장비와 맞춘다. 검증 계약은 실제 wire 이름을 유지한다. 출력 토큰은 계약에서 양의 정수로 설정할 수 있으나 기존 요청 정책 32,000 및 실제 context C를 넘지 않고 exact tokenizer 검증을 통과해야 한다. 장비 키 경로에서 계약의 출력 상한이 registry ceiling보다 크면 거절한다. 낮춘 registry ceiling을 적용하려면 같은 출력 상한의 검증 계약도 준비한다.

장비가 달라도 가중치가 같으면 독립 투표가 아니다. JS와 SQL의 underlying 비교는 키를 실제 모델로 해석한다. 슬롯/라우팅 키와 독립성 family를 구분한다. `first-reviewers.ts`는 firstReviewCandidates()로 레지스트리 후보 제안을 읽는다. 실제 배정은 저장된 primary/additional pool, active intent/retry 고정, 미전송 후보만 우회하는 PR710 정책을 유지한다. 후보 제안 목록을 바꿔도 현재 DB 심사 풀은 바뀌지 않는다.

## 검증과 운영자 화면

사람 검토 위임 스위치(설정 화면·모델 화면)와 심사 화면의 바로가기 알약은 저장된 `human-review` 풀이 있으면 그 표시 이름들을, 없으면 레지스트리의 `human-review` 모델 표시 이름과 `key · 요청 이름`을 보여 준다(`humanReviewModelDisplay`). 고정 «DeepSeek·M3 Ultra» 문구는 없앴다.

`/admin/models`의 기존 단계 표는 실제 소비자와 같은 모델 선택을 표시한다. 제품 번역은 `PRODUCT_TRANSLATION_MODEL`의 독립 선택을 보여 준다. `등록된 모델 설정`을 펼치면 현재 웹 프로세스의 키·표시 이름·provider·주소·요청 이름·모델 상한을 본다. 개별 env override는 단계 표를 확인한다. connect 모델 선택과 provider 표시는 서버가 전한 레지스트리 metadata를 사용한다. registry 교체로 저장된 옛 CLI 선택이 목록에서 사라져도 인증·기존 선택을 삭제하거나 새 기본값으로 자동 적용하지 않는다. 선택을 화면에 보존하고 실행/준비를 보류하며, 새 등록 모델을 선택·검사·적용한 뒤 분류를 재개한다.

```bash
scripts/verify-model-config.sh
```

이 명령은 이 차선의 명시적 단위 시험 목록, `next typegen`, `tsc --noEmit --incremental false`, 동일 `git grep`의 기준→현재 줄 수와 감소 판정을 실행한다. 전체 unit·전체 DB·전체 e2e·운영 API 호출은 넣지 않는다. 각 시험 파일의 존재도 검사해 Vitest가 잘못 적힌 파일 이름을 조용히 건너뛰지 않게 한다. 실제 앱/운영 검증은 CLI 통과와 별도로 기록한다.

남은 항목과 검증 실패 이력은 [model-config-backlog.md](model-config-backlog.md)에 보존한다.

## 기한·후보 설정과 오프라인 설정 이전

경로별 호출 예산 기본값(`timeouts[경로]`로 대체 가능): 운영자 분류 검사·분류 호출 `classify-cli` 35초, 화면 판별 `screen-review` 90초 등은 `DEFAULT_MODEL_TIMEOUTS`에 있다. 값은 기존 상수와 같다.

`deadlines["review-gateway"]`의 기본값은 PR711과 같은 `{engineMs:50000, relayMs:null, gatewayMs:55000, clientMs:60000}`다. 모델별 deadlineLadder가 있으면 그 장비의 클라이언트 기한을 사용하며, 없으면 역할의 기한과 모델 timeoutMs 중 작은 값을 사용한다. 순서 위반은 `invalid_model_registry:...deadline_order_inverted`, 선언 불일치는 `model_timeout_ladder_mismatch`로 실패한다. timeouts[용도]로 경로별 예산을 지정할 수도 있다. 같은 경로에 전체 사다리가 있으면 clientMs와 같아야 한다. 모델/용도별 출력은 maxTokens와 역할 예산 중 작은 값이다. 검증 계약과 exact tokenizer의 상한은 별도로 보존한다.

제품 번역은 PR711의 40초 클라이언트 예산을 유지한다. 증명이 없는 M1 내부 엔진 기한은 만들지 않았다. 기존 job deadline/lease는 설정 예산보다 먼저 중단할 수 있다. relay 기본 upstream은 90초이고 maxOutputTokens는 relay 모델과 limits.relay의 작은 값이다. 기존 LOCAL_MODEL_RELAY_* 기한은 유효성·사다리 일치를 검사한다. 엔진 상한은 여전히 명시적 LOCAL_MODEL_RELAY_ENGINE_DEADLINE_MS와 강제 시작 시각이 필요하다. 레지스트리 선언만으로 unknown을 회수하지 않는다. 자동 회수 기본 비활성도 유지한다.

`candidates["first-review"]`는 등록된 key 목록이다. 기본 제안은 기존 Supa, MLX GPT OSS, Claude sonnet/opus, Grok을 유지한다. gpt-oss 제외나 실제 DB pool 수정은 포함하지 않는다. 외부 gateway 동적 목록도 기존처럼 제안할 수 있다. 진행 중인 요청·재시도·심사 결과는 설정 이전 대상이 아니다.

이미 MODEL_REGISTRY_CONFIG를 쓰고 있다면 코드 기본값 변경만으로 이전 JSON이 바뀌지 않는다. 아래 **로컬 파일 입력→후보 JSON 출력** 도구로 주소·기한·출력·동시성·다른 모델·후보 목록을 보존한 이전본을 만든다. 도구는 DB/네트워크에 연결하지 않는다.

```bash
node --import tsx scripts/migrate-model-registry-m1.ts --print-migration < registry-before.json > registry-candidate.json
```

빈 입력·M1 entry 누락·M1 gateway 불일치·주소 누락은 오류다. 이전본을 검토한 뒤 별도 승인된 운영 절차에서 설정한다. 우선순위 때문에 PRODUCT_TRANSLATION_MODEL_KEY=m1:translation도 함께 준비하고 오래된 PRODUCT_TRANSLATION_MODEL은 대체 대상으로 기록한다. 직접 주소를 추측하거나 운영 DB를 갱신하는 마이그레이션은 없다. 이번 차선은 후보 JSON 생성과 코드·PR·CI·main 병합까지만 수행한다.
