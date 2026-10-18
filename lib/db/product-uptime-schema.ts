import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import type { UptimeDisposition, UptimeObservation, UptimeSource } from "@/lib/domain/products/uptime-policy";
import type { UptimeBreakerState, UptimeClaimState, UptimeHostClass, UptimeSplitMode, UptimeSplitPolicy } from "@/lib/domain/products/uptime-split-policy";
import { products } from "./schema";

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

/** 0103 split-v1 제어(단일 행). mode 전환·policy 변경마다 epoch+1. legacy 가 기본이라 배포만으로는 동작이 바뀌지 않는다. */
export const uptimeSplitControl = pgTable("uptime_split_control", {
  id: integer("id").primaryKey().default(1),
  mode: varchar("mode", { length: 10 }).$type<UptimeSplitMode>().notNull().default("legacy"),
  epoch: bigint("epoch", { mode: "number" }).notNull().default(1),
  policy: jsonb("policy").$type<UptimeSplitPolicy>(), policyHash: varchar("policy_hash", { length: 64 }),
  updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
}, table => [check("uptime_split_control_id", sql`${table.id} = 1`),
  check("uptime_split_control_mode", sql`${table.mode} in ('legacy','claims')`),
  check("uptime_split_control_epoch", sql`${table.epoch} between 1 and 9007199254740991`),
  check("uptime_split_control_policy", sql`(${table.policy} is null) = (${table.policyHash} is null)
    and (${table.policy} is null or (jsonb_typeof(${table.policy}) = 'object' and ${table.policyHash} ~ '^[a-f0-9]{64}$'))
    and (${table.mode} = 'legacy' or ${table.policy} is not null)`)]);

/** 제품당 1행. idle → claimed → submitted → idle. 정식 기록(health·카운터·내림)은 home 적용기만 쓴다. */
export const uptimeClaims = pgTable("uptime_claims", {
  productId: integer("product_id").primaryKey().references(() => products.id, { onDelete: "cascade" }),
  state: varchar("state", { length: 10 }).$type<UptimeClaimState>().notNull().default("idle"),
  dueAt: timestamp("due_at", { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
  epoch: bigint("epoch", { mode: "number" }).notNull().default(0),
  controlEpoch: bigint("control_epoch", { mode: "number" }), token: uuid("token"),
  ownerInstanceId: varchar("owner_instance_id", { length: 48 }), ownerBootId: uuid("owner_boot_id"),
  host: varchar("host", { length: 24 }).$type<UptimeSource["host"]>(), hostClass: varchar("host_class", { length: 8 }).$type<UptimeHostClass>(),
  leaseUntil: timestamp("lease_until", { withTimezone: true, precision: 3 }), claimedAt: timestamp("claimed_at", { withTimezone: true, precision: 3 }),
  claimSlug: varchar("claim_slug", { length: 80 }), claimUrl: text("claim_url"), origin: text("origin"),
  claimSlot: timestamp("claim_slot", { withTimezone: true, precision: 3 }),
  confirmClass: varchar("confirm_class", { length: 8 }).$type<"home">(), confirmReason: varchar("confirm_reason", { length: 64 }),
  confirmRequestedAt: timestamp("confirm_requested_at", { withTimezone: true, precision: 3 }),
  affinityHomeUntil: timestamp("affinity_home_until", { withTimezone: true, precision: 3 }),
  conflictCount: integer("conflict_count").notNull().default(0),
  resultStartedAt: timestamp("result_started_at", { withTimezone: true, precision: 3 }),
  resultObservedAt: timestamp("result_observed_at", { withTimezone: true, precision: 3 }),
  resultKind: varchar("result_kind", { length: 12 }).$type<UptimeObservation["kind"]>(), resultStatus: integer("result_status"),
  resultLatencyMs: integer("result_latency_ms"), submittedAt: timestamp("submitted_at", { withTimezone: true, precision: 3 }),
  lastAppliedAt: timestamp("last_applied_at", { withTimezone: true, precision: 3 }),
  lastAppliedHost: varchar("last_applied_host", { length: 24 }).$type<UptimeSource["host"]>(),
  lastOutcome: varchar("last_outcome", { length: 32 }),
  updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
}, table => [index("uptime_claims_due_idx").on(table.dueAt, table.productId).where(sql`${table.state} <> 'submitted'`),
  index("uptime_claims_origin_live_idx").on(table.origin).where(sql`${table.state} = 'claimed'`),
  index("uptime_claims_submitted_idx").on(table.submittedAt, table.productId).where(sql`${table.state} = 'submitted'`)]);
// uptime_claims·uptime_host_windows·uptime_host_breakers 의 CHECK(상태 모양·Oracle=probe·결과 모양)는 drizzle/0103_uptime_split.sql 이 정본이다.

/** host 차단기 재료. 적용기가 묶음마다 host 별 분 단위 칸에 더한다. */
export const uptimeHostWindows = pgTable("uptime_host_windows", {
  host: varchar("host", { length: 24 }).$type<UptimeSource["host"]>().notNull(),
  bucket: timestamp("bucket", { withTimezone: true, precision: 0 }).notNull(),
  checks: integer("checks").notNull(), failures: integer("failures").notNull(), transport: integer("transport").notNull(),
}, table => [primaryKey({ columns: [table.host, table.bucket] })]);

/** host 차단기 상태. 행이 없으면 closed 다. */
export const uptimeHostBreakers = pgTable("uptime_host_breakers", {
  host: varchar("host", { length: 24 }).$type<UptimeSource["host"]>().primaryKey(),
  state: varchar("state", { length: 10 }).$type<UptimeBreakerState>().notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true, precision: 3 }), probeAfter: timestamp("probe_after", { withTimezone: true, precision: 3 }),
  coolDownMs: integer("cool_down_ms").notNull().default(600_000), reason: varchar("reason", { length: 64 }),
  ratio: numeric("ratio", { precision: 6, scale: 4, mode: "number" }),
  probeChecks: integer("probe_checks").notNull().default(0), probeFailures: integer("probe_failures").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
});
