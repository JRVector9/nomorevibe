# 제품 근거 갱신 추가 배치 — 2026-10-13

사용자의 기한 지난 출처 51,141건 갱신 요청에 따라 실제 운영 상태를 확인하고 기존 갱신 runner로 추가 배치를 실행했다. 앱 코드·배포 이미지·환경설정·수집 주기·기존 worker 구성을 변경하지 않았다.

## 운영 측정

2026-10-13 23:19:41 KST의 읽기 전용 DB 조회에서 전체 source 85,942개 중 기한이 지난 것은 51,104개였다. 경고 화면은 전체 출처를 세며 공개/비공개 제품과 현재 연결 여부를 제한하지 않는다.

후속 조회에서 현재 공개 제품의 visible 링크 출처 due23,667개, 저장소 갱신과 함께 수집하는 canonical_site 출처 due24,644개였다. 두 종류는 서로 다른 source 행이며 제품 수를 더해서는 안 된다. 비공개 제품 출처 due2,832개가 최장795시간(약33일) 경고의 원인이다. 공개 제품의 최장은 사이트57시간/저장소54시간이었다. visible 링크의 최초 source 없는 1,236개는 이 due source 집계와 별도이다. 수치는 갱신·새로운 기한 도래·발행에 따라 계속 바뀐다.

기존 product-evidence-refresh는 정상 실행 중이었다. 당시 마지막 batch 25.6초/시도7제품/완료6제품, 최근1시간 source 관측1,274개, cursor와 runs가 연속 조회에서 이동했다. 수집PAT와 App설치 각1개 enabled이며 GitHub cooldown은 없었다.

## 실행한 조치

2026-10-13 23:24:31 KST에 기존 crawler-m3 컨테이너 안에서 추가 배치를 시작했다. 1시간 한정이며 55초 협력 예산으로 기존 product-evidence-refresh handler를 반복 실행한다. 기존 job lease가 같은 작업의 중복 실행을 막고, requestedOnly=true가 pause/backoff를 보존한다. 15초 heartbeat, 기존 GitHub quota/재시도, 제품 generation 보호를 사용한다. 수동 실행의 범위는 independent-workers-runbook의 run-job 절차와 같으며, 별도 상시 evidence-worker나 새 역할 leader를 만들지 않았다. 시작·종료는 operations_audit에 jr/token 및 고정 runId로 기록한다.

추가 배치는 2026-10-14 00:24:32.733 KST에 `time_limit`으로 실제 자동 종료됐다. 완료65회, job 실패0회, `process_alive=false`, `finished=true`를 확인했다. 이후 기존 정기 갱신의 00:28:12 KST 성공을 확인했다.

## 실제 진행 확인

2026-10-13 23:29:15 KST에 다음 결과를 확인했다.

| 항목 | 실측 |
| --- | ---: |
| 추가 배치 완료 회차 | 4 |
| 추가 배치의 정상 완료 제품 합계 | 85 |
| 추가 배치의 factsChanged 합계 | 85 |
| 추가 배치의 업데이트 이벤트 삽입 | 24 |
| 시작 이후 정상 관측/성공한 고유 출처 | 210 |
| 시작 이후 정상 근거가 갱신된 서로 다른 제품 | 107 |
| 사이트 HTTP 실패/후속 재시도 출처 | 3 |
| 현재 공개 제품의 남은 due 출처 | 48,195 |
| 위 출처의 서로 다른 제품 | 24,632 |
| 현재 공개 출처의 최대 지연 | 57시간 |
| 활성 GitHub quota cooldown | 0 |

최종 23:32:16 KST 재조회에서는 정상 갱신 출처340개/서로 다른 제품173개, 실패 기록 source5개였다. 추가 배치는8회 완료/정상 완료 제품합계165/factsChanged165/events85/제품 실패1회이며 계속 살아 있다. job 자체의 last_error는 없고 현재 임대 중이며 cursor는 officialskillssh로 전진했다. 이 수치는 앞 표의23:29시점 이후 측정이다.

추가 배치 완료 제품 합계와 DB의 고유 출처/제품 집계는 기준이 다르다. DB 집계는 추가 배치 시작 뒤 같은 기간의 기존 실행도 포함한다. 전체 적체가 소진됐다고 해석하지 않는다. 추가 배치 process_alive=true/finished=false, 실제 DB cursor 이동·저장 시각 갱신을 확인했다. public /api/health HTTP200이다. product-intro-check는 not_before2100-01-01/runs741/미임대로 기존 중단을 유지한다.

## 보관·다음 확인

비공개 운영 도구와 숫자 증거는 /private/tmp/nomorevibe-evidence-refresh-20261013(디렉터리0700,파일0600)에 있다. 토큰·DBURL·API키·원시 근거를 공유 문서나 도구 출력에 남기지 않았다.

상태 확인:

```sh
python3 /private/tmp/nomorevibe-evidence-refresh-20261013/status.py
```

종료 시 배치 합계는 시도1,424제품/정상 완료1,354제품/제품 실패5회, factsChanged1,345회/업데이트 이벤트973건이다. 반복 제품은 합계에 포함될 수 있으므로 고유 제품 수로 해석하지 않는다. 종료 증거는 `/private/tmp/nomorevibe-pipeline-audit-20261013/catchup-final-confirmed.json`이다. 종료된 PID35030에 예전 중단 명령을 실행하지 않는다.

전체 초기 적체 해소·장기 처리량은 아직 확인하지 않았다. 비공개 출처가 포함되는 관리자 경고의 집계 범위도 앱 코드에서는 변경하지 않았다. 새로운 테스트·Git 커밋/푸시·배포는 실행하지 않았다. 이 작업의 검증은 실제 운영 DB·배치 로그·감사 로그·서비스 health 조회이다. 10/14 후속 단계별 처리량 측정은 별도 기록한다.
