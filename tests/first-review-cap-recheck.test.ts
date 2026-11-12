import { beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * 2026-11-12 검수 F2(gpt-6.1-sol 재현): 1차 「동시에」 칸 수(max_slots)를 TX 밖 고르기(executor = db)만 세고, claim 의 후보 잠금 아래 재확인(executor = tx)은
 * 세지 않았다 — 힌트 뒤에 다른 후보가 그 구성원의 하나뿐인 칸을 채워도 재확인이 그 구성원을 다시 허락했다. 재확인도 칸 수를 세야 하고, 이 후보의
 * 살아 있는 의도(대기·예약·보냄)는 그대로 잇는다. DB 읽기만 바꾼다 — chooseFirstReviewForCandidate 는 운영 코드 그대로다.
 */
const state = vi.hoisted(() => ({ countReads: 0, state: null as unknown, intents: [] as { provider: string; model: string }[] }));
const dialect = new PgDialect();
vi.mock("@/lib/db", async load => {
  const actual = await load<typeof import("@/lib/db")>();
  const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => [] };
  const fake = {
    select: () => chain,
    execute: async (query: SQL) => {
      const text = dialect.sqlToQuery(query).sql;
      if (text.includes("ai1_intents")) return state.intents;
      if (!text.includes("count(*)::integer AS n")) return [];
      state.countReads++;
      return [{ provider: "abcllm", model: "pool-member", n: 1 }];
    },
  };
  return { ...actual, db: fake };
});
vi.mock("@/lib/crawl/first-reviewers", async load => ({
  ...await load<typeof import("@/lib/crawl/first-reviewers")>(), firstReviewRankState: () => state.state,
}));
vi.mock("@/lib/crawl/review-task-ranks", async load => ({
  ...await load<typeof import("@/lib/crawl/review-task-ranks")>(),
  ensureReviewTaskRanks: async () => {},
  chooseReviewWorkloadMember: async () => null,
}));
import { chooseFirstReviewForCandidate } from "@/lib/crawl/agent-review-repository";
import { db } from "@/lib/db";

const MEMBER_KEY = JSON.stringify(["abcllm", "pool-member"]);
beforeEach(() => {
  state.countReads = 0;
  state.intents = [];
  const reviewer = { provider: "abcllm", model: "pool-member" };
  const member = { memberId: "pool-member-id", position: 1, maxSlots: 1 };
  state.state = { pool: [reviewer], unusable: new Map(), degraded: null, reserve: [],
    resolution: { task: "first-review", slot: 1, routeId: "crawl-agent-review", status: "ok",
      candidates: [{ rank: { rank: 1 }, unusable: null, poolMember: member,
        binding: { provider: "abcllm", identity: reviewer.model } }],
      execution: { task: "first-review", slot: 1, mode: "workload_pool", revision: 1,
        members: [member], reserveRanks: false } } };
});
const context = { candidate: { id: 999 }, input: { inputHash: "cap-hash" }, settings: {} } as never;
// claimReview 의 TX 처럼 db 와 다른 executor 객체
const tx = () => ({ select: db.select, execute: db.execute }) as unknown as Exclude<Parameters<typeof chooseFirstReviewForCandidate>[1], undefined>;

it("outside selection refuses an already full member", async () => {
  expect(await chooseFirstReviewForCandidate(context)).toBeNull();
  expect(state.countReads).toBe(1);
});

it("the candidate-locked recheck rejects a new input when its member filled after the hint, and says which member is capped", async () => {
  // 다른 후보의 예약 하나가 하나뿐인 칸을 쥐었다 — 이 후보에는 살아 있는 시도·의도가 없다
  const note: { capped?: ReadonlySet<string> } = {};
  const result = await chooseFirstReviewForCandidate(context, tx(), new Set(), note);
  expect(result, "max_slots=1, another candidate already holds its only slot").toBeNull();
  expect(state.countReads).toBe(1);
  expect([...note.capped ?? []]).toEqual([MEMBER_KEY]);
});

it("the recheck keeps resuming this candidate's own live intent without counting the cap", async () => {
  state.intents = [{ provider: "abcllm", model: "pool-member" }];
  expect(await chooseFirstReviewForCandidate(context, tx(), new Set())).toEqual({ provider: "abcllm", model: "pool-member" });
  expect(state.countReads).toBe(0);
});

it("the ledger admission gets the member's own cap with the same live-ledger count, and nothing for a non-member or fallback", async () => {
  const { firstReviewMemberSlotCap } = await import("@/lib/crawl/first-review-member-cap");
  const cap = firstReviewMemberSlotCap({}, { provider: "abcllm", model: "pool-member" });
  expect(cap?.maxSlots).toBe(1);
  const statements: { sql: string; params: unknown[] }[] = [];
  const load = await cap!.load({ execute: async (query: SQL) => { statements.push(dialect.sqlToQuery(query)); return [{ n: 2 }]; } } as never);
  expect(load).toBe(2);
  expect(statements[0].sql).toContain("route_id = 'crawl-agent-review' AND class = 'first'");
  expect(statements[0].sql).toContain("state = 'waiting' AND queue_until > clock_timestamp()");
  expect(statements[0].params).toEqual(expect.arrayContaining(["abcllm", "pool-member"]));
  // 구성원이 아닌 모델(예비·다른 순위)은 칸 수가 없다
  expect(firstReviewMemberSlotCap({}, { provider: "abcllm", model: "not-a-member" })).toBeNull();
  // 순위대로면 칸 수가 없다
  state.state = { ...(state.state as object), resolution: { ...(state.state as { resolution: object }).resolution,
    execution: { task: "first-review", slot: 1, mode: "fallback", revision: null, members: [], reserveRanks: false } } };
  expect(firstReviewMemberSlotCap({}, { provider: "abcllm", model: "pool-member" })).toBeNull();
});
