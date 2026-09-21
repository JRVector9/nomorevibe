# 수집·심사 파이프라인 속도 개선 구현 및 검증

2026-09-21. 기준 코드 `af50608`. **코드와 로컬 검증 완료, 운영 미배포. 운영 단축률은 아직 측정하지 않았다.**

## 구현한 변경

| 단계 | 변경 | 유지하는 계약 |
|---|---|---|
| 규칙→1차 | 후보 저장 트랜잭션에서 다음 작업 요청 | 기존 자동 심사 대상·off/observe/enforce |
| 1차→2차 | 성공 저장 직후 2차 요청 | 동일 원문·독립 모델·기존 입력 해시 |
| 2차→발행 | 실제 ai_approved 승인 의견이 agreed로 저장될 때 요청 | 전체 필수 모델의 승인 관문을 발행에서 재검사 |
| fallback | 대체 표 생성과 2차 실행 요청 원자화 | 기존 모델 목록·횟수·실패 이력 |
| 1차 처리 | 슬롯 완료 후 다음 후보 시작, 최대16후보/40초 | 동시성 설정 유지, gateway24초/CLI20초와 저장 여유2초 |
| 다음 회차 | 실제 처리 진전과 실행 가능한 잔여 큐가 있을 때 continuation | 재시도 대기·요청 버전·다른 잡의 실행 기회 유지 |
| 텍스트 | reason-translate와 crawl-tagline을 전용 text 역할로 이동 | 두 작업은 직렬, 기존 모델·번역55초/소개25초 worker 예산 |
| 텍스트 저장 | 원본·후보·기존 소개·작성자·lease 재검사 | 관리자 문구, 최신 원본, 재시도 상태 보호 |
| 계측 | 모델 호출/재사용/대기/커밋/다음 요청 분리 | 원문·모델 답변·키를 새 로그에 넣지 않음 |

LAYA 운영 호출을 추가하지 않았다. 수집은 기존3개 병렬·README 재사용을 유지했다. 처리량 개선을 이유로 수집 기준이나 모델 판정을 생략하지 않는다.

## 실제 검증

최종 GitHub CI: **검증 코드 `5df9bce`, 단위141파일/1,091개·통합79파일/767개 전부 통과**, 타입·lint·Next build도 통과. 6개 구현 PR CI 모두 성공: [#161 CI](https://github.com/JRVector9/nomorevibe/actions/runs/35565100321), [#162 CI](https://github.com/JRVector9/nomorevibe/actions/runs/35565095414), [#163 CI](https://github.com/JRVector9/nomorevibe/actions/runs/35565087150), [#164 CI](https://github.com/JRVector9/nomorevibe/actions/runs/35565091983), [#165 CI](https://github.com/JRVector9/nomorevibe/actions/runs/35565212113), [#166 CI](https://github.com/JRVector9/nomorevibe/actions/runs/35565195009). 이후 변경은 이 검증 기록 문서뿐이다. 아래는 로컬 검증 및 수정 경과다.

- 최종 단위 전체140파일1,090개 통과(14:27 KST). 종료 중 claim/성공 응답 경계도 포함한다. 이후 실제 오프라인 CLI 실행 회귀1개를 추가해 관련5개 통과(고유 단위1,091개).
- 통합 전체79파일767개 중766개 통과, 옛 batch 요청 횟수 기대1개 실패. 결과별 원자적 요청 기대값으로 수정한 해당 파일17개 재실행 통과. 다른 실패 없음.
- 고정 시계 실험: 응답10초×8건, 동시성4 → 0초에4건, 10초에4건 시작,20초 완료. peak4. 응답24초 뒤 추가 호출0. **실제 서비스의 처리시간 측정은 아니다.**
- `af50608` detached worktree에서 생성한10개 fixture의 전체 ReviewInput/해시/규칙 결과가 동일. 499/500/501별·문서·설문·설문 작성 도구·플러그인·스킬·튜토리얼·자료 목록·웹 입력을 포함한다.
- 실제 PostgreSQL에서 결과와 신호의 rollback, 중복 완료 전달, 입력/정책/승인 관문, lease 교체, 관리자 결정 보호를 검증했다.
- 자동 저장이 소개 행 부재를 조회한 뒤 DB trigger/advisory barrier로 멈추고 별도 세션에서 수동 insert: 관리자 문구 보존, 자동 결과/release/발행 신호0.
- text가 대기해도 publisher가 먼저 작업 시작, text 내부 두 잡은 직렬임을 테스트했다.
- 타입 검사와 Git 추적+신규 소스 ESLint 통과(기존 vendor 미사용 인자 경고1개). Next production build 통과. Compose config --quiet 통과.
- worker Docker target 빌드 통과. 로컬 테스트 DB 연결 text/publisher 컨테이너 모두 healthy·restart0, 실제 로그에서 각 소유 작업만 실행. 수집 disabled/API키 미주입이므로 실제 모델 성능 시험으로 보지 않는다.
- 최종 리뷰에서 claim 도중 shutdown과 성공 응답 직후 shutdown을 추가 차단했다. 새로운 승인을 만들지 않으며 1차 claim은 취소 실패로 정리하고 2차는 pending으로 남긴다.

실패/수정 기록: 신규 기능의 RED를 확인한 뒤 구현했다. 소개 upsert의 raw Date 파라미터 오류는 ISO timestamp 및 밀리초 비교로 수정했다. 첫 fixture 출력 디렉터리 누락을 바로잡았다. 마지막 실제 CLI 실행에서 CJS top-level await 오류를 재현하고 async main 진입점으로 수정, 실행 회귀 테스트를 통과했다. 컨테이너 최초 종료 실험은 Compose의 init:true를 빠뜨려 esbuild 자식 회수가 완료되지 않았고 exit1이었다. Compose와 동일한 --init 재시험에서 text/publisher 모두 healthy·restart0, SIGTERM 후 worker failures0·supervisor exit0·컨테이너 exit0을 확인했다(14:28 KST). worker 이미지의 기존 lockfile 설치에서 npm audit high1/critical1을 알렸으며 이 변경에서 의존성을 변경하지 않았다.

## 재현 명령

아래 테스트는 전용 loopback `nomorevibe_test`만 허용한다. 운영 env를 로드하지 않는다.

```sh
npm test
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test npm run test:integration
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test node --import tsx scripts/verify-review-pipeline-speed.ts --mode=fixtures
npx tsc --noEmit
npm run build
node --import tsx scripts/report-review-latency.ts /absolute/path/to/worker.jsonl
```

로그 보고는 오프라인이다. 모델 시간은 provider adapter(응답 파싱 포함)의 단조 시계 시간이며 준비/DB 저장 시간은 제외한다. 1차 커밋→2차 호출 시작은 firstAttemptId로 연결한다. 큐 시각은 DB, 이벤트는 application UTC라 host skew가 있을 수 있다. 음수/누락은0으로 채우지 않는다. 모델별 부하와 신규 수집/재심사·큐 깊이는 별도 운영 표본으로 구분해야 한다.

## 운영 적용 순서와 남은 검증

1. 6개 PR을 순서대로 검토한다. DB 마이그레이션은 없다.
2. 계측을 먼저 배포하고 새 심사100건 및30분 이상 기준선을 확보한다. 정책/모델/원문이 같은 집단으로 비교한다.
3. 다음 단계 신호와 슬롯 재사용을 순차 적용한다. 2차 대기 p95·시간당 처리 건수·timeout/429를 함께 본다.
4. 텍스트 저장 보호 이후 구형 publisher를 drain/중지하고 새 publisher를 교체한다. 소유 작업이 crawl-publish 하나인지 확인한다.
5. 새 text 앱을 별도 컨테이너로 시작한다. `npm run worker:supervised -- --role=text`, worker target, pool3, hard timeout180초, 별도 SERVICE_INSTANCE_ID, 승인된 ABCLLM 키를 비밀 저장소에서 주입한다. Compose와 동일하게 init을 사용한다.
6. 실제 host CPU/RAM/DB 여유, text health, backlog 감소와 publisher 텍스트 실행0을 확인한다. 기본 연결 상한은 웹1개+connect-agent 포함27, 웹2개 각8이면35, 각6이면31이다.
7. 각 단계마다 새 심사100건/30분 이상 관측한다. 오류율+2%p 또는2차 대기 p95+20%면 원인을 확인하고 슬롯 재사용을 우선 되돌린다. 중복 발행·승인 우회·관리자 덮어쓰기는 진행 중단 조건이다.

롤백은 text 중지→이전 publisher 복구→필요한 코드 역순으로 진행한다. 결과/잡 요청 행을 지우거나 일괄 재심사를 강제로 실행하지 않는다. 현재 운영 배포·Dokploy 앱 추가·운영100건 전후 비교는 미실시다.
