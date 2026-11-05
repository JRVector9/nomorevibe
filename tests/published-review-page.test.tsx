import { renderToStaticMarkup } from "react-dom/server";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, beforeEach, vi } from "vitest";
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), replica: vi.fn(), translated: vi.fn(), admin: vi.fn(), page: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: mocks.transaction }, onReplica: mocks.replica }));
vi.mock("@/lib/crawl/translations", () => ({ translationsFor: mocks.translated }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/app/(operator)/admin/review/actions", () => ({ resolvePublishedSecondReview: vi.fn() }));
import { decodePublishedReviewCursor, encodePublishedReviewCursor } from "@/lib/crawl/published-review-cursor";
import { readPublishedReviewPage, publishedReviewPageAfter, publishedReviewMembership } from "@/lib/crawl/published-review-page";
import { PrototypeReviewPublished } from "@/app/(operator)/admin/review/PrototypeReviewPublished";

const after = { priority: 1, at: "2026-11-05 02:34:12.123456", id: 100 };
const dialect = new PgDialect();
beforeEach(() => { vi.clearAllMocks(); mocks.replica.mockImplementation((load: () => unknown) => load()); mocks.translated.mockResolvedValue(new Map()); });

describe("published review stable cursor and bounded reads", () => {
  it("roundtrips raw microseconds and null timestamps without admitting another cursor scope", () => {
    expect(decodePublishedReviewCursor(encodePublishedReviewCursor(after)!)).toEqual(after);
    const scoped = encodePublishedReviewCursor(after, "%_")!;
    expect(decodePublishedReviewCursor(scoped, "%_")).toEqual(after);
    expect(() => decodePublishedReviewCursor(scoped, "another query")).toThrow("published_review_cursor_invalid");
    const undated = { ...after, at: null };
    expect(decodePublishedReviewCursor(encodePublishedReviewCursor(undated)!)).toEqual(undated);
    const encoded = JSON.parse(Buffer.from(encodePublishedReviewCursor(after)!, "base64url").toString());
    for (const bad of ["", "bad!", "a".repeat(513), Buffer.from(JSON.stringify({ ...encoded, scope: "other" })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...encoded, after: { ...after, at: "2026-02-30 00:00:00" } })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...encoded, after: { ...after, priority: 3 } })).toString("base64url")])
      expect(() => decodePublishedReviewCursor(bad)).toThrow("published_review_cursor_invalid");
  });
  it("keeps unresolved published membership and priority / timestamp / id order stable", () => {
    const query = dialect.sqlToQuery(publishedReviewPageAfter(after)!);
    expect(query.sql).toContain('"second_reviews"."status" =');
    expect(query.params).toContain("needs_human");
    expect(query.sql).toContain('"second_reviews"."published_slug" is not null');
    expect(query.sql).toContain('"second_reviews"."reviewed_at" <');
    expect(query.sql).toContain('"second_reviews"."reviewed_at" IS NULL');
    expect(query.sql).toContain('"second_reviews"."id" <');
    expect(query.params).toContain(after.at);
    const search = dialect.sqlToQuery(publishedReviewMembership("%_")!);
    expect(search.sql).toContain("position(lower(");
    expect(search.params).toContain("%_");
    expect(search.sql).not.toContain("LIKE");
    const nullPage = dialect.sqlToQuery(publishedReviewPageAfter({ ...after, at: null })!);
    expect(nullPage.sql).toContain('"second_reviews"."reviewed_at" IS NULL AND');
    expect(nullPage.params).not.toContain(after.at);
  });
  it("fetches31 but serializes/translates30 and carries ordering values even if the last row later changes", async () => {
    const raw = Array.from({ length: 31 }, (_, i) => ({ id: 100 - i, slug: `p${i}`, repo: `owner/p${i}`, decision: "reject", confidence: .9,
      reason: `reason-${i}`, trigger: "risk", signals: [], autoOpinion: { decision: "needs_review", confidence: .5, reason: `extra-${i}`, inputHash: "private-hash" }, priority: 1, rawReviewedAt: after.at }));
    const limits: number[] = [], orders: unknown[][] = [], predicates: unknown[] = [];
    const select = vi.fn(() => {
      const result = select.mock.calls.length === 1 ? raw : [{ total: 400 }];
      const chain = { from: () => chain, where: (where: unknown) => { predicates.push(where); return chain; }, orderBy: (...args: unknown[]) => { orders.push(args); return chain; },
        limit: (n: number) => { limits.push(n); return Promise.resolve(result); }, then: (ok: (rows: unknown[]) => unknown) => Promise.resolve(result).then(ok) };
      return chain;
    });
    mocks.transaction.mockImplementation((load: (tx: unknown) => unknown) => load({ execute: vi.fn(), select }));
    const result = await readPublishedReviewPage(undefined, "%_");
    expect(limits).toEqual([31]);
    expect(result.rows).toHaveLength(30);
    expect(result.total).toBe(400);
    expect(predicates).toHaveLength(2);
    for (const predicate of predicates) expect(dialect.sqlToQuery(predicate as never).params).toContain("%_");
    expect(mocks.translated.mock.calls[0][0]).toHaveLength(60);
    expect(decodePublishedReviewCursor(result.nextCursor!, "%_")).toEqual({ priority: 1, at: after.at, id: 71 });
    const wire = JSON.stringify(result.rows);
    expect(wire).not.toContain("private-hash");
    expect(wire).not.toContain("rawReviewedAt");
    expect(wire).not.toContain("autoOpinion");
    expect(dialect.sqlToQuery(orders[0][1] as never).sql).toContain("DESC NULLS LAST");
    expect(mocks.transaction.mock.calls[0][1]).toEqual({ accessMode: "read only", isolationLevel: "repeatable read" });
  });
  it("renders only the supplied first page and retains existing public keep/ban confirmations", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, slug: `p${i}`, repo: `o/p${i}`, decision: "reject", confidence: .9,
      reason: null, reasonKo: null, trigger: "risk", signals: [] }));
    const html = renderToStaticMarkup(<PrototypeReviewPublished rows={rows} total={400} nextCursor={encodePublishedReviewCursor(after)} />);
    expect(html.match(/<tr/g)).toHaveLength(31);
    expect(html).toContain("전체 400건");
    expect(html).toContain("추가 자동 의견의 반려·보류 우선");
    expect(html).toContain("다음 30개 불러오기");
    expect(html).toContain("현재 공개 유지");
    expect(html).toContain("공개 중단");
    expect(html).not.toContain('data-admin-scroll-active="true"');
  });
});
