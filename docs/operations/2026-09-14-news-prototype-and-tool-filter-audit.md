# 제작 도구 필터 점검과 AI 소식 시안 — 2026-09-14

## 요청과 범위

제작 도구 선택지가 없는 이유를 확인하고, NewsTimes를 참고한 AI 뉴스 HTML 시안을 실제 자료로 제작했다. 운영 앱/DB 변경 및 배포는 수행하지 않았다. 이미 수정 중이던 ProductHero와 사용자 디자인 파일은 보존했다.

## 제작 도구 필터

03:18 KST 운영 DB 읽기 전용 조회: 공개(verified/seeded) 프로젝트 6,907개, 제작자 보고로 인정되는 비어 있지 않은 builder 0개. 실제 운영 홈의 `#home-builder` 옵션도 **모든 제작 도구 하나뿐**이었다.

03:35 재조회: builder 필드가 채워진 프로젝트 811개, 공개 필터에 적격인 값 0개. 수집기의 추정값은 제작자 신고가 아니어서 제외된다.

- `components/BrowseFilters.tsx`: 전달된 builders만 선택지로 렌더링. 빈 배열에도 select를 표시한다.
- `lib/domain/products/repository.ts`: `listBuilders`는 공개 상태 + builder 존재 + `(source != crawler OR claimedAt IS NOT NULL)` 조건. 검색 필터에도 같은 조건이 적용된다.
- `components/home/AutoSubmitSelect.tsx`: onChange 시 form.requestSubmit. 이벤트 자체가 막힌 문제가 아니다.
- `lib/domain/products/view.ts`: 미인수 크롤러 제품의 추정 builder는 공개 제작 도구 필드에서 제외한다.

**현재 그 드롭다운은 사용할 선택지가 없는 상태다. 내부 도구 탐지는 존재하나 공개 제작 도구 필터와 연결된 데이터 기준이 다르다.**

03:35 최신 탐지 버전 2026-09-14.1: 완료 68회, 부분 완료 13회. 관측 행은 Claude Code/Codex 클라이언트 설정 10/3, 커밋 기여 표기 56/12 등으로 구분된다. 이 숫자는 고유 프로젝트 수나 검증된 AI 사용 프로젝트 수가 아니다. 지침 파일이나 설정 존재를 개발 기여 확정으로 승격하면 안 된다.

후속 UX: 선택지가 없을 때 필터를 숨기거나 '확인된 제작 도구 없음' 비활성 상태로 표시. 제작자 신고와 근거로 관측한 도구를 혼합하지 않고, 검증된 관측 필터를 제공할 경우 별도 출처/판정 정책으로 구현한다. 이번 요청의 질문에는 현 상태를 설명했고 운영 필터를 임의로 변경하지 않았다.

## 현재 운영 뉴스

18개 출처(뉴스 10, 릴리스 8) 설정. 공개 데이터 210건, 실제 항목이 있는 출처 16개. 모든 출처 cursor.ok=true, 가장 최근 출처 확인 2026-09-14 02:54 KST. autoApprove=true, disabledSources=[]이고 `lib/jobs/catalog.ts`의 news-refresh 간격은 60분이다. 성공적인 출처 조회가 회사의 모든 기사 수집을 보장하지는 않는다.

현재 공개 메뉴 'AI 소식'은 독립 페이지가 아니라 홈 `/#briefing`으로 연결된다. 홈은 회사별 하나씩 최대 3개를 보여준다. 새 뉴스 전용 페이지는 아직 운영 반영 전이다.

Anthropic/DeepSeek 사이트맵은 최초 수집 시 기준선만 저장하여 기존 기사가 공개 목록에 들어오지 않는 상태가 확인됐다. 또한 Anthropic의 Fable/Mythos 5.1 발표는 최상위 경로여서 기존 `/news/`·`/engineering/` 필터 밖이다. 전체 회사/전체 발표를 목표로 할 때 수집 범위를 개선해야 한다.

## 결과물

`prototypes/ai-news/index.html`, 미리보기 http://localhost:4178/

9개 회사 기사 25건, 영상 3건, X/Threads 게시물 3건, 릴리스 스냅샷 4건. 원문 링크·확인된 게시일·한국어 요약·출처 표시. 대표 이미지/영상 썸네일 등 24개 이미지를 HTML 안에 포함했다. 자료는 공식 피드/원문/oEmbed로 확인했다. 소셜 게시물은 실제 자료지만 수동 선정이며 날짜를 그대로 표시한다.

단독 HTML은 고정 자료이고, 함께 제공한 로컬 서버는 공식 뉴스 피드 8개와 OpenAI 영상 피드를 1시간마다 확인한다. 웹 화면은 1분마다 반영한다. 서버 종료 시 갱신도 종료된다. X·Threads API 연결과 운영 서비스의 상시 실행은 후속 작업이다. 현재 모든 AI 회사가 수집된 것은 아니다.

참고 및 확장 계획: `prototypes/ai-news/README.md`.

## 실제 실행한 검증

- `node --check prototypes/ai-news/collect.mjs`, `node --check prototypes/ai-news/serve.mjs`: 통과.
- `node prototypes/ai-news/build.mjs`: 25기사/9회사 HTML 생성.
- `node prototypes/ai-news/qa.mjs`: 회사/주제 필터, 검색/빈 결과/초기화, 9→18→25, 저장 유지/해제, X/Threads 탭, 원문 링크, 키보드 dialog 닫기, 1440/768/390/320px 문서 overflow 없음, 이미지 decode, 단독 파일 실행, JS 오류 0 통과. 최종 16개 검증에 폴링 연결 실패 후 새 기사 없이도 정상 상태로 복구되는 검사 포함.
- `node prototypes/ai-news/qa-refresh.mjs`: 수집 실패 시 기존 자료 보존, 미래/잘못된 게시일·비 HTTPS 제외, URL 중복 제거, 스크립트 문자열 삽입 방지, 실제 공식 피드 시작/예약 실행 2회 통과. 테스트용 간격은 3초, 실제 미리보기 기본 1시간.
- `npx eslint prototypes/ai-news/*.mjs`, `git diff --check`: 통과.
- 운영 앱 소스가 바뀌지 않아 전체 Next 빌드/통합 DB 테스트는 실행하지 않았다.

첫 모바일 점검에서 회사 필터의 최소 너비 때문에 390px 문서가 넘쳤다. grid 자식에 min-width:0을 적용해 해결. 320px 추가 검사에서 제호/버튼 너비 초과를 발견해 작은 화면 제호 크기를 조정한 뒤 재실행 통과했다. 수정 후 데스크톱과 모바일 스크린샷을 직접 열어 확인했다.

추가 리뷰에서 폴링 연결 실패 후 같은 데이터로 복구될 때 오류 문구가 남는 문제를 수정하고, 가상 시계로 실패→복구를 재현해 통과했다.

최종 재검토: 미연동 소셜을 자동 수집으로 표기하지 않음, 인기/조회/멘션 숫자를 만들어 넣지 않음, 전체 AI 회사 수집 완료로 주장하지 않음, 원문/게시일 보존, 기존 사용자 변경 보존.
