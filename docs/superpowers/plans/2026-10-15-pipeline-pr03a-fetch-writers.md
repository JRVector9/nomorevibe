# PR03a — fetch 소유권과 원자 완료

2026-10-16 KST 진행. [원래 PR03](2026-10-15-pipeline-pr-roadmap.md)의 fetch 단위를 먼저 구현한다. 전체 PR03에는 AI1·입력 controller·legacy drain 인증·replay 인증 통합이 더 필요하다.

## 목적과 범위

기존 수집기는 stage가 items/draining이어도 HTTP를 호출하고, 독립 item owner가 있는 frontier를 legacy recovery로 다시 수집할 수 있었다. 실제 handler/DB 회귀3개로 이 행동을 재현한 뒤 변경한다.

legacy claim은 실제 frontier CAS·job token·stage epoch를, 신규 item claim은 같은 실제 frontier/input에 결합한 필수 item lease를 가진다. mode 변경 또는 role/job 교체가 살아 있는 item을 해제하지 않는다. 네트워크 동안 DB transaction은 유지하지 않는다.

결과 저장·관리자 evidence refresh 요청 소비·item release·필요한 crawl-judge 요청은 같은 transaction이다. 실패·skip·quota 반환·abandoned recovery에도 같은 권한 경계를 적용한다. 기존 pause/backoff/cursor·실패 원인·README 보존·중복 repository 처리·사람 결정 조건을 유지한다.

## 병렬 소유권

| 담당 | 단독 파일 | DB |
| --- | --- | --- |
| AI1 | crawl/repository.ts의 fetch 경로, jobs/fetch.ts, 새 fetch-ownership.ts | 필요 시 자체55470 |
| AI2 | admin-review.ts, 새 evidence-refresh-completion.ts | 필요 시 자체55472 |
| 독립 테스트 | 새 fetch-item-ownership 및 기존 fetch/admin 관련 테스트·fixture | 자체55471 |
| root | items/repository.ts의 readItemStage, 새 pipeline-stage-context, 공유 접점·문서·Git·전체 검증 | 필요 시 자체55473 |

모든 담당은 gpt-6.1-sol/xhigh. 같은 파일을 두 담당이 편집하지 않고 DB도 공유하지 않는다. 담당 종료 뒤 root가 직접/교차 리뷰하고 전체 검증한다.

## 고정 API와 순서

- `readItemStage(tx, guard)`는 이미 획득한 opaque guard의 실제 tx/xid/stage를 검증한다. 반환 state는 소유권이 아니다.
- `lockPipelineInputStages(tx)`는 fetch→ai1→ai2 순차 SHARE 후 `{fetch,ai1,ai2}` guard를 반환한다. 다음은 기존 domain→item→jobs/outbox 순서다.
- `FetchClaim`은 frontier에 legacy/item discriminated ownership을 붙인다. consumer 쓰기에 optional 무권한 fallback을 남기지 않는다. 추가 receipt issuer/WeakMap framework는 도입하지 않는다.
- `lockAdminEvidenceRefreshCompletion(tx, repo, fetchGuard)`는 candidate/document/settings/evidence/scan/request를 frontier/item 이전에 잠근다.
- `applyAdminEvidenceRefreshCompletion(tx, context, {documentFetchedAt?})`는 같은 tx의 실제 source와 현재 candidate를 다시 확인해 기존 요청을 한 번 소비한다. 전달한 시각 자체는 권한이 아니다. 새 domain/job 잠금·자체 transaction·requestJob을 열지 않는다.
- 기존 completion wrapper의 production caller는 agent-evidence-refresh이며 실제 JobLease를 필수로 받는다. fetch는 caller transaction helper를 쓴다.

## 실제 검증과 남은 gate

- [x] 기존 actual runJob/handler에서 items/draining의 HTTP1회, healthy foreign item recovery HTTP1회를 재현했다. actual3FAIL, 1.82초. HTTP transport만 mock이며 DB·handler·recovery는 실제다. `/tmp/nomorevibe-pr03-independent-mode-red-20261015.log`.
- [x] mode/foreign owner 회귀 GREEN, unleased consumer 쓰기 거절.
- [x] actual source·admin 소비·release·요청 중 trigger 실패 시 전체 rollback, duplicate receipt의 요청 증가0.
- [x] stale frontier/job/stage/binding·expiry·late failure/recovery/defer의 쓰기0, quota/실패 의미 보존.
- [x] actual guardread forged/cross-tx/ended 거절, 두 연결의 잠금 순서 확인.
- [x] 기존 fetch/admin unit·DB fixture를 명시 claim으로 변경하고 기대값을 보존.
- [x] 담당 handback→root 직접/교차 리뷰→전체 unit/DB·타입/lint/i18n/Python/build/bundle.
- [ ] 최신base CI/독립 PR 병합과 main CI/image 확인.

PR02는 [PR435](https://github.com/JRVector9/nomorevibe/pull/435)로 main8f2bdb3에 병합됐고 PR/main 전체 CI·image SUCCESS를 확인했다. writers worktree에 실제 merged main을 merge924dfa3으로 통합했다.

담당 actual DB는 신규25 포함71, 기존fixture71, collector wallclock1 PASS다. root unit2,849·tsc/lint/i18n/Python23 PASS, 전체 DB164파일1,804PASS·기존TODO1(349.72초), build/bundle PASS다. 최신base 원격 CI와 PR 납품은 남았다. 요청은 source별로 확정하므로 source3개 성공 시 요청 version3이며 중복 완료0이다. deferFrontier는 receipt별 짧은 tx로 frontier+release를 원자 반납한다. 뒤 receipt 권한 상실 시 앞 반납은 이미 commit됐을 수 있다.

## 열지 않는 경계와 후속 작업

기본 legacy/epoch1/계약0, 신규 consumer 미연결을 유지한다. legacy의 fetching0/running0·job90s TTL·live item0만으로 실제 외부 호출 종료를 인증하지 않는다. durable admission/inflight 종료 계약을 검증하기 전 stage 전환은 fail-closed다. 운영 migration·provider 호출·배포·모델/품질 변경은 이 개발 단계에서 수행하지 않는다.

PR03b에는 README/source controller(setReadmeSample/recordPublishedReadme/refreshTextSample 등), 자동 판정·관리자·설정·발행·AI1 attempt/direct reuse/semantic reuse, B5 stage/item projection·journal·authority/profile 통합이 남는다. PR04는 AI2 composite policy/실제 input·root generation·필수 독립 slot 및 모든 writer를 통합한다. PR01 baseline과 PR05 공통 호출 슬롯 전에는 새 병렬 consumer를 켜지 않는다.

운영 적용 전에는 stage/item 표를 제공하는0077 migration을 선적용하고 exit0를 확인한다. 기본 계약0/consumer 비활성 상태를 그대로 유지하며 이번 단계에서 운영 migration·배포는 실행하지 않았다.
