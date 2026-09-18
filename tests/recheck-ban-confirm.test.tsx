import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/admin/actions", () => ({ banProducts: vi.fn() }));
const { BanHits } = await import("@/app/admin/products/recheck/BanHits");

/**
 * 일괄 내리기는 누르는 즉시 돌면 안 된다.
 *
 * 전에는 "선택 차단"이 그냥 submit 이라 체크해 둔 것이 한 번에 공개 목록에서 사라졌고,
 * 되돌리기는 제품 화면에서 한 건씩만 된다. 보이는 버튼은 확인 창을 여는 것뿐이어야 하고,
 * 실제로 내리는 버튼은 창 안에만 있어야 한다.
 */
describe("재검수 일괄 내리기 — 확인 창", () => {
  const html = renderToStaticMarkup(createElement(BanHits, { formId: "ban", total: 12 }));
  const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];

  it("화면에 보이는 버튼은 submit 이 아니다 — 누르면 창만 뜬다", () => {
    const trigger = buttons.find((b) => b.includes("선택 차단"))!;
    expect(trigger).toBeTruthy();
    expect(trigger).toContain('type="button"');
    expect(trigger).not.toContain('type="submit"');
    expect(trigger).toContain('aria-haspopup="dialog"');
  });

  it("이 폼에는 submit 버튼이 하나도 없다 — 엔터로도 곧바로 제출되지 않는다", () => {
    expect(buttons.some((b) => b.includes('type="submit"'))).toBe(false);
  });

  it("실제로 내리는 버튼은 확인 창 안에만 있다", () => {
    const dialog = html.match(/<dialog[\s\S]*?<\/dialog>/)?.[0] ?? "";
    expect(dialog).toContain("내리기");
    const outside = html.replace(dialog, "");
    expect(outside).not.toMatch(/>\s*\d*건?\s*내리기\s*</);
  });

  it("창의 기본 초점은 취소다 — 엔터를 치면 내리지 않고 닫힌다", () => {
    const dialog = html.match(/<dialog[\s\S]*?<\/dialog>/)?.[0] ?? "";
    const cancel = (dialog.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []).find((b) => b.includes("취소"))!;
    expect(cancel).toMatch(/autofocus/i);
  });
});
