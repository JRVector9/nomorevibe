# 2026-10-25 감시·자동복구 보안 검토

검토 기준은 reliability/autorecovery 작업 트리의 `e7136238` 기반 코드다. 이 문서는 확인한 경계와 실제 실행한 회귀를 기록한다. 운영 자격 정보, Push URL, Telegram 설정은 수집하거나 기록하지 않았다. 운영 DB 변경·실제 알림·서비스 재시작은 이 보안 검토에서 실행하지 않았다.

주 작업의 후속 실행은 별도다. PR659는 정상 병합됐고 최종 통합 unit7398PASS/9skip, typegen/tsc/i18n/lint/build 성공, npm audit0을 확인했다. 최종 Python recovery/watchdog discovery 두 단계도 PR659 CI40173805135에서 성공했다. 별도 보존 CI 로그에는 수치 집계가 없어 초기 선택 회귀의 수치와 합치지 않는다. 실제 격리Engine CAS 복구, 격리웹 DB 재연결, mini scheduler 단독120초, watchdog deadman·receiver 장애 알림도 실행했다. Osaka native는3c63/Node24.22.1로 갱신했으나 Docker18앱의 새 소스 배포와 배포 후 관측은 남았다. 아래 역할별 초기 기록을 현재 운영 완료로 해석하지 않으며, 최신 운영 상태·공유 배포 소유권과 실제 영수증은 [인계 문서](../CODEX_HANDOFF.md) 최상단 및 [Oracle 운영 절차](oracle-recovery-runbook.md)를 따른다.

private native 시험도구는 초기46개 회귀 이후 실제 첫 시험에서 실패했다. 이를 보존한 고정 followup1은 작성자·보안·root 각각90개 회귀를 통과하고 실제 Oracle 복구까지 PASS했다. 최종 증거의 독립 로컬 검토도59개 assertion/EXIT0·차단 결함0이었다. 범위·실패 이력·정확한 해시는 [native 복구 실증](2026-10-25-native-recovery-verification.md)에 기록했다. 이 실증의 운영 창은 닫혔으며 Docker18앱 배포의 native 보류 사유는 해소됐다.

## 확인하고 수정한 문제

| 문제 | 근거와 영향 | 수정 |
| --- | --- | --- |
| 외부 HTTP 응답 하나로 워커 프로세스 종료 | 설치된 Undici `8.10.2`에 6개 `Content-Encoding`과 조기 종료 응답을 주면 `fetch` rejection을 잡아도 내부 stream의 unhandled error로 자식 Node 프로세스가 exit 1 했다. | npm Undici `8.12.3`으로 갱신. 실제 로컬 TCP 서버와 별도 프로세스로 재현한 회귀 추가. |
| 감시 Push가 구성한 수신기 밖으로 이동 | `pushKumaStatus`의 기본 redirect follow 때문에 다른 목적지의 307을 따라가 성공으로 처리했다. 구성의 외부 HTTPS 호스트 검사만으로는 이후 hop을 제한하지 못했다. | redirect를 거절한다. 두 로컬 서버로 목적지 서버에 요청이 도달하지 않는지 검사한다. 환경 변수 자체는 운영자가 관리하는 신뢰 경계이며 공개 요청에서 Push 주소를 정할 수 있는 경로는 발견하지 않았다. |
| 감시 Push JSON 크기 무제한 | 기존 `response.json()`은 8 KiB보다 큰 응답도 성공으로 처리했다. 큰 응답은 감시자 메모리 사용을 키울 수 있다. | 선언 길이와 실제 stream을 모두 4 KiB로 제한한다. 5초 deadline과 비밀 없는 오류·receipt를 유지한다. |
| npm 갱신 후에도 감시자의 내장 fetch가 취약 | 로컬 Node `24.18.0`의 내장 Undici는 `7.28.0`이었다. npm 패키지만 갱신하고 전역 fetch를 남기면 같은 악성 응답이 감시자를 종료시켰다. | 감시 Push는 패치된 npm fetch를 명시적으로 사용한다. 감시자 코드 자체를 호출하는 별도 프로세스 회귀도 추가했다. |
| 알려진 Zod·Vitest 취약 버전 | 초기 `npm audit --json`은 high 2개·moderate 2개를 보고했다. | Zod `4.6.7`, Vitest `4.1.12`로 갱신했다. 최종 npm audit의 알려진 취약점은 0개다. Zod 메모리 공격·Vitest 개발 서버 공격은 직접 실행하지 않았다. |
| 부동 Node base가 이전 빌드 캐시에 머물 수 있음 | npm 패치는 Node의 Brotli·TLS·내장 fetch를 바꾸지 않는다. | Docker의 7개 Node stage를 `24.22.1-alpine`으로 고정했다. CI의 Node 24 선택은 그대로 둔다. |
| DB 장애가 웹 프로세스 재시작을 유발 | 기존 웹 Docker health는 `/api/health`의 DB 503도 unhealthy로 판정했다. dependency 장애가 Swarm의 프로세스 재시작 조건이 될 수 있었다. | `/api/live`를 DB·readiness 모듈 import 없이 Node 이벤트 루프 생존만 응답하도록 추가했다. 웹 두 Docker target은 실제 listen hostname으로 `/api/live`를 검사한다. 배포 관문의 `/api/health` 준비 검사는 유지한다. |
| Python subprocess의 출력 상한이 사후 검사였음 | `capture_output` 뒤 길이를 검사하면 읽는 동안의 메모리 사용을 제한하지 못했다. | 주 작업에서 `bounded_output`으로 수신량을 제한하고, deadline/초과 출력에서 명령 프로세스 그룹을 종료하도록 수정했다. |
| 종료된 group leader가 남긴 자식의 stdout 때문에 deadline 무력화 | 실제 child가 종료한 뒤 descendant가 stdout을 물게 스케줄을 고정하면, 초기 구현의 `process.poll()` 조건 때문에 timeout 0.05초에도 1.206초 기다렸다. | leader 종료 여부와 관계없이 group 종료를 시도하도록 주 작업에서 수정했다. 실제 subprocess 회귀로 deadline 준수를 확인했다. |
| 표본 CLI의 홈페이지가 사설망 요청·redirect를 허용 | `scripts/crawl-sample.ts`는 GitHub에서 받은 홈페이지를 전역 fetch/redirect follow로 읽었다. | 작은 `sampleHomepageStatus`를 통해 운영과 같은 guarded `safeFetch`를 사용한다. 사설 주소와 사설망 redirect를 거절하고, 상태만 보존한 뒤 body를 취소한다. CLI의 토큰 조회·main 실행 구조는 바꾸지 않았다. |
| 공급자 재시도가 장기 장애 관측을 초기화 | 마지막 실패의 DB `updated_at`만 보면 30분 재시도마다 실패 나이가 초기화되어 장기 장애 알림을 놓칠 수 있다. | heartbeat는 수요·실패가 있고 최근 출력이 없는 고정 7개 텍스트 단계 키만 보낸다. Oracle이 단계별 최초·최종 관측을 영속 보존해 30분 지속 실패를 알리고, 성공·중지·관측 누락·150초 초과 간격·시계 역행에서는 시계를 다시 시작한다. 이 신호는 재시작 권한을 주지 않는다. |
| 손상된 단계별 장애 이력이 watchdog을 종료 | `providerFailures` 내부의 특정 단계 이력이 문자열·배열·null이면 `.get()`에서 `AttributeError`가 발생했다. | 타입을 확인해 해당 단계 관측만 초기화한다. 세 경우의 수정 전 예외와 수정 후 정상 처리 및 NaN·무한대·미래 시각 초기화를 검증했다. |
| watchdog 생존 Push가 pipeline 경보를 덮을 수 있는 설정 | `pushUrls`와 별도 `heartbeatUrls`에 같은 Kuma endpoint가 있어도 설정이 허용되면 DOWN과 UP을 같은 monitor에 병렬 전송한다. | endpoint 교집합을 설정 단계에서 거절한다. hostname·기본 HTTPS port·query 차이로 같은 endpoint를 중복 지정하는 경우도 검사한다. 실제 운영 URL은 이 검토에서 읽거나 바꾸지 않았다. |

Undici·Zod·Vitest 수정은 다음 공급자 근거와 대조했다: [Undici 응답 처리 advisory](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c), [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), [Vitest manual mock advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8), [Vitest Windows 경로 advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-xp26-3454-mjgp).

[Node 24.22.1 릴리스](https://nodejs.org/en/blog/release/v24.22.1)는 내장 Undici `7.30.1`과 Brotli·TLS 등의 보안 수정을 포함한다. [Node 10월 보안 공지](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)에서 런타임 수정의 범위를 확인했다. `docker manifest inspect node:24.22.1-alpine`은 exit 0으로 linux/amd64와 linux/arm64/v8을 반환했다. 별도 `--network=none` 컨테이너를 실제 실행해 `node=24.22.1`, `undici=7.30.1`을 확인했다. 이미지 index digest는 `sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53`였다. 이 명령은 앱 이미지를 빌드·배포한 검증이 아니다.

## 감시·권한 경계

- 기존 M3 감시자는 읽기만 한다. DB 쿼리 실패는 `unknown`이고, 두 bad 표본 후 DOWN·정상 표본 즉시 UP을 보낸다. 수신기는 병렬로 시도하며 한 수신기 실패가 다른 수신기 전송을 막지 않는다.
- `standby_active`, 버전 차이, 공급자 대기, 운영 정책에 따른 hold도 경보 문맥에 들어갈 수 있다. `overall=alarm`만을 자동 재시작 권한으로 사용하면 안 된다. 새 Oracle 복구기는 웹·감시자만 고정 허용하고 worker·모델·정책 상태를 재시작 대상으로 삼지 않는 설계로 검토했다.
- 관리자 ingress는 Host/IP 헤더가 아니라 별도 비밀의 상수 시간 비교를 사용한다. 운영의 로컬 로그인은 꺼지고, 관리자 세션은 서명·만료·허용 목록을 확인한다. 검토한 public mutation은 고정 origin과 세션 CSRF를 확인한다. 이 확인은 모든 엔드포인트에 대한 침투 시험을 대신하지 않는다.
- 공개 URL transport는 각 redirect URL과 실제 DNS 연결 시점의 사설 IP를 검사한다. `ALLOW_PRIVATE_URLS=1`은 이 경계를 해제하므로 운영 설정에 두면 안 된다. 운영 환경의 실제 값은 이 검토에서 조회하지 않았다.
- Oracle SSH gateway의 보안 경계는 고정 allowlist·root 소유 source/config·제한된 forced command·전용 키·고정 known hosts다. 실제 설치 전 이 권한을 검증해야 한다. 재시작은 원 service spec의 `ForceUpdate`만 바꾸며 service version의 Engine CAS로 동시 배포와 충돌할 때 거절해야 한다.
- 주 작업의 실제 조회에서 Tailscale SSH `:22`가 일반 `authorized_keys` forced command를 적용하지 않는 것을 확인했다. 이 경로는 제한 gateway로 사용하지 않는다. 주 작업은 별도 native OpenSSH `:22222`에 publickey-only·고정 사용자·ForceCommand·forward/TTY 금지·Oracle 출발지 제한을 설치했고, 기존의 신뢰한 SSH로 읽은 실제 host key를 pin했다. 이 사실과 진행 중인 live denial/probe 검증은 [현재 인계 기록](../CODEX_HANDOFF.md)에 근거한다. 보안 담당이 직접 운영 SSH 설치를 실행한 결과는 아니다.
- Oracle 초안 검토에서 일반 bad 표본과 실제 복구 가능한 원인을 별도로 연속 집계하도록 요청했고, 최종 소스에 별도 actionable 연속 집계가 반영된 것을 확인했다. 손상된 복구 이력의 NaN도 새 예산을 열지 않게 `math.isfinite`로 거절한다. Push 응답은 소켓 idle timeout과 별도로 연결 이후의 절대 deadline에서 socket shutdown을 예약한다. 최종 watchdog 전체 테스트와 설치 결과는 주 작업의 검증 기록을 따른다.
- 장기 공급자 장애 신호는 고정 키만 저장하며 원문 오류·URL을 담지 않는다. 공급자 backoff 중에도 같은 키를 유지하고, `paused`·`no_work`·`manual_attention`·정책 hold와 최근 성공 출력은 제외한다. progress 조회가 없으면 필드를 생략하고, 정상 빈 목록과 이전 heartbeat의 필드 누락은 Oracle의 해당 장애 관측을 지운다. service version 변경만으로는 지속 장애 시계를 지우지 않는다.
- `deliver`는 파이프라인 결과와 별도로 watchdog 생존을 UP으로 전송한다. 각 수신기는 독립적으로 시도하고 실패를 boolean receipt로만 남긴다. 이 기능은 복구 대상·명령·예산을 바꾸지 않으며, 이전의 `heartbeatUrls` 없는 설정도 허용한다.

## 직접 실행한 검증

| 명령/범위 | 실제 결과 |
| --- | --- |
| 초기 `npm audit --json` | exit 1, high 2·moderate 2 |
| 수정 전 monitor 외부 Push 회귀 | redirect·선언 길이 초과·stream 초과 3개가 예상대로 실패 |
| 수정 전 Undici 별도 프로세스 회귀 | `8.10.2`에서 unhandled error·exit 1 재현 |
| npm만 갱신한 뒤 monitor 별도 프로세스 회귀 | 전역 fetch 경로의 unhandled error·exit 1 재현 |
| `npx vitest run tests/undici-response-security.test.ts tests/monitor-external-push.test.ts tests/failover-monitor.test.ts` | 수정 후 3파일 13개 통과 |
| monitor/readiness/SSRF/redirect/link evidence/실제 transport 선택 회귀 | 15파일 131개 통과(감시자 프로세스 회귀를 추가 확장하기 전 집계) |
| Zod 계약·capacity·settings·public auth·CSRF·bearer 선택 회귀 | 11파일 259개 중 258개 통과, capacity offline CLI 1개가 5초 timeout |
| `npx vitest run tests/pipeline-capacity.test.ts tests/session.test.ts tests/admin-job-control-action.test.ts tests/source-buffer-admin-action.test.ts --maxWorkers=2` | 4파일 97개 통과. 위 timeout도 격리·낮은 병렬성으로 통과 |
| Docker base 검사와 monitor/Undici 최종 선택 회귀 | 4파일 17개 통과 |
| `npx vitest run tests/liveness-route.test.ts tests/dockerfile-emergency-web.test.ts tests/health-route.test.ts tests/operations-health.test.ts` | 4파일 10개 통과. DB import 거절 mock 아래 liveness 200·no-store와 기존 readiness의 DB 503을 함께 확인 |
| `python3 -m unittest discover -s tests -p 'test_oracle_watchdog_transport.py'` | 5개 통과. 헤더·본문 대기 shutdown, 성공 후 deadline 취소, redirect·비200·초과 body·잘못된 ACK 거절, 비밀 없는 실패를 fake transport로 확인. 이 테스트 실행 시 구현은 이미 반영되어 있었으며 수정 전 실패를 관측한 것으로 기록하지 않는다. |
| `python3 -m unittest discover -s tests -p 'test_recovery_bounded_output.py'` | 최종 7개 통과(0.910초). 실제 256 KiB 출력/1 KiB cap, 0.05초 child deadline, 종료된 leader의 descendant, binary payload, cap과 같은 길이, 비정상 종료, OS stderr 비밀 무음을 확인했다. 최초 descendant 회귀 1개 실패를 보존한다. |
| `npx vitest run tests/crawl-sample-homepage.test.ts tests/redirect-guard.test.ts` | 2파일 8개 통과. 홈페이지 사설망·metadata·redirect 차단 및 status/body 해제를 확인했다. |
| `npx vitest run tests/monitor-heartbeat.test.ts tests/failover-monitor.test.ts tests/monitor-external-push.test.ts --maxWorkers=2` | 3파일 23개 통과. 신규 heartbeat 12개는 구현 전 필드 누락으로 모두 실패했다. fixed 7개 키·중복 제거·backoff 유지·pause/resume/success·hold·unknown 값 제거·0600·이전 heartbeat 호환을 확인했다. |
| `python3 -B -m unittest discover -s tests -p 'test_oracle_watchdog*.py'` | 최종 23개 통과. 30분 지속 실패·재시작 후 상태 복구·버전 변경·중지/성공·단계 독립성·gap/rollback·손상 이력과 pipeline/heartbeat 전송 분리 및 설정 회귀를 포함한다. endpoint 겹침 2개 subcase는 수정 전 거절되지 않는 실패를 확인했다. |
| `python3 -B -m unittest discover -s tests -p 'test_recovery*.py'` | 최종 34개 중 33개 통과·1개 skip. 실제 Node `MONITOR_PROBE`의 legacy/빈 목록/잘못된 타입/고정 키 필터, 다복제본 신호 합집합과 stale 신호 배제를 추가 검증했다. |
| `python3 -B -m unittest discover -s tests -p 'test_recovery_native*.py'` | 신규 native 23개 통과(0.137초). 최초 16개는 파일 부재로 실패했고, 빈 ControlGroup 및 reset 후 재검사 확장에서도 실패를 관측한 뒤 수정했다. 고정 unit/7필드·hash/실행 정체성·root/permission·재귀 populated·inactive 거절·15분/rolling 24시간 2회·unknown 예산 소비·maintenance 재조회·실제 Python `-I` 로딩을 확인했다. |
| native 추가 후 Python 선택 전체 | recovery 57개 중 56개 통과·1개 skip(1.903초), watchdog 26개 통과(0.552초). 운영 systemd 실패·복구 드릴을 실행한 결과는 아니다. |
| notifier 독립 검토 후 Python 선택 전체 | watchdog 44개 통과(0.512초), recovery 57개 중 56개 통과·1개 skip(0.832초). notifier 신규 18개와 실제 main 전달·receiver별 receipt·aggregate DOWN 중 새 fault·본문 포함 서명만 ACK·partial snapshot 해소 거절·자식 deadline/stdin/설정 무음을 포함한다. 별도 notifier 최초 16개와 provider 3개도 직접 실행해 통과했다. 실제 Telegram 전송은 보안 검토에서 실행하지 않았다. |
| 수정한 TS/MJS·Docker 검사 테스트 파일 ESLint | exit 0 |
| 최종 `npm audit --json` | exit 0, 알려진 취약점 0개 |

Vitest 실행에는 기존 CommonJS/ESM config loader 경고가 있었다. 단위·DB·빌드 전체 통합 검증은 주 작업 담당자가 별도로 실행한다. 위 선택 회귀 결과로 운영 배포 완료나 장기 관측 완료를 주장하지 않는다.

## 남은 확인

- 배포 이미지·Oracle native runtime가 실제 Node `24.22.1` 이상인지 직접 확인한다. 로컬 개발용 기본 Node는 이 검토 동안 `24.18.0` 그대로이며 시스템 설치를 바꾸지 않았다.
- 주 작업의 실제 조회에서 M3·mini Engine API는 `1.54`, 웹 service health override는 모두 null이었다([현재 인계 기록](../CODEX_HANDOFF.md)). 따라서 소스의 `/v1.45` CAS를 지원하고 이미지 health를 덮는 service override는 관측되지 않았다. 새 이미지 배포 뒤 `/api/live` health 적용 여부는 별도로 확인한다.
- 나머지 전역 server fetch의 확인된 목적지는 GitHub 고정 origin, OAuth 고정 origin, GA 고정 endpoint, 운영자가 정하는 connect-agent/로컬 relay 주소다. 브라우저용 상대 주소 fetch와 주입된 capped fetch 함수를 전역 server fetch로 세지 않았다.
- 운영 외부 Push·Telegram 수신, SSH 제한 키, cold boot, 실제 서비스 장애 복구 드릴은 이 문서의 완료 범위가 아니다.

## 원 요구별 감지·복구·알림 대조

운영 상태는 [인계 문서 06:50Z checkpoint](../CODEX_HANDOFF.md)를 기준으로 읽었다. 이 시점 Oracle의 M3·mini 제한 복구는 활성화됐고 앱 릴리스는 기존 be71이다. 아래에서 소스 구현, 기존 운영 장치, 실제 장애 증명을 구분한다.

| 장애 | 감지·복구·알림 | 남은 구현 또는 운영 증명 |
| --- | --- | --- |
| 웹 프로세스 종료 / DB 정상인 홈 500 | 기존 Swarm restart가 종료 task를 복구한다. 새 DB-free [liveness](../../app/api/live/route.ts)와 readiness는 분리된다. Oracle [gateway](../../scripts/ops/recovery_gateway.py)는 180초 안정 상태에서 readiness 정상·홈 실패일 때 같은 spec의 ForceUpdate만 Engine CAS로 바꾼다. 동일 reason/version 3회 뒤 제한 복구하고 두 수신기에 pipeline 상태를 보낸다. | 실제 격리 Engine 드릴은 주 작업에서 통과했다. 운영 앱의 새 liveness 배포와 실제 홈 500 복구 증명은 별도다. |
| M3 전체 단절 → mini | [기존 도메인 전환 기록](2026-10-11-primary-domain-cutover.md)은 M3·mini Cloudflare pool을 기록한다. 다섯 mini 역할은 DB role lease로 선출된다. Oracle은 SSH 실패·heartbeat 중단을 감지한다. | scheduler 두 복제본이 M3에만 있어 새 정기 요청 생성이 끊기는 구현 gap을 확인했다. mini scheduler 1개 추가를 주 작업이 인수했다. M3 전체 단절 후 새 due 요청·작업 완료·웹 응답을 함께 확인하는 운영 증명은 남는다. DB/모델까지 함께 사라지는 경우는 별도다. |
| DB 일시 불통 뒤 재접속 | [DB pool](../../lib/db/pool.ts)과 [network route](../../lib/db/network-route.ts)는 새 연결 및 구성된 fallback을 관리한다. scheduler는 다음 틱을 계속한다. gateway는 DB unavailable을 재시작 원인으로 쓰지 않는다. 감시 unknown은 경보가 되고 새 liveness는 DB 503 때문에 task를 바꾸지 않는다. | 운영 DB 단절·회복 드릴은 이 검토에서 실행하지 않았다. [Patroni/DCS 제한](../runbooks/db-lan-fallback.md)과 영구 DR·PITR/RPO/RTO 증명은 별개다. |
| 모델/provider 장애 / 정책 hold | 텍스트 7단계 수요·실패·성공 조회와 fixed-key heartbeat를 Oracle이 관측한다. durable first/last로 provider 연속 실패 30분 후 경보를 내며 retry/backoff·lease/fence·capacity hold를 보존한다. 모델 강제 재시작은 없다. | pause/no work/hold/최근 성공은 provider 연속 실패에서 제외한다. 주 작업의 후속 운영 검증은 12표 SELECT grant·readonly on·쓰기42501 및 reason2552ms/other788ms를 확인했다. 새 monitor 배포·실제 장기 provider 알림 증명은 별도이며, 독립 모델의 물리 실행·품질·terminal 증명이나 PR16 활성화까지 완료한 것은 아니다. |
| Osaka agent-scan systemd 중단 | 기존 Restart=on-failure는 의도적 stop과 start-limit 소진을 계속 복구하지 않는다. 글로벌 alive 판정은 M3 소비자가 살아 있으면 Osaka 단일 부재를 숨길 수 있다. 새 [native gateway](../../scripts/ops/native_recovery_gateway.py)는 고정 unit의 failed/MainPID0/180초/빈 재귀 cgroup에만 reset-failed→start를 허용한다. inactive는 경보만, active hung은 기존 fenced supervisor가 담당한다. | 후속 실제 pre-launcher 실패 복구 PASS: Oracle180초/동일version3표본/requested1회/양budget각1/새PID·boot·freshhealth·원source/config/caps/fallback0을 확인했다. 최종 독립 읽기에서 driver/fallback empty·timerinactive·job0/DB writer·agent-control 전후 동일/네 ACK를 확인했다. 첫 시험은 도구 실패로 별도 보존한다. |
| Oracle watchdog / 한쪽 receiver 중단 | watchdog의 systemd Restart=always와 양 Kuma heartbeat가 watchdog 자체 중단을 감지한다. pipeline DOWN과 watchdog 생존 UP은 다른 monitor다. 주 작업은 SIGKILL 복귀·양 수신기 deadman DOWN/UP·Telegram API 수락을 실제 확인했다. | 새 notifier는 watchdog이 살아 있는 동안 receiver ACK=false를 직접 Telegram incident로 알린다. Oracle host 자체가 끊기면 mini heartbeat74의 timeout이 경보를 낸다. 추가 Kuma 상호 HTTP 점검은 컨테이너 MagicDNS ENOTFOUND 오탐으로 주 작업이 제거했다. 원 pipeline/heartbeat는 유지한다. 단말 읽음과 receiver+watchdog host 동시 손실까지 증명한 것은 아니다. |

## Scheduler와 Oracle emergency의 경계

[scheduler](../../scripts/scheduler.ts)에 primary/standby 후보 모드는 없다. [requestDueJobs](../../lib/jobs/control.ts)는 DR writer fence를 먼저 잡고 batch SHARE 뒤 jobs 행을 조건부 UPDATE한다. due 시각을 전진시키고 미처리 요청은 추가 증가시키지 않는다. 같은 릴리스·고유 instance ID·DB 예산의 mini scheduler 1개 상시 실행이 기존 coalescing을 쓰는 최소안이다. [기존 세 프로세스 동시 scheduler 회귀](../../tests/integration/oracle-scheduler-coexistence.test.ts)는 이 읽기 전용 조사에서 다시 실행하지 않았다. M3 소실 뒤 scheduler 1개만 남으면 복수 복제본 기준의 degraded 경보는 유지해야 한다.

PR16 emergency admission은 실행 중인 Oracle workload의 예산·우선순위·DR fence를 검사하며 프로세스 기동이나 DB 승격을 대신하지 않는다. 현재 [Oracle preflight](../../lib/runtime/oracle-preflight.ts)의 role enum은 split 네 역할과 scheduler만 허용하므로 legacy 다섯 역할을 모두 기존 launcher로 즉시 대체할 수는 없다. Oracle scheduler는 boot가 바뀌면 새 canary가 필요하다. serving resolver는 구성된 contract를 읽을 수 있으므로 오래된 “항상 null” 기록을 현재 결함으로 인용하지 않았다. 실제 독립 모델·principal·host 예산·canary 활성화는 해당 운영 근거로 따로 확인해야 한다.

## Native gateway 설치 계약과 미검증

보안 담당의 Osaka 조회는 모두 읽기 전용이었다. unit은 enabled/active/running, MainPID 양수, NRestarts=0, Restart=on-failure, KillMode=mixed, start-limit 3회/5분이었다. 부모 `nomorevibe-core.slice`의 실제 한도는 CPU `60000 100000`, memory 3 GiB, pids 256이다. unit 자체의 `memory.max=max`를 예산 부재로 해석하면 안 된다. 새 함수를 메모리로 읽어 실제 Osaka Python `-I`에서 실행한 결과 exit0, reason=ok, recoverable=false, cgroup empty=false였다. 소스를 설치하거나 systemd를 변경하지 않았다.

설치 시 같은 root 소유·비그룹/기타쓰기 디렉터리에 `native_recovery_gateway.py`와 `recovery_gateway.py`를 0644로 둔다. config는 root0600, state 부모는 root0700으로 미리 만든다. 모든 부모 경로와 source/shared/config는 root 소유·비그룹/기타쓰기·symlink 없음이 필수다. `-I`에서는 검증한 정확한 sibling만 importlib로 읽는다. 예시 config에는 새 DB·모델·외부 서비스 자격 정보가 없다.

```json
{
  "state": "/var/lib/nomorevibe-native-recovery/state.json",
  "unitFile": "/etc/systemd/system/nomorevibe-core-consumer@.service",
  "unitSha256": "1180d9b0d1c09b4573f00ef945ed435f0d0cc5d3b57d9352d8c1a385d113214c",
  "controlGroup": "/nomorevibe.slice/nomorevibe-core.slice/nomorevibe-core-consumer@agent-scan.service",
  "user": "nomorevibe-core",
  "group": "nomorevibe-core",
  "execStart": "/usr/bin/python3 /opt/nomorevibe-core/current/deploy/oracle/launch.py --consumer=agent-scan",
  "recoverEnabled": false
}
```

예시 경로의 ForceCommand는 `/usr/bin/python3 -I /opt/nomorevibe-native-recovery/native_recovery_gateway.py --config /etc/nomorevibe-native-recovery/config.json`이다. 전용 native sshd 22222는 Osaka tailnet IP에만 bind한다. 고정 실행 사용자·publickey-only·Oracle 출발지 제한·restrict·TTY/forward/사용자 환경 금지·별도 authorized keys·신뢰 경로에서 읽은 host key pin을 적용한다. 별도 systemd sshd service는 고정 config와 `sshd -D -f` 인자로 실행한다. root로 실행한다면 전용 key에도 같은 command를 고정해 일반 root shell을 열지 않는다. 기존 22는 일반 shell용 경로이므로 복구 키 경계로 쓰지 않는다. 첫 probe/denial 확인 후 recoverEnabled를 켜며 unit/release/env는 바꾸지 않는다.

실행 정체성은 고정 path+argv만 비교하고 동적인 ExecStart pid·시각은 pin하지 않는다. drop-in·daemon reload 필요·identity 변경은 unknown이다. `cgroup.events`의 재귀 populated=0 또는 정확 group 부재만 허용하고 빈 `cgroup.procs`로 자식 부재를 추론하지 않는다. lock과 요청 전 영속 예약으로 15분 cooldown·rolling 24시간 2회 한도를 보존하며 불명확한 reset/start도 예산을 소비한다. reset 후 identity·inactive/dead·MainPID0·빈 cgroup을 재조회하고 `start --job-mode=fail`만 호출한다. 공개 보고는 고정 7필드이며 환경·로그·원문 오류를 반환하지 않는다.

systemd에는 Docker Engine과 같은 원자적 state CAS가 없다. 운영자가 의도적으로 멈추기 전 `recoverEnabled=false`로 disarm해야 한다. 설치 후 운영 실패 복구 드릴은 이 단위 회귀와 구분해 기록해야 한다.

이후 주 작업은 Osaka 전용 SSH 설치와 recoverEnabled=true, Oracle→Osaka 실제 probe 정상 및 `id` 거절(exit1)을 확인했다. 설치 당시 consumer는 유지했고, 별도 정상 drain·TTL 대기·검증된 release 전환으로3c63/Node24.22.1·npmUndici8.12.3에 갱신했다. 이 설치·권한·정상 runtime 전환 증명은 실제 consumer 실패 후 시작 드릴을 대신하지 않는다.

첫 실제 native 드릴은10:03:09Z 관측 EXIT1로 실패했다. false prestart3회 뒤 PID1은 시작 제한을 기록했지만 실제 Result는 exit-code였고, 시험도구의 start-limit-hit 가정 때문에 Oracle 재활성화 단계에 도달하지 못했다. fallback timer의 실제 발화도 늦었으며, fallback은 새 consumer를 시작한 뒤 결과 영수증·rearm을 완료하지 못했다. root는 기존 driver/fallback 종료와 빈 cgroup·job0, 새 PID·boot·fresh health·원 파일 정체성을 확인한 다음 자기 elapsed timer 종료와 원 recoverEnabled 복원만 수행했다. 이 마무리에서 consumer start/stop/reset은0이다.

첫 시험의 최종 read-only 증거는 native/Oracle 예산0·Oracle 복구 이벤트0, 원 config/identity와 fresh health, DB writer/fence/agent control/settings 전후 동일을 확인했다. 독립 security는 연결된8개 파일 해시·크기와 old unit 원문을 검증했다. 기존 fallback에 FileNotFoundError를 주입한 offline 재현은 예외 탈출·영수증/rearm 미도달을 보였지만 실제 historical 원인으로 단정하지 않는다. 원 실패와 모든 once는 보존했다.

이후 고정 followup1은 원 terminal/operator 복원 SHA에 결속한 단1회 새 예약, 절대 OnBootSec·reload 후 typed deadline 검증, 실제 PID1 control-exit3/counter1·2·3/limit 순서, known old DB PID의 bounded pending과45초 전후·내부 명령 제한을 적용했다. 작성자/security/root 각90/90 offline PASS 뒤 양host root0600 새 경로에 exclusive 설치했다. 실제10:54:46.973Z EXIT0/PASS: 같은 failed version180초/복구가능1·2·3/Oracle requested1회/양budget각append1/newPID1886533·새 supervisor serviceboot/freshhealth/fallback발화0. 독립 최종 읽기에서 원env/config/source/caps/fullrelease, empty driver/fallback·inactive timer/LastTrigger0·job0, DB writer/fence/agent settings 전후 동일과 네 Push ACK를 확인했다. native실패 bad2 cycle의 Telegram API수락도 기록했다. 원 시험의 FAIL, runtime hang·모델/provider·DB DR 미검증 범위는 유지하며 자세한 SHA는 [native 복구 실증](2026-10-25-native-recovery-verification.md)을 따른다.

## 독립 incident 알림 검토

[incident notifier](../../scripts/ops/incident_notifications.py)는 optional root0600 구성의 기존 bot/chat 목적지만 사용한다. HTTP 목적지는 `api.telegram.org:443`과 검증한 token의 고정 sendMessage path이며 proxy·redirect·shell이 없다. token/chat은 argv·환경·state·로그에 저장하지 않고 격리 child의 stdin으로만 전달한다. child는 빈 환경과 Python `-I`로 실행하고 부모가 DNS/connect/read를 포함한 5초 제한에서 kill/reap한다. stdin은 32 KiB, 응답은 16 KiB, 본문은 4096자로 제한한다. 성공은 HTTP200·API ok=true·bool이 아닌 양의 정수 message_id를 모두 요구한다.

알림 state는 고정 host/service/stage/reason 서명과 firstSeen/sent만 보존한다. 전체 pipeline이 이미 DOWN이어도 새 fault를 전송하며 본문에 실제 포함된 서명만 ACK 뒤 sent로 기록한다. 다음 batch는 pending으로 남는다. 관측 누락·불완전한 inventory는 해소 증거로 쓰지 않고 명시적 성공·빈 provider 목록·receiver true로 해소한다. provider duration의 missing-reset과 알림 incident의 missing-preserve는 목적이 다르다. 새 gateway가 fresh replica 모두의 명시적 빈 provider 목록을 보존하는 회귀도 확인했다.

ACK 유실이나 ACK 후 state 저장 전에 종료되면 Telegram이 이미 보냈어도 재시도할 수 있다. 이 경로는 at-least-once이며 exactly-once 전송을 주장하지 않는다. 독립 검토 중 발견한 테스트 fixture의 `TestCase.fail` 이름 충돌은 담당자가 `fail_service`로 바꿨고, 수정된 실제 assertion으로 전체 회귀를 다시 실행했다. notifier production source에 추가 차단 결함은 발견하지 않았다.
