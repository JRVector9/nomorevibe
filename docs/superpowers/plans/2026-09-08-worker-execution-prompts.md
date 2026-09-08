# 독립 워커 구현 실행 지시문

2026-09-08 사용자 실행 승인. 이 문서는 PR 계획의 반복 테스트 순서보다 최신 사용자 지시를 우선한다.

## 공통 프롬프트

현재 프로젝트의 기존 잡/큐/후보 상태/발행 트랜잭션을 유지하면서 지정된 PR 범위를 구현하라.
기준 설계와 PR 계획은 이 디렉터리의 independent-workers 문서를 읽는다. 새 범용 큐/Redis/정책 변경은 금지한다.
할당 worktree 안에서만 수정하고 다른 담당 파일, 공통 스키마 export, migration journal, package lock,
Compose, handoff는 담당 조정자에게 요청한다. 기존 사용자 미커밋 작업을 복사하거나 되돌리지 않는다.

사용자는 중간 테스트로 개발이 지연되지 않기를 명시했다. 구현 중에는 타입/입출력 계약과 요청 유실,
오래된 소유권 쓰기, 중복 발행 등 핵심 결함 확인에 꼭 필요한 작은 검사만 실행한다.
전체 단위/통합/E2E/빌드/이미지/실제 후보/운영 검증은 A/B의 큰 작업 완료 후 조정자가 모아 실행한다.
실패하면 원인을 수정하고 영향받는 검사만 재실행한다. 미실행 검사를 성공으로 기록하지 않는다.
통합 DB를 임의 실행하거나 실제 개발/운영 데이터를 초기화하지 않는다.

완료 시 자기 파일만 커밋하고 SHA, 변경 파일, 공개 함수/타입, 실행한 검사, 남은 위험을 보고하라.
독립 검토 요청을 받으면 다른 담당 구현을 읽고 구체적인 재현 조건과 파일 위치를 보고하라.

## A 공통 인터페이스 (조정자 소유)

- `lib/jobs/catalog.ts`: `JobRole = 'crawler'|'reviewer'|'publisher'|'maintenance'`,
  `JOB_NAMES`, `JOB_CATALOG`(name/role/intervalMs), `jobsForRole(role)`, `isJobName(name)`.
- `lib/jobs/control.ts`: `requestJob(name, tx?) -> {job, status:'queued', requestedVersion:number}`;
  `requestDueJobs() -> number`; `markWorkerSeen(names:string[])`; `markSchedulerSeen()`;
  `pendingJobNames(role:JobRole) -> string[]`.
- `runJob(name, handler, {budgetMs?, requestedOnly?, signal?})`의 기존 형태 유지.
  요청을 소비하는 worker는 requestedOnly:true. 기존 수동 실행은 기본 한 tick이며 동일 소유권 검사 사용.
- `JobContext.lease?: JobLease`, `JobLease={name:string,token:string,requestedVersion:number}`;
  `assertJobLease(tx, lease)`를 최종 도메인 트랜잭션에서 사용할 수 있게 한다.
- 요청 실행 중 새 version은 보존. done=false 성공도 captured version 처리, cursor 유지.
  heartbeat 15초/stale 10분, 실패 재시도 대기, 오래된 token의 save/완료/해제 금지.
- ranking의 정기 요청은 rollup done=true 성공 완료 트랜잭션에서만 생성한다.

## 담당 프롬프트

### 실행기 담당 — PR 02

scripts/worker.ts, scheduler.ts, run-job.ts, evidence-worker.ts, scheduler.sh 및 해당 작은 단위 테스트만 구현하라.
위 control API로 역할별 순차 poll, scheduler 10초 tick, SIGTERM drain/pool 종료를 구현하라.
supervisor와 연결할 IPC 생존/현재 잡/처리 시작 시각 신호를 지원하되 자체 외부 호출은 하지 않는다.
CLI once/interval 기존 사용을 보존하라. catalog/control/runner/package/Compose/migration은 수정하지 말라.

### 수집 담당 — PR 03

github-quota.ts, github.ts, jobs/fetch.ts, jobs/seed.ts와 꼭 필요한 repository의 frontier 대기 helper를 구현하라.
기존 rate_limits namespace에 token digest/resource별 primary와 credential 전체 secondary 대기를 저장하라.
조건부 요청/크기 제한/timeout 유지, 늦은 Retry-After/reset 준수, fetch 재개 시각 반영,
frontier 10000/5000 적체 탐색 양보와 cursor 보존. 기존 방문 제한의 의미를 바꾸지 말라.

### 근거 담당 — PR 04

product-evidence-schema.ts에 product_refresh_requests, refresh-requests.ts, maker.ts/refresh.ts/
jobs/products/evidence-refresh.ts의 최소 변경으로 관리자 force 예약·부분 재개를 구현하라.
requestJob은 조정자 API를 사용하며 request/감사/신호를 원자 저장하라. 정상 maker 202/한도 보존,
최근 관측 미디어 force, URL/revision 진행점, 재요청/version/제품 세대/쿼터 대기를 보존하라.
schema.ts export/journal/SQL migration은 수정하지 말고 schema 변경을 보고하라.

## 통합/운영 담당 — 주 조정자

PR 01 공통 기반, migration 순서, PR 05 웹 경계, PR 06 이미지/운영을 통합한다.
이후 B 계약을 먼저 확정하고 리뷰 실행/발행 보호를 병렬 배정한다. 서로 다른 worktree의 DB 시험을 직렬화한다.
서버는 현재 상태를 확인한 뒤 기존 서비스와 데이터 보호 범위 안에서 적용한다. 중간 PR 상태를 운영에 배포하지 않는다.
큰 단계 후 전체 검증과 독립 코드 리뷰, 실제 10개 표본, 운영 관측을 수행하고 증거와 미완료를 구분해 보고한다.
