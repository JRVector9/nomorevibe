import { describe, expect, it } from "vitest";
import { koreanTranslationRuntimePrompt } from "@/lib/crawl/korean-translation-prompts";
import { productTaglineKoGatewayWire, productTaglineKoLegacyWire, reasonTranslationGatewayWire } from "@/lib/crawl/translate";

describe("Korean runtime Qwen summary prompt", () => {
  it("changes only expanded Qwen requests while strict native and other models retain their systems", () => {
    const items = [{ name: "Product", tagline: "A useful product" }];
    const native = JSON.parse(productTaglineKoGatewayWire(items, "qwen3.8-flash-next"));
    const expanded = JSON.parse(productTaglineKoLegacyWire(items, "qwen3.8-flash-next"));
    expect(expanded.messages[0].content).toBe(koreanTranslationRuntimePrompt("qwen3.8-flash-next", 1));
    expect(native.messages[0].content).not.toBe(expanded.messages[0].content);
    expect(native.max_tokens).toBe(750);
    expect(expanded.max_tokens).toBe(2250);
    const gptNative = JSON.parse(productTaglineKoGatewayWire(items, "[MLX] gpt-oss-120b"));
    const gptExpanded = JSON.parse(productTaglineKoLegacyWire(items, "[MLX] gpt-oss-120b"));
    expect(gptExpanded.messages).toEqual(gptNative.messages);
    expect(koreanTranslationRuntimePrompt("[MLX] gpt-oss-120b", 8)).toBeNull();
    expect(JSON.parse(reasonTranslationGatewayWire(["Source"], "qwen3.8-flash-next")).messages[0].content)
      .not.toContain("name이 40자");
  });
});
