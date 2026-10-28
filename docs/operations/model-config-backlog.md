# 모델 설정 유연화 백로그

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
| 5. 검증 스크립트 | 진행 중 | 명시적 scoped unit 목록 + typegen + tsc + git grep 감소 스크립트 작성. 최종 실행 및 로컬 커밋 남음. |
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
