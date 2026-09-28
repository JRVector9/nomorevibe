# 2026-09-28 워커 장애 복구 배포·시험

## 현재 배치

main `2f8a6bb607e622b18ba512415b4004d19f5557e5` (PR #215)의 웹 M3·mini,
M3 scheduler/crawler/reviewer/publisher/text/maintenance와 mini crawler·reviewer 예비,
총 10개 Dokploy 앱의 최신 배포가 `done`이고 같은 소스 commit·`RELEASE_TAG`를 가진다.
connect-agent는 이 10개와 별도 앱이며 이번 릴리스 대상이 아니다.

| 역할 | 운영 배치 | 실행 방식 |
|---|---|---|
| scheduler | M3 2복제본 | 두 poller가 DB의 같은 due 요청을 합침 |
| crawler | M3 주 + mini 예비 | `m3-crawler`와 `mini-crawler-standby`가 DB lease 경쟁 |
| reviewer | M3 주 + mini 예비 | `m3-reviewer`와 `mini-reviewer-standby`가 DB lease 경쟁 |
| publisher/text/maintenance | M3 각 1개 | supervisor와 Swarm 재시작, 예비 없음 |

mini 예비 앱의 Dokploy ID는 crawler `GfIKV_iTLs3uifo-A3ate`, reviewer
`Len0UIDDJlawK2jvnnPjl`이다. 둘 다 `autoDeploy=false`라 새 릴리스 때
주 후보와 같은 이미지·`RELEASE_TAG`로 수동 교체해야 한다. DB streaming이나 서버
장애 대응 설정은 변경하지 않았다.

## 코드·CI 검증

- `npm test`: 152파일/1217 통과.
- `npm run test:integration`: PostgreSQL 93파일/906 통과·TODO1. 동시 scheduler
  요청 합치기, 실제 후보 프로세스의 SIGKILL·lease 인계, late write fencing을 포함한다.
- `npx next typegen` 뒤 `npx tsc --noEmit`, `npm run lint`, `npm run build`,
  `git diff --check` 통과. lint와 build에는 기존 vendor/CLI 추적 경고가 남는다.
- PR #215 최신 head의 GitHub Actions 필수 `check`에서 위 단계가 모두 통과했다.

## 운영 장애 주입과 관측

1. scheduler를 2복제본으로 올린 뒤 두 컨테이너 `healthy`, 서로 다른
   `service:scheduler:m3-scheduler-<hostname>` 관측 2개가 15초 안에 갱신되는 것을
   확인했다. `crawl-fetch` requested/processed version과 `next_scheduled_at`이 전진했고
   `check-worker-progress.ts`는 scheduler `scheduled`를 반환했다.
2. crawler 주 후보의 `worker.ts` 자식을 `SIGKILL`했다. Swarm이 비정상 종료 코드1을
   보고 컨테이너를 재시작했고, 주 후보가 lease 만료 뒤 epoch 1→2를 재획득했다.
   예비는 계속 대기했다. 이어 M3 crawler 서비스를 0으로 내려 정상 drain하자 mini 예비가
   epoch 3으로 활성화됐다. M3 서비스를 1로 복귀시키고 예비를 정상 drain한 뒤 M3가
   epoch 4로 재선출됐다. 두 서비스 모두 다시 `healthy`이며 예비 phase는 `standby`다.
3. reviewer도 자식 `SIGKILL` 뒤 Swarm 재시작과 주 후보 epoch 1→2, M3 서비스 0일 때
   mini 예비 epoch 3, 복귀 때 M3 epoch 4를 확인했다. 예비 활성 중 `second-review`의
   requested/processed version이 함께 전진했다. 최종 두 서비스는 `healthy`이며
   예비 phase는 `standby`다.
4. 최종 읽기 전용 진행 판정은 `overall=ok`, scheduler `scheduled`, crawler·reviewer
   liveness `present`, 모든 단계 `no_work`였다. 공개 `/api/health`에서 M3·mini 웹이
   각각 HTTP200, app/DB `ok`, 릴리스 SHA 일치를 반환했다.

이 시험은 자식 강제 종료 때 **주 후보의 첫 재시작**, 주 서비스 정상 종료 때 **예비
승격과 복귀**를 실측했다. 주 서비스가 비정상 종료한 뒤 재시작까지 계속 실패하는
복합 장애는 로컬 PostgreSQL 통합 시험에서 lease 만료를 앞당겨 검증했고, 운영에서
실제 복구 시간을 측정하지 않았다. 예비 활성 구간에는 새 적격 자료가 없어 예비가
수집 문서나 심사 결과를 저장하는 장면도 확인하지 못했다. 반복 부팅 3회/5분 격리와
실제 `no_progress` 자동 재시작의 운영 주입, 24시간 관측, 독립 감시자·외부 알림은 남았다.

## 다음 운영 확인

```sh
node --import tsx scripts/check-worker-progress.ts
```

운영 DB 환경은 기존 비밀 저장소에서 주입한다. `role_leases`의 owner/epoch,
`operations_observations`의 네 candidate phase와 두 scheduler 관측 시각,
`jobs`의 requested/processed version을 함께 본다. 다음 릴리스는
[독립 워커 운영 절차](independent-workers-runbook.md)의 예비 먼저 drain 순서를 따른다.
