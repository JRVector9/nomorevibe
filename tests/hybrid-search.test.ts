import { describe, expect, it, vi } from "vitest";
import { CANDIDATES, fuseRanks, rankSearch, rerankDocuments, RERANK_TOP, type RankDependencies } from "@/lib/domain/products/hybrid-search";
import { withPrimaryFallback } from "@/lib/domain/products/relevance";

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
    expect(result).toEqual({ head: ["c", "a", "b", "x"], total: 4, semantic: true, reranked: true });
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
      expect(result).toEqual({ head: ["c", "b", "a"], total: 3, semantic: false, reranked: true });
    }
  });

  it("재정렬이 실패하면 섞은 순서로 낸다", async () => {
    const result = await rankSearch("q", deps({ rerank: vi.fn(async () => { throw new Error("rerank_http_503"); }) }));
    expect(result).toEqual({ head: ["c", "a", "b", "x"], total: 4, semantic: true, reranked: false });
  });

  it("아무것도 걸리지 않으면 재정렬을 부르지 않는다", async () => {
    const d = deps({ ftsSlugs: vi.fn(async () => []), ftsCount: vi.fn(async () => 0), nearestSlugs: vi.fn(async () => []) });
    expect(await rankSearch("asdfgh", d)).toEqual({ head: [], total: 0, semantic: true, reranked: false });
    expect(d.rerank).not.toHaveBeenCalled();
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
