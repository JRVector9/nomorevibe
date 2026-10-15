# PR03d — 남은 maintenance·소개·분류 입력 controller

사용자의 병렬 PR 개발 지시에 따라 root가 세 담당의 파일/API/DB·실제 RED 승인·직접/교차 리뷰·취합/Git을 관리한다. base는 PR03c source1da624d이며 PR03b/03c 실제 main을 납품 전에 통합한다. 기본 legacy/epoch1/계약0 및 신규 consumer 비활성을 유지한다.

## 단독 소유권

| 담당 | production 편집 | 검증 편집 | 자기 loopback DB |
| --- | --- | --- | --- |
| A maintenance | crawl/reconsider.ts, rejudge.ts, duplicate-reconciliation.ts, tidy-catalog.ts, domain/products/name-review.ts | 기존 reconsider-installable/rejudge-stars/crawl-duplicate-reconciliation/tidy-catalog/name-review integration만 | 55485 |
| B 소개·분류 | crawl/taglines.ts, operations/categories.ts, domain/products/intro-editor.ts, intro-requests.ts, intro-checks.ts | 기존 crawl-tagline/intro-requests/text-result-fencing/admin-products-actions/operations-center integration만 | 55486 |
| C 독립 실제 회귀 | production 편집 금지 | NEW integration/pipeline-maintenance-stage-lock.test.ts 및 pipeline-text-input-stage-lock.test.ts | 55484 |
| root | 공통 접점 필요 시 먼저 선언, 문서·Git·전체검증·리뷰 | 최종 통합 | 추후55487 |

모든 담당은 gpt-6.1-sol/xhigh다. 다른 파일·모델·운영·provider·migration·consumer·B5·Git을 변경하지 않는다. AI2 본체 authority와 B5 item certificate/durable external drain은 이 PR 완료로 세지 않는다.

## 구현 계약

- C가 기존 실제 export에서 stage barrier를 우회하는 행동 RED와 정상 control을 먼저 실행한다. A/B는 그 결과와 root 승인 전 production 행동을 편집하지 않는다. import/type/fixture 실패는 RED가 아니다.
- 모든 실제 canonical input mutation은 최상위 짧은 write TX에서 lockPipelineInputStages(tx), 즉 fetch→ai1→ai2 SHARE를 기존 repository/generation/domain보다 먼저 획득한다. mode 독립으로 controller를 허용하며 healthy item/attempt를 조기 해제·회수하지 않는다.
- 기존 snapshot/hash/CAS/정렬/사람·maker 우선/alias·provider cooldown·fetching 보호와 audit/request의 기존 원자성을 유지한다. 단순 순서 보완을 위해 batch 전체 원자화·새 schema·범용 helper/API를 추가하지 않는다. tidy/name은 기존 entry별 CAS를 짧은 S3 TX 안에 둔다.
- worker result는 optional JobLease의 기존 의미를 유지하되 실제 write/outbox 대기가 끝난 뒤 assertJobLeaseAtWallTime을 수행한다. global assertJobLease/withJobLeaseWrite 의미는 변경하지 않는다. manual/hold API의 무lease 의미를 임의 변경하지 않는다.
- transport/CLI/model 동안 DB transaction을 유지하지 않는다. manual tagline 저장 뒤 별도 admin 승인 실패 시 수동 줄을 남기는 기존 의미를 유지한다. 기존 품질 gate·실제 모델/동시성은 변경하지 않는다.
- 기존 foreign rows·jobs/settings를 삭제하는 resetTables로 새 회귀를 격리하지 않는다. 필요한 demand 열만 임시 suspend하고 같은 열만 복원한 뒤 raw to_jsonb 전체 원행을 exact 검사한다. timestamp µs는 raw JSON(::text::jsonb)으로 복원한다. 자신이 만든 fixture/barrier/client만 정리한다.

## 실제 합격 조건

- maintenance reconsider/rejudge+revert/duplicate/tidy/name, tagline result+manual, classification hold+manual, intro editor/request/check의 실제 stage wait를 관측하며 그동안 domain lock/쓰기/요청0.
- items/draining에서도 정상 controller 동작. 실제 입력·사람 결정이 바뀐 stale 계획은 기존 조건대로 거절. healthy logical item/attempt 원본 보존.
- worker 결과의 request trigger 실패 및 실제 job lockwait 중 token 교체/DBclock 만료에서 결과/요청 전체 rollback. 기존 business 회귀를 약화하지 않는다.
- handback 뒤 root 직접/교차 리뷰, 전체 unit/DB/type/lint/i18n/Python/build/bundle와 최신 main 필수CI/별도PR. 실행하지 않은 PASS를 기록하지 않는다.

## 현재 상태

읽기 inventory는 `/tmp/nomorevibe-pr03d-remaining-writer-audit-20261016.md`다. 초기 실제2 RED/control2 PASS 뒤 최소 구현을 승인했다. A 기존26/B 기존45 PASS 및 whole tsc/scopedlint exit0, 두 source 소유권 반환·root/교차 리뷰를 마쳤다. C의 확대29 PASS에는 global LIMIT2000 fixture 실제2 RED→원행 exact 복원의 격리 보강이 포함된다. root unit2,857/전체DB172파일1,947PASS·기존TODO1/type/lint/i18n/Python23/build/bundle exit0. PR438 actual mainaded56e 통합·취소fixture 전체6PASS·자기DB readback/STOP 완료, 별도 PR CI/병합은 남았다. 상세 [실제 검증](../../operations/2026-10-16-pipeline-pr03d-input-controllers-validation.md)을 따른다.
