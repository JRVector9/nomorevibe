import { describe, expect, it, vi } from 'vitest';
import { classifyCategories } from '@/lib/crawl/classify';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { createHash, randomUUID } from 'node:crypto';
import { cliDispatchBindingSchema } from '@/lib/llm/capacity';

const input = { repo: 'owner/tool', url: 'https://example.com', name: 'Tool', tagline: 'Plan tasks', topics: [], language: null };
describe('publication classifier admission', () => {
  it('accepts one purpose-specific publisher binding without impersonating an intro check', () => {
    const sha = 'a'.repeat(64), members = [{ candidateId: 7, repo: 'owner/tool', sourceHash: sha }];
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => [k, canonical(v)])) : value;
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
    const facts = { members, provider: 'codex-cli', model: 'gpt-5.6-terra', payloadHash: sha, definitionsHash: sha,
      configHash: sha, generation: 3, configVersion: 4 };
    const value = { ...facts, kind: 'publication_classify_cli', version: 1,
      logicalWorkKey: `bg:publication-classify:${hash(['classify:7'])}`, inputHash: hash(facts),
      routeId: 'crawl-publish-classify', job: { name: 'crawl-publish', token: randomUUID(), requestedVersion: 5 },
      publisherRole: { role: 'publisher', instanceId: 'm3-publisher-1', bootId: randomUUID(), release: 'release', epoch: 2, kind: 'primary' },
      transport: { protocol: 'cli-process-v1', provider: 'codex-cli', model: 'gpt-5.6-terra', argvHash: sha, inputHash: sha,
        envPolicyHash: sha, cliContractHash: sha, timeoutMs: 35_000, maxStdoutBytes: 65_536, maxStderrBytes: 32_768 },
      totalTokenBound: 200_000, chargedTokens: 200_000 };
    expect(cliDispatchBindingSchema.safeParse(value).success).toBe(true);
    for (const changed of [{ ...value, kind: 'intro_check_cli' }, { ...value, provider: 'grok-cli' },
      { ...value, publisherRole: { ...value.publisherRole, role: 'reviewer' } },
      { ...value, members: [...members, members[0]] }, { ...value, inputHash: 'b'.repeat(64) },
      { ...value, job: { ...value.job, name: 'product-intro-check' } }])
      expect(cliDispatchBindingSchema.safeParse(changed).success).toBe(false);
  });
  it('does not turn an unsettled primary dispatch into a fallback model call', async () => {
    const deferred = new ModelCapacityDeferredError('dispatched');
    const run = vi.fn().mockRejectedValue(deferred);
    await expect(classifyCategories([input], run, [
      { model: 'gpt-5.6-terra', effort: 'xhigh', timeoutMs: 35_000 },
      { model: 'sonnet', effort: 'high', timeoutMs: 35_000 },
    ])).rejects.toBe(deferred);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
