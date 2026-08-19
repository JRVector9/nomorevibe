# NoMoreVibe

AI로 만든 제품의 마켓 데이터베이스. 메이커가 AI 코딩 툴에서 `/nomorevibe` 한 번을 실행하면
배포한 서비스가 등록된다.

**원칙: 우리가 직접 확인한 것만 보여준다.**
`✓` 표시는 도메인 소유권 검증에만 붙는다. "만든 AI"는 기술적으로 검증할 방법이 없으므로
**메이커 신고**로 표기하고 랭킹에 반영하지 않는다.

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
lib/domain/products/        유스케이스 · zod 스키마 · repository (HTTP 무관)
lib/net/                    normalize(순수) / ssrf(정책) / fetch(I/O)
skill/SKILL.md              /nomorevibe 스킬 단일 소스 — /skill.md 로 서빙
```

DB 접근은 `lib/domain/products/repository.ts` 한 곳으로만 한다.
새 진입점(크롤러 등)은 라우트를 거치지 않고 유스케이스를 직접 호출한다.

## 로컬 배포

개발 서버와 별개로, 실제 배포되는 형태를 그대로 띄운다. 목적은 **개발 서버에서 검증할 수 없는
경로를 확인하는 것**이다 — 프로덕션 모드에서만 켜지는 SSRF 가드, 컨테이너 시작 시 마이그레이션,
스케줄러 진입점.

```bash
cp .env.example .env          # AUTH_SECRET, VISITOR_HASH_SECRET 등을 채운다 (openssl rand -hex 32)
docker compose up -d --build  # http://localhost:3200
docker compose logs -f app
docker compose down           # 데이터는 볼륨에 남는다
```

`.env`와 `.env.local`을 분리한 이유가 있다. `.env.local`에는 `ALLOW_PRIVATE_URLS=1`이 있어
SSRF 가드가 꺼지는데, 배포 형태 검증이 목적인 쪽에 그것을 넣으면 확인할 것이 없어진다.
DB 포트도 개발용(55434)과 분리해(55437) 어느 쪽에 붙었는지 헷갈리지 않게 한다.

## 백그라운드 작업

큐 서버를 두지 않는다. 작업당 행 하나에 커서를 남기고, 매 틱이 그 지점부터 이어받는다.

**한 틱은 유한하다.** HTTP 요청 안에서 돌기 때문에 무한정 이어갈 수 없고, GitHub 수집기처럼
rate limit에 걸리는 작업은 애초에 한 번에 끝낼 수도 없다. 작업은 시간 예산 안에서 할 수 있는
만큼만 하고 커서를 저장한 뒤 물러난다.

```bash
npm run job heartbeat                    # 로컬에서 한 틱

curl -X POST $SITE/api/cron/heartbeat \  # 스케줄러가 주기적으로 호출
  -H "Authorization: Bearer $CRON_SECRET"
```

새 작업은 `lib/jobs/registry.ts`에 이름과 핸들러를 추가하면 두 진입점 모두에서 쓸 수 있다.
동시 실행은 잠금으로 막히므로 스케줄이 겹쳐 호출해도 안전하다.

## 수집 파이프라인

검색엔진 크롤러의 뼈대를 따른다 — 프론티어(큐) → 원본 보관 → 판정 → 색인. 단계마다 작업이
하나씩이고, 각자 자기 큐가 빌 때까지 시간 예산 안에서 조금씩 나아간다.

| 작업 | 하는 일 | 다음 단계에 넘기는 것 |
|---|---|---|
| `crawl-seed` | GitHub 검색으로 레포를 발견 | `crawl_frontier`의 pending |
| `crawl-fetch` | 레포 메타 + 배포 페이지 확보 | `crawl_documents` (원본) |
| `crawl-judge` | 현재 기준으로 판정 | `crawl_candidates` (approved / rejected / needs_review) |
| `crawl-publish` | 통과한 후보를 목록에 올림 | `products` (status=seeded, source=crawler) |
| `uptime-ping` | 등재된 제품이 아직 떠 있는지 확인 | `product_health` (기록만 — 목록은 안 건드린다) |
| `click-rollup` | 클릭 원천을 하루 단위로 굴리고 오래된 원천 정리 | `product_click_daily` |
| `ranking-refresh` | 시즌 경계·쿨다운을 계산하고 공개 순위 스냅샷 갱신 | `ranking_seasons`, `ranking_entries` |

```bash
GITHUB_TOKEN=... npm run job crawl-seed      # 로컬에서 한 틱씩
GITHUB_TOKEN=... npm run job crawl-fetch
npm run job crawl-judge
npm run job crawl-publish
```

규칙이 가르지 못한 것(`needs_review`)은 `/admin/review`에서 사람이 가른다. 발행된 제품은
주인이 없는 상태(`seeded`)로 목록에 뜨고, 랭킹에는 들어가지 않는다.

### 스케줄

`scripts/scheduler.sh`가 주기를 쥐고 cron 진입점을 두드린다. compose에 `scheduler` 서비스로
붙어 있고, 겹쳐 호출해도 러너의 잠금이 중복 실행을 막는다.

| 작업 | 주기 | 근거 |
|---|---|---|
| `crawl-fetch` | 1분 | 레포 조회 5000회/시간. 한 틱에 30건 남짓이라 여유가 있다 |
| `crawl-judge` | 5분 | 계산만 한다. 원본 쌓이는 속도만 따라가면 된다 |
| `crawl-publish` | 5분 | 판정 직후에 돌아야 통과한 것이 바로 목록에 오른다 |
| `crawl-seed` | 15분 | 검색 30회/분. 프론티어는 한 번 돌면 한참 차 있다 |
| `uptime-ping` | 10분 | 제품이 죽는 것은 분 단위로 급한 일이 아니다. 같은 제품은 6시간에 한 번만 본다 |
| `click-rollup` | 1시간 | 집계는 하루 단위라 자주 돌 이유가 없다 |
| `ranking-refresh` | 1시간 | 클릭 집계 직후 시즌 경계와 공개 순위 스냅샷을 갱신한다 |

크론 데몬을 쓰지 않는 이유는 작업 수가 적고 주기가 분 단위이며, 실패해도 다음 틱이
이어받기 때문이다. 다른 스케줄러(Dokploy, GitHub Actions)를 쓴다면 같은 주기로 아래를 호출하면 된다.

```bash
curl -X POST $SITE/api/cron/crawl-fetch -H "Authorization: Bearer $CRON_SECRET"
```

발행할 때 제품 카테고리는 Claude API(`claude-sonnet-5`, `effort: high`)가 고른다.
`ANTHROPIC_API_KEY`가 없거나 호출이 실패하면 토픽·설명 키워드 규칙으로 떨어지고 발행은 그대로 진행된다 — 카테고리 하나 때문에 목록에 못 오를 이유가 없다.

수집기는 `GITHUB_TOKEN`이 있어야 돈다. 없으면 시간당 60회라 성립하지 않으므로 작업이 실패로
남는다(`jobs.last_error`).

**단계를 나눈 이유는 되돌릴 수 있게 하기 위함이다.** 원본을 보관하므로 판정 기준을 바꾸면
GitHub을 다시 긁지 않고 다시 판정한다(후보 state를 `new`로 되돌리면 `crawl-judge`가 다시
가져간다). 검색은 분당 30회, 레포 조회는 시간당 5000회로 묶여 있어 한 번에 끝낼 수 없는데,
단계가 붙어 있으면 한도에 걸릴 때마다 처음부터 다시 해야 한다.

세 작업 모두 크롤 설정의 `enabled`가 꺼져 있으면 아무것도 하지 않는다.

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

토큰은 `GITHUB_TOKEN` 환경변수를 쓰고, 없으면 `gh auth token`을 부른다.

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

## 멈춰 있는 작업

코드로 끝낼 수 없어 대기 중인 것은 `PENDING.md`에 적는다 — 무엇이 막고 있고, 풀렸을 때
무엇을 해야 하는지가 실행 가능한 형태로 들어 있다.

## 운영 제약

- rate limit은 DB(`rate_limits`)에 둔다. 인스턴스를 늘려도 한도가 하나로 유지된다.
  한도를 거는 세 경로(등록·검증·수정)는 어차피 그 요청 안에서 DB를 타므로 왕복이 늘지 않는다.
- `NEXT_PUBLIC_SITE_URL`을 반드시 설정한다. 미설정 시 메이커에게 내부 origin 주소가 전달된다.
- `ALLOW_PRIVATE_URLS`는 SSRF 가드를 끄므로 프로덕션에서 절대 설정하지 않는다.
