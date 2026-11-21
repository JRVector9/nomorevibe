import { sql } from "drizzle-orm";
import { check, doublePrecision, integer, pgTable, primaryKey, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { productAuditItems } from "./product-audit-schema";

/** Advisory only. No vote, human decision, product status or hold lives in this table. */
export const productAuditSameModelRechecks = pgTable("product_audit_same_model_rechecks", {
  itemId: integer("item_id").notNull().references(() => productAuditItems.id, { onDelete: "cascade" }),
  rejectRevision: varchar("reject_revision", { length: 32 }).notNull(),
  promptVersion: varchar("prompt_version", { length: 80 }).notNull(),
  source: varchar("source", { length: 40 }).notNull().default("same-model-recheck"),
  actor: varchar("actor", { length: 40 }).notNull().default("same-model-recheck"),
  model: varchar("model", { length: 160 }).notNull(),
  decision: varchar("decision", { length: 20 }).$type<"approve" | "reject" | "needs_review">().notNull(),
  reason: text("reason"), confidence: doublePrecision("confidence"),
  inputHash: varchar("input_hash", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.itemId, table.rejectRevision, table.promptVersion] }),
  check("same_model_recheck_source", sql`${table.source} = 'same-model-recheck' and ${table.actor} = 'same-model-recheck'`),
  check("same_model_recheck_decision", sql`${table.decision} in ('approve', 'reject', 'needs_review')`),
  check("same_model_recheck_confidence", sql`${table.confidence} between 0 and 1`),
]);
