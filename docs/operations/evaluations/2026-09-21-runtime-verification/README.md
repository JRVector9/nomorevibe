# 수집·평가 기능 및 속도 확인

2026-09-21 16:47 KST. 운영 릴리스 `8ec1adc`, 로컬 `5146d13`에서 확인했다. **자동 수집→심사→발행은 작동한다. 대기 단축은 통제 실험에서 재현됐고, 운영에서는 발행과 번역의 병행 실행을 확인했다. 운영 전체의 개선율은 아직 확정할 수 없다.**

고정 운영 표본은 16:10–16:40 KST(07:10–07:40 UTC), 30분이다. DB는 read-only transaction으로 조회했고 자연 실행 로그만 관측했다. 재심사 요청, 운영 데이터 수정, 모델·승인 기준 변경, 재배포는 하지 않았다. 판단의 의미적 정확도·오탐률을 사람 정답으로 평가한 시험은 아니다.

## 기능 확인

| 항목 | 실제 결과 |
|---|---|
| 발견·수집 | 신규 발견 136건, 원본 수집 150건, 건너뜀 2건, 수집 실패 0건. DB와 수집 로그 수량 일치 |
| GitHub 제한 | 수집 한도 대기 7회. 이후 수집 진행, 16:44 확인 시 pending/fetching 0건 |
| 1차 심사 | 실제 새 호출 38건: 성공 36, 응답 형식 오류 `invalid_output` 2. 실패 2건은 needs_review/ambiguous로 남고 승인되지 않음 |
| 2차 심사 | 기본 모델 22건: 정상 응답 19, 형식 오류 3. 오류 3건 모두 연결된 Sonnet fallback 승인 확인. 정상 응답 중 6건은 사람 확인으로 보류 |
| 발행 | 고정 30분 동안 신규 발행 16건. 배포 안정화 이후 별도 표본 29건에서 유효 1차·독립 2차 승인 누락 0건, 전체 동일 저장소 중복 그룹 0건 |
| 워커 분리 | 발행 작업 완료 14회 중 6회가 text 작업 실행 중 발생. publisher가 번역·소개 작업을 실행한 사례 0회 |
| 작업·서버 | 관측 로그의 job.failed 0건. 웹 2대 HTTP 200/DB 정상, 워커 7개 healthy/재시작 0. 워커별 핵심 11파일 해시 일치. 9앱 자동 배포 모두 true |
| 화면 | 홈·상세·인기·운영센터·심사 큐·2차 보류·제품 관리·크롤 설정 HTTP 200. 작업 상세와 번역 실패 팝업 열기/닫기 성공. 브라우저 예외·추가 관리자 검사 console error·서버 5xx 0. 모바일 가로 넘침 없음 |

`job.completed`는 개별 모델 응답 성공을 뜻하지 않는다. 따라서 작업 오류 0건과 모델 오류 5건을 분리했다. 1차 실패 2/38(5.3%), 기본 2차 실패 3/22(13.6%)는 이 작은 표본의 값이며 장기 오류율이 아니다. 전체 작업의 last_error는 조회 시 모두 비어 있었다.

## 현재 속도

30분 중 발행된 16건을 추적했다. 그중 이전 심사 이력이 없는 13건과 재심사 3건을 구분한다.

| 신규 발행 13건의 단계 | 중앙값 | p95 |
|---|---:|---:|
| 원본 수집 → 1차 시작 | 20.2초 | 24.8초 |
| 1차 실행 | 9.65초 | 15.44초 |
| 1차 완료 → 2차 등록 | 24.2초 | 36.0초 |
| 2차 등록 → 완료 | 10.9초 | 19.9초 |
| 2차 완료 → 발행 | 12.7초 | 17.0초 |
| 원본 수집 → 발행 | **71.7초** | **92.6초** |

각 단계 중앙값의 합은 전체 중앙값과 같지 않다. 이 값은 성공 발행 표본의 속도이며 거절·오류·사람 보류를 포함한 전체 후보의 SLA가 아니다. 현재 원본의 fetched_at을 사용하므로 불변 수집 이력을 대신하지 않는다.

전체 발행 16건의 수집→발행 중앙값은 73.7초, 2차 완료→발행은 11.3초다. 재심사 3건에는 수시간 된 원본이 섞여 전체 수집→발행 p95가 약 8시간이 된다. 또 기존 1차 queue 로그는 실행 가능 시각이 아니라 `candidate.updatedAt`을 기준으로 하므로 p95 약 55시간을 그대로 신규 큐 대기로 해석하면 안 된다. 실제 모델 호출은 1차 중앙값 9.61초, 2차 6.02초이며, 1차 저장 완료→2차 모델 시작은 중앙값 17.86초다(로그 25쌍).

과거 109건 재심사 표본의 2차 완료→발행 중앙값 35.2초보다 현재 전체 16건의 11.3초가 짧다. 하지만 과거는 일괄 재심사 적체였고 지금은 신규·재심사 혼합이므로 **68% 운영 개선이라고 해석하지 않는다.** 같은 조건의 충분한 전후 표본은 확보하지 못했다. 안정화 이후 30분 동안 신규 1차 호출은 38건으로, 계획의 100건 기준에도 못 미친다.

## 같은 조건의 코드 비교 재실행

`af50608`과 현재 `5146d13`의 실제 작업 코드를 동일 harness에서 실행했다. 가상 시계·모의 DB·고정 모델 응답이며 각 버전 3개 테스트가 통과했다.

| 조건 | 이전 | 현재 | 감소 |
|---|---:|---:|---:|
| 8건 심사, 응답 10초, 동시성 4 | 70초 | 20초 | 71.4% |
| 8건 심사, 응답 24초, 동시성 4 | 84초 | 53초 | 36.9% |
| 번역 30초 중 요청한 발행의 시작 대기 | 34초 | 4초 | 88.2% |

두 버전 모두 8건 완료·최대 동시성 4·모의 오류 0이다. 네트워크, 실제 DB, 모델 부하, 이미지 처리 비용을 반영한 운영 처리량 수치는 아니다. 재현 harness는 [기존 비교 자료](../2026-09-21-review-speed/README.md)에 있다.

## 남아 있는 운영 사항

- 모델 형식 오류는 남아 있다. 1차 오류 보류와 2차 fallback은 동작하며 실패를 승인으로 바꾸지 않는다.
- 사람 확인 대기 469건이 조회됐다(16:44 스냅샷). 이 큐는 자동 처리 성능 개선으로 없어지지 않는다.
- 운영센터는 번역 실패 1건, 응답하지 않는 공개 제품 50건을 표시했다. 모두 이번 실행에서 새로 생겼다고 판단할 근거는 없다.
- 이전에 기록한 익명 관리자 접근이 이번 새 브라우저에서도 재확인됐다. 접근 정책은 변경하지 않았다.
- 신규 표본에서도 1차 완료→2차 등록 대기 중앙값 24.2초가 남는다. 워커의 다른 실행과 슬롯 점유를 포함하므로 기본 poll 5초가 전체 단계 지연 보장은 아니다.

## 실행한 검증과 재현

- `npm test`: **141파일 / 1,094개 PASS**, 4.58초.
- `TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test npm run test:integration`: **79파일 / 767개 PASS**, 93.23초. 전용 로컬 테스트 DB만 사용했다. 실패 경로를 의도적으로 시험한 error 로그는 최종 테스트 실패와 구분했다.
- `npx tsc --noEmit`: **종료 코드 0**.
- 비교 harness: 이전·현재 각 **3개 PASS**.
- 운영 브라우저: `node .crawl-samples/review-speed/deploy-browser.mjs`, `node .crawl-samples/review-speed/verification-browser.mjs` 모두 **종료 코드 0**.

운영 원본은 [evidence.json](evidence.json), 추가 조회 및 화면 점검 소스는 `verification-audit.mjs.txt`, `verification-browser.mjs.txt`에 보관했다. 쿼리 재실행은 현재 상태 변경의 영향을 받을 수 있다. `/tmp/nmv-installable-web.env`는 기존 개인용 자격 정보 파일이며 출력하거나 저장소에 넣지 않는다.

```sh
python3 /tmp/nmv-speed-dokploy.py status
python3 /tmp/nmv-speed-runtime.py /tmp/nmv-check-runtime-next.json
node .crawl-samples/review-speed/verification-audit.mjs
node .crawl-samples/review-speed/verification-browser.mjs
NMV_SPEED_ROOT=/tmp/nomorevibe-speed-baseline-20260921 NMV_SPEED_VARIANT=af50608 NMV_SPEED_OUTPUT=/tmp/nmv-check-before.json npx vitest run --config .crawl-samples/review-speed/vitest.comparison.config.mts
NMV_SPEED_ROOT=/Users/jr/Desktop/projects/nomorevibe NMV_SPEED_VARIANT=5146d13 NMV_SPEED_OUTPUT=/tmp/nmv-check-after.json npx vitest run --config .crawl-samples/review-speed/vitest.comparison.config.mts
```

진단 중 Docker service logs의 `--until` 시도는 JSON 결과가 없어 실패했다. 기존 `--since` 읽기 방식과 파싱 후 UTC 상한 필터로 재실행해 고정 30분 수집 수치를 얻었다. 앱 코드 변경은 없다.
