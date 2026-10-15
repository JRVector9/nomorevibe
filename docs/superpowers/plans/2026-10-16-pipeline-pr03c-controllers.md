# PR03c — 제품·근거 입력의 stage 잠금과 차단 요청 보존

PR03b source07051b0 위 별도 worktree `/Users/jr/Desktop/projects/nomorevibe-pipeline-controllers`에서 구현한다. PR03b 정상 병합 뒤 실제 main을 통합한다. root가 API·소유권·RED 승인·직접/교차 리뷰·전체 검증·Git 납품을 맡는다. 모든 담당은 gpt-6.1-sol/xhigh이며 같은 파일/DB를 공유 편집하지 않는다.

## 파일 소유권

| 담당 | 단독 source | 단독 신규 검증 | 자체 DB |
| --- | --- | --- | --- |
| 제품/발행 | products/repository·takedown·repo-reviews·uptime-auto-ban, crawl/publication-guard·product-audit·product-purpose-cleanup·published-second-review, jobs/products/spam-rescan | pipeline-product-stage-lock.test.ts | 55478 |
| evidence | domain/evidence/agents/repository, jobs/products/agent-evidence-refresh | pipeline-evidence-stage-lock.test.ts | 55479 |
| 요청 보존 | jobs/runner, crawl/repository의 dequeue만, crawl/jobs/fetch·agent-review; 필요한 fetch unit4·AI1 job unit1 | pipeline-blocked-requests.test.ts | 55480 |
| root | 이 문서·검증/delivery/handoff·전체 리뷰/Git. 공통 helper 변경 필요 시 먼저 조율 | 통합 검증 | 추후55481 |

각 담당은 신규 자기 loopback DB만 만들며 운영/provider/Git/migration/B5/consumer 활성화/문서/typegen/build를 변경하지 않는다. 기존 business 테스트를 약화하지 않는다. 외부 fixture를 읽는 전역 handler 테스트는 입력 universe·job 상태를 명시 격리하고 종료 시 원상 복원/검증한다.

## 계약

- 제품/발행·scan·관리자 상태 변경은 mode 독립이다. 최상위 write transaction에서 stage SHARE(fetch→ai1→ai2)를 기존 repository/product generation/domain보다 먼저 획득한다. callback 내부에만 넣거나 이미 잠근 하위 generation helper에 일괄 삽입하지 않는다. 기존 transaction을 받는 status helper는 모든 상위 caller를 닫는다.
- 정상 승인 발행에 이미 release된 AI1 item의 liveness를 다시 요구하지 않는다. full AI2 gate·사람 결정·감사·삭제 재등장 보호를 유지한다. 입력 갱신은 healthy logical item/attempt를 조기 해제하지 않는다.
- scan 저장은 HTTP 밖의 짧은 tx다. 성공 후 실제 candidate reopen이 있으면 judge 요청을 같은 tx에 넣는다. job 권한은 해당 optional 호출 의미를 유지하되 outbox/잠금 대기 뒤 DB wallclock으로 최종 확인한다.
- `dequeueWithAdmission`은 기존 동일 stage tx에서 blocked와 정상 empty를 구분하고 기존 배열 API는 compatibility wrapper를 유지한다. 새 stage_blocked outcome만 runner에서 현재 token CAS 해제하고 requested/processed/cursor/notBefore/성공·실패 이력을 보존한다. 기존 done=false ACK 의미는 유지한다.
- RunResult 새 deferred 상태는 모든 소비자 분기를 읽어 정상 성공/실패로 오집계하지 않는다. 중간 stage block과 healthy foreign owner skip은 구분한다. 새 producer 요청·pause·새 token을 덮어쓰지 않는다.
- runtime 계약0/새 consumer 비활성. preflight 재검사는 실제 외부 종료 증명이 아니다. durable legacy admission과 remote settle/unknown barrier는 별도 후속 단계에 둔다. B5 handlers-v5 legacy-only 경계를 유지한다.

## 실행·검증 순서

- [x] 담당별 독립 actual RED 및 정상 control 실행, root 승인.
- [x] 제품 top tx closure + status 상위 caller inventory, 정상 business 회귀.
- [x] evidence 세 tx closure + direct reopen/outbox actual RED/원자 rollback/wallclock 회귀.
- [x] blocked outcome/typed dequeue + 요청·이력·cursor·pause·producer·token 보호.
- [x] 종료 보고·소유권 반환 뒤 root 직접 리뷰 및 교차 리뷰.
- [x] 최신 main0330a5d 통합, 전체 unit/DB/type/lint/i18n/Python/build/bundle.
- [ ] 문서확정·명시 commit/push와 필수 CI/정상 merge.

초기 실제 결과: 제품7 FAIL/control1 PASS(1.45초), evidence5 FAIL/control4 PASS, blocked4 FAIL/control3 PASS(1.44초). import/fixture 실패를 행동 RED로 세지 않는다.

## Handback·교차 리뷰와 후속 보완 — 16:14 UTC

PR03b fixture66ca2c8까지 fast-forward 통합했다. old ownership의 inactive 기대2건은 실제 deferred 계약으로 유지했다. 해당 파일만 root 자체 stash55a7b08로 잠시 보존 후 apply해 소스 충돌 없이 통합했고 exact hash 확인 후 그 stash만 제거했다. 다른 stash/원본 X branch는 변경하지 않았다.

- 제품 첫 확대18개 및 기존 회귀16파일227 PASS. evidence 담당 최종4파일85 PASS(새15 포함), blocked/기존AI1/runner4파일80 PASS(새16 포함), 관련 unit7파일90 PASS. 각 담당 tsc/scopedlint exit0. source 소유권 반환 후 root와 교차 리뷰를 수행했다.
- 교차 리뷰 actual fetch budget0의 items/draining ACK2 RED/control1→zero-limit admission 확인으로3 GREEN. root full unit277파일2,856 PASS(7.20초)는 이후 제품 walltime 변경 전 결과다.
- evidence 직접 reopen의 outbox 누락·request실패 원자성·outbox wait 중 lease 만료를 각각 RED로 닫았다. foreign제품/후보/jobs/settings은 raw JSON 전체 복원 검사와 hash 전후동일을 확인했다.
- 제품 worker 네 경로와 정상발행은 새 S3/기존 domain 대기 뒤 tx-start now()로 만료된 job을 허용하는 별도7 actual RED/control1를 재현했다. 담당이 좁은 wallclock 검사를 적용 중이며 root는 products.insert의 optional third JobLease와 모든 내부 write/outbox 뒤 마지막 검사, publish actual lease 전달을 맡았다. full AI2 승인 gate는 유지한다. 최종 handback·root DB/static 검증 전이다.
- root blocked fixture에서 DB µs 원본 손실을16 body PASS/teardown FAIL로 재현하고 raw JSON 복원·suspend열만복원으로16 PASS(1.82초), scopedlint exit0 확인. 최종 root fullDB는 자체55481에서 아직 실행 전이다.

최종 source1da624d 동결·마지막 교차리뷰 추가P1/P2없음. 제품 worker expiry 최종10파일150 PASS(새30포함), root 마지막 unit277파일2,857 PASS(9.64초), typegen/tsc/lint/i18n/Python23/build/bundle exit0. 새로운 unused fixture warning은 미사용 snapshot 변수를 삭제한 뒤 scopedlint0으로 정리했다. fullDB는 자체55481에서 session28846 실행 중으로 위 '아직 실행 전'보다 이 현황이 우선한다. 검증 상세 문서와 delivery/handoff는 실제 종료 뒤 갱신한다.

## 다음에 남는 범위

maintenance/reconsider/rejudge/duplicate/tagline/category 및 전체 AI2 writer는 후속 파일 소유권으로 진행한다. B5 item 인증은 별도 PR03d 이후에 projection/journal/receipt authority/strict artifact/고정 item fixture 실행을 나눠 진행한다. 실모델 비용·serving identity/30분 baseline·legacy 종료 증명·2배/Oracle DR은 여전히 미완료다.

## root 최종 검증 확정

source1da624d + publication fixtureb5feaea + actual main merge54b9770에서 전체 DB170파일1,918PASS/기존TODO1(404.28초)을 확인했다. 첫 전체3실패는 enforce 설정 상속/AI1 승인 없는 fixture로31PASS 보완했고, 재실행 ENOSPC는 로그 보존/자체 완료DB만 정리한 뒤 fresh55488로 검증했다. 이후 CI의 공용 취소 scope를 실제1RED→해당6PASS로 닫은 fixture-only commit31c8de3을 추가했다. runner30s/CLI10s/outer45s 및 childclose 대기는 그대로다. 상세 실패·수치·정리·남은 경계는 [검증 장부](../../operations/2026-10-16-pipeline-pr03c-controllers-validation.md)가 최신이다.
