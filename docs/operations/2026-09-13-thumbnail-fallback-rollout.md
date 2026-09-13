# 기존 누락 이미지 보충 및 자동 파이프라인

## 범위와 현재 상태

2026-09-13 09:21:39 KST에 공개 상태(seeded/verified)이면서 og_image와 현재 공개 메이커 미디어가 없는 제품 3,128개를 고정했다. 기존 OG 및 메이커 이미지가 있는 제품은 보충 대상에서 제외했다. 09:56:35 KST DB 재조회에서 3,128개 전부 실제 이미지로 채워졌고, 누락/빈 내부 캐시는 0개였다.

| 출처 | 채워진 수 |
|---|---:|
| 사이트 아이콘 | 2,127 |
| GitHub 소유자 프로필 | 734 |
| 프로젝트 저장소 이미지 | 125 |
| OG 이미지 | 142 |
| nomorevibe 기본 이미지 | 0 |
| 남은 누락 | 0 |

실제 이미지 확보율은 100%다. 12개 사전 조회 후 동일 대상에 먼저 적용했고, 나머지 3,116개를 이어서 적용했다. 영수증 3,128개가 모두 applied이며 DB에서 같은 제품 ID 및 캐시 존재를 재확인했다.

승인된 우선순위: 기존/새로 확보한 OG → 사이트 앱 아이콘·Apple touch icon·고해상도 favicon → 프로젝트 README 로고·배너·화면 → 정확한 GitHub 소유자 프로필 → nomorevibe 이니셜 기본 이미지. 마지막 기본 이미지는 실제 이미지 확보 수와 구분한다.

## 구현

- 수집한 HTML에 manifest/icon 후보를 보관한다. 이미지 후보만 바뀌었을 때는 기존 자동 심사 결정을 초기화하지 않는다.
- 출판·등록 성공 후 product-thumbnail-refresh 잡을 요청한다. maintenance 워커가 처리하고 scheduler가 1분 간격으로 누락 요청을 복구한다.
- OG 이하의 출처는 하루 후 재확인한다. 더 낮은 순위의 결과로 기존 이미지를 덮어쓰지 않는다. 소유자가 올린 현재 미디어와 기존 OG를 우선하며, 조회 이후 제품·URL·저장소·이미지·리스가 바뀌면 저장을 취소한다.
- 외부 이미지는 SSRF 보호, 요청/전체 시간 제한, 바이트·픽셀 제한을 적용해 WebP 내부 사본으로 저장한다. PNG/JPEG/WebP/GIF/AVIF, 안전한 SVG, PNG/DIB 기반 ICO를 처리한다. 외부 참조 SVG와 배지·후원·기술 스택 로고 후보를 제외한다.
- 화면은 출처를 표시한다. 아이콘·프로필·작은/정사각형 저장소 로고를 확대하거나 화면처럼 자르지 않는다. 홈의 가상 UI 그림을 브랜드 기본 표시로 교체했다.

## 검증 및 재리뷰

- 전체 단위: 119파일 905개 통과(최초 구현 시점).
- 전체 통합: 65파일 596개 통과(최초 구현 시점).
- 리뷰 수정 후 관련 단위: 5파일 11개 통과; 통합: 2파일 26개 통과. 이후 기본 이미지→OG 예약 재시도 회귀 테스트를 추가해 관련 통합 5개 재통과.
- 최종 TypeScript 및 변경 파일 ESLint 통과.
- 격리한 체크아웃에서 프로덕션 빌드 및 Playwright 5개 통과. 1440px/390px, 5종 이미지 출처, 작은 아이콘·저장소 로고 크기, 가로 넘침을 검사했다.
- 마지막 가로 로고 변경 후 격리 프로덕션 빌드+Playwright 2개 추가 통과. 첫 fixture SSR 시도는 Playwright JSX 변환 때문에 실패했고, 별도 Node/tsx 렌더링으로 실제 컴포넌트 마크업을 생성해 통과했다.
- 수집/출판 연결 통합 55개, 인코딩 SVG 거부 관련 단위 5개 추가 통과.
- 운영 4종 출처 × 데스크톱/모바일 8개 상세 화면 HTTP200, 이미지 로딩, 출처 표시, 작은 아이콘112px 상한, 가로 넘침 없음 통과. 홈 화면도 확인했으며 브라우저 오류0건. 운영에 기본 이미지가 사용된 제품은0개라 기본 이미지는 로컬 E2E로 검증했다.
- 운영 웹2대와 crawler/publisher/scheduler/maintenance가 모두 `1893b15d9d944fdd8e80211eb9391bc42d5c92ba`로 배포 완료. 두 웹 직접 health에서 app/DB 정상,6개 서비스의 새 릴리스 heartbeat를 확인했다.

| 독립 리뷰 발견 | 등급 | 반영 |
|---|---|---|
| thumbnailHints가 심사 입력 비교에 포함되어 불필요한 재심사 발생 | P1 | 비교에서 이미지 탐색 힌트만 제외; 최초 추가/변경 회귀 테스트 |
| 저장소 로고를 제품 화면처럼 확대·자름 | P2 | 작은/정사각형 이미지 identity 표시; 단위·브라우저 회귀 테스트 |
| preview 및 CAS skipped 영수증이 후속 --apply를 막음 | P2 | applied/preexisting만 완료로 취급; 나머지 재시도 테스트 |
| 가로형 저장소 로고가 작은 카드/아이콘에서 잘림 | P2 | 저장소 이미지 전체에 contain 적용, 원본 크기 상한; 512×128 실제 CSS 브라우저 검증 |

리뷰 도구는 raw confidence 수치를 제공하지 않았다. 지정된 gpt-5.6은 현재 CLI 계정에서 지원되지 않아 기본 Codex 모델로 독립 검토했다. 최종 재검토는 추가 actionable finding 없이 Clean으로 끝났다 (`/tmp/nomorevibe-thumbnail-review-clean.log`). 최초 전체 재검토가 16분간 범위를 넓혀, 동일 세션에서 확인한 근거로 결론을 요청한 뒤 마지막 P2만 고쳐 범위를 한정해 재검토했다.

## 운영 자동 처리 확인

2026-09-13 10:16:16 KST 재확인:

- 전체 공개 제품 6,303개 중 이미지 누락0개.
- 기존 고정 대상3,128개는 그대로 실제 이미지100%, 기본0, 캐시 누락0.
- 배포한 자동 잡이 고정 대상 밖의 신규29개를 추가 보충(사이트 아이콘22, GitHub 프로필7). 수동 보충 CLI로 처리한 수와 구분했다.
- 배포 이후 새로 출판된3개 제품도 이미지 누락0.
- 새 수집 문서6개에서 thumbnailHints 저장 확인. 이미지 잡은5회 성공 실행했고 마지막 성공10:16:05, last_error/locked_at 없음. 발행/수집 잡도 성공 기록 확인.
- 브라우저 검증은 운영 실제4종 이미지×1440/390px8페이지; HTTP200, 내부 이미지 로딩, 출처 표시, native-size 상한, 가로 넘침 없음, pageerror0.

실시간 수집이 계속되므로 이후 새 항목은 발행 직후 짧은 대기 시간을 거쳐 이미지 잡이 보충한다. 위 0개는 명시한 시점의 DB 실측값이다.

## 배포 증빙

| 서비스 | 배포 ID | 상태 |
|---|---|---|
| web-m3 | aR7VFfouHNgV_eSGw2d0y | done |
| web-mini | V4Iv9XH7z1IyXXfBqBPJI | done |
| crawler | DfeHkJVmkoIPpIimhCpqV | done |
| publisher | 69uaHauXzfnMs0ynppRCY | done |
| scheduler | FrpOuVfL3PiEquVaSt_Ai | done |
| maintenance | MorbcjQ3vDctIe2hYqaYq | done |

## 증빙

- `.crawl-samples/thumbnail-cohort-20260913.json`: 고정 대상 3,128개
- `.crawl-samples/thumbnail-preview-20260913.jsonl`: 최초 12개 사전 조회
- `.crawl-samples/thumbnail-apply-20260913.jsonl`: 항목별 적용 영수증
- `.crawl-samples/thumbnail-final-audit.json`: DB의 실제 이미지·캐시·재시도·잡 상태
- `.crawl-samples/thumbnail-fallback-live.json`: 운영 브라우저 검증
- `.crawl-samples/thumbnail-pipeline-proof.json`: 배포 후 수집·발행·자동 보충/서비스 heartbeat
- `.crawl-samples/thumbnail-release-health.json`, `thumbnail-deploy-final.jsonl`: 웹 health/6개 배포
- `/tmp/nomorevibe-thumbnail-review-final.log`: 최종 독립 재검토

원래의 비공개/심사 정책은 변경하지 않았다. 이 작업의 '실제 이미지 확보'에는 아이콘과 GitHub 프로필도 포함되며 모두 제품 스크린샷이라는 의미는 아니다.
