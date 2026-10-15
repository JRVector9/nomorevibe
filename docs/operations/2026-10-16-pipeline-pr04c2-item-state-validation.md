# PR04c-2a-0 실제 검증 장부 — item 상태 순수 모델

[실행 계약](../superpowers/plans/2026-10-16-pipeline-pr04c2-item-state-foundation.md). 새 WT/baseca715846에 A production+primaryunit, B 독립adversarialunit, C actualSQL row-conformance를 배타 배정했다. root가 아래 세 독립 baseline의 원driver/로그를 읽어 행동 RED를 수용하고 A의 구현 동결을 해제했다. 이후 같은 driver GREEN과 root 전체 단위·관련 DB·정적/build gate까지 아래처럼 확인했다.

독립 payload `kind=pipeline-replay-item-state,version=1`은 향후 combinedreadinessv2 구성요소다. 현재 v1/artifact/profile/entry·item replay 차단은 byte변경0으로 유지하고 새authority/verifiedhandle/consumer/운영활성화를 추가하지 않는다. pure모델에 actualrawrows를 넣는 테스트를 인증된 capture/journal/coverage로 부르지 않는다.

선행 PR444/headca715846 CI38798204078 필수check 전체SUCCESS→정상 squash merge main `bcf4396e51738ee4c974f72728c27ea72d8a1598`를 직접 확인했다. main CI38799565167은 진행 중이다. 새 WT는 HEAD/base와 actualmain의 tree동일 확인 후 정상 merge `cfc44c2d`로 통합했다. PR443/mainc7754651 CI38797366784는 필수check·웹/워커image 전체SUCCESS다. c1b 실제unit2985/DB2132PASS·TODO1·최종test보강별도·정적build0/4DBreadbackSTOP 결과는 해당 validation 문서에 있다. 이것은 새 item-state 모델의 PASS가 아니다.

C55509 전용pinnedPG17/loopback/dummy만 허용한다. root가 포트 미사용을 확인했다. forensic/타user/다른image/cache는 변경하지 않는다. c1b 완료4DB는 각각 rawreadback/STOP 확인 뒤 exact이름만 metadata보존후 제거했다. 마지막 C/root2개 metadata `/tmp/nomorevibe-pr04c1b-final-completed-db-before-cleanup-20261016.json`, 제거actual0 `/tmp/nomorevibe-pr04c1b-final-owned-db-storage-cleanup-20261016.log`.

## 실행 가능한 scaffold와 새 기능 unit RED

A sourceSHA `b07f75d41723ea2ef0a1309bae54c3504eb16db95f2d1c1be0f18d20f10601d0`, primaryunitSHA `ad2fb15f6a4551d1a41abd1f8aa725e9def11fcf4e46583722755581e742e7fe`를 root가 전체코드/원로그로 확인했다. `npx vitest run tests/pipeline-replay-item-state.test.ts` 실제 **4FAIL/exit1·338ms**. 실행가능6API와 strict full열 schema는 있고 정렬/시각정규화·reducer·expiry가 빠진상태에서 expected/received assertion이 각각 실패했다. import/setup오류가 아니다. `/tmp/nomorevibe-pr04c2-a-scaffold-red-20261016.log`. 신규기능stub TDD이며 기존운영결함재현은아니다.

B의 동결 독립driver `tests/pipeline-replay-item-state-adversarial.test.ts` SHA `1e532514318f45d0634858bb32b17248a2973bcf70cfb22a5b0ee2c34e1d9244`, 같은 scaffold에서 `npm test -- tests/pipeline-replay-item-state-adversarial.test.ts` 실제 **71FAIL/59PASS/130case·604ms·exit1**. 정렬·binding/owner 교차검증·시각/µs·OLD/ordinal/null·expiry assertion이며 import/setup/TypeError 실패0이다. 59 control에는 strict malformed/unsafe/version격리를 포함한다. `/tmp/nomorevibe-pr04c2-state-b-scaffold-red-20261016.log`. whole tsc 및 scopedlint 실제0도 별도 확인했다.

C 원2case driver SHA `9079dc7824ce07659da1c23ece96bff5316a9b9dc15f72c0b00cfcce9e9529a1`은 `/tmp/nomorevibe-pr04c2-c-initial-driver-20261016.ts`에 보존했다. 전용55509에서 실제 **control1PASS/행동1FAIL·957ms·exit1**. SQL/getTableColumns/to_jsonb 6/12열·generic 원90s claim control은 통과했고 canonical actualrow와 독립SQL UTC/order 대조 assertion이 실패했다. `/tmp/nomorevibe-pr04c2-c-initial-red-20261016.log`. SQL/API/setup오류를 RED로 세지 않았다. root가 원2case/로그를 읽고 수용했다. C는 원2case를 보존하며 renew/release/transition/expiry/cleanup matrix를 자기파일에만 추가한다.

세 baseline 수용 뒤 root가 A source/본인unit 두파일만 동결해제했다. B/C의 독립driver 기대값을 변경하지 않고 동일 GREEN 및 최종 직접/교차 리뷰를 기다린다.

root가 `pipeline-replay-readiness.ts`, `pipeline-replay-artifact.ts`, `pipeline-replay-handler-profile.ts`, `pipeline-replay-runner.ts`를 baseca715846와 byte비교해 동일함을 확인했다. 새module을기존replayentry/인증경로에연결하지않는다.

## 동결 구현과 같은 driver GREEN

최종 production SHA `01d06f0daf4a284aa68e320e0da51ec92e5dfe438e22566c68f11c8fe23221f2`, primaryunit SHA `f56fe8f90e2e72701ba3ba07cdb5f90fdabe6eccd3c4be3484d2c246836e9490`다. A는 원4case를 같은 기대값으로 GREEN한 뒤, nested binding의 이미 실패한 refinement가 parent에서 itemWorkKey/hash를 통해 다시 throw하는 경계를 self-review로 찾았다. 새 negative1case 실제 **1FAIL/4PASS·313ms·exit1**→기존 binding.safeParse 성공 때만 교차검증하는 최소보강→**5PASS·376ms·exit0**. `/tmp/nomorevibe-pr04c2-a-{nested-binding-red,final-unit-green}-20261016.log`. 이는 이 신규 모듈 개발 중 검증 API의 예외 누출이며 기존운영결함을 주장하지 않는다. whole tsc/scopedlint 실제0.

B frozen130case는 SHA/기대값 변경0으로 **130PASS·651ms·exit0**, `/tmp/nomorevibe-pr04c2-state-b-green-20261016.log`. whole tsc/scopedlint0. C 최종driver SHA `61fbd45e2ac2e6f6dc042cc30403e0a17157144b853ede63b4a44e34170faf08`, 305행7case. 원2case byte-identical prefix를 보존하고 같은2case **2PASS/5skip·2.27초·exit0**→전체 **7PASS·1.22초·exit0**. `/tmp/nomorevibe-pr04c2-c-{same-two-green,whole7-first}-20261016.log`, whole tsc/scopedlint0. claim→renew→원object release→DELETE actual fullOLDNEW, 실제stage transition의 stale released/foreign행, 전체owned expiry, staleOLD/누락·추가열/불변, cleanup실패전파를 비교한다.

root는 source1/단위2/integration1 전부 직접 읽었고 B→A source와 A→C driver 읽기교차리뷰의 미해결 P1/P2는0이다. schema는 raw timestamp 텍스트를 검증·보존하고 canonical 함수에서만 UTC로 정규화한다. 실제 owner/token은 C generic claim이 발급하며, 이 테스트가 AI2 domain·인증된 journal/권한을 증명한다고 확장하지 않는다.

## root 취합 gate

| 실제 실행 명령 | 결과 | 원로그 |
| --- | --- | --- |
| `npm test` | 284파일 **3,120PASS·9.01초·exit0** | `/tmp/nomorevibe-pr04c2-root-unit-20261016.log` |
| `npx tsc --noEmit --incremental false` | exit0 | `/tmp/nomorevibe-pr04c2-root-tsc-20261016.log` |
| `npm run lint` | exit0, 기존vendor unused변수warning1 | `/tmp/nomorevibe-pr04c2-root-lint-20261016.log` |
| `npm run check:i18n` | exit0, locales4/namespaces8/pages11 | `/tmp/nomorevibe-pr04c2-root-i18n-20261016.log` |
| `python3 -m unittest tests/test_deploy_shared_images.py` | 23PASS·exit0 | `/tmp/nomorevibe-pr04c2-root-python-20261016.log` |
| `DATABASE_URL=postgres://build:build@localhost:5432/build npm run build` | exit0 | `/tmp/nomorevibe-pr04c2-root-build-20261016.log` |
| `node scripts/bundle-size.mjs` | exit0, br148.7/159.0/136.2KB 한도내 | `/tmp/nomorevibe-pr04c2-root-bundle-20261016.log` |
| 전용55509 `npx vitest run --config vitest.integration.config.ts tests/integration/pipeline-replay-item-state.test.ts tests/integration/pipeline-replay-readiness.test.ts tests/integration/pipeline-replay-handler-profile.test.ts tests/integration/pipeline-replay-certified-final-wall.test.ts` | 4파일 **41PASS·12.49초·exit0** | `/tmp/nomorevibe-pr04c2-root-focused-db-20261016.log` |

41에는 C신규7이 포함되며 두 결과를 더하지 않는다. 새 모듈은 기존 경로에서 import하지 않는 순수 추가여서 전체DB local재실행을 불필요 반복하지 않았다. 필수PR CI의 전체DB3shard는 별도 확인한다. root `git diff --name-only origin/main -- lib scripts migrations .github package.json package-lock.json` 결과는 빈 목록으로 기존trackedsource 변경0을 확인했다. 위 production1은 신규파일이다. 최종C readback/STOP은 아래처럼 완료했고 PR/CI/normalmerge/mainCI는 별도 남아 있다.

## 선행 main CI 실패와 조사 한계

PR444 mainCI38799565167 quality의 `npm test`에서 기존 `tests/thumbnail-images.test.ts:9` PNG-backedICO/default-render case **5005ms timeout1/2984PASS**가 발생했다. 원job로그 `/tmp/nomorevibe-pr04c1b-main-quality-failed-20261016.log`. thumbnail source/test/lock은 선행c1a와 동일하고 c1b변경 경로의 직접sharp의존0을 읽기 확인했다. B의 변경없는 동일파일 단독 실행은 **5PASS·208ms·exit0**, `/tmp/nomorevibe-pr04c1b-thumbnail-scoped-unchanged-20261016.log`. 첫SVG/font 초기화와 전체suite부하가 후보이나 CI 내부await진단이 없어 원인은 미확정이며 단독PASS만으로 flaky로 확정하지 않는다. timeout/config/source를 바꾸거나 실패를 숨기지 않았다. 같은mainSHA의 실패job 재검증을 CI종료 뒤 수행하고 결과를 별도 기록한다. 이 실패는 c2 새기능 RED가 아니다.

같은 main CI의 통합3shard는 첫 기존 `pipeline-replay-certified-final-wall.test.ts` healthy case의 default20초 timeout 후 미완료fixture/cleanup 경합과 immutableguard 잔류가 나타났다. 결과32file/147FAIL·626PASS·17skip·기존TODO1, 통합1/2shard SUCCESS. 원로그 `/tmp/nomorevibe-pr04c1b-main-ci-failed-20261016.log` 의 첫timeout/후속guard 실패를 확인했다. 원인 전체를 단정하지 않고 같은mainSHA로 `gh run rerun 38799565167 --failed` 를 실행해 actualexit0/재실행 중을 확인했다. fixturecleanup은 독립읽기리뷰로 조사 중이다. image는 최초시도SKIP이며 성공이라고 기록하지 않는다.

## 마지막 raw readback과 DB 종료

C는 신규driver가 만든 행을 원래대로 복원했다. root 관련gate의 기존 readiness/profile driver가 남기는101 candidates·102 documents·7 attempts·2 jobs·settings1은 source의 readiness/app-0..100/outside/universe·정확jobname으로 출처를 확인했다. 전체14테이블 rawµs snapshot과 inventory를 보존하고 각 fullrow 사전일치 검증 뒤 **정확 ID/repo/key만** 단일TX에서 삭제했다. 나머지9테이블과 stage 전체raw 불변을 다시 검사한 뒤 COMMIT했다. `/tmp/nomorevibe-pr04c2-root-fixture-{before-cleanup-20261016.json,cleanup-inventory-20261016.json,exact-cleanup-20261016.sql,exact-cleanup-20261016.log}`. root가 원COMMIT/DELETE수와 최종readback을 직접 읽었다. 광범위TRUNCATE/타fixture 정리는 하지 않았다.

최종 `/tmp/nomorevibe-pr04c2-c-clean-final-readback-20261016.log`: 관련14테이블 잔류0, own/replay trigger·함수·역할·schema·다른connection0, 세stage raw `legacy/epoch1/contract0` 및 원 updated_at 불변. DB/PUBLIC/관계ACL은 기본권한과 일치, columnACL0, lock_timeout0/deadlock_timeout1s/statement_timeout0와 source/default 일치. 전용55509 **STOP/exited0·OOMfalse** 원로그 `/tmp/nomorevibe-pr04c2-c-stop-20261016.log`도 root가 직접 확인했다. stopped container/volume은 아직 보존한다. forensic/타user/다른image/cache는 변경0이다.
