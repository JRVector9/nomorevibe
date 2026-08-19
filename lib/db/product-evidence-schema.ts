import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export type LinkKind =
  | "repository"
  | "app_store"
  | "play_store"
  | "npm"
  | "pypi"
  | "crates"
  | "documentation"
  | "support"
  | "rss"
  | "changelog"
  | "video";
export type DeclarationSource = "maker" | "discovered";
export type SourceState = "unobserved" | "ok" | "failed" | "stale" | "disconnected";
export type EvidenceLevel =
  | "maker_reported"
  | "repository_evidenced"
  | "nomorevibe_recorded"
  | "signed_build";
export type RelationshipState =
  | "bidirectional"
  | "site_link"
  | "repository_link"
  | "maker_reported"
  | "disconnected";

export type PricingModel = "free" | "freemium" | "paid" | "open_source" | "contact" | "unknown";
export type ProductLifecycle = "prototype" | "beta" | "ga" | "maintenance" | "sunset" | "unknown";

export type MakerLicense = { value: string; spdxId?: string; url?: string };
export type ProfileTeamMember = { name: string; role: string };

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const productProfiles = pgTable("product_profiles", {
  slug: varchar("slug", { length: 80 }).primaryKey(),
  problem: varchar("problem", { length: 2_000 }),
  targetUsers: varchar("target_users", { length: 2_000 }),
  keyFeatures: jsonb("key_features").$type<string[]>().notNull().default([]),
  useCases: jsonb("use_cases").$type<string[]>().notNull().default([]),
  pricingModel: varchar("pricing_model", { length: 20 }).$type<PricingModel>().notNull(),
  pricingUrl: varchar("pricing_url", { length: 1_000 }),
  lifecycle: varchar("lifecycle", { length: 20 }).$type<ProductLifecycle>().notNull(),
  platforms: jsonb("platforms").$type<string[]>().notNull().default([]),
  privacySummary: varchar("privacy_summary", { length: 2_000 }),
  longDescriptionMarkdown: text("long_description_markdown").notNull(),
  team: jsonb("team").$type<ProfileTeamMember[]>().notNull().default([]),
  makerLicense: jsonb("maker_license").$type<MakerLicense>(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const productLinks = pgTable("product_links", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 80 }).notNull(),
  kind: varchar("kind", { length: 24 }).$type<LinkKind>().notNull(),
  declarationSource: varchar("declaration_source", { length: 20 }).$type<DeclarationSource>().notNull(),
  url: varchar("url", { length: 1_000 }).notNull(),
  normalizedKey: varchar("normalized_key", { length: 500 }).notNull(),
  verificationState: varchar("verification_state", { length: 20 }).$type<SourceState>().notNull().default("unobserved"),
  relationshipState: varchar("relationship_state", { length: 24 }).$type<RelationshipState>(),
  visible: boolean("visible").notNull().default(true),
  verifiedAt: timestamp("verified_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("product_links_slug_kind_key_idx").on(table.slug, table.kind, table.normalizedKey),
]);

export const productEvidenceSources = pgTable("product_evidence_sources", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 80 }).notNull(),
  kind: varchar("kind", { length: 24 }).$type<LinkKind>().notNull(),
  provider: varchar("provider", { length: 60 }).notNull(),
  sourceKey: varchar("source_key", { length: 500 }).notNull(),
  sourceUrl: varchar("source_url", { length: 1_000 }),
  state: varchar("state", { length: 20 }).$type<SourceState>().notNull().default("unobserved"),
  normalizedFacts: jsonb("normalized_facts").$type<Record<string, unknown>>(),
  etag: varchar("etag", { length: 500 }),
  lastModified: varchar("last_modified", { length: 200 }),
  observedAt: timestamp("observed_at"),
  lastSuccessAt: timestamp("last_success_at"),
  lastFailureAt: timestamp("last_failure_at"),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  attempts: integer("attempts").notNull().default(0),
  lastErrorCode: varchar("last_error_code", { length: 80 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("product_evidence_sources_slug_kind_key_idx").on(table.slug, table.kind, table.sourceKey),
  index("product_evidence_sources_due_idx").on(table.state, table.nextAttemptAt, table.slug),
]);

export const mediaAssets = pgTable("media_assets", {
  hash: varchar("hash", { length: 64 }).primaryKey(),
  webData: bytea("web_data").notNull(),
  thumbnailData: bytea("thumbnail_data").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  thumbnailWidth: integer("thumbnail_width").notNull(),
  thumbnailHeight: integer("thumbnail_height").notNull(),
  mimeType: varchar("mime_type", { length: 40 }).notNull(),
  webSize: integer("web_size").notNull(),
  thumbnailSize: integer("thumbnail_size").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** 메이커가 제출했고 백그라운드 수집기가 내부 자산으로 복사할 외부 이미지 URL. */
export const productMediaDeclarations = pgTable("product_media_declarations", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 80 }).notNull(),
  sourceUrl: varchar("source_url", { length: 1_000 }).notNull(),
  altText: varchar("alt_text", { length: 500 }).notNull(),
  position: integer("position").notNull().default(0),
  revision: integer("revision").notNull().default(1),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("product_media_declarations_slug_source_idx").on(table.slug, table.sourceUrl),
  index("product_media_declarations_due_idx").on(table.nextAttemptAt, table.slug),
]);

export const productMedia = pgTable("product_media", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 80 }).notNull(),
  sourceUrl: varchar("source_url", { length: 1_000 }).notNull(),
  assetHash: varchar("asset_hash", { length: 64 }).notNull().references(() => mediaAssets.hash),
  position: integer("position").notNull().default(0),
  altText: varchar("alt_text", { length: 500 }),
  current: boolean("current").notNull().default(true),
  visible: boolean("visible").notNull().default(true),
  version: integer("version").notNull().default(1),
  firstObservedAt: timestamp("first_observed_at").notNull().defaultNow(),
  lastObservedAt: timestamp("last_observed_at").notNull().defaultNow(),
  lastSuccessAt: timestamp("last_success_at").notNull().defaultNow(),
  missingAt: timestamp("missing_at"),
  supersededAt: timestamp("superseded_at"),
}, (table) => [
  uniqueIndex("product_media_slug_source_asset_idx").on(table.slug, table.sourceUrl, table.assetHash),
  uniqueIndex("product_media_one_current_source_idx")
    .on(table.slug, table.sourceUrl)
    .where(sql`${table.current} = true`),
  index("product_media_asset_idx").on(table.assetHash),
]);

export type ProductUpdateSourceKind =
  | "maker"
  | "github_release"
  | "feed"
  | "site_change"
  | "repository_change"
  | "activity_digest";

export const productUpdates = pgTable("product_updates", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 80 }).notNull(),
  sourceKind: varchar("source_kind", { length: 32 }).$type<ProductUpdateSourceKind>().notNull(),
  dedupeKey: varchar("dedupe_key", { length: 500 }).notNull(),
  canonicalUrl: varchar("canonical_url", { length: 1_000 }),
  title: varchar("title", { length: 500 }).notNull(),
  summary: text("summary"),
  beforeAfter: jsonb("before_after").$type<Record<string, unknown>>(),
  publishedAt: timestamp("published_at"),
  observedAt: timestamp("observed_at").notNull(),
  visible: boolean("visible").notNull().default(true),
  makerEditedAt: timestamp("maker_edited_at"),
  makerEditedBy: varchar("maker_edited_by", { length: 120 }),
  makerDeletedAt: timestamp("maker_deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("product_updates_slug_dedupe_idx").on(table.slug, table.dedupeKey),
  index("product_updates_visible_order_idx").on(
    table.slug,
    table.visible,
    sql`coalesce(${table.publishedAt}, ${table.observedAt}) desc`,
  ),
]);

export const productAgents = pgTable("product_agents", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 80 }).notNull(),
  provider: varchar("provider", { length: 120 }).notNull(),
  client: varchar("client", { length: 120 }),
  model: varchar("model", { length: 160 }),
  roles: jsonb("roles").$type<string[]>().notNull().default([]),
  commitFrom: varchar("commit_from", { length: 64 }),
  commitTo: varchar("commit_to", { length: 64 }),
  dateFrom: date("date_from"),
  dateTo: date("date_to"),
  sourceUrl: varchar("source_url", { length: 1_000 }),
  evidenceLevel: varchar("evidence_level", { length: 32 }).$type<EvidenceLevel>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const productSkills = pgTable("product_skills", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 80 }).notNull(),
  namespace: varchar("namespace", { length: 120 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  version: varchar("version", { length: 80 }),
  source: varchar("source", { length: 1_000 }),
  hash: varchar("hash", { length: 64 }),
  commit: varchar("commit", { length: 64 }),
  evidenceLevel: varchar("evidence_level", { length: 32 }).$type<EvidenceLevel>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("product_skills_identity_idx").on(
    table.slug,
    table.namespace,
    table.name,
    sql`coalesce(${table.version}, '')`,
    sql`coalesce(${table.commit}, '')`,
  ),
]);

export const productEvidenceAudit = pgTable("product_evidence_audit", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 80 }),
  actor: varchar("actor", { length: 120 }).notNull(),
  action: varchar("action", { length: 80 }).notNull(),
  reason: varchar("reason", { length: 500 }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [index("product_evidence_audit_slug_time_idx").on(table.slug, table.createdAt.desc())]);

export const evidenceSettings = pgTable("evidence_settings", {
  id: integer("id").primaryKey().default(1),
  values: jsonb("values").$type<Record<string, unknown>>().notNull(),
  updatedBy: varchar("updated_by", { length: 120 }),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const productHealthDaily = pgTable("product_health_daily", {
  slug: varchar("slug", { length: 80 }).notNull(),
  day: date("day").notNull(),
  checks: integer("checks").notNull().default(0),
  successes: integer("successes").notNull().default(0),
  latencyTotalMs: bigint("latency_total_ms", { mode: "number" }).notNull().default(0),
  latencySamples: integer("latency_samples").notNull().default(0),
}, (table) => [primaryKey({ columns: [table.slug, table.day] })]);

export type ProductProfile = typeof productProfiles.$inferSelect;
export type ProductLink = typeof productLinks.$inferSelect;
export type ProductEvidenceSource = typeof productEvidenceSources.$inferSelect;
export type MediaAsset = typeof mediaAssets.$inferSelect;
export type ProductMediaDeclaration = typeof productMediaDeclarations.$inferSelect;
export type ProductMedia = typeof productMedia.$inferSelect;
export type ProductUpdate = typeof productUpdates.$inferSelect;
export type ProductAgent = typeof productAgents.$inferSelect;
export type ProductSkill = typeof productSkills.$inferSelect;
