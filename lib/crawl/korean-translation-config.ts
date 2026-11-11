import { modelLimits } from "@/lib/llm/model-registry";
/** Korean introduction budgets are independent of reasons, search and public multilingual fields. */
export const KOREAN_TRANSLATION_MAX_ITEMS = 8;
export const KOREAN_TRANSLATION_LEGACY_MAX_CHARS = 3_600;
export const KOREAN_TRANSLATION_NATIVE_MAX_CHARS = 1_200;
export type KoreanTranslationProfile = "expanded" | "native";
export function koreanTranslationMaxOutputTokens(count: number, profile: KoreanTranslationProfile = "expanded"): number {
  return profile === "native" ? Math.min(3_000, 600 + count * 150) : Math.min(modelLimits("product-tagline-ko").maxTokens, 1_800 + count * 450);
}
// 2026-11-11: 한국어 소개 번역의 Qwen 직접 경로(korean-translation-direct, env KOREAN_TRANSLATION_QWEN_ENABLED·_RECOVERY_ENABLED)는 없앴다(운영자 결정).
// 용량 장부 밖에서 부르던 길이었고, 장부를 거치는 product-tagline-ko 순위(작업 ↔ 모델)가 같은 일을 한다.
