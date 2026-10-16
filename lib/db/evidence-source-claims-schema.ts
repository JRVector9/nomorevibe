import { sql } from "drizzle-orm";
import { pgTable, integer, bigint, boolean, varchar, jsonb, timestamp, uuid, check, index } from "drizzle-orm/pg-core";
import type { CanonicalSourceBinding, CanonicalSourceLease } from "@/lib/domain/evidence/source-contract";
export const evidenceSourceControl = pgTable("evidence_source_control", {
  id: integer("id").primaryKey().default(1), enabled: boolean("enabled").notNull().default(false),
  epoch: bigint("epoch", { mode: "number" }).notNull().default(1), cursor: integer("cursor").notNull().default(0),
}, t => [check("evidence_source_control_id", sql`${t.id}=1`), check("evidence_source_control_epoch", sql`${t.epoch} between 1 and 9007199254740991`), check("evidence_source_control_cursor", sql`${t.cursor} between 0 and 3`)]);
export const evidenceSourceClaims = pgTable("evidence_source_claims", {
  productId: integer("product_id").primaryKey(), binding: jsonb("binding").$type<CanonicalSourceBinding>().notNull(), bindingHash: varchar("binding_hash", { length: 64 }).notNull(),
  controlEpoch: bigint("control_epoch", { mode: "number" }).notNull(), epoch: bigint("epoch", { mode: "number" }).notNull(),
  instanceId: varchar("instance_id", { length: 120 }), bootId: varchar("boot_id", { length: 120 }), token: uuid("token"),
  job: jsonb("job").$type<CanonicalSourceLease["job"]>(), leaseUntil: timestamp("lease_until", { withTimezone: true, precision: 3 }),
  lane: varchar("lane", { length: 10 }).$type<"admin" | "normal" | "catchup">().notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
  lastOutcome: varchar("last_outcome", { length: 40 }), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [check("evidence_source_claims_owner", sql`(${t.token} is null and ${t.instanceId} is null and ${t.bootId} is null and ${t.leaseUntil} is null and ${t.job} is null) or (${t.token} is not null and ${t.instanceId} is not null and ${t.bootId} is not null and ${t.leaseUntil} is not null)`),
  check("evidence_source_claims_epochs", sql`${t.productId}>0 and ${t.epoch} between 1 and 9007199254740991 and ${t.controlEpoch} between 1 and 9007199254740991`),
  check("evidence_source_claims_hash", sql`${t.bindingHash} ~ '^[a-f0-9]{64}$'`),
  check("evidence_source_claims_lane", sql`${t.lane} in ('admin','normal','catchup')`), index("evidence_source_claims_due").on(t.nextAttemptAt, t.productId)]);
