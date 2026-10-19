import { resolve } from 'node:path';
import { serviceInstanceId } from '../lib/operations/instance';
import { consumerInstancePrefix, consumerNames, consumerOfInstance, type ConsumerName } from '../lib/runtime/consumer-registry';

export const DEFAULT_HEALTH_PATH = '/tmp/nomorevibe-worker-health.json';
const defaultConsumerPath = (consumer: string) => `/tmp/nomorevibe-${consumer}-consumer-health.json`;
/** 역할 기본 파일이나 다른 consumer 의 기본 파일은 쓰지 않는다 — 한 자리의 두 감독이 서로의 건강 기록을 덮지 않게 */
function sharedPath(consumer: ConsumerName, path: string) {
  return resolve(path) === resolve(DEFAULT_HEALTH_PATH)
    || consumerNames().some(other => other !== consumer && resolve(path) === resolve(defaultConsumerPath(other)));
}
/** SERVICE_INSTANCE_ID 가 등록된 consumer 접두(<이름>-consumer-)로 시작하면 그 consumer. Observation routing only. */
export function instanceConsumer(env: Readonly<Record<string, string | undefined>> = process.env): ConsumerName | null {
  return consumerOfInstance(env.SERVICE_INSTANCE_ID?.trim());
}
/** Observation routing only. A dedicated instance/path grants no item or role authority. */
export function consumerHealthPath(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const consumer = instanceConsumer(env);
  if (consumer === null) return null;
  const prefix = consumerInstancePrefix(consumer), instance = serviceInstanceId(env);
  if (!instance || instance.length === prefix.length) throw new Error('invalid_item_consumer_service_instance');
  const path = env.WORKER_HEALTH_PATH ?? defaultConsumerPath(consumer);
  if (!path.trim() || sharedPath(consumer, path)) throw new Error('invalid_item_consumer_health_path');
  return path;
}
export function supervisorHealthPath(options: { consumer?: ConsumerName; healthPath?: string },
  env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (options.consumer !== undefined) {
    if (instanceConsumer(env) !== options.consumer) throw new Error('invalid_item_consumer_service_instance');
    const path = consumerHealthPath(env);
    if (!path) throw new Error('invalid_item_consumer_service_instance');
    if (options.healthPath !== undefined && (!options.healthPath.trim() || sharedPath(options.consumer, options.healthPath))) {
      throw new Error('invalid_item_consumer_health_path');
    }
    return options.healthPath ?? path;
  }
  return options.healthPath ?? env.WORKER_HEALTH_PATH ?? DEFAULT_HEALTH_PATH;
}
