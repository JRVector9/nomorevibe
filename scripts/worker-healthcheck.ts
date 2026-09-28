/** Read-only local health check: no DB queries, provider requests, or AI invocations. */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { DEFAULT_HEALTH_PATH, type WorkerHealth } from './worker-supervisor';
import { DEFAULT_ROLE_HEALTH_PATH } from './role-health';

export function workerIsHealthy(value: unknown, now = Date.now(), role?: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const health = value as Partial<WorkerHealth>;
  return health.status === 'running' && (!role || health.role === role) &&
    typeof health.updatedAt === 'number' && Number.isFinite(health.updatedAt) &&
    typeof health.lastHeartbeatAt === 'number' && Number.isFinite(health.lastHeartbeatAt) &&
    now >= health.updatedAt && now - health.updatedAt < 20_000 &&
    now >= health.lastHeartbeatAt && now - health.lastHeartbeatAt < 30_000;
}
export function roleCandidateIsHealthy(candidate: unknown, worker: unknown, now = Date.now(), role?: string): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  const value = candidate as Record<string, unknown>;
  if ((role && value.role !== role) || !['crawler', 'reviewer'].includes(String(value.role)) ||
      !['primary', 'standby'].includes(String(value.kind)) ||
      typeof value.instanceId !== 'string' || typeof value.bootId !== 'string' ||
      typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) ||
      now < value.updatedAt || now - value.updatedAt >= 20_000) return false;
  if (value.phase === 'standby') return value.epoch === null;
  if (value.phase === 'active') return Number.isSafeInteger(value.epoch) &&
    workerIsHealthy(worker, now, value.role as string);
  return false;
}
if (process.argv[1] && /^worker-healthcheck\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  try {
    const rolePath = process.env.ROLE_HEALTH_PATH ?? DEFAULT_ROLE_HEALTH_PATH;
    const workerPath = process.env.WORKER_HEALTH_PATH ?? DEFAULT_HEALTH_PATH;
    if (existsSync(rolePath)) {
      const candidate: unknown = JSON.parse(readFileSync(rolePath, 'utf8'));
      let worker: unknown = null;
      if (existsSync(workerPath)) worker = JSON.parse(readFileSync(workerPath, 'utf8'));
      process.exitCode = roleCandidateIsHealthy(candidate, worker, Date.now(), process.env.WORKER_ROLE) ? 0 : 1;
    } else {
      const value: unknown = JSON.parse(readFileSync(workerPath, 'utf8'));
      process.exitCode = workerIsHealthy(value, Date.now(), process.env.WORKER_ROLE) ? 0 : 1;
    }
  } catch { process.exitCode = 1; }
}
