# AI 소식 HTML 시안

사용자 요청: NewsTimes를 참고한 신문형 AI 뉴스 화면을 **실제 데이터로 먼저 제시**한다. 이 디렉터리는 운영 Next.js 앱과 독립된 디자인 시안이다. 운영 배포나 DB 변경은 수행하지 않았다.

- [HTML 열기](./index.html): CSS, JavaScript, 스냅샷, 확인한 이미지 24개를 파일 안에 포함. 파일만 열어도 화면·필터·검색·저장이 동작한다.
- [데스크톱 화면](./qa-results/preview-desktop-fold.png), [전체 화면](./qa-results/preview-1440.png), [모바일 화면](./qa-results/preview-390.png)
- [UI 검증 결과](./qa-results/ui.json), [수집·타이머 검증](./qa-results/refresh.json)

## 실행

저장소 루트에서, 기존 node_modules 사용:

```sh
node prototypes/ai-news/serve.mjs
```

http://localhost:4178/ 에서 확인한다. 서버는 시작할 때와 이후 **1시간마다** 공식 뉴스 RSS 8개와 OpenAI YouTube 피드 1개를 확인한다. 화면은 1분마다 같은 서버의 data.json을 확인한다. 브라우저를 닫아도 서버 프로세스가 실행 중이면 수집은 계속된다. 컴퓨터/서버 프로세스가 꺼지면 중단된다. 파일로 직접 연 HTML은 자동 갱신되지 않는 고정 스냅샷이다. 운영 뉴스 페이지의 상시 수집은 기존 maintenance worker에 연결해야 한다.

```sh
node prototypes/ai-news/collect.mjs  # 지금 한 번 수집 후 HTML 재생성
node prototypes/ai-news/build.mjs    # 데이터 그대로 HTML만 재생성
node prototypes/ai-news/qa.mjs       # 4178 서버 실행 후 UI 검증
node prototypes/ai-news/qa-refresh.mjs # 임시 사본에서 수집 오류/타이머 검증
```

타이머 테스트는 임시 디렉터리·4179 포트·3초 간격을 사용하며 2회 완료 후 프로세스를 종료한다. 실제 기본 간격은 3,600,000ms다. 테스트용 가짜 날짜/악성 문자열은 임시 디렉터리에만 기록한다.

## 디자인과 데이터

NewsTimes의 중앙 제호, 섹션 내비게이션, 큰 대표 기사 이미지, 좌측 보조 기사와 우측 최신 뉴스, 구분선 중심 편집 구성을 참고했다. nomorevibe의 밝은 바탕과 보라색 포인트를 유지했다. 광고 여백은 두지 않았다.

현재 9개 회사의 기사 25건, 영상 3건, 소셜 게시물 3건. 회사는 OpenAI, Anthropic, Google, Mistral, Cursor, GitHub, Hugging Face, NVIDIA, Meta다. Google의 두 피드는 한 회사로 묶는다. 이것은 전체 AI 회사 수집이 완료됐다는 의미가 아니다.

- 뉴스: 각 공식 피드 또는 원문. 한국어 제목·요약은 해당 원문을 확인해 작성한 시안 편집문이다. 원제는 링크 title 속성과 데이터에 보존한다.
- 영상: OpenAI 공식 채널 RSS 1건 자동 갱신, No Priors 인터뷰와 Andrej Karpathy 영상은 원문/oEmbed를 확인한 수동 선정 자료. 원문에서 확인된 게시일을 사용한다.
- X: Sam Altman 2026-09-08 (공식 oEmbed 확인), Andrej Karpathy 2026-03-08 (원문 확인).
- Threads: Mark Zuckerberg 2026-01-12 (실제 페이지 og:description 확인). 오래된 글을 최신 글로 표시하지 않는다.
- 개발 도구 릴리스 4건: 기존 운영 DB의 공개 자료를 읽기 전용으로 가져온 스냅샷. 시안 갱신 대상에는 포함되지 않는다.
- 시안에 반응수·인기순·실시간 멘션량 등 확인하지 않은 지표는 만들지 않았다.
- 날짜 표시는 한국 시간 기준이다. 피드의 시간대와 원문 사이트의 날짜가 다른 경우 한국 시간 날짜가 하루 다를 수 있다.

## 파일 역할

- template.html: 화면 및 상호작용 원본.
- index.html: build.mjs로 생성한 단독 실행 HTML.
- editorial.json: 확인한 한국어 제목·요약, 수동 선정 자료.
- sources.json: 고정 공식 피드 목록.
- data.json: 최신 수집 결과와 출처별 확인 상태.
- image-cache.json: 원문 이미지의 WebP 캐시. 출처 주소를 키로 유지한다.
- collect.mjs: 공식 피드/YouTube 갱신, URL 중복 제거, 날짜 검증, 오류 시 기존 데이터 유지, HTML 생성.
- serve.mjs: 로컬 전용 127.0.0.1 서버, 시간당 수집, 공개 파일 3개와 상태 URL만 제공.

추가 기사에는 확인된 한국어 편집문이 없으면 원제를 사용한다. 임의 번역·모델 추측을 자동 생성하지 않는다. 피드별 최근 3건(OpenAI 5건)을 시안에서 확인하고 최대 500건을 보관한다. 초기 전체 이력 수집이나 운영용 페이지네이션 정책은 아니다.

## 운영 구현 시 다음 단계

1. 새 `/news` 페이지와 공통 기사 모델: 회사·발행자·채널·원문·게시일·수집일·갱신 상태·이미지 출처. RSS의 공개 시각, 사이트맵 lastmod, 최초 발견 시각을 구별한다.
2. 기존 시간당 `news-refresh`를 활용하고 피드별 커서/실패/재시도 상태를 관리한다. URL 중복 방지와 관리자 숨김 유지, 소스별 최초 백필을 추가한다. 사이트맵 최초 기준선 등록만으로 과거 기사가 나타나지는 않는다.
3. 회사별 공식 출처를 추가한다. 이번 시안에서 Microsoft AI RSS는 410, 시도한 Meta AI 분류 RSS는 404였다. 이 주소를 정상 수집기로 등록하지 않았다. xAI·DeepSeek·Moonshot·Qwen·Cohere·Perplexity·Adobe·Stability AI·ElevenLabs·Runway 및 국내 업체도 각각 공식 출처 확보가 필요하다.
4. Anthropic은 새 발표가 `/news/` 밖의 최상위 경로에도 존재한다. 현재 운영 사이트맵의 `/news/`, `/engineering/` 경로 필터만으로 모든 모델 발표를 수집할 수 없다. 뉴스룸 링크를 함께 수집하고 게시일을 원문에서 확인해야 한다.
5. YouTube는 허용한 공식/인플루언서 채널 RSS를 추가한다. 최근 피드 밖의 이력이나 지표는 별도 Data API 연동으로 검토한다. 사용자 선택 시 원문으로 이동하도록 구성했다.
6. X는 공식 API의 사용자 게시물과 멘션을 구분해 연동한다. 공개 사용자 게시물에는 개발자 앱/토큰이 필요하다. API 쿼터에 맞춘 주기와 since_id 커서, 삭제/수정 재검증을 둔다.
7. Threads는 Meta 앱·사용자 토큰·공개 프로필/키워드 탐색 권한을 확인한 뒤 연결한다. '해당 인물이 작성한 글'과 '다른 사람이 그 인물을 언급한 글'을 분리한다. 현재 시안은 전자이며 멘션 전체 검색 서비스는 아니다.
8. 번역을 운영에 추가한다면 원문 변경 해시로 재번역하고 원제/원문 접근을 유지한다. 한국어 번역 지연이 기사 수집을 막지 않게 한다.

플랫폼 공식 근거:
- [X 사용자 게시물·멘션 API](https://docs.x.com/x-api/posts/timelines/introduction)
- [Meta가 제공한 Threads API 컬렉션](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api)
- [OpenAI 공식 YouTube 피드](https://www.youtube.com/feeds/videos.xml?channel_id=UCXZCJLdBC09xxGZ6gcdrc6A)

별도 키나 접근 권한을 받기 전에는 X·Threads 자동 수집이 동작한다고 표시하지 않는다. 이 시안의 데이터/이미지/HTML에는 자격 증명을 포함하지 않는다.
