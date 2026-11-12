import { describe, expect, it } from "vitest";
import { readTextTargetPoolAffinities } from "@/lib/llm/capacity-repository";
import { repeatedPoolMemberWarnings } from "@/lib/operations/admin-ai-task-execution";

/** 2026-11-12 「동시에」 전 단계 검토 — 저장 알림과 이어받기 조회의 이름 수 상한. */
describe("이어받기 조회: 구성원 4 + 예비 순위 3(0179)", () => {
  const owner = { instanceId: "pool-guard", bootId: "0b0c0d0e-0000-4000-8000-000000000000" };
  const names = (count: number) => Array.from({ length: count }, (_, index) => `model-${index}`);
  it("묶지 못한 후보의 이름 둘(모델·연결 별칭)까지 14개를 받는다 — 예전 상한 8이면 틱마다 오류로 멈췄다", async () => {
    // 이름 수 검사를 지나 다음 검사(대상 모양)에서 거절된다 — 상한 오류가 아니다
    await expect(readTextTargetPoolAffinities({ routeId: "search-query-translate", member: {} } as never, names(14), owner))
      .rejects.not.toThrow("invalid_text_pool_affinity_models");
    await expect(readTextTargetPoolAffinities({ routeId: "search-query-translate", member: {} } as never, names(17), owner))
      .rejects.toThrow("invalid_text_pool_affinity_models");
  });
});

describe("저장 알림: 같은 엔진을 두 자리에", () => {
  const row = (position: number, engineKey: string, model: string) => ({ position, engineKey, model, options: {} });
  it("같은 엔진 키가 두 자리면 알린다(저장은 막지 않는다) — 칸 수를 따르는 작업이면 칸 수를 권한다", () => {
    const warnings = repeatedPoolMemberWarnings([row(1, "a", "gpt-oss-120b"), row(2, "b", "m1-gemma"), row(3, "b", "m1-gemma")], "product-translate", 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("2·3번째 모델(m1-gemma)");
    expect(warnings[0]).toContain("칸 수를 늘리세요");
    expect(repeatedPoolMemberWarnings([row(1, "a", "x"), row(2, "a", "x")], "publish-classify", 1)[0]).toContain("한 자리만 두는 것을 권합니다");
    expect(repeatedPoolMemberWarnings([row(1, "a", "x"), row(2, "b", "y")], "product-translate", 1)).toEqual([]);
  });
});
