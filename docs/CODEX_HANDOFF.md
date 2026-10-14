# 2026-10-15 KST — 적체 회복 설정·배포 완료, 실제 소진 진행 중

## Current objective / authorization

사용자 지시: `수집을 멈추고, 밀린 작업 전부 진행해서 앞으로 안밀리게 다시 세팅하자`, 이어 `소개 검수도 포함해`.
이전 소개 검수 중단은 명시적으로 해제 승인됐다. 신규 발굴을 멈추고 기존 일감의 실제 결과를 저장한다.
앞선 커밋·푸시·배포 승인과 병렬 검토 지시에 따른 후속이다. 추가 승인을 반복해서 요청하지 않는다.
서브에이전트·직접 Codex CLI는 항상 `gpt-6.1-sol` / `xhigh`.
main은 PR와 최신 base CI `check`가 필수다. 직접 main push/bypass/force push하지 않는다.

## Completed work / exact repository and production state

- PR419 정상 병합, code/runtime **b0879eab83d7020839caef477fd512f842bcf1dc**.
  PR CI38587866210 및 main CI38588635517의 전체 검사·필수check 성공. main의 양 이미지 발행 성공.
- 13앱/18컨테이너 모두 새 runtime으로 교체하고 실제 readiness를 확인했다.
  source 앱5개는 각각533개 파일 hash 일치. 다섯 역할 쌍의 readiness/progress gate 통과.
  scheduler2복제본, web M3 4복제본/mini2복제본 보존. 기존 환경·웹키·기능flags·provider·모델·worker command 보존.
  13앱 배포 단계 합계240.98초이며 preflight/CI/gate/최종verification 대기는 포함하지 않는다.
- 실제 DB journal77/quality컬럼 존재를 읽기 전용 확인했다. 새 DDL과 drain은 없다.
  새 private release.py의 `migrate`도 읽기 전용 기존 스키마 확인으로 바꿨다.
- 공개 양 웹 health 통과. 실제 정상 password/CSRF 로그인 후 private 크롤러 탭 HTTP200/13수집기 확인.
  공개홈HTTP200/새runtime참조/DYNAMIC private no-store/정적자산17개HTTP200/공개관리자404도 확인했다.
  브라우저 시각 검사는 하지 않았고 HTTP·HTML 계약을 확인한 결과다. 토큰/비밀번호를 출력하지 않는다.
- 이번 문서 후속 브랜치 `docs/backlog-catchup-rollout-proof-20261015`.
  docs-only main push는 새 이미지를 만들지 않는다. runtime SHA는 위 b0879ea와 구별한다.

## Operations completed / evidence

- 2026-10-14 14:36:37 UTC: `crawl-seed` / `hn-show-seed.not_before=2100-01-01`.
  `product-intro-check.not_before=NULL`로 재개. 기존 lease/cursor/attempts/성공시각은 보존, operations audit 기록.
  신규 발굴 runs8,905/1,681 그대로를 반복 확인했다. 신규 fetch/judge/AI1/AI2/publish 실행 대기는0.
- 14:41:50 UTC 근거 설정: GitHub facts / link check24→96시간, release feed6시간 유지.
  batch20/maxRetries4/staleAfterIntervals2 유지, 기존 출처 행 재스케줄0.
  현재86,220출처의 반복 수요 약898/h, 관측 성공 약1,507/h. 4일 주기로 수요를 줄인 것이며 속도 개선 실측이 아니다.
  기존24h media backlog0/postponed0을 별도 확인했다.
- 15:38:35 UTC, 전체 새 runtime 확인 후 표준 saveSettings/행잠금·폼버전 CAS·감사 경로로
  `agentEvidence.backgroundRefreshDays=90` 적용. 그 외 설정 hash 일치, 기존 스캔 행 재스케줄0.
  깨끗한 complete/오류없음/cursor없음/nonlimited/nonfuture/공개-only에만 적용한다.
  활성 후보·공유 비공개 수요·미완료·오류·partial·버전 변경·미래 backoff는 기존 기준을 지킨다.
  collector/cache/DAY/검수24h 신선도/공개 stale 표시와 영속 완료·재시도 시각을 바꾸지 않았다.
  배경 주기 질문에 답이 없어90일 기본 방침을 알린 뒤 적용했다.
- M3 root-owned `/Library/Application Support/NoMoreVibe/backlog-20261014`, LaunchDaemon
  `com.nomorevibe.backlog-catchup` 설치/실행. 첫 정상 요청15:11:10 UTC, startup audit15:12 UTC.
  10초마다 직전 done=false+완료version일치+idle+notBefore/retryAfter/quota/CAS 조건을 지켜 후속 요청만 coalesce.
  새 워커를 띄우지 않으며 역할 lease가 실행자를 결정한다. 원격 Node15초/SQL5초/lock1초 제한.
  private config.disabled, 발굴 재개, 2026-11-28T15:09:07Z 기한에 정상 종료. **수집 자동 재개는 하지 않는다.**
  마지막15:41 UTC live status age7.27초/running/enabled/pulse hash 일치 확인.
  로컬 PC 종료와 독립적이지만 M3/Docker/DB/provider가 계속 동작해야 한다.
- private evidence `/Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14`(700/files600).
  snapshot-start/before-policy/after-policy, control/source-settings/background-policy/controller-final/cohort-progress JSON.
  freeze cohort15:22:27 UTC: 근거54,526출처, 최초미스캔14,952레포, 소개1,548건, CDN1,868건.
  실제 성공시각·스캔결과·소개판정·purge확인으로 추적하며 단순 due 감소를 완료로 계산하지 않는다.

## Actual progress / remaining

- 14:37→15:38 UTC 소개 ready2,208→1,258. kept782/replaced155/needs_editor기록3이 추가돼 결과940건 저장.
  같은 구간 `cancelled`10건이 생겨 backoff 대기하며 성공으로 계산하지 않는다. 시도/재시도 시각을 초기화하지 않는다.
- 제작 근거 waiting42,622→16,568에는 배경90일 재분류가 포함된다. 26,054개 실제 새 스캔 완료가 아니다.
  frozen 최초스캔 cohort는15:38 기준 attempted16/완전7/부분9/미시도14,936.
  frozen 근거393개 실제 새 성공, 실패6개; 소개279개 kept/replaced, 사람대기1개, 실패10개. 전체 소진은 계속 진행 중.
- 근거 due54,644. 이전24h 예약이 계속 도래하므로 첫 회복 기간에 due가 증가할 수 있다.
  성공·partial·실패·쿼터와 새 예약을 함께 관측해야 한다. 수십 시간/여러 날을 보장된 완료 시각으로 단정하지 않는다.
- 사유 번역 pending12,549, 검색 검증 ready8,195, 한국어 최초/원문 변경 waiting3,462.
  한국어 quality gaveUp2,709는 일반4회/홈추가2회 기준을 지킨 보류이며 일괄 승인·초기화하지 않는다.
  최신 숫자 표현 검사 a809463도 새 runtime에 포함된다. 원문/실패 출력 근거가 있는 한정 재평가만 의미 있다.
  같은 입력의 무제한 재시도·원문을 형식만 바꿔 새 입력으로 위장·품질 상한 초기화 금지.
- Cloudflare purge1,868건은 운영 credential 미설정으로 미완료. 기존 Keychain 토큰도 Authentication error였다.
  유효 Cache Purge 토큰의 private 파일 경로 또는 사용자 로그인 필요한 별도 발급을 질문해 둔 상태다.
  공개홈 DYNAMIC/no-store는 purge 성공 증거가 아니다. 실제 confirmed_at 저장 전 완료로 표기하지 않는다.
- 현재 사람 소개 보류는 freeze시점35건(현재공개+checked_tagline일치). 기록행 전체수44와 구별한다.
  사람 검수·품질 보류는 실제 교정·추가 근거가 필요하다. 자동 성공/보류 해제하지 않는다.
- 전체 소진·24h 안정성·지속 감소율·backup 복구·외부 monitor 수신·X 상시HOT는 미검증/별도작업이다.

## Modified files / key decisions

코드 PR419: `lib/crawl/settings-schema.ts`, 새 `lib/domain/evidence/agents/refresh-policy.ts`,
`lib/jobs/products/agent-evidence-refresh.ts`, `lib/operations/worker-progress-query.ts`, 관련3테스트.
설정 기본1일로 과거 동작을 보존하고 collector/monitor에 동일 SQL 예정시각을 적용한다.
영속 시각을 바꾸지 않고 스케줄만 분리한다. active/shared demand bool_or가 긴 배경 주기를 무효화한다.
문서는 AGENTS/PENDING/README/handoff/운영회복보고서. 사용자 untracked PT/packages/assets/prototypes/mistake.md 보존.

## Tests actually executed / failed approaches

- 실제 RED→GREEN: legacy 설정2개, 공개25h/89d 기존waiting1→skip;90d due 경계.
  격리 PostgreSQL55439 사용, SQL16-case 경계/활성3상태/공유비공개/partial/error/cursor/limited/version/scope/backoff 포함.
- 집중 통합4파일83PASS, 관련 단위7파일54PASS, 실제 background90/80k/3초 회귀PASS.
  agent full shard2 48파일446PASS65.08초.
- 최신base a809463 통합 후 root 전체 단위256파일2,472PASS7.57초,
  full shard2 48파일446PASS69.21초, TypeScript/lint0(기존warning1)/Next build/i18n/bundlePASS.
  이어 PR/main CI의 전체 quality와 통합3shard 모두 실제 통과, main 양 이미지 발행 성공.
  새 테스트 DB는 검증 후 `docker stop nomorevibe-agent-policy-test-db-20261014`로 중지했다(삭제하지 않음).
- 병렬 정적 검토 CLEAN. 정적 검토는 테스트 실행으로 계산하지 않는다.
- private pulse 초기 clock 비교로 동일 성공 관측을 누락: atomically committed version 비교로 수정.
  초기 write transaction undefined 인자로 TypeError: DB 쓰기 전 실패, 빈 옵션 문자열로 수정 후 요청 저장 확인.
  큰 freeze JSON의 즉시 process.exit가 stdout을 잘라 실패: stdout callback flush 대기 후 성공.
- 새 release verifier의 2100 문자열만 거절하는 약한 gate는 introNULL 계약으로 고쳤다(leased 허용).
  이전 migration helper의 2100 전제/drain 경로는 새 helper에서 read-only 함수로 교체했다.

## Exact next commands

새 code/runtime 배포와 정책 적용은 끝났다. 같은 DB 제어/90일 정책을 다시 쓰거나 migration/drain하지 않는다.
아래 관측/장기감소 확인을 진행하고, 다른 응답/수집 재개 지시가 오면 기존 목표의 steering으로 반영한다.

```sh
git status --short
gh pr list --state all --head docs/backlog-catchup-rollout-proof-20261015 --json number,state,url
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py cohort-progress
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py pipeline-controls
python3 /Users/jr/.config/nomorevibe/releases/2026-10-15-backlog-catchup/release.py verify
python3 /Users/jr/.config/nomorevibe/releases/2026-10-15-backlog-catchup/check_admin.py
```

관측 baseline `frozen-work.json`을 덮지 않는다. snapshot은 새 파일 이름으로 저장한다.
background-policy.mjs는1→90 적용 전용이라 이미90이면 의도적으로 실패한다. 재실행하지 않는다.
controller 종료는 M3 root-owned config.enabled=false 후 정상종료/fresh status 확인이다. 임의kill/queue삭제하지 않는다.
수집 재개는 전체 실처리·실패·품질 보류를 확인하고 유입 제어·96h/90d/쿼터 용량을 유지하는 조건으로 별도 수행한다.
새 release 증거 `/Users/jr/.config/nomorevibe/releases/2026-10-15-backlog-catchup`700/files600.
옛9baf 배포 증거와 소개2100 전제의 옛 verify를 현재 상태에 재사용하지 않는다.
이전 완료 단계 상세는 Git commit b0879ea의 인계 아래 역사 기록과 운영 rollout 문서에 보존돼 있다.
