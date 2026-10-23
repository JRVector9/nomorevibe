import http from "node:http";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const { fetchCapped, nativeGuard } = vi.hoisted(() => ({ fetchCapped: vi.fn(), nativeGuard: { origin: "" } }));
vi.mock("@/lib/net/fetch", async original => ({ ...await original<typeof import("@/lib/net/fetch")>(), fetchCapped }));
vi.mock("@/lib/llm/gateway-local-end-fetch", async original => {
  const actual = await original<typeof import("@/lib/llm/gateway-local-end-fetch")>();
  return { ...actual, gatewayFetch: (...args: Parameters<typeof actual.gatewayFetch>) => {
    const target = args[1], url = typeof target === "string" ? target : "href" in target ? target.href : target.url;
    if (!nativeGuard.origin || new URL(url).origin !== nativeGuard.origin) throw new Error("fixture_external_model_request_refused");
    return actual.gatewayFetch(...args);
  } };
});
import { db } from "@/lib/db";
import { llmAssistResults, llmAssistWorks, productEvidenceAudit, products } from "@/lib/db/schema";
import { reviewLlmAssist } from "@/lib/jobs/products/llm-assist-review";
import { assistHash, ASSIST_SCHEMA_VERSION, type AssistSource } from "@/lib/domain/llm-assist/contracts";
import { repoMoveSource, type RepoMoveCandidate } from "@/lib/domain/products/repo-move-review";
import { readRepoMoveSnapshot } from "@/lib/domain/products/repo-move-snapshots";
import { ASSIST_POLICY_VERSION } from "@/lib/domain/llm-assist/contracts";
import { ASSIST_PROMPT_VERSION } from "@/lib/domain/llm-assist/prompts";
import { localModelContractHash, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import type { JobContext } from "@/lib/jobs/runner";
import type { CappedFetchResult } from "@/lib/net/fetch";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const prefix = `repo-native-${randomUUID().slice(0, 8)}`, backendId = "fixture-repo-qwen", model = "qwen3.8-flash-next";
const jobName = "product-llm-assist-review", originJob = "product-repo-review", jobNames = [jobName, originJob];
const owner = { instanceId: prefix, bootId: randomUUID() };
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const server = http.createServer();
const owned: { id: number; slug: string; url: string; candidate: RepoMoveCandidate }[] = [];
const ownedUsers: number[] = [];
let contract: LocalModelServingContract, policy: ModelCapacityPolicy, jobToken = "", serial = 0;
let originalCapacity: Record<string, unknown>, originalAssist: Record<string, unknown>, originalRole: Record<string, unknown> | null;
let originalJobs: Record<string, unknown>[], calls: { requestId: string; body: Record<string, unknown> }[] = [];
let mode: "official" | "unrelated" | "fork" = "official", pageText = "Tool draws maps.", onCall: (() => Promise<void>) | null = null;
const ok = (url: string, text: string): CappedFetchResult => ({ ok: true, status: 200, finalUrl: url, body: Buffer.from(text), headers: new Headers() });
const nativeOutcome = (sources: AssistSource[]) => {
  const unrelated = mode === "unrelated", readme = sources.find(source => source.sourceId === "candidate_readme_0")!;
  const official = sources.find(source => source.sourceId === "old_repository")!;
  return { schema_version: ASSIST_SCHEMA_VERSION, task: "repo", evidence_quality: { status: "sufficient", limitations: ["none"] },
    state: { project_identity: unrelated ? "different" : "matches", code_lineage: unrelated ? "independent" : mode === "fork" ? "fork_or_copy" : "original",
      official_continuity: unrelated ? "unverified" : "explicit_move", relationship: unrelated ? "unrelated" : "same_project" },
    evidence: [{ source_id: readme.sourceId, quote: readme.text, supports: ["/state/project_identity", "/state/code_lineage"] },
      ...(!unrelated ? [{ source_id: official.sourceId, quote: official.text, supports: ["/state/official_continuity"] }] : [])],
    action: { proposal: unrelated ? "delist_candidate" : "update_repo_candidate", reason_ko: "현재 저장소 근거를 대조했습니다.", missing_items: [] } };
};
async function fixtureProduct() {
  const slug = `${prefix}-${++serial}`;
  const [row] = await admin`INSERT INTO products(slug,url,repo_url,name,tagline,description,category,status,source,verify_token,edit_token_hash,
      repo_status,repo_checked_at,repo_missing_since,repo_renamed_to,updated_at)
    VALUES(${slug},${`https://${slug}.example/`},${`https://github.com/old/${slug}`},'Tool','Draw maps','Tool draws maps.','Dev','seeded','crawler',
      'fixture',${"a".repeat(64)},'not_found',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '3 days',${`new/${slug}`},clock_timestamp()-interval '7 days')
    RETURNING id,slug,url`;
  const id = Number(row.id), url = String(row.url);
  await admin`INSERT INTO product_repo_reviews(product_id,decision,reason,next_review_at) VALUES(${id},'human','repo_moved',clock_timestamp()-interval '1 minute')`;
  const snapshot = await readRepoMoveSnapshot(id);
  if (!snapshot) throw new Error("fixture_snapshot_missing");
  const candidate: RepoMoveCandidate = { kind: "repo_move", snapshot, oldRepository: mode === "official" ? { state: "moved", to: `new/${slug}` } : { state: "gone" },
    page: repoMoveSource("product_page", "page", url, "Producer page from an older collection.", "2026-10-22T00:00:00Z", "complete", 200),
    candidates: [{ url: `https://github.com/new/${slug}`, check: { state: "alive" } }], uncheckedRepositoryUrls: [] };
  owned.push({ id, slug, url, candidate });
  await admin`INSERT INTO llm_assist_work(id,task,product_id,origin_job,source_hash,source,policy_version,prompt_version,control_revision)
    VALUES(${randomUUID()},'repo_move',${id},${originJob},${assistHash(candidate)},${JSON.stringify(candidate)}::text::jsonb,
      ${ASSIST_POLICY_VERSION},${ASSIST_PROMPT_VERSION},2)`;
  return owned[owned.length - 1];
}
const context = (): JobContext<null> => ({ cursor: null, lease: { name: jobName, token: jobToken, requestedVersion: 0 }, save: async () => {}, hasBudget: () => true, log: () => {} });
const current = async (id: number) => (await db.select().from(products).where(eq(products.id, id)))[0];
const work = async (id: number) => (await db.select().from(llmAssistWorks).where(eq(llmAssistWorks.productId, id)))[0];
const requests = async () => Array.from(await admin`SELECT * FROM model_capacity_requests WHERE owner_instance_id=${prefix}`);
async function results(id: number) { const item = await work(id); return db.select().from(llmAssistResults).where(eq(llmAssistResults.workId, item.id)); }
async function cleanFixture() {
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const ids = (await tx`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${prefix} FOR UPDATE`).map(row => row.request_id);
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events WHERE request_id=ANY(${ids}::uuid[])`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
    expect((await tx`SELECT tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass AND tgname='model_capacity_events_no_change'`)[0]?.tgenabled).toBe("A");
  });
  for (const product of owned.splice(0)) {
    await admin`DELETE FROM products WHERE id=${product.id} AND slug=${product.slug}`;
    await admin`DELETE FROM product_health WHERE slug=${product.slug}`;
    await admin`DELETE FROM product_evidence_audit WHERE slug=${product.slug}`;
    await admin`DELETE FROM cdn_purges WHERE slug=${product.slug}`;
  }
  for (const id of ownedUsers.splice(0)) await admin`DELETE FROM public_users WHERE id=${id} AND display_name=${prefix}`;
}
async function restore() {
  await admin`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
    FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalCapacity)}::text::jsonb) r WHERE c.id=r.id`;
  expect(await admin`SELECT id FROM llm_assist_work WHERE task='repo_move'`).toHaveLength(0);
  await admin`DELETE FROM llm_assist_controls WHERE task='repo_move'`;
  await admin`INSERT INTO llm_assist_controls SELECT * FROM jsonb_populate_record(NULL::llm_assist_controls,${JSON.stringify(originalAssist)}::text::jsonb)`;
  await admin`DELETE FROM jobs WHERE name=ANY(${jobNames})`;
  if (originalJobs.length) await admin`INSERT INTO jobs SELECT * FROM jsonb_populate_recordset(NULL::jobs,${JSON.stringify(originalJobs)}::text::jsonb)`;
  await admin`DELETE FROM role_leases WHERE role='reviewer' AND owner_instance_id=${prefix}`;
  if (originalRole) await admin`INSERT INTO role_leases SELECT * FROM jsonb_populate_record(NULL::role_leases,${JSON.stringify(originalRole)}::text::jsonb)`;
}
beforeAll(async () => {
  ensureSchema();
  originalCapacity = (await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`)[0].row;
  originalAssist = (await admin`SELECT to_jsonb(c) AS row FROM llm_assist_controls c WHERE task='repo_move'`)[0].row;
  originalRole = (await admin`SELECT to_jsonb(c) AS row FROM role_leases c WHERE role='reviewer'`)[0]?.row ?? null;
  originalJobs = (await admin`SELECT to_jsonb(c) AS row FROM jobs c WHERE name=ANY(${jobNames})`).map(row => row.row);
  expect(await admin`SELECT id FROM llm_assist_work WHERE task='repo_move'`).toHaveLength(0);
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched','indeterminate')`).toHaveLength(0);
  server.on("request", async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      calls.push({ requestId: String(req.headers["x-nmv-relay-request-id"] ?? ""), body });
      const messages = body.messages as { content: string }[];
      const sources = JSON.parse(messages[1].content.split("[비신뢰 근거]\n")[1]) as AssistSource[];
      await onCall?.();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(nativeOutcome(sources)) } }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
    } catch { res.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_server_missing");
  nativeGuard.origin = `http://127.0.0.1:${address.port}`;
  contract = { version: 1, protocol: "local-openai-chat-v1", backendId, provider: "local-direct", physicalGroup: "fixture-repo-gpu",
    endpoint: `${nativeGuard.origin}/v1/chat/completions`, model, responseModel: model, modelFamily: model, deploymentRevision: "fixture-repo-1",
    contextWindowTokens: 50000, totalTokenBound: 50000, maxOutputTokens: 2048, maxInputBytes: 100000,
    capabilities: { vision: false, jsonSchema: true }, thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" }, termination: { kind: "response_only" } };
  policy = { version: 1, globalLimit: 1, providerLimits: { [backendId]: 1 }, groupLimits: { "fixture-repo-gpu": 1 }, poolLimits: { reviewer: 1, text: 1 },
    weights: { first: 2, second: 2, background: 1 }, maxWaiting: 8, queueTtlMs: 60000, reservationTtlMs: 60000,
    routes: [{ routeId: `local-assist-repo_move-${backendId}`, provider: "local-direct", model, providerBudgetId: backendId, groupId: "fixture-repo-gpu" }] };
});
beforeEach(async () => {
  calls = []; mode = "official"; pageText = "Tool draws maps."; onCall = null; jobToken = randomUUID();
  for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: "reviewer", ROLE_LEASE_INSTANCE_ID: prefix, ROLE_LEASE_BOOT_ID: owner.bootId,
    ROLE_LEASE_RELEASE: prefix, ROLE_LEASE_EPOCH: "1", LOCAL_MODEL_SERVING_CONTRACTS: JSON.stringify([contract]),
    LOCAL_MODEL_VERIFIED_CONTRACT_HASHES: JSON.stringify({ [backendId]: localModelContractHash(contract) }),
    LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify({ "fixture-repo-gpu": 1 }), LLM_ASSIST_API_KEYS: JSON.stringify({ [backendId]: "fixture-key" }),
    LLM_ASSIST_BACKENDS: JSON.stringify([{ backendId, tasks: ["repo_move"], maxClaims: 1 }]) })) vi.stubEnv(key, value);
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},cursor=0 WHERE id=1`;
  await admin`UPDATE llm_assist_controls SET mode='confirm',confirmation_required=true,dispatch_enabled=true,apply_enabled=true,revision=2 WHERE task='repo_move'`;
  await admin`INSERT INTO role_leases(role,owner_instance_id,owner_boot_id,owner_release,owner_kind,epoch,lease_until)
    VALUES('reviewer',${prefix},${owner.bootId},${prefix},'primary',1,clock_timestamp()+interval '1 hour')
    ON CONFLICT(role) DO UPDATE SET owner_instance_id=excluded.owner_instance_id,owner_boot_id=excluded.owner_boot_id,
      owner_release=excluded.owner_release,owner_kind=excluded.owner_kind,epoch=1,lease_until=excluded.lease_until`;
  for (const name of jobNames) await admin`INSERT INTO jobs(name,lease_token,locked_at) VALUES(${name},${name===jobName ? jobToken : null},${name===jobName ? new Date() : null})
    ON CONFLICT(name) DO UPDATE SET lease_token=excluded.lease_token,locked_at=excluded.locked_at,not_before=NULL`;
  fetchCapped.mockReset().mockImplementation(async (url: string) => {
    const product = owned.find(item => item.url === url || url.includes(item.slug));
    if (!product) throw new Error("fixture_external_evidence_request_refused");
    if (url === product.url) return ok(url, `<h1>${pageText}</h1>`);
    const readme = mode === "unrelated" ? "Unrelated monitoring SDK." : mode === "fork" ? "Tool fork copied from another author." : "Tool draws maps. Original Tool repository.";
    if (url.startsWith("https://raw.githubusercontent.com/")) return ok(url, readme);
    if (url === product.candidate.snapshot.repoUrl) return mode === "official" ? ok(product.candidate.candidates[0].url, "Tool repository") : { ok: false, reason: "http", status: 404 };
    if (url === product.candidate.candidates[0].url) return ok(url, readme);
    throw new Error("fixture_external_evidence_request_refused");
  });
});
afterEach(async () => { server.closeAllConnections(); try { await cleanFixture(); await restore(); } finally { vi.unstubAllEnvs(); } });
afterAll(async () => {
  try {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); nativeGuard.origin = "";
    expect((await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`)[0]?.row).toEqual(originalCapacity);
    expect((await admin`SELECT to_jsonb(c) AS row FROM llm_assist_controls c WHERE task='repo_move'`)[0]?.row).toEqual(originalAssist);
    expect((await admin`SELECT to_jsonb(c) AS row FROM role_leases c WHERE role='reviewer'`)[0]?.row ?? null).toEqual(originalRole);
    const restoredJobs = (await admin`SELECT to_jsonb(c) AS row FROM jobs c WHERE name=ANY(${jobNames})`).map(row => row.row);
    expect(restoredJobs).toHaveLength(originalJobs.length);
    expect(restoredJobs).toEqual(expect.arrayContaining(originalJobs));
    expect(await requests()).toHaveLength(0);
  } finally { await admin.end(); }
});
describe("저장소 이전 공통 소비자 native 실행", () => {
  it("공식 GitHub redirect만 native 정산·결과·주소 CAS·감사와 원자 적용한다", async () => {
    const product = await fixtureProduct();
    const sourceHash = assistHash(product.candidate);
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(1);
    const [request] = await requests();
    expect(request).toMatchObject({ state: "settled", logical_work_key: `direct:assist:${product.id}:repo_move` });
    expect(calls[0].requestId).toBe(request.request_id);
    expect((await current(product.id)).repoUrl).toBe(product.candidate.candidates[0].url);
    expect((await current(product.id)).repoLinkVersion).toBe(product.candidate.snapshot.repoLinkVersion + 1);
    expect(await results(product.id)).toMatchObject([{ applied: true, capacityRequestId: request.request_id }]);
    expect(await work(product.id)).toMatchObject({ state: "done", attempts: 1 });
    expect(await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, product.slug))).toMatchObject([{ action: "product.repository.move" }]);
    const modelSources = JSON.parse((calls[0].body.messages as { content: string }[])[1].content.split("[비신뢰 근거]\n")[1]) as AssistSource[];
    expect(modelSources.find(source => source.sourceId === "product_page")?.text).toBe("Tool draws maps.");
    expect(assistHash(product.candidate)).toBe(sourceHash);
    await reviewLlmAssist(context()); expect(calls).toHaveLength(1);
  });
  it("무관한 SDK는 현재 page가 유지된 경우만 내림 후보를 최종 검증한다", async () => {
    mode = "unrelated"; const product = await fixtureProduct();
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(1); expect((await requests())[0]?.state).toBe("settled");
    expect((await current(product.id)).status).toBe("banned"); expect(await results(product.id)).toMatchObject([{ applied: true }]);
  });
  it("모델 응답 중 제품 page가 바뀌면 실제 종료만 정산하고 내리지 않는다", async () => {
    mode = "unrelated"; const product = await fixtureProduct();
    onCall = async () => { pageText = "Tool is now a different live service with a new repository."; };
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(1); expect((await requests())[0]?.state).toBe("settled");
    expect((await current(product.id)).status).toBe("seeded"); expect(await results(product.id)).toMatchObject([{ applied: false }]);
    expect(await work(product.id)).toMatchObject({ state: "obsolete" });
  });
  it("응답 중 claimed 보호가 생기면 저장소 주소를 바꾸지 않는다", async () => {
    const product = await fixtureProduct();
    onCall = async () => { await admin`UPDATE products SET claimed_at=clock_timestamp() WHERE id=${product.id}`; };
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(1); expect((await requests())[0]?.state).toBe("settled");
    expect((await current(product.id)).repoUrl).toBe(product.candidate.snapshot.repoUrl);
    expect(await results(product.id)).toMatchObject([{ applied: false }]);
  });
  it("응답 중 active maker가 등장하면 저장소 주소를 바꾸지 않는다", async () => {
    const product = await fixtureProduct();
    onCall = async () => {
      const [user] = await admin`INSERT INTO public_users(display_name) VALUES(${prefix}) RETURNING id`;
      ownedUsers.push(Number(user.id));
      await admin`INSERT INTO product_maker_members(product_id,user_id,role,method,github_user_id)
        VALUES(${product.id},${Number(user.id)},'owner','github_repo_owner',7)`;
    };
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(1); expect((await requests())[0]?.state).toBe("settled");
    expect((await current(product.id)).repoUrl).toBe(product.candidate.snapshot.repoUrl);
    expect(await results(product.id)).toMatchObject([{ applied: false }]);
  });
  it("현재 제품 page의 접근 차단은 모델 호출 없이 추가 근거 대기로 남긴다", async () => {
    mode = "unrelated"; const product = await fixtureProduct();
    const request = fetchCapped.getMockImplementation()!;
    fetchCapped.mockImplementation(async (url: string) => url === product.url ? { ok: false, reason: "http", status: 403 } : request(url));
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(0); expect(await requests()).toHaveLength(0);
    expect((await current(product.id)).status).toBe("seeded");
    expect(await work(product.id)).toMatchObject({ state: "waiting_evidence", attempts: 0, lastError: "product_page_unavailable" });
  });
  it("동명 포크를 모델이 공식 이전이라고 제안해도 서버가 주소 변경을 거절한다", async () => {
    mode = "fork"; const product = await fixtureProduct();
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(1); expect((await current(product.id)).repoUrl).toBe(product.candidate.snapshot.repoUrl);
    expect((await current(product.id)).status).toBe("seeded"); expect(await results(product.id)).toMatchObject([{ applied: false }]);
    expect(await work(product.id)).toMatchObject({ state: "human" });
  });
  it("source 원시 revision이 바뀌면 native 호출을 시작하지 않는다", async () => {
    const product = await fixtureProduct();
    await admin`UPDATE products SET updated_at=updated_at+interval '1 microsecond' WHERE id=${product.id}`;
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(0); expect(await requests()).toHaveLength(0); expect(await work(product.id)).toMatchObject({ state: "queued", attempts: 0 });
  });
});
