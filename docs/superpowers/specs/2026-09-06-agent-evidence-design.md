# GitHub 에이전트 근거 수집 설계 및 조사 보고

작성: 2026-09-06 KST. 상태: **조사·설계 완료, 구현·재수집·배포 전**.

## 1. 결론

공개 저장소에서 에이전트 문서와 설정 파일을 확인할 수 있다. 다만 확인 가능한 사실은
“이 커밋에 이 파일/설정/기여 표기가 존재한다”이다. 파일을 누가 생성했는지, 그 설정으로
실행했는지, 프로젝트 전체를 어떤 모델이 만들었는지는 별도의 근거가 필요하다.

현재 `builder` 하나에 도구·모델·검색어를 합쳐 저장하는 구조를 바꾸고, **실행 도구,
선언된 모델, API 연결 경로, 근거 종류**를 분리한다. AI 기능을 제공하는 제품과 AI를
개발에 활용한 제품도 별도로 취급한다. 아래는 공식 문서와 현재 코드의 대조 결과이며,
모든 공개 저장소를 전수 조사하거나 새 탐지기의 정확도를 실측한 결과는 아니다.

## 2. 요청한 다섯 계열

| 계열 | 공개 저장소에서 조사할 것 | 확정 가능한 표시와 제한 |
| --- | --- | --- |
| Grok / xAI | Grok Build의 `.grok/config.toml`, 공유 `AGENTS.md` 계열, 다른 클라이언트 설정의 명시적 Grok 모델 ID와 xAI endpoint | Grok 모델과 Grok Build 도구를 분리한다. 프로젝트 `.grok/config.toml`은 MCP·플러그인·권한 범위이고 사용자 전체 모델 설정과 다르다. 프로젝트 파일에 임의로 넣은 모델 키를 활성 모델로 인정하지 않는다. [설정](https://docs.x.ai/build/settings), [프로젝트 지침](https://docs.x.ai/build/features/project-rules) |
| Kimi / Moonshot | 기존 Kimi CLI의 `AGENTS.md`, `.kimi/AGENTS.md`; 새 Kimi Code 문서의 `.kimi-code/agents/**/*.md`; 공유 `.agents/agents/**/*.md`; 클라이언트에 명시된 Kimi 모델 | 기존 YAML `--agent-file`과 새 Markdown agent 형식을 버전별 규칙으로 분리한다. 사용자 홈 설정은 public repo에 없을 수 있다. Kimi CLI도 다른 provider/model을 설정할 수 있어 도구 이름으로 모델을 채우지 않는다. [기존 agent](https://moonshotai.github.io/kimi-cli/en/customization/agents.html), [새 agent](https://moonshotai.github.io/kimi-code/en/customization/agents), [provider](https://moonshotai.github.io/kimi-cli/en/configuration/providers.html) |
| GLM / Z.AI | Claude Code 등 클라이언트의 모델 설정, `ANTHROPIC_BASE_URL`의 알려진 Z.AI 주소, 역할별 `ANTHROPIC_DEFAULT_*_MODEL` | `CLAUDE.md`가 있어도 GLM일 수 있다. `client=claude-code`, `gateway=z-ai`, `declaredModelId=명시된 glm ID`로 각각 기록한다. endpoint만 있으면 정확한 모델은 미확인이다. 공식 예시는 사용자 홈 설정이므로 저장소에서 반드시 발견된다는 뜻은 아니다. [Z.AI의 Claude Code 연결](https://docs.z.ai/devpack/tool/claude) |
| DeepSeek | Claude Code 연결의 `https://api.deepseek.com/anthropic`, 에이전트별 명시 모델 설정 | 호환 API는 Claude 이름의 요청을 DeepSeek 모델로 매핑할 수 있다. 요청 alias와 실제 실행 모델을 같게 취급하지 않는다. 앱 소스의 DeepSeek SDK 호출은 서비스 기능의 단서일 뿐 개발 도구 사용 증거가 아니다. [공식 연결](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/) |
| OpenRouter | OpenCode의 `model`·`small_model`·agent별 모델, Codex provider 설정, Claude Code base URL, 다른 클라이언트의 gateway 지정 | OpenRouter는 연결·라우팅 계층이다. 모델 공급사와 실제 inference 사업자를 구분한다. `openrouter/auto`는 실행 응답 없이 최종 모델을 알 수 없고, 사용 가능 모델 목록도 실제 선택이 아니다. [OpenCode 연결](https://openrouter.ai/docs/cookbook/coding-agents/opencode-integration), [Claude 연결](https://openrouter.ai/docs/guides/coding-agents/claude-code-integration), [자동 라우터](https://openrouter.ai/docs/guides/routing/routers/auto-router) |

문서의 최신 기본 모델 이름을 모든 과거 저장소에 소급 적용하지 않는다. 규칙마다 문서 URL,
확인일, 지원 형식 버전을 보관한다. `GLM.md`, `DEEPSEEK.md`, `OPENROUTER.md` 같은 이름을
공통 공식 규격으로 만들어내지 않는다. 미등록 파일은 “모델 미확인”으로 남긴다.

## 3. 함께 지원할 클라이언트와 공유 형식

아래 경로는 **호환 문서/설정 존재 탐지 대상**이다. 한 파일만으로 실제 사용이나 모델을
확정하는 규칙이 아니다. 설정 파서는 각 도구가 허용하는 프로젝트 범위 키만 읽는다.

| 클라이언트/형식 | 탐지 범위 | 주의 및 공식 근거 |
| --- | --- | --- |
| Claude Code | `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/settings.json`, `.claude/rules/`, `.claude/agents/` | 다른 도구도 CLAUDE 형식을 읽거나 가져온다. 문서와 모델 설정을 별도 관측. [memory](https://code.claude.com/docs/en/memory), [settings](https://code.claude.com/docs/en/settings) |
| Codex | `AGENTS.override.md`, `AGENTS.md`, `.codex/config.toml` | AGENTS는 전용 형식이 아니다. config도 실행 시 trust·상위 설정·CLI에 영향받는다. [AGENTS](https://developers.openai.com/codex/guides/agents-md), [config](https://developers.openai.com/codex/config-basic) |
| Cursor | `.cursor/rules/*.mdc`, `.cursorrules`, 프로젝트 `AGENTS.md`·`CLAUDE.md` | 규칙 파일만으로 선택 모델을 알 수 없다. [rules](https://docs.cursor.com/context/rules-for-ai), [CLI](https://docs.cursor.com/en/cli/using) |
| Cline | `.clinerules/` 및 단일 `.clinerules` 호환 형식 | 전용 규칙과 다른 도구 호환 규칙을 구별한다. 모델은 대체로 IDE 설정에 있어 미공개 가능. [rules](https://docs.cline.bot/customization/cline-rules) |
| Roo Code | `.roo/rules/`, `.roo/rules-{mode}/`, `.roorules`, `.roorules-{mode}` | mode별 적용 범위 유지. 규칙·모드 이름으로 모델 추론 금지. [instructions](https://docs.roocode.com/features/custom-instructions) |
| OpenCode | `opencode.json`, `opencode.jsonc`, `.opencode/agents/`, `AGENTS.md` | `provider.models`는 선택 후보; `model`, `small_model`, agent 모델은 역할별 설정. [config](https://opencode.ai/docs/config/), [agents](https://opencode.ai/docs/agents) |
| Aider | `.aider.conf.yml`, `.aider.model.settings.yml` | 전자는 명시 `model`·`weak-model`·`editor-model` 등을 읽고 후자는 모델 정의로 구분한다. alias는 같은 설정 내 명시 매핑만 해석한다. [config](https://aider.chat/docs/config/aider_conf.html), [model settings](https://aider.chat/docs/config/adv-model-settings.html) |
| Continue | `.continue/rules/`; 명시적으로 연결된 공개 YAML 설정 | 기본 `~/.continue/config.yaml`은 사용자 홈이다. 저장소의 임의 `config.yaml`을 Continue 설정으로 보지 않는다. models 역할 목록도 실행 이력이 아니다. [rules](https://docs.continue.dev/customize/rules), [CLI config](https://docs.continue.dev/cli/configuration) |
| Gemini CLI | `GEMINI.md`, `.gemini/settings.json` | context 파일 이름 변경 가능. 사용자 홈이나 CLI override는 미관측. [context](https://geminicli.com/docs/cli/gemini-md/), [config](https://geminicli.com/docs/reference/configuration/) |
| Qwen Code | `QWEN.md`, `.qwen/settings.json` | 설정 버전·역할 구분. `codex` 본문 언급을 Codex 기여 표기로 오인하지 않는다. [config](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/) |
| GitHub Copilot | `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md`, 공유 `AGENTS.md`·`CLAUDE.md`·`GEMINI.md` | 사용 환경마다 읽는 형식이 다르다. 파일이나 bot 이름으로 기반 모델을 추정하지 않는다. [지원표](https://docs.github.com/en/copilot/reference/custom-instructions-support) |
| Windsurf / Devin Desktop | `.windsurf/rules/*.md`, `.windsurfrules`, `.devin/rules/*.md`, `AGENTS.md` | 현재 공식 문서는 `.devin` 우선·`.windsurf` fallback을 명시한다. 과거 흔적을 새 브랜드의 실행 이력으로 재명명하지 않는다. [공식 rules](https://docs.devin.ai/desktop/cascade/memories) |
| Goose | `.goosehints`; 명시적으로 연결된 공개 recipe 설정 | Goose 자체 저장소에도 하위 디렉터리 `.goosehints`가 있다. 파일 범위를 제품 전체로 확대하지 않는다. [공식 저장소 예](https://github.com/aaif-goose/goose/blob/main/ui/desktop/.goosehints), [provider 개요](https://block.github.io/goose/index.html) |
| Factory Droid | `.factory/droids/*.md`, 프로젝트 `.factory/settings.json` | Claude agent 가져오기와 `inherit`가 가능하다. 이름만으로 원래 모델·실행을 단정하지 않는다. [계층 설정](https://docs.factory.ai/enterprise/hierarchical-settings-and-org-control) |
| Kiro | `.kiro/steering/*.md`, `AGENTS.md` | 자동 생성·수동 작성 모두 가능; 커스텀 agent에는 명시적 resource 연결이 필요할 수 있다. [steering](https://kiro.dev/docs/steering/) |
| 공유 Agent Skills / MCP | `.agents/skills/**/SKILL.md`, `.agents/agents/`, 도구별 skills·MCP 설정 | 여러 도구가 공유한다. MCP 서버 존재는 개발 AI나 실행 모델 증거가 아니다. Kimi는 다른 브랜드 skill 디렉터리도 읽는다. [Kimi skills](https://moonshotai.github.io/kimi-cli/en/customization/skills.html), [Grok 호환성](https://docs.x.ai/build/features/skills-plugins-marketplaces) |

공식 경로가 없는 커스텀 에이전트·웹에서만 사용하는 도구·비공개 저장소·로컬 홈 설정만
쓰는 사례는 탐지 한계다. “없음”이 아니라 “공개 근거 미확인”으로 표시한다. 제품명과
문서 경로가 계속 바뀌므로 정적 목록만으로 모든 도구의 영구 완전 탐지를 약속하지 않는다.

## 4. 현재 코드에서 바꿔야 하는 지점

| 우선순위 | 현재 문제 | 수정 방향 |
| --- | --- | --- |
| P0 | `lib/crawl/settings-schema.ts` 기본 검색이 Claude/Codex 공동 기여와 vibe-coding topic 중심 | 검색은 후보 발견용으로만 사용. 파일 검사와 원문 trailer 검증을 별도 단계로 추가 |
| P0 | `lib/crawl/github.ts`·`jobs/seed.ts`가 commit SHA·본문·URL을 버리고 검색 라벨의 builder를 저장 | 검색 근거를 보존하고 실제 trailer에서 이름을 판별. 본문 언급·코드 블록 제외 |
| P0 | `lib/crawl/repository.ts` frontier 충돌 시 새 신호가 사라짐 | 저장소별 다중 관측 append/upsert. 검색 순서에 따라 이름이 바뀌지 않도록 함 |
| P0 | `lib/crawl/rules.ts`에는 AI 개발 근거 입력 자체가 없음 | 제품 적합성, 저장소 관계, AI 개발 근거를 각각 판정하고 사유 코드 저장 |
| P0 | `lib/crawl/publish.ts`·기본 등록/수정은 repoUrl만 쓰고 evidence 링크 연결이 빠짐 | 신규 등록 트랜잭션에 동기화, 기존 제품은 보존 규칙을 적용해 backfill |
| P0 | source 수집 성공과 링크 배지·최신성 표시가 불일치 | 수집 성공·공식 관계·정보 나이를 각각 표시하는 공통 view 생성 |
| P1 | `product_agents`는 maker 신고/기존 provenance 용도; provider/client/model만으로 새 근거 구분 불가 | 자동 관측 테이블을 추가하고 maker 데이터와 합성해서 읽음 |
| P1 | 긴 검색 창·1000건 상한·incomplete 응답으로 수집 누락 가능 | 날짜 구간 cursor와 불완전 상태를 보존하고 범위를 나눠 재개 |
| P1 | 기존 Docker 스케줄러의 evidence 실행 간격 때문에 backlog 해소가 느림 | 기존 잡 runner의 lease/cursor를 활용한 별도 개발 근거 잡, due 시각 기준 재개 |

`replaceProductProvenance`를 재확인했다. maker 권한은 **maker_reported 행만** 교체하고,
system 권한은 해당 제품의 모든 agent/skill 행을 교체할 수 있다. 자동 파일 스캔을 이
system replace 경로에 연결하지 않는다.

같은 세션의 앞선 실측에서 localhost:3000 DB에는 repoUrl이 있는 제품 32개와 evidence
링크 0개가 있었다. 별도 localhost:3200 Docker DB에도 링크 누락이 컸다. 현재 계획은
그 원인을 다루며, 앞선 스냅샷을 현재 운영 서버 실측이라고 부르지 않는다. 세부 근거는
[수집 감사](../../reviews/2026-09-06-crawler-evidence-audit.md)와
[판정·배포 감사](../../reviews/2026-09-06-ai-crawler-deployment-review.md)에 있다.

## 5. 권장 설계와 대안

| 방식 | 장점 | 문제 | 선택 |
| --- | --- | --- | --- |
| 파일명 → builder 단일 매핑 | 구현이 작음 | 공유 형식, provider 교체, 예제·복제에 취약 | 제외 |
| README·설정 전체를 LLM에 보내 추정 | 자유 텍스트 대응 | 실행 증거를 만들어낼 수 없고 비용·재현성·민감 정보 문제가 생김 | 1차 범위에서 제외 |
| 버전 있는 규칙 + 허용 키 파싱 + 근거별 공개 | 원문 위치로 설명 가능, 실패·미확인 구분 가능 | 초기 규칙/fixture 작성 필요 | **권장** |

### 5.1 수집과 데이터

흐름: 검색 → repository 메타/고정 commit SHA → 허용 경로 tree/blob 검사 → 정규화 관측
저장 → 제품과 저장소 관계 검사 → 판정 → 발행/근거 화면. 발행된 제품도 같은 수집 함수를
재사용한다. 전체 저장소 clone이나 도구 실행은 필요 없다.

신규 저장소 식별은 GitHub numeric repository ID를 사용한다. 기존 owner/name 키는 즉시
전면 교체하지 않고 alias 매핑으로 연결한다. scan은 repo ID + commit SHA + detectorVersion
+ scanScope로 식별한다. 파일 근거는 path + blob SHA + rule ID + keyPath + 역할별로 구분한다.
commit 표기는 commit SHA + trailer 종류 + 정규화된 attribution으로 중복 제거한다.

자동 관측은 maker provenance와 별도 보관한다. 주요 필드:

```ts
type EvidenceKind = 'instruction_file' | 'client_config' | 'model_config'
  | 'commit_attribution' | 'declared_usage';
type ScanState = 'pending' | 'complete' | 'partial' | 'failed';
type AgentObservation = {
  kind: EvidenceKind;
  client: string | null;            // 이 형식이 대상으로 하는 클라이언트
  compatibleClients: string[];      // 공유 파일은 단일 client로 단정하지 않음
  modelDeveloper: string | null;    // 명시 모델 ID에서 식별되는 개발사
  declaredModelId: string | null;   // alias/namespace 포함, 실제 실행 모델 아님
  gateway: string | null;           // openrouter, z-ai, deepseek-direct 등
  routing: 'fixed' | 'auto' | 'fallback' | 'unknown';
  role: string | null;              // main, small, sonnet, reviewer 등
  scope: string;                   // repo 내 적용 하위 경로
  keyPath: string | null;
  ruleId: string;
  sourcePath: string | null;
  commitSha: string;
  blobSha: string | null;
  sourceUrl: string;               // collector가 GitHub ID/SHA/path로 생성
};
```

이 타입에는 실제 실행 모델 필드를 넣지 않는다. 기존 `nomorevibe_recorded`와
`signed_build`는 기존 수집·검증 경로가 증명한 범위에서만 사용한다. GitHub가 커밋 서명을
verified라고 표시해도 LLM 실행이나 전체 AI 제작을 증명하지 않는다.

repo별 scan은 현재 commit과 과거 근거를 구분한다. complete scan에서 사라진 경로는
“과거 확인”으로 바꾸고, partial·timeout·403에서 기존 근거를 삭제하지 않는다. 제품 연결은
product ID/generation과 link ID로 관리하여 삭제 후 같은 slug가 재등록돼도 과거 응답이
새 제품에 붙지 않게 한다. 숨긴/삭제한 maker 링크를 backfill로 부활시키지 않는다.

### 5.2 해석 규칙

1. `AGENTS.md`만 있으면 공유 지침 확인, client/model 미확인. `CLAUDE.md`는 Claude 호환
   문서 확인이지 Anthropic 모델 사용 확정이 아니다.
2. `.claude/settings.json`의 명시 모델과 알려진 base URL을 각각 읽는다. 역할별 모델은
   별도 행. `${MODEL}`·`inherit`·`default`·`auto`는 임의 해석하지 않는다.
3. OpenCode의 provider.models 카탈로그는 model_config로 승격하지 않는다. 선택된
   model/agent 항목만 모델 설정으로 기록한다. main과 제목 생성용 small 역할을 구분한다.
4. 알려진 endpoint hostname/path는 URL 파서와 정확한 allowlist로 비교한다.
   `api.z.ai.attacker.example`, URL userinfo, redirect, 임의 proxy는 Z.AI 직접 연결로 판정하지 않는다.
   사용자 설정의 endpoint를 네트워크로 호출하지 않는다.
5. JSON/JSONC/TOML/YAML은 데이터로 파싱한다. 모델 ID 허용 문자·길이를 제한하고 API key,
   auth token, header 값, `.env`, 인증 파일, 대화 로그, shell history, 원문 prompt는 저장·출력하지 않는다.
   parser 예외 메시지에 원문 조각도 남기지 않는다. YAML tag/alias 확장·원격 include·환경변수 치환 금지.
6. 기본 root와 알려진 agent 디렉터리를 우선 검사한다. subproject는 실제 제품 경로가
   연결된 경우만 제품 근거로 승격한다. `examples/`, `fixtures/`, `vendor/`, template 사본은
   관측 위치를 보존하되 해당 서비스의 사용 근거에서 제외한다. 중첩 지침만으로 repo 전체를 판정하지 않는다.
7. GitHub tree의 type/mode를 확인한다. TradingGoose의 `.codex`는 앞선 직접 조회에서
   **디렉터리가 아닌 파일**이었다. `.codex/config.toml`이 존재하는 것처럼 취급하지 않는다.
   symlink/submodule은 존재 유형만 기록하고 자동 추적하지 않는다.
8. 커밋은 검색 match가 아니라 실제 마지막 trailer 블록을 파싱한다. `Co-authored-by`는
   “커밋에 기여자로 표기”이며 위조 불가능한 실행 로그가 아니다. merge로 물려온 기록,
   upstream 복제, 봇 일반 커밋을 현재 제품의 AI 제작 증거로 자동 승격하지 않는다.
9. README의 “built with X”는 저장소 작성자 주장으로만 기록한다. dependency/runtime SDK는
   별도 `runtime_ai_signal` 후보 정보다. 개발 근거 점수와 섞지 않는다.

### 5.3 판정 정책

현재 서비스의 AI 제작/바이브 코딩 취지를 기준으로 권장하는 초기 정책이다.

| 입력 | 결과 |
| --- | --- |
| 제품 기본 조건 통과 + 동일 제품의 저장소 관계 확인 + 유효한 전용 설정 또는 귀속 가능한 기여 표기 | 자동 등록 가능, 근거 수준은 “설정 확인/기여 표기 확인” 유지 |
| 공유 AGENTS만 존재 / README 주장만 존재 / 예제·복제 여부 불명확 | needs_review, `ai_evidence_insufficient` |
| scan 미완료·rate limit·통신 실패 | needs_review, `ai_evidence_pending`; 재시도 |
| 제품 사이트가 다른 canonical repo를 가리킴 | needs_review, `repository_relationship_conflict` |
| scan 완료했지만 개발 근거 없음 | needs_review, `ai_evidence_not_found`; “비AI 확정” 아님 |
| 앱에서 LLM API만 호출 | AI 기능 신호 별도 보관; AI 제작 자동 등록 조건 충족하지 않음 |

전용 설정도 사용 사실 자체를 입증하지 않으므로 “AI 제작 검증 완료”라는 배지를 만들지
않는다. 관리자 승인에는 판단 사유와 actor/version을 남긴다. 기존 공개 제품은 새 정책을
shadow 평가하고 수정 대상 목록을 만든다. 조사만으로 일괄 삭제하거나 maker 신고를 덮지 않는다.
빈 설정이나 MCP 서버 목록만 있는 파일은 위의 유효한 개발 설정 조건에 포함하지 않는다.

### 5.4 API 예산과 실패 처리

제안 시작값: 동시 요청 2개, 요청 8초 timeout, repo tick 20초/12요청, 최대 파일 32개,
파일당 64KiB·총 본문 512KiB, source facts 요약은 기존 64KiB 제한 유지. 디렉터리/파일
cursor를 저장해서 다음 tick에 이어간다. 32개 상한에 닿으면 partial이며 전수 없음 판정 금지.
허용 범위 밖 파일을 읽지 않고 GitHub API를 통해서만 blob을 가져온다.

recursive tree가 truncated이거나 기존 HTTP body 제한을 넘으면 root와 알려진 디렉터리
tree를 단계적으로 조회한다. GitHub도 recursive tree 제한과 truncated 응답을 명시한다.
[Git Trees API](https://docs.github.com/en/rest/git/trees#get-a-tree)

변하지 않은 commit+규칙 버전+scope는 blob 재수집 생략, repo SHA는 하루 1회 재확인한다.
새 후보/실패 복구는 별도 due 시간으로 처리한다. rate limit remaining/reset 및 Retry-After를
존중하고 deadline 전 cursor 저장. GitHub 검색 incomplete/페이지 상한은 기록하고 날짜
구간을 분할한다. 구간을 최소 단위로 쪼개도 넘치면 partial coverage로 남긴다.

현재 1,000개 수준에서 신규 scan이 repo당 평균 4~10 API 요청이라고 **가정**하면 초기
4,000~10,000회다. 이는 실측이 아니고 rate limit·다른 잡과 공유하는 예산에 따라 며칠로
분산될 수 있다. AI 추론을 실행하지 않는 수집이므로 GPU는 필요 없다. 기존 권장 구성인
동일 호스트 내 web/worker 별도 프로세스·컨테이너, 4vCPU/8GB 출발안과 양립한다.
원문 전체 LLM 분석이나 대규모 브라우저 크롤링을 추가하면 다시 측정해야 한다.

### 5.5 화면

예: `Claude Code 설정 확인 · GLM 모델 설정 · Z.AI 연결 설정`을 각각 보여주고,
“설정 파일 기준 · 실제 실행 기록 미확인 · 2026-09-06 확인 · 원문 보기”를 함께 표시한다.
`CLAUDE.md`만 있으면 “Claude 호환 지침 파일 확인”, `AGENTS.md`만 있으면
“공유 에이전트 지침 파일 확인”이다. OpenRouter auto는 “자동 모델 선택 설정”으로 표시한다.

기존 builder의 근거 없는 추정은 새 공개 근거와 같은 verified 스타일로 보이지 않게 한다.
maker 신고는 별도 유지한다. 사용 중인 도구 여러 개를 하나로 압축하지 않는다. repo의 별,
라이선스, 릴리스 등 객관적 사실은 기존 GitHub source에서 계속 제공하고, 관계 확인 상태와
마지막 성공 시각을 일관되게 보여준다. 오래된 health 체크는 “현재 온라인”으로 표시하지 않는다.

## 6. 검증 및 출시 순서

1. 형식별 fixture와 잘못된 귀속 사례의 회귀 테스트 → 저장/수집 → 판정 연결 → UI.
2. 기존 링크 누락 복구 dry-run과 shadow 재판정 결과를 JSON으로 저장한다.
3. 명명된 다섯 계열, 공유 파일, 설정 미공개, runtime-only, 사본, monorepo를 포함한
   실제 public repo 50개를 사람이 라벨링한다. 합성 fixture 통과를 실제 정확도로 보고하지 않는다.
4. 실제 표본의 각 공개 배지는 commit/path/key를 역추적할 수 있어야 한다. 모델 미확인
   사례를 임의 채운 사례 0건, 키/원문 prompt 저장 0건, 숨긴 링크 부활 0건을 출시 기준으로 삼는다.
5. 통합/E2E/빌드와 별도 worker 재시작·cursor 복구·backlog 소진 측정 후 단계적으로 적용한다.

이번 단계에서는 문서 조사와 코드 읽기만 수행했다. 새 탐지기 테스트·마이그레이션·backfill·
배포를 실행하지 않았다. 앞선 테스트 결과는 이전 감사 문서의 실행 기록이며 이번 설계의
구현 검증 결과가 아니다.

## 7. 설계 자체 검토

- 명명된 5계열은 모두 탐지 경로와 한계, provider/model/client 혼합 예외를 포함했다.
- 공유 파일, 전역 설정 부재, 삭제/실패, 공급자 proxy, 역할별 모델, template/monorepo,
  secret, GitHub pagination, maker 보존을 명시했다.
- Grok 프로젝트 설정 범위를 사용자 전체 config로 오해하지 않도록 수정했다.
- Kimi 구/신 문서와 Windsurf/Devin 경로 변경을 하나의 영구 규칙으로 합치지 않았다.
- 실행 계획은 [구현 계획](../plans/2026-09-06-agent-evidence-implementation.md)에서 파일·시험·순서를 정의한다.
