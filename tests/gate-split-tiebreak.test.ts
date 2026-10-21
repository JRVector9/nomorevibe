import { describe, expect, it } from "vitest";
import type { SecondReviewStatus } from "@/lib/db/schema";
import { splitRejectVerdict } from "@/lib/crawl/gate-split-tiebreak";
import { QWEN_V2_AUTO_SOURCE } from "@/lib/crawl/qwen-direct-review";
import { SPLIT_TIEBREAK_ACTOR, TIEBREAK_APPROVE_BADGE, TIEBREAK_AWAITING_BADGE, TIEBREAK_DAILY_CAP_BADGE, TIEBREAK_DEEPSEEK_UNCONFIRMED_BADGE,
  tiebreakApproved, tiebreakBadge, tiebreakDeepseekLine, tiebreakSummary } from "@/app/(operator)/admin/review/tiebreak";
import { deepseekEndpointError, SPLIT_CONFIRM_DEEPSEEK_MIN_CONFIDENCE, SPLIT_CONFIRM_TIMEOUT_MS } from "@/lib/crawl/gate-split-confirm";
import { DEEPSEEK_MIN_CONFIDENCE } from "@/lib/crawl/deepseek-review-policy";

/** 2차 갈림 판가름의 순수한 부분 — 다수 규칙, 화면 문구 */
const vote = (secondDecision: string | null, extra: { model?: string; status?: SecondReviewStatus; secondReason?: string; firstModel?: string } = {}) => ({
  status: extra.status ?? "needs_human" as SecondReviewStatus, secondDecision, secondReason: extra.secondReason ?? "Only a docs page",
  model: extra.model ?? "[MLX] qwen3.8-27b", firstModel: extra.firstModel ?? "grok-4.7",
});
const QWEN = "qwen3.8-flash-next";

describe("splitRejectVerdict", () => {
  it("독립 모델의 거부가 있고 승인이 없을 때만 거부를 다수로 본다(1차 승인 1 : 거부 2)", () => {
    expect(splitRejectVerdict([vote("reject")], { decision: "reject", reason: "A placeholder page." }, QWEN)).toBe("apply");
    // 다른 2차 모델이 보류했어도 거부가 둘이다
    expect(splitRejectVerdict([vote("reject"), vote("needs_review", { model: "grok-4.7-fast" })], { decision: "reject", reason: "Empty." }, QWEN)).toBe("apply");
  });

  it("승인 표가 있거나 거부 표가 없으면 다수가 아니다", () => {
    // 1차 확신이 낮아 2차가 승인했는데도 사람에게 넘어온 것
    expect(splitRejectVerdict([vote("approve")], { decision: "reject", reason: "Empty." }, QWEN)).toBe("minority");
    expect(splitRejectVerdict([vote("needs_review")], { decision: "reject", reason: "Empty." }, QWEN)).toBe("minority");
    // 3회 실패로 넘어온 것 — 표가 없다
    expect(splitRejectVerdict([vote(null)], { decision: "reject", reason: "Empty." }, QWEN)).toBe("minority");
    expect(splitRejectVerdict([vote("reject"), vote("approve", { model: "b", status: "agreed" })], { decision: "reject", reason: "Empty." }, QWEN)).toBe("minority");
  });

  it("1차와 같은 모델·Qwen-v2 와 같은 모델의 거부는 독립 표가 아니다", () => {
    expect(splitRejectVerdict([vote("reject", { model: "grok-4.7" })], { decision: "reject", reason: "Empty." }, QWEN)).toBe("minority");
    expect(splitRejectVerdict([vote("reject", { model: `[gpu3090] ${QWEN}` })], { decision: "reject", reason: "Empty." }, QWEN)).toBe("minority");
  });

  it("카탈로그·디렉터리 같은 거부는 Qwen 의 거부로 세지 않는다 — 어느 쪽 사유든", () => {
    expect(splitRejectVerdict([vote("reject")], { decision: "reject", reason: "A curated directory of AI tools." }, QWEN)).toBe("catalog");
    expect(splitRejectVerdict([vote("reject", { secondReason: "An awesome list of links." })], { decision: "reject", reason: "Empty." }, QWEN)).toBe("catalog");
  });

  it("거부가 아니면 닫지 않는다", () => {
    expect(splitRejectVerdict([vote("reject")], { decision: "approve", reason: "Usable." }, QWEN)).toBe("not_reject");
    expect(splitRejectVerdict([vote("reject")], { decision: "needs_review", reason: "Unsure." }, QWEN)).toBe("not_reject");
  });
});

// 스위치 읽기(없거나 깨지면 꺼짐)·폼 판은 tests/qwen-auto-settings.test.ts(qwenAuto.splitTiebreak)가 본다

describe("심사 큐 문구", () => {
  const view = { decision: "approve" as const, confidence: 0.95, reason: "Usable", model: QWEN, promptVersion: "2026-10-21.v2",
    applied: "kept_human", at: null, current: true, deepseek: null };
  it("결정 기록의 actor 는 공용 제공자의 출처와 같다", () => expect(SPLIT_TIEBREAK_ACTOR).toBe(QWEN_V2_AUTO_SOURCE));
  it("지금 세대의 승인에만 배지를 단다", () => {
    expect(tiebreakApproved(view)).toBe(true);
    expect(tiebreakApproved({ ...view, current: false })).toBe(false);
    expect(tiebreakApproved({ ...view, decision: "reject" })).toBe(false);
    expect(tiebreakApproved(null)).toBe(false);
  });
  it("답과 처리를 한 줄로 적는다", () => {
    expect(tiebreakSummary(view)).toBe("승인 · 발행하지 않고 사람 확인을 기다립니다");
    expect(tiebreakSummary({ ...view, decision: "reject", applied: "held_catalog", current: false }))
      .toBe("거부 · 카탈로그·디렉터리 거부는 세지 않아 사람 확인으로 남겼습니다 · 지난 입력의 답");
  });
});

describe("DeepSeek 확인 — 배지·문구·문턱", () => {
  const reject = { decision: "reject" as const, confidence: 0.97, reason: "Placeholder", model: QWEN, promptVersion: "2026-10-21.v2",
    at: null, current: true };
  const deepseek = (decision: string | null, confidence: number | null = 0.8, errorCode: string | null = null) =>
    ({ state: decision ? "succeeded" : errorCode ? "failed" : "waiting", model: "deepseek-v4.1-flash-1017", decision, confidence, reason: "x", errorCode });

  it("Qwen 거부의 갈래마다 배지가 다르다 — 확인 대기 · 확인 안 됨(승인·보류·실패) · 하루 상한. 승인 배지는 그대로", () => {
    expect(tiebreakBadge({ ...reject, decision: "approve", applied: "kept_human", deepseek: null })?.label).toBe(TIEBREAK_APPROVE_BADGE);
    expect(tiebreakBadge({ ...reject, applied: "awaiting_deepseek", deepseek: deepseek(null) })).toMatchObject({ label: TIEBREAK_AWAITING_BADGE, tone: "neutral" });
    expect(tiebreakBadge({ ...reject, applied: "awaiting_deepseek", deepseek: deepseek(null, null, "timeout") }))
      .toMatchObject({ label: TIEBREAK_DEEPSEEK_UNCONFIRMED_BADGE, tone: "warn" });
    for (const applied of ["held_deepseek", "held_deepseek_error"]) {
      expect(tiebreakBadge({ ...reject, applied, deepseek: deepseek("approve", 0.9) })?.label, applied).toBe(TIEBREAK_DEEPSEEK_UNCONFIRMED_BADGE);
    }
    expect(tiebreakBadge({ ...reject, applied: "held_daily_cap", deepseek: deepseek("reject", 0.8) })?.label).toBe(TIEBREAK_DAILY_CAP_BADGE);
    expect(TIEBREAK_DAILY_CAP_BADGE).toContain("하루 상한");
    // 지난 세대·다른 처리에는 배지가 없다
    expect(tiebreakBadge({ ...reject, applied: "held_daily_cap", current: false, deepseek: deepseek("reject") })).toBeNull();
    expect(tiebreakBadge({ ...reject, applied: "held_catalog", deepseek: null })).toBeNull();
    expect(tiebreakBadge({ ...reject, applied: "held_deepseek", deepseek: deepseek("needs_review", 0.5) })?.title).toContain("DeepSeek needs_review 0.50");
  });

  it("상세는 두 판단을 함께 적는다", () => {
    expect(tiebreakSummary({ ...reject, applied: "rejected", deepseek: deepseek("reject", 0.78) })).toBe("거부 · 두 모델(Qwen-v2·DeepSeek)이 따로 거부해 닫았습니다");
    expect(tiebreakSummary({ ...reject, applied: "held_daily_cap", deepseek: deepseek("reject") })).toContain("하루 자동 거부 상한");
    expect(tiebreakDeepseekLine({ ...reject, applied: "held_deepseek", deepseek: deepseek("approve", 0.92) }))
      .toBe("DeepSeek 승인 · 확신 0.92 · deepseek-v4.1-flash-1017");
    expect(tiebreakDeepseekLine({ ...reject, applied: "awaiting_deepseek", deepseek: deepseek(null, null, "http_503") })).toBe("DeepSeek 확인 실패 · http_503");
    expect(tiebreakDeepseekLine({ ...reject, applied: "held_catalog", deepseek: null })).toBeNull();
  });

  it("DeepSeek 확인의 문턱은 이 길만의 0.70 — 사람 검토 위임의 0.90 은 그대로. 한 호출은 45초까지", () => {
    expect(SPLIT_CONFIRM_DEEPSEEK_MIN_CONFIDENCE).toBe(0.7);
    expect(DEEPSEEK_MIN_CONFIDENCE).toBe(0.9);
    expect(SPLIT_CONFIRM_TIMEOUT_MS).toBe(45_000);
  });

  it("부르는 곳의 탈만 물러나고 항목의 실패로 세지 않는다", () => {
    for (const code of ["timeout", "unreachable", "model_mismatch", "http_503", "http_429", "http_404"]) expect(deepseekEndpointError(code), code).toBe(true);
    for (const code of ["invalid_response", "incomplete_response", "input_too_large", "http_400", "cancelled"]) expect(deepseekEndpointError(code), code).toBe(false);
  });
});

describe("DeepSeek 원래 답과 위임의 문턱", async () => {
  const { reviewWithDeepSeek, reviewWithDeepSeekRaw } = await import("@/lib/crawl/deepseek-review");
  const { createReviewInput } = await import("@/lib/crawl/agent-review-contract");
  const { DEFAULT_CRAWL_SETTINGS } = await import("@/lib/crawl/settings-schema");
  const { DEEPSEEK_REVIEW_MODEL } = await import("@/lib/crawl/deepseek-review-policy");
  const now = new Date();
  const input = createReviewInput({ repo: "acme/demo", productUrl: "https://demo.example", judgedAt: now } as never,
    { id: 1, repo: "acme/demo", productUrl: "https://demo.example", repoMeta: { description: "A task tracker" },
      pageMeta: { title: "Demo", textSample: "Coming soon" }, pageStatus: 200, fetchedAt: now } as never,
    DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
  const answer = (confidence: number) => (async () => new Response(JSON.stringify({ model: DEEPSEEK_REVIEW_MODEL, choices: [{ finish_reason: "stop",
    message: { content: JSON.stringify({ decision: "reject", reason: "Only a placeholder.", evidenceIds: ["product"], confidence }) } }] }))) as unknown as typeof fetch;

  it("갈림 판가름 확인은 원래 답(확신 0.78 거부)을 받고, 위임은 같은 답을 0.90 문턱으로 판단 보류로 본다", async () => {
    expect(await reviewWithDeepSeekRaw(input, { request: answer(0.78) })).toMatchObject({ ok: true, outcome: { decision: "reject", confidence: 0.78 } });
    expect(await reviewWithDeepSeek(input, { request: answer(0.78) })).toMatchObject({ ok: true, outcome: { decision: "needs_review", confidence: 0.78 } });
    expect(await reviewWithDeepSeek(input, { request: answer(0.95) })).toMatchObject({ ok: true, outcome: { decision: "reject" } });
  });

  it("응답 전에 끊기면 확인 쪽은 unreachable(부르는 곳의 탈), 위임은 예전처럼 invalid_response", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await reviewWithDeepSeekRaw(input, { request: down })).toEqual({ ok: false, error: "unreachable" });
    expect(await reviewWithDeepSeek(input, { request: down })).toEqual({ ok: false, error: "invalid_response" });
    const garbage = (async () => new Response("not json")) as unknown as typeof fetch;
    expect(await reviewWithDeepSeekRaw(input, { request: garbage })).toEqual({ ok: false, error: "invalid_response" });
  });
});
