import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { categoryDecisions, crawlCandidates, crawlDocuments, crawlTaglines, jobs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { saveSettings, getSettings } from '@/lib/crawl/settings';
import { prepareCandidateClassification } from '@/lib/crawl/publish';
import { publicationClassificationAuthority, runPublicationClassificationCall } from '@/lib/crawl/publication-classify-capacity';
import { CliPhysicalEndUnknownError } from '@/lib/llm/cli-model-capacity';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { modelCapacityPolicyHash, cliDispatchBindingSchema, cliModelTerminalEvidenceSchema, type ModelCapacityPolicy } from '@/lib/llm/capacity';
import type { CliCallInput } from '@/lib/llm/cli-process-runner';
import { claudeCliTokenBound, type CliServingContract } from '@/lib/llm/cli-serving-contract';
import type { AgentStatus } from '@/lib/operations/contracts';
import { readControlSnapshot } from '@/lib/operations/pipeline-control-repository';
import { modelRouteContracts, usedModelRoutes } from '@/lib/operations/pipeline-control';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

const fixture = vi.hoisted(() => ({ contracts: [] as CliServingContract[], status: {} as AgentStatus, statusFailure: false }));
vi.mock('@/lib/operations/agent-client', () => ({ agentRequest: async () => { if (fixture.statusFailure) throw new Error('RPC unavailable'); return fixture.status; } }));
vi.mock('@/lib/llm/cli-serving-contract', async original => ({ ...await original<typeof import('@/lib/llm/cli-serving-contract')>(),
  resolveCliServingContract: (routeId: string, provider: string, model: string) => fixture.contracts.find(contract =>
    contract.routeId === routeId && contract.provider === provider && contract.model === model) ?? null }));
const admin = postgres(TEST_DATABASE_URL, { max: 3, prepare: false, onnotice: () => {} });
const prefix = `classify-${randomUUID().slice(0, 8)}`, owner = { instanceId: `${prefix}-publisher`, bootId: randomUUID() };
const routeId = 'crawl-publish-classify', model = 'gpt-5.6-terra';
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { codex: 4, claude: 4 }, groupLimits: { classifier: 4 },
  poolLimits: { reviewer: 4, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 32, queueTtlMs: 60_000,
  reservationTtlMs: 60_000, routes: [{ routeId, provider: 'codex-cli', model, providerBudgetId: 'codex', groupId: 'classifier' },
    { routeId, provider: 'claude-cli', model: 'sonnet', providerBudgetId: 'claude', groupId: 'classifier' }] };
let root = '', records = '', command = '', empty = '', originalControl: Record<string, unknown>;
let originalRole: Record<string, unknown> | undefined, originalJob: Record<string, unknown> | undefined, originalSettings: Record<string, unknown> | undefined;
let version = 0;
beforeAll(async () => {
  ensureSchema();
  [{ row: originalControl }] = await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`;
  originalRole = (await admin`SELECT to_jsonb(r) AS row FROM role_leases r WHERE role='publisher'`)[0]?.row;
  originalJob = (await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name='crawl-publish'`)[0]?.row;
  originalSettings = (await admin`SELECT to_jsonb(s) AS row FROM crawl_settings s WHERE id=1`)[0]?.row;
  root = await mkdtemp(path.join(os.tmpdir(), 'publication-classify-native-')); records = path.join(root, 'records'); empty = path.join(root, 'empty');
  await mkdir(records); await mkdir(empty);
  command = path.join(root, 'fake-cli');
  await writeFile(command, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve('tests/fixtures/fake-cli/fake.mjs')}' "$@"\n`); await chmod(command, 0o755);
  fixture.contracts = [{ version: 1, protocol: 'cli-process-v1', routeId, provider: 'codex-cli', model, cliVersion: 'fake 0.0.0',
    inputByteCap: 100_000, totalTokenBound: 200_000, costBoundUsdMicros: null, boundProvenance: 'declared' }];
  const claudeShape = { maxTurns: 2, inputByteCap: 100_000, overheadTokenBound: 20_000, outputTokensPerTurn: 4_000 };
  fixture.contracts.push({ version: 1, protocol: 'cli-process-v1', routeId, provider: 'claude-cli', model: 'sonnet', cliVersion: 'fake 0.0.0',
    totalTokenBound: claudeCliTokenBound(claudeShape), costBoundUsdMicros: null, boundProvenance: 'derived', ...claudeShape });
});
beforeEach(async () => {
  fixture.statusFailure = false;
  fixture.status = { connected: true, generation: 3, configVersion: 4,
    config: { primary: { model, effort: 'xhigh' }, fallback: { model: 'sonnet', effort: 'high' } },
    busy: null, connection: null, verification: null, lastAttempt: null, appliedAt: null, lastUsedVersion: null,
    classifyReady: true, classificationCapacityVersion: 1 };
  for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: 'publisher', ROLE_LEASE_INSTANCE_ID: owner.instanceId,
    ROLE_LEASE_BOOT_ID: owner.bootId, ROLE_LEASE_RELEASE: 'test-release', ROLE_LEASE_EPOCH: '2', CONNECT_AGENT_URL: 'http://fake-agent' })) vi.stubEnv(key, value);
  await saveSettings({ enabled: true }, 'test');
  await admin`INSERT INTO role_leases(role,owner_instance_id,owner_boot_id,owner_release,owner_kind,epoch,lease_until)
    VALUES ('publisher',${owner.instanceId},${owner.bootId},'test-release','primary',2,clock_timestamp()+interval '45 seconds')
    ON CONFLICT (role) DO UPDATE SET owner_instance_id=excluded.owner_instance_id,owner_boot_id=excluded.owner_boot_id,
    owner_release=excluded.owner_release,owner_kind=excluded.owner_kind,epoch=excluded.epoch,lease_until=excluded.lease_until`;
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)} WHERE id=1`;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const name of await readdir(records)) {
    const record = JSON.parse(await readFile(path.join(records, name), 'utf8'));
    if (record.grandchild) try { process.kill(record.grandchild, 'SIGKILL'); } catch { /* already exited */ }
  }
});
afterAll(async () => {
  // Dedicated loopback test database only. Never turn a test cleanup into a production release mechanism.
  await admin.begin(async tx => {
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events WHERE request_id IN (SELECT request_id FROM model_capacity_requests WHERE route_id=${routeId})`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_requests WHERE route_id=${routeId}`;
    await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,
      updated_at=r.updated_at FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r WHERE c.id=r.id`;
    await tx`DELETE FROM role_leases WHERE role='publisher'`;
    if (originalRole) await tx`INSERT INTO role_leases SELECT * FROM jsonb_populate_record(NULL::role_leases,${JSON.stringify(originalRole)}::text::jsonb)`;
    await tx`DELETE FROM jobs WHERE name='crawl-publish'`;
    if (originalJob) await tx`INSERT INTO jobs SELECT * FROM jsonb_populate_record(NULL::jobs,${JSON.stringify(originalJob)}::text::jsonb)`;
    await tx`DELETE FROM crawl_settings WHERE id=1`;
    if (originalSettings) await tx`INSERT INTO crawl_settings SELECT * FROM jsonb_populate_record(NULL::crawl_settings,${JSON.stringify(originalSettings)}::text::jsonb)`;
    for (const table of ['category_decisions', 'crawl_taglines', 'crawl_candidates', 'crawl_documents'])
      await tx.unsafe(`DELETE FROM ${table} WHERE repo LIKE $1`, [`${prefix}/%`]);
  });
  expect((await admin`SELECT to_jsonb(r) AS row FROM role_leases r WHERE role='publisher'`)[0]?.row).toEqual(originalRole);
  await admin.end(); await rm(root, { recursive: true, force: true });
});
async function prepared() {
  const repo = `${prefix}/tool-${++version}`, url = `https://tool-${version}.example`;
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: url, repoMeta: { description: 'Plan shared tasks' },
    pageStatus: 200, pageMeta: { title: 'Planner', description: 'Plan shared tasks' } }).returning();
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: url, state: 'approved', reason: 'passed', decidedBy: 'admin' }).returning();
  const classification = (await prepareCandidateClassification(candidate))!; expect(classification).not.toBeNull();
  const lease = { name: 'crawl-publish' as const, token: randomUUID(), requestedVersion: version };
  await admin`INSERT INTO jobs(name,lease_token,locked_at,requested_version) VALUES ('crawl-publish',${lease.token},clock_timestamp(),${version})
    ON CONFLICT (name) DO UPDATE SET lease_token=excluded.lease_token,locked_at=excluded.locked_at,requested_version=excluded.requested_version`;
  const payload = { inputs: [classification.input], definitions: (await getSettings()).classify.definitions };
  const authority = (await publicationClassificationAuthority([{ candidate, classification, decision: null }], payload, lease))!;
  const input: CliCallInput = { routeId, provider: 'codex-cli', model, command, args: ['exec', '-m', model], stdin: 'Fixed fixture prompt', cwd: root,
    env: { PATH: empty, FAKE_CLI_MODE: 'ok', FAKE_CLI_RECORD: records }, boundEnvKeys: [], timeoutMs: 5000,
    maxStdoutBytes: 65_536, maxStderrBytes: 32_768 };
  return { candidate, document, payload, authority, input, lease };
}
it('reserves, proves the actual publisher/source and settles from the native process in the remote process', async () => {
  const value = await prepared(), before = (await readdir(records)).length;
  expect((await runPublicationClassificationCall(value.input, value.payload, value.authority, () => fixture.status)).kind).toBe('exit');
  expect((await readdir(records)).length).toBe(before + 1);
  const [row] = await admin`SELECT state,dispatch_binding,terminal_evidence FROM model_capacity_requests WHERE route_id=${routeId} ORDER BY updated_at DESC LIMIT 1`;
  expect(row.state).toBe('settled'); expect(cliDispatchBindingSchema.safeParse(row.dispatch_binding).success).toBe(true);
  expect(row.terminal_evidence.process).toMatchObject({ ending: 'exited', actualUsage: null, provenance: 'unknown' });
  const [valid] = await admin`SELECT nmv_publication_classify_binding_valid(${JSON.stringify(row.dispatch_binding)}::text::jsonb) AS valid`;
  expect(valid.valid).toBe(true);
});
it('defers a missing remote status before creating any model request', async () => {
  const value = await prepared(), before = (await readdir(records)).length;
  const [{ count }] = await admin`SELECT count(*)::int AS count FROM model_capacity_requests`;
  fixture.statusFailure = true;
  await expect(publicationClassificationAuthority([{ candidate: value.candidate, classification: (await prepareCandidateClassification(value.candidate))!, decision: null }],
    value.payload, value.lease)).rejects.toBeInstanceOf(ModelCapacityDeferredError);
  expect((await readdir(records)).length).toBe(before);
  expect((await admin`SELECT count(*)::int AS count FROM model_capacity_requests`)[0].count).toBe(count);
});
it('rejects JSON null provenance in both Zod, the SQL validator and a real ledger CHECK', async () => {
  const value = await prepared(); await runPublicationClassificationCall(value.input, value.payload, value.authority, () => fixture.status);
  const [{ row }] = await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE route_id=${routeId} ORDER BY updated_at DESC LIMIT 1`;
  for (const usage of [null, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }]) {
    const terminal = structuredClone(row.terminal_evidence); terminal.process.provenance = null; terminal.process.actualUsage = usage;
    expect(cliModelTerminalEvidenceSchema.safeParse(terminal).success).toBe(false);
    const [checked] = await admin`SELECT nmv_publication_classify_terminal_valid(${JSON.stringify(terminal)}::text::jsonb) AS valid`;
    expect(checked.valid).toBe(false);
    const copy = { ...row, request_id: randomUUID(), terminal_evidence: terminal };
    copy.terminal_evidence.dispatch.requestId = copy.request_id; copy.terminal_evidence.process.requestId = copy.request_id;
    await expect(admin`INSERT INTO model_capacity_requests SELECT * FROM jsonb_populate_record(NULL::model_capacity_requests,${JSON.stringify(copy)}::text::jsonb)`)
      .rejects.toMatchObject({ code: '23514' });
  }
});
it('rejects JSON null for every required string enum and matching owner/transport identity', async () => {
  const value = await prepared(); await runPublicationClassificationCall(value.input, value.payload, value.authority, () => fixture.status);
  const [{ terminal_evidence: original }] = await admin`SELECT terminal_evidence FROM model_capacity_requests WHERE route_id=${routeId} ORDER BY updated_at DESC LIMIT 1`;
  const paths = [['kind'], ['process', 'kind'], ['process', 'ending'], ['process', 'provenance'],
    ['dispatch', 'owner', 'instanceId'], ['dispatch', 'owner', 'bootId'], ['dispatch', 'binding', 'kind'],
    ['dispatch', 'binding', 'provider'], ['dispatch', 'binding', 'routeId'], ['dispatch', 'binding', 'publisherRole', 'role'],
    ['dispatch', 'binding', 'publisherRole', 'kind'], ['dispatch', 'binding', 'job', 'name'],
    ['dispatch', 'binding', 'transport', 'protocol'], ['dispatch', 'binding', 'transport', 'provider'], ['dispatch', 'binding', 'transport', 'model']];
  for (const keys of paths) {
    const terminal = structuredClone(original); let target = terminal;
    for (const key of keys.slice(0, -1)) target = target[key];
    target[keys.at(-1)!] = null;
    expect(cliModelTerminalEvidenceSchema.safeParse(terminal).success, keys.join('.')).toBe(false);
    const [checked] = await admin`SELECT nmv_publication_classify_terminal_valid(${JSON.stringify(terminal)}::text::jsonb) AS valid`;
    expect(checked.valid, keys.join('.')).toBe(false);
  }
});
it('rejects a UUID-shaped job token outside the Zod UUID versions and variants', async () => {
  const value = await prepared(); await runPublicationClassificationCall(value.input, value.payload, value.authority, () => fixture.status);
  const [{ terminal_evidence: original }] = await admin`SELECT terminal_evidence FROM model_capacity_requests WHERE route_id=${routeId} ORDER BY updated_at DESC LIMIT 1`;
  for (const token of ['12345678-1234-f234-8234-123456789abc', '12345678-1234-4234-7234-123456789abc']) {
    const terminal = structuredClone(original); terminal.dispatch.binding.job.token = token;
    expect(cliDispatchBindingSchema.safeParse(terminal.dispatch.binding).success).toBe(false);
    const [checked] = await admin`SELECT nmv_publication_classify_terminal_valid(${JSON.stringify(terminal)}::text::jsonb) AS valid`;
    expect(checked.valid).toBe(false);
  }
});
it('settles the first native failure before admitting the same members to the actual fallback provider', async () => {
  const value = await prepared(), before = (await readdir(records)).length;
  const first = await runPublicationClassificationCall({ ...value.input, env: { ...value.input.env, FAKE_CLI_MODE: 'fail' } },
    value.payload, value.authority, () => fixture.status);
  expect(first).toMatchObject({ kind: 'exit', code: 1 });
  const [settled] = await admin`SELECT state,terminal_evidence FROM model_capacity_requests WHERE route_id=${routeId} ORDER BY updated_at DESC LIMIT 1`;
  expect(settled.state).toBe('settled'); expect(settled.terminal_evidence.process).toMatchObject({ ending: 'exited', exitCode: 1 });
  const second = await runPublicationClassificationCall({ ...value.input, provider: 'claude-cli', model: 'sonnet',
    args: ['-p', '-m', 'sonnet', '--max-turns', '2', '--output-format', 'json'],
    env: { ...value.input.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4000' }, boundEnvKeys: ['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] },
    value.payload, value.authority, () => fixture.status);
  expect(second).toMatchObject({ kind: 'exit', code: 0 }); expect((await readdir(records)).length).toBe(before + 2);
  const rows = await admin`SELECT state,provider,terminal_evidence FROM model_capacity_requests
    WHERE route_id=${routeId} AND dispatch_binding->'members'->0->>'candidateId'=${String(value.candidate.id)} ORDER BY queue_ordinal`;
  expect(rows.map(row => [row.state, row.provider])).toEqual([['settled', 'codex-cli'], ['settled', 'claude-cli']]);
  expect(rows[1].terminal_evidence.process).toMatchObject({ ending: 'exited', provenance: 'cli_reported', actualUsage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 } });
});
it('reads the actual remote observation into the control snapshot and blocks a stale classifier', async () => {
  const key = `service:connect-agent:${prefix}`, observation = { ...fixture.status, status: 'running', classificationContracts: fixture.contracts };
  await admin`INSERT INTO operations_observations(key,value,observed_at) VALUES (${key},${JSON.stringify(observation)}::text::jsonb,clock_timestamp() AT TIME ZONE 'UTC')`;
  try {
    const snapshot = await readControlSnapshot(db);
    expect(snapshot.classificationObservations).toEqual([expect.objectContaining({ value: observation })]);
    const rows = modelRouteContracts(policy, 'items', usedModelRoutes(snapshot, null)).filter(row => row.routeId === routeId && row.status !== 'unused');
    expect(rows.map(row => row.status)).toEqual(['serving', 'serving']);
    await admin`UPDATE operations_observations SET observed_at=(clock_timestamp() AT TIME ZONE 'UTC')-interval '20 seconds' WHERE key=${key}`;
    const stale = await readControlSnapshot(db);
    expect(modelRouteContracts(policy, 'items', usedModelRoutes(stale, null))).toContainEqual({ routeId, provider: 'unknown', model: null, status: 'unknown' });
  } finally { await admin`DELETE FROM operations_observations WHERE key=${key}`; }
});
it.each(['candidate', 'document', 'settings', 'decision', 'tagline', 'job', 'role', 'config', 'payload'] as const)(
  'does not spawn or overwrite publication state after %s changes', async change => {
    const value = await prepared(), before = (await readdir(records)).length;
    if (change === 'candidate') await admin`UPDATE crawl_candidates SET updated_at=updated_at+interval '1 microsecond' WHERE id=${value.candidate.id}`;
    if (change === 'document') await admin`UPDATE crawl_documents SET fetched_at=fetched_at+interval '1 microsecond' WHERE id=${value.document.id}`;
    if (change === 'settings') await saveSettings({ reviewConcurrency: 2 }, 'test');
    if (change === 'decision') await db.insert(categoryDecisions).values({ repo: value.candidate.repo, sourceHash: 'a'.repeat(64), category: null, reason: 'Changed', actor: 'admin', retryAt: new Date() });
    if (change === 'tagline') await db.insert(crawlTaglines).values({ repo: value.candidate.repo, tagline: 'Changed', source: 'page', model: '', sourceHash: '', documentAt: new Date() });
    if (change === 'job') await db.update(jobs).set({ leaseToken: randomUUID() }).where(eq(jobs.name, 'crawl-publish'));
    if (change === 'role') await admin`UPDATE role_leases SET owner_boot_id=${randomUUID()} WHERE role='publisher'`;
    if (change === 'config') fixture.status.generation++;
    if (change === 'payload') value.payload.inputs[0]!.tagline = 'Forged caller facts';
    await expect(runPublicationClassificationCall(value.input, value.payload, value.authority, () => fixture.status)).rejects.toBeInstanceOf(ModelCapacityDeferredError);
    expect((await readdir(records)).length).toBe(before);
    expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, value.candidate.id)))[0].state).toBe('approved');
  });
it('retains an unknown child for review and no longer fences the same member after owner/provider changes (2026-10-30)', async () => {
  const value = await prepared(), before = (await readdir(records)).length;
  await expect(runPublicationClassificationCall({ ...value.input, env: { ...value.input.env, FAKE_CLI_MODE: 'grandchild-hold' } },
    value.payload, value.authority, () => fixture.status)).rejects.toBeInstanceOf(CliPhysicalEndUnknownError);
  const [unknown] = await admin`SELECT request_id,state,terminal_evidence FROM model_capacity_requests WHERE route_id=${routeId} ORDER BY updated_at DESC LIMIT 1`;
  expect(unknown).toMatchObject({ state: 'indeterminate', terminal_evidence: null });
  const { requestCliModelSlot, cancelReservedModelSlot } = await import('@/lib/llm/capacity-repository');
  const { publicationClassifyInputHash, publicationClassifyLogicalWorkKey } = await import('@/lib/llm/capacity');
  const facts = { members: value.authority.members, provider: 'claude-cli' as const, model: 'sonnet', payloadHash: value.authority.payloadHash,
    definitionsHash: value.authority.definitionsHash, configHash: value.authority.configHash, generation: 3, configVersion: 4 };
  // 2026-10-30 결정: 미확인 child 행은 점유도 fence 도 아니다 — 다른 owner·provider 의 같은 멤버 재접수가 들어가고, 미확인 행은 사람 검토용으로 그대로 남는다.
  const slot = await requestCliModelSlot({ requestId: randomUUID(), owner: { instanceId: 'replacement-publisher', bootId: randomUUID() },
    class: 'background', pool: 'reviewer', routeId, provider: facts.provider, model: facts.model,
    workKey: `${publicationClassifyLogicalWorkKey(facts.members)}:${publicationClassifyInputHash(facts)}` }, { kind: 'publication-classify', members: facts.members });
  expect(slot.kind).toBe('granted'); if (slot.kind === 'granted') expect(await cancelReservedModelSlot(slot.reservation)).toBe(true);
  expect((await admin`SELECT state FROM model_capacity_requests WHERE request_id=${unknown.request_id}::uuid`)[0]).toEqual({ state: 'indeterminate' });
  expect((await readdir(records)).length).toBe(before + 1);
});
