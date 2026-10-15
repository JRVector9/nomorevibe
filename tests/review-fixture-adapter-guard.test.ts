import { afterEach, expect, it, vi } from "vitest";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import { reviewWithAgent } from "@/lib/crawl/agent-review";
import { listGatewayModels, reviewWithGateway } from "@/lib/crawl/agent-review-gateway";
import { reviewWithGrokCli } from "@/lib/crawl/agent-review-grok";

function input() {
  const now = new Date("2026-10-15T00:00:00Z");
  return createReviewInput({ id: 1, repo: "acme/demo", productUrl: "https://demo.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: "acme/demo", productUrl: "https://demo.example", repoMeta: { description: "Task tracker" },
      pageMeta: { title: "Demo", textSample: "A usable task tracker" }, pageStatus: 200, fetchedAt: now } as CrawlDocument,
    DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}

afterEach(() => vi.unstubAllEnvs());

it.each(["claude-cli", "abcllm", "grok-cli"] as const)("rejects raw %s adapter in semantic replay before external dispatch", async provider => {
  vi.stubEnv("ABCLLM_API_KEY", "fixture-test-key");
  const external = vi.fn(async () => { throw new Error("external_dispatch_reached"); });
  const call = () => provider === "abcllm" ? reviewWithGateway(input(), { model: "fixture-model", request: external })
    : provider === "grok-cli" ? reviewWithGrokCli(input(), { model: "fixture-model", run: external })
      : reviewWithAgent(input(), { model: "fixture-model", run: external });
  await expect(withReviewReplayContext({ referenceTime: new Date() }, call)).rejects.toThrow("replay_raw_review_adapter_rejected");
  expect(external).not.toHaveBeenCalled();
});

it("rejects gateway model discovery in replay before fetching the model catalog", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "fixture-test-key");
  const external = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
  await expect(withReviewReplayContext({ referenceTime: new Date() }, () => listGatewayModels({ request: external })))
    .rejects.toThrow("replay_raw_review_adapter_rejected");
  expect(external).not.toHaveBeenCalled();
});
