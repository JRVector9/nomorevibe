# PR04a — AI2 입력·소유권 기반 검증

## 목적과 범위

AI2 pending vote를 실제 현재 원본·first/root·설정과 결합하고, generic0077 item owner를 사용하는 비활성 adapter를 제공한다. existing writer/handler의 필수 receipt 전환은 PR04b, item 실행 lifecycle은 PR04c다. 이 기반만으로 AI2의 모든 기존 쓰기 fencing이 완료됐다고 해석하지 않는다.

root가 gpt-6.1-sol/xhigh 담당3명의 배타적 파일·DB·공통 API를 확정했다. A source/input·ownership·자체 회귀, B 독립 domain unit/DB proof, C 기존 handler 독립 RED와 읽기 리뷰를 맡았다. root는 typed published source와 공통 fixture, 직접/교차 리뷰·전체 검증·Git·문서를 맡는다. [실행 계획](../superpowers/plans/2026-10-16-pipeline-pr04a-ai2-authority.md).

## 동결된 변경

- second-review-input: 실제 candidate/document/first ID, first confidence·모델, trigger/input, exact fallback root를 확인한다. 새 domain loader가 S3 뒤 published lifecycle/product→candidate→document/settings/evidence/first→vote를 잠그고 actual productId를 반환한다. 기존 읽기 API 유지.
- new second-review-ownership: composite policy, 실제 원행 identity와 binding, legacy admission observation, item claim/renew/assert/finish, chain owner 보호. legacy private invalidation은 같은 TX 안에서 job 및 nondeferred recorder 대기 뒤 DB wallclock을 재확인한다.
- lib/jobs/items/types: published source는 slug와 positive-safe productId를 필수로 저장한다. 같은 workKey는 유지하고 재등록 제품은 bindingHash가 달라진다. JSON 계약 보강이며 DDL은 없다.
- 신규 unit2파일 및 integration2파일. 기존 pipeline-item-types와 review-replay-context의 정상 fixture만 보강한다. clock/잘못된 firstAttempt 거절 등 기존 assertion 유지.

소스 동결 SHA256: input `5bcf9d2bf3c3b2b356667ce3d731c1afea153db4d1c4da727f47ceba3f58b314`, ownership `247050f275c401ad6cca11c47d8da740a471a43b0300226646b6ffafad3093a9`. 자체unit `90aa7d92beeb69135c6f9eb2d3e167d38cc12b522953a072a9e66de6affc40d7`, claim DB `01751994c34c5a4cb8db4bd32afc9bbc9f8ef42a0e0c3e7088c2e1dd727d7a67`.

## 실제 RED → GREEN

| 경계 | 실제 실패 | 최소 보강 뒤 결과 |
| --- | --- | --- |
| pure supplied context의 candidate/root/first confidence | 초기3RED/정상3PASS, 확대44개16RED | 44PASS. nullable/빈 first.model 추가2RED→46PASS. actual DB loader의 wrong-row 선택 증거로 확대하지 않음 |
| published 재등록 세대 | actual removeProductAndEvidence→새id INSERT→actual markPublished 후 원0077 binding과 새 binding이 동일: 정상1PASS/구분1RED | actual productId 영속 결합 뒤 DB2PASS, 별도 µs baseline 반복2PASS. 실제 결과 writer 거절은04b |
| published source parser | productId 없는 source 허용1RED/정상6PASS | 필수 positive-safe id/hash 구분 전체7PASS |
| original legacy source hash | admitted receipt의 source만 변경해도 original ownership helper가 허용: actual1RED | generation 재유도 최소조건 뒤 focused PASS, claim 전체33PASS에 포함 |
| nondeferred recorder wait | 실제 capacity_runs row blocker·pg_blocking_pids·DB clock job 만료 뒤 admission fulfilled: actual1RED | recorder 뒤 같은 job 검사로 pending 행/전이 장부 rollback PASS, claim 전체33PASS에 포함 |
| 기존 reference-time unit fixture | 전체unit1FAIL/2,914PASS. cast fixture에 first.candidateId/vote.inputHash 누락 | 필수 실제값 두 줄만 채워 해당15PASS→전체2,915PASS. predicate/clock/negative assertions 완화0 |

로그는 각각 `/tmp/nomorevibe-pr04-domain-initial-red-20261016.log`, `...-matrix-red-...`, `...-missing-first-model-red-...`, `...-first-model-final-green-...`, `...-published-generation-{red,green}-...`, `/tmp/nomorevibe-pr04a-root-published-binding-{red,green}-20261016.log`, `/tmp/nomorevibe-pr04a-foundation-source-hash-red-20261016.log`, `...-recorder-wait-red-...`, `...-last-boundaries-green-...`, `/tmp/nomorevibe-pr04a-root-{unit,reference-fixture-green,unit-final}-20261016.log`에 나눠 보존했다.

C의 실제 runJob/기존 handler는 control1PASS/3RED(1.82초)를 확인했다. items/draining에서 completed→deferred 기대 실패, healthy foreign item인데 gateway1call→0 기대 실패다. 이는04b의 실제 미완료 행동으로 별도 보존한다. 원본 `/tmp/nomorevibe-pr04b-second-review-item-ownership.test.ts`, SHA256 a5dadc044c913c30ccf7d869c48700f73869a157730c51e4a0a44225e0d208c8. 이 PR에 unresolved RED 파일을 포함하지 않았다.

## 실행한 검증

| 실행자 / 명령 | 실제 결과 |
| --- | --- |
| A / own55490 `npm run test:integration -- tests/integration/second-review-item-claim.test.ts` | 최종33PASS(13.37초), 실제 DB owner/token/boot/epoch/binding·SKIP LOCKED·S3 순서·published 재등록·outbox 실패·DB clock rollback 포함 |
| A / related pure3파일 | 64PASS(own11+B46+generic7). root 전체와 중복 합산 금지 |
| B / own55491 published domain DB | 2PASS, 정상 세대 안정/재등록 구분, 반복 baseline 검증 포함 |
| root / `npm test` | 279파일2,915PASS(10.20초), 최종exit0 |
| root / `npx next typegen`, `npx tsc --noEmit`, `npm run lint`, `npm run check:i18n` | 모두exit0, lint 기존 vendor warning1 |
| root / `python3 -m unittest tests/test_deploy_shared_images.py` | 23PASS/exit0 |
| root / `npm run build`, `node scripts/bundle-size.mjs` | exit0, br148.7/159.0/136.2KB, 기존 한도 이내 |
| root / fresh55492 전체DB | **174파일1,982PASS/기존TODO1(398.46초)**, session42015 실제exit0 |

전체DB 명령은 `TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55492/nomorevibe_test PIPELINE_TEST_LOG_PREFIX=/tmp/nomorevibe-pr04a-root-db node /tmp/nomorevibe-pr03b-db-diagnostics-20261016.mjs`. 진단 wrapper는 같은 기존 integration 명령을 실행하며 readonly lock observer만 추가한다. 로그 `/tmp/nomorevibe-pr04a-root-db-full-fresh-20261016.log`와 동명 locks.jsonl. root static/build/unit 로그는 `/tmp/nomorevibe-pr04a-root-*-20261016.log`다.

## 원복·실패·리뷰

A/B/C는 서로의 DB를 건드리지 않았다. A55490 기존 managed jobs/settings/observation에6자리 시각·JSON baseline을 넣고 wholeto_jsonb 원문 동일을 확인했다. 기존 행은 같은 열 in-place/raw exact 복원, 원래 없던 자체 baseline jobs2/settings1만 whole-row CAS로 제거했다. own fixture/product/item/purge/sentinel/schema/trigger/functions0, stage3 legacy/epoch1/contract0, 타 연결0 뒤 STOP→exited. `/tmp/nomorevibe-pr04a-foundation-managed-restore-20261016.log`. B55491도 id1 두 열만 복원·nonid1 µs sentinel 원문 동일·자체 purge0/readback 뒤 STOP. C55489는 보존된 handler RED 뒤 동일 원복·STOP을 마쳤다. root55492 final readback은 item/replay schema·role/자체 candidate·document·vote·product·purge·job·settings·trigger·function/타 연결0, stage3 legacy/epoch1/계약0, PUBLIC schema USAGE=true/CREATE=false, deadlock_timeout1s/lock_timeout0을 확인했다. `/tmp/nomorevibe-pr04a-root-db-final-readback-20261016.log`. STOP→실제 exited/exit0을 확인했다(session73660).

B 첫 published fixture의 sampleRate100 schema 오류와 자기 vote 정리 누락은 행동 RED가 아니다. 원래 실패파일은 미보존이고 도구 출력만 남았다. 유효 설정/정리 뒤 assertion RED를 별도로 확보했다. A 초기 observe-only skeleton2RED/control3PASS도 기존 handler 결함과 구분한다. root 기존 fixture 누락은 위 실제 전체unit 실패와 최소보강 기록으로 남겼다. timeout/권한/품질 gate·assertion 완화0이다.

root 직접 source/새 테스트 리뷰와 B/C 교차 리뷰를 수행했다. C 동결 source 및 root 기존 fixture 두 줄 리뷰에서 미해결P1/P2 0; B 최종 source crossover도 미해결P1/P2 0으로 handback했다. 최종 고정내용의 root `tsc --noEmit --incremental false` 및 변경9파일 scopedeslint도 exit0/경고0이다. A 동결4파일은 root 소유로 반환됐다.

## 미완료·운영 경계

legacy admitted는 실제 job 아래 입력 관측이다. durable per-row nonce가 없으므로 정확한 현재 행/토큰을 복제한 receipt의 발급 함수 실행이나 외부 호출 종료를 독립 증명하지 않는다. renewal/cleanup은 원 소유권이고 current semantic·policy·제품 세대에 결과 적용은04b 책임이다. item은 replay에서 mutation 전에 explicit unsupported로 막는다. certified B5의 callback 뒤 deferred flush 대기와 최종 clock은 공통 미완료 경계다.

이번 PR은 아직 미병합이며 최신 base 필수CI가 남는다. 부모 #439 main643bd3c는 PR CI38774067586/main CI38775007005 웹·워커 image까지 SUCCESS다. 기본 legacy/계약0·새 consumer 비활성, 운영 배포/DDL/provider inference/신규 발굴 재개0. 향후 legacy image 시작 전0077 migration 선적용이 필요하다. provider 전체 serving identity/비용·취소/30분 baseline, 2배 처리량·Oracle DR은 미판정이다.
