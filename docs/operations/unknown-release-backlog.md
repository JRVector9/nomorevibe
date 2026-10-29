# 미확인 요청 2건 해제 차선 — 남은 일 목록

**실행 순서 확정본: [2026-10-29-release-order.md](2026-10-29-release-order.md).** 세부 명령은 실행서 [2026-10-29-unknown-release-runbook.md](2026-10-29-unknown-release-runbook.md)와 [2026-10-29-monitor-gate-pause-plan.md](2026-10-29-monitor-gate-pause-plan.md)에 있다. 작업자는 원격 명령, 운영 DB 쓰기, 0143을 실행하지 않는다.

## 끝남 (2026-10-29, 브랜치 `xaegis/4ed4ea33`, 기준 main 75b8aa31)
- C1 PR721 근거 목록: 실행서 A-1(항목·출처·형식).
- C2 수집 스크립트: `scripts/ops/release-29877f65/collect-m1.sh`(device_admin root, 읽기 전용), `collect-docker.sh`(xa-ssh m3ultra/mini, 읽기 전용). 묶음 JSON은 stdout, sha256은 stderr.
- C3 조립·실행: `assemble.ts`(preflight/plan/receipt/readback, DB는 READ ONLY), `wire.ts`(0507685d/81d1f571 재현), `in-container.sh`(유지보수 컨테이너 단계 실행기). 0143 전/후 구분은 실행서 A-2~A-4.
- D4 Supa: 컨테이너 안 runner는 불가하다(이미지에 python3·ssh 없음, maintenance 키 금지). 대안 A(gpu3090 실제 셸)의 prepare→root argv→run 전 과정과 신뢰 경로·handoff·task sha 확인은 실행서 B.
- D5 최소 코드: `scripts/ops/release-65f8c399/build-manifest.py`(manifest/profile 생성, adapter identity AST 동일 시험).

## 끝남 (2026-10-29, 브랜치 `xaegis/7b7a2d23`, 위 브랜치와 `xaegis/4cefcc24` 포함)
- E1 순환 의존 확정(코드 근거는 확정본 1절): ① 배포 `model_replacement_gate`는 미확인 0건을 요구한다(web도 모델 owner, 일부 앱만 고르는 plan 옵션 없음). ② 운영 웹 199a3ebb에는 ops-runner가 없어 Supa job을 접수할 수 없었다. ③ runner는 DRAIN이면 시작을 거절한다. ④ runner가 끝에 OPEN하는데, M1·배포는 DRAIN을 요구한다. 그 OPEN이 deferred route로 거절되면 job이 영구 blocked가 되어 이후 접수를 모두 막는다.
- E2 해소 구현: 운영자 셸 접수 CLI `scripts/ops/admin-models-ops-submit.ts`(웹과 같은 `submitModelOpsCommand`, 기본 READ ONLY 미리 보기). profile `finalAdmission:"draining"` → 마지막 단계 `handoff`(capacity 무변경, 자기 DRAIN 핀 + FOR UPDATE 확인 + 감사). `build-manifest.py --final-admission=draining`. 배포 뒤 OPEN 실행기 `scripts/ops/release-order/capacity-control.sh`(status/routes/open, 허용 플래그 없음). 관리 화면 카드에 인계 단계와 안내를 추가했다.
- E3 확정본 `2026-10-29-release-order.md` 작성(20단계, 위치·명령·전제·성공·실패, [승인] 표시, 실패 경로).
- E4 문서 모순 수정: 실행서의 「Supa는 배포 뒤 시작」·「웹 버튼으로만 접수」·「S14 OPEN까지」·「T=75b8aa31」, 관문 문서 6절의 「M1은 model-provider-boundary-release --relay-state-dir」·「deploy plan에 --migration-verified 없음」·「OPEN 명령 위치」.
- 시험: 바꾼 영역 Vitest 14파일/130 → 17파일/145 PASS, Python 3 → 4 PASS, tsc·ESLint 0.

## 끝남 (2026-10-29, 브랜치 `xaegis/e84f26ca`, `xaegis/7b7a2d23` fast-forward 병합)
- F1 결과 확인 재실행: 앞 작업의 실패는 후보 폴더에 node_modules가 없어서였다(`Cannot find module node_modules/vitest`). 공유 node_modules를 symlink로 연결(커밋 안 함, `.gitignore` `/node_modules`)한 뒤 지정 7파일 Vitest **7파일/38시험 PASS**. 코드 수정 없음.
- F2 확정본·두 런북 대조(코드 근거로 확인):
  - 확정본 7단계 「revision은 `REV0+1`」은 틀렸다. `setModelCapacityMode`는 mode·updated_at만 바꾼다. `EPOCH1 = EPOCH0`, `REV1 = REV0`로 고쳤다(실행서 D2/D10의 같은 `1 7`과도 맞음).
  - 실행서 표 0의 `build-manifest.py` 해시가 4ed4ea33 판(`4099b7e0…`)이었다. S5의 `--final-admission`을 받는 7b7a2d23 판 `1d974717…`로 고쳤다.
  - 실행서 S5·S7이 `$SRC` 작업 트리 파일을 직접 실행했다(작업 트리 상태·node_modules에 의존). `$T`(REL archive + node_modules)로 바꿨다. 확정본 표 3에 `$SRC`는 git show/archive 전용이라고 적었다.
  - 실행서 B-3 「A절을 아직 시작하지 않았다」가 0143 전 C1~C7 선행 요구와 어긋났다. 「A-4(D1~D9) 미시작」으로 고쳤다. D1이 `status`로 볼 수 없는 job·감사 확인을 요구하던 문구는 확정본 11단계 읽기를 쓰도록 고쳤다.
  - 확정본 4단계 실패 코드 이름(`ops_runner_request_not_indeterminate`·`ops_runner_id_conflict`)과 exit 3/1 구분을 CLI 코드대로 고쳤다. 2단계 (b) 파일 경로·순서를 고치고, 관문 문서 6절 1번의 R1 사전 확인을 (e)로 넣었다.
  - 그대로 맞는 것: 표 3 SHA-256 10개, 0143/0144 sha256·저널 145항목·0144 인덱스 이름, deploy plan/run 출력 키(`planned`·`planSha256`·`selectedApps`·`serviceMutations`·`model-drain.safe.json`), 관문 문서의 `deploy_release.py`·`deploy_shared_images.py` 줄 번호, `package-lock.json`이 199a3ebb·공유 checkout과 같음(C5·S1 전제), DRAIN은 deferred route 검사 대상이 아님(OPEN만 해당).

## 끝남 (2026-10-29, 작업 공간 `xaegis/da3bd4a3`, `xaegis/e84f26ca` 병합)
- G1 결과 확인 환경 실패 원인: `trustedOpsPath`가 경로의 모든 상위 디렉터리 소유자가 0 또는 현재 uid인지 본다. 샌드박스 UID 매핑에서는 `/`·`/home` 등이 65534로 보여 `tests/ops-runner-operator.test.ts` 13건이 `ops_runner_untrusted_path`로 실패했다. 코드 결함이 아니라 시험이 실행 환경의 상위 소유자에 의존한 것이다.
- G2 수정: `trustedOpsPath`·`readOperatorProfile`·`callOpsAdapter`·`runPreparedModelOps`가 선택 인자 `OpsPathTrust`(`root` 신뢰 루트, `trustedOwner` 소유자 판정)를 받는다. 인자가 없으면 지금과 같다(파일시스템 루트까지 검사, 소유자 0 또는 현재 uid). 운영 CLI `scripts/ops/admin-models-ops-runner.ts`는 이 인자를 넘기지 않는다. 신뢰 루트도 symlink·쓰기 권한·소유자를 똑같이 검사하고, 루트 밖 경로는 거절한다. 검사를 끄는 환경변수·플래그는 없다.
- G3 시험: 경로마다 소유자를 바꾸던 `lstatSync` 흉내 대신 임시 디렉터리(`os.tmpdir()`)를 신뢰 루트로 주입했다. 루트 아래 symlink·group-writable·다른 소유자(주입 판정, 65534 흉내)·루트 밖 경로를 거절하는 시험과, 운영 기본값이 상위 디렉터리 하나라도 65534로 보이면 거절하는 시험을 더했다. 상위를 65534로 흉내 낸 실행에서 옛 시험은 13/13 실패, 새 시험은 통과했다(임시 사본, 커밋 안 함).
- 지정 7파일 Vitest 38 → 40 PASS(시험 2건 추가). ops-runner·admin-models-ops 11파일/60 PASS. `next typegen` 뒤 `tsc --noEmit` 0. 병합해 들어온 `tests/release-order-capacity-control.test.ts`의 spawnSync env 타입 오류는 `NODE_ENV: "test"`를 넣어 고쳤다(대상 sh는 NODE_ENV를 읽지 않는다). 바뀐 파일 ESLint 0.

## 끝남 (2026-10-29, 작업 공간 `xaegis/13018003`, `xaegis/da3bd4a3`·origin/main `c7dad56b` 병합)
- H1 대표 실측 결함: 운영 이미지에 `scripts/ops`가 없다(`.dockerignore` 7행, 199a3ebb·main 같음). 옛 `capacity-control.sh`는 `/app`에서 `pipeline-control.ts`를 실행해 `ERR_MODULE_NOT_FOUND`로 실패했다. 이 때문에 확정본 2단계 (b)와 18단계가 막혔고, 18단계에서 막히면 DRAIN이 남는다. `capacity-control.sh`에 `stage <tar sha256>`를 더했다. 쓰기 전에 tar sha256과 tar 안 lock이 이미지 lock과 같은지 확인하고, 어긋나면 아무것도 쓰지 않는다. 같은 tar면 다시 쳐도 그대로 두고, 풀기는 임시 폴더에서 한 뒤 옮긴다. `node_modules`는 이미지 심링크다. `status`·`routes`·`open`은 스테이징한 소스에서만 실행한다. `.dockerignore` 변경안은 쓰지 않았다(떠 있는 컨테이너에 효과 없음).
- H2 문서에서 `/app/scripts/ops`(컨테이너 안 직접 경로)를 전제한 곳을 고쳤다. 확정본 2절 3번·표 3·2단계 (b)·18단계(C5 재스테이징 + `in-container.sh open`)·5절 실패 경로, 실행서 표 0·C5·D10·B-1, 관문 문서 6절 3·8번이다.
- H3 실제 DB 통합 시험으로 접수 CLI 미리 보기 결함(READ ONLY TX의 `FOR SHARE` → `25006`, 미리 보기·`--execute` 모두 exit 1)을 찾아 고쳤다(`readWriterFence`). 새 통합 시험 `tests/integration/ops-runner-drain-handoff.test.ts`를 넣었다.
- 시험: 지정 7파일 40 → 49, 관련 18파일 175 → 184, 통합 4파일/17 PASS(새 파일 2건 포함, 고치기 전 1/2 실패), tsc·ESLint 0.
- 범위 밖이라 고치지 않은 같은 전제: `docs/operations/2026-10-17-pipeline-control-runbook.md:9`, `docs/runbooks/uptime-gate-transition.md:31`, `docs/runbooks/uptime-split.md:66`은 「maintenance 컨테이너에서 `node --import tsx scripts/ops/…`」를 실행 위치로 적는다. 운영 이미지에서는 같은 이유로 실패한다. 다른 구역 문서라 여기서는 기록만 한다.

## 남음 (대표 실행)
- 확정본 1~20단계. 0143(+0144) 적용·확인 → Supa(OPEN에서 시작, DRAIN 인계로 끝) → M1(인계 DRAIN 안, D2·D10 생략) → 미확인 0 → job-pause → deploy plan(--migration-verified)·run → M1 relay 재설치 → OPEN → job-resume → verify-prod-revision.
- 권장: 이 브랜치를 PR로 main에 병합해 배포 `TARGET`에 넣는다(관리 화면 handoff 표시). 넣지 않아도 안전에는 영향이 없다.
- 해제 뒤 30분 동안 모델별 성공·AI1/AI2·새 미확인 0을 실측한다(실제 영수증으로만 기록).

## 막힘·위험
- M1 relay를 Gemma handoff로 재시작하면 recovery.newRelayPid ≠ 현재 PID가 되어 A 경로가 영구적으로 막힌다. 확정본 17단계(M1 해제 뒤) 전에는 재시작하지 않는다.
- Supa: 06:33Z 이후 M3 reviewer가 재배포됐으면 owner 교체로 prepare가 거절된다(이 경로로는 해제 불가). 배포는 Supa 해제 뒤에만 한다.
- M1이 인계 DRAIN 안에서 막히면 배포할 수 없다. 199a3ebb env에 non-serving route가 있으면 배포 전 OPEN도 거절될 수 있다(확정본 2단계 (b)에서 미리 확인, 5절 실패 경로).
- 접수한 ops-runner job은 `queued`부터 완료 전까지 다른 job 접수를 막는다. 취소 경로가 없다(기존 설계, 이번에 바꾸지 않음). 접수는 이어서 실행할 수 있을 때만 한다.
- 직접 5432 URL이 컨테이너 DATABASE_URL 계정으로 연결되지 않으면 중단한다(우회 금지).
- 운영 실측(미확인 수, route 상태, revision)은 이 환경에서 측정하지 않았다. SSH 22가 막혀 있고 운영 접근이 금지돼 있기 때문이다.
