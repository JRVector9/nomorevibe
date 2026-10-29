# 2026-10-15 KST — 신규 발굴 중단과 적체 회복

사용자는 신규 수집을 멈추고 밀린 작업을 처리하도록 요청했고, 소개 검수도 명시적으로 포함했다.
이 문서는 처리 설정과 실제 관측을 기록한다. **전체 적체 소진은 진행 중이다.**

## 처리 상태와 대상

2026-10-14 14:36:37 UTC(23:36:37 KST) `crawl-seed`와 `hn-show-seed`의 `not_before`를
2100-01-01로 설정했다. 이미 발굴한 후보의 수집·검수·발행과 기존 제품의 갱신은 계속한다.
`product-intro-check`의 이전 중단을 해제했고 실제 kept/replaced 결과가 증가했다.
운영 감사 기록을 남기고 기존 lease, cursor, attempts, 성공 시각과 품질 거절 기록을 보존했다.

14:37 UTC 기준으로 실행 가능한 신규 후보의 fetch/judge/AI1/AI2/publish 대기는 모두 0이었다.
전체 보유 제품·출처와 실제 처리 대기를 구별한다.

| 대상 | 관측 수량 | 해석 |
|---|---:|---|
| 공개 제품 | 44,048 | 전체 공개 목록 |
| 현재 근거 출처 | 86,220 | GitHub facts·공식 사이트 전체 대상 |
| 근거 갱신 due | 53,788 | 실제 갱신 예정 시각이 지난 출처 |
| 제작 근거 스캔 waiting | 42,680 | 기존 매일 재스캔 포함, 미스캔 전용 수량 아님 |
| 소개 검수 ready | 2,208 | 중단 해제 뒤 실제 처리 가능한 소개 |
| 한국어 소개 최초/원문 변경 waiting | 3,395 | 품질 거절 재시도 수량은 별도 |
| 한국어 소개 품질 상한 도달 | 2,726 | 자동 성공으로 바꾸지 않는 품질 보류 |
| 사유 번역 pending | 12,666 | 현재·과거 사유의 해시별 자동 번역 일감 |
| 검색 키워드 검증 ready | 8,258 | 저장된 프로필 검증 일감 |
| CDN purge 미확인 | 1,864 | 인증 준비 전에는 완료 불가 |

이 표는 여러 시점의 스냅샷(14:37~14:42 UTC)을 사용하며 같은 시각의 원자적 전체 집계는 아니다.
품질 상한에 못 미친 한국어 거절 477건과 게이트웨이 실패 9건도 기존 backoff에 따라 재시도한다.
소개 검수의 `needs_editor` 기록 수는 현재 공개 제품의 사람 보류 수와 같다고 단정하지 않는다.

## 반복 수요와 실제 완료를 구별하는 설정

14:41:50 UTC GitHub facts와 link check를 24→96시간으로 조정했다.
release feed 6시간, batch20, maxRetries4, staleAfterIntervals2는 유지했다.
기존 출처의 성공·재시도 시각은 변경하지 않았고 출처 행의 강제 재스케줄은 0건이다.
link check 주기 변경이 밀린 media를 미루는지도 확인했다. 이전 24시간 기준 media due0,
변경 때문에 미래로 밀린 기존 media0이었다.

86,220개를 96시간마다 갱신하는 계산상 수요는 약898개/시간이다.
관측한 최근 성공 처리량 약1,507개/시간의 약60%다. 24시간 정책의 약3,593개/시간에는 미달했다.
**4일 주기로 수요를 줄인 것이며 동일한 신선도를 더 빠르게 처리했다는 결과가 아니다.**
실패·쿼터·미래에 도래할 대상이 있으므로 53,788÷1,507≈35.7시간은 보장된 완료 시각이 아니다.

제작 근거에서는 clean complete27,486개가 매일 다시 돌아오고, 최초 미스캔14,792개와
일반 partial1,649개가 남아 있었다. 24시간 실제 완료 약1,450개로는 반복 수요를 감당하지 못한다.
완료된 공개 제품의 배경 재스캔 주기를 별도로 설정하는 변경을 추가했다.

- `agentEvidence.backgroundRefreshDays`: 1..365일, 기본1일로 이전 설정의 동작 보존.
- 깨끗한 complete, error 없음, cursor 없음, coverage 제한 없음, 미래 완료시각 아님,
  활성 후보·비공개 제품의 공유 수요 없음일 때만 배경 주기 적용.
- 미완료·오류·partial·새 탐지기 버전·활성 검수 후보는 기존 주기와 backoff 유지.
- 실제 수집 선별과 운영 집계는 같은 예정 시각 계산을 사용한다.
- 영속 `completed_at`/`next_attempt_at`, collector/cache의 24시간,
  검수 24시간 신선도와 공개 화면의 오래된 근거 표시는 유지한다.

전체 배포 후15:38:35 UTC 운영90일을 적용했다. 30일은 목록44,000개 기준 약1,467개/일로 현재 실측 용량과 비슷해
최초 스캔을 따라잡을 여유가 작다. 90일은 약489개/일이다.
주기상 대기 감소는 실제 스캔 완료로 보고하지 않는다. 최초 스캔은 실제 새 저장으로 확인한다.
표준 설정 저장의 행잠금·폼버전 CAS·감사 경로를 사용했고, 다른 설정은 hash로 일치를 확인했다.
영속 스캔 행의 재스케줄은0건이었다.

## 서버의 기간 한정 후속 요청

M3의 root 소유 private 디렉터리와 LaunchDaemon `com.nomorevibe.backlog-catchup`을 사용한다.
15:11:10 UTC 첫 정상 tick에서 제작 근거·스타·썸네일 작업의 후속 요청이 실제 기록됐다.
다른 역할 워커를 새로 실행하는 방식이 아니다. 기존 역할 lease가 계속 실행자를 결정한다.

10초마다 지정한 기존 작업만 요청한다. 직전 회차 `done=false`와 완료된 요청 버전이 일치하고,
pending 요청·lease·lock·error·미래 not_before·cursor retryAfter가 없을 때만 CAS로 요청 버전을1 올린다.
최근 quota 정보가 없거나 합산 잔여15% 미만일 때는 추가 GitHub 작업 요청을 보류한다.
기존 정기 scheduler와 provider의 개별 quota guard는 유지한다.
새 발굴 중단이 풀리거나 private config가 disabled가 되면 정상 종료하며,
최대 종료 시각은2026-11-28 15:09:07 UTC다. 자동 수집 재개는 하지 않는다.
원격 Node 자체에15초 종료 제한을 두고 SQL5초/lock1초 제한을 적용했다.

초기 read-only 시각 비교는 동일 트랜잭션 내 JS와 DB clock 차이 때문에 후속 요청을 누락했다.
같은 성공 회차의 `requestedVersion=processed_version`으로 확인하도록 수정했다.
초기 write-mode transaction 인자를 undefined로 넘겨 TypeError가 난 실행은 DB 쓰기 전 실패했다.
Postgres.js의 빈 옵션 문자열로 수정 후 첫 실제 요청을 확인했다. 실패를 처리 완료로 계산하지 않는다.

로컬 PC와 독립적으로 서버가 계속 처리하지만 M3 서버·Docker·DB와 필요한 provider가 동작해야 한다.
controller는 임시 회복용이며 향후 수집 재개를 자동 결정하지 않는다.

## 검증과 아직 필요한 확인

격리 PostgreSQL55439를 사용해 기존 매일 재스캔의 RED→새 정책 GREEN을 확인했다.
관련 통합4파일83개, 단위7파일54개, 실제 SQL 경계16개와 background90 설정의80k/3초 회귀를 통과했다.
최신 main `a809463` 통합 후 전체 단위256파일2,472개, 통합 shard2 48파일446개,
TypeScript·lint(기존 warning1)·Next build·i18n·bundle size를 실제 실행해 통과했다.
정적 병렬 재검토에서 남은 P0/P1/P2는 없었다. 정적 검토를 실행 테스트로 계산하지 않는다.
PR419를 정상 병합한 runtime은 `b0879eab83d7020839caef477fd512f842bcf1dc`다.
PR CI38587866210과 main CI38588635517의 quality·통합3shard·필수check가 통과했고 양 이미지를 발행했다.
M3·mini의13앱/18컨테이너를 모두 교체해 readiness·release·source5앱의533파일 hash 일치를 확인했다.
13앱 배포 단계 합계240.98초이며 gate/CI/preflight/최종검증은 제외한 시간이다.
DB journal77/quality컬럼을 읽기 전용 확인했고 새 DDL/drain은 없었다.
정상 관리자 password/CSRF 로그인 뒤 private 크롤러 탭HTTP200/13수집기와 공개 양 웹 health를 확인했다.
공개 홈HTTP200/새runtime자산참조/DYNAMIC private no-store/정적자산17개HTTP200/공개관리자404도 확인했다.
브라우저 시각 검사를 수행했다는 의미는 아니다.

15:12 UTC 후속 관측에서 소개 ready는2,208→1,708로500개 감소했고,
kept428개/replaced71개/needs_editor 기록1개가 실제 추가됐다.
두 발굴 작업의 runs는8,905/1,681로 그대로여서 새 발굴 중단을 확인했다.
근거 성공은 시간당1,514개였지만 기존24시간 예약이 계속 도래해 due는54,483개로 증가했다.
96시간 정책이 기존 예약을 미래로 옮기지는 않으므로 첫 회복 기간의 증가를 숨기지 않는다.
controller 정상 가동 뒤1분 정도의 관측이라 controller의 속도 개선 실측으로 해석하지 않는다.

15:38 UTC 소개 ready는1,258건이었다. 첫14:37 snapshot 대비 kept782/replaced155/needs_editor기록3이
늘어 실제 결과940건이 저장됐다. 같은 구간 cancelled10건은 backoff 대기이며 성공으로 계산하지 않는다.
제작 근거 waiting42,622→16,568에는 배경90일 재분류가 포함된다. 26,054건이 새로 스캔된 결과가 아니다.
근거 due는54,644건이었다.

15:22:27 UTC 밀린 출처54,526개/최초스캔14,952레포/소개1,548개/CDN1,868개를 별도 고정했다.
15:38 같은 cohort를 다시 읽었을 때 근거393개 새 성공/실패6개,
최초스캔16개 실제 시작(완전7/부분9), 소개279개 kept/replaced/사람대기1개/실패10개,
CDN확인0개였다. 현재의 미시도·오류·partial은 각각 남은 일감이며 주기 조정에 따른 숫자 감소와 구별한다.
큰 freeze JSON은 stdout flush를 기다린 뒤 저장했고 baseline을 덮지 않는다.

최신 main의 한국어 숫자 표현 검사 수정도 배포에 포함한다. 기존 품질 상한 도달 행은
코드 배포만으로 재선택되지 않는다. 실제 검사 수정과 관련된 행의 한정 재평가가 필요하며,
attempts/qualityRejections 초기화, 원문을 형식만 바꿔 새 입력으로 위장, 일괄 승인은 하지 않는다.

Cloudflare purge는 운영 인증 미설정이고 기존 Keychain 토큰도 Authentication error였다.
유효 Cache Purge 자격 증명이 필요하다. 홈의 DYNAMIC/no-store는 purge 완료 증거가 아니다.
사람 심사 보류와 실제 품질 거절은 자동 처리 일감과 따로 남겨 사람이 교정할 수 있어야 한다.
실제 전체 소진, 장기 감소율, 실패·쿼터 여유, 수집 재개 후 유입 대비 처리량은 추가 확인 대상이다.

15:38 관측의 사유 번역pending12,549/검색 검증ready8,195/한국어 최초·원문변경waiting3,462/
quality gaveUp2,709도 계속 추적한다. freeze시점 현재 소개와 일치하는 공개 사람 보류는35건이었다.
전체 소개검수 기록의needs_editor44건과는 다른 집계다.

비공개 실행 증거는 `/Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14` 및
`/private/tmp/nomorevibe-agent-policy-20261014`에 권한 제한하여 저장했다.
환경·토큰·원시 설정·로그를 이 문서나 공개 저장소에 복사하지 않는다.

## 2026-10-15 07:34~07:44 KST 후속 실제 결과

Cloudflare 인증 장애는 [실제 복구 기록](2026-10-15-cloudflare-purge-recovery.md)에 따라 해결했다.
양 publisher credential/env·정상 주/예비·실제 HTML purge와 정상 제품 second purge를 확인했다.
22:34:07 UTC CDN 미확인1,579/복구 후 confirmed315/오류0이며 아직 전체 소진은 진행 중이다.

22:34:10 UTC 고정 cohort의 source 새성공12,528/실패195, 최초 agent 시도1,321
(complete1,230/partial91/error2/never13,631), 소개완료1,481/사람대기67/실패0이었다.
현재 소개 needs_editor102와 고정 cohort67은 집계 범위가 다르다. 자동 intro 일감은 소진됐다.
발굴 runs8,905/1,681과 pause는 유지한다.

22:44:33 UTC 서버 controller enabled/allowed/apply, quotaBlocked=false, status age7.76초를 확인했다.
사용자 후속 지시에 따라 자동 처리되지 않는 오류를 병렬 조사·복구하며 사람 판단 대상은 유지한다.
발행분 감사#4를 현재 기준으로 시작했고 22:44:32 UTC 실제 판정8개/timeout8개를 확인했다.
첫 판정이 저장되지 않은 진단 호출은 처리 성공 건수로 계산하지 않는다.
검색 network 상한17개·제작 근거 ID변경/compare404 커서 반복·audit의 짧은 deadline 원인을
회귀 테스트로 확인하고 수정 중이다. 새 코드 배포 전 정상 선택이 복구됐다고 주장하지 않는다.

08:23 KST 읽기 전용 재관측에서 고정 source cohort 실제 새 저장14,068, agent 완전1,402,
소개 완료1,481/직접 편집67, CDN confirmed1,440이었다. 전체 CDN 대기는455/오류0이며
신규 발굴 runs8,905/1,681과 중단을 보존했다. 서로 다른 시점·전체 큐와 고정 cohort를 혼합하지 않는다.
현재 소개 직접 편집102와 자동 소개 소진도 이전 관측과 같았다.

별도 Grok CLI `grok-4.7`/`low`로 공개 출처 갱신을 조사했다. 55초 틱 포화와 GitHub 수집 시간73%,
회차 사이5~10초 대기를 실측했다. [출처 처리량 보고서](2026-10-15-evidence-source-capacity.md)에
안전한 개선의 검증과 실제 반영 상태를 기록한다. 부적절한 cursor·quota 초기화나 예약 연기로
갱신 완료 건수를 만들지 않는다. 새 코드의 PR·CI·운영 반영은 해당 보고서와 handoff를 따른다.


## 2026-10-15 11:05–11:07 KST — 기술 오류 후보 회복과 고정 적체 재확인

이전 게이트웨이 오류 때문에 심사 시도 상한에 머물렀던 후보 `114695 · growthxai/output`을
공식 추가 근거 수집 경로로 정확히 한 번 요청했다. 실행 직전 현재 입력·출처·정책 해시와
현재 규칙·프롬프트에 일치하는 시도가 0개이고, 옛 3회는 실제 판정 없이 `gateway_error`로 끝났음을 확인했다.
운영 감사 `12742`에는 `system:backlog-catchup`/`token`의 `evidence-collect`가 남았다.
공식 요청 `96108`의 접수 시각은 UTC 02:03:05다.

정상 작업자가 새 원본 수집 → 규칙 판정 → 완전 제작 근거 스캔 →
1차 `[MLX] gpt-oss-120b` → 2차 `[supa] Qwen3.8-27B-NVFP4` 순서로 처리했다.
두 모델이 승인했고 UTC 02:04:11 자동 발행했다.
02:06:19의 실제 읽기에서 제품 `46071`, slug `output`, 공개 `seeded`, `https://output.ai`와 원 저장소 연결을 확인했다.
메이커 소개 140자가 저장돼 있다. 별도 소개 검수 기록은 없으므로 소개 검수 통과로 세지 않는다.
02:07:17의 공식 자동 소개 검수 selector에서는 대기 대상이 아니었다.
옛 오류 3건의 해시·규칙·오류·판정 NULL은 모두 보존됐으며,
카운터 초기화·직접 상태 승인·모델 직접 호출·재요청은 하지 않았다.

비공개 증거는 `backlog-recovery/2026-10-15/candidate114695-recovery`의
`official-request-20261015T020305291964Z.json`,
`observe-20261015T020502283582Z.json`,
`final-20261015T020619790487Z.json`, `intro-selector-20261015T020717097219Z.json`이다.
각 파일 권한은 600이며 자격 증명을 문서에 복사하지 않는다.

같은 날 UTC 02:07:24.816에 최초 고정 적체를 read-only로 다시 조회했다.
기준 시각은 전날 UTC 15:22:27.413이며, 주기 변경으로 줄어든 전체 대기 수와 혼동하지 않는다.

| 고정 대상 | 최초 대상 | 실제 후속 결과 |
| --- | ---: | --- |
| 제품 근거 출처 | 54,526 | 새 저장 19,118, 시작 후 실패 304, 식별자 변경 9, 삭제 0 |
| 제작 근거 최초 스캔 | 14,952 | 실제 시도 1,952: 완전 1,841·부분 111, 미시도 13,000, 오류 2 |
| 소개 검수 | 1,548 | 완료 1,481·직접 편집 67·실패 0 |
| 기존 CDN 갱신 | 1,868 | 재확인 완료 1,868 |

실패·식별자 변경·부분 스캔은 저장 성공과 별도 집계이며 서로 배타적이라고 가정해 합산하지 않는다.
신규 GitHub/Show HN 발굴은 2100년까지 중단, runs `8,905`/`1,681`을 유지했다.
소개 검수 중단은 해제돼 있다. 서버의 기간 한정 controller와 기존 역할 작업자가 나머지 자동 적체를 계속 처리한다.
전체 적체가 소진됐거나 사람이 볼 항목만 남았다는 뜻은 아니다.
이번 접속 실패 자동 내림 519개와 그 CDN 상태는 [별도 보고서](2026-10-15-uptime-auto-ban.md)를 따른다.


UTC 02:10:47.976 후속 snapshot에서 전체 진행은 ok, 소개 자동 ready0이었다.
근거 출처 due48,300/최근1시간 새 저장1,952, 제작 근거 스캔 waiting14,385였으며 두 단계 모두 progressing이었다.
일반 접속 확인은 최근1시간5,634개 저장/현재due342였다. 이 값은 최대 용량 실험 결과가 아니다.
현재 후보 needs_review는 모델 의견 분할181/스팸의심9/판단불명4/소개없음13/저장소삭제1로,
옛 gateway 오류 심사상한 항목은 없어졌다. 이 합계208과 다른 사람 큐는 중복 가능하므로 더하지 않는다.
수집→규칙→1차→2차→발행의 실행 가능 대기는 모두0이었다.
제품 근거·공개 재검수·번역 등 별도 자동 적체가 남아 있어 전체 완료로 표시하지 않는다.

UTC 02:13:53 서버의 LaunchDaemon이 loaded/enabled/allowed/apply 상태이며 오류없음을 다시 확인했다.
status age9.544초/tick3,929/quotaBlockedfalse였고 정상 후속 작업을 요청하고 있었다.
로컬 PC와 독립적으로 가동 중이며 신규 발굴을 재개하지 않는다.

## 2026-10-18 신규 발굴 재개

사용자 지시로 2026-10-18 08:19:16 KST(UTC 10-17 23:19:16)에 `crawl-seed`·`hn-show-seed`의
`not_before`를 비웠다. 한 트랜잭션에서 두 잡이 여전히 2100-01-01 정지이고 lease가 없을 때만 바꾸고,
운영 감사 13090(`pipeline-discovery-resume`)에 바꾸기 전·후를 남겼다. cursor·요청/처리 판은 건드리지 않았다.
같은 SQL을 먼저 rollback으로 실행해 문법과 상태 검사를 확인했다.

두 잡은 재개 직후 바로 실행·성공했다. seed는 지난 회차가 덮은 끝에서 3일 조각으로 이어 받으므로
정지 기간의 저장소를 건너뛰지 않는다. 재개 뒤 3시간 동안 공개 등재 240건이었다.

서버의 기간 한정 controller(`com.nomorevibe.backlog-catchup`)는 설계대로 신규 발굴 재개를 보고 정상 종료했다
(exit 0, KeepAlive `SuccessfulExit=false`라 다시 뜨지 않음). 이후 제작 근거·스타·썸네일 후속 요청은
기존 scheduler 주기로만 돈다. 같은 날 제작 근거 대기는 약 2,750(최장 약 37일)이며 진행 중이다.

## 2026-10-29 빈 화면 본문 규칙(shadow)과 남의 사이트 8곳 — `lib/crawl/rules.ts`

사람 지시 "추가할 규칙 넣어서 rules.ts 업데이트해"의 코드 몫. 운영 DB 쓰기·SSH·배포는 하지 않았다(대표가 한다).
근거는 10/22~10/29 1차 AI 웹 심사 11,486건(승인 6,366·거부 5,053)이고, 원자료는 main-agent 보고
`nomorevibe-rule-gap-20261029/rows.jsonl`이다.

### 끝낸 것

- `rules.ts`의 `stubTextHits`/`stubTextHit`: AI와 같은 본문(`pageFactsFromDocument().textSample`)을 NFKC+소문자로 본다.
  응답 코드를 확인한 뒤 웹 경로에만 건다(설치형 경로·`pageStatus` 없음·오류 응답에는 걸지 않는다).
  1) 제목만(≤300자, 제목·호스트·저장소 이름에 없는 낱말 0개, 본문 없음 포함) 2) 로딩만(≤60자) 3) JavaScript 껍데기(≤300자)
  4) 로그인 화면만(≤150자, 가입 문구 없음) 5) 출시 예정·대기 명단(≤400자). 문서 갈래 규칙은 넣지 않았다.
- 설정 `judge.stubTextRules = off | shadow | enforce`, 기본 `shadow`. 얕은 병합이라 운영 저장 judge에 이 칸이 없어도 shadow다.
  - shadow: 판정·사유·발자국(trace)·AI 입력을 바꾸지 않고 `signals.stubTextShadow = {id, rule, detail}`만 남긴다.
    판정 잡이 남기고, 1차 AI 결과를 반영할 때(발행 보호 적용 중) 같은 재확인 판정으로 다시 쓴다.
  - enforce: `not_a_product`로 거부한다. 1차 AI 직전 재확인에서도 모델을 부르지 않고 규칙 거부(provider `rules`)로 끝낸다.
  - off: 아무것도 남기지 않는다.
  - shadow·off는 심사 정책 해시(`reviewPolicyHash`)에 넣지 않는다 — 이 배포만으로 진행 중인 1·2차 심사가 낡지 않는다.
    enforce로 바꾸면 다른 판정 기준 저장과 같이 해시가 바뀐다.
- `thirdPartyHosts` 코드 기본값에 zenodo.org·arxiv.org·pkg.go.dev·codeberg.org·stackblitz.com·codefloe.com·zenn.dev·xdaforums.com
  (huggingface.co는 넣지 않음). **운영에는 저장된 21개가 코드 기본값을 통째로 덮으므로 배포만으로는 적용되지 않는다** — 아래 2번.
- 관리 화면 `/admin` "판정 기준" 카드에 "빈 화면 본문 규칙" 선택(꺼짐·관측·적용, 1차 AI 발행 보호와 같은 낱말). 저장 바·기본값 되돌리기 창도 같은 낱말.

재측정 — 구현한 `stubTextHits`를 rows.jsonl(AI 웹 심사 11,486건)에 그대로 걸었다. 기대치는 분석 스크립트 a3.py·a8.py 값이고 그대로 재현됐다.
다시 잴 때는 `npx tsx scripts/measure-stub-text-rules.ts <rows.jsonl> --check`(DB·네트워크 없음, 지시 수치와 다르면 종료 코드 1).

| 규칙 | 기대 거부/승인/보류 · 일치 | 실측(구현 코드) |
| --- | --- | --- |
| 1 제목만 | 1,387/229/29 · 84% | 1,387/229/29 · 84.3% |
| 2 로딩만 | 38/1 · 97% | 38/1/0 · 97.4% |
| 3 JavaScript 껍데기 | 70/13 · 84% | 70/13/0 · 84.3% |
| 4 로그인 화면만 | 80/16 · 82% | 80/16/1 · 82.5% |
| 5 출시 예정·대기 명단 | 9/1 · 90% | 9/1/0 · 90.0% |
| 1~5 합계 | 1,582/260/30 · 84.5% (16.3%) | 1,582/260/30 · 84.5% (16.3%) |
| 6 호스트 8곳 | — | 33/0/0 · 100% (huggingface.co는 13/7로 갈려 제외) |

- 5번 문구 "be the first to"는 know·try 뒤만 본다. 그냥 두면 돌아가는 앱의 빈 목록 안내("Be the first to chirp!")까지 집어 승인 2건이 늘었다(9/3·75%).
- 한계: rows에는 저장소 이름이 따로 없어(스냅숏 name은 제목, 없으면 저장소 이름) 저장소 이름 낱말 없이 쟀다. 운영 규칙은 저장소 이름 낱말도
  "아는 낱말"로 보므로 1번이 이 표보다 조금 더 걸릴 수 있다. 이 차이는 아래 shadow 측정으로 확인한다.
- 사람 정답 50건 표본(2026-10-29, b577191d): enforce로 판정하면 정답이 거부인 4건(#25·#36·#38·#49)을 더 거르고 정답이 올림인 것은 0건 거부했다.

### 남은 것(대표) — 배포 → 하루 shadow → 50건 사람 검토 → enforce

1. **배포.** 일반 배포 경로(`npm run deploy -- scope|plan|run`). 판정 잡·1차 AI 기록은 워커, 선택 칸은 웹이다. 기본 shadow라 판정 결과는 바뀌지 않는다.
2. **운영 남의 사이트에 8곳 더하기(기존 21개 보존).** `/admin` → "거르는 목록" 카드 → **남의 사이트** 탭(옆에 ● 표시) →
   노란 상자 "코드 기본값에 있는데 저장된 목록에 없는 8개" → **모두 더하기** → 화면 아래 저장 바에 "남의 사이트 +8"이 보이면
   **저장 — 다음 틱부터 적용**. "모두 더하기"는 빠진 것만 뒤에 붙이고 기존 21개는 건드리지 않는다(저장하면 29개). 다른 칸은 손대지 않는다.
   저장 뒤부터 새 판정과 1차 AI 직전 재확인에 적용된다(이미 판정·발행된 것은 그대로). judge가 바뀌므로 진행 중인 2차 심사는 `policy_changed`로 다시 준비된다(다른 판정 기준 저장과 같다).
   저장은 `saveSettings`(행 잠금·zod 검증)를 거치고 운영 감사 `settings-save`에 바뀐 칸이 남는다. 저장 전·후에 아래 SQL ④⑤⑥으로 확인한다.

```sql
begin read only;
set local statement_timeout = '30s';
-- ④ 저장 전: 운영에 저장된 남의 사이트 목록(지금 21개)과, 그 목록에 아직 없는 8곳
select jsonb_array_length(values->'judge'->'thirdPartyHosts') as stored_count,
  (select array_agg(h order by h) from unnest(array['zenodo.org','arxiv.org','pkg.go.dev','codeberg.org','stackblitz.com',
     'codefloe.com','zenn.dev','xdaforums.com']) h
   where not (values->'judge'->'thirdPartyHosts') ? h) as missing_hosts,
  values->'judge'->>'stubTextRules' as stub_text_rules,   -- null 이면 코드 기본값 shadow(관리 화면에서 한 번 저장하면 값이 채워진다)
  updated_by, updated_at
from crawl_settings where id = 1;
-- ⑤ 저장 후: 29개, missing 0개, huggingface.co 없음 — 저장 전 21개가 모두 남았는지는 ④의 목록과 견준다
select jsonb_array_length(values->'judge'->'thirdPartyHosts') as stored_count,
  (values->'judge'->'thirdPartyHosts') ? 'huggingface.co' as has_huggingface,
  values->'judge'->'thirdPartyHosts' as hosts
from crawl_settings where id = 1;
-- ⑥ 감사 기록: 최근 설정 저장(남의 사이트 +8, 빈 화면 본문 규칙 관측 → 적용)
select id, created_at, actor, ok, error, detail->'changes' as changes
from operations_audit
where action = 'settings-save' and target = 'crawl_settings'
order by created_at desc limit 5;
rollback;
```
3. **하루 shadow 관측.** 아래 SQL ①②로 규칙별 AI 결정과 일치율을 잰다(시작 시각을 배포 완료 시각 UTC로 바꾼다). 위 재측정 표와 비교한다.
4. **AI 승인과 엇갈린 50건 사람 검토.** SQL ③이 고정 순서로 50건을 뽑는다. 건마다 주소를 열어 "올림/거부"를 붙이고 규칙별로 센다.
   사람 기준으로 올려야 할 것이 한 규칙에 몰리면 그 규칙을 코드에서 고친 뒤(새 PR) 다시 shadow로 잰다.
5. **enforce 전환.** `/admin` → "판정 기준" 카드 → **빈 화면 본문 규칙**에서 **적용** → 저장 바 "빈 화면 본문 규칙 관측 → 적용" 확인 → 저장.
   운영 감사(`settings-save`)에 바꾸기 전·후가 남는다. 되돌릴 때는 **관측**으로 저장한다. 전환 뒤 거부는 `signals.stoppedAt.rule`이
   `제목만 있는 페이지 아님`·`로딩 화면만 아님`·`JavaScript 안내만 아님`·`로그인 화면만 아님`·`출시 예정·대기 명단 아님`으로 남는다.

shadow 측정 SQL(읽기 전용, `begin read only … rollback`). 일회용 PostgreSQL에 같은 스키마로 문법·결과 모양을 확인했다(운영에서는 실행하지 않았다).

```sql
begin read only;
set local statement_timeout = '30s';
-- ① 규칙별: 걸렸을 규칙(signals.stubTextShadow) × 그 후보의 마지막 1차 AI 결정
with ai as (
  select distinct on (a.candidate_id) a.candidate_id, a.outcome->>'decision' as decision
  from crawl_review_attempts a
  where a.kind = 'automatic' and a.state = 'succeeded' and a.provider <> 'rules' and a.reused_from_attempt_id is null
    and a.completed_at >= timestamp '2026-10-30 00:00:00'   -- 배포 완료 시각(UTC)으로 바꾼다
    and a.snapshot->'product'->>'accessMode' = 'website'
  order by a.candidate_id, a.completed_at desc, a.id desc
)
select coalesce(c.signals->'stubTextShadow'->>'id', '합계') as rule,
  count(*) filter (where ai.decision = 'reject') as ai_reject,
  count(*) filter (where ai.decision = 'approve') as ai_approve,
  count(*) filter (where ai.decision = 'needs_review') as ai_hold,
  round(100.0 * count(*) filter (where ai.decision = 'reject') / nullif(count(*), 0), 1) as agree_pct
from crawl_candidates c join ai on ai.candidate_id = c.id
where c.signals ? 'stubTextShadow'
group by rollup (c.signals->'stubTextShadow'->>'id')
order by grouping(c.signals->'stubTextShadow'->>'id'), 1;
-- ② 분모: 같은 기간 1차 AI 웹 심사 후보 수(걸린 비율 = ① 합계 / 이것)
select count(distinct a.candidate_id) as ai_web_candidates
from crawl_review_attempts a
where a.kind = 'automatic' and a.state = 'succeeded' and a.provider <> 'rules' and a.reused_from_attempt_id is null
  and a.completed_at >= timestamp '2026-10-30 00:00:00'
  and a.snapshot->'product'->>'accessMode' = 'website';
-- ③ 사람 검토 표본: 걸렸는데 AI가 승인한 것 50건(고정 순서라 다시 뽑아도 같다)
with ai as (
  select distinct on (a.candidate_id) a.candidate_id, a.id as attempt_id, a.outcome->>'decision' as decision, a.outcome->>'reason' as reason
  from crawl_review_attempts a
  where a.kind = 'automatic' and a.state = 'succeeded' and a.provider <> 'rules' and a.reused_from_attempt_id is null
    and a.completed_at >= timestamp '2026-10-30 00:00:00'
    and a.snapshot->'product'->>'accessMode' = 'website'
  order by a.candidate_id, a.completed_at desc, a.id desc
)
select c.repo, c.product_url, c.signals->'stubTextShadow'->>'id' as rule, c.signals->'stubTextShadow'->>'detail' as detail,
  left(d.page_meta->>'title', 120) as title, left(d.page_meta->>'textSample', 400) as text, ai.attempt_id, left(ai.reason, 300) as ai_reason
from crawl_candidates c
join ai on ai.candidate_id = c.id and ai.decision = 'approve'
left join crawl_documents d on d.repo = c.repo
where c.signals ? 'stubTextShadow'
order by md5(c.repo || ':stub-text-20261030')
limit 50;
rollback;
```

- 판정 잡이 shadow를 남기는 것은 배포 뒤 새로 판정하는 후보다. 1차 AI 결과 반영 때 다시 쓰므로, 배포 전에 판정돼 AI를 기다리던 후보도 AI 결정과 함께 기록된다.
- ①의 `ai_approve`가 사람 검토 대상이다. AI 결정은 사람 정답이 아니므로 일치율을 정확도로 읽지 않는다.
