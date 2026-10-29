# 관리자 단계별 모델 작업 — 2026-10-29

기준: fetch 성공, origin/main a3094a73. 원래 허브 브랜치 xaegis/e1b30377의 다른 차선 변경은 보존하고 최신 main에서 전용 브랜치를 만들었다. 원본 사용자 폴더 변경 없음.

## 완료·검증 중

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
