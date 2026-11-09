import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * 2026-11-08 운영 /admin/models: 접수 카드에 끝나지 않은 운영 요청(단계 8개)이 보이자 카드가 길어졌고, `.llm-top { align-items: stretch }` 로
 * 판단 띠가 그 높이만큼 늘었다. 띠 본문 grid 는 align-content 가 기본(normal = stretch)이라 자동 행 4개가 늘어난 높이를 나눠 가져
 * 제목·줄·관측 시각이 위아래로 흩어졌다. 또 접수 카드 안 Tailwind `flex flex-col` 은 prototype.css 의 층 밖 규칙
 * `.admin-prototype .flex { align-items: center }` 에 져서 단추·진행 상자가 가운데로 모였다.
 * 2026-11-09 압축 시안: 접수는 숫자 띠의 첫 칸이 되고 판단 띠는 접수와 나란히 서지 않는다(그래서 늘 일도 없다). 띠의 모양 상자(llm-banner-shape)는 없앴다.
 */
const root = path.resolve(__dirname, "../app/(operator)/admin/models");
const strip = (file: string) => readFileSync(path.join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const parse = (source: string) => [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selectors: selector.split(",").map(part => part.trim()), body }));
const llmOps = parse(strip("llm-ops.css")), dashboard = parse(strip("dashboard.css"));
const values = (rules: ReturnType<typeof parse>, selector: string, property: string) => rules.filter(rule => rule.selectors.includes(selector))
  .map(rule => rule.body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1].trim()).filter(Boolean);
const SCOPE = ".admin-prototype .llm-ops";
const DASH = ".admin-prototype .md-dash";

describe("LLM 대시보드 판단 띠·숫자 띠 CSS", () => {
  it("판단 띠 본문 행은 늘지 않고, 숫자 띠 칸은 위에 맞춘다; 모양 상자는 없다", () => {
    expect(values(dashboard, `${DASH} .md-banner-main`, "align-content")).toEqual(["start"]);
    expect(values(dashboard, `${DASH} .md-stat`, "align-content")).toEqual(["start"]);
    expect(strip("dashboard.css") + strip("llm-ops.css")).not.toMatch(/llm-banner|llm-top|llm-kpi|llm-todo|llm-stage\b|llm-device/);
    expect(readFileSync(path.join(root, "ModelsDashboard.tsx"), "utf8")).not.toContain("llm-banner-shape");
  });

  it("접수 칸 안 단추·진행 상자·확인 대화상자는 가운데로 모이지 않는다", () => {
    expect(values(llmOps, `${SCOPE} .llm-ops-runner`, "display")).toEqual(["grid"]);
    expect(values(llmOps, `${SCOPE} .llm-admission-action`, "justify-content")).toEqual(["flex-start"]);
    expect(values(llmOps, `${SCOPE} .llm-ops-runner .flex-col`, "align-items")).toEqual(["stretch"]);
  });

  it("접수 실행기·대시보드 규칙은 모두 관리자 셸 안으로 좁혀 CSS 묶음 순서·prototype.css 요소 규칙의 층 이동과 무관하게 이긴다", () => {
    const own = /\.llm-(admission|ops-runner|ops-req|ops-done)\b/;
    expect(llmOps.flatMap(rule => rule.selectors).filter(selector => own.test(selector) && !selector.startsWith(`${SCOPE} `))).toEqual([]);
    expect(dashboard.flatMap(rule => rule.selectors).filter(selector => !selector.startsWith(`${DASH} `) && selector !== ".admin-prototype .stack.md-dash")).toEqual([]);
    expect(dashboard.some(rule => rule.selectors.includes(`${DASH} .md-banner-title`))).toBe(true);
  });
});
