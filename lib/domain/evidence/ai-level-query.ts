import type { GraphqlError } from '@/lib/crawl/github';
import type { RepositoryRef } from '@/lib/crawl/github-repositories';
import { AGENT_ROOT_DIRECTORIES, type CommitFacts, type MergedPullRequest, type TreeEntry } from './ai-level';

/**
 * AI 제작 근거 단계의 GitHub GraphQL 질의 — 저장소 10개씩 한 번(ai-level-refresh 잡).
 *
 * 2026-10-10 실측(공개분 무작위 10개 묶음 세 번): 기본 브랜치 최근 커밋 30개(메시지·작성자) + 병합 PR 30개(연 계정) + 루트 목록이
 * 1점, 3.5~4.5초, 응답 260KB 남짓. PR 50개로 늘리면 4.5~7.3초라 GitHub 10초 상한에 가까워 30개로 둔다.
 * 오래 활발한 저장소는 병합 PR 30개 너머의 에이전트 PR 을 놓친다 — 단계를 낮게 볼 수는 있어도 높게 보지는 않는다.
 */
export const AI_LEVEL_BATCH = 10;
const HISTORY = 30;
const PULL_REQUESTS = 30;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/;

const REPOSITORY_FIELDS = `isFork defaultBranchRef { name target { ... on Commit { oid history(first: ${HISTORY}) { nodes { oid message parents { totalCount } author { name email user { login } } } } } } } `
  + `pullRequests(states: MERGED, first: ${PULL_REQUESTS}, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number mergedAt baseRefName author { __typename login } } } `
  + `root: object(expression: "HEAD:") { ... on Tree { entries { name type mode } } }`;

function repositoryCall(alias: string, repo: RepositoryRef, body: string): string {
  if (!SEGMENT.test(repo.owner) || !SEGMENT.test(repo.name)) throw new Error('ai_level_repository_name');
  return `${alias}: repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.name)}) { ${body} }`;
}

export function aiLevelBatchQuery(repos: readonly RepositoryRef[]): string {
  if (repos.length === 0 || repos.length > AI_LEVEL_BATCH) throw new Error('ai_level_batch_size');
  return `query { rateLimit { cost remaining resetAt } ${repos.map((repo, index) => repositoryCall(`r${index}`, repo, '...A')).join(' ')} }\n`
    + `fragment A on Repository { ${REPOSITORY_FIELDS} }`;
}

export type RepositoryAiScan = {
  isFork: boolean; defaultBranch: string | null; headSha: string | null;
  commits: CommitFacts[]; pullRequests: MergedPullRequest[]; rootEntries: TreeEntry[];
};
/** found 받음 · not_found 없음(NOT_FOUND) · unknown 이번 답으로는 모름(오류·깨진 답) — 지난 판정을 그대로 둔다 */
export type AiLevelAnswer = { kind: 'found'; scan: RepositoryAiScan } | { kind: 'not_found' } | { kind: 'unknown' };

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';

function treeEntries(value: unknown, prefix: string): TreeEntry[] {
  return asArray(asObject(value)?.entries).flatMap((item) => {
    const entry = asObject(item);
    const name = entry?.name;
    if (typeof name !== 'string' || !name || name.includes('/') || typeof entry?.type !== 'string' || typeof entry.mode !== 'number') return [];
    return [{ path: prefix ? `${prefix}/${name}` : name, type: entry.type, mode: entry.mode }];
  });
}

function readScan(node: Record<string, unknown>): RepositoryAiScan {
  const branch = asObject(node.defaultBranchRef);
  const target = asObject(branch?.target);
  const commits = asArray(asObject(asObject(target?.history))?.nodes).flatMap((item): CommitFacts[] => {
    const commit = asObject(item);
    const sha = commit?.oid;
    if (typeof sha !== 'string' || !SHA.test(sha)) return [];
    const author = asObject(commit?.author);
    const parents = asObject(commit?.parents)?.totalCount;
    return [{ sha, message: text(commit?.message, 128 * 1024), parents: typeof parents === 'number' ? parents : 1,
      authorName: text(author?.name, 200), authorEmail: text(author?.email, 200),
      authorLogin: typeof asObject(author?.user)?.login === 'string' ? asObject(author?.user)!.login as string : null }];
  });
  const pullRequests = asArray(asObject(node.pullRequests)?.nodes).flatMap((item): MergedPullRequest[] => {
    const pr = asObject(item);
    const author = asObject(pr?.author);
    if (typeof pr?.number !== 'number' || !Number.isSafeInteger(pr.number) || typeof pr.mergedAt !== 'string' || typeof pr.baseRefName !== 'string') return [];
    return [{ number: pr.number, mergedAt: pr.mergedAt, baseRefName: pr.baseRefName,
      authorLogin: typeof author?.login === 'string' ? author.login : null, authorType: typeof author?.__typename === 'string' ? author.__typename : null }];
  });
  const headSha = typeof target?.oid === 'string' && SHA.test(target.oid) ? target.oid : null;
  return { isFork: node.isFork === true, defaultBranch: typeof branch?.name === 'string' ? branch.name : null, headSha, commits, pullRequests,
    rootEntries: treeEntries(node.root, '') };
}

export function parseAiLevelBatch(repos: readonly RepositoryRef[], data: Record<string, unknown> | null, errors: readonly GraphqlError[]): AiLevelAnswer[] {
  return repos.map((_, index) => {
    const alias = `r${index}`;
    const node = asObject(data?.[alias]);
    if (node) return { kind: 'found', scan: readScan(node) };
    const error = errors.find((item) => Array.isArray(item.path) && item.path[0] === alias);
    return error?.type === 'NOT_FOUND' ? { kind: 'not_found' } : { kind: 'unknown' };
  });
}

/** 두 번째 질의 — 루트의 에이전트 폴더 두 겹과 에이전트 PR 이 바꾼 파일. 필요한 저장소만 */
export type AiLevelDetailRequest = { repo: RepositoryRef; directories: readonly string[]; pullRequests: readonly number[] };
export type AiLevelDetail = { entries: TreeEntry[]; pullRequestFiles: Map<number, string[]> } | null;

const DIRECTORY_SET = new Set<string>(AGENT_ROOT_DIRECTORIES);

export function aiLevelDetailQuery(items: readonly AiLevelDetailRequest[]): string {
  if (items.length === 0 || items.length > AI_LEVEL_BATCH) throw new Error('ai_level_batch_size');
  const calls = items.map((item, index) => {
    if (item.directories.some((directory) => !DIRECTORY_SET.has(directory))) throw new Error('ai_level_directory');
    if (item.pullRequests.some((number) => !Number.isSafeInteger(number) || number <= 0)) throw new Error('ai_level_pull_request');
    const body = [
      ...item.directories.map((directory, at) => `d${at}: object(expression: ${JSON.stringify(`HEAD:${directory}`)}) { ...T }`),
      ...item.pullRequests.map((number, at) => `p${at}: pullRequest(number: ${number}) { files(first: 100) { nodes { path } } }`),
    ].join(' ');
    return repositoryCall(`r${index}`, item.repo, body || '__typename');
  });
  return `query { rateLimit { cost remaining resetAt } ${calls.join(' ')} }\n`
    + 'fragment T on Tree { entries { name type mode object { ... on Tree { entries { name type mode } } } } }';
}

export function parseAiLevelDetail(items: readonly AiLevelDetailRequest[], data: Record<string, unknown> | null): AiLevelDetail[] {
  return items.map((item, index) => {
    const node = asObject(data?.[`r${index}`]);
    if (!node) return null;
    const entries = item.directories.flatMap((directory, at) => {
      const top = treeEntries(node[`d${at}`], directory);
      // 한 겹 아래(.cursor/rules/*.mdc 처럼 규칙은 대개 두 겹째에 있다)
      const nested = asArray(asObject(node[`d${at}`])?.entries).flatMap((child) => {
        const entry = asObject(child);
        return typeof entry?.name === 'string' && !entry.name.includes('/') ? treeEntries(entry.object, `${directory}/${entry.name}`) : [];
      });
      return [...top, ...nested];
    });
    const pullRequestFiles = new Map<number, string[]>();
    item.pullRequests.forEach((number, at) => {
      const files = asObject(asObject(node[`p${at}`])?.files);
      if (!files) return;
      pullRequestFiles.set(number, asArray(files.nodes).flatMap((file) => {
        const path = asObject(file)?.path;
        return typeof path === 'string' && path.length <= 1000 ? [path] : [];
      }));
    });
    return { entries, pullRequestFiles };
  });
}
