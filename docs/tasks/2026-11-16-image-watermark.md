# 그림 워터마크 — PR #976

- 작업: `feat/image-watermark-20261116`, base `1791d70d` (`origin/main`). 등록 checkout은 보존한다.
- 완료: 응답 시에만 `nomorevibe.com` 합성, 저장 원본/해시 보존. OG JPEG·WebP와 메이커 web·thumbnail 대상.
- 완료: 실제 출력 폭 200px 미만 또는 높이 64px 미만, `github_avatar`·`site_icon`·`default` 제외.
  홈은 320/640px(`components/cards/views.tsx`), 상세 표지는 1200px(`PreviewFigure.tsx`), 아이콘은 64/96/192px(`ProductIcon.tsx`).
- 완료: Noto Sans KR 400 WOFF를 `next/og`로 경로화하고 작은 투명 PNG를 Sharp로 합성. 시스템 글꼴·네트워크 불필요.
- 완료: 메모리 `preview-v2` → `preview-v3`, 아이콘 여부별 캐시 분리. 외부 응답 URL에 `wm=1`을 더한다.
  `protectedCoverUrl`은 JPEG 주소와 WebP srcset에 버전을 전하고, 메이커 상세 데이터의 web/thumbnail 주소도 버전을 전한다.
- 캐시 전환: 새 API 응답의 `wm=1` 주소는 Cloudflare 하루(`s-maxage=86400`) 및 브라우저의 옛 사본과 구분된다.
  롤링 배포 중에는 옛 인스턴스/API가 옛 주소를 내줄 수 있다. 두 웹 교체 및 기존 HTML/RSC 갱신 뒤 새 주소를 확인한다.
  기존 주소도 즉시 바꿔야 하면 운영자가 별도 승인된 절차로 `og-<slug>` 태그를 purge한다. 이 PR에서는 purge/배포하지 않는다.
  메이커의 옛 immutable 주소는 이미 받은 브라우저에서 남을 수 있으므로 새 `wm=1` 주소를 사용한다.
- 마이그레이션: 0개. 저장소·스키마·운영 설정 변경 없음.
- 완료: 범위 vitest 9파일/124개, `tests/image-watermark.test.ts` 19개 포함. DB 55435의 상세 조회 통합 11개 통과.
- 완료: `(npx next typegen || true) && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p .`, 변경 파일 ESLint 통과.
- 완료: main/브랜치 홈·밝은/어두운 표지 상세·메이커 상세·이미지 확대 화면을 Playwright로 캡처하고 직접 검수했다.
  작은 표시가 오른쪽 아래에 있고 잘림·본문 가림 없음. 밝은 그림 가독성을 위해 옅은 어두운 테두리/그림자를 보강했다.
- 실측: Sharp로 전후 화면 같은 영역의 RGB 채널 최대 차 >16인 픽셀 수를 셌다. 왼쪽 위 180×90은 모두 0→0.
  오른쪽 아래 120×60은 홈 0→251, 밝은 상세 0→231, 어두운 상세 0→227, 메이커 상세 0→218.
  전용 시각 품질 점수 도구는 없어 점수를 추정하지 않는다. 명령: `node <artifacts>/measure-watermark.mjs <artifacts>`.
- 검증 영수증/전후 스크린숏/측정 스크립트는 개발 보고에 첨부한다(공개 저장소에 화면 결과물을 올리지 않음).
- 커밋·scope·ready·CI 최종 상태: [PR #976](https://github.com/JRVector9/nomorevibe/pull/976),
  [현재 head checks](https://github.com/JRVector9/nomorevibe/pull/976/checks)와 완료 개발 보고가 영수증이다.
- 이 구역 구현의 남은 코드 작업 없음. 운영 적용은 승인된 후속 병합/배포 단계에서 진행한다.
- 제한: 병합·배포·운영 Cloudflare 변경은 범위 밖. rate-limit.ts/proxy.ts/anti-scrape.ts와 다른 PR은 변경하지 않는다.

- CI 첫 ready 실행: unit (2)의 기존 카드 API 주소 기대값 1건이 `wm=1`을 반영하지 않아 실패. `product-cards-slugs.test.ts`를 갱신하고 카드 API 5개·워터마크 19개(2파일 24개) 회귀, typegen/tsc, 해당 파일 ESLint가 모두 통과했다. 응답 코드/화면은 변경하지 않았다. 새 head CI 결과는 위 PR checks 영수증을 따른다.

## PR #976 후속 수정 — 요청 thumbnail 우회 차단

- 완료: 아이콘 제외 여부와 JPEG/WebP 메모리 사본의 `icon`/`cover` 열쇠는 저장된 제품 `og_image`의 `thumbnail`만 따른다.
  요청 `thumbnail`은 완전히 무시한다. 저장값 일치 검사를 추가하는 것보다 분기가 적고, 요청 조작으로 제외·캐시 분리를 만들 수 없다.
- 완료: 출력 폭 200px 미만 규칙은 그대로 유지한다. 저장된 아바타·사이트 아이콘·기본 이미지는 요청에 종류가 없어도 제외한다.
- 완료: JPEG 1200px와 WebP 640px에서 세 종류의 요청 우회, 연속 캐시 요청, 저장 종류 변경, 64/96/192px 아이콘 회귀 시험을 추가했다.
  공유 카드의 `nomorevibe.com/p/<slug>` 문구 시험은 유지했다.
- 의도된 현재 동작: `/api/media`는 서버 메모리 캐시 없이 요청마다 워터마크 대상만 재인코딩하며, 움직이는 WebP는 첫 장면만 합성한다.
- 실측: 같은 확장 시험을 이전 머리 `126e97c2`의 route에 적용하면 21/35 통과·14실패 → 수정 후 35/35 통과·0실패.
  명령: `npx vitest run tests/image-watermark.test.ts --reporter=json --outputFile=<영수증 경로>`.
- 완료: 워터마크 35개와 보호 표지 주소 12개, `npx next typegen` → `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p .`,
  `npx eslint 'app/api/og-cache/[slug]/route.ts' tests/image-watermark.test.ts`, `git diff --check` 통과.
- 커밋·push·새 head CI의 최종 상태는 위 PR checks 및 후속 완료 보고를 영수증으로 삼는다. 남은 구현 작업 없음.
- 최초 로컬 실행은 공유 `node_modules`의 `aws4fetch` 누락으로 시험 수집 전에 실패했다. 등록 checkout을 수정하지 않고 격리 폴더에 `npm ci --no-audit --no-fund --ignore-scripts`로 설치한다.
- 마이그레이션 0개. 화면·창 변경 없음. 병합·배포·운영 설정·Cloudflare 및 PR #977/#952 변경 금지 범위 유지.
