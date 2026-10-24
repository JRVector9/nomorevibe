import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { llmAssistResults, llmAssistWorks, products } from "./schema";
import type { IntroRewriteCandidate } from "@/lib/domain/products/intro-assist";

/** 사실 판정과 교정 생성은 별도 물리 호출이다. 제품 변경 전에도 원문에 묶인 후보를 보존한다. */
export const introAssistCorrections = pgTable("intro_assist_corrections", {
  id: uuid("id").primaryKey(), workId: uuid("work_id").notNull().references(() => llmAssistWorks.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  factualResultId: uuid("factual_result_id").notNull().references(() => llmAssistResults.id, { onDelete: "cascade" }),
  capacityRequestId: uuid("capacity_request_id").notNull(), requestHash: varchar("request_hash", { length: 64 }).notNull(),
  promptHash: varchar("prompt_hash", { length: 64 }).notNull(),
  responseHash: varchar("response_hash", { length: 64 }).notNull(), contractHash: varchar("contract_hash", { length: 64 }).notNull(),
  model: varchar("model", { length: 200 }).notNull(), backendId: varchar("backend_id", { length: 120 }).notNull(),
  correction: jsonb("correction").$type<IntroRewriteCandidate>().notNull(), applied: boolean("applied").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
}, t => [uniqueIndex("intro_assist_correction_request").on(t.capacityRequestId),
  uniqueIndex("intro_assist_correction_factual").on(t.factualResultId),
  check("intro_assist_correction_hash", sql`${t.requestHash} ~ '^[a-f0-9]{64}$' and ${t.promptHash} ~ '^[a-f0-9]{64}$' and ${t.responseHash} ~ '^[a-f0-9]{64}$'
    and ${t.contractHash} ~ '^[a-f0-9]{64}$'`)]);
