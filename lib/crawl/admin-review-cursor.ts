import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

/** The ordering values are carried with the page: deleting/updating the last row cannot move its boundary. */
export const reviewCursorSchema = z.object({ id: z.number().int().positive(), priority: z.boolean(), value: z.string().max(80).nullable() }).strict();
export type ReviewCursor = z.infer<typeof reviewCursorSchema>;
const envelope = z.object({ version: z.literal(1), query: z.string().regex(/^[a-f0-9]{64}$/), after: reviewCursorSchema }).strict();
const fingerprint = (filter: unknown) => createHash("sha256").update(JSON.stringify(filter)).digest("hex");
export function encodeReviewCursor(after: ReviewCursor | null, filter: unknown): string | null {
  return after ? Buffer.from(JSON.stringify({ version: 1, query: fingerprint(filter), after })).toString("base64url") : null;
}
export function decodeReviewCursor(raw: string, filter: unknown): ReviewCursor {
  if (!raw || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("review_cursor_invalid");
  const parsed = envelope.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString()));
  if (!parsed.success || parsed.data.query !== fingerprint(filter)) throw new Error("review_cursor_invalid");
  return parsed.data.after;
}

/** NULLS LAST and id ASC are identical to the review reader's existing stable tie breaker. */
export function reviewCursorPredicate(after: ReviewCursor, parts: {
  id: SQL; priority: SQL; value: SQL; kind: "id" | "number" | "time"; descending: boolean;
}): SQL {
  const samePriority = sql`${parts.priority} = ${after.priority}`;
  const idAfter = sql`${parts.id} > ${after.id}`;
  let valueAfter: SQL;
  if (parts.kind === "id") valueAfter = idAfter;
  else if (after.value === null) valueAfter = sql`(${parts.value} IS NULL AND ${idAfter})`;
  else {
    // Cursor values remain parameters; the only casts/direction are from the fixed sort definition.
    if (parts.kind === "number" ? !/^\d{1,19}$/.test(after.value) : !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(after.value)) throw new Error("review_cursor_invalid");
    const value = parts.kind === "number" ? sql`${after.value}::bigint` : sql`${after.value}::timestamp`;
    const later = parts.descending ? sql`${parts.value} < ${value}` : sql`${parts.value} > ${value}`;
    valueAfter = sql`(${later} OR ${parts.value} IS NULL OR (${parts.value} = ${value} AND ${idAfter}))`;
  }
  return sql`((${parts.priority} = false AND ${after.priority} = true) OR (${samePriority} AND ${valueAfter}))`;
}
