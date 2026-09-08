# NoMoreVibe

AI로 만든 제품의 마켓 데이터베이스. 메이커가 AI 코딩 툴에서 `/nomorevibe` 한 번을 실행하면
배포한 서비스가 등록된다.

**원칙: 우리가 직접 확인한 것만 보여준다.**
`✓` 표시는 도메인 소유권 검증에만 붙는다. 메이커가 밝힌 제작 AI는
**메이커 신고**로 표기하고 랭킹에 반영하지 않는다. 검색 신호로 제작 AI를 채우지 않는다.
공개 저장소에서 발견한 지침 파일·설정·기여 표기는 관측 사실로 보여주며 실제 실행 증명과 구분한다.

## 메이커 스킬 명령

`curl -fsSL <SITE>/install.sh | sh`로 설치한 뒤 프로젝트 폴더에서 `/nomorevibe`를 실행한다.
등록·검증·삭제뿐 아니라 공개 상세 근거도 같은 credential-store 수정 키로 관리한다.

| 명령 | 하는 일 |
|---|---|
| `/nomorevibe` | 제품 등록 또는 기본 정보 갱신 |
| `/nomorevibe verify` | 배포 도메인 소유권 검증 |
| `/nomorevibe profile` | 상세 소개·가격·팀·라이선스 신고 갱신 |
| `/nomorevibe links` | 저장소·스토어·패키지·RSS·changelog 링크 갱신 |
| `/nomorevibe media` | 최대 8개 외부 이미지 선언, 서버가 검증 후 내부 보관 |
| `/nomorevibe provenance` | 동의한 에이전트·스킬 메타데이터만 선택적으로 공개 |
| `/nomorevibe update` | 메이커 업데이트 작성 |
| `/nomorevibe refresh` | 외부 근거 재수집을 대기열에 등록 |
| `/nomorevibe delete` | 확인 후 제품 삭제 |

모든 쓰기는 전송 payload와 `메이커 제공·미검증` 라벨을 먼저 보여주고 확인받는다. 수정 키는
`~/.config/nomorevibe/credentials.json`에만 저장하며 프로젝트 파일, 프롬프트, 대화 로그,
환경변수, 비밀값은 업로드하지 않는다. provenance는 명시적 opt-in이며 랭킹에 반영하지 않는다.

## 개발 환경

```bash
# DB (전용 컨테이너)
docker run -d --name nomorevibe-local-db \
  -e POSTGRES_USER=nomorevibe -e POSTGRES_PASSWORD=nomorevibe -e POSTGRES_DB=nomorevibe \
  -p 55434:5432 -v nomorevibe-local-pgdata:/var/lib/postgresql/data postgres:17

cp .env.example .env.local     # ALLOW_PRIVATE_URLS=1 주석 해제 (로컬 테스트용)
# openssl rand -hex 32 결과를 VISITOR_HASH_SECRET에 넣는다
npm install
npx drizzle-kit migrate
npm run dev
```

| 명령 | 용도 |
|---|---|
| `npm run dev` | 개발 서버 |
| `npm test` | 단위·회귀 테스트 (DB 불필요) |
| `npm run test:integration` | 통합 테스트 (테스트 DB 필요 — 아래 참조) |
| `npm run lint` | ESLint |
| `npm run build` | 프로덕션 빌드 (standalone) |
| `npm run worker -- --role=crawler --once` | 주입된 환경변수로 크롤러 요청을 한 회차 소비 |
| `npm run scheduler -- --once` | 주입된 환경변수로 주기가 도래한 DB 요청을 한 회차 접수 |
| `npm run crawl:sample` | 판정 시험용 표본 수집 (GitHub 토큰 필요 — 아래 참조) |
| `npm run crawl:rejudge` | 떠 놓은 표본으로 현재 판정 규칙 재판정 |
| `npx drizzle-kit generate` / `migrate` | 마이그레이션 생성 / 적용 |

통합 테스트는 **개발 DB가 아닌 전용 DB**를 쓴다. 테이블을 비우므로 개발 DB를 가리키면
작업 중인 데이터가 날아간다.

```bash
docker run -d --name nomorevibe-test-db \
  -e POSTGRES_USER=nomorevibe -e POSTGRES_PASSWORD=nomorevibe -e POSTGRES_DB=nomorevibe_test \
  -p 55435:5432 postgres:17
npm run test:integration
```

## 구조

```
app/api/*/route.ts          파싱 → 유스케이스 호출 → 응답 매핑
lib/http/respond.ts         도메인 에러 → HTTP 상태코드 매핑
lib/domain/<모듈>/          유스케이스 · zod 스키마 · repository (HTTP 무관)
lib/net/                    normalize(순수) / ssrf(정책) / fetch(I/O)
skill/SKILL.md              /nomorevibe 스킬 단일 소스 — /skill.md 로 서빙
```

도메인은 HTTP를 모른다 — `lib/domain`·`lib/crawl`·`lib/net`·`lib/jobs`에서 `next/*`를
import 하지 않는다. 그래서 새 진입점(크롤러 등)은 라우트를 거치지 않고 유스케이스를 직접
호출할 수 있고, 단위 테스트가 서버 없이 돈다.

DB 접근은 **모듈마다 그 모듈의 파일 안에서** 한다. `products`·`evidence`·`ranking`·`media`가
각자 자기 테이블을 읽고 쓰며, 다른 모듈의 테이블을 직접 건드리지 않는다. 모듈 하나에 통과만
하는 위임 함수를 쌓지 않으려고 단일 repository 파일을 강제하지 않는다.

모듈 사이에 공유되는 것은 아래 둘뿐이고, 어느 쪽도 상대 모듈을 import 하지 않는다.

| 모듈 | 하는 일 | 쓰는 곳 |
|---|---|---|
| `products/generation.ts` | 제품 세대 잠금 (`lockProductGeneration`) | evidence · media · health |
| `evidence/settings-store.ts` | 근거 설정 한 행 읽기 | 상세 페이지 · 어드민 · 갱신 잡 |

**둘을 분리한 이유는 순환을 끊기 위해서다.** 잠금이 `products/repository.ts`에 있을 때는
evidence가 잠금 하나를 쓰려고 products repository 전체를 import 했고, 설정 읽기가
`evidence/refresh.ts`에 있을 때는 상세 페이지가 세 줄을 읽으려고 수집 provider와 `net/fetch`
까지 끌고 들어왔다(파일 36개 → 22개로 줄었다).

새 근거 출처 종류를 추가할 때는 `evidence/refresh.ts`의 `EVIDENCE_KINDS` 한 곳에 행을
더한다. `Record<LinkKind, _>`이므로 빠뜨리면 타입 검사가 막는다.

## 로컬 배포

개발 서버와 별개로, 실제 배포되는 형태를 그대로 띄운다. 목적은 **개발 서버에서 검증할 수 없는
경로를 확인하는 것**이다 — 프로덕션 모드의 SSRF 가드, 별도 마이그레이션 작업,
웹과 독립된 워커·스케줄러, 방문자 해시·고유 집계처럼 비밀키가 있어야 도는 경로.

실행 순서는 [독립 워커 운영 절차](docs/operations/independent-workers-runbook.md)를 따른다.
이미지 빌드 → 기존 소비자 stop/drain → migration 성공 확인 → 웹·역할별 워커 시작 순서다.
웹과 워커의 entrypoint는 마이그레이션을 실행하지 않는다.

```bash
cp .env.example .env          # AUTH_SECRET, VISITOR_HASH_SECRET 등을 채운다 (openssl rand -hex 32)
# 위 운영 절차의 최초 실행/릴리스 명령을 순서대로 수행한다.
docker compose logs -f app
docker compose down           # 데이터는 볼륨에 남는다
```

`.env`와 `.env.local`을 분리한 이유가 있다. `.env.local`에는 `ALLOW_PRIVATE_URLS=1`이 있어
SSRF 가드가 꺼지는데, 배포 형태 검증이 목적인 쪽에 그것을 넣으면 확인할 것이 없어진다.
DB 포트도 개발용(55434)과 분리해(55437) 어느 쪽에 붙었는지 헷갈리지 않게 한다.

## 백그라운드 작업

큐 서버를 두지 않는다. 작업당 행 하나에 커서를 남기고, 매 틱이 그 지점부터 이어받는다.

**한 틱은 유한하다.** 독립 워커가 DB에 접수된 요청을 소비하고, 시간 예산 안에서 처리한
진행점을 저장한다. GitHub 제한이나 실패가 있으면 대기 시각을 남기고 다음 요청에서 재개한다.
웹·어드민은 요청 접수와 상태 조회를 담당하며 HTTP 안에서 수집기를 실행하지 않는다.

```bash
npm run job heartbeat                    # .env.local을 읽는 로컬 한 틱 명령

# 호환 운영 API: 202 접수 응답이며 완료 응답이 아니다. crawler가 별도로 실행 중이어야 한다.
curl -X POST "$SITE/api/cron/crawl-fetch" \
  -H "Authorization: Bearer $CRON_SECRET"

# 컨테이너는 주입된 환경변수를 사용한다(.env.local 파일 불필요).
docker compose exec crawler node --import tsx scripts/run-job.ts crawl-fetch
```

새 작업은 `lib/jobs/catalog.ts`에 이름·역할·주기를, `lib/jobs/registry.ts`에 핸들러를 추가한다.
요청 버전과 실행 소유권으로 중복 실행과 실행 중 재요청 유실을 막는다. 초기 배포는 역할당 워커 1개다.

## 수집 파이프라인

검색엔진 크롤러의 뼈대를 따른다 — 프론티어(큐) → 원본 보관 → 판정 → 색인. 단계마다 작업이
하나씩이고, 각자 자기 큐가 빌 때까지 시간 예산 안에서 조금씩 나아간다.

| 작업 | 하는 일 | 다음 단계에 넘기는 것 |
|---|---|---|
| `crawl-seed` | GitHub 검색으로 레포를 발견 | `crawl_frontier`의 pending |
| `crawl-fetch` | 레포 메타 + 배포 페이지 확보 | `crawl_documents` (원본) |
| `crawl-judge` | 현재 기준으로 판정 | `crawl_candidates` (approved / rejected / needs_review) |
| `crawl-agent-review` | 규칙 재확인 후 제한된 AI 심사 | `crawl_review_attempts`, enforce에서 유효한 후보 판정 |
| `crawl-publish` | 통과한 후보를 목록에 올림 | `products` (status=seeded, source=crawler) |
| `uptime-ping` | 등재된 제품이 아직 떠 있는지 확인 | `product_health` (기록만 — 목록은 안 건드린다) |
| `click-rollup` | 클릭 원천을 하루 단위로 굴리고 오래된 원천 정리 | `product_click_daily` |
| `ranking-refresh` | 시즌 경계·쿨다운을 계산하고 공개 순위 스냅샷 갱신 | `ranking_seasons`, `ranking_entries` |
| `product-evidence-refresh` | 공식 링크·저장소·업데이트·내부 보관 미디어 갱신 | `product_evidence_*`, `product_updates`, `product_media` |
| `agent-evidence-refresh` | 공개 저장소의 지침·설정·기여 근거 갱신 | `agent_repository_scans`, `agent_repository_observations` |

```bash
GITHUB_TOKEN=... npm run job crawl-seed      # 로컬에서 한 틱씩
GITHUB_TOKEN=... npm run job crawl-fetch
npm run job crawl-judge
npm run job crawl-agent-review              # 기본 off에서는 심사하지 않음
npm run job crawl-publish
```

`/admin/review`에서 대기 사유·심사 근거·시도 이력을 보고 사유와 함께 관리자 판정이나 제한 재수집을
요청한다. AI 리뷰는 기본 `off`, 이력만 남기는 `observe`, 현재 입력의 유효 승인을 발행에 요구하는
`enforce`로 나뉜다. 모드 전환과 인증 준비는 운영 절차를 따른다. 개발 근거 부족은 보류이며 자동
부적격 판정의 근거로 쓰지 않는다. 발행된 제품은 주인 없는 `seeded` 상태이며 랭킹에는 들어가지 않는다.

밖으로 나가는 문은 둘이고 담는 것이 다르다. `/sitemap.xml`은 검증된 제품만 싣는다 — 상세
페이지가 나머지를 noindex로 두므로 실어봐야 크롤러가 헛걸음한다. `/feed.xml`은 홈의 발견
보드처럼 검증·시드 제품을 등재 시각순으로 함께 싣되, 리더에는 배지가 없으므로 어느 쪽인지를
제목에 글자로 적는다.

### 스케줄

Compose `scheduler`가 10초마다 `lib/jobs/catalog.ts`의 주기를 확인해 DB에 요청을 남긴다.
각 역할 워커는 기본 5초 간격으로 요청을 순차 소비한다. `scripts/scheduler.sh`는 이 DB 스케줄러의
호환 진입점이다. 웹이 중지돼도 운영되며, 아래 주기는 요청 주기여서 처리 완료 시각을 보장하지 않는다.

| 작업 | 주기 | 근거 |
|---|---|---|
| `crawl-fetch` | 1분 | 실제 API quota·쿨다운과 frontier due 시각을 준수 |
| `crawl-judge` | 5분 | 계산만 한다. 원본 쌓이는 속도만 따라가면 된다 |
| `crawl-agent-review` | 1분 | 모드·입력 유효성·시도 한도에 따라 한 틱 AI 호출 최대 1개 |
| `crawl-publish` | 5분 | 판정 직후에 돌아야 통과한 것이 바로 목록에 오른다 |
| `crawl-seed` | 15분 | 공유 API 대기와 frontier 적체 시 탐색 양보 |
| `uptime-ping` | 10분 | 제품이 죽는 것은 분 단위로 급한 일이 아니다. 같은 제품은 6시간에 한 번만 본다 |
| `click-rollup` | 1시간 | 집계는 하루 단위라 자주 돌 이유가 없다 |
| `ranking-refresh` | 독립 주기 없음 | `click-rollup`의 done=true 성공 완료 트랜잭션이 요청 |
| `product-evidence-refresh` | 1분 | 출처별 due 시각으로 실제 요청을 제한한다 |
| `agent-evidence-refresh` | 1분 | 공개 저장소 문서·설정 수집, partial 재개, 완료 후 기본 24시간 캐시 |

기존 Dokploy/GitHub Actions의 HTTP 스케줄과 evidence wrapper는 전환 때 중지한다.
호환 cron API는 요청만 접수하므로 소비 워커를 대신하지 않는다. `ranking-refresh`를 별도 정기
스케줄로 등록하면 집계 완료 순서를 우회하므로 등록하지 않는다.

발행할 때 제품 카테고리는 **`claude` CLI**(`claude -p`, `claude-sonnet-5`, `effort: high`, 구조화
출력)가 고른다. API 키가 아니라 로그인 세션으로 돈다 — 개발 머신은 `claude` 로그인(keychain),
서버는 `CLAUDE_CODE_OAUTH_TOKEN`(`claude setup-token`으로 발급)이다. worker 이미지에는 CLI
`2.1.263`이 고정돼 있다. `--safe-mode`로 사용자 설정을 격리하면서 OAuth 인증을 보존하고,
도구를 끈 채 프로젝트 밖 임시 경로에서 한 턴만 실행한다. 이 버전의 `--bare`는 OAuth도 건너뛴다.
실행 파일 경로는 `CLAUDE_CLI`로 바꿀 수 있다(기본 `claude`).
카테고리 CLI가 없거나 로그인이 풀렸거나 15초를 넘기면 토픽·설명 키워드 규칙으로 분류한다.
AI 리뷰는 별도 `CRAWL_REVIEW_MODEL`을 명시해야 하며 기본 모델은 없다. 리뷰 실패는 보류·재시도로
남고, `enforce`에서 유효 승인 없이 카테고리 폴백만으로 발행할 수 없다.

수집기는 `GITHUB_TOKEN`이 있어야 돈다. 없으면 시간당 60회라 성립하지 않으므로 작업이 실패로
남는다(`jobs.last_error`).

검색 신호는 두 종류다. **커밋 검색**(`Co-authored-by: Claude` 같은 트레일러)은 결과에 레포
메타가 없어 배포 여부를 모른 채 프론티어에 넣고, 그중 상당수가 `no_homepage`로 거부된다(실측
206건 중 122건). **레포 검색**(`topic:vibe-coding` 같은 수식어)은 결과에 `homepage`가 실려 와
배포 URL이 없는 레포를 애초에 넣지 않는다 — `homepage`는 자유 입력이라 `soon`·`TBD` 같은
값이 오므로 URL로 풀리는 것만 넣는다.

신호는 `/admin` 검색 신호 목록 **끝의 빈 행**에 이름·종류·검색어를 적어 저장하면 늘어나고,
이름이나 검색어를 지우면 빠진다. 저장된 목록이 코드 기본값을 통째로 덮으므로 기본 신호를
새로 넣어도 이미 저장된 환경에는 닿지 않는다 — `/admin`이 그 차이를 "검색 신호"로 짚는다.
검색 신호의 이름이나 `builder` 설정은 제작 AI의 증명이 아니다. 현재 seed는 이 값으로
`crawl_frontier.builder`를 채우지 않으며, 제품의 제작 AI로 복사하지 않는다. 공개 표시는 별도
수집한 근거와 메이커 신고를 사용한다.

## 제품 근거 수집 운영

공개 에이전트 근거는 `agentEvidence.enabled` → `displayObservedFacts` → `enforceEligibility`
순으로 적용한다. 파일·설정·커밋 표기는 실제 실행 증명이 아니다. 도구/선언 모델/연결 경로를
분리하며 제품과 저장소 관계가 불명확하면 자동 발행을 보류한다. 기존 제품은 삭제하지 않는다.
기본 루트와 알려진 에이전트 디렉터리가 수집 범위이며, 임의의 monorepo 하위 프로젝트 전체를
검사했다고 주장하지 않는다. 운영 전환 시 이번 릴리스의 가산 마이그레이션까지 적용하고 프로세스를 재시작한다.

```sh
# 읽기 전용 점검 (기본 10개)
npx tsx --env-file=.env.local scripts/backfill-agent-evidence.ts --limit 1000
# 기존 제작자 삭제/숨김 의도를 보존하면서 저장소 연결만 복구
npx tsx --env-file=.env.local scripts/backfill-agent-evidence.ts --apply --links-only --limit 1000
# 특정 제품의 일반 근거와 에이전트 근거를 즉시 갱신
npx tsx --env-file=.env.local scripts/backfill-agent-evidence.ts --apply --slug tradinggoose-visual-workflow-platform-for-llm-trading
# 이전 로컬 사용을 위한 evidence 전용 wrapper (crawler와 함께 상시 실행하지 않음)
npx tsx --env-file=.env.local scripts/evidence-worker.ts
```

백필 JSON의 `issues`, `problem`, `selectedCount`를 함께 확인한다. 외부 수집 오류가 있으면
종료 코드 1이며, 관계/실행 여부 미확인은 오류를 숨기기 위해 확정으로 바꾸지 않는다.
이 wrapper는 새 후보를 발행하지 않는다. 서버 상시 운영은 역할별 Compose 워커와 독립 scheduler,
supervisor·재시작 정책을 사용한다. 로컬 직접 실행은 Mac 종료 뒤 자동 복구되는 서비스가 아니다.


제품 상세의 정보는 두 권한 경계를 섞지 않는다. 소개·가격·팀·라이선스 신고와 공식 링크는
`메이커 제공`이고, GitHub·스토어·패키지 레지스트리·RSS·changelog를 직접 읽어 얻은 값은
`자동 감지`다. 자동 수집 실패가 메이커 값을 덮지 않으며, 마지막 정상 관측값은 출처 상태가
`failed`나 `stale`이 되어도 보존한다. GitHub 저장소와 실제 서비스가 서로 링크하는지는 별도
관계 상태로 기록하고, 한쪽 링크만으로 상호 연결을 주장하지 않는다.

제품의 외부 근거 수집 중 인증이 필요한 제공자는 GitHub다. 프로덕션 비밀 저장소에 public repository를 읽을 수
있는 `GITHUB_TOKEN`을 넣는다. 토큰이 없거나 유효하지 않으면 GitHub 근거 갱신은 실패로 남지만,
App Store·Play Store·npm·PyPI·crates.io·일반 링크·RSS 수집은 각 공개 URL을 독립적으로 확인한다.
토큰과 제공자 응답 본문은 로그나 감사 메타데이터에 저장하지 않는다.
외부 수집은 DNS 조회와 실제 연결 시점 모두 공인 IP만 허용하며, GitHub JSON 응답도 선언 크기와
실제 스트림을 각각 2 MiB로 제한한다.

DB 스케줄러는 두 evidence 잡을 매분 요청하며 crawler가 소비한다. due 시각 이전에는 외부 요청을 생략한다.
운영 서버·도메인은 아직 확정되지 않았고 생산 배포는 수행하지 않았다. 전환 절차와 남은 환경 설정은
`PENDING.md`를 따른다. 저장소·일반 링크의 기본 갱신 간격은 24시간,
release feed는 6시간이며, 성공한 출처만 다음 시각으로 전진한다. 일반 출처 실패 재시도는 6시간에서 시작해 12·24·48시간으로 늘고 기본 최대 재시도 설정에서는 48시간이 상한이다
(설정을 늘려도 절대 상한은 7일). 마지막 성공 이후 `출처 간격 × staleAfterIntervals`가 지나면
`stale`로 표시한다. GitHub rate-limit이 준 재시도 시각은 자체 백오프로 덮지 않는다. 설정은
`evidence_settings` 한 행에 저장되며 코드 기본값은 `lib/domain/evidence/settings.ts`에 있다.

운영에서는 `/admin/products/<slug>`의 강제 갱신으로 요청 버전을 접수하고 완료 상태를 확인한다.
최근 관측 미디어도 다시 확인하며, 재요청·부분 진행과 GitHub 대기를 보존한다. 아래는 독립 워커를
대신하는 상시 실행 명령이 아닌 로컬 수동 진단용이다. 직접 확인한 slug와 전용 환경을 사용한다.

```bash
npx tsx --env-file=.env.local -e \
  'import { refreshProductEvidence } from "./lib/domain/evidence/refresh.ts"; refreshProductEvidence("simplehwp", { force: true }).then((result) => { console.log(result); process.exit(0) }).catch((error) => { console.error(error); process.exit(1) })'
```

외부 갤러리 이미지는 URL만 저장하지 않는다. JPEG·PNG·WebP만 받고 원본 응답은 최대 5 MiB,
한 변은 최대 10,000 px, 전체는 최대 4천만 픽셀로 제한한다. 메타데이터를 제거한 WebP 웹용
(최대 1600×1200)과 썸네일(최대 480×360)을 만들고, 두 결과의 SHA-256으로 중복 제거해
PostgreSQL `bytea`에 보관한다. 제품당 공개 이미지는 최대 8개다. 원본 URL이 사라져도 마지막
정상 바이트를 유지하며, 공유 자산은 마지막 제품 참조가 삭제될 때만 제거한다.

이 설계는 별도 오브젝트 스토리지 없이 시작하는 대신 PostgreSQL 데이터와 백업 크기가 미디어에
비례한다. 운영 전 DB 볼륨·WAL·스냅샷 여유를 함께 산정하고, 논리/물리 백업에 `media_assets`의
두 `bytea` 열이 실제 포함되는지 복구 연습으로 확인한다. DB 백업에서 미디어를 제외하면 상세
갤러리는 복구되지 않는다.

**단계를 나눈 이유는 되돌릴 수 있게 하기 위함이다.** 원본을 보관하므로 판정 기준을 바꾸면
GitHub을 다시 긁지 않고 다시 판정한다(후보 state를 `new`로 되돌리면 `crawl-judge`가 다시
가져간다). 검색은 분당 30회, 레포 조회는 시간당 5000회로 묶여 있어 한 번에 끝낼 수 없는데,
단계가 붙어 있으면 한도에 걸릴 때마다 처음부터 다시 해야 한다.

seed·fetch·judge·AI 리뷰·publish는 크롤 설정의 `enabled`가 꺼져 있으면 수집·판정을 수행하지 않는다.
일반 제품 근거·가동 상태·집계 잡은 각각의 설정과 due 조건을 따른다.

**기준은 데이터라 한 번 저장하면 코드 기본값을 덮는다.** 판정 규칙을 고쳐 기본값을 바꿔도 이미
돌고 있는 환경은 옛 값으로 돈다. `/admin`이 어긋난 항목을 짚어 보여주고, 되돌리는 버튼을 둔다
(수집 스위치는 건드리지 않는다). 없는 필드는 기본값으로 채우므로 필터를 새로 추가할 때는
마이그레이션이 필요 없다.

## 판정 기준 시험

판정 규칙은 표본 40개를 눈대중으로 보고 정한 기본값에서 출발했다. 실제로 돌려 보기 전에는
무엇이 새고 무엇이 과하게 걸리는지 알 수 없으므로, GitHub을 다시 긁지 않고 기준만 바꿔 다시
재는 판을 둔다. DB의 crawl_documents가 하는 일과 같고, 이쪽은 DB 없이 파일로 한다.

```bash
npm run crawl:sample -- --pages=6                  # 원본을 뜬다 (레포 메타 + 배포 URL 응답 코드)
npm run crawl:rejudge -- --out=.crawl-samples/before.json
# lib/crawl/rules.ts 또는 기본 설정을 고친 뒤
npm run crawl:rejudge -- --out=.crawl-samples/after.json
```

**표본을 파일로 고정하는 것이 요점이다.** 다시 뜨면 기준을 바꾼 효과와 표본이 바뀐 효과가
섞여 비교가 안 된다. 통과 수가 몇 개 줄었는지보다 **무엇이 빠지고 무엇이 새로 들어왔는지**를
봐야 한다 — 실제로 이 방식으로 GitHub Pages 프로젝트 페이지가 통째로 거부되던 것과,
이름이 `blog`인 개인 블로그가 `*-blog`를 통과하던 것을 잡았다.

토큰은 `GITHUB_TOKEN` 환경변수만 쓴다. 로컬 `gh auth` 상태를 자동으로 읽지 않는다.

## 클릭과 랭킹

목록에서 제품으로 나가는 링크는 `/go/<slug>`를 거친다. JS 없이 동작하고, 세는 쪽이 서버라
클라이언트가 조작할 수 없다. 봇·링크 미리보기를 제외하고, 같은 브라우저의 같은 제품 방문은
10분 창에서 한 번만 인정한다. 이 조건을 통과한 외부 이동을 공개 화면에서는 `유효 방문`이라
부른다.

**방문자는 1st-party 쿠키(`nmv_visitor`)로 구분한다.** IP로 묶으면 `TRUSTED_PROXY_HOPS`가
기본값(0)일 때 모든 요청이 `direct` 하나로 접혀 전 세계 방문자가 한 버킷에 들어간다 —
제품당 10분에 한 번만 세진다. 신원이 아니라 "같은 브라우저인가"만 본다. 원본 쿠키, IP,
User-Agent는 방문 이벤트에 저장하지 않는다. 서버는 제품별
`HMAC-SHA256(VISITOR_HASH_SECRET, slug + "\0" + nmv_visitor)`만 만들어 중복 제거와 고유 집계에
쓴다. `VISITOR_HASH_SECRET`은 최소 32자여야 하며 `openssl rand -hex 32`로 별도 생성한다.
`ADMIN_SESSION_SECRET`, `CRON_SECRET`, 수정 토큰 키와 재사용하지 않는다. 값이 없거나 짧으면
외부 이동은 계속되지만 방문 이벤트는 기록하지 않는다.

봇은 세지 않는다. `robots.txt`가 `/go/`를 막고, 그것을 지키지 않는 크롤러와 링크 미리보기는
User-Agent로 거른다. 어느 쪽이든 **이동 자체는 막지 않는다.**

공개 지표의 뜻은 다음과 같다.

| 지표 | 의미 |
|---|---|
| `유효 방문` | 봇과 제품별 10분 중복을 제외하고 NoMoreVibe가 받아들인 외부 이동 수 |
| `고유 유입자` | 해당 기간에 NoMoreVibe를 거친 서로 다른 제품별 1st-party 브라우저 식별자 수. 실제 사람 수나 제품 전체 방문자 수가 아니다 |
| `반복 방문 가중` | 고유 유입자마다 추가 유효 방문 최대 1회를 25%만 반영한 값. GitHub·메이커 신고 정보는 점수에 넣지 않는다 |

고유 집계가 시작된 뒤 7일이 지나기 전에는 고유 유입자를 `집계 중`으로 표시한다. 7일이 지나도
관리자가 예약한 정책은 현재 시즌을 바꾸지 않고 다음 시즌 경계부터만 적용된다. 고유 우선 점수는
`고유 유입자 100% + 고유 유입자당 추가 유효 방문 최대 1회 × 25%`에 기존 소프트 쿨다운을
적용한다.

원천(`click_events`)은 35일 동안만 보관하고 `click-rollup`이 KST 하루 단위 유효 방문과 일별
고유 수를 남긴 뒤 정리한다. **서로 다른 날의 일별 고유 수를 더해 여러 날의 고유 유입자라고
부르면 안 된다.** 같은 브라우저가 날짜마다 중복되기 때문이다. 여러 날에 걸친 정확한 고유 수는
보존 중인 원천에서 `distinct`로 계산하며, 종료된 시즌 값은 원천 삭제 전 랭킹 항목에 확정한다.

`VISITOR_HASH_SECRET`을 교체하면 같은 쿠키도 새로운 식별자로 계산된다. 교체 전후가 같은 집계
기간에 걸치면 한 브라우저가 둘로 셀 수 있고 10분 중복 제거도 새로 시작되므로, 유출 대응 외의
일상적인 rotation은 피한다. 불가피한 교체 시에는 활성 시즌과 7일 준비 기간에 미치는 영향을
기록하고 다음 시즌 전환을 다시 판단한다. 원본 식별자가 없어 과거 값을 새 키로 재계산할 수 없다.

경쟁 랭킹은 **검증된 제품만** 참가하는 시즌제다. 기본값은 매주 월요일 00:00 KST에 시작하는
주간 시즌이고, 관리자가 월간 시즌으로 바꿀 수 있다. 새로 수집했지만 주인이 검증하지 않은
제품은 경쟁 순위에 섞지 않고 `새로 발견됨` 보드에만 보여준다.

기존 `valid-visits-v1` 시즌 점수는 `유효 방문 × 순위 반영률`이다. 직전 시즌 상위 제품에는
관리자가 정한 소프트 쿨다운을 적용하고, 시즌이 지날수록 100%까지 회복시켜 같은 제품이 계속
상단을 독점하지 않게 한다. 변동률은 정책에 지정된 인접 구간을 비교하며, 이전 구간이 설정된
최소값보다 작으면 과장된 퍼센트 대신 `신규`로 표시한다.

활성 시즌의 기간과 정책은 도중에 바뀌지 않는다. `/admin/ranking`에서 저장한 설정은 다음 시즌
정책으로 한 건만 예약되며, 주간·월간 주기를 바꾸면 다음 자연 경계까지 전환 시즌을 한 번 거친다.
`click-rollup` 뒤에 `ranking-refresh`를 실행해야 시즌 경계, 쿨다운, 공개 순위 스냅샷이 최신
집계를 반영한다. 현재·지난 시즌의 기간과 당시 잠긴 규칙은 `/rankings/<시즌 키>`에서 확인한다.
정책 스냅샷이 없는 과거 시즌과 기존 시즌은 계속 `유효 방문` 기준으로 읽는다. 전체 기간 보드는
일별 유효 방문 합계를 사용하는 역사 지표이므로 `누적 유효 방문`이라고 표시하며, 고유 유입자로
재표기하지 않는다.

## 도메인 검증

등록은 누구나 할 수 있지만(마찰 0), **검증 전에는 공개 목록에 뜨지 않는다**.
`/.well-known/nomorevibe.txt` 또는 `<meta name="nomorevibe-verify">` 중 하나를 우리 서버가 직접 확인한다.
둘 다 해당 도메인에 배포할 수 있는 사람만 만들 수 있으므로 소유 증명이 된다.

## 내려달라는 요청

우리가 대신 올린 제품(`seeded`)은 주인이 부탁한 적이 없다. `POST /api/products/<slug>/takedown`으로
누구나 요청할 수 있고, 소유 증명을 요구하지 않는다 — 내려달라는 사람에게 우리 토큰을 먼저
사이트에 붙이라고 할 수는 없기 때문이다. 대신 어드민이 `/admin/review`에서 보고 처리한다.

내릴 때는 행을 지우지 않고 `banned`로 둔다. 지우면 수집기가 다음 바퀴에 같은 URL을 다시
주워 온다. 주인이 있는 제품은 이 창구를 쓰지 않는다 — 수정 키로 직접 삭제하면 된다.

## 클레임 초대

우리가 대신 올린 제품의 주인은 자기 제품이 올라와 있다는 것을 모른다 — 상세 페이지를 볼 일이
없다. 레포는 안다. `/admin/products`의 미클레임 제품에 **미리 채운 GitHub 새 이슈 링크**가
붙어 있고, 운영자가 그 링크를 열어 자기 계정으로 직접 제출한다. 서버가 남의 레포에 글을 쓸
자격을 쥐지 않고, 마지막 버튼은 사람이 누른다. 제출한 뒤 "보냈음으로 표시"를 눌러
`claim_invited_at`에 시각을 남기면 두 번 보내지 않는다. 이슈 본문은 클레임(`/nomorevibe`)과
내리기(상세 페이지의 요청 폼) 두 길을 함께 안내하고, 다시 보내지 않겠다고 적는다.

## 멈춰 있는 작업

코드로 끝낼 수 없어 대기 중인 것은 `PENDING.md`에 적는다 — 무엇이 막고 있고, 풀렸을 때
무엇을 해야 하는지가 실행 가능한 형태로 들어 있다.

## 운영 제약

- rate limit은 DB(`rate_limits`)에 둔다. 인스턴스를 늘려도 한도가 하나로 유지된다.
  한도를 거는 세 경로(등록·검증·수정)는 어차피 그 요청 안에서 DB를 타므로 왕복이 늘지 않는다.
- `NEXT_PUBLIC_SITE_URL`을 반드시 설정한다. 미설정 시 메이커에게 내부 origin 주소가 전달된다.
- `ALLOW_PRIVATE_URLS`는 SSRF 가드를 끄므로 프로덕션에서 절대 설정하지 않는다.
