# 규칙 전용 작업에 LLM 보강 — 인수인계 (2026-10-23)

> **2026-10-24 후속 확인:** 아래는 우선순위를 정한 최초 인계다. 최신 main에는 1번의 공통 후보 큐·Qwen 소비·최종 적용이 이미 병합돼 있다.
> 이번 작업에서 `unclear + retain`이 완료로 사라지는 누락을 재현·수정하고 두 생산 경로를 검증했다.
> [검증 결과와 남은 운영 단계](2026-10-24-uptime-confirmation-verification.md)를 먼저 읽는다. 기본 off와 실제 운영 활성화를 구분하며 운영 설정은 이번에 조회·변경하지 않았다.

LLM 없이 M3에서 규칙만으로 처리하는 작업 중, LLM을 붙이면 결과가 나아지는 곳을 검토했다. 아래 순서로 개발한다.
운영 변경(배포·DB 쓰기·차단 해제)은 매번 사용자 승인을 받는다. 보고·커밋·PR 글은 한국어로 쓴다.

## 측정한 사실 (2026-10-23 KST, 운영 DB 읽기 전용)

- 소개 검수(`product-intro-check`)는 M3 reviewer의 Claude CLI `sonnet`으로 정상 동작한다. 판정 3,290건 전부 sonnet, 오류 0.
  다만 `needs_editor` 107건(운영센터 "소개 확인 필요" 100건)은 10-14 이후 새로 생기지 않았고 사람이 처리하지 않았다.
- 연결 실패 자동 내림(`product-auto-ban-uptime`)은 최근 7일 337건이다. 마지막 응답은 404 167건, 접속 실패(0) 72건, 402 47건, 503 35건이다.
  10-23에 다시 열어 보니 **12건이 정상으로 열렸다(약 4%)**. 대부분 내릴 때 0·503이었고, onrender·fly.dev처럼 잠들었다 깨는 호스팅도 있었다.
  반대로 200인데 내용이 종료(`proofhand.dev` "has closed")·가짜 404(`fixel-skills…` "404 - Fixel")인 페이지도 있다. 상태 코드 규칙으로는 둘 다 못 가린다.
- 저장소 사라짐 확인(`product-repo-review`)의 사람 대기는 다음과 같다.
  - `repo_link_alive` 42건: 페이지가 다른 살아 있는 저장소를 가리킨다.
  - `page_unavailable` 86건: 대부분 200인데 판정할 만큼 읽지 못했다(잘림·체크포인트).
  - `delist_candidate` 40건.
  - 운영자는 7일간 513건을 일괄로 내렸다.
- 공개 사이트 표본 300곳을 열어 보니 제목 기준 종료·파킹 페이지는 0건이었다. 공개 사이트 전체를 LLM으로 상시 훑을 필요는 낮다.
- AI 소식 `news_items` 585건 중 한국어 제목은 0건이다.
- 썸네일은 공개 제품의 89%가 사이트 아이콘(15,001)이나 GitHub 아바타(8,332)이고, og 이미지는 2,074건이다.

## 할 일 (우선순위)

1. **연결 실패 자동 내림 직전 확인** — 가장 급하다(잘못 내림 4%).
   - 내리는 곳은 `lib/domain/products/uptime-auto-ban.ts`(`autoBanUptimeProduct`)다. 부르는 곳이 둘이다: 기존 방식 `lib/jobs/products/uptime.ts`, 분담 방식 `lib/domain/products/uptime-apply.ts`. **둘 다 같은 확인을 거치게 한다.**
   - 제안: 바로 내리지 말고 "내릴 후보"로 둔다. 확인 작업이 ① 긴 시간 제한으로 다시 열고(가능하면 Oracle 등 다른 네트워크) ② 200이면 LLM이 글을 읽어 `alive / closed / parked / soft_404 / unclear`로 가른다. closed·parked·soft_404·다시 실패만 내리고, unclear는 사람에게 보낸다.
   - 모델: Qwen 직접 서버 gpu3090(`lib/crawl/qwen-direct-review.ts`, 키 없음) 또는 abcllm gpt-oss-120b. maintenance 앱에는 모델 환경변수가 없을 수 있다 — `.claude/prod.sh env-names maintenance`로 확인하거나 확인 작업을 reviewer에 둔다.
   - 지킬 것: 401·403·429·999는 지금처럼 세지 않는다(사용자 결정 10-19). 관리자가 해제한 제품은 다시 내리지 않는다.
2. **저장소 옮김 판정**(`repo_link_alive`).
   - 코드: `lib/domain/products/repo-review.ts` `decideGoneRepository`, 작업 `lib/jobs/products/repo-review.ts`.
   - LLM이 옛 저장소 이름·제품 설명과 링크된 저장소의 README·설명을 비교한다. 같은 프로젝트면 저장소 주소를 고치고 유지(사람 확인 표시), 무관하면 `delist_candidate`, 애매하면 지금처럼 human이다.
   - 하루 내림 한도(`MAX_REPO_GONE_DELISTS_PER_DAY`)는 그대로 둔다.
3. **소개 `needs_editor` 재검수.**
   - 코드: `lib/domain/products/intro-check.ts`, `intro-checks.ts`.
   - README(이미 받아 둔 것)와 화면 서버(m1-studio, `lib/screen-review/`)로 그린 글을 근거에 더해, sonnet과 다른 모델로 한 번 더 묻는다.
   - 규칙(메이커 주장은 고치지 않음, 모르면 관리자)은 그대로다.
4. **자동 판정 표본 감사(새 작업).**
   - 주 1회 자동 결정(연결 실패 내림, 저장소 내림, 소개 교체)에서 표본을 뽑아, 결정과 다른 모델이 다시 판정한다. 엇갈린 것만 사람 큐로 보낸다. 결과는 운영센터 조치로 보인다.
5. **AI 소식 한국어 제목·요약**(제품 결정 뒤). `lib/news/refresh.ts`, 번역은 기존 `lib/jobs/products/translations.ts`의 gpt-oss 경로를 따른다.

보류: 썸네일 스크린샷(m1-studio 그리기 + 비전 검사). 처리량상 전체에 열흘 넘게 걸린다.
LLM이 필요 없는 것: 방문 집계·랭킹, CDN, 메일·알림, 스타, 검색 점검, 근거 스캔, 규칙 심사, 스팸 재검사(7일 자동 차단 0건).

## 사용자 결정 대기

자동 내림 중 지금 정상으로 열리는 12건을 복구(차단 해제)할지 정해야 한다. 승인 없이 풀지 않는다.
`blinkbox`, `ryan-kim`, `mc`, `product-401`, `webarkit-org-official-website`, `voisss`, `virtual-numbers-for-sms-verification-worldwide`,
`sitrep-3`, `cheapest-ai-model-api-prices-official-inference-providers-an`, `regen`, `shinychat-openrouter`, `operations-intelligence-workbench`.
애매한 1건: `world`(1.6KB, 제목 "world").

## 개발·배포 규칙

- 새 잡을 더하면 다음을 모두 맞춘다.
  - `lib/jobs/catalog.ts`.
  - `lib/operations/stage-registry.ts`(단계 또는 제외 사유 — 테스트가 막는다).
  - 운영센터 상세 창 문구 `app/(operator)/admin/status/work-owners.ts` `JOB_HOW`(테스트가 막는다).
  - 조치 칸에 맡은 작업 달기(`attention.tsx`의 `work`).
- 새 잡은 scheduler(git 빌드)를 먼저 배포하고 공통 릴리스를 돌린다. maintenance·text를 고치면 git 빌드 앱도 mini 예비 → M3 주 순서로 올린다.
- 공통 8앱 배포: `scripts/ops/deploy_shared_images.py plan|run`(자세한 것은 `docs/operations/independent-workers-runbook.md`). 실행에는 사용자 권한 허용이 필요하다.
- 규칙·재시도·시간 제한·판정 기준을 느슨하게 하지 않는다. 돌리지 않은 테스트를 통과로 적지 않는다. 운영 DB는 읽기 전용으로만 본다(`ssh jr@100.99.209.55 'sudo -n -u postgres psql …'`, `BEGIN READ ONLY`). 시각은 시간대 없는 UTC다.
