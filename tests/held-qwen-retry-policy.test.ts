import { describe, expect, it } from "vitest";
import { heldQwenGateable, heldQwenGateFirst, heldQwenIndependentVoters, heldQwenOwnedReasons, heldQwenOwns, heldQwenSameModelFallback } from "@/lib/crawl/held-qwen-retry-policy";
import { sameReviewModel, sameUnderlyingModel } from "@/lib/crawl/review-model-identity";
import { combineVerdicts } from "@/lib/crawl/second-review";
import { mergeWithDefaults, storedQwenAuto } from "@/lib/crawl/settings";
import { DEFAULT_CRAWL_SETTINGS, DEFAULT_HELD_QWEN_RETRY, DEFAULT_QWEN_AUTO, type CrawlSettings } from "@/lib/crawl/settings-schema";

/** 보류 재심사를 켠 설정 — 기본은 꺼짐이다(qwenAuto.heldRetry) */
const ON = { ...DEFAULT_HELD_QWEN_RETRY, enabled: true };
const settings = (patch: Partial<CrawlSettings> = {}): CrawlSettings => ({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "enforce",
  qwenAuto: { ...DEFAULT_QWEN_AUTO, heldRetry: ON },
  secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, enabled: true,
    voters: [{ provider: "abcllm", model: "[gpu3090] qwen3.8-flash-next" }, { provider: "abcllm", model: "[MLX] gpt-oss-120b" }] }, ...patch });
type Row = Parameters<typeof heldQwenGateFirst>[1];
const attempt: Row = { id: 41, kind: "delegated", provider: "qwen-direct", actor: "qwen-v2:2026-10-21.v2", state: "succeeded",
  outcome: { decision: "approve", reason: "ok", evidenceIds: ["product"], confidence: 0.95 }, model: "qwen3.8-flash-next" };
/** applyOutcome 이 관문에 넣은 승인 — 후보 signals.heldQwenAttemptId 가 그 시도 id 다 */
const applied = { signals: { heldQwenAttemptId: 41 } };

describe("보류 Qwen-v2 재심사 정책", () => {
  it("기본값은 꺼짐·세 사유·한 틱 10건이고, 켜도 적용 모드에서만 맡는다", () => {
    expect(DEFAULT_CRAWL_SETTINGS.qwenAuto.heldRetry).toEqual({ enabled: false, perTick: 10, budgetSeconds: 40,
      reasons: ["no_description", "ai_review_exhausted", "ambiguous"] });
    expect(heldQwenOwns({ ...settings(), qwenAuto: DEFAULT_QWEN_AUTO }, "ai_review_exhausted")).toBe(false);
    expect(heldQwenOwns(settings(), "ai_review_exhausted")).toBe(true);
    expect(heldQwenOwns(settings(), "repo_deleted")).toBe(false);
    expect(heldQwenOwns(settings(), "suspected_spam")).toBe(false);
    expect(heldQwenOwns(settings({ reviewMode: "observe" }), "ambiguous")).toBe(false);
    expect(heldQwenOwnedReasons(settings({ enabled: false }))).toEqual([]);
    // 칸이 없는 부분 설정은 꺼진 것으로 읽는다
    expect(heldQwenOwns({ enabled: true, reviewMode: "enforce" } as CrawlSettings, "ambiguous")).toBe(false);
  });

  it("게이트웨이 이름표만 다른 같은 Qwen 은 독립 투표자가 아니다", () => {
    expect(heldQwenIndependentVoters(settings(), "qwen3.8-flash-next").map((voter) => voter.model)).toEqual(["[MLX] gpt-oss-120b"]);
    const onlyQwen = settings({ secondReview: { ...settings().secondReview, voters: [{ provider: "abcllm", model: "[gpu3090] qwen3.8-flash-next" }] } });
    expect(heldQwenGateable(onlyQwen, "qwen3.8-flash-next")).toBe(false);
    expect(heldQwenGateFirst(onlyQwen, attempt, applied)).toBe(false);
    expect(heldQwenGateable(settings(), "qwen3.8-flash-next")).toBe(true);
  });

  it("관문은 켜진 스위치·적용 모드·2차 심사·성공한 승인 행에서만 Qwen-v2 를 1차 승인으로 받는다", () => {
    expect(heldQwenGateFirst(settings(), attempt, applied)).toBe(true);
    expect(heldQwenGateFirst(settings({ qwenAuto: { ...DEFAULT_QWEN_AUTO, heldRetry: { ...ON, enabled: false } } }), attempt, applied)).toBe(false);
    expect(heldQwenGateFirst(settings({ secondReview: { ...settings().secondReview, enabled: false } }), attempt, applied)).toBe(false);
    expect(heldQwenGateFirst(settings({ reviewMode: "observe" }), attempt, applied)).toBe(false);
    expect(heldQwenGateFirst(settings(), { ...attempt, state: "failed" }, applied)).toBe(false);
    expect(heldQwenGateFirst(settings(), { ...attempt, outcome: { ...attempt.outcome!, decision: "needs_review" } }, applied)).toBe(false);
    expect(heldQwenGateFirst(settings(), { ...attempt, provider: "m3-deepseek", actor: "m3-deepseek:3" }, applied)).toBe(false);
    expect(heldQwenGateFirst(settings(), { ...attempt, kind: "automatic" }, applied)).toBe(false);
  });

  it("관문은 applyOutcome 이 실제로 넣은 승인만 받는다 — 후보 signals.heldQwenAttemptId 가 그 시도여야 한다(소개 없음의 승인 의견은 아니다)", () => {
    expect(heldQwenGateFirst(settings(), attempt, { signals: {} })).toBe(false);
    expect(heldQwenGateFirst(settings(), attempt, { signals: { heldQwenAttemptId: 40 } })).toBe(false);
    expect(heldQwenGateFirst(settings(), attempt, null)).toBe(false);
    expect(heldQwenGateFirst(settings(), attempt, { signals: { heldQwenAttemptId: "41" } })).toBe(true);
  });

  it("같은 Qwen 의 대체 모델이 있으면 관문에 넣지 않는다 — 독립 칸이 실패하면 그 대체 모델이 칸을 채운다", () => {
    const withFallback = settings({ secondReview: { ...settings().secondReview, fallbacks: [{ provider: "abcllm", model: "[gpu3090] qwen3.8-flash-next" }] } });
    expect(heldQwenSameModelFallback(withFallback, "qwen3.8-flash-next")).toBe(true);
    expect(heldQwenGateable(withFallback, "qwen3.8-flash-next")).toBe(false);
    expect(heldQwenGateFirst(withFallback, attempt, applied)).toBe(false);
    // 운영의 대체 모델(qwen3-coder:30b)은 다른 모델이다
    const coder = settings({ secondReview: { ...settings().secondReview, fallbacks: [{ provider: "abcllm", model: "qwen3-coder:30b" }] } });
    expect(heldQwenGateable(coder, "qwen3.8-flash-next")).toBe(true);
  });

  it("독립 표인지는 자리 표시를 모두 떼고 가른다 — 칸 맞추기(sameReviewModel)는 [MLX] 만 뗀다", () => {
    expect(sameReviewModel("[gpu3090] qwen3.8-flash-next", "qwen3.8-flash-next")).toBe(false);
    expect(sameUnderlyingModel("[gpu3090] qwen3.8-flash-next", "qwen3.8-flash-next")).toBe(true);
    expect(sameUnderlyingModel("[MLX] gpt-oss-120b", "gpt-oss-120b")).toBe(true);
    expect(sameUnderlyingModel("[supa] Qwen3.8-27B-NVFP4", "qwen3.8-flash-next")).toBe(false);
    expect(sameUnderlyingModel("", "")).toBe(false);
    // 같은 Qwen 의 표는 자리 표시가 달라도 되풀이라 "일치"로 적지 않는다
    const first = { decision: "approve" as const, confidence: 0.95, model: "qwen3.8-flash-next" };
    expect(combineVerdicts(first, { decision: "approve", confidence: 0.9, provider: "abcllm", model: "[gpu3090] qwen3.8-flash-next" }, 0.85, false))
      .toBe("needs_human");
    expect(combineVerdicts(first, { decision: "approve", confidence: 0.9, provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4" }, 0.85, false)).toBe("agreed");
  });

  it("저장된 값은 따로 읽는다 — 없거나 깨졌으면 꺼짐(빠진 칸을 채우지 않는다)", () => {
    expect(storedQwenAuto({}).heldRetry).toEqual(DEFAULT_HELD_QWEN_RETRY);
    expect(storedQwenAuto({ qwenAuto: {} }).heldRetry.enabled).toBe(false);
    expect(storedQwenAuto({ qwenAuto: { heldRetry: ON } }).heldRetry).toEqual(ON);
    expect(storedQwenAuto({ qwenAuto: { heldRetry: { ...ON, perTick: 0 } } }).heldRetry.enabled).toBe(false);
    expect(storedQwenAuto({ qwenAuto: { heldRetry: { ...ON, reasons: ["repo_deleted"] } } }).heldRetry.enabled).toBe(false);
    expect(storedQwenAuto({ qwenAuto: { heldRetry: { enabled: true } } }).heldRetry.enabled).toBe(false);
    // 행의 다른 칸이 깨져 기본값으로 돌아가도 켠 스위치는 저장된 값으로 읽는다
    expect(mergeWithDefaults({ enabled: "yes", qwenAuto: { heldRetry: ON } }).qwenAuto.heldRetry.enabled).toBe(true);
  });
});
