import { beforeEach, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/lib/crawl/github', () => ({ githubRequest: request }));
import { checkDelegatedRepository } from '@/lib/crawl/delegated-repo-check';

const ok = (value: Record<string, unknown>) => ({ ok: true, status: 200, value, etag: null, lastModified: null, link: null });
beforeEach(() => request.mockReset());

// 2026-11-09 운영자 결정 「해당 레포가 사라졌는지 있는지 봐야」 — 24~72시간 근거의 위임 승인은 발행 전에 한 번 묻는다
it('present only for the same public, unarchived repository', async () => {
  request.mockResolvedValue(ok({ id: 1, full_name: 'Owner/App', private: false, archived: false }));
  expect(await checkDelegatedRepository('owner/app')).toEqual({ check: 'present', retryAt: null });
  expect(request).toHaveBeenCalledWith('/repos/owner/app', {}, expect.objectContaining({ timeoutMs: 8000 }));
});
it.each([
  [{ id: 1, full_name: 'new-owner/app', private: false, archived: false }],
  [{ id: 1, full_name: 'owner/app', private: false, archived: true }],
  [{ id: 1, full_name: 'owner/app', private: true, archived: false }],
])('changed for a renamed, archived or private repository', async value => {
  request.mockResolvedValue(ok(value));
  expect((await checkDelegatedRepository('owner/app')).check).toBe('changed');
});
it('gone on 404', async () => {
  request.mockResolvedValue({ ok: false, error: { kind: 'not_found' } });
  expect(await checkDelegatedRepository('owner/app')).toEqual({ check: 'gone', retryAt: null });
});
it('deferred — never present — on budget, credential or transport failures', async () => {
  const resetAt = new Date(Date.now() + 60_000);
  request.mockResolvedValueOnce({ ok: false, error: { kind: 'rate_limited', resetAt } });
  expect(await checkDelegatedRepository('owner/app')).toEqual({ check: 'deferred', retryAt: resetAt });
  for (const error of [{ kind: 'transport' }, { kind: 'invalid_response' }, { kind: 'http', status: 500 },
    { kind: 'auth_unavailable', reason: 'cooldown', resetAt: null }]) {
    request.mockResolvedValueOnce({ ok: false, error });
    expect((await checkDelegatedRepository('owner/app')).check).toBe('deferred');
  }
});
