import {
  pgTable,
  serial,
  text,
  varchar,
  timestamp,
  jsonb,
  customType,
  index,
} from "drizzle-orm/pg-core";

// drizzle pg-core에 내장 bytea 타입이 없어 customType으로 정의
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// 제품 상태: 미검증(상세만 노출, noindex) → 검증(공개 목록) / 차단(어드민)
export type ProductStatus = "unverified" | "verified" | "banned";

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
  verifyToken: varchar("verify_token", { length: 80 }).notNull(),
  verifyMethod: varchar("verify_method", { length: 10 }), // 'file' | 'meta'
  verifiedAt: timestamp("verified_at"),
  editTokenHash: varchar("edit_token_hash", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  // 홈 목록 쿼리(WHERE status='verified' ORDER BY verified_at DESC) 전용
  index("products_status_verified_at_idx").on(table.status, table.verifiedAt.desc()),
]);

// OG 이미지 사본 — 로컬 디스크는 재배포/다중 인스턴스에서 유실되므로 DB에 저장
export const ogImages = pgTable("og_images", {
  slug: varchar("slug", { length: 80 }).primaryKey(),
  contentType: varchar("content_type", { length: 40 }).notNull(),
  data: bytea("data").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
