import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each(['transport', 'monitor'])('keeps an excessive encoding response from crashing the %s process', mode => {
  const result = spawnSync(process.execPath, ['--import', 'tsx',
    fileURLToPath(new URL('./fixtures/undici-excessive-encodings.mjs', import.meta.url)), mode],
    // The monitor fixture imports its TS graph in a separate cold process. Give
    // transpilation room under concurrent CI load; its HTTP deadline stays 5s.
    { encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_OPTIONS: '' } });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('transport_failure_caught\n');
}, 30_000);
