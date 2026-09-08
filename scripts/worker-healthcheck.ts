/** Read-only local health check: no DB queries, provider requests, or AI invocations. */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { DEFAULT_HEALTH_PATH, type WorkerHealth } from './worker-supervisor';

export function workerIsHealthy(value: unknown, now = Date.now(), role?: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const health = value as Partial<WorkerHealth>;
  return health.status === 'running' && (!role || health.role === role) &&
    typeof health.updatedAt === 'number' && Number.isFinite(health.updatedAt) &&
    typeof health.lastHeartbeatAt === 'number' && Number.isFinite(health.lastHeartbeatAt) &&
    now >= health.updatedAt && now - health.updatedAt < 20_000 &&
    now >= health.lastHeartbeatAt && now - health.lastHeartbeatAt < 30_000;
}
if (process.argv[1] && /^worker-healthcheck\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  try {
    const value: unknown = JSON.parse(readFileSync(process.env.WORKER_HEALTH_PATH ?? DEFAULT_HEALTH_PATH, 'utf8'));
    process.exitCode = workerIsHealthy(value, Date.now(), process.env.WORKER_ROLE) ? 0 : 1;
  } catch { process.exitCode = 1; }
}
