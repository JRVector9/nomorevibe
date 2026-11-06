import { randomUUID } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstReviewers } from '@/lib/crawl/first-reviewers';
import { setAiTaskModelsForTest } from '@/lib/llm/ai-task-models-snapshot';
import { setAiTaskExecutionConfigsForTest } from '@/lib/llm/ai-task-execution-snapshot';
import { setServingContractSnapshotForTest } from '@/lib/llm/serving-contract-store';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { DEFAULT_CONFIG, type AgentStatus, type ClassificationAuthority } from '@/lib/operations/contracts';
import { DEFAULT_CATEGORY_DEFINITIONS } from '@/lib/crawl/settings-schema';
import { classificationConfigHash, classificationDefinitionsHash, classificationPayloadHash,
  publicationClassificationAuthority, publicationApiSources, runPublicationClassificationCall } from '@/lib/crawl/publication-classify-capacity';
import type { CliCallInput } from '@/lib/llm/cli-process-runner';
import { publishCandidates } from '@/lib/crawl/jobs/publish';

const fixture = vi.hoisted(() => ({ read: vi.fn(), ranks: vi.fn(), transaction: vi.fn(), run: vi.fn(), control: vi.fn(), status: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { execute: fixture.read, transaction: fixture.transaction }, onPrimary: (run: () => unknown) => run() }));
vi.mock('@/lib/llm/cli-model-capacity', () => ({ runCliWithModelCapacity: fixture.run }));
vi.mock('@/lib/llm/capacity-repository', async original => ({ ...await original<typeof import('@/lib/llm/capacity-repository')>(),
  readModelCapacityCallerControl: fixture.control }));
vi.mock('@/lib/operations/agent-client', () => ({ agentRequest: fixture.status }));
vi.mock('@/lib/crawl/settings', async original => ({ ...await original<typeof import('@/lib/crawl/settings')>(),
  getSettings: async () => ({ enabled: true }) }));
vi.mock('@/lib/crawl/agent-review-repository', async original => ({ ...await original<typeof import('@/lib/crawl/agent-review-repository')>(),
  requeueInvalidStarApprovals: async () => {
    expect(firstReviewers()).toEqual([{ provider: 'claude-cli', model: 'sonnet' }]);
    throw stop;
  } }));

const stop = new ModelCapacityDeferredError('work_busy');
const rank = { task: 'first-review', slot: 1, rank: 1, model: 'sonnet', enabled: true, options: {},
  connection_id: randomUUID(), label: 'Review CLI', kind: 'cli', base_url: null, api_key_ciphertext: null,
  cli_tool: 'claude', device_id: 'test-device', connection_enabled: true, models: null, connection_options: {} };

function prepared() {
  const status: AgentStatus = { connected: true, generation: 3, configVersion: 4, config: DEFAULT_CONFIG,
    busy: null, connection: null, verification: null, lastAttempt: null, appliedAt: null, lastUsedVersion: null,
    classifyReady: true, classificationCapacityVersion: 1 };
  const payload = { inputs: [{ repo: 'owner/tool', url: 'https://example.com', name: 'Tool', tagline: 'Plan tasks', topics: [], language: null }],
    definitions: DEFAULT_CATEGORY_DEFINITIONS };
  const authority: ClassificationAuthority = { version: 1, members: [{ candidateId: 7, repo: 'owner/tool', sourceHash: 'a'.repeat(64) }],
    payloadHash: classificationPayloadHash(payload), definitionsHash: classificationDefinitionsHash(payload.definitions),
    configHash: classificationConfigHash(status), generation: 3, configVersion: 4,
    job: { name: 'crawl-publish', token: randomUUID(), requestedVersion: 5 },
    publisherRole: { role: 'publisher', instanceId: 'test-publisher', bootId: randomUUID(), release: 'test', epoch: 2, kind: 'primary' } };
  const input: CliCallInput = { routeId: 'crawl-publish-classify', provider: 'codex-cli', model: DEFAULT_CONFIG.primary.model,
    command: 'never-executed', args: [], stdin: null, cwd: '/tmp', env: {}, boundEnvKeys: [],
    timeoutMs: 35_000, maxStdoutBytes: 1024, maxStderrBytes: 1024 };
  return { status, payload, authority, input };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('DATABASE_URL', 'postgres://unused:unused@localhost:1/unused');
  vi.stubEnv('MODEL_SERVING_CONTRACTS_DB', '1');
  vi.stubEnv('ROLE_LEASE_ROLE', 'publisher');
  vi.stubEnv('ROLE_LEASE_INSTANCE_ID', 'test-publisher');
  vi.stubEnv('ROLE_LEASE_BOOT_ID', randomUUID());
  vi.stubEnv('ROLE_LEASE_RELEASE', 'test');
  vi.stubEnv('ROLE_LEASE_EPOCH', '2');
  setServingContractSnapshotForTest([]);
  // Undo the global unit fixture: a real newly booted process has neither snapshot.
  setAiTaskModelsForTest(null);
  setAiTaskExecutionConfigsForTest(null);
  fixture.ranks.mockResolvedValue([rank]);
  fixture.read.mockImplementation(query => new PgDialect().sqlToQuery(query).sql.includes('FROM ai_task_models')
    ? fixture.ranks() : []);
  fixture.control.mockResolvedValue({ mode: 'open' });
  fixture.transaction.mockImplementation(async (run, options) => {
    if (options?.accessMode === 'read only') return run({ execute: async () => [] });
    // This is the first source-lock boundary. Real assertReviewApproval builds the
    // same synchronous reviewer identity; do not let a test fixture prewarm it.
    expect(firstReviewers()).toEqual([{ provider: 'claude-cli', model: 'sonnet' }]);
    throw stop;
  });
});
afterEach(() => {
  setAiTaskModelsForTest(null);
  setAiTaskExecutionConfigsForTest(null);
  setServingContractSnapshotForTest(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('publication approval snapshots on a cold process', () => {
  it('loads the publisher reviewer identities before its first queue operation', async () => {
    const value = prepared();
    await expect(publishCandidates({ lease: value.authority.job, cursor: null, save: vi.fn(), log: vi.fn(), hasBudget: () => true }))
      .rejects.toBe(stop);
    expect(fixture.ranks).toHaveBeenCalledOnce();
  });

  it('loads review ranks before the publisher takes source locks for CLI authority', async () => {
    const value = prepared(); fixture.status.mockResolvedValue(value.status);
    await expect(publicationClassificationAuthority([], value.payload, value.authority.job)).rejects.toBe(stop);
    expect(fixture.ranks).toHaveBeenCalledOnce();
  });

  it('loads review ranks before an API publisher takes the same source locks', async () => {
    const value = prepared();
    await expect(publicationApiSources([], value.payload, value.authority.job)).rejects.toBe(stop);
    expect(fixture.ranks).toHaveBeenCalledOnce();
  });

  it('independently initializes the remote Connect process before native CLI admission', async () => {
    const value = prepared();
    fixture.run.mockImplementation(async () => {
      expect(firstReviewers()).toEqual([{ provider: 'claude-cli', model: 'sonnet' }]);
      return { kind: 'ran', result: { kind: 'exit', code: 0, stdout: 'fixture', stderr: '' } };
    });
    await expect(runPublicationClassificationCall(value.input, value.payload, value.authority, () => value.status))
      .resolves.toMatchObject({ kind: 'exit', code: 0 });
    expect(fixture.run).toHaveBeenCalledOnce();
    expect(fixture.ranks).toHaveBeenCalledOnce();
  });

  it('does not silently fall back when execution settings cannot be read', async () => {
    const value = prepared();
    fixture.transaction.mockRejectedValue(new Error('execution config read unavailable'));
    fixture.run.mockImplementation(async () => { firstReviewers(); throw stop; });
    await expect(runPublicationClassificationCall(value.input, value.payload, value.authority, () => value.status))
      .rejects.toMatchObject({ reason: 'assignments_unavailable' });
  });

  it('refreshes changed review settings in a long-lived Connect process after the cache interval', async () => {
    const value = prepared(), at = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
    const reviewers: ReturnType<typeof firstReviewers>[] = [];
    fixture.run.mockImplementation(async () => {
      reviewers.push(firstReviewers());
      return { kind: 'ran', result: { kind: 'exit', code: 0, stdout: '', stderr: '' } };
    });
    const classify = () => runPublicationClassificationCall(value.input, value.payload, value.authority, () => value.status);
    await classify();
    fixture.ranks.mockResolvedValue([{ ...rank, model: 'opus' }]);
    await classify();
    expect(fixture.ranks).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(at + 30_001);
    await classify();
    expect(fixture.ranks).toHaveBeenCalledTimes(2);
    expect(reviewers).toEqual([
      [{ provider: 'claude-cli', model: 'sonnet' }],
      [{ provider: 'claude-cli', model: 'sonnet' }],
      [{ provider: 'claude-cli', model: 'opus' }],
    ]);
  });

  it('keeps disabled legacy authority independent of the new snapshots', async () => {
    fixture.control.mockResolvedValue({ mode: 'disabled' });
    const value = prepared();
    await expect(publicationClassificationAuthority([], value.payload, value.authority.job)).resolves.toBeUndefined();
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.transaction).not.toHaveBeenCalled();
  });
});
