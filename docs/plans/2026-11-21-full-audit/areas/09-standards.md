# 09. 개발 표준·관행 — 점검 결과

> 2026-11-21 전수 점검의 구역 문서다(점검 기준 origin/main `34b5fe32`, 읽기 전용). 수정 순서와 묶음은 [README](../README.md), 실측은 [evidence](../evidence.md)·`../evidence/`.
> 줄 번호는 그 커밋 기준이다. 「확신도」가 PLAUSIBLE 인 항목은 적힌 확인을 먼저 한다.


대상: `저장소 루트` (origin/main `34b5fe32`). 읽기 전용(`rg`·파일 읽기·`git log/show`)만 썼다. 테스트·빌드·tsc 는 돌리지 않았다.
개수는 테스트 파일(`*.test.*`)을 뺀 `app lib components scripts proxy.ts instrumentation*.ts` 기준(소스 1,895파일)이다.

## 요약 (심각도별 건수, 가장 중요한 5개 한 줄씩)

- P0 0 · P1 0 · **P2 2** · P3 14 (모두 16건). 2차 검증에서 STD-03·04·05·06 을 P2 → P3 로 내렸다(까닭은 각 항목과 맨 끝 「검증 기록 (2차)」).
  1차 집계는 P2 6 · P3 10 이었다.
- 가장 중요한 5개
  1. STD-01 (P2) 공통 로거가 `Error.message` 와 `stack` 첫 줄들을 그대로 남긴다. 그래서 drizzle 오류의 **SQL·params 가 로그에 찍히고**, SQLSTATE(cause)는 빠진다. 원시 오류를 넘기는 호출이 43곳이고(그중 2곳은 문자열), 모든 API 500 응답(`http.unhandled`)과 잡 실패 로그(`job.failed`)도 여기에 들어간다.
  2. STD-02 (P2) 운영 진입점 13곳(역할 워커·감독·scheduler·monitor·소비자)이 최상위 오류를 버리고 「check configuration」 한 줄만 남긴다. 그래서 크래시 루프가 나도 원인이 로그에 없다.
  3. STD-03 ([부분 반증], P2 → P3) `pipeline-control` 스냅숏이 **트랜잭션 안의 DB 오류를 savepoint 없이 `.catch` 로 삼키려 한다**. 그러나 postgres.js 3.4.9 는 범위 안의 첫 오류를 기억했다가 다시 던진다. 그래서 1차가 말한 「관문이 조용히 꺼진다」는 일어나지 않는다. dry-run 은 원래 오류로 실패하고, 실행은 25P02 로 원인을 가린다. 주석이 의도한 「모름으로 둔다」는 어느 경로에서도 동작하지 않는다.
  4. STD-04 ([부분 반증], P2 → P3) `timestamp without time zone` 열이 약 250개이고 TZ 고정이 없다. 다만 drizzle 이 postgres.js 의 날짜 파서를 바꿔 끼워, 형이 있는 칸은 프로세스 시간대와 무관하게 UTC 로 읽는다. 남는 의존은 DB 세션 TimeZone(`now()` 로 쓰는 값)과 날 문자열을 `new Date()` 로 읽는 곳뿐이다.
  5. STD-05 ([부분 반증], P2 → P3) 기본 등록부에 Tailscale 주소 URL 4개(호스트 3개)·ts.net 호스트 1개·모델 10개가 들어 있다. effort 선택지와 프롬프트는 모델 **이름**으로 고른다. env 가 관리자 값을 이기는 것은 `MODEL_REGISTRY_CONFIG` 하나뿐이다. `EMBEDDING_URL`·`RERANK_URL`·`LOCAL_MODEL_SERVING_CONTRACTS` 는 관리자 행이 없을 때 쓰는 대체값이다.

## 발견

### STD-01 공통 로거가 오류의 message 를 그대로 기록해 SQL params 가 새고, SQLSTATE 는 사라진다
- 심각도: P2
- 분류: non-standard
- 위치:
  - `lib/observability/logger.ts:28-30`
    ```ts
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack?.split("\n").slice(0, 4) };
    }
    ```
  - drizzle 오류의 message: `node_modules/drizzle-orm/errors.js:10-13`, ``super(`Failed query: ${query}\nparams: ${params}`)`` — 원 PostgresError 는 `cause` 에만 있다. drizzle 0.45.2 의 `pg-core/session.js` 가 모든 쿼리 실패를 이 오류로 감싼다(41·48·59·66·81·98줄).
  - `stack` 도 새는 길이다: `Error.stack` 의 첫 줄은 `DrizzleQueryError: Failed query: …` 이고, SQL 에 줄바꿈이 있으면 `slice(0, 4)` 네 줄이 모두 SQL·params 일 수 있다. message 만 비우는 수정으로는 막히지 않는다.
  - 원시 오류를 넘기는 곳: 43곳(2차에서 같은 정규식 `rg 'logger\.\w+\([^;]*\berror(: e|: err|: error)?\s*[,}]'` 로 테스트 밖 소스를 다시 셈). 그중 2곳(`lib/domain/products/search-translation.ts:211`, `app/(operator)/admin/actions.ts:262`)은 `error: result.error` 문자열이다. 대표:
    - `lib/http/handler.ts:65`, `logger.error("http.unhandled", { ...base, durationMs, error })` — `withRoute` 를 쓰는 라우트 파일 39개(호출 48곳)의 처리되지 않은 예외 전부
    - `lib/domain/products/register.ts:138`, `logger.error("register.insert_failed", { url, slug, error: e })` — 이 INSERT 의 params 에는 `verifyToken` 원문과 `editTokenHash` 가 든다(`lib/domain/products/register.ts:111-124`). 로거의 키 가림(`token`)은 message 안의 params 에 닿지 않는다.
    - `lib/crawl/publish.ts:272`, `logger.error("crawl.publish_failed", { …, error: e })`
    - `lib/jobs/runner.ts:367`, `logger.error("job.failed", { …, error })` — SQLSTATE 머리말을 따로 붙이지만 원시 error 도 함께 넘긴다
    - `app/(public)/[locale]/(content)/page.tsx:368·488·597`, `lib/cache/shared.ts:93`
  - 같은 문제를 이미 푼 도우미: `lib/db/error-fields.ts:22-29` `dbErrorFields`(cause 사슬의 SQLSTATE, 감싼 message 버림, `postgres://` 가림). 이 도우미와 `dbErrorTag` 는 8파일(32회)이 쓴다. 그러나 잡 실패 경로(`lib/jobs/runner.ts:351-356`)도 `[40P01]` 같은 머리말만 붙이고 message 전체(SQL·params)를 `jobs.last_error`(2,000자)에 저장한다.
- 문제: `redact()` 는 **키 이름**만 가린다(`/token|secret|password|…/`). Error 는 message·stack 을 통째로 남기고 `cause` 는 따라가지 않는다. 사이에서 거르는 층(stdout 감싸기·instrumentation 훅)도 없다(`instrumentation.ts` 는 tailnet DNS·웹 관측만 건다).
  - 실패 시나리오: 쓰기 라우트(`/api/products` 등록, `/api/auth/*`, `/api/products/[slug]/takedown`)에서 제약 위반이나 시간 초과가 나면 `http.unhandled` 한 줄에 그 INSERT 의 SQL 전문과 `params:`(입력 URL·이메일·검증 토큰 원문·토큰 해시·자유 글)가 stderr 로 나가 Dokploy 로그에 남는다.
  - 그 줄에는 정작 SQLSTATE(23505·57014·55P03)가 없어 원인 분류를 할 수 없다. 2026-10-29 잡 로그에서 교착(40P01)이 일반 실패처럼 보였던 것(`lib/db/error-fields.ts:32-34` 주석)과 같은 문제가 웹·발행 로그에 그대로 남아 있다.
- 실측 근거: 코드 근거만(운영 로그는 받지 않았다).
- 수정 방안: `redact()` 의 Error 분기를 `dbErrorFields()` 와 같은 규칙으로 바꾼다.
  - cause 사슬(최대 5단)에서 `code` 가 있는 오류의 `code·name` 과 잘린 message 를 남긴다.
  - `DrizzleQueryError`/`Failed query:` 면 message 를 비우고, `stack` 에서는 message 줄을 빼고 `at …` 줄만 남긴다.
  - `query`·`params`·`detail` 속성은 읽지 않는다.
  - 호출부 43곳은 그대로 두어도 된다(로거 한 곳만 고친다). `jobs.last_error` 저장(`lib/jobs/runner.ts:353-356`)도 같은 규칙으로 바꾼다.
- 검증:
  - `tests/logger.test.ts` 에 `new DrizzleQueryError("insert …", ["a@b.c"], pgError)` 를 넣고, 출력 JSON(message·stack 모두)에 `a@b.c`·`Failed query` 가 없고 `code:"23505"` 가 있는지 확인한다.
  - `tests/handler.test.ts` 의 500 경로도 같은 단언으로 본다.
- 배포 주의: 일반 배포. 로그를 grep 하는 운영 스크립트가 `error.message` 모양에 기대는지 확인한다.
- 확신도: CONFIRMED (2차 반증 시도: 로거 앞에서 거르는 층이 있는지 찾았으나 없다. drizzle 0.45.2 가 모든 실패를 `DrizzleQueryError` 로 감싸는 것, stack 도 같은 내용을 싣는 것, 등록 INSERT params 에 검증 토큰 원문이 드는 것을 코드로 확인했다. 운영 로그 실물은 보지 않았다.)
- 규모: S

### STD-02 운영 진입점 13곳이 최상위 오류를 버린다
- 심각도: P2
- 분류: non-standard
- 위치(모두 `void main().catch(() => { console.error('… failed; check … configuration'); process.exitCode = 1; })` 모양):
  - `scripts/role-worker.ts:704`, `scripts/worker-supervisor.ts:391`(Dockerfile 워커 CMD), `scripts/scheduler.ts:76-78`, `scripts/run-job.ts:42`
  - `scripts/watch-failover-readiness.ts:235`(monitor CMD), `scripts/pipeline-consumer.ts:38`, `scripts/pipeline-first-consumer.ts:41`, `scripts/agent-scan-consumer.ts:53`
  - `scripts/github-ko-discovery-consumer.ts:40`, `scripts/uptime-consumer.ts:37`, `scripts/evidence-worker.ts:66`, `scripts/cli-host-bridge.ts:132`
  - `scripts/worker.ts:434-436`: `Usage:` 일 때만 message 를 낸다.
  - (2차 재계산) 위 13곳이 맞다. 같은 모양이 운영 보조 진입점 3곳에도 있다: `scripts/x-collector.ts:49`, `scripts/local-model-relay/server.ts:49`, `scripts/ops/admin-models-ops-runner.ts:44`(일회성 `scripts/backfill-agent-evidence.ts:122` 은 셈에서 뺐다).
  - `process.on('unhandledRejection'|'uncaughtException')` 처리기는 어디에도 없다(테스트 밖 소스를 rg 로 확인. `lib/db/pool.ts:125` 는 주석이다).
  - 의도를 밝힌 주석은 없다(`scripts/role-worker.ts:703-705` 주변, 처음 넣은 커밋 `8401edfb`).
- 문제: 루프 안의 예상된 실패는 `runtimeLog` 로 남는다(예: `role-worker.ts:352-354`). 하지만 설정 검사(`assertHostDbEntry`, `role-worker.ts:606`), 모듈 초기화, 예상 못 한 throw 는 최상위까지 올라와 **원인 없이 한 줄**만 남긴다.
  - 실패 시나리오: Dokploy env 값에 `#` 가 섞여 잘렸거나(메모 11-01) 풀 예산 env 가 틀린 역할 워커는 5분 안에 3번 재부팅되어 `primary_quarantined` 15분에 들어간다. 그동안 로그에는 「role worker failed; check role/database/environment configuration」만 반복된다. 운영자가 컨테이너에 들어가 직접 재현해야 원인이 보인다(메모 「크래시 로그는 루프 중에 떠 둘 것」).
- 실측 근거: 코드 근거만.
- 수정 방안: 공통 `reportFatal(event, error)` 를 두고 13곳이 모두 쓰게 한다. `dbErrorFields(error)`(이미 `postgres://`·password 를 가림)와 Error 이름·첫 스택 4줄을 JSON 한 줄로 stderr 에 쓴다. 같은 함수를 `unhandledRejection` 에도 건다. 비밀이 새지 않게 한다는 지금 의도는 `dbErrorFields` 가 지킨다.
- 검증: `tests/role-worker.test.ts` 에서 `assertHostDbEntry` 가 던지게 했을 때 stderr JSON 에 `name`·`message`(가린 것)가 있는지 확인한다. 13곳(+보조 3곳)을 rg 로 다시 세어 0인지 본다.
- 배포 주의: 공통 worker digest 를 쓰는 앱 전부(text·maintenance·scheduler 포함). 일반 배포.
- 확신도: CONFIRMED (2차: 13곳을 줄 단위로 다시 확인했고, 루프 밖 오류가 다른 경로로 기록되는지 찾았으나 없다. 크래시 루프가 실제로 원인 없이 반복된 사례는 메모 근거만 있다.)
- 규모: S

### [부분 반증] STD-03 트랜잭션 안의 DB 오류를 savepoint 없이 `.catch` 로 삼키려 하지만 삼켜지지 않는다 — 의도한 「모름」 대신 dry-run 은 원래 오류로 실패하고, 실행은 25P02 로 원인을 가린다
- 반증 까닭(2차): 1차의 「TX 가 abort 되어 뒤 읽기가 조용히 비고 OPEN 의 `device_unconfigured` 관문이 꺼진다」는 성립하지 않는다. postgres.js 3.4.9 의 `begin` 범위는 그 안의 모든 문장에 `q.catch(e => uncaughtError || (uncaughtError = e))` 를 건다(`node_modules/postgres/src/index.js:291-292`). 콜백이 끝나면 `if (uncaughtError) throw uncaughtError` 로 첫 오류를 다시 던지고 ROLLBACK 한다(`:265-272`). JS 의 `.catch` 는 그 기록을 지우지 못한다. 그래서 관문이 「조용히」 빠지는 경로가 없다. 남는 결함은 주석이 의도한 「모름으로 둔다」가 동작하지 않는다는 것과, 실행 경로의 원인 가림이다.
- 심각도: P3 (2차에서 P2 → P3. 관문이 꺼지는 경로가 없고(위), 장비 상태 쿼리가 실제로 실패한 근거도 없다. 느린 문장 64개 모양에 `model_capacity_devices` 가 없다.)
- 분류: logic
- 위치:
  - `lib/operations/pipeline-control-repository.ts:105-109`
    ```ts
    // … 표를 못 읽으면 장비 판정은 모름(devices 없음)으로 둔다.
    const devices = await readModelCapacityDeviceStates(tx as unknown as ProductTransaction).catch(() => undefined);
    …
    const assignments = assignmentTableEnabled() ? await readAssignmentStatus(tx).catch(() => undefined) : undefined;
    ```
  - 쓰기 TX 경로 `pipeline-control-repository.ts:192-200`: `snapshotIn(tx)` → `transition(tx…)` → `snapshotIn(tx)` → 감사 행 insert.
  - 관문: `lib/operations/pipeline-control.ts:432` `deviceRows = snapshot.devices ? … : null`, `:462-463` `if (deviceRows) … blocked.push(\`device_unconfigured:…\`)`
  - (2차 확인) `.catch` 는 같은 `tx` 의 쿼리에 걸려 있다. `readModelCapacityDeviceStates(tx)` 는 받은 tx 로 바로 `reader.execute` 를 하고 savepoint 를 열지 않는다(`lib/llm/capacity-devices-repository.ts:210-235`). `readAssignmentStatus(tx)` 도 같은 tx 에서 `tx.execute` 한다(`lib/operations/pipeline-control-repository.ts:116-119`).
  - 이 스냅숏을 쓰는 곳은 운영 CLI(`scripts/ops/pipeline-control.ts:49·55`)뿐이 아니다. 관리자 ops-runner 의 OPEN/DRAIN 실행(`lib/operations/ops-runner/control.ts:31`)과 관리자 화면의 경로 상태(복제본, `lib/operations/model-route-status.ts:14`)도 쓴다.
- 문제: PostgreSQL 은 TX 안의 한 문장이 실패하면 TX 전체를 abort 한다. JS 에서 오류를 잡아도 그 TX 의 다음 문장은 모두 `25P02 current transaction is aborted` 로 실패한다. 게다가 이 드라이버(postgres.js 3.4.9)는 범위 안의 첫 문장 오류를 기억했다가 콜백 뒤에 다시 던진다(위 반증 까닭).
  - 코드 주석이 상정한 실패(「표를 못 읽으면」 `:105`, 「0155 전 DB 처럼 읽지 못하면」 `:108`)는 표가 없는 경우, 곧 DB 오류(42P01)다. 이 경우가 바로 TX 를 abort 시킨다. 주석이 바란 「devices·assignments 없이 계속」은 어느 경로에서도 일어나지 않는다.
  - 시나리오 ①(dry-run·status·관리자 경로 상태, 읽기 전용 TX) — **1차 서술 반증**: 장비 상태 쿼리가 DB 오류로 실패한다. 그러면 뒤의 `readAssignmentStatus` 도 25P02 로 실패한다(둘 다 JS 에서는 잡힘). 그래도 콜백이 끝난 뒤 postgres.js 가 첫 오류(예: 57014·42P01)를 다시 던져 `readControlSnapshot` 전체가 실패한다. 계획이 「장비 모름」으로 OPEN 가능하게 나오는 일은 없다. 대신 상태·dry-run 이 통째로 실패한다(fail-loud). 관리자 화면은 `readReplicaOrHold` 로 보류를 보인다.
  - 시나리오 ②(실행 TX, `runPipelineControl` `:192-208`): 잠근 스냅숏(`:195`)에서 같은 일이 나면 재계획(`:196`)은 장비 관문 없이 진행한다. 그러나 다음 문장(`beforeApply`·`transition`)이 25P02 로 던져 콜백이 먼저 실패하고, TX 전체가 되돌려진다. **OPEN 은 일어나지 않는다.** 이때 postgres.js 는 콜백의 오류(25P02 를 감싼 `DrizzleQueryError`)를 그대로 던진다(`:272` 은 `PostgresError` 일 때만 원래 오류로 바꾼다). 그래서 운영자는 원인(57014 등) 대신 「aborted transaction」만 본다. 이 원인 가림이 남는 실제 결함이다.
  - 같은 이유로 `lib/operations/admin-models-repository.ts:94` 의 `.catch(() => null)` 도 의도(「한도 미확인」으로 표시)대로 되지 않는다. 장비 읽기가 DB 오류면 그 관리자 관측 TX 전체가 원래 오류로 실패한다(1차의 「해가 없다」 정정).
- 실측 근거: `slow-queries-primary.txt` 오류 집계 `10383 | nomorevibe | canceling statement due to statement timeout`, `17 | … lock timeout`. 이 쿼리가 거기에 들었는지는 확인하지 못했다.
- 수정 방안: 두 읽기를 각각 `tx.transaction(async sp => …)`(drizzle savepoint → postgres.js `savepoint`, 범위마다 오류 기록이 따로다)로 감싼다. 그러면 실패가 savepoint 만 되돌리고 바깥 TX 는 계속된다. 같은 저장소의 `lib/jobs/runner.ts:325` 가 이미 그렇게 쓴다. 쓰기 TX(`runPipelineControl`)에서는 장비 읽기 실패를 「모름」으로 두지 말고 거절(`devices_unreadable`)로 바꾸는 것을 추천한다. 그러면 원인 코드가 계획에 남는다. 「모름」으로 계속하는 것은 dry-run·관리자 표시에서만 쓴다.
- 검증: 통합 테스트(`tests/integration/pipeline-control.test.ts`)에 장비 쿼리를 `SET LOCAL statement_timeout='1ms'` 로 실패시키는 경우를 넣는다. 고치기 전에는 dry-run 이 57014 로 던지는지 확인하고(2차 판단 확인용), 고친 뒤에는 dry-run 이 `assignments` 를 남기는지, 실행이 57014(또는 `devices_unreadable`)로 거절되는지 단언한다.
- 배포 주의: 운영 CLI(`scripts/ops/pipeline-control.ts`)와 ops-runner(`lib/operations/ops-runner/control.ts`)·관리자 웹(`lib/operations/model-route-status.ts`)이 함께 쓰는 코드다. ops 실행 폴더 갱신과 웹 배포가 필요하다. DRAIN 은 필요 없다.
- 확신도: CONFIRMED (2차: savepoint 부재와 같은 tx 를 코드로 확정했다. postgres.js 3.4.9 `begin` 범위가 잡힌 오류도 기억해 다시 던지는 것은 `node_modules/postgres/src/index.js:255-296` 에서 읽었다(실행해 보지는 않음). drizzle 의 `transaction` 이 `client.begin`·`savepoint` 를 그대로 쓰는 것도 확인했다(`node_modules/drizzle-orm/postgres-js/session.js:108-140`). 그 결과 「OPEN 관문이 꺼진다」는 반증되었다. 「원인이 25P02 로 가려진다」와 「주석 의도가 동작하지 않는다」만 남는다.)
- 규모: S

### [부분 반증] STD-04 timestamp without time zone 약 250열이 DB 세션 시간대에 기대고 있는데, 세션 TimeZone 고정이 없다
- 반증 까닭(2차): 1차의 핵심 전제 「postgres.js 가 tz 없는 값을 프로세스 로컬 시간으로 읽는다」는 이 앱에 맞지 않는다. `drizzle(client)` 가 그 파서를 바꿔 끼우고, 형이 있는 칸은 `+0000` 을 붙여 UTC 로 읽는다. 그래서 「컨테이너 TZ 하나가 어긋나면 읽기가 9시간 밀린다」는 대부분 경로에서 성립하지 않는다. 시나리오 ② 는 반증됐다. 남는 의존(DB 세션 TimeZone·날 문자열 파싱)만 P3 로 남긴다.
- 심각도: P3 (2차에서 P2 → P3)
- 분류: non-standard
- 위치:
  - 스키마: `timestamp(` 417개 중 `withTimezone: true` 166개다(`lib/db/*schema*.ts` 에서 `rg -o … | wc -l` 로 셈. `rg -c` 줄 수로는 363줄·163줄). 나머지 약 250개가 tz 없음이다.
  - 드라이버 기본 파서: `node_modules/postgres/src/types.js:28-33`, `date: { to: 1184, from: [1082, 1114, 1184], parse: x => new Date(x) }`.
  - **2차 확인 — 이 앱에서는 그 파서가 쓰이지 않는다.**
    - `lib/db/index.ts:28` `drizzle(client, { schema })` → `node_modules/drizzle-orm/postgres-js/driver.js:16-20` 이 1114·1184·1082 등의 parser·serializer 를 `val => val` 로 바꾼다.
    - 형이 있는 tz 없는 칸은 `node_modules/drizzle-orm/pg-core/columns/timestamp.js:30-31` `new Date(this.withTimezone ? value : value + "+0000")` 로 **UTC 로 읽는다**.
    - 쓰기는 `toISOString()`(`…/timestamp.js:34-35`)이다. PG 는 `timestamp without time zone` 입력의 시간대 표기를 버리므로 세션 시간대와 무관하게 UTC 벽시계 값이 저장된다.
  - 남는 의존 ①(DB 세션 TimeZone): `now()`·`localtimestamp`·`now() + interval` 로 tz 없는 칸에 쓰는 곳은 세션 TimeZone 의 벽시계 값을 저장한다. 예: `role_leases.lease_until = now() + interval '45 seconds'`(`lib/jobs/role-leader.ts:26·85`). 이 값을 JS 가 `+0000` 으로 읽어 `now()`(오프셋이 붙은 문자열)와 비교한다(`lib/jobs/role-leader.ts:57-63`). 세션 TimeZone 이 UTC 가 아니면 lease 판정이 그 오프셋만큼 어긋난다.
    - 연결 설정 `lib/db/pool.ts:72-87` 은 `TimeZone` 을 넣지 않는다. 저장소에는 메인 계정의 `ALTER ROLE … SET timezone` 도 없다. Oracle 소비자 계정만 건다(`lib/runtime/oracle-db-profile.ts:237`). 지금은 서버 기본값(미확인)이 UTC 라서 맞는 것으로 보인다.
  - 남는 의존 ②(프로세스 TZ): 날 `execute` 결과의 tz 없는 문자열을 `new Date(str)` 로 읽는 곳만 해당한다. 예: `lib/operations/capacity-supervisor/snapshot.ts:71`, `lib/operations/capacity-supervisor/repository.ts:43` 의 `iso()`. 이 둘은 Oracle 소비자(유닛이 TZ=UTC 고정)에서 돈다. 표본 3곳(`lib/domain/products/repository.ts:447`, `lib/crawl/second-review-stale.ts:155`, `lib/jobs/role-leader.ts:59`)은 timestamptz·오프셋 있는 문자열이라 해당하지 않았다.
  - 이미지: `Dockerfile`(worker·monitor·runner 모두)과 `compose.yml` 에 `TZ` 가 없다(alpine 기본값이 UTC).
  - Oracle: 소비자 유닛만 고정한다. `deploy/oracle/` 폴더의 `nomorevibe-core-consumer@.service` 21줄 `Environment=TZ=UTC`, `deploy/oracle/launch.py:295` `_require(consumer is None or env.get('TZ') == 'UTC', …)`. `nomorevibe-core-role@.service`·`nomorevibe-core-scheduler.service`·`role.env.example`·`scheduler.env.example` 에는 TZ 가 없다.
  - 우회 흔적(2차 재계산, 테스트 밖 소스 `rg -c`): SQL 의 `AT TIME ZONE 'UTC'` 159줄(대소문자 무시 205줄), `to_char(… "Z")` 150줄. 1차의 178·98 은 재현되지 않았다.
- 문제: tz 없는 칸의 값은 「DB 세션 TimeZone = UTC」일 때만 맞다. 그런데 이것을 코드·계정 어디에서도 고정하지 않는다. 프로세스 TZ 는 날 문자열 파싱 몇 곳에만 영향이 있다.
  - 실패 시나리오 ①(실제로 일어남): KST 노트북에서 운영 DB 를 날 SQL 로 읽고 `new Date()` 하는 스크립트는 잡이 9시간 멈춘 것처럼 본다(메모 prod-timestamp-timezone). drizzle 형 칸으로 읽으면 일어나지 않는다.
  - 실패 시나리오 ②(1차) — **반증**: Oracle role·scheduler 호스트가 Asia/Tokyo 여도 lease 비교(`lib/jobs/role-leader.ts:57-63`)는 형 칸(UTC 고정)과 오프셋이 붙은 `now()` 문자열을 쓴다. 그래서 프로세스 TZ 로는 어긋나지 않는다. due 비교는 SQL 안에서 한다. 어긋나는 것은 세션 TimeZone 이 바뀔 때다(남는 의존 ①).
- 실측 근거: 코드 근거만(운영 호스트 TZ·서버 `timezone` 설정은 보지 않았다. `pg-stats-primary.txt` 설정 목록에 timezone 이 없다).
- 수정 방안(추천 순):
  1. (핵심) 세션 TimeZone 을 고정한다. 연결 옵션 `connection: { TimeZone: 'UTC' }` 를 `postgresClientOptions` 의 direct·pgbouncer 두 갈래 모두에 넣거나, Oracle 소비자처럼 `ALTER ROLE nomorevibe SET timezone='UTC'` 를 건다. PgBouncer 경유라면 계정 설정 쪽이 확실하다.
  2. (보강) `Dockerfile` 의 worker·monitor·runner·emergency-web 단계와 Oracle role/scheduler 유닛에 `ENV TZ=UTC`/`Environment=TZ=UTC` 를 넣는다. 날 문자열을 `new Date()` 로 읽는 곳의 안전판이다. `launch.py:295` 의 `consumer is None or` 를 지우는 것은 선택이다.
  3. 장기적으로는 새 표를 `withTimezone: true` 로 만든다. 운영 표는 `ALTER COLUMN … TYPE timestamptz USING … AT TIME ZONE 'UTC'` 를 별도 창에서 한다(큰 표는 rewrite 비용이 있다).
- 검증: 통합 테스트에서 세션을 `SET TimeZone='Asia/Seoul'` 로 바꿔 `tryAcquireRole` 의 lease 판정이 그대로인지 본다(지금은 어긋날 것으로 예상). 운영은 읽기 전용으로 `SHOW timezone` 과 `pg_db_role_setting` 의 메인 계정 행을 확인한다.
- 배포 주의: ①은 DB 계정 설정 또는 일반 배포, ②는 일반 배포(Oracle 은 release 재설치). ③은 표 rewrite 라 DRAIN 과 별도 창이 필요하다.
- 확신도: CONFIRMED(2차: drizzle 이 파서를 바꾸는 것과 형 칸의 UTC 해석을 코드로 확인 → 1차 전제 반증). 남는 의존 ① 은 코드로 확인했다. 운영 서버의 `timezone` 기본값이 UTC 가 아닌지는 확인하지 못했다(PLAUSIBLE — 지금 피해는 없을 가능성이 높다).
- 규모: S(①②) / L(③)

### [부분 반증] STD-05 모델 이름·엔진 주소 하드코딩과 env 덮개가 관리자 설정을 이긴다 (소유자 규칙 위반)
- 반증 까닭(2차): 우선순위를 코드로 따라가 보았다. 관리자 값을 실제로 이기는 env 는 `MODEL_REGISTRY_CONFIG` 하나다(명시적·재시작 전용·화면 배지로 알림). `EMBEDDING_URL`·`RERANK_URL`·`LOCAL_MODEL_SERVING_CONTRACTS` 는 관리자 행이나 표 행이 **없을 때만** 쓰는 대체값이다. 코드 기본 등록부도 DB 덮개 아래에 깔리는 값이다. 그래서 제목의 「관리자 설정을 이긴다」는 대부분 틀렸다. 이름 기반 분기와 기본값 잔존만 남는다.
- 심각도: P3 (2차에서 P2 → P3. 남는 것은 소유자 규칙상 정리 대상이고, 실측 피해는 없다.)
- 분류: non-standard
- 위치:
  - `lib/llm/model-registry.ts:75-78`
    ```ts
    const m1 = "https://(내부 호스트)/v1";
    const supa = "http://(내부 주소):8000/v1";
    const m3Mlx = "http://(내부 주소):8014/v1";
    const local = "http://(내부 주소):8090/v1";
    ```
    `:86-110` `DEFAULT_MODEL_DEFINITIONS` 10개(2차 재계산. 1차 11개는 틀림 — 모델 이름 `qwen3.8-flash-next`·`deepseek-v4.1-flash-1017`·`gpt-oss-120b`·`grok-4.7`·`gpt-5.3-codex-spark`·`gpt-5.6-terra` 등과 동시 한도·토큰 한도). 주소는 위 4개 상수와 `:89` 의 `http://(내부 주소):8010/v1` 이다. IP URL 4개·호스트 3개·ts.net 1개다. 이 파일의 주석(`:80-84`)은 이것을 「호환 기본값, DB 덮개와 관리자 계약이 우선」이라고 밝힌다.
  - `lib/operations/admin-models-view.ts:50-55`: 호스트 → 장비 이름표를 IP·ts.net 이름으로 하드코딩했다.
  - `lib/llm/ai-task-reasoning.ts:10-16`
    ```ts
    const CLAUDE_EFFORT_MODEL = /^(opus|sonnet)$|^claude-(opus|sonnet)-(4-[6-9]|[5-9])/;
    if (model === "grok-4.7" || model === "grok-4.6") return ["low", "medium", "high", "xhigh"];
    if (model === "grok-4.5") return ["low", "medium", "high"];
    return [];
    ```
  - `lib/crawl/translation-prompts.ts:13-17`: Qwen 전용 출력 계약을 모델 **이름** 정규식 `/^qwen(?:\d|[-_]|$)/i` 로 붙인다. 등록부에는 `family` 칸이 따로 있다(`model-registry.ts:95` Supa 는 `model: "supa", family: "qwen3.8-27b-nvfp4"`).
  - env 와 관리자 값의 우선순위(2차에서 코드로 확인):
    - **env 가 이김**: `lib/operations/runtime-settings-schema.ts:20` 「MODEL_REGISTRY_CONFIG env 는 그대로 이긴다」 — `lib/llm/model-registry.ts:236-237` 이 env 가 있으면 DB 덮개·경로 정책 덮개를 건너뛴다(주석 `:228` 「bypasses both overlays」, `:437` 「restart-only」).
    - **관리자가 이김(env 는 대체값)**: `lib/domain/products/search-model-settings.ts:80` 의 `EMBEDDING_URL`·`RERANK_URL` 은 관리자 행이 0개일 때만 쓴다(`:100`·`:110` `if (own.length === 0) return environment(task)`). `lib/domain/products/search-model-repository.ts:147-151` 도 오류 경로에서 관리자 행이 없을 때만 env 를 보인다.
    - **관리자가 이김**: `lib/llm/local-model-capacity.ts:53` 의 `LOCAL_MODEL_SERVING_CONTRACTS` 는 계약 표 행이 없을 때만 읽는다(`:45-51` 주석·`tableLocalModelContract` 먼저).
    - **의도된 끄기 스위치**: `MODEL_SERVING_CONTRACTS_DB === "0"` 이면 DB 를 끈다(코드 10곳, 2차 재확인). `lib/llm/serving-contract-store.ts:29` 가 kill switch 라고 밝힌다.
  - 소스의 모델 이름 문자열: 2차에서 모델 식별자 정규식(`qwen3|deepseek-v|gpt-oss|grok-4|gemma-?4|claude-(opus|sonnet|haiku)|gpt-5|codex-spark`)으로 테스트 밖 소스를 셌더니 40파일이었다. 1차의 91파일은 정규식이 적혀 있지 않아 재현하지 못했다.
- 문제: 11-02 소유자 결정은 「API 주소나 CLI 로만, 하드코딩·env 금지」였는데 기본값·이름 분기·`MODEL_REGISTRY_CONFIG` 덮개가 남아 있다.
  - 실패 시나리오 ①: 새 Grok(예: `grok-4.8`)이나 `claude-opus-10`·`fable` 계열을 관리자 화면에서 고르면 effort 선택지가 `[]` 로 나와 정할 수 없다(정규식 `:10` 이 끝을 고정하지 않지만 `claude-opus-1…` 은 `[5-9]` 에 걸리지 않는다). 기본 effort 로 돌 뿐 호출이 실패하지는 않는다. (1차의 「사용자가 말한 드롭다운 문제와 같은 종류」는 다른 제품의 대화 창 이야기라 근거에서 뺐다.)
  - 실패 시나리오 ②: 한국어 소개(`product-tagline-ko`) 경로를 Supa(Qwen, 와이어 이름 `supa`)로 옮기면 Qwen 출력 계약 접미사가 붙지 않는다. 그러면 배열 모양 실패가 늘 수 있다(PLAUSIBLE — 와이어 이름이 `supa` 로 오는지 확인 필요).
  - 실패 시나리오 ③: env `MODEL_REGISTRY_CONFIG` 가 남은 역할에서는 관리자 「경로 한도」 저장이 적용되지 않는다(화면이 「env 등록부」 배지로만 알린다, `app/(operator)/admin/settings/SettingsApplyLine.tsx:17`).
  - 덤: 공개 저장소에 tailnet 이름 `tail02799e` 와 엔진 내부 주소가 노출되어 있다.
- 실측 근거: 코드 근거만.
- 수정 방안:
  1. effort 선택지는 모델 이름 대신 연결·CLI 의 실제 카탈로그(이미 OpenCode 는 `catalogVariants`)나 관리자 저장값으로 정한다. 모르는 모델은 `[]` 가 아니라 공급자 기본 집합을 준다.
  2. 프롬프트 선택은 `family`(등록부)나 작업 설정의 「프롬프트 프로필」 칸으로 한다.
  3. `DEFAULT_MODEL_DEFINITIONS` 의 주소·모델은 0개로 줄이고, 시드는 마이그레이션 데이터(관리자 표 행)로 옮긴다. 장비 이름표는 장비 표(`/admin/models/devices`)에서 읽는다.
  4. `MODEL_REGISTRY_CONFIG` 는 읽기 경로를 지운다(관리자 값을 실제로 이기는 유일한 env). `EMBEDDING_URL`·`RERANK_URL`·`LOCAL_MODEL_SERVING_CONTRACTS` 는 대체값이라 급하지 않다. 관리자 행이 모두 채워진 것을 확인한 뒤 지운다. 남아 있는 앱 env 를 정리하는 절차를 둔다.
- 검증:
  - `tests/cli-rank-reasoning.test.tsx`(`aiTaskReasoningEfforts` 시험)에 처음 보는 모델 이름의 경우를 넣는다.
  - `rg '100\.[0-9]+\.[0-9]+\.[0-9]+|ts\.net' lib app` 결과가 0인지 본다(2차 기준 지금 13파일·23줄).
  - 관리자 모델 화면에서 새 모델 추가 → effort 선택 → 저장 흐름을 e2e 로 확인한다.
- 배포 주의: 시드를 옮기는 것은 마이그레이션이다. env 를 지울 때는 「Dokploy env 변경은 plan 전에 재배포까지」 규칙(메모)을 따른다.
- 확신도: 하드코딩·이름 분기는 CONFIRMED. 「env 가 관리자 값을 이긴다」는 2차에서 `MODEL_REGISTRY_CONFIG` 만 CONFIRMED, 나머지 셋은 반증(대체값). 어느 운영 앱에 `MODEL_REGISTRY_CONFIG` 가 남아 있는지는 확인하지 못했다. 시나리오 ②는 PLAUSIBLE.
- 규모: M

### STD-06 PgBouncer 모드에서는 역할별 문장·잠금·idle-in-transaction 시간 제한이 코드 밖 설정 하나로 합쳐진다
- 심각도: P3 (2차에서 P2 → P3. 운영 문서가 정한 의도된 설계이고(runbook 394-399), 실측 피해가 없다. 남는 차이는 웹 15초 → 계정 값뿐이다.)
- 분류: non-standard
- 위치:
  - `lib/db/pool.ts:54-56`: 역할별 기본값(web 15초·scheduler/monitor 10초·maintenance 120초·그 밖 60초, lock 5초)을 계산한다.
  - `lib/db/pool.ts:74-81`: `poolerMode === "pgbouncer"` 면 `{ application_name }` 만 넣고 `statement_timeout`·`lock_timeout`·`idle_in_transaction_session_timeout` 을 버린다.
  - 저장소에는 메인 계정(`nomorevibe`)의 `ALTER ROLE … SET` 이 없다. Oracle 계정만 있다(`deploy/oracle/least-privilege.sql:11…335`).
  - 문서는 「DB 에서 설정한다」고 적었고 값도 정했다: `docs/operations/independent-workers-runbook.md:394-399` 「공통 DB role timeout은 PgBouncer backend에 적용되도록 DB에서 설정한다. 초기값은 statement_timeout=120s, lock_timeout=5s, idle_in_transaction_session_timeout=120s」. 곧 **의도된 운영 설계**다(2차 확인).
  - 코드도 이 한계를 알고 보완한다. 역할 선출·갱신 TX 는 `set_config(…, true)` 로 lock 5초·문장 10초를 건다(`lib/jobs/batch-repository.ts:16-25`, 주석 「pgbouncer transaction 모드는 연결 시작 값으로 timeout 을 넘길 수 없어」). 테스트 밖 소스에서 `SET LOCAL statement_timeout|lock_timeout`·`set_config` 로 거는 곳은 83파일·120줄이다(2차 재계산).
- 문제: 운영 앱은 pgbouncer 모드다(`docs/operations/independent-workers-runbook.md:394`, 메모 prod-script-pgbouncer). 그래서 코드가 보여 주는 역할별 예산(웹 15초)은 실제로 걸리지 않고, DB 계정 하나의 값이 모든 역할에 같이 걸린다.
  - 실패 시나리오: 공개 화면의 느린 읽기가 15초에서 끊기지 않고 계정 값(문서 값이면 120초)까지 웹 연결을 쥔다. 웹 풀이 막히면 다른 요청이 풀 대기에 걸린다. (1차의 「maintenance 120초 정리 쿼리가 계정 값에 잘린다」는 문서 값 120초와 같아 성립하지 않는다 — 2차 반증.)
  - 계정 설정이 실제로 없다면, 서버 기본 `idle_in_transaction_session_timeout=0` 때문에 멈춘 TX 가 잠금을 무기한 쥔다. `lib/jobs/batch-repository.ts:17-18` 의 「선출이 끝없이 기다렸다」는 과거 기록이 그런 상태가 있었음을 암시한다.
- 실측 근거: `pg-stats-primary.txt` settings `idle_in_transaction_session_timeout | 0`·`statement_timeout | 0`. 이 값은 `psql`(postgres 계정) 세션의 값이라 메인 계정의 `rolconfig` 를 보여 주지 않는다. 연결 표에 `nomorevibe:reviewer | idle in transaction | 1`(순간값). 오류 집계 `statement timeout 10383`(어느 값으로 걸렸는지는 모른다).
- 수정 방안:
  1. pgbouncer 모드에서도 TX 를 열 때 `SET LOCAL statement_timeout/lock_timeout` 을 역할 값으로 넣는 drizzle 래퍼를 둔다(83파일이 이미 손으로 하고 있다). 단일 문장은 짧은 `BEGIN; SET LOCAL …; stmt; COMMIT` 비용이 있으니 역할별 DB 계정(`nomorevibe_web`·`nomorevibe_maint`)을 나누고 `ALTER ROLE … SET` 으로 거는 것이 더 낫다(추천).
  2. 시작할 때 `SHOW statement_timeout/lock_timeout/idle_in_transaction_session_timeout` 을 읽어 기대값과 다르면 경고하는 preflight 를 둔다. Oracle 은 이미 `lib/runtime/oracle-preflight.ts:29-31` 에서 한다.
- 검증: 운영에서 읽기 전용으로 `SELECT rolname, rolconfig FROM pg_roles WHERE rolname LIKE 'nomorevibe%'` 를 확인한다. 고친 뒤 웹 컨테이너에서 `SHOW statement_timeout` 이 15s 인지 본다.
- 배포 주의: 계정을 나누는 것은 DB 작업과 Dokploy env(DATABASE_URL) 변경이라 일반 배포와 별도다.
- 확신도: PLAUSIBLE (코드 동작은 CONFIRMED). 2차: 운영 문서가 DB 계정 값(120s/5s/120s)을 정해 두었음을 확인했다. 남는 결함은 웹 15초 예산이 걸리지 않는 것과, 메인 계정 설정을 검사하는 preflight 가 없는 것이다(Oracle 에는 있다). 메인 계정의 `rolconfig` 실값은 여전히 보지 못했다.
- 규모: M

### STD-07 (보강 — #772) 생성한 CHECK SQL 을 TS 소스 문자열로 두고, 마이그레이션마다 다시 쓴다
- 심각도: P3
- 분류: structure
- 위치:
  - `lib/db/operations-schema.ts` 982,709바이트 / 878줄. 한 줄 길이: `:185` 17,796자, `:186` 23,431자, `:187` 235,006자, `:188` 270,469자, `:227` 14,595자, `:230` **338,170자**. 모양은 `sql.raw('(' + ('(' + ('(' + … "((((((((((((((terminal_evidence IS NULL …"`.
  - `lib/llm/*-sql.ts` 생성 파일 합계 약 1.17MB. 최대는 `gateway-local-direct-binding-sql.ts` 470,746바이트(한 줄 185,388자)다.
  - 마이그레이션 `drizzle/*.sql` 13MB 가운데 `0122`(1.06MB)·`0121`(0.99MB)·`0119`·`0125`·`0124`(각 0.87~0.93MB)가 같은 CHECK 를 통째로 다시 만든다.
  - CI: `.github/workflows/ci.yml:107-111`, tsc 가 「cold run peaks at ~4.8 GB RSS and OOMs at 4096」이라 `--max-old-space-size=6144`.
- 문제: CHECK 의 실행 비용은 #772 로 알려져 있다. 여기서는 **소스 모양**이 만드는 비용을 다룬다.
  - 변경 하나가 수십만 자 한 줄의 diff 가 되어 사람이 검토할 수 없다. 리뷰는 생성기 스크립트(`scripts/ops/generate-*-sql.ts` 11개)와 단언 테스트에만 기댄다.
  - `lib/db/schema` 를 import 하는 모든 서버 번들·tsc·IDE 가 1MB 짜리 문자열 연결식을 해석한다.
  - 마이그레이션마다 CHECK 를 다시 써서 이미지·저장소가 커지고, live rebuild 가 표를 다시 검사해(메모 「CHECK 재구성 migrate는 DRAIN 뒤에」) 배포 창을 늘린다.
- 실측 근거: 크기는 실측(`ls -la`, `awk length`). tsc 메모리에 얼마나 기여하는지는 측정하지 않았다(PLAUSIBLE).
- 수정 방안: #772 의 「CHECK → 트리거 함수」 시안(`claude/ledger-check-trigger`)과 함께 간다.
  - 생성 술어는 `drizzle/generated/<name>.sql` 파일로만 두고, 스키마 TS 에는 이름만 선언한다(drizzle `check()` 에서 빼고 마이그레이션만 진실로 둔다).
  - 바뀐 가지는 `CREATE OR REPLACE FUNCTION` 으로 덧붙여, 1MB CHECK 재작성과 표 재검사를 없앤다.
- 검증: `wc -c lib/db/operations-schema.ts` 가 50KB 아래인지 본다. CI typecheck 를 4GB heap 으로 돌려 통과하는지 본다. 기존 `tests/*-schema.test.ts` 단언을 생성 파일 기준으로 옮긴다.
- 배포 주의: 트리거 전환은 장부 표의 DDL 이라 DRAIN 창에서 한다(#772 와 같은 창).
- 확신도: CONFIRMED (크기·모양). tsc 메모리 기여는 PLAUSIBLE. 2차: 인용 줄(`ci.yml:107-111`)과 파일 크기(982,709바이트·878줄)만 다시 확인했다.
- 규모: L

### STD-08 스키마의 기준이 없다 — drizzle snapshot 이 0052 에서 멈췄고 TS 스키마와 DB 가 어긋나 있다
- 심각도: P3
- 분류: non-standard
- 위치:
  - `drizzle/meta/` 의 snapshot 은 `0052_snapshot.json` 까지다. `_journal.json` 항목은 186개(마지막 `0190_multilingual_search_query`).
  - 「오래된 snapshot 을 생성기로 다시 쓰지 않는다」: `docs/operations/2026-10-13-i18n-content-implementation.md:7`
  - TS 스키마(`pgTable`)에 없는데 SQL 로 만든 표 11개: `dr_fence_events dr_process_group_events dr_promotion_evidence dr_promotions dr_writer_fence github_ko_discovery_control github_ko_discovery_queries github_ko_discovery_staging llm_assist_audit_findings llm_assist_audit_periods pipeline_evidence_events`
  - TS 에 없는 SQL 색인 13개(예: `operations_audit_created_idx`, `http_origin_hops_active_idx`, `human_batch_gates_executed_idx`)
  - 표 전체를 비교하는 검사(`getTableConfig` ↔ `information_schema`)는 없다. 있는 것은 장부 CHECK 단언(`tests/*-schema.test.ts`)뿐이다.
- 문제: 마이그레이션 138개를 손으로 쓰면서 TS 스키마가 DB 의 거울이 아니게 되었다.
  - 실패 시나리오: 누가 `drizzle-kit generate`/`push` 를 한 번 돌리면, 0052 snapshot 과의 차이로 위 색인·표를 지우거나 다시 만드는 SQL 이 나온다.
  - raw SQL 로만 쓰는 11개 표는 칸 이름이 틀려도 tsc 가 잡지 못한다(STD 범위의 형 안전 공백).
  - 0155 번호 충돌·해시 충돌 정리(PENDING 「마이그레이션 해시 충돌 정리」) 같은 사고가 기계 검사 없이 사람 기억에 기대고 있다.
- 실측 근거: 코드 근거만(이름 비교는 `rg -U` 로 TS·SQL 을 대조했다. 정규식 비교라 근소한 누락이 있을 수 있다).
- 수정 방안:
  - 통합 테스트 하나(새 파일 `tests/integration/schema-parity.test.ts`)를 둔다. 마이그레이션한 DB 의 `pg_indexes`·`information_schema.columns` 를 TS 스키마(`getTableConfig`)와 비교하고, 허용 목록(의도적인 raw-SQL 표)만 통과시킨다.
  - `drizzle-kit generate` 를 금지한다는 사실을 README 에 적고, package script 를 막는다.
- 검증: 새 테스트가 지금 상태에서 위 24개를 정확히 보고하는지 확인한다.
- 배포 주의: 테스트만이라 해당 없음.
- 확신도: CONFIRMED (snapshot 중단·비교 결과) 2차: snapshot 0052 끝·journal 186개(마지막 0190)·표 4개(TS 에 pgTable 없음)를 표본 확인했다.
- 규모: M

### STD-09 rewrite 원 주소·force-dynamic 화면에 revalidatePath 를 불러도 효과가 없고, 자동 업데이트 숨김은 CDN 에서 지우지 않는다
- 심각도: P3
- 분류: logic
- 위치:
  - `app/(operator)/admin/products/[slug]/actions.ts:23-27`
    ```ts
    function paths(slug: string) {
      revalidatePath(`/admin/products/${slug}`);
      revalidatePath(`/p/${slug}`);
      revalidatePath("/admin/status");
    }
    ```
  - 같은 모양: `app/(operator)/admin/audit/actions.ts:250`, `app/(operator)/admin/products/actions.ts:50`, `app/(operator)/admin/news/actions.ts:33`(`"/"`), `app/(operator)/admin/talk/actions.ts:19`(`"/"`)
  - `proxy.ts:72-74`: 공개 주소 `/p/x` 를 `/ko/p/x` 로 rewrite 한다.
  - `app/(public)/[locale]/(content)/p/[slug]/page.tsx:42`: `dynamic = "force-dynamic"`(서버에 캐시가 없다).
  - `lib/domain/evidence/admin.ts:90-117` `setAutomaticUpdateVisibility`: `productUpdates.visible` 만 바꾸고 `queueDetailPurge` 를 부르지 않는다.
- 문제: 문서 `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidatePath.md:55-57` 은 「rewrites 를 쓰면 **destination** 경로를 넘겨야 한다」고 한다. 공개 화면은 force-dynamic 이라 무효화할 서버 사본도 없다. 그래서 이 5곳은 아무 일도 하지 않는다. 실제 반영은 Cloudflare 지우기(`lib/cdn/detail-purge.ts`)가 맡는다.
  - 대부분은 도메인 함수가 지우기를 이미 적는다(`intro-editor.ts:66`·`intro-requests.ts:142`). 그러나 자동 업데이트 숨김·복원(`changeAutomaticUpdate`)은 지우기가 없다.
  - 실패 시나리오: 관리자가 부적절한 자동 업데이트를 숨겨도 상세 엣지 사본(240초 + SWR 60초)과 원 서버 기억에 그것이 최대 5분 남는다. `next.config.ts` 주석이 약속한 「사람이 고친 제품은 5분을 기다리지 않고 지운다」와 어긋난다.
- 실측 근거: 코드 근거만.
- 수정 방안:
  - `setAutomaticUpdateVisibility` 의 TX 안에서 `queueDetailPurge(tx, slug, DETAIL_EDIT_PURGE)` 를 부른다.
  - 공개 경로 `revalidatePath` 5곳은 지운다. 남겨야 한다면 `revalidatePath('/[locale]/p/[slug]', 'page')` 처럼 실제 라우트 패턴으로 바꾼다.
- 검증: `tests/integration/*evidence-admin*` 에서 숨김 뒤 `cdn_purges` 에 그 slug 행이 생기는지 확인한다.
- 배포 주의: 일반 배포(web).
- 확신도: CONFIRMED 2차: 줄 번호를 23-27 로 고쳤다. Next 문서 `revalidatePath.md:55-57` 의 rewrite 문구를 확인했다.
- 규모: S

### STD-10 오류 분류가 메시지 문자열에 기대고, SQLSTATE 찾기 도우미가 9벌 이상 제각각이다
- 심각도: P3
- 분류: structure
- 위치:
  - 코드 문자열 오류: `new Error("snake_code")` 1,544곳, `/re/.test(…message)` 51곳, `.message === '…'` 40곳(30파일), `.message.startsWith(` 8곳
    - (2차 재계산, 테스트 밖 소스) `new Error("a_b…")` 1,513회(1,508줄·361파일), `.test(…message` 42줄, `.message ===`·`!==` 42줄(33파일), `.message.startsWith(` 8줄. 정규식에 따라 조금씩 다르다. 규모는 같다.
  - cause 사슬에서 SQLSTATE 를 찾는 구현:
    - 1단만: `lib/operations/admin-capacity-retire.ts:31-32`, `lib/operations/admin-ai-tasks-repository.ts:82-86`, `lib/operations/admin-ai-task-execution.ts:65-67`
    - 재귀·5단: `lib/domain/products/repository.ts:1013-1020` `uniqueViolation`, `lib/net/origin-permits.ts:18-20` `lockBusy`, `lib/db/error-fields.ts:14-21` `errorChain`
    - 각자: `lib/llm/capacity-lock-diagnostics.ts:7`, `lib/crawl/review-backlog.ts:67`, `lib/crawl/source-buffer.ts:33`, `lib/crawl/discovery-admission.ts:42`, `lib/crawl/audit-policy.ts:712`, `scripts/role-worker.ts:61`
- 문제: drizzle 은 드라이버 오류를 `DrizzleQueryError` 로 한 번 감싼다. 1단 구현은 지금은 맞지만, 감싸는 층이 하나 더 생기면(중첩 savepoint, STD-03 수정, 드라이버 업그레이드) 조용히 「알 수 없는 실패」로 떨어진다. 같은 판정(잠금 바쁨 = 55P03/57014/`DB_POOL_WAIT_TIMEOUT`)이 파일마다 다르게 적혀 있다(어떤 곳은 57014 를 포함하고 어떤 곳은 뺀다).
  - 메시지 문자열 분류는 오타·접두어 바꾸기 하나로 분기를 깨뜨리고, tsc 가 잡지 못한다.
- 실측 근거: 코드 근거만.
- 수정 방안: `lib/db/error-fields.ts` 에 `sqlState(error): string | null` 과 `isLockBusy(error)`·`isUniqueViolation(error, constraint?)` 를 모으고 위 구현을 그것으로 바꾼다. 앱 오류는 `class CodedError extends Error { code: Code }` 하나와 코드 유니온 형으로 옮겨 `error.code === …` 비교를 tsc 가 검사하게 한다(점진적으로, 새 코드부터).
- 검증: rg 로 `code === "55P03"` 직접 비교가 `error-fields.ts` 밖에서 0인지 본다. 기존 단위 테스트를 그대로 통과하는지 본다.
- 배포 주의: 일반 배포.
- 확신도: CONFIRMED (중복·불일치). 지금 깨지는 경로는 찾지 못했다. 2차: 인용 줄을 확인했고 개수를 다시 셌다(위 「2차 재계산」 줄).
- 규모: M

### STD-11 abcLLM 게이트웨이(10-30 제거) 잔재 — 445회·98파일, 기본 provider 가 아직 "abcllm" 이다
- 심각도: P3
- 분류: structure
- 위치:
  - `lib/crawl/agent-review-gateway.ts:601·779·871·980·1074·1168·1257·1358`(8곳): `provider = options.provider ?? "abcllm"`. `:758` 주석 「주지 않으면 예전처럼 abcllm 이다」.
  - `lib/crawl/agent-review-gateway.ts:849`: 파일 한가운데에 `import { ABCLLM_STRICT_TERMINAL_HEADER, … } from …` 이 있다.
  - `lib/llm/model-registry.ts:92·94·97`: 직접 엔진(m1·supa·mlx)을 `provider: "abcllm"` 으로 적었다. `:69-70` 는 「abcllm|local-direct|llama-server 는 baseUrl 필수」.
  - `ABCLLM_STRICT_TERMINAL_OPT_IN` 을 serving-contract 4파일이 가져다 쓴다(`lib/llm/*-serving-contract.ts:3·21`).
  - `rg -i -o abcllm`: 445회 / 98파일(2차 재계산. `rg -c` 줄 수로는 354줄). 상위는 `agent-review-gateway.ts` 31, `admin-ai-tasks.ts` 12, `capacity-repository.ts` 11.
- 문제: 사라진 게이트웨이 이름이 「OpenAI 호환 직접 연결」의 뜻으로 재사용되고 있다. 그래서 provider 를 빠뜨린 호출이 게이트웨이 wire(`gatewayWire`·엄격 terminal 헤더) 쪽으로 간다. 읽는 사람은 어느 갈래가 살아 있는지 매번 추적해야 한다. 메모 「abcllm-removal-status」에 남은 일로 적힌 상태 그대로다.
- 실측 근거: 코드 근거만.
- 수정 방안: provider 형을 `"openai-compatible" | "local-direct" | …` 로 이름을 바꾼다(DB 의 계약 행 값은 마이그레이션으로 옮기거나 읽을 때 별칭으로 둔다). `?? "abcllm"` 기본값은 없애 호출자가 반드시 provider 를 주게 한다. 게이트웨이 전용 함수(strict terminal 헤더 등)는 쓰는 곳이 0이 되면 지운다.
- 검증: `rg -i abcllm lib app` 이 마이그레이션 별칭 한 곳으로 줄었는지 본다. 장부 통합 테스트(`tests/integration/*capacity*`)를 통과하는지 본다.
- 배포 주의: provider 값이 장부 CHECK 술어에 들어 있다(`provider IN ('abcllm', …)`). 그러면 CHECK 재구성 DRAIN 이 필요하므로 STD-07(트리거 전환)과 같은 창에서 한다.
- 확신도: CONFIRMED 2차: `?? "abcllm"` 8곳과 개수(445회·98파일)를 다시 확인했다.
- 규모: M

### STD-12 포매터가 없어 압축 문체 파일과 거대 파일이 늘었다
- 심각도: P3
- 분류: structure
- 위치:
  - 포매터 설정(`.prettierrc`·`biome.json`·`.editorconfig`)과 CI 형식 검사가 없다.
  - 압축(minified) 문체 7파일: `lib/domain/products/thumbnails/{repository,resolver,presentation}.ts`, `lib/jobs/products/thumbnail-refresh.ts`, `lib/crawl/product-purpose-cleanup.ts`, `scripts/backfill-thumbnails.ts`, `scripts/cleanup-non-products.ts`(평균 줄 585자). 예: `import{and,eq,inArray,sql}from'drizzle-orm';import{db}from'@/lib/db';…`
  - 평균 줄 길이 150자 초과 19파일(생성 SQL 제외 시 `app/(operator)/admin/products/PrototypeProductWorkspaces.tsx` 207자, `lib/db/http-origin-schema.ts` 209자·최대 3,259자 등). 1,000자 넘는 줄이 있는 파일 22개.
  - 80KB 넘는 손글씨 모듈 12개: `lib/llm/capacity-repository.ts` 283KB/3,392줄, `lib/crawl/agent-review-repository.ts` 122KB, `lib/crawl/second-review.ts` 118KB, `lib/crawl/agent-review-gateway.ts` 115KB, `lib/operations/admin-ai-tasks.ts` 101KB, `lib/llm/capacity.ts` 99KB.
- 문제: 장부·심사처럼 동시성 결함이 몰리는 핵심 모듈이 한 파일 수천 줄·한 줄 수백 자라서 diff 리뷰가 어렵다. 같은 줄을 여러 PR 이 고칠 때 충돌도 커진다(병렬 에이전트 개발에서 실제로 비용이 된다). 압축 파일은 `git blame` 이 줄 단위로 의미를 갖지 못한다.
- 실측 근거: 크기·줄 길이 실측(`awk`).
- 수정 방안: Biome(또는 Prettier)를 도입해 `--write` 를 **새·수정 파일에만** 적용하는 CI 검사부터 시작한다. 전체 재포맷은 열린 PR 이 적은 날 한 번에 하고, `.git-blame-ignore-revs` 에 등록한다. `capacity-repository.ts` 는 구조 제안 ③대로 나눈다.
- 검증: CI 에 `biome check --changed` 단계를 넣는다. 위 7파일이 일반 문체로 바뀌었는지 본다.
- 배포 주의: 해당 없음(코드 동작 불변).
- 확신도: CONFIRMED 2차: 인용만 확인했다(크기 재측정 안 함).
- 규모: M

### STD-13 워커 이미지: 운영에서 tsx 로 TS 를 실행하고, 쓰지 않는 next 를 싣고, Grok CLI 를 무검증으로 설치한다
- 심각도: P3
- 분류: inefficiency
- 위치:
  - `Dockerfile:68`·`:75`·`:91` `CMD ["node", "--import", "tsx", …]`. `package.json:44` 에서 `tsx` 가 런타임 의존성이다.
  - `Dockerfile:65-66` `HEALTHCHECK --interval=15s … CMD node --import tsx scripts/worker-healthcheck.ts`: 워커 컨테이너마다 15초에 한 번 node+tsx 프로세스를 띄운다.
  - `Dockerfile:11` `npm ci --omit=dev` → `:57`·`:83` worker·monitor 단계로 복사한다. `next`(210MB)·`@next/*`(98MB)·`react-dom` 이 그대로 들어간다(워커 코드의 `next/*` import 는 웹 전용 12파일).
  - `Dockerfile:54-56` `curl -fsSL https://x.ai/cli/install.sh -o /tmp/grok-install.sh && … bash /tmp/grok-install.sh "${GROK_CLI_VERSION}"`: 설치 스크립트·바이너리의 해시 검사가 없다(Codex 는 `scripts/install-codex-native-entrypoint.mjs:20-22` 로 해시를 고정한다).
- 문제:
  - 매 기동마다 esbuild 변환을 하므로 배포·크래시 재시작이 느려진다(tsx 캐시는 컨테이너 /tmp 에만 있어 새 컨테이너마다 처음부터 한다). 워커·감독·healthcheck 의 메모리도 커진다.
  - 이미지에 쓰지 않는 300MB 가 매 lockfile 변경마다 두 호스트로 다시 받힌다.
  - Grok 설치는 DB 접속 정보와 공급자 토큰을 쥐는 이미지에 원격 스크립트를 무검증으로 실행한다. 공급망 표준(해시 고정)에서 벗어난다.
- 실측 근거: 크기만 실측(`du -sh node_modules/next node_modules/@next`). 기동 시간·CPU 는 재지 않았다(PLAUSIBLE).
- 수정 방안:
  1. `scripts/build-cli-host.mjs` 처럼 esbuild 로 `worker-supervisor`·`role-worker`·소비자·healthcheck 를 미리 묶고(`dist/*.mjs`), CMD 를 `node dist/…mjs` 로 바꾼다. tsx 는 devDependency 로 내린다.
  2. 워커용 `npm ci --omit=dev` 를 워커 전용 의존 목록(또는 번들이 끝나면 node_modules 없이)으로 줄인다.
  3. Grok 은 고정 버전 바이너리 URL 과 sha256 을 ARG 로 두고 검증한다.
- 검증: 이미지 크기(`docker image ls`)를 비교한다. 역할 워커 첫 `role.acquired` 로그까지의 시간을 배포 전후로 비교한다. healthcheck 한 번의 CPU 시간을 본다.
- 배포 주의: 모든 워커 앱의 CMD 가 바뀐다. 공통 worker digest 라 scheduler 를 먼저 배포하는 규칙(메모 「New jobs → scheduler first」)을 따른다. Oracle native release 의 launcher 경로도 함께 바꾼다.
- 확신도: CONFIRMED (구성). 효과 크기는 PLAUSIBLE. 2차: `Dockerfile` 줄 번호·`package.json:44`·`du -sh`(next 210M·@next 98M)를 다시 확인했다.
- 규모: M

### STD-14 CI·테스트: 실행마다 npm ci 12번, 묵은 샤드 기록, 순서에 기대는 직렬 테스트
- 심각도: P3
- 분류: inefficiency
- 위치:
  - `.github/workflows/ci.yml:98·132·172·188·229·264`(+ refresh-caches `:351`): typecheck·lint·unit×2·build·integration×6·ledger 가 각자 `npm ci` 를 한다(전체 실행당 12번). `setup-node cache: npm` 은 `~/.npm` 만 캐시하고 `node_modules`(next 210MB 포함)는 매번 푼다.
  - `tests/integration/durations.json`: 마지막 갱신 2026-10-22(`23da0867`). 병렬 샤드 대상 415파일 중 **126파일이 기록에 없어** 중앙값으로 배정된다(`scripts/integration-shards.mjs:80-81`).
  - 순서 의존: `scripts/integration-shards.mjs --serial` 21파일. 「각 파일은 끝날 때 행 기준 상태를 복원하고, 뒤 파일은 그 기준 위에서 돈다 — 순서를 바꾸거나 다른 파일과 섞지 않는다」(`ci.yml:266-267`). README 의 로컬 절차는 `|| break` 로 첫 실패에서 멈춘다.
  - 실시간 대기: 단위·통합 테스트의 `setTimeout(r, ≥100)`·`sleep(≥100)` 52곳(34파일), `pg_sleep(` 11곳(6파일). `useFakeTimers` 를 쓰는 파일은 68개다.
- 문제: npm ci 반복은 실행당 몇 분의 runner 시간을 쓴다. 기록 없는 126파일이 중앙값으로 배정되어 6개 샤드의 끝나는 시각이 벌어지고, 가장 늦은 샤드가 `check` 를 늦춘다. 직렬 파일 하나가 기준 상태를 복원하지 못하면 뒤 파일들이 연쇄로 실패해, 원인 파일을 찾기 어렵다.
- 실측 근거: 코드·기록 파일 근거만(Actions 실행 시간은 받지 않았다).
- 수정 방안:
  - `node_modules` 를 `hashFiles('package-lock.json')` 키로 `actions/cache` 하고, 맞으면 `npm ci` 를 건너뛴다.
  - durations 갱신(`node scripts/integration-durations.mjs --run <id>`)을 main push 마다 artifact 로 자동 커밋하는 대신, 샤드 계획이 `DurationReporter` 산출물을 직전 main 실행에서 내려받아 쓰게 한다.
  - 직렬 21파일은 파일마다 `CREATE DATABASE … TEMPLATE` 로 깨끗한 DB 를 만들어 순서 의존을 끊는다(구조 제안 ⑤).
- 검증: CI 실행 요약에서 job 별 시간과 샤드별 `~Ns recorded` 편차를 비교한다.
- 배포 주의: CI 만. `check` 이름과 필수 규칙은 유지한다.
- 확신도: CONFIRMED (구성·기록). 시간 영향은 PLAUSIBLE. 2차: `npm ci` 12번(1+1+2+1+6+1, `ci.yml` 98·132·172·188·229·264)과 직렬 21파일을 다시 확인했다.
- 규모: S

### STD-15 문서·설정 예시 드리프트
- 심각도: P3
- 분류: non-standard
- 위치:
  - `README.md:139-140·182`: 직렬 ledger 파일을 「열아홉 파일」, 바로 다음 줄과 182줄은 「열여덟 파일」이라 적었다. 실제는 21파일(`node scripts/integration-shards.mjs --serial`).
  - `.env.example`: 코드가 `process.env.X` 로 직접 읽는 이름 126개 중 73개가 없다. CI 전용을 빼도 운영 변수 약 40개가 빠졌다: `READ_DATABASE_URL`, `VALKEY_URL`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `PUBLIC_API_SESSION_SECRET`, `TRUST_CF_CONNECTING_IP`, `MODEL_SERVING_CONTRACTS_DB`, `EMBEDDING_URL`, `RERANK_URL`, `LOG_LEVEL` 등. `process.env` 는 532회·231파일(2차 재계산 `rg -o`. 1차 521회·224파일)에 흩어져 있고, 한곳에서 검사하는 스키마가 없다.
  - `PENDING.md:99`: 「## 최신 상태 — 2026-10-27」(한 달 전). 위쪽 항목 다수가 「운영 미적용」이라 지금 배포 상태와 맞는지 이 문서만으로는 알 수 없다.
  - `AGENTS.md`: 「현재 파이프라인 PR의 검증 정책 (JR 지정, 2026-10-16)」. 「수동 전체 unit·전체 DB·종합 테스트은 남은 모든 PR 개발이 끝난 뒤 통합 단계에서」라는 내용인데, 파이프라인 개편은 10-17 이후 운영에 반영되었다(메모 pipeline-overhaul). 에이전트가 이 문구를 근거로 회귀 검사를 계속 미룰 수 있다.
- 문제: 새 환경(Oracle 증설, 비상 웹)을 세우는 사람이 `.env.example` 만 보고 Turnstile·세션 비밀·복제본 주소를 빠뜨린다. 에이전트는 AGENTS.md·PENDING.md 의 지난 상태를 현재로 읽는다.
- 실측 근거: 코드·문서 근거만.
- 수정 방안:
  - 새 파일 `lib/config/env.ts`(zod)에 운영 변수를 모으고, 그 스키마에서 `.env.example` 을 생성·검사하는 단위 테스트를 둔다.
  - README 의 숫자는 스크립트 출력으로 바꾼다(「`--serial` 이 출력하는 파일」).
  - AGENTS.md 의 10-16 정책은 소유자에게 유효 여부를 확인해 날짜 범위를 적거나 지운다.
  - PENDING.md 의 「최신 상태」 머리는 날짜만 남긴다.
- 검증: 새 파일 `tests/env-example.test.ts` 로 확인한다.
- 배포 주의: 해당 없음.
- 확신도: CONFIRMED (불일치 자체). AGENTS.md 정책의 유효 여부는 소유자 확인이 필요하다. 2차: README 「열아홉/열여덟」 문구와 직렬 21파일, `PENDING.md:99` 를 다시 확인했다. `.env.example` 의 126/73 은 다시 세지 않았다.
- 규모: S

### STD-16 형 검사·lint 의 빈칸 — floating promise 규칙 없음, 런타임과 다른 @types/node
- 심각도: P3
- 분류: non-standard
- 위치:
  - `eslint.config.mjs:1-21`: `eslint-config-next/core-web-vitals`·`typescript` 만 쓴다. 형 정보 기반 규칙(`@typescript-eslint/no-floating-promises`·`no-misused-promises`)이 없다.
  - `package.json`: `"@types/node": "^20"`(설치 20.19.43)인데 런타임은 Node 24(`Dockerfile` `node:24.22.1-alpine`, CI `node-version: 24`).
  - 참고(양호): `tsconfig.json` `strict: true`. `any` 2곳, `@ts-ignore/expect-error` 0곳, `eslint-disable` 12곳(5곳은 `no-img-element`). 다만 `as unknown as` 67곳(42파일), 형 매개변수로 DB 행 모양을 단언하는 `execute<…>` 504곳, non-null `!` 996곳이 있다.
- 문제: 코드베이스는 `void p`·`.catch(() => {})`(276곳. 2차 재계산으로는 `.catch(() => {})` 107줄·`void x` 237줄 — 정규식에 따라 다르다)로 의도적인 fire-and-forget 를 많이 쓴다. 규칙이 없어서 의도하지 않은 빠진 `await` 을 기계가 구분하지 못한다(이번 점검에서 구체적인 누락은 찾지 못했다). Node 22~24 API 를 쓰거나 바뀐 형을 tsc 가 알지 못한다.
- 실측 근거: 코드 근거만.
- 수정 방안: `@typescript-eslint/no-floating-promises`(`ignoreVoid: true`)를 경고로 먼저 켜고 수를 센 뒤 오류로 올린다. typed lint 의 CI 비용은 typecheck 잡과 합쳐 감당한다. `@types/node` 를 `^24` 로 올린다.
- 검증: lint 잡에서 새 경고 수를 기록한다. `tsc --noEmit` 통과를 본다.
- 배포 주의: 해당 없음.
- 확신도: CONFIRMED (설정). 결함 수는 측정하지 않았다. 2차: `@types/node` `^20`(설치 20.19.43)과 `as unknown as` 67줄·42파일, `execute<` 504줄을 다시 확인했다.
- 규모: S

## 구조 변경 제안 (리팩토링으로 효율화)

① **오류·로그 표준 한 벌** (STD-01·02·10)
- 지금 구조: 문자열 코드 오류 1,544곳, SQLSTATE 찾기 9벌, 로거는 Error.message 를 그대로 쓰고, 진입점은 오류를 버린다.
- 바꿀 구조: 새 파일 `lib/errors.ts`(`CodedError`, `sqlState()`, `isLockBusy()`, `isUniqueViolation()`)와 `logger` 의 Error 직렬화를 `dbErrorFields` 규칙으로 통일한다. 진입점은 `reportFatal()` 하나를 쓴다.
- 얻는 것: 개인정보·SQL 이 로그에 새는 경로 0. 500 로그와 크래시 로그 모두에 SQLSTATE 가 남아, 교착·시간 초과·잠금 바쁨을 로그 grep 한 번으로 셀 수 있다.
- 옮기는 순서: 로거 → 진입점 13곳 → 도우미 9벌 교체 → 새 코드부터 CodedError.
- 위험: 운영 grep 스크립트의 문자열 의존. 출력 키를 바꾸지 말고 추가만 한다.

② **설정의 단일 입구** (STD-05·06·15)
- 지금 구조: `process.env` 532회·231파일, 모델 주소·이름 기본값이 코드에 있고, env 하나(`MODEL_REGISTRY_CONFIG`)가 관리자 값을 이긴다(STD-05 2차).
- 바꿀 구조:
  - 새 파일 `lib/config/env.ts`(zod, 기동 때 한 번 검증, 비밀 표시)는 인프라 값만 다룬다. DB·Valkey·비밀·기능 스위치.
  - 모델·엔진 주소·한도는 DB(관리자 표)만 진실로 둔다. 시드는 마이그레이션 데이터로 넣는다.
  - DB 계정을 역할별로 나누고(`ALTER ROLE … SET statement_timeout/lock_timeout/idle_in_transaction/timezone`), 기동 preflight 가 `SHOW` 로 확인한다.
- 얻는 것: 「저장했는데 안 먹는다」 부류(env 등록부·`MODEL_SERVING_CONTRACTS_DB=0`)가 사라진다. 새 모델은 코드 배포 없이 고를 수 있다. 웹 15초 문장 예산이 실제로 걸린다.
- 옮기는 순서: env 스키마(읽기만) → `.env.example` 생성 테스트 → 모델 기본값 제거(시드 마이그레이션) → env 덮개 읽기 제거 → DB 계정 분리.
- 위험: env 를 지우는 순서. 메모 「Dokploy env 변경은 plan 전에 재배포까지」를 따른다.

③ **장부 모듈 분할 + 생성 SQL 분리** (STD-07·11·12)
- 지금 구조: `capacity-repository.ts` 283KB 한 파일, CHECK 술어가 TS 문자열 1MB.
- 바꿀 구조: `lib/llm/capacity/{reserve,dispatch,settle,reclaim,read}.ts` 로 나누고, 생성 술어는 `drizzle/generated/*.sql` 과 트리거 함수(#772 시안)로 옮긴다. provider 이름은 `openai-compatible` 로 정리한다.
- 얻는 것: 소스 약 2MB 감소, tsc 메모리 하락(6GB heap 재측정 필요), 장부 변경 PR 의 diff 가 사람이 읽을 크기가 된다. CHECK 재구성 DRAIN 이 사라지면 배포 창 하나당 수십 분을 줄인다(메모 10-31 창 #3).
- 옮기는 순서: 파일 분할(동작 불변) → 생성 파일 분리 → 트리거 전환(DRAIN 창 한 번) → provider 이름 바꾸기.
- 위험: 트리거 전환은 장부 무결성의 핵심이다. 기존 CHECK 단언 테스트를 트리거 기준으로 1:1 옮긴 뒤에 바꾼다.

④ **워커 번들 이미지** (STD-13)
- 지금 구조: 운영에서 `node --import tsx` 로 TS 를 실행하고, 이미지에 next 를 포함한다.
- 바꿀 구조: esbuild 로 진입점별 번들(`cli-host:bundle` 방식 재사용)을 만든다. worker 이미지에는 번들과 꼭 필요한 native 의존(sharp 등)만 둔다.
- 얻는 것: 이미지 약 300MB 이상 감소, 컨테이너 기동·healthcheck CPU 감소(추정, 측정 필요).
- 옮기는 순서: healthcheck 번들 → monitor → 역할 워커 → 소비자 → Oracle launcher.
- 위험: 동적 `import()`·`__dirname` 의존 모듈. 번들 뒤 `tests/cli-protocol-cold-import.test.ts` 류의 콜드 import 검사를 모든 진입점에 둔다.

⑤ **통합 테스트 DB 템플릿 병렬화** (STD-14)
- 지금 구조: 묶음 안 파일 직렬(`fileParallelism: false`) + 순서 의존 직렬 21파일.
- 바꿀 구조: globalSetup 이 한 번 migrate 한 DB 를 TEMPLATE 으로 두고, vitest worker 마다(또는 직렬 파일마다) `CREATE DATABASE … TEMPLATE` 로 복제한다.
- 얻는 것: 기록 합계 1,546초를 6샤드 직렬에서 runner 당 병렬로 돌려 샤드 수를 줄이거나 시간을 줄일 수 있다(추정 30~50%). 순서 의존이 사라진다.
- 옮기는 순서: 직렬 21파일부터 → 나머지.
- 위험: `CREATE DATABASE` 비용(작은 DB 라 수백 ms). 전역 객체(`role`, 확장)를 쓰는 테스트는 따로 둔다.

## 확인했지만 문제 아님

- TypeScript 기본 위생: `tsconfig.json` `strict: true`, `any` 2곳, `@ts-ignore` 0곳. 원시 SQL 의 `count(*)`/`sum()` 을 `number` 로 받는 곳은 모두 `::int` 캐스트를 했다(스캔 결과 0건).
- Next 16 비동기 요청 API: `params`·`cookies()` 를 동기로 접근하면 tsc 가 잡는다(typecheck 잡이 `next typegen` 뒤에 돈다). `dynamic='force-dynamic'`·`fetchCache` 는 Cache Components 를 끈 「Previous Model」에서 유효하다(`…/02-route-segment-config/index.md:25`).
- `proxy.ts` 는 Next 16 이름(`proxy` export)을 쓰고(`…/03-file-conventions/proxy.md`, 업그레이드 문서 「middleware to proxy」), 관리자 기본 차단을 먼저 한다.
- `router.prefetch(path, { kind: "full" })` 는 설치본 `PrefetchKind` enum(`router-reducer-types.d.ts:125-128`)과 맞는다. `experimental.staleTimes` 는 문서상 아직 experimental 이고(`staleTimes.md:4`), 의도와 주석이 맞다.
- `after()` 를 응답 뒤 기록(검색·번역 예열)에만 쓴다. 맞는 용도다.
- 공개 화면의 클라이언트 컴포넌트는 `app/(public)` 에 3파일뿐이고, 번들 크기 관문(`scripts/bundle-size.mjs`, 허용 10%)이 있다.
- API 오류 본문은 `{ error }` 로 거의 통일되어 있다(78/79). 도메인 → HTTP 매핑은 `lib/http/respond.ts` 한 곳이고, 500 응답 본문에 내부 정보가 없다(`lib/http/handler.ts:66-69`).
- 관리자 화면의 `revalidatePath('/admin/…')` 136회는 server action 이 현재 화면을 다시 그리게 하는 데 필요하다(STD-09 는 공개 경로 5곳만).
- 공개 화면 과다 호출 차단이 proxy 에서 주 DB upsert(`lib/http/crawl-burst.ts:59-87`)를 한다. 엣지 MISS 만 오고 설정은 30초 캐시이며, 느린 문장 근거에 `rate_limits` 가 없다. 주석이 설명한 의도적 절충이라 결함으로 싣지 않았다.
- 2026-11-08 메모의 `cli-host` 순환 import(TDZ) 빌드 실패는 `9737712d`(11-11)에서 고쳤고, 콜드 import 테스트(`tests/cli-protocol-cold-import.test.ts`)가 있다.
- 워커 healthcheck 가 import 하는 `lib/jobs/catalog.ts` 는 import 가 0개라 가볍다(비용은 tsx 기동뿐, STD-13).
- Codex CLI 설치는 런처 sha256 을 고정한다. Oracle 소비자는 TZ=UTC 를 강제한다(STD-04 의 공백은 role/scheduler).
- CI 의 tsc·ESLint·Turbopack 캐시, PR 이미지 승격, 같은 트리 검사 재사용은 잘 짜여 있다(중복 typecheck 를 `SKIP_NEXT_TYPECHECK` 로 피한 것도 의도대로다).
- `lib/vendor/deppy-aibox`(8KB, LICENSE 포함)는 실제로 쓰인다(`lib/operations/agent.ts`). `prototypes/`(112KB, 9파일)는 lint 에서 빠져 있고, TS 파일이 없어 tsc 범위에도 들지 않는다.

## 범위 밖·못 본 것

- 규칙상 tsc·빌드·테스트를 돌리지 않았다. 그래서 tsc 메모리에서 `operations-schema.ts` 가 차지하는 몫, 워커 기동 시간, healthcheck CPU 는 측정하지 않았다(STD-07·13 의 효과 수치는 추정이다).
- 운영 DB 의 `pg_roles.rolconfig`(STD-06), 운영 호스트(특히 Oracle role/scheduler)의 TZ(STD-04), Dokploy 앱별 env(`MODEL_REGISTRY_CONFIG`·`DB_POOLER_MODE` 실제 값)는 보지 않았다.
- `web-timing.txt` 에서 `/` 가 연달아 두 번 `cf-cache: MISS` 인 것(엣지 보관이 효과적인지)은 latency/CDN 구역에 넘긴다.
- 쓰이지 않는 export 를 낱말 색인으로 어림했다. lib export 9,133개 중 어디에서도(자기 파일 포함) 참조하지 않는 이름이 123개, 테스트만 참조하는 이름이 864개다. 하나씩 확인하지 않아 발견으로 싣지 않았다.
- Python 운영 도구(42파일·13,823줄, `scripts/ops/deploy_*.py` 등)는 구조만 보았고, 타입 검사·lint 도구가 CI 에 없다는 것만 확인했다. 내용은 검토하지 않았다.
- `scripts/ops/release-29877f65/`·`release-65f8c399/` 같은 일회성 릴리스 도구는 tsc 범위에 남아 있지만 크기가 작아(수백 줄) 싣지 않았다.
- 느린 쿼리·seq scan 의 쿼리별 원인 추적은 DB/latency 구역 몫이라 다루지 않았다.

## 검증 기록 (2차)

검증자가 2026-11-21 에 같은 코드(`34b5fe32`)를 읽기 전용으로 다시 보았다. 테스트·빌드는 돌리지 않았다. 숫자는 테스트 밖 소스(`app lib components scripts proxy.ts instrumentation*.ts`)를 `rg -c`(줄)·`rg -o`(횟수)로 다시 셌다.

#### 고친 인용 (16곳)

| 전 | 후 | 까닭 |
|---|---|---|
| deploy/oracle 폴더의 `nomorevibe-core-consumer@.service:21` | 폴더와 파일 이름을 나눠 적음 | 경로는 맞다. 확장자 `.service` 가 7자라 검사기 정규식이 잘라 읽는다 |
| tests 폴더의 `ai-task-reasoning.test.ts`(없음) | `tests/cli-rank-reasoning.test.tsx` | 없는 파일. `aiTaskReasoningEfforts` 시험이 있는 파일로 고침 |
| (새 파일 제안) `tests/integration/schema-parity.test.ts`·(새 파일 제안) `tests/env-example.test.ts`·(새 파일 제안) `lib/config/env.ts`(2곳)·(새 파일 제안) `lib/errors.ts` | 앞에 「새 파일」 | 만들자는 제안 경로 |
| `app/(operator)/admin/products/[slug]/actions.ts:22-26` | `:23-27` | 함수가 한 줄 아래에 있다 |
| `error-fields.ts:34` | `lib/db/error-fields.ts:32-34` | 경로를 줄여 썼고, 2026-10-29 주석은 33줄이다 |
| `tests/logger*.test.ts`·`tests/http-handler*.test.ts`·`tests/role-worker*.test.ts` | `tests/logger.test.ts`·`tests/handler.test.ts`·`tests/role-worker.test.ts` | 실제 파일 이름 |
| `node_modules/postgres/src/types.js:28-32` | `:28-33` | 블록 끝 |
| `search-model-repository.ts:151` | `lib/domain/products/search-model-repository.ts:147-151` | 경로 생략·분기 시작 줄 |
| `docs/operations/independent-workers-runbook.md:396` | `:394-399` | 정한 값(120s/5s/120s)까지 포함 |
| (1차 인용 없음) `jobs.last_error` 저장 | `lib/jobs/runner.ts:353-356` | 새로 확인한 근거 줄 |

#### 다시 센 숫자 (전 → 후)

| 항목 | 1차 | 2차 |
|---|---:|---:|
| STD-01 원시 오류를 로거에 넘기는 호출 | 약 40 | 43(그중 2곳은 문자열 `result.error`) |
| STD-01 `withRoute` 라우트 | 38 | 파일 39·호출 48 |
| STD-02 오류를 버리는 진입점 | 13 | 13(같은 모양의 보조 진입점 3곳 더) |
| STD-04 `timestamp(` / `withTimezone: true` | 417 / 166 | 같음(`rg -o`. `rg -c` 줄로는 363 / 163) |
| STD-04 `AT TIME ZONE 'UTC'` | 178 | 159줄(대소문자 무시 205줄) |
| STD-04 `to_char(… "Z")` | 98 | 150줄 |
| STD-05 `DEFAULT_MODEL_DEFINITIONS` | 11 | **10** |
| STD-05 모델 이름이 든 소스 파일 | 91 | 40(정규식을 적어 둠. 1차 정규식은 재현 불가) |
| STD-05 `MODEL_SERVING_CONTRACTS_DB === "0"` | 10 | 10 |
| STD-06 손으로 timeout 을 거는 곳 | 83곳 | 83파일·120줄 |
| STD-10 `new Error("snake_code")` | 1,544 | 1,513회 |
| STD-10 `.test(…message)` / `.message ===` | 51 / 40(30파일) | 42줄 / 42줄(33파일, `!==` 포함) |
| STD-11 `abcllm` | 444회·97파일 | 445회·98파일 |
| STD-15 `process.env` | 521회·224파일 | 532회·231파일 |
| STD-16 `void`·`.catch(() => {})` | 276 | `.catch(() => {})` 107줄·`void x` 237줄 |
| 맞음 그대로 | | `npm ci` 12번, 직렬 21파일, `as unknown as` 67줄·42파일, `execute<` 504줄, `?? "abcllm"` 8곳 |

#### 반증·심각도 변경

- **STD-03 [부분 반증] P2 → P3**: savepoint 없는 `.catch` 는 확정이다. 그러나 postgres.js 3.4.9 `begin` 범위가 잡힌 문장 오류도 기억해 콜백 뒤에 다시 던진다(`node_modules/postgres/src/index.js:265-272·291-292`). 그래서 「뒤 읽기가 조용히 비고 OPEN 관문이 꺼진다」는 dry-run·실행 어느 쪽에서도 일어나지 않는다. dry-run 은 원래 오류로 실패한다. 실행은 25P02 로 실패해 OPEN 이 되돌려지고, 원인은 가려진다. 장비 쿼리가 실패한 실측도 없다. 같은 이유로 1차가 「해가 없다」고 본 `lib/operations/admin-models-repository.ts:94` 도 TX 전체 실패가 된다.
- **STD-04 [부분 반증] P2 → P3**: drizzle 이 postgres.js 의 날짜 파서를 `val => val` 로 바꾸고(`node_modules/drizzle-orm/postgres-js/driver.js:16-20`), 형 칸은 `+0000` 으로 UTC 로 읽는다. 그래서 「프로세스 TZ 가 어긋나면 읽기가 9시간 밀린다」와 시나리오 ②(Oracle 호스트 TZ)는 반증됐다. 남는 것은 DB 세션 TimeZone 미고정과 날 문자열 파싱 몇 곳이다.
- **STD-05 [부분 반증] P2 → P3**: 관리자 값을 실제로 이기는 env 는 `MODEL_REGISTRY_CONFIG` 하나다. `EMBEDDING_URL`·`RERANK_URL`·`LOCAL_MODEL_SERVING_CONTRACTS` 는 관리자 행·표 행이 없을 때의 대체값이다. 기본 모델은 11개가 아니라 10개다.
- **STD-06 P2 → P3**: 운영 문서가 PgBouncer 경유의 공통 계정 값(120s/5s/120s)을 의도된 설계로 정했다. 「maintenance 120초 쿼리가 잘린다」는 그 값과 같아 반증됐다. 남는 것은 웹 15초 예산 미적용과 메인 계정 preflight 부재다.
- STD-01·STD-02 는 P2 유지. STD-01 은 오히려 넓어졌다: stack 첫 줄들, `job.failed` 로그, `jobs.last_error`, 등록 INSERT 의 검증 토큰 원문.

#### 끝내 확인하지 못한 것

- 운영 로그 실물에 SQL·params 가 실제로 찍혔는지(STD-01), 크래시 루프 중 로그(STD-02).
- 운영 DB 서버의 `timezone` 기본값과 메인 계정 `pg_db_role_setting`·`rolconfig`(STD-04·06), Oracle role/scheduler 호스트의 TZ.
- 어느 운영 앱에 `MODEL_REGISTRY_CONFIG` 가 남아 있는지(STD-05).
- statement timeout 10,383건이 어느 문장인지 — 근거 파일의 오류 집계에 문장이 없다(STD-03·06).
- 1차의 「모델 이름 91파일」 정규식, `.env.example` 의 126/73 개수, `operations-schema.ts` 가 tsc 메모리에서 차지하는 몫(STD-07).
