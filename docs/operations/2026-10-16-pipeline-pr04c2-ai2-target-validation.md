# PR04c-2a-3 검증 장부 — target 판정·actual claim 대조

[고정 계약](../superpowers/plans/2026-10-16-pipeline-pr04c2-ai2-target.md). root가 배타 파일·DB·원로그·리뷰를 취합한다. 선행 PR의 테스트를 새 기능의 증거로 세지 않는다.

A의 실행 가능한 baseline source SHA `82847f0e4c6a329a71ab21b0b645c09897e1e62f21f4912b34845a77034b0f64`, 자체 unit SHA `724c56b09754bb35e15507d80e06df3b59347134d267ba7767fae4f70e5d036e`를 root가 전체 읽었다. 실제 valid current target의 full binding/included·outside 기대값 **2 Assertion FAIL, strict/stage/status/args/clock conflict control 4 PASS**, 639ms/exit1. import/API/SQL/setup 실패가 아니다. 원로그 `/tmp/nomorevibe-pr04c2-ai2-target-a-scaffold-red-20261016.log`. B/C의 같은 baseline 독립 RED와 actual claim control을 root가 수용한 뒤 A 최소 구현을 해제했다.

root `npx next typegen` 실제 exit0, `/tmp/nomorevibe-pr04c2-target-root-typegen-20261016.log`. 그 밖의 새 GREEN/DB differential/전체 gate/최종 리뷰는 아직 기록하지 않는다.

PR448은 필수 CI38808970207 전체 SUCCESS 후 main `e22ec72576aa801e320e047bb53d7d5dbf1eed69`로 정상 병합했다(2026-10-15T21:27:09Z). main CI38809968134는 필수 검사와 웹/워커 image까지 전체 SUCCESS다. 이 병합은 새 target 기능의 검증 결과가 아니다.

B의 독립 driver SHA `bdfa991db314a1b75400c5e6897321f26936578d25c7e8f040a0bdd72de5fcb0`(467행)는 같은 source에서 **49 Assertion FAIL/72 control PASS**, 1.54s/exit1. Vitest는 49개 실패를 같은 오류 35개 블록으로 묶었다. import/API/SQL/setup 오류0. root가 전체 driver와 원로그의 모든 실패 이름/오류 종류/결과, whole tsc/scoped lint 빈 오류 로그를 읽었다. `/tmp/nomorevibe-pr04c2-ai2-target-b-frozen-scaffold-{red,tsc,lint}-20261016.log`.

C 원 driver SHA `1c2d45e7e4f7ed5e712085633dfae29c1259e8b8e940c5715ce1f32b75675786`(283행), `/tmp/nomorevibe-pr04c2-ai2-target-c-initial-typechecked-red-20261016.log`: **1 Assertion FAIL/1 actual control PASS**, tests978ms/total1.61s/exit1. root가 전체 driver/원로그를 읽었다. 각 case에서 capture TX 종료 뒤 ordinary actual claim90s·영속 token/owner/boot/epochs/full binding·원 cancelled writer·release/null·domain/jobs/foreign item 불변을 확인한 후, 새 logical assessment의 eligible/fullbinding/included 기대값만 실패했다. 실제 DB UTC6 capture/claim bounds와 genuine receipt를 사용했다. fixture first/frozen 이력은 provider/dispatch 증거가 아니며 provider0이다.

C registry가 같은 원 Assertion을 Aggregate로 보존한 것은 별도 cleanup 실패가 아니다. 초기 nullable DB provider/model type-only 표시 두 건을 보강한 전 driver 결과는 최종 RED 증거와 구분해 보존했다. root는 baseline/after-initial-red JSON 전체의 rawµs/함수/trigger/roles/effective ACL/defaults 동일을 실제 assert했다. 최초 raw `datacl=NULL`이 기본 권한의 명시 배열로 바뀐 표현 차이와 clock sample만 제외했다. raw ACL 표현까지 동일하다고 주장하지 않는다.

root 원본4파일은 `/tmp/nomorevibe-pr04c2-ai2-target-root-frozen-{source,a-unit,b-unit,c-driver}-20261016.ts`에 보존했다. 원 기대값/bytes를 유지한 GREEN은 아래와 같으며 actual differential 확장·최종 리뷰/남은 전체 gate는 진행 중이다.

최소 구현 source SHA `fed5623d282ee7fdb2e65e39c7c52765fb891920d4e5675cd1bff055da2614a5`(119행). root가 source 전체와 actual loader·public predicate·generic MAX_SAFE 경계·product SQL·root chain을 직접 대조했다. 기존 production 파일 변경0, 공개 factory/predicate/binding 재사용이며 새 storage adapter만 추가했다. 초기 직접리뷰 P1/P2 0이고 최종 교차리뷰는 남았다.

같은 동결 driver GREEN: A6 PASS596ms/exit0, B121 PASS2.44s/exit0, C 원2 PASS3.53s(tests2.34s)/exit0. 원로그 `/tmp/nomorevibe-pr04c2-ai2-target-a-green-20261016.log`, `...-b-final-green-20261016.log`, `...-c-original-two-green-20261016.log`를 root가 읽었다. A/B whole tsc/scoped lint actual0 로그도 읽었다. C는 같은 원본 2case를 먼저 검증한 후 실제 claim 직후의 정산 try 범위 보강과 matrix append를 진행 중이다.

root `npm test`: **290files/3,644PASS/14.18s/exit0**. i18n **4 locales/8 namespaces/11 pages**, Python **23PASS/1.520s**, actualexit0. `/tmp/nomorevibe-pr04c2-ai2-target-root-{unit,i18n,python}-20261016.log`. 새 whole tsc/lint/build/bundle·최종 관련 DB와 필수 CI는 아직 남았다.

## 실제 DB 행렬·최종 리뷰와 root gate 완료

C 최종600행 SHA **a0f6fc12c77547fdb39bf52e8f1cee39a327f741cbdb7df8ba23bde17f47a1ae**. 원1c2d45의 두 case 본문과 assertion은 전체 bytes 동일임을 C conformance와 root 독립 추출 비교로 확인했다. helpers는 승인된 receipt 직후 try/finally 범위·새 item key/원 publication 이력 부재 guard·own product/scan/settings 및 trigger history cleanup만 보강했고25case를 추가했다. root가 source119행·unit2개·C600행 전체/최소 diff를 읽었고, B→source/A→C 최종 교차리뷰 추가P1/P2 0이다.

최종 **27PASS/6.87s/tests6.25s/exit0**, C whole tsc/scoped lint0. 원로그 `/tmp/nomorevibe-pr04c2-ai2-target-c-clean-final-{27-green,tsc,lint,diff-conformance}-20261016.log`. 실제 stage/status/source·human·pool, same/foreign boot owner, healthy oldepoch 보존·원 receipt 거절, independent root/다른 generation, fallback root/child, 정책 변경 후 회복, exact referenced first reviewer, outside universe·외부101, actual rawµs latest scan, published product replacement·banned priority, MAX_SAFE 순서를 확인했다. row/advisory holder 때 snapshot eligible와 actual running은 경합 사실로 분리하고 해제 후 actual claim 회복을 확인했다. unknown3·ambient 충돌은 runtime claim 동치라고 세지 않았다.

Root 관련 DB **4files58PASS/15.63s/tests14.11s/exit0**: target/combined capture/item capture/item state. `/tmp/nomorevibe-pr04c2-ai2-target-root-related-db-20261016.log`. 새 로컬 whole DB suite를 전부 실행한 것은 아니며 PR 필수 CI3shard는 별도다. 원 source/A/B unit은 계속 동결되어 전체 unit3,644PASS 결과는 유지했다. 최종 whole tsc --incremental false/whole lint actual0(기존 vendor warning1만), dummy DB production build/bundle 실제0. bundle br148.7/159.0/136.2KB. `/tmp/nomorevibe-pr04c2-ai2-target-root-{final-tsc,final-lint,build,bundle}-20261016.log`.

C 최종 readback과 root 관련DB 뒤 readback은 rawµs·원3stage/timestamp·전체 public 원행/함수OID·정의/trigger·roles/config/effectiveACL/defaults 동일이다. root가 JSON 전체를 직접 비교해 clock sample/raw datacl default 표현만 제외한 일치를 assert했다. replay/columnACL/다른 연결0, 비어있지 않은 행은 stage3/visit1뿐이었다. repo0058 jitoff/source database·timeout0/1s/0 유지. C 로그/JSON `/tmp/nomorevibe-pr04c2-ai2-target-c-clean-final-27-readback-20261016.{json,log}`와 root JSON `/tmp/nomorevibe-pr04c2-ai2-target-c-root-related-final-readback-20261016.json`. root 직접 명령 로그는 `/tmp/nomorevibe-pr04c2-ai2-target-root-related-final-readback-20261016.log`.

root가 own55517/정확 container ID/loopback port/정확 단독volume을 확인하고 정상STOP/exited0/OOMfalse 뒤 그 container/volume만 제거했다(실제0). metadata `/tmp/nomorevibe-pr04c2-ai2-target-root-owned-db-{before-cleanup,after-stop}-20261016.json`, `...-cleanup-20261016.log`. 현재55517 접속 대상은 없다. 다른DB/image/cache/forensic·운영 변경0.

## 실패 접근과 검증 한계

첫 확장27은25PASS/2fixtureFAIL(5.91s): timestamp 직접 bind가 µs를 잘랐고 product URL 중복23505였다. ::text::timestamp와 실제 to_char µs 두 행 assertion, 다른uniqueURL+같은repoURL OR identity로 최소 보강했다. 새 production RED가 아니다. 처음27PASS6.81s 뒤 whole public readback actual1이 자체 publication trigger 잔여6행을 발견했다. 원JSON의 id1–6와 세 C suffix/각+1/-1쌍을 root가 읽었고 exact id+repo AND만 삭제했다. 이후 ownrepo guard/cleanup/table snapshot 보강 후 같은27·readback0을 확보했다. 실패 전 기록은 보존했다.

Root는 C 작성중 build를 먼저 실행해 테스트 crowd.reason이 실제 enum에 없는 TS2769/exit1을 받았다. 최종 fixture ambiguous 보강·동결 후 build actual0을 재확인했다. 초기 로그 `/tmp/nomorevibe-pr04c2-ai2-target-root-draft-build-failed-20261016.log`. body+cleanup 동시 fault 주입·추가 자연90초 대기·분할query mutant 실험은 이번에 하지 않았다. actual provider 실행/원격 종료/인증 journal·item B5/실30분 baseline·2배 성능·Oracle DR는 이 검증으로 완료되지 않는다.

로컬 구현/리뷰/검사 완료이며 실제 feature commit/main 통합·PR 필수 CI와 정상 병합 결과는 다음 기록에서 추적한다.
