import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { itemOwnerSchema } from '@/lib/jobs/items/types';
import { serviceInstanceId } from '@/lib/operations/instance';
import { supervisorHealthPath } from './consumer-health';
import { assertHostDbEntry } from '@/lib/db/host-budget';
import { createProviderCircuits, providerCircuitConfig } from '@/lib/llm/provider-circuit-breaker';

export function parsePipelineFirstConsumerArgs(args: string[]): { once: boolean } {
  if (args.filter(arg => arg === '--once').length > 1 || args.some(arg => arg !== '--once'))
    throw new Error('Usage: pipeline-first-consumer.ts [--once]');
  return { once: args.includes('--once') };
}
export async function runPipelineFirstConsumer(args: string[], env: Readonly<Record<string, string | undefined>> = process.env) {
  const options = parsePipelineFirstConsumerArgs(args), version = env.PIPELINE_ITEM_CONSUMER_VERSION;
  if (version === undefined) return { state: 'disabled' as const };
  if (version !== '1') throw new Error('invalid_pipeline_item_consumer_version');
  assertHostDbEntry(env, { kind: 'worker', role: 'reviewer', consumer: 'ai1' });
  supervisorHealthPath({ consumer: 'ai1' }, env);
  const owner = itemOwnerSchema.parse({ instanceId: env.PIPELINE_ITEM_CONSUMER_INSTANCE_ID, bootId: randomUUID() });
  if (owner.instanceId !== serviceInstanceId(env)) throw new Error('invalid_item_consumer_service_instance');
  const circuit = providerCircuitConfig(env);
  const [{ withRuntimeProcess }, { runFirstReviewConsumer }, { startHostBudget }, { supervisorLimits }] = await Promise.all([
    import('./worker'), import('@/lib/crawl/consumers/first'), import('@/lib/operations/host-budget-runtime'), import('./worker-supervisor'),
  ]);
  const result = await withRuntimeProcess('reviewer', async (signal, report) => {
    // worker 와 같은 host 장부 자리(PR10e). 감독이 item 을 끊는 한도(job+drain)까지 비상 slot 을 지킨다. 비활성이면 DB·타이머 없이 기존 그대로다
    const limits = supervisorLimits('reviewer', env), host = startHostBudget(env, { holdMs: limits.jobMs + limits.drainMs });
    try {
      if (host.enabled) await host.settled;
      return await runFirstReviewConsumer({ owner, signal, report, once: options.once, ...(host.enabled ? { admit: host.admit } : {}),
        ...(circuit.mode === 'enabled' ? { circuits: createProviderCircuits(circuit) } : {}) });
    } finally { await host.stop(); }
  });
  return { state: 'stopped' as const, ...result };
}
if (process.argv[1] && /^pipeline-first-consumer\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void runPipelineFirstConsumer(process.argv.slice(2)).catch(() => { console.error('first pipeline consumer failed; check configuration'); process.exitCode = 1; });
}
