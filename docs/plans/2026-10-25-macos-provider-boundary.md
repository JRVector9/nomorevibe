# macOS provider 경계 종료의 제한된 지원

## 목표와 승인된 경계

기존 provider boundary는 Linux systemd와 Docker 종료만 표현한다. macOS launchd의 실제 종료를 Linux PID namespace/cgroup 값으로 꾸미지 않고 provider에만 별도 strict identity와 receipt를 추가한다. 기존 Linux JSON·canonical hash·20 CHECK·원장 정산과 업무 결과의 의미는 유지한다.

계약은 특권 operator가 원격 실제 관측과 serving source/config를 검토한다는 기존 신뢰 경계다. JSON 선언이나 artifact SHA만으로 물리 종료가 증명되는 것은 아니다. 전체 inference가 고정한 단일 process의 MLX threads에서 실행되고 fork/setsid/외부 inference worker로 위임되지 않음을 실제 source/config로 닫은 `topologyProofSha256`가 필요하다. 이 자료가 미완료면 운영 실행은 불가하다.

## 최소 구현 계획

1. 기존 Linux identity/exit를 그대로 둔 provider-only `kind: launchd`, `method: launchd_process_group_empty`를 추가한다. 실제 bootsession UUID와 libproc start seconds/microseconds, PID/PPID/PGID/SID/UID, launchd domain/label, plist/entry/serving revision/topology SHA, 관측한 descendant PID 목록과 listener port를 고정한다. Linux 전용 필드는 거절한다.
2. receipt는 same boot, disabled/unloaded, old PID·exact process group·모든 고정 descendants의 ESRCH, replacement/listener 없음과 기존 stop/restart 차단 flags를 요구한다. owner→두 gateway→provider 순서, 30분 plan/5분 receipt, 현재 control/fence/request CAS는 바꾸지 않는다.
3. CLI에서 topology proof의 실제 artifact bytes를 기존 artifact-dir 방식으로 추가 검증한다. source proof가 닫혔다는 의미 자체는 operator가 검토한다.
4. 0128은 기존 세 public validator의 OID를 유지한다. 기존 prosrc를 Linux legacy helper에 byte 그대로 보존하고 public 이름을 CREATE OR REPLACE한다. 단순 rename은 CHECK가 이전 OID를 계속 참조할 수 있으므로 쓰지 않는다. launchd identity는 Mac 전용 exit에서만 허용한다.
5. 먼저 unit/실제 격리 PG RED를 만들고 구현 후 GREEN을 확인한다. 128→129 journal, nonempty 원행, 기존20 CHECK byte 동일, legacy prosrc 동일, Linux hash와 기존 release guard 회귀를 검증한다. 실제 운영 mutation/모델 호출은 root만 수행한다.

## 검증 기록과 인계

완료한 변경은 `lib/llm/provider-boundary-contract.ts`, operator CLI, `0128_macos_provider_boundary_exit.sql`/journal129와 전용 unit/PG fixtures다. root 소유 공통 handoff/운영 문서는 수정하지 않았다. 운영 DB·앱·프로세스 변경과 모델 호출은 이 작업에서 모두 0이다.

Mac identity의 `pgid == pid`를 요구한다. 실제 launchd의 SID는 공유될 수 있으므로 SID를 identity에 고정하되 session 전체가 비었다고 요구하거나 주장하지 않는다. kernel boot UUID는 identity와 exit 양쪽에서 같은 lowercase hex UUID 형식으로 검사한다. Linux validator와 canonical 함수는 변경하지 않았다. CLI는 Mac topology 원문 artifact도 실제 재해시한다.

실행한 검증:

- 새 TS 계약: 구현 전 launchd 허용 사례 2개가 실제 실패했고, 구현 후 통과했다.
- 실제 PG17: journal128에서 새 Mac validator 사례가 실제 실패했다. journal129로 구현 후 새5개+기존10개가 통과했다.
- 독립 검토의 Mac boot UUID 형식 차이를 추가 회귀로 실제 1실패 재현한 뒤 같은 Mac validator 재사용으로 해결했다.
- 최종 unit 6파일 **27/27 PASS**: launchd, 기존 boundary/CLI, DR followups/reclaim, capacity schema.
- 최종 실제 격리 PG17 4파일 **32/32 PASS**: 새 launchd5, 기존 boundary10, gateway not-started7, constraint regression10. direct INSERT, 잘못된 canonical hash, 다른 요청 binding/group, 잘못된 종료 순서, non-draining, NULL/누락/cross-kind proof를 거절한다. 정상 합성 AI1은 exact 한 행만 withdrawn/event/audit 처리되고 binding/charged bound와 `settled_at = NULL`을 보존한다. 이는 실제 provider 관측이나 모델 정산 시험이 아니다.
- 별도 nonempty migration 관측은 **128→129**, 기존 **20 CHECK 이름/validated/정의 byte 동일**, 기존 public 3함수 **OID 동일**, legacy 3함수 **prosrc byte 동일**, canonical 함수 전체 동일을 확인했다.
- `next typegen`, `tsc --noEmit --incremental false`, 변경 TS 파일 scoped ESLint와 `git diff --check`를 실제 실행했다. 결과 원문은 아래 private 검증 디렉터리에 보존한다.

검증 자료는 `/private/tmp/nomorevibe-llm-activation-20261024/provider-boundary-launchd-proof/`에 0600으로 저장했다. `before-128.catalog.safe.json`, `after-129.catalog.safe.json`, `catalog-comparison.safe.json`, `pg-red.local.txt`, `pg-green.local.txt`와 final 결과를 구분한다. 운영 identity snapshot이나 topology source proof는 종료 receipt가 아니며 이 합성 fixture와 섞지 않는다.

재현 명령(본인 전용 local PG의 `TEST_DATABASE_URL`을 사용):

```sh
npm test -- tests/provider-boundary-launchd.test.ts tests/provider-boundary-release.test.ts tests/provider-boundary-cli.test.ts tests/dr-followups.test.ts tests/dr-reclaim-outside.test.ts tests/local-model-capacity-schema.test.ts
npm run test:integration -- tests/integration/provider-boundary-launchd.test.ts tests/integration/provider-boundary-release.test.ts tests/integration/gateway-not-started-ledger.test.ts tests/integration/local-model-assist-constraint-regression.test.ts
npx next typegen
npx tsc --noEmit --incremental false
npx eslint lib/llm/provider-boundary-contract.ts scripts/ops/model-provider-boundary-release.ts tests/provider-boundary-cli.test.ts tests/provider-boundary-launchd.test.ts tests/fixtures/provider-boundary-launchd.ts tests/integration/provider-boundary-launchd.test.ts
git diff --check
```

남은 일은 root의 최종 코드/실제 topology artifact 검토, CI/merge, exact main의 기존 migrator로 0128 적용, 그리고 root만 수행하는 실제 경계 종료·단건 회수·복원이다. migration 이전 wrapper catalog와 실제 대상 request/control/fence를 동결하며 global count를 CAS하지 않는다. 실제 종료 관측은 disable/bootout/unloaded, same boot, exact old PID·private PGID·고정 descendants ESRCH와 replacement/listener 없음이 모두 있어야 한다. 기존 owner→양 gateway→provider 순서와 freshness/CAS를 그대로 지킨다. topology는 추론 경로만 단일 process MLX threads임을 검토하며 비추론 sysctl subprocess까지 없다고 주장하지 않는다. GPTOSS batched와 공유 DeepSeek VLM의 실제 경로를 구분한다.

최종 root wrapper가 source/plan/raw artifact 해시를 고정한 뒤 호출할 기존 CLI 형태(기본 rollback, 실제 apply는 root 전용):

```sh
npx tsx scripts/ops/model-provider-boundary-release.ts --database-url-stdin --plan=/absolute/reviewed-plan.json --plan-sha=EXACT_FILE_SHA256 --receipt=/absolute/actual-receipt.json --artifact-dir=/absolute/reviewed-artifacts --operator=EXACT_OPERATOR --reference=EXACT_OPERATION_REFERENCE
```

stdin은 root가 검증한 direct-primary 접속만 메모리로 전달한다. 각 artifact는 `${sha256}.json`으로 보존하며, Mac topology proof도 그 목록에 포함한다. root가 실제 증거를 검토하고 명시적으로 실행할 때만 `--apply`를 추가한다. 이 회수는 `withdrawn`이며 native terminal/usage 또는 업무 성공을 만들지 않는다.
