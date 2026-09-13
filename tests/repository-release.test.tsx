import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RepositoryEvidence } from '@/components/product-detail/RepositoryEvidence';
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
const release = { tagName: 'v1.2.0', name: 'Version 1.2', url: 'https://github.com/example/app/releases/tag/v1.2.0', notesUrl: null, publishedAt: '2026-09-10T17:53:34Z' };
function render(latestRelease: RepositoryFactsView['latestRelease']) {
  return renderToStaticMarkup(<RepositoryEvidence repository={{ ...repository, facts: { ...repository.facts!, latestRelease } }}
    license={{ state: 'missing', label: '라이선스 확인 안 됨', maker: null, observed: null }} />);
}

describe('repository release provenance', () => {
  it.each([null, { ...release, publishedAt: null }, { ...release, publishedAt: '' }, { ...release, publishedAt: 'not-a-date' }])(
    'omits undated releases instead of substituting a push or observation date (%j)', latestRelease => {
      const html = render(latestRelease);
      expect(html).not.toContain('최신 release');
      expect(html).not.toContain('v1.2.0');
      expect(html).toContain('최근 push');
      expect(html).toContain('GitHub stars');
    },
  );
  it('shows the actual publication date in KST and a safe original release link', () => {
    const html = render(release);
    expect(html).toContain('최신 release');
    expect(html).toContain('2026년 9월 11일');
    expect(html).toContain('dateTime="2026-09-10T17:53:34.000Z"');
    expect(html).toContain(`href="${release.url}"`);
    expect(html).toContain('rel="noopener noreferrer"');
  });
  it('retains a dated release without emitting an unsafe source URL', () => {
    const html = render({ ...release, url: 'javascript:alert(1)' });
    expect(html).toContain('v1.2.0');
    expect(html).not.toContain('javascript:');
  });
});
