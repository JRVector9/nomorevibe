import { pgTable, serial, text, varchar, timestamp, jsonb, integer, index, doublePrecision, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ReviewOutcome, ReviewSnapshot, ReviewSource } from "@/lib/crawl/agent-review-contract";

/**
 * 크롤 파이프라인.
 *
 * 검색엔진 크롤러의 뼈대를 따른다 — 프론티어(큐) → 원본 보관 → 판정 → 색인.
 * 핵심은 크롤과 색인이 끊겨 있다는 것이다. 수집기가 무엇을 긁어오든 사이트에 보이는
 * products는 발행 단계를 거쳐야만 바뀐다.
 *
 * 다만 재귀 크롤은 아니다. 프론티어는 GitHub 검색으로만 채워지고, 가져온 문서에서
 * 새 링크를 뽑아 확장하지 않는다. 그래서 검색엔진 크롤러의 가장 어려운 부분
 * (URL 정규화 폭발, 스팸 트랩, 무한 공간)이 없다.
 */

// ─────────────────────────── 프론티어 ───────────────────────────

/**
 * - pending:  조사 대기
 * - fetching: 가져오는 중 (프로세스가 죽으면 next_attempt_at 지나고 회수)
 * - done:     원본 확보 완료
 * - failed:   재시도 한도 소진
 * - skipped:  조사할 가치 없다고 판단 (판정 단계 이전의 값싼 거르기)
 */
export type FrontierState = "pending" | "fetching" | "done" | "failed" | "skipped";

export const crawlFrontier = pgTable(
  "crawl_frontier",
  {
    id: serial("id").primaryKey(),
    /** owner/name — 파이프라인 전체에서 이 값이 자연키다 */
    repo: varchar("repo", { length: 200 }).notNull().unique(),
    /** 어떤 신호로 발견했는지 (commit-trailer 등) — 신호별 수율을 나중에 비교하려면 필요 */
    signal: varchar("signal", { length: 40 }).notNull(),
    /**
     * 그 신호가 말하는 "만든 AI" 추정값. 없으면 추정하지 않는다.
     *
     * signal(자유 텍스트 라벨)로 설정을 되짚지 않고 발견 시점의 값을 굳혀 둔다. 운영자가
     * 라벨을 고치면 밀려 있던 후보가 전부 추정을 잃고, 라벨을 재사용하면 과거 발견분이
     * 소급 재라벨되기 때문이다.
     */
    builder: varchar("builder", { length: 40 }),
    /** 높을수록 먼저 조사한다 */
    priority: integer("priority").notNull().default(0),
    state: varchar("state", { length: 20 }).$type<FrontierState>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    /** 이 시각 이후에 시도한다. 실패 시 백오프로 미루고, fetching 중 죽으면 회수 기준이 된다 */
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    discoveredAt: timestamp("discovered_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // 큐에서 꺼내는 쿼리 전용: WHERE state=? AND next_attempt_at<=now() ORDER BY priority DESC
    index("crawl_frontier_dequeue_idx").on(t.state, t.nextAttemptAt, t.priority.desc()),
  ],
);

// ─────────────────────────── 원본 보관 ───────────────────────────

/**
 * 가져온 원본.
 *
 * 판정 결과와 분리해서 보관하는 이유: 판정 규칙을 바꿨을 때 GitHub을 다시 긁지 않고
 * 재판정할 수 있다. search가 30회/분인 상황에서 이 차이는 크다.
 */
export const crawlDocuments = pgTable("crawl_documents", {
  id: serial("id").primaryKey(),
  repo: varchar("repo", { length: 200 }).notNull().unique(),
  /** GitHub 레포 메타 원본 (stars, homepage, language, topics, fork, owner.type, pushed_at 등) */
  repoMeta: jsonb("repo_meta").$type<Record<string, unknown>>().notNull(),
  /** 정규화된 배포 URL. 없으면 null (homepage 미설정) */
  productUrl: text("product_url"),
  /** 배포 URL 응답 코드. null이면 아직 확인 안 함, 0이면 확인했으나 닿지 않음 */
  pageStatus: integer("page_status"),
  /** 배포 페이지에서 뽑은 것 (title, description, ogImage) */
  pageMeta: jsonb("page_meta").$type<Record<string, unknown>>(),
  fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
});

// ─────────────────────────── 판정 ───────────────────────────

/**
 * - new:           아직 판정 안 함
 * - approved:      자동 규칙이 통과시킴 — 발행 대상
 * - rejected:      자동 규칙이 걸러냄
 * - needs_review:  애매해서 사람이 봐야 함 (심사는 '자동 판정 + 예외만'이므로 여기만 손댄다)
 * - published:     products에 발행됨
 */
export type CandidateState = "new" | "approved" | "rejected" | "needs_review" | "published";

/**
 * 판정 사유 코드.
 *
 * 문자열로 남기는 이유: 어떤 규칙이 얼마나 거르고 있는지 집계할 수 있어야 규칙을
 * 고칠 수 있다. "왜 이게 안 올라왔지"에 답할 수 없으면 자동 판정은 블랙박스가 된다.
 */
export type DecisionReason =
  | "no_homepage" // homepage 미설정
  | "unreachable" // 배포 URL 접속 불가
  | "not_a_product" // homepage가 GitHub·SNS 링크 등 배포물이 아님
  | "large_oss" // 대형 오픈소스 — AI가 커밋 일부에 참여했을 뿐
  | "personal_site" // 개인 홈페이지·블로그·문서 사이트
  | "fork" // 포크된 레포
  | "already_listed" // 같은 URL이 이미 products에 있음
  | "banned" // 차단된 URL
  | "ambiguous" // 규칙으로 못 가름 → 사람이 판단
  | "passed" // 통과
  | "ai_evidence_pending"
  | "ai_evidence_insufficient"
  | "ai_evidence_not_found"
  | "repository_relationship_conflict"
  | "source_changed"
  | "ai_evidence_supported";

export const crawlCandidates = pgTable(
  "crawl_candidates",
  {
    id: serial("id").primaryKey(),
    repo: varchar("repo", { length: 200 }).notNull().unique(),
    productUrl: text("product_url"),
    state: varchar("state", { length: 20 }).$type<CandidateState>().notNull().default("new"),
    reason: varchar("reason", { length: 40 }).$type<DecisionReason>(),
    /** 'auto' | 'admin' — 사람이 뒤집은 건이 얼마나 되는지가 규칙 품질의 지표다 */
    decidedBy: varchar("decided_by", { length: 10 }),
    /** 판정에 쓴 신호와 점수 — 왜 그렇게 판정했는지 되짚을 수 있어야 한다 */
    signals: jsonb("signals").$type<Record<string, unknown>>(),
    /** 발행되면 products.slug */
    publishedSlug: varchar("published_slug", { length: 80 }),
    judgedAt: timestamp("judged_at"),
    decidedAt: timestamp("decided_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("crawl_candidates_state_idx").on(t.state, t.updatedAt.desc()),
    // 발행분 재검수·본문 채우기는 products.slug 로 후보를 찾아 repo 로 원본에 잇는다 — repo 까지 담아 표를 다시 읽지 않게.
    // 발행된 것(수 %)만 담는다: 나머지는 늘 null 이라 찾을 일이 없다. 100만 행 실측에서 전부 담으면 생성(쓰기 잠금)
    // 3.4초·74MB, 발행분만 담으면 0.1초·2.5MB 였다
    index("crawl_candidates_published_slug_idx").on(t.publishedSlug, t.repo).where(sql`${t.publishedSlug} is not null`),
    // 심사 화면·갈래 집계는 상태로 거른 뒤 id 순으로 넘긴다 — 위 인덱스는 updated_at 순이라 이 정렬을 못 받는다
    index("crawl_candidates_state_id_idx").on(t.state, t.id),
  ],
);

// ─────────────────────────── 설정 ───────────────────────────

/**
 * 크롤 기준. 한 행만 존재한다 (id = 1).
 *
 * 값을 jsonb 한 컬럼에 담는 이유: 필터를 추가할 때 마이그레이션이 필요 없다.
 * 형태는 zod(lib/crawl/settings-schema.ts)가 지키므로 타입 안전성은 잃지 않는다.
 *
 * 누가 언제 바꿨는지 남긴다. "왜 갑자기 수집량이 줄었지"에 답할 수 있어야 한다.
 */
export const crawlSettings = pgTable("crawl_settings", {
  id: integer("id").primaryKey().default(1),
  values: jsonb("values").$type<Record<string, unknown>>().notNull(),
  updatedBy: varchar("updated_by", { length: 120 }),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CrawlSettingsRow = typeof crawlSettings.$inferSelect;

export type FrontierEntry = typeof crawlFrontier.$inferSelect;
export type CrawlDocument = typeof crawlDocuments.$inferSelect;
export type CrawlCandidate = typeof crawlCandidates.$inferSelect;

export const crawlReviewAttempts = pgTable("crawl_review_attempts", {
  id: serial("id").primaryKey(),
  candidateId: integer("candidate_id").notNull().references(() => crawlCandidates.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 24 }).$type<"automatic" | "admin_override" | "evidence_refresh">().notNull().default("automatic"),
  state: varchar("state", { length: 20 }).$type<"running" | "succeeded" | "failed" | "superseded">().notNull(),
  inputHash: varchar("input_hash", { length: 64 }).notNull(),
  policyHash: varchar("policy_hash", { length: 64 }).notNull(),
  sourceRevisionHash: varchar("source_revision_hash", { length: 64 }).notNull(),
  snapshot: jsonb("snapshot").$type<ReviewSnapshot>().notNull(),
  source: jsonb("source").$type<ReviewSource>().notNull(),
  promptVersion: varchar("prompt_version", { length: 40 }).notNull(),
  rulesVersion: varchar("rules_version", { length: 40 }).notNull(),
  provider: varchar("provider", { length: 80 }),
  model: varchar("model", { length: 160 }),
  attemptNumber: integer("attempt_number").notNull(),
  reusedFromAttemptId: integer("reused_from_attempt_id"),
  outcome: jsonb("outcome").$type<ReviewOutcome>(),
  errorCode: varchar("error_code", { length: 120 }),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: doublePrecision("cost_usd"),
  actor: varchar("actor", { length: 120 }),
  reason: varchar("reason", { length: 2000 }),
  leaseToken: varchar("lease_token", { length: 80 }),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  retryAfter: timestamp("retry_after"),
  validUntil: timestamp("valid_until").notNull(),
}, table => [
  uniqueIndex("crawl_review_one_active_idx").on(table.candidateId).where(sql`${table.state} = 'running'`),
  index("crawl_review_input_idx").on(table.candidateId, table.inputHash, table.sourceRevisionHash, table.startedAt.desc()),
  index("crawl_review_approval_idx").on(table.candidateId, table.policyHash, table.validUntil)
    .where(sql`${table.state} = 'succeeded' AND ${table.kind} = 'automatic'`),
]);
export type CrawlReviewAttempt = typeof crawlReviewAttempts.$inferSelect;
