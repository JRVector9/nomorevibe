# 기존 카탈로그·독립 크롤러 로컬 복구 — 2026-09-08

## 원인

리디자인을 검증한 `http://127.0.0.1:43201`은 기존 데이터 보호를 위해 별도 시험 DB를 사용했다.
그 DB에는 합성 검증 제품 한 개만 있었으므로 과거 수집 제품이 보이지 않았다. 기존 데이터는 포트 3200의
`nomorevibe` DB에 그대로 남아 있었다.

확인 당시 기존 DB에는 seeded 제품 1,118개, 수집 문서 5,336개, published 후보 1,118개,
needs_review 후보 254개, rejected 후보 3,964개가 있었다. 데이터 손실은 없었다. 다만 기존 HTTP
스케줄러는 웹과 비밀값이 달라 모든 cron 요청에서 403을 받고 있었고 실제 수집은 중단된 상태였다.

## 복구 작업

1. 기존 DB를 custom-format dump로 백업했다.
   - 파일: `/tmp/nomorevibe-before-worker-split-20260908.dump`
   - 크기: 151 MiB
   - SHA-256: `8bbb4e26f75988fb840c019410925af8f75f0e156a0c888520a830fe99f831ce`
2. 기존 웹과 HTTP 스케줄러를 중지하고, 기존 행을 지우지 않는 마이그레이션을 릴리스당 한 번 실행했다.
3. 현재 main 웹과 scheduler, crawler, reviewer, publisher, maintenance를 기존 DB에 연결했다.
4. 시험 DB를 보던 중복 웹·워커 컨테이너는 종료·삭제했다. 비밀값 전달용 임시 파일도 삭제했다.
5. `최신`과 일반 검색이 verified 제품만 조회하던 결함을 회귀 테스트로 재현하고, seeded를 포함한
   공개 카탈로그와 공개 카테고리 개수를 사용하도록 수정했다.

## 실제 동작 확인

- 웹과 역할별 프로세스 5개가 모두 healthy이며 포트 3200 홈과 최신 목록이 HTTP 200을 반환했다.
- 자동 스케줄러 첫 회차가 기한이 된 잡 9개를 요청했고 각 역할의 요청·처리 버전이 일치했다.
- GitHub 검색에서 저장소 2개를 발견하고 두 문서를 모두 수집했다.
- 규칙 판정에서 1개는 `passed`, 1개는 `no_homepage`가 됐다.
- 통과한 `itechmeat/open-second-brain`은 `Dark Factory`로 발행되어 seeded 제품이 1,119개가 됐다.
- 화면은 첫 6개 카드와 더 보기 흐름을 렌더하고 `최신 100개 · 공개 1119개`를 표시했다.
- production-mode 브라우저 검사에서 console/page 오류가 없었다.

후속 코드 검사는 targeted 13개, 전체 unit 610개, Playwright 6개, 비증분 TypeScript, ESLint,
Docker runner 빌드가 통과했다. E2E의 빠른 페이지 전환 중 서버가 기록한 destination stream closed는
브라우저가 이전 응답을 취소한 경로이며 테스트와 사용자 요청은 정상 완료됐다.

## 현재 AI 처리 상태

규칙 기반 `crawl-judge`와 발행은 동작한다. 자동 AI 리뷰는 아직 켜지 않았다. 기존 설정에 저장된
reviewMode가 없어 코드 기본값 `off`가 적용되고, `CRAWL_REVIEW_MODEL`도 지정되지 않았다. 저장소의
CLAUDE.md·AGENTS.md 등을 모으는 agent-evidence 설정도 현재 비활성이다.

발행 중 카테고리 분류가 Claude CLI를 호출했지만 컨테이너 인증이 유효하지 않아 `Not logged in`을
반환했다. 기존 결정적 키워드 폴백으로 발행은 완료됐지만 AI 분류 성공으로 간주하면 안 된다. 장기
Claude 토큰과 명시한 리뷰 모델을 설정하고 실제 표본을 `observe`에서 비교한 뒤에만 `enforce`로
전환한다. agent-evidence를 켤 때는 1,119개 전체를 한 번에 스캔하지 말고 GitHub 쿼터와 backlog를
관측하면서 bounded batch로 진행한다.
