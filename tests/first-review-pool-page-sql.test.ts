import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

vi.mock("@/lib/crawl/first-reviewers", async (original) => ({
  ...await original<typeof import("@/lib/crawl/first-reviewers")>(),
  firstReviewers: () => [{ provider: "abcllm", model: "fixture-model" }],
}));

// SQL 글자만 만든다 — 연결하지 않는다(lib/db 는 첫 쿼리 때 연결한다)
vi.stubEnv("DATABASE_URL", "postgres://fixture:fixture@127.0.0.1:1/fixture");

const SEEN = /seen\.candidate_id = ([^ ]+) AND seen\.state = 'succeeded'/g;
const selectList = (text: string) => text.slice(0, text.indexOf(' from "crawl_candidates"'));

/**
 * 2026-11-11 16:00Z~ 1차 심사가 같은 후보 2건만 매 틱 다시 뽑고 새 후보 1,030건을 굶겼다.
 * select 목록의 「심사한 적 있음」이 표 이름 없는 "id" 로 그려져 안쪽 쿼리의 seen.id 에 묶였고(늘 false), 커서가 심사한 후보를 지나가지 못했다.
 */
describe("1차 심사 쪽 쿼리 — 심사한 적 있음 칸", () => {
  it("select·where(커서 뒤)·order by 모두 바깥 후보 표의 id 를 가리킨다", async () => {
    const { firstReviewPoolQuery } = await import("@/lib/crawl/agent-review-repository");
    const { mergeWithDefaults } = await import("@/lib/crawl/settings");
    const settings = mergeWithDefaults({ enabled: true, reviewMode: "enforce" });
    const text = firstReviewPoolQuery(settings, 20, { id: 1, reviewed: false, updatedAt: "2026-11-11 16:00:31.013", ceiling: 10 }).toSQL().sql;
    const seen = [...text.matchAll(SEEN)].map(match => match[1]);
    // select 목록 1 + where 2(gt·eq) + order by 1
    expect(seen).toHaveLength(4);
    expect(new Set(seen)).toEqual(new Set(['"crawl_candidates"."id"']));
    // select 목록의 것이 바로 고친 자리다 — 예전에는 여기만 seen.candidate_id = "id" 였다
    expect([...selectList(text).matchAll(SEEN)].map(match => match[1])).toEqual(['"crawl_candidates"."id"']);
  });

  it("첫 쪽(커서 없음)도 select 목록과 order by 가 같은 식이다", async () => {
    const { firstReviewPoolQuery } = await import("@/lib/crawl/agent-review-repository");
    const { mergeWithDefaults } = await import("@/lib/crawl/settings");
    const text = firstReviewPoolQuery(mergeWithDefaults({ enabled: true, reviewMode: "enforce" }), 20, null).toSQL().sql;
    expect([...text.matchAll(SEEN)].map(match => match[1])).toEqual(['"crawl_candidates"."id"', '"crawl_candidates"."id"']);
  });

  it("잠시 뺀 후보는 쪽에서 빠진다", async () => {
    const { firstReviewPoolQuery } = await import("@/lib/crawl/agent-review-repository");
    const { mergeWithDefaults } = await import("@/lib/crawl/settings");
    const query = firstReviewPoolQuery(mergeWithDefaults({ enabled: true, reviewMode: "enforce" }), 20, null, [642281, 696099]).toSQL();
    expect(query.sql).toContain('"crawl_candidates"."id" not in (');
    expect(query.params).toEqual(expect.arrayContaining([642281, 696099]));
  });
});

/** 같은 결함이 있던 다른 자리 — 저장소 전수 검사(2026-11-12)에서 toSQL 로 확인한 둘 */
describe("select 목록의 상관 서브쿼리 — 바깥 칸이 안쪽 표에 묶이지 않는다", () => {
  it("AI1 consumer 의 hint 쪽도 select·where·order by 가 바깥 후보 id 를 가리킨다", async () => {
    const { firstReviewConsumerHintsQuery } = await import("@/lib/crawl/consumers/first");
    const { mergeWithDefaults } = await import("@/lib/crawl/settings");
    const text = firstReviewConsumerHintsQuery(mergeWithDefaults({ enabled: true, reviewMode: "enforce" }),
      { id: 1, reviewed: false, updatedAt: "2026-11-11 16:00:31.013", ceiling: 10 }).toSQL().sql;
    expect([...text.matchAll(SEEN)].map(match => match[1])).toEqual(Array(4).fill('"crawl_candidates"."id"'));
    expect([...selectList(text).matchAll(SEEN)].map(match => match[1])).toEqual(['"crawl_candidates"."id"']);
  });

  it("심사 목록의 다음 쪽 우선 칸(_cursorPriority)이 쓰는 Qwen-v2 승인 갈림 식은 select 목록에서도 바깥 후보 id 를 가리킨다", async () => {
    const { db } = await import("@/lib/db");
    const { crawlCandidates } = await import("@/lib/db/schema");
    const { splitTiebreakApproved, splitTiebreakApprovedFirst } = await import("@/lib/crawl/gate-split-tiebreak-read");
    const text = db.select({ id: crawlCandidates.id, priority: splitTiebreakApproved }).from(crawlCandidates)
      .orderBy(splitTiebreakApprovedFirst).toSQL().sql;
    const joins = [...text.matchAll(/FROM "gate_split_tiebreaks" WHERE (\S+) = (\S+)\s/g)].map(match => `${match[1]} = ${match[2]}`);
    expect(joins).toEqual(Array(2).fill('"gate_split_tiebreaks"."candidate_id" = "crawl_candidates"."id"'));
  });
});

/** drizzle 의 그리는 방식이 바뀌면 이 시험이 알려 준다 — qualifiedColumn 은 어느 자리에서도 표 이름을 붙인다 */
describe("qualifiedColumn", () => {
  it("join 없는 select 목록에서 맨 바깥 칸은 표 이름 없이, qualifiedColumn 은 표 이름을 붙여 그린다", async () => {
    const { db } = await import("@/lib/db");
    const { crawlCandidates, crawlReviewAttempts } = await import("@/lib/db/schema");
    const { qualifiedColumn } = await import("@/lib/db/qualified-column");
    const text = db.select({
      bare: sql<boolean>`EXISTS (SELECT 1 FROM ${crawlReviewAttempts} a WHERE a.candidate_id = ${crawlCandidates.id})`,
      qualified: sql<boolean>`EXISTS (SELECT 1 FROM ${crawlReviewAttempts} a WHERE a.candidate_id = ${qualifiedColumn(crawlCandidates.id)})`,
    }).from(crawlCandidates).toSQL().sql;
    expect(text).toContain('a.candidate_id = "id")');
    expect(text).toContain('a.candidate_id = "crawl_candidates"."id")');
  });
});
