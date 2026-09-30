# 수집 중단 의심 확인 — 2026-09-26 21:09–21:12 KST

사용자: “수집이 멈춘거같아”. 운영 상태를 조회하고 다음 예약 수집까지 관찰했다. **현재 수집 중단은 확인되지 않았다.**

- 21:09:11 DB 스냅샷: 최근1시간 신규발견169 / 원본수집170 / 규칙170 / AI1성공38회 / AI2성공26표 / 발행15. 최근24시간 원본수집3,826건.
- 마지막 수집21:01:59, 처리 가능한 수집 큐0. 스냅샷 최근1분/5분 수집0이었다. crawl-fetch는 매분 실행해 drained=true로 큐가 비었음을 기록했고 last_error없음.
- crawler/reviewer/scheduler Docker healthy, 서비스 heartbeat4/2/8초 전. DB health ok1ms. 전체9앱Dokploydone/autoDeploytrue.
- 30분 로그: scheduler.tick178, crawl.seeded3, crawl.fetched30개 이벤트. job.failed없음. 오류 때문에 멈춘 정황 없음.
- 다음 예약 신규발견은21:11:35. 실제21:11:47 신규41건 발견 →21:12:03 원본41건 수집, failed0/skipped0/drainedtrue. 다음 배치가 정상 실행됨을 직접 확인했다.

## 보이는 수치가 0인 이유
`lib/jobs/catalog.ts`의 crawl-seed는10분 주기, crawl-fetch는1분 주기다. 신규 발견 배치를 금방 비우고 다음 발견을 기다리므로 그 사이 상단 최근1분과5분 평균이 모두0이 될 수 있다. 현재 UI는 '대기 없음'으로 표시한다. 발견 주기가 평균 집계5분보다 길어 멈춤으로 오해하기 쉽다. 권장 후속 개선은 마지막 수집 시각, 다음 신규발견 예정 시각, 최근10분/1시간 처리량을 함께 보여주는 것이다. 이번에는 운영 정상임이 확인돼 재시작/주기변경/큐강제실행/코드수정/재배포하지 않았다.

## 한계와 기존 문제
이 점검은 현재 수집 중단 여부를 확인했다. 9월25일 보고된 근거invalid 오류, 생존확인용량, 사람심사대기를 해결하거나 판정정확도를 검증한 것은 아니다. 최신 needs_review는1,989건(split1,826/ambiguous95/no_description68), 소개문검수not_before2100년 보류는 그대로다.

## 증거와 명령
`evaluations/2026-09-26-crawl-check/{db,apps,logs,live}.json`. API비밀값/환경원문 없음. READ ONLY DB조회 + Dokploy GET + SSH상태·로그조회만 실행. 단위/통합테스트는 구현변경이 없어 실행하지 않았다.

```sh
python3 /tmp/nmv-health-20260925.py audit
python3 /tmp/nmv-health-20260925.py status
ssh -o BatchMode=yes -o ConnectTimeout=8 jr@100.92.77.66 'docker service logs --raw --since 3m app-generate-haptic-card-vjqgv4'
```

기존helper는출력파일명을9월25일로유지하므로실행후당일증거폴더에복사해야한다. /tmp helper는다음세션에없을수있다. 운영DB대상테스트금지.
