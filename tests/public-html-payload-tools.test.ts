import { describe, expect, it } from "vitest";
import { README_EXCERPT_DISPLAY_CHARS, shortReadmeExcerpt } from "@/lib/domain/products/readme-excerpt";
import { extractFlight, forbiddenKeysIn, measurePage, parseFlightRows, productObjects } from "../scripts/public-payload-report";

describe("README 발췌 표시 길이(2026-11-15 사람 결정 — 몇 문장·수백 자)", () => {
  it("짧은 발췌는 그대로, 긴 발췌는 문단·문장 경계에서 표시 한도 안으로", () => {
    expect(shortReadmeExcerpt("  A short excerpt.  ")).toBe("A short excerpt.");
    expect(shortReadmeExcerpt(null)).toBeNull();
    const paragraphs = `${"First paragraph sentence. ".repeat(8).trim()}\n\n${"Second paragraph sentence. ".repeat(10).trim()}`;
    expect(shortReadmeExcerpt(paragraphs)).toBe("First paragraph sentence. ".repeat(8).trim());
    const sentences = "This sentence keeps going for a while. ".repeat(12).trim();
    const cut = shortReadmeExcerpt(sentences)!;
    expect(cut.length).toBeLessThanOrEqual(README_EXCERPT_DISPLAY_CHARS);
    expect(cut.endsWith(".")).toBe(true);
    const words = "word ".repeat(200).trim();
    expect(shortReadmeExcerpt(words)!.endsWith("…")).toBe(true);
    expect(shortReadmeExcerpt(words)!.length).toBeLessThanOrEqual(README_EXCERPT_DISPLAY_CHARS);
  });
});

describe("측정 도구(scripts/public-payload-report.ts)", () => {
  const flight = `0:["$","div",null,{"children":"x"}]\n1:{"slug":"a","name":"A","repoUrl":"https://github.com/a/a","id":3}\n2:T6,héllo3:[{"slug":"b","name":"B"}]\n`;
  const html = `<html><body><p data-readme-excerpt="">Lead text</p><script>self.__next_f.push([1,${JSON.stringify(flight)}])</script></body></html>`
    .replace("<p data-readme-excerpt=\"\">Lead text</p>", "<blockquote data-readme-excerpt=\"\">Lead &amp; text</blockquote>");

  // T 줄의 길이는 UTF-8 바이트 수다(é 는 2바이트)
  it("HTML 안 RSC 조각을 잇고 줄(T 길이 글 포함)을 값으로 푼다", () => {
    expect(extractFlight(html)).toBe(flight);
    const rows = parseFlightRows(flight);
    expect(rows).toHaveLength(4);
    expect(rows[2]).toBe("héllo");
  });

  it("제품 객체·남은 칸·금지 칸·README 발췌 길이와 전문 포함 여부를 잰다", () => {
    expect(productObjects(parseFlightRows(flight)).map((item) => item.slug)).toEqual(["a", "b"]);
    expect(forbiddenKeysIn(flight)).toEqual(["id", "repoUrl"]);
    const measured = measurePage(html, "not-here");
    expect(measured).toMatchObject({ productObjects: 2, productFields: ["id", "name", "repoUrl", "slug"], readmeExcerptChars: "Lead & text".length,
      readmeFullInHtml: false, readmeFullInRsc: false });
    expect(measurePage(html, "héllo")).toMatchObject({ readmeFullInRsc: true });
  });
});
