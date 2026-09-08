# 독립 워커 운영 절차

이 문서는 로컬 Compose의 실제 실행 명령과 운영 전환 시 지켜야 하는 순서를 정리한다.
현재 대상 운영 서버·도메인·외부 DB는 별도로 확인해야 하며 이 파일이 실제 배포 완료 증거는 아니다.
A/B 통합 검증 기록은 `docs/CODEX_HANDOFF.md`와 해당 릴리스 보고서를 따른다.

## 구성과 실행 계약

- 웹 `runner` target, 수집·리뷰·발행·집계·스케줄러는 동일한 `worker` target을 사용한다.
- `node --import tsx scripts/worker-supervisor.ts --role=crawler`가 상시 실행 명령이다.
  다른 역할은 `scheduler`, `reviewer`, `publisher`, `maintenance`다. 역할당 활성 프로세스는 1개다.
- 워커는 DB 요청만 소비한다. 스케줄러는 10초마다 주기가 도래한 요청을 기록한다.
  웹/어드민 종료와 무관하게 동작하며 스케줄러 중단 시 이미 접수한 요청까지만 처리한다.
- `npm run worker -- --role=crawler --once`, `npm run scheduler -- --once`는 제한된 한 회차다.
  큐 전체를 소진하거나 24시간 운영을 검증하는 명령이 아니다. 직접 실행에는 환경변수를 별도로 주입한다.
- 로컬 `npm run job <name>`은 `.env.local`을 읽고 명시적 요청을 남긴 뒤 한 tick을 실행한다.
  잠금/쿼터 대기가 있으면 요청은 남는다. 컨테이너는 `.env.local` 없이 주입된 환경을 사용한다.
  예: `docker compose exec crawler node --import tsx scripts/run-job.ts crawl-fetch`.
- `scripts/evidence-worker.ts`는 이전 로컬 사용을 위한 두 evidence 잡 전용 접수/실행 wrapper다.
  새 `crawler`와 함께 상시 배포하지 않는다. `scripts/scheduler.sh`는 HTTP 없이 새 DB 스케줄러를 exec한다.
- 이미지에는 `tsx`가 production 의존성으로 포함된다. `lib`, `scripts`, `drizzle`, `tsconfig.json`도 포함한다.
  CLI는 worker 이미지에만 설치하며 기본 고정 버전은 로컬에서 확인한 `2.1.263`이다.
  버전을 바꾸면 `CLAUDE_CODE_VERSION` build arg를 명시하고 이미지 내부 호출/timeout을 다시 검증한다.
- 기존 카테고리 분류의 Claude CLI/키워드 폴백을 보존한다. 신규 AI 리뷰 모델 `CRAWL_REVIEW_MODEL`은
  기본값이 없으며 승인된 모델·인증·관측 결과를 확인한 뒤 심사 정책에 맞춰 켠다.
- `ranking-refresh`는 정기 스케줄이 없다. `click-rollup`의 done=true 성공 완료 트랜잭션이 요청한다.
  예전 매시 5분 HTTP 스케줄은 제거한다. `heartbeat`는 scheduler 생존 관측 전용으로 HTTP 예약은 400을 반환한다. cron API의 HTTP 202는 접수 결과이며 완료 확인은 `/admin/status`에서 한다.

## 로컬 Compose 최초 실행과 릴리스

이 저장소의 `compose.yml`은 외부에 노출할 운영용 기본 자격 증명을 제공하지 않는다.
로컬 DB 사용자/비밀번호는 이전 값을 보존하고 DB 포트 `55437`, 웹 포트 `3200`,
볼륨 `deploy-pgdata`도 보존한다. 운영에서는 외부 DB/비밀 저장소/도메인/프록시 설정을 따로 적용한다.
기존 사용자 미커밋 Compose·로컬 관리자 로그인 변경은 이 워커 브랜치에 자동 복사하지 않았다.

1. `.env`에 최소 `AUTH_SECRET`, `VISITOR_HASH_SECRET`을 각각 32자 이상 별도 값으로 설정한다.
   GitHub 수집 자격 정보와 CLI 토큰은 필요한 워커에만 제공한다. `.env.local`의
   `ALLOW_PRIVATE_URLS`를 배포 환경으로 복사하지 않는다. 파일을 커밋하거나 렌더링된 환경값을 로그로 남기지 않는다.
2. 환경 설정 형식만 확인하고 웹/워커 이미지를 먼저 빌드한다. 운영에서는 빌드를 부하가 없는 환경에서 완료한다.

```sh
docker compose config --quiet
docker compose build app crawler
docker compose up -d db
```

3. DB가 healthy인지 확인하고 기존 HTTP 스케줄러, evidence wrapper, CLI 수집 프로세스와
   이전 역할별 워커를 모두 중지·drain한다. 단순히 새 컨테이너를 추가하지 않는다.
   아래는 현재 Compose 서비스 이름 기준이다. Compose 밖에서 실행 중인 프로세스도 별도로 종료 확인한다.

```sh
docker compose stop scheduler crawler reviewer publisher maintenance app
docker compose ps -a
```

4. 마이그레이션을 릴리스당 한 번 실행한다. 명령의 종료 코드가 0인지 확인해야 다음 단계로 간다.
   기존 `scripts/migrate.mjs`를 사용하며 실패하면 앱/워커를 시작하지 않는다.

```sh
docker compose up --no-deps --force-recreate --abort-on-container-exit --exit-code-from migrate migrate
```

5. 준비된 이미지로 새 역할을 시작한다. `--no-deps`는 방금 성공한 마이그레이션을 다시 실행하지 않는다.
   app/worker entrypoint에는 마이그레이션을 넣지 않는다.

```sh
docker compose up -d --no-deps --no-build app scheduler crawler reviewer publisher maintenance
docker compose ps
docker compose logs --since=5m scheduler crawler reviewer publisher maintenance
```

역할 모두 DB와 성공한 migration에만 의존한다. 웹 healthcheck는 사용자 요청 준비 상태를 확인하며
워커 시작 조건으로 사용하지 않는다. 배포 서버에서는 이 순서를 릴리스 작업으로 한 번 수행한다.
동일 role 복제본 자동 확대와 무중단 rolling 교체는 A의 지원 범위가 아니다.

## Claude 인증과 AI 리뷰 모드 전환

카테고리는 `claude-sonnet-5`·effort high·15초 제한을 사용한다. 리뷰는 별도 `CRAWL_REVIEW_MODEL`·
effort low·20초 제한으로 한 tick에 AI 호출 최대 1개다. 모델 기본값은 없으며 카테고리 모델을
리뷰 모델로 자동 채택하지 않는다. 도구를 끄고 구조화 출력을 다시 검증한다.

CLI `2.1.263`에서는 `--safe-mode`로 사용자 설정을 격리하면서 keychain/OAuth 인증을 보존한다.
`--bare`는 OAuth도 건너뛰므로 기존 bare 안내를 사용하지 않는다. 운영에서는 `claude setup-token`으로
발급한 장기 `CLAUDE_CODE_OAUTH_TOKEN`을 reviewer/publisher에만 주입한다. 로컬 단기 토큰을 사용한
실제 worker 이미지 인증·구조화 응답 smoke는 통과했으나 운영 장기 토큰 설정은 아직 남아 있다.

1. 초기 DB 모드는 `off`로 둔다. B 전체 릴리스가 모든 reviewer/publisher에 적용됐고
   reviewer의 명시한 모델·실제 인증·제한 시간 내 응답을 확인한다.
2. 웹에 `CRAWL_REVIEW_READY=true`를 주입해 재시작한다. 이 플래그는 변경 준비 조건이며
   저장된 DB 모드를 바꾸지 않는다. reviewer에는 `CRAWL_REVIEW_MODEL`과 인증을 별도로 주입한다.
3. `/admin/review`에서 변경 사유를 입력하고 `observe`로 전환한다. 관측 모드는 심사 이력만
   남기고 후보 상태나 기존 발행 조건을 바꾸지 않는다. 실제 표본의 기대 판정과 결과를 비교한다.
4. 검토 후 같은 화면에서 사유와 함께 `enforce`로 전환한다. 현재 입력·정책·근거에 유효한 승인과
   발행 시점 검사를 통과해야 자동 발행된다. 오래된 화면의 모드 변경은 거절되므로 새로고침한다.

`off`는 AI 발행 보호 해제다. 리뷰 장애 때 조용히 off로 낮추지 말고 enforce를 유지한 채 자동 발행을
보류하고 reviewer를 복구한다. 정책 복귀는 별도 명시적 사유와 감사 기록을 남긴다. 일반 설정 저장과
초기화는 현재 리뷰 모드를 보존한다. 기존 `agentEvidence.enforceEligibility`는 별도 근거 정책이다.
개발 근거 부족은 규칙 단계에서 needs_review로 보류하며, AI 오류도 자동 부적격 판정으로 바꾸지 않는다.

## 자원·비밀값

다음은 초기 시험 예산이다. 최소 사양이나 사용량 보장이 아니며 실제 RSS/DB 연결/응답 지연을 기록해야 한다.

| 역할 | pool 상한 | RAM 상한 | CPU 상한 | 제공하는 외부 자격 정보 |
|---|---:|---:|---:|---|
| 웹 | 8 | 1536 MiB | 2 | OAuth·세션·방문자 키·관리자/cron 접수 토큰 |
| 크롤러 | 4 | 1536 MiB | 1 | GitHub token |
| 리뷰 | 3 | 2 GiB | 1 | 리뷰용 Claude CLI token |
| 발행 | 3 | 1536 MiB | 1 | 분류용 Claude CLI token |
| 집계 | 3 | 1 GiB | 1 | 없음 |
| 스케줄러 | 2 | 256 MiB | 0.25 | 없음 |
| 로컬 DB | 별도 | 4 GiB | 2 | 로컬 DB 계정 |

앱 pool 상한 합계는 23이며 migration/관리/다른 앱/교체 중 연결을 추가 계산한다. 웹 복제본을 하나
더 띄우면 31이다. RAM은 앱 7.75 GiB + DB 4 GiB에 OS·파일 캐시 여유가 필요하다.
CPU 상한은 예약량이 아니므로 모든 역할의 동시 peak를 보장하지 않는다. 8 vCPU/16 GiB 예시는
측정을 시작할 동거형 예산이며 호스트 장애까지 견디는 무중단 구성은 아니다.

로그는 컨테이너당 10 MiB × 3개로 회전한다. 비루트 프로세스, `no-new-privileges`, capability 제거,
Compose `init: true`를 사용한다. 초기 자원 초과가 보이면 탐색/재수집량과 pool 상한을 함께 조정한다.

## 생존·진행·장애 복구

워커 자식은 IPC로 5초마다 생존 신호를 보내고 현재 잡·시작 시각·최근 진행 시각을 보고한다.
감시기는 아래 초기 상한을 넘으면 워커 leader에 SIGTERM을 보내 먼저 drain한다.
단순 유휴/쿼터 대기 자체는 장애가 아니다.

| 감시 대상 | 초기 상한 | 의미 |
|---|---:|---|
| IPC 생존 신호 없음 | 30초 | 자식 event loop 중단/프로세스 장애 |
| 잡 밖에서 진행 없음 | 90초 | poll/DB 요청/초기화가 끝나지 않음 |
| crawler/reviewer/publisher 잡 | 180초 | 정상 HTTP/CLI 한도를 크게 넘긴 tick |
| scheduler 잡 | 120초 | 스케줄 기록의 장시간 정지 |
| maintenance 잡 | 600초 | 현재 분할 전 집계 작업을 위한 초기 여유 |
| SIGTERM drain | 45초 | 새 잡 중지, 현재 호출·pool 종료 유예 |

25초 `hasBudget`은 협조적 작업 예산이다. 위 강제 감시 상한과 같지 않다. 현재 CLI 분류는 15초,
AI 리뷰와 agent scan은 각각 20초 제한을 사용하지만 전체 tick은 여러 bounded 작업과 DB 처리를 포함한다.
실제 최장 처리 시간을 기록하여 `WORKER_*_SECONDS`와 Compose 서비스 값을 함께 조정한다.
특히 maintenance 600초는 실측 보장이 아니며 병목이 보이면 집계 분할이 필요하다.

45초 안에 종료되지 않으면 별도 프로세스 그룹 전체에 SIGKILL을 보내 CLI 자식도 정리한다.
워커가 먼저 종료해도 남은 그룹을 정리하고 최대 5초 동안 소멸을 확인한다. 정리가 끝나지 않으면
실패 로그를 남겨 supervisor가 비정상 종료하며 컨테이너 종료가 남은 프로세스를 정리한다.
Compose 종료 유예는 60초다. drain 45초와 그룹 정리 최대 5초를 포함하도록 함께 조정한다.
`restart: unless-stopped`가 컨테이너를 재시작한다. `unhealthy` 표시만으로 재시작되는 구조가 아니다.
healthcheck는 로컬 JSON만 읽으며 DB·웹·AI를 호출하지 않는다. 한 호스트/파일시스템 장애 복구는 별도다.

DB 작업 잠금은 15초마다 갱신되고 기존 stale 유예는 10분이다. 강제 종료 직후에는 남은 잠금으로
잠시 건너뛸 수 있다. 임의로 잠금/token을 지우지 말고 기존 프로세스 종료 및 stale 회수를 확인한다.
이 상한 때문에 장애 복구를 항상 2분 이하라고 보고하지 않는다.

DB 드라이버는 `postgres` 3.4.9로 고정했다. `lib/db/pool.ts`는 대기 중인 정확한 요청을 취소하기 위해
해당 버전의 내부 연결 경계를 사용한다. 업그레이드 시 단순 타입 검사만으로 호환성을 판단하지 말고
`tests/integration/db-pool-budget.test.ts`를 전용 DB에서 실행해 만료된 쓰기/BEGIN 미실행,
정상 BEGIN 복구, statement 제한, pipeline 대기, 연결 회전과 트랜잭션 복구를 확인한다.

## 통합 완료 시 남길 증거

아래는 수행할 체크포인트이며 이 문서 작성 시 통과한 것으로 간주하지 않는다.
2026-09-08 웹 없이 5역할을 1,800.307초 관측했다(31표본 모두 healthy, 재시작0, DB연결 최대5).
외부 수집 비활성·빈 DB 조건의 독립 실행 검증이며 24시간 운영 관측은 미수행이다.
운영 서버·도메인이 미확정이므로 생산 배포 완료를 뜻하지 않는다. 완료한 항목은 릴리스 보고서의
실제 환경·명령·시각과 함께 구분한다.

- 웹 30분 중지 중 scheduler 요청과 각 워커 tick/cursor 진행. 수집 설정과 외부 자격 정보가 활성인지 함께 기록.
- scheduler 중지 시 새 정기 요청 중단, 이미 접수한 tick 처리, 재시작 후 예정 시각 재개.
- 정상 SIGTERM drain, event-loop hang, Promise 정지, CLI 자식 잔존, supervisor 비정상 종료 및 Compose 재시작.
- shared GitHub cooldown, pool 포화 시 유한 실패 및 취소된 대기 작업이 나중에 실행되지 않는지 실제 DB로 확인.
- worker 이미지의 `tsx`, 경로 alias, Claude CLI 버전/실제 인증/timeout 확인. 웹 이미지에서 collector 실행 경로 제거 확인.
- B 통합 후 실제 후보 10개의 기대 판정 비교, observe/enforce 구분, 오래된 승인/관리자 결정 충돌 검사,
  24시간 운영 관측. 외부 AI 오류는 자동 탈락으로 바꾸지 않는다.

DB를 비우는 통합 테스트는 전용 시험 DB에만 직렬 실행한다. 운영 DB를 시험 DB URL에 넣지 않는다.

## 부하 측정과 롤백

부하 측정은 로컬의 격리된 URL을 명시해야 한다. 공개 외부 URL과 `/api/`, 방문 추적 `/go/` 요청은 받지 않고
GET·loopback origin·최대 20 RPS·120초·동시 10개로 제한한다. 리다이렉트를 따라가지 않는다.
측정 전에 해당 페이지가 외부 제공자를 직접 호출하지 않는지 확인하고 crawler를 정지하거나 fixture를 사용한다.

```sh
node --import tsx scripts/measure-worker-capacity.ts --origin=http://127.0.0.1:3200 --paths=/ --rps=2 --duration-seconds=60 --max-inflight=4
```

출력 JSON에는 실제 달성 RPS, HTTP 계열/429/네트워크 오류, p50/p95/p99, 건너뛴 슬롯·최대 동시 요청이 있다.
실제 페이지 경로를 확인해 지정한다. `/ranking`은 현재 존재하지 않는 경로이므로 예제로 사용하지 않는다.
측정은 헤더 도착부터 끝내지 않고 최대 2 MiB 응답 본문을 읽은 완료 시간까지 포함한다. 본문 내용은
저장하지 않는다. 측정 전후 CPU/RSS/DB 대기와 함께 보관하고 병목이 확인된 항목만 개선한다.

2026-09-08 격리 DB의 제품 1,000개·클릭 원천 100,000개로 수행한 로컬 HTML 응답 시험:
실제 `click-rollup`·`ranking-refresh`가 각각 110ms에 완료되어 `2026-W37`의 순위 1,000개를 만든 뒤,
최신 웹 이미지로 최신 목록·주간 순위 경로를 측정했다. 20 RPS × 120초, 2,400/2,400 HTTP 2xx,
p50 22.7ms·p95 33.6ms·p99 39.3ms, skipped 0, 최대 동시 요청 2였다.
최신 목록 HTML 321,355 bytes·주간 순위 HTML 71,499 bytes에서 시험 제품이 표시되고 빈 랭킹·Next 오류가
없음을 확인했다. 측정 중 앱 오류 로그는 0건이었다. 원본은 해당 시험 호스트의
`/tmp/nomorevibe-workers-acceptance/capacity-ranking-20rps.json`에 있으며 영구 보고서에 결과를 보관한다.
Docker VM은 4 CPU·7.737 GiB, 웹 컨테이너 상한은 2 CPU·1.5 GiB였다. 모든 워커가 실제 작업으로
동시에 부하를 받은 시험이 아니며, 동시 사용자 수·최대 처리량·최소 서버 사양으로 환산하지 않는다.

롤백할 때도 새 소비자를 먼저 stop/drain하고 이전 **요청 버전/소유권 호환 릴리스** 이미지를 시작한다.
가산 DB 컬럼·cursor·pending force 요청·심사 이력은 보존한다. 볼륨 삭제와 down --volumes를 사용하지 않는다.
B 심사 장애는 신규 자동 발행을 보류하며 조용히 AI 심사를 끄고 우회하지 않는다. 정책 rollback은 별도 명시한다.
