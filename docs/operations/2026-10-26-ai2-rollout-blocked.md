> 과거 중단 시점의 기록입니다. 이후 복구와 AI2 전환을 완료했습니다. 현재 상태는 [AI2 전환 결과](2026-10-26-ai2-native-recovery.md)를 참고하세요.

# AI2 운영 전환 실측과 현재 중단 지점

2026-10-26 KST. 요청: GPU3090 Tailscale 직접 연결을 AI2 주모델로, abcLLM Supa를 대체로 사용. 양쪽 no-thinking, 출력 최대10,000 / 입출력 합계32,000.

## 확인한 것

- PR664 구현과 PR665 배포 명령 검사 수정은 main에 병합됐다. 최종 main은 `17cef1f8dd99f1495e810a2bcaa4a76e58a39e23`.
- PR665 범위 Python30건과 필수 GitHub CI40210642469가 통과했다. 추가 전체 수동 검사는 하지 않았다.
- AI2 consumer의 직접 연결 지원과 두 startup contract는 운영에 설치됐다. 새 토큰 제한의 abcLLM 실제 검수2건이 DB에 저장되고 용량 장부도 정상 정산된 증거가 있다. GPU 주모델 설정은 아직 선택하지 않았다.
- 정규 배포에서 text/maintenance/scheduler 각 mini·M3와 connect-agent M3, 총7개 앱은 새 버전 배포 영수증이 있다. 나머지11개 배포는 요청되지 않았다.

## 현재 막는 실제 요청

- Request: `d4354687-9839-46b4-88ac-293700e1d349`
- Route: `product-search-verify`, provider budget `abcllm-supa`, physical group `supa`.
- Owner: `m3-text`, boot `7f36d455-ec81-43b7-a7e0-a9784286946e`.
- Dispatch: 2026-10-25 16:24:40.093 UTC. 16:24:54.135 UTC에 local_abort, 16:24:54.184 UTC에 gateway_local_end가 기록됐다. 실제 원격 terminal은 없다.
- Supa 그룹 한도1을 이 indeterminate가 점유한다. 실측16:31 UTC에는 AI2 abc22건이 waiting, 최근 AI2 완료는16:22:34 UTC였다.
- 배포는 이로 인한 second/no_progress 한 가지 알람으로7개 배포 뒤 멈췄다. 다른 단계/role/lane은 당시 정상이다. 실패한 run을 재실행하거나 once를 지우지 않았다.

## 재개를 위해 제안하는 구체적 조치 — 미실행

이 조치는 AI2 설정만 바꾸는 범위를 넘어 공유 abcLLM/Supa의 다른 모델 호출도 잠시 중단할 수 있다. 2026-10-26 사용자가 ‘응’으로 실행을 승인했다. 새 원 요청 종료 증거와 실제 경계 plan을 준비 중이다.

1. 새 요청에 대한 새 plan으로 capacity를 공식 draining으로 바꾸고 기존 정상 호출의 종료를 기다린다. 위 unknown은 강제로 정산하지 않는다.
2. 해당 owner와 양 abcLLM gateway, Supa 추론 엔진의 실제 incarnation을 새 plan에 고정한다. owner → gateway → Supa 순서로 실제 종료 및 재시작 방지 증거를 수집한다. 기존 요청의 once/receipt는 재사용하지 않는다.
3. 공식 `scripts/ops/model-provider-boundary-release.ts`로 위1건만 withdrawn 처리한다. 원격 종료가 입증되지 않으면 처리하지 않는다. 업무 성공이나 사용량은 만들지 않는다.
4. 모델 서비스 복원과 새 incarnation을 확인하고, 실제 혼합 버전을 기준으로 새 정규 배포 계획을 만든다. 완료된7개 앱의 배포는 반복하지 않는다.
5. 나머지11개 파서 배포 뒤 GPU route1개만 추가하고 voters/fallbacks만 공식 CAS로 변경한다. 재개 후 실제 GPU 검수1건의 DB 저장과 장부 정상 종료를 확인한다.

abcLLM의 입증된 원격 hard deadline이 없어 로컬 종료 기록/HTTP timeout/시간 경과만으로 unknown을 해제할 수 없다. 독립 서브에이전트의 소스 검토도 이 점을 확인했다. 관련 근거: `lib/operations/dr/call-drain.ts`, `lib/operations/dr/reclaim.ts`, `docs/operations/2026-10-17-dr-reclaim-runbook.md`.

## 남은 작업

승인된 공유 모델 회수의 새 실제 경계 plan/receipt, 나머지11개 배포, GPU 주모델/abc fallback 설정 활성화, 실제 GPU 검수 저장 확인. 현재 capacity는 open/epoch1/revision2이며 새 GPU policy와 voters는 적용되지 않았다. GPU 운영 검수가 성공했다고 주장하지 않는다.
