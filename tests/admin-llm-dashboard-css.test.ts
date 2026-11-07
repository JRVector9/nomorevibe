import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * 2026-11-08 운영 /admin/models: 접수 카드에 끝나지 않은 운영 요청(단계 8개)이 보이자 카드가 길어졌고, `.llm-top { align-items: stretch }` 로
 * 판단 띠가 그 높이만큼 늘었다. 띠 본문 grid 는 align-content 가 기본(normal = stretch)이라 자동 행 4개가 늘어난 높이를 나눠 가져
 * 제목·줄·관측 시각이 위아래로 흩어졌다. 또 접수 카드 안 Tailwind `flex flex-col` 은 prototype.css 의 층 밖 규칙
 * `.admin-prototype .flex { align-items: center }` 에 져서 단추·진행 상자가 가운데로 모였다.
 */
const source = readFileSync(path.resolve(__dirname, "../app/(operator)/admin/models/llm-ops.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** 가장 안쪽 규칙(선택자 { 선언 })들 — @media 안의 규칙도 같은 모양으로 나온다 */
const rules = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selectors: selector.split(",").map(part => part.trim()), body }));
const values = (selector: string, property: string) => rules.filter(rule => rule.selectors.includes(selector))
  .map(rule => rule.body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1].trim()).filter(Boolean);
const SCOPE = ".admin-prototype .llm-ops";

describe("LLM 대시보드 판단 띠·접수 카드 CSS", () => {
  it("판단 띠는 접수 카드 높이로 늘지 않고, 띠 본문 행도 늘지 않는다", () => {
    expect(values(`${SCOPE} .llm-top`, "align-items")).toEqual(["start"]);
    expect(values(`${SCOPE} .llm-banner`, "align-items")).toEqual(["flex-start"]);
    expect(values(`${SCOPE} .llm-banner-body`, "align-content")).toEqual(["start"]);
    expect(source).not.toMatch(/\.llm-top\s*\{[^}]*align-items:\s*stretch/);
  });

  it("접수 카드 안 단추·진행 상자·확인 대화상자는 가운데로 모이지 않는다", () => {
    expect(values(`${SCOPE} .llm-ops-runner`, "display")).toEqual(["grid"]);
    expect(values(`${SCOPE} .llm-admission-action`, "justify-content")).toEqual(["flex-start"]);
    expect(values(`${SCOPE} .llm-ops-runner .flex-col`, "align-items")).toEqual(["stretch"]);
  });

  it("띠·접수 규칙은 모두 관리자 셸 안으로 좁혀 CSS 묶음 순서·prototype.css 요소 규칙의 층 이동과 무관하게 이긴다", () => {
    const own = /\.llm-(top|banner|card|admission|ops-runner|ops-req|ops-done)\b/;
    const loose = rules.flatMap(rule => rule.selectors).filter(selector => own.test(selector) && !selector.startsWith(`${SCOPE} `));
    expect(loose).toEqual([]);
    expect(rules.some(rule => rule.selectors.includes(`${SCOPE} .llm-banner-body h2`))).toBe(true);
  });
});
