import { sql } from 'drizzle-orm';
import { pgTable, varchar, jsonb, timestamp, serial, integer, text, bigint, boolean, index } from 'drizzle-orm/pg-core';

/**
 * Cloudflare 에서 지울 제품 — 공개 제품이 내려가거나 지워지면 DB 트리거가 같은 트랜잭션에서 적는다(0057).
 * 내리는 길(관리자 차단·내려달라는 요청·감사·재검토)마다 코드를 넣지 않아도 빠지지 않는다.
 * 발행 워커가 태그로 지우고(purgedAt), 원 서버가 옛 내용을 다시 채웠을 때를 위해 60초 뒤 한 번 더 지운다(confirmedAt).
 */
export const cdnPurges = pgTable('cdn_purges', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 80 }).notNull(),
  /** 바뀐 상태 또는 'deleted' */
  reason: varchar('reason', { length: 20 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  purgedAt: timestamp('purged_at'),
  confirmedAt: timestamp('confirmed_at'),
  attempts: integer('attempts').notNull().default(0),
  lastError: varchar('last_error', { length: 300 }),
}, (table) => [index('cdn_purges_pending_idx').on(table.id).where(sql`confirmed_at is null`)]);

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
/**
 * 관리자 작업 로그. 덧붙이기만 한다 — 고치기·지우기·비우기는 DB 트리거가 거부한다(0056).
 * 스크립트가 남긴 옛 행은 actor_kind·ip 가 비어 있다.
 */
export const operationsAudit = pgTable('operations_audit', {
  id: serial('id').primaryKey(), actor: varchar('actor', { length: 120 }).notNull(),
  action: varchar('action', { length: 80 }).notNull(), target: varchar('target', { length: 200 }).notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  /** 'github' | 'local' | 'token' */
  actorKind: varchar('actor_kind', { length: 12 }),
  ip: varchar('ip', { length: 64 }),
  userAgent: varchar('user_agent', { length: 300 }),
  ok: boolean('ok').notNull().default(true),
  error: varchar('error', { length: 300 }),
}, (table) => [index('operations_audit_action_created_idx').on(table.action, table.createdAt.desc())]);

/** Collector PATs are encrypted with a dedicated secret shared by web and crawler instances. */
export const githubCollectorAccounts = pgTable('github_collector_accounts', {
  userId: bigint('user_id', { mode: 'number' }).primaryKey(),
  login: varchar('login', { length: 100 }).notNull(),
  encryptedToken: text('encrypted_token').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  coreQuota: jsonb('core_quota').$type<{ limit: number; used: number; remaining: number; reset: number }>(),
  quotaObservedAt: timestamp('quota_observed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
/**
 * GitHub App 수집 자격(0064) — 설치(installation)마다 따로 한도가 있어, 같은 계정의 개인 토큰과 달리 한도가 더해진다.
 * 개인 키는 수집 비밀키(GITHUB_COLLECTOR_SECRET)로 암호화해 두고, 워커가 한 시간짜리 설치 토큰을 만들어 쓴다(github-apps.ts).
 */
export const githubCollectorApps = pgTable('github_collector_apps', {
  installationId: bigint('installation_id', { mode: 'number' }).primaryKey(),
  appId: bigint('app_id', { mode: 'number' }).notNull(),
  appSlug: varchar('app_slug', { length: 100 }).notNull(),
  accountLogin: varchar('account_login', { length: 100 }).notNull(),
  encryptedPrivateKey: text('encrypted_private_key').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  coreQuota: jsonb('core_quota').$type<{ limit: number; used: number; remaining: number; reset: number }>(),
  quotaObservedAt: timestamp('quota_observed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
