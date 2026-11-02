import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { translateToKorean, translateTaglinesToKorean, translateProductFields,
  translateQueryToEnglish, translateChineseQueryToEnglish } from "@/lib/crawl/translate";
import { writeTagline } from "@/lib/crawl/tagline";
import { writeKeywords } from "@/lib/domain/products/search-profile";
import { verifyKeywords, verifyKeywordsInChunks } from "@/lib/domain/products/search-verify";
import { TextTaskRankMissingError } from "@/lib/llm/ai-task-rank-scope";
import { inTextRank } from "./text-task-ranks-fixture";

const mocks = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn() }));
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: mocks.read }));

const evidence = { name: "Doc", url: "https://doc.test", category: "Tools", topics: "", tagline: "Document tool",
  pageText: "Document management", readme: "", evidenceLevel: "thin" as const };
const tagline = { name: "Doc", url: "https://doc.test", topics: [], language: "TypeScript",
  pageTitle: "Doc", pageText: "Document management", readme: "" };
// 모델은 「작업 ↔ 모델」 순위가 고른다(PR B) — 옛 잎은 잡·검색이 여는 순위 범위 안에서만 불리므로 같은 범위에서 부른다
const SEARCH_QUERY_MODEL = "gpt-oss-120b";
const leaves: { routeId: string; model: string; run: () => Promise<unknown> }[] = [
  { routeId: "reason-translate", model: "gemma-4-26b", run: () => translateToKorean(["Document management tool"], 1_000) },
  { routeId: "product-tagline-ko", model: "gpt-oss-120b", run: () => translateTaglinesToKorean([{ name: "Doc", tagline: "Document tool" }], 1_000) },
  { routeId: "product-translate", model: "gemma-4-26b", run: () => translateProductFields([{ name: "Doc", text: "Document tool", field: "tagline", locale: "en" }], 1_000) },
  { routeId: "crawl-tagline", model: "qwen3.6-35b-heretic", run: () => writeTagline(tagline, { timeoutMs: 1_000 }) },
  { routeId: "product-search-profile", model: "gpt-oss-120b", run: () => writeKeywords(evidence, { timeoutMs: 1_000 }) },
  { routeId: "product-search-verify", model: "Qwen3.8-27B-NVFP4", run: () => verifyKeywords({ evidence, keywords: ["document tool"] }, { timeoutMs: 1_000 }) },
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

it.each(leaves)("$routeId sends nothing and answers no_key, even with the old gateway key set", async ({ routeId, model, run }) => {
  vi.stubEnv("ABCLLM_API_KEY", "old-gateway-key");
  for (const mode of ["open", "disabled", "draining"]) {
    mocks.read.mockResolvedValue(control(mode));
    await expect(inTextRank(routeId, model, run)).resolves.toMatchObject({ ok: false, error: "no_key" });
  }
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
});

it("keeps the chunked verification and Chinese query leaves on the same no-send answer", async () => {
  expect(await inTextRank("search-query-translate", SEARCH_QUERY_MODEL, () => translateChineseQueryToEnglish("文件整理", "zh-Hans", 1_000))).toMatchObject({ ok: false });
  const chunks = await verifyKeywordsInChunks({ evidence, keywords: ["document tool", "file manager"] }, { timeoutMs: 1_000 });
  expect(chunks).toMatchObject({ ok: false, error: "no_key" });
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
});

it("never falls back to a code default model outside a rank scope", async () => {
  // 순위 범위 밖에서 검색어 잎을 부르면 기본값·환경변수 모델로 떨어지지 않고 던진다(보내는 것도 없다)
  await expect(translateQueryToEnglish("문서 정리", 1_000)).rejects.toBeInstanceOf(TextTaskRankMissingError);
  expect(mocks.request).not.toHaveBeenCalled();
});
