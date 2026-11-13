import { describe, expect, it } from "vitest";
import { consoleStageExecution } from "@/lib/operations/console-home-model";
import type { ConsoleRank } from "@/lib/operations/console-tasks";

const execution = (task: string, mode: "fallback" | "workload_pool", slot = 1) => ({ task, mode, slot });
const rank = (task: string, slot: number): ConsoleRank => ({ task, slot, rank: 1, connectionId: "connection", model: "model", enabled: true });

describe("saved execution policy beside a home flow stage", () => {
  it("shows the saved policy even when a pool has no live calls or the task is paused", () => {
    expect(consoleStageExecution("reason-translate", [execution("reason-translate", "workload_pool")], []))
      .toMatchObject({ label: "동시에", detail: expect.stringContaining("실제 동시 호출 수를 뜻하지 않습니다") });
    expect(consoleStageExecution("first", [execution("first-review", "fallback")], [])?.label).toBe("순위대로");
  });

  it("does not invent fallback when the batch or an expected config is missing", () => {
    expect(consoleStageExecution("first", null, [])?.label).toBe("방식 미확인");
    expect(consoleStageExecution("first", [], [])?.label).toBe("방식 미확인");
    expect(consoleStageExecution("keywords", [execution("product-search-profile", "workload_pool")], []))
      .toMatchObject({ label: "방식 미확인", detail: expect.stringContaining("검색 키워드 검수: 방식 미확인") });
  });

  it("aggregates both keyword tasks and preserves their different modes in the description", () => {
    const view = consoleStageExecution("keywords", [execution("product-search-profile", "fallback"), execution("product-search-verify", "workload_pool")], []);
    expect(view).toEqual({ label: "혼합", detail: expect.stringMatching(/검색 키워드 짓기: 순위대로 \/ 검색 키워드 검수: 동시에/) });
    expect(consoleStageExecution("keywords", [execution("product-search-profile", "workload_pool"), execution("product-search-verify", "workload_pool")], [])?.label).toBe("동시에");
  });

  it("ignores unused voter defaults but includes configured voters and missing configuration", () => {
    const configs = [execution("second-review", "workload_pool"), execution("second-review", "fallback", 2), execution("second-review", "fallback", 3)];
    expect(consoleStageExecution("second", configs, [])?.label).toBe("동시에");
    const mixed = consoleStageExecution("second", configs, [rank("second-review", 2)]);
    expect(mixed).toMatchObject({ label: "혼합", detail: expect.stringContaining("투표자 2: 순위대로") });
    expect(mixed?.detail).not.toContain("투표자 3");
    expect(consoleStageExecution("second", configs, null)?.label).toBe("방식 미확인");
    expect(consoleStageExecution("second", [configs[0]], [rank("second-review", 2)])?.label).toBe("방식 미확인");
  });

  it("distinguishes the legacy classifier and external intro settings from live ranks", () => {
    expect(consoleStageExecution("publish", [execution("publish-classify", "fallback")], [])?.label).toBe("CLI 분류");
    expect(consoleStageExecution("publish", [execution("publish-classify", "workload_pool")], [])?.label).toBe("동시에");
    expect(consoleStageExecution("intro-check", [execution("product-intro-check", "workload_pool")], [])?.label).toBe("별도 설정");
  });

  it.each(["discover", "fetch", "judge", "human", "public", "unknown"])("leaves %s without a model policy badge", stage => {
    expect(consoleStageExecution(stage, null, null)).toBeNull();
  });
});
