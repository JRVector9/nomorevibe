import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { itemOwnerSchema } from '@/lib/jobs/items/types';
import { assertHostDbEntry } from '@/lib/db/host-budget';
import { collectorScope } from '@/lib/crawl/github-secret';
import { serviceInstanceId } from '@/lib/operations/instance';
import { supervisorHealthPath } from './consumer-health';

/**
 * 제작 근거 스캔 consumer 진입점(lib/domain/evidence/agents/consumer.ts). 감독이 띄운다:
 * `worker-supervisor.ts --role=crawler --consumer=agent-scan` — M3 Dokploy 앱과 Oracle unit(launch.py --consumer=agent-scan)이 같다.
 *
 * 기본 꺼짐: AGENT_SCAN_CONSUMER_VERSION 이 없으면 DB·런타임을 불러오기 전에 끝난다. 켜져 있어도 agent_scan_control 이 items 가
 * 아니면 claim 하지 않고 쉰다(배포만으로 동작이 바뀌지 않는다). SERVICE_INSTANCE_ID 는 agent-scan-consumer-<자리>(예: -m3, -oracle)다.
 */
export function parseAgentScanConsumerArgs(args: string[]): { once: boolean } {
  if (args.filter(arg => arg === '--once').length > 1 || args.some(arg => arg !== '--once'))
    throw new Error('Usage: agent-scan-consumer.ts [--once]');
  return { once: args.includes('--once') };
}
/** AGENT_SCAN_CONCURRENCY: 동시 스캔 수 1..4, 없으면 1. 그 밖의 값은 조용히 고치지 않고 던진다 */
export function agentScanConcurrency(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.AGENT_SCAN_CONCURRENCY;
  if (raw === undefined) return 1;
  if (!/^[1-4]$/.test(raw)) throw new Error('invalid_agent_scan_concurrency');
  return Number(raw);
}
export async function runAgentScanConsumerProcess(args: string[], env: Readonly<Record<string, string | undefined>> = process.env) {
  const options = parseAgentScanConsumerArgs(args), version = env.AGENT_SCAN_CONSUMER_VERSION;
  if (version === undefined) return { state: 'disabled' as const };
  if (version !== '1') throw new Error('invalid_agent_scan_consumer_version');
  const concurrency = agentScanConcurrency(env);
  assertHostDbEntry(env, { kind: 'worker', role: 'crawler', consumer: 'agent-scan' });
  // 관측·건강 파일 자리와 claim owner 가 같은 인스턴스다(agent-scan-consumer-<자리>)
  supervisorHealthPath({ consumer: 'agent-scan' }, env);
  // 수집 자격 설정이 틀리면 첫 GitHub 요청이 아니라 시작에서 멈춘다(github-secret.ts)
  collectorScope(env);
  const owner = itemOwnerSchema.parse({ instanceId: serviceInstanceId(env), bootId: randomUUID() });
  const [{ withRuntimeProcess }, { runAgentScanConsumer }, { startHostBudget }, { supervisorLimits }] = await Promise.all([
    import('./worker'), import('@/lib/domain/evidence/agents/consumer'), import('@/lib/operations/host-budget-runtime'), import('./worker-supervisor'),
  ]);
  const result = await withRuntimeProcess('crawler', async (signal, report) => {
    // worker 와 같은 host 장부 자리. 비활성이면 DB·타이머 없이 바로 claim 한다
    const limits = supervisorLimits('crawler', env), host = startHostBudget(env, { holdMs: limits.jobMs + limits.drainMs });
    try {
      if (host.enabled) await host.settled;
      return await runAgentScanConsumer({ owner, signal, report, once: options.once, concurrency, ...(host.enabled ? { admit: host.admit } : {}) });
    } finally { await host.stop(); }
  });
  return { state: 'stopped' as const, ...result };
}
if (process.argv[1] && /^agent-scan-consumer\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void runAgentScanConsumerProcess(process.argv.slice(2)).catch(() => { console.error('agent scan consumer failed; check configuration'); process.exitCode = 1; });
}
