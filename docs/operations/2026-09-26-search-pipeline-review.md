# 수집·검수 및 검색 저장 항목 검토 — 2026-09-26

## 결론
수집·AI1·AI2·발행은 작동하며 검색 스키마와 색인 사본의 광범위한 누락은 없다. 그러나 **기존 제품 README 보충 수집 누락, 근거 비교 응답 크기 초과에 따른 재시도, 소개 수정 후 오래된 키워드 잔존, 검색 모델 출력 검증의 허점**을 확인했다. 이 보고는 검토·보고 요청에 따른 감사이며 구현·운영 설정·큐·배포를 변경하지 않았다.

점검 시각은21:09–21:12의수집실행확인,21:30:55의검색저장집계,21:32이후의추가조회·외부원본대조다. 동시갱신중인운영DB라서수치는하나의원자적전역스냅샷이아니다. HEAD410c991. 관련운영워커소스9개SHA256이현재작업트리와일치하므로아래코드경로는실제운영에도있다.

## 저장 요소별 확인
공개(seeded/verified)제품19,217개는전부crawler출처다. 비공개제품까지모든필드를강제로채워야한다는기준은적용하지않았다.

| 저장 항목 | 저장된 공개 제품 | 원본·연결 검증 | 판단 |
|---|---:|---|---|
| 수집 후보→문서→제품 |19,217|후보/문서연결누락0|연결정상|
| search_topics |8,357|원본문서와차이0|빈값은원본토픽없음|
| search_page_text |18,931|원본있는데사본없는제품0;초기차이1→후속조회0|갱신정상;원본부터빈것286|
| search_readme |6,810|원본있는데사본없는제품0,차이0|사본이아니라과거원본수집이부족|
| product_search_profiles |19,217|누락0|프로필행이있다고키워드생성이성공한것은아님|
| search_keywords |18,941|성공프로필19,216개에서검수제거목록을반영한사본불일치0|전반동기화정상|
| search_category |19,217|CATEGORY_LABELS와불일치0|전부저장|
| search_vector |19,217|빈색인0,생성컬럼식에토픽/본문/README/키워드/카테고리포함|검색요소가색인에연결됨|
| 검수기록 |18,950|Sonnet9,539 / Qwen3.8 9,411|키워드있는제품중검수미완료5개|
| 검색질의로그 |130회|최근24시간81회,normalized/duration누락0|저장은되고있음;요청총수대조없어100%기록보장아님|
| 영어질의번역캐시 |216개성공/1개실패|해시에질의프롬프트판·해당용어표판포함|최근24시간로그중한국어번역표현없는질의0|

`search_keywords`보유수18,941과프로필분류합계는다를수있다. 성공빈배열261개,생성실패1개뿐아니라검수에서모든키워드를뺀제품도있어서NULL이항상누락은아니다.검색은키워드가없어도기존이름·소개·본문·README색인으로가능하다. 최신확장검색·한국어번역·용어표·스트리밍은쿼리/렌더동작변경이며새제품컬럼이필요한기능이아니다.

## 발견 사항 — 우선순위 순

### 1. 근거 커밋 비교가 정상 대용량 응답을 invalid로 처리하고 재시도함 — 확인, 높은 우선순위
- 활성수요에속한최신스캔중partial/invalid883건(21:30조회). 전체최신스캔invalid908건(후속조회)모두첫pendingCommit의observations가이미있어**compare단계**에남아있다. 누적request_count최대441로재시도가실제로소모되고있다. 최대값만으로정확한동일요청횟수를계산하지는않는다.
- 코드위치:`lib/domain/evidence/agents/collect.ts:128`, `lib/crawl/github.ts:139`, `lib/domain/evidence/agents/repository.ts:67`.
- compare는기본응답전체를받지만실제필요한것은커밋관계status다. GitHub공통클라이언트가2MiB를넘는JSON을invalid_response로반환하고,콜렉터는pendingCommit을그대로둔채15분후다시시도한다.
- 운영실패커서4개를GitHub공개API로조회한결과모두HTTP200/ahead인데응답2,373,767–2,471,923바이트로2MiB상한초과:OpenAlice,MeshMonitor,Navigate,Over.garden. **이4개에서는원인을확인했다. 나머지883개모두같은원인이라고단정하지않는다.**
- 개선:커밋관계조회만작은페이지로요청하거나필요필드만안전하게읽는별도경로를두고,본문초과/JSON오류/검증실패를구분한다. OpenAlice에서`per_page=1&page=1`조회는1,166,905바이트로작아졌고HTTP200/ahead유지. 첫페이지파일패치가큰경우도고려해야하므로이한표본만으로전체수정완료를주장할수없다. 영구적오류는재시도상한·운영확인대기로보내고,확인안된커밋근거를성공으로승격하지않는다.
- GitHub공식문서는페이지지정과첫페이지에만파일목록이나오는특성을명시한다. [Compare two commits](https://docs.github.com/en/rest/commits/commits#compare-two-commits). 전역크기상한을무작정올릴필요는없다.

### 2. 과거 공개 제품의 README 보충 수집 경로가 없음 — 확인, 높은 우선순위
- 원본문서README가빈제품12,407개. 그중12,089개는readmeSampleVersion자체가없어'README없음을확인함'과구분된다. 모두9월19일이전공개분이다.9월20일이후공개분에는현재조회에서버전미기록0.
- 미기록제품8개(최신순편의표본)를공개raw README.md로조회해**8개모두HTTP200/본문존재**확인. MatchupKetchup은페이지본문이14자뿐인데README1,504바이트가저장돼있지않다. 무작위표본이아니므로12,089개전부README가있다는추정에사용하지않는다.
- 코드위치:`lib/crawl/jobs/review-document.ts:9`, `lib/jobs/products/search-refresh.ts:35`. README는1차심사입력로드때받으며검색갱신잡은이미있는원본을복사하기만한다. 과거발행분을새README수집대상으로다시넣는상시작업은확인되지않았다. 공개분감사도자동전체감사가아니다.
- 개선:README확인여부·수집시각·실패코드를남기는기존제품보충수집을작은배치로돌리고,확보후검색사본갱신및해당검색키워드재생성을요청한다. 생존확인은본문을보충하지만README를받지않는다.

### 3. 소개를 고쳐도 예전 검색 키워드가 남음 — 코드 및 로컬 재현 확인
- 코드위치:`lib/domain/products/intro-checks.ts:113`. 잘못된소개를수정하면product_search_profiles만삭제하고products.search_keywords는지우지않는다.
- 전용localhost55435/nomorevibe_test에서재현:소개WoW→Margonem수정후프로필0행인데search_keywords='World of Warcraft items'잔존. 새키워드생성을HTTP502로실패시켜도잔존한다. 생성이5회실패하면자동대상에서빠져잘못된키워드가오래남을수있다.
- 운영스냅샷에는프로필없는키워드잔재0. **현재대량오염이관측됐다는주장은아니다.** 소개검수잡도보류상태라최근이경로는실행되지않는다.
- 개선:소개수정트랜잭션에서키워드원본과search_keywords사본을함께무효화하고재생성대상을남긴다.기존소개검수테스트는프로필삭제만검사하고검색사본을검사하지않아놓쳤다.

### 4. 빈/불완전한 모델 답이 완료 상태로 저장될 수 있음 — 코드 및 파서 재현 확인
- `lib/domain/products/search-profile.ts:118`–130:`{}`처럼키워드배열이아예없는답도ok:true/en:[]/ko:[]로읽힌다. 키워드없는JSON과정상빈배열응답을구분하지않아30일간성공프로필로남을수있다.
- 운영성공빈프로필261개. 실제비제품/설명부족으로정당한빈답도포함될수있다. 모델원문응답을저장하지않아**261개중몇개가이파서허점때문인지입증할수없다.** 표본에는구체적인소개·본문·README가있는Chute도있어빈프로필재검토가필요하다.
- `lib/domain/products/search-verify.ts:75`: `{"checks":[]}`도성공으로읽힌다. 빠뜨린키워드는유지하는현재정책은잘못된삭제를줄이지만verified_at은전체키워드검수완료를보장하지않는다. 체크별개수/불완전상태/모델원문은저장되지않아운영영향범위를산정할수없다.
- 개선:배열이없는생성답은invalid_output으로구분. 의도적빈배열은별도사유로남김. 검수는미응답키워드를유지하되완료와부분검수를구분하고,키워드별검사수·제거사유·promptVersion/입력해시를저장한다. 현재원본키워드·제거목록·모델은이미저장된다.

### 5. 재시도 한도에 도달한 검색 항목6개가 자동 작업에서 빠져 있음 — 운영 확인
- 생성실패1개:home-page-3(Hyperswitch),invalid_output/attempts5.
- 검수실패5개:Authelia,SnapNote,springdoc-openapi,OpenAlice,Yoda,모두invalid_output/verify_attempts5. 마지막관련갱신9월24일.
- pendingProfiles/pendingVerifications의실제predicate로조회한준비큐는둘다0. **준비큐0이모두성공이라는뜻은아니다.** 실패한도항목이선택에서빠지기때문이다.
- 개선:한도초과항목을별도운영대기로표시하고,파서/모델변경후관리된재검수기능을제공한다.생성timeout등게이트웨이문제도제품별실패횟수에누적될수있으며검수의NOT_PRODUCT_FAULT에서도timeout/5xx는빠져있으므로한도정책일관성도점검할것.

## 저장은 됐지만 신선도·추적에 남은 한계
- 성공프로필19,216개중2,747개(14.3%)는현재증거로다시계산한sourceHash와다르다. 키워드재생성은성공후30일이되어야검토하도록설계되어있어서갱신잡이빠진버그라고단정하지않는다. 본문날짜·숫자만바뀐것도포함된다. 그러나메이커수정·소개교정·주요기능변경과동적본문의사소한변화를구분해전자만즉시무효화할필요가있다.
- 생성해시는증거만포함하고생성promptVersion/모델판은포함하지않는다. 같은증거라면30일후에도reuse되므로프롬프트변경만으로다시생성되지않는다. 검수도verify_model만남아같은모델의프롬프트판을구분하기어렵다. 이항목들은**추가권장추적정보**이며새검색기능이컬럼없어서실행되지않는누락과구분한다.
- 소개검수잡not_before2100년보류유지. 실제선택함수기준준비대상43개. 실패/무한정체가아닌설정상보류이며,과거구독사용중단요청과관련될수있으나정확한설정행위는확인하지못했다. 임의재개안함.
- agentEvidence.enabled=true지만enforceEligibility=false/displayObservedFacts=false. 근거완료가현재추가발행자격필수조건은아니다. 근거스캔실패가전체수집/발행중단으로이어지는설정은아니다.기존정책을임의변경하지않았다.

## 수집·심사 동작 검토
21:09스냅샷최근1시간원본170/AI1성공38회/AI2성공26표/발행15,21:11새41건발견→21:12수집41건/실패0. 실제중단이아니다.1차실패시도최근24시간timeout2/invalid_output2이며현재running기록없음. 과거실패누적을현시점장애로취급하지않았다.2차미해결오류는needs_human2건. 불일치심사1,826건은기술재시도로없어지는큐가아니라사람판단이필요한별도대기다.현재검토가모든심사결과의의미적정확도를채점한것은아니다.

## 실제 검증
- 단위7파일69PASS:검색프로필/검수/질의/소개/심사입력/근거수집/발행guard.
- 통합7파일101PASS+1TODO:검색프로필/검수/소개/검색품질/검색/발행/근거커서복구. DB는전용localhost55435/nomorevibe_test. TODO는search-quality의'한국어제품을영어로찾는다';별도search-profile통합테스트에같은방향의키워드검색시나리오는실행됐다.기존테스트가위발견사항전체를보장한다고해석하지말것.
- 별도proof스크립트는로컬DB에서소개수정후검색사본잔존/재생성실패후잔존과파서빈답수용을재현했다. 생성테스트제품·관련잡은finally로삭제. 운영DB에는실행안함.
- 운영READ ONLY조회와후속SELECT,공개GitHubGET,SSH런타임파일hash조회. 운영설정/작업/데이터변경없음. 전체build/lint/전체test는이번에실행하지않았다.

```sh
npm test -- tests/search-profile.test.ts tests/search-verify.test.ts tests/search-query.test.ts tests/intro-check.test.ts tests/crawl-agent-input.test.ts tests/agent-evidence-collect.test.ts tests/crawl-publication-guard.test.ts
npm run test:integration -- tests/integration/search-profile.test.ts tests/integration/search-verify.test.ts tests/integration/intro-check.test.ts tests/integration/search-quality.test.ts tests/integration/catalog-search.test.ts tests/integration/crawl-publish.test.ts tests/integration/agent-evidence-cursor-recovery.test.ts
python3 /tmp/nmv-health-20260925.py search
python3 /tmp/nmv-health-20260925.py search-detail
npx tsx .crawl-samples/admin-ui-review/search-proofs-20260926.ts
```

## 개선 실행 순서
1. 대용량compare응답축소·실패사유분리·재시도상한으로근거수집낭비해소.
2. 기존README보충수집+수집상태기록,확보된제품의검색문서/키워드재생성.
3. 소개수정시검색키워드동시무효화와회귀테스트.
4. 생성·검수파서형식/완료범위강화,실패한도6건관리된재처리,빈프로필261개표본심사.
5. 주요원문변경즉시재생성,동적본문30일정책유지,생성/검수프롬프트판·입력해시·검사범위기록.

증거폴더의JSON은비밀값없는집계·공개제품표본·검증결과다. 읽기전용스크립트사본은.txt로보관했다. 첫운영집계스크립트의regexp역참조템플릿이스케이프로SQLundefined오류가났고,저장소키추출을split_part로바꿔조회완료했다.그실패호출은READ ONLY transaction에서rollback됐으며운영변경없음.
