import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import type { UptimeDisposition, UptimeObservation, UptimeSource } from "@/lib/domain/products/uptime-policy";

export const uptimeControl = pgTable("uptime_control", {
  id: integer("id").primaryKey().default(1), observationsEnabled: boolean("observations_enabled").notNull().default(false),
  gateEnabled: boolean("gate_enabled").notNull().default(false), revision: bigint("revision", { mode: "number" }).notNull().default(1),
  sources: jsonb("sources").$type<UptimeSource[]>().notNull().default([]),
}, table => [check("uptime_control_id", sql`${table.id} = 1`),
  check("uptime_control_revision", sql`${table.revision} between 1 and 9007199254740991`),
  check("uptime_control_gate", sql`not ${table.gateEnabled} or ${table.observationsEnabled}`)]);

export const uptimeObservations = pgTable("uptime_observations", {
  observationId: uuid("observation_id").primaryKey(), productId: integer("product_id").notNull(),
  slug: varchar("slug", { length: 80 }).notNull(), url: text("url").notNull(), urlHash: varchar("url_hash", { length: 64 }).notNull(),
  slot: timestamp("slot", { withTimezone: true, precision: 3 }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, precision: 3 }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true, precision: 3 }).notNull(),
  host: varchar("host", { length: 24 }).$type<UptimeSource["host"]>().notNull(),
  instanceId: varchar("instance_id", { length: 120 }).notNull(), region: varchar("region", { length: 120 }).notNull(),
  kind: varchar("kind", { length: 12 }).$type<UptimeObservation["kind"]>().notNull(), status: integer("status").notNull(),
  latencyMs: integer("latency_ms"), payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  disposition: varchar("disposition", { length: 20 }).$type<UptimeDisposition>().notNull(), reason: varchar("reason", { length: 64 }),
  revision: bigint("revision", { mode: "number" }).notNull(), receivedAt: timestamp("received_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, table => [uniqueIndex("uptime_observations_slot_idx").on(table.productId, table.urlHash, table.slot, table.host),
  index("uptime_observations_evidence_idx").on(table.observedAt, table.host),
  check("uptime_observations_status", sql`(${table.kind} = 'http' and ${table.status} between 100 and 599) or (${table.kind} in ('timeout','dns','network','unknown') and ${table.status} = 0)`),
  check("uptime_observations_time", sql`${table.observedAt} >= ${table.startedAt} and extract(epoch from ${table.slot}) % 21600 = 0 and ${table.startedAt} >= ${table.slot} and ${table.startedAt} < ${table.slot} + interval '6 hours'`),
  check("uptime_observations_host", sql`${table.host} in ('m3','mini','oracle-osaka-smoke') and (${table.host} <> 'oracle-osaka-smoke' or ${table.region} = 'ap-osaka-1')`),
  check("uptime_observations_hash", sql`${table.urlHash} ~ '^[a-f0-9]{64}$' and ${table.payloadHash} ~ '^[a-f0-9]{64}$'`),
  check("uptime_observations_disposition", sql`${table.disposition} in ('raw_only','applied','observation_hold','stale')`),
]);

export const uptimeGates = pgTable("uptime_gates", {
  productId: integer("product_id").primaryKey(), url: text("url").notNull(),
  productUpdatedAt: timestamp("product_updated_at", { mode: "string" }).notNull(),
  revision: bigint("revision", { mode: "number" }).notNull(),
  policyVersion: varchar("policy_version", { length: 32 }),
  state: varchar("state", { length: 20 }).$type<"admitted" | "observation_hold">().notNull(), reason: varchar("reason", { length: 64 }),
  lastObservationId: uuid("last_observation_id").notNull(), lastObservedAt: timestamp("last_observed_at", { withTimezone: true, precision: 3 }).notNull(),
  appliedObservationId: uuid("applied_observation_id"), healthCheckedAt: timestamp("health_checked_at", { precision: 3 }),
  failures: integer("failures").notNull().default(0), status: integer("status"),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true, precision: 3 }).notNull(),
  recheckRequestedAt: timestamp("recheck_requested_at", { withTimezone: true }),
});
