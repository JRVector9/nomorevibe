# 기한 사다리(엔진 < 중계기 < 게이트웨이 < 클라이언트)와 자동 해제 선언

작성: 2026-10-28 UTC, 작업 공간 `xaegis/36694e57`(기준 커밋 `8c10f0ad` 위, origin/main `199a3ebb` 기준으로 옮겨야 함).
대표 지시 3·4단계의 코드와 값 근거다. **이 세션에서는 운영 DB·모델·게이트웨이에 접근하지 못해 새 지연 측정을 하지 못했다.**
아래 수치는 저장소 문서에 이미 기록된 실측을 인용한 것이며, 배포 전 최근 p95/p99를 다시 재야 한다(아래 측정 절차).

## 왜 바꾸나

| 층 | 바꾸기 전 | 출처 |
| --- | --- | --- |
| 제품 번역 클라이언트 | 20초 | `lib/jobs/products/translations.ts` |
| AI1·AI2 클라이언트 | 60초 | `REVIEW_GATEWAY_TIMEOUT_MS`, item 소비자 |
| M1 중계기 → 엔진 | 90초, 넘기면 이후 모든 추론 503 | `scripts/local-model-relay/service.ts` |
| abcLLM 게이트웨이 → 엔진 | read 600초, 전체 기한·취소 확인 없음 | `2026-10-15-pipeline-pr01b-provider-audit.md:43` |
| 모델 서버 | 최대 실행시간 없음(`termination: response_only`) | 서빙 계약 |

바깥 층(클라이언트)이 먼저 포기하면 GPU 작업이 계속되는지 알 수 없어 `indeterminate`가 된다. 물리 그룹 상한이 1이면 그 한 건이 같은 그룹의 AI1·AI2·번역을 모두 막는다.

## 정한 값(`lib/llm/deadline-ladder.ts`)

이웃 층 사이 최소 2초(`DEADLINE_LADDER_SKEW_MS`). `deadlineLadderViolation()`이 순서를 검사한다.

| 경로 | 엔진 | 중계기 | 게이트웨이 | 클라이언트 |
| --- | --- | --- | --- | --- |
| AI1·AI2(abcLLM) `REVIEW_GATEWAY_LADDER` | 45초 | — | 50초 | 60초(기존값 유지) |
| 제품 번역(M1 relay 포함) `PRODUCT_TRANSLATION_LADDER` | 28초 | 31초 | 34초 | 40초(20초→40초) |

### 근거(기록된 실측 인용 — 이번 세션 측정 아님)

- AI1 `[MLX] gpt-oss-120b`: 50건(동시성≤2, 60초 상한) 중앙값 11.762초·p95 21.571초·최대 23.384초(2026-09-14, `evaluations/2026-09-14-first-review/summary.json`). 24시간 성공 1,183건 평균 12.71초·최대 23.955초(2026-10-15, `2026-10-15-backlog-published-audit.md:47`). 동시성4에서 유효 답 29.742·36.328초(같은 문서 :53).
- AI1 `[supa] Qwen3.8-27B`: 100건 중앙값 3.900초·p95 7.576초(2026-10-14, `2026-10-14-coder-codex-supa-validation.md:87`).
- AI2: Qwen 3.8 27B 14건 중앙값 26.1초·최대 56.2초(2026-09-17, 당시 구성), Qwen 교체 14건 최대 35.767초. fallback qwen3-coder p95 12.61초(2026-10-14).
- 제품 번역: GPT-OSS 8건 중앙값 8.58초·최대 17.49초, Qwen 8건 최대 8.16초(2026-10-23, `2026-10-23-product-translation-throughput.md:11`). M1 지연 실측 없음.
- 토큰/초(decode 속도) 기록 없음.

판단:
- AI 엔진 45초는 기록된 유효 응답 최대(36.3초, 동시성4)를 덮는다. 2026-09-17 구성의 AI2 56.2초는 넘으므로, 그런 호출은 게이트웨이가 끊는 **확정 실패(재시도)** 가 된다. 확정 실패는 미확인과 달리 자리를 막지 않는다.
- 클라이언트 60초는 legacy·item·AI2 틱 예산(origin/main #706의 108초 회차)과 맞물려 그대로 둔다.
- 번역 클라이언트 40초는 origin/main(#708)의 product-translate 예산 55초 안에서 기록 여유 2초와 준비 시간 13초를 남긴다. **이 작업 공간 기준 커밋에는 55초 예산이 없으므로 반드시 origin/main 위에서 병합한다.**

## 무엇을 코드로 바꿨나

1. `lib/llm/deadline-ladder.ts`: 사다리 값·순서 검사·`worstGenerationMs(max_tokens, 최저 decode 속도, 최대 prefill)`.
2. AI 클라이언트 60초를 사다리에서 읽는다(값 불변). 제품 번역 클라이언트 40초.
3. M1 중계기(`scripts/local-model-relay`):
   - `LOCAL_MODEL_RELAY_MAX_OUTPUT_TOKENS`: `max_tokens`(또는 `max_completion_tokens`)가 없거나 상한을 넘으면 엔진에 보내지 않고 400 `output_bound_required`. 생성 길이로 실행시간을 묶는다.
   - `LOCAL_MODEL_RELAY_UPSTREAM_TIMEOUT_MS`(≤90초)와 `LOCAL_MODEL_RELAY_ENGINE_DEADLINE_MS`: 엔진 상한+2초 ≥ 중계기 기한이면 시작을 거부(`relay_deadline_order_invalid`).
   - **90초 뒤 전부 거절 상태 해소:** 엔진 상한이 선언된 경우에만, 미확인 receipt의 `startedAt + 엔진 상한 + 2초`가 지나면 `<id>.deadline-release.json`을 남기고 active 표식만 지워 다시 받는다. 원래 receipt는 바이트 그대로 둔다. 재시작 때도 같은 판정. 선언이 없으면 기존처럼 운영자 경계 해제 전까지 거절한다(TTL 해제 아님).
   - 이미 중계기가 스스로 열린 요청을 나중에 DB 경계 해제(`--relay-state-dir`)로 처리해도 `already_cleared`로 끝난다.

## 이 저장소 밖이라 하지 못한 것(막힘)

- **abcLLM 게이트웨이**(별도 저장소 `abcLLM`): 요청별 전체 기한(위 표의 게이트웨이 값)을 두고, 기한 초과 시 upstream 연결을 끊어 vLLM이 요청을 abort하게 하며, 요청 ID·시작·끊은 시각·upstream 상태를 종료 기록으로 남겨야 한다. Qwen 400/422 재시도로 두 번 보내는 경로도 기한 안에 묶어야 한다. 이 세션은 작업 공간 밖 파일 접근이 거부돼 손대지 못했다.
- **모델 서버 상한**: vLLM(Supa)·MLX(M3)·oMLX(M1)의 서버 측 요청 최대 실행시간 설정. 호스트 설정이며 이 저장소에 없다.
- **실측**: 운영 DB의 최근 p95/p99, vLLM 0.30.0의 disconnect abort 실제 동작, 엔진별 최저 decode 속도.

## 자동 해제 선언(4단계와 연결)

`MODEL_CAPACITY_AUTO_RECLAIM`(maintenance 워커 env, JSON 배열)에 **위 실측과 강제를 확인한 budget만** 적는다.

```json
[{"providerBudgetId":"<policy의 providerBudgetId>",
  "ladder":{"engineMs":45000,"relayMs":null,"gatewayMs":50000,"clientMs":60000},
  "generation":{"maxOutputTokens":3000,"minDecodeTokensPerSec":<실측 최저>,"maxPrefillMs":<실측 최대>},
  "reference":"<실측·강제 확인 문서 경로나 감사 번호>"}]
```

검증: 순서 위반, `worstGenerationMs > engineMs`, 중복, 형식 오류가 하나라도 있으면 **전체를 쓰지 않는다**. 통과하면 `provider_bound`, `hardDeadlineMs = max(엔진, 중계기, 게이트웨이)`, skew 10초 정책이 된다. 해제 시각은 기존 판정 그대로 `로컬 종료 기록 + hardDeadlineMs + 10초`다. AI 경로는 대략 dispatch 후 60+50+10 = 120초로 5분 안이다.

## 배포 전 측정 절차(재현 가능하게)

1. 최근 7일 실제 호출 지연(primary READ ONLY):
   ```sql
   SELECT r.route_id, r.provider_budget_id, count(*) n,
     percentile_cont(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM (s.created_at - r.dispatched_at))) p50,
     percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (s.created_at - r.dispatched_at))) p95,
     percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (s.created_at - r.dispatched_at))) p99,
     max(extract(epoch FROM (s.created_at - r.dispatched_at))) max_s
   FROM model_capacity_requests r JOIN model_capacity_events s ON s.request_id = r.request_id AND s.kind = 'dispatch_settled'
   WHERE r.dispatched_at > now() - interval '7 days' GROUP BY 1, 2 ORDER BY 1;
   ```
   같은 기간 `dispatch_indeterminate` 건수도 경로별로 센다.
2. 엔진별 최저 decode 속도·최대 prefill: 실제 응답의 usage(completion_tokens)와 지연에서 하위 1% 속도를 쓴다. 추정 usage(게이트웨이가 글자 수로 만든 값)는 쓰지 않는다.
3. 게이트웨이 기한 강제 드릴: 기한보다 긴 생성(큰 `max_tokens`)을 한 번 보내 게이트웨이가 끊고, vLLM `/metrics`의 running 요청이 0으로 돌아오는지, 종료 기록이 남는지 확인한다.
4. 1~3을 문서로 남기고 그 경로를 `reference`에 적은 뒤 `MODEL_CAPACITY_AUTO_RECLAIM`을 선언한다.

## 2026-10-28 23:14 UTC primary DB 재측정 (이전 제안값보다 우선)

원본: `review-stall-measurement-before.json`. 명령: `scripts/ops/measure-review-stall.mjs`를 M3의 기존 text 컨테이너에서 `node --input-type=module` stdin으로 실행. `BEGIN READ ONLY`, statement_timeout 25초. `pg_is_in_recovery=false`, 최근7일의 `dispatch_settled.created_at - requests.dispatched_at`를 초 단위로 계산했다. 성공/정산된 호출의 장부 지연이며 timeout으로 끝나지 않은 표본·순수 decode 속도는 아니다.

| 경로·모델 | n | p95(초) | p99(초) | 최대(초) |
| --- | ---: | ---: | ---: | ---: |
| AI1 GPT-OSS | 5807 | 7.644500 | 10.320340 | 17.982 |
| AI1 Supa Qwen | 1458 | 6.242650 | 7.764920 | 20.093 |
| AI2 Supa Qwen | 1552 | 6.145950 | 7.967630 | 42.991 |
| AI2 gpu3090 Qwen | 3985 | 3.781000 | 5.254440 | 6.487 |
| 제품 번역 GPT-OSS | 774 | 7.382000 | 9.390320 | 14.387 |
| 제품 번역 M1 | 0 | 측정 없음 | 측정 없음 | 미확인1건 |

선택:
- AI 경로의 **검증 대상 값**을 엔진50초 < gateway55초 < client60초로 갱신한다. p99가 약10.32초 이하였어도 AI2 최대42.991초를 보존하도록 엔진에 약7초 여유를 둔다. client60초는 기존 워커 예산을 보존한다. 코드 `REVIEW_GATEWAY_LADDER` 반영. gateway/엔진에서 실제 강제했다는 뜻은 아니다.
- M1은 성공 표본이 없어 안쪽 값을 확정하지 않는다. 예전28/31/34초 사다리를 코드의 확정 상수로 내보내지 않는다. 번역 **바깥 HTTP 기한만40초**로 두어 #708의 job55초 안에 준비·기록15초를 남긴다. M1 표본 확보·서버 상한 강제 전까지 내부 사다리/자동 해제 선언은 막힘.
- `max_tokens`는 생성 길이를 제한하며, 측정한 decode 속도만으로 벽시계 실행 상한을 증명하지 않는다. 서버의 강제 종료 상한과 gateway disconnect→vLLM abort 실측이 따로 필요하다.

추가 안전 조건: `LOCAL_MODEL_RELAY_ENGINE_DEADLINE_MS`를 쓰려면 `LOCAL_MODEL_RELAY_ENGINE_BOUND_EFFECTIVE_AT`(실제 엔진 상한이 보장되기 시작한 UTC 시각)을 함께 적어야 한다. 이 시각보다 먼저 전송된 미확인 receipt는 새 상한으로 자동 해제하지 않는다. 재시작·기한 경과·기존 archive 불일치도 이를 우회하지 않는다. 현재 운영의 기존 미확인3건을 새 선언으로 자동 소급 해제하지 않는다.

배포/강제 막힘: 지정 scratch 디렉터리 생성이 `Read-only file system`으로 거절되었고 별도 abcLLM/engine 작업용 checkout과 private 배포 영수증을 그 밖 경로로 우회 생성하지 않았다. 이 저장소 코드의 회귀 시험은 서버 종료·vLLM abort 운영 증명이 아니다.
