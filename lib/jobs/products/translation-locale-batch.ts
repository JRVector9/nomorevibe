/**
 * 제품 번역 한 묶음에는 한 언어만 담는다(2026-11-17).
 *
 * 예전에는 수요 순서(갱신 시각·제품·언어·칸)대로 앞의 4건을 그대로 묶어 같은 제품의 en·ja·zh-Hans 가 한 요청에 섞였다.
 * M1Max Qwen3.8-27B 실측(운영 wire 그대로 50묶음, main a9c53498):
 * zh-Hans 뒤에 처음 나온 ja 는 34건 중 18건이 not_japanese(16건 중국어 간체), 묶음 맨 앞의 ja 는 16건 중 0건 — 모델이 앞 항목의 중국어를 이어 쓴다. 시스템 문장은 바꾸지 않고
 * (M1Max 프롬프트 캐시 공통 앞부분 유지) 묶음 구성만 바꾼다 — 모델·제공자와 무관하게 순위의 모든 경로에 같은 묶음이 간다.
 *
 * 맨 앞(가장 오래 기다린) 건의 언어를 고르고 같은 언어만 남긴다 — 맨 앞 건은 늘 들어가므로 어느 언어도 굶지 않는다.
 * 남은 다른 언어 건은 다른 줄·다음 틱의 묶음이 다시 고른다(넘김 기록 없음). 순서·글자 임계·최대 건수는 packProductTranslationBatch 그대로다.
 *
 * 창 16: 운영 대기 155,429건(2026-11-17, en 47,253·zh-Hans 55,448·ja 52,728)을 같은 순서로 모의하면 호출 수가
 * 예전 4건 그대로 38,858 → 창 8 43,662(+12.4%) · 창 16 40,800(+5.0%). 섞인 묶음은 19,365(ja+zh-Hans 5,758) → 0.
 */
export const PRODUCT_TRANSLATION_CANDIDATE_WINDOW = 16;

export function sameLocaleTranslationCandidates<T extends { locale: string }>(tasks: readonly T[]): T[] {
  const locale = tasks[0]?.locale;
  return tasks.filter(task => task.locale === locale);
}
