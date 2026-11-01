/** Separate read-only watcher. Kuma Push URL is never written to logs. */
import { writeFileSync, renameSync } from 'node:fs';
import { basename } from 'node:path';
import { fetch as monitorFetch } from 'undici';
import { readMonitorStatus, type MonitorStatus } from '../lib/operations/failover-monitor';
import { TEXT_PROGRESS_STAGE_JOBS } from '../lib/operations/worker-progress';
import { readBodyStrictlyCapped } from '../lib/net/fetch';
import { capacityMonitorThresholds } from '../lib/operations/model-capacity-unknowns';
import { validDiscoveryFailures } from '../lib/crawl/discovery-checkpoint-contract';

export type MonitorCycleState = { badSamples: number };
export type MonitorPushTarget = { name: 'primary' | 'external'; url: string };
export type MonitorPushReceipt = { target: MonitorPushTarget['name']; ok: boolean; attemptedAt: string };
type CycleDependencies = {
  push: (state: 'up' | 'down', message: string) => Promise<void>;
  record: (status: MonitorStatus) => void;
};

const STAGE_FAILURE_STAGES = new Set(['fetch', 'judge', 'publish', 'evidence', 'agent-evidence', 'ai-level', 'uptime',
  ...Object.keys(TEXT_PROGRESS_STAGE_JOBS)]);
const STAGE_FAILURE_REASONS = new Set(['no_progress', 'worker_missing', 'consumer_missing', 'upstream_stalled']);
const STAGE_FAILURE_ROLES = new Set(['scheduler', 'crawler', 'reviewer', 'publisher', 'maintenance', 'text']);
const KNOWN_PROGRESS_REASONS = new Set(['paused', 'no_work', 'progressing', 'running', 'backoff', 'upstream_or_job_error',
  'upstream_stalled', 'warming_up', 'worker_missing', 'no_progress', 'manual_attention', 'consumer_missing']);

const ageText = (seconds: number) => seconds >= 86_400 ? `${Math.floor(seconds / 86_400)}d` : seconds >= 3_600
  ? `${Math.floor(seconds / 3_600)}h` : `${Math.floor(seconds / 60)}m`;

/** Kuma 메시지. 확인 못함(review)은 UP 메시지에 건수·가장 오래된 나이만 덧붙인다 — 상태(up/down)는 바꾸지 않는다. */
export function monitorPushMessage(status: MonitorStatus): string {
  const capacity = status.capacityUnknowns, base = `worker failover ${status.overall}`;
  if (!capacity || capacity.status === 'unknown' || capacity.status === 'ok') return base;
  const review = capacity.count ? `capacity review ${capacity.count}${capacity.oldestAgeSeconds === null ? '' : ` (oldest ${ageText(capacity.oldestAgeSeconds)})`}` : '';
  const alarm = capacity.alarmReasons.length ? `capacity alarm ${capacity.alarmReasons.join('+')}` : '';
  return [base, alarm, review].filter(Boolean).join('; ');
}

export async function runMonitorCycle(
  state: MonitorCycleState, status: MonitorStatus, deps: CycleDependencies,
): Promise<MonitorCycleState> {
  deps.record(status);
  const badSamples = status.overall === 'ok' ? 0 : Math.min(2, state.badSamples + 1);
  if (badSamples >= 2 || status.overall === 'ok') {
    try {
      await deps.push(status.overall === 'ok' ? 'up' : 'down', monitorPushMessage(status));
    } catch {
      throw new Error('monitor_push_failed');
    }
  }
  return { badSamples };
}

export function recordMonitorHeartbeat(status: MonitorStatus, path = process.env.MONITOR_HEALTH_PATH ?? '/tmp/monitor-health.json') {
  const temporary = `${path}.${process.pid}.tmp`;
  const positive = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  // Stable keys let the independent watchdog age a failure across retries without
  // persisting provider bodies. Missing progress differs from an observed clear.
  const providerFailures = status.progress ? Object.keys(TEXT_PROGRESS_STAGE_JOBS).filter(key => status.progress!.stages.some(stage =>
    stage.stage === key && !['paused', 'no_work', 'manual_attention'].includes(stage.reason) && stage.held !== true
    && (positive(stage.waiting) || positive(stage.deferred)) && (positive(stage.providerErrors) || positive(stage.errors5m))
    && [stage.completed5m, stage.progress5m].every(value => value == null || value === 0))) : undefined;
  // A healthy process can be unable to review because a remote model still owns
  // capacity. Report the actual stage separately from the service heartbeat;
  // these observations never grant remote kill/restart or ledger-release rights.
  const reviewFailures = status.progress ? (['first', 'second'] as const).flatMap(key => {
    const stage = status.progress!.stages.find(row => row.stage === key);
    if (!stage || stage.alarm !== true || stage.held === true
      || !(positive(stage.waiting) || positive(stage.deferred))
      || ![stage.completed5m, stage.progress5m].every(value => value == null || value === 0)) return [];
    const reason = stage.admissionBlock?.reason === 'capacity' ? 'capacity_blocked'
      : stage.reason === 'consumer_missing' ? 'consumer_missing'
      : stage.reason === 'worker_missing' ? 'worker_missing'
      : stage.reason === 'upstream_stalled' ? 'upstream_stalled'
      : stage.reason === 'no_progress' ? (stage.restartEligible === true ? 'local_stalled' : 'review_stalled') : null;
    return reason ? [{ stage: key, reason }] : [];
  }) : undefined;
  // The existing review/provider paths retain their timing and signatures. This
  // optional, fixed vocabulary adds faults hidden by an already-DOWN aggregate.
  // A different alarm can dominate overall while one stage's age is unknown.
  // Such a report cannot establish an explicit clear of earlier stage faults.
  const stagesKnown = status.progress && ['ok', 'alarm'].includes(status.progress.overall)
    && new Set(status.progress.stages.map(stage => stage.stage)).size === status.progress.stages.length
    && status.progress.stages.every(stage => (STAGE_FAILURE_STAGES.has(stage.stage) || ['first', 'second'].includes(stage.stage))
      && KNOWN_PROGRESS_REASONS.has(stage.reason) && typeof stage.alarm === 'boolean'
      && (stage.held === undefined || typeof stage.held === 'boolean')
      && ['waiting', 'deferred', 'completed5m', 'providerErrors']
        .every(key => {
          const value = stage[key as keyof typeof stage];
          return value === undefined || typeof value === 'number' && Number.isFinite(value) && value >= 0;
        })
      && ['progress5m', 'errors5m', 'oldestMinutes', 'providerErrorMinutes']
        .every(key => {
          const value = stage[key as keyof typeof stage];
          return value == null || typeof value === 'number' && Number.isFinite(value) && value >= 0;
        }))
    && ['scheduled', 'scheduler_missed', 'worker_missing'].includes(status.progress.scheduler.reason)
    && typeof status.progress.scheduler.alarm === 'boolean'
    && new Set(status.progress.liveness.map(role => role.role)).size === status.progress.liveness.length
    && status.progress.liveness.every(role => STAGE_FAILURE_ROLES.has(role.role)
      && ['present', 'worker_missing', 'restart_loop'].includes(role.reason) && typeof role.alarm === 'boolean');
  const stageFailures = stagesKnown && status.progress ? [
    ...status.progress.stages.flatMap(stage => {
      if (!STAGE_FAILURE_STAGES.has(stage.stage) || stage.alarm !== true || stage.held === true
        || !STAGE_FAILURE_REASONS.has(stage.reason)
        || (stage.reason === 'upstream_stalled' && providerFailures?.includes(stage.stage))) return [];
      return [{ stage: stage.stage, reason: stage.reason }];
    }),
    ...(status.progress.scheduler.alarm === true
      && ['scheduler_missed', 'worker_missing'].includes(status.progress.scheduler.reason)
      ? [{ stage: 'scheduler', reason: status.progress.scheduler.reason }] : []),
    ...status.progress.liveness.flatMap(role => STAGE_FAILURE_ROLES.has(role.role) && role.alarm === true
      && ['worker_missing', 'restart_loop'].includes(role.reason)
      ? [{ stage: `role-${role.role}`, reason: role.reason }] : []),
  ] : undefined;
  const discovery = status.discovery?.failures;
  const discoveryFailures = validDiscoveryFailures(discovery) ? discovery : undefined;
  writeFileSync(temporary, JSON.stringify({ checkedAt: Date.now(), overall: status.overall, providerFailures, reviewFailures, stageFailures, discoveryFailures,
    capacityUnknowns: status.capacityUnknowns }), { mode: 0o600 });
  renameSync(temporary, path);
}

export async function pushKumaStatus(url: string, state: 'up' | 'down', message: string): Promise<void> {
  try {
    const target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('unsupported_protocol');
    target.searchParams.set('status', state);
    target.searchParams.set('msg', message);
    // The configured receivers are privileged internal/external endpoints, not crawler URLs.
    // Never follow a response to a different receiver or permit an unbounded JSON body.
    const response = await monitorFetch(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('non_success_response');
    }
    const body = await readBodyStrictlyCapped(response as unknown as Response, 4_096);
    if (body === null || (JSON.parse(body.toString('utf8')) as { ok?: boolean } | null)?.ok !== true) {
      throw new Error('non_success_response');
    }
  } catch {
    throw new Error('monitor_push_failed');
  }
}

/** Both receivers are attempted even when one is unavailable. Receipts never contain URLs or response bodies. */
export async function pushMonitorTargets(targets: MonitorPushTarget[], state: 'up' | 'down', message: string,
  record: (receipts: MonitorPushReceipt[]) => void): Promise<void> {
  const receipts = await Promise.all(targets.map(async target => {
    const attemptedAt = new Date().toISOString();
    try {
      await pushKumaStatus(target.url, state, message);
      return { target: target.name, ok: true, attemptedAt };
    } catch {
      return { target: target.name, ok: false, attemptedAt };
    }
  }));
  record(receipts);
  if (receipts.some(receipt => !receipt.ok)) throw new Error('monitor_push_failed');
}

export function monitorPushTargets(env: Record<string, string | undefined> = process.env): MonitorPushTarget[] {
  try {
    if (!env.MONITOR_PUSH_URL) throw new Error('missing_primary');
    const primary = new URL(env.MONITOR_PUSH_URL);
    if (!['http:', 'https:'].includes(primary.protocol) || primary.username || primary.password) throw new Error('invalid_primary');
    const targets: MonitorPushTarget[] = [{ name: 'primary', url: primary.href }];
    if (env.MONITOR_EXTERNAL_PUSH_URL) {
      const external = new URL(env.MONITOR_EXTERNAL_PUSH_URL);
      if (external.protocol !== 'https:' || external.username || external.password
        || external.hostname.toLowerCase().replace(/\.$/, '') === primary.hostname.toLowerCase().replace(/\.$/, '')) throw new Error('invalid_external');
      targets.push({ name: 'external', url: external.href });
    }
    return targets;
  } catch {
    throw new Error('monitor_push_configuration_invalid');
  }
}

async function main() {
  const targets = monitorPushTargets();
  // A second hostname is only a configuration check. Independent hosting and actual delivery need operator verification.
  console.log(JSON.stringify({ event: 'monitor.configured', targets: targets.map(target => target.name),
    externalReceiverConfigured: targets.some(target => target.name === 'external'), capacityThresholds: capacityMonitorThresholds() }));
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  let state: MonitorCycleState = { badSamples: 0 };
  while (!stop.signal.aborted) {
    const status = await readMonitorStatus();
    try {
      state = await runMonitorCycle(state, status, {
        push: (next, message) => pushMonitorTargets(targets, next, message, receipts => {
          console.log(JSON.stringify({ event: 'monitor.push', state: next, receipts }));
        }),
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
