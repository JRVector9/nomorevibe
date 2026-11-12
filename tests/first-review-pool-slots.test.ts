import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * 1차 검수 「동시에」의 칸 수·예비 — 2026-11-12 소유자 「1,2차도 동시에 선택하면 새 동작을 따르게」.
 * - 구성원의 칸 수 = 그 모델의 살아 있는 1차 장부 행(대기·예약·보냄) 상한. 찬 구성원은 고르지 않고, 줄에 서는 것(queueWhenFull)도 칸이 남은 구성원 중에서만이다.
 * - 구성원이 모두 차거나 쉬거나 줄에 설 자리도 없으면 예비 순위가 받는다(예비도 claim 이 줄에 선다). 예비까지 없으면 모델 쪽 미룸(poolBusy)이다 — 후보 탓이 아니다.
 * - 같은 엔진(같은 장부 이름) 두 자리는 칸 수를 더해 한 열쇠로 함께 찬다.
 */
const dialect = new PgDialect();
const mocks = vi.hoisted(() => ({ choose: vi.fn(), state: null as unknown, counts: [] as { provider: string; model: string; n: number }[], countReads: 0 }));
vi.mock("@/lib/db", async load => {
  const actual = await load<typeof import("@/lib/db")>();
  const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => [] };
  const fake = {
    select: () => chain,
    execute: async (query: SQL) => {
      if (!dialect.sqlToQuery(query).sql.includes("count(*)::integer AS n")) return [];   // 이 후보의 살아 있는 의도: 없음
      mocks.countReads++;
      return mocks.counts;
    },
  };
  return { ...actual, db: fake };
});
vi.mock("@/lib/crawl/first-reviewers", async load => ({ ...await load<typeof import("@/lib/crawl/first-reviewers")>(), firstReviewRankState: () => mocks.state }));
vi.mock("@/lib/crawl/review-task-ranks", async load => ({ ...await load<typeof import("@/lib/crawl/review-task-ranks")>(),
  ensureReviewTaskRanks: async () => {}, chooseReviewWorkloadMember: mocks.choose }));
import { chooseFirstReviewForCandidate } from "@/lib/crawl/agent-review-repository";
import { firstReviewerKey } from "@/lib/crawl/first-reviewers";

type Member = { memberId: string; model: string; maxSlots: number | null };
const reviewer = (model: string) => ({ provider: "abcllm" as const, model });
function pool(members: Member[], reserve: string[] = []) {
  const candidates = members.map((member, index) => ({ rank: { rank: index + 1 }, unusable: null, detail: null,
    poolMember: { memberId: member.memberId, position: index + 1, maxSlots: member.maxSlots },
    binding: { provider: "abcllm", identity: member.model } }));
  const keys = new Set<string>(), list: { provider: "abcllm"; model: string }[] = [];
  for (const model of [...members.map(member => member.model), ...reserve]) if (!keys.has(model)) { keys.add(model); list.push(reviewer(model)); }
  mocks.state = { pool: list, unusable: new Map(), degraded: null, reserve: reserve.filter(model => !members.some(member => member.model === model)).map(reviewer),
    resolution: { task: "first-review", slot: 1, routeId: "crawl-agent-review", status: "ok", candidates,
      execution: { task: "first-review", slot: 1, mode: "workload_pool", revision: 4, updatedAt: null, reserveRanks: reserve.length > 0,
        members: members.map((member, index) => ({ memberId: member.memberId, position: index + 1, maxSlots: member.maxSlots })) } } };
}
const context = { candidate: { id: 7 }, input: { inputHash: "h" }, settings: {} } as never;
/** 고르기 힌트: 막히지 않은 구성원 중 첫째 */
const firstFree = () => mocks.choose.mockImplementation(async (resolution: { candidates: { binding: { provider: string; identity: string } }[] }, blocked: ReadonlySet<string>) => {
  const free = resolution.candidates.find(candidate => !blocked.has(JSON.stringify([candidate.binding.provider, candidate.binding.identity])));
  return free ? { provider: free.binding.provider, model: free.binding.identity, poolSelection: {} } : null;
});
beforeEach(() => { mocks.counts = []; mocks.countReads = 0; firstFree(); });
afterEach(() => mocks.choose.mockReset());

describe("1차 「동시에」 — 칸 수", () => {
  it("살아 있는 1차 장부 행이 칸 수에 닿은 구성원은 고르지 않는다 — 칸이 남은 구성원이 받는다", async () => {
    pool([{ memberId: "a", model: "qwen-27b", maxSlots: 2 }, { memberId: "b", model: "qwen-flash", maxSlots: 1 }]);
    mocks.counts = [{ provider: "abcllm", model: "qwen-27b", n: 2 }];
    expect(await chooseFirstReviewForCandidate(context)).toEqual(reviewer("qwen-flash"));
    expect([...mocks.choose.mock.calls[0][1] as Set<string>]).toEqual([firstReviewerKey(reviewer("qwen-27b"))]);
  });

  it("칸 수를 적지 않은 묶음은 장부를 세지 않는다(예전 그대로)", async () => {
    pool([{ memberId: "a", model: "qwen-27b", maxSlots: null }]);
    mocks.counts = [{ provider: "abcllm", model: "qwen-27b", n: 9 }];
    expect(await chooseFirstReviewForCandidate(context)).toEqual(reviewer("qwen-27b"));
    expect(mocks.countReads).toBe(0);
  });

  it("같은 엔진 두 자리는 칸 수를 더한다(1+1) — 하나가 차도 받고, 합에 닿으면 함께 찬다", async () => {
    pool([{ memberId: "a", model: "qwen-27b", maxSlots: 1 }, { memberId: "a2", model: "qwen-27b", maxSlots: 1 }]);
    mocks.counts = [{ provider: "abcllm", model: "qwen-27b", n: 1 }];
    expect(await chooseFirstReviewForCandidate(context)).toEqual(reviewer("qwen-27b"));
    mocks.counts = [{ provider: "abcllm", model: "qwen-27b", n: 2 }];
    const note: { poolBusy?: boolean } = {};
    expect(await chooseFirstReviewForCandidate(context, undefined, new Set(), note)).toBeNull();
    expect(note.poolBusy).toBe(true);
  });
});

describe("1차 「동시에」 — 예비", () => {
  it("구성원이 모두 칸 수에 닿으면 예비 순위가 받는다(claim 이 줄에 선다)", async () => {
    pool([{ memberId: "a", model: "qwen-27b", maxSlots: 1 }], ["sonnet-reserve"]);
    mocks.counts = [{ provider: "abcllm", model: "qwen-27b", n: 1 }];
    expect(await chooseFirstReviewForCandidate(context)).toEqual(reviewer("sonnet-reserve"));
  });

  it("구성원이 쉬어도(이 틱 미룸·쓸 수 없음) 예비가 받는다 — 쉬는 예비는 비켜 간다", async () => {
    pool([{ memberId: "a", model: "qwen-27b", maxSlots: null }], ["reserve-1", "reserve-2"]);
    const blocked = new Set([firstReviewerKey(reviewer("qwen-27b")), firstReviewerKey(reviewer("reserve-1"))]);
    expect(await chooseFirstReviewForCandidate(context, undefined, blocked)).toEqual(reviewer("reserve-2"));
  });

  it("예비까지 모두 쉬고 구성원은 칸이 찼으면 null + poolBusy — 후보 탓이 아닌 모델 쪽 미룸이다(잡은 새 들임을 멈추고 포화로 미룬다)", async () => {
    pool([{ memberId: "a", model: "qwen-27b", maxSlots: 1 }], ["reserve-1"]);
    mocks.counts = [{ provider: "abcllm", model: "qwen-27b", n: 1 }];
    const note: { poolBusy?: boolean } = {};
    expect(await chooseFirstReviewForCandidate(context, undefined, new Set([firstReviewerKey(reviewer("reserve-1"))]), note)).toBeNull();
    expect(note.poolBusy).toBe(true);
  });

  it("구성원도 예비도 모두 쉬면 poolBusy 가 아니다 — 예전처럼 「모든 순위를 쓸 수 없음」이 가른다", async () => {
    pool([{ memberId: "a", model: "qwen-27b", maxSlots: null }], ["reserve-1"]);
    const note: { poolBusy?: boolean } = {};
    const blocked = new Set([firstReviewerKey(reviewer("qwen-27b")), firstReviewerKey(reviewer("reserve-1"))]);
    expect(await chooseFirstReviewForCandidate(context, undefined, blocked, note)).toBeNull();
    expect(note.poolBusy).toBeUndefined();
  });
});
