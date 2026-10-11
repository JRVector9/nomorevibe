import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// 결정 버튼은 서버 액션을 부른다 — 이 테스트는 그리기만 본다(DB 없음)
vi.mock('@/app/admin/audit/actions', () => ({ decideAuditFinding: vi.fn() }));

import { AuditFinding, type AuditFindingView } from '@/app/admin/audit/AuditFinding';

const LONG_URL = 'https://very-long-subdomain-name.example-hosting-platform.app/path/to/landing?ref=producthunt&utm=x';
const finding = (overrides: Partial<AuditFindingView> = {}): AuditFindingView => ({
  id: 1, slug: 'agency', name: '에이전시', url: LONG_URL, category: 'Productivity',
  reason: 'The page is a marketing landing page for a consulting agency that offers AI development services.',
  reasonKo: null, confidence: 0.95, reviewedAt: '9/18 21:30', owned: false, reasonCategory: '회사·서비스 소개', ...overrides,
});
const render = (view: AuditFindingView) => renderToStaticMarkup(<table><tbody><AuditFinding finding={view} /></tbody></table>);

/** ADM-32 — 감사 목록 한 줄이 130~150px 이라 50건 한 쪽이 8,373px 였다. 이름·주소 한 줄, 갈래+사유 두 줄로 줄인다 */
describe('감사 목록 한 줄의 밀도(ADM-32)', () => {
  it('이름과 주소는 한 줄 — 긴 주소는 줄을 넘기지 않고 말줄임하고 전체는 title 로 본다', () => {
    const html = render(finding());
    expect(html).not.toContain('break-all');
    expect(html).toContain(`<span title="${LONG_URL.replaceAll('&', '&amp;')}" class="min-w-0 truncate font-mono text-fg-3">very-long-subdomain`);
    // 이름·주소가 같은 줄(flex) 안에 있다
    expect(html).toMatch(/<div class="flex min-w-0 items-baseline gap-2"><a href="https:\/\/very-long[^>]*>에이전시<\/a><span title=/);
  });

  it('첫 칸은 남은 너비만 쓴다 — 말줄임한 긴 주소가 표를 넓혀 결정 칸을 밀어내지 않는다', () => {
    expect(render(finding())).toMatch(/<td class="w-full max-w-0 /);
  });

  it('사유 갈래는 사유 앞에 붙고, 사유는 두 줄로 접혀 있다가 눌러서 편다', () => {
    const html = render(finding());
    expect(html).toMatch(/<div class="mt-1 flex items-start gap-2"><span class="shrink-0[^"]*">회사·서비스 소개<\/span><button type="button" aria-expanded="false"[^>]*title="사유 펼치기"[^>]*line-clamp-2/);
    expect(html).toContain('consulting agency');
  });

  it('주인 있음 표시와 사유 없음도 같은 두 줄 안에 든다', () => {
    const html = render(finding({ owned: true, reason: null }));
    expect(html).toMatch(/>에이전시<\/a><span class="shrink-0[^"]*">주인 있음<\/span>/);
    expect(html).toMatch(/회사·서비스 소개<\/span><p class="text-fg-3">사유 없음<\/p>/);
  });
});
