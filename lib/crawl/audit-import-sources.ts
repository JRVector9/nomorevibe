import { QWEN_AUTO_MIN_CONFIDENCE } from "./second-opinion-rules";

/**
 * 두 번째 의견 파일 올리기(0116)의 출처와 줄 읽기 — 화면(브라우저, 출처 알아맞히기)과 서버(lib/crawl/audit-second-opinion-upload.ts)가 같이 쓴다.
 * DB 를 끌어오지 않는다.
 *
 * grok-cli-batch: 2026-10-21 grok CLI 일괄(JSONL) — auditResultId·productId·grokDecision·grokConfidence·grokReason·model·inputHash·error.
 *   CLI(scripts/ops/import-audit-second-opinions.ts)와 같은 모양이다.
 * qwen-vision-m1: 2026-10-22 m1-studio Qwen(qwen3.8-flash-next)의 보류 재판정 — 크롤러가 글을 읽지 못한(JS 로 그리는) 보류 918건을
 *   브라우저로 그려 그린 뒤의 글과 첫 화면 스크린샷(1280×800)을 함께 운영 v2 글(QWEN_V2_PROMPT_VERSION)에 물었다. 줄은
 *   slug·itemId·name·url·before·after·shot·ms·decision·confidence·reason(실패면 error·detail). productId 가 없어 항목의 제품 slug 와 견준다.
 *   같은 (항목, 모델) 한 줄 규칙(product_audit_second_opinions_item_model_idx) 때문에 모델 이름에 '+vision'을 붙인다 — 붙이지 않으면 같은
 *   서버의 글만 본 자동 의견(qwen-v2-auto, 같은 모델 이름)을 덮어쓰고, 자동 단계가 판이 다른 그 줄을 보고 다시 물어 거꾸로 덮어쓴다.
 *   모델 갈래(secondOpinionFamily)는 그대로 qwen 이다 — Qwen 거절의 카탈로그 예외가 그대로 걸린다.
 */

export type ImportFormat = "grok" | "vision";
export type ImportSourceSpec = {
  label: string; format: ImportFormat;
  /** 이 출처의 의견을 적을 모델 이름 — null 이면 줄의 model */
  model: string | null;
  /** 그 의견을 받은 글의 판 — null 이면 없음(grok 일괄) */
  promptVersion: string | null;
  /** 스크린샷까지 본 판정인가 — 대체(supersede)는 이 출처의 승인만 텍스트만 본 거절을 대신할 수 있다 */
  screenshot: boolean;
  /** 보류에서 셀 때의 확신 하한(승인·거절 모두) — 없으면 늘 센다 */
  confidenceFloor: number | null;
  hint: string;
};

export const QWEN_VISION_M1_SOURCE = "qwen-vision-m1";

export const IMPORT_SOURCES = {
  "grok-cli-batch": { label: "grok 일괄(JSONL)", format: "grok", model: null, promptVersion: null, screenshot: false, confidenceFloor: null,
    hint: "auditResultId·productId·grokDecision·grokConfidence·grokReason·model 줄" },
  [QWEN_VISION_M1_SOURCE]: { label: "m1 Qwen 화면+글 재판정", format: "vision", model: "qwen3.8-flash-next+vision",
    promptVersion: "2026-10-21.v2+shot1", screenshot: true, confidenceFloor: QWEN_AUTO_MIN_CONFIDENCE,
    hint: "slug·itemId·decision·confidence·reason·shot 줄 — JS 로 그린 뒤의 글과 첫 화면 스크린샷을 함께 본 판정" },
} as const satisfies Record<string, ImportSourceSpec>;
export type ImportSource = keyof typeof IMPORT_SOURCES;
export const IMPORT_SOURCE_KEYS = Object.keys(IMPORT_SOURCES) as ImportSource[];

export function isImportSource(value: unknown): value is ImportSource {
  return typeof value === "string" && Object.hasOwn(IMPORT_SOURCES, value);
}

/** 스크린샷까지 본 출처 — 대체가 '텍스트만 본 거절'을 가를 때 이 출처의 의견은 텍스트만 본 것으로 치지 않는다 */
export const SCREENSHOT_SOURCES: ReadonlySet<string> = new Set(IMPORT_SOURCE_KEYS.filter((key) => IMPORT_SOURCES[key].screenshot));

/** 보류에서 셀 때 확신 하한이 있는 출처 — product-audit-hold.ts countedOpinion·audit-second-opinions.ts countedSecondReject 가 읽는다 */
export const CONFIDENCE_FLOOR_SOURCES: Readonly<Record<string, number>> = Object.fromEntries(IMPORT_SOURCE_KEYS
  .flatMap((key) => IMPORT_SOURCES[key].confidenceFloor === null ? [] : [[key, IMPORT_SOURCES[key].confidenceFloor as number]]));

export type ImportDecision = "approve" | "reject" | "needs_review";
/** 읽어 고친 한 줄 — 서버가 항목과 견준다(grok 은 productId, 화면 재판정은 slug) */
export type ImportOpinion = {
  itemId: number; productId: number | null; slug: string | null; model: string; decision: ImportDecision; confidence: number | null;
  reason: string | null; inputHash: string | null; shot: boolean;
};
export type ImportLineSkip = "error" | "invalid";

const DECISIONS = new Set(["approve", "reject", "needs_review"]);
const REASON_LIMIT = 2_000;
/** 한 줄의 길이 상한 — 사유 2천 자에 다른 칸을 더해도 넉넉하다. 넘으면 잘못 고른 파일이다 */
export const IMPORT_LINE_LIMIT = 16_000;

const failed = (value: Record<string, unknown>) => value.error !== undefined && value.error !== null && value.error !== "" && value.error !== false;
const positive = (value: unknown) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};
const confidenceOf = (value: unknown): number | null | undefined => {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : undefined;
};
const text = (value: unknown, limit: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;

/** JSONL 한 줄(글자)을 읽는다. 실패가 적힌 줄은 error, 모양이 틀린 줄은 invalid */
export function parseImportLine(source: ImportSource, raw: string): ImportOpinion | ImportLineSkip {
  if (raw.length > IMPORT_LINE_LIMIT) return "invalid";
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return "invalid"; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const line = value as Record<string, unknown>;
  if (failed(line)) return "error";
  const spec: ImportSourceSpec = IMPORT_SOURCES[source];
  if (spec.format === "grok") {
    const itemId = positive(line.auditResultId), productId = positive(line.productId);
    const model = text(line.model, 161);
    const confidence = confidenceOf(line.grokConfidence);
    if (!itemId || !productId || !model || model.length > 160 || typeof line.grokDecision !== "string" || !DECISIONS.has(line.grokDecision)
      || confidence === undefined) return "invalid";
    return { itemId, productId, slug: null, model: spec.model ?? model, decision: line.grokDecision as ImportDecision, confidence,
      reason: text(line.grokReason, REASON_LIMIT), inputHash: text(line.inputHash, 128), shot: false };
  }
  const itemId = positive(line.itemId);
  const slug = text(line.slug, 81);
  const confidence = confidenceOf(line.confidence);
  if (!itemId || !slug || slug.length > 80 || typeof line.decision !== "string" || !DECISIONS.has(line.decision) || confidence === undefined) return "invalid";
  return { itemId, productId: null, slug, model: spec.model ?? "unknown", decision: line.decision as ImportDecision, confidence,
    reason: text(line.reason, REASON_LIMIT), inputHash: null, shot: line.shot === true };
}

/** 파일 앞의 줄로 출처를 알아맞힌다 — 화면이 고르기 상자의 처음 값으로 쓴다(사람이 바꿀 수 있다) */
export function detectImportSource(lines: readonly string[]): ImportSource | null {
  for (const raw of lines.slice(0, 20)) {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { continue; }
    if (!value || typeof value !== "object") continue;
    const line = value as Record<string, unknown>;
    if ("grokDecision" in line || "auditResultId" in line) return "grok-cli-batch";
    if ("itemId" in line && "slug" in line && ("shot" in line || "decision" in line)) return QWEN_VISION_M1_SOURCE;
  }
  return null;
}
