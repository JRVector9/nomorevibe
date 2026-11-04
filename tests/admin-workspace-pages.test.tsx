import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const fake = vi.hoisted(() => ({ admin: vi.fn(), redirect: vi.fn((url: string) => { throw new Error(`redirect:${url}`); }) }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: fake.admin }));
vi.mock("next/navigation", () => ({ redirect: fake.redirect }));
vi.mock("@/app/(operator)/admin/talk/page", () => ({ default: function Talk() { return null; } }));
vi.mock("@/app/(operator)/admin/news/page", () => ({ default: function News() { return null; } }));
vi.mock("@/app/(operator)/admin/ranking/page", () => ({ default: function Ranking() { return null; } }));
vi.mock("@/app/(operator)/admin/page", () => ({ default: function Collection() { return null; } }));
vi.mock("@/app/(operator)/admin/categories/page", () => ({ default: function Categories() { return null; } }));
vi.mock("@/app/(operator)/admin/evidence/page", () => ({ default: function Evidence() { return null; } }));
vi.mock("@/app/(operator)/admin/github-accounts/page", () => ({ default: function Accounts() { return null; } }));
vi.mock("@/app/(operator)/admin/github-integrations/page", () => ({ default: function Delivery() { return null; } }));
vi.mock("@/app/(operator)/admin/activity/page", () => ({ default: function Activity() { return null; } }));

import Content from "@/app/(operator)/admin/content/page";
import Settings from "@/app/(operator)/admin/settings/page";
import Talk from "@/app/(operator)/admin/talk/page";
import News from "@/app/(operator)/admin/news/page";
import Ranking from "@/app/(operator)/admin/ranking/page";
import Collection from "@/app/(operator)/admin/page";
import Categories from "@/app/(operator)/admin/categories/page";
import Evidence from "@/app/(operator)/admin/evidence/page";
import Accounts from "@/app/(operator)/admin/github-accounts/page";
import Delivery from "@/app/(operator)/admin/github-integrations/page";
import Activity from "@/app/(operator)/admin/activity/page";

type Query = Record<string, string | string[] | undefined>;
const props = (query: Query) => ({ searchParams: Promise.resolve(query) });
beforeEach(() => { vi.clearAllMocks(); fake.admin.mockResolvedValue({ login: "operator" }); });

describe("actual content workspace routing", () => {
  it("preserves social filters and uses existing pages for news and ranking", async () => {
    const query = { source: "x", state: "held", q: "actual" };
    const social = await Content(props(query));
    expect(social.type).toBe(Talk);
    expect(await social.props.searchParams).toEqual(query);
    const news = await Content(props({ tab: "news", state: "official", page: "2", q: ["bad"] }));
    expect(news.type).toBe(News);
    expect(await news.props.searchParams).toEqual({ state: "official", page: "2" });
    expect((await Content(props({ tab: "ranking" }))).type).toBe(Ranking);
  });
  it("requires authentication and treats invalid tab as default", async () => {
    expect((await Content(props({ tab: ["news", "ranking"] }))).type).toBe(Talk);
    fake.admin.mockResolvedValue(null);
    await expect(Content(props({}))).rejects.toThrow("redirect:/admin/login");
  });
});

describe("actual settings workspace routing", () => {
  it("uses the original collection reader and bounds history filters to scalar values", async () => {
    expect((await Settings(props({}))).type).toBe(Collection);
    const history = await Settings(props({ tab: "history", actor: "operator", before: "cursor", failed: ["1"], target: "product:42" }));
    expect(history.type).toBe(Activity);
    expect(await history.props.searchParams).toEqual({ group: undefined, actor: "operator", before: "cursor", failed: undefined, target: "product:42" });
  });
  it.each([
    ["evidence", undefined, Categories], ["evidence", "sources", Evidence],
    ["integrations", undefined, Accounts], ["integrations", "delivery", Delivery],
  ])("keeps both original %s subviews reachable (%s)", async (tab, view, component) => {
    const page = await Settings(props({ tab, view }));
    const children = page.props.children as ReactElement[];
    expect(children[1].type).toBe(component);
  });
  it("requires authentication before selecting a settings view", async () => {
    fake.admin.mockResolvedValue(null);
    await expect(Settings(props({ tab: "integrations" }))).rejects.toThrow("redirect:/admin/login");
  });
});
