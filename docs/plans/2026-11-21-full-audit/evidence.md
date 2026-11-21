# 실측 근거 (2026-11-20 ~ 21, 운영 읽기 전용)

계획의 우선순위는 이 실측에서 나온다. 모두 읽기 전용으로 받았고, 운영 설정·데이터는 바꾸지 않았다.
원본은 `evidence/` 에 있다(구역 문서가 `파일:줄` 로 가리킨다 — 줄 번호가 맞도록 고치지 않고 실었다).

| 파일 | 무엇 | 범위 |
| --- | --- | --- |
| `evidence/slow-queries-primary.txt` | 주 DB 에서 0.5초 넘은 문장을 모양별로 묶은 것(횟수·합계 초·평균·최대·본 시간 수·계정·문장)과 DB 오류 집계 | 2026-11-20 01:18Z ~ 23:53Z, 약 23시간 |
| `evidence/pg-stats-primary.txt` | 표별 seq scan·읽은 행, 안 쓰는 큰 인덱스, 연결, 설정, 임시 파일·교착 누계 | 11-15 09:38Z 재시작 뒤 약 5.6일 누계 |
| `evidence/pg-stats-replica.txt` | 복제본의 seq scan·연결·충돌 | 복제본 통계 창 |
| `evidence/indexes-primary.txt` | 주요 표의 실제 인덱스 정의·크기·사용 횟수 | 같은 누계 |
| `evidence/jobs.txt` | 잡별 실행 수·마지막 실행·마지막 성공 | 11-20 23:55Z |
| `evidence/crawl-stats-replica.txt` | frontier·후보 상태 분포, 수집 실패 사유, 페이지 상태 코드, 1차 심사 결과, 장부 상태 | 11-20 23:5xZ |
| `evidence/web-timing.txt` | 공개 URL 응답 시간(curl, 캐시 MISS 포함) | 11-20 23:5xZ |
| `evidence/orchestrator-checks.md` | 오케스트레이터가 주장을 직접 재확인한 EXPLAIN·집계 | 11-21 |

느린 문장 기록은 주 DB 의 `log_min_duration_statement=500ms` 로그에서 나왔다. **0.5초 미만 문장은 보이지 않는다** — 자주 도는 0.1~0.4초 문장의 합은 이 표에 없다.
`pg_stat_statements` 가 설치돼 있지 않아 문장별 전체 통계는 없다(계획 W0-2).

## 1. 느린 문장의 시간이 가는 곳

23시간 동안 0.5초 넘은 문장 **79,854건, 합계 122,850초(약 34시간)**. 모양 64개를 원인별로 묶으면:

| 묶음 | 합계 초 | 비율 | 횟수 | 평균 | 계획 |
| --- | ---: | ---: | ---: | ---: | --- |
| 모델 장부 control 한 행의 잠금 **대기**(`FOR UPDATE`·`FOR SHARE`) | 36,184 | 29.5% | 35,141 | 1.0초 | W2 |
| 발행 대기열(승인 후보 전체에 관문 술어 재평가) | 34,309 | 27.9% | 12,377 | 2.8초 | W1-2 · W1-3 · W3-1 |
| 사유 번역 진행 집계(사유 48만 행을 매번 해시) | 19,651 | 16.0% | 4,251 | 4.6초 | W1-5 · W3-2 |
| 2차 심사 낡은 표 힌트(장부 전체 seq scan) | 10,293 | 8.4% | 1,418 | 7.3초 | W1-1 · W1-3 |
| 판정 대기열(원본 107만 행 ⨝ 후보) | 8,871 | 7.2% | 10,220 | 0.87초 | W3-3 |
| uptime 장부 readback(진행 집계의 일부) | 4,160 | 3.4% | 7,281 | 0.57초 | W1-4 |
| 위임 검수 후보 고르기 | 2,572 | 2.1% | 1,293 | 2.0초 | W3-4 |
| jobs·role_leases 행 잠금 대기 | 2,151 | 1.8% | 2,339 | 0.92초 | W1-6 · W1-7 |
| 장부 쓰기 문장 자체 | 1,002 | 0.8% | 1,824 | 0.55초 | W2 |
| 그 밖 36개 모양 | 3,657 | 3.0% | 3,710 | — | 구역 문서 |

위 다섯 줄이 89% 다. 두 가지 성격으로 나뉜다.

- **잠금 대기 약 31%** — 일을 하는 시간이 아니라 줄 서는 시간이다. 장부의 전역 한 행, 잡 행, 역할 lease 행.
- **「할 일이 있나」를 이력에서 매번 다시 계산 약 65%** — 대기열·진행률을 상태 표가 아니라 전체 이력 훑기로 구한다. 게다가 일정보다 훨씬 자주 돈다(아래 3).

## 2. 표 통계 — 전체 훑기

5.6일 누계에서 seq scan 으로 읽은 행이 많은 표(`evidence/pg-stats-primary.txt`):

| 표 | 크기 | 행 | seq scan 횟수 | 읽은 행 | 1회 평균 |
| --- | ---: | ---: | ---: | ---: | ---: |
| model_capacity_requests | 2.5GB | 51만 | 176만 | 5,654억 | 32만(=거의 전체) |
| crawl_candidates | 862MB | 106만 | 140만 | 3,370억 | 24만 |
| crawl_documents | 3.5GB | 107만 | 106만 | 2,328억 | 22만 |
| crawl_frontier | 344MB | 107만 | 60만 | 1,278억 | 21만 |
| pipeline_item_leases | 74MB | 7.8만 | 189만 | 1,191억 | 6.3만 |
| second_reviews | 212MB | 20만 | 134만 | 1,179억 | 8.8만 |
| crawl_review_attempts | 1.8GB | 36만 | 63만 | 756억 | 12만 |
| products | 1.4GB | 11.5만 | 98만 | 585억 | 5.9만 |

작은 표인데 호출 수가 지나친 것: `second_review_workload_assignments`(2,359행) seq scan 2,066만 번·인덱스 탐색 56.6억 번, `product_audit_campaigns`(0행) seq scan 1,391만 번.

그 밖의 누계: 임시 파일 43,727개·**1,205GB**(하루 약 215GB), 교착 13건, HOT 갱신 비율 — `products` 0.3%·`model_capacity_requests` 0%·`uptime_claims` 0%.
한 번도 쓰이지 않은 큰 인덱스: `products_search_idx` 265MB, `uptime_claims_due_idx` 32MB, `product_evidence_sources_due_idx` 24MB, `product_thumbnail_retry_idx` 14MB, `agent_scans_due_idx` 13MB.

## 3. 잡 실행 수 — 일정보다 자주 도는 잡

`evidence/jobs.txt`. `second-review` 는 일정이 60초인데 누계 208,583회(10-25 이후만 쳐도 평균 약 11초 간격)이고 마지막 성공 시각은 10-25 에 멈춰 있다.
미룬(deferred) 틱이 요청을 인정하지 않아 5초 poll 마다 다시 도는 탓이다(구역 문서 REVIEW-03 · RUN-06). `crawl-publish` 의 2.8초 쿼리가 하루 12,377회인 것도 같은 까닭이다(5분 일정이면 288회).

## 4. DB 오류

| 건수(23시간) | 계정 | 메시지 |
| ---: | --- | --- |
| 10,383 | 앱 | canceling statement due to statement timeout |
| 875 | 감시(monitor) | canceling statement due to statement timeout |
| 17 | 앱 | canceling statement due to lock timeout |
| 1 | 앱 | deadlock detected |

로그에 문장 본문이 붙지 않아 어느 문장이 끊겼는지는 이 자료로 확정하지 못한다(W0-2).

## 5. 수집

`evidence/crawl-stats-replica.txt`.

- 후보 106만 중 `rejected / no_homepage` 78.8만, `published` 11.5만.
- frontier `failed` 1,693 — 「HTTP N」 964, 「fetch failed」 433, 타임아웃 292. 모두 시도 4회에서 멈췄다.
- `rejected / unreachable(auto)` 2.06만 가운데 원본 상태가 **403 821 · 401 411 · 429 112**(합 1,344) — 봇 차단 응답이다(`evidence/orchestrator-checks.md`).

## 6. 공개 웹

`evidence/web-timing.txt`. 원 서버 응답은 캐시 MISS 에서도 TTFB 0.17~0.38초다. 공개 화면의 느림은 원 서버 계산보다 **요청마다 주 DB 로 가는 부수 문장**(rate limit·바인딩 확인)과 엣지 경로 쪽이다(구역 문서 web-public, 2026-11-11 프론트 병목 실측).
`sitemap.xml` 은 이 측정 위치에서 403 이었다 — 원 서버가 아니라 엣지가 낸 응답이다(WEB-07, 확인 필요).

## 7. 오케스트레이터가 직접 확인한 것

`evidence/orchestrator-checks.md` 에 전문이 있다. 요점:

- 상태 조건을 `coalesce(state,'') NOT IN (…)` 에서 `state IN ('reserved','dispatched')` 로 쓰면 장부 조회가 **357ms(전체 seq scan, 660MB) → 0.06ms**(기존 부분 인덱스).
- `second_reviews` 에는 `first_attempt_id`·`fallback_for_id` 인덱스가 없다. `uptime_claims_due_idx`(32MB)는 사용 0회다.
- 사유 번역 진행 집계는 `SET LOCAL work_mem='32MB'` 아래에서 돈다 → 호출마다 임시 파일 약 18MB. 원천 행이 6일에 20% 늘어(40.4만 → 48.5만) 지금 6.5~6.8초, **약 3주 뒤 10초 상한을 넘는다**.
- `console-alerts` 는 `console_tasks_unknown`(「셀 수 없음 · 바꾼 뒤 처리량」)으로 11-20 13:54Z 부터 매 틱 degraded.
