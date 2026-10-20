import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewInput } from '@/lib/crawl/agent-review-contract';
import type { HumanReviewClaim } from '@/lib/crawl/human-review-repository';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), current: vi.fn(), lease: vi.fn(), stage: vi.fn(), request: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { transaction: mocks.transaction } }));
vi.mock('@/lib/jobs/control', () => ({ assertJobLeaseAtWallTime: mocks.lease, requestJob: mocks.request }));
vi.mock('@/lib/jobs/items/repository', () => ({ readItemStage: mocks.stage }));
vi.mock('@/lib/crawl/admin-review', () => ({ lockedInput: mocks.current, candidateRevisionHash: (candidate: unknown) => JSON.stringify(candidate) }));
vi.mock('@/lib/crawl/pipeline-stage-context', () => ({ lockPipelineInputStages: async () => ({ ai1: {}, ai2: {} }) }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: vi.fn() }));
vi.mock('@/lib/crawl/agent-review-repository', () => ({ reviewApprovalPredicate: vi.fn() }));
vi.mock('@/lib/crawl/rules', () => ({ judgeRevision: () => 'document-revision' }));

import { claimHumanReview, recordHumanReview } from '@/lib/crawl/human-review-repository';

const input = { inputHash: 'a'.repeat(64), policyHash: 'b'.repeat(64), sourceRevisionHash: 'c'.repeat(64),
  source: {}, snapshot: { evidence: [], policy: { enforceEligibility: false } }, validUntil: new Date(Date.now() + 3600_000),
} as unknown as ReviewInput;
const lease = { name: 'human-deepseek-review', token: 'owned', requestedVersion: 1 };
const candidate = { id: 5, repo: 'owner/app', state: 'needs_review', decidedBy: 'auto', reason: 'second_review_split',
  productUrl: 'https://example.test', publishedSlug: null, signals: {}, judgedAt: new Date('2026-10-19T00:00:00Z') };
const claim = { repo: candidate.repo, attemptId: 7, generation: 3, input, lease, candidateRevision: JSON.stringify(candidate) } as HumanReviewClaim;
const success = { ok: true as const, outcome: { decision: 'approve' as const, reason: 'Working product page', evidenceIds: ['product'], confidence: 0.97 } };
let current: { candidate: typeof candidate; settings: { enabled: boolean; humanReview: { enabled: boolean; generation: number } }; input: ReviewInput; document: { productUrl: string } };
let reads: unknown[][];
let writes: { table: unknown; values: Record<string, unknown> }[];

function chain(rows: unknown[] = []) {
  const q: Record<string, unknown> = {};
  for (const name of ['from', 'where', 'for', 'orderBy', 'limit']) q[name] = () => q;
  q.then = (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
  q.returning = () => Promise.resolve([{ id: 7 }]);
  return q;
}
beforeEach(() => {
  vi.clearAllMocks();
  current = { candidate: structuredClone(candidate), settings: { enabled: true, humanReview: { enabled: true, generation: 3 } },
    input: structuredClone(input), document: { productUrl: candidate.productUrl } };
  reads = [[{ id: 7, state: 'running', ...input }]]; writes = [];
  mocks.current.mockImplementation(async () => current);
  mocks.stage.mockResolvedValue({ mode: 'legacy' }); mocks.lease.mockResolvedValue(undefined);
  mocks.transaction.mockImplementation(async fn => fn({
    select: () => chain(reads.shift() ?? []),
    update: (table: unknown) => ({ set: (values: Record<string, unknown>) => { writes.push({ table, values }); return chain(); } }),
    insert: (table: unknown) => ({ values: (values: Record<string, unknown>) => { writes.push({ table, values }); return chain(); } }),
  }));
});

describe('delegated final write', () => {
  it('records a model decision separately from human overrides and wakes publisher', async () => {
    expect(await recordHumanReview(claim, success)).toBe('applied');
    expect(writes.some(row => row.values.decidedBy === 'deepseek' && row.values.state === 'approved')).toBe(true);
    expect(writes.some(row => row.values.actorKind === 'model')).toBe(true);
    expect(writes.some(row => row.values.kind === 'admin_override' || row.values.decidedBy === 'admin')).toBe(false);
    expect(mocks.request).toHaveBeenCalledWith('crawl-publish', expect.anything());
  });
  it.each(['switch-off', 'off-on', 'human', 'source', 'candidate', 'expired', 'draining'])('discards a late result after %s', async change => {
    if (change === 'switch-off') current.settings.humanReview.enabled = false;
    if (change === 'off-on') current.settings.humanReview.generation = 5;
    if (change === 'human') current.candidate.decidedBy = 'admin';
    if (change === 'source') current.input.sourceRevisionHash = 'different';
    if (change === 'candidate') current.candidate.reason = 'suspected_spam';
    if (change === 'expired') current.input.validUntil = new Date(0);
    if (change === 'draining') mocks.stage.mockResolvedValue({ mode: 'draining' });
    expect(await recordHumanReview(claim, success)).toBe('superseded');
    expect(writes).toHaveLength(1); expect(writes[0].values.state).toBe('superseded');
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('refuses a lost lease before writing', async () => {
    mocks.lease.mockRejectedValue(new Error('lease_lost'));
    await expect(recordHumanReview(claim, success)).rejects.toThrow('lease_lost'); expect(writes).toHaveLength(0);
  });
  it('keeps abstentions and uncertain replies in the queue', async () => {
    expect(await recordHumanReview(claim, { ...success, outcome: { ...success.outcome, confidence: 0.5 } })).toBe('held');
    expect(writes).toHaveLength(1); expect(mocks.request).not.toHaveBeenCalled();
  });
  it('keeps failures in the human queue with a retry deadline', async () => {
    expect(await recordHumanReview(claim, { ok: false, error: 'timeout' })).toBe('failed');
    expect(writes).toHaveLength(1); expect(writes[0].values.retryAfter).toBeInstanceOf(Date);
  });
});

describe('delegated claim', () => {
  it('does not call the model again after a successful abstention', async () => {
    reads = [[], [], [{ state: 'succeeded', outcome: { decision: 'needs_review' } }]];
    expect(await claimHumanReview(candidate.repo, lease)).toBeNull(); expect(writes).toHaveLength(0);
  });
  it('bounds failed attempts and respects retry cooldown', async () => {
    for (const history of [Array(3).fill({ state: 'failed' }), [{ state: 'failed', retryAfter: new Date(Date.now() + 60_000) }]]) {
      reads = [[], [], history];
      expect(await claimHumanReview(candidate.repo, lease)).toBeNull();
    }
    expect(writes).toHaveLength(0);
  });
  it('does not interrupt a live AI1 or pending AI2', async () => {
    reads = [[], [{ kind: 'automatic' }]];
    expect(await claimHumanReview(candidate.repo, lease)).toBeNull();
    reads = [[{ id: 99 }]];
    expect(await claimHumanReview(candidate.repo, lease)).toBeNull(); expect(writes).toHaveLength(0);
  });
  it('claims the shared candidate slot with exact source, generation and lease', async () => {
    reads = [[], [], []];
    expect(await claimHumanReview(candidate.repo, lease)).toMatchObject({ attemptId: 7, generation: 3, lease });
    expect(writes[0].values).toMatchObject({ kind: 'delegated', state: 'running', actor: 'm3-deepseek:3', leaseToken: 'owned',
      inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash });
  });
});
