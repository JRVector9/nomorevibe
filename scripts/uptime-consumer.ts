import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertHostDbEntry } from '@/lib/db/host-budget';
import { serviceInstanceId } from '@/lib/operations/instance';
import { supervisorHealthPath } from './consumer-health';

/**
 * split-v1 제품 연결 확인 consumer 진입점(design-uptime §7.2). 감독(worker-supervisor --role=maintenance --consumer=uptime)이 띄운다.
 * UPTIME_CONSUMER_VERSION=1 이 없으면 DB·런타임을 열기 전에 끝난다(기본 꺼짐).
 *
 * - 인스턴스는 uptime-consumer- 로 시작해야 한다(감독·health·관측 갈래). host·class 는 env 가 아니라 split 정책의 instance 매핑이 정한다.
 * - 공유 HTTP permit(HTTP_ORIGIN_PERMITS=1)은 거절한다(§4: uptime 은 전역 permit 밖, 같은 사이트 동시 1 은 claim 의 origin 배타가 지킨다).
 *   host 합계 장부(HOST_BUDGET_ENFORCEMENT)·비상 admission 도 permit 을 전제로 하므로 켜져 있으면 거절한다 — 세지 않은 채 조용히 돌지 않는다.
 */
export function parseUptimeConsumerArgs(args: string[]): { once: boolean } {
  if (args.filter(arg => arg === '--once').length > 1 || args.some(arg => arg !== '--once')) throw new Error('Usage: uptime-consumer.ts [--once]');
  return { once: args.includes('--once') };
}
export async function runUptimeConsumerProcess(args: string[], env: Readonly<Record<string, string | undefined>> = process.env) {
  const options = parseUptimeConsumerArgs(args), version = env.UPTIME_CONSUMER_VERSION;
  if (version === undefined) return { state: 'disabled' as const };
  if (version !== '1') throw new Error('invalid_uptime_consumer_version');
  assertHostDbEntry(env, { kind: 'worker', role: 'maintenance', consumer: 'uptime' });
  supervisorHealthPath({ consumer: 'uptime' }, env);
  if (env.HTTP_ORIGIN_PERMITS !== undefined && env.HTTP_ORIGIN_PERMITS !== '0') throw new Error('uptime_consumer_http_permits_unsupported');
  const [{ assertHostBudgetEntrySupported }, { withRuntimeProcess }, { runUptimeConsumer }] = await Promise.all([
    import('@/lib/operations/host-budget'), import('./worker'), import('@/lib/jobs/products/uptime-consumer'),
  ]);
  assertHostBudgetEntrySupported(env);
  // 한 프로세스 = 한 boot. 제출·되돌림은 같은 instance·boot 의 claim 만 바꾼다
  const owner = { instanceId: serviceInstanceId(env)!, bootId: randomUUID() }, physicalHost = env.PHYSICAL_HOST?.trim() || undefined;
  const result = await withRuntimeProcess('maintenance', (signal, report) =>
    runUptimeConsumer({ owner, signal, report, once: options.once, ...(physicalHost ? { physicalHost } : {}) }));
  return { state: 'stopped' as const, ...result };
}
if (process.argv[1] && /^uptime-consumer\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void runUptimeConsumerProcess(process.argv.slice(2)).catch(() => { console.error('uptime consumer failed; check configuration'); process.exitCode = 1; });
}
