# 2026-11-06 배포 단축 경로

다음 배포부터 이 분류와 준비 순서를 먼저 적용한다. 실행 진입점은 기존 [단축 배포 절차](deployment-fast-path.md)의 `npm run deploy -- scope|plan|run`이다. 이 문서 PR은 배포 코드·CLI 옵션을 바꾸지 않는다. 아래의 **현재 사용 가능**과 **추가 구현 필요**를 구분한다.

## 변경 범위부터 나눈다

`scripts/ops/deployment_scope.py`의 `deployment-scope-v2`를 기준으로 한다. 실제 앱별 baseline으로 계산한 `plan`이 최종 대상이며, 이미 목표 상태인 앱은 유지한다.

| 변경 | 현재 분류 | 다음 배포에 적용할 절차 |
|---|---|---|
| 문서·tests·등록된 로컬 운영 도구만 | 0개 | 로컬 `scope`에서 0개를 확인하고 종료 |
| `app`·`components`·`styles` 아래 CSS만 | 웹 2개 | 웹 이미지 준비 후 웹 짝만 갱신 |
| 허용된 passive 이미지·폰트·앱 icon만 | 웹 2개 | 같은 웹 경로 사용 |
| 허용 locale의 `auth`·`browse`·`common`·`detail`·`global-error`·`launch`·`policy` 문구만 | 웹 2개 | 문구 TS의 full CI와 runtime 배포 범위를 구분 |
| 관리자 전용 TSX·임의 화면 TSX | 전체 18개 | 관리자 PR을 분리하되 현재 분류 결과 유지 |
| 공통 `lib`·DB·catalog·Dockerfile·workflow·미분류 변경 | 전체 18개 | 역할 짝·소비자를 포함한 기존 전체 경로 사용 |
| 등록된 scheduler·connect·monitor entrypoint만 | 해당 등록 앱과 필요한 역할 짝 | 실제 `scope`·`plan` 결과 사용 |

`scripts/ops/**` 전체가 0개인 것은 아니다. 등록된 `LOCAL_OPERATOR_FILES`만 해당한다. 명시적 앱 선택도 추론 범위를 넓힐 수만 있고, 전체로 분류된 변경을 임의로 웹 2개로 줄일 수 없다.

관리자와 공개 화면은 같은 웹 앱에 포함된다. 관리자 전용 PR 분리는 검토·릴리스 시점을 분리하지만, 현재 임의 관리자 TSX를 웹 전용으로 만드는 기능은 없다. UI와 worker/DB 변경을 한 PR에 섞으면 전체 범위가 적용된다.

**추가 구현 필요:** 화면·관리자 TSX를 웹 전용으로 좁히려면 실제 runtime import와 worker·scheduler·job registry 영향을 조사하고, 검증된 경로만 분류기 허용 목록에 추가하는 별도 코드 PR이 필요하다. DB·공유 lib를 import한다는 사실만으로 실행 범위를 단정하지 않고 실제 사용 관계를 확인한다. 알 수 없는 경로·rename·history는 계속 전체로 판단한다.

## 현재 사용 가능한 준비 순서

1. 변경 범위를 PR에서 분리하고 로컬 `scope`로 예상 대상을 확인한다. 필수 CI `check`와 필요한 immutable 이미지가 준비될 때까지 서비스는 유지한다. 이미 검증한 전체 테스트를 배포 직전에 다시 돌리지 않는다.
2. 첫 앱 변경 전에 GitHub API 잔여 한도와 reset, 기존 역할 quarantine·진행 경보·설정 drift를 확인한다. 기존 장애로 막혀 있으면 원인을 먼저 구분한다. 격리 표식이나 운영 DB 연결을 강제로 지우지 않는다.
3. 이미지가 준비되면 DRAIN 전에 기존 pre-pull로 양쪽 호스트의 이미지를 받는다. registry 설정·인증·웹 빌드 키·출처 검사는 유지한다.
4. 모델 호출을 보유하는 앱을 교체할 때만 공식 capacity 제어로 DRAINING으로 바꾸고, **유효 reserved 0·dispatched 0**을 기다린다. indeterminate는 비점유 검토 기록이므로 이 조건에 넣지 않는다. 실제 모델 서버의 고아 작업 종료까지 증명한다는 뜻은 아니다.
5. 기존 공식 잡 제어로 일시 정지가 필요하면 이번 배포가 변경한 잡과 이전 상태·audit를 기록한다. 최신 상태로 fresh `plan`을 만들고 정확한 plan hash로 한 번 `run`한다. 사전 다운로드한 이미지도 `plan`의 출처 검증을 그대로 받는다.
6. 새 버전·기본 건강 확인 후 같은 공식 제어로 OPEN을 복구한다. 배포가 직접 일시 정지한 잡만 원 상태와 대조해 재개한다. 이미 다른 이유로 정지된 잡을 함께 재개하지 않는다.
7. `refresh-caches`와 5·10·15분·6시간 관측은 기존처럼 비동기다. 실제 관측 영수증이 생기기 전에는 통과로 적지 않는다.

기존 사전 다운로드 명령은 다음과 같다. `NMV_RELEASE_SHA`와 두 image 값은 최신 trusted main CI의 정확한 SHA 및 검증된 immutable digest로 채운다. 이것은 서비스 설정을 변경하지 않는 이미지 준비 단계이며 `plan`·`run`을 대신하지 않는다.

```bash
python3 scripts/ops/deploy_shared_images.py prepull \
  --sha "$NMV_RELEASE_SHA" \
  --worker-image "$NMV_WORKER_IMAGE" \
  --web-image "$NMV_WEB_IMAGE"
```

실제 앱의 `autoDeploy=false`, 복제본·volume·health·registry 설정을 baseline대로 보존한다. 준비와 이미지 다운로드를 DRAIN 전에 끝내는 것이 실행 중단 시간을 줄이는 현재 사용 가능한 방법이다.

## 공개 GitHub 저장소도 API 한도가 있다

공개 데이터의 REST API는 무인증이면 IP당 기본 시간당 60회, 일반 사용자 인증은 기본 시간당 5,000회다. 같은 사용자의 토큰·일부 앱 요청은 개인 예산을 공유한다. Enterprise·설치 토큰 등은 별도 조건이 있으므로 실제 응답의 한도 헤더를 따른다. 공개 저장소나 공개 registry라는 이유로 API가 무제한이 되지는 않는다. [GitHub 공식 REST 한도 문서](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)에서 2026-11-06 확인했다.

현재 실행 가능한 대응:

- 첫 서비스 변경 전에 `gh api rate_limit` 등으로 잔여량·reset을 확인한다. 응답의 `x-ratelimit-*` 헤더가 현재 한도의 근거이며 `/rate_limit`을 반복 폴링하지 않는다.
- 한도를 넘으면 `x-ratelimit-reset`까지 기다린다. secondary 403/429는 `retry-after`를 우선 따르고, 헤더가 없으면 GitHub 문서의 backoff를 적용한다. 반복 요청이나 신원·IP 회전으로 제한을 회피하지 않는다.
- 서비스 변경 전 plan만 실패했다면 원인을 해소한 뒤 새 unique 출력 경로로 다시 준비한다. 이미 `execution/once.json`이 있으면 기존 표식을 재사용하지 않는다. 원본 `attempted`·`completed`·`verified` 영수증과 실제 API/runtime을 읽어 부분 완료·불명확 응답을 먼저 대조한다.
- 웹 이미지 패키지의 기존 비공개 설정을 유지한다. 저장소 공개 여부와 이미지 pull 인증은 별개이며, 공개 전환을 한도 해결책으로 사용하지 않는다.

`git ls-remote`·ref fetch로 exact main SHA를 확인하는 경로는 REST 조회와 다르다. 그러나 Git ref만으로 최신 CI 실행·attempt·필수 check·artifact·이미지 출처를 증명할 수는 없다. 현재 `deploy_git_apps.verify_main`과 `release_readiness.resolve_readiness`는 GitHub API를 호출하므로 **Git-only/offline 배포 fallback은 현재 지원되지 않는다.** 새 `--skip-check`·offline·override 옵션도 없다.

**추가 구현 필요:** Git ref와 서명 또는 검증 가능한 exact-SHA CI·이미지 영수증을 함께 사용하는 대안은 별도 코드 PR에서 신뢰 정책·최신성·SHA/tree/run/attempt/check/image digest 결속을 구현해야 한다. 옛 성공 CI나 이미지 태그만 가져와 현재 검증을 대체하지 않는다. 중복 API 조회를 줄이는 실행 단위 캐시도 최종 main·CI 변경 확인을 유지하도록 구현·검토해야 한다.

## 배포 완료와 기존 업무 경보를 나눈다

현재 `release_monitor.MONITOR_VERIFY_TIMEOUT_SECONDS`는 300초다. 새 deploymentId·done·runtime 계약·이미지 revision·healthy를 증명해도 `stateUp:false`면 이 시간을 기다린다. 이후 배포 자체 증명이 유지되면 `deployed-human-review-required`·종료 코드 2로 인계하고, 별도 관측을 시작한다. 이 동작은 문서 변경만으로 단축되지 않는다.

**추가 구현 필요:** 새 앱과 알림 수신이 증명됐고 기존 업무 경보만 남은 경우의 빠른 인계. 기존 경보를 새로 생긴 경보와 비교할 근거, 양쪽 수신 ACK와 freshness, runtime 안정성을 보존하는 코드 PR이 필요하다. 사람이 임의로 timeout을 바꾸거나 경보를 정상으로 덮어쓰는 절차는 없다.

## 시간 근거와 다음 측정

아래 시각은 UTC다. 2026-11-06 배포 영수증을 기준으로 하며, 사전 준비·복구·앱 교체·관측을 나눠 기록한다.

| 구간 | 확인된 시간 |
|---|---|
| 첫 실행 → 작업 재개 | 11-06 00:00:08 → 약 00:26, 약 26분 |
| GitHub 한도 중단 → 복구 배포 요청 | 00:01:39 → 00:08:26, 약 6분 47초 |
| 복구 완료 → 새 정상 실행 시작 | 00:09:38 → 00:12:05, 약 2분 27초 |
| monitor 요청 → 검증 인계 | 00:19:15 → 00:24:32, 약 5분 17초 |
| 기존 publisher 격리 관측 → 만료 | 11-05 23:39:30 → 23:52:16, 약 13분; 첫 실행 전 |
| 개별 앱 교체·기본 확인 | 대부분 32~56초, scheduler 최대 약 74초 |
| main check·이미지 승격 | 11-05 23:35:57 → 23:36:50, 1분 미만; PR 성공 CI 약 9분과 별도 |

monitor 사례는 기존 `review_stale` 20건 때문에 `stateUp:false`였고 양쪽 ACK는 정상이었다. 5분 대기를 없애려면 위의 빠른 인계 코드가 먼저 필요하다. GitHub 한도 이후 복구 시간 전체가 서버가 배포한 시간인 것도 아니다.

이미지·필수 CI가 준비돼 있고 기존 장애가 없으며 빠른 monitor 인계까지 구현되면, 같은 전체 배포를 약 **10~15분**으로 줄일 수 있다는 추산이다. 허용된 CSS 등 웹 전용 배포는 약 **2~3분** 추산이며, 임의 관리자 TSX가 지금 이 범위에 들어간다는 뜻은 아니다. 둘 다 변경 후 실측이나 보장 시간이 아니다.

다음 실행은 `PR CI / main check·이미지 / 준비·pull / DRAIN / 앱 교체 / 복구 / monitor 인계 / 후속 관측` 시간을 따로 남긴다. 이미 비동기인 캐시 갱신·6시간 관측을 새 절약 시간으로 다시 계산하지 않는다. 필수 CI·버전·이미지·출처·헬스 검증을 삭제해서 시간을 줄이지 않는다.
