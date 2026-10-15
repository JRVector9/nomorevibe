# 수집·검수 2배와 세 서버 운영 — PR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 저장소에서는 사용 가능한 `execute-plan` 절차를 적용하고 모든 agent/CLI는 `gpt-6.1-sol` / `xhigh`를 사용한다.

**Goal:** 같은 심사 품질·모델·예산에서 고유 최종 검수량을 2배로 높이고, 세 서버가 같은 종류의 업무를 지원하며 osaka-smoke가 평소에도 실제 번역·등록 후 관리를 수행하게 한다.

**Architecture:** 기존 PostgreSQL 큐를 유지한다. 개별 소유권·결과 fencing·공통 외부 호출 예산을 먼저 만들고 독립 소비자를 활성화한다. Oracle 상시 업무와 DB·모델까지 잃는 최종 재해복구는 서로 다른 합격 조건으로 검증한다.

**Tech Stack:** Node 24, TypeScript, PostgreSQL 17, Drizzle, Vitest, Next.js 16, Dokploy(M3/mini), systemd(osaka-smoke).

---

2026-10-15 사용자가 PR 단위 계획과 실행을 승인했다. **이 문서는 PR 경계와 의존성의 실행 순서표다.**
각 신규 코드 PR은 착수 시 별도 상세 계획에 실패 회귀·완전한 변경 코드·명령을 고정한 뒤 진행한다.
미래 PR의 상세 코드가 이미 구현됐다는 뜻이 아니다. 첫 PR의 실제 실행 절차는
[PR-00 상세 계획](2026-10-15-pipeline-pr00-evidence-progress.md)을 따른다.
설계 근거는 [전체 설계](../specs/2026-10-15-pipeline-two-times-design.md)와
[비교 흐름도](../../design/2026-10-15-pipeline-two-times/index.html)다.

## 운영 중 보존할 조건

- 신규 GitHub/Show HN 발굴 중단, 소개 검수 재개, 검색어 `api-stop`, 사람 판단을 유지한다.
- 기존 근거 catch-up의 deadline·회차·I/O·GitHub reserve를 늘리거나 장부를 초기화하지 않는다.
- X는 `surfguide / ap-osaka-1 / osaka-smoke`의 별도 서비스·UTC 하루10읽기·목적 승인 gate를 유지한다. `onetwoday`로 배포하지 않는다.
- Cloudflare 무료 사용량80% 중단·외부 API/모델/HTTP/원문 크기·SSRF 제한을 유지한다.
- 첫 HTTP 원본 동시성3, AI1+AI2 합4에서 출발한다. gateway 총8은 **새 보수적 배정안**이며 제공자 허용량이나 현재 전체 호출 상한의 실측값이 아니다. 웹 검색의 질의 번역도 공통 예산에 포함한다.
- 승인 임계값·심사 모델·필수 AI2·번역 검증기를 속도 때문에 낮추지 않는다.
- 설치·heartbeat·빈 큐의 성공·다른 host의 `lastSuccessAt`을 실제 업무 완료 증거로 세지 않는다.
- PR 생성/병합, migration, 배포, 실측 성공은 각각 기록한다. main은 최신 base의 CI `check` 성공 후에만 병합한다.

## PR 경계·의존성

정상 검수 처리량의 우선 경로는 **00→01→02→03/04→05→06**이다.
공유 HTTP/등록 후 관리는 **02→07→08/09**, 세 서버 배치는 **05+08+09→10→11**이다.
DR 조사·복원 준비(14)는 이들과 병렬로 진행할 수 있으나 실제 승격은15·16까지 통과해야 한다.
여러 PR을 동시에 개발해도 같은 파일·DB migration 번호·운영 writer는 한 명이 조정한다.

| PR | 결과 / 주요 파일 책임 | 선행 | 반드시 통과할 검증 / 복구 경계 |
| --- | --- | --- | --- |
| **00** | **응답 body 회수·근거 full-page 이어 처리**. `lib/net/fetch.ts`, `lib/jobs/products/evidence-refresh.ts`, 두 회귀 테스트. X·역할·DB 스키마 변경은 제외. | 없음 | oversize/error/redirect의 unread body 취소, cleanup 실패가 원래 결과를 덮지 않음. deadline 경계 continuation·100건 selector·cursor·quota/backoff/abort 보존. migration 없음, 이전 image로 복구. |
| **01** | **측정 기준·격리 replay 장부**. `lib/observability/review-pipeline.ts`, 신규 `lib/operations/pipeline-capacity.ts`, `scripts/report-review-latency.ts`, 신규 `scripts/measure-pipeline-capacity.ts`, 관련 unit/integration. 실행/정책/input-set/시각/모델 identity를 manifest로 고정하고 재시도·표·캐시·실제 최종 완료를 분리. | 00 | 다중 AI2 표/중복 이벤트가 완료량을 늘리지 않음. 승인에 필수 AI2가 없으면 미완료. 규칙 종료·사람 인계·재심사 별도. 모델/분포 불일치·빈 대기·30분 미달은 비교 미완료. 실제 모델 replay는 사전 호출·토큰·시간 상한 안에서만 실행하며 공개 상태를 쓰지 않음. 관측 코드 제거로 복구. |
| **02** | **item lease와 stage mode의 비활성 기반**. 신규 `lib/jobs/items/{types,repository}.ts`, `lib/db/operations-schema.ts`와 `schema.ts` re-export, 신규 additive migration, `tests/integration/item-leases.test.ts`. mode `legacy/draining/items`와 owner/boot/token/epoch/input binding. | 01 | 실제 DB 두 연결의 동시 claim·SKIP LOCKED, 살아 있는 타 owner 유지, 만료 재할당·늦은 저장 거부·heartbeat·원자 handoff·mode 전환 경합. 기본 legacy라 기존 실행 변화 없음. rollback은 claim 중단/drain→새 token 폐기→legacy, 데이터 DROP 불필요. |
| **03** | **원본·AI1 writer를 개별 소유권과 연결**. `lib/crawl/repository.ts`, `agent-review-repository.ts`, `jobs/{fetch,agent-review}.ts`, 신규 item adapter와 integration. | 02 | `recoverAbandonedFrontier`가 다른 살아 있는 item을 되돌리지 않음. 다른 job token이라는 이유만으로 running attempt supersede 금지. 모든 결과/실패/cursor·입력 변경·admin 결정에 현재 token 검사. legacy 경로도 mode 검사. 아직 새 consumer 활성화 안 함. |
| **04** | **AI2의 개별 claim·모든 결과 쓰기 fencing**. `lib/crawl/{second-review,second-review-input}.ts`, `jobs/second-review.ts`, second-review integration. | 02 | vote claim, enqueue/close/retry/orphan sweep/입력 invalidation/admin resolve까지 controller와 item writer 권한을 구분. 새 consumer는 lease 생략 API 사용 불가. 오래된 vote/정책/1차 세대/동일 모델의 승인 저장 차단. legacy 기본 유지. |
| **05** | **모든 gateway 실제 호출의 공통 모델 슬롯**. 신규 `lib/llm/{capacity,capacity-repository}.ts`와 migration. 실제 transport 5곳: `lib/crawl/{agent-review-gateway,translate,tagline}.ts`, `lib/domain/products/{search-profile,search-verify}.ts`; 호출자 `search-translation.ts` 포함. | 02, 03, 04 | provider+underlying model alias 동시 한도·공정 배분, 각 retry/chunk/fallback 직전 획득. 웹의 replica scope에서도 `onPrimary`로 장부 사용. 슬롯 대기는 deferred이며 failureCount/attempt/예비모델 전환을 소모하지 않음. 외부 대기 동안 DB transaction/connection 없음. lease TTL만으로 진행 중 외부 호출 permit 재발급 금지. 기존 동시성으로 drain 복구. |
| **06** | **AI1·AI2·배경의 독립 계속 소비**. 신규 `scripts/pipeline-consumer.ts`, `lib/crawl/consumers/{first,second}.ts`, `scripts/{worker,worker-supervisor}.ts`, reviewer job 및 catalog. | 01–05 | 슬롯이 비면 다음 준비 item 처리, 빈 큐 호출0, graceful shutdown/heartbeat/deadline. audit/intro 몫·fairness 유지. stage drain 후 하나씩 canary. 고정 입력의 같은 품질·한도에서30분 baseline/변경 비교, 준비 대기 고갈이면 성능 미판정. legacy 복귀 절차 실제 시험. |
| **07** | **서버 공통 per-hop HTTP origin permit**. `lib/net/fetch.ts`, 신규 `lib/net/origin-permits.ts`와 migration; shared-fetch unit/integration. | 02 | 매 redirect의 실제 origin/SSRF·DNS 검사, 본문 읽기/취소까지 permit 유지. timeout·abort·stream 실패·worker crash·두 host 경합. `safeFetch`와 `fetchCapped`를 모두 덮고, 활성 호출이 남은 TTL 만료를 안전한 해제로 오인하지 않음. 단일 기존 consumer로 drain 복구. |
| **08** | **근거를 제품이 아닌 출처별로 처리**. `lib/domain/evidence/{refresh,refresh-requests}.ts`, 신규 source claim adapter, `lib/jobs/products/evidence-refresh.ts`, `lib/news/{refresh,repository}.ts`. | 02, 07 | GitHub quota 대기여도 canonical due 처리. source/input/policy CAS, 관리자 요청/정상/catch-up 공정 배분. 캐시없는304·다른 finalURL304·truncated body 성공 금지. 부분 성공을 제품 전체 완료로 기록하지 않음. 새 due canonical10개·공식 due source1개 실제 readback. 기존 product consumer로 drain 복구. |
| **09** | **제품 연결 관측의 멱등·지역 실패 보호**. `lib/domain/products/{health,uptime-auto-ban}.ts`, `lib/jobs/products/uptime.ts`, raw observation schema/migration, uptime integration. | 02, 07 | observationID+6h slot·시각/URL/세대 CAS. Oracle403/timeout·광역망 장애·증거 공백은 machine hold. authoritative counter/checkedAt 보존; 3회 목록 숨김·10회 내림·기존 sweep/최종 commit 모두 보호. 유효10회 감사/CDN은 유지. 원시 관측 canary 후 정책 입력 gate 활성화. |
| **10** | **3서버 선출·번역 역할 분리·실처리 준비도**. `lib/jobs/{catalog,registry,role-leader}.ts`, `scripts/{role-worker,worker-supervisor,worker-healthcheck}.ts`, `lib/db/pool.ts`, `lib/operations/{instance,roles,failover-readiness}.ts`, 번역3종 handler, 관리자 role 표시·deploy helper. | 03–05, 08, 09 | 역할별 M3→mini→Oracle / mini→M3→Oracle / Oracle→M3→mini. 현 유효 owner 비선점, planned drain/만료 뒤 새 epoch. catalog/pool/권한/health/배포를 같은 버전으로 전환. `reason-translate/product-tagline-ko/product-translate`만 분리; `crawl-tagline`·embedding·keyword 별도. host+release+실제 결과 readback canary 없으면 capability unknown. Oracle를 켜기 전 기존 text/maintenance consumer drain. |
| **11** | **osaka-smoke 상시 업무 실제 배포**. 신규 `deploy/oracle/`의 nonroot systemd·release/env template·설치/rollback 도구, `scripts/ops/deploy_shared_images.py`의 명시적 Oracle 지원, 운영 runbook. | 07–10 | 정확한 OCI tenancy/region/instance guard, ARM dependency/CLI·최소권한 인증 SQL·pool/heartbeat·독립 scheduler. 번역 승인 저장, canonical·news 실갱신, uptime raw→gate를 순차 증명. M3/mini 종료 시 생존 DB/모델로 인계, Oracle 종료 시 M3/mini 인계. X/Mautic 백업 보존. 24h 정상 실제 업무 관측. |
| **12** | **발견 구간 분할·원본 공급·시간 버퍼**. `lib/crawl/{discovery-admission,repository}.ts`, seed/HN/fetch jobs, shard cursor schema, integration. | 01–06 | 정규화 dedup·query/window claim·외부 계정 예산 공유. 발견 key 저장량/TTL과24h 입력 신선도 분리. R 실측 전 기존500/1000+hysteresis 유지, 검증 후2h 목표/6h 상한. 부족할 때만 원본3→6 비교. 기존 pause를 자동 해제하지 않음. selector·admission flag로 복구. |
| **13** | **관리자에서 단계·host·적체·예산 확인**. `lib/operations/`의 stage/capability 집계, `app/(operator)/admin/status/`와 관련 API/view, 운영 CLI, UI/unit/integration. | 01, 05–11 | 고유 완료/실제 호출/재사용/표 구분. ready·backoff·human hold·현재 모델슬롯·oldest age·실행 host/lease·epoch·Oracle active/DR 미준비를 구분. 수집·검수·모델 추론 상태를 혼동하지 않음. 관리자 인증/접속과 좁은 화면 실제 검증. 읽기 UI만 되돌려 복구. |
| **14** | **Oracle 전용 logical DR 데이터·실제 복원**. 신규 `scripts/ops/oracle-dr/`의 capacity/backup/restore/replication 검증 도구와 최소권한 SQL, DR runbook. | 병렬 조사 가능, 활성 구성은 용량 검증 후 | PG17 x86→ARM physical WAL standby 금지. 실제 dump 복원→논리 복제의 전용 DB, 모든 table/replica identity·확장·DDL·sequence·large object·증가율/retention 확인. 9GiB DB와 현 여유20GiB가 충분하다고 가정하지 않음. RPO/RTO·누락 작업·사람 결정 대조; 복원 성공만으로 자동승격을 열지 않음. 기존 writer 변경 전 rollback 준비. |
| **15** | **단일 writer 전환·복원 뒤 외부 호출 barrier**. 신규 `lib/operations/dr/{epoch,promotion,call-drain}.ts`, DB/permit adapters와 운영 도구. | 02, 05, 07, 14 | 기존 writer와 독립된 fencing 증거 없으면 승격 차단. 복원 장부의 구 epoch/token 저장 거부. 진행 모델/HTTP 종료 확인 또는 증명된 hard deadline+clock skew까지 새 permit 금지. 시간 한도 불명/제공자 계속실행이면 독립 예산 조정 전 차단. 분할·old host 복귀·중복 발행/내림0. 수동 planned failback, 양방향 DB merge 금지. |
| **16** | **독립 모델·embedding·최소 웹/관리자와 비상 운영**. 승인된 provider 설정, `lib/domain/products/embedding.ts`, `Dockerfile`, `deploy/oracle/`, DNS/tunnel/운영 runbook. | 11, 14, 15 | M3와 독립된 serving/키/DNS·용도별 품질·비용 검증. embedding은 같은 `bge-m3-f16@daec91ff`/1024차원·전처리; 미준비면 정확히 degraded. Oracle1CPU 합계 bounded 예산, DB/제어→번역·연결→기존 승인 발행→준비 검수→근거→신규 순서. 최소 웹/관리자 실제 로그인과 scheduler 포함. 앱/DB/모델 동반 중단·복귀별 RPO/RTO 기록. |
| **17** | **최종 성능·장애·24h 운영 보고**. 신규 `docs/operations/2026-10-15-pipeline-two-times-rollout.md`, README/PENDING/handoff, PR01 측정 도구의 실제 결과. | 06, 11–16 | 같은 모델/품질/입력·30분 구간 최종 고유 완료≥2.0배, p95 악화 없음, 기술 실패≤기준+1%p, 잘못 승인/거절 증가 없음. lease 위반/사람 판단 덮음/중복 발행0. 24h Oracle 상시 업무와 양방향 인계·DB/모델 복구 증명. 검증 안 된 범위는 완료로 올리지 않음. |

### migration·배포·rollback 공통 계약

- 현 마지막 migration은 `0076_korean_tagline_quality_rejections.sql`이다. 새 번호는 PR의 **최신 main으로 갱신한 시점**에 하나씩 배정하고 Drizzle journal/snapshot과 함께 검증한다. 병렬 작업자가 같은 번호를 선점하지 않는다.
- schema 추가는 additive로 시작하고 기본 legacy/disabled를 유지한다. 새 consumer를 켜는 PR은 먼저 기존 claim 중단→inflight drain→mode/token 전환을 테스트한다. producer의 다음 단계 신호는 중단하지 않는다.
- migration이 필요한 PR은 전용 테스트 DB의 재실행·이전 데이터 유지부터 확인한다. 운영에서는 drain→직접 PostgreSQL migration 종료0→한 역할 canary→다음 역할 순서다.
- 권한/배치/역할/관측 schema 버전을 맞춘다. 런타임은 PgBouncer, migration은 직접 연결을 사용한다. 외부 HTTP/모델 응답 중 DB transaction/connection을 점유하지 않는다.
- 실제 배포는 main의 필수 `check`와 고정 SHA image revision/digest 확인 후 한다. M3·mini와 Oracle의 실제 runtime release·DB readback·health를 따로 기록한다.
- rollback은 새 claim부터 멈추고 drain/fence 후 구 consumer를 연다. table 삭제·quota 초기화·실패 기록 삭제·미래 작업 강제 당김을 복구 수단으로 쓰지 않는다.
- 현 공개 웹 검색도 `lib/domain/products/search-translation.ts`→`lib/crawl/translate.ts`로 gateway를 호출한다. reviewer/text만 합산한8을 시스템 전체 현행 최대량이라고 부르지 않는다.

### 공통 모델 슬롯 전환의 누락 방지

- reviewer 합계 예산에는 gateway 이외 `lib/crawl/agent-review.ts`, `agent-review-grok.ts`와 `lib/domain/products/intro-check.ts`의 CLI 호출도 provider별 계약에 맞춰 포함한다. 소개 검수를 gateway 경로라고 잘못 분류하지 않는다.
- 구버전 호출자가 남은 rolling 배포 구간에는 전체 공통 상한이 아직 성립하지 않는다. 모든 caller를 교체하고 기존 외부 호출을 drain한 뒤 새 병렬 consumer를 활성화한다. rollback도 새 consumer 정지가 먼저다.
- `lib/jobs/role-leader.ts`의 role takeover가 기존 job token을 폐기하는 것과 독립 item owner를 같은 생명주기로 묶지 않는다. 정상 role 인계 때문에 무관한 consumer를 중복 실행하지 않게 검증한다.

## PR별 검증 명령

코드 PR의 공통 CI는 `.github/workflows/ci.yml`을 따른다. 변경 경계의 회귀를 먼저 실행한 뒤
타입·lint·전체 unit·해당 DB integration·build를 확인한다. 단순 docs PR은 scope/diff/link 검증만 한다.
테스트 DB 명령은 테이블을 비우므로 운영·개발 DB에 실행하지 않는다.

```sh
npx next typegen
npx tsc --noEmit
npm run check:i18n
npm run lint
npm test
npm run test:integration
DATABASE_URL=postgres://build:build@localhost:5432/build npm run build
node scripts/bundle-size.mjs
python3 -m unittest tests/test_deploy_shared_images.py
git diff --check
```

통합 테스트 기본값은 `localhost:55435/nomorevibe_test`이며 세 CI shard는 서로 다른 DB를 사용한다.
실제 실행 결과만 각 상세 계획·PR·handoff에 적는다. fixture 속도를 인터넷/모델 처리량으로 보고하지 않는다.

## 현재 실행 상태

- [x] 전체 설계와 기존 코드·PR/main 상태 확인, 세 서버·독립 DR 요구를 PR 경계에 배정.
- [x] PR-00용 별도 worktree/branch를 최신 `origin/main`에서 생성하고 X·문서 변경을 제외한4파일을 추출.
- [x] PR-00 전체 검증·부모 diff 검토·원격 [PR #427](https://github.com/JRVector9/nomorevibe/pull/427) 생성.
- [ ] PR-00 필수 CI 확인·병합/배포는 실제 완료 후 기록.
- [ ] PR-01 상세 계획 작성 → 최종 완료 계수의 실패 회귀부터 구현.
- [ ] PR-02–17은 각 선행 합격 후 상세 계획·회귀·구현·검토·PR·migration/배포 증거 순서로 진행.

이번 실행의 첫 결과는 PR-00이며, 최종2배/Oracle DR의 완료를 뜻하지 않는다.

## 자체 검토

전체 설계1–8절을 표의 PR00–17에 대응했다. 웹 질의 번역/replica scope, AI1 `owner_changed`,
frontier 전체복구, AI2의 lease 생략·sweep writer, uptime3/10회·기존 sweep, DR의 외부 호출 barrier를 포함했다.
새 queue 제품·모델 교체·과금 인프라를 임의 도입하지 않는다. 실제 DB/model 생존 검증 전 무손실/자동DR을 주장하지 않는다.
