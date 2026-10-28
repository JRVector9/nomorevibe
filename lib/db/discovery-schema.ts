import { index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/** A page identity is independent of the device claiming it. Results survive owner loss. */
export const githubDiscoveryPages = pgTable('github_discovery_pages', {
  key: varchar('key', { length: 64 }).primaryKey(),
  kind: varchar('kind', { length: 20 }).notNull(),
  query: text('query').notNull(),
  sort: varchar('sort', { length: 20 }).notNull(),
  page: integer('page').notNull(),
  scope: varchar('scope', { length: 120 }).notNull(),
  generation: varchar('generation', { length: 120 }).notNull(),
  state: varchar('state', { length: 20 }).notNull(),
  owner: uuid('owner').notNull(),
  ownerName: varchar('owner_name', { length: 120 }).notNull(),
  leaseUntil: timestamp('lease_until').notNull(),
  result: jsonb('result').$type<unknown>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
}, table => [index('github_discovery_pages_state_idx').on(table.state, table.leaseUntil),
  index('github_discovery_pages_completed_idx').on(table.completedAt),
  index('github_discovery_pages_retention_idx').on(table.updatedAt)]);
