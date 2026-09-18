import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdminNav } from '@/app/admin/AdminNav';

describe('shared administrator navigation', () => {
  it('keeps all nine menus including the selected page visible', () => {
    const html = renderToStaticMarkup(<AdminNav current="/admin/status" />);
    expect(html.match(/href="\/admin/g)).toHaveLength(9);
    expect(html).toContain('운영센터');
    expect(html).toContain('AI 소식');
    expect(html).toContain('aria-current="page"');
  });
  it('keeps product management selected on nested product pages', () => {
    const html = renderToStaticMarkup(<AdminNav current="/admin/products/example" />);
    expect(html).toMatch(/(?=[^>]*href="\/admin\/products")(?=[^>]*aria-current="page")/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
  it('places the removal list right after product management and selects only itself', () => {
    const html = renderToStaticMarkup(<AdminNav current="/admin/audit" />);
    expect(html.indexOf('href="/admin/audit"')).toBeGreaterThan(html.indexOf('href="/admin/products"'));
    expect(html.indexOf('href="/admin/audit"')).toBeLessThan(html.indexOf('href="/admin"'));
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
