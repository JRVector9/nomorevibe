import { pgTable, varchar, jsonb, timestamp, serial, integer, text } from 'drizzle-orm/pg-core';

export const operationsObservations = pgTable('operations_observations', {
  key: varchar('key', { length: 80 }).primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  observedAt: timestamp('observed_at').notNull().defaultNow(),
});
export const categoryDecisions = pgTable('category_decisions', {
  repo: varchar('repo', { length: 200 }).primaryKey(),
  sourceHash: varchar('source_hash', { length: 64 }).notNull(),
  category: varchar('category', { length: 40 }),
  reason: text('reason').notNull(),
  actor: varchar('actor', { length: 120 }).notNull(),
  revision: integer('revision').notNull().default(1),
  retryAt: timestamp('retry_at').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
export const operationsAudit = pgTable('operations_audit', {
  id: serial('id').primaryKey(), actor: varchar('actor', { length: 120 }).notNull(),
  action: varchar('action', { length: 80 }).notNull(), target: varchar('target', { length: 200 }).notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
