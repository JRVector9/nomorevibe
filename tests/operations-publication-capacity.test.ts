import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConnectAgent } from '@/lib/operations/agent';
import { seal } from '@/lib/operations/credential-vault';
import { DEFAULT_CONFIG } from '@/lib/operations/contracts';
import { DEFAULT_CATEGORY_DEFINITIONS } from '@/lib/crawl/settings-schema';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { CliPhysicalEndUnknownError } from '@/lib/llm/cli-model-capacity';

const fixture = vi.hoisted(() => ({ path: 'native', call: vi.fn() }));
vi.mock('@/lib/crawl/publication-classify-capacity', () => ({ PUBLICATION_CLASSIFY_ROUTE: 'crawl-publish-classify',
  publicationClassificationPath: async () => { if (fixture.path === 'draining') throw new ModelCapacityDeferredError('draining'); return fixture.path; },
  runPublicationClassificationCall: fixture.call }));
const secret = 'test-operations-secret-with-32-characters';
const auth = JSON.stringify({ tokens: { access_token: 'a'.repeat(30), refresh_token: 'r'.repeat(30), id_token: 'i'.repeat(30) } });
const input = { repo: 'owner/tool', url: 'https://example.com', name: 'Tool', tagline: 'Plan tasks', topics: [], language: null };
const sha = 'a'.repeat(64);
const authority = () => ({ version: 1, members: [{ candidateId: 7, repo: input.repo, sourceHash: sha }], payloadHash: sha,
  definitionsHash: sha, configHash: sha, generation: 3, configVersion: 4,
  job: { name: 'crawl-publish', token: randomUUID(), requestedVersion: 5 },
  publisherRole: { role: 'publisher', instanceId: 'm3-publisher-1', bootId: randomUUID(), release: 'r1', epoch: 2, kind: 'primary' } });
let directory = '', agent: ConnectAgent | undefined;
const originalHome = process.env.CODEX_HOME;
afterEach(() => { agent?.close(); agent = undefined; if (directory) rmSync(directory, { recursive: true, force: true });
  directory = ''; fixture.call.mockReset(); fixture.path = 'native';
  if (originalHome) process.env.CODEX_HOME = originalHome; else delete process.env.CODEX_HOME; });
function create() {
  directory = mkdtempSync(join(tmpdir(), 'classifier-capacity-test-'));
  writeFileSync(join(directory, 'vault.enc'), seal(JSON.stringify({ credential: auth, claudeCredential: 'sk-ant-oat01-' + 'A'.repeat(64), appliedGeneration: 3,
    state: { generation: 3, configVersion: 4, config: DEFAULT_CONFIG } }), secret));
  const legacy = vi.fn().mockResolvedValue({ kind: 'exit', code: 0, stdout: JSON.stringify({ results: [{ id: 0, category: 'Productivity', reason: 'Tasks' }] }), stderr: '' });
  agent = new ConnectAgent(directory, secret, legacy); return { agent, legacy };
}
describe('ConnectAgent native publisher boundary', () => {
  it('rejects an old publisher under open before any model adapter', async () => {
    const { agent, legacy } = create();
    await expect(agent.classify({ inputs: [input] })).rejects.toBeInstanceOf(ModelCapacityDeferredError);
    expect(legacy).not.toHaveBeenCalled(); expect(fixture.call).not.toHaveBeenCalled();
    expect(agent.snapshot().busy).toBeNull();
  });
  it('releases its mutex for admission deferral without fallback', async () => {
    const { agent, legacy } = create(); fixture.call.mockRejectedValue(new ModelCapacityDeferredError('capacity'));
    await expect(agent.classify({ inputs: [input], definitions: DEFAULT_CATEGORY_DEFINITIONS, authority: authority() })).rejects.toMatchObject({ reason: 'capacity' });
    expect(fixture.call).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled(); expect(agent.snapshot().busy).toBeNull();
  });
  it('retains the credential mutex only for this native child with no physical end', async () => {
    const { agent, legacy } = create(); fixture.call.mockRejectedValue(new CliPhysicalEndUnknownError());
    await expect(agent.classify({ inputs: [input], definitions: DEFAULT_CATEGORY_DEFINITIONS, authority: authority() })).rejects.toBeInstanceOf(CliPhysicalEndUnknownError);
    expect(fixture.call).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled();
    expect(agent.snapshot().busy).toBe('classification_unknown');
    await expect(agent.probe('codex')).rejects.toThrow('다른 AI 작업');
  });
  it('sends disabled through the legacy adapter with no new authority requirement', async () => {
    fixture.path = 'legacy'; const { agent, legacy } = create();
    expect((await agent.classify({ inputs: [input] })).categories).toEqual(['Productivity']);
    expect(legacy).toHaveBeenCalledTimes(1); expect(fixture.call).not.toHaveBeenCalled();
  });
  it.each(['native', 'draining'])('defers manual probes and configuration tests under %s before any model adapter', async path => {
    fixture.path = path; const { agent, legacy } = create(), before = agent.snapshot();
    await expect(Promise.resolve().then(() => agent.probe('codex'))).rejects.toBeInstanceOf(ModelCapacityDeferredError);
    await expect(Promise.resolve().then(() => agent.probe('claude'))).rejects.toBeInstanceOf(ModelCapacityDeferredError);
    await expect(Promise.resolve().then(() => agent.test(DEFAULT_CONFIG))).rejects.toBeInstanceOf(ModelCapacityDeferredError);
    expect(legacy).not.toHaveBeenCalled(); expect(fixture.call).not.toHaveBeenCalled();
    expect(agent.snapshot().busy).toBeNull(); expect(agent.snapshot().verification).toEqual(before.verification);
    expect(agent.snapshot().accounts).toEqual(before.accounts);
  });
  it('uses the frozen actual fallback only after the prior native call returns a terminal result', async () => {
    const { agent, legacy } = create();
    fixture.call.mockResolvedValueOnce({ kind: 'exit', code: 1, stdout: '', stderr: 'rate limit' })
      .mockResolvedValueOnce({ kind: 'exit', code: 0, stdout: JSON.stringify({ structured_output: {
        results: [{ id: 0, category: 'Productivity', reason: 'Tasks' }] } }), stderr: '' });
    expect((await agent.classify({ inputs: [input], definitions: DEFAULT_CATEGORY_DEFINITIONS, authority: authority() })).categories).toEqual(['Productivity']);
    expect(fixture.call.mock.calls.map(call => call[0].provider)).toEqual(['codex-cli', 'claude-cli']);
    expect(fixture.call.mock.calls[1][0].args).toContain('--max-turns');
    expect(legacy).not.toHaveBeenCalled(); expect(agent.snapshot().busy).toBeNull();
  });
  it('closes admission immediately but drains through the admitted native result and reconciliation promise', async () => {
    const { agent, legacy } = create(); let reconciled!: () => void;
    fixture.call.mockImplementation(() => new Promise(resolve => { reconciled = () => resolve({ kind: 'exit', code: 0,
      stdout: JSON.stringify({ results: [{ id: 0, category: 'Productivity', reason: 'Tasks' }] }), stderr: '' }); }));
    const running = agent.classify({ inputs: [input], definitions: DEFAULT_CATEGORY_DEFINITIONS, authority: authority() });
    await vi.waitFor(() => expect(fixture.call).toHaveBeenCalledTimes(1));
    let drained = false; const drain = agent.drain().then(() => { drained = true; });
    expect(agent.snapshot().classifyReady).toBe(false);
    await expect(agent.classify({ inputs: [input], definitions: DEFAULT_CATEGORY_DEFINITIONS, authority: authority() }))
      .rejects.toMatchObject({ reason: 'draining' });
    await Promise.resolve(); expect(drained).toBe(false); expect(fixture.call).toHaveBeenCalledTimes(1);
    reconciled(); expect((await running).categories).toEqual(['Productivity']); await drain;
    expect(drained).toBe(true); expect(legacy).not.toHaveBeenCalled();
  });
  it('does not start fallback after shutdown even when the admitted primary returns a settled failure', async () => {
    const { agent, legacy } = create(); let primaryEnded!: () => void;
    fixture.call.mockImplementation(() => new Promise(resolve => { primaryEnded = () => resolve({ kind: 'exit', code: 1, stdout: '', stderr: 'rate limit' }); }));
    const running = agent.classify({ inputs: [input], definitions: DEFAULT_CATEGORY_DEFINITIONS, authority: authority() });
    const rejected = expect(running).rejects.toMatchObject({ reason: 'draining' });
    await vi.waitFor(() => expect(fixture.call).toHaveBeenCalledTimes(1));
    const drain = agent.drain(); const drainRejected = expect(drain).rejects.toMatchObject({ reason: 'draining' });
    primaryEnded(); await rejected; await drainRejected;
    expect(fixture.call).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled();
  });
  it('does not turn a prior unknown physical end into a successful shutdown drain', async () => {
    const { agent } = create(); fixture.call.mockRejectedValue(new CliPhysicalEndUnknownError());
    await expect(agent.classify({ inputs: [input], definitions: DEFAULT_CATEGORY_DEFINITIONS, authority: authority() }))
      .rejects.toBeInstanceOf(CliPhysicalEndUnknownError);
    await expect(agent.drain()).rejects.toBeInstanceOf(CliPhysicalEndUnknownError);
    expect(agent.snapshot().busy).toBe('classification_unknown');
  });
});
