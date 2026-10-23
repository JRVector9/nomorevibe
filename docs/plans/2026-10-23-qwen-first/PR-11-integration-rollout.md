# PR-11 통합 검증 근거와 단계별 운영 전환·중단 절차를 확정한다

상태: **코드 통합 완료 · 정확한 SHA 전체 검사 결과는 [실제 PR11 본문](https://github.com/JRVector9/nomorevibe/pull/638) 참조** · 브랜치: `feat/qwen-first-integration-rollout` · 설계 기준: `c37ae82f`

선행 PR: [PR-01](PR-01-contracts-evaluation.md), [PR-02](PR-02-direct-capacity.md), [PR-04](PR-04-work-uptime-candidates.md), [PR-05](PR-05-uptime-confirmation.md), [PR-06](PR-06-qwen-screen-prompts.md), [PR-07](PR-07-repository-move.md), [PR-08](PR-08-intro-recheck.md), [PR-09](PR-09-exceptions-independent-audit.md). 이 번호는 설계 순번이며 GitHub PR 번호가 아니다.

03은 M1 route 활성화에만 필요하며 GPU 구현의 선행 조건은 아니다.

## 현재 통합 준비 상태

01~11의 범위 구현과 가짜 HTTP/격리 DB 회귀 결과를 모았다. 오프라인 readiness 도구·CLI·운영 runbook은 `980feabe`에서 구현했고 범위 unit 13건·ESLint·Next typegen·tsc를 통과했다. 이는 제출한 manifest의 일관성 검토이며 실제 운영 상태나 산출물의 진위를 독립 인증하지 않는다. 도구의 `productionReady`, `automaticApplyAuthorized`, `mutations`는 항상 false다.

통합 보강 `6c634c6a`는 native 정규화 이후 실제 전송 wire hash를 텍스트/화면 관측에 연결하고 `context_strategy:raw`만 검증 후 제거한다. 다른 값은 거절하고 기존 legacy 호출의 fallback을 보존한다. 별도 범위의 unit13/DB4 결과가 있으며, 이 변경과03 relay·06 shot2/native hook을 최종 통합했고 복구 3건·실제 잠금 경합 3건도 통합했다. 해당 보강 당시의 테스트 타입 오류는 `8a30253f`에서 수정했다. 원래 실패 기록은 보존한다.

실제 운영 M1 설치·caller/alias readback·새 schema의 사람 독립 라벨/실제 모델 비교·운영 정책 승인은 남아 있다. `globalReady=false`를 유지하며, 이를 아래 코드 전체 검사로 대체하지 않는다.

## 최종 통합 기록 위치

| 항목 | 정확한 결과 |
|---|---|
| 통합 SHA | 실제 PR11 본문의 `tested_sha` |
| 실제 PR URL | [#638](https://github.com/JRVector9/nomorevibe/pull/638) |
| fresh migration journal 124개·적용 hash | 실제 PR11 본문·외부 검증 보고서 참조 |
| 전체 unit | 실제 PR11 본문·외부 검증 보고서 참조 |
| 전체 전용 DB 회귀 | 실제 PR11 본문·외부 검증 보고서 참조 |
| build | 실제 PR11 본문·외부 검증 보고서 참조 |
| typecheck·lint | 실제 PR11 본문·외부 검증 보고서 참조 |
| GitHub 필수 CI | 실제 PR11 본문 참조; draft 상태와 필수 check 통과를 구분 |
| 운영 변경 | 미실행: 배포·운영 DB 쓰기·서버 설정·자동 기능 활성화·12건 해제 없음 |

검증 보고서 경로는 `/home/ubuntu/reports/nomorevibe-llm-development-2026-10-23`이다. 소스 SHA를 고정한 뒤 전체 검사를 수행하고 PR 본문·외부 보고서만 갱신한다. 전체 unit/DB/build는 모든 코드·회귀 합류 뒤 정확한 SHA에서 한 번 수행한다. 실패를 고쳐 새 SHA가 생기면 이전 성공을 새 SHA의 결과로 인용하지 않는다. [개발 기록](../../operations/2026-10-23-qwen-first-development.md)과 [운영 전환 runbook](../../operations/2026-10-23-qwen-first-rollout.md)에 범위 검사·실제 모델 비교·운영 실행을 나누어 남긴다.

## 문제와 결과

코드 PR·단문 모델 평가·CI 성공만으로 장비 공통 슬롯, 실제 M1 경로, 다중 역할 경합과 운영 적용의 준비 상태가 보장되지 않는다.

정확한 통합 SHA의 검증 결과, 실제 환경 확인 항목, 승인받을 실행 계획과 중단·되돌림 절차를 묶은 문서 PR을 만든다. 실제 배포 실행을 이 PR의 병합 효과로 만들지 않는다.

## 수정 범위

- 본 차수 핵심01·02·04·05·06·07·08·09 구현 완료 후 정확한 통합 SHA에서 수동 전체 unit/전용 DB/종합 검증을 한 번 수행한다. 10이 같은 차수로 확정되면 10까지 포함한 뒤 수행한다.
- 단건·혼합 작업 부하에서 GPU/M1 슬롯, M3 공유 자원, 원격 종료 불명 상태, 큐 대기·p95·성공·기권·상향 비율을 분리 보고한다. 설정 동시6을 처리용량으로 환산하지 않는다.
- 실제 활성 caller/alias/물리 endpoint와 전역 capacity open 준비를 대조한다. 신규 local 경로만 연결한 채 기존 미연결 작업을 멈추게 하는 global open 전환은 거절한다.
- 코드·설치물 검토 → 승인된 migration/사설 ingress/배포 → 제한 shadow → 실제 근거 검수 → 승인된 적용 → 작은 과거 적체 순으로 운영 실행 계획을 만든다. 실행 결과는 실행 뒤 별도 기록한다.
- 신규 잡은 scheduler(git 빌드) 선배포 후 등록 확인, 공통8앱, text/maintenance 등 git 빌드 소비자 순서를 따른다. 각 역할은 mini 예비→M3 주, 현재 runbook의 기본 순차 방식으로 한다.
- PR마다 scope 회귀·정적 검사를 수행하고 GitHub 필수 CI는 유지한다. 이 문서 PR이 전체 테스트를 매번 중복 실행하게 만들지 않는다.

## 포함하지 않는 변경

- 배포·운영 DB 쓰기·자동 적용 활성화의 자동 승인
- 현재 정상인 12건의 차단 해제
- 뉴스 제품 결정을 core 일정에 강제
- 롤백을 위해 pending을 legacy 직접 내림으로 전환

## 파일과 데이터 변경

기존 파일:

- [AGENTS.md](../../../AGENTS.md)
- [README.md](../../../README.md)
- [docs/operations/independent-workers-runbook.md](../../../docs/operations/independent-workers-runbook.md)
- [docs/operations/2026-10-22-worker-monitor-rollout.md](../../../docs/operations/2026-10-22-worker-monitor-rollout.md)
- [scripts/ops/deploy_shared_images.py](../../../scripts/ops/deploy_shared_images.py)
- [lib/operations/admin-job-control.ts](../../../lib/operations/admin-job-control.ts)

신규 제안 파일:

- `docs/operations/<implementation-date>-qwen-first-validation.md` (신규 제안 경로, 구현 시 확정)
- `docs/operations/qwen-first-rollout.md` (신규 제안 경로, 구현 시 확정)

Migration: 없음. 앞선 코드 PR이 추가한 migration의 SHA·journal·적용 상태와 호환성을 확인한다. 실제 번호는 구현 시 최신 main의 journal을 확인해 배정한다.

## 검증과 완료 조건

다음은 실행 결과가 아닌 구현 시 검증 항목이다. PR별로 관련 회귀·정적 검사만 수행하고 GitHub 필수 CI를 유지한다.

- 완성된 정확한 통합 SHA의 전체 검증. 통합 테스트는 전용 DB이며 필요한 직렬 ledger 순서를 따른다.
- 관련 새 잡에 catalog/registry/stage/JOB_HOW/attention.work와 stop/resume 의미가 모두 연결됐는지 확인
- fake remote 장시간 실행·client abort·재시작·주/예비 인계·DB 응답 분실·오래된 결과를 통합 재현
- 실제 환경 모델 호출/배포/쓰기 검증은 승인된 실행 단계에만 수행하고 측정 전에는 미실행으로 기록

완료 조건:

- 정확한 SHA·dataset·모델/endpoint revision·prompt/schema·명령/결과·관측 한계가 함께 남는다.
- 계획·CI·실제 배포·자동 적용·과거 적체 처리를 서로 다른 상태로 보고하며 실행 가능한 중단 절차가 있다.
- GPU 우선 단계와 GPU+M1 분산 단계의 준비 상태를 따로 기록한다. 03과 실제 M1 공동 처리 검증이 남으면 GPU 단계만 준비됐다고 보고하고 최종 분산 도입 완료로 세지 않는다.

## 적용 전 확인

- 인수인계 문서의 운영 변경 승인 조건을 유지한다. 이 설계/코드 PR의 병합은 설치·migration·배포·자동 조치·12건 복구의 승인으로 세지 않는다.

## 중단과 되돌림

- 새 생산·admission·자동 적용을 각각 멈추고 원격 호출 drain/정산·pending 보존을 확인한다. 후보 게이트를 모르는 구형 코드로 돌아가야 하면 자동 내림을 먼저 멈추고 별도 계획으로 진행한다.

공통 정책·실데이터 평가·운영 전환 조건은 [전체 계획](README.md)을 따른다. PR 병합을 운영 쓰기·배포·기능 활성화 승인으로 간주하지 않는다.
