import { describe, expect, it } from "vitest";
import { productIndexable, type IndexingFacts } from "@/lib/domain/products/indexing";

/** 색인 판단(UX-08, D1·D2)의 JS 판 — SQL 판과 같은 답인지는 통합 테스트(product-indexing)가 본다 */
const unclaimed: IndexingFacts = {
  status: "seeded", source: "crawler", claimedAt: null, accessMode: "website", category: "Dev",
  repoGone: false, aiEvidence: true, takedownPending: false,
};
const owned: IndexingFacts = { ...unclaimed, status: "verified", source: "skill", aiEvidence: false };

describe("productIndexable", () => {
  it("주인 없는 제품은 AI 근거가 있어야 한다", () => {
    expect(productIndexable(unclaimed)).toBe(true);
    expect(productIndexable({ ...unclaimed, aiEvidence: false })).toBe(false);
  });
  it("주인 없는 개인 프로필은 근거가 있어도 색인하지 않는다(D2)", () => {
    expect(productIndexable({ ...unclaimed, category: "Profile" })).toBe(false);
    expect(productIndexable({ ...owned, category: "Profile" })).toBe(true);
  });
  it("처리 전 내려달라는 요청이 있으면 누구 것이든 색인하지 않는다(D1)", () => {
    expect(productIndexable({ ...unclaimed, takedownPending: true })).toBe(false);
    expect(productIndexable({ ...owned, takedownPending: true })).toBe(false);
  });
  it("공개가 아니면 색인하지 않는다", () => {
    expect(productIndexable({ ...unclaimed, status: "banned" })).toBe(false);
    expect(productIndexable({ ...owned, status: "banned" })).toBe(false);
    expect(productIndexable({ ...owned, status: "unverified" })).toBe(false);
  });
  it("클레임한 수집 제품은 주인 있는 제품이다", () => {
    expect(productIndexable({ ...unclaimed, status: "verified", claimedAt: new Date("2026-10-01"), aiEvidence: false })).toBe(true);
  });
  it("저장소가 사라지면 — 설치형은 누구 것이든 빼고, 웹사이트는 주인 있는 것만 남긴다", () => {
    expect(productIndexable({ ...owned, repoGone: true })).toBe(true);
    expect(productIndexable({ ...owned, repoGone: true, accessMode: "installable" })).toBe(false);
    expect(productIndexable({ ...unclaimed, repoGone: true })).toBe(false);
    expect(productIndexable({ ...unclaimed, accessMode: "installable" })).toBe(true);
    expect(productIndexable({ ...unclaimed, repoGone: true, accessMode: "installable" })).toBe(false);
  });
  it("repoGone 을 읽지 않았으면 사라지지 않은 것으로 본다", () => {
    expect(productIndexable({ ...unclaimed, repoGone: undefined })).toBe(true);
  });
});
