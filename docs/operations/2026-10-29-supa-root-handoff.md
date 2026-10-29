# Supa root 작업의 관리자 실행과 runner 근거 수집 분리

코드·시험·PR 전용 결과다. 운영 DRAIN/정지/복원/해제/DB 쓰기/배포0, Supa/M1 접근·설정 변경0. 기존 차선49b91700과 PR721의 removed-boundary 코드는 수정하지 않았다.

기존 해제 차단 기록은 커밋 `a75015f7`의 `docs/operations/2026-10-29-supa-65f8c399-release.md`로 확인했다. 기록의 UID1000은 root로 취급하지 않는다. jr의 sudo -n/systemctl, 새 권한·계정·접근 경로를 만들지 않는다.

## 설치와 manifest의 명시적 선택

최소 변경으로 기존 직접 root SSH 방식은 보존하고 Supa provider에만 `rootHandoff:true`를 **명시**할 때 새 방식을 쓴다. manifest의 `requiresSudo:false`는 runner가 sudo를 실행하지 않는다는 뜻이며, 대표의 외부 관리자 작업을 대신 승인하는 값이 아니다. 전역 `requiresSudo:true`와 M1 수동 경계 보호는 그대로 거절한다.

provider target은 `role:provider`, `kind:systemd`, identity.host=`supa`, progressRoot=`/var/lib/nmv-admin-models-root/progress`여야 한다. 기존 unit/boot/InvocationID/PID/startTicks/namespace/config snapshot과 요청·manifest 해시는 모두 유지한다. sourceHashes에 `systemd_handoff.py`의 실제 해시를 추가하고, 변경된 systemd_action.py/systemd_reader.py 해시도 다시 검토해야 한다. 이전 manifest의 해시를 자동 대체하지 않는다.

대표가 등록된 관리자 접근에서 세 helper를 `/usr/local/libexec/nmv-admin-models`에 root 소유로 설치해야 한다. 모든 상위 경로가 root 소유·symlink 없음·다른 계정 쓰기 불가여야 한다. root 결과는 `/var/lib/nmv-admin-models-root/results/<taskSha256>.json`에 root 소유0644로 쓰고 상위 디렉터리는 root0755다. jr는 결과를 읽을 수 있지만 바꿀 수 없다. private progress는 root0700/0600을 그대로 쓴다. root helper와 결과를 jr 소유 작업 폴더에 두거나 sudo로 runner 전체를 실행하지 않는다.

## 단계별 동작

1. 기존 runner `prepare`는 owner→gateway 두 곳→Supa를 **읽기만** 확인한다. rootHandoff인 Supa는 operatorUid1000이어도 다른 물리 snapshot 전체가 일치해야 한다. stop/restore 각각 별 nonce·작업ID·manifest hash·원래 identity·helper hash에 묶인 frozen task를 만든다. 실제 절대 실행 파일·argv·staging/result 경로를 private `<jobId>.root-handoff.json`에 기록하고 CLI가 그 경로를 출력한다. 공개 OpsState/감사/UI에는 argv를 복사하지 않는다. prepare는 DRAIN하지 않는다.
2. 대표는 frozen task와 helper를 검토·전송한다. **prepare에 출력됐다고 stop을 먼저 실행하지 않는다.** 운영 충돌 조정 후 runner가 DRAIN 및 owner/gateway 중지·종료 검증을 완료하여 `stop/supa_root_result_required`로 기다릴 때만 stop argv를 실행한다. root helper도 원래 identity·두 번의 native idle 관측·source hash를 재확인한 다음 정확한 vllm.service를 한 번 중지한다.
3. 같은 runner `run`을 이어가면 root 결과의 안전한 경로/소유권과 exact task hash를 검증한다. ACK만으로 해제하지 않는다. 그때 실제 boot, unit/config hash, inactive/MainPID0, **재귀 전체 cgroup 비어 있음**, 원래 PID/startTicks 부재를 다시 읽고 기존 V1 proof/plan/receipt 검증으로 넘긴다. read 권한 부족/프로세스 존재/파일 변경은 이유를 반환하고 차단한다. 시간 경과는 해제 근거가 아니다.
4. 기존 release가 증거 검증을 통과한 뒤 역순 복원의 provider 차례에 `restore/supa_root_result_required`로 기다린다. 대표가 restore argv를 실행한 후 runner를 이어간다. root ACK와 **현재 health+원래 config+동일한 새 invocation**을 다시 확인하고 나머지를 역순 복원한다. 전부 검증돼야 기존 OPEN 단계에 도달한다.

각 root helper 실행은 alarm55초로 끝난다. stop/start는 systemctl `--no-block`이다. 종료/기동이 늦으면 영수증은 만들어지지 않아 runner가 차단된다. 결과가 불명확한 경우 같은 frozen argv의 후속 실행은 private attempt marker/기존 durable ACK를 읽는 **재확인만** 하며 stop/start를 재전송하지 않는다. ACK가 없으면 계속 차단한다. 이미 결과가 있으면 실행 재요청은 거절하고 runner의 읽기 수집만 수행한다. 자동 root 실행·자동 변이 재시도·SQL 직접 해제·보호 우회는 없다.

## 대표용 Supa argv 목록 (미실행)

아래는 설치 형식이다. `<REVIEWED_SOURCE_DIR>`은 대표가 해시 검토한 세 Python 소스가 놓인 절대 경로다. root 설치 전 각 소스 SHA-256을 frozen manifest.sourceHashes와 비교한다. 각 줄은55초 제한의 독립 명령이며 성공 여부를 확인한 뒤 다음 줄로 진행한다. 기존 동일 경로의 설치물이 있다면 먼저 그 작업의 진행 중 여부와 기존 해시를 보존·검토해야 한다. 같은 시각 작업49b91700이 사용하는 설치물을 덮어쓰지 않는다.

```jsonl
{"executable":"/usr/bin/timeout","args":["55","/usr/bin/install","-d","-o","root","-g","root","-m","0755","/usr/local/libexec/nmv-admin-models","/var/lib/nmv-admin-models-root","/var/lib/nmv-admin-models-root/results"]}
{"executable":"/usr/bin/timeout","args":["55","/usr/bin/install","-d","-o","root","-g","root","-m","0700","/var/lib/nmv-admin-models-root/progress"]}
{"executable":"/usr/bin/timeout","args":["55","/usr/bin/install","-o","root","-g","root","-m","0644","<REVIEWED_SOURCE_DIR>/systemd_action.py","/usr/local/libexec/nmv-admin-models/systemd_action.py"]}
{"executable":"/usr/bin/timeout","args":["55","/usr/bin/install","-o","root","-g","root","-m","0644","<REVIEWED_SOURCE_DIR>/systemd_reader.py","/usr/local/libexec/nmv-admin-models/systemd_reader.py"]}
{"executable":"/usr/bin/timeout","args":["55","/usr/bin/install","-o","root","-g","root","-m","0644","<REVIEWED_SOURCE_DIR>/systemd_handoff.py","/usr/local/libexec/nmv-admin-models/systemd_handoff.py"]}
{"executable":"/usr/bin/python3","args":["-I","/usr/local/libexec/nmv-admin-models/systemd_handoff.py","execute","/var/tmp/nmv-supa-root-<STOP_TASK_SHA256>.json","<STOP_TASK_SHA256>"]}
{"executable":"/usr/bin/python3","args":["-I","/usr/local/libexec/nmv-admin-models/systemd_handoff.py","execute","/var/tmp/nmv-supa-root-<RESTORE_TASK_SHA256>.json","<RESTORE_TASK_SHA256>"]}
```

마지막 두 줄은 서로 다른 시점의 명령이다. 실제 argv는 prepare/대기 시 생성된 private 파일의 `commands[].executable,args`를 그대로 사용한다. 현재 운영 snapshot·새 접수ID·manifest가 없으므로 이 보고에서 가짜 task hash를 채우지 않는다. 결과 파일 위치도 `commands[].resultPath`로 나온다. 별도 root chmod·결과 내용 편집·오래된65f8c399 receipt 재사용은 금지다.

runner의 기존 `prepare|run UUID --profile=... --state-dir=...` CLI는 유지된다. 운영자가 현재 상태/락/다른 작업 진행을 확인한 뒤에만 사용하는 명령이며 이 차선에서는 실행하지 않았다. 결과가 없으면 `supa_root_result_required`; path/hash/identity/cgroup 문제가 있으면 그 검증 이유 또는 `root_installation_or_evidence_unproven`으로 차단한다.

## 실제 로컬 검증

- 기존4파일/26시험 PASS 후 새 분기를 추가했다.
- Supa 범위9파일/43 Vitest 시험 PASS. 이 중1시험은 Python unittest14건을 실제 실행한다. root/nonroot/소유권·symlink·writable parent, 다른 task/nonce/요청/manifest/identity, 실제 현재 cgroup 대조, stop·restore 응답 유실의 읽기 재확인, 현재 새 incarnation 대조, private argv와 공개 감사 분리를 포함한다.
- SSH/systemctl/DB 호출은 모두 합성 경계다. 실제 장비 설치·관리자 실행·종료·해제·복원·OPEN은 검증하지 않았다. 화면 변경이 없으므로 UI 클릭/스크린샷 대상 없음.
