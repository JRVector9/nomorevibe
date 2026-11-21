# 제작자 커밋 이메일 — 관리자 전용 저장 (2026-11-15 요청 · 2026-11-21 결정 반영)

요청(운영자, 2026-11-15): "이메일은 외부에 공개하지 말고 탐색 시 저장해서 관리자 화면에서만 볼 수 있게 하자. 추후에 프로젝트 관리자들에게 지금 프로젝트 상황을 공개해 주기 위함이야."

소유자 결정(2026-11-21):
- 모으는 범위: 「프로젝트 제작자만 모아」. 저장소 주인 계정이 쓴 커밋의 주소만 모은다.
- 보관: 마지막 확인 뒤 1년이 지나면 자동으로 지운다.
- 삭제·거부: 관리자가 주소를 바로 지우고, 거부 목록에 넣어 다시 모으지 않게 한다. 거부 목록에는 주소가 아니라 해시만 남긴다. 모든 관리자 작업은 작업 로그에 남기되, 주소는 남기지 않는다.

(사전 점검 문서를 담았던 PR #958은 병합 없이 닫혔다. 그 문서의 결론 가운데 필요한 것, 곧 법률 검토 항목은 아래 "하지 않은 것"에 옮겼다.)

## 무엇을 하나

- **모으는 곳**: `ai-level-refresh` 잡(M3 crawler, mini 예비). 새 GitHub 요청은 없다.
  - 이 잡이 원래 읽던 GraphQL 묶음의 기본 브랜치 최근 커밋 30개에서 `history.author { name email user { login } }`를 쓴다.
  - 대상 저장소는 잡이 보는 것과 같다. 심사 중인 후보(new·needs_review·approved), 공개 제품, 다시 볼 때가 된 것이다.
- **누구의 주소인가**: 저장소 주인(`owner/name`의 owner)이 개인 계정일 때, 그 계정이 쓴 커밋만 본다(`lib/domain/makers/maintainer-emails.ts` `ownerMaintainerEmails`).
  - 판단 기준은 커밋 작성자의 GitHub 사용자 로그인(`author.user.login`)이다. GitHub이 작성자 주소를 계정에 이어 준 값이며, 이것이 주인 로그인과 같아야 한다(대소문자 무시). 이름 글자는 보지 않는다. 계정에 이어지지 않은 커밋(`user` 없음)은 뺀다.
  - 조직 저장소는 모으지 않는다.
    - 저장해 둔 주인 종류가 조직이면 커밋을 아예 보지 않는다. 주인 종류는 후보의 `crawl_documents.repo_meta.owner.type`과 제품의 `products.owner_type`에서 읽으며, 둘 중 하나라도 조직이면 조직으로 본다.
    - 주인 종류를 모르는 경우에도 GitHub의 사용자·조직 로그인은 한 이름 공간이다. 커밋 작성자는 늘 사용자이므로 조직 로그인과 맞을 수 없다.
  - 포크는 모으지 않는다.
  - 그 사람의 주소라도 연락이 안 되거나 사람 주소가 아닌 것은 버린다. GitHub 비공개 주소(`users.noreply.github.com`), `noreply`·`no-reply`, 봇, AI 도구가 작성자인 커밋(`commitAiClaims` author 표기), 예약·로컬 도메인이 그렇다. Co-authored-by 꼬리 줄은 보지 않는다.
  - 저장소마다 커밋이 많은 주소부터 3개까지 남긴다. 주소는 소문자로 바꿔 저장한다.
  - 모으지 않은 저장소는 까닭별 수만 센다. 틱 로그 `ai_level.maintainer_emails {repositories, saved, denied, organization, fork, noOwnerCommit, noAddress}`로 남고, 크롤러 활동 화면에 "제작자 이메일 수집 결과"로 보인다. 주소는 어떤 로그에도 남기지 않는다.
- **저장 표**(migration 0194)
  - `repository_maintainer_emails`: 저장소 키, 주소, 작성자 이름, GitHub 로그인, 최근 창의 커밋 수, 처음·마지막 확인 시각(timestamptz)을 둔다. 다시 볼 때는 이번에 본 주소의 커밋 수와 마지막 확인 시각만 고친다.
  - `maintainer_email_denials`: 거부한 주소의 해시만 둔다. 정규화한 주소(앞뒤 공백 제거·소문자)에 영역 구분 접두어를 붙여 sha256을 낸 값이다. 접두어가 있어 Gravatar 같은 공개 sha256(주소)와 같아지지 않는다. 다만 비밀값은 아니다. 주소를 아는 사람은 같은 값을 만들 수 있다.
- **보관(1년)**: maintenance의 `db-retention` 잡(한 시간마다)에 `maintainerEmails` 부분이 있다(`lib/operations/db-retention.ts` `pruneMaintainerEmails`).
  - `last_seen_at`이 365일보다 오래된 행을 500행씩 지운다.
  - 다시 수집되는 저장소는 시각이 계속 앞으로 가므로 지워지지 않는다. 내려간 제품, 거절된 후보, 창 밖으로 밀려난 예전 주소가 1년 뒤 사라진다.
  - 거부 목록은 지우지 않는다. 지우면 다시 모이기 때문이다.
  - 0194 전에는 `skipped=migration_pending`으로 건너뛴다.
- **보는 곳·지우는 곳**: 관리자 → 제품 상세 → **메이커** 탭 → "제작자 이메일 (관리자 전용·비공개)" 표. 관리자 확인(`currentAdmin`)을 통과한 뒤에만 읽는다.
  - 줄마다 **지우고 다시 모으지 않기** 단추가 있다(확인 창을 거친다). 그 주소를 모든 저장소에서 바로 지우고 거부 목록에 넣는다. 다음 수집부터 거부 목록에 있는 주소는 쓰지 않는다(`denied`로 센다).
  - 양식은 주소 대신 해시를 보낸다. 저장소는 양식 값이 아니라 제품의 `repo_url`로 정한다.
  - 수집 쓰기(공유)와 거부(배타)는 같은 advisory 잠금을 나눠 잡는다. 그래서 거부 직전에 목록을 읽은 수집 쓰기가 거부 뒤에 주소를 되살리지 못한다.
  - 작업 로그(`operations_audit`, action `maintainer-email-deny`, target = 제품 slug)에는 저장소 키, 지운 행 수, 이미 거부돼 있었는지만 남긴다. 주소와 해시는 남기지 않는다. 실패 기록에도 DB 오류 코드만 남는다.

## 공개되지 않게 막은 것

- 공개 화면·공개 API·피드·sitemap·OG·탐색 캐시는 이 표들을 읽지 않는다. 탐색 캐시가 주소를 `<redacted@invalid>`로 지우는 동작(`lib/crawl/discovery-contract.ts`)도 그대로다.
- 읽기·지우기 모듈 `lib/domain/makers/maintainer-emails-admin.ts`는 `server-only`다. 표시 부품은 서버 부품이라 주소는 관리자 화면 HTML에만 실린다. 브라우저 부품인 지우기 단추에는 해시와 가린 주소(`k***@fixture.nomorevibe.com`)만 넘긴다.
- `tests/maintainer-email-boundary.test.ts`가 두 표·모듈을 부르는 소스 파일을 정해진 8개로 묶는다. 공개 경로에서 부르기 시작하면 시험이 실패한다. 표는 공용 묶음 `lib/db/schema.ts`에 넣지 않는다.
- AI 판정 근거(`repository_ai_levels.evidence`)와 확인 스크립트(`scripts/ai-level-check.ts`)의 내보내기 파일에는 주소가 섞이지 않는다. 주소는 `processBatch`의 `contacts`로 따로 다니고, 스크립트는 그것을 쓰지 않는다.
- Oracle 최소 권한 계정에는 GRANT하지 않는다. 그쪽에서는 읽을 일도, 쓸 일도 없다. 적용 뒤 `\dp repository_maintainer_emails`·`\dp maintainer_email_denials`로 Oracle·monitor 계정이 없는지 확인한다.

## 경계 밖에 남는 것 (알려진 상태, 코드 변경 없음)

- **관리자 화면은 아직 무로그인 내부망 관리자다.** 그래서 "관리자만"은 실제로 "관리자 내부망에 닿는 누구나"와 같다.
- **공개 웹 컨테이너도 같은 DB 계정을 쓴다.** 공개 경로가 읽지 않게 막는 것은 코드(경계 시험)뿐이다.
- **DB 백업·복구 연습·Oracle DR 복제본에는 이 표들이 그대로 들어간다.**
  - `scripts/ops/oracle-dr/replication_plan.py`는 표 목록을 inventory에서 만들고 제외 목록만 뺀다. 두 표 모두 기본 키가 있어 복제 대상이 된다.
  - 백업 보관 기간 동안에는 1년 보관 정리나 관리자 삭제로 지운 주소도 백업 안에 남는다.
  - 제외 목록에 넣을지는 소유자가 정할 일이다.
- 0.5초를 넘긴 INSERT는 Postgres 문장 로그에 bind 값과 함께 남을 수 있다. 가능성은 낮지만, 운영 `log_min_duration_statement`·`log_parameter_max_length` 설정은 확인하지 않았다.

## 하지 않은 것 / 남은 결정

- **메일 발송 기능은 없다.** 관리자 화면에도 보내기 단추나 mailto 링크를 두지 않았다.
  - 실제로 연락하기 전에 법률 검토를 받아야 한다. 걸리는 규정은 GitHub AUP §7(요청받지 않은 메일 금지)과 정보통신망법 제50조·제50조의2다.
  - 공개된 개인정보도 처리 근거를 고지해야 한다(개인정보 보호법, GDPR 제14조). 개인정보 처리방침에 수집 사실을 적을지도 운영자가 정해야 한다. 지금 `messages/ko/policy.ts`는 방문 분석에 관한 문구뿐이고, 이 PR에서 바꾸지 않았다.
- **소급 수집은 없다.** 배포 뒤 잡이 각 저장소를 다시 볼 때부터 채워진다. 공개 제품은 대개 72시간 주기다.
- 거부를 푸는 화면은 없다. 거부 목록에는 해시만 있어서 화면에 보일 주소도 없다.

## 배포 시 주의

- migration 0194는 새 표 둘과 그 인덱스만 만든다. 기존 표를 잠그거나 CHECK를 다시 짓지 않으므로 **DRAIN은 필요 없다.** 옛 웹·워커는 이 표들을 모르고 그대로 돈다.
- **번호를 0186에서 0194로 옮긴 까닭**
  - drizzle migrator는 이미 적용된 마지막 `created_at`(운영은 0193, `1795219200002`)보다 큰 `when`만 적용한다.
  - 0186(`1794700800000`)으로 두면 "완료"로 끝나면서 실제로는 적용되지 않는다. 그러면 배포 관문이 적용 수 부족으로 계속 거절한다.
  - 그래서 0194(`1795219200003`)로 붙였다. 0193까지 적용된 DB에 0194만 적용되는지는 PR 본문의 검증 기록을 본다.
- 쓰는 쪽은 crawler(`ai-level-refresh`)와 maintenance(`db-retention` 보관 정리)이고, 읽고 지우는 쪽은 웹(관리자)이다. 실제 대상 앱은 `npm run deploy -- scope`·`plan`으로 정한다. 새 잡은 없으므로 scheduler를 먼저 배포할 필요도 없다.
  - 주소 기록은 저장점(savepoint) 안에서 한다. 표가 없거나 기록이 실패해도 AI 단계 판정은 그대로 적힌다. 실패하면 로그 `ai_level.maintainer_emails_failed {repositories, code}`가 남는다.
  - 관리자 화면은 표가 없으면 "제작자 이메일을 읽지 못했습니다."로 보인다.
- `deployment-fast-path.md` 규칙대로, 일반 배포가 DB 이전을 대신하지 않는다. 0194를 별도 승인된 이전으로 먼저 적용한 뒤 `plan --migration-verified`로 진행한다.
