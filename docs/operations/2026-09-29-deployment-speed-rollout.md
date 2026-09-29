# 배포 시간 단축 릴리스 — 2026-09-29

## 적용 범위와 속도

PR #234의 필수 `check`는 `scope` 뒤에 품질 검사와 PostgreSQL 전용 DB가 붙은
통합 테스트 3개를 병렬 실행한다. 기존 PR #231의 `check`는 6분 27초였고,
#234는 실행 생성부터 `check` 완료까지 2분 55초였다. main의 기존 5분 3초 검사는
PR #235 병합 뒤 2분 53초였다. 새 main 실행은 이미지 2개 빌드를 포함해
4분 17초에 끝났다. 문서 전용 PR #236의 첫 실행은 생성부터 필수 `check`까지
14초였다. `scope`와 `check`가 성공하고 quality·integration·두 이미지 작업은
모두 건너뛰었다.

8개 앱은 이전 Git 소스의 개별 빌드에서 공통 이미지 digest로 전환했다.
두 서버에서 이미지를 미리 pull한 뒤 Dokploy가 기록한 개별 배포 시간은
0.555–1.138초, 8개 합계 6.103초였다. 다만 예비→주 readiness를 사람이
각 역할마다 확인해 첫 앱 시작부터 마지막 앱 완료까지 4분 12.8초가 걸렸다.
이전 릴리스의 8개 순차 완료 4분 7초와 비교해 전체 교체 시간은 아직 줄지
않았다. CI 병목과 앱별 빌드는 줄었고, 운영 확인을 자동화하는 일은 별도다.

## 이미지와 운영 확인

main SHA `cf64bc246319ca2d5ea0925c30fa2a3ebf2f8667`의 두 ARM 이미지:

| 용도 | GHCR 이미지 digest | 사용 앱 |
|---|---|---:|
| worker | `ghcr.io/jrvector9/nomorevibe-worker@sha256:77f33353431c74be2886a0b3d5849fcf5e20cbaea722ecd45fcdefac183176d8` | 6 |
| web | `ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:b3a81e45d30c7720e5a90fa28de713c3ba496f84d17770b26d07bb4050164b39` | 2 |

두 이미지의 `linux/arm64` manifest와 OCI revision을 확인했고 M3·mini에서
실제로 pull했다. 비공개 웹 패키지는 익명 manifest 조회가 거부된다. 8개 앱
모두 Dokploy 최신 deployment가 `done`, 설정 source가 Docker, 실행 중 Docker
service image가 위 digest이며 `RELEASE_TAG`가 같은 SHA였다.

publisher, reviewer, crawler 순서로 각 mini 예비→M3 주를 배포했다. 예비만
새 릴리스일 때의 `release_mismatch` 경보는 주 배포 뒤 `ready`로 복귀했다.
웹은 mini→M3로 연속 교체했고 두 컨테이너의 직접 `/api/health`는
`status:ok`, `db:ok`, 새 release였다. 런타임 키와 `NEXT_DEPLOYMENT_ID`도
두 웹에서 일치했다. 공개 `/api/health` 12회는 M3 7회·mini 5회였고 모두
새 release였다. 10:38:59 UTC의 `check-failover-readiness.ts`와
`check-worker-progress.ts`는 종료 코드 0, 전체 `ok`였다. 운영 DB 서버·
스트리밍 설정과 migration은 변경하지 않았다.

## 공개 웹 이미지와 키 회전

첫 main 이미지 빌드의 `nomorevibe-web` 패키지는 공개였다. 이미지를 배포하기
전에 2,732개 파일을 검사해 실제 `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`가
Next의 `server-reference-manifest.js`와 `.json`에 들어간 것을 확인했다.
공개 패키지를 삭제하고 익명 태그·digest 조회가 실패하는 것을 확인했다.
두 서버에서 내려받은 해당 이미지도 실행 중인 컨테이너가 없음을 확인한 뒤
이미지 참조를 제거했다. 이미 다운로드했을 가능성은 되돌릴 수 없으므로
기존 키는 노출된 것으로 취급했다.

새 32바이트 키를 만들어 Actions 빌드 secret과 두 운영 웹의 build secret·
runtime env에 동일하게 적용했다. 계정 토큰으로 미리 만든
`nomorevibe-runtime-web` 패키지가 `private`이고 익명 조회가 거부되는 것을
빌드 전후 확인했다. 새 웹 이미지의 같은 2,732개 파일에서 이전 키는
발견되지 않았고 새 키만 서버 참조 manifest 2곳에 있었다. 임시 bootstrap
이미지 버전은 실제 릴리스 이미지가 올라온 뒤 삭제했다. 키 값은 문서·Git·
로그에 기록하지 않았다.

## 검증 기록과 후속 작업

- 로컬 분류기 4개 테스트, 통합 shard 34/33/33파일의 323/271/352개 테스트
  통과(기존 TODO 1개). 타입 생성·TypeScript·lint·단위 테스트·빌드,
  `actionlint`, `git diff --check` 완료. lint의 기존 경고 1개는 남았다.
- PR #234와 #235의 필수 `check`, 보안 검사, 두 main 실행의 이미지 작업 성공.
- PR #236 첫 실행의 필수 `check`는 14초였고 GitGuardian 검사도 통과했다.
- 실제 운영 상태는 짧은 시점의 검증이다. 24시간 처리·헬스 추세는
  [PENDING.md](../../PENDING.md)에 남겼다. private GHCR pull에 사용한 계정
  토큰을 별도 최소 권한 토큰으로 바꾸고 만료 시 재배포 경로를 확인해야 한다.

롤백 자료는 운영 앱 8개의 이전 Git source/env/build 설정을 권한 0600의
로컬 보관 파일에 저장했다. 소스와 이미지의 실제 실행 상태를 확인하지 않고
`RELEASE_TAG`만으로 롤백 완료를 판단하지 않는다.
