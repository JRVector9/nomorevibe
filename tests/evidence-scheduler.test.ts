import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('execs the DB scheduler without requiring a web URL or cron secret', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nomorevibe-scheduler-test-'));
  try {
    const calls = join(directory, 'calls');
    writeFileSync(join(directory, 'node'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_CALLS"\nexit 42\n', { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_CALLS: calls };
    delete env.CRON_SECRET;
    delete env.BASE_URL;
    delete env.TICK_SECONDS;
    const result = spawnSync('sh', ['scripts/scheduler.sh', '--once'], { env, timeout: 5_000, encoding: 'utf8' });
    expect(result.status).toBe(42);
    const args = readFileSync(calls, 'utf8').trim().split('\n');
    expect(args.slice(0, 2)).toEqual(['--import', 'tsx']);
    expect(args[2]).toMatch(/\/scripts\/scheduler\.ts$/);
    expect(args.slice(3)).toEqual(['--interval-seconds=10', '--once']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
