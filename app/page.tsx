import Link from "next/link";
import { getPublicList, getRankedList, type ProductListItem } from "@/lib/domain/products/view";
import type { ProductSort } from "@/lib/domain/products/repository";
import { logger } from "@/lib/observability/logger";
import { ProductList } from "@/components/ProductCard";
import { EmptyState } from "@/components/EmptyState";

export const dynamic = "force-dynamic";

// 홈은 가장 뜨거운 경로 — 전체 조회 대신 최근 N개만 (페이지네이션은 규모가 생기면)
const HOME_LIST_LIMIT = 100;

type Props = { searchParams: Promise<{ sort?: string }> };

export default async function HomePage({ searchParams }: Props) {
  const { sort: requested } = await searchParams;
  const sort: ProductSort = requested === "popular" ? "popular" : "recent";
  // 공개 목록에는 검증된 제품만 — 등록은 열고, 노출은 잠근다
  // DB 장애가 랜딩 전체를 500으로 만들지 않도록 폴백 처리
  let list: ProductListItem[] = [];
  let dbDown = false;
  try {
    // 많이 눌린 순은 랭킹이므로 우리가 직접 확인한 제품만 다룬다.
    // 미클레임 제품까지 섞으면 "확인한 것만 랭킹에 넣는다"는 원칙이 무너진다.
    list =
      sort === "popular"
        ? await getRankedList(HOME_LIST_LIMIT, sort)
        : await getPublicList(HOME_LIST_LIMIT, sort);
  } catch (error) {
    // 랜딩이 조용히 빈 화면이 되지 않도록, 폴백으로 떨어진 이유를 남긴다
    logger.error("home.list_failed", { error });
    dbDown = true;
  }

  return (
    <main className="mx-auto max-w-[1280px] px-6 pb-20">
      <section className="pb-2 pt-9">
        <h1 className="text-[26px] font-extrabold tracking-tight">AI로 만든 제품들</h1>
        <p className="mt-1.5 max-w-[68ch] text-fg-2">
          AI로 만들어 배포된 실제 서비스들입니다. 도메인 소유권을 우리가 직접 확인한 제품에는{" "}
          <span className="font-semibold text-up">✓ 검증됨</span>이 붙고, 우리가 찾아서 올렸지만 아직
          주인이 나타나지 않은 제품은 <span className="font-semibold text-fg-2">미클레임</span>으로
          표시합니다.
        </p>
      </section>

      <nav className="mt-4 flex gap-2">
        {(
          [
            ["recent", "최신순"],
            ["popular", "많이 눌린 순"],
          ] as const
        ).map(([key, label]) => (
          <Link
            key={key}
            href={key === "recent" ? "/" : "/?sort=popular"}
            className={`rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold ${
              key === sort ? "border-accent text-accent" : "border-line text-fg-2 hover:text-fg"
            }`}
          >
            {label}
          </Link>
        ))}
        {sort === "popular" && (
          <span className="self-center text-[11.5px] text-fg-3">검증된 제품만</span>
        )}
      </nav>

      {dbDown ? (
        <div className="mt-10">
          <EmptyState>일시적으로 목록을 불러올 수 없습니다. 잠시 후 다시 시도해주세요.</EmptyState>
        </div>
      ) : list.length === 0 ? (
        <div className="mt-10">
          <EmptyState>
            아직 등록된 제품이 없습니다.{" "}
            <Link href="/launch" className="font-semibold text-accent">
              /nomorevibe
            </Link>{" "}
            로 첫 번째 제품을 등록해보세요.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-6">
          <ProductList products={list} />
        </div>
      )}
    </main>
  );
}
