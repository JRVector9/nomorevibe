import { sql } from "drizzle-orm";
import { pgTable, serial, integer, varchar, text, timestamp, doublePrecision, real, boolean, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import type { ReviewOutcome, ReviewSource } from "@/lib/crawl/agent-review-contract";
import type { AuditProvider } from "@/lib/crawl/product-audit-reviewer";

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
 * 확신 높은 거부는 사람이 정할 때까지 공개 목록에서만 뺀다(0110 감사 보류, lib/crawl/product-audit-hold.ts).
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
   * 제공자·모델은 잡이 설정이 아니라 이 행에서 읽는다. 도중에 1차 심사자 설정을 갈아 끼워도 감사는 따라가지 않는다 —
   * 감사의 심사자를 바꾸는 것은 사람이 감사 화면에서 사유를 적고 누르는 '남은 감사 모델 바꾸기'뿐이다(아래 current_*, 0112).
   * 프롬프트·규칙 버전은 코드가 정하므로, 배포로 바뀌면 잡이 이 감사를 멈춘다(lib/crawl/jobs/product-audit.ts) —
   * 두 글의 판단을 한 목록에 섞지 않는다.
   */
  promptVersion: varchar("prompt_version", { length: 40 }).notNull(),
  rulesVersion: varchar("rules_version", { length: 40 }).notNull(),
  provider: varchar("provider", { length: 80 }).notNull(),
  model: varchar("model", { length: 160 }).notNull(),
  /**
   * 남은 감사 모델 바꾸기(0112) — 아직 답이 없는 항목을 이 심사자로 묻는다. 비어 있으면 위의 provider·model 이다(product-audit-reviewer.ts).
   * 위의 두 칸은 이 감사가 무엇으로 시작했는지의 기록이라 바꾸지 않는다. 이미 답한 항목은 그대로고, 답마다 누가 답했는지는
   * 항목의 ai_provider·ai_model 과 시도 행이 적는다. 바꾼 사유는 작업 로그(operations_audit audit-switch-model)에 남는다.
   */
  currentProvider: varchar("current_provider", { length: 80 }).$type<AuditProvider>(),
  currentModel: varchar("current_model", { length: 160 }),
  switchedAt: timestamp("switched_at"),
  switchedBy: varchar("switched_by", { length: 120 }),
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
  /**
   * 이 답을 낸 심사자(0112) — 감사 도중 모델을 바꾸면 한 감사에 두 모델의 답이 섞인다. 비어 있으면 그 감사의 provider·model 이 답했다
   * (0112 전 행). 같은 모델에 두 번째 의견을 묻지 않는 규칙과 모델별 보류 규칙(second-opinion-rules.ts)이 coalesce(이 칸, 감사)로 읽는다
   */
  aiProvider: varchar("ai_provider", { length: 80 }),
  aiModel: varchar("ai_model", { length: 160 }),
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
  /**
   * 사람이 이 항목의 보류를 풀었다(0110) — 차단 해제·모두 풀기. 사람 결정(human_decision)은 아니지만 같은 항목으로 다시 보류하지 않는다.
   * 유지·내리기는 human_decision 이 남으므로 따로 적지 않는다(lib/crawl/product-audit-hold.ts)
   */
  holdReleasedAt: timestamp("hold_released_at"),
}, (table) => [
  uniqueIndex("product_audit_items_campaign_product_idx").on(table.campaignId, table.productId),
  // 잡이 다음 일감을 고른다 — 아직 답을 받지 못한 것만
  index("product_audit_items_pending_idx").on(table.campaignId, table.id).where(sql`${table.aiDecision} is null`),
  // 사람이 볼 목록 — 아직 아무도 손대지 않은 것만
  index("product_audit_items_open_idx").on(table.campaignId, table.aiDecision).where(sql`${table.humanDecision} is null`),
  // 새 감사를 올릴 때 살아 있는 유지 판정을 찾는다
  index("product_audit_items_kept_idx").on(table.productId, table.keepUntil).where(sql`${table.humanDecision} = 'kept'`),
  // Search generation and health audits look up the latest available reviewer note.
  index("product_audit_items_latest_reason_idx").on(table.productId, table.id.desc()).where(sql`${table.aiReason} is not null`),
  // 감사 보류(0110) — 그 제품의 더 새 항목 찾기와 보류를 풀 때 그 제품의 열린 항목에 '풀었음'을 적는 쓰기
  index("product_audit_items_product_id_idx").on(table.productId, table.id),
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
  /** 이 호출이 쓴 글의 판(0112) — Qwen 직접 심사는 QWEN_V2_PROMPT_VERSION. 비어 있으면 그 감사의 prompt_version 이다(0112 전 행) */
  promptVersion: varchar("prompt_version", { length: 40 }),
  inputHash: varchar("input_hash", { length: 64 }).notNull(),
  source: jsonb("source").$type<ReviewSource>().notNull(),
  outcome: jsonb("outcome").$type<ReviewOutcome>(),
  errorCode: varchar("error_code", { length: 120 }),
}, (table) => [
  index("product_audit_attempts_item_idx").on(table.itemId),
]);

/**
 * 감사 답에 대한 다른 모델의 두 번째 의견(0110) — 감사 모델이 아닌 모델(2026-10-21 grok CLI 일괄)이 같은 항목을 다시 본 것.
 *
 * grok 은 밖에서 돌린 결과(JSONL)를 scripts/ops/import-audit-second-opinions.ts 가 옮겨 적고, gpu3090 Qwen-v2 는 감사 잡 틱마다 받아 적는다
 * (lib/crawl/audit-second-opinion-auto.ts, source qwen-v2-auto) — 둘 다 같은 쓰기(audit-second-opinion-import.ts)를 지난다. 같은 (항목, 모델)은
 * 덮어써서 다시 넣어도 한 줄이다. 두 번째 모델도 거절했으면 사유 갈래와 상관없이 보류의 까닭이 된다(lib/crawl/product-audit-hold.ts).
 * 승인·판단 보류는 보류하지도 풀지도 않는다 — 감사 화면이 '갈림'으로 보여 사람이 본다.
 * item_id 가 JSONL 의 auditResultId(product_audit_items.id)다. 항목이 지워지면 함께 지운다.
 */
export const productAuditSecondOpinions = pgTable("product_audit_second_opinions", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => productAuditItems.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull(),
  model: varchar("model", { length: 160 }).notNull(),
  decision: varchar("decision", { length: 20 }).$type<ReviewOutcome["decision"]>().notNull(),
  confidence: real("confidence"),
  reason: text("reason"),
  inputHash: varchar("input_hash", { length: 128 }),
  source: varchar("source", { length: 40 }).notNull(),
  /** 그 의견을 받은 글의 판(0111) — Qwen-v2 자동 의견(qwen-direct-review.ts QWEN_V2_PROMPT_VERSION). grok 일괄은 비어 있다 */
  promptVersion: varchar("prompt_version", { length: 40 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("product_audit_second_opinions_item_model_idx").on(table.itemId, table.model),
  check("product_audit_second_opinions_decision_check", sql`${table.decision} in ('approve', 'reject', 'needs_review')`),
  check("product_audit_second_opinions_reason_check", sql`char_length(${table.reason}) <= 2000`),
]);

/**
 * 감사 정책 처리(0116, 2026-10-22) — 운영자가 거르기로 고른 감사 항목을 한 번에 닫는 실행 한 번(lib/crawl/audit-policy.ts).
 *
 * kind: close(열린 거절을 내리기·유지·보류 풀기) · import(두 번째 의견 파일 올리기) · extend(곧 끝나는 유지 연장).
 * status: staging·staged(올린 파일을 받는 중·받음 — import 만) → applying(나눠 적용 중) → applied → undoing → undone. discarded 는 버린 올리기다.
 * 적용 중·되돌리기 중인 실행은 한 번에 하나다(product_audit_policy_runs_one_active_idx). filter 는 사람이 미리 본 거르기 그대로,
 * summary 는 미리보기가 건너뛴 것과 까닭(import 는 파일 검사 결과)이다. 작업 로그에는 실행마다 한 줄(audit-policy-apply·audit-policy-undo)이 남는다.
 */
export type ProductAuditPolicyRunKind = "close" | "import" | "extend";
export type ProductAuditPolicyRunAction = "remove" | "keep" | "release" | "import" | "extend";
export type ProductAuditPolicyRunStatus = "staging" | "staged" | "applying" | "applied" | "undoing" | "undone" | "discarded";

export const productAuditPolicyRuns = pgTable("product_audit_policy_runs", {
  id: serial("id").primaryKey(),
  kind: varchar("kind", { length: 20 }).$type<ProductAuditPolicyRunKind>().notNull(),
  action: varchar("action", { length: 20 }).$type<ProductAuditPolicyRunAction>().notNull(),
  status: varchar("status", { length: 20 }).$type<ProductAuditPolicyRunStatus>().notNull(),
  filter: jsonb("filter").$type<Record<string, unknown>>().notNull().default({}),
  options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
  summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}),
  /** 만들 때 고른 항목 수 — 사람이 적은 수와 같아야 만들어진다 */
  planned: integer("planned").notNull().default(0),
  note: varchar("note", { length: 500 }),
  createdBy: varchar("created_by", { length: 120 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  appliedAt: timestamp("applied_at"),
  undoBy: varchar("undo_by", { length: 120 }),
  undoStartedAt: timestamp("undo_started_at"),
  undoneAt: timestamp("undone_at"),
}, (table) => [
  uniqueIndex("product_audit_policy_runs_one_active_idx").on(sql`(true)`).where(sql`${table.status} in ('applying', 'undoing')`),
  check("product_audit_policy_runs_kind_check", sql`${table.kind} in ('close', 'import', 'extend')`),
  check("product_audit_policy_runs_action_check", sql`${table.action} in ('remove', 'keep', 'release', 'import', 'extend')`),
  check("product_audit_policy_runs_status_check",
    sql`${table.status} in ('staging', 'staged', 'applying', 'applied', 'undoing', 'undone', 'discarded')`),
]);

/**
 * 실행이 손댈(손댄) 감사 항목 하나. before 는 손대기 전의 제품·항목 상태(되돌리기가 쓴다), after 는 손댄 뒤 값(되돌리기 전에 그대로인지 견준다).
 * applied_at 은 적용한 트랜잭션의 now() — 그 트랜잭션이 적은 human_at·hold_released_at·의견 created_at 과 같아 "그 뒤에 바뀌었나"를 가른다.
 * product_audit_items 로 외래 키를 걸지 않는다(0116 — 감사 잡이 쉬지 않고 쓰는 표를 잠그지 않게). 감사 항목은 지우지 않는다.
 */
export type ProductAuditPolicyRunItemState = "pending" | "applied" | "skipped" | "cancelled" | "undone" | "undo_blocked";

export const productAuditPolicyRunItems = pgTable("product_audit_policy_run_items", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull().references(() => productAuditPolicyRuns.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull(),
  productId: integer("product_id").notNull(),
  slug: varchar("slug", { length: 80 }).notNull(),
  state: varchar("state", { length: 20 }).$type<ProductAuditPolicyRunItemState>().notNull().default("pending"),
  /** 건너뛴 까닭·되돌리지 못한 까닭 */
  reason: varchar("reason", { length: 60 }),
  /** import: 올린 의견 한 줄(읽어 고친 값) */
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  before: jsonb("before").$type<Record<string, unknown>>(),
  after: jsonb("after").$type<Record<string, unknown>>(),
  appliedAt: timestamp("applied_at"),
  undoneAt: timestamp("undone_at"),
}, (table) => [
  uniqueIndex("product_audit_policy_run_items_run_item_idx").on(table.runId, table.itemId),
  index("product_audit_policy_run_items_state_idx").on(table.runId, table.state, table.id),
  check("product_audit_policy_run_items_state_check",
    sql`${table.state} in ('pending', 'applied', 'skipped', 'cancelled', 'undone', 'undo_blocked')`),
]);

export type ProductAuditCampaign = typeof productAuditCampaigns.$inferSelect;
export type ProductAuditItem = typeof productAuditItems.$inferSelect;
export type ProductAuditSecondOpinion = typeof productAuditSecondOpinions.$inferSelect;
export type ProductAuditPolicyRun = typeof productAuditPolicyRuns.$inferSelect;
export type ProductAuditPolicyRunItem = typeof productAuditPolicyRunItems.$inferSelect;
