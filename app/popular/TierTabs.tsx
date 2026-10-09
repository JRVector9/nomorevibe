'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { STAR_TIERS, popularHref, type StarTier } from '@/lib/domain/products/stars';
import { formatCount } from '@/lib/format/number';

/**
 * 스타 구간 탭. 좁은 화면(≤640px)에서는 가로로 밀리는 칩 줄이라(popular.css) 고른 구간이 줄 밖에 있을 수 있다 —
 * 그 칩이 줄 가운데 오게 민다(2026-10-08 UX 감사 UX-23).
 * scrollIntoView 는 창도 세로로 움직인다. 목록 아래에서 상세로 갔다가 뒤로 오면 복원된 위치가 탭으로 튀므로 줄의 가로 위치만 바꾼다.
 */
export function TierTabs({ current, personal, totals }: { current: StarTier; personal: boolean; totals?: number[] }) {
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const nav = navRef.current;
    const tab = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !tab || nav.scrollWidth <= nav.clientWidth) return;
    const box = nav.getBoundingClientRect(), chip = tab.getBoundingClientRect();
    nav.scrollLeft += chip.left - box.left - (box.width - chip.width) / 2;
  }, [current]);

  return (
    <nav ref={navRef} className="popular-tabs" aria-label="스타 구간">
      {STAR_TIERS.map((t, index) => (
        <Link prefetch={false} key={t.key} aria-current={current === t.key ? 'page' : undefined} href={popularHref(t.key, personal)}>
          <strong>{t.label}</strong>
          {totals && <b>{formatCount(totals[index])}</b>}
        </Link>
      ))}
    </nav>
  );
}
