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
});
