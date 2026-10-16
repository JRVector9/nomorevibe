import { resolve } from 'node:path';
import { serviceInstanceId } from '../lib/operations/instance';

export const DEFAULT_HEALTH_PATH = '/tmp/nomorevibe-worker-health.json';
const FIRST_HEALTH_PATH = '/tmp/nomorevibe-ai1-consumer-health.json';
const SECOND_HEALTH_PATH = '/tmp/nomorevibe-ai2-consumer-health.json';
/** Observation routing only. A dedicated instance/path grants no item or role authority. */
export function consumerHealthPath(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const stage = env.SERVICE_INSTANCE_ID?.trim().startsWith('ai1-consumer-') ? 'ai1'
    : env.SERVICE_INSTANCE_ID?.trim().startsWith('ai2-consumer-') ? 'ai2' : null;
  if (stage === null) return null;
  const prefix = `${stage}-consumer-`, instance = serviceInstanceId(env);
  if (!instance || instance.length === prefix.length) throw new Error('invalid_item_consumer_service_instance');
  const path = env.WORKER_HEALTH_PATH ?? (stage === 'ai1' ? FIRST_HEALTH_PATH : SECOND_HEALTH_PATH);
  if (!path.trim() || resolve(path) === resolve(DEFAULT_HEALTH_PATH)
    || stage === 'ai1' && resolve(path) === resolve(SECOND_HEALTH_PATH)) throw new Error('invalid_item_consumer_health_path');
  return path;
}
export function supervisorHealthPath(options: { consumer?: 'ai1' | 'ai2'; healthPath?: string },
  env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (options.consumer !== undefined) {
    if (!env.SERVICE_INSTANCE_ID?.trim().startsWith(`${options.consumer}-consumer-`)) throw new Error('invalid_item_consumer_service_instance');
    const path = consumerHealthPath(env);
    if (!path) throw new Error('invalid_item_consumer_service_instance');
    if (options.healthPath !== undefined && (!options.healthPath.trim() || resolve(options.healthPath) === resolve(DEFAULT_HEALTH_PATH)
      || options.consumer === 'ai1' && resolve(options.healthPath) === resolve(SECOND_HEALTH_PATH))) throw new Error('invalid_item_consumer_health_path');
    return options.healthPath ?? path;
  }
  return options.healthPath ?? env.WORKER_HEALTH_PATH ?? DEFAULT_HEALTH_PATH;
}
