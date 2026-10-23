# PR-05 비동기 uptime 재접속·Qwen 확인과 최종 적용

상태: **설계 완료 · 구현 전** · 제안 브랜치: `feat/qwen-first-uptime-confirmation` · 설계 기준: `c37ae82f`

선행 PR: [PR-01](PR-01-contracts-evaluation.md), [PR-02](PR-02-direct-capacity.md), [PR-04](PR-04-work-uptime-candidates.md). 이 번호는 설계 순번이며 GitHub PR 번호가 아니다.

03은 M1 route 활성화에만 필요하며 GPU 구현의 선행 조건은 아니다.

## 문제와 결과

느린호스팅·일시장애와 실제종료·파킹·soft404를 HTTP코드만으로 구분하지 못한다.

입력은04후보와수집스냅샷,출력은page_state/evidence_quality/evidence/action이다. 서버가enum·인용·세대·정책을검사하고최종setStatusWithAudit와두감사를원자적으로쓴다. LLM에는DB쓰기권한이없다.

## 수정 범위

- 04 후보를별도consumer가수집→상태판정→서버검증→최종적용한다.
- GPU Qwen 우선, M1은화면근거·시간여유있는재확인에사용한다. 충분한증거의의미충돌만DeepSeek 예외큐로보낸다.
- 상태·근거품질·조치제안과원문근거id/인용을저장하고,최종적용직전제품세대·URL·관리자해제·최신health·lease를재검증한다.
- 재접속실패·체크포인트·잘림은추가수집/보류로보내며모델closed로대체하지않는다.
- 공통 소비자 job 제안명은 product-llm-assist-review, reviewer의 별도 assist lane이다. GPU/M1 backend별 bounded drain이 같은 큐를 소비하며 기존 main/screen 작업과 물리 공통 슬롯을 공유한다. 새 lane은 기존 잡 시간 한도를 늘리지 않는다.
- PR03 전에는 GPU만 선택한다. PR09 전의 충분한 근거 충돌은 사람/대기 상태로 보존하고 동기 DeepSeek 우회를 넣지 않는다.
- alive/unclear는 product_health를 LLM 답변으로 위조하지 않는다. 정식 새 관측과 처리 revision을 구분해 동일 실패 관측의 반복 후보화를 막는다.

## 포함하지 않는 변경

- uptime-ping의25초연장
- timeout·큐대기를DeepSeek로일괄우회
- 실패횟수·시간제한·관리자보호완화
- 현재12건차단해제

## 파일과 데이터 변경

기존 파일:

- [lib/domain/products/uptime-auto-ban.ts](../../../lib/domain/products/uptime-auto-ban.ts)
- [lib/domain/products/uptime-negative-gate.ts](../../../lib/domain/products/uptime-negative-gate.ts)
- [lib/domain/products/generation.ts](../../../lib/domain/products/generation.ts)
- [lib/net/fetch.ts](../../../lib/net/fetch.ts)
- [lib/screen-review/](../../../lib/screen-review)

신규 제안 파일:

- `lib/jobs/products/uptime-delist-review.ts` (신규 제안 경로, 구현 시 확정)
- `lib/domain/products/uptime-delist-review.ts` (신규 제안 경로, 구현 시 확정)

Migration: 04의공통원장·task payload를사용하면추가migration없음. 기존product_health·uptime gate의보호컬럼은재사용하며정식관측을LLM의견으로변조하지않는다. 실제 번호는 구현 시 최신 main의 journal을 확인해 배정한다.

## 검증과 완료 조건

다음은 실행 결과가 아닌 구현 시 검증 항목이다. PR별로 관련 회귀·정적 검사만 수행하고 GitHub 필수 CI를 유지한다.

- tests/integration/uptime-auto-ban.test.ts
- tests/integration/uptime-split-apply.test.ts
- tests/operations-work-owners.test.tsx
- tests/stage-registry.test.ts
- 신규: active제품의오류키워드·soft404·영구종료·주차·warmup·stale결과·동시관리자해제·재시작중복적용
- GPU drain이 대기 중인 M1/후속 DeepSeek와 직렬화되지 않음, deadline·공정성·기아 방지, 같은 입력 중복 호출/적용 없음
- dispatch/apply 중단·consumer pause·배포 rollback에서 confirm gate를 우회하는 legacy 자동 내림 0

완료 조건:

- 모델응답후URL/관측이바뀌면적용하지않는다.
- unclear·증거검증실패·기한초과는자동내림하지않는다.
- 재접속·모델시간과대기시간을구분하고원래uptime-ping25초예산을유지한다.
- 새 job 또는 실행 줄을 추가하면 lib/jobs/catalog.ts, lib/jobs/registry.ts, scripts/worker.ts의 등록·시간 예산·lane 및 역할별 DB 풀/host budget을 같이 검토한다.
- lib/operations/stage-registry.ts의 단계 또는 제외 사유, app/(operator)/admin/status/work-owners.ts의 JOB_HOW, attention.tsx의 work 연결을 함께 맞춘다.
- tests/job-catalog.test.ts, tests/stage-registry.test.ts, tests/operations-work-owners.test.tsx와 관련 운영센터 회귀를 실행한다.
- 기존 admin-job-control의 legacy/versioned/draining 지원 범위를 따른다. pause가 신규 claim을 멈추는지, 진행 중 원격 호출·pending·capacity 점유가 어떻게 drain되는지 표시·회귀 검증한다. 실제 계속 도는 소비자를 멈춤으로 표시하지 않는다.
- 원 업무(originJob/task) pause도 공통 소비자의 해당 queued work에 적용한다. claim/dispatch 확정 시 제어를 확인하고, 다른 업무·이미 in-flight 호출·resume 동작을 별도로 회귀 검증한다.
- backend와 기반 모델 정체성을 구분해 GPU/M1의 용량은 따로, 같은 Qwen family의 독립 감사 자격은 같게 판정한다.

## 적용 전 확인

- 실제현재정상/종료/파킹/soft404/차단·지연사례를사람이현재근거로독립라벨링한다. 살아있는제품오내림,기권·추가수집,처리시간·적체를측정한다. 자동적용허용기준은실측후승인하며임의숫자를정하지않는다.

## 중단과 되돌림

- 확인consumer와최종적용을중지하고후보·근거를보존한다. 제품복구는자동으로하지않고감사이력으로되돌릴대상을검토한다.

공통 정책·실데이터 평가·운영 전환 조건은 [전체 계획](README.md)을 따른다. PR 병합을 운영 쓰기·배포·기능 활성화 승인으로 간주하지 않는다.
