# 2026-11-01 배포 창 #4

운영은 [nomorevibe.com](https://nomorevibe.com)이다. Dokploy 18앱(M3 Ultra·mini)이 공통 worker 이미지와 web 이미지를 쓴다.
배포 도구는 `scripts/ops/deploy_release.py`의 plan/run이고, 모델 접수는 capacity 장부(`model_capacity_*`)다.
시각은 UTC다. 분이 확정되지 않은 시각은 실측 기록의 `06:1xZ`처럼 그대로 둔다.

## 목적

- main `61dc57be`(PR #765 #766 #767 #768 #769 #770 #771 #773 #774 #775 #776 #777)를 18앱에 배포한다.
- migration 0158(`release_branch_kinds`: 회수 가지에 `publication_classify_cli`·`local_model_direct`)과 0160(`ledger_check_rules`: 거대 CHECK 6개를 규칙 표와 BEFORE 트리거로)을 적용한다.
- publisher 고아 dispatched 행 `1b70ed46`를 정식 회수한다. 이 행은 창 #3 12:51Z에 0155/0157을 OPEN 중 적용하면서 생겼고, `group_exited`는 13:01:55Z다.
- abcLLM env 5종(`ABCLLM_API_KEY`·`ABCLLM_SERVING_CONTRACTS`·`ABCLLM_TAGLINE_MODEL`·`PRODUCT_TRANSLATION_MODEL`·`CRAWL_REVIEW_MODEL`)을 16앱(monitor-m3·scheduler-mini 제외)에서 릴리스에 싸서 제거한다(#776 `plan --retire-setting`).

## 사전 점검

읽기 전용으로 확인했다.

- `model_serving_contracts`의 enabled 9행은 전부 transport direct다. text 7경로와 AI1 `crawl-agent-review`의 qwen3.8-flash-next·supa다.
- `crawl_settings.values.firstReview`는 `qwen3.8-flash-next/abcllm`으로 저장돼 있어 #767 배포 조건을 충족한다.
- main CI `61dc57be`는 success다. 운영 run 트리는 `61dc57be`이고 변경은 없다.

## 타임라인

- 06:1xZ에 DRAIN으로 바꿨다(OPEN→DRAINING, rev 12). 5분 뒤 진행 중 행 1건은 고아 `1b70ed46`만 남았다. 예상한 결과다.
- 06:3xZ에 migrate 0158·0160을 적용했다(applied 158→160). `model_capacity_check_rules` 6행(dispatch 가지에 `publication_classify_cli` 포함), `*_zz_check_guard` 트리거 2개, 길이 5000자를 넘는 CHECK 0개를 확인했다.
- 06:5xZ `promotion.ts process-reclaim --instance=m3-publisher --boot=36431c63… --client-bound=codex-cli`를 dry-run한 뒤 apply했다. `1b70ed46`는 released다. 진행 중 행은 0/0/0이다.
- 06:36Z plan이 `web-mini_env_drift_redeploy_required`로 거절됐다. web-m3·web-mini의 `GA_PROPERTY_URL` 저장값(79자)이 라이브 spec(43자)과 달랐다. 값의 43번째 문자가 `#`다. Dokploy(dotenv)는 따옴표 없는 값의 `#` 뒤를 주석으로 잘라 넣고, 배포 도구 `shared.dotenv_settings`는 전체를 읽는다. 06:42Z web-m3를 같은 릴리스로 다시 배포해도 spec은 43자 그대로였다.
- 09:0xZ에 저장 env의 `GA_PROPERTY_URL` 줄에 큰따옴표만 씌웠다. 값은 바꾸지 않았고 readback으로 확인했다. web-m3 같은 릴리스 재배포(09:07Z) 뒤 spec이 79자로 맞았다. 09:19Z web-mini도 같았다.
- 09:22Z와 09:25Z plan이 다시 거절됐다. monitor 관문이 120초 timeout이고 `progress=alarm`이었다. worker progress의 `upstream_stalled` 4단계는 crawler/agent-evidence=`agent-evidence-refresh`, text/reason-translate, text/keywords=`product-search-profile`, text/product-translate다. 3시간 DRAINING으로 대기열만 쌓인 탓이다.
- 09:3xZ에 잡 4개(`reason-translate`·`product-search-profile`·`product-translate`·`agent-evidence-refresh`)를 일시중지했다. 관리 화면 job-pause와 같은 함수다. monitor progress가 ok가 된 뒤 09:37Z plan이 planned였다(18앱, retiredSettings 5, 앱별 savedEnv/liveSpec 이름 기록). 09:39Z run, 09:46:35Z `deployed-and-verified`(existingGuard readiness ready·progress ok).
- 6시간 관측 예약은 `ObserverError`(`schedule-failed`)다. 이 호스트 run 트리의 도구 파일이 group-writable(0664)이라 `release_observer` `_source_hashes`의 `st_mode & 0o022` 검사에 걸렸다. 0664가 된 원인은 그 뒤에 확인했다.

## 결과

09:46Z fleet 실측에서 18앱이 모두 `61dc57be`·done이고, abcllm env 이름은 TOTAL 0이다. 09:46:38Z OPEN(routes 50, non-serving 0, `61dc57be` 코드로 판정) 뒤 capacity가 open이다. 09:46:55Z에 잡 4개를 재개했다.

09:47Z 이후 OPEN 2분 안에 22건이 정산됐다. 11:50Z 기준 시간당 661건이 정산됐다. monitor progress와 failover는 ok이고 stuckDispatched는 0이다. #775 효과로 product-search-profile의 묵은 `last_error`(`[55P03]`)가 비워졌다.

## 교훈

1. CHECK를 다시 짜는 migration(0155·0157·0158·0160)은 DRAIN 아래에서만 적용한다. OPEN 중 적용은 고아 행을 만든다(창 #3). [단축 배포의 모델 접수](deployment-fast-path.md#모델-호출을-보유하는-앱-교체).
2. Dokploy env 값에 `#`가 있으면 큰따옴표로 감싼다. 같은 릴리스 재배포만으로는 드리프트가 풀리지 않는다. [단축 배포의 env 드리프트](deployment-fast-path.md#dokploy-env-를-바꿨으면-plan-전에-spec-을-맞춘다).
3. 긴 DRAINING은 monitor progress 경보(`upstream_stalled`)를 만들어 plan 관문을 막는다. 해당 잡을 일시중지하고 OPEN 뒤에 재개한다. [단축 배포의 모델 접수](deployment-fast-path.md#모델-호출을-보유하는-앱-교체).
4. 멈춘 제공자로 가는 경로는 OPEN 전에 일시중지하거나 다른 계약 행으로 바꾼다. [단축 배포의 모델 접수](deployment-fast-path.md#모델-호출을-보유하는-앱-교체).
5. run 트리 도구 파일은 0644여야 관측 예약이 된다(umask 002 체크아웃을 주의한다). [단축 배포의 비동기 관측](deployment-fast-path.md#실패·원복-자료와-비동기-관측).

## 남은 것

- run 영수증의 observation은 `schedule-failed`다. 장기 관측은 예약되지 않았다.
- Supa가 다운인 채로 crawl-tagline/supa와 product-search-verify/supa가 `gateway_not_started`로 헛돌았고, 미확인 2건이 11:04Z에 생겼다. OPEN 전에 멈춘 제공자 경로를 일시중지하지 않은 누락이다.

## 관련 PR

배포된 main `61dc57be`에 포함된 PR(10-31 밤 ~ 11-01 새벽 머지).

- [#765](https://github.com/JRVector9/nomorevibe/pull/765) 배포 도구: plan 에서 Dokploy env 드리프트 사전검사
- [#766](https://github.com/JRVector9/nomorevibe/pull/766) 0158 release_branch_kinds — 회수 가지에 publication_classify_cli·local_model_direct
- [#767](https://github.com/JRVector9/nomorevibe/pull/767) abcLLM env 5종 읽기 제거, `textRouteAccess` 로 text 경로 관문 통일
- [#768](https://github.com/JRVector9/nomorevibe/pull/768) 관리자 단계별 모델: 카드 묶음 → 표, 「장비 미확인」 주소·groupId 보정
- [#769](https://github.com/JRVector9/nomorevibe/pull/769) 배포 도구: monitor 검증 5분, 넘으면 사람 판별(`deployed-human-review-required`)
- [#770](https://github.com/JRVector9/nomorevibe/pull/770) 관리자 모델 화면 묵은 문구 정리
- [#771](https://github.com/JRVector9/nomorevibe/pull/771) 배정 표 읽기 runtime 토글(`assignments.tableReads`, 3b-E 1부)
- [#773](https://github.com/JRVector9/nomorevibe/pull/773) 장부 control 행 경합 — 읽기 전용 readback 네 곳 잠금 제거
- [#774](https://github.com/JRVector9/nomorevibe/pull/774) 관리자 모델 한 페이지 리디자인
- [#775](https://github.com/JRVector9/nomorevibe/pull/775) runner: 던지지 않고 끝난 미룸 틱은 lastError 를 비움
- [#776](https://github.com/JRVector9/nomorevibe/pull/776) 배포 도구 `plan --retire-setting`
- [#777](https://github.com/JRVector9/nomorevibe/pull/777) 0160 ledger_check_rules — 거대 CHECK 여섯 개를 규칙 표 + 트리거로(쓰기 66ms → 6.5ms)
