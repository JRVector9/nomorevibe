# 수집·검수·발행·자동 복구 감사 및 공개 제품 근거 갱신 해결안

후속 구현: [수집→검수 개선·검증](2026-10-14-pipeline-recovery-implementation.md). 아래 PR01~07과 추가 PR00의 코드 개선을 별도 브랜치에서 진행했다. 이 감사의 원래 결함·운영 수치는 보존하며, 개선 후 운영 처리량은 아직 재측정하지 않았다.

후속 실측: [2026-10-14-pipeline-capacity-measurement.md](2026-10-14-pipeline-capacity-measurement.md). 10/14 00:42~01:05 KST에 단계별21회 정기 관측·마지막 묶음 처리 확인, 실제 모델 동시성 비교76회를 수행했다. 신규 검수의 실행 가능 대기는 비워졌지만 공개 근거 갱신은 약1,223source/h로 유지 하한3,453/h에 미달했다. 없는 AI2 기본 모델과 구버전 정책으로 중단된 발행 감사도 확인했다. 아래 감사의 시점별 수치와 후속 측정 수치를 같은 시점으로 해석하지 않는다.

작성: 2026-10-14 KST. 감사 기준 main `edeb8cf0f95d3cb9a587a065f793aa6ce6d2fdd0`, 운영 backend `b5924ac3a2dac3225998671f97117fce78c5246c`. 감사한 수집·근거·job·runtime 주요 경로는 두 revision 사이 diff가 없다. gpt-6.1-sol/xhigh 세 담당이 수집, 검수·발행, 장애 복구를 병렬 감사했고 root가 코드 대조·운영 읽기·추가 집계·보고를 수행했다.

## 1. 결론

현재 수집·검수·발행 워커는 실행되고 실제 저장 결과도 발생한다. 전체 중단이나 현재 주·예비 전환 실패는 확인되지 않았다. 그러나 **모든 실패가 자동으로 회복되는 상태는 아니다.** 초기 수집 결정의 경쟁 조건, 일시적 사이트 오류의 최종 거절 처리, AI 재시도 소진 인계 누락, 근거 갱신의 예산 초과 반복 및 사이트 예약 누락을 확인했다.

공개 제품 근거 지연 약4.8만건은 실제 적체다. 처리량이 현재 갱신 대상 수를 따라가지 못하며 반복 요청과 선택 로직 문제가 이를 악화시킨다. 워커가 살아 있거나 job의 `last_success_at`이 갱신되는 것만으로 전체 출처 갱신 완료를 판단할 수 없다.

이번 작업은 감사·해결안 보고다. 앱코드·환경·스키마를 변경하거나 배포·운영 재시작·장애 주입을 하지 않았다. 앞서 승인받아 실행한 1시간 임시 catch-up은 별도 유지했으며, 사용자 중단 상태인 소개 검수도 유지했다.

## 2. 운영 실측

아래는 서로 다른 시각의 스냅샷이다. 모두 KST이며 읽기 전용 쿼리와 운영 프로세스 상태로 확인했다.

| 항목 | 실측 | 해석 |
|---|---|---|
| 실행 구성 | 13개 core 앱 / 18개 컨테이너 running | M3·mini 웹, scheduler2, 다섯 역할의 주·예비. 예비는 처리량을 늘리는 복제본이 아니다. |
| 준비 상태, 10/13 23:46 | 다섯 역할 ready, scheduler2 fresh, progress overall `ok` | 근거 갱신 출력은 현재 progress 판정에 포함되지 않는다. |
| frontier, 10/13 23:50 | pending/fetching0, failed14 | 14건 모두4회 상한에 도달. 그중 원본 없는 것13건. 적격 수집 대기가0이라는 뜻이지 역사적 실패가 모두 해소됐다는 뜻은 아니다. |
| 원본→후보 연결 | 후보가 없거나 `new`인 원본0 | 이 시점 일반 judge 연결 대기는 없다. |
| 후보 상태 | approved5 / needs_review43 / published45,055 | approved5도 현재 관문 조건을 만족하는 발행 가능5건을 뜻하지 않는다. |
| 보류43건 사유 | second_review_split15, no_description10, suspected_spam9, ambiguous8, ai_review_exhausted1 | 모델 의견 차이·설명 부족·의심 후보는 사람 판단을 요구하는 정상적인 보류도 포함한다. |
| 최근1시간 AI1 결과 | abcllm 성공73 / 실패4 | 실제 운영 성공 기록. 감사자가 새 AI 요청을 실행한 것은 아니다. |
| 최근1시간 AI2 | ai_approved resolved81 | 최초 신규 제품81개라는 의미가 아니다. |
| 현재 정책의 AI1 소진, 10/14 00:06 | ambiguous8건 중2건 | 현재 입력/출처/정책/버전/심사자 일치 실패3회, 성공 없음, source fresh, 자동 후보, star 예외 없음까지 동일 read-only snapshot에서 확인했다. |
| 공개 health | HTTP200 | 웹 응답을 확인했다. 외부 API와 모든 장애 복구 시나리오의 성공을 보증하지 않는다. |
| 소개 검수 | not_before2100 / 미임대 / runs741 유지 | 사용자가 중단한 작업이며 재개하지 않았다. |

실행 중 Swarm 서비스의 restart policy는 `any`, delay5초, 재시도 상한 없음이다. 컨테이너의 HostConfig `RestartPolicy=no`를 보고 자동 재시작이 없다고 판단하면 안 된다. Swarm이 새 task로 교체한다. 워커·scheduler12개는 healthcheck가 있고, 웹6개에는 Docker healthcheck가 없으므로 health값 null을 장애로 계산하지 않았다.

현재 해당 DB backend 연결은11개, 전체 PostgreSQL 연결96/설정상한150이었다. 잠재 PgBouncer client 상한과 실제 PostgreSQL 연결은 다르다. DB pool을 확대해서 적체를 해결할 근거는 없다.

## 3. 단계별 기준과 재실행

| 단계 | 적용되는 기준·보호 | 실패 후 자동 동작 / 수동 경계 |
|---|---|---|
| 발굴 | GitHub 검색 창·페이지·cursor, 설정된 AI 관련 검색/commit trailer, Show HN GitHub 링크. 수집 backlog10,000에서 발굴 억제,5,000 이하에서 재개 | 검색 실패는 cursor를 보존하고 다음 tick/reset시각에 재시도. HN은 다음30분 회차. 자격 설정 오류는 올바른 키/권한 수정이 필요하다. |
| 저장소·페이지 수집 | 공개 저장소 metadata, homepage, 페이지·README·필요시 패키지 설치 근거. `requireEvidence` 신호는 신규 후보의 저비용 AI 흔적 probe | GitHub 일반 오류는5→30→180분 backoff, 총4회 후 frontier `failed`. quota/auth 대기는 reset/backoff 후 재개하며 시도 횟수를 소모하지 않는다. 페이지 오류는 아래 F03 예외가 있다. |
| 중단된 수집 회수 | frontier claim + job lease 검증 | 새 유효 crawl-fetch가 버려진 fetching을 pending으로 회수하고 시도 횟수도 복구한다. legacy10분 회수만 있는 구조가 아니다. |
| 규칙 판정 | URL·중복·차단·제품/프로필 홈 여부, 문서·빈 페이지 등의 거절, 설치형 예외, 의심 spam. 최신24시간의 GitHub 응답으로 star 예외 검증 | 원본 저장 뒤 judge 요청 전에 종료되어도5분 정기 judge가 미판정 원본을 다시 선택한다. 자동 기록은 source/settings/lease가 같아야 한다. F01 초기 gate는 예외다. |
| star 자동승인 | 현재 설정500개 이상 + 양의 GitHub ID + repo full_name 일치 + public/nonfork/nonarchived +24시간 이내 원본 + 현재 candidate marker | 문서화된 정책상 일반 제품 판정·AI1/AI2와 enforceEligibility 관문을 건너뛴다. 최종 URL 중복·차단·설명·저장 transaction은 유지한다. 이를 임의로 AI 필수 정책으로 바꾸는 것은 이번 해결안에 포함하지 않는다. F02는 이 정책보다 앞선 gate 불일치다. |
| 개발 근거 스캔 | source·commit·스캔 상태/관측을 검수 입력에 결합. 현재 enabled, enforceEligibility=false | 부분/실패 스캔은 저장한 cursor/backoff로 재개. 오래된 원본은 재수집, 원본은 신선하지만 스캔이 오래됐으면 우선 스캔 후 검수한다. 역사적 scan의 due 전체를 현재 작업 적체로 셀 수는 없다. |
| AI1 | 현재 enforce, abcllm `[MLX] gpt-oss-120b`, concurrency4. 출력 schema·인용 근거·현재 input/source/policy/model/version·24시간 유효성을 검증 | 동일 입력·출처 revision·provider/model의 실패 최대3회,1/2/4분 backoff. 재수집/스캔으로 출처 revision이 바뀌거나 정책·모델·입력이 바뀌면 새 묶음으로 판단한다. approved 소진은 ai_review_exhausted로 사람에게 넘기지만 일부 needs_review는 F04로 소진 사유 전환 누락. |
| AI2 | 현재 abcllm `[supa] Qwen3.8-27B-NVFP4`, fallback `qwen3-coder:30b`. 현재 AI1 세대에 대한 독립 모델 칸들이 모두 승인해야 발행 가능 | 일시 오류5분/그 외1시간 backoff, fallback 총3회. 모델 의견 차이 또는 최종 소진은 사람 인계. 같은 모델의 중복 표는 승인 수에 넣지 않는다. |
| 설명·분류·발행 | 설명 부재는 생성/사람 인계. 최종 candidate/document/settings/review/lease 재확인, 저장소·URL 중복 방지 | 설명 생성 실패 최대5회. CONNECT 분류 제공자 실패는1시간 hold 후 정기 발행 재확인, direct CLI 경로는 keyword fallback을 사용한다. product/candidate/저장소 링크/최초 갱신 요청은 하나의 transaction이다. 부분 발행으로 재실행되는 구조는 아니다. |
| 썸네일·텍스트 | 썸네일 실패가 product transaction을 취소하지 않는다. 이유·검색문·언어별 소개는 별도 잡/입력 CAS | 썸네일은 별도 정기 작업. 이유 번역은 backoff 재시도, 검색문 생성은5회 등 작업별 상한이 다르다. 한국어 품질 거절은4회/홈 추가2회 의도이나 F10의 횟수 혼합이 있다. 별도 소개 검수 사용자 pause는 유지된다. |
| 공개 근거 갱신 | 현재 visible 링크와 media/declaration의 due, product generation·source·quota 보호. default GitHub24h/링크24h/피드6h | 기본1분 요청,25초 협력 예산, 현재 crawler main lane. source 실패는 지수 backoff/reset시각을 보존한다. `maxRetries=4`는 이 source 경로에서는 종료 횟수가 아니라 backoff 지수 상한이다. F05/F06/F07 참고. |
| job/프로세스/서버 | scheduler10초·2복제본, 요청 version 병합, job heartbeat15초/소유권90초, role lease45초/갱신10초, 예비 grace20초 | job throw는30초 backoff 후 재요청. process hang/장기 실행은 supervisor drain/종료 및 Swarm restart. 역할 갱신 실패는 자식 중단·drain을 시작하고, 새 역할 선출 transaction에서 이전 job token을 무효화한 뒤 늦은 저장을 차단한다. 사람이 pause한 잡은 자동으로 풀지 않는다. F08/F09는 감시 예외다. |

`requestJob`/관리자 잡 재실행은 요청 version을 올리는 동작이다. 항목의 재시도 상한이나 source의 미래 retry시각을 무조건 초기화하지 않는다. 임의로 전체 실패를 계속 재실행하면 provider 장애·잘못된 URL을 반복 호출하게 된다.

## 4. 확인한 결함과 우선순위

P1은 결정 무결성이나 지속 처리 진행을 깨뜨릴 수 있는 결함, P2는 자동 복구·인계·관측의 누락이다. 코드상 가능한 결함과 운영에서 실제 확인한 영향은 분리했다.

### F01 · P1 — 초기 evidence gate가 최신 검수/관리자 결정을 덮을 수 있음

`lib/crawl/jobs/fetch.ts:237–268`은 후보 없음 확인→비동기 probe→원본 저장 transaction→`recordJudgement`를 별도로 실행한다. `lib/crawl/repository.ts:611–634`의 UPSERT에는 현재 상태/decidedBy/source/settings/lease 비교가 없다. 그 사이 관리자 또는 검수 잡이 결정을 기록하면 뒤늦은 fetch가 `rejected/ai_evidence_not_found`로 덮을 수 있다. 발행 연결 필드를 유지한 채 후보 상태만 달라질 수도 있다.

자동 judge의 `recordAutomaticJudgement:638–683`은 이미 snapshot과 lease를 검사하지만 초기 gate는 그 경로를 사용하지 않는다. **경쟁 조건은 코드로 확인했으며 운영 발생 건수는 미확정**이다. 원본 저장+초기 결정의 fenced transaction 또는 absent-only insert로 기존 결정을 보존해야 한다.

### F02 · P2 — 500star 예외 전에 AI 흔적 부재로 거절

초기 requireEvidence gate는 star 예외를 먼저 검사하지 않는다. `rules.ts:215–227`/`star-auto-approval.ts`의 현재 정책과 순서가 맞지 않는다. 저장 metadata상500star 이상/public/nonfork/nonarchived/ID 등 영향 조건에 맞는 `ai_evidence_not_found` 거절19건(최근7일14건)이 있었지만 현재24시간 신선한 원본은0건이다. 역사적 정책과 실제 원본까지 같았다고 증명한19건은 아니다.

최소 수정은 초기 gate가 같은 starAutoApproval 정책을 사용하게 하는 것이다. 영향 후보는 수정 후 원본을 다시 수집하고 정상 judge로 평가한다. 과거 metadata만으로19건을 일괄 발행하지 않는다.

### F03 · P2 — 일시적 사이트 실패가 최종 거절로 끝남

`lib/net/fetch.ts:347–349`/`fetch.ts:397–398`은 응답 헤더를 받기 전 transport·TLS·timeout 등으로 페이지를 못 받으면 status0을 저장하고 수집을 done으로 마친다. `rules.ts:517–518`은 이를 unreachable 거절로 처리한다. HTTP429/5xx도 같은 종결 경로다. 헤더 수신 후 본문 단절·timeout은 `fetch.ts:305–317`에서 이미 bounded retry한다. 저장소 frontier는 중복 발굴로 재등록되지 않고 일반 stale review selector도 rejected를 복구하지 않으므로 사이트가 회복돼도 자동 재평가를 보장하지 않는다.

실측 잠재 재확인 대상은 **1,965건: status0 1,503 /429 110 /5xx 352**, 최근7일542건이다. status0에는 영구 DNS·정책상 unsafe URL도 섞일 수 있어 전부 일시 장애의 오판이라고 부를 수 없다. transport/timeout/429/5xx와 영구 URL/SSRF/명확한4xx를 구분해 기존 bounded frontier backoff에 연결해야 한다.

### F04 · P2 — needs_review의 AI1 소진 사유·인계 집계 누락: 현재2건 확인

`agent-review-repository.ts:282–310`의 소진 인계는 approved만 바꾼다. 반면 `reviewCandidatePredicate:368`은 needs_review도 실패3회 이상이면 재시도 선택에서 제외한다. 현재 ambiguous2건은 입력/출처/정책/버전/현 reviewer가 일치하는 실제 실패3회이고 유효 성공이 없다. 자동 후보·enforce·신선한 source·star 예외 없음까지 확인했다.

상세 검수 화면에는 exhausted 상태가 표시되고 전체 needs_review 집계43건에도 이2건이 포함된다. 다만 운영 처리량/진행 감시의 AI1 수동 인계 집계(`throughput.ts:90–92,110`)는 ai_review_exhausted 사유만 세어 이2건의 소진을 놓친다. 같은 소진 predicate로 needs_review도 소진 사유와 인계 신호를 바꾸고 원래 보류 사유는 signals에 보존해야 한다.

### F05 · P1 — 예산 미완료가 같은 제품부터 반복될 수 있음

`lib/jobs/products/evidence-refresh.ts:127–150`은 일반 source 내부 progress 없이 호출하고 `complete:false`이면 afterSlug 전진 전에 종료한다. `providers/github.ts:511–513,560–563`은 릴리스 페이지 또는 선택적 activity가 예산을 넘으면 이미 받아온 핵심 facts/validator/release도 저장하지 않는다. 페이지 cursor는 호출 안의 지역 변수다.

사이트10초+root8초+병렬 보조 요청8초만 반복해도 기본25초를 넘을 수 있다. 매번 같은 제품·페이지부터 다시 시작하면 정상 heartbeat/완료 tick이 찍히면서 뒤의 제품이 계속 기다린다. **현재 운영은 cursor가 이동하므로 전역 정지 원인이라고 단정하지 않는다.** 저장소 내부 checkpoint와 재시도 시각을 보존하고 일반 순회는 다음 제품으로 넘어가야 한다. 선택적 activity 실패를 불완전 집계로 기록하되 완료된 핵심 facts 저장을 취소하지 않아야 한다.

강제 refresh 요청은 nextAttemptAt 순서로 다시 배치돼 요청 사이에 같은 영구 차단은 없다. 다만 내부 페이지 진척이 없어 개별 요청이 반복 미완료로 남을 수 있다.

### F06 · P2 — canonical_site 자체 due가 직접 선택되지 않음

`refresh.ts:276–319`의 selector는 visible 선언 링크와 media/declaration만 읽는다. 생성된 `product_site/canonical_site`는 직접 대상이 아니다. `refresh.ts:477–480`은 저장소 수집 때 사이트의 미래 nextAttemptAt도 검사하지 않는다. `site-fingerprint.ts:37–48`은 성공24h/실패6h를 하드코딩하고 실패 attempts를 올리지 않는다.

10/14 00:06 실측 사이트 due24,128건 중 **1,017건은 연결된 저장소 due가 없다.** 성공24h·실패6h의 기한을 합친 예약 gap이며 강제 요청 여부는 미구분이다. 별도 강제 요청이 없다면 사이트 기한이 와도 직접 선택되지 않는 영향 후보다. 반대로 저장소의 예산 초과 반복에서는 사이트 쿨다운을 무시하고 다시 fetch할 수 있다. 사이트를 자체 due로 수집하고 미래 due면 기존 fingerprint를 사용해야 한다. 사이트가 회복되면 기존 repo facts로 관계도 재계산해 공개 표시가 추가24시간 기다리지 않게 해야 한다.

일반 GitHub 성공은 githubFactsHours, deferred는 provider reset 또는 공통 backoff로 보정된다. 모든 실패가24h 고정인 것은 아니다. disconnected404/private만 provider 기본24h가 남는 예외다.

### F07 · P2 — 원본304에도 여러 보조 endpoint를 매번 조회

`providers/github.ts:464–469`만 validator를 사용한다. root304이어도 languages·contributors·releases·README와 activity를 다시 요청한다(`505–510,560`). 보통 최소 GitHub6요청+사이트1요청이며 페이지가 늘면 더 필요하다. root304라는 이유만으로 릴리스 등의 보조 자료를 생략하면 변경을 놓친다.

endpoint별 ETag/LastModified와 마지막 정상 payload를 보존해야 한다. 정확한 권한으로 요청한304는 primary quota를 소비하지 않으며, secondary limit과 backoff는 별도로 지켜야 한다. [GitHub REST API 공식 권고](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

### F08 · P2 — 근거 출력·개별 lane의 정체를 놓칠 수 있음

`worker-progress-query.ts:27–33`은 fetch/judge/AI1/AI2/publish만 본다. product-evidence/agent-evidence/AI-level이 출력0이어도 전체 progress는 ok가 가능하다. `scripts/worker.ts:89–99`/runtime은 여러 lane의 상태를 합쳐 보고하므로 다른 lane이 건강하면 특정 lane의 job 시작 전 pending/seen DB poll hang이 가려질 수 있다. 시작된 오래된 job의 timeout 보호는 존재한다.

role-worker는 역할에 유효 실행 job이 하나라도 있으면 전체 저장 정체 검사를 생략한다. 개별 lane의 pollStartedAt/lastProgressAt과 실제 적격 작업의 나이를 확인하되 정상 provider backoff나 사용자 pause는 재시작 근거로 삼지 않아야 한다.

### F09 · P2 — 지속 provider 실패의 alarm과 외부 감시 설치 증거 부족

`worker-progress.ts:19–25`는 최근 오류가 있으면 upstream_or_job_error/alarm=false다. 대기100건·최장120분·저장0이 지속돼도 provider 오류 때문에 계속 alarm이 안 날 수 있다. 제공자 장애 알림과 무응답 프로세스 재시작을 분리해야 한다. 키/권한 오류에서 restart loop를 만들면 안 된다.

두 host의 Docker service와 root crontab에서는 기존 failover monitor 실행을 찾지 못했다. 외부 host/사용자 launchd 설치 및 Uptime Kuma 실제 수신은 미확인이다. 기존 monitor image/read-only 계정/Push·deadman 경로를 사용하고 실제 수신을 검증하면 된다. 새 모니터링 플랫폼은 필요하지 않다.

### F10 · 잠재 P2 — 현재 비활성 provider 및 텍스트 재시도 예외

- Grok AI1은40초 tick 안에서90초 이상 남았을 때만 시작하도록 되어 있어 실행이 안 된다(`crawl/jobs/agent-review.ts:17,42–47`). AI2 input loader도 성공 provider를 claude-cli/abcllm만 인정한다(`second-review-input.ts:60`). 현재 운영 provider는 abcllm이므로 이번 실제 정체 원인은 아니다. 지원하는 설정을 열어둘 거면 예산/whitelist를 함께 고치고 경로 검증, 아니면 검증 전 설정에서 막아야 한다.
- 한국어 소개는 network 실패도 attempts를 올린 뒤 마지막 오류가 rejected이면 동일 attempts로 품질 거절4회를 판정한다(`korean-taglines.ts:73–76,102`). 네트워크5회 뒤 첫 품질 거절에서 조기에 소진될 수 있다. 품질 거절 횟수를 분리해야 한다. 이번 감사에서 운영 영향 건수는 확정하지 않았다.

## 5. 공개 제품 지연 출처: 정확한 작업량

10/14 00:06:26 KST snapshot:

| 대상 | 현재 출처 | 기한 지난 출처 |
|---|---:|---:|
| 공개 제품의 현재 visible 저장소 링크 | 41,351 | 23,159 |
| 해당 공개 제품의 canonical site | 41,345 | 24,128 |
| 합계 | **82,696** | **47,287** |

지연은24,176개 제품에 걸쳐 있고 최장56시간이다. source가 아직 없는 visible 저장소 링크 **1,158개**도 최초 수집 대상으로 별도 존재한다. 공개 제품 source 중 숨김/삭제 링크에만 남은 잔존 source는 이 조회에서0건이었다.

비공개 제품 source의 due2,860건/최장795시간은 별도 범위다. 기존 전체 경고의 최장33일은 이 범위에서 비롯된다. 운영 경고는 공개/current link+canonical_site 지연과 비공개/더 이상 노출하지 않는 출처를 나눠야 한다. 출처 삭제나 timestamp 변경으로 경고를 없애면 안 된다.

47,287은 현재 공개 근거 출처의 실제 지연 수다. 그러나 현재 일반 selector의 직접 후보는 visible link/media/declaration이다. 사이트까지 포함한 원시 source due를 일반 job이 모두 직접 선택한다고 해석하면 안 된다.

## 6. 처리량과 해소 목표

임시 catch-up 시작10/13 23:24:31부터10/14 00:06:26까지 약41.9분 동안 공개 source **1,823개 / 제품922개**의 성공 갱신을 확인했다. 이 값은 같은 기간 기존 작업도 포함한 고유 source/제품 행의 성공 시각 집계이며 수동 batch 완료 건수와 같지 않다. 관측 처리량은 약**2,610source/시간**이다. 앞서 정상 주기만 관측한1시간은1,274source였다.

| 계산 | 필요한 처리량 | 의미 |
|---|---:|---|
| 82,696 /24h | 약3,446source/h | 현 source를 하루마다 갱신하는 기본 유지량의 하한 추정 |
| 유지량 +47,287 /24h | 약5,416source/h | 기존 적체도24시간에 줄이려는 용량 목표 |
| 제안 운영 기준 | 유지3,600 이상 / catch-up5,500 이상 source/h | 실제 success와 공개 due 증가/감소를 함께 계측해 판단 |

실패 사이트6h retry·새로운 발굴·추가 페이지·quota 대기가 더해지므로 위 값은 처리량 계획의 하한이다. site 실패·불완전·영구 연결 끊김은 정상 갱신과 따로 집계해야 한다. **현재 수치로24시간 해소를 약속할 수 없다.** 개선 후5,500source/h를 실제 달성하고 입력량이 유지될 때 단순 추정으로 약23시간 동안 backlog가 줄어드는 수준이다.

현재 PAT1개와 App installation1개는 각 core5000/h로 관측된다. 원본304를 제외해도 저장소당 보조4개+activity1개를 매일 호출하면 약8,615요청/h가 필요하다. 이는 페이지가 각각1개이고 모든 저장소가 해당 경로를 완료한다는 가정의 요청량 추정이며 신규 발굴/검수 API는 별도다. catch-up5,500source/h를 저장소·사이트 쌍으로 처리하면 보조 요청만 약13,750/h다. 따라서 **조건부 조회/불필요한 재호출 절감이 먼저**다. 신규 보조 cache의 최초 구축은200 조회가 필요하므로 cache 축적과 실제304 비율을 확인한 뒤 목표 처리량을 판단한다. 이 시점 quota는 남아 있었으므로 현재 전역 quota 차단이라고 단정하지 않는다.

기존 임시 작업은 같은 job lease, requestedOnly,55초 예산,1시간 제한을 사용한다.10/14 00:03:52 현재42틱 완료·process alive·종료 전을 확인했다.00:24:31 자동종료 예정이고 이후 기존25초 정기 작업은 유지된다. 종료 실제 확인은 후속 기록 대상이며 임시 한 번 실행으로 적체 전체가 해소됐다고 주장하지 않는다.

## 7. 최소 개발 계획: PR 단위

| PR | 수정 범위 | 완료 확인 기준 | 우선순위/의존성 |
|---|---|---|---|
| PR01 수집 결정 무결성 | F01 초기 gate와 source 저장을 lease/CAS로 보호 또는 absent-only 결정, F02에 공통 star 예외 적용 | probe/저장 뒤 관리자·AI 결정 삽입 시 덮어쓰기 없음, lease 상실 no-op,500star/일반 gate 각 정책 유지 | 최우선. 이후19건은 fresh 재수집→judge |
| PR02 실패 복구·수동 인계 | F03 transient 페이지 오류를 기존 bounded frontier retry로, F04 needs_review 소진 사유/신호 인계 | timeout/429/5xx backoff 및 Retry-After 존중, 영구 URL/SSRF는 retry 제외, 총4회 후 명확한 인계. 현재2건의 semantic exhaustion을 관리자 집계에 반영 | PR01과 fetch.ts를 공유하므로 순차 통합 또는 파일 소유권 분리. source·정책 보존, 무한 retry 금지 |
| PR03 근거 갱신 재개·선택 | F05 내부 페이지/부분 checkpoint·shared deadline·다음 제품 진행, F06 site 독립 due·retry/settings·cache 관계 재계산 | 느린 제품이 반복 미완료여도 뒤 제품 갱신. release 중간페이지 재개. site6h retry가 repo24h와 독립 실행. 선택적 activity 실패 시 핵심 저장 유지 | 적체 해결 최우선. 기존 progress/source/cursor 저장 구조를 우선 활용 |
| PR04 endpoint cache·호출 절감 | GitHub root/보조 각각 validator+정상 payload cache, site conditional 지원·future retry 존중 | root304에도 변경된 release 정상 반영. endpoint304 cache 활용. cache 없는304 재수집. 마지막 정상 facts 유지. 입력별 API 수 실측 | PR03과 동일 provider 파일을 공유하므로 순차 통합/소유권 분리 |
| PR05 갱신 용량·한정 catch-up | 기존 crawler 안에서 근거 갱신 전용 lane/55초 예산·단일 제품부터 계측. 목표 미달 시 제품 최대2와 HTTP 전체 동시성 제한/계정별 직렬 queue 검토. 기존 shared cooldown 유지. 추가 catch-up은 필요시 기존 refresh queue/progress로 제한 처리 | 신규 수집/검수 starvation 없음, job/role lease 유지,429시 reset 존중. 성공·실패·현재 due·최장 지연 계측, target5,500/h 미달이면 원인 재측정 | PR03/04 후. 제품2개가 보조4개씩8HTTP 동시 실행이 되지 않게 제한. 별도 상시 worker/새 queue·스케줄러·DB quota 예약·pool 확대 제외 |
| PR06 출력·lane 감시 | evidence 출력/oldest due 포함, 개별 lane poll age, 장기 provider 장애 별도 alarm. 기존 외부 monitor 설치/수신 확인 | heartbeat 정상+출력0을 검출, 정상 backoff/pause에서 재시작 안 함, 장기 provider 오류는 알림, Push 미수신도 감지 | 코드 작업은 앞 PR과 병렬 가능. 운영 fault injection은 별도 검증 window |
| PR07 설정 지원·텍스트 횟수 | Grok 실행 예산/AI2 provider 일치 또는 미지원 설정 fail-fast, 한국어 network/품질 거절 counter 분리 | 현재 abcllm 경로 유지, 지원 provider의 end-to-end gate 확인, network 오류 뒤 첫 품질 거절이4회로 오판되지 않음 | 후순위. 이번4.8만건 적체 선결 조건은 아님 |

PR03→04→05가 적체 해소의 핵심이다. PR01/02/06은 결정 무결성·복구·관측을 함께 보완한다. 자동승인 기준·공개 제품 정의·8시간 스타 관측 주기는 바꾸지 않는다. `batchSize`만20→100으로 늘리거나 standby를 여러 개 켜는 것은 현재25초 예산·역할 lease·API 반복을 해결하지 못한다.

후속 사용자 요청의 PR00 유입 제어는 실제 신규 후보와 후속 실행 가능 대기시간에 맞춰 admission을 조절하는 계획이다. 현 운영에서 페이지 예산만10→6으로 줄였고 정상 적용을 확인했다. 이는 최적값 또는 실제 유입40% 감소의 증거가 아니다. 사람 보류·정책 중단·누적 기록을 자동 처리 backlog와 분리하고 cursor를 유지하며 최소 탐색과 hysteresis를 사용한다. 1차 AI 증설보다 없는2차 모델 설정과 근거 갱신 용량을 먼저 개선해야 한다. PR00 및 기존 PR01~07 구현은 아직 하지 않았다.

GitHub는 secondary limit 방지를 위해 요청 직렬화를 권고한다. 제품 단위 병렬화는 사이트/DB/독립 계정 대기 겹침을 위한 제한적 수단이며 account별 GitHub 요청 queue와 backoff를 우선 적용한다. [공식 REST API 권고](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

## 8. 검증 범위와 남은 검증

실제로 실행한 기존 unit/mock 검사는 모두 성공했다. 중복 파일이 있으므로 아래 사례 수를 합산해 독립 검증 총계로 표시하지 않는다.

| 담당 | 파일/사례 | 실제 결과 |
|---|---:|---|
| 수집 | 10 /85 | exit0 |
| 검수·발행 | 13 /206 | exit0 |
| 복구·runtime | 8 /52 | exit0 |
| root 근거·runtime | 10 /53 | exit0 |

```sh
npm test -- tests/crawl-seed-discovery.test.ts tests/crawl-seed-latest.test.ts tests/crawl-seed-evidence.test.ts tests/crawl-fetch-concurrency.test.ts tests/crawl-fetch-backpressure.test.ts tests/crawl-fetch-evidence-gate.test.ts tests/crawl-fetch-package-proof.test.ts tests/crawl-hn-show.test.ts tests/crawl-readme.test.ts tests/github-collector-accounts.test.ts
npm test -- tests/crawl-rules.test.ts tests/crawl-ai-gate.test.ts tests/crawl-first-reviewer.test.ts tests/agent-review-contract.test.ts tests/crawl-agent-input.test.ts tests/agent-review-job.test.ts tests/second-review.test.ts tests/second-review-job.test.ts tests/crawl-publication-guard.test.ts tests/crawl-publish-evidence.test.ts tests/review-pipeline-equivalence.test.ts tests/crawl-tagline.test.ts tests/translate-reasons-job.test.ts
npx vitest run tests/worker-runtime.test.ts tests/worker-supervisor.test.ts tests/role-worker.test.ts tests/scheduler-runtime.test.ts tests/worker-progress.test.ts tests/failover-monitor.test.ts tests/failover-readiness.test.ts tests/evidence-scheduler.test.ts
npm test -- tests/github-evidence.test.ts tests/product-refresh-progress.test.ts tests/evidence-scheduler.test.ts tests/evidence-worker.test.ts tests/agent-evidence-refresh-budget.test.ts tests/agent-evidence-refresh-demand.test.ts tests/worker-progress.test.ts tests/worker-supervisor.test.ts tests/role-worker.test.ts tests/maintenance-progress.test.ts
```

이번에는 DB integration suite, 외부 AI 표본 정확도 평가, 운영 프로세스 kill/SIGSTOP, 서버 재부팅/전환, 장기24h 관측, 외부 경보 수신을 새로 실행하지 않았다. 기존 운영 문서의 장애 전환·child kill·고립환경 hang 검증은 과거 증거이며 현재의 모든 lane/새 발행 저장까지 다시 검증했다고 말할 수 없다.

기존 테스트는 신규 경쟁 조건·반복 예산 초과 후 뒤 제품 진행·사이트 독립 retry를 충분히 검증하지 않는다. 일부 integration fixture는 예산 초과 시 저장 안 함/커서 유지라는 현재 동작을 기대한다. 기존 검사 성공과 위 결함의 부재는 같은 뜻이 아니다.

비밀 없는 운영 집계와 helper는 `/private/tmp/nomorevibe-pipeline-audit-20261013`에0600으로 저장했다. API키·DBURL·환경 전문·원시 검수 payload는 보고서/Git/도구 출력에 남기지 않았다. 사용자 기존 미추적 산출물은 보존했다.
