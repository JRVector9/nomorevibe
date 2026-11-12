import { describe, expect, it } from "vitest";
import { applySampleResults, nextSampleBatch, pickSamples, SAMPLE_COMPARE_LIMITS, SAMPLE_COMPARE_SUPPORTED, SAMPLE_COMPARE_TASKS, sampleComplete, sampleReasonText,
  sampleSize, sampleStatusText, sampleTally, type SampleComparison, type SampleItem } from "@/lib/operations/model-sample-compare";

const queue = (n: number) => Array.from({ length: n }, (_, index) => ({ productId: index + 1 }));
const item = (productId: number, text = "x".repeat(100)): SampleItem => ({ productId, name: `p${productId}`, text, current: null, candidate: null });
const record = (items: SampleItem[], current = true): Pick<SampleComparison, "items" | "current" | "status" | "statusCode"> => ({ items, status: "running", statusCode: null,
  current: current ? { connectionId: "c1", model: "gpt-oss-120b", name: "m3-gpt-oss" } : null });

describe("표본 비교 — 지원하는 작업", () => {
  it("시안의 텍스트 작업 넷 — 실행을 붙인 것은 한국어 소개 하나, 나머지는 까닭과 함께 「지원 안 함」", () => {
    expect(SAMPLE_COMPARE_TASKS.map(task => [task.task, task.label, task.supported])).toEqual([
      ["product-tagline-ko", "한국어 소개", true], ["product-translate", "공개 번역", false], ["reason-translate", "사유 번역", false], ["product-search-profile", "키워드 짓기", false]]);
    expect(SAMPLE_COMPARE_SUPPORTED).toEqual(["product-tagline-ko"]);
    for (const task of SAMPLE_COMPARE_TASKS.filter(entry => !entry.supported)) expect(task.reason).toMatch(/운영 데이터에 쓰지 않고/);
  });

  it("표본 수 — 빈 값은 기본 20, 1~40 으로 자르고 숫자가 아니면 null", () => {
    expect([sampleSize(""), sampleSize(null), sampleSize("5"), sampleSize("0"), sampleSize("999"), sampleSize("열")]).toEqual([20, 20, 5, 1, SAMPLE_COMPARE_LIMITS.maxSize, null]);
  });
});

describe("표본 고르기", () => {
  it("맨 앞(곧 실제 잡이 집어 갈 것)을 건너뛰고 남은 줄에 고르게 — 같은 줄이면 같은 표본", () => {
    const picked = pickSamples(queue(400), 20);
    expect(picked).toHaveLength(20);
    expect(Math.min(...picked.map(row => row.productId))).toBeGreaterThan(SAMPLE_COMPARE_LIMITS.skipHead);
    expect(Math.max(...picked.map(row => row.productId))).toBeGreaterThan(360);
    expect(new Set(picked.map(row => row.productId)).size).toBe(20);
    expect(pickSamples(queue(400), 20)).toEqual(picked);
  });

  it("남은 줄이 모자라면 맨 앞도 쓰고, 대기보다 많이 달라면 있는 만큼 — 같은 제품은 한 번", () => {
    expect(pickSamples(queue(10), 20).map(row => row.productId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(pickSamples([...queue(3), { productId: 2 }], 5).map(row => row.productId)).toEqual([1, 2, 3]);
    expect(pickSamples([], 5)).toEqual([]);
  });
});

describe("부를 묶음과 기록", () => {
  it("지금 모델 쪽부터, 한 묶음은 8건·1,200자까지 — 지금 모델이 없으면 후보만", () => {
    const items = Array.from({ length: 12 }, (_, index) => item(index + 1, "y".repeat(index === 3 ? 1000 : 100)));
    const first = nextSampleBatch(record(items))!;
    expect(first.side).toBe("current");
    expect(first.items.map(entry => entry.productId)).toEqual([1, 2, 3]);
    expect(nextSampleBatch(record(items, false))!.side).toBe("candidate");
  });

  it("결과를 옮기면 다음 묶음으로, 둘 다 끝나면 끝 — 통과 수는 받은 결과만 센다", () => {
    let items = [item(1), item(2), item(3)];
    const done = (side: "current" | "candidate", results: [number, boolean][]) => {
      items = applySampleResults(items, side, new Map(results.map(([id, pass]) => [id, { state: "done" as const, output: "한국어", pass, reason: pass ? null : "rejected:not_korean" }])));
    };
    done("current", [[1, true], [2, true], [3, true]]);
    expect(nextSampleBatch(record(items))!.side).toBe("candidate");
    done("candidate", [[1, true], [2, false]]);
    items = applySampleResults(items, "candidate", new Map([[3, { state: "skipped" as const, reason: "already_done" }]]));
    expect(sampleComplete(record(items))).toBe(true);
    expect(sampleTally(record(items))).toEqual({ total: 3, current: { pass: 3, done: 3 }, candidate: { pass: 1, done: 2 } });
  });

  it("까닭·상태 글자", () => {
    expect(sampleReasonText("rejected:not_korean")).toBe("검사 탈락: 한국어 아님");
    expect(sampleReasonText("already_done")).toBe("이미 처리됨(표본에서 빠짐)");
    expect(sampleReasonText("unusable:no_direct_contract")).toBe("부를 수 없음: no_direct_contract");
    expect(sampleReasonText("timeout")).toBe("시간 초과");
    const items = [item(1), { ...item(2), current: { state: "done" as const, output: "가", pass: true } }];
    expect(sampleStatusText(record(items))).toBe("부르는 중 · 1/4");
    expect(sampleStatusText({ ...record(items), status: "failed", statusCode: "timeout" })).toBe("실패 · 시간 초과");
    expect(sampleStatusText({ ...record(items), status: "done" })).toBe("끝남");
  });
});
