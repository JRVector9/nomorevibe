# 연속 접속 실패 10회 자동 내림

사용자 지시: 응답이 10회 이상 거절된 제품을 자동으로 내리고 이력을 남긴다.
관리자 ‘응답 없음’과 실제 운영 집계에 따라 사이트 uptime의 **연속 실패**를 적용한다.
2026-10-15 09:19 KST 공개 제품 44,017개 중 534개가 해당했고, AI 재검수/생성 품질 거절 10회는 각각 0개였다.
이 해석을 사용자에게 알렸으며 다른 기준으로 답하면 변경한다.

## 동작과 불변 조건

- HTTP 200~399가 한 번 나오면 연속 실패가 초기화된다. 9회에는 유지하고 10회부터 공개 목록에서 내린다.
- 현재 제품 ID/slug/website URL과 최근 6시간의 health를 잠금 아래 다시 확인한다.
- `setStatusWithAudit`로 `banned` 처리하고 같은 트랜잭션에 운영 이력을 남긴다.
  이력에는 자동 처리 주체, 정책/기준 10회, 실제 횟수, 마지막 상태, 실패 시작/확인 시각, URL/제품 ID를 저장한다.
  기존 DB trigger가 같은 트랜잭션에서 CDN purge를 등록한다. hard delete나 가짜 사람 판정은 없다.
- 기존 적체는 정상 uptime job에서 batch/budget 범위만 처리한다. 오래된 결과는 정상 접속 재확인 후 처리한다.
- 성공으로 회복했거나 URL/제품 세대가 바뀌면 차단하지 않는다. 이미 차단된 제품은 이력을 중복 생성하지 않는다.
- URL 변경은 현재 health를 무효화하고 과거 일별 통계는 보존한다. 이전 URL의 늦은 요청은 결과를 저장하지 않는다.
  새 URL은 첫 실패부터 다시 센다. 수동 차단 해제 이후에는 새 접속 확인 결과를 요구한다.
- 기존 health에는 관측 URL이 없어, 실패 시작 이후 제품이 수정됐다면 현재 주소의 연속 실패로 확정하지 않는다.
  다음 정상 관측부터 새 streak로 센다. URL 외 수정도 포함하는 보수적 조건이므로 내림이 늦어질 수 있다.
  10:08 고정 535개 중 519개는 수정 시각이 실패 시작보다 앞서고 16개는 이 조건으로 구별된다.
- 제품 감사는 제품 삭제 경로에서 지워질 수 있으므로 전체 근거 snapshot은 append-only 운영 감사에도 남긴다.
- 현재 동시성, 재확인 6시간, 원본/모델 설정, 신규 발굴 중단, lease/CAS/취소 경계를 유지한다.

## 구현 순서

1. 실제 DB 통합 테스트에서 9→10, 성공 초기화, 기존 10+ 적체, 오래된 결과/URL/세대 변경,
   lease 상실, 중복 처리, 감사·purge 원자성을 검증한다. 구현 전 실패를 직접 실행한다.
2. 작은 도메인 모듈과 uptime job 연결을 구현한다. 순환 import를 피하고 DB 쓰기는 기존 직렬 경로를 따른다.
   제품 상태·두 감사 이력·purge는 한 트랜잭션으로 기록하며 조회와 실행 사이 상태를 다시 검사한다.
3. 관리자 차단 사유/활동 표시를 연결한다. 운영 문서와 handoff에 정책·검증·수치를 남긴다.
4. 독립 코드 검토, 관련 통합 테스트와 전체 필요한 검증을 실제 실행한다.
5. 정상 PR/필수 CI/병합 후 새 main 이미지로 13앱을 배포한다. 기존 c8f0424 운영 설정을 새로 capture한다.
6. 실제 기존 대상의 차단/회복/보류와 이력/purge를 확인한다. 성공한 내림과 진행 중 적체를 구별해서 보고한다.

## 검증 명령

```sh
npx vitest run --config vitest.integration.config.ts tests/integration/uptime-auto-ban.test.ts --silent
npx vitest run --config vitest.integration.config.ts tests/integration/uptime.test.ts --silent
npx tsc --noEmit --pretty false --incremental false
npm run lint
git diff --check
```

각 에이전트는 별도 테스트 DB를 사용한다(root 55448, evidence agent 55449).
운영 DB에 테스트 fixture, 실패 횟수 초기화, lease 강제 변경을 실행하지 않는다.
