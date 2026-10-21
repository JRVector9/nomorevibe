import { describe, expect, it } from "vitest";
import { reconcileSnapshots, resolveSelection } from "@/app/(operator)/admin/components/selection";
import { bulkDecisionForm } from "@/app/(operator)/admin/review/BulkDecision";
import { entryVersion } from "@/app/(operator)/admin/review/contract";
import type { AdminReviewEntry } from "@/lib/crawl/admin-review";

/**
 * 다시 읽은 목록 위에서 사람이 고른 것을 지키는 규칙 — 내려달라는 요청(TakedownQueue)·심사 큐(ReviewConsole·BulkDecision).
 */
describe("고른 한 건이 다시 읽은 목록에서 빠지면", () => {
  const order = [{ slug: "a" }, { slug: "b" }, { slug: "c" }];
  const key = (item: { slug: string }) => item.slug;

  it("같은 자리의 다른 것으로 바꾸지 않고 비운다(lost) — 처음 열 때만 첫 줄", () => {
    expect(resolveSelection(order, "b", key)).toEqual({ current: { slug: "b" }, lost: false });
    expect(resolveSelection(order.filter((item) => item.slug !== "b"), "b", key)).toEqual({ current: null, lost: true });
    expect(resolveSelection(order, null, key)).toEqual({ current: { slug: "a" }, lost: false });
    // 목록이 비면 잃은 것이 아니라 볼 것이 없다
    expect(resolveSelection([], "b", key)).toEqual({ current: null, lost: false });
  });
});

describe("일괄로 고른 줄은 고른 때의 판으로 보낸다", () => {
  const entry = (id: number, hash: string): AdminReviewEntry => ({
    candidate: { id, repo: `acme/r${id}` }, name: `r${id}`, inputHash: "in", sourceRevisionHash: "src", candidateRevisionHash: hash,
    bucket: null, review: null, seconds: [],
  }) as unknown as AdminReviewEntry;

  it("판이 그대로인 줄은 고른 때의 해시로 보내고, 바뀐 줄은 풀고(changed), 빠진 줄은 뺀다", () => {
    const snapshots = new Map([[1, entry(1, "h1")], [2, entry(2, "h2")], [3, entry(3, "h3")]]);
    // 다시 읽은 목록 — 2는 후보 내용이 바뀌었고 3은 빠졌다
    const refreshed = [entry(1, "h1"), entry(2, "h2-changed"), entry(4, "h4")];
    const picked = reconcileSnapshots(snapshots, refreshed, (item) => item.candidate.id, entryVersion);
    expect(picked.send.map((item) => item.candidate.id)).toEqual([1]);
    expect([...picked.changed]).toEqual([2]);
    expect(picked.gone).toBe(1);
    // 보내는 폼에는 고른 때의 줄(스냅숏)이 실린다 — 다시 읽은 목록의 판이 아니다
    const form = bulkDecisionForm([snapshots.get(1)!, snapshots.get(2)!], "approve", {});
    const sent = form.getAll("selected").map(String);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("h2");
    expect(sent[1]).not.toContain("h2-changed");
  });

  it("판은 입력·원본·후보 해시 셋이다", () => {
    expect(entryVersion({ inputHash: "a", sourceRevisionHash: "b", candidateRevisionHash: "c" })).toBe("a|b|c");
    expect(entryVersion({ inputHash: null, sourceRevisionHash: undefined, candidateRevisionHash: "c" })).toBe("||c");
  });
});
