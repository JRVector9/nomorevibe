# 변경 범위에 맞춘 일반 배포

2026-10-25 단축 보고서를 적용한 기본 진입점은 `npm run deploy -- <scope|plan|run>`이다.
필수 PR `check`는 유지한다. 이 도구를 main에 반영하는 것과 운영 앱을 새로 배포하는 것은 별개다.
현재 be71 운영 앱을 이번 도구 적용만으로 다시 올리지 않는다.

## 세 단계 실행

main의 정확한 SHA를 checkout한 깨끗한 운영자 Mac에서 실행한다. Python 표준 라이브러리,
Git·GitHub CLI 로그인, 기존 Keychain의 Dokploy 키와 두 호스트 SSH 접근이 필요하다.
웹 이미지 패키지의 비공개 설정과 기존 registry 자격 증명을 유지한다.

gpu3090에서는 `prod` 스킬의 기존 Keychain 호환 도구를 PATH에 추가한다.
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

준비 단계에서는 서비스를 변경하지 않고 필요한 이미지 cache를 두 호스트에 받는다.
main의 최신 trusted CI 실행에서 필수 `check`와 필요한 image publish가 성공하고
`release-image-{worker|web}-<SHA>` artifact의 run/attempt/tree/profile/version/digest가 일치해야 한다.
전체 workflow나 `refresh-caches` 종료를 기다리지 않는다. 준비가 아직 안 됐으면 배포 요청 없이 멈춘다.
실행 직전에도 main·CI·대상 범위·전체 원 상태를 다시 확인한다.

## 줄이는 단계와 유지하는 증명

| 변경 | 앱 갱신 |
|---|---|
| docs·README·검토된 로컬 운영 도구만 |0개|
| CSS·확인된 웹 문구 namespace·수동 웹 asset |웹2개|
| 독립 scheduler/connect/monitor entrypoint |해당 등록 앱|
| 공통 lib·DB·catalog·Dockerfile·workflow·이미지 승격·미분류 |전체18개|

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

## 실패·원복 자료와 비동기 관측

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
