# 2026-11-15 DB 디스크 장애 — 03:10Z 전조와 07:09Z 정지

공유 Postgres(V9-Primary, Patroni `postgres-ha`)의 데이터 볼륨 `/data/postgres`(당시 40G)가 하루에 두 번 가득 찼다.
07:09–10:15Z 정지는 소유자가 볼륨을 70G 로 늘려 끝났고, 같은 날 og_images MinIO 이전(#960)·보관 정리(#967)·VACUUM FULL 로 DB 가 29GB → 15GB 가 됐다.
이 문서는 03:10Z 전조의 원인과 재발 방지 조치를 남긴다.

## 03:10Z — 같은 디스크 가득 참이었다

`/var/log/syslog` 에서 확인했다. 주 DB 의 journal 은 느린 쿼리 로그에 밀려 09:38Z 이전이 남아 있지 않았다.

| UTC | 일 |
| --- | --- |
| 03:08:35 | 정상 checkpoint |
| 03:10:43 | `PANIC: could not write to file "pg_wal/xlogtemp…": No space left on device`(checkpointer) |
| 03:10–03:20 | `core_pattern` 이 apport 파이프여서 커널이 RLIMIT_CORE(소프트 0)를 무시하고, apport 가 10.5GB `.crash` 를 `/var/crash` 에 썼다. 그동안 checkpointer 가 끝나지 않아 postmaster 가 재시작하지 못했다 |
| 03:12–03:20 | 연결이 `max_connections` 150 까지 쌓였다(postgres_exporter: 「remaining connection slots are reserved」→「too many clients」). Oracle consumer 둘이 이때 연결이 끊긴 뒤 시작 한도에 걸려 멈췄다(#961 로 보완) |
| 03:20:43–48 | 덤프가 끝나 crash 재시작, redo 1초, 연결 받음 |
| 03:21–07:09 | 볼륨이 거의 찬 채 `base/pgsql_tmp` 쓰기 실패가 이어지다 07:09 에 WAL 을 못 써 crash loop |

복제본도 10:07–10:16Z 에 같은 식으로 10.1GB 덤프를 남겼다.
그 시각의 마지막 한 방울은 확정하지 못했다(디스크 사용 이력·임시 파일 로그가 없음). 바탕은 DB 증가(og_images 9GB 등)였고,
사유 번역 진행 쿼리(monitor `reason_sources`·text 대기 조회)가 돌 때마다 100~260MB 임시 파일을 쓴다(재시작 뒤 7시간 346GB, `temp_file_limit` 없음).

## 조치(2026-11-15 소유자 승인 「a b c d e 다 진행해」)

| | 조치 | 영수증 |
| --- | --- | --- |
| a | 두 서버의 크래시 덤프 삭제(주 10.5GB·복제본 10.1GB) | 주 DB 루트 88% → 77% |
| b | 주 DB `ALTER SYSTEM`: `log_min_duration_statement` 100 → 500ms, `log_parameter_max_length` -1 → 256 · reload | 기록되는 문장 약 72% 감소(표본 12,568건 중 500ms 이상 3,490) |
| c | 두 서버 apport 끔(`apport.service`·autoreport·forward) → `core_pattern=core`. 모든 서비스의 코어 소프트 한도가 0이라 덤프 없이 바로 끝난다 | 두 서버 `core_pattern=core`, apport inactive |
| d | Patroni 동적 설정 `temp_file_limit=5GB`(두 노드, reload) | 두 노드 5242880kB, `pending_restart=f` |
| e | Oracle 디스크 경보 타이머 — [runbook](oracle-recovery-runbook.md#db-서버-디스크-경보-2026-11-15) | 설치 영수증은 설치 뒤 따로 |

d 의 두 쿼리 자체(임시 파일을 쓰지 않게)는 별도 PR 이다.

## 남은 위험

- 주 DB 루트(`/`)의 `/var/log` 가 크다(syslog 가 Postgres 로그를 그대로 복사, 하루 최대 29GB). b 로 줄었고 e 가 루트도 본다.
- 복제본 루트의 WAL 보관(`/data/wal-archive`, 25GB 상한·매시간 정리)은 큰 다시 쓰기(VACUUM FULL 등) 동안 상한을 넘었다가 정각에 줄어든다.
- 실제 80% 넘김 알림 드릴은 하지 않았다.
