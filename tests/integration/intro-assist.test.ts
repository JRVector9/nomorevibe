import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { llmAssistResults, operationsAudit, productIntroChecks, productMakerMembers, products, publicUsers } from "@/lib/db/schema";
import { ASSIST_SCHEMA_VERSION, assistHash, assistInputHash, type AssistOutcome } from "@/lib/domain/llm-assist/contracts";
import { buildIntroAssistInput, introCorrectionPromptHash, introCorrectionRequestHash, introRecheckSourceHash,
  type IntroRewriteCandidate } from "@/lib/domain/products/intro-assist";
import { applyIntroAssistCorrection, planIntroRechecks, readIntroRecheckSnapshot, requestIntroRecheck,
  saveIntroCorrection } from "@/lib/domain/products/intro-assist-repository";
import { pendingIntroChecks } from "@/lib/domain/products/intro-checks";
import { auditFloor, ensureSchema, resetTables } from "./setup";

beforeAll(ensureSchema);
const hash = "a".repeat(64);
async function resetControl() {
  await db.execute(sql`delete from llm_assist_work where task='intro_recheck'`);
  await db.execute(sql`delete from llm_assist_controls where task='intro_recheck'`);
  await db.execute(sql`insert into llm_assist_controls(task) values ('intro_recheck')`);
}
beforeEach(async () => { await resetTables(); await resetControl(); });
afterAll(resetControl);
async function seed(slug = "intro-assist") {
  const [product] = await db.insert(products).values({ slug, name: "Margonem editor", url: `https://${slug}.example/`,
    tagline: "Edit World of Warcraft items", taglineSource: "ai_page", description: "Edit World of Warcraft items", category: "Other",
    source: "crawler", status: "seeded", verifyToken: "v", editTokenHash: "x", searchPageText: "Older excerpt" }).returning();
  await db.execute(sql`update products set updated_at='2026-10-23 01:02:03.123456'::timestamp where id=${product.id}`);
  await db.insert(productIntroChecks).values({ productId: product.id, checkedTagline: product.tagline, outcome: "needs_editor",
    verdict: "wrong", problem: "근거 부족", model: "sonnet", attempts: 2, originalTagline: "Earlier original" });
  await db.execute(sql`update product_intro_checks set updated_at='2026-10-23 01:02:03.234567'::timestamp where product_id=${product.id}`);
  return product;
}
const shadow = () => db.execute(sql`update llm_assist_controls set mode='shadow',revision=2 where task='intro_recheck'`);

describe("소개 보강 명시 요청 원장", () => {
  it("기존 성공 needs_editor는 Sonnet에 다시 선택되지 않지만 별도 plan은 raw revision으로 선택한다", async () => {
    const product = await seed(), [plan] = await planIntroRechecks([product.id, product.id]);
    expect(plan.candidate.snapshot.product.updatedAt).toBe("2026-10-23 01:02:03.123456");
    expect(plan.candidate.snapshot.check.updatedAt).toBe("2026-10-23 01:02:03.234567");
    expect(await pendingIntroChecks(10)).toEqual([]);
    expect(await requestIntroRecheck(plan, "test:operator")).toBe("disabled");
    expect(await db.execute(sql`select id from llm_assist_work`)).toHaveLength(0);
  });
  it("동시 명시 요청도 한 번만 enqueue하며 원 Sonnet 성공행·attempts는 보존한다", async () => {
    const product = await seed(), [plan] = await planIntroRechecks([product.id]);
    const before = await readIntroRecheckSnapshot(product.id);
    await shadow(); const floor = await auditFloor();
    const outcomes = await Promise.all([requestIntroRecheck(plan, "test:operator"), requestIntroRecheck(plan, "test:operator")]);
    expect(outcomes.sort()).toEqual(["duplicate", "queued"]);
    expect(await readIntroRecheckSnapshot(product.id)).toEqual(before);
    expect(await db.execute(sql`select source_hash from llm_assist_work`)).toMatchObject([{ source_hash: plan.sourceHash }]);
    expect(await db.select().from(operationsAudit).where(and(sql`${operationsAudit.id}>${floor}`,
      eq(operationsAudit.action, "product-intro-assist-request")))).toHaveLength(1);
  });
  it("제품 또는 Sonnet check가 1 microsecond만 바뀌어도 오래된 plan은 거절한다", async () => {
    const product = await seed(), [plan] = await planIntroRechecks([product.id]); await shadow();
    await db.execute(sql`update products set updated_at=updated_at + interval '1 microsecond' where id=${product.id}`);
    expect(await requestIntroRecheck(plan, "test:operator")).toBe("stale");
    const [next] = await planIntroRechecks([product.id]);
    await db.execute(sql`update product_intro_checks set updated_at=updated_at + interval '1 microsecond' where product_id=${product.id}`);
    expect(await requestIntroRecheck(next, "test:operator")).toBe("stale");
  });
  it("계획 후 메이커가 등장하거나 사람이 소개를 고치면 enqueue하지 않는다", async () => {
    const product = await seed(), [plan] = await planIntroRechecks([product.id]); await shadow();
    const [user] = await db.insert(publicUsers).values({ displayName: "maker" }).returning();
    await db.insert(productMakerMembers).values({ productId: product.id, userId: user.id, role: "owner", method: "admin" });
    expect(await requestIntroRecheck(plan, "test:operator")).toBe("stale");
    await db.delete(productMakerMembers);
    await db.update(products).set({ taglineSource: "editor", tagline: "A human supplied introduction" }).where(eq(products.id, product.id));
    expect(await requestIntroRecheck(plan, "test:operator")).toBe("stale");
  });
  it("교정 JSON과 사실 결과를 저장해도 별도 settled native 호출이 없으면 제품을 바꾸지 않는다", async () => {
    const product = await seed(), [plan] = await planIntroRechecks([product.id]); await shadow();
    expect(await requestIntroRecheck(plan, "test:operator")).toBe("queued");
    const [work] = await db.execute<{ id: string }>(sql`select id from llm_assist_work`);
    const input = buildIntroAssistInput(plan.candidate, [{ sourceId: "current", kind: "page", url: product.url,
      observedAt: new Date().toISOString(), revision: "fresh", text: "Edit items in the game Margonem", completeness: "complete", httpStatus: 200 }]);
    const factual: AssistOutcome = { schema_version: ASSIST_SCHEMA_VERSION, task: "intro", state: { factual_match: "explicit_mismatch",
      content_kind: "descriptive", author_protection: "server_operator", treatment: "rewrite_candidate" }, evidence_quality: { status: "sufficient", limitations: ["none"] },
      evidence: [{ source_id: "current", quote: "game Margonem", supports: ["/state/factual_match"] }], action: { proposal: "rewrite_candidate", reason_ko: "대상 게임이 다릅니다.", missing_items: [] } };
    const lease = { name: "product-llm-assist-review", token: randomUUID(), requestedVersion: 1 }, token = randomUUID();
    await db.execute(sql`update llm_assist_controls set mode='confirm',confirmation_required=true,dispatch_enabled=true,apply_enabled=true where task='intro_recheck'`);
    await db.execute(sql`insert into jobs(name) values ('product-intro-check') on conflict do nothing`);
    await db.execute(sql`update llm_assist_work set state='claimed',revision=2,claim_token=${token},claim_job=${lease.name},claim_job_token=${lease.token},
      claim_requested_version=1,owner_instance_id='test',owner_boot_id=${randomUUID()},input=${JSON.stringify(input)}::jsonb,input_hash=${assistInputHash(input)} where id=${work.id}`);
    const factualId = randomUUID();
    await db.insert(llmAssistResults).values({ id: factualId, workId: work.id, workRevision: 2, capacityRequestId: randomUUID(), backendId: "m1-qwen",
      modelFamily: "qwen3.8-flash-next", contractHash: hash, inputHash: assistInputHash(input), promptHash: hash, responseHash: hash, outcome: factual });
    const correctionId = randomUUID(), correction: IntroRewriteCandidate = { schema_version: ASSIST_SCHEMA_VERSION, kind: "intro_correction",
      source_hash: introRecheckSourceHash(plan.candidate), input_hash: assistInputHash(input), factual_outcome_hash: assistHash(factual),
      corrected: "Edit items in the game Margonem", reason_ko: "원문에 나온 게임 이름을 사용합니다.", evidence: [{ source_id: "current", quote: "game Margonem" }] };
    await db.transaction(tx => saveIntroCorrection(tx, { id: correctionId, workId: work.id, productId: product.id,
      factualResultId: factualId, capacityRequestId: randomUUID(), requestHash: introCorrectionRequestHash(plan.candidate, input, factual),
      promptHash: introCorrectionPromptHash(), responseHash: hash, contractHash: hash, model: "qwen3.8-flash-next", backendId: "m1-qwen", correction }));
    expect(await db.transaction(tx => applyIntroAssistCorrection(tx, { workId: work.id, revision: 2, claimToken: token, lease },
      plan.candidate, input, factual, correctionId))).toBe(false);
    expect((await db.select().from(products).where(eq(products.id, product.id)))[0].tagline).toBe(product.tagline);
    expect((await db.select().from(productIntroChecks))[0]).toMatchObject({ attempts: 2, model: "sonnet", originalTagline: "Earlier original" });
  });
});
