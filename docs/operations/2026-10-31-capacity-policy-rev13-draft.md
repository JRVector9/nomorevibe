# 용량 정책 rev13 초안 — abcLLM 이름 경로 제거·M3 장비 나누기

상태: **초안 · 운영 적용 안 함.** 작성 2026-10-31 UTC.
정책 파일: [`2026-10-31-capacity-policy-rev13-draft.json`](2026-10-31-capacity-policy-rev13-draft.json).
이 문서와 파일은 정책 명령·장비 저장·DRAIN·OPEN을 하지 않는다. 적용은 운영자가 아래 순서대로 한다.

## 무엇을 바꾸나 (소유자 지시)

2026-10-30 소유자가 abcLLM 게이트웨이를 없애고 모든 엔진을 주소로 직접 연결하라고 했다. 연결은 관리 화면의 직접 연결 계약(`transport direct`)이 맡는다.
rev13 은 그에 맞춰 정책을 다음처럼 정리한다.

1. 게이트웨이 이름표가 붙은 모델(`[MLX] …`·`[supa] …`·`[m1] …`)의 경로를 모두 지우고, 같은 경로를 엔진이 받는 모델 이름으로 다시 적는다. abcllm-api 주소는 어디에도 넣지 않는다.
2. `compatiblePredecessor` 를 넣지 않는다. 경로를 지우고 바꾸므로 "옛 경로 그대로 + 추가만" 인 호환 개정이 될 수 없다. DRAIN 이 필요하다.
3. Supa 모델 이름을 `Inferact/Qwen3.8-27B-NVFP4` 로 되돌린다. rev12 의 임시 이름 `supa`(장비·예산 `supa-direct`)는 쓰지 않는다.
4. 옛 장비 `m3-mlx` 를 `m3-deepseek`(DeepSeek 직접 경로)와 `m3-gptoss`(gpt-oss-120b 문자 경로)로 나눈다.
5. 한도 칸(`globalLimit`·`providerLimits`·`groupLimits`·`poolLimits`·`weights`)을 넣지 않는다. 한도는 장비 행(0153, `/admin/models/devices`)에 둔다.

검증: `parseModelCapacityPolicy` 통과, 경로 26개·장비 7개,
`modelCapacityPolicyHash` = **`3f35e8c35223da2702840b0493162c55cba9be046c6207cffc4040c4c31efb29`**.

## 근거와 한계

rev12 저장본(`model_capacity_control.policy`)은 저장소에 없다. 이 초안은 아래 근거로 rev12 를 다시 그려 만들었다.
그래서 **적용 전에 rev12 저장본과 경로를 하나씩 맞춰 봐야 한다**(확인 필요 1).

| 근거 | 알려 주는 것 |
| --- | --- |
| `docs/operations/review-stall-measurement-before.json` (운영 장부, 2026-10-28 23:14Z) | 실제로 쓰인 경로·모델·예산. 예: `crawl-agent-review` `[MLX] gpt-oss-120b`/`abcllm-m3-mlx`, `local-human-deepseek` 예산 `m3-deepseek`, CLI 예산 `claude-cli`·`codex-cli` |
| `CODEX_HANDOFF.md:1092` | `local-human-deepseek` 의 실제 행이 예산 `m3-deepseek`·장비 `m3-mlx` |
| 커밋 367c6de2(0150)·`lib/llm/replaced-path-boundary-contract.ts:31-39` | rev12(2026-10-30)는 Supa 직접 경로를 예산·장비 `supa-direct` 에 두었다 |
| `model-serving-contracts-admin.md:74-97` | 직접 연결 모델 이름: Supa `Inferact/Qwen3.8-27B-NVFP4`(장비 `supa`, 예산 `abcllm-supa`), M1 `mlx-community--gemma-4-26b-a4b-it-4bit`(장비 `m1-qwen`), M3 mlx-serve `:8014` `gpt-oss-120b` |
| `2026-10-15-pipeline-pr01b-provider-audit.md:98` | M3 `:8014` 의 모델 id 가 `gpt-oss-120b` |
| `model-capacity-devices-admin.md:90-92`, `model-capacity-devices.md:87`(Q6) | 소유자가 적어 둔 rev13 장비 값 |
| `2026-10-23-local-model-capacity-validation.md:9-18` | 직접 로컬 고정 경로 8개 이름 |
| `2026-10-24-publication-classify-capacity.md:47-48` | 분류 CLI 경로: 우선 `codex-cli gpt-5.6-terra`, 예비 `claude-cli sonnet` |
| 2026-10-31 배포 창 기록(대표 작업 기억, 저장소 문서 아님) | 0153 seed 가 만든 장비 행 7개: `anthropic-cli` 2, `gpu3090-qwen` 4, `m1-qwen` 4, `m3-mlx` 1, `openai-cli` 2, `supa` 4, `supa-direct` 4(모두 상한 = 칸 수, 순위 없음) |

## 정책 문서 모양

- `version`·`maxWaiting`·`queueTtlMs`·`reservationTtlMs`·`routes` 만 있다(시험 `tests/capacity-policy-optional-limits.test.ts:45` 이 "new rev13 shape" 라고 부르는 모양).
- `groupLimits` 를 빼면 정책 대체(`policy_fallback`)가 없다. 그래서 정책의 장비 7개 모두 **장비 행이 있어야** 한다. 없으면 그 장비의 경로는 `device_unconfigured` 로 보류되고
  `capacity mode --to=open` 이 `device_unconfigured:<장비>` 로 거절한다(runbook §6 6-1 주석, `pipeline-control.ts` OPEN 판정).
- `unknown_capacity_group`·`unknown_provider_budget` 검사는 그 맵이 있을 때만 돈다(`lib/llm/capacity.ts:95-101`). 맵을 빼면 이 검사 때문에 막히는 것은 없다.
  반대로 `groupLimits` 를 안전망으로 넣으려면 경로의 장비 7개 키를 **모두** 넣어야 한다(하나라도 빠지면 정책이 파싱되지 않는다).
- `maxWaiting` 256 · `queueTtlMs` 300000 · `reservationTtlMs` 30000 은 rev12 저장본이 아니라 rev12 모양 시험 값이다(확인 필요 2).

### provider 값 — 직접 연결이어도 문자·1차 경로는 `abcllm`

코드가 문자 7경로와 1차(게이트웨이식) 경로에서 provider `abcllm` 만 받는다. 직접 연결 여부는 정책의 provider 가 아니라 계약의 `transport: direct` 가 정한다.
줄 번호는 HEAD 703f2b59 기준이다.

- dispatch binding 이 `provider: z.literal("abcllm")` 이다: 1차(`ai1_item_gateway`), `product-search-profile`, `reason-translate`, `product-translate`, `product-tagline-ko`, `crawl-tagline`, `product-search-verify`, `search-query-translate`(`lib/llm/capacity.ts`). 2차 `second-review` 만 `abcllm`·`local-direct` 둘 다 받는다.
- 정책 조회가 `route.provider === "abcllm"` 이다: `lib/domain/products/translations.ts:296`, `search-profiles.ts:390·508`, `korean-taglines.ts:452`, `search-query-model-capacity.ts:38`, `crawl/tagline-model-capacity.ts:37`, `llm/text-capacity-admission.ts:18`.
- 「엔진 연결」(`lib/operations/admin-engine-connect.ts:68·152`)도 provider `abcllm` 계약을 만들고 정책에 `경로 / abcllm / 엔진 모델명` 이 있는지 본다.
- `local-direct` 는 `LOCAL_MODEL_SERVING_CONTRACTS`(직접 로컬 경로)와 `AI2_DIRECT_SERVING_CONTRACTS`(2차 GPU) 계약 몫이다. 이 경로는 `providerBudgetId` = 계약 `backendId`, `groupId` = 계약 `physicalGroup` 이어야 열린다(`lib/llm/local-model-capacity.ts:51-57`, `pipeline-control.ts:187-191`).

### 예산 이름(`providerBudgetId`)

한도가 아니라 식별자다(DR seal 범위, 자동 회수 선언 키, replaced-path 위상 키, 관측 표시).

- Supa `abcllm-supa`: 직접 연결 문서(`model-serving-contracts-admin.md:95`)가 적은 값. rev12 직접 경로는 `supa-direct` 였다. 두 이름 모두 replaced-path 위상(0145·0150)이 안다.
- M1 `abcllm-m1-qwen`: rev12 값을 그대로 둔다.
- M3 gpt-oss `m3-gptoss`: **새 이름**이다. 옛 `abcllm-m3-mlx` 의 replaced-path 엔진 hop 은 DeepSeek 서비스(`gui/501/com.jr.deepseek`)라 gpt-oss(`:8014`)에 그대로 쓰면 다른 엔진을 보고 해제할 수 있다.
  새 이름은 위상에 없어서 그 도구가 `topology_unregistered` 로 거절한다(안전 쪽). 등록하려면 새 migration 이 필요하다.
- 직접 로컬 `gpu3090-qwen`·`m3-deepseek`: 계약 `backendId` 그대로.

## rev12 → rev13 경로 표

"rev12" 칸은 위 근거로 그린 값이다. 저장본과 다르면 저장본을 따른다.

| 경로 / provider | rev12 모델 · 장비 · 예산 (근거) | rev13 모델 · 장비 · 예산 | 비고 |
| --- | --- | --- | --- |
| `crawl-agent-review` / abcllm | `[supa] Qwen3.8-27B-NVFP4` · supa · abcllm-supa (측정) 과 `supa` · supa-direct · supa-direct (0150 커밋·작업 기억) | `Inferact/Qwen3.8-27B-NVFP4` · **supa** · abcllm-supa | 두 경로를 하나로 |
| `crawl-agent-review` / abcllm | `[MLX] gpt-oss-120b` · m3-mlx · abcllm-m3-mlx (측정) | `gpt-oss-120b` · **m3-gptoss** · m3-gptoss | 확인 필요 4 |
| `product-search-verify` / abcllm | `[supa] Qwen3.8-27B-NVFP4` · supa (측정), 직접 `supa` · supa-direct (추정) | `Inferact/Qwen3.8-27B-NVFP4` · supa · abcllm-supa | |
| `crawl-tagline` / abcllm | `[supa] Qwen3.8-27B-NVFP4` · supa (측정), 직접 `supa` · supa-direct (추정) | `Inferact/Qwen3.8-27B-NVFP4` · supa · abcllm-supa | 확인 필요 7 |
| `second-review` / abcllm | `[supa] Qwen3.8-27B-NVFP4` · supa · abcllm-supa (측정, 2차 Supa 대체) | `Inferact/Qwen3.8-27B-NVFP4` · supa · abcllm-supa | 확인 필요 5 |
| `product-search-profile` / abcllm | `[MLX] gpt-oss-120b` · m3-mlx · abcllm-m3-mlx (측정) | `gpt-oss-120b` · **m3-gptoss** · m3-gptoss | |
| `product-tagline-ko` / abcllm | `[MLX] gpt-oss-120b` · m3-mlx · abcllm-m3-mlx (측정) | `gpt-oss-120b` · m3-gptoss · m3-gptoss | |
| `search-query-translate` / abcllm | `[MLX] gpt-oss-120b` · m3-mlx (등록부 `mlx:text` 용도, 측정 창에는 호출 없음) | `gpt-oss-120b` · m3-gptoss · m3-gptoss | |
| `product-translate` / abcllm | `[m1] mlx-community--gemma-4-26b-a4b-it-4bit` · m1-qwen · abcllm-m1-qwen (`model-config-registry.md:64`); 10-28 측정에는 `[MLX] gpt-oss-120b` | `mlx-community--gemma-4-26b-a4b-it-4bit` · m1-qwen · abcllm-m1-qwen | |
| `reason-translate` / abcllm | `[MLX] gpt-oss-120b` · m3-mlx (측정) 또는 `[m1] …gemma…` · m1-qwen | `mlx-community--gemma-4-26b-a4b-it-4bit` · m1-qwen · abcllm-m1-qwen | 확인 필요 6 |
| `local-human-deepseek` / local-direct | `deepseek-v4.1-flash-1017` · m3-mlx · m3-deepseek (handoff:1092) | 같은 모델 · **m3-deepseek** · m3-deepseek | 정책 밖 env 변경 필요(아래) |
| `local-deepseek-confirm` / local-direct | 같은 모델 · m3-mlx · m3-deepseek (추정) | 같은 모델 · **m3-deepseek** · m3-deepseek | 위와 같음 |
| `second-review` / local-direct | `qwen3.8-flash-next` · gpu3090-qwen · gpu3090-qwen (측정) | 그대로 | |
| `local-screen`·`local-held-qwen`·`local-qwen-tiebreak`·`local-published-filter` / local-direct | `qwen3.8-flash-next` · gpu3090-qwen · gpu3090-qwen (측정) | 그대로 | |
| `local-assist-{uptime,repo_move,intro_recheck,news}-gpu3090-qwen` / local-direct | 같음 (측정) | 그대로 | |
| `local-audit` / local-direct | 같음 (소유자 순위 목록; 측정 창에는 호출 없음) | 그대로 | |
| `local-second-opinion` / local-direct | 같음 (2026-10-23 고정 경로; 측정 창에는 호출 없음) | 그대로 | 확인 필요 1 |
| `product-intro-check` / claude-cli / `sonnet` | 예산 claude-cli (측정), 장비 anthropic-cli (seed) | 그대로 | 확인 필요 3 |
| `crawl-publish-classify` / codex-cli / `gpt-5.6-terra` | 예산 codex-cli (측정), 장비 openai-cli (seed) | 그대로 | 확인 필요 3 |
| `crawl-publish-classify` / claude-cli / `sonnet` | 분류 예비(2026-10-24 문서) | 예산 claude-cli · 장비 anthropic-cli | 확인 필요 3 |

대신하는 경로 없이 빠지는 것:

- rev12 에 남아 있다면 `[m1] qwen3.8-flash-next`(옛 M1 이름), `[MLX] qwen3.6-35b-heretic`(옛 수집 소개·2차 모델), 그 밖의 `[…]` 이름 경로 전부.
- Supa 임시 이름 `supa` 의 경로 전부(`supa-direct`). 장비 `m3-mlx`·`supa-direct` 를 쓰는 경로는 하나도 남지 않는다.

## 장비 값 (관리자 `/admin/models/devices`, 0153 행)

정책이 아니라 장비 행에 저장한다. 값은 `model-capacity-devices-admin.md:90-92` 를 그대로 옮겼다. 그 줄 자체가 "소유자 확인 필요(pr1-plan §4.3)" 로 적혀 있다(확인 필요 15).
공통: 유휴 판정 60초, 비워 둘 칸 0, 엔진 실제 동시 처리 수 없음(문서에 값이 없어 기본값).

| 장비 | 칸 수 | 낮은 순위 상한 | 역할 순위 | 순위 없는 정책 경로(32767) | 출처 | 지금 행(0153 seed) |
| --- | --- | --- | --- | --- | --- | --- |
| `supa` | 4 | 1 | crawl-agent-review 1, product-search-verify 2, crawl-tagline 3 | second-review(abcllm) | admin:90 | 4 / 4 |
| `gpu3090-qwen` | 4 | 2 | second-review 1, local-screen 2, local-held-qwen 3, local-audit 4 | local-second-opinion, local-published-filter, local-qwen-tiebreak, local-assist 4개 | admin:90-91 | 4 / 4 |
| `m3-deepseek` | 1 | 0 | local-human-deepseek 1, local-deepseek-confirm 2 | 없음 | admin:91 | **없음 — 새 행** |
| `m3-gptoss` | 2 | 2 | 없음 | product-search-profile, product-tagline-ko, search-query-translate, crawl-agent-review | admin:91 | **없음 — 새 행** |
| `m1-qwen` | 2 | 1 | product-translate 1, reason-translate 2 | 없음 | admin:92 | 4 / 4 → 2 로 내림 |
| `anthropic-cli` | 2 | 적지 않음 → 기본 2 | 없음 | product-intro-check, crawl-publish-classify(claude) | admin:92 | 2 / 2 |
| `openai-cli` | 2 | 적지 않음 → 기본 2 | 없음 | crawl-publish-classify(codex) | admin:92 | 2 / 2 |

- 같은 장비에서 순위를 적지 않은 경로는 최하위(32767)라 낮은 순위 상한에 묶인다. 예: `m3-deepseek` 은 상한 0 이라 순위 2 인 확인 경로는 사람 검토 경로가 쉬는 동안만 빌려 쓴다.
- seed 행 `m3-mlx`(1)·`supa-direct`(4)는 PR 1 에 지우는 동작이 없어 그대로 남는다. rev13 경로는 쓰지 않는다. rev12 로 되돌릴 때 그대로 쓰인다.
- 소유자 값은 장비 schema(`parseModelCapacityDeviceSettings`)를 통과하고, 순위를 준 경로는 모두 그 장비의 rev13 경로다(아래 검증).

## 확인 필요

1. **rev12 저장본 대조.** 이 초안은 저장본을 보지 않고 그렸다. 저장본에 있는데 여기 없는 경로(게이트웨이 이름 경로 제외)는 장비 이름만 `m3-mlx`→`m3-deepseek`/`m3-gptoss`, `supa-direct`→`supa` 로 바꿔 옮긴다.
   특히 `local-direct` 경로는 OPEN dry-run 의 경로 표(`usedModelRoutes`)에 나오지 않는다. 빠지면 OPEN 뒤 조용히 `provider_contract_unavailable` 로 미뤄진다.
   `local-second-opinion` 은 저장본에 없을 수도 있다(호출 지점은 있다).
2. **`maxWaiting`·`queueTtlMs`·`reservationTtlMs`.** 시험의 rev12 모양 값(256·300000·30000)이다. 저장본 값을 그대로 옮긴다. 다르게 하면 그것도 정책 변경이다.
3. **CLI 경로의 장비·예산.** 예산 `claude-cli`·`codex-cli` 는 10-28 장부, 장비 `anthropic-cli`·`openai-cli` 는 0153 seed 기록(저장소 밖)과 소유자 목록에서 왔다. 저장본과 다르면 저장본을 따른다.
   `product-audit`·`grok-session-check`·1차/2차 CLI 경로는 근거가 없어 넣지 않았다. 저장본에 있으면 옮긴다.
4. **1차 gpt-oss 경로.** 10-28 에는 1차가 gpt-oss 와 Supa 를 나눠 썼다. 지금 1차 풀에 gpt-oss 가 없으면 이 경로는 `unused` 로만 보인다(해는 없다).
5. **2차 Supa 대체(`second-review` / abcllm / Inferact).** 「엔진 연결」은 `second-review` 를 다루지 않는다(`ENGINE_CONNECT_ROUTES`). 이 경로의 직접 계약은 「계약 추가·수정」으로 따로 저장해야 한다.
   2차 대체 설정의 모델 이름도 새 이름이어야 한다(binding 이 `reviewer.model === model` 을 요구한다). `supa` 장비에서 순위를 줄지(지금은 순위 없음)도 소유자가 정한다.
6. **사유 번역(`reason-translate`)이 M1 인가.** 소유자 목록과 등록부 기본값(`m1:translation` 용도)은 M1 이다. 10-28 장부에는 gpt-oss 였다.
   소비자가 실제로 부르는 이름(단계 선택, 없으면 `ABCLLM_MODEL` env)이 gemma 이름이 아니면 `unmapped` 다. 문자 경로라 OPEN dry-run 에 보인다.
7. **수집 소개(`crawl-tagline`).** 소유자 목록·직접 연결 문서·10-28 장부 모두 Supa 다. 코드 기본값(`mlx:tagline`)은 아직 `[MLX] qwen3.6-35b-heretic` 이다.
   이 모델은 M3 직접 주소 목록에 없다. 단계 선택(`supa:review`)이 없으면 기본값을 불러 `unmapped` 가 된다. heretic 경로는 넣지 않았다.
8. **gpt-oss 엔진이 `:8014` 인가.** 직접 연결 문서는 M3 mlx-serve `:8014` 의 `gpt-oss-120b` 를 적는다. M3 oMLX `:8010` 도 `gpt-oss-120b` 를 낸다(대표 작업 기억).
   계약이 `:8010` 을 가리키면 DeepSeek 과 같은 엔진이라 장비를 나눈 뜻이 없다.
9. **예산 이름.** Supa 를 `abcllm-supa`(문서)로 할지 rev12 의 `supa-direct` 로 할지, `abcllm-` 접두를 지금 정리할지. 한도에는 영향이 없다. replaced-path 위상은 `abcllm-supa`·`supa-direct`·`abcllm-m1-qwen` 만 안다.
10. **`groupLimits` 생략.** `model-capacity-devices.md:87`(Q1)은 "rev14 가 groupLimits 를 버린 뒤 대체 제거" 라고 적어, rev13 이 대체값을 가질 수도 있음을 시사한다.
    시험(`capacity-policy-optional-limits.test.ts:45`)과 runbook(§6 6-1)은 생략을 허용한다. 초안은 생략했다. 안전망이 필요하면 장비 7개 키를 모두 넣는다.
11. **M1 칸 수 2.** `2026-10-23-local-model-capacity-validation.md:24` 는 "M1 을 쓰는 모든 route 의 group 한도는 1 로 유지" 라고 적었다. LLM 보강 준비 판정도 M1 물리 상한 1 을 요구한다(`llm-assist-readiness.ts`, M1 직접 로컬 경로 한정).
    지금 M1 은 `mlx_lm.server` 다. 2 가 안전한지 소유자가 확인한다.
12. **LLM 보강 감사 경로.** `local-assist-decision_audit-m3-deepseek`·`local-assist-semantic_exception-m3-deepseek` 는 근거가 없어 넣지 않았다. 저장본에 `m3-mlx` 로 있으면 `m3-deepseek` 로 옮긴다.
13. **`anthropic-cli`·`openai-cli` 의 낮은 순위 상한.** 소유자 목록에 칸 수만 있다. 기본(= 칸 수)으로 둔다.
14. **Supa 응답 모델 이름.** Supa vLLM 은 등록 이름 중 첫째로 답하고, 10-30 재시작에서 순서가 바뀌었다. 계약의 응답 모델은 「엔진 연결」의 1토큰 시험으로 다시 읽는다.
15. **장비 값 자체.** `model-capacity-devices-admin.md:90` 이 "소유자 확인 필요" 로 적은 값을 옮겼다.

## 정책 밖에서 OPEN 전에 맞출 것

정책만 바꾸면 경로가 `serving` 이 되지 않는다. 아래는 이 초안의 범위 밖이지만 OPEN 전에 필요하다.

- **직접 계약.** abcllm 경로마다 새 모델 이름의 직접 계약이 있어야 한다. 없으면 `no_contract` 다.
  - Supa: 「엔진 연결」, 엔진 모델 `Inferact/Qwen3.8-27B-NVFP4`, 경로 crawl-agent-review·product-search-verify·crawl-tagline, 단계 지정 켬. 등록부 덮어쓰기와 1차 설정의 옛 이름(`supa`)이 새 이름으로 바뀐다.
  - 2차 Supa 대체: 「계약 추가·수정」(확인 필요 5).
  - M3 gpt-oss: `:8014`, 경로 product-search-profile·product-tagline-ko·search-query-translate(1차에 쓰면 crawl-agent-review 도). 상한은 운영자 입력 131072.
  - M1: product-translate·reason-translate.
- **DeepSeek 직접 로컬 계약의 그룹.** `local-human-deepseek`·`local-deepseek-confirm` 는 정책 `groupId` 가 계약 `physicalGroup` 과 같아야 열린다.
  지금 계약은 `m3-mlx` 로 보인다(handoff:1092 의 실제 행). 그래서 다음 env 를 함께 바꿔 DeepSeek 을 부르는 앱에 다시 배포해야 한다.
  - `LOCAL_MODEL_SERVING_CONTRACTS` 의 `physicalGroup` 을 `m3-deepseek` 로.
  - `LOCAL_MODEL_PHYSICAL_LIMITS` 의 키를 `m3-deepseek` 로.
  - `LOCAL_MODEL_VERIFIED_CONTRACT_HASHES` 를 다시 계산한다. 계약 hash 가 `physicalGroup` 을 포함한다.
  - 안 하면 OPEN 뒤 두 경로가 `provider_contract_unavailable` 로 미뤄진다. OPEN dry-run 에는 보이지 않는다.
- **부르는 이름.** 각 잡이 정책과 똑같은 이름을 불러야 한다(단계 선택 → env → 등록부 기본값 순). 코드 기본값은 아직 이름표(`gatewayLabel`)가 있어 `[MLX] gpt-oss-120b`·`[supa] Qwen3.8-27B-NVFP4`·`[m1] …` 를 만든다.
  관리 화면 덮어쓰기나 단계 선택이 없는 잡은 rev13 에서 `unmapped` 다.
- **옛 세대 행.** rev12 세대의 reserved·dispatched 행이 끝날 때까지 새 입장은 `policy_changed` 로 미뤄진다. 그동안 `m3-mlx`·`supa-direct` 의 잡힌 행과 새 장비 칸이 겹쳐 엔진을 넘기는 일은 없다.

## 적용 순서 (운영자가 한다 · 이 PR 은 하지 않는다)

0. 위 확인 필요를 정리하고 JSON 을 고친다. 고쳤으면 아래 명령으로 hash 를 다시 계산해 이 문서를 고친다.
1. **DRAIN** — `capacity mode --to=draining --from-mode=open --expect-epoch=<CE> --expect-revision=<R> …` dry-run, 그 뒤 `--execute`. `<CE>`·`<R>` 은 `status` 에서 읽는다(R 은 12 로 알려져 있다).
2. **정책** — `capacity policy --file=docs/operations/2026-10-31-capacity-policy-rev13-draft.json --from-mode=draining --expect-epoch=<CE> --expect-revision=<R> …` dry-run.
   출력의 새 hash 가 위 값과 같은지 본다. `old_generation_held:<n>` 와 아직 행이 없는 장비의 `device_row_missing:<장비>` 경고를 확인한 뒤 `--execute`(revision R → R+1).
3. **장비 행** — `/admin/models/devices` 에서 위 표대로 저장한다. 새 행은 `m3-deepseek`·`m3-gptoss`, 값을 바꾸는 행은 `supa`·`gpu3090-qwen`·`m1-qwen` 이다.
   새 장비 행은 2 보다 먼저 만들어도 된다(`model-capacity-devices-admin.md:45-46`, runbook 6-7 권장; 그러면 `device_row_missing` 경고가 없다).
   기존 행의 값은 저장 즉시 다음 입장부터 쓰이므로 DRAIN 중에 저장하면 rev12 운영에 영향이 없다.
4. **OPEN dry-run** — `capacity mode --to=open --from-mode=draining --expect-epoch=<CE> --expect-revision=<R+1> …`.
   `device_unconfigured:<장비>` 가 없어야 한다. `[capacity routes]` 에서 쓰는 경로가 모두 `serving` 인지 본다(전부터 있던 `product-intro-check/claude-cli/sonnet no_contract` 는 전례대로 판단).
5. **OPEN** — 같은 명령에 `--execute`. 뒤에 `status` 의 `[devices]`·`[capacity routes]` 와 장부로 확인한다.

되돌리기: DRAIN → rev12 정책 파일로 `capacity policy`(revision 하나 더) → OPEN. 장비 행 `m3-mlx`·`supa-direct` 는 남아 있으므로 rev12 장비 그대로 돈다.

## 검증 (2026-10-31, 이 작업)

- `lib/llm/capacity.ts` 는 HEAD(703f2b59) 그대로(blob `ae0896c4`)인 상태에서 검사했다.
- 저장소 checkout(의존성 설치됨)의 루트에서 hash 만 다시 낼 때:

  ```sh
  npx tsx -e 'import { readFileSync } from "node:fs"; import { modelCapacityPolicyHash, parseModelCapacityPolicy } from "@/lib/llm/capacity"; console.log(modelCapacityPolicyHash(parseModelCapacityPolicy(JSON.parse(readFileSync("docs/operations/2026-10-31-capacity-policy-rev13-draft.json", "utf8")))));'
  ```

  출력 `3f35e8c35223da2702840b0493162c55cba9be046c6207cffc4040c4c31efb29`.
- 이 worktree 에는 `node_modules` 가 없다. 그래서 작업 밖 임시 디렉터리에 저장소 파일 symlink 와 같은 lockfile 의 `node_modules` 를 두고 `--preserve-symlinks` 로 실행했다. 일회용 스크립트이고 저장소에 넣지 않았다. 확인한 것:
  - 파싱 결과가 입력과 같다. `compatiblePredecessor`·한도 칸이 없다.
  - `[…]` 이름표 모델, `supa` 임시 이름, 장비 `m3-mlx`·`supa-direct` 가 없다.
  - 문자 7경로는 provider `abcllm`, `local-*` 경로는 `local-direct`, 직접 로컬 경로의 예산은 계약 `backendId`(gpu3090-qwen·m3-deepseek)다.
  - 소유자 장비 값 7개가 `parseModelCapacityDeviceSettings` 를 통과하고, 순위를 준 경로가 모두 그 장비의 경로다.
  - 정책의 장비 집합이 소유자 목록의 7개와 같다.
  - 결과 `routes=26 devices=7`, 위 hash, `OK`(종료 0).
- 하지 않은 것: 운영 DB 의 `pipeline-control capacity policy` dry-run(저장본 대조 포함), 장비 저장, 계약·env 확인. 단위·통합 시험은 이 문서 작업과 관계가 없어 돌리지 않았다.
