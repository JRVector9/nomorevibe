# 2026-10-16 — PR05a 로컬 검증 완료 / PR 제출 준비

## 현재 목표·운영 경계

파이프라인 PR00–17 남은 개발 goal active. root가 gpt-6.1-sol/xhigh A/B/C의 배타 파일·DB·직접/교차 리뷰·검증·Git을 관리한다. 완료 agent는 `followup_task`로 재개한다. 원본 `/Users/jr/Desktop/projects/nomorevibe`는 사용자 X branch `codex/x-osaka-smoke-20261015`이므로 **원본push금지**, handoff만 동기화한다.

현재WT `/Users/jr/Desktop/projects/nomorevibe-pipeline-model-capacity`, branch `codex/pipeline-pr05a-model-capacity-20261016`, HEAD5f65a50a는main40cca 정상merge다. root가tree동일확인. PR05a commit/push/PR은아직없다. 운영배포/DDL/provider inference/발굴재개/새consumer활성화0. 마지막직접확인운영8020dca·legacy/epoch1/contract0, 향후배포전0077/0078필수다. 모델·품질·사람판단보호유지. 작은PR로전체goal을complete처리하지않는다.

## 완료 작업·PR 상태

PR449 https://github.com/JRVector9/nomorevibe/pull/449 head7fc40d255d2e8fc66fca3c39a1296808dd3869cb의 PR CI38812876045 필수전체SUCCESS 뒤정상exact-head squashmerge했다. actualmain **40cca23d244224e1123f013b09153c82984a2a21**, merged2026-10-15T21:57:32Z. **mainCI38813727290 필수check·통합3구간·웹/워커image 전체SUCCESS 직접확인.** JSON `/tmp/nomorevibe-pr04c2-ai2-target-root-main-ci-38813727290-20261016.json`.

PR446–448 main도필수/두imageSUCCESS. PR444/445 과거main healthy20초timeout/147후속FAIL은실패로보존한다. 전체상태는 `docs/superpowers/plans/2026-10-15-pipeline-delivery-status.md`, 실제이력은각operationsvalidation. 원PR01전체baseline·PR04itemB5·실모델종료·2배/OracleDR미완료. 이전handoff는 `/tmp/nomorevibe-CODEX_HANDOFF-before-pr05a-final-review-20261016.md`, 더오래된2032행은Git86da89e5와 `/tmp/nomorevibe-CODEX_HANDOFF-before-ai2-target-compaction-20261016.md` 보존.

## PR05a 수정 파일·최종 소유권

고정계획 `docs/superpowers/plans/2026-10-16-pipeline-pr05a-model-capacity.md`, 실제기록 `docs/operations/2026-10-16-pipeline-pr05a-model-capacity-validation.md`를읽는다. 모든소스/테스트쓰기동결·root소유권반환완료.

- A pure `lib/llm/capacity.ts` SHA **db6dd34a00e1d24829f9a3b681870dd119cd0f25743c0087359496c67665b372**, unit `tests/model-capacity.test.ts` 원8개, operations-schema/journal/0078. migrationSHA **bcaf4b50bd735a2e16124744b00df7922c416b716dc060ca0e37c80c394b6dce**.
- B `lib/llm/capacity-repository.ts`231행 SHA **17af8163914a0ce7e5db905a0c4ee1997d6507144d87a11ac32d7b45a3d04ebb**, `tests/integration/model-capacity.test.ts`376행 SHA **912b011b77cd302a6e7894ef04fd04fad49ead7499455fcc24a43208b643c7b3**.
- C `tests/model-capacity-adversarial.test.ts` 원88개 SHA **882554aca74ae37ea3a30ad622fa2c324bce9c48fc1f6aa684899f1eaa632e23**, `tests/integration/model-capacity-adversarial.test.ts`596행 SHA **cff357865b235715fd77fb8a30363c71558d3aa3691d1834eeb2047a410812a3**.
- root 문서5개: plan/validation/handoff/delivery/선행PR449 validation. 합계14파일. 기존caller/설정/권한/runtime변경0, schema.ts는기존reexport라변경0.

## 설계 결정

기본disabled, policy/enable/실transport/기존caller연결0. strictpolicy exact(route/provider/model)→명시budget/group, canonicalSHA, 3class expandedweightedcycle. active reserved/dispatched/indeterminate를모든revision의global/budget/group/pool로센다. oldepoch/revision/hashactive가있으면admission차단. stale waiting은withdrawn+policy_changed로기록하며재해석0.

모든normalAPI 첫lock control FOR UPDATE. 기존expiry묶음queueOrdinal순이지만전역모든lock오름차순주장0. poll최대1grant·classcapacity-fitFIFO/HOL회피·idle몫대여. foreigngrant token비노출. reserved만TTL회수/cancel, dispatch/unknown은TTL·epoch·owner죽음으로free0. postdispatchrelease/force-reset0. currentReplayDb는SQL전거절, onPrimary자체짧은TX/commit await. 실제rowowner/boot/token/epoch/rev/hash가권한이며brand는모양뿐이다.

0078 additive3표/append-only UPDATE·DELETE·TRUNCATE statementtrigger2개 ENABLE ALWAYS. control1disabled만seed, policy/cap/aliasseed0, 기존권한변경0. 실제provider종료/commitackloss/비용상한/전체callercap·외부대기DB점유0/2배는미입증이다.

## 실행 검사·리뷰 결과

pure runnablebaseline ed29fabc…에서 A같은8개3AssertionFAIL/5controlPASS→원8PASS99ms, C같은88개3AssertionFAIL/85controlPASS→원88PASS113ms. DB runnablebaseline cfa604ea…143행에서 B원3개cap1→2grant AssertionFAIL/2controlPASS1.11s, Cactual서로다른2PID blockinggraph후같은capFAIL/2controlPASS1.13s. root가전체source/원driver/log/hash를읽고기능RED수용후본구현해제했다.

최종 B16PASS1.95s, C28PASS6.35s 각actual0/scopedlint0. root전체 **292파일3740unitPASS12.77s**·동일DB두새파일 **44PASS8.80s**·whole tsc `--incremental false`/wholelint(기존vendorwarning1)/i18n4·8·11/Python23/build(dummyDB)/bundle 모두actual0. br148.7/159.0/136.2KB. local전체DBsuite를새로돌린것은아니며필수CI3shard는남았다. nexttypegen도actual0.

root는최종모든source/DDL/unit/DBdriver전체와원로그를읽었다. A→Bsource·B→Cdriver교차review완료. helperfinding은독립requestsnapshot·실Promise정산/단일cleanup·nonexpiryTTL60s/명시expiry1s·actualblockedxact_start<expiry양성·holder-start Promise.race로폐쇄했다. 최종미해결P1/P2 0. actualhooktimeout/holder실패fault주입0. optionalreviewskill의참조checklist파일누락으로자동절차PASS주장0, 직접/교차리뷰는완료했다.

로그prefix `/tmp/nomorevibe-pr05a`: `-root-{unit,final-tsc,final-lint,i18n,python,build,bundle,combined-db}-20261016.log`; `-model-capacity-b-clone-final-green-20261016.log`; `-capacity-c-nonexpiry-final-28-green-20261016.log`. baseline/원driver/전체sha/교차memo는validation문서참조.

## 실패 접근·최종 자원 정리

C directblockerfixtureFAIL(2waiter중직접1만계수)은recursivegraph로보강하고기능RED제외. expanded27PASS/cleanup1FAIL은normalprofile의datacl/정확16관계relacl NULL→명시ownerdefault표현으로raw비교rollback이었다. 원로그/원ACLJSON보존, root가전16개actual==ownerdefault SQL결과를독립Python확인뒤정확selfrequest1/event3만ownerTX복구했다. effectiveACL비교만좁게정규화, pg_catalog수정/권한완화0. B중간C작성중tsc1타입오류는최종0과구분한다.

B최종root원10필드직접readback exact0, C결합44후전체public행/rawµs/control/stage/roles/config/function/trigger/effectiveACL/settings readback0. requests/events/items/sentinel/replay/타연결0. root가fullID·원mount·pinnedimage·loopback·단독volume참조검증후정상STOP→둘exited0/OOMfalse확인→정확own2container/volume만제거했다(actual0). **55518/55519는이제없으며재접속금지**. B실volume은 `nomorevibe-pr05a-model-capacity-b-20261016-data`, C는 `nomorevibe-pr05a-model-capacity-c-20261016`. image/cache/기타volume/prune0. 이전55517/15/16도없다.

root원metadata `/tmp/nomorevibe-pr05a-root-owned-db-{before-cleanup,after-stop}-20261016.json`, readback `-root-b-final-readback-20261016.{json,log}`/`-capacity-c-root-combined-final-readback-20261016.json`, `-root-combined-final-readback-20261016.log`. Bclone7필드JSON과초기10필드JSON의첫root전체비교는shape차이로실패해원10필드를새로조회·동등을확인했다. 실제DB변화는없었다.

## 남은 작업·정확한 다음 명령

```sh
cd /Users/jr/Desktop/projects/nomorevibe-pipeline-model-capacity
git status --short --branch
git diff --check
# root문서최종확인→명시14파일commit→featurepush→PR생성→필수CI3shard/check성공확인
# origin/main은마지막fetch에서40cca23d unchanged. 최신base정상merge만허용, force/bypass0.
# PR필수성공뒤 exacthead 정상squashmerge→main CI/웹·워커image관측·실제상태기록.
# 변경/실패없으면이미통과한localgate반복0. 55518/19·이전15/16/17재접속0. 원본Xpush/운영배포0.
```

A후속readonly `/tmp/nomorevibe-pr05b-next-contract-a-20261016.md` root완독: 물리gateway5/CLI/웹query/embedding/probe inventory, 다음pureexplicitrouteidentity제안. actualcaller연결은정상종료settled·provideridentity/hiddenretry·무소모defer·runnerACK보존계약이선행한다. A완료상태. C는 `/tmp/nomorevibe-pr07-next-contract-c-20261016.md` per-hop HTTPpermit readonly조사중(쓰기0), B완료대기. root가현재PR제출후후속최소단위계약을검토/고정한다.

PR01b6 `/tmp/nomorevibe-pr01b6-next-contract-a-20261016.md`도root완독. abcLLM부분EOF→stop추정/400·422숨은재시도와강제전체cap·strictterminal·unknownprovenance를좁은route에서먼저닫아야한다. ordinary개발/PR은사용자이미승인, 지금phase실provider/배포0. 실제servingcap/nativelegacyreplay/30분baseline/PR06·17동일조건2배·OracleDR미완료를유지한다.
