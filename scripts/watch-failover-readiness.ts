/** Separate read-only watcher. Kuma Push URL is never written to logs. */
import { writeFileSync, renameSync } from 'node:fs';
import { basename } from 'node:path';
import { readMonitorStatus, type MonitorStatus } from '../lib/operations/failover-monitor';

export type MonitorCycleState = { badSamples: number };
type CycleDependencies = {
  push: (state: 'up' | 'down', message: string) => Promise<void>;
  record: (status: MonitorStatus) => void;
};

export async function runMonitorCycle(
  state: MonitorCycleState, status: MonitorStatus, deps: CycleDependencies,
): Promise<MonitorCycleState> {
  deps.record(status);
  const badSamples = status.overall === 'ok' ? 0 : Math.min(2, state.badSamples + 1);
  if (badSamples >= 2 || status.overall === 'ok') {
    try {
      await deps.push(status.overall === 'ok' ? 'up' : 'down', `worker failover ${status.overall}`);
    } catch {
      throw new Error('monitor_push_failed');
    }
  }
  return { badSamples };
}

export function recordMonitorHeartbeat(status: MonitorStatus, path = process.env.MONITOR_HEALTH_PATH ?? '/tmp/monitor-health.json') {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ checkedAt: Date.now(), overall: status.overall }), { mode: 0o600 });
  renameSync(temporary, path);
}

export async function pushKumaStatus(url: string, state: 'up' | 'down', message: string): Promise<void> {
  try {
    const target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('unsupported_protocol');
    target.searchParams.set('status', state);
    target.searchParams.set('msg', message);
    const response = await fetch(target, { method: 'POST', signal: AbortSignal.timeout(5_000) });
    if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) {
      throw new Error('non_success_response');
    }
  } catch {
    throw new Error('monitor_push_failed');
  }
}

async function main() {
  const url = process.env.MONITOR_PUSH_URL;
  if (!url) throw new Error('MONITOR_PUSH_URL is required');
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  let state: MonitorCycleState = { badSamples: 0 };
  while (!stop.signal.aborted) {
    const status = await readMonitorStatus();
    try {
      state = await runMonitorCycle(state, status, {
        push: (next, message) => pushKumaStatus(url, next, message),
        record: recordMonitorHeartbeat,
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'monitor_push_failed') throw error;
      state = { badSamples: status.overall === 'ok' ? 0 : Math.min(2, state.badSamples + 1) };
      console.error('monitor push failed');
    }
    console.log(JSON.stringify({ measuredAt: status.measuredAt, overall: status.overall,
      badSamples: state.badSamples }));
    await new Promise<void>(resolve => {
      const onAbort = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { stop.signal.removeEventListener('abort', onAbort); resolve(); }, 30_000);
      stop.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  const client = (globalThis as { pgClient?: { end: (options: { timeout: number }) => Promise<void> } }).pgClient;
  await client?.end({ timeout: 5 }).catch(() => {});
}

if (process.argv[1] && basename(process.argv[1]) === 'watch-failover-readiness.ts') {
  void main().catch(() => { console.error('monitor failed; check configuration'); process.exitCode = 1; });
}
