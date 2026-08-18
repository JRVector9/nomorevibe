import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { listProducts } from "@/lib/domain/products/repository";
import { isUnclaimed } from "@/lib/domain/products/view";
import type { ProductStatus } from "@/lib/db/schema";
import { AdminNav } from "../AdminNav";
import { ProductRow } from "./ProductRow";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "제품 — NoMoreVibe", robots: { index: false } };

const PAGE_SIZE = 100;

/** 상태 묶음. 어드민이 실제로 묻는 질문에 맞춘다 */
const FILTERS = {
  전체: ["verified", "seeded", "unverified", "banned"],
  검증됨: ["verified"],
  미클레임: ["seeded"],
  "검증 대기": ["unverified"],
  차단됨: ["banned"],
} as const satisfies Record<string, ProductStatus[]>;

type Props = { searchParams: Promise<{ filter?: string }> };

export default async function AdminProductsPage({ searchParams }: Props) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const { filter } = await searchParams;
  // `in`은 프로토타입 키까지 통과시킨다 — ?filter=constructor 하나로 500이 났다
  const active = (filter && Object.hasOwn(FILTERS, filter) ? filter : "전체") as keyof typeof FILTERS;
  const products = await listProducts({ statuses: [...FILTERS[active]], limit: PAGE_SIZE });

  return (
    <main className="mx-auto max-w-[900px] px-6 pb-20">
      <div className="flex flex-wrap items-baseline gap-3 pt-9">
        <h1 className="text-[26px] font-extrabold tracking-tight">제품</h1>
        <span className="text-[12.5px] text-fg-3">{products.length}건</span>
        <div className="ml-auto">
          <AdminNav current="/admin/products" />
        </div>
      </div>

      <nav className="mt-4 flex flex-wrap gap-2">
        {Object.keys(FILTERS).map((name) => (
          <Link
            key={name}
            href={name === "전체" ? "/admin/products" : `/admin/products?filter=${encodeURIComponent(name)}`}
            className={`rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold ${
              name === active ? "border-accent text-accent" : "border-line text-fg-2 hover:text-fg"
            }`}
          >
            {name}
          </Link>
        ))}
      </nav>

      {products.length === 0 ? (
        <p className="mt-8 rounded-[14px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">
          해당하는 제품이 없습니다.
        </p>
      ) : (
        <ul className="mt-5 flex flex-col gap-3">
          {products.map((product) => (
            <ProductRow
              key={product.slug}
              product={{
                slug: product.slug,
                name: product.name,
                url: product.url,
                status: product.status,
                source: product.source,
                unclaimed: isUnclaimed(product),
                listedAt: (product.verifiedAt ?? product.createdAt).toLocaleDateString("ko-KR"),
              }}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
