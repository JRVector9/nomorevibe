import { randomInt, randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { llmAssistWorks, productRepoReviews, products } from "@/lib/db/schema";
import { completeAssistClaim } from "@/lib/domain/llm-assist/complete";
import { ASSIST_SCHEMA_VERSION, assistHash, assistInputHash, type AssistInput } from "@/lib/domain/llm-assist/contracts";
import { assistPromptHash, ASSIST_PROMPT_VERSION } from "@/lib/domain/llm-assist/prompts";
import type { AssistWorkClaim } from "@/lib/domain/llm-assist/repository";
import { buildRepoMoveInput, repoMoveSource, type RepoMoveCandidate, type RepoMoveOutcome } from "@/lib/domain/products/repo-move-review";
import { readRepoMoveSnapshot } from "@/lib/domain/products/repo-move-snapshots";
import { lockProductRepository } from "@/lib/domain/products/repository-identity";
import { lockProductGeneration } from "@/lib/domain/products/generation";
import { freezeActionAuditPeriod, loadAutomatedDecision, lockActionAuditCandidate, readActionAuditProduct } from "@/lib/domain/products/automated-action-audit-repository";
import type { ActionAuditCandidate, ActionAuditPolicy } from "@/lib/domain/products/automated-action-audit";
import type { LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/llm/gateway-local-end-fetch", () => ({ gatewayFetch: async () => { throw new Error("lock_test_model_transport_forbidden"); } }));

const prefix = `assist-lock-${randomUUID().slice(0, 8)}`, jobName = "product-llm-assist-review", originJob = "uptime-ping";
const jobNames = [jobName, originJob], jobToken = randomUUID();
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const ownedProducts: { id: number; slug: string }[] = [], ownedPeriods: string[] = [];
const pending = new Set<Promise<unknown>>();
const periodSeedHash = assistHash(prefix);
let originalJobs: Record<string, unknown>[] = [], sequence = 0;

function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function tracked<T>(work: Promise<T>): Promise<T> {
  pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
}
async function deadline<T>(work: Promise<T>, label: string, milliseconds = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
async function waitingForAdvisory(blockerPid: number) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    const [row] = await admin`select a.pid from pg_stat_activity a where a.datname=current_database()
      and ${blockerPid}::int=any(pg_blocking_pids(a.pid)) and exists(select 1 from pg_locks l
        where l.pid=a.pid and not l.granted and l.locktype='advisory')`;
    if (row) return Number(row.pid);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("expected_real_advisory_wait");
}
async function product(status: "seeded" | "banned" = "seeded") {
  const slug = `${prefix}-${++sequence}`;
  const [row] = await db.insert(products).values({ slug, name: "Tool", url: `https://${slug}.example/`, repoUrl: `https://github.com/old/${slug}`,
    tagline: "Draw maps", taglineSource: "editor", description: "Tool draws maps.", category: "Dev", status, source: "crawler",
    verifyToken: slug, editTokenHash: "a".repeat(64) }).returning();
  ownedProducts.push({ id: row.id, slug }); return row;
}
const contract: LocalModelServingContract = { version: 1, protocol: "local-openai-chat-v1", backendId: "lock-fixture", provider: "local-direct",
  physicalGroup: "fixture", endpoint: "http://127.0.0.1:1/v1/chat/completions", model: "qwen3.8-flash-next", responseModel: "qwen3.8-flash-next",
  modelFamily: "qwen3.8-flash-next", deploymentRevision: "lock-fixture", contextWindowTokens: 32000, totalTokenBound: 32000,
  maxOutputTokens: 1024, maxInputBytes: 100000, capabilities: { vision: false, jsonSchema: true },
  thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" }, termination: { kind: "response_only" } };

beforeAll(async () => {
  ensureSchema();
  originalJobs = Array.from(await admin`select to_jsonb(j) row from jobs j where name=any(${jobNames}::varchar[])`).map(row => row.row);
  for (const name of jobNames) await admin`insert into jobs(name,lease_token,locked_at) values(${name},${jobToken},clock_timestamp())
    on conflict(name) do update set lease_token=excluded.lease_token,locked_at=excluded.locked_at,not_before=null`;
});
afterEach(async () => {
  await Promise.allSettled([...pending]);
  for (const row of ownedProducts.splice(0)) await admin`delete from products where id=${row.id} and slug=${row.slug}`;
  for (const period of ownedPeriods.splice(0)) await admin`delete from llm_assist_audit_periods where period_start=${period}::date and seed_hash=${periodSeedHash}`;
});
afterAll(async () => {
  for (const name of jobNames) {
    const original = originalJobs.find(row => row.name === name);
    if (original) await admin`update jobs j set lease_token=r.lease_token,locked_at=r.locked_at,not_before=r.not_before,updated_at=r.updated_at
      from jsonb_populate_record(null::jobs,${JSON.stringify(original)}::text::jsonb) r where j.name=${name}`;
    else await admin`delete from jobs where name=${name} and lease_token=${jobToken}`;
  }
  expect(Array.from(await admin`select to_jsonb(j) row from jobs j where name=any(${jobNames}::varchar[]) order by name`).map(row => row.row))
    .toEqual(originalJobs.sort((a, b) => String(a.name).localeCompare(String(b.name))));
  await admin.end({ timeout: 5 });
});

async function repoClaim() {
  const p = await product();
  await db.insert(productRepoReviews).values({ productId: p.id, decision: "human", reason: "repo_moved" });
  const snapshot = (await readRepoMoveSnapshot(p.id))!, destination = `https://github.com/new/${p.slug}`;
  const candidate: RepoMoveCandidate = { kind: "repo_move", snapshot, oldRepository: { state: "moved", to: `new/${p.slug}` },
    candidates: [{ url: destination, check: { state: "alive" } }], uncheckedRepositoryUrls: [], page: null };
  const readme = repoMoveSource("candidate_readme_0", "readme", destination, "Tool draws maps. Original Tool repository.", new Date().toISOString(), "complete", 200);
  const input = buildRepoMoveInput(candidate, [readme]);
  const outcome: RepoMoveOutcome = { schema_version: ASSIST_SCHEMA_VERSION, task: "repo", evidence_quality: { status: "sufficient", limitations: ["none"] },
    state: { project_identity: "matches", code_lineage: "original", official_continuity: "explicit_move", relationship: "same_project" },
    evidence: [{ source_id: readme.sourceId, quote: readme.text, supports: ["/state/project_identity", "/state/code_lineage"] },
      { source_id: "old_repository", quote: input.sources[0].text, supports: ["/state/official_continuity"] }],
    action: { proposal: "update_repo_candidate", reason_ko: "공식 이전 근거를 확인했습니다.", missing_items: [] } };
  const [work] = await db.insert(llmAssistWorks).values({ id: randomUUID(), task: "repo_move", productId: p.id, originJob: "product-repo-review",
    source: candidate, sourceHash: assistHash(candidate), policyVersion: input.policyVersion, promptVersion: input.promptVersion }).returning();
  const claim: AssistWorkClaim = { work, token: randomUUID(), owner: { instanceId: prefix, bootId: randomUUID() },
    lease: { name: jobName, token: jobToken, requestedVersion: 0 } };
  return { p, destination, input, outcome, claim };
}

async function originalDecision() {
  const p = await product("banned");
  const [raw] = await admin`select updated_at::text as revision from products where id=${p.id}`;
  const revision = String(raw.revision), observedAt = new Date().toISOString();
  const input: AssistInput = { schemaVersion: ASSIST_SCHEMA_VERSION, task: "uptime", subject: { type: "product", id: p.id, revision },
    policyVersion: "uptime-lock-fixture", promptVersion: ASSIST_PROMPT_VERSION,
    sources: [{ sourceId: "current-page", kind: "page", url: p.url, observedAt, revision: "fixture", text: "The service is permanently closed.", completeness: "complete", httpStatus: 200 }],
    context: { requestedUrl: p.url, finalUrl: p.url, failureCount: 10, requiredFailures: 10, administratorReleased: false } };
  const source = { kind: "uptime" as const, product: { id: p.id, slug: p.slug, url: p.url, updatedAt: revision },
    health: { failures: 10, status: 404, checkedAt: revision, downSince: revision } };
  const outcome = { schema_version: ASSIST_SCHEMA_VERSION, task: "uptime", state: { page_state: "closed", finding: "explicit_shutdown" },
    evidence_quality: { status: "sufficient", limitations: ["none"] }, evidence: [{ source_id: "current-page", quote: "permanently closed", supports: ["/state/page_state"] }],
    action: { proposal: "delist_candidate", reason_ko: "종료가 명시되어 있습니다.", missing_items: [] } };
  const workId = randomUUID(), resultId = randomUUID();
  await db.insert(llmAssistWorks).values({ id: workId, task: "uptime", productId: p.id, originJob, source, sourceHash: assistHash(source),
    policyVersion: input.policyVersion, promptVersion: input.promptVersion, state: "done", input, inputHash: assistInputHash(input) });
  await admin`insert into llm_assist_results(id,work_id,work_revision,capacity_request_id,backend_id,model_family,contract_hash,input_hash,prompt_hash,response_hash,input,outcome,applied)
    values(${resultId}::uuid,${workId}::uuid,1,${randomUUID()}::uuid,'fixture','qwen3.8-flash-next',${assistHash("contract")},${assistInputHash(input)},
      ${assistPromptHash("uptime")},${assistHash(outcome)},${JSON.stringify(input)}::text::jsonb,${JSON.stringify(outcome)}::text::jsonb,true)`;
  const decision = (await db.transaction(tx => loadAutomatedDecision(tx, resultId)))!;
  expect(decision).not.toBeNull(); return { p, decision };
}

describe("공통 보강의 실제 DB 잠금 순서", () => {
  it("저장소 완료는 canonical repo를 기다리는 동안 제품 세대를 먼저 잡지 않는다", async () => {
    const prepared = await repoClaim(), held = latch<number>(), proceed = latch<void>();
    const writer = tracked(db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout='1200ms'`);
      await lockProductRepository(tx, prepared.destination);
      const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() pid`); held.resolve(row.pid);
      await proceed.promise;
      expect(await lockProductGeneration(tx, prepared.p.id, prepared.p.slug)).toBe(true);
      await tx.execute(sql`update products set name=name where id=${prepared.p.id}`);
      return "writer_committed";
    }));
    let completion: Promise<unknown> | undefined;
    try {
      const writerPid = await deadline(held.promise, "writer_repo_lock_missing");
      completion = tracked(completeAssistClaim(prepared.claim, prepared.input, prepared.outcome, contract, assistHash("unused-response")));
      expect(await waitingForAdvisory(writerPid)).toBeGreaterThan(0);
      proceed.resolve(undefined);
      expect(await deadline(writer, "writer_blocked_by_completion")).toBe("writer_committed");
      // No claimed work/native proof was created: this test grants no model or product-write authority.
      expect(await deadline(completion, "completion_did_not_drain")).toEqual({ recorded: false, applied: false });
    } finally { proceed.resolve(undefined); await Promise.allSettled([writer, ...(completion ? [completion] : [])]); }
  });

  it("감사 producer의 초기 원 결정·제품 조회는 lifecycle을 기다릴 때 행 잠금을 유지하지 않는다", async () => {
    const prepared = await originalDecision(), read = latch<ActionAuditCandidate>(), startProof = latch<void>(), held = latch<number>(), proceed = latch<void>();
    const producer = tracked(db.transaction(async tx => {
      const decision = (await loadAutomatedDecision(tx, prepared.decision.resultId))!, current = (await readActionAuditProduct(tx, prepared.p.id))!;
      const c: ActionAuditCandidate = { kind: "decision_audit", product: current, decision, periodStart: "2460-01-05",
        selectedAt: new Date().toISOString(), seedHash: periodSeedHash, conflict: null };
      read.resolve(c); await startProof.promise;
      return lockActionAuditCandidate(tx, c);
    }));
    let writer: Promise<unknown> | undefined;
    try {
      await deadline(read.promise, "initial_audit_read_blocked");
      writer = tracked(db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout='1200ms'`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`product-lifecycle:${prepared.p.slug}`}))`);
        const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() pid`); held.resolve(row.pid);
        await proceed.promise;
        expect(await lockProductGeneration(tx, prepared.p.id, prepared.p.slug)).toBe(true);
        await tx.execute(sql`update products set name=name where id=${prepared.p.id}`);
        // 소개 완료 writer도 product 다음 원 work를 갱신한다. 초기 결정 조회의 SHARE가 남아도 막힌다.
        await tx.execute(sql`update llm_assist_work set updated_at=updated_at where id=${prepared.decision.workId}::uuid`);
        return "writer_committed";
      }));
      const writerPid = await deadline(held.promise, "writer_lifecycle_lock_missing"); startProof.resolve(undefined);
      expect(await waitingForAdvisory(writerPid)).toBeGreaterThan(0); proceed.resolve(undefined);
      expect(await deadline(writer, "writer_blocked_by_initial_audit_read")).toBe("writer_committed");
      expect(await deadline(producer, "audit_proof_did_not_drain")).toBe(true);
    } finally { startProof.resolve(undefined); proceed.resolve(undefined); await Promise.allSettled([producer, ...(writer ? [writer] : [])]); }
  });

  it("주간 기간의 non-key 갱신 잠금은 완료 기록의 외래키 확인을 막지 않는다", async () => {
    const prepared = await originalDecision(), held = latch<void>(), release = latch<void>();
    let periodStart = "";
    for (;;) {
      const monday = new Date(Date.UTC(2400 + randomInt(4000), 0, 8)); monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
      const value = monday.toISOString().slice(0, 10);
      if (!(await admin`select period_start from llm_assist_audit_periods where period_start=${value}::date`).length) { periodStart = value; break; }
    }
    const policy: ActionAuditPolicy = { enabled: true, lookbackDays: 7, perStratum: 1, maxAuditsPerWeek: 10, maxExceptionsPerWeek: 1, maxCandidates: 10 };
    const args = { periodStart, seedHash: periodSeedHash, policy, selected: [prepared.decision], skippedUnknownFamily: 0, candidatesClipped: false };
    await db.transaction(tx => freezeActionAuditPeriod(tx, args)); ownedPeriods.push(periodStart);
    const producer = tracked(db.transaction(async tx => { await freezeActionAuditPeriod(tx, args); held.resolve(undefined); await release.promise; }));
    try {
      await deadline(held.promise, "period_update_lock_missing");
      // This fixture exercises only the FK lock. It bypasses native completion APIs and is rolled back.
      await expect(db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout='1200ms'`);
        await tx.execute(sql`insert into llm_assist_audit_findings(audit_result_id,original_result_id,work_id,period_start,subject,
          original_model_family,auditor_model_family,decision_at,audited_at,decision_source_hash,current_input_hash,comparison)
          values(${prepared.decision.resultId}::uuid,${prepared.decision.resultId}::uuid,${prepared.decision.workId}::uuid,${periodStart}::date,'uptime',
            'qwen3.8-flash-next','deepseek-v4.1-flash-1017',clock_timestamp(),clock_timestamp(),${prepared.decision.sourceHash},${prepared.decision.inputHash},
            '{"authority":"record_only","interpretation":"current_evidence_comparison","status":"agree"}'::jsonb)`);
        throw new Error("fixture_fk_insert_rolled_back");
      })).rejects.toThrow("fixture_fk_insert_rolled_back");
      expect(await admin`select audit_result_id from llm_assist_audit_findings where audit_result_id=${prepared.decision.resultId}::uuid`).toHaveLength(0);
    } finally { release.resolve(undefined); await Promise.allSettled([producer]); }
  });
});
