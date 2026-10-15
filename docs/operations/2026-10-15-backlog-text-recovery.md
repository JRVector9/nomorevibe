# 2026-10-15 텍스트 적체 회복

## 범위와 승인된 수정

검색 생성·검수, 소개 검수, 한국어 소개, 제품 번역, 이유 번역, 저장소 재검수, 크롤링 소개의 정상 처리 경로를 조사한다. 신규 발굴 중단, 모델·설정·품질 한도는 유지한다. 실제로 필요한 사람 판단만 남긴다.

검색 생성의 `network` 17건은 모두 5회 이상 실패해 정상 selector에서 영구 제외되고 있었다. 현재 오류가 명확한 공급자 오류(`network`, `no_key`, `model_unavailable`, `rate_limit`, `rate_limited`)이면 시도 횟수 상한의 예외로 두고, 실패 저장 시 30분 backoff를 적용한다. 누적 attempts, repairVersion, sourceHash, sourceRevision, 원문과 기존 성공 시각은 초기화하지 않는다. `invalid_output`, `timeout`, 불분명한 HTTP 오류는 기존 5회 상한을 유지한다. 검수와 잡 gateway-down/call quota 정책은 바꾸지 않는다.

작업 순서: 독립 PostgreSQL 17 테스트 DB에서 selector·backoff·관측 집계·이력 보존·source/profile CAS·job lease 테스트를 먼저 실패시킨 뒤, 공통 정책과 정확한 사용처만 수정하고 기존 검색 관련 통합 검증을 실행한다. 운영 배포·PR·handoff 통합은 root가 수행한다.

## 운영 관측

07:37:59 KST 관측: 검색 생성 ready 26, 검수 ready 7,967, 한 시간 실제 생성 223/검수 234. 생성 오류 network 17건은 모두 cap에 도달했다. 검수는 model_unavailable 2,465건과 network 44건이 cap 없이 정상 backoff 중이며 timeout 1건만 검수 상한에 도달했다.

07:39:53 KST 정상 selector 확인: 소개 검수 0, 저장소 재검수 0, 크롤링 소개 0. 소개 사람 검수는 현재 공개·같은 소개 기준 102건이며 과거 고정 cohort 67건과 다르다. 이들은 검수 오류가 아니라 `needs_editor` 판단이다. 사이트 이름만 있는 본문, CSS, 빈 화면, 일반 AI Studio README 같은 증거가 포함되어 일괄 승인을 할 수 없다.

한국어 소개: eligible 41,794, 완료 36,172, 대기 2,832, retryable 실패 9, gaveUp 2,763, 한 시간 저장 171. 제품 번역: 정상 선택 가능 77, 4회 상한 127, future backoff 3, pending 62. 이유 번역: 전체 152,613, 완료 140,940, 대기 11,673, failed 0, 한 시간 실제 저장 118. 정상 job demand가 이미 있으므로 중복 재요청하지 않았다.

저장소 gone 대상 90개 중 현재 정상 재검수 due 0, delist 후보 보류 36, human 35. 후보 보류는 nextReviewAt=null인 기존 판단이므로 자동 삭제로 바꾸지 않았다. 최근 24시간 정상 자동 비공개 처리 65건을 확인했다.

현재 checker에 실제 source를 넣은 제한된 재현에서 P2P, 월명 날짜, Bengali 숫자, French 숫자 단어의 자연스러운 한국어 번역이 `invented_number`로 거절됐다. 의미가 명확한 한국어 제품 설명의 영어 번역도 `english_uncertain`로 거절됐다. root에게 재현과 최소 수정 후보를 전달했다. 실패한 모델 출력은 현재 DB에 보존되지 않아 이 재현이 모든 gaveUp의 자동 승인 근거는 아니다.

## 증거와 실패한 접근

비공개 경로의 새 관측 파일 `2026-10-15-text/baseline-2-20261015.json`, `details-20261015.json`은 숫자와 공개 제품 근거만 보관했다. frozen-work 기준선은 덮어쓰지 않았다. 최초 원격 probe는 실행 오류, 두 번째는 repo review 컬럼 updated_at 대신 reviewed_at을 사용해야 하는 SQL 오류였으며, 읽기 전용 쿼리를 수정한 뒤 위 관측에 성공했다. 원시 환경 변수·토큰은 출력하지 않았다.

## 검증 상태

독립 테스트 DB: `nomorevibe-search-provider-test-db-20261015`, localhost 55445, pgvector 0.8.6 / PostgreSQL 17.

07:44 RED 실제 실행: 새 통합 테스트 8개 중 6개가 의도한 assertion으로 실패했다. network 17개가 0개로 선택됐고, 명확한 공급자 장애는 pending 대신 exhausted로 집계됐으며, 새 실패의 5분과 기존 실패의 160분 retry가 요구한 30분과 달랐다. stale source/profile CAS와 lease rollback 2개는 기존 코드에서 통과했다.

공통 `search-profile-retry.ts`를 추가하고 generation selector, failure writer, 기존 verification 공급자 분류, search-health 집계, text-progress ready age에서 사용한다. 기존 verification의 오류 분류와 시도 정책은 같다. 공급자 실패의 누적 시도 횟수는 계속 증가하며 30분 backoff만 적용한다. 현재 오류가 품질 실패로 바뀌면 기존 5회 상한이 적용된다. 반복 실패 집계도 보존한다.

실제 실행 결과:

- 검색 관련 integration 6파일 **71/71 통과**: search-profile-provider-retry, search-profile, search-profile-note-correlation, search-verify, search-health, worker-progress-query.
- 최종 fixture 타입 수정 후 새 provider retry integration **8/8 재실행 통과**.
- search-health/text-progress unit **7/7 통과**.
- `npx tsc --noEmit`, 변경한 TypeScript 5파일 scoped eslint, `git diff --check` 통과.
- lost-lease 테스트가 의도대로 `job.failed`/`job_lease_lost` 로그를 만들었으며 결과 저장은 rollback됐다. 예상한 테스트 로그다.

처음 tsc에서는 fixture override의 Date 필드에 SQL을 전달한 2개 타입 오류가 나왔다. 미래 retry를 실제 Date로 바꾼 뒤 tsc와 focused integration을 다시 실행해 통과했다. 제품 코드의 타입 오류는 없었다.

수정 파일: `lib/domain/products/search-profile-retry.ts`, `lib/domain/products/search-profile.ts`, `lib/domain/products/search-profiles.ts`, `lib/domain/products/search-health.ts`, `lib/operations/text-progress.ts`, `tests/search-profile.test.ts`, `tests/integration/search-profile-provider-retry.test.ts`, `tests/integration/search-profile.test.ts`, `tests/integration/search-verify.test.ts`, 이 보고서. 커밋·배포·운영 카운터 초기화는 하지 않았다. Handoff는 root가 통합한다.

## 최신 운영 결과와 남은 범위

07:46:09 KST 읽기 전용 재관측: 생성 ready 46, 검수 ready 7,958, 한 시간 실제 생성 211/검수 236. 한국어 소개 완료 36,173/대기 2,831/retryable failed 10/gaveUp 2,764. 이유 번역 완료 140,952/대기 11,661이며 신규 timeout 4건은 각 1회 실패 후 future backoff 중이다. 소개 needs_editor 102는 그대로다. 두 신규 발굴 잡은 2100년까지 중단된 상태이며 runs는 변하지 않았다.

07:47:47 KST 고정 network cohort 재관측: 17건 모두 아직 network/attempts=5/repairVersion=0이며 정상 selector가 선택한 cohort 0건, 기준선 뒤 성공 0건이었다. 이는 수정 배포 전 관측이다. 13건은 옛 생성 성공 시각과 키워드를 갖고, 4건은 최초 생성이 실패한 상태다. 별도 reset 없이 배포 뒤 정상 selector와 worker가 처리하도록 준비했다.

검수 timeout 상한의 1건(id 19301, jaewoo-kang)은 마지막 실패가 10/09이고 16개 키워드 246자, 소개·설명 각각 80자, page 931자/readme 2,000자다. 실제 모델 입력에서 README는 1,500자로 잘린다. 재시도는 5개씩 최대 4번을 하나의 60초 deadline으로 호출하므로 timeout을 명확한 공급자 장애로 단정하지 않고 상한 예외에서 제외했다. 최초 읽기 전용 재현은 helper 기본 역할인 crawler-m3에서 키가 없어 `no_key`, calls=0으로 끝났다. 운영 text 역할의 장애나 검수 결과로 해석하지 않는다. text-m3에서 현재 모델·동일 parser로 재현하는 결과는 아래에 추가한다.

07:50:22 KST text-m3 진단은 **실제 성공**했다. 현재 설정 모델 그대로, strict parser와 shared 60초 deadline 아래 4회 모두 HTTP 200, 총 24,010ms(6,824/6,687/7,227/3,266ms), unsupported 0이었다. 원문·키·응답 본문은 출력하지 않았고 DB는 쓰지 않았다. 오래된 일시 오류였을 가능성은 있지만 당시 timeout의 원인은 이 결과만으로 확정할 수 없다.

root의 명시 승인 뒤 **id 19301 한 건의 실제 복구를 완료**했다. 현재 source/profile/config fingerprint를 다시 읽고 정상 `runJob(product-search-verify, requestedOnly:true)` claim을 얻어, 동일 모델·60초·strict parser로 새로 검수했다. 실제 4회/23,875ms/unsupported 0이며 정상 `recordVerificationResult` CAS로 저장했다. verifiedAt은 07:54:22.760 KST, verifyAttempts는 5→6, verifyError/retryAt은 null이다. 기존 원문/hash/sourceRevision 1/repairVersion 0/생성 attempts 1/10월 9일 generatedAt은 보존됐다. audit id 12177(`recover-search-verify-timeout`), job runs 16,242, 정상 관측 verified 1/failed 0을 읽기 전용으로 확인했다. role token 위조·강제 lease 해제·새 상시 워커·진단 응답 재사용·timeout 전역 예외는 없다.

최초 적용 wrapper는 정상 job logger의 여러 JSON 줄 때문에 `ExtraData`로 결과 파싱에 실패했다. **적용을 다시 실행하지 않고**, `timeout-recovery-confirm-20261015.json`에서 실제 saved row/audit/job 관측을 확인했다. 후속 private helper는 해당 단발 프로세스의 로그 수준만 조절하며 운영 서비스 설정은 바꾸지 않는다.

아직 자동 작업이 다 끝난 상태가 아니다. 검색 검수와 이유 번역·한국어 소개의 대규모 정상 대기열은 계속 돌고 있으며, 공급자 장애와 품질 거절은 구별해 관측해야 한다. 사람 판단 대상은 소개 102건과 저장소 human 35건/기존 후보 보류 36건이며 서로 대상이 겹칠 수 있다. 한국어 gaveUp 전체와 번역 cap 전체를 사람 판단으로 단정하지 않는다. 숫자·영어 탐지 checker의 제한된 오판을 root가 검토한 뒤 실제 근거를 갖춘 대상만 정상 경로로 회복할 수 있다.

## 고정 숫자 cohort와 배포 전 복구 준비

07:56:07 KST 현재 public·동일 source의 `invented_number` terminal 69건 중 변경된 checker의 네 패턴과 맞는 **12건**을 private 600 파일에 고정했다. P2P/peer-to-peer 6, 월명 날짜 4, Bengali 숫자 1, French plural hundreds 1이다. id는 6931, 8785, 10827, 13794, 15033, 15810, 15979, 18071, 23147, 30191, 32579, 34927이다. 모두 qualityRejections 4, attempts 4이며 id 18071만 attempts 5다. 이는 패턴 일치 후보이며 69건 전체의 오거절 증명이 아니다.

private `recover-numeric.py`/`.mjs`를 준비했다. 각 id를 **한 번만** 정상 requested job claim으로 실행하며, 현재 원문으로 fresh generation→실제 checker→`recordKoreanTaglines`→audit 순서를 따른다. 현재 모델, 정상 45초 호출/55초 잡 예산, 기존 원문/품질 한도를 그대로 사용한다. 원문·name·hash와 기존 실패 fingerprint를 호출 전/저장 전 검사하고, 저장 중 product share lock으로 name/source 변경을 막는다. 정상 writer의 누적 attempts/qualityRejections와 job-token fencing을 사용하며 실패한 건은 재실행하지 않는다. per-id private marker가 중복 호출을 차단한다. 정상 claim이 locked/stopping으로 건너뛰고 실제 호출이 없었던 경우만 다음 idle에 다시 claim할 수 있다.

08:10:00 KST 최종 dry-run은 12/12 current fingerprint 일치, 모델 호출 0/DB mutation 0이었다. 운영 release는 아직 `b0879eab83d7020839caef477fd512f842bcf1dc`, checker hash는 `e84682eb02588e0fbb2dac3907d7417fdf4fbcf9f986753b8e55c473186871b4`다. 준비된 새 checker의 당시 hash `a2225dac10779c95940216383f14d4bd707cca7e0246be86cde40cd5ba91413f`와 다르므로 적용 gate가 차단된다. **새 배포를 확인하기 전 apply를 실행하지 않았다.** apply는 정확한 release tag와 당시 local checker의 SHA256이 모두 운영과 일치해야 시작한다.

## 영어 terminal 및 no_description 사람 큐

08:07:06 KST 영어 `rejected:english_uncertain` terminal은 57건(소개 56/설명 1)이다. 현재 public·intro hold 없음·takedown 없음 조건은 모두 일치하고 source hash는 49건만 현재와 같으며 8건은 stale이다. 변경된 좁은 영어 imperative checker가 전체 보류를 해결한다고 가정하지 않는다.

대표 id 43987(한국어), 43995(일본어), 43979(번체중국어)의 현재 원문을 정상 `translateProductFields`, 동일 모델, 20초 strict batch로 새로 생성했다. 08:08:02 KST 실제 HTTP 200/5,175ms, 세 source/failure fingerprint는 전후 모두 일치했으나 **기존 운영 검사와 새 로컬 검사에서 3/3 모두 english_uncertain**이었다. 출력 길이는 49/81/96자이며 응답 본문은 private 600 파일에만 저장했다. DB mutation 0, attempts는 모두 4 그대로다. 이 세 건을 저장하거나 broad cap 예외로 회복할 근거가 없다. 나머지 54건도 진단 없이 자동 승인하지 않는다.

08:01:03 KST agreed `no_description` 3건은 candidate 287317(`ludea-ai/gta7`), 289803(`pipecrew-ai/pipecrew`), 290122(`Terra0305/Arduino`)이다. 모두 attempt 1/error null이고 현재 sourceHash/documentAt과 일치하는 유효한 empty 결과라 정상 selector가 다시 선택하지 않는다. page/readme 자료는 존재하므로 literal source missing이나 quality 상한이 아니다. 모델이 현재 증거로 소개를 말할 수 없다고 정상 반환한 사람 검토 큐이며 일괄 재요청/승인은 하지 않았다.

## 최종 응답 경계와 fixture 회귀 검증

독립 리뷰에서 HTTP 200 HTML/JSON null/object content가 `network`로 기록되거나 object choices가 잘못된 success로 받아져 공급자 cap 예외에 들어가는 문제가 확인됐다. 실제 unit RED 24개 중 4개 실패를 확인한 후, `search-profile.ts`의 fetch/body-stream transport catch와 완료된 JSON/envelope 검사를 분리했다. 실제 network/끊긴 body stream은 `network`, 완료된 malformed JSON/schema는 `invalid_output`이다. 기존 HTTP/status 정책·모델·prompt는 그대로다. GREEN **24/24**이며 malformed quality cap·actual transport retryability·정상 envelope success를 검사했다.

root 전체 integration에서 새 shared monitor assertion 하나가 기존 crawler translation fixture 때문에 실패했다. own 55445에서 `translations.test.ts` 12/12 실행 뒤 새 provider test를 실행해 **동일 null vs 0.12758848 실패를 재현**했다. `resetTables`가 남긴 crawl review 영어 source 2건이 `oldestPendingTranslationMinutes`로 합산되는 원인이었다. 새 테스트의 beforeEach에서 secondReviews/crawlCandidates(1차 source cascade)/crawlTaglines/textTranslations만 정리하고 assertion을 유지했다. 같은 cross-file 순서 재실행은 12/12→8/8 통과했다. root 55448 DB는 건드리지 않았다.

transport 변경 뒤 기존 partial fetch fixture에 text reader가 없어 첫 기존 검색 integration에서 10개 실패했다. 제품 코드에 mock 호환 예외를 넣지 않고, 해당 fixture에 실제 body text contract를 추가했다. 정상 leased writer에서 malformed HTTP200가 cumulative attempts 4→5/invalid_output으로 저장되고 다음 selector에서 제외되는 3개 회귀도 추가했다. 최종 검색 integration 3파일 **38/38** 통과, 새 변경 scoped eslint와 `git diff --check` 통과했다.

08:09 `npx tsc --noEmit`은 실제 통과했다. 동시 evidence 변경이 반영된 08:12 재실행은 `tests/agent-attribution-audit.test.ts:34`의 `scan_coverage`, `tests/agent-evidence-view.test.ts:42`의 `coverage` 타입 오류로 실패했고 담당 owner에게 전달했다. 담당 수정 뒤 root의 **08:14 실행에서 전체 type check와 unit 259파일/2,515개가 통과**한 결과를 전달받았다. root의 lint/i18n/build/bundle/Python 23개 검증도 통과했다. 다른 owner 파일은 수정하지 않았다.

root의 두 번째 전체 integration에서는 `search-verify.test.ts`의 “키워드를 다시 지으면 검수를 비워 다시 본다”만 추가 실패했다. 08:24:36 own 55445에서 같은 **13개 중 1개 실패**를 실제 재현했다. 생성 HTTP fixture에 `.json`만 있고 `.text`가 없어 generation이 network 실패로 끝나 이전 verifiedAt/키워드가 유지된 원인이었다. 재생성 fixture 한 곳만 매 호출 새 `Response.json(...)`을 반환하도록 바꿨다. assertion·모델·런타임 코드는 바꾸지 않았으며 08:24:58 재실행 **13/13**, scoped eslint, diff check가 통과했다. root의 55448 및 운영 DB는 건드리지 않았다. 전체 integration의 최종 결과는 진행 중인 root 실행으로 확정한다.

## 감사 잡 독립 읽기 전용 리뷰

`lib/crawl/jobs/product-audit.ts`, `scripts/worker.ts`, `scripts/run-job.ts`와 관련 테스트를 읽고 unit 3파일 **25/25** 실제 통과를 확인했다. 1차 unreviewed 우선, gateway full 60초+2초 admission, 65초 tick/70초 outer, cancelled/ownership loss 후 late response 폐기, no_source 기록, queue 보존, 수동·워커 공유 예산을 확인했다. 결과 writer의 DB job-token 검사는 기존 transaction 경계에 남아 있다. 현재 abcllm campaign 경로의 변경에서 blocking finding은 없다. 공식 [review checklist](https://raw.githubusercontent.com/garrytan/gstack/main/review/checklist.md)도 읽어 SQL/경합/출력 검증/계약/검증 변경 범위를 확인했다. 다른 owner의 파일은 편집하지 않았다.

별도 이전 분기 문제: firstReview/audit의 지원 provider는 claude-cli/abcllm/grok-cli이고 Codex는 없다. `product-audit.ts:73,100`은 abcllm 외 전부 Claude CLI adapter/20초 ceiling을 사용하므로 grok-cli campaign을 선택하면 정상 Grok 90초 adapter로 가지 않는다. 현재 고정 abcllm 감사에는 영향 없으며 위치와 재현 조건만 root에게 전달했다. DB write가 시작된 뒤 shutdown 시 transaction 자체를 취소하는 AbortSignal 재검사는 없으므로 저장 전 응답 guard가 시작한 정상 lease transaction의 취소까지 보장하지는 않는다. 실제 token takeover는 writer에서 rollback된다.

## 다음 정확한 명령

독립 DB에서 변경된 검색 계약 검증:

```sh
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55445/nomorevibe_test npm run test:integration -- tests/integration/search-profile-provider-retry.test.ts tests/integration/search-profile.test.ts tests/integration/search-profile-note-correlation.test.ts tests/integration/search-verify.test.ts tests/integration/search-health.test.ts tests/integration/worker-progress-query.test.ts --silent
npm test -- tests/search-health.test.ts tests/text-progress.test.ts --silent
npm test -- tests/search-profile.test.ts tests/product-audit-job.test.ts tests/manual-job-budget.test.ts tests/worker-runtime.test.ts --silent
npx tsc --noEmit
npx eslint lib/domain/products/search-profile-retry.ts lib/domain/products/search-profile.ts lib/domain/products/search-profiles.ts lib/domain/products/search-health.ts lib/operations/text-progress.ts tests/search-profile.test.ts tests/integration/search-profile-provider-retry.test.ts tests/integration/search-profile.test.ts
git diff --check
```

root의 PR/CI/운영 배포 뒤 고정 17건을 새 관측 이름으로 재확인한다. helper는 기존 이름 덮어쓰기를 거절한다. 정상 요청은 이미 대기 중이므로 demand·counter reset을 추가하지 않는다.

```sh
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15-text/run.py after-deploy-search-provider-20261015 verify-recovery.mjs
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15-text/run.py after-deploy-text-progress-20261015
```

첫 명령은 현재 정상 selector가 선택한 고정 cohort ID, 정상 생성 ready 수(500개까지, 상한 여부 별도 표시), 실제 새 generatedAt을 기록한다. 두 번째 probe의 generation ready SQL은 배포 전 상한 정의라 provider cap을 포함하지 않는다. 생성 ready 수는 첫 명령의 정상 운영 함수 결과를 우선하고, 두 번째 결과는 worker 상태와 실제 저장 성과 확인에 사용한다.

숫자 cohort는 새 운영 release/checker hash 일치 확인 뒤 아래 단발 명령을 id마다 한 번만 실행한다. `EXACT_DEPLOYED_RELEASE`에는 실제 검증된 새 release tag를 전달한다. 실패 결과의 반복 실행, unknown 원격 결과의 marker 삭제는 하지 않는다. locked/stopping으로 skip되고 호출 0일 때만 정상 다음 idle을 기다린다.

```sh
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15-text/recover-numeric.py dry-run numeric-recovery-after-deploy-20261015
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15-text/recover-numeric.py apply numeric-recovery-6931-after-deploy-20261015 6931 EXACT_DEPLOYED_RELEASE
```

검수 timeout 19301은 이미 실제 회복됐으므로 다시 적용하지 않는다. 영어 대표 3건은 새 검사에서도 pass하지 않아 저장용 helper나 apply 명령을 준비하지 않았다.

## 09:12 배포 소스 검증과 고정 숫자 실제 회복

root가 text-mini/text-m3의 release `c8f04245e44cb60573cbc2f8685d2f6c4b6f0407`과 readiness를 확인한 뒤, 모델 호출 전에 두 live container의 실제 파일을 추가 검증했다. 현재 main의 tracked `lib/`, `scripts/`, `drizzle/`, package/lock/tsconfig 총 **536파일**(scripts/ops 제외)의 SHA256이 각 앱에서 모두 일치했다. 컨테이너는 각 1개, mismatch 0, 실제 container RELEASE_TAG도 c8f0424였다. manifest SHA256은 `4748f2165b63e082800318c3e5b072646d98de9749a5dbfa40b05e907aabd5f3`, 최종 Korean checker SHA256은 `651cbb41358d89d784701de4218b03ea5e3adb8e3dce43a127caa9c695cc886a`다. private `text-runtime-source-match-20261015-c8f0424.json`과 `numeric-recovery-deployed-c8f0424-20261015.json`에 source/code/fingerprint 검증을 보관했다.

09:13~09:18 KST 고정 숫자 **12건을 각각 fresh generation 한 번씩** 정상 leased writer로 처리했다. 실제 저장은 12건이고, 그중 strict 검사를 통과한 한국어 소개는 **7건**, 품질 실패 저장은 **5건**이다. 실패는 empty 4건과 invented_number 1건이며 다시 호출하지 않았다.

| id | 실제 결과 | attempts 전→후 | qualityRejections 전→후 | audit id |
|---|---|---|---|---|
| 6931 | rejected:empty | 4→5 | 4→5 | 12184 |
| 8785 | 통과·저장 | 4→5 | 4→4 | 12195 |
| 10827 | rejected:empty | 4→5 | 4→5 | 12196 |
| 13794 | 통과·저장 | 4→5 | 4→4 | 12197 |
| 15033 | 통과·저장 | 4→5 | 4→4 | 12198 |
| 15810 | 통과·저장 | 4→5 | 4→4 | 12199 |
| 15979 | 통과·저장 | 4→5 | 4→4 | 12200 |
| 18071 | 통과·저장 | 5→6 | 4→4 | 12201 |
| 23147 | rejected:empty | 4→5 | 4→5 | 12202 |
| 30191 | rejected:empty | 4→5 | 4→5 | 12203 |
| 32579 | 통과·저장 | 4→5 | 4→4 | 12204 |
| 34927 | rejected:invented_number | 4→5 | 4→5 | 12205 |

첫 claim 이후 worker가 잡을 소유한 시점의 11개 시도는 called=false/stored=0으로 skip됐으며 모델 호출로 세지 않는다. 다음 idle에는 일부가 not_requested였다. root가 승인한 표준 manual 계약에 따라 **미실행 marker 없음·현재 fingerprint 일치·현재 not_requested**를 다시 확인한 경우만 `requestJob('product-tagline-ko')` 한 번 후 `runJob(...requestedOnly:true)`를 사용했다. 정상 request append는 9회(versions 4962~4969, 4971)이며 나머지는 이미 존재한 request를 사용했다. 직접 demand/lease/cap/cursor 변경은 없다.

09:21 읽기 전용 actual readback에서 12건의 현재 name/source hash와 원문이 모두 고정 cohort와 같고, attempts/qualityRejections가 위 표와 일치하며 audit 12행을 확인했다. 성공 7건은 현재 source에 대해 배포된 checker로 다시 검사해 모두 pass였다. 모델은 기존 `[MLX] gpt-oss-120b`, 정상 45초 호출/55초 잡 예산을 사용했고 진단 출력은 재사용하지 않았다. 아직 실패한 5건은 이 제한 복구에서 추가 실행하지 않는다. 새 “10회 거절 후 내리기” 정책은 적용하지 않았다.

network 17건은 09:12부터 정상 selector에 모두 재진입했으나 09:17까지 실제 새 저장 0이었다. 최초 생성(profile 없음)이 먼저 정렬되고 현재 ready가 61→81로 늘어나 기존 재시도가 뒤로 가는 상태였다. root는 이미 승인된 정확한 17건만 현재 정상 selector의 fresh task/hash/revision과 현재 모델로 각각 한 번 처리하는 bounded 복구를 승인했다. 코어 우선순위·모델·상한·원문은 바꾸지 않는다. source/runtime/model/full-call budget 검증과 per-id marker/normal request+lease/CAS/official writer를 사용하는 private helper를 준비했으며 결과는 다음에 추가한다.

## 09:25 고정 network 17건 실제 회복 완료

09:20:29 KST 정상 `pendingProfiles(500)`에서 정확한 고정 17건 모두 current network/attempts 5/repairVersion 0으로 선택되는 fresh 입력을 고정했다. 정상 `profileEvidence`의 실제 slice(page/readme 각각 최대 1,500자, description 최대 600자)를 그대로 사용했다. 과거 profile의 저장 hash와 현재 evidence hash가 다른 경우도 현재 원문을 정상 생성 입력으로 사용하고, 모델 호출 전과 official writer 전의 source/profile fingerprint를 다시 비교했다.

모델 호출 전마다 배포 release와 검색 runtime 5파일 SHA를 검사하고, gateway 모델 목록 GET으로 현재 configured `[MLX] gpt-oss-120b`가 실제 제공되는 것을 확인했다. 각 건은 full 45초 호출+저장 여유가 있는 정상 55초 `runJob` lease 안에서 `writeKeywords`→strict parser→`recordProfileResult` CAS로 한 번씩 저장했다. normal request가 없고 job이 idle이며 아직 실행 marker가 없고 fingerprint가 같은 경우만 표준 `requestJob('product-search-profile')`를 한 번 append했다. 이 append는 12회(18366, 18368~18371, 18373~18375, 18377~18380)이며 5건은 기존 request를 사용했다. 작업별 API 호출은 1회, 전체 **17회 HTTP 200**, 최대 실제 호출 23,874ms였다.

**실제 결과: 17건 생성 성공·저장, 실패 0, 미실행 0, unknown 0.** 각 attempts는 5→6, repairVersion은 0 그대로, sourceRevision도 모두 보존됐다. 새 generatedAt은 09:21:21.826~09:24:51.294 KST이며 error/retryAt은 모두 null이다. audit 12206~12222 총 17행과 각 행의 actual modelCalls 1을 확인했다. DB demand/lease/cap/cursor 직접 변경, 입력 위장, 모델/우선순위 변경은 없다. 과거 hash로 현재 source를 덮지 않았고, 저장된 hash는 실제 fresh inputHash 및 현재 sourceHash와 모두 일치한다.

09:25:22 읽기 전용 확인(`network-recovery-confirm-c8f0424-20261015.json`): 17/17 current source/hash/revision/attempt delta/audit가 일치하고 정상 generation selector에서 고정 cohort는 **0건**이다. 새 키워드는 정상 계약대로 verifiedAt=null로 저장되어 기존 semantic verification queue에서 검수할 차례를 기다린다. 생성 복구 성공을 의미하며 이 17건의 별도 검수 완료를 주장하지 않는다.

같은 시각 전체 텍스트 관측은 생성 ready 107/검수 ready 7,900, 한 시간 실제 생성 211/검수 243이었다. 공개 제품의 generation error는 0이고 검수 backoff 오류(model_unavailable 2,185/network 44/timeout 37/invalid_output 22)는 모두 verify cap 아래다. 한국어 소개 완료 36,397/대기 2,602/retryable 실패 8/gaveUp 2,770, 이유 번역 완료 141,150/대기 11,463/failed 0이다. 관측한 text 잡의 job_error는 모두 false다. 이 정상 대기열 전체가 비었다는 뜻은 아니다.

소개 정상 ready 0/현재 사람 큐 102, crawl-tagline ready 0, agreed no_description 3은 현재 source의 유효한 empty 그대로다. 저장소 대상은 새 1건이 더해져 91/정상 due 1/기존 delist hold 36/human 35/keep 19였다. 제품 번역 selectable 266/pending 223/cap 128/backoff 4, 영어 terminal 57은 그대로다. 숫자 invented_number terminal은 정상 작업의 추가 결과를 포함해 59건이다. 신규 발굴 두 잡의 not_before 2100 및 runs(8,905/1,681)는 유지된다.

**현재 고정 numeric 12건과 network 17건은 모두 각 한 번의 실제 호출을 마쳤다. 기존 apply 명령을 다시 실행하거나 marker를 삭제하지 않는다.** 필요하면 새 이름으로 아래 읽기 전용 확인만 한다. private observation/helper는 600, directory는 700이며 원시 env/키/모델 응답을 공개하지 않았다. 이번 단계의 저장소 변경은 이 보고서 append뿐이다.

```sh
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15-text/check-numeric-results.py numeric-readback-next-20261015
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15-text/check-network-results.py network-readback-next-20261015
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15-text/run.py text-progress-next-20261015 probe.mjs text-m3
```
