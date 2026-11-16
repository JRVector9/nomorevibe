# 상세 출처 — PR #979

브랜치: feat/detail-source-line-20261117. 기준 main: 0b7ae636. 병합·배포 금지.

## 사람 결정 변경(2026-11-16 16:3xZ)

"나는 크롤링할때만 저게 떠야한다고 말한거야. 사용자 페이지에선 안보여도 크롤링 해가는 사람들한테만 남도록"
→ 출처는 사람 화면에 0번, 긁어 가는 글자(서버 HTML·API·브라우저 DOM)에만 남긴다. 앞선 '요약 아래 보이는 한 줄'(1515be70) 방식을 대체한다.

## 끝낸 것

- [x] PR #979 Draft 되돌림 확인, 본문 맨 위에 결정 변경 기록
- [x] 서버 HTML: 요약 아래 보이는 출처 `<p … text-fg-2>` 삭제, 요약 문단 안 끝에 `HiddenSource`(`<span class="sr-only" aria-hidden="true"> · 출처…</span>`)
- [x] 소개(API로 받아 그리는 부분): API `intro.text` 끝 출처는 그대로, 화면은 끝 줄을 잘라 버리지 않고 소개 문단 안 같은 `HiddenSource`로 그림
- [x] 숨김은 Tailwind `sr-only` 클래스만. `hidden` 속성·display:none·visibility:hidden·인라인 style 없음, 링크 아님(탭 순서 무관)
- [x] tests/detail-source-line.test.tsx 새 기준(5개 언어 × 소개 있음/없음/요약과 같음 = 15개)
- [x] 관련 상세 시험 9파일 150개, typegen→tsc, 변경 파일 ESLint, check:i18n, git diff --check
- [x] 시험 DB 55435 + next dev, 실제 Chromium: 스크린숏에 출처 없음, textContent·innerText에 있음, 접근성 트리에 없음
- [ ] PR ready·GitHub CI 전체 확인

## 바꾸지 않음

메타 3종 끝 ' · nomorevibe.com', JSON-LD isPartOf·publisher, 워터마크, 공유 카드, DB tagline·description·번역,
상세 API 요약 칸·intro.text, API 보호·한도·관문 설정, #952. 마이그레이션 0개.

## 품질 수치

새 출처 시험: 1515be70 0/15 → 지금 15/15.
잰 명령: `git archive 1515be70`로 scratch에 만든 사본에 새 시험만 복사해 `node node_modules/vitest/vitest.mjs run tests/detail-source-line.test.tsx`(15개 모두 `expected 'p' to be 'span'`로 실패), 작업 브랜치에서 `npx vitest run tests/detail-source-line.test.tsx`(15 통과).

## 실제 화면 확인(시험 DB 55435, next dev 43291, Desktop Chrome UA)

| 제품 | 서버 HTML textContent | DOM textContent | DOM innerText | 보이는 출처 요소 | 접근성 트리 | API intro.text 끝 출처 |
|---|---|---|---|---|---|---|
| 소개 있음 | 1 | 3(숨김 span 2 + RSC 데이터 script 1) | 2 | 0 | 없음 | 유지 |
| 소개 없음 | 1 | 2(숨김 span 1 + RSC 데이터 script 1) | 1 | 0 | 없음 | null(그대로) |

숨김 span 계산값: position absolute, 1×1px, clip-path inset(50%), overflow hidden, visibility visible, aria-hidden true.
1440px·390px 가로 넘침 없음, pageerror 0.

배포 범위: `npm run deploy -- scope --base 0b7ae636 --sha d089c744` → full / 18 apps(`unclassified_runtime_change`). 로컬 scope 결과이며 plan/run은 실행하지 않음.
