import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  varchar,
  timestamp,
  jsonb,
  customType,
  index,
  integer,
} from "drizzle-orm/pg-core";

// drizzle pg-core에 내장 bytea 타입이 없어 customType으로 정의
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * 제품 상태.
 *
 * - unverified: 메이커가 등록했고 검증 진행 중. 주인이 있는 일시적 상태.
 *               상세만 보이고 목록에는 안 뜬다.
 * - seeded:     우리가 공개 데이터를 보고 대신 올림. 주인이 아직 없다.
 *               스스로 검증될 수 없으므로 지속될 수 있는 상태다.
 *               목록에는 뜨되 미클레임 배지가 붙고 랭킹에서는 빠진다.
 * - verified:   도메인 소유권을 우리가 직접 확인함.
 * - banned:     어드민 차단. 행은 남겨 같은 URL의 재등록까지 막는다.
 */
export type ProductStatus = "unverified" | "seeded" | "verified" | "banned";

/** 어떤 경로로 들어왔는지 — 클레임 후에도 남는다 */
export type ProductSource = "skill" | "crawler";

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 80 }).notNull().unique(),
  // 정규화된 URL (https 강제, www/후행슬래시 제거)
  url: text("url").notNull().unique(),
  name: varchar("name", { length: 120 }).notNull(),
  tagline: varchar("tagline", { length: 200 }).notNull(),
  description: text("description").notNull(),
  category: varchar("category", { length: 40 }).notNull(),
  // 메이커 신고값 — 랭킹에 반영하지 않음
  builder: varchar("builder", { length: 60 }),
  stack: jsonb("stack").$type<string[]>().notNull().default([]),
  ogImage: text("og_image"),
  makerName: varchar("maker_name", { length: 120 }),
  repoUrl: text("repo_url"),
  status: varchar("status", { length: 20 })
    .$type<ProductStatus>()
    .notNull()
    .default("unverified"),
  source: varchar("source", { length: 20 })
    .$type<ProductSource>()
    .notNull()
    .default("skill"),
  // 우리가 대신 올린 제품을 메이커가 가져간 시각. null이면 아직 주인이 없다.
  claimedAt: timestamp("claimed_at"),
  verifyToken: varchar("verify_token", { length: 80 }).notNull(),
  verifyMethod: varchar("verify_method", { length: 10 }), // 'file' | 'meta'
  verifiedAt: timestamp("verified_at"),
  editTokenHash: varchar("edit_token_hash", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  /**
   * 홈 목록 정렬용.
   *
   * seeded는 verified_at이 null이라 그것만으로 정렬하면 (Postgres에서 DESC의 NULL이
   * 앞에 오므로) 미클레임 제품이 목록 맨 위를 차지한다. 등재 시각으로 정렬해야 한다.
   */
  index("products_status_listed_at_idx").on(
    table.status,
    sql`coalesce(${table.verifiedAt}, ${table.createdAt}) desc`,
  ),
]);

// OG 이미지 사본 — 로컬 디스크는 재배포/다중 인스턴스에서 유실되므로 DB에 저장
export const ogImages = pgTable("og_images", {
  slug: varchar("slug", { length: 80 }).primaryKey(),
  contentType: varchar("content_type", { length: 40 }).notNull(),
  data: bytea("data").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * 백그라운드 작업 상태.
 *
 * 큐 서버를 두지 않는다. 이 규모에서는 작업당 행 하나로 충분하고,
 * 커서만 남아 있으면 어디서 끊겼든 다음 틱이 이어받는다.
 */
export const jobs = pgTable("jobs", {
  name: varchar("name", { length: 60 }).primaryKey(),
  // 작업이 스스로 정의하는 재개 지점 (수집기: 검색 페이지, 롤업: 처리 완료 시각 등)
  cursor: jsonb("cursor"),
  // 동시 실행 방지. 프로세스가 죽어 잠금이 남으면 lockedAt 기준으로 회수한다
  lockedAt: timestamp("locked_at"),
  lastRunAt: timestamp("last_run_at"),
  lastSuccessAt: timestamp("last_success_at"),
  lastError: text("last_error"),
  runs: integer("runs").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Job = typeof jobs.$inferSelect;

/**
 * 제품 생존 상태.
 *
 * 등재된 제품이 언젠가는 죽는다. 죽은 링크가 목록에 남아 있으면 "직접 확인한 것만
 * 보여준다"는 말이 무의미해진다.
 *
 * 여기서는 재기만 한다. 몇 번 실패했다고 자동으로 감추지 않는다 — 배포가 잠깐 흔들린 것과
 * 서비스가 끝난 것을 응답 코드만으로 가를 수 없고, 목록에서 내리는 것은 되돌리기 어려운
 * 판단이다. 어드민이 보고 차단한다.
 *
 * products와 나눠 둔 이유: 제품 기록은 사람이 쓴 것이고 이쪽은 기계가 매번 덮어쓰는 값이다.
 */
export const productHealth = pgTable("product_health", {
  slug: varchar("slug", { length: 80 }).primaryKey(),
  checkedAt: timestamp("checked_at").notNull().defaultNow(),
  /** 마지막 응답 코드. 0이면 연결 자체가 안 됐다 */
  status: integer("status").notNull(),
  /** 연속 실패 횟수. 한 번 성공하면 0으로 돌아간다 */
  failures: integer("failures").notNull().default(0),
  /** 죽기 시작한 시각. 살아 있으면 null */
  downSince: timestamp("down_since"),
});

export type ProductHealth = typeof productHealth.$inferSelect;

/**
 * 내려달라는 요청.
 *
 * 우리가 대신 올린 제품은 주인이 부탁한 적이 없으므로, 내려달라는 말에 답할 창구가 있어야
 * 한다. 상세 페이지가 그렇게 약속하고 있다.
 *
 * 요청 자체에는 소유 증명을 요구하지 않는다. 증명을 받으려면 우리 토큰을 그 사이트에
 * 올리라고 해야 하는데, 내려달라는 사람에게 먼저 뭔가를 붙이라고 할 수는 없다.
 * 대신 처리는 사람이 한다.
 */
export const takedownRequests = pgTable("takedown_requests", {
  slug: varchar("slug", { length: 80 }).primaryKey(),
  /** 요청자가 남긴 사유. 없을 수 있다 */
  reason: text("reason"),
  requestedAt: timestamp("requested_at").notNull().defaultNow(),
  /** 처리 시각. null이면 아직 사람이 안 봤다 */
  handledAt: timestamp("handled_at"),
  handledBy: varchar("handled_by", { length: 120 }),
  /** 'removed' | 'dismissed' */
  outcome: varchar("outcome", { length: 20 }),
});

export type TakedownRequest = typeof takedownRequests.$inferSelect;

/**
 * rate limit 버킷.
 *
 * 인메모리로 두면 인스턴스마다 한도가 따로 생겨, 2대로 늘리는 순간 실제 한도가 2배가 된다.
 * Redis를 들이는 대신 이미 있는 DB를 쓴다 — 한도를 거는 세 경로(등록·검증·수정)는 어차피
 * 그 요청 안에서 DB를 타므로 왕복이 늘지 않는다.
 *
 * 키는 "행위:클라이언트" 형태다. 행 하나를 갱신할 뿐이므로 요청마다 늘지 않는다.
 */
export const rateLimits = pgTable("rate_limits", {
  key: varchar("key", { length: 200 }).primaryKey(),
  count: integer("count").notNull().default(0),
  /** 이 시각이 지나면 창이 새로 열린다 */
  resetAt: timestamp("reset_at").notNull(),
});

// 크롤 파이프라인 테이블 — 수집 데이터는 제품 데이터와 섞이지 않도록 파일을 나눈다
export * from "./crawl-schema";

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
