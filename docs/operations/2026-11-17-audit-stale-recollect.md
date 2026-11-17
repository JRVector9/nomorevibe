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
  - 48시간 안에 새로워지지 않으면 failed(recollect_timeout). done 뒤 또 기한이 지나 3번째 요청이 되면 failed(recollect_repeated).
  - 그 사이 사람이 정했거나 제품이 내려갔으면 dropped.
- 두 번째 의견은 done 이 아닌 다시 받기 줄이 있는 항목을 고르지 않는다(`auditRecollectBlocksSql`). 상한을 넘긴 나머지와 공개분 2차 행은 예전처럼 1시간 쉰다.
- 감사 화면(자동 보류 칸): "원본 다시 받기 틱마다 N건 · 받는 중 · 끝남(근거 바뀜) · 사람 몫(사유별)" 한 줄, 두 번째 의견 스위치에 "원본 다시 받기 _건/틱" 칸(올리면 사유 필요).
  운영 스크립트: `scripts/ops/set-qwen-auto.ts --step=auditSecondOpinion --recollect-per-tick=N --reason=…`.

## GitHub 한도 영향

- 한 건: 원본 수집 core 1회(저장소 메타) + 별 5~499·배포 주소 없음이면 패키지 확인 1회, README 1회, 스캔 9~12회(스캔 한 단계 상한 12, 운영 24시간 중앙값 9) ≈ **13회**.
- 기본 1건/틱(틱 1분)이면 최대 60건/시간 ≈ 780회/시간. 실제로는 README 잡(2건/5분 = 24건/시간)과 동시 20건 상한이 묶어 **약 24건/시간 ≈ 310회/시간**.
- 538건 전부 ≈ 7,000회. 스캔 소비자는 GitHub 여유 관문(`readGitHubCoreHeadroom`)을, 수집은 rate_limited 일시정지를 그대로 탄다.

## 운영 적용 뒤 예상 (추정, 근거는 위 실측)

- 538건 중 저장소 표본 40/40 존재 → 다시 받기 실패는 많아야 수십 건(0/40 의 95% 상한 ≈ 7.5% ≈ 40건).
- 다시 받은 뒤 두 번째 의견이 묻는다. qwen-v2-auto 전체 의견 6,479건 분포: 승인 28.9%·거절 71.0%(확신 0.90 이상 99.7%).
  주인 있는 것 0, 글 적은 페이지 23건(답은 의견으로만 남고 화면 판별 대기), vision 의견이 있는 23건 중 일부는 엇갈림으로 열림.
- 답으로 닫기(autoClose 켬) 기준: **자동 유지(닫힘) 약 140건, 자동 숨김(보류 — 최종 내리기는 사람 정책 처리) 약 340건, 열린 채 사람 몫 약 30~70건**
  (글 적은 23 + 엇갈림·낮은 확신 + 다시 받기 실패). 즉 538건 중 약 480건이 사람 손 없이 다음 단계(유지 또는 숨김)로 넘어간다.
- 걸리는 시간: 약 24건/시간 → 약 22시간(README 잡이 묶는 속도). recollectPerTick 을 올려도 README 잡 속도 때문에 크게 빨라지지 않는다.

## 배포

- `npm run deploy -- scope --base a9c53498 --sha <head>` → full(18앱 전부, `unclassified_runtime_change`). 마이그레이션 0188 은 새 표만 만들어 **DRAIN 불필요**
  (product_audit_items 로의 외래 키가 그 표에 SHARE ROW EXCLUSIVE 를 잠깐 잡는다 — lock_timeout 5s).
- 배포만으로 켜진다(기본 recollectPerTick 1, 운영 auditSecondOpinion 은 켜져 있음). 새 요청을 막으려면 `--recollect-per-tick=0`.

## 되돌리기

1. 새 요청만 멈추기: `set-qwen-auto.ts --step=auditSecondOpinion --recollect-per-tick=0 --reason=…`(이미 요청한 것은 마무리만 한다).
2. 코드 되돌리기: 이 PR 을 revert 하고 배포. 표는 남겨도 옛 코드가 읽지 않는다(지우려면 `DROP TABLE product_audit_recollects` — 별도 승인).
   주의: 새 코드가 `recollectPerTick` 칸을 저장한 뒤 옛 코드로 돌아가면 옛 코드(strict)는 감사 두 번째 의견 단계를 깨진 것(꺼짐)으로 읽는다 — 되돌린 뒤 그 단계를 다시 저장해 칸을 지운다.
3. 다시 받기 waiting·failed 항목을 두 번째 의견에 다시 돌리려면(사람 결정): `delete from product_audit_recollects where state in ('waiting','failed')` — 운영 쓰기라 별도 승인.

## 남은 일 / 막힌 것

- [x] 원인 확인·재현 시험(`tests/audit-stale-recollect.test.ts`, 통합 `tests/integration/audit-stale-recollect.test.ts`)
- [x] 기존 수집 길 재사용(프론티어·스캔 claim·README 잡), 틱 상한·동시 상한, 실패 → 사람 몫, 근거 바뀜 기록, 감사 화면 상태 줄
- [ ] 운영 배포·관측(이 PR 범위 밖 — 병합·배포 금지). 관측 SQL 은 PENDING.md
- [ ] 공개분 2차 행(published-filter)의 기한 지남은 그대로 쉰다(이 PR 범위 밖)
