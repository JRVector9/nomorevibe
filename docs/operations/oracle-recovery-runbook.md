# Oracle 독립 감시와 자동복구

2026-10-25 구현·검증 진행 기록이다. 현재 목표 전체의 완료 증거는 아니다. PR659의 새 Node/liveness/번역·items 감시는 Docker18앱 배포 전이며, Osaka native agent-scan은 3c63/Node24.22.1로 갱신했다. 공유 DB 복구와 정규 전체 배포는 다른 작업 흐름에서 진행하므로 최신 상태와 배포 소유권은 `docs/CODEX_HANDOFF.md` 최상단을 따른다.

## 배치와 권한

Oracle `onetwoday`의 `nomorevibe-oracle-watchdog.service`가 M3 11앱·mini 7앱·Osaka native 1개, 총19개 대상을 약30초 간격으로 관찰한다. 설정 `/etc/nomorevibe-watchdog/config.json`, key/known_hosts는 같은 디렉터리, 상태는 `/var/lib/nomorevibe-watchdog/state.json`이다. 설정·key·상태는0600이며 로그에는 상태 코드와 고정 앱 이름만 남는다. 원본 환경·Push URL·Kuma 비밀번호를 출력하지 않는다.

M3/mini에는 tailnet IPv4:22222의 별도 native OpenSSH launchd `com.nomorevibe.recovery-sshd`를 둔다. Tailscale SSH :22는 authorized_keys의 forced command를 거치지 않으므로 복구 키 경로에 사용하지 않는다. 전용 listener는 jr/publickey-only·Oracle tailnet IP from 제한·ForceCommand·forward/TTY 금지다. 실제 host key를 신뢰된 기존 관리 연결로 읽어 Oracle known_hosts에 고정한다. 설정 예시는 `scripts/ops/recovery-sshd.conf.example`이다.

Gateway 소스는 `/usr/local/libexec/nomorevibe-recovery/gateway.py`, root-owned allowlist는 `/usr/local/etc/nomorevibe-recovery.json`이다. 일반 authorized_keys·기존 SSH·Dokploy·앱 source/env/replicas를 재설정하지 않는다. gate 상태만 jr의 `.local/state/nomorevibe-recovery/`에0600으로 쓴다.

Oracle에는 Dokploy/DB/모델 자격을 전달하지 않는다. 공개·DB·모델의 전역 장애 경보를 앱 재시작 권한과 혼동하지 않는다. 현재 자동복구 설정은 **recover=true**다. Oracle pipeline2/heartbeat3과 mini pipeline73/heartbeat74를 별도로 활성화했으며 네 Push ACK를 확인했다. 두 신호가 같은 endpoint를 공유하면 설정을 거절한다. 기존 M3 worker Push monitor1을 덮지 않는다. 현재 live 수신/알림 및 활성화 결과는 `docs/CODEX_HANDOFF.md`를 우선 확인한다.

## 복구 판정

- 같은 버전·같은 복구 원인3개가150초 이내 간격으로 연속 관측되어야 요청한다. 경보는2개 표본이다.
- 웹: 모든 replica의 직접 `/api/health` 준비 상태가정상인데 홈페이지 GET이 실패할 때. DB unavailable은 경보만 낸다. 운영 바인딩에 맞춰 컨테이너 env.HOSTNAME을 사용한다.
- 읽기 전용 monitor: 로컬 heartbeat가90초 이상 오래됐거나 사라졌을 때. 최근 heartbeat의 pipeline alarm 자체로 재시작하지 않는다.
- gateway가 의도한 replica 수·배포 완료·3분 안정화·현재 실패와 version을 다시 확인한다. Docker Engine API version CAS로 `TaskTemplate.ForceUpdate`만1늘리고 기존 spec/registryAuth/rollout/종료 grace를 보존한다. 동시에 배포가 일어나면 거절한다.
- Oracle/gateway 양쪽이 요청 전에 상태에 예약한다. 응답을 잃어도 재요청하지 않는다. 앱별15분 cooldown·24시간2회 상한이며 재부팅 후에도 유지한다. 손상·미래·NaN 이력은 새 예산을 열지 않는다.
- 모델 worker·DB·role lease·policy/hold·replica0·stopped/deploying/불확실한 상태는 gateway가 복구하지 않는다. 기존 fenced supervisor/Swarm이 담당한다. 실제 host/DB disaster readiness는 별도다.

## 장애별 현재 검증 범위

| 장애 | 자동 동작 | 현재 근거 / 남은 일 |
| --- | --- | --- |
| 웹 프로세스 종료 | 기존 Swarm any/unlimited 재생성 | 양 운영 서비스 restart policy 확인. 새 릴리스에서 실제 드릴 남음 |
| DB 일시 불통 | 새 `/api/live`는 DB와 분리, readiness503·기존 DB 재연결 | immutable3c63 웹·격리PG17의 실제 단절/재연결18.5초 PASS: readiness200→503→200, live200·Dockerhealthy 지속, PID동일/restart0. 운영DB를 중단한 시험은 아님 |
| Valkey 설정/접속 예외 | 캐시 실패를 흡수하고 정상 DB 경로 사용 | 동기 client/set 예외 RED→GREEN |
| 악성 HTTP 응답/과도 압축 | 패치된 Undici에서 caught failure/정규 retry | 기존 Node 종료 재현→패치 transport/monitor child 회귀 통과 |
| 역할 선출 응답 무한 대기 |5분 한도 뒤 boot 종료1·불확실 선출 재요청 금지 | fake-timer resolve/reject 및 기존 supervisor 회귀 |
| 번역/소개 검토 정체 |7개 개별 queue를 경보, canonical retry/hold/시도 소진 유지 | 실제PG 회귀와 운영12표 SELECT-only/defaultreadonly/쓰기42501 확인. reason2552ms/나머지6개788ms, 각3초 제한. 새 monitor 배포 후 관측은 남음 |
| AI items 정체/consumer 누락 | 독립 consumer lane 경보, legacy reviewer 재시작 배제 | legacy/items/draining unit·실PG 회귀. 실제 mode/반복 부팅 원인·수정 후 관측 남음 |
| 홈페이지500/monitor hang | 위 제한으로 same-spec rolling recovery | Python/Node/CAS 계약42개. 격리 실제Engine29.5.2의180초gate·CAS·task교체·홈500→200·ACK유실중복제한 통과; 실제운영홈500주입은 미실행 |
| Oracle watchdog 프로세스 종료 | systemd Restart=always·Kuma deadman | 실제SIGKILL→systemd복귀, 양Kuma heartbeat timeoutDOWN→재시작UP 및 OracleTelegram 두API수락 확인 |
| 한 receiver 실패 | 두 Kuma에 독립 Push, Oracle이 ACKfalse를 새 incident로 Telegram 알림 | mini8443만75초 차단: 두 ACKfalse→Telegram acceptedtrue/sent2/pending0, 반복전송0, 자동원복 후 네 ACKtrue. 기존 pipeline DOWN 중 새incident도 알림 확인 |
| M3 scheduler 둘 중단 | mini scheduler가 같은 DB coalescing으로 정기요청 지속 | 독립120초 자동원복을 먼저 준비한 실제 시험: mini 단독120.158초/12틱/실패0/자연due55요청, M3원spec·두healthy 복원. 전체M3단절 시험은 아님 |
| Osaka agent-scan failed | 고정 native unit/MainPID0/180초/빈 재귀cgroup만 reset-failed→start | 후속 실제 시험 PASS: failed/PID0·현재 PID1 기록, 동일version180초·복구가능3표본, Oracle requested1회·양budget각append1, 새PID/DB serviceboot/freshhealth·원source/config/caps 보존. fallback발화0/자기timer종료·driver/fallback empty/job0, 네 Push ACK와 native실패 경보 cycle Telegram API수락 확인. 첫 시험의 도구 실패는 별도 FAIL로 보존하며 runtime hang 시험은 아님 |
| 전체 호스트/DB 영구 장애 | 기존 standby/재연결 범위, 준비된 DR fence 필요 | 최신 릴리스에서 host 인계·M3/mini 동시 단절·Oracle DB DR/독립 모델·복귀는 완료로 주장하지 않음 |

## 관찰과 변경

```sh
ssh onetwoday 'sudo systemctl show nomorevibe-oracle-watchdog.service -p ActiveState -p SubState -p MainPID -p NRestarts -p MemoryCurrent'
ssh onetwoday 'sudo journalctl -u nomorevibe-oracle-watchdog.service -n 3 --no-pager -o cat'
ssh onetwoday 'sudo ssh -F /dev/null -p 22222 -o BatchMode=yes -o ConnectTimeout=8 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/nomorevibe-watchdog/known_hosts -i /etc/nomorevibe-watchdog/gateway_ed25519 jr@100.92.77.66 probe'
```

로그의 `receipts=true`는 Push ACK이며 Telegram API의 전송 수락·수신자 단말 도착과 별개다. Kuma delivery audit에서 해당 monitor ID의 `apiAccepted/receiptPresent`와 시각을 대조한다. recover를 전환할 때 비밀 설정을 화면에 표시하지 않고 원본과 변경할 필드만 읽어 확인한다. 상한 상태를 삭제해 같은 장애를 무제한 재시도하지 않는다.

복구기 소스는 테스트·hash 대조 후 한 번 갱신한다. 관측 이력과 attempts를 보존하며 기존 watchdog를 중복 시작하지 않는다. systemd와 `--once`는 같은 파일 lock을 사용한다. 결과가 불확실한 복구 요청은 반복하지 않고 gateway 결과·Docker version/spec/task/HTTP를 읽어 확인한다.

Osaka native gateway는 `/usr/local/libexec/nomorevibe-native-recovery/native_recovery_gateway.py`와 검증한 sibling `recovery_gateway.py`를 읽는다. 설정은 `/etc/nomorevibe-native-recovery/config.json` root0600, 상태 부모는 `/var/lib/nomorevibe-native-recovery` root0700이다. 의도적 consumer 중단 전에는 `recoverEnabled=false`로 disarm하고 실제 정상 복귀 뒤에만 rearm한다. inactive·active hung·실행 정체성 불명·자식이 남은 cgroup은 이 gateway의 시작 대상이 아니다.

첫 native 시험의 fallback timer는 예정 시각보다 늦게 발화했고, consumer 시작 후 결과 영수증과 rearm을 완료하지 못했다. 실제 예외 원인은 미확정이다. 원 실패·once·예산은 보존한다. 별도 고정 followup1은 실제 PID1 실패 형상, reload 후 절대 monotonic 기한, 시작 직후 health·이전 DB PID 관측과45초 전체 제한을 보완했고90개 offline 회귀와 독립 보안검토를 통과했다. 후속 실제 시험은10:54:46Z EXIT0/PASS, 독립 최종 읽기까지 통과했다. 새 fallback의 실제 발화·자동완료를 시험한 것으로 확대하지 않는다. 정확한 SHA와 실행 범위는 [native 복구 실증](2026-10-25-native-recovery-verification.md) 및 `prepared-native-followup1` 증거를 따른다. 완료된 두 once를 재실행하지 않는다.

최종 Push와 Telegram 전송은 DNS/connect를 포함해 격리 child 전체5초 안에 종료·회수한다. 토큰/URL은 빈환경 child의 stdin으로만 전달하고 stdout은 고정 결과만 받는다. 복구 예약은 파일 fsync→rename→부모directory fsync 뒤에만 동작을 허용한다. 알림 ACK 유실에는 드문 중복이 가능하며 단말 읽음은 증명하지 않는다. 실제 시험 영수증9개와 SHA manifest는 `/Users/jr/.local/state/nomorevibe-reliability-20261025/verified-receipts`에0700/0600으로 보관했다. 완료된 once helper는 재실행하지 않는다.

## 회귀검사

```sh
python3 -B -m unittest discover -s tests -p 'test_recovery*.py'
python3 -B -m unittest discover -s tests -p 'test_oracle_watchdog*.py'
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:32784/nomorevibe_test npm run test:integration -- tests/integration/text-stage-progress.test.ts tests/integration/review-stage-progress.test.ts
```

전 페이지 측정·개선은 `2026-10-25-page-reliability-audit.md`, 보안 점검은 `2026-10-25-security-reliability-audit.md`, 최신 실행 상태와 다음 명령은 `docs/CODEX_HANDOFF.md`를 참조한다.
