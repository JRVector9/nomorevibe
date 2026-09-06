import { bigint, boolean, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import type { AgentObservation } from '@/lib/domain/evidence/agents/types';
import type { CollectCursor } from '@/lib/domain/evidence/agents/collect';
export const agentRepositoryScans = pgTable('agent_repository_scans', {
  id: serial('id').primaryKey(), githubRepositoryId: bigint('github_repository_id', { mode: 'bigint' }).notNull(),
  repositoryKey: varchar('repository_key', { length: 200 }).notNull(), commitSha: varchar('commit_sha', { length: 64 }).notNull(),
  detectorVersion: varchar('detector_version', { length: 40 }).notNull(), scope: text('scope').notNull().default(''), scopeHash: varchar('scope_hash', { length: 64 }).notNull(),
  state: varchar('state', { length: 16 }).$type<'pending' | 'complete' | 'partial' | 'failed'>().notNull(),
  cursor: jsonb('cursor').$type<CollectCursor>(), requestCount: integer('request_count').notNull().default(0), fileCount: integer('file_count').notNull().default(0),
  coverage: jsonb('coverage').$type<{ limited: boolean }>().notNull().default({ limited: false }),
  startedAt: timestamp('started_at').notNull().defaultNow(), completedAt: timestamp('completed_at'),
  lastErrorCode: varchar('last_error_code', { length: 60 }), nextAttemptAt: timestamp('next_attempt_at').notNull().defaultNow(),
}, table => [uniqueIndex('agent_scans_identity_idx').on(table.githubRepositoryId, table.commitSha, table.detectorVersion, table.scopeHash), index('agent_scans_due_idx').on(table.state, table.nextAttemptAt), index('agent_scans_repository_idx').on(table.repositoryKey)]);
export const agentRepositoryObservations = pgTable('agent_repository_observations', {
  id: serial('id').primaryKey(), scanId: integer('scan_id').notNull().references(() => agentRepositoryScans.id, { onDelete: 'cascade' }),
  observationKey: varchar('observation_key', { length: 64 }).notNull(), facts: jsonb('facts').$type<AgentObservation>().notNull(), observedAt: timestamp('observed_at').notNull().defaultNow(),
}, table => [uniqueIndex('agent_observations_scan_key_idx').on(table.scanId, table.observationKey)]);
export const crawlDiscoveryEvidence = pgTable('crawl_discovery_evidence', {
  id: serial('id').primaryKey(), repositoryKey: varchar('repository_key', { length: 200 }).notNull(), signalId: varchar('signal_id', { length: 80 }).notNull(),
  evidenceKey: varchar('evidence_key', { length: 64 }).notNull(), sourceUrl: text('source_url').notNull(), commitSha: varchar('commit_sha', { length: 64 }),
  attribution: jsonb('attribution').$type<{ client: string | null; label: string }>(), searchWindowFrom: timestamp('search_window_from'), searchWindowTo: timestamp('search_window_to'),
  incomplete: boolean('incomplete').notNull().default(false), observedAt: timestamp('observed_at').notNull().defaultNow(),
}, table => [uniqueIndex('crawl_discovery_repository_key_idx').on(table.repositoryKey, table.evidenceKey)]);
export type AgentRepositoryScan = typeof agentRepositoryScans.$inferSelect;
