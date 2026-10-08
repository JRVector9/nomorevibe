import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdminNav, countBadge, NAV_GROUPS } from '@/app/admin/AdminNav';

describe('shared administrator navigation', () => {
  it('keeps all eleven menus including the selected page visible', () => {
    const html = renderToStaticMarkup(<AdminNav current="/admin/status" />);
    expect(html.match(/href="\/admin/g)).toHaveLength(11);
    expect(html).toContain('운영센터');
    expect(html).toContain('GitHub 수집 계정');
    expect(html).toContain('AI 소식');
    expect(html).toContain('작업 로그');
    expect(html).toContain('aria-current="page"');
  });
  it('keeps product management selected on nested product pages', () => {
    const html = renderToStaticMarkup(<AdminNav current="/admin/products/example" />);
    expect(html).toMatch(/(?=[^>]*href="\/admin\/products")(?=[^>]*aria-current="page")/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
  it('places the removal list right after the review queue and selects only itself', () => {
    const html = renderToStaticMarkup(<AdminNav current="/admin/audit" />);
    expect(html.indexOf('href="/admin/audit"')).toBeGreaterThan(html.indexOf('href="/admin/review"'));
    expect(html.indexOf('href="/admin/audit"')).toBeLessThan(html.indexOf('href="/admin/products"'));
    expect(html).toContain('내릴 후보');
    expect(html).toMatch(/(?=[^>]*href="\/admin\/audit")(?=[^>]*aria-current="page")/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
  it('does not select crawl settings for every admin URL', () => {
    const html = renderToStaticMarkup(<AdminNav current="/admin/review" />);
    expect(html).toMatch(/(?=[^>]*href="\/admin\/review")(?=[^>]*aria-current="page")/);
    expect(html).not.toMatch(/(?=[^>]*href="\/admin")(?=[^>]*aria-current="page")/);
  });
});

/** ADM-22·28 — 일하기와 설정·기록 두 묶음, 메뉴 이름은 페이지 h1 과 같다 */
describe('menu groups', () => {
  it('splits daily work from settings and history', () => {
    expect(NAV_GROUPS.map((group) => group.title)).toEqual(['일하기', '설정·기록']);
    expect(NAV_GROUPS[0].pages.map((page) => page.href)).toEqual(['/admin/status', '/admin/review', '/admin/audit', '/admin/products']);
    expect(NAV_GROUPS[1].pages.at(-1)?.href).toBe('/admin/activity');
    const html = renderToStaticMarkup(<AdminNav current="/admin/status" />);
    expect(html).toContain('id="admin-nav-group-0">일하기</p><ul aria-labelledby="admin-nav-group-0"');
  });
  it('uses the page headings as menu labels', () => {
    const labels = NAV_GROUPS.flatMap((group) => group.pages.map((page) => page.label));
    expect(labels).toEqual(expect.arrayContaining(['제품', '랭킹 설정', '근거 수집 설정']));
    expect(labels).not.toContain('제품 관리');
  });
});

describe('menu badges', () => {
  it('describes a count badge for screen readers and hides it at zero', () => {
    expect(countBadge(0, 'warn')).toBeUndefined();
    expect(countBadge(null, 'critical')).toBeUndefined();
    const badge = countBadge(1234, 'warn', (count) => `직접 판단 ${count}건`);
    expect(badge).toEqual({ label: '1,234', tone: 'warn', title: '직접 판단 1,234건' });
    const html = renderToStaticMarkup(<AdminNav current="/admin/status" badges={{ '/admin/review': badge }} />);
    expect(html).toContain('data-tone="warn" title="직접 판단 1,234건"><span aria-hidden="true">1,234</span><span class="admin-vh">직접 판단 1,234건</span></b>');
  });
  it('accepts a critical badge for the operations center', () => {
    const html = renderToStaticMarkup(<AdminNav current="/admin/review" badges={{ '/admin/status': countBadge(3, 'critical') }} />);
    expect(html).toMatch(/href="\/admin\/status"[^]*?data-tone="critical">3<\/b>/);
  });
});
