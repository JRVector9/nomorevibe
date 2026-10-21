import { describe, expect, it } from "vitest";
import { heldQwenGateable, heldQwenGateFirst, heldQwenIndependentVoters, heldQwenOwnedReasons, heldQwenOwns } from "@/lib/crawl/held-qwen-retry-policy";
import { mergeWithDefaults, storedHeldQwenRetry } from "@/lib/crawl/settings";
import { DEFAULT_CRAWL_SETTINGS, DEFAULT_HELD_QWEN_RETRY, type CrawlSettings } from "@/lib/crawl/settings-schema";

const settings = (patch: Partial<CrawlSettings> = {}): CrawlSettings => ({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "enforce",
  secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, enabled: true,
    voters: [{ provider: "abcllm", model: "[gpu3090] qwen3.8-flash-next" }, { provider: "abcllm", model: "[MLX] gpt-oss-120b" }] }, ...patch });
type Row = Parameters<typeof heldQwenGateFirst>[1];
const attempt: Row = { kind: "delegated", provider: "qwen-direct", actor: "qwen-v2:2026-10-21.v2", state: "succeeded",
  outcome: { decision: "approve", reason: "ok", evidenceIds: ["product"], confidence: 0.95 }, model: "qwen3.8-flash-next" };

describe("보류 Qwen-v2 재심사 정책", () => {
  it("기본값은 켬·세 사유·한 틱 10건이고, 적용 모드에서만 맡는다", () => {
    expect(DEFAULT_CRAWL_SETTINGS.review.qwenHeldRetry).toEqual({ enabled: true, perTick: 10, budgetSeconds: 40,
      reasons: ["no_description", "ai_review_exhausted", "ambiguous"] });
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
    expect(heldQwenGateFirst(onlyQwen, attempt)).toBe(false);
    expect(heldQwenGateable(settings(), "qwen3.8-flash-next")).toBe(true);
  });

  it("관문은 켜진 스위치·적용 모드·2차 심사·성공한 승인 행에서만 Qwen-v2 를 1차 승인으로 받는다", () => {
    expect(heldQwenGateFirst(settings(), attempt)).toBe(true);
    expect(heldQwenGateFirst(settings({ review: { qwenHeldRetry: { ...DEFAULT_HELD_QWEN_RETRY, enabled: false } } }), attempt)).toBe(false);
    expect(heldQwenGateFirst(settings({ secondReview: { ...settings().secondReview, enabled: false } }), attempt)).toBe(false);
    expect(heldQwenGateFirst(settings({ reviewMode: "observe" }), attempt)).toBe(false);
    expect(heldQwenGateFirst(settings(), { ...attempt, state: "failed" })).toBe(false);
    expect(heldQwenGateFirst(settings(), { ...attempt, outcome: { ...attempt.outcome!, decision: "needs_review" } })).toBe(false);
    expect(heldQwenGateFirst(settings(), { ...attempt, provider: "m3-deepseek", actor: "m3-deepseek:3" })).toBe(false);
    expect(heldQwenGateFirst(settings(), { ...attempt, kind: "automatic" })).toBe(false);
  });

  it("저장된 값은 따로 읽는다 — 없으면 기본값, 깨졌으면 꺼짐, 일부만 있으면 나머지를 채운다", () => {
    expect(storedHeldQwenRetry({})).toEqual(DEFAULT_HELD_QWEN_RETRY);
    expect(storedHeldQwenRetry({ review: {} })).toEqual(DEFAULT_HELD_QWEN_RETRY);
    expect(storedHeldQwenRetry({ review: { qwenHeldRetry: { perTick: 3 } } })).toEqual({ ...DEFAULT_HELD_QWEN_RETRY, perTick: 3 });
    expect(storedHeldQwenRetry({ review: { qwenHeldRetry: { perTick: 0 } } }).enabled).toBe(false);
    expect(storedHeldQwenRetry({ review: { qwenHeldRetry: { reasons: ["repo_deleted"] } } }).enabled).toBe(false);
    expect(storedHeldQwenRetry({ review: null }).enabled).toBe(false);
    // 행의 다른 칸이 깨져 기본값으로 돌아가도 끈 스위치는 꺼진 채다
    expect(mergeWithDefaults({ enabled: "yes", review: { qwenHeldRetry: { ...DEFAULT_HELD_QWEN_RETRY, enabled: false } } }).review.qwenHeldRetry.enabled).toBe(false);
  });
});
