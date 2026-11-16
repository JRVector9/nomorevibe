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
