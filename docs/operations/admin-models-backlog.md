# 관리자 단계별 모델 작업 — 2026-10-29

기준: fetch 성공, origin/main a3094a73. 원래 허브 브랜치 xaegis/e1b30377의 다른 차선 변경은 보존하고 최신 main에서 전용 브랜치를 만들었다. 원본 사용자 폴더 변경 없음.

## 현재 상태 (후속 PR CI 검증 중)

| 항목 | 현재 결과 |
| --- | --- |
| 1 저장 버튼 | PR #714 필수 CI 통과·main 77eadd1c 병합 |
| 2 단계별 모델 풀 | #713 병합 후 구현·로컬 시험·커밋 완료, PR #716 CI 중. 화면 판별은 실제 목적 모델 등록 전 선택 불가 |
| 3 실제 동작 확인 | HTTP 목록·시간/장부 실측 구현. 짧은 실제 호출·legacy 전체 이력은 정식 계약 부재로 남음 |
| 4 미확인·점유 | 장부 snapshot/발생·경과/그룹 점유·접수 상태 구현·로컬 시험 |
| 5 수동 복구 | 조건 안내·실행 불가 버튼/M1 수동 작업 표시. 정식 prepare→run 실행기 연결 부재로 자동 종료·해제·재시작·native verify 미구현 |
| 6 권한·감사 | 서버 admin/CAS/정식 감사 경로 사용·관련 범위 시험 |
| 실제 화면·배포 | Chromium/Next dev 제한으로 클릭·스크린샷 미완료. M3 Keychain exit44로 배포·운영 설정/실측 미완료 |

## 착수 시 기록


- 저장 버튼: 기존 파란 관리자 주 버튼 토큰 적용, 성공·거절·동시 수정 충돌 표시, 네트워크 오류 시 결과 미확인 안내. 기존 saveSettings의 CAS와 감사 기록 경로 유지.
- 요청된 xaegis/88105c3c는 로컬 refs와 origin ls-remote에 없다. 같은 UI 변경을 최신 main 위에 직접 적용하는 최소 변경을 선택했다. 다른 브랜치 이력 재작성 없음.
- 최초 `npx --no-install vitest run admin-models`: 파일 없음으로 exit1. 새 범위 시험을 추가해 다시 검증한다.

## 남음

1. 저장 UI 브라우저 확인 → 단독 PR → 필수 CI → 병합.
2. 등록부 PR #713 (feat/model-config-registry) 병합 후 단계별 전체 모델 관리. 2026-10-29 최초 확인 OPEN. 해당 작업 파일 직접 변경 금지.
3. 모델 목록·시험 호출, 최근 1시간 DB 실측.
4. 미확인·보류·예약·진행·슬롯·접수 상태와 경과 시간.
5. 기존 prepare/run·provider-boundary 복구 경로, native verify 재확인, M1 수동 작업 안내.
6. 서버 admin 검사·감사 및 범위 회귀·타입·화면 검증, 후속 PR 병합.
7. 배포 직전 M3 Keychain 검사 → 있을 때만 표준 drain 배포·운영 설정·양 모델 성공 검증.

## 현재 환경 제한(실측)

- `docker ps --format '{{.Names}} {{.Ports}}'`: `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`. 로컬 DB 컨테이너를 시작할 수 없다. 권한 변경·승인 우회 없음.
- 지정 scratch 경로 mkdir: `mkdir: Read-only file system` (exit1). 지정 artifacts 디렉터리는 읽기 가능하지만 쓰기는 아직 성공하지 않았다. 큰 scratch 사본을 다른 경로에 만들지 않는다. 보고 도구의 인라인 artifact 첨부 경로를 사용할 수 있는지 확인한다.
- npm 설치 없음. 원본 node_modules는 읽기 전용으로 복사해 이 worktree 전용 설치본을 사용한다.

## 저장 버튼 검증 결과

- 범위 2파일 10시험 PASS (`vitest run admin-models tests/admin-review-models.test.tsx`), next typegen 성공, scoped ESLint 성공.
- Next dev를 127.0.0.1:43127에서 기동(Ready). `/admin/models`를 DB 없는 시험 페이지로 잠시 연결했으며 원래 페이지로 복원했다. 시험용 저장 함수만 주입하며 운영 저장 호출 없음.
- 브라우저 실행 실패: 기본 설치 요구 경로 chromium_headless_shell-1234 부재. 설치된 chromium-1248로 실행 시 `socket() failed: Operation not permitted (1)`, SIGABRT. OS 권한을 우회하지 않았으며 화면 클릭·스크린샷·화면 품질 측정은 미완료다.
- 지정 artifacts 경로 touch도 `Read-only file system`(exit1). 스크린샷 생성 자체가 실패했으므로 첨부할 이미지 없음.
- Next가 AGENTS.md 관리 블록 제목을 자동 갱신했다. 관리 블록 지침에 따라 함께 보존한다.

## 실측·접수 제어 구현 진행

- 새 admin-models-observation/repository: primary READ ONLY REPEATABLE READ, DB 시각 기준 최근1시간 응답 종료·철회, 판정 불가 종료 별도, 모델/그룹별 미확인·보류·예약·진행 중·점유·상한·발생/경과 표시. 과거 정책의 미확인도 보존. 조회 실패는 0건으로 보이지 않음.
- 새 LiveModels: 목록 확인 시간, 미확인 요청 복구 안내 창, 정식 runPipelineControl을 통한 접수 DRAIN/OPEN 확인·사유·진행·실패 사유. allowDeferredRoutes=false 고정. 서버 admin 검사, 실행 의도/결과 감사 기록.
- `npx --no-install vitest run admin-models`: 3파일20시험 PASS. scoped ESLint/TypeScript PASS. 화면은 앞서 확인한 OS socket 권한 제한으로 막힘.
- 저장 PR #714: 첫 CI 40801879041에서 변경 밖 host-aggregate-budget.test.ts:177의 heartbeat 시간 시험이 expected admitted=false / actual=true로 실패(그 외 unit/typecheck/lint/build·대부분 DB 검사 성공). 실패 잡만 같은 head에서 재실행(2차) 중. 원 실패 보존, 필수 검사 우회 없음.
- 등록부 PR #713: 다른 차선에서 CI 실패를 수정해 새 head a07f8bef로 검사 중. 이 차선에서 해당 파일을 바꾸지 않음.

## 정식 실행 계약이 없어 막힌 기능

- 수동 짧은 모델 호출: 기존 connect-agent test/probe는 versioned capacity 경로에서 manualModelAdmission으로 거절하며, 각 업무용 dispatch 계약에 임의 시험 업무를 넣을 수 없다. 별도 승인된 수동 probe 슬롯/종료 증거 계약이 없다. 현재 버튼은 모델 목록 조회만 실제 실행하고 짧은 호출의 차단 사유를 분리 표시한다. 유료 DeepSeek 호출 0.
- 자동 요청 종료·모델 재시작: 현재 추적 소스에는 provider-boundary 해제 라이브러리/CLI는 있지만, 10/29에 사용한 prepare→run 종료 근거 수집/서비스 종료·복원 실행기는 없다. 기존 recovery_gateway/native_recovery_gateway는 worker watchdog 제한 복구용이며 임의 모델 stop 권한이 없다. connect-agent RPC도 이 기능이 없다. 웹에 SSH·sudo 권한을 새로 주거나 임의 종료 receipt를 받는 우회는 하지 않는다. 복구 창은 시작 전 막힘과 원 요청 보존, native verify 필요, M1 장비 수동 작업을 표시한다. 자동 stop/해제·restore·native verify 실제 실행은 미구현/미검증.
- 배포 precheck 실제 실행: M3 `security find-generic-password -a deploy.brut.bot -s dokploy-api-key -w >/dev/null` → `security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.` / 원격 `keychain_exit=44`. SSH wrapper의 exit0을 성공으로 해석하지 않음. 키가 없으므로 배포0·운영 설정 저장0·양 모델 새 성공 확인0.

- 2026-10-29 01:52:58 UTC: 등록부 PR #713 필수 check SUCCESS로 main 병합 확인. 현재 실측 변경을 독립 커밋으로 보존한 뒤 최신 main을 merge하고 해당 등록부 위에서 2번 구현을 시작한다.

## 저장 PR 완료와 단계별 풀 구현

- PR #714는 최신 base 35ef739a에서 필수 check SUCCESS 후 2026-10-29 02:05:28 UTC main `77eadd1c`로 병합. 저장 head `2da5d29b`(원 변경 `3b6039b2`). 첫 CI 실패와 재실행 기록은 위에 보존. 이후 main을 작업 브랜치에 정상 merge했다.
- 등록부 #713 위에서 `stageModelPools`를 기존 crawl_settings JSON에 추가하고 saveSettings의 CAS/감사 경로로 저장한다. 이름·주소·제공자 정의는 등록부를 그대로 재사용한다. 선택이 어댑터나 실행 계약·물리 상한을 바꾸지 않는다.
- AsyncLocalStorage 범위에서 새 job lease/공개 검색 요청마다 모델을 한 번 배정한다. 같은 묶음에서는 wire·기록·용량 식별자가 같은 모델을 사용하고, 다른 동시 작업과 섞이지 않는다. 풀을 비우면 배포 기본값을 사용한다. 기존 전송·미확인은 기존 논리 키와 정식 용량 보호에 남으며 재배정 권한을 주지 않는다.
- 지원 선택: 사람 위임, Qwen 공통 기본, 발행분 Qwen 감사, 감사 두 번째 의견, 공개분 추가 검수, Qwen 갈림/보류 재검토, DeepSeek 갈림 재확인, 사유·제품 다국어·한국어 소개(게이트웨이/직접)·검색 질의 번역, 키워드/프로필 생성·검증, 수집 소개, 소개 검수, LLM 보강 일반/감사. AI1/추가AI1/AI2/예비AI2는 기존 정식 폼을 유지한다. 카테고리 분류는 기존 검사→적용 컴포넌트를 이 화면에도 제공한다.
- 화면 판별 선택/런타임 연결도 구현했으나 기본 등록부에는 screen-review 목적 모델이 없다. 해당 칸에 미등록 사유를 표시하며 비전 기능을 이름으로 추정해 선택지를 만들지 않는다. 기존 SCREEN_REVIEW_MODEL 설정은 보존한다.
- 모델 선택에 따라 요청 주소·토큰·클라이언트 상한도 등록부와 맞춘다. native는 기존 검증 계약의 endpoint/증거/정산 경로를 그대로 사용한다. 계약이 없으면 호출을 보류한다.
- 게이트웨이뿐 아니라 등록된 직접 HTTP 모델도 연결 버튼에서 bounded `/models` 조회·시간을 표시한다. CLI/짧은 시험 호출은 앞서 적은 정식 probe 계약 부재로 차단한다. 연결 확인 결과를 실제 시험 호출 성공으로 표시하지 않는다.

## 보존한 시험 실패와 수정

- 첫 확장 회귀 `verify-model-config`: 69파일 중 검색 번역 2파일22실패/963성공. 공개 검색의 낮은 계층에 새 설정 조회를 넣어 기존 native 회귀의 DB 경계와 singleflight 시험에 영향을 줬다. 조회를 실제 공개 페이지 호출 경계의 admin-models-search로 옮기고 낮은 계층 계약을 보존했다.
- 재검증 `bash scripts/verify-model-config.sh`: 69파일985시험 PASS, typegen/TypeScript PASS, 동일 모델 literal 측정158→99, 종료0. 추가 사람 위임/화면 판별 관련4파일54시험 PASS. 확장 admin-models 시험은 현재5파일32시험 PASS. 이후 최종 변경분은 다시 검증한다.
- 화면 검증은 OS socket 권한 제한으로 여전히 미완료이며 스크린샷 없음. 브라우저 제한을 우회하지 않는다. UI의 메뉴/확인 창 이름 일치와 불가 버튼 비활성은 코드·정적 렌더 검증만 수행했다.

## 여전히 막힘 / 완료로 기록하지 않는 것

- 모든 단계의 짧은 실제 시험 호출, 장부가 없는 legacy 경로까지의 완전한 실패 이력 계량, 자동 prepare→run 서비스/모델 종료·복원·재시작·native verify: 정식 실행/계량 계약·종료 근거 수집 연결 필요. 복구 창은 이 사유와 중단 위치를 표시하고 해제를 실행하지 않는다. native verify-stop 재확인의 실제 구현·시험도 아직 완료하지 않았다.
- 운영 M1 29877f65 해제시험0, TTL 해제0, SQL 초기화0, 상한 우회0, 실행권한 변경0, 유료 DeepSeek 호출0.
- 배포·운영 화면 저장·Supa/GPT OSS 양 모델 자연 성공 확인은 M3 Keychain exit44 때문에 막힘.

## 최종 소스 검증과 화면 환경 제한 추가

- 최종 범위 시험: `npx --no-install vitest run admin-models` 5파일33시험 PASS. TypeScript `node node_modules/typescript/bin/tsc --noEmit` PASS. 변경 파일 ESLint `--max-warnings 0` PASS(초기 미사용 import 경고2건도 수정).
- 실제 클라이언트 시험에서 사유 번역·프로필 생성·키워드 검증·소개 생성의 저장된 모델명/주소/토큰·시간 상한을 확인했다. 모델 선택 간 동시 실행 격리와 감사·공개분·보류 단계의 독립 범위도 시험했다. 이들은 시험 응답이며 운영 성공이 아니다.
- 기존 측정 방식 그대로 최신 origin/main 대비 모델 literal 줄 수 `99 → 99`(git grep 패턴은 verify-model-config.sh의 count_model_lines와 동일). 이 차선 회귀 파일 최초0(명령exit1) → 현재33시험 통과. 화면 품질 수치는 측정 없음: Chromium OS socket 권한 거부.
- 확대된 로컬 preview fixture도 실제 컴포넌트·시험 전용 server action으로 준비했다. 두 번째 Next dev 기동은 Next 내부의 npm registry 접근이 `Network access to "registry.npmjs.org" was blocked: domain is not on the allowlist for the current sandbox mode.`로 거절되어 로컬 SSR/브라우저 검증을 마치지 못했다. 의존성을 설치하거나 네트워크 제한을 우회하지 않았다. 임시 preview 페이지 연결은 실제 페이지 내용으로 정확히 복원했다.

- 후속 PR #716을 생성했다. 초기 head 43ce5422 / a5030746의 CI 40806021121·40806168506은 scope에서 `lib/operations/admin-models-observation.ts:57: new blank line at EOF`로 중단됐다. runtime 검사는 실행되지 않았으며 성공으로 기록하지 않는다. 작업 트리 diff만 확인해 앞선 관측 커밋의 공백을 놓친 것을 PR 전체 base diff 검사로 수정했다.

- #716 CI 40806263673의 첫 DB ledger는 1파일4시험 통과 후 product-translation-model-capacity 로드에서 `This module cannot be imported from a Client Component module. It should only be used from a Server Component.`로 실패했다. 공용 Node 워커 모듈에 둔 server-only 표식이 원인이었으며 제거했다. 새 admin-models-worker-runtime.test.ts가 실제 Node/tsx 자식 프로세스로 풀 모듈을 로드하는 경계를 검증한다. 현재 `vitest run admin-models` 6파일34시험 PASS. CI의 나머지 실패가 같은 원인인지 로그를 보존해 확인한다.
