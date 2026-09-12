import { pgTable, serial, integer, varchar, text, timestamp, doublePrecision, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";

/**
 * 2차 심사 — 1차(규칙·AI)와 다른 모델이 같은 입력을 따로 본다.
 *
 * 규칙만 통과해 공개된 것이 공개분의 96%였고(2026-09-11), 1차 AI 는 관찰 모드라 결정에 쓰이지 않았다.
 * 두 판단이 같고 확신이 높으면 "일치", 아니면 사람에게 넘긴다. 공개된 제품은 자동으로 내리지 않는다.
 *
 * - trigger: ai_decided(규칙이 못 가른 것을 AI 1차가 가름) · ai_held(1차도 못 가름) · risk(위험 신호) · sample(무작위 표본)
 * - status: pending(2차 대기) · agreed(일치 — 확정 대기) · needs_human(엇갈림·확신 낮음) · failed · resolved
 */
/** ai_held: 1차 AI 도 못 가른 것 — 1차는 표를 내지 않고 2차들끼리 견준다 */
export type SecondReviewTrigger = "ai_decided" | "ai_held" | "risk" | "sample";
export type SecondReviewStatus = "pending" | "agreed" | "needs_human" | "failed" | "resolved";
export type SecondReviewProvider = "claude-cli" | "abcllm";

export const secondReviews = pgTable("second_reviews", {
  id: serial("id").primaryKey(),
  candidateId: integer("candidate_id").notNull(),
  repo: varchar("repo", { length: 200 }).notNull(),
  /** 공개된 제품을 다시 본 것이면 그 slug — 사람이 내릴지 정한다 */
  publishedSlug: varchar("published_slug", { length: 80 }),
  trigger: varchar("trigger", { length: 20 }).$type<SecondReviewTrigger>().notNull(),
  /** 위험 신호 이름들 (trigger=risk) */
  signals: jsonb("signals").$type<string[]>().notNull().default([]),
  /** 1차 판단: AI 1차의 결론, 규칙만 통과한 공개분은 approve */
  firstDecision: varchar("first_decision", { length: 20 }).notNull(),
  firstConfidence: doublePrecision("first_confidence"),
  /** 1차를 본 모델 — 2차에 같은 모델이 서면 그 표는 메아리라 셈에서 뺀다 */
  firstModel: varchar("first_model", { length: 160 }),
  /** 이 입력으로 본 것 — 입력이 바뀌면 다시 본다 */
  inputHash: varchar("input_hash", { length: 64 }).notNull(),
  /** 누가 모델을 돌렸나 — claude-cli(로컬 CLI) 또는 abcllm(사내 게이트웨이) */
  provider: varchar("provider", { length: 20 }).$type<SecondReviewProvider>(),
  model: varchar("model", { length: 160 }),
  secondDecision: varchar("second_decision", { length: 20 }),
  secondConfidence: doublePrecision("second_confidence"),
  secondReason: text("second_reason"),
  errorCode: varchar("error_code", { length: 60 }),
  status: varchar("status", { length: 20 }).$type<SecondReviewStatus>().notNull().default("pending"),
  resolvedBy: varchar("resolved_by", { length: 120 }),
  resolution: varchar("resolution", { length: 40 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at"),
  resolvedAt: timestamp("resolved_at"),
}, (table) => [
  /**
   * 한 후보·한 입력에 모델마다 한 행.
   *
   * 모델을 여럿 세울 수 있어야 표가 쌓인다. model 은 올릴 때(enqueue) 설정값으로 채운다 —
   * 비워 두면 Postgres 가 NULL 을 서로 다른 값으로 보아 같은 후보가 매 틱 다시 올라온다.
   */
  uniqueIndex("second_reviews_candidate_input_model_idx").on(table.candidateId, table.inputHash, table.model),
  index("second_reviews_status_idx").on(table.status, table.createdAt.desc()),
]);

export type SecondReview = typeof secondReviews.$inferSelect;
