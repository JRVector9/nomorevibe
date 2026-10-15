# 2026-10-15 공개 근거 출처 처리량

이번 실측 창의 출처 적체는 repository와 canonical site에 집중되어 있다. 같은 origin 동시 수집은 넣지 않았다. 측정된 틱 사이 5~10초 공백은 기존 ready 요청과 crawler `sources` lane의 poll sleep을 이어서 줄인다. 그 공백은 관측 창의 약 9.4%이고, 배포는 되어 있지 않다.

## 관찰

집계는 위임자가 직접 측정했다. Grok은 정제된 합계만 읽었다. 파일은 `/Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15/source-capacity/capacity-20261014T231524Z.json` (로그 창 2026-10-14T22:15:22.998Z–23:15:21.247Z, DB 시각 2026-10-14T23:15:23.805Z).

| 구분 | repository | canonical site (`documentation` / `product_site`) |
| --- | ---: | ---: |
| 전체 | 43,420 | 43,414 |
| due | 25,498 | 25,281 |
| DB `saved_hour` | 962 | 1,001 |
| 로그 `succeeded` | 966건, 합 2,370,669ms, p50 2,279ms, p95 3,475ms, max 11,343ms | 1,007건, 합 752,496ms, p50 517ms, p95 2,215ms, max 8,181ms |
| 로그 `deferred` / `budget` | 46건, 합 63,510ms | 13건, 합 7,206ms |
| 로그 `failed` | 13건, 합 4,190ms | 18건, 합 15,811ms |
| due 오류 행 | 150 | 1,584 |

이 시간 GitHub collector 결과는 `updated:200` 965, `disconnected:not_found` 11, `deferred:transport` 2, `budget_exhausted:budget` 4다. 로그의 succeeded와 DB `saved_hour`는 같은 시간이 아니다. 저장 성공만 다음 간격으로 나가며, deferred·실패·미완료는 성공이 아니다.

`product-evidence-refresh`는 59틱 모두 `done=false`, 길이 n=59, 합 3,246,306ms, p50 55,017ms, p95 55,035ms, max 55,081ms다. 배치 합계는 attempted 1,034, succeeded 947, failed 28, factsChanged 1,967, eventsInserted 336, mediaInserted 0이다. 배치 `succeeded`는 제품 단위 완료이고 출처 저장 건수가 아니다. 출처 소요 합은 약 3,213,882ms로 틱 벽시계의 대부분이다.

origin 집계는 `github.com` due 26,917(origin 1개)과 그 외 due 23,862(origin 22,936개)다. 후자는 선언 URL 기준이다.

## 원인

한 crawler `sources` lane이 협조 예산 55초를 제품마다 순서로 쓴다. 각 제품은 canonical site를 끝낸 뒤 repository를 시작한다. site 관측이 저장된 뒤에야 repository relationship을 계산한다 (`lib/domain/evidence/refresh.ts`의 source 순서, `refreshGitHubEvidence` 끝의 `siteObservedRepository`).

한 제품의 중앙 경로는 site 517ms + repository 2,279ms다. 틱은 이미 55초 경계를 채우고 끝나며, 페이지를 예산이 끝날 때까지 이어서 읽는다. `batchSize`를 키워도 같은 예산 안에 출처 합이 들어가지 않는다.

repository 자체는 `api.github.com`에 대한 조건부 캐시·체크포인트가 있는 직렬 호출이다. 이번 변경은 같은 origin의 HTTP 동시성을 늘리지 않는 제약을 두었고, 기존 GitHub 제공자의 직렬 호출을 유지했다. 시간당 저장 약 962건은 이 직렬 체인과 앞선 site가 55초 틱을 채운 결과와 맞다. 쿼터 바닥(15%)이나 배치 크기가 이 창의 상한으로 보이지 않는다. 쿼터 숫자는 이 집계에 없다.

## 검토했으나 하지 않은 것

- generic·npm·rss·support 링크만 최대 2개로 겹치기. 이 창의 활성 due와 로그 종류는 repository와 canonical site뿐이다. 효과 없는 범위다.
- 선언 origin만 보고 site HTTP와 repository HTTP를 겹치기. 리다이렉트는 하나의 origin으로 모일 수 있다. npm API origin과 선언 URL, 커스텀 제공자, 최종 origin은 선언 URL로 알 수 없다. 선언 origin 그룹은 same-origin 금지를 지키지 못한다.
- 같은 제품에서 site 저장 전에 GitHub relationship을 읽기. 현재 순서는 그 읽기 전에 site 증거가 있게 한다. 그 장벽을 collector 안으로 옮기려면 `github.ts`와 네트워크 경로를 고쳐야 하고, 이번 조사에서는 더 큰 네트워크·collector 변경의 효과와 안전성이 검증되지 않아 구현 범위에 포함하지 않았다.
- 다음 제품의 site를 이전 제품의 GitHub 호출과 겹치기. 커서·요청 progress·lease 손실 시 남은 쓰기를 거두는 순서에 더해, 위와 같은 최종 origin 문제가 있다.
- 전역 HTTP 동시성 가드나 provider commit hook. 네트워크 어댑터 변경이 필요하고, 이번 측정만으로 이득이 증명되지 않는다.

## 자동 처리가 해야 하는 일

due인 canonical site를 먼저 수집·저장하고, 이어서 같은 제품의 repository를 수집한다. 저장된 현재 URL 관측만 성공이다. 예산으로 끊긴 partial·deferred는 성공이 아니며 커서를 그 제품 뒤로 넘긴 채 다음 틱에서 재개한다. 강제 요청의 `requestedVersion` / `activeVersion` / progress는 기존 CAS와 lease 순서를 유지한다. 예산·abort 이후에는 새 읽기·쓰기를 시작하지 않는다. SSRF, 공인 IP, 응답 크기, 조건부 endpoint cache, GitHub 쿼터·쿨다운, 15% 여유는 그대로다.

겹침을 검토한 산술이다. site 성공 합 752,496ms가 틱 안에 완전히 숨어도 repository 성공 합 2,370,669ms는 남는다. 그 가정에서 시간당 repository 저장 962건이 약 1,300건 근처로 보이는 것은 가설이지 측정된 처리량이 아니다. 96시간 간격이면 약 43,420 / 96 ≈ 시간당 452건이 다시 due가 된다. 미래 성공을 예약하지 않는다.

## 틱 사이 공백

`/Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15/source-capacity/gaps-20261014T232206Z.json` (2026-10-14T23:22:06Z, 2시간 tail). 55초 틱 118개, 길이 합 6,492,499ms, `done` 0. 틱 사이 117간격 합 671,048ms, p50 5,007ms, p95 10,013ms, min 5,004ms, max 10,018ms. 5초 초과 117, 10초 초과 17. 관측 구간 7,108,522ms 중 공백은 671,048 / 7,108,522 ≈ 9.44%다. 공백이 전부 사라진다는 가정이면 상대 처리량은 약 1/0.9056 − 1 ≈ 10.4%다. 이것은 가설이다. 실패·quota·partial 가드가 있으면 실제 이득은 더 작다. 배포 결과가 아니다. 핸들러와 runner만 요청을 올려도 `scripts/worker.ts`의 `runLane`은 poll마다 기본 5초를 잔다. 그래서 source lane이 검증된 continuation일 때만 그 sleep 한 번을 건너뛴다.

## 수정

1. `refreshProductEvidenceJob`은 공유 `deadlineAt`이 지났고, abort가 아니고, `counts.succeeded > 0`이며 `counts.failed === 0`이고, 수행된 refresh 로그의 `httpClass` 또는 `outcome`이 `rate_limited`·`auth_unavailable`·`quota`·`cooldown`·`backoff`가 아니고, 이미 고른 due 페이지에 아직 시도하지 않은 뒤 제품이 있을 때만 `continuation: "ready"`를 낸다. `ctx.log`는 바꾸지 않고 `sourceDependencies.log`에서 hold를 본다. 강제 요청이 먼저 완료되면 그 완료도 `succeeded`에 들어간다. 데드라인 뒤에 새 due 조회는 하지 않는다. 미완료만 있고 완료가 없으면 ready가 없다.
2. `runJob`은 `product-evidence-refresh`이고 `done === false`, 실행 예산이 실제로 지났고, abort가 아닐 때만 그 ready를 본다. 같은 lease CAS에서 `notBefore`가 미래(일시정지·백오프)면 버전을 올리지 않고 그 시각을 남긴다. 바깥에서 이미 올린 `requestedVersion`은 다시 올리지 않는다. `sourceContinuation`은 `UPDATE ... RETURNING`의 `requestedVersion > processedVersion and (notBefore is null or notBefore <= now())`가 DB `now()` 기준으로 참일 때만 붙는다. 앱 시계와 비교하지 않는다. review continuation SQL은 그대로다.
3. crawler lane 이름이 정확히 `['product-evidence-refresh']`이고 결과가 completed, `done === false`, `sourceContinuation === true`일 때만 다음 poll 전 sleep을 한 번 건너뛴다. 다음 반복은 다시 pending을 읽는다. 비면 보통 5초를 잔다. `once`와 abort는 그대로 끝난다.

스케줄 간격 1분, source 예산 55초, 제품·origin 직렬, 역할 lease 5개는 그대로다. continuation은 큐 신호이고 출처 저장 성공이 아니다.

## 테스트

첫 구현 RED에서 제품 실패는 두 가지였다. continuation이 없고, source lane이 두 번째 poll 전에 sleep했다(polls 1, expected 2). 빈 due와 dependency 단언이 `{ done: false, cursor: null }`과 달랐던 것은 고친 fixture다. 그 4건을 모두 제품 RED로 세지 않는다. runner RED 2건은 예산 경과 후 marker 부재와, 외부 요청이 있어도 marker가 없던 것이다.

안전 보강 RED (프로덕션 수정 전):

- `npx vitest run tests/evidence-refresh-continuation.test.ts tests/worker-runtime.test.ts` — 2 failed / 22 passed. 실패는 미완료 alpha가 뒤 제품이 있어도 `continuation: "ready"`를 낸 것, `ctx.log`가 다른 함수로 바뀐 것. worker 17은 통과(skipped/done:true/once/abort/mixed lane은 기존 sleep 규칙과 맞음).
- `TZ=UTC TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55450/nomorevibe_test npx vitest run tests/integration/source-continuation.test.ts --config vitest.integration.config.ts` — 1 failed / 6 passed. 실패는 DB `now()+1 hour` backoff와 외부 version 2인데 앱 시계를 2시간 앞으로 옮기면 `sourceContinuation: true`가 나온 것. stolen lease CAS와 signal abort는 이미 통과했다.

GREEN:

- `npx vitest run tests/evidence-refresh-continuation.test.ts tests/worker-runtime.test.ts tests/evidence-refresh-cancellation.test.ts tests/product-refresh-progress.test.ts tests/github-evidence.test.ts` — 5 files, 82 tests passed (continuation 7, worker-runtime 17, cancellation 41, progress 4, GitHub unit 13).
- `TZ=UTC TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55450/nomorevibe_test npx vitest run tests/integration/source-continuation.test.ts tests/integration/review-draining.test.ts tests/integration/job-runner.test.ts tests/integration/evidence-refresh.test.ts --config vitest.integration.config.ts` — 4 files, 55 tests passed (source-continuation 7, review-draining 3, job-runner 19, evidence-refresh 26).
- `npx eslint lib/jobs/runner.ts lib/jobs/products/evidence-refresh.ts scripts/worker.ts tests/evidence-refresh-continuation.test.ts tests/integration/source-continuation.test.ts tests/worker-runtime.test.ts` — 오류 없음.
- `git diff --check` — 공백 오류 없음.
- 전체 `tsc`는 이전에 생성된 Next `PageProps` 부재로 실패했다. 그 파일은 고치지 않았고, 이번 변경의 타입 통과로 보지 않는다.

## 모델

세션 `01a13cb0-ae94-76d2-ae5c-cacfba1fba78`. 저장된 `current_model_id=grok-4.7`, `reasoning_effort=low`. CLI 1.0.52, 인증 카탈로그의 grok-4.7. Grok 작업 도구에는 자격 증명을 전달하지 않았다. CLI 자체의 정상 인증만 사용했다. 마지막 안전 보강 재개는 종료 코드 0, 198.3초였고 단위 82개와 통합 55개를 통과했다.

## 남은 한계

- 공백 비율 9.44%와 상대 10.4%는 공백이 모두 없을 때의 가설이다. 완료 제품·hold·DB 미래 `notBefore` 가드가 있으면 더 작다. 배포 결과가 아니다. 백로그가 비워졌다고 보지 않는다.
- due는 repository 25,498, canonical site 25,281이다. 직렬 GitHub 체인과 site 다음 repository 순서는 그대로다.
- 배포·프로덕션 반영 없음. 로그 succeeded(966/1,007), DB saved_hour(962/1,001), 배치 succeeded(947)는 서로 다른 수다.
- collector 수정과 admin source-demand 수정은 이 diff 밖에 있다. `scripts/worker.ts`는 `runLane`과 run 결과 타입만 건드렸다.

## 실제 Grok 실행과 통합

별도 detached worktree에서 동일 세션을 재개한 실제 명령이다. 모델과 effort는 실행 인자와 세션 metadata 양쪽에서 확인했다.

```bash
grok --cwd /private/tmp/nomorevibe-grok-source-capacity-20261015 \
  --continue --prompt-file '<private source-capacity/hardening.txt>' \
  --model grok-4.7 --reasoning-effort low \
  --output-format streaming-json --max-turns 60 \
  --disable-web-search --no-subagents --no-plan --permission-mode acceptEdits \
  --tools read_file,list_dir,grep,glob,search_replace,write_file,run_terminal_cmd \
  --deny 'Read(.env*)' --deny 'Read(**/.env*)'
```

실측 집계·지시문·CLI 로그는 위 비공개 `source-capacity` 디렉터리(0700), 파일(0600)에 보관했다. Grok에는 원시 환경값·키·인증 파일·개인정보와 운영 접속 권한을 전달하지 않았다. 원문 갱신 5만여 건을 모델 호출로 전환하지 않았다.

검토한 patch만 현재 작업트리에 적용했으며 별도 `product-audit` 예산 70초 변경을 보존했다. commit·PR·배포·최신 base 전체 검증과 배포 후 실제 저장 처리량 측정은 통합 담당자가 이어간다.

## 현재 작업트리 재검증

2026-10-15 08:38 KST, 검토한 patch 통합 후 직접 실행했다.

- 위 단위 5파일 명령: 83개 통과. 현재 base의 `product-audit` 예산 회귀 1개를 보존해 worker-runtime은 18개이며 격리 worktree의 82개보다 1개 많다.
- 위 DB 4파일 명령 (`TZ=UTC`, 독립 PostgreSQL 55450): 55개 통과.
- 대상 6파일 `npx eslint` 및 `npx tsc --noEmit --pretty false --incremental false`: 각각 종료 코드 0. 현재 작업트리의 생성된 Next 타입을 사용했다. 격리 worktree의 생성 타입 부재 실패를 이 결과와 구분한다.
- `git diff --check`: 종료 코드 0.

비공개 실행 기록: `source-capacity/integrated-unit.log`, `integrated-db.log`, `integrated-static.log` (0600).

## 배포 후 직접 관측 — 2026-10-15 09:14 KST

PR #421 병합 release는 `c8f04245e44cb60573cbc2f8685d2f6c4b6f0407`이다. crawler pair와 failback 준비 완료 통보 시각 `2026-10-15T00:09:30Z`를 고정 cutoff로 삼았다. M3의 실제 컨테이너 `RELEASE_TAG`, DB 접속 프로세스의 release tag, 위 production 세 파일의 SHA256이 해당 git commit과 모두 일치했다. crawler role은 같은 release의 primary, epoch 92, 유효한 lease였으며 quarantine은 없었다. 환경값 전체나 자격 증명은 출력하지 않았다.

최종 capture DB 시각은 `2026-10-15T00:14:58.665Z`이다. cutoff 뒤 **328.665초**를 실제 기다렸고, cutoff 이후에 시작해서 완료된 source 틱 **5개**를 확인했다. 틱 실행 실패(`job.failed`)는 0이다. 최초 runtime attestation(00:10:05Z)과 중간 3틱 관측(00:13:02Z)은 이 최종 조건을 충족한 것으로 세지 않았다.

재시작 공백은 완료 로그 시각에서 다음 틱의 실제 `durationMs`를 빼 계산했다. 이전 배치의 실패 유무를 같은 틱의 `evidence.refresh_batch`와 연결했다.

| 직전 배치 | 배포 전 1시간 구간 | 배포 후 완전한 5틱 사이 |
| --- | --- | --- |
| failed = 0, completed product 있음 | 30간격, 5,004–10,016ms | **2간격, 4ms·6ms** |
| failed > 0 | 27간격, 5,005–10,015ms | **2간격, 5,005ms·5,008ms** |

따라서 오류 없는 작업의 즉시 재개와, 실패가 있으면 기존 5초 sleep을 남기는 동작을 운영에서 모두 확인했다. source budget은 계속 약 55초이며, 짧은 반복으로 바뀐 것이 아니다. post 표본은 네 간격이므로 전체 중앙값이나 백분위 하나로 효과를 대표하지 않는다.

배포 직전 추가 before capture(00:01:40.701Z)는 기존 기준과 별도 이름으로 보존했다. before 1시간 창은 `2026-10-14T23:01:39.257611Z`부터이며, after 창은 위 cutoff부터다. 아래 최근 5분 값은 각 capture 직전의 창이다.

| 현재 공개 제품·visible link·현재 URL 기준 | before 00:01:40Z | after 00:14:58Z |
| --- | ---: | ---: |
| DB 실제 성공 관측 시각 기준 최근 5분의 고유 출처 | 146 | 152 |
| Docker wall clock `succeeded` 이벤트 최근 5분 | 152 | 181 |
| due 출처(미생성 초기 일감 포함) | 50,344 (3) | 50,212 (4) |
| 미래 retry와 현재 error가 있는 출처 | 227 | 229 |
| GitHub partial checkpoint | 407 | 418 |
| 미래 rate_limited/auth_unavailable 출처 | 0 | 0 |

post cutoff 이후 DB의 현재 URL 성공 관측은 고유 출처 185개, wall clock 성공 이벤트는 201개다. 두 값은 같은 정의가 아니다. 기존 provider는 틱 시작 `now`를 관측 시각으로 사용하고, 이벤트는 실제 완료 때 기록한다. 그 clock을 변경하지 않았다. before 23:46Z 기준의 별도 12개 5분 이벤트 구간도 152–188건(평균 162.67, 중앙 160.5)으로 변동했다. 이번 181건만으로 처리량 인과 효과나 장기 용량을 주장하지 않는다. 배포 직후 시간당 DB 저장 1,907건은 이전 release의 실적이 섞여 있어 개선율 계산에 사용하지 않는다.

이 첫 post 5분에는 다른 역할의 이미지 빌드·순차 재배포가 겹쳤다. 확인한 것은 위 조건별 gap 동작과 짧은 실제 저장 관측이다. 앞선 10.4%는 모든 공백을 제거한다는 가정이며 측정 결과가 아니다. 바로 전 before에서 실패 없는 30간격만 전부 없앤다는 산술도 약 5.1%에 그친다. 이것 역시 구현의 예측치나 보장치가 아니다. 재개 허용 여부, source latency, 실패, quota와 제품 구성이 달라진다.

최종 PAT/App core 잔량은 각각 3,252/5,000과 2,975/5,000이었다. 15% 여유와 quota 정책을 바꾸지 않았다. 신규 발굴 `crawl-seed`/`hn-show-seed`는 계속 `2100-01-01` 중단이며 runs 8,905/1,681도 before와 같다. checkpoint·retry·완료 시각을 직접 수정하지 않았다. 남은 source 적체 50,212건이 모두 완료됐다고 보지 않는다.

비공개 proof(기존 `source-capacity/`, 파일 0600):

- `before-release-20261015T000141266197Z.json` — 바로 전 old release/env/파일 hash/DB role까지 검증한 기준.
- `before-release-20261014T234604117680Z.json`, `before-five-minute-buckets-20261014T235718843756Z.json` — 앞선 기준과 5분 자연 변동, 원본 보존.
- `after-release-20261015T001006000373Z.json`, `after-release-20261015T001302635623Z.json` — 초기/중간 관측.
- `after-release-20261015T001459218014Z.json` — 328.665초·완전 5틱 최종 원자료.
- `comparison-20261015T001515477016Z.json` — SHA·파일 hash·role·300초·5틱 gate가 전부 참인 비교. gap 백분위는 작은 표본의 경험적 하위 순위 값이므로 위 개별 간격을 우선한다.

실행한 read-only 관측 명령:

```bash
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15/source-capacity/observe-release.py \
  --phase after-release --since 2026-10-15T00:09:30Z \
  --expected-sha c8f04245e44cb60573cbc2f8685d2f6c4b6f0407
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15/source-capacity/compare-release.py \
  /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15/source-capacity/before-release-20261015T000141266197Z.json \
  /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-15/source-capacity/after-release-20261015T001459218014Z.json
```

Docker inspect·bounded logs·파일 hash 읽기와 DB `READ ONLY` transaction만 사용했다. 이 관측에서 추가 Grok 호출, 코드·모델·역할 설정 변경, 운영 쓰기는 하지 않았다.

## 전체 배포 검증 뒤 추가 관측 1회 — 2026-10-15 09:26 KST

13앱 검증 완료 통보(약 00:19:20Z) 뒤 `2026-10-15T00:19:30Z`를 새 cutoff로 고정했다. 외부 배포 없이 `00:26:05.661Z`까지 **395.661초**를 실제 기다려, cutoff 뒤 시작해 완료된 틱 **5개**, 실행 실패 **0개**를 확인했다. 이 기간에도 text/reviewer 등 정상 역할의 복구 작업은 계속될 수 있었다. 유휴 서버나 최대 처리량 실험이 아니다.

release는 계속 `c8f04245e44cb60573cbc2f8685d2f6c4b6f0407`이었다. 실제 runtime tag·DB 프로세스 tag·핵심 세 파일 hash가 git과 일치했고, crawler는 primary/epoch 92의 같은 live lease를 유지했다. 추가로 확인한 네 공백은 실패 없는 직전 배치 뒤 **4ms·5ms**, 실패가 있는 직전 배치 뒤 **5,006ms·10,012ms**였다. 즉시 재개와 실패 시 기존 polling 대기 보존이 다시 관측됐다. 틱 길이도 계속 약 55초다.

| 최신 5분/현재 수요 | 첫 post 00:14:58Z | 추가 관측 00:26:05Z |
| --- | ---: | ---: |
| DB 성공 관측 시각 기준 고유 출처 | 152 | 141 |
| Docker wall clock 성공 이벤트 | 181 | 148 |
| Docker 실패/예산 deferred 이벤트 | 4 / 5 | 2 / 5 |
| due 출처(미생성 포함) | 50,212 (4) | 50,134 (3) |
| 미래 retry + error 출처 / GitHub partial | 229 / 418 | 228 / 426 |
| quota/auth로 미래 대기 중인 출처 | 0 | 0 |

추가 cutoff 이후 DB의 현재 URL 성공 관측은 163개, wall clock 성공 이벤트는 188개다. 최근 5분의 저장 수는 첫 post보다 낮다. 네트워크 지연·실패·일감 구성과 정상 복구 부하가 섞이는 작은 표본에서 전체 처리량 개선율을 주장할 수 없다. **확인된 결론은 조건을 만족하는 배치 사이의 불필요한 5초 sleep을 줄였고, 실패가 있으면 기존 polling 대기를 남긴다는 것**이다. quota/auth hold는 이 구간에 0건이어서 실제 발생 시의 재개 억제 동작을 이 운영 표본으로 검증했다고 보지 않는다. 전체 공백 제거 10.4% 가정과 이 실제 결과를 같은 수치로 읽지 않는다. 시간당 DB 저장 1,915건도 이전 release 구간이 섞여 있다.

PAT/App core 잔량은 2,486/5,000과 2,203/5,000이었다. 신규 GitHub/Show HN 발굴의 `2100-01-01` pause와 runs 8,905/1,681은 그대로다. due 50,134건, retry·partial과 정상 복구 작업이 남아 있으며 완료로 표시하거나 시각·lease를 직접 고치지 않았다. 추가 관측은 허용된 한 번으로 끝냈다.

비공개 proof(0600)는 `after-release-20261015T002606188633Z.json`과 `comparison-20261015T002643511812Z.json`이다. 비교 gate는 같은 release/tag/hash/live role·300초 이상·완전 5틱을 모두 확인한다. observer 명령은 앞선 것과 같고 `--since 2026-10-15T00:19:30Z`를 사용했다. 이 단계의 저장소 변경은 이 추가 기록뿐이며, 추가 모델 호출·운영 쓰기·코드 변경은 없다.
