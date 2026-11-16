# 제품 API 원래 주소 제거·verify 조건부 공개

- PR: [#975](https://github.com/JRVector9/nomorevibe/pull/975)
- base: main `2296c2c5`, branch: `feat/product-api-url-verify-20261116`
- 병합·배포 금지. 운영 env·관문·Cloudflare 및 다른 PR은 변경하지 않는다.

## 남은 일

- [x] 최신 main 확인, 격리 브랜치·빈 시작 커밋·push·Draft PR 확인.
- [x] GET의 url 제거, verify를 주인 없음+주소 일치 때만 공개, 그 외 claimable/message 유지.
- [x] 스킬·운영 문서와 관련 응답 기대값 갱신.
- [x] 범위 unit 154/154 및 전용 Postgres 통합 27/27 통과(아래 실패·재검증 기록 참조).
- [x] Next typegen 후 tsc 및 변경 TS ESLint 통과. fixture 보강 후 같은 검사도 재통과.
- [x] 구현 커밋 `00c1848d`·작업 브랜치 push·PR 본문 실제 결과 반영.
- [x] 사람 지시에 따른 ready 전환 확인.

코드 작업의 남은 항목은 없다. 외부 검증(CI)과 최종 보고는 이 파일을 커밋한 뒤의 head를 대상으로 계속한다. 최신 상태와 실패·차단 여부는 [PR #975 본문과 검사](https://github.com/JRVector9/nomorevibe/pull/975/checks), 보고함 → 개발사항의 PR #975 최종 보고에 기록한다. 이 문서는 로컬 통과를 CI 통과로 대신하지 않는다.

## 결정·측정

- 안내 필드는 기존 제품 API 성공 응답과 같은 `message`를 선택했다. 오류로 오해시키지 않으면서 짧은 재확인 안내를 담는다.
- 공유 node_modules 링크는 aws4fetch 누락으로 최초 시험 수집이 실패(시험 0개)했다. 공유 폴더를 건드리지 않고 링크를 해제하고 잠금 파일 기준 npm ci를 실행했다.
- 새 응답 계약을 이전 구현에 적용한 baseline: `npx vitest run tests/skill-agent-access.test.ts tests/anti-scrape-api.test.ts` — 64/91 통과, 27 실패. 수정 후 같은 명령으로 비교한다.
- 전용 컨테이너 `nmv-product-privacy-49f7bbae`, localhost 동적 포트 32802, DB nomorevibe_test. 다른 세션의 55435 DB는 사용하지 않는다.
- DB migration 0개. 화면 변경 없음: 앱 클릭·스크린샷 검수 대상 없음. POST 생성/verify·PATCH·DELETE·상세·카드·readme·관문 구현은 변경하지 않는다.

## 실제 검사 기록

- 핵심 응답 계약: 같은 명령으로 **64/91 → 91/91 통과**. 기존 코드 27실패는 응답 노출·새 필드 계약에서 발생했다.
- `npx vitest run tests/skill-agent-access.test.ts tests/skill-contract.test.ts tests/anti-scrape-api tests/dr-web-fence.test.ts --maxWorkers=3`: 7파일 148/154 통과. DR fence 6실패(시간 초과 및 연쇄 실패), 나머지 6파일 140/140 통과.
- DR 단독 `--maxWorkers=1`: 10/14 통과, 같은 시간 초과 계열 4실패 보존.
- `npx vitest run tests/dr-web-fence.test.ts --maxWorkers=1 --testTimeout=30000`: 14/14 통과(4.40초). 제품·DR 코드를 바꾸지 않고 CLI 시간 상한만 넓혔다. 기본 5초 상한의 앞선 실패를 숨기지 않는다.
- 전용 DB 통합: `TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:32802/nomorevibe_test npm run test:integration -- tests/integration/public-product-api.test.ts tests/integration/anti-scrape-api-limits.test.ts`: 2파일 27/27 통과. 실제 DB에서 enforce·세션 없음과 주소 없음/일치/불일치/주인 있음·no-store 확인.
- `npx next typegen` 성공 후 `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p .` 성공. 변경 TS 4파일 `npx eslint` 성공.
- 전체 unit·전체 DB·종합 시험은 PR별 검증 정책에 따라 수동 실행하지 않았다.

- 설정 원복 fixture 보강 후 같은 전용 DB 통합 재실행 **27/27 통과**(8.22초), typegen→tsc→변경 TS ESLint 재통과.

- 작업 전용 DB 컨테이너는 최종 검사 뒤 stop·rm 완료. 공유 DB·다른 세션 컨테이너 변경 없음.
- Draft synchronize 실행 `43783148148`은 저장소 정책상 scope 생략·check 실패다. Ready 전환 완료 후 이 기록 커밋의 새 head로 정상 CI를 관측한다. 과거 Draft 실패를 코드 결함이나 최종 성공으로 해석하지 않는다.
