import { describe, expect, it, vi } from 'vitest';
import { collectRepositoryAgentEvidence } from '@/lib/domain/evidence/agents/collect';
import type { GitHubHttpResult } from '@/lib/crawl/github';
const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40), BLOB = 'c'.repeat(40);
function mockRequest(options: { truncated?: boolean; limited?: boolean; symlink?: boolean } = {}) {
  const paths: string[] = [];
  const request = async <T>(path: string): Promise<GitHubHttpResult<T>> => {
    paths.push(path);
    if (options.limited) return { ok: false, error: { kind: 'rate_limited', resetAt: new Date('2026-09-07') } };
    let value: unknown;
    if (path === '/repos/acme/app') value = { id: 12, private: false, full_name: 'acme/app', default_branch: 'main' };
    else if (path.includes('/commits/')) value = { sha: COMMIT, commit: { tree: { sha: TREE } } };
    else if (path.includes('/git/trees/')) value = { truncated: options.truncated ?? false, tree: [
      { path: 'AGENTS.md', sha: BLOB, type: 'blob', mode: options.symlink ? '120000' : '100644', size: 10 },
      { path: '.env', sha: 'd'.repeat(40), type: 'blob', mode: '100644', size: 20 },
    ] };
    else value = { encoding: 'base64', size: 10, content: Buffer.from('# Rules').toString('base64') };
    return { ok: true, status: 200, value: value as T, etag: null, lastModified: null, link: null };
  };
  return { paths, request };
}
describe('bounded GitHub agent collector', () => {
  it('reports budget exhaustion before branch resolution instead of an unexplained failed scan', async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const mock = mockRequest();
    const request = async <T>(path: string): Promise<GitHubHttpResult<T>> => {
      const response = await mock.request<T>(path);
      now += 2_000;
      return response;
    };
    try {
      const result = await collectRepositoryAgentEvidence({ repositoryKey: 'acme/app', request, deadlineAt: now + 9_000 });
      expect(result).toMatchObject({ state: 'partial', errorCode: 'budget_exhausted', commitSha: null, cursor: null, requestCount: 1 });
      expect(mock.paths).toEqual(['/repos/acme/app']);
    } finally { clock.mockRestore(); }
  });
  it('pins the branch before tree/blob reads and never reads env files', async () => {
    const mock = mockRequest();
    const result = await collectRepositoryAgentEvidence({ repositoryKey: 'acme/app', request: mock.request });
    expect(result.state).toBe('complete');
    expect(result.commitSha).toBe(COMMIT);
    expect(result.observations[0]?.commitSha).toBe(COMMIT);
    expect(mock.paths.some(p => p.includes('/.env'))).toBe(false);
    expect(mock.paths.every(p => p.startsWith('/repos/acme/app'))).toBe(true);
  });
  it('does not collect a private repository accessible to the configured token', async () => {
    const request = async <T>(): Promise<GitHubHttpResult<T>> => ({ ok: true, status: 200, value: { id: 12, private: true, default_branch: 'main' } as T, etag: null, lastModified: null, link: null });
    const result = await collectRepositoryAgentEvidence({ repositoryKey: 'acme/app', request });
    expect(result.state).toBe('failed');
    expect(result.observations).toHaveLength(0);
    expect(result.requestCount).toBe(1);
  });
  it('rechecks visibility before resuming a previously public repository', async () => {
    const first = await collectRepositoryAgentEvidence({ repositoryKey: 'acme/app', request: mockRequest().request, maxRequests: 3 });
    let requests = 0;
    const request = async <T>(): Promise<GitHubHttpResult<T>> => { requests++; return { ok: true, status: 200, value: { id: 12, private: true } as T, etag: null, lastModified: null, link: null }; };
    const resumed = await collectRepositoryAgentEvidence({ repositoryKey: 'acme/app', request, cursor: first.cursor });
    expect(resumed.state).toBe('partial');
    expect(resumed.observations).toHaveLength(0);
    expect(requests).toBe(1);
  });
  it('does not claim complete coverage for a truncated nonrecursive tree', async () => {
    const result = await collectRepositoryAgentEvidence({ repositoryKey: 'acme/app', request: mockRequest({ truncated: true }).request });
    expect(result.state).toBe('partial');
    expect(result.cursor?.commitSha).toBe(COMMIT);
  });
  it('does not follow symlinks', async () => {
    const mock = mockRequest({ symlink: true });
    const result = await collectRepositoryAgentEvidence({ repositoryKey: 'acme/app', request: mock.request });
    expect(result.observations).toHaveLength(0);
    expect(mock.paths.some(p => p.includes('/git/blobs/'))).toBe(false);
  });
  it('preserves rate-limit retry time and reports failed rather than absent', async () => {
    const result = await collectRepositoryAgentEvidence({ repositoryKey: 'acme/app', request: mockRequest({ limited: true }).request });
    expect(result.state).toBe('failed');
    expect(result.errorCode).toBe('rate_limited');
    expect(result.retryAt).toEqual(new Date('2026-09-07'));
  });
  it('skips immutable tree and blobs when the complete SHA is unchanged', async () => {
    const mock = mockRequest();
    const result = await collectRepositoryAgentEvidence({ repositoryKey: 'acme/app', request: mock.request, knownComplete: { repositoryId: '12', commitSha: COMMIT } });
    expect(result.state).toBe('complete');
    expect(mock.paths).toHaveLength(2);
    expect(result.fileCount).toBe(0);
  });
  it.each(['ahead', 'identical', 'diverged', 'behind'])('requires default-branch reachability for a commit attribution (%s)', async status => {
    const mock = mockRequest();
    const discovered = 'e'.repeat(40);
    const request = async <T>(path: string): Promise<GitHubHttpResult<T>> => {
      let value: unknown;
      if (path.endsWith('/commits/' + discovered)) value = { sha: discovered, commit: { message: 'Fix app\n\nCo-authored-by: Qwen-Coder <qwen@example.com>' }, parents: [{ sha: 'f'.repeat(40) }] };
      else if (path.includes('/compare/')) value = { status };
      else return mock.request<T>(path);
      return { ok: true, status: 200, value: value as T, etag: null, lastModified: null, link: null };
    };
    const first = await collectRepositoryAgentEvidence({ repositoryKey: 'acme/app', request, discoveryCommitShas: [discovered], knownComplete: { repositoryId: '12', commitSha: COMMIT }, maxRequests: 3 });
    expect(first.state).toBe('partial');
    expect(first.observations).toHaveLength(0); // Parsed trailer alone is insufficient.
    const result = await collectRepositoryAgentEvidence({ repositoryKey: 'acme/app', request, cursor: first.cursor });
    expect(result.state).toBe('complete');
    expect(result.observations).toHaveLength(['ahead', 'identical'].includes(status) ? 1 : 0);
    if (result.observations.length) expect(result.observations[0]).toMatchObject({ kind: 'commit_attribution', client: 'qwen-code', declaredModelId: null, commitSha: discovered });
  });
  it.each([{ labels: Array.from({ length: 1000 }, (_, i) => `Claude Opus ${i}`), expected: 1, state: 'complete' }, { labels: ['Claude', 'Codex', 'Kimi', 'Grok', 'Cursor', 'Cline', 'Roo Code', 'Aider', 'Goose'], expected: 8, state: 'partial' }])('bounds commit client observations ($expected)', async ({ labels, expected, state }) => {
    const mock = mockRequest();
    const discovered = 'e'.repeat(40);
    const message = 'Fix\n\n' + labels.map(label => `Co-authored-by: ${label} <agent@example.com>`).join('\n');
    const request = async <T>(path: string): Promise<GitHubHttpResult<T>> => {
      let value: unknown;
      if (path.endsWith('/commits/' + discovered)) value = { sha: discovered, commit: { message }, parents: [{}] };
      else if (path.includes('/compare/')) value = { status: 'ahead' };
      else return mock.request<T>(path);
      return { ok: true, status: 200, value: value as T, etag: null, lastModified: null, link: null };
    };
    const result = await collectRepositoryAgentEvidence({ repositoryKey: 'acme/app', request, discoveryCommitShas: [discovered], knownComplete: { repositoryId: '12', commitSha: COMMIT } });
    expect(result.observations).toHaveLength(expected);
    expect(result.observations[0].declaredModelId).toBeNull();
    expect(result.state).toBe(state);
  });
  it('ignores merge commits even if a search found a coauthor trailer', async () => {
    const mock = mockRequest();
    const discovered = 'e'.repeat(40);
    let compared = false;
    const request = async <T>(path: string): Promise<GitHubHttpResult<T>> => {
      if (path.includes('/compare/')) compared = true;
      if (!path.endsWith('/commits/' + discovered)) return mock.request<T>(path);
      return { ok: true, status: 200, value: { sha: discovered, commit: { message: 'Merge\n\nCo-authored-by: Codex <codex@example.com>' }, parents: [{}, {}] } as T, etag: null, lastModified: null, link: null };
    };
    const result = await collectRepositoryAgentEvidence({ repositoryKey: 'acme/app', request, discoveryCommitShas: [discovered], knownComplete: { repositoryId: '12', commitSha: COMMIT } });
    expect(result.observations).toHaveLength(0);
    expect(compared).toBe(false);
  });
  it('resumes a pinned cursor without resolving a moving branch again', async () => {
    const mock = mockRequest();
    const first = await collectRepositoryAgentEvidence({ repositoryKey: 'acme/app', request: mock.request, maxRequests: 3 });
    expect(first.state).toBe('partial');
    const resume = mockRequest();
    const result = await collectRepositoryAgentEvidence({ repositoryKey: 'acme/app', request: resume.request, cursor: first.cursor });
    expect(result.state).toBe('complete');
    expect(result.commitSha).toBe(COMMIT);
    expect(resume.paths.some(p => p.includes('/commits/'))).toBe(false);
  });
});
