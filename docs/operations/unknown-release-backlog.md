# 미확인 요청 2건 해제 차선 — 남은 일 목록

실행서: [2026-10-29-unknown-release-runbook.md](2026-10-29-unknown-release-runbook.md). 작업자는 원격 명령, 운영 DB 쓰기, 0143을 실행하지 않는다.

## 끝남 (2026-10-29, 브랜치 `xaegis/4ed4ea33`, 기준 main 75b8aa31)
- C1 PR721 근거 목록: 실행서 A-1(항목·출처·형식).
- C2 수집 스크립트: `scripts/ops/release-29877f65/collect-m1.sh`(device_admin root, 읽기 전용), `collect-docker.sh`(xa-ssh m3ultra/mini, 읽기 전용). 묶음 JSON은 stdout, sha256은 stderr.
- C3 조립·실행: `assemble.ts`(preflight/plan/receipt/readback, DB는 READ ONLY), `wire.ts`(0507685d/81d1f571 재현), `in-container.sh`(유지보수 컨테이너 단계 실행기). 0143 전/후 구분은 실행서 A-2~A-4.
- D4 Supa: 컨테이너 안 runner는 불가하다(이미지에 python3·ssh 없음, maintenance 키 금지). 대안 A(gpu3090 실제 셸)의 prepare→root argv→run 전 과정과 신뢰 경로·handoff·task sha 확인은 실행서 B.
- D5 최소 코드: `scripts/ops/release-65f8c399/build-manifest.py`(manifest/profile 생성, adapter identity AST 동일 시험). runner·신뢰 경로 코드는 바꾸지 않았다.

## 남음 (대표 실행)
- M1: 실행서 C1~C7(지금 가능) → 0143 승인·적용 → D1~D10.
- Supa: 0143/0144 적용 + main 표준 배포(웹에 job 접수 버튼) → S1~S14.
- 해제 뒤 30분 동안 모델별 성공·AI1/AI2·새 미확인 0을 실측한다(실제 영수증으로만 기록).

## 막힘·위험
- M1 relay를 Gemma handoff로 재시작하면 recovery.newRelayPid ≠ 현재 PID가 되어 A 경로가 영구적으로 막힌다. M1 해제 전에는 재시작하지 않는다.
- Supa: 06:33Z 이후 M3 reviewer가 재배포됐으면 owner 교체로 prepare가 거절된다(이 경로로는 해제 불가).
- 직접 5432 URL이 컨테이너 DATABASE_URL 계정으로 연결되지 않으면 중단한다(우회 금지).
