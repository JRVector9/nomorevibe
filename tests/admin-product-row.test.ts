import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/admin/actions", () => ({
  setProductBan: vi.fn(),
  markClaimInvite: vi.fn(),
}));
import { ProductRow, type AdminProduct } from "@/app/admin/products/ProductRow";

const base: AdminProduct = {
  slug: "found-app",
  name: "FoundApp",
  url: "https://found.test",
  status: "seeded",
  source: "crawler",
  unclaimed: true,
  listedAt: "2026. 8. 18.",
  inviteUrl: "https://github.com/someone/found-app/issues/new?title=x",
  invitedAt: null,
};

const render = (over: Partial<AdminProduct>) =>
  renderToStaticMarkup(createElement(ProductRow, { product: { ...base, ...over } }));

describe("admin product row — 클레임 초대", () => {
  it("주인이 없고 GitHub 레포가 있으면 초대 링크와 보냈음 버튼을 보여준다", () => {
    const html = render({});
    expect(html).toContain("초대 이슈 열기");
    expect(html).toContain('href="https://github.com/someone/found-app/issues/new?title=x"');
    expect(html).toContain("보냈음으로 표시");
  });

  it("이미 보냈으면 시각만 보여주고 버튼은 감춘다", () => {
    const html = render({ invitedAt: "2026. 8. 29." });
    expect(html).toContain("클레임 초대 보냄 · 2026. 8. 29.");
    expect(html).not.toContain("보냈음으로 표시");
  });

  it("GitHub 레포가 없으면 초대할 곳이 없다고 말한다", () => {
    const html = render({ inviteUrl: null });
    expect(html).toContain("초대할 곳이 없습니다");
    expect(html).not.toContain("초대 이슈 열기");
  });

  it("주인이 있는 제품에는 초대 UI가 없다", () => {
    const html = render({ status: "verified", source: "skill", unclaimed: false });
    expect(html).not.toContain("초대");
  });
});
