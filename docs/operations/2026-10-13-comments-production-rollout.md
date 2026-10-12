# 댓글 PR01~04 운영 배포 결과

2026-10-13 KST. 사용자 요청에 따라 커밋·푸시한 네 PR을 보호된 main에 순차 병합하고 두 운영 웹에 배포했다. 배포 후 읽기 전용 상태 확인까지 완료했다.

## 병합과 CI

| PR | 최신 main 기준 확인한 head / CI | 실제 merge |
| --- | --- | --- |
| [PR01 #393](https://github.com/JRVector9/nomorevibe/pull/393) | `68940aa` / `38263733075` 성공 | `1d3b31a` |
| [PR02 #394](https://github.com/JRVector9/nomorevibe/pull/394) | `41e3ca7` / `38267679323` 성공 | `452ae56` |
| [PR03 #395](https://github.com/JRVector9/nomorevibe/pull/395) | `653237c` / `38268389005` 성공 | `c731167` |
| [PR04 #396](https://github.com/JRVector9/nomorevibe/pull/396) | `589c9af` / `38269164775` 성공 | `0db24f0` |

후속 PR을 main 대상으로 바꾸고 실제 최신 main을 브랜치에 병합·푸시한 뒤 필수check 성공을 확인했다. 일반 matching-head merge를 사용했으며 force push·보호 우회는 하지 않았다. 로컬 main도 FF했다.

최종 코드 릴리스는 `0db24f0d4afec7c7a70065f45103446f22fd024f`다. [main CI38269773018](https://github.com/JRVector9/nomorevibe/actions/runs/38269773018)의 scope·quality·integration3분할·필수check·worker/web 이미지 발행 모두 실제 성공이다. 웹 이미지는 비공개 `ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:62fb6c59836afa46186d0b5dbbd7ae8fd88d94e0d2eeb5f06d86318098ec17e9`를 사용했다. 문서만 추가 병합한 main의 SHA와 실행 중인 코드 릴리스는 다를 수 있으며, 문서 전달 때문에 이미지를 다시 배포하지 않는다.

## 실제 운영 결과

| 웹 | Dokploy deployment ID | 실행 상태 |
| --- | --- | --- |
| mini | `1lOdFUzb9YGg3oBh5sBFr` | done, 같은 digest/release, 2/2 컨테이너 정상 |
| M3 | `S6PJE-SWveHQ0o1NaPcFO` | done, 같은 digest/release, 4/4 컨테이너 정상 |

mini를 먼저 완료하고 M3를 배포했다. 양 서버의 실제 private image pull·arm64·OCI revision과 기존 build/runtime action key 일치를 선행 확인했다. 두 웹의 환경에서 변경한 값은 `RELEASE_TAG`·`NEXT_DEPLOYMENT_ID`이며 기존 인증키·origin·플래그·replicas·source·autoDeploy·명령·buildSecrets를 보존했다. 두 웹을 포함한 Docker8앱12컨테이너의 실제 digest/release/환경·health 일치도 확인했다.

네 기능 플래그 `PUBLIC_USER_AUTH_ENABLED`, `GITHUB_STAR_ENABLED`, `PRODUCT_FEEDBACK_ENABLED`, `GITHUB_FEEDBACK_DELIVERY_ENABLED`는 기존 true를 유지했고 configurationMatched도 true다. flag ON은 실제 GitHub 스타·이슈 생성 시험의 성공을 뜻하지 않는다. 워커는 기존 `33349ed1352caabcb434ac4906bc2a2213ac2a51` / `ce17a8f84c31bbab98bd9186e2ecaefc4fd8855a6c55d1c2a7ff84f32952ade9`를 유지했다. 이번 CI worker 이미지는 발행만 확인했다. DB migration·worker 교체·키 회전·스타 기능 변경은 없었다.

## 실행한 배포 후 확인

- 공개 `/api/health`에서 `mini-web`·`m3-web` 모두 새 릴리스와 status/db `ok`를 확인했다.
- `/`, `/login`, `/api/me`, `/p/manimgx`, `/p/openfilm`, `/api/products/manimgx/feedback`의 curl GET은 모두 HTTP200이었다. `/api/me`의 익명 응답도 기존 계약과 같았다.
- 두 상세페이지 HTML의 asset deployment ID는 새 릴리스였다. 댓글 영역·`#feedback`·접힌 작성 버튼은 각각1개, 초기 펼친 작성창은0개였다.
- ManimGX 공개 댓글 GET의 실제 응답은 total0·목록0개였으며 새 total 필드를 확인했다.
- 배포 전후 worker failover/progress는 `ok`였다. 소개 검수는 `not_before=2100-01-01`, lease 없음으로 중단을 유지했다.

`capture`, `plan`, 한 번의 `deploy`, `verify`, `public_get.py`, `health_verify.py before/after`는 실제 종료 코드0이었다. 최초 Python urllib 상세 GET은403으로 실패했으며 기존 curl 방법의 실제 HTTP200으로 확인했다. 기존 Cloudflare purge 키의 인증 실패는 이번에 재시도하지 않았고 canonical GET의 새 asset ID로 실제 반영을 확인했다.

사용자 요청에 따라 로컬 화면 기능/E2E 테스트, 실제 로그인·댓글 제출·GitHub 이슈/스타 쓰기는 실행하지 않았다. 화면 작성·인증 복귀·초안·재시도·GitHub 별도 동의는 사용자가 직접 확인한다. 구현 리뷰는 [기존 보고서](2026-10-12-comments-review.md)에 있다.

## 인계와 복구 자료

운영자 도구는 `/private/tmp/nomorevibe-comments-release-20261013-uyggqrv7`다. `preflight.json`·`before.json`은 비밀을 포함하므로 폴더0700/파일0600을 유지하고 출력·커밋하지 않는다. `before.json` 생성 뒤 deploy는 반복하지 않는다. 상태 재확인은 `release.py verify`와 읽기 전용 public/health helper만 사용한다. rollback은 private snapshot의 이전 웹 digest/env로 앱 하나씩 복구하고 양쪽 버전·키·health를 다시 확인해야 한다.

루트의 소유 시안·계획·리뷰·인계만 정확한 경로로 백업한 stash `a7813ffdb053286bffee61df83a6ce19424f8a4e`, 진행 인계만 백업한 `f5d30cc246b22a932e46478261542b3cd483ac28`를 보존했다. 최신 main에 다시 적용하거나 삭제하지 않는다. 사용자 나머지 미추적 파일은 그대로 유지했다.
