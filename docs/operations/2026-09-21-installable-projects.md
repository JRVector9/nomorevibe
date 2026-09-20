# 설치형 GitHub 프로젝트 등록 기준 — 2026-09-21

## 변경 내용

- GitHub 별 500개 이상인 실제 소프트웨어는 배포 URL이 없어도 심사한다. 기존 스타 상한은 500개 이상에 적용하지 않는다. 웹 제품은 기존대로 별 500개 미만도 심사한다.
- 홈페이지가 없거나 자신의 GitHub 저장소·문서 주소만 있으면 설치형 후보로 넘긴다. 별 숫자만으로 제품임을 확정하지 않는다. 1차와 2차 심사가 README에서 기능·설치·사용 근거를 판단한다.
- 책·논문·개인 연구 노트·튜토리얼·일회성 설문·단순 링크/프롬프트 모음은 제외한다. 설치 가능한 SKILL.md 패키지는 Markdown이라는 이유로 문서로 거절하지 않는다. 기존 포크·보관됨·차단/중복 보호는 유지한다.
- Plugin(플러그인), Skill(스킬)을 분류·필터·관리자 정의와 분류 RPC에 추가한다. 기능을 확장하는 플러그인과 호스트에 설치하는 스킬을 구분한다.
- products.access_mode의 기본값은 website다. installable 제품의 url은 공식 저장소 식별자이며 배포 URL을 의미하지 않는다. 수집 원본과 후보의 null URL은 그대로 두어 1차/2차/발행의 원본 일치 검증을 유지한다.
- 상세와 목록에서 직접 설치를 표시하고, 상세의 방문 버튼 대신 Copy Prompt를 제공한다. 프롬프트는 공식 저장소에서 설치법·운영체제·호스트·권한을 확인하도록 요청한다. AI가 실행할 권한이 없는 환경에서는 단계별 안내를 하도록 명시한다. 복사가 제한되면 읽기 전용 입력란에서 직접 복사할 수 있다.
- 설치형 프로젝트는 웹 가동률 측정과 github.com 도메인 소유권 검증 대상에서 제외한다. GitHub 공용 파비콘 대신 저장소 이미지·소유자 이미지·서비스 기본 이미지를 사용한다.

## 기존 거절 항목 처리

최초 운영 조회: 별 500개 이상 중 no_homepage 191건, not_a_product 자동 205/관리자 15건, large_oss 80건, already_listed 57건, unreachable 14건, personal_site 7건.

새 규칙의 첫 dry run은 자동 거절 497건을 검토하여 392건을 재심사 대상으로 골랐다(추가 중복 보호 전 수치). 중복 보호를 포함한 최종 dry run도 392건이며, 전부 재심사 큐에 넣었다. 관리자가 직접 거절한 항목은 자동으로 뒤집지 않는다.

`node --import tsx scripts/reconsider-installable.ts --plan <new-plan.json>`은 읽기 전용이다. `--apply <plan.json> <actor>`는 행·원본·정책 해시가 같은 후보만 재수집으로 돌리고 operations_audit에 남긴다. 새 수집이 끝나기 전에는 기존 원본으로 AI 심사하지 않는다. 이전 결정 기록을 삭제하거나 승인으로 덮어쓰지 않는다.

운영 실행 시 런타임 env를 명시적으로 주입한다. Node의 --env-file은 기존 DATABASE_URL을 덮어쓰지 않으므로, 이미 테스트 DB 환경변수가 있다면 잘못된 DB를 조회할 수 있다. 환경 파일의 값은 출력하거나 저장소에 커밋하지 않는다.

## 검증

단위 136개 파일 / 1,058개 테스트, 통합 74개 파일 / 719개 테스트, 제품 상세 브라우저 테스트 4개 통과. Copy Prompt의 클립보드 내용·권한 거절 시 직접 복사·모바일 폭과 글자 크기를 확인했다. 최종 발행 경합 보호 테스트 57개, 원본 갱신 경계 테스트 18개도 통과했다. 최신 커밋의 GitHub CI에서 타입·린트·단위·통합·빌드 전체 단계가 통과했다. Next 프로덕션 빌드와 타입 검사 통과. ESLint 오류 0, 기존 vendor 미사용 변수 경고 1개.

실제 공개 README로 qwen3.6-35b-heretic과 gpt-oss-120b 각각 검증했다. gstack, last30days-skill, hyperframes는 두 모델 모두 승인, ai-agent-book은 두 모델 모두 거절했다. 4개 × 2모델의 경계 사례 점검이며 통계적 정확도 평가가 아니다. README 뒤쪽의 설치 섹션이 잘리던 문제를 보완한 뒤 재실행해 같은 결과를 확인했다.

## 추가 수집 제안

1. `stars:>=500 archived:false fork:false`에 `topic:agent-skills`, `topic:browser-extension`, `topic:vscode-extension`, `topic:cli`, `topic:self-hosted` 등을 조합한 탐색 경로를 추가한다. AI 개발 흔적과 제품 유형은 별개 신호로 저장한다. GitHub의 [저장소 검색 조건](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories)을 사용한다.
2. README뿐 아니라 패키지 매니페스트·플러그인 manifest·SKILL.md의 호스트 및 진입점과 릴리스 자산을 함께 수집한다. 설치 명령은 실행하지 않고 출처와 커밋을 저장해 제품 유형 판단에 쓴다.
3. 최근 스타 증가·최근 실제 릴리스·명확한 설치 경로를 재수집 우선순위에 함께 반영한다. 마지막 커밋이 오래됐다는 이유만으로 완성된 작은 도구를 버리지 않는다. 릴리스가 없는 저장소는 날짜를 만들어 넣지 않는다. [GitHub 릴리스 API](https://docs.github.com/en/rest/releases/releases).
4. API 사용량을 신규 탐색·재심사·일일 별 갱신별로 나누어 관측한다. 안정된 URL에 인증된 ETag/Last-Modified 조건부 요청을 써서 변경 없는 응답의 비용을 줄인다. GitHub는 인증된 304 응답을 기본 한도에 계산하지 않는다. 이번 운영에서도 core 한도 소진으로 재수집이 대기했다. [GitHub 권장 요청 방식](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests).
5. 저장소 검색은 한 질의당 최대 1,000건이므로 날짜·별 구간을 나눈 탐색과 저장소 ID 기준 중복 제거를 함께 쓴다. 기존 검색 윈도 분할을 새 Plugin/Skill 쿼리에도 적용한다. [GitHub 검색 API](https://docs.github.com/en/rest/search/search#about-search).
6. 수집 경로별 승인율·문서 오탐률·1차/2차 불일치율을 측정하고, 경계 사례에 사람의 정답을 붙여 모델·프롬프트 회귀 평가 세트로 유지한다.

## 실행 기록

- PR #154: `7b30ecf1d6c3574f4213cea13235f8141c860fe4`, 2026-09-21 01:59 KST 병합. CI `35524198751` 통과.
- 운영 DB migration0041 적용 완료. 웹 M3·mini, crawler, reviewer, publisher, maintenance, scheduler, connect-agent 8개 배포 완료. 6개 작업 컨테이너 healthy, 각각 주요 소스 9개 SHA256 일치. 양쪽 웹 /api/health HTTP200 및 DB 정상. 기존 RELEASE_TAG 환경값은 오래된 값이므로 배포 기록과 실제 소스로 확인했다.
- 자동 거절 497건 중 392건 재심사 적용, 변경 경합으로 제외된 건0. 기존 사유: no_homepage191 / large_oss67 / not_a_product132 / personal_site2. operations_audit에 392건 기록(actor `codex-2026-09-21-installable-policy`). 관리자 거절15건 유지.
- 02:04 KST에는 392건 모두 새 원본 수집 대기. GitHub core 한도의 리셋은 02:15:51 KST. 완료된 심사 수치가 아니며, 아래 후속 관측으로 보완한다.
- 운영 브라우저: Skill·Plugin 쿼리 인식 및 카테고리 변경, 390px 가로 넘침 없음, pageerror0 확인. 발행 제품이 0개인 분류는 기존 UI 정책상 기본 드롭다운에서 숨기고 해당 URL로 선택했을 때 표시한다. 첫 설치형 제품 발행 뒤 실제 Copy Prompt 화면을 다시 확인한다.

### 추가 경계 사례 검토

공개 README 6개를 두 모델로 추가 평가했다. 설치형 연구 자동화 스킬(ARIS), Nix 패키지, 취업 지원 프레임워크, OpenWiki CLI는 양쪽 모두 승인했다. DefinitelyTyped 타입 패키지와 Free-TV IPTV 재생목록에서는 문서·패키지·데이터 경계가 드러났다. 프롬프트2026-09-21.2는 웹 URL 거부 조건을 설치형에 적용하지 않도록 분리하고 타입 패키지와 단순 데이터 목록의 차이를 명시한다. 보완 후에도 두 사례는 모델 판단이 갈렸다. 이들은 자동 확정의 근거가 아니라 기존 2차 불일치→사람 확인 절차가 필요한 사례이며, 정확도100%로 보고하지 않는다. 실제 큐의 판단은 새로운 수집과 정상 심사 결과에 따른다.

### 운영에서 발견한 README 저장 결함

홈페이지가 없는 원본의 page_meta는 SQL NULL인데 README 저장의 원본 일치 조건이 JSON null과 비교하여 저장하지 못했다. 실제 첫 심사 4건이 README 근거 없음으로 보류된 것을 보고 발견했다. null 원본 저장 및 수집 중 원본 교체 경합을 통합 테스트로 추가했으며, 수정 전 실패와 수정 후 관련 11개 통과를 확인했다. null 비교만 바로잡고 기존 원본 일치 보호는 유지한다. 수정 배포 뒤 영향을 받은 자동 심사 건만 감사 기록을 남겨 재판정한다.

첫 발행 결과에서 GitHub 공용 페이지 제목이 프로젝트명으로, API 문서 소개가 SDK 한 줄 소개로 사용되는 문제도 확인했다. 설치형은 저장소명과 저장소 설명을 사용하고, 저장소 설명이 없으면 README 기반 소개 생성 경로를 따른다. GitHub/문서 사이트의 포장 제목을 제품명으로 쓰지 않는 통합 회귀 테스트를 추가했다.
