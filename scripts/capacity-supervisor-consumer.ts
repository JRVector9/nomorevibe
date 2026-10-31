import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertHostDbEntry } from '@/lib/db/host-budget';
import { serviceInstanceId } from '@/lib/operations/instance';
import { supervisorHealthPath } from './consumer-health';

/**
 * Oracle 도우미 장비 감시자 consumer 진입점(pr2-plan §3.1). 감독(worker-supervisor --role=maintenance --consumer=capacity-supervisor)이 띄운다.
 * CAPACITY_SUPERVISOR_VERSION=1 이 없으면 DB·런타임을 열기 전에 끝난다(기본 꺼짐).
 *
 * - 인스턴스는 capacity-supervisor-consumer- 로 시작해야 한다(감독·health·관측 갈래, 0154 관측 키 범위).
 * - replay 범위에서는 열지 않는다. host 합계 장부(HOST_BUDGET_ENFORCEMENT)·비상 admission 은 거절한다 — 이 계정에는 host 장부 권한이 없다.
 * - DB 계정은 nomorevibe_oracle_capacity_supervisor 여야 한다. main 역할(`nomorevibe`)이나 다른 계정이면 아무것도 쓰기 전에
 *   `supervisor_principal_mismatch` 로 끝난다(loop.ts). control 이 꺼져 있으면(enabled=false) 신호 없이 쉰다.
 */
export const CAPACITY_SUPERVISOR_CONSUMER = 'capacity-supervisor' as const;

export function parseCapacitySupervisorArgs(args: string[]): { once: boolean } {
  if (args.filter(arg => arg === '--once').length > 1 || args.some(arg => arg !== '--once')) throw new Error('Usage: capacity-supervisor-consumer.ts [--once]');
  return { once: args.includes('--once') };
}

export async function runCapacitySupervisorProcess(args: string[], env: Readonly<Record<string, string | undefined>> = process.env) {
  const options = parseCapacitySupervisorArgs(args), version = env.CAPACITY_SUPERVISOR_VERSION;
  if (version === undefined) return { state: 'disabled' as const };
  if (version !== '1') throw new Error('invalid_capacity_supervisor_version');
  assertHostDbEntry(env, { kind: 'worker', role: 'maintenance', consumer: CAPACITY_SUPERVISOR_CONSUMER });
  supervisorHealthPath({ consumer: CAPACITY_SUPERVISOR_CONSUMER }, env);
  const [{ assertHostBudgetEntrySupported }, { currentReplayDb }, { withRuntimeProcess }, { runCapacitySupervisor }] = await Promise.all([
    import('@/lib/operations/host-budget'), import('@/lib/db/replay-scope'), import('./worker'), import('@/lib/operations/capacity-supervisor/loop'),
  ]);
  assertHostBudgetEntrySupported(env);
  if (currentReplayDb()) throw new Error('capacity_supervisor_replay_unsupported');
  // 한 프로세스 = 한 boot. 같은 인스턴스가 다시 뜨면 boot 가 바뀌어 epoch 이 올라간다(이전 streak 를 믿지 않는다)
  const release = env.RELEASE_TAG?.trim() || null;
  const owner = { instanceId: serviceInstanceId(env)!, bootId: randomUUID(), release: release && release.length <= 80 ? release : null };
  const summary = await withRuntimeProcess('maintenance', (signal, report) =>
    runCapacitySupervisor({ owner, signal, report, once: options.once }));
  return { state: 'stopped' as const, ...summary };
}

if (process.argv[1] && /^capacity-supervisor-consumer\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void runCapacitySupervisorProcess(process.argv.slice(2)).catch(error => {
    const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'configuration';
    console.error(`capacity supervisor failed: ${code}`); process.exitCode = 1;
  });
}
