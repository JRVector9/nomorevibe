import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { classifyClick, viewEvent, type ClickContext } from "@/lib/analytics/dom";
import { ANALYTICS_EVENT_CATALOG, isAnalyticsEventName } from "@/lib/analytics/events";
import { FORBIDDEN_PARAM_KEYS } from "@/lib/analytics/sanitize";
import type { ProductListItem } from "@/lib/domain/products/view";
import { common } from "@/messages/ko/common";
import { byAttribute, byHref, find, parseMarkup, trackedParams, type MarkupNode } from "./analytics-markup";

/**
 * 방문 분석 — 화면의 클릭 표시(2026-10-22). 실제 컴포넌트를 그린 HTML 을 작은 나무로 바꿔 "누르면 무엇을 보내나"를 본다.
 * 클릭 분류는 lib/analytics/dom.ts, 표시 규칙은 lib/analytics/attrs.ts.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

const { CompactRow } = await import("@/components/home/CompactRow");
const { SiteFooter } = await import("@/components/home/SiteFooter");
const { SaveButton } = await import("@/components/product-detail/SaveButton");
const { CopyCommand } = await import("@/app/(public)/[locale]/(content)/launch/CopyCommand");
const { BrowseFilters } = await import("@/components/BrowseFilters");
const { UnclaimedOwnerContact } = await import("@/components/product-detail/UnclaimedOwnerContact");
const { default: LaunchPage } = await import("@/app/(public)/[locale]/(content)/launch/page");
const { trackAttrs } = await import("@/lib/analytics/attrs");
const { followEvents } = await import("@/components/me/FollowButton");
const { triedEvents } = await import("@/components/feedback/try-events");

const ORIGIN = "https://nomorevibe.com";
const at = (pathname: string, search = ""): ClickContext => ({ origin: ORIGIN, pathname, search });
const tree = (element: React.ReactElement) => parseMarkup(renderToStaticMarkup(element));
const click = (node: MarkupNode, context: ClickContext) => classifyClick(node, context);

const item = (slug: string): ProductListItem => ({
  slug, name: slug, tagline: `${slug} does things`, taglineSource: "maker", category: "Games",
  builder: null, builderClaim: "guessed", stack: [], ogImage: null, makerName: null,
  repoUrl: `https://github.com/acme/${slug}`, listedAt: new Date("2026-10-02T00:00:00Z"), status: "seeded",
  unclaimed: true, stars: 990, starsAt: new Date("2026-10-02T00:00:00Z"), starsPrevious: 1,
  starsPreviousAt: new Date("2026-10-01T00:00:00Z"),
});

describe("목록의 제품 카드 → select_item", () => {
  it("홈 '지금 뜨는' 줄: 목록은 구획 id, 위치는 몇 번째 제품인지(같은 제품의 링크 여럿은 하나)", () => {
    const root = tree(createElement(CompactRow, { id: "rising", title: "지금 뜨는", items: [item("alpha"), item("beta"), item("gamma")], trailing: "category" }));
    const links = root.querySelectorAll("a[href]").filter((node) => node.getAttribute("href") === "/p/gamma");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(click(link, at("/"))).toEqual([{ name: "select_item", params: { item_list_id: "home_rising", item_list_name: "rising", index: 2, item_id: "gamma" } }]);
    }
    // 같은 줄을 언어 주소에서
    expect(click(links[0], at("/en"))[0].params).toMatchObject({ item_list_id: "home_rising", item_id: "gamma" });
  });

  it("data-track-list 가 가까운 id 보다 앞선다, 목록이 없으면 화면 갈래", () => {
    const root = parseMarkup(`<section data-track-list="unclaimed" data-track-list-name="Unclaimed list"><div id="project-grid"><a href="/p/one">1</a><a href="/en/p/two">2</a></div></section><a href="/p/three">3</a>`);
    expect(click(find(root, byHref("/en/p/two")), at("/", "?q=pdf"))).toEqual([{ name: "select_item",
      params: { item_list_id: "search_unclaimed", item_list_name: "unclaimed_list", index: 1, item_id: "two" } }]);
    expect(click(find(root, byHref("/p/three")), at("/c/dev"))).toEqual([{ name: "select_item", params: { item_list_id: "browse", item_list_name: "browse", item_id: "three" } }]);
  });

  it("상세의 GitHub 설정·공유 카드 같은 하위 주소는 제품 선택이 아니다", () => {
    const root = parseMarkup(`<section id="x"><a href="/p/one/github">s</a><a href="/p/one/share-card.png">c</a></section>`);
    expect(click(find(root, byHref("/p/one/github")), at("/p/one"))).toEqual([]);
    expect(click(find(root, byHref("/p/one/share-card.png")), at("/p/one"))).toEqual([]);
  });
});

describe("메뉴 → nav_click", () => {
  it("푸터 링크는 주소로 이름을 짓는다(?metric → metrics, #listing 은 붙인다)", () => {
    const root = tree(<SiteFooter locale="ko" messages={common}>{null}</SiteFooter>);
    expect(click(find(root, byHref("/?metric=all")), at("/talk"))).toEqual([{ name: "nav_click", params: { target: "metrics", surface: "footer" } }]);
    expect(click(find(root, byHref("/launch")), at("/talk"))).toEqual([{ name: "nav_click", params: { target: "launch", surface: "footer" } }]);
    expect(click(find(root, byHref("/policy#listing")), at("/talk"))).toEqual([{ name: "nav_click", params: { target: "policy_listing", surface: "footer" } }]);
  });

  it("머리 메뉴의 /#projects 는 home_projects, 명시한 이름이 있으면 그것", () => {
    const root = parseMarkup(`<header><a href="/" ${attrs(trackAttrs("nav_click", { target: "logo", surface: "header" }))}>n</a><nav data-track-nav="header"><a href="/rising">r</a><a href="/#projects">p</a><a href="/c/dev">c</a></nav></header>`);
    expect(click(find(root, byHref("/")), at("/p/x"))).toEqual([{ name: "nav_click", params: { target: "logo", surface: "header" } }]);
    expect(click(find(root, byHref("/rising")), at("/p/x"))[0].params).toEqual({ target: "rising", surface: "header" });
    expect(click(find(root, byHref("/#projects")), at("/p/x"))[0].params).toEqual({ target: "home_projects", surface: "header" });
    expect(click(find(root, byHref("/c/dev")), at("/p/x"))[0].params).toEqual({ target: "category", surface: "header" });
  });
});

describe("제품 상세", () => {
  it("저장 단추: 누르기 전 상태로 save(눌러 저장) — surface 는 화면에서", () => {
    const root = tree(<SaveButton slug="foo" name="Foo" />);
    expect(click(find(root, (node) => node.tagName === "BUTTON"), at("/p/foo"))).toEqual([{ name: "product_save", params: { product_slug: "foo", action: "save", surface: "product" } }]);
  });

  it("제품 방문하기·저장소 열기(/go) → outbound_click(link_kind 는 data-track-kind)", () => {
    const root = parseMarkup(`<div><a href="/go/foo" data-track-kind="repo">r</a><a href="/go/foo" data-track-kind="site" class="site">s</a><a href="/go/bar">b</a></div>`);
    expect(click(root.querySelectorAll("a[href]")[0], at("/p/foo"))).toEqual([{ name: "outbound_click", params: { link_kind: "repo", product_slug: "foo", surface: "product" } }]);
    expect(click(root.querySelectorAll("a[href]")[1], at("/en/p/foo"))[0].params).toEqual({ link_kind: "site", product_slug: "foo", surface: "product" });
    expect(click(root.querySelectorAll("a[href]")[2], at("/"))[0].params).toEqual({ link_kind: "site", product_slug: "bar", surface: "home" });
  });

  it("GitHub 직접 링크 → github_click(상세면 주소의 slug, 아니면 data-track-product 가 있을 때만)", () => {
    const root = parseMarkup(`<div><a href="https://github.com/acme/foo">g</a><div data-track-product="bar"><a href="https://github.com/acme/bar?tab=readme">g2</a></div></div>`);
    const [direct, marked] = root.querySelectorAll("a[href]");
    expect(click(direct, at("/p/foo"))).toEqual([{ name: "github_click", params: { product_slug: "foo", surface: "product" } }]);
    expect(click(direct, at("/"))).toEqual([]);
    expect(click(marked, at("/talk"))).toEqual([{ name: "github_click", params: { product_slug: "bar", surface: "talk" } }]);
  });

  it("운영자 상자의 '1분 만에 확인하기' → claim_start(verify)", () => {
    const root = tree(<UnclaimedOwnerContact repoUrl="https://github.com/acme/foo" slug="foo" />);
    expect(click(find(root, byHref("/launch#verify")), at("/p/foo"))).toEqual([{ name: "claim_start", params: { product_slug: "foo", step: "verify" } }]);
  });

  it("팔로: 제품은 follow_change, 메이커·분야는 열쇠 없이 종류만", () => {
    expect(followEvents("product", "foo", true, "hero")).toEqual([{ name: "follow_change", params: { product_slug: "foo", action: "follow", surface: "product" } }]);
    expect(followEvents("product", "foo", false, "row")).toEqual([{ name: "follow_change", params: { product_slug: "foo", action: "unfollow", surface: "me" } }]);
    expect(followEvents("maker", "octocat", true, "inline")).toEqual([{ name: "select_content", params: { content_type: "follow", content_id: "maker" } }]);
    expect(JSON.stringify(followEvents("maker", "octocat", true, "inline"))).not.toContain("octocat");
  });

  it("써봤어요: 처음 add, 바꾸면 update, 지우면 remove — 태그는 코드, 한 줄은 내용 없이 'comment'", () => {
    expect(triedEvents("foo", null, { verdict: "good", tags: [], comment: null })).toEqual([
      { name: "product_tried", params: { product_slug: "foo", action: "add", verdict: "good" } }]);
    const events = triedEvents("foo", { verdict: "good", tags: ["fast" as never], comment: null }, { verdict: "meh", tags: ["buggy" as never], comment: "느려요 alice@example.com" });
    expect(events).toEqual([
      { name: "product_tried", params: { product_slug: "foo", action: "update", verdict: "meh" } },
      { name: "reaction_change", params: { product_slug: "foo", reaction_kind: "buggy", action: "add" } },
      { name: "reaction_change", params: { product_slug: "foo", reaction_kind: "fast", action: "remove" } },
      { name: "reaction_change", params: { product_slug: "foo", reaction_kind: "comment", action: "add" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("alice");
    expect(triedEvents("foo", { verdict: "bad", tags: [], comment: null }, null)).toEqual([{ name: "product_tried", params: { product_slug: "foo", action: "remove" } }]);
    expect(triedEvents("foo", null, null)).toEqual([]);
  });
});

describe("검색·거르기", () => {
  it("정렬 탭·분야 칩 → filter_change, 초기화 → reset", () => {
    const root = tree(<BrowseFilters state={{ sort: "ai", category: "Games", query: "pdf" }} counts={{ Games: 3 }} categoryOrderCounts={{ Games: 3, Dev: 2 }} total={5} resultCount={3} />);
    const recent = find(root, byAttribute("data-track-value", "recent"));
    expect(click(recent, at("/", "?q=pdf"))).toEqual([{ name: "filter_change", params: { filter_name: "sort", filter_value: "recent", surface: "search" } }]);
    const games = find(root, byAttribute("data-track-value", "all"));
    expect(click(games, at("/c/games"))[0]).toMatchObject({ name: "filter_change", params: { filter_name: "category", filter_value: "all", surface: "browse" } });
    const reset = find(root, byAttribute("class", "clear-filters show"));
    expect(click(reset, at("/", "?q=pdf"))).toEqual([{ name: "filter_change", params: { filter_name: "reset", filter_value: "all", surface: "search" } }]);
  });

  it("이름 없는 거르기 줄은 지금 주소와 링크의 질의에서 바뀐 열쇠를 찾는다(인기 화면의 AI·개인 칩)", () => {
    const root = parseMarkup(`<nav data-track-filter=""><a href="/popular?tier=rising&amp;ai=made">ai</a><a href="/popular?tier=rising&amp;ai=made&amp;personal=1">p</a><a href="/popular?tier=rising">off</a></nav><nav data-track-filter="tier"><a href="/popular?tier=noticed&amp;ai=made">t</a></nav>`);
    const [ai, personal, off, tier] = root.querySelectorAll("a[href]");
    expect(click(ai, at("/popular", "?tier=rising"))[0].params).toEqual({ filter_name: "ai", filter_value: "made", surface: "popular" });
    expect(click(personal, at("/popular", "?tier=rising&ai=made"))[0].params).toEqual({ filter_name: "personal", filter_value: "1", surface: "popular" });
    expect(click(off, at("/popular", "?tier=rising&ai=made"))[0].params).toEqual({ filter_name: "ai", filter_value: "none", surface: "popular" });
    expect(click(tier, at("/popular", "?tier=rising&ai=made"))[0].params).toEqual({ filter_name: "tier", filter_value: "noticed", surface: "popular" });
    // 바뀌는 것이 없으면(지금 화면 그대로) 보내지 않는다
    expect(click(ai, at("/popular", "?tier=rising&ai=made"))).toEqual([]);
  });
});

describe("/launch — 스킬 설치 흐름", () => {
  it("설치 명령 복사·등록/확인 명령 복사·스크립트 보기·단계 보기", async () => {
    const root = parseMarkup(renderToStaticMarkup(await LaunchPage()));
    const context = at("/launch");
    const copies = root.querySelectorAll("button").filter((node) => node.getAttribute("data-track"));
    expect(copies.map((node) => click(node, context)[0])).toEqual([
      { name: "skill_install_copy", params: { command: "install_sh", surface: "launch" } },
      { name: "launch_command_copy", params: { command_kind: "launch", surface: "launch" } },
      { name: "skill_install_copy", params: { command: "install_sh_verify", surface: "launch" } },
      { name: "launch_command_copy", params: { command_kind: "launch", surface: "launch" } },
      { name: "launch_command_copy", params: { command_kind: "verify", surface: "launch" } },
    ]);
    expect(click(find(root, (node) => node.tagName === "SUMMARY" && node.getAttribute("data-track") !== null), context))
      .toEqual([{ name: "skill_script_view", params: { script: "install_sh", surface: "launch" } }]);
    expect(click(find(root, byHref("/install.sh")), context)).toEqual([{ name: "skill_script_view", params: { script: "install_sh", surface: "launch" } }]);
    const steps = root.querySelectorAll("[data-track-view]").map((node) => viewEvent(node, context));
    expect(steps).toEqual(["install", "how_it_works", "verify", "no_cli"].map((step, index) => ({ name: "launch_step_view", params: { step, step_index: index + 1 } })));
  });

  it("CopyCommand 는 표시가 없으면 아무것도 보내지 않는다", () => {
    const root = tree(<CopyCommand command="npx x" label="x" />);
    expect(click(find(root, (node) => node.tagName === "BUTTON"), at("/launch"))).toEqual([]);
  });
});

describe("바깥 원문·기타", () => {
  it("화제 원문(HN·X·Bluesky) → social_outbound_click, 제품은 data-track-product", () => {
    const root = parseMarkup(`<div data-track-product="foo"><a href="https://news.ycombinator.com/item?id=1">h</a><a href="https://x.com/i/web/status/2">x</a><a href="https://bsky.app/profile/a/post/b">b</a></div><a href="https://www.reddit.com/r/x">r</a>`);
    const [hn, x, bsky, reddit] = root.querySelectorAll("a[href]");
    expect(click(hn, at("/talk"))).toEqual([{ name: "social_outbound_click", params: { source: "hn", surface: "talk", product_slug: "foo" } }]);
    expect(click(x, at("/"))[0].params).toMatchObject({ source: "x", surface: "home" });
    expect(click(bsky, at("/p/foo"))[0].params).toMatchObject({ source: "bluesky", surface: "product", product_slug: "foo" });
    expect(click(reddit, at("/talk"))).toEqual([{ name: "social_outbound_click", params: { source: "reddit", surface: "talk" } }]);
  });

  it("무시·잘못된 표시·mailto·바깥 일반 링크·이름 없는 단추는 보내지 않는다", () => {
    const root = parseMarkup(`<div><a href="mailto:contact@nomorevibe.com">m</a><a href="https://example.com/x">e</a><button>b</button><button data-track="nope" data-track-params="{}">n</button><button data-track="nav_click" data-track-params="{bad">j</button><div data-track-ignore=""><a href="/p/x">p</a></div><a href="#verify">h</a></div>`);
    for (const node of root.querySelectorAll("")) {
      if (node.tagName === "A" || node.tagName === "BUTTON") expect(click(node, at("/"))).toEqual([]);
    }
  });

  it("안쪽 요소(아이콘)를 눌러도 가장 가까운 표시를 찾는다", () => {
    const root = parseMarkup(`<section id="new"><a href="/p/foo"><span><i>icon</i></span></a></section>`);
    expect(click(find(root, (node) => node.tagName === "I"), at("/"))[0]).toMatchObject({ name: "select_item", params: { item_list_id: "home_new", item_id: "foo", index: 0 } });
  });
});

describe("금지 키 — 화면에 단 어떤 표시도 개인정보·자격 키를 싣지 않는다", () => {
  it("그린 화면들의 모든 data-track 매개변수가 목록에 있는 키이고 금지 키가 아니다", async () => {
    const roots = [
      parseMarkup(renderToStaticMarkup(await LaunchPage())),
      tree(<SaveButton slug="foo" name="Foo" />),
      tree(<UnclaimedOwnerContact repoUrl="https://github.com/acme/foo" slug="foo" />),
      tree(<BrowseFilters state={{ sort: "ai", category: "Games", query: "pdf" }} counts={{ Games: 3 }} categoryOrderCounts={{ Games: 3 }} total={5} resultCount={3} />),
      tree(<SiteFooter locale="ko" messages={common}>{null}</SiteFooter>),
    ];
    const all = roots.flatMap(trackedParams);
    expect(all.length).toBeGreaterThan(8);
    for (const { name, params } of all) {
      expect(isAnalyticsEventName(name), name).toBe(true);
      const allowed = Object.keys(ANALYTICS_EVENT_CATALOG[name as keyof typeof ANALYTICS_EVENT_CATALOG].params);
      for (const key of Object.keys(params)) {
        expect(allowed, `${name}.${key}`).toContain(key);
        expect(FORBIDDEN_PARAM_KEYS, `${name}.${key}`).not.toContain(key);
      }
    }
  });

  it("코드 속 track·trackAttrs 의 매개변수 키도 금지 키가 아니다", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const full = path.join(directory, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name)) files.push(full);
      }
    };
    walk("components");
    walk("app/(public)");
    const calls = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/\btrack(?:Attrs|ViewAttrs)?\(\s*"([a-z_]+)",\s*\{([^}]*)\}/g)]
      .map((match) => ({ file, name: match[1], keys: [...match[2].matchAll(/([a-z_]+)\s*:/g)].map((key) => key[1]) })));
    expect(calls.length).toBeGreaterThan(20);
    for (const call of calls) {
      expect(isAnalyticsEventName(call.name), `${call.file} ${call.name}`).toBe(true);
      for (const key of call.keys) expect(FORBIDDEN_PARAM_KEYS, `${call.file} ${call.name}.${key}`).not.toContain(key);
    }
  });
});

/** trackAttrs 결과를 HTML 속성 글로 */
function attrs(record: Record<string, string>): string {
  return Object.entries(record).map(([key, value]) => `${key}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`).join(" ");
}
