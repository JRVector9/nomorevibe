# GitHub Agent Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 공개 GitHub 근거로 개발 에이전트의 문서·설정·기여 표기를 수집하고, 모델과 도구의 오귀속 및 근거 누락을 줄인다.

**Architecture:** 버전 있는 결정적 파서가 고정 commit의 허용 파일만 검사한다. 자동 관측은 maker 신고와 분리하고, 기존 잡 runner와 제품 generation 잠금을 재사용한다. 등록 적합성과 공개 배지는 같은 근거 요약을 읽되, 설정을 실제 실행 증거로 승격하지 않는다.

**Tech Stack:** 현재 Next.js 16.3.1 / TypeScript / PostgreSQL / Drizzle / Vitest / Playwright. JSONC·TOML·YAML의 데이터 전용 파서 추가.

---

작성: 2026-09-06 KST. 후속 사용자 요청으로 병렬 구현·리뷰·재수집을 실행했다.
아래는 원래 계획이며, 실행 결과와 계획 대비 차이는 `../../reviews/2026-09-06-agent-implementation-result.md`와
`../../CODEX_HANDOFF.md`에 기록한다. 원래의 세부 커밋/50건 검증 항목은 실행한 것으로 간주하지 않는다.

설계/공식 출처/전체 도구 목록: [설계 보고](../specs/2026-09-06-agent-evidence-design.md).
인프라 별도 검토: [배포 감사](../../reviews/2026-09-06-ai-crawler-deployment-review.md).

## 적용 순서와 범위

- 1차 P0: 검색 라벨의 제작자 고정 차단, 파일 탐지와 근거 저장, 링크 연결, 판정/화면 연결.
- 2차 P1: 기존 제품 재수집·수정 목록, 검색 범위 확장, 운영 처리량과 복구 검증.
- 서버 이전·서명 실행 증명·대화 로그 수집·LLM 전문 분석은 이 계획에서 구현하지 않는다.
- 기존 제품 자동 삭제, maker 데이터 덮어쓰기, 순위 변경도 하지 않는다.

## Task 0: 실행 기준과 격리

**Read:** `AGENTS.md`, `docs/CODEX_HANDOFF.md`, `tests/integration/setup.ts`,
`node_modules/next/dist/docs/01-app/02-guides/self-hosting.md`, 해당 UI 수정 관련 설치된 Next 문서.

- [ ] `git status --short`로 기존 문서 변경을 보존한다. 현재 기준 commit은 `be4aee0`이며 실행 시 다시 확인한다.
- [ ] 아래 명령으로 전용 테스트 DB 기준과 migration 경로를 확인한다. 55434/55437 앱 DB에서 integration을 실행하지 않는다.

```sh
git rev-parse HEAD
cat tests/integration/setup.ts
cat drizzle.config.ts
cat scripts/migrate.mjs
```

- [ ] 단위 테스트 RED→구현→해당 GREEN 후 각 Task 단위로 검토·커밋한다. 이 문서에 적힌
  예상 PASS를 실행 결과로 보고하지 않는다. task 완료 시 실제 결과를 handoff에 적는다.

## Task 1: 공통 타입과 근거 수준

**Create:** `lib/domain/evidence/agents/types.ts`, `lib/domain/evidence/agents/summary.ts`.
**Test:** `tests/agent-evidence-summary.test.ts`.

- [ ] 다음 사례를 테스트로 추가한다. `AgentObservation`은 설계 5.1 타입 그대로 사용하고,
  테스트 데이터는 아래 입력을 충족하는 literal로 작성한다.

```ts
import { expect, it } from 'vitest';
import { summarizeAgentEvidence } from '@/lib/domain/evidence/agents/summary';

it('does not promote a shared instruction file into model use', () => {
  const result = summarizeAgentEvidence({
    scanState: 'complete',
    relationship: 'same_product',
    observations: [{
      kind: 'instruction_file', client: null,
      compatibleClients: ['codex', 'kimi', 'grok-build'],
      modelDeveloper: null, declaredModelId: null, gateway: null,
      routing: 'unknown', role: null, scope: '', keyPath: null,
      ruleId: 'shared.agents.v1', sourcePath: 'AGENTS.md',
      commitSha: 'a'.repeat(40), blobSha: 'b'.repeat(40),
      sourceUrl: 'https://github.com/acme/app/blob/' + 'a'.repeat(40) + '/AGENTS.md',
    }],
  });
  expect(result).toMatchObject({
    eligible: false, reason: 'ai_evidence_insufficient', executionVerified: false,
  });
});
```

- [ ] `npx vitest run tests/agent-evidence-summary.test.ts`로 미구현 FAIL을 확인한다.
- [ ] 설계 타입을 추가하고 다음 계약으로 summary를 구현한다.

```ts
type SummaryInput = {
  scanState: 'pending' | 'complete' | 'partial' | 'failed';
  relationship: 'same_product' | 'unknown' | 'conflict';
  observations: AgentObservation[];
};
type AgentEvidenceSummary = {
  eligible: boolean;
  reason: 'ai_evidence_pending' | 'ai_evidence_insufficient'
    | 'ai_evidence_not_found' | 'repository_relationship_conflict'
    | 'ai_evidence_supported';
  executionVerified: false;
};
// 순서: conflict → incomplete → relationship unknown → 유효 전용 설정/기여 → 부족/미발견.
// observations는 이미 현재 제품 scope·원본 귀속 검사를 통과한 행만 전달한다.
// 빈 설정/MCP-only 설정은 eligible 입력에서 제외하고 파일 관측으로만 보존한다.
export function summarizeAgentEvidence(input: SummaryInput): AgentEvidenceSummary;
```

- [ ] 전용 설정, runtime-only 빈 관측, conflict, partial, attribution 사례도 literal 입력으로
  추가하여 같은 명령 GREEN을 확인한다. 타입/summary/test만 커밋한다.

## Task 2: 경로 카탈로그와 파일 종류

**Create:** `lib/domain/evidence/agents/catalog.ts`, `tests/agent-evidence-catalog.test.ts`.

- [ ] 아래 표를 `it.each`의 입력/예상값으로 작성한다.

```ts
// path, Git mode, 예상 분류
[
  ['AGENTS.md', '100644', 'shared_instruction'],
  ['.claude/settings.json', '100644', 'client_config'],
  ['.codex', '100644', 'unsupported'],
  ['.codex/config.toml', '100644', 'client_config'],
  ['.grok/config.toml', '100644', 'client_config'],
  ['.kimi-code/agents/reviewer.md', '100644', 'agent_definition'],
  ['.agents/agents/reviewer.md', '100644', 'shared_instruction'],
  ['fixtures/CLAUDE.md', '100644', 'example_only'],
  ['CLAUDE.md', '120000', 'symlink'],
  ['.claude', '160000', 'submodule'],
]
```

- [ ] `npx vitest run tests/agent-evidence-catalog.test.ts`로 RED를 확인한다.
- [ ] 다음 선언형 규칙을 추가한다. 설계 표의 모든 클라이언트와 문서에 명시된 구형 경로를
  개별 규칙으로 등록한다. Git의 실제 대소문자와 경로를 보존하고 유사 이름을 확정 판정하지 않는다.

```ts
type ArtifactRule = {
  id: string;
  version: number;
  docsUrl: string;
  checkedOn: '2026-09-06';
  pathPattern: string;
  compatibleClients: string[];
  format: 'markdown' | 'json' | 'jsonc' | 'toml' | 'yaml';
  scope: 'project' | 'shared' | 'explicit_reference';
};
```

- [ ] 설계 표의 각 행에 정상 입력과 예제/공유 파일 반례를 한 쌍 이상 추가한다.
  `npx vitest run tests/agent-evidence-catalog.test.ts` GREEN 후 커밋한다.

## Task 3: 설정 파서와 다섯 계열의 모델·연결 경로 분리

**Create:** `lib/domain/evidence/agents/parse.ts`, `lib/domain/evidence/agents/model-routing.ts`,
`tests/agent-evidence-parse.test.ts`, `tests/fixtures/agent-evidence/`.
**Modify:** `package.json`, `package-lock.json`.

- [ ] 다음 입력과 기대값을 회귀 fixture로 만든다. 모델 ID는 테스트에 명시된 값이며
  최신 모델 목록이나 실제 운영 상태를 뜻하지 않는다.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-4.7",
    "ANTHROPIC_AUTH_TOKEN": "DO_NOT_PERSIST_SECRET"
  }
}
```

```ts
// .claude/settings.json의 위 fixture:
expect(observations).toEqual(expect.arrayContaining([
  expect.objectContaining({kind: 'model_config', client: 'claude-code',
    gateway: 'z-ai', declaredModelId: 'glm-4.7', role: 'sonnet'}),
]));
expect(JSON.stringify(observations)).not.toContain('DO_NOT_PERSIST_SECRET');
```

- [ ] `npx vitest run tests/agent-evidence-parse.test.ts` RED를 확인한다.
- [ ] 구현 시 package metadata/공식 문서에서 `jsonc-parser`, `smol-toml`, `yaml`의 Node
  호환 버전을 확인하고 lockfile에 고정한다. 일반 JSON은 JSON.parse로 처리한다.
  eval, import 실행, shell/source, 정규식으로 JSON 흉내 내기를 금지한다.
  YAML은 custom tag와 alias 확장을 금지하고 미지원 구조는 unsupported로 반환한다.
- [ ] 다음 계약으로 파서를 구현한다. 근거 URL은 전달받은 repository identity와 SHA/path로
  구성하고, content에 들어 있는 임의 URL을 사용하지 않는다.

```ts
type ParseArtifactInput = {
  rule: ArtifactRule; path: string; content: string;
  repository: { owner: string; name: string };
  commitSha: string; blobSha: string;
};
type ParseArtifactResult = {
  observations: AgentObservation[];
  status: 'ok' | 'unsupported' | 'invalid';
};
export function parseAgentArtifact(input: ParseArtifactInput): ParseArtifactResult;
```

- [ ] 다음 회귀 표를 모두 구현한다. API key, header, env 전체는 출력하지 않는다.

| 사례 | 기대 결과 |
| --- | --- |
| CLAUDE.md만 존재 | instruction_file, model=null |
| AGENTS만 존재 | client=null, 공유 형식 |
| Claude config + Z.AI + GLM 명시 | 도구·모델·gateway 분리 |
| Claude config + DeepSeek endpoint + Claude alias | 선언 alias 보존, 실행 모델 미확인 |
| OpenCode + `model: openrouter/x-ai/grok-code-fast-1` | client=opencode, gateway=openrouter, 명시된 Grok 모델 |
| OpenCode provider.models만 존재 | model_config 생성하지 않음 |
| OpenCode `model: openrouter/openrouter/auto` | routing=auto, modelDeveloper=null |
| Kimi 공유 AGENTS + 다른 provider 설정 | 공유 문서로 Moonshot 모델을 보충하지 않음 |
| Grok project config에 사용자 범위 model 키 | 파일 존재만 기록, model_config로 승격하지 않음 |
| Codex custom provider + env 참조 모델 | provider 설정만 확인, 모델 미해결 |
| Aider alias/weak/editor, Factory inherit | 명시된 역할 보존, inherit 미해결 |
| 여러 모델, 구/신 형식 충돌 | 모든 관측과 scope 보존, 하나로 덮어쓰지 않음 |
| 가짜 Z.AI hostname, 로컬 proxy | 알려진 gateway로 판정하거나 접속하지 않음 |
| YAML alias, 거대 문자열, 잘못된 JSON, secret 혼입 | 오류 종류만 기록, 원문 비출력 |
| runtime SDK, README 예제, `.env` | 개발 model_config로 판정하지 않음 |

- [ ] 같은 단위 명령으로 GREEN을 확인하고 파서와 fixture를 커밋한다.

## Task 4: 관측을 보존하는 추가 스키마

**Create:** `lib/db/agent-evidence-schema.ts`, `lib/domain/evidence/agents/repository.ts`,
`tests/integration/agent-evidence-repository.test.ts`.
**Modify:** `lib/db/schema.ts`, `tests/integration/setup.ts`, `lib/domain/products/repository.ts`.
**Generate:** `drizzle/0019_agent_evidence.sql`과 Drizzle metadata. 구현 시 0019가 이미
사용 중이면 generator의 다음 번호를 사용하며 기존 이력을 덮어쓰지 않는다.

- [ ] 동일 관측 중복 저장, 여러 모델 저장, maker provenance 보존을 DB 테스트에 추가한다.
  RED command:
  `npx vitest run --config vitest.integration.config.ts tests/integration/agent-evidence-repository.test.ts`。
- [ ] 다음 세 테이블을 Drizzle로 정의하고 `schema.ts`에서 export한다.

```text
agent_repository_scans:
  id serial PK, github_repository_id bigint, repository_key varchar(200),
  commit_sha varchar(64), detector_version varchar(40), scope text, scope_hash varchar(64),
  state varchar(16), cursor jsonb, request_count integer, file_count integer,
  coverage jsonb, started_at timestamp, completed_at timestamp,
  last_error_code varchar(60), next_attempt_at timestamp
  UNIQUE(github_repository_id, commit_sha, detector_version, scope_hash)
  INDEX(state, next_attempt_at)

agent_repository_observations:
  id serial PK, scan_id FK ON DELETE CASCADE,
  observation_key varchar(64), facts jsonb,
  observed_at timestamp
  UNIQUE(scan_id, observation_key)

crawl_discovery_evidence:
  id serial PK, repository_key varchar(200), signal_id varchar(80),
  evidence_key varchar(64), source_url text, commit_sha varchar(64),
  attribution jsonb, search_window_from timestamp, search_window_to timestamp,
  incomplete boolean, observed_at timestamp
  UNIQUE(repository_key, evidence_key)
```

- [ ] `observation_key`는 kind/path/blob/commit/rule/keyPath/role/normalized value의
  안정된 JSON 직렬화에 대한 SHA-256이다. AgentObservation schema를 검증하여 저장한다.
  동일 키는 no-op이고 새 근거는 추가한다.
- [ ] scope_hash는 정규화된 scope의 SHA-256이며 긴 경로를 unique index에 직접 넣지 않는다.
  facts 본문은 64KiB 이하로 검증한다. source의 scan 참조가 유효한지 transaction에서 확인한다.
- [ ] 제품 연결은 기존 `product_evidence_sources`의 normalizedFacts에 `agentScanId`와
  `agentDetectorVersion`을 추가해 관리한다. source 갱신은 `withProductGeneration`에서
  수행하며 product_agents의 system replace를 호출하지 않는다. 제품 삭제 시 repo 공통
  scan은 유지하고 제품 source 삭제로 공개 참조만 끊는다.
- [ ] `npx drizzle-kit generate --name agent_evidence`로 migration을 생성하고 전용 테스트
  DB의 integration setup에서 적용한다. cleanup 순서를 FK에 맞춘다.
- [ ] 위 integration과 기존 `tests/integration/product-provenance.test.ts`,
  `tests/integration/product-evidence-lifecycle.test.ts`의 GREEN을 실측 후 커밋한다.

## Task 5: 고정 commit의 GitHub 수집

**Create:** `lib/domain/evidence/agents/collect.ts`, `tests/agent-evidence-collect.test.ts`.
**Modify:** `lib/crawl/github.ts`.

- [ ] mocked GitHub의 branch 변경, truncated tree, symlink, 403 네 사례를 RED로 만든다.
  명령: `npx vitest run tests/agent-evidence-collect.test.ts`.
- [ ] repository 메타 → branch commit → tree/blob 순으로 SHA를 고정한다.
  기존 githubRequest의 token/timeout/body 제한을 공유하고 다음 계약을 사용한다.

```ts
type CollectCursor = {
  repositoryId: string; repositoryKey: string;
  commitSha: string; detectorVersion: string; scope: string;
  pendingTrees: Array<{path: string; sha: string}>;
  pendingBlobs: Array<{path: string; sha: string; size: number; ruleId: string}>;
};
type CollectResult = {
  state: 'complete' | 'partial' | 'failed';
  cursor: CollectCursor | null;
  observations: AgentObservation[];
  requestCount: number;
  errorCode: 'rate_limited' | 'timeout' | 'unavailable' | 'invalid' | null;
};
```

- [ ] 설계 5.4의 상한을 상수로 정의한다. 예산 종료 전 cursor를 저장한다. SHA가 같아도
  규칙 version/scope가 바뀌면 재분석한다. 부분 tree에서 파일 부재를 확정하지 않는다.
- [ ] 다음 assertion을 추가해 GREEN을 확인한다.

```ts
expect(result.state).toBe('partial'); // tree 잘림 또는 수집 상한 도달
expect(result.cursor?.commitSha).toBe(originalSha); // branch가 바뀌어도 고정 SHA 유지
expect(requestedHosts.every(host => host === 'api.github.com')).toBe(true);
expect(requestedPaths.some(path => path.includes('/.env'))).toBe(false);
```

- [ ] 실패 후에도 이전 complete 관측이 남는 DB 통합 사례를 추가하고 커밋한다.

## Task 6: 검색 라벨 고정을 제거하고 실제 trailer 보존

**Create:** `lib/domain/evidence/agents/commit-attribution.ts`, `tests/commit-attribution.test.ts`.
**Modify:** `lib/crawl/github.ts`, `lib/crawl/jobs/seed.ts`, `lib/crawl/repository.ts`,
`tests/integration/crawl-seed.test.ts`.

- [ ] 다음을 RED 회귀 테스트로 만든다.

```ts
expect(parseCommitAttributions(
  'fix codex: preserve permissions\n\nCo-authored-by: Qwen-Coder <qwen@example.com>'
)).not.toEqual(expect.arrayContaining([expect.objectContaining({client: 'codex'})]));
// parseCommitAttributions(message) -> Array<{client: string|null; label: string}>
// 이메일 원문은 저장하지 않고 마지막 trailer의 표시 이름만 정규화한다.
```

- [ ] `npx vitest run tests/commit-attribution.test.ts` RED 후 마지막 trailer 블록을
  파싱한다. 코드 블록·인용·본문은 제외한다. Codex/OpenAI Codex 등 별칭은 규칙 표에
  명시하고 애매한 이름은 미확인으로 둔다. bot 작성자만으로 실행을 증명하지 않는다.
- [ ] CommitSearchResult에 sha/message/html_url, incomplete_results/total_count를 추가한다.
  frontier의 기존 signal/builder는 이력 호환용으로 남기고 새 확정값을 넣지 않는다.
  signal.builder는 discovery evidence의 발견 힌트로만 저장한다.
- [ ] 같은 repo에 Claude/Qwen/Grok이 다른 순서로 도착하는 integration을 추가한다.
  `crawl.enqueue`가 ON CONFLICT DO NOTHING이어도 discovery evidence는 별도 upsert한다.
- [ ] unit과 `npx vitest run --config vitest.integration.config.ts tests/integration/crawl-seed.test.ts`
  GREEN 후 커밋한다. legacy builder fallback의 재노출은 Task 9에서도 검증한다.

## Task 7: repoUrl과 evidence 연결 누락 복구

**Create:** `lib/domain/evidence/repository-link-sync.ts`,
`tests/integration/repository-link-sync.test.ts`.
**Modify:** `lib/domain/products/repository.ts`, `lib/domain/products/register.ts`,
`lib/domain/products/manage.ts`, `lib/crawl/publish.ts`, `lib/domain/evidence/repository.ts`.

- [ ] 신규 등록·crawler 발행·repo 수정 시 대응 link가 생성/갱신되는 테스트를 RED로 만든다.
  동일 정규화 키, maker 비공개/삭제, product generation 변경, 다른 repo 링크 공존을 포함한다.
- [ ] 제품 insert/update와 같은 DB transaction에 링크 동기화를 넣는다. crawler는
  declarationSource=discovered, maker의 repo_url 입력은 maker로 보존한다.
  source 수집 성공만으로 공식 저장소 관계를 확정하지 않는다.
- [ ] backfill은 기존 이력으로 maker 삭제 의도를 확인한다. 이력이 불충분하면 자동 공개하지
  않고 `review_required`로 분류한다. 이후 삭제는 link tombstone을 유지하도록 만들고
  필요한 migration을 추가한다. 의도가 불명확한 기존 행을 자동 재생성하지 않는다.
- [ ] 동기화 결과는 다음 타입으로 반환한다.

```ts
type RepositoryLinkSyncResult = {
  action: 'created' | 'updated' | 'unchanged' | 'preserved_hidden' | 'review_required';
  linkId: number | null;
};
```

- [ ] `npx vitest run --config vitest.integration.config.ts tests/integration/repository-link-sync.test.ts tests/integration/crawl-publish.test.ts tests/integration/product-evidence-lifecycle.test.ts`
  GREEN 후 커밋한다. 신규 등록이 외부 HTTP 수집 완료를 기다리지 않는지도 확인한다.

## Task 8: 수집 잡·판정·발행 연결

**Create:** `lib/jobs/products/agent-evidence-refresh.ts`,
`lib/domain/evidence/providers/site-fingerprint.ts`,
`tests/integration/agent-evidence-pipeline.test.ts`, `tests/site-fingerprint.test.ts`.
**Modify:** `lib/jobs/registry.ts`, `lib/crawl/jobs/fetch.ts`, `lib/crawl/jobs/judge.ts`,
`lib/crawl/rules.ts`, `lib/crawl/publish.ts`, `lib/crawl/settings-schema.ts`,
`lib/db/crawl-schema.ts`, `lib/domain/evidence/providers/github.ts`,
`lib/domain/evidence/refresh.ts`, `lib/domain/evidence/relationship.ts`, `tests/crawl-rules.test.ts`.

- [ ] 일반 calculator + stars/recent push/http200만으로 approved되는 현재 사례를
  `needs_review/ai_evidence_not_found` 기대값의 RED 테스트로 만든다.
- [ ] 제품 기본 거부 규칙 다음에 Task 1 summary를 결합한다. DecisionReason에 설계의
  다섯 이유를 추가하고 DB varchar 길이·UI 사유 목록을 rg로 찾아 모두 반영한다.
  classify.ts는 카테고리 분류를 유지하고 AI 적합성 판단의 대용으로 쓰지 않는다.
- [ ] 미수집이면 `ai_evidence_pending`을 반환한다. refresh 완료 시 자동 pending 후보만
  재판정 대상으로 바꾼다. 사람의 승인/거부나 기존 published 상태는 되돌리지 않는다.
- [ ] 현재 저장 경로가 빠져 있는 `site_fingerprint.repositoryKeys`를 실제 사이트 수집에서
  생성한다. 기존 SSRF 보호 fetch로 얻은 최종 URL과 HTML의 GitHub repository 링크를
  정규화해 저장하고 `siteObservedRepository`가 그 source를 읽게 한다. footer의 단순
  GitHub 소셜 프로필, 다른 프로젝트 예제 링크, 임의 canonical 메타만으로 관계를 확정하지 않는다.
  명확한 소스 코드 링크가 여러 repo를 가리키면 scope 확인 전 unknown으로 둔다.
  `site_link`/`bidirectional`과 제품 경로 일치만 자동 same_product로 매핑한다.
  repo homepage만 같은 단방향 `repository_link`는 복제 가능성이 있어 unknown이다.
  사이트가 명시한 소스 repo가 후보와 다르면 conflict로 둔다.
- [ ] site-fingerprint 단위 테스트에 같은 repo, 다른 canonical repo, 소셜 링크만 있음,
  리디렉션, 여러 서비스의 repo 링크를 넣고 `npx vitest run tests/site-fingerprint.test.ts`로 검증한다.
- [ ] 기존 runner의 job lease+cursor를 재사용하고 후보와 제품의 요청을 repo별로 합친다.
  agent scan 실패가 기존 GitHub 별·라이선스 수집 결과를 지우지 않게 한다.
  25초 잡 예산에서는 collector를 20초에 멈춰 cursor/source 저장 시간을 확보한다.
- [ ] 발행 transaction 직전에 policyVersion/scanId/relationship을 재확인한다. scan 후
  repo/maker/ban이 바뀐 후보를 과거 approved 결과만으로 발행하지 않는다.
- [ ] settings에 다음 feature flags를 추가한다.

```ts
agentEvidence: {
  enabled: false,
  enforceEligibility: false,
  displayObservedFacts: false,
  detectorVersion: '2026-09-06.1',
  policyVersion: '2026-09-06.1',
}
```

- [ ] `npx vitest run tests/crawl-rules.test.ts tests/agent-evidence-summary.test.ts`
  및 `npx vitest run --config vitest.integration.config.ts tests/integration/agent-evidence-pipeline.test.ts tests/integration/crawl-pipeline.test.ts`
  GREEN 후 커밋한다. pending→complete→rejudge→publish와 실패 재개를 모두 포함한다.

## Task 9: 공개 표시와 최신성 통일

**Create:** `lib/domain/evidence/agents/view.ts`, `tests/agent-evidence-view.test.ts`.
**Modify:** `lib/domain/products/detail-view.ts`, `components/product-detail/BuildProvenance.tsx`,
`components/product-detail/ProductHero.tsx`, `app/p/[slug]/page.tsx`,
`tests/product-detail-components.test.tsx`, `tests/e2e/product-detail.spec.ts`.

- [ ] 다음 화면 assertion을 RED로 만든다.

```text
CLAUDE.md만 있음 → “Claude 호환 지침 파일 확인”, 모델 “미확인”
Claude 설정 + GLM → 도구 Claude Code / 설정 모델 GLM / 연결 Z.AI
OpenRouter auto → “자동 모델 선택 설정”, 실제 실행 모델은 미확인
maker 신고 + 자동 관측 → 구분된 라벨로 둘 다 보존
source ok + relationship unknown → “공식 확인 완료” 표시 없음
19일 전 health → 현재 온라인 표시 없음
partial scan → 확인한 파일 유지, “일부 미확인” 표시
legacy builder만 있음 → maker_reported 외 제작 확정 표시 없음
```

- [ ] 공개 view에서 scan/source, 링크 가시성, relationship, lastSuccess를 함께 읽는다.
  모든 배지는 sourceUrl/commitSha/observedAt/kind에 연결하고 한국어로 표시한다.
- [ ] 기존 maker agent/skill은 유지한다. 자동 파일을 `repository_evidenced` 실행 이력으로
  productAgents에 추가하지 않는다. ProductDetailView에 observedAgentFacts 배열을 추가한다.
- [ ] health freshness는 기존 settings의 감시 주기와 맞는 단일 함수로 계산하고 오래된
  관측을 unknown/stale로 표시한다. 수집 성공과 공식 관계는 별도 표시한다. builder 참조를
  rg로 찾아 목록 페이지도 동일 규칙을 적용한다.
- [ ] `npx vitest run tests/agent-evidence-view.test.ts tests/product-detail-components.test.tsx`
  및 `npm run test:e2e:product` GREEN 후 커밋한다. E2E 시작 조건은 기존 config를 따른다.

## Task 10: 기존 데이터 수정 목록과 단계적 backfill

**Create:** `scripts/audit-agent-evidence.ts`, `scripts/backfill-agent-evidence.ts`,
`tests/agent-evidence-audit.test.ts`, `tests/integration/agent-evidence-backfill.test.ts`.

- [ ] dry-run 무변경, cursor 재개 중복 방지, 비공개/삭제 보존을 RED 테스트로 만든다.
- [ ] audit는 읽기 전용으로 다음 JSON 행과 사유별 집계·수집 coverage를 출력한다.

```ts
type CorrectionRow = {
  productId: number; slug: string; repoUrl: string | null;
  currentBuilder: string | null;
  proposedFacts: AgentObservation[];
  issues: Array<'missing_repository_link' | 'builder_without_evidence'
    | 'client_model_confusion' | 'relationship_conflict' | 'scan_pending'
    | 'scan_partial' | 'stale_public_label' | 'maker_deletion_ambiguous'>;
  action: 'backfill_link' | 'refresh' | 'adjust_label' | 'manual_review' | 'none';
};
```

- [ ] backfill은 기본 dry-run이며 `--apply`에서만 Task 7 동기화/Task 8 큐 입력을 한다.
  repo별 재개 cursor, product generation, policy version을 기록한다. 불필요한 개인 정보,
  이메일과 설정 원문은 보고서에 넣지 않는다.
- [ ] 스크립트 작성 후 실행할 정확한 명령:

```sh
npx tsx --env-file=.env.local scripts/audit-agent-evidence.ts --output /private/tmp/nomorevibe-agent-audit.json
npx tsx --env-file=.env.local scripts/backfill-agent-evidence.ts --dry-run --limit 50
```

- [ ] unit/integration GREEN 후 연결 DB를 확인하고 50건 dry-run 차이를 검토한다.
  실제 적용은 구현 당시 사용자가 허용한 범위에 따른다. 이번 계획 단계에서는 실행하지 않는다.
  maker 신고 삭제나 제품 일괄 삭제를 backfill에 넣지 않고 커밋한다.

## Task 11: 발견 범위·관측 지표·인수 검증

**Modify:** `lib/crawl/settings-schema.ts`, `lib/crawl/jobs/seed.ts`, `lib/crawl/github.ts`,
`tests/integration/crawl-seed.test.ts`, `lib/jobs/products/agent-evidence-refresh.ts`.
**Create:** `tests/agent-search-window.test.ts`, `docs/reviews/agent-evidence-acceptance.md`.

- [ ] GitHub incomplete_results=true/1000건 도달/같은 날 대량 결과/재개 중 검색 변경을 RED로 만든다.
- [ ] 검색 cursor에 고정 from/to/signal ID/query hash를 추가하고 미완료 구간만 분할한다.
  최소 시간 구간에서도 상한에 도달하면 incomplete를 유지한다. 검색 순서로 근거가 사라지지 않는다.
- [ ] Grok/Kimi/GLM/DeepSeek/OpenRouter 추가 검색도 발견 힌트로만 저장하고 builder 확정에
  쓰지 않는다. 우선 기존 repo 파일 검사를 진행한 뒤 새로운 탐색을 늘린다.
- [ ] 다음 지표를 secret 없는 structured log/관리 집계에 추가한다.

```text
agent_scan_requested / complete / partial / failed / oldest_due_age_seconds
repo_link_coverage = visible repo links / eligible products with repoUrl
evidence_coverage = complete scans / requested unique repo+scope
reason_counts, provider_rule_counts, unknown_model_counts
requests_per_repo, bytes_per_repo, p50/p95_scan_seconds, retry_after_seconds
```

- [ ] 다음 최종 검증을 실행하고 실제 결과를 기록한다. 실패 시 관련 범위를 수정한다.

```sh
npx next typegen
npx tsc --noEmit
npm test
npm run test:integration
npm run test:e2e:product
npm run lint
npm run build
git diff --check
```

- [ ] 다섯 계열·공유 문서·runtime-only·template·monorepo·미확인을 포함한 실제 repo
  50개에 수동 정답을 붙인다. 파일 존재·설정 모델·제품 관계 정확도를 각각 보고하고
  표본 수와 미확인 수를 공개한다. 이 표본만으로 전체 GitHub recall을 주장하지 않는다.
- [ ] worker 재시작 cursor 복구, 이중 worker lease 배타성, deadline, rate limit 대기를
  실측한다. 기존 6시간 전체 tick을 그대로 쓰지 않고 agent job의 due를 짧은 주기로 확인한다.
- [ ] enabled → display → enforceEligibility 순서로 적용한다. 롤백 시 flags를 끄고
  추가 테이블의 근거는 보존한다. 테이블 삭제는 필요 없다. 감사 결과와 handoff를 갱신한다.

## 계획 자체 검토

| 설계 요구사항 | 대응 Task |
| --- | --- |
| 지정 다섯 계열·다른 클라이언트·공유 형식 | 1–3 |
| 타입·secret·alias·역할·실행 증명 구분 | 1, 3, 9 |
| 다중 관측·제품 세대·maker 보존 | 4, 7–10 |
| GitHub 상한·SHA·실패·재개 | 5, 8, 11 |
| 검색 오귀속·AI 적합성·관계 | 6, 8 |
| repo link 누락·오래된 배지 | 7, 9 |
| 수정 목록·기존 제품 backfill | 10 |
| 실제 표본·운영 측정·단계 적용 | 11 |

실행 범위: Task 0–9 핵심 기능과 회귀 검증, Task 10 백필/JSON 보고, Task 11 검색 확장과 로컬 운영을 구현했다.
원래 계획의 별도 audit CLI/50개 대표 저장소 표본/태스크별 커밋/서버 배포는 수행하지 않았다.
사용자가 최종 요청한 실제 10개 제품 검증은 결과 보고서에 수집·화면·미확인을 나누어 기록한다.
