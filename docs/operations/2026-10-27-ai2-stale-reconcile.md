# 오래된 AI2 재검수 자동 정리·갱신·재등록 — 2026-10-27

현재 입력과 맞지 않는 표가 `input_changed`로 건너뛰어진 뒤 pending에 남았다. 공개 후48시간이 지난 원래 재검수 수요는 신규 enqueue가 다시 집지 않아 대기 시간이 계속 늘었다. 14:23:58 KST 운영 읽기에서 pending76건을 보관했으며, 그중 가장 오래된136522(Nitsuah-Labs/nitsuah-io)는 전날09:51:38 KST 생성됐다. 최근1시간 실제AI2는 agreed16/needs_human9/resolved39로, 전체AI2중단은 아니었다.

## 자동화 흐름

기존 `second-review` 잡이 매분 활성 pending/failed와 이 자동화가 닫은 미완료 수요를 검사한다. 후보ID 커서를 jobs.cursor에 보존해 한 틱에서 최대80후보를 검사하고 최대25후보를 변경한다. 정상 prefix나 재시작이 뒤의 오래된 수요를 계속 막지 않는다.

1. 실제 입력 검증과 일치하지 않는 표를 `resolved/superseded/resolved_by=stale-input-reconciler`로 닫는다. 이전 오류·실패 횟수는 남긴다. 유효한 오래된 fallback 체인의 root도 함께 소유해 새 primary를 가로막지 않게 한다.
2. 원본·최신 탐지 scan이24시간 이내이고 현재 detector와 일치하면 현재 입력 세대로 모델별 한 행을 멱등 생성한다. 공개 후48시간이 지났어도 기존 수요를 이어간다.
3. 근거가 오래됐으면 기존 crawl-fetch와 agent-evidence-refresh 큐를 사용한다. 사이트 재요청 cooldown24시간과 scan 실패 backoff·살아있는 claim을 보존한다. 갱신이 오래 걸려도 원래 수요를 임의 일수로 만료시키지 않는다.
4. 신선한 공개 근거에서 risk/sample 요건이 사라졌거나 자동 공개 요건이 없어졌으면 자동 소유 수요만 `not_required`로 명시 종료한다. 사람 판단·성공 표를 수정하지 않는다.

product→candidate→document/settings/scan/frontier→fetch item→AI2 item→job 순서로 잠근다. 새 frontier 준비가 실제 정리/갱신에 쓰이지 않으면 transaction을 rollback한다. 진행 중이거나 종료가 불명확한 dispatched/indeterminate, 유효·불명확 reservation과 live item은 건드리지 않는다. capacity행을 회수하거나 실제 모델을 종료하지 않는다. secondReview가 꺼지면 이 추가 scan 수요도 공급하지 않는다.

입력이 너무 커 로더가 거부한 후보는 그 transaction을 되돌리고 `crawl.second_review_stale_skipped/input_too_large`를 남긴 뒤 다음 후보로 진행한다. 이 경우 해당 수요를 성공 처리하거나 버리지 않는다. 제한된 replay DB에는 capacity 권한이 없어 신규 live 정리를 건너뛰며, Oracle claim-only 역할의 권한도 넓히지 않는다.

## 검증과 운영 적용

native Grok CLI가 초안을 작성했고 root가 read-only call 사이 SIGINT해 EXIT130으로 넘겼다. 이를 native 최종 성공이라고 기록하지 않는다. 사용자 지정 gpt-6.1-sol xhigh 구현/독립 검토 agent가 수요 보존·fallback·잠금·커서 문제를 보완했고 root가 diff를 검토했다. 사용자 지시에 따라 수동 test/lint/typecheck/build를 실행하지 않았다. `git diff --cached --check`만 실제EXIT0이며 필수 GitHub CI는 별도 증거다.

추가 회귀는 오래된 공개 수요→갱신→최신세대 멱등 생성, 일주일 이후 수요 보존, policy-only 변경, not_required, fallback 이력 보존, 실제 reservation 무변경, unknown binding/route 보호, cursor wrap·기존 cursor 필드 보존을 포함한다. 아직 CI/운영 반영 성공을 주장하지 않는다.

수집 확대는 PR691(main6838889)로 분리했다. 운영 DB pool 명시4·모델·토큰 예산·승인/발행 기준은 유지한다. 실제 배포는 공통 lib 영향의 공식18앱 scope/plan/run으로 진행한다. 최종 main check/이미지 발행만 기다리고 refresh-caches나6시간 관측은 배포 동기 대기에서 제외한다. 과거 once/중단/회수/원복 영수증은 재실행하지 않는다.

정리 건수, 원본·근거 갱신 대기, 최신 세대 등록, 실제 모델 결과를 구분해 읽는다. 기존76행 snapshot과 비교하고 신규 고유 발견/그 신규의 원본 확보를5·15·60분으로 측정한다. 3,000/h는 실제60분 관측 전 달성으로 기록하지 않는다. 저장소 밖 private 상태는 grok-reconcile-discovery-20261027 아래 보존하며 비밀이나 원문 env는 커밋하지 않는다.

## 운영 데이터에서 확인한 SQL 비용 보완

PR692의 운영 적용 뒤 새 stale 힌트가 완료되지 않는 현상을 확인했다. primary READ ONLY로 확인한 실행계획에서 후보별 capacity 이력 Seq Scan이 반복됐으며 전체 추정 비용은574138.10이었다. 이 수치는 실행시간이 아니다. 실제 reviewer의 약95초 실행 중 SQL과 stale 힌트의 실패 기록을 별도로 관측했으며, 잘린 오류에서 SQLSTATE는 확인하지 못했다.

보호 상태의 capacity 행을 MATERIALIZED CTE로 한 번 선별한 뒤 후보별 작업 키를 비교한다. 각 후보 트랜잭션에서는 현재 보호 요청을 다시 조회한다. 미확정 호출·null 예약기한·불명확 AI2 identity 보호, 작업 커서, 락 순서와 모델 설정은 유지한다. capacity 이력이나 호출을 삭제·회수하지 않는다. 새 인덱스나 DB 마이그레이션은 없다.

회귀 코드는 PostgreSQL 실행계획에서 원본 capacity 접근1회와 CTE Scan을 확인하고, 활성·unknown·null 예약기한 및 다른 route의 보호 의미를 비교한다. 로컬 테스트는 실행하지 않았으며 PR의 필수 CI 결과와 운영 후 실제 정리·재등록 결과를 따로 확인한다.

스키마 후속 검토: 요청에 후보/2차 검수 ID를 직접 저장하여 문자열·JSON 비교를 줄이는 방안, 기존 활성 요청 인덱스 재사용, 완료 이력과 현재 처리 목록의 분리다. 이번 복구에 광범위한 스키마 변경은 포함하지 않는다.
