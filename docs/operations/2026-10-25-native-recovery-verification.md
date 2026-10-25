# 2026-10-25 Osaka native 자동복구 실증

Osaka `nomorevibe-core-consumer@agent-scan.service`의 **실행 전 실패 → Oracle 자동복구**를 실제 확인했다. 고정 followup1은 2026-10-25T10:54:46.973Z에 EXIT0/PASS로 종료했고 최종 정상 상태까지 검증했다. 최초 시험의 FAIL은 별도로 보존한다. 전체 웹·백엔드 검증의 완료를 뜻하지 않는다.

## 실제 확인한 동작

1. 독립 비상 timer를 먼저 준비하고 고정 consumer를 정상 종료했다. claim TTL 125초 뒤 고정 false `ExecStartPre`의 실패 3회와 PID1 시작 제한을 확인했다. 실제 Result는 `exit-code`였다.
2. 시험용 drop-in을 제거하고 원 설정을 복원한 뒤 Oracle이 관찰하게 했다. 동일 failed version `7243867278211`이 180초 이상 유지되고 복구 가능한 표본 1·2·3이 쌓인 후 Oracle이 10:54:03.062047Z에 한 번 요청했다.
3. native와 Oracle의 기존 복구 예산에 각각 1회가 추가됐다. 예산을 초기화하지 않았다. 새 parent PID1886533·child1886641, 새 supervisor service-observation boot `dc93420b-45d6-407c-9871-2108d0a13b4e`, 최신 health를 확인했다. 이 boot는 소비자의 claim 증거가 아니다.
4. 원 release·env·config·source·UID·resource caps가 보존됐다. root는 시험 후 consumer start/stop/reset을 추가 실행하지 않았다. 최종 driver/fallback은 PID0·재귀 cgroup empty, timer는 inactive/dead·LastTrigger0, queued job은0이었다. fallback은 발화하지 않았다.
5. DB identity·writer fence·agent-control/settings의 전후 동일성을 확인했다. M3 소비자는 계속 살아 있었다. 다른 작업 소유자가 capacity를 변경했으므로 전후 capacity 동일성을 주장하지 않는다. 시험의 마지막 DB 관측은130/기존 unknown2였다.
6. Oracle의 pipeline·heartbeat Push 네 ACK가 true였다. native inactive/failed 경보 표본을 포함한 cycle에서 Telegram API accepted=true·sent1·pending0을 확인했다. 단말 도착이나 읽음의 증거는 아니다.

후속 source는 작성자·보안·root 각각90/90 offline 회귀를 통과했다. root AST/default validate도 실제 실행했다. 최종 증거의 독립 로컬 검토는59개 assertion/EXIT0·차단 결함0이었다. 이 독립 검토는 원격 상태를 다시 조회한 검사가 아니다.

## 증거 위치와 해시

로컬 증거 부모는 `/Users/jr/.local/state/nomorevibe-reliability-20261025/prepared-native-followup1`이다. 디렉터리0700·파일0600으로 보관했다. 완료 bundle은 원본11개 증거의 크기와 SHA를 결속한다. 아래에는 주요 파일과 별도 알림 부록을 나열했다. 부록은 bundle을 덮어쓰지 않고 보관했다.

| 파일 | SHA-256 |
| --- | --- |
| `completion-bundle-20261025.safe.json` | `5aa8e900b82e9773de98537d078eb66c623e40546a19cc60377f2e08aad3b17e` |
| `observer-terminal-20261025.safe.json` | `24213d64236695c8be494c2d1abc4580aa681236d7e02ee5e422bd73d76e1afc` |
| `trial-result-20261025.safe.json` | `0457c6c92de6822aecac0e6eee010918f888fbb4742b70e01f6df6904575da73` |
| `final-native-proof-20261025.safe.json` | `9568059d67dd29c9e572dc757ad421321831a691806f360fdf9addd38216fbcf` |
| `final-oracle-proof-20261025.safe.json` | `44dc7962f6a8bba38be4937ce834a887f867c5ad70a0ce1f903e2911269ef100` |
| `db-scope-start-20261025.safe.json` | `2471a8b77678034332138256980d7c60d531a77fd559206bce91c02e16592bab` |
| `db-scope-after-20261025.safe.json` | `81280ad99590f0132df5c7aee1ad45365a77b6d389a001d0a9cb622f3af89176` |
| `accepted-alert-cycles-all-targets-20261025.safe.json` | `3030e16e3371b3f9f9e6d3d0d1de1cff44446bda2fba204f043e210070ec3bcb` |

후속 helper SHA는 `77b293d8d504d49c3d15a44d48b7c0a4db9830fabdfbe59d428bda7a6640a366`, source/test/invocation manifest SHA는 `3fd94260b921aa9bdffae98e591251a3639d65cfdfc715d912c3aed701251025`다. 실행 session93894·observerPID34783은 terminal이다. **설치·시험 helper·완료 once를 다시 실행하지 않는다.** 원격 root 파일과 phase 기록도 보존한다.

## 실패 이력과 증명의 한계

첫 isolated 시험은10:03:09Z에 EXIT1이 관측됐다. 실제 PID1은 시작 제한을 기록했지만 Result가 `exit-code`여서 시험도구의 `start-limit-hit` 가정이 실패했다. 기존 relative timer는 늦게 발화했고 fallback이 새 consumer를 시작한 뒤 영수증·rearm을 완료하지 못했다. reload가 상대 기한을 바꾼 원인이라는 설명과 실제 fallback 예외 원인은 확정하지 않았다. root는 소비자 정상 상태를 검증하고 자기 timer·원 설정 복원만 마무리했다.

첫 시험 terminal/복원 bundle은 sibling `prepared-native-isolated/original-trial-terminal-and-restoration-20261025.safe.json`, SHA `c29b14d3d1964dc6893d6c977c2b945a9d11000b12d243e6b9c493d814cf3e83`다. `originalTrialPassed=false`, `fallbackAutomaticPass=false`를 유지한다. 후속 도구는 실제 PID1 형상, reload 전후 절대 monotonic 기한, 시작 직후 health·이전 DB PID의 bounded pending, 전체45초 제한을 보완했다.

후속 PASS의 범위는 **pre-launcher ExecStartPre 실패 후 고정 native unit 복구**다. runtime hang·provider/model 장애·전체 host 소실·DB DR/PITR, 새 fallback의 실제 발화·자동완료를 시험한 결과는 아니다.

## DB132 전환 뒤 독립 관측

11:33:25Z의 새 primary 읽기 전용 조회에서 journal132·draining11:20:43.235Z·기존 indeterminate2를 확인했다. DB identity·writer fence·agent-control/settings는 native 시험 시작 전과 같았고 M3 소비자는 running·관측 나이6.999초·기존 be71이었다. 이 결과는 마이그레이션 전체 검증, unknown 회수, 새18앱 배포의 완료 증거가 아니다.

11:33:43Z의 Oracle 읽기 전용 조회에서 watchdog active/running·NRestarts0·19개 관측 대상, native reason=ok/bad0/actionable0/기존 예산1을 확인했다. 마지막4개 cycle의 pipeline·heartbeat 네 Push ACK는 모두 true였고 최대 간격은35.724초 미만이었다. 전체 pipeline 결과는 false였으므로 모든 작업이 정상이라고 해석하지 않는다. Oracle 설정과 세 소스의 SHA는 시험 종료 때와 같았다. 이 조회에서 운영 쓰기·복구 요청·새 알림 전송은 하지 않았다.

두 증거는 sibling `post-native-monitoring-20261025` 디렉터리에0700/0600으로 보관했다.

| 파일 | SHA-256 |
| --- | --- |
| `../post-native-monitoring-20261025/db-scope-20261025T113325620233Z.safe.json` | `a4c8f966125012d0be0f3f644fb9c1b0d0f2dc6f0cd3c897ac220407dd396c99` |
| `../post-native-monitoring-20261025/oracle-scope-20261025T113343255010Z.safe.json` | `b391d206e7ce6ee31b9d533a307065db113077bb91e90e9b07ec3f4f0d43f368` |

## 남은 운영 검증

native 시험 창은 닫혔다. 다른 운영 소유자의 실제11:16 읽기 전용 기록은 OPEN updatedAt11:07:20.075Z·DB130·기존 unknown2·18앱 배포0이다. 당시 OPEN 복귀는 완료됐으며 최종 복구 완료를 뜻하지 않는다. 공유 DB132·provider 경계 회수·unknown0 및 최종 정상 OPEN·최신 main18앱 배포 확인은 그 운영 작업 소유자가 담당한다. 최신 영수증과 실제 source/health를 먼저 확인한 뒤 준비된 mini web→idle text 프로세스 교체 시험, 배포 후 home/popular·인증 관리자7개 GET 지연, text7·AI legacy/items·hold·provider 신호와 Oracle19대상·알림을 검증한다. 준비물의 offline 통과를 실행한 운영 시험으로 세지 않는다.

운영 명령·권한 경계는 [Oracle 운영 절차](oracle-recovery-runbook.md), 최신 소유권·재개 조건은 [인계 문서](../CODEX_HANDOFF.md)를 따른다.
