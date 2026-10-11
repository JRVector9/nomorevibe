"use client";

import Link from "next/link";
import { ProductTagline } from "@/components/ProductTagline";
import { StarMetric } from "@/components/StarMetric";
import { Icon } from "@/components/home/icons";
import type { RankedCardProduct } from "@/components/home/popular-cards";
import { ProjectTile } from "@/components/home/ProjectTile";
import { useSavedSlugs } from "@/components/home/useSavedSlugs";
import { listedRepositoryOwner } from "@/lib/domain/products/github-owner";
import { categoryLabel } from "@/lib/domain/products/labels";
import "@/components/home/cards.css";

const ACCOUNT: Record<string, string> = { User: "개인", Organization: "조직" };

/**
 * /popular 목록 보기 — 순위 · 커버(발견하기 카드와 같은 ProjectTile) · 이름 · @소유자 · 소개 두 줄 · 분야·계정 · ★와 증감 · 저장.
 * 줄 하나가 링크 하나다(카드와 같은 UX-30): 이름 링크가 줄 전체를 덮고, 소유자 링크와 저장만 따로 누른다.
 * 좁은 화면은 커버를 줄이고 순위를 커버 위 숫자로 옮긴다(popular.css).
 */
export function PopularList({ items, now }: { items: RankedCardProduct[]; now: string }) {
  const [saved, toggle] = useSavedSlugs();
  return (
    <ol className="popular-list">
      {items.map((product) => {
        const href = `/p/${product.slug}`;
        const owner = listedRepositoryOwner(product.repoUrl, product.repoRenamedTo);
        const isSaved = saved.has(product.slug);
        const account = product.ownerType ? ACCOUNT[product.ownerType] : null;
        return (
          <li key={product.slug} className="popular-row">
            <span className="popular-rank">{product.rank}<span className="sr-only">위</span></span>
            <Link prefetch={false} href={href} className="popular-thumb" tabIndex={-1} aria-hidden="true">
              <ProjectTile slug={product.slug} name={product.name} ogImage={product.ogImage} size={44} installable={product.accessMode === "installable"}
                ai={product.aiLevel != null} category={product.category} />
              <span className="popular-thumb-rank">{product.rank}</span>
            </Link>
            <div className="popular-row-body">
              <div className="popular-row-title">
                <h3><Link prefetch={false} href={href} className="card-link">{product.name}</Link></h3>
                {owner && <a className="card-owner" href={owner.profileUrl} target="_blank" rel="noopener noreferrer" title="GitHub 저장소 소유자"><span>@{owner.login}</span></a>}
              </div>
              <ProductTagline tagline={product.tagline} taglineKo={product.taglineKo} source={product.taglineSource} className="popular-description" showSource={false} />
              <p className="popular-row-meta card-dots">
                <span>{categoryLabel(product.category)}</span>
                {account && <span>{account}</span>}
              </p>
            </div>
            <div className="popular-row-end">
              <StarMetric value={product} now={now} />
              <button type="button" className={`cover-saved${isSaved ? " active" : ""}`} aria-label={`${product.name} ${isSaved ? "저장 취소" : "저장"}`}
                aria-pressed={isSaved} onClick={() => toggle(product.slug)}>
                <Icon name="bookmark" size={16} />
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
