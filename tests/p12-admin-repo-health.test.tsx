import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RepoHealthCard } from '@/app/(operator)/admin/status/dashboard/RepoHealthCard';
import { PRODUCT_FILTERS } from '@/app/(operator)/admin/products/filters';

const state = (total: number) => ({ total, new24h: 0 });
const html = renderToStaticMarkup(<RepoHealthCard
  health={{ tracked: 1000, checked24h: 990, states: { ok: state(950), not_found: state(12), empty: state(3), blocked: state(1), archived: state(20), renamed: state(4) } }}
  review={{ pending: 0, delistCandidates: 0, human: 0, kept: 0, oldestHours: null }} />);
/** 칩 이름 → 링크 주소(링크가 아니면 null) */
const chipHref = (label: string) => {
  const link = html.match(new RegExp(`<a class="dash-pill"(?: title="[^"]*")? href="([^"]+)">${label} <b>`));
  if (link) return link[1].replaceAll('&amp;', '&');
  expect(html).toContain(`<span class="dash-pill">${label} <b>`);
  return null;
};

/** ADM-33 — 운영센터 저장소 카드의 '없음 N' 칩만 링크가 아니었다(보관됨·이름 바뀜은 링크) */
describe('저장소 카드의 없음 칩(ADM-33)', () => {
  it('없음·빈 저장소 칩은 제품 관리 저장소 사라짐의 대기 포함 보기로 간다', () => {
    const expected = `/admin/products?filter=${encodeURIComponent('저장소 사라짐')}&pending=1`;
    expect(chipHref('없음')).toBe(expected);
    expect(chipHref('빈 저장소')).toBe(expected);
    expect(html).toContain('title="제품 관리에서 없음·빈 저장소를 함께 봅니다');
  });

  it('링크가 가리키는 거르기는 제품 관리에 있고, 저장소 사라짐 거르기다(page.tsx 가 pending=1 이면 없거나 빈 것 모두로 넓힌다)', () => {
    const target = new URL(chipHref('없음')!, 'https://x.test');
    const name = target.searchParams.get('filter')!;
    expect(Object.hasOwn(PRODUCT_FILTERS, name)).toBe(true);
    expect(PRODUCT_FILTERS[name as keyof typeof PRODUCT_FILTERS]).toMatchObject({ statuses: ['seeded', 'verified'], repoGone: true });
    expect(target.searchParams.get('pending')).toBe('1');
  });

  it('보관됨·이름 바뀜은 전처럼 각자의 거르기로, 있음·막힘은 링크가 아니다', () => {
    expect(chipHref('보관됨')).toBe(`/admin/products?filter=${encodeURIComponent('저장소 보관됨')}`);
    expect(chipHref('이름 바뀜')).toBe(`/admin/products?filter=${encodeURIComponent('저장소 이름 바뀜')}`);
    expect(chipHref('있음')).toBeNull();
    expect(chipHref('막힘')).toBeNull();
  });
});
