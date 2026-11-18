# deepseek 품질 표본 — 키워드 검수·제품 번역 (2026-11-18, 측정만)

- 지시: "키워드 검수와 제품 번역에 deepseek를 넣기 전에 50건 품질 표본 비교부터 해 줘"(사람, 11/18). 측정만 했다. 운영 순위·연결·장비 한도 저장, 운영 DB 쓰기, 서버 설정 변경은 하지 않았다.
- 대상: M3 `deepseek-v4.1-flash-1017`(oMLX, 8010, 엔진 1칸). 비교 대상 모델은 새로 부르지 않았다. 운영 DB에 저장된 결과를 읽기 전용으로 읽었다.
- 코드 기준: 운영 판 `ebd63092`(장부 binding `role.release`로 운영 판임을 확인). 스크립트는 `scripts/ops/deepseek-quality-sample/`에 있다.
- PR: #991 (Draft).

## 결론

**키워드 검수는 "조건부"다. 예비 순위로는 넣어도 되지만, 동시에 묶음 구성원은 비추천이다. 제품 번역은 측정을 끝내지 못해 판단을 보류한다.**

- 품질: 측정한 23건(qwen 층)에서 deepseek는 운영 qwen과 키워드 단위로 98.2% 같았다. 운영이 지우지 않은 13건에서는 하나도 지우지 않았다.
- 속도: 검수 1건에 p50 31.1초가 걸렸다. 운영 qwen은 7.2초, Supa는 19.1초다. 엔진 1칸을 그만큼 오래 잡는다.
- 처리량: 남는 엔진 시간을 다 써도 시간당 약 40~65건이다. 지금 키워드 검수 처리량(시간당 약 380건)의 +10~17% 정도다. 그 대신 위임 검수·키워드 짓기·발행 분류의 기다림이 늘어난다.
- 시험 중 운영 영향: **직접 호출이 운영을 약 19분 막았다.** 23번째 호출 뒤 시험을 멈췄다. 자세한 내용은 아래 "운영 영향"에 있다.
- 번역 50건은 부르지 않았다. 같은 방식으로 이어서 측정할지는 사람이 정해야 한다.

## 1. 키워드 검수 (product-search-verify)

### 표본

- 최근 24시간 안에 첫 시도에 확정된 제품에서 뽑았다(verify_attempts=1, 나눠 검수 아님).
- 운영 모델별로 25건씩, 그중 지움이 있는 것을 10건씩 일부러 넣었다(supa 25, qwen3.8-flash-next 25).
- 50건 모두 지금 다시 만든 근거의 `profileHash`가 저장된 `source_hash`와 같았다. 즉 운영 검수가 본 입력과 같다.
- wire: `searchVerifyGatewayWire(item, "deepseek-v4.1-flash-1017")` 그대로 보냈다.
  - deepseek의 다른 abcllm 직접 계약(키워드 짓기)과 같은 방식이다.
  - 설정은 temperature 0, max_tokens 3,000(운영 routes.limits와 같음), json_object, enable_thinking false다.
- 결과 파서: 운영 `parseVerification`.
- **실제로 부른 것은 50건 중 23건이다.** 모두 qwen 층이다(정렬상 qwen 25건이 앞이었다). Supa 층 25건은 측정하지 못했다.

### 결과 (23건)

| 항목 | deepseek | 운영(같은 23건, qwen) |
| --- | --- | --- |
| 형식 통과 | 23/23 | — |
| 키워드 수 | 330 | 330 |
| 지운 키워드 | 10 | 14 |
| 키워드 단위 일치(유지·지움) | 324/330 = **98.2%** | — |
| 둘 다 지움 / 둘 다 유지 | 9 / 315 | |
| 운영만 지움(deepseek 유지) | 5 | |
| deepseek만 지움 | 1 | |
| 지움 집합이 완전히 같은 제품 | 20/23 | |
| 운영 지움 0인 13건에서 deepseek 지움 | 0건 | 0 |
| 운영 지움 있는 10건에서 지움 비율 | 6.7% | 9.4% |
| 호출 시간 p50 / p90 | **31.1초 / 38.3초** | qwen 7.2 / 9.5초, Supa 19.1 / 24.2초(장부 24시간) |
| 출력 토큰 p50 / p90 | 827 / 968 | — |
| 생성 속도 | 25~33 tok/s, 입력 916~2,063토큰, 첫 토큰 1.6~4.3초 | |

지움 비율 해석:

- 운영 전체의 지움 비율은 qwen 1.6%, Supa 4.6%다(11/17).
- 표본은 지움 있는 것을 일부러 많이 넣었으므로 전체 비율을 직접 비교할 수 없다.
- 운영이 아무것도 지우지 않은 제품에서 deepseek도 지우지 않았다는 점은 확인했다. 운영 검수의 95% 이상이 이런 제품이다.

### 사람이 본 사례

deepseek가 틀린 것(5):

1. `shahi`, "mobile terminal interface": 페이지에 "Not a terminal squeezed onto a small screen"이라고 적혀 있다. 운영 qwen은 지웠고 deepseek는 남겼다(fits true). 놓친 것이다.
2. `don`, "전 남친 문자 차단": 남성용 이별 앱이다("A Survival Guide For Men After A Breakup", "checking her Instagram"). deepseek의 reading은 "Blocking texts from an ex-boyfriend"인데 fits를 true로 냈다. 대상이 틀린 것을 놓쳤다.
3. `don`, "전 남친 연락 차단": 2번과 같은 이유로 놓쳤다.
4. `dabba`, "software discovery platform": 제품은 RFP를 "discovery, a PRD, …"로 바꾸는 작업공간이다. 소프트웨어를 찾는 플랫폼이 아니다. 운영은 지웠고 deepseek는 남겼다.
5. `dabba`, "사업 계획서 작성": deepseek만 지웠다(source_means "business case … not a business plan"). 프롬프트는 "If you would have to argue that two things differ, they fit"라고 한다. 지나치게 엄격하게 지운 것으로 본다.

같은 `don`의 "ex texting blocker"는 "app that helps you not send the text"로 읽으면 맞는 말로 볼 수 있어 셈하지 않았다.

deepseek가 맞은 것(5, 모두 운영과 같은 지움):

1. `553hoikaten`, "보육원 입원 점수 계산기": source "保育園の入園点数"에서 source_means를 "Nursery school admission (入園) points — entering a nursery, not hospitalization"으로 적고 지웠다.
2. `jra`, "구매 가이드": "買い目ガイド"를 "betting-combination guide (買い目 = betting ticket selection), not 'purchase'"로 읽고 지웠다.
3. `4730`, "학점 계산기": 내신점(内申点) 계산 사이트다. deepseek는 이를 "GPA / credit calculator (university-style …)"와 다르다고 보고 지웠다.
4. `spideryarn`, "article summarizer": 근거에 "Nearly every AI reading tool makes the same move: compression …"이라고 적혀 있다. 요약을 거부하는 제품이라는 점을 짚고 지웠다.
5. `shinobi-journey`, "shrine villages": "four rival villages (no mention of shrines)"라고 보고 지웠다.

## 2. 제품 번역 (product-translate) — 측정 못 함

### 준비한 것

- `/tmp/xaegis/m1apc/cases3.json`은 이 작업 환경에서 읽을 수 없었다. gpu3090 /tmp, M3·mini·supa, 허브 보고 첨부를 모두 찾아봤다. 대표 실행 단위의 /tmp에만 있던 것으로 보인다.
  - 원래 cases3은 사이트 HTML에서 뽑은 이름·소개로 만들었다. 그래서 다시 만들 수 없다.
- 그래서 같은 생성 방식으로 운영 DB에서 50묶음을 새로 만들었다. 실제 이름, 소개(tagline), 4건 묶음, en 17·zh-Hans 17·ja 16묶음이다(`translate-cases.ts build`).
  - en·zh-Hans는 최근 48시간에 운영 모델(m1-gemma·gpt-oss-120b·Qwen3.8-27B-4bit)이 처리한 행이다. 저장된 결과와 비교할 수 있다.
  - ja는 운영 대기(pending) 행이다. ja는 운영에서 아직 한 건도 번역되지 않았다(ready 0).
  - 200항목 모두 지금 원문의 `productTranslationSourceHash`가 저장된 값과 같았다.
- wire: `productTranslationGatewayWire(items, "deepseek-v4.1-flash-1017")`.
  - deepseek는 Qwen이 아니어서 기본 시스템 문장을 쓴다. ja 묶음에는 ja 지시가 붙는다.
  - 묶음은 #985 방식(한 묶음 한 언어)으로 만들었다.
- 채점: 운영 `parseKoreanTaglines` + `checkProductTranslation`. en은 #986(미병합) 판 검사로도 함께 센다.
- **위 준비는 했지만 호출하지 않았다.** 아래 운영 영향 때문에 남은 호출을 멈췄다.

### 지시와 다른 점

- 지시는 "#985·#986이 병합됐다"고 했다. 실제로는 2026-11-18 기준 두 PR 모두 **OPEN(미병합)** 이고, 운영 판 ebd63092에 들어 있지 않다.
  - #985는 wire 바이트를 바꾸지 않고 묶음 구성만 한 언어로 바꾼다. 그래서 한 언어 묶음을 ebd63092 wire로 보내면 #985 이후와 같은 요청이 된다.
  - 운영은 지금도 여러 언어를 섞어 묶는다.
- M1Max 기준 148/200은 다른 50건(cases3)에서 나온 값이고, 그 뒤 검사·묶음이 바뀌었다. 직접 비교하지 않는다.

## 3. 운영 영향 (시험 전·중·후 장부)

deepseek 경로의 기다림은 `dispatched_at - queued_at`, 실행은 `settled_at - dispatched_at`으로 쟀다.

| 구간(UTC) | 요청 | 평균 기다림 | 실행 | 미확정 |
| --- | --- | --- | --- | --- |
| 시험 전 03:09–04:09 | 키워드 짓기 79, 위임 검수 37, 분류 17, 두 번째 의견 1 | 1.1–1.7초 | 7.4 / 8.6 / 39.6초 | 분류 1(시험 전부터 있던 것, 01:35·02:57·03:32에도 있음) |
| 시험 중 04:09:20–04:31 | **키워드 짓기 6건뿐**(정상이면 약 85건) | 0.8초 | 19.5초 | **키워드 짓기 2** |
| 시험 뒤 04:31–04:36:30 | 위임 검수 11, 키워드 짓기 6, 분류 3 | 0.9–1.4초(분류 7.8) | 7.2 / 7.7 / 49.8초 | 0 |

무슨 일이 있었나:

1. 04:09:24 키워드 짓기 1건이 평소 7초가 아니라 28초 걸렸다. 직접 호출이 같은 엔진을 동시에 쓴 탓이다.
2. 04:09:56 키워드 짓기 1건이 예약(디스패치 뒤 약 30초)을 넘겨 04:10:18에 **미확정(indeterminate)** 이 됐다.
3. 미확정은 유지 시간(`DEFAULT_MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS` 600초) 동안 1칸을 잡는다. 그래서 04:10:18–04:20:05에 deepseek 운영 디스패치가 **0건**이었다. 위임 검수·키워드 짓기·분류가 모두 멈췄다.
4. 04:20:49 또 1건이 미확정이 됐다(04:21:20). 그래서 04:30:56까지 다시 0건이었다.
5. 04:22Z(23건째 뒤)에 시험을 멈췄다. 04:30:56부터 정상으로 돌아왔다.

정리하면 약 19분 동안 deepseek 운영 경로가 멈췄고, 약 80건이 뒤로 밀렸다(잃은 것은 아니다).

- 정한 정지 조건 "평균 기다림 30초"는 이 막힘을 잡지 못했다. 디스패치되지 않은 일은 장부에 행이 없어서 평균에 들어가지 않기 때문이다. 처리 건수가 줄어든 것을 보고 멈췄다.
- 교훈: 1칸 엔진을 장부 밖에서 직접 부르면, 2초 간격으로 한 건씩 불러도 운영 호출이 예약 시간을 넘긴다. 그러면 미확정 → 10분 점유가 된다. 앞으로 이 엔진의 표본 측정은 장부 예약을 거치거나, 운영 경로를 멈춘 창에서만 해야 한다.

## 4. 넣는다면 — 방식과 숫자 (키워드 검수)

- 남는 엔진 시간: 24시간 시간당 사용률 44~64%이므로 남는 시간은 시간당 약 1,300~2,000초다.
- 검수 1건 31초면 시간당 최대 약 40~65건이다. 지금 처리량은 qwen 5,040건 + Supa 4,158건 / 24시간 ≈ 시간당 380건이다. 그러니 +10~17%이고, 대기 39,736건을 다 비우는 데 걸리는 시간이 약 104시간에서 약 90시간으로 준다.
- **동시에 묶음 구성원 1칸으로 넣는 경우(비추천)**:
  - 검수가 칸을 31초씩 잡는다. 시간당 50건이면 엔진의 약 43%다. 기존 경로(시간당 약 120건) 호출의 약 43%가 앞선 검수를 평균 약 15초 기다린다.
  - 그러면 위임 검수·키워드 짓기의 평균 기다림이 1초대에서 약 7초 늘어난다. 최대는 약 38초다. 엔진 사용률은 거의 100%가 된다.
  - 시간당 약 200건 여유라는 대표 추정은 호출 7초 기준이다. 검수는 4배 이상 길어서 실제 여유는 약 50건이다.
- **예비 순위(qwen·Supa가 모두 쓸 수 없을 때만)로 넣는 경우(조건부 추천)**:
  - 측정한 범위에서 품질은 qwen과 비슷하다. 운영이 깨끗하다고 본 제품을 지우지 않았다. 다만 대상(성별)·문맥 오류를 몇 개 놓쳤다.
  - 평소에는 엔진을 쓰지 않는다. 장애 때만 시간당 약 50건을 처리한다.
  - 장부 안에서 돌면 위 미확정 문제는 생기지 않는다. 예약 안에서 하나씩 돌기 때문이다.
- 출력이 긴 까닭: 프롬프트가 키워드마다 reading·source·source_means·fits 네 칸을 적게 한다. 16개면 약 830토큰이다. 프롬프트를 줄이면 `SEARCH_VERIFY_POLICY_HASH`가 바뀌므로 별도 작업이다.

## 5. 확인하지 못한 것

- 키워드 검수 Supa 층 25건과 qwen 층 2건(총 27건)을 측정하지 못했다. Supa와의 일치와 Supa가 지운 사례에 대한 판단은 없다.
- 제품 번역 50묶음 전부(형식 실패, 언어별 통과, ja 중국어 답 수, 시간·토큰)를 측정하지 못했다.
  - 참고 추정(측정 아님): 소개 4건 묶음의 출력이 300~400토큰이라면 27 tok/s에서 12~15초다. M1max Qwen(장부 p50 14.9초)과 비슷하다.
- 멈출 때 엔진에 들어가 있던 24번째 요청(i=23)이 끝까지 생성됐는지는 모른다. 응답은 기록되지 않았다.
- 미확정 2건(`20cb61bc…`, `9ba2c713…`)은 장부에 indeterminate로 남아 있다. 회수는 일반 운영 절차가 다룬다. 이 작업은 쓰지 않았다.

## 6. 재현

1. 읽기 전용 SQL로 후보를 뽑는다. 쿼리는 PR 대화와 보고서 원자료에 있다.
2. 실행 폴더에 ebd63092 트리를 풀고 node_modules를 링크한다.
3. 다음을 차례로 실행한다:
   - `tsx scripts/ops/deepseek-quality-sample/verify-cases.ts build <candidates.json> <cases.jsonl> deepseek-v4.1-flash-1017 25 10`
   - `python3 -I scripts/ops/deepseek-quality-sample/run-serial.py <cases.jsonl> <responses.jsonl> --budget-file <f> --wait-check …`
   - `verify-cases.ts parse …`
   - `analyze.py …`
4. `run-serial.py`는 한 번에 1건, 2초 간격, 120초 제한, 누적 150건 상한으로 돈다. 10건마다 장부 기다림을 잰다.
5. **위 운영 영향 때문에, 장부 밖 직접 호출로 다시 돌리지 않는다.**
