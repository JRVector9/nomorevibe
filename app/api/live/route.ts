export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Container liveness: database readiness belongs to /api/health and must not cause restart loops. */
export function GET() {
  return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
