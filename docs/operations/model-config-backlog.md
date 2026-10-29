# 모델 설정 유연화 백로그

> 이전 작업의 수치·실패 이력을 보존한다. 현재 작업 결과는 문서 끝 «후속 통합»과 «최종 검증·PR»이 기준이다.

## 범위·기준

- 작업 공간: GPU3090의 현재 xAegis worktree, 브랜치 `xaegis/d9b32a19`만 사용. 원본 폴더의 사용자 변경은 수정하지 않는다.
- `git fetch origin` 결과 기준 `199a3ebb` (#708). 기존 작업 브랜치에 main을 병합한 로컬 커밋 `baaf88c4`.
- 기준 재측정: 아래 재현 명령 **158줄** (lib/crawl 54, lib/domain 44, app/(operator) 22, relay 3, lib/operations 20, lib/jobs 7, lib/llm 1, lib/db 7). 사용자 제공 대표치 216줄은 원래 정규식이 없어 동일 수치로 재현했다고 주장하지 않는다. 이 차선은 동일 명령의 이전→현재를 비교한다. 주석도 소스 줄이므로 포함하며, 주석 삭제로 줄 수를 낮추지 않는다.

```bash
git grep -I -n -i -E '(qwen[0-9]|gpt-[0-9]|gpt-oss|gemma[- /0-9]|deepseek-v[0-9]|sonnet|opus|haiku|grok-[0-9])' 199a3ebb -- lib/crawl lib/domain 'app/(operator)' scripts/local-model-relay lib/operations lib/jobs lib/llm lib/db ':!*.test.*' ':!*.md' | wc -l
```

## 진행

| 항목 | 상태 | 내용·다음 작업 |
| --- | --- | --- |
| 1. 중앙 모델 레지스트리 | 끝남 | `lib/llm/model-registry.ts`: 기존 versioned JSON 환경설정 방식 재사용. 장비 포함 키·표시 이름·provider·URL·wire 모델·family·기한·maxTokens·concurrency·용도·선택 매핑 검증. `MODEL_REGISTRY_CONFIG`, 기존 env와 `*_MODEL_KEY` 호환. 잘못된 설정은 명시적 오류. |
| 2. 장비별 라우팅 | 끝남 | key/명시적 장비 label 우선. 동명 bare 모델 거절, 번역 두 HTTP 서버·AI2 native 키/terminal 회귀 통과. |
| 3a. lib/llm | 끝남 | serving family 고정 enum 제거. registry와 별도로 검증 hash·물리 용량·unknown 보존. |
| 3b. lib/db, lib/jobs | 끝남 | 모델명 일치는 역사 주석. 실제 jobs 검색 동시 실행 2/4를 중앙 예산에 연결. DB schema 데이터는 유지. |
| 3c. lib/operations | 끝남 | 단계별 현재 모델·CLI 모델/제공자·기본 effort·native publication 가드를 중앙 metadata에 연결. |
| 3d. scripts/local-model-relay | 끝남 | 레지스트리 기반 모델 선택. 사설 인증·고정 loopback upstream·검증 readback 유지. |
| 3e. lib/domain | 끝남 | text 모델/주소/토큰과 assist family·SQL·claim 상한 연결. 용량·독립성 정책 유지. |
| 3f. app/(operator) | 끝남 | 현재 설정·선택지·표·툴팁 중앙 조회. 독립 로컬 Next 앱에서 실제 컴포넌트 브라우저 7항목 확인, JPG 확보. |
| 3g. lib/crawl | 끝남(명시적 제외 있음) | 생성 모델·주소·출력 토큰·tagline 동시성·AI2 키 연결. 아래 병행 차선 및 불변 자료는 제외. |
| 4. M1 번역 설정 문서·기본값 | 끝남 | 기본 `m1:translation` → `[m1] gemma4-26b` alias. exact advertised id는 운영 readback 뒤 설정에 입력. 적용·롤백·계약/정책 절차와 과거 문서 주의 문구 작성 완료. |
| 5. 검증 스크립트 | 끝남 | 64개 명시적 unit 파일 + typegen + tsc + git grep 감소 검사. 최종 896시험·정적 검사·158→98, exit 0. |
| lib/crawl/first-reviewers.ts | 다음 차례(기한 차선 병합 뒤) | 사용자 지정 배정 로직 소유 파일. 이번 차선 수정 금지. |
| 클라이언트·중계기·게이트웨이 기한 숫자 | 다음 차례(기한 차선 병합 뒤) | 레지스트리에 timeoutMs는 선언하되 실제 deadline 상수/숫자는 이번에 교체하지 않음. |
| 배포·운영 DB·push | 범위 밖 | 수행하지 않음. 설정·계약 준비와 실제 운영 참여를 구분. |

## 검증 이력

- `package-lock.json`은 원본 폴더와 `cmp` 일치. 의존성 설치 대신 기존 `node_modules`에 worktree 안 symlink를 만들어 읽기 전용 재사용. 원본 설치·lock 파일 수정 없음, 네트워크 설치 실패 없음.
- Next.js 동봉 `node_modules/next/dist/docs/01-app/02-guides/environment-variables.md` 읽음. `NEXT_PUBLIC_` 설정은 빌드 시 고정되므로 레지스트리에 사용하지 않는다.
- 1항목: `npx vitest run tests/model-registry.test.ts`: 1파일 5시험 통과. `npx tsc --noEmit --incremental false`: 실행 중, 결과는 다음 기록에서 보존.
- 3a: serving contract의 고정 family enum을 검증된 문자열 identity로 확장. 새 family의 shape 통과가 readiness를 뜻하지 않으며 기존 exact hash·provider·endpoint·토큰 검사는 유지. 관련 4파일 17시험 통과 (`model-registry`, `local-model-serving-contract`, `local-model-capacity-schema`, `local-model-terminal`).
- 3b 조사: `lib/db` 7줄과 `lib/jobs` 7줄의 측정 일치는 모두 설명·역사 주석이다. 실제 모델 선택 상수는 없으며 jobs는 translate/profile 등 소비자 상수를 이미 재사용한다. 주석을 레지스트리 조회로 바꾸지 않는다. 향후 연결된 소비자의 회귀를 함께 실행한다.
- 3c–3e 연결: 운영 단계 표의 제품 번역이 실제 `PRODUCT_TRANSLATION_MODEL`과 달랐던 부분을 고침. relay 모델 선택·readback family, assist family 정책·SQL parameter, 검색 profile/verify·소개 검수·tagline·번역 모델/주소와 출력 상한을 중앙 조회로 연결. 목적별 토큰/동시 실행 예산은 `limits`로 조절하며 모델 ceiling·기존 검증 계약을 넘지 않는다. jobs의 검색 동시 실행 2/4 기본값 유지.
- 변경 범위 회귀: 처음 14파일 203시험 중 3실패(이전 공용 번역 기본값을 기대한 시험). 요청한 M1 독립 기본값과 실제 제품 번역 상수를 기대하도록 갱신한 뒤 18파일 269시험 통과. 실패 이력은 삭제하지 않는다.
- 첫 `npx tsc --noEmit --incremental false`는 `PageProps` 생성 파일 부재로 exit 2 (공개 페이지·기존 시험 8곳). 동봉 Next CLI 문서의 `next typegen && tsc --noEmit` 절차 적용 중. 차선 코드 오류로 단정하지 않음.

## 구현 후 검증과 잔여 분류

- 2·3: M1/GPU3090 동명 모델의 중앙 resolver·실제 로컬 HTTP 두 서버 회귀 통과. M1 번역은 M1 주소와 `[m1]` label을 쓰고 GPU 요청은 0건이다. AI2 직접 계약도 backendId로 각각 보존하고 장비 키로 exact endpoint+wire model을 선택한다. capacity 기록의 키와 실제 요청 모델을 분리한 native HTTP/tokenizer/terminal 회귀가 통과했다. 같은 가중치의 두 장비를 독립 표로 늘리지 않도록 JS/SQL underlying 비교도 키를 해석한다.
- 3: gateway/CLI/DeepSeek의 출력 토큰·text/tagline 검색 동시성 기본값을 중앙 예산으로 옮겼다. AI2 native 출력 설정은 검증 계약에서 조절하고, 장비 키 경로에서는 registry ceiling도 확인한다. 실제 context C·32,000 요청 정책·exact tokenizer·strict terminal은 보존했다. 분류 제공자는 `sonnet` 문자열로 실행기를 추정하지 않고 레지스트리 metadata를 사용한다. 제공자를 Claude로 바꾼 우선 모델의 기본 effort는 high이며, 미지원 어댑터·잘못된 CLI 이름은 호출 전에 거절한다.
- 첫 AI2 계약 회귀 8파일 92시험 중 1실패: 계약 map이 모델명에서 backendId로 바뀌었는데 시험의 `.get(model)`이 남았다. 새 map 계약을 기대하도록 고친 후 관련 14파일 162시험 통과. 이후 장비 키 native 전송 회귀 추가분도 통과했다.
- 전체 차선 1차 검증: `scripts/verify-model-config.sh` **56파일 805시험 + typegen + tsc + git grep 158→100, exit 0**. 이후 provider 전환 가드와 publication native의 마지막 `sonnet` 비교를 추가로 수정했으므로 최종 실행 결과를 아래에 따로 남긴다.
- 추가 회귀: provider/기본 effort/CLI guard 6파일 61시험 통과. publication 관련 3파일 15시험 통과. 신규 registry/분류 helper/운영자 표/새 회귀 파일의 ESLint 통과.
- 화면 검증: 전체 앱 dev는 npm `registry.npmjs.org` 접근 차단, webpack의 기존 instrumentation Node 모듈 browser 번들 오류, Turbopack의 외부 node_modules symlink root 제한으로 완주하지 못했다. 기존 설치·브라우저를 재사용하고 외부 fetch를 호출 전에 차단한 **독립 로컬 Next 검수 앱**에 실제 변경 컴포넌트와 CSS를 불러 확인했다. 새 의존성 설치, 외부 인증, 운영 DB·실제 워커 호출은 하지 않았다.
- 실제 브라우저 확인: 1280px/390px, 모델 설정 펼치기, M1 key 확인, 직접 AI2 선택 시 `gpu3090:review` 입력, gateway 선택 시 scoped 이름 입력, CLI 선택에 따른 high 제약, 기본 모델 복원, 모바일 페이지 가로 넘침 없음, pageerror 0. 메뉴·제목은 «단계별 모델»로 맞췄으며 표의 가로 스크롤 안내를 넣었다. JPG 두 장은 최종 개발사항 보고에 첨부한다. 인증·실제 운영 화면 전체 검증을 했다고 주장하지 않는다. 임시 검수 route/app/build는 작업 트리 안에서 만들고 제거했다.
- `next dev`가 AGENTS.md 제목을 h1→h2로 재생성한 한 줄은 사용자 제공 규칙에 따라 함께 커밋한다.

## 남은 것과 이유

| 사용처 | 상태·이유 |
| --- | --- |
| `lib/crawl/first-reviewers.ts` 및 AI1 배정의 키 연결 | **다음 차례(기한 차선 병합 뒤)**. 사용자가 배정 로직 파일 수정을 금지했다. 이 파일은 기준 커밋 대비 diff 0이다. |
| 클라이언트·relay·gateway의 실제 기한 상수/숫자 | **다음 차례(기한 차선 병합 뒤)**. timeoutMs를 중앙에 선언했으나 기존 시간 제한 숫자는 바꾸지 않았다. |
| 현재 M1 advertised model id/revision·실제 gateway label/배치 참여 | **운영 확인 필요·이번 범위 밖**. 기본 family는 사용자 지정 Gemma 4 26B로 갱신했지만 exact alias readback·운영 설정/계약/정책 적용은 하지 않았다. [절차](model-config-registry.md)에 변경·롤백 방법을 적었다. |
| `audit-import-sources.ts`의 `qwen3.8-flash-next+vision` | **이관 대상 아님**. 2026-10-22 수입 결과의 불변 provenance이며 현재 요청 모델 설정으로 바꾸면 기존 자료의 출처를 거짓으로 바꾸게 된다. |
| evidence/agents의 Claude/Qwen 이름 인식 regex·외부 프로젝트 env parser | **이관 대상 아님**. nomorevibe의 모델 선택이 아니라 외부 저장소 제작 근거의 문법/분류다. |
| 임베딩 모델 revision/dimensions, context C·byte/tokenizer 증명 | **공유 데이터/검증 계약**. 자유로운 생성 모델 선택과 다르며 기존 벡터 호환·재색인·실제 readback을 유지한다. 임베딩 revision/차원 변경과 운영 데이터 재작성은 이 차선에서 하지 않는다. |
| 역사·측정 주석과 중앙 기본값 | **보존**. 모델 교체 설정은 중앙에서 바뀌며 주석의 과거 실측을 새 모델 이름으로 덮거나 줄 수를 줄이기 위해 지우지 않는다. |
| `repoPushedAt` 등 광역 grep 일치 | **검색 오탐**. 고정 검색식의 opus가 식별자 일부에도 맞는다. 기준/현재 모두 같은 검색식을 사용하고 전체 줄 수를 실제 실행 모델 상수 수로 해석하지 않는다. |
- 3 최종 추가 회귀: native 키·provider·publication 가드 관련 8파일 51시험 + `tsc --noEmit --incremental false` 통과. 구현 커밋 `acb3314b`.
- 4 문서 확인: 전체 기본 JSON export→재해석→`m1:translation` 선택을 실제 실행해 통과. 처음 예시의 tsx CLI는 `listen EPERM: operation not permitted /tmp/tsx-1000/3.pipe`로 불필요한 IPC socket 생성이 막혔다. 예시를 IPC 서버를 만들지 않는 `node --import tsx` 로더 호출로 고쳐 같은 설치를 재사용해 통과했다. OS/네트워크 허용을 넓히지 않았다.
- 최신 main 갱신: `git fetch origin && git merge origin/main`, `b047bddb`를 로컬 merge `17609cc9`로 반영. 반영된 것은 배포 절차/Python 회귀이며 기한·AI1 배정 차선은 들어오지 않았으므로 해당 대기는 유지한다.
- 중간 최종 검증은 59파일 821시험 + typegen/tsc + 158→99, exit 0으로 통과했다. 이어 실제 소비자 전체 대조에서 한국어 소개·검색 질의의 독립 registry selection이 legacy 공용 상수/기록과 불일치하는 사용처를 찾아 추가 연결했다. 요청·native capacity·결과 저장·운영 표시를 각각 KOREAN_TAGLINE_MODEL/SEARCH_QUERY_MODEL로 통일했고 기존 공용 env 동작은 유지한다.
- 추가 점검: 9파일 156시험 통과. 이후 직접 모델 표시를 장비/실제 model로 바꾼 화면 시험 1개가 이전 고정 문구를 기대해 실패했다(7파일 82시험 중 1실패). 기대값을 실제 config 상수로 갱신했다. 모바일 화면에서 단계 표의 좁은 열을 확인해 최소 폭·가로 스크롤 안내를 적용하고 실제 화면으로 다시 확인했다. 기본 registry/CLI와 독립 용도 선택 두 시나리오, 1280px/390px JPG를 확보했으며 마지막 브라우저 9항목/페이지 오류 0을 확인했다.
- 후속 소비자 회귀: 8파일 99시험 통과. CLI registry 교체 시 저장된 옛 model을 삭제하거나 기본값으로 덮지 않고 보존하도록 복원 경계를 분리했다. 옛 선택은 안전한 shape로 읽되 현재 registry와 맞지 않으면 classifyReady/configReady=false, native 계약 발급·실행은 보류한다. 기존 인증은 보존하며 새 선택은 기존 검사·적용 절차를 거친다. 관련 5파일 61시험과 ESLint 통과. 브라우저에서 미등록된 저장 선택이 보이는 상태와 기본값 복원을 확인했다.

## 최종 상태 (2026-10-29 UTC)

- 이 차선의 구현·설정 절차·검증 스크립트는 로컬 커밋 완료 대상으로 정리했다. 실행 가능한 백로그는 끝났고, 남은 것은 위의 명시적 기한/AI1 배정 병합 대기·운영 확인 범위다. push·배포·운영 DB 변경·사용자 원본 작업 폴더 변경은 수행하지 않았다.
- 최종 `scripts/verify-model-config.sh`: **64파일 896시험 통과**, `next typegen` 성공, `tsc --noEmit --incremental false` 성공, 모델명 고정 검색 **158→98**, **exit 0**. 전체 unit·전체 DB·전체 e2e·production build·원격 CI는 실행하지 않았다.
- 남은 검색 일치 98줄을 직접 분류: 중앙 기본값 14, 역사/측정 주석 75, 불변 수입 provenance 1, 외부 제작 근거 parser 4, `repoPushedAt` 식별자 오탐 4. 이 값은 같은 광역 검색식의 소스 줄 수이며 단독 실행 모델 설정 상수 개수로 해석하지 않는다.
- 레지스트리 직접 연결 **41파일**, 중앙 조회 **107호출 위치**. 간접 metadata/상수 소비자도 같은 선택을 따르며 이 두 수치는 직접 import와 helper 호출만 센다.
- 기본 설정과 용도별 M1 override, 저장된 미등록 CLI 선택 보존을 독립 로컬 Next 앱의 실제 컴포넌트로 확인했다. 1280px/390px, 마지막 브라우저 **10항목 통과·pageerror 0**. 최종 모델 표는 모바일 가로 스크롤로 전체 값을 볼 수 있다. 운영 인증·실제 워커 검증은 미실시다. JPG는 개발사항 보고에 첨부하며 최종 검수 앱/route/임시 스크립트는 제거했다.
- 신규 registry/분류 helper/표/회귀 파일과 변경 CLI 선택 컴포넌트의 ESLint 통과. 이전의 미사용 mock 인자 경고 1개는 typed mock으로 고쳐 최종 해당 파일 lint 경고 0을 확인했다.
- `lib/crawl/first-reviewers.ts` 기준 대비 diff 0. 기존 클라이언트·중계기·게이트웨이 기한 숫자는 유지했다. timeoutMs 선언의 실제 적용은 기한 차선 병합 뒤 항목으로 남겼다.
- 실제 배포 준비는 정확한 M1 advertised id/revision·gateway 장비 라우팅 readback과 해당 serving/capacity 설정 검증을 거친 뒤 판정한다. 이번 산출물은 코드·문서·로컬 검증 결과이며 운영 참여 완료 영수증은 아니다.

조회 사용처 재현 명령(각 명령의 검색 범위는 위 baseline과 같다):

```bash
git grep -l -F 'llm/model-registry' -- lib/crawl lib/domain 'app/(operator)' scripts/local-model-relay lib/operations lib/jobs lib/llm lib/db ':!*.test.*' ':!*.md' | wc -l
git grep -o -E '(configuredModel|configuredModelDefinition|configuredModelForProvider|modelForPurpose|modelFamily|modelLimits|modelBaseUrl|modelRequestBudget|readModelRegistry|resolveRegistryModel)\(' -- lib/crawl lib/domain 'app/(operator)' scripts/local-model-relay lib/operations lib/jobs lib/llm lib/db ':!*.test.*' ':!*.md' ':!lib/llm/model-registry.ts' | wc -l
```

## 산출물 경로 차단 (최종 보고 뒤 확인)

- 개발사항 보고 `c70954cd08b62121a7c1a86e723a863655a40951101d751db93adbe8a282ee41`은 Markdown 문서·백로그·설정 절차·검증 로그·JPG 3장을 인라인 첨부하여 **queued**로 저장했다. 허브 전달·artifact URL 발급은 아직 확인되지 않았다.
- 요청 경로 `/home/ubuntu/.xaegis-hub/data/local-agent/jobs/d9b32a19-27bc-4d32-8f18-d0af05410ced/artifacts`는 존재하지만 직접 결과 파일 저장이 막혔다. 실제 시도는 Python `Path(.../artifacts/model-config-report.md).write_text(..., encoding='utf-8')`이며 **`OSError: [Errno 30] Read-only file system`**, exit 1이었다.
- **막힘: 지정 artifacts 폴더에 결과 파일 직접 저장.** 이 경로의 쓰기 권한/마운트 상태는 현재 작업의 허용 범위 밖이다. 다른 경로로 결과 파일을 우회 저장하거나 권한을 확대하지 않았다. 기존 보고 큐의 인라인 첨부를 보존하고 허브 동기화와 산출물 경로 쓰기 가능 상태를 기다린다.
- 코드 최종 검증은 여전히 64파일 896시험·타입 검사·158→98·스크립트 exit 0이다. 이 추가 기록은 문서만 변경하며 배포/운영 DB/push는 수행하지 않는다.

## 후속 통합 (현재 작업: 2026-10-29)

- 작업 공간 `b6a58262-d6c2-4002-89d7-084fda1f5e95`, 브랜치 `feat/model-config-registry`. 위 기록은 이전 차선의 검증 이력으로 보존한다.
- `git fetch origin` 뒤 `origin/main` a3094a73에서 새 브랜치를 만들고 6f5d98f1을 merge `4ffbed6d`로 통합했다. 충돌 없음. 다른 브랜치 기록·원본 파일은 수정하지 않았다.
- 통합 직후 지정 회귀 6파일 29시험 통과. 이어 registry 기한·후보 목록·정확한 사용자 제공 M1 모델 id를 연결 중이다. PR709~712의 retry/active intent 고정·미전송 우회·회수 기본 비활성은 유지한다.
- 의존성은 같은 package-lock임을 cmp로 확인한 원본 node_modules의 읽기 전용 재사용 symlink. npm 설치는 하지 않았다.
- 신규 runtime 회귀 첫 실행은 7파일 34시험 중 1실패: 존재하지 않는 gatewayReviewWire export를 시험에서 참조했다(TypeError: gatewayReviewWire is not a function). 실제 reviewWithGateway의 전송 stub을 검사하도록 고쳤다. 구현의 export를 시험 때문에 늘리지 않았다.
- 남은 작업: 기한/relay/후보 회귀, 두 검증 스크립트·tsc, 변경 UI 로컬 브라우저 확인·스크린샷, 재측정, PR/check/main 병합. 운영 배포·재시작·모델 조작·용량 모드·운영 DB 쓰기는 금지 범위로 유지한다.

### 후속 구현·검수

- 레지스트리 deadlines/timeouts/선택적 모델 사다리로 review·relay·번역·text·CLI·재심사 경로의 기한을 연결했다. 선언된 사다리의 모든 이웃 순서·2초 여유와 모델 client 기한 불일치를 로드 시 거절한다. 후보 모델의 client만 줄여 기본 gateway보다 먼저 끝나는 설정도 거절한다. 검증 primitive는 순환 import를 피하도록 deadline-policy.ts로 옮기고 기존 deadline-ladder.ts export를 유지했다.
- gateway wire max_tokens·relay 출력 상한은 모델과 용도 예산의 작은 값이다. relay의 엔진 기한/강제 시작 시각 opt-in·native 계약·exact tokenizer·unknown 보존은 그대로다. 실제 외부 엔진/gateway 강제는 이번 작업에서 확인하지 않았다.
- first-reviewers.ts의 selectFirstReviewer/firstReviewers 본문은 그대로다. 후보 제안만 candidates.first-review에서 조회하며 Supa·MLX GPT OSS·sonnet/opus·Grok 기본 목록을 유지한다. 실제 DB pool·심사 결과를 변경하지 않는다.
- M1 기본 wire id를 사용자가 지정한 `[m1] mlx-community--gemma-4-26b-a4b-it-4bit`로 정리했다. 기존 공용 gateway 주소만 유지하고 미확인 M1 직접 주소를 만들지 않았다. 주소 누락은 명확한 설정 오류다. 오프라인 migrate-model-registry-m1.ts는 기존 주소·리소스·다른 모델을 보존해 검토용 JSON만 출력한다. 실제 CLI smoke 및 2시험 통과.
- 신규 회귀 중 괄호 오타로 model-registry.test.ts 변환이 한 번 실패했다(7파일 27시험은 통과, 해당 파일은 미실행). 고친 뒤 지정 8파일 36시험 통과. 이전 실패는 이력으로 보존한다.
- 첫 verify-model-config 실행: 65파일 902시험·typegen·tsc·158→99, exit 0. 첫 verify-review-stall 실행: 타입·변경 파일 lint·차선 unit·Oracle Python 전부 exit 0. 이후 gateway 모델 ceiling/추가 검증·오프라인 이전 도구를 넣었으므로 최종 검증은 별도 아래에 기록한다.
- 실제 UI: 기존 설치를 재사용한 독립 로컬 Next 앱에서 실제 ModelRows/ModelRegistryTable/TextModelStagesTable/CSS를 확인했다. 1280×1000/390×844, 메뉴·제목 일치, 기본 GPT OSS 후보 보존, CLI 후보 선택과 입력 반영, M1 정확한 id 표시, 모바일 페이지 넘침 없음, 가로 표 끝까지 스크롤, pageerror 0. 8항목 통과. PNG 3장(데스크톱·모바일 왼쪽·모바일 오른쪽)을 개발사항 보고에 첨부한다. 운영 인증·실제 저장·외부 모델 호출 검증은 아니다. 임시 앱/빌드는 제거했다.
- UI 도구 제한: Next의 선택적 npm 버전 조회가 `Network access to "registry.npmjs.org" was blocked: domain is not on the allowlist for the current sandbox mode.`로 막혔다. 같은 lock/node_modules를 유지하고 임시 앱의 외부 fetch를 호출 전에 거절한 상태로 검수했다. Playwright 기본 headless shell 1234는 없었으며(`Executable doesn't exist at ...chromium_headless_shell-1234/...`), 이미 설치된 1248 실행 파일을 재사용했다. 설치·접근 권한 확대 없음.
- 지정 artifacts/scratch 경로에 `.write-probe` 파일을 쓰는 Path.write_text는 각각 `OSError(30, 'Read-only file system')`였다. 승인 차단은 없었고 마운트 쓰기 제한이다. 권한·마운트 변경 없이 보고 도구의 지원된 첨부 기능으로 증거를 보존한다.

### 동일 측정 재실행

위의 동일 git grep 명령에서 `199a3ebb=158`, `origin/main(a3094a73)=158`, `6f5d98f1=98`, 현재 **99**줄이다. 이전 차선 대비 +1은 중앙 DEFAULT_MODEL_CANDIDATES의 기본 키 한 줄(sonnet/opus 검색 일치)이며 분산 운영 상수가 아니다. 99줄을 실제 확인한 분류는 중앙 기본값/후보 키 15, 역사·측정·형식 설명 주석 75, 불변 수입 provenance 1, 외부 제작 근거 parser 4, repoPushedAt 검색 오탐 4다. 주석·역사 출처·외부 parser를 현재 모델 설정으로 바꾸거나 줄 수를 줄이려고 삭제하지 않는다.

### 최종 검증·PR (진행 중)

- 지정 타입 검사 `npx tsc --noEmit -p .`: exit 0.
- 지정 unit `npx vitest run tests/model-registry*.test.ts tests/first-reviewers.test.ts tests/local-model-relay.test.ts tests/deadline-ladder.test.ts`: **8파일 37시험 통과**, exit 0. 실제 로컬 HTTP 두 서버에서 qwen3.8-flash-next 동명 모델을 재현했다. key 지정과 `[m1]` label 지정 두 경우 모두 M1 요청 1건·GPU3090 요청 0건이다.
- 두 번째 모델 스크립트: **66파일 904시험**·typegen·tsc·158→99, exit 0. 이후 추가한 label 재현 1시험은 지정 unit에 통과했고 다음 최종 스크립트 묶음에 포함한다.
- 두 번째 review-stall 스크립트: typegen·tsc·변경 파일 eslint·차선 unit·Oracle Python 전부 exit 0. 신규 registry/순수 validator/오프라인 migration/운영자 component와 신규 회귀 ESLint도 경고 0.
- gh branch protection 읽기 `gh api repos/JRVector9/nomorevibe/branches/main/protection ...`는 HTTP 403: `Upgrade to GitHub Pro or make this repository public to enable this feature.`였다. 보호 설정은 변경하지 않는다. PR의 실제 check 결과를 확인하고 허용된 일반 merge만 사용한다.
- 구현과 설정 이전 도구는 완료. 남은 코드 작업 없음. 최종 재검증·PR/check/main merge·최종 개발사항 보고를 진행한다. 운영 후속은 이 차선의 금지 범위로 유지한다.

- PR [#713](https://github.com/JRVector9/nomorevibe/pull/713) 생성·push 완료. 첫 CI 40799670719는 scope/check 실패: `ci_diff_whitespace_error` / `ci_check_scope_failed`. 로그와 `git diff --check origin/main...HEAD`로 deadline-policy.ts의 EOF 빈 줄을 확인해 제거했다. 이후 검증은 작업 트리만이 아니라 PR 전체 diff에 적용한다. 실패를 rerun으로 덮지 않고 수정 커밋을 추가한다.

- 두 번째 CI 40799774290: scope/typecheck/lint/build/이미지 빌드는 통과했지만 integration-ledger의 제품 번역 10시험이 실패했다. 로그의 `expected { status: 'deferred' } ... { status: 'completed' }`를 추적해 제품 번역 fixture가 여전히 사유 번역 TRANSLATE_MODEL로 계약·capacity route를 만들고 있음을 확인했다. 제품은 PRODUCT_TRANSLATION_MODEL, 한국어 소개는 KOREAN_TAGLINE_MODEL, 검색 질의/reclaim fixture는 SEARCH_QUERY_MODEL로 명시적으로 분리한다. 운영의 계약/용량 거절은 완화하지 않는다. reason fixture는 기존 용도를 유지한다.
- 로컬 DB 재현 준비의 읽기 전용 `docker info --format '{{.ServerVersion}}'`는 `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`로 실패했다. Docker 권한을 확대하거나 운영 DB를 사용하지 않는다. 로컬 DB 시험은 미실행이며 CI의 격리 PostgreSQL에서 실제 dispatch/terminal/복원 시험을 확인한다.
- 최종 로컬 모델 스크립트는 **66파일 905시험 + typegen/tsc + 158→99**, review-stall은 **23파일 339시험 + Oracle Python 71시험 + typegen/tsc/lint**, 둘 다 exit 0. 지정 tsc도 다시 exit 0이다.
