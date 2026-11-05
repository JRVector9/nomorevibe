import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

const timestamp = z.string().max(26).regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/).refine(value => {
  const date = new Date(value.replace(" ", "T") + "Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.replace(" ", "T").slice(0, 19);
});
export const publishedReviewCursorSchema = z.object({ priority: z.number().int().min(0).max(2), at: timestamp.nullable(), id: z.number().int().positive() }).strict();
export type PublishedReviewCursor = z.infer<typeof publishedReviewCursorSchema>;
const envelope = z.object({ version: z.literal(1), scope: z.literal("published-second-review"), query: z.string().regex(/^[a-f0-9]{64}$/), after: publishedReviewCursorSchema }).strict();
const queryKey = (q: string) => createHash("sha256").update(q.trim()).digest("hex");
export function encodePublishedReviewCursor(after: PublishedReviewCursor | null, q = ""): string | null {
  return after ? Buffer.from(JSON.stringify({ version: 1, scope: "published-second-review", query: queryKey(q), after })).toString("base64url") : null;
}
export function decodePublishedReviewCursor(raw: string, q = ""): PublishedReviewCursor {
  if (!raw || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("published_review_cursor_invalid");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(raw, "base64url").toString()); } catch { throw new Error("published_review_cursor_invalid"); }
  const parsed = envelope.safeParse(value);
  if (!parsed.success || parsed.data.query !== queryKey(q)) throw new Error("published_review_cursor_invalid");
  return parsed.data.after;
}

/** Human priority ASC, review timestamp DESC NULLS LAST, stable id DESC. Keep raw microseconds in the cursor. */
export function publishedReviewCursorPredicate(after: PublishedReviewCursor, columns: { priority: SQL; at: SQL; id: SQL }): SQL {
  const validated = publishedReviewCursorSchema.parse(after);
  const samePriority = sql`${columns.priority} = ${validated.priority}`;
  const idAfter = sql`${columns.id} < ${validated.id}`;
  const nextInPriority = validated.at === null
    ? sql`(${columns.at} IS NULL AND ${idAfter})`
    : sql`(${columns.at} < ${validated.at}::timestamp OR ${columns.at} IS NULL
      OR (${columns.at} = ${validated.at}::timestamp AND ${idAfter}))`;
  return sql`(${columns.priority} > ${validated.priority} OR (${samePriority} AND ${nextInPriority}))`;
}
