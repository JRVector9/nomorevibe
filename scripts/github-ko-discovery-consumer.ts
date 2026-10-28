import { basename } from 'node:path';
import { assertHostBudgetEntrySupported } from '@/lib/operations/host-budget';
import { assertHostDbEntry } from '@/lib/db/host-budget';
import { collectorScope } from '@/lib/crawl/github-secret';
import { serviceInstanceId } from '@/lib/operations/instance';
import { supervisorHealthPath } from './consumer-health';

export function parseKoreanDiscoveryArgs(args: string[]) {
  if (args.some(arg=>arg!=='--once') || args.length>1) throw new Error('Usage: github-ko-discovery-consumer.ts [--once]');
  return { once: args.includes('--once') };
}
export async function runKoreanDiscoveryProcess(args: string[], env: Readonly<Record<string,string|undefined>> = process.env) {
  const { once } = parseKoreanDiscoveryArgs(args);
  if (env.GITHUB_KO_DISCOVERY_VERSION === undefined) return { state: 'disabled' as const };
  if (env.GITHUB_KO_DISCOVERY_VERSION !== '1') throw new Error('invalid_korean_discovery_version');
  // This staging principal has no host-ledger cleanup or shared HTTP permit authority.
  assertHostBudgetEntrySupported(env);
  assertHostDbEntry(env, { kind: 'worker', role: 'crawler', consumer: 'github-ko-discovery' });
  supervisorHealthPath({ consumer: 'github-ko-discovery' }, env);
  const scope = collectorScope(env);
  if (!scope || scope.sources.size !== 1 || !scope.sources.has('apps')) throw new Error('korean_discovery_requires_apps_only');
  if (env.HTTP_ORIGIN_PERMITS !== undefined && env.HTTP_ORIGIN_PERMITS !== '0') throw new Error('korean_discovery_http_permits_unsupported');
  const instanceId = serviceInstanceId(env);
  if (!instanceId) throw new Error('invalid_korean_discovery_instance');
  const [{ withRuntimeProcess, interruptibleSleep }, { koreanDiscoveryTick }] = await Promise.all([
    import('./worker'), import('@/lib/crawl/korean-discovery/consumer'),
  ]);
  return withRuntimeProcess('crawler', async (signal, report) => {
    do {
      report('running', 'github-ko-discovery', Date.now());
      await koreanDiscoveryTick({ instanceId, signal, deadlineAt: Date.now()+45_000 });
      report('idle');
      if (once || signal.aborted) break;
      await interruptibleSleep(15_000, signal);
    } while (!signal.aborted);
    return { state: 'stopped' as const };
  });
}
if (process.argv[1] && /^github-ko-discovery-consumer\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void runKoreanDiscoveryProcess(process.argv.slice(2)).catch(() => { console.error('Korean GitHub discovery failed; check configuration'); process.exitCode=1; });
}
