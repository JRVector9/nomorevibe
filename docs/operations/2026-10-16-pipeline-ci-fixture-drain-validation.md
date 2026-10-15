# Certified wall fixture timeout 정산 검증

[실행 계약](../superpowers/plans/2026-10-16-pipeline-ci-fixture-drain.md). 변경은 기존 통합 테스트 1개와 문서다. production, 권한, 모델, TTL, 심사 기준과 timeout 기본값을 바꾸지 않았다.

## 문제와 수정

PR444 main CI38799565167은 두 실행 모두 healthy 사례가 20초를 넘긴 뒤에도 원 exercise가 계속되었다. hooks가 먼저 raw 상태를 복원하면서 활성 immutable guard의 42501과 후속 147개 실패가 발생했다. 원로그 `/tmp/nomorevibe-pr04c1b-main-ci-{failed,attempt2-failed}-20261016.log`, 읽기 진단 `/tmp/nomorevibe-pr04c1b-ci-timeout-diagnosis-20261016.md`. 최초 20초 지연이 어느 await에서 발생했는지는 아직 미확정이다.

최종 파일 SHA `0524db7e533d9bc2a8e499e93caf578a6e0879f1ee6d0566c67e5183adcaf187`. 원 exercise Promise를 즉시 추적하고 hooks에서 실제 allSettled를 기다린다. writer/holder와 정상 profile release가 끝난 뒤 원본을 복원한다. profile이 미해제면 raw 복원을 차단하고 원 오류와 cleanup 오류를 AggregateError/cause에 보존한다. 단계별 시간 기록은 정해진 이름과 횟수로 제한한다.

처음 cleanup 오류 보존을 추가했을 때 같은 두 사례가 `replay_run_state_mismatch`로 실패했다. 기존 drain은 closeAdmission의 별칭이라 이미 sealed인 run에서 중복 호출하면 거절했고, 기존 catch가 그 오류를 숨겼다. 본문의 closeAdmission이 성공한 경우만 기록해 finally의 중복 호출을 생략했다. 아직 닫히지 않은 run은 drain하고 실제 실패는 보존한다. 이 중간 패치 실패는 CI 지연의 재현으로 세지 않는다. 원로그 `/tmp/nomorevibe-pr04c-ci-fixture-drain-two-cases-20261016.log`.

## 실행한 검증

- 기존 두 사례: **2 PASS / 4.99초 / exit 0**. `/tmp/nomorevibe-pr04c-ci-fixture-drain-two-cases-green-20261016.log`.
- 단계 시간 출력 확인: **2 PASS / 5.28초 / exit 0**. `/tmp/nomorevibe-pr04c-ci-fixture-drain-phase-green-20261016.log`.
- 일회성 CLI `--testTimeout=1000 --silent=false`: **예상 test timeout 2개 / 4.96초 / exit 1**, hook·42501·늦은 cleanup 실패는 0. healthy는 profile 설치 141ms 후 작업 중 timeout, release 1701ms까지 hook이 700ms를 추가 대기했다. expired는 설치 126ms, release 2279ms까지 1280ms를 추가 대기했다. 두 경우 모두 unreleasedProfiles=0 뒤 raw 복원이 끝났다. `/tmp/nomorevibe-pr04c-ci-fixture-drain-forced-timeout-20261016.log`. 이것은 cleanup 감도 검증이며 원 CI의 20초 지연 재현이 아니다. tracked 기본값은 20초다.
- root `npx next typegen` exit0 뒤 B의 whole `npx tsc --noEmit --incremental false`, 파일 eslint, diff check는 실제 exit0. `/tmp/nomorevibe-pr04c-ci-fixture-drain-{final-tsc,final-lint}-20261016.log`. 앞 PageProps 생성 누락은 typegen 전에 발생한 별도 실패로 구분한다.
- 원 두 사례의 핵심 assertions, 같은 writer TX의 750ms anchor, 정확한 timestamp RETURNING, 90초 lease, 기존 holder/writer 정산은 유지했다. root가 전체 diff를 직접 읽었고 A 읽기 교차리뷰의 추가 P1/P2는 0이다.

강제 timeout 뒤 whole raw µs 복원 assertions가 통과했다. 전용 55513의 candidate/document/attempt/vote/item/job/settings/observation은 모두 0, stage 3개는 원래 legacy/epoch1/contract0와 원 updated_at이다. profile role/schema/guard/다른 연결은 0이고 PUBLIC DB CONNECT/TEMP·schema USAGE와 owner role config NULL을 확인했다. `/tmp/nomorevibe-pr04c-ci-fixture-drain-forced-final-readback-20261016.log`. B는 전용 container의 STOP/exited0/OOMfalse를 반환했다. root는 raw readback과 원 timeout 로그를 직접 확인했다.

## 검증 경계와 남은 확인

로컬 정상 PASS만으로 최초 CI 지연 원인을 확정하지 않는다. 강제 timeout은 수정한 fixture의 정산 순서에 대한 증거다. 실제 CI 전체와 main image 확인은 PR 제출 뒤 기록한다. 운영 배포·DDL·provider inference·새 consumer 활성화는 수행하지 않았다.

PR445 main e11fa51c의 CI38802089410에서도 quality·통합1/2는 SUCCESS, 통합3은 동일 healthy20초timeout→32files147FAIL/626PASS·17skip·TODO1로 끝났다. root는 `/tmp/nomorevibe-pr04c2-main-ci-failed-20261016.log`에서 timeout과 immutable 잔류 경로를 직접 확인했다. checkFAIL/imageSKIP이며 해당 실행을 성공으로 기록하지 않는다.
