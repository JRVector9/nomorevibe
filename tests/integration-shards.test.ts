import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeDurations } from "@/scripts/integration-durations.mjs";
import { planShards, readDurations, SERIAL_FILES } from "@/scripts/integration-shards.mjs";

const ROOT = path.resolve(__dirname, "..");

describe("통합 테스트 시간 기준 묶음(LPT)", () => {
  it("긴 파일부터 가장 가벼운 묶음에 넣어 묶음 시간을 고르게 한다", () => {
    const plan = planShards(["a", "b", "c", "d", "e"], { a: 10, b: 7, c: 5, d: 4, e: 3 }, 2);
    expect(plan.map((shard) => shard.files)).toEqual([["a", "d"], ["b", "c", "e"]]);
    expect(plan.map((shard) => shard.seconds)).toEqual([14, 15]);
  });

  it("입력 순서와 상관없이 같은 배정이고, 모든 파일이 정확히 한 묶음에 들어간다", () => {
    const files = Array.from({ length: 40 }, (_, index) => `tests/integration/f${index}.test.ts`);
    const durations = Object.fromEntries(files.map((file, index) => [file, (index * 7) % 13]));
    const forward = planShards(files, durations, 6);
    const backward = planShards([...files].reverse(), durations, 6);
    expect(backward).toEqual(forward);
    expect(forward.flatMap((shard) => shard.files).sort()).toEqual([...files].sort());
  });

  it("기록 없는 새 파일은 기록의 중앙값으로 친다", () => {
    const plan = planShards(["old-1", "old-2", "old-3", "new"], { "old-1": 1, "old-2": 3, "old-3": 100 }, 2);
    expect(plan[1].files).toEqual(["new", "old-2", "old-1"]);
    expect(plan[1].seconds).toBe(7);
  });

  it("잘못된 묶음 수는 거절한다", () => {
    expect(() => planShards(["a"], {}, 0)).toThrow("integration_shard_count_invalid");
  });

  it("갱신은 새로 잰 값만 덮고 지금 없는 파일은 지운다", () => {
    expect(mergeDurations({ keep: 1, gone: 2, again: 3 }, [{ files: { again: 4.26, fresh: 5 } }], ["keep", "again", "fresh"]))
      .toEqual({ again: 4.3, fresh: 5, keep: 1 });
  });

  it("직렬 ledger 파일은 모두 실제로 있고 시간 기록은 읽힌다", () => {
    for (const file of SERIAL_FILES) expect(existsSync(path.join(ROOT, file)), file).toBe(true);
    expect(new Set(SERIAL_FILES).size).toBe(SERIAL_FILES.length);
    expect(Object.keys(readDurations(ROOT)).length).toBeGreaterThan(200);
  });

  it("CI 는 직렬 파일을 이 목록에서 읽어 ledger 잡에서 돌리고 묶음에서 뺀다", () => {
    const workflow = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("node scripts/integration-shards.mjs --serial");
    expect(workflow).toContain("node scripts/integration-shards.mjs --exclude-args");
  });
});
