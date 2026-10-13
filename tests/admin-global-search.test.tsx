import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), search: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {} }) }));
vi.mock("@/lib/db", () => ({ db: {} }));

import { activityHref, candidateHref, searchTerm, type AdminSearchResult } from "@/lib/operations/admin-search";
import { CommandSearch, searchItems } from "@/app/(operator)/admin/components/CommandSearch";

/** 관리자 전역 검색(⌘K, 2026-10-08 UX 점검 ADM-05) */
describe("전역 검색 — 찾는 말과 가는 곳", () => {
  it("두 글자부터 찾고 100자까지 자른다", () => {
    expect(searchTerm("a")).toBeNull();
    expect(searchTerm("  ")).toBeNull();
    expect(searchTerm(" lc ")).toBe("lc");
    expect(searchTerm("가")).toBeNull();
    expect(searchTerm("가계")).toBe("가계");
    expect(searchTerm("x".repeat(150))).toHaveLength(100);
  });

  it("후보는 그 저장소로 거르고 그 줄을 고른 심사 큐로 — 거부·발행은 그 보기로", () => {
    expect(candidateHref({ id: 7, repo: "acme/tool", state: "needs_review" })).toBe("/admin/review?q=acme%2Ftool&focus=7#review-list");
    expect(candidateHref({ id: 8, repo: "acme/x", state: "rejected" })).toBe("/admin/review?state=rejected&q=acme%2Fx&focus=8#review-list");
    expect(candidateHref({ id: 9, repo: "acme/y", state: "published" })).toBe("/admin/review?state=published&q=acme%2Fy&focus=9#review-list");
    expect(activityHref("acme/tool")).toBe("/admin/activity?target=acme%2Ftool");
  });

  it("결과를 제품·후보·작업 로그 대상 차례의 한 목록으로, 빈 묶음은 뺀다", () => {
    const result: AdminSearchResult = {
      q: "lcu",
      products: [{ slug: "lcu", name: "LCU", url: "https://lcu.example", repoUrl: "https://github.com/amontlabs/lcu", status: "banned",
        href: "/admin/products/lcu", publicHref: "/p/lcu", logHref: "/admin/activity?target=lcu" }],
      candidates: [],
      targets: [{ target: "lcu", count: 3, lastAt: new Date("2026-10-11T00:00:00Z"), href: "/admin/activity?target=lcu" }],
    };
    const sections = searchItems(result);
    expect(sections.map((section) => section.group)).toEqual(["제품", "작업 로그 대상"]);
    expect(sections[0].items[0]).toMatchObject({ title: "LCU", detail: "amontlabs/lcu", badge: "차단됨", href: "/admin/products/lcu" });
    expect(sections[0].items[0].extra?.map((link) => link.label)).toEqual(["공개 페이지", "기록"]);
    expect(sections[1].items[0]).toMatchObject({ title: "lcu", detail: "3건" });
    expect(searchItems(null)).toEqual([]);
  });

  it("사이드바 단추와 검색 창(콤보박스·목록)을 그린다 — 창은 닫혀 있다", () => {
    const html = renderToStaticMarkup(createElement(CommandSearch));
    expect(html).toContain('aria-keyshortcuts="Meta+K Control+K"');
    expect(html).toContain(">찾기</span>");
    expect(html).toMatch(/<dialog[^>]*aria-label="관리자 전역 검색"/);
    expect(html).not.toMatch(/<dialog[^>]* open/);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain("2글자 이상 입력하면 찾습니다");
  });
});

describe("전역 검색 경로", () => {
  beforeEach(() => vi.clearAllMocks());
  it("관리자가 아니면 403 이고 검색하지 않는다", async () => {
    mocks.admin.mockResolvedValue(null);
    const { GET } = await import("@/app/(operator)/admin/search/route");
    const response = await GET(new Request("https://admin.test/admin/search?q=lcu"), {} as never);
    expect(response.status).toBe(403);
  });
});
