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
import { NAME_ISSUE_LABELS } from "@/lib/domain/products/display-name";
import { namesNeedingReview } from "@/lib/domain/products/name-review";
import { formatDay, formatDetailTime, formatListTime } from "@/lib/format/time";
import { siteOrigin } from "@/lib/site";
import { ScrollTable } from "../components/ScrollTable";
import { ProductRow } from "./ProductRow";
import { repoReviewView } from "./repo-review-view";
import { PRODUCT_FILTERS, PRODUCT_SORTS, type ProductAdminSort, type ProductFilterName } from "./filters";
import { PrototypePanel, PrototypeStat, PrototypeTag, n, prototypeRepositoryStatus } from "./PrototypeParts";
import { PrototypeQualityWorkspace, PrototypeTranslationsWorkspace } from "./PrototypeProductWorkspaces";
import { PageStamp } from "@/app/(operator)/admin/components/PageStamp";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "제품 — NoMoreVibe", robots: { index: false } };

/** 한 쪽 — 줄 높이 34px로 한 화면에 머리·거르기와 함께 들어가는 수 */
const PAGE_SIZE = 25;

/**
 * 찾는 글자 없이 센 칩의 수 — 한 번에 공개 제품 3만7천 행을 훑어 150ms 쯤 든다(2026-10-08 복제본 실측).
 * 1분 담아 둔다. 찾는 글자가 있으면 그 결과로 다시 센다(목록과 함께 바뀌어야 뜻이 있다).
 */
const allFilterCounts = createMemo<Record<ProductFilterName, number>>({ ttlMs: 60_000, max: 1 });

type Props = { searchParams: Promise<{ filter?: string; page?: string; q?: string; sort?: string; pending?: string; tab?: string; mode?: string; offset?: string; cursor?: string }> };

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

  const params = await searchParams;
  if (params.tab === "quality") return <PrototypeQualityWorkspace mode={typeof params.mode === "string" ? params.mode : undefined} offset={typeof params.offset === "string" ? params.offset : undefined} />;
  if (params.tab === "translations") return <PrototypeTranslationsWorkspace admin={admin} query={typeof params.q === "string" ? params.q : ""} cursor={typeof params.cursor === "string" ? params.cursor : undefined} />;
  const { filter, page: rawPage, q: rawQuery, sort: rawSort, pending: rawPending } = params;
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
  const repoAutoBanned = active === "저장소 소실 자동 차단";
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
  const [reviews, waiting, introNotes, nameReviews] = await Promise.all([
    repoGone || repoAutoBanned ? repoReviewsFor(products.map((product) => product.id)) : null,
    // 빈 거르기가 운영센터의 '없음'과 어긋나 보이지 않게 — 못 읽으면 안내만 뺀다
    repoGone && !pending ? repoGonePending().catch(() => null) : null,
    intro ? introEditorNotes(products.map((product) => product.id)) : null,
    active === "이름 확인 필요" ? namesNeedingReview() : null,
  ]);
  /** 이름 확인 — 지금 이름(행의 제목) 옆에 제안과 사유 */
  const nameNote = (slug: string) => {
    const review = nameReviews?.get(slug);
    // 짐작한 제안·저장소 이름으로 대신한 제안은 자주 틀린다 — 그대로 고르지 말고 사이트를 보고 정하라고 적는다
    const caution = review?.source === "repo" ? " (저장소 이름 — 확인 필요)" : review?.source === "guess" ? " (짐작 — 확인 필요)" : "";
    const proposal = review?.proposed ? `${review.proposed}${caution}` : "없음 (직접 확인)";
    return review ? `제안 → ${proposal} · ${review.issues.map((issue) => NAME_ISSUE_LABELS[issue]).join(", ")}` : null;
  };
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

  return <main><PageStamp />
    <div className="page-heading"><div className="heading-actions"><a className="button small" href={exportHref}>CSV 내보내기</a></div></div>
    <div className="grid four mb">
      <PrototypeStat label="등록 프로젝트" value={n(counts?.전체)} note={q ? "현재 검색어의 전체 상태" : "검증·미클레임·검증 대기·차단 포함"} />
      <PrototypeStat label="공개 대상 상태" value={counts ? n(counts.검증됨 + counts.미클레임) : "—"} note="실제 노출은 생존·보류 조건도 적용" tone="good" />
      <PrototypeStat label="생존 확인 필요" value={n(counts?.["응답 없음"])} note="공개 대상 중 연속 응답 실패" tone="warn" />
      <PrototypeStat label="소개 확인 필요" value={n(counts?.["소개 확인 필요"])} note="현재 소개의 편집 보류" />
    </div>
    <Form action="/admin/products" className="toolbar">
      <input type="search" name="q" className="search-input" defaultValue={q} maxLength={100} placeholder="프로젝트명·주소 검색" aria-label="프로젝트 검색" />
      <select name="filter" defaultValue={active} aria-label="프로젝트 필터">{(Object.keys(PRODUCT_FILTERS) as ProductFilterName[]).map(name => <option key={name} value={name}>{name}{counts ? ` (${n(counts[name])})` : ""}</option>)}</select>
      <select name="sort" defaultValue={sort} aria-label="프로젝트 정렬">{Object.entries(PRODUCT_SORTS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      <button className="button small" type="submit">조회</button><span className="small muted spacer">{n(total)}개 · {page}/{pages}쪽</span>
    </Form>
    <section className="panel"><div className="table-scroll"><table style={{ minWidth: 920 }}><thead><tr><th>프로젝트</th><th>공개 상태 / 원본</th><th>메이커 확인</th><th>품질·후처리</th><th>최근 관측</th><th>관리</th></tr></thead><tbody>
      {products.map(product => <tr key={product.slug}><td><div className="flex"><span className="project-avatar">{product.name.slice(0,2)}</span><div><Link className="name" href={`/admin/products/${product.slug}`}>{product.name}</Link><p>{product.source === "crawler" ? "자동 수집" : "직접 등록"} · /{product.slug}</p></div></div></td>
        <td><PrototypeTag tone={product.status === "banned" ? "gray" : product.status === "unverified" ? "amber" : "green"}>{({ verified: "검증됨", seeded: "미클레임", unverified: "검증 대기", banned: "차단" })[product.status]}</PrototypeTag><p>{product.source === "crawler" ? "자동 수집 원본" : "직접 등록 원본"}</p></td>
        <td>{product.claimedAt ? "클레임됨" : isUnclaimed(product) ? "미클레임" : "미확인"}<p><Link href={`/admin/products/${product.slug}?section=maker`}>확인 기록 →</Link></p></td>
        <td><PrototypeTag tone={product.repoStatus === "not_found" || product.repoStatus === "empty" ? "amber" : "gray"}>{prototypeRepositoryStatus(product.repoStatus)}</PrototypeTag><p><Link href={`/admin/products/${product.slug}?section=intro`}>소개·번역 상태</Link></p></td>
        <td>{formatListTime(product.repoCheckedAt ?? product.createdAt, now)}<p>{product.repoCheckedAt ? "저장소 확인" : "등록 시각"}</p></td><td><Link className="button small" href={`/admin/products/${product.slug}`}>상세 관리</Link></td></tr>)}
      {products.length === 0 && <tr><td colSpan={6}><div className="empty">조건에 맞는 프로젝트가 없습니다.</div></td></tr>}
    </tbody></table></div><div className="table-note">공개 대상 상태와 실제 공개 노출, 메이커 소유권 확인을 구분합니다. 차단·클레임 초대·이름/소개 확인의 원본 조치는 아래 상세 관리에서 유지합니다.</div></section>
    <div className="flex mt"><Link className="button small" href={href(Math.max(1, page - 1))}>이전</Link><span className="small muted">{page}/{pages}</span>{page < pages && <Link className="button small" href={href(page + 1)}>다음</Link>}</div>
    {pending && <div className="notice mt">24시간 확인 전의 저장소 누락도 함께 표시합니다.</div>}
    {waiting && waiting.count > 0 && <div className="notice mt">24시간 확인 대기 {n(waiting.count)}건 · {waiting.firstAt ? dayHour(waiting.firstAt, now) : "다음 관측"} <Link href={pendingHref}>함께 보기 →</Link></div>}
    <details className="mt"><summary className="text-button">차단·클레임 초대·이름/소개·저장소 상세 관리</summary><PrototypePanel title="원본 조건과 관리 조치"><ScrollTable label="프로젝트 상세 관리"><table className="w-full min-w-[720px] text-[13px]"><thead><tr><th>프로젝트</th><th>상태</th><th>유입</th><th>등록</th><th>관리</th></tr></thead><tbody>{products.map((product, index) => <ProductRow key={product.slug} dropUp={index >= 3 && index >= products.length - 6} product={{ slug: product.slug, name: product.name, url: product.url, status: product.status, source: product.source, unclaimed: isUnclaimed(product), listedAt: formatListTime(product.verifiedAt ?? product.createdAt, now), inviteUrl: claimInviteUrl(product, origin), publicOriginMissing, invitedAt: time(product.claimInvitedAt), repoGone: repoGone || repoAutoBanned ? [repoAutoBanned && "저장소 소실 자동 차단", product.repoMissingSince && `${time(product.repoMissingSince)}부터 없음`, pending && !confirmedGone(product) && "24시간 확인 대기"].filter(Boolean).join(" · ") : null, ...(reviews ? { repoReview: reviews.has(product.id) ? repoReviewView(reviews.get(product.id)!, now) : null } : {}), repoNote: repoArchived ? `보관됨 · 마지막 push ${time(product.repoPushedAt) ?? "모름"}` : repoRenamed ? `이름 바뀜 → ${product.repoRenamedTo}` : nameNote(product.slug), ...(introNotes ? { intro: { tagline: product.tagline, problem: introNotes.get(product.id)?.problem ?? "" } } : {}) }} />)}</tbody></table></ScrollTable></PrototypePanel></details>
  </main>;
}
