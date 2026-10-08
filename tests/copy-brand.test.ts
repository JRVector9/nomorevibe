import { describe, expect, it } from "vitest";
import { BRAND, HOME_TITLE, pageTitle } from "@/lib/copy/brand";

/** 브랜드 표기와 페이지 제목(UX-39) */
describe("pageTitle", () => {
  it("로고와 같은 소문자 표기 하나", () => {
    expect(BRAND).toBe("nomorevibe");
    expect(HOME_TITLE).toBe("nomorevibe — AI로 만든 것들, 세상에 나오다.");
  });
  it("'무엇 — nomorevibe'", () => {
    expect(pageTitle("“가계부” 검색 결과")).toBe("“가계부” 검색 결과 — nomorevibe");
    expect(pageTitle("금융 프로젝트")).toBe("금융 프로젝트 — nomorevibe");
    expect(pageTitle("2026년 41주 랭킹")).toBe("2026년 41주 랭킹 — nomorevibe");
  });
  it("여러 조각은 가운뎃점으로, 빈 조각은 건너뛴다", () => {
    expect(pageTitle("금융", null, "", "  ", false, undefined, "2026년 41주 랭킹")).toBe("금융 · 2026년 41주 랭킹 — nomorevibe");
    expect(pageTitle(" LCU ")).toBe("LCU — nomorevibe");
  });
  it("조각이 없으면 홈 제목", () => {
    expect(pageTitle()).toBe(HOME_TITLE);
    expect(pageTitle(null, "")).toBe(HOME_TITLE);
  });
});
