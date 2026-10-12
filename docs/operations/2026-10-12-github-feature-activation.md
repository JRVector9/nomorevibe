# GitHub 로그인·개인 스타·피드백 운영 활성화

상태: **운영 배포와 네 기능 플래그 ON 완료**. 2026-10-12 11:10 KST 최종 확인에서
14개 앱과 19개 실행 컨테이너가 정상이었다. 실제 사용자 기능 테스트는 아직 수행하지 않았다.

## 환경변수와 실행 반영

플래그는 Dokploy의 각 **Application → Environment**에서 설정한다. 저장한 뒤
재배포해야 실행 컨테이너에 반영된다. 아래 값은 저장 설정과 실행 환경 양쪽에서 확인했다.

| 대상 | 환경변수 | 적용 값 |
| --- | --- | --- |
| 웹 mini·M3 | `PUBLIC_USER_AUTH_ENABLED` | `true` |
| 웹 mini·M3 | `GITHUB_STAR_ENABLED` | `true` |
| 웹 mini·M3 | `PRODUCT_FEEDBACK_ENABLED` | `true` |
| 웹 mini·M3·publisher 주/예비·maintenance 주/예비 | `GITHUB_FEEDBACK_DELIVERY_ENABLED` | `true` |

GitHub 가입·로그인은 Resend 없이 사용한다. 이메일 로그인은 별도 발신 설정을 추가할 때
사용할 수 있다. GitHub 피드백 전송에는 제작자의 Feedback App 설치, 저장소 연결과
수신 허용, 작성자의 공개·전송 동의가 필요하다.

## 릴리스와 배포

실행 코드 릴리스는 `58a63a3bc180f3e9cce3670ebb5b52a11cf6c3ef`이며
[main CI38186736825](https://github.com/JRVector9/nomorevibe/actions/runs/38186736825)의 검사와 이미지 빌드가 성공했다.
배포 시작 main `d506cfb87689452adebd36aa9c6992c7c3c3bb5d`와 비문서 차이가 없어 검증 이미지를 재사용했다.

- worker: `ghcr.io/jrvector9/nomorevibe-worker@sha256:43f7a9212d57203d9df5681df48e2a6b15514cc6d91237f1cf5aa4b44196722c`
- private web: `ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:76f7ed244d5c6838aae6b90785f0f087a1af5bb5868883a46fdf68690d10ebd7`

양 서버에서 실제 pull로 ARM64, OCI revision, 기존 웹 빌드·실행 암호화 키 일치를 확인했다.
Git 앱은 main 소스를 유지하고 실행 파일 507개의 SHA256을 릴리스와 대조했다.
API의 Git commitId는 null이므로 실제 Git 커밋은 그 필드로 단정하지 않는다.

현재 환경과 Swarm 설정을 보관하고 scheduler 및 다섯 역할의 주·예비를 정상 drain했다.
PostgreSQL 직접 연결 5432에서 migration0073/0074를 적용해 종료 코드0, journal73→75,
마지막 두 SQL 해시 일치와 신규 관측 표2개를 확인했다. 기존 runtime PgBouncer6432는 유지했다.
워커 복구 후 maintenance/text, scheduler/connect-agent, publisher→reviewer→crawler,
마지막으로 웹 mini→M3를 교체했다. 기존 source, command, 복제본과 autoDeploy 정책을 보존했다.
scheduler와 connect-agent의 기존 autoDeploy는 true다.

## 실제 확인 결과

- Docker8앱과 Git6앱의 새 배포 done, 컨테이너 healthy, 실행 릴리스·이미지·소스 일치를 확인했다. 웹은 mini2/M3 4복제본, scheduler는2복제본이다.
- 필요한 App·공개 인증·암호화 키, origin과 기능 플래그가 저장 설정 및 각 실행 컨테이너에서 일치했다. 비밀값은 출력하지 않았다.
- 다섯 역할 모두 M3 primary의 live DB lease와 릴리스가 일치했고 readiness/progress는 모두ok였다.
- 공개 health에서 mini-web과 m3-web의 status:ok, db:ok, 새 릴리스를 확인했다. `/login`과 `/p/nanomuse`의 배포 준비 GET은 HTTP200, DYNAMIC, 새 asset dpl이었고 로그인 응답에 GitHub 안내가 표시됐다.
- 최종 읽기 검증 `verify.py`는 실제 exit0이었다. 소개 검수는 기존2100년 pause, processed_version741, leased=false를 유지했다.

사용자 지시에 따라 실제 OAuth 승인, Star 등록·취소, 댓글 제출, 메일, Issue 생성,
웹훅 redelivery와 역할 중단 실험은 수행하지 않았다. 위 결과는 배포 확인이며 실연동 테스트 성공 기록이 아니다.
새 급상승은8시간 관측 회차와24시간 전 비교 자료가 쌓여야 한다. 과거 값을 만들어 채우지 않았다.

복구·검증 근거는0700 디렉터리 `/private/tmp/nomorevibe-activation-20261012-7ej2ked6`의
0600 파일에 있다: `before.json`, `swarm-before.json`, `db-before.json`, `preflight.json`,
`migration-verified.json`, `verification.json`. 원본 환경 snapshot에는 비밀값이 있으므로 Git에 넣지 않는다.

초기 snapshot의 모든 autoDeploy=false 가정은 실제 scheduler/connect-agent 설정과 달라
읽기 단계에서 중지됐다. 재조회 후 기존 true를 보존하도록 운영 helper를 수정했다. 이미지 로그의
첫 조회도 잘못된 job ID와 summary 문자열 부재로 실패했고 정확한 publish job의 DIGEST 및
양 서버 pull로 확정했다. 실제 migration·배포·최종 실행 검증 실패는 없었다.
