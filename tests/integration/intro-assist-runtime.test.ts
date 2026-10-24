import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { llmAssistResults, productIntroChecks, products } from "@/lib/db/schema";
import { introAssistCorrections } from "@/lib/db/intro-assist-schema";
import { ASSIST_SCHEMA_VERSION, assistHash, assistInputHash, type AssistOutcome } from "@/lib/domain/llm-assist/contracts";
import { assistPromptHash } from "@/lib/domain/llm-assist/prompts";
import { buildIntroAssistInput, introRecheckSourceHash } from "@/lib/domain/products/intro-assist";
import { planIntroRechecks, requestIntroRecheck } from "@/lib/domain/products/intro-assist-repository";
import { completeIntroCorrectionStage, introCorrectionCapacityInput, proveIntroCorrectionDomain, runIntroCorrectionStage } from "@/lib/domain/products/intro-assist-runtime";
import type { LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import type { RoleLease } from "@/lib/jobs/role-leader";
import { ensureSchema, resetTables } from "./setup";

beforeAll(ensureSchema);
const ownedProducts: number[] = [];
async function resetControl() {
  await db.execute(sql`delete from llm_assist_work where task='intro_recheck'`);
  await db.execute(sql`delete from llm_assist_controls where task='intro_recheck'`);
  await db.execute(sql`insert into llm_assist_controls(task) values ('intro_recheck')`);
}
beforeEach(async () => { await resetTables(); await resetControl(); });
afterAll(async () => {
  for (const id of ownedProducts) await db.delete(products).where(eq(products.id, id));
  await resetControl();
});
const hash = "a".repeat(64);
const contract: LocalModelServingContract = { version: 1, protocol: "local-openai-chat-v1", backendId: "fixture-m1-qwen", provider: "local-direct",
  physicalGroup: "m1", endpoint: "http://127.0.0.1:8080/v1/chat/completions", model: "qwen3.8-flash-next", responseModel: "qwen3.8-flash-next",
  modelFamily: "qwen3.8-flash-next", deploymentRevision: "fixture-q4", contextWindowTokens: 64000, totalTokenBound: 64000,
  maxOutputTokens: 2048, maxInputBytes: 100000, capabilities: { vision: true, jsonSchema: true },
  thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" }, termination: { kind: "response_only" } };
async function fixture() {
  const [product] = await db.insert(products).values({ slug: "intro-runtime", name: "Margonem editor", url: "https://intro-runtime.example/",
    tagline: "Edit World of Warcraft items", taglineSource: "ai_page", description: "Edit World of Warcraft items", category: "Other",
    source: "crawler", status: "seeded", verifyToken: "v", editTokenHash: "x" }).returning();
  ownedProducts.push(product.id);
  await db.insert(productIntroChecks).values({ productId: product.id, checkedTagline: product.tagline, outcome: "needs_editor", verdict: "wrong",
    problem: "근거 부족", model: "sonnet", attempts: 2, originalTagline: "Earlier original" });
  const [plan] = await planIntroRechecks([product.id]);
  await db.execute(sql`update llm_assist_controls set mode='confirm',confirmation_required=true,dispatch_enabled=true,apply_enabled=true,revision=2 where task='intro_recheck'`);
  expect(await requestIntroRecheck(plan, "test:runtime")).toBe("queued");
  const [work] = await db.execute<{ id: string }>(sql`select id from llm_assist_work where product_id=${product.id}`);
  const lease = { name: "product-llm-assist-review", token: randomUUID(), requestedVersion: 1 }, claimToken = randomUUID();
  const role: RoleLease = { role: "reviewer", instanceId: "intro-runtime-test", bootId: randomUUID(), release: "test", epoch: 1, kind: "primary" };
  await db.execute(sql`insert into jobs(name,lease_token,locked_at) values(${lease.name},${lease.token},clock_timestamp())
    on conflict(name) do update set lease_token=excluded.lease_token,locked_at=excluded.locked_at,not_before=null`);
  await db.execute(sql`insert into jobs(name) values('product-intro-check') on conflict(name) do update set not_before=null`);
  const input = buildIntroAssistInput(plan.candidate, [{ sourceId: "current", kind: "page", url: product.url, observedAt: new Date().toISOString(),
    revision: "fresh", text: "Edit items in the game Margonem", completeness: "complete", httpStatus: 200 }]);
  const factual: AssistOutcome = { schema_version: ASSIST_SCHEMA_VERSION, task: "intro", state: { factual_match: "explicit_mismatch",
    content_kind: "descriptive", author_protection: "server_operator", treatment: "rewrite_candidate" }, evidence_quality: { status: "sufficient", limitations: ["none"] },
    evidence: [{ source_id: "current", quote: "game Margonem", supports: ["/state/factual_match"] }],
    action: { proposal: "rewrite_candidate", reason_ko: "대상 게임이 다릅니다.", missing_items: [] } };
  const factualResultId = randomUUID(), factualRequestId = randomUUID();
  await db.execute(sql`update llm_assist_work set state='claimed',revision=2,claim_token=${claimToken},claim_job=${lease.name},claim_job_token=${lease.token},
    claim_requested_version=1,owner_instance_id=${role.instanceId},owner_boot_id=${role.bootId},backend_id=${contract.backendId},
    input=${JSON.stringify(input)}::jsonb,input_hash=${assistInputHash(input)},capacity_request_id=${factualRequestId} where id=${work.id}`);
  await db.insert(llmAssistResults).values({ id: factualResultId, workId: work.id, workRevision: 2, capacityRequestId: factualRequestId,
    backendId: contract.backendId, modelFamily: contract.modelFamily, contractHash: hash, inputHash: assistInputHash(input), input,
    promptHash: assistPromptHash("intro"), responseHash: hash, outcome: factual });
  const correction = { schema_version: ASSIST_SCHEMA_VERSION, kind: "intro_correction", source_hash: introRecheckSourceHash(plan.candidate),
    input_hash: assistInputHash(input), factual_outcome_hash: assistHash(factual), corrected: "Edit items in the game Margonem",
    reason_ko: "원문에 나온 대상 게임을 사용합니다.", evidence: [{ source_id: "current", quote: "game Margonem" }] };
  return { product, candidate: plan.candidate, input, factual, factualResultId, workId: work.id, role, lease, claimToken, correction };
}

describe("소개 교정 runtime의 실제 native 증명 요구", () => {
  it("사실 결과 행이 있어도 원 native 호출의 settled 원장이 없으면 두번째 dispatch를 증명하지 않는다", async () => {
    const f = await fixture(), envelope = introCorrectionCapacityInput(f.candidate, f.input, f.factualResultId, f.factual);
    const proved = await db.transaction(tx => proveIntroCorrectionDomain(tx, { workId: f.workId, workRevision: 2, claimToken: f.claimToken,
      task: "intro_recheck", subjectId: f.product.id, backendId: contract.backendId }, envelope, f.lease, f.role));
    expect(proved).toBe(false);
    expect((await db.select().from(productIntroChecks))[0]).toMatchObject({ model: "sonnet", attempts: 2, originalTagline: "Earlier original" });
  });
  it("실행 callback이 정상 교정 JSON을 반환해도 실제 별도 native 원장 없이 후보를 저장하거나 적용하지 않는다", async () => {
    const f = await fixture();
    const generated = await runIntroCorrectionStage({ candidate: f.candidate, input: f.input, factualResultId: f.factualResultId,
      factual: f.factual, workId: f.workId, contract }, async () => ({ capacityRequestId: randomUUID(), response: new Response(JSON.stringify({
        model: contract.model, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(f.correction) } }] })) }));
    expect(generated.ok).toBe(true);
    if (!generated.ok) throw new Error(generated.error);
    expect(await db.transaction(tx => completeIntroCorrectionStage(tx, { workId: f.workId, revision: 2, claimToken: f.claimToken, lease: f.lease },
      f.candidate, f.input, f.factual, generated))).toEqual({ recorded: false, applied: false, correctionId: null });
    expect(await db.select().from(introAssistCorrections)).toHaveLength(0);
    expect((await db.select().from(products).where(eq(products.id, f.product.id)))[0].tagline).toBe(f.product.tagline);
    expect((await db.select().from(productIntroChecks))[0].attempts).toBe(2);
  });
});
