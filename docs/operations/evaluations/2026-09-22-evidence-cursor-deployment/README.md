# 근거 수집 복구 운영 배포

2026-09-22 01:08 KST 검증. 사용자 “커밋하고 푸시하고 배포해”에 따라 실행했다.

- 소스 커밋: [`d29b7156ac256f7b7f7730899da8c02ab87d2abf`](https://github.com/JRVector9/nomorevibe/commit/d29b7156ac256f7b7f7730899da8c02ab87d2abf), `main` 푸시 완료.
- 이전 운영 릴리스: `8ec1adc90709b813297e6a63686deb8d2fff6626`.
- Dokploy 배포 요청: 2026-09-21 16:04:38 UTC. M3/mini 웹 2개와 M3 워커 7개 모두 새 배포 `done` 확인.
- 9개 컨테이너 모두 위 소스 릴리스, 재시작 0회. 두 웹 내부 `/api/health` HTTP 200·DB 정상(각 2ms). 워커 7개 모두 healthy, 변경 3개+기존 핵심 11개 파일의 SHA256이 각각 **14/14 일치**.
- 외부 홈페이지 및 `/api/health` HTTP 200.

## 검증과 GitHub CI 제한

작업 디렉터리에서 단위 1,094개·통합 784개·타입·변경 파일 lint를 통과했다. GitHub [CI 35622606975](https://github.com/JRVector9/nomorevibe/actions/runs/35622606975)는 계정 결제/사용 한도 때문에 작업이 시작되지 않았다. `steps=[]`이고 실행 로그도 없다. CI가 통과했다고 기록하지 않는다.

대신 **동일 커밋의 깨끗한 detached checkout**, Node 24.18.0에서 CI 명령을 실행했다:

| 검사 | 결과 |
| --- | --- |
| npm ci, Next typegen, TypeScript | 통과 |
| 전체 ESLint | 오류 0, 기존 vendor 미사용 변수 경고 1 |
| 단위 테스트 | 141파일 1,094개 통과 |
| 통합 테스트 | 80파일 784개 통과, 87.46초 |
| 프로덕션 Next 빌드 | 통과 |

통합 테스트는 전용 로컬 DB만 사용했다. 이전 검토에서 기록한 seed/dequeue 간헐 실패는 이번 두 번의 전체 실행에서 재현되지 않았으며, 과거 기록은 보존한다. 이것만으로 그 실패 원인이 규명됐다고 보지는 않는다.

## 실제 복구 확인

수동 운영 SQL 수정이나 재시도 횟수 초기화 없이 새 워커의 자연 실행으로 확인했다.

| 저장소 | 이전 최신 스캔 | 배포 후 최신 스캔 | 결과 |
| --- | ---: | ---: | --- |
| hraness/hra | 39628 | 65733 | cursor 이름 일치, 오류 없음, 관측 근거 4개 기록 |
| hraness/atet | 39627 | 65734 | cursor 이름 일치, 오류 없음, 관측 근거 2개 기록 |
| hraness/message-like-me | 39630 | 65735 | cursor 이름 일치, 오류 없음, 관측 근거 5개 기록 |

세 스캔은 관측 시점에 `partial`로, 시간·요청 예산에 맞춰 다음 수집을 기다린다. **수집 재개 복구이며 전체 근거 수집 완료를 의미하지 않는다.** 이어서 다른 저장소 `akshaydighegithub/emotion`, `alan20111/evalua-facil`의 수집 완료도 확인했다.

모든 새 컨테이너가 시작된 뒤 16:05:39–16:07:59 UTC 약 2분 20초 로그 203개에서 `job.failed=0`, `agent_evidence.failed=0`, 근거 수집 결과 5건을 확인했다. 짧은 배포 직후 관찰이며 장기 무장애 보장은 아니다.

기존 불일치 cursor 전체 행 6개는 이력으로 남아 있다. 최신 스캔 기준 불일치는 확인 시점에 3개로 줄었고, 이번에 반복 실패한 위 세 저장소의 최신 스캔은 모두 일치한다. 나머지 기존 데이터의 전량 정리나 전체 수집 적체 해소는 이번 배포의 완료 조건으로 삼지 않았다.

## 운영 설정·범위

DB 마이그레이션, 운영 데이터 삭제, 수집 한도·모델·심사 정책 변경은 없다. 웹 두 대의 배포 ID와 Server Actions 키 일치도 확인했다. 생존 확인 배치 확대는 아직 제안 상태이며 이번 코드에 포함하지 않았다.

9개 앱의 원래 자동 배포 설정은 모두 `true`다. 검증할 커밋을 고정하려고 배포 및 이 기록의 푸시 동안 `false`로 유지했다. 이 기록 푸시 직후 `/tmp/nmv-cursor-release.py restore`로 원래 값을 복구하고 `status`로 확인하는 것이 마지막 후처리다. 증거 파일의 autoDeploy 값은 이 후처리 전 시점을 나타낸다.

## 증거

- `release.json`: 앱 ID·배포 ID·실행 릴리스·헬스·코드 해시 확인, CI 제한과 대체 검사 결과.
- `db-before.json`, `db-after.json`: 읽기 전용 스냅샷. DB timestamp-without-time-zone은 UTC로 정규화했으며 before 파일에 변환 설명을 남겼다.
- `events.json`: 배포 이후 로그의 허용된 안전 필드만 저장.
- `cursor-release-audit.mjs.txt`: 읽기 전용 DB 점검 소스. 실행은 `TZ=UTC node ...` 사용.

로컬 검증 로그는 `/tmp/nmv-cursor-clean-{install,types,lint,unit,integration,build}.log`, 원래 작업 폴더의 배포 전 검증 로그는 `/tmp/nmv-cursor-release-{unit,integration}.log`에 있다.
