import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import type { ModelCapacityPolicy } from "@/lib/llm/capacity";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/*
 * 장부 control 행(model_capacity_control id=1) 경합 — 2026-10-31 운영 관측(OPEN 직후 60초 표본 146회 중 42회에 Lock 대기, text 두 잡이
 * 매 틱 55P03)의 원인 재현과 고친 뒤의 계약.
 *
 * - 다른 세션이 control 을 FOR UPDATE 로 쥐고 있어도 readback(자기 대기·예약 행 조회, 전송 경로 선택용 control 읽기, 대기열 선택기의 busy
 *   제외)은 잠금 없이 끝난다 — 아래 다섯 호출은 holder 가 풀기 전에 돌아온다.
 * - 쓰기 경로(control FOR UPDATE)는 lock_timeout 으로 끝나고, drizzle 이 보고하는 실패 문장은 그 TX 의 첫 잠금 문장(control 행)이다 —
 *   뒤따르는 평범한 SELECT 가 아니다. 즉 "행 잠금 없는 SELECT 가 55P03 을 냈다"는 운영 기록은 같은 틱 안의 다른 TX(control 잠금)의 것이거나,
 *   같은 SQL 본문을 공유하는 다른 호출 경로의 것이다.
 * - 잠그지 않는 readback 은 커밋된 행만 본다(holder 의 미커밋 insert 는 보이지 않고, 커밋 뒤에는 보인다) — requestSlot 이 FOR UPDATE 아래에서
 *   다시 판정하므로 그 사이 값은 입장 근거가 아니다.
 */
// lib/db 의 첫 연결 전에 연결 lock_timeout 을 짧게 둔다 — 운영(5초)과 같은 55P03 경로를 수백 ms 로 본다
vi.stubEnv("DB_LOCK_TIMEOUT_MS", "300");
const admin = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, onnotice: () => {}, connection: { application_name: "ledger-lock-fixture" } });
const owner = { instanceId: `ledger-lock-${randomUUID().slice(0, 8)}`, bootId: randomUUID() };
const inserted = new Set<string>();
let saved: Record<string, unknown>, profileModel: string, reasonModel: string;

beforeAll(async () => {
  ensureSchema();
  const { modelCapacityPolicyHash } = await import("@/lib/llm/capacity");
  const { scopedModel } = await import("@/lib/llm/model-registry");
  const { PROFILE_MODEL } = await import("@/lib/domain/products/search-profile");
  const { TRANSLATE_MODEL } = await import("@/lib/crawl/translate");
  profileModel = scopedModel("product-search-profile", PROFILE_MODEL);
  reasonModel = scopedModel("reason-translate", TRANSLATE_MODEL);
  [{ saved }] = await admin`SELECT to_jsonb(c) AS saved FROM model_capacity_control c WHERE id=1` as unknown as [{ saved: Record<string, unknown> }];
  expect(await admin`SELECT state FROM dr_writer_fence WHERE id=1`).toEqual([{ state: "active" }]);
  const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { account: 2 }, groupLimits: { engine: 2 }, poolLimits: { reviewer: 2, text: 2 },
    weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12, queueTtlMs: 60_000, reservationTtlMs: 60_000,
    routes: [{ routeId: "product-search-profile", provider: "abcllm", model: profileModel, providerBudgetId: "account", groupId: "engine" },
      { routeId: "reason-translate", provider: "abcllm", model: reasonModel, providerBudgetId: "account", groupId: "engine" }] };
  await admin`UPDATE model_capacity_control SET mode='open', policy=${admin.json(policy as unknown as postgres.JSONValue)}, policy_hash=${modelCapacityPolicyHash(policy)},
    epoch=1, revision=1, cursor=0, updated_at=clock_timestamp() WHERE id=1`;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  const g = globalThis as { pgClient?: { end: (options: { timeout: number }) => Promise<void> } };
  await g.pgClient?.end({ timeout: 5 });
  try {
    for (const requestId of inserted) await admin`DELETE FROM model_capacity_requests WHERE request_id=${requestId}::uuid AND owner_instance_id=${owner.instanceId}`;
    await admin`UPDATE model_capacity_control SET mode=${saved.mode as string}, epoch=${saved.epoch as number}, revision=${saved.revision as number},
      policy=${saved.policy === null ? null : admin.json(saved.policy as postgres.JSONValue)}, policy_hash=${saved.policy_hash as string | null},
      cursor=${saved.cursor as number}, updated_at=${saved.updated_at as string}::timestamptz WHERE id=1`;
  } finally { await admin.end({ timeout: 5 }); }
});

/** control 행을 FOR UPDATE 로 쥔 TX — 테스트가 release() 를 부를 때까지 연다(운영의 긴 장부 쓰기 TX 를 흉내 낸다). */
async function holdControl(inside?: (tx: postgres.TransactionSql) => Promise<void>) {
  let release!: () => void, locked!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const lockedAt = new Promise<void>(resolve => { locked = resolve; });
  const done = admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    await inside?.(tx);
    locked();
    await released;
  });
  await lockedAt;
  return { release: async () => { release(); await done; } };
}

function lockTimeout(error: unknown): { reported: string } {
  expect(error).toBeInstanceOf(DrizzleQueryError);
  const failed = error as DrizzleQueryError & { cause?: { code?: string } };
  expect(failed.cause?.code).toBe("55P03");
  return { reported: failed.query };
}

it("readbacks and route checks finish while another session holds control FOR UPDATE; only writers hit lock_timeout on the control statement", async () => {
  const { findOwnPendingTextProfileRequests, findOwnPendingReasonTranslationRequests, findOwnPendingProductTextRequests,
    findOwnPendingModelRequest, readModelCapacityCallerControl, cancelReservedModelSlot } = await import("@/lib/llm/capacity-repository");
  const { retryableTranslations, untriedTranslations } = await import("@/lib/crawl/translations");
  const { isLockNotAvailable } = await import("@/lib/llm/capacity-lock-diagnostics");
  const identity = { owner, workKey: `text:profile:1:${"a".repeat(64)}`, class: "background" as const, pool: "text" as const,
    routeId: "product-search-profile", provider: "abcllm", model: profileModel };
  const holder = await holdControl();
  try {
    const startedAt = Date.now();
    // 1) 잠그지 않는 readback 들 — holder 가 쥔 동안 모두 돌아온다(55P03 없음)
    await expect(findOwnPendingTextProfileRequests({ owner, model: profileModel })).resolves.toEqual([]);
    await expect(findOwnPendingReasonTranslationRequests({ owner, model: reasonModel })).resolves.toEqual([]);
    await expect(findOwnPendingProductTextRequests({ owner, model: reasonModel, routeId: "product-translate" })).resolves.toEqual([]);
    await expect(findOwnPendingModelRequest(identity)).resolves.toBeNull();
    const control = await readModelCapacityCallerControl();
    expect(control.mode).toBe("open");
    expect(control.policy?.routes.map(route => route.routeId)).toEqual(["product-search-profile", "reason-translate"]);
    // reason-translate 의 대기열 선택기(notBusy → busyMemberKeysSql 의 control EXISTS)도 잠그지 않는다
    await expect(retryableTranslations(4, owner)).resolves.toBeInstanceOf(Array);
    await expect(untriedTranslations(4, owner)).resolves.toBeInstanceOf(Array);
    // 연결의 lock_timeout(300ms)이 한 번도 쓰이지 않았다 — 일곱 호출이 그 합보다 빨리 끝났다
    expect(Date.now() - startedAt).toBeLessThan(7 * 300);

    // 2) 쓰기 경로는 control FOR UPDATE 에서 lock_timeout — 보고되는 실패 문장은 control 행 잠금이다
    const reservation = { requestId: randomUUID(), owner, token: randomUUID(), epoch: 1, revision: 1, policyHash: "d".repeat(64) };
    const error = await cancelReservedModelSlot(reservation as never).then(() => null, (error: unknown) => error);
    expect(isLockNotAvailable(error)).toBe(true);
    const { reported } = lockTimeout(error);
    expect(reported).toContain('from "model_capacity_control"');
    expect(reported).toMatch(/for update$/);
    expect(reported).not.toContain("model_capacity_requests");
  } finally { await holder.release(); }
  // holder 가 풀린 뒤에는 같은 쓰기 경로가 잠금 없이 판정까지 간다(없는 예약 → false)
  await expect(cancelReservedModelSlot({ requestId: randomUUID(), owner, token: randomUUID(), epoch: 1, revision: 1, policyHash: "d".repeat(64) } as never)).resolves.toBe(false);
});

it("an unlocked readback sees only committed rows: the holder's uncommitted waiting row is invisible, then visible after commit", async () => {
  const { findOwnPendingModelRequest, findOwnPendingTextProfileRequests } = await import("@/lib/llm/capacity-repository");
  const requestId = randomUUID(), productId = 424242, workKey = `text:profile:${productId}:${"b".repeat(64)}`;
  const identity = { owner, workKey, class: "background" as const, pool: "text" as const, routeId: "product-search-profile", provider: "abcllm", model: profileModel };
  const [{ policy_hash: policyHash }] = await admin`SELECT policy_hash FROM model_capacity_control WHERE id=1`;
  const holder = await holdControl(async tx => {
    await tx`INSERT INTO model_capacity_requests (request_id, work_key, owner_instance_id, owner_boot_id, class, pool, route_id, provider, model,
        provider_budget_id, group_id, epoch, revision, policy_hash, state, queue_until, logical_work_key)
      VALUES (${requestId}::uuid, ${workKey}, ${owner.instanceId}, ${owner.bootId}::uuid, 'background', 'text', 'product-search-profile', 'abcllm', ${profileModel},
        'account', 'engine', 1, 1, ${policyHash}, 'waiting', clock_timestamp() + interval '10 minutes', ${`text:profile:${productId}`})`;
    inserted.add(requestId);
  });
  try {
    await expect(findOwnPendingModelRequest(identity)).resolves.toBeNull();
    await expect(findOwnPendingTextProfileRequests({ owner, model: profileModel })).resolves.toEqual([]);
  } finally { await holder.release(); }
  await expect(findOwnPendingModelRequest(identity)).resolves.toEqual({ requestId, state: "waiting" });
  await expect(findOwnPendingTextProfileRequests({ owner, model: profileModel })).resolves.toEqual([{ productId, workKey }]);
});
