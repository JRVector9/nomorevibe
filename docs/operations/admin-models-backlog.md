## 2026-10-29 M1 경계 후속 — 코드 준비 완료 / 운영·병합 차단

재실행 확인(2026-10-29 07:43 UTC): 기존 구현·시험은 반복하지 않았다. GitHub API와 이번 명령에만 적용한 동일 저장소 HTTPS fetch로 최신 main `00aa00e3`를 대조했고 정상 merge는 Already up to date다. 일반 `git fetch origin`은 간격을 둔3회 모두 exit128/`Connection closed by UNKNOWN port 65535`로 실패했다. 영구 remote/SSH/인증 설정은 바꾸지 않았다. CI40835471662의 실패 job만1회 재요청한 attempt2도 scope/check가 실행 단계 없이 실패했으며 annotation은 동일한 계정 결제실패/사용한도 차단이다. 결제·한도·필수관문 변경 없음. 공개 health12회는 모두ok/dbok이며 m3-web·mini-web 둘 다199a3ebb다. M1 검토용 사본 조회와 M3 DB 측정용 SSH도 각각 간격을 둔3회 모두 exit255/같은 연결종료 오류였다. 따라서 이번 AI1·AI2/번역/새미확인/29877f65 현재 상태의 **신규 DB 측정 없음**. 아래07:23값은 이전 실행 실측이며 현재값으로 재사용하지 않는다. 사람의 M1 사본 생성 여부도 확인하지 못했다. 운영 쓰기/DRAIN/해제/모델 저장/마이그레이션/배포/새 모델 호출0, 원본 사용자 파일 변경0. main 병합은 필수CI 차단에 남아 있고 B~D도 그 선행조건에 막혔다.

- [PR721](https://github.com/JRVector9/nomorevibe/pull/721): 엄격한 교체 경계 단건 해제 CLI/0140 DB guard와 28ada57b 판 검증 스크립트를 준비했다. 원 장부 wire `0507685d…`와 relay `81d1f571…`를 당시 코드·일치 원문4개·gateway 변환·실제 HTTPX0.27.2 직렬화로 연결했다. 기존 ops-runner M1 수동 sudo/V1~V4 보호는 유지한다.
- 실제 검증: 범위103 unit PASS, verify-review-stall의339 TS+71 Python 및 typegen/tsc/lint exit0. 새 DB 회귀4개 CI PASS. 구현 head2fa095f6의 CI40833430125 attempt1은 모든 시험 job SUCCESS지만, 필수check는 GitHub 결제실패/사용한도 사유로 runner가 시작하지 못했다. 실패 job1회 재시도 attempt2도 같은 차단. **병합/배포 통과로 세지 않는다.** 실패 이력과 정확한 annotation은 review-stall-backlog 최신 절에 보존했다.
- 운영07:23:25Z PRIMARY READ ONLY: AI1 95603→95667, AI2 91774→91822(기존 서비스 자연 증가). 번역 완료16917→16917. 기존 M1미확인29877f65는 미해제/C40768/terminalNULL/감사없음. 새 Supa미확인65f8c399가06:33:07Z에 생겨 새미확인0→1, indeterminate합계2. 운영 DB 쓰기/모델 호출/해제/DRAIN/배포0, capacity OPEN epoch1/revision7.
- 운영 차단: 설치된 root 소유 M1 relay는 Qwen3.8만 허용하지만 현재 상류는 Gemma4 등이며 nativeCapacityReady=false/native_contract_invalid. `/var/nmvllm/native-readback.json` stat이 `Permission denied`. 사용자 sudo 중단 규칙을 지켜 수리/운영 적용을 중단했다. 원본 보존 사본을 사람이 만드는 명령은 review-stall-backlog 최신 절을 따른다. 결제·한도·권한·gate를 바꾸지 않았다.
- 공개 health12회 모두ok/dbok, 두 웹 모두199a3ebb. 원본에서 fetch 뒤 요청한 판 검증은 ancestry exit1, 아직 main에 없는 script는 exit127. 원본 사용자 변경은 보존했다. 준비된 스크립트를 병합 없이 원본에 덮어쓰지 않았다.
- 남음: 필수CI/병합과 사람 권한의 정식 M1 수리·Supa 종료 근거 해결 뒤 merged CLI dry-run/apply/감사→표준 배포/양웹 판 확인→운영 /admin/models 저장 버튼으로 Supa+[MLX] gpt-oss-120b 저장/감사/스크린샷→30분 각 모델1차 성공·AI1/AI2·번역 증가·새미확인0 실측. **이번 저장·저장 후 모델별 성공·UI 화면·30분 관측은 미실행**이다.

# 관리자 단계별 모델 작업 — 2026-10-29

기준: fetch 성공, origin/main a3094a73. 원래 허브 브랜치 xaegis/e1b30377의 다른 차선 변경은 보존하고 최신 main에서 전용 브랜치를 만들었다. 원본 사용자 폴더 변경 없음.

## 현재 상태 (정식 복구 실행기 PR #719 병합)

| 항목 | 현재 결과 |
| --- | --- |
| 1 저장 버튼 | PR #714 필수 CI 통과·main 77eadd1c 병합 |
| 2 단계별 모델 풀 | #713 병합 후 구현. PR #716 필수 CI 통과·main 9b316234 병합. 화면 판별은 실제 목적 모델 등록 전 선택 불가 |
| 3 실제 동작 확인 | HTTP 목록·시간/장부 실측 구현. 운영 primary READ ONLY SQL 확인 완료. 짧은 실제 호출·legacy 전체 이력은 정식 계약 부재로 남음 |
| 4 미확인·점유 | 장부 snapshot/발생·경과/그룹 점유·접수 상태 구현·로컬 시험 |
| 5 수동 복구 | PR #719 필수 CI 성공·main a4c1b759 병합. 정식 큐/prepare→run·V1 해제·native verify·역순 복원·버튼 구현/시험. 운영 설치·장비 드릴 별도 |
| 6 권한·감사 | 서버 admin/CAS/정식 감사 경로 사용·관련 범위 시험 |
| 실제 화면·배포 | 이번 실행에서도 Chromium socket 권한/Next 컴파일 오류로 클릭·스크린샷 미완료. 이 차선의 배포·운영 조작은 요청 범위 밖이며 실행하지 않음 |

## 착수 시 기록


- 저장 버튼: 기존 파란 관리자 주 버튼 토큰 적용, 성공·거절·동시 수정 충돌 표시, 네트워크 오류 시 결과 미확인 안내. 기존 saveSettings의 CAS와 감사 기록 경로 유지.
- 요청된 xaegis/88105c3c는 로컬 refs와 origin ls-remote에 없다. 같은 UI 변경을 최신 main 위에 직접 적용하는 최소 변경을 선택했다. 다른 브랜치 이력 재작성 없음.
- 최초 `npx --no-install vitest run admin-models`: 파일 없음으로 exit1. 새 범위 시험을 추가해 다시 검증한다.

## 착수 당시 남은 목록 (완료 여부는 위 현재 상태와 아래 최종 기록 기준)

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

- 40806263673 unit(1) 추가 실패도 확인: 공개 페이지 facade가 기존 resolver의 언어 판별 export를 불필요하게 요구한 것, generic runJob에 새 설정 조회를 넣은 것, 신규 연결 안내의 12px 문구가 저장소 최소 글자 기준에 맞지 않은 것. 실제 모델 handler 등록 경계(JOBS)로 범위 적용을 옮기고 generic runner는 기존 모습으로 복구했다. 번역할 필요 없는 공개 검색은 원 resolver로 바로 위임하고 안내를 13px로 고쳤다. 기존 실패 시험 파일/기대값은 바꾸지 않았다.
- 재검증: admin-models + 해당 공개 화면·deferral/replay·글자/UI·worker runtime 13파일154시험 PASS. 새 모델 handler는 실제 lease가 있는 진입점에서만 DB 풀 범위를 연다. unleased handler의 기존 거절 계약은 보존한다.

- 1a269841의 CI 40807436518은 모든 DB 묶음·build/typecheck/lint·unit(2)를 통과했고 unit(1)의 전역 쓰기 관문 소스 규칙에서 새 action 3개 형식을 거절했다. 실제 내부 runWebWrite 보호는 있었으나 저장소 표준의 export webWriteAction 형식으로 맞췄다. 전역 관문 시험의 정확한 등록 개수도 기존77→새 action3개를 더한80으로 갱신(guard 삭제·예외 추가 없음)한다. 새 시험 파일들은 모두 admin-models 이름이며, 이 기존 전역 guard 파일은 개수만 필요한 만큼 수정했다.
- 운영 SQL 실제 검증: 2026-10-29T02:41:06.994Z, M3 text 기존 연결에서 이 화면의 4개 SQL(기한 설정/제어/집계/요청)을 READ ONLY REPEATABLE READ로 실행. primary in_recovery=false/read_only=on, OPEN epoch1/revision7, 집계24줄/요청12줄. M1 요청29877f65는 indeterminate이고 로컬 종료 기록이 있으며 그대로 보존했다. 최근1시간 AI1 응답 종료는 Supa147/실패0/철회52, GPT-OSS0/실패0/철회0. 이는 배포 전 장부 관측이며 두 모델의 새 업무 성공·이번 코드의 배포 결과가 아니다.

## 기능 병합과 최종 남은 경계

- PR #716 최종 head1add0863, 필수 CI40808550518의 전체 선택 검사와 check SUCCESS. 2026-10-29 02:57:08 UTC main **9b31623417dfda4385f1fdba0dc2814c17047513**로 병합했다. PR #714와 합쳐 기능 변경은 main에 있다. 이미지 PR 빌드도 통과했으나 운영 배포 완료를 뜻하지 않는다.
- 준비된 변경: `/admin/models`의 파란 저장·충돌 피드백, 20개 모델 풀(기존 AI1/AI2 폼·분류 모델 검사/적용 포함), 장부 실측·미확인·점유·접수 제어, 복구 조건 확인과 실행 불가 사유. 20개 풀에는 감사/공개분/갈림/보류의 별도 선택, 한국어 소개 직접 모델, 화면 판별 등록 조건도 포함한다.
- LLM 보강 일반 풀은 uptime/repo_move/intro_recheck/news 작업의 검증된 backend를, 감사 풀은 decision_audit/semantic_exception을 처리한다. 작업의 적용 권한·검증 계약·기존 backend drain 설정은 별도이며 변경하지 않는다.
- 전체 모델 호출 추가 점검: **의미 검색 임베딩**(`embedding.ts`, bge-m3-f16@daec91ff,1024차원)과 **검색 결과 재정렬**(`hybrid-search.ts`)은 등록부 밖의 서버 적재 모델 API다. 이 두 단계도 화면에 상태·제약을 추가했다. 현재 API에는 호출자가 모델을 고르는 인자가 없으며, 임베딩은 모델 SHA/차원/전처리 및 최소32표본·코사인0.999의 기존 parity 검증이 필수다. 승인된 모델 등록/동일 공간 검증·색인 이전 계약 없이 임의 풀을 저장하거나 벡터를 섞지 않는다. 실제 재정렬 모델 식별자도 미확인으로 표시한다. 두 단계의 임의 추가·제거·저장은 이 계약이 제공되기 전까지 남음이다.
- 새 검색 모델 표시: admin-models-search-constraints.test.tsx 포함 완료 명령 **7파일36시험 PASS**, TypeScript/scoped ESLint/diff check PASS. 화면 클릭은 기존 Chromium/Next 환경 제한으로 계속 막힘이다.
- 배포 직전 키 재검사도 실제 수행: 같은 M3 Keychain 명령이 다시 `The specified item could not be found in the keychain.` / 원격 exit44. 표준 deploy scope/plan/run과 운영 설정 쓰기는 실행하지 않았다.
- GitHub 상태 조회 중 cafe.github.com allowlist 오류1회. 접속·인증 설정을 바꾸지 않고 동일 gh 조회를20초 후1회 다시 실행해 성공했다. 지속 차단이 아니다.

### 운영 완료로 남겨 둔 항목

1. 정식 수동 probe dispatch/종료 증거 계약이 제공된 뒤 짧은 실제 호출과 CLI 목록 검사.
2. legacy 경로까지 포함한 완전한 실패 이력 계량 계약(기록이 없는 과거를0으로 만들지 않음).
3. 승인된 prepare→run 종료 근거 수집/서비스·모델 stop·restore 실행기 연결, native stop의 exit_fact_missing_launchdUnloaded에 대한 실제 native verify 경로·시험. 현재 해제 버튼은 실행 불가이며 request·업무 기록·점유를 보존한다.
4. M1 sudo 종료·복원은 사람이 장비에서 수행. 29877f65 해제 시험은 하지 않는다.
5. 화면 판별의 실제 목적 모델 등록, 임베딩/재정렬의 모델 선택·색인 검증 계약.
6. 브라우저/Next dev 제한 해소 뒤 실제 저장·추가/제거·연결·미확인·복구 조건 창 클릭과 스크린샷·화면 품질 측정.
7. M3 Keychain 복구 뒤 표준 drain 배포, 운영 화면에서 Supa+GPT OSS 저장, 두 모델의 새 업무 성공을 운영 DB로 확인.

운영 배포0/운영 설정 저장0/unknown 해제0/유료 DeepSeek 호출0/권한 설정 변경0/SQL 초기화0. 원본 사용자 폴더의 변경과 미추적 파일은 보존했다.

## 사람 위임 풀의 활성화 검증 보완 (#717)

- 기본 DeepSeek만 확인하던 활성화 경로를 수정했다. 저장한 사람 위임 풀의 모든 모델을 실제 선택 범위에서 `/models`로 확인한 뒤 정식 setHumanReviewEnabled로 저장한다. 짧은 유료/추론 호출은 하지 않는다.
- 연결 확인과 저장 사이 풀이 바뀌면 잠근 설정 행에서 expectedModelPoolKeys를 비교해 거절하고 실패 감사 기록을 남긴다. 성공 기록에는 실제 선택 key·모델·장비·제공자를 남긴다. 끄기는 연결 미확인이어도 계속 허용한다. 모델 화면의 위임 제목/설명도 선택 풀을 가리킨다.
- `npx --no-install vitest run admin-models`: **9파일43시험 PASS**. 같은 범위에 기존 human-deepseek-review를 더한 **10파일73시험 PASS**. TypeScript noEmit/변경 파일 ESLint(--max-warnings 0)/PR 전체 diff check PASS. 브라우저 실행·스크린샷은 앞서 기록한 OS 권한/Next 네트워크 제한으로 미완료이며, 정적 렌더 시험을 실제 화면 확인으로 세지 않는다.
- #717 첫 검색 표시 head2a3917d9의 CI40810209449도 전체 필수 check SUCCESS. 이후 위임 풀 보완 head의 필수 CI를 다시 요구하며, 앞선 head의 성공을 새 head의 성공으로 사용하지 않는다.

## 2026-10-29 정식 ops-runner 차선 (이번 작업)

아래 기록은 위의 “정식 실행기 부재”라는 소스 차단 사유를 대체한다. 운영 설치·실측 완료를 뜻하지 않는다.

- 최신 origin/main `907b8df3`에서 전용 `feat/admin-models-ops-runner` 브랜치를 시작했다. 원본 `/home/ubuntu/projects/nomorevibe` 사용자 변경은 수정하지 않았다. 후속 main 변경은 정상 merge로 통합한다.
- 완료: 허용 목록의 네 명령만 받는 관리자 큐, 기존 append-only 감사 장부의 단계 checkpoint, private frozen profile 기반 별도 prepare→run CLI, Docker/systemd/M3 native 관측·종료·역순 복원 helper의 정식 소스 이관. 웹/maintenance에는 SSH·sudo·물리 실행 모듈을 주지 않는다.
- 완료: DRAIN → 종료/근거 → 기존 provider-boundary/V1 해제 → 동일 설정 복원/health → OPEN. 종료 근거 없음은 해제하지 않는다. native `exit_fact_missing_launchdUnloaded`는 verify만 재확인하며 실패하면 stop에서 멈춘다. M1/필요한 sudo는 DRAIN 전 사람 작업이다.
- 완료: `/admin/models`의 요청 종료·해제, 모델 재시작, 접수 중지/재개를 같은 명령 큐에 연결. 확인·사유 창, 2초 단계 조회, 중단 위치/이유, 관리자 서버 검사, 중복 제출 ID, 미완료 경계 중 OPEN 거절. 재시작에는 해제 단계가 없다.
- 완료: PR712 maintenance가 같은 `runModelOpsRunner`를 호출한다. 선언·enforcedAfter·기존 DB lock/근거 판정과 기본 비활성을 보존한다. 자동 분기는 장비를 멈추지 않고, 기존 종료 근거 해제와 같은 TX에 감사 결과를 쓴다. 운영 활성화는 하지 않았다.
- 검증: 동일 명령 `node node_modules/vitest/vitest.mjs run admin-models ops-runner`을 시작점 `907b8df3`의 scratch 사본과 현재 코드에서 실행: **9파일43시험 → 17파일82시험 PASS**. 기본 비활성·허용 목록·비관리자·근거 없음·native 재확인 성공/실패·수동 sudo·감사·중복/응답 유실·중간 stop/restore 실패 후 이어가기를 포함한다. 새 시험 파일명은 모두 ops-runner/admin-models를 포함한다.
- 실제 Python coordinator 시험은 SSH/장비 응답을 합성 자료로 대체하고 prepare→plan→stop→V1 영수증→역순 복원을 실행했다. 실제 V1 schema/시간·identity 검사를 통과했으며, 복원 중 ACK 유실 후에도 각 변이는 한 번이었다. 이는 운영 종료/복원 성공이 아니다.
- 기존 `bash scripts/verify-review-stall.sh`: **23파일339 TS 시험 + Python 범위 회귀 PASS**, typegen/TypeScript/scoped lint 포함 종료0. 초기 실행의 TypeScript 오류(NODE_ENV 타입)도 보존 후 수정했다. 최종 추가 범위는 pipeline-control/자동 회수/전역 web fence를 더해 **20파일128시험 PASS**. 접수 전환의 ACK hook이 읽기 전용 snapshot을 건드리지 않고 실제 전환·감사 TX에서만 실행되는 것도 검증했다. 전체 unit/전체 DB/종합 검사를 로컬에서 반복하지 않았다.
- 화면 막힘: 실제 fixture로 Next dev `127.0.0.1:43127 --webpack`은 Ready. `/admin/models`는 기존 instrumentation→Redis 경로에서 `Module not found: Can't resolve 'stream'`으로 HTTP502. 종료 과정에서 Next의 npm registry 접근도 allowlist 차단. 운영 페이지는 정확히 복원했다.
- 화면 막힘: 설치된 Chromium1248 실행은 `process_singleton_posix.cc:297 … socket() failed: Operation not permitted (1)` → SIGABRT, crashpad settings는 Read-only file system. 권한 변경/승인 우회 없이 중단했다. **실제 클릭·스크린샷·화면 품질 수치 측정 없음**. 정적 렌더의 버튼·단계·실패/사람 작업·미완료 OPEN 비활성 시험을 실제 화면 확인으로 세지 않는다.
- 남음: 브라우저/Next 환경이 허용된 곳에서 확인 창·진행·실패 화면 스크린샷, 승인된 별도 권한 영역에 새 장비 snapshot/프로필·실행기 설치, 실제 운영 종료·복원 드릴, 자동 회수의 운영 실측 후 별도 활성화. 예전의 probe/legacy 이력/임베딩·재정렬 계약도 이번 작업 범위 밖의 남은 일이다.
- 운영 배포0/운영 장비 접속·조작0/운영 DB 쓰기0/unknown 해제0/유료 DeepSeek 호출0/실행 권한 설정 변경0/SQL 초기화0/TTL 해제0/그룹 상한 우회0. 실행 계약과 프로필 형식은 [정식 실행기 문서](admin-models-ops-runner.md)를 따른다.
- PR [#719](https://github.com/JRVector9/nomorevibe/pull/719) **병합 완료**: 최종 head `c153565e5cf9eb14b16aae3c101a27b381882f59`, [CI 40821992110](https://github.com/JRVector9/nomorevibe/actions/runs/40821992110)의 unit/TypeScript/lint/build/DB 6묶음/장부/필수 `check` SUCCESS. 최신 base `da0d044a` 반영을 확인하고 2026-10-29 05:22:11 UTC 표준 merge로 main **a4c1b759c5d1e934e17a51fc428968e0a762321b**에 병합했다. force push/관리자 우회 없음. 앞선 draft 검사 실패와 새 head로 취소된 실행을 최종 성공으로 세지 않았다.
- 최종 로컬 검증: 범위 17파일82시험, 확대 20파일128시험, 기존 verify-review-stall의 23파일339 TS + Python71시험 통과. 검토를 위해 임시 프로필/장비 자료는 모두 합성 자료이며 운영 성공으로 세지 않는다.

- 어댑터가 성공 JSON을 출력했어도 프로세스가 비정상 종료/강제 종료되면 성공으로 받지 않는 검증을 추가했다. native의 구조화된 실패(JSON ok=false, exit1)는 계속 실패 근거로만 처리한다.

- 병합 뒤 남은 항목은 위의 화면 환경 제한, 별도 권한 영역의 운영 설치/새 프로필, 실제 운영 드릴/실측/활성화다. 코드·시험·PR·CI·기능 병합은 완료했으며 운영 배포 준비물은 저장소 실행기/문서뿐이다. 실행기 설치나 운영 배포를 완료했다고 기록하지 않는다.

## 2026-10-29 코드 전용 차선74afc085

M1 모델 선택/readiness 수정과 상품·사유 번역 동일 등록부 정렬 구현. 명시된 DB 풀/env는 보존. main typecheck PASS로 TS2353 재현 없음. M1 범위34시험 PASS, verify-model-config 첫35실패 fixture 원인을 보존하고 재검증 중. 대표 argv는 `2026-10-29-m1-relay-model-handoff.md`. 다음 항목은 Supa root 단계를 관리자 argv 준비/검증된 결과 수집으로 분리하는 구현이다. 운영·UI 변경 없음.
- M1 최종 검증: verify-model-config 69파일/988시험·typegen·tsc PASS, 모델 리터럴158→99. 범위 ESLint/installer bash 문법 PASS. Supa 구현 계속.

- 끝(코드): Supa provider의 명시적 rootHandoff. prepare에서 private 절대 argv/task 생성, 대표 관리자 root 실행 후 root 소유 결과+현재 전체 cgroup/old PID/boot/config/health 재검증, 기존 V1 해제·역순 복원·OPEN 경계 유지. sudo/DB 직접 해제/시간 기반 해제 없음.
- 실제 시험: 기존4파일/26시험 PASS, 새 분기 포함9파일/43 Vitest PASS(별도 실제 Python14시험 포함). root argv는 공개 감사에 넣지 않음. 대표 명령·설치/결과 소유권은 `2026-10-29-supa-root-handoff.md`.
- 남음: 최종 정적/모델 설정 검증·PR·필수 CI. 운영 설치/65f8c399 해제·M1 재시작/배포는 명시적 범위 밖이므로 미수행.
- Supa 최종 정적 검사: 범위 ESLint, tsc --noEmit --incremental false, git diff --check PASS. 실제 Python14시험 재실행 PASS. 항목별 로컬 커밋 후 PR 검증으로 계속한다.

- 최종 확장 검증: verify-model-config 72파일/1,032시험·typegen·tsc PASS, 동일 기준 git grep158→99. 추가 회귀7파일/64시험 및 실제 Python16시험 PASS. 최초35실패(공용 fixture), 추가 범위1실패(사유 timeout45→40초 fixture)는 고친 뒤 통과했으며 실패 로그를 보존한다. PR/CI 확인만 남음.

## PR722 최종 인계 — 2026-10-29

- 코드/시험/항목별 커밋 완료, 새 브랜치 push 및 PR https://github.com/JRVector9/nomorevibe/pull/722 OPEN. 대표용 절대 argv: `2026-10-29-m1-relay-model-handoff.md`(13줄), `2026-10-29-supa-root-handoff.md`(7줄 + prepare가 생성하는 실제 task).
- verify-model-config 72파일/1,032시험·typegen·tsc PASS. Supa9파일/43시험, 실제 Python16시험, 추가7파일/64시험 PASS(중복 포함). UI 변경/실제 장비 실행 없음.
- 막힘: Actions run40835749295 scope/check는 GitHub 계정 결제 실패 또는 spending limit으로 **잡 시작 전** 실패(annotation 확인). 나머지 코드 검사는 SKIPPED. 필수 CI 통과를 주장하지 않으며 병합하지 않음. 담당자의 Billing & plans 해결 뒤 CI 성공 확인만 남음. 결제·권한·워크플로 우회는 하지 않음.
- 최종 relay 모델 ID/KEY 충돌 거절 회귀 추가. verify-model-config 72파일/1,032시험·typegen·tsc 재실행 PASS. PR의 GitHub CI 계정 차단은 운영자 해결 대상으로 유지.
