import { expect, it, vi } from 'vitest';

// Importing a DB-capable health module would couple container restarts to DB readiness again.
vi.mock('@/lib/db', () => { throw new Error('liveness_must_not_import_database'); });
vi.mock('@/lib/operations/health', () => { throw new Error('liveness_must_not_import_readiness'); });

it('answers a fresh Node liveness response without database or readiness imports', async () => {
  const route = await import('@/app/api/live/route');
  const response = await route.GET();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ status: 'ok' });
  expect(route.dynamic).toBe('force-dynamic');
  expect(route.runtime).toBe('nodejs');
});
