# 2026-09-29 운영 DB 논리 백업 복원 검증

## 범위

워커 failover 작업 중 운영 DB의 존재와 복제 상태를 **읽기 전용**으로 확인했다. 운영 DB는
Patroni primary/replica 스트리밍으로 이미 구성되어 있다. Primary의 `pg_stat_replication`은
replica `v9-replica`를 `streaming`/async/lag 0바이트로 보였고, replica의 WAL receiver도
`streaming`이었다. Primary에서 `archive_mode=on`, 당시 아카이브 실패 0건을 확인했다.
DB 서버 설정·역할·운영 데이터는 변경하지 않았다.

이는 특정 시점의 관측이다. WAL 아카이브가 켜져 있다는 사실만으로 보관 기간이나 기존
백업의 복구 성공을 입증하지는 않는다.

## 격리 복원 시험

로컬 Docker PostgreSQL 17 컨테이너 `nomorevibe-test-db`에 시험 DB
`nomorevibe_restore_verify_20260929`를 만들었다. 처음에는 운영 replica에서
`pg_dump -Fc --no-acl --no-owner`를 스트리밍해 `pg_restore --exit-on-error`로
복원했으나, `crawl_review_attempts`를 읽는 동안 hot standby recovery conflict로
취소됐다. 이 부분 복원 DB는 폐기하고 새로 만들었다. 운영 primary에서 같은 논리 dump를
스트리밍한 두 번째 `pg_restore`는 종료 코드 0으로 완료됐다. 운영 DB에서는 dump용
읽기만 수행했다. 대조 뒤 로컬 시험 DB를 `dropdb`로 삭제했고 명령은 종료 코드 0이었다.

| 대조 항목 | 운영 원본 | 로컬 복원 |
|---|---:|---:|
| `products` 행 | 19,894 | 19,894 |
| `crawl_documents` 행 | 107,220 | 107,220 |
| `jobs` 행 | 25 | 25 |
| Drizzle migration 행/최대 ID | 53/53 | 53/53 |
| Drizzle migration hash 집계 MD5 | `4d430ae1bbb51fe8729aa802111a5067` | 동일 |
| `og_images` 행 | 19,865 | 19,865 |
| `og_images.data` 총 바이트 | 2,009,099,011 | 2,009,099,011 |
| `og_images` 표본 1건 바이트/MD5 | 38,948 / `7e0f955bdee0f0b8b7eadf952ee5614d` | 동일 |
| `media_assets` 행 | 0 | 0 |

표본은 `og_images.slug='00-aakash-00skills'`였다. 원본과 복원을 대조하는 사이에도
운영 데이터는 계속 쓰일 수 있으므로 표의 행 수 일치는 **대조한 표본 시점의 결과**다.
복원 DB 물리 크기 3,649,844,915바이트와 운영 DB 물리 크기 4,068,816,563바이트는
다르다. 논리 복원 뒤 테이블·인덱스 배치와 원본의 누적 공간 차이가 있으므로 물리 크기
동일성은 성공 조건으로 사용하지 않았다.

## 검증 경계

- 이 시험은 **지금 새로 생성한 논리 백업**의 격리 복원이다. 기존에 보관된 과거 백업본의
  복원, 보존 기간, 시점 복구는 검증하지 않았다.
- `media_assets`에 행이 없어 `web_data`·`thumbnail_data`의 비어 있지 않은 바이너리
  복원은 검증할 수 없었다. 대신 실제 데이터가 있는 `og_images.data`를 확인했다.
- DB 볼륨/WAL 여유와 PgBouncer 최대 연결 용량의 장기 적정성은 이 시험의 결과가 아니다.
  DB 인프라는 별도로 구성·운영 중이며 워커 failover 범위에서 변경하지 않는다.
