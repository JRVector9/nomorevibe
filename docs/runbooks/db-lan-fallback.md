# DB·Valkey 연결 경로: LAN ↔ Tailscale fallback runbook (2026-10-17)

2026-10-17 11:16 KST V9-Primary·Replica의 Tailscale 노드 키가 만료돼, Tailscale 주소로만 DB를 찾는 웹·워커가 5시간 DB에 못 붙었다.
이 문서는 앱이 **새 TCP 연결마다 URL의 주소를 먼저 시도하고, TCP 연결이 안 될 때만 `*_FALLBACK_HOST`로 넘어가는** 기능의 설정·배포·되돌리기 절차다.
이 문서의 운영 단계는 **모두 사용자 승인 뒤** 실행한다.

## 먼저 알아야 할 것

1. **앱 fallback만으로는 오늘 같은 장애를 막지 못한다.** Patroni의 DCS(etcd 3대: V9-Primary·V9-Replica·9mini)는 peer·client 주소가 모두 Tailscale이다.
   2026-10-17 02:17:04 UTC Patroni가 `demoting self because DCS is not accessible and I was a leader`로 주 DB를 스스로 내렸고, 07:29 UTC에야 다시 leader가 됐다.
   그동안은 LAN으로 붙어도 읽기 전용이었다(쓰기 실패). 재발을 막으려면 DB 쪽 결정이 따로 필요하다(서버 노드 Tailscale 키 만료 끄기, etcd·Patroni를 LAN 주소로).
2. **넘어가는 조건은 TCP 연결 실패뿐이다**(거절·도달 불가·1초 안에 안 열림). 그때는 PostgreSQL/RESP 바이트를 하나도 보내지 않았으므로 쿼리·쓰기가 두 번 나갈 수 없다.
   연결된 뒤의 쿼리 오류·인증 거절(pg_hba `28000`)·끊김은 넘기지 않고 원래대로 오류가 난다.
3. **새 연결마다 URL의 주소부터 다시 시도한다.** 원래 길이 돌아오면 다음 새 연결부터 그 길을 쓴다. 이미 열린 연결은 수명(`DB_MAX_LIFETIME_SECONDS`, 기본 30분)까지 그대로다.
4. **`*_FALLBACK_HOST`가 없으면 동작이 지금과 같다**(드라이버 옵션·health 응답·관측 값 모두 그대로). Oracle osaka-smoke에는 두지 않는다 — Oracle은 Tailscale만 쓴다.
5. 컨테이너(OrbStack) 실측(2026-10-17, `dokploy-network`에 붙인 임시 컨테이너, 10회):
   - LAN으로 새 TCP 연결을 열면 **첫 번째·세 번째 왕복이 약 200ms씩 멈춘다**(그 뒤 왕복은 LAN 0.4ms·Tailscale 0.9ms). Tailscale 경로와 호스트(컨테이너 밖)의 LAN 경로에는 없다.
     PostgreSQL 새 연결은 인증까지 왕복이 3번이라 LAN에서 약 +400ms가 든다(연결 수명 30분마다 한 번).
   - M3 컨테이너의 LAN 출발 주소는 `192.168.139.2`(OrbStack VM)다. PgBouncer(6432, hba 없음)·Valkey(6380)는 받지만 **V9-Replica·V9-Primary 5432의 pg_hba가 거절한다**
     (`no pg_hba.conf entry for host "192.168.139.2"`). mini 컨테이너는 `192.168.50.246`으로 나가 모두 받는다.
   - 그래서 **M3 웹에는 `READ_DATABASE_FALLBACK_HOST`를 두지 않는다**(복제본 연결이 안 되면 기존 규칙대로 30초 동안 주 DB로 읽는다).

## 설정

| 환경변수 | 쓰는 곳 | 값 모양 | 짝 |
|---|---|---|---|
| `DATABASE_FALLBACK_HOST` | lib/db 주 DB 풀(웹·모든 워커) | `host:port` | `DATABASE_URL` |
| `READ_DATABASE_FALLBACK_HOST` | 웹 공개 읽기 복제본 풀 | `host:port` | `READ_DATABASE_URL` |
| `VALKEY_FALLBACK_HOST` | 웹 공유 캐시 | `host:port` | `VALKEY_URL` |

- 값은 IPv4나 이름과 포트 하나다(쉼표·IPv6·URL 불가). 비밀이 들어가지 않는다 — 계정·비밀번호·DB 이름은 짝 URL의 것을 그대로 쓴다.
- 짝 URL은 명시 포트가 있는 host 하나여야 한다(여러 host URL은 거절). 틀린 값이면 DB는 첫 쿼리에서 바로 실패하고(health 503 → 배포 확인에서 걸린다),
  Valkey는 `cache.valkey_config_invalid`를 남기고 캐시를 끈다(읽기는 DB로).
- 빈 값(`KEY=`)은 설정하지 않은 것으로 본다.
- 격리 DB를 쓰는 replay·용량 측정 도구는 `DATABASE_FALLBACK_HOST`·`READ_DATABASE_FALLBACK_HOST`가 있으면 거부한다(격리 DB 밖으로 새 연결이 나갈 수 있다).

### 선택지 (사용자 결정)

주소: Primary LAN `192.168.50.18`, Primary Tailscale `100.99.209.55`, Replica LAN `192.168.50.248`, Replica Tailscale `100.85.113.10`.

**A. LAN 먼저, 안 되면 Tailscale (사용자 지시 그대로)** — URL의 주소를 LAN으로 바꾸고 대신 주소에 Tailscale.

| 앱 | 바꿀 것 |
|---|---|
| 모든 M3·mini 앱(웹·워커·scheduler·text·maintenance·connect-agent·mini 예비 5) | `DATABASE_URL`의 `host:port`만 `<LAN 192.168.50.18>:6432`로, `DATABASE_FALLBACK_HOST=<TS 100.99.209.55>:6432` |
| web-mini | `READ_DATABASE_URL`의 `host:port`만 `<LAN 192.168.50.248>:5432`로, `READ_DATABASE_FALLBACK_HOST=<TS 100.85.113.10>:5432` |
| web-m3 | `READ_DATABASE_URL` 그대로(Tailscale), `READ_DATABASE_FALLBACK_HOST` 없음 — pg_hba가 `192.168.139.0/24`를 받기 전까지 |
| web-m3·web-mini | `VALKEY_URL`의 `host:port`만 `<LAN 192.168.50.18>:6380`로, `VALKEY_FALLBACK_HOST=<TS 100.99.209.55>:6380` |

비밀이 든 URL을 고쳐야 한다(`host:port` 부분만, 값은 찍지 않는다). 새 연결마다 약 +400ms(위 5번)가 든다.

**B. Tailscale 먼저, 안 되면 LAN** — URL은 그대로 두고 대신 주소만 더한다.

| 앱 | 더할 것 |
|---|---|
| 모든 M3·mini 앱 | `DATABASE_FALLBACK_HOST=<LAN 192.168.50.18>:6432` |
| web-mini | `READ_DATABASE_FALLBACK_HOST=<LAN 192.168.50.248>:5432` |
| web-m3 | (없음 — 위 hba 이유) |
| web-m3·web-mini | `VALKEY_FALLBACK_HOST=<LAN 192.168.50.18>:6380` |

비밀을 고치지 않고 한 줄씩 더하기만 한다. 평소 지연은 지금과 같고, Tailscale 경로가 끊길 때만 LAN으로 넘어간다.

Oracle osaka-smoke: 어느 쪽이든 **바꾸지 않는다**(`DATABASE_URL`은 Tailscale, `*_FALLBACK_HOST` 없음).

## 배포 순서

0. 이 기능이 든 릴리스를 평소대로 전 앱에 올린다(환경변수는 아직 그대로 → 동작 불변). `/api/health`에 `networkRoutes`가 없는지 본다.
1. **mini 예비 5개**(publisher·reviewer·crawler·text·maintenance standby): 환경변수 저장 → 재배포. 예비라 일을 하지 않는다 — `role_leases`가 그대로인지,
   `operations_observations`의 해당 서비스 값에 `networkRoutes.primary`가 기대 경로인지 본다.
2. **web-mini**(2대): 저장 → 재배포 → 각 복제본 `/api/health`: `db: ok`, `networkRoutes.primary`·`read`·`valkey`가 기대 경로.
3. **web-m3**(4대): 같은 확인.
4. **M3 역할 앱**: connect-agent 먼저(관측 `service:connect-agent:*` 갱신 확인) → publisher → reviewer → crawler → scheduler(2대) → text → maintenance.
   text·maintenance를 재시작하는 동안 mini 예비가 lease를 가져가면 스스로 놓지 않는다 — `docs/operations/independent-workers-runbook.md`의 예비 scale 0→1 절차를 따른다.
5. 하루 관측: 로그 `db.connection_fallback`·`cache.valkey_fallback_opened`(평소 0), health `dbLatencyMs`, 웹 오류율, V9-Primary `ss` 의 6432·6380 출발 주소
   (A면 M3 `192.168.139.2`·mini `192.168.50.246`, B면 Tailscale 주소).

## 확인 명령 (읽기 전용)

- health: 웹 컨테이너 안이 아니라 Traefik/서비스 경로로 `/api/health` → `networkRoutes`(이름만, 주소 없음).
- 워커 관측: `select key, value->'networkRoutes' from operations_observations where key like 'service:%'`.
- DB 쪽 출발 주소: `ssh jr@100.99.209.55 'ss -Htn state established "( sport = :6432 or sport = :6380 )"'`.

## 되돌리기

- B: 더한 `*_FALLBACK_HOST` 줄을 지우고 재배포(같은 순서). 코드 되돌리기는 필요 없다(변수가 없으면 동작이 지금과 같다).
- A: `DATABASE_URL`·`READ_DATABASE_URL`·`VALKEY_URL`의 `host:port`를 Tailscale 주소로 되돌리고 `*_FALLBACK_HOST`를 지운 뒤 재배포.
- 이 릴리스 이전 코드로 돌아가도 `*_FALLBACK_HOST`는 무시된다 — A에서 URL을 LAN으로 바꾼 채 옛 코드로 돌아가면 LAN만 쓰고 fallback은 없다.
