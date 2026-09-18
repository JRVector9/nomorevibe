import { sql } from "drizzle-orm";
import { pgTable, serial, integer, varchar, text, timestamp, doublePrecision, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import type { ReviewOutcome, ReviewSource } from "@/lib/crawl/agent-review-contract";

/**
 * 발행분 감사 — 이미 공개된 제품을 지금의 1차 심사 글로 한 번 더 본다.
 *
 * 공개 10,751건 중 10,120건(94%)이 AI 심사를 한 번도 거치지 않았다(2026-09-18 프로드). 그중 무작위
 * 40건을 실제로 열어 보니 가를 수 있던 32건 중 21건(66%)이 올라와 있으면 안 되는 것이었다 —
 * 다른 곳에서 도는 소프트웨어의 소개 페이지, 로그인 벽, 문서 사이트, 회사 소개, index.js 원문.
 * 규칙 재검수(recheck.ts)는 그중 377건만 잡는다. 나머지는 모델이 봐야 한다.
 *
 * 이 표들은 "찾아낸 것"만 적는다. 감사는 아무것도 내리지 않는다 — crawl_candidates.state 도
 * products.status 도 쓰지 않는다. 내리는 것은 사람이 한 건씩 누른다(/admin/audit).
 *
 * 1차 심사 기록(crawl_review_attempts)을 쓰지 않는 이유: 그 표는 enforce 발행 문의 장부다.
 * 재사용 대조(matchingSource)가 automatic·현재 모델·판정 시각·문서·스캔까지 맞아야 하고,
 * recordAgentReview 는 enforce 에서 후보 상태를 결정으로 덮는다 — 공개된 후보를 거기 태우면
 * published 가 rejected/approved 로 뒤집히고 발행 잡이 다시 올리려 든다.
 */
export type ProductAuditStatus = "running" | "done" | "cancelled";
export type ProductAuditHumanDecision = "removed" | "kept";

export const productAuditCampaigns = pgTable("product_audit_campaigns", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  startedBy: varchar("started_by", { length: 120 }).notNull(),
  reason: varchar("reason", { length: 500 }).notNull(),
  /**
   * 이 감사가 어떤 기준으로 도는지 — 시작할 때 굳히고 바꾸지 않는다.
   *
   * 제공자·모델은 잡이 설정이 아니라 이 행에서 읽는다. 도중에 1차 심사자를 갈아 끼워도 한 감사
   * 안의 판단은 한 모델의 것이다. 프롬프트·규칙 버전은 코드가 정하므로, 배포로 바뀌면 잡이 이
   * 감사를 멈춘다(lib/crawl/jobs/product-audit.ts) — 두 글의 판단을 한 목록에 섞지 않는다.
   */
  promptVersion: varchar("prompt_version", { length: 40 }).notNull(),
  rulesVersion: varchar("rules_version", { length: 40 }).notNull(),
  provider: varchar("provider", { length: 80 }).notNull(),
  model: varchar("model", { length: 160 }).notNull(),
  /** "유지 판정도 다시 보기" — 사람이 유지로 둔 것까지 다시 넣었는지 */
  reauditKept: boolean("reaudit_kept").notNull().default(false),
  status: varchar("status", { length: 20 }).$type<ProductAuditStatus>().notNull().default("running"),
  finishedAt: timestamp("finished_at"),
}, (table) => [
  // 한 번에 하나만 돈다. 둘이 돌면 같은 제품을 두 번 묻고 목록도 둘로 갈린다
  uniqueIndex("product_audit_one_running_idx").on(table.status).where(sql`${table.status} = 'running'`),
]);

export const productAuditItems = pgTable("product_audit_items", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => productAuditCampaigns.id),
  /**
   * 제품은 id 로 잇는다. slug 는 메이커가 지우면 다시 쓰일 수 있다(manage.ts deleteProduct) —
   * slug 로 이으면 "유지" 판정이 같은 이름을 얻은 남의 제품에 붙는다.
   *
   * products 로 외래 키를 걸지 않는다. 제품이 지워져도 이 행은 무엇을 왜 짚었는지의 기록으로
   * 남고, products 와 조인하는 곳(목록·다음 일감)에서 저절로 빠진다. 외래 키를 걸면 제품 삭제
   * (removeProductAndEvidence)가 이 표까지 알아야 한다.
   */
  productId: integer("product_id").notNull(),
  /** 올릴 때의 slug. 행동 폼이 싣고 오는 값과 대조한다 */
  slug: varchar("slug", { length: 80 }).notNull(),
  /**
   * 모델이 본 페이지 내용(심사 입력의 product 부분)의 해시. 유지 판정이 아직 유효한지 가른다.
   *
   * 입력 전체(inputHash)를 쓰지 않는다. 거기에는 스타 수·마지막 푸시·프롬프트 버전이 들어 있어,
   * 스타 하나나 프롬프트 한 줄에도 "유지"가 풀린다 — 사람이 이미 본 것을 다시 보게 된다.
   * 사람이 판단한 것은 페이지이므로 페이지가 바뀌었을 때만 다시 넣는다.
   */
  sourceHash: varchar("source_hash", { length: 64 }),
  aiDecision: varchar("ai_decision", { length: 20 }).$type<ReviewOutcome["decision"]>(),
  aiReason: text("ai_reason"),
  aiConfidence: doublePrecision("ai_confidence"),
  aiCategory: varchar("ai_category", { length: 40 }),
  reviewedAt: timestamp("reviewed_at"),
  /** 모델이 답하지 못한 횟수. MAX_REVIEW_ATTEMPTS 에 닿으면 더 묻지 않는다 */
  attempts: integer("attempts").notNull().default(0),
  /** 마지막 실패. no_source 는 수집 원본이 없어 물을 수조차 없다는 뜻이다(메이커 등록분) */
  errorCode: varchar("error_code", { length: 120 }),
  retryAt: timestamp("retry_at"),
  humanDecision: varchar("human_decision", { length: 20 }).$type<ProductAuditHumanDecision>(),
  humanBy: varchar("human_by", { length: 120 }),
  humanAt: timestamp("human_at"),
  humanNote: varchar("human_note", { length: 500 }),
  /** 유지 판정이 다음 감사에서 이 제품을 빼 주는 기한 */
  keepUntil: timestamp("keep_until"),
}, (table) => [
  uniqueIndex("product_audit_items_campaign_product_idx").on(table.campaignId, table.productId),
  // 잡이 다음 일감을 고른다 — 아직 답을 받지 못한 것만
  index("product_audit_items_pending_idx").on(table.campaignId, table.id).where(sql`${table.aiDecision} is null`),
  // 사람이 볼 목록 — 아직 아무도 손대지 않은 것만
  index("product_audit_items_open_idx").on(table.campaignId, table.aiDecision).where(sql`${table.humanDecision} is null`),
  // 새 감사를 올릴 때 살아 있는 유지 판정을 찾는다
  index("product_audit_items_kept_idx").on(table.productId, table.keepUntil).where(sql`${table.humanDecision} = 'kept'`),
]);

/**
 * 모델을 부를 때마다 한 행 — 덧붙이기만 한다. 왜 짚었는지의 근거다.
 *
 * 입력 전문(스냅숏)은 남기지 않는다. 10,751건 × 최대 64KB 라 이 표만 수백 MB 가 되고, 사람은
 * 어차피 지금 떠 있는 페이지를 열어 보고 판단한다. 대신 어느 원본(문서 id·수집 시각·스캔)을
 * 봤는지와 입력 해시를 남긴다. 모델의 사유는 pageText 를 인용하라고 되어 있다(REVIEW_SYSTEM_PROMPT).
 */
export const productAuditAttempts = pgTable("product_audit_attempts", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => productAuditItems.id),
  startedAt: timestamp("started_at").notNull(),
  completedAt: timestamp("completed_at").notNull().defaultNow(),
  provider: varchar("provider", { length: 80 }).notNull(),
  model: varchar("model", { length: 160 }).notNull(),
  inputHash: varchar("input_hash", { length: 64 }).notNull(),
  source: jsonb("source").$type<ReviewSource>().notNull(),
  outcome: jsonb("outcome").$type<ReviewOutcome>(),
  errorCode: varchar("error_code", { length: 120 }),
}, (table) => [
  index("product_audit_attempts_item_idx").on(table.itemId),
]);

export type ProductAuditCampaign = typeof productAuditCampaigns.$inferSelect;
export type ProductAuditItem = typeof productAuditItems.$inferSelect;
