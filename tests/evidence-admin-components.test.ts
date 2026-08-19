import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/admin/evidence/actions", () => ({
  saveEvidenceSettings: vi.fn(),
}));
import {
  EvidenceSettingsForm,
  numberOrPrevious,
} from "@/app/admin/evidence/EvidenceSettingsForm";
import { DEFAULT_EVIDENCE_SETTINGS } from "@/lib/domain/evidence/settings";

describe("evidence settings form", () => {
  it("preserves the previous finite value for invalid numeric edits", () => {
    expect(numberOrPrevious("12", 7)).toBe(12);
    expect(numberOrPrevious("NaN", 7)).toBe(7);
    expect(numberOrPrevious("Infinity", 7)).toBe(7);
  });

  it("renders every bounded setting, pending feedback, and no text below 13px", () => {
    const html = renderToStaticMarkup(createElement(EvidenceSettingsForm, {
      initialSettings: DEFAULT_EVIDENCE_SETTINGS,
    }));
    for (const label of [
      "GitHub 사실 갱신",
      "릴리스·피드 갱신",
      "링크·미디어 확인",
      "오래됨 판정",
      "최대 재시도",
      "한 번에 처리",
      "별 증가 절대값",
      "별 증가율",
    ]) expect(html).toContain(label);
    expect(html).toContain("aria-live=\"polite\"");
    for (const file of [
      "app/admin/evidence/EvidenceSettingsForm.tsx",
      "app/admin/evidence/page.tsx",
      "app/admin/products/[slug]/page.tsx",
    ]) {
      expect(readFileSync(file, "utf8"))
        .not.toMatch(/text-\[(?:1[0-2](?:\.\d+)?|[0-9](?:\.\d+)?)px\]/);
    }
  });
});
