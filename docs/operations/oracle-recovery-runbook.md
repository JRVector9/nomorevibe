# Oracle 독립 감시와 자동복구

2026-10-25 구현·검증 진행 기록이다. 현재 목표 전체의 완료 증거는 아니다. 앱 운영 릴리스는 아직 be71이며 새 Node/liveness/번역·items 감시는 배포 전이다.

## 배치와 권한

Oracle `onetwoday`의 `nomorevibe-oracle-watchdog.service`가 M3 11앱·mini 6앱을 약30초 간격으로 관찰한다. 설정 `/etc/nomorevibe-watchdog/config.json`, key/known_hosts는 같은 디렉터리, 상태는 `/var/lib/nomorevibe-watchdog/state.json`이다. 설정·key·상태는0600이며 로그에는 상태 코드와 고정 앱 이름만 남는다. 원본 환경·Push URL·Kuma 비밀번호를 출력하지 않는다.

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
| DB 일시 불통 | 새 `/api/live`는 DB와 분리, readiness503·기존 DB 재연결 | unit/readonly 경계 검증. 새 image 배포·실제 일시불통 드릴 남음 |
| Valkey 설정/접속 예외 | 캐시 실패를 흡수하고 정상 DB 경로 사용 | 동기 client/set 예외 RED→GREEN |
| 악성 HTTP 응답/과도 압축 | 패치된 Undici에서 caught failure/정규 retry | 기존 Node 종료 재현→패치 transport/monitor child 회귀 통과 |
| 역할 선출 응답 무한 대기 |5분 한도 뒤 boot 종료1·불확실 선출 재요청 금지 | fake-timer resolve/reject 및 기존 supervisor 회귀 |
| 번역/소개 검토 정체 |7개 개별 queue를 경보, canonical retry/hold/시도 소진 유지 | 실제 PG9개 및SELECT-only/write거절. 운영 SELECT grant12표·쿼리 비용·배포 남음 |
| AI items 정체/consumer 누락 | 독립 consumer lane 경보, legacy reviewer 재시작 배제 | legacy/items/draining unit·실PG 회귀. 실제 mode/반복 부팅 원인·수정 후 관측 남음 |
| 홈페이지500/monitor hang | 위 제한으로 same-spec rolling recovery | Python/Node/CAS 계약42개. 격리 실제Engine29.5.2의180초gate·CAS·task교체·홈500→200·ACK유실중복제한 통과; 실제운영홈500주입은 미실행 |
| Oracle watchdog 프로세스 종료 | systemd Restart=always·Kuma deadman | 실제SIGKILL→systemd복귀, 양Kuma heartbeat timeoutDOWN→재시작UP 및 OracleTelegram 두API수락 확인 |
| 한 receiver 실패 | 원래 M3 watcher는 독립 두 Kuma에 동시 전송 | 양pipeline·양heartbeat ACK와 실제두receiver deadman DOWN→UP 확인. mini tailnetHTTPS8443 추가 |
| 전체 호스트/DB 영구 장애 | 기존 standby/재연결 범위, 준비된 DR fence 필요 | 최신 릴리스에서 host 인계·M3/mini 동시 단절·Oracle DB DR/독립 모델·복귀는 완료로 주장하지 않음 |

## 관찰과 변경

```sh
ssh onetwoday 'sudo systemctl show nomorevibe-oracle-watchdog.service -p ActiveState -p SubState -p MainPID -p NRestarts -p MemoryCurrent'
ssh onetwoday 'sudo journalctl -u nomorevibe-oracle-watchdog.service -n 3 --no-pager -o cat'
ssh onetwoday 'sudo ssh -F /dev/null -p 22222 -o BatchMode=yes -o ConnectTimeout=8 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/nomorevibe-watchdog/known_hosts -i /etc/nomorevibe-watchdog/gateway_ed25519 jr@100.92.77.66 probe'
```

로그의 `receipts=true`는 Push ACK이며 Telegram API의 전송 수락·수신자 단말 도착과 별개다. Kuma delivery audit에서 해당 monitor ID의 `apiAccepted/receiptPresent`와 시각을 대조한다. recover를 전환할 때 비밀 설정을 화면에 표시하지 않고 원본과 변경할 필드만 읽어 확인한다. 상한 상태를 삭제해 같은 장애를 무제한 재시도하지 않는다.

복구기 소스는 테스트·hash 대조 후 한 번 갱신한다. 관측 이력과 attempts를 보존하며 기존 watchdog를 중복 시작하지 않는다. systemd와 `--once`는 같은 파일 lock을 사용한다. 결과가 불확실한 복구 요청은 반복하지 않고 gateway 결과·Docker version/spec/task/HTTP를 읽어 확인한다.

## 회귀검사

```sh
python3 -B -m unittest discover -s tests -p 'test_recovery*.py'
python3 -B -m unittest discover -s tests -p 'test_oracle_watchdog*.py'
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:32784/nomorevibe_test npm run test:integration -- tests/integration/text-stage-progress.test.ts tests/integration/review-stage-progress.test.ts
```

전 페이지 측정·개선은 `2026-10-25-page-reliability-audit.md`, 보안 점검은 `2026-10-25-security-reliability-audit.md`, 최신 실행 상태와 다음 명령은 `docs/CODEX_HANDOFF.md`를 참조한다.
