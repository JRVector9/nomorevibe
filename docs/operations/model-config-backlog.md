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
| 2. 장비별 라우팅 | 진행 중 | 중앙 resolver는 key/명시적 gateway label 우선, 동명 bare 모델은 거절. M1/GPU3090 동명 회귀 추가. 실제 소비자 연결과 HTTP 회귀 남음. |
| 3a. lib/llm | 끝남 | serving family 검증 및 레지스트리 연계. 검증 hash·물리 용량·unknown 보존. |
| 3b. lib/db, lib/jobs | 끝남 | 실제 고정값 여부 확인 후 소비자 연계. 역사 주석은 설정 사용처로 세지 않는다. |
| 3c. lib/operations | 남음 | 현재 모델 조회·단계별 표시·CLI 모델 선택의 중앙 값 연결. |
| 3d. scripts/local-model-relay | 남음 | 레지스트리 기반 모델 선택. 사설 인증·고정 loopback upstream·검증 readback 유지. |
| 3e. lib/domain | 남음 | text 및 assist 소비자 연결, 용량·독립성 정책 유지. |
| 3f. app/(operator) | 남음 | 현재 설정과 선택지 중앙 조회. 보이는 기능 변경 시 실제 브라우저 확인. |
| 3g. lib/crawl | 남음 | 모델·주소·리소스 설정 연결. 아래 병행 차선 제외. |
| 4. M1 번역 설정 문서·기본값 | 진행 중 | 기본 `m1:translation` → `[m1] gemma4-26b` (Gemma 4 26B). 실제 서버의 정확한 advertised id는 운영 readback 확인 뒤 설정에 입력; 이 차선은 운영 접속·변경하지 않음. 적용·롤백·strict contract/policy 변경 방법 문서화 남음. |
| 5. 검증 스크립트 | 남음 | 변경 영역 unit + tsc + git grep 감소 확인. 전체 unit/DB 시험 금지. |
| lib/crawl/first-reviewers.ts | 다음 차례(기한 차선 병합 뒤) | 사용자 지정 배정 로직 소유 파일. 이번 차선 수정 금지. |
| 클라이언트·중계기·게이트웨이 기한 숫자 | 다음 차례(기한 차선 병합 뒤) | 레지스트리에 timeoutMs는 선언하되 실제 deadline 상수/숫자는 이번에 교체하지 않음. |
| 배포·운영 DB·push | 범위 밖 | 수행하지 않음. 설정·계약 준비와 실제 운영 참여를 구분. |

## 검증 이력

- `package-lock.json`은 원본 폴더와 `cmp` 일치. 의존성 설치 대신 기존 `node_modules`에 worktree 안 symlink를 만들어 읽기 전용 재사용. 원본 설치·lock 파일 수정 없음, 네트워크 설치 실패 없음.
- Next.js 동봉 `node_modules/next/dist/docs/01-app/02-guides/environment-variables.md` 읽음. `NEXT_PUBLIC_` 설정은 빌드 시 고정되므로 레지스트리에 사용하지 않는다.
- 1항목: `npx vitest run tests/model-registry.test.ts`: 1파일 5시험 통과. `npx tsc --noEmit --incremental false`: 실행 중, 결과는 다음 기록에서 보존.
- 3a: serving contract의 고정 family enum을 검증된 문자열 identity로 확장. 새 family의 shape 통과가 readiness를 뜻하지 않으며 기존 exact hash·provider·endpoint·토큰 검사는 유지. 관련 4파일 17시험 통과 (`model-registry`, `local-model-serving-contract`, `local-model-capacity-schema`, `local-model-terminal`).
- 3b 조사: `lib/db` 7줄과 `lib/jobs` 7줄의 측정 일치는 모두 설명·역사 주석이다. 실제 모델 선택 상수는 없으며 jobs는 translate/profile 등 소비자 상수를 이미 재사용한다. 주석을 레지스트리 조회로 바꾸지 않는다. 향후 연결된 소비자의 회귀를 함께 실행한다.
