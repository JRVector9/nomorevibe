/** Child process for tests/integration/oracle-consumer-db-roles.test.ts. It runs the real consumer preflight with only
 * the DATABASE_URL principal it was given, then tries each negative statement under that principal. */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import type { ConsumerParentRole } from '@/lib/runtime/consumer-registry';
import { inspectOracleConsumer, readOracleConsumerPreflight } from '@/lib/runtime/oracle-consumer-preflight';
import type { OracleConsumerDbProfile } from '@/lib/runtime/oracle-db-profile';

type Input = { consumer: string; role: ConsumerParentRole; profile?: OracleConsumerDbProfile; negatives: string[] };
const input = JSON.parse(process.env.ORACLE_DRIVER_INPUT ?? '{}') as Input;
const failure = (error: unknown) => {
  for (let value = error, depth = 0; value && depth < 8; depth++) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    value = (value as { cause?: unknown }).cause;
  }
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown';
};

async function main() {
  const result: Record<string, unknown> = { principal: (await db.execute<{ user: string }>(sql`SELECT current_user AS user`))[0].user };
  // A fixture profile gets a readiness hook that reads a granted table inside the preflight transaction (as the principal).
  result.preflight = input.profile ? await inspectOracleConsumer({ consumer: input.consumer, role: input.role, db: input.profile,
    readiness: async tx => { await tx.execute(sql`SELECT 1 FROM crawl_settings LIMIT 1`); return { status: 'verified', reason: 'fixture_ready' }; } })
    : await readOracleConsumerPreflight({ consumer: input.consumer });
  const negatives: Record<string, string> = {};
  for (const statement of input.negatives) {
    try { await db.execute(sql.raw(statement)); negatives[statement] = 'allowed'; }
    catch (error) { negatives[statement] = failure(error); }
  }
  result.negatives = negatives;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main().then(() => (globalThis as { pgClient?: { end: (o: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 }),
  async error => {
    process.stdout.write(`${JSON.stringify({ error: failure(error), message: error instanceof Error ? error.message.slice(0, 300) : String(error) })}\n`);
    await (globalThis as { pgClient?: { end: (o: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 });
    process.exitCode = 1;
  });
