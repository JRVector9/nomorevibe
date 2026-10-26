# 현재 인계 — 2026-10-27, PR686 배포 전

## 목표와 작업 경계

사용자가 요청한 운영 자동화·정체 복구와 상세페이지3건을 실제 배포·확인까지 마무리한다. PR685 운영 복구를 완료했고, 검색 프로필 예약 이어받기 결함을 고친 PR686은 필수 자동 CI 성공 후 병합했다. 새 main의 필수 CI·웹/워커 이미지 준비를 확인했고, root가 공식 전체18 계획을 생성 중이다. 전체18앱 배포·최종 영수증·새 관측은 아직 미완료다.

- 모델은 `gpt-6.1-sol`, reasoning `xhigh`. 스킬을 사용하지 않는다.
- **2026-10-26 14:37 UTC 이후 추가 수동 테스트·lint·tsc·컴파일 금지**. 필수 자동 CI는 유지한다. 작성한 회귀 테스트를 실행했다고 기록하지 않는다.
- 운영·SSH·API·Keychain·DB·GitHub·git 작업은 root만 담당한다. 기존 once를 지우거나 실패한 요청을 자동 재시도하지 않는다.
- 이번 문서 단계에서 수정한 파일은 `docs/CODEX_HANDOFF.md`, `docs/operations/2026-10-26-pr-priority-progress.md`, `PENDING.md` 세 개뿐이다. PENDING의 2026-10-25 이하 본문은 원바이트를 보존했다.

## 현재 실제 상태

| 항목 | 확인한 결과 |
|---|---|
| main·이미지 | PR668–679·681–686 병합. 최신 main `34cc2045cbb7105313861792adb37c035b64e70c`. PR686 필수 CI40382748901 전체 성공; 새 main CI40383949515의 필수 check·웹/워커 이미지 발행도19:08 UTC대에 모두 성공. 검증한 PR tree·이미지를 재사용했으며 진행 중 refresh-caches는 관문이 아님. 운영 Connect는 이전20493 유지 |
| DB | 0137까지 journal138개, 실제 적용·전체 사후 검증 완료. 완료 영수증 SHA `4cec42a948f8e5ed9882598ffeb1ea0017f7b12bd5ac0341289d353c47d73acf` |
| 정확한 요청 회수 | 6c 요청은 실제 Docker die 종료 코드1·작업/컨테이너 삭제·새 전체0 증거로 감사20474에서 withdrawn. C272000·settled_at NULL·사용량 미확정 보존. 모델 정상 종료나 업무 성공으로 세지 않음 |
| ConnectAgent | 20493 소스·OCI·healthy1·종료 유예240초 실제 확인. 종료 때 새 실행 차단/180초 대기와 동일 네이티브 바이너리 직접 exec 적용 |
| 접수 제어 | 공식 OPEN 감사20475 완료. 과거 DRAIN20472는 이력 |
| 나머지17앱 | 기존50f 소스 유지. AI2 컨테이너 한 건의 자동 교체는 같은 API·spec·이미지·설정임을 별도 실제 증거로 검증 |
| 최신 일반 관문 | **2026-10-26 18:54:22 UTC** stock monitor에서 다섯 역할·scheduler·전체 progress=ok 실제 통과. 현재 표본이며 PR686 배포·이후 관측의 통과 증거는 아님 |
| PR686 | head `4fd6981b61cd447fd237dfc274a1fb561a3cf6b4`, CI40382748901 전체 성공. **2026-10-26 19:07:47 UTC** main으로 병합; 소스·테스트 파일 유지. 운영 배포는 아직 미완료 |
| 전체18 계획·실행 | root의 공식 plan 세션24626이19:09 UTC부터 진행 중. 경로 `STATE/full18-release686-20261027-a`, 새686 운영자·정확한34cc·`--migration-verified`. 아직 plan 파일·서비스 POST·실제 run 없음 |
| 최종 인증·관측 | 최신 전체18앱 최종 영수증과 새 observer 결과 없음. 과거12:57 인증은 당시 상태만 증명 |

최신 관문 영수증은 `STATE/normal686-preflight-monitor-readback-20261027-a.private.json`, SHA `8f2ce086fdf5ec5f73503fb8c655709180ed76a54aa946dd6b981c7e0ed8a09f`다. `STATE`는 `/Users/jr/.local/state/nomorevibe-reliability-20261025`다. 원문에는 민감한 설정이 있으므로 공개 응답·Git에 넣지 않는다.

## 추가 결함과 PR686

새 제품 순으로 12개를 고르는 동안 이전 자기 소유 예약 제품이 범위 밖으로 밀렸다. coordinator가 이번에 고른 work key만 이어받아, grant가 난 기존 제품이 실제 호출 없이 만료됐다. 실제11개 grant 중10개 미사용 만료와 제품 rank17/19/24를 확인했다. 영구 예약 점유나 공급자 과부하로 단정하지 않는다.

PR686의4파일 수정은 자기 소유·같은 boot·현재 정책·route/model·현재 입력 해시가 맞는 미시작 waiting/reserved 작업을 새 후보보다 먼저 이어받는다. 기존 dispatch·role/job/control·binding·C·CAS 검증은 유지하며 취소·환불·품질·모델·한도·일반 관문을 바꾸지 않는다. 독립 소스 검토 완료, 회귀 테스트는 작성만 했고 수동 실행하지 않았다.

첫 자동 CI `40381826340`의 integration-ledger8건은 `runtimeRoleLease`의 추가 owner 필드가 strict Zod 입력에 전달되어 실패했다. SQL 실패가 아니다. domain에서 `instanceId`·`bootId`만 명시적으로 투영하는2줄을 수정했고 strict schema·dispatch·테스트는 유지했다. root+독립 소스 검토 완료 후 위4fd6981b를 push했고, 후속 필수 CI40382748901은 전체 성공하여 병합했다. 당시 다른 CI shard는 통과 중이었지만 integration1·5는 실행 중이었으므로 이전 CI 전체 통과를 주장하지 않는다. 원 로그는 `STATE/ci686-ledger-job.private.log`에 보존하며 원 파라미터를 문서에 싣지 않는다.

**18:56:10 UTC** 실제 읽기 `STATE/text-job-errors686-20261027-a.private.json` SHA `ade300c0991de0c9f8e856e2aab072c6099616a4aa2be536fa0cbfa5f75f8a5c`에서 KO `has_error=true`, 나머지5작업은 false였다. 오류를 reset하지 않았고 새 DRAIN 변경도 없다. 18:54 관문 통과를 durable KO 오류 해소나 이후 통과로 확대하지 않는다.

- 소스 WT: `/Users/jr/Desktop/projects/nomorevibe-profile-owned-queue-resume-20261027`, branch `codex/profile-owned-queue-resume-20261027`.
- 새 깨끗한 운영자 WT: `/Users/jr/Desktop/projects/nomorevibe-release-686-20261027`, 정확한 main `34cc2045cbb7105313861792adb37c035b64e70c`, node_modules는685 운영자에 연결. 이전 `/Users/jr/Desktop/projects/nomorevibe-release-685-20261027`은 보존한다. 새 main CI·이미지 준비 확인 완료. 현재는 공식 plan 진행 중이며 배포 완료로 세지 않는다.
- 문서 WT: `/Users/jr/Desktop/projects/nomorevibe-ops-delivery-report-20261026`, branch `codex/ops-delivery-report-20261026`. PR680은 아직50f 기반 draft이며 root가 최신 main을 통합해야 한다.

## 완료 범위와 남은 사용자 확인

- 상세 UI: PR672 정보·설명 유지/높이 약13.7% 절감·모바일2열·라이선스 줄바꿈, PR670 최신 업데이트3개, PR673 개인 숫자ID·조직 저장소 증명 파일 경로. 운영 두 웹의 익명 화면은 **2026-10-26 13:19:31 UTC** 데스크톱1280/모바일375에서 확인했다. 실제 OAuth·claim·멤버 관리·30일 재검증·파일 삭제 회수는 미실행이다.
- AI2: GPU3090 Tailscale 직접 기본 `qwen3.8-flash-next`, abcLLM Supa Qwen3.8 대체, no-thinking·총32k/출력10k를 유지했다. 번역 품질 기준도 바꾸지 않았다.
- 운영 판단: OPEN의 capacity waiting을 progress 통과로 바꾸는 예외는 없다. 공식 일반 관문이 실제 통과해야 한다. 실제 유지보수 DRAIN은 별도 감사·새 계획이 필요하며, 그 관문을 OPEN 정상 인증으로 기록하지 않는다.
- KO의 과거 last_error는 정상 ACK한 `done:false`도 지우지만, capacity/DRAIN deferred는 보존한다. 새 출력 일부만으로 durable 오류 해소를 단정하거나 직접 reset하지 않는다.
- 미완료: 새 전체18 인증/monitor UP·두 수신처, 새5·10·15분/6시간 및 별도24시간 관측, 실제 소유권 사용자 경로, 백업/PITR/보존기간·용량·nonempty media_assets 복원, 독립 사람 라벨5개/assist 적용 꺼짐 등 `PENDING.md`의 기존 검증.

## root의 다음 순서와 명령

1. PR686 병합 및 새 main CI40383949515의 필수 check·웹/워커 이미지 준비 확인 완료. root가 아래 새 운영자에서 **공식 plan 세션24626**을 실행 중이다. 새 계획을 중복 시작하지 않는다. 아직 plan 파일·서비스 POST·run은 없다.
2. 진행 중인 `STATE/full18-release686-20261027-a` 계획의 실제 결과·hash를 수집한다. 아래 명령은 동일한 공식 진입점의 기록이며 진행 중 plan을 다시 실행하라는 지시가 아니다. 새 실제 혼합 baseline·DB138·모든 일반 관문을 확인한다. 텍스트 쌍 전용 `--apps`는 없다. 공통 코드 변경은 전체18 범위를 계산하며 실행 직전 다시 대조한다.

```bash
cd /Users/jr/Desktop/projects/nomorevibe-release-686-20261027
MERGED_686_SHA=34cc2045cbb7105313861792adb37c035b64e70c
STATE=/Users/jr/.local/state/nomorevibe-reliability-20261025
npm run deploy -- scope --base 20493cfdf43b98bcb239bc8d097a705707da23d9 --sha "$MERGED_686_SHA"
npm run deploy -- plan --sha "$MERGED_686_SHA" --migration-verified --out "$STATE/full18-release686-20261027-a"
# root가 실제 plan·hash·선택/유지 앱·현재 관문을 검토한 다음, 새 계획을 단 한 번 실행한다.
npm run deploy -- run --plan "$PLAN" --plan-sha "$PLAN_SHA256"
```

`--migration-verified`는 이미 적용한138 journal의 실제 검증 주장이지 DB 이전 재실행 지시가 아니다. 서비스 변경 전 관문이 실패하면 실패 원문을 보존하고 원인을 확인한다. 관문·계획·runtime을 위조하거나 timeout을 우회하지 않는다. API 응답이 불명확하면 같은 배포를 다시 요청하지 않고 실제 읽기로 대조한다.

3. 실제 최종 영수증이 나온 뒤에만 전체18 완료를 기록한다. 도구의 새 observer 예약과 실제 실행/PID를 구분하고, 5·10·15분/6시간 결과는 경과 후 각각 수집한다. 별도24시간 관측은 남겨 둔다.
4. root가 아래 결과 슬롯과 보고서/PENDING 현재 블록을 실제로 갱신하고, PR680에 최신 main을 통합한다. 문서 변경만으로 앱을 재배포하지 않는다.

| PR686 이후 결과 슬롯 | 현재 |
|---|---|
| 병합 main / CI·이미지 / 새 운영자 | main34cc·깨끗한686 운영자·main CI40383949515 필수 check/웹·워커 이미지 성공 |
| 공식 전체18 plan·hash / 실행 경로 / 최종 영수증 | plan 세션24626/`STATE/full18-release686-20261027-a` 진행 중; plan 파일·run·최종 영수증 대기 |
| 배포 후 제어 상태 / monitor UP·두 ACK / 일반 관문 | 대기 |
| 새 observer 시작 및 실제 시각별 결과 | 대기 |

## 소비한 once·실패·역사 보존

- 과거63 요청: stop·journal136·감사20456 회수·기존 finish·OPEN20457은 완료 이력이다. 재실행하지 않는다.
- 6c 요청: 유일한 Engine stop은 실제 die1을 확보했지만 Swarm 작업이 삭제되어0136 계약으로 인증하지 못했다. 종료 상태를 만들어 넣지 않고0137 새 계약으로 처리했다. journal137/138, 감사20474 canonical 공유 once, V2 finish 공유 once, OPEN20475는 모두 소비했다. **stop·migration·canonical·finish·OPEN을 다시 실행하지 않는다.**
- journal138 완료: `STATE/cli-executor-indeterminate-removed-0137-migration-20261027/apply-20261027-a/completed.private.json`.
- canonical 완료: `STATE/cli-6c-removed-canonical-apply-20261027-a/canonical-receipt.private.json`, SHA `be8db75b76bb24eb6b4a855a540c4a63431012f8e607506b9e45e1a0d84a4137`.
- Connect 완료: `STATE/cli-indeterminate-removed-known-exit-ops-20261027-v2/finish-run-20261027-a/final-6.private.json`; 원 V1/V2 helper와 request-wide once는 그대로 보존한다.
- 기존 일반685 plan-a/b는 progress 관문 timeout으로 정상 서비스 POST 전 중단했다. 새 실제 출력과18:54:22 통과를 과거 실패 구간에 소급 적용하지 않는다. 사용한 경로·실패 영수증은 재사용하지 않는다.
- source manifest의 추가 COPY, 과거 migration count/static mirror, 동적 CREATE를 가로지른 regex 등 자동 CI/읽기 거절과 수정 이력은 아래 비공개 원문에 보존한다. 실패를 삭제하거나 수동 시험 통과로 바꾸지 않는다. 미완성 `expire.mjs`는 실행하지 않는다.

이번 교체 직전 dirty3파일 원문과 SHA manifest: `STATE/docs-before-686-final-consolidation-20261027/` (0700/0600). 더 긴 과거 handoff는 Git의50f 이력 및 `STATE/final-docs-history-20261026T130400Z/{main-handoff.private.md,working-handoff.private.md}`, `STATE/docs-before-final-consolidation-20261027T162700Z/`, `STATE/handoff-before-684-stop-phase-20261027/`에 보존한다. 현재 문서와 실제 저장소·영수증을 우선하며 과거 진행 문단을 현재 상태로 해석하지 않는다.
