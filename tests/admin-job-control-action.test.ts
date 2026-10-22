import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), headers: vi.fn(), control: vi.fn(), fence: vi.fn(), revalidate: vi.fn(), local: vi.fn() }));
vi.mock('@/lib/operations/dr/epoch', async original => ({ ...await original<typeof import('@/lib/operations/dr/epoch')>(), readWriterFence: mocks.fence }));
vi.mock('@/lib/auth/admin', () => ({ currentAdmin: mocks.admin, adminOrigin: () => 'https://admin.nomorevibe.example',
  authSecret: () => 'a'.repeat(32), adminLocalLoginEnabled: mocks.local, LOCAL_ADMIN_LOGIN: 'local' }));
vi.mock('@/lib/operations/admin-job-control', () => ({ controlAdminJob: mocks.control }));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));

const ADMIN = { login: 'jr', exp: Math.floor(Date.now() / 1000) + 3600 };
const token = (login = ADMIN.login, exp = ADMIN.exp, secret = 'a'.repeat(32)) => createHmac('sha256', secret)
  .update(`job-control-admin:${login}:${exp}`).digest('hex');
const input = (extra: Record<string, unknown> = {}) => ({ name: 'crawl-fetch', pause: true, expectedNotBefore: null,
  expectedControlVersion: 0, reason: '후단 부하 확인', csrfToken: token(), csrfExpiresAt: ADMIN.exp, ...extra }) as never;
const action = async () => (await import('@/app/(operator)/admin/status/job-control-actions')).controlJobAction;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.admin.mockResolvedValue(ADMIN);
  mocks.headers.mockResolvedValue(new Headers({ origin: 'https://admin.nomorevibe.example' }));
  mocks.fence.mockResolvedValue({ state: 'active' });
  mocks.control.mockResolvedValue(undefined);
  mocks.local.mockReturnValue(false);
});

describe('administrator job control action authorization', () => {
  it('requires an authenticated admin on every action', async () => {
    mocks.admin.mockResolvedValue(null);
    expect(await (await action())(input())).toEqual({ error: '관리자 로그인이 필요합니다.' });
    expect(mocks.control).not.toHaveBeenCalled();
  });

  it('binds the HMAC to the authenticated login and exact session expiry', async () => {
    const run = await action();
    for (const extra of [
      { csrfToken: token('attacker') }, { csrfToken: token(ADMIN.login, ADMIN.exp, 'b'.repeat(32)) },
      { csrfToken: '0'.repeat(64) }, { csrfToken: 'x'.repeat(64) }, { csrfToken: null },
      { csrfExpiresAt: ADMIN.exp - 1, csrfToken: token(ADMIN.login, ADMIN.exp - 1) },
      { csrfExpiresAt: Math.floor(Date.now() / 1000) - 1, csrfToken: token(ADMIN.login, Math.floor(Date.now() / 1000) - 1) },
    ]) expect((await run(input(extra))).error).toContain('요청을 확인하지 못했습니다');
    expect(mocks.control).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it.each([null, 'https://nomorevibe.example', 'https://attacker.example', 'https://admin.nomorevibe.example.attacker.test'])
    ('requires the exact configured admin origin (%s)', async origin => {
      mocks.headers.mockResolvedValue(new Headers(origin ? { origin } : {}));
      expect((await (await action())(input())).error).toContain('요청을 확인하지 못했습니다');
      expect(mocks.control).not.toHaveBeenCalled();
    });

  it('derives the actor from the authenticated session, forwards CAS inputs and refreshes both affected pages', async () => {
    const request = input({ actor: 'forged' });
    expect(await (await action())(request)).toMatchObject({ message: expect.stringContaining('실행 중인 작업은 끝까지') });
    expect(mocks.control).toHaveBeenCalledExactlyOnceWith(request, ADMIN.login);
    expect(mocks.revalidate.mock.calls).toEqual([['/admin/status'], ['/admin/activity']]);
  });

  it.each([
    ['job_control_conflict', '다른 작업자가 상태를 바꿨습니다'],
    ['job_control_unsupported_mode', '개별 멈춤을 지원하지 않습니다'],
    ['job_control_invalid', '작업과 사유를 확인해 주세요'],
    ['job_control_not_found', '작업과 사유를 확인해 주세요'],
  ])('keeps %s failures visible and avoids a false success refresh', async (code, message) => {
    mocks.control.mockRejectedValue(new Error(code));
    expect((await (await action())(input())).error).toContain(message);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('does not swallow unexpected storage or writer fence errors', async () => {
    mocks.control.mockRejectedValue(new Error('database-unavailable'));
    await expect((await action())(input())).rejects.toThrow('database-unavailable');
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('rejects a fenced web process before accessing the session or changing a job', async () => {
    mocks.fence.mockResolvedValue({ state: 'fenced' });
    await expect((await action())(input())).rejects.toThrow('dr_writer_site_fenced');
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.control).not.toHaveBeenCalled();
  });

  it('accepts bounded local login tokens and refuses tokens beyond twelve hours', async () => {
    mocks.local.mockReturnValue(true);
    mocks.admin.mockResolvedValue({ login: 'local', exp: Number.MAX_SAFE_INTEGER });
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    expect(await (await action())(input({ csrfToken: token('local', expiresAt), csrfExpiresAt: expiresAt })))
      .toHaveProperty('message');
    mocks.control.mockClear();
    const tooLate = Math.floor(Date.now() / 1000) + 12 * 3600 + 100;
    expect((await (await action())(input({ csrfToken: token('local', tooLate), csrfExpiresAt: tooLate }))).error)
      .toContain('요청을 확인하지 못했습니다');
    expect(mocks.control).not.toHaveBeenCalled();
  });
});
