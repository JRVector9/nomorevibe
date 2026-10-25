import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/net/http-transport', () => ({ nativeHttpFetch: transport.request, legacyHttpDispatcher: () => undefined }));

beforeEach(() => {
  transport.request.mockReset();
  vi.stubEnv('HTTP_ORIGIN_PERMITS', '0');
});
afterEach(() => vi.unstubAllEnvs());

it('blocks private homepage and metadata addresses before making a request', async () => {
  const { sampleHomepageStatus } = await import('@/lib/crawl/sample-homepage');
  for (const url of ['http://127.0.0.1:3000/', 'http://169.254.169.254/latest/meta-data/', 'http://db.internal/']) {
    expect(await sampleHomepageStatus(url)).toBeNull();
  }
  expect(transport.request).not.toHaveBeenCalled();
});

it('blocks a public homepage redirect into a private service', async () => {
  const { sampleHomepageStatus } = await import('@/lib/crawl/sample-homepage');
  const response = new Response('moved', { status: 302, headers: { location: 'http://127.0.0.1:3000/' } });
  const cancel = vi.spyOn(response.body!, 'cancel');
  transport.request.mockResolvedValue(response);
  expect(await sampleHomepageStatus('https://8.8.8.8/redirect')).toBeNull();
  expect(transport.request).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('preserves the observed status and cancels the unused homepage body', async () => {
  const { sampleHomepageStatus } = await import('@/lib/crawl/sample-homepage');
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), { status: 404 });
  transport.request.mockResolvedValue(response);
  expect(await sampleHomepageStatus('https://8.8.8.8/missing')).toBe(404);
  expect(transport.request).toHaveBeenCalledWith('https://8.8.8.8/missing', expect.objectContaining({ redirect: 'manual' }));
  expect(cancel).toHaveBeenCalledTimes(1);
});
