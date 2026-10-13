# 공개 i18n — 로그인·피드백 원문·공개 안내·게재 기준

2026-10-13. 격리 브랜치 `feat/public-i18n-auth-pages-20261013`, 기반 `9e95dc3`에서 네 공개 페이지와 지정 클라이언트 및 카탈로그를 구현했다. foundation `01823626`/`72f49874`, 공통 labels/server time `3cd0d64`를 별도 선행 커밋으로 받았다. registry 충돌은 기존 labels/browse/detail/auth/launch/policy와 globalError를 모두 보존했고 foundation의 dictionary 반환 타입 cast를 유지했다. 최종 UI 커밋은 소유 파일만 담는다.

## 변경과 계약

- 로그인·이메일 폼·GitHub 연결의 모든 제목, 안내, 상태, 오류, 버튼, aria 문구를 auth49개 semantic key로 옮겼다. API 오류 코드는 그대로 받아 번역 key에 대응한다. state에 key를 저장하여 effect에서 번역 함수를 새 fetch 의존성으로 만들지 않는다. 기존 플래그, 이메일 발송 설정, CSRF, consent, 코드 입력, disabled/busy, GitHub 연결·해제 동작은 유지한다.
- login은 공통 `safePublicReturnUrl(value, localePath(locale,'/'))`를 사용한다. 없거나 유효하지 않은 복귀 주소는 현재 언어 홈으로 간다. 명시된 정상 주소는 그 주소의 언어·query·hash·사용자 의도를 보존한다. 이미 로그인한 사용자의 locale별 login 자기복귀는 현재 언어 홈으로 보낸다. sanitizer를 별도로 만들지 않았다.
- 피드백 permalink는 auth 서버 문구와 현재 언어 제품 링크를 사용한다. 공통 `FeedbackItem`의 사용자 글 원문은 변경하지 않았다. 해당 클라이언트에는 선택 locale의 detail slice만 전달하며, FeedbackItem 자체의 상세 번역은 detail 소유자가 처리한다. 기존 사용자/관리자 조회 및 공개/비공개 판단은 유지한다.
- launch44개 key는 등록·도메인 확인·설치·기타 도구 안내와 copy/clipboard fallback 상태 및 접근성 이름을 포함한다. 명령, 설치 스크립트 원문, 기술 이름, 경로, machine `/install.sh`, 앵커를 그대로 유지한다. 정책 링크만 `localePath`로 만든다.
- policy40개 key는 기존 등재·AI 근거·제외·소유 확인·내림 요청·연락 구획과 같은 처리 기준을 담는다. 기존 여섯 앵커를 유지하고 공통 labels의 미확인 명칭/설명을 재사용한다. 등록/확인 안내 링크는 선택 locale을 유지한다.
- auth/launch/policy의 네 locale 카탈로그는 한국어 key·placeholder 타입을 따른다. 간체·번체 문구와 소프트웨어 용어를 각각 작성했다. 한 번의 서버 렌더에는 선택한 언어의 필요한 slice만 전달한다.
- 네 page의 metadata는 locale별 `generateMetadata`다. login/feedback의 기존 noindex/nofollow를 유지한다. 완료된 launch/policy UI는 index/follow와 네 언어 상호 alternate 및 한국어 x-default를 사용한다. canonical은 자기 언어의 논리 경로다. 기존 shareMetadata의 기본 image/twitter를 유지하며 locale helper를 얕은 OpenGraph 결과에 합친다. 잘못된 feedback ID에는 alternate를 만들지 않아 metadata가 machine-path 예외로 원래404를500으로 바꾸지 않는다.

수정 파일은 네 page, launch CopyCommand, EmailLoginForm/GithubConnection, 세 namespace×네 locale 및 이 문서다. root/proxy/core registry/dictionary/shared detail 컴포넌트는 UI 커밋에 포함하지 않는다. root가 공통 handoff를 갱신한다.

## 실제 실행한 확인

- `npx next typegen`: exit0.
- `npx tsc --noEmit --incremental false`: exit2. 구현 모듈의 타입 오류는 보고되지 않았다. 기존 테스트 세 곳의 static metadata export 참조가 남았다: `tests/launch-brand-outputs.test.ts`, `tests/popular-page.test.tsx`, `tests/site-chrome.test.tsx`. 통합 담당자가 async generateMetadata 계약으로 기존 기대값을 연결한다. 전체 통과로 주장하지 않는다.
- `npm run check:i18n`: exit1, `detail: release namespace is empty`. 상세 namespace는 다른 에이전트의 미완료 작업이다. 모든 locale의 파일 목록과 비어 있지 않은 값 검사는 이 오류 이전에 완료됐으며, 소유 namespace의 key/placeholder 일치는 아래 임시 assertion으로 별도 확인했다.
- 소유 TS/TSX catalog/page/client만 실행한 `npx eslint ...`: exit0.
- `git diff --check`: exit0.
- `node --conditions=react-server --import tsx --input-type=module` 임시 assertion: exit0. auth49/launch44/policy40×네 언어의 key·placeholder·비어 있지 않은 문구·비한국어 locale의 Hangul 잔존0, interpolation, 원본 명령·경로·8/10/500/24 수치 및 중앙 return URL의 locale/query/hash 유지/불허 경로 fallback을 확인했다. DB/HTTP/인증 mutation/LLM 호출은 없었다.

별도 suite나 E2E를 추가·실행하지 않았다. 실제 로그인/이메일/GitHub/댓글 쓰기, DB, 운영, migration, LLM, env 복사 및 build는 실행하지 않았다. 소개 검수는 재개하지 않았다. 초기 기반 파일에는 feedback return URL이 숫자만 허용됐으나 foundation을 받은 실제 파일은 `/feedback/[^/]+`로 UUID를 수용함을 확인했다. 별도 routing 수정은 필요하지 않았다.

## 통합 후 확인

통합 담당자가 detail 카탈로그와 FeedbackItem, 기존 metadata 테스트 참조를 완료한 뒤 실행한다.

```sh
npx next typegen
npx tsc --noEmit --incremental false
npm run check:i18n
npm run lint
npm run build
node scripts/bundle-size.mjs
git diff --check
```

EmailLoginForm/GithubConnection/CopyCommand를 직접 렌더하는 기존 테스트도 선택한 namespace와 server timestamp provider 계약을 받도록 통합 담당자가 조정한다. 이 작업에서 테스트를 실행해 성공했다고 주장하지 않는다.
