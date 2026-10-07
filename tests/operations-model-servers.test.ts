import { expect, it } from "vitest";
import { modelServerHealth } from "@/lib/operations/model-servers";

it("asks only the configured model servers and reports each failure", async () => {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(url);
    if (url.startsWith("http://rerank")) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  expect(await modelServerHealth({ EMBEDDING_URL: "http://embed:1/", RERANK_URL: "http://rerank:2" }, fetchImpl)).toEqual([
    { name: "임베딩", ok: true },
    { name: "재정렬", ok: false, error: "응답 없음" },
  ]);
  expect(asked).toEqual(["http://embed:1/health", "http://rerank:2/health"]);
  expect(await modelServerHealth({}, fetchImpl)).toEqual([]);
});
