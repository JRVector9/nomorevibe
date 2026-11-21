import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * 2차 「동시에」(투표자 1)의 회원 자격 — 심사자 identity 의 provider 동등 규칙(lib/crawl/reviewer-identity.ts).
 * abcllm 으로 올린 표는 그 구성원·순위의 계약을 local-direct 로 다시 저장한 뒤에도 그 자리의 표다. 다른 모델·CLI·다른 구성원은 예전 그대로다.
 */
const MEMBER = "0b0c0d0e-0000-4000-8000-00000000c0c0", OTHER = "0b0c0d0e-0000-4000-8000-00000000d0d0";
let providers: Record<string, string> = {};
let legacyModels: string[] = [];
const binding = (model: string) => ({ routeId: "second-review", provider: providers[model] ?? "abcllm", identity: model, engineModel: model, connectionId: "c", deviceId: "gpu" });
const member = (memberId: string, model: string, position: number) => ({ memberId, position, connectionId: `0b0c0d0e-0000-4000-8000-00000000000${position}`,
  model, options: {}, canonicalModel: model, deviceId: "gpu", engineKey: "e".repeat(64), maxSlots: null, connection: {} });
const members = [member(MEMBER, "qwen-next", 1), member(OTHER, "deepseek-flash", 2)];
const config = { task: "second-review", slot: 1, mode: "workload_pool", revision: 3, updatedAt: null, reserveRanks: false, members };

vi.mock("@/lib/llm/ai-task-resolver", () => ({
  taskModels: (_task: string, slot: number) => slot === 1
    ? legacyModels.map((model, index) => ({ task: "second-review", slot: 1, rank: index + 1, model, enabled: true, options: {}, connection: {} })) : [],
}));
vi.mock("@/lib/crawl/review-task-ranks", async load => ({
  ...await load<typeof import("@/lib/crawl/review-task-ranks")>(),
  settingsReviewersActive: () => false, reviewTaskRanksPinned: () => false, reviewRouteContracts: () => [],
  bindReviewTaskRank: (_task: string, rank: { model: string }) => ({ rank, unusable: null, detail: null, binding: binding(rank.model) }),
  resolveReviewTaskRanks: (_task: string, slot = 1) => ({ task: "second-review", slot, routeId: "second-review", status: "ok",
    execution: slot === 1 ? config : undefined,
    candidates: slot === 1 ? members.map(entry => ({ rank: { rank: entry.position }, unusable: null, detail: null, poolMember: entry, binding: binding(entry.model) })) : [] }),
}));
import { secondReviewPoolMembershipSql, secondReviewPoolRootMembershipSql, secondReviewWorkloadMembership, secondReviewWorkloadReviewer } from "@/lib/crawl/second-review-workload";
import { setAiTaskExecutionConfigsForTest } from "@/lib/llm/ai-task-execution-snapshot";
import type { AiTaskExecutionConfig } from "@/lib/llm/ai-task-execution-config";

beforeEach(() => {
  providers = {};
  legacyModels = ["legacy-voter", "legacy-fallback"];
  setAiTaskExecutionConfigsForTest([config as unknown as AiTaskExecutionConfig]);
});
const assignment = (memberId = MEMBER, canonicalModel = "qwen-next") => ({ secondReviewId: 1, taskSlot: 1, configRevision: 3, memberId, canonicalModel });
const row = (provider: string | null, model: string, fallbackForId: number | null = null) =>
  ({ provider, model, fallbackForId }) as Parameters<typeof secondReviewWorkloadMembership>[0];

describe("2차 「동시에」 회원 자격 — provider 동등 규칙", () => {
  it("배정된 구성원의 계약이 local-direct 로 바뀌어도 abcllm 으로 올린 표는 그 구성원의 표다", () => {
    expect(secondReviewWorkloadReviewer(row("abcllm", "qwen-next"), assignment())).toEqual({ provider: "abcllm", model: "qwen-next" });
    providers["qwen-next"] = "local-direct";
    expect(secondReviewWorkloadMembership(row("abcllm", "qwen-next"), assignment())).toBe(true);
    // 그 자리의 지금 이름표 — 아직 보내지 않은 표를 옮겨 적을 값이다
    expect(secondReviewWorkloadReviewer(row("abcllm", "qwen-next"), assignment())).toEqual({ provider: "local-direct", model: "qwen-next" });
    expect(secondReviewWorkloadMembership(row("local-direct", "qwen-next"), assignment())).toBe(true);
  });

  it("CLI·다른 장부 이름·다른 구성원은 예전처럼 회원이 아니다", () => {
    providers["qwen-next"] = "opencode-cli";
    expect(secondReviewWorkloadMembership(row("abcllm", "qwen-next"), assignment())).toBe(false);
    providers["qwen-next"] = "local-direct";
    // 배정 행이 있는 첫 표의 모델은 장부 이름 글자 그대로다
    expect(secondReviewWorkloadMembership(row("abcllm", "[MLX] qwen-next"), assignment())).toBe(false);
    expect(secondReviewWorkloadMembership(row("abcllm", "deepseek-flash"), assignment())).toBe(false);
    expect(secondReviewWorkloadMembership(row("abcllm", "qwen-next"), assignment(OTHER, "deepseek-flash"))).toBe(false);
    expect(secondReviewWorkloadMembership(row(null, "qwen-next"), assignment())).toBe(false);
    expect(secondReviewWorkloadMembership(row("abcllm", "qwen-next"), { ...assignment(), configRevision: 4 })).toBe(false);
  });

  it("배정 행 없는 첫 표(저장된 1순위)와 대체 표(그 밖의 순위)도 같은 규칙이다", () => {
    providers["legacy-voter"] = "local-direct";
    providers["legacy-fallback"] = "local-direct";
    expect(secondReviewWorkloadReviewer(row("abcllm", "legacy-voter"))).toEqual({ provider: "local-direct", model: "legacy-voter" });
    expect(secondReviewWorkloadMembership(row("abcllm", "legacy-fallback"))).toBe(false);          // 첫 표 자리는 1순위뿐
    expect(secondReviewWorkloadReviewer(row("abcllm", "legacy-fallback", 9))).toEqual({ provider: "local-direct", model: "legacy-fallback" });
    expect(secondReviewWorkloadMembership(row("abcllm", "legacy-voter", 9))).toBe(false);          // 대체 자리는 1순위 밖
    expect(secondReviewWorkloadReviewer(row("abcllm", "legacy-fallback", 9), assignment())).toEqual({ provider: "local-direct", model: "legacy-fallback" });
    providers["legacy-voter"] = "claude-cli";
    expect(secondReviewWorkloadMembership(row("abcllm", "legacy-voter"))).toBe(false);
  });

  it("SQL 회원 자격도 provider 를 같은 열쇠로 견준다(모델 견줌은 그대로)", () => {
    providers["legacy-voter"] = "local-direct";
    const render = (value: ReturnType<typeof secondReviewPoolRootMembershipSql>) => new PgDialect().sqlToQuery(value);
    const key = (name: string) => new RegExp(`\\(CASE WHEN ${name.replace(/[.>'-]/g, "\\$&")} IN \\(\\$\\d+, \\$\\d+\\) THEN \\$\\d+ ELSE ${name.replace(/[.>'-]/g, "\\$&")} END\\)`);
    const root = render(secondReviewPoolRootMembershipSql(sql`wr`));
    expect(root.sql).toMatch(key("wr.provider"));
    expect(root.sql).toMatch(key("m->>'provider'"));
    expect(root.sql).toContain("wr.model = m->>'model'");
    expect(root.sql).not.toMatch(/wr\.provider (=|IS NOT DISTINCT FROM) /);
    // 저장된 1순위의 이름표는 열쇠로 넘긴다(abcllm·local-direct → 같은 값)
    expect(root.params).toContain("local-direct");
    const chain = render(secondReviewPoolMembershipSql(sql`second_reviews`));
    expect(chain.sql).toMatch(key("f->>'provider'"));
    expect(chain.sql).toMatch(key("second_reviews.provider"));
  });
});
