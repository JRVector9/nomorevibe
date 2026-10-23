import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import type { AssistInput, AssistOutcome } from "@/lib/domain/llm-assist/contracts";
import type { AssistControlMode, AssistWorkState, AssistWorkTask, UptimeAssistCandidate } from "@/lib/domain/llm-assist/work";
import { products } from "./schema";

export const llmAssistControls = pgTable("llm_assist_controls", {
  task: varchar("task", { length: 32 }).$type<AssistWorkTask>().primaryKey(),
  mode: varchar("mode", { length: 10 }).$type<AssistControlMode>().notNull().default("off"),
  confirmationRequired: boolean("confirmation_required").notNull().default(false),
  dispatchEnabled: boolean("dispatch_enabled").notNull().default(false), applyEnabled: boolean("apply_enabled").notNull().default(false),
  revision: bigint("revision", { mode: "number" }).notNull().default(1), updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
}, t => [check("llm_assist_control_task", sql`${t.task} in ('uptime')`),
  check("llm_assist_control_mode", sql`${t.mode} in ('off','shadow','confirm')`),
  check("llm_assist_control_confirm", sql`${t.mode}<>'confirm' or ${t.confirmationRequired}`),
  check("llm_assist_control_apply", sql`not ${t.applyEnabled} or (${t.dispatchEnabled} and ${t.mode}='confirm')`),
  check("llm_assist_control_revision", sql`${t.revision} between 1 and 9007199254740991`)]);

export const llmAssistWorks = pgTable("llm_assist_work", {
  id: uuid("id").primaryKey(), task: varchar("task", { length: 32 }).$type<AssistWorkTask>().notNull().references(() => llmAssistControls.task),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  originJob: varchar("origin_job", { length: 80 }).notNull(), sourceHash: varchar("source_hash", { length: 64 }).notNull(),
  source: jsonb("source").$type<UptimeAssistCandidate>().notNull(),
  policyVersion: varchar("policy_version", { length: 120 }).notNull(), promptVersion: varchar("prompt_version", { length: 120 }).notNull(),
  state: varchar("state", { length: 24 }).$type<AssistWorkState>().notNull().default("queued"),
  revision: bigint("revision", { mode: "number" }).notNull().default(1), priority: integer("priority").notNull().default(0),
  controlRevision: bigint("control_revision", { mode: "number" }).notNull().default(1),
  nextAttemptAt: timestamp("next_attempt_at", { mode: "string" }).notNull().defaultNow(),
  claimToken: uuid("claim_token"), claimJob: varchar("claim_job", { length: 80 }), claimJobToken: uuid("claim_job_token"),
  claimRequestedVersion: bigint("claim_requested_version", { mode: "number" }), ownerInstanceId: varchar("owner_instance_id", { length: 120 }), ownerBootId: uuid("owner_boot_id"),
  backendId: varchar("backend_id", { length: 120 }),
  capacityRequestId: uuid("capacity_request_id"), input: jsonb("input").$type<AssistInput>(), inputHash: varchar("input_hash", { length: 64 }),
  attempts: integer("attempts").notNull().default(0), lastError: varchar("last_error", { length: 120 }),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
}, t => [uniqueIndex("llm_assist_work_source_unique").on(t.task, t.productId, t.sourceHash),
  uniqueIndex("llm_assist_work_active_unique").on(t.task, t.productId).where(sql`${t.state} in ('claimed','indeterminate')`),
  index("llm_assist_work_due").on(t.nextAttemptAt, t.priority, t.id).where(sql`${t.state} in ('queued','waiting_capacity','retryable_transport')`),
  check("llm_assist_work_state", sql`${t.state} in ('queued','claimed','waiting_evidence','waiting_capacity','retryable_transport','human','done','obsolete','indeterminate')`),
  check("llm_assist_work_revision", sql`${t.revision} between 1 and 9007199254740991 and ${t.attempts} between 0 and 1000`),
  check("llm_assist_work_hash", sql`${t.sourceHash} ~ '^[a-f0-9]{64}$' and (${t.inputHash} is null or ${t.inputHash} ~ '^[a-f0-9]{64}$')`),
  check("llm_assist_work_source_shape", sql`jsonb_typeof(${t.source})='object' and ${t.source}->>'kind'=${t.task}`),
  check("llm_assist_work_claim", sql`(${t.state} in ('claimed','indeterminate')) = (${t.claimToken} is not null)
    and (${t.claimToken} is null or (${t.claimJob} is not null and ${t.claimJobToken} is not null and ${t.claimRequestedVersion} is not null and ${t.ownerInstanceId} is not null and ${t.ownerBootId} is not null))`)]);

export const llmAssistResults = pgTable("llm_assist_results", {
  id: uuid("id").primaryKey(), workId: uuid("work_id").notNull().references(() => llmAssistWorks.id, { onDelete: "cascade" }),
  workRevision: bigint("work_revision", { mode: "number" }).notNull(), capacityRequestId: uuid("capacity_request_id").notNull(),
  backendId: varchar("backend_id", { length: 120 }).notNull(), modelFamily: varchar("model_family", { length: 120 }).notNull(),
  contractHash: varchar("contract_hash", { length: 64 }).notNull(), inputHash: varchar("input_hash", { length: 64 }).notNull(),
  promptHash: varchar("prompt_hash", { length: 64 }).notNull(), responseHash: varchar("response_hash", { length: 64 }).notNull(),
  input: jsonb("input").$type<AssistInput>(),
  outcome: jsonb("outcome").$type<AssistOutcome>().notNull(), applied: boolean("applied").notNull().default(false),
  completedAt: timestamp("completed_at", { mode: "string" }).notNull().defaultNow(),
}, t => [uniqueIndex("llm_assist_results_request_unique").on(t.capacityRequestId),
  check("llm_assist_result_hash", sql`${t.contractHash} ~ '^[a-f0-9]{64}$' and ${t.inputHash} ~ '^[a-f0-9]{64}$'
    and ${t.promptHash} ~ '^[a-f0-9]{64}$' and ${t.responseHash} ~ '^[a-f0-9]{64}$'`)]);
