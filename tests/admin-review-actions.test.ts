import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ admin: vi.fn(), collect: vi.fn(), mode: vi.fn(), revalidate: vi.fn() }));
vi.mock('@/lib/auth/admin', () => ({ currentAdmin: mocks.admin }));
vi.mock('@/lib/crawl/admin-review', () => ({ requestCandidateEvidence: mocks.collect }));
vi.mock('@/lib/crawl/settings', () => ({ changeReviewMode: mocks.mode }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
import { collectCandidateEvidence, setReviewMode } from '@/app/admin/review/actions';
beforeEach(() => { vi.clearAllMocks(); });
it('checks authorization on every action before touching settings or collection requests', async () => {
  mocks.admin.mockResolvedValue(null);
  expect(await collectCandidateEvidence(null, new FormData())).toMatchObject({ error: expect.any(String) });
  expect(await setReviewMode(null, new FormData())).toMatchObject({ error: expect.any(String) });
  expect(mocks.collect).not.toHaveBeenCalled();
  expect(mocks.mode).not.toHaveBeenCalled();
});
it('passes the expected mode and authenticated actor to the explicit CAS API', async () => {
  mocks.admin.mockResolvedValue({ login: 'jr' });
  mocks.mode.mockResolvedValue({ ok: true });
  const form = new FormData();
  form.set('mode', 'enforce'); form.set('expectedMode', 'observe'); form.set('reason', '표본 검증 완료'); form.set('actor', 'forged');
  expect(await setReviewMode(null, form)).toMatchObject({ message: expect.any(String) });
  expect(mocks.mode).toHaveBeenCalledWith({ mode: 'enforce', expectedMode: 'observe', actor: 'jr', reason: '표본 검증 완료' });
});
it('reports collection as accepted, not completed, and keeps conflicts visible', async () => {
  mocks.admin.mockResolvedValue({ login: 'jr' });
  mocks.collect.mockResolvedValue({ ok: false, message: '입력 변경' });
  expect(await collectCandidateEvidence(null, new FormData())).toEqual({ error: '입력 변경' });
  expect(mocks.revalidate).not.toHaveBeenCalled();
});
