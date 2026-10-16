import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { itemOwnerSchema } from '@/lib/jobs/items/types';

export function parsePipelineConsumerArgs(args: string[]): { stage: 'ai2'; once: boolean } {
  if (args.filter(arg => arg === '--stage=ai2').length !== 1 || args.filter(arg => arg === '--once').length > 1
    || args.some(arg => arg !== '--stage=ai2' && arg !== '--once')) throw new Error('Usage: pipeline-consumer.ts --stage=ai2 [--once]');
  return { stage: 'ai2', once: args.includes('--once') };
}
export async function runPipelineConsumer(args: string[], env: Readonly<Record<string, string | undefined>> = process.env) {
  const options = parsePipelineConsumerArgs(args), version = env.PIPELINE_ITEM_CONSUMER_VERSION;
  // Default-off exits before importing the queue, DB or runtime collectors.
  if (version === undefined) return { state: 'disabled' as const };
  if (version !== '1') throw new Error('invalid_pipeline_item_consumer_version');
  const owner = itemOwnerSchema.parse({ instanceId: env.PIPELINE_ITEM_CONSUMER_INSTANCE_ID, bootId: randomUUID() });
  const [{ withRuntimeProcess }, { runSecondReviewConsumer }] = await Promise.all([
    import('./worker'), import('@/lib/crawl/consumers/second'),
  ]);
  const result = await withRuntimeProcess('reviewer', (signal, report) =>
    runSecondReviewConsumer({ owner, signal, report, once: options.once }));
  return { state: 'stopped' as const, ...result };
}
if (process.argv[1] && /^pipeline-consumer\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void runPipelineConsumer(process.argv.slice(2)).catch(() => { console.error('pipeline consumer failed; check configuration'); process.exitCode = 1; });
}
