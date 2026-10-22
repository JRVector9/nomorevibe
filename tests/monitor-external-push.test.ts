import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { monitorPushTargets, pushMonitorTargets } from '@/scripts/watch-failover-readiness';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

async function receiver(ok: boolean) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok, private: 'receiver-secret' }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing_address');
  return { url: `http://127.0.0.1:${address.port}/api/push/private-token`, requests };
}

it('delivers to the independent receiver when the primary rejects a push, and reports recovery', async () => {
  const primary = await receiver(false), external = await receiver(true);
  const record = vi.fn();
  const targets = [{ name: 'primary' as const, url: primary.url }, { name: 'external' as const, url: external.url }];
  await expect(pushMonitorTargets(targets, 'down', 'worker failover alarm', record)).rejects.toThrow('monitor_push_failed');
  expect(primary.requests).toHaveLength(1);
  expect(external.requests).toEqual(['/api/push/private-token?status=down&msg=worker+failover+alarm']);
  expect(record).toHaveBeenLastCalledWith([
    { target: 'primary', ok: false, attemptedAt: expect.any(String) },
    { target: 'external', ok: true, attemptedAt: expect.any(String) },
  ]);
  expect(JSON.stringify(record.mock.calls)).not.toMatch(/private-token|receiver-secret|127\.0\.0\.1/);
  await pushMonitorTargets([targets[1]], 'up', 'worker failover ok', record);
  expect(external.requests.at(-1)).toContain('status=up');
});

it('keeps the primary working when the external receiver rejects a push', async () => {
  const primary = await receiver(true), external = await receiver(false);
  const record = vi.fn();
  await expect(pushMonitorTargets([{ name: 'primary', url: primary.url }, { name: 'external', url: external.url }],
    'up', 'worker failover ok', record)).rejects.toThrow('monitor_push_failed');
  expect(primary.requests).toHaveLength(1);
  expect(record.mock.calls[0][0].map((receipt: { ok: boolean }) => receipt.ok)).toEqual([true, false]);
});

it('requires a different HTTPS hostname for the external receiver and sanitizes configuration errors', () => {
  expect(monitorPushTargets({ MONITOR_PUSH_URL: 'http://mini.test/api/push/a' })).toHaveLength(1);
  expect(monitorPushTargets({ MONITOR_PUSH_URL: 'http://mini.test/api/push/a',
    MONITOR_EXTERNAL_PUSH_URL: 'https://outside.test/api/push/b' }).map(target => target.name)).toEqual(['primary', 'external']);
  for (const external of ['http://outside.test/token', 'https://mini.test/token', 'https://MINI.TEST./token', 'https://user:secret@outside.test/token', 'private-token']) {
    expect(() => monitorPushTargets({ MONITOR_PUSH_URL: 'http://mini.test/api/push/a', MONITOR_EXTERNAL_PUSH_URL: external }))
      .toThrow('monitor_push_configuration_invalid');
  }
});
