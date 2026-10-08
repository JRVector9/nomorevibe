import { readFileSync } from "node:fs";
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
  publicOriginMissing: false,
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
    // 제출 전에 표시를 눌렀을 수 있으니 링크는 남는다
    expect(html).toContain("이슈 다시 열기");
  });

  it("GitHub 레포가 없으면 초대할 곳이 없다고 말한다", () => {
    const html = render({ inviteUrl: null });
    expect(html).toContain("초대할 곳이 없습니다");
    expect(html).not.toContain("초대 이슈 열기");
  });

  it("공개 주소가 없어 초대를 못 만들면 레포 탓으로 돌리지 않는다", () => {
    const html = render({ inviteUrl: null, publicOriginMissing: true });

    expect(html).toContain("NEXT_PUBLIC_SITE_URL");
    expect(html).not.toContain("GitHub 레포가 없어");
  });

  it("주인이 있는 제품에는 초대 UI가 없다", () => {
    const html = render({ status: "verified", source: "skill", unclaimed: false });
    expect(html).not.toContain("초대");
  });
});

describe("admin product row — 저장소 사라짐", () => {
  it("거르기에서 넘겨준 이용 방식·시작 줄을 이름 아래에 보여준다", () => {
    const html = render({ repoGone: "설치형 · 목록에서 가려짐 · 2026. 10. 5.부터 404" });
    expect(html).toContain("설치형 · 목록에서 가려짐 · 2026. 10. 5.부터 404");
    expect(render({})).not.toContain("목록에서 가려짐");
  });
});

describe("운영센터 → 제품 거르기 링크", () => {
  it("운영센터가 여는 거르기는 모두 제품 화면에 있는 이름이다", () => {
    const products = readFileSync("app/admin/products/page.tsx", "utf8");
    const block = products.slice(products.indexOf("const FILTERS = {"), products.indexOf("} as const satisfies"));
    const filters = new Set([...block.matchAll(/^\s+"?([^":\s/*][^":]*?)"?: \[/gm)].map((match) => match[1]));
    expect(filters).toContain("소개 확인 필요");
    expect(filters).toContain("저장소 사라짐");
    const status = readFileSync("app/admin/status/page.tsx", "utf8");
    // ?filter=intro 처럼 없는 이름이면 제품 화면이 조용히 '전체'로 떨어진다
    const linked = [...status.matchAll(/\/admin\/products\?filter=\$\{encodeURIComponent\("([^"]+)"\)\}|\/admin\/products\?filter=([^"`&$]+)/g)]
      .map((match) => match[1] ?? decodeURIComponent(match[2]));
    expect(linked.length).toBeGreaterThanOrEqual(2);
    for (const name of linked) expect(filters).toContain(name);
  });
});
