# AI1 추가 모델 pool 구현 — 2026-10-27, 로컬 실행 검사 없이 root 검토 단계

목표: 기본 `firstReview`를 유지하며 선택 설정 `firstReviewAdditional` 최대2개로 AI1 미완료 후보를 분담한다. 작업 WT는 `/Users/jr/Desktop/projects/nomorevibe-ai1-additive-pool-20261027`, branch `codex/ai1-additive-pool-20261027`, base `06ac66c1ebbb130258eb72a73b0a83dbed6420b1`이다. UI/API 상태 구현은 별도 PR695이며 이 WT에서 main을 병합하지 않는다. root가 최신 base를 통합하고 PR/필수 CI/배포를 맡는다.

완료: 공용 pool/선택기, schema 검증, 기존 legacy와 item AI1 실행, 현재 pool 완료 결과 인정, AI2 enqueue/current-input/publication gate 연결, discovery first-pressure 집계 identity, stage 모델 슬롯과 pipeline control route 목록을 연결했다. primary 모델/실제 추가 모델/용량 정책/운영 설정은 바꾸지 않았다. 후보별 새 작업은 stable ID 분담, 재시도와 현재 native waiting/reserved/dispatched/indeterminate 의도는 기존 provider/model에 고정한다. 제거된 활성 의도나 여러 모델의 충돌 의도는 재배정하지 않는다. 기존 candidate/item/native 권한과 `ai1:<candidateId>` binding을 보존한다.

독립 리뷰 P1 두 건을 반영했다. 고정 prefix만 반복하면 정상 모델이 굶는 초안을 폐기하고 기존 미검수 우선·오래된 순서/ID ceiling을 쓰는 bounded keyset을 `jobs.cursor.firstReviewPoolScan`에 저장한다. 최대32 힌트/16 examined·claim 및 기존 동시성/시간 예산을 유지하며 cursor의 다른 필드를 보존한다. 현재 승인 pool과 재시도 identity를 분리해 동일 input/source/policy/prompt/rules의 모든 자동 모델 실패·유예·owner-change와 실제 attempt 번호를 합산한다. 모델 제거 후 시도 한도가 리셋되던 기존 테스트의 기대를 새 요구에 맞게 정정했다.

모델/route별 용량 거절·회로만 국소 대기하고 global drain·정책·owner/host/epoch fence는 그대로 전체 적용한다. pool 추가는 reviewPolicyHash/secondReviewPolicyHash에 넣지 않아 완료 입력 전체를 재검수하지 않는다. AI2와 같은 underlying 모델은 독립 표로 세지 않으며 같은 모델 fallback은 needs_human이다. 기존 단일 AI1 manifest의 capacity/replay 권한을 확대하지 않고 추가 pool을 명시 거절한다. 일반 운영 generation snapshot은 pool 결과를 인정한다. 일반 설정 폼은 추가 필드를 보내지 않아 canonical saveSettings 부분 병합으로 보존한다. Zod4 superRefine은 object의 shape를 유지하고 저장소에 crawlSettingsSchema.extend/pick 호출은 없다.

수정 파일: `lib/crawl/first-reviewers.ts`, `settings-schema.ts`, `agent-review-repository.ts`, `jobs/agent-review.ts`, `agent-review-item-lifecycle.ts`, `consumers/first.ts`, `discovery-admission.ts`, `second-review-input.ts`, `second-review.ts`, `second-review-ownership.ts`; `lib/operations/stage-registry.ts`, `pipeline-control.ts`, `pipeline-capacity-repository.ts`, `pipeline-replay-readiness.ts`, `pipeline-replay-runner.ts`; 관련 unit/integration 회귀, 운영 설계 문서 `docs/operations/2026-10-27-ai1-additive-pool.md`, 이 인계. schema/grant/앱/UI/API 변경은 없다.

검증: 소스 독립 리뷰 및 자체 정적 diff 검토를 했다. `git diff --check` 실제 EXIT0이다. 사용자 지시로 로컬 tests/lint/typecheck/build/compile/provider probe는 실행하지 않았다. 추가한 회귀는 stable/retry/active-intent, capacity 국소 대기/global drain, 32개 막힌 prefix 뒤 정상 후보의 tick간 진행, 완료 결과 유지, 제거 후 backoff/3회 상한, 실제 AI2 발행 관문/자가 fallback 금지, route 목록/replay 거절을 다룬다. 회귀 실행·CI 성공은 아직 주장하지 않는다.

남은 일: root가 frozen diff 검토→scoped commit 통합→최신 main/UI695 base와 필수 GitHub CI→별도 운영 적용을 결정한다. 기존 native indeterminate 실제 정산 및 Supa/M3 serving·용량 상태는 root의 운영 조사 범위이며 이번 agent가 조회/수정하지 않았다. 추가 모델 설정은 미적용이다. 모델 추가만으로 즉시 적체 해소나 수집3천/h 달성을 주장하지 않는다.

다음 root 명령(로컬 tests 금지 유지): `git -C /Users/jr/Desktop/projects/nomorevibe-ai1-additive-pool-20261027 status --short`; `git -C /Users/jr/Desktop/projects/nomorevibe-ai1-additive-pool-20261027 diff HEAD --stat`; `git -C /Users/jr/Desktop/projects/nomorevibe-ai1-additive-pool-20261027 show --stat --oneline HEAD`. root가 최신 base 통합 뒤 PR을 생성하고 exact-head CI `check`를 확인한다. main merge/PR/push/배포는 이 agent가 하지 않는다.

---

# 현재 인계 — DB 스키마 교차검토·운영 반영 (2026-10-27 KST16:10)

## 목표와 완료

사용자 요청: 추가 서브에이전트와 스키마 개선 검토, Claude CLI Fable5.1/xhigh 직접 교차검토. 두 schema agent(gpt-6.1-sol/xhigh)와 실제 native Claude claude-fable-5-1/xhigh(402.84초 EXIT0/modelUsage 확인) 결과를 root가 소스와 대조했다. 보고서는 docs/operations/2026-10-27-db-schema-review.md. SQL 우선→실측 후 필요한 부분 index→반복 필요 시 별도 subject 매핑 순서다. schema/index/backfill0, 커넥션 확대0. 단순 generated컬럼도 전체 행 감사hash/terminal immutable/Oracle·replay·DR 영향을 피하지 못한다.

원래 작업의 PR691/692/693은 병합·운영 반영됐다. source06ac66c1ebbb130258eb72a73b0a83dbed6420b1, 공식693b run89721 실제EXIT0/deployed-and-verified 2026-10-27T06:56:25.001613Z. 최종18앱 모두target, 이번14배포+4이미target유지. finalSnapshotSHA d7dc6476a5c8d427023dddde350d339adb0ebd7583fc6e0a029adcd058d2052d. own8모델job pause 전부재개/OPEN audit20604(1/rev3/정책불변), 과거pause/드레인/실패run 재실행 금지. 수집 pages6→10 canonical saveSettings audit20630/readback확인, 모델·정책·query/window/cursor/목표3000·5분250 유지.

## 실제 관측과 한계

B=/Users/jr/.local/state/nomorevibe-reliability-20261025/grok-reconcile-discovery-20261027 (0700, private0600). sql693b-root-final.private.json 07:10:29Z READONLY/primary: 기존76 중74superseded/1not_required/1pending.69새세대등록/51기존행에새세대실제모델판별, 승인수와다름. 최근60분신규2046/원본2033(혼합창), 완전postdeploy5분신규26/원본20.3천/h미확인/현재유입감소관측필요.

실제SQL SELECT direct5432 LIMIT25 1059.399ms, PgBouncer6432 1157.373ms, LIMIT80 direct1159.639ms. 각각1표본/전체tick p95아님. helper는실제pinned generator를컴파일한 READONLY SELECT이며SQLSTATE없음. EXPLAIN ONLY(capacitybaseScan1)는추정이며ANALYZE0. reviewer DB_POOL_MAX12/consumer3, pooler6432/같은credentialhash. 기존job.last_error/last_success보존은stageblocked deferred경로 영향: ai2-post693-deferral.private.json 07:10:20Z 최신defer stage_blocked07:09:21Z. 이를현재SQL실패로단정하지않는다.

NativeGrok sql693b-grok-final1 actual80802/PID31864 EXIT0/end_turn88.17초, helperreceipt검증/root REPORT.reviewed.private.md 대조완료. 해당06:58표본에서는25정리만확인됐으나이후root07:10표본이위결과다. 공식success18앱·14/4분할원본계약재검증/추가원격fleet검증아님과freshstrictmonitor구분. 텍스트경보로overallHealthyfalse/paused[]였다. observer PID11481은첫5분관문 actual07:03:37Z failed/stopped; 나머지미래표본통과0/장기관측완료0. OP /Users/jr/Desktop/projects/nomorevibe-release-ai2-sql-fix-20261027 과소스/원본receipt6h보존.

## 변경 파일·검증·실패

현재docs WT /Users/jr/Desktop/projects/nomorevibe-schema-review-report-20261027, branchcodex/db-schema-review-report-20261027. docs/CODEX_HANDOFF.md와새schema보고서만변경. 수동tests/lint/typecheck/build/컴파일미실행(사용자지시). 운영READONLY실측만위와같이실행. PR693 CI40461058061 및main40461953037 check/worker·webimage 실제success. 문서PR694 첫head418854a6의CI40465904466/check07:14:40Z는실제success. 이번원인추가커밋의필수CI는최신PR상태로확인해야하며기존성공을재사용해단정하지않는다. 원사용자dirtyWT보존.

실패이력: Claude첫literal fable5.1은404/EXIT1, 공식동일모델ID claude-fable-5-1로별도실행성공. 공식693a는text/maintenance4배포뒤globalprogress관문실패/once소비·원본보존. OPEN·ownpause복원후새mixedbaseline693b가4유지/14배포로성공했다. gate/timeout완화0. relative resume-plan시도는readonlypreflight실패후새절대경로plan으로진행. 과거once/failed 영수증을지우거나성공으로바꾸지않았다.

## 남은 작업과 다음 정확 명령

1. 미게시pending1(id138985/candidate357316): ai_approved표지만candidateauto needs_review/splitfalse. currentitems admission은입력불일치를skip하고legacy만supersede. stalehint도approved만보기때문에자동정리공백이있다. 별도PR에서인간결정/실행중·미확정capacity/옛세대표보호를유지해cleanup범위를검토한다. 현재직접SQL수정0.
2. 수집3000/h 실제유지미확인/GitHubApp·토큰추가0. 사용자추가질문 검색수집량감소→root현재원인확인/답변완료. B/discovery-bottleneck-readonly-20261027-2.{db,logs}.private.json actual86250 EXIT0/primaryREADONLY07:15:31Z/실제crawler source06ac일치. 06:57:43 first498/53.69분/throttledfalse→06:58:43 first506/54.69분/throttledtrue→07:14:42 first514/68.45분/true. seed.ts:56의 pagesPerTick=1 강제경로가설정10을덮는다. 19admission timedOut0/GitHub rate-auth0/cooldown[]/seed-fetchhas_errorfalse. 최신탐색은6/16진행/waitingfalse라시간당휴지는현재주원인아님. 다음우선작업은AI1처리율진단/복구와발견저장-검수backpressure결합의안전한분리설계,cap·품질·pending저장상한을무작정없애지않는다. sourceagent에도현재로그전달완료. 과거06:18snapshot을현재원인으로쓰지않는다.
3. 기존텍스트품질·진행경보/전체healthyfalse, observer장기/백업DR등은PENDING기존범위. 일시pause를경보해결로쓰지않는다. 모델defaultGPU3090직접qwen3.8-flash-next/abcLLM Supa fallback/no-thinking32k출력10k그대로.
4. 문서PR694 https://github.com/JRVector9/nomorevibe/pull/694 에실제원인추가커밋후최신필수docsCI→exacthead/latestbase확인병합. docs-only이므로앱재배포하지않는다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe-schema-review-report-20261027
git diff --check
git add docs/CODEX_HANDOFF.md docs/operations/2026-10-27-db-schema-review.md
git commit -m 'docs: record DB schema cross-review and production evidence'
git push -u origin codex/db-schema-review-report-20261027
# PR본문은 B/schema-review-pr-body.private.md를사용
# 새운영관측이필요하면새stem만사용(기존once재사용금지):
python3 /Users/jr/.local/state/nomorevibe-reliability-20261025/grok-reconcile-discovery-20261027/read-postdeploy-metrics.py SCHEMA-NEXT-UNUSED --target-sha 06ac66c1ebbb130258eb72a73b0a83dbed6420b1 --deployed-at 2026-10-27T06:56:25.001613Z
```

---

# 독립 schema 리뷰 경계조건 반영 — 2026-10-27 KST15:26

사용자는추가subagent+nativeClaudeCLI Fable5.1 xhigh로스키마개선교차검토를요청했다. schema_performance_review/schema_compatibility_review 모두 gpt-6.1-sol xhigh/forknone/readonlysource이며root는actualClaudeCLI를실행했다. 첫literal fable5.1은404/EXIT1이었고공식claude-fable-5-1 확인후새dir B/claude-schema-fable51-2/PID3389/exec65247로동일모델xhigh재실행중. skills/tools비활성,reviewsource만제공,운영변경0. 모델성공은아직미확인.

성능agent가callback시각의미변경을발견해root최소보완: materialized집합은정적nonterminal superset(reserved는만료포함),hint는원DBwall판정/callback은원JSnow판정유지. 만료가tick후/probe전에오는회귀코드를추가했다. 기존목적전체반복검색제거/unknown/null/unboundfailclosed보호/커서/락순서는같다. PR693 head069eb057 첫CI40460560933는type/lint/build/unit/images성공·integration진행중이었으며최종통과아님. root가새commit/push후필수CI다시확인한다. 로컬test/lint/build미실행.

---

# SQL 보완 root 검토 완료·PR 준비 — 2026-10-27 KST15:20

원본PR691/692는main93794615로병합·운영18앱교체됐다. 공식run은finalprogressalarm으로stopped/EXIT1이며원본once보존·재실행금지. 별도READONLY fullfleet readback는18앱source/digest/env/deployment一致이나guard-blocked였다. OPENaudit20588/epoch1revision3·자기6textresume全6実EXIT0복원완료. 아직전체운영정상으로보고하지않는다.

새stalehint SQL 회귀의최소패치를root독립diff검토했다. 활성보호집합을한번materialize하고각candidateTXfresh재검증하므로미확정요청보호는유지한다. production2+integration1+운영문서+handoff수정. 실제diff --check EXIT0,로컬test/lint/typecheck/build0. 아래agent의계획근거는추정cost이며실측속도개선치아님. root가이제commit/push/PR/필수CI진행한다.

nativeGrok 실제 B/reconciled-grok-check1 PID37099/exec42606는69.08초 EXIT0,groк-4.7xhigh/no-subagents/단일readonlyhelper영수증검증true. 전체건강false/sourceguardblocked를보존했다. 최종문장root검토는아직이며원76정리실제완료0을성공으로승격하지않는다. fullypostdeploy5m(06:14:16Z) 신규고유149/원본행123. 3천/h실측달성아님. discoveryagent가admission/read-only1회조사중이다.

사용자DBconnection/schema질문에대한현황: 실제병목은후보별전체capacity반복검색이며connection증설은보류. 기존active/logicalactive인덱스있지만이번OR/LIKE/regex가충분히활용못함. candidate/secondreview별도typedcolumn+index·완료이력분리는후속설계검토다. 신규migration은이번fix에없다. 원본dirtyWT/oldonce/clean9379OP보존.

---

# AI2 stale 힌트 비용 수정 — 2026-10-27 KST, root 검토·CI 전

목표: 배포93794615에서 stale 조정기 힌트가 용량 이력 전체를 후보마다 반복 읽어 커서 저장 전에 실패하는 문제를 최소 보완한다. branch `codex/ai2-stale-capacity-scan-20261027`은 fetch한 origin/main93794615에서 만들었다. commit/push·운영 쓰기는 하지 않았다.

완료 근거: 승인된 primary READ ONLY 조회에서 기존76행은 pending, owned수요0, 보호capacity0, replay오인식 근거0이었다. `B/ai2-query-phase-rootcause.private.json`의 최근 Drizzle 실패는 stale hint로 식별됐다. `B/ai2-stale-hint-explain-rootcause.private.json`(06:13:56Z, SHA256 `a1f8797c3cf654fc4ace70ec44cd30e3d4efae9997ab8780dde0f2c13c3ec9e2`)은 EXPLAIN ONLY이며 상관 capacity SeqScan cost6035.78/전체574138.10을 확인했다. SQLSTATE는 잘린 wrapper 오류에서 복원하지 못했다. EXPLAIN ANALYZE는 실행하지 않았다.

수정: `lib/crawl/second-review-stale.ts`, `lib/crawl/second-review.ts`, `tests/integration/second-review-published.test.ts` 및 이 인계. 보호 상태 행을 MATERIALIZED CTE로 먼저 선별해 후보별 LIKE/정규식이 전체 이력에 반복 적용되지 않게 했다. 후보 TX에서도 현재 보호 집합을 다시 읽는다. null 예약기한·unknown 상태·불명확 AI2 identity 보호, cursor·lease·락 순서·실행 순서는 보존한다. 후보별 현재 보호 재검증은 각 TX의 상태 선별1회가 남는다.

회귀 코드: 실제 PostgreSQL EXPLAIN의 원본 capacity scan1회/CTE Scan, hint·callback의 active/unknown/null 예약기한/다른 route 보호 일치. 로컬 tests/lint/typecheck/build/컴파일은 미실행이며 CI 결과도 아직 없다. 실패한 기존 접근은 상관 OR/LIKE 보호 조회로 전체 capacity 이력을 반복 읽은 것이다. stale 실행 순서를 앞당겨 오류를 숨기는 변경은 하지 않았다.

남은 일: root diff 검토→필요한 보완→root가 commit/push/PR·필수 CI 후 별도 공식 배포를 결정한다. 기존 release/once 재실행·임의 capacity 회수는 하지 않는다. 다음 읽기 명령: `git -C /Users/jr/Desktop/projects/nomorevibe-ai2-stale-reconcile-20261027 diff --stat`, `git -C /Users/jr/Desktop/projects/nomorevibe-ai2-stale-reconcile-20261027 diff -- lib/crawl/second-review-stale.ts lib/crawl/second-review.ts tests/integration/second-review-published.test.ts`.

---

# AI2 구현 단계 완료 — 2026-10-27 KST14:36, PR 게시·필수CI 전

목표는 stale AI2 수요의 자동 정리→원본/근거 갱신→최신 세대 재등록과 별도 수집3천/h 확대다. 수집PR691은05:27:20Z main683888914db4152a6893dc1dfc164e58ec1f66f6로 병합됐고 main40455412090 필수check/worker·web publish 실제success다. refresh-caches는 기다리지 않는다. 이번 운영 변경·배포는 아직0이다.

AI2 코드 commit `fb86c7319e90a144a3dafa495ebd383743106764`는 최신main6838889에 clean rebase했다. 수정 파일은 second-review/stale helper/job, claims scan demand, generic gate/replay 호출과 관련 회귀12개다. root가 추가로 secondReview off 시 scan수요 공급을 막는 guard와 회귀1개를 넣었다. 두 운영문서 및 이 handoff를 함께 기록한다. native Grok 초안 뒤 EXIT130/1180.36초로 명시 종료했고 성공으로 주장하지 않는다. 구현·독립 검토 agent는 사용자 지정gpt-6.1-sol xhigh다. 최종 코드파일 소유권은 root에게 돌아왔다.

설계: 실제 controllerInputMatches로 세대 외 부적격도 검출, stale-input-reconciler 소유 표만 기한 없이 이어감, fresh 미대상이면not_required, fallback 미완료 root도 함께 닫음, source잠금을 votes/items 앞에 준비하고 사용하지 않은 insert는 rollback, 미확정·활성 capacity를 failclosed로 보호, job cursor를 기존필드와 함께 보존. oversized 후보는 rollback+명시log로 뒤 후보를 막지 않는다. replay/Oracle grant 확대 없음.

수동 tests/lint/typecheck/build/컴파일·합성 모델 호출은 미실행. `git diff --cached --check` 실제EXIT0. 아직 AI2 PR CI는 실행 전이며 통과라고 기록하지 않는다. 테스트코드는 docs/operations/2026-10-27-ai2-stale-reconcile.md의 회귀 범위를 따른다. 실제 DB80개 초과 연속 cursor 접근은 이번 회귀 범위 밖이다.

다음 root 명령: 이 문서/운영문서를 커밋→`git push -u origin codex/ai2-stale-reconcile-20261027`→`gh pr create --base main --head codex/ai2-stale-reconcile-20261027 --title 'AI2: 오래된 재검수 정리·원본 갱신·재등록 자동화' --body-file B/ai2-pr-body.private.md`→필수CI→exacthead 병합→최종main check/이미지→새clean operatorWT에서공식scope/plan/run. runtime환경 DB_POOL_MAX4 유지. 새 `B/read-postdeploy-metrics.py NEWSTEM --target-sha FULLSHA --deployed-at UTCZ` helper는 코드준비만 끝났고 실행하지 않았다. runtimeproof는 별도이며 marker정리와 실제모델성공을 구분한다.

---

# 현재 작업 — 2026-10-27 KST, 수집 PR691 CI·AI2 자동 재등록 구현/검토 병렬 진행

## 현재 목표·제약

오래된 AI2 재검수의 정리→원본 갱신→최신 세대 재등록 자동화를 고치고, 신규 고유 저장소 시간당3,000건 수집 확대를 별도 PR로 진행한다. 사용자가 native Grok CLI 직접 실행과 추가 서브에이전트 병렬 작업을 명시했다. 스킬 사용·수동 test/lint/typecheck/build·합성 LLM 호출 없이 개발하며 필수 GitHub CI를 통과한다. 원 사용자 dirty WT·과거 운영 once 영수증은 보존한다. 아직 이번 작업의 운영 변경·병합·배포는 없다.

## 완료·변경 파일·현재 실행

- 실제 native Grok discovery는 `B/discovery-follow/` end_turn/EXIT0(30turn/585.87초). root가 검토하고 미사용 이론상 수학 모듈을 제거했다. PR https://github.com/JRVector9/nomorevibe/pull/691 , branch `codex/discovery-3000-hour-20261027`, WT `/Users/jr/Desktop/projects/nomorevibe-discovery-3000-hour-20261027`, 최종 head `8d37a58a`(앞선4b620ad1/cc5b3921 포함), 필수 전체 CI success 뒤05:27:20Z squash merge `683888914db4152a6893dc1dfc164e58ec1f66f6` 완료. 운영 배포는 아직 없다.
- 주요 파일: `lib/jobs/catalog.ts`, `scripts/worker.ts`, `lib/crawl/jobs/{seed,fetch}.ts`, `lib/crawl/discovery-admission.ts`, `lib/crawl/settings-schema.ts`, DB pool/host-budget, admin 설정/상태 화면, 수집 회귀 코드·운영 문서. seed60초/discovery lane/30초, fetch 별도 lane/120초/BATCH24/concurrency12, crawler 기본 pool8, maxNewPerHour 기본3000(rolling5분250). 기존 quota/backpressure/품질/중복/role lease 유지. 신규3천 실측은 아직 없다.
- 실제 native Grok AI2 `B/ai2-follow/` PID87390 / exec session94202, session01a17bac-9ae6-7051-9c74-4defb1e70d93, grok-4.7 xhigh --no-subagents --resume --no-plan 65turn으로 진행하다 코드 검토 소유권 이전을 위해 root가 read-only call 사이 SIGINT했다. 실제 EXIT130/1180.36초이며 최종 성공 보고는 없다. WT `/Users/jr/Desktop/projects/nomorevibe-ai2-stale-reconcile-20261027`, branch `codex/ai2-stale-reconcile-20261027`. `lib/crawl/second-review-stale.ts`와 `second-review.ts`에 실제 코드 작성 중이며 최종 native 성공 보고는 없으며 코드의 안전 보완은 ai2_independent_safety_review에 단독 위임했다. 동일 파일에 동시 수정 금지.
- root 발견 검토 사항은 `B/ai2-follow/ROOT_REVIEW.private.md`에 보관했지만 native 종료 뒤 구현 담당에게 전달했다. 예약시간 파싱 failclosed, fallback child ghost, 세대 변경 감지·bounded prefix 기아,7일 뒤 수요 소실, 불명확 capacity binding 보호, source/frontier identity 잠금이 votes/items보다 늦는 순서 문제를 최종 수정 전에 해결해야 한다. 미검토 코드를 운영 배포하지 않는다.
- 추가 서브에이전트는 모두 사용자 지정 gpt-6.1-sol xhigh: discovery_ci_finish(PR691 최신 CI 및 실제 실패 수정 전용), ai2_independent_safety_review(AI2 안전 보완 구현 단독 담당), release_readiness(공식 배포 준비 읽기전용). native Grok와 수정 충돌을 피한다. root integration WT는 이 handoff만 dirty다.

## 테스트 명령·실제 결과·실패한 접근

- 수동 tests/lint/typecheck/build는 실행하지 않았다. `git diff --check`만 실제 EXIT0.
- PR691 첫 CI40453659689/4b620ad1은 타입의 신규 lane 라벨 및 unit의 기존 budget/pool 기대값 실패. 다음40453993018/cc5b3921은 타입/빌드/린트/이미지 성공, unit의 추가 pool/budget 기대값과 fetch 동시성 시간 경합 실패. 모두 최신8d37a58a에 수정했고 과거 run은 cancelled다. 실패를 성공으로 기록하지 않는다.
- 최종 CI40454513467/8d37a58a는 completed/success. typecheck/lint/build/unit2/integration6/ledger/PR이미지2개 및 필수check(05:26:33Z) 실제 success. root가 latestbase1cfd1ba/exacthead8d37/mergeableCLEAN을 확인한 뒤 병합했다. 동시성 회귀는 wall-clock 지연 대신 첫12개 page 요청이 모두 도착하는 barrier로 바꿨다.
- AI2 첫 native Grok는 provider403/EXIT1/107.76초. AI2 retry와 discovery 초기 호출은55turn max_turn 상한으로 코드 없이 종료했다. discovery만 후속에서 실제 구현/보고까지 완료했다. AI2 follow는 구현 중이다. 과거 실패 또는 시작을 완료로 쓰지 않는다.

## 운영 근거·핵심 결정

14:23:58 readonly 추가 snapshot `B/predeploy-live.private.json`: 신규 고유/원본 최근60분355/355, pending76그대로, 실제AI2최근1h agreed16/needs_human9/resolved39. 전체AI2중단이 아니라 stale 수요고립이다. `B/predeploy-monitor.private.json`은 공식 monitor의 역할·scheduler·전체worker progress 관문 passedtrue/blocking[] (운영변경0).

- 시작 base1cfd1bab8c2563eb5f842757ae8d5698b97bbb27, 현재 main683888914db4152a6893dc1dfc164e58ec1f66f6, 운영 runtime50be0d706b9562067a44867d239d0362bc83892b. private B=`/Users/jr/.local/state/nomorevibe-reliability-20261025/grok-reconcile-discovery-20261027` (0700/0600).
-13:41:38 KST readonly baseline60분 신규 고유383/원본382,15분59/59,5분1/1. AI2 pending76(게시75/미게시1), 최장10/26 09:51:38 KST. 현재 Supa dispatched1/예약2가 있어 TTL 강제회수 금지. 당시 실제 loader에서76모두 generation mismatch였고 published slug inputHash는 의도된 값이다.
- 기존 M3 REST quota는 서로 다른 env PAT JRVector9 + DB PAT lollol-jr + findai App의 총15,000/h. 같은 계정 PAT 추가는 한도를 늘리지 않는다. Oracle App installation172855274 제외를 유지한다. 토큰 추가 없음. 전체 repo별 원본/agent 요청까지3천/h를 감당하는지는 실측으로 확인한다.
- 실제 crawler-m3/mini/agent-scan은 명시 DB_POOL_MAX4, HOST_DB_BUDGET 비활성이다. 기본8은 현운영을 바꾸지 않는다. 추가 검토에서 HTTP12 동시성은 DB transaction 밖이고 짧은 저장만 pool을 쓰므로 명시4를 유지하기로 결정했다. 공식 run은 runtime env변경을 허용하지 않으므로8변경용 추가배포도 하지 않는다. 실제 풀대기/DB오류/처리율 관측으로 병목 때만 별도 조정한다. 수집 PR의8필수 문장은 AI2 PR에서 정정한다. DB max150/관리예약3/관측 전체68(일부 필드 권한상NULL), 순간 headroom은 있지만 장기관측 보장은 아니다.
- AI2 정리는 product→candidate→source→votes→items→job lease 순서와 capacity dispatched/indeterminate/유효예약 보호를 지켜야 한다. 인간 결정/과거투표 변경 없이 원래 수요를 최신 세대로 멱등 생성한다. 임의7일 경과로 수요가 사라지면 안 된다. Oracle claim-only/replay grant를 넓혀 우회하지 않는다.

## 남은 일·다음 정확한 명령

1. AI2 구현 담당 완료 diff를 root 독립 검토→위6개 이슈 해결→별도 PR/필수 CI. AI2 구현 담당 파일을 동시에 수정하지 않는다.
2. PR691 병합 완료(main6838889). AI2 구현 commit 뒤 이 base로 rebase해 별도 PR/필수CI. 자동배포는 없으며 두 변경을 함께 공식 배포한다.
3. crawler/agent-scan 환경값4 유지→clean mergedmain WT에서 scope/plan/run. 공통 lib 변경이면18앱 대상. 과거 once 또는 알 수 없는 provider request TTL 해제 금지.
4. canonical saveSettings CAS로 discovery 설정만 변경, 실제 자동 정리·refresh·새 검수 결과와 수집량 관측. native Grok 읽기전용 운영 재검증 후 root가 원본과 대조.3천/h는 실제60분 관측 전 달성으로 보고하지 않는다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe-discovery-3000-hour-20261027
gh run view 40454513467 --json status,conclusion,jobs
cd /Users/jr/Desktop/projects/nomorevibe-ai2-stale-reconcile-20261027
git status --short
git diff --stat
```

private `B/ai2-follow/{exit.private.json,REPORT.private.md,ROOT_REVIEW.private.md}`가 다음 근거다. 같은 output stem/once 영수증을 재실행하지 않는다. 아래는 이전 완료 단계의 역사다.

---

# 현재 — 2026-10-27 KST12:09, PR689 병합·운영 반영·10분47초 재검증 완료

목표: checkMini 중복/반복 알림을 실제 Grok CLI로 수정하고 root가 운영 결과를 대조한다. 스킬·수동 test/lint/typecheck/build/컴파일·합성 모델 호출·시험 Telegram 금지 유지. 원 사용자 dirty WT와 pinned686/687 운영자 WT는 보존했다.

## 완료·변경·판단

- PR689 최종head4729e6e3(코드bd36a09f), 자동 CI40440673155의 타입·린트(Python 회귀 포함)·빌드·unit2·통합6·ledger·두 이미지·필수check 실제 success. 02:57:29Z merge225965189581877e59bc5e1cac5a00b288fdfc7b. main40441430068도 검사한 트리를 재사용해 필수check success.
- Grok가 `scripts/ops/incident_notifications.py`와 `tests/test_oracle_watchdog_notifications.py`를 수정했다. pipeline_alarm은 명시적 정상600초/표본간격≤150초 뒤 전송완료 기록을 해제한다. 짧은 회복·재시작·누락/불완전 보고·시간역행은 같은 장애를 재무장하지 않는다. 다른 고장/provider/receiver 처리는 유지. 새 회귀4개를 수동 실행 없이 자동 CI에서 검증했다.
- root가 `scripts/ops/deployment_scope.py`와 기존 scope 회귀 목록에 Oracle 별도 설치 파일의 정확한 경계만 추가했다. Docker에서 scripts/ops 제외·Node production caller 부재를 확인했다. 실제 `npm run deploy -- scope --base f483704184b81ea167bc3a0d7e4145e48c10cac1 --sha 225965189581877e59bc5e1cac5a00b288fdfc7b`는 selected0/retained18/mode none. 웹·워커 재배포0. 문서는 이 파일과 `docs/operations/2026-10-27-alert-notification-fix.md`.
- mini02:36:33.286Z 72/73, Oracle02:38:00.209Z 1/2의 notification1 연결만 제거. 모니터·알림 정의·수집/상태 이력·다른 연결과 mini74/Oracle3 heartbeat 알림 보존. 네 monitor 자체를 삭제한 것이 아니다. 매 전송 시 연결 DB를 SELECT하는 실제 Kuma2.3.2 소스 SHA20e3d6e…를 확인한 뒤 짧은 CAS 트랜잭션으로 제거했다.
- **02:58:24.745Z Oracle notifier 설치·watchdog1개 restart 성공**. merged source SHA256 `3b0305a89cb2050df0174c61e3ab1964e6e6df610404914ca6d9ec3f647f9550`, 이전8d5b190c…를 CAS/원자교체. PID3224044→4036892, active/running/NRestarts0. config SHA 불변, state0600과 pipeline senttrue/firstSeen1793069494.7789228 보존. root0644 `/opt/nomorevibe-watchdog/incident_notifications.py`; 원본 backup0600 `/var/lib/nomorevibe-watchdog/alert-fix-20261027/incident_notifications.before.py`.

## 실제 운영 검증

PRIVATE `STATE=/Users/jr/.local/state/nomorevibe-reliability-20261025/grok-alert-spam-fix-20261027`(0700/0600). 두 routing apply once와 root-watchdog-install.once는 **소비됨, 재실행 금지**. 설정·상태를 과거로 덮거나 이전 recovery/deploy/observer once도 재실행하지 않는다.

코드 Grok 세션01a17b2c-9d73-7062-8c7b-b917ae23eb5f는12turn/end_turn/EXIT0. 최종 `code/REPORT.private.md`와 diff를 root 대조. routing 준비 초기/후속 상한 종료는 보존했고 최종response는 end_turn. `routing/REPORT.private.md`는 실제 최종 응답이다. Grok routing helper는 apply하지 않았다.

운영 Grok 세션01a17b4b-c990-76f3-a268-d0730e21698d는2turn/end_turn. 직접 `python3 STATE/root-final-readonly.py`를 실행했고 operator EXIT0/productionMutations0. 실제 SSH로 source/systemd/state/journal와 두 Kuma SELECT를 읽었다. `FINAL_GROK_REPORT.private.md`와 `grok-final-live/{watchdog,mini,oracle}.private.json`을 root 대조. 이 첫 Grok 표본은 설치38.61초/1cycle이며 업무 pipeline_alarm은 그대로, 전송0이었다. helper oktrue는 구조 검증 성공이며 업무 전체정상을 뜻하지 않는다.

root 독립 재읽기03:09:11.416Z(`root-final-watchdog.private.json`)는 설치646.67초 후 실제18cycle(경보16/정상2), notification sent0/accepted전부NULL/pending전부0, failedCycles0, Push·heartbeat 각2개 ACKtrue, source/config 동일·PID4036892/NRestarts0. 기존 pipeline senttrue/firstSeen 유지하고 실제 정상2표본 뒤 clearSince1793070482.034188/lastClearAt1793070517.507393가 생겨 즉시 지워지지 않음을 확인했다. **600초 연속 정상 관측은 아직 아니며**, 전체10분47초를 연속정상10분으로 쓰지 않는다. mini03:09:08/Oracle03:09:11 재읽기도 target link0/heartbeat link1·정의/다른 링크 보존.

사용자가 보낸11:28/29/37/39/51 알림은 notifier 설치11:58:24 전이다. 특히 기존 firstSeen은 KST11:51:34.778923이며 설치 후 그대로 유지됐다. 사용자가 재질문해 실제 native Grok가 별도 `root-final-readonly.py recheck`를 실행했다. `grok-final-live-recheck/`의 원본을 root가 대조:03:10:54Z/설치749.62초·21cycle(경보16/정상5), 전송0/실패0, 원 firstSeen과 senttrue·정상 streak142.51초 보존, source/config/PID 동일. 두 Kuma도 네 링크0/heartbeat1 유지. 재조회 Grok 세션01a17b56-a9fc-73b0-a983-3b7ecf044257는2turn/end_turn, operator EXIT0. 최종응답 `STATE/FINAL_GROK_RECHECK_REPORT.private.md`를 root가21개 원본 cycle과 대조했다. 사용자11:37 메시지는 분 단위이므로 Grok가 임의 계산한 제거 전후 초 차이는 채택하지 않았다. 실제 기록된 적용시각과 설치 후 전송0만 근거로 쓴다. 600초 연속 실제 정상 해제는 아직 관측하지 않았다.

## 실패·남은 일·다음 명령

첫 CI40440628344는 handoff EOF 공백으로 scope 실패했다. 4729e6e3에서 문서 순서/EOF를 고치고 base→head `git diff --check` 및 최신 전체 CI 성공. Grok routing 상한 종료를 성공으로 쓰지 않는다. Oracle public SSH 간헐 불통은 기존 host key를 HostKeyAlias로 검증하는 Tailnet 경로로 해결했다. hostkey 검증 해제·비밀 출력 없음.

운영 반영과 root 독립 검토·Grok 재확인/최종응답 보관은 완료했다. 이 기록은 후속 docs-only PR로 반영하며 앱 재배포 대상0이다. 병합 상태는 이 문서 branch의 GitHub 필수 check/PR 상태로 확인한다. 번역 등 실제 업무 적체와 장기 관찰은 별도 과제이며 이번 알림 변경으로 해결했다고 주장하지 않는다. 모델/큐/용량·품질 관문은 유지했다.

```bash
# 읽기 전용: 최신 Grok 검증 결과가 생성되면 확인한다.
sed -n '1,180p' /Users/jr/.local/state/nomorevibe-reliability-20261025/grok-alert-spam-fix-20261027/FINAL_GROK_REPORT.private.md
# 추가 read가 필요할 때만 OUT을 새 private 절대 경로로 준다. install/apply 재실행 금지.
python3 /Users/jr/.local/state/nomorevibe-reliability-20261025/grok-alert-spam-fix-20261027/root-watchdog-rollout.py observe OUT 1793069904.7450373
```

아래는 이전 진행 기록이다. 위 최신 상태가 우선한다.

# 진행 중 — 2026-10-27 KST11:38, Grok 알림 반복 수정·중복4경로 운영 반영

사용자가 원인보고만으로는 해결되지 않았다고 확인하고 실제 native Grok CLI로 수정/운영반영/결과검토를 지시했다. 이번 objective는 반복 알림 해결이며 번역 backlog 품질기준·모델·DB큐/용량 정책을 바꾸지 않는다. 스킬/수동 테스트·lint/compile/build·합성 모델 호출 금지 유지. 필수 GitHub 자동CI는 유지한다.

- 새 WT `/Users/jr/Desktop/projects/nomorevibe-grok-alert-spam-fix-20261027`, branch `codex/grok-alert-spam-fix-20261027`, origin/mainf4837041. 원 사용자 dirtyWT·직전 조사WT·pinned686/687 운영자 WT는 그대로.
- PRIVATE `STATE=/Users/jr/.local/state/nomorevibe-reliability-20261025/grok-alert-spam-fix-20261027`(0700/0600). nativeGrok code58193 진행 중, 소스77줄 patch까지 작성(아직 root최종검토/자동CI/병합/설치 전); routing40287는18turn상한, 후속27771는검토가능helper 준비중(아직apply권한 없음). Grok 결과 확인 후 root가 검토한다. 새 codex subagent 없음.
- **실제 운영 중복 경로 적용 완료**: root가 두 Kuma2.3.2 설치 소스 `Monitor.sendNotification`→`getNotificationList`가 매 전송마다 DB association을 다시 SELECT함을 직접 확인(두 호스트 SHA20e3d6e 동일). API자격 미발견으로 liveSQLite 일괄수정 금지라는 초기 자체가정을 이 증거로 좁혀, 정확한 notification association만 guarded BEGIN IMMEDIATE로 제거했다. Kuma/worker재시작·전역기본알림변경·보안우회 없음.
- mini02:36:33.286Z 대상72/73 notification1 각1행 삭제·readback 성공, 링크42→40/모니터42그대로. Oracle02:38:00.209Z 대상1/2 각1행 삭제·readback 성공, 링크3→1/모니터3그대로. mini74/Oracle3 생존알림 link1 보존. 전체 monitor행/notification정의/비대상links unchanged 실제검증. 두 apply once **소비됨, 재실행 금지**. helper `root-kuma-link.py/js`, plan/영수증 `root-kuma-{mini,oracle}-{prepare,apply}.private.json`.
- 실제 Oracle 별도알림 경로 configuredtrue·serviceactive·NRestarts0/1프로세스, 기존 pipeline incident senttrue를 확인하고 중복4개만 분리했다. 장애별 directTelegram 알림은 그대로이며 수신테스트 메시지는 보내지 않았다. 잠깐 회복 시 sent기록을 지우는 문제의600초 연속회복 코드는 아직 설치 전이다.
- root `scripts/ops/deployment_scope.py`에 `incident_notifications.py`의 정확한 Oracle별도설치 경계만 추가하고 기존 scope test목록을 확장했다. .dockerignore에 scripts/ops 제외, Node production caller없음 확인. 웹/워커18앱은 다시 배포하지 않는다. Python모듈은 Oracle 설치+watchdog1개 controlledrestart로 반영한다.

남은 작업: nativeGrok code/tests/REPORT 완료→root review(명시적정상만연속600s/간격150s/unknown·clock rollback/reset/재시작보존/unsent전송)→commitPR/필수 자동CI/merge→Oracle notifier파일만 installedoldSHA8d5b190c…에서 새merged소스로 CAS교체, 설정/상태보존, watchdog1개 restart→실제해시/PID/정상cycle/보존된sent/latch/두Kuma추가readback 확인. 수동테스트 실행금지. 아직 commit/CI/merge/sourceinstall을 완료라고 주장하지 않는다.

Oracle root검토 연결: public onetwoday SSH는간헐unreachable이어서 기존 알려진키를 HostKeyAlias로 검증하는 Tailnet경로 사용. `ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes -o HostKeyAlias=161.33.31.250 -i /Users/jr/.ssh/id_rsa_oci_osaka ubuntu@onetwoday.tail02799e.ts.net` 성공(hostnameonetwoday/active 확인). Source `/opt/nomorevibe-watchdog/incident_notifications.py` root0644. Config `/etc/nomorevibe-watchdog/config.json`와 state `/var/lib/nomorevibe-watchdog/state.json`은 건드리지 않는다. 기존 소스·configSHA·incident beforeimage는 `STATE/root-watchdog-before.private.json`에 보존. 민감값 stdout/Git금지.

정확한 다음 읽기:
```bash
git -C /Users/jr/Desktop/projects/nomorevibe-grok-alert-spam-fix-20261027 diff --stat
# Grok 보고서가 생성되면 PRIVATE로 읽고 실제diff와 대조
sed -n '1,220p' /Users/jr/.local/state/nomorevibe-reliability-20261025/grok-alert-spam-fix-20261027/code/REPORT.private.md
```

아래는 이전 완료 단계 기록이다. 위 진행상태가 우선한다.

# 현재 인계 — 2026-10-27 KST08:37, PR687 전체18 배포·접수/6잡 원복 완료

**운영 코드50be0d706b9562067a44867d239d0362bc83892b, capacity OPEN 감사20533, text6잡 모두 재개 감사20534–20539. DeepSeek8dc withdrawn 감사20523. 유지보수·회수·배포·종료/복원 once를 다시 실행하지 않는다.**

## 목표·완료한 구현

사용자는 실제 Grok CLI 병렬 실행으로 DeepSeek 미확정 점유와 reviewer 반복 재시작을 해결하고, 재발 방지 및 종료원인 로그를 구현·병합·배포하라고 지시했다. 스킬은 사용하지 않았다. 사용자 dirty 원본 WT와 clean686/687 운영자 WT는 수정하지 않았다.

- 실제 native Grok3개 독립 WT에서 실행. 각20turn source탐색 후 focused continuation physical62633/guard62302/logging63772 모두 EXIT0. root가 결과를 독립 대조했다. guard/logging 소스는 통합했고, physical factory/report는 root 실제 회수 이후의 stale 준비 산출물이어서 미실행·미채택이다. 그 명령을 실행하지 않는다. PRIVATE `ROOT_GROK_REVIEW.private.json`에 각 보고서 SHA·채택/수정 범위를 남겼다.
- FIRST/SECOND의 **현재 OPEN 정책·route·fence·최근 미만료 waiting·실제 group/provider/pool/global 포화**가 입증될 때만 단계 restartEligiblefalse. no_progress 경보/대기량을 유지하고, 실제 job/poll timeout lane과 다른 잡·독립 AI consumer의 복구 판정은 유지한다. 현재 queueTtlMs120000/reservationTtlMs30000이다.
- 동일 보고서에서 고른 실제 재시작 트리거의2표본(stage/lane/reason/age/wait/progress), role/instance/boot/release/epoch와 실제 abort/signal/lease cause/drain/exit를 JSON 로깅. 제어된 프로세스 종료 직전 boot별 `operations_observations`의 `worker-exit:<role>:<boot UUID>`에 최대2초 best-effort 기록. 새 종료를 만들기 위해 인위적으로 재시작하지 않았다. 이번 새 boot는 종료가 없어 durable exit 실제 표본은0이며 저장 성공을 관측했다고 주장하지 않는다.
- root가 Grok 초기 inactive-FIRST 적용 누락 수정 여부, 객체 restartEligiblefalse 보호를 확인했다. 추가로 선택 writer의 동기 throw/비Error 거절도 종료를 막지 않게 고정 code 처리하고 watchdog lease만료/renew기한을 구분했다.

## 실제 DeepSeek 종료·단건 회수·원복

PRIVATE `STATE=/Users/jr/.local/state/nomorevibe-reliability-20261025`, 이번 자료는 `STATE/grok-fix-20261027/`다(0700/0600). raw env·credential·binding·prompt·Docker 원문은 Git/공개 로그에 넣지 않는다.

1. 공식 DRAIN20521 후 native PID50759/PGID50759 launchd disable→bootout ACK 각0으로 종료. 다음 owner reviewer와 M3/mini gateway의 실제 private PID namespace 종료/Docker wait0·replicas0·교체없음을 확인했다. 사용자 즉시 종료 지시로 provider가 먼저였으며 stop 순서를 거짓으로 바꾸지 않았다.
2. 원 owner durable group exit, local-end, strict V2 plan/실제 경계종료와 모든 경계 뒤 native 부재 재관측23:05:54.709Z로 공식 dry-run 성공/rollback 후 apply **audit20523/event95577** 단1회. dry-run20522는 committed audit가 아니다.
3. 독립23:09:41 사후 읽기 및23:36:56 최신 읽기에서 request8dc `withdrawn`, releaseevent1, bindingunchanged, charge/totalbound262144·settledNULL. 원 failed/cancelled attempt121607과 보류 후보를 성공으로 바꾸지 않았다. 모델 정상응답·사용량 정산을 주장하지 않는다.
4. 같은 boot/config/plist/entry의 native 새 PID72251·listener8010 일치·인증 health GET200을 실제 확인했다. 원 spec/image로 gateway-mini version45688 / gateway-m3 6239607 / owner6239614 복원 verifiedtrue. 첫 OPEN20524 후 FIRST/AI2 자연 진행도 확인했다.

## PR·CI·운영 배포 완료

- PR687 code commitc602c156, 자동 CI40418372835 **전체 success/필수checksuccess**. 타입·린트·빌드·unit2묶음·통합6묶음·ledger·두 PR이미지 실제 자동 통과. inactive-FIRST 대기/진짜 hung lane/다른job 차단의 새3회귀 포함. **수동 test/lint/typecheck/build/컴파일·합성 모델 호출은 실행하지 않았다.** `git diff --check`만 실제 통과했다.
- 실제 병합 **23:22:52Z**, main50be. main CI40419359154는 tested-tree 재사용해 필수check와 두 image publish success. refresh-caches를 기다리지 않았다. worker digestce67a6c45e7a3b6de1ea72b4ca34d3df98cd0fa38f6d5d3421e1b9fb547fc5da, web e9f42c3bdd2e5fa3b13417117b1c8c1eedcc02ad029ed7fb58183dd5038bd89f.
- clean operator `/Users/jr/Desktop/projects/nomorevibe-release-687-20261027` HEAD50be를 보존한다. fast deploy scope/plan/run 사용. 공통 lib 변경으로 전체18 선택, 모두34cc인 baseline과 원 replica/spec/serving 설정을 대조하고 두 호스트 prePull. DDL 변경 없음.
- 배포 전 공식 DRAIN **20526**. 실제5표본/20.3초 뒤 **23:23:52.459Z unexpiredreserved/dispatched/indeterminate0** 확인. 단순 만료로 unknown을 회수하지 않았다. 첫 raw count에는 이미 만료된 reserved3행도 나왔으므로 `reserved_until > clock_timestamp()`를 적용한 실제 active 읽기와 구분한다.
- `release-687/plan.private.json` SHA **d24ea02a5c71d446388874da33952a17d7e9347b54e3140ff0e7a430ac478367**. run78737 한 번 실행, **23:35:04.133843Z EXIT0/deployed-and-verified**. selected/deployed18, skipped0, retained0, failed0, 앱 실제 새 deployment/source/image/health·원복자료·public gate 확인. final snapshot SHA **cc4679873fd625ab800089628580a019ba7dafd29c1e51c77f21c9872c6b49cc**.
- 초기 DRAIN progressok 뒤 tagline-ko 기존 오류가23:30:55 다시 관문을 막았다. 원 오류·lease/cursor/version을 보존한 공식 text6잡 계획 일시정지 **20527–20532**로 유지보수 관문을 통과했다. 이 상태의 progressok는 OPEN 업무 전체정상 인증이 아니다.
- 모든 앱 확인 후 공식 OPEN **20533**, own pause 영수증만으로 새 resume-plan/apply 실행 **20534–20539**,6잡 모두 pausedfalse. 계획된 pause·DRAIN을 남기지 않았다. 기존 intro Claude미계약1개는 deferred 유지, serving 모델/한도/정책/AI2 설정 그대로.

## 최신 실제 관측·남은 한계

- **23:36:56.332Z** `final-db-open.private.json`: OPEN/epoch1/revision3, 원8dc withdrawn·releaseevent1·정산NULL·binding/charge보존. 전역 indeterminate0. 정상 FIRSTdispatched1·GPU3090unexpiredreserved1,5역할 모두 새50be M3 owner/unexpired.
- **23:36:56** reviewer 주·예비 실제4파일 SHA 일치, healthy, restartCount0. CID m3 `2543025f9259`/mini `dec4d604b9a1`가23:33:07 표본부터 **약229초 동일**이다. 새 종료/반복재시작 이벤트 없음. 시작은 각각23:32:14/23:31:56으로180초도 경과했다. 이것을 장기 무장애 증거로 확대하지 않는다.
- **23:37:01.123654Z** 공식 운영 progress: FIRST 진행5분4/SECOND3, lane alarm0. **overallalarm**: reason-translate waiting9371/no_progress, keywords14644/upstream_stalled, product-translate113738/upstream_stalled(errors5m4), tagline-ko540/upstream_stalled. 별도 실제 업무 경보이며 이 PR에서 해결했다고 쓰지 않는다. 다시 pause하거나 오류/품질 관문을 완화하지 않는다.
- stock observer는23:35:04.148914Z PID14178로 한 번 시작,5/10/15분/6시간, productionMutations0/**futurePassedfalse**. 표본은 실제 due 후에만 읽는다. OPEN text 경보로 실패할 수 있고 실패 시 원본을 보존하며 재시작/과거시각 소급통과 금지. 별도24시간 관측은 남는다.
- response_only provider의 request별 취소 ACK/서버 강제실행기한 자동화는 **설계 후속**이다. 배포 시 DRAIN→실제 진행요청 종료대기(최대3분, 남으면 교체중단)→교체/확인→OPEN을 지킨다. TTL/clientabort를 provider종료로 해석하지 않는다.

## 파일·실패·다음 agent 명령

구현7파일: `lib/operations/capacity-admission-block.ts`, `worker-progress-query.ts`, `scripts/role-worker.ts`, `worker-supervisor.ts`, `tests/worker-progress-items.test.ts`, `docs/CODEX_HANDOFF.md`, `docs/operations/2026-10-27-reviewer-restart-recovery.md`. 이번 후속 문서 branch `codex/reviewer-recovery-report-20261027`는 docs/PENDING만 수정하며 앱 재배포 대상이 아니다.

실패 보존: native stop ACK 뒤 macOS disabled parser가 `=>disabled`를 true문법만 허용해 후검증 실패. 별도 실제 부재 재관측으로 판단했고 stop 재전송하지 않았다. 최초 Docker readonly 이중user SSH255는 barehost 읽기로 수정(변경0). auto-merge는 저장소 설정상 불가해 요청 실패/상태변경0, 필수CI 완료 후 정상 merge했다. pause 전 태그라인 관문대기는 오류를 숨기지 않고 유지보수 pause/resume 감사로 남겼다.

후속 문서PR 상태는 GitHub의 실제 merge/check로 확인한다. 미병합이면 필수CI 후 병합하고 docs-onlyscope0을 확인하며, 병합됐으면 별도 남은 업무 경보·장기 관측 읽기만 진행한다. 배포·회수·stop/restore·capacity·pause/resume once를 다시 실행하지 않는다.

```bash
git -C /Users/jr/Desktop/projects/nomorevibe-grok-fix-integration-20261027 status --short
# 새 조회만 필요하면, NEW_OUTPUT은 이전에 없는 PRIVATE 절대 경로다.
python3 /Users/jr/.local/state/nomorevibe-reliability-20261025/grok-fix-20261027/root-final-db.py NEW_OUTPUT
# observer 기존 파일을 읽기만 한다. sample 재실행/driver 재시작 금지.
cat /Users/jr/.local/state/nomorevibe-reliability-20261025/grok-fix-20261027/release-687/execution/observation/summary.private.json
```

아래는 당시의 진행 기록이다. 위 최신 실제 완료·남은 경보가 우선한다.

## 목표와 완료

사용자 요청: Grok CLI를 직접 병렬 실행해 DeepSeek 미확정 점유와 reviewer 반복 재시작을 해결하고, 재발 방지 및 종료 원인 로그를 구현·병합·배포한다. 스킬·수동 테스트/lint/tsc/build/컴파일·합성 운영 모델 호출 금지 유지. 자동 필수 CI는 유지한다.

- PRIVATE `STATE=/Users/jr/.local/state/nomorevibe-reliability-20261025`, 이번 root 산출물은 `STATE/grok-fix-20261027/`. 0700/0600, raw env·binding·token·SSH 원문은 Git/대화에 복사하지 않는다.
- root integration WT `/Users/jr/Desktop/projects/nomorevibe-grok-fix-integration-20261027`, branch `codex/reviewer-recovery-20261027`, base8bbd50ce. 원 사용자 dirty WT와 clean pinned operator `/Users/jr/Desktop/projects/nomorevibe-release-686-20261027`(34cc2045)은 수정하지 않는다.
- 실제 native Grok CLI3개 독립 WT 병렬 실행. 초기 세션 physical89316/guard69172/logging48345는20turn 소진해 source 탐색만 길어졌고, focused continuation physical62633/guard62302/logging63772로 구체 산출물 작성. guard62302 EXIT0, source·REPORT root 검토. logging63772도 EXIT0·최종 코드/REPORT 검토. physical62633은 최종 보고 확인 중. 실행만으로 해결을 주장하지 않는다.
- 공식 capacity DRAINING **audit20521** 실제 적용, epoch1/revision3/한도·정책 유지. native PID50759/PGID50759는 launchd disable→bootout ACK 각0으로 실제 종료했다. 이후 owner reviewer와 M3/mini gateway Docker private PID namespace를 각각 실제 종료·Docker wait0/replicas0/교체없음 확인했다. 사용자 즉시 종료 지시로 **native provider를 먼저 종료**했으며 일반적인 owner→gateway→provider stop 순서로 기록하지 않는다.
- 실제 V2 plan(23:04:00.512Z)/각 경계 stop readback/모든 경계 종료 뒤 native 부재 재관측23:05:54.709Z로 증거를 구성했다. source554파일/설정·entry·plist SHA 유지. 공식 strict V2 schema/plan hash 확인 후 dry-run 트랜잭션 성공·rollback(20522는 committed audit 아님), 별도 apply **audit20523 / release event95577** 성공.
- 독립 primary 사후 조회 **23:09:41.092566Z**: request8dc0c418-034e-4163-bd62-36d9c9fe2802 `withdrawn`, m3-mlx active0. binding unchanged, charged/totalbound262144·settledNULL 유지. attempt121607 failed/cancelled/outcomeNULL, candidate293769 needs_review/미발행 유지. 실제 점유 회수이며 모델 정상 응답·사용량 정산·업무 성공을 주장하지 않는다.
- root native restore once 성공: 같은 plist/entry/config, 같은 host boot, **새 PID72251**, listener8010=newPID, identity/static stable, 인증 포함 `/v1/models/status` GET200(추론0). Docker 원본spec/image 복원 gateway-mini version45688 / gateway-m3 6239607 / owner6239614, 모두 verifiedtrue·새CID. stop/restore once 재실행 금지.
- OPEN 복귀 dry-run은 기존 `product-intro-check/claude-cli/sonnet no_contract`1개만 deferred. 기존 FIRST abcMLX/AI2 GPU3090 direct+Supa abc/나머지 serving계약 보존을 검토해 `--allow-deferred-routes`로 공식 dry-run blockedfalse 확인. reviewed SHA306f4f1646b3091788d1e9b3e90cffcc44e549d81b1758ccfce6d9987a81de21. apply EXIT0 **audit20524**. 독립23:12:15 실제control OPEN/epoch1/revision3, 기존8dc withdrawn 유지, **새 FIRST crawl-agent-review dispatched1**을 확인했다. 정상 자연 접수가 다시 시작됐다.

## 변경 파일·결정

- guard Grok: `lib/operations/capacity-admission-block.ts`(신규), `lib/operations/worker-progress-query.ts`. 실제 OPEN/현재policy·fence·미만료waiting·route일치·공유group/provider/pool/global 한도 포화가 입증된 FIRST/SECOND만 restartEligiblefalse. 경보·reason·대기량은 유지하고, 실제 hung lane/다른job/독립consumer 재시작 정책을 바꾸지 않는다. 초기 inactive-FIRST wiring 누락은 Grok 최종 diff에서 수정됨(root 확인).
- logging Grok: `scripts/role-worker.ts`, `scripts/worker-supervisor.ts`, 운영문서. 동일 progress 보고서의 stage/lane/reason/age/wait/progress·2표본과 instance/boot/release/epoch, 실제 abort/signal/lease cause/drain/exit를 JSON 로깅. boot별 operations_observations worker-exit 키로 종료 기록, 제한2초 best-effort. 객체 restartEligiblefalse는 재시작하지 않도록 코드 root 확인. 최종 diff 통합/검토 완료. root가 종료기록 동기throw/비Error실패도 고정code로 처리하고 watchdog의 lease만료와renew기한을 정확히 구분했다.
- AI2 primary GPU3090 Tailscale / Supa via abc fallback / no-thinking / total32k output10k 설정은 유지한다. DDL·회수 증거 schema 변경 없음.

## 실제 실패와 실행 결과

- native stop은 실제 ACK 각0 뒤 후속 검증 parser가 macOS `=>disabled`를 `=>true`만 허용해 실패했다. SSH0만으로 성공 판정하지 않았다. 별도 read-only22:56:15 및23:05:54에서 oldPID/PGID ESRCH·unloaded·disabled·listener없음으로 확인했고 stop 재전송하지 않았다. 복원 parser는 enabled/disabled/true/false 모두 처리했다.
- root 최초 Docker readonly는 SDK에 root@host를 전달해 SSH255(이중user)였고 barehost로 읽기만 수정했다. 실패에서 mutation없음.
- OPEN 첫 dry-run deferred_routes:1 차단은 정책 우회가 아니라 기존 미계약 소개 route임을 exact route readback으로 확인했다. 신규 모델·권한·정책 변경 없음.
- 수동 테스트/lint/typecheck/build/컴파일/합성 model probe는 실행하지 않았다. 운영 identity/DB/health GET readback, 공식 operator schema/argument 검증과 dry-run/apply만 실행했다. CI는 아직 새 PR 전이라 미실행. tests/worker-progress-items.test.ts에 inactive-FIRST capacity 대기/실제 hung lane/다른job 차단 회귀를 작성했고 수동 실행하지 않았다.

## 남은 작업·정확한 다음 명령

1. OPEN20524/실제 새 FIRST접수까지 독립 확인했다. 23:13:19 공식운영 progress 읽기에서 FIRST progress5m4/SECOND5, reviewer lane reason없음, 동일 복원CID b71e0271eaf1 확인. 전체overall은 기존text 경보로 alarm이며 전체정상PASS를 주장하지 않는다. 기존 stop/release/restore/apply once는 재실행하지 않는다.
2. Grok63772/62633 최종 보고·diff 검토→integration WT에 guard/logging 파일만 통합→구체 미비점 수정→커밋/PR/필수 최신base CI/병합. 사용자 지시로 수동 테스트는 실행하지 않는다.
3. 새 merged main clean operator에서 일반 fast deploy scope/plan/run. 공통 lib 수정은 전체18 scope이며 실제 baseline에 따라 선택/유지한다. 모델 호출이 살아 있을 때 교체로 unknown을 만들지 않도록 공식 DRAIN+실제 inflight0 확인을 먼저 수행한다. 자동TTL회수/기존once재사용 금지.
4. 실제 source/runtime, 자연 발생 FIRST 모델처리·점유 감소, reviewer 동일boot ≥180초, 새로운 종료 로그를 읽기 전용으로 확인한다. 미래6h/24h는 통과로 기록하지 않는다.

```bash
python3 /Users/jr/.local/state/nomorevibe-reliability-20261025/grok-fix-20261027/root-reconcile-after.py
git -C /Users/jr/Desktop/projects/nomorevibe-grok-fix-integration-20261027 status --short
sed -n '1,200p' /Users/jr/.local/state/nomorevibe-reliability-20261025/grok-fix-20261027/guard/REPORT.private.md
```

이하 진단 단계 기록은 과거다.

# 현재 진행 — 2026-10-27 KST07:47, reviewer 반복 알림 원인 확인·DeepSeek 회수 미완료

## 현재 목표와 실제 완료

최신 사용자 요청은 9mini/checkMini의 reviewer-m3 `warming_up`/`replicas_missing` 반복 알림 원인을 **추가 실제 Grok CLI**로 조사하는 것이다. 이전 DeepSeek8dc 단건 해결 요청은 미완료로 유지한다. 스킬은 사용하지 않았다. root가 실제 운영 읽기와 소스를 독립 대조했다. 이번 단계에서 운영 코드·설정·DB·capacity·서비스·배포 변경은 **0**이다.

- 실제 Grok CLI1.0.70 기본 설정을 두 독립 WT에서 실행했다. Grok 내부 subagent는 `--no-subagents`로 끄고, 사용자 명시 Grok CLI 요청으로 실행했다. Codex subagent/codex exec는 추가하지 않았다. 사용자 모델 규칙은 그대로다.
- 추가 진단 WT `/Users/jr/Desktop/projects/nomorevibe-reviewer-alert-grok-20261027`, branch `codex/reviewer-alert-grok-20261027`, base main8bbd50ce. PRIVATE `STATE/reviewer-alert-grok-20261027/REPORT.private.md`와 각 prompt/stream만 사용한다. 처음 세션5332 EXIT0, 첫 followup23699 EXIT0. 마지막 capacity-followup21595도 EXIT0. 최종 보고는 공유group 점유 연결을 반영했고 root가 실제 snapshot·소스로 독립 검토했다.
- DeepSeek WT `/Users/jr/Desktop/projects/nomorevibe-deepseek-grok-20261027`, base8bbd50ce. 첫 Grok69353은50turn, continuation48407은22turn 제한으로 EXIT1했고 보고서 미작성 상태였다. 계속 읽기만 하는 접근을 중단하도록 좁힌 최종 report-now61793 EXIT0으로 실제 REPORT를 작성했다. root는 수정된 read-only 결과22:42:57.430456Z/indeterminate·settledNULL을 독립 확인했다(artifact SHAbe99cdbd33578d81dbfe3cfab608eebb40f601207db6e03c9a4e07d3476abd1a). 구체 plan·회수는 준비하지 못했다고 Grok도 명시했다. private 로그/실패를 보존한다. **Grok 실행을 문제 해결 완료로 해석하지 않는다.**

## root가 독립 확인한 원인과 증거

`STATE=/Users/jr/.local/state/nomorevibe-reliability-20261025`, 아래 경로는 그 아래의 private 원본이다. 자격증명·raw env·binding·원문 Docker 로그·prompt를 Git/화면에 복사하지 않는다.

1. `reviewer-alert-grok-20261027/current.private.json`, UTC22:39:51/KST07:39, SHAabd6606ac74a0331696288da2ad7d53d965f88eafe31eeca0e29a11082f8eec0. SDK `c.app('reviewer-m3')`가 실제 appName `app-copy-primary-hard-drive-b5fhzd`에 결속한다. desired1, worker34cc 이미지, 서비스 마지막 update19:37–19:38Z(반복 배포 아님). 실제 task exit1, OOMfalse. epoch356/357에서 `role.progress_stalled`→`supervisor.stopping(reason=progress_stalled)`→supervisor exit0/`progressRestart=true`→Swarm task 교체. 22:29:42→22:32:41, 22:32:46→22:34:09. 두 번째는 acquire 후46초였다.
2. `root-progress-current.private.json`, UTC22:44:01/KST07:44, SHA622ab7e17b6b4336d80e654385d3a67e6ff7451b23525810b1d43c2db86ef077. 기존 공식 read-only `scripts/check-worker-progress.ts` 운영 조회를 실행했다(테스트·모델 호출 아님). scheduler scheduled. FIRST `crawl-agent-review` waiting394/5분진행0/no_progress/restartEligibletrue. SECOND AI2는 별도 ai2-consumer lane/5분진행1/restartEligiblefalse. 새 container ad81efa63041이 이전 캡처 이후 교체를 증명한다. healthy 한 표본만으로 루프 해소를 주장하지 않는다.
3. `root-job-trace.private.json`, UTC22:45:20, SHA60be30bb2d5fe544c99c4a78faab6020c60159314ff446b897228886960fa87c. 실제22:44–22:45 FIRST `crawl.agent_review_deferred(reason=capacity)`와 worker.job deferred가 반복된다. 프로세스가 죽어 응답하지 않는 것과 다르다. `root-jobs-current.private.json`22:45:37에서 AI1 legacy/AI2 items, FIRST worker_seen·last_run 최신/last_error없음, 요청은 남고 processed 미진행이다.
4. `root-capacity-current.private.json`, UTC22:46:12/KST07:46. 실제 policy global3/reviewerpool2/공유group `m3-mlx` 한도1. 유일한 active는8dc `local-human-deepseek` indeterminate/m3-mlx/reviewer1건. FIRST의 abcLLM `[MLX] gpt-oss-120b` route `crawl-agent-review`도 **같은 m3-mlx**에4건 waiting, text5건도 같은 group이다. 따라서 현재 shared-group 점유가 FIRST admission을 막는 것은 확인했다. GPU3090 AI2의 다른 group과 구분한다.
5. 소스 `role-worker.ts:110–125,247–259,324–351,420–431`: 15초마다 progress를 확인해2회 stall이면 종료1을 반환한다. classifier `worker-progress-query.ts:95–127`는 global draining/독립consumer에는 예외가 있지만 **OPEN 상태에서 실제 capacity 차단 중인 FIRST**를 held로 보정하지 않는다. 현재 FIRST는 restartEligibletrue이다. `recovery_gateway.py:125–138`: running 수 불일치→replicas_missing, 새 컨테이너180초 미만→warming_up(healthy여도). Oracle/checkMini force_update가 이 두 reason의 재시작을 지시하는 것은 아니다.

확인된 현재 인과: **DeepSeek 미확정이 공유 슬롯 점유→FIRST capacity 대기→처리0이 재시작 대상으로 분류됨→실제 progress_stalled 교체→3분 warming_up/교체 공백 replicas_missing**. 단 각 과거 role.progress_stalled 로그에는 판정 stage/lane이 없고 사용자07:07–07:24 각 container 원본도 현재 보존 범위 밖이다. 모든 과거 알림의 개별 trigger까지 확정했다고 쓰지 않는다. 추가 Grok 보고서에서 “한 boot healthy이므로 루프 해소”, “DeepSeek는 intro-check라 이 경로와 관계없음”이라는 초기 추론은 root가 반박했고 최신 사실로 수정하도록 지시했다.

## DeepSeek 단건 상태·설계 결정

- 요청8dc0c418-034e-4163-bd62-36d9c9fe2802, route local-human-deepseek, 실제 human_deepseek 재검수.19:37:37.933 dispatch→19:37:40.689 local_abort→local-end93120/19:37:40.809→attempt121607 failed/cancelled/결과NULL. candidate293769 needs_review/second_review_split/미발행.22:46 현재도indeterminate·settledNULL·terminal없음. 정확한 기존 읽기 `deepseek-exact-status-20261027-b.private.json` SHA004eea593aa0c637fe9a91429166d2602e8936e3c7a6d5f1e9b74766a130f93e.
- 원 owner durable group1013/1014/1015 PID40 seq1은 group_exited1214 pgid_esrch_after_sigkill19:37:40.970. client/group 종료와 실제 provider 모델 종료는 동일하지 않다.
- M3 native provider response_only, endpoint100.92.77.66:8010, 실제PID50759/PGID50759/PPID1, launchd gui/501/com.jr.deepseek, dispatch 전 시작한 동일 프로세스다. 단순 시간 경과·idle만으로 unknown 회수/사용량 정산을 하지 않는다.
- canonical historical-owner+실제Mac launchd V2 경계를 검토한다. 이전 nativeMac source template는 `STATE/mlx133-provider-recovery-20261026/`, `STATE/84d-provider-recovery-20261026/mac-action.remote.py`다. d435는 **Supa** 템플릿으로 그대로 실행하면 안 된다. 모든 과거 once/stop/release/OPEN/restore는 소비됐으므로8dc용 새 실제 plan·경계 증거·복원 및 canonical release가 필요하다. 현재 준비·적용 완료 아님.
- 알림을 숨기거나 healthy 대기 시간을 늘리는 것만으로 해결하지 않는다. 실제 capacity 차단을 worker 고장과 구분하고, 같은 차단 상태로 새 boot를 반복 종료하지 않는 수정이 필요하다. 진단 단계에서는 소스 수정·임계값 변경을 하지 않았다. AI2 모델·32k/10k/no-thinking은 유지한다.

## 변경 파일·실행과 실패

- 저장소 수정: 이 `docs/CODEX_HANDOFF.md`만. 실제 앱 소스 변경0. 원 사용자 dirty WT와 pinned686 operator는 건드리지 않았다. 추가 산출물은 위 두 private 디렉터리의 보고서·read-only helper·원본 snapshot뿐이다.
- 사용자 지시 이후 수동 테스트/lint/tsc/build/컴파일·합성 운영 모델 호출은 이번에도 실행하지 않았다. 테스트 PASS를 주장하지 않는다. 운영 조회와 Grok CLI 실행 결과만 위에 기록했다.
- root 최초 exact SQL `attempt.created_at` 및 Grok private reconcile `attempt.decision`은 존재하지 않아42703으로 read-only 실패했다. 각각 started_at/`outcome->>'decision'`로 수정한 읽기와 원 실패를 보존한다. 공유 DB write는 없었다.
- Grok 50+22turn broad source/history 조사로 구체 report 미작성→최종 결과 작성으로 좁혀 continuation했다. 같은 연구를 다시 넓히거나 이전 consumed helper를 실행하지 않는다.

## 남은 작업·다음 agent 정확한 명령

1. 두 Grok은 종료했고 root 검토까지 완료했다. 두 WT의 git status는 clean, 실제 source 변경0이다. 최종 진단은 `STATE/reviewer-alert-grok-20261027/ROOT_REVIEW.private.md`와 최종 `REPORT.private.md`에 보존했다. 같은 Grok을 중복 실행하거나 초기 철회된 추론을 사용하지 않는다.
2. 8dc의 실제 물리 종료 증명·정확히 한 행의 canonical 회수·모든 stop 원복을 **새 reviewable plan**으로 수행해야 한다. usageunknown/charged/binding/settledNULL/업무failed 보존. raw SQL reset/delete·가짜 terminal·과거 once 재사용 금지. 어떤 공유 stop도 이번 단계에 아직 실행하지 않았다.
3. 현재 OPEN/슬롯 차단을 restartable local stall로 보지 않도록 최소 소스 변경과 trigger stage/lane 진단을 검토한다. 실제 동작 관측 후 알림이 끝났는지 확인해야 하며 아직 수정/배포/해결 완료 아님.
4. 정상progress/monitorUP·실제6시간/24시간 관측, 나머지 사람/백업 검증은 아래 기존 기록을 유지한다. 이전 observer5분sample은실패해후속표본중단, 미래PASS없다.

```bash
git -C /Users/jr/Desktop/projects/nomorevibe-deepseek-grok-20261027 status --short
git -C /Users/jr/Desktop/projects/nomorevibe-reviewer-alert-grok-20261027 status --short
sed -n '1,180p' /Users/jr/.local/state/nomorevibe-reliability-20261025/reviewer-alert-grok-20261027/REPORT.private.md
sed -n '1,180p' /Users/jr/.local/state/nomorevibe-reliability-20261025/deepseek-grok-20261027/REPORT.private.md
```

아래 PR680은20:02:03Z 실제병합(main8bbd50ce), 자동CI성공. 앱 실행 소스34cc 그대로다. 아래는 이전 배포 단계 기록이며 최신 진단이 우선한다.

# 현재 인계 — 2026-10-27, 전체18 source/runtime 확인·6잡 재개 완료

**전체18 source/runtime34cc와 text6잡 재개는 실제 완료했다. 정상 운영 인증은 통과하지 않았다. 19:58:05 실제 읽기에서 reviewer owner_mismatch는 자연 해소됐고 모든5역할·scheduler ready다. progress=alarm만 남아 정상 관문·monitor UP 통과를 주장하지 않는다. 새 관측은 한 번 시작했지만 미래 통과는 false다. 배포·회수·migration·grant·pause/resume once를 재실행하지 않는다.**

## 목표와 경계

사용자 요청의 운영 자동화·정체 복구·상세페이지3건을 실제 반영한 결과와 미해결 정상 업무 경보를 구분해 보고한다. 최종 문서PR680은 docs-only로 root가 CI·병합을 진행한다.

- 모델 `gpt-6.1-sol`, reasoning `xhigh`, 스킬 금지. 운영·SSH·API·DB·Keychain·GitHub·git 작업은 root만 담당한다.
- 사용자 지시로 **2026-10-26 14:37 UTC 이후 추가 수동 테스트·lint·tsc·컴파일은 실행하지 않았다**. 필수 자동 CI는 유지했다. 작성한 회귀를 수동 실행했다고 기록하지 않는다.
- 최종 문서 단계 수정은5파일이다: `docs/CODEX_HANDOFF.md`, `docs/operations/2026-10-26-pr-priority-progress.md`, `PENDING.md`와 감시 읽기 권한 설치 절차를 보완한 `docs/operations/2026-10-22-worker-monitor-rollout.md`, `docs/operations/independent-workers-runbook.md`. 마지막 두 문서는 다른 agent가 수정·독립 소스 검토를 마쳤다. PENDING의2026-10-25 이하 본문은 원바이트를 보존했다.

## 현재 실제 결과

| 항목 | 확인 결과 |
|---|---|
| 코드·CI | PR668–679·681–686 병합. 최신 앱 소스 `34cc2045cbb7105313861792adb37c035b64e70c`. PR686 CI40382748901과 main CI40383949515의 필수 check·웹/워커 이미지 성공. checked PR tree/이미지 재사용, refresh-caches는 관문 아님 |
| 전체18 source/runtime | 제한된 읽기 증명97182 EXIT0, **2026-10-26 19:56:03.736950 UTC**. 변경 없는 stock verify_fleet로 selected11+retained7 전체18 확인. `normalCompletionCertified:false`이며 정상 인증을 대신하지 않음 |
| DB·정확한 요청 회수 | DB0137/journal138 실제 적용·사후 검증 완료. 6c 요청은 실제 Docker die1+작업/컨테이너 삭제 증거로 감사20474 withdrawn. C272000·settled_at NULL·사용량 미확정 보존. 모델 정상 종료/업무 성공 아님 |
| Connect |34cc 실제 배포·runtime 검증. 새 실행 차단·180초 종료 대기·동일 네이티브 바이너리 직접 exec·240초 유예 유지 |
| 프로필 수정 실제 효과 | 새 boot에서1grant→1dispatch→1settled/generated **19:29:48.471 UTC**, 새 profile 미사용 예약 만료 없음. 한 표본의 자기 예약 이어받기 효과이며 전체 품질/장기 정상 증거 아님 |
| 유지보수 종료 | 두 번째 resume30148 EXIT0. 실제 감사20514–20519, **19:54:59.077–19:55:02.865 UTC**. 여섯 잡 모두 paused=false·계획된 pause 없음. capacity OPEN20475 그대로 |
| 읽기 권한 | monitor의 PG42501 fence SELECT 누락을 root가 SELECT-only grant20513으로 보완. 실제 post-grant 읽기 성공, role 쓰기불가/defaultRO 유지. 앱/모델 설정 변경 없음 |
| 정상 관문 |19:56 표본은 owner_mismatch·progress alarm. **최신19:58:05.270076 UTC 실제80777 읽기는 모든5역할·scheduler ready, reviewer 소유권 자연 해소, ONLY progress=alarm**. FIRST110/SECOND71 대기·5분 진행0/text upstream_stalled 유지. 정상 통과 아님 |
| monitor | 두 수신처 ACK=true/fresh=true이지만 **UP=false**. 전달 확인과 정상 업무 인증을 구분 |
| 새 관측 | stock observer **19:56:25.106637 UTC 시작**, PID51355. offsets300/600/900/21600, productionMutations0, **futurePassed:false**. 실패 표본에서 driver 중단, 이후 성공을 예약만으로 주장하지 않음 |

`STATE=/Users/jr/.local/state/nomorevibe-reliability-20261025`다. 실제 전체 source/runtime snapshot은 `STATE/full18-release686-source-runtime-20261027/source-runtime.final.private.json`, SHA **`1ce7da702b3b6a01423867ffddabf8c53977820fbd9499e95810363edb0de0da`**. 같은 디렉터리 `result.safe.json`이 normalCompletionCertified=false를 명시한다. 관측은 그 디렉터리 `observation/`와 `observation.safe.json`에 결속했다. 원 private snapshot·설정·token·binding을 공개 로그/Git에 넣지 않는다.

**추가 실제 미해결 요청**: `STATE/capacity-final686-readback-20261027-a.private.json`의19:58 UTC대 읽기에서 global OPEN/epoch1/revision3은 그대로이고, active는 `local-human-deepseek`/budget `m3-deepseek`/group `m3-mlx`/pool reviewer의 **새 INDETERMINATE1건**이다(queued19:36:44.442/dispatched19:37:37.933/updated19:37:40.584 UTC). FIRST waiting4·localdeepseek-confirm1·text waiting5이며 active TEXT는 없다. 이 요청이 진행 경보의 원인/공유 그룹 차단이라고 입증한 것은 아니다. **과거6c와 다른 요청**이며 unknown을 지우거나 기존 once/종료 증거를 재사용하지 않는다. 새 요청의 실제 물리/모델 terminal 증거·정확한 한 행의 현재 권한/CAS를 확인한 뒤 root가 적법한 회수 경로를 별도 검토해야 한다. 현재 normal progress는 false다.

## 바로 다음은 읽기 전용 관측 상태와 실제 경보 확인

이미 실행한 배포·completion·grant·pause/resume를 다시 요청할 명령은 없다. 아래는 **root의 로컬 읽기 명령**이며 관측을 새로 시작하거나 표본을 수동 재실행하지 않는다.

```bash
OBS=/Users/jr/.local/state/nomorevibe-reliability-20261025/full18-release686-source-runtime-20261027/observation
jq '{pid,startAt,actualAt,productionMutations,futurePassed}' "$OBS/started.private.json"
jq '{completed,stopped,productionMutations,samples:[.samples[]|{offset,dueAt,actualAt,status,passed}]}' "$OBS/summary.private.json"
ps -p 51355 -o pid=,etime=
```

- 관측 예약/시작·PID는 미래 정상 증거가 아니다. 실제 sample result·summary의 시각과 passed를 확인한다. 실패하면 실패 원문·sample을 보존하고 남은 미래 표본을 통과로 채우거나 driver를 재시작하지 않는다.
- 최신 실제 `STATE/final-current686-readback-20261027-b.private.json`(80777 EXIT0,19:58:05.270076 UTC)에서 reviewer 소유권은 자연 해소·ALL5/scheduler ready다. 남은 FIRST/SECOND·text 실제 progress alarm을 새 읽기 근거로 조사한다. owner/lease/오류를 직접 reset하거나 모델·품질 관문을 완화하지 않는다. monitor UP·normal/business PASS는 아직 없다.
- 관측에 결속된 운영자 `/Users/jr/Desktop/projects/nomorevibe-release-686-20261027`의34cc·소스 바이트와 snapshot/observer 경로를 보존한다.5·10·15분/6시간 결과는 실제 경과 후 기록하고 별도24시간은 남긴다.

## 완료한 유지보수·실패 이력 — 재실행 금지

- 첫 pause-a 감사20494–20499→resume-a20501–20506 완료. text쌍 검증 뒤 조기 재개했지만 run-b31590은19:31 progress 관문 timeout으로 중단했다. `execution/git/summary.json`의 Git7앱34cc deployed/verified·failed0를 보존한다. outer completedApps=[]는 반환 전 관문 실패 집계이며 배포0/롤백이 아니다.
- 두 번째 pause-b20507–20512 후 새 plan-C는11앱 선택/7앱 유지. C plan `STATE/full18-release686-20261027-c/plan.private.json`, SHA `a8f8d6032e43992ba70540b29c677de1569488384c1d60eea22c0bb2f010dae7`. C97598은10앱 verified+monitor done/healthy1 뒤 **19:47:10 UTC EXIT1 monitor source/health/push timeout**. C execution once 소비·원 파일 그대로 보존.
- readonly completion62719도 같은 monitor UP timeout으로 EXIT1했다. 실패 자료를 성공으로 바꾸지 않는다.19:54:07 실제 post-grant 읽기는 성공했지만 FIRST/SECOND 실제 progress alarm이었다. `STATE/monitor686-post-grant-readback-20261027-a.private.json`을 보존한다.
- 물리 rollout과 text쌍 검증을 마친 뒤 유지보수를 무기한 유지하지 않도록 root가 두 번째 resume30148을 완료했다. 새 resume-plan SHA `6cfcca8575b4d4182e4c05bb2f9b041607a0913d051bdee8377993b3bd8b8a6f`는 원 pause-b SHA `6b7c71f0e63b2ca593375cdc124950c4f8b6631a971b138b77e54cc33fe687ba`에 결속한다. 실제 own 영수증 `STATE/text-maintenance-pause-20261027-v2/resume-run-20261027-b/`. **현재 모두 paused=false, 모든 pause/resume once 소비**.
- 정규 helper V2 Node9a2c64319bb386036cc2c383bde8ebe560e0529bec258c2ee116a9d906455b7e는 CommonJS 로컬 import만 createRequire로 맞췄다. 원 import 실패·원 helper를 보존하며 global once는 `STATE/text-maintenance-pause-20261027/once` 그대로다. 정규 controlAdminJob이 오류/cursor/요청/lease/version을 보존했다.
- SELECT-only grant20513 자료: `STATE/monitor-writer-fence-select-grant-20261027/`. 원 monitor RO·쓰기불가 보존. 같은 grant 재실행 금지.
- DB138 완료 `STATE/cli-executor-indeterminate-removed-0137-migration-20261027/apply-20261027-a/completed.private.json`, SHA4cec42a948f8e5ed9882598ffeb1ea0017f7b12bd5ac0341289d353c47d73acf. canonical 감사20474 실제 영수증 `STATE/cli-6c-removed-canonical-apply-20261027-a/canonical-receipt.private.json`, SHAbe8db75b76bb24eb6b4a855a540c4a63431012f8e607506b9e45e1a0d84a4137. 과거63 stop/DB136/회수20456/finish/OPEN20457, 6c stop/DB137·138/회수/finish/OPEN20475 모두 once 소비. 재실행 금지. 미완성 expire.mjs도 실행하지 않는다.
- PR686 첫 CI40381826340은 runtimeRoleLease 추가 owner 필드 strict Zod 거절8건이었다(SQL 원인 아님). instanceId/bootId2줄 projection 후40382748901 전체 성공. strict schema/dispatch/tests 유지, raw 실패 로그 `STATE/ci686-ledger-job.private.log` 보존. 이후 수동 테스트 통과를 주장하지 않는다.

## UI·AI2·남은 사람/운영 검증

- PR672 정보·설명 유지/약13.7% 높이 절감·모바일2열·라이선스 줄바꿈, PR670 최신 업데이트3개, PR673 개인 숫자ID·조직 증명 파일. 실제 익명 UI는 **2026-10-26 13:19:31 UTC** 당시50f의 두 웹에서1280/375로 확인했다. 현재34cc에도 코드가 포함되지만 실제 OAuth·claim·멤버 관리·30일 재검증·파일 삭제 회수나 이후 새 UI 로그인은 미실행이다.
- AI2 GPU3090 Tailscale 직접 기본 qwen3.8-flash-next·abcLLM Supa Qwen3.8 대체·no-thinking·총32k/출력10k 유지. 번역 품질 기준·모델·한도 변경 없음.
- 진행 경보·UP, 실제6시간/24시간 관측, 백업/PITR/보존기간·용량·nonempty media_assets 복원, 독립 사람 라벨5개·assist 적용 꺼짐과 기존 드릴은 PENDING에 남긴다. 이미 검증한9월29일 논리 dump·og_images 격리복원을 미실행으로 되돌리지 않는다.

## 문서 경로와 역사 보존

문서 WT `/Users/jr/Desktop/projects/nomorevibe-ops-delivery-report-20261026`, branch codex/ops-delivery-report-20261026. root가906e9772 문서 정리 후 d855154a로 main34cc를 통합했다. PR680은 docs-only 최종 CI·병합 대상이며 문서 변경으로 앱을 재배포하지 않는다.

통합 전 원 main handoff: `STATE/docs-686-before-base-integration-20261027/main34cc-handoff.private.md`. 정리 전 dirty3파일+SHA manifest: `STATE/docs-before-686-final-consolidation-20261027/`. 긴 역사 원문은 Git50f와 `STATE/final-docs-history-20261026T130400Z/{main-handoff.private.md,working-handoff.private.md}`, `STATE/docs-before-final-consolidation-20261027T162700Z/`, `STATE/handoff-before-684-stop-phase-20261027/`의0600 보관본에 있다. 실제 저장소·영수증을 대화 기억보다 우선한다.

---

# AI 1차 관리자 상세 상태 — 2026-10-27 KST, source 단계 완료

## 현재 목표·완료

`/admin/status`에 AI 1차 검수의 목적·설정 모델·대기·실행·최근 처리·공유 용량과 수집 압력 연결을 표시한다. WT `/Users/jr/Desktop/projects/nomorevibe-ai1-admin-status-20261027`, branch `codex/ai1-admin-status-20261027`, 시작 base `06ac66c1ebbb130258eb72a73b0a83dbed6420b1`이다. 원 dirty WT·운영 설정은 수정하지 않았다. PR·필수 CI·병합·운영 배포·실제 화면 확인은 아직이며 root 담당이다.

전체 현황에 독립 상세 카드를 추가하고 모바일에서도 표시한다. 파이프라인 AI 1차와 흐름 상세 노드에서 카드로 이동한다. 저장된 홈페이지 본문·README·설명·근거로 게시 적격을 처음 판단한다는 목적, AI 2차 재검토·별도 개발 AI 근거 판정과의 차이를 설명한다. 모델은 `resolveModelSlots`의 first 슬롯 모두를 표시하므로 별도 pool 변경의 추가 슬롯도 반영한다.

## 변경 파일·핵심 결정

- `app/(operator)/admin/status/{FirstReviewStatus.tsx,page.tsx,render-reads.ts,FlowDetail.tsx,action-links.ts,dashboard/StageRail.tsx}`: 기존 throughput.first·workerProgress·jobStates·수집 cursor.admissionThrottled·처리 지표·제어 상태를 재사용한다. 실행 가능 대기·최장 추정, 재시도 유예·시도 소진, legacy 작업과 items 점유, 회차 성공과 후보 완료를 구분한다. 원문/오류 본문·토큰·키는 보내지 않는다.
- `lib/operations/first-review-status.ts`: 부족한5/15/60분 완료·기술 실패·승인/거절/사람 확인·최근 종료5건만 새 집계한다. 시각 인덱스 없는 시도 이력에서 시간 필터 전에 PK 역순 최대10,001행을 읽고10,000행 표본으로 계산한다. 상한 도달 시 전체 수량·전체 성공률이 아님을 표시한다. 분모는 표본 안 성공+기술 실패이며 취소·연기·규칙·재사용·대체·실행 중을 제외한다. 승인·거절·사람 확인은 모두 기술 성공이다.
- 새 집계는 복제본 전용 read-only TX·문장3초·JIT off,60초 공유 캐시·동시 읽기 합치기·수동 새로고침 분3회 상한이다. DB 조회시각·캐시·오래된 값·표본을 표시한다. 복제 지연·장애·시간 초과·스키마 불일치는0이 아닌미확인이다. 새 API·migration·쓰기·모델 호출은 없다.
- `lib/operations/{pipeline-control-status,pipeline-runtime-status}.ts`: 기존 제어 readback에 공유 물리 group별 AI1 대기·유효 예약·dispatched·indeterminate·점유 route를 additive로 추가한다. active/waiting 부분 인덱스 대상 최대513행을 읽으며512행 초과/누락 자료는 group 미확인이다. settled 이력·요청 payload는 읽지 않는다. 검증된 policy의 group 상한과 AI1 모델 경로를 함께 보인다. AI1 실행0·실패0이어도 번역 등 다른 단계의 종료 미확정 점유가 막을 수 있음을 표시하고 전역 장부 링크를 제공한다. 자동 회수·용량 변경은 하지 않는다.
- 수집 압력은 기존 대기 지표의 참고 판정이다. 수집기의 retry/job 조건을 반영한 실제 판정과 다를 수 있음을 밝히고, 마지막 저장 커서의 완화 여부·마지막 실행시각을 별도로 표시한다. 실제 현재 페이지 실행량·단일 병목 원인으로 승격하지 않는다.
- `tests/first-review-status.test.tsx`, `tests/pipeline-runtime-status.test.ts`: 미확인/0·분모/표본·오래된 값·나이 미확인·PK 상한·다른 단계 종료 미확정 공유 점유의 회귀 코드를 추가했다. 실행하지 않았다.

## 검증·실패한 접근·남은 일

사용자 지시대로 로컬 tests/lint/typecheck/build/컴파일·합성 provider·Telegram 호출은 모두 미실행이다. `git diff --check`와 최종 `git diff --cached --check`는 실제 EXIT0이었다. 기능 GitHub CI는 아직 실행하지 않았다. 실행 후 실패한 구현 접근은 없으며, 운영 재현·성능 실측도 하지 않았다.

root가 별도 AI1 pool 변경과 통합 검토→필수 GitHub CI→최신 base 병합→공식 배포를 진행한다. 실제 복제본 권한/성능·로그인된 데스크톱/모바일 표시·모델 실제 적용은 미확인이다. 표본 성공률은 전체 처리 성능 증명이 아니며10,000행 이전에 생성된 늦은 종료가 누락될 수 있다. group readback은 상한 초과 시0/정상으로 축약하지 않는다. root의 실제 운영 장애·회수 조사 결과를 이 source 구현이 대신하지 않는다.

다음 정확한 읽기 명령:

```sh
git -C /Users/jr/Desktop/projects/nomorevibe-ai1-admin-status-20261027 log -1 --oneline
git -C /Users/jr/Desktop/projects/nomorevibe-ai1-admin-status-20261027 show --stat --oneline HEAD
git -C /Users/jr/Desktop/projects/nomorevibe-ai1-admin-status-20261027 status --short
```

통합 WT에서 `git cherry-pick codex/ai1-admin-status-20261027`로 최종 scoped commit을 옮길 수 있다. pool agent 담당 `stage-registry.ts`는 이 branch에서 수정하지 않았다. PR·병합·운영 I/O는 root만 수행한다.
