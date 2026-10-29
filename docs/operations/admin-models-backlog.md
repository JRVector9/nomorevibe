# 2026-10-29 현재 상태 — PR721 병합 / 운영 저장·배포는 sudo 단계 대기

- [PR721](https://github.com/JRVector9/nomorevibe/pull/721) 병합 완료: `c42dcb0b16e317132f4218172e27ed64c19b3260`(07:58:53Z). 구현 head5a5bbefc의 [CI40837650963](https://github.com/JRVector9/nomorevibe/actions/runs/40837650963)은 필수check/typecheck/lint/build/unit2묶음/DB6묶음/직렬장부/PR이미지 모두 SUCCESS다. 이전 결제·한도 미시작 실패는 아래 이력에 남겼으며 이번 실행의 성공으로 구분한다. 결제·한도·관문 설정은 변경하지 않았다.
- 원본 `/home/ubuntu/projects/nomorevibe`에서 최신main `bde9bcf7` fetch 후 `origin/main:scripts/ops/verify-prod-revision.sh` 존재 및00aa00e3 ancestry를 확인했다. 요청된 새 스크립트만 exclusive-create로 추가했고 main 및28ada57b와 바이트가 같다. 원본 HEAD edc56865/브랜치/기존 미추적9개는 그대로다. 기존 사용자 파일 덮어쓰기/원본 브랜치 전환/실행 비트 변경0.
- 원본 경로 실제 판 검사: 요청한 ancestry루프 exit1(`mini-web 199a3ebb68772f1ccbefd397172effce72029796 lacks 00aa00e3`); bash 검증 스크립트 exit1(`m3-web: release 199a3ebb… does not contain required commit 00aa00e3…`). 이전 script부재 exit127은 해소됐지만 **운영 release 목표는 미달**이다. 별도 health12회 모두ok/dbok, 두 웹 모두199a3ebb.
- 재실행 초반 남은 SSH wrapper가 없는 sandbox proxy를 호출해 Git3회/M1·M3각3회 연결종료였다. 승인된 전체권한 재실행은 proxy를 생성하지 않는 코드 경로임을 확인한 뒤 등록된 같은 호스트에 `/usr/bin/ssh -F /home/ubuntu/.ssh/config`로 기존 인증·host-key 검증을 유지해 읽기 접속을 복구했다. Git은 명령 단위 HTTPS와 기존 gh helper로 fetch/push했고 영구 remote/인증/SSH 설정은 변경하지 않았다.
- PRIMARY REPEATABLE READ READ ONLY 신규 실측07:56:02Z: AI1 **95667→95724**, AI2 **91822→91867**(이번 재실행 비교; 최초06:24 기준95603/91774). 기존 서비스의 자연 증가이며 배포/모델 저장 뒤 성과가 아니다. 번역 완료 **16917→16917**, 마지막 갱신10/28 07:01:54Z. 새미확인(최초기준)1건/Supa65f8c399, 기존M1포함 indeterminate총2로 이전과 같다. 당시 dispatched0, capacity OPEN epoch1/revision7.
- **현재 남은 차단은 M1 sudo 단계**: root readiness파일 stat은 `Permission denied`, 앞서 요청한 사용자 검토용 사본은 `No such file or directory`. 29877f65는 여전히indeterminate/C40768/terminalNULL/settled_atNULL이고 운영 해제 감사번호 없음. 사용자 sudo 중단 규칙에 따라 운영 migration/dry-run/apply/DRAIN/모델 저장/배포/새 모델POST를 실행하지 않았다.
- 사람이 M1에서 할 다음 한 줄(원본을 보존하는 검토용 사본 생성): `sudo /usr/bin/install -o jinwooro -g staff -m 600 /var/nmvllm/native-readback.json /Users/jinwooro/.local/share/nomorevibe-m1-translation-20261028/receipts-20261029/native-readback-review-49b91700.json`. 미실행이다. 이 사본 생성은 실제 모델 수리/해제/배포 완료가 아니다.
- main에는 [PR722](https://github.com/JRVector9/nomorevibe/pull/722)의 Gemma relay 모델/readiness와 Supa rootHandoff 코드도 들어왔다. 별도 차선의 파일·검증 이력은 보존했고 운영 설치/권한/정지·재시작은 하지 않았다. 해당 root argv 목록을 현재 사용자 규칙과 실제 snapshot 검토 없이 실행하지 않는다. Supa65f8c399의 실제 원격 종료 근거도 아직 없다.
- 남음(B~D): 사람 권한의 정식 M1 relay/readiness 수리 및 Supa 종료 근거→merged 단건 CLI의 정식 dry-run/apply·감사→표준 plan/deploy·OPEN·두 웹 판 exit0→/admin/models 버튼 정식 Supa+[MLX] 저장·감사·스크린샷·30분 모델별 성공/AI1·AI2/번역 증가/새미확인0 실측. 운영 DB 쓰기/해제/배포0이며 저장 후 모델별 성공·UI/30분 관측은 미측정이다.

---

아래는 각 실행 시점의 이전 기록이며 현재 상태는 위 절을 따른다.

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

## 2026-10-29 가독성·처리량 리디자인 (진행 중)

- 기준: 현재 브랜치에서 `git fetch origin && git merge origin/main`, main `00aa00e3` 통합. 이전 차선의 중복 충돌은 저장된 해결 결과가 main과 같음을 확인하고 정상 merge commit으로 보존했다.
- 완료: 실제 settled 종료·접수 시각으로 중앙값/nearest-rank p90/시간당 종료 건수/판정 가능한 종료의 실패율을 구하는 순수 함수. 1시간·24시간 모델별/단계별 집계, 빈 표본·종료 없음·1건·10/11건 p90·분모0·시간 경계 7시험 통과.
- 완료: 관측 SQL의 종료 이력을 최근24시간으로 제한하고 settled/withdrawn 시각 부분 인덱스 migration 0141 추가. 미확인·보류 등 열린 요청은 오래되어도 그대로 포함한다. 5만 종료 표본 상한 초과는 불완전한 집계 대신 관측 실패로 표시한다.
- 진행: 지금 상태 띠, 모델 카드·모델 내부 복구 버튼, 칩 설정과 변경 시만 저장, 30초 갱신, 렌더 회귀·화면 검수·PR/CI.
- 미실행: migration 적용·운영 쓰기·장비 조작·미확인 해제·배포 전부 0. 인덱스의 운영 query plan/DB 실측은 아직 검증하지 않았다.

### 리디자인 구현·검증 진행

- 완료: 맨 위 지금 상태(ADMIN_MODEL_STAGES20개 + 1차/2차), 미확인 경고와 카드 앵커, 장비별 모델 카드/점유/성공·실패/마지막 성공/연결 확인. 내부 route/group/budget/request ID는 기본 접힌 자세히 안에만 표시한다. 모바일 상태 띠는 2행 가로 스크롤, 카드는 모바일1열/데스크톱2~3열이다.
- 완료: 모델별 미확인·보류 블록, 시작·경과·영향 단계, 종료(정식 해제)·모델 재시작·공통 접수 중지/재개. 기존 ModelOpsPanel·prepare→run action을 재사용하고 확인 창·2초 진행·멈춘 단계·실제 감사 행 번호를 표시한다. Supa root/미등록 접근, M1 sudo는 비활성 사유를 표시한다. 다른 모델도 prepare의 실제 권한/프로필 검증을 그대로 거친다. 장비 종료나 TTL 해제 경로는 새로 만들지 않았다.
- 완료: 설정 바꾸기 영역으로 칩과 추가/× 제거를 분리. 검수 모델+20단계 풀을 기존 saveSettings 한 번의 CAS·감사 TX로 저장한다. 하단 고정 저장 버튼은 실제 변경 때만 활성화하고 변경 단계명을 요약한다. 프리셋을 자동 적용하거나 기존 Supa+추가 MLX 값을 덮어쓰지 않는다. 30초 관측 새로고침에도 편집 중 draft/CAS 버전은 보존한다.
- 완료: 카테고리 분류/검색/모델 등록부/다른 LLM 단계는 기본 접힘 참고 영역. 수동/30초 자동 새로고침과 관측 시각. 열린 확인 창 동안 자동 route refresh를 쉬고 닫힌 뒤 재개한다.
- 판정 기준: 접수 draining/disabled→접수 중지, 해당 단계의 모든 관측 그룹이 상한이고 미확인 있음→멈춤, 병렬 건강 모델이 남으면→미확인 N건. 대기·최근 실패·5분 이상 진행/예약→느림. 실제 성공/진행은 정상, 표본·관측 없음은 미확인. 이 판정은 종료·해제를 일으키지 않는다.
- 검증: 기준선 `node node_modules/vitest/vitest.mjs run admin-models ops-runner --maxWorkers=4` 17파일82시험 PASS → 구현 후 20파일107시험 PASS. `npx next typegen` 후 `npx tsc --noEmit` PASS, 범위 ESLint(--max-warnings0) PASS. 초기 tsc의 미생성 PageProps 오류와 기존 관측 시험의 바뀐 버튼 문구 실패를 확인 후 각각 typegen/새 문구 기대값으로 해결했다. 전체 unit/DB/종합 검사 반복하지 않았다.
- 화면 막힘(실제): 기본 Playwright가 chromium_headless_shell-1234 실행 파일 없음. 설치된 Chromium1248로 실행해도 `process_singleton_posix.cc:297 … socket() failed: Operation not permitted (1)` → SIGABRT, crashpad 설정은 Read-only file system. 권한 변경/승인 우회 없음. 실제 클릭·1440/390 스크린샷·화면 조판 품질 수치 **측정 없음**. 이 사유로 시각 검수 완료로 기록하지 않는다.
- 검토 자료: `node scripts/preview-admin-models.mjs <artifacts-dir>`로 실제 컴포넌트·생산 CSS·합성 Supa 미확인1/GPT OSS 정상/M1 미확인+sudo fixture의 1440/390 정적 HTML을 생성했다. HTML은 스크린샷/클릭 증거가 아니다. 앱의 인증 우회 경로나 공개 fixture route는 추가하지 않았다.
- 남음: 최종 코드 회귀·타입/정적 검사, PR/필수 CI. 환경 차단 남음: 브라우저 실행 가능한 환경에서 실제 클릭·스크린샷/잘림·정렬 확인, migration0141의 실제 DB query plan 검증. 운영 DB 조회/쓰기·접수 전환·재시작·해제·배포 모두 이번 작업에서는 하지 않았다.

### 화면 환경 차단 해소·최종 화면 검수

- 위 Chromium 전체 브라우저의 초기 실패는 보존한다. 이미 설치된 **전용 headless shell1248**은 추가 권한·설정 변경 없이 정상 실행됐다. 기본1234 실행 파일 부재를 설치나 OS 권한 변경으로 해결하지 않았다.
- 실제 React+생산 CSS의 고정 데이터 HTML을 Playwright에서 열고 1440px/390px 각각 실측했다. 문서 너비=뷰포트너비 **1440/1440, 390/390(가로 넘침0px)**, 모델 카드 **3열/1열**. 브라우저 page error0. 일반 Next/auth/실제 DB 통합 화면이 아닌 독립 고정 데이터 렌더 검증임을 구별한다.
- 실제 클릭: 수동 새로고침+30초 자동 새로고침(Playwright clock), Supa/M1 종료·재시작 비활성/사유, 내부 ID 접힘, 합성 연결 확인, 추가1차 칩 제거→저장 활성→저장 후 비활성, 단계 칩 추가/제거→원복 시 비활성, 한국어 확인 창·합성 접수·단계 진행·실패 위치·감사 번호를 모두 확인했다. 모든 action 응답은 fixture이고 운영 DB/장비 IO는 없다.
- 기획 자체 검수: 메뉴/화면 이름 ‘단계별 모델’ 일치, 수동/확인/취소·저장 단추 정렬, 모델 이름·장비·건당 통계·비활성 사유와 모바일 확인창을 캡처해 직접 확인했다. 관측 없는 단계 배지를 중립색으로 낮추고 실제 미확인만 빨강으로 강조했다. 모바일 고정 메뉴가 카드 제목을 덮는 문제를 발견해 앵커 여백112px로 수정했다. 저장바는 모바일에서도 한 줄 구조로 과도한 화면 점유를 줄였다.
- 결과 경로(작업 artifacts): `admin-models-1440.png`, `admin-models-390.png` 전체 화면과 각 `-first-screen.png`, `-model.png`, `-settings.png`, `-confirm.png`, `-progress.png`. `admin-models-browser-validation.json`에 실제 너비/열수·클릭 항목을 기록했다. `admin-models-1440.html`/`admin-models-390.html`은 독립 검토 자료다.
- 재현: `node scripts/preview-admin-models.mjs <artifacts-dir>`; `ADMIN_MODELS_CHROMIUM_PATH=<설치된 headless-shell 경로> node scripts/verify-admin-models-preview.mjs <artifacts-dir>`.
- 남음 정정: 브라우저 스크린샷/합성 클릭은 완료했다. 운영 DB query plan·migration0141 적용·실제 등록된 접근/프로필·운영 드릴·배포는 이 작업 범위 밖으로 계속 미실행이다. 실제 운영 화면의 현재 설정/장부 비교 조회도 수행하지 않았다.

### PR 준비 상태

- PR [#723](https://github.com/JRVector9/nomorevibe/pull/723), 현재 브랜치 `xaegis/1638b627`에 의미 단위 커밋(최신 main merge, 처리량, 화면/검수)을 보존하고 push했다. 강제 push/이력 재작성/다른 브랜치 편집 없음.
- 최종 품질 수치: 동일 범위 명령 `node node_modules/vitest/vitest.mjs run admin-models ops-runner --maxWorkers=4`의 **17파일82시험 → 20파일111시험 PASS**. 추가 stage-registry/model-registry-operator/operations-action-contract 범위까지 23파일208시험 PASS 뒤 미설정 모델 카드 방지1시험을 더했다. 타입 검사/범위 ESLint/diff check PASS. 전체 수동 unit/DB/종합 검사는 반복하지 않았다.
- 화면 수치: 최초 전체 Chromium 실행 실패로 측정 불가 → 전용 headless shell에서 **1440/390 가로 넘침0px, 3열/1열, page error0, 각10개 상호작용 검증 PASS**. 운영 화면의 이전 조판 수치는 측정하지 않았으며 추정하지 않는다.
- 선택 이유: 검수+단계 풀은 기존 경로로 한 번에 저장해 서로의 CAS 버전 충돌을 줄였다. p90은 nearest-rank, 시간은 장부 접수→종료(대기 포함), 24시간 시간당 건수는 종료 건수/24로 명시했다. 운영 모델 구성은 자동 프리셋으로 바꾸지 않았다.
- 배포 준비물: 웹 화면/집계 코드와 migration0141(읽기 범위용 인덱스). 실제 운영 적용·배포·DB 쓰기·DRAIN·재시작·미확인 해제는 수행하지 않았다. CI 결과와 병합 여부는 확인 후 덧붙인다.

### 구현 종료 기준과 최종 검증 범위

- 실제 AI1 장부의 `crawl-agent-review`를 ‘1차 검수’에 연결했다. 고정 자료도 이 실제 route 이름으로 바꿔 지금 상태/마지막 성공/미확인/단계별 처리량까지 같은 경로로 시험한다. 종료·재시작 버튼은 기존의 지원 제공자 범위를 넘겨 CLI 제공자에 활성화하지 않는다.
- 최종 범위 회귀는 **20파일111시험 PASS**, 확대 범위는 **23파일209시험 PASS**, 타입/정적 검사 PASS다. 최종 고정 데이터 브라우저 재실행도 두 크기에서 각10개 검증·page error0·가로 넘침0을 확인했다.
- 구현·회귀·고정 자료 화면 검수·커밋·push·PR 작성은 완료했다. 필수 CI와 병합의 최종 영수증은 PR #723 및 보고함 → 개발사항의 이 작업 완료 보고를 기준으로 확인한다. 이전 head에서 취소된 CI를 최종 성공으로 세지 않는다.
- 이 구역에서 실제로 남은 운영 확인: migration0141 적용 후 읽기 쿼리 plan/운영 화면 값 비교, 승인된 장비 접근/프로필 등록, 실제 종료·복원 드릴. 이 사용자 요청은 해당 운영 쓰기·배포·DRAIN·재시작·해제를 금지하므로 별도 담당자의 작업으로 남긴다. 화면 판별/임베딩·재정렬 계약 등 앞선 기록의 운영·모델 등록 과제도 자동 완료로 바꾸지 않는다.

- 최신 main PR721·722(`bde9bcf7`)를 정상 병합했다. 다른 차선의 운영 기록은 그대로 보존하고, migration 번호 충돌은 이 화면의 인덱스를 **0141**로 옮겨 해결했다. 0140 교체 경계 해제 migration은 변경하지 않았다.

### 최신 main 통합 후 재검증

- PR721·722의 M1/복구 변경과 migration0140은 그대로 보존했다. 인덱스 migration은 **0141**이다. 다른 차선의 `review-stall-backlog.md`는 main 내용을 그대로 받아 이 PR의 최종 차이가 없다.
- 같은 M1 그룹의 미확인이 상품 번역뿐 아니라 사유 번역 슬롯도 막으면 두 단계 모두 ‘멈춤·미확인 N건’을 표시한다. 다른 단계의 성공을 해당 단계의 마지막 성공으로 재사용하지 않는다. 공유 그룹 회귀1개를 추가했다.
- 실제 최종 범위: **21파일116시험 PASS**(최신 main의 ops-runner root 검증 포함), 확대 **24파일214시험 PASS**. 1440/390 Playwright 각10항목·오류0·가로 넘침0 재확인. 타입 검사·범위 ESLint·diff 검사도 다시 확인한다. 필수 CI 최종 결과/병합 영수증은 PR #723·개발사항 완료 보고로 남긴다.

### 기존 UI 기준 보완

- 앞선 CI40838781221의 unit(1)이 이번 보조 글자(10~12px)를 기존 `tests/ui-contract.test.ts`의 최소13px 규칙 위반으로 거절했다. 이번 변경으로 생긴 실패이며 기존 실패로 돌리지 않는다.
- 같은 검사 기준으로 실제 소스 위반 **24건 → 0건**. 화면 보조 글자를 모두13px 이상으로 올리고 작은 글자의 fg-3도 fg-2로 바꿨다. 기존 UI 기준을 낮추거나 예외를 추가하지 않았다.
- `node node_modules/vitest/vitest.mjs run admin-models ops-runner stage-registry model-registry-operator operations-action-contract ui-contract --maxWorkers=4`: **25파일219시험 PASS**. 타입/범위 ESLint/diff PASS. 최종13px 화면을 1440/390에서 다시 캡처·클릭해 가로 넘침0/3열·1열/page error0을 확인했다. 이 결과가 앞선214시험·작은 글자 화면 자료를 대체한다.
- 하단 참고 영역도 고정 저장바에 가리지 않도록 페이지 끝 여백을 확보했다. 실제 브라우저에서 참고 제목의 하단좌표가 저장바의 상단보다 위에 있음을 검사하고 펼치기까지 확인했다. 최종 검증은 두 크기에서 **각11항목**이다.
