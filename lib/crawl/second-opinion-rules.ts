import { classifyAuditReason } from "./audit-reason-category";

/**
 * 두 번째 의견의 모델별 규칙(2026-10-21) — 브라우저도 쓰므로 DB·서버 모듈을 끌어오지 않는다. 같은 규칙의 SQL 은 audit-second-opinions.ts 에 있다.
 */

/**
 * 모델 갈래 — 'qwen3.8-flash-next' → 'qwen', 'grok-4.7' → 'grok', '[gpu3090] qwen3.8-flash-next' → 'qwen'.
 * 감사 화면의 배지('qwen: 거절')와 보류 규칙(SECOND_OPINION_REJECT_RULES)이 같은 갈래를 쓴다. 영문자로 시작하지 않으면 이름 그대로(소문자)
 */
export function secondOpinionFamily(model: string): string {
  const name = model.trim().replace(/^\[[^\]]*\]\s*/, "").toLowerCase();
  return /^[a-z]+/.exec(name)?.[0] ?? name;
}

/**
 * 같은 모델인가 — 게이트웨이는 같은 모델에 '[gpu3090] ' 같은 자리 표시를 붙여 부른다(qwen-direct-review.ts 는 붙이지 않는다).
 * 앞의 대괄호 덩이를 떼고 대소문자 없이 견준다
 */
export function sameOpinionModel(a: string | null | undefined, b: string | null | undefined): boolean {
  const bare = (model: string) => model.trim().replace(/^\[[^\]]*\]\s*/, "").toLowerCase();
  return Boolean(a && b && bare(a) && bare(a) === bare(b));
}

/** 카탈로그·디렉터리 같은 항목을 가르는 낱말 — 감사 사유(감사 모델이 쓴 사유)에서 찾는다. SQL 쪽은 같은 글을 ~* 로 쓴다 */
export const CATALOG_LIKE_REASON = /directory|catalog|awesome|curated list|list of/i;

/** 감사 사유가 카탈로그·디렉터리 같은가 — 사유 갈래가 '남의 플랫폼·목록 페이지'(platform)이거나 위 낱말이 있다 */
export function catalogLikeAuditReason(reason: string | null | undefined): boolean {
  return classifyAuditReason(reason) === "platform" || CATALOG_LIKE_REASON.test(reason ?? "");
}

/**
 * 모델 갈래마다 두 번째 거절을 보류의 까닭으로 셀지. 표에 없는 갈래는 늘 센다(grok 일괄이 그랬다 — 0110).
 * qwen(except_catalog): 카탈로그·디렉터리 같은 항목의 거절은 세지 않는다. Qwen-v2 는 진짜 둘러보기 카탈로그(갈래별 도구 디렉터리 같은 것)를
 * 가끔 거절했고(2026-10-21 50건 표본), 확신이 늘 0.95 나 1 이라 문턱으로 가를 수 없다. 그 항목은 목록에 둔 채 사람이 '갈림'에서 본다.
 */
export const SECOND_OPINION_REJECT_RULES = { grok: "counts", qwen: "except_catalog" } as const satisfies Record<string, "counts" | "except_catalog">;
export type SecondOpinionRejectRule = (typeof SECOND_OPINION_REJECT_RULES)[keyof typeof SECOND_OPINION_REJECT_RULES];

export function secondOpinionRejectRule(model: string): SecondOpinionRejectRule {
  const family = secondOpinionFamily(model);
  return Object.hasOwn(SECOND_OPINION_REJECT_RULES, family) ? SECOND_OPINION_REJECT_RULES[family as keyof typeof SECOND_OPINION_REJECT_RULES] : "counts";
}

/** 카탈로그 예외가 걸린 모델 갈래 — SQL 이 같은 표를 읽는다 */
export const CATALOG_EXCEPTION_FAMILIES: readonly string[] = Object.entries(SECOND_OPINION_REJECT_RULES)
  .flatMap(([family, rule]) => rule === "except_catalog" ? [family] : []);

/** 이 모델의 거절이 이 감사 항목(감사 사유)에서 보류의 까닭이 되는가 */
export function secondRejectHolds(model: string, auditReason: string | null | undefined): boolean {
  return secondOpinionRejectRule(model) === "counts" || !catalogLikeAuditReason(auditReason);
}
