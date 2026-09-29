# 배포 시간 단축 설계 — 2026-09-29

## 목표와 기준

PR #231에서 필수 CI `check` 6분 27초(통합 테스트 3분 24초), 뒤이은 앱 8개의
순차 교체가 첫 완료부터 마지막 완료까지 4분 7초였다. PR #232의 문서 변경도
전체 CI를 다시 실행해 6분 31초 걸렸다. 필수 검증과 주·예비 안전 순서를
유지하면서 같은 작업을 반복하는 시간을 줄인다.

## CI

항상 실행되는 `scope`가 PR merge commit 또는 main push의 변경 파일을 검출한다.
`README.md`, `PENDING.md`, `docs/**`만 바뀌면 문서 변경으로 분류한다. 빈 diff,
비교 실패, 수동 실행, 그 밖의 파일 변경은 모두 코드 변경으로 취급한다.
필수 이름 `check`는 항상 실행하며 `scope` 결과와 모든 필수 잡의 성공을 검사한다.
workflow 자체에 paths filter를 걸지 않아 branch protection의 Pending 함정을 피한다.

코드 변경이면 `quality`(typegen, TypeScript, lint, unit, build)와 세 개의
`integration` shard가 병렬 실행된다. 각 shard는 별도 GitHub Actions runner와
PostgreSQL 17 서비스 하나를 가지며, shard 내부 파일은 기존처럼 직렬 실행한다.
전용 DB 안전 검사는 그대로 유지한다. 어느 shard라도 실패하면 `check`가 실패한다.
문서 변경이면 `scope`의 `git diff --check` 성공만으로 `check`가 성공한다.
main push의 중복 전체 CI도 문서 변경에는 실행하지 않는다.

## 이미지 생성과 배포

main의 코드 변경 `check` 성공 후 GitHub Actions가 같은 SHA의 `worker`와
`runner` 이미지를 각각 한 번 빌드해 JRVector9 GHCR에 올린다. 웹은
운영 M3·mini가 모두 `arm64`이므로 `ubuntu-24.04-arm` runner에서
`linux/arm64` 이미지로 빌드한다. Next의 서버 참조 manifest에 Actions 빌드 키가
들어가므로 웹 패키지는 공개 저장소와 별도로 만든 비공개
`nomorevibe-runtime-web`에만 발행한다. 기존 GHCR-deppy 등록의 실제 Docker 로그인은
인증 거부를 반환했다. 두 서버에서 새 비공개 이미지 pull을 확인하기 전에는 source를
전환하지 않는다. 웹은
현재 Dokploy 두 앱의 동일한 `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`를 Actions
secret으로 복사해 BuildKit secret mount에만 제공하고 `NEXT_DEPLOYMENT_ID`는
commit SHA로 고정한다. Actions token에는 해당 잡에서만 `packages: write`를
준다. 이미지는 태그와 OCI source/revision을 기록하고, 배포에는 태그 대신
registry가 반환한 immutable digest를 쓴다. docs-only main push에는 빌드가 없다.

운영 전환은 자동 병렬 교체가 아니라 기존 failover 순서다. 운영 스크립트는
이미지 digest·대상 앱 신원·GHCR pull 접근·현재 release·Docker source 설정을
확인하고, 예비 publisher/reviewer/crawler → M3 주 → mini 웹 → M3 웹을
순서대로 배포한다. 각 단계의 `done`, 런타임 release, 역할 readiness를 확인한
뒤 다음 단계로 간다. 앱의 기존 env, command, volumes, domains, healthcheck,
주·예비 정책은 유지한다. 실패하면 남은 앱을 전환하지 않고 이전 이미지 또는
GitHub source 구성을 복원한다. DB 서버·스트리밍 설정은 변경하지 않는다.

## 검증

분류기의 문서/코드/빈 diff/수동 실행 경계를 단위 테스트로 확인한다.
세 shard의 파일 집합이 전체 통합 테스트 파일을 빠짐없이 한 번씩 포함하고
각 shard가 독립 DB에서 실제 통과하는지 확인한다. PR 필수 `check`와
main 이미지 빌드·registry digest를 확인한 뒤 예비부터 운영 배포한다.
배포 전후 8개 앱의 image digest와 release, 웹/DB health, 다섯 역할의
ready/progress를 기록한다. 다음 문서 전용 PR에서 빠른 `check`를 실측한다.
