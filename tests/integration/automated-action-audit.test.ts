import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { assistHash, assistInputHash } from "@/lib/domain/llm-assist/contracts";
import { actionAuditSourceHash, buildBlindedActionAuditInput } from "@/lib/domain/products/automated-action-audit";
import { enqueueFrozenActionAudit, enqueueSemanticActionException, freezeActionAuditPeriod, loadAutomatedDecision,
  readActionAuditProduct, recordActionAuditCompletion } from "@/lib/domain/products/automated-action-audit-repository";
import { alive, at, auditSource, candidate, decision, independentFinding, originalInput, originalWorkSource, periodStart, policy, seed } from "../fixtures/automated-action-audit";
import { ensureSchema, resetTables } from "./setup";

beforeAll(ensureSchema);
beforeEach(async () => {
  await resetTables();
  await db.execute(sql`delete from llm_assist_audit_periods`);
  await db.execute(sql`insert into jobs(name) values ('uptime-ping') on conflict (name) do update set not_before=null`);
  await db.execute(sql`update llm_assist_controls set mode='shadow',dispatch_enabled=true where task in ('semantic_exception','decision_audit')`);
  await db.execute(sql`insert into products(id,slug,url,name,tagline,tagline_source,description,category,status,verify_token,edit_token_hash,updated_at)
    values (1,'example','https://example.com','Example','소개','editor','설명','Other','banned','verify',${"a".repeat(64)},'2026-10-23 09:00:00.123456'::timestamp)`);
});
afterAll(async () => {
  await db.execute(sql`update llm_assist_controls set mode='off',dispatch_enabled=false,apply_enabled=false where task in ('semantic_exception','decision_audit')`);
});
async function seedDecisions() {
  const workId = randomUUID(), inputHash = assistInputHash(originalInput);
  await db.execute(sql`insert into llm_assist_work(id,task,product_id,origin_job,source_hash,source,policy_version,prompt_version,state,input,input_hash)
    values (${workId}::uuid,'uptime',1,'uptime-ping',${assistHash(originalWorkSource)},${JSON.stringify(originalWorkSource)}::jsonb,
      ${originalInput.policyVersion},${originalInput.promptVersion},'done',${JSON.stringify(originalInput)}::jsonb,${inputHash})`);
  const first = decision({ workId }), second = decision({ workId, outcome: alive, applied: false }), third = decision({ workId });
  for (const value of [first, second, third]) await db.execute(sql`insert into llm_assist_results(id,work_id,work_revision,capacity_request_id,
    backend_id,model_family,contract_hash,input_hash,prompt_hash,response_hash,outcome,applied,completed_at)
    values (${value.resultId}::uuid,${workId}::uuid,1,${randomUUID()}::uuid,'gpu-qwen',${value.modelFamily},${assistHash("contract")},
      ${value.inputHash},${assistHash("prompt")},${assistHash(value.outcome)},${JSON.stringify(value.outcome)}::jsonb,${value.applied},${value.decidedAt}::timestamp)`);
  return { first: (await db.transaction(tx => loadAutomatedDecision(tx, first.resultId)))!,
    second: (await db.transaction(tx => loadAutomatedDecision(tx, second.resultId)))!,
    third: (await db.transaction(tx => loadAutomatedDecision(tx, third.resultId)))! };
}
const period = { periodStart, seedHash: assistHash(seed), policy };
describe("주간 표본·예외 원장", () => {
  it("첫 표본 집합을 고정하고 재실행·다른 selectedAt이 중복 작업을 만들지 않는다", async () => {
    const { first, third } = await seedDecisions();
    const one = await db.transaction(tx => freezeActionAuditPeriod(tx, { ...period, selected: [first], skippedUnknownFamily: 2, candidatesClipped: false }));
    const repeated = await db.transaction(tx => freezeActionAuditPeriod(tx, { ...period, selected: [third], skippedUnknownFamily: 0, candidatesClipped: false }));
    expect(repeated.selectedResultIds).toEqual(one.selectedResultIds);
    const product = (await db.transaction(tx => readActionAuditProduct(tx, 1)))!;
    const c = { ...candidate(first), product };
    const initial = await db.transaction(tx => enqueueFrozenActionAudit(tx, c));
    expect(initial?.created).toBe(true);
    const duplicate = await db.transaction(tx => enqueueFrozenActionAudit(tx, { ...c, selectedAt: "2026-10-23T10:00:00Z" }));
    expect(duplicate).toEqual({ workId: initial!.workId, created: false });
    const [count] = await db.execute<{ count: number }>(sql`select count(*)::int as count from llm_assist_work where task='decision_audit'`);
    expect(count.count).toBe(1);
  });
  it("동시 의미 충돌은 주간 1건 한도를 지키고 무추론 대기는 예외 예산을 쓰지 않는다", async () => {
    const { first, second, third } = await seedDecisions();
    const args = { ...period, selectedAt: at.toISOString(), secondResultId: second.resultId };
    expect(await db.transaction(tx => enqueueSemanticActionException(tx, { ...args, firstResultId: first.resultId, reason: "capacity" }))).toBe("not_eligible");
    const results = await Promise.all([first, third].map(row => db.transaction(tx => enqueueSemanticActionException(tx,
      { ...args, firstResultId: row.resultId, reason: "semantic_conflict" }))));
    expect(results.sort()).toEqual(["budget_exhausted", "queued"]);
    const [ledger] = await db.execute<{ count: number }>(sql`select exception_count as count from llm_assist_audit_periods where period_start=${periodStart}::date`);
    expect(ledger.count).toBe(1);
  });
  it("DB도 고정된 표본·예외 quota 감소와 다른 업무의 audit 입력을 거부한다", async () => {
    const { first } = await seedDecisions();
    await db.transaction(tx => freezeActionAuditPeriod(tx, { ...period, selected: [first], skippedUnknownFamily: 0, candidatesClipped: false }));
    await expect(db.execute(sql`update llm_assist_audit_periods set selected_result_ids='[]'::jsonb where period_start=${periodStart}::date`)).rejects.toThrow();
    await expect(db.execute(sql`update llm_assist_audit_periods set max_exceptions=2 where period_start=${periodStart}::date`)).rejects.toThrow();
    const queued = (await db.transaction(tx => enqueueFrozenActionAudit(tx, candidate(first))))!;
    await expect(db.execute(sql`update llm_assist_work set input='{"task":"uptime"}'::jsonb where id=${queued.workId}::uuid`)).rejects.toThrow();
  });
  it("원 업무 pause·제품 raw revision 변경·설정 변경은 새 감사 작업을 막는다", async () => {
    const { first } = await seedDecisions();
    await db.transaction(tx => freezeActionAuditPeriod(tx, { ...period, selected: [first], skippedUnknownFamily: 0, candidatesClipped: false }));
    const c = candidate(first);
    await db.execute(sql`update jobs set not_before=clock_timestamp()+interval '1 hour' where name='uptime-ping'`);
    expect(await db.transaction(tx => enqueueFrozenActionAudit(tx, c))).toBeNull();
    await db.execute(sql`update jobs set not_before=null where name='uptime-ping'`);
    await db.execute(sql`update products set updated_at=updated_at+interval '1 microsecond' where id=1`);
    expect(await db.transaction(tx => enqueueFrozenActionAudit(tx, c))).toBeNull();
    await expect(db.transaction(tx => freezeActionAuditPeriod(tx, { ...period, seedHash: assistHash("changed-seed"),
      selected: [first], skippedUnknownFamily: 0, candidatesClipped: false }))).rejects.toThrow("audit_period_configuration_changed");
  });
  it("같은 TX의 원 result와 묶인 불일치만 한 번 기록하고 제품 상태는 바꾸지 않는다", async () => {
    const { first } = await seedDecisions();
    await db.transaction(tx => freezeActionAuditPeriod(tx, { ...period, selected: [first], skippedUnknownFamily: 0, candidatesClipped: false }));
    const reviewAt = new Date();
    const c = { ...candidate(first), selectedAt: new Date(reviewAt.getTime()-60_000).toISOString(),
      product: (await db.transaction(tx => readActionAuditProduct(tx, 1)))! };
    const queued = (await db.transaction(tx => enqueueFrozenActionAudit(tx, c)))!;
    const input = buildBlindedActionAuditInput(c, [{ ...auditSource, observedAt: reviewAt.toISOString() }],
      { administratorReleased: false, makerProtected: false }, { task: "uptime", requestedUrl: "https://example.com" }, reviewAt);
    const outcome = independentFinding(input), inputHash = assistInputHash(input), resultId = randomUUID(), capacityId = randomUUID();
    const token = randomUUID();
    await db.execute(sql`update llm_assist_work set state='claimed',revision=2,claim_token=${token}::uuid,claim_job='product-llm-assist-review',
      claim_job_token=${randomUUID()}::uuid,claim_requested_version=1,owner_instance_id='audit-test',owner_boot_id=${randomUUID()}::uuid,
      capacity_request_id=${capacityId}::uuid,input=${JSON.stringify(input)}::jsonb,input_hash=${inputHash},source_hash=${actionAuditSourceHash(c)} where id=${queued.workId}::uuid`);
    const stored = await db.transaction(async tx => {
      await tx.execute(sql`insert into llm_assist_results(id,work_id,work_revision,capacity_request_id,backend_id,model_family,
        contract_hash,input_hash,prompt_hash,response_hash,outcome) values (${resultId}::uuid,${queued.workId}::uuid,2,${capacityId}::uuid,'m3-deepseek',
        'deepseek-v4.1-flash-1017',${assistHash("contract")},${inputHash},${assistHash("prompt")},${assistHash(outcome)},${JSON.stringify(outcome)}::jsonb)`);
      return recordActionAuditCompletion(tx, { candidate: c, workId: queued.workId, resultId, input, auditorFamily: "deepseek-v4.1-flash-1017", outcome });
    });
    expect(stored).toMatchObject({ stored: true, comparison: { status: "human_review", authority: "record_only" } });
    expect(await db.transaction(tx => recordActionAuditCompletion(tx, { candidate: c, workId: queued.workId, resultId,
      input, auditorFamily: "deepseek-v4.1-flash-1017", outcome }))).toMatchObject({ stored: false });
    const [product] = await db.execute<{ status: string }>(sql`select status from products where id=1`);
    expect(product.status).toBe("banned");
    const [findings] = await db.execute<{ count: number }>(sql`select count(*)::int as count from llm_assist_audit_findings`);
    expect(findings.count).toBe(1);
  });
});
