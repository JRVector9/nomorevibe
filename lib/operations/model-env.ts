import type { ModelEnv } from "./pipeline-control";

/**
 * 호출 지점과 같은 상수·함수로 이 프로세스 env를 읽는다. 그 역할과 같은 model env로 실행해야 route 판정이 맞다.
 * 운영 CLI(scripts/ops/pipeline-control.ts)와 관리자 화면이 같이 쓴다 — 화면에서는 웹 프로세스 env 기준이다.
 */
export async function currentModelEnv(): Promise<ModelEnv> {
  const [{ reviewModel }, { TRANSLATE_MODEL, PRODUCT_TRANSLATION_MODEL }, { TAGLINE_MODEL }, { PROFILE_MODEL }, { VERIFY_MODEL }, { INTRO_CHECK_MODEL }] = await Promise.all([
    import("@/lib/crawl/agent-review"), import("@/lib/crawl/translate"), import("@/lib/crawl/tagline"),
    import("@/lib/domain/products/search-profile"), import("@/lib/domain/products/search-verify"), import("@/lib/domain/products/intro-check")]);
  return { crawlReview: reviewModel(), translate: TRANSLATE_MODEL, productTranslate: PRODUCT_TRANSLATION_MODEL, tagline: TAGLINE_MODEL,
    profile: PROFILE_MODEL, verify: VERIFY_MODEL, introCheck: INTRO_CHECK_MODEL };
}
