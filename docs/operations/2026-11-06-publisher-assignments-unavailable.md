# 발행 `assignments_unavailable` 원인과 수정 — 2026-11-06

사용자 지시 범위는 원인 조사·소스 수정·검증이다. 운영 배포·재시작·설정 변경은 하지 않았다.

## 확인한 현상

- 09:40 UTC 운영 진행 조회: 발행 실행 가능 대기 1,796건, 최근 5분 발행 0건,
  `publish.reason=no_progress`. 당시 실제 발행 소유자는 mini 예비였고 M3 주는 대기 중이었다.
- 10:03 UTC mini 로그에서도 `crawl.classification_deferred`의
  `reason=assignments_unavailable`과 `job.deferred reason=model_capacity`가 반복됐다.
  `model_capacity`라는 상위 미룸 표지만으로 실제 모델 포화라고 판단할 수 없다.
- mini에서 실제 사용하는 Connect RPC의 상태 조회는 Codex·Claude 연결,
  `configReady=true`, `classifyReady=true`, `busy=null`이었다.
  마지막 모델 성공은 11월 5일 기록이다. 이 조회는 현재 모델 호출 성공 증거와 구분한다.
- 두 컨테이너에서 같은 앱 DB 계정으로 SELECT가 성공했고 순위/연결 JOIN은 23건이었다.
  별도 프로세스에서 읽기 전용 초기화를 기다리면 순위 스냅숏도 `loaded=true`가 됐다.

## 원인

모델 실행 설정(`ai_task_execution_configs`)을 동기적으로 읽는
`resolveReviewTaskRanks → readAiTaskExecutionConfig`는 최초 스냅숏을 읽기 전에는
`assignments_unavailable`로 미룬다. 이 보호 동작은 올바르지만, 발행 경로가 필요한 초기화를
빠뜨렸다.

발행의 승인 재검증은 다음 경로로 현재 심사자 정보를 사용한다.

```text
ConnectAgent의 native 분류
  → runPublicationClassificationCall의 dispatch proof
  → lockSources → assertReviewApproval → activeReviewIdentity
  → firstReviewers → resolveReviewTaskRanks → readAiTaskExecutionConfig
```

publisher가 읽은 스냅숏은 별도 프로세스인 ConnectAgent에 전달되지 않는다.
ConnectAgent 경로에는 검증 전에 `ensureReviewTaskRanks()`를 기다리는 단계가 없어,
처음 실행한 프로세스에서 동기 읽기가 매번 실패한다. CLI 실행 전 증명 단계에서 미뤄지므로
재로그인이나 같은 입력 재시도만으로 이 초기화 누락이 해결되지 않는다.

10:06 UTC 실제 배포 소스의 별도 읽기 전용 진단 프로세스에서 초기화 전
`firstReviewers()` 호출이 위 마지막 네 함수의 스택으로 같은 오류를 던지는 것을 재현했다.
실행 설정 초기화를 기다린 뒤에는 해당 오류가 사라졌다. 실행 중 앱 프로세스의 메모리를
변경한 진단이 아니며, 이 진단으로 발행 재개를 주장하지 않는다.

## 수정

- 발행 틱의 큐 처리 전에 `ensureReviewTaskRanks()`를 기다린다.
  기존의 실행 설정 단독 초기화를 순위·계약·실행 설정의 공통 초기화로 대체한다.
- CLI 발행 권한 생성, 원격 Connect의 native 호출, API 분류 소스 확인과 dispatch에서
  같은 초기화를 해당 프로세스가 직접 기다린다. DB 소스/용량 잠금을 잡기 전에 수행한다.
- 기존 30초 캐시·마지막 정상 스냅숏 유지 정책을 재사용한다.
  승인 조건·소유자 검증·용량 제어·CLI 물리 종료 검증을 완화하지 않는다.

## 검증

- 수정 전 신규 회귀 5개 중 3개가 `assignments_unavailable`로 실제 실패했다.
- 최종 신규 회귀 7개 통과: publisher 최초 큐 처리, CLI 권한 생성, API 소스 확인,
  독립 Connect 초기화, 읽기 실패 시 미룸 유지, 30초 뒤 변경 반영, disabled 경로 보존.
- 관련 기존 unit 44개 통과.
- 실제 로컬 전용 테스트 DB의 관련 통합 4파일/94개 통과:
  `publication-classify-capacity`, `review-publication-gate`, `crawl-publish-deferral`, `crawl-publish`.
- 변경 파일 ESLint와 `git diff --check` 통과.
- 최초 `tsc --noEmit --incremental false`는 새 작업 트리의 Next 경로 타입이 아직 생성되지 않아
  `PageProps` 미정의 8건으로 실패했다. 이 실패는 통과로 기록하지 않는다.
  저장소 CI와 같은 선행 단계인 `next typegen` 실행 후,
  `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit --incremental false` 재검사는 EXIT0으로 통과했다.
- 전체 unit·전체 DB·종합 테스트와 빌드는 실행하지 않았다.

운영 적용과 실제 신규 발행 재개 확인은 사용자 배포 이후에 남는다.
배포 시 publisher만이 아니라 Connect도 수정 소스로 교체되어야 하며,
공유 라이브러리 변경의 실제 배포 범위는 기존 단축 배포 절차의 scope/plan으로 확정한다.
CLI 재로그인·슬롯 강제 회수·DB 마이그레이션은 이 수정에 필요하지 않다.
