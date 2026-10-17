import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { networkRoutesField } from '@/lib/db/network-route';
import { logger } from '@/lib/observability/logger';
import { EXPECTED_MIGRATION, healthIdentity, schemaReadiness } from '@/lib/operations/health';

export const dynamic = 'force-dynamic';

const headers = { 'cache-control': 'no-store' };

export async function GET() {
  const startedAt = Date.now();
  try {
    await db.execute(sql`select 1`);
  } catch {
    return Response.json({
      status: 'error',
      db: 'unavailable',
      ...healthIdentity(),
      ...networkRoutesField(),
    }, { status: 503, headers });
  }
  const dbLatencyMs = Date.now() - startedAt;
  // 코드가 기대하는 migration 이 없으면 준비되지 않았다 — 배포 helper(status·db·release 확인)가 롤아웃을 여기서 멈춘다
  const schema = await schemaReadiness(db);
  if (schema !== 'ok') {
    logger.error('health.schema_not_ready', { schema, expectedMigration: EXPECTED_MIGRATION.tag, ...healthIdentity() });
    return Response.json({
      status: 'error',
      db: 'ok',
      schema,
      expectedMigration: EXPECTED_MIGRATION.tag,
      ...healthIdentity(),
      ...networkRoutesField(),
    }, { status: 503, headers });
  }
  return Response.json({
    status: 'ok',
    db: 'ok',
    ...healthIdentity(),
    dbLatencyMs,
    // DATABASE_FALLBACK_HOST 등을 둔 곳만 — 경로 이름(lan/tailscale)만, 주소 없음
    ...networkRoutesField(),
  }, { headers });
}
