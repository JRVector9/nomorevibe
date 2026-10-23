/** Korean introduction budgets are independent of reasons, search and public multilingual fields. */
export const KOREAN_TRANSLATION_MAX_ITEMS = 8;
export const KOREAN_TRANSLATION_LEGACY_MAX_CHARS = 3_600;
export const KOREAN_TRANSLATION_NATIVE_MAX_CHARS = 1_200;
export type KoreanTranslationProfile = "expanded" | "native";
export function koreanTranslationMaxOutputTokens(count: number, profile: KoreanTranslationProfile = "expanded"): number {
  return profile === "native" ? Math.min(3_000, 600 + count * 150) : Math.min(5_400, 1_800 + count * 450);
}
export const KOREAN_TRANSLATION_QWEN_BASE_URL = "http://100.77.43.63:8090/v1";
export const KOREAN_TRANSLATION_QWEN_MODEL = "qwen3.8-flash-next";
export const KOREAN_TRANSLATION_QWEN_SERVER = "gpu3090";
export function koreanTranslationQwenEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.KOREAN_TRANSLATION_QWEN_ENABLED === "true";
}
export function koreanTranslationQwenRecoveryEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return koreanTranslationQwenEnabled(env) && env.KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED === "true";
}
