/** Inspection-only Oracle entry; it never starts a worker, consumer or scheduler. */
import { readOracleRuntimePreflight } from '@/lib/runtime/oracle-preflight';
import { readOracleConsumerPreflight } from '@/lib/runtime/oracle-consumer-preflight';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function oraclePreflightMain(args: readonly string[]): Promise<number> {
  let failed = false, original: unknown;
  try {
    // --role=<역할> 은 versioned 역할 점검, --consumer=<이름> 은 batch 없이 도는 consumer 점검(launch.py --consumer)이다
    if (args.length !== 1 || !args[0].startsWith('--role=') && !args[0].startsWith('--consumer=')) throw new Error('invalid_oracle_preflight_arguments');
    const report = args[0].startsWith('--role=') ? await readOracleRuntimePreflight({ role: args[0].slice(7) })
      : await readOracleConsumerPreflight({ consumer: args[0].slice(11) });
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
