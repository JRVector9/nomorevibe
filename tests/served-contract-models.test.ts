import { afterEach, describe, expect, it, vi } from "vitest";
import { readServedContractModels } from "@/lib/operations/admin-engine-connect";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";

afterEach(() => { setServingContractSnapshotForTest(null); vi.unstubAllGlobals(); });

describe("saved engine APIs", () => {
  it("uses the model id the entered API returns and does not keep a stored name the server does not list", async () => {
    setServingContractSnapshotForTest([{
      routeId: "crawl-agent-review", model: "stored-name", auth: "none", apiKey: null, transport: "direct",
      contract: { endpoint: "http://engine.test/v1/chat/completions" },
    }]);
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "served-by-api", max_model_len: 1000 }] })));
    await expect(readServedContractModels(request)).resolves.toEqual([
      // host 는 키 없이 host:port 만, 장비 이름은 같은 host 를 baseUrl 로 둔 등록부 모델이 없으면 null 이다(「장비 · 모델」 표시용)
      { routeId: "crawl-agent-review", storedModel: "stored-name", servedIds: ["served-by-api"], reason: null, host: "engine.test", equipment: null },
    ]);
    expect(request).toHaveBeenCalledWith("http://engine.test/v1/models", expect.objectContaining({ method: "GET" }));
  });
});
