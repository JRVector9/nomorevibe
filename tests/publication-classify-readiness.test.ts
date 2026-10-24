import { describe, expect, it } from 'vitest';
import { usedModelRoutes, modelRouteContracts, type ControlSnapshot } from '@/lib/operations/pipeline-control';
import type { ModelCapacityPolicy } from '@/lib/llm/capacity';

const now = '2026-10-24T15:00:00.000Z', routeId = 'crawl-publish-classify';
const config = { primary: { model: 'gpt-5.6-terra', effort: 'xhigh' }, fallback: { model: 'sonnet', effort: 'high' } };
const codex = { version: 1, protocol: 'cli-process-v1', routeId, provider: 'codex-cli', model: 'gpt-5.6-terra',
  cliVersion: 'codex-cli 0.153.4', inputByteCap: 64_000, totalTokenBound: 200_000, costBoundUsdMicros: null, boundProvenance: 'declared' };
const claude = { version: 1, protocol: 'cli-process-v1', routeId, provider: 'claude-cli', model: 'sonnet',
  cliVersion: '2.1.263 (Claude Code)', inputByteCap: 64_000, totalTokenBound: 200_000, costBoundUsdMicros: null, boundProvenance: 'derived',
  maxTurns: 2, outputTokensPerTurn: 4000, overheadTokenBound: 20_000 };
const observation = (extra: Record<string, unknown> = {}) => ({ observedAt: now, value: { status: 'running', config,
  classifyReady: true, busy: null, classificationCapacityVersion: 1, classificationContracts: [codex, claude], ...extra } });
const snapshot = (classificationObservations?: unknown): ControlSnapshot => ({ now, reviewSettings: null, auditCampaign: null,
  classificationObservations } as ControlSnapshot);
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { cli: 2 }, groupLimits: { classifier: 2 },
  poolLimits: { reviewer: 2, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4, queueTtlMs: 1000, reservationTtlMs: 1000,
  routes: [codex, claude].map(({ provider, model }) => ({ routeId, provider, model, providerBudgetId: 'cli', groupId: 'classifier' })) };
const rows = (value: ControlSnapshot, p: ModelCapacityPolicy = policy) => modelRouteContracts(p, 'items', usedModelRoutes(value, null))
  .filter(route => route.routeId === routeId && route.status !== 'unused');
describe('external classifier stays in the capacity readiness denominator', () => {
  it('reports an unknown caller when the remote configuration cannot be read', () => {
    expect(rows(snapshot())).toEqual([{ routeId, provider: 'unknown', model: null, status: 'unknown' }]);
  });
  it('requires fresh remote contracts for both actually selected primary and fallback', () => {
    expect(rows(snapshot([observation()])).map(route => route.status)).toEqual(['serving', 'serving']);
    expect(rows(snapshot([observation({ classificationContracts: [codex] })])).map(route => route.status)).toEqual(['serving', 'no_contract']);
    expect(rows(snapshot([observation({ classificationCapacityVersion: undefined })])).every(route => route.status === 'no_contract')).toBe(true);
    expect(rows(snapshot([observation()]), { ...policy, routes: policy.routes.slice(0, 1) }).some(route => route.status === 'unmapped')).toBe(true);
  });
  it('does not trust an old, future or ambiguous observation or a local-only matching contract', () => {
    for (const observations of [[{ ...observation(), observedAt: '2026-10-24T14:59:00.000Z' }],
      [{ ...observation(), observedAt: '2026-10-24T15:01:00.000Z' }], [observation(), observation()],
      [observation({ classificationContracts: [{ ...codex, cliVersion: '' }, claude] })]])
      expect(rows(snapshot(observations)).every(route => route.status !== 'serving')).toBe(true);
  });
});
