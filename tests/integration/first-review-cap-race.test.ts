import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { requestAi1ModelSlot, requestModelSlot, type ModelSlotMemberCap } from "@/lib/llm/capacity-repository";
import { readModelCapacityDevice, saveModelCapacityDevice } from "@/lib/llm/capacity-devices-repository";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 2026-11-12 검수 F2(gpt-6.1-sol 재현): 1차 「동시에」 구성원 칸 수(max_slots)를 claim 의 잠금 아래 재확인이 세지 않았고, 두 claim 이 함께 세면 둘 다 지나갈 수
 * 있었다. 실제 장부로 본다 —
 *  1) 재확인(executor = tx)도 다른 후보의 살아 있는 장부 행을 세어 칸이 찬 구성원 대신 예비를 고른다.
 *  2) 예약을 만드는 장부 TX(requestAi1ModelSlot memberCap, control FOR UPDATE 아래)가 칸 수를 원자적으로 지킨다 — 동시에 두 후보가 와도 하나만 줄에 서고,
 *     이미 줄에 선 자기 요청을 다시 묻는 것은 세지 않는다.
 * 고르기·순위 상태는 고정한다(장비 힌트는 capacity-model-limits 가 본다). 자기 DB 를 만들어 끝까지 migrate 한다.
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
import { firstReviewMemberSlotCap } from "@/lib/crawl/first-review-member-cap";

const name = `nomorevibe_test_first_cap_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 6, prepare: false, onnotice: () => {} });
let created = false;
const MEMBER = "qwen-27b", RESERVE = "sonnet-reserve";
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { account: 1 }, poolLimits: { reviewer: 1, text: 1 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "crawl-agent-review", provider: "abcllm", model: MEMBER, providerBudgetId: "account", groupId: "dev" }] };
const owner = { instanceId: `first-cap-${randomUUID()}`, bootId: randomUUID() };
const ai1 = (candidateId: number, requestId = randomUUID()) => ({ requestId, workKey: `ai1:${candidateId}:${randomUUID()}`, owner, class: "first" as const,
  pool: "reviewer" as const, routeId: "crawl-agent-review", provider: "abcllm" as const, model: MEMBER });
const live = () => client`SELECT logical_work_key, state FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched') ORDER BY queue_ordinal`;

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.join(path.resolve("."), "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
  await client`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(policy)}::jsonb, policy_hash = ${modelCapacityPolicyHash(policy)},
    revision = revision + 1, cursor = 0, updated_at = clock_timestamp() WHERE id = 1`;
  // 장비·모델 한도는 넉넉하다(4) — 구성원 칸 수 1 만이 막는다
  const current = await readModelCapacityDevice("dev");
  await db.transaction(tx => saveModelCapacityDevice(tx, { deviceId: "dev", limitSlots: 4, secondaryCap: 4, idleMs: 0, reserveSlots: 0, roles: [],
    physicalLimit: null, note: null }, current?.version ?? null, "first-cap-test"));
  const reviewer = (model: string) => ({ provider: "abcllm" as const, model });
  mocks.state = { pool: [reviewer(MEMBER), reviewer(RESERVE)], unusable: new Map(), degraded: null, reserve: [reviewer(RESERVE)],
    resolution: { task: "first-review", slot: 1, routeId: "crawl-agent-review", status: "ok",
      candidates: [{ rank: { rank: 1 }, unusable: null, detail: null, poolMember: { memberId: "m", position: 1, maxSlots: 1 }, binding: { provider: "abcllm", identity: MEMBER } }],
      execution: { task: "first-review", slot: 1, mode: "workload_pool", revision: 2, updatedAt: null, reserveRanks: true, members: [{ memberId: "m", position: 1, maxSlots: 1 }] } } };
}, 180_000);
beforeEach(async () => {
  await client`UPDATE model_capacity_requests SET state = 'withdrawn', updated_at = clock_timestamp() WHERE state IN ('waiting','reserved')`;
});
afterAll(async () => {
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 }); if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end({ timeout: 3 });
});

it("the transaction recheck honours max_slots=1 and chooses the reserve after another candidate's live member row", async () => {
  const context = { candidate: { id: 7 }, input: { inputHash: "h" }, settings: {} } as never;
  expect(await chooseFirstReviewForCandidate(context)).toEqual({ provider: "abcllm", model: MEMBER });
  const first = await requestModelSlot({ requestId: randomUUID(), workKey: randomUUID(), owner, class: "first", pool: "reviewer",
    routeId: "crawl-agent-review", provider: "abcllm", model: MEMBER });
  expect(first.kind).toBe("granted");
  expect(await chooseFirstReviewForCandidate(context)).toEqual({ provider: "abcllm", model: RESERVE });
  const note: { capped?: ReadonlySet<string> } = {};
  // claim 의 재확인과 같은 호출(TX executor) — 예전에는 칸 수를 세지 않아 구성원을 다시 허락했다
  expect(await db.transaction(tx => chooseFirstReviewForCandidate(context, tx, new Set(), note))).toEqual({ provider: "abcllm", model: RESERVE });
  expect([...note.capped ?? []]).toEqual([JSON.stringify(["abcllm", MEMBER])]);
});

it("the reservation-creating ledger TX enforces the member cap atomically: two concurrent candidates, one queues", async () => {
  const cap = firstReviewMemberSlotCap({} as never, { provider: "abcllm", model: MEMBER });
  expect(cap?.maxSlots).toBe(1);
  const [a, b] = await Promise.all([requestAi1ModelSlot(ai1(11), 11, { memberCap: cap }), requestAi1ModelSlot(ai1(12), 12, { memberCap: cap })]);
  expect([a.kind, b.kind].sort()).toEqual(["deferred", "granted"]);
  expect([a, b].find(result => result.kind === "deferred")).toEqual({ kind: "deferred", reason: "model_quota" });
  // 장부에는 그 구성원의 살아 있는 행이 하나뿐이다(거절된 후보는 대기 행도 남기지 않는다)
  expect((await live()).map(row => row.state)).toEqual(["reserved"]);
});

it("an own queued/reserved request is resumed without counting the cap; the cap only gates new intents", async () => {
  const blocker: ModelSlotMemberCap = { maxSlots: 1, load: async () => 99 };
  const own = ai1(21);
  // 칸 수가 없던 때 줄에 선 자기 요청(예: 저장 직후) — 다시 물어도 칸 수로 거절하지 않는다
  expect((await requestAi1ModelSlot(own, 21)).kind).toBe("granted");
  expect((await requestAi1ModelSlot(own, 21, { memberCap: blocker })).kind).toBe("granted");
  // 새 의도는 막힌다
  expect(await requestAi1ModelSlot(ai1(22), 22, { memberCap: blocker })).toEqual({ kind: "deferred", reason: "model_quota" });
  // 칸 수가 없으면(예비·순위대로) 예전 그대로 장비 한도만 본다
  expect((await requestAi1ModelSlot(ai1(23), 23)).kind).toBe("granted");
  expect((await live()).length).toBe(2);
});
