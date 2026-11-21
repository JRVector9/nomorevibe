import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/** 서빙 계약 화면의 「abcllm 계약 → 직접 연결 전환」 칸 — 처음 그림(미리 보기 전에는 실행 단추가 없다). */
vi.mock("@/app/(operator)/admin/models/contracts/actions", () => ({ previewContractConversion: vi.fn(), applyContractConversion: vi.fn() }));
const { ConvertForm } = await import("@/app/(operator)/admin/models/contracts/ConvertForm");

describe("ConvertForm", () => {
  it("동작·경로·모델 칸과 미리 보기 단추만 그린다 — 계획 hash 없이 실행할 수 없다", () => {
    const html = renderToStaticMarkup(createElement(ConvertForm, { routes: ["crawl-tagline", "second-review"] }));
    expect(html).toContain("abcllm → 직접 연결 전환");
    expect(html).toContain("직접 연결 → abcllm 되돌리기");
    expect(html).toContain('<option value="second-review">second-review</option>');
    expect(html).toContain("미리 보기");
    expect(html).not.toContain("planHash");
    expect(html).not.toContain("이 계획대로");
  });
});
