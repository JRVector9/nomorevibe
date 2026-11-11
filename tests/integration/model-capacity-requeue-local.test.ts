import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { crawlCandidates, crawlReviewAttempts, gateSplitTiebreaks, jobs, productAuditCampaigns, productAuditItems, products,
  textTranslations } from "@/lib/db/schema";
import { localModelBindingHash, localModelBindingSchema, localModelJob, localModelLogicalKey, localModelRoute,
  type LocalModelTarget } from "@/lib/llm/local-model-capacity-contract";
import { modelCapacityPolicyHash, reasonTranslationDispatchBindingHash, reasonTranslationInputHash, reasonTranslationLogicalWorkKey,
  type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { DEEPSEEK_REVIEW_PROVIDER } from "@/lib/crawl/deepseek-review-policy";
import { HELD_QWEN_PROVIDER } from "@/lib/crawl/held-qwen-retry-policy";
import { QWEN_V2_PROMPT_VERSION } from "@/lib/crawl/qwen-direct-review";
import { canRequeueUnknownRoute, previewModelCapacityUnknowns, requeueModelCapacityUnknowns } from "@/lib/operations/model-capacity-requeue";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 「다시 대기열」(결과 미확정 행) — 2026-11-11.
 *  ② 사유 번역은 시도 횟수를 되돌리지 않는다(운영 2026-11-10: 다시 넣은 독 글이 시도 0 으로 다시 묶여 곧바로 결과 미확정 2건을 더 남겼다).
 *  ③ 후보·갈림·감사 항목을 가리키는 로컬 직접 경로(local-human-deepseek · local-qwen-tiebreak · local-deepseek-confirm · local-audit)를 지원한다.
 * 장부 행은 실제 CHECK 를 지나는 binding 으로 넣는다(잡 경로 대신) — 자기 DB 를 만들어 다른 파일과 장부·작업 행을 나누지 않는다.
 */
const name = `nomorevibe_test_requeue_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 3, prepare: false, onnotice: () => {} });
let created = false;
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { fixture: 4 }, groupLimits: { fixture: 4 },
  poolLimits: { reviewer: 4, text: 4 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 20, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "local-human-deepseek", provider: "local-direct", model: "fixture-model", providerBudgetId: "fixture", groupId: "fixture" }] };
const policyHash = modelCapacityPolicyHash(policy);
const owner = { instanceId: "requeue-fixture", bootId: randomUUID() };
const hash = (seed: string) => seed.repeat(64).slice(0, 64);
let serial = 0;

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.resolve("drizzle") });
  await client`UPDATE model_capacity_control SET mode='draining', epoch=1, revision=2, policy=${JSON.stringify(policy)}::jsonb, policy_hash=${policyHash} WHERE id=1`;
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
}, 180_000);
afterAll(async () => {
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 }); if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end({ timeout: 3 });
});

/** 결과 미확정(indeterminate) 로컬 직접 장부 행 — 운영과 같은 binding 모양(CHECK 를 지난다) */
async function localUnknown(target: LocalModelTarget): Promise<string> {
  const requestId = randomUUID(), digest = hash("a");
  const binding = localModelBindingSchema.parse({ kind: "local_model_direct", version: 1, target, logicalWorkKey: localModelLogicalKey(target),
    routeId: localModelRoute(target), provider: "local-direct", model: "fixture-model", backendId: "fixture", physicalGroup: "fixture",
    deploymentRevision: "fixture", inputHash: digest, sourceRevisionHash: digest, reviewPolicyHash: digest, promptVersion: "fixture", wireHash: digest,
    servingContractHash: digest, totalTokenBound: 1000, chargedTokens: 1000, job: { name: localModelJob(target), token: randomUUID(), requestedVersion: 1 } });
  await client`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,provider_budget_id,
      group_id,epoch,revision,policy_hash,state,logical_work_key,dispatch_binding,dispatch_binding_hash,dispatched_at,token,reserved_until,queue_until)
    VALUES(${requestId},${`${binding.logicalWorkKey}:${digest}`},${owner.instanceId},${owner.bootId},'background','reviewer',${binding.routeId},'local-direct',
      ${binding.model},'fixture','fixture',1,2,${policyHash},'indeterminate',${binding.logicalWorkKey},${JSON.stringify(binding)}::jsonb,
      ${localModelBindingHash(binding)},clock_timestamp() - interval '1 minute',${randomUUID()},clock_timestamp(),clock_timestamp())`;
  return requestId;
}
const ledger = async (requestIds: string[]) => new Map(Array.from(await client`SELECT request_id, state, terminal_evidence FROM model_capacity_requests
  WHERE request_id = ANY(${requestIds}::uuid[])`).map(row => [String(row.request_id), { state: row.state as string,
  note: (row.terminal_evidence as { note?: string } | null)?.note ?? null }]));
const requested = async (job: string) => (await db.select({ version: jobs.requestedVersion }).from(jobs).where(eq(jobs.name, job)))[0]?.version ?? 0;
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

async function candidate(values: Partial<typeof crawlCandidates.$inferInsert> = {}) {
  const repo = `requeue-fixture/app-${++serial}`;
  const [row] = await db.insert(crawlCandidates).values({ repo, productUrl: `https://${serial}.requeue.example`, state: "needs_review",
    reason: "ambiguous", decidedBy: "auto", ...values }).returning({ id: crawlCandidates.id, repo: crawlCandidates.repo });
  return row;
}
async function attempt(candidateId: number, values: Partial<typeof crawlReviewAttempts.$inferInsert>) {
  const [row] = await db.insert(crawlReviewAttempts).values({ candidateId, kind: "delegated", state: "failed", inputHash: hash("1"), policyHash: hash("2"),
    sourceRevisionHash: hash("3"), snapshot: {} as never, source: {} as never, promptVersion: "fixture", rulesVersion: "fixture",
    provider: DEEPSEEK_REVIEW_PROVIDER, model: "deepseek", actor: "deepseek:1", attemptNumber: 1, validUntil: later(60), ...values })
    .returning({ id: crawlReviewAttempts.id });
  return row.id;
}

describe("③ local-human-deepseek — 위임 검수의 결과 미확정 행", () => {
  it("그 뒤 성공한 위임은 닫고, 기다리는 위임은 다시 볼 시각만 지워 잡을 부르며, 상한·사람 결정은 닫기만 한다", async () => {
    expect(canRequeueUnknownRoute("local-human-deepseek")).toBe(true);
    // 운영 2026-11-10 후보 597175: 시도 232068 이 cancelled 로 끝나 장부 행이 미확정으로 남고, 40분 뒤 시도 232334 가 성공했다
    const redone = await candidate();
    const redoneOwn = await attempt(redone.id, { errorCode: "cancelled", retryAfter: later(15) });
    await attempt(redone.id, { state: "succeeded", errorCode: null, attemptNumber: 2,
      outcome: { decision: "needs_review", reason: "Not enough evidence", evidenceIds: ["product"], confidence: 0.5 } });
    // 기다리는 위임 — 실패 하나(15분 뒤 다시). 뒤의 보류 Qwen 성공은 위임의 일이 아니다
    const waiting = await candidate();
    const waitingOwn = await attempt(waiting.id, { errorCode: "timeout", retryAfter: later(15) });
    await attempt(waiting.id, { state: "succeeded", provider: HELD_QWEN_PROVIDER, actor: "qwen", attemptNumber: 2,
      outcome: { decision: "needs_review", reason: "Unclear", evidenceIds: ["product"], confidence: 0.4 } });
    // 같은 입력에서 셋을 다 썼다 — 잡은 더 부르지 않는다. 용량 미룸(세지 않는 superseded)은 상한에 들지 않는다
    const exhausted = await candidate();
    const exhaustedOwn = await attempt(exhausted.id, { errorCode: "timeout", retryAfter: later(15) });
    await attempt(exhausted.id, { errorCode: "timeout", retryAfter: later(15), attemptNumber: 2 });
    await attempt(exhausted.id, { errorCode: "invalid_json", retryAfter: later(15), attemptNumber: 3 });
    const underCap = await candidate();
    const underCapOwn = await attempt(underCap.id, { errorCode: "timeout", retryAfter: later(15) });
    await attempt(underCap.id, { errorCode: "timeout", retryAfter: later(15), attemptNumber: 2 });
    await attempt(underCap.id, { state: "superseded", errorCode: "model_capacity_deferred", attemptNumber: 3 });
    // 사람이 그 사이 정했다
    const decided = await candidate({ state: "rejected", reason: "not_a_product", decidedBy: "jr" });
    const decidedOwn = await attempt(decided.id, { errorCode: "timeout", retryAfter: later(15) });
    const target = (row: { id: number; repo: string }, attemptId: number): LocalModelTarget =>
      ({ kind: "candidate", purpose: "human_deepseek", attemptId, candidateId: row.id, repo: row.repo });
    const ids = [await localUnknown(target(redone, redoneOwn)), await localUnknown(target(waiting, waitingOwn)),
      await localUnknown(target(exhausted, exhaustedOwn)), await localUnknown(target(underCap, underCapOwn)), await localUnknown(target(decided, decidedOwn))];
    const expected = [["done", "delegate_done"], ["requeued", "requeued"], ["done", "attempts_exhausted"], ["requeued", "requeued"], ["done", "candidate_decided"]];
    // 미리보기는 같은 판정이고 아무것도 쓰지 않는다
    const before = await db.select().from(crawlReviewAttempts).orderBy(crawlReviewAttempts.id);
    const preview = await previewModelCapacityUnknowns(ids);
    expect(ids.map(id => [preview.get(id)?.outcome, preview.get(id)?.reason])).toEqual(expected);
    expect(await db.select().from(crawlReviewAttempts).orderBy(crawlReviewAttempts.id)).toEqual(before);
    const version = await requested("human-deepseek-review");

    expect(await requeueModelCapacityUnknowns({ routeId: "local-human-deepseek", operator: "fixture", note: "2026-11-11 repro" })).toEqual({
      groups: [{ routeId: "local-human-deepseek", requests: 5, requeued: 2, done: 3, skipped: 0, closed: 5, left: [], error: null }], closed: 5, leftRows: [] });
    const closed = await ledger(ids);
    expect(ids.map(id => closed.get(id)?.state)).toEqual(Array(5).fill("withdrawn"));
    expect(closed.get(ids[0])?.note).toBe("2026-11-11 repro · local-human-deepseek · 위임 검수를 그 뒤 다시 해 끝남");
    expect(await requested("human-deepseek-review")).toBe(version + 1);
    // 다시 넣은 후보의 실패한 DeepSeek 위임만 지금 다시 볼 수 있게 되고, 시도 행·횟수·다른 후보·보류 Qwen 행은 그대로다
    const after = await db.select().from(crawlReviewAttempts).orderBy(crawlReviewAttempts.id);
    expect(after.filter(row => row.retryAfter === null && before.find(old => old.id === row.id)?.retryAfter !== null).map(row => row.candidateId))
      .toEqual([waiting.id, underCap.id, underCap.id]);
    const withoutRetry = (rows: typeof before) => rows.map(row => ({ ...row, retryAfter: null }));
    expect(withoutRetry(after)).toEqual(withoutRetry(before));
    expect(after.filter(row => [redone.id, exhausted.id, decided.id].includes(row.candidateId)))
      .toEqual(before.filter(row => [redone.id, exhausted.id, decided.id].includes(row.candidateId)));
  });
});

describe("③ local-qwen-tiebreak · local-deepseek-confirm — 갈림 판가름 행", () => {
  async function tiebreak(values: Partial<typeof gateSplitTiebreaks.$inferInsert>, candidateValues: Partial<typeof crawlCandidates.$inferInsert> = {}) {
    const row = await candidate({ reason: "second_review_split", ...candidateValues });
    const generationKey = hash(String(serial % 10));
    const [inserted] = await db.insert(gateSplitTiebreaks).values({ candidateId: row.id, repo: row.repo, generationKey, promptVersion: QWEN_V2_PROMPT_VERSION,
      model: "qwen", state: "failed", failureCount: 1, retryAfter: later(15), ...values }).returning({ id: gateSplitTiebreaks.id });
    return { candidateId: row.id, repo: row.repo, generationKey, tiebreakId: inserted.id };
  }
  const split = (purpose: "qwen_tiebreak" | "deepseek_confirm", row: Awaited<ReturnType<typeof tiebreak>>): LocalModelTarget => ({ kind: "split", purpose, ...row });

  it("판가름: 실패 대기는 다시 볼 시각만 지우고(실패 수 그대로), 답·물을 수 없음·상한·사람 결정은 닫는다", async () => {
    expect(canRequeueUnknownRoute("local-qwen-tiebreak")).toBe(true);
    const failed = await tiebreak({ failureCount: 1 }), running = await tiebreak({ state: "running", retryAfter: null });
    const answered = await tiebreak({ state: "succeeded", retryAfter: null, decision: "approve", applied: "kept_human" });
    const ineligible = await tiebreak({ state: "ineligible", errorCode: "source_changed" });
    const capped = await tiebreak({ failureCount: 3 }), decided = await tiebreak({}, { state: "approved", reason: "passed", decidedBy: "jr" });
    const rows = [failed, running, answered, ineligible, capped, decided];
    const ids = [];
    for (const row of rows) ids.push(await localUnknown(split("qwen_tiebreak", row)));
    const version = await requested("split-tiebreak");
    const result = await requeueModelCapacityUnknowns({ routeId: "local-qwen-tiebreak", operator: "fixture", note: "tiebreak" });
    expect(result.groups).toEqual([{ routeId: "local-qwen-tiebreak", requests: 6, requeued: 2, done: 4, skipped: 0, closed: 6, left: [], error: null }]);
    const preview = await previewModelCapacityUnknowns(ids);
    expect(preview.size).toBe(0); // 이미 닫혔다 — 미확정 행만 본다
    expect(await requested("split-tiebreak")).toBe(version + 1);
    const after = new Map((await db.select().from(gateSplitTiebreaks).where(inArray(gateSplitTiebreaks.id, rows.map(row => row.tiebreakId))))
      .map(row => [row.id, row]));
    expect(after.get(failed.tiebreakId)).toMatchObject({ state: "failed", failureCount: 1, retryAfter: null });
    expect(after.get(running.tiebreakId)).toMatchObject({ state: "running", failureCount: 1 });
    for (const row of [ineligible, capped, decided]) expect(after.get(row.tiebreakId)?.retryAfter).not.toBeNull();
    const notes = await ledger(ids);
    expect(ids.map(id => notes.get(id)?.note?.split(" · ")[2])).toEqual(["다시 넣음", "다시 넣음", "갈림 판가름이 이미 끝남(답·물을 수 없음)",
      "갈림 판가름이 이미 끝남(답·물을 수 없음)", "시도 상한에 닿아 더 묻지 않음 — 사람 몫으로 남음", "후보 판정이 이미 남(사람·거절·발행)"]);
  });

  it("확인: 확인을 기다리는 실패만 다시 볼 시각을 지우고, 기다리지 않거나 끝난 확인·옛 판 행은 닫는다", async () => {
    expect(canRequeueUnknownRoute("local-deepseek-confirm")).toBe(true);
    const awaiting = { state: "succeeded" as const, retryAfter: null, decision: "reject" as const, applied: "awaiting_deepseek" };
    const failed = await tiebreak({ ...awaiting, deepseekState: "failed", deepseekFailureCount: 1, deepseekRetryAfter: later(15) });
    const waiting = await tiebreak({ ...awaiting, deepseekState: "waiting" });
    const confirmed = await tiebreak({ ...awaiting, applied: "rejected", deepseekState: "succeeded" });
    const capped = await tiebreak({ ...awaiting, deepseekState: "failed", deepseekFailureCount: 3, deepseekRetryAfter: later(15) });
    const oldPrompt = await tiebreak({ ...awaiting, promptVersion: "2026-01-01.old", deepseekState: "failed", deepseekRetryAfter: later(15) });
    const rows = [failed, waiting, confirmed, capped, oldPrompt];
    const ids = [];
    for (const row of rows) ids.push(await localUnknown(split("deepseek_confirm", row)));
    const preview = await previewModelCapacityUnknowns(ids);
    expect(ids.map(id => preview.get(id)?.reason)).toEqual(["requeued", "requeued", "confirm_done", "attempts_exhausted", "tiebreak_gone"]);
    const version = await requested("split-confirm");
    expect((await requeueModelCapacityUnknowns({ routeId: "local-deepseek-confirm", operator: "fixture", note: "confirm" })).groups)
      .toEqual([{ routeId: "local-deepseek-confirm", requests: 5, requeued: 2, done: 3, skipped: 0, closed: 5, left: [], error: null }]);
    expect(await requested("split-confirm")).toBe(version + 1);
    const after = new Map((await db.select().from(gateSplitTiebreaks).where(inArray(gateSplitTiebreaks.id, rows.map(row => row.tiebreakId))))
      .map(row => [row.id, row]));
    expect(after.get(failed.tiebreakId)).toMatchObject({ deepseekState: "failed", deepseekFailureCount: 1, deepseekRetryAfter: null });
    for (const row of [capped, oldPrompt]) expect(after.get(row.tiebreakId)?.deepseekRetryAfter).not.toBeNull();
  });
});

describe("③ local-audit — 감사 항목(직접 모델)", () => {
  it("답이 없고 시도가 남은 항목만 다시 볼 시각을 지우고, 답·상한·닫힌 감사·내린 제품은 닫는다", async () => {
    expect(canRequeueUnknownRoute("local-audit")).toBe(true);
    const product = async (status: "seeded" | "banned" = "seeded") => {
      const slug = `requeue-audit-${++serial}`;
      const [row] = await db.insert(products).values({ slug, url: `https://${slug}.example`, name: slug, tagline: "한 줄", description: "소개",
        category: "Productivity", status, source: "crawler", verifyToken: `token-${serial}`, editTokenHash: "h".repeat(64) }).returning({ id: products.id, slug: products.slug });
      return row;
    };
    const campaign = async (status: "running" | "done") => (await db.insert(productAuditCampaigns).values({ startedBy: "jr", reason: "fixture",
      promptVersion: "p", rulesVersion: "r", provider: "qwen-direct", model: "qwen", status }).returning({ id: productAuditCampaigns.id }))[0].id;
    const running = await campaign("running"), finished = await campaign("done");
    const item = async (campaignId: number, values: Partial<typeof productAuditItems.$inferInsert> = {}, status: "seeded" | "banned" = "seeded") => {
      const listed = await product(status);
      const [row] = await db.insert(productAuditItems).values({ campaignId, productId: listed.id, slug: listed.slug, attempts: 1, errorCode: "timeout",
        retryAt: later(10), ...values }).returning({ id: productAuditItems.id, slug: productAuditItems.slug });
      return row;
    };
    const rows = [await item(running), await item(running, { aiDecision: "approve", aiReason: "ok", errorCode: null, retryAt: null }),
      await item(running, { attempts: 3 }), await item(finished), await item(running, {}, "banned")];
    const ids = [];
    for (const row of rows) ids.push(await localUnknown({ kind: "audit", purpose: "audit", itemId: row.id, slug: row.slug }));
    const preview = await previewModelCapacityUnknowns(ids);
    expect(ids.map(id => preview.get(id)?.reason)).toEqual(["requeued", "audit_done", "attempts_exhausted", "audit_closed", "product_not_listed"]);
    const version = await requested("audit-qwen");
    expect((await requeueModelCapacityUnknowns({ routeId: "local-audit", operator: "fixture", note: "audit" })).groups)
      .toEqual([{ routeId: "local-audit", requests: 5, requeued: 1, done: 4, skipped: 0, closed: 5, left: [], error: null }]);
    expect(await requested("audit-qwen")).toBe(version + 1);
    const after = await db.select().from(productAuditItems).where(inArray(productAuditItems.id, rows.map(row => row.id))).orderBy(productAuditItems.id);
    expect(after.map(row => [row.attempts, row.retryAt === null])).toEqual([[1, true], [1, true], [3, false], [1, false], [1, false]]);
  });
});

describe("③ 지원하지 않는 로컬 경로는 남는다", () => {
  it("local-second-opinion 은 넣지도 닫지도 않고 까닭(unsupported_route)과 함께 남긴다", async () => {
    expect(canRequeueUnknownRoute("local-second-opinion")).toBe(false);
    const id = await localUnknown({ kind: "audit", purpose: "second_opinion", itemId: 999_999, slug: "missing" });
    expect(await requeueModelCapacityUnknowns({ routeId: "local-second-opinion", operator: "fixture", note: "left" })).toEqual({
      groups: [{ routeId: "local-second-opinion", requests: 1, requeued: 0, done: 0, skipped: 1, closed: 0, left: [{ reason: "unsupported_route", count: 1 }],
        error: null }], closed: 0, leftRows: [{ requestId: id, routeId: "local-second-opinion", reason: "unsupported_route" }] });
    expect((await ledger([id])).get(id)?.state).toBe("indeterminate");
  });
});

describe("② reason-translate — 다시 넣어도 시도 횟수는 그대로다", () => {
  it("끝나지 않은 번역은 지금 다시 볼 수 있게만 하고 시도 횟수·마지막 오류를 지키며, 끝난 번역은 닫기만 한다", async () => {
    const poison = hash("e"), finished = hash("d");
    await db.insert(textTranslations).values([
      { sourceHash: poison, targetLang: "ko", status: "failed", attempts: 7, errorCode: "invalid_output", retryAt: later(600) },
      { sourceHash: finished, targetLang: "ko", status: "done", translated: "끝난 번역", attempts: 1 }]);
    const role = { role: "text" as const, instanceId: owner.instanceId, bootId: owner.bootId, release: "fixture", kind: "primary" as const, epoch: 1,
      batch: { mode: "legacy" as const } };
    const ids: string[] = [];
    for (const sourceHash of [poison, finished]) {
      const members = [{ sourceHash, cache: { kind: "present" as const, rowIdentityHash: hash("c"), attempts: 7 } }], model = "m1-gemma";
      const binding = { kind: "reason_translation_gateway" as const, version: 1 as const, members, model,
        inputHash: reasonTranslationInputHash({ members, model }), logicalWorkKey: reasonTranslationLogicalWorkKey(members),
        routeId: "reason-translate" as const, provider: "abcllm" as const, wireHash: hash("b"), servingContractHash: hash("f"),
        totalTokenBound: 8000, chargedTokens: 8000, role, job: { name: "reason-translate" as const, token: randomUUID(), requestedVersion: 1 } };
      const requestId = randomUUID();
      await client`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,provider_budget_id,
          group_id,epoch,revision,policy_hash,state,logical_work_key,logical_member_keys,dispatch_binding,dispatch_binding_hash,dispatched_at,token,reserved_until,queue_until)
        VALUES(${requestId},${`${binding.logicalWorkKey}:${binding.inputHash}`},${owner.instanceId},${owner.bootId},'background','text','reason-translate','abcllm',
          ${model},'fixture','fixture',1,2,${policyHash},'indeterminate',${binding.logicalWorkKey},${[`ko:${sourceHash}`]}::text[],
          ${JSON.stringify(binding)}::jsonb,${reasonTranslationDispatchBindingHash(binding)},clock_timestamp() - interval '1 minute',${randomUUID()},
          clock_timestamp(),clock_timestamp())`;
      ids.push(requestId);
    }
    const version = await requested("reason-translate");
    expect((await requeueModelCapacityUnknowns({ routeId: "reason-translate", operator: "fixture", note: "reason" })).groups)
      .toEqual([{ routeId: "reason-translate", requests: 2, requeued: 1, done: 1, skipped: 0, closed: 2, left: [], error: null }]);
    expect(await requested("reason-translate")).toBe(version + 1);
    const [row] = await db.select().from(textTranslations).where(eq(textTranslations.sourceHash, poison));
    // 시도 7 그대로 — 잡은 이 글을 홀로(soloAttempts 3 이상) 보내고, 다시 실패하면 5분×2^7 뒤에 본다
    expect(row).toMatchObject({ status: "failed", attempts: 7, errorCode: "invalid_output" });
    expect(row.retryAt!.getTime()).toBeLessThan(Date.now() + 60_000);
    expect((await db.select().from(textTranslations).where(eq(textTranslations.sourceHash, finished)))[0]).toMatchObject({ status: "done", attempts: 1 });
  });
});
