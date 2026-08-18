import Link from "next/link";
import { getPublicList, getRankedList, type ProductListItem } from "@/lib/domain/products/view";
import { categoryCounts, type ProductSort } from "@/lib/domain/products/repository";
import { CATEGORIES } from "@/lib/domain/products/schema";
import type { ProductStatus } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { ProductList } from "@/components/ProductCard";
import { EmptyState } from "@/components/EmptyState";
import { BrowseFilters } from "@/components/BrowseFilters";

export const dynamic = "force-dynamic";

// 홈은 가장 뜨거운 경로 — 전체 조회 대신 최근 N개만 (페이지네이션은 규모가 생기면)
const HOME_LIST_LIMIT = 100;

type Props = { searchParams: Promise<{ sort?: string; category?: string; q?: string }> };

const LISTED: ProductStatus[] = ["verified", "seeded"];

export default async function HomePage({ searchParams }: Props) {
  const params = await searchParams;
  const sort: ProductSort = params.sort === "popular" ? "popular" : "recent";
  // 모르는 카테고리가 오면 필터를 걸지 않는다 — 빈 화면보다 전체가 낫다
  const category = CATEGORIES.find((c) => c === params.category);
  const query = params.q?.trim() || undefined;
  // 공개 목록에는 검증된 제품만 — 등록은 열고, 노출은 잠근다
  // DB 장애가 랜딩 전체를 500으로 만들지 않도록 폴백 처리
  let list: ProductListItem[] = [];
  let counts: Record<string, number> = {};
  let total = 0;
  let dbDown = false;
  try {
    // 많이 눌린 순은 랭킹이므로 우리가 직접 확인한 제품만 다룬다.
    // 미클레임 제품까지 섞으면 "확인한 것만 랭킹에 넣는다"는 원칙이 무너진다.
    const options = { sort, category, query };
    [list, counts] = await Promise.all([
      sort === "popular"
        ? getRankedList(HOME_LIST_LIMIT, options)
        : getPublicList(HOME_LIST_LIMIT, options),
      // 칩의 숫자는 검색어와 무관하게 카테고리 전체를 센다 — 필터를 풀었을 때 무엇이 있는지 보여준다
      categoryCounts(LISTED),
    ]);
    total = Object.values(counts).reduce((sum, n) => sum + n, 0);
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

      <BrowseFilters
        state={{ sort, category, query }}
        counts={counts}
        total={total}
      />

      {dbDown ? (
        <div className="mt-10">
          <EmptyState>일시적으로 목록을 불러올 수 없습니다. 잠시 후 다시 시도해주세요.</EmptyState>
        </div>
      ) : list.length === 0 ? (
        <div className="mt-10">
          {query || category ? (
            <EmptyState>
              조건에 맞는 제품이 없습니다.{" "}
              <Link href="/" className="font-semibold text-accent">
                전체 보기
              </Link>
            </EmptyState>
          ) : (
            <EmptyState>
              아직 등록된 제품이 없습니다.{" "}
              <Link href="/launch" className="font-semibold text-accent">
                /nomorevibe
              </Link>{" "}
              로 첫 번째 제품을 등록해보세요.
            </EmptyState>
          )}
        </div>
      ) : (
        <div className="mt-6">
          <ProductList products={list} />
        </div>
      )}
    </main>
  );
}
