import { afterEach, expect, it, vi } from "vitest";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import { reviewWithAgent } from "@/lib/crawl/agent-review";
import { listReviewEngineModels, reviewWithGateway } from "@/lib/crawl/agent-review-gateway";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { reviewWithGrokCli } from "@/lib/crawl/agent-review-grok";

function input() {
  const now = new Date("2026-10-15T00:00:00Z");
  return createReviewInput({ id: 1, repo: "acme/demo", productUrl: "https://demo.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: "acme/demo", productUrl: "https://demo.example", repoMeta: { description: "Task tracker" },
      pageMeta: { title: "Demo", textSample: "A usable task tracker" }, pageStatus: 200, fetchedAt: now } as CrawlDocument,
    DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); setServingContractSnapshotForTest(null); });

it.each(["claude-cli", "abcllm", "grok-cli"] as const)("rejects raw %s adapter in semantic replay before external dispatch", async provider => {
  const external = vi.fn(async () => { throw new Error("external_dispatch_reached"); });
  const call = () => provider === "abcllm"
    ? reviewWithGateway(input(), { model: "fixture-model", request: external, endpoint: { baseUrl: "http://engine.invalid/v1", apiKey: "fixture-test-key" } })
    : provider === "grok-cli" ? reviewWithGrokCli(input(), { model: "fixture-model", run: external })
      : reviewWithAgent(input(), { model: "fixture-model", run: external });
  await expect(withReviewReplayContext({ referenceTime: new Date() }, call)).rejects.toThrow("replay_raw_review_adapter_rejected");
  expect(external).not.toHaveBeenCalled();
});

it("rejects review engine model discovery in replay before reading the serving contracts", async () => {
  setServingContractSnapshotForTest([{ routeId: "second-review", model: "fixture-model", contract: null, auth: "none", apiKey: null, transport: "direct" }]);
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("external_dispatch_reached"));
  await expect(withReviewReplayContext({ referenceTime: new Date() }, () => listReviewEngineModels()))
    .rejects.toThrow("replay_raw_review_adapter_rejected");
  // 바깥(재생 밖)에서는 같은 계약으로 그 모델을 돌려준다 — 막은 것은 재생 경계다. 어느 쪽도 네트워크를 읽지 않는다
  expect(await listReviewEngineModels()).toEqual(["fixture-model"]);
  expect(network).not.toHaveBeenCalled();
});
