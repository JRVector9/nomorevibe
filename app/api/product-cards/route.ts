import { NextResponse } from "next/server";
import { cardItem, type CardItem } from "@/components/cards/card-item";
import { HOME_MAX_SHOWN } from "@/components/home/browse-state";
import { homeListFromParams, readHomeList, readUnclaimedList } from "@/components/home/home-list";
import { getPopularGroups, getPopularPage } from "@/lib/domain/products/popular";
import { publicRead } from "@/lib/domain/products/public-reads";
import { getStarGrowthPage } from "@/lib/domain/products/star-growth";
import { POPULAR_SERVER_ROWS, STAR_TIERS, parsePopularParams } from "@/lib/domain/products/stars";
import { completedWindows, getHomePulse } from "@/lib/domain/products/home-pulse";
import { countNewThisWeek, getNewThisWeek, getPublicListBySlugs, NEW_THIS_WEEK_MIN_STARS, type ProductListItem } from "@/lib/domain/products/view";
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { withRoute } from "@/lib/http/handler";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n/locales";
import { localizeProductList } from "@/lib/i18n/products";
import { publicPaginationBlocked } from "@/lib/web/public-pagination";

const NO_STORE = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store" } as const;

/** 서버 HTML 의 카드(이름·요약)에 채울 나머지 칸 — 카드가 그리는 값에서 이름을 뺀 것(요약 원문·번역 표식은 툴팁·기계 번역 표시에 쓴다) */
export type CardFill = Omit<CardItem, "name"> & { rank?: number; ownerType?: "User" | "Organization" | null };
/** 브라우저가 열 때 받는 카드 목록 — 서버 HTML 에 없는 카드라 이름까지 */
export type ProductCardsResponse = { items: (CardFill & { name: string })[] };
export type ProductCardFillsResponse = { items: CardFill[] };

/** slugs 한 번에 받는 수 — 화면에 있는 카드(홈 첫 쪽 9 + 주인 기다리는 9 + 띠 5…)를 한 번에 */
export const MAX_CARD_SLUGS = 60;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
/** 홈 더 보기 뒷카드 한 번에 — 화면이 그리는 창(HOME_MAX_SHOWN)을 넘지 않는다 */
const HOME_REST_MAX = HOME_MAX_SHOWN;
/** /?new=1 한 쪽(app/(public)/[locale]/(content)/page.tsx NewRepositories 와 같다) */
export const NEW_PAGE_SIZE = 15;
/** /rising 한 쪽(app/(public)/[locale]/(content)/rising/page.tsx 와 같다) */
export const RISING_PAGE_SIZE = 15;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const cards = async <T extends Parameters<typeof cardItem>[0] & ProductListItemLike>(rows: T[], locale: Locale) =>
  (await localizeProductList(rows, locale)).map((item) => cardItem(item, locale));
type ProductListItemLike = { name: string; tagline: string; id?: number };

function offsetParam(value: string | null, max: number): number | null {
  if (value === null) return 0;
  if (!/^(0|[1-9][0-9]{0,6})$/.test(value)) return null;
  const number = Number(value);
  return number <= max ? number : null;
}

/**
 * 카드 채우기·첫 화면 밖 카드(2026-11-14 공개 HTML 줄이기, 2026-11-15 이름·요약만 — 문서 4.1·4.2).
 * 서버 HTML·RSC 데이터에는 카드의 slug·이름·요약만 있고, 나머지 칸은 화면 JS 가 이 같은 출처 API 로 받는다.
 *  - slugs=a,b,…(최대 60) : 화면에 있는 카드의 나머지 칸 — 이름은 빼고 준다. 없는·내려간 제품(공개 목록 밖)은 응답에 없다.
 *    full=1 이면 이름까지(저장 목록 보기처럼 서버 HTML 에 카드가 없을 때)
 *  - list=popular&tier=<구간>&personal=1 : 홈 '많이 쓰이는 프로젝트'의 구간 상위 3(홈 구간과 같은 읽기·같은 열쇠)
 *  - list=rising : 홈 8시간 급상승 띠·없는 주소 화면의 '지금 뜨는' 다섯(홈 띠와 같은 읽기·같은 열쇠)
 *  - list=rising-page&page=&cycle= : /rising 한 쪽(증가·순위 줄)
 *  - list=new : 홈 '이번 주 새로 나온' 다섯, list=new-page&page= : /?new=1 한 쪽
 *  - list=popular-page&</popular 의 tier·personal·ai·category·sort·page>[&from=0] : /popular 한 쪽 — 기본은 서버가 그린 앞줄
 *    (POPULAR_SERVER_ROWS) 다음부터, from=0 이면 처음부터(앞줄 채우기와 2쪽부터의 빈 틀)
 *  - list=active : 홈 '이번 주 가장 활발한' 다섯의 아이콘·분야·스타·새 버전 수(홈 집계와 같은 값)
 *  - list=home&<홈 sort·category·builder·observedTool·ai>&offset=&limit=[&section=unclaimed] : 홈·분야 더 보기(?shown=)의 첫 쪽 뒤 카드
 * 공개 API 읽기 관문을 그대로 거친다. 카드가 그리는 칸만 돌려준다(card-item.ts).
 */
export const GET = withRoute("products.cards", async (req: Request) => {
  const refused = await guardPublicApiRead(req, "products.cards");
  if (refused) return refused;
  const params = new URL(req.url).searchParams;
  const requested = params.get("locale");
  const locale = requested && isLocale(requested) ? requested : DEFAULT_LOCALE;
  const slugsParam = params.get("slugs");
  if (slugsParam !== null) {
    const asked = [...new Set(slugsParam.split(",").map((slug) => slug.trim()).filter(Boolean))];
    if (asked.length > MAX_CARD_SLUGS) return json({ error: "too_many_slugs", max: MAX_CARD_SLUGS }, 400);
    const slugs = asked.filter((slug) => SLUG.test(slug)).sort();
    // 차례를 맞춰 열쇠를 정한다 — 같은 화면을 여러 사람이 열면 같은 읽기를 나눠 쓴다
    const rows = await publicRead("list", ["card-slugs", slugs], () => getPublicListBySlugs(slugs));
    const items = await cards(rows, locale);
    const full = params.get("full") === "1";
    return json({ items: full ? items : items.map((item) => { const fill: CardFill & { name?: string } = { ...item }; delete fill.name; return fill; }) } satisfies ProductCardFillsResponse);
  }
  const list = params.get("list");
  if (list === "popular") {
    const tier = STAR_TIERS.find((item) => item.key === params.get("tier"));
    if (!tier) return json({ error: "unknown_tier" }, 400);
    const personal = params.get("personal") === "1";
    const groups = await publicRead("list", ["popular-groups", personal], () => getPopularGroups(personal));
    const items = await cards(groups.find((group) => group.key === tier.key)?.items ?? [], locale);
    return json({ items: items.map((item, index) => ({ ...item, rank: index + 1 })) } satisfies ProductCardsResponse);
  }
  if (list === "popular-page") {
    const query = Object.fromEntries(params.entries());
    if (publicPaginationBlocked(query, "page")) return json({ error: "page_out_of_range" }, 400);
    const state = parsePopularParams(query);
    const filters = { personal: state.personal, ai: state.ai, category: state.category };
    const result = await publicRead("list", ["popular-page", state.tier, filters, state.sort, state.page],
      () => getPopularPage(state.tier, filters, state.sort, state.page));
    const skip = params.get("from") === "0" ? 0 : POPULAR_SERVER_ROWS;
    const first = (result.page - 1) * result.pageSize + 1 + skip;
    const rows = result.items.slice(skip);
    const items = await cards(rows, locale);
    return json({ items: items.map((item, index) => ({ ...item, ownerType: rows[index].ownerType ?? null, rank: first + index })) } satisfies ProductCardsResponse);
  }
  if (list === "rising") {
    // 홈 띠와 같은 읽기(pageSize 5) — 같은 열쇠를 나눠 쓴다
    const page = await getStarGrowthPage({ pageSize: 5 });
    return json({ items: await cards(page.items, locale) } satisfies ProductCardsResponse);
  }
  if (list === "rising-page") {
    const query = Object.fromEntries(params.entries());
    if (publicPaginationBlocked(query, "page")) return json({ error: "page_out_of_range" }, 400);
    const page = await getStarGrowthPage({ pageSize: RISING_PAGE_SIZE, page: params.get("page") ?? undefined, cycle: params.get("cycle") ?? undefined });
    const first = (page.page - 1) * page.pageSize + 1;
    const items = await cards(page.items, locale);
    return json({ items: items.map((item, index) => ({ ...item, rank: first + index })) } satisfies ProductCardsResponse);
  }
  if (list === "new" || list === "new-page") {
    const { weekStart, asOf } = completedWindows(new Date());
    const key = ["new-repositories", weekStart, asOf, NEW_THIS_WEEK_MIN_STARS];
    if (list === "new") {
      const rows = await publicRead("list", [...key, 5, 0], () => getNewThisWeek(5, weekStart, asOf));
      return json({ items: await cards(rows, locale) } satisfies ProductCardsResponse);
    }
    const query = Object.fromEntries(params.entries());
    if (publicPaginationBlocked({ ...query, new: "1" }, "home")) return json({ error: "page_out_of_range" }, 400);
    const requestedPage = /^[1-9][0-9]{0,6}$/.test(params.get("page") ?? "") ? Number(params.get("page")) : 1;
    const total = await publicRead("count", key, () => countNewThisWeek(weekStart, asOf));
    const pages = Math.max(1, Math.ceil(total / NEW_PAGE_SIZE));
    const page = requestedPage <= pages ? requestedPage : 1;
    const offset = (page - 1) * NEW_PAGE_SIZE;
    const rows = await publicRead("list", [...key, NEW_PAGE_SIZE, offset], () => getNewThisWeek(NEW_PAGE_SIZE, weekStart, asOf, offset));
    return json({ items: await cards(rows, locale) } satisfies ProductCardsResponse);
  }
  if (list === "active") {
    const pulse = await getHomePulse(new Date());
    return json({ items: pulse.active.slice(0, 5).map(({ slug, category, stars, ogImage, releases }) => ({ slug, category, stars, ogImage, releases })) });
  }
  if (list === "home") {
    const offset = offsetParam(params.get("offset"), Number.MAX_SAFE_INTEGER);
    const limit = offsetParam(params.get("limit"), HOME_REST_MAX);
    if (offset === null || limit === null || limit === 0) return json({ error: "bad_range" }, 400);
    // 화면의 더 보기 한도(?shown=)와 같은 끝 — 그 밖은 화면도 그리지 않는다
    if (publicPaginationBlocked({ shown: String(offset + limit) }, "home")) return json({ error: "page_out_of_range" }, 400);
    const { sort, active, filters, verifiedTotal } = await homeListFromParams(params);
    let rows: ProductListItem[];
    if (params.get("section") === "unclaimed") {
      rows = await readUnclaimedList(sort, filters, { start: offset, count: limit });
    } else if (sort === "trending" && active) {
      // 순위 목록은 화면처럼 검증된 수만큼 한 번에 읽고 자른다
      rows = (await readHomeList(sort, active, filters, verifiedTotal, 0)).slice(offset, offset + limit) as ProductListItem[];
    } else {
      rows = await readHomeList(sort, active, filters, limit, offset) as ProductListItem[];
    }
    return json({ items: await cards(rows, locale) } satisfies ProductCardsResponse);
  }
  return json({ error: "unknown_list" }, 400);
});
