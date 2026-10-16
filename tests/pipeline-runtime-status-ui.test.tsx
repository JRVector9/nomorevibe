import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineControlStatus } from '@/app/(operator)/admin/status/PipelineControlStatus';
import { buildPipelineControlStatus, type PipelineControlStatus as Snapshot } from '@/lib/operations/pipeline-control-status';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), redirect: vi.fn(), read: vi.fn(), settings: vi.fn() }));
vi.mock('@/lib/auth/admin', () => ({ currentAdmin: mocks.admin }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, useRouter: vi.fn(), useSearchParams: vi.fn() }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: mocks.settings }));
vi.mock('@/lib/operations/pipeline-control-status', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/operations/pipeline-control-status')>(), readPipelineControlStatus: mocks.read,
}));

const render = (status: Snapshot) => renderToStaticMarkup(createElement(PipelineControlStatus, { status }));
const at = '2026-10-16T12:00:00.000Z';

function fullStatus(): Snapshot {
  const status = buildPipelineControlStatus(null, null);
  status.observedAt = at;
  status.owners = [{ role: 'official-news', instanceId: 'oracle-news', host: 'oracle-osaka-smoke', release: '0123456789abcdef0123', epoch: 11, live: true },
    { role: 'publisher', instanceId: 'ghost-worker', host: null, release: 'r', epoch: 2, live: false },
    { role: 'text', instanceId: null, host: null, release: null, epoch: 0, live: false }];
  status.hosts[2].roles[0] = { ...status.hosts[2].roles[0], ready: true, reason: 'ready' };
  status.runtime = { ...status.runtime, ownersRead: true,
    anchors: [{ host: 'oracle-osaka-smoke', role: status.hosts[2].roles[0].role, anchor: 'pinned' }],
    ledgers: [{ host: 'm3', ledger: { ...status.runtime.ledgers[0].ledger, state: 'invalid' } },
      { host: 'mini', ledger: { ...status.runtime.ledgers[1].ledger, state: 'absent' } },
      { host: 'oracle-osaka-smoke', ledger: { state: 'ok', processes: 2, expired: 1, primaryClients: 4, replicaClients: 1, shapes: 2,
        heartbeatGapMs: 12_000, eventLoopDelayMs: 75, loadPerCpu: 1.25, rssBytes: 400 * 1024 * 1024, translationHeld: 1, translationCap: 1 } }],
    models: [{ budget: 'abcllm', limit: 2, waiting: 2, reserved: 1, expiredReserved: 1, dispatched: 3, indeterminate: 4, oldestWaitingMin: 30, oldestUnsettledMin: 61 },
      { budget: 'cli', limit: null, waiting: 0, reserved: 0, expiredReserved: 0, dispatched: 1, indeterminate: 0, oldestWaitingMin: null, oldestUnsettledMin: null }],
    dr: { state: 'fenced', epoch: 3, reason: 'promotion_sealed', updatedAt: at, promoted: 1,
      sealed: [{ id: '5e0c2a4b-7f61-4c3d-9a8b-2c1d0e9f8a7b', fromEpoch: 3, toEpoch: 4, sealedAt: at, evidence: ['old_db_fenced'] }] },
    oracle: { liveLeases: 1, checks: [{ key: 'batch', status: 'verified', reason: 'oracle_instance_registered' }, { key: 'dr', status: 'rejected', reason: 'writer_fenced' }],
      roles: [{ role: 'official-news', candidate: true, db: 'verified', http: 'verified', model: 'unknown', reason: 'ready', anchor: 'pinned', lease: true },
        { role: 'translation', candidate: false, db: null, http: null, model: null, reason: 'candidate_missing', anchor: null, lease: false }] } };
  return status;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('pipeline runtime status UI', () => {
  it('groups lease, readiness anchor and host-slot ledger by host and keeps unmapped or ownerless roles visible', () => {
    const html = render(fullStatus());
    expect(html).toContain('aria-label="Oracle · Osaka 실행 상태"');
    expect(html).toContain('oracle-news');
    expect(html).toContain('title="0123456789abcdef0123"');
    expect(html).toContain('anchor 고정');
    expect(html).toContain('host 미확인 lease');
    expect(html).toContain('ghost-worker');
    expect(html).toContain('소유자 없는 역할');
    expect(html).toContain('장부 무효 · 새 일감 보류');
    expect(html).toContain('장부 미참여');
    expect(html).toContain('정책 모양 2종 불일치');
    expect(html).toContain('12.0초');
    expect(html).toContain('400MB');
    expect(html).toMatch(/번역 slot<\/dt><dd[^>]*>1 \/ 1</);
  });
  it('shows full-C model slot charges, DR fence and Oracle gate as observations with no controls', () => {
    const html = render(fullStatus());
    expect(html).toContain('full C');
    expect(html).toContain('61분');
    expect(html).toContain('1 (1)');
    expect(html).toContain('쓰기 차단 (fenced · 승격 봉인)');
    expect(html).toContain('title="5e0c2a4b-7f61-4c3d-9a8b-2c1d0e9f8a7b">5e0c2a4b<');
    expect(html).toContain('옛 DB fence');
    expect(html).toContain('DR 준비 완료를 뜻하지 않습니다');
    expect(html).toContain('Oracle 역할 lease 유효 1');
    expect(html).toContain('실행 허가는 이 화면에서 판정하지 않음');
    expect(html).toContain('DR writer fence · 거절 · fenced');
    expect(html).toContain('OCI identity');
    expect(html).not.toMatch(/<button|<form|<input|href=/);
    expect(html).not.toMatch(/활성화 완료|실행 가능|승격 가능(?! 여부)/);
  });
  it('keeps unknown runtime readings unknown instead of zero or healthy', () => {
    const html = render(buildPipelineControlStatus(null, null));
    expect(html).toContain('예산 장부 · 미확인');
    expect(html).toContain('Oracle 역할 lease 유효 미확인');
    expect(html).toContain('anchor 미확인');
    expect(html).not.toContain('>0<');
    expect(html).not.toContain('0/0');
    expect(html).not.toContain('쓰기 가능');
  });
  it('keeps wide tables in keyboard-reachable horizontal scroll regions for narrow screens', () => {
    const html = render(fullStatus());
    for (const label of ['provider budget별 모델 슬롯', 'Oracle 역할별 준비도', '단계별 제어 상태'])
      expect(html).toMatch(new RegExp(`role="region" aria-label="${label}" tabindex="0"`));
    expect(html).toContain('grid gap-3 sm:grid-cols-2 xl:grid-cols-3');
    expect(html).toMatch(/class="min-w-0 rounded-\[10px\]/);
    expect(html).not.toMatch(/text-\[(1[0-2]|[0-9])px\]|text-xs/);
  });
});

describe('admin status page access', () => {
  it('redirects a signed-out request before any pipeline read', async () => {
    mocks.admin.mockResolvedValue(null);
    mocks.redirect.mockImplementation((path: string) => { throw new Error(`redirect:${path}`); });
    const { default: StatusPage } = await import('@/app/(operator)/admin/status/page');
    await expect(StatusPage()).rejects.toThrow('redirect:/admin/login');
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.settings).not.toHaveBeenCalled();
  });
});
