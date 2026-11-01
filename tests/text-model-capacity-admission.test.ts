import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TRANSLATE_MODEL, PRODUCT_TRANSLATE_MODEL, KOREAN_TAGLINE_MODEL, SEARCH_QUERY_MODEL, translateToKorean, translateTaglinesToKorean, translateProductFields,
  translateQueryToEnglish, translateChineseQueryToEnglish } from "@/lib/crawl/translate";
import { TAGLINE_MODEL, writeTagline } from "@/lib/crawl/tagline";
import { PROFILE_MODEL, writeKeywords } from "@/lib/domain/products/search-profile";
import { VERIFY_MODEL, verifyKeywords, verifyKeywordsInChunks } from "@/lib/domain/products/search-verify";

const mocks = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn() }));
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: mocks.read }));

const evidence = { name: "Doc", url: "https://doc.test", category: "Tools", topics: "", tagline: "Document tool",
  pageText: "Document management", readme: "", evidenceLevel: "thin" as const };
const tagline = { name: "Doc", url: "https://doc.test", topics: [], language: "TypeScript",
  pageTitle: "Doc", pageText: "Document management", readme: "" };
const leaves = [
  { routeId: "reason-translate", model: TRANSLATE_MODEL, run: () => translateToKorean(["Document management tool"], 1_000) },
  { routeId: "product-tagline-ko", model: KOREAN_TAGLINE_MODEL, run: () => translateTaglinesToKorean([{ name: "Doc", tagline: "Document tool" }], 1_000) },
  { routeId: "product-translate", model: PRODUCT_TRANSLATE_MODEL, run: () => translateProductFields([{ name: "Doc", text: "Document tool", field: "tagline", locale: "en" }], 1_000) },
  { routeId: "crawl-tagline", model: TAGLINE_MODEL, run: () => writeTagline(tagline, { timeoutMs: 1_000 }) },
  { routeId: "product-search-profile", model: PROFILE_MODEL, run: () => writeKeywords(evidence, { timeoutMs: 1_000 }) },
  { routeId: "product-search-verify", model: VERIFY_MODEL, run: () => verifyKeywords({ evidence, keywords: ["document tool"] }, { timeoutMs: 1_000 }) },
  { routeId: "search-query-translate", model: SEARCH_QUERY_MODEL, run: () => translateQueryToEnglish("문서 정리", 1_000) },
];
const control = (mode = "open") => ({ mode, epoch: 1, revision: 1, policyHash: "a".repeat(64),
  policy: { routes: leaves.map(({ routeId, model }) => ({ routeId, model, provider: "abcllm" })) } });

/**
 * The legacy text senders went to the abcLLM gateway, which was removed on 2026-10-30. They now send nothing: every leaf answers
 * no_key (a provider-side reason, so no attempt is counted) without reading the capacity control and without any HTTP, whatever the
 * env key, capacity mode or route mapping. Text models are called only through the capacity path on a direct engine contract.
 */
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.request);
  mocks.read.mockResolvedValue(control());
  mocks.request.mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: '["문서 관리 도구"]' } }] })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each(leaves)("$routeId sends nothing and answers no_key, even with the old gateway key set", async ({ run }) => {
  vi.stubEnv("ABCLLM_API_KEY", "old-gateway-key");
  for (const mode of ["open", "disabled", "draining"]) {
    mocks.read.mockResolvedValue(control(mode));
    await expect(run()).resolves.toMatchObject({ ok: false, error: "no_key" });
  }
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
});

it("keeps the chunked verification and Chinese query leaves on the same no-send answer", async () => {
  expect(await translateChineseQueryToEnglish("文件整理", "zh-Hans", 1_000)).toMatchObject({ ok: false });
  const chunks = await verifyKeywordsInChunks({ evidence, keywords: ["document tool", "file manager"] }, { timeoutMs: 1_000 });
  expect(chunks).toMatchObject({ ok: false, error: "no_key" });
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
});
