"use client";

import Link from "next/link";
import { ProductTagline } from "@/components/ProductTagline";
import { useLocale,useTranslations } from "@/lib/i18n/context";
import { formatNumber,formatRelativeTime } from "@/lib/i18n/format";
import { localePath } from "@/lib/i18n/routing";
import type { ProductListItem } from "@/lib/domain/products/view";
import type { getDiscoveryBoards, RankingListItem } from "@/lib/domain/ranking/view";

type Boards = Awaited<ReturnType<typeof getDiscoveryBoards>>;

function ProductLink({ product, detail }: { product: ProductListItem; detail: React.ReactNode }) {
  const locale=useLocale();
  const labels=useTranslations("labels");
  return (
    <li className="border-t border-line py-3 first:border-0 first:pt-0 last:pb-0">
      <Link prefetch={false} href={localePath(locale,`/p/${product.slug}`)} className="group block">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-bold group-hover:text-accent">
            {product.name}
          </span>
          {product.unclaimed && (
            <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[13px] font-semibold text-fg-2" title={labels("status.unclaimedHint")}>
              {labels("status.unclaimed")}
            </span>
          )}
        </div>
        <ProductTagline tagline={product.tagline} source={product.taglineSource} className="mt-0.5 truncate text-[13px] text-fg-2" showSource={false} />
        <div className="mt-1 font-mono text-[13px] font-semibold text-fg-2">{detail}</div>
      </Link>
    </li>
  );
}

function Board({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[12px] border border-line bg-bg-card p-4">
      <h3 className="mb-3 text-[13px] font-extrabold">{title}</h3>
      {children}
    </section>
  );
}

function Entries({
  items,
  detail,
}: {
  items: ProductListItem[];
  detail: (item: ProductListItem) => React.ReactNode;
}) {
  const t=useTranslations("browse");
  if (items.length === 0) return <p className="text-[13px] text-fg-2">{t("boards.empty")}</p>;
  return <ol>{items.map((item) => <ProductLink key={item.slug} product={item} detail={detail(item)} />)}</ol>;
}

export function DiscoveryBoards({ boards, now = new Date() }: { boards: Boards; now?: Date }) {
  const locale=useLocale();
  const t=useTranslations("browse");
  const count=(n:number)=>formatNumber(n,locale);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Board title={t("boards.season")}>
        <Entries
          items={boards.weekly}
          detail={(item) => {
            const ranked = item as RankingListItem;
            if (ranked.scoreMode === "unique_visitors") {
              return t("boards.uniqueDetail", {rank:count(ranked.rank),unique:count(ranked.uniqueVisitors),visits:count(ranked.validClicks)});
            }
            return t("boards.visitDetail", {rank:count(ranked.rank),visits:count(ranked.validClicks)});
          }}
        />
      </Board>
      <Board title={t("boards.growing")}>
        <Entries
          items={boards.trending}
          detail={(item) => {
            const change = (item as RankingListItem).changePercent;
            if (change === null) return t("ranking.new");
            return <span className={change >= 0 ? "text-up" : "text-down"}>{change > 0 ? "+" : ""}{count(change)}%</span>;
          }}
        />
      </Board>
      <Board title={t("boards.verified")}>
        <Entries items={boards.verifiedNew} detail={(item) => formatRelativeTime(item.listedAt,now,locale)} />
      </Board>
      <Board title={t("boards.discovered")}>
        <Entries items={boards.discoveredNew} detail={(item) => formatRelativeTime(item.listedAt,now,locale)} />
      </Board>
    </div>
  );
}
