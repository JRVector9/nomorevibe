import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { countProducts, listProducts } from "@/lib/domain/products/repository";
import { isUnclaimed } from "@/lib/domain/products/view";
import { claimInviteUrl, isPublicOrigin } from "@/lib/domain/products/claim-invite";
import { siteOrigin } from "@/lib/site";
import type { ProductStatus } from "@/lib/db/schema";
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

type Props = { searchParams: Promise<{ filter?: string; page?: string }> };

export default async function AdminProductsPage({ searchParams }: Props) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const { filter, page: rawPage } = await searchParams;
  // `in`은 프로토타입 키까지 통과시킨다 — ?filter=constructor 하나로 500이 났다
  const active = (filter && Object.hasOwn(FILTERS, filter) ? filter : "전체") as keyof typeof FILTERS;
  const parsedPage = Number(rawPage ?? 1);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const statuses = [...FILTERS[active]];
  const [products, total] = await Promise.all([
    listProducts({ statuses, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countProducts({ statuses }),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const href = (next: number) => {
    const params = new URLSearchParams();
    if (active !== "전체") params.set("filter", active);
    if (next > 1) params.set("page", String(next));
    return `/admin/products${params.size ? `?${params}` : ""}`;
  };
  // 요청을 넘기지 않으므로 NEXT_PUBLIC_SITE_URL이 없으면 localhost로 떨어진다. 그 주소는
  // 초대 이슈에 실을 수 없으므로(claimInviteUrl이 null을 준다) 행에 이유를 대신 보여준다.
  const origin = siteOrigin();
  const publicOriginMissing = !isPublicOrigin(origin);

  return (
    <main className="mx-auto max-w-[900px] px-6 pb-20">
      <div className="flex flex-wrap items-baseline gap-3 pt-9">
        <h1 className="text-[26px] font-extrabold tracking-tight">제품</h1>
        <span className="text-[13px] text-fg-3">
          {total.toLocaleString("ko-KR")}건 중 {products.length ? `${((page - 1) * PAGE_SIZE + 1).toLocaleString("ko-KR")}–${((page - 1) * PAGE_SIZE + products.length).toLocaleString("ko-KR")}` : "0"}
          {pages > 1 && ` · ${page}/${pages} 쪽`}
        </span>

      </div>

      <nav className="mt-4 flex flex-wrap gap-2">
        {Object.keys(FILTERS).map((name) => (
          <Link
            key={name}
            href={name === "전체" ? "/admin/products" : `/admin/products?filter=${encodeURIComponent(name)}`}
            className={`rounded-lg border px-3 py-1.5 text-[13px] font-semibold ${
              name === active ? "border-accent text-accent" : "border-line text-fg-2 hover:text-fg"
            }`}
          >
            {name}
          </Link>
        ))}
      </nav>

      {products.length === 0 ? (
        <p className="mt-8 rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">
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
                inviteUrl: claimInviteUrl(product, origin),
                publicOriginMissing,
                invitedAt:
                  product.claimInvitedAt?.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }) ?? null,
              }}
            />
          ))}
        </ul>
      )}

      {pages > 1 && (
        <nav aria-label="제품 목록 쪽 이동" className="mt-6 flex flex-wrap items-center gap-2 text-[13px]">
          {page > 1 && <Link href={href(page - 1)} className="rounded-lg border border-line px-3 py-2 font-semibold">이전</Link>}
          <span className="text-fg-3">{page} / {pages} 쪽</span>
          {page < pages && <Link href={href(page + 1)} className="rounded-lg border border-line px-3 py-2 font-semibold">다음</Link>}
        </nav>
      )}
    </main>
  );
}
