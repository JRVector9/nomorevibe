import { expect, it } from "vitest";
import { admitStaleProposals, staleReviewCursorAfterPage } from "@/lib/crawl/second-review-stale";

/** 다시 넣는 AI2 행의 중복 방지·순서 — 한 후보·slug·모델에 살아 있는 표는 하나, 투표자 순서는 그대로 */
const proposal = (model: string, generationKey = "gen-2", publishedSlug: string | null = null) =>
  ({ model, generationKey, inputHash: "in-2", publishedSlug });
const vote = (model: string, status: "pending" | "failed" | "agreed" | "needs_human" | "resolved", generationKey = "gen-1",
  publishedSlug: string | null = null) => ({ model, status, generationKey, inputHash: "in-1", publishedSlug });

it("gives each configured model exactly one new row, in voter order", () => {
  const admitted = admitStaleProposals([proposal("opus"), proposal("haiku"), proposal("[MLX] Opus")], []);
  expect(admitted.map(row => row.model)).toEqual(["opus", "haiku"]);
});

it("never assigns a model that still holds a waiting vote for the same candidate", () => {
  for (const status of ["pending", "failed"] as const)
    expect(admitStaleProposals([proposal("opus"), proposal("haiku")], [vote("opus", status)]).map(row => row.model)).toEqual(["haiku"]);
  // 끝난 표(사람 확인·일치·닫힘)는 다음 세대를 막지 않는다 — 같은 세대만 막는다
  for (const status of ["agreed", "needs_human", "resolved"] as const)
    expect(admitStaleProposals([proposal("opus")], [vote("opus", status)])).toHaveLength(1);
});

it("refuses the same generation for the same model in any state, matching the unique index", () => {
  const same = { ...vote("[mlx] opus", "resolved", "gen-2"), inputHash: "in-2" };
  expect(admitStaleProposals([proposal("opus"), proposal("haiku")], [same]).map(row => row.model)).toEqual(["haiku"]);
});

it("keeps published slugs separate from pre-publication votes", () => {
  const published = proposal("opus", "gen-2", "app");
  expect(admitStaleProposals([published], [vote("opus", "pending")])).toEqual([published]);
  expect(admitStaleProposals([published], [vote("opus", "pending", "gen-1", "app")])).toEqual([]);
});

it("walks a large backlog in candidate order without revisiting a consumed page", () => {
  const backlog = Array.from({ length: 7 }, (_, index) => 100 + index);
  const seen: number[] = [];
  let after = 0;
  for (let guard = 0; guard < 10; guard++) {
    const page = backlog.filter(id => id > after).slice(0, 3);
    seen.push(...page);
    after = staleReviewCursorAfterPage(page, page.length, 3);
    if (after === 0) break;
  }
  expect(seen).toEqual(backlog);
});
