# 오케스트레이터 직접 검증 기록 (2026-11-21, 복제본·주 DB 읽기 전용)

## REVIEW-04 상태 조건 (복제본 EXPLAIN ANALYZE)
- 현행 `coalesce(cap.state,'') NOT IN ('waiting','withdrawn','settled')`: Seq Scan, 84,708 버퍼(약 660MB), 357ms, 613행.
- `cap.state IN ('reserved','dispatched')`: Index Scan `model_capacity_requests_active_idx`, 57 버퍼, 0.061ms, 8행 (약 5,800배).
- `IN ('reserved','dispatched','indeterminate')`: 여전히 (Parallel) Seq Scan 97ms — 미확정까지 넣으려면 별도 인덱스·UNION 이 필요. 보호 판정이 미확정을 쓰지 않는다는 점검자 주장과 맞으면 앞의 꼴로 충분.

## REVIEW-01 / REVIEW-14 인덱스 (주 DB pg_stat_user_indexes)
- second_reviews 인덱스는 pkey · (candidate_id,input_hash,model,generation_key) · (status,created_at) 셋뿐 — first_attempt_id·fallback_for_id 인덱스 없음(확인).
- uptime_claims_due_idx(32MB) idx_scan = 0(5.6일) — 한 번도 안 쓰임(확인).

## REVIEW-15 console-alerts (operations_observations)
- job:console-alerts degraded code=console_tasks_unknown, since 2026-11-20T13:54:49Z, detail 「셀 수 없음 · 바꾼 뒤 처리량」, streak 125, 틱 7.4초.
- job:second-review 관측은 2026-11-19 03:41 에 멈춤: all_ranks_unusable since 11-02(「엔진 직접 계약이 없음」).

## DOM-01 (코드 직접 확인)
- lib/me/maker-claims.ts storedRepositoryAnchors: 세 출처 모두 이름당 마지막 값. lib/crawl/repository.ts saveFetchedDocument: 같은 행의 옛 id 와 다르면 비교 없이 onConflictDoUpdate 로 덮음 — 주장과 일치.

## REVIEW-03 (코드 직접 확인)
- lib/jobs/runner.ts 미룸 분기: processedVersion 을 올리지 않고 processed>=1 일 때만 lastSuccessAt. scripts/worker.ts: 미룬 틱은 기본 poll 간격(5초)에 다시 — 주석이 인정.

## CRAWL-03 봇 차단 응답으로 자동 거부된 후보 (복제본, crawl_candidates ⨝ crawl_documents)
- state=rejected · reason=unreachable · decided_by=auto 인 후보의 원본 page_status: 404 15,595 · 0(접속 실패) 2,471 · **403 821 · 401 411 · 429 112**(합 1,344) · 402 620 · 500 201 · 503 116 · 200 69 · 410 52.
- 같은 코드베이스의 가동 확인·감사 경로는 401·403·429·999 를 「살았는지 알 수 없음」으로 본다(`lib/domain/products/health-record.ts:142` `UPTIME_UNKNOWN_STATUSES`). 규칙 판정(`lib/crawl/rules.ts:590-592`)만 400 이상을 모두 거부한다.

## DB-03 / REVIEW-07 / OPS-04 사유 번역 진행 집계 (복제본 EXPLAIN ANALYZE, 2026-11-21)
- `lib/operations/text-stage-progress.ts:156` 가 진행 읽기 TX 에서 `SET LOCAL work_mem = '32MB'` 를 건다 → 해시 한도 64MB.
- work_mem 32MB: HashAggregate Batches 5 · 메모리 65.6MB · 디스크 11.3MB(임시 2,259블록 ≈ 18MB 기록) · 6.82초.
- work_mem 64MB: Batches 1 · 메모리 90.1MB · 디스크 0 · 6.51초.
- 즉 #970(본문 대신 해시로 묶기)은 기본 work_mem 경로(text 워커)의 흘림만 없앴고, 감시·진행 경로는 여전히 호출마다 임시 파일을 쓴다.
- 원천 행: 11-15 40.4만 → 11-21 48.5만(6일에 +20%). 지금 추세면 약 3주 뒤 문장이 10초 상한(`TEXT_PROGRESS_STATEMENT_TIMEOUT.reason`)을 넘고, 기본 경로도 해시 128MB 를 넘어 다시 흘린다.
  감시 계정의 statement timeout 은 이미 하루 875건이다.

## 주 DB 누계 (11-15 09:38Z 재시작 뒤 5.6일)
- 임시 파일 43,727개 · 1,205GB(하루 약 215GB), 교착 13, statement timeout 하루 1만 건(앱 계정)·875건(감시 계정), lock timeout 17건/일.
- idx_scan=0 인 큰 인덱스: products_search_idx 265MB · uptime_claims_due_idx 32MB · product_evidence_sources_due_idx 24MB · product_thumbnail_retry_idx 14MB · agent_scans_due_idx 13MB.

## RUN-09 / STD-06 / RUN-10 운영 DB·PgBouncer 설정 (주 DB 읽기 전용, 2026-11-21)
- 앱 계정의 DB 단위 설정(pg_db_role_setting): `statement_timeout=120s, lock_timeout=5s, idle_in_transaction_session_timeout=120s`. runbook 의 초기값과 같다. TimeZone 은 지정하지 않았다(서버 기본 Etc/UTC).
  → PgBouncer 모드의 모든 프로세스(웹 포함)가 이 한 벌을 쓴다. 웹의 15초 문장 상한 같은 역할별 값은 실리지 않는다.
- 감시 계정: `statement_timeout=10s`, 읽기 전용, 연결 한도 2. Oracle 소비자 계정들: `10s / 5s / 60s`, 연결 한도 5~6.
- PgBouncer: `pool_mode=transaction`, `max_client_conn=1000`, `default_pool_size=20`, `reserve_pool_size=5`, nomorevibe DB 는 `pool_size=40`.
  풀은 (DB, 계정) 쌍마다 하나다 → 같은 앱 계정을 쓰는 웹과 워커가 서버 연결 40개를 나눠 쓴다. 잠금을 기다리는 트랜잭션도 그 연결 하나를 쥔다.
- 주 DB `max_connections=150`, 관측 시점의 nomorevibe 연결 28개(유휴 17).

## DB-14 「안 쓰는 인덱스」 — 복제본 사용 횟수 대조 (2026-11-21)
주 DB 에서 idx_scan=0 인 인덱스도 복제본에서 쓰일 수 있다(공개 읽기는 복제본으로 간다). 복제본의 idx_scan:
- `products_stars_refresh_idx` 3,725,920 — **쓰인다, 지우면 안 된다**.
- `products_search_idx`(265MB) 80 — 드물지만 쓰인다. 사용처를 확인한 뒤 판단.
- `agent_scans_due_idx` 0 · `product_thumbnail_retry_idx` 0 · `uptime_claims_due_idx` 0 · `products_listed_owner_idx` 0 · `product_evidence_sources_due_idx` 1 · `crawl_candidates_state_idx` 10(주 DB 21,350).
