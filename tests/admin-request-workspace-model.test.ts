import { describe, expect, it } from "vitest";
import type { InboxKey, InboxSnapshot } from "@/lib/operations/inbox";
import { assembleRequestOverview, requestWorkspaceTab } from "@/lib/operations/admin-request-workspace-model";

describe("요청함의 기존 링크와 실제 요청 집계", () => {
  it("기본은 처리 필요이며 기존 문의 필터 링크를 보존한다", () => {
    expect(requestWorkspaceTab({})).toBe("open");
    expect(requestWorkspaceTab({ state: "waiting", offset: "50" })).toBe("contact");
    expect(requestWorkspaceTab({ tab: "posts", state: "accepted" })).toBe("posts");
    expect(requestWorkspaceTab({ tab: "invalid", state: "open" })).toBe("open");
    expect(requestWorkspaceTab({ tab: ["contact", "posts"] })).toBe("open");
  });

  const snapshot = (): InboxSnapshot => {
    const keys: InboxKey[] = ["takedown", "introRequest", "feedback", "makerReply", "contact", "human", "agreed", "audit", "down", "intro", "translations", "repoGone", "repoAutoBanned", "spam"];
    return { fetchedAt: "2026-11-04T12:00:00.000Z", done: [34, 56], results: Object.fromEntries(keys.map(key =>
      [key, { ok: true, data: { count: key === "human" ? 9000 : 2, items: [{ id: key, name: key, why: "원본 요청", since: null }], overdue: key === "takedown" ? 1 : 0 } }])) as InboxSnapshot["results"] };
  };

  it("후보 심사·자동 작업·처리 완료 수는 사용자 요청에 합산하지 않는다", () => {
    const result = assembleRequestOverview(snapshot(), { ok: true, data: { count: 3, items: [] } });
    expect(result.knownCount).toBe(13);
    expect(result.failed).toBe(0);
    expect(result.sections.map(section => section.key)).toEqual(["takedown", "introRequest", "contact", "feedback", "makerReply", "reaction"]);
    expect(result.sections[0].overdue).toBe(1);
    expect(result.observedAt).toBe("2026-11-04T12:00:00.000Z");
  });

  it("한 원본 조회 실패를 0건으로 바꾸지 않고 합계를 하한으로 만든다", () => {
    const data = snapshot(); data.results.contact = { ok: false };
    const result = assembleRequestOverview(data, { ok: false });
    expect(result.failed).toBe(2);
    expect(result.knownCount).toBe(8);
    expect(result.sections.find(section => section.key === "contact")).toMatchObject({ count: null, items: [], overdue: null });
    expect(result.sections.find(section => section.key === "reaction")?.count).toBeNull();
  });

  it("전체 집계 실패에서도 독립적으로 읽은 써봤어요 수를 보존한다", () => {
    const result = assembleRequestOverview(null, { ok: true, data: { count: 4, items: [] } });
    expect(result.knownCount).toBe(4); expect(result.failed).toBe(5); expect(result.observedAt).toBeNull();
  });
});
