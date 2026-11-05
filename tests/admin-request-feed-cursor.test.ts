import { expect, it } from "vitest";
import { parseRequestFeedCursor, requestFeedCursor, requestFeedFilter, requestFeedWindow, type RequestFeedRow } from "@/lib/operations/admin-request-workspace-feed-model";
const filter = requestFeedFilter({ tab: "open" });
const makeRow = (key: string, cursorAt = "2026-11-05T01:00:00.123456Z") => ({ key, kind: "contact", name: "문의", type: "문의", status: "접수", at: cursorAt, cursorAt, waitHours: 1, next: "검토", slug: null, excerpt: null }) as RequestFeedRow & { cursorAt: string };
it("preserves DB microseconds and binds the cursor to current type/state/search", () => {
  const at = "2026-11-05T01:00:00.123456Z", key = "contact:00000000-0000-0000-0000-000000000001", cursor = requestFeedCursor(at, key, filter);
  expect(parseRequestFeedCursor(cursor, filter)).toEqual({ at, key });
  for (const changed of [{ q: "changed" }, { state: "all" }, { kind: "intro" }, { tab: "contact" }]) expect(() => parseRequestFeedCursor(cursor, requestFeedFilter(changed))).toThrow("request_feed_cursor_invalid");
  expect(() => parseRequestFeedCursor("not-a-cursor", filter)).toThrow("request_feed_cursor_invalid");
});
it("returns only newest30 with deterministic equal-time keys and no initial overfetch serialization", () => {
  const rows = Array.from({ length: 45 }, (_, i) => makeRow(`contact:${String(i).padStart(3, "0")}`));
  rows[0] = makeRow("contact:newer-microsecond", "2026-11-05T01:00:00.123457Z");
  const result = requestFeedWindow(rows, filter);
  expect(result.items).toHaveLength(30); expect(result.items[0].key).toBe("contact:newer-microsecond");
  const last = result.items.at(-1)!;
  expect(parseRequestFeedCursor(result.nextCursor!, filter)).toEqual({ at: "2026-11-05T01:00:00.123456Z", key: last.key });
  expect(result.items.some(row => "cursorAt" in row)).toBe(false);
});
it("allowlists list fields and never serializes contact body/email/handling records", () => {
  const item = { ...makeRow("contact:private"), body: "private-body", senderEmail: "private@example.com", record: { secret: true }, excerpt: "private-excerpt" };
  const result = requestFeedWindow([item], filter);
  expect(JSON.stringify(result)).not.toMatch(/private-body|private@example|private-excerpt|secret|record/);
  expect(result.items[0].excerpt).toBeNull(); expect(result.nextCursor).toBeNull();
});
it("keeps reaction-only queues held and excludes held reactions from accepted combined posts", () => {
  expect(requestFeedFilter({ tab: "posts", kind: "reactions", state: "accepted" })).toMatchObject({ kinds: ["reactions"], state: "held" });
  expect(requestFeedFilter({ tab: "posts", state: "accepted" }).kinds).toEqual(["feedback", "replies"]);
});
