# AI 프로젝트 판별 재검토와 서버 배포 검토

2026-09-06 07:31–07:35 KST 실측. 코드 기준 `be4aee0`.
범위: 코드 추적, 공개 원본 대조, 두 검색 표본, Docker 로그/자원/DB 조회, 기존 테스트.
서비스 코드 수정·데이터 정정·서버 배포는 수행하지 않았다. 통합 테스트는 별도 DB 55435에서 실행했다.
수치 근거는 [측정 JSON](2026-09-06-ai-crawler-deployment-evidence.json)에 보관했다.
이전 [상세 근거 수집 점검](2026-09-06-crawler-evidence-audit.md)의 발견 사항도 여전히 유효하다.

## 결론

크롤러는 작동하지만 **AI 제작 관련성을 검증하는 심사는 없다.** 검색 신호를 통과한 제품에
배포 여부·규모·최근 활동 필터만 적용한다. 카테고리 분류용 LLM도 AI 제작 여부를 판단하지 않는다.
현재 자동 발행 품질과 상시 실행 설정을 수정한 후 배포하는 것이 맞다.

초기 구성은 **동일 서버, 프런트엔드와 실제 워커는 별도 컨테이너**를 권장한다.
낮은 초기 트래픽, 제품 약 1천~수천 개, 원격 LLM 호출, 이미지 순차 처리, 빌드는 다른 머신에서
수행하는 조건으로 **4 vCPU / RAM 8GB / SSD 80GB**를 시작 사양으로 제안한다.
이는 실측 하한과 예정 작업에 여유를 더한 설계 추정이며 부하 테스트로 보증한 처리 한계는 아니다.

## AI 관련성을 실제로 어떻게 판별하는가

README의 서비스 정의는 “AI로 만든 제품”이다. 이를 “AI 기능이 들어간 제품”과 나눠야 한다.
예를 들어 AI로 구현한 일반 계산기는 서비스 목적에 맞을 수 있고, 오래된 대형 AI 라이브러리에
AI 보조 커밋 하나가 있다고 전체를 AI로 만든 제품이라고 볼 수는 없다.

| 단계 | 현재 동작 | 부족한 검증 |
|---|---|---|
| 발견 | `Co-authored-by: Claude`, `Co-authored-by: Codex`, `topic:vibe-coding` 검색 | 검색 결과와 원본 근거 일치 여부 |
| 큐 저장 | repo, 첫 signal, 첫 builder 저장 | commit SHA/URL/일시/실제 trailer 보관, 여러 신호 병합 |
| 수집 | 저장소 메타, 홈페이지 응답/제목/설명 | 원본 저장소-서비스 관계, AI 제작 근거 재확인 |
| 심사 | 별 수·fork·활동·홈페이지·문서/개인 사이트 제외 | AI 제작 근거 상태를 입력받지도 않음 |
| 분류 | Claude CLI로 5개 제품 카테고리 중 선택 | AI 관련성 심사 기능이 아님 |
| 발행 | 프론티어의 builder를 복사해 “우리 추정” 표시 | 근거의 유효성·최신성·정확한 제품 연결 |

`judge(factsFromRepoMeta(...), ...)`에 AI 근거가 없는 일반 계산기를 넣고 HTTP 200과 최근
push를 주면 `approved / passed`가 된다. **AI가 사용되지 않았다는 판정이 아니라,
심사 함수가 AI 근거의 존재를 확인하지 않는다는 재현**이다. 현재 구조는 후보 발견 단계가
AI 관련성을 충분히 보장한다고 가정하는데 아래 반례 때문에 그 가정이 성립하지 않는다.

### 검색 결과 표본

운영 코드와 같은 검색어·최근 180일·relevance·첫 페이지 100건으로 공개 GitHub API를 조회했다.
트레일러 줄에 공급자 이름이 나타나는지 검사했다. 실제 작성자 신원이나 전체 코드 작성 비율을
검증한 것이 아니며, merge 본문에 반복된 trailer도 있을 수 있다.

| 검색 | 표본 | 해당 AI의 공동작성자 줄 있음 | 고유 저장소 | incomplete_results |
|---|---:|---:|---:|---|
| Claude | 100 commits | 100 | 67 | true |
| Codex | 100 commits | 98 | 49 | true |

Codex 두 반례는 Qwen-Coder 공동작성자 줄과 일반 본문의 `codex:` 문구가 함께 있는 커밋이다.
현재 코드는 검색어의 builder를 그대로 사용하므로 이런 항목에도 Codex를 붙일 수 있다.
이 저장소가 실제 제품으로 발행됐다는 뜻이나 전체 오탐률이 2%라는 뜻은 아니다.
[반례 1](https://github.com/QwenLM/qwen-code/commit/3133e835e6da5a37b682aad50e927d8d13ebdb8d),
[반례 2](https://github.com/QwenLM/qwen-code/commit/37cb9ac161f1c98e7fec0731f7050a1809126273).

처음에는 이름이 Codex로 시작하는 줄만 세어 90건으로 나왔으나, `OpenAI Codex` 변형을
포함하도록 분석을 정정한 결과가 98건이다. 단순 문자열 매칭을 새 판정기로 그대로 쓰면 안 된다.

검색 API는 결과를 최대 1,000건만 반환하며 부분 결과도 반환한다. 현재 타입은
`total_count/incomplete_results`를 보존하지 않고 10페이지 이후 “사이클 완료”로 돌아간다.
넓은 180일 relevance 검색을 반복하면 이미 본 상위 결과에 치우친다. 날짜 구간 분할과
마지막 완료 구간 기록이 필요하다. [GitHub 검색 문서](https://docs.github.com/en/rest/search/search).

### 저장된 전체 후보와 실제 오분류

DB 스냅샷은 후보 4,652개, 발행 1,006개였다. 이전 점검의 1,004개에서 조사 중 두 개가 늘었다.

| 첫 발견 신호 | 후보 수 | 발행 | 심사 대기 | 거부 |
|---|---:|---:|---:|---:|
| Claude 커밋 | 2,916 | 555 | 118 | 2,243 |
| Codex 커밋 | 1,157 | 153 | 50 | 954 |
| vibe-coding 토픽 | 579 | 298 | 50 | 231 |

vibe-coding 토픽은 자체 분류표이므로 AI 제작에 대한 외부 증명이 아니다. builder를 비워 두는
현재 동작은 맞지만, 별도의 출처 근거 없이 자동 발행하는 정책은 보완해야 한다.

발행 제품 25개를 repo 해시순으로 고정 표본 조회하고 의심 항목의 원본을 대조했다.

| 수집 저장소 | 발행된 사이트 | 문제 |
|---|---|---|
| `aoshen02/vllm-detached-backup-20260720` | vllm.ai | 별 0, fork=false인 백업 저장소 메타로 대형 원본 제품을 심사 |
| `Sentinel-One/vector` | vector.dev | 별 0, fork=false인 다른 저장소를 원본 제품과 연결 |
| `AllenNPIT/ADS-Bit` | buymeacoffee.com/adsbit | 후원 페이지를 배포된 제품으로 승인 |

vLLM 사이트가 가리키는 저장소는 `vllm-project/vllm`, Vector 사이트가 가리키는 저장소는
`vectordotdev/vector`다. 단순 fork 플래그와 후보 저장소의 별 수만으로 원본 프로젝트를
구분하지 못한다. 홈페이지에 주소를 적었다는 사실만으로 공식 관계를 인정하면 안 된다.
[vLLM 공식 사이트](https://vllm.ai/), [Vector 공식 사이트](https://vector.dev/).

현재 규칙으로 저장된 4,652개 원본을 읽기 전용 재판정했을 때, 기존 발행 1,006개 중 12개가
더 이상 자동 승인되지 않았다. 5개는 기본 제목(Create Next App 등), 7개는 저장된 push 시각이
180일을 넘긴 경우다. **7개를 실제 접속 불가로 확인한 것은 아니다.** 규칙이 활동 부족에도
`unreachable` 사유를 쓰는 문제이며, 현재 저장소 메타를 재수집한 뒤 심사해야 한다.
이미 발행된 제품에 대한 정기 재평가/검토 큐도 필요하다. 자동 삭제는 권장하지 않는다.

### 권장 판정 기준

서로 다른 세 축을 별도로 저장하고 화면에 표시한다.

1. **AI 제작 근거**: 메이커 신고 / 공개 커밋 근거 / 설정·README의 명시적 설명 / 근거 부족.
   실제 trailer, commit SHA/URL, 관측 시각, 공급자·도구를 보관한다. “파일 존재”와
   “실제 사용”을 구분하며, 공개 기록만으로 전체 AI 제작 비율을 확정하지 않는다.
2. **AI 기능 여부**: 제품 설명과 문서에서 제공자가 주장하는 기능. AI 제작 근거를 대신하지 않는다.
3. **제품 실체·원본 관계**: 배포물인지, 사이트와 저장소의 연결이 맞는지, 복제/후원/문서/템플릿인지.

자동 발행은 구체적인 제작 근거와 제품 관계를 확보한 경우로 제한하고, 토픽뿐이거나
원본 관계가 충돌하면 심사 대기로 보낸다. 출처 자료를 LLM에 읽힐 때는 인용 가능한 근거와
불확실성을 구조화해서 받되 LLM 판단 자체를 검증 배지로 쓰지 않는다. 제작 AI를 알아낼 수
없다는 이유로 존재하지 않는 모델·도구를 채워 넣지 않는다.

## 수정 목록

각 항목은 아직 미수정이다. P1은 공개 배포 전 우선 처리, P2는 운영 품질/범위 확대 항목이다.

| ID | 우선순위 | 수정할 내용 | 주요 파일 | 완료 확인 |
|---|---|---|---|---|
| AI-01 | P1 | 검색 문자열과 실제 trailer 검증, SHA/URL/시각 저장 | `lib/crawl/github.ts`, `jobs/seed.ts`, `repository.ts`, `lib/db/crawl-schema.ts` | 본문에 Codex만 있는 반례가 Codex trailer 근거로 저장되지 않음 |
| AI-02 | P1 | AI 제작 근거를 심사 입력에 추가, 근거 부족은 보류 | `lib/crawl/rules.ts`, `jobs/judge.ts`, `settings-schema.ts` | 근거 없는 후보·토픽만 있는 후보가 자동 발행되지 않음 |
| AI-03 | P1 | 서비스↔원본 저장소 관계 확인, 복제 우회 차단 | `jobs/fetch.ts`, `rules.ts`, `publish.ts`, evidence relationship | vLLM/Vector 반례를 보류하고 실제 원본을 식별; 소유권 검증과 구분 |
| AI-04 | P1 | 후원/소개/문서 페이지와 실제 제품 구분 | `rules.ts`, `settings-schema.ts` | Buy Me a Coffee 반례 통과 방지; 도메인 목록 추가만으로 끝내지 않음 |
| AI-05 | P1 | CLI 인증 복구 또는 명시적으로 API 분류로 전환, 실패 가시화 | `lib/crawl/classify.ts`, `Dockerfile`, compose/deploy 설정 | 실제 원격 분류 1건 성공, 인증 실패가 대체 분류로 기록됨 |
| AI-06 | P2 | 여러 AI 발견 근거 누적, 첫 신호 독점 제거 | `repository.ts`, crawl schema | Claude 후 Codex 발견 시 두 근거 보존, 기존 근거 덮어쓰기 없음 |
| AI-07 | P2 | 검색 날짜 구간 분할, 불완전 결과/완료 범위 보존 | `github.ts`, `jobs/seed.ts` | 1,000건 초과·부분 결과에서 누락을 완료로 처리하지 않음 |
| AI-08 | P2 | 재수집·규칙 버전·재심사 큐, 사유 코드 세분화 | `rules.ts`, crawl repository/review | 오래된 push를 장애로 표기하지 않음; 이미 발행된 12개 검토 가능 |
| EV-01 | P1 | repo_url→근거 링크 동기화 및 기존 데이터 backfill | products register/manage, `crawl/publish.ts`, evidence repository | 숨김/메이커 선언 보존하며 기존 수집 누락 해소 |
| EV-02 | P1 | 출처의 성공·실패·시각에서 공개 라벨/요약 도출 | `products/detail-view.ts`, product-detail 컴포넌트 | GitHub 성공과 미검증/공식 출처 0의 모순 해소; 단순 도달은 별도 표시 |
| EV-03 | P1 | 가동 결과 유효기간과 오래된 상태 표시 | `ProductHero.tsx`, products health/detail-view | 8/18 검사 결과를 현재 온라인으로 단정하지 않음 |
| EV-04 | P2 | 사이트/README 링크·소개·미디어 발견 및 검증 연결 | evidence refresh/providers, media | 메이커 제출이 없는 제품도 원문 있는 정보 확보 |
| OP-01 | P1 | 실제 워커를 웹 프로세스에서 분리 | `compose.yml`, `Dockerfile`, job 진입점 | 크롤러 재시작/작업 부하가 웹 프로세스를 종료시키지 않음 |
| OP-02 | P1 | 짧은 worker tick과 출처별 nextAttemptAt 분리, backlog 계측 | `scripts/scheduler.sh`, uptime/evidence jobs | 1천 제품 6시간 내 가동 확인·24시간 내 저장소 갱신 목표 실측 |
| OP-03 | P1 | DB 재시작 정책, curl 전체 시간 제한, 정지 감지 | `compose.yml`, `scripts/scheduler.sh` | 재부팅 후 DB 포함 기동; 응답 없는 1개 작업이 전체 루프를 멈추지 않음 |
| OP-04 | P1 | origin/OAuth/비밀키/DB 노출/리버스 프록시 배포값 확정 | compose, deployment env | 로컬 주소·기본 토큰 제거, DB 비공개, 인증 callback 정상 |
| OP-05 | P2 | 자원 제한·로그 순환·백업 복구·큐 지연 모니터링 | compose, 운영 설정, admin status | 메모리/디스크/수집률/인증 실패 관측, 미디어 포함 복구 확인 |

기존 테스트는 정해진 검색 결과의 전달과 일반 제품 필터를 검증하지만 AI-01~03의 전체 계약을
보장하지 않는다. 반례를 먼저 회귀 테스트로 추가하고 수정해야 한다.

## 서버 구성 비교

현재는 `scheduler → app의 /api/cron/* → 같은 Next.js 프로세스의 수집기`다.
scheduler의 약 5 MiB 사용량은 실제 워커 용량이 아니다. scheduler만 별도 서버에 두어도
이미지 변환·CLI 실행·DB 처리는 프런트엔드 서버에 남는다.

```mermaid
flowchart LR
  U[사용자] --> P[HTTPS 리버스 프록시]
  subgraph S[초기 서버 한 대]
    P --> W[웹 컨테이너: Next.js]
    T[스케줄러] --> C[워커 컨테이너: 수집·근거·이미지·분류]
    W --> D[(PostgreSQL)]
    C --> D
  end
  C --> G[GitHub·제품 사이트·원격 LLM]
  D --> B[다른 호스트의 백업]
```

| 선택 | 장점 | 제한 | 판단 |
|---|---|---|---|
| 같은 서버·같은 앱 프로세스 | 현재 그대로 배포 가능 | 수집/CLI/이미지 부하와 앱 재시작이 웹에 영향 | 시연용 |
| 같은 서버·컨테이너 분리 | 비용 절약, 별도 자원 제한·재시작·배포 가능 | 호스트 장애/디스크/DB는 공유 | 초기 운영 권장 |
| 웹과 워커를 다른 서버에 배치 | 작업 폭증·호스트 장애 영향 분리 | 비용과 사설 네트워크/DB 운영 복잡도 증가 | 지속 부하 또는 가용성 요구 증가 시 |

빠른 분리 방법은 standalone 앱 이미지를 웹용과 내부 워커용으로 각각 띄우고 scheduler의
대상을 내부 워커로 바꾸는 것이다. 워커에는 공개 도메인/포트를 주지 않는다. 웹의 cron 경로는
역할 또는 프록시 정책으로 차단해 공용 웹에서 작업이 실행되지 않도록 한다. 마이그레이션은
한 번 실행하는 별도 단계로 빼고 웹/워커를 시작해야 한다.

장기적으로는 jobs registry를 호출하는 전용 Node 워커를 빌드한다. 현재 `npm run job`은
tsx와 원본 TS, `.env.local`에 의존하며 standalone 이미지에는 이 CLI 실행 구성이 보장되지
않는다. 이미지에 그대로 명령만 바꾸는 방식은 검증 없이 적용할 수 없다.
초기에는 DB 큐·커서를 재사용하고 별도 Redis/Kubernetes는 요구하지 않는다.

## 실제 부하와 필요한 사양

약 60초 동안 6번 관측한 로컬 ARM64 Docker 사용량:

| 구성 요소 | 메모리 관측 범위 | CPU 관측 |
|---|---:|---:|
| app | 233.0–247.8 MiB | 0–11.0% |
| PostgreSQL | 176.6–176.8 MiB | 0–1.57% |
| scheduler | 약 4.73 MiB | 0% |

이 구간은 부하 테스트가 아니며 최대치가 아니다. 실제 상세 source는 1개, gallery media는
0개이고 CLI 인증도 실패 중이다. 개발 머신의 측정값을 저사양 서버의 처리량 보장으로 쓰지 않는다.

최근 24시간 로그는 새 후보 1,040개 발견/수집, 가동 확인 2,079회, 상세 근거 시도 1회를
기록했다. 카테고리 LLM 성공 0회, 인증 실패 184회였다. 인증 오류가 나도 키워드 분류로
발행하므로 `job.failed=0`만 보고 LLM이 정상이라고 판단할 수 없다.

| 용도/조건 | 시작 사양 제안 | 적용 조건 |
|---|---|---|
| 소규모 실험 | 2 vCPU / RAM 4GB / SSD 40–60GB | CLI 없이 원격 API 분류로 전환하거나 분류를 명시적으로 끈 구성, 낮은 웹 부하, 순차 이미지 처리, 외부 빌드 |
| 초기 운영 권장 | **4 vCPU / RAM 8GB / SSD 80GB** | 웹·워커·DB 분리, CLI 분류 동시 1개, 이미지 동시 1개, 원격 LLM 사용 |
| 브라우저 수집/병렬 처리·서버 내 빌드까지 증가 | 8 vCPU / RAM 16GB / SSD 160GB 이상 검토 | 실제 CPU/메모리/큐 지연을 보고 증설 또는 워커 호스트 분리 |

GPU는 현재 필요 없다. LLM 추론을 원격으로 호출하고 로컬은 HTTP·파싱·이미지 변환을 한다.
Claude Code 공식 환경 요구사항은 RAM 4GB 이상이며 **프로세스당 항상 4GB를 쓴다는 뜻은
아니다**. 이를 다른 프로세스와 이미지 처리의 여유에 반영했다.
[Claude Code 환경 요구사항](https://code.claude.com/docs/en/setup#system-requirements).

8GB 서버의 초기 메모리 상한 예시는 웹 1GB, 워커 3GB, DB 2GB이며 나머지는 OS·프록시·캐시
여유로 남긴다. 고정 사용량 예상이 아니라 보호용 시작 상한이다. 정상 작업을 대표하는 부하에서
RSS·OOM·큐 지연을 보고 조정한다. CPU는 웹 1 vCPU, 워커 최대 2 vCPU 정도에서 시작하고
DB/호스트 여유를 둔다. 외부에서 이미지를 빌드해 배포하고, 서버에서 동시에 Next 빌드와
크롤러가 메모리를 경쟁하게 만들지 않는다.

### 사양보다 먼저 해결할 처리량 병목

- 가동 확인은 10분마다 최대 15개, 이론상 시간당 최대 90개다. 1,006개를 한 바퀴 돌려면
  최소 약 11.2시간이므로 “6시간 재확인” 목표를 만족할 수 없다. 조회 당시 1,004개 측정 행 중
  479개가 6시간 초과였고 최장 11.40시간이었다. 1천 개를 6시간마다 확인하려면 시간당
  약 168개가 필요하다. 짧은 틱으로 due 큐를 계속 처리하고 도메인별 간격은 유지한다.
- 상세 근거는 360틱마다 25초 예산의 배치를 한 번 실행한다. 미완료 커서는 다음 긴 간격까지
  기다린다. worker tick을 예컨대 1분으로 줄이되 저장소 24시간·feed 6시간 같은 출처별 간격은
  `nextAttemptAt`으로 유지한다. 준비된 일이 없으면 쉬게 한다.
- GitHub 저장소 첫 관측은 보통 repo/languages/contributors/releases/readme의 5호출이다.
  1천 개를 하루 한 번 갱신하면 약 5천 호출/일(평균 약 208회/시간), 1만 개면 약 5만 호출/일
  (평균 약 2,083회/시간)이다. 페이지 수·실패·재시도·신규 수집은 추가된다.
  첫 backfill 1천 개를 한 번에 실행하면 약 5천 호출이 몰리므로 분산해야 한다.
- 일반 PAT 읽기는 보통 시간당 5천 요청, 검색은 별도 분당 30회 제한이 있다. 동일 사용자
  토큰의 소비는 공유되므로 워커 서버 수를 늘려도 한도가 자동으로 늘지 않는다.
  release 페이지가 많으면 기본 5호출을 초과한다. rate-limit 응답을 존중하는 공용 요청 예산과
  백오프가 필요하다. [GitHub 한도](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

### 디스크와 상시 운영

현재 DB는 약 160 MB, 그중 OG 이미지가 약 131 MB다. OG 537장의 평균 원본은 약 247 KB,
최대 약 4.3 MB이고 상세 갤러리는 아직 0장이다. 이후 저장량은 텍스트보다 이미지가 좌우한다.
가령 **정규화 이미지와 썸네일의 합이 평균 300 KB라고 가정**하면 제품당 8장 기준
1천 제품은 약 2.4 GB, 1만 제품은 약 24 GB다. 버전 보관·WAL·인덱스·로그·백업은 별도이며
이 300 KB는 현재 갤러리에서 측정한 평균이 아니다. bytea를 보관하므로 미디어 포함 복구를
검증해야 한다. 이미지 버전 보존 기간과 미참조 자산 정리 정책을 정한다.

현재 Docker DB에는 restart 정책이 없고 실제 inspect도 `restart=no`다. 앱/scheduler는
`unless-stopped`이지만 DB가 재부팅 뒤 안 뜨면 전체가 멈춘다. DB 포함 재기동 정책,
Docker 부팅 시작, 볼륨 지속성을 설정하고 배포 대상에서 복구 연습을 해야 한다.
healthcheck가 unhealthy라는 사실만으로 멈추지 않은 프로세스를 자동 재시작한다고 가정하지
않는다. 프로세스 생존 외에 마지막 완료 시각·큐 지연을 감시한다.
[Docker 재시작 정책](https://docs.docker.com/engine/containers/start-containers-automatically/).

현재 scheduler의 curl에는 연결/전체 요청 제한 시간이 없다. 응답이 오지 않는 요청 하나가
직렬 루프 전체를 붙잡을 수 있다. 요청 deadline, 실패 후 다음 작업 진행, 지연 경보를 추가한다.
25초는 협력적인 작업 예산이지 강제 종료 시각이 아니므로 진행 중인 외부 요청의 시간까지
고려한다. `status:failed`도 HTTP 200으로 응답하므로 JSON 결과를 함께 관찰해야 한다.
DB 작업 잠금은 유지하고 작업 취소/재시도·종료 유예를 검증한다.

컨테이너의 메모리/CPU 제한과 로그 회전도 현재 없다. `json-file`의 max-size/max-file을
설정하거나 운영 플랫폼의 로그 제한을 사용하고, 백업은 같은 디스크 밖에 둔다.
[Compose 자원 설정](https://docs.docker.com/reference/compose-file/services/),
[Docker 로그 회전](https://docs.docker.com/engine/logging/drivers/json-file/).

배포 시점에는 공개 origin, TLS 프록시, OAuth callback, 관리자 계정·개별 비밀키,
GitHub/LLM 인증, DB 비공개 네트워크, 미디어 포함 백업을 확정한다. 로컬 compose의
`localhost:3200`, 공개 DB 포트 매핑, 기본 admin/cron 토큰을 운영값으로 그대로 사용하지 않는다.
읽은 설치본 Next.js self-hosting 가이드도 reverse proxy와 빌드/런타임 환경변수 구분을 안내한다.

## 배포 전 완료 기준과 이후 분리 기준

1. AI-01~04와 EV-01~03의 실제 반례 회귀 테스트를 추가하고 통과시킨다.
2. 기존 발행 데이터는 자동 삭제하지 않고 잘못 연결된 저장소·후원 페이지·12개 재심사 항목을
   검토 가능한 목록으로 만든다. 저장소 수정은 변경 이력과 근거를 남긴다.
3. AI 분류 인증과 공급자 읽기를 실제 1건으로 확인하고, source backfill을 제한 속도로 수행한다.
4. 동일 서버의 별도 웹/워커/DB 구성에서 실제 대표 작업 부하를 걸고 24시간 관측한다.
   proposed 기준: OOM/재시작 반복 0, 메모리 75% 이하 유지, 웹 p95 응답이 사전 합의한 목표
   (초기 제안 500ms, 서버 측 측정)을 만족, 미관측/오래된 출처와 큐 최장 대기가 감소할 것.
5. 프로세스 종료 후 재개·서버 재부팅·외부 요청 지연·인증 실패·백업 복원을 배포 대상에서 검증한다.

worker 부하와 웹 지연이 함께 오르거나 CPU가 지속 70% 이상, 메모리 압박/OOM, 목표 갱신
간격 초과가 반복되면 별도 워커 서버 또는 증설을 검토한다. 먼저 API 한도와 느린 외부 사이트를
분리 진단한다. 서버 추가로 해결되지 않는 한도 문제와 단순 계산 자원 부족을 구별한다.
위 임계치는 운영 시작용 제안이며 현재 성능 측정 결과로 주장하는 값이 아니다.

## 실행한 검증

- `npx vitest run tests/crawl-rules.test.ts tests/classify.test.ts tests/github-evidence.test.ts`
  — **3 files, 64 tests PASS**.
- `TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55435/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/crawl-seed.test.ts tests/integration/crawl-fetch.test.ts tests/integration/crawl-judge.test.ts tests/integration/crawl-publish.test.ts tests/integration/crawl-pipeline.test.ts tests/integration/crawl-review.test.ts`
  — **6 files, 76 tests PASS**, 전용 테스트 DB만 변경.
- AI 근거 없는 심사 입력의 통과를 실제 함수 호출로 재현. 앱 DB 수정 없음.
- 공개 검색 200 commits 및 공식 제품 사이트 원본 대조, 4,652개 원본 읽기 전용 재판정.
- Docker 24시간 로그 요약, 60초 6회 자원 표본, 재시작/자원/로그 정책 inspect.
- 전체 suite/빌드/서버 재부팅/최대 부하/유효 CLI 분류는 이번에 실행하지 않았다.
  기존 Vite native config 경고와 의도된 실패 분기 로그는 남았다.

분석 중 임시 로그 요약 스크립트의 괄호 오류가 한 번 발생해 수정 후 다시 실행했다.
판정 관련 테스트가 모두 통과한다는 사실은 현재 테스트가 새로 발견한 AI 근거 계약까지
검증한다는 뜻이 아니다. 이번 산출물은 수정 항목과 배포 설계 검토이며 서비스 코드는 그대로다.
