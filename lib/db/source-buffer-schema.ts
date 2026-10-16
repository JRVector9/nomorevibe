import { sql } from "drizzle-orm";
import { pgTable, integer, bigint, boolean, varchar, timestamp, check } from "drizzle-orm/pg-core";

/** Count/age hysteresis only. The activation flag lives in audited crawl settings. */
export const crawlSourceBufferControl = pgTable("crawl_source_buffer_control", {
  id: integer("id").primaryKey().default(1),
  revision: bigint("revision", { mode: "number" }).notNull().default(1),
  policyVersion: integer("policy_version").notNull().default(1),
  blocked: boolean("blocked").notNull().default(false),
  lastDecisionAt: timestamp("last_decision_at", { withTimezone: true, precision: 3 }),
  lastReason: varchar("last_reason", { length: 30 }).notNull().default("unobserved"),
}, t => [check("crawl_source_buffer_id", sql`${t.id}=1`),
  check("crawl_source_buffer_revision", sql`${t.revision} between 1 and 9007199254740991`),
  check("crawl_source_buffer_policy", sql`${t.policyVersion}=1`),
  check("crawl_source_buffer_reason", sql`${t.lastReason} in ('unobserved','ready','count_pressure','measurement_unknown')`)]);
