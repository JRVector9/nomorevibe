import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TalkEntry, TalkProduct } from "@/lib/social/talk";

const mocks = vi.hoisted(() => ({ visible: vi.fn(), list: vi.fn(), localize: vi.fn() }));
vi.mock("@/lib/social/flags", () => ({ talkVisibility: mocks.visible }));
vi.mock("@/lib/social/talk", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/social/talk")>(), listTalk: mocks.list,
}));
vi.mock("@/lib/i18n/products", () => ({ localizeProductList: mocks.localize }));

import { loadHomeTalk } from "@/lib/social/home-talk";

const NOW = new Date("2026-10-23T13:00:00Z");
const entry = (rank: number, homeDecision: TalkEntry["homeDecision"] = null): TalkEntry => ({
  rank, repositoryKey: `acme/p${rank}`, score: 3, sources: ["hn"], byMaker: false, starGrowth: null, homeDecision,
  posts: [{ id: rank, source: "hn", externalId: String(9000 + rank), kind: "link", title: "Real", linkTarget: "repo", postedAt: NOW, points: 40, comments: 3, frontPage: false }],
  product: { id: rank, slug: `p${rank}`, name: `p${rank}`, translationName: `p${rank}`, tagline: "t", taglineKo: null, taglineSource: "maker", category: "Dev",
    repoUrl: `https://github.com/acme/p${rank}`, ogImage: null, stars: 10, aiLevel: 1, accessMode: "website" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.visible.mockResolvedValue({ visible: true, preview: false });
  mocks.list.mockResolvedValue({ entries: [], checkedAt: NOW, unlisted: { active: 0, unknown: 0 } });
  mocks.localize.mockImplementation(async (products: TalkProduct[]) => products);
});

describe("홈 SNS 화제 실데이터", () => {
  it("화제가 없으면 빈 목록을 반환하고 가짜 1위나 출처를 만들지 않는다", async () => {
    expect(await loadHomeTalk(NOW, "ko")).toEqual({ lead: null, rest: [], sources: [], preview: false });
  });

  it("실제 화제가 네 개여도 허용된 1위가 없으면 네 개 목록만 반환한다", async () => {
    const entries = [1, 2, 3, 4].map(rank => entry(rank));
    mocks.list.mockResolvedValue({ entries });
    expect(await loadHomeTalk(NOW, "ko")).toEqual({ lead: null, rest: entries, sources: ["hn"], preview: false });
    expect(mocks.localize).toHaveBeenCalledWith(entries.map(row => row.product), "ko");
  });

  it("승인된 실제 1위 하나만 있으면 그 항목만 보여주고 빈자리를 채우지 않는다", async () => {
    const approved = entry(1, "approved");
    mocks.list.mockResolvedValue({ entries: [approved] });
    expect(await loadHomeTalk(NOW, "en")).toEqual({ lead: approved, rest: [], sources: ["hn"], preview: false });
  });

  it("공개·미리보기 모두 꺼져 있으면 데이터를 읽지 않는다", async () => {
    mocks.visible.mockResolvedValue({ visible: false, preview: false });
    expect(await loadHomeTalk(NOW, "ko")).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.localize).not.toHaveBeenCalled();
  });
});
