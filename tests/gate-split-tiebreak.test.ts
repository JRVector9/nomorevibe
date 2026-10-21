import { describe, expect, it } from "vitest";
import type { SecondReviewStatus } from "@/lib/db/schema";
import { splitRejectVerdict } from "@/lib/crawl/gate-split-tiebreak";
import { QWEN_V2_AUTO_SOURCE } from "@/lib/crawl/qwen-direct-review";
import { SPLIT_TIEBREAK_ACTOR, tiebreakApproved, tiebreakSummary } from "@/app/(operator)/admin/review/tiebreak";

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
    applied: "kept_human", at: null, current: true };
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
