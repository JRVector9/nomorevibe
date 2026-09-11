import { pgTable, varchar, text, integer, timestamp, primaryKey, index } from "drizzle-orm/pg-core";

/**
 * 사유 번역 — 원문 글자 그대로의 해시로 한 번만 번역해 둔다.
 *
 * AI 심사 사유 3,459건 중 한국어는 607건이었다(2026-09-11). 같은 글이면 같은 번역을 다시 쓰고,
 * 한 글자라도 다르면 해시가 달라져 새로 번역한다 — 공백·대소문자도 고치지 않고 그대로 해시한다.
 *
 * - status: done(번역 있음) · failed(실패 — retry_at 이후 다시)
 */
export type TranslationStatus = "done" | "failed";

export const textTranslations = pgTable("text_translations", {
  /** sha256(원문 UTF-8) hex — DB 의 encode(sha256(convert_to(t, 'UTF8')), 'hex') 와 같다 */
  sourceHash: varchar("source_hash", { length: 64 }).notNull(),
  targetLang: varchar("target_lang", { length: 8 }).notNull().default("ko"),
  translated: text("translated"),
  status: varchar("status", { length: 12 }).$type<TranslationStatus>().notNull(),
  model: varchar("model", { length: 160 }),
  attempts: integer("attempts").notNull().default(0),
  errorCode: varchar("error_code", { length: 60 }),
  retryAt: timestamp("retry_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.sourceHash, table.targetLang] }),
  index("text_translations_updated_idx").on(table.status, table.updatedAt.desc()),
]);

export type TextTranslation = typeof textTranslations.$inferSelect;
