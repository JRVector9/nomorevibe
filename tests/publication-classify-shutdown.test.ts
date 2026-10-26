import { beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG, type AgentStatus, type ClassificationAuthority } from '@/lib/operations/contracts';
import { DEFAULT_CATEGORY_DEFINITIONS } from '@/lib/crawl/settings-schema';
import { classificationConfigHash, classificationDefinitionsHash, classificationPayloadHash,
  runPublicationClassificationCall } from '@/lib/crawl/publication-classify-capacity';
import type { CliCapacityWork } from '@/lib/llm/cli-model-capacity';
import type { CliCallInput } from '@/lib/llm/cli-process-runner';

const fixture = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@/lib/llm/cli-model-capacity', () => ({ runCliWithModelCapacity: fixture.run }));
beforeEach(() => { fixture.run.mockReset(); });
function prepared() {
  const status: AgentStatus = { connected: true, generation: 3, configVersion: 4, config: DEFAULT_CONFIG,
    busy: 'classification', connection: null, verification: null, lastAttempt: null, appliedAt: null, lastUsedVersion: null,
    classifyReady: true };
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

it('refuses a new native dispatch once the executing agent closes admission', async () => {
  const value = prepared(); value.status.classifyReady = false;
  await expect(runPublicationClassificationCall(value.input, value.payload, value.authority, () => value.status))
    .rejects.toMatchObject({ reason: 'reservation_lost' });
  expect(fixture.run).not.toHaveBeenCalled();
});

it('rechecks shutdown immediately before spawn after asynchronous admission and proof', async () => {
  const value = prepared();
  fixture.run.mockImplementation(async (_input: CliCallInput, _signal: undefined, work: CliCapacityWork) => {
    value.status.classifyReady = false;
    expect(work.beforeSpawn()).toBe(false);
    return { kind: 'not_started' };
  });
  await expect(runPublicationClassificationCall(value.input, value.payload, value.authority, () => value.status))
    .rejects.toMatchObject({ reason: 'reservation_lost' });
  expect(fixture.run).toHaveBeenCalledTimes(1);
});
