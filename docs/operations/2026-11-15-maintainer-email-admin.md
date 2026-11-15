# 커밋 작성자 이메일 — 관리자 전용 저장 (2026-11-15)

요청(운영자, 2026-11-15): "이메일은 외부에 공개하지 말고 탐색 시 저장해서 관리자 화면에서만 볼 수 있게 하자. 추후에 프로젝트 관리자들에게 지금 프로젝트 상황을 공개해 주기 위함이야."

앞선 점검: `docs/operations/2026-11-15-github-author-email-feasibility.md`(PR #958). 이 문서는 그 결정에 따른 구현 기록이다.

## 무엇을 하나

- **모으는 곳**: `ai-level-refresh` 잡(M3 crawler). 새 GitHub 요청은 없다. 이 잡이 원래 읽던 기본 브랜치 최근 커밋 30개의 작성자 주소(GraphQL `history.author.email`)를 쓴다.
  - 대상 저장소는 잡이 보는 것과 같다: 심사 중인 후보(new·needs_review·approved), 공개 제품, 다시 볼 때가 된 것.
  - 포크는 모으지 않는다. 포크의 커밋은 원본 저장소 사람의 것이기 때문이다.
- **남기는 주소**: 실제 사람 주소로 보이는 것만 남긴다(`lib/domain/makers/maintainer-emails.ts`).
  - 버리는 주소: GitHub 비공개 주소(`users.noreply.github.com`), `noreply`·`no-reply`, 봇(`[bot]`, `…-bot`), AI 도구가 작성자인 커밋(`commitAiClaims` author 표기), 예약·로컬 도메인(example.com, .local, localhost 등).
  - Co-authored-by 꼬리 줄의 주소는 보지 않는다.
  - 저장소마다 커밋이 많은 사람부터 10개까지 남긴다. 주소는 소문자로 바꿔 저장한다.
- **저장 표**: `repository_maintainer_emails`(migration 0186). 칸은 저장소 키, 주소, 작성자 이름, GitHub 로그인, 최근 창의 커밋 수, 처음·마지막 확인 시각이다.
  - 다시 볼 때는 이번에 본 주소의 커밋 수와 마지막 확인 시각만 고친다.
  - 창 밖으로 밀려난 예전 주소는 지우지 않는다. 예전 관리자도 연락 대상이 될 수 있기 때문이다.
- **보는 곳**: 관리자 → 제품 상세 → **메이커** 탭 → "커밋 작성자 이메일 (관리자 전용·비공개)" 표. 관리자 확인(`currentAdmin`)을 통과한 뒤에만 읽는다.

## 공개되지 않게 막은 것

- 공개 화면·공개 API·피드·sitemap·탐색 캐시는 이 표를 읽지 않는다. 탐색 캐시가 주소를 `<redacted@invalid>`로 지우는 동작(`lib/crawl/discovery-contract.ts`)은 그대로다.
- 읽기 모듈 `lib/domain/makers/maintainer-emails-admin.ts`는 `server-only`다. 표시 부품은 서버 부품이라 관리자 화면 HTML에만 실린다.
- `tests/maintainer-email-boundary.test.ts`는 이 표나 모듈을 부르는 소스 파일을 정해진 7개로 묶는다. 공개 경로에서 부르기 시작하면 시험이 실패한다.
- AI 판정 근거(`repository_ai_levels.evidence`)와 확인 스크립트(`scripts/ai-level-check.ts`)의 내보내기 파일에는 주소가 섞이지 않는다. 주소는 `processBatch`의 `contacts`로 따로 다닌다.
- Oracle 최소 권한 계정에는 GRANT하지 않는다. 그쪽에서는 읽을 일도, 쓸 일도 없다.

## 하지 않은 것 / 남은 결정

- **메일 발송 기능은 없다.** 관리자 화면에도 보내기 버튼이나 mailto 링크를 두지 않았다.
  - 실제로 연락하기 전에 법률 검토를 받아야 한다. 걸리는 규정은 GitHub AUP §7(요청받지 않은 메일 금지)과 정보통신망법 제50조·제50조의2다.
  - 공개된 개인정보도 처리 근거를 고지해야 한다(개인정보 보호법, GDPR 제14조). 개인정보 처리방침에 수집 사실을 적을지도 운영자가 정해야 한다. 지금 `messages/ko/policy.ts`는 방문 분석에 관한 문구뿐이고 바꾸지 않았다.
- **삭제 요청 처리 화면은 없다.** 지금은 운영 DB에서 직접 지운다.
  ```sql
  DELETE FROM repository_maintainer_emails WHERE email = lower('<주소>');
  ```
  단, 지워도 다음 확인(72시간 주기) 때 같은 커밋에서 다시 모인다. 다시 모으지 않게 하려면 거부 목록(주소 해시)이 필요하며, 이는 후속 작업이다.
- **보관 기한이 없다.** 내려간 제품이나 거절된 후보의 주소도 남는다. 정리 주기는 후속으로 정한다.
- **소급 수집은 없다.** 배포 뒤 잡이 각 저장소를 다시 볼 때부터 채워진다. 공개 제품은 대개 72시간 주기다.

## 배포 시 주의

- 새 표 하나만 만드는 migration이다(0186). 옛 웹·워커는 이 표를 모르고 그대로 돈다.
- 쓰는 쪽은 crawler(`ai-level-refresh`), 읽는 쪽은 웹(관리자)이다. migration을 먼저 적용해야 주소가 모인다.
  - 주소 기록은 저장점(savepoint) 안에서 한다. 표가 없거나 기록이 실패해도 AI 단계 판정은 그대로 적힌다.
  - 실패하면 로그 `ai_level.maintainer_emails_failed {repositories, code}`가 남는다. 주소는 로그에 남기지 않는다.
  - 관리자 화면은 표가 없으면 "작성자 이메일을 읽지 못했습니다."로 보인다.
- `deployment-fast-path.md` 규칙대로, 일반 배포가 DB 이전을 대신하지 않는다. 0186을 별도 승인된 이전으로 먼저 적용하고 `plan --migration-verified`로 진행한다.
- 이 migration은 새 표만 만들고 CHECK를 바꾸지 않으므로 DRAIN은 필요 없다.
