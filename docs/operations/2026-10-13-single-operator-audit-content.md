# NoMoreVibe 1인 관리자 운영 감사 — 콘텐츠 영역

## 범위와 증거의 한계

- 읽은 저장소: `/private/tmp/nomorevibe-i18n-integration-20261013`, 조회 시 HEAD `4a9a227861b29b1e06aca902ff71d502a3fcaf8a`.
- 범위: 제품 발견·후보 심사·발행·수정·근거/이미지/번역/업데이트·공개 목록/랭킹·차단/복구·신고/메이커 확인. AI 소식도 콘텐츠 메뉴이므로 보조 검토했다.
- AGENTS.md, README.md, PENDING.md, 독립 워커 runbook, 실제 페이지·서버 액션·API·도메인·스키마를 읽었다. 운영 서비스가 배포되어 있다는 현행 문서를 기준으로 삼았다. 사용자 중단 `product-intro-check`는 재개하지 않았다.
- **실행 검증 없음**: 브라우저, 기능 테스트, DB 조회, 외부 API/LLM 호출, 운영 쓰기, migration, 환경변수/비밀 읽기를 수행하지 않았다. 이 문서의 “구현”은 코드 경로 확인이며 운영 성공을 뜻하지 않는다.
- 저장소 파일 수정 없음. 결과물은 이 독립 메모뿐이다. 추정 경로 몇 개의 검색은 파일 부재로 실패했고, 이후 `rg --files`/실제 import 경로로 확인했다.
- P0: 공개 콘텐츠 문제를 접수·중단할 기본 경로의 공백. P1: 매일 또는 반복 운영에서 놓치거나 CLI/DB 수작업을 요구하는 공백. P2: 운영 수요가 확인될 때 확장할 편의 기능.

## 결론

수집→규칙→AI 1·2차→사람 결정→publisher, 그리고 발행분 감사→차단→해제는 이미 상당히 갖춰졌다. 목록·큐·CRUD를 새로 만드는 방향은 불필요하다. 1인 운영에서 우선 메워야 하는 것은 **현재 메뉴 사이에서 빠진 일의 접수와 조치 연결**이다.

1. 클레임된 제품은 현 신고 API에서 거부되므로 스팸·악성/잘못된 공개 콘텐츠 제보가 들어갈 기본 경로가 없다.
2. 최신 저장소 소실 자동 차단은 구현되어 있으나 “오늘 할 일”은 스팸 자동 차단만 확인한다. 자동으로 내려간 제품을 원인별로 찾고 복구하는 일의 연결이 빠졌다.
3. 발행 제품 이름/분류/일반 소개를 사람이 바로잡는 관리자 동선이 없다. 이름 확인은 CLI 계획·적용으로 끝나고, 소개 고치기는 기존 검수 또는 수정 요청이 있을 때만 가능하다.
4. 미디어, 메이커 업데이트, AI 제작 근거 단계, 다국어 제품 번역은 일부가 관측/자동화 또는 메이커 API에만 있어 운영자가 정확한 원인과 대상 항목을 확인·조치하기 어렵다.
5. 8시간 스타 급상승은 공개 reader에 회차와 실패 상태가 있으나 관리자에서는 일반 job 상태에 묻힌다. 시즌 방문 랭킹의 “급상승” 설정과 전혀 다른 계산인데 이름이 겹친다.

## 실제 메뉴와 기능별 상태

메뉴는 `app/(operator)/admin/AdminNav.tsx:11`의 “일하기”(오늘 할 일, 운영센터, 심사 큐, 내릴 후보, 피드백 검수, GitHub 연동, 제품)와 “설정·기록”(크롤, 카테고리, 근거 수집, 랭킹, AI 소식, GitHub 수집 계정, 작업 로그) 두 묶음이다. 아래의 “없음”은 검토한 관리자 페이지·액션·관련 API에서 해당 운영 경로를 찾지 못했다는 뜻이다.

| 기능 / 상태 | 현재 실제 동선·코드 근거 | 1인 운영의 판단과 남은 공백 | 우선순위 |
|---|---|---|---|
| 자동 발굴 / 구현 | `/admin` 검색 신호·범위·판정·심사 설정, 신호별 7일 수집/발행률(`app/(operator)/admin/page.tsx:40`, `:64`, `:105`). GitHub 저장소/커밋 검색→enqueue(`lib/crawl/jobs/seed.ts:258`, `:305`), Show HN→같은 frontier(`lib/crawl/jobs/hn-show.ts:115`, `:163`). 수집 즉시 스위치는 `/admin/status`(`status/actions.ts:59`). | 검색어를 늘릴 때 결과의 발행률을 보고 기존 신호를 조정할 수 있다. 커서·원본·중복 guard가 있어 재수집기를 새로 만들 이유가 없다. | 유지 |
| 운영자가 발견한 제품을 후보로 접수 / 없음 | frontier 도메인 `lib/crawl/repository.ts:57`는 enqueue를 제공하지만 관리자 메뉴/액션은 신호 편집·job 요청만 제공. 일반 등록은 메이커 `POST /api/products`(`app/api/products/route.ts:10`). | 개인이 찾은 유용한 저장소 하나를 등록하려고 신호를 넓히거나 메이커인 척 등록할 필요는 없다. 다만 자동 발굴로 충분하면 필수 기능이 아니다. 수요가 있으면 기존 enqueue를 쓰는 단일 GitHub URL 접수만 추가. CSV 대량 import는 아직 불필요. | P2 |
| 후보 심사 / 구현 | `/admin/review` 단계·갈래·AI 판정/2차표·검색·push 기간·정렬·CSV(`review/page.tsx:47`, `:98`, `:115`, `:181`). 한 화면에서 사이트/저장소·규칙 흔적·AI 근거와 직접 결정(`ReviewDetail.tsx:149`, `:224`, `:268`, `:330`, `:345`), 키보드/다음 행·선택 묶음(`ReviewConsole.tsx:147`, `:151`, `:175`). | 사람이 봐야 할 “직접 판단”, 두 모델 합의는 “확정만”으로 처리한다. 실패를 자동 거부로 둔갑시키지 않고, approve/reject 사유와 기록을 남긴다. 수동 hold/예약 결정을 반드시 추가할 이유는 확인하지 못했다. | 유지 |
| 심사 재수집·오래된 결정 방지·되돌리기 / 구현 | 원본/후보/input 해시를 함께 검사(`admin/actions.ts:173`, `:198`), 후보 추가 근거 요청은 자동 보류·최대2회(`ReviewDetail.tsx:65`, `:353`, `review/actions.ts:55`). 개별·일괄 undo(`review/actions.ts:160`, `:171`). | AI 재시도 소진은 사람에게 넘기고, 실행 요청 반복으로 상한을 무작정 초기화하지 않는다(runbook:451). 승인 실수·화면이 오래된 경우에 이미 안전한 복구 길이 있다. | 유지 |
| 발행 조건/예외 처리 / 구현 | 승인≠즉시 공개. publisher가 원본 변화·중복·차단·현재 심사·분류를 재검사(`lib/crawl/publish.ts:66`, `:78`, `:233`). 관리자가 “소개 없음” 후보에 직접 한 줄을 써 승인(`review/actions.ts:30`). 분류 실패는 `/admin/status?tab=manual`에서 사유와 category 지정→기존 publisher 요청(`status/ManualClassification.tsx:17`, `:48`, `lib/operations/categories.ts:34`). | 승인 후보를 모두 사람이 다시 등록하는 기능은 불필요. 자동 승인 최소 스타의 AI 우회는 명시된 기존 정책(`SettingsForm.tsx:189`, README:321), 운영자가 기준을 바꾼다면 다음 publish가 재확인한다. | 유지 |
| 분류 운영 / 부분 | `/admin/categories` 정의·include/exclude를 바꾸면 다음 분류에 적용(`categories/page.tsx:38`, `categories/actions.ts:21`). 수동 분류는 승인 후보 최대50건, 발행 완료는 제외(`status/ManualClassification.tsx:19`, `lib/operations/categories.ts:46`). | “이 공개 제품은 Dev가 아니라 Productivity”를 발견해도 관리자에서 제품 카테고리를 바꾸지 못한다. 정의 수정이 기존 제품 재분류를 뜻하지 않는다. 승인 후보 50건 안 검색도 전체 큐 검색으로 오인할 수 있다. 공개분 단건 교정은 기존 분류 경계/제품 generation을 재사용. | P1 |
| 이름·소개·기본정보 교정 / 부분 | 제품 찾기/상태·URL·repo 검색/스타 정렬/CSV(`products/page.tsx:56`, `:122`, `:133`). 이름 확인 필터는 제안·주의만 표시(`products/page.tsx:80`, `filters.ts:26`). 이름 적용은 CLI `scripts/normalize-product-names.ts:19`, 도메인 stale/name/source 검사(`name-review.ts:82`). 소개 고치기는 `needs_editor`인 지금 소개만(`intro-editor.ts:46`, `:57`) 또는 미클레임 소개 수정 요청이 있을 때(`intro-requests.ts:114`). 이름/description/category/stack/repo 등의 일반 PATCH는 메이커 edit token 필요(`manage.ts:8`, `app/api/products/[slug]/route.ts:85`). | 운영자가 공개 페이지에서 먼저 오표기를 발견하면 기존 검수 또는 외부 요청이 없을 때 고칠 수 없다. “이름 확인 필요”는 할 일을 보여주고 완료할 버튼이 없다. 미클레임 제품에 좁은 이름/한 줄 소개/카테고리 교정 폼부터 필요. 메이커 정보는 운영자 대신 신고값을 쓰지 말고 수정 요청 또는 항목 숨김으로 구분. URL은 소유권 기준이므로 기존 PATCH도 제외(`manage.ts:16`)—자유 URL 편집 추가 금지. | P1 |
| 링크·라이선스·저장소 메타 조회 / 구현, 조치 부분 | `/admin/products/[slug]` 선언/관측 관계·성공/실패/재시도·라이선스 충돌(`page.tsx:119`, `:130`, `:146`; `lib/domain/evidence/admin.ts:198`). `/admin/evidence`는 출처 주기·stale·retry 정책(`evidence/page.tsx:21`, `lib/domain/evidence/settings.ts:3`). 제품 강제 갱신 접수와 요청버전/진행/오류 표시(`products/[slug]/actions.ts:28`, `page.tsx:84`, `:87`; `refresh-requests.ts:51`). | 관측 라이선스를 수동 덮어써 “검증”한 것처럼 만드는 기능은 불필요하다. 충돌은 원문을 확인하고 재수집 또는 메이커 정정을 요청할 일. 다만 전체 제품 중 충돌/관계 미확인/오래된 실패 목록은 없어 제품을 알고 들어가야 보인다. 먼저 실패/충돌 필터와 출처 링크 연결을 재사용. | P1(조치 연결) |
| AI 제작 근거 단계 확인 / 부분 | 1/2/3단계·판 버전과 실제 PR/commit/file 증거는 있음(`ai-level-labels.ts:18`, `:36`; `ai-level-refresh.ts:287`). 공개 상세 reader는 level/clients/checkedAt만 내보냄(`ai-level-store.ts:13`, `:16`). 관리자 제품 상세는 maker agent/skill provenance만 조회(`evidence/admin.ts:125`, `:176`; `products/[slug]/page.tsx:181`), `repository_ai_levels`의 evidence를 로드하지 않는다. | “AI로 제작” 필터에 왜 들어갔는지 운영자가 해당 저장소의 기준 판·근거·실패/대기 상태를 UI에서 재현하지 못한다. AI 단계 숫자 수동 변경 기능보다 저장된 관측 evidence의 읽기 전용 표시와 기존 수집 재요청 연결이 먼저다. | P1 |
| 이미지/썸네일 / 부분 | 메이커 선언 API + 내부8개 보관·버전/visible(`app/api/products/[slug]/media/route.ts:25`, `lib/domain/media/repository.ts:104`). 관리자에는 URL/버전 텍스트만(`products/[slug]/page.tsx:161`)이며 미리보기·항목별 숨김·잘못된 썸네일 교정이 없다. fallback 썸네일 job/state가 있음(`thumbnails/repository.ts:7`, `:21`). | 잘못된 스크린샷·오래된 로고·문제 이미지 하나를 확인하려면 공개 화면에서 찾아야 하고 관리자 조치는 제품 전체 차단뿐이다. 기존 visible/source/version을 쓰는 미리보기+항목별 숨김/복원과 썸네일 재시도 접수가 적절하다. 원본 임의 업로드 CMS는 불필요. | P1 |
| 업데이트 관리 / 부분 | 상세에서 자동 감지 업데이트는 사유와 숨김/복원(`products/[slug]/page.tsx:172`, `actions.ts:51`; `evidence/admin.ts:88`). 메이커 updates POST/PATCH/DELETE는 maker API, 관리자 visibility는 명시적으로 `forbidden`(`evidence/admin.ts:102`). 관리자 조회는 title/sourceKind/visible만(`evidence/admin.ts:167`). | release/RSS 오탐은 기존 숨김으로 충분하지만 실제 메이커 게시글의 스팸·피싱 등을 개별 중단할 길은 없다. title만 보고 판단하기도 어렵다. 본문/원문/시각을 읽고 “운영자 숨김”을 메이커 삭제/편집과 별도로 유지해야 한다. | P1 |
| 번역 운영 / 부분 | 심사사유 원문/한국어 토글·진행/실패 이유(`review/page.tsx:165`, `status/TranslationFailures.tsx:28`)는 구현. 별도 제품 `en/zh-Hans/zh-Hant` demand ledger/text job/최대4회/backoff/CAS/fallback 있음(`products/translations.ts:111`, `:124`; `translation-policy.ts:59`; `lib/db/schema.ts:474`). 관리자 UI는 이 제품 번역 테이블을 조회/교정/재접수하지 않는다. | 새 다국어 화면에서 원문이 계속 보일 때 “아직 수요 없음/대기/4회 소진/원문 바뀜”과 부정확한 ready 번역을 한 제품에서 볼 수 없다. 제품 번역 카드와 실패 큐부터 필요. `reviewed`/editor provenance는 스키마에 있으나 수동 UI는 없으므로 재사용할 수 있다. 한국어 소개 검수 중단을 번역 복구 이유로 재개하면 안 된다(PENDING:150). | P1 |
| 목록·시즌 랭킹 / 구현 | 기본 목록 Profile 제외 정책 공유(`visibility.ts:9`, `repository.ts:144`), 생존 실패3회는 목록 조건 제외/회복시 자동 복귀(`health.ts:15`, `:27`). `/admin/ranking` 현/예약/취소/전후 비교, 다음 시즌부터 정책 적용(`ranking/actions.ts:17`, `ranking/page.tsx:63`). 경쟁 시즌은 verified만(`ranking/season-entries.ts:20`; README:541). | 제품 위치를 임의로 끌어올리는 수동 순위 CRUD는 기존 원칙과 맞지 않는다. 운영자는 현재 표시/제외 사유와 기준 시각을 확인하면 된다. 제품 상세는 상태만 있어서 Profile/down/repoGone/번역 준비 등의 “왜 안 보임”이 흩어져 있음. | P1(가시성 설명) |
| 8시간 스타 급상승 / 공개 구현, 관리자 부분 | KST00/08/16 관측(`star-observation-policy.ts:22`, `:26`), reader는 직전8h closed 회차 대비 비교, effective gain1/간격7~9h(`star-growth.ts:263`, `:274`), 동일 repoID/linkVersion·live safety 제외·증가량→스타→slug 정렬(`:171`, `:197`, `:245`), 상태/원인/분모/회차 DTO(`:55`, `:288`). `/admin/status` 일반 jobs에는 `product-star-observation`이 존재하지만 전용 회차 카드/감사 목록 없다. | `/admin/ranking`의 “급상승”은 방문/유입 시즌 trend(`ranking/page.tsx:54`, `RankingPolicyForm.tsx:339`)이고 `/admin#public` freshDays는 기존 stars row의 신선도(`SettingsForm.tsx:279`)—8h reader 기준이 아니다. 운영자가 비어 있는 홈을 보고 엉뚱한 값을 바꾸기 쉽다. 현재·기준 회차, target/success/failure/comparable/eligible, 다음 cutoff, 읽기 실패 원인을 공개 DTO로 관리자에 연결. | P1 |
| 발행분 재검수·감사 / 구현 | `/admin/products/recheck` 저장 원본으로 지금 규칙을 다시 계산하고 사람이 선택 차단(`recheck/page.tsx:45`, `:73`). `/admin/audit` 캠페인 시작/중단/재시작·AI reject/hold·단건 keep/remove·고확신 묶음 내리기·처리 기록/CSV(`audit/page.tsx:142`, `:155`; `audit/actions.ts:24`, `:47`). keep는 page가 같은 한90일 감사 제외(`audit/page.tsx:147`). | 전면 자동 삭제를 추가할 필요가 없다. 현재 사람의 확인과 되돌릴 차단을 유지. 캠페인을 새로 여는 것과 처리할 기존 finding을 구분하고, 정책 변경 후 원본 기반 재검수 vs AI 감사를 선택한다. | 유지 |
| 저장소 소실·이름 이동 / 최신 코드 부분 | 2026-10-13 정책은 공개 repo가 정말 gone이면 웹 생존 여부와 관계없이 내림, 이동 링크면 human(`repo-review.ts:7`, `:88`). job가 새 GitHub/페이지 확인→하루100건 자동 차단, operator keep는 보호(`repo-reviews.ts:29`, `:101`; `jobs/products/repo-review.ts:116`). 기존 제품 필터는 공개 status만(`products/filters.ts:35`); 웹만 review 행을 붙임(`products/page.tsx:74`). rename는 “repo_url 옛 이름 그대로” 관측만(`filters.ts:38`). | 현재 inbox/attention은 repoGone 공개 제품과 스팸 자동차단만. repo-gone 자동 차단은 banned 전체에서 이름을 알고 찾아야 한다(`inbox.ts:117`, `:189`; `dashboard.ts:366`). 이동한 설치형 후보의 review 상세는 목록에 안 붙고, 옮긴 repo를 확정/연결할 관리 UI도 없다. 새 정책 문구/전체 accessMode review 표시/자동 내림 확인 큐/검증된 이동 처리 필요. | P1 |
| 차단·복구 / 구현 | 목록⋯/제품 상세 BanAction은 사유·대상 확인→10초 undo·기록, 차단됨 필터에서 해제(`products/BanAction.tsx:26`, `:49`). 행을 남겨 URL 재등록/수집을 막고 해제시 verifiedAt/source로 상태 복구(`manage.ts:44`, `:74`). API DELETE admin도 물리삭제 아닌 ban(`app/api/admin/products/[slug]/route.ts:10`). | 관리자에게 휴지통/물리삭제 CRUD를 추가할 이유가 없다. 메이커 delete는 소유 데이터·흔적을 transaction에서 지우는 별도 의도(`manage.ts:31`), 관리자 복원 권한으로 바꾸지 않는다. 단 자동 차단 원인별 찾기/근거/해제 후 목록 자격 설명이 필요. | 유지+P1 연결 |
| 내려달라/소개 수정/악성 신고 / 미클레임 구현, 전체 신고 없음 | 공개 미클레임 상자의 takedown/intro request→`/admin/audit?tab=requests`→remove/dismiss,24h SLA·같은 보낸이/owner 묶기·burst 감시·이력(`TakedownQueue.tsx:37`, `:201`, `:272`; `takedown-view.ts:18`, `:26`). 접수 즉시 noindex/purge, intro 수정은 별도 큐이며 노출 유지(`takedown.ts:36`; `intro-requests.ts:18`). 그러나 owner뿐 아니라 `abuse`도 `isUnclaimed` 아니면 API가 거부(`takedown.ts:53`, `:57`), 공개 폼도 unclaimed만(`app/(public)/[locale]/(content)/p/[slug]/page.tsx:173`). | 소유 확인과 스팸·악성 제보는 다른 질문이다. verified/claimed 제품이 악성 주소로 바뀌거나 부적절한 메이커 글을 싣는 경우 사이트 안 접수 경로가 없다. 기존 요청 처리 UI를 재사용하되 abuse는 모든 공개 제품에 허용하고 소유자 삭제 요청/무조건 noindex는 기존 정책과 분리해야 한다. | P0 |
| 메이커 클레임·수정 키 운영 / 웹 구현, 설치형/지원 없음 | 웹 file/meta 도메인 검증과 seeded→claimed/새 edit token 발급 구현(`verify.ts:25`, `:82`, `:104`). 클레임 초대는 GitHub 새이슈 미리 채움→운영자가 직접 제출→보냈음 표시(`products/ProductRow.tsx:90`, `:98`, `claim-invite.ts:15`). 설치형 verify는 관리자에게 저장소 소유 확인 요청 안내만(`verify.ts:34`). 연락 링크 `/policy#contact`는 문장뿐(`policy/page.tsx:128`), requester 연락처를 받지 않는 소개/삭제폼이 전부. GitHub 일반 로그인/Feedback App OAuth는 제품 수정 자격이 아니고 Actor는 edit_token뿐(`actor.ts:16`, `:26`). | 설치형 주인이 소유 확인/수정 키 재발급을 요청·증명·수령할 안전한 동선이 없다. 연락하라고 안내하고 관리자 큐/응답 채널은 없다. 먼저 안내를 실제 가능한 소개/삭제 요청으로 정확히 고치고, 진짜 소유 확인 수요가 있으면 challenge 기반 소규모 지원 flow를 추가. 관리자가 메이커 주장만 보고 verified로 수동 승격하는 버튼은 부적절. | P1(안내/지원), P2(계정클레임) |
| AI 소식 / 구현, inbox 연결 부분 | `/admin/news` 공식 RSS/사이트맵/npm·출처별 성공/실패·approved/pending/hidden·일괄 게시/숨김·자동승인·수집 요청(`news/page.tsx:22`, `:75`; `news/actions.ts:18`, `:37`, `:53`). 출처는 코드 allowlist(`lib/news/sources.ts:50`). 홈은 news만 vendor 최신1개, release는 별도(`sources.ts:15`). | 게시 승인 수동 모드면 pending 글을 매일 별도 메뉴로 찾는다. 현재 inbox에는 news/feedback가 없음(`inbox.ts:24`). 기존 count를 inbox에 연결하면 충분. 출처·글 CRUD/수동 기사 편집은 공식 원문 링크 제품에 필요하지 않다. | P1(inbox 연결), 그 외 유지 |

## 혼자 하루 운영할 때의 실제 흐름

1. **첫 접속: `/admin/inbox` + `/admin/status`.** 먼저24시간 약속이 있는 내려달라는 요청을 본다. 같은 제품/owner/sender의 폭주 여부, 사이트/저장소와 기존 결과를 보고 remove 또는 dismiss 사유를 남긴다. 소개 수정은 별도로 읽고 고치기/처리함/둠을 고른다. 상태 숫자는 요청 접수가 아니라 실제 저장 진척과 대기 원인을 확인한다.
2. **심사 시간: 직접 판단→확정만.** 직접 판단 후보의 사이트·repo·원본·AI 표·규칙을 읽고 승인/거부/최대2회 추가 수집을 결정한다. no_description이면 이미 지은 소개와 원문을 비교하거나 직접 한 줄을 쓰고 승인한다. 같은 갈래의 합의 후보는 목록을 훑어 일괄 확정하고 예외 건은 개별 판단한다. 실수는 existing undo로 복구한다.
3. **승인했는데 발행이 없을 때: `/admin/status`와 수동 분류.** 분류 보류/backoff·publisher 적격 대기·실패를 구분한다. 분류만 막힌 후보는 기존 사유/카테고리 폼을 쓴다. “승인=즉시 발행”으로 보고 제품을 직접 insert하지 않는다.
4. **공개 목록 점검: 홈5개/급상승과 최근 등록, `/admin/products`.** 부정확한 이름/소개/분류·잘못된 이미지·중단된 주소를 확인한다. down은3회 실패 후 조건 숨김이며 정상 ping에서 저절로 돌아온다. repoGone은 최신 정책상 자동 차단 또는 human 예외가 있으므로 스팸 자동차단과 함께 검토해야 한다. 지금은 이름/분류 교정과 repo-gone 자동차단 확인이 끊긴 부분이다.
5. **제보/문제 콘텐츠 발생 즉시.** 기존 전체 제품 차단으로 페이지를 내리고 기록을 남길 수 있다. 하지만 claimed 제품의 abuse 접수, 문제 이미지 하나/메이커 업데이트 하나만 숨기는 길이 없어 전체 제품 차단과 수작업 사이에서 선택해야 한다. 제안 PR의 중심은 이 상황을 좁은 범위로 처리하게 만드는 것이다.
6. **마감: 그날 결정/자동 차단·미처리 건·발행 결과 확인.** `/admin/activity`, 제품 상세 history, `/admin/audit` 처리 기록을 활용한다. inbox의 “오늘 처리”는 심사 결정+takedown만(`inbox.ts:46`, `:198`)이므로 소개 교정·감사·피드백·소식까지 처리한 전체 업무량으로 읽지 않는다. 내일로 넘길 일의 건수/최장 대기와 업무시간 대비 순증을 확인한다.
7. **기준을 바꾼 날만** 신호별 발행률을 보고 크롤 설정을 바꾸고, 이미 발행된 것에 적용하려면 existing 재검수 또는 audit 캠페인을 연다. 랭킹 정책은 현 시즌을 보존하고 다음 시즌 예약으로 검토한다.

## 최소 필요한 PR 단위와 수용 기준

### C1. 전체 공개 제품 abuse 접수 — P0

- 기존 request 처리 페이지와 audit trail을 재사용. owner 삭제/소개 요청과 abuse 경계를 타입/정책에서 분명히 한다. 클레임 여부가 abuse 제보의 접수를 막지 않게 한다.
- 수용: seeded/verified/claimed 공개 제품에 abuse 접수 가능; banned/없는 제품은 적절한 응답; owner 무증명 삭제와 메이커 edit-token 직접 삭제는 기존 경계 유지; rate limit/dedupe/이력/운영자 판단 유지; abuse 접수만으로 자동 차단 또는 자동 noindex 정책을 임의 적용하지 않는다. 공개 제보 링크→inbox→사유/근거→결정→작업 로그가 연결되어야 한다.

### C2. 저장소 소실 자동 차단의 확인·복구 연결 — P1

- 기존 스팸 자동차단 칸을 “자동으로 내려감” 원인별 큐로 확장하거나 repo-gone 칸을 병합. 기존 productEvidenceAudit(actor/reason), BanAction/history를 재사용한다. installed/website 모두 review 판정·다른 repo 링크를 보여준다. 오래된 “AI가 자동으로 가리지 않음” 안내를 실제2026-10-13 정책에 맞춘다.
- 수용: 최근 auto:repo-gone 차단이 조회/집계·제품 필터·inbox에서 같은 수로 보임; banned만이어도 목록에서 사라지지 않음; 사유/시각/현재 repo/이동 근거/관련 링크가 보임; 해제는 기존 경로; restore 이후 down/Profile/repoGone 때문에 여전히 숨겨지면 이유를 설명. operator keep와 하루100건 한도는 유지. newest가 아니라 실제 미확인/확인 상태를 명확히 표현한다.

### C3. 미클레임 공개 제품의 좁은 교정 폼 — P1

- `/admin/products/[slug]`에 현재 값+교정 제안+이유+전후 preview. 이름/한 줄 소개/카테고리부터. `name-review`의 before 값 검사, 제품 generation, intro 교정의 search profile/keywords invalidation, audit logging을 재사용한다. 전체 profile/가격/팀을 운영자가 메이커 제공값처럼 바꾸는 CRUD는 제외한다.
- 수용: 현재 공개 미클레임에만 편집; 그 사이 클레임/차단/내용 변경이면 거부; old→new/actor/이유 기록과 복구; 이름확인 필터의 해당 건을 그 자리에서 해결; category 변경은 공개 facet/search/8h filter에 동일하게 반영; 소개/이름 변경은 sourceHash 기반 번역과 검색 재생성을 유효하게 처리. URL 자유편집은 제외.

### C4. 제품 근거 상세에 AI 단계·가시성 설명 연결 — P1

- 기존 상세에 current3단계, rulesVersion/headSha/checkedAt/error/pending, 저장된 PR·commit·file 근거를 읽기 전용으로 추가. 공개 경로의 배지를 임의 승인/수정하지 않는다. 현재 목록·랭킹·8h 자격을 한 제품에서 이유로 보여준다. 라이선스 충돌·관계미확인·출처 실패 필터는 기존 조회를 재사용한다.
- 수용: 공개 ai_level과 같은 repo/version의 근거; “검사 전/근거없음/오류/대기”를 구분; 실제 GitHub 원문 링크 제공; maker 신고 vs 관측값 라벨 유지; “왜 목록/시즌/8h에 없음”을 현재 status/down/Profile/repo/회차 기준으로 설명; 기존 refresh가 어떤 근거를 갱신하는지 범위를 명시하고 전혀 다른 job을 완료로 오인시키지 않는다.

### C5. 항목별 공개 콘텐츠 숨김과 내부 미디어 미리보기 — P1

- image/version/source/alt 및 update title/body/canonicalUrl/timestamp를 상세에서 볼 수 있게 한다. 메이커 값 수정과 운영자 hold를 별도로 둔다. media.visible/자동 업데이트 existing visibility 경계를 재사용하되 collector/메이커 수정이 운영자 hold를 부활시키지 않게 한다. 잘못된 thumbnail은 기존 worker에 대상 재시도만 접수.
- 수용: 한 이미지만 숨겨도 제품 유지; 자동/메이커 업데이트 모두 운영자 정책에 맞게 항목 숨김·복원 가능; 원문 자체는 삭제/대필하지 않음; 이유/대상/전후/actor 기록; 재수집/메이커 수정/버전 교체 후 숨김 유지 규칙 명확; 새 public 카드·상세/OG의 실제 참조를 검증.
- **코드상 별도 주의:** 현재 `/api/media/[hash]`는 visibility/status를 검사하지 않고 바이트를 제공하며1년 immutable cache(`lib/domain/media/http.ts:17`, `:23`; `postgres-storage.ts:25`). 제품 ban은 링크를 숨기지만 원본 hash 직접 접근을 회수하는 동작으로 볼 수 없다. 공개 중단 요구가 바이트 접근 회수까지 포함할 때 asset 단위 차단/새 응답 및 CDN 정책을 이 PR에서 분리 검토한다. 문제 콘텐츠가 존재한다는 증거나 실제 cache 검증은 없다.

### C6. 다국어 제품 번역 상태·실패 복구 — P1

- 제품 상세 번역 카드와 inbox/상태의 locale×field 실패/최종소진 연결. 이유 번역 화면에 제품 번역을 섞어 보여주지 않는다. 원문/hash·번역/provenance·모델·attempt/retryAt/error를 기존 ledger로 읽고 sourceHash/최종제어를 재사용한다.
- 수용: 현재 sourceHash와 일치한 번역만 표시/교정; stale source와4회 소진/too_long을 구분; 대상 재시도는 이유/기록이 있고 상한을 무제한 자동초기화하지 않음; editor reviewed가 machine보다 오래 유지되는 기준 명시; 원문 수정과 렌더 readiness/SEO 관계 검증; 한국어 소개 검수 잡을 자동 재개하지 않음.

### C7. 스타8h 회차 운영 카드 — P1

- `/admin/status`에 existing StarGrowthSnapshot/RunSummary를 이용한 읽기 전용 카드. “스타8h 관측”과 방문 시즌 trend의 메뉴·폼 이름을 분명히 구분. 정책 숫자 편집기 추가보다 현재 관측/지연 설명과 기존 job 링크가 먼저다.
- 수용: 현재/baseline cutoff·closed 상태·policyVersion·target/success/failure/comparable/eligible·최근 실제 관측/다음 cutoff·reader reason이 표시; missing/늦음/0개/필터0개의 구분; 홈/급상승 reader와 같은 숫자·기간/자격; 이미 닫힌 관측을 재작성/가짜 보간하지 않음; 8h 외 시간에 job 실행 요청해도 그 회차가 복원되는 것처럼 설명하지 않음.

### C8. 오늘 할 일의 누락 콘텐츠 연결·이름 정리 — P1

- existing inbox에 pending news(수동 승인 모드), 기존 피드백 검수 큐(다른 감사 담당 영역), 후보 수동분류/최종소진 번역 등을 정확한 조건에서 연결. 감사 hold/public-second 검토도 현재 human action이 열려 있다면 별도로 계수한다. 이름 확인 필요는 C3 완료 후 연결. 끝난 실제 사람 작업을 합산하거나 지표 명칭을 “심사·삭제요청 처리”로 좁힌다.
- 수용: badge/count/list/처리 화면 조건이 동일; 조회 실패는0으로 오인하지 않음; 급한순/오래된순 유지; 똑같은 제품의 여러 일이 “제품 수”처럼 합산되어 보이지 않음; 뉴스autoApprove면 매일 불필요한 승인 일 생성 없음. 모든 큐의 크기를0으로 만들려는 운영 목표를 강제하지 않는다.

### C9. 소유확인/수정 키 지원 안내, 필요시 단일 repo 접수 — P1/P2

- 먼저 `/policy#contact`를 요청 폼으로 오해하게 만드는 설치형/CLI불가 안내를 실제 현재 기능과 맞춘다(P1). 계정기반 클레임·키 재발급은 현재 actor 계약을 확장하는 별도 권한 PR(P2); 필요할 때 challenge와 본인에게만 결과 수령 경로를 갖추고 관리자 지원 큐를 연결한다. 운영자 발견 repo 접수는 C1~C8 뒤 수요가 있을 때 existing frontier enqueue만 재사용(P2).
- 수용: 사용자가 끝까지 할 수 있는 다음 행동과 관리자 도착 큐가 존재; 설치형 도메인 검증 우회/근거없는 verified 승격 불가; token이 URL/작업로그에 남지 않음; 소유 증명·권한이양·키회전/재발급의 audit와 stale 보호; repo 접수는 중복/기존ban/SSRF 정책을 유지하며 자동발행 우회 없음.

## 추가 검증이 필요한 것

- 위 기능의 실제 운영 DB 건수, 상태 시간, 최신8h 회차 성공률, 자동repo-gone 차단 이후 해제/재차단 동작, 브라우저 동선과 모바일 선택/확인/되돌리기는 실행하지 않았다.
- PR406 번역 ledger/text worker와 migration이 운영에 적용되었는지는 root의 별도 배포 검증 영역이다. 코드 존재만으로 운영 활성화·번역 품질을 판단하지 않았다.
- CDN purge의 미확인 이슈(PENDING.md:28), 실제 GitHub 로그인/스타/피드백 파일럿(PENDING.md:9), 중단 소개 검수(PENDING.md:150)는 기존 운영 제약이며 이 감사에서 해소하거나 재개하지 않았다.
- 테스트 명령을 실제 실행한 결과는 **없음**. 다음 구현의 수용 검사는 repo 단위/전용DB integration/브라우저를 해당 좁은 변경에 맞춰 수행해야 한다.

## 인계

- 현재 목적: 1인 관리자 운영에서 콘텐츠 기능의 현행 범위와 누락 동선을 읽기 전용으로 정리.
- 완료: 페이지→액션/API→도메인 확인, 최신repo-gone 자동 차단과 관리자 연결 불일치, 제한적교정/미디어/번역/AI근거/8h/신고/소유 지원 공백 정리.
- 수정 파일: 이 `/private/tmp/nomorevibe-admin-audit-content-20261013.md` 한 개. repo 변경 없음.
- 남은 일: root가 운영·고객/피드백 감사 결과와 통합, 중복PR 제거·정책상 priority 확정. 별도 구현은 승인 범위 밖.
- 다음 읽기 전용 명령:

```sh
cd /private/tmp/nomorevibe-i18n-integration-20261013
git rev-parse HEAD
cat /private/tmp/nomorevibe-admin-audit-content-20261013.md
nl -ba lib/domain/products/repo-reviews.ts
nl -ba lib/operations/inbox.ts
nl -ba 'app/(operator)/admin/products/[slug]/page.tsx'
nl -ba lib/domain/products/takedown.ts
```
