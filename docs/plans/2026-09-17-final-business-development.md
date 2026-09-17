# NoMoreVibe 최종 사업안 개발 계획

기준: 사용자가 지정한 `docs/PT/NoMoreVibe_Business_Plan_Final.md` v1.0, 22개 장과 P01–P21. 화면 참고: `docs/PT/NoMoreVibe_Final/assets/01…13`. 14…19는 설명용 보드이며 서비스 화면으로 복제하지 않는다. 이미지와 본문 충돌 시 본문 우선. 작성: 2026-09-17.

## 목표와 이번 산출물

발견 → 무료 등록/관리 권한 확인 → 사용 과제 → 사람 피드백 → 메이커 답변/수정 → 재확인의 흐름을 만든다. 핵심 지표는 **주간 적격 비소유자 User Feedback을 받은 활성 Launch 제품 수**다. 에이전트 실행이나 외부 클릭은 사람 사용 수에 합산하지 않는다.

이번 브랜치 `feat/final-plan-design`은 **21개 화면 명세의 인터랙티브 디자인 구현**과 개발 계획을 제공한다. `/design` 아래에서 독립 실행한다. 예시 데이터는 상시 표시하고 입력/저장/상태 변경은 브라우저 로컬에만 남긴다. 운영 데이터·인증·크레딧·결제·외부 메시지·Agent 실행을 호출하지 않는다. 기존 메인/관리자/수집/검수 소스와 사용자의 미커밋 작업을 보존한다. 운영 배포나 main 병합은 이번 디자인 작업 범위가 아니다.

## 현재 코드와 차이

| 영역 | 현재 확인한 구현 | 추가 개발 |
|---|---|---|
| 제품 발견 | `lib/crawl/`, worker/scheduler, 수집·심사·발행·썸네일·별 증감 | Radar/Launches용 명시적 공개 상태와 사용 조건 |
| 제품 데이터 | `lib/db/schema.ts` products: source=skill/crawler, status=seeded/unverified/verified/banned | origin·claim_status·publication_status 분리. 기존 slug/ID/출처 유지 |
| 관리 권한 | `lib/domain/products/verify.ts` 파일/meta challenge, `maker-auth.ts` 수정 토큰 | 계정/팀/제품 멤버십, 대상·신청자·만료에 묶인 일회성 challenge, GitHub 저장소 권한, 충돌·회수·분쟁 |
| 로그인 | `lib/auth/session.ts`, `oauth.ts`, GitHub OAuth | 일반 참여자와 Agent principal 구분, 제품별 RBAC |
| 상세/출처/업데이트 | `app/p/[slug]`, `lib/domain/evidence/updates.ts`, provenance/updates API | 실제 피드백과 이슈·배포·재확인 관계. 기존 출처 데이터 재사용 |
| 피드백/미션 | 예산 연결 슬롯·테스트 세션·적격 심사 테이블 없음 | 과제/예약/제출/증거/출처/관계/심사 상태 |
| 크레딧 | 장부·예약·거래 테이블 없음 | 정수/불변 장부, 예약/정산/해제, 중복 방지, 운영 정정 |
| 유료/Agent | CLI는 내부 분류/심사 목적 | 결제·유료 보상·제품 테스트 실행을 새 기능으로 분리 |
| 운영 기반 | PostgreSQL/Drizzle, 7개 앱 운영과 CI 확인 기록 존재 | 기존 큐/감사 체계 재사용, 첨부 접근 제어와 알림 outbox 추가 |

`PENDING.md` 및 AGENTS의 “아직 미배포” 문구는 오래된 기록이다. 2026-09-17 배포 보고서와 저장소 상태를 기준으로 보며 이 계획에서 미배포 상태라고 가정하지 않는다. 이 문서는 운영 DB 재실사/사업 지표 실측 결과가 아니다.

## 반드시 지킬 정책

- 등록/관리 권한 확인/기본 공개 0C. 사용자가 먼저 남의 제품을 평가할 의무 없음.
- 예산이 사전 예약된 비소유자 User 미션만 적격 확정 시 +10C. 요청자 1건 15C, 차이 5C 소각. 수치는 버전 있는 파일럿 설정.
- 클릭/체류/가입/호평/Agent 제출은 사람 크레딧 지급 근거가 아님. 완료·일부 완료·막힘·접근 불가 모두 제출 가능.
- 공개·적격 심사·보상·개선 상태를 별도 관리. 메이커가 비판 의견의 보상을 결정하지 않음.
- 자동 API의 출처는 Agent로 고정. 문장 정리용 AI 사용 여부와 실제 수행 주체는 구분.
- L0 방문, L1 자기진술, L2 증거 검토, L3 제품 이벤트 확인. 확률 같은 임의 신뢰 점수 없음.
- 관리 권한은 법적 소유권 보증이 아님. 로그인만으로 Claim 통과 불가. 재Claim은 자동 이전 금지.
- 수정 배포와 재확인 완료 별도. GitHub 이슈 종료/커밋은 배포·해결의 증거로 자동 승격하지 않음.
- 기여 크레딧 판매/현금 교환/양도 없음. 유료 Sprint는 견적, 모집 수·호평 보장 없음.
- 원본 증거 비공개/제한 링크, 개인정보 최소 수집. 실제 Agent 실행은 허용 도메인·금지 행동·예산·격리 환경 확인 후 후속 단계.

## PR 단위 실행 순서

의존성: D0 → M1 → M2 → M3 → M4 → M5 → M6. 반복 개선 E1은 M6 이후, 유료 P1과 Agent A1은 각각 별도 출시 심사를 거친다. 기간은 담당 인력/인터뷰/파일럿 결과 없이는 확정하지 않는다.

| 단계/PR | 변경 대상과 범위 | 완료 기준 / 검사 |
|---|---|---|
| D0 디자인 (이번) | `app/design`, `components/design`, 디자인 전용 상태/데이터/CSS, 21화면 경로표, 브라우저 테스트 | 모든 경로·모바일·키보드·주요 폼·빈/오류/권한 상태 확인. 운영 API 호출 0 |
| M1 제품 수명주기 | `lib/db/product-lifecycle-schema.ts`, additive migration, `lib/domain/products/{repository,view,register}.ts`, 목록 API | 기존 products를 유지한 백필 dry-run과 표본 검토. verified를 자동 launched로 오판하지 않음. 새/기존 URL·검색·페이지네이션 회귀 |
| M2 계정·Claim | `lib/db/product-membership-schema.ts`, `lib/domain/claims/{challenge,verify,membership}.ts`, claims API | 제품×계정×대상×만료 일회성, 동시 Claim 충돌, fork/공유 호스팅 경계, SSRF/redirect, 팀 RBAC/회수 테스트 |
| M3 미션·테스트 | `lib/db/mission-schema.ts`, `lib/domain/missions/{reserve,release,eligibility}.ts`, `lib/domain/tests/`, reserve/test API | 잔여 슬롯 행 잠금, 자기제품/팀/중복 차단, 만료/재진입, 제출된 슬롯 보호, 접근 불가 제출. M4와 기능 플래그로 함께 공개 |
| M4 장부 | `lib/db/credit-schema.ts`, `lib/domain/credits/{ledger,reservation,settle,reconcile}.ts` | 요청 45C 예약→2건 정산30C→테스터20C/소각10C→15C해제 불변식. 중복 심사·동시 예약·부족 잔액·정정 역거래 통합 테스트. 현금 장부와 분리 |
| M5 증거·심사 | `lib/db/feedback-schema.ts`, `lib/domain/feedback/{submit,review,appeal}.ts`, private media storage, `/admin/review` | source/relationship/incentive/evidence 별도. Agent가 user API로 보상 불가. 보완·이의제기·감사. PNG/JPG 제한/민감 증거 ACL. 원자적 심사+M4정산 |
| M6 개선·알림 | `lib/domain/feedback/links.ts`, updates 기존 API 확장, notifications/outbox, dashboard | 답변→이슈→배포→재확인 E2E. outbox 실패 재시도/중복 수신. 메이커는 심사 결과 변경 불가 |
| E1 증거 강화 | usage events HMAC/time/replay, 선택적 GitHub issue/release 연결, 재테스트·매칭 | 위조/중복/제품 불일치 이벤트 거부. 명시적 동의 후 이슈 생성. 원문을 지시로 실행하지 않음 |
| P1 유료 파일럿 | 별도 payments/refunds/billing, 수동 Sprint 견적/운영, 구독은 재구매 검증 뒤 | 현금/포인트 분리, webhook 멱등, 모집 미달 환급/연장, 보상 사실 표시, 변동비 포함 공헌이익 확인 |
| A1 Agent 실행 | 별도 실행 worker/sandbox, service principals, agent_runs·evidence | 동의·도메인·계정·시간/비용 한도, 결제/삭제/실고객 데이터 변경 차단, 출처 고정. README 분석과 실행 결과 분리 |

마이그레이션은 `drizzle/`의 실제 다음 번호를 개발 시 확인한다. 이미 배포된 0035를 덮어쓰지 않는다. 각 PR은 스키마 호환→백필→읽기 전환→쓰기 전환 순서, 이전 앱과 호환되는 가산 변경, 플래그 비활성 롤백을 기본으로 한다. 크레딧 거래를 지우거나 잔액을 직접 맞추는 롤백은 하지 않는다.

## 화면 커버리지 (모두 `/design` 접두사)

| 명세 | 경로 | 구현할 화면/행동 |
|---|---|---|
| P01 | `/design` | 미니멀 히어로, Launches/Radar 각3개, 피드백 모집3개, 참여 안내 |
| P02 | `/launches` | 목록·검색·필터·정렬·저장 |
| P03 | `/radar` | 자동발견 안내·출처·확인 시각·저장·상세 |
| P04 | `/p/frameit` (각 제품 동적) | 소개/피드백/업데이트, User/Agent 분리, 이용 조건 |
| P05 | `/launch` | 4단계 입력, 초안 복원, 미리보기, 공개 전 관리 권한 안내 |
| P06 | `/p/agentdesk/claim` | 검증 수단/대상/검토 중, 법적 소유권과 구분 |
| P07 | `/p/notegen/test` | 과제/조건/보상/슬롯 안내, 테스트 시작 |
| P08 | `/tests/notegen/feedback` | 결과4종·질문3개·증거 범위·보완·심사 대기 |
| P09 | `/feedback/f1` | 원문·출처·확인·답변·개선 연결 |
| P10 | `/missions` | 과제/대상/준비물/+10C/참여 상태 |
| P11 | `/dashboard` | 할 일/피드백 목록·필터·상세, 상태 변경 |
| P12 | `/dashboard/products/frameit/updates/new` | 버전·본문·피드백 연결·배포/재확인 구분 |
| P13 | `/credits` | 가용/예약/대기, 거래 목록, 상태 필터 |
| P14 | `/credits/how-it-works` | 등록 무료/+10C/15C/예산 예약·소각·해제 |
| P15 | `/sprints/new` | 커뮤니티/견적 구분, 조건/수량/기간/15C 계산 |
| P16 | `/sprints/demo` | 슬롯 진행·예약 예산·User/Agent 탭·예약 해제 |
| P17 | `/dashboard/agent-runs` | 허용 범위·금지 행동·시간/비용·실행 상태(실행 안 함) |
| P18 | `/pricing`, `/settings/billing` | 무료/유료 파일럿 구분, 확정되지 않은 요금 판매 안 함 |
| P19 | `/me`, `/notifications` | 저장/참여·기여·상태 알림·읽음 |
| P20 | `/trust`, `/appeals/demo` | 신뢰 수준/신고·이의제기 사유·처리 상태 |
| P21 | `/admin/review` | 원본/기준/사유, 품질 검토·적격/보완 모의 처리 |

## 구현 구조와 상태

- `components/design/data.ts`: 문서 시안에서 가져온 명시적 예시 제품/피드백 및 경로 registry. 실제 통계처럼 사용하는 금지값 없음.
- `components/design/store.ts`: 디자인 전용 localStorage 모델, 순수 reducer, 예산/중복/Agent 보상 제외를 보여주는 모의 전이. 실제 정산/권한을 보장하는 서버 구현으로 간주하지 않는다.
- `components/design/{Shell,ui,Discovery,Product,Participation,Maker,Account,DesignRouter}.tsx`: 화면 책임별 분리.
- `app/design/[[...path]]/page.tsx`: params await, 등록 경로만 허용, noindex. CSS는 `.nmv-design` 안으로 제한.
- 루트의 기존 chrome은 디자인 경로에서만 렌더링 제외하는 작은 client 경계를 사용. 기존 페이지의 구성 보존.
- 로컬 저장이 차단되면 저장 불가 안내, 예시 데이터 리셋은 해당 키만 삭제. 브라우저 전체 storage 초기화 금지.
- 화면 검토용 상태 선택: loading/empty/error/forbidden/partial/stale/pending. 상태에서 정상 복귀 가능.

## 검증과 출시 게이트

이번: 타입/ESLint/build, 순수 상태 전이 테스트(중복 보상·자기제품·예약 부족·해제), Playwright 21명세 경로 직접 진입/주요흐름/390px/1440px/console/가로 넘침, 캡처를 직접 비교한다. 테스트를 실행한 뒤 결과를 별도 보고서에 기록한다.

MVP: 20–30개 파일럿 제품은 목표치이며 실적이 아니다. 담당자/과제/접근경로가 있는 메이커부터 수동 검토로 시작한다. 첫 피드백 시간, 28일3명 적격 비율, 응답/개선 연결/재확인, 타깃 비메이커 비중을 구분해 측정한다. 부정 평가 보상 편향·대기시간·증거 수집 부담을 확인한다. 인터뷰·법률 검토·결제 원가·제품 이벤트 동의는 화면 구현만으로 완료됐다고 하지 않는다.

이벤트: product_viewed → test_started → mission_reserved → feedback_submitted → feedback_qualified → credit_awarded → maker_replied → update_published → fix_reconfirmed. 원문/개인정보를 분석 이벤트에 복제하지 않는다. 외부 클릭과 테스트 완료를 합치지 않는다.
