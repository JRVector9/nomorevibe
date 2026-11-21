import { describe, expect, it, vi } from "vitest";
import { CANDIDATES, fuseRanks, rankMultilingualSearch, rankSearch, rerankDocuments, RERANK_TOP, type RankDependencies } from "@/lib/domain/products/hybrid-search";
import { searchRelevance, withPrimaryFallback } from "@/lib/domain/products/relevance";

const slugs = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

function deps(overrides: Partial<RankDependencies> = {}): RankDependencies {
  return {
    ftsSlugs: vi.fn(async () => ["a", "b", "c"]),
    ftsCount: vi.fn(async () => 3),
    ftsMatching: vi.fn(async () => []),
    nearestSlugs: vi.fn(async () => ["c", "x"]),
    documents: vi.fn(async (list: string[]) => new Map(list.map((slug) => [slug, `${slug} 글`]))),
    embed: vi.fn(async () => [0.1, 0.2]),
    // 글 순서 그대로 높은 점수 — 재정렬이 순서를 바꾸지 않는다
    rerank: vi.fn(async (_query: string, docs: string[]) => docs.map((_, i) => -i)),
    ...overrides,
  };
}

describe("순위 섞기(RRF)", () => {
  it("두 목록에 다 있는 것이 한쪽에만 있는 것보다 앞이고, 같은 점수는 앞 목록 순서를 따른다", () => {
    expect(fuseRanks([["a", "b", "c"], ["c", "x"]])).toEqual(["c", "a", "b", "x"]);
    expect(fuseRanks([["a"], ["b"]])).toEqual(["a", "b"]);
  });
});

describe("관련도순 검색", () => {
  it("의미 검색만으로 걸린 것을 더해 섞고, 전체 수에 더한다", async () => {
    const d = deps();
    const result = await rankSearch("회의록 정리", d);
    expect(result).toMatchObject({ head: ["c", "a", "b", "x"], total: 4, semantic: true, reranked: true,
      modelWork: { embeddingCalls: 1, rerankCalls: 1, embeddingTimedOut: false, rerankTimedOut: false, fallback: false } });
    expect(d.embed).toHaveBeenCalledWith("회의록 정리");
    // 낱말 검색이 다 들어왔으면(200 미만) 뒤에서 겹칠 것이 없다
    expect(d.ftsMatching).not.toHaveBeenCalled();
  });

  it("낱말 검색이 200을 넘으면, 의미 검색만으로 걸린 것 중 뒤쪽 낱말 검색에도 걸린 것은 한 번만 센다", async () => {
    const fts = slugs("f", CANDIDATES);
    const d = deps({
      ftsSlugs: vi.fn(async () => fts), ftsCount: vi.fn(async () => 1_000),
      nearestSlugs: vi.fn(async () => ["f1", "v1", "v2"]), ftsMatching: vi.fn(async () => ["v2"]),
    });
    const result = await rankSearch("q", d);
    expect(d.ftsMatching).toHaveBeenCalledWith(["v1", "v2"]);
    expect(result.total).toBe(1_000 + 2 - 1);
    expect(result.head).toHaveLength(CANDIDATES + 2);
  });

  it("앞 30개만 재정렬하고 그 뒤는 섞은 순서 그대로 둔다", async () => {
    const fts = slugs("f", 40);
    const rerank = vi.fn(async (_q: string, docs: string[]) => docs.map((_, i) => i)); // 거꾸로
    const result = await rankSearch("q", deps({ ftsSlugs: vi.fn(async () => fts), ftsCount: vi.fn(async () => 40), nearestSlugs: vi.fn(async () => []), rerank }));
    expect(rerank.mock.calls[0][1]).toHaveLength(RERANK_TOP);
    expect(result.head.slice(0, RERANK_TOP)).toEqual(fts.slice(0, RERANK_TOP).reverse());
    expect(result.head.slice(RERANK_TOP)).toEqual(fts.slice(RERANK_TOP));
  });

  it("임베딩 서버나 벡터 조회가 실패해도 낱말 검색으로 내고, 재정렬은 그대로 건다", async () => {
    for (const failing of [
      { embed: vi.fn(async () => { throw new Error("timeout"); }) },
      { nearestSlugs: vi.fn(async () => { throw new Error('could not access file "$libdir/vector"'); }) },
    ]) {
      const rerank = vi.fn(async (_q: string, docs: string[]) => docs.map((_, i) => i));
      const result = await rankSearch("q", deps({ ...failing, rerank }));
      expect(result).toMatchObject({ head: ["c", "b", "a"], total: 3, semantic: false, reranked: true });
    }
  });

  it("재정렬이 실패하면 섞은 순서로 낸다", async () => {
    const result = await rankSearch("q", deps({ rerank: vi.fn(async () => { throw new Error("rerank_http_503"); }) }));
    expect(result).toMatchObject({ head: ["c", "a", "b", "x"], total: 4, semantic: true, reranked: false });
  });

  it("아무것도 걸리지 않으면 재정렬을 부르지 않는다", async () => {
    const d = deps({ ftsSlugs: vi.fn(async () => []), ftsCount: vi.fn(async () => 0), nearestSlugs: vi.fn(async () => []) });
    expect(await rankSearch("asdfgh", d)).toMatchObject({ head: [], total: 0, semantic: true, reranked: false,
      modelWork: { embeddingCalls: 1, rerankCalls: 0 } });
    expect(d.rerank).not.toHaveBeenCalled();
  });

  it("records model timeouts for the original ranking path", async () => {
    const d = deps({ embed: () => new Promise(() => {}), rerank: () => new Promise(() => {}) });
    expect(await rankSearch("q", d)).toMatchObject({ head: ["a", "b", "c"], total: 3, semantic: false, reranked: false,
      modelWork: { embeddingCalls: 1, rerankCalls: 1, embeddingTimedOut: true, rerankTimedOut: true, fallback: true } });
  });
});

describe("재정렬 서버 부르기", () => {
  it("서버가 섞어 준 결과를 글 순서의 점수로 맞춘다", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [{ index: 1, relevance_score: 2.5 }, { index: 0, relevance_score: -1 }],
    })));
    expect(await rerankDocuments("q", ["첫째", "둘째"], { url: "http://models.local:18082", fetchImpl })).toEqual([-1, 2.5]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://models.local:18082/v1/rerank");
    expect(JSON.parse(String(init.body))).toEqual({ query: "q", documents: ["첫째", "둘째"], top_n: 2 });
  });

  it("주소가 없거나, 실패하거나, 점수가 빠지면 던진다 — 부르는 쪽이 섞은 순서로 낸다", async () => {
    await expect(rerankDocuments("q", ["a"], { url: "" })).rejects.toThrow("rerank_no_url");
    const failing = vi.fn(async () => new Response("busy", { status: 503 }));
    await expect(rerankDocuments("q", ["a"], { url: "http://m", fetchImpl: failing })).rejects.toThrow("rerank_http_503");
    const partial = vi.fn(async () => new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 1 }] })));
    await expect(rerankDocuments("q", ["a", "b"], { url: "http://m", fetchImpl: partial })).rejects.toThrow("rerank_bad_response");
  });
});

describe("복제본이 pgvector 를 모를 때", () => {
  it("확장이 없다는 오류에만 주 DB 에서 다시 읽는다", async () => {
    const missing = Object.assign(new Error('could not access file "$libdir/vector"'), { code: "58P01" });
    const load = vi.fn().mockRejectedValueOnce(missing).mockResolvedValueOnce(["on-primary"]);
    const primary = vi.fn(async (again: () => Promise<string[]>) => again());
    expect(await withPrimaryFallback(load, primary)).toEqual(["on-primary"]);
    expect(primary).toHaveBeenCalledTimes(1);

    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const other = vi.fn(async () => primary(async () => ["never"]));
    await expect(withPrimaryFallback(vi.fn().mockRejectedValue(timeout), other)).rejects.toThrow("statement timeout");
    expect(other).not.toHaveBeenCalled();
  });
});

describe("처음 들어온 한국어 문장", () => {
  const empty = { head: [], total: 0, semantic: true, reranked: false };
  const found = { head: ["tv-shows-chart"], total: 1, semantic: true, reranked: true };

  it("원문으로 0건이면 그때만 번역을 기다려 다시 찾는다", async () => {
    const work = { embeddingCalls: 1, rerankCalls: 0, embeddingTimedOut: true, rerankTimedOut: false, fallback: true };
    const rank = vi.fn().mockResolvedValueOnce({ ...empty, modelWork: work }).mockResolvedValueOnce({
      ...found, modelWork: { ...work, rerankCalls: 1, embeddingTimedOut: false, fallback: false },
    });
    const translate = vi.fn(async () => ({ queries: ["드라마 평점 차트", "tv show ratings"], translated: "tv show ratings" }));
    const result = await searchRelevance("드라마 평점 차트", { queries: ["드라마 평점 차트"], translated: null, translationPending: true }, {}, translate, rank);
    expect(result).toEqual({ ...found, plan: ["드라마 평점 차트", "tv show ratings"], translated: "tv show ratings",
      modelWork: { ...work, embeddingCalls: 2, rerankCalls: 1 } });
    expect(rank).toHaveBeenLastCalledWith("드라마 평점 차트", ["드라마 평점 차트", "tv show ratings"], {});
  });

  it("결과가 있거나 이미 옮긴 말이면 기다리지 않는다", async () => {
    const translate = vi.fn();
    const rank = vi.fn().mockResolvedValue(found);
    await searchRelevance("회의록", { queries: ["회의록"], translated: null, translationPending: true }, {}, translate, rank);
    const none = vi.fn().mockResolvedValue(empty);
    await searchRelevance("asdfgh", { queries: ["asdfgh"], translated: null }, {}, translate, none);
    expect(translate).not.toHaveBeenCalled();
  });
});

describe("expanded relevance ranking", () => {
  it.each([-0.1, 0, 0.1])("preserves the original leader only at scores of zero or higher (%s)", async (score) => {
    const fetchNative = vi.fn(async () => ["native-first", "native-second"]);
    const rerank = vi.fn(async (query: string, docs: string[]) => docs.map((doc) =>
      query === "原文" ? doc.startsWith("native") ? score : score - 1 : doc.startsWith("x") ? 10 : 1));
    const d = deps({ rerank });
    const result = await rankMultilingualSearch("原文", "english", d, fetchNative);
    expect(result.head[0]).toBe(score < 0 ? "x" : "native-first");
    expect(result.total).toBe(score < 0 ? 4 : 5);
    expect(result.head).not.toContain("native-second");
    expect(d.documents).toHaveBeenCalledTimes(1);
    expect(d.embed).toHaveBeenCalledTimes(2);
    expect(d.nearestSlugs).toHaveBeenCalledTimes(2);
    expect(rerank.mock.calls.map(([query]) => query)).toEqual(["原文 / english", "原文"]);
  });

  it("can preserve the original leader even when the expanded candidate list is empty", async () => {
    const d = deps({ ftsSlugs: async () => [], ftsCount: async () => 0, nearestSlugs: async () => [] });
    expect(await rankMultilingualSearch("原文", "english", d, async () => ["legacy-only"]))
      .toMatchObject({ head: ["legacy-only"], total: 1, reranked: true, modelWork: { rerankCalls: 1 } });
  });

  it("reuses the lexical ranking after an extra embedding fails before the deadline", async () => {
    const embed = vi.fn(async (text: string) => {
      if (text === "english") throw new Error("unavailable");
      return [0.1, 0.2];
    });
    const d = deps({ embed, rerank: vi.fn(async (_q: string, docs: string[]) => docs.map((_, index) => index)) });
    const native = async () => ["unrelated"];
    const result = await rankMultilingualSearch("原文", "english", d, native);
    expect(result).toMatchObject({ head: ["x", "b", "a", "c"], total: 4, reranked: true,
      modelWork: { embeddingCalls: 2, rerankCalls: 1, embeddingTimedOut: false, fallback: true } });
    expect(d.rerank).toHaveBeenCalledWith("原文", expect.any(Array));
  });

  it("uses the original vector already received when the second embedding times out", async () => {
    const embed = vi.fn(async (text: string) => text === "english" ? new Promise<number[]>(() => {}) : [0.1, 0.2]);
    const d = deps({ embed });
    const result = await rankMultilingualSearch("原文", "english", d, async () => ["legacy-only"]);
    expect(result).toMatchObject({ head: ["c", "a", "b", "x"], total: 4, semantic: true, reranked: false,
      modelWork: { embeddingTimedOut: true, rerankCalls: 0, fallback: true } });
    expect(d.rerank).not.toHaveBeenCalled();
  });

  it("keeps database deadlines out of the model timeout counts", async () => {
    const vectors = deps({ nearestSlugs: () => new Promise(() => {}) });
    expect(await rankMultilingualSearch("原文", "english", vectors, async () => ["a"]))
      .toMatchObject({ head: ["a", "b", "c"], modelWork: {
        embeddingCalls: 2, embeddingTimedOut: false, rerankCalls: 0, rerankTimedOut: false, fallback: true,
      } });
    const documents = deps({ documents: () => new Promise(() => {}) });
    expect(await rankMultilingualSearch("原文", "english", documents, async () => ["a"]))
      .toMatchObject({ head: ["c", "a", "b", "x"], modelWork: {
        embeddingCalls: 2, embeddingTimedOut: false, rerankCalls: 0, rerankTimedOut: false, fallback: true,
      } });
  });

  it("does not start a third rerank after a failure and only uses complete original scores", async () => {
    const rerank = vi.fn(async (text: string, docs: string[]) => {
      if (text.includes(" / ")) throw new Error("unavailable");
      return docs.map((_, index) => index);
    });
    const d = deps({ rerank });
    const result = await rankMultilingualSearch("原文", "english", d, async () => ["a", "b", "c"]);
    expect(result).toMatchObject({ head: ["x", "b", "a", "c"], total: 4, reranked: true,
      modelWork: { rerankCalls: 2, fallback: true } });
    const incomplete = await rankMultilingualSearch("原文", "english", d, async () => ["legacy-only"]);
    expect(incomplete).toMatchObject({ head: ["c", "a", "b", "x"], total: 4, reranked: false,
      modelWork: { rerankCalls: 2, fallback: true } });
  });

  it("drops the translated vector on rerank timeout and sends at most 30 pairs per call", async () => {
    const fts = slugs("f", 40);
    const rerank = vi.fn(async (text: string, docs: string[]) => text.includes(" / ")
      ? new Promise<number[]>(() => {}) : docs.map(() => 0));
    const d = deps({
      ftsSlugs: async () => fts, ftsCount: async () => fts.length,
      embed: async (text) => [text === "english" ? 1 : 0],
      nearestSlugs: async ([vector]) => vector ? ["translated-only"] : ["native-vector"],
      rerank,
    });
    const result = await rankMultilingualSearch("原文", "english", d, async () => fts);
    expect(result).toMatchObject({ head: fuseRanks([fts, ["native-vector"]]), total: 41, reranked: false,
      modelWork: { rerankCalls: 2, rerankTimedOut: true, fallback: true } });
    expect(rerank.mock.calls.map(([, docs]) => docs.length)).toEqual([30, 30]);
    expect(d.documents).toHaveBeenCalledTimes(1);
  });
});
