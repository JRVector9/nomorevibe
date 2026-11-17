# 오래된 감사 거절의 원본 다시 받기 — 2026-11-17 (PR #987)

대표 지시 원문: "오래된 감사 거절은 원본을 다시 수집한 뒤 두 번째 의견을 묻게, 재판정 거절은 다른 모델이 의견을 내게"
이 문서와 PR #987 은 **앞쪽(오래된 감사 거절 재수집)만** 맡는다. 뒤쪽(재판정 거절의 같은 모델 제외 → 다른 모델)은 별도 PR 이다.

## 운영 실측 (2026-11-17 11:3xZ, 운영 DB 읽기 전용 `begin read only`)

| 항목 | 값 |
|---|---|
| 감사 캠페인 6(grok-4.7, 11/01 옮겨 적기)의 열린 거절 | 538 (모두 7일 넘음) |
| 그 원본 수집 시각 | 2026-08-29 ~ 2026-09-19 (538건 모두 24시간 넘음) |
| 그 저장소 스캔 | complete 519(완료 9/26~10/14) · partial 19(완료 시각 없음) |
| 스캔 claim | 537건 priority 5(regular), due 2026-12-25 ~ 2027-01-17(공개 제품 배경 주기 `backgroundRefreshDays`=90) |
| 수집 프론티어 | 538건 모두 `done`(실패·404 기록 없음) |
| 이 538건의 qwen-v2-auto 의견 | 0건 (qwen-vision-auto 23건: 거절 17·승인 6) |
| 관측 `qwen-second-opinion` failures | 500건(상한) 모두 `input_stale` |
| 주인 있는 제품 | 0 · 글 적은 페이지(본문 300자 아래) 23 |
| GitHub 표본 40개 저장소 존재 확인(`gh api repos/…`) | 40/40 있음 |
| 수집 대기열(pending) | 27건(due 14) · 스캔 claim priority 1 active 26 |

## 원인 (코드)

- `lib/crawl/audit-second-opinion-auto.ts` 의 입력은 `loadAuditInput` → `createReviewInput` 이고 `validUntil = min(원본 수집, 스캔 완료) + 24시간`.
- PR #802 이후 기한 지난 대상은 자리를 잡지 않고 `input_stale` 로 넘기고 1시간(`INPUT_STALE_RETRY_MS`) 뒤 다시 고른다 — "그 사이 원본이 다시 수집됐으면 묻는다".
- 그러나 공개 제품의 원본·스캔을 다시 받는 곳이 없다: 1차 원본 재수집(`requeueStaleReviewSources`)은 approved/needs_review 후보만, 스캔 우선 수요는
  1차 심사·2차 대기만 보고, 공개 제품 스캔은 90일 주기다. 그래서 538건은 매 시간 다시 골라도 영원히 `input_stale` 였다(asked 0).

## 고친 것

- 새 표 `product_audit_recollects`(0188, 항목마다 한 줄: waiting · done · failed · dropped).
- 두 번째 의견 단계가 기한 지난 **감사 거절**을 만나면 틱마다 `qwenAuto.auditSecondOpinion.recollectPerTick`(기본 1, 0~10) 건까지,
  다시 받는 중인 것이 `AUDIT_RECOLLECT_MAX_WAITING`(20) 아래일 때만 `requestAuditRecollect` 로 기존 수집 길을 다시 연다.
  - 원본: `crawl_frontier` 를 pending 으로 되돌리고 `crawl-fetch` 를 깨운다(1차 원본 재수집과 같은 잠금 순서·같은 신호 `review-source-refresh`, 살아 있는 수집 claim 은 건드리지 않음).
  - 스캔: `fillAgentScanQueue` 가 waiting 항목 저장소(마지막 스캔 완료가 23시간 넘음)를 1차 심사 몫 우선순위(priority 1)·매일 수요로 올린다(`auditRecollectScanDemand`).
  - README: 수집은 옛 README 를 판 없음으로 옮겨 두고, 기존 잡 `product-readme-refresh`(5분마다 2건)가 다시 받는다. 마무리는 그것을 12시간까지 기다린다.
- 틱 앞머리 `settleAuditRecollects` 가 waiting 줄을 본다(모델 호출 없음):
  - 입력이 새로워졌으면 done — 감사 입력 product 칸(이름·소개·본문·README·주소·접근 방식·토픽 등)마다의 16자 해시를 요청 때와 견줘 `changed_fields`·`source_changed`, `readme_refreshed` 를 남긴다.
    다음부터 두 번째 의견이 보통처럼 새 입력으로 묻는다(같은 틱에 묻기도 한다).
  - 요청 뒤 수집이 404(repo_deleted)·빈 저장소(repo_empty)·이름 바뀜(repo_renamed)·재시도 소진(source_refresh_failed)으로 끝나면 failed — 사유를 남기고 사람 몫. 다시 고르지 않는다.
  - 요청하고 48시간 안에 다시 받지 못하면 failed(refetch_not_received_48h). done 뒤 또 기한이 지나 3번째 요청이 되면 failed(refetch_expired_before_ask).
    둘 다 '다시 받지 못해서'다 — 근거 나이로 사람 몫이 되는 길은 없다(아래 '사람 추가 지시' 1).
  - 그 사이 사람이 정했거나 제품이 내려갔으면 dropped.
- 두 번째 의견은 done 이 아닌 다시 받기 줄이 있는 항목을 고르지 않는다(`auditRecollectBlocksSql`). 상한을 넘긴 나머지와 공개분 2차 행은 예전처럼 1시간 쉰다.
- 감사 화면(자동 보류 칸): "원본 다시 받기 틱마다 N건 · 받는 중 · 끝남(근거 바뀜) · 사람 몫(사유별)" 한 줄, 두 번째 의견 스위치에 "원본 다시 받기 _건/틱" 칸(올리면 사유 필요).
  운영 스크립트: `scripts/ops/set-qwen-auto.ts --step=auditSecondOpinion --recollect-per-tick=N --reason=…`.

## GitHub 한도 영향

- 한 건: 원본 수집 core 1회(저장소 메타) + 별 5~499·배포 주소 없음이면 패키지 확인 1회, README 1회, 스캔 9~12회(스캔 한 단계 상한 12, 운영 24시간 중앙값 9) ≈ **13회**.
- 기본 1건/틱(틱 1분)이면 최대 60건/시간 ≈ 780회/시간. 실제로는 README 잡(2건/5분 = 24건/시간)과 동시 20건 상한이 묶어 **약 24건/시간 ≈ 310회/시간**.
- 프로젝트 활동 묶음(11-17 추가)은 GitHub 를 새로 부르지 않는다 — 수집 원본의 repo_meta·page_status·finalUrl, 기존 연결 확인·릴리스 수집 값만 읽는다.
- 538건 전부 ≈ 7,000회. 스캔 소비자는 GitHub 여유 관문(`readGitHubCoreHeadroom`)을, 수집은 rate_limited 일시정지를 그대로 탄다.

## 운영 적용 뒤 예상 (추정, 근거는 위 실측)

- 538건 중 저장소 표본 40/40 존재 → 다시 받기 실패는 많아야 수십 건(0/40 의 95% 상한 ≈ 7.5% ≈ 40건).
- 다시 받은 뒤 두 번째 의견이 묻는다. qwen-v2-auto 전체 의견 6,479건 분포: 승인 28.9%·거절 71.0%(확신 0.90 이상 99.7%).
  주인 있는 것 0, 글 적은 페이지 23건(답은 의견으로만 남고 화면 판별 대기), vision 의견이 있는 23건 중 일부는 엇갈림으로 열림.
- 첫 추정(v2 글, 활동 묶음 없음): 자동 유지 약 140 · 자동 숨김 약 340 · 열린 채 사람 몫 약 30~70.
- **재추정(11-17 사람 추가 지시 반영 뒤)**: 자동 유지 **140 이상** · 자동 숨김 **340 이하** · 사람 몫 **30~70(그대로)**.
  - 사람 몫은 나이로 늘지 않는다 — 사유가 모두 '다시 받지 못해서'라 다시 받기 실패(많아야 ~40)와 글 적은 23·엇갈림만 남는다.
  - 감사 전용 글(오래됨·활동 멈춤만으로 거절 금지)과 활동 묶음은 '오래됨·비활동'이 거절 까닭이던 항목을 승인(자동 유지) 쪽으로 옮긴다.
    11/01 grok 감사 사유 중 그런 것이 몇 건인지는 이번에 운영 읽기 조회가 권한 거부돼 세지 못했다 — 옮겨 가는 크기는 배포 뒤 PENDING.md 의 SQL 로 잰다.
  - 사이트가 지금 오류·닿지 않음이면 활동 묶음이 그것을 보여 거절(숨김)은 그대로다.
- 걸리는 시간: 약 24건/시간 → 약 22시간(README 잡이 묶는 속도). 활동 묶음은 GitHub 를 새로 부르지 않아 속도·한도가 같다.

## 배포

- `npm run deploy -- scope --base a9c53498… --sha 22eda6f3…`(11-17 사람 추가 지시 반영 뒤, 전체 sha) → **full(18앱 전부)**, `trusted: true`, 사유 `no_runtime_change`·`unclassified_runtime_change`
  (이후 문서 커밋만 추가). 마이그레이션은 **0188 하나**(새 표만 — 11-17 추가로 같은 새 표에 jsonb 열 3개 `before_activity`·`after_activity`·`change_summary` 를
  배포 전에 더했다. 기존 표의 CHECK·열은 바꾸지 않아 **DRAIN 불필요**, product_audit_items 외래 키가 SHARE ROW EXCLUSIVE 를 잠깐 잡는다 — lock_timeout 5s).
- 배포만으로 켜진다(기본 recollectPerTick 1, 운영 auditSecondOpinion 은 켜져 있음). 새 요청을 막으려면 `--recollect-per-tick=0`.
  감사 두 번째 의견은 배포 즉시 감사 전용 글 판 `2026-11-17.v2-audit` 과 활동 묶음으로 묻는다(이미 받은 v2 의견은 다시 묻지 않음).

## 되돌리기

1. 새 요청만 멈추기: `set-qwen-auto.ts --step=auditSecondOpinion --recollect-per-tick=0 --reason=…`(이미 요청한 것은 마무리만 한다).
2. 코드 되돌리기: 이 PR 을 revert 하고 배포. 표는 남겨도 옛 코드가 읽지 않는다(지우려면 `DROP TABLE product_audit_recollects` — 별도 승인).
   주의: 새 코드가 `recollectPerTick` 칸을 저장한 뒤 옛 코드로 돌아가면 옛 코드(strict)는 감사 두 번째 의견 단계를 깨진 것(꺼짐)으로 읽는다 — 되돌린 뒤 그 단계를 다시 저장해 칸을 지운다.
3. 다시 받기 waiting·failed 항목을 두 번째 의견에 다시 돌리려면(사람 결정): `delete from product_audit_recollects where state in ('waiting','failed')` — 운영 쓰기라 별도 승인.
4. 감사 전용 글 판만 되돌리기: `audit-second-opinion-auto.ts` 의 `promptFor` 가 감사도 v2 를 돌려주게 고치고 배포. 감사 전용 판으로 받은 의견(prompt_version `2026-11-17.v2-audit`)은
   `AUDIT_OPINION_PROMPT_VERSIONS` 에 남겨 두면 다시 묻지 않는다(빼면 그 항목들을 v2 로 다시 묻는다). 활동 묶음만 끄려면 `loadAuditInput(…, { projectActivity: true })` 와
   호출 직전 증명의 second_opinion 묶음을 함께 뺀다(한쪽만 빼면 증명이 input_changed 로 거절).

## 사람 추가 지시(11-17) 반영

원문: "기간 상관없이 다시 살펴보고 진행중인 프로젝트인지 보게 만드는게 맞지 않을까"

### 1. 나이 기준 없음 고정
- 다시 받을 대상과 두 번째 의견 고르기에는 근거 나이(N일) 조건이 없다(그대로). 시간 재기는 **다시 받기 요청부터**(waitedMs)만 한다.
- 사람 몫 사유 이름을 '다시 못 받아서'로 바꿨다: `recollect_timeout` → **`refetch_not_received_48h`**("다시 받기를 요청하고 48시간 안에 원본·스캔을 다시 받지 못했습니다(근거 나이 때문이 아닙니다)"),
  `recollect_repeated` → **`refetch_expired_before_ask`**("원본을 3번 다시 받았지만 그때마다 묻기 전에 받은 근거의 기한이 지났습니다(근거 나이 때문이 아닙니다)").
  배포 전이라 옛 이름의 행은 없다.
- 감사 화면: 상태 줄 "다시 받지 못해 사람 몫 N(사유별)", 스위치 설명 "근거가 언제 것이든(나이 기준 없음) … 오래됐다는 것만으로는 사람 몫이 되지 않고",
  항목 줄 "다시 받지 못함 — 48시간 안에 못 받음 — 사람 몫(근거 나이 때문이 아니라 다시 받지 못해서)".
- 시험: 50일·400일·5년 묵은 근거가 모두 다시 받기로 가고 받은 뒤 묻는다(단위), 3년 묵은 원본이 failed 가 아니라 waiting(통합), 사유 목록에 나이·오래됨 이름이 없음,
  두 번째 의견 고르기 SQL 에 수집·스캔 시각 조건이 없음.

### 2. 프로젝트 활동 근거(`lib/crawl/audit-project-activity.ts`)
- 감사 거절의 두 번째 의견 입력 `snapshot.projectActivity`(product 밖 — 원본 해시 `auditSourceHash` 그대로):
  `archived`·`lastPushAt`(수집 원본 repo_meta), `latestRelease`(기존 릴리스 수집 product_updates github_release 중 원본을 받은 때까지의 마지막 것),
  `site.status`(수집이 연 응답 코드)·`site.finalUrl`(리다이렉트 끝 주소, 같으면 null)·`site.uptimeStatus`/`uptimeDown`(기존 연결 확인 product_health, 연속 3번 실패 = 내려감).
- **새 GitHub 호출 0회** — 모두 이미 받은 값이다. GitHub 한도 계산은 바뀌지 않는다(아래 'GitHub 한도 영향' 그대로).
- 관측 시각(수집·연결 확인 시각)은 싣지 않는다 — 언제 받았는지가 판정 입력을 바꾸지 않게.
- 1차·2차·감사 본심사·화면 판별 입력에는 싣지 않는다(입력 해시 그대로). 호출 직전 증명(`local-model-domain.ts`)은 second_opinion 목적일 때 같은 트랜잭션으로 묶음을 다시 만들어 견준다.

### 3. 감사 때와 지금 차이(0188 열 `before_activity`·`after_activity`·`change_summary`)
- 요청 때 옛 원본(감사가 본 것)의 묶음과 다시 받은 원본의 묶음을 견줘 사람이 읽는 글을 남긴다:
  "사이트 404 → 200", "리다이렉트 → …", "마지막 push 9/02 → 11/10", "보관 아님 → 보관됨(archived)", "새 릴리스 v2.0 (2026/11/03)", "페이지 본문·README 바뀜".
  changed_fields(칸 해시)는 그대로 둔다.
- 감사 화면 '감사가 짚은 제품'·'변경 재판정' 항목에 한 줄: **감사 때 → 지금** …(끝남) · **원본 다시 받는 중** 11/17 요청 · **다시 받지 못함** 사유(사람 몫).
  스크린숏: 보고의 `audit-finding-before.png`·`audit-finding-after.png`(실제 `AuditFinding` 컴포넌트를 고정 데이터로 그림, DB·로그인 없음).

### 4. 오래됨 편향 방지 — 감사 두 번째 의견 전용 글 판 `2026-11-17.v2-audit`
- `QWEN_V2_AUDIT_ADDENDUM` = v2 덧붙임(한 바이트도 그대로) 마지막 줄 앞에 메모 두 줄:
  8. 근거·수집·감사가 오래됐다는 것, 최근 커밋·push·릴리스가 없다는 것만으로 거절하지 말 것 — 이번에 새로 받은 근거와 projectActivity 로 지금을 판단.
  9. 지금 쓸 수 있으면(사이트 동작·설치형은 설치 가능) 개발이 멈췄거나 보관됐어도 올림 그대로. 거절은 정책의 사유(지금 오류·닿지 않음·엉뚱한 곳 착지 등)일 때만.
  게재 기준(실제로 만든 소프트웨어면 올림)은 바꾸지 않았다. sha256 `2e417bf1…899246c` 를 시험이 고정한다.
- **선택과 이유**: v2(`2026-10-21.v2`)를 고치면 그 글을 쓰는 다른 줄(보류 재심사·갈림 판가름·화면 판별·감사 본심사·공개분 2차)과 이미 받은 v2 감사 의견
  (운영 6,479건)이 모두 다시 돈다 → **감사 두 번째 의견 경로에만** 새 판을 쓴다. 공개분 2차는 v2 그대로.
  이미 받은 v2 감사 의견은 끝난 것으로 센다(`AUDIT_OPINION_PROMPT_VERSIONS` — 고르기·남은 수·답으로 닫기 따라잡기·상태 수). 출처(qwen-v2-auto)·기록 모델 이름이 같아 (항목, 모델) 한 줄 규칙과 답으로 닫기가 그대로다.
- 시험: 같은 원본을 1시간 전·20시간 전에 받고 스캔도 다른 때 끝난 두 입력이 같은 스냅숏·같은 입력 해시·실제 Qwen 직접 호출 길의 같은 보내는 글·같은 결과를 낸다.

### 진행표
- [x] 1. 나이 기준 없음 고정 — 사유 이름·문구, 시험
- [x] 2. 프로젝트 활동 근거 — 새 GitHub 호출 0
- [x] 3. 감사 때와 지금 차이 — 기록·감사 화면 한 줄(전후 스크린숏)
- [x] 4. 오래됨 편향 방지 — 감사 두 번째 의견 전용 판, 같은 입력 시험
- [x] 문서·예상 효과·배포 범위·되돌리기 갱신
- [ ] 538건 재추정의 운영 표본 측정 — 운영 DB 읽기 전용 조회가 이 실행에서 권한 거부(자동 모드 분류기 'Unauthorized Access')돼 못 했다. 아래 재추정은 11-17 11:3xZ 실측만 근거

## 남은 일 / 막힌 것

- [x] 원인 확인·재현 시험(`tests/audit-stale-recollect.test.ts`, 통합 `tests/integration/audit-stale-recollect.test.ts`)
- [x] 기존 수집 길 재사용(프론티어·스캔 claim·README 잡), 틱 상한·동시 상한, 실패 → 사람 몫, 근거 바뀜 기록, 감사 화면 상태 줄
- [ ] 운영 배포·관측(이 PR 범위 밖 — 병합·배포 금지). 관측 SQL 은 PENDING.md
- [ ] 공개분 2차 행(published-filter)의 기한 지남은 그대로 쉰다(이 PR 범위 밖)
