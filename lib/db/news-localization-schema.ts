import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import type { NewsLocalizationDraft } from "@/lib/news/localization-work";
import type { NewsLocalizationSource, NewsLocalizationValidation, NewsLocalizationOutcome } from "@/lib/news/localization-contract";
import { newsItems } from "./news-schema";
import { llmAssistResults, llmAssistWorks } from "./llm-assist-schema";

/** 공개 여부를 갖지 않는 번역 초안. news_items 원문·상태는 이 테이블로 바꾸지 않는다. */
export const newsLocalizations = pgTable("news_localizations", {
  resultId: uuid("result_id").primaryKey().references(() => llmAssistResults.id, { onDelete: "cascade" }),
  workId: uuid("work_id").notNull().references(() => llmAssistWorks.id, { onDelete: "cascade" }),
  newsItemId: integer("news_item_id").notNull().references(() => newsItems.id, { onDelete: "cascade" }),
  locale: varchar("locale", { length: 8 }).$type<"ko">().notNull().default("ko"),
  sourceHash: varchar("source_hash", { length: 64 }).notNull(), sourceSnapshot: jsonb("source_snapshot").$type<NewsLocalizationSource>().notNull(),
  status: varchar("status", { length: 20 }).$type<NewsLocalizationDraft["status"]>().notNull().default("needs_review"),
  title: varchar("title", { length: 45 }), summary: text("summary"),
  facts: jsonb("facts").$type<NewsLocalizationOutcome["state"]>(),
  validation: jsonb("validation").$type<NewsLocalizationValidation>().notNull(),
  backendId: varchar("backend_id", { length: 120 }).notNull(), modelFamily: varchar("model_family", { length: 120 }).notNull(),
  modelId: varchar("model_id", { length: 200 }).notNull(), policyVersion: varchar("policy_version", { length: 120 }).notNull(),
  promptVersion: varchar("prompt_version", { length: 120 }).notNull(),
  inputHash: varchar("input_hash", { length: 64 }).notNull(), contractHash: varchar("contract_hash", { length: 64 }).notNull(),
  promptHash: varchar("prompt_hash", { length: 64 }).notNull(), responseHash: varchar("response_hash", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
}, t => [index("news_localizations_source_idx").on(t.newsItemId, t.locale, t.sourceHash, t.createdAt.desc()),
  check("news_localizations_locale", sql`${t.locale}='ko'`),
  check("news_localizations_status", sql`${t.status} in ('draft','needs_review')`),
  check("news_localizations_draft", sql`${t.status}<>'draft' or (${t.title} is not null and ${t.summary} is not null and ${t.facts} is not null and ${t.validation} @> '{"ok":true,"authority":"translation_candidate_only","semanticCoverage":"bounded_patterns"}'::jsonb)`),
  check("news_localizations_source", sql`coalesce(jsonb_typeof(${t.sourceSnapshot})='object' and ${t.sourceSnapshot}->'id'=to_jsonb(${t.newsItemId}) and ${t.sourceSnapshot}->>'state' in ('approved','pending'),false)`),
  check("news_localizations_hash", sql`${t.sourceHash} ~ '^[a-f0-9]{64}$' and ${t.inputHash} ~ '^[a-f0-9]{64}$' and ${t.contractHash} ~ '^[a-f0-9]{64}$' and ${t.promptHash} ~ '^[a-f0-9]{64}$' and ${t.responseHash} ~ '^[a-f0-9]{64}$'`)]);
