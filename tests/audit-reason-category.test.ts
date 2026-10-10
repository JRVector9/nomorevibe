import { describe, expect, it } from "vitest";
import { AUDIT_REASON_KEYS, classifyAuditReason, groupAuditReasons, isAuditReasonCategory } from "@/lib/crawl/audit-reason-category";
import { banReasonLabel } from "@/app/admin/products/ban-reasons";

/** 감사 사유 갈래(2026-10-11) — 감사 #3 미처리 사유에서 옮긴 문장들 */
describe("감사 사유 갈래", () => {
  it.each([
    ["login", "The page at product.url is only a login form with email and password fields and no sign‑up, description, or visible functionality."],
    ["placeholder", "The page at https://sirreel-fleet.vercel.app only shows \"SirReel HQ Loading...\" which is a placeholder/loading page."],
    ["placeholder", "The page at https://nimiq-arena.vercel.app shows only an error message \"The deployment could not be found on Vercel. DEPLOYMENT_NOT_FOUND\"."],
    ["placeholder", "The page at https://hopscotch-compliance.vercel.app shows only the title \"Hopscotch Daily Checks\" with no clear indication of being a software product."],
    ["platform", "The URL is a NuGet package page, which is a package registry listing rather than the project's own homepage."],
    ["platform", "The URL is a Product Hunt launch page, which is a third‑party listing site, not the project's own homepage."],
    ["shop", "The URL https://chickimmiu.vercel.app is an e‑commerce storefront for a fashion brand with product listings, shopping cart, checkout."],
    ["content", "The URL https://zenn.dev/shimo4228/articles/daily-research-postmortem is an article/post describing a research pipeline."],
    ["content", "The URL https://help.getcalyx.app is a help/documentation site providing usage, settings, and policies for the Calyx macOS terminal app."],
    ["company", "The page is a company site offering EV charger installation, solar, and electrical services."],
    ["company", "The page https://lenne.tech is a company/service site describing custom software development services and consulting."],
    ["other", "The page https://surendranb.github.io/deepseek-vs-openclaw is a live data‑visualization dashboard comparing GitHub star counts."],
  ])("%s ← %s", (category, reason) => {
    expect(classifyAuditReason(reason)).toBe(category);
  });

  it("사유 끝의 '소프트웨어 목록(directory of software)'은 남의 플랫폼으로 세지 않는다", () => {
    const reason = "The page is an online store selling handcrafted perfumes and gifts. It does not belong in a directory of software or personal profiles.";
    expect(classifyAuditReason(reason)).toBe("shop");
    expect(classifyAuditReason("It is a consulting business site. Therefore it does not belong in a directory of software products.")).toBe("company");
  });

  it("'Book a call' 의 book 은 글·문서로 세지 않는다", () => {
    expect(classifyAuditReason("The page is a company marketing site offering services (e.g., \"Send a message\", \"Book a call\").")).toBe("company");
  });

  it("차례가 우선순위다 — 로그인 창만 있는 쇼핑몰은 로그인 화면만", () => {
    expect(classifyAuditReason("The page is an e-commerce admin that only shows a sign-in form.")).toBe("login");
  });

  it("사유가 없으면 기타, 모르는 값은 갈래가 아니다", () => {
    expect(classifyAuditReason(null)).toBe("other");
    expect(classifyAuditReason("")).toBe("other");
    expect(isAuditReasonCategory("shop")).toBe(true);
    expect(isAuditReasonCategory("constructor")).toBe(false);
  });

  it("갈래마다 항목을 모은다 — 빠지는 항목 없이", () => {
    const rows = [
      { id: 1, reason: "only a login screen" }, { id: 2, reason: "a blog post" }, { id: 3, reason: null }, { id: 4, reason: "a password-protected page" },
    ];
    const ids = groupAuditReasons(rows);
    expect(ids.login).toEqual([1, 4]);
    expect(ids.content).toEqual([2]);
    expect(ids.other).toEqual([3]);
    expect(AUDIT_REASON_KEYS.flatMap((key) => ids[key]).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe("감사로 내린 차단의 사유 이름", () => {
  it("'audit:갈래'는 '감사: 갈래 이름'으로, 모르는 갈래는 코드 그대로", () => {
    expect(banReasonLabel("audit:shop")).toBe("감사: 쇼핑몰·판매");
    expect(banReasonLabel("audit:nope")).toBe("감사: nope");
    expect(banReasonLabel("not_product")).toBe("제품 아님");
  });
});
