import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { boundaryFixture } from './fixtures/provider-boundary-release';
import { providerBoundaryCanonicalHash, providerBoundaryPlanHash } from '@/lib/llm/provider-boundary-contract';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), replay: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { transaction: (load: (tx: unknown) => unknown) => load({ execute: mocks.execute }) }, onPrimary: (load: () => unknown) => load() }));
vi.mock('@/lib/db/replay-scope', () => ({ currentReplayDb: mocks.replay }));
import { readCommittedRelayBoundaryProof } from '@/lib/operations/dr/provider-boundary-relay';
const f = boundaryFixture();
const input = () => ({ ...f, expectedPlanHash: providerBoundaryPlanHash(f.plan), operator: 'fixture', reference: 'test-only observed exit' });
function row() {
  const evidence = { kind: 'provider_boundary_exit', plan: f.plan, receipt: f.receipt, operator: input().operator, reference: input().reference };
  return { state: 'withdrawn', unsettled: true, event_matches: true, binding_hash: f.plan.request.bindingHash,
    binding: { wireHash: 'b'.repeat(64), model: 'Fixture Model', servingContractHash: f.plan.request.servingContractHash }, evidence,
    evidence_hash: providerBoundaryCanonicalHash(evidence) };
}
beforeEach(() => { vi.resetAllMocks(); mocks.replay.mockReturnValue(undefined); });
function reply(value: unknown) { mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce(value ? [value] : []); }
it('issues a marker repair proof only from the exact committed primary row and release event', async () => {
  reply(row());
  expect(await readCommittedRelayBoundaryProof(input())).toEqual({ requestId: f.plan.request.requestId, planHash: input().expectedPlanHash,
    bindingHash: f.plan.request.bindingHash, wireHash: 'b'.repeat(64), model: 'Fixture Model', releaseEvidenceHash: row().evidence_hash });
  const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[1][0]).sql;
  expect(query).toContain("e.kind = 'dispatch_released'"); expect(query).toContain('e.evidence = r.terminal_evidence');
  expect(query).not.toMatch(/\b(?:UPDATE|INSERT|DELETE)\b|r\.token/);
});
it.each([null, { state: 'indeterminate' }, { state: 'settled' }, { event_matches: false }, { unsettled: false },
  { binding_hash: '0'.repeat(64) }, { evidence_hash: '0'.repeat(64) }, { evidence: { ...row().evidence, reference: 'another operation' } },
  { binding: { ...row().binding, servingContractHash: '0'.repeat(64) } },
])('refuses a missing, rolled-back, unrelated or incomplete DB readback %j', patch => {
  reply(patch === null ? null : { ...row(), ...patch });
  return expect(readCommittedRelayBoundaryProof(input())).rejects.toThrow('relay_recovery_committed_release_missing');
});
it('refuses wrong plan and replay before querying the database', async () => {
  await expect(readCommittedRelayBoundaryProof({ ...input(), expectedPlanHash: '0'.repeat(64) })).rejects.toThrow('relay_recovery_plan_mismatch');
  mocks.replay.mockReturnValue({});
  await expect(readCommittedRelayBoundaryProof(input())).rejects.toThrow('relay_recovery_replay_unsupported');
  expect(mocks.execute).not.toHaveBeenCalled();
});
