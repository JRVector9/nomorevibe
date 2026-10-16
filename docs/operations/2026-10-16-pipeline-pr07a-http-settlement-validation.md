# PR07a HTTP 본문 정산 — 실제 검증 기록

## 추가 진행 — 2026-10-16 07:56 UTC

AI1 PR05b3 source16은 ledger/native/runtime 실제범위검증·root직접/독립리뷰를완료해770221fb로commit했고 최신HTTP/main9e133을정상merge한로컬0cc5a50e에서push/초안PR제출을준비한다. Runtime8 distinct는 분리실행으로PASS/전체반복0, root55559·60독립raw/capturedcatalog/연결0확인후정상retired했다. Productionresolverunsupported/defaultdisabled·2배미검증유지. PR469는필수CI/최신base guard뒤main9e133으로정상병합했고mainCI진행/배포0이며strictrestore46실패는그대로다. PR453dfa와PR47063d의CI는동일HTTP unread1timeoutFAIL을보존하고B가새임시WT/전용55561에서최소관측을준비한다. PR460d71필수CI성공. A PR06 defaultdisabled consumer최소계획·C text전caller계획을충돌없이후속개발한다. 수동전체테스트는모든PR개발뒤다. 정확SHA/실패/소유권/명령은CODEX_HANDOFF최상단.

## 추가 진행 — 2026-10-16 07:13 UTC

PR460 recorder 지정case 최종2PASS/원형보존/독립리뷰0/root55557 정리까지 완료해 commit 준비다. HTTP는 C가 전용55558에서 관측·실패정산 두 fixture를 보완해 원 대상2PASS를 반환 중이며 기존 CI hang 해결은 미확정이다. PR14b는 초안PR469/head361704ef로 제출, 필수CI6+GG SUCCESS를 직접 확인했다. 실제 strict restore46 실패는 유지한다. AI1 실제 request→dispatch→terminal 구현을 ledger/schema와 native transport로 나누어 진행한다. 수동 전체 테스트는 모든 PR 개발 후이며 정확 상태·소유권·명령은 CODEX_HANDOFF 최상단을 따른다.

## 추가 진행 — 2026-10-16 06:57 UTC

PR453789의 새 CI는 HTTP rival.result/cleanup 미정산으로 통합3/check 실패해 병합을 보류했다. PR460의 별도 실패도 원로그 분석했고, C가 내부 정지 관측 계획을 검토한다. PR14b local restore 도구는 collation guard 실제2RED→same2PASS/독립 리뷰0/root55556 정리 뒤6d55f993로 로컬 commit했다. 실제 strict46 실패는 유지한다. B는 새55557에서 검수 recorder fixture1+control1만 검증하고 A는 AI1 실제 dispatch/terminal 계약을 준비한다. Root migration0084 예약/0083은 sourcebuffer 전용이다. 전체 수동 테스트는 모든 PR 개발 뒤, 운영 활성화0이다. 정확 상태·한계·명령은 CODEX_HANDOFF 최상단을 따른다.

## 추가 진행 — 2026-10-16 06:47 UTC

PR453은 최신 main 반영 후78963fc3로 정상 push했고 새 필수 CI 확인 중이다. Main7f34c475 CI 필수6+두 image SUCCESS를 확인했다. PR460 새 CI 통합1·3은 실패했으며 TTL/lock_timeout 경합 fixture를 B가 검토한다. PR10b host DB quota source7/tests5/validation1은 root commit e0142201·아직 미push다. Child helper 실제 RED→GREEN 및 A 독립 리뷰0까지 완료했다. PR14b는 실제 dump/restore 명령 성공과 strict mismatch46 실패를 구분하며 source/target root 독립 확인 후55553·54 정상 정리했다. C는 새55556에서 collation 검사 누락을 최소3파일로 보완하고 A는 PR14c 후속 설계를 검토한다. 수동 전체 테스트는 모든 PR 개발 후다. 정확한 source/실패/소유권/명령은 CODEX_HANDOFF 최상단을 따른다.

## 추가 진행 — 2026-10-16 06:31 UTC

PR453529d4199 CI38860739876의필수scope/quality/통합3/check/GG전체SUCCESS확인、최신main반영후재확인남음。PR460은3349f20c로부모normalmerge/push/고유57+incoming7SHA보존。PR468readonlyDR는필수CI/최신base/고정head확인뒤main7f34c475정상병합、mainCI진행/운영배포0。PR10b source7+tests5검증·root독립DB정리뒤C발견fixtureP2두helper를DB0로보강중(55552retired)。PR14bactualdump/restorechild0이나DB설정1+DDLdeparse45의엄격대조실패를유지、재dump0/남은negative1만승인。A55553/54독점、B는PR05positivecaller읽기계획。전체수동테스트는모든PR뒤、실제2배/Oracle운영DR는미완료。정확명령·실패·소유권은CODEX_HANDOFF최상단。

## 추가 진행 — 2026-10-16 06:23 UTC

PR453 진단opt-in·strictschema재사용 변경을 root직접/C독립리뷰와 범위 unit/actual3 후 **529d4199**로normalpush/remote확인했다. 실제CI성공과성능2배는미확인이다. 새CI분석상HTTP최초pending은headers뒤 rival.result이며PGbackend원인미확정이다. 모델요청재발견PR467/readonlyDR PR468은초안제출완료. B는실제DBpool/childentryquota7source와actual3PASS뒤정산중(55552), A는localdump→restore전용5파일개발/actual2 scope(55553/54)다. Retired55515–51/수동전체테스트는모든PR뒤/운영·consumer·실모델·DR활성화0. Root가최신453을460에고유57SHA보존normalmerge할예정이며정확head·파일·命令/한계는CODEX_HANDOFF최상단을따른다.

2026-10-16 KST. [고정 계획](../superpowers/plans/2026-10-16-pipeline-pr07a-http-settlement.md)을 따라 실제 기존 HTTP 호출을 수정했다. base `99a9cefcd9c82dcc86441b798332137a3604fe36`, 작업 branch `codex/pipeline-pr07a-http-settlement-20261016`다.

## 변경 결과

background `safeFetch`는 abort 이벤트나 취소 요청만으로 origin을 반환하지 않는다. 실제 reader.cancel과 진행 중 read가 정산된 뒤 반환하며, caller cancel/abort가 겹쳐도 취소는 한 번만 실행한다. abort로 깨운 read를 정상 EOF로 바꾸지 않고 원 signal.reason을 보존한다.

본문 정리 실패 뒤 redirect의 다음 요청을 보내지 않는다. 확정된 prefix·too_large·HTTP status·Retry-After는 cleanup 실패로 덮지 않는다. `readBodyCapped`의 fire-and-forget 취소는 await로 바꿨다. 기존 byte 보존 의미·SSRF/DNS 검증·헤더·timeout·redirect 상한·interactive 병렬은 유지했다.

production 변경은 `lib/net/fetch.ts` 하나다. 동결 SHA-256은 `d69349eb88a6e1262d688879e8497538576594889d25569b4d506aea7ca19fac`다. 새 설정/의존성/DB/마이그레이션/공개 API는 없다.

## 실제 RED → 같은 GREEN

C와 B가 독립 fixture로 실제 ReadableStream/Response/reader.cancel을 사용했다. undici 외부 transport와 timeout signal 생성만 stub했다. root가 원 driver 전체·실패 로그·원 source SHA를 읽어 기능 실패를 수용한 뒤 C만 production 소스를 수정했다.

| 검사 | 원 source에서 실제 결과 | 같은 원 driver의 수정 후 결과 |
| --- | --- | --- |
| C 7개: cancel/read 대기, prefix 대기, abort/이미 abort된 signal, 정상 controls | 4 Assertion FAIL / 3 PASS, exit1 | 원 C+B 합17 PASS, exit0/111ms |
| B 독립10개: 정리 실패·redirect·origin 유지·prefix/too_large·HTTP | 8 Assertion FAIL / 2 PASS, exit1 | B가 독립 재실행10 PASS, exit0/112ms. C와 합17 PASS, exit0/114ms |
| 기존 deadline/recovery/conditional/link-evidence 4파일 | 기존 회귀 | C 실제48 PASS, exit0/427ms |
| C source/driver scoped ESLint | driver 초기 exit0 | 최종 exit0 |

C driver `tests/net-fetch-settlement.test.ts` 249행 SHA `7613611d2215277b13ecd3557162226166e306dd5e6988fa1522f8583aef7edf`, B driver `tests/net-fetch-settlement-adversarial.test.ts` 220행 SHA `44afb66a1e0731e87626652b643d6272e32c5d5971720e466afa6cbbb559b0a0`는 각각 원 RED 파일과 byte 동일하다. 초기 import/setup/unhandled 오류를 기능 실패로 세지 않았다. assertion 실패 경로에서도 finally에서 실제 reader/cancel/follower를 정산했다.

원 로그는 `/tmp/nomorevibe-pr07a-c-initial-red-20261016.log`, `-b-baseline-red-20261016.log`, `-c-original-17-green-20261016.log`, `-c-existing-related-green-20261016.log`, `-b-frozen10-green-20261016.log`, `-b-combined17-green-20261016.log`에 보존했다.

## root 검증과 검증 정책 변경

사용자가 **이후 PR별 수동 전체 테스트를 반복하지 않고, 남은 모든 PR 개발 후 통합 단계에서 실행**하도록 지시했다. 앞으로 변경 범위 회귀와 필요한 정적 검사만 PR별로 실행한다. 저장소의 필수 병합 CI는 유지한다. 아래는 지시 전에 이미 실행한 결과이며 다시 실행하지 않았다.

| 실제 실행 | 결과 |
| --- | --- |
| `npm test` | exit0, 294파일 **3,757 PASS**, 15.83초 |
| `npm run lint` | exit0, error0/기존 vendor `_ctx` warning1 |
| `npm run check:i18n` | exit0, 4 locales/8 namespaces/11 public pages |
| `npx next typegen` 후 `npx tsc --noEmit --incremental false` | 각각 exit0 |
| 전체 build | **exit1**, 외부 node_modules symlink가 Turbopack filesystem root 밖을 가리켜 거절됨. 앱 compile PASS가 아님 |

C의 typegen 전 tsc는 미생성 PageProps6개로 exit2였다. root가 typegen 후 source 수정 없이 tsc exit0을 확인했다. 전체 build를 위해 설정/의존성을 변경하거나 재실행하지 않았다. bundle은 실행하지 않았다. 종합 build/bundle과 전체 DB 검사는 모든 PR 개발 후 통합 단계에 남긴다. 새 테스트 DB를 만들거나 이전에 정리한 DB에 재접속하지 않았다.

root 원로그: `/tmp/nomorevibe-pr07a-root-{unit,lint,i18n,typegen,tsc,build}-20261016.log`.

## 직접·교차 리뷰와 한계

root가 production 전체 diff/helper/호출 문맥과 두 원 driver를 읽었다. A가 동결 source 전체를 독립 읽기 리뷰하고 B가 원8개 실패의 해결을 diff와 대조했다. 추가 미해결 P1/P2는 없다. A/B/C 모두 source/driver SHA 동결을 확인했다. 리뷰는 `/tmp/nomorevibe-pr07a-a-source-review-20261016.md`, `-b-final-review-20261016.md`, C 반환은 `-c-final-report-20261016.md`다.

이 결과는 **process-local origin의 reader/cancel 정산**을 검증한다. 실제 socket/native transport 종료, multi-host 공통 permit, crash 회수, 외부 모델 종료, Oracle 실제 가동이나 2배 처리량을 증명하지 않는다. 취소 실패한 origin은 유지되며 후속 background 요청은 기존 deadline에 중단된다. 자동 TTL 반환을 추가하지 않았다.

다음 PR07b에서 공통 DB 장부와 고정 per-hop adapter, safeFetch/fetchCapped 실제 연결, 실제 DB/loopback을 함께 검증한다. 운영 배포/DDL/새 consumer/발굴 재개는 이 PR에서 수행하지 않았다.

## PR 상태

코드·변경 범위 검증·직접/교차 리뷰 후 실제 commit `69512b92a05065e66bd3323c4ed102994b53b1a6`을 feature branch에 push하고 [PR451](https://github.com/JRVector9/nomorevibe/pull/451)을 제출했다. base는 main99a9cefc다. PR은 OPEN/MERGEABLE이며 필수 check 대기로 BLOCKED다. [PR CI38823740327](https://github.com/JRVector9/nomorevibe/actions/runs/38823740327)의 scope 및 GitGuardian SUCCESS, quality·통합3구간 IN_PROGRESS를 직접 확인했다. 전체 CI·병합·main CI/image·운영 적용 완료로 세지 않는다. 관측 JSON은 `/tmp/nomorevibe-pr07a-root-pr451-20261016.json`이다. 이 PR 제출 기록은 코드 head 이후의 로컬 문서 갱신이며 다음 코드 PR에 취합한다.


## 필수 CI·정상 병합·main image — 완료

root가 [PR CI38823740327](https://github.com/JRVector9/nomorevibe/actions/runs/38823740327)의 scope·quality·통합3구간·필수check 전체 SUCCESS를 직접 확인했다. PR 이벤트의 image 두 잡은 SKIPPED다. 로컬 symlink 제한과 별개로 CI의 clean-install quality/build는 SUCCESS다. 원 JSON은 `/tmp/nomorevibe-pr07a-root-ci-final-poll-20261016.json`.

최신 origin/main99a9cefc·동일 head69512b92·MERGEABLE/CLEAN·필수check SUCCESS를 확인하고 `gh pr merge 451 --squash --match-head-commit 69512b92a05065e66bd3323c4ed102994b53b1a6`을 실제 실행했다(exit0). 병합 시각은 **2026-10-15T23:37:21Z**, main **f93b8d638d4f58405e62f9b11ce1b58c117ad1e0**다. [main CI38824682495](https://github.com/JRVector9/nomorevibe/actions/runs/38824682495)가 이 SHA로 진행 중임을 직접 확인했다. 전체main check/image 및 운영 적용 완료로 세지 않는다.

후속 같은 run 관측에서 scope·quality·통합3구간·필수check·웹/워커 image **전체 SUCCESS**를 직접 확인했다. 최종 JSON은 `/tmp/nomorevibe-pr07a-root-main-ci-38824682495-20261016.json`이다. 위 진행 중 문장은 이전 관측이다. image 생성은 운영 배포 증거가 아니며 이 단계의 수동 전체 테스트 재실행은 없다.


2026-10-16 site/admission 인수: PR456 main CI38843767154·images SUCCESS, PR458 exacthead888f1ce/필수CI38844114868 성공후 main2a227dd 정상squash(03:21Z). site20파일은 actual role2+site8의 분리10PASS·unit52/후속runtime10·root89table raw/capturedcatalog exact/독립리뷰 P1/P2 0로동결됐다. AI1admission source5/tests3은 원3GREEN/unit38/확장11분리GREEN/genuine1GREEN; fixture foreignitem 소유권P2는 ownItemKeys 최소보강(원15본문exact/해당eslint0/DB재실행0). 둘다local/운영비활성이다. PR453 원pair 각1회2PASS/7.115·9.479초로CI지연미재현, 검증SQL과후단CPU를함께측정하고검증의미를보존하는profile두SQL만후속개선중이다. PR460 통합1은직전records fixture의healthy AI1job 미정리구체경로를확인했고전체CI실패를보존한다. PR459 통합3HTTP8실패도미해결이다. 전체수동테스트는모든PR개발후최종통합단계에서만진행한다. 최신세부소유권/merge중단/DB55535는CODEX_HANDOFF를따른다.


2026-10-16 최신 취합: site/AI1 admission은 역할분리 PR460에 의존하는 초안 PR461/462로 제출했다. PR453 profile SQL 두경계 개선은 old/new실제32항목·원2case와독립리뷰를통과하여source인수중이며CI지연해결은미확정이다. PR460 fixture의실제잠금잔류원인을좁은pair로재현/수정했고, 독립리뷰의absent→concurrentowner경쟁도실제RED후보강중이다. Oracle초안PR459는최신main2a정상adoption/head67f35d7. PR12 sourcebuffer(A,defaultdisabled/R:null)와PR13 관리자현재제어상태(C)는분리WT에서병렬구현중이다. 수동전체unit/전체DB/종합build는모든PR개발이끝난뒤만실행한다. 상세소유권/정확명령은CODEX_HANDOFF.md.
