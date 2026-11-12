import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { requestModelSlot } from "@/lib/llm/capacity-repository";
import { readModelCapacityDevice, saveModelCapacityDevice } from "@/lib/llm/capacity-devices-repository";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 1차 「동시에」 칸 수(2026-11-12 「1,2차도 새 동작」)를 실제 장부로 센다 — 그 모델의 살아 있는 1차 장부 행(예약·대기·보냄)이 칸 수에 닿으면 그 구성원을 고르지 않고
 * 예비가 받는다. 고르기·순위 상태는 고정하고(장비 힌트는 capacity-model-limits 가 본다), 세는 SQL 만 실제 DB 로 본다. 자기 DB 를 만들어 끝까지 migrate 한다.
 */
const mocks = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("@/lib/crawl/first-reviewers", async load => ({ ...await load<typeof import("@/lib/crawl/first-reviewers")>(), firstReviewRankState: () => mocks.state }));
vi.mock("@/lib/crawl/review-task-ranks", async load => ({ ...await load<typeof import("@/lib/crawl/review-task-ranks")>(),
  ensureReviewTaskRanks: async () => {},
  chooseReviewWorkloadMember: async (resolution: { candidates: { binding: { provider: string; identity: string } }[] }, blocked: ReadonlySet<string>) => {
    const free = resolution.candidates.find(candidate => !blocked.has(JSON.stringify([candidate.binding.provider, candidate.binding.identity])));
    return free ? { provider: free.binding.provider, model: free.binding.identity, poolSelection: {} } : null;
  } }));
import { chooseFirstReviewForCandidate } from "@/lib/crawl/agent-review-repository";

const name = `nomorevibe_test_first_pool_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {} });
let created = false;
const MEMBER = "qwen-27b", RESERVE = "sonnet-reserve";
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { account: 1 }, poolLimits: { reviewer: 1, text: 1 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "crawl-agent-review", provider: "abcllm", model: MEMBER, providerBudgetId: "account", groupId: "dev" }] };
const owner = { instanceId: `first-pool-${randomUUID()}`, bootId: randomUUID() };

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.join(path.resolve("."), "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
  await client`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(policy)}::jsonb, policy_hash = ${modelCapacityPolicyHash(policy)},
    revision = revision + 1, cursor = 0, updated_at = clock_timestamp() WHERE id = 1`;
  const current = await readModelCapacityDevice("dev");
  await db.transaction(tx => saveModelCapacityDevice(tx, { deviceId: "dev", limitSlots: 4, secondaryCap: 4, idleMs: 0, reserveSlots: 0, roles: [],
    physicalLimit: null, note: null }, current?.version ?? null, "first-pool-test"));
  const reviewer = (model: string) => ({ provider: "abcllm" as const, model });
  mocks.state = { pool: [reviewer(MEMBER), reviewer(RESERVE)], unusable: new Map(), degraded: null, reserve: [reviewer(RESERVE)],
    resolution: { task: "first-review", slot: 1, routeId: "crawl-agent-review", status: "ok",
      candidates: [{ rank: { rank: 1 }, unusable: null, detail: null, poolMember: { memberId: "m", position: 1, maxSlots: 2 }, binding: { provider: "abcllm", identity: MEMBER } }],
      execution: { task: "first-review", slot: 1, mode: "workload_pool", revision: 2, updatedAt: null, reserveRanks: true, members: [{ memberId: "m", position: 1, maxSlots: 2 }] } } };
}, 180_000);
afterAll(async () => {
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 }); if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end({ timeout: 3 });
});

it("counts the member's live AI1 ledger rows across owners against its slot cap; at the cap the reserve takes the candidate", async () => {
  const context = { candidate: { id: 7 }, input: { inputHash: "h" }, settings: {} } as never;
  const take = () => requestModelSlot({ requestId: randomUUID(), workKey: randomUUID(), owner, class: "first", pool: "reviewer",
    routeId: "crawl-agent-review", provider: "abcllm", model: MEMBER });
  expect(await chooseFirstReviewForCandidate(context)).toEqual({ provider: "abcllm", model: MEMBER });
  expect((await take()).kind).toBe("granted");
  expect(await chooseFirstReviewForCandidate(context)).toEqual({ provider: "abcllm", model: MEMBER });     // 1/2
  expect((await take()).kind).toBe("granted");
  expect(await chooseFirstReviewForCandidate(context)).toEqual({ provider: "abcllm", model: RESERVE });    // 2/2 — the reserve takes it
  // a withdrawn (no longer live) row frees the member's slot
  await client`UPDATE model_capacity_requests SET state = 'withdrawn' WHERE request_id = (SELECT request_id FROM model_capacity_requests
    WHERE owner_instance_id = ${owner.instanceId} AND state = 'reserved' ORDER BY queue_ordinal LIMIT 1)`;
  expect(await chooseFirstReviewForCandidate(context)).toEqual({ provider: "abcllm", model: MEMBER });
});
