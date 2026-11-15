# GitHub 제작자 이메일 수집 가능성 점검 (2026-11-15)

요청: 자료 탐색(GitHub 발굴·근거 수집) 중 저장소를 올린 제작자의 이메일도 크롤링할 수 있는지 확인.
범위: 코드 읽기와 공개 정책 문서 확인만. 코드·설정·운영 DB 변경 없음, 실제 이메일 수집·저장 없음.

## 결론

- **기술적으로는 가능하다.** 공개 저장소의 커밋 메타데이터에는 작성자 이메일이 들어 있고, 지금 파이프라인도 이미 그 값을 받는다.
- **지금은 일부러 저장하지 않는다.** AI 도구 판별(예: `noreply@anthropic.com`)에 쓴 뒤 버리고, 탐색 캐시에서는 지운다.
- **연락용 수집은 권하지 않는다.** GitHub 이용 정책(AUP), 정보통신망법 제50조·제50조의2, 우리 사이트의 공개 정책과 부딪힌다.

## 1. 이메일이 노출되는 곳 (공개 저장소 기준)

| 출처 | 내용 | 비고 |
|---|---|---|
| 커밋 메타데이터 (REST `/repos/{o}/{r}/commits[/{sha}]`, GraphQL `history { author { email } }`, `/search/commits`, `git clone`, `…/commit/{sha}.patch`) | 커밋 author·committer 이메일 | 로컬 git 설정값이 그대로 남는다. 개인정보 보호를 켠 사람은 `ID+login@users.noreply.github.com`(연락 불가) |
| 사용자 프로필 (`/users/{login}`의 `email`) | 본인이 공개로 설정한 이메일만 | 대부분 null |
| 저장소 본문 (README·package.json `author`·LICENSE 등) | 본인이 직접 적은 연락처 | 형식이 제각각 |
| Co-authored-by 트레일러 | 공동 작성자 이메일 | 주로 AI 도구나 봇 주소 |

GitHub 문서(커밋 이메일 설정)에 따르면, 명령줄에서 push한 커밋에는 로컬 git의 이메일이 쓰인다. 이메일을 바꿔도 과거 커밋은 이전 주소를 그대로 가진다. 그래서 커밋을 읽기만 해도 실제 개인 이메일을 상당수 얻을 수 있다.

## 2. 현재 파이프라인이 다루는 방식 (main c5d2c2b9 코드)

- `lib/domain/evidence/ai-level-query.ts:18,67` — GraphQL 커밋 이력에서 `author { name email user { login } }`를 받아 `authorEmail`로 넘긴다.
- `lib/jobs/products/ai-level-refresh.ts:214,223` — REST 커밋 1건에서 `commit.author.email`을 받는다.
- `lib/domain/evidence/ai-level.ts:53-81,107` — 이 값은 AI 도구 판별 규칙에만 쓴다. 메모리에서 비교한 뒤 버린다.
  - 판별 규칙 예: `noreply@anthropic.com`, `@openai.com`, `cursoragent@cursor.com`, `copilot-swe-agent[bot]@users.noreply.github.com`
  - 결과로는 `client`·`basis`만 남는다.
- `lib/crawl/discovery-contract.ts:21-38` — 탐색 캐시에 넣기 전에 저장소 이름·설명·sha·검증된 트레일러 라벨만 남긴다. 이메일은 `<redacted@invalid>`로 바꾼다("commit prose/emails never enter the cache").
- `lib/domain/evidence/agents/commit-changes.ts:17` — "never persist email addresses or commit message bodies".
- `products` 표(`lib/db/schema.ts`)에는 `maker_name`, `owner_type`, `repo_url`만 있다. 제작자 이메일 칸은 없다.
- 이메일을 저장하는 표는 우리 사이트 계정(이메일 로그인), 관리자 문의 접수(`admin_contact_requests.sender_email`)처럼 본인이 직접 준 경우뿐이다.

즉 구현하려면 지금 일부러 막아 둔 경로를 풀어야 한다. 이미 받고 있는 값을 저장하는 일이라 기술 난이도는 낮다.

## 3. 규정·정책 제약

1. **GitHub Acceptable Use Policies §7 Information Usage Restrictions**
   - 원문: "You may not use information from the Service (whether scraped, collected through our API, or obtained otherwise) for spamming purposes, including for the purposes of sending unsolicited emails to users or selling personal information, such as to recruiters, headhunters, and job boards."
   - 연구 목적 허용 범위도 "public, non-personal information"으로 한정된다.
   - 따라서 API로 모았더라도, 제작자에게 요청받지 않은 메일을 보내면 위반이다. 위반하면 수집 계정·토큰이 정지될 위험이 있고, 운영 발굴 전체가 이 토큰에 기대고 있다.
2. **정보통신망법 제50조의2(전자우편주소의 무단 수집행위 등 금지)**
   - 홈페이지 운영자의 사전 동의 없이 프로그램으로 전자우편주소를 자동 수집하는 것을 금지한다.
   - 그렇게 모은 주소를 판매·유통하거나 전송에 쓰는 것도 금지한다.
   - GitHub는 위 정책으로 사실상 동의하지 않은 상태로 봐야 한다.
3. **정보통신망법 제50조** — 영리 목적 광고성 정보를 메일로 보내려면 수신자의 명시적 사전 동의가 필요하다. 신규 등록 안내나 배지 홍보도 광고성으로 볼 여지가 있다.
4. **개인정보 보호법 / GDPR** — 공개된 개인정보도 개인정보다. 처리 목적·근거·고지·보관 기간·열람 삭제 요청 처리가 필요하다. EU 제작자는 GDPR 제14조에 따라 직접 받지 않은 정보도 고지할 의무가 있다.
5. **우리 사이트 정책**(`messages/ko/policy.ts`)
   - 분석 데이터에서 이메일을 제외한다.
   - 본인이 동의하지 않은 개인 프로필은 노출하지 않는다.
   - 이메일을 모아 두면 이 방향과 반대가 되고, 공개 정책 문구도 바꿔야 한다.

※ 법률 조항은 일반적인 해석이다. 실제로 하려면 법률 검토가 필요하다.

## 4. 대안 (제작자에게 닿아야 할 때)

- **메이커 소유 확인 흐름 활용**: 제작자가 GitHub로 로그인해 저장소를 확인할 때 연락 이메일 수신 동의를 함께 받는다. 동의 기반이라 위 제약을 모두 피한다. 이미 있는 maker claim 흐름에 붙이면 된다.
- **README 배지·등록 안내**: 제작자가 스스로 찾아오게 하는 방식으로, 지금 하고 있다.
- **개별 연락**: 운영자가 건별로 사람 손으로 확인한다. 제작자가 사이트·README에 공개한 공식 문의 경로(문의 폼·Issues·Discussions)를 쓴다. 이 경우에도 대량 발송이나 자동 이슈 생성은 AUP의 스팸 금지에 걸린다.
- **집계 통계만**: "noreply 비율" 같은 숫자가 필요하면, 주소를 저장하지 않고 메모리에서 분류해 개수만 남긴다.

## 5. 이번에 하지 않은 것

- 실제 저장소 표본으로 noreply·실주소 비율을 재지 않았다. 운영 DB 읽기가 권한에서 거절됐고, 공개 피드에는 저장소 주소가 없다(#956 축소의 결과).
- 법률 자문을 받지 않았다.
- 코드 변경이나 기능 구현을 하지 않았다.
