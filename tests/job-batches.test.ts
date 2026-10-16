import { expect, it } from 'vitest';
import { jobsForRole } from '@/lib/jobs/catalog';
import { batchJobsForRole, batchLanesForRole, batchRoleForJob, batchHostOrder, classifyBatchReadiness, batchPolicySchema } from '@/lib/jobs/batches';

it('routes only the canonical job to the versioned site role and keeps legacy/draining closed', () => {
  expect(batchJobsForRole('site-evidence', 'versioned')).toEqual(['product-site-evidence-refresh']);
  expect(batchLanesForRole('site-evidence', 'versioned')).toEqual([['product-site-evidence-refresh']]);
  expect(batchRoleForJob('product-site-evidence-refresh')).toBe('site-evidence');
  expect(batchJobsForRole('site-evidence', 'legacy')).toEqual([]);
  expect(batchJobsForRole('site-evidence', 'draining')).toEqual([]);
  expect(batchJobsForRole('crawler', 'versioned')).toContain('product-evidence-refresh');
  expect(batchJobsForRole('crawler', 'versioned')).not.toContain('product-site-evidence-refresh');
});

function publisherReadinessInput() {
  const host = 'm3' as const;
  const instanceId = 'm3-publisher';
  const release = 'r1';
  const job = 'crawl-publish';
  return {
    role: 'publisher' as const, host, instanceId, release,
    at: Date.parse('2026-10-16T12:00:00Z'),
    evidence: { host, instanceId, release, dbPrivileges: 'verified', dbRole: 'fixture-only',
      effectivePrivilegeHash: 'a'.repeat(64), http: 'verified', model: 'verified',
      modelBoundEvidenceHash: 'b'.repeat(64), observedAt: '2026-10-16T11:59:30Z' },
    result: { job, role: 'publisher', batchEpoch: 1, host, instanceId, bootId: 'boot-1', release,
      recordedAt: '2026-10-16T11:59:40Z', count: 1, requestedVersion: 1 },
    readback: { job, instanceId, host, release, requestedVersion: 1,
      domainReadbackHash: 'c'.repeat(64), observedAt: '2026-10-16T11:59:50Z' },
  };
}

it('accepts a publisher with verified bound model evidence and actual result readback', () => {
  expect(classifyBatchReadiness(publisherReadinessInput())).toEqual({ ready: true, reason: 'ready' });
});

it('rejects publisher readiness when the model dependency is unknown', () => {
  const input = publisherReadinessInput();
  expect(classifyBatchReadiness({ ...input, evidence: { ...input.evidence, model: 'unknown' } }))
    .toEqual({ ready: false, reason: 'capability_unknown' });
});

it('rejects publisher readiness without the model bound evidence hash', () => {
  const input = publisherReadinessInput();
  const { modelBoundEvidenceHash: _hash, ...evidence } = input.evidence;
  expect(classifyBatchReadiness({ ...input, evidence })).toEqual({ ready: false, reason: 'capability_unknown' });
});

it('preserves legacy roles and separates only the three translation jobs in version one', () => {
  expect(batchJobsForRole('text', 'legacy')).toEqual(jobsForRole('text'));
  expect(batchJobsForRole('translation', 'versioned')).toEqual(['reason-translate', 'product-tagline-ko', 'product-translate']);
  expect(batchJobsForRole('text', 'versioned')).not.toContain('reason-translate');
  expect(batchJobsForRole('text', 'versioned')).toContain('crawl-tagline');
  expect(batchJobsForRole('translation', 'legacy')).toEqual([]);
  expect(batchJobsForRole('maintenance', 'versioned')).not.toContain('uptime-ping');
  expect(batchJobsForRole('product-health', 'versioned')).toEqual(['uptime-ping']);
  expect(batchJobsForRole('official-news', 'versioned')).toEqual(['news-refresh']);
  expect(batchJobsForRole('site-evidence', 'versioned')).toEqual(['product-site-evidence-refresh']);
  expect(batchJobsForRole('translation', 'draining')).toEqual([]);
});
it('uses fixed physical host rankings rather than primary boolean or alphabetic instance names', () => {
  expect(batchHostOrder('translation')).toEqual(['oracle-osaka-smoke', 'm3', 'mini']);
  expect(batchHostOrder('crawler')).toEqual(['mini', 'm3', 'oracle-osaka-smoke']);
  expect(batchHostOrder('publisher')).toEqual(['m3', 'mini', 'oracle-osaka-smoke']);
});
it('rejects unknown hosts, duplicate instances and arbitrary role overrides', () => {
  const policy = { version: 1, release: 'r1', instances: [{ instanceId: 'oracle-text', host: 'oracle-osaka-smoke' }] };
  expect(batchPolicySchema.parse(policy)).toEqual(policy);
  expect(batchPolicySchema.safeParse({ ...policy, instances: [{ instanceId: 'x', host: 'onetwoday' }] }).success).toBe(false);
  expect(batchPolicySchema.safeParse({ ...policy, instances: [policy.instances[0], policy.instances[0]] }).success).toBe(false);
  expect(batchPolicySchema.safeParse({ ...policy, jobs: { 'crawl-tagline': 'translation' } }).success).toBe(false);
});
it('keeps installation, a healthy heartbeat and zero-work tick distinct from actual ready evidence', () => {
  const input = { role: 'translation' as const, host: 'oracle-osaka-smoke' as const, instanceId: 'oracle-text', release: 'r1',
    at: Date.parse('2026-10-16T12:00:00Z'), evidence: null, result: null };
  expect(classifyBatchReadiness(input)).toEqual({ ready: false, reason: 'capability_unknown' });
  expect(classifyBatchReadiness({ ...input, evidence: { host: input.host, release: 'r1', instanceId: input.instanceId,
    dbPrivileges: 'unknown', http: 'verified', model: 'unknown', observedAt: '2026-10-16T11:59:30Z' } })).toEqual({ ready: false, reason: 'capability_unknown' });
});
it('requires fresh host/release-specific actual positive results in addition to privilege and dependency evidence', () => {
  const at=Date.parse('2026-10-16T12:00:00Z');
  const evidence={host:'oracle-osaka-smoke',instanceId:'oracle-text',release:'r1',dbPrivileges:'verified',dbRole:'fixture-only',effectivePrivilegeHash:'a'.repeat(64),modelBoundEvidenceHash:'b'.repeat(64),http:'verified',model:'verified',observedAt:'2026-10-16T11:59:30Z'};
  const result={job:'reason-translate',role:'text',batchEpoch:1,host:'oracle-osaka-smoke',instanceId:'oracle-text',bootId:'boot-1',release:'r1',recordedAt:'2026-10-16T11:59:40Z',count:1,requestedVersion:1};
  const input={role:'translation' as const,host:'oracle-osaka-smoke' as const,instanceId:'oracle-text',release:'r1',at,evidence,result,readback:{job:result.job,instanceId:result.instanceId,host:result.host,release:result.release,requestedVersion:1,domainReadbackHash:'c'.repeat(64),observedAt:'2026-10-16T11:59:50Z'}};
  expect(classifyBatchReadiness(input)).toEqual({ready:true,reason:'ready'});
  for(const patch of [{count:0},{host:'m3'},{release:'r0'},{job:'crawl-tagline'}])expect(classifyBatchReadiness({...input,result:{...result,...patch}}).ready).toBe(false);
  expect(classifyBatchReadiness({...input,result:null}).ready).toBe(false);
  expect(classifyBatchReadiness({...input,readback:null}).reason).toBe('result_unverified');
  expect(classifyBatchReadiness({...input,at:at+24*60*60_000}).reason).toBe('capability_stale');
});
