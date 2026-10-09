import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductTagline } from "@/components/ProductTagline";

const render = (props: Parameters<typeof ProductTagline>[0]) => renderToStaticMarkup(createElement(ProductTagline, props));

describe("ProductTagline — 한국어 소개를 먼저, 원문은 뒤에(UX-13)", () => {
  it("한국어가 없으면 원문과 AI 출처만 — 메이커 원문에는 출처를 붙이지 않는다", () => {
    expect(render({ tagline: "Edit videos locally", source: "maker", className: "t" }))
      .toBe('<p class="t" title="Edit videos locally">Edit videos locally</p>');
    expect(render({ tagline: "Edit videos locally", source: "ai_readme" })).toContain("AI가 요약 · README에서");
  });

  it("좁은 자리는 한국어 줄을 보이고 원문은 툴팁으로", () => {
    const html = render({ tagline: "Edit videos locally", taglineKo: "로컬에서 동영상 편집", source: "maker" });
    expect(html).toContain('title="원문: Edit videos locally"');
    expect(html).toContain(">로컬에서 동영상 편집</p>");
    expect(html).toContain("AI가 한국어로 요약");
    expect(html).not.toContain("<details");
  });

  it("상세는 '원문 보기' 토글 안에 원문을 둔다 — 원문이 AI 가 지은 것이면 무엇을 보고 지었는지도", () => {
    const html = render({ tagline: "Edit videos locally", taglineKo: "로컬에서 동영상 편집", source: "ai_page", original: "toggle" });
    expect(html).toMatch(/<details[^>]*><summary[^>]*>원문 보기<\/summary><p[^>]*>Edit videos locally<\/p><\/details>/);
    expect(html).toContain("AI가 한국어로 요약 · 페이지 글에서");
    expect(html).not.toContain("원문: ");
  });

  it("출처 줄을 끌 수 있고, 빈 한국어 줄은 없는 것으로 본다", () => {
    expect(render({ tagline: "A", taglineKo: "가나다라", source: "ai_both", showSource: false })).not.toContain("AI가");
    expect(render({ tagline: "Original", taglineKo: "  " })).toContain(">Original</p>");
  });
});
