# 1인 관리자 — 실측에 따른 최소 구현 계획

> 작성 2026-10-13. 기존 ADM01~16 감사는 제안 목록이며 현재 구현 완료 목록이 아니다. 이 계획은 main `b8147dc` 코드와 root의 운영 read-only 집계를 대조한 최종 범위다. gpt-6.1-sol / xhigh 담당 3명이 서로 다른 worktree에서 구현하고 root가 리뷰·통합한다.

**목표:** 혼자 운영할 때 이미 있는 기능을 안전하게 열고, 놓친 일을 발견하고, 필요한 조치를 끝낼 수 있게 한다.

**설계:** 기존 관리자 UI, HMAC 세션, DB 실패 제한, 댓글 상태, 번역 ledger, 역할 readiness, 자동 차단 감사, 닫힌 8시간 관측 reader를 재사용한다. 새 schema/RBAC/CMS/collector를 추가하지 않는다. Next16.3.8 설치 가이드에 맞춰 조회는 서버, 필요한 상호작용만 클라이언트로 둔다.

## 실제 운영 대조

2026-10-13 **15:50:44 KST**의 한 read-only transaction 기준이다. 계속 수집·번역하므로 이후 수치가 달라질 수 있다. 댓글 본문·이메일·계정명·세션·토큰·환경 전문은 읽기 결과에 포함하지 않았다.

| 측정 | 결과 | 개발 판단 |
|---|---|---|
| 공개 health / 관리자 진입 | health200, login200, status·feedback307→login, 관리자 OAuth503, 언어 접두 관리자404 | 현재 임시 우회 차단은 적용됐지만 정상 관리자 로그인과 private ingress는 아직 없다 |
| core 앱 설정 | 13개 `done`, 웹 mini2/M3 4, scheduler2; 웹707e9c2·워커b5924ac | 프런트와 백엔드 전체 SHA 일치를 강제하는 기존 경고는 잘못된 기준이다 |
| 관리자 설정 | 양웹 local0, password hash/ingress secret 미설정 | production local 금지 + 1인 로그인과 private 경계 필요. 코드 완료와 운영 설치를 분리 |
| 공개 계정·댓글 | 사용자1/GitHub identity1/유효 세션1, accepted2/held0/rejected0 | 공개글 사후 숨김은 필요. 새 계정 정지·삭제 관리 시스템은 보류 |
| GitHub feedback outbox | 0건 | 기존 재조회·위험 확인 재전송은 재사용. 오래된 문제 검색·복구 이력 확장은 보류 |
| 공개 번역 | ready116/pending2/failed53. en실패24, 간체15, 번체14 | 실패 조회·현재 원문 비교·제한 단건 재요청 필요. 자동 대기는 사람이 처리할 일로 합산하지 않음 |
| 번역 실패 원인 | 품질 검수45/time-out8; 4회 소진4 | 품질 탈락을 네트워크 실패로 표시하지 않고 상한·대기·원문 변경·too_long을 구분 |
| 자동 저장소 소실 차단 | 최근24시간2건, 현재 차단2건 | 기존 공개 제품만 보는 inbox에서 빠진 결과를 기존 제품 필터·차단 해제로 연결 |
| 내림/소개/뉴스 요청 | 내림 pending0(total1), 소개0, 뉴스 승인451/pending0 | 기존 경로 유지. 사용되지 않는 일반 문의·뉴스 큐를 이번에 새로 구축하지 않음 |
| 8시간 관측 | 마지막08시 target3703/성공3702/실패1, 직전00시3667/성공3667. 16시 회차3721/성공3721이어도 collecting·미마감 | 성공수만 보고 완료로 표시하지 않음. 공개 페이지와 동일한 닫힌 evidence를 진단 카드에 연결 |
| 소개 검수 | not_before2100, 미임대 | 사용자 중단 유지. 번역 화면/복구가 이를 재개하지 않음 |

운영 관리자 화면의 쓰기·로그인·외부 Issue 전송·실제 탈퇴는 시험하지 않았다. 공개 local 우회를 켜거나 실제 운영 DB를 수정하는 실측은 하지 않았다. 서버 CLI의 Tailscale 설치/Serve/ACL 및 private ingress 연결은 별도 설치 검증이 필요하다. 앱 상태 `done`만으로 모든 기능의 건강을 보증하지 않는다.

## 기존 16개 제안의 최종 판정

| 기존 | 이미 있는 것 / 과한 범위 | 이번 결정 |
|---|---|---|
| ADM01 | public local0 임시 차단만 적용. 코드에서production local=1 허용 위험 잔존 | PR01에서 private ingress proof + 영구 production 우회 금지 |
| ADM02 | HMAC·쿠키·실패 제한·OAuth 기반 있음, 요청한 ID/비밀번호 없음 | PR01에 통합. 신규 계정/RBAC 테이블 제외 |
| ADM03 | 역할 lease·readiness·웹 관측·조치 함수 있음 | PR02에서 unknown/stale/기대 개수/각 쌍 릴리스·배지 정확성만 교정 |
| ADM04 | inbox9칸·오래된 preview·조회 실패 구분 구현 | PR05에서 held댓글·번역실패·자동소실 결과만 연결. 자동 처리 중 backlog나 정상 최근100건을 사람 일로 만들지 않음 |
| ADM05 | held 승인/거절·감사·공개 가시성 구현 | PR03에서 세 상태 조회·공개 숨김/복원 추가. 계정 작성 정지·전체 세션 회수 보류 |
| ADM06 | 미클레임 내림/소개 요청 구현 | 보류. claimed abuse를 기존 내림 요청에 단순 허용하면 접수 즉시 noindex·번역 중단. 별도 종류/정책 설계와 실제 수요 필요 |
| ADM07 | locale3/field2 ledger·text worker·hashCAS·유한 재시도 구현 | PR04에서 실패/소진 조회·현재 원문 대조·상한 내 단건 재요청만 연결 |
| ADM08 | 하루100건 보호·operator keep·자동 차단/기존해제 구현 | PR05에서 auto:repo-gone 결과 필터·모든 accessMode 판정 조회·해제 후 미노출 사유 연결 |
| ADM09 | 소개 CLI·메이커 편집·기존 재검수·검색 기반 있음 | 일반 관리자 CMS는 보류. 이름/소개/분류 동시 편집·검색/번역 무효화는 이번 공백 해결보다 큼 |
| ADM10 | 제품별 근거 조회/갱신·자동 업데이트 숨김/복원과 감사 이미 구현. 재수집dedupe는 숨김을 덮어쓰지 않음 | 새로 만들지 않음. 메이커 글·미디어 hold/schema/asset회수 확장은 구체적 오노출 사례 발생 시 항목별 PR로 분리 |
| ADM11 | run/snapshot/8h정책/공개 reader 구현 | PR06에서 기존 reader를 운영 카드·작업 라벨에 연결. 새 관측 스케줄·테이블 없음 |
| ADM12 | monitor/classifier/활성job guard·PAT/App 안전 메타데이터 있음 | PR02에 표시·coverage·중단 안내만 통합. 새 감시자/재시도 체계 보류 |
| ADM13 | CAS·멱등·재조회·중복 위험 확인 재전송 구현 | 0outbox인 현재 보류. 복구 함수 다시 만들지 않음. 누적 문제 발생 시 기존 조회 검색·페이징·이력만 확장 |
| ADM14 | 공개 신원/세션·댓글/FK·외부 Issue가 각각 존재 | 계정 삭제/익명화는 보류. 보존·외부 게시·본인 확인 정책을 먼저 결정해야 하며 단순 DELETE는 부적절 |
| ADM15 | CLI 배포·상태·기존 runbook과 PENDING 증거 있음 | PR02에 링크/관측 범위 설명만 통합. 웹root 배포·백업 bridge/새 evidence table 보류 |
| ADM16 | 검색0건/p95/번역/제품클릭·1차비용 지표 구현 | 비용총계·일일요약·여정추적·단건repo접수는 수요별 보류. 미측정 비용을0으로 취급하지 않음 |

## 개발 PR과 파일 소유권

### PR01 — 관리자 private 경계와 1인 로그인 (access 담당)

- [x] `lib/auth/admin-access.ts`의 ingress·Origin·세션 검증을 proxy/currentAdmin/관리 API 모두 사용. production에서 local 플래그 무효. 공개·잘못된 proof는404.
- [x] `ADMIN_ORIGIN`, `ADMIN_INGRESS_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`로 단일 로그인. scrypt hash, DB 실패 제한, 정확한 Origin, 기존12h HttpOnly 쿠키·로그아웃 재사용. ID/hash 교체는 기존 비밀번호 세션 무효화.
- [x] 관리자 login, 관리자 OAuth/로그아웃·API, `lib/operations/admin-log.ts`, hash 생성 CLI·private 설치 runbook만 담당. 일반 user/maker 인증 유지.
- [x] header strip/overwrite, private proxy·Tailscale ACL·direct-origin firewall의 설치 경계를 문서화. Host/XFF/IP 주장만으로 허용하지 않음. 운영 설치 전 완료로 표기하지 않음.
- [x] root가 피드백·GitHub 복구·번역 action Origin을 공통 `adminOrigin()`에 연결. 담당은 공통 Origin 연결의 중복 편집 금지.

### PR02 — 운영 상태 정확성과 기존 안내 (ops 담당)

- [x] `app/(operator)/admin/status/*`, 관련 기존 상태 reader/model: null/unknown/stale 보존, 기대 m3-web/mini-web 두 관측·5역할과 모든 readiness reason→조치/배지.
- [x] 역할 주·예비끼리, 두 웹끼리 릴리스 일치 검사. 독립 프런트/백엔드 릴리스는 합쳐서 경고하지 않음. lease/만료/epoch 등 기존 읽기 표시.
- [x] 첫 PAT을 전체 풀 고갈로 부르는 문구 제거. 기존 safe metadata·stale/reset 활용. maintenance uptime /text기존4업무 /공개번역ledger의 coverage 구분.
- [x] 중단의 실제 범위·job접수와 처리완료 차이·외부 runbook 설명만 추가. monitor/workerguard/운영 중단 정책 재설계 없음.

### PR03 — 공개 댓글 사후 조치 (content 담당)

- [x] `admin/feedback/{page,actions}`, `lib/domain/feedback/{repository,review}`: 상태/검색/keyset조회, count와preview 동일 predicate.
- [x] 사유·expectedReviewState CAS·동일tx감사. product→binding(필요시)→outbox→feedback 잠금 순서 유지.
- [x] 숨길 때 queued/retry_wait만cancel. sending/uncertain/delivered는 그대로 남을 수 있음을 안내. 복원은 사이트공개만, 자동 외부 재전송 없음.

### PR04 — 공개 번역 실패 운영 (content 담당, PR03 뒤 별도 commit)

- [x] `admin/translations/{page,actions}`와 기존 ledger의 read/failure summary·bounded retry helper. locale/field/status/원문/hash/error/attempts/retryAt/eligibility를 확인.
- [x] 단건 retry는 현재 대상/hash/상태 CAS, attempts4상한·too_long·retryAt·품질 검수 유지. 같은 원문 상한을 초기화하지 않음. stale_source는 현재 원문 요청 경로 재사용.
- [x] 외부LLM 직접 호출·일괄 백필·별도worker·소개검수 재개 없음.

### PR05 — 기존 오늘 할 일·자동 내림 연결 (root)

- [x] `lib/operations/inbox.ts`, `admin/inbox/inbox-model.ts`, `AdminNav.tsx`에 PR03/04의 동일 queue helper와 자동소실 필터 연결. 조회 실패는0과 구분, 오래된5건 표시.
- [x] `lib/domain/products/repository.ts`, `admin/products/{filters,page}`, 관련 제품 상세에서 auto:repo-gone 감사의 최신 차단 결과 필터·현재 근거·기존해제 재사용. installable도 판정 조회.
- [x] 정상 자동번역pending/빈outbox/미사용뉴스를 새 사람 일로 추가하지 않음. 메뉴/상태 배지를 위해 같은 큰inbox전체를 매페이지 중복 조회하지 않음.

### PR06 — 닫힌 8시간 관측 운영 카드 (ops 담당, PR02 뒤 별도 commit)

- [x] 기존 `getStarGrowthPage({limit:0})` snapshot과 필요한 현재 runstatus 노출만 연결. T/T−8h, 성공/실패/비교가능, reader reason/다음마감을 async 진단 카드로 보여줌.
- [x] `lib/operations/contracts.ts` joblabel. 1분job tick과8시간관측마감을 구분. collecting중 성공수를closed로 간주하지 않음.

## 병렬·통합·검증

access/ops/content worktree는 각각 `/private/tmp/nomorevibe-admin-{access,ops,content}-essential-20261013`, root는 `/private/tmp/nomorevibe-admin-essential-integration-20261013`이다. 모두 baseb8147dc, node_modules symlink만 공유한다. 담당3은 root의 inbox/nav/docs/schema를 편집하지 않는다. status/action-links는 ops 소유이므로 root가 새 링크를 필요로 하면 담당 종료 후 통합한다. migration/package/deps 변경은 계획에 없다.

root는 각 담당 commit을 읽고, 인증 경계/Origin, 댓글 lock·CAS/외부 상태, 번역 source·상한, unknown 전달과 공유 predicate를 검토한다. 리뷰 수정 뒤 순서대로 cherry-pick하고 최종 sourcecheck를 실행한다. 사용자 수동 기능 시험 요청에 따라 새 E2E/대량 suite는 만들지 않는다. 필요한 보안 불변식과 기존 fixture/필수 CI는 실제 실행 결과만 기록한다.

```sh
cd /private/tmp/nomorevibe-admin-essential-integration-20261013
npx next typegen
npx tsc --noEmit
npm run check:i18n
npx vitest run tests/admin-local-login.test.ts tests/admin-navigation.test.tsx tests/admin-status-action-links.test.ts tests/operations-attention.test.tsx tests/admin-inbox.test.tsx tests/product-feedback.test.ts
git diff --check
git status --short --branch
# 담당별 scoped ESLint 및 관련 기존 translation/star/feedback fixture는 실제 변경 후 추가 실행.
# 운영 DB/환경 수정·migration·배포는 이번 실측/개발 완료를 뜻하지 않는다.
```

실제 ID/비밀번호 선택, private ingress/ACL 연결, 사용자 GitHub 댓글/외부전송 파일럿, 외부 경보 수신·복원 검증은 코드 체크와 별도다. PENDING의 미검증 항목을 코드 구현만으로 완료 처리하지 않는다.


## 구현·통합 리뷰 결과

2026-10-13 코드 구현과 관련 로컬 확인을 완료했다. 위 체크는 코드·설치 계약 문서의 완료이며 실제 Tailscale/자격 설치·운영 배포 완료를 뜻하지 않는다. 세 담당이 서로 다른 worktree에서 구현하고 root가 각 diff를 리뷰·통합했다. 최종 통합 읽기 리뷰도 3명이 병렬로 수행했으며 중요 잔여 문제를 발견하지 못했다.

| PR 단위 | integration의 로컬 commit | 구현 결과 |
|---|---|---|
| PR01 | `4914506` | private proof/production 우회 금지, 1인 ID·password, 실패 제한·자격 교체 시 세션 무효화, 설치 runbook |
| PR02 | `01d3649`, `1b3a2c9` | unknown/stale·기대 관측·각 release 쌍·readiness·안전한 토큰 메타데이터·관측 범위 안내 |
| PR03 | `5369e2d`, `cc4f384` | 세 상태·검색·정확한 cursor, 사유/CAS/감사, 공개 숨김·복원과 외부 상태 보존 |
| PR04 | `b7dea37`, `bce67aa` | 실패 ledger·현재 원문 비교, 상한/backoff/보류/CAS를 유지하는 단건 재요청 |
| PR05 | `67ce2c2` | held/failed/자동 소실 차단 inbox, 같은 수신 조건·count·preview, 설치형 판정·기존 복구 연결 |
| PR06 | `43c64b4`, `e333134` | 닫힌 8시간 관측 reader 카드·미마감 구분·실제 조치 화면 링크 |
| 공통 인증 연결 | `94a68f2` | 피드백·GitHub 복구·번역 action의 private Origin 검증 |

root 확인 결과:

- `next typegen`와 `tsc --noEmit --incremental false` 성공.
- `check:i18n`: 4 locales / 8 namespaces / 11 public pages 성공. 변경 범위 ESLint·`git diff --check` 성공.
- 기존 단위 13파일 **161사례**, 독립 local DB 통합 6파일 **76사례** 성공. 초기 테스트 mock 두 곳을 보완한 뒤 해당 파일을 재실행한 결과를 포함한다.
- `DATABASE_URL=postgres://build:build@localhost:5432/build npx next build --webpack` 성공. 별도 worktree의 외부 node_modules symlink 때문에 Turbopack이 거절한 경로를 지원되는 webpack 옵션으로 확인했다.
- 담당의 별도 local DB probe에서 댓글 CAS·대기 전송 취소·복원 시 재전송 없음·감사 rollback, 번역 attempt/backoff/4회 상한·보류·원문 변경·CAS/lease를 확인했다.

전체 GitHub CI·브라우저 수동 시험·실제 운영 로그인/관리 쓰기·외부 Issue 전송은 실행하지 않았다. 새 suite/E2E, migration, dependency, 별도 collector는 추가하지 않았다. 사용자 main의 미추적 산출물은 보존했다.

개발 브랜치는 `/private/tmp/nomorevibe-admin-essential-integration-20261013`의 `feat/admin-essential-integration-20261013`다. PR01~06은 개발 범위 번호이며 아직 GitHub PR 생성·원격 push·merge·운영 배포는 하지 않았다. 다음 운영 적용에는 정상 PR/최신 base의 필수 CI와 `admin-private-access.md`의 양 웹 설정·private proxy·Tailscale ACL·direct-origin 방화벽 검증이 필요하다. 공개 소개 검수 중단은 그대로 유지한다.
