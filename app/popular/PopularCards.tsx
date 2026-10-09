import Link from 'next/link';
import { ProductIcon } from '@/components/ProductIcon';
import { ProductTagline } from '@/components/ProductTagline';
import { StarMetric } from '@/components/StarMetric';
import type { PopularProduct } from '@/lib/domain/products/popular';

/**
 * 좁은 화면(≤640px)의 /popular 목록 — 가로로 밀리던 표 대신 카드 행(2026-10-08 UX 감사 UX-23).
 * 첫 줄에 순위·아이콘·이름·★수·증감, 그 아래 소개 두 줄. 넓은 화면은 표를 쓰고 이 목록은 숨는다(popular.css).
 */
export function PopularCards({ items, first }: { items: PopularProduct[]; first: number }) {
  return (
    <ol className="popular-cards" aria-label="프로젝트 목록">
      {items.map((p, index) => (
        <li key={p.slug} className="popular-card">
          <span className="popular-card-rank">{first + index}</span>
          <ProductIcon name={p.name} ogImage={p.ogImage} size={28} />
          <Link prefetch={false} className="popular-card-name" href={`/p/${p.slug}`}>{p.name}</Link>
          <StarMetric value={p} />
          {/* 좁은 행이라 출처 줄은 끈다 — 상세에서 밝힌다 */}
          <div className="popular-card-intro">
            <ProductTagline tagline={p.tagline} taglineKo={p.taglineKo} source={p.taglineSource} className="popular-description" showSource={false} />
          </div>
        </li>
      ))}
    </ol>
  );
}
