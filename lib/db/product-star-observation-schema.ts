import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import type { StarObservationPolicy } from '@/lib/domain/products/star-observation-policy';

export type StarObservationRunStatus = 'preparing' | 'collecting' | 'closed' | 'failed';
export type StarObservationStatus = 'pending' | 'ok' | 'not_found' | 'empty' | 'blocked' | 'failed';

export const productStarObservationRuns = pgTable('product_star_observation_runs', {
  id: serial('id').primaryKey(),
  cycleAt: timestamp('cycle_at', { withTimezone: true }).notNull(),
  windowStartsAt: timestamp('window_starts_at', { withTimezone: true }).notNull(),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
  status: varchar('status', { length: 16 }).$type<StarObservationRunStatus>().notNull().default('preparing'),
  policyVersion: varchar('policy_version', { length: 40 }).notNull(),
  policy: jsonb('policy').$type<StarObservationPolicy>().notNull(),
  targetCount: integer('target_count').notNull().default(0),
  successCount: integer('success_count').notNull().default(0),
  failureCount: integer('failure_count').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, table => [
  uniqueIndex('product_star_observation_runs_cycle_idx').on(table.cycleAt),
  check('product_star_observation_runs_status_check', sql`${table.status} in ('preparing','collecting','closed','failed')`),
  check('product_star_observation_runs_window_check', sql`${table.windowStartsAt} < ${table.deadlineAt} and ${table.deadlineAt} = ${table.cycleAt}`),
  check('product_star_observation_runs_counts_check', sql`${table.targetCount} >= 0 and ${table.successCount} >= 0 and ${table.failureCount} >= 0 and ${table.successCount} + ${table.failureCount} <= ${table.targetCount}`),
]);

/** Product IDs identify a generation. No product FK: deletion must not alter closed evidence. */
export const productStarObservations = pgTable('product_star_observations', {
  runId: integer('run_id').notNull().references(() => productStarObservationRuns.id, { onDelete: 'cascade' }),
  productId: integer('product_id').notNull(),
  slug: varchar('slug', { length: 80 }).notNull(),
  repoUrl: text('repo_url').notNull(),
  repositoryKey: varchar('repository_key', { length: 200 }).notNull(),
  /** GitHub node ID also detects a deleted/recreated repository at the same path. */
  repositoryId: varchar('repository_id', { length: 200 }),
  repoLinkVersion: integer('repo_link_version').notNull(),
  status: varchar('status', { length: 16 }).$type<StarObservationStatus>().notNull().default('pending'),
  stars: integer('stars'),
  observedAt: timestamp('observed_at', { withTimezone: true }),
  archived: boolean('archived'),
  errorClass: varchar('error_class', { length: 64 }),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
}, table => [
  primaryKey({ columns: [table.runId, table.productId] }),
  index('product_star_observations_product_idx').on(table.productId, table.runId),
  index('product_star_observations_pending_idx').on(table.runId, table.nextAttemptAt, table.productId).where(sql`${table.status} = 'pending'`),
  check('product_star_observations_status_check', sql`${table.status} in ('pending','ok','not_found','empty','blocked','failed')`),
  check('product_star_observations_value_check', sql`(${table.stars} is null or ${table.stars} >= 0) and ${table.attempts} between 0 and 3 and ${table.repoLinkVersion} >= 1 and (${table.status} <> 'ok' or (${table.stars} is not null and ${table.observedAt} is not null and ${table.archived} is not null and ${table.repositoryId} is not null and char_length(btrim(${table.repositoryId})) > 0))`),
]);

export type ProductStarObservationRun = typeof productStarObservationRuns.$inferSelect;
export type ProductStarObservation = typeof productStarObservations.$inferSelect;
