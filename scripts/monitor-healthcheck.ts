import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export function monitorHeartbeatIsFresh(value: unknown, now = Date.now()): boolean {
  if (!value || typeof value !== 'object') return false;
  const checkedAt = (value as { checkedAt?: unknown }).checkedAt;
  return typeof checkedAt === 'number' && Number.isFinite(checkedAt) &&
    checkedAt <= now + 5_000 && now - checkedAt <= 90_000;
}

if (process.argv[1] && basename(process.argv[1]) === 'monitor-healthcheck.ts') {
  try {
    const path = process.env.MONITOR_HEALTH_PATH ?? '/tmp/monitor-health.json';
    process.exitCode = monitorHeartbeatIsFresh(JSON.parse(readFileSync(path, 'utf8'))) ? 0 : 1;
  } catch { process.exitCode = 1; }
}
