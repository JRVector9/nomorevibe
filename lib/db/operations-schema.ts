import { pgTable, varchar, jsonb, timestamp, serial, integer, text, bigint } from 'drizzle-orm/pg-core';

/** One active process per job role. Database time is the authority for expiry. */
export const roleLeases = pgTable('role_leases', {
  role: varchar('role', { length: 30 }).primaryKey(),
  ownerInstanceId: varchar('owner_instance_id', { length: 120 }),
  ownerBootId: varchar('owner_boot_id', { length: 36 }),
  ownerKind: varchar('owner_kind', { length: 10 }),
  ownerRelease: varchar('owner_release', { length: 120 }),
  epoch: bigint('epoch', { mode: 'number' }).notNull().default(0),
  primaryBoots: jsonb('primary_boots').$type<{ id: string; at: number }[]>().notNull().default([]),
  quarantineUntil: timestamp('quarantine_until'),
  leaseUntil: timestamp('lease_until').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

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
