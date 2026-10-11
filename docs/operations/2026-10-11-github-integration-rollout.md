# GitHub Star·피드백 코드 운영 배포 — 2026-10-11

## 결과

[PR #356](https://github.com/JRVector9/nomorevibe/pull/356)의 9개 구현 커밋을 보존하여 병합하고
운영 릴리스 `650b341c8889f06b2ec3daa3b99da4e5712fee1a`를 배포했다.
2026-10-11 17:24 KST 최종 확인에서 **14개 앱·19개 실행 복제본 모두 정상**이었다.
공개 서비스는 <https://nomorevibe.brut.bot>이다.

일반 인증·개인 GitHub Star·로컬 피드백·GitHub 피드백 전송의 네 플래그는 모두 `false`다.
운영에 새 App·메일·공개 인증·암호화 키가 아직 없어 이번 배포에서는 기능을 활성화하지 않았다.
실제 메일 수신, 개인 Star, 봇 Issue, 웹훅 및 외부 전송 중 failover 파일럿은 계속 미검증이다.

## 원격 검사와 이미지

- [PR CI 38123311591](https://github.com/JRVector9/nomorevibe/actions/runs/38123311591):
  scope·quality·DB 통합 3분할·필수 `check` 성공. 병합 직전 최신 base와 동일했다.
- [main CI 38123539692](https://github.com/JRVector9/nomorevibe/actions/runs/38123539692):
  같은 필수 검사와 ARM64 worker/web 이미지 빌드 모두 성공.
- worker: `ghcr.io/jrvector9/nomorevibe-worker@sha256:b2f81cd8179770c364452e9d2cbb1fb19c1a1ac9607c79496b3282dbde1070ab`
- private web: `ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:8b65fed0865672f2ab942874a897f9ff00850ad6d309238f58fa4921deeb2ab6`

두 서버에서 이미지의 ARM64·OCI revision·기존 웹 빌드 암호화 키 일치를 확인했다.
웹 키를 회전하지 않았다. main의 PR·최신 base 필수 검사 정책을 우회하지 않았다.

## DB와 순차 교체

scheduler와 다섯 역할의 주·예비, 총 11개 서비스의 소비자를 정상 drain했다.
검증한 worker 이미지의 `scripts/migrate.mjs`를 PostgreSQL 직접 연결 **5432**에서 한 번 실행하여
종료 코드 0을 확인했다. runtime PgBouncer **6432** 설정은 유지했다.
DB migration journal은 **66→73**, 신규 테이블은 **14개**이며 마지막 7개 migration hash가
배포 소스의 SQL 파일과 모두 일치했다. 기존 DB를 초기화하거나 복구 덤프로 덮지 않았다.

maintenance와 text는 각각 mini 예비→M3 주 순서로, scheduler와 connect-agent는 기존 main Git
source를 유지하여 배포했다. 그 뒤 공통 배포 스크립트의 `plan → run`을 실행하여
publisher→reviewer→crawler의 mini→M3, 웹 mini→M3 순서로 교체했다.
역할 쌍마다 readiness/progress 검사 성공 후 다음 단계로 진행했다.
앱의 source type·autoDeploy·command·복제본 수 정책을 변경하지 않았다.

| 운영 앱 | 앱 수 / 실행 복제본 | 실제 코드 확인 |
| --- | --- | --- |
| 웹 M3·mini | 2 / 6 (4+2) | 동일 web digest·release·NEXT_DEPLOYMENT_ID, 각 컨테이너 health/DB 정상 |
| publisher M3·mini | 2 / 2 | 동일 worker digest·release·worker health 정상 |
| reviewer M3·mini | 2 / 2 | 동일 worker digest·release·worker health 정상 |
| crawler M3·mini | 2 / 2 | 동일 worker digest·release·worker health 정상 |
| maintenance M3·mini | 2 / 2 | Git main source·release, 컨테이너 내 소스 500파일 hash 일치 |
| text M3·mini | 2 / 2 | Git main source·release, 컨테이너 내 소스 500파일 hash 일치 |
| scheduler M3 | 1 / 2 | 두 복제본 Git source·release·500파일·health 일치 |
| connect-agent M3 | 1 / 1 | Git source·release·500파일·health 일치 |

문서의 기존 13개 core 앱 외 connect-agent 1개를 실제 조회에서 확인해 검증에 포함했다.
Git source 이미지의 소스 대조에는 `.dockerignore`가 제외하는 `scripts/ops` 2파일을 포함하지 않는다.

## 최종 운영·공개 화면 확인

- 14개 앱 모두 새 deployment `done`이며 실제 실행 이미지 또는 Git source가 위 릴리스와 일치했다.
- 다섯 역할 모두 M3 primary의 live DB lease를 확인했고 mini standby 관측도 신선했다.
  failover readiness와 worker progress는 모두 `ok`, scheduler의 fresh replicas는 2였다.
- 공개 health에서 `m3-web`·`mini-web` 모두 `status:ok`, `db:ok`, 새 release를 확인했다.
- 실제 Playwright 공개 홈·`/p/nanomuse` 상세는 HTTP 200, 브라우저 오류 0·실패 리소스 0이었다.
  각 HTML의 JS/CSS `dpl`도 새 SHA와 일치했다. 홈 첫 관측 5,953ms→배포 후 2,730ms는 단발 측정으로
  성능 개선 수치로 해석하지 않는다. 배포 후 홈 스크린샷도 직접 확인했다.
- `product-intro-check`는 `not_before=2100-01-01`, `processed_version=741`, `leased=false`로
  배포 전후 동일했다. 사용자가 중단한 소개 검수를 재개하지 않았다.

## 발견한 운영 항목과 보존 자료

Cloudflare HTML 태그 purge는 **Authentication error**로 실패했다. 배포 스크립트는 이 별도
캐시 작업의 실패를 알리고 정상 배포를 보존했다. 실제 홈·상세의 새 asset deployment ID와
브라우저 로딩은 확인했으며 purge 키 복구는 [PENDING](../../PENDING.md)에 남겼다.

소비자 복구 때 mini를 먼저 시작하여 예비들이 정상 lease를 인계받았다. 새 maintenance/text의
순차 교체와 기존 publisher/reviewer/crawler 예비의 개별 정상 drain·주 lease 확인·예비 재시작으로
M3 primary 상태를 회복했다. DB lease를 직접 수정하거나 강제로 소유권을 빼앗지 않았다.
operator helper의 향후 복구 순서는 M3→mini로 바꿨다.

초기 소스 probe는 제외된 운영 스크립트 2개까지 포함해 정상 컨테이너를 불일치로 판정했다.
검증 목록을 502→500으로 고친 뒤 이미 배포된 컨테이너를 재배포 없이 확인했다.
이 과정에서 서비스 코드 변경은 없었다.

다음 원본은 작업자의 `/private/tmp`에 보관하며 Git에 넣지 않는다.
환경 비밀값이 있는 세 snapshot은 **0600**이다.

- `nomorevibe-all-apps-before-20261011.json`, `nomorevibe-swarm-before-20261011.json`,
  `nomorevibe-release-650b341-20261011.json`: 배포 전 설정 및 공통 8앱 복구 자료.
- `nomorevibe-migration-result-20261011.json`, `nomorevibe-db-after-migration-20261011.json`,
  `nomorevibe-production-release-20261011.json`: 실제 실행·DB·전체 최종 검증 근거.
- `nomorevibe-public-{before,after}-20261011.json`, `nomorevibe-{before,after}-{home,detail}-20261011.png`:
  공개 브라우저 관측과 화면.

공통 8앱 복구는 보관한 snapshot과 `deploy_shared_images.py restore`를 사용한다.
Git source 앱 복구는 이전 소스 commit과 환경을 함께 지정하고 실제 코드·역할을 다시 확인해야 한다.
이번 작업은 운영 rollback 주입이나 실제 GitHub 쓰기 파일럿을 수행한 것으로 기록하지 않는다.
