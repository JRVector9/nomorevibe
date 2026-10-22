# 독립 워커 운영 절차

이 문서는 로컬 Compose의 실제 실행 명령과 운영 전환 시 지켜야 하는 순서를 정리한다.
운영은 M3 다섯 역할·scheduler 2복제본, mini의 다섯 역할 예비와 M3·mini 웹 2개가 외부 `nomorevibe` DB를 공유한다. 이 파일 자체는
실제 배포 완료 증거가 아니며 완료 여부는 Dokploy 상태·DB 결과·health 응답으로 확인한다.
A/B 통합 검증 기록은 `docs/CODEX_HANDOFF.md`와 해당 릴리스 보고서를 따른다.

## 구성과 실행 계약

- 웹 `runner` target, 수집·리뷰·발행·집계·스케줄러는 동일한 `worker` target을 사용한다.
- 로컬 Compose는 `node --import tsx scripts/worker-supervisor.ts --role=crawler`를 사용한다.
  운영 Dokploy의 다섯 역할은 `scripts/role-worker.ts --role=<role> --kind=primary|standby`를
  실행하며, scheduler는 `worker-supervisor.ts --role=scheduler` 2복제본이다.
  역할당 활성 프로세스는 1개다.
- 워커는 DB 요청만 소비한다. 스케줄러는 10초마다 주기가 도래한 요청을 기록한다.
  웹/어드민 종료와 무관하게 동작하며 스케줄러 중단 시 이미 접수한 요청까지만 처리한다.
- 일반 잡은 25초 협력 예산을 유지하고, publisher는 최대 20초 모델 폴백 뒤 10건 발행을 마치도록
  120초 협력 예산을 쓴다. supervisor의 publisher hard timeout은 180초다.
- 공개 근거 `product-evidence-refresh`는 crawler의 `sources` lane에서 55초 예산으로 실행한다.
  제품 내부의 부분 수집을 재개하되 다음 제품 순회를 막지 않는다. 다른 crawler lane과 같은 역할
  lease·DB pool·GitHub 계정별 쿼터를 사용하므로 앱을 추가해 처리량을 늘리는 설정은 아니다.
  AI1 worker 예산은 Grok의 90초 호출을 수용하도록 110초이며, 현재 abcllm/Claude handler의
  내부 틱 예산은 40초다. provider 설정이 바뀌면 현재 입력과 동일 provider/model의 심사만 유효하다.
- `crawl-seed`는 실제 새 후보와 실행 가능한 후속 대기량으로 유입을 제한한다. 제한 중에도 최소
  탐색과 cursor를 보존한다. 사람 보류·정책 중단·미래 backoff를 실행 대기와 합산하지 않는다.
  초기 기준·하한 집계의 제약·배포 후 재측정은
  [수집→검수 개선 구현 보고서](2026-10-14-pipeline-recovery-implementation.md)를 따른다.
- `npm run worker -- --role=crawler --once`, `npm run scheduler -- --once`는 제한된 한 회차다.
  큐 전체를 소진하거나 24시간 운영을 검증하는 명령이 아니다. 직접 실행에는 환경변수를 별도로 주입한다.
- 로컬 `npm run job <name>`은 `.env.local`을 읽고 명시적 요청을 남긴 뒤 한 tick을 실행한다.
  잠금/쿼터 대기가 있으면 요청은 남는다. 컨테이너는 `.env.local` 없이 주입된 환경을 사용한다.
  예: `docker compose exec crawler node --import tsx scripts/run-job.ts crawl-fetch`.
- `scripts/evidence-worker.ts`는 이전 로컬 사용을 위한 두 evidence 잡 전용 접수/실행 wrapper다.
  새 `crawler`와 함께 상시 배포하지 않는다. `scripts/scheduler.sh`는 HTTP 없이 새 DB 스케줄러를 exec한다.
- 이미지에는 `tsx`가 production 의존성으로 포함된다. `lib`, `scripts`, `drizzle`, `tsconfig.json`도 포함한다.
  CLI는 worker 이미지에만 설치하며 Codex `0.153.4`, Claude Code `2.1.263`을 고정한다. 버전을 바꾸면
  `CODEX_CLI_VERSION` 또는 `CLAUDE_CODE_VERSION` build arg를 명시하고 이미지 내부 호출/timeout을 다시 검증한다.
- 카테고리는 Codex CLI 2단계와 키워드 폴백을 사용한다. 신규 AI 리뷰 모델 `CRAWL_REVIEW_MODEL`은
  별도 Claude CLI 경로이며 기본값이 없다. 승인된 모델·인증·관측 결과를 확인한 뒤 심사 정책에 맞춰 켠다.
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
docker compose stop scheduler crawler reviewer publisher text maintenance app
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
docker compose up -d --no-deps --no-build app scheduler crawler reviewer publisher text maintenance
docker compose ps
docker compose logs --since=5m scheduler crawler reviewer publisher text maintenance
```

역할 모두 DB와 성공한 migration에만 의존한다. 웹 healthcheck는 사용자 요청 준비 상태를 확인하며
워커 시작 조건으로 사용하지 않는다. 배포 서버에서는 이 순서를 릴리스 작업으로 한 번 수행한다.
동일 role 복제본 자동 확대와 무중단 rolling 교체는 A의 지원 범위가 아니다.

## 운영 M3·mini 배포와 데이터 컷오버

### 공통 이미지 릴리스

코드 변경이 main에 들어간 뒤 CI의 필수 `check`가 성공하면 GHCR에
비공개 `ghcr.io/jrvector9/nomorevibe-runtime-web:<SHA>`와
`ghcr.io/jrvector9/nomorevibe-worker:<SHA>`가 각각 한 번 생성된다.
두 이미지의 Actions 작업이 성공하고 OCI `revision`이 같은 SHA인지 확인한다.
M3와 mini 모두 arm64다. 웹 빌드는 두 앱이 공유하는 Actions secret
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`와 `NEXT_DEPLOYMENT_ID=<SHA>`를 사용한다.
비밀값은 보고서·셸 로그·Git에 남기지 않는다. Next 서버 참조 manifest에는 빌드 키가
들어가므로 웹 패키지는 GHCR에서 `private`임을 확인한 뒤 빌드한다. 웹 이미지
푸시는 `GHCR_PUSH_TOKEN`을 사용하고 공개 저장소와 연결되는 source label을 붙이지 않는다.

배포 전에 두 이미지의 SHA 태그를 registry의 `sha256:` digest로 풀고,
**각 서버에서** 해당 digest를 실제로 pull할 수 있는지 확인한다. Dokploy의
registry 연결 시험만으로 GHCR 로그인 성공을 판단하지 않는다. 웹은 Docker provider에
유효한 pull 자격 정보를 직접 설정하고 실제 private digest pull을 확인한다. worker
패키지는 공개이므로 pull 자격 정보가 필요 없다. Dokploy 앱 8개의 현재
source, 이미지/커밋, `RELEASE_TAG`, 환경·build 설정과 배포 상태를 안전한 위치에
백업한다. DB migration이 필요한 릴리스는 기존 절차대로 소비자를 drain한 뒤
한 번 실행하고 종료 코드 0을 확인한다.

역할별 주·예비는 같은 worker digest와 `RELEASE_TAG=<SHA>`로 교체한다.
mini 예비를 먼저 배포해 healthy standby를 확인하고 M3 주를 배포해 active와
동일 릴리스를 확인한다. publisher → reviewer → crawler 순서로 역할 하나씩
끝낸다. 그다음 mini 웹, M3 웹을 같은 web digest로 배포하고 각각 `/api/health`와
공개 로드밸런서 응답을 확인한다. Dokploy의 `done`만으로 완료를 판단하지 않고
실제 실행 중 컨테이너의 image digest, release, 다섯 역할의 readiness/progress를
대조한다. 문제가 있으면 뒤의 앱을 전환하지 않고 해당 역할의 이전 이미지와
source/env 설정으로 되돌린다. DB 서버·스트리밍 설정은 이 작업에서 바꾸지 않는다.
웹 빌드 키를 회전하는 릴리스라면 두 웹의 build secret과 runtime env를 같은 새
키로 갱신하고 두 웹의 직접 health를 확인한다. 전환 중 두 웹의 키가 다른 짧은
구간은 서버 액션 요청에 영향을 줄 수 있으므로 연속 배포한다.

문서만 바뀐 main push에는 새 이미지를 만들지 않는다. 수동 Actions 실행은
전체 검증과 이미지 빌드를 수행한다.

### 공통 이미지 배포 자동 확인

`scripts/ops/deploy_shared_images.py`는 **main SHA를 checkout한 운영자 Mac**에서
실행한다. GitHub CLI는 `JRVector9` 계정으로 로그인하고, Dokploy API 키는
macOS Keychain의 `deploy.brut.bot`/`dokploy-api-key`에 있어야 한다. 두 서버에
root SSH로 접근할 수 있어야 한다. 명령 인자의 이미지 주소는 main Actions가
출력한 SHA 태그의 `sha256:` digest를 사용한다. DB migration이 포함된 릴리스라면
기존 절차로 한 번 적용·검증한 뒤에만 `--migration-verified`를 추가한다.
웹 서버 액션 키를 바꾸는 릴리스는 자동화 대상에서 제외하고 위의 두 웹
build/runtime 키 교체 절차를 따른다.

```sh
python3 scripts/ops/deploy_shared_images.py plan \
  --sha "$RELEASE_SHA" --worker-image "$WORKER_IMAGE" --web-image "$WEB_IMAGE"
python3 scripts/ops/deploy_shared_images.py run \
  --sha "$RELEASE_SHA" --worker-image "$WORKER_IMAGE" --web-image "$WEB_IMAGE" \
  --snapshot "/private/tmp/nomorevibe-release-${RELEASE_SHA:0:7}.json"
```

`plan`은 8개 앱의 현재 동일 릴리스·실제 컨테이너 이미지·건강 상태, 두 웹의
build/runtime 키 일치, 기존 failover·진행 상태, 새 이미지의 양 서버 실제
pull/arm64/OCI revision과 비공개 웹 이미지 안의 빌드 키 일치를 값 노출 없이
확인한다. 앱 설정은 변경하지 않는다. `run`은 같은
사전 검사 뒤 기존 설정을 권한 0600 스냅샷에 저장하고 publisher→reviewer→crawler
각각 mini 예비→M3 주, 마지막으로 mini→M3 웹을 배포한다. 각 앱마다 새 Dokploy
deployment ID와 `done`, Swarm 1/1, 실행 컨테이너 digest·release·health를
기다린다. 역할 쌍 뒤에는 그 역할이 M3 주가 쥔 `ready`이고 다른 역할은 유효한 소유자(`ready` 또는
`standby_active`)이며 scheduler 두 복제본·`check-worker-progress.ts`가 `ok`인지 확인한다(아래 "관문의 소유자 판정").
웹 둘 뒤에는 공개
`/api/health`에서 두 인스턴스의 같은 릴리스를 확인한다. 실패하면 뒤 앱 배포를
멈추고 스냅샷 경로만 출력한다. 스냅샷에는 환경 비밀값이 있어 공유하거나 Git에
넣지 않는다.

멈춘 뒤에는 원인을 고치고 **같은 목표로 이어 가기**(`run --resume`, 아래)를 먼저 쓴다. 목표 릴리스 자체를 포기할 때만
스냅샷에서 **앱 하나씩** 복구한다. 역할 쌍은 예비(mini) → 주(M3) 순으로 되돌린다. 역할 쌍의 한쪽만
복구한 경우 다른 쪽도 이전 릴리스로 맞추고 failover 상태를 다시 확인한다.

```sh
python3 scripts/ops/deploy_shared_images.py restore \
  --snapshot "/private/tmp/nomorevibe-release-${RELEASE_SHA:0:7}.json" \
  --app publisher-mini
```

`restore`는 그 앱의 실제 실행이 이미 이전 릴리스이고 Swarm update가 진행 중이 아니면(예: Swarm이 새 태스크를 되돌렸다)
Dokploy 설정만 이전 값으로 되돌리고 **다시 배포하지 않는다**(`"restored": "configuration_only"`). 같은 릴리스로 주를
재시작하면 같은 릴리스의 예비가 lease를 가져가기 때문이다(아래 #597).

#### Swarm 되돌림·멈춘 배포 이어 가기·관문의 소유자 판정 (2026-10-22, #597 배포)

#597(515b8a10) 공통 배포에서 세 가지가 이어서 일어났다. 원인과 도구의 대응은 다음과 같다.

1. **Swarm 되돌림을 시간 초과로만 봤다.** crawler-m3의 새 태스크가 `No such container`로 실패해 Swarm이 옛 spec(이전 이미지)으로
   되돌렸는데 Dokploy는 `done`이었다. 도구는 실행 이미지가 끝내 목표와 같아지지 않아 4분 뒤 `crawler-m3_verification_timeout`으로만
   멈췄다(같은 일이 10-17 maintenance·scheduler에도 있었고 같은 SHA 재배포로 풀렸다).
   → 이제 Dokploy `done` 뒤 실행이 준비가 아니면 원격 확인이 Swarm `UpdateStatus`와 최근 태스크 오류(걸러 160자)를 함께 읽는다.
   `rollback_started`·`rollback_completed`면 되돌리기가 끝나기를 기다렸다가(최대 180초) **같은 설정으로 한 번만** 다시 배포하고
   (`{"app": …, "swarmRollback": …, "taskErrors": […], "action": "redeploy_once"}`), 또 되돌리면
   `<app>_swarm_rollback_repeated:task_error=…`로 멈춘다. `paused`·`rollback_paused`는 다시 배포하지 않고 바로 멈춘다.
   시간 초과도 마지막 태스크 오류를 붙인다(`<app>_verification_timeout:task_error=…`).
2. **섞인 릴리스에서 다시 시작할 수 없었다.** 재시도가 `web-mini_baseline_release_mismatch`로 거절돼 바뀐 워커 여섯 개를 스냅샷에서 손으로
   되돌린 뒤 처음부터 다시 배포했다.
   → `plan`/`run --resume --snapshot <멈춘 run 의 스냅샷>`은 **같은 목표**(SHA·두 이미지)로 멈춘 run을 이어 간다. 새 스냅샷은 만들지 않는다
   (되돌릴 이전 설정은 그 스냅샷에 있다). 앱마다 Dokploy 설정이 스냅샷의 이전 설정 그대로이거나, 그 설정에서 `run`이 바꾸는
   것(`RELEASE_TAG`·웹의 `NEXT_DEPLOYMENT_ID` 줄과 이미지)만 목표로 바뀐 설정이어야 한다. 그 밖의 차이(다른 env 줄·다른 이미지·
   복제본 수·명령)는 `<app>_unexplained_drift`로 어느 앱에도 쓰지 않고 멈춘다. 목표 설정인 앱은 실제 실행으로 나눈다:
   새 릴리스로 healthy면 건너뛰고(`"resume": "already_target"`), 실행이 아직 이전 릴리스면(Swarm 되돌림) Swarm이 안정된 뒤
   같은 설정으로 다시 배포한다(`"resume": "redeployed"`). 둘 다 아니면 `<app>_resume_runtime_unknown`으로 멈춘다. 사전 감시 관문은
   쌍의 한쪽만 새 릴리스로 실행 중인 역할의 `release_mismatch`를 받는다. 계획 줄의 `resume`이 앱별 상태다.

   ```sh
   python3 scripts/ops/deploy_shared_images.py run --resume \
     --sha "$RELEASE_SHA" --worker-image "$WORKER_IMAGE" --web-image "$WEB_IMAGE" \
     --snapshot "<멈춘 run 이 출력한 snapshot 경로>" --migration-verified
   ```
3. **예비가 쥔 lease 때문에 관문이 끝나지 않았다.** 복구에서 crawler-mini(예비)를 먼저 a9ad31da로 되돌렸는데, crawler-m3(주)는 Swarm
   되돌림으로 이미 a9ad31da로 돌고 있었다. 이어서 crawler-m3를 같은 릴리스로 다시 배포(재시작)하자 주가 lease를 정상 반납했고, 반납한
   lease의 릴리스와 같은 릴리스의 예비가 유예 없이 넘겨받았다(`lib/jobs/role-leader.ts` — 20초 유예는 owner 가 남은 만료에만 있다).
   예비는 스스로 놓지 않고 주는 lease가 살아 있는 동안 기다리기만 하므로 `standby_active`가 계속됐고, 관문은 모든 역할의 `ready`를
   요구해 `crawler_monitor_gate_timeout`으로 멈췄다. 예비를 scale 0으로 내리면 `standby_missing`이라 관문은 여전히 통과하지 않고(관문은
   주·예비 두 후보의 최근 관측을 요구한다), 주가 lease를 되찾은 뒤(epoch 148) 예비를 1로 올려야 통과했다. 정상 배포(#602)는 예비가 먼저
   새 릴리스가 되어 옛 주가 반납한 lease와 릴리스가 달라 넘겨받지 않으므로 문제가 없었다.
   → **관문의 소유자 판정**: 방금 쌍을 올린 역할은 여전히 M3 주가 쥔 `ready`여야 한다 — 새 릴리스의 M3 주가 역할을 실제로 쥘 수
   있음을 보는 관문이기 때문이다. 그 역할을 예비가 쥐고 있으면(`standby_active`) 주가 되찾을 때까지 한 번 180초 더 기다린다
   (`{"handoff": "waiting_for_primary"}` 줄). 다른 역할은 유효한 소유자(`ready` 또는 `standby_active`) 어느 쪽이든 받는다. 배포 전 사전
   관문은 모든 역할에서 유효한 소유자를 받는다 — 예비가 쥔 역할은 예비를 먼저 올리는 배포에서 주가 되찾는다. `primary_quarantined`·
   `lease_expired`·`owner_mismatch`·`standby_missing`·`primary_missing`·`release_mismatch`, scheduler `replica_missing`, 진행 경보는 예전처럼
   막는다. 시간이 넘으면 받지 못한 사유를 붙인다(`crawler_monitor_gate_timeout:crawler=standby_active`). 통과 줄·계획 줄의
   `standbyActive`는 예비가 일하는 역할이다.

**예비 scale 0으로 lease를 돌리지 않는다.** 예비가 역할을 쥐고 있어도 다음 공통 배포(또는 `run --resume`)는 사전 관문을 지나고, 예비를
**새 릴리스로** 먼저 올리는 단계에서 예비가 반납한 lease(이전 릴리스)를 새 예비는 넘겨받지 못하므로 기다리던 주가 되찾는다.
같은 릴리스로 예비만 재시작하면(Dokploy 재배포) 반납 순간 새 예비와 주가 다시 겨루므로 돌려준다는 보장이 없다(#597 복구의
`return-crawler-primary` 재시작이 그랬다).

이 도구는 릴리스 사이에 운영자가 기다리던 상태 확인을 자동화한다. 다음 실제
릴리스에서 첫 앱 시작부터 마지막 앱 완료까지의 시간을 기록해 전체 소요시간
개선 여부를 따로 판정한다.

#### 시각·소요 시간, 동시 pre-pull, `prepull` (2026-10-22)

- **진행 줄**: `plan`·`run`·`prepull`·`restore`가 내는 줄은 모두 JSON이고 맨 앞 `at`에 UTC 시각(초)이 있다.
  앱 줄과 관문 줄에는 걸린 `seconds`가 붙는다. `plan`/`run`의 계획 줄 `preflight`는 사전 검사의
  `baseline`·`gate:crawler`·`prePull` 시간과 전체 초다. `run`의 마지막 줄 `summary`는 앱·관문별
  `durations`와 `totalSeconds`, `mode`다. 멈춘 경우에도 그때까지의 `summary`를 남기고, `stopped` 줄의
  `touched`는 설정을 바꿨을 수 있는 앱(스냅샷에서 되돌릴 후보)이다.
- **pre-pull**: 새 두 이미지를 mini와 M3에서 **동시에** 받는다(예전에는 mini 다음 M3). 검사는 같다
  (arm64·OCI revision·비공개 웹 이미지 안의 빌드 키). 한 서버가 실패해도 다른 서버를 끝까지 기다려 두 결과를 남긴 뒤 멈춘다.
- **`prepull`**: main CI의 `publish-worker-image`·`publish-web-image`가 끝나는 대로 같은 pre-pull만 먼저 한다.
  GitHub 계정·main SHA·웹 패키지 비공개를 확인하고, Dokploy는 두 웹의 빌드 키만 **읽는다**(앱 설정·배포는 바꾸지 않는다).
  Git checkout 확인과 baseline은 하지 않는다. `run`은 pre-pull을 그대로 다시 하므로(이미 받은 층은 내려받지 않는다)
  관문이 줄지 않고, `run`의 사전 검사(baseline 등 수십 초)와 겹쳐 돌리면 받기 시간이 그만큼 앞당겨진다.

  ```sh
  python3 scripts/ops/deploy_shared_images.py prepull \
    --sha "$RELEASE_SHA" --worker-image "$WORKER_IMAGE" --web-image "$WEB_IMAGE"
  ```
- **확인 간격**: 앱 배포 확인 2초(예전 5초 — 한 번에 Dokploy 읽기 두 번이고, SSH 상태 확인은 Dokploy가 `done`을 낸 뒤에만 한다),
  감시 관문 3초(예전 5초 — 한 번에 컨테이너 안에서 tsx 확인 둘을 띄운다). 공개 health 관문은 그대로다.

#### `--parallel-roles` (선택, 기본은 순차)

기본(순차)은 위와 같다: publisher → reviewer → crawler 역할마다 mini 예비 → M3 주 → (`--consumer`로 고른 소비자 앱)
→ 그 역할의 감시 관문. `--parallel-roles`를 `plan`/`run`에 주면 순서가 다음처럼 바뀐다. `plan`은 바뀐 순서를
계획 줄의 `mode`·`rollout`으로 보여 주기만 한다.

1. 세 역할의 mini 예비(publisher-mini·reviewer-mini·crawler-mini)를 **동시에** 올린다.
2. 세 역할의 M3 주를 **동시에** 올린다.
3. 고른 소비자 앱이 있으면 mini 쪽들을 함께, 다음에 M3 쪽들을 함께 올린다(부모 역할의 주 뒤·관문 앞은 순차와 같다).
4. 감시 관문을 **한 번** 본다: crawler-m3 컨테이너에서 failover readiness·worker progress가 전체 `ok`이고 세 역할이 모두
   `ready`일 때까지, 한도 180초(역할 하나의 관문은 120초).
5. 웹은 순차와 같이 mini → M3 한 대씩 올리고 공개 관문을 본다.

묶음마다 먼저 모든 앱이 사전 검사 뒤 그대로인지 읽기만 하고, 하나라도 바뀌었으면 그 묶음의 어느 앱에도 쓰지 않는다.
묶음 안의 한 앱이 실패해도 이미 요청한 다른 앱은 끝까지 기다려 결과를 남긴 뒤 멈춘다(Dokploy 배포는 중간에 거둘 수 없다).

관문이 달라지는 점과 위험:

- **세 역할이 같은 때 재시작한다.** 2단계에서 세 역할의 주가 함께 내려갔다 뜬다. 예비는 lease 소유자의 릴리스와 자기
  릴리스가 다르면 넘겨받지 않으므로(`lib/jobs/role-leader.ts`) 순차와 마찬가지로 새 주가 lease를 다시 잡는다. 순차는 한 역할씩
  번갈아 수십 초 멈추지만, 병렬은 세 역할의 작업과 진행 중이던 일감이 **같은 수십 초 동안 함께** 멈추고 끊긴다.
  M3에서 세 컨테이너가 동시에 떠 CPU·DB 연결도 잠깐 몰린다.
- **관문이 역할마다가 아니라 한 번이다.** 순차는 publisher 관문이 실패하면 reviewer·crawler가 옛 릴리스 그대로라 publisher 쌍만
  되돌리면 된다. 병렬은 관문을 볼 때 이미 여섯 앱(+소비자 앱)이 새 릴리스다. 관문이 실패하면 `touched`의 앱을 스냅샷에서
  하나씩 모두 되돌리고 failover 상태를 다시 확인한다.
- 1단계와 2단계 사이에는 세 역할 모두 readiness `release_mismatch`(경보)다. 외부 감시(Uptime Kuma Push)가 이 구간을 경보로
  볼 수 있다. 순차도 역할마다 같은 구간이 있지만 한 역할씩이다.
- 새 릴리스가 부팅부터 실패하면 1단계에서 세 예비가 모두 확인 시간 초과로 멈춘다. 주는 옛 릴리스로 계속 일하므로 예비 셋을 되돌린다.

쓰는 때: DB·catalog 변화가 없고 lease·failover·역할 시작 코드를 건드리지 않는 릴리스. migration 규칙(`--migration-verified`와
운영 journal 읽기 확인)과 **scheduler 먼저** 규칙(새 catalog 잡이 있으면 scheduler를 공통 배포 전에 올려 새 잡 행을 확인)은 그대로이며
둘 다 `run` 앞에서 끝나야 한다. 나머지 릴리스와 판단이 서지 않을 때는 기본(순차)으로 한다.

예상 효과(실측 아님, 2026-10-22 기준 순차 8앱 3분11초~4분16초): 역할 부분이 앱 여섯 대·관문 세 번에서 앱 두 묶음·관문 한 번이
되어 1분~1분 40초 줄 것으로 본다. 앱별 시간은 이번 변경 전까지 기록되지 않았으므로 다음 실제 릴리스의 `summary`로 순차·병렬을 비교한다.

git 빌드 앱(scheduler·text·maintenance)은 이 도구가 올리지 않는다. 공통 배포가 끝난 뒤(동시에 하지 않는다) 앱마다
`RELEASE_TAG` 한 줄만 바꾸고 예비 → 주 순으로 배포한다. 쌍끼리는 서로 기다릴 까닭이 없으므로 text 쌍·maintenance 쌍·scheduler를
함께 진행해도 되고, 새 catalog 잡이 있으면 scheduler만 공통 배포 **전에** 올린다.

### GitHub 수집 PAT 관리자 등록

관리자 `/admin/github-accounts`에서 공개 저장소 읽기용 PAT를 등록·교체한다. 등록 시
GitHub `/user`의 숫자 ID로 동일 계정을 식별하므로 같은 계정의 새 PAT는 교체된다.
토큰 원문은 저장 후 볼 수 없다. 계정 카드는 core 잔여/사용/초기화 시각과 관측 시각을
표시한다. 최근 1시간 원본 저장·신규 제품 수는 전체 수집 결과이며 계정별 기여로
해석하지 않는다. GitHub quota 사용량에는 다른 앱의 요청도 포함된다.

배포 순서: (1) 가산 마이그레이션 `0053_github_collector_accounts`를 기존 DB에 한 번
적용하고 성공 확인, (2) 동일한 32자 이상 `GITHUB_COLLECTOR_SECRET`을 M3·mini 웹과
M3·mini crawler 런타임에 비밀값으로 설정, (3) 같은 release의 웹과 crawler 주·예비
배포 후 관리자 페이지 확인, (4) 관리자에서 두 번째 계정 PAT 등록, (5) 두 계정의
관측 시각·core 잔여와 원본 증가를 확인한다. DB 서버·복제 설정은 변경하지 않는다.
기존 crawler의 `GITHUB_TOKEN`은 이행 중 유지한다. 같은 계정의 환경 토큰과 관리자 PAT를
함께 쓰면 GitHub 사용자별 한도는 합산되므로, 별도 계정을 등록했는지 `/user` 결과로
확인한다. 웹 또는 crawler의 암호화 키가 다르면 복호화가 실패하므로 키를 임의로
회전하지 않는다. 앱 롤백은 가산 테이블을 보존한 채 수행한다.

GitHub가 401을 돌려주면 응답 본문을 크기 제한 안에서 읽고 `expired`·`revoked`·
`bad_credentials`·`unauthorized` 중 하나로만 기록한다. 같은 토큰은 최대 두 번 더
시도한 뒤 다른 등록 계정으로 넘긴다. 401 뒤 일반 403으로 바뀌면 인증 차단으로 보고 바로
넘긴다. 거부된 토큰의 해시 키는 기존 `rate_limits`에 15분 보류한다. 새 PAT는 해시가
달라 바로 사용할 수 있다. 두 계정 모두 거부되면 1분 후 풀을 다시 확인하고 프론티어
항목의 재시도 횟수를 소모하지 않는다. `github.auth_rejected` 로그에는 계정 ID와
분류 코드만 남으며 원문 응답·PAT는 남기지 않는다. 관리자에서 토큰 교체 후
`crawl-seed`·`crawl-fetch`의 다음 실행과 새 원본 저장을 확인한다.

### 서버별 GitHub 수집 자격 (App 설치를 한 서버 전용으로)

관리자에서 켜 둔 App 설치·PAT와 `GITHUB_TOKEN`은 기본으로 모든 프로세스가 요청 단위로
돌려 쓴다. 한 설치를 한 서버(예: Oracle) 전용으로 쓰려면 프로세스 환경 변수로 나눈다(README의
`GITHUB_COLLECTOR_SOURCES` 표). 환경 변수는 그 값을 받은 프로세스에만 적용되므로, 설치를 빼려는
서버의 GitHub 요청을 하는 모든 앱(M3·mini의 역할 워커 주·예비와 웹)에 같은 값을 넣는다.
관리자 화면의 '수집에서 제외'는 모든 서버에서 빼는 스위치다.

새 설치를 Oracle 전용으로 쓰는 순서:

1. 조직에서 GitHub App을 만든다(조직 Settings → Developer settings → GitHub Apps → New
   GitHub App). Webhook의 Active를 끄고 권한은 아무것도 고르지 않는다. 운영 중인 기존 App도
   권한·저장소 없이 설치해 공개 저장소를 읽고 있다.
2. App 설정의 Private keys에서 개인 키(.pem)를 만들고 App ID를 적어 둔다.
3. Install App으로 그 조직에 설치한다. 설치 설정 주소
   (`github.com/organizations/<조직>/settings/installations/<숫자>`) 끝의 숫자가 Installation ID다.
4. 먼저 정한다: Oracle 가동 전까지 M3가 이 설치를 같이 써도 되는가.
   - 같이 쓴다: 바로 5번. Oracle 가동 때 M3·mini 앱에
     `GITHUB_COLLECTOR_EXCLUDE_APP_INSTALLATIONS=<설치 ID>`를 넣고 재배포한다.
   - 처음부터 Oracle만 쓴다: 이 기능이 든 release로 M3·mini 앱에 위 제외 변수를 먼저 넣고
     재배포한 뒤 5번. 또는 5번 직후 '수집에서 제외'로 꺼 두었다가, Oracle 가동 때 제외 변수를
     넣고 다시 켠다.
5. `/admin/github-accounts`의 "GitHub App 등록"에 App ID·Installation ID·개인 키 전체를 넣는다.
   저장하면 켜진 상태다.
6. Oracle 프로세스 환경 파일에 `GITHUB_COLLECTOR_SOURCES=apps`,
   `GITHUB_COLLECTOR_APP_INSTALLATIONS=<설치 ID>`, 같은 `GITHUB_COLLECTOR_SECRET`을 둔다.
7. 확인: App 카드의 한도 관측 시각·잔여가 움직이는지, 워커 로그에
   `github.collector_scope_empty`·`github.app_scope_installation_disabled`·`github.app_token_unavailable`이
   없는지 본다.

GitHub 공식 문서 기준 설치 한도는 시간당 5,000이다. 조직 설치는 저장소가 20개를 넘으면 저장소마다,
조직 사용자가 20명을 넘으면 사용자마다 50씩 늘고 최대 12,500이다. GitHub Enterprise Cloud
조직이면 15,000이다. 2차 레이트 리밋 대기 키(`github:quota:secondary:global`)는 서버를 나눠도
하나라서, 한 서버가 2차 제한에 걸리면 모든 서버의 GitHub 요청이 그 시각까지 멈춘다.

### 저장소 이름 변경 중복 차단 (0054)

`0054_crawl_github_identity_lookup`은 원본의 GitHub 숫자 ID 조회 인덱스와
`crawl_frontier.alias_of`를 추가한다. 기존 원본·후보·제품 행은 건드리지 않는다.
마이그레이션 성공 후 같은 GitHub ID가 새 `owner/name`으로 들어오면 새 원본은 저장하지 않고
새 프론티어를 `skipped`로 끝내며 기존 경로를 `alias_of`에 남긴다. 한 ID에 대한 동시 저장은
트랜잭션 자문 잠금으로 막는다. 운영 DB 서버·복제 설정을 바꾸는 절차는 없다.

배포 뒤 읽기 전용으로 새 별칭 처리와 중복 총량을 확인한다. 이전 중복은 이 배포만으로
사라지지 않으므로, 배포 전후 전체 중복 수를 곧바로 0과 비교하지 않는다.

```sql
select repo, alias_of, updated_at from crawl_frontier
where alias_of is not null order by updated_at desc limit 20;
select count(*) - count(distinct repo_meta->>'id') as excess_rows
from crawl_documents where repo_meta->>'id' is not null;
```

운영 환경 계약은 `docs/operations/production-multi-instance.env.example`을 사용한다. 실제 비밀값은
Dokploy와 Keychain에만 저장하고 렌더링된 환경을 로그나 문서에 출력하지 않는다.

1. 같은 commit을 두 웹에서 사용하고, build 시 동일한 base64 32-byte
   `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`를 Dokploy build secret으로, `NEXT_DEPLOYMENT_ID=<commit>`을
   build argument로 전달한다. 런타임에는 두 웹의
   `AUTH_SECRET`, `VISITOR_HASH_SECRET`, OAuth, site URL과 agent secret을 같게 둔다.
2. 런타임 `DATABASE_URL`은 PgBouncer 6432와 `DB_POOLER_MODE=pgbouncer`를 사용한다. 일회성 migration은
   직접 5432 URL로 실행한다. PgBouncer의 pool mode/size와 DB 전체 연결 사용량을 확인하기 전 pool을
   늘리지 않는다. 공통 DB role timeout은 PgBouncer backend에 적용되도록 DB에서 설정한다.
   초기값은 `statement_timeout=120s`, `lock_timeout=5s`,
   `idle_in_transaction_session_timeout=120s`다. `scripts/migrate.mjs`는 직접 연결한 세션에서만
   statement timeout을 해제하고 lock timeout을 10초로 바꾼 뒤 migration을 실행한다.
3. 로컬 수집 데이터를 옮길 때 scheduler와 5개 워커를 먼저 stop/drain한다. 일관된 dump를 복원한 뒤
   `jobs.locked_at`, `jobs.lease_token`, `jobs.worker_seen_at`을 비우고 fetching frontier를 pending으로
   되돌린다. 제품·후보·근거·클릭·정책 데이터는 유지한다. production이 빈 DB임을 확인한 첫 컷오버에만
   전체 복원을 사용하며, 이후 릴리스에서 반복하지 않는다.
4. M3에서 Dockerfile의 `connect-agent` target 한 개를 영구 볼륨과 함께 시작한다. 전용 target의
   HTTP healthcheck를 사용해야 worker supervisor 파일을 찾는 기본 healthcheck가 적용되지 않는다.
   M3/mini web과 publisher는 Tailscale 내부
   주소로 연결하고 해당 포트는 공개 domain을 만들지 않는다. 각 서비스에는 고유한
   `SERVICE_INSTANCE_ID`를 넣는다.
5. M3 singleton 역할을 시작하고 `/api/health` 및 `/admin/status`에서 DB, 두 web instance, scheduler와
   4개 worker, connect-agent 관측을 확인한다. 두 web을 직접 확인한 뒤 같은 public domain의
   load-balancer target으로 넣는다. `TRUSTED_PROXY_HOPS`는 실제 전달된 header를 표본으로 정한다.

롤백은 load-balancer에서 새 web target을 빼고 singleton consumer를 stop/drain한 다음 이전 호환
이미지를 시작한다. 데이터 복원을 되감지 않고 가산 schema와 작업 요청 버전을 보존한다.

## Codex 분류·Claude 리뷰 인증과 AI 리뷰 모드 전환

카테고리는 승인 후보를 최대 10개씩 묶어 `gpt-5.3-codex-spark`·effort xhigh·8초로 분류하고,
실패하면 `gpt-5.6-terra`·effort high·12초, 다시 실패하면 키워드 규칙을 쓴다. Spark는
`CODEX_ACCESS_TOKEN`, Terra는 `OPENAI_API_KEY`가 필요하다. publisher 시작 스크립트가 Codex 로그인
뒤 두 원문 비밀값을 환경에서 제거한다. CLI 설정·저장소 지침·플러그인·셸·웹을 격리하고, 구조화
출력의 제품 ID 전체 집합이 입력과 정확히 같을 때만 결과를 채택한다.

리뷰는 별도 Claude CLI의 `CRAWL_REVIEW_MODEL`·effort low·20초 제한으로 한 tick에 AI 호출 최대
1개다. 모델 기본값은 없으며 카테고리 모델을 리뷰 모델로 자동 채택하지 않는다. Claude Code CLI
`2.1.263`은 `--safe-mode`로 사용자 설정을 격리하면서 OAuth 인증을 보존한다. 운영에서는
`claude setup-token`으로 발급한 장기 `CLAUDE_CODE_OAUTH_TOKEN`을 reviewer에만 주입한다. 로컬
CLI smoke는 통과했으나 운영 장기 Codex/Claude 인증 설정과 24시간 관측은 아직 남아 있다.

**Grok CLI(2차 표 제공자 `grok-cli`, 2026-10-03).** 워커 이미지에 xAI 공식 Grok Build CLI `1.0.46`이
`/usr/local/bin/grok`으로 들어 있다(Dockerfile). 호출마다 `GROK_HOME`은 빈 임시 디렉터리를 쓰고, 로그인 파일만
`GROK_AUTH_PATH`(기본 `~/.grok/auth.json`)로 함께 쓴다 — CLI가 갱신한 토큰을 그 파일에 다시 쓰므로 쓰기 가능한
볼륨이어야 한다. 운영에서는 Dokploy 볼륨을 `/var/lib/nomorevibe-grok`(이미지에서 worker 소유로 만들어 둠)에
마운트하고 reviewer 환경에 `GROK_AUTH_PATH=/var/lib/nomorevibe-grok/auth.json`을 둔다. 로그인은 reviewer 컨테이너마다
한 번: `docker exec -t <reviewer> env GROK_HOME=/var/lib/nomorevibe-grok grok login --device-auth`로 받은 코드를
브라우저에서 승인한다(M3·mini 각각, 구독 계정 SuperGrok/X Premium+). 볼륨이라 재배포해도 로그인이 남는다. 설정은 2차 표 `grok-cli` / 모델 `grok-4.7`(실제 id `grok-4.7-build`, effort high
고정, 제한 90초 — 실측 중앙값 23초·최대 75초). 실패는 `auth`·`rate_limited`·`budget`으로 적히고 3회 실패 뒤
대체 모델(sonnet)로 넘어간다. 주간 크레딧 한도는 CLI가 알려 주지 않으니 x.ai 계정 사용량에서 본다.
호출은 정책 글만 시스템 프롬프트로 쓰는 에이전트 정의(`--agent nmv-review`, promptMode full)와 빈 도구 목록으로 나가
입력이 기본 에이전트의 절반(같은 사례 16,805 → 8,324 토큰)이다. 추론 강도는 reviewer 환경의 `GROK_REVIEW_EFFORT`
(minimal·low·medium·high·xhigh, 기본 low — 50건 비교에서 high 와 48/50 같은 판정, 절반 시간)로 바꾼다. `grok-session-check` 잡(reviewer, 4시간)이 가장 짧은 호출로
토큰을 갱신하고 `service:grok:<instance>` 관측을 남겨 운영센터 모델 카드에 "Grok 연결"로 보인다 — 예비(mini)는
잡을 돌리지 않으므로 넘겨받은 뒤 `auth` 실패가 보이면 다시 로그인한다.

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

### 500스타 이상 자동 승인 전환

관리자 `자동 승인 최소 스타` 기본값은 500이다. 현재 GitHub 응답의 숫자 ID·공개 여부·포크·
보관 여부·정수 스타 수와 원본 수집 시각(24시간 이내)을 확인한 후보는 AI 심사 없이 승인한다.
10만 스타도 상한 없이 포함한다. 기존 제품·차단 제품의 중복과 관리자 직접 거부는 유지한다.
발행 직전 잠긴 후보·원본·설정을 재확인하므로 설정 변경이나 원본 교체는 승인을 무효화한다.
발행 워커가 재개했을 때 확인 자료가 24시간을 넘은 승인 후보는 재수집으로, 관리자 기준이
바뀐 승인 후보는 재판정으로 자동 복귀한다.

웹·crawler·reviewer·publisher 주/예비 앱이 모두 같은 릴리스 SHA가 된 뒤에 기존 자동
거부·보류·미발행 승인 후보를 다시 수집한다. 계획은 읽기 전용이고 `.crawl-samples` 파일은
민감할 수 있어 git에 넣지 않는다. 실행 환경의 `DATABASE_URL`과 운영 pooler 설정을 사용한다.

```sh
DB_POOLER_MODE=pgbouncer npx tsx scripts/reconsider-star-auto.ts --plan .crawl-samples/star-auto-plan.json
# 파일의 후보·건수·사유를 확인한 뒤 같은 파일로 적용한다.
DB_POOLER_MODE=pgbouncer npx tsx scripts/reconsider-star-auto.ts --apply .crawl-samples/star-auto-plan.json <actor>
```

적용은 계획을 만든 DB의 식별값과 행마다 계획 당시 후보·원본·정책 지문 및 제품 중복을
다시 확인한다. 일치한 후보만
`new`/재수집 대기로 바꾸며, 새 GitHub 응답이 저장된 뒤 판정한다. 적용 수와 변경되어 건너뛴
수를 기록하고, 이후 `crawl-fetch`·`crawl-judge`·`crawl-publish` 완료와 실제 발행 결과를
확인한다. 오래된 `scripts/rejudge-stars.ts`는 과거 스타 상한 변경용이므로 이 전환에 사용하지 않는다.

## 자원·비밀값

다음은 초기 시험 예산이다. 최소 사양이나 사용량 보장이 아니며 실제 RSS/DB 연결/응답 지연을 기록해야 한다.

| 역할 | pool 상한 | RAM 상한 | CPU 상한 | 제공하는 외부 자격 정보 |
|---|---:|---:|---:|---|
| 웹 | 8 | 1536 MiB | 2 | OAuth·세션·방문자 키·관리자/cron 접수 토큰, 일반 로그인 `PUBLIC_AUTH_SECRET`, 메일을 켤 때 `LOGIN_EMAIL_API_KEY`·`LOGIN_EMAIL_FROM` |
| 크롤러 | 4 | 1536 MiB | 1 | GitHub token |
| 리뷰 | 3 | 2 GiB | 1 | 리뷰용 Claude CLI token |
| 발행 | 3 | 1536 MiB | 1 | Codex access token 또는 OpenAI API key |
| 소개·사유 번역 | 3 | 512 MiB | 1 | ABCLLM API key |
| 집계 | 3 | 1 GiB | 1 | GitHub Feedback App 키; 메일을 켤 때 웹과 같은 `LOGIN_EMAIL_API_KEY`·`LOGIN_EMAIL_FROM`·`PUBLIC_AUTH_SECRET` |
| 스케줄러 | 2 | 256 MiB | 0.25 | 없음 |
| 로컬 DB | 별도 | 4 GiB | 2 | 로컬 DB 계정 |

웹 1개와 6역할의 pool 상한 합계는 26이다. 웹 복제본과 connect-agent pool 1개를 더하면 35이며
migration/관리/다른 앱/교체 중 연결을 추가 계산한다. 운영 초기 웹 pool을 각각 6으로 설정하면 합계는
31이다. RAM은 singleton 역할을 배치한 M3에 OS·파일 캐시 여유가 필요하다.
CPU 상한은 예약량이 아니므로 모든 역할의 동시 peak를 보장하지 않는다. 8 vCPU/16 GiB 예시는
측정을 시작할 동거형 예산이며 호스트 장애까지 견디는 무중단 구성은 아니다.

알림 메일(MY7)은 웹·발행·수집·집계 어디서 알림이 생기든 DB 설정만 보고 `email_outbox`에 줄을 세우고,
집계(maintenance)의 `email-outbox-send`만 보낸다. 그래서 메일을 켤 때는 두 웹과 집계 주·예비 넷에 같은
`LOGIN_EMAIL_API_KEY`·`LOGIN_EMAIL_FROM`·`PUBLIC_AUTH_SECRET`(끄기 링크 서명)을 두고 집계를 먼저 배포한다.
배포 사전 점검(`deploy_shared_images.py`)은 넷의 값이 다르면 멈춘다. 집계에 키가 없으면 줄을 닫지 않고
`me.email_sender_unconfigured` 경고만 남기며, 하루 안에 못 보낸 줄은 보내지 않고 닫고(`expired`) 닫힌 줄은 30일 뒤
`email-weekly-digest`가 지운다. 키·도메인·한도 오류(Resend 401·403·429)는 시도로 세지 않고 5분 뒤 다시 본다.

로그는 컨테이너당 10 MiB × 3개로 회전한다. 비루트 프로세스, `no-new-privileges`, capability 제거,
Compose `init: true`를 사용한다. 초기 자원 초과가 보이면 탐색/재수집량과 pool 상한을 함께 조정한다.

## 생존·진행·장애 복구

### 역할 후보 운영·교체

2026-09-29 운영에서는 M3의 crawler·reviewer·publisher·maintenance·text가
`role-worker.ts --kind=primary`, mini의 같은 다섯 역할이 `--kind=standby`로 실행된다.
실제 앱 13개와 scheduler 2복제본의 검증은 [P3 배포 기록](2026-09-29-worker-failover-p3-rollout.md)에 있다.
다음 릴리스 교체에는 아래 순서를 지킨다.

1. `0051_role_leases.sql`과 `0052_role_failover_history.sql`을 한 번 적용하고 종료 코드 0을
   확인한다. 기존 워커를 먼저 정상 drain한다. 기존 `worker-supervisor.ts`와 새 역할 후보가
   동시에 쓰지 않도록 한다.
2. 주 후보의 명령을 `node --import tsx scripts/role-worker.ts --role=crawler --kind=primary`
   (심사는 `reviewer`)로 바꾼다. 고유한 `SERVICE_INSTANCE_ID`, 실제 이미지 commit의
   `RELEASE_TAG`, 기존 역할 자격 정보와 pool 상한을 설정한다. 이 명령은 주인 선출에
   성공한 뒤에만 기존 supervisor를 실행한다.
3. DB `role_leases`의 owner/epoch와 로컬 worker health, 후보 관측이 일치하고 실제 저장이
   진행되는지 확인한다. 그 뒤 같은 commit과 `RELEASE_TAG`의 예비 서비스를 **별도
   instance ID**로 시작한다. 예비 명령은 `--kind=standby`다. 대기 중에는 supervisor나
   수집/심사 외부 호출을 실행하지 않는다. `worker-healthcheck.ts`는 로컬 후보 상태가
   신선한 대기를 healthy로 판단하고, 활성 후보는 supervisor 상태도 요구한다.
4. 롤링 교체에서는 역할 주·예비 앱의 `autoDeploy=false`를 유지한다. 현재 주가 살아 있는 동안
   예비의 `RELEASE_TAG`를 새 commit으로 바꾸고 새 이미지를 먼저 배포한다. 이 잠깐의 릴리스
   불일치 동안 새 예비는 옛 주의 lease를 승계하지 않는다. 예비 배포 완료와 대기를 확인한 뒤
   주의 환경·이미지를 같은 commit으로 배포하고 새 주의 active·예비 standby를 확인한다.
   두 역할을 동시에 교체하지 않고 역할별로 마친다. 이후 main 변경에도 역할 앱은 수동으로
   함께 교체해야 한다. 옛 주가 이미 장애 상태라면 릴리스 불일치 예비를 즉시 승격시키려 하지
   말고 같은 릴리스로 맞춘 후보를 먼저 확보한다.
5. 역할 후보의 비정상 종료는 Swarm의 기존 restart 정책이 1차 복구한다. 역할 lease는
   45초, 예비 확인은 5초, 기존 주인 만료 뒤 유예는 20초다. 반복 주 후보 부팅 3회/5분은
   15분 격리한다. DB 연결이 불명확하면 새 작업을 중단하며, 이전 job token은 새 주인의
   선출 트랜잭션에서 무효화된다. 실제 운영에서는 자식 SIGKILL 뒤 주 후보 재획득과
   주 서비스 중단 뒤 mini 예비 선출 및 복귀를 확인했다. crawler 문서·reviewer 1차 심사·
   maintenance ping·text 검수의 새 결과 저장도 확인했다. publisher는 당시 적격 승인 후보가
   없어 새 제품 저장을 확인하지 못했다. 반복 부팅 격리의 운영 주입은 별도 검증이 필요하다.

P0 `check-worker-progress.ts`의 독립 주기 실행·외부 알림 연결은 아직 배치되지 않았다.
역할 후보는 프로세스 종료·lease 만료를 처리하고, 아래 조건일 때만 저장 정체로 재시작한다.

역할 후보 명령으로 전환하면 **주 후보만** 15초 간격으로 구조화된 진행 상태를 확인한다.
scheduler가 정상 예약 중이고 해당 역할에 `no_progress`가 연속 2회이며 같은 역할의
다른 단계가 저장 진행 또는 제공자 오류를 보이지 않을 때 supervisor를 drain하고
비정상 종료해 Swarm 재시작을 먼저 시도한다. 기존 역할 lease의 45초 만료·20초
예비 유예 후 새 주 후보가 재획득한다. 반복 부팅 3회/5분으로 격리되면 같은 릴리스
예비가 선출될 수 있다. 예비 후보는 같은 진행 정체를 이유로 무한 재시작하지 않는다.
역할의 유효한 실행 중 job lease가 있으면 저장 간격만으로 재시작하지 않는다. 실제로 오래
멈춘 잡은 위 supervisor의 역할별 job timeout이 종료한다.
DB 판정 오류는 이 재시작 조건에서 제외하고 역할 lease 갱신 실패가 별도로 중단시킨다.
외부 알림은 여전히 별도 연결이 필요하다.

publisher·maintenance·text도 같은 주/예비 후보와 healthcheck로 운영한다. publisher는 적격 승인
후보가 10분 넘게 대기하고 발행 저장이 멎었을 때만 정체를 잡는다. maintenance는 점검
대상과 최근 5분의 실제 ping 저장을 비교한다. text는 번역·소개·검색 프로필·검수의
적격 대기와 최근 10분 결과를 비교한다. DB 시간으로 대기 시간을 계산하고, scheduler
중단·잡 backoff·최근 제공자 오류와 실행 중 job lease는 정체 재시작에서 제외한다.
publisher의 OG 저장과 maintenance의 ping·뉴스·검색 사본·클릭 정리·랭킹은 이전 job
token으로 커밋할 수 없게 같은 트랜잭션에서 검사한다. text의 결과 쓰기는 기존 job
token과 원본 변경 검사를 유지한다.

maintenance의 `uptime-ping`은 기본 15건/분·HTTP 동시 3개다. 2026-09-29 읽기 전용 표본은
공개 웹사이트 19,365개, 최근 6시간 미점검 13,976개, 최근 1시간 점검 905개였다.
6시간 재확인에는 분당 약 54건이 필요하다. `UPTIME_BATCH_SIZE`는 1..60,
`UPTIME_CONCURRENCY`는 1..6이며 미설정 기본값은 15/3이다. 우선 30/4로 올려
5분 이상 `job:uptime-ping`의 `durationMs`·`uptime.checked` 건수, 최근 5분 저장,
`jobs.last_error`, DB 연결과 서버 CPU/RSS를 확인한다. tick이 25초 예산 안에서
안정적으로 끝나면 60/6으로 올린다. 주·예비 앱의 이미지와 설정을 함께 맞추되
한 번에 하나만 활성 실행한다. 동일 origin 단일 요청·한 건씩 DB 기록·제품별 6시간
재확인 제한은 유지된다. 실제 6시간 초과 건수가 여러 시간에 걸쳐 줄기 전에는
목표 달성으로 기록하지 않는다. 설정만 올리고 측정하지 않은 것은 용량 해결이 아니다.
2026-09-29에는 30/4와 60/6을 순차 배포해 60/6의 5분 저장 300건을 확인했다.
수시간의 6시간 초과 대기와 자원 사용은 계속 검증한다.

2026-09-29에는 publisher→maintenance→text 순서로 M3 기존 워커를 새 이미지에 배포하고
주 후보 명령으로 전환한 뒤 동일 commit·`RELEASE_TAG`·필요한 인증의 mini 예비를 배포했다.
자식 종료→주 재시작, 주 서비스 중단→mini 인계와 확인 가능한 결과 저장, M3 복귀를
순차 시험했다. publisher의 신규 발행 저장은 위의 미검증 항목으로 남는다.
다음 교체는 위 4번의 주·예비 릴리스 절차를 따른다. 작업 중 역할당 활성 소비자는 하나만
허용하고 DB streaming·서버 설정은 변경하지 않는다.

scheduler 2복제본의 DB 요청 합치기 통합 테스트와
`SCHEDULER_REPLICA_IDENTITY=1` 설정을 확인했다. 이 옵션에서 각 컨테이너의
`HOSTNAME`이 관측 키에 포함되므로 고정 `SERVICE_INSTANCE_ID`를 공유하더라도 서로의
생존 기록을 덮어쓰지 않는다. 두 관측 키와 각 컨테이너 상태, 예약 시각 전진을
확인한 뒤 수집 예비 배치로 넘어간다.

워커 자식은 IPC로 5초마다 생존 신호를 보내고 현재 잡·시작 시각·최근 진행 시각을 보고한다.
감시기는 아래 초기 상한을 넘으면 워커 leader에 SIGTERM을 보내 먼저 drain한다.
단순 유휴/쿼터 대기 자체는 장애가 아니다.

| 감시 대상 | 초기 상한 | 의미 |
|---|---:|---|
| IPC 생존 신호 없음 | 30초 | 자식 event loop 중단/프로세스 장애 |
| 잡 밖에서 진행 없음 | 90초 | poll/DB 요청/초기화가 끝나지 않음 |
| crawler/reviewer/publisher/text 잡 | 180초 | 정상 HTTP/CLI 한도를 크게 넘긴 tick |
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

DB 작업 잠금은 15초마다 갱신되고 현재 stale 유예는 90초다. 강제 종료 직후에는 남은 잠금으로
잠시 건너뛸 수 있다. 임의로 잠금/token을 지우지 말고 기존 프로세스 종료 및 stale 회수를 확인한다.
프론티어 개별 `fetching` 항목의 재선택 시각은 별도 10분이다. 이 상한 때문에 장애 복구를
항상 2분 이하라고 보고하지 않는다.

`node --import tsx scripts/check-worker-progress.ts`는 수집·심사·발행의 준비된 일감·저장 진행과
scheduler 및 다섯 역할의 생존, 예정 시각과 최근 부팅을 읽기 전용 JSON으로 출력한다. 종료 코드 0은 정상·유휴,
1은 DB 조회 실패 등 판별 불가, 2는 경보다. 유휴·정책상 중단·backoff를 장애로 다루지 않는다.
`manual_attention`은 워커 장애가 아니라 자동 처리가 끝나 사람이 결정해야 하는 상태라 종료 코드 0을 유지한다.
각 단계의 `manualAttention`과 관리자 `단계별 처리 속도`의 `직접 확인` 건수를 함께 확인한다.
1차 심사의 같은 입력이 3회 실패하면 `ai_review_exhausted`, 재수집 요청이 GitHub 404 또는 수집 재시도
소진으로 끝나면 `source_refresh_failed` 사유로 심사 큐의 `직접 판단` 단계에 넘긴다.
첫 사례는 1차 심사 기록을 보고 직접 승인·거부하고, 두 번째는 현재 저장소와 제품을 확인한 뒤 결정하거나
관리자에서 추가 수집을 요청한다. 작업 실행 요청만 반복해도 재시도 상한은 초기화되지 않는다.
현재 CLI 자체의 주기 실행과 외부 알림은 배치되지 않았으므로 관리자 화면 또는 수동 호출만으로
자동 경보가 준비됐다고 보고하지 않는다.

### 독립 failover 감시

`check-worker-progress.ts`는 역할별 최신 서비스 하나를 읽는다. 주가 계속 실행되면 mini 예비가
사라져도 정상으로 보일 수 있다. `node --import tsx scripts/check-failover-readiness.ts`는
`m3-<role>` 주 후보·`mini-<role>-standby` 예비 후보의 최근 60초 관측, 같은 릴리스,
유효한 lease의 owner/boot/epoch 일치와 scheduler의 서로 다른 최근 복제본 2개를 별도로 판정한다.
DB 시계로 관측과 lease 나이를 계산하고 기존 진행 판정도 JSON에 포함한다. 종료 코드는
0 정상, 1 판별 불가, 2 경보다. 인계 중 예비가 활성인 상태는 용량 여유가 사라진 경보로 표시한다.

`docker build --target monitor -t nomorevibe-monitor:<commit> .`로 CLI 없는 경량 감시 이미지를
만든다. 웹·scheduler와 별도 M3 Dokploy 앱, `autoDeploy=false`, `WORKER_ROLE=monitor`,
DB pool1, 30초 Push 루프를 사용한다. 환경에 `DATABASE_URL`(읽기 전용 계정),
`MONITOR_PUSH_URL`(mini Uptime Kuma의 전용 Push monitor URL)을 설정한다. URL은 로그에
출력하지 않는다. `CONNECT_AGENT_URL`의 설정 여부는 publisher와 일치시킨다. 진행 판정의
발행 적격 큐가 이 변수의 존재에 따라 분류 완료 조건을 적용하므로, 서로 다르면 거짓 경보가
될 수 있다. 감시자는 이 URL에 직접 접속하지 않는다. Push monitor의 heartbeat timeout은
최소 90초 이상으로 맞춰 일시적
전환 1표본을 허용한다. 연속 2회 이상에서 `down`, 정상 회복 때 바로 `up`을 보낸다.
Push 실패가 나면 URL·응답 본문 없이 오류만 기록하며 전송을 재시도한다. 컨테이너 healthcheck는
최근 검사 완료만 보며 DB 장애를 숨기지 않도록 JSON은 `unknown`으로 남긴다.

운영 연결 순서는 감시자 계정 SELECT 범위 확인 → Kuma Push monitor 생성 → `MONITOR_PUSH_URL`
주입 → 앱 배포/이미지 commit 확인 → CLI 정상·Push 최근 UP 확인 → mini 예비 하나 일시 중지로
DOWN/회복 확인 → monitor 중지로 Push heartbeat timeout 확인 → 모두 원복이다. 알림
수신 경로는 실제 수신으로 확인한다. mini 호스트 자체가 사라지면 Kuma도 멈추므로 독립된
외부 deadman 또는 두 번째 감시 위치가 추가로 필요하다. 이 절차는 아직 운영 검증으로
기록하지 않는다.

DB 드라이버는 `postgres` 3.4.9로 고정했다. `lib/db/pool.ts`는 대기 중인 정확한 요청을 취소하기 위해
해당 버전의 내부 연결 경계를 사용한다. 업그레이드 시 단순 타입 검사만으로 호환성을 판단하지 말고
`tests/integration/db-pool-budget.test.ts`를 전용 DB에서 실행해 만료된 쓰기/BEGIN 미실행,
정상 BEGIN 복구, statement 제한, pipeline 대기, 연결 회전과 트랜잭션 복구를 확인한다.

## 통합 완료 시 남길 증거

아래는 수행할 체크포인트이며 이 문서 작성 시 통과한 것으로 간주하지 않는다.
2026-09-08 웹 없이 5역할을 1,800.307초 관측했다(31표본 모두 healthy, 재시작0, DB연결 최대5).
외부 수집 비활성·빈 DB 조건의 독립 실행 검증이며 24시간 운영 관측은 미수행이다.
운영 배포 전 로컬 결과이므로 생산 배포 완료를 뜻하지 않는다. 완료한 항목은 릴리스 보고서의
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

## 2026-09-21 text 역할 분리

`publisher`는 `crawl-publish`만, `text`는 `reason-translate`와 `crawl-tagline`을 직렬로 실행한다. 기존 job 이름과 요청·lease 행을 그대로 사용한다. 번역 동시성1/예산55초, 소개 동시성2/worker 예산25초를 유지한다. 1차 심사는 별도 변경으로40초/호출24초(gateway)·20초(CLI)다.

배포 준비: 기존 publisher를 정상 drain→새 publisher 교체 및 소유 잡 확인→새 text 컨테이너 시작. 신규 text는 worker target/위 명령, memory512MiB·DB pool3·hard timeout180초, 별도 instance ID/health를 사용한다. 실제 서버 여유는 배포 전에 확인한다. 구형 publisher와 새 text를 함께 유지하지 않는다. rollback은 text drain/중지 후 구형 publisher 복구이며 DB 요청·결과를 삭제하지 않는다.

DB 기본 상한은 web8+crawler4+reviewer3+publisher3+text3+maintenance3+scheduler2+connect-agent1=27이다. 웹2개 기본8이면35, 운영 웹 각각6이면31이다. migration/관리/다른 앱/교체 여유를 별도로 확보한다. 이 계산은 설정상 최대이며 실제 연결 수 실측이 아니다.

관리자 상태 화면에 소개·사유 번역(text) 카드를 추가했다. 표시만으로 배포 성공을 판단하지 않는다. 해당 release의 컨테이너 healthy, publisher의 텍스트 실행0, text의 처리 및 backlog 감소를 확인한다. 공유 모델 서버 경합은 분리 후에도 계측한다.

### Oracle consumer host budget 제한 및 identity 전환

Oracle 전용 `agent-scan` principal은 host 장부의 만료 DELETE 및 HTTP control 권한을 갖지 않는다.
따라서 `HOST_BUDGET_ENFORCEMENT.mode=enabled`와 `HTTP_ORIGIN_PERMITS=1` 조합은 launcher,
consumer preflight, runtime에서 `agent_scan_oracle_host_budget_unsupported` 설정 오류로 거절한다.
기본 비활성 설정은 유지하며 이를 해결하려고 GRANT를 확대하지 않는다.

host process identity의 consumer 칸은 등록된 일반 consumer(`agent-scan`, `uptime`)도 구분한다.
기존 reviewer(`legacy`/`ai1`/`ai2`)와 consumer 없는 프로세스의 identity는 그대로다.
일반 consumer만 과거 `-` 칸에서 이름으로 전환되므로 host budget 활성 상태의 전환은 해당
구버전 프로세스를 먼저 종료하고 기존 장부 lease(기본 45초)가 만료된 뒤 시작한다.
혼합 버전에서 동일 consumer를 중복 기동하지 않는다. 같은 새 identity의 다른 boot는 계속 거절한다.
