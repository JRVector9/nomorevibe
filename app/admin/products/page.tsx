import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { createMemo } from "@/lib/cache/memo";
import { countProducts, countProductsByFilter, listProducts } from "@/lib/domain/products/repository";
import { isUnclaimed } from "@/lib/domain/products/view";
import { claimInviteUrl, isPublicOrigin } from "@/lib/domain/products/claim-invite";
import { repoReviewsFor } from "@/lib/domain/products/repo-reviews";
import { REPO_GONE_WAIT_MS, repoGonePending } from "@/lib/domain/products/repo-pending";
import { introEditorNotes } from "@/lib/domain/products/intro-editor";
import { formatDay, formatDetailTime, formatListTime } from "@/lib/format/time";
import { siteOrigin } from "@/lib/site";
import { ScrollTable } from "../components/ScrollTable";
import { ProductRow } from "./ProductRow";
import { repoReviewView } from "./repo-review-view";
import { pageWindow } from "../paging";
import { PRODUCT_FILTERS, PRODUCT_SORTS, type ProductAdminSort, type ProductFilterName } from "./filters";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "제품 — NoMoreVibe", robots: { index: false } };

/** 한 쪽 — 줄 높이 34px로 한 화면에 머리·거르기와 함께 들어가는 수 */
const PAGE_SIZE = 25;

/**
 * 찾는 글자 없이 센 칩의 수 — 한 번에 공개 제품 3만7천 행을 훑어 150ms 쯤 든다(2026-10-08 복제본 실측).
 * 1분 담아 둔다. 찾는 글자가 있으면 그 결과로 다시 센다(목록과 함께 바뀌어야 뜻이 있다).
 */
const allFilterCounts = createMemo<Record<ProductFilterName, number>>({ ttlMs: 60_000, max: 1 });

type Props = { searchParams: Promise<{ filter?: string; page?: string; q?: string; sort?: string; pending?: string }> };

/** "오늘 13시"·"내일 9시"·"10/12 9시" — 한국 시각 */
function dayHour(at: Date, now: Date): string {
  const day = formatDay(at);
  const label = day === formatDay(now) ? "오늘" : day === formatDay(new Date(now.getTime() + 86_400_000)) ? "내일"
    : `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
  return `${label} ${Number(formatDetailTime(at).slice(11, 13))}시`;
}

export default async function AdminProductsPage({ searchParams }: Props) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const { filter, page: rawPage, q: rawQuery, sort: rawSort, pending: rawPending } = await searchParams;
  // 목록·등록 시각의 '지금' — 서버가 읽은 시각 하나로 그린다
  const now = new Date();
  // `in`은 프로토타입 키까지 통과시킨다 — ?filter=constructor 하나로 500이 났다
  const active = (typeof filter === "string" && Object.hasOwn(PRODUCT_FILTERS, filter) ? filter : "전체") as ProductFilterName;
  const parsedPage = Number(rawPage ?? 1);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  // 이름·slug·URL·저장소 URL 에서 찾는다(repository adminSearch) — 앞뒤 공백을 떼고 100자까지
  const q = typeof rawQuery === "string" ? rawQuery.trim().slice(0, 100) : "";
  const sort: ProductAdminSort = typeof rawSort === "string" && Object.hasOwn(PRODUCT_SORTS, rawSort) ? rawSort as ProductAdminSort : "recent";
  const { statuses, ...flags } = PRODUCT_FILTERS[active];
  const repoGone = active === "저장소 사라짐";
  // ?pending=1 — 저장소 사라짐에 아직 24시간이 지나지 않은 '지금 없음'까지 넣어 본다(2026-10-08 UX 감사 ADM-33)
  const pending = repoGone && rawPending === "1";
  const conditions = { statuses: [...statuses], ...flags, ...(pending ? { repoGone: undefined, repoMissing: true } : {}), adminSearch: q || undefined };
  const repoArchived = active === "저장소 보관됨";
  const repoRenamed = active === "저장소 이름 바뀜";
  const [products, total, counts] = await Promise.all([
    listProducts({ ...conditions, sort, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countProducts(conditions),
    // 칩의 수는 없어도 목록은 그린다
    (q ? countProductsByFilter(PRODUCT_FILTERS, q) : allFilterCounts.get("all", () => countProductsByFilter(PRODUCT_FILTERS))).catch(() => null),
  ]);
  const intro = active === "소개 확인 필요";
  const [reviews, waiting, introNotes] = await Promise.all([
    repoGone ? repoReviewsFor(products.filter((product) => product.accessMode === "website").map((product) => product.id)) : null,
    // 빈 거르기가 운영센터의 '없음'과 어긋나 보이지 않게 — 못 읽으면 안내만 뺀다
    repoGone && !pending ? repoGonePending().catch(() => null) : null,
    intro ? introEditorNotes(products.map((product) => product.id)) : null,
  ]);
  const time = (value: Date | null) => value ? formatListTime(value, now) : null;
  /** 24시간을 채워 확정됐는지 — repository.ts repoGone 과 같은 식 */
  const confirmedGone = (product: (typeof products)[number]) => Boolean(product.repoCheckedAt && product.repoMissingSince
    && product.repoCheckedAt.getTime() >= product.repoMissingSince.getTime() + REPO_GONE_WAIT_MS);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 거르기·찾는 글자·정렬을 이어 가고, 조건이 바뀌면 첫 쪽부터
  const href = (next: number, name: ProductFilterName = active) => {
    const params = new URLSearchParams();
    if (name !== "전체") params.set("filter", name);
    if (q) params.set("q", q);
    if (sort !== "recent") params.set("sort", sort);
    if (pending && name === active) params.set("pending", "1");
    if (next > 1) params.set("page", String(next));
    return `/admin/products${params.size ? `?${params}` : ""}`;
  };
  // 지금 거르기 그대로 내보낸다(C1) — 쪽은 빼고
  const exportParams = new URLSearchParams(href(1).split("?")[1] ?? "");
  const exportHref = `/admin/export?view=products&format=csv${exportParams.size ? `&${exportParams}` : ""}`;
  const pendingHref = `${href(1)}${href(1).includes("?") ? "&" : "?"}pending=1`;
  // 요청을 넘기지 않으므로 NEXT_PUBLIC_SITE_URL이 없으면 localhost로 떨어진다. 그 주소는
  // 초대 이슈에 실을 수 없으므로(claimInviteUrl이 null을 준다) 행에 이유를 대신 보여준다.
  const origin = siteOrigin();
  const publicOriginMissing = !isPublicOrigin(origin);

  return (
    <main className="flex flex-col gap-2.5 pb-10 pt-6">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[22px] font-extrabold tracking-tight">제품</h1>
        <span className="text-[13px] text-fg-3">
          {products.length
            ? `${total.toLocaleString("ko-KR")}건 중 ${((page - 1) * PAGE_SIZE + 1).toLocaleString("ko-KR")}–${((page - 1) * PAGE_SIZE + products.length).toLocaleString("ko-KR")}`
            : `${total.toLocaleString("ko-KR")}건`}
          {pages > 1 && ` · ${page}/${pages} 쪽`}
        </span>
        <a href={exportHref} className="ml-auto text-[13px] font-semibold text-accent hover:underline">CSV 내보내기</a>
      </div>

      <p className="text-[13px] leading-[1.6] text-fg-3">
        ⋯ 메뉴: <b className="font-semibold text-fg-2">차단</b>(사유를 고른다 · 행은 남아 같은 URL의 재등록·재수집을 막음) ·{" "}
        <b className="font-semibold text-fg-2">클레임 초대</b>(레포에 미리 채운 이슈를 직접 제출한 뒤 표시) ·{" "}
        <b className="font-semibold text-fg-2">근거·업데이트 관리</b>. 기준을 고친 뒤에는{" "}
        <Link href="/admin/products/recheck" className="font-semibold text-accent">발행분 재검수</Link>로 이미 올라간 것에도 지금 기준을 태웁니다.
      </p>

      {/* 찾기 — 지금 거르기를 지키고 첫 쪽부터. 신고·메일로 이름만 들었을 때 목록에서 바로 찾는다(2026-10-08 감사 ADM-05) */}
      <Form action="/admin/products" className="flex flex-wrap items-center gap-2 text-[13px]">
        {active !== "전체" && <input type="hidden" name="filter" value={active} />}
        <label className="flex min-w-0 flex-1 basis-[260px] items-center gap-2">
          <span className="shrink-0 font-semibold text-fg-2">찾기</span>
          <input type="search" name="q" defaultValue={q} maxLength={100} placeholder="이름 · 주소(slug) · URL · 저장소"
            className="min-w-0 flex-1 rounded-lg border border-line bg-bg-card px-2.5 py-1.5 text-[13px] text-fg focus:outline-2 focus:outline-accent" />
        </label>
        <label className="flex items-center gap-2">
          <span className="font-semibold text-fg-2">정렬</span>
          <select name="sort" defaultValue={sort} className="rounded-lg border border-line bg-bg-card px-2 py-1.5 text-[13px] text-fg">
            {Object.entries(PRODUCT_SORTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <button type="submit" className="rounded-lg border border-accent bg-accent px-3 py-1.5 font-semibold text-white">찾기</button>
        {(q || sort !== "recent") && <Link href={active === "전체" ? "/admin/products" : `/admin/products?filter=${encodeURIComponent(active)}`}
          className="px-1 py-1.5 text-fg-2 underline">지우기</Link>}
      </Form>

      <nav className="flex flex-wrap gap-1.5" aria-label="제품 거르기">
        {(Object.keys(PRODUCT_FILTERS) as ProductFilterName[]).map((name) => (
          <Link
            key={name}
            href={href(1, name)}
            aria-current={name === active ? "page" : undefined}
            className={`rounded-full border px-2.5 py-1 text-[13px] ${
              name === active ? "border-accent bg-accent-soft font-semibold text-accent"
                : counts?.[name] === 0 ? "border-line bg-bg-card text-fg-3 hover:bg-bg-hover" : "border-line bg-bg-card text-fg-2 hover:bg-bg-hover"
            }`}
          >
            {name}{counts && <> <span className="font-mono">{counts[name].toLocaleString("ko-KR")}</span></>}
          </Link>
        ))}
      </nav>

      {pending && (
        <p className="text-[13px] text-fg-3">
          24시간이 지나지 않은 &lsquo;지금 없음&rsquo;까지 보는 중입니다 — 하루 확인에서 다시 있으면 저절로 빠집니다.{" "}
          <Link href={href(1)} className="font-semibold text-accent">확정된 것만 보기</Link>
        </p>
      )}
      {waiting && waiting.count > 0 && products.length > 0 && (
        <p className="text-[13px] text-fg-3">
          이 밖에 아직 24시간이 지나지 않은 &lsquo;지금 없음&rsquo; {waiting.count.toLocaleString("ko-KR")}건 —{" "}
          <Link href={pendingHref} className="font-semibold text-accent">함께 보기</Link>
        </p>
      )}

      {products.length === 0 ? (
        <div className="rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">
          <p>{q ? `"${q}"에 해당하는 제품이 없습니다.` : "해당하는 제품이 없습니다."}</p>
          {/* 저장소 사라짐은 하루 넘게 이어진 것만 든다 — 운영센터의 '없음'과 수가 다른 까닭을 말한다(ADM-33) */}
          {repoGone && !pending && <p className="mt-2 leading-[1.6]">저장소가 없거나 빈 채로 <b className="font-semibold text-fg-2">24시간 넘게</b> 이어진 공개 제품만 여기 나타납니다.</p>}
          {waiting && waiting.count > 0 && (
            <p className="mt-1 leading-[1.6]">
              지금 없음 {waiting.count.toLocaleString("ko-KR")}건은 아직 24시간이 지나지 않았습니다
              {waiting.firstAt && ` — ${waiting.firstAt > now ? `${dayHour(waiting.firstAt, now)}부터` : "다음 하루 확인부터"} 여기에 나타납니다`}.{" "}
              <Link href={pendingHref} className="font-semibold text-accent">지금 보기</Link>
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-[12px] border border-line bg-bg-card">
        <ScrollTable label="제품 목록">
        <table className="w-full min-w-[720px] table-fixed text-[13px] tabular-nums">
          <colgroup><col /><col className="w-[84px]" /><col className="w-[200px]" /><col className="w-[136px]" /><col className="w-12" /></colgroup>
          <thead className="bg-bg-soft text-left text-fg-3">
            <tr><th className="px-3 py-2 font-semibold">제품 · 주소</th><th className="px-2 py-2 font-semibold">상태</th>
              <th className="px-2 py-2 font-semibold">들어온 길</th><th className="px-2 py-2 text-right font-semibold">등록</th>{/* relative — sr-only(absolute)가 스크롤 상자 밖 문서 폭을 늘리지 않게 */}<th className="relative w-12 px-2 py-2"><span className="sr-only">관리</span></th></tr>
          </thead>
          <tbody>
          {products.map((product, index) => (
            <ProductRow
              key={product.slug}
              // 위로 열 자리(줄 셋)가 없으면 아래로 — 스크롤 상자 위로 넘친 메뉴는 닿을 수 없지만 아래로 넘친 것은 상자를 내려 닿는다
              dropUp={index >= 3 && index >= products.length - 6}
              product={{
                slug: product.slug,
                name: product.name,
                url: product.url,
                status: product.status,
                source: product.source,
                unclaimed: isUnclaimed(product),
                listedAt: formatListTime(product.verifiedAt ?? product.createdAt, now),
                inviteUrl: claimInviteUrl(product, origin),
                publicOriginMissing,
                invitedAt: time(product.claimInvitedAt),
                repoGone: repoGone ? [
                  product.accessMode === "website" ? "웹 · GitHub 표시만 뺌" : "설치형 · 목록에서 가려짐",
                  product.repoMissingSince && `${time(product.repoMissingSince)}부터 ${product.repoStatus === "empty" ? "빈 저장소" : "없음"}`,
                  pending && !confirmedGone(product) && "24시간 확인 대기 — 아직 공개 화면은 그대로",
                ].filter(Boolean).join(" · ") : null,
                ...(reviews && product.accessMode === "website" ? { repoReview: reviews.has(product.id) ? repoReviewView(reviews.get(product.id)!, now) : null } : {}),
                repoNote: repoArchived ? `보관됨 · 마지막 push ${time(product.repoPushedAt) ?? "모름"}`
                  : repoRenamed ? `이름 바뀜 → ${product.repoRenamedTo} (repo_url 은 옛 이름 그대로)` : null,
                ...(introNotes ? { intro: { tagline: product.tagline, problem: introNotes.get(product.id)?.problem ?? "" } } : {}),
              }}
            />
          ))}
          </tbody>
        </table>
        </ScrollTable>
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
