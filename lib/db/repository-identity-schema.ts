import { sql } from "drizzle-orm";
import { check, pgTable, primaryKey, timestamp, varchar } from "drizzle-orm/pg-core";

/** repo_id = GitHub 숫자 저장소 id(글자로), node_id = GraphQL node id — lib/me/maker-claims.ts RepoAnchor 의 두 꼴 */
export type RepositoryAnchorKind = "repo_id" | "node_id";

/**
 * 저장소 이름(소문자 owner/repo)마다 우리가 본 id — 덧붙이기만 한다(0191). 메이커 소유 확인이 «전에 본 그 저장소» 를 여기서 읽는다.
 *
 * 앱 코드는 이 표에 쓰지 않는다. crawl_documents · product_evidence_sources · product_star_observations 의 DB 트리거가
 * 행이 생길 때·id 가 바뀔 때(옛 값과 새 값)·지워질 때 남긴다. 지우기·비우기와 last_seen_at 을 앞으로 옮기는 것 말고의 고치기는 DB 가 거절한다.
 * 보관 정리(lib/operations/db-retention.ts)도 건드리지 않는다.
 */
export const repositoryIdentityAnchors = pgTable("repository_identity_anchors", {
  repoKey: varchar("repo_key", { length: 200 }).notNull(),
  kind: varchar("kind", { length: 8 }).$type<RepositoryAnchorKind>().notNull(),
  value: varchar("value", { length: 200 }).notNull(),
  /** 이 근거를 처음 남긴 출처: crawl_document · evidence_source · star_observation */
  source: varchar("source", { length: 24 }).notNull(),
  /** 백필한 행은 그때 출처에 남아 있던 관측 시각이다 */
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  /** 근거가 다시 기록될 때만(새 행·id 바뀜·스타 관측 주기), 하루 넘게 앞설 때만 움직인다 — 같은 id 로 덮는 갱신은 건드리지 않는다 */
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "repository_identity_anchors_pkey", columns: [table.repoKey, table.kind, table.value] }),
  check("repository_identity_anchors_kind_check", sql`${table.kind} in ('repo_id', 'node_id')`),
  check("repository_identity_anchors_key_check", sql`${table.repoKey} is not distinct from nmv_repository_anchor_key(${table.repoKey})`),
  check("repository_identity_anchors_value_check", sql`${table.value} is not distinct from nmv_repository_anchor_value(${table.kind}, ${table.value})`),
  check("repository_identity_anchors_source_check", sql`${table.source} ~ '^[a-z_]{1,24}$'`),
  check("repository_identity_anchors_seen_check", sql`${table.lastSeenAt} >= ${table.firstSeenAt}`),
]);

export type RepositoryIdentityAnchor = typeof repositoryIdentityAnchors.$inferSelect;
