---
name: nomorevibe
description: 배포한 서비스를 NoMoreVibe에 등록하고 소개·공식 링크·갤러리·제작 provenance·업데이트를 관리한다. /nomorevibe, verify, delete, profile, links, media, provenance, update, refresh로 실행한다. 사용자가 "노모어바이브", "nomorevibe에 올려줘", "서비스 등록해줘"라고 요청할 때 사용.
---

# NoMoreVibe 등록 스킬

배포된 서비스의 정보를 수집해 NoMoreVibe 레지스트리에 등록한다.
API 베이스: 환경변수 `NOMOREVIBE_API`가 있으면 그 값, 없으면 `{{SITE_URL}}`.

## 공통 규칙

- 로컬 상태 파일: 프로젝트 루트의 `.nomorevibe.json` — `{ "slug": "...", "url": "...", "api": "..." }`
- 수정 키 저장소: `~/.config/nomorevibe/credentials.json` —
  `{ "<api-origin>": { "<slug>": { "token": "<edit_token>" } } }`
  - **수정 키는 `.nomorevibe.json`에 저장하지 않는다. 수정 키는 프로젝트 파일에 저장하거나 기록하지 않는다.**
  - 수정 키, 인증 헤더, 제공자 자격 증명은 화면·로그·명령 결과에 출력하지 않는다.
  - 파일 생성 시 `chmod 600` 적용
- 모든 API 호출은 `curl -s`로 하고, 응답 JSON의 `error` 필드를 사용자에게 그대로 전달한다
- 변경 명령은 `.nomorevibe.json`의 `api`를 유효한 http(s) **origin**으로 정규화한 뒤, 수정 키를
  `credentials[origin][slug]`에서만 찾는다. 즉 수정 키는 **API origin과 slug의 조합**에 결박한다.
  인증 요청 목적지는 일치한 credential의 origin만 사용하며 프로젝트 파일에 적힌 임의 URL로 수정 키를
  보내지 않는다. 정확히 일치하는 항목이 없으면 쓰기를 시도하지 않는다.
  **두 origin의 같은 slug가 서로 덮어쓰지 않게** origin별 하위 객체를 유지한다.
- 문자열 형식의 기존 credential이나 과거 `{ token, api }` 형식은 목적지와 slug 결박이 불충분한
  legacy 값이다. 자동 전송하거나 프로젝트의 api로 보정하지 말고 **수정 키를 보내지 않는다**.
  사용자에게 설치된 스킬의 기본 API origin과 대상 slug를 보여주고 신뢰 여부를 명시적으로 확인받은 뒤
  새 `origin → slug → token` 형식으로 한 번만 마이그레이션한다.
- 정확한 `(origin, slug)` 수정 키가 없으면 먼저 등록 또는 클레임하라고 안내한다.

## 서브커맨드 판별

- 인자 없음 또는 URL → **등록/업데이트**
- `verify` → **검증**
- `delete` → **삭제**
- `profile` → **상세 소개 갱신**
- `links` → **공식 외부 링크 갱신**
- `media` → **갤러리 이미지 선언 갱신**
- `provenance` → **제작 에이전트·스킬 정보 갱신**
- `update` → **메이커 업데이트 작성**
- `refresh` → **외부 근거 수집 요청**

## 쓰기 전 공통 절차

`profile`, `links`, `media`, `provenance`, `update`는 아래 절차를 반드시 지킨다.

1. 프로젝트의 공개 메타데이터만 읽는다. README, package manifest, public 문서, git remote와
   현재 commit은 허용한다. `.env*`, credential 파일 전체, 스킬 지침 본문, 프롬프트, 대화 로그,
   환경변수 값, 비밀값은 수집하거나 제안 payload에 넣지 않는다.
2. `profile`, `links`, `media`, `provenance`는 같은 리소스 URL을 `X-Edit-Token`으로 먼저 조회해
    **현재 저장된 리소스를 GET**한다. GET이 실패하면 PUT하지 않는다. 이 네 PUT은 전체 교체이므로
    서버 응답을 기준값으로 삼아 새 제안을 병합하고, 사용자가 명시적으로 지워 달라고 하지 않은 기존
    필드와 항목은 그대로 보존한다. 응답의 `ETag`도 해당 제안과 함께 메모리에만 보관한다.
3. 보낼 **제안 payload**를 필드별로 보여주고 각 값의 근거를 `메이커 제공·미검증`으로 표시한다.
   현재값과 비교해 추가·변경·유지·**삭제될 항목**을 모두 구분한다. 삭제될 항목이 하나라도 있으면
   별도로 강조한다.
   수정 키와 인증 헤더는 미리보기에서 제외한다.
4. 사용자에게 "이대로 NoMoreVibe에 저장할까요?"라고 묻고 **명시적으로 확인**받는다. 확인 전에는
   API 쓰기, 로컬 상태 변경, 외부 이미지 업로드를 하지 않는다. 수정 요청이 있으면 payload를 다시
   보여주고 재확인한다.
5. 확인 후에만 `X-Edit-Token`과 GET에서 받은 `If-Match: <ETag>` 헤더로 호출한다. JSON은 임시
   파일이나 셸 history에 남기지 않고 안전한 프로세스 입력으로 전달한다. `412` 응답이면 다른 변경을
   덮어쓰지 말고 최신 리소스를 다시 GET해 변경 비교와 사용자 확인을 처음부터 반복한다. 성공 상태와
   공개 근거 라벨만 보고한다.

## 상세 근거 명령

### `profile` — 상세 소개

README와 공개 제품 문서를 바탕으로 해결하는 문제, 주요 사용자, 기능, 활용 예시, 가격 방식,
플랫폼, 개인정보 처리 방식, 상세 Markdown, 팀, 메이커 신고 라이선스를 제안한다. 추측값은 비워둔다.
쓰기 전 공통 절차로 확인받은 뒤 다음 형태를 `PUT /api/products/<slug>/profile`에 보낸다.

```json
{
  "problem": "...",
  "targetUsers": "...",
  "keyFeatures": ["..."],
  "useCases": ["..."],
  "pricingModel": "free|freemium|paid|open_source|contact|unknown",
  "lifecycle": "prototype|beta|ga|maintenance|sunset|unknown",
  "platforms": ["web"],
  "privacySummary": "...",
  "longDescriptionMarkdown": "...",
  "team": [{ "name": "...", "role": "..." }],
  "makerLicense": { "value": "MIT", "spdxId": "MIT", "url": "https://..." }
}
```

라이선스를 공개하지 않거나 근거가 없으면 `makerLicense` 전체를 생략한다. `spdxId`와 `url`도
확인된 값만 넣는다.

### `links` — 공식 외부 출처

실제 제품·문서·manifest가 공개적으로 가리키는 링크만 제안한다. 종류는 `repository`, `app_store`,
`play_store`, `npm`, `pypi`, `crates`, `documentation`, `support`, `rss`, `changelog`, `video` 중
하나다. 쓰기 전 공통 절차로 확인받고 `{ "links": [{ "kind": "repository", "url": "..." }] }`를
`PUT /api/products/<slug>/links`에 보낸다. 링크가 제품과 실제로 연결됐는지는 서버가 별도로 확인한다.
`repository` 종류는 현재 **GitHub(`github.com`) 저장소만** 지원한다. GitLab, Bitbucket 등 다른
호스트의 원격은 repository 항목으로 제안하지 않는다. 지원되지 않는다고 사용자에게 알리고 기존
서버 항목은 그대로 보존한다.

### `media` — 내부 보관 갤러리 선언

메이커가 통제하는 공개 **외부 이미지 URL**과 설명적인 `altText`만 최대 8개 제안한다. 로컬 파일,
data URL, base64 바이트, 영상 바이트는 보내지 않는다. 쓰기 전 공통 절차로 확인받고
`{ "items": [{ "url": "https://...", "altText": "..." }] }`를 `PUT /api/products/<slug>/media`에
보낸다. 응답은 선언 접수일 뿐이며 서버 작업이 나중에 내부 저장소로 복사하고 검증한 뒤 공개한다.

### `provenance` — 어떤 에이전트·스킬로 만들었나

기본적으로 수집하지 않는다. 사용자의 **명시적 동의(옵트인)**가 있을 때만 공개할 항목을 하나씩
고른다. 에이전트는 `provider`, 실행 `client`, `model`, `roles`, 선택한 commit 범위를, 스킬은
`namespace`, `name`, `version`, 공개 `source`, 선택한 바이트 `hash`, 현재 `commit`을 기록할 수 있다.
모든 항목의 `evidenceLevel`은 `maker_reported`다. 저장소 근거나 서명 증명으로 격상하지 않는다.
commit 값은 `git rev-parse`가 반환한 축약되지 않은 소문자 Git object ID(40자 SHA-1 또는 64자
SHA-256)만 사용한다. 스킬 파일 바이트의 `hash`는 소문자 64자 SHA-256만 허용한다.

스킬 지침 본문, 프롬프트, 대화 로그, 환경변수 값, 비밀값, 파일 내용은 절대 업로드하지 않는다.
쓰기 전 공통 절차로 정확한 메타데이터만 확인받고 `{ "agents": [...], "skills": [...] }`를
`PUT /api/products/<slug>/provenance`에 보낸다.

### `update` — 메이커 업데이트

사용자가 공개하려는 변경만 제목, 요약, 공식 원문 URL, 공개 시각으로 제안한다. git diff나 커밋
메시지를 통째로 보내지 않는다. 쓰기 전 공통 절차로 확인받고 다음 payload를
`POST /api/products/<slug>/updates`에 보낸다.

```json
{ "title": "...", "summary": "...", "canonicalUrl": "https://...", "publishedAt": "2026-08-20T00:00:00Z" }
```

### `refresh` — 외부 근거 재수집 요청

`POST /api/products/<slug>/refresh`를 `X-Edit-Token`으로 호출한다. 제공자 자격 증명을 읽거나
전송하지 않는다. 202 응답이면 **수집 요청이 대기열에 등록**됐다고만 보고하고, GitHub·스토어·피드
갱신이 완료됐다고 말하지 않는다. 실제 수집 결과는 이후 상세 화면의 갱신 상태에서 확인한다.

## 1. 등록/업데이트

1. **URL 확보**: 인자로 URL이 없으면 사용자에게 "배포한 서비스 주소를 알려주세요"라고 묻는다.
   `.nomorevibe.json`이 이미 있으면 그 URL을 기본값으로 제안한다.
2. **접속 확인**: `curl -sIL <url>` 로 확인한다. `-L`을 붙이는 이유는 배포 주소가 다른 도메인으로
   넘기는 일이 흔하기 때문이다(예: `*.vercel.app` → 자체 도메인). 3xx는 실패가 아니다.
   최종 응답이 2xx면 진행하고, 연결 자체가 안 되면 배포 상태를 확인하라고 안내하고 중단한다.
   **최종 도착지가 입력과 다르면 사용자에게 알린다** — 서버는 최종 주소를 기준으로 등록한다.
3. **정보 수집** (있는 것만, 없어도 진행):
   - `package.json` / `pyproject.toml` / `Cargo.toml` 등 → 프로젝트 이름, 의존성 기반 스택 추정
   - `README.md` → 서비스 설명의 근거
   - `git remote get-url origin` → 레포 URL (GitHub이면 https 형태로 변환)
   - `git config user.name` → 메이커 이름. **한두 글자이거나 비어 있으면 쓰지 않는다** —
     "R" 같은 값은 표시해도 의미가 없다. 그럴 때는 사용자에게 어떤 이름으로 표시할지 묻거나 비워둔다.
   - `curl -s <url>` → 랜딩 페이지 카피 (title, meta description, 본문 요지)
4. **소개 작성**: 위 자료를 근거로 직접 작성한다.
   - `name`: 제품 이름
   - `tagline`: 한 줄 소개 (200자 이내)
   - `description`: 3–5문장 소개. **언어는 해당 제품 랜딩 페이지의 언어를 따른다** (한국어 서비스면 한국어)
   - `category`: `Productivity` | `Dev` | `Design` | `Finance` | `Other` 중 하나
   - `builder`: 지금 이 스킬을 실행 중인 AI 툴 이름 (예: "Claude Code", "Codex")
   - `stack`: 핵심 기술 최대 12개 (예: ["Next.js", "PostgreSQL"])
5. **확인**: 수집한 정보를 표로 보여주고 "이대로 등록할까요?" 확인을 받는다. 수정 요청이 있으면 반영한다.
6. **등록 요청**:
   ```
   curl -s -X POST <API>/api/products \
     -H 'content-type: application/json' \
     -d '{"url":"...","name":"...","tagline":"...","description":"...","category":"...","builder":"...","stack":[...],"maker_name":"...","repo_url":"..."}'
   ```
7. **응답 처리**:
   - **201 (신규 등록)**:
      - `.nomorevibe.json`에 `{slug, url, api}` 저장
      - `~/.config/nomorevibe/credentials.json`에
        `{"<토큰을 발급한 API origin>": {"<slug>": {"token": "<edit_token>"}}}`를 기존 origin과
        slug 항목을 보존하며 병합 저장한다(chmod 600). 이후 인증 요청은 이 정확한 `(origin, slug)`
        항목만 사용한다.
     - 사용자에게 보고: 상세 페이지 주소(`page_url`), 현재 상태(미검증), 수정 키를 안전하게 저장했다는 사실
     - **검증 안내로 이어간다** (아래 8번)
   - **409 (`already_registered: true`)**: 이미 등록된 URL이다. 응답의 `status`를 본다.
     - `status`가 `"seeded"`: 우리가 공개 데이터를 보고 대신 올린 제품이다. 아직 주인이 없으므로
       수정 키를 찾지 말고 **클레임으로 이어간다** (아래 4번).
     - 그 밖: credentials에서 해당 API origin과 slug에 정확히 일치하는 수정 키를 찾아
       `PATCH <API>/api/products/<slug>`
       (`X-Edit-Token` 헤더)로 4번에서 만든 정보를 갱신한다.
       수정 키가 없으면 다른 곳에서 등록된 제품이므로 수정할 수 없다고 안내한다.
8. **검증 파일 제안**: 응답의 `verify.file` 정보로:
   - "공개 목록에 오르려면 도메인 소유권 검증이 필요합니다. 검증 파일을 추가해드릴까요?"
   - 동의하면 정적 파일이 서빙되는 위치를 찾아 (`public/`, `static/`, 프로젝트 구조에 따라)
     `.well-known/nomorevibe.txt` 파일을 verify_token 내용으로 생성한다.
   - SPA 등 파일 방식이 곤란하면 `<meta name="nomorevibe-verify" content="...">` 태그를 HTML head에 추가한다.
   - "재배포하신 뒤 `/nomorevibe verify` 를 실행해주세요"라고 안내한다.

## 2. 검증 (`verify`)

1. `.nomorevibe.json`에서 slug를 읽는다. 없으면 먼저 등록하라고 안내.
2. `curl -s -X POST <API>/api/products/<slug>/verify`
3. 성공(`status: "verified"`): 공개 목록에 게시됐다고 알리고 상세 페이지 주소를 보여준다.
4. 실패(422): 응답의 `expected` 내용을 보여주며 배포가 완료됐는지, 파일 경로가 맞는지 확인하도록 안내한다.
   실제 배포 URL에서 `curl -s <url>/.well-known/nomorevibe.txt` 로 직접 확인해본다.

## 3. 클레임 — 우리가 대신 올린 제품 가져오기

등록할 때 409에 `status: "seeded"`가 왔거나, 사용자가 "내 제품이 이미 올라와 있다"고 할 때.

1. **확인**: `curl -s <API>/api/products/<slug>` — 응답에 `claimable: true`와 `verify`가 있으면
   아직 주인이 없는 제품이다. 사용자에게 현재 등록된 이름·소개를 보여주고 본인 제품이 맞는지 묻는다.
2. **소유 증명**: `verify.file` 정보로 검증 파일을 만든다 (등록 8번과 같은 방식). 재배포를 안내한다.
3. **가져오기**: `curl -s -X POST <API>/api/products/<slug>/verify`
   - 성공 응답에 `claimed: true`와 `edit_token`이 온다. **이 응답에만 나오는 값이다.**
      `~/.config/nomorevibe/credentials.json`의 토큰을 발급한 API origin 아래 해당 slug에 저장하고
      (chmod 600) `.nomorevibe.json`도 만든다.
   - 이제 제품은 검증됨 상태가 되고 랭킹에 들어간다.
4. **내리고 싶다면**: 사용자가 등록을 원치 않으면 클레임할 필요가 없다.
   `curl -s -X POST <API>/api/products/<slug>/takedown -H 'content-type: application/json' -d '{"reason":"..."}'`
   이유는 선택이다. 사람이 확인한 뒤 내려주며, 내려간 뒤에는 수집기가 다시 올리지 않는다.
5. **정보 갱신**: 우리가 채운 이름·소개는 공개 데이터에서 뽑은 것이라 부정확할 수 있다.
   등록 4번처럼 정보를 만들어 `PATCH <API>/api/products/<slug>`로 갱신할지 사용자에게 묻는다.
   `builder`(만든 AI)는 이때 처음 들어간다 — 우리가 대신 채우지 않는다.

## 4. 삭제 (`delete`)

1. `.nomorevibe.json`의 API origin과 slug에 정확히 일치하는 credentials 수정 키 확보.
2. 정말 삭제할지 사용자에게 확인받는다 (삭제는 되돌릴 수 없다).
3. `curl -s -X DELETE <API>/api/products/<slug> -H 'X-Edit-Token: <token>'`
4. 성공 시 `.nomorevibe.json` 삭제, credentials에서 해당 `(origin, slug)` 항목만 제거한다. 해당
   origin 아래 slug가 더 없을 때만 빈 origin 객체도 제거한다.
