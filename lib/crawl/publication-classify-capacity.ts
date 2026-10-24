import { isDeepStrictEqual } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { categoryDecisions, crawlCandidates, crawlDocuments, crawlSettings, crawlTaglines, roleLeases,
  type CrawlCandidate } from '@/lib/db/schema';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import { assertJobBatchAdmission } from '@/lib/jobs/batch-repository';
import { assertJobLeaseAtWallTime, type JobLease } from '@/lib/jobs/control';
import { roleLeaseFromEnv, type RoleLease } from '@/lib/jobs/role-leader';
import { publicationClassifyInputHash, publicationClassifyLogicalWorkKey, publicationPublisherRoleSchema,
  type PublicationClassifyMember } from '@/lib/llm/capacity';
import { readModelCapacityCallerControl } from '@/lib/llm/capacity-repository';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { runCliWithModelCapacity } from '@/lib/llm/cli-model-capacity';
import type { CliCallInput, CliProcessResult } from '@/lib/llm/cli-process-runner';
import { agentRequest } from '@/lib/operations/agent-client';
import { modelConfigSchema, type AgentStatus, type ClassificationAuthority } from '@/lib/operations/contracts';
import { categorySourceHash } from '@/lib/operations/categories';
import { reviewHash } from './agent-review-contract';
import { assertReviewApproval } from './agent-review-repository';
import type { ClassifyInput } from './classify';
import { lockPipelineInputStages } from './pipeline-stage-context';
import { classificationInputFromRows, type PreparedClassification } from './publish';
import { mergeWithDefaults } from './settings';
import type { CategoryDefinitions } from './settings-schema';

export const PUBLICATION_CLASSIFY_ROUTE = 'crawl-publish-classify';
type Raw = Record<string, unknown>;
type Payload = { inputs: ClassifyInput[]; definitions?: CategoryDefinitions };
export const classificationPayloadHash = (payload: Payload) => reviewHash(payload.inputs);
export const classificationDefinitionsHash = (definitions: CategoryDefinitions) => reviewHash(definitions);
export function classificationConfigHash(status: Pick<AgentStatus, 'config'>): string { return reviewHash(modelConfigSchema.parse(status.config)); }

export async function publicationClassificationPath(): Promise<'legacy' | 'native'> {
  const control = await readModelCapacityCallerControl();
  if (control.mode === 'disabled') return 'legacy';
  if (control.mode !== 'open') throw new ModelCapacityDeferredError('draining');
  return 'native';
}

/** Batch admission → role → stages → sources → job, after the capacity lock prefix when dispatching. */
async function lockPublisher(tx: ProductTransaction, lease: RoleLease) {
  await assertJobBatchAdmission(tx, 'crawl-publish', lease);
  const [role] = await tx.select().from(roleLeases).where(eq(roleLeases.role, 'publisher')).for('share');
  if (!role || role.ownerInstanceId !== lease.instanceId || role.ownerBootId !== lease.bootId
    || role.ownerRelease !== lease.release || role.epoch !== lease.epoch)
    throw new ModelCapacityDeferredError('owner_unavailable');
  return publicationPublisherRoleSchema.parse({ ...lease, kind: role.ownerKind });
}
async function wallAuthority(tx: ProductTransaction, authority: Pick<ClassificationAuthority, 'job' | 'publisherRole'>) {
  await assertJobLeaseAtWallTime(tx, authority.job);
  const role = authority.publisherRole;
  const [wall] = await tx.execute<{ role_live: boolean; job_live: boolean }>(sql`SELECT
    EXISTS (SELECT 1 FROM role_leases WHERE role='publisher' AND owner_instance_id=${role.instanceId}
      AND owner_boot_id=${role.bootId} AND owner_release=${role.release} AND owner_kind=${role.kind}
      AND epoch=${role.epoch} AND lease_until>clock_timestamp()) AS role_live,
    EXISTS (SELECT 1 FROM jobs WHERE name='crawl-publish' AND lease_token=${authority.job.token}
      AND requested_version=${authority.job.requestedVersion} AND locked_at>=clock_timestamp()-interval '90 seconds') AS job_live`);
  if (!wall?.role_live) throw new ModelCapacityDeferredError('owner_unavailable');
  if (!wall.job_live) throw new ModelCapacityDeferredError('reservation_lost');
}

type Expected = { candidate: CrawlCandidate; classification: PreparedClassification;
  decision: { revision: number; sourceHash: string } | null };
async function lockSources(tx: ProductTransaction, payload: Payload, members: readonly Pick<PublicationClassifyMember, 'candidateId' | 'repo'>[],
  lease: JobLease, expected?: readonly Expected[]): Promise<PublicationClassifyMember[]> {
  await lockPipelineInputStages(tx);
  const [settingsRow] = await tx.select({ row: crawlSettings, raw: sql<Raw>`to_jsonb(${crawlSettings})` })
    .from(crawlSettings).where(eq(crawlSettings.id, 1)).for('share');
  const settings = mergeWithDefaults(settingsRow?.row.values);
  if (!settings.enabled || !isDeepStrictEqual(payload.definitions, settings.classify.definitions))
    throw new ModelCapacityDeferredError('reservation_lost');
  const approvals: { candidate: typeof crawlCandidates.$inferSelect; document: typeof crawlDocuments.$inferSelect }[] = [];
  const locked = new Map<string, { member: PublicationClassifyMember; input: ClassifyInput }>();
  // Stable row order also protects different, partially overlapping batches.
  for (const member of [...members].sort((a, b) => a.candidateId - b.candidateId)) {
    const [candidate] = await tx.select({ row: crawlCandidates, raw: sql<Raw>`to_jsonb(${crawlCandidates})` })
      .from(crawlCandidates).where(eq(crawlCandidates.id, member.candidateId)).for('update');
    const [document] = await tx.select({ row: crawlDocuments, raw: sql<Raw>`to_jsonb(${crawlDocuments})` })
      .from(crawlDocuments).where(eq(crawlDocuments.repo, member.repo)).for('share');
    const [decision] = await tx.select({ row: categoryDecisions, raw: sql<Raw>`to_jsonb(${categoryDecisions})` })
      .from(categoryDecisions).where(eq(categoryDecisions.repo, member.repo)).for('share');
    const [tagline] = await tx.select({ row: crawlTaglines, raw: sql<Raw>`to_jsonb(${crawlTaglines})` })
      .from(crawlTaglines).where(eq(crawlTaglines.repo, member.repo)).for('share');
    if (!candidate || !document || candidate.row.state !== 'approved' || candidate.row.repo !== member.repo
      || document.row.repo !== member.repo || decision?.row.category && decision.row.sourceHash === categorySourceHash(candidate.row, document.row))
      throw new ModelCapacityDeferredError('reservation_lost');
    const original = expected?.find(item => item.candidate.id === member.candidateId);
    if (expected && (!original || !isDeepStrictEqual(original.candidate, candidate.row)
      || !isDeepStrictEqual(original.classification.snapshot.document, document.row)
      || !isDeepStrictEqual(original.classification.snapshot.settings, settings)
      || (original.decision?.revision ?? null) !== (decision?.row.revision ?? null)
      || (original.decision?.sourceHash ?? null) !== (decision?.row.sourceHash ?? null)))
      throw new ModelCapacityDeferredError('reservation_lost');
    const input = classificationInputFromRows(candidate.row, document.row, settings, tagline?.row);
    if (!input) throw new ModelCapacityDeferredError('reservation_lost');
    approvals.push({ candidate: candidate.row, document: document.row });
    locked.set(member.repo, { input, member: { ...member, sourceHash: reviewHash({ candidate: candidate.raw, document: document.raw,
      settings: settingsRow?.raw ?? null, decision: decision?.raw ?? null, tagline: tagline?.raw ?? null }) } });
  }
  for (const approval of approvals) await assertReviewApproval(tx, { ...approval, settings, lease });
  if (members.length !== payload.inputs.length || !isDeepStrictEqual(payload.inputs, members.map(member => locked.get(member.repo)?.input)))
    throw new ModelCapacityDeferredError('reservation_lost');
  return members.map(member => locked.get(member.repo)!.member);
}

/** Disabled sends exactly the old payload, so an old ConnectAgent can still serve during rolling deployment. */
export async function publicationClassificationAuthority(expected: readonly Expected[], payload: Payload, lease?: JobLease): Promise<ClassificationAuthority | undefined> {
  if (await publicationClassificationPath() === 'legacy') return undefined;
  const role = roleLeaseFromEnv('publisher', process.env);
  if (!lease || lease.name !== 'crawl-publish' || !role) throw new ModelCapacityDeferredError('owner_unavailable');
  let status: AgentStatus;
  try { status = await agentRequest<AgentStatus>('status'); }
  catch { throw new ModelCapacityDeferredError('provider_contract_unavailable'); }
  if (status.classificationCapacityVersion !== 1 || !status.classifyReady || status.busy)
    throw new ModelCapacityDeferredError('provider_contract_unavailable');
  return onPrimary(() => db.transaction(async tx => {
    const publisherRole = await lockPublisher(tx, role);
    const members = await lockSources(tx, payload, expected.map(item => ({ candidateId: item.candidate.id, repo: item.candidate.repo })), lease, expected);
    const authority: ClassificationAuthority = { version: 1, publisherRole, job: { ...lease, name: 'crawl-publish' }, members,
      payloadHash: classificationPayloadHash(payload), definitionsHash: classificationDefinitionsHash(payload.definitions!),
      configHash: classificationConfigHash(status), generation: status.generation, configVersion: status.configVersion };
    await wallAuthority(tx, authority);
    return authority;
  })).catch((error: unknown) => {
    if (error instanceof ModelCapacityDeferredError) throw error;
    throw new ModelCapacityDeferredError('reservation_lost');
  });
}

/** Native admission and the private terminal never leave this remote process. The RPC result grants no settlement authority. */
export async function runPublicationClassificationCall(input: CliCallInput, payload: Payload, authority: ClassificationAuthority,
  status: () => AgentStatus): Promise<CliProcessResult> {
  const current = () => { const value = status(); return value.generation === authority.generation
    && value.configVersion === authority.configVersion && classificationConfigHash(value) === authority.configHash; };
  try {
    if (input.routeId !== PUBLICATION_CLASSIFY_ROUTE || input.provider !== 'claude-cli' && input.provider !== 'codex-cli')
      throw new ModelCapacityDeferredError('provider_contract_unavailable');
    const configured = status().config;
    if (![configured.primary, configured.fallback].some(model => model?.model === input.model)
      || (input.model === 'sonnet' ? input.provider !== 'claude-cli' : input.provider !== 'codex-cli'))
      throw new ModelCapacityDeferredError('provider_contract_unavailable');
    if (!current() || classificationPayloadHash(payload) !== authority.payloadHash
      || !payload.definitions || classificationDefinitionsHash(payload.definitions) !== authority.definitionsHash)
      throw new ModelCapacityDeferredError('reservation_lost');
    const facts = { members: authority.members, provider: input.provider, model: input.model, payloadHash: authority.payloadHash,
      definitionsHash: authority.definitionsHash, configHash: authority.configHash, generation: authority.generation, configVersion: authority.configVersion };
    const logicalWorkKey = publicationClassifyLogicalWorkKey(facts.members), inputHash = publicationClassifyInputHash(facts);
    const result = await runCliWithModelCapacity(input, undefined, {
      requireTerminal: true, beforeSpawn: current,
      plan: async () => ({ target: { kind: 'publication-classify', members: facts.members }, identity: {
        owner: { instanceId: authority.publisherRole.instanceId, bootId: authority.publisherRole.bootId },
        class: 'background', pool: 'reviewer', routeId: PUBLICATION_CLASSIFY_ROUTE, provider: facts.provider, model: facts.model,
        workKey: `${logicalWorkKey}:${inputHash}` } }),
      prove: async (tx, call) => {
        if (!current()) return null;
        const publisherRole = await lockPublisher(tx, authority.publisherRole);
        if (!isDeepStrictEqual(publisherRole, authority.publisherRole)) return null;
        const members = await lockSources(tx, payload, facts.members, authority.job);
        if (!isDeepStrictEqual(members, facts.members)) return null;
        await wallAuthority(tx, authority);
        return { ...facts, kind: 'publication_classify_cli', version: 1, logicalWorkKey, inputHash, publisherRole,
          job: authority.job, routeId: PUBLICATION_CLASSIFY_ROUTE, transport: call.transport,
          totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound };
      },
    });
    if (result.kind !== 'ran') throw new ModelCapacityDeferredError('reservation_lost');
    return result.result;
  } catch (error) {
    // A ledger/commit error is never a deterministic model failure and cannot authorize fallback.
    if (error instanceof ModelCapacityDeferredError) throw error;
    throw new ModelCapacityDeferredError('dispatched');
  }
}
