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
      { routeId: "crawl-agent-review", storedModel: "stored-name", servedIds: ["served-by-api"], reason: null },
    ]);
    expect(request).toHaveBeenCalledWith("http://engine.test/v1/models", expect.objectContaining({ method: "GET" }));
  });
});
