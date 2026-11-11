import { describe, expect, it } from "vitest";
import { README_PREVIEW_CHARS, readmePreview } from "@/lib/domain/products/readme-preview";

const paragraph = (index: number, size = 400) => `Paragraph ${index} ${"word ".repeat(Math.ceil(size / 5))}`.slice(0, size);

describe("README preview", () => {
  it("keeps short and slightly long READMEs whole", () => {
    const short = "# Title\n\nShort body.\n";
    expect(readmePreview(short)).toEqual({ markdown: short, truncated: false });
    const almost = Array.from({ length: 18 }, (_, index) => paragraph(index)).join("\n\n");
    expect(almost.length).toBeGreaterThan(README_PREVIEW_CHARS);
    expect(readmePreview(almost).truncated).toBe(false);
  });

  it("cuts long READMEs at the last block boundary within the budget", () => {
    const blocks = Array.from({ length: 60 }, (_, index) => paragraph(index));
    const markdown = blocks.join("\n\n");
    const preview = readmePreview(markdown);
    expect(preview.truncated).toBe(true);
    // 예산은 블록 글자 수로 센다 — 블록 사이 빈 줄만큼은 넘을 수 있다
    expect(preview.markdown.length).toBeLessThanOrEqual(README_PREVIEW_CHARS + 2 * 60);
    expect(preview.markdown.length).toBeGreaterThan(README_PREVIEW_CHARS - 500);
    expect(markdown.startsWith(preview.markdown.trimEnd())).toBe(true);
    // 블록 한가운데에서 자르지 않는다
    expect(blocks).toContain(preview.markdown.trimEnd().split("\n\n").at(-1));
  });

  it("never cuts inside a fenced code block", () => {
    const code = ["```bash", ...Array.from({ length: 200 }, (_, index) => index % 10 === 0 ? "" : `echo line ${index}`), "```"].join("\n");
    const markdown = `${paragraph(0, 3000)}\n\n${code}\n\n${Array.from({ length: 20 }, (_, index) => paragraph(index + 1)).join("\n\n")}`;
    const preview = readmePreview(markdown);
    expect(preview.truncated).toBe(true);
    const fences = preview.markdown.match(/^```/gm) ?? [];
    expect(fences.length % 2).toBe(0);
  });

  it("keeps reference definitions from the dropped tail so kept links still resolve", () => {
    const markdown = [`See [the docs][docs] and [site].`, ...Array.from({ length: 40 }, (_, index) => paragraph(index)),
      "[docs]: https://example.com/docs", "[site]: https://example.com", "```", "[fake]: https://inside-code.example", "```"].join("\n\n");
    const preview = readmePreview(markdown);
    expect(preview.truncated).toBe(true);
    expect(preview.markdown).toContain("[docs]: https://example.com/docs");
    expect(preview.markdown).toContain("[site]: https://example.com");
    expect(preview.markdown).not.toContain("inside-code");
  });

  it("does not end the preview on a heading whose body was cut", () => {
    const sections = Array.from({ length: 30 }, (_, index) => `## Section ${index}\n\n${paragraph(index, 500)}`);
    const preview = readmePreview(sections.join("\n\n"));
    expect(preview.truncated).toBe(true);
    const last = preview.markdown.trimEnd().split("\n\n").at(-1)!;
    expect(last.startsWith("##")).toBe(false);
    // 제목 뒤가 그리지 않는 HTML 블록뿐이어도 제목만 남는다
    const htmlAfter = Array.from({ length: 30 }, (_, index) => `## Section ${index}\n\n<details>\n<summary>more</summary>\n\n${paragraph(index, 500)}\n\n</details>`).join("\n\n");
    const kept = readmePreview(htmlAfter).markdown.trimEnd().split("\n\n").filter((block) => !block.startsWith("<"));
    expect(kept.at(-1)!.startsWith("##")).toBe(false);
    const commented = Array.from({ length: 30 }, (_, index) => `<!-- generated -->\n## Section ${index}\n\n${paragraph(index, 500)}`).join("\n\n");
    expect(readmePreview(commented).markdown.trimEnd().split("\n\n").at(-1)).not.toMatch(/## Section \d+$/);
    const setext = Array.from({ length: 30 }, (_, index) => `Section ${index}\n----------\n\n${paragraph(index, 500)}`).join("\n\n");
    expect(readmePreview(setext).markdown.trimEnd().split("\n\n").at(-1)).not.toMatch(/\n-+$/);
  });

  it("does not count HTML blocks, which the detail page does not render", () => {
    const table = `<table>\n${Array.from({ length: 80 }, (_, index) => `<tr><td>skill ${index}</td><td>${"x".repeat(60)}</td></tr>`).join("\n")}\n</table>`;
    const markdown = [`# Title`, paragraph(1, 1500), table, paragraph(2, 1500), table, paragraph(3, 1500)].join("\n\n");
    expect(markdown.length).toBeGreaterThan(README_PREVIEW_CHARS * 2);
    expect(readmePreview(markdown)).toEqual({ markdown, truncated: false });
  });

  it("does not truncate a single giant block without boundaries", () => {
    const markdown = `| a | b |\n| - | - |\n${Array.from({ length: 600 }, (_, index) => `| ${index} | value ${index} |`).join("\n")}`;
    expect(readmePreview(markdown)).toEqual({ markdown, truncated: false });
  });
});
