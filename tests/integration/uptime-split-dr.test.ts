import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { applyUptimeResults } from "@/lib/domain/products/uptime-apply";
import { claimUptimeProducts, releaseUptimeClaims, submitUptimeResults, syncUptimeClaimRows } from "@/lib/domain/products/uptime-claims";
import * as fence from "@/lib/operations/dr/epoch";
import * as repo from "@/lib/operations/dr/repository";
import type { PromotionPlan } from "@/lib/operations/dr/promotion";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { OWNERS, product, result, setSplit, takeJobLease } from "./uptime-split-fixture";

/*
 * U1b DR: 복원 DB 봉인(seal)이 uptime_claims 의 claim·제출을 모두 회수하고 그 owner 를 instance 목록에 남기는지,
 * 봉인된(fenced) DB 에서 claim·제출·되돌림·적용·동기화가 쓰기 없이 거절되는지 본다(design-uptime §8.1 15).
 * 이 파일이 만들고 지우는 임시 DB 하나만 쓴다(공유 test DB 를 봉인하면 다른 테스트가 모두 막힌다).
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const name = `nomorevibe_test_u1b_${randomBytes(6).toString("hex")}`;
const url = (() => { const value = new URL(TEST_DATABASE_URL); value.pathname = `/${name}`; return value.toString(); })();
let client: postgres.Sql | undefined, created = false;

beforeAll(async () => {
  ensureSchema();
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${name}`); created = true; } finally { await admin.end({ timeout: 5 }); }
  const migrator = postgres(url, { max: 1, onnotice: () => {} });
  try { await migrator.unsafe("set statement_timeout = 0"); await migrate(drizzle(migrator), { migrationsFolder: path.join(root, "drizzle") }); }
  finally { await migrator.end({ timeout: 5 }); }
  client = postgres(url, { max: 6, prepare: false, onnotice: () => {} });
  // lib 의 전역 db proxy 를 이 임시 DB 로 돌린다(실제 저장소 함수를 그대로 부르기 위해)
  const g = globalThis as { db?: unknown; pgClient?: unknown };
  g.pgClient = client; g.db = drizzle(client, { schema });
}, 600_000);

afterAll(async () => {
  const g = globalThis as { db?: unknown; pgClient?: unknown };
  delete g.db; delete g.pgClient;
  await client?.end({ timeout: 5 });
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { if (created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}, 120_000);

it("seal revokes every uptime claim and pending submission, lists their owners, and the fenced DB refuses claim·submit·release·apply·sync", async () => {
  await setSplit("claims");
  const [a, b, c] = [await product("dr-a", { dueMinutes: -30 }), await product("dr-b", { dueMinutes: -20 }), await product("dr-c", { dueMinutes: -10 })];
  const oracle = await claimUptimeProducts({ owner: OWNERS.oracle, limit: 2 });
  if (oracle.kind !== "claimed") throw new Error("fixture_claim");
  expect(oracle.claims.map(claim => claim.productId)).toEqual([a.id, b.id]);
  expect(await submitUptimeResults({ owner: OWNERS.oracle, results: [result(oracle.claims[0], { status: 200 })] }))
    .toMatchObject({ kind: "submitted", accepted: [a.id] });
  const m3 = await claimUptimeProducts({ owner: OWNERS.m3, limit: 5 });
  if (m3.kind !== "claimed") throw new Error("fixture_claim");
  expect(m3.claims.map(claim => claim.productId)).toEqual([c.id]);
  const lease = await takeJobLease();

  const here = await db.transaction(tx => fence.readDatabaseIdentity(tx));
  const current = await db.transaction(tx => fence.lockWriterFence(tx, "share"));
  const plan: PromotionPlan = { version: 1, promotionId: randomUUID(), lineageId: current.lineageId, fromEpoch: current.writerEpoch,
    knownActiveEpoch: current.writerEpoch, restoredDb: here, oldDbs: [{ ...here, databaseName: `${here.databaseName}_old` }], oldInstances: [],
    snapshotAt: new Date().toISOString(), operator: "u1b-dr-driver" };
  const states = async () => Array.from(await db.execute<{ product_id: number; state: string; token: string | null; result_kind: string | null;
    last_outcome: string | null }>(sql`select product_id, state, token::text, result_kind, last_outcome from uptime_claims order by product_id`));

  // dry-run 은 ROLLBACK 이다: 미리 본 값만 돌려주고 claim 은 그대로다
  const preview = await repo.sealRestoredDatabase(plan, false);
  expect(preview.sealSnapshot.revoked.uptimeClaims).toBe(3);
  expect(preview.sealSnapshot.instances).toEqual(expect.arrayContaining(["u1b-m3", "u1b-oracle"]));
  expect((await states()).map(row => row.state)).toEqual(["submitted", "claimed", "claimed"]);

  const sealed = await repo.sealRestoredDatabase(plan, true);
  expect(sealed.sealSnapshot.revoked).toMatchObject({ uptimeClaims: 3, jobs: 1 });
  expect(await states()).toEqual([a, b, c].map(target => ({ product_id: target.id, state: "idle", token: null, result_kind: null, last_outcome: "dr_sealed" })));
  expect(await db.transaction(tx => fence.writerSiteActive(tx))).toBe(false);

  // 봉인된 DB: 옛 owner 의 늦은 제출·되돌림, 새 claim, 적용, 동기화 모두 쓰기 없이 거절
  const before = await states();
  expect(await claimUptimeProducts({ owner: OWNERS.mini, limit: 5 })).toEqual({ kind: "blocked", reason: "site_fenced", controlEpoch: null });
  expect(await submitUptimeResults({ owner: OWNERS.oracle, results: [result(oracle.claims[1], { status: 200 })] }))
    .toEqual({ kind: "blocked", reason: "site_fenced", controlEpoch: null });
  expect(await releaseUptimeClaims({ owner: OWNERS.m3, claims: m3.claims })).toEqual({ kind: "blocked", reason: "site_fenced" });
  await expect(applyUptimeResults({ lease, own: [result(m3.claims[0], { status: 0 })] })).rejects.toBeInstanceOf(fence.DrWriterFencedError);
  await expect(syncUptimeClaimRows()).rejects.toBeInstanceOf(fence.DrWriterFencedError);
  expect(await states()).toEqual(before);
});
