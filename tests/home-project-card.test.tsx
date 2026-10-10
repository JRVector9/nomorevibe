import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProjectCard } from "@/components/home/ProjectCard";
import type { HomeCardProduct } from "@/components/home/types";

const baseProduct: HomeCardProduct = {
  slug: "found-app",
  name: "Found App",
  tagline: "공개 저장소에서 찾은 제품",
  category: "Dev",
  builder: "Claude Code",
  builderClaim: "guessed",
  ogImage: null,
  makerName: null,
  repoUrl: null,
  unclaimed: true,
};

function render(product: HomeCardProduct) {
  return renderToStaticMarkup(createElement(ProjectCard, {
    product,
    saved: false,
    onToggleSave: vi.fn(),
    browseState: { sort: "recent" },
  }));
}

describe("home project card builder evidence", () => {
  it("does not expose a crawler guess", () => {
    expect(render(baseProduct)).not.toContain("Claude Code");
  });

  it("shows a maker-reported builder", () => {
    expect(render({ ...baseProduct, builderClaim: "reported", unclaimed: false }))
      .toContain("Claude Code");
  });

  it("links an unclaimed project's creator label to the GitHub repository owner", () => {
    const html = render({
      ...baseProduct,
      repoUrl: "https://github.com/AgentWorkforce/relay",
    });
    expect(html).toContain('href="https://github.com/AgentWorkforce"');
    expect(html).toContain("@AgentWorkforce");
    expect(html).toContain("GitHub 저장소 소유자");
  });

  it("renders an icon tile instead of a cover and no internal status badge", () => {
    const html = render(baseProduct);
    expect(html).toContain('class="project-tile tile-');
    expect(html).not.toContain("미클레임");
    expect(html).not.toContain("tiny-tag");
  });

  it("marks installable projects on the tile", () => {
    expect(render({ ...baseProduct, accessMode: "installable" })).toContain("직접 설치");
  });

  // 커버 배지(2026-10-10 시안 안 C) — 1·2·3단계 어느 것이든 'AI' 하나, 단계는 보이지 않는다(2026-10-11 운영자 결정)
  it.each([1, 2, 3])("puts one 'AI' badge on the cover for AI level %i", (aiLevel) => {
    const html = render({ ...baseProduct, aiLevel });
    expect(html).toContain('<span class="tile-flag tile-flag-ai">AI</span>');
    expect(html).not.toContain("단계");
  });

  it("has no AI badge without an AI level, and keeps it beside the installable badge", () => {
    expect(render({ ...baseProduct, aiLevel: null })).not.toContain("tile-flag-ai");
    expect(render(baseProduct)).not.toContain("tile-flag-ai");
    const both = render({ ...baseProduct, accessMode: "installable", aiLevel: 2 });
    expect(both).toContain(">직접 설치</span>");
    expect(both).toContain(">AI</span>");
  });
});
