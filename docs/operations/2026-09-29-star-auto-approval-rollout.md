# 500스타 자동 승인 운영 기록 — 2026-09-29

## 배포

PR [#231](https://github.com/JRVector9/nomorevibe/pull/231)의 `check`와 GitGuardian이
통과한 뒤 06:30:28 UTC main 커밋 `e232f16a79e7db8e3b9abdfc79aadf717041795f`로
병합했다. publisher·reviewer·crawler의 mini 예비를 먼저, M3 주를 다음에, 웹 mini·M3를
마지막에 배포했다. 대상 8개 Dokploy 앱의 최신 deployment 상태는 모두 `done`이고
release와 deployment 설명이 위 커밋과 일치한다. 첫 앱 완료 06:31:56 UTC부터
마지막 웹 완료 06:36:03 UTC까지 4분 7초였다. DB 스키마·서버·스트리밍 설정은
변경하지 않았다. scheduler·text·maintenance는 이번 코드의 실행 대상이 아니어서
기존 release를 유지했다.

공개 `/api/health`는 `status:ok`, `db:ok`, 웹 release가 위 커밋이었다.
06:36:58 UTC `scripts/check-failover-readiness.ts` 종료 코드 0은 다섯 워커 역할의
주·예비 준비, scheduler 2복제본, 진행 상태 모두 `ok`였다. 06:38:32 UTC 재확인도
동일한 `ok`였다.

## 기존 후보 재처리

배포 전 읽기 전용 계획은 92건(거부 59·보류 33, 스타 517–116,862)이었다.
배포 중 1건이 새 코드로 자연 발행돼 배포 후 계획은 91건(거부 59·보류 32)이었다.
두 계획의 DB 식별값은 같았다. 91건의 저장된 GitHub 숫자 ID 별칭·동일 ID 기발행
제품·ID 누락은 모두 0건이었다. 배포 후 계획을 `scripts/reconsider-star-auto.ts`로
적용해 89건을 `new`와 원본 재수집 대기로 바꿨다. 2건은 계획 작성 후 상태/원본이
바뀌어 안전 검사에서 건너뛰었다. 새 계획을 다시 작성해 두 건만 재적용했지만,
둘 다 기존 `products.url`과 후보의 `product_url`이 같아 중복 방지 조건에서
의도대로 건너뛴 것을 읽기 전용 조회로 확인했다. 오래된 GitHub 원본으로 즉시
발행시키지 않았다.

06:38:32 UTC 재처리 중에는 19건이 새 원본으로 갱신됐고 71건이 수집 대기였다.
06:46 UTC 최종 읽기 전용 대조에서는 처음 92건 중 **88건 발행**, **3건 거부**,
**1건 `new`**였다. 발행 88건에 대한 저장된 GitHub ID별 기발행 제품 중복은 0건이다.
`VoltAgent/awesome-design-md`는 새 원본 118,660스타로 발행돼 10만 이상 경로도
확인했다. 거부 2건은 위 기존 제품 URL 중복이다. 나머지 `huggingface/ml-intern`은
새 GitHub 원본 10,816스타이지만 `archived=true`라 자동 승인 대상이 아니었다.
`taekchef/claude-code-zh-cn`은 재수집 요청 뒤 GitHub `not_found`로 frontier가
`skipped`됐고, 공개 저장소 URL도 HTTP 404였다. 이전 원본은 2026-09-18자로
신선하지 않아 발행되지 않았다. 이 1건의 후보 상태 `new`는 장기 관측 항목으로 남긴다.

## 검증과 배포 시간

구현 검증은 단위 160파일·1,274건, 통합 100파일·946건 통과/기존 TODO 1건,
Next typegen·TypeScript·lint·빌드 종료 코드 0이었다. lint의 기존 vendor 경고 1건과
빌드의 기존 동적 파일 추적 경고 1건이 있었다. PR의 `check`는 06:23:10–06:29:37 UTC
**6분 27초**였고, main push의 `check`는 06:30:34–06:35:37 UTC **5분 3초**였다.
main 검사에서 통합 테스트만 06:31:46–06:35:10 UTC **3분 24초**로 가장 길었다.
main CI는 배포와 병행해 완료됐으며 성공했다. 현 방식은 8개 앱이 Git 소스에서
각자 Docker 빌드를 한다. 단기에는 PR 통과 후 main CI를 기다리는 중복 대기를
없애고, 장기에는 동일 커밋의 worker 이미지 1개와 web 이미지 1개를 한 번씩 빌드해
각 앱에 같은 digest를 배포하는 구성이 효과가 크다. 배포 순서(예비→주)는
역할 장애 대비를 위해 유지한다.

## 추가 관측

24시간 동안 새 후보의 신선 원본·중복 ID·발행 오류와 보관/404 사유를 확인한다.
스타 기준 변경이나 GitHub 원본 소실 후 발행 재검증은 자동화 시험으로 확인했으나,
운영에서 자연 발생하는 장기 장애는 이 짧은 배포 관측으로 보장하지 않는다.
