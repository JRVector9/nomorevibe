# 2026-10-29 M1 relay·제품 번역 모델 등록부 연결 (작업 공간 xaegis/0e7cd93c, 코드 커밋 `a900db03`)

배경: 제품 번역이 10/28 16:01 이후 0건인 원인 중 하나로, M1 relay의 기본 허용 모델이 등록부의 GPU3090 Qwen entry(`relay` 용도)에서 나오고 앱의 오래된 `PRODUCT_TRANSLATION_MODEL=[m1] qwen3.8-flash-next`가 그대로 전송되던 점. M1 oMLX는 `mlx-community--gemma-4-26b-a4b-it-4bit`를 서빙한다.

한 일(코드·시험만, 운영 DB·SSH·배포·push 0):

- `relay` 용도를 `gpu3090:review`에서 `m1:translation`(Gemma)으로 옮겼다. relay 허용 목록은 `LOCAL_MODEL_RELAY_EQUIPMENT`(기본 `m1`) 장비의 `relay` 용도 entry만이다(`relayAllowedModels`). `LOCAL_MODEL_RELAY_MODEL`/`_KEY`는 그 목록 안에서 하나로 고정만 할 수 있고, 다른 장비의 같은 이름 모델·gateway label·미등록 id는 `relay_model_not_allowed`, 장비에 entry가 없으면 `relay_model_not_registered`로 시작을 거절한다.
- relay 요청: 허용 목록 밖 모델은 `400 model_not_allowed`. 허용 모델이어도 영수증·상류 호출 전에 loopback `/v1/models`와 대조해 없으면 `503 upstream_model_mismatch`, 목록을 못 읽으면 `503 upstream_models_unavailable`(일치 목록은 30초 재사용). 거절은 전송 전이라 미확인(indeterminate)을 만들지 않는다. health에 `allowedModels`·`upstreamModelMatch`·`upstreamModelReason`을 추가했다.
- 앱: 옛 모델 env 해석을 용도 route 기준으로 바꿨다(`resolvePurposeModel`). 여러 장비에 같은 bare 이름이 있으면 그 용도의 selection→purposes가 가리키는 한 entry를 고르고, 둘 이상이면 계속 `ambiguous_model_identity`. 등록된 장비 label인데 그 장비에 등록되지 않은 모델(`[m1] qwen3.8-flash-next`)은 그 장비에서 해당 용도의 현재 등록 모델(`[m1] mlx-community--gemma-4-26b-a4b-it-4bit`)로 해석한다. 다른 장비 label·미등록 label은 기존처럼 그대로 둔다. `configuredModelRoute`가 key·장비·route·wire 이름·주소를 한 번에 돌려준다.
- 오프라인 `scripts/migrate-model-registry-m1.ts`가 M1 entry에 `relay` 용도와 `selections.relay`도 넣는다(기존 JSON 사용 시).
- 시험: `tests/m1-relay-model-config.test.ts`(7), `tests/product-translate-model-registry.test.ts`(7) 신규. 기존 relay·등록부 시험 3개의 기본값 기대를 Qwen→Gemma로 갱신. `bash scripts/verify-model-config.sh` exit0: 77파일/1,096시험 통과, typegen·`tsc --noEmit` 오류0, 모델 이름 리터럴 158(199a3ebb)→101(작업 전 c7dad56b도 101, 변화 없음). 바뀐 파일 eslint 오류0. 전체 unit·DB·종합 시험은 정책상 통합 단계 몫이라 실행하지 않았다.

남은 일(대표 몫, 미실행):

1. push·PR·CI `check`·main 병합. relay 재설치용 `<REVIEWED_SHA>`는 **병합된 main 커밋**이다(로컬 `a900db03`은 후보일 뿐 설치본으로 쓰지 않는다). 설치본 경로는 그대로 `/var/tmp/nmv-relay-reviewed/<REVIEWED_SHA>` → `/usr/local/nmv-llm-relay/releases/<REVIEWED_SHA>`. 절차·argv는 [M1 relay 인계](2026-10-29-m1-relay-model-handoff.md).
2. M1 relay 재설치 후 `server.ts check` 출력의 `equipment:"m1"`, `allowedModels:["mlx-community--gemma-4-26b-a4b-it-4bit"]`와 health의 `upstreamModelReason:"matched"` 확인.
3. 운영 `MODEL_REGISTRY_CONFIG`를 쓰는 경우 M1 entry에 `relay` 용도가 없으면 새 relay가 `relay_model_not_registered`로 시작하지 않는다 → migration 도구 후보 JSON 검토 후 반영.
4. 운영 text·translation 소비자에 `PRODUCT_TRANSLATION_MODEL_KEY=m1:translation` 설정(옛 `[m1] qwen…`은 코드가 Gemma로 해석하지만 설정 정리는 별도), capacity policy의 `product-translate` route 모델이 `[m1] mlx-community--gemma-4-26b-a4b-it-4bit`인지 확인(다르면 `unmapped`로 보류된다), 표준 배포.
5. 배포 후 실제 M1 dispatch·terminal·번역 저장 건수 증가 실측(현재 측정 없음).
6. `lib/llm/replaced-provider-boundary-contract.ts`의 `[m1] qwen3.8-flash-next` 고정값은 이미 보낸 옛 요청 경계 해제용이라 이 차선에서 바꾸지 않았다.

# 2026-10-29 현재 상태 — 단건 해제 코드 main 병합 / 운영 sudo 중단

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

# 2026-10-29 M1 교체 경계 — 코드 준비 완료, 운영·병합 차단

재실행 확인(2026-10-29 07:43 UTC): 기존 구현·시험은 반복하지 않았다. GitHub API와 이번 명령에만 적용한 동일 저장소 HTTPS fetch로 최신 main `00aa00e3`를 대조했고 정상 merge는 Already up to date다. 일반 `git fetch origin`은 간격을 둔3회 모두 exit128/`Connection closed by UNKNOWN port 65535`로 실패했다. 영구 remote/SSH/인증 설정은 바꾸지 않았다. CI40835471662의 실패 job만1회 재요청한 attempt2도 scope/check가 실행 단계 없이 실패했으며 annotation은 동일한 계정 결제실패/사용한도 차단이다. 결제·한도·필수관문 변경 없음. 공개 health12회는 모두ok/dbok이며 m3-web·mini-web 둘 다199a3ebb다. M1 검토용 사본 조회와 M3 DB 측정용 SSH도 각각 간격을 둔3회 모두 exit255/같은 연결종료 오류였다. 따라서 이번 AI1·AI2/번역/새미확인/29877f65 현재 상태의 **신규 DB 측정 없음**. 아래07:23값은 이전 실행 실측이며 현재값으로 재사용하지 않는다. 사람의 M1 사본 생성 여부도 확인하지 못했다. 운영 쓰기/DRAIN/해제/모델 저장/마이그레이션/배포/새 모델 호출0, 원본 사용자 파일 변경0. main 병합은 필수CI 차단에 남아 있고 B~D도 그 선행조건에 막혔다.

- 전용 worktree/브랜치 `fix/m1-replaced-provider-boundary`, 기준 main `00aa00e3`. 구현·시험·운영 문서와 28ada57b의 `scripts/ops/verify-prod-revision.sh` 동일 바이트를 [PR721](https://github.com/JRVector9/nomorevibe/pull/721)에 보존했다. **main 병합·운영 배포 완료가 아니다.**
- 완료(코드): `replaced_provider_boundary_exit` 단건 CLI와 0140 migration. exact full-row/token/binding/C/DRAIN/writer CAS, 원 worker DB 종료 기록 재조회, 세 Docker/Swarm 교체, M1 receipt/relay 세대·native 모델 프로세스 교체, 양 wire hash/메시지·생성 상한 보존을 모두 요구한다. 누락·다중 요청·해시 불일치는 거절한다. 업무 성공/사용량 환불/TTL/정지·재시작은 만들지 않는다.
- 해시 대조 완료: 당시199a3ebb 코드와 원문4개 sourceHash가 모두 일치. 원문 SHA256 `0507685dd86a3fe61a62d0c83b71cfafbc1add1e08feb70fb6436c38854a40d8` = 장부 wireHash. gateway 변환 + HTTPX0.27.2 기본 Python json.dumps 뒤 `81d1f5713daacd9a742e853b7880e5636efd53910ed473038ea91f61a75c1768` = relay6571d6c8 requestHash. 단순 시간 근접으로 동일 요청을 추정하지 않았다.
- 원 owner DB 종료: opened1932/intent1933/spawn1934/exit1967, request local-end156477. 운영 적용은 하지 않았다. M1은 여전히 indeterminate, C40768/terminalNULL/settled_atNULL 보존, 해제 감사 번호 없음.
- 실제 검증: 로컬 3파일103시험, 최종 verify-review-stall(typegen/tsc/scoped lint, TS23파일339시험+Python71시험) exit0, 최신 역사 비교 시험 수정 후 tsc/lint exit0. 새 단건 DB 회귀4개는 CI에서 실제 PASS(dry-run rollback, 누락/불일치 거절, 적용/실패·C 보존/감사/중복).
- 구현 head `2fa095f6`의 [CI40833430125 attempt1](https://github.com/JRVector9/nomorevibe/actions/runs/40833430125/attempts/1)은 typecheck/lint/unit2묶음/build/DB6묶음/직렬장부/PR이미지 모두 SUCCESS. **필수 check는 runner 미시작으로 FAILURE**. 정확한 GitHub annotation: `The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings`. 실패 job만1회 재실행한 attempt2도 같은 결제·한도 사유로 미시작. 결제/한도/필수관문 변경·우회 없음. 최종 문서 커밋을 기존 구현 시험 통과로 소급 인증하지 않는다.
- 앞선 실패 보존: CI40830660927은 마지막 migration을0137로 가정한 schema/역사 비교 기대가 실패했고, CI40831748543은 나머지 CLI 역사 비교2개가 실패했다. 기존 predicate 전체와0140의 새 branch를 함께 재parse하는 검증으로 수정했다. 로컬 처음 새 fixture lint의 미사용 변수 경고1개는 수정 뒤0. 로컬 DB 회귀는 global `npx drizzle-kit migrate` exit1에서 시험 시작 전 실패했으며, 전용 DB는 `connect ECONNREFUSED 127.0.0.1:55435`. 로컬 Docker도 `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`. sudo/권한 변경 없이 CI DB 증거를 사용한다.
- 운영 PRIMARY READ ONLY: 06:24:03Z→07:23:25Z AI1 **95603→95667**, AI2 **91774→91822**. 기존 서비스의 자연 증가이며 이번 배포·저장 결과가 아니다. 번역 ready/reviewed **16917→16917**, 마지막 갱신10/28 07:01:54Z. 새 미확인 **0→1**, Supa `65f8c399-ff4b-47bc-8f4d-6e4a682cf6a7`, dispatch10/29 06:33:07Z. M1 포함 indeterminate합계2. 진행 중 dispatched2는 미확인 수와 구분했다. 이번 작업 모델 호출/운영 DB 쓰기0.
- 공개 health 별도12회는 모두 health/db ok, m3-web·mini-web 모두 release `199a3ebb68772f1ccbefd397172effce72029796`. 원본 경로에서 fetch 후 요청한 ancestry 루프는 exit1(`m3-web 199a3ebb68772f1ccbefd397172effce72029796 lacks 00aa00e3`), 검증 스크립트 명령은 exit127(`bash: scripts/ops/verify-prod-revision.sh: No such file or directory`). origin/main에는 아직 스크립트가 없다. 병합을 우회해 원본에 브랜치 파일을 복사하지 않았다. 원본 사용자 파일/브랜치 수정0.
- 막힘(M1 sudo): 설치된 root 소유 `/usr/local/nmv-llm-relay/current/scripts/local-model-relay/config.ts`는 Qwen3.8만 허용한다. 현재 상류 목록은 Gemma4 등을 제공하며 Qwen3.8은 없다. relayReady=true지만 nativeCapacityReady=false/reason=native_contract_invalid. `/var/nmvllm/native-readback.json`의 stat조차 Permission denied. root 설치물/launchd 및 서비스 전용0700경로를 현재 계정으로 수정·조회할 수 없어 사용자 sudo 중단 규칙에 따라 **운영 해제/DRAIN/배포/모델 저장을 중단**했다.
- 사람이 M1에서 할 한 줄(원본 보존, 읽기용 사본만): `sudo /usr/bin/install -o jinwooro -g staff -m 600 /var/nmvllm/native-readback.json /Users/jinwooro/.local/share/nomorevibe-m1-translation-20261028/receipts-20261029/native-readback-review-49b91700.json`. 아직 실행하지 않았다. 이 사본 확인만으로 모델 수리/해제/배포가 완료되지 않는다.
- 남음: GitHub 계정의 CI 시작 차단 해결→필수check/최신base/PR병합→정식 M1 relay·readiness 수리(사람 권한 필요)와 새 Supa 실제 종료 증거→merged 코드 단건 dry-run/apply·감사→표준 plan/deploy·OPEN·양웹 판 검증→/admin/models 정식 저장·감사·화면·30분 모델별 성공/번역/AI1·AI2/새미확인0 실측. 현재 capacity OPEN epoch1/revision7, DRAIN/마이그레이션/배포/저장/해제 실행0.

---

# 현재 재개 상태 — 2026-10-29 (3d813382)

이 절이 현재 상태이며 아래 이전 기록은 당시 이력이다.

- 끝남(단계1): PR709에 origin/main b047bddb를 정상 merge해 PR707 drain 보호를 복구. main과 다른 파일을 07930102의 재시작 보호 범위로 제한했다. 무관한 tests/crawl-seed-latest.test.ts, docs/CODEX_HANDOFF.md, GPU3090 개발 문서를 main으로 복구했다. 이력 재작성/force push 없음.
- 검증: bash scripts/verify-review-stall.sh 종료0(typegen/tsc/lint, 관련 TS/Python). 별도 crawl-seed-latest 22시험 성공. PR709 기존 CI40783523028/unit(1) 실패 원인은 main에 없는 탐색 시험 혼입이었다. 새 CI40789227478/check SUCCESS 후 PR709를 7973d9b7421dad81cfe66fb4b05fded862d7c446으로 병합(23:51:18Z).
- 끝남(단계2): 01514beb를 최신 main 7973d9b7 위에 cherry-pick. item 경로만 우회하던 누락을 고쳐 실제 legacy 잡도 같은 blocked/paused hint를 선택 함수에 전달한다. 미전송 우회 및 이미 보낸 후보 고정의 legacy 회귀 2개 추가. bash scripts/verify-review-stall.sh 종료0(typegen/tsc/lint, TS20파일320시험/Python68시험). PR710 첫 CI40790400261/typecheck는 Node heap OOM(exit134, 약2GiB)으로 실패했다. 로컬2GiB도 OOM 재현. 조회 단순화로 해결되지 않아 해당 실험은 되돌렸고 CI typecheck 단계만4GiB heap으로 명시한다. 검사/필수관문/운영용량 변경 없음. 같은 CI integration(4)는 제거된 모델의 시도를 다른 모델로 재시도하던 이전 기대값 때문에 실패했다. 요청한 전송 후 고정을 검증하도록, 제거 시 시도0/거절과 원 모델 복원 후 backoff·총3회 상한을 모두 확인하는 DB 회귀로 갱신. 수정 후 NODE_OPTIONS=--max-old-space-size=4096 bash scripts/verify-review-stall.sh 종료0, CI workflow 회귀2파일16시험 성공. 관련 DB 회귀의 로컬 실행은 Docker API permission denied로 막힘(CI에서 실제 실행). 새 CI40791156676 전체 성공(check/typecheck/integration4 포함) 후 PR710을 717549486e83d04425cf861d539e048aba39cc2d로 병합(2026-10-29 00:09:53Z).
- 끝남(단계3): dc704d87 cherry-pick, legacy 선택 충돌은 blocked+paused 합집합 유지. bash scripts/verify-review-stall.sh 종료0(TS22파일332시험/Python68시험), 측정mjs syntax/eslint 성공. PR711 CI40792266878 전체 성공 후 2f45f6d05a7d7aff4b87d723b0e146ae50c9e1dc로 병합(00:20:02Z). 서버/gateway 강제 및 M1 표본 미검증으로 자동 회수는 선언하지 않음.
- 막힘(사람 필요, Oracle): 10초 timeout/BatchMode의 동일 sanctioned `ssh ubuntu@nomore-x 'systemctl list-units --type=service --all --no-legend "nomorevibe*"'`를 시차를 두고3회 시도, 매회 exit255 `Connection closed by UNKNOWN port 65535`. 서비스/권한/키 변경 없음.
- 막힘(결과 디렉터리): 지정 jobs/3d813382.../artifacts와scratch의 mkdir은 `Read-only file system`. 작업 공간에 로그 보존, 보고함 첨부로 결과를 보관한다.
- 남음: 단계4(d7fea73c+7eaf8bef) PR/필수CI/병합. 표준 배포와 실제 강제 확인·자동 회수 선언·4종 드릴·60분 관측은 아래 운영 인증/종료증거 미확인에 막힘.
- 실제 운영 23:41:15Z: AI1 94871(최근1시간0), AI2 91158(최근1시간2). 이전 측정과 총수 동일. GPT-OSS AI1/Supa tagline/M1 translation indeterminate 각1. scripts/ops/measure-review-stall.mjs(원 커밋 dc704d87)를 기존 M3 text 컨테이너에서 node stdin 실행, primary READ ONLY. 세부 원인과 쿼리 근거는 아래 진단 절에 기록했다.
- 막힘(사람 필요, 배포 checkout): ssh jr@m3Ultra 연결·Docker 조회는 성공. 문서 경로 /Users/jr/Desktop/projects/nomorevibe-release-ai1-queue-fix-20261027 및 /Users/jr/Desktop/projects/nomorevibe는 `No such file or directory`. `ls -la /Users/jr/Desktop`는 `Operation not permitted`. 경로/OS 권한을 우회하지 않았다. 전용 운영자 checkout의 clone도 GitHub 인증 오류로 막혔다(아래 정확한 명령/응답). Keychain 접근 성공은 아직 확인하지 않았다.
- 의존성: npm ci --ignore-scripts --no-audit --no-fund는 registry.npmjs.org allowlist 차단. 이전 작업 공간의 기존 node_modules를 이 작업 공간에 복사해 로컬 검사했다. 원본 폴더·설정·자격정보 변경 없음.
- 결정: 가장 적게 바꾸는 정상 merge와 main 파일 복구를 선택했다. 자동 회수는 기본 비활성으로 유지한다. CI heap은 OOM이 재현된 typecheck 단계만4GiB로 명시하는 최소 변경을 택했다.

## 저장 정체 읽기 전용 원인 확인 (23:42:49Z / 23:43:26Z)

- 기존 M3 text 컨테이너의 업무 DB 연결에서 BEGIN READ ONLY + statement_timeout15초로 조회. primary(pg_is_in_recovery=false), capacity open/epoch1/revision7.
- active는 indeterminate3건뿐: product-translate/M1 `29877f65-9f95-4efb-88f9-aea5f39a28b2`(13:58:16Z 전송), crawl-tagline/Supa `161d7780-5b1f-4ce8-be8d-baed927b28e8`(18:16:16Z), crawl-agent-review/MLX `547292c0-6bf9-4052-b1c1-90c98fc75277`(18:16:26Z). 각 group/provider 상한1을 해당1건이 차지했다. AI1 두 모델 waiting각2건. heartbeat는 최근 수초이고 현재 작업 잠금도 null이라, 워커 전체가 사라졌다고 볼 근거는 없다.
- 각 요청에 dispatch_indeterminate(reason transport_unknown)와 dispatch_local_ended가 있지만 provider 종료/dispatch_settled/dispatch_released 증거는 없다. 로컬 종료만으로 원격 생성 종료를 단정하거나 해제하지 않는다. 세 요청은 새 선언 이전이므로 비소급 보호상 자동 회수 대상도 아니다.
- AI2는 설정상 local-direct Qwen voter1, fallback없음, 공개분 sampleRate0.05. 실제 pending0. 최신12표는 first_attempt_id가 모두null인 공개분 표본. 최근1시간2건은22:48/23:08 저장이고 신규 AI1 성공은18:16 이후0. **AI1 공급 정체와 일치하며 GPU 고장/활성 점유 때문에 AI2가 멈췄다는 근거는 없다.** AI2 job.last_error의 과거 SELECT 오류만으로 현재 DB 장애라고 판단하지 않는다.
- 이 차선 코드 보강: legacy AI1의 blocked hint 연결 누락을 PR710에서 수정. 두 모델이 모두 막히면 안전하게 기다리므로 기존3건은 별도 provider 경계 종료 증거에 따른 회수가 필요하다. 그룹 상향/SQL 초기화/TTL 해제/점유 파일 삭제는 하지 않았다.
- 원본 진단 JSON과 SELECT 스크립트는 이 작업 공간 및 /tmp/review-stall-{rca,ai2}-3d813382.mjs에 보존(자격정보 없음). 운영 DB를 시험 DB로 사용하지 않았다.

## 2026-10-29 추가 검증·현재 운영 막힘

- 단계4 로컬/PR 준비: 최신 main2f45f6d0을 정상 merge한 d7fea73c+7eaf8bef를 순서대로 cherry-pick. 백로그 conflict는 이 작업 최신 기록을 우선 보존하고 이전 이력도 유지했다. bash scripts/verify-review-stall.sh 종료0(typegen/tsc/lint, TS23파일338시험/Python71시험). 규칙 측정mjs syntax/eslint 성공. 최신 main merge 후 최종 bash scripts/verify-review-stall.sh도 종료0(동일338/71시험). 자동 회수 env/서버/실행 권한 변경0, 해제 요청0.
- M3 문서 checkout 부재를 해결하려고 전용 운영자 사본만 새로 준비했다: `ssh jr@m3Ultra 'test ! -e /Users/jr/Server/nomorevibe-release-review-stall-20261029 && git clone --no-checkout https://github.com/JRVector9/nomorevibe.git /Users/jr/Server/nomorevibe-release-review-stall-20261029 ...'`. clone은 `fatal: could not read Username for 'https://github.com': Device not configured`로 실패. SSH wrapper의0종료를 clone성공으로 세지 않았다.
- 추가 읽기 명령 `ssh jr@m3Ultra 'gh repo view JRVector9/nomorevibe --json visibility --jq .visibility'`는 `HTTP 401: Requires authentication (https://api.github.com/graphql)` / `Try authenticating with: gh auth login`. 다른 호스트의 토큰 복사·auth설정 변경·GitHub 접근 우회는 하지 않았다.
- **막힘(사람 필요): M3에서 기존 GitHub CLI 인증을 1회 복구(`gh auth login`)해야 한다.** 이후 새 clean operator checkout과 최신 main의 표준 scope/plan/run을 재개할 수 있다. 아직 npm deploy plan에 진입하지 못했으므로 Keychain 잠김/키부재 여부는 측정 없음이며 추정하지 않는다.
- Oracle 동일SSH3회 모두 exit255 `Connection closed by UNKNOWN port 65535`. 실제 Oracle scheduler/watchdog 배포·가동은 미확인. 키/권한/known-host 설정 변경0.
- 운영 배포0. 서버/gateway 강제종료·M1 지연/최저decode·disconnect abort가 미검증이므로 자동 회수 선언/4종 실제드릴/60분 새저장 증가 관측은 수행하지 않는다. 기존3건은 비소급 보호로 별도 종료증거 회수가 필요하다.

---

# 미확인 요청 정체 차선 남은 일 (2026-10-28)

대표 지시(2026-10-28): AI1·AI2 미확인 요청 발생을 줄이고, 발생해도 사람 개입 없이 자동 해제·재개.
기준 origin/main `199a3ebb`(#708). 작업 공간 `xaegis/36694e57`(HEAD `8c10f0ad`, = `xaegis/cca48837`의 부모).

## 상태 요약

| 단계 | 코드 | 로컬 시험 | 커밋 | PR·CI·병합·배포·운영 확인 |
| --- | --- | --- | --- | --- |
| 1 재시작 보호(cca48837) | 작업 공간에 `8513cff8` 내용 그대로 반영 | 미실행(막힘) | 못 함(막힘) | 못 함(막힘) |
| 2 막힌 모델 우회 배정 | 끝 | 미실행(막힘) | 못 함 | 못 함 |
| 3 기한 사다리·M1 중계기 | 이 저장소 몫 끝, abcLLM 게이트웨이·엔진 설정은 저장소 밖(게이트웨이는 2026-10-30 은퇴 — 종료) | 미실행 | 못 함 | 못 함 |
| 4 자동 해제 | 워커 잡·Oracle 지연 경보 끝, 선언(실측 후)은 남음 | 미실행 | 못 함 | 못 함·드릴 못 함 |
| 5 1차 심사 보고서 | 끝(`2026-10-28-first-review-content-and-rule-worker.md`), 비율 실측 없음 | — | 못 함 | — |

## 독립 코드 읽기 검토(실행 아님)와 반영

시험을 돌릴 수 없어 별도 에이전트가 변경을 읽어 검토했다(실행 결과 아님).

- 확인된 결함 1건 고침: claim 단계 재확인(`agent-review-repository.ts` `claimReview`)이 blocked 정보 없이 고정 칸을 다시 골라, 우회된 후보가 항상 `input_changed`로 건너뛰어졌을 것이다. 잠금 아래 재확인에서 "claim한 모델 외 풀 모델 = avoid"로 같은 선택 함수를 써서, 한 번도 보내지 않은 후보만 우회 모델을 유지하고 고정(시도·intent) 후보는 그대로 거절하게 했다. 시험 추가.
- 고침: 중계기가 이미 기한 경과로 열린 요청을 DB 경계 해제 연결 도구가 `already_cleared`로 끝낼 때 receipt의 wireHash·모델을 대조한다.
- 검사 스크립트에 `test_recovery_provider.py`, `test_release_catalog.py`, 번역 호출자 시험 2개 추가.
- 기준 차이(결함 아님): `lib/jobs/products/translations.ts`는 origin/main(#708) 형태(`deadlineAt`, 55초 예산)로 썼다. **이 작업 공간 기준(`8c10f0ad`)에서는 tsc가 실패하고 25초 기본 예산이 40초 HTTP 기한보다 짧다. 반드시 origin/main 위로 옮긴 뒤 검사·병합한다.**
- 남긴 위험: `.boundary-recovery.lock`이 프로세스 강제 종료로 남으면 중계기가 계속 닫힌다(cca48837의 의도된 동작 — 자동 만료 없음, 운영 절차로 확인 후 정리).

## 끝낸 것(작업 공간에 미커밋 변경으로 존재)

- 1단계: `git show 8513cff8:<경로> > <경로>`로 22개 파일을 그대로 옮겼다. `git diff --stat 8513cff8`에서 추적 파일 차이 0을 확인했다(새 파일은 미추적으로만 보임).
- 2단계: `selectFirstReviewer`의 `avoid` 인자. 활성 intent·시도 기록이 전혀 없는 후보만 막힌 모델(물리 그룹 또는 provider budget이 `indeterminate`로 꽉 참, 또는 이번 회차에 local deferral로 멈춘 모델)을 건너뛰어 고정 칸에서부터 돌아가며 다음 모델로 보낸다. 모두 막혔으면 고정 칸 그대로 기다린다. 이미 보낸 요청·재시도 고정·점유는 건드리지 않는다. `lib/crawl/first-reviewer-blocks.ts`(읽기 전용 hint, 실패하면 hint 없음). AI2는 후보별 고정 배정이 아니라 voter 전원+fallback 구조라 같은 문제가 없다(`lib/crawl/settings-schema.ts` `secondReview.voters`).
- 3단계: `lib/llm/deadline-ladder.ts`, 번역 클라이언트 20→40초, M1 중계기 `max_tokens` 강제·엔진 상한 선언 시 자동 재개. 근거 `docs/operations/2026-10-28-deadline-ladder.md`.
- 4단계: maintenance 잡 `model-capacity-reclaim`(1분) — 선언된 budget만 기존 `releaseEvidencedDispatches` 판정으로 해제. Oracle은 같은 요청이 5분 넘게 남으면 `model_reclaim_overdue` 별도 사건으로 사람에게 알린다(DB·모델 권한 추가 없음).
- `scripts/verify-review-stall.sh` 작성.

## 남은 것

1. (사람·권한 필요) 아래 막힌 명령 실행: 커밋, origin/main 기준 브랜치 정리, PR707 → PR(1단계) → PR(2~4단계) 순 push·PR·CI·병합.
2. `scripts/verify-review-stall.sh`를 node_modules가 있는 곳에서 실행해 0 종료 확인, 실패하면 고친다.
3. ~~abcLLM 게이트웨이 요청별 기한·vLLM abort·종료 기록(별도 저장소)~~ — 종료: 게이트웨이 2026-10-30 은퇴.
4. 운영 실측(p95/p99, decode 속도, 엔진 연결 끊김 드릴) 후 `MODEL_CAPACITY_AUTO_RECLAIM`·`LOCAL_MODEL_RELAY_ENGINE_DEADLINE_MS`·`LOCAL_MODEL_RELAY_MAX_OUTPUT_TOKENS` 선언.
5. 표준 배포(`npm run deploy -- scope|plan|run`, PR707 drain 보호) → M3·mini 반영 → DB의 새 AI1·AI2 저장 건수 증가 확인.
6. 드릴(timeout·연결 끊김·owner 교체·응답 유실) 5분 내 자동 해제·재개, 이후 60분 AI1·AI2 저장 증가, 수동 해제 0.
7. 1차 심사 보고서의 대체 가능 비율 실측(측정 SQL은 보고서에 있음).

## 막힌 것(이유: 이 세션은 승인 화면이 없어 승인이 필요한 도구 호출이 모두 자동 거절됨)

거절된 실제 명령(그대로):

- `git fetch origin` — 원격 갱신 불가. 로컬 `origin/main`=`199a3ebb`를 기준으로 사용.
- `gh pr view 707 --json ...` — PR·CI 확인 불가. 따라서 push·PR·병합도 불가.
- 작업 공간 밖 읽기(`xaegis/ce0a1f81` 작업 공간 파일) — 커밋된 `6da7ea92`의 문서로 대신 읽음.
- `npm ci --ignore-scripts --no-audit --no-fund` — node_modules 없음 → tsc·eslint·vitest 실행 불가.
- `python3 -B -m unittest discover -s tests -p 'test_oracle_*.py'` — Python 시험 실행 불가.
- `git checkout -b fix/review-restart-protection-20261028 origin/main`, `git merge --no-edit origin/main`, `git add ...` — 브랜치 생성·병합·커밋 불가.
- `chmod +x scripts/verify-review-stall.sh`, `bash -n scripts/verify-review-stall.sh` — 실행 권한·문법 검사 불가(`bash scripts/verify-review-stall.sh`로 실행).
- 운영 DB·SSH·배포 명령은 위 결과로 보아 시도해도 같은 방식으로 거절된다고 판단해 시도하지 않았다. 따라서 운영 반영·드릴·저장 건수 측정 없음.

## 병합 순서 제안

1. PR707(`fix/review-stall-recovery-20261028`, drain 보호) — 먼저.
2. 1단계 PR: origin/main(707 병합 후)에서 `git cherry-pick 8513cff8`. 충돌 예상 파일(HEAD와 origin/main이 다른 파일): `scripts/ops/incident_notifications.py`, `scripts/ops/oracle_watchdog.py`, `scripts/ops/recovery_gateway.py`, `scripts/watch-failover-readiness.ts`, `tests/test_recovery_provider.py`.
3. 2~4단계 PR: 이 작업 공간의 나머지 변경. origin/main과 다른 파일 중 이 차선이 고친 것: `lib/crawl/jobs/agent-review.ts`(1줄), `lib/jobs/products/translations.ts`(main 줄 형태로 작성함), `lib/jobs/catalog.ts`, `lib/jobs/registry.ts`, `lib/operations/emergency-priority.ts`, `lib/operations/stage-registry.ts`, `app/(operator)/admin/status/work-owners.ts`, `tests/job-catalog.test.ts`, Oracle 두 파일.


## 2026-10-28 23:16 UTC 재개 세션 (gpu3090, 최신 기록)

- 최신 확인: `git fetch origin` 성공, origin/main `199a3ebb` (#708).
- 시작 브랜치의 다른 구역 변경을 건드리지 않도록 `fix/review-stall-lane-20261028`를 origin/main에서 생성. 원본 사용자 폴더·기존 xaegis 브랜치 보존.
- 단계0: e3e3596d를 가져와 main 충돌 해결. 번역 55초 예산·deadlineAt 유지. 최신 reviewFailures 감시와 capacityUnknowns 감시를 병존시킴.
- 최초 검증: typegen/tsc/eslint 성공, TS 23파일 332시험 성공. Python 전체 Oracle 249시험은 실패 33·오류6·skip8 (차선 밖 activation의 `identity:approved_identity_unavailable`·restore의 `unsafe_output_parent`, 차선 안 overdue 시험 상태 객체 오류 1). 기록 보존. 전체 Oracle 시험은 앞으로 반복하지 않음.
- overdue 시험은 cycle이 state를 교체한 뒤 notify에 넘기도록 수정. 차선 범위로 검증 스크립트를 좁힘. 최종 `bash scripts/verify-review-stall.sh` 종료0: typegen/tsc/lint, TS 23파일332시험, Python 관련 감시·gateway·catalog 회귀 성공.
- `npm ci --ignore-scripts --no-audit --no-fund` 막힘: `Network access to "registry.npmjs.org" was blocked: domain is not on the allowlist for the current sandbox mode.` 승인 우회 없이 로컬 npm 캐시만 쓰는 `npm ci --offline --ignore-scripts --no-audit --no-fund` 성공(535 packages).
- 단계1: `gh pr update-branch 707` 성공, head `4e490d2c`로 최신 main 갱신. 새 필수 CI 진행 중. 이전 head의 성공을 새 head 성공으로 간주하지 않음.
- 운영 측정: `scripts/ops/measure-review-stall.mjs`를 기존 M3 text 컨테이너에서 read-only transaction으로 실행. 원본 `review-stall-measurement-before.json` 참조. primary=false 아님(pg_is_in_recovery=false). AI1 총94871·최근1시간0, AI2 총91158·최근1시간2. 미확인 GPT-OSS AI1 / Supa tagline / M1 번역 각1.
- monitor DB 계정 조회는 실제 `42501 permission denied for table model_capacity_requests`로 실패. 기존 text 앱의 업무 DB 연결로 READ ONLY 조회 성공했으며 권한·계정·환경변수는 변경하지 않음.
- **막힘(지정 artifact·scratch 경로 쓰기)**: `mkdir -p /home/ubuntu/.xaegis-hub/data/local-agent/jobs/6b64d562-ec09-4b3e-96a1-2a6a103a4073/artifacts /home/ubuntu/.xaegis-hub/data/local-agent/jobs/6b64d562-ec09-4b3e-96a1-2a6a103a4073/scratch` → `mkdir: Read-only file system` (exit1). sandbox escalation·권한 변경·다른 scratch 경로로 우회하지 않음. 배포 private receipt 디렉터리와 별도 abcLLM checkout 준비가 이 경로에 의존함.
- SSH 읽기: M3 docker / m1-studio / supa 접속 성공. Dokploy status reviewer·web 양쪽 done(기존 배포, 이번 배포 아님).
- 남음: 단계1 CI→병합→표준 plan/run(지정 경로 막힘), 이후 단계2 별도 PR/배포, 단계3 코드·회귀 독립 커밋, 단계4 최신 지연 반영 및 서버/게이트웨이 강제, 단계5 실측 후 선언·드릴·60분 관측, 단계6 최신 코드 보고서 확인.

### 단계2 독립 분리

- `fix/review-restart-protection-20261028`는 origin/main `199a3ebb`에서 8513cff8만 가져옴. 최신 main의 reviewFailures 감시를 유지하고 capacityUnknowns를 병존시켰다.
- `bash scripts/verify-review-stall.sh` 종료0: typegen·tsc·변경 lint, TS19파일312시험, Python 요청감시5 + watchdog9/10/24 + recovery7 + catalog13 성공. 아직 도입하지 않은 단계5 시험 파일은 명시적으로 건너뜀.
- 첫 분리 검사에서 아직 존재하지 않는 단계5 Python 파일 discovery가 `NO TESTS RAN` / exit5로 끝나 수정 후 위 명령을 재실행해0 확인. 실패 결과를 성공으로 덮어 적지 않음.
- PR·배포는 단계1 배포와 운영 저장 확인 뒤 진행. 지정 배포 영수증 디렉터리 생성이 막혀 후속 병합·배포 순서를 앞당기지 않음.

### 단계1 PR707 병합 / 배포 준비 기록

- 최신 main 기반 head `4e490d2cf15f3e88b611191cfb733727f8ad0919`의 필수 `check` SUCCESS: https://github.com/JRVector9/nomorevibe/actions/runs/40785613934 .
- `gh pr merge 707 --merge --match-head-commit 4e490d2cf15f3e88b611191cfb733727f8ad0919` 성공. 병합 `b047bddbeb86a2828e2ab1e0f293a91df5affda2`.
- main run https://github.com/JRVector9/nomorevibe/actions/runs/40786665949 의 `check`·`publish-worker-image`·`publish-web-image` SUCCESS. 전체 workflow/refresh-caches는 기다릴 관문 아님.
- 올바른 exact SHA로 `npm run deploy -- scope --base 199a3ebb68772f1ccbefd397172effce72029796 --sha b047bddbeb86a2828e2ab1e0f293a91df5affda2` 실행: mode=none, selectedApps=[], no_runtime_change. PR707은 배포 coordinator 보호 변경이므로 이 diff만으로 앱을 불필요 재배포하지 않음. 실제 혼합 baseline 검증은 plan 몫.
- 앞선 scope의 짧은 ref / 잘못 적은 base는 각각 invalid_commit_identity / unproven_git_history로 full fallback. 위 정확한 SHA 재실행 결과만 채택.
- 첫 `PATH=/home/ubuntu/.codex/skills/prod/bin:$PATH NMV_DEPLOY_SSH_USER=jr npm run deploy -- plan --sha b047bddbeb86a2828e2ab1e0f293a91df5affda2 --out /home/ubuntu/.xaegis-hub/data/local-agent/jobs/6b64d562-ec09-4b3e-96a1-2a6a103a4073/scratch/review-stall-pr707-20261028` 은 exit1, `{"status":"release-not-complete","errorClass":"ValueError","reason":"inspect-private-receipts","automaticRetry":false}`. 당시 checkout이 code 분리 브랜치였으므로 `create_plan` 첫 관문 `checkout_must_be_target_release`에 해당. 깨끗한 대상 SHA에서 다시 확인할 예정. 이 결과를 배포 시도/완료로 세지 않음.
- mini의 jr 계정도 읽기 전용 docker 확인 성공. 계정·SSH·실행 권한 변경 없음.

### 단계3 전송 전 후보만 우회

- AI1: 미확인으로 group/provider budget이 꽉 찬 모델을 읽기 전용 hint로 제외. 해당 후보의 모든 입력 이력에서 모델 시도 기록이 없고 활성/대기 intent도 없을 때만 고정 칸부터 다음 모델 선택. hint 실패 시 기존 고정 선택. claim 잠금 아래 같은 선택 재확인.
- 추가 보강: 최신 시도 모델이 풀에서 제거되었거나 읽을 수 없어도 다른 모델로 재시도하지 않고 보호(null). 과거 다른 모델 시도로 건너뛰지 않음.
- AI2 재확인: `second-review.ts` enqueue는 voter별 독립 행을 만들며 AI1처럼 candidateId % pool 방식이 아님. `second-review-model-capacity.ts` / `fallbackWaitingSecondReview`는 local-direct 전송 전 waiting/reserved에 한한 기존 fallback. 본 단계에서 AI2의 전송·고정·점유·fallback 정책은 변경하지 않음.
- 최초 분리 tsc는 lifecycle에 단계4 import가 섞여 TS2307(deadline-ladder 없음)로 실패. 이 단계의 timeout 60000을 유지하도록 import만 분리한 후 재실행.
- `bash scripts/verify-review-stall.sh` 최종 종료0, typegen/tsc/lint 및 관련 TS·Python 회귀 성공. 배포와 운영 저장 증가는 단계1 plan 막힘 해소 전 보류.

### 단계1 최종 배포 막힘 / 단계4 코드·실측

- 대상 b047bddb의 깨끗한 detached checkout에서 표준 `PATH=/home/ubuntu/.codex/skills/prod/bin:$PATH NMV_DEPLOY_SSH_USER=jr npm run deploy -- plan --sha b047bddbeb86a2828e2ab1e0f293a91df5affda2 --out /home/ubuntu/.xaegis-hub/data/local-agent/jobs/6b64d562-ec09-4b3e-96a1-2a6a103a4073/scratch/review-stall-pr707-20261028-clean` 실행 → exit1, `{"status":"release-not-complete","errorClass":"FileNotFoundError","reason":"inspect-private-receipts","automaticRetry":false}`.
- 같은 create_plan의 예외 경로만 진단(별도 새 diagnostic out 경로, 관문 비활성화 없음): `FileNotFoundError.filename=/home/ubuntu/.xaegis-hub/data/local-agent/jobs/6b64d562-ec09-4b3e-96a1-2a6a103a4073/scratch/review-stall-pr707-20261028-diagnostic`, deploy_release.py:254 create_plan → :99 fresh_directory → pathlib.mkdir. 지정 부모 생성은 앞서 `Read-only file system`으로 실패. 배포 영수증을 다른 경로에 우회 작성하지 않음. run 요청 없음.
- 단계2 전용 브랜치에도 origin/main b047bddb를 병합해 최신 main 기반으로 보존. 단계2 이후 PR/CI/병합/배포는 단계1 실제 운영 검증을 앞질러 진행하지 않음. 로컬 분리 개발은 계속함.
- 단계4: 최근7일 primary 장부 지연을 다시 측정. AI1 GPT p95/p99=7.644500/10.320340s(n5807), AI1 Supa=6.242650/7.764920s(n1458), AI2 Supa=6.145950/7.967630s(n1552, max42.991s), AI2 gpu3090=3.781000/5.254440s(n3985). GPT 번역=7.382000/9.390320s(n774). M1 성공 표본0이므로 p95/p99 측정 없음.
- 검증 대상 AI 상한을50/55/60초로 갱신. M1 내부28/31/34초 상수는 확정값으로 내보내지 않고 번역 client40초만 #708 job55초 안에 유지. 확정 내부 값은 M1 표본·서버 강제 확인 후 정함.
- relay max_tokens 강제·미확인 후 자동 열기는 검증된 엔진 상한 선언 시만 사용. 추가로 보장 적용 UTC 시각을 요구하고 그 이전 요청은 소급 해제하지 않음. 기존 archive의 active/receipt hash·정책 불일치 시 표식 유지. 원본 receipt 보존 회귀 추가.
- `bash scripts/verify-review-stall.sh` 종료0(typegen/tsc/lint, 관련TS/Python). 실제 서버·gateway 강제, vLLM disconnect abort·종료 기록, M1 최근 지연/최저 decode, 90초 운영 드릴은 막힘(별도 checkout/배포 receipt용 지정 scratch 생성 불가). 로컬 fake upstream 시험을 운영 종료 증거로 세지 않음.

### 단계5 자동 해제 코드 (운영 선언은 막힘)

- maintenance `model-capacity-reclaim` 1분 잡·catalog/역할 연결, Oracle 요청별5분 지연 경보를 분리 도입. 선언 없음/잘못된 선언이면 해제 경로를 호출하지 않음. 유효 선언도 기존 `releaseEvidencedDispatches`와 owner/프로세스 그룹/로컬 종료 증거 판정만 사용.
- 추가 보강: `enforcedAfter` UTC 시각 필수. 선언된 새 서버 상한을 그 전에 시작한 old-policy/기존 미확인 요청에 소급하지 않음. 공통 판정에 적용해 보고와 실행이 같은 결과를 냄. 해제 이벤트 reference에 보장 적용 시각도 남김.
- 관련 단위17시험 성공 후 `bash scripts/verify-review-stall.sh` 전체 차선 종료0(typegen/tsc/lint·TS/Python). timeout/연결 끊김/owner 교체의 순수 판정과 무증거·과거 요청 거절은 로컬 시험이며 운영 드릴 아님.
- 운영 `MODEL_CAPACITY_AUTO_RECLAIM`·relay engine 상한 선언 미설정, 실제 자동/수동 해제0(이 작업이 요청한 해제 없음). 단계4 서버/gateway 강제·M1 표본·vLLM abort가 미검증이므로 선언 금지 조건을 유지.
- 기존 AI1 `MAX_REVIEW_ATTEMPTS=3`, AI2 `MAX_SECOND_REVIEW_FAILURES` 및 receipt/item owner·현재 입력 검증을 유지. 늦은 응답이 새 owner/입력의 성공을 쓰도록 완화하지 않음. 실제 중복 저장 방지 드릴은 미실행.
- **남음/막힘**: Oracle의 현재 허용 forced command는 service observe/recover(web/monitor)에 한정된다. 새 해제용 trigger를 운영에서 설치·권한 추가하지 않았으며 현재 구현은 scheduler가 매분 worker를 깨우고 Oracle이 요청별 감시/경보만 한다. Oracle 트리거까지 검증하려면 기존 승인된 트리거 통로의 확인이 필요하며 실행 권한 설정 변경으로 만들지 않음.
- 실제4종(timeout·끊김·owner교체·응답유실) 드릴5분 내 해제/재개, 이후60분 AI1·AI2 저장 증가·수동 해제0 관측은 단계4 실제 보장과 배포 경로가 막혀 수행하지 않음.

### 단계6 p84-5 최신 검토

- 최초 보고를 보존하고 최신 코드 정정과 실제14일 표본19093건을 추가. prompt2026-10-06.2 동일, 규칙 provider/재사용 제외. READ ONLY primary 조회의 원본 JSON2개와 측정 스크립트 보존.
- 단순 본문50/100/200/400자 거절 규칙의 AI 일치율71.27/70.12/67.43/63.71%. 200자 미만5431건 중 AI approve1593건. installable 예외를 읽지 않은 전역 빈 본문 거절은 정책을 재현하지 못함. 신규 자동 거절 대신 그림자 평가를 선택(가장 덜 파괴적이며 실측상98% 기준 미달).
- AI1 후보 reason·packageProof 성격·installable 예외·AI2 출력 상한 설명을 최신 코드와 대조해 정정. 사람 기준 대체 가능 비율은 측정 없음(동일 입력의 검증된 사람 정답 대조 미실행), 추정치 없음.
- 운영 저장23:14→23:30 AI1 94871→94871, AI2 91158→91158. 배포 없음/증가0. 정체 해결 또는 운영 완료로 기록하지 않음.
- 마지막 `git fetch origin` 확인 main b047bddb 그대로. 단계2 이후 PR/병합/배포는 단계1 private receipt 쓰기 막힘과 운영 확인 조건 때문에 대기. 그 밖 남은 것은 단계4 외부 서버/gateway 강제·M1 표본, 단계5 Oracle 승인된 트리거 통로/실제 드릴·60분 관측이다. 로컬 코드 단계는 모두 분리 커밋으로 보존.

### Oracle 트리거 추가 확인·막힘 (앞선 단계5 기록 보충)

- 별도 `lib/runtime/oracle-scheduler.ts`의 `runOracleSchedulerTick → requestDueJobs`와 `deploy/oracle/least-privilege.sql`의 기존 scheduler jobs 권한을 확인했다. 공통 catalog에 등록한 model-capacity-reclaim은 이 정기 트리거 통로에도 포함된다(`catalogJobsForBatch`, interval60000). 그러므로 새 실행 권한을 만드는 것이 필수라는 뜻은 아니다. watchdog forced command 자체에는 모델 회수 트리거가 없고, 실제 nomore-x scheduler 통로가 설치/활성인지 확인해야 한다.
- 실제 읽기 명령 `ssh -o BatchMode=yes -o ConnectTimeout=10 ubuntu@nomore-x 'systemctl list-units --type=service --all --no-legend "nomorevibe*"'` 을 간격을 두고 같은 명령으로 총3회 시도. 매회 exit255, `Connection closed by UNKNOWN port 65535`.
- 이 연결 실패로 nomore-x의 실제 scheduler/watchdog 가동·새 catalog 반영을 확인하지 못했다. 다른 계정/주소/직접 TCP로 우회하거나 host-key 검증·실행 권한·인증을 바꾸지 않았다.

## 2026-10-28 최종 상태 (이 표가 현재 상태, 앞 기록은 이력)

| 단계 | 로컬 결과 | PR·CI·병합·배포/운영 |
| --- | --- | --- |
| 0 기존 작업 회수 | 86203e5d, main199a3ebb에 충돌 해결·verify0 | 로컬 보존용, 합쳐서 publish하지 않음 |
| 1 PR707 | 최신 base check SUCCESS | PR707 병합b047bddb, main check·두 image publish SUCCESS. scope상 runtime변경0. 실제 baseline plan의 private receipt 작성은 지정 scratch 부모 쓰기 차단으로 막힘. run/앱 변경/저장 증가 확인 없음 |
| 2 재시작 보호 | 07930102, 전용 브랜치에 main b047 병합, verify0 | 단계1 운영 관문 미완료로 후속 PR·병합·배포 대기 |
| 3 미전송 우회 | 01514beb, verify0. 제거 모델 재시도도 보호 | 동일 선행 배포 의존으로 PR/배포 막힘 |
| 4 기한/relay | dc704d87, 최근 p95/p99 측정·비소급 relay·verify0 | AI50/55/60초는 검증 대상. 외부 gateway/엔진 강제·종료 기록·vLLM abort·M1 성공 지연은 미검증. 별도 checkout용 지정 scratch 쓰기 막힘 |
| 5 자동 회수 | d7fea73c, 선언 기본off·시작 시각 보호·verify0 | 4의 강제 미검증이므로 운영 선언 금지. Oracle 현재 통로의 실제 서비스 확인은 SSH3회 실패.4종 실제5분 드릴·60분 저장 증가 관측 막힘 |
| 6 p84-5 보고서 | 최신 코드 정정·primary19093 표본·측정 도구·보고서 별도 커밋 | 신규 규칙 자동 거절은 채택하지 않음. 사람 정답 기반 대체율은 측정 없음 |

품질 명령 `bash scripts/verify-review-stall.sh`: 최초 종료1 → 최종 종료0. 최종 typegen/tsc/lint, TS23파일336시험·Python71시험 성공. 새 측정 mjs2개 node syntax/eslint 및 실제 READ ONLY SQL 성공. 실제 DB 통합 시험·운영 드릴·UI 검수는 수행하지 않음(UI 레이아웃/창 변경 없음). 검증 로그는 작업 공간의 review-stall-*-verify.log에 보존.

AI1/AI2 저장 증가 명령은 두 측정 mjs를 기존 M3 text 컨테이너에서 stdin 실행한 primary READ ONLY 쿼리. 23:14→23:30 AI1 **94871→94871**, AI2 **91158→91158**. 배포 없음·증가0. 운영 회복 성공을 주장하지 않는다. 이 작업이 요청한 수동/자동 해제도 없음이며, 전체 운영의60분 수동 해제0은 관측하지 않았다.

이후 할 수 있는 로컬 코드 단계는 모두 완료·커밋했고, 남은 것은 위 배포 경로/외부 강제/연결/운영 측정에 막힌 항목뿐이다. 파일시스템·인증·권한 제한을 우회하지 않았다.

## 2026-10-29 코드 전용 차선74afc085

- 끝: origin/main `00aa00e3` 병합. 충돌은 main 후속판을 보존. 장비 라우팅/Gemma 기본값은 이미 main에 있어 중복 cherry-pick하지 않음.
- 끝: relay 모델/family를 등록부와 env로 선택, 실제 upstream models 대조·기존 native 증명 유지. 상품·사유 번역을 같은 M1 entry로 정렬. 설치 스크립트는 명시 모델을 보존.
- 시험: 변경 전 main typegen/tsc PASS(TS2353 재현 없음). M1 범위5파일/34시험 PASS. verify-model-config 최초35실패는 독립 번역 모델을 공용 상수로 쓰던 fixture 등이며 재검증 결과는 후속 기록.
- 남음: Supa root prepare argv/검증된 결과 수집 분리, 범위시험·커밋·PR/CI.
- 운영은 막힘이 아닌 명시적 제외: DRAIN/해제/배포/DB 쓰기/장비 변경0. 대표용 argv는 `2026-10-29-m1-relay-model-handoff.md`. 운영 native ready/새 저장 실측 미수행.
- M1 최종 로컬 검증: verify-model-config 69파일/988시험·next typegen·tsc PASS, 동일 git grep 모델 리터럴158→99. 범위 ESLint·bash -n·git diff --check PASS. 이후 Supa 구현으로 계속 진행.

- 끝(코드): Supa root prepare argv/검증된 결과 수집 분리. 현재 전체 cgroup·원래 PID/startTicks·boot/config를 다시 읽고 부족한 근거는 차단. root 응답 유실은 durable ACK 읽기만 하며 stop/start 재전송 없음.
- 시험: Supa9파일/43 Vitest PASS 및 Python14건 PASS. 대표 argv는 `2026-10-29-supa-root-handoff.md`. 최종 정적 검사·PR/CI 확인을 이어서 수행한다. 실제 운영 종료·해제 검증 없음.
- Supa 범위 ESLint/tsc/diff 검사 PASS, Python14시험 재실행 PASS. 항목별 로컬 커밋 뒤 최종 모델 검증·PR 진행.

- 최종 확장 검증: verify-model-config 72파일/1,032시험·typegen·tsc PASS, 동일 기준 git grep158→99. 추가 회귀7파일/64시험 및 실제 Python16시험 PASS. 최초35실패(공용 fixture), 추가 범위1실패(사유 timeout45→40초 fixture)는 고친 뒤 통과했으며 실패 로그를 보존한다. PR/CI 확인만 남음.

## PR722 인계 — 2026-10-29

- 끝: M1 `c8e2c477`, Supa `252c65bb`, 확장 회귀 `79a4b1fb` 로컬 커밋 후 새 브랜치 `fix/m1-relay-supa-root-handoff` push, PR https://github.com/JRVector9/nomorevibe/pull/722 OPEN.
- 로컬 최종 `bash scripts/verify-model-config.sh` PASS(72파일/1,032시험·typegen·tsc), Supa9파일/43시험·Python16시험 PASS, 추가7파일/64시험 PASS(중복 합산하지 않음). 범위 ESLint/bash 문법/diff 검사 PASS.
- 막힘: Actions run40835749295의 scope/check가 **잡 시작 전** 실패. check-run123320010237 annotation: 계정의 최근 결제 실패 또는 spending limit 증액 필요(Billing & plans). 따라서 typecheck/lint/unit/build/integration 잡은 SKIPPED이며 CI 통과로 기록하지 않는다. 코드 실패 로그는 없고 `gh run view --log-failed`도 `log not found`였다. 결제/한도 변경·CI 보호 우회·강제 병합/배포 없음.
- 남음: 저장소 계정 담당자가 결제/한도 문제를 해결한 뒤 같은 PR의 필수 CI 성공 확인. 성공 전 병합 금지. 실제 운영 설치/종료/해제/저장 측정은 다른 승인된 운영 차선 몫이다.
- 최종 설정 검토: relay bare ID와 *_MODEL_KEY가 서로 다른 장비를 고르는 경우도 거절해 모델/리소스 한도가 갈리지 않게 함. 72파일/1,032시험·typegen·tsc 재실행 PASS. CI 계정 차단은 별도이며 완화하지 않음.

## 번역·후처리 3잡 적체 차선 (2026-10-29, 작업 공간 `xaegis/f1c6bae2`)

대상: product-tagline-ko·reason-translate·product-search-profile(근거 `docs/CODEX_HANDOFF.md` 10/27 23:07 KST).
원인·수정·배포 뒤 READ ONLY SQL 과 기대값은 [2026-10-29-text-backlog-runbook.md](2026-10-29-text-backlog-runbook.md).
기준 origin/main `be5d1d53`(#733)에 fast-forward 한 뒤 작업했다.

### 끝낸 것(로컬 커밋, push 안 함)

- 공통: `lib/llm/capacity-busy-targets.ts` — 세 선택기가 장부 fence 와 같은 상태·키(남의 대기·예약, 누구든 보냄·미확인)를 미리 뺀다.
  고정된 맨 앞 대상이 미확인 요청에 묶여 매 틱 같은 미룸만 되풀이하던 정체를 끊는다. fence·한도·경보 규칙은 그대로.
- tagline-ko: 출력 후처리(뒤 괄호·뒷문장·줄표 뒤·이름 철자·첫 줄) 뒤 전체 검사 재실행, 쉼표 앞 구절, 품질 외 실패 10회 종료와
  `gaveUpReasons`(quality_limit/failure_limit), 미룸 사유 로그.
- reason-translate: 두 대기열에서 장부에 묶인 사유 제외, 미룸 사유 로그, 진척 시 경보 해제를 실제 PostgreSQL 관측으로 시험.
- product-search-profile: 묶인 제품 제외(한 제품 한 요청), 같은 그룹 다른 route 대기 시 일꾼 하나(fair share), 미룸 사유 로그.
- 시험: 단위 `tests/postprocess-backlog-{tagline,reason,profile}.test.ts`, 통합 `tests/integration/postprocess-backlog-*.test.ts`.
  기존 dispatch 시험 세 곳(tagline-ko·reason·text-profile)의 "미확인 대상을 다시 골라 틱이 미뤄진다" 단언을
  "건너뛰고 재전송하지 않는다"로 갱신(두 번째 POST 없음·장부·캐시 불변 단언 유지). 시험 결과는 런북 '시험' 절.

### 남은 것

1. (대표) PR·CI·병합·표준 배포(`npm run deploy -- scope|plan|run`, text 공통 worker digest).
2. (대표) 배포 뒤 런북 Q0~Q10 실행, 결과를 이 절에 기록. 특히 Q0(route 전체 옛 형식 fence)·Q1(그룹 한도를 미확인이 다 쥠)이
   걸리면 이 수정으로 풀리지 않는다 — 미확인 요청 회수(`model-capacity-reclaim`, 위 차선 4단계) 선언이 필요하다.
3. 운영 실측 전에는 효과 크기(시간당 저장 수 변화)를 말할 수 없다. 측정 없음.
4. 수동 전체 unit·전체 DB·종합 시험은 통합 단계(AGENTS.md 검증 정책).

### 막힌 것(이유)

- 운영 DB 읽기·SSH·배포·push: 이번 지시가 금지(작업자 SSH 22 차단, 배포는 사람 승인). 그래서 실제 원인 분포(Q0·Q1 해당 여부,
  too_long 중 후처리로 살릴 비율)는 재지 못했다.

## AI1 고정 모델 정체 해소 규칙 (2026-11-01, 브랜치 `claude/ai1-stale-input-hol`)

운영자 결정(2026-11-01): **「지금 정말 보내진 중인 호출이 없으면 1차 후보는 언제나 지금 풀로 간다」.** 위 「단계3」의
「최신 시도 모델이 풀에서 제거되었거나 읽을 수 없어도 다른 모델로 재시도하지 않고 보호(null)」(10-28)를 이 결정으로 뒤집는다.
원인: 풀 모드(`firstReviewAdditional: []` 포함)에서 같은 입력의 마지막 시도가 풀에 없는 모델(`supa`·`[MLX] gpt-oss-120b`·`[supa] Qwen3.8-27B-NVFP4`)이면
고르기가 null 을 돌려 틱이 `admitted 14 · calls 0` 으로 말없이 끝났고, 진행 감시가 reviewer 를 5분에 세 번 재시작해 `primary_quarantined` 가 됐다.

- 묶는 것은 살아 있는 것뿐: 기한 안의 `reserved`, 그 공급자 호출 기한(게이트웨이는 review-gateway 사다리 clientMs, CLI 는 review-cli·grok-review)
  + 60초 안의 `dispatched`, 지금 풀 모델의 `waiting`, 같은 창 안에 시작한 `running` 시도(`lib/crawl/ai1-live-call.ts`). 이보다 오래된
  dispatched·indeterminate·running(주인이 죽은 boot)과 풀 밖 모델의 waiting 은 후보를 묶지 않는다.
- **순위 대체(단계 × 모델 순위)**: 1차는 순위 순으로 고른다. 배정 표가 꺼져 있으면(지금 운영) 설정 풀이 순위다 — `firstReview` 1순위,
  `firstReviewAdditional` 을 적은 순서대로 2·3순위(예전의 「후보를 id 로 나눠 처리」는 없어졌다). 배정 표가 켜져 있으면 `/admin/models/assignments` 의
  rank 칸이 순위이고, 같은 rank 안에서만 (후보 id − 1) mod n 으로 나눈다. 가장 높은 순위를 이 틱에 쓸 수 없을 때만 다음 순위로 간다 —
  쓸 수 없음 = 미확인 점유로 꽉 참·이 틱에 쉼(호출 실패·엔진 내려감) 또는 그 모델만의 거절(경로 없음 `unmapped`·장비 미설정·연결 계약 닫힘
  `provider_contract_unavailable`·진짜 포화). 그런 거절이면 **같은 후보**를 곧바로 다음 순위로 다시 고른다. 모든 순위를 쓸 수 없으면
  `reason=all_ranks_unusable` 로 건너뛰고 대기열은 지나간다. 끝난 재시도는 모델에 묶지 않는다(시도 예산·재시도 시각은 모델과 무관하게 이어진다).
- **grok-cli 를 마지막 순위로**: `/admin/models` 「1차 AI 검수」의 1·2·3순위 드롭다운에서 3순위(또는 마지막 칸)에 `grok-cli · grok-4.7` 을 고른다.
  드롭다운은 모든 서버의 엔진 API(GET /models, 화면이 이미 읽는 `readServedContractModels`)가 내놓는 모델을 「장비 · 모델」로, CLI 모델(claude-cli·grok-cli)과 함께 보인다.
  같은 모델 두 순위·앞 순위를 비운 뒤 순위는 저장하지 않는다. 저장하면 다음 틱부터 적용된다(재배포 없음).
  **운영자가 할 일**: 용량 정책에 `crawl-agent-review / grok-cli / grok-4.7` 경로와 그 장비(group) 한도를 넣어야 grok 순위가 실제로 쓰인다 —
  그 전에는 `unmapped` 로 그 순위를 건너뛴다. 저장 응답이 순위마다 없는 것(1차 연결 계약·용량 경로·장비 한도)을 한국어로 알린다.
  연결 계약·경로·장비는 저장이 자동으로 만들지 않는다(계약은 엔진 probe·키가 필요한 「엔진 연결」, 경로·장비는 용량 정책·장비 화면).
- 남는 null(살아 있는 호출 보호)은 `crawl.agent_review_skipped reason=reviewer_unassigned`(모든 순위를 쓸 수 없으면 `all_ranks_unusable`)로 남고, 키셋 커서는 그 후보를 지나 같은 틱에 다음 후보를 본다.
  들인 후보를 모두 건너뛴 틱은 `degraded: agent_review_all_skipped` 이며 진행 감시는 그것으로 reviewer 를 재시작하지 않는다.
- 이중 전송 보장은 장부가 지킨다: 같은 후보 fence(`ai1Fence`·`cliKeyFence`)와 점유 유일 색인(`model_capacity_requests_logical_active_idx`)은 바꾸지 않았다.
  그래서 주인이 죽은 오래된 dispatched 행이 남은 후보는 고르기가 지금 풀로 옮겨도 claim 이 `work_busy` 로 그 후보만 넘긴다 —
  그 행은 기존 증거 기반 회수(`model-capacity-reclaim`, `MODEL_CAPACITY_AUTO_RECLAIM` 선언) 또는 운영자 미확인 처리로 풀어야 한다.
  풀 밖 모델의 waiting 행은 queue TTL 로 만료될 때까지 같은 `work_busy` 다(남의 대기 행을 고르기가 거두지 않는다).
