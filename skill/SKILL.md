---
name: nomorevibe
description: 배포한 서비스를 NoMoreVibe에 등록/수정/검증/삭제한다. /nomorevibe (등록·업데이트), /nomorevibe verify (도메인 검증), /nomorevibe delete (삭제) 로 실행. 사용자가 "노모어바이브", "nomorevibe에 올려줘", "서비스 등록해줘" 라고 요청할 때 사용.
---

# NoMoreVibe 등록 스킬

배포된 서비스의 정보를 수집해 NoMoreVibe 레지스트리에 등록한다.
API 베이스: 환경변수 `NOMOREVIBE_API`가 있으면 그 값, 없으면 `{{SITE_URL}}`.

## 공통 규칙

- 로컬 상태 파일: 프로젝트 루트의 `.nomorevibe.json` — `{ "slug": "...", "url": "...", "api": "..." }`
- 수정 키 저장소: `~/.config/nomorevibe/credentials.json` — `{ "<slug>": "<edit_token>" }`
  - **수정 키는 절대 프로젝트 폴더에 저장하지 않는다** (git에 커밋되면 아무나 제품을 삭제할 수 있다)
  - 파일 생성 시 `chmod 600` 적용
- 모든 API 호출은 `curl -s`로 하고, 응답 JSON의 `error` 필드를 사용자에게 그대로 전달한다

## 서브커맨드 판별

- 인자 없음 또는 URL → **등록/업데이트**
- `verify` → **검증**
- `delete` → **삭제**

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
     - `~/.config/nomorevibe/credentials.json`에 `{"<slug>": "<edit_token>"}` 병합 저장 (chmod 600)
     - 사용자에게 보고: 상세 페이지 주소(`page_url`), 현재 상태(미검증), 수정 키를 안전하게 저장했다는 사실
     - **검증 안내로 이어간다** (아래 8번)
   - **409 (`already_registered: true`)**: 이미 등록된 URL이다. 응답의 `status`를 본다.
     - `status`가 `"seeded"`: 우리가 공개 데이터를 보고 대신 올린 제품이다. 아직 주인이 없으므로
       수정 키를 찾지 말고 **클레임으로 이어간다** (아래 4번).
     - 그 밖: credentials에서 해당 slug의 수정 키를 찾아 `PATCH <API>/api/products/<slug>`
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
     `~/.config/nomorevibe/credentials.json`에 저장하고(chmod 600) `.nomorevibe.json`도 만든다.
   - 이제 제품은 검증됨 상태가 되고 랭킹에 들어간다.
4. **내리고 싶다면**: 사용자가 등록을 원치 않으면 클레임할 필요가 없다.
   `curl -s -X POST <API>/api/products/<slug>/takedown -H 'content-type: application/json' -d '{"reason":"..."}'`
   이유는 선택이다. 사람이 확인한 뒤 내려주며, 내려간 뒤에는 수집기가 다시 올리지 않는다.
5. **정보 갱신**: 우리가 채운 이름·소개는 공개 데이터에서 뽑은 것이라 부정확할 수 있다.
   등록 4번처럼 정보를 만들어 `PATCH <API>/api/products/<slug>`로 갱신할지 사용자에게 묻는다.
   `builder`(만든 AI)는 이때 처음 들어간다 — 우리가 대신 채우지 않는다.

## 4. 삭제 (`delete`)

1. `.nomorevibe.json`의 slug + credentials의 수정 키 확보.
2. 정말 삭제할지 사용자에게 확인받는다 (삭제는 되돌릴 수 없다).
3. `curl -s -X DELETE <API>/api/products/<slug> -H 'X-Edit-Token: <token>'`
4. 성공 시 `.nomorevibe.json` 삭제, credentials에서 해당 항목 제거.
