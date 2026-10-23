import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const control = vi.hoisted(() => vi.fn());
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: control }));
import { translateKoreanTaglinesWithQwen } from "@/lib/crawl/korean-translation-qwen";
import { productTaglineKoGatewayWire, productTaglineKoLegacyWire } from "@/lib/crawl/translate";
import { KOREAN_TRANSLATION_QWEN_BASE_URL, KOREAN_TRANSLATION_QWEN_MODEL } from "@/lib/crawl/korean-translation-config";
const item = { name: "Tool", tagline: "Track tasks for your team" };
const answer = (over: Record<string, unknown> = {}) => new Response(JSON.stringify({
  model: KOREAN_TRANSLATION_QWEN_MODEL, choices: [{ finish_reason: "stop", message: { content: '["팀의 할 일을 기록하는 도구"]' } }], ...over,
}));
beforeEach(() => { control.mockReset().mockResolvedValue({ mode: "disabled" }); vi.stubEnv("KOREAN_TRANSLATION_QWEN_ENABLED", "true"); vi.stubEnv("AUDIT_SECOND_OPINION_API_KEY", ""); });
afterEach(() => vi.unstubAllEnvs());
describe("KO expanded legacy and frozen native profiles", () => {
  it.each([1, 8])("triples output for %i items without changing native wire", count => {
    const items = Array.from({ length: count }, () => item);
    const native = JSON.parse(productTaglineKoGatewayWire(items, "[MLX] gpt-oss-120b"));
    const legacy = JSON.parse(productTaglineKoLegacyWire(items, "[MLX] gpt-oss-120b"));
    expect(native.max_tokens).toBe(600 + 150 * count);
    expect(legacy.max_tokens).toBe(native.max_tokens * 3);
    expect({ ...legacy, max_tokens: native.max_tokens }).toEqual(native);
  });
});
describe("direct gpu3090 Korean translation", () => {
  it("uses pinned endpoint/model, optional auth, explicit thinking off and dedicated Qwen prompt", async () => {
    const request = vi.fn().mockResolvedValue(answer());
    expect(await translateKoreanTaglinesWithQwen([item], { timeoutMs: 1000, request })).toMatchObject({ ok: true });
    const [url, init] = request.mock.calls[0]; const wire = JSON.parse(init.body);
    expect(url).toBe(KOREAN_TRANSLATION_QWEN_BASE_URL + "/chat/completions");
    expect(init.redirect).toBe("error"); expect(init.headers).not.toHaveProperty("Authorization");
    expect(wire).toMatchObject({ model: KOREAN_TRANSLATION_QWEN_MODEL, stream: false, max_tokens: 2250, chat_template_kwargs: { enable_thinking: false } });
    expect(wire).not.toHaveProperty("reasoning_effort");
    expect(wire.messages[0].content).toContain("80");
    expect(wire.messages[0].content).toContain("JSON");
  });
  it.each(["open", "draining"])("refuses %s capacity before any HTTP", async mode => {
    control.mockResolvedValue({ mode }); const request = vi.fn();
    await expect(translateKoreanTaglinesWithQwen([item], { timeoutMs: 1000, request })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("is opt-in and refuses over-budget input before HTTP", async () => {
    const request = vi.fn(); vi.stubEnv("KOREAN_TRANSLATION_QWEN_ENABLED", "false");
    expect(await translateKoreanTaglinesWithQwen([item], { timeoutMs: 1000, request })).toMatchObject({ ok: false, error: "qwen_disabled" });
    vi.stubEnv("KOREAN_TRANSLATION_QWEN_ENABLED", "true");
    expect(await translateKoreanTaglinesWithQwen([{ ...item, tagline: "x".repeat(3601) }], { timeoutMs: 1000, request })).toMatchObject({ ok: false, error: "input_too_large" });
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects response model mismatch and truncated output", async () => {
    const request = vi.fn().mockResolvedValueOnce(answer({ model: "another-model" })).mockResolvedValueOnce(answer({ choices: [{ finish_reason: "length", message: { content: '["팀의 할 일"]' } }] }));
    expect(await translateKoreanTaglinesWithQwen([item], { timeoutMs: 1000, request })).toMatchObject({ ok: false, error: "model_mismatch" });
    expect(await translateKoreanTaglinesWithQwen([item], { timeoutMs: 1000, request })).toMatchObject({ ok: false, error: "invalid_output" });
  });
  it("honors a caller abort before HTTP", async () => {
    const request = vi.fn(); const controller = new AbortController(); controller.abort();
    expect(await translateKoreanTaglinesWithQwen([item], { timeoutMs: 1000, request, signal: controller.signal })).toMatchObject({ ok: false, error: "cancelled" });
    expect(request).not.toHaveBeenCalled();
  });
});
