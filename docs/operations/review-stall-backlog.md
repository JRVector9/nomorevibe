# 현재 재개 상태 — 2026-10-28 (3d813382)

이 절이 현재 상태이며 아래 이전 기록은 당시 이력이다.

- 끝남(로컬): PR709에 origin/main b047bddb를 정상 merge해 PR707 drain 보호를 복구. main과 다른 파일을 07930102의 재시작 보호 범위로 제한했다. 무관한 tests/crawl-seed-latest.test.ts, docs/CODEX_HANDOFF.md, GPU3090 개발 문서를 main으로 복구했다. 이력 재작성/force push 없음.
- 검증: bash scripts/verify-review-stall.sh 종료0(typegen/tsc/lint, 관련 TS/Python). 별도 crawl-seed-latest 22시험 성공. PR709 기존 CI40783523028/unit(1) 실패 원인은 main에 없는 탐색 시험 혼입이었다. 새 CI40789227478/check SUCCESS 후 PR709를 7973d9b7421dad81cfe66fb4b05fded862d7c446으로 병합(23:51:18Z).
- 진행: 01514beb를 최신 main 7973d9b7 위에 cherry-pick. item 경로만 우회하던 누락을 고쳐 실제 legacy 잡도 같은 blocked/paused hint를 선택 함수에 전달한다. 미전송 우회 및 이미 보낸 후보 고정의 legacy 회귀 2개 추가. bash scripts/verify-review-stall.sh 종료0(typegen/tsc/lint, TS20파일320시험/Python68시험). PR/CI 대기.
- 남음: 01514beb → dc704d87 → d7fea73c+7eaf8bef를 각각 최신 main에서 PR/필수CI/병합. 이후 표준 배포, 실제 강제 확인 후 자동 회수 선언·4종 드릴·60분 관측.
- 실제 운영 23:41:15Z: AI1 94871(최근1시간0), AI2 91158(최근1시간2). 이전 측정과 총수 동일. GPT-OSS AI1/Supa tagline/M1 translation indeterminate 각1. scripts/ops/measure-review-stall.mjs(원 커밋 dc704d87)를 기존 M3 text 컨테이너에서 node stdin 실행, primary READ ONLY. 세부 원인 추가 조회 예정.
- 막힘(사람 필요, 배포 checkout): ssh jr@m3Ultra 연결·Docker 조회는 성공. 문서 경로 /Users/jr/Desktop/projects/nomorevibe-release-ai1-queue-fix-20261027 및 /Users/jr/Desktop/projects/nomorevibe는 `No such file or directory`. `ls -la /Users/jr/Desktop`는 `Operation not permitted`. 경로/OS 권한을 우회하지 않았다. M3에서 SSH로 읽을 수 있는 기존 운영자 checkout의 정확한 경로 확인이 필요하다. Keychain 접근 성공은 아직 확인하지 않았다.
- 의존성: npm ci --ignore-scripts --no-audit --no-fund는 registry.npmjs.org allowlist 차단. 이전 작업 공간의 기존 node_modules를 이 작업 공간에 복사해 로컬 검사했다. 원본 폴더·설정·자격정보 변경 없음.
- 결정: 가장 적게 바꾸는 정상 merge와 main 파일 복구를 선택했다. 자동 회수는 기본 비활성으로 유지한다.

---

# 미확인 요청 정체 차선 남은 일 (2026-10-28)

대표 지시(2026-10-28): AI1·AI2 미확인 요청 발생을 줄이고, 발생해도 사람 개입 없이 자동 해제·재개.
기준 origin/main `199a3ebb`(#708). 작업 공간 `xaegis/36694e57`(HEAD `8c10f0ad`, = `xaegis/cca48837`의 부모).

## 상태 요약

| 단계 | 코드 | 로컬 시험 | 커밋 | PR·CI·병합·배포·운영 확인 |
| --- | --- | --- | --- | --- |
| 1 재시작 보호(cca48837) | 작업 공간에 `8513cff8` 내용 그대로 반영 | 미실행(막힘) | 못 함(막힘) | 못 함(막힘) |
| 2 막힌 모델 우회 배정 | 끝 | 미실행(막힘) | 못 함 | 못 함 |
| 3 기한 사다리·M1 중계기 | 이 저장소 몫 끝, abcLLM 게이트웨이·엔진 설정은 저장소 밖 | 미실행 | 못 함 | 못 함 |
| 4 자동 해제 | 워커 잡·Oracle 지연 경보 끝, 선언(실측 후)은 남음 | 미실행 | 못 함 | 못 함·드릴 못 함 |
| 5 1차 심사 보고서 | 끝(`2026-10-28-first-review-content-and-rule-worker.md`), 비율 실측 없음 | — | 못 함 | — |

## 독립 코드 읽기 검토(실행 아님)와 반영

시험을 돌릴 수 없어 별도 에이전트가 변경을 읽어 검토했다(실행 결과 아님).

- 확인된 결함 1건 고침: claim 단계 재확인(`agent-review-repository.ts` `claimReview`)이 blocked 정보 없이 고정 칸을 다시 골라, 우회된 후보가 항상 `input_changed`로 건너뛰어졌을 것이다. 잠금 아래 재확인에서 "claim한 모델 외 풀 모델 = avoid"로 같은 선택 함수를 써서, 한 번도 보내지 않은 후보만 우회 모델을 유지하고 고정(시도·intent) 후보는 그대로 거절하게 했다. 시험 추가.
- 고침: 중계기가 이미 기한 경과로 열린 요청을 DB 경계 해제 연결 도구가 `already_cleared`로 끝낼 때 receipt의 wireHash·모델을 대조한다.
- 검사 스크립트에 `test_recovery_provider.py`, `test_release_catalog.py`, 번역 호출자 시험 2개 추가.
- 기준 차이(결함 아님): `lib/jobs/products/translations.ts`는 origin/main(#708) 형태(`deadlineAt`, 55초 예산)로 썼다. **이 작업 공간 기준(`8c10f0ad`)에서는 tsc가 실패하고 25초 기본 예산이 40초 HTTP 기한보다 짧다. 반드시 origin/main 위로 옮긴 뒤 검사·병합한다.**
- 남긴 위험: `.boundary-recovery.lock`이 프로세스 강제 종료로 남으면 중계기가 계속 닫힌다(cca48837의 의도된 동작 — 자동 만료 없음, 운영 절차로 확인 후 정리).

## 끝낸 것(작업 공간에 미커밋 변경으로 존재)

- 1단계: `git show 8513cff8:<경로> > <경로>`로 22개 파일을 그대로 옮겼다. `git diff --stat 8513cff8`에서 추적 파일 차이 0을 확인했다(새 파일은 미추적으로만 보임).
- 2단계: `selectFirstReviewer`의 `avoid` 인자. 활성 intent·시도 기록이 전혀 없는 후보만 막힌 모델(물리 그룹 또는 provider budget이 `indeterminate`로 꽉 참, 또는 이번 회차에 local deferral로 멈춘 모델)을 건너뛰어 고정 칸에서부터 돌아가며 다음 모델로 보낸다. 모두 막혔으면 고정 칸 그대로 기다린다. 이미 보낸 요청·재시도 고정·점유는 건드리지 않는다. `lib/crawl/first-reviewer-blocks.ts`(읽기 전용 hint, 실패하면 hint 없음). AI2는 후보별 고정 배정이 아니라 voter 전원+fallback 구조라 같은 문제가 없다(`lib/crawl/settings-schema.ts` `secondReview.voters`).
- 3단계: `lib/llm/deadline-ladder.ts`, 번역 클라이언트 20→40초, M1 중계기 `max_tokens` 강제·엔진 상한 선언 시 자동 재개. 근거 `docs/operations/2026-10-28-deadline-ladder.md`.
- 4단계: maintenance 잡 `model-capacity-reclaim`(1분) — 선언된 budget만 기존 `releaseEvidencedDispatches` 판정으로 해제. Oracle은 같은 요청이 5분 넘게 남으면 `model_reclaim_overdue` 별도 사건으로 사람에게 알린다(DB·모델 권한 추가 없음).
- `scripts/verify-review-stall.sh` 작성.

## 남은 것

1. (사람·권한 필요) 아래 막힌 명령 실행: 커밋, origin/main 기준 브랜치 정리, PR707 → PR(1단계) → PR(2~4단계) 순 push·PR·CI·병합.
2. `scripts/verify-review-stall.sh`를 node_modules가 있는 곳에서 실행해 0 종료 확인, 실패하면 고친다.
3. abcLLM 게이트웨이 요청별 기한·vLLM abort·종료 기록(별도 저장소).
4. 운영 실측(p95/p99, decode 속도, 게이트웨이 끊김 드릴) 후 `MODEL_CAPACITY_AUTO_RECLAIM`·`LOCAL_MODEL_RELAY_ENGINE_DEADLINE_MS`·`LOCAL_MODEL_RELAY_MAX_OUTPUT_TOKENS` 선언.
5. 표준 배포(`npm run deploy -- scope|plan|run`, PR707 drain 보호) → M3·mini 반영 → DB의 새 AI1·AI2 저장 건수 증가 확인.
6. 드릴(timeout·연결 끊김·owner 교체·응답 유실) 5분 내 자동 해제·재개, 이후 60분 AI1·AI2 저장 증가, 수동 해제 0.
7. 1차 심사 보고서의 대체 가능 비율 실측(측정 SQL은 보고서에 있음).

## 막힌 것(이유: 이 세션은 승인 화면이 없어 승인이 필요한 도구 호출이 모두 자동 거절됨)

거절된 실제 명령(그대로):

- `git fetch origin` — 원격 갱신 불가. 로컬 `origin/main`=`199a3ebb`를 기준으로 사용.
- `gh pr view 707 --json ...` — PR·CI 확인 불가. 따라서 push·PR·병합도 불가.
- 작업 공간 밖 읽기(`xaegis/ce0a1f81` 작업 공간 파일) — 커밋된 `6da7ea92`의 문서로 대신 읽음.
- `npm ci --ignore-scripts --no-audit --no-fund` — node_modules 없음 → tsc·eslint·vitest 실행 불가.
- `python3 -B -m unittest discover -s tests -p 'test_oracle_*.py'` — Python 시험 실행 불가.
- `git checkout -b fix/review-restart-protection-20261028 origin/main`, `git merge --no-edit origin/main`, `git add ...` — 브랜치 생성·병합·커밋 불가.
- `chmod +x scripts/verify-review-stall.sh`, `bash -n scripts/verify-review-stall.sh` — 실행 권한·문법 검사 불가(`bash scripts/verify-review-stall.sh`로 실행).
- 운영 DB·SSH·배포 명령은 위 결과로 보아 시도해도 같은 방식으로 거절된다고 판단해 시도하지 않았다. 따라서 운영 반영·드릴·저장 건수 측정 없음.

## 병합 순서 제안

1. PR707(`fix/review-stall-recovery-20261028`, drain 보호) — 먼저.
2. 1단계 PR: origin/main(707 병합 후)에서 `git cherry-pick 8513cff8`. 충돌 예상 파일(HEAD와 origin/main이 다른 파일): `scripts/ops/incident_notifications.py`, `scripts/ops/oracle_watchdog.py`, `scripts/ops/recovery_gateway.py`, `scripts/watch-failover-readiness.ts`, `tests/test_recovery_provider.py`.
3. 2~4단계 PR: 이 작업 공간의 나머지 변경. origin/main과 다른 파일 중 이 차선이 고친 것: `lib/crawl/jobs/agent-review.ts`(1줄), `lib/jobs/products/translations.ts`(main 줄 형태로 작성함), `lib/jobs/catalog.ts`, `lib/jobs/registry.ts`, `lib/operations/emergency-priority.ts`, `lib/operations/stage-registry.ts`, `app/(operator)/admin/status/work-owners.ts`, `tests/job-catalog.test.ts`, Oracle 두 파일.


## 2026-10-28 23:16 UTC 재개 세션 (gpu3090, 최신 기록)

- 최신 확인: `git fetch origin` 성공, origin/main `199a3ebb` (#708).
- 시작 브랜치의 다른 구역 변경을 건드리지 않도록 `fix/review-stall-lane-20261028`를 origin/main에서 생성. 원본 사용자 폴더·기존 xaegis 브랜치 보존.
- 단계0: e3e3596d를 가져와 main 충돌 해결. 번역 55초 예산·deadlineAt 유지. 최신 reviewFailures 감시와 capacityUnknowns 감시를 병존시킴.
- 최초 검증: typegen/tsc/eslint 성공, TS 23파일 332시험 성공. Python 전체 Oracle 249시험은 실패 33·오류6·skip8 (차선 밖 activation의 `identity:approved_identity_unavailable`·restore의 `unsafe_output_parent`, 차선 안 overdue 시험 상태 객체 오류 1). 기록 보존. 전체 Oracle 시험은 앞으로 반복하지 않음.
- overdue 시험은 cycle이 state를 교체한 뒤 notify에 넘기도록 수정. 차선 범위로 검증 스크립트를 좁힘. 최종 `bash scripts/verify-review-stall.sh` 종료0: typegen/tsc/lint, TS 23파일332시험, Python 관련 감시·gateway·catalog 회귀 성공.
- `npm ci --ignore-scripts --no-audit --no-fund` 막힘: `Network access to "registry.npmjs.org" was blocked: domain is not on the allowlist for the current sandbox mode.` 승인 우회 없이 로컬 npm 캐시만 쓰는 `npm ci --offline --ignore-scripts --no-audit --no-fund` 성공(535 packages).
- 단계1: `gh pr update-branch 707` 성공, head `4e490d2c`로 최신 main 갱신. 새 필수 CI 진행 중. 이전 head의 성공을 새 head 성공으로 간주하지 않음.
- 운영 측정: `scripts/ops/measure-review-stall.mjs`를 기존 M3 text 컨테이너에서 read-only transaction으로 실행. 원본 `review-stall-measurement-before.json` 참조. primary=false 아님(pg_is_in_recovery=false). AI1 총94871·최근1시간0, AI2 총91158·최근1시간2. 미확인 GPT-OSS AI1 / Supa tagline / M1 번역 각1.
- monitor DB 계정 조회는 실제 `42501 permission denied for table model_capacity_requests`로 실패. 기존 text 앱의 업무 DB 연결로 READ ONLY 조회 성공했으며 권한·계정·환경변수는 변경하지 않음.
- **막힘(지정 artifact·scratch 경로 쓰기)**: `mkdir -p /home/ubuntu/.xaegis-hub/data/local-agent/jobs/6b64d562-ec09-4b3e-96a1-2a6a103a4073/artifacts /home/ubuntu/.xaegis-hub/data/local-agent/jobs/6b64d562-ec09-4b3e-96a1-2a6a103a4073/scratch` → `mkdir: Read-only file system` (exit1). sandbox escalation·권한 변경·다른 scratch 경로로 우회하지 않음. 배포 private receipt 디렉터리와 별도 abcLLM checkout 준비가 이 경로에 의존함.
- SSH 읽기: M3 docker / m1-studio / supa 접속 성공. Dokploy status reviewer·web 양쪽 done(기존 배포, 이번 배포 아님).
- 남음: 단계1 CI→병합→표준 plan/run(지정 경로 막힘), 이후 단계2 별도 PR/배포, 단계3 코드·회귀 독립 커밋, 단계4 최신 지연 반영 및 서버/게이트웨이 강제, 단계5 실측 후 선언·드릴·60분 관측, 단계6 최신 코드 보고서 확인.

### 단계2 독립 분리

- `fix/review-restart-protection-20261028`는 origin/main `199a3ebb`에서 8513cff8만 가져옴. 최신 main의 reviewFailures 감시를 유지하고 capacityUnknowns를 병존시켰다.
- `bash scripts/verify-review-stall.sh` 종료0: typegen·tsc·변경 lint, TS19파일312시험, Python 요청감시5 + watchdog9/10/24 + recovery7 + catalog13 성공. 아직 도입하지 않은 단계5 시험 파일은 명시적으로 건너뜀.
- 첫 분리 검사에서 아직 존재하지 않는 단계5 Python 파일 discovery가 `NO TESTS RAN` / exit5로 끝나 수정 후 위 명령을 재실행해0 확인. 실패 결과를 성공으로 덮어 적지 않음.
- PR·배포는 단계1 배포와 운영 저장 확인 뒤 진행. 지정 배포 영수증 디렉터리 생성이 막혀 후속 병합·배포 순서를 앞당기지 않음.

### 단계1 PR707 병합 / 배포 준비 기록

- 최신 main 기반 head `4e490d2cf15f3e88b611191cfb733727f8ad0919`의 필수 `check` SUCCESS: https://github.com/JRVector9/nomorevibe/actions/runs/40785613934 .
- `gh pr merge 707 --merge --match-head-commit 4e490d2cf15f3e88b611191cfb733727f8ad0919` 성공. 병합 `b047bddbeb86a2828e2ab1e0f293a91df5affda2`.
- main run https://github.com/JRVector9/nomorevibe/actions/runs/40786665949 의 `check`·`publish-worker-image`·`publish-web-image` SUCCESS. 전체 workflow/refresh-caches는 기다릴 관문 아님.
- 올바른 exact SHA로 `npm run deploy -- scope --base 199a3ebb68772f1ccbefd397172effce72029796 --sha b047bddbeb86a2828e2ab1e0f293a91df5affda2` 실행: mode=none, selectedApps=[], no_runtime_change. PR707은 배포 coordinator 보호 변경이므로 이 diff만으로 앱을 불필요 재배포하지 않음. 실제 혼합 baseline 검증은 plan 몫.
- 앞선 scope의 짧은 ref / 잘못 적은 base는 각각 invalid_commit_identity / unproven_git_history로 full fallback. 위 정확한 SHA 재실행 결과만 채택.
- 첫 `PATH=/home/ubuntu/.codex/skills/prod/bin:$PATH NMV_DEPLOY_SSH_USER=jr npm run deploy -- plan --sha b047bddbeb86a2828e2ab1e0f293a91df5affda2 --out /home/ubuntu/.xaegis-hub/data/local-agent/jobs/6b64d562-ec09-4b3e-96a1-2a6a103a4073/scratch/review-stall-pr707-20261028` 은 exit1, `{"status":"release-not-complete","errorClass":"ValueError","reason":"inspect-private-receipts","automaticRetry":false}`. 당시 checkout이 code 분리 브랜치였으므로 `create_plan` 첫 관문 `checkout_must_be_target_release`에 해당. 깨끗한 대상 SHA에서 다시 확인할 예정. 이 결과를 배포 시도/완료로 세지 않음.
- mini의 jr 계정도 읽기 전용 docker 확인 성공. 계정·SSH·실행 권한 변경 없음.

### 단계3 전송 전 후보만 우회

- AI1: 미확인으로 group/provider budget이 꽉 찬 모델을 읽기 전용 hint로 제외. 해당 후보의 모든 입력 이력에서 모델 시도 기록이 없고 활성/대기 intent도 없을 때만 고정 칸부터 다음 모델 선택. hint 실패 시 기존 고정 선택. claim 잠금 아래 같은 선택 재확인.
- 추가 보강: 최신 시도 모델이 풀에서 제거되었거나 읽을 수 없어도 다른 모델로 재시도하지 않고 보호(null). 과거 다른 모델 시도로 건너뛰지 않음.
- AI2 재확인: `second-review.ts` enqueue는 voter별 독립 행을 만들며 AI1처럼 candidateId % pool 방식이 아님. `second-review-model-capacity.ts` / `fallbackWaitingSecondReview`는 local-direct 전송 전 waiting/reserved에 한한 기존 fallback. 본 단계에서 AI2의 전송·고정·점유·fallback 정책은 변경하지 않음.
- 최초 분리 tsc는 lifecycle에 단계4 import가 섞여 TS2307(deadline-ladder 없음)로 실패. 이 단계의 timeout 60000을 유지하도록 import만 분리한 후 재실행.
- `bash scripts/verify-review-stall.sh` 최종 종료0, typegen/tsc/lint 및 관련 TS·Python 회귀 성공. 배포와 운영 저장 증가는 단계1 plan 막힘 해소 전 보류.
