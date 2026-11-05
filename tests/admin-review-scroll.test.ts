import { beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { decodeReviewCursor, encodeReviewCursor, reviewCursorKind, reviewCursorPredicate } from "@/lib/crawl/admin-review-cursor";
import { prototypeReviewFilter } from "@/app/(operator)/admin/review/PrototypeReviewQuery";

const fake = vi.hoisted(() => ({ admin: vi.fn(), settings: vi.fn(), list: vi.fn(), causes: vi.fn(), overview: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: fake.admin }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: fake.settings }));
vi.mock("@/lib/crawl/admin-review", async original => ({ ...await original<typeof import("@/lib/crawl/admin-review")>(), listAdminReviewEntries: fake.list, reviewQueueCauses: fake.causes }));
vi.mock("@/lib/crawl/review-overview", () => ({ humanQueueOverview: fake.overview }));
const { GET } = await import("@/app/(operator)/admin/review/scroll/route");
const after = { id: 43, priority: false, value: "2026-11-05 01:03:20.123456" };
const filter = prototypeReviewFilter({ tab: "all", q: "needle", sort: "wait_short" });
const request = (cursor = encodeReviewCursor(after, filter)!) => new Request(`https://admin.test/admin/review/scroll?tab=all&q=needle&sort=wait_short&cursor=${cursor}`);
beforeEach(() => {
  vi.clearAllMocks(); fake.admin.mockResolvedValue({ login: "operator" }); fake.settings.mockResolvedValue({});
  fake.list.mockResolvedValue({ entries: [], total: 5, hiddenByAge: 0, nextCursor: null });
});
it("defaults to the recent waiting queue while keeping explicit sort choices", () => {
  expect(prototypeReviewFilter({ tab: "all" }).sort).toBe("wait_short");
  expect(prototypeReviewFilter({ sort: "" }).sort).toBe("");
  expect(prototypeReviewFilter({ sort: "wait" }).sort).toBe("wait");
});
it("binds the cursor to the exact current filters and preserves submillisecond boundaries", () => {
  const cursor = encodeReviewCursor(after, filter)!;
  expect(decodeReviewCursor(cursor, filter)).toEqual(after);
  expect(() => decodeReviewCursor(cursor, { ...filter, q: "other" })).toThrow("review_cursor_invalid");
  expect(() => decodeReviewCursor("x".repeat(1025), filter)).toThrow("review_cursor_invalid");
});
it("keeps approved split priority, descending value, NULLS LAST and ascending id ties in the keyset", () => {
  const dialect = new PgDialect();
  const query = dialect.sqlToQuery(reviewCursorPredicate(after, { id: sql`candidate_id`, priority: sql`split_approved`, value: sql`wait_at`, kind: "time", descending: true }));
  expect(query.sql).toContain("split_approved = false");
  expect(query.sql).toContain("wait_at <"); expect(query.sql).toContain("wait_at IS NULL"); expect(query.sql).toContain("candidate_id >");
  expect(query.params).toContain("2026-11-05 01:03:20.123456");
  const nullPage = dialect.sqlToQuery(reviewCursorPredicate({ ...after, value: null }, { id: sql`candidate_id`, priority: sql`false`, value: sql`stars`, kind: "number", descending: true }));
  expect(nullPage.sql).toContain("stars IS NULL AND candidate_id >");
  expect(nullPage.sql).not.toContain("stars <");
});
it.each(["push", "push_old"])("roundtrips %s cursors with PostgreSQL timezone text and exact microseconds", sort => {
  const selected = prototypeReviewFilter({ tab: "all", sort });
  const boundary = { id: 43, priority: false, value: "2026-11-05 01:03:20.123456+09" };
  const decoded = decodeReviewCursor(encodeReviewCursor(boundary, selected)!, selected);
  const query = new PgDialect().sqlToQuery(reviewCursorPredicate(decoded, { id: sql`candidate_id`, priority: sql`split_approved`,
    value: sql`pushed_at`, kind: reviewCursorKind(selected.sort), descending: selected.sort === "push" }));
  expect(reviewCursorKind(selected.sort)).toBe("timestamptz");
  expect(query.sql).toContain(selected.sort === "push" ? "pushed_at <" : "pushed_at >");
  expect(query.sql).toContain("::timestamptz");
  expect(query.sql).toContain("pushed_at IS NULL");
  expect(query.sql).toContain("candidate_id >");
  expect(query.params).toContain("2026-11-05 01:03:20.123456+09");
});
it("refuses unauthenticated scroll requests before reading filters or candidates", async () => {
  fake.admin.mockResolvedValue(null);
  const response = await GET(request());
  expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(fake.settings).not.toHaveBeenCalled(); expect(fake.list).not.toHaveBeenCalled();
});
it("rejects a cursor reused with different filters without starting a queue read", async () => {
  const url = new URL(request().url); url.searchParams.set("q", "changed");
  const response = await GET(new Request(url));
  expect(response.status).toBe(400); expect(fake.list).not.toHaveBeenCalled();
});
it("reads a bounded next30 with the same filters and cursor without closed-panel scans", async () => {
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(fake.list).toHaveBeenCalledWith({}, expect.objectContaining({ state: "all", search: "needle", sort: "wait_short", cursor: after, limit: 30 }));
  expect(fake.causes).not.toHaveBeenCalled(); expect(fake.overview).not.toHaveBeenCalled();
  expect(await response.json()).toMatchObject({ entries: [], nextCursor: null });
});
it("keeps failures retryable instead of returning an empty successful queue", async () => {
  fake.list.mockRejectedValue(new Error("private failure"));
  const response = await GET(request());
  expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("private failure");
});
