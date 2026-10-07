import { describe, expect, it, vi } from "vitest";
import { embedTexts, EmbeddingUnavailableError, vectorLiteral } from "@/lib/domain/products/embedding";

const vector = (first: number) => Array.from({ length: 1024 }, (_, k) => (k === 0 ? first : 0));
const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
const options = (fetchImpl: typeof fetch) => ({ timeoutMs: 1_000, url: "http://models.local:18081/", fetchImpl });

describe("임베딩 서버 부르기", () => {
  it("글을 한 번에 보내고 서버가 섞어 준 순서를 글 순서로 맞춘다", async () => {
    const fetchImpl = reply({ data: [{ index: 1, embedding: vector(2) }, { index: 0, embedding: vector(1) }] });
    const vectors = await embedTexts(["첫째", "둘째"], options(fetchImpl));
    expect(vectors.map((v) => v[0])).toEqual([1, 2]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://models.local:18081/v1/embeddings");
    expect(JSON.parse(String(init.body))).toEqual({ input: ["첫째", "둘째"] });
  });

  it("주소가 없거나, 서버가 실패하거나, 차원이 다르면 쓸 수 없다고 알린다", async () => {
    await expect(embedTexts(["글"], { timeoutMs: 1_000, url: " " })).rejects.toThrow(new EmbeddingUnavailableError("no_url"));
    await expect(embedTexts(["글"], options(reply({}, 503)))).rejects.toThrow("http_503");
    await expect(embedTexts(["글"], options(reply({ data: [{ index: 0, embedding: [1, 2, 3] }] })))).rejects.toThrow("bad_vector");
    await expect(embedTexts(["글", "글"], options(reply({ data: [{ index: 0, embedding: vector(1) }] })))).rejects.toThrow("bad_response");
  });

  it("제한 시간을 넘기면 기다리지 않는다", async () => {
    const hang = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    await expect(embedTexts(["글"], { ...options(hang as unknown as typeof fetch), timeoutMs: 20 })).rejects.toThrow("timeout");
  });

  it("벡터를 halfvec 리터럴로 적는다", () => {
    expect(vectorLiteral([0.5, -1, 2])).toBe("[0.5,-1,2]");
  });
});
