import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * 상세 요청 폼의 셋째 갈래 '소개 수정 요청'(2026-10-08 UX 감사 UX-18).
 *
 * 화면을 눌러 볼 DOM 이 없으므로, 처음 고른 갈래를 'intro' 로 바꿔 그린다 — 폼의 useState("owner") 만 바꾼다.
 */
const state = vi.hoisted(() => ({ start: "owner" }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => actual.useState(initial === "owner" ? state.start : initial) };
});

const { TakedownForm } = await import("@/app/(public)/[locale]/(content)/p/[slug]/TakedownForm");
const { INTRO_REQUEST_MAX, INTRO_REQUEST_MIN, TAKEDOWN_PROMISE, introRequestMessage } = await import("@/lib/domain/products/takedown-view");

const textOf = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

describe("요청 폼 — 소개 수정 요청", () => {
  it("세 갈래를 고를 수 있고 처음에는 내려달라는 요청(운영자 요청)이다", () => {
    state.start = "owner";
    const html = renderToStaticMarkup(<TakedownForm slug="hwp" />);
    const radios = html.match(/<input type="radio"[^>]*name="kind"[^>]*>/g) ?? [];
    expect(radios.map((radio) => radio.match(/value="([^"]+)"/)?.[1])).toEqual(["owner", "abuse", "intro"]);
    expect(radios[0]).toContain('checked=""');
    expect(textOf(html)).toContain("소개 수정 요청 · 한 줄 소개가 틀렸거나 바꾸고 싶을 때");
    expect(textOf(html)).toContain("요청 이유 (선택)");
    expect(html).not.toMatch(/<textarea[^>]*required/);
  });

  it("소개 수정을 고르면 글을 꼭 적게 하고, 노출을 멈춘다는 약속 대신 노출은 그대로라고 말한다", () => {
    state.start = "intro";
    const html = renderToStaticMarkup(<TakedownForm slug="hwp" />);
    const checked = html.match(/<input type="radio"[^>]*checked=""[^>]*>/g) ?? [];
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('value="intro"');
    // 보이는 이름표가 칸에 이어지고 '필수'가 보인다(A11Y-01)
    const labelFor = html.match(/<label for="([^"]+)"[^>]*>고칠 내용/)?.[1];
    expect(labelFor).toBeTruthy();
    const textarea = html.match(new RegExp(`<textarea id="${labelFor}"[^>]*>`))?.[0] ?? "";
    expect(textarea).toContain('required=""');
    expect(textarea).toContain(`minLength="${INTRO_REQUEST_MIN}"`);
    expect(textarea).toContain(`maxLength="${INTRO_REQUEST_MAX}"`);
    expect(textOf(html)).toContain("(필수)");
    expect(textOf(html)).toContain("검색엔진 노출은 그대로입니다");
    expect(textOf(html)).not.toContain(TAKEDOWN_PROMISE);
    expect(html).not.toContain("/policy#takedown");
    // 연락처 칸은 없다(D5)
    expect(html).not.toMatch(/type="email"|연락처|이메일/);
  });

  it("소개 수정은 내려달라는 요청 주소가 아니라 따로 된 주소로 글만 보낸다", () => {
    const source = readFileSync("app/p/[slug]/TakedownForm.tsx", "utf8");
    expect(source).toContain("intro ? `/api/products/${slug}/intro-request` : `/api/products/${slug}/takedown`");
    expect(source).toContain("intro ? { message: text } : { reason: text, kind }");
  });
});

describe("요청 글 검사", () => {
  it("앞뒤 빈칸을 빼고 길이를 본다", () => {
    expect(introRequestMessage("  소개가 틀렸어요  ")).toEqual({ ok: true, message: "소개가 틀렸어요" });
    expect(introRequestMessage("    ")).toMatchObject({ ok: false });
    expect(introRequestMessage("짧음")).toMatchObject({ ok: false });
    expect(introRequestMessage(undefined)).toMatchObject({ ok: false });
    expect(introRequestMessage(42)).toMatchObject({ ok: false });
    expect(introRequestMessage("가".repeat(INTRO_REQUEST_MAX))).toMatchObject({ ok: true });
    expect(introRequestMessage("가".repeat(INTRO_REQUEST_MAX + 1))).toMatchObject({ ok: false });
  });
});
