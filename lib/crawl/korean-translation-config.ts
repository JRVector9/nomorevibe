import { modelBaseUrl, modelForPurpose, modelLimits } from "@/lib/llm/model-registry";
/** Korean introduction budgets are independent of reasons, search and public multilingual fields. */
export const KOREAN_TRANSLATION_MAX_ITEMS = 8;
export const KOREAN_TRANSLATION_LEGACY_MAX_CHARS = 3_600;
export const KOREAN_TRANSLATION_NATIVE_MAX_CHARS = 1_200;
export type KoreanTranslationProfile = "expanded" | "native";
export function koreanTranslationMaxOutputTokens(count: number, profile: KoreanTranslationProfile = "expanded"): number {
  return profile === "native" ? Math.min(3_000, 600 + count * 150) : Math.min(modelLimits("product-tagline-ko").maxTokens, 1_800 + count * 450);
}
export const KOREAN_TRANSLATION_QWEN_BASE_URL = modelBaseUrl("korean-translation-direct", process.env, "local-direct");
export const KOREAN_TRANSLATION_QWEN_MODEL = modelForPurpose("korean-translation-direct").model;
export const KOREAN_TRANSLATION_QWEN_SERVER = modelForPurpose("korean-translation-direct").equipment;
export function koreanTranslationQwenEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.KOREAN_TRANSLATION_QWEN_ENABLED === "true";
}
export function koreanTranslationQwenRecoveryEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return koreanTranslationQwenEnabled(env) && env.KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED === "true";
}
