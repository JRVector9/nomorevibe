import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { modelCapacityPolicyHash, productTaglineKoInputHash, productTaglineKoLogicalWorkKey, productTranslationInputHash,
  productTranslationLogicalWorkKey, reasonTranslationInputHash, reasonTranslationLogicalWorkKey, textProfileInputHash,
  type ModelCapacityPolicy, type ModelCapacityRequest, type ModelSlotResult, type ProductTaglineKoMember, type ProductTranslationMember,
  type ReasonTranslationMember } from "@/lib/llm/capacity";
import { requestModelSlot, requestProductTaglineKoModelSlot, requestProductTranslationModelSlot, requestReasonTranslationModelSlot,
  requestTextProfileModelSlot } from "@/lib/llm/capacity-repository";
import { capacityRefusalReason } from "@/lib/llm/capacity-busy-targets";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { resolveTextTaskRanks, TextTaskRanks } from "@/lib/llm/ai-task-resolver";
import type { TextTaskRankBinding } from "@/lib/llm/ai-task-rank-scope";
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import type { AiTextTaskId } from "@/lib/llm/ai-tasks";
import { textContract, textRankRow } from "../text-task-ranks-fixture";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 2026-11-12 검수 F1(gpt-6.1-sol 재현): 순위대로의 글 작업에서 1순위 장비가 가득이면 그 요청이 대기 행으로 줄에 서고(capacity), runRanked 가 같은 일을
 * 2순위로 넘긴다 — 그런데 그 대기 행이 같은 일의 fence 라 2순위 장비가 비어 있어도 2순위 요청이 막혀(work_busy) 항목이 미뤄졌다.
 * 고친 뒤: 2순위가 그 자리에서 예약을 받으면 같은 TX 에서 1순위의 「보내지 않은」 자기 대기 행을 거두고(wait_cancelled) 2순위가 일한다. 2순위도 가득이면
 * 아무것도 바꾸지 않는다(1순위 줄 자리를 지킨다). 예약·보냄 행, 다른 주인의 행은 건드리지 않는다. 실제 resolver·장부 API·자기 DB 로 본다
 * (모델을 부르기 전 입장 단계까지). 장비 한도는 정책 groupLimits(장비 행 없음)로 1칸씩이다.
 */
const name = `nomorevibe_test_rank_handover_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {} });
let created = false;
const FIRST = "gpt-oss-120b", SECOND = "qwen3.6-35b";
const SECOND_CONNECTION = "0b0c0d0e-0000-4000-8000-000000000002", SECOND_BASE = "http://second.test/v1";
const TASKS = ["product-translate", "product-tagline-ko", "product-search-profile", "reason-translate"] as const satisfies readonly AiTextTaskId[];
type Task = (typeof TASKS)[number];
const policy: ModelCapacityPolicy = { version: 1, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  groupLimits: { "device-first": 1, "device-second": 1 }, routes: [
    { routeId: "blocker-first", provider: "fixture", model: FIRST, providerBudgetId: "acct", groupId: "device-first" },
    { routeId: "blocker-second", provider: "fixture", model: SECOND, providerBudgetId: "acct", groupId: "device-second" },
    ...TASKS.flatMap(routeId => [FIRST, SECOND].map((model, index) => ({ routeId, provider: "abcllm", model, providerBudgetId: "acct",
      groupId: index ? "device-second" : "device-first" }))) ] };
const owner = { instanceId: `rank-handover-${randomUUID()}`, bootId: randomUUID() };
const sha = (seed: string) => seed.repeat(64).slice(0, 64);

/** 한 일(묶음)의 요청을 모델마다 만든다 — 같은 일이면 멤버·작업 키가 같고 모델만 다르다 */
type Ask = (model: string, who?: typeof owner) => { request: ModelCapacityRequest; slot: () => Promise<ModelSlotResult> };
function work(task: Task, seed: number): Ask {
  const base = (model: string, who: typeof owner, workKey: string): ModelCapacityRequest => ({ requestId: randomUUID(), workKey, owner: who,
    class: "background", pool: "text", routeId: task, provider: "abcllm", model });
  if (task === "product-translate") {
    const members: ProductTranslationMember[] = [{ productId: seed, slug: `handover-${seed}`, locale: "en", field: "tagline",
      sourceHash: sha("a"), demand: { rowIdentityHash: sha("b"), attempts: 0 } }];
    return (model, who = owner) => { const request = base(model, who,
      `${productTranslationLogicalWorkKey(members)}:${productTranslationInputHash({ members, model })}`);
    return { request, slot: () => requestProductTranslationModelSlot(request, members) }; };
  }
  if (task === "product-tagline-ko") {
    const members: ProductTaglineKoMember[] = [{ productId: seed, slug: `handover-${seed}`, sourceIdentityHash: sha("c"), sourceHash: sha("d"),
      cache: { kind: "absent" } }];
    return (model, who = owner) => { const request = base(model, who,
      `${productTaglineKoLogicalWorkKey(members)}:${productTaglineKoInputHash({ members, model })}`);
    return { request, slot: () => requestProductTaglineKoModelSlot(request, members) }; };
  }
  if (task === "reason-translate") {
    const members: ReasonTranslationMember[] = [{ sourceHash: sha(String(seed % 10)), cache: { kind: "absent" } }];
    return (model, who = owner) => { const request = base(model, who,
      `${reasonTranslationLogicalWorkKey(members)}:${reasonTranslationInputHash({ members, model })}`);
    return { request, slot: () => requestReasonTranslationModelSlot(request, members) }; };
  }
  return (model, who = owner) => {
    const input = { productId: seed, slug: `handover-${seed}`, evidenceHash: sha("e"), profile: { kind: "absent" as const }, model };
    const request = base(model, who, `text:profile:${seed}:${textProfileInputHash(input)}`);
    return { request, slot: () => requestTextProfileModelSlot(request, seed) };
  };
}

function pinRanks(task: Task) {
  setAiTaskModelsForTest([textRankRow(task, FIRST), textRankRow(task, SECOND, { rank: 2, connectionId: SECOND_CONNECTION, baseUrl: SECOND_BASE })]);
  setServingContractSnapshotForTest([textContract(task, FIRST), textContract(task, SECOND, { baseUrl: SECOND_BASE })]);
}
/** 잡이 하듯 같은 일을 순위 차례로 부른다 — 모델을 부르기 전 입장(장부 요청)까지만 */
async function runRanked(task: Task, ask: Ask) {
  const ranks = new TextTaskRanks(resolveTextTaskRanks(task));
  const visited: { rank: number; kind: string; reason: string | null }[] = [];
  try {
    const run = await ranks.run(async (binding: TextTaskRankBinding) => {
      const { request, slot } = ask(binding.identity);
      const result = await slot();
      const reason = result.kind === "granted" ? null : await capacityRefusalReason(request, result);
      visited.push({ rank: binding.rank, kind: result.kind, reason });
      if (reason) throw new ModelCapacityDeferredError(reason);
      return binding.rank;
    });
    return { run, visited, ranks };
  } catch (error) {
    return { error: error instanceof ModelCapacityDeferredError ? error.reason : String(error), visited, ranks };
  }
}
const block = (routeId: "blocker-first" | "blocker-second") => requestModelSlot({ requestId: randomUUID(), workKey: randomUUID(), owner,
  class: "background", pool: "text", routeId, provider: "fixture", model: routeId === "blocker-first" ? FIRST : SECOND });
/** 이 시험이 쓴 행만(앞 시험의 거둔 행은 뺀다) */
let floor = 0;
const rows = (routeId: string) => client`SELECT request_id, model, state FROM model_capacity_requests
  WHERE route_id = ${routeId} AND queue_ordinal > ${floor} ORDER BY queue_ordinal`;
const eventsOf = async (requestId: string) => (await client`SELECT kind FROM model_capacity_events WHERE request_id = ${requestId} ORDER BY id`).map(row => row.kind);

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.join(path.resolve("."), "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
  await client`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(policy)}::jsonb, policy_hash = ${modelCapacityPolicyHash(policy)},
    revision = revision + 1, cursor = 0, updated_at = clock_timestamp() WHERE id = 1`;
}, 180_000);
beforeEach(async () => {
  await client`UPDATE model_capacity_requests SET state = 'withdrawn', updated_at = clock_timestamp() WHERE state IN ('waiting','reserved')`;
  floor = Number((await client`SELECT coalesce(max(queue_ordinal), 0)::bigint AS n FROM model_capacity_requests`)[0].n);
});
afterEach(() => { setAiTaskModelsForTest(null); setServingContractSnapshotForTest(null); });
afterAll(async () => {
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 }); if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end({ timeout: 3 });
});

describe.each(TASKS.map((task, index) => [task, 100 + index] as const))("%s", (task, seed) => {
  it("rank-1 device saturation lets the same work run on an idle rank-2 device, handing over the unsent rank-1 waiting row", async () => {
    pinRanks(task);
    expect((await block("blocker-first")).kind).toBe("granted");
    const result = await runRanked(task, work(task, seed));
    expect(result).toMatchObject({ run: { kind: "served", value: 2 } });
    expect(result.visited).toEqual([{ rank: 1, kind: "deferred", reason: "capacity" }, { rank: 2, kind: "granted", reason: null }]);
    const ledger = await rows(task);
    expect(ledger.map(row => [row.model, row.state])).toEqual([[FIRST, "withdrawn"], [SECOND, "reserved"]]);
    // 1순위의 대기 행은 지우지 않고 wait_cancelled 로 거뒀다(append-only 사건 그대로)
    expect(await eventsOf(ledger[0].request_id)).toEqual(["queued", "wait_cancelled"]);
  });
});

describe("product-translate", () => {
  const task = "product-translate" as const;
  it("when rank 2 is saturated too nothing changes: the rank-1 waiting row keeps its place and rank 2 leaves no row", async () => {
    pinRanks(task);
    expect((await block("blocker-first")).kind).toBe("granted");
    expect((await block("blocker-second")).kind).toBe("granted");
    const result = await runRanked(task, work(task, 201));
    // 모든 순위가 포화 — 잡은 model_capacity 로 미룬다(work_busy 로 이 일만 넘기지 않는다)
    expect(result).toMatchObject({ run: { kind: "unusable" } });
    expect(result.ranks.saturated()).toBe(true);
    expect(result.visited).toEqual([{ rank: 1, kind: "deferred", reason: "capacity" }, { rank: 2, kind: "deferred", reason: "capacity" }]);
    const ledger = await rows(task);
    expect(ledger.map(row => [row.model, row.state])).toEqual([[FIRST, "waiting"]]);
    expect(await eventsOf(ledger[0].request_id)).toEqual(["queued"]);
  });

  it("a reserved (not yet sent) rank-1 row is never handed over — the rank-2 request is only this work's busy refusal", async () => {
    pinRanks(task);
    const ask = work(task, 202);
    expect((await ask(FIRST).slot()).kind).toBe("granted");
    const second = ask(SECOND);
    const slot = await second.slot();
    expect(slot).toEqual({ kind: "deferred", reason: "capacity" });
    expect(await capacityRefusalReason(second.request, slot)).toBe("work_busy");
    expect((await rows(task)).map(row => [row.model, row.state])).toEqual([[FIRST, "reserved"]]);
  });

  it("another owner's waiting row for the same work is never handed over", async () => {
    pinRanks(task);
    expect((await block("blocker-first")).kind).toBe("granted");
    const ask = work(task, 203), foreign = { instanceId: `foreign-${randomUUID()}`, bootId: randomUUID() };
    expect(await ask(FIRST, foreign).slot()).toEqual({ kind: "deferred", reason: "capacity" });
    const mine = ask(SECOND);
    const slot = await mine.slot();
    expect(slot).toEqual({ kind: "deferred", reason: "capacity" });
    expect(await capacityRefusalReason(mine.request, slot)).toBe("work_busy");
    expect((await rows(task)).map(row => [row.model, row.state])).toEqual([[FIRST, "waiting"]]);
  });

  it("the same model on two ranks shares one waiting row (no handover between equal ledger identities)", async () => {
    pinRanks(task);
    expect((await block("blocker-first")).kind).toBe("granted");
    const ask = work(task, 204), first = ask(FIRST);
    expect(await first.slot()).toEqual({ kind: "deferred", reason: "capacity" });
    // 같은 모델·같은 작업 키의 새 요청(다른 requestId)은 중복 작업이다 — 대기 행을 거두지 않는다
    const again = ask(FIRST), slot = await again.slot();
    expect(slot).toEqual({ kind: "deferred", reason: "capacity" });
    expect((await rows(task)).map(row => [row.request_id, row.state])).toEqual([[first.request.requestId, "waiting"]]);
  });
});
