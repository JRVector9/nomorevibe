# 전후 코드 비교 재현 자료

2026-09-21 14:57 KST. 개선 전 `af50608`, 개선 후 `bd4b36d`를 같은 Vitest harness로 각각 실행했다. 각 실행3개 테스트 통과. 모델/DB 응답은 모의이고 시계는 가상이다. 운영 전후 성능 측정이 아니다.

## 결과

| 조건 | 이전 | 개선 | 소요시간 감소 |
|---|---:|---:|---:|
| 1차8건, 응답10초, 동시성4 | 70초 | 20초 | 71.4% |
| 1차8건, 응답24초, 동시성4 | 84초 | 53초 | 36.9% |
| 번역30초 중 1초 시점에 요청한 발행의 대기 | 34초 | 4초 | 88.2% |

1차는 실제 각 checkout의 reviewCrawlCandidates와 jobRunOptions를 사용했다. tick 간에는 다른 작업이 없는 reviewer를 가정하고, 기존 catalog의60초 cadence 또는 ready continuation의 기본5초 poll을 harness가 재현한다. 모델 결과는 항상 동일한 승인 응답이고 DB 호출 지연은0이다. 두 버전 모두8건 완료, peak4, 모의 호출 오류0, timeout24초다. 이 결과로 운영 오류율이나 시간당 처리량을 추정하지 않는다.

발행 실험은 실제 runWorker와 jobsForRole을 사용한다. 번역은0초 시작, 발행 요청은1초에 도착, poll은5초다. 기존 publisher는 번역 종료30초 후 다음 poll인35초에 발행을 시작했고, 분리 버전 publisher는5초에 시작했다. 여기서 측정한 것은 발행 시작까지의 대기이며 분류/이미지 처리/발행 DB 저장 시간은 포함하지 않는다.

운영 워커6개에서 관련5개 파일 SHA256을 읽기 전용으로 확인했다. 모두 이전 코드와5/5 일치, 개선 코드와0/5 일치했다. 최종 PR166도 OPEN이다. 따라서 운영 개선은 아직 검증할 수 없다. 운영 DB/API 모델 호출, 배포, 큐 변경은 하지 않았다.

## 파일

- before.json / after.json: 원본 비교 결과.
- production-code-check.json: 워커별 해시 대조 결과(키·env 제외).
- before-after.test.ts.txt / vitest.comparison.config.mts.txt: 실제 실행 harness 원본. 앱이나 기본 테스트 모음에 import되지 않는 검증 자료다.

## 재현

기준 checkout `/tmp/nomorevibe-speed-baseline-20260921`은 af50608이며 node_modules는 현재 프로젝트 설치를 사용한다. 없는 경우 git worktree add --detach로 준비한다. 아래 명령은 저장소 루트에서 실행한다.

```sh
mkdir -p .crawl-samples/review-speed
cp docs/operations/evaluations/2026-09-21-review-speed/before-after.test.ts.txt .crawl-samples/review-speed/before-after.test.ts
cp docs/operations/evaluations/2026-09-21-review-speed/vitest.comparison.config.mts.txt .crawl-samples/review-speed/vitest.comparison.config.mts
NMV_SPEED_ROOT=/tmp/nomorevibe-speed-baseline-20260921 NMV_SPEED_VARIANT=af50608 NMV_SPEED_OUTPUT=/tmp/nmv-review-speed-before.json npx vitest run --config .crawl-samples/review-speed/vitest.comparison.config.mts
NMV_SPEED_ROOT=/Users/jr/Desktop/projects/nomorevibe NMV_SPEED_VARIANT=bd4b36d NMV_SPEED_OUTPUT=/tmp/nmv-review-speed-after.json npx vitest run --config .crawl-samples/review-speed/vitest.comparison.config.mts
```

현재 개선 checkout 이후 앱 코드가 바뀌면 비교 대상 commit과 artifact 표기를 함께 갱신해야 한다. 운영 검증은 병합·단계 배포 후 같은 조건의 신규 심사100건/30분 이상으로 대기 p50/p95, 시간당 처리량, timeout/429를 비교한다.
