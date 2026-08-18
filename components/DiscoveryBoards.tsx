import Link from "next/link";
import type { ProductListItem } from "@/lib/domain/products/view";
import type { getDiscoveryBoards, RankingListItem } from "@/lib/domain/ranking/view";

type Boards = Awaited<ReturnType<typeof getDiscoveryBoards>>;

function relativeDate(date: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60_000));
  if (minutes < 60) return minutes < 1 ? "방금" : `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  return `${Math.floor(days / 30)}개월 전`;
}

function ProductLink({ product, detail }: { product: ProductListItem; detail: React.ReactNode }) {
  return (
    <li className="border-t border-line py-3 first:border-0 first:pt-0 last:pb-0">
      <Link href={`/p/${product.slug}`} className="group block">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-bold group-hover:text-accent">
            {product.name}
          </span>
          {product.unclaimed && (
            <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] font-semibold text-fg-3">
              미클레임
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11.5px] text-fg-3">{product.tagline}</p>
        <div className="mt-1 font-mono text-[11.5px] font-semibold text-fg-2">{detail}</div>
      </Link>
    </li>
  );
}

function Board({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[14px] border border-line bg-bg-card p-4">
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
  if (items.length === 0) return <p className="text-[12px] text-fg-3">아직 표시할 제품이 없습니다.</p>;
  return <ol>{items.map((item) => <ProductLink key={item.slug} product={item} detail={detail(item)} />)}</ol>;
}

export function DiscoveryBoards({ boards, now = new Date() }: { boards: Boards; now?: Date }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Board title="이번 시즌">
        <Entries
          items={boards.weekly}
          detail={(item) => {
            const ranked = item as RankingListItem;
            return `#${ranked.rank} · 유효 클릭 ${ranked.validClicks.toLocaleString("ko-KR")}`;
          }}
        />
      </Board>
      <Board title="급상승">
        <Entries
          items={boards.trending}
          detail={(item) => {
            const change = (item as RankingListItem).changePercent;
            if (change === null) return "신규";
            return <span className={change >= 0 ? "text-up" : "text-down"}>{change > 0 ? "+" : ""}{change}%</span>;
          }}
        />
      </Board>
      <Board title="새로 검증됨">
        <Entries items={boards.verifiedNew} detail={(item) => relativeDate(item.listedAt, now)} />
      </Board>
      <Board title="새로 발견됨">
        <Entries items={boards.discoveredNew} detail={(item) => relativeDate(item.listedAt, now)} />
      </Board>
    </div>
  );
}
