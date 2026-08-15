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

## 도메인 검증

등록은 누구나 할 수 있지만(마찰 0), **검증 전에는 공개 목록에 뜨지 않는다**.
`/.well-known/nomorevibe.txt` 또는 `<meta name="nomorevibe-verify">` 중 하나를 우리 서버가 직접 확인한다.
둘 다 해당 도메인에 배포할 수 있는 사람만 만들 수 있으므로 소유 증명이 된다.

## 운영 제약

- **rate limit이 인메모리다** — 인스턴스 2대 이상으로 늘리면 한도가 인스턴스별로 나뉜다.
  스케일아웃 전에 공유 저장소(Redis 등)로 옮겨야 한다.
- `NEXT_PUBLIC_SITE_URL`을 반드시 설정한다. 미설정 시 메이커에게 내부 origin 주소가 전달된다.
- `ALLOW_PRIVATE_URLS`는 SSRF 가드를 끄므로 프로덕션에서 절대 설정하지 않는다.
