import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { TRANSLATE_MODEL, translateToKorean, translateTaglinesToKorean, translateProductFields,
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
  { routeId: "product-tagline-ko", model: TRANSLATE_MODEL, run: () => translateTaglinesToKorean([{ name: "Doc", tagline: "Document tool" }], 1_000) },
  { routeId: "product-translate", model: TRANSLATE_MODEL, run: () => translateProductFields([{ name: "Doc", text: "Document tool", field: "tagline", locale: "en" }], 1_000) },
  { routeId: "crawl-tagline", model: TAGLINE_MODEL, run: () => writeTagline(tagline, { timeoutMs: 1_000 }) },
  { routeId: "product-search-profile", model: PROFILE_MODEL, run: () => writeKeywords(evidence, { timeoutMs: 1_000 }) },
  { routeId: "product-search-verify", model: VERIFY_MODEL, run: () => verifyKeywords({ evidence, keywords: ["document tool"] }, { timeoutMs: 1_000 }) },
  { routeId: "search-query-translate", model: TRANSLATE_MODEL, run: () => translateQueryToEnglish("문서 정리", 1_000) },
];
const control = (mode = "open") => ({ mode, epoch: 1, revision: 1, policyHash: "a".repeat(64),
  policy: { routes: leaves.map(({ routeId, model }) => ({ routeId, model, provider: "abcllm" })) } });
const reply = (content: string, status = 200) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ABCLLM_API_KEY", "test-key");
  vi.stubGlobal("fetch", mocks.request);
  mocks.read.mockResolvedValue(control());
  mocks.request.mockImplementation(async () => reply('["문서 관리 도구"]'));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each(leaves)("$routeId defers a mapped open route before any HTTP dispatch", async ({ run }) => {
  await expect(run()).rejects.toMatchObject({ name: "ModelCapacityDeferredError", reason: "provider_contract_unavailable" });
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.read).toHaveBeenCalledTimes(1);
});

it("defers draining before dispatch without mapping it to a network failure", async () => {
  mocks.read.mockResolvedValue(control("draining"));
  await expect(writeKeywords(evidence, { timeoutMs: 1_000 })).rejects.toMatchObject({ reason: "draining" });
  expect(mocks.request).not.toHaveBeenCalled();
});

it("requires an exact route, provider and model mapping", async () => {
  mocks.read.mockResolvedValue({ ...control(), policy: { routes: [{ routeId: "reason-translate", model: TRANSLATE_MODEL, provider: "another" }] } });
  await expect(translateToKorean(["Document tool"], 1_000)).rejects.toMatchObject({ reason: "unmapped" });
  expect(mocks.request).not.toHaveBeenCalled();
});

it("preserves the original control failure instead of issuing HTTP or masking it", async () => {
  const failure = new Error("model_capacity_policy_hash_mismatch");
  mocks.read.mockRejectedValue(failure);
  await expect(writeTagline(tagline, { timeoutMs: 1_000 })).rejects.toBe(failure);
  expect(mocks.request).not.toHaveBeenCalled();
});

it.each(leaves)("$routeId keeps its no-key branch ahead of the capacity read", async ({ run }) => {
  vi.stubEnv("ABCLLM_API_KEY", "");
  await expect(run()).resolves.toMatchObject({ ok: false, error: "no_key" });
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
});

it("keeps the disabled translation wire and successful output", async () => {
  mocks.read.mockResolvedValue(control("disabled"));
  expect(await translateToKorean(["Document management tool"], 1_000)).toEqual({ ok: true, translations: ["문서 관리 도구"] });
  expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toMatchObject({ model: TRANSLATE_MODEL, stream: false,
    reasoning_effort: "low", temperature: 0.1, max_tokens: 429 });
});

it("keeps disabled provider failure and invalid-output classifications", async () => {
  mocks.read.mockResolvedValue(control("disabled"));
  mocks.request.mockImplementationOnce(async () => reply("", 429));
  expect(await writeKeywords(evidence, { timeoutMs: 1_000 })).toEqual({ ok: false, error: "rate_limit" });
  mocks.request.mockImplementationOnce(async () => reply("not json"));
  expect(await writeKeywords(evidence, { timeoutMs: 1_000 })).toEqual({ ok: false, error: "invalid_output" });
});

it("defers Chinese query translation through the same fixed query route", async () => {
  await expect(translateChineseQueryToEnglish("代码编辑器", "zh-Hans", 1_000)).rejects.toBeInstanceOf(ModelCapacityDeferredError);
  expect(mocks.request).not.toHaveBeenCalled();
});

it("does not turn a chunk admission defer into per-keyword retries", async () => {
  await expect(verifyKeywordsInChunks({ evidence, keywords: ["document tool", "document editor"] }, { timeoutMs: 1_000 }))
    .rejects.toMatchObject({ reason: "provider_contract_unavailable" });
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(mocks.request).not.toHaveBeenCalled();
});

it.each(leaves)("$routeId uses its own exact mapping, not another text route", async ({ routeId, model, run }) => {
  mocks.read.mockResolvedValue({ ...control(), policy: { routes: [{ routeId, model, provider: "abcllm" }] } });
  await expect(run()).rejects.toMatchObject({ reason: "provider_contract_unavailable" });
  expect(mocks.request).not.toHaveBeenCalled();
});
