import { describe, expect, it } from "vitest";
import { buildModelThroughput, calculateThroughput, throughputModelKey, type ModelCompletion } from "@/lib/operations/admin-models-throughput";
const now = "2026-10-29T12:00:00Z";
const row = (seconds = 10, patch: Partial<ModelCompletion> = {}): ModelCompletion => ({ routeId: "first-review", provider: "abcllm", model: "[supa] Qwen",
  state: "settled", queuedAt: new Date(Date.parse(now) - seconds * 1000).toISOString(), settledAt: now, responseOk: true, ...patch });
describe("운영 장부 건당 처리량", () => {
  it("빈 표본은 기록 없음이며 실패율 분모 0을 0%로 만들지 않는다", () => {
    expect(calculateThroughput([], now, 1)).toEqual({ count: 0, medianMs: null, p90Ms: null, perHour: null, failureRate: null, classified: 0 });
  });
  it("종료 없는 행·미확인·철회·잘못된 시각은 제외한다", () => {
    expect(calculateThroughput([row(10, { settledAt: null }), row(10, { state: "indeterminate" }), row(10, { state: "withdrawn" }),
      row(10, { queuedAt: "invalid" }), row(10, { queuedAt: "2026-10-30T00:00:00Z" })], now, 24).count).toBe(0);
  });
  it("1건의 중앙값·p90·시간당 건수·실패율을 계산한다", () => {
    expect(calculateThroughput([row(10, { responseOk: false })], now, 24)).toEqual({ count: 1, medianMs: 10000, p90Ms: 10000, perHour: 1 / 24, failureRate: 1, classified: 1 });
  });
  it("짝수 중앙값과 p90 순위 경계(10·11건)를 적용한다", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1));
    expect(calculateThroughput(rows, now, 1)).toMatchObject({ medianMs: 5500, p90Ms: 9000 });
    expect(calculateThroughput([...rows, row(11)], now, 1).p90Ms).toBe(10000);
  });
  it("미분류 종료는 속도 표본에 포함하되 실패율 분모에서 뺀다", () => {
    expect(calculateThroughput([row(10, { responseOk: null })], now, 1)).toMatchObject({ count: 1, failureRate: null, classified: 0 });
    expect(calculateThroughput([row(), row(10, { responseOk: false }), row(10, { responseOk: null })], now, 1).failureRate).toBe(.5);
  });
  it("종료 시각 기준 1·24시간 경계와 미래 종료를 구분한다", () => {
    const at = (h: number) => new Date(Date.parse(now) - h * 3600000).toISOString();
    const rows = [row(100000, { settledAt: at(1) }), row(100000, { settledAt: at(24) }), row(100000, { settledAt: at(25) }), row(10, { settledAt: at(-1) })];
    expect(calculateThroughput(rows, now, 1).count).toBe(1);
    expect(calculateThroughput(rows, now, 24).count).toBe(2);
  });
  it("모델은 여러 단계 이력을 합치고 단계는 모델을 합친다", () => {
    const result = buildModelThroughput([row(), row(20, { routeId: "second-review" }), row(30, { model: "[MLX] gpt-oss" })], now);
    expect(result.byModel[throughputModelKey(row())].hour.count).toBe(2);
    expect(result.byStage["first-review"].hour.count).toBe(2);
  });
});
