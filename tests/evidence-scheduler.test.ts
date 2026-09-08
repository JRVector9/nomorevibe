import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
it('schedules both evidence jobs on the first tick with bounded HTTP timeouts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nomorevibe-scheduler-test-'));
  try {
    const calls = join(directory, 'calls');
    writeFileSync(join(directory, 'curl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_CALLS"\nprintf "200"\n', { mode: 0o755 });
    writeFileSync(join(directory, 'sleep'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
    const result = spawnSync('sh', ['scripts/scheduler.sh'], { env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CRON_SECRET: 'test-only-secret', BASE_URL: 'http://scheduler.invalid', TEST_CALLS: calls }, timeout: 15_000, encoding: 'utf8' });
    expect(result.status).toBe(42); // Stop immediately after one tick, with no real HTTP calls.
    const requests = readFileSync(calls, 'utf8').trim().split('\n');
    expect(requests.some(line => line.includes('/api/cron/product-evidence-refresh'))).toBe(true);
    expect(requests.some(line => line.includes('/api/cron/agent-evidence-refresh'))).toBe(true);
    expect(requests.every(line => line.includes('--connect-timeout 5 --max-time 35'))).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 20_000);
