# C 트랙 구현·운영 확인

원문: https://claude.ai/code/artifact/258acc8e-c763-45cc-9aea-62c360b6ac56
화면 시안: https://claude.ai/code/artifact/7ec79b82-e8e6-4350-b4a9-03e864c73023

## 요구사항과 구현

| 원문 항목 | 구현 및 검증 |
|---|---|
| C-1 자동 large_oss 재판정 | 검토 계획/적용/제한적 되돌림 CLI, 수동 결정 보존, DB·설정·행 지문 보호. 사용자 승인 후318건 적용,0건 건너뜀. |
| 10만 이상 제외 | 기존 포함 상한 의미를 유지하며 운영값99999. 네 구간 모두 상한 제외. |
| C-2 스타 저장 | products.stars/stars_at/owner_type, 정렬·갱신 인덱스. 0030의 최신 원본 백필. 실패 재시도용 stars_checked_at 추가. |
| C-2 주기 갱신 | crawler의 product-stars-refresh: 5분마다40건, 동시3건·최대15초,24시간 갱신 기준. 커서·임대·API 제한 재개 시각·실패1시간 보류. 저장소 변경 시 기존 값 초기화 및 진행 중 응답 폐기. 발행 즉시 원본 값 저장. |
| C-3 홈 | 떠오르는/주목받는/인기/대형 네 칸에 각각10개, 전체 보기 링크, 개인 계정 필터. |
| C-3 목록 | /popular, 구간·개인·페이지 URL 유지,15개씩 표, 스타 내림차순과 ID 동점 정렬. 빈 구간 ‘아직 없음’, DB 실패는 오류 메시지. |
| C-3 AI 흔적 | 상세 화면의 공개 링크·표시 설정·관측 freshness/관계 표시 재사용. 상세 근거 anchor 연결. 실행 모델을 추정하지 않음. |
| C-3 화면 제약 | 최소13px, 데스크톱4열/중간2열/모바일1열, 표 영역 가로 스크롤, 방법론2.1 갱신. |
| C-4 조건부 발견 확장 | C-1 및 백필 후 전체 공개 구간78/65/61/45개로 홈10개씩 채워짐. 기존12개 검색 신호와 pagesPerTick2 유지. 추가 발견 확장의 전제인 빈 구간이 없어 이번에는 쿼터를 늘리지 않음. |

시안의 주간 커밋 꾸준함은 원문이 별도로 구분한 B 트랙이다. C 구현에서 근거 없는 점을 만들지 않고 실제 스타 확인일을 보여준다.

## 실제 운영 DB

2026-09-12T16:33:05Z: direct5432에서0030 마이그레이션 성공 후 제품5995건 모두 저장 원본으로 스타 백필.
공개·접속 가능·2천 이상10만 미만 제품은249건:78/65/61/45개. 개인은23/17/9/15개.
단일 개인 구간이9개인 경우 실제9개를 그대로 표시한다. 운영 설정의 기존 심사 observe 모드는 유지한다.

## 검증과 추가 리뷰

- 전체 단위116파일897개 통과.
- 전체 통합64파일587개 통과. 추가 리뷰 후 확장 통합9개도 통과(공개 설정·숨긴 링크·오래된 근거 표시·저장소 변경 후 원복 경합 포함).
- Playwright3개 통과: 홈→전체목록→2페이지→개인필터(페이지 초기화)→새로고침→빈 구간→방법론,1440/390px 글자 크기·넘침·표 스크롤.
- 배포 커밋418d734만 담은 별도 작업 폴더에서 Next 프로덕션 빌드 및 홈·인기 목록·상세 화면 Playwright7개 통과. 기존 상세 시험의 낡은 스타/forks 합친 문구·제목·저장소 없는 제품의 소유자 UI 기대값을 실제 동작에 맞게 정정했다.
- Next 프로덕션 빌드 포함 Playwright 실행 성공. TypeScript/변경 파일 ESLint 통과.
- 실제 발견·수정: 서버 이동 중 체크박스 되돌아감→낙관적 표시, 누락된 근거 anchor, 저장소 변경 후 원복 경합, AI 흔적 요약의 오래됨/관계 미확인 표시.
- 로컬 화면 캡처: /tmp/nomorevibe-popular-home-1440.png, /tmp/nomorevibe-popular-table-390.png. 브라우저 렌더링을 이미지로 직접 확인.

## 배포 및 최종 확인

PR [#109](https://github.com/JRVector9/nomorevibe/pull/109) 병합, 배포 소스 `d7b832be7a7bfccb06183daa6d7ad91c02435c6c`.
실행 코드 식별자 `418d734028990df808068a4a38debc6bd38d301a`를 RELEASE_TAG에, 두 웹의 NEXT_DEPLOYMENT_ID와 build arg에 동일하게 설정했다.
기존 배포에서 남아 있던 오래된 릴리스 식별자를 최종 점검에서 발견해 갱신했다.

| 서비스 | Dokploy 앱 | 완료 UTC |
|---|---|---|
| 웹 M3 | oipo2OAnIrtcnILBCRoG2 | 2026-09-12 16:43:48 |
| 웹 mini | llv4rlABSJOcFauSxaHdx | 2026-09-12 16:43:44 |
| crawler | AFHDBGCCY4zT9XkkcnzGd | 2026-09-12 16:43:59 |
| publisher | AeTaWnZbZKzzv94h7c8Vw | 2026-09-12 16:44:02 |
| scheduler | uAjLU7MslLIGpORD9h6LQ | 2026-09-12 16:44:05 |

- 5개 모두 해당 소스 SHA로 deployment.done 확인. 16:45UTC에 세 워커의 새 release heartbeat도 확인.
- M3/mini 각각 직접 요청한 /api/health: status=ok,db=ok,각 instanceId 및 같은 release. 공개 도메인도 정상.
- product-stars-refresh는16:44:27에 첫 실행,16:44:33 성공. 실제40개 요청·40개 성공 갱신, 오류 없음, afterId52 저장. 스케줄러 요청과 워커 처리 버전1/1 일치.
- 16:44:40UTC 공개 도메인 브라우저 실측 통과: 홈40개/구간78·65·61·45개,네 구간 표15행,구간 경계와 스타 정렬,2페이지,개인 필터와 새로고침 유지,상세 근거 이동,모바일 가로 넘침 없음/표 스크롤,방법론 대화상자. 페이지 JS 오류0.
- 운영 데스크톱 홈/표와 모바일 표 캡처를 직접 열어 레이아웃도 확인했다.
- GitHub CI 최종 결과: 단위897개,통합589개,전체ESLint,TypeScript,프로덕션빌드 모두 성공. 배포 커밋만의 별도 작업 폴더에서 브라우저7개 성공.

[운영 홈](https://nomorevibe.brut.bot/#popular-projects) · [전체 목록](https://nomorevibe.brut.bot/popular?tier=rising)

로컬 실측 증거(비밀 없음,gitignored):
[홈 화면](../../.crawl-samples/popular-production-home-desktop.png),
[개인 계정 표](../../.crawl-samples/popular-production-table-desktop.png),
[모바일 표](../../.crawl-samples/popular-production-table-mobile.png),
[브라우저 검증 JSON](../../.crawl-samples/popular-production-smoke.json).

## 완료 후 누락 재점검

원문 C-1–C-4를 코드·DB·운영 화면에 다시 대조했다. 필수 구현의 남은 항목은 없다.
C-4는 실제 모든 기본 구간이 채워져 조건부 확장을 발동하지 않은 결정이며,검색 예산과 심사 기준을 유지했다.
C-1의30.39분 실측은 발행249/검토대기12/거부57,재처리new/approved0이다. 검토대기12건은 기존 운영 심사 절차가 처리할 대상이며 자동 승인하지 않았다.
AI 흔적이 없는 곳에는 공개된 흔적 없음을 표시하며,데이터나 제작 도구를 지어내지 않았다.

실패 기록: 체크박스의 서버 이동 중 되돌아감 수정,추가 통합시험 server-only mock 누락 수정,
기존 상세 E2E의 오래된 기대값 정정. 별도 검증 폴더의 node_modules 외부 심볼릭 링크는 Turbopack이 거부하여 실제 파일 복제본으로 바꾼 뒤7개 시험이 모두 통과했다.

