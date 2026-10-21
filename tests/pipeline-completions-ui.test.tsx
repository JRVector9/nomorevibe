import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineCompletions } from '@/app/(operator)/admin/status/PipelineCompletions';
import { buildPipelineCompletions, DEFERRED, type PipelineCompletions as Snapshot } from '@/lib/operations/pipeline-completions';
import { AI1_EXPECTED, AI2_EXPECTED } from './pipeline-completions-fixture';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), redirect: vi.fn(), read: vi.fn(), settings: vi.fn() }));
vi.mock('@/lib/auth/admin', () => ({ currentAdmin: mocks.admin }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, useRouter: vi.fn(), useSearchParams: vi.fn() }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: mocks.settings }));
vi.mock('@/lib/operations/pipeline-completions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/operations/pipeline-completions')>(), readPipelineCompletions: mocks.read,
}));

const NOW = '2026-10-17T12:00:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const render = (status: Snapshot) => renderToStaticMarkup(createElement(PipelineCompletions, { status }));
const ledger = (dispatched: number, settled: number) => ({ windows: { '1h': { dispatched, settled, indeterminate: 0, released: 0, settledUnits: settled },
  '24h': { dispatched: dispatched + 1000, settled, indeterminate: 1, released: 0, settledUnits: settled } }, waiting: 3, waitingOldestAt: ago(42), active: 2 });
const full = () => buildPipelineCompletions({ at: NOW,
  ai1: { windows: AI1_EXPECTED, backoff: 1, human: 2, humanOldestAt: ago(125) },
  ai2: { windows: AI2_EXPECTED, ready: 4, readyOldestAt: ago(100), backoff: 3, human: 2, humanCandidates: 1, humanOldestAt: ago(90) },
  publish: { windows: { '1h': { published: 1, transitions: 2, withdrawn: 1 }, '24h': { published: 2, transitions: 3, withdrawn: 1 } }, approved: 7 },
  fetch: { ready: 12345, readyOldestAt: ago(50), backoff: 2, inFlight: 1, human: 0, humanOldestAt: null },
  ledger: { first: ledger(1, 1), second: ledger(1, 0), background: ledger(2, 2) } });

beforeEach(() => { vi.clearAllMocks(); });

describe('pipeline completions UI', () => {
  it('keeps unknown readings unknown instead of zero', () => {
    const html = render(buildPipelineCompletions(null));
    expect(html).toContain('조회 시각 미확인');
    expect(html).toContain('미확인');
    expect(html).not.toContain('>0<');
    expect(html).not.toContain('최장');
  });
  it('shows each stage with separate unique completions, calls, reuse and AI2 votes per window', () => {
    const html = render(full());
    for (const label of ['원본 수집', 'AI 1차', 'AI 2차', '발행', '배경 작업']) expect(html).toContain(`>${label}</h3>`);
    for (const label of ['고유 완료(후보)', '실제 호출 · 도메인 기록', '모델 장부 dispatch', '모델 장부 정산', '재사용', 'AI2 표', '표 받은 후보(고유)', '경계 걸친 사슬'])
      expect(html).toContain(label);
    expect(html).toMatch(/고유 완료\(후보\).*?<\/th><td[^>]*>3<\/td><td[^>]*>6<\/td>/);
    expect(html).toMatch(/AI2 표.*?<\/th><td[^>]*>2<\/td><td[^>]*>4<\/td>/);
    expect(html).toMatch(/모델 장부 dispatch.*?<\/th><td[^>]*>1<\/td><td[^>]*>1,001<\/td>/);
    expect(html).toContain('12,345');
    expect(html).toContain('최장 50분');
    expect(html).toContain('최장 125분');
    expect(html).toContain('후보 1 · 결정 기준');
    expect(html).toContain('>미계산<');
    expect(html).toContain('>해당 없음<');
    // 설계상 늘 같은 글자인 칸은 흐리게·기울여 그리고 까닭을 title 로 단다 — 멈춘 숫자처럼 보이지 않게
    expect(html).toMatch(/class="py-1 text-right text-fg-2 italic" title="설계상 이 화면에서 세지 않는 값입니다\(늘 미계산\)[^"]*"[^>]*>미계산</);
    expect(html).toMatch(/title="이 단계에는 해당하지 않는 지표입니다\(늘 해당 없음\)[^"]*">해당 없음</);
    for (const row of DEFERRED) expect(html).toContain(row.label);
    expect(html).toContain('pipeline-capacity-live');
    expect(html).not.toMatch(/<button|<form|<input|href=/);
    expect(html).not.toMatch(/최종 고유 완료<\/th>/);
  });
  it('fits narrow screens with one-column cards and no font below 13px', () => {
    const html = render(full());
    expect(html).toContain('grid gap-3 sm:grid-cols-2 xl:grid-cols-3');
    expect(html).toMatch(/class="min-w-0 rounded-\[10px\]/);
    expect(html).toContain('<caption class="sr-only">AI 1차 최근 1시간·24시간 처리 지표</caption>');
    expect(html).not.toMatch(/text-\[(1[0-2]|[0-9])px\]|text-xs/);
  });
});

describe('admin status page access', () => {
  it('redirects a signed-out request before reading completions', async () => {
    mocks.admin.mockResolvedValue(null);
    mocks.redirect.mockImplementation((path: string) => { throw new Error(`redirect:${path}`); });
    const { default: StatusPage } = await import('@/app/(operator)/admin/status/page');
    await expect(StatusPage()).rejects.toThrow('redirect:/admin/login');
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.settings).not.toHaveBeenCalled();
  });
});
