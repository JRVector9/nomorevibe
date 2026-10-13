# NoMoreVibe 1인 관리자 운영 감사 — 운영·작업·자원·복구

작성일: 2026-10-13. 읽기 전용 감사 대상: `/private/tmp/nomorevibe-i18n-integration-20261013`, HEAD `4a9a227861b29b1e06aca902ff71d502a3fcaf8a` (PR406 source). 감사 시 `git status --short` 출력은 비어 있었다. 아래 경로·행은 이 HEAD 기준이다.

저장소 코드와 문서만 읽었다. 서버·Dokploy·운영 DB·브라우저에 접근하지 않았고, 비밀값/env 파일을 읽지 않았다. 테스트·빌드·마이그레이션·기능 구현·저장소 수정·커밋을 실행하지 않았다. 문서에 적힌 과거 검증은 문서 근거이며 이 감사에서 다시 실행한 검증이 아니다. `PENDING.md`의 미검증 항목을 완료로 간주하지 않는다. 독립 메모 외 파일을 변경하지 않았다.

## 결론

운영센터는 이미 상당히 완성되어 있다. 역할 lease, 주·예비, scheduler 2복제본, 실제 저장 진행, 작업 요청/처리 버전, cursor, AI 재인증·모델 검사·적용, 설정 적용판, 오늘 할 일, 관리자 변경 이력과 CSV를 재사용해야 한다. 새 운영 대시보드·별도 큐·매시간 GitHub 수집·새 감시자를 설계할 근거는 없다.

1인이 매일 화면을 보지 않아도 장애를 알 수 있는 경로와, 화면에서 내리는 정상/미확인 판단의 정확성이 가장 먼저 필요하다. 그다음 기존 8시간 관측 완료 여부, 실제 풀 전체의 GitHub 가용성, 배포·복구 증거가 관리자와 연결되어야 한다. 비용 전체와 백업 복구 가능성은 현재 관리자 화면만으로 알 수 없다.

운영 구성은 **13개 core 앱**(M3 웹·scheduler 앱 2복제본·5역할 주, mini 웹·5역할 예비)이며 connect-agent를 포함한 최근 문서 inventory는 **14앱·19복제본**이다. 앱 수, 컨테이너 복제본 수, 역할 표의 행 수를 같은 숫자로 표시하면 안 된다. 근거: `AGENTS.md:15`, `README.md:135`, `PENDING.md:65`. 실제 최신 inventory는 이 감사에서 미조회.

## 기능별 상태와 최소 변경

상태는 `구현`(코드에 기능 있음), `부분`(기반은 있으나 1인 업무가 끝나지 않음), `없음`(해당 관리자 경로/기능 미발견)으로 구분한다. P0는 운영 대응 전제, P1는 일상·장애 판단의 신뢰성/복구 시간, P2는 추가 편의·효율이다.

표에서 `status/...`, `activity/...`, `inbox/...`, `export/...`는 모두 `app/(operator)/admin/` 아래 파일의 축약이다. `settings.ts`, `runner.ts`, `catalog.ts`, `contracts.ts`처럼 바로 앞에 전체 경로를 명시한 파일의 후속 행 번호는 같은 파일을 가리킨다.

| 기능 | 상태·현재 진입점/근거 | 1인 운영에서 필요한 이유와 빈틈 | 우선순위·최소 PR / 수용 기준 |
|---|---|---|---|
| 한 곳에서 전체 현황·긴급 조치 | 구현. 메뉴 `/admin/status`: `app/(operator)/admin/AdminNav.tsx:16`. 5탭·10초 화면 갱신·15초 관측·조치 링크: `status/OperationsCenter.tsx:25`, `:70`; 입력/파생/조치 공통 함수: `status/attention.tsx:66`, `:84`, `:124`. | 정상/장애/백로그를 먼저 보고 조치 페이지로 바로 갈 수 있다. 하지만 일부 쿼리 실패가 null→[]가 되어 정상으로 보이는 경계가 있다. | **P1 PR-O1**. 조회 실패를 명시적 미확인으로 전달. 역할·모델을 못 읽었을 때 초록 `0/0 정상` 또는 "손댈 것이 없음"으로 종결하지 않아야 한다. 새 수집 없음. |
| 다섯 역할 주·예비와 lease | 구현/부분. `/admin/status#roles`, `lib/operations/roles.ts:21`, `failover-readiness.ts:30`; 주/예비 관측60초, lease owner/boot/epoch/phase·release·격리 검증. 표 `status/dashboard/RolesTable.tsx:24`. | 주가 살아 있어도 예비 소실을 알아야 한다. 표에는 문제를 표시하지만 모든 readiness 사유가 긴급 조치/메뉴 배지로 올라오지 않음. 표는 owner 릴리스만 보여 주·예비 릴리스/담당 만료값을 이미 조회했는데 사용하지 않는다. | **P1 PR-O1**. 기존 readiness 결과를 공통 조치에 모두 반영. 예비만 없을 때 경고, lease 만료/owner 불일치는 긴급, 조회 실패는 미확인. 상세는 기존 `primaryRelease`, `standbyRelease`, `secondsUntilExpiry`, `epoch` 재사용(`roles.ts:12`). |
| scheduler 2복제본·예약 지연 | 구현. `failover-readiness.ts:58`, `worker-progress.ts:38`, `status/attention.tsx:294`. 서로 다른 최근 관측 키 2개와 예정 시각 확인. | 요청 접수와 실제 소비가 다름을 분리한다. 1/2 경고와 예약 지연 조치가 이미 있다. 컨테이너 실제 replica와 DB 관측은 다른 근거다. | 현 기능 유지. **PR-O1**에 관측 실패·0개·1개·2개를 일관 표시. 앱 하나의 scheduler 2replica를 두 앱으로 계산하지 않음. 실제 재시작·scale은 Dokploy 영역. |
| 웹 두 인스턴스·서비스/릴리스 요약 | 부분. `/api/health`는 DB select1·release·instanceId: `app/api/health/route.ts:9`; 웹 관측 stale45초·최근1시간 필터: `status/attention.tsx:94`. 표는 지연 표시(`RolesTable.tsx:46`). | 웹 한 대가 사라져도 나머지 한 대의 SHA만 있으면 머리 칩이 "웹 m3·mini 같은 릴리스"로 보인다. 칩은 web.stale을 받지 않고 인스턴스 수/기대 ID도 검사하지 않는다. `StatusChips.tsx:12`, `:20`, `:31`. | **P1 PR-O1**. 기대 m3/mini 각각 최신 관측을 요구. 1대·둘 다 stale·미상 release·조회 실패를 정상으로 표현하지 않음. `/api/health` 한 번 성공은 두 웹 확인이나 모든 워커 정상 근거가 아님. |
| 수집·심사·발행 저장 정체 | 구현. `worker-progress.ts:9`는 policy paused/no work/manual attention/progress/backoff/upstream error/unknown age/no progress 구분. `worker-progress-query.ts:27`은 fetch/judge/first/second/publish 5단계. 조치 `attention.tsx:317`. | heartbeat·요청 수 증가로 수집 성공을 오판하지 않게 한다. 이미 목적에 맞는 판정. 단순 큐 증가/유휴/제공자 오류를 프로세스 재시작 사유로 만들면 안 된다. | 현 기능 유지. **PR-O2**에서는 이 판정을 그대로 사용하고 기준을 새로 만들지 않음. unknown과 정책 중단을 장애·성공으로 뭉개지 않음. |
| maintenance·text 저장 정체 | 부분. 주 후보 자동 복구는 `scripts/role-worker.ts:79`, `:141`; `maintenance-progress.ts:14`·`text-progress.ts:9`로 실제 저장·적격 대기·backoff·제공자 오류를 판정. | 외부 `readMonitorStatus`와 관리자 `buildWorkerProgress`에는 해당 두 저장 정체 결과가 없음. 외부 monitor는 6역할 생존+위 5단계만 읽음. 예비 활성은 경보지만 예비가 살아 있으면서 저장을 못 하는 사유가 자세히 안 나온다. | **P1 PR-O2**. 기존 두 read/classifier의 결과를 관측·관리자·기존 monitor 결과에 재사용. 유지보수 backlog가 커도 최근 ping 저장이 있으면 정체 아님. text는 10분 기준·eligible age·provider/backoff 제외 유지. 기존 job lease 실행 중 제외 유지. 새 monitor 없음. |
| 잡/큐/재시도/cursor·수동 요청 | 구현. `/admin/status?tab=jobs&job=...`, `OperationsCenter.tsx:101`는 상태·요청/처리·마지막 성공·예정·notBefore·오류·최근 결과·cursor·요청. `lib/operations/admin.ts:8`: 서버에서도 allowlist/중복·30초 제한·트랜잭션 감사. `lib/jobs/control.ts:14`, `:57`; `runner.ts:143`, `:163`. | 웹 HTTP에서는 collectors를 실행하지 않으며 작업 결과를 직접 고칠 필요 없음. 일반 잡 이력은 최신 결과만 덮어 쓰므로 과거 실패/정체 사유는 Dokploy 로그에서 찾아야 함. 수동 재요청은 auth/쿼터 대기와 항목 재시도 상한을 초기화하지 않음. | **P1 PR-O3** 소규모: 상세에서 "접수이며 완료 아님"·대기 사유·재시도 가능시각·항목 상한과 직접 판단 이동을 명시. 중단/미해결 backoff에 요청 버튼만 안내하지 않음. 일반 잡 전체 히스토리 DB를 새로 만들기보다 이미 저장된 결과+로그 링크/사유 표시부터. |
| 정책 중단·소개 검수 보존 | 구현/부분. `/admin/status` 수집 스위치·사유·메모: `CollectionSwitch.tsx:18`, `status/actions.ts:59`; optimistic settings/audit `settings.ts:122`. 사람 중단은 notBefore 먼 미래, `jobs/status.ts:8`; runner가 성공/실패 뒤에도 보존(`runner.ts:143`, `:165`). | 전체 수집 enabled=false는 seed/fetch/judge/AI/second/publish/감사까지 일부 경로를 멈추지만, 공개 제품 점검·스타 관측 등 모두를 멈추는 총괄 스위치는 아님. 현재 안내는 탐색·수집·판정만 말함. 자동 차단 사고 때 해당 잡만 멈추는 관리자 경로는 미발견. | **P1 PR-O3** 우선 범위 안내를 실제 handler와 맞춤. 필요 시 기존 notBefore를 쓰는 제한된 개별 중단 action만 추가: allowlist·사유·감사·열려 있던 폼 충돌·현재 tick 강제 취소 아님을 표시. `product-intro-check` 재개는 범위 제외. 중단된 소개 검수를 저장/초기화/재요청으로 되살리지 않는 수용 기준 필수. |
| 8시간 스타 관측·홈 공개 자료 준비 | 부분. 기존 잡 `catalog.ts:123`(1분은 동일 회차 재개/마감); 실제 GitHub 수집은 KST00/08/16 마감 전1시간, `star-observation.ts:171`; run 대상·성공·실패·정책·마감 DB `product-star-observation-schema.ts:8`; 공개 reader snapshot `star-growth.ts:55`, `:260`. | 잡은 창 밖에 done:true로 끝나도 해당 회차 관측 완료를 뜻하지 않음. 관리자에는 run 요약/직전8시간 비교가능수/실패 이유 UI가 없고 일반 잡 `product-star-observation` 이름도 `contracts.ts:24` JOB_LABELS에 없음. 현 timeline은 주기1분이라고만 표시(`JobTimeline.tsx:109`). | **P1 PR-O4**. 기존 run/snapshot 읽기 요약을 진단에 추가: 최신 마감 T·T−8h·다음00/08/16·대상/성공/실패·closed/failed·비교가능수·warming/late/no-results 사유·기한 초과 실패. 양성 급상승0건과 관측누락을 구분. 수집 주기/immutable evidence/schema/재시도3회/7일 보존/수집범위를 변경하지 않음. 닫힌 회차 수동 재수집 버튼 없음. |
| 관리자 밖 장애 경보·회복 | 코드 구현, 운영 미검증. `failover-monitor.ts:22` 병렬 판정·unknown, `scripts/watch-failover-readiness.ts:12` 2회 bad/down·즉시 up·30초, Push 오류는 URL 없이 기록. CLI `check-worker-progress.ts:4`, `check-failover-readiness.ts`. | 운영자가 화면을 열어야 알 수 있음. `PENDING.md:115`는 기존 monitor 앱/Push/실제 수신 미배포·미검증, mini Kuma와 함께 사라지는 감시 공백을 명시한다. 독립 uptime URL만 정상이어도 작업이 멎을 수 있음. | **P0 운영 작업 O0**: 이미 만든 monitor/Kuma 경로를 연결하고 수신·회복·deadman를 실제 검증. 신규 감시자 개발부터 하지 않음. **P1 PR-O2**: 동일 판정/사유·측정시각·마지막 Push/회복/미설정·unknown을 관리자에서 읽게 연결(비밀URL는 노출 금지). 운영증거 없는 "알림 활성" 표시 금지. |
| 일일 요약·매일 우선순위·누적 변화 | 구현/부분. `/admin/inbox` 오늘 처리·남은 일·실패한 칸, `inbox/page.tsx:26`; `lib/operations/inbox.ts:142`; 운영24시간 처리량 `dashboard.ts:149`; 발행 feed `:307`; 조치25시간 snapshot/7일 확인함 `operations/attention.ts:8`, `:58`, `:81`. | 현 화면으로 일일 확인은 가능. 자동 일일 통지/정시 report는 미발견. 조치 history는 운영센터 요청 후 after/다른 admin의 badge 계산 때만 쌓임(`status/page.tsx:369`, `status/attention.tsx:485`)이어서 아무 admin 화면도 안 열면 연속시간 관측은 보장 안 됨. | **P2 PR-O8**. 새 collector/job 없이 기존 조회를 묶은 on-demand 일일 요약/다운로드부터: 날짜·측정시각·기간 coverage·새 긴급·남은 사람 일·오늘 처리·오래된 관측·가장 큰 backlog 변화·링크. "24시간"은 실제 coverage가 있을 때만. 자동 전송은 채널/수신자가 정해진 뒤 기존 운영 실행과 연계하며 발송 이력을 기록. |
| GitHub 수집 계정·App 자격 정보 교체 | 구현. `/admin/github-accounts`, page `:17`, `:40`, `:64`; PAT/App 등록·교체·계정 ID검증·암호화·활성/제외·감사 `actions.ts:22`, `:53`; `github-accounts.ts:47`, `:66`. | 관리자만으로 계정을 교체할 수 있음. 환경 토큰은 목록에 없고 만료/철회·최근 auth 거부·shared cooldown은 화면에 없음. App도 오래된 quota 기준/reset은 PAT보다 덜 명확. 공통 암호화 키 보관·회전은 화면 밖. | **P1 PR-O5**. 기존 계정/설치의 관측시각·stale/reset·최근 auth/대기 사유를 안전한 메타데이터로 표시; 환경 토큰은 명시적으로 "관리자 목록 밖/관측불명". 토큰/암호문/secret/hash 식별자 노출 없이 작업 흐름과 연결. 토큰 실제 폐기 시험은 감사에서 하지 않았음(`PENDING.md:96`). |
| GitHub API 가용성·quota·backoff | 부분. 계정 페이지 core 잔여·used·관측/reset(`page.tsx:45`); 런타임 PAT+App+env 풀 `github-accounts.ts:85`; core/search/code_search/graphql/secondary 공유 대기 `github-quota.ts:7`, `:62`. | 운영센터 요약은 enabled PAT의 첫 coreQuota 한 개만 선택, stale도 제외 안 함(`status/attention.tsx:99`, `:429`). App만 운영하면 칩 없음, 다른 계정/App 가용한데 첫 PAT 소진이면 긴급, reset 지난 값도 긴급 가능. API 사용량에는 계정의 다른 앱 사용분 포함(`github-accounts/page.tsx:38`), 저장량과 구분해야 함. | **P1 PR-O5**. PAT+App 각각 최신/미확인·예상 reset, 풀 일부 대기 vs 전체 대기 구분. stale 한도로 확정 경보 금지. resource 구분 없이 단순 잔여 합산 금지(현재 persisted quota는 core만). search/GraphQL은 미관측/기존 cooldown 사실로 표현하고 새 rate_limit 호출을 주기 수집하지 않음. |
| AI 연결·심사 모델·장애 복구 | 구현. `/admin/status?tab=ai`, `status/actions.ts:21`은 status/connect/input/cancel/probe/test/apply·schema·admin·인증본문 미감사·결과버전 감사. `AiConnection.tsx:83` 적용판/최근사용판/실제분류. 모델1시간 calls/fail/latency/agreement `dashboard.ts:224`, `ModelCards.tsx:26`. 게이트웨이 심사와 connect-agent 분류를 구분(`attention.tsx:135`). | 재인증→검사→적용 흐름이 관리자에 있음. 단순 연결 성공/회차 성공을 모델 심사 성공으로 해석하면 안 됨. 여러 2차 투표자는 설정에 있어도 집계는 첫 독립 투표자·첫 fallback 4자리라 전체 투표자의 실패량을 모두 보여주는 화면은 아님(`dashboard.ts:226`). | 유지/ **P2 PR-O7**: 먼저 현재 표시 coverage를 설명, 필요하면 기존 secondReviews의 모델별 결과를 펼쳐 전체 유효 투표/실패 관측. 새 probe·별도 AI 호출 없음. auth 실패는 관리자의 연결 action, 모델서버 launchd 장애는 외부 복구. |
| AI 비용·월 예산·자원 압박 | 부분/없음. 1차 attempts에 input/outputTokens/costUsd 저장(`crawl-schema.ts:230`, `agent-review-repository.ts:493`); gateway는 tokens만(`agent-review-gateway.ts:101`), CLI일부 per-call `$0.15` 제한(`agent-review.ts:163`). 모델 카드에 비용 없음. service 상세 RSS는 supervisor 측정(`OperationsCenter.tsx:100`, `worker-supervisor.ts:126`), DB 조회시간 `operations/admin.ts:21`. | 1인 운영자는 이번 달 알려진 비용과 모르는 비용을 구분해야 함. 2차 schema·분류·번역·검색 호출에 공통 비용/토큰 ledger 없음. worker supervisor RSS는 자식/모델서버/호스트 RSS·CPU·DB pool 전체를 대표하지 않음. 금융 예산 총괄 차단 없음; 작업 시간 예산과 비용 예산이 다름. | **P2 PR-O7**. 기존 1차 attempts의 실제 제공된 비용만 일/월 집계·null coverage·tokens 표시. 0달러와 미관측 구분. 가격을 임의 대입한 전 서비스 비용 추정 금지. 서버 자원은 기존 RSS 종류/관측시각·외부 metrics 링크부터. 월 한도 자동 차단은 실제 청구 데이터와 정책을 정한 뒤 별도 범위. |
| 설정 변경·적용판·기능 플래그 | 구현/부분. `/admin` 크롤·1·2차·신호·분류, `/admin/evidence`, `/admin/ranking`, `/admin/news`, `/admin/categories`; NAV `:28`. 크롤 zod/행잠금/formVersion/필드diff 감사(`settings.ts:122`), 역할4개 적용판 확인·10분 지연(`settings-apply.ts:17`, `:50`). 4개 사용자/스타/피드백/외부전송 플래그는 env 함수(`github-integration/flags.ts:2`). | 데이터 정책은 재배포 없이 바꾸고 무엇이 실제 적용됐는지 볼 수 있다. env 플래그/설정 필수조건/웹·publisher·maintenance 일치와 자동 작업 상한이 한 화면에 없음. 원격 secret/env 편집 기능을 새로 만들 필요는 없음. | **P1 PR-O6**. 현재 서비스 기능의 on/off/미확인·필수조건 readiness·출처(관리자DB vs 배포설정)·담당 역할·설정변경 경로를 read-only 표시. 플래그는 실제 runtime 관측과 drift를 확인하며 비밀값 여부만 표시. UI 토글을 만든다면 4개 env 플래그를 DB로 옮기는 것은 별도 명시적 정책 변경; 이번 최소 PR에 묶지 않음. |
| 배포 SHA·digest·migration·롤백 증거 | 부분. 관리자 role/web release 표시·공통8앱 SHA 불일치 조치(`RolesTable.tsx:59`, `attention.tsx:264`); 독립 CLI는 digest/health/Swarm/두웹/readiness 확인·실패에서 중지·0600 복구스냅샷(`scripts/ops/deploy_shared_images.py:329`, `:456`, `:504`, `:573`). runbook `:119`. | RELEASE_TAG 문자열이 실제 image/소스 동일·최신 main·migration 성공 증거는 아님(`README.md:149`). 관리자는 최신 deployment ID·expected target·실제 digest·실패 단계·마지막 복구를 조회할 수 없음. Git 소스 scheduler/text/maintenance도 같은 도구8앱 밖이며 SHA가 서로 달라도 즉시 오류 아님. | **P1 PR-O6**. 기존 배포 도구가 이미 검증한 비밀 없는 요약만 `operations_observations`/감사에 남기고 관리자에서 읽음. 13core/14incl, 적용대상8앱와 별도앱 coverage 분리. 예상/실제SHA·digest·done/health·migration(직접확인/없음/미확인)·verifiedAt·실패/복구/증거링크. 소스/env/0600snapshot 본문 노출 금지. 배포·rollback·migration 실행 버튼은 최소 PR에 불필요. |
| 장애 원인·일지·로그·감사·내보내기 | 구현/부분. `/admin/activity` actor/kind/IP/UA/action/target/ok/error/diff·필터/정확대상/CSV(`activity/page.tsx:30`, `:72`); immutable DB trigger 문서 `admin-log.ts:8`; `/admin/export?view=...&format=...` 제한·감사(`export/route.ts:18`). 구조화 stdout는 Dokploy로(`observability/logger.ts:1`); job 최신결과(`runner.ts:148`). | 사람의 변경은 추적 가능. 인프라 사건·배포·backup·자동 supervisor 종료/role 교체와 관리자 조치를 한 사건으로 묶어 조회하는 경로/장애 메모는 없음. 외부 side effect 후 audit 실패는 로그만 남김(`admin-log.ts:60`)이라 "모든 변경 전부" 문구는 감사 저장 실패의 한계를 숨긴다. | **P1 PR-O6**의 release/restore summary 감사부터. **P2 PR-O8** 안전한 상태/증거 snapshot 다운로드·운영자 메모를 기존 operationsAudit append로 연결 가능. 원문 로그 무제한 프록시/새 incident 관리 시스템보다 역할·잡·시각·release 기준의 Dokploy 링크/필터 안내 우선. |
| 백업·복원·WAL/디스크/DB 연결 | 관리자 없음, 문서/외부 운영. `PENDING.md:138` 및 `docs/operations/2026-09-29-db-restore-verification.md:14`는 새 primary 논리 dump의 격리복원 기록. 기존 과거backup/PITR·media바이트·보존·디스크/WAL·PgBouncer 미검증(`:42`). README미디어 백업 요구 `:428`. | 웹 상태ok/db조회ok, Patroni 복제/WAL설정은 삭제/오염 복구 가능성을 증명하지 않는다. 1인이 백업 최근성·마지막 성공복원·미검증 데이터를 즉시 알아야 한다. | **P0 운영 작업 O0**: 이미 보관된 백업·보존·WAL/볼륨 여유·실제 media 포함 격리복구를 별도 실제 확인. **P1 PR-O6**에 last backup/restore evidence·대상/시각·검증범위/미확인·문서/외부관리 링크 read-only. 성공기록을 만들어내지 않고 수동 증거 입력은 수행한 사람·시각·링크 필수. 복원·DB 설정 변경은 관리자에 새 버튼을 붙이지 않음. |

## 확인된 판정 공백 — 수정 근거

1. **조회 실패가 정상으로 보일 수 있음.** `loadActionInputs`는 역할·모델·throughput 등 실패를 warn+null로 바꾼다(`status/attention.tsx:59`, `:71`). StatusPage는 roles/models를 []로 넘긴다(`status/page.tsx:385`, `:410`, `:417`). StatusChips는 roles.length=0에서 primaryOk===roles.length로 초록 `워커 주 0/0`, models.length=0에서 초록 `모델 0/0 정상`을 만든다(`StatusChips.tsx:17`, `:28`, `:32`). buildActions는 해당 입력 미확인을 별도 조치로 만들지 않는다. scheduler 칩은 실패기본0/2로 빨갛지만 역할/모델은 반대로 표시된다. 현 코드 경계로 확인한 사실이며 운영에서 해당 failure를 주입하지 않았다.
2. **웹 두 대 증명이 없는 정상 문구.** deriveStatus는 최근1시간 웹 관측·stale를 만들어도 StatusChips는 stale를 타입에서 버리고, 단일 release set이면 "웹 m3·mini 같은 릴리스"다(`attention.tsx:94`, `StatusChips.tsx:31`). table은 stale를 표시하므로 머리와 표가 모순될 수 있다.
3. **예비 소실/owner 문제의 조치 누락.** readiness는 9개 reason을 만들고 표가 모두 번역한다(`failover-readiness.ts:18`, `RolesTable.tsx:6`). buildActions에서 role readiness를 쓰는 조건은 standby_active, 공통 owner release set, scheduler1/2이다(`attention.tsx:256`, `:264`, `:294`). 주 정상+예비소실은 표·칩에서만 보이고 긴급 배지는 반드시 올라오지 않는다. 전체 lease/boot/epoch 불일치를 같은 reason으로 조치해야 재진단이 줄어든다.
4. **quota 요약의 단일 PAT/낡은 값.** 실제 수집자는 env+PAT+App인데 관리자 핵심은 `.find(enabled && coreQuota)`다(`attention.tsx:99`). 고갈된 첫 PAT·reset 지난 quota로 풀 전체가 고갈된 듯 표시할 수 있다. 같은 사용자의 토큰을 독립한도로 합산하면 안 된다(`github-accounts.ts:46`).
5. **회차 성공≠도메인 완료.** runner는 handler가 유휴/window 밖 done:true로 끝나도 lastSuccessAt를 저장한다(`runner.ts:133`, `:144`). 8시간 관측 job은 창밖 곧 끝난다(`star-observation.ts:179`). completed run 및 직전8시간 비교 evidence를 직접 읽는 기존 `getStarGrowthPage().snapshot`을 활용해야 한다.
6. **운영 알림 준비≠코드 있음.** PENDING `:115`와 runbook `:479`에 실제 수신/예비중단/감시자중단 검증이 남는다. 관리자 화면·CLI 한번 정상과 30초 Push 코드만으로 완료라 할 수 없다.

## 최소 실행 순서

코드 PR과 운영 검증을 분리한다. 이 목록은 제안이며 이번 감사에서 실행한 변경/테스트가 아니다.

| 단위 | 범위 | 수용 기준 |
|---|---|---|
| **O0 / P0 운영 확인** | 기존 monitor/Kuma/deadman 연결·수신/회복 확인; 기존 backup 격리복원과 보존/용량 증거 확인. 새 시스템 구축부터 하지 않음. | 운영자가 실제 경보를 수신하고 복구 알림/Push timeout도 확인. mini 전체 장애 시 감시 사라짐을 외부 경로로 알 수 있음. backup은 과거 실제보관본·media 바이트·복원범위·시간이 기록되며 미검증은 남음. PENDING는 실제 명령·시각·결과가 있어야만 완료 처리. |
| **PR-O1 / P1 상태 요약 정확성** | null/unknown 전달, 기대두웹·stale, readiness 모든 reason 조치/배지, 기존 role 상세값. | 데이터못읽음/0관측/한웹/예비소실/lease만료/owner불일치/배포전환을 서로 다른 상태로 표시. 정상0/0과 한웹으로 두웹정상 문구 없음. 기존 query/pure classifier 재사용, 화면마다 같은 상태. |
| **PR-O2 / P1 기존 감시 판정 연결** | 기존 maintenance/text classifier를 monitor/status에서도 공유; monitor 최근 상태·수신검증 구분·사유/deep link. | 정상저장+큰backlog, 유휴, paused/backoff/provider오류/유효joblease는 정체 경보 아님. 실제 저장정체/unknown/회복은 코드상 같은 판정, Push비밀URL 안 노출. 주·예비 감시 유지, 신규 monitor/job 없음. 운영실제검증 별도. |
| **PR-O3 / P1 중단·재요청 안내** | 스위치 실제 범위, 잡요청 도메인상한/대기 안내, 필요시 제한된 개별pause. | 접수와 완료 분리, 요청버전 중복·30초 제한·notBefore·자동재시도상한 유지. paused job 즉시재개 금지. 소개검수 중단을 저장·reset·일괄retry가 못 해제. 진행중 호출 강제취소/토큰수정 없음. |
| **PR-O4 / P1 8시간 관측 완료 요약** | 진단에 기존 star runs/snapshot 요약·잡 라벨/주기설명. | T/T−8h·실측시각·동일저장소비교·실패/누락·0급상승·missing-baseline 구별; collecting은 마감완료 아님. 기존00/08/16/직전1시간수집·immutable·7일 보존 유지. 외부호출 없이 읽기만. |
| **PR-O5 / P1 GitHub 풀 상태** | PAT/App core관측 stale/reset와 공유 대기/인증사유, 풀일부대기/전체대기, env불명 표시. | stale/미관측을 잔여0으로 변환하지 않음. 첫 PAT소진+둘째/App가용일 때 전체고갈 긴급 아님. core/search/GraphQL 구분·사용량/저장량 구분. 비밀값/암호문/hash 노출 없음, 주기 API조회 추가 없음. |
| **PR-O6 / P1 운영 증거 읽기** | 기존 배포 검증도구의 비밀없는 결과/실패/복구 요약→기존 관측·감사→status진단; 기능플래그 현재값/적용범위; backup검증경계/증거링크. | actualSHA/digest와 RELEASE_TAG 구분, 검증시각/대상앱/coverage·migration미확인 표시, 오래된 증거를 현재정상으로 표시하지 않음. snapshot/env/secret는 절대 UI에 실리지 않음. Dokploy·CLI 작업링크/절차를 제공, 실행권한 브릿지 확대 없음. |
| **PR-O7 / P2 비용·AI 관측 범위** | 기존 1차 attempts 비용/토큰·known coverage, 모델카드 coverage/여러표/실측RSS 종류 표시. | null cost는 미관측, `$0`와 구별. 2차/분류/번역 미포함을 전서비스 총비용으로 표현하지 않음. 새 AI호출/임의가격환산 없음. supervisorRSS를 host/worker총메모리로 표기하지 않음. |
| **PR-O8 / P2 일일 요약·증거 내보내기** | inbox/status의 기존 집계 on-demand 요약·표본coverage·download, 기존 audit에 운영자 메모. | 날짜/기준시각/coverage·긴급/남은사람일·오늘처리·변화·링크를 한 화면/파일에서 확인. 관측표본 없는 날을 24h안정으로 표시하지 않음. 명시적으로 경로를 정하기 전 외부 메시지를 보내지 않음. 새 매시간collector/job 없음. |

## 1인 운영 흐름

### 매일 10~20분 확인

1. `/admin/inbox`에서 오늘 처리·남은 직접 판단/요청·24시간 넘은 요청을 확인한다. 실패한 조회칸은 남은일0이 아니다(`inbox/page.tsx:44`).
2. `/admin/status`에서 먼저 빨간 조치와 미확인 관측, 다섯 역할 주/예비·scheduler2·두웹을 확인한다. 다음으로 실제5분 저장진행/대기나이·작업lastError·AI계정/모델실패를 확인한다. 대기가 커도 계속 저장되면 장애 재시작보다 처리량/정책을 검토한다.
3. 현재·직전8시간 관측이 닫혔는지, 비교가능수/실패/late인지 확인한다(현재 관리자에 부족한 PR-O4). T는 실시간최근8h가 아니라 마지막 KST00/08/16마감 비교다. 창밖 job유휴를 수집완료로 세지 않는다.
4. `/admin/github-accounts`에서 관측시각·corereset·사용중계정/App, `/admin/status?tab=ai`에서 인증·검사·적용판을 확인한다. 전체고갈과 일부계정대기를 구분한다(현재 요약 공백 PR-O5).
5. 해당 업무는 `/admin/review`, `/admin/products`, `/admin/audit`, `/admin/github-integrations`로 이동해 기존 기능으로 처리한다. `product-intro-check`는 중단 유지; 소개 수정요청 처리와 자동소개검수 재개는 다른 행위다.
6. `/admin/activity`에서 방금 변경과 실패를 확인하고 필요할 때 필터CSV를 남긴다. 최근 배포·backup복원 검증범위는 별도문서/외부관리에서 확인한다. 일일수치만으로 24시간 운영관측 완료를 주장하지 않는다.

### 장애가 발생했을 때

1. **탐지/분류:** 관리자 긴급칩 또는 기존 독립경보→같은 역할/잡/측정시각·릴리스를 확인한다. 공개health정상은 워커정상 보증이 아니다. DB관측없음은 원인판별불가일 수 있고 전체목록빈값을 정상으로 보지 않는다.
2. **공급자대기:** GitHub reset/secondary/auth 대기, AI auth·rate_limit·gateway 실패는 자격정보/제공자회복을 먼저 처리한다. 관리자 PAT/App교체와 AI재인증→검사→적용은 관리자에서 끝난다. 요청을 반복해 쿼터나 실패상한을 우회하지 않는다.
3. **사람의 결정 필요:** 자동시도소진·원본재수집실패는 `/admin/review`에서 현재근거를 보고 승인/거부/제한된재수집을 결정한다. 무조건모델해제/자동승인으로 우회하지 않는다. CLI `manual_attention` 종료코드0은 사람일이없음을 뜻하지 않는다(runbook `:449`).
4. **프로세스/정체:** 실제저장없는유효대기·scheduler정상·backoff/제공자오류 아님을 확인→기존 supervisor/role lease 복구를 관측한다. 예비활성일 때는 M3주 복구와 주·예비동일릴리스·lease를 확인. 활성예비를 강제로 없애는 action은 관리자에 없다. Dokploy/Swarm과 runbook으로 처리한다. 잠금/token을 DB에서 임의삭제하지 않는다(runbook `:441`).
5. **잘못된자동처리/정책:** 현재수집switch가 멈추는범위를 보고 사유와 함께 끈다. 전체자동쓰기중단으로 해석하지 않는다. 별도잡중단이 필요한 자동내리기/스팸검사 등은 현재 외부DB운영/CLI가 필요하므로 제한된 관리자중단 경로가 PR-O3의 후보이다. 중단된소개검수는 재개하지 않는다.
6. **배포장애:** 마지막targetSHA/digest·deploymentID·migration결과·실패단계·검증coverage→기존 deploy_shared_images 도구/runbook으로 affected앱/역할쌍 복구. 0600스냅샷은 비밀이며 관리자파일다운로드로 옮기지 않는다. 실패단계뒤앱을 계속 배포하지 않는다.
7. **DB/호스트/백업:** 관리자나같은DB를 읽는monitor도 죽을 수 있다. 외부deadman·Dokploy/DB관리/백업관리로 넘어간다. 실제보관백업에서 격리복원·자료바이트·복구시각을 확인하며 DB구성변경/운영복구는 기존 외부 운영 절차를 따른다.
8. **종결근거:** UItoast/요청접수와종결을 구분. 실제저장전진·두웹·주/예비·scheduler·기능플래그/설정판을 다시 확인하고 실행시각·대상·결과·남은미검증을 감사/운영기록에 남긴다. 경보회복과새데이터저장을 별개 증거로 본다.

## 관리자만으로 끝나지 않는 경계

| 작업 | 현재 필요한 외부 경로 | 관리자에서 제공하면 충분한 최소 지원 |
|---|---|---|
| 13core/14incl 실제 앱·19복제본 inventory, 재시작·drain·scale·주복귀 | Dokploy/Swarm/SSH, runbook `:333` | 기대값/마지막검증시각·현재DB관측·사유·정확한외부runbook/앱링크. DB관측=컨테이너실상으로 주장하지 않음. |
| mainCI/이미지발행·digestpull·8앱동시릴리스·별도Git앱교체 | GitHubActions/GHCR·MacCLI·Keychain·rootSSH, runbook `:121` | 기존도구검증결과 비밀없는요약과 실패/복구순서. 새 root권한관리자 API는 불필요. |
| DBmigration·PgBouncer/Patroni/WAL/볼륨·시점복구 | 기존DB인프라·직접DB접속·백업관리 | 마지막실제증거·복구범위·미확인·외부관리링크. web조회ok만으로복구가능판정 금지. |
| monitor/KumaPush·외부deadman·실제알림채널 연결 | 기존monitor앱/Kuma/외부서비스 | 미설정/미검증/최근검사/최근수신확인·사유·운영자연락경로. 추가monitor개발 불필요. |
| 검색임베딩·재정렬모델서버 재시작/호스트CPU/RSS | M3 launchd bot.brut.nmv-* 및호스트metrics | 기존modelServerHealth 실패·잡 backlog·외부서비스링크. 관리자probe는이미1회health, 별도모델부하호출 추가 불필요. |
| env플래그·키회전·네앱공통암호화키·GHCRpull토큰 | Dokploy/Keychain/외부자격정보관리 | 적용된on/off/키존재만·drift·교체시각/미확인; 원문조회·복사경로 만들지 않음. |

## 운영 검증과 코드 확인의 구분

- 문서상 완료: 서비스 최초배포/운영DB/역할시작, 다섯역할주·예비인계, 일부예비의 실제저장, 공통8앱같은SHA/digest배포, 계정풀PAT등록/교체, 새논리백업격리복원. 이번감사에서 재확인하지 않았다.
- 미검증 그대로 유지: 기존monitor앱·실제경보수신/mini전체장애deadman, publisher예비의 실제적격신규제품발행, 실제저장정체2회자동재시작/3회5분격리주입, maintenance장기backlog회복·CPU/DB, 실제PAT한도자연소진전환/reset·실폐기, 기존과거backup/PITR·media바이트·보존/볼륨/WAL/PgBouncer, 24h연속안정관측, 배포게이트실패후실운영복구. `PENDING.md:76`부터 `:150` 근거.
- 8시간은 스타관측/급상승자료주기이다. 운영안정성을 확인하는24시간관측, uptime6시간목표와 별개다. 이 셋을 줄이거나 합치지 않는다.
- `AGENTS.md:23`과 `PENDING.md:150`의 사용자중단소개검수는 계속 유지한다. 자동소개검수재개를 P0복구·일일루틴·일괄retry에 섞지 않는다.

## 다음 담당자용 읽기 전용 명령

이 감사의 증거를 재확인하는 명령이며 테스트/운영연결 명령은 아니다. 현재source/행번호가 바뀌면 최신main/worktree를 먼저 확인한다.

```sh
cd /private/tmp/nomorevibe-i18n-integration-20261013
git rev-parse HEAD
git status --short
rg -n 'roles\?|models \?\?|roleRows|StatusChips' 'app/(operator)/admin/status/page.tsx'
nl -ba 'app/(operator)/admin/status/dashboard/StatusChips.tsx'
nl -ba lib/operations/failover-readiness.ts
sed -n '240,330p' 'app/(operator)/admin/status/attention.tsx'
nl -ba lib/operations/worker-progress-query.ts
nl -ba lib/operations/maintenance-progress.ts
nl -ba lib/operations/text-progress.ts
nl -ba scripts/watch-failover-readiness.ts
nl -ba lib/crawl/github-accounts.ts
nl -ba lib/crawl/github-quota.ts
nl -ba lib/db/product-star-observation-schema.ts
rg -n 'StarGrowthSnapshot|export async function getStarGrowthPage|COMPARISON_HOURS' lib/domain/products/star-growth.ts
sed -n '60,156p' PENDING.md
sed -n '119,164p' docs/operations/independent-workers-runbook.md
sed -n '446,484p' docs/operations/independent-workers-runbook.md
```

완료한 일: 범위에 해당하는 관리자메뉴/상태판/잡/lease/관측/계정/AI/설정/배포·백업문서/감사코드를 읽고 현재구현·공백·우선순위·최소PR·수용기준·매일/장애흐름을 정리했다. 실패접근: 없음; 몇몇추정파일경로는 존재하지 않아 실제rg파일목록으로 재탐색했으며 그파일을 근거로 쓰지 않았다. 남은일: 다른감사담당의제품·심사/권한업무결과와 통합, root배포의최신실행결과를 별도접수하고운영미검증목록과 구분. 저장소수정금지에 따라 docs/CODEX_HANDOFF.md를 이메모로 대체하지 않았고 수정하지 않았다.
