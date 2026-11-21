import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { networkRoutesField } from '@/lib/db/network-route';
import { logger } from '@/lib/observability/logger';
import { directServerRequest, EXPECTED_MIGRATION, healthIdentity, schemaReadiness } from '@/lib/operations/health';

export const dynamic = 'force-dynamic';

const headers = { 'cache-control': 'no-store' };

/**
 * 공개 요청(Cloudflare → Traefik)은 상태만 받는다: `{status:'ok'}` 200 / `{status:'error'}` 503 — HTTP 코드와 status 값은 예전과 같다.
 * 배포 커밋(release)·서버 이름(instanceId)·DB 지연·DB 경로(networkRoutes)·schema 는 컨테이너에 바로 붙은 요청에만 낸다
 * (directServerRequest). 배포 도구는 서버마다 SSH + docker exec 로 그 전체 본문을 읽는다.
 */
export async function GET(request: Request) {
  const direct = directServerRequest(request.headers);
  const respond = (body: { status: 'ok' | 'error' } & Record<string, unknown>, status = 200) =>
    Response.json(direct ? body : { status: body.status }, { status, headers });
  const startedAt = Date.now();
  try {
    await db.execute(sql`select 1`);
  } catch {
    return respond({
      status: 'error',
      db: 'unavailable',
      ...healthIdentity(),
      ...networkRoutesField(),
    }, 503);
  }
  const dbLatencyMs = Date.now() - startedAt;
  // 코드가 기대하는 migration 이 없으면 준비되지 않았다 — 배포 helper(status·db·release 확인)가 롤아웃을 여기서 멈춘다
  const schema = await schemaReadiness(db);
  if (schema !== 'ok') {
    logger.error('health.schema_not_ready', { schema, expectedMigration: EXPECTED_MIGRATION.tag, ...healthIdentity() });
    return respond({
      status: 'error',
      db: 'ok',
      schema,
      expectedMigration: EXPECTED_MIGRATION.tag,
      ...healthIdentity(),
      ...networkRoutesField(),
    }, 503);
  }
  return respond({
    status: 'ok',
    db: 'ok',
    ...healthIdentity(),
    dbLatencyMs,
    // DATABASE_FALLBACK_HOST 등을 둔 곳만 — 경로 이름(lan/tailscale)만, 주소 없음
    ...networkRoutesField(),
  });
}
