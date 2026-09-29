# 공통 이미지 배포 확인 자동화 — 2026-09-29

## 적용과 소요시간

PR #238은 `scripts/ops/deploy_shared_images.py`에 공통 이미지 배포의 사전 검사와
단계별 게이트를 넣어 main `5d67b23466659e943e51d5110ce5f2fd2ef8eab1`에
병합했다. main CI의 필수 `check`, quality, PostgreSQL 통합 테스트 3분할,
worker/web 이미지 빌드가 모두 성공했다. 첫 실제 `plan`은 20.27초에 성공했고
8개 앱의 이전 릴리스·실행 컨테이너, 기존 failover·진행 상태, 두 서버의 새
이미지 pull/arm64/OCI revision, 비공개 웹 이미지의 빌드 키 일치를 확인했다.

`run` 명령 전체는 사전 검사·이미지 pull을 포함해 **118.45초**에 종료 코드
0으로 끝났다. Dokploy가 기록한 첫 publisher 예비의 시작
`12:31:16.253 UTC`부터 마지막 M3 웹 완료 `12:32:45.706 UTC`까지는
**89.45초**였다. 앞 릴리스의 수동 순차 확인 252.8초보다 약 163.35초,
64.6% 짧았다. 이전과 이번의 앱별 배포 시간은 모두 약 1초 내외이므로
차이는 역할별 상태를 사람이 읽고 다음 앱을 시작하던 대기가 자동화된 데서
나왔다. 이 측정은 한 번의 릴리스이며 장기 평균이나 무중단 보장은 아니다.

## 이미지와 실제 상태

| 용도 | main SHA의 arm64 digest | 앱 수 |
|---|---|---:|
| worker | `ghcr.io/jrvector9/nomorevibe-worker@sha256:89e32f9fb18179424310a96aaf23867507ac936327aaaf7f41451f28db8cb19f` | 6 |
| web | `ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:3c5b760860b53265c4db2fbe316f584260c6b7c10b4bc23d6913dc8a5ccdbe65` | 2 |

publisher→reviewer→crawler의 각 mini 예비→M3 주, mini 웹→M3 웹 순서로
교체했다. 각 앱의 새 Dokploy deployment ID·`done`, Swarm 1/1, 실행 컨테이너의
digest·`RELEASE_TAG`·health가 일치했다. 세 역할 쌍마다
`check-failover-readiness.ts`의 전체 `ok`·해당 역할 `ready`와
`check-worker-progress.ts`의 `ok`를 확인한 뒤 다음 역할로 넘어갔다.
웹 두 컨테이너의 직접 `/api/health`와 공개 로드밸런서의 M3·mini 응답은
`status:ok`, `db:ok`, 새 release였다. 배포 뒤 별도 읽기 전용 조회로 8개
앱의 실행 상태, 전체 failover·진행 상태, 공개 웹 두 인스턴스를 다시 확인했다.
웹 GHCR 패키지는 `private`였다. DB 서버·스트리밍·migration은 변경하지 않았다.

## 오류 중단과 남은 항목

배포 전에 앱 설정 원문을 `/private/tmp/nomorevibe-release-5d67b23.json`에
권한 0600으로 저장했다. 여기에는 비밀값이 있으므로 보고서에 내용을 남기지
않는다. 게이트 실패 시 뒤 앱 배포를 중지하고 `restore --snapshot ... --app ...`로
해당 앱의 이전 digest/env를 복구한다. 이번 실제 실행에는 게이트 실패나 복구가
없었다. 따라서 장애 중 자동 중단과 실제 복구는 테스트로 확인했으며 운영
장애 주입으로 검증하지 않았다.

로컬 Python 표준 라이브러리 안전 검사 8개, `py_compile`, `actionlint`,
`git diff --check`가 통과했다. PR #238 최신 CI의 quality·통합 3분할·필수
`check`·GitGuardian, main의 quality·통합 3분할·필수 `check`·두 이미지 빌드가
성공했다. 웹 이미지 빌드 키 회전은 자동 도구의 대상이 아니며 기존 수동
절차를 따른다. GHCR pull 계정 토큰의 최소 권한 교체, 24시간 처리·헬스 관측,
외부 감시/실제 장애 주입은 [PENDING.md](../../PENDING.md)에 남는다.
