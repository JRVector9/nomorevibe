# PR13a 관리자 파이프라인 관측 — 2026-10-16

관리자 status에 stage/batch/source/model/HTTP/uptime 제어값과 장부 집계, 후단 대기, host별 기존 준비조건, 현재 역할 lease를 추가했다. 인증 뒤 Suspense slot에서 조회하며 공개 operationsData 경로·실행 권한·활성화 설정은 변경하지 않는다.

## 조회·표시 경계

control/장부는 primary의 한 SELECT와 DB clock으로 읽는다. 기존 readJobBatchReadiness는 별도 조회하며 두 결과가 모두 정산된 뒤 표시한다. 실패한 구획은 null/미확인으로 두고 빈0이나 준비 완료로 바꾸지 않는다. lease 기한 만료는 외부 호출 종료나 실제 완료 증거가 아니다. 설정 host는 물리 하드웨어 확인과 구분한다.

별도 readiness는 현재 mode/epoch, 검증 정책 hash, 고정 release, instance→host가 일치할 때만 채택한다. A 독립리뷰가 같은 epoch/release에서 다른 instance만 바뀐 정책의 이전 ready:true를 채택하는 P2를 찾았고, 기존 helper의 검증된 hash 반환과 presentation exact 매칭만 추가했다. unknown 정책은 null로 전달한다. runtime 분류·SQL·권한은 변경하지 않았다.

C/R/host 전체 DB 예산 강제/Oracle 실제 실행·DR은 미확인으로 명시한다. 장부의 reserved/dispatched/indeterminate 수를 모델의 실제 제공용량으로 사용하지 않는다. 이 화면은 실행 제어 버튼을 제공하지 않는다.

## 실제 검증

- 원 unit/UI의 구체 RED→같은 GREEN 및 기존 dashboard18 포함 당시32PASS. 최종 신규 unit/UI는 정책 release 회귀를 포함해15PASS였다. 서로 겹치는 실행을 합산하지 않는다.
- 정책 hash P2의 같은 신규case1AssertionRED(이전 ready:true) → 최소3파일 보강 뒤 관련 unit/UI **16PASS/292ms**. 기존12개 it 전체 call text 및 두 source tagged SQL literal 각각1개 exact.
- 변경6파일 scoped tsc/eslint0, hash 보강3파일의 scoped tsc/eslint도0. whole tsc는 앞선1회 기존 미생성 PageProps6진단이며 typegen/whole 반복은 하지 않았다.
- 전용55538 실제 SQL **1PASS/455ms**, shared CI의 기존행 무수정 driver 보강 뒤 같은1 **PASS/488ms**. 이후 release/hash pure mapping·반환 보강은 SQL 불변/해당 unit으로 검증했으며 보강 뒤 actual DB 재실행은 주장하지 않는다.
- root 직접 전체7파일과 최소 보강hunk를 읽었다. A 독립리뷰의 다른 P1/P2는 없었고 인증 전후 page 변경을 base와 대조했다. 관리자 실제 로그인·브라우저/CSS/mobile 검증은 아직 하지 않았다.

실제 SQL test는 관리행·관측·job·ACL·role 전후 raw와 독립 현재 집계가 같음을 확인한다. production 데이터나 grants를 쓰지 않는다. root는 반환55538의 exactcontainer/loopback/image/label/mount/memory를 확인하고 전체89public/9raw행의 baseline·agentfinal·root JSON 정확 일치,83journal/catalog/ACL/default/타연결0을 독립 확인했다. 정상STOP/exited0/OOMfalse 뒤 자기container+volume만 삭제했다. **55538 retired: 재접속·재생성하지 않는다.**

로컬 근거: `/tmp/nomorevibe-pr13-root-independent-readback-proof-20261016.json`, `...pr13-root-control-status-cleanup...json`, `...pr13-a-independent-review...md`, `...pr13-c-policy-hash-final-report...md`와7파일 최종manifest. 원6파일 단계·원SQL의 이전 결과도 별도 보고에 보존한다.

## 정확 명령·남은 작업

```sh
npx vitest run tests/pipeline-control-status.test.ts tests/pipeline-control-status-ui.test.tsx
npx tsc --project /tmp/nomorevibe-pr13-c-policy-hash-scoped-tsconfig-20261016.json
npx eslint lib/operations/job-batch-readiness.ts lib/operations/pipeline-control-status.ts tests/pipeline-control-status.test.ts
```

새 전용DB를 별도 배정한 뒤에만 `TEST_DATABASE_URL="$OWN_TEST_DATABASE_URL" npx vitest run --config vitest.integration.config.ts tests/integration/pipeline-control-status.test.ts`를 사용한다. retired55538은 예시 실행 대상이 아니다.

선행PR453/460/461/462, 실제 관리자 접속·운영 규모 조회 비용/실principal/canary, 고유 최종 완료·처리율은 별도 검증이다. 전체 unit/전체DB/build는 모든 PR 개발 뒤 수행한다. 운영 배포·Oracle 가동이나2배 달성을 주장하지 않는다.
