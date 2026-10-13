"use client";

import Link from "next/link";
import { ProductTagline } from "@/components/ProductTagline";
import { StarMetric } from "@/components/StarMetric";
import { StarGrowthMetric } from "@/components/home/StarGrowthMetric";
import { Icon } from "@/components/home/icons";
import type { RankedCardProduct } from "@/components/home/popular-cards";
import { ProjectTile } from "@/components/home/ProjectTile";
import { useSavedSlugs } from "@/components/home/useSavedSlugs";
import { listedRepositoryOwner } from "@/lib/domain/products/github-owner";
import { translatedCategory } from "@/components/home/i18n";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";
import { formatNumber } from "@/lib/i18n/format";
import "@/components/home/cards.css";



/**
 * /popular 목록 보기 — 순위 · 커버(발견하기 카드와 같은 ProjectTile) · 이름 · @소유자 · 소개 두 줄 · 분야·계정 · ★와 증감 · 저장.
 * 줄 하나가 링크 하나다(카드와 같은 UX-30): 이름 링크가 줄 전체를 덮고, 소유자 링크와 저장만 따로 누른다.
 * 좁은 화면은 커버를 줄이고 순위를 커버 위 숫자로 옮긴다(popular.css).
 */
export function PopularList({ items, now }: { items: RankedCardProduct[]; now: string }) {
  const locale=useLocale();
  const t=useTranslations("labels");
  const count=(n:number)=>formatNumber(n,locale);
  const [saved, toggle] = useSavedSlugs();
  return (
    <ol className="popular-list">
      {items.map((product) => {
        const href = localePath(locale,`/p/${product.slug}`);
        const owner = listedRepositoryOwner(product.repoUrl, product.repoRenamedTo);
        const isSaved = saved.has(product.slug);
        const account = product.ownerType === "User" ? t("card.personal") : product.ownerType === "Organization" ? t("card.organization") : null;
        return (
          <li key={product.slug} className="popular-row">
            <span className="popular-rank"><span aria-hidden="true">{count(product.rank)}</span><span className="sr-only">{t("card.rank", { rank:count(product.rank) })}</span></span>
            <Link prefetch={false} href={href} className="popular-thumb" tabIndex={-1} aria-hidden="true">
              <ProjectTile slug={product.slug} name={product.name} ogImage={product.ogImage} size={44} installable={product.accessMode === "installable"}
                ai={product.aiLevel != null} category={product.category} />
              <span className="popular-thumb-rank">{count(product.rank)}</span>
            </Link>
            <div className="popular-row-body">
              <div className="popular-row-title">
                <h3><Link prefetch={false} href={href} className="card-link">{product.name}</Link></h3>
                {owner && <a className="card-owner" href={owner.profileUrl} target="_blank" rel="noopener noreferrer" title={t("card.owner")}><span>@{owner.login}</span></a>}
              </div>
              <ProductTagline translation={product.translation} tagline={product.tagline} taglineKo={product.taglineKo} source={product.taglineSource} className="popular-description" showSource={false} />
              <p className="popular-row-meta card-dots">
                <span>{translatedCategory(product.category,t)}</span>
                {account && <span>{account}</span>}
              </p>
            </div>
            <div className="popular-row-end">
              {product.starGrowth ? <StarGrowthMetric value={product.starGrowth} /> : <StarMetric value={product} now={now} />}
              <button type="button" className={`cover-saved${isSaved ? " active" : ""}`} aria-label={t(isSaved?"card.unsave":"card.save", { name:product.name })}
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
