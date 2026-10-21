import { sql } from "drizzle-orm";
import { check, doublePrecision, index, integer, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

/**
 * 2차 갈림 판가름(lib/crawl/gate-split-tiebreak.ts, 2026-10-21) — 두 모델 승인 관문에서 1차 승인·2차 반대로 갈려 사람에게 넘어온
 * 후보(second_review_split)를 gpu3090 Qwen-v2 에 한 번 더 물은 기록. 관문 세대(second_reviews.generation_key)·덧붙임 판마다 한 줄이라
 * 같은 입력을 두 번 묻지 않는다.
 *
 * second_reviews 에 행을 더하지 않는 까닭: 그 표의 행은 세워 둔 투표자(voters·fallbacks)의 표다. 투표자가 아닌 모델의 열린 행은
 * closeSettledSecondReviews 가 model_removed 로 닫고, 그 닫힘이 reopenOrphanedGateHolds 의 되돌리기 조건이며, 발행 관문·replay 기록기가
 * 같은 1차 판단의 모든 관문 행을 읽는다. 판가름은 표가 아니라 사람 큐를 거르는 의견이라 따로 둔다.
 *
 * - state: running(묻는 중) · succeeded(답을 받음) · failed(실패 — retry_after 뒤 다시) · ineligible(관문 입력을 그대로 다시 만들 수 없음)
 * - applied: 답으로 무엇을 했나 — rejected(자동 거부) · kept_human(승인·보류 — 사람에게 남김) · held_minority(거부지만 다수가 아님)
 *   · held_catalog(카탈로그 예외) · switch_off(답을 받는 사이 꺼짐) · superseded(답을 받는 사이 후보·관문이 바뀜)
 *
 * crawl_candidates 를 외래 키로 걸지 않는다(second_reviews 와 같다) — 마이그레이션이 바쁜 후보 표를 잠그지 않게.
 */
export type GateSplitTiebreakState = "running" | "succeeded" | "failed" | "ineligible";

export const gateSplitTiebreaks = pgTable("gate_split_tiebreaks", {
  id: serial("id").primaryKey(),
  candidateId: integer("candidate_id").notNull(),
  repo: varchar("repo", { length: 200 }).notNull(),
  /** 관문이 붙은 1차 판단과 그 입력 — 대상이 아니면(ineligible) 비어 있을 수 있다 */
  firstAttemptId: integer("first_attempt_id"),
  generationKey: varchar("generation_key", { length: 64 }).notNull(),
  inputHash: varchar("input_hash", { length: 64 }),
  sourceRevisionHash: varchar("source_revision_hash", { length: 64 }),
  /** QWEN_V2_PROMPT_VERSION — 덧붙임 판이 바뀌면 같은 세대도 다시 묻는다 */
  promptVersion: varchar("prompt_version", { length: 40 }).notNull(),
  model: varchar("model", { length: 160 }).notNull(),
  state: varchar("state", { length: 20 }).$type<GateSplitTiebreakState>().notNull(),
  decision: varchar("decision", { length: 20 }).$type<"approve" | "reject" | "needs_review">(),
  confidence: doublePrecision("confidence"),
  reason: text("reason"),
  applied: varchar("applied", { length: 30 }),
  /** 자동 거부의 결정 기록(crawl_review_attempts kind=delegated) */
  decisionAttemptId: integer("decision_attempt_id"),
  errorCode: varchar("error_code", { length: 60 }),
  errorDetail: varchar("error_detail", { length: 80 }),
  /** 항목 탓 실패만 센다 — 부르는 곳이 탈 난 실패(시간 초과·연결·5xx)와 멈춤은 세지 않는다 */
  failureCount: integer("failure_count").notNull().default(0),
  latencyMs: integer("latency_ms"),
  leaseToken: varchar("lease_token", { length: 80 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  retryAfter: timestamp("retry_after"),
}, (table) => [
  uniqueIndex("gate_split_tiebreaks_generation_idx").on(table.candidateId, table.generationKey, table.promptVersion),
  index("gate_split_tiebreaks_completed_idx").on(table.completedAt.desc()),
  check("gate_split_tiebreaks_state_check", sql`${table.state} in ('running', 'succeeded', 'failed', 'ineligible')`),
  check("gate_split_tiebreaks_decision_check", sql`${table.decision} is null or ${table.decision} in ('approve', 'reject', 'needs_review')`),
  check("gate_split_tiebreaks_reason_check", sql`char_length(${table.reason}) <= 2000`),
]);

export type GateSplitTiebreak = typeof gateSplitTiebreaks.$inferSelect;
