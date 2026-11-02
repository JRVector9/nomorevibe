import type { ModelEnv, TextModelRoute } from "./pipeline-control";

/**
 * 호출 지점이 resolver 에 넘기는 모델을 이 프로세스에서 읽는다. 운영 CLI(scripts/ops/pipeline-control.ts)와 관리자 화면이 같이 쓴다.
 * 2026-11-02(PR B): 글 짓기·번역·검색 text 일곱 경로는 「작업 ↔ 모델」 순위(ai_task_models)가 모델을 고른다 — 잡과 같은 resolver
 * (lib/llm/ai-task-resolver.ts)로 순위마다 장부 이름(identity)을 담는다(pooled, 순위 차례). 환경변수·단계 풀·등록부 기본값은 읽지 않는다.
 * 그 연결의 계약에 묶인 순위만 담는다(부를 수 있는 이름만 — text 진행 판정이 「부를 수 있다」로 읽는다). 묶인 순위가 없으면 빈 이름(판정이 「모름」) —
 * 까닭(순위 없음·계약 없음)은 잡의 degraded 와 /admin/models/tasks 가 보인다.
 * 소개 검수(introCheck)는 아직 예전 설정이다(PR C).
 */
export async function currentModelEnv(): Promise<ModelEnv> {
  const [{ INTRO_CHECK_MODEL }, { pooled, keyMissing }] = await Promise.all([import("@/lib/domain/products/intro-check"), rankedTextRoutes()]);
  const first = (route: TextModelRoute) => pooled[route]?.[0] ?? "";
  return { translate: first("reason-translate"), koreanTagline: first("product-tagline-ko"), searchQuery: first("search-query-translate"),
    productTranslate: first("product-translate"), tagline: first("crawl-tagline"), profile: first("product-search-profile"),
    verify: first("product-search-verify"), introCheck: INTRO_CHECK_MODEL, pooled, ...(keyMissing.length ? { keyMissing } : {}) };
}

/** text 일곱 경로의 묶인 순위 → 장부 이름(순위 차례). 읽지 못하면 빈 목록. */
export async function rankedTextModels(): Promise<Partial<Record<TextModelRoute, readonly string[]>>> {
  return (await rankedTextRoutes()).pooled;
}

/**
 * rankedTextModels 와 같은 읽기 + 묶인 순위가 하나도 없고 모든 순위가 「연결에 키가 없음」뿐인 경로(keyMissing) — OPEN 이 그 경로를
 * 「모름」(미룸)으로 세어 배포를 막지 않게 한다(key_missing, 2026-11-02 사람 결정 「키 없어도 배포는 되게」). 읽지 못하면 둘 다 비어 있다.
 */
export async function rankedTextRoutes(): Promise<{ pooled: Partial<Record<TextModelRoute, readonly string[]>>; keyMissing: TextModelRoute[] }> {
  try {
    const [{ TextTaskRanks }, { AI_TEXT_TASK_IDS, onlyKeyMissing }] = await Promise.all([import("@/lib/llm/ai-task-resolver"), import("@/lib/llm/ai-tasks")]);
    const pooled: Partial<Record<TextModelRoute, readonly string[]>> = {}, keyMissing: TextModelRoute[] = [];
    for (const route of AI_TEXT_TASK_IDS) {
      const ranks = await TextTaskRanks.open(route);
      pooled[route] = ranks.bindings().map(binding => binding.identity);
      if (!pooled[route]!.length && onlyKeyMissing(ranks.resolution.candidates.map(candidate => candidate.unusable))) keyMissing.push(route);
    }
    return { pooled, keyMissing };
  } catch { return { pooled: {}, keyMissing: [] }; }
}
