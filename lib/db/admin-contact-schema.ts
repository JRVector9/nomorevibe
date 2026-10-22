import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

/** 관리자 수동 접수 전용. 주소·내용·처리 메모를 공개 목록/일반 작업 로그에 복사하지 않는다. */
export const CONTACT_STATUSES = ["new", "in_progress", "waiting", "resolved", "spam"] as const;
export type ContactStatus = typeof CONTACT_STATUSES[number];
export const adminContactRequests = pgTable("admin_contact_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  senderEmail: varchar("sender_email", { length: 254 }).notNull(),
  subject: varchar("subject", { length: 200 }).notNull(),
  body: varchar("body", { length: 10000 }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  status: varchar("status", { length: 16 }).$type<ContactStatus>().notNull().default("new"),
  handlingNote: varchar("handling_note", { length: 2000 }).notNull().default(""),
  createdBy: varchar("created_by", { length: 120 }).notNull(),
  updatedBy: varchar("updated_by", { length: 120 }).notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("admin_contact_requests_queue_idx").on(table.status, table.receivedAt, table.id),
  check("admin_contact_requests_status_check", sql`${table.status} in ('new', 'in_progress', 'waiting', 'resolved', 'spam')`),
  check("admin_contact_requests_version_check", sql`${table.version} > 0`),
  check("admin_contact_requests_content_check", sql`char_length(btrim(${table.senderEmail})) > 0 and char_length(btrim(${table.subject})) > 0 and char_length(btrim(${table.body})) > 0`),
]);
