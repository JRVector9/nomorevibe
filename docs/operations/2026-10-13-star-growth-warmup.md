# 2026-10-13 급상승 관측 준비 기간의 프로젝트 노출

[PR #398](https://github.com/JRVector9/nomorevibe/pull/398)을 커밋·푸시·필수 CI 성공·normal merge한 뒤 양 운영 웹에 배포했다. 공개 홈5개와 [/rising](https://nomorevibe.com/rising)15개, 다음 페이지15개가 실제 표시되며 홈과 전체 목록의 첫5개·순서가 일치한다.

## 원인과 수정

10월13일03:59 KST의 운영 read-only SQL에서 닫힌 회차는 12일16시(3,627/3,627 성공)와13일00시(3,667/3,667 성공)뿐이었다. 관측 잡은 매분 정상 완료했고 last_error=null이었다. 관측을12일에 시작해 T−24시간 회차가 없어 기존 reader가 빈 목록을 반환했다. 수집 중단이나 UI 배포 누락이 아니었다.

전날 회차가 없으면 최신 닫힌 회차의 실제 관측 프로젝트를 **스타 관측 중인 프로젝트**로 표시한다. 스타50~1,999개, 성공 관측·공개/생존/저장소 연결·관측 창/10시간 신선도 조건을 유지하고 이번 회차 스타 내림차순·고정 slug 순으로 정렬한다. 홈5개와 전체15개는 같은 회차·조회·페이지 기준을 사용한다. 증가량과 과거값을 만들지 않는다.

전날 정상 회차가 생기면 기존 **전일 대비 스타 급상승**으로 자동 전환한다. 스타50~1,999개·전일+10개 이상·실제 관측 간격23~25시간·동일 저장소/연결 버전 조건은 유지한다. 수집이 정상적으로 이어지면 첫 비교는 **10월13일16시 KST 회차**부터 가능하다. 실제 전환과 조건 충족 프로젝트 수는 미래 회차가 마감된 뒤 확인해야 한다. 실패·미마감·전날 회차 실패를 후보 목록으로 덮지 않는다.

새 schema/migration·워커 배포·수집 횟수·AI 호출·키/flags 변경은 없다. 사용자가 중단한 소개 검수는 재개하지 않았다.

## 전달·실행 증거

- 코드 head `921b8606a1a3a054547b74d88bcf06aa4ffe3698`, PR CI [38295058222](https://github.com/JRVector9/nomorevibe/actions/runs/38295058222) completed/success, 최신 base `5a66d07`, merge `b48b3d3972f7f6e5149f632e1de75e544427f86f`.
- main CI [38295610184](https://github.com/JRVector9/nomorevibe/actions/runs/38295610184)의 scope·quality·DB integration3개·check·worker/web publish 실제 success. quality의 타입/lint/단위/빌드 통과와 사용자 직접 기능 테스트를 구분한다.
- 실제 운영 web release `b48b3d3972f7f6e5149f632e1de75e544427f86f`, private immutable image `ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:f605fc68cabef4731ce1e5d6aa8bf75125986132217aa45b94697e2798f99f63`.
- mini deployment `c2-oYFFC2vutdNrPx9Yqr`, M3 deployment `pC8vsYZDJdYioMbqP-0Ow` 모두 done/healthy. mini2/2와 M3 4/4 실제 컨테이너 image/release·전체 saved/runtime env·공개 health가 일치했다.
- Docker worker6개는 기존 `33349ed1352caabcb434ac4906bc2a2213ac2a51` / `ghcr.io/jrvector9/nomorevibe-worker@sha256:ce17a8f84c31bbab98bd9186e2ecaefc4fd8855a6c55d1c2a7ff84f32952ade9` 유지·healthy. 이번 worker 이미지는 발행만 확인했다. Git/manual maintenance/scheduler/text 앱은 이 릴리스에서 배포하지 않았다.
- 공개 curl GET의 새 asset dpl 확인, 홈5/rising15/page2 15, 첫5개·실측 스타 내림차순 일치, 증가량 badge 없음, 페이지 간 중복 없음 확인.
- 배포 전후 workerProgress/workerFailover ok. intro not_before=2100-01-01T00:00:00Z/unleased 보존. 기존 네 GitHub flags true/설정 일치, 도메인·키·명령·buildSecrets·replicas·source·autoDeploy 보존.

안전한 운영자 작업 위치는 `/private/tmp/nomorevibe-star-growth-release-20261013-88ou02hb`다. `target.json`, `verification.json`, `public-get.json`, `health-before.json`, `health-after.json`, `deployment-identities.json`은 비밀값을 제외한 증거다. preflight/before snapshot은 비밀값이 포함될 수 있어0700 디렉토리/0600 파일로 로컬에만 보관하며 출력·커밋하지 않는다. deploy는 새 O_EXCL snapshot 후 한 번 실행했고 반복하지 않는다.

처음 검색의 추정 glob 불일치 외 새 CI/배포 실패는 없었다. 기존 Cloudflare purge 인증 실패는 재시도하지 않았고 canonical GET의 새 release/content로 반영을 확인했다. 스킬·서브에이전트·Codex CLI·새 테스트를 사용하지 않았다. 로컬 기능/E2E나 실제 인증·댓글/스타/GitHub 쓰기는 수행하지 않았다.
