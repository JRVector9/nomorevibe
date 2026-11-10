# 변경 범위에 맞춘 일반 배포

2026-10-25 단축 보고서를 적용한 기본 진입점은 `npm run deploy -- <scope|plan|run>`이다.
필수 PR `check`는 유지한다. 이 도구를 main에 반영하는 것과 운영 앱을 새로 배포하는 것은 별개다.
문서·로컬 도구 갱신만으로 이미 목표 상태인 운영 앱을 다시 배포하지 않는다.

화면 전용·관리자 전용 변경의 실제 범위, GitHub API 한도 대응과 다음 배포의 준비 순서는
[2026-11-06 배포 단축 경로](2026-11-06-deployment-fast-routes.md)를 함께 따른다.
현재 실행 가능한 절차와 추가 코드 구현이 필요한 단축안을 구분하며, 필수 CI·출처·상태 검증은 유지한다.

## 세 단계 실행

main의 정확한 SHA를 checkout한 깨끗한 운영자 Mac에서 실행한다. Python 표준 라이브러리,
Git·GitHub CLI 로그인, 기존 Keychain의 Dokploy 키와 두 호스트 SSH 접근이 필요하다.
웹 이미지 패키지의 비공개 설정과 기존 registry 자격 증명을 유지한다.

gpu3090에서는 `prod` 스킬의 기존 Keychain 호환 도구를 PATH에 추가한다.
등록 키를 제공하는 xAegis worker에서는 키 파일이나 Keychain 설정을 만들지 않고
`xa-key exec DOKPLOY_API_KEY=gpu3090/dokploy -- npm run deploy -- plan ...`처럼 실행한다.
`run`과 별도 관측도 같은 등록 키 환경에서 실행한다. 도구는 `DOKPLOY_API_KEY`가 있으면
메모리에서 읽고, 없으면 기존 Keychain 조회를 유지한다. 빈 값·공백·제어문자가 있는 명시적
키는 다른 인증으로 조용히 대체하지 않고 거절한다. 키를 명령 인자·로그·영수증에 저장하지 않는다.
이 인증 경로도 동일한 SSH·출처·drain·한 번 실행 관문을 거친다.

현재 등록된 M3/mini SSH 계정이 `jr`이면 `NMV_DEPLOY_SSH_USER=jr`을 plan/run 및
후속 관측에 동일하게 지정한다. 기본 계정은 기존 `root`이며 호스트·SSH 옵션·접속
권한은 변경하지 않는다. 배포 전 두 호스트에서 해당 계정의 Docker 접근을 확인한다.
이미지 준비의 Docker 로그인은 0700 임시 디렉터리 안 0600 설정 파일만 사용하고
종료 시 제거한다. macOS SSH 세션의 Keychain 자동 선택·저장에 의존하지 않으며
기존 Dokploy registry 자격 정보나 OS Keychain을 변경하지 않는다.

```bash
# 1. 로컬 미리 보기. BASE/SHA는 검토한 40자리 커밋이다. 자격 증명·운영 호출 없음.
npm run deploy -- scope --base "$BASE" --sha "$SHA"

# 2. 실제 앱별 baseline, 출처·health·관문과 main CI/이미지를 확인한다.
# OUT은 저장소 밖의 새 절대 경로. 부모 디렉터리는 먼저 준비한다.
mkdir -p "$HOME/.local/state/nomorevibe-releases"
npm run deploy -- plan --sha "$SHA" \
  --out "$HOME/.local/state/nomorevibe-releases/RELEASE-UNIQUE"

# 3. plan이 출력한 정확한 plan 경로와 planSha256를 사용한다.
npm run deploy -- run --plan "$PLAN" --plan-sha "$PLAN_SHA256"
```

`scope`는 두 커밋의 로컬 예상이며 실제 배포 대상의 최종 근거는 `plan`이다.
각 앱의 실제 기존 release부터 비교하므로 앞선 일부 배포로 버전이 섞여 있어도 처리한다.
문서만 바뀌면 `scope`로 대상0임을 확인하고 끝낸다. `plan`은 실제 혼합 baseline 확인이
필요하므로 이전 private snapshot이 없으면 운영을 읽는다. 이미 받은 snapshot을 재사용할 때는
`--baseline /절대경로/final.private.json --baseline-sha <64자리SHA256>`를 함께 준다.
대상이 있으면 이전 snapshot도 실제 전체 앱을 다시 읽어 검증한다.

`.claude/prod.sh scope|plan|run`도 같은 진입점이며 `prod.sh deploy`는 검증된 `run`의 별칭이다.
기존 개별 API 요청은 복구용 `legacy-deploy`로 명시해야 한다.

### Dokploy env 를 바꿨으면 plan 전에 spec 을 맞춘다

Dokploy 앱 env(예: `DB_POOL_MAX`)를 저장만 하고 재배포하지 않으면 Swarm 서비스 spec 은 옛 env 로 돈다.
`plan`은 선택된 앱마다(Git 빌드·Docker 앱 모두) 저장된 env 와 라이브 서비스 spec env 를
`RELEASE_TAG`·`NEXT_DEPLOYMENT_ID` 만 빼고 이름 집합·값까지 비교해, 하나라도 다르면 자격 증명·이미지 준비 전에
`<app>_env_drift_redeploy_required` 로 즉시 멈춘다. 그러므로 env 를 바꿨으면 **plan 전에 그 앱을 같은 릴리스로
재배포해 spec 을 맞추거나, 릴리스가 끝난 뒤 env 절차로 바꾼다.** 설정을 **지우는** 것이면 Dokploy 를 먼저 고치지 말고
plan 에 `--retire-setting NAME` 을 준다(아래 절). 어긴 채 진행하면 2026-10-31 처럼 text-mini 가
정상 배포돼도 계약 검증이 480초 뒤 `_verification_timeout` 으로 서고 같은 묶음의 동료 앱만 새 판이 되어 fleet 이 섞인다.
달라진 변수 **이름**(값 없음)은 `~/.local/state/nomorevibe-releases/plan-failures/<utc>-<pid>.safe.json` 에 남고,
최상위 출력의 `reason` 은 멈춤 코드가 공백·URL·따옴표 없는 코드 문자열이면 그대로 보이며(`failureRecord` 에 기록 경로),
그 밖의 메시지는 지금처럼 `inspect-private-receipts` 로 숨긴다. plan 이 private 디렉터리를 만들기 전에 실패해도
이 기록은 남는다(코드·시각·단계·변수 이름만, 비밀값 없음).

값에 `#`가 있으면 큰따옴표로 감싼다. 따옴표 없는 `#`는 Dokploy가 주석으로 잘라 라이브 spec만 짧아지고, 같은 릴리스 재배포로는 드리프트가 풀리지 않는다([2026-11-01 창 #4](2026-11-01-deploy-window-4.md#교훈)).

준비 단계에서는 서비스를 변경하지 않고 필요한 이미지 cache를 두 호스트에 받는다.
main의 최신 trusted CI 실행에서 필수 `check`와 필요한 image publish가 성공하고
`release-image-{worker|web}-<SHA>` artifact의 run/attempt/tree/profile/version/digest가 일치해야 한다.
전체 workflow나 `refresh-caches` 종료를 기다리지 않는다. 준비가 아직 안 됐으면 배포 요청 없이 멈춘다.
실행 직전에도 main·CI·대상 범위·전체 원 상태를 다시 확인한다.

### 설정 폐기는 릴리스에 싸서: `--retire-setting`

abcLLM 게이트웨이 은퇴 뒤 아래 열 이름은 코드가 더 읽지 않는다:
`ABCLLM_API_KEY`·`ABCLLM_SERVING_CONTRACTS`·`ABCLLM_TAGLINE_MODEL`·`ABCLLM_BASE_URL`·`ABCLLM_MODEL`·`ABCLLM_MODEL_KEY`·
`ABCLLM_PROFILE_MODEL`·`ABCLLM_PROFILE_MODEL_KEY`·`PRODUCT_TRANSLATION_MODEL`·`CRAWL_REVIEW_MODEL`. 이 설정들은 Dokploy 에서 먼저 지우지 않는다 — 지우면 위 drift 로
plan 이 멈추고 앱마다 같은 릴리스 재배포가 하나씩 더 든다. 대신 plan 에 이름을 준다(이름마다 한 번, `^[A-Z][A-Z0-9_]*$`).

```bash
npm run deploy -- plan --sha "$SHA" --out "$OUT" \
  --retire-setting ABCLLM_API_KEY --retire-setting ABCLLM_SERVING_CONTRACTS \
  --retire-setting ABCLLM_TAGLINE_MODEL --retire-setting ABCLLM_BASE_URL \
  --retire-setting ABCLLM_MODEL --retire-setting ABCLLM_MODEL_KEY \
  --retire-setting ABCLLM_PROFILE_MODEL --retire-setting ABCLLM_PROFILE_MODEL_KEY \
  --retire-setting PRODUCT_TRANSLATION_MODEL --retire-setting CRAWL_REVIEW_MODEL
npm run deploy -- run --plan "$PLAN" --plan-sha "$PLAN_SHA256"   # run 에는 옵션이 없다 — plan 에 적힌 이름을 따른다
```

- `plan`: 코드 변경 범위에 **그 이름을 아직 가진 앱**(저장 env 또는 라이브 spec)과 그 역할 짝·소비자를 더해 선택한다.
  이미 목표 릴리스·이미지인 앱도 이름을 갖고 있으면 유지 대상이 아니라 재배포 대상이다. 출력과 `plan.private.json` 의
  `retiredSettings`(정렬한 이름)·`retiredSettingsFound`(선택 앱별로 `savedEnv`·`liveSpec` 에 남은 이름)와
  `scope.retiredSettingCarriers`(이름을 가진 앱)는 **이름만** 담는다. 값은 어디에도 적지 않는다.
  `RELEASE_TAG`·`NEXT_DEPLOYMENT_ID` 와 도구가 읽는 설정(`WORKER_ROLE`·`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`·`DATABASE_URL`·
  GitHub 연동 사전 점검이 읽는 이름들)은 `retire_setting_protected:<NAME>` 으로, 형식이 틀린 이름은 `retire_setting_name_invalid` 로
  자격 증명·baseline 읽기 전에 거절한다(틀린 이름은 되비추지 않는다). 저장 env 와 라이브 spec 의 drift 검사는 그대로다 —
  폐기할 이름도 plan 전에는 둘 다에 있어야 한다.
- `run`: 재배포하는 앱마다 `application.saveEnvironment` 에 그 줄을 뺀 env 를 쓴다(Git 빌드·Docker 앱 같음, 그 밖의 바이트는 그대로,
  여러 줄 따옴표 값도 통째로). 배포 뒤 계약 검증(`runtime_contract_matches`)은 `RELEASE_TAG`·`NEXT_DEPLOYMENT_ID` 갱신 외에
  **그 이름의 줄이 새 spec 에 없는 것만** 추가로 허용한다. 다른 줄이 빠지거나 값이 바뀌거나 폐기한 줄이 아직 보이면 전처럼 불일치다.
  마지막 fleet 검증은 재배포한 앱의 저장 env·서비스 spec·컨테이너 env 모두에서 이름이 사라졌는지 보고, 유지 앱은 전처럼
  원 상태(이름 포함)와 같아야 한다. `once.json`·`result.safe.json` 에 `retiredSettings` 가 남는다.
- 이름을 주지 않으면 plan·run 은 이전과 같게 동작한다.

## 줄이는 단계와 유지하는 증명

| 변경 | 앱 갱신 |
|---|---|
| docs·README·검토된 로컬 운영 도구만 |0개|
| CSS·확인된 웹 문구 namespace·수동 웹 asset |웹2개|
| 독립 scheduler/connect/monitor entrypoint |해당 등록 앱|
| 공통 lib·DB·catalog·Dockerfile·workflow·이미지 승격·미분류 |전체18개|

관리자 전용 PR도 임의 `app/(operator)/admin/**/*.tsx`·공유 `lib/**` 변경이면 현재는 전체 18개다.
관리자 경로라는 이유로 웹 2개만 지정하지 않는다. CSS 등 위 허용 목록만의 변경은 웹 짝을 선택한다.

분류는 허용 목록이다. 다른 history·객체 부재·rename의 이전 경로·미분류는 전체로 복귀한다.
`lib/jobs/registry.ts`가 handler들을 함께 import하므로 파일 이름만 보고 역할을 좁히지 않는다.
역할을 선택하면 mini/M3와 등록된 소비자까지 묶고, 이미 목표 상태인 앱은 실제 배포에서 건너뛴다.
최종 검사는 실제 배포 앱의 새 deployment ID·새 release/image/source와 유지 앱의 원 상태를 모두 확인한다.

text·maintenance·scheduler 여섯 앱은 해당 앱 배포에서 공통 worker immutable digest를 사용한다.
명령·health·볼륨·registry 설정·`autoDeploy=false`와 scheduler의 M3 2복제본·mini 1복제본을 보존한다.
connect는 Git stage를 유지하며 `NMV_SOURCE_SHA` build arg/OCI revision 및 Docker COPY 파일의
SHA256 manifest를 검증한다. 릴리스 환경변수만으로 출처를 인정하지 않는다.

첫 묶음은 mini(text+maintenance), 둘째는 M3(text+maintenance)다.
mini scheduler를 먼저 검증한 뒤 M3 scheduler+connect를 갱신한다.
각 묶음 최대2개이며 같은 역할은 예비 완료 뒤 주를 갱신한다. 이후 crawler/reviewer/publisher의
기존 역할 병렬 경로, 소비자, mini→M3 웹, 마지막 monitor 중 **선택한 앱만** 실행한다.
실패하면 시작한 동료 결과는 수집하고 다음 묶음을 중단한다. 자동 배포 재요청은 없다.

DB·schema·마이그레이션 변경이 있으면 일반 배포가 이전을 대신하지 않는다. 별도 승인된 이전을
완료한 뒤 `plan --migration-verified`로 주장하고 실제 운영 journal count/latest/hash 읽기 검증도 통과해야 한다.
새 catalog 잡이 있으면 scheduler 배포와 DB 등록 확인을 먼저 끝내는 기존 규칙을 유지한다.
native unknown 회수, 모델 종료, capacity 변경과 생산자 재등록은 별도 복구 절차이며 일반 도구는 실행하지 않는다.

### 모델 호출을 보유하는 앱 교체

reviewer·publisher·text·maintenance·AI 소비자와 웹을 실제 교체할 때는 먼저 기존
`pipeline-control capacity mode`의 비교 후 적용 경로로 모델 접수를 DRAINING으로 전환한다.
유효한 reserved와 dispatched가 모두 0이 된 뒤 `run`을 실행한다.
2026-10-30 상태 계약대로 indeterminate는 점유하지 않는 사람 검토 기록이며 이 0건 조건에서 제외한다.
기한이 지난 미전송 예약도 유효 예약에 포함하지 않으며, 장부 행을 임의로 삭제하거나 정산하지 않는다.
대기 중인 waiting 행과 검수 결과는 보존한다. 배포 도구는 첫 변경과 각 교체 묶음 직전에
주 DB를 읽어 이 조건을 재확인하며, 접수가 다시 열렸거나 유효 예약·전송 중 호출이 남으면 중단한다.
DB 조회 실패도 교체 허가가 아니다. 기존 모델 요청을 SIGTERM으로 끊은 뒤 슬롯이 자동으로
풀릴 것으로 가정하지 않는다. 2026-10-28 배포의 번역 정체는 이 경계에서 재현됐다.
미확정 검토 닫기는 기존 관리자 검토 절차이며 모델 서버의 실제 종료를 증명하거나 강제 취소하는 동작이 아니다.
모델 서버의 실제 종료·취소나 원격 회수는 그에 맞는 근거를 갖춘 별도 절차로 처리한다.
앱 교체·기본 건강 확인 후 같은 공식 제어 경로로 접수를 OPEN으로 원복한다.
도구가 자동으로 용량을 바꾸거나 공유 모델을 강제 종료하지 않는다.
CHECK를 다시 짜는 migration(0155·0157·0158·0160)은 이 DRAIN 아래에서만 적용한다. OPEN 중 적용은 고아 dispatched 행을 만든다([2026-11-01 창 #4](2026-11-01-deploy-window-4.md#교훈)).
긴 DRAIN 뒤 `upstream_stalled` 잡은 일시중지한다. 대기만 쌓이면 worker progress가 경보가 되어 plan 관문(120초, `progress=alarm`)이 막히고, OPEN 뒤에 그 잡을 재개한다([2026-11-01 창 #4](2026-11-01-deploy-window-4.md#교훈)).
멈춘 제공자로 가는 경로는 OPEN 전에 일시중지하거나 다른 계약 행으로 바꾼다([2026-11-01 창 #4](2026-11-01-deploy-window-4.md#교훈)).

## 실패·원복 자료와 비동기 관측

**plan 이 `inspect-private-receipts` 로 약 2분 뒤 멈추면** 먼저 다섯 역할 관문(monitor_gate)을 의심한다. `role_leases` 의
`quarantine_until` 이 미래면 그 역할은 `primary_quarantined`(5분 안 3회 새 부팅 → 15분 격리)다. 격리는 지우지 않고
풀릴 때까지 기다린 뒤 다시 plan 한다. 2026-11-01 은 앱 밖의 `pg_terminate_backend` 일괄 종료가 원인이었다 —
[운영 DB 연결을 직접 끊지 않는다](independent-workers-runbook.md#운영-db-연결을-직접-끊지-않는다2026-11-01-격리-사고).

**새 표를 monitor 가 읽게 되면** monitor 읽기 역할(`nomorevibe_monitor_20261022`)에 SELECT 를 따로 준다. 이 역할은
저장소 밖에서 만든 운영 역할이라 마이그레이션이 GRANT 하지 않는다. 빠지면 Postgres 로그에 `permission denied for table …`
가 probe 마다 남고 monitor 보고에서 그 부분이 빈다(0153 장비 표 두 개가 2026-11-01 까지 빠져 있었다).

계획·전체 API 설정·실제 runtime·원 release/image/spec·단계별 영수증은 저장소 밖 0700 디렉터리,
0600 파일에 둔다. Git 앱의 이전 로컬 image도 첫 서비스 변경 전에 rollback 태그로 보존한다.
파일에는 인증 정보가 있으므로 커밋하거나 응답 원문을 로그에 붙이지 않는다.

`execution/once.json`이 생긴 디렉터리는 다시 실행할 수 없다. 응답이 불명확하면
`*.attempted.json`, `*.completed.json`, `*.verified.json`, `stopped.safe.json`과 실제 API/runtime을
대조해 완료 여부를 확인한다. marker 삭제·자동 재개·자동 되돌림으로 새 모델 작업을 반복하지 않는다.
실패 원문은 `failure.private.json`에서 로컬로만 확인한다.
필요한 원복은 `plan.private.json`의 원 설정·원 image와 기존 runbook의 원복 경계를 사용해 별도 검토한다.

실제 배포·전체 health·보호 관문이 끝나면 `result.safe.json`에 `deployed-and-verified`를 먼저 기록한다.
그다음 detached 관측 드라이버를 시작하고 시작 영수증과 살아 있는 PID를 확인한다.
5·10·15분·6시간에 읽기 전용 전체 상태/진행 관문을 확인한다. 시각별 실제 결과만 완료 증거이며
예약 응답의 `futurePassed:false`는 관측 통과가 아니다.
관측 예약 실패는 `observation.safe.json`의 `schedule-failed`로 남긴다. 이 경우 완료된 앱을 재배포하지 말고
원 final snapshot과 hash로 관측만 별도로 시작한다.
run 트리 도구 파일은 0644여야 한다. group-writable(0664, umask 002 체크아웃)이면 `release_observer` `_source_hashes`의 `st_mode & 0o022`에 걸려 예약이 `schedule-failed`로 남는다([2026-11-01 창 #4](2026-11-01-deploy-window-4.md#교훈)).

`run` 트리의 `scripts/ops` 도구 파일은 현재 사용자 소유의 정규 파일이어야 하고 그룹·기타 쓰기 비트(`0o022`)가 없어야 한다.
권장 모드는 소유자 `0644`다. `umask 002`로 체크아웃하면 `0664`(group-writable)가 되므로 `chmod -R g-w scripts/ops`로 맞춘다.
`plan`이 `observer_source_group_writable`·`observer_source_not_owned`·`observer_source_missing`·`observer_source_not_regular`
(`observer_source_*`)로 멈추면 그 검사다. 자격 증명·이미지 준비 전에 멈추고, plan-failures 기록의 detail에는 저장소 상대 경로와
문제 종류(`group_or_world_writable`·`not_owned`·`missing`·`not_regular`)만 남는다. 값·절대 경로·사용자 이름은 적지 않는다.
이미 `deployed-and-verified`인 뒤 예약만 실패하면 `observation.safe.json`의 `schedule-failed`에 `reason`(같은 안전 코드)과
`file`(상대 경로)이 함께 남고, 완료된 앱은 재배포하지 않는다.

### monitor 검증은 5분, 넘으면 사람 판별(`deployed-human-review-required`)

마지막 단계 monitor-m3 는 새 deploymentId·done, runtime 계약, 이미지 revision·RELEASE_TAG·healthy 를 확인한 뒤
가장 최근 `monitor.push` 이벤트가 `state:"up"` 이고 두 수신자(primary·external)가 `ok:true` 로 90초 안에 응답했을 때만
`deployed-and-verified` 다. 이 push 영수증 대기는 `release_monitor.MONITOR_VERIFY_TIMEOUT_SECONDS` = **300초**다
(2026-10-31 사용자 결정). 다른 앱의 계약 검증 480초는 바꾸지 않았다.

5분이 지나면 두 갈래다.

- **(a) 배포 자체가 마지막 확인에서 증명됐고 (b) 막힌 것이 push 영수증(`stateUp`·`fresh`·receipts)뿐이면** run 을 멈추지 않는다.
  `monitor-m3.verified.json` 에 `verification: "human_review_required"`·`reason`·마지막 관측한 다섯 불리언(`pushReceipts`)을 남기고
  최종 fleet 검증·보호 관문·`result.safe.json`·관측 시작을 평소처럼 진행한다. `result.safe.json` 의 status 는
  `deployed-human-review-required`, `humanReview` 에 앱·사유·기록 경로가 있고, **종료 코드는 2** 다(0 이 아니므로 호출 스크립트는
  이를 완료가 아닌 "사람 확인 대기"로 다룬다). 5·10·15분·6시간 관측은 그대로 시작돼 있다.
- **(a) 조차 안 되면**(새 deploymentId 없음·runtime 미정착·옛 컨테이너·이미지 revision 불일치·spec drift·rollback·저장 설정 불일치)
  지금처럼 `monitor-m3_source_health_or_push_verification_timeout` 으로 `stopped-readback-required` 다. 사람 판별로 넘기지 않는다.

운영자가 확인할 것은 `execution/monitor-m3.human-review.safe.json` 에 값 없이(URL·비밀·로그 원문 없음) 남는다.

| 항목 | 뜻 · 확인 방법 |
|---|---|
| `reason` | `monitor_push_state_not_up`: 2026-10-31 사례 — 장부 `dispatch_stuck` 경보로 watcher 가 `down` 을 push 했고 수신자는 정상 응답. `monitor_push_receipts_unreadable`: 부팅 뒤 `monitor.push` 이벤트를 읽지 못함(컨테이너 수·SSH·로그 형식). `monitor_push_receipt_stale`: 마지막 push 가 90초보다 오래됨. `monitor_push_receiver_not_acknowledged`: 한쪽 수신자가 `ok:true` 가 아님. |
| `lastPushState`·`pushReceipts` | 마지막 `monitor.push` 의 state(`up`/`down`/`unknown`)와 `primary`·`external`·`fresh`·`stateUp` 불리언. M3 에서 `docker logs --timestamps --since <StartedAt> <monitor 컨테이너>` 의 마지막 `monitor.push` 와 대조한다. |
| `capacityUnknowns` | crawler-m3 컨테이너에서 읽은 `check-failover-readiness` 요약(`status`·`monitorOverall`·`count`·`stuckDispatched`·`oldestAgeSeconds`·`alarmReasons`). `alarmReasons` 에 `dispatch_stuck` 가 있으면 monitor 의 `down` 은 장부 상태이고 배포 결함이 아니다 — 장부 정리(고아 dispatched 회수 등)는 별도 절차이며 그 뒤 다음 push 가 `up` 인지 본다. 2026-11-10 부터 `review_backlog`·`review_stale` 만 있고 `stuckDispatched` 0 이면 monitor 는 `up`(메시지 「검토 대기 N건 … 사람 검토 필요」, `monitorOverall` ok)이라 이 인계가 생기지 않는다 — 그런데도 `down` 이면 다른 원인을 본다. `unread` 는 읽지 못한 것이고 정상이 아니다. |
| `operatorChecks` | `monitor_push_event_state_and_receipts`(위 로그 대조), `capacity_unknowns_alarm_reasons`(위 요약), `kuma_primary_and_external_heartbeat`(mini Kuma·Oracle Osaka Kuma 에 새 컨테이너 부팅 뒤 heartbeat 가 들어왔는지). |

세 항목이 확인되면 사람이 그 결과를 운영 기록에 남기고 끝낸다. 사람 판별은 재배포·marker 삭제·자동 재개의 허가가 아니다.

```bash
python3 scripts/ops/release_observer.py --help
```

로컬 Mac이 종료되거나 네트워크가 끊기면 관측을 보장하지 않는다. 과거 시각을 소급 통과로 기록하지 않는다.
관측 중에는 해당 worktree와 관측 모듈을 6시간 동안 보존한다. 경로 삭제·소스 바이트 변경은 후속 관측을 중단한다.
런타임이 새 버전으로 바뀌거나 관측 소스가 변하면 이전 관측은 원 상태와 다른 것으로 보고한다.

## 검사 단축

CI 규칙 `v2`는 docs/ui/full 프로필을 사용한다. docs는 기존 scope/check, 좁은 ui는
typegen·tsc·i18n·lint·unit2분할·build를 유지하고 DB 통합6분할/직렬 ledger만 생략한다.
ui 허용 목록은 `app/**.css`, `components/**.css`, `messages/**.json`이다.
이 저장소의 실제 문구인 `messages/**/*.ts`는 실행 코드라 full CI를 유지한다.
그 밖의 코드·설정·배포 도구·lockfile·workflow·혼합 변경은 full이다.

필수 `check`는 프로필별 필요한 job의 정확한 success/skipped 조합을 대조한다.
검사 재사용 artifact는 `ci-tested-tree-v2-<full|ui>-<tree>`로 분리하고 full에는 full 증거만 받는다.
로컬은 변경 회귀와 필요한 정적 검사를 한 번 실행하며, 마지막 PR 필수 CI를 공동 근거로 사용한다.
Python 운영 회귀는 lint에 유지했다. 별도 job 분리는 큰 절감 근거가 없어 이번 경로의 필수 변경에 포함하지 않았다.

실제 시간은 다음 배포에서 `PR check / main check·이미지 / 앱 갱신 / 복구 / 관측`을 따로 기록한다.
보고서의 Git6 약2분31초 절감은 이전 실측을 병렬로 대입한 예상이며 새 경로의 실제 절감 실측은 아직 없다.
