import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { itemOwnerSchema } from '@/lib/jobs/items/types';
import { serviceInstanceId } from '@/lib/operations/instance';
import { supervisorHealthPath } from './consumer-health';
import { assertHostDbEntry } from '@/lib/db/host-budget';
import { assertHostBudgetEntrySupported } from '@/lib/operations/host-budget';
import { processGroupBootFor } from '@/lib/operations/dr/process-owner-env';

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
  assertHostBudgetEntrySupported(env);
  supervisorHealthPath({ consumer: 'ai1' }, env);
  // D11: 슈퍼바이저가 이 consumer instance 로 spawn 의도를 기록했으면 그 boot 가 item(=장부) owner 다. 아니면 새 boot(근거 없는 owner).
  const owner = itemOwnerSchema.parse({ instanceId: env.PIPELINE_ITEM_CONSUMER_INSTANCE_ID,
    bootId: processGroupBootFor(env.PIPELINE_ITEM_CONSUMER_INSTANCE_ID, env) ?? randomUUID() });
  if (owner.instanceId !== serviceInstanceId(env)) throw new Error('invalid_item_consumer_service_instance');
  const [{ withRuntimeProcess }, { runFirstReviewConsumer }] = await Promise.all([
    import('./worker'), import('@/lib/crawl/consumers/first'),
  ]);
  const result = await withRuntimeProcess('reviewer', (signal, report) => runFirstReviewConsumer({ owner, signal, report, once: options.once }));
  return { state: 'stopped' as const, ...result };
}
if (process.argv[1] && /^pipeline-first-consumer\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void runPipelineFirstConsumer(process.argv.slice(2)).catch(() => { console.error('first pipeline consumer failed; check configuration'); process.exitCode = 1; });
}
