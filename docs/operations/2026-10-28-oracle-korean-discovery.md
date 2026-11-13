# Oracle 한국어 GitHub 탐색

> **2026-11-13 변경 — 한국어 전용 검색은 Oracle에서만 돈다.** 검색 문자열에 한글이 든 레포 검색 신호(`isKoreanRepositoryQuery`)는
> Oracle이 켜져 있든 꺼져 있든 M3 일반 수집(`crawl-seed`)이 검색하지 않는다(`m3DiscoveryQueries`). 관리자 「검색 신호」 표에서 켜 둔
> 한글 신호는 M3 적용기(`crawl-ko-apply`)가 Oracle 표로 넘기고, Oracle consumer만 검색한다. Oracle을 끄면 한국어 검색은 **멈추며**
> M3로 되돌아가지 않는다. 아래 본문 중 "M3가 다시 맡는다"는 이전 설계는 이 변경으로 대체됐다. 활성화 순서는 맨 아래 「활성화 점검표」를 따른다.

이 릴리스는 M3의 최신·전체 탐색을 유지하고 Oracle에 `github-ko-discovery` consumer를 추가한다. 배포만으로 실행하지 않는다. `GITHUB_KO_DISCOVERY_VERSION=1`과 `github_ko_discovery_control.enabled`가 모두 필요하며 기본값은 비활성이다. X 타이머와 기존 agent-scan은 변경하지 않는다.

## 데이터와 권한

Oracle은 공통 공개 저장소 검색 페이지를 재사용하거나 한국어 검색어로 후보를 찾고, 한글 설명·README·한국어 README의 실제 설명 문장을 확인한다. `yes`·`no`·`unknown`과 내용 해시만 staging에 남긴다. 번역 링크·파일명·코드의 한글만으로 통과시키지 않는다. 전송 실패·크기 제한·기한 만료는 비한국어와 구분해 15분 후 재시도한다. LLM을 호출하지 않는다.

M3의 분당 `crawl-ko-apply`가 `yes`만 공통 `enqueueDiscoveryBatch`에 전달한다. 두 서버의 5분 환산 신규 적재 목표와 고유 미완료 저장소 상한을 함께 적용한다. Oracle은 frontier·candidate·jobs·role lease·model 표·개인 PAT에 접근하지 않는다. `Oracle Korean` 신호는 기존 fetch의 AI 제작 근거 검사를 항상 통과해야 한다. 한국어 판정으로 AI 제작 여부를 대신하지 않는다.

한 번에 검색 1페이지, 언어 확인 최대 5건, 공유 페이지 재사용 1페이지로 제한한다. staging의 미적용 후보 상한은 `KOREAN_STAGING_MAX_PENDING`의 50,000건이다(2026-11-13 코드 변경; 운영 반영은 별도). 한국어 판별 전 `unknown`과 한국어 확인 뒤 공통 큐 전송을 기다리는 `yes` 등을 합친 `state='pending'` 수이며, 모두 한국어로 확인된 저장소라는 뜻은 아니다. 새 페이지를 넣을 공간이 부족하면 페이지와 cursor를 확정하지 않고 같은 위치에서 재시도한다. 공유 페이지 재사용도 같은 잠금 아래 최대 100건의 공간을 확보한다. 이미 저장한 응답은 공유 캐시에서 재사용한다. 일반 검색 결과의 설명에 한글이 있는 후보는 공유 페이지에서 재사용한다. 한글 설명이 없는 일반 결과의 모든 README를 추가 검사하는 방식은 쓰지 않는다.

상한 확대는 검색을 위한 완충 공간을 늘릴 뿐, 회차당 5건인 언어 확인 처리량이나 공통 큐의 신규 적재·심사 예산을 늘리지 않는다. 미판별 후보가 계속 쌓이면 다시 상한에 도달할 수 있으므로 `unknown` 증감과 판별·적재 속도를 별도로 확인한다. 기존 applied/excluded 행·커서·이력은 보존하며 DB 마이그레이션은 필요 없다. Oracle 소비자와 상태 화면 모두 새 코드를 실행해야 상한과 표시가 일치한다.

공통 검색 캐시는 `public-v1`과 `is:public` 조건을 사용한다. Oracle은 RLS로 공개 repository 검색 페이지에만 접근한다. 새로운 principal `nomorevibe_oracle_github_ko`의 예시 권한은 `deploy/oracle/least-privilege.sql`과 `lib/runtime/oracle-db-profile.ts`가 일치한다. 이 PR은 실제 principal 생성·비밀번호·App 허용 목록·운영 DB를 변경하지 않는다.

## 준비와 활성화

1. A의 migration 0138 다음 0139를 전용 DB와 CI에서 검증한다. 운영 migration은 묶음 릴리스 절차로 한 번 수행한다.
2. 별도 principal의 최소권한 프로필을 운영자가 준비한다. 기존 Oracle App을 그 principal의 `oracle_principals`에 명시 허용하고 기존 수집 암호화 키를 안전한 설정 파일로 제공한다. agent-scan principal의 권한을 확대하지 않는다.
3. consumer의 root 관리 환경 파일에 `SERVICE_INSTANCE_ID=github-ko-discovery-consumer-oracle`, `WORKER_ROLE=crawler`, `PHYSICAL_HOST=oracle-osaka-smoke`, 정확한 release, 전용 DB URL을 둔다. `GITHUB_COLLECTOR_SOURCES=apps`와 허용된 App 설치 범위를 사용한다. 개인 토큰·관리자·migration·모델 비밀은 제공하지 않는다.
4. 기존 launcher의 host DB roster에 이 consumer의 감독 1연결·worker 최대 3연결을 포함해 측정한 전체 DB 연결 예산을 선언한다. `HTTP_ORIGIN_PERMITS=0`을 사용한다. 별도 `HOST_BUDGET_ENFORCEMENT`/비상 admission 모드는 이 staging consumer에서 지원하지 않으며 readiness가 거절한다. DB roster 검증은 기존 launcher 경로로 지원한다.
5. `github_ko_discovery_control.start_at`을 관리자가 UTC로 명시한다. 새 전용 검색어의 과거 시작점에는 기본 추측값을 쓰지 않는다. control의 `queries` JSON 배열은 `{label,query,priority}`이며 기본 한국어 README 검색 3종을 제공한다. 기존 관리자 검색 조건에서 꺼 둔 동일 검색어는 자동으로 켜지 않는다.
6. preflight로 전용 프로필·UTC·timeout·App 복호화·제어 행을 확인한다. 환경 opt-in을 켜고 DB control을 활성화한 뒤 `--once` 단건부터 확인한다. 이 문서의 준비·활성화 절차는 실행 영수증이 아니다.

DB 제어의 예시(실제 날짜는 운영자가 정한다):

```sql
BEGIN;
UPDATE github_ko_discovery_control
SET start_at = :'explicit_start_at'::timestamp, enabled = true, updated_at = now()
WHERE id = 1;
COMMIT;
```

M3 적용기는 관리자 검색 신호 중 켜진 한국어 repository 검색어의 query·우선순위를 Oracle 표로 넘긴다. M3 `crawl-seed` cursor에 그 검색어의 미완료 날짜·페이지·분할·재시도 구간이 남아 있으면 함께 복사한다(2026-11-13 변경 배포 뒤 M3의 다음 탐색 틱이 한글 검색어의 진행 상태를 cursor에서 정리하므로, 그 뒤 활성화하면 `start_at`부터 시작한다). 전체 원본 cursor도 `legacy_state`에 보존한다. 기존 검색 정렬이 recent인지 확인할 수 없으면 고정 날짜·분할·재시도 구간은 유지하고 첫 페이지부터 다시 확인한다. 다른 정렬의 같은 페이지를 재사용해 누락시키지 않는다. 동일 label의 검색식이 바뀌면 이전 query/cursor를 보존하고 새 조건으로 시작한다. 일반 M3 검색어의 진행 위치는 유지한다. 소비자가 중단되면 query lease 만료 뒤 이어가며, 제어 변경은 epoch를 증가시켜 늦게 돌아온 이전 응답을 차단한다.

## 확인과 중지

`github_ko_discovery_queries`의 due/error/lease/cursor, staging의 `language`/`state`, `crawl.korean_applied` 작업 로그와 관리자 탐색 계측을 확인한다. 검색 요청과 새 frontier 적재는 별도 지표다. 한국어가 아니라고 M3 일반 탐색 결과를 삭제하지 않는다.

문제가 있으면 control의 `enabled=false`로 Oracle의 새 탐색·판별·적용을 멈춘다. 한국어 검색은 그동안 멈춘다(2026-11-13부터 M3는 한글 검색어를 맡지 않는다). 일반 최신·전체 탐색과 저장된 Oracle cursor·staging은 보존되며, 다시 켜면 저장된 cursor에서 이어간다. 실제 활성화 뒤 M3·Oracle·X·agent-scan의 진척과 API 오류를 함께 관측한다. 배포와 관측 완료는 실제 기록으로만 보고한다.

## 활성화 점검표 (2026-11-13)

실행 영수증이 아니다. 각 단계는 운영자 승인을 받고 실제 결과를 따로 기록한다.

| # | 단계 | 확인 |
|---|---|---|
| 1 | 이 변경(한국어 검색 M3 제외)을 crawler 역할에 배포한다. Oracle consumer 코드는 바뀌지 않았다. | M3 `crawl.seed_page`·탐색 진척에 한글 검색어 신호가 더 나오지 않음 |
| 2 | 운영 DB에 `-- consumer github-ko-discovery` 절만 `BEGIN`/`COMMIT`으로 실행해 `nomorevibe_oracle_github_ko`를 만들고 대화형 `\password`로 비밀번호를 정한다(`2026-10-17-oracle-activation-runbook.md` 2절). | `pg_roles`에 role, 권한 readback = `lib/runtime/oracle-db-profile.ts` |
| 3 | Oracle이 쓸 GitHub App 설치의 `github_collector_apps.oracle_principals`에 `nomorevibe_oracle_github_ko`를 추가한다. agent-scan principal 권한은 넓히지 않는다. | 전용 계정으로 그 설치 1행만 보임 |
| 4 | Oracle(osaka-smoke)에 root 0600 `/etc/nomorevibe-core/consumer-github-ko-discovery.env`를 `deploy/oracle/consumer.env.example` 형식으로 만든다: `SERVICE_INSTANCE_ID=github-ko-discovery-consumer-oracle`, `WORKER_ROLE=crawler`, 현재 Oracle `RELEASE_TAG`, 전용 `DATABASE_URL`, `GITHUB_COLLECTOR_SOURCES=apps`, 수집 암호화 키, `HTTP_ORIGIN_PERMITS=0`, `GITHUB_KO_DISCOVERY_VERSION=1`, 측정한 `DB_POOL_MAX`·`HOST_DB_BUDGET`(감독 1 + worker 최대 3 연결). | `launch.py` preflight가 `korean_discovery_standby_ready` |
| 5 | 관리자 상태 화면 「Oracle 한국어 프로젝트 탐색」에서 과거 시작일(UTC)을 정해 저장하고 켠다. 시작일은 한 번 검색이 시작되면 바꿀 수 없다. M3의 기존 한국어 검색어는 2026-10-28 무렵까지 훑었으므로 그 날짜 전후를 권장 기준으로 삼는다. | 감사 `korean-discovery-control`, `github_ko_discovery_queries` 행 생성(=M3 적용기가 넘김) |
| 6 | `nomorevibe-core-consumer@github-ko-discovery.service`를 `--once`로 한 번 확인한 뒤 enable/start 한다. | 90초 이내 생존 관측, staging `language` 판정, `crawl.korean_applied` 로그, 탐색 진척 `korean` 줄 |

되돌리기: 5단계의 `enabled=false`(관리자 화면) → 한국어 검색만 멈춘다. 6단계 unit stop/disable. 2~4단계 자격은 그대로 두거나 승인 후 회수한다.
