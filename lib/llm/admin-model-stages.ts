import { z } from "zod";

/** Selection changes never change the adapter, capacity limits, contracts or stage enable switches. */
export const ADMIN_MODEL_STAGES = [
  { id: "human-review", label: "사람 위임 검수", purpose: "human-review", provider: "local-direct" },
  { id: "direct-review", label: "Qwen 검수 공통 기본 풀", purpose: "direct-review", provider: "local-direct" },
  { id: "audit-review", label: "발행분 감사 · Qwen", purpose: "direct-review", provider: "local-direct" },
  { id: "audit-second-opinion", label: "감사 두 번째 의견", purpose: "direct-review", provider: "local-direct" },
  { id: "published-filter", label: "공개분 추가 검수", purpose: "direct-review", provider: "local-direct" },
  { id: "split-tiebreak", label: "2차 갈림 재검토 · Qwen", purpose: "direct-review", provider: "local-direct" },
  { id: "held-review-retry", label: "보류 재검토 · Qwen", purpose: "direct-review", provider: "local-direct" },
  { id: "split-confirm", label: "2차 갈림 재확인 · DeepSeek", purpose: "human-review", provider: "local-direct" },
  { id: "screen-review", label: "화면 판별", purpose: "screen-review", provider: "local-direct" },
  { id: "reason-translate", label: "심사 사유 번역", purpose: "reason-translate", provider: "abcllm" },
  { id: "product-translate", label: "제품 다국어 번역 · M1 포함", purpose: "product-translate", provider: "abcllm" },
  { id: "product-tagline-ko", label: "한국어 소개 번역", purpose: "product-tagline-ko", provider: "abcllm" },
  { id: "korean-translation-direct", label: "한국어 소개 번역 · 직접 모델", purpose: "korean-translation-direct", provider: "local-direct" },
  { id: "search-query-translate", label: "검색 질의 번역", purpose: "search-query-translate", provider: "abcllm" },
  { id: "product-search-profile", label: "검색 키워드·프로필 생성", purpose: "product-search-profile", provider: "abcllm" },
  { id: "product-search-verify", label: "검색 키워드 검증", purpose: "product-search-verify", provider: "abcllm" },
  { id: "crawl-tagline", label: "수집 소개 생성", purpose: "crawl-tagline", provider: "abcllm" },
  { id: "product-intro-check", label: "소개 검수", purpose: "product-intro-check", provider: "claude-cli" },
  { id: "assist-primary", label: "LLM 보강 · Qwen", purpose: "assist-primary", provider: "local-direct" },
  { id: "assist-audit", label: "LLM 보강 · 감사", purpose: "assist-audit", provider: "local-direct" },
] as const;
export type AdminModelStage = typeof ADMIN_MODEL_STAGES[number]["id"];
export const adminStagePoolsSchema = z.partialRecord(z.enum(ADMIN_MODEL_STAGES.map(stage => stage.id)),
  z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/)).max(8)
    .refine(keys => new Set(keys).size === keys.length, "같은 모델을 중복 선택할 수 없습니다."));
export type AdminStagePools = z.infer<typeof adminStagePoolsSchema>;

/** One eligibility rule shared by the stage editor and its runtime selection. */
export function adminStageAcceptsModel(stage: typeof ADMIN_MODEL_STAGES[number], model: {
  provider: string; cliEngine?: unknown; purposes: readonly string[];
}): boolean {
  const nativeIntro = stage.id === "product-intro-check" && model.provider === "opencode-cli" && !!model.cliEngine
    && model.purposes.includes(stage.purpose);
  if (!nativeIntro && model.provider !== stage.provider) return false;
  if (stage.id === "korean-translation-direct" && model.cliEngine) return false;
  return !(stage.id.startsWith("assist-") || stage.id === "screen-review") || model.purposes.includes(stage.purpose);
}
