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

/**
 * 사람 없이 정하는 자동 단계의 확신 하한 — Qwen-v2 의 답은 확신이 있고 이 값 이상일 때만 자동으로 반영한다(보류 걸기·풀기, 공개분 유지,
 * 갈림 판가름 거부, 보류 재심사). 아래면 판단만 남기고 사람에게 둔다(DeepSeek 위임의 하한과 같다)
 */
export const QWEN_AUTO_MIN_CONFIDENCE = 0.9;
/** 확신이 있고 하한 이상인가 */
export const qwenConfident = (confidence: number | null | undefined): boolean => typeof confidence === "number" && confidence >= QWEN_AUTO_MIN_CONFIDENCE;

/**
 * 글이 적은 페이지의 문턱(2026-10-22 사용자 결정 "글이 적은 페이지는 늘 화면을 보고 판정한다") — 수집한 본문(crawl_documents.page_meta.textSample,
 * 감사와 m1 이 product.pageText 로 받는 바로 그 글)이 이 글자 수 아래면 글만 본 판단으로 닫지 않는다(audit-text-gate.ts).
 *
 * 300자인 까닭: (1) 본문은 정적 HTML 에서 스크립트·스타일·SVG 를 걷어 낸 보이는 글이다(lib/net/normalize.ts extractTextSample) — JS 로 그리는
 * 페이지는 여기에 제목·메뉴 몇 낱말만 남는다. 제목만 300자까지 받으므로(page title 상한) 300자 아래는 많아야 제목과 한두 문장이다.
 * (2) 감사 글과 m1 덧붙임은 pageText 가 비었거나 제목뿐이면 거절하라고 한다(qwen-direct-review.ts QWEN_V2_ADDENDUM 4번) — 그 거절은 화면을
 * 본 판단이 아니라 글이 없다는 사실이다. (3) m1 화면 재판정(audit-import-sources.ts qwen-vision-m1)이 브라우저로 다시 그린 보류 918건을 고른
 * 문턱(보이는 정적 글 300자 아래)과 같다. 운영 분포는 재지 않았다 — 바꾸려면 이 값 하나다(JS·SQL 이 같이 읽는다)
 */
export const THIN_PAGE_TEXT_CHARS = 300;

/** 수집 본문이 적은가 — 감사 입력과 같은 자르기(앞 6천 자·앞뒤 공백 없음)로, 글자(코드 포인트) 수를 센다(SQL char_length 와 같다). 없으면 적다 */
export function thinPageText(text: string | null | undefined): boolean {
  return [...(text ?? "").slice(0, 6_000).trim()].length < THIN_PAGE_TEXT_CHARS;
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
