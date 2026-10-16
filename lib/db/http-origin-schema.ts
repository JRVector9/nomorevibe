import { sql } from 'drizzle-orm';
import { pgTable, integer, text, bigint, jsonb, timestamp, uuid, varchar, bigserial } from 'drizzle-orm/pg-core';

export const httpOriginControl = pgTable('http_origin_control', {
  id: integer('id').primaryKey().default(1), mode: text('mode').notNull().default('disabled'),
  epoch: bigint('epoch', { mode: 'number' }).notNull().default(1), revision: bigint('revision', { mode: 'number' }).notNull().default(1),
  policy: jsonb('policy'), policyHash: text('policy_hash'), updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
});
export const httpOriginHops = pgTable('http_origin_hops', {
  id: uuid('id').primaryKey(), token: uuid('token').notNull().unique(), instanceId: varchar('instance_id', { length: 120 }).notNull(),
  bootId: uuid('boot_id').notNull(), hostId: varchar('host_id', { length: 120 }).notNull(), origin: text('origin').notNull(),
  epoch: bigint('epoch', { mode: 'number' }).notNull(), revision: bigint('revision', { mode: 'number' }).notNull(), policyHash: text('policy_hash').notNull(), state: text('state').notNull(),
  reservedUntil: timestamp('reserved_until', { withTimezone: true, precision: 3 }).notNull(), dispatchedAt: timestamp('dispatched_at', { withTimezone: true, precision: 3 }),
  settledAt: timestamp('settled_at', { withTimezone: true, precision: 3 }),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
});
export const httpOriginEvents = pgTable('http_origin_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(), hopId: uuid('hop_id').notNull().references(() => httpOriginHops.id), kind: text('kind').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().default(sql`clock_timestamp()`),
});
