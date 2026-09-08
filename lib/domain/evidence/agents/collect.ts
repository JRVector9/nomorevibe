import { githubRequest, type GitHubFailure, type GitHubHttpResult } from '@/lib/crawl/github';
import { AGENT_DIRECTORY_PREFIXES, ARTIFACT_RULES, matchAgentArtifact } from './catalog';
import { parseAgentArtifact } from './parse';
import { parseCommitAttributions } from './commit-attribution';
import { AGENT_DETECTOR_VERSION, type AgentObservation } from './types';

export const AGENT_SCAN_LIMITS = { requests: 12, durationMs: 20_000, timeoutMs: 8_000, files: 32, fileBytes: 64 * 1024, totalBytes: 512 * 1024, queuedEntries: 512 } as const;
export type AgentGitHubRequest = <T>(path: string) => Promise<GitHubHttpResult<T>>;
export type CollectCursor = {
  repositoryId: string; repositoryKey: string; commitSha: string; detectorVersion: string; scope: string;
  pendingTrees: Array<{ path: string; sha: string }>;
  pendingBlobs: Array<{ path: string; sha: string; size: number; ruleId: string }>;
  pendingCommits?: Array<{ sha: string; observations?: AgentObservation[] }>;
  coverageLimited?: boolean;
};
export type CollectResult = {
  repositoryId: string | null; repositoryKey: string; commitSha: string | null; scope: string;
  state: 'complete' | 'partial' | 'failed'; cursor: CollectCursor | null;
  observations: AgentObservation[]; requestCount: number; fileCount: number;
  errorCode: 'rate_limited' | 'timeout' | 'unavailable' | 'invalid' | 'budget_exhausted' | null;
  retryAt: Date | null;
};
const shaPattern = /^[a-f0-9]{40,64}$/;
export function normalizeAgentRepositoryKey(key: string): string {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(key) || key.split('/').some(p => p === '.' || p === '..') || key.length > 200) throw new Error('invalid repository key');
  return key.toLowerCase();
}
function normalizeScope(scope: string): string {
  const normalized = scope.replace(/^\/+|\/+$/g, '');
  if (normalized.length > 1000 || normalized.split('/').some(p => p === '.' || p === '..') || /[\x00-\x1f\\]/.test(normalized)) throw new Error('invalid repository scope');
  return normalized;
}
function failure(error: GitHubFailure): Pick<CollectResult, 'errorCode' | 'retryAt'> {
  return { errorCode: error.kind === 'rate_limited' ? 'rate_limited' : error.kind === 'invalid_response' ? 'invalid' : error.kind === 'transport' ? 'timeout' : 'unavailable', retryAt: error.kind === 'rate_limited' ? error.resetAt : null };
}
export async function collectRepositoryAgentEvidence(input: {
  repositoryKey: string; scope?: string; cursor?: CollectCursor | null; request?: AgentGitHubRequest;
  hasBudget?: () => boolean; maxRequests?: number; knownComplete?: { repositoryId: string; commitSha: string }; deadlineAt?: number; discoveryCommitShas?: string[];
}): Promise<CollectResult> {
  const repositoryKey = normalizeAgentRepositoryKey(input.repositoryKey);
  const scope = normalizeScope(input.scope ?? input.cursor?.scope ?? '');
  const started = Date.now();
  const deadlineAt = Math.min(started + AGENT_SCAN_LIMITS.durationMs, input.deadlineAt ?? Infinity);
  const request: AgentGitHubRequest = input.request ?? (path => githubRequest(path, {}, { timeoutMs: Math.max(1, Math.min(AGENT_SCAN_LIMITS.timeoutMs, deadlineAt - Date.now())) }));
  const maxRequests = Math.max(3, Math.min(input.maxRequests ?? AGENT_SCAN_LIMITS.requests, AGENT_SCAN_LIMITS.requests));
  let cursor = input.cursor ? structuredClone(input.cursor) : null;
  if (cursor && (cursor.repositoryKey !== repositoryKey || cursor.scope !== scope || cursor.detectorVersion !== AGENT_DETECTOR_VERSION || !shaPattern.test(cursor.commitSha) || !/^\d+$/.test(cursor.repositoryId) || [...cursor.pendingTrees, ...cursor.pendingBlobs].some(item => !shaPattern.test(item.sha) || item.path.split('/').some(p => p === '..')))) throw new Error('invalid agent scan cursor');
  const result: CollectResult = { repositoryId: cursor?.repositoryId ?? null, repositoryKey, commitSha: cursor?.commitSha ?? null, scope, state: 'partial', cursor, observations: [], requestCount: 0, fileCount: 0, errorCode: null, retryAt: null };
  const budget = () => result.requestCount < maxRequests && Date.now() <= deadlineAt - AGENT_SCAN_LIMITS.timeoutMs && (input.hasBudget?.() ?? true);
  const get = async <T>(path: string) => { result.requestCount++; return request<T>(path); };
  const fail = (error: GitHubFailure) => { Object.assign(result, failure(error)); result.state = cursor ? 'partial' : 'failed'; result.cursor = cursor; return result; };
  if (cursor) {
    if (!budget()) return { ...result, errorCode: 'budget_exhausted' };
    // Visibility can change between ticks; token access is not public publication permission.
    const repository = await get<{ id: number; private: boolean }>(`/repos/${repositoryKey}`);
    if (!repository.ok) return fail(repository.error);
    if (repository.status !== 200 || repository.value.private !== false || String(repository.value.id) !== cursor.repositoryId) return fail({ kind: 'invalid_response' });
  }
  if (!cursor) {
    if (!budget()) return { ...result, errorCode: 'budget_exhausted' };
    const repo = await get<{ id: number; full_name: string; default_branch: string; private: boolean }>(`/repos/${repositoryKey}`);
    if (!repo.ok) return fail(repo.error);
    if (repo.status !== 200 || !Number.isSafeInteger(repo.value.id) || repo.value.id <= 0 || repo.value.private !== false || typeof repo.value.default_branch !== 'string') return fail({ kind: 'invalid_response' });
    result.repositoryId = String(repo.value.id);
    if (!budget()) return { ...result, errorCode: 'budget_exhausted' };
    const branch = await get<{ sha: string; commit: { tree: { sha: string } } }>(`/repos/${repositoryKey}/commits/${encodeURIComponent(repo.value.default_branch)}`);
    if (!branch.ok) return fail(branch.error);
    if (branch.status !== 200 || !shaPattern.test(branch.value.sha) || !shaPattern.test(branch.value.commit?.tree?.sha)) return fail({ kind: 'invalid_response' });
    result.commitSha = branch.value.sha;
    const unchanged = input.knownComplete?.repositoryId === result.repositoryId && input.knownComplete.commitSha === result.commitSha;
    cursor = { repositoryId: result.repositoryId, repositoryKey, commitSha: branch.value.sha, detectorVersion: AGENT_DETECTOR_VERSION, scope, pendingTrees: unchanged ? [] : [{ path: '', sha: branch.value.commit.tree.sha }], pendingBlobs: [], pendingCommits: [...new Set(input.discoveryCommitShas ?? [])].filter(sha => shaPattern.test(sha)).slice(0, 5).map(sha => ({ sha })) };
  }
  result.cursor = cursor;
  const traversable = (path: string) => {
    if (scope && (path === scope || scope.startsWith(path + '/'))) return true;
    const relative = scope ? (path.startsWith(scope + '/') ? path.slice(scope.length + 1) : null) : path;
    return relative !== null && AGENT_DIRECTORY_PREFIXES.some(prefix => prefix === relative || prefix.startsWith(relative + '/') || relative.startsWith(prefix + '/'));
  };
  let bodyBytes = 0;
  while (budget() && (cursor.pendingBlobs.length || cursor.pendingTrees.length || cursor.pendingCommits?.length)) {
    if (cursor.pendingBlobs.length) {
      if (result.fileCount >= AGENT_SCAN_LIMITS.files) break;
      const item = cursor.pendingBlobs[0];
      if (bodyBytes + item.size > AGENT_SCAN_LIMITS.totalBytes) break;
      const response = await get<{ encoding: string; content: string; size: number }>(`/repos/${repositoryKey}/git/blobs/${item.sha}`);
      if (!response.ok) return fail(response.error);
      if (response.status !== 200 || response.value.encoding !== 'base64' || typeof response.value.content !== 'string' || response.value.content.length > AGENT_SCAN_LIMITS.fileBytes * 1.5) return fail({ kind: 'invalid_response' });
      const bytes = Buffer.from(response.value.content, 'base64');
      if (bytes.length > AGENT_SCAN_LIMITS.fileBytes) return fail({ kind: 'invalid_response' });
      const rule = ARTIFACT_RULES.find(rule => rule.id === item.ruleId);
      if (!rule) return fail({ kind: 'invalid_response' });
      const [owner, name] = repositoryKey.split('/');
      const parsed = parseAgentArtifact({ rule, path: item.path, content: bytes.toString('utf8'), repository: { owner, name }, commitSha: cursor.commitSha, blobSha: item.sha });
      result.observations.push(...parsed.observations);
      if (parsed.status !== 'ok') cursor.coverageLimited = true;
      cursor.pendingBlobs.shift(); result.fileCount++; bodyBytes += bytes.length;
    } else if (cursor.pendingCommits?.length && !cursor.pendingTrees.length) {
      const item = cursor.pendingCommits[0];
      if (!item.observations) {
        const commit = await get<{ sha: string; commit: { message: string }; parents: Array<{ sha: string }> }>(`/repos/${repositoryKey}/commits/${item.sha}`);
        if (!commit.ok) return fail(commit.error);
        if (commit.status !== 200 || commit.value.sha !== item.sha || typeof commit.value.commit?.message !== 'string' || !Array.isArray(commit.value.parents)) return fail({ kind: 'invalid_response' });
        // Merge commits may inherit unrelated upstream attribution; only inspect direct commits.
        if (commit.value.parents.length !== 1) { cursor.pendingCommits.shift(); continue; }
        const clients = [...new Set(parseCommitAttributions(commit.value.commit.message).flatMap(attribution => attribution.client ? [attribution.client] : []))];
        if (clients.length > 8) cursor.coverageLimited = true;
        item.observations = clients.slice(0, 8).map(client => ({ kind: 'commit_attribution', client, compatibleClients: [], modelDeveloper: null, declaredModelId: null, gateway: null, routing: 'unknown', role: null, scope, keyPath: null, ruleId: 'commit.coauthor.v1', sourcePath: null, commitSha: item.sha, blobSha: null, sourceUrl: `https://github.com/${repositoryKey}/commit/${item.sha}` }));
        if (!item.observations.length) { cursor.pendingCommits.shift(); continue; }
      }
      if (!budget()) break;
      const comparison = await get<{ status: string }>(`/repos/${repositoryKey}/compare/${item.sha}...${cursor.commitSha}`);
      if (!comparison.ok) return fail(comparison.error);
      if (comparison.status !== 200 || typeof comparison.value.status !== 'string') return fail({ kind: 'invalid_response' });
      if (['ahead', 'identical'].includes(comparison.value.status)) result.observations.push(...item.observations);
      cursor.pendingCommits.shift();
    } else {
      const item = cursor.pendingTrees[0];
      const response = await get<{ truncated: boolean; tree: Array<{ path: string; mode: string; type: string; sha: string; size?: number }> }>(`/repos/${repositoryKey}/git/trees/${item.sha}`);
      if (!response.ok) return fail(response.error);
      if (response.status !== 200 || !Array.isArray(response.value.tree)) return fail({ kind: 'invalid_response' });
      cursor.pendingTrees.shift();
      if (response.value.truncated) cursor.coverageLimited = true;
      for (const entry of response.value.tree) {
        if (!entry || typeof entry.path !== 'string' || entry.path.includes('/') || entry.path === '..' || !shaPattern.test(entry.sha)) { cursor.coverageLimited = true; continue; }
        const path = item.path ? `${item.path}/${entry.path}` : entry.path;
        if (path.length > 1000 || path.split('/').length > 24 || /[\x00-\x1f]/.test(path)) { cursor.coverageLimited = true; continue; }
        if (cursor.pendingTrees.length + cursor.pendingBlobs.length >= AGENT_SCAN_LIMITS.queuedEntries) { cursor.coverageLimited = true; break; }
        if (entry.type === 'tree' && entry.mode === '040000' && traversable(path)) cursor.pendingTrees.push({ path, sha: entry.sha });
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) continue;
        if (scope && !path.startsWith(scope + '/')) continue;
        const match = matchAgentArtifact(scope ? path.slice(scope.length + 1) : path, entry.mode, entry.type);
        if (!match.rule || ['example_only', 'unsupported', 'symlink', 'submodule'].includes(match.classification)) continue;
        if (!Number.isSafeInteger(entry.size) || entry.size! < 0 || entry.size! > AGENT_SCAN_LIMITS.fileBytes) { cursor.coverageLimited = true; continue; }
        cursor.pendingBlobs.push({ path, sha: entry.sha, size: entry.size!, ruleId: match.rule.id });
        if (cursor.pendingBlobs.length + cursor.pendingTrees.length > AGENT_SCAN_LIMITS.queuedEntries) { cursor.coverageLimited = true; cursor.pendingBlobs = cursor.pendingBlobs.slice(0, AGENT_SCAN_LIMITS.queuedEntries); cursor.pendingTrees = cursor.pendingTrees.slice(0, Math.max(0, AGENT_SCAN_LIMITS.queuedEntries - cursor.pendingBlobs.length)); break; }
      }
    }
  }
  result.state = !cursor.pendingTrees.length && !cursor.pendingBlobs.length && !cursor.pendingCommits?.length && !cursor.coverageLimited ? 'complete' : 'partial';
  result.cursor = result.state === 'complete' ? null : cursor;
  return result;
}
