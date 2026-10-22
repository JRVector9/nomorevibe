import { ANALYTICS_EVENT_CATALOG, isAnalyticsEventName, type AnalyticsEventName, type AnalyticsPageType, type AnalyticsSurface } from "@/lib/analytics/events";
import { pageType } from "@/lib/analytics/routes";
import { stripLocale } from "@/lib/i18n/routing";

/**
 * 클릭 하나 → 보낼 이벤트(2026-10-22). 런타임이 문서에 단 클릭 듣개 하나가 이것을 부른다 — 표시 규칙은 lib/analytics/attrs.ts.
 *
 * 누른 곳에서 위로 올라가며 먼저 만나는 것으로 정한다.
 * 1. data-track 이 달린 요소 → 그 이벤트
 * 2. 링크(a[href])
 *    - data-track-nav 안 → nav_click
 *    - data-track-filter 안 → filter_change
 *    - /go/<slug> → outbound_click(종류는 data-track-kind, 없으면 site)
 *    - /p/<slug> → select_item(목록·위치는 둘레에서)
 *    - /install.sh·/skill.md → skill_script_view
 *    - github.com → github_click(제품을 알 때만), HN·X·Bluesky·Reddit → social_outbound_click
 * 3. 그 밖(이름 없는 단추 등)은 보내지 않는다.
 *
 * 실제 DOM 이 아니어도 돌게(시험의 가짜 나무) 요소에서 쓰는 것은 tagName·getAttribute·parentElement·querySelectorAll 뿐이다.
 */

export type TrackElement = {
  tagName: string;
  getAttribute(name: string): string | null;
  parentElement: TrackElement | null;
  querySelectorAll?(selector: string): ArrayLike<TrackElement>;
};

export type ClickContext = { origin: string; pathname: string; search: string };
export type ClickEvent = { name: AnalyticsEventName; params: Record<string, unknown> };

const SURFACE_BY_PAGE: Record<AnalyticsPageType, AnalyticsSurface> = {
  home: "home", browse: "browse", search: "search", product: "product", product_settings: "product", talk: "talk",
  popular: "popular", rising: "rising", rankings: "rankings", launch: "launch", policy: "policy", me: "me", login: "login",
  feedback: "feedback", not_found: "other", other: "other",
};

const SOCIAL_HOSTS: ReadonlyArray<[RegExp, "hn" | "x" | "bluesky" | "reddit"]> = [
  [/(^|\.)news\.ycombinator\.com$/, "hn"],
  [/(^|\.)(x|twitter)\.com$/, "x"],
  [/(^|\.)bsky\.app$/, "bluesky"],
  [/(^|\.)reddit\.com$/, "reddit"],
];

function closestWith(start: TrackElement | null, attribute: string): TrackElement | null {
  for (let element = start; element; element = element.parentElement) {
    if (element.getAttribute(attribute) !== null) return element;
  }
  return null;
}

/** 목록·이름·위치에 쓰는 낱말 — 소문자, 영숫자와 _ 만 */
function token(value: string, max = 40): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, max);
}

function pageTypeOf(context: ClickContext): AnalyticsPageType {
  return pageType(context.pathname, context.search);
}

/** 가장 가까운 data-track-surface, 없으면 화면 갈래 */
export function surfaceFor(element: TrackElement | null, context: ClickContext): AnalyticsSurface {
  const value = closestWith(element, "data-track-surface")?.getAttribute("data-track-surface");
  if (value && (ANALYTICS_EVENT_CATALOG.nav_click.params.surface.values ?? []).includes(value)) return value as AnalyticsSurface;
  return SURFACE_BY_PAGE[pageTypeOf(context)];
}

/** 상세 화면 주소의 slug, 아니면 가장 가까운 data-track-product */
function productSlugFor(element: TrackElement, context: ClickContext): string | null {
  const marked = closestWith(element, "data-track-product")?.getAttribute("data-track-product");
  if (marked) return marked;
  if (pageTypeOf(context) !== "product") return null;
  const match = /^\/p\/([^/]+)/.exec(stripLocale(context.pathname));
  return match ? decodeURIComponent(match[1]) : null;
}

function productLinkSlug(href: string | null, context: ClickContext): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, `${context.origin}${context.pathname}`);
    if (url.origin !== context.origin) return null;
    const match = /^\/p\/([^/]+)\/?$/.exec(stripLocale(url.pathname));
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function explicitEvent(element: TrackElement, name: string, context: ClickContext): ClickEvent[] {
  if (!isAnalyticsEventName(name)) return [];
  let params: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(element.getAttribute("data-track-params") ?? "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) params = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  if ("surface" in ANALYTICS_EVENT_CATALOG[name].params && params.surface === undefined) params = { ...params, surface: surfaceFor(element, context) };
  return [{ name, params }];
}

/** 메뉴 항목 이름 — data-track-target, 없으면 주소의 첫 마디(/ 는 home, ?metric 은 metrics, #이 있으면 붙인다) */
function navTarget(anchor: TrackElement, url: URL): string {
  const marked = anchor.getAttribute("data-track-target");
  if (marked) return token(marked);
  const path = stripLocale(url.pathname);
  const first = path.split("/")[1] ?? "";
  const base = !first ? (url.searchParams.has("metric") ? "metrics" : "home")
    : first === "c" ? "category" : first === "p" ? "product" : first;
  const hash = url.hash.slice(1);
  return token(hash ? `${base}_${hash}` : base);
}

/**
 * select_item 의 목록 — 위에 data-track-list 가 있으면 그것(가장 가까운 것), 없으면 가장 가까운 id·aria-labelledby.
 * 이름은 화면 갈래를 앞에 붙인다(home_rising, search_project_grid, product_related …).
 */
function listFor(anchor: TrackElement, context: ClickContext): { id: string; name: string; container: TrackElement | null } {
  const page = pageTypeOf(context);
  const explicit = closestWith(anchor.parentElement, "data-track-list");
  let container: TrackElement | null = explicit;
  let named = explicit?.getAttribute("data-track-list") ?? null;
  for (let element = anchor.parentElement; !explicit && element; element = element.parentElement) {
    const implicit = element.getAttribute("id") ?? element.getAttribute("aria-labelledby")?.replace(/-title$/, "") ?? null;
    if (implicit && implicit !== "main" && token(implicit)) {
      container = element;
      named = implicit;
      break;
    }
  }
  const name = named ? token(named) : "";
  if (!container || !name) return { id: page, name: page, container: null };
  return { id: `${page}_${name}`.slice(0, 100), name: token(container.getAttribute("data-track-list-name") ?? name, 100), container };
}

/** 링크가 지금 주소에서 바꾸는 첫 질의 열쇠(쪽 번호는 뺀다) — 없으면 null */
function changedQueryKey(url: URL, context: ClickContext): string | null {
  const current = new URLSearchParams(context.search.startsWith("?") ? context.search.slice(1) : context.search);
  const keys = new Set([...url.searchParams.keys(), ...current.keys()]);
  for (const key of keys) {
    if (key === "page") continue;
    if (url.searchParams.get(key) !== current.get(key)) return key;
  }
  return null;
}

/** 목록 안 몇 번째 제품인가(0부터) — 같은 제품을 가리키는 링크 여럿(그림·이름)은 하나로 센다 */
function indexIn(container: TrackElement | null, slug: string, context: ClickContext): number | null {
  if (!container?.querySelectorAll) return null;
  const order: string[] = [];
  const anchors = container.querySelectorAll("a[href]");
  for (let i = 0; i < anchors.length; i += 1) {
    const found = productLinkSlug(anchors[i].getAttribute("href"), context);
    if (found && !order.includes(found)) order.push(found);
  }
  const index = order.indexOf(slug);
  return index < 0 ? null : index;
}

function anchorEvents(anchor: TrackElement, context: ClickContext): ClickEvent[] {
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return [];
  let url: URL;
  try { url = new URL(href, `${context.origin}${context.pathname}`); } catch { return []; }
  const surface = surfaceFor(anchor, context);

  if (url.origin === context.origin) {
    const nav = closestWith(anchor, "data-track-nav");
    if (nav) {
      const navSurface = nav.getAttribute("data-track-nav") || "other";
      return [{ name: "nav_click", params: { target: navTarget(anchor, url), surface: navSurface } }];
    }
    const filter = closestWith(anchor, "data-track-filter");
    if (filter) {
      const named = filter.getAttribute("data-track-filter") ?? "";
      // 이름이 비었으면 지금 주소와 링크 주소의 질의에서 바뀐 열쇠를 찾는다(한 줄에 여러 거르기가 섞인 칩)
      const key = named || changedQueryKey(url, context);
      if (!key) return [];
      const value = anchor.getAttribute("data-track-value") ?? url.searchParams.get(key) ?? (named ? "all" : "none");
      return [{ name: "filter_change", params: { filter_name: token(key), filter_value: token(value, 100) || "all", surface } }];
    }
    const path = stripLocale(url.pathname);
    const go = /^\/go\/([^/]+)\/?$/.exec(path);
    if (go) {
      const kind = anchor.getAttribute("data-track-kind") === "repo" ? "repo" : "site";
      return [{ name: "outbound_click", params: { link_kind: kind, product_slug: decodeURIComponent(go[1]), surface } }];
    }
    const slug = productLinkSlug(href, context);
    if (slug) {
      const list = listFor(anchor, context);
      const marked = anchor.getAttribute("data-track-index");
      const index = marked !== null && /^\d+$/.test(marked) ? Number(marked) : indexIn(list.container, slug, context);
      return [{ name: "select_item", params: { item_list_id: list.id, item_list_name: list.name, ...(index === null ? {} : { index }), item_id: slug } }];
    }
    if (path === "/install.sh") return [{ name: "skill_script_view", params: { script: "install_sh", surface } }];
    if (path === "/skill.md") return [{ name: "skill_script_view", params: { script: "skill_md", surface } }];
    return [];
  }

  const host = url.hostname.toLowerCase();
  if (host === "github.com" || host === "www.github.com") {
    const productSlug = productSlugFor(anchor, context);
    return productSlug ? [{ name: "github_click", params: { product_slug: productSlug, surface } }] : [];
  }
  const social = SOCIAL_HOSTS.find(([pattern]) => pattern.test(host));
  if (social) {
    const productSlug = productSlugFor(anchor, context);
    return [{ name: "social_outbound_click", params: { source: social[1], surface, ...(productSlug ? { product_slug: productSlug } : {}) } }];
  }
  return [];
}

/** 누른 요소에서 보낼 이벤트들(대개 하나, 없으면 빈 배열) */
export function classifyClick(target: TrackElement | null, context: ClickContext): ClickEvent[] {
  try {
    if (closestWith(target, "data-track-ignore")) return [];
    for (let element = target; element; element = element.parentElement) {
      const name = element.getAttribute("data-track");
      if (name) return explicitEvent(element, name, context);
      if (element.tagName.toUpperCase() === "A" && element.getAttribute("href") !== null) return anchorEvents(element, context);
    }
  } catch {
    // 분석은 클릭을 막지 않는다
  }
  return [];
}

/** 화면에 들어오면 보낼 이벤트(data-track-view) — 잘못 적힌 것은 버린다 */
export function viewEvent(element: TrackElement, context: ClickContext): ClickEvent | null {
  const name = element.getAttribute("data-track-view");
  if (!name) return null;
  return explicitEvent(element, name, context)[0] ?? null;
}
