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
vi.mock('@/lib/crawl/agent-review-repository', () => ({ reviewApprovalPredicate: vi.fn(), currentReviewSource: vi.fn() }));
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
  // 2026-11-09 운영자 결정: 근거가 24시간 지났다는 것만으로 버리지 않는다 — 결정은 적용하고 근거 나이를 감사에 남긴다
  const agedBy = (hours: number) => {
    const validUntil = new Date(Date.now() - (hours - 24) * 3600_000);
    current.input.validUntil = validUntil; reads = [[{ id: 7, state: 'running', ...input, validUntil, startedAt: new Date() }]];
  };
  it('applies a decision made on evidence older than 24h and records its age', async () => {
    agedBy(54);
    expect(await recordHumanReview(claim, success, { repoCheck: { check: 'present', retryAt: null } })).toBe('applied');
    expect(mocks.current).toHaveBeenCalledWith(expect.anything(), candidate.repo, 'any_age');
    const audit = writes.find(row => row.values.action === 'candidate-deepseek-decision');
    expect(audit?.values.detail).toMatchObject({ evidenceExpired: true, evidenceAgeHours: expect.any(Number) });
    expect((audit?.values.detail as { evidenceAgeHours: number }).evidenceAgeHours).toBeGreaterThanOrEqual(53.9);
    expect(mocks.request).toHaveBeenCalledWith('crawl-publish', expect.anything());
  });
  // 2026-11-09 운영자 결정: 72시간 넘은 근거의 승인은 공개 전에 다시 검수 — 승인하지 않고 사람 큐에 남긴다
  it('holds an approval on evidence older than 72h for a source refresh instead of publishing', async () => {
    agedBy(73);
    expect(await recordHumanReview(claim, success)).toBe('stale');
    expect(writes.some(row => row.values.state === 'approved' || row.values.decidedBy === 'deepseek')).toBe(false);
    expect(writes[0].values).toMatchObject({ state: 'succeeded', reason: 'stale_evidence_refresh', outcome: { decision: 'needs_review' } });
    expect(writes.find(row => row.values.action === 'candidate-deepseek-stale-hold')?.values.detail)
      .toMatchObject({ cause: 'evidence_over_72h', outcome: { decision: 'approve' } });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('closes a rejection whatever the evidence age', async () => {
    agedBy(100);
    expect(await recordHumanReview(claim, { ok: true, outcome: { ...success.outcome, decision: 'reject' } })).toBe('applied');
    expect(writes.some(row => row.values.state === 'rejected' && row.values.decidedBy === 'deepseek')).toBe(true);
  });
  it('routes a 24-72h approval of a repository GitHub no longer has to repo_deleted', async () => {
    agedBy(48);
    expect(await recordHumanReview(claim, success, { repoCheck: { check: 'gone', retryAt: null } })).toBe('repo_gone');
    expect(writes.some(row => row.values.reason === 'repo_deleted' && row.values.state === undefined)).toBe(true);
    expect(writes.some(row => row.values.state === 'approved')).toBe(false);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each([undefined, { check: 'deferred' as const, retryAt: null }])('never publishes a 24-72h approval blind (%s)', async repoCheck => {
    agedBy(48);
    expect(await recordHumanReview(claim, success, repoCheck ? { repoCheck } : {})).toBe('deferred');
    expect(writes).toHaveLength(1);
    expect(writes[0].values).toMatchObject({ state: 'superseded', errorCode: 'repo_check_deferred', retryAfter: expect.any(Date) });
  });
  it('holds a renamed/archived repository for a refresh', async () => {
    agedBy(48);
    expect(await recordHumanReview(claim, success, { repoCheck: { check: 'changed', retryAt: null } })).toBe('stale');
    expect(writes.some(row => row.values.state === 'approved')).toBe(false);
  });
  it.each(['switch-off', 'off-on', 'human', 'source', 'candidate', 'draining'])('discards a late result after %s', async change => {
    if (change === 'switch-off') current.settings.humanReview.enabled = false;
    if (change === 'off-on') current.settings.humanReview.generation = 5;
    if (change === 'human') current.candidate.decidedBy = 'admin';
    if (change === 'source') current.input.sourceRevisionHash = 'different';
    if (change === 'candidate') current.candidate.reason = 'suspected_spam';
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

// 0173: 위임 시도를 succeeded 로 닫을 때 모델의 원래 답과 남긴 까닭을 model_outcome 에 적는다 — 결정·적용은 그대로다
describe('delegated model outcome', () => {
  const attemptWrite = () => writes.find(row => row.values.state === 'succeeded')?.values;
  const agedBy = (hours: number) => {
    const validUntil = new Date(Date.now() - (hours - 24) * 3600_000);
    current.input.validUntil = validUntil; reads = [[{ id: 7, state: 'running', ...input, validUntil, startedAt: new Date() }]];
  };
  it('applied approve and reject keep no hold cause', async () => {
    expect(await recordHumanReview(claim, { ...success, original: success.outcome })).toBe('applied');
    expect(attemptWrite()?.modelOutcome).toEqual({ decision: 'approve', confidence: 0.97, holdCause: null });
    writes = []; reads = [[{ id: 7, state: 'running', ...input }]];
    expect(await recordHumanReview(claim, { ok: true, outcome: { ...success.outcome, decision: 'reject', confidence: 0.93 } })).toBe('applied');
    expect(attemptWrite()?.modelOutcome).toEqual({ decision: 'reject', confidence: 0.93, holdCause: null });
  });
  it('a low-confidence approval keeps the model decision the transport turned into needs_review', async () => {
    const original = { ...success.outcome, confidence: 0.8 };
    expect(await recordHumanReview(claim, { ok: true, outcome: { ...original, decision: 'needs_review' }, original })).toBe('held');
    expect(attemptWrite()).toMatchObject({ outcome: { decision: 'needs_review' },
      modelOutcome: { decision: 'approve', confidence: 0.8, holdCause: 'low_confidence' } });
    expect(writes.some(row => row.values.state === 'approved')).toBe(false);
  });
  it('a model abstention is model_abstained, an approval on a human-only reason is cannot_approve', async () => {
    const abstain = { decision: 'needs_review' as const, reason: 'Unclear', evidenceIds: [], confidence: 0.6 };
    expect(await recordHumanReview(claim, { ok: true, outcome: abstain, original: abstain })).toBe('held');
    expect(attemptWrite()?.modelOutcome).toEqual({ decision: 'needs_review', confidence: 0.6, holdCause: 'model_abstained' });
    current.candidate.reason = 'suspected_spam'; writes = []; reads = [[{ id: 7, state: 'running', ...input }]];
    expect(await recordHumanReview({ ...claim, candidateRevision: JSON.stringify(current.candidate) }, success)).toBe('held');
    expect(attemptWrite()?.modelOutcome).toEqual({ decision: 'approve', confidence: 0.97, holdCause: 'cannot_approve' });
    expect(writes.some(row => row.values.state === 'approved')).toBe(false);
  });
  it.each([[73, undefined, 'stale', 'stale_evidence'], [48, 'changed', 'stale', 'repo_changed'], [48, 'gone', 'repo_gone', 'repo_gone']] as const)(
    'an approval on %sh evidence (repo check %s) ends %s with %s', async (hours, check, state, holdCause) => {
      agedBy(hours);
      expect(await recordHumanReview(claim, success, check ? { repoCheck: { check, retryAt: null } } : {})).toBe(state);
      expect(attemptWrite()).toMatchObject({ outcome: { decision: 'needs_review' }, modelOutcome: { decision: 'approve', confidence: 0.97, holdCause } });
    });
  it('failed, superseded and repo-check-deferred attempts write no model outcome', async () => {
    expect(await recordHumanReview(claim, { ok: false, error: 'timeout' })).toBe('failed');
    agedBy(48);
    expect(await recordHumanReview(claim, success)).toBe('deferred');
    reads = [[{ id: 7, state: 'running', ...input }]]; current.settings.humanReview.generation = 5;
    expect(await recordHumanReview(claim, success)).toBe('superseded');
    expect(writes.map(row => row.values.state)).toEqual(['failed', 'superseded', 'superseded']);
    expect(writes.some(row => 'modelOutcome' in row.values)).toBe(false);
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
  // 보류 Qwen-v2 재심사가 맡은 사유는 그쪽이 끝내기 전에는 DeepSeek 이 집지 않는다 — 같은 잠긴 설정으로 재고, 끄면 다시 DeepSeek 몫이다
  it('leaves reasons owned by the held Qwen-v2 retry alone', async () => {
    const owned = { ...current.settings, reviewMode: 'enforce', qwenAuto: { heldRetry: { enabled: true, perTick: 10,
      budgetSeconds: 40, reasons: ['no_description', 'ai_review_exhausted', 'ambiguous'] } } };
    current.candidate.reason = 'ai_review_exhausted';
    current.settings = owned as typeof current.settings;
    reads = [[], [], []];
    expect(await claimHumanReview(candidate.repo, lease)).toBeNull(); expect(writes).toHaveLength(0);
    current.settings = { ...owned, qwenAuto: { ...owned.qwenAuto, heldRetry: { ...owned.qwenAuto.heldRetry, enabled: false } } } as typeof current.settings;
    expect(await claimHumanReview(candidate.repo, lease)).toMatchObject({ attemptId: 7 });
  });
  // 2026-11-10 운영자 결정: Qwen-v2 가 지금 입력에서 끝냈으면(판단 보류·승인 의견·실패 상한) DeepSeek 이 이어 본다 — 잠긴 후보 아래에서 다시 잰다
  it('takes an owned reason once the held Qwen-v2 retry has concluded on this input', async () => {
    current.candidate.reason = 'no_description';
    current.settings = { ...current.settings, reviewMode: 'enforce', qwenAuto: { heldRetry: { enabled: true, perTick: 10,
      budgetSeconds: 40, reasons: ['no_description', 'ai_review_exhausted', 'ambiguous'] } } } as typeof current.settings;
    const qwen = { kind: 'delegated', provider: 'qwen-direct', actor: 'qwen-v2:2026-10-21.v2', model: 'qwen', errorCode: null, outcome: null };
    const failed = { ...qwen, state: 'failed', errorCode: 'qwen_invalid_json' };
    // 보는 중 · 다시 볼 실패가 남음 · 세지 않는 실패 · 다른 일(갈림 판가름)의 판단 — Qwen-v2 가 끝낸 것이 아니다
    for (const rows of [[{ ...qwen, state: 'running' }], [failed, failed], [{ ...qwen, state: 'failed', errorCode: 'qwen_timeout' }],
      [{ ...qwen, actor: 'qwen-v2-auto', state: 'succeeded', outcome: { decision: 'needs_review' } }]]) {
      reads = [rows];
      expect(await claimHumanReview(candidate.repo, lease)).toBeNull();
    }
    expect(writes).toHaveLength(0);
    // 판단 보류 · 소개 없음의 승인 의견 · 세는 실패 상한 — 끝냈다
    for (const rows of [[{ ...qwen, state: 'succeeded', outcome: { decision: 'needs_review' } }],
      [{ ...qwen, state: 'succeeded', outcome: { decision: 'approve' } }], [failed, failed, failed]]) {
      reads = [rows, [], [], []]; writes = [];
      expect(await claimHumanReview(candidate.repo, lease)).toMatchObject({ attemptId: 7 });
      expect(writes[0].values).toMatchObject({ kind: 'delegated', state: 'running', actor: 'm3-deepseek:3' });
    }
  });
  it('claims an input whose evidence is older than 24h — no time cut for this job', async () => {
    current.input.validUntil = new Date(Date.now() - 72 * 3600_000);
    reads = [[], [], []];
    expect(await claimHumanReview(candidate.repo, lease)).toMatchObject({ attemptId: 7 });
    expect(mocks.current).toHaveBeenCalledWith(expect.anything(), candidate.repo, 'any_age');
    expect(writes[0].values).toMatchObject({ validUntil: current.input.validUntil });
  });
  it('claims the shared candidate slot with exact source, generation and lease', async () => {
    reads = [[], [], []];
    expect(await claimHumanReview(candidate.repo, lease)).toMatchObject({ attemptId: 7, generation: 3, lease });
    expect(writes[0].values).toMatchObject({ kind: 'delegated', state: 'running', actor: 'm3-deepseek:3', leaseToken: 'owned',
      inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash });
  });
});
