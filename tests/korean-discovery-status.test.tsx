import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/app/(operator)/admin/status/KoreanDiscoveryControls', () => ({ KoreanDiscoveryControls: () => null }));
import { buildKoreanDiscoveryStatus } from '@/lib/operations/korean-discovery-status';
import { KoreanDiscoveryStatusCard } from '@/app/(operator)/admin/status/KoreanDiscoveryStatus';

const source = { at: '2026-10-28T06:00:00.000Z', enabled: false, startAt: null, epoch: 1, collectionEnabled: true,
  principalReady: false, queries: [{ label: '한국어 README', query: '한국어 in:readme', priority: 50 }], activeQueries: 0,
  heartbeatAt: null, tickAt: null, pending: 0, queryErrors: 0, nextRetryAt: null };

describe('Oracle Korean discovery operator status', () => {
  it('shows disabled configuration even when no observations or queries have ever been recorded', () => {
    const value = buildKoreanDiscoveryStatus(source);
    expect(value.state).toBe('disabled');
    expect(value.blockers).toContain('start_missing');
    expect(value.blockers).toContain('principal_missing');
    const html = renderToStaticMarkup(createElement(KoreanDiscoveryStatusCard, { read: { ok: true, value } }));
    expect(html).toContain('꺼짐');
    expect(html).toContain('Oracle 전용 DB 계정 미설치');
    expect(html).toContain('과거 탐색 시작일 미설정');
  });
  it('distinguishes enabled but unprovisioned from a recent actual worker heartbeat', () => {
    const enabled = { ...source, enabled: true, startAt: '2026-01-01T00:00:00Z' };
    expect(buildKoreanDiscoveryStatus(enabled).state).toBe('blocked');
    expect(buildKoreanDiscoveryStatus({ ...enabled, principalReady: true }).state).toBe('unconfirmed');
    const live = { ...enabled, principalReady: true, activeQueries: 3, heartbeatAt: '2026-10-28T05:59:45Z' };
    expect(buildKoreanDiscoveryStatus(live).state).toBe('observed');
    expect(buildKoreanDiscoveryStatus({ ...live, heartbeatAt: '2026-10-28T05:58:00Z' }).state).toBe('unconfirmed');
    expect(buildKoreanDiscoveryStatus({ ...live, heartbeatAt: '2026-10-28T06:01:00Z' }).state).toBe('unconfirmed');
  });
  it('keeps a failed read unknown and does not show a false disabled or zero result', () => {
    const html = renderToStaticMarkup(createElement(KoreanDiscoveryStatusCard, { read: { ok: false, reason: 'down' } }));
    expect(html).toContain('미확인');
    expect(html).toContain('복제본에 연결되지 않습니다');
    expect(html).not.toContain('설정 저장');
    expect(html).not.toContain('판별·적재 대기 0');
  });
  it('keeps progress and successful collection separate from liveness; bounds the pending count', () => {
    const value = buildKoreanDiscoveryStatus({ ...source, pending: 10001, queryErrors: 1, nextRetryAt: '2026-10-28T06:15:00Z' });
    expect(value).toMatchObject({ pending: 10001, pendingTruncated: false, queryErrors: 1 });
    expect(buildKoreanDiscoveryStatus({ ...source, pending: 50001 })).toMatchObject({ pending: 50000, pendingTruncated: true });
    expect(value.blockers).toContain('query_retry');
    const html = renderToStaticMarkup(createElement(KoreanDiscoveryStatusCard, { read: { ok: true, value } }));
    expect(html).toContain('신규 수집 성공을 뜻하지 않습니다');
    expect(html).toContain('다음 재시도');
    expect(html).toContain('한국어 판별 전 후보도 포함');
    expect(html).toContain('대기 상한 50,000건');
  });
});
