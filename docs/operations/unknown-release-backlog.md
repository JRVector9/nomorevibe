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
