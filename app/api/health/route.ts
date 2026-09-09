import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { healthIdentity } from '@/lib/operations/health';

export const dynamic = 'force-dynamic';

const headers = { 'cache-control': 'no-store' };

export async function GET() {
  const startedAt = Date.now();
  try {
    await db.execute(sql`select 1`);
    return Response.json({
      status: 'ok',
      db: 'ok',
      ...healthIdentity(),
      dbLatencyMs: Date.now() - startedAt,
    }, { headers });
  } catch {
    return Response.json({
      status: 'error',
      db: 'unavailable',
      ...healthIdentity(),
    }, { status: 503, headers });
  }
}
