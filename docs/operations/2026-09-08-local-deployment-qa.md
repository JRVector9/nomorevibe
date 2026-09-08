# 로컬 배포·최종 QA 보고 — 2026-09-08

`feat/independent-workers`의 최종 소스로 production target 이미지를 빌드하고, 기존 개발 서비스와
분리된 PostgreSQL 데이터베이스에 웹과 역할별 워커를 실제 컨테이너로 배포했다. 외부 GitHub 수집과
Claude 호출은 비활성화하고 합성 제품·심사 후보만 사용했다. 이 검증은 프로덕션 배포나 24시간
외부 수집 관측을 대신하지 않는다.

## 배포 상태

| 역할 | 컨테이너 | 이미지 | 최종 상태 |
|---|---|---|---|
| web | `nomorevibe-workers-local-app` | `nomorevibe-web:local-merge-qa` | HTTP 200, restart 0, OOM 0 |
| scheduler | `nomorevibe-workers-local-scheduler` | `nomorevibe-worker:local-merge-qa` | healthy, restart 0, OOM 0 |
| crawler | `nomorevibe-workers-local-crawler` | `nomorevibe-worker:local-merge-qa` | healthy, restart 0, OOM 0 |
| reviewer | `nomorevibe-workers-local-reviewer` | `nomorevibe-worker:local-merge-qa` | healthy, restart 0, OOM 0 |
| publisher | `nomorevibe-workers-local-publisher` | `nomorevibe-worker:local-merge-qa` | healthy, restart 0, OOM 0 |
| maintenance | `nomorevibe-workers-local-maintenance` | `nomorevibe-worker:local-merge-qa` | healthy, restart 0, OOM 0 |

웹은 `http://127.0.0.1:43201`에서 계속 실행한다. 전용 데이터베이스는
`nomorevibe_workers_local_deploy`이며 기존 로컬 서비스와 원본 작업 폴더의 데이터·변경은 건드리지 않았다.
검사 시점 메모리는 web 88.62 MiB, scheduler 77.82 MiB, crawler 111.4 MiB,
reviewer 111 MiB, publisher 107.7 MiB, maintenance 108.5 MiB였다. 짧은 유휴 표본이므로 최대 사용량이나
외부 수집 처리 용량으로 해석하지 않는다.

## 최종 수정 사항

- 자동 승인 또는 재시도 가능한 심사 후보의 원문이 없거나 24시간보다 오래되면 `crawl-fetch`에
  제한적으로 다시 넣는다. 최근 처리 중인 프론티어는 건드리지 않고, terminal cooldown 조건을
  `LIMIT` 전과 conflict update 양쪽에 적용했다.
- 원문 재수집 뒤 제품 URL이 달라졌으면 자동 결정·미발행 후보만 `source_changed/new`로 되돌리고
  `crawl-judge`를 요청한다. 관리자 결정과 이미 발행된 후보는 보존한다.
- scheduler와 각 경로의 DB 잠금 순서를 동일하게 맞추고 lease 상실 시 트랜잭션 전체를 취소한다.
- 상세 페이지의 개발 도구 영역은 메이커 신고 또는 실제로 관측한 agent·skill·지침 파일 근거가
  있을 때만 하나의 `개발 근거` 섹션으로 표시한다. 빈 추정치·미확인 필드는 숨기고 팀 정보는
  객관적 정보 영역에 유지한다.
- 새 repository export를 사용하는 fetch 경로의 백프레셔 테스트 mock을 보완했다.

독립 읽기 전용 리뷰는 stale 복구, URL 변경 재판정, candidate/document/job lease 잠금 순서를 다시
검사했고 main 병합을 막는 correctness/security/concurrency 문제를 찾지 못했다.

## 실행한 검사

| 명령·검사 | 결과 |
|---|---|
| `npm test` | 78개 파일, 592개 통과 |
| `npm run test:integration` | 49개 파일, 445개 통과 |
| 관련 단위 검사 | 2개 파일, 22개 통과; 백프레셔 2개 통과 |
| 관련 DB 검사 | 2개 파일, 16개 통과 |
| `npm run test:e2e` | 5개 통과 |
| `npx next typegen` | 통과 |
| `npx tsc --noEmit --incremental false` | 통과 |
| `npm run lint` | 통과 |
| `git diff --check` | 통과 |
| Docker `worker` / `runner` target build | 둘 다 통과 |
| production-mode 브라우저 QA | 공개·관리자 20개 흐름 통과, console/page/request 오류 0 |

브라우저에서는 홈 검색, 제품 상세 desktop/mobile, launch/install/skill/feed/badge, 제품 이동,
관리자 status/review/evidence/products/ranking, 리뷰 모드 `off → observe → enforce`, 비활성 수집 보호,
관리자 승인, 비동기 제품 근거 갱신 접수를 확인했다. 390 px에서 가로 넘침이 없었다. 최종 상세
캡처는 `/tmp/nomorevibe-local-qa/screenshots/product-desktop.png`와 `product-mobile.png`에 있다.

cron 호환 API는 무인증 `crawl-fetch`를 403으로 거절하고, 실행 대상이 아닌 `heartbeat`를
인증 상태에서도 400으로 거절했다. 인증된 `crawl-fetch`는 202와 요청 버전을 반환했고 crawler가
처리했다. 최종 DB에서 10개 실행 잡의 `requested_version`과 `processed_version`이 모두 같았고
`last_error`는 비어 있었다. 관리자에서 접수한 `local-qa-product` 근거 갱신도 요청 1, 완료 1,
오류 없음으로 끝났다. 최신 여섯 컨테이너의 error/fatal 로그는 0건이었다.

## 검사 중 발견해 바로잡은 사항

첫 전체 단위 검사에서 새 repository 함수가 백프레셔 테스트의 전체 모듈 mock에 없어서 1개가
실패했다. mock을 보완한 뒤 해당 검사와 전체 592개를 다시 실행했다. 통합 검사 뒤 fixture가
정리된 상태에서 예전 임시 seed 파일이 분리된 `crawl-schema`를 참조하지 않아 재배포 QA 데이터가
없었고, 임시 seed import를 현재 구조로 고친 뒤 다시 넣었다. 코드 결함으로 판정한 stale 원문,
URL 변경, 잠금 순서 문제는 위 최종 수정과 통합 테스트로 막았다.

## 운영 전 남은 조건

서버·도메인·운영 PostgreSQL과 비밀 저장소가 아직 확정되지 않았고, publisher용
`CODEX_ACCESS_TOKEN` 또는 `OPENAI_API_KEY`, reviewer용 장기 `CLAUDE_CODE_OAUTH_TOKEN` 및
`CRAWL_REVIEW_MODEL`도 운영 환경에 설정하지 않았다. 따라서 실제
GitHub API·LLM을 켠 24시간 수집/심사/발행 관측은 남아 있다. 운영 전환은
[독립 워커 운영 절차](independent-workers-runbook.md)의 stop/drain, migration 1회, 역할별 시작,
observe 비교, 운영자 enforce 전환 순서를 따른다.
