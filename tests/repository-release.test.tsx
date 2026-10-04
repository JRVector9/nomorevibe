import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FactsStrip } from '@/components/product-detail/FactsStrip';
import type { ProductDetailView, RepositoryFactsView } from '@/lib/domain/products/detail-view';

const repository: NonNullable<ProductDetailView['repository']> = {
  provider: 'github', sourceUrl: 'https://github.com/example/app', state: 'ok',
  observedAt: new Date('2026-09-14T00:00:00Z'), lastSuccessAt: new Date('2026-09-14T00:00:00Z'), lastFailureAt: null,
  facts: {
    repositoryKey: 'example/app', repositoryUrl: 'https://github.com/example/app',
    createdAt: null, pushedAt: '2026-09-13T00:00:00Z', updatedAt: null,
    stars: 0, forks: 0, public: true, archived: false, fork: false, homepage: null,
    contributors: null, license: null, languages: [], latestRelease: null, relationshipState: null,
  },
};
const product: ProductDetailView['product'] = {
  id: 1, slug: 'app', url: 'https://github.com/example/app', accessMode: 'installable', name: 'app', tagline: 'An app.',
  taglineSource: 'maker', description: 'An app.', category: 'Dev', builder: null, stack: [], ogImage: null, makerName: null,
  repoUrl: 'https://github.com/example/app', status: 'seeded', source: 'crawler', claimedAt: null, verifiedAt: null,
  createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-14T00:00:00Z'),
};
const release = { tagName: 'v1.2.0', name: 'Version 1.2', url: 'https://github.com/example/app/releases/tag/v1.2.0', notesUrl: null, publishedAt: '2026-09-10T17:53:34Z' };

/** 핵심 사실 띠의 '최신 release' 칸만 — 다른 칸의 날짜(최근 push 등)와 섞이지 않게 */
function releaseTile(latestRelease: RepositoryFactsView['latestRelease']) {
  const html = renderToStaticMarkup(<FactsStrip product={product} repository={{ ...repository, facts: { ...repository.facts!, latestRelease } }}
    license={{ state: 'missing', label: '라이선스 확인 안 됨', maker: null, observed: null }}
    health={{ uptime30d: null, latencyMs: null, checkedAt: null, down: false }}
    visits={{ periodDays: 7, validVisits: 0, uniqueVisitors: null, uniqueChangePercent: null, collectionStartedAt: null, collecting: true }} />);
  return { html, tile: html.match(/<dt[^>]*>최신 release<\/dt>[\s\S]*?<\/div>/)?.[0] ?? '' };
}

describe('repository release provenance', () => {
  it('says there is no release instead of borrowing another date', () => {
    const { html, tile } = releaseTile(null);
    expect(tile).toContain('없음');
    expect(tile).not.toMatch(/\d+월 \d+일/);
    expect(html).toContain('최근 push');
  });
  it.each([{ ...release, publishedAt: null }, { ...release, publishedAt: '' }, { ...release, publishedAt: 'not-a-date' }])(
    'never substitutes a push or observation date for an undated release (%j)', latestRelease => {
      const { tile } = releaseTile(latestRelease);
      expect(tile).toContain('v1.2.0');
      expect(tile).not.toMatch(/\d+월 \d+일/);
    },
  );
  it('shows the actual publication date in KST and a safe original release link', () => {
    const { tile } = releaseTile(release);
    expect(tile).toContain('v1.2.0');
    expect(tile).toContain('Version 1.2');
    // 9월 10일 17:53 UTC 는 서울로 9월 11일
    expect(tile).toContain('9월 11일');
    expect(tile).toContain(`href="${release.url}"`);
    expect(tile).toContain('rel="noopener noreferrer"');
  });
  it('retains a dated release without emitting an unsafe source URL', () => {
    const { tile } = releaseTile({ ...release, url: 'javascript:alert(1)' });
    expect(tile).toContain('v1.2.0');
    expect(tile).not.toContain('javascript:');
    expect(tile).not.toContain('<a ');
  });
});
