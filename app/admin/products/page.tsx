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
import { pageWindow } from "../paging";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "제품 — NoMoreVibe", robots: { index: false } };

/** 한 쪽 — 줄 높이 34px로 한 화면에 머리·거르기와 함께 들어가는 수 */
const PAGE_SIZE = 25;

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
    <main className="flex flex-col gap-2.5 pb-10 pt-6">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[22px] font-extrabold tracking-tight">제품</h1>
        <span className="text-[13px] text-fg-3">
          {total.toLocaleString("ko-KR")}건 중 {products.length ? `${((page - 1) * PAGE_SIZE + 1).toLocaleString("ko-KR")}–${((page - 1) * PAGE_SIZE + products.length).toLocaleString("ko-KR")}` : "0"}
          {pages > 1 && ` · ${page}/${pages} 쪽`}
        </span>

      </div>

      <p className="text-[13px] leading-[1.6] text-fg-3">
        ⋯ 메뉴: <b className="font-semibold text-fg-2">차단</b>(행은 남아 같은 URL의 재등록·재수집을 막음) ·{" "}
        <b className="font-semibold text-fg-2">클레임 초대</b>(레포에 미리 채운 이슈를 직접 제출한 뒤 표시) ·{" "}
        <b className="font-semibold text-fg-2">근거·업데이트 관리</b>. 기준을 고친 뒤에는{" "}
        <Link href="/admin/products/recheck" className="font-semibold text-accent">발행분 재검수</Link>로 이미 올라간 것에도 지금 기준을 태웁니다.
      </p>

      <nav className="flex flex-wrap gap-1.5">
        {Object.keys(FILTERS).map((name) => (
          <Link
            key={name}
            href={name === "전체" ? "/admin/products" : `/admin/products?filter=${encodeURIComponent(name)}`}
            className={`rounded-full border px-2.5 py-1 text-[13px] ${
              name === active ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line bg-bg-card text-fg-2 hover:bg-bg-hover"
            }`}
          >
            {name}
          </Link>
        ))}
      </nav>

      {products.length === 0 ? (
        <p className="rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">
          해당하는 제품이 없습니다.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[12px] border border-line bg-bg-card">
        <table className="w-full min-w-[720px] table-fixed text-[13px] tabular-nums">
          <colgroup><col /><col className="w-[84px]" /><col className="w-[200px]" /><col className="w-[104px]" /><col className="w-12" /></colgroup>
          <thead className="bg-bg-soft text-left text-fg-3">
            <tr><th className="px-3 py-2 font-semibold">제품 · 주소</th><th className="px-2 py-2 font-semibold">상태</th>
              <th className="px-2 py-2 font-semibold">들어온 길</th><th className="px-2 py-2 text-right font-semibold">등록</th><th className="w-12 px-2 py-2"><span className="sr-only">관리</span></th></tr>
          </thead>
          <tbody>
          {products.map((product, index) => (
            <ProductRow
              key={product.slug}
              dropUp={index >= products.length - 6}
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
          </tbody>
        </table>
        </div>
      )}

      {pages > 1 && (
        <nav aria-label="제품 목록 쪽 이동" className="flex flex-wrap items-center gap-1 text-[13px]">
          {page > 1 && <Link href={href(page - 1)} className="rounded-lg border border-line px-2.5 py-1">이전</Link>}
          {pageWindow(page, pages).map((item, i) => item === null
            ? <span key={`gap-${i}`} className="px-1 text-fg-3">…</span>
            : <Link key={item} href={href(item)} aria-current={item === page ? "page" : undefined}
                className={`min-w-8 rounded-lg border px-2.5 py-1 text-center font-mono ${item === page ? "border-accent bg-accent text-white" : "border-line text-fg-2"}`}>{item}</Link>)}
          {page < pages && <Link href={href(page + 1)} className="rounded-lg border border-line px-2.5 py-1">다음</Link>}
        </nav>
      )}
    </main>
  );
}
