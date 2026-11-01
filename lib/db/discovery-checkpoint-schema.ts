import { bigint, index, pgTable, primaryKey, smallint, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import type { DiscoverySource, DiscoveryIntent } from "@/lib/crawl/discovery-checkpoint-contract";

export const discoveryCheckpoints = pgTable("discovery_checkpoints", {
  source: varchar("source", { length: 24 }).$type<DiscoverySource>().notNull(),
  subject: varchar("subject", { length: 64 }).notNull(),
  slot: smallint("slot").notNull(),
  generation: varchar("generation", { length: 64 }).notNull(),
  semantic: varchar("semantic", { length: 64 }).notNull(),
  reference: varchar("reference", { length: 200 }),
  intent: varchar("intent", { length: 24 }).$type<DiscoveryIntent>().notNull(),
  resumeAt: timestamp("resume_at"),
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
  progressAt: timestamp("progress_at"),
  failureStartedAt: timestamp("failure_started_at"),
  acknowledgedAt: timestamp("acknowledged_at"),
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.source, t.subject] }), uniqueIndex("discovery_checkpoints_slots").on(t.source, t.slot),
  index("discovery_checkpoints_retention").on(t.recordedAt)]);
