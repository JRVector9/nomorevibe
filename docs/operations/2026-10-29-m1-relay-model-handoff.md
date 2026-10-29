# M1 relay 모델 수정과 대표 실행 목록

이 차선은 코드·오프라인 시험·PR만 수행한다. M1 설치/재시작, Supa/DB/접수/배포 변경은 실행하지 않았다. 다른 작업49b91700이 현재 운영 중이므로 아래는 **동시에 실행할 절차가 아니다**. 대표가 그 작업과 조정하고 기존 미확인/활성 receipt·lease·계약을 확인한 뒤 등록된 관리자 접근에서 수행할 목록이다. 기존 unknown은 이 변경으로 해제되지 않는다.

## 코드 선택

> 2026-10-29 갱신(`a900db03`, 병합 전): 기본값이 바뀌었다. 아래가 현재 코드다.

relay 허용 모델은 `MODEL_REGISTRY_CONFIG`(없으면 중앙 기본값) 한 곳에서 읽는다. `LOCAL_MODEL_RELAY_EQUIPMENT`(기본 `m1`) 장비의 `relay` 용도 entry가 허용 목록이고, 중앙 기본값에서는 `m1:translation`의 `mlx-community--gemma-4-26b-a4b-it-4bit` 하나다(이전의 GPU3090 Qwen 기본값은 없어졌다). `LOCAL_MODEL_RELAY_MODEL`/`_KEY`는 그 목록의 한 entry로만 고정할 수 있다. 다른 장비의 같은 이름 entry·gateway label·미등록 모델은 `relay_model_not_allowed`, 장비 entry가 없으면 `relay_model_not_registered`. `LOCAL_MODEL_RELAY_MODEL_FAMILY`는 생략 시 해당 entry.family, 지정 시 일치해야 한다. loopback upstream/별도 토큰/경계 보호는 유지한다. Qwen→Gemma 별칭은 없다.

추론 요청은 허용 목록 밖이면 `400 model_not_allowed`, 허용 모델이어도 상류 `/v1/models`에 없으면 `503 upstream_model_mismatch`, 목록 조회 실패는 `503 upstream_models_unavailable`로 영수증·상류 호출 전에 거절한다. health는 `allowedModels`·`upstreamModelMatch`·`upstreamModelReason`을 보인다.

상품과 사유 번역 기본값은 `m1:translation` Gemma entry를 함께 쓴다. 기존 명시적 env/DB 단계 풀은 덮어쓰지 않는다. 이미 versioned JSON을 쓰면 `scripts/migrate-model-registry-m1.ts --print-migration`으로 후보 JSON을 만들고 검토한다. 이 도구는 두 목적의 selection만 M1로 준비하며 DB에 쓰지 않는다. 사유 번역의 기존 ABCLLM_MODEL/KEY override와 DB 단계 풀도 별도 확인해야 한다.

health마다 인증된 고정 `127.0.0.1:8000/v1/models`를 5초/100KB 한도로 읽어 실제 id가 일치해야 한다. 그 확인만으로 native ready가 되지 않는다. 같은 model/family/deployment 계약, root readback hash, 정상 종료 응답·토큰 관측도 계속 필요하다. 모델 목록 불일치·조회 실패·unknown은 ready=false다.

## 대표용 M1 argv (미실행)

각 줄은 실행 파일과 argv다. `<REVIEWED_SHA>`는 CI가 통과한 실제 40자리 커밋으로 대체한다. 2026-10-29 등록부 연결 변경 후에는 그 변경(`a900db03` 후보)이 **병합된 main 커밋**이어야 한다. 그 전 SHA로 설치하면 relay 기본 허용 모델이 옛 GPU3090 Qwen entry에서 나온다. 설치본 경로는 바뀌지 않았다. 새 완전한 설치본(의존성 포함)은 `/var/tmp/nmv-relay-reviewed/<REVIEWED_SHA>`에 대표가 먼저 준비·해시 검토한다. 아래 ditto 목적지 release는 처음 사용하는 경로여야 한다. 이 작업 공간은 장비의 Node 실행 파일 위치와 새 설치본 준비 상태를 확인하지 않았다. 불명확한 값을 추측해 실행하지 않는다.

아래 모든 명령은 `/usr/bin/perl`의 55초 alarm으로 한정한다. 시간 초과/응답 유실은 완료가 아니며 자동 재요청하지 않는다. root 소유 plist, UserName `_nmvllm`, 기존 토큰 파일·state·계약·다른 환경값은 보존한다. bootout은 기존 active/unknown 요청을 확인한 승인된 유지보수 창에서만 한다. plist 변경은 kickstart만으로 재로딩되지 않아 bootout/bootstrap이 필요하다.

```jsonl
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/usr/bin/ditto","/usr/local/nmv-llm-relay/current","/usr/local/nmv-llm-relay/backup-before-model-fix"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/bin/cp","-p","/Library/LaunchDaemons/bot.brut.nmv-llm-relay.plist","/usr/local/nmv-llm-relay/plist-before-model-fix.plist"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/usr/bin/ditto","/var/tmp/nmv-relay-reviewed/<REVIEWED_SHA>","/usr/local/nmv-llm-relay/releases/<REVIEWED_SHA>"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/usr/sbin/chown","-R","root:wheel","/usr/local/nmv-llm-relay/releases/<REVIEWED_SHA>"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/bin/chmod","-R","a+rX,go-w","/usr/local/nmv-llm-relay/releases/<REVIEWED_SHA>"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/bin/launchctl","bootout","system/bot.brut.nmv-llm-relay"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/bin/ln","-sfn","/usr/local/nmv-llm-relay/releases/<REVIEWED_SHA>","/usr/local/nmv-llm-relay/current"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/usr/bin/python3","-I","-c","import os,plistlib,pathlib; p=pathlib.Path('/Library/LaunchDaemons/bot.brut.nmv-llm-relay.plist'); s=p.lstat(); assert os.geteuid()==0 and s.st_uid==0 and not p.is_symlink() and not s.st_mode&0o022; d=plistlib.loads(p.read_bytes()); assert d['UserName']=='_nmvllm'; e=d['EnvironmentVariables']; e.update(LOCAL_MODEL_RELAY_MODEL='mlx-community--gemma-4-26b-a4b-it-4bit',LOCAL_MODEL_RELAY_MODEL_FAMILY='gemma4-26b',LOCAL_MODEL_RELAY_VERSION='<REVIEWED_SHA>'); p.write_bytes(plistlib.dumps(d))"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/usr/bin/python3","-I","-c","import os,pathlib; p=pathlib.Path('/usr/local/nmv-llm-relay/config.env'); s=p.lstat(); assert os.geteuid()==0 and s.st_uid==0 and not p.is_symlink() and s.st_mode&0o777==0o600; lines=[x for x in p.read_text().splitlines() if not x.startswith(('MODEL=','MODEL_FAMILY=','CURRENT_SHA='))]; p.write_text('\\n'.join(lines+['MODEL=mlx-community--gemma-4-26b-a4b-it-4bit','MODEL_FAMILY=gemma4-26b','CURRENT_SHA=<REVIEWED_SHA>'])+'\\n')"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/usr/bin/plutil","-lint","/Library/LaunchDaemons/bot.brut.nmv-llm-relay.plist"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/bin/launchctl","bootstrap","system","/Library/LaunchDaemons/bot.brut.nmv-llm-relay.plist"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/bin/launchctl","kickstart","-k","system/bot.brut.nmv-llm-relay"]}
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/usr/bin/python3","-I","-c","import subprocess; r=subprocess.run(['/bin/launchctl','print','system/bot.brut.nmv-llm-relay'],capture_output=True,text=True,timeout=10); print('launchd_readback_exit',r.returncode); print('\\n'.join(x for x in r.stdout.splitlines() if x.strip().startswith(('state =','pid =','last exit code ='))))"]}
```

backup 목적지는 **처음 사용하는 경로**여야 한다. 기존 backup을 덮어쓰지 않는다. 단순 kickstart는 이미 bootstrap되어 실행 중인 서비스를 한 번 더 재시작하므로 정상 시작됐으면 해당 줄은 실행하지 않고 유지 확인한다. 기존 `config.env`를 사용하는 이후 upgrade/status에는 `MODEL`·`MODEL_FAMILY`를 같은 값으로 보존해야 한다. 새 installer는 `--model`/`--model-family`를 config와 plist에 함께 기록한다. 실제 배포 revision/서빙 계약/root readback은 관측 근거로 별도 갱신하며 이번 코드 SHA로 모델 deploymentRevision을 꾸미지 않는다.

검증: 최초 범위5파일/34시험 PASS. `verify-model-config` 첫 실행은 사유·소개·검색의 예전 공용 상수를 쓰던 fixture 등35시험 실패(953 PASS)를 보존했다. 각 독립 용도의 실제 상수로 fixture를 고쳐 재검증한다. main typegen/tsc는 수정 전 통과하여 보고된 TS2353은 재현되지 않았다. 실제 M1 실행·native readiness·번역 저장 품질은 측정 없음(운영 금지 범위).

최종 확장 검증: verify-model-config 72파일/1,032시험·typegen·tsc PASS, 모델 이름 리터럴(같은 git grep, 기준199a3ebb)158→99. 추가 회귀7파일/64시험 PASS. 사유 번역 job의 기본 예산은 M1 entry의40초 상한을 따르며 그 fixture도 갱신했다.
