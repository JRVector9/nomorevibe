# Oracle 한국어 GitHub 탐색

이 릴리스는 M3의 최신·전체 탐색을 유지하고 Oracle에 `github-ko-discovery` consumer를 추가한다. 배포만으로 실행하지 않는다. `GITHUB_KO_DISCOVERY_VERSION=1`과 `github_ko_discovery_control.enabled`가 모두 필요하며 기본값은 비활성이다. X 타이머와 기존 agent-scan은 변경하지 않는다.

## 데이터와 권한

Oracle은 공통 공개 저장소 검색 페이지를 재사용하거나 한국어 검색어로 후보를 찾고, 한글 설명·README·한국어 README의 실제 설명 문장을 확인한다. `yes`·`no`·`unknown`과 내용 해시만 staging에 남긴다. 번역 링크·파일명·코드의 한글만으로 통과시키지 않는다. 전송 실패·크기 제한·기한 만료는 비한국어와 구분해 15분 후 재시도한다. LLM을 호출하지 않는다.

M3의 분당 `crawl-ko-apply`가 `yes`만 공통 `enqueueDiscoveryBatch`에 전달한다. 두 서버의 5분 환산 신규 적재 목표와 고유 미완료 저장소 상한을 함께 적용한다. Oracle은 frontier·candidate·jobs·role lease·model 표·개인 PAT에 접근하지 않는다. `Oracle Korean` 신호는 기존 fetch의 AI 제작 근거 검사를 항상 통과해야 한다. 한국어 판정으로 AI 제작 여부를 대신하지 않는다.

한 번에 검색 1페이지, 언어 확인 최대 5건, 공유 페이지 재사용 1페이지로 제한한다. staging의 미적용 후보가 10,000건에 도달하면 새 페이지를 확정하지 않고 같은 위치에서 재시도한다. 이미 저장한 응답이 있으므로 GitHub를 다시 검색하지 않는다. 일반 검색 결과의 설명에 한글이 있는 후보는 공유 페이지에서 재사용한다. 한글 설명이 없는 일반 결과의 모든 README를 추가 검사하는 방식은 쓰지 않는다.

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

M3 적용기는 기존 활성 한국어 repository 검색어의 query·우선순위와 미완료 날짜·페이지·분할·재시도 구간을 Oracle 표로 복사한 뒤에만 소유권을 넘긴다. 전체 원본 cursor도 `legacy_state`에 보존한다. 기존 검색 정렬이 recent인지 확인할 수 없으면 고정 날짜·분할·재시도 구간은 유지하고 첫 페이지부터 다시 확인한다. 다른 정렬의 같은 페이지를 재사용해 누락시키지 않는다. 동일 label의 검색식이 바뀌면 이전 query/cursor를 보존하고 새 조건으로 시작한다. 일반 M3 검색어의 진행 위치는 유지한다. 소비자가 중단되면 query lease 만료 뒤 이어가며, 제어 변경은 epoch를 증가시켜 늦게 돌아온 이전 응답을 차단한다.

## 확인과 중지

`github_ko_discovery_queries`의 due/error/lease/cursor, staging의 `language`/`state`, `crawl.korean_applied` 작업 로그와 관리자 탐색 계측을 확인한다. 검색 요청과 새 frontier 적재는 별도 지표다. 한국어가 아니라고 M3 일반 탐색 결과를 삭제하지 않는다.

문제가 있으면 control의 `enabled=false`로 Oracle의 새 탐색·판별·적용을 멈춘다. 기존 M3 한국어 검색어는 다시 M3가 맡으며 일반 최신·전체 탐색과 저장된 Oracle cursor·staging은 보존한다. 실제 활성화 뒤 M3·Oracle·X·agent-scan의 진척과 API 오류를 함께 관측한다. 배포와 관측 완료는 실제 기록으로만 보고한다.
