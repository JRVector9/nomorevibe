/** Inspection-only Oracle entry; it never starts a worker or scheduler. */
import { readOracleRuntimePreflight } from '@/lib/runtime/oracle-preflight';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function oraclePreflightMain(args: readonly string[]): Promise<number> {
  let failed = false, original: unknown;
  try {
    if (args.length !== 1 || !args[0].startsWith('--role=')) throw new Error('invalid_oracle_preflight_arguments');
    const report = await readOracleRuntimePreflight({ role: args[0].slice(7) });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 78;
  } catch (error) { failed = true; original = error; throw error; }
  finally {
    try { await (globalThis as { pgClient?: { end: (options: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 }); }
    catch (error) { if (failed) throw new AggregateError([original, error], 'oracle_preflight_and_drain_failed'); throw error; }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void oraclePreflightMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
    // API errors retain identity; the command never prints a SQL/URL/env error.
    process.stderr.write('{"code":"oracle_runtime_preflight_failed"}\n'); process.exitCode = 78;
  });
}
