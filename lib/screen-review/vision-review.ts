import { createHash } from "node:crypto";
import type { ReviewInput } from "@/lib/crawl/agent-review-contract";
import { IMPORT_SOURCES, QWEN_VISION_AUTO_SOURCE, QWEN_VISION_M1_SOURCE } from "@/lib/crawl/audit-import-sources";
import { qwenDirectConfig, reviewWithQwenDirect, type QwenDirectConfig, type QwenDirectReview } from "@/lib/crawl/qwen-direct-review";
import { SCREEN_TEXT_LIMIT } from "./protocol";

/**
 * 화면 판별의 모델 묻기 — 운영 v2 글(reviewWithQwenDirect: 정책 글 2026-10-06.2 + v2 덧붙임, json_schema, 검증)을 한 바이트도 바꾸지 않고,
 * 마지막 사용자 메시지만 [글 + 아래 한 단락, 첫 화면 이미지]로 바꾼다. 보류 918건 재판정(2026-10-22, probe-vision.mts — 승인 451·거절 460·오류 7)과
 * 같은 요청이다. 그 판이 2026-10-21.v2+shot1 이고(audit-import-sources.ts qwen-vision-m1), 이 단락이나 이미지 크기를 바꾸면 새 판으로 다시 잰다.
 *
 * 그린 뒤 글이 크롤러의 글보다 길면 product.pageText 를 그것으로 바꾼다(6,000자). 글과 화면은 모두 믿지 않는 증거다: 글은 정책 글이 말하는
 * <untrusted_evidence_json> 안(꺾쇠를 막아 둔다)에 들어가고, 아래 단락은 화면을 'pageText 와 똑같이' 증거로만 보라고 한다.
 */

/** 그 단락 — 재판정 스크립트(probe-vision.mts)의 NOTE 그대로(sha256 은 SCREEN_REVIEW_NOTE_SHA256, 시험이 지킨다) */
export const SCREEN_REVIEW_NOTE = "\n\nAttached image: a screenshot (1280x800, top of the page) of product.url taken today after JavaScript rendering. " +
  "product.pageText above was replaced with the text visible after rendering. Treat what the screenshot visibly shows as evidence about " +
  "product.url, exactly like pageText; cite it with the evidence id \"product\".";
export const SCREEN_REVIEW_NOTE_SHA256 = "24aebe391146a9d6366f4b4de717a35e43a846e2fb73dafce26bd941c96a79e0";

/**
 * 화면 판별 잡의 출처 — 운영 화면 판정(qwen-vision-auto, audit-import-sources.ts SCREEN_REVIEW_SOURCES). 파일로 올린 m1 재판정(qwen-vision-m1)과
 * 출처만 다르고 모델 이름·판은 같다 — 같은 (항목, 모델) 한 줄이라, 화면 판별 대기는 어느 쪽이든 화면 의견이 있으면 다시 묻지 않는다
 */
export const SCREEN_REVIEW_SOURCE = QWEN_VISION_AUTO_SOURCE;
export const SCREEN_REVIEW_PROMPT_VERSION: string = IMPORT_SOURCES[QWEN_VISION_M1_SOURCE].promptVersion;
/**
 * 의견에 적는 모델 이름 = 부른 모델 + '+vision'. 같은 서버의 글만 본 자동 의견(qwen-v2-auto, 같은 모델 이름)을 덮어쓰지 않고, 자동 단계가 서로의
 * 줄을 보고 다시 묻지 않게 한다(audit-import-sources.ts). 모델 갈래(secondOpinionFamily)는 그대로 qwen 이다
 */
export const VISION_MODEL_SUFFIX = "+vision";
export const visionModelName = (model: string): string => `${model}${VISION_MODEL_SUFFIX}`;

/**
 * 화면 판별이 부를 모델 서버 — SCREEN_REVIEW_MODEL_URL·_MODEL·_API_KEY, 없으면 감사 두 번째 의견의 것(AUDIT_SECOND_OPINION_*).
 * 둘 다 m1-studio 의 같은 Qwen(VLM, oMLX)을 가리키는 것이 기본이다. 고칠 수 없는 값이면 null
 */
export function screenModelConfig(env: Readonly<Record<string, string | undefined>> = process.env): QwenDirectConfig | null {
  return qwenDirectConfig({
    AUDIT_SECOND_OPINION_URL: env.SCREEN_REVIEW_MODEL_URL?.trim() || env.AUDIT_SECOND_OPINION_URL,
    AUDIT_SECOND_OPINION_MODEL: env.SCREEN_REVIEW_MODEL?.trim() || env.AUDIT_SECOND_OPINION_MODEL,
    AUDIT_SECOND_OPINION_API_KEY: env.SCREEN_REVIEW_MODEL_API_KEY?.trim() || env.AUDIT_SECOND_OPINION_API_KEY,
  });
}

/** 감사 두 번째 의견과 같은 서버인가 — 같으면 그쪽의 물러나기(qwen-endpoint-backoff.ts)를 따른다 */
export function sharesQwenEndpoint(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const screen = screenModelConfig(env), text = qwenDirectConfig(env);
  return Boolean(screen && text && screen.baseUrl === text.baseUrl);
}

/** 그린 뒤 글이 더 길면 pageText 를 바꾼 입력 — 나머지(증거·README·규칙)는 그대로 */
export function screenInput(input: ReviewInput, renderedText: string): ReviewInput {
  const text = renderedText.slice(0, SCREEN_TEXT_LIMIT).trim();
  if (text.length <= input.snapshot.product.pageText.length) return input;
  return { ...input, snapshot: { ...input.snapshot, product: { ...input.snapshot.product, pageText: text } } };
}

/** 이 판정이 본 것의 지문 — 감사 입력 해시·그린 뒤 글·스크린샷 */
export function screenInputHash(input: ReviewInput, jpeg: Buffer): string {
  return createHash("sha256").update(`${input.inputHash}\n${createHash("sha256").update(input.snapshot.product.pageText).digest("hex")}\n`)
    .update(createHash("sha256").update(jpeg).digest("hex")).digest("hex");
}

/**
 * 운영 요청의 마지막 사용자 메시지를 [글 + 단락, 이미지]로 바꾸는 fetch — 나머지(시스템 글·v2 덧붙임·json_schema·max_tokens…)는 그대로다.
 * 본문이 예상과 다르면(사용자 메시지가 글이 아님) 고치지 않고 던진다 — 이미지 없이 묻지 않게
 */
export function withScreenshot(jpeg: Buffer, base: typeof fetch = fetch): typeof fetch {
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  return (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: unknown }[] };
    const last = [...body.messages].reverse().find((message) => message.role === "user");
    if (!last || typeof last.content !== "string") throw new TypeError("screen_request_shape");
    last.content = [{ type: "text", text: last.content + SCREEN_REVIEW_NOTE }, { type: "image_url", image_url: { url: dataUrl } }];
    return base(url, { ...init, body: JSON.stringify(body) });
  }) as typeof fetch;
}

export type ScreenReview = QwenDirectReview & { recordedModel: string; inputHash: string };

/**
 * 그린 글·화면으로 묻는다 — 성공이면 검증한 판단, 아니면 QwenDirectError(qwen_timeout·qwen_http_<n>·qwen_invalid_json…)를 던진다.
 * DB 트랜잭션 안에서 부르지 않는다
 */
export async function reviewWithScreenshot(input: ReviewInput, jpeg: Buffer, options: {
  config: QwenDirectConfig; timeoutMs: number; signal?: AbortSignal; request?: typeof fetch;
}): Promise<ScreenReview> {
  const env = { AUDIT_SECOND_OPINION_URL: options.config.baseUrl, AUDIT_SECOND_OPINION_MODEL: options.config.model,
    AUDIT_SECOND_OPINION_API_KEY: options.config.apiKey ?? "" };
  const review = await reviewWithQwenDirect(input, { timeoutMs: options.timeoutMs, signal: options.signal, env,
    request: withScreenshot(jpeg, options.request ?? fetch) });
  return { ...review, promptVersion: SCREEN_REVIEW_PROMPT_VERSION, recordedModel: visionModelName(review.model), inputHash: screenInputHash(input, jpeg) };
}
