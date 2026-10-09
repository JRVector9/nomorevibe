import { matchAgentArtifact } from './agents/catalog';
import { finalTrailerLines } from './agents/commit-attribution';
import type { AgentObservation } from './agents/types';
import type { AiLevel, AiLevelEvidence } from './ai-level-labels';

/**
 * AI 제작 근거 단계 판정(2026-10-10, 기준 문서 docs/ai-evidence-criteria.html) — 순수 함수와 GraphQL 질의.
 * 잡(lib/jobs/products/ai-level-refresh.ts)이 저장소 10개씩 한 번에 묻고 여기서 읽는다.
 *
 * 1단계: 서비스가 앱 토큰을 쥔 AI 에이전트 앱이 연 PR 이 기본 브랜치에 병합됐고 코드 파일을 바꿨다. PR 을 연 계정은 GitHub 이 기록한다.
 *   PR 안 커밋의 작성자는 보지 않는다 — Devin·Arena·Cursor 는 사용자 이름으로 커밋한다(2026-10-10 실측: Devin PR 6건·Arena 6건 모두 사용자,
 *   Cursor 6건 중 4건 사용자). 그래서 사람이 덧붙였는지는 가릴 수 없고, 1단계는 "에이전트가 연 PR 이 병합됐다"까지다.
 * 2단계: 코드 파일을 바꾼 커밋에 AI 도구 서명(Co-authored-by)·작성자 표기·도구가 붙이는 꼬리 줄. 저장소 주인의 워크플로가 토큰을 받아 쓰는
 *   claude[bot] 이 연 PR 도 여기다(주인이 꾸밀 수 있다). 포크는 커밋 표기를 보지 않는다 — 원본 저장소의 것을 물려받는다.
 * 3단계: 루트의 AI 도구 전용 설정·규칙 파일(agents/catalog.ts 의 도구가 정해진 규칙). CLAUDE.md·AGENTS.md 처럼 여러 도구가 읽는 공유 형식은 넣지 않는다.
 *   포크는 파일도 원본에서 물려받으므로 커밋처럼 보지 않는다.
 * 기존 근거 수집(agent_repository_observations)이 찾은 개발 커밋 표기·도구 파일도 같은 단계로 센다.
 */

/** 서비스가 앱 토큰을 쥔 에이전트 — GraphQL 봇 login('[bot]' 없이) → 도구 키. 2026-10-10 GitHub 검색으로 병합 PR 이 있는 것을 확인했다 */
export const SERVICE_AGENT_APPS: Readonly<Record<string, string>> = {
  'copilot-swe-agent': 'github-copilot', copilot: 'github-copilot',
  'devin-ai-integration': 'devin', 'google-labs-jules': 'jules', cursor: 'cursor', 'kiro-agent': 'kiro',
  'codegen-sh': 'codegen', 'amazon-q-developer': 'amazon-q', 'factory-droid': 'factory-droid', 'arena-ai-coding-agent': 'arena',
};
/** 저장소 주인의 GitHub Actions 워크플로가 앱 토큰을 받아 쓰는 에이전트 — 주인이 무엇이든 그 이름으로 올릴 수 있어 2단계 */
export const WORKFLOW_AGENT_APPS: Readonly<Record<string, string>> = { claude: 'claude-code' };

export type MergedPullRequest = { number: number; mergedAt: string; baseRefName: string; authorLogin: string | null; authorType: string | null };
export type AgentPullRequest = { number: number; mergedAt: string; agent: string; client: string; level: 1 | 2 };

/** 에이전트 앱이 열어 기본 브랜치로 병합된 PR — 코드 파일을 바꿨는지는 따로 본다 */
export function agentPullRequests(pullRequests: readonly MergedPullRequest[], defaultBranch: string | null): AgentPullRequest[] {
  if (!defaultBranch) return [];
  return pullRequests.flatMap((pr): AgentPullRequest[] => {
    if (pr.authorType !== 'Bot' || !pr.authorLogin || pr.baseRefName !== defaultBranch) return [];
    const agent = pr.authorLogin.toLowerCase().replace(/\[bot\]$/, '');
    const service = SERVICE_AGENT_APPS[agent];
    if (service) return [{ number: pr.number, mergedAt: pr.mergedAt, agent, client: service, level: 1 }];
    const workflow = WORKFLOW_AGENT_APPS[agent];
    return workflow ? [{ number: pr.number, mergedAt: pr.mergedAt, agent, client: workflow, level: 2 }] : [];
  });
}

export type CommitFacts = { sha: string; message: string; parents: number; authorName: string; authorEmail: string; authorLogin: string | null };
export type CommitClaim = { client: string; basis: 'coauthor' | 'author' | 'footer' };

/**
 * Co-authored-by 표기 — 이름과 주소가 함께 맞아야 한다. 'Claude'·'Devin'·'Jules' 는 사람 이름이기도 하다.
 * 2026-10-10 공개분 1,435개 저장소의 최근 커밋 30개에서 본 표기: Claude Opus 5.5 / Fable 5.1 / Opus 5 (1M context) 등 모델 이름 뒤 괄호,
 * Cursor Agent, Codex, copilot-swe-agent[bot], Devin, claude[bot], Grok 4.7.
 */
const CO_AUTHORS: readonly { client: string; label: RegExp; email: RegExp | null }[] = [
  { client: 'claude-code', label: /^claude(?: code| (?:opus|sonnet|haiku|fable)\b.*|\[bot\])?$/i, email: /@anthropic\.com$|^(?:\d+\+)?claude\[bot\]@users\.noreply\.github\.com$/i },
  { client: 'codex', label: /^(?:openai )?codex(?: cloud| cli)?$/i, email: /@openai\.com$/i },
  { client: 'cursor', label: /^cursor(?: agent)?$/i, email: /@cursor\.(?:com|sh)$/i },
  { client: 'github-copilot', label: /^(?:github )?copilot$|^copilot-swe-agent\[bot\]$/i, email: /^(?:\d+\+)?(?:copilot|copilot-swe-agent\[bot\])@users\.noreply\.github\.com$/i },
  { client: 'devin', label: /^devin(?: ai)?$|^devin-ai-integration\[bot\]$/i, email: /devin-ai-integration\[bot\]@users\.noreply\.github\.com$|@(?:cognition\.ai|devin\.ai)$/i },
  { client: 'jules', label: /^(?:jules|google-labs-jules\[bot\])$/i, email: /google-labs-jules\[bot\]@users\.noreply\.github\.com$/i },
  { client: 'gemini-cli', label: /^gemini(?: cli| [0-9].*)?$/i, email: /@google\.com$/i },
  { client: 'grok-build', label: /^grok\b/i, email: /@x\.ai$/i },
  { client: 'amp', label: /^amp$/i, email: /@ampcode\.com$/i },
  // 사람 이름으로 쓰이지 않는 도구 이름은 주소를 보지 않는다
  { client: 'opencode', label: /^opencode$/i, email: null },
  { client: 'roo-code', label: /^roo code$/i, email: null },
  { client: 'qwen-code', label: /^qwen[- ]?code(?:r)?$/i, email: null },
  { client: 'kimi', label: /^kimi (?:code|cli)$/i, email: null },
  { client: 'factory-droid', label: /^factory droid$|^factory-droid\[bot\]$/i, email: null },
  { client: 'windsurf', label: /^windsurf$/i, email: null },
  { client: 'cline', label: /^cline$/i, email: null },
];

/** 커밋 작성자 자체가 도구인 경우 — 'Claude <noreply@anthropic.com>'(공개분 1,435개 중 200개), Cursor Agent, Copilot, Codex */
const AUTHORS: readonly { client: string; test: (name: string, email: string, login: string) => boolean }[] = [
  { client: 'claude-code', test: (name, email) => email === 'noreply@anthropic.com' || /^claude\[bot\]$/i.test(name) },
  { client: 'cursor', test: (_name, email, login) => login === 'cursoragent' || email === 'cursoragent@cursor.com' },
  { client: 'github-copilot', test: (name, _email, login) => login === 'copilot' || /^copilot-swe-agent\[bot\]$/i.test(name) },
  { client: 'codex', test: (name, email, login) => login === 'codex' || (/@openai\.com$/.test(email) && /codex/i.test(name)) },
  { client: 'jules', test: (name) => /^google-labs-jules\[bot\]$/i.test(name) },
  { client: 'devin', test: (name) => /^devin-ai-integration\[bot\]$/i.test(name) },
  { client: 'kiro', test: (_name, _email, login) => login === 'kiro-agent' },
  { client: 'amazon-q', test: (name) => /^amazon-q-developer\[bot\]$/i.test(name) },
  { client: 'codegen', test: (name) => /^codegen-sh\[bot\]$/i.test(name) },
  { client: 'factory-droid', test: (name) => /^factory-droid\[bot\]$/i.test(name) },
  { client: 'aider', test: (name) => / \(aider\)$/i.test(name) },
];

/** 도구가 커밋 본문 끝에 붙이는 줄 — 정해진 문구와 주소 그대로만 */
const FOOTERS: readonly { client: string; line: RegExp }[] = [
  { client: 'claude-code', line: /^(?:\p{Extended_Pictographic}️?\s*)?Generated with \[Claude Code\]\(https:\/\/(?:claude\.com\/claude-code|claude\.ai\/code)\/?\)\s*$/mu },
  { client: 'devin', line: /^Generated with \[Devin\]\(https:\/\/devin\.ai\/?\)\s*$/m },
];

/** 커밋 하나의 AI 도구 표기. 병합 커밋은 보지 않는다 — 다른 갈래의 표기를 물려받는다 */
export function commitAiClaims(commit: CommitFacts): CommitClaim[] {
  if (commit.parents > 1 || commit.message.length > 128 * 1024) return [];
  const claims: CommitClaim[] = [];
  for (const line of finalTrailerLines(commit.message)) {
    const match = line.match(/^Co-authored-by:\s*([^<>\r\n]+?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/i);
    if (!match) continue;
    const label = match[1].trim().replace(/\s+/g, ' ');
    const email = match[2].toLowerCase();
    const rule = CO_AUTHORS.find((item) => item.label.test(label) && (!item.email || item.email.test(email)));
    if (rule) claims.push({ client: rule.client, basis: 'coauthor' });
  }
  const name = commit.authorName.trim();
  const email = commit.authorEmail.trim().toLowerCase();
  const login = (commit.authorLogin ?? '').toLowerCase();
  for (const rule of AUTHORS) if (rule.test(name, email, login)) claims.push({ client: rule.client, basis: 'author' });
  for (const rule of FOOTERS) if (rule.line.test(commit.message)) claims.push({ client: rule.client, basis: 'footer' });
  return [...new Map(claims.map((claim) => [`${claim.client}:${claim.basis}`, claim])).values()];
}

export type TreeEntry = { path: string; type: string; mode: number };

/** 3단계 — 도구가 정해진 설정·규칙·에이전트 정의 파일. 예제 폴더와 공유 지침(CLAUDE.md·AGENTS.md)은 빼고, 루트 범위만 */
export function toolFiles(entries: readonly TreeEntry[]): { path: string; client: string }[] {
  return entries.flatMap((entry) => {
    const match = matchAgentArtifact(entry.path, entry.mode.toString(8), entry.type);
    const client = match.rule?.client;
    return client && match.scope === '' && ['instruction_file', 'client_config', 'agent_definition'].includes(match.classification)
      ? [{ path: entry.path, client }] : [];
  });
}

/** 루트에 있으면 한 겹 더 들여다볼 폴더 — 도구가 정해진 규칙이 그 안에 있다(공유 형식뿐인 .agents·.kimi 는 뺀다) */
export const AGENT_ROOT_DIRECTORIES = ['.claude', '.codex', '.grok', '.kimi-code', '.cursor', '.clinerules', '.roo', '.opencode',
  '.continue', '.gemini', '.qwen', '.github', '.windsurf', '.devin', '.factory', '.kiro'] as const;

/** 기존 근거 수집(agent_repository_observations)의 마지막 루트 조사에서 단계로 셀 것 */
export function scanEvidence(observations: readonly AgentObservation[]): { commits: { sha: string; client: string }[]; files: { path: string; client: string }[] } {
  const commits = observations.flatMap((item) => item.kind === 'commit_attribution' && item.client && item.role !== 'committer'
    && item.commitEvidence?.basis !== 'committer' && item.commitEvidence?.changeKind === 'development' && item.scope === ''
    ? [{ sha: item.commitSha, client: item.client }] : []);
  const files = observations.flatMap((item) => ['instruction_file', 'client_config', 'model_config'].includes(item.kind)
    && item.client && item.scope === '' && item.sourcePath ? [{ path: item.sourcePath, client: item.client }] : []);
  return { commits, files };
}

export type ClassifyInput = {
  isFork: boolean;
  /** 코드 파일을 바꿨는지 확인한 에이전트 PR — development false 는 버린다, null 은 아직 모른다 */
  pullRequests: readonly (AgentPullRequest & { development: boolean | null })[];
  commits: readonly { sha: string; client: string; basis: CommitClaim['basis'] | 'scan'; development: boolean | null }[];
  files: readonly { path: string; client: string }[];
};

const EVIDENCE_CAP = 5;

/** 단계 하나로 — 1 이 가장 강하다. 근거는 단계마다 몇 건만 남긴다 */
export function classifyAiLevel(input: ClassifyInput): { level: AiLevel | null; clients: string[]; evidence: AiLevelEvidence } {
  const pullRequests = input.pullRequests.filter((pr) => pr.development === true);
  const commits = (input.isFork ? input.commits.filter((commit) => commit.basis === 'scan') : input.commits)
    .filter((commit) => commit.development === true);
  const files = input.isFork ? [] : [...new Map(input.files.map((file) => [file.path, file])).values()];
  const level: AiLevel | null = pullRequests.some((pr) => pr.level === 1) ? 1
    : pullRequests.length || commits.length ? 2 : files.length ? 3 : null;
  const clients = [...new Set([...pullRequests.map((pr) => pr.client), ...commits.map((commit) => commit.client), ...files.map((file) => file.client)])].sort();
  return {
    level,
    clients,
    evidence: {
      ...(pullRequests.length ? { pullRequests: [...pullRequests].sort((a, b) => a.level - b.level || b.mergedAt.localeCompare(a.mergedAt)).slice(0, EVIDENCE_CAP)
        .map(({ number, agent, mergedAt, level: prLevel }) => ({ number, agent, mergedAt, level: prLevel })) } : {}),
      ...(commits.length ? { commits: [...new Map(commits.map((commit) => [commit.sha, commit])).values()].slice(0, EVIDENCE_CAP)
        .map(({ sha, client, basis }) => ({ sha, client, basis })) } : {}),
      ...(files.length ? { files: files.slice(0, EVIDENCE_CAP) } : {}),
    },
  };
}
