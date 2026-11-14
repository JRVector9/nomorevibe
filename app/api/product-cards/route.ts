import { NextResponse } from "next/server";
import { cardItem, type CardItem } from "@/components/cards/card-item";
import { getPopularGroups } from "@/lib/domain/products/popular";
import { publicRead } from "@/lib/domain/products/public-reads";
import { getStarGrowthPage } from "@/lib/domain/products/star-growth";
import { STAR_TIERS } from "@/lib/domain/products/stars";
import { completedWindows } from "@/lib/domain/products/home-pulse";
import { getNewThisWeek, NEW_THIS_WEEK_MIN_STARS } from "@/lib/domain/products/view";
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { withRoute } from "@/lib/http/handler";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/locales";
import { localizeProductList } from "@/lib/i18n/products";

const NO_STORE = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store" } as const;

/** 브라우저가 열 때 받는 카드 목록 — 홈 '많이 쓰이는' 다른 구간, 없는 주소의 '지금 뜨는' */
export type ProductCardsResponse = { items: (CardItem & { rank?: number })[] };

/**
 * 첫 화면에 보이지 않는 카드(2026-11-14 공개 HTML 줄이기) — 서버 HTML·RSC 데이터에 싣지 않고 누르거나 열 때 이 같은 출처 API 로 받는다.
 *  - list=popular&tier=<구간>&personal=1 : 홈 '많이 쓰이는 프로젝트'의 다른 구간 상위 3(홈 구간과 같은 읽기·같은 열쇠)
 *  - list=rising : 없는 주소 화면의 '지금 뜨는' 다섯(없는 주소 화면은 모든 공개 화면의 RSC 데이터에 404 경계로 실린다)
 *  - list=new : 홈 '이번 주 새로 나온' 다섯(첫 화면 아래 — 홈과 같은 읽기·같은 열쇠)
 * 공개 API 읽기 관문을 그대로 거친다. 카드가 그리는 칸만 돌려준다(card-item.ts).
 */
export const GET = withRoute("products.cards", async (req: Request) => {
  const refused = await guardPublicApiRead(req, "products.cards");
  if (refused) return refused;
  const params = new URL(req.url).searchParams;
  const requested = params.get("locale");
  const locale = requested && isLocale(requested) ? requested : DEFAULT_LOCALE;
  const list = params.get("list");
  if (list === "popular") {
    const tier = STAR_TIERS.find((item) => item.key === params.get("tier"));
    if (!tier) return NextResponse.json({ error: "unknown_tier" }, { status: 400, headers: NO_STORE });
    const personal = params.get("personal") === "1";
    const groups = await publicRead("list", ["popular-groups", personal], () => getPopularGroups(personal));
    const items = await localizeProductList(groups.find((group) => group.key === tier.key)?.items ?? [], locale);
    return NextResponse.json({ items: items.map((item, index) => ({ ...cardItem(item, locale), rank: index + 1 })) } satisfies ProductCardsResponse, { headers: NO_STORE });
  }
  if (list === "rising") {
    const page = await getStarGrowthPage({ limit: 5 });
    const items = await localizeProductList(page.items, locale);
    return NextResponse.json({ items: items.map((item) => cardItem(item, locale)) } satisfies ProductCardsResponse, { headers: NO_STORE });
  }
  if (list === "new") {
    const { weekStart, asOf } = completedWindows(new Date());
    const rows = await publicRead("list", ["new-repositories", weekStart, asOf, NEW_THIS_WEEK_MIN_STARS, 5, 0], () => getNewThisWeek(5, weekStart, asOf));
    const items = await localizeProductList(rows, locale);
    return NextResponse.json({ items: items.map((item) => cardItem(item, locale)) } satisfies ProductCardsResponse, { headers: NO_STORE });
  }
  return NextResponse.json({ error: "unknown_list" }, { status: 400, headers: NO_STORE });
});
