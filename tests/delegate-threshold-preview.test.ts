import { describe, expect, it } from "vitest";
import { confidenceBucket, DELEGATE_THRESHOLD_CANDIDATES, summarizeDelegateThreshold, type DelegateOutcomeRow } from "@/lib/operations/delegate-threshold-preview";
import { parseDelegateThresholdArgs } from "@/scripts/ops/delegate-threshold-preview";

const row = (decision: string, confidence: number | null, holdCause: string | null, n: number, route = "publish"): DelegateOutcomeRow =>
  ({ decision, confidence, holdCause, route, n });
const summarize = (rows: DelegateOutcomeRow[]) => summarizeDelegateThreshold(rows, { hours: 24, measuredAt: "2026-11-11T00:00:00.000Z" });
const line = (preview: ReturnType<typeof summarize>, threshold: number) => preview.thresholds.find(item => item.threshold === threshold)!;

describe("확신 구간", () => {
  it("아래 끝을 포함하고, 확신이 없으면 none", () => {
    expect([null, 0.2, 0.5, 0.69, 0.7, 0.75, 0.8, 0.849, 0.85, 0.9, 0.95, 1].map(confidenceBucket)).toEqual(["none", "<0.50", "0.50-0.60",
      "0.60-0.70", "0.70-0.75", "0.75-0.80", "0.80-0.85", "0.80-0.85", "0.85-0.90", "0.90-0.95", ">=0.95", ">=0.95"]);
  });
});

describe("문턱 미리보기(summarizeDelegateThreshold)", () => {
  const rows = [
    row("approve", 0.97, null, 40), row("approve", 0.95, null, 2, "check_repo"), row("reject", 0.93, null, 46),
    row("approve", 0.85, "low_confidence", 100), row("approve", 0.8, "low_confidence", 200, "check_repo"),
    row("approve", 0.8, "low_confidence", 30, "refresh"), row("reject", 0.75, "low_confidence", 300), row("reject", null, "low_confidence", 7),
    row("approve", 0.72, "low_confidence", 50), row("needs_review", 0.95, "model_abstained", 400),
    row("approve", 0.85, "cannot_approve", 20), row("approve", 0.95, "stale_evidence", 9, "refresh"),
    row("approve", 0.95, "repo_changed", 3, "check_repo"), row("approve", 0.92, "repo_gone", 1, "check_repo"),
  ];
  const preview = summarize(rows);

  it("지금 문턱(0.9)에서는 실제로 적용된 수와 같다", () => {
    expect(preview.currentThreshold).toBe(0.9);
    expect(preview.ending).toEqual({ applied: 88, model_abstained: 400, low_confidence: 687, cannot_approve: 20, stale_evidence: 9,
      repo_changed: 3, repo_gone: 1 });
    expect(preview.total).toBe(1208);
    expect(line(preview, 0.9)).toEqual({ threshold: 0.9, approve: 42, approveRepoCheck: 2, approveStale: 0, reject: 46, held: 1208 - 88 });
  });

  it("문턱을 내리면 확신 부족만 적용으로 넘어오고, 모델 보류·승인 불가·근거 나이 까닭은 그대로 남는다", () => {
    expect(line(preview, 0.85)).toMatchObject({ approve: 142, approveRepoCheck: 2, approveStale: 0, reject: 46 });
    // 0.8: 72시간 넘은 근거의 승인 30건은 적용이 아니라 원본 재수집으로 남는다, 24~72시간 200건은 저장소 확인을 거친다
    expect(line(preview, 0.8)).toEqual({ threshold: 0.8, approve: 342, approveRepoCheck: 202, approveStale: 30, reject: 46, held: 1208 - 342 - 46 });
    expect(line(preview, 0.75)).toMatchObject({ approve: 342, reject: 346 });
    expect(line(preview, 0.7)).toMatchObject({ approve: 392, reject: 346, held: 1208 - 392 - 346 });
    // 확신 없는 반려(7)·모델 보류(400)·승인 불가(20)·근거 나이(13)는 어느 후보에서도 적용되지 않는다
    expect(Math.min(...preview.thresholds.map(item => item.held))).toBe(7 + 400 + 20 + 9 + 3 + 1 + 30);
    expect(preview.thresholds.map(item => item.threshold)).toEqual([...DELEGATE_THRESHOLD_CANDIDATES]);
  });

  it("원래 결정 × 확신 구간과 결정 × 까닭으로 나눠 센다", () => {
    expect(preview.byDecision.approve).toMatchObject({ ">=0.95": 40 + 2 + 9 + 3, "0.90-0.95": 1, "0.85-0.90": 120, "0.80-0.85": 230, "0.70-0.75": 50 });
    expect(preview.byDecision.reject).toMatchObject({ "0.90-0.95": 46, "0.75-0.80": 300, none: 7 });
    expect(preview.byDecision.needs_review[">=0.95"]).toBe(400);
    expect(preview.byDecisionEnding.approve).toMatchObject({ applied: 42, low_confidence: 380, cannot_approve: 20 });
    expect(preview.byDecisionEnding.reject).toMatchObject({ applied: 46, low_confidence: 307 });
  });

  it("모양이 어긋난 줄은 세지 않고 ignored 로만 보인다", () => {
    const odd = summarize([row("approve", 0.97, null, 1), row("maybe", 0.9, null, 5), row("approve", 0.9, "bored", 6),
      row("approve", 0.9, null, 7, "elsewhere"), row("approve", Number.NaN, null, 8), row("approve", 0.9, null, -1)]);
    expect(odd.total).toBe(1);
    expect(odd.ignored).toBe(5 + 6 + 7 + 8);
  });
});

describe("미리보기 CLI 인자", () => {
  it("기본 24시간, 1~168시간의 정수만 받는다", () => {
    expect(parseDelegateThresholdArgs([])).toEqual({ hours: 24 });
    expect(parseDelegateThresholdArgs(["--hours=72"])).toEqual({ hours: 72 });
    for (const args of [["--hours=0"], ["--hours=1.5"], ["--hours=169"], ["--hours=x"]])
      expect(() => parseDelegateThresholdArgs(args)).toThrow("delegate_threshold_preview_invalid_hours");
    expect(() => parseDelegateThresholdArgs(["--apply"])).toThrow();
    expect(() => parseDelegateThresholdArgs(["prod"])).toThrow();
  });
});
