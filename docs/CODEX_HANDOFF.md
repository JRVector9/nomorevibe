# 2026-10-16 최신 인계 — PR07a 구현·회귀 GREEN / 검증 정책 변경

## 최우선 사용자 지시

**앞으로 수동 전체 테스트는 남은 모든 PR 개발이 끝난 뒤 통합 단계에서 실행한다. PR별로는 변경 범위 회귀와 필요한 정적 검사만 한다.** 전체 unit/전체 DB/종합 테스트을 PR마다 반복하지 않는다. 이미 실행한 결과와 실패는 보존한다. GitHub의 필수 병합 CI는 저장소 규칙대로 유지한다. 이 지시는 아래 이전 계획의 PR별 전체 검사 지시보다 우선하며 A/B/C 모두 전달받았다.

전체 PR00–17 병렬 개발 objective는 active다. 최신 사용자 질문은 병렬 진행과 이전 대비 차이에 대한 상태 요청이었고, 검증 정책만 변경했으며 개발 취소가 아니다. root가 오케스트레이터/직접 리뷰/Git 담당이고 모든 서브에이전트는 gpt-6.1-sol/xhigh다.

## 현재 작업과 실제 결과

- WT `/Users/jr/Desktop/projects/nomorevibe-http-settlement`, branch `codex/pipeline-pr07a-http-settlement-20261016`, base `99a9cefcd9c82dcc86441b798332137a3604fe36`. 원본 X branch Git/source는 바꾸지 않고 handoff만 동기화한다.
- PR07a production 변경은 `lib/net/fetch.ts` 하나, 동결 SHA `d69349eb88a6e1262d688879e8497538576594889d25569b4d506aea7ca19fac`. 취소 호출 전에 상태를 고정하고 실제 reader.cancel Promise·진행 중 read가 정산된 뒤에만 process-local origin을 반환한다. abort의 일부 본문을 정상 성공으로 저장하지 않고 원 signal.reason을 보존한다. 취소 실패면 점유 유지, redirect 다음 hop0, prefix/too_large/HTTP 원결과 유지. multi-host/실제 socket 종료/Oracle/2배 증거가 아니다.
- C 원 테스트 `tests/net-fetch-settlement.test.ts` 249행 SHA `7613611d2215277b13ecd3557162226166e306dd5e6988fa1522f8583aef7edf`: 실제 원 source에서 4 Assertion FAIL/3 control PASS.
- B 독립 원 테스트 `tests/net-fetch-settlement-adversarial.test.ts` 220행 SHA `44afb66a1e0731e87626652b643d6272e32c5d5971720e466afa6cbbb559b0a0`: 실제 8 Assertion FAIL/2 control PASS. root가 원 두 driver와 로그를 완독·수용한 뒤 C source 편집을 허용했다. 두 driver는 원 byte 그대로다.
- C 같은 원17 PASS/111ms, 기존 관련4파일48 PASS/427ms, scoped lint exit0. B 독립 같은10 PASS/112ms, 합17 PASS/114ms 및 diff/함수 문맥 교차 리뷰 완료, 추가 P1/P2 0. A/B/C 모두 완료·파일 소유권 root 반환. A도 동결 source를 독립 읽기 리뷰해 추가 P1/P2 0을 반환했다. root도 full diff와 fetch.ts 전체를 읽었다.
- 사용자 정책 변경 전에 root가 실제 실행한 전체 unit **294파일 3,757 PASS/15.83초**, lint exit0(기존 vendor `_ctx` warning1), i18n exit0, next typegen exit0 후 tsc exit0. **이전 C tsc exit2는 미생성 PageProps6개**였으며 source 수정 없이 typegen으로 해소했다.
- root 전체 build **exit1**: 외부 WT node_modules를 가리키는 symlink를 Turbopack filesystem root가 거부했다. 앱 compile PASS가 아니며 종합 build/bundle은 새 사용자 정책에 따라 최종 통합 단계로 남긴다. 설정/의존성 변경 또는 재실행0. 새 DB/원격 HTTP/provider/운영 DDL/배포0.

정확한 원로그: `/tmp/nomorevibe-pr07a-{c-initial-red,b-baseline-red,c-original-17-green,c-existing-related-green,b-frozen10-green,b-combined17-green,root-typegen,root-tsc,root-unit,root-lint,root-i18n,root-build}-20261016.log`. C 보고 `/tmp/nomorevibe-pr07a-c-final-report-20261016.md`, B `/tmp/nomorevibe-pr07a-b-final-review-20261016.md`. 고정 계획 `docs/superpowers/plans/2026-10-16-pipeline-pr07a-http-settlement.md`에 새 검증 정책을 반영했다.

## 실서버 후속 조사·남은 일

A가 exact M3 source와 공식 mlx-lm v0.31.3 `server.py`의 byte/SHA 일치를 확인했다. upstream revision `ed1fca4cef15a824c5f1702c80f70b4cffc8e4dd`, source SHA `cdfcb4ac848636f9927851a0ec7a951584526530cb7832ba58049e4a9144db8b`, MIT. root는 `/tmp/nomorevibe-pr01b6b-upstream-source-pin-a-20261016.md` 전체를 읽었다. 공식 GET3은200이며 tag 원문+revision metadata를 받았고 immutable commit URL GET는 아직0이다. 정확한 Git metadata anchor는 모두 없었다. 실제 운영 source를 고친 것이 아니며 managed pin+좁은 patch를 다음 개발에 쓸 수 있다. 최소 guard는 full tokenize 직후 batch/single의 pre-cache/pre-ctx에서 positive integer resolved M/non-spec/P+M+1≤C를 검사한다. 실제 C·serving 적용·tokenizer canary·native baseline은 미완료다.

PR04c 다음 실제 item TX/journal/최종 authority→mixed coverage/strict seal→비활성 독립 소비자 기능 범위는 `/tmp/nomorevibe-pr04c2-next-functional-scope-b-20261016.md`를 root가 완독했다. 기존 기반을 반복 구현하지 않는다. 다음 PR07b는 공유 DB 장부+고정 undici per-hop adapter+safeFetch/fetchCapped 실제 연결+actual DB/loopback을 함께 검증한다. 현재 PR07a만으로 그 기능이 끝났다고 하지 않는다.

PR07a는 A/B/root 리뷰·실제 operations/진행 장부까지 완료했다. 다음은 정확한 파일 commit/push/PR→필수 CI 후 exact-head 정상 병합이다. 새 검증 정책을 AGENTS.md에도 기록했다. 수동 전체 테스트는 더 실행하지 않는다. PR01 native30분/PR04itemB5/PR05전caller/PR06독립소비·2배/PR07–11 Oracle상시번역·근거·uptime/PR14–17 DR·24h는 남아 있다. Oracle는 정확히 surfguide/ap-osaka-1/osaka-smoke다. Supa SSH 계정 optional질문 pending으로 계정 추정/반복 질문/정책 우회0.

```sh
cd /Users/jr/Desktop/projects/nomorevibe-http-settlement
git status --short --branch
# A 리뷰 반환 확인. 변경/새 finding 없으면 원17/48 또는 전체suite를 다시 돌리지 않는다.
# 필요할 때만 변경 범위 회귀/정적 검사를 실행한다.
git diff --check
# root만 정확한 파일 commit/push/PR. 필수 CI는 유지하고 운영 배포/DDL/새consumer 활성화는 이 단계에서 하지 않는다.
```

이전 phase의 저장소/PR450·abcLLM PR1·실서버·실패/정리 증거는 아래 이력과 `/tmp/nomorevibe-CODEX_HANDOFF-before-pr07a-green-20261016.md`에 보존한다. 아래의 '지금 RED/소스 편집0' 및 완료 담당 상태는 과거 기록으로 위 최신 인계가 우선한다.

---

# 2026-10-16 — PR450 검증 완료 / abcLLM raw 검수 PR1 제출

## 현재 목표와 사용자 요청

파이프라인 PR00–17의 남은 작업을 병렬 개발하는 goal은 active다. 최신 사용자 질문은 병렬 작업 여부와 이전 대비 변화에 대한 상태 요청이며 원래 목표를 취소하지 않았다. 서브에이전트3명과 root로 구현·독립 회귀/교차 리뷰·실서버 읽기 조사를 나눴다. 모두 gpt-6.1-sol/xhigh이며 지금 세 담당은 완료·파일 소유권 반환 상태다. 완료 담당을 재개할 때는 followup_task를 사용한다.

운영은 마지막 직접 확인 릴리스 **8020dca**, legacy/epoch1/contract0이다. 이번 단계에서 운영 배포·운영 DDL·provider 추론·발굴 재개·새 consumer 활성화는 하지 않았다. 신규 모델 슬롯과 item 기반의 main 병합을 운영 적용이나 2배 달성으로 해석하지 않는다. 모델·품질 gate·사람 판단·발굴 pause를 유지한다.

## 저장소와 완료 결과

- 원본 `/Users/jr/Desktop/projects/nomorevibe`: 사용자 X branch `codex/x-osaka-smoke-20261015`, HEAD `b1fb8dd54910cd55d334129f86cf670fdfa1225b`. 원본 Git/push/다른 파일은 변경하지 않는다. 이 handoff만 동기화한다. 기존 untracked 사용자 산출물은 보존한다.
- NoMoreVibe 작업 WT `/Users/jr/Desktop/projects/nomorevibe-pipeline-model-capacity`: branch `codex/pipeline-pr05a-model-capacity-20261016`, HEAD `6da1facc0656dd71467efc354b97fc7ab73497da`. PR450으로 정상 squash 병합했고 main은 **99a9cefcd9c82dcc86441b798332137a3604fe36**다.
- [PR450](https://github.com/JRVector9/nomorevibe/pull/450): 2026-10-15T22:40:46Z 병합. PR CI38817812703와 main CI38818744171의 필수 check·통합3구간·웹/워커 image 모두 SUCCESS를 root가 직접 확인했다. 공통 모델 슬롯은 disabled·기존 caller 연결0이다. 운영 migration0077/0078과 전환은 별도다.
- 원래 `/Users/jr/Desktop/projects/abcLLM`: clean main **fc0f972ac1608ab8a8c822edd5f3d9f4a0f7fdac**, Git/source 변경0.
- 새 gateway WT `/Users/jr/Desktop/projects/abcLLM-review-raw`: branch `codex/review-raw-single-attempt-20261016`, 생산 코드 commit **2b80a2de58cc27f89e82fa5c04a1cb9218a9c7b8**, PR 제출 기록만 정리한 최종 head **1ca85c4f2f8e1590f5c9a167a176433369e01d7e**. commit·feature push·[abcLLM PR1](https://github.com/JRVector9/abcLLM/pull/1) 생성 완료, OPEN/MERGEABLE/CLEAN. 초기 코드 head의 GitGuardian Security Checks SUCCESS를 관측했고 최종 docs head의 GitGuardian Security Checks도 SUCCESS를 직접 확인했다. 별도 backend CI가 있다고 주장하지 않는다. 마지막 두 줄 docs 변경 뒤 source가 같아 이미 통과한 테스트를 반복하지 않았다. PR 원 JSON은 `/tmp/abcllm-review-raw-root-pr1-final-20261016.json`이다. **main 병합·운영 배포는 하지 않았다.** remote main은 fc0f972 그대로이며 WT는 clean이다.

## 이번 gateway PR의 변경 파일과 설계

고정 계획과 실제 기록은 abcLLM WT의 아래 파일을 읽는다.

- `backend/app/routers/ollama_proxy.py`: 유일한 생산 코드 변경. 최종 SHA **3774d44494cde76f7649b9932a97795174218666759ed4bfdb492edf21484566**.
- `backend/tests/test_raw_chat_contract.py`: A 원154행·SHA **b175bca499dafbf234f4ad45ef16357257dc8f9d254e9cdc18efa1892e366c20** 그대로.
- `backend/tests/test_raw_chat_adversarial.py`: B 최종180행·SHA **96594bc76cf88c3cc441e2e7c8f0b1fc07b6405ad4f35f6574c794569d96bd89**. 원164행은 byte prefix 그대로이며 교차 리뷰에서 찾은 두 사례만 추가했다.
- `docs/superpowers/plans/2026-10-16-review-raw-chat.md`.
- `docs/operations/2026-10-16-raw-chat-validation.md`.

기존 raw 경로를 재사용한다. raw 입력은 전역 문자 truncation을 우회하고 MLX/vLLM raw/nonstream은 단일 chat_stream을 사용해 400/422 옵션 제거 재POST를 하지 않는다. 실제 choice terminal과 DONE을 모두 요구한다. 오류·malformed·불완전 EOF·terminal 뒤 새로운 choice는 502다. length 뒤 usage-only/DONE은 계속 읽는다. 유효한 세 upstream counter와 추정치를 usage_provenance로 구분하고 invalid 값을 quota 산술에 쓰지 않는다. non-raw fallback/부분 EOF 호환은 control로 유지했다. 새 endpoint/DB/모델 옵션 전달/설정/계정 quota 변경0.

원 요청의 고정 조건을 유지하며 실제 hidden-inclusive 비용·engine 내부 attempt·원격 취소 완료를 이 PR로 인증하지 않는다. 현재 NoMoreVibe의 system+user 2메시지가 잘렸다는 주장도 하지 않는다. truncation RED는 4메시지로 재현했다. raw 400/422는 이제 실패하므로 운영 전 정확한 모델 옵션 호환 canary가 필요하다.

## 실제 검증과 리뷰

- 기존 source에서 A는 5 Assertion FAIL/4 control PASS, B는 10 Assertion FAIL/3 control PASS를 실제 재현했다. root가 원 두 driver 전체와 원 로그를 직접 읽은 뒤 구현을 허용했다. import/setup 오류를 RED로 세지 않았다.
- 첫 구현에서 원22 PASS, 전체151 PASS. root도 전체151 PASS/1.77초를 직접 실행했다.
- 교차 리뷰에서 terminal 뒤 추가 content/상충 terminal을 성공 처리하는 P2를 찾았다. B가 원22를 유지하고 두 사례만 추가해 실제 2 Assertion FAIL/22 PASS/0.15초를 재현했다. root 확인 후 A가 raw 한 조건 두 줄로 고쳤다.
- 최종 A 같은24 PASS/0.12초, 전체153 PASS/1.68초. **root 직접 전체153 PASS/1.69초**, source+두 test py_compile exit0, git diff --check exit0. 기존 deprecation 경고2개. Python lint 설정은 발견되지 않아 lint PASS를 주장하지 않는다.
- root 전체 diff/helper/호출 문맥·원 회귀·실제 로그 직접 리뷰 및 B 최종 교차 리뷰 완료, 미해결 P1/P2 0. B의 최종24는 A 원 로그 확인이며 B가 직접 재실행한 것으로 주장하지 않는다.

로그: `/tmp/abcllm-review-raw-{a,b}-baseline-red-20261016.log`, `-b-postterminal-red-20261016.log`, `-a-postterminal-focused-green-20261016.log`, `-a-postterminal-suite-green-20261016.log`, `-root-postterminal-suite-green-20261016.log`. B 리뷰 `/tmp/abcllm-review-raw-b-cross-review-20261016.md`.

PR450의 root unit3740/관련 DB44·정적/build 및 실제 CI 결과는 `docs/operations/2026-10-16-pipeline-pr05a-model-capacity-validation.md`와 delivery status를 따른다. 이 단계에서 NoMoreVibe 테스트를 다시 실행한 것으로 주장하지 않는다. 모든 own55518/55519 및 이전15/16/17 DB는 raw readback·정상STOP 뒤 제거 완료다. **재접속·재생성·타 자원 prune 금지.**

## 실서버 조사와 실패 접근

C의 읽기 조사는 종료했다. 실제 M3 8014 PID1758→serve.sh→9014 PID1502/같은 PPID1459·venv와 설치 source를 연결했다. installed metadata는 mlx-lm0.31.3/MLX0.32.2다. source SHA/관측과 현재 메모리 state는 구분한다. proxy의 출력 clamp만 확인됐고 입력 hard P 또는 전체 C는 검토 경로에서 확인되지 않았다. M≥1 non-spec loop는 반환≤M + 최대 lookahead1의 보수적 source bound를 지지하나 실제 GPU 비용 계측은 하지 않았다.

초기 'MLX 정상 final이 proxy에서 반드시 유실된다'는 가설은 추가 source 읽기로 **배제**했다. 현재 generate_response는 text가 비면 content 키를 생략하므로 proxy가 finish를 전달한다. 다른 upstream의 content:'' 형식은 미검증 호환 경계이며 현 서버 필수 수정으로 분류하지 않는다. remote import/추론/HTTP/쓰기0.

C 최종 결론 `/tmp/nomorevibe-pr01b6a-c-m3-serving-conclusion-20261016.md`, 전체 원자료 목록 `/tmp/nomorevibe-pr01b6a-serving-readback-contract-c-20261016.md`. 최소 후속안은 고정 non-spec route의 실제 tokenizer/template 이후 prefill 전에 positive Pmax/Mmax 및 P+M+1≤C를 검사하고 oversize를 거절하는 것이다. 아직 구현/운영 지원은 아니다.

Supa `supa`/vector9 SSH는 Tailscale 정책 deny exit255여서 원격 process/config는 읽지 못했다. 사용자의 평소 SSH 계정을 묻는 optional async 질문은 pending이다. 계정 추정·정책 우회·반복 질문을 하지 않는다. 별도 고정 HTTP /version,/v1/models,/openapi.json 각 GET1은200이며 vLLM0.30.0/Qwen3.8-27B-NVFP4/max_model_len32768 metadata만 확인했다. 이를 actual enforcement 증명으로 취급하지 않는다.

## 남은 작업과 다음 명령

1. abcLLM PR1은 로컬 개발 PR 제출까지 마쳤다. 이 단계의 main merge/배포0 경계를 유지한다. 후속 단계에서 실제 serving hard bound와 고정 모델 옵션 호환·종료 계약을 구체화한 뒤 배포/canary 순서를 정한다. native replay의 unsupported_provider_budget을 단순 boolean/JSON/callback으로 풀지 않는다.
2. 증명된 전체 C 또는 Pmax+M을 전량 보수 charge할 수 있으면 exact usage가 필수는 아니다. 실제 terminal/route/단일 attempt가 확인된 native 정산은 actualusage null도 가능하지만 unknown terminal/owner/attempt는 indeterminate와 seal 차단을 유지한다. 기존 fixture 의미는 바꾸지 않는다. 새 table·endpoint·all-loaded-bytes attestation을 불필요하게 선행시키지 않는다.
3. PR01 실제 bounded baseline/30분, PR04 item B5, PR05 전 caller와 종료 정산, PR06 독립 계속 소비·2배, PR07–11 Oracle 상시 번역/근거/uptime, PR14–17 DR·24h는 미완료다. 전체 상태는 `docs/superpowers/plans/2026-10-15-pipeline-delivery-status.md`를 따른다. Oracle는 정확히 surfguide/ap-osaka-1/osaka-smoke다.
4. NoMoreVibe WT의 handoff/PR05a validation/delivery status는 이전 PR 병합 이후 local docs 수정이다. 원 X branch나 이미 병합된 feature를 임의 push하지 않는다. 다음 실제 code PR에서 필요한 이전 결과를 취합한다.

```sh
cd /Users/jr/Desktop/projects/abcLLM-review-raw
git status --short --branch
gh pr view 1 --repo JRVector9/abcLLM --json state,headRefOid,baseRefOid,mergeable,statusCheckRollup
# source 변경/새 finding이 없으면 통과한 회귀를 반복하지 않는다.
# 변경이 있을 때만 아래 기존 venv 명령으로 실제 검증한다.
cd backend
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. /Users/jr/Desktop/projects/abcLLM/backend/.venv/bin/python -m pytest tests -q -p no:cacheprovider
# top-level backend/test_*.py 수동 외부 호출 스크립트는 실행하지 않는다.
```

직전 handoff 전체는 `/tmp/nomorevibe-CODEX_HANDOFF-before-raw-chat-pr1-20261016.md`에 보존했다. 과거 실패·자원 정리 세부는 이 백업과 각 PR 검증 문서에 있다. 이번 phase는 실제 gateway 결함 수정·PR 제출로 progress이며 전체 goal complete가 아니다.

## 최신 후속 phase — PR07a HTTP 정산 실제 수정 착수

이전 goal turn은 abcLLM PR1의 코드·회귀·직접/교차 리뷰·실제 commit/push/PR로 progress다. 이번에는 remote NoMoreVibe main99a9cefc 및 open PR를 확인했다. 기존 open292/270/208/160/159는 이번 pipeline PR가 아니므로 임의 병합하지 않았다. abcLLM PR1 최신1ca85c4도 GitGuardian SUCCESS이며 아직 OPEN/main 미병합이다.

새 WT **/Users/jr/Desktop/projects/nomorevibe-http-settlement**, branch **codex/pipeline-pr07a-http-settlement-20261016**, base **99a9cefcd9c82dcc86441b798332137a3604fe36**. root가 fetch 후 생성했고 기존 model-capacity WT의 node_modules만 symlink했다. Node **v24.18.0**. root가 설치 Next Vitest/server-client guide와 net/fetch.ts 전체·기존 deadline tests·model capacity 주요 경로를 읽었다. 새 DB/의존성 설치/운영 호출0.

고정 계획 **docs/superpowers/plans/2026-10-16-pipeline-pr07a-http-settlement.md**를 읽는다. 공통 HTTP DB장부만 더 추가하기 전에 실제 현재 safeFetch의 abort 즉시release/cancel 전release와 readBodyCapped fire-and-forget cancel을 닫는다. 취소상태를 호출 전 latch하고 같은 cancelPromise와 진행중 read 정산까지 origin을 유지한다. cancel 실패면 점유 유지, redirect cleanup 실패면 다음hop0, prefix/HTTP/Retry-After 원결과 보존이다. abort 때문에 read.done이 먼저 깨어나도 partial을 정상 성공으로 바꾸지 않고 원 signal.reason으로 body error를 유지한다. already-aborted 설치경계도 포함한다. 새 DB/모델/발굴/timeout/심사 기준/운영 적용 변경0. multi-host 상한/Oracle 가동/2배 합격은 별도다.

소유권: **C provider_contract_evidence**가 `lib/net/fetch.ts`와 `tests/net-fetch-settlement.test.ts`, **B pr01_final_ai2**가 독립 `tests/net-fetch-settlement-adversarial.test.ts`만. **지금은 테스트만 쓰고 실행하는 RED 단계이며 root가 원driver/log를 읽어 수용하기 전 source쓰기0**. shared fixture/설정/Git/DB/network0, 실제 ReadableStream과 deferred cancel, 원 source에서도 finally의 모든reader/cancel/follower 정산을 요구한다. source baselineSHA **7ce56dca705124b25b4ee7208e90f127ea11373a137d8cc874158e6e17298b11**, 원본 `/tmp/nomorevibe-pr07a-root-original-fetch-20261016.ts`.

A는 M3 관리되는 serving source 후속을 조사했다. root가 `/tmp/nomorevibe-pr01b6b-managed-serving-scope-a-20261016.md` 전체를 읽었다. 현재 두abcLLM checkout은MLX launch원본을관리하지않고M3Git원본은미확인이다. 가장작은cap은full tokenize직후 batch/single 두곳에서 positive resolved M/draft없음/**P+M+1≤C**를검사하는것이며Pmax/Mmax/prepare API를먼저추가할필요는없다. 현재A에게exact기존M3SSH 한회로 /Users/jr/mlx-serve와명시부모/프록시의.git **존재 metadata만** 및기존sourceSHA동일확인을허용했다. 원격git명령/remoteURL/argv/env/plist/secret/추론/HTTP/쓰기0, .git가있으면먼저root보고. 이후A를07a source교차리뷰에쓸수있다.

C 기능범위노트 `/tmp/nomorevibe-pr07-functional-scope-c-20261016.md`는root완독. 다음PR07b는shared장부+고정undici per-hop adapter+safeFetch/fetchCapped 양API실연결+actualDB/loopback을한기능gate로묶는다. 원 fetch reject/body EOF만으로 실제dispatch종료를추정하지않고설치undici의native onResponseEnd/onResponseError 경계와reader정산을결합할필요가있다. crash미확정slot의TTL회수는열지않는다. 지금07a로이전체를완료한것으로세지않는다.

B의PR04c다음기능범위읽기는 /tmp/nomorevibe-pr04c2-next-functional-scope-b-20261016.md 에반환예정이다. root가아직완독/구현계약고정하지않았다. 이읽기가끝나면위독립07a test를진행하도록지시했다.

정확한 다음 명령:
```sh
cd /Users/jr/Desktop/projects/nomorevibe-http-settlement
git status --short --branch
# C/B가원driver/RED로그를반환하면root직접읽기→기능RED수용→C만source수정.
# writing-plans/TDD절차와고정계획의실제검증명령을따른다.
npx vitest run tests/net-fetch-settlement.test.ts tests/net-fetch-settlement-adversarial.test.ts tests/net-fetch-deadline.test.ts tests/net-fetch-recovery.test.ts tests/net-fetch-conditional.test.ts tests/link-evidence.test.ts
# source미완성중전체suite를먼저돌리지말것. 새DB0/이전ownDB재접속0/원Xpush0.
```
