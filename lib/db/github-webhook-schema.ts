import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { githubIssueOutbox } from "./github-issue-outbox-schema";
import type { GithubWebhookApp, GithubWebhookEvent } from "@/lib/domain/github-webhooks/verify";

/** Only signed target identifiers are retained; full webhook bodies may contain private data. */
export const githubWebhookEvents = pgTable("github_webhook_events", {
  deliveryId: uuid("delivery_id").primaryKey(),
  app: varchar("app", { length: 16 }).$type<GithubWebhookApp>().notNull(),
  event: varchar("event", { length: 50 }).$type<GithubWebhookEvent>().notNull(),
  action: varchar("action", { length: 64 }).notNull(),
  installationId: bigint("installation_id", { mode: "number" }),
  repositoryId: bigint("repository_id", { mode: "number" }),
  githubUserId: bigint("github_user_id", { mode: "number" }),
  issueId: bigint("issue_id", { mode: "number" }),
  issueNumber: integer("issue_number"),
  removedRepositoryIds: jsonb("removed_repository_ids").$type<number[]>().notNull().default([]),
  issuesPermission: varchar("issues_permission", { length: 16 }),
  repositorySelection: varchar("repository_selection", { length: 16 }),
  suspended: boolean("suspended"),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, table => [index("github_webhook_events_pending_idx").on(table.receivedAt).where(sql`${table.processedAt} IS NULL`),
  index("github_webhook_events_lifecycle_idx").on(table.installationId, table.receivedAt).where(sql`${table.app} = 'feedback'`),
  check("github_webhook_events_app_check", sql`${table.app} IN ('star','feedback')`),
  check("github_webhook_events_ids_check", sql`(${table.installationId} IS NULL OR ${table.installationId} BETWEEN 1 AND 9007199254740991) AND (${table.repositoryId} IS NULL OR ${table.repositoryId} BETWEEN 1 AND 9007199254740991) AND (${table.githubUserId} IS NULL OR ${table.githubUserId} BETWEEN 1 AND 9007199254740991) AND (${table.issueId} IS NULL OR ${table.issueId} BETWEEN 1 AND 9007199254740991) AND (${table.issueNumber} IS NULL OR ${table.issueNumber} > 0)`)]);

export const githubIntegrationActions = pgTable("github_integration_actions", {
  requestId: uuid("request_id").primaryKey(),
  outboxId: uuid("outbox_id").notNull().references(() => githubIssueOutbox.id, { onDelete: "cascade" }),
  action: varchar("action", { length: 16 }).$type<"requery" | "retransmit">().notNull(),
  previousDispatchId: uuid("previous_dispatch_id").notNull(),
  previousState: varchar("previous_state", { length: 16 }).notNull(),
  repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
  installationId: bigint("installation_id", { mode: "number" }).notNull(),
  bindingRevision: integer("binding_revision").notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  adminLogin: varchar("admin_login", { length: 120 }).notNull(),
  reason: text("reason").notNull(),
  duplicateRiskAcknowledged: boolean("duplicate_risk_acknowledged").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("github_integration_actions_outbox_idx").on(table.outboxId, table.createdAt),
  check("github_integration_actions_check", sql`${table.action} IN ('requery','retransmit') AND (${table.action} <> 'retransmit' OR ${table.duplicateRiskAcknowledged}) AND char_length(btrim(${table.reason})) BETWEEN 1 AND 1000 AND ${table.repositoryId} BETWEEN 1 AND 9007199254740991 AND ${table.installationId} BETWEEN 1 AND 9007199254740991 AND ${table.bindingRevision} > 0`)]);
