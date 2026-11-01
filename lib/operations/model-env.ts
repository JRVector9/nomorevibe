import type { ModelEnv, TextModelRoute } from "./pipeline-control";

/**
 * 호출 지점과 같은 상수·함수로 이 프로세스 env를 읽는다. 그 역할과 같은 model env로 실행해야 route 판정이 맞다.
 * 운영 CLI(scripts/ops/pipeline-control.ts)와 관리자 화면이 같이 쓴다 — 화면에서는 웹 프로세스 env 기준이다.
 * 관리자 단계 선택이 있는 text route는 잡과 같은 식(저장된 선택 + 관리자 등록부 덮어쓰기)으로 실제 호출 이름을 따로 담는다(pooled).
 */
export async function currentModelEnv(): Promise<ModelEnv> {
  const [{ TRANSLATE_MODEL, PRODUCT_TRANSLATE_MODEL, KOREAN_TAGLINE_MODEL, SEARCH_QUERY_MODEL }, { TAGLINE_MODEL }, { PROFILE_MODEL }, { VERIFY_MODEL }, { INTRO_CHECK_MODEL }] = await Promise.all([
    import("@/lib/crawl/translate"), import("@/lib/crawl/tagline"),
    import("@/lib/domain/products/search-profile"), import("@/lib/domain/products/search-verify"), import("@/lib/domain/products/intro-check")]);
  const pooled = await pooledTextModels({ "product-search-profile": PROFILE_MODEL, "product-search-verify": VERIFY_MODEL, "reason-translate": TRANSLATE_MODEL,
    "product-translate": PRODUCT_TRANSLATE_MODEL, "product-tagline-ko": KOREAN_TAGLINE_MODEL, "search-query-translate": SEARCH_QUERY_MODEL, "crawl-tagline": TAGLINE_MODEL });
  return { translate: TRANSLATE_MODEL, koreanTagline: KOREAN_TAGLINE_MODEL, searchQuery: SEARCH_QUERY_MODEL, productTranslate: PRODUCT_TRANSLATE_MODEL, tagline: TAGLINE_MODEL,
    profile: PROFILE_MODEL, verify: VERIFY_MODEL, introCheck: INTRO_CHECK_MODEL, ...(pooled ? { pooled } : {}) };
}

/**
 * The text jobs run inside the stored admin stage pools (lib/jobs/registry.ts MODEL_POOL_JOBS) after the serving-contract reload
 * that carries the admin registry overrides; a pooled route then sends the selected key's wire name, not this process's import-time
 * constant (an engine connected directly sends 'gpt-oss-120b', not '[MLX] gpt-oss-120b'). Every selected key is judged, since
 * each lease picks one of them. Unreadable settings keep the env-only judgment.
 */
export async function pooledTextModels(fallbacks: Record<TextModelRoute, string>): Promise<ModelEnv["pooled"]> {
  try {
    const [{ ensureServingContracts }, { getSettings }, { onPrimary }, { withAdminStagePools }, { scopedModel }] = await Promise.all([
      import("@/lib/llm/serving-contract-store"), import("@/lib/crawl/settings"), import("@/lib/db"), import("@/lib/llm/admin-model-pools"),
      import("@/lib/llm/model-registry")]);
    await ensureServingContracts(0);
    const pools = (await onPrimary(getSettings)).stageModelPools ?? {};
    const pooled: Partial<Record<TextModelRoute, string[]>> = {};
    for (const [routeId, fallback] of Object.entries(fallbacks) as [TextModelRoute, string][]) {
      const keys = pools[routeId] ?? [];
      if (keys.length) pooled[routeId] = [...new Set(keys.map(key =>
        withAdminStagePools({ [routeId]: [key] }, `route-judgment:${routeId}`, () => scopedModel(routeId, fallback))))];
    }
    return pooled;
  } catch { return undefined; }
}
