import { createHash } from 'node:crypto';
import { z } from 'zod';
import { jobsForRole, lanesForRole, JOB_CATALOG, JOB_ROLES, type JobRole } from './catalog';
export const BATCH_ROLES = [...JOB_ROLES, 'translation', 'product-health', 'site-evidence', 'official-news'] as const;
export type BatchRole = typeof BATCH_ROLES[number];
export type BatchMode = 'legacy' | 'draining' | 'versioned';
export const BATCH_HOSTS = ['m3', 'mini', 'oracle-osaka-smoke'] as const;
export type BatchHost = typeof BATCH_HOSTS[number];
export const batchPolicySchema = z.object({ version: z.literal(1), release: z.string().min(1).max(120),
  instances: z.array(z.object({ instanceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/), host: z.enum(BATCH_HOSTS) }).strict()).min(1).max(100)
    .refine(v => new Set(v.map(r => r.instanceId)).size === v.length),
}).strict();
export type BatchPolicy = z.infer<typeof batchPolicySchema>;
export const batchCandidateSchema = z.object({role:z.enum(BATCH_ROLES),instanceId:z.string().min(1).max(48),bootId:z.string().min(1).max(36),release:z.string().min(1).max(120),kind:z.enum(['primary','standby']),batchVersion:z.literal(1),host:z.enum(BATCH_HOSTS)}).strict();
export const batchLeaseSchema=batchCandidateSchema.extend({epoch:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),batchEpoch:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)});
export function batchPolicyHash(value: BatchPolicy): string {
  const checked = batchPolicySchema.parse(value);
  return createHash('sha256').update(JSON.stringify({ ...checked, instances: [...checked.instances].sort((a,b) => a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0) })).digest('hex');
}
const SPLIT_JOBS = {
  translation: ['reason-translate', 'product-tagline-ko', 'product-translate'],
  'product-health': ['uptime-ping'], 'official-news': ['news-refresh'],
  'site-evidence': ['product-site-evidence-refresh'],
} satisfies Record<string, readonly string[]>;
export function batchJobsForRole(role: BatchRole, mode: BatchMode): string[] {
  if (mode === 'draining' || !BATCH_ROLES.includes(role)) return [];
  if (!JOB_ROLES.includes(role as JobRole)) return mode === 'versioned' ? [...SPLIT_JOBS[role as keyof typeof SPLIT_JOBS]] : [];
  const legacy = jobsForRole(role as JobRole);
  return mode === 'legacy' ? legacy : legacy.filter(name => !Object.values(SPLIT_JOBS).some(names => (names as readonly string[]).includes(name)));
}
export function batchLanesForRole(role: BatchRole, mode: BatchMode): string[][] {
  const names = batchJobsForRole(role, mode);
  if (!names.length) return [];
  if (!JOB_ROLES.includes(role as JobRole)) return [names];
  const selected = new Set(names);
  return lanesForRole(role as JobRole).map(lane => lane.filter(name => selected.has(name))).filter(lane => lane.length > 0);
}
export function batchRoleForJob(name: string): BatchRole | undefined { return BATCH_ROLES.find(role => batchJobsForRole(role, 'versioned').includes(name)); }
/** 이 batch 상태에서 일정·실행이 있는 카탈로그 잡. batchVersion 1 잡은 versioned 계약에서만 — scheduler·진행 판정·관리자 목록이 같은 기준을 쓴다 */
export function catalogJobsForBatch(batch: { mode: string; writerContractVersion: number }) {
  return JOB_CATALOG.filter(job => job.batchVersion !== 1 || (batch.mode === 'versioned' && batch.writerContractVersion >= 1));
}
export function batchHostOrder(role: BatchRole): readonly BatchHost[] {
  if (!JOB_ROLES.includes(role as JobRole)) return ['oracle-osaka-smoke', 'm3', 'mini'];
  return role === 'crawler' ? ['mini', 'm3', 'oracle-osaka-smoke'] : ['m3', 'mini', 'oracle-osaka-smoke'];
}
export const batchCapabilitySchema = z.object({ host: z.enum(BATCH_HOSTS), release: z.string().min(1).max(120), instanceId: z.string().min(1).max(48),
  dbPrivileges: z.enum(['unknown', 'verified']), http: z.enum(['unknown', 'verified']), model: z.enum(['unknown', 'verified']),
  dbRole:z.string().min(1).max(63).optional(), effectivePrivilegeHash:z.string().regex(/^[0-9a-f]{64}$/).optional(),
  modelBoundEvidenceHash:z.string().regex(/^[0-9a-f]{64}$/).optional(),
  observedAt: z.iso.datetime({ offset: true }),
}).strict();
const resultSchema = z.object({ role:z.enum(BATCH_ROLES),batchEpoch:z.number().int().positive(), job: z.string(), instanceId: z.string(), host: z.enum(BATCH_HOSTS), release: z.string(), bootId: z.string().min(1),
  recordedAt: z.iso.datetime({ offset: true }), count: z.number().int().positive(), requestedVersion: z.number().int().positive(),
}).strict();
export const batchResultReadbackSchema=z.object({job:z.string().min(1),instanceId:z.string().min(1),host:z.enum(BATCH_HOSTS),release:z.string().min(1),requestedVersion:z.number().int().positive(),domainReadbackHash:z.string().regex(/^[0-9a-f]{64}$/),observedAt:z.iso.datetime({offset:true})}).strict();
export type BatchResultEvidence = z.infer<typeof resultSchema>;
/** classifyBatchReadiness 의 결과 나이 한도. stale re-canary(classifyBatchRecanary)도 같은 값으로만 판정한다. */
export const BATCH_RESULT_MAX_AGE_MS = 24 * 60 * 60_000;
export function classifyBatchReadiness(input: {role: BatchRole; host: BatchHost; instanceId: string; release: string; at: number; evidence: unknown; result: unknown; readback?:unknown}) {
  const capability = batchCapabilitySchema.safeParse(input.evidence);
  if (!capability.success || capability.data.host !== input.host || capability.data.instanceId !== input.instanceId || capability.data.release !== input.release ||
    capability.data.dbPrivileges !== 'verified' || !capability.data.dbRole || !capability.data.effectivePrivilegeHash || capability.data.http !== 'verified' ||
    (['translation','reviewer','publisher','text'].includes(input.role) && (capability.data.model !== 'verified' || !capability.data.modelBoundEvidenceHash))) return { ready: false, reason: 'capability_unknown' } as const;
  const age = input.at - Date.parse(capability.data.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 15 * 60_000) return { ready: false, reason: 'capability_stale' } as const;
  const result = resultSchema.safeParse(input.result);
  if (!result.success || result.data.host !== input.host || result.data.instanceId !== input.instanceId || result.data.release !== input.release ||
    !batchJobsForRole(input.role, 'versioned').includes(result.data.job)) return { ready: false, reason: 'result_unknown' } as const;
  const resultAge = input.at - Date.parse(result.data.recordedAt);
  if (!Number.isFinite(resultAge) || resultAge < 0 || resultAge > BATCH_RESULT_MAX_AGE_MS) return { ready: false, reason: 'result_stale' } as const;
  const readback=batchResultReadbackSchema.safeParse(input.readback);
  if(!readback.success || readback.data.job!==result.data.job || readback.data.instanceId!==input.instanceId || readback.data.host!==input.host || readback.data.release!==input.release || readback.data.requestedVersion!==result.data.requestedVersion || Date.parse(readback.data.observedAt)<Date.parse(result.data.recordedAt) || Date.parse(readback.data.observedAt)>input.at) return {ready:false,reason:'result_unverified'} as const;
  return { ready: true, reason: 'ready' } as const;
}

export type BatchCanaryCandidate = { role: BatchRole; instanceId: string; host: BatchHost; bootId: string; release: string; policyHash: string; capability: unknown; resultEvidence: unknown };
export type BatchCanaryAnchor = { batchCanary: { version: 1; kind: 'verified_batch_canary'; candidateIdentityHash: string; readbackHash: string; result: BatchResultEvidence } };
export type BatchCandidateEvidenceInput = { candidate: BatchCanaryCandidate; controlEpoch: number; at: number; anchor: unknown; latest: readonly {key:string;result:unknown}[] };
export type BatchCandidateEvidence = { report: {ready:boolean;reason:string}; selectedResult?: BatchResultEvidence; anchorToPin?: BatchCanaryAnchor };
export function batchCanaryAnchorKey(role: BatchRole, instanceId: string) {
  return 'batch-canary:' + createHash('sha256').update(JSON.stringify([role,instanceId])).digest('hex');
}
const anchorIdentitySchema = z.object({ role:z.enum(BATCH_ROLES),instanceId:z.string().min(1).max(48),
  host:z.enum(BATCH_HOSTS),bootId:z.string().min(1).max(36),release:z.string().min(1).max(120),
  policyHash:z.string().regex(/^[0-9a-f]{64}$/),controlEpoch:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
export const batchCanaryAnchorSchema = z.object({batchCanary:z.object({version:z.literal(1),kind:z.literal('verified_batch_canary'),
  candidateIdentityHash:z.string().regex(/^[0-9a-f]{64}$/),readbackHash:z.string().regex(/^[0-9a-f]{64}$/),result:resultSchema}).strict()}).strict();
const canaryHash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A stored anchor preserves an already verified ACK; it never certifies fresh domain work. */
export function classifyBatchCandidateEvidence(input: BatchCandidateEvidenceInput): BatchCandidateEvidence {
  const {candidate} = input;
  const identity = anchorIdentitySchema.safeParse({role:candidate.role,instanceId:candidate.instanceId,host:candidate.host,
    bootId:candidate.bootId,release:candidate.release,policyHash:candidate.policyHash,controlEpoch:input.controlEpoch});
  if(!identity.success) return {report:{ready:false,reason:'identity_mismatch'}};
  const classify = (result:unknown) => classifyBatchReadiness({role:candidate.role,host:candidate.host,instanceId:candidate.instanceId,
    release:candidate.release,at:input.at,evidence:candidate.capability,result,readback:candidate.resultEvidence});
  const readback = batchResultReadbackSchema.safeParse(candidate.resultEvidence);
  if(input.anchor !== undefined) {
    const anchor=batchCanaryAnchorSchema.safeParse(input.anchor);
    if(!anchor.success) return {report:{ready:false,reason:'anchor_invalid'}};
    if(anchor.data.batchCanary.candidateIdentityHash!==canaryHash(identity.data)) return {report:{ready:false,reason:'anchor_identity_mismatch'}};
    if(!readback.success || anchor.data.batchCanary.readbackHash!==canaryHash(readback.data)) return {report:{ready:false,reason:'anchor_readback_mismatch'}};
    const report=classify(anchor.data.batchCanary.result);
    return {report,...(report.ready ? {selectedResult:anchor.data.batchCanary.result} : {})};
  }
  let report: BatchCandidateEvidence['report'] = classify(null);
  for(const row of input.latest) {
    const result=resultSchema.safeParse(row.result);
    if(!result.success || row.key!==`batch-result:${candidate.instanceId}:${result.data.job}` ||
      !batchJobsForRole(candidate.role,'versioned').includes(result.data.job)) continue;
    report=classify(result.data);
    if(report.ready && readback.success) return {report,selectedResult:result.data,anchorToPin:{batchCanary:{version:1,kind:'verified_batch_canary',
      candidateIdentityHash:canaryHash(identity.data),readbackHash:canaryHash(readback.data),result:result.data}}};
  }
  return {report};
}

/**
 * First-ever ACK bootstrap for a role whose versioned jobs have no legacy parent (today: site-evidence), so neither a
 * legacy seed nor a prior canary can exist. An operator (attest principal) grant binds one exact boot/release/policy/
 * epoch for at most BATCH_BOOTSTRAP_TTL_MS, the attested capability must already pass classifyBatchReadiness, and the
 * caller must prove no batch-result or anchor exists for this role instance. It never makes launch readiness positive:
 * the resulting ACK still needs the normal attest readback and a canary through classifyBatchCandidateEvidence.
 */
export const BATCH_BOOTSTRAP_TTL_MS = 10 * 60_000;
export const batchBootstrapGrantSchema = z.object({ batchBootstrap: z.object({ version: z.literal(1), kind: z.literal('first_ack_bootstrap'),
  role: z.enum(BATCH_ROLES), instanceId: z.string().min(1).max(48), host: z.enum(BATCH_HOSTS), bootId: z.string().min(1).max(36),
  release: z.string().min(1).max(120), policyHash: z.string().regex(/^[0-9a-f]{64}$/), controlEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  job: z.string().min(1).max(120), issuedAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }) }).strict() }).strict();
export type BatchBootstrapGrant = z.infer<typeof batchBootstrapGrantSchema>;
export function batchBootstrapEligible(role: BatchRole): boolean {
  const names = batchJobsForRole(role, 'versioned');
  return names.length > 0 && names.every(name => JOB_CATALOG.some(job => job.name === name && job.batchVersion === 1 && job.role === role));
}
export function classifyBatchBootstrap(input: { candidate: BatchCanaryCandidate; controlEpoch: number; at: number; prior: boolean }) {
  const { candidate } = input, parsed = batchBootstrapGrantSchema.safeParse(input.candidate.resultEvidence);
  if (!parsed.success) return { ready: false, reason: 'bootstrap_grant_absent' } as const;
  const grant = parsed.data.batchBootstrap, issued = Date.parse(grant.issuedAt), expires = Date.parse(grant.expiresAt);
  if (!batchBootstrapEligible(candidate.role) || grant.role !== candidate.role || grant.instanceId !== candidate.instanceId || grant.host !== candidate.host
    || grant.bootId !== candidate.bootId || grant.release !== candidate.release || grant.policyHash !== candidate.policyHash
    || grant.controlEpoch !== input.controlEpoch || !batchJobsForRole(candidate.role, 'versioned').includes(grant.job))
    return { ready: false, reason: 'bootstrap_grant_mismatch' } as const;
  if (!(issued <= input.at && input.at < expires && expires - issued <= BATCH_BOOTSTRAP_TTL_MS)) return { ready: false, reason: 'bootstrap_grant_expired' } as const;
  if (input.prior) return { ready: false, reason: 'bootstrap_prior_evidence' } as const;
  // Exactly the normal capability checks: with no result, a passing capability is the only way to reach result_unknown.
  const capability = classifyBatchReadiness({ role: candidate.role, host: candidate.host, instanceId: candidate.instanceId,
    release: candidate.release, at: input.at, evidence: candidate.capability, result: null });
  if (capability.reason !== 'result_unknown') return capability;
  return { ready: true, reason: 'bootstrap_granted' } as const;
}

/**
 * Stale-result re-canary (PR11e). Readiness never accepts a result older than BATCH_RESULT_MAX_AGE_MS and the PR10d anchor keeps
 * its original ACK, so once every stored result of a role instance is that old nothing can elect it, and `attest`/`canary` refuse
 * the stale result: no fresh ACK can ever be produced. An operator (attest principal) grant reopens exactly one boot for at most
 * BATCH_BOOTSTRAP_TTL_MS under the same exact identity binding and capability checks as the first-ACK bootstrap, and only while
 * every stored result (batch-result rows and the anchor's result) is still stale: the first new ACK ends it. Nothing renews it
 * automatically and it never makes launch readiness positive; the new ACK still needs `attest` and `canary`.
 */
export const batchRecanaryGrantSchema = z.object({ batchRecanary: z.object({ version: z.literal(1), kind: z.literal('stale_result_recanary'),
  role: z.enum(BATCH_ROLES), instanceId: z.string().min(1).max(48), host: z.enum(BATCH_HOSTS), bootId: z.string().min(1).max(36),
  release: z.string().min(1).max(120), policyHash: z.string().regex(/^[0-9a-f]{64}$/), controlEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  job: z.string().min(1).max(120), issuedAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }) }).strict() }).strict();
export type BatchRecanaryGrant = z.infer<typeof batchRecanaryGrantSchema>;
/** Newest recordedAt of every stored result of this role instance: null when none exists, undefined when any stored row is unreadable. */
function newestPriorResultAt(role: BatchRole, instanceId: string, anchor: unknown, latest: readonly {key:string;result:unknown}[]): number | null | undefined {
  const names = batchJobsForRole(role, 'versioned'), times: number[] = [];
  const read = (value: unknown, key?: string) => {
    const result = resultSchema.safeParse(value);
    if (!result.success || result.data.instanceId !== instanceId || !names.includes(result.data.job)
      || (key !== undefined && key !== `batch-result:${instanceId}:${result.data.job}`) || !Number.isFinite(Date.parse(result.data.recordedAt))) return false;
    times.push(Date.parse(result.data.recordedAt)); return true;
  };
  if (anchor !== undefined) { const stored = batchCanaryAnchorSchema.safeParse(anchor); if (!stored.success || !read(stored.data.batchCanary.result)) return undefined; }
  for (const row of latest) if (!read(row.result, row.key)) return undefined;
  return times.length ? Math.max(...times) : null;
}
export function classifyBatchRecanary(input: { candidate: BatchCanaryCandidate; controlEpoch: number; at: number; anchor: unknown;
  latest: readonly {key:string;result:unknown}[] }) {
  const { candidate } = input, parsed = batchRecanaryGrantSchema.safeParse(candidate.resultEvidence);
  if (!parsed.success) return { ready: false, reason: 'recanary_grant_absent' } as const;
  const grant = parsed.data.batchRecanary, issued = Date.parse(grant.issuedAt), expires = Date.parse(grant.expiresAt);
  if (grant.role !== candidate.role || grant.instanceId !== candidate.instanceId || grant.host !== candidate.host || grant.bootId !== candidate.bootId
    || grant.release !== candidate.release || grant.policyHash !== candidate.policyHash || grant.controlEpoch !== input.controlEpoch
    || !batchJobsForRole(candidate.role, 'versioned').includes(grant.job)) return { ready: false, reason: 'recanary_grant_mismatch' } as const;
  if (!(issued <= input.at && input.at < expires && expires - issued <= BATCH_BOOTSTRAP_TTL_MS)) return { ready: false, reason: 'recanary_grant_expired' } as const;
  const prior = newestPriorResultAt(candidate.role, candidate.instanceId, input.anchor, input.latest);
  if (prior === null) return { ready: false, reason: 'recanary_prior_absent' } as const;
  if (prior === undefined) return { ready: false, reason: 'recanary_prior_unknown' } as const;
  if (!(input.at - prior > BATCH_RESULT_MAX_AGE_MS)) return { ready: false, reason: 'recanary_prior_fresh' } as const;
  // Exactly the normal capability checks (translation keeps its model proof requirement), as for the first-ACK bootstrap.
  const capability = classifyBatchReadiness({ role: candidate.role, host: candidate.host, instanceId: candidate.instanceId,
    release: candidate.release, at: input.at, evidence: candidate.capability, result: null });
  if (capability.reason !== 'result_unknown') return capability;
  return { ready: true, reason: 'recanary_granted' } as const;
}
