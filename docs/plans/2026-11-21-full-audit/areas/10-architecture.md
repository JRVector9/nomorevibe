# 10. 구조 변경 제안 — 점검 결과

> 2026-11-21 전수 점검의 구역 문서다(점검 기준 origin/main `34b5fe32`, 읽기 전용). 수정 순서와 묶음은 [README](../README.md), 실측은 [evidence](../evidence.md)·`../evidence/`.
> 줄 번호는 그 커밋 기준이다. 「확신도」가 PLAUSIBLE 인 항목은 적힌 확인을 먼저 한다.


기준 코드: `저장소 루트` (origin/main `34b5fe32`). 실측은 `../evidence/` 의 파일.
이 구역은 개별 결함이 아니라 **비용을 계속 만들어 내는 구조**를 본다. 개별 쿼리·인덱스 처방은 db-queries·llm-capacity·jobs-runtime-db 구역의 몫이다.
여기 제안은 그 처방이 끝난 뒤에도 같은 종류의 문제가 다시 생기지 않게 하는 구조 변경이다.

## 요약

심각도별: **P1 3건 · P2 5건 · P3 5건** (모두 분류 `structure`. ARCH-09·10 은 「하지 말 것」 판단이다). 2차 검증에서 ARCH-02 를 P1 → P2 로 내렸다(1차 집계 P1 4 · P2 4 · P3 5).

느린 문장(0.5초 이상) 23시간치 122,852초를 구조 원인별로 다시 묶었다(evidence/slow-queries-primary.txt 전 64개 모양을 분류함).

2차 검증에서 같은 파일로 다시 계산했다. 아래 「slow 행」은 `slow-queries-primary.txt` 의 파일 줄 번호(1줄 = 머리)다. 행들의 합은 64모양·79,854건·122,850초다(파일 머리의 122,852초와 반올림 차).

| 구조 원인 | slow 행(파일 줄) | 횟수 | 합계 초 | 비율 |
|---|---|---:|---:|---:|
| 이력에서 「할 일·대기열·진행」을 매번 다시 유도하는 조회(읽기) | 2·4·5·6·9·10·11·12·14·17·19·26·29·30·31·36·37·40·42·46·48·50·51·53·55·57·62·65 | 39,572 | 82,586 | **67.2%** |
| 모델 장부 control 한 행(id=1) 잠금 대기 | 3·7·8·13·24 | 35,291 | 36,317 | **29.6%** |
| role_leases 행 잠금 대기 | 15·18 | 2,038 | 1,879 | 1.5% |
| jobs 행 잠금·쓰기 | 20·21·23·25·27·28·38·39·41·52·60 | 1,031 | 983 | 0.8% |
| 장부 쓰기(`model_capacity_requests` UPDATE·INSERT) | 16·22·32·43·45 | 1,824 | 1,002 | 0.8% |
| 그 밖(advisory·products 쓰기·행 잠금·한국어 탐색) | 33·34·35·44·47·49·54·56·58·59·61·63·64 | 98 | 83 | 0.1% |
| (겹침) 그중 감시 계정 `nomorevibe_monitor_20261022` 몫 | 4·30·50 | 3,681 | 16,622 | 13.5% |

- 1차 값과의 차이: 1차는 34(`products.search_keywords` UPDATE)·35(`github_ko_discovery_queries` upsert)·64(`github_ko_discovery_control` FOR SHARE) 행(43건·37초)을 「유도 조회」에 넣었다. 그래서 39,615건·82,623초·67.3% 였다. 이 셋은 쓰기·잠금이라 「그 밖」으로 옮겼다. 1차는 나머지 「그 밖」 55건·46초를 어느 묶음에도 넣지 않았다. 「jobs 행·장부 쓰기」 2,855건·1,985초는 위 두 줄(jobs + 장부 쓰기)의 합과 정확히 같다.
- 합이 100% 를 넘는 까닭: 마지막 줄(감시 계정 13.5%)은 원인 묶음이 아니라 **계정별 단면**이다. 세 행 모두 유도 조회 묶음 안에 이미 들어 있다(4행 `reason_eligible`, 30행 uptime readback, 50행 공개 제품 목록). 위 여섯 줄만 더하면 100.0% 다.
- 9행(uptime split readback, 7,210건·4,121초)과 12행(사람 위임 검수 후보 `humanReviewRepos`, `lib/crawl/human-review-repository.ts:77`)도 코드 위치를 확인하고 유도 조회로 넣었다. 9행은 `readWorkerProgress` → `readUptimeSplitStage`(`lib/operations/uptime-split-repository.ts:66·74-76`)의 진행 계산이다.

**얻는 것 ÷ 드는 것 상위 5개**

1. **ARCH-02** 역할 lease 잠금 규약 — 예비가 5초마다, 주가 10초마다 같은 행을 `FOR UPDATE` 로 잡는다. 미리 읽기를 넣고 `FOR KEY SHARE` 로 바꾸면 끝난다(S). lease 를 잃어 워커가 재시작될 위험도 함께 줄인다. (2차: 비용 대비 1순위는 그대로다. 다만 실측 몫이 느린 시간의 1.5% 라 P2 로 내렸다.)
2. **ARCH-01** 진행 보고서를 한 번만 계산 — 같은 무거운 집계를 역할 주 프로세스 5개가 15초마다, 감시가 30초마다 따로 계산한다(하루 최대 약 3.2만 번). DB 의 한 행에 계산해 두고 함께 읽으면 계산 횟수가 약 80% 준다(S~M). 진행 계산으로 확인된 느린 시간은 4·9·11·30행의 23,811초/일이다. 줄일 수 있는 몫은 약 1.3만~1.6만 초/일로 본다(2차 추정).
3. **ARCH-05** 배포 범위를 이미지 내용과 import 그래프로 판정 — 최근 PR 100개 가운데 19개는 웹만 바꿨음을 증명할 수 있다(2차에서 표본 8개를 재현). 지금 분류기는 1개만 웹 전용으로 본다(재현 안 함). 그 19개는 18앱 배포와 DRAIN 창 대신 웹 2앱 배포로 끝낼 수 있다(S~M).
4. **ARCH-03** 장부 직렬화 지점 쪼개기 — 점유를 늘리는 전이(예약 부여)만 장비 단위로 직렬화하고, 보냄·정산은 전역 `FOR UPDATE` 에서 뺀다. control 잠금 대기(하루 36,317초)의 약 44~80% 를 없앨 수 있다(2차에서 범위를 넓힘. M, 단계별로 되돌릴 수 있음).
5. **ARCH-04** 상태 전이 때 채우는 대기열 + 드문 대조기 — 발행·규칙 판정·사유 번역·2차 정리 네 가지 유도 조회가 느린 시간의 59.5%(73,123초)를 쓴다(2차 재계산으로 같음). 대기열 행을 인덱스로 집고, 전체 유도는 10~15분마다 대조용으로만 돌린다(대기열마다 M).

## 발견

### ARCH-01 같은 진행 집계를 6개 이상의 프로세스가 각자 계산한다 — DB 한 행에 한 번 계산하고 모두 그것을 읽게
- 심각도: P1
- 분류: structure
- 위치:
  - `scripts/role-worker.ts:445-466` — 주(primary) 후보가 lease 를 쥔 동안 **15초마다** `checkProgress` 를 부른다.
  - `scripts/role-worker.ts:651-664` — 그 안에서 `readWorkerProgress(undefined, { includeText: false })` 를 부른다. maintenance·text 는 여기에 `readMaintenanceUptimeProgress`·`readTextProgress` 를 더 부른다.
  - `lib/operations/worker-progress-query.ts:455-481` — `pipelineThroughput` 와 증거 진행, `operations_observations` 전체 읽기, 응답 점검, 텍스트 단계(감시만)를 부른다.
  - `lib/operations/throughput.ts:23-34` — 겹친 호출을 하나로 묶는 처리는 **한 프로세스 안**에서만 된다. 그마저 `now` 를 넘기면 건너뛴다(`readWorkerProgress` 는 늘 `now` 를 넘긴다, `worker-progress-query.ts:471`).
  - `lib/operations/throughput.ts:123-130` — `publish_candidates` 가 승인 후보마다 발행 관문 술어(`reviewApprovalPredicate`) 전체를 평가한다.
  - `lib/operations/failover-monitor.ts:68-70`, `scripts/watch-failover-readiness.ts:207,226` — 감시는 30초마다 같은 보고서를 텍스트 단계까지 포함해 계산한다.
  - `app/(operator)/admin/status/attention.tsx:108` — 관리자 화면도 따로 계산한다.
  ```ts
  // scripts/role-worker.ts:655
  const report = await readWorkerProgress(undefined, { includeText: false });
  // lib/operations/throughput.ts:24
  if (now) return readThroughputSnapshot(settings, now);   // 묶기 없이 바로 계산
  ```
- 문제: 지금 구조는 「진행 판정이 필요한 곳마다 직접 계산한다」이다. M3 의 역할 주 프로세스 5개가 15초마다 계산하면 하루 최대 5×5,760 = 28,800번이다. 감시가 2,880번, 관리자 화면과 배포 관문이 그 위에 더한다. 모두 같은 DB·같은 술어·같은 결과다.
  - `pipelineThroughput` 는 `statement_timeout 3s` 로 묶여 있다(`lib/operations/throughput.ts:62`). 그런데 같은 발행 술어를 쓰는 발행 잡의 조회는 평균 2.7초가 걸린다(slow-queries 2행). 그러니 throughput 집계도 3초 안팎에서 자주 끊길 것으로 추정한다.
    - **2차 반증 시도 — 이 추정은 근거가 약하다.**
      - 같은 파일 주석이 운영 실측을 적었다. JIT 를 끄면 156ms(`lib/operations/throughput.ts:59-60`)이고, 「혼자 1초, 셋이 겹치면 2.6초」(`:25-26`, 11-10)다. 서버 설정도 이미 `jit = off` 다(`pg-stats-primary.txt` 94행).
      - 0.5~3초에 끝난 실행이 있었다면 0.5초 넘은 문장 집계에 `WITH fetched AS` 모양이 나와야 한다. 23시간 동안 한 번도 없다. 그러므로 「늘 0.5초 안에 끝난다」 쪽이 더 그럴듯하다.
      - 「늘 3초에 끊긴다」였다면 역할 주 프로세스 5개의 `checkProgress` 가 15초마다 모두 실패했을 것이다. 그러면 배포 관문도 늘 막혔을 텐데, 그런 상태를 가리키는 근거는 없다.
  - 느린 문장 목록에 throughput 의 `WITH fetched AS …` 모양은 한 번도 없다. 반면 `nomorevibe` 계정의 statement timeout 은 하루 10,383건이다. 1차는 둘 다 「끝까지 가지 못하고 3초에 끊긴다」로 설명했다. 2차 판정은 위 반증 시도 때문에 「근거 약함」이다. 10,383건이 어느 문장인지는 여전히 모른다.
  - 끊기면 `checkProgress` 가 실패하고 `role.progress_unknown` 이 난다(`scripts/role-worker.ts:461-464`). 감시는 `unknown` 이 된다. 11-02 에 진행 쿼리 하나가 3.2초가 되어 배포 관문을 막은 일과 같은 구조다(`lib/operations/text-stage-progress.ts:146-150` 주석).
  - (2차 보강) 진행 계산 중 **실측으로 확인된 느린 몫**은 다음과 같다.
    - 4행: 감시의 `reason_eligible`, 16,580초.
    - 11행: 앱의 `reason_eligible`, 3,071초.
    - 9행: 역할 주 프로세스의 uptime split readback(`readUptimeSplitStage` → `lib/operations/uptime-split-repository.ts:66`), 7,210건·4,121초.
    - 30행: 감시의 같은 readback, 39초.
    - 합 23,811초/일, 느린 시간의 19.4% 다.
  - 조건부 호출: `checkProgress` 는 batch 가 versioned 이면 아무것도 하지 않는다(`scripts/role-worker.ts:652`). maintenance·text 는 역할 잡이 돌고 있으면 건너뛴다(`:654`). 그러니 「5×5,760」은 상한이다. 9행이 하루 7,210건이나 0.5초를 넘는 것으로 보아, 운영은 legacy 모드에서 이 계산을 자주 하고 있다.
- 실측 근거:
  - slow-queries 4·11행: 감시의 `reason_eligible` 3,604회·16,580초, 앱 647회·3,071초.
  - errors 70·71행: statement timeout `nomorevibe` 10,383, 감시 875.
  - pg-stats-primary 30행: `operations_observations` seq_scan 150,934회(5.6일, 하루 약 2.7만 번). 2차 정정: 이것은 `lib/operations/worker-progress-query.ts:471` 의 전체 읽기 횟수의 **상한**일 뿐이다. 같은 표를 `LIKE 'service:%'` 로 훑는 다른 조회(예: `lib/operations/pipeline-control-repository.ts:91-93`)도 seq scan 으로 센다. 표가 2,585행·5MB 라 한 번의 비용은 작다.
  - (2차 추가) slow-queries 9·30행: 진행 계산 안의 uptime split readback 7,210+71건·4,160초.
- 수정 방안(바꿀 구조):
  1. `operations_observations` 에 `progress:report` 한 줄을 둔다. `readOrRefreshProgress(maxAgeMs)` 는 다음 순서로 동작한다.
     - 그 줄이 `maxAgeMs` 안이면 그대로 돌려준다.
     - 아니면 `pg_try_advisory_xact_lock` 을 얻은 프로세스 하나만 계산해 upsert 한다.
     - 잠금을 못 얻은 쪽은 직전 값을 돌려주거나 1~2초 뒤 다시 읽는다.
  2. 역할 주 프로세스의 `checkProgress` 는 `maxAgeMs=15s` 로 읽는다. 재시작 조건인 「두 표본」은 **`measuredAt` 이 서로 다른 두 보고서**일 때만 센다. 같은 보고서를 두 번 읽고 재시작하지 않게 하기 위해서다.
  3. 관리자 화면과 배포 관문(`scripts/check-worker-progress.ts`)도 같은 함수로 읽는다. 텍스트 단계는 60초 주기로 따로 갱신한다.
  4. 감시는 읽기 전용 계정이라 쓰지 않는다. 그 줄이 90초 넘게 낡았을 때만 지금처럼 직접 계산한다. 그래서 워커가 모두 죽어도 감시는 독립적으로 움직인다. 생산자가 안정됐음을 확인한 뒤 「낡음 = 경보」로 바꾸면 감시의 import 범위가 419개 lib 파일에서 수십 개로 준다. 이렇게 되면 ARCH-05 에서 감시 배포가 분리된다.
- 얻는 것:
  - 전체 진행 계산이 하루 최대 약 31,700번 → 약 5,760번(−80%)으로 준다(횟수 상한 기준).
  - 텍스트 단계 계산은 3,604+647번 → 1,440번이다. 평균 약 4.6초로 치면 `reason_eligible` 은 19,651초 → 약 6,600초, 곧 **약 −13,000초/일**이다. 1차는 −10,000초로 적었는데 보수적이었다. ARCH-04(a) 원천 등록 표를 더하면 사실상 0 이다. 다만 그 몫은 ARCH-04 의 73,123초와 겹치므로 두 제안의 효과를 더하면 안 된다.
  - (2차 추가) 9행 uptime readback 은 5개 프로세스 → 1개라 약 4,121초 → 약 820초(−3,300초/일)로 본다.
  - 합쳐서 **약 −1.3만~1.6만 초/일**(느린 시간의 11~13%)이다.
  - 「3초에 끊기는 문장 수도 같은 비율로 준다」는 2차에서 근거가 약하다고 보았다(위 반증 시도). 효과로 세지 않는다.
  - 운영 홈·배포 관문·재시작 판정이 **같은 시각의 같은 보고서**를 보게 된다. 지금은 관문마다 계산한 시각이 달라 판정이 엇갈릴 수 있다.
- 옮기는 순서:
  - PR1: 함수와 줄만 추가하고 관리자 화면만 그것을 읽게 한다. 되돌리기는 화면 import 하나다.
  - PR2: 역할 주 프로세스가 읽게 한다. 두 표본 규칙을 바꾸는 것까지 포함하며 `scripts/role-worker.ts` 의 기존 시험을 그대로 쓴다.
  - PR3: 배포 관문이 읽게 한다.
  - PR4: 감시를 「낡았을 때만 계산」으로 바꾼다. PR 마다 env 스위치(`PROGRESS_SUMMARY_READ=0`)로 즉시 예전 경로로 돌아갈 수 있게 한다.
- 위험: 생산자가 멈추면 모든 판정이 낡은 보고서를 본다. 그래서 줄의 `measuredAt` 나이를 판정 입력으로 넣는다. 너무 낡으면 「unknown·재시작 안 함」으로 둔다. 지금 오류 경로가 이미 그렇다(`role-worker.ts:461-464`). 복제본으로 옮기는 대안은 「관문은 주 DB」라는 의도된 결정(`worker-progress-query.ts:469`)과 맞지 않아 권하지 않는다.
- 검증:
  - 느린 문장·오류 집계에서 statement timeout 건수와 `reason_eligible` 횟수를 비교한다.
  - `operations_observations` seq_scan 증가 속도를 본다.
  - `role.progress_unknown` 로그 빈도를 본다.
  - 기존 `role-worker` 시험에 「같은 measuredAt 두 번은 재시작하지 않음」을 추가한다.
- 배포 주의: 일반 배포다. PR2 는 reviewer·text 등 역할 앱 교체이므로 기존 DRAIN 절차를 따른다.
- 확신도: 6개 이상의 프로세스가 같은 집계를 반복한다는 것은 CONFIRMED(호출 경로를 끝까지 읽음. 2차에서 `readWorkerProgress` 가 늘 `now` 를 넘겨 프로세스 안 묶기도 건너뛰는 것까지 확인). 진행 계산의 느린 몫 23,811초/일도 CONFIRMED(4·9·11·30행을 코드 위치까지 추적). 「statement timeout 10,383건의 대부분이 throughput 집계」는 2차 반증 시도 뒤 **근거 약함**이다(주석 실측 156ms~1초, 0.5초 넘은 실행 0건). 확인하려면 오류 로그에서 timeout 문장의 첫 줄과 `application_name` 을 함께 뽑아 본다.
- 규모: M

### ARCH-02 역할 lease 행이 「심장 박동」과 「작업 울타리」를 겸해 직렬화 지점이 됐다
- 심각도: P2 (2차에서 P1 → P2. 실측 몫이 느린 시간의 1.5%(1,879초/일)이고, lock timeout 은 모든 문장을 합쳐 하루 17건뿐이다. 갱신 실패로 재시작된 실례도 확인되지 않았다. 비용이 S 라 순위 1 은 그대로다.)
- 분류: structure
- 위치:
  - `lib/jobs/role-leader.ts:45-56` — `tryAcquireRole` 은 **lease 가 살아 있어도** 매번 `INSERT … ON CONFLICT DO NOTHING` 과 `SELECT … FOR UPDATE` 를 한다. 예비(mini 5역할)는 `scripts/role-worker.ts:371` 에서 5초마다 부른다. versioned 경로(`lib/jobs/batch-repository.ts:160`)도 같은 전체 열 `FOR UPDATE` 다. 그래서 15행 모양은 두 경로 모두에서 나올 수 있다.
  - `lib/jobs/role-leader.ts:96-111` — `renewRole` 은 10초마다 `FOR UPDATE` 를 잡은 뒤 UPDATE 한다(`scripts/role-worker.ts:414-443`, 주기 `:443` `10_000`). `:103` 이 그 `select role … for update` 다(= 18행).
  - `lib/jobs/role-leader.ts:198-211` — 모든 잡 claim 트랜잭션과 도메인 트랜잭션은 같은 행을 `FOR SHARE` 로 잡는다(`lib/jobs/runner.ts:161`, `lib/crawl/translations.ts:311-312` 의 `lockReasonRole` 등).
  - `lib/jobs/batch-repository.ts:21` — 역할 트랜잭션의 lock_timeout 은 5초다.
  - `lib/db/replica.ts:31-34` — `55P03` 는 「끊김(down)」으로 분류되지 않는다.
  ```ts
  // role-leader.ts:53-55 — 살아 있는 주가 있어도 예비가 5초마다 배타 잠금을 요청
  await tx.insert(roleLeases).values({ role: candidate.role }).onConflictDoNothing();
  const [current] = await tx.select().from(roleLeases)
    .where(eq(roleLeases.role, candidate.role)).for('update');
  ```
- 문제: 역할 행 5개에 하루 약 13만 번의 배타 잠금 요청이 몰린다. 예비 5×17,280 + 주 갱신 5×8,640 이다. 이 행은 작업 트랜잭션들이 공유 잠금으로 쥐고 있다.
  - Postgres 의 잠금 줄은 순서대로 선다. 그래서 배타 요청 하나가 앞의 SHARE 보유자를 기다리는 동안 뒤의 SHARE 요청도 모두 그 뒤에 선다. 몇 초마다 작은 convoy 가 생긴다.
  - 주 갱신이 lock_timeout 5초를 넘기면 `55P03` 가 난다. 이 코드는 down 이 아니므로 `renew_failed` 가 된다. 그러면 `lost=true` 가 되어 활성 자식이 강제 중단된다(`scripts/role-worker.ts:431-441`). 일하던 역할이 자기 예비의 폴링 때문에 재시작될 수 있는 구조다.
  - 실측 최대 대기 4,719ms 는 이미 5초 문턱에 닿아 있다.
- 실측 근거:
  - slow-queries 15행: `role_leases … for update`(전체 열 = `tryAcquireRole`) 1,328회, 최대 4,719ms.
  - 18행: `select "role" … for update`(= `renewRole`) 710회, 최대 4,408ms.
  - errors 72행: lock timeout 17건. 어떤 문장인지는 이 집계에 없다.
- 수정 방안(바꿀 구조): 「누가 주인인가(epoch)」와 「아직 살아 있다(lease_until)」를 잠금 모드로 분리한다.
  1. `tryAcquireRole`: 먼저 잠그지 않고 읽는다. `lease_until > now() + 여유` 이고 주인이 내가 아니면 바로 `null` 을 돌려준다. 만료 직전·만료 후에만 지금의 잠금 경로로 들어간다. 예비의 정상 폴링은 평범한 SELECT 가 된다.
  2. `renewRole`: 앞의 `SELECT … FOR UPDATE` 를 빼고 조건부 UPDATE 하나로 바꾼다. 키가 아닌 열만 바꾸므로 `FOR NO KEY UPDATE` 다.
  3. `assertRoleLease`: `FOR SHARE` 를 `FOR KEY SHARE` 로 바꾼다. `FOR KEY SHARE` 는 갱신(NO KEY UPDATE)과 충돌하지 않는다. 반면 소유권 이전(epoch 증가)은 `FOR UPDATE` 를 유지하므로 진행 중인 작업 트랜잭션과 여전히 직렬화된다. 울타리 보장은 그대로다.
- 얻는 것:
  - role_leases 대기 2,038회/일(1,879초)이 거의 0이 된다.
  - 예비의 DB 비용이 「5초마다 배타 잠금 TX」에서 「5초마다 한 줄 읽기」로 준다.
  - 갱신 lock timeout 으로 활성 역할이 재시작될 경로가 사라진다.
  - 이 행을 SHARE 로 쥔 claim TX 가 `jobs` 행을 기다리는 사슬(`runner.ts:155` 의 fence→batch→role→jobs 순서)도 덜 막힌다.
- 옮기는 순서:
  - PR1: 미리 읽기 한 줄만 넣는다. 동작은 같고 잠금만 준다.
  - PR2: 갱신의 `FOR UPDATE` 를 빼고 `assertRoleLease` 를 `KEY SHARE` 로 바꾼다. 둘 다 잠금 모드만 바꾸므로 한 줄로 되돌릴 수 있다. batch(versioned) 경로(`batch-repository.ts:58,202`)도 같은 규칙으로 바꾼다.
- 위험: 넘겨주기(`yieldRoleToPrimary`)와 격리(`quarantine_until`) 쓰기의 잠금 모드를 함께 점검해야 한다. 이 쓰기들이 키 열을 바꾸지 않으면 `KEY SHARE` 와 함께 갈 수 있으므로, 소유권을 바꾸는 쓰기는 반드시 명시적 `FOR UPDATE` 를 먼저 잡게 한다.
- 검증:
  - 통합 시험 `tests/integration/role-worker-process.test.ts`·`role-worker-resilience-process.test.ts` 가 그대로 통과해야 한다.
  - 새 시험을 추가한다. 작업 TX 가 KEY SHARE 를 쥔 동안 갱신은 기다리지 않고, 이전(epoch+1)은 기다려야 한다.
  - 느린 문장의 role_leases 행이 사라졌는지 본다.
  - `worker-exit:*` 관측에서 `leaseCause=renew_failed` 빈도를 본다.
- 배포 주의: 역할 앱 전체를 교체한다(lease 규약 변경). 주·예비가 옛 코드와 새 코드로 섞이는 동안에도 안전하다. 옛 코드의 FOR UPDATE 는 새 코드의 KEY SHARE 와 충돌해 지금처럼 동작할 뿐이다.
- 확신도: 잠금 규약과 호출 빈도는 CONFIRMED. 2차: 예비 5초(`scripts/role-worker.ts:371`)·주 갱신 10초(`:443`)·잠금 5초(`lib/jobs/batch-repository.ts:21`)·`55P03` 가 down 이 아님(`lib/db/replica.ts:31-35`)을 다시 확인했다. role_leases 의 키는 `role` 하나다(`role_leases_pkey`, evidence/indexes-primary.txt). 그래서 lease_until 갱신은 NO KEY UPDATE 이고, KEY SHARE 와 충돌하지 않는다는 전제도 맞다. 단, epoch 를 올리는 이전 UPDATE(`lib/jobs/role-leader.ts:81-86`)도 NO KEY UPDATE 다. 그러므로 울타리 보장은 그 앞의 명시적 `FOR UPDATE`(`:54-55`)를 남길 때만 유지된다. 위험 절의 조건이 필수다. 갱신 실패로 실제 재시작이 났는지는 PLAUSIBLE이다. 확인하려면 `role.renew_unknown` 로그의 `code=55P03` 와 `worker-exit` 관측의 `leaseCause` 를 본다.
- 규모: S

### ARCH-03 모델 장부: 전역 mutex 한 행 아래에 모든 호출의 예약·보냄·정산·도메인 쓰기가 줄 선다
- 심각도: P1
- 분류: structure
- 위치:
  - `lib/llm/capacity-repository.ts:81-85` — `control(tx)` 의 기본값이 `FOR UPDATE` 다. 30곳에서 쓴다(2차 재계산 `await control(tx`. 1차 28곳).
  - `:682-709` — `requestSlot` 이 mutex 아래에서 전역 만료 쓸기, fence 조회, 입장, 부여를 모두 한다.
  - `:161-179` — `expireRequests` 는 모든 장비의 만료 행을 쓴다.
  - `:189-207` — `grantOne` 은 이미 **장비마다** 판정한다. 주석은 「전역·공급자·풀 한도와 class 가중치 순환은 더 읽지 않는다」고 적는다.
  - `:604`·`:1138`·`:1267`·`:1327`·`:1411`·`:1445`·`:1554`·`:1668`·`:1783`·`:1898`·`:2062`·`:2242`·`:2496`·`:2753`·`:3304` — 정산 함수 15개(`reconcile*`, 2차에서 `reconcilePublicationApiTerminal` `:3297` 을 더함. 1차 14개) 전부가 `select id … for update` 를 mutex 로 쓴다. 이 직렬화는 의도된 설계로 적혀 있다(`:158` 「The control mutex serializes every runtime writer」).
  - `:1605-1633` — `lockReasonTranslationModelCapacityDispatch` 를 포함한 11개 `lock*Dispatch`(2차 재계산. 1차 12개 — `lockModelCapacityCallerControl` `:98` 을 더하면 12)가 **도메인 트랜잭션 맨 앞에서** control `FOR UPDATE` 를 잡는다. 커밋까지 쥔다.
  - `lib/crawl/translations.ts:372-395` — 그 TX 안에서 batch 입장, 역할 lease, 캐시 행 잠금, 잡 lease, binding 쓰기, 사건 쓰기가 차례로 이어진다.
  ```ts
  // capacity-repository.ts:81-83
  async function control(tx: ProductTransaction, lock: "share" | "update" = "update") {
    const fenced = !await writerSiteActive(tx);
    const [row] = await tx.select().from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for(lock);
  ```
- 문제: 지금 구조에서 장부의 정합성은 「control 한 행을 배타로 쥔 쪽만 쓴다」에 기대고 있다. 그 결과 다음 일이 생긴다.
  - 서로 다른 장비(gpu3090·M3·M1·게이트웨이)의 호출이 서로를 기다린다.
  - 임계 구역 안에서 도는 느린 문장 하나가 전체 convoy 를 만든다. 예: fence 조회 `logical_member_keys && ARRAY…`(slow 46행), 만료 쓸기.
  - 보냄과 정산은 점유 수를 늘리지 않는데도 같은 줄에 선다.
  - 이 대기가 ARCH-02 의 role·jobs 잠금 사슬로 번진다.
  - 따로, 살아 있는 행(실측 614행: indeterminate 605 + waiting·reserved·dispatched 9)과 14일치 이력(정산 483,751행)이 **한 표**에 있다. 그래서 상태 술어를 부분 인덱스에 맞게 쓰지 않은 조회는 2.4GB 를 통째로 읽는다. 예: `lib/crawl/second-review-stale.ts:179-181` 의 `coalesce(state,'') NOT IN (…)` 는 1,417회에 평균 7.3초다.
- 실측 근거:
  - slow-queries 3·7·8·13·24행: control 잠금 대기 35,291회·36,317초(느린 시간의 29.6%), 최대 5,013ms(lock_timeout 근처).
  - 5행: 장부 전체를 읽는 2차 정리 쿼리 10,292초.
  - pg-stats-primary 8행: `model_capacity_requests` seq_scan 1,756,826회, 읽은 행 5,654억(한 번에 평균 약 32만 행 = 거의 표 전체).
  - crawl-stats 89-97행: 상태 분포.
- 수정 방안(바꿀 구조): **점유를 늘리는 전이만 장비 단위로 직렬화한다.**

  | 전이 | 점유 변화 | 필요한 잠금 |
  |---|---|---|
  | waiting→reserved(부여) | 늘어남 | 그 장비의 잠금(`pg_advisory_xact_lock(hashtext('cap:'||group_id))` 또는 `model_capacity_devices` 행) + control `FOR SHARE` |
  | reserved→dispatched(보냄) | 같음(`grantOne` 주석의 「점유 = reserved·dispatched + 유지 시간 안 indeterminate」) | 요청 행 `FOR UPDATE` + control `FOR SHARE`(세대·정책 확인) + 멤버 키 겹침 울타리(정렬된 멤버 키 advisory 잠금 또는 기존 고유 부분 인덱스) |
  | dispatched→settled/withdrawn/expired(정산·만료) | 줄어듦 | 요청 행 `FOR UPDATE` 만. 동시에 부여가 옛 점유를 세면 덜 부여할 뿐, 넘치게 부여하지 않는다 |
  | 정책·모드 변경(관리자) | — | control `FOR UPDATE`. 런타임 SHARE 와 충돌하므로 진행 중인 런타임 TX 가 끝나야 바뀐다. 지금과 같은 보장이다 |

  - 만료 쓸기는 장비별 부여 TX 안에서 그 장비 것만 한다. 또는 maintenance 의 `model-capacity-reclaim` 이 `SKIP LOCKED` 로 맡는다.
  - 2단계(선택): 살아 있는 행과 이력을 나눈다. `model_capacity_requests` 에는 waiting·reserved·dispatched·indeterminate 만 두고, 끝난 행은 `model_capacity_history`(append-only)로 옮긴다. 기존 보관 잡(`lib/jobs/db-retention.ts` ledger 부분)이 옮기는 일을 맡는다. 그러면 어떤 술어로 써도 살아 있는 표는 1천 행 안팎이다.
- 얻는 것(추정):
  - 보냄·정산·SHARE 대기(slow 7·8·13행, 15,501회·15,930초)는 런타임에 배타 잠금을 쥐는 쪽이 없어지므로 거의 0이 된다.
  - 남는 19,640회(20,254초, 3행 = `control(tx)` 기본 FOR UPDATE)는 부여와 보냄이 섞여 있다. 보냄 몫이 빠지고 부여 몫은 장비 수만큼 나뉜다.
  - 합쳐서 control 대기 **−44~80%(하루 약 1.6만~2.9만 초)** 로 본다. 1차는 −60~80%(2.2만~2.9만 초)였다.
    - 2차에서 아래 끝을 넓혔다. 3행의 부여·보냄 비율과 장비별 호출 분포는 실측이 없다.
    - 호출이 한 장비에 몰리면(예: 1차 심사 시도의 대부분이 한 공급자 — crawl-stats 75-87행) 부여는 그 장비 잠금에서 그대로 줄을 선다. 이때 확실히 빠지는 것은 7·8·13행(15,930초 = control 대기의 44%)뿐이다.
    - 또 SHARE 대기(8·13행)는 PR2 만으로는 없어지지 않는다. `requestSlot` 이 FOR UPDATE 로 남아 있는 동안(PR3 전)에는 SHARE 쪽이 그 뒤에 계속 선다.
  - 2단계까지 하면 장부 seq scan 읽기(5.6일 5,654억 행)가 사실상 사라진다. 장부를 읽는 2차 정리 쿼리(10,292초) 같은 부류도 다시 생길 수 없다.
  - 모두 같은 slow-log 집계로 확인할 추정치다.
- 옮기는 순서(각 PR 은 잠금 모드만 바꾸므로 한 커밋으로 되돌릴 수 있고, 스키마 변경이 없다):
  - PR1: 정산 함수 15개의 `select id … for update` 를 없앤다. 요청 행 잠금만 남긴다. 가장 기계적이고 효과가 바로 보인다.
  - PR2: 11개 `lock*Dispatch`(+`lockModelCapacityCallerControl`)의 `control(tx)` 를 `control(tx, "share")` 로 바꾸고, 멤버 키 울타리를 advisory 잠금으로 바꾼다.
  - PR3: `requestSlot` 의 전역 mutex 를 장비 잠금으로 바꾼다. `handOverRankWaiting`(`:728-739`, 두 장비의 대기 행을 함께 만짐)은 두 장비 잠금을 정해진 순서로 잡는다.
  - PR4(소유자 결정 뒤): 살아 있는 행과 이력을 가르는 마이그레이션.
  - ARCH-07(공통 생애 주기)을 PR2 앞에 하면 12곳을 한 곳에서 바꿀 수 있다.
- 위험·하지 말 것:
  - 이 모듈은 「같은 일이 두 번 보내지지 않음」을 보장하는 핵심이다. 직렬화 가정이 숨어 있는 곳이 있다. 예: `:737` 「control FOR UPDATE 아래라 그 사이 다른 TX 가 그 대기 행을 예약하거나 보낼 수 없고」. PR 마다 그 가정을 찾아 장비 잠금이나 행 잠금으로 옮겨야 한다. 직렬 장부 통합 시험 21개 파일(`scripts/integration-shards.mjs:23` SERIAL_FILES. 2차 재계산 — 1차의 34개는 틀림)이 계약 시험이다.
  - DR fence 가 첫 잠금이라는 순서(`:79`)는 그대로 둔다.
  - **Valkey 토큰 버킷으로 옮기는 안은 권하지 않는다.** 장부 쓰기가 도메인 행·잡 lease·DR fence 와 **한 트랜잭션**으로 커밋된다는 성질 위에 「보낸 증거」·미확정 처리가 서 있다(`translations.ts:372-395`). Valkey 는 그 원자성 밖이다. 하루 호출 수만(약 0.4건/초) 규모에는 처리량 이득도 없다.
  - **낙관적 버전(CAS)만으로 바꾸는 안도 권하지 않는다.** 부여는 「장비 점유 수를 센 뒤 쓰기」라 행 하나의 버전으로는 경합을 막지 못한다.
- 검증:
  - 직렬 장부 시험 전부를 통과해야 한다.
  - 새 동시성 시험을 추가한다. 다른 장비의 부여 두 개가 서로 기다리지 않고, 같은 장비의 부여는 한도를 넘지 않아야 한다.
  - 운영 지표: slow-log 의 control 모양 횟수·합계, `settle_lock_*` 로그, 장부 seq_scan 증가 속도.
- 배포 주의: 모델을 부르는 모든 앱을 같은 릴리스로 맞춰야 한다. 옛 코드의 FOR UPDATE 와 새 코드의 SHARE 는 함께 있어도 안전하지만 이득은 다 바뀐 뒤에 나온다. 그래서 DRAIN 창 안에서 바꾼다. PR4 는 마이그레이션이며 DRAIN 뒤에 적용한다(memory 의 CHECK 재구성 교훈).
- 확신도: 직렬화 구조와 대기 실측은 CONFIRMED. 2차: 3·7·8·13·24행의 합 35,291회·36,317초(29.6%)를 다시 계산해 맞았다. 정산 15·dispatch 11·`control(tx)` 30곳으로 개수를 고쳤다. 「보냄·정산은 전역 잠금이 필요 없다」는 판단은 점유 정의(`:181-187` 주석)를 읽고 내린 PLAUSIBLE이다. `event()` 기록 순서처럼 mutex 에 기대는 곳이 더 있는지는 보지 못했다. 「얻는 것」은 범위로 넓혔다(위).
- 규모: L(PR1·2 는 각 S~M)

### ARCH-04 「할 일」을 이력에서 매번 유도한다 — 전이 때 채우는 대기열 + 드문 대조기로
- 심각도: P1
- 분류: structure
- 위치:
  - 발행: `lib/crawl/jobs/publish.ts:115-124` 가 승인 후보마다 `reviewApprovalPredicate`(`lib/crawl/agent-review-repository.ts:432-445`)를 평가한다. 이 술어는 1차 시도·2차 표(`secondApproved` `:400-415`)·대체 모델·별 자동 승인(`:448-468`, crawl_documents 의 jsonb 비교) 상관 서브쿼리를 모두 포함한다. 틱마다 예산이 다할 때까지 다시 고른다.
  - 1차 대기열: `reviewCandidatePredicate` `:819-864`. 상관 서브쿼리 10개 안팎(attempts·documents·scans·item lease·jobs)이다.
  - 규칙 판정: `lib/crawl/repository.ts:787-811`. `crawl_documents LEFT JOIN crawl_candidates WHERE c.id IS NULL OR …` 로 106만 × 106만을 anti-join 한다.
  - 사유 번역 대기: `lib/operations/text-stage-progress.ts:35-39`. 40만 사유마다 sha256 을 계산해 GROUP BY 한다.
  - 2차 정리: `lib/crawl/second-review-stale.ts:245-260`.
  - 그런데 「누가 일하나」를 정하는 lease 는 이미 있다. `claimItemLease`(`lib/jobs/items/repository.ts:100`)가 정해진 작업 키의 행을 advisory 잠금 뒤 `FOR UPDATE SKIP LOCKED` 로 집는다(`:114·120`. 2차 정정: 「다음 N개 고르기」가 아니라 키 하나의 소유권 잠금이다). 「다음 할 일 고르기」 꼴의 `SKIP LOCKED` 는 `lib/crawl/agent-review-repository.ts:552`·`lib/me/email-outbox.ts:201` 에 있다. 비어 있는 것은 「무엇이 할 일인가」를 담는 대기열이다.
- 문제: 지금 구조는 「대기열 = 원천 표들에 대한 술어」이다. 대기 건이 적어도(발행 대상 `approved` 약 590건, needs_review 약 5,300건 — crawl-stats 16-49행) 매번 106만 후보·106만 원본·36만 시도·20만 표를 훑는다. 같은 술어를 잡(선택)·진행 감시(ARCH-01)·관리자 화면이 각자 다시 평가한다. 술어가 복잡해질수록 planner 가 seq scan 을 고르는 일이 늘고, 이는 운영에서만 드러난다(`throughput.ts:59-60` 주석: JIT 하나로 7.3초).
- 실측 근거: 느린 시간의 67.3%(82,623초)가 이 부류다. 큰 넷은 다음과 같다.

  | 유도 조회 | slow 행 | 합계 초 |
  |---|---|---:|
  | 발행 술어 | 2·10행 | 34,309 |
  | 사유 번역 | 4·11행 | 19,651 |
  | 2차 정리 | 5행 | 10,292 |
  | 규칙 판정 | 6행 | 8,871 |
  | 합 | | **73,123(59.5%)** |

  seq scan 누적(pg-stats-primary 9·10·13·14행): crawl_candidates 3,370억 행, crawl_documents 2,328억, second_reviews 1,179억, crawl_review_attempts 756억.
- 수정 방안(바꿀 구조): 「대기열 행 = 선택, 술어 = 검증」으로 뒤집는다.
  1. **선택은 대기열 행에서 한다.** 항목이 할 일이 되는 전이(1차 승인 기록, 2차 합의, 분류 결정, 원본 수집 완료, 사유가 있는 시도 완료)가 **같은 트랜잭션** 안에서 대기열 행을 쓴다. 구현은 표의 `ready_at` 칸 + 부분 인덱스이거나 작은 대기열 표다. 입력이 바뀌는 전이(원본 변경, 사람 결정)는 그 행을 지운다. 이 코드베이스는 이미 `requestJob(…, tx)` 로 「같은 TX 에서 잡 깨우기」를 한다(`agent-review-repository.ts:515`). 같은 자리에 항목 단위 한 줄을 더하는 것이다.
  2. **검증은 그 행 하나에 대해서만 한다.** 잡은 대기열에서 `ORDER BY ready_at LIMIT n FOR UPDATE SKIP LOCKED` 로 집고, 지금의 술어를 **그 행 하나**에 대해서만 다시 평가한다. 발행 TX 는 이미 잠근 행으로 관문을 다시 잰다(`agent-review-repository.ts:447`의 「the publication transaction repeats this check against locked rows」). 따라서 잘못 들어간 대기열 행은 발행되지 않고 지워질 뿐이다. 안전 방향이다.
  3. **대조기를 둔다.** 지금의 전체 유도 조회는 10~15분마다 한 번만 돈다. 대기열에 빠진 것은 넣고, 남은 것은 지운다. 차이 건수를 관측에 남긴다. 빠진 전이가 있어도 늦어질 뿐(최대 대조 주기) 틀리지 않는다.
  4. 적용 순서는 얻는 것이 큰 차례다.
     - (a) 사유 번역: `text_translations(source_hash, 'ko')` 에 사유가 생길 때 `pending` 행을 upsert 하는 원천 등록 표로 바꾼다. 대기 = 인덱스 계수다.
     - (b) 발행 준비: `crawl_candidates.publish_ready_at` + 부분 인덱스.
     - (c) 규칙 판정: crawl-fetch 가 원본을 쓸 때 후보 행을 `state='new'` 로 upsert 한다. 그러면 anti-join 이 `state='new'` 부분 인덱스 스캔으로 바뀐다.
     - (d) 2차 정리: 정리 대상 표식을 전이에서 쓴다.
- 얻는 것: 큰 넷(73,123초/일, 59.5% — 2차 재계산으로 같음: 2·10행 34,309 + 4·11행 19,651 + 5행 10,292 + 6행 8,871)이 「인덱스로 몇 행 집기 + 대조기 하루 100~150회」로 바뀐다. 느린 문장 시간 **약 −55%** 를 기대한다(네 대기열을 모두 끝냈을 때).
  - 2차 점검: 대조기가 지금의 무거운 조회를 하루 96~144번 그대로 돌린다고 하자(네 조회 평균 합 약 15.5초). 그러면 하루 약 1,500~2,200초가 남아 −56~58% 다. 1차 −55% 와 맞는다.
  - 적용 순서상 앞의 둘(사유 번역·발행)만 끝낸 단계에서는 약 −42%(53,960초에서 대조기 몫을 뺌)다.
  - 사유 번역 19,651초는 모두 진행·감시 읽기(4·11행)다. 그래서 ARCH-01 의 −1.3만 초와 겹친다. 두 제안의 효과를 더하지 않는다. 대기 건수와 나이는 대기열 표의 계수로 몇 ms 안에 나온다. 그러면 ARCH-01 의 보고서 계산도 함께 가벼워진다.
- 옮기는 순서(대기열마다 같은 3단계):
  - ① 그림자: 전이에서 대기열 행을 쓰되 아무도 읽지 않는다. 대조기가 차이를 센다.
  - ② 읽기: 잡이 대기열로 고르고, 술어는 검증에만 쓴다. env 스위치로 옛 선택 경로에 돌아갈 수 있다.
  - ③ 옛 선택 경로를 지운다.
  - 각 단계는 독립 PR 이고, ①은 마이그레이션(칸·인덱스 추가)뿐이라 되돌리기가 쉽다.
- 위험·하지 말 것:
  - 전이 지점을 빠뜨리는 것이 가장 큰 위험이다. 대조기가 차이를 세고 그 건수에 경보를 걸어 드러낸다.
  - 대기열을 **유일한 진실**로 만들지 않는다. 원천 표와 술어가 진실이고 대기열은 색인이다.
  - 외부 메시지 브로커로 대기열을 옮기지 않는다(ARCH-10).
  - LISTEN/NOTIFY 로 깨우기는 이 단계에 필요 없다. 깨우기는 이미 `requestJob` + 5초 폴링(`scripts/worker.ts:130`)으로 충분하다. 비용은 깨우기가 아니라 「무엇을 할지 계산하기」에 있다.
- 검증:
  - 그림자 단계에서 대조기 차이가 며칠 동안 0인지 본다.
  - 잡별 통합 시험(발행: `tests/integration/*publish*`, 사유 번역 직렬 ledger 시험)을 돌린다.
  - slow-log 에서 해당 모양이 사라졌는지 본다.
  - `crawl_candidates`·`crawl_documents` seq_tup_read 증가 속도를 본다.
- 배포 주의: ①마다 마이그레이션이 있다(칸·부분 인덱스). 새 칸을 읽는 코드는 마이그레이션 뒤에 둔다(memory 의 「새 칸 마이그레이션은 이전 코드로 DRAIN」). 대조기는 기존 잡 안의 부분으로 둔다. 새 카탈로그 잡이면 scheduler 를 먼저 배포한다.
- 확신도: CONFIRMED(유도 조회 위치·호출 경로·실측 대응). 2차: 2·10행이 발행 잡 `listCandidates(["approved"], …)`(`lib/crawl/jobs/publish.ts:115-124`)임을 다시 확인했다. 대기 건수(approved 589, needs_review 5,324 — crawl-stats 16-49행)도 맞다. −55% 는 네 대기열 완료를 가정한 추정이고, 단계별 범위를 위에 적었다.
- 규모: L(대기열마다 M)

### ARCH-05 배포 범위 분류기가 런타임 경계를 모른다 — 이미지 내용 + import 그래프로 판정
- 심각도: P2
- 분류: structure
- 위치:
  - `scripts/ops/deployment_scope.py:140-160` — CSS·공개 자산·웹 문구 7개 이름 공간 말고는 모두 `unclassified_runtime_change` 로 보아 **18앱 전체**를 고른다. `app/**`·`components/**` TSX 도 마찬가지다.
  - `Dockerfile:57-63`(worker)·`:83-86`(monitor) — 두 이미지는 `lib`·`scripts`·`drizzle`·`messages` 만 복사한다. `app/`·`components/` 는 **이미지에 없다**.
  - `docs/operations/2026-11-06-deployment-fast-routes.md` — 「추가 구현 필요: … 실제 runtime import 와 worker·scheduler·job registry 영향을 조사하고」.
  ```py
  # deployment_scope.py:158-160
  # lib/jobs/registry.ts eagerly imports every handler, and HTTP cron also
  # consumes that registry. Handler filenames alone never prove role isolation.
  return None, 'unclassified_runtime_change'
  ```
- 문제: 화면만 바꾼 PR 도 18앱 배포와 모델 앱 DRAIN 창을 거친다(문서 `docs/operations/2026-11-06-deployment-fast-routes.md:73-83`: 실측 한 사례 「첫 실행 → 작업 재개 약 26분」, 빠른 인계가 생기면 「약 10~15분」 추산. 1차의 「14~30분」은 문서에 없는 값이라 고쳤다). 위 주석의 근거와 실제 코드가 다르다.
  - HTTP cron 은 레지스트리를 import 하지 않는다. `app/api/cron/[job]/route.ts:2-3` 은 `catalog`·`control` 만 쓴다.
  - 웹에서 `lib/jobs/registry.ts` 로 가는 정적 경로는 없다(아래 그래프에서 확인).
  - 워커·감시는 tsx 로 **소스를 그대로** 실행한다. 그래서 실행되는 파일 집합은 진입점의 import 그래프로 정확히 정해진다. 웹은 빌드 때 번들링한다.
- 실측 근거(코드·git 근거). 정규식 import 그래프로 측정했다. `import type` 은 뺐고, 비리터럴 동적 import 는 0건(주석 1건 오검출)이었다. 진입점: worker = `worker-supervisor`·`role-worker`·`worker`·`scheduler`·consumer 6개·`connect-agent`·`migrate.mjs`, monitor = `watch-failover-readiness`·`monitor-healthcheck`.
  - lib 파일 1,066개의 도달 범위:

    | 범위 | 파일 | 줄 |
    |---|---:|---:|
    | 웹 전용 | 251 | 30,279 |
    | 워커 전용 | 164 | 24,418 |
    | 웹+워커 | 159 | 23,660 |
    | 셋 모두 | 415 | 71,014 |
    | 어디서도 안 닿음(운영 도구 전용 등) | 73 | 10,423 |

  - 워커·감시에서 닿는 `app/`·`components/` 파일은 **0개**다.
  - 최근 first-parent 병합 100개(11-09~11-19)를 분류했다.

    | 분류 방식 | full | 웹 전용 | 없음 |
    |---|---:|---:|---:|
    | 지금 분류기 | 97 | 1 | 2 |
    | 이미지+그래프 증명 | 69 | **19** | — |

    - 웹 전용 19개: #979 #974 #975 #971 #968 #966 #951 #933 #929 #930 #926 #907 #906 #902 #892 #889 #884 #874 + 직접 커밋 246d3993.
    - 이 가운데 7개는 lib 를 건드리지 않아 Dockerfile 만으로도 증명된다(`app`·`components` 만 바꿈).
    - 나머지 12개는 웹 전용 lib 파일을 포함해 그래프 증명이 필요하다.
    - `scripts/ops/` 만 바꾼 PR 5개도 지금은 full 이다.
    - (2차 재현) 같은 방식의 정규식 그래프를 따로 짜서 다시 계산했다(진입점: worker 13개·monitor 2개, `import type` 제외, 주석 제거, `@/`·상대 경로·`import("…")` 해석).
      - worker 가 닿는 lib 는 738개다(1차 표의 워커 전용 164 + 웹+워커 159 + 셋 모두 415 = 738 과 같다). monitor 가 닿는 lib 는 419개다. 두 집합 모두 `app/`·`components/` 파일은 0개다.
      - 표본 8개의 바뀐 파일을 직접 대조했다: #926 `9ea57b1f`, #933 `d4d70685`, #974 `1791d70d`, #902 `afb8eae6`(`lib/operations/admin-runtime-settings.ts`), #874 `c7d2acab`(`lib/llm/capacity-retire.ts`·`lib/operations/admin-capacity-retire.ts`), #930 `68e42d8c`, #884 `23f9eee5`, #971 `2296c2c5`. 모두 worker·monitor 도달 집합 밖이다.
      - `docker exec` 로 워커 컨테이너에서 도는 운영 CLI 도 따져 보았다. `scripts/**` 의 모든 `.ts`·`.mjs` 를 진입점으로 넣어도(도달 955파일) 19개 PR 의 바뀐 파일은 하나도 닿지 않는다.
      - 1차의 「지금 분류기 97·1·2」는 분류기를 실행해야 해서(실행 금지) 재현하지 않았다. 규칙(`scripts/ops/deployment_scope.py:140-160`)상 app TSX 가 full 이 되는 것은 확인했다.
- 수정 방안(바꿀 구조):
  1. (S) `app/**`·`components/**` 의 TSX·TS 를 웹으로 분류한다. 근거는 두 가지다. Dockerfile 의 worker·monitor COPY 목록에 그 폴더가 없다. lib·scripts 가 그 폴더를 값으로 import 하는 곳 7개(`lib/me/inbox.ts:2`, `lib/domain/products/detail-page-data.ts:3-5` 등)는 모두 워커·감시에서 닿지 않는다. 그 성질은 lint 규칙(ARCH-06)으로 묶는다.
  2. (M) CI 가 정확한 트리로 `runtime-reach.json` 을 만든다. tsx 와 같은 해석(esbuild `--bundle --metafile --packages=external` 또는 TS 모듈 해석)으로 worker·monitor 진입점이 닿는 소스 목록을 뽑는다. 실행 중 파일 읽기(`messages/**` 를 `lib/me/email-copy.ts` 가 늦게 읽는다)는 명시 목록으로 더한다. 이미지 영수증과 같은 SHA·트리에 결속한다. 분류기는 다음처럼 판정한다.
     - 「바뀐 파일 ∩ worker 도달 = ∅ 이고 ∩ monitor 도달 = ∅」이면 웹 전용이다.
     - monitor 만 닿으면 monitor 를 더한다.
     - 목록이 없거나 해시가 맞지 않으면 지금처럼 full 이다(fail-closed).
  3. scheduler 진입점은 worker 집합에 포함한다(`scheduler.ts` 는 worker 이미지에서 돈다).
- 얻는 것:
  - 최근 실적 기준 PR 의 **19%** 가 웹 2앱 배포로 끝난다. 문서 추산으로 웹 전용 배포는 2~3분이다. 전체는 빠른 인계가 생긴 뒤 추산 10~15분, 실측 한 사례 약 26분이다. 그러니 웹 전용 배포 한 번에 **약 7~24분**과 모델 작업 중단(DRAIN)이 준다(2차 정정. 1차 11~27분).
  - 11일(11-09~11-19)에 19개, 하루 약 1.7개다. 배포를 PR 하나씩 했다면 하루 **약 0~40분**의 배포 창이 준다(2차 정정. 1차 20~50분). 아래 끝이 0 인 까닭이 있다. 실제 배포 창은 여러 PR 을 묶어 하므로, 묶음 안에 full 변경이 하나라도 있으면 절약이 없다.
  - 웹이 모델 호출을 쥐는지는 지금 plan 이 판정한다. 웹 2앱만 바꿀 때 DRAIN 이 필요 없다는 판정은 plan 의 기존 규칙을 따른다.
  - ARCH-06 으로 웹+워커 공유 파일이 줄면 비율이 더 오른다.
- 옮기는 순서:
  - PR1: 1번 규칙과 분류기 단위 시험. 최근 100개 표본을 시험 고정값으로 넣는다.
  - PR2: CI 의 도달 목록 생성과 아티팩트 결속.
  - PR3: 분류기가 목록을 읽게 한다.
  - 각 단계에서 분류기 판정이 「좁힐 수만 있고 증명이 없으면 full」이므로 되돌리기는 규칙 한 줄이다.
- 위험: 웹 전용으로 나간 관리자 화면이 **새 설정 모양**을 쓰는데 옛 워커가 그것을 못 읽는 경우가 있을 수 있다. 다만 설정 스키마(`lib/operations/runtime-settings-schema.ts`, `lib/crawl/settings-schema.ts`)는 워커 도달 파일이다. 그것을 바꾸는 PR 은 자동으로 full 이 되므로 그래프가 이 경우를 막는다.
- 검증:
  - 분류기 시험에 위 19개 PR 의 실제 경로 목록을 넣는다.
  - CI 가 만든 도달 목록과 이미지 안 파일 목록(`docker run … find lib scripts`)을 대조한다.
  - 첫 몇 번의 웹 전용 배포 뒤 워커의 `release` 가 그대로이고 경보가 없는지 본다.
- 배포 주의: 배포 도구 파일 변경이다. memory 의 「plan 거절 group_writable = umask」 교훈대로 실행 폴더 권한을 확인한다.
- 확신도: CONFIRMED(Dockerfile COPY, 그래프 계산, git 표본). 2차: `Dockerfile:57-63`·`:83-86` 이 `lib`·`scripts`·`drizzle`·`messages`(monitor 는 `lib`·`scripts`)만 복사함을 다시 확인했다. 그래프를 따로 재현해 도달 수(738·419)와 표본 8개가 맞았다. 절약 시간은 범위로 고쳤다. 정규식 그래프에는 한계가 있으므로 PR2 는 esbuild 의 정확한 해석으로 대체한다.
- 규모: M(PR1 은 S)

### ARCH-06 도메인 모듈이 읽기·잡 쓰기·장부를 한 파일에 섞어, 공개 화면이 워커 코드 455개 파일에 묶인다
- 심각도: P2
- 분류: structure
- 위치:
  - `app/(public)/[locale]/(content)/p/[slug]/page.tsx:30,62` — 공개 상세가 `readProductTranslationReadiness` 하나를 쓰려고 `lib/domain/products/translations.ts` 를 import 한다. 이 파일은 `:9-24` 에서 잡 lease·역할 lease·batch 입장·장부(`lockModelCapacityCallerControl`·`lockProductTranslationModelCapacityDispatch`)를 import 한다. 그래서 공개 상세의 서버 코드가 `lib/llm/capacity-repository.ts`(3,392줄)까지 닿는다.
  - `lib/jobs/control.ts:10` — `requestJob` 모듈이 `pipeline-replay-execution` 을 import 한다. 그 모듈이 다시 1차 심사 저장소(`lib/crawl/agent-review-repository.ts`)를 끌어온다. HTTP cron 경로가 이 사슬로 심사 저장소에 닿는다.
  - `lib/operations/` 250개 파일이 평평하게 놓여 있다. 이름으로 묶으면 다음과 같다.

    | 묶음 | 파일 | 줄 |
    |---|---:|---:|
    | 읽기 모델(view/read/query/progress) | 59 | 10.3k |
    | 관리자 명령(`admin-*`) | 50 | 9.5k |
    | 측정·replay | 31 | 6.9k |
    | 모델 운영 | 30 | 5.4k |
    | 그 밖 | 76 | 10k |
    | `dr/` | 25 | 2.1k |

  - 핵심 코드가 `lib/operations` 를 기반 계층처럼 import 한다. `dr/epoch` 38회, `admin-log` 18, `runtime-settings-store/schema` 29, `instance`, `observations`, `credential-vault`, `cli-host-*` 가 그렇다.
  - 최상위 폴더 사이에 순환이 있다: crawl↔domain(61/47 파일), crawl↔operations(49/69), domain↔operations(24/50), jobs↔{crawl,domain,operations,llm}, llm↔{domain,operations,crawl}.
  - `lib/db/replay-scope.ts:5-6` — 스키마 층이 replay 실행 코드를 값으로 import 한다.
  - 경계 lint 규칙이 없다(`eslint.config.mjs` 는 next 기본만 쓴다).
- 문제:
  - 공개 웹이 닿는 lib 569개 파일(84.7k줄) 중 **455개가 워커도 닿는 파일**이다(2차 재현: `app/(public)/**` 만 진입점으로 하면 514개·79.9k줄 중 444개다. 진입점 집합에 따라 다르지만 규모는 같다. 공개 상세가 `lib/llm/capacity-repository.ts` 에 닿는 것도 재현됨). 그래서 번역 잡을 고치는 PR 이 공개 상세 서버 번들을 바꾼다. 반대로 화면을 고치는 PR 이 워커 배포를 부른다(ARCH-05).
  - 감시가 닿는 lib 는 419개 파일·71.6k줄이다. 감시는 집계 몇 개만 읽는데 핵심 코드 거의 전부와 함께 배포된다.
  - 최근 100 PR 에서 가장 많이 바뀐 파일은 `capacity-repository.ts`(11회)이고, 다음이 `admin-ai-tasks.ts`(10)·`runtime-settings-schema.ts`(9)다. 모두 셋 모두 도달하는 파일이다.
- 실측 근거: 코드·git 근거만(위 그래프·`git log --first-parent -100`).
- 수정 방안(바꿀 구조). 기준은 「누가 실행하나」다.
  1. 도메인 모듈을 `*-read.ts`(SELECT·화면 모양 변환, 잡·장부 import 금지)와 `*-job.ts`·`*-write.ts` 로 나눈다. 첫 대상은 공개 웹이 닿는 워커 파일 중 import 수가 많은 것이다. `products/translations`, `products/repository`(1,021줄), `products/detail-view`, `i18n/products`.
  2. 기반 기능을 `lib/platform/`(이름은 예시)으로 옮긴다. 대상은 `dr/epoch`·`admin-log`·`runtime-settings-*`·`observations`·`instance`·`credential-vault`·`cli-host-*` 다. 그러면 `lib/operations` 는 관리자 화면과 감시만 import 하는 **잎**이 된다.
  3. `lib/jobs/control.ts` 의 replay 결속을 주입식(등록 hook)으로 바꿔 import 사슬을 끊는다.
  4. 경계 규칙을 둔다(eslint `no-restricted-imports` 또는 dependency-cruiser).
     - `app/(public)/**` 와 `*-read.ts` 는 `lib/llm/capacity*`·`lib/jobs/*`(catalog 제외)를 import 하지 않는다.
     - `lib/**` 는 `app/**`·`components/**` 를 값으로 import 하지 않는다.
     - `lib/db/**` 는 타입만 import 한다.
     - 처음에는 warn, 위반이 0이 되면 error 로 올린다.
- 얻는 것:
  - ARCH-05 의 웹 전용 비율이 19%보다 오른다. 공유 파일이 웹 전용·워커 전용으로 옮겨 가기 때문이다.
  - 공개 서버 번들과 콜드 스타트가 줄 것으로 추정한다(측정 필요).
  - 화면 작업과 잡 작업이 같은 파일에서 충돌하는 일이 준다.
  - 순환이 끊기면 폴더 단위로 「무엇이 무엇에 기대는가」를 읽을 수 있다. 새로 온 개발자나 에이전트가 길을 잃는 비용이 준다.
- 옮기는 순서:
  - PR 마다 **동작을 바꾸지 않는 이동** 하나만 한다(파일 분리 + import 갱신, 다시 내보내기 없음).
  - 이동이 끝난 영역부터 lint 규칙을 켠다.
  - 순서: translations → products/repository → detail-view → platform 이동 → jobs/control 결속 끊기 → lint error.
- 위험: 이동 PR 은 diff 가 커서 병렬 작업과 충돌하기 쉽다. 한 번에 한 모듈만, 작업이 적은 시간에 병합한다. 다시 내보내기(re-export) 층을 두면 그래프가 다시 엉키므로 두지 않는다.
- 검증:
  - 이동 PR 마다 typecheck·전체 unit 를 돌린다.
  - ARCH-05 의 도달 목록에서 공유 파일 수가 단조로 감소하는지 본다.
  - 공개 상세 경로가 `capacity-repository.ts` 에 닿지 않는지 도달 목록으로 확인한다.
- 배포 주의: 일반 배포(이동 PR 은 lib 변경이라 full).
- 확신도: CONFIRMED(import 사슬을 그래프와 파일로 확인함). 2차: 감시 도달 419파일·71.6k줄을 따로 짠 그래프로 똑같이 재현했다. 공개 웹 수치는 진입점에 따라 514~569개다.
- 규모: L(점진, PR 마다 S)

### ARCH-07 장부 저장소가 작업마다 같은 생애 주기를 복사해 3,392줄·84개 export 가 됐다
- 심각도: P2
- 분류: structure
- 위치: `lib/llm/capacity-repository.ts` — export 84개.
  - `request*Slot / lock*Dispatch / finish*Dispatch / reconcile*Terminal (/read*Continuation)` 묶음이 작업마다 반복된다. ai1·ai1Item·ai2Item·textProfile·reasonTranslation·productTranslation·productTaglineKo·crawlTagline·searchVerify·websearchQuery·cli·publicationApi·local 이다.
  - 예: `:1591-1705`(사유 번역)과 `:1706-1820`(제품 번역)은 이름만 바꿔 비교하면 차이가 거의 없다(diff 로 확인).
  - `requestFenced` `:713-726` 은 routeId·접두어로 분기하는 사슬이다.
- 문제: 새 AI 작업 하나를 더할 때마다 이 파일에 함수 4~5개가 늘고, binding kind·고유 인덱스·CHECK 분기가 붙는다. ARCH-03 같은 잠금 규약 변경도 12곳을 똑같이 고쳐야 한다. 하나를 빠뜨리면 그 경로만 옛 규약으로 남는다. 최근 100 PR 에서 가장 자주 바뀐 파일(11회)이고, 감시·공개 상세까지 닿아 모든 변경이 full 배포다(ARCH-05·06).
- 실측 근거: 코드·git 근거만.
- 수정 방안(바꿀 구조):
  - `defineCapacityTask({ routeId, kind, bindingSchema, identity(value, members), memberKeys(members), fence })` 를 둔다. 그 위에 공통 `request / lock / finish / reconcile` 을 얹는다.
  - 작업별 차이는 다음 세 가지뿐이므로 작업 파일(`lib/llm/capacity-tasks/<task>.ts`)로 옮긴다.
    - binding zod 스키마
    - logical key·member key 규칙
    - 고유 인덱스 이름
  - 공통부만 장부 행과 잠금을 만진다.
- 얻는 것: 파일이 약 1,500~2,000줄 줄 것으로 추정한다(작업당 약 115줄 × 12 중 공통부). 새 작업은 작업 파일 하나와 마이그레이션 하나로 끝나 핵심 파일을 건드리지 않는다. ARCH-03 의 PR2·3 을 한 곳에서 할 수 있다.
- 옮기는 순서:
  - ① 공통 함수를 추가하고 작업 하나(사유 번역)만 옮긴다. 직렬 ledger 시험을 계약 시험으로 쓴다.
  - ② 작업을 하나씩 옮긴다. PR 하나에 작업 하나이고, 옛 export 는 그 PR 에서 지운다.
  - ③ `requestFenced` 분기를 작업 등록표로 바꾼다.
- 위험: 작업별로 미묘하게 다른 검사가 숨어 있을 수 있다. 예: crawl tagline 의 부모 요청, websearch 의 캐시 멤버. 옮기기 전에 두 블록의 diff 를 PR 설명에 붙여 「다른 점 = 어댑터로 옮긴 것」을 보인다.
- 검증:
  - 직렬 장부 시험 21개 파일(2차 재계산. 1차 34개는 틀림)과 작업별 통합 시험을 돌린다.
  - 옮긴 작업의 운영 장부에서 `*_capacity_identity` 오류가 0인지 본다.
- 배포 주의: 모델을 부르는 앱 전부를 같은 릴리스로 맞추고 DRAIN 창에서 바꾼다(동작 같음, 코드 경로 변경).
- 확신도: CONFIRMED(반복 구조). 줄 수 감소는 추정이다. 2차: export 함수 84개(`^export (async )?function`), 3,392줄, `:1591`·`:1706` 시작 줄을 다시 확인했다.
- 규모: L

### ARCH-08 뜨거운 행과 차가운 이력·넓은 jsonb 를 한 표에 둔다
- 심각도: P2
- 분류: structure
- 위치·실측(pg-stats-primary 8-16행):

  | 표 | 크기 | 행 | 문제 |
  |---|---:|---:|---|
  | `products` | 1,402MB | 115k | 5.6일 갱신 704,214회 중 HOT 2,202회(0.3%). 인덱스 14개(2차: evidence/indexes-primary.txt 의 실제 목록. 칸이 바뀌면 HOT 이 불가능해지는 `products_public_stars_idx`(stars)·`products_repo_check_idx`(repo_checked_at)·`products_search_idx`(search_vector) 등 포함). 잡이 고치는 칸(`stars*`·`repo_*`·`og_image`·`search_keywords`·`search_page_text`·`search_readme` 등, `lib/db/schema.ts:61-`)이 목록 칸과 한 행에 있다 |
  | `crawl_review_attempts` | 1,845MB | 363k | 행당 약 5KB(snapshot·source jsonb). 그런데 술어들은 candidate_id·state·decision·valid_until 만 본다(ARCH-04) |
  | `model_capacity_requests` | 2,471MB | 510k | 살아 있는 행 614 + 이력. ARCH-03 2단계 |
  | `crawl_documents` | 3,548MB | 1.07M | 811,982행이 page_status 없음(홈페이지 없음 거절, crawl-stats 52-54행). 후보와 1:1 인데 varchar `repo` 로 조인한다(`lib/db/crawl-schema.ts:80-95,177-206`) |

  비교 사례: 이미 칸을 따로 떼어 둔 표는 HOT 비율이 높다. `product_health` 1,532,334/1,582,190(97%), `product_search_profiles` 85%.
- 문제:
  - `products` 의 잡 갱신은 대부분 HOT 이 아니다. 그래서 갱신 한 번마다 넓은 행 전체 사본과 인덱스 14개 항목이 새로 쓰인다(5.6일 70만 회).
  - 공개 목록은 그 넓은 heap 을 훑는다. 복제본에서 `products` seq_scan 66,580회·53억 행이다(pg-stats-replica 4행).
  - 시도 표와 장부 표는 「판정에 쓰는 몇 칸」을 읽으려고 수 KB 행을 읽는다.
- 수정 방안(바꿀 구조):
  1. `products` 에서 잡이 고치는 칸을 옆 표로 뗀다. `product_repo_state`(stars·repo_status·checked_at…), `product_search_documents`(search_page_text·readme·keywords), `og_image` → 기존 `product_thumbnail_state`. 이 코드베이스에 이미 있는 패턴(`product_health`·`product_search_profiles`)을 넓히는 것이다.
  2. `crawl_review_attempts`·`model_capacity_requests` 는 판정 칸과 원문 payload(snapshot·source·dispatch_binding·terminal_evidence)를 1:1 옆 표로 나눈다.
  3. `crawl_documents` 는 **행을 지우지 않는다**(11-15 소유자 결정 — 저장소 id 근거). 거절 행의 jsonb 줄이기는 이미 `lib/jobs/db-retention.ts:51-55` 가 한다. 뜨거운 경로가 이 표를 훑지 않게 하는 것은 ARCH-04(c)가 맡는다.
- 얻는 것(추정):
  - `products` 쓰기 증폭이 크게 준다. 목록 heap 이 작아져 복제본 스캔이 싸진다.
  - 시도 표 상관 서브쿼리가 좁은 표를 읽는다.
  - 크기 근거만 있으므로 효과는 EXPLAIN 과 쓰기 WAL 양으로 확인한다.
- 옮기는 순서:
  - 칸마다 ① 옆 표 추가와 이중 쓰기 → ② 읽기를 옆 표로 → ③ 옛 칸 쓰기 중지 → ④(창에서) 옛 칸 DROP.
  - ①~③은 되돌릴 수 있다. ④만 비가역이므로 마지막에 따로 한다.
- 위험·하지 말 것:
  - **파티셔닝은 지금 하지 않는다.** `crawl_candidates`·`crawl_documents` 는 `repo` 고유 제약이 있어 파티션 키를 고유 제약에 넣어야 한다. 상태가 바뀌면 행이 파티션 사이를 옮겨 다닌다(삭제+삽입). 이 규모(100만 행대)에서는 ARCH-04 의 부분 인덱스·대기열이 같은 효과를 훨씬 싸게 낸다.
  - 장부 보관 기간(14일)을 줄이는 것은 11-15 소유자 승인 사항이라 결정 없이 바꾸지 않는다.
- 검증:
  - `pg_stat_user_tables` 의 n_tup_hot_upd 비율과 표 크기를 본다.
  - 복제본 `products` seq_tup_read 를 본다.
  - 목록 쿼리 EXPLAIN 의 buffers 를 본다.
- 배포 주의: 칸마다 마이그레이션 여러 개가 있다. DROP 은 DRAIN 창에서, 새 칸 읽기는 마이그레이션 뒤에 한다.
- 확신도: 크기·HOT 실측은 CONFIRMED(2차: pg-stats-primary 8·10·14·15·20·23행과 replica 4·5행의 숫자를 다시 대조함). 효과 크기는 PLAUSIBLE이며 칸별 갱신 빈도를 `pg_stat_statements` 로 확인해야 한다.
- 규모: L

### ARCH-09 M3·mini 두 벌 워커: 작업 단위로 양쪽이 나눠 일하게(active-active) 바꾸지 말고, 예비를 싸게
- 심각도: P3
- 분류: structure
- 위치:
  - `scripts/role-worker.ts:339-372` — 예비는 5초마다 선출을 시도한다.
  - `lib/jobs/role-leader.ts:45-56` — 시도마다 배타 잠금을 잡는다(ARCH-02).
  - `lib/db/host-budget.ts:54-57` — 역할 자식 풀 상한은 crawler 8·reviewer 11·publisher 3·text 6·maintenance 3 이다.
  - `lib/jobs/catalog.ts:6-26` — 「모델 동시 호출 수는 줄이 아니라 공통 장부(물리 한도)가 정한다」.
  - `lib/runtime/consumer-registry.ts:20-30` — 이미 항목 단위 소비자가 있다(ai1·ai2·agent-scan·uptime·github-ko).
- 판단: 작업 단위 lease 로 양쪽이 동시에 일하게 바꾸는 것은 **권하지 않는다.**
  - 처리량을 정하는 것은 모델 장부의 장비 한도(GPU 슬롯)와 GitHub API 한도다. 워커 프로세스 수가 아니다. 두 호스트가 함께 일해도 같은 슬롯과 같은 버킷을 나눌 뿐이다.
  - 동시 claim 하는 쪽이 둘이 되면 지금 가장 비싼 「할 일 유도」 조회(ARCH-04)와 장부 mutex(ARCH-03) 경합이 두 배가 된다.
  - 이미 병렬이 의미 있는 단계(1·2차 심사, 스캔, 응답 점검)는 항목 소비자로 분리돼 있다(`consumer-registry.ts`).
- 대신 할 것: 예비의 비용을 줄인다. 예비의 실제 비용은 (a) 5초마다 배타 잠금 TX(ARCH-02 로 해결)와 (b) 넘겨받을 때를 대비해 비워 둔 DB 연결 예산(150개 중)이다. (b)는 장애 넘김의 대가로 받아들일 만하다.
- 얻는 것: 재작성 비용이 없다. ARCH-02 만으로 예비의 DB 부하가 「한 줄 읽기」 수준이 된다.
- 옮기는 순서: ARCH-02 PR1.
- 위험: 없다(현행 유지 판단).
- 검증: ARCH-02 와 같다.
- 배포 주의: 해당 없음.
- 확신도: CONFIRMED(병목 위치는 catalog 주석과 장부 구조로 확인. GitHub 버킷 공유는 운영 기록 근거). 2차: `lib/jobs/catalog.ts:13` 「모델 동시 호출 수는 줄이 아니라 공통 장부(물리 한도)가 정한다」, `lib/db/host-budget.ts:54-57` 풀 상한, `lib/runtime/consumer-registry.ts:20-30` 항목 소비자 6종(1차 목록 + `capacity-supervisor`)을 다시 확인했다. 근거가 코드와 맞는다.
- 규모: S

### ARCH-10 이 규모에 과한 재작성 — 하지 말 것
- 심각도: P3
- 분류: structure
- 위치: 시스템 전반.
- 판단과 까닭. 규모는 제품 11.5만, 하루 LLM 호출 약 3.6만(장부 행 51만 / 보관 14일), DB 커밋 하루 약 2,200만 건이다(evidence 의 xact_commit 1.25억이 11-15 재시작 뒤 누적이라는 가정 아래의 추정).
  - **마이크로서비스 분리·서비스별 DB**: 문제는 쿼리 모양과 잠금 규약(ARCH-01~04)이지 한 Postgres 의 처리량이 아니다. 지금의 정합성은 「도메인 쓰기 + 장부 + 잡 깨우기를 한 트랜잭션에」에 서 있다(`lib/crawl/translations.ts:372-395`). 서비스를 나누면 이것이 분산 트랜잭션이나 사가가 되어 미확정 처리가 몇 배로 어려워진다.
  - **메시지 브로커(Kafka·RabbitMQ·NATS 등)**: 「같은 TX 안에서 깨우기」(`requestJob(…, tx)`)라는 outbox 를 이미 DB 안에 갖고 있다. 브로커를 들이면 진실의 원천이 둘이 되고, 브로커와 DB 사이의 정합성(이중 쓰기)이라는 새 문제가 생긴다. 하루 수만 건은 Postgres 대기열(`FOR UPDATE SKIP LOCKED`, 이미 `lib/crawl/agent-review-repository.ts:552`·`lib/me/email-outbox.ts:201` 에 있음. 항목 lease 는 `lib/jobs/items/repository.ts:114`)로 충분하다.
  - **LISTEN/NOTIFY 를 먼저 도입하는 것**: 런타임 DB 연결은 PgBouncer(6432)를 지난다(`docs/operations/independent-workers-runbook.md:394`). 트랜잭션 풀링에서는 LISTEN 세션이 유지되지 않는다. 따로 직접 연결이 필요하고, 장애 넘김 때 다시 구독해야 한다. 깨우기 지연(최대 5초 폴링)은 지금 병목이 아니다.
  - **Valkey 로 장부·한도 옮기기**: ARCH-03 참조(원자성 상실).
  - **이벤트 소싱으로 전면 재작성·Kubernetes 이전**: 실측 병목과 무관하다. 지금 배포 체계(Dokploy·영수증·관문)의 검증 자산을 버리게 된다.
- 얻는 것: 쓰지 않을 비용을 피한다.
- 옮기는 순서: 해당 없음.
- 위험: 해당 없음.
- 검증: 해당 없음.
- 배포 주의: 해당 없음.
- 확신도: CONFIRMED(근거 위치를 적은 판단). 2차: 숫자를 다시 계산했다. 장부 510,514행 ÷ 14일 = 약 3.6만/일(약 0.42건/초). xact_commit 125,268,523 ÷ 5.6일 = 약 2,240만/일. PgBouncer 경유(runbook `:394`)와 transaction 모드(`lib/jobs/batch-repository.ts:17` 주석), 5초 폴링(`scripts/worker.ts:130`), `jobs` 표 61행(evidence/jobs.txt)도 확인했다. SKIP LOCKED 인용 줄만 고쳤다.
- 규모: S

### ARCH-11 측정용 replay 장치가 운영 경로 61개 파일에 199개 분기로 박혀 있다
- 심각도: P3
- 분류: structure
- 위치:
  - `currentReplayDb()` 호출이 61개 파일에 199곳 있다. 예: `lib/jobs/runner.ts:140-143,151-160`, `lib/llm/capacity-repository.ts:66` 과 모든 export 의 첫 줄.
  - `lib/operations/pipeline-replay*` 는 4,788줄이다.
  - `lib/db/replay-scope.ts:5-6` 는 스키마 층에서 replay 를 값으로 import 한다.
  - `lib/jobs/control.ts:10`(ARCH-06 사슬).
  - 시험: replay 관련 46개 파일, 통합 시험 기록 시간 319초/1,546초(21%, `tests/integration/durations.json`).
  - 코드의 마지막 변경은 11-06(`git log -- lib/operations/pipeline-replay*`)이다.
- 문제: 10-15~10-17 처리량 개편 때의 고정 입력 재생 측정 장치다. 그런데 운영의 모든 장부·잡 경로가 「replay 인가」를 묻고, 그 import 가 웹 공개 경로까지 사슬을 만든다(ARCH-06). 통합 CI 시간의 1/5을 쓴다.
- 수정 방안: 소유자가 정한다. 다시 쓸 계획이 없으면 퇴역시킨다(측정 문서는 남김). 쓸 계획이 있으면 replay 판정을 DB 핸들 주입(별도 DB 클라이언트를 넘김)으로 바꿔 운영 함수의 전역 분기를 없앤다.
- 얻는 것: 운영 경로의 분기·import 사슬 제거, 통합 CI 약 −20%, 장부 코드 가독성.
- 옮기는 순서: ① 소유자 결정 → ② 퇴역이면 replay 시험과 스크립트 제거 → ③ 운영 경로의 `currentReplayDb()` 가드를 모듈 하나씩 제거(동작 같음).
- 위험: replay 가 지키던 「격리 DB 에서 장부를 쓰지 않음」 가드는 replay 와 함께 사라져야 한다. 순서를 반대로 하면 안 된다.
- 검증: typecheck·전체 unit·통합 시험을 돌리고, replay 진입점이 없는지 확인한다.
- 배포 주의: 일반 배포.
- 확신도: CONFIRMED(분포·시간). 「더 쓰지 않음」은 소유자 확인이 필요하다. 2차: `currentReplayDb(` 199줄·61파일, `pipeline-replay*` 21파일·4,788줄, 마지막 변경 11-06(`b6b894f4`), durations 의 replay 21파일 321초/1,546초(20.8%)로 다시 셌다.
- 규모: M

### ARCH-12 CI: tests/ 만 바꿔도 전체 행렬, 측정 시험이 통합 시간의 1/5
- 심각도: P3
- 분류: structure
- 위치:
  - `scripts/ci-scope.mjs:12-26` — docs·README·PENDING·CSS·messages JSON 말고는 모두 `full` 이다. `tests/**` 만 바뀌어도 typecheck·lint·unit×2·build·통합×6·직렬 ledger·이미지 2개가 돈다.
  - `.github/workflows/ci.yml:208-238` — 통합 6샤드.
  - `tests/integration/durations.json` — 기록 308개 파일·1,546초(샤드당 약 258초).
  - 시험 파일 1,348개(통합 436), 시험 코드 237k줄로 lib 약 160k줄보다 많다.
- 문제: 시험만 고치는 PR(예: flaky 수정)도 약 9분짜리 전체 CI 와 arm 이미지 빌드를 기다린다. 비용은 크지 않다. CI 가 GitHub Actions 한도·결제 문제로 막혔던 이력이 있어 줄일 가치는 있다.
- 수정 방안:
  - `tests` 프로필을 추가한다. 바뀐 시험 파일만 실행하고 typecheck·lint 를 돈다. 이미지 빌드는 하지 않는다.
  - 통합 시험 선택을 ARCH-05 도달 목록으로 하는 안은 **나중에, fail-closed 로만** 한다.
  - replay 시험은 ARCH-11 결정을 따른다.
- 얻는 것: 시험만 고치는 PR 의 CI 와 이미지 빌드가 준다. replay 퇴역이면 통합 −20% 다.
- 옮기는 순서: `CI_RULES_VERSION` 을 올리고 프로필 하나를 추가한다(`ci-scope.node-test.mjs` 에 고정값 추가).
- 위험: 시험 파일만 바꿨다고 판단했는데 시험 헬퍼(`tests/helpers`)가 다른 시험에 영향을 주는 경우가 있다. 헬퍼 경로는 full 로 둔다.
- 검증: `ci-scope.node-test.mjs` 를 돌리고 필수 `check` 결과를 비교한다.
- 배포 주의: 해당 없음(CI 만). 필수 병합 CI 규칙은 그대로다(AGENTS.md).
- 확신도: CONFIRMED. 2차: `scripts/ci-scope.mjs:12-26` 규칙, durations 308파일·1,546초, 시험 파일 1,348개(통합 436)를 다시 확인했다.
- 규모: S

### ARCH-13 공개 화면 읽기 모델: 지금은 CDN 이 그 역할을 한다 — 재작성하지 말고 목록 정렬 키만 미리 계산
- 심각도: P3
- 분류: structure
- 위치:
  - `next.config.ts` headers — Cloudflare 전용 캐시 시간(목록 60초, 상세 240+60초)과 태그 지우기를 쓴다.
  - 공개 페이지는 모두 `export const dynamic = "force-dynamic"` 이다(`app/(public)/[locale]/(content)/page.tsx:91`, `p/[slug]/page.tsx:42` 등).
  - 복제본 연결은 `nomorevibe:web-replica` idle 46개다(pg-stats-replica 27행).
- 판단: 지금은 원 서버가 렌더하고 CDN 이 캐시한다. 측정된 웹 TTFB 는 0.2~0.4초다(web-timing 2-25행). 11-11 에 확인된 지연 주원인은 한국 회선이 미국 엣지로 가는 것(memory)이다. 그러므로 ISR·서버 캐시 같은 렌더링 전략 재작성은 이득이 작다. 이 Next 버전의 캐시 API 는 학습 자료와 다를 수 있어 문서 확인 비용도 든다.
  - 남는 구조 비용은 복제본의 `products` seq scan(5.6일 66,580회·53억 행)과 `social_posts`(24,866회·13억 행)다. 목록마다 넓은 표를 훑는다는 신호다.
- 수정 방안: 크게 바꾸지 않는다. 다음 두 가지만 한다.
  - 공개 목록이 쓰는 정렬·거르기 키(순위 점수·별 증가·카테고리·listed_at)를 발행·갱신 잡이 좁은 `public_product_cards` 표에 미리 계산해 두고, 목록 쿼리가 그 표의 인덱스만 타게 한다.
  - ARCH-08 의 `products` 칸 분리와 함께 한다.
- 얻는 것: 복제본 seq scan 이 줄고, 캐시 MISS 때의 원 서버 시간이 준다(추정, 목록 쿼리 EXPLAIN 으로 확인).
- 옮기는 순서: ① 표와 이중 쓰기 → ② 목록 쿼리 하나씩 옮김 → ③ 옛 쿼리 제거.
- 위험: 미리 계산한 키가 원천과 어긋나는 경우다. 대조기(ARCH-04 와 같은 방식)를 둔다.
- 검증: 복제본 seq_tup_read, 목록 쿼리 EXPLAIN, web-timing MISS 의 TTFB 를 본다.
- 배포 주의: 마이그레이션.
- 확신도: PLAUSIBLE. 어떤 공개 쿼리가 seq scan 을 만드는지는 web-public·db-queries 구역의 쿼리 추적과 맞춰 봐야 한다. 2차: 인용한 숫자(replica 4·5·27행)만 다시 확인했다.
- 규모: M

## 구조 변경 제안 (리팩토링으로 효율화)

얻는 것 ÷ 드는 것 순위. 「얻는 것」은 위 실측에 근거한 추정이고, 「드는 것」은 PR 수와 위험을 함께 본 것이다.

| 순위 | ID | 바꿀 구조 한 줄 | 얻는 것(실측 근거) | 드는 것 |
|---|---|---|---|---|
| 1 | ARCH-02 | 역할 lease: 미리 읽기 + 갱신 NO KEY UPDATE + 작업 KEY SHARE | role 잠금 대기 2,038회/일(1,879초, 느린 시간의 1.5%) → 0, 갱신 실패 재시작 경로 제거. (2차: P2) | S, PR 2개, 잠금 모드만 |
| 2 | ARCH-01 | 진행 보고서를 DB 한 줄에 단일 계산, 모두 읽기 | 진행 계산 횟수 −80%(약 3.2만→5.8천 회/일), 느린 시간 약 −1.3만~1.6만 초/일(`reason_eligible`·uptime readback. ARCH-04 와 겹침). 3초 timeout 감소는 2차에서 근거 약함 | S~M, PR 4개, env 로 되돌림 |
| 3 | ARCH-05 | 배포 분류기: Dockerfile 증명(app·components) → 도달 목록 | PR 19%가 웹 2앱 배포(배포당 약 7~24분 + DRAIN 절약. 묶음 배포면 그보다 적음) | S(1단계)·M |
| 4 | ARCH-03 | 장부: 점유 증가 전이만 장비 단위로 직렬화, 보냄·정산은 전역 잠금 제외, (선택) live/history 분리 | control 대기 −44~80%(하루 1.6만~2.9만 초), 장부 seq scan 제거 | M~L, PR 3+1개, 각 PR 잠금 모드만 |
| 5 | ARCH-04 | 전이 때 채우는 대기열 + 술어는 검증 + 15분 대조기 | 느린 시간 −55% 기대(큰 넷 73,123초/일, 넷 모두 끝냈을 때. 앞의 둘만이면 약 −42%) | 대기열마다 M, 그림자→읽기→제거 |
| 6 | ARCH-06 | read/write 모듈 분리, `lib/platform` 추출, 경계 lint | 공개 웹 ∩ 워커 455개 파일 축소 → ARCH-05 비율 상승, 충돌 감소 | L(점진, PR 마다 S) |
| 7 | ARCH-07 | 장부 작업 생애 주기 공통화(작업 어댑터) | −1.5천~2천 줄, 새 작업이 핵심 파일 무변경, ARCH-03 을 한 곳에서 | L |
| 8 | ARCH-08 | 뜨거운 칸·차가운 payload 옆 표 분리(파티셔닝은 안 함) | products 쓰기 증폭(HOT 0.3%) 감소, 넓은 행 스캔 감소 | L(칸마다 4단계) |
| 9 | ARCH-11 | replay 장치 퇴역 또는 주입식 격리 | 운영 분기 199곳 제거, 통합 CI −20% | M + 소유자 결정 |
| 10 | ARCH-12 | CI `tests` 프로필 | 시험만 고친 PR 의 전체 행렬·이미지 빌드 제거 | S |
| 11 | ARCH-13 | 목록 정렬 키 미리 계산(렌더링 전략 재작성 없음) | 복제본 products seq scan 감소 | M |
| — | ARCH-09·10 | active-active·마이크로서비스·브로커·Valkey 장부·LISTEN 먼저 — 하지 않음 | 쓰지 않을 비용 회피 | — |

**권하는 진행 순서**(서로의 전제를 고려함):
1. ARCH-02 → ARCH-01 PR1·2 → ARCH-05 PR1. 모두 S이고 서로 독립이다. 몇 주 안에 운영 부하와 배포 창이 눈에 띄게 준다.
2. ARCH-03 PR1(정산 mutex 제거) → ARCH-07(공통화) → ARCH-03 PR2·3. 공통화 뒤에 하면 12곳이 아니라 한 곳을 바꾼다.
3. ARCH-04 의 대기열은 사유 번역 → 발행 → 규칙 판정 → 2차 정리 순서로 하며, 각각 그림자 단계부터 시작한다.
4. ARCH-06 은 위 작업과 나란히 이동 PR 로 조금씩 한다. 이동이 끝난 영역부터 lint 를 켠다.
5. ARCH-08·11·12·13 은 소유자 결정과 여유에 맞춰 한다.

공통 원칙(이 코드베이스의 기존 관행과 맞춤):
- 각 단계는 「잠금 모드만」「칸 추가만」「읽기 전환만」처럼 하나의 축만 바꾼다. 그래서 한 커밋으로 되돌릴 수 있다.
- 진실은 원천 표와 트랜잭션 안의 재검증에 둔다. 새로 만드는 대기열·요약·미리 계산 표는 **색인**이고, 대조기가 차이를 센다.
- 판정이 바뀌는 곳(재시작, 배포 관문)은 증거가 없으면 지금처럼 「unknown·재시작 안 함·full 배포」로 닫는다.

## 확인했지만 문제 아님
- HTTP cron 이 잡 레지스트리(모든 처리기)를 끌어온다는 분류기 주석의 우려: `app/api/cron/[job]/route.ts:2-3` 은 `catalog`·`control` 만 import 한다. 웹에서 `lib/jobs/registry.ts` 로 가는 정적 경로는 없다(그래프 확인). 다만 `control.ts` 의 replay 사슬은 ARCH-06 에 적었다.
- lib→components 값 import 7곳(`lib/me/inbox.ts:2` 등)이 워커 이미지에서 깨질 위험: 워커·감시 도달 집합에 `components/`·`app/` 파일은 0개다. 지금은 안전하다. 경계 lint 로 고정할 것을 ARCH-06 에 넣었다.
- 항목 lease 의 claim 방식: 이미 `FOR UPDATE SKIP LOCKED` 다(`lib/jobs/items/repository.ts:114·120`, 함수는 `:100`). claim 원시 기능은 문제없다. 문제는 「무엇을 고르나」(ARCH-04)다.
- LISTEN/NOTIFY 가 없는 것: `jobs` 표는 60행 남짓이라 5초 폴링(`scripts/worker.ts:130`)이 싸다. 깨우기는 `requestJob(…, tx)` 가 같은 TX 로 한다. PgBouncer 경유라 LISTEN 은 오히려 부적합하다.
- `operations_observations` 를 요약 표로 쓰는 것: 갱신 2,267,751회 중 HOT 2,191,921회(97%)라 요약 행을 자주 덮어써도 싸다(ARCH-01 의 근거).
- `job_batch_control` 의 `FOR SHARE`(`lib/jobs/batch-repository.ts:29`): 읽는 쪽끼리 충돌하지 않고, 배타 잠금을 잡는 쪽은 드문 관리 전이뿐이라 직렬화 지점이 아니다.
- 비리터럴 동적 import 로 도달 그래프가 틀릴 가능성: 워커·감시 도달 파일 중 해당 1건(`lib/db/product-audit-schema.ts:250`)은 주석이었다.

## 범위 밖·못 본 것
- 개별 쿼리 재작성·인덱스 추가(예: `NOT IN` → `IN`, `products_search_idx` 265MB 미사용): db-queries·llm-capacity 구역에 넘긴다. 이 문서는 그 처방 뒤의 구조만 다룬다.
- statement timeout 10,383건과 lock timeout 17건이 어느 문장인지: 근거 파일의 오류 집계에 문장이 없다. ARCH-01·02 의 확인 항목으로 남긴다.
- 배포 단계별 실측 시간: 11-06 문서의 표만 썼고 최근 배포 영수증은 보지 못했다. ARCH-05 의 절약 시간은 그 문서의 값(전체: 실측 한 사례 약 26분·추산 10~15분, 웹: 추산 2~3분)에 기댄다(2차 정정).
- 웹이 모델 호출을 쥐는 앱으로 분류되는지(DRAIN 필요 여부): plan 의 규칙을 읽지 않았다.
- Oracle native release·connect-agent(Git 빌드)의 런타임 경계, Valkey 사용처, 실제 CI 실행 시간(GitHub 기록): 보지 않았다. CI 시간은 `durations.json` 만 썼다.
- 정규식 import 그래프의 한계: tsconfig paths 는 `@/` 만 해석했다. `export * from` 은 잡히지만 조건부 require 는 없는지 확인하지 않았다. ARCH-05 PR2 는 esbuild 해석으로 대체해야 한다.

## 검증 기록 (2차)

검증자가 2026-11-21 에 같은 코드(`34b5fe32`)와 `evidence/` 로 다시 보았다(읽기 전용, 테스트·빌드·분류기 실행 없음). import 그래프는 1차와 별도로 정규식 해석기를 새로 짜서 재현했다.

#### 고친 인용 (13곳)

- `lib/jobs/items/repository.ts:100` 의 「SKIP LOCKED 로 집는다」 3곳(ARCH-04·ARCH-10·확인했지만 문제 아님) → `:114·120`. 함수 시작은 100줄이고, SKIP LOCKED 는 키 하나의 소유권 잠금이다. 「다음 N개 고르기」 꼴의 예는 `lib/crawl/agent-review-repository.ts:552` 로 따로 적었다.
- 줄여 쓴 경로 4곳을 전체 경로로 고쳤다: `throughput.ts:62`, `text-stage-progress.ts:146-151`(→ `:146-150`), `role-worker.ts:461-464`, `worker-progress-query.ts:471`.
- 「직렬 장부 시험 34개 파일」 2곳(ARCH-03·07) → 21개(`scripts/integration-shards.mjs:23` SERIAL_FILES).
- ARCH-03 정산 mutex 줄 목록에 빠진 `:3304`(`reconcilePublicationApiTerminal`)를 더했다.
- 「문서 기준 14~30분」 2곳(ARCH-05 문제·범위 밖) → `docs/operations/2026-11-06-deployment-fast-routes.md:73-83` 의 실제 값으로 고쳤다. 실측 한 사례 약 26분, 추산 10~15분, 웹 2~3분이다. 14~30분은 그 문서에 없다.
- ARCH-08 「인덱스 14개 이상(drizzle 의 …)」 → evidence/indexes-primary.txt 의 실제 14개.

#### 요약 비율의 재계산 (slow-queries-primary.txt)

| 묶음 | 1차 | 2차 | 넣은 파일 줄 |
|---|---|---|---|
| 유도 조회 | 39,615건·82,623초·67.3% | 39,572건·82,586초·**67.2%** | 2·4·5·6·9·10·11·12·14·17·19·26·29·30·31·36·37·40·42·46·48·50·51·53·55·57·62·65 |
| control 잠금 대기 | 35,291·36,317·29.6% | 같음 | 3·7·8·13·24 |
| role_leases 잠금 대기 | 2,038·1,879·1.5% | 같음 | 15·18 |
| jobs 행·장부 쓰기 | 2,855·1,985·1.6% | 같음(jobs 1,031·983 + 장부 1,824·1,002) | 20·21·23·25·27·28·38·39·41·52·60 / 16·22·32·43·45 |
| 그 밖 | (없음) | 98·83·0.1% | 33·34·35·44·47·49·54·56·58·59·61·63·64 |
| 감시 계정(겹침) | 3,681·16,622·13.5% | 같음 | 4·30·50 |
| 큰 넷(ARCH-04) | 73,123·59.5% | 같음 | 2·10 / 4·11 / 5 / 6 |

- 차이의 까닭: 1차는 쓰기·잠금인 34·35·64행(43건·37초)을 유도 조회에 넣었다. 그리고 「그 밖」 55건·46초는 어느 묶음에도 넣지 않았다.
- 합이 100% 를 넘는 까닭: 감시 계정 줄은 원인이 아니라 계정 단면이다. 세 행이 모두 유도 조회 안에 이미 있다(겹침).

#### 다시 센 숫자 (전 → 후)

| 항목 | 1차 | 2차 |
|---|---|---|
| ARCH-01 진행 계산의 느린 몫 | (없음) | 4·9·11·30행 23,811초/일(19.4%) |
| ARCH-01 줄어드는 느린 시간 | `reason_eligible` 약 −10,000초 | 약 −1.3만~1.6만 초(uptime readback 포함, ARCH-04 와 겹침) |
| ARCH-03 `control(tx)` 사용처 / 정산 함수 / `lock*Dispatch` | 28 / 14 / 12 | 30 / 15 / 11(+`lockModelCapacityCallerControl`) |
| ARCH-03 control 대기 감소 | −60~80%(2.2만~2.9만 초) | **−44~80%(1.6만~2.9만 초)** |
| ARCH-04 느린 시간 감소 | 약 −55% | 넷 모두 −56~58%(대조기 몫 차감) / 앞의 둘만 약 −42% |
| ARCH-05 배포당 절약 / 하루 절약 | 11~27분 / 20~50분 | **7~24분 / 0~40분**(묶음 배포면 0) |
| ARCH-05 worker·monitor 가 닿는 lib | 738 / 419(표에서 계산) | 738 / 419(따로 재현, 같음) |
| ARCH-06 공개 웹 lib ∩ 워커 | 569개 중 455 | `app/(public)` 만 진입점이면 514개 중 444(같은 규모) |
| ARCH-07·03 직렬 장부 시험 | 34파일 | 21파일 |
| ARCH-08 products 인덱스 | 14개 이상 | 14개 |
| ARCH-10 LLM 호출 / DB 커밋 | 3.6만/일 / 2,200만/일 | 3.6만/일 / 2,240만/일 |
| ARCH-11 replay 통합 시간 | 319초(21%) | 321초(20.8%) |

#### 반증·심각도 변경

- **ARCH-02 P1 → P2**: 잠금 규약·주기(예비 5초 `scripts/role-worker.ts:371`, 주 갱신 10초 `:443`)는 확정이다. 다만 실측 몫이 느린 시간의 1.5% 이고, lock timeout 은 전체 하루 17건이다. 비용이 S 라 순위 1 은 그대로 둔다.
- **ARCH-01 일부 근거 약함**: 「throughput 집계가 3초에 자주 끊기고 statement timeout 10,383건의 대부분이 그것」은 근거가 약하다. 주석 실측(156ms·1초)이 있고, 서버 `jit=off` 이며, 0.5초 넘은 실행이 0건이다. 효과에서 뺐다. 항목 자체는 P1 유지다(진행 계산 몫 19.4% 를 실측으로 확인).
- **ARCH-05 Dockerfile 전제 확인**: worker·monitor 이미지에 `app/`·`components/` 가 없다(`Dockerfile:57-63`·`:83-86`). 표본 8개 PR 을 직접 대조했다. 운영 CLI 를 포함한 `scripts/**` 전체를 진입점으로 넣어도 19개는 그대로다. 절약 시간만 과장이라 범위로 고쳤다.
- **ARCH-09·10**: 근거로 든 코드(`lib/jobs/catalog.ts:13`, `lib/db/host-budget.ts:54-57`, `lib/runtime/consumer-registry.ts:20-30`, `lib/crawl/translations.ts:372-395`, PgBouncer transaction 모드)와 숫자가 맞다. SKIP LOCKED 인용 줄만 고쳤다.
- [반증됨] 표시는 없다.

#### 끝내 확인하지 못한 것

- 「지금 분류기 97·1·2」 — `deployment_scope.py` 를 실행해야 해서 재현하지 않았다(규칙만 읽음).
- statement timeout 10,383건·lock timeout 17건이 어느 문장인지(근거 파일에 문장이 없음).
- ARCH-03: 3행(19,640회) 가운데 부여와 보냄의 비율, 장비별 호출 분포, `event()` 순서 등 mutex 에 숨은 다른 가정.
- ARCH-05: 최근 배포 영수증의 실제 단계별 시간, 웹 2앱만 바꿀 때 plan 이 DRAIN 을 요구하는지.
- ARCH-02: `role.renew_unknown code=55P03` 로 실제 역할 재시작이 난 적이 있는지.
